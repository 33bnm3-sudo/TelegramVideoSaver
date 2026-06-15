#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod telegram;

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const NO_WINDOW: u32 = 0x08000000;

// ---- State: HashMap so multiple jobs run in parallel --------------------

struct AppState {
    pids: Arc<Mutex<HashMap<String, u32>>>,
    telegram: telegram::TelegramState,
    log_lock: Arc<Mutex<()>>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            pids: Arc::new(Mutex::new(HashMap::new())),
            telegram: telegram::TelegramState::default(),
            log_lock: Arc::new(Mutex::new(())),
        }
    }
}

// ---- Progress event (includes job_id so the frontend routes it) ---------

#[derive(Clone, Serialize)]
struct Progress {
    job_id: String,
    percent: f64,
    speed: String,
    eta: String,
    message: String,
    status: String,
}

fn emit(app: &AppHandle, job_id: &str, pct: f64, speed: &str, eta: &str, msg: &str, status: &str) {
    let _ = app.emit_all("dl-progress", Progress {
        job_id: job_id.into(),
        percent: pct,
        speed: speed.into(),
        eta: eta.into(),
        message: msg.into(),
        status: status.into(),
    });
}

// ---- Helpers ------------------------------------------------------------

fn tool(name: &str) -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(format!("{}.exe", name));
            if p.exists() { return p.to_string_lossy().to_string(); }
        }
    }
    name.to_string()
}

fn tool_exists(name: &str) -> bool {
    let p = tool(name);
    if p != name { return true; }
    Command::new(name).arg("--version")
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().is_ok()
}

fn quality_fmt(q: &str) -> &'static str {
    match q {
        "best"  => "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        "1080p" => "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]",
        "720p"  => "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]",
        "480p"  => "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]",
        "360p"  => "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]",
        "audio" => "bestaudio/best",
        _       => "bestvideo+bestaudio/best",
    }
}

fn parse_dl_line(line: &str) -> Option<(f64, String, String)> {
    if !line.contains("[download]") || !line.contains('%') { return None; }
    let pct_pos = line.find('%')?;
    let before = line[..pct_pos].trim();
    let start = before.rfind(|c: char| c.is_whitespace() || c == ']')
        .map(|i| i + 1).unwrap_or(0);
    let pct: f64 = before[start..].trim().parse().ok()?;
    let speed = line.find(" at ").map(|i|
        line[i+4..].split_whitespace().next().unwrap_or("").to_string()
    ).unwrap_or_default();
    let eta = line.find("ETA ").map(|i|
        line[i+4..].split_whitespace().next().unwrap_or("").to_string()
    ).unwrap_or_default();
    Some((pct, speed, eta))
}

fn handle_yt_line(line: &str, app: &AppHandle, job_id: &str,
    phase: &Mutex<u32>, last_pct: &Mutex<f64>,
    premiere_compat: bool, is_audio: bool, final_path: &Mutex<Option<String>>)
{
    let trimmed = line.trim();
    if !trimmed.is_empty() && !trimmed.starts_with('[') && trimmed.contains(":\\") {
        *final_path.lock().unwrap() = Some(trimmed.to_string());
        return;
    }
    if line.contains("[Merger]") || line.contains("Merging formats") {
        let pct = if premiere_compat && !is_audio { 85.0 } else { 95.0 };
        emit(app, job_id, pct, "", "", "Merging audio/video...", "merging");
        return;
    }
    if let Some((pct, speed, eta)) = parse_dl_line(line) {
        let mut p = phase.lock().unwrap();
        let mut lp = last_pct.lock().unwrap();
        if pct < *lp - 10.0 { *p += 1; }
        *lp = pct;
        let adj = if premiere_compat && !is_audio {
            match *p { 0 => pct * 0.55, 1 => 55.0 + pct * 0.30, _ => 85.0 }
        } else {
            match *p { 0 => pct * 0.65, 1 => 65.0 + pct * 0.30, _ => pct }
        };
        emit(app, job_id, adj, &speed, &eta,
             &format!("Downloading... {:.1}%", pct), "downloading");
    }
}

fn find_raw_file(dir: &str, prefix: &str) -> Result<String, String> {
    std::fs::read_dir(dir).map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .map(|e| e.path().to_string_lossy().to_string())
        .ok_or_else(|| "Downloaded file not found".to_string())
}

/// Append a row to {day_dir}\{file_name}, writing a UTF-8 BOM + header row
/// on first creation so Excel opens it with Korean intact.
fn append_csv_row(log_lock: &Mutex<()>, day_dir: &str, file_name: &str, header: &str, fields: &[&str]) {
    use std::io::Write;
    let _guard = log_lock.lock().unwrap();
    let path = format!("{}\\{}", day_dir, file_name);
    let is_new = !std::path::Path::new(&path).exists();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        if is_new {
            let _ = f.write_all(format!("\u{FEFF}{}\r\n", header).as_bytes());
        }
        let row: Vec<String> = fields.iter().map(|s| csv_field(s)).collect();
        let _ = f.write_all(format!("{}\r\n", row.join(",")).as_bytes());
    }
}

