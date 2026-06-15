use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as SyncMutex};

use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::{Client, SignInError};
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_session::types::PeerRef;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::AbortHandle;

use crate::AppState;

#[derive(Default)]
pub struct TelegramState {
    client: AsyncMutex<Option<Client>>,
    runner: AsyncMutex<Option<AbortHandle>>,
    pending_login: AsyncMutex<Option<LoginToken>>,
    pending_password: AsyncMutex<Option<PasswordToken>>,
    msg_link_counts: SyncMutex<HashMap<i32, usize>>,
}

#[derive(Serialize, Deserialize)]
struct TgConfig {
    api_id: i32,
    api_hash: String,
}

// ---- Storage helpers -----------------------------------------------------

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("tg_config.json"))
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("tg.session"))
}

fn load_config(app: &AppHandle) -> Result<TgConfig, String> {
    let data = std::fs::read_to_string(config_path(app)?).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// Connects (if not already connected) and returns a clone of the client.
async fn ensure_client(app: &AppHandle, state: &TelegramState) -> Result<Client, String> {
    {
        let guard = state.client.lock().await;
        if let Some(c) = guard.as_ref() {
            return Ok(c.clone());
        }
    }

    let cfg = load_config(app)?;
    let session = Arc::new(
        SqliteSession::open(session_path(app)?)
            .await
            .map_err(|e| e.to_string())?,
    );

    let SenderPool { runner, handle, .. } = SenderPool::new(session, cfg.api_id);
    let client = Client::new(handle);
    let abort = tokio::spawn(runner.run()).abort_handle();

    *state.client.lock().await = Some(client.clone());
    *state.runner.lock().await = Some(abort);

    Ok(client)
}

/// Resolves the "Saved Messages" peer (the user's own account).
async fn me_peer(client: &Client) -> Result<PeerRef, String> {
    let me = client.get_me().await.map_err(|e| e.to_string())?;
    me.to_ref()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Could not resolve self peer".to_string())
}

// ---- Tauri commands --------------------------------------------------------

#[tauri::command]
pub fn telegram_has_credentials(app: AppHandle) -> bool {
    config_path(&app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub async fn telegram_save_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    api_id: i32,
    api_hash: String,
) -> Result<(), String> {
    let cfg = TgConfig { api_id, api_hash };
    let data = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(&app)?, data).map_err(|e| e.to_string())?;
    ensure_client(&app, &state.telegram).await?;
    Ok(())
}

#[tauri::command]
pub async fn telegram_check_session(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if !telegram_has_credentials(app.clone()) {
        return Ok(false);
    }
    let client = ensure_client(&app, &state.telegram).await?;
    client.is_authorized().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn telegram_send_code(app: AppHandle, state: State<'_, AppState>, phone: String) -> Result<(), String> {
    let cfg = load_config(&app)?;
    let client = ensure_client(&app, &state.telegram).await?;
    let token = client
        .request_login_code(&phone, &cfg.api_hash)
        .await
        .map_err(|e| e.to_string())?;
    *state.telegram.pending_login.lock().await = Some(token);
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoginResult {
    Done,
    PasswordRequired { hint: Option<String> },
}

#[tauri::command]
pub async fn telegram_sign_in(app: AppHandle, state: State<'_, AppState>, code: String) -> Result<LoginResult, String> {
    let client = ensure_client(&app, &state.telegram).await?;
    let token = state
        .telegram
        .pending_login
        .lock()
        .await
        .take()
        .ok_or_else(|| "No pending login. Request a code first.".to_string())?;

    match client.sign_in(&token, &code).await {
        Ok(_) => Ok(LoginResult::Done),
        Err(SignInError::PasswordRequired(pt)) => {
            let hint = pt.hint().map(|s| s.to_string());
            *state.telegram.pending_password.lock().await = Some(pt);
            Ok(LoginResult::PasswordRequired { hint })
        }
        Err(e) => {
            // Keep the token around so the user can retry with a corrected code.
            *state.telegram.pending_login.lock().await = Some(token);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn telegram_check_password(state: State<'_, AppState>, password: String) -> Result<(), String> {
    // `ensure_client` is not needed here: a client must already exist to have
    // reached the password step (it was created by telegram_send_code).
    let client = state
        .telegram
        .client
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Not connected".to_string())?;

    let pt = state
        .telegram
        .pending_password
        .lock()
        .await
        .take()
        .ok_or_else(|| "No pending 2FA password request.".to_string())?;

    match client.check_password(pt, password.into_bytes()).await {
        Ok(_) => Ok(()),
        Err(SignInError::InvalidPassword(pt2)) => {
            *state.telegram.pending_password.lock().await = Some(pt2);
            Err("Invalid password".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn telegram_logout(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let guard = state.telegram.client.lock().await;
        if let Some(client) = guard.as_ref() {
            let _ = client.sign_out().await;
        }
    }
    if let Some(abort) = state.telegram.runner.lock().await.take() {
        abort.abort();
    }
    *state.telegram.client.lock().await = None;
    *state.telegram.pending_login.lock().await = None;
    *state.telegram.pending_password.lock().await = None;
    state.telegram.msg_link_counts.lock().unwrap().clear();

    let _ = std::fs::remove_file(session_path(&app)?);
    let _ = std::fs::remove_file(config_path(&app)?);
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct TelegramLink {
    pub message_id: i32,
    pub url: String,
    pub text: String,
    pub date: String,
}

/// Scan the most recent Saved Messages for http(s) links.
#[tauri::command]
pub async fn scan_saved_links(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<TelegramLink>, String> {
    let client = ensure_client(&app, &state.telegram).await?;
    let peer = me_peer(&client).await?;
    let url_re = Regex::new(r"https?://\S+").unwrap();

    let mut links = Vec::new();
    let mut counts: HashMap<i32, usize> = HashMap::new();
    let mut messages = client.iter_messages(peer).limit(500);
    while let Some(msg) = messages.next().await.map_err(|e| e.to_string())? {
        let text = msg.text();
        for m in url_re.find_iter(text) {
            let url = m
                .as_str()
                .trim_end_matches(|c: char| ".,)]}>\"'".contains(c))
                .to_string();
            *counts.entry(msg.id()).or_insert(0) += 1;
            links.push(TelegramLink {
                message_id: msg.id(),
                url,
                text: text.to_string(),
                date: msg.date().format("%Y-%m-%d %H:%M").to_string(),
            });
        }
    }

    *state.telegram.msg_link_counts.lock().unwrap() = counts;
    Ok(links)
}

/// Called after a download finishes. Deletes the originating Saved Messages
/// entry once every link found in that message has been downloaded.
pub async fn mark_downloaded(state: &TelegramState, message_id: i32) {
    let should_delete = {
        let mut counts = state.msg_link_counts.lock().unwrap();
        match counts.get_mut(&message_id) {
            Some(n) if *n > 1 => {
                *n -= 1;
                false
            }
            Some(_) => {
                counts.remove(&message_id);
                true
            }
            None => true,
        }
    };
    if !should_delete {
        return;
    }

    let Some(client) = state.client.lock().await.clone() else {
        return;
    };
    let Ok(peer) = me_peer(&client).await else {
        return;
    };
    let _ = client.delete_messages(peer, &[message_id]).await;
}
