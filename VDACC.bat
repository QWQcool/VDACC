@echo off
rem VDACC launcher: start the local service, then open the browser with a valid token.
rem Keep this file ASCII-only: cmd renders UTF-8 batch files as mojibake on GBK systems.
rem
rem Behaviour: if the port is already held by a previous VDACC (bun) process, that
rem process is stopped first and the new one takes over. Rationale: a stale server
rem keeps serving OLD code, which looks exactly like "my fix did not work" and is
rem much harder to notice than an outright startup error.
setlocal enabledelayedexpansion
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

rem --- Take over the port from a previous instance ------------------------------
set "PORT=8765"
set "OLD_PID="
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R /C:":%PORT% .*LISTENING"') do if not defined OLD_PID set "OLD_PID=%%a"

if defined OLD_PID (
    set "OLD_NAME="
    for /f "tokens=1 delims=," %%b in ('tasklist /FI "PID eq !OLD_PID!" /NH /FO CSV 2^>nul') do if not defined OLD_NAME set "OLD_NAME=%%~b"
    if /i "!OLD_NAME!"=="bun.exe" (
        echo Stopping previous instance on port %PORT% ^(PID !OLD_PID!^) ...
        taskkill /F /PID !OLD_PID! >nul 2>nul
        rem Give the OS a moment to release the socket before binding it again.
        ping -n 2 127.0.0.1 >nul 2>nul
    ) else (
        echo [ERROR] Port %PORT% is already used by "!OLD_NAME!" ^(PID !OLD_PID!^).
        echo         Close that program first, then run this file again.
        pause
        exit /b 1
    )
)

rem ffmpeg is only needed by Bilibili (DASH merge), music tagging and HLS sniffing.
rem Warn instead of blocking so Douyin-only use still works.
where ffmpeg >nul 2>nul
if errorlevel 1 if not exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" (
    echo [WARN] ffmpeg not found - Bilibili / music / m3u8 downloads will fail.
    echo        Install it with:  winget install Gyan.FFmpeg
    echo.
)

echo Starting VDACC on http://127.0.0.1:%PORT% ...
echo Close this window or press Ctrl+C to stop the service.
echo.
"%BUN%" ts/src/server.ts --port %PORT% --open

echo.
echo Server stopped.
pause
