@echo off
setlocal EnableDelayedExpansion
rem LatentSync 口型驱动按需安装：仓库 + conda 环境（tools\lsenv） + 权重
rem 安装完成后 download-manager 会把服务配置指向项目内 tools/ 路径
cd /d "%~dp0..\.."

echo ##STEP## 1/4 克隆 LatentSync 仓库
if not exist tools\LatentSync\gradio_app.py (
  if exist tools\LatentSync rmdir /s /q tools\LatentSync
  git clone --depth 1 https://github.com/bytedance/LatentSync.git tools\LatentSync || exit /b 1
)

echo ##STEP## 2/4 创建 conda 环境 tools\lsenv（Python 3.10）
set "CONDA="
where conda >nul 2>nul && set "CONDA=conda"
if not defined CONDA if exist "%USERPROFILE%\miniconda3\Scripts\conda.exe" set "CONDA=%USERPROFILE%\miniconda3\Scripts\conda.exe"
if not defined CONDA if exist "%USERPROFILE%\anaconda3\Scripts\conda.exe" set "CONDA=%USERPROFILE%\anaconda3\Scripts\conda.exe"
if not defined CONDA if exist "C:\ProgramData\miniconda3\Scripts\conda.exe" set "CONDA=C:\ProgramData\miniconda3\Scripts\conda.exe"
if not defined CONDA (
  echo [错误] LatentSync 需要 Miniconda/Anaconda，请先安装后重试
  exit /b 1
)
if not exist tools\lsenv\python.exe "!CONDA!" create -p tools\lsenv python=3.10 -y || exit /b 1

echo ##STEP## 3/4 安装依赖（torch cu118 + Windows 兼容修正）
tools\lsenv\python.exe -m pip install --upgrade pip || exit /b 1
tools\lsenv\python.exe -m pip install torch==2.0.1 torchvision==0.15.2 --index-url https://download.pytorch.org/whl/cu118 || exit /b 1
pushd tools\LatentSync
..\lsenv\python.exe -m pip install -r requirements.txt || (popd & exit /b 1)
popd
rem Windows 兼容：onnx 1.16.2 / protobuf 3.20.3（mediapipe）/ webrtcvad-wheels / insightface
tools\lsenv\python.exe -m pip install "onnx==1.16.2" "protobuf==3.20.3" webrtcvad-wheels ffmpeg-python imageio-ffmpeg || exit /b 1
tools\lsenv\python.exe -m pip install "insightface==0.7.3" || tools\lsenv\python.exe -m pip install insightface || exit /b 1

echo ##STEP## 4/4 下载权重（hf-mirror 镜像）
pushd tools\LatentSync
set "HF_ENDPOINT=https://hf-mirror.com"
..\lsenv\python.exe -m pip install -U "huggingface_hub[hf_xet]" || (popd & exit /b 1)
..\lsenv\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('ByteDance/LatentSync', local_dir='checkpoints')" || (popd & exit /b 1)
popd

echo ##STEP## 4/4 LatentSync 安装完成
exit /b 0
