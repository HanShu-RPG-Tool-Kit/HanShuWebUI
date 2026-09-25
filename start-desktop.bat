@echo off
setlocal
cd /d "%~dp0"

if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Rust / cargo not found. Install rustup first.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  call npm install
  if errorlevel 1 pause & exit /b 1
)

echo [HanShu] Starting Tauri desktop (dev^)...
call npm run desktop:dev
if errorlevel 1 pause
endlocal
