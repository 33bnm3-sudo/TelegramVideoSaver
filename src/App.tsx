import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { homeDir } from "@tauri-apps/api/path";

// ── Types ──────────────────────────────────────────────────────────────────

type Screen   = "loading" | "setup" | "tg-auth" | "main";
type JobStatus = "queued"|"downloading"|"merging"|"converting"|"done"|"error"|"cancelled";

interface Job {
  id: string; url: string; status: JobStatus;
  percent: number; speed: string; eta: string; message: string;
  telegramMessageId?: number;
}
interface ProgressPayload {
  job_id: string; percent: number; speed: string;
  eta: string; message: string; status: string;
}
interface Tools { ytdlp: boolean; ffmpeg: boolean; }

interface TelegramLink {
  message_id: number; url: string; text: string; date: string;
}
interface LinkItem extends TelegramLink { id: string }

type LoginResult =
  | { status: "done" }
  | { status: "password_required"; hint: string | null };

const QUALITIES = [
  { value: "best",  label: "Best Quality (1080p+)" },
  { value: "1080p", label: "1080p" },
  { value: "720p",  label: "720p"  },
  { value: "480p",  label: "480p"  },
  { value: "360p",  label: "360p"  },
  { value: "audio", label: "Audio Only (MP3)" },
];

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function isUrl(s: string) {
  try { const u = new URL(s); return u.protocol==="http:"||u.protocol==="https:"; } catch { return false; }
}
function platform(url: string): "yt"|"ig"|"web" {
  if (url.includes("youtube.com")||url.includes("youtu.be")) return "yt";
  if (url.includes("instagram.com")) return "ig";
  return "web";
}
function shortUrl(url: string) {
  try {
    const u = new URL(url);
    const p = u.pathname.slice(0,38)+(u.pathname.length>38?"…":"");
    return u.hostname.replace("www.","")+p;
  } catch { return url.slice(0,55); }
}

function TelegramIcon() {
  return (
    <svg width="36" height="36" fill="none" viewBox="0 0 24 24">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [tools,  setTools]  = useState<Tools>({ ytdlp: false, ffmpeg: false });

  const [jobs,      setJobs]      = useState<Job[]>([]);
  const [quality,   setQuality]   = useState("best");
  const [outputDir, setOutputDir] = useState("");
  const [ppCompat,  setPpCompat]  = useState(true);

  const checkTelegram = useCallback(async () => {
    const authed = await invoke<boolean>("telegram_check_session").catch(() => false);
    setScreen(authed ? "main" : "tg-auth");
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("outputDir");
    if (saved) {
      setOutputDir(saved);
    } else {
      homeDir().then(h => setOutputDir(h + "Downloads")).catch(() => {});
    }

    invoke<[boolean, boolean]>("check_tools").then(([y, f]) => {
      setTools({ ytdlp: y, ffmpeg: f });
      if (y && f) checkTelegram();
      else setScreen("setup");
    });

    const unsub = listen<ProgressPayload>("dl-progress", ({ payload }) => {
      if (payload.job_id === "__setup__") return;
      setJobs(prev => prev.map(j =>
        j.id === payload.job_id
          ? { ...j, percent: payload.percent, speed: payload.speed,
              eta: payload.eta, message: payload.message,
              status: payload.status as JobStatus }
          : j
      ));
    });
    return () => { unsub.then(f => f()); };
  }, [checkTelegram]);

  const handleSetupDone = () => {
    setTools({ ytdlp: true, ffmpeg: true });
    checkTelegram();
  };

  const handleLogout = async () => {
    await invoke("telegram_logout").catch(() => {});
    setScreen("tg-auth");
  };

  if (screen === "loading") return <LoadingScreen />;
  if (screen === "setup")
    return <SetupScreen tools={tools} onDone={handleSetupDone} />;
  if (screen === "tg-auth")
    return <TelegramAuthScreen onDone={() => setScreen("main")} />;
  return (
    <MainScreen
      jobs={jobs} setJobs={setJobs}
      quality={quality} setQuality={setQuality}
      outputDir={outputDir} setOutputDir={setOutputDir}
      ppCompat={ppCompat} setPpCompat={setPpCompat}
      onLogout={handleLogout}
    />
  );
}

// ── LoadingScreen ──────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="spinner" />
    </div>
  );
}

