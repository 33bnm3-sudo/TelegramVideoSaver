Set-Location $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host ""
Write-Host "=== TelegramVideoSaver - Install ===" -ForegroundColor Cyan
Write-Host ""

# 1. VS C++ Build Tools
Write-Host "[1/4] C++ Build Tools..." -NoNewline
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs2022  = "${env:ProgramFiles}\Microsoft Visual Studio\2022"
if ((Test-Path $vsWhere) -or (Test-Path $vs2022)) {
    Write-Host " already installed." -ForegroundColor Green
} else {
    Write-Host " downloading..."
    Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile "$env:TEMP\vs_buildtools.exe"
    Write-Host "    Installing (10-20 min, window may disappear - that is normal)..."
    Start-Process -Wait "$env:TEMP\vs_buildtools.exe" -ArgumentList "--quiet","--wait","--norestart","--add","Microsoft.VisualStudio.Workload.VCTools","--includeRecommended"
    Write-Host "    Done." -ForegroundColor Green
}

# 2. Node.js
Write-Host ""
Write-Host "[2/4] Node.js..." -NoNewline
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host " already installed." -ForegroundColor Green
} else {
    Write-Host " downloading..."
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.15.0/node-v20.15.0-x64.msi" -OutFile "$env:TEMP\node.msi"
    Write-Host "    Installing..."
    Start-Process -Wait msiexec -ArgumentList "/i","$env:TEMP\node.msi","/quiet","/norestart"
    Write-Host "    Done." -ForegroundColor Green
}

# 3. Rust
Write-Host ""
Write-Host "[3/4] Rust..." -NoNewline
$env:PATH = "$env:PATH;$env:USERPROFILE\.cargo\bin"
if (Get-Command rustc -ErrorAction SilentlyContinue) {
    Write-Host " already installed." -ForegroundColor Green
} else {
    Write-Host " downloading..."
    Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile "$env:TEMP\rustup.exe"
    Write-Host "    Installing..."
    Start-Process -Wait "$env:TEMP\rustup.exe" -ArgumentList "-y","--default-toolchain","stable"
    Write-Host "    Done." -ForegroundColor Green
}

# 4. Make sure Rust is up to date (required by Telegram library)
Write-Host ""
Write-Host "[4/4] Updating Rust toolchain..."
rustup update stable
Write-Host "    Done." -ForegroundColor Green

Write-Host ""
Write-Host "=== All done! ===" -ForegroundColor Cyan
Write-Host "Close this window, then run 2_run.bat" -ForegroundColor Yellow
Write-Host ""
