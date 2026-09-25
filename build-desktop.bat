@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  HanShu Desktop Build (Tauri)
echo ========================================
echo.

REM --- prerequisites ---
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install: https://nodejs.org/
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found.
  exit /b 1
)

REM Ensure cargo is on PATH (common after rustup install in same session)
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Rust / cargo not found.
  echo         Install: https://rustup.rs/
  echo         Or: winget install Rustlang.Rustup
  echo         Then reopen this terminal and run again.
  exit /b 1
)

where rustc >nul 2>&1
if errorlevel 1 (
  echo [ERROR] rustc not found. Open a new terminal after installing Rust.
  exit /b 1
)

echo [OK] node  && node -v
echo [OK] cargo && cargo --version
echo.

if not exist "node_modules\" (
  echo [..] npm install ...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed
    exit /b 1
  )
)

REM Hide local secrets from Vite (VITE_* is inlined into the frontend bundle).
set "HS_ENV_STASH="
if exist ".env" (
  set "HS_ENV_STASH=.env.__hanshu_build_stash__"
  if exist ".env.__hanshu_build_stash__" del /f /q ".env.__hanshu_build_stash__" >nul 2>&1
  move /y ".env" ".env.__hanshu_build_stash__" >nul
  if errorlevel 1 (
    echo [ERROR] failed to stash .env for safe build
    exit /b 1
  )
  echo [OK] temporarily stashed .env ^(will restore after build^)
)
set "VITE_DEEPSEEK_API_KEY="
echo [OK] release build will not embed DeepSeek API key
echo.

echo [..] tauri build  (first run may take several minutes^)
echo.
call npm run desktop:build
set "HS_BUILD_EXIT=%ERRORLEVEL%"

if defined HS_ENV_STASH (
  if exist ".env.__hanshu_build_stash__" (
    move /y ".env.__hanshu_build_stash__" ".env" >nul
    echo [OK] restored .env
  )
)

if not "%HS_BUILD_EXIT%"=="0" (
  echo.
  echo [ERROR] desktop build failed
  echo   - Windows needs Visual Studio C++ Build Tools
  echo   - WebView2 Runtime should be present on Win10/11
  exit /b %HS_BUILD_EXIT%
)

echo.
echo ========================================
echo  Build finished
echo ========================================
echo.
echo  Installers / bundles:
echo    src-tauri\target\release\bundle\
echo.
echo  Portable exe:
echo    src-tauri\target\release\hanshu.exe
echo.
echo  Users need their own DeepSeek key for Agent ^(not shipped in this build^).
echo.
exit /b 0
