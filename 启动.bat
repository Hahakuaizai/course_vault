@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo 正在准备运行环境，首次启动需要一点时间...
  call npm install
  if errorlevel 1 (
    echo.
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" .
exit
