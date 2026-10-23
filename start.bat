@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 未找到 Electron，请先执行: tools\node\npm.cmd install
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
