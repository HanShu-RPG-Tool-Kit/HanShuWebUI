@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [HanShu] Node.js not found. Install: https://nodejs.org/
  pause
  exit /b 1
)

rem Always sync: after git pull, new deps (e.g. skinview3d) would be missed
rem if we only install when node_modules is missing.
echo [HanShu] Syncing dependencies...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo [HanShu] npm install failed
  pause
  exit /b 1
)

echo [HanShu] Starting dev server...
call npm run dev
if errorlevel 1 (
  echo [HanShu] start failed
  pause
  exit /b 1
)

endlocal
