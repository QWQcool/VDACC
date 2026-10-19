@echo off
rem 双击打开图形界面（不显示命令行窗口）
cd /d "%~dp0"
if not exist "%~dp0venv\Scripts\pythonw.exe" (
    echo [ERROR] venv missing: %~dp0venv\Scripts\pythonw.exe
    pause
    exit /b 1
)
start "" "%~dp0venv\Scripts\pythonw.exe" "%~dp0dy_gui.pyw"
exit /b
