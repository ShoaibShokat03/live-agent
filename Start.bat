@echo off
title J.A.R.V.I.S launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [JARVIS] Node.js is not installed. Get it from https://nodejs.org ^(v22 or newer^).
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [JARVIS] First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [JARVIS] npm install failed.
    pause
    exit /b 1
  )
)

echo [JARVIS] Building...
call node build.mjs >nul 2>&1
if errorlevel 1 (
  echo [JARVIS] Build failed. Run "node build.mjs" to see the errors.
  pause
  exit /b 1
)

echo [JARVIS] Launching...
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
