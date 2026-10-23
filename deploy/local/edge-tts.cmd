@echo off
setlocal EnableDelayedExpansion
rem edge-tts 语音合成环境按需安装
cd /d "%~dp0..\.."

echo ##STEP## 1/2 创建 Python 环境（tools\pyenv）
if not exist tools\pyenv\Scripts\python.exe (
  where py >nul 2>nul
  if !errorlevel! == 0 (
    py -3 -m venv tools\pyenv || exit /b 1
  ) else (
    python -m venv tools\pyenv || exit /b 1
  )
)

echo ##STEP## 2/2 安装 edge-tts（阿里云镜像）
tools\pyenv\Scripts\python.exe -m pip install --upgrade pip || exit /b 1
tools\pyenv\Scripts\python.exe -m pip install edge-tts || exit /b 1

echo ##STEP## 2/2 edge-tts 安装完成
exit /b 0