// ── SetupScreen ────────────────────────────────────────────────────────────

function SetupScreen({ tools, onDone }: { tools: Tools; onDone: () => void }) {
  const [busy,    setBusy]    = useState(false);
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState("");
  const [localTools, setLocalTools] = useState(tools);
  const [finished, setFinished] = useState(false);
  const [error,   setError]   = useState("");

  const allReady = localTools.ytdlp && localTools.ffmpeg;

  useEffect(() => {
    if (allReady) return;
    const unsub = listen<ProgressPayload>("dl-progress", ({ payload }) => {
      if (payload.job_id !== "__setup__") return;
      setPercent(payload.percent);
      setMessage(payload.message);
      if (payload.status === "setup_done") {
        setLocalTools({ ytdlp: true, ffmpeg: true });
        setFinished(true);
        setTimeout(onDone, 1800);
      }
    });
    return () => { unsub.then(f => f()); };
  }, [allReady, onDone]);

  const handleInstall = async () => {
    setBusy(true); setError(""); setPercent(0);
    setMessage("Preparing install...");
    try { await invoke("download_tools"); }
    catch (e) { setError(String(e)); setBusy(false); }
  };

  return (
    <div className="setup-screen">
      <div className="setup-card">

        <div className="setup-logo">
          <svg width="36" height="36" fill="none" viewBox="0 0 24 24">
            <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M8 12l4 4 4-4M12 4v12"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        <h1 className="setup-title">Telegram Video Saver</h1>
        <p className="setup-subtitle">Saved Messages 자동 다운로드</p>

        <div className="setup-divider" />

        <p className="setup-desc">
          {allReady ? "All tools are ready." : "Required tools need to be installed before use."}
        </p>

        <div className="setup-list">
          <SetupItem
            label="yt-dlp"
            desc="Video download engine"
            ok={localTools.ytdlp}
            installing={busy && !localTools.ytdlp}
          />
          <SetupItem
            label="ffmpeg"
            desc="Video conversion / Premiere Pro compatibility"
            ok={localTools.ffmpeg}
            installing={busy && localTools.ytdlp && !localTools.ffmpeg}
          />
        </div>

        {busy && (
          <div className="setup-progress">
            <div className="setup-bar-wrap">
              <div className="setup-bar" style={{ width: `${percent}%` }} />
            </div>
            <p className="setup-progress-msg">{message}</p>
          </div>
        )}

        {error && <p className="setup-error">{error}</p>}

        {finished ? (
          <div className="setup-done">
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Installation complete — starting shortly
          </div>
        ) : allReady ? (
          <button className="setup-btn" onClick={onDone}>Get Started →</button>
        ) : (
          <button className="setup-btn" onClick={handleInstall} disabled={busy}>
            {busy ? "Installing..." : "Auto Install"}
          </button>
        )}

        <p className="setup-note">
          yt-dlp · ffmpeg are saved to the app folder<br/>and won't need to be reinstalled.
        </p>
      </div>
    </div>
  );
}

function SetupItem({ label, desc, ok, installing }:
  { label: string; desc: string; ok: boolean; installing: boolean }) {
  return (
    <div className={`setup-item ${ok ? "ok" : installing ? "active" : "pending"}`}>
      <div className="setup-item-icon">
        {ok
          ? <svg width="13" height="13" fill="none" viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          : installing
          ? <div className="mini-spinner" />
          : <div className="item-dot" />
        }
      </div>
      <div>
        <strong>{label}</strong>
        <span>{desc}</span>
      </div>
    </div>
  );
}

// ── TelegramAuthScreen ─────────────────────────────────────────────────────

type AuthStep = "credentials" | "phone" | "code" | "password";

function TelegramAuthScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<AuthStep>("credentials");
  const [checking, setChecking] = useState(true);
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<boolean>("telegram_has_credentials")
      .then(has => setStep(has ? "phone" : "credentials"))
      .finally(() => setChecking(false));
  }, []);

  const handleCredentials = async () => {
    const id = parseInt(apiId, 10);
    if (!id || !apiHash.trim()) { setError("api_id / api_hash를 입력하세요."); return; }
    setBusy(true); setError("");
    try {
      await invoke("telegram_save_credentials", { apiId: id, apiHash: apiHash.trim() });
      setStep("phone");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const handlePhone = async () => {
    if (!phone.trim()) { setError("전화번호를 입력하세요."); return; }
    setBusy(true); setError("");
    try {
      await invoke("telegram_send_code", { phone: phone.trim() });
      setStep("code");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const handleCode = async () => {
    if (!code.trim()) { setError("인증 코드를 입력하세요."); return; }
    setBusy(true); setError("");
    try {
      const result = await invoke<LoginResult>("telegram_sign_in", { code: code.trim() });
      if (result.status === "done") onDone();
      else { setHint(result.hint); setStep("password"); }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const handlePassword = async () => {
    if (!password) { setError("비밀번호를 입력하세요."); return; }
    setBusy(true); setError("");
    try {
      await invoke("telegram_check_password", { password });
      onDone();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const submit = () => {
    if (busy) return;
    if (step === "credentials") handleCredentials();
    else if (step === "phone") handlePhone();
    else if (step === "code") handleCode();
    else handlePassword();
  };

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") submit(); };

  if (checking) return <LoadingScreen />;

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-logo"><TelegramIcon /></div>
        <h1 className="setup-title">Telegram 로그인</h1>
        <p className="setup-subtitle">Saved Messages(나에게 보내기)에 접근하려면<br/>한 번만 로그인하면 됩니다</p>

        <div className="setup-divider" />

        {step === "credentials" && (
          <div className="auth-form">
            <p className="setup-desc">
              <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">my.telegram.org/apps</a>에서
              발급받은 API 정보를 입력하세요.
            </p>
            <label className="auth-label">api_id</label>
            <input className="auth-input" value={apiId} onChange={e=>setApiId(e.target.value)}
              onKeyDown={onEnter} inputMode="numeric" placeholder="1234567" autoFocus />
            <label className="auth-label">api_hash</label>
            <input className="auth-input" value={apiHash} onChange={e=>setApiHash(e.target.value)}
              onKeyDown={onEnter} placeholder="0123456789abcdef0123456789abcdef" />
          </div>
        )}

        {step === "phone" && (
          <div className="auth-form">
            <p className="setup-desc">국가 코드를 포함한 전화번호를 입력하세요.</p>
            <label className="auth-label">전화번호</label>
            <input className="auth-input" value={phone} onChange={e=>setPhone(e.target.value)}
              onKeyDown={onEnter} placeholder="+821012345678" autoFocus />
          </div>
        )}

        {step === "code" && (
          <div className="auth-form">
            <p className="setup-desc">Telegram으로 전송된 인증 코드를 입력하세요.</p>
            <label className="auth-label">인증 코드</label>
            <input className="auth-input" value={code} onChange={e=>setCode(e.target.value)}
              onKeyDown={onEnter} inputMode="numeric" placeholder="12345" autoFocus />
          </div>
        )}

        {step === "password" && (
          <div className="auth-form">
            <p className="setup-desc">
              2단계 인증 비밀번호를 입력하세요.
              {hint && <><br/>힌트: {hint}</>}
            </p>
            <label className="auth-label">비밀번호</label>
            <input className="auth-input" type="password" value={password} onChange={e=>setPassword(e.target.value)}
              onKeyDown={onEnter} placeholder="••••••••" autoFocus />
          </div>
        )}

        {error && <p className="setup-error">{error}</p>}

        <button className="setup-btn" onClick={submit} disabled={busy}>
          {busy ? "처리 중..." :
            step === "credentials" ? "다음" :
            step === "phone" ? "코드 전송" :
            step === "code" ? "로그인" : "확인"}
        </button>

        <p className="setup-note">
          한 번 로그인하면 세션이 저장되어<br/>다음부터는 자동으로 로그인됩니다.
        </p>
      </div>
    </div>
  );
}

// ── MainScreen ─────────────────────────────────────────────────────────────

interface MainProps {
  jobs: Job[]; setJobs: React.Dispatch<React.SetStateAction<Job[]>>;
  quality: string; setQuality: (v: string) => void;
  outputDir: string; setOutputDir: (v: string) => void;
  ppCompat: boolean; setPpCompat: (v: boolean) => void;
  onLogout: () => void;
}

function MainScreen({ jobs, setJobs, quality, setQuality, outputDir, setOutputDir, ppCompat, setPpCompat, onLogout }: MainProps) {
  const [urlInput, setUrlInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const [links, setLinks] = useState<LinkItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [scanError, setScanError] = useState("");

  const startJob = useCallback((job: Job, q: string, dir: string, pp: boolean) => {
    invoke("download_video", {
      jobId: job.id, url: job.url, quality: q,
      outputDir: dir, premiereCompat: pp,
      telegramMessageId: job.telegramMessageId ?? null,
    }).catch(e => setJobs(prev => prev.map(j =>
      j.id === job.id ? { ...j, status: "error", message: String(e) } : j
    )));
  }, [setJobs]);

  const addUrls = useCallback((raw: string) => {
    const urls = raw.split(/[\n\r\s]+/).filter(isUrl);
    if (!urls.length) return;
    const newJobs: Job[] = urls.map(url => ({
      id: uid(), url, status: "downloading",
      percent: 0, speed: "", eta: "", message: "Starting...",
    }));
    setJobs(prev => [...prev, ...newJobs]);
    newJobs.forEach(j => startJob(j, quality, outputDir, ppCompat));
    setUrlInput("");
  }, [quality, outputDir, ppCompat, startJob, setJobs]);

  const handleAdd = () => { if (urlInput.trim()) addUrls(urlInput); };

  const handlePaste = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) setUrlInput(t); }
    catch { inputRef.current?.focus(); }
  };

  const handleInputPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (text.split(/[\n\r]+/).filter(isUrl).length > 1) {
      e.preventDefault(); addUrls(text);
    }
  };

  const handleBrowse = async () => {
    const sel = await open({ directory: true, multiple: false, defaultPath: outputDir });
    if (typeof sel === "string") {
      setOutputDir(sel);
      localStorage.setItem("outputDir", sel);
    }
  };

  const cancelJob = (id: string) => {
    invoke("cancel_job", { jobId: id });
    setJobs(prev => prev.map(j =>
      j.id === id ? { ...j, status: "cancelled", message: "Cancelled" } : j
    ));
  };
  const cancelAll = () => {
    invoke("cancel_all");
    setJobs(prev => prev.map(j =>
      ["downloading","merging","converting","queued"].includes(j.status)
        ? { ...j, status: "cancelled", message: "Cancelled" } : j
    ));
  };
  const clearDone = () =>
    setJobs(prev => prev.filter(j => !["done","error","cancelled"].includes(j.status)));

  // ── Telegram scan / download ──────────────────────────────────────────

  const handleScan = async () => {
    setScanning(true); setScanError("");
    try {
      const found = await invoke<TelegramLink[]>("scan_saved_links");
      const items: LinkItem[] = found.map(l => ({ ...l, id: uid() }));
      setLinks(items);
      setSelected(new Set(items.map(i => i.id)));
      setScanned(true);
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const toggleAll = () => {
    setSelected(prev => prev.size === links.length ? new Set() : new Set(links.map(l => l.id)));
  };
  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDownloadSelected = () => {
    const chosen = links.filter(l => selected.has(l.id));
    if (!chosen.length) return;
    const newJobs: Job[] = chosen.map(l => ({
      id: uid(), url: l.url, status: "downloading",
      percent: 0, speed: "", eta: "", message: "Starting...",
      telegramMessageId: l.message_id,
    }));
    setJobs(prev => [...prev, ...newJobs]);
    newJobs.forEach(j => startJob(j, quality, outputDir, ppCompat));
    setLinks(prev => prev.filter(l => !selected.has(l.id)));
    setSelected(new Set());
  };

  const activeCount = jobs.filter(j => ["downloading","merging","converting","queued"].includes(j.status)).length;
  const doneCount   = jobs.filter(j => ["done","error","cancelled"].includes(j.status)).length;

  return (
    <div className="app">
      <header className="header">
        <TelegramIcon />
        <span className="header-title">Telegram Video Saver</span>
        <span className="header-sep" />
        <span className="header-sub">Saved Messages</span>
      </header>

      <div className="body">
        {/* ── Telegram Saved Messages scan ── */}
        <div className="tg-section">
          <div className="tg-section-hd">
            <span className="tg-section-title">Saved Messages</span>
            <button className="btn-sm ghost" onClick={handleScan} disabled={scanning}>
              {scanning ? "스캔 중..." : "스캔"}
            </button>
          </div>

          {scanError && <p className="setup-error">{scanError}</p>}

          {links.length > 0 && (
            <>
              <div className="queue-hd">
                <span className="queue-title">
                  찾은 링크
                  <span className="queue-badge active">{links.length}</span>
                </span>
                <div className="queue-acts">
                  <button className="btn-xs ghost" onClick={toggleAll}>
                    {selected.size === links.length ? "전체 해제" : "전체 선택"}
                  </button>
                </div>
              </div>
              <div className="link-list">
                {links.map(l => (
                  <label key={l.id} className="link-row">
                    <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} />
                    <span className={`pf pf-${platform(l.url)}`}>
                      {platform(l.url)==="yt" && <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 00-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 00.5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 002.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 002.1-2.1C24 15.9 24 12 24 12s0-3.9-.5-5.8zM9.75 15.6V8.4l6.25 3.6-6.25 3.6z"/></svg>}
                      {platform(l.url)==="ig" && <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>}
                      {platform(l.url)==="web" && <svg width="11" height="11" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>}
                    </span>
                    <span className="link-url" title={l.text}>{shortUrl(l.url)}</span>
                    <span className="link-date">{l.date}</span>
                  </label>
                ))}
              </div>
              <button className="setup-btn link-dl-btn" onClick={handleDownloadSelected} disabled={selected.size===0}>
                선택 항목 다운로드 ({selected.size})
              </button>
            </>
          )}

          {!scanning && scanned && links.length === 0 && !scanError && (
            <p className="tg-empty">Saved Messages에서 링크를 찾지 못했습니다.</p>
          )}
        </div>

        <div className={`url-box${isUrl(urlInput) ? " valid" : urlInput ? " invalid" : ""}`}>
          <span className="url-icon">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </span>
          <input
            ref={inputRef}
            className="url-input"
            placeholder="Paste URL (separate multiple URLs with newlines)"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAdd()}
            onPaste={handleInputPaste}
            spellCheck={false}
          />
          {urlInput && <button className="url-clear" onClick={() => setUrlInput("")}>×</button>}
          <button className="url-paste-btn" onClick={handlePaste}>
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24">
              <rect x="9" y="2" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2"/>
              <path d="M5 6H4a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Paste
          </button>
          <button className="url-add-btn" onClick={handleAdd} disabled={!isUrl(urlInput)}>Add</button>
        </div>

        <div className="settings-row">
          <div className="sg">
            <label className="sg-label">Quality</label>
            <select className="sg-select" value={quality} onChange={e => setQuality(e.target.value)}>
              {QUALITIES.map(q => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          </div>

          <div className="sg sg-folder">
            <label className="sg-label">Save to</label>
            <div className="folder-row">
              <input className="folder-input" readOnly value={outputDir} title={outputDir} />
              <button className="btn-sm ghost" onClick={handleBrowse}>Browse</button>
              <button className="btn-sm ghost icon" onClick={() => invoke("open_in_explorer", { path: outputDir })} title="Open folder">
                <svg width="13" height="13" fill="none" viewBox="0 0 24 24">
                  <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          </div>

          <div className="sg">
            <label className="sg-label">Post-process</label>
            <button className={`pp-btn${ppCompat ? " on" : ""}`} onClick={() => setPpCompat(!ppCompat)}
              title="Prevent Premiere Pro echo (VFR→CFR + AAC re-encode)">
              <span className="pp-dot" />
              {ppCompat ? "PP Compat ON" : "PP Compat OFF"}
            </button>
          </div>
        </div>

        {jobs.length > 0 && (
          <div className="queue-hd">
            <span className="queue-title">
              Queue
              {activeCount > 0 && <span className="queue-badge active">{activeCount}</span>}
              {doneCount   > 0 && <span className="queue-badge done">{doneCount}</span>}
            </span>
            <div className="queue-acts">
              {doneCount > 0 && <button className="btn-xs ghost" onClick={clearDone}>Clear Done</button>}
              {activeCount > 0 && <button className="btn-xs danger" onClick={cancelAll}>Cancel All</button>}
            </div>
          </div>
        )}

        <div className="queue">
          {jobs.length === 0 ? (
            <div className="queue-empty">
              <svg width="38" height="38" fill="none" viewBox="0 0 24 24" opacity=".2">
                <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M8 12l4 4 4-4M12 4v12"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <p>Saved Messages를 스캔하거나 URL을 붙여넣어 시작하세요</p>
              <p className="empty-sub">Paste multiple URLs at once to download simultaneously</p>
            </div>
          ) : (
            jobs.map(job => <JobCard key={job.id} job={job} onCancel={cancelJob} />)
          )}
        </div>
      </div>

      <footer className="footer">
        <span className="footer-note">yt-dlp · ffmpeg installed</span>
        <button className="btn-xs ghost" onClick={onLogout}>Telegram 로그아웃</button>
      </footer>
    </div>
  );
}

// ── JobCard ────────────────────────────────────────────────────────────────

function JobCard({ job, onCancel }: { job: Job; onCancel: (id: string) => void }) {
  const isActive = ["downloading","merging","converting"].includes(job.status);
  const isIndet  = ["merging","converting"].includes(job.status);
  const barColor =
    job.status==="done"      ? "var(--green)" :
    job.status==="error"||job.status==="cancelled" ? "var(--red)" :
    job.status==="converting"? "var(--yellow)" : "var(--accent)";

  const BADGE: Record<JobStatus,[string,string]> = {
    queued:      ["Queued",      "b-idle"],
    downloading: ["Downloading", "b-act"],
    merging:     ["Merging",     "b-act"],
    converting:  ["Converting",  "b-warn"],
    done:        ["Done",        "b-done"],
    error:       ["Error",       "b-err"],
    cancelled:   ["Cancelled",   "b-err"],
  };
  const [blabel, bcls] = BADGE[job.status] ?? ["?","b-idle"];
  const p = platform(job.url);

  return (
    <div className={`job ${job.status}`}>
      <span className={`pf pf-${p}`}>
        {p==="yt" && <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 00-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 00.5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 002.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 002.1-2.1C24 15.9 24 12 24 12s0-3.9-.5-5.8zM9.75 15.6V8.4l6.25 3.6-6.25 3.6z"/></svg>}
        {p==="ig" && <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>}
        {p==="web" && <svg width="11" height="11" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>}
      </span>

      <div className="job-main">
        <div className="job-top">
          <span className="job-url">{shortUrl(job.url)}</span>
          <span className={`badge ${bcls}`}>{blabel}</span>
        </div>
        <div className="job-bar-bg">
          <div className={`job-bar${isIndet?" indet":""}`}
            style={{ width: isIndet ? undefined : `${job.percent}%`, background: barColor }} />
        </div>
        <div className="job-bottom">
          <span className="job-msg">{job.message}</span>
          <span className="job-stats">
            {job.speed && job.speed!=="Unknown" && job.speed}
            {job.eta && job.eta!=="Unknown" && job.eta!=="00:00" && ` · ${job.eta}`}
            {!isIndet && job.percent>0 && job.percent<100 && ` · ${job.percent.toFixed(1)}%`}
          </span>
        </div>
      </div>

      {isActive && (
        <button className="job-cancel" onClick={() => onCancel(job.id)} title="Cancel">
          <svg width="11" height="11" fill="none" viewBox="0 0 24 24">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </button>
      )}
      {job.status==="done" && (
        <span className="job-done-icon">
          <svg width="13" height="13" fill="none" viewBox="0 0 24 24">
            <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      )}
    </div>
  );
}
