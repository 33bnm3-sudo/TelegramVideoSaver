Set-Location $PSScriptRoot
$env:PATH = "$env:PATH;$env:USERPROFILE\.cargo\bin"

Write-Host ""
Write-Host "=== TelegramVideoSaver ===" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found." -ForegroundColor Red
    Write-Host "Run 1_install.bat first, then close and reopen this window." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# Check Rust
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Rust not found." -ForegroundColor Red
    Write-Host "Run 1_install.bat first, then close and reopen this window." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Node.js : $(node --version)" -ForegroundColor Green
Write-Host "Rust    : $(rustc --version)" -ForegroundColor Green
Write-Host ""

# npm install (first time only)
if (-not (Test-Path "$PSScriptRoot\node_modules")) {
    Write-Host "Installing npm packages (first time only)..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed." -ForegroundColor Red
        Read-Host "Press Enter to close"
        exit 1
    }
    Write-Host ""
}

# Choose mode
Write-Host "Select mode:"
Write-Host "  1  Run app now  (dev mode)"
Write-Host "  2  Build .exe   (shareable file)"
Write-Host ""
$choice = Read-Host "Enter 1 or 2 (default 1)"
if ($choice -eq "") { $choice = "1" }

if ($choice -eq "2") {
    Write-Host ""
    Write-Host "Building... (first time takes 5-10 min)" -ForegroundColor Cyan
    Write-Host ""
    npm run tauri build
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "Build complete!" -ForegroundColor Green
        Write-Host "File: $PSScriptRoot\src-tauri\target\release\telegram-video-saver.exe"
        explorer "$PSScriptRoot\src-tauri\target\release"
    } else {
        Write-Host ""
        Write-Host "Build failed. See error above." -ForegroundColor Red
    }
} else {
    Write-Host ""
    Write-Host "Starting app... (first build ~5 min, please wait)" -ForegroundColor Cyan
    Write-Host ""
    npm run tauri dev
}

Write-Host ""
Read-Host "Press Enter to close"