/// Log a successfully downloaded file to {day_dir}\links.csv (시간,링크,파일명).
fn append_link_log(log_lock: &Mutex<()>, day_dir: &str, url: &str, filename: &str) {
    let now = chrono::Local::now().format("%H:%M:%S").to_string();
    append_csv_row(log_lock, day_dir, "links.csv", "시간,링크,파일명", &[&now, url, filename]);
}

/// Log a failed download to {day_dir}\failed_links.csv (시간,링크,오류).
fn append_failed_log(log_lock: &Mutex<()>, day_dir: &str, url: &str, reason: &str) {
    let now = chrono::Local::now().format("%H:%M:%S").to_string();
    append_csv_row(log_lock, day_dir, "failed_links.csv", "시간,링크,오류", &[&now, url, reason]);
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn run_ffmpeg_convert(ffmpeg: &str, input: &str, output: &str) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-i", input,
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-vf", "fps=fps=30",
        "-c:a", "aac",
        "-ac", "2", "-ar", "48000", "-b:a", "192k",
        "-threads", "0",
        "-movflags", "+faststart", "-y", output,
    ])
    .stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { cmd.creation_flags(NO_WINDOW); }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn run_ps(script: &str) -> Result<(), String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
       .stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { cmd.creation_flags(NO_WINDOW); }
    cmd.status().map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Tauri commands -----------------------------------------------------

#[tauri::command]
fn check_tools() -> (bool, bool) {
    (tool_exists("yt-dlp"), tool_exists("ffmpeg"))
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    if let Some(pid) = state.pids.lock().unwrap().get(&job_id).copied() {
        #[cfg(windows)]
        Command::new("taskkill").args(["/PID", &pid.to_string(), "/F", "/T"])
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok();
    }
    Ok(())
}

#[tauri::command]
fn cancel_all(state: State<'_, AppState>) -> Result<(), String> {
    let pids: Vec<u32> = state.pids.lock().unwrap().values().copied().collect();
    for pid in pids {
        #[cfg(windows)]
        Command::new("taskkill").args(["/PID", &pid.to_string(), "/F", "/T"])
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok();
    }
    Ok(())
}

#[tauri::command]
async fn download_tools(app: AppHandle) -> Result<(), String> {
    let dir = std::env::current_exe().map_err(|e| e.to_string())?
        .parent().map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let yt_path = dir.join("yt-dlp.exe");
    if !yt_path.exists() {
        emit(&app, "__setup__", 15.0, "", "", "Downloading yt-dlp (~10 MB)...", "setup");
        run_ps(&format!(
            "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;\
             Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' \
             -OutFile '{}'", yt_path.to_string_lossy()))?;
    }

    let ff_path = dir.join("ffmpeg.exe");
    if !ff_path.exists() {
        emit(&app, "__setup__", 35.0, "", "", "Downloading ffmpeg (~80 MB)...", "setup");
        let zip = dir.join("_ffmpeg.zip");
        let tmp = dir.join("_ffmpeg_tmp");
        run_ps(&format!(
            "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;\
             Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' \
             -OutFile '{zip}';\
             Expand-Archive -Path '{zip}' -DestinationPath '{tmp}' -Force;\
             $src=(Get-ChildItem '{tmp}\\*\\bin\\ffmpeg.exe'|Select-Object -First 1).FullName;\
             Copy-Item $src '{ff}';\
             Remove-Item -Recurse -Force '{tmp}','{zip}'",
            zip = zip.to_string_lossy(), tmp = tmp.to_string_lossy(),
            ff = ff_path.to_string_lossy()))?;
    }

    emit(&app, "__setup__", 100.0, "", "", "Tools installed!", "setup_done");
    Ok(())
}

