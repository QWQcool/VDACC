@echo off
rem VDACC launcher: start the local service, then open the browser with a valid token.
rem Keep this file ASCII-only: cmd renders UTF-8 batch files as mojibake on GBK systems.
setlocal
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
    echo [ERROR] bun not found in PATH.
    echo         Install Bun from https://bun.sh or add it to PATH, then run this file again.
    pause
    exit /b 1
)

echo Starting VDACC on http://127.0.0.1:8765 ...
echo Close this window or press Ctrl+C to stop the service.
echo.
bun ts/src/server.ts --port 8765 --open

echo.
echo Server stopped.
pause
