@echo off
rem Windows dev launcher: keeps every cache, temp file and app data off C:.
rem Usage: scripts\dev.cmd            (hot-reload dev)
rem        scripts\dev.cmd preview    (run the production build)
setlocal
cd /d "%~dp0.."

rem Dev always uses its own data folder, never the installed app's (AIMO_DATA_DIR may be set for the installed app).
if defined AIMO_DEV_DATA_DIR (set "AIMO_DATA_DIR=%AIMO_DEV_DATA_DIR%") else (set "AIMO_DATA_DIR=F:\Claude\AI Media Operations\data-dev")
set "TMP=F:\Claude\tmp"
set "TEMP=F:\Claude\tmp"
set "npm_config_cache=F:\npm\cache"
set "ELECTRON_CACHE=F:\Claude\cache\electron"
set "ELECTRON_BUILDER_CACHE=F:\Claude\cache\electron-builder"
set "ELECTRON_RUN_AS_NODE="
if not exist "%TMP%" mkdir "%TMP%"

where node >nul 2>nul || (echo Node.js not found on PATH & exit /b 1)
if not exist node_modules\electron\dist\electron.exe (
  echo Installing dependencies...
  call npm install || exit /b 1
)

echo Data directory: %AIMO_DATA_DIR%
if /i "%~1"=="preview" (
  call npm run start
) else (
  call npm run dev
)
