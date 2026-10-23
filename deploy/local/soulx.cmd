@echo off
setlocal EnableDelayedExpansion
rem SoulX-Singer（SVS 歌声合成 / SVC 音色转换共用）按需安装
rem 仓库地址可用环境变量 SOULX_REPO 覆盖；权重仓库用 SOULX_WEIGHTS_REPO 覆盖
if not defined SOULX_REPO set "SOULX_REPO=https://github.com/Soul-AILab/SoulX-Singer.git"
if not defined SOULX_WEIGHTS_REPO set "SOULX_WEIGHTS_REPO=Soul-AILab/SoulX-Singer"
cd /d "%~dp0..\.."

echo ##STEP## 1/4 克隆 SoulX-Singer 仓库（%SOULX_REPO%）
if not exist tools\SoulX-Singer\webui.py (
  if exist tools\SoulX-Singer rmdir /s /q tools\SoulX-Singer
  git clone --depth 1 "%SOULX_REPO%" tools\SoulX-Singer || exit /b 1
)

echo ##STEP## 2/4 创建 conda 环境 tools\soulxenv（Python 3.10）
set "CONDA="
where conda >nul 2>nul && set "CONDA=conda"
if not defined CONDA if exist "%USERPROFILE%\miniconda3\Scripts\conda.exe" set "CONDA=%USERPROFILE%\miniconda3\Scripts\conda.exe"
if not defined CONDA if exist "%USERPROFILE%\anaconda3\Scripts\conda.exe" set "CONDA=%USERPROFILE%\anaconda3\Scripts\conda.exe"
if not defined CONDA if exist "C:\ProgramData\miniconda3\Scripts\conda.exe" set "CONDA=C:\ProgramData\miniconda3\Scripts\conda.exe"
if not defined CONDA (
  echo [错误] SoulX-Singer 需要 Miniconda/Anaconda，请先安装后重试
  exit /b 1
)
if not exist tools\soulxenv\python.exe "!CONDA!" create -p tools\soulxenv python=3.10 -y || exit /b 1

echo ##STEP## 3/4 安装依赖（torch cu118 + 歌声合成/人声分离/ASR）
tools\soulxenv\python.exe -m pip install --upgrade pip || exit /b 1
tools\soulxenv\python.exe -m pip install torch==2.0.1 torchvision==0.15.2 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cu118 || exit /b 1
pushd tools\SoulX-Singer
if exist requirements.txt ..\soulxenv\python.exe -m pip install -r requirements.txt || (popd & exit /b 1)
popd
tools\soulxenv\python.exe -m pip install demucs faster-whisper gradio || exit /b 1

echo ##STEP## 4/4 下载模型权重（hf-mirror 镜像，model.pt + model-svc.pt）
pushd tools\SoulX-Singer
set "HF_ENDPOINT=https://hf-mirror.com"
..\soulxenv\python.exe -m pip install -U "huggingface_hub[hf_xet]" || (popd & exit /b 1)
..\soulxenv\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('%SOULX_WEIGHTS_REPO%', local_dir='pretrained_models/SoulX-Singer')" || (popd & exit /b 1)
popd

echo ##STEP## 4/4 SoulX-Singer 安装完成
exit /b 0
