@echo off
setlocal EnableDelayedExpansion
rem MuseTalk 实时互动按需安装：仓库 + Python3.10 环境 + torch cu118 + 模型权重 + ffmpeg
rem 国内镜像：pip 走阿里云（download-manager 已注入 PIP_INDEX_URL），权重走 hf-mirror
cd /d "%~dp0..\.."

echo ##STEP## 1/6 克隆 MuseTalk 仓库
if not exist tools\MuseTalk\scripts\realtime_service.py (
  if exist tools\MuseTalk rmdir /s /q tools\MuseTalk
  git clone --depth 1 https://github.com/TMElyralab/MuseTalk.git tools\MuseTalk || exit /b 1
)

echo ##STEP## 2/6 准备 Python 3.10 环境（tools\museenv）
if not exist tools\museenv\Scripts\python.exe (
  set "PY310="
  py -3.10 --version >nul 2>&1 && set "PY310=py -3.10"
  if defined PY310 (
    !PY310! -m venv tools\museenv || exit /b 1
  ) else (
    set "CONDA="
    where conda >nul 2>nul && set "CONDA=conda"
    if not defined CONDA if exist "%USERPROFILE%\miniconda3\Scripts\conda.exe" set "CONDA=%USERPROFILE%\miniconda3\Scripts\conda.exe"
    if not defined CONDA if exist "%USERPROFILE%\anaconda3\Scripts\conda.exe" set "CONDA=%USERPROFILE%\anaconda3\Scripts\conda.exe"
    if not defined CONDA if exist "C:\ProgramData\miniconda3\Scripts\conda.exe" set "CONDA=C:\ProgramData\miniconda3\Scripts\conda.exe"
    if not defined CONDA (
      echo [错误] 未找到 Python 3.10：请安装 Python 3.10 或 Miniconda 后重试
      exit /b 1
    )
    "!CONDA!" create -p tools\_base310 python=3.10 -y || exit /b 1
    tools\_base310\python.exe -m venv tools\museenv || exit /b 1
  )
)

echo ##STEP## 3/6 安装 PyTorch 2.0.1 + cu118（约 2.5GB）
tools\museenv\Scripts\python.exe -m pip install --upgrade pip || exit /b 1
tools\museenv\Scripts\python.exe -m pip install torch==2.0.1 torchvision==0.15.2 --index-url https://download.pytorch.org/whl/cu118 || exit /b 1

echo ##STEP## 4/6 安装依赖（Windows 修正版）
pushd tools\MuseTalk
findstr /v /i /r "webrtcvad chumpy xtcocotools yapf mmpose mmdet mmcv numpy" requirements.txt > requirements_win.txt
..\museenv\Scripts\python.exe -m pip install -r requirements_win.txt || (popd & exit /b 1)
..\museenv\Scripts\python.exe -m pip install yapf==0.40.2 webrtcvad-wheels "mmpose==1.3.2" "mmdet==3.2.0" "numpy==1.23.5" faster-whisper || (popd & exit /b 1)
..\museenv\Scripts\python.exe -m pip install "mmcv==2.0.1" -f https://download.openmmlab.com/mmcv/dist/cu118/torch2.0/index.html || (popd & exit /b 1)
..\museenv\Scripts\python.exe -m pip install --no-build-isolation chumpy xtcocotools || (popd & exit /b 1)

echo ##STEP## 5/6 下载模型权重（hf-mirror 镜像，约 3GB）
set "PATH=%CD%\..\museenv\Scripts;%PATH%"
set "HF_ENDPOINT=https://hf-mirror.com"
call download_weights.bat || (popd & exit /b 1)
popd

echo ##STEP## 6/6 准备 ffmpeg
if not exist tools\ffmpeg\ffmpeg.exe (
  if not exist tools\ffmpeg mkdir tools\ffmpeg
  curl -L --fail -o tools\_tmp\ffmpeg.zip https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
  if !errorlevel! == 0 (
    tar -xf tools\_tmp\ffmpeg.zip -C tools\_tmp
    for /d %%d in (tools\_tmp\ffmpeg-*) do copy /y "%%d\bin\ffmpeg.exe" tools\ffmpeg\ffmpeg.exe >nul
    del /q tools\_tmp\ffmpeg.zip 2>nul
  ) else (
    echo [警告] ffmpeg 下载失败，可稍后手动放置到 tools\ffmpeg\ffmpeg.exe 后重新执行本脚本
  )
)

echo ##STEP## 6/6 MuseTalk 实时互动安装完成
exit /b 0
