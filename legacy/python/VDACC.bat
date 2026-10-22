@echo off
setlocal
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
    echo [1/3] 创建 venv ...
    python -m venv venv || goto :fail
)

if not exist "venv\.deps-ok" (
    echo [2/3] 安装可选依赖 ...
    venv\Scripts\python.exe -m pip install -q --upgrade pip
    venv\Scripts\python.exe -m pip install -q -r requirements.txt || goto :fail
    echo ok > "venv\.deps-ok"
)

echo [3/3] 启动服务 ...
venv\Scripts\python.exe -m vdl serve %*
goto :eof

:fail
echo.
echo 启动失败。先看 `venv\Scripts\python.exe -m vdl doctor`
pause
exit /b 1
