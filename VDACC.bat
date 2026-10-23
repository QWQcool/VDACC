@echo off
rem VDACC launcher: start the local service, then open the browser with a valid token.
rem Keep this file ASCII-only: cmd renders UTF-8 batch files as mojibake on GBK systems.
setlocal
cd /d "%~dp0"

rem Resolve bun. `where` only sees the PATH this window inherited, so also probe the
rem winget shim directly - otherwise a freshly installed bun looks "missing" until
rem the user opens a brand-new terminal.
set "BUN="
for /f "delims=" %%i in ('where bun 2^>nul') do if not defined BUN set "BUN=%%i"
if not defined BUN if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe" set "BUN=%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe"
if not defined BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"

if not defined BUN (
    echo [ERROR] bun not found.
    echo         Install it with:  winget install Oven-sh.Bun
    echo         then run this file again.
    pause
    exit /b 1
)

rem ffmpeg is only needed by Bilibili (DASH merge), music tagging and HLS sniffing.
rem Warn instead of blocking so Douyin-only use still works.
where ffmpeg >nul 2>nul
if errorlevel 1 if not exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" (
    echo [WARN] ffmpeg not found - Bilibili / music / m3u8 downloads will fail.
    echo        Install it with:  winget install Gyan.FFmpeg
    echo.
)

echo Starting VDACC on http://127.0.0.1:8765 ...
echo Close this window or press Ctrl+C to stop the service.
echo.
"%BUN%" ts/src/server.ts --port 8765 --open

echo.
echo Server stopped.
pause