/// Download a single video. Can be invoked concurrently for parallel downloads.
#[tauri::command]
async fn download_video(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    url: String,
    quality: String,
    output_dir: String,
    premiere_compat: bool,
    telegram_message_id: Option<i32>,
) -> Result<String, String> {
    let is_audio = quality == "audio";
    let yt_dlp = tool("yt-dlp");
    let ffmpeg  = tool("ffmpeg");

    // Group each day's downloads into their own dated folder so weekly
    // batches don't pile up together.
    let day_dir = format!("{}\\{}", output_dir, chrono::Local::now().format("%Y-%m-%d"));
    std::fs::create_dir_all(&day_dir).map_err(|e| format!("Failed to create folder: {}", e))?;

    // Raw (pre-conversion) files are tagged with the job id so concurrent
    // premiere_compat jobs can each find their own file.
    let raw_prefix = format!("_raw_{}_", job_id);

    let outtmpl = if premiere_compat && !is_audio {
        format!("{}\\{}%(title)s [%(id)s].%(ext)s", day_dir, raw_prefix)
    } else {
        format!("{}\\%(title)s [%(id)s].%(ext)s", day_dir)
    };

    let mut args: Vec<String> = vec![
        "-f".into(), quality_fmt(&quality).into(),
        "-o".into(), outtmpl,
        "--merge-output-format".into(), "mp4".into(),
        "--newline".into(), "--no-colors".into(), "--no-warnings".into(),
        "--print".into(), "after_move:%(filepath)s".into(),
        "--ffmpeg-location".into(), ffmpeg.clone(),
        "--concurrent-fragments".into(), "8".into(),
        "--buffer-size".into(), "16M".into(),
        "--http-chunk-size".into(), "5M".into(),
    ];
    if is_audio {
        args.extend(["-x".into(), "--audio-format".into(), "mp3".into(),
                      "--audio-quality".into(), "192K".into()]);
    }
    if url.contains("instagram.com") {
        args.extend(["--add-header".into(),
            "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36".into()]);
    }
    args.push(url.clone());

    emit(&app, &job_id, 0.0, "", "", "Starting...", "downloading");

    let mut child_cmd = Command::new(&yt_dlp);
    child_cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] { child_cmd.creation_flags(NO_WINDOW); }

    let mut child = child_cmd.spawn()
        .map_err(|e| format!("Failed to launch yt-dlp: {}", e))?;

    state.pids.lock().unwrap().insert(job_id.clone(), child.id());

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let phase    = Arc::new(Mutex::new(0u32));
    let last_pct = Arc::new(Mutex::new(-1.0f64));
    let final_path = Arc::new(Mutex::new(None::<String>));

    let (app_s, jid_s, ph_s, lp_s, fp_s) = (app.clone(), job_id.clone(), Arc::clone(&phase), Arc::clone(&last_pct), Arc::clone(&final_path));
    let t1 = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            handle_yt_line(&line, &app_s, &jid_s, &ph_s, &lp_s, premiere_compat, is_audio, &fp_s);
        }
    });
    let (app_e, jid_e, ph_e, lp_e, fp_e) = (app.clone(), job_id.clone(), Arc::clone(&phase), Arc::clone(&last_pct), Arc::clone(&final_path));
    let t2 = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().flatten() {
            handle_yt_line(&line, &app_e, &jid_e, &ph_e, &lp_e, premiere_compat, is_audio, &fp_e);
        }
    });

    let exit = child.wait().map_err(|e| e.to_string())?;
    state.pids.lock().unwrap().remove(&job_id);
    t1.join().ok(); t2.join().ok();

    if !exit.success() {
        emit(&app, &job_id, 0.0, "", "", "Download failed. Please check the URL.", "error");
        append_failed_log(&state.log_lock, &day_dir, &url, "다운로드 실패");
        return Err("Download failed".into());
    }

    if premiere_compat && !is_audio {
        let raw = find_raw_file(&day_dir, &raw_prefix)
            .map_err(|e| {
                emit(&app, &job_id, 100.0, "", "", "Output file not found.", "done");
                append_failed_log(&state.log_lock, &day_dir, &url, "출력 파일을 찾을 수 없음");
                e
            })?;
        let out = raw.replacen(&raw_prefix, "", 1).replace(".mp4", "_PP.mp4");
        emit(&app, &job_id, 90.0, "", "", "Converting for Premiere Pro...", "converting");

        let result = if run_ffmpeg_convert(&ffmpeg, &raw, &out) {
            let _ = std::fs::remove_file(&raw);
            let name = PathBuf::from(&out).file_name()
                .unwrap_or_default().to_string_lossy().to_string();
            emit(&app, &job_id, 100.0, "", "", &format!("Done — {}", name), "done");
            append_link_log(&state.log_lock, &day_dir, &url, &name);
            Ok(out)
        } else {
            let fallback = raw.replacen(&raw_prefix, "", 1);
            let _ = std::fs::rename(&raw, &fallback);
            let name = PathBuf::from(&fallback).file_name()
                .unwrap_or_default().to_string_lossy().to_string();
            emit(&app, &job_id, 100.0, "", "", "Done (conversion skipped)", "done");
            append_link_log(&state.log_lock, &day_dir, &url, &name);
            Ok(fallback)
        };

        if let Some(mid) = telegram_message_id {
            telegram::mark_downloaded(&state.telegram, mid).await;
        }
        return result;
    }

    let name = final_path.lock().unwrap().clone()
        .map(|p| PathBuf::from(&p).file_name().unwrap_or_default().to_string_lossy().to_string())
        .unwrap_or_else(|| "?".into());
    append_link_log(&state.log_lock, &day_dir, &url, &name);

    emit(&app, &job_id, 100.0, "", "", "Download complete!", "done");
    if let Some(mid) = telegram_message_id {
        telegram::mark_downloaded(&state.telegram, mid).await;
    }
    Ok(day_dir)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            check_tools,
            download_video,
            cancel_job,
            cancel_all,
            open_in_explorer,
            download_tools,
            telegram::telegram_has_credentials,
            telegram::telegram_save_credentials,
            telegram::telegram_check_session,
            telegram::telegram_send_code,
            telegram::telegram_sign_in,
            telegram::telegram_check_password,
            telegram::telegram_logout,
            telegram::scan_saved_links,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
