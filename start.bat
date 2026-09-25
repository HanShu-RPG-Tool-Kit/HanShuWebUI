@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [HanShu] Node.js not found. Install: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [HanShu] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [HanShu] npm install failed
    pause
    exit /b 1
  )
)

echo [HanShu] Starting dev server...
call npm run dev
if errorlevel 1 (
  echo [HanShu] start failed
  pause
  exit /b 1
)

endlocal
