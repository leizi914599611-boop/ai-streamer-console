#!/usr/bin/env bash
# AutoDL 云端实例自举脚本（由实例 start_command 调用）
#
# 用法:
#   bash deploy/cloud_bootstrap.sh prepare        # 一次性安装全部服务的环境与权重（不启动服务，用于构建共享私有镜像）
#   bash deploy/cloud_bootstrap.sh realtime       # 安装(若无 marker)并启动 MuseTalk 实时互动
#   bash deploy/cloud_bootstrap.sh svs            # SoulX-Singer 歌声合成 WebUI
#   bash deploy/cloud_bootstrap.sh svc            # SoulX-Singer 音色转换 WebUI
#   bash deploy/cloud_bootstrap.sh latentsync     # LatentSync 口型驱动
#
# 设计:
#   - 全部服务共用同一块系统盘与同一份私有镜像（不同实例各自启动其中一个服务，均监听 6006）
#   - 安装完成后写入 /root/.install_done_<env>，二次开机（私有镜像）跳过安装直接起服务
#   - 版本与本地验证环境对齐（见各 install_* 函数）
set -u

SERVICE="${1:-}"
if [ -z "${SERVICE}" ]; then
  echo "[bootstrap] 用法: cloud_bootstrap.sh <prepare|realtime|svs|svc|latentsync>" >&2
  exit 1
fi

APP_DIR=/root/app
REPO_DIR=/root/repos
DONE_DIR=/root
LOG_FILE="/root/bootstrap_${SERVICE}.log"

export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
export PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL:-}"
export PYTHONUNBUFFERED=1

log() { echo "[bootstrap $(date +%H:%M:%S)] $*" >&2; }

# 不启用 network_turbo：实测其仅加速 github/huggingface 官方域名，会显著拖慢
# pip 镜像源（tuna/SJTU/openmmlab）与 hf-mirror.com，而本脚本全部依赖均走国内镜像
log "network_turbo 保持关闭（镜像源足够快，开启反而拖慢 pip/hf-mirror）"

mkdir -p "${REPO_DIR}"
cd "${APP_DIR}" 2>/dev/null || { log "缺少 ${APP_DIR}（start_command 应先 git clone 控制台仓库）"; exit 1; }

CONDA_BASE="$(conda info --base 2>/dev/null || echo /root/miniconda3)"
# shellcheck disable=SC1091
source "${CONDA_BASE}/etc/profile.d/conda.sh"

# ---------------------------------------------------------------- 通用工具 -- #

ensure_repo() {
  # $1=目录名 $2=上游 git 地址
  local name="$1" upstream="$2"
  if [ -d "${APP_DIR}/tools/${name}" ]; then
    echo "${APP_DIR}/tools/${name}"
    return 0
  fi
  if [ ! -d "${REPO_DIR}/${name}/.git" ]; then
    log "克隆上游仓库 ${upstream}（git 走 network_turbo 代理，pip 不受影响）"
    # 仅 git 在子 shell 内启用 network_turbo 代理，避免污染 pip/hf-mirror 的镜像直连
    ( source /etc/network_turbo >/dev/null 2>&1 || true; \
      git clone --depth 1 "${upstream}" "${REPO_DIR}/${name}" ) || return 1
  fi
  echo "${REPO_DIR}/${name}"
}

make_env() {
  # $1=环境名 $2=python 版本
  local env="$1" py="${2:-3.10}"
  if ! conda env list | grep -qE "^${env} "; then
    log "创建 conda 环境 ${env} (python=${py})"
    conda create -n "${env}" "python=${py}" -y || return 1
  fi
  conda activate "${env}" || return 1
  pip install --upgrade pip setuptools wheel >/dev/null 2>&1 || true
  python -c "import torch" 2>/dev/null && log "  ${env}: torch 已安装" || log "  ${env}: 待安装 torch"
}

hf_pull() {
  # $1=HF 仓库 $2=本地目录 [$3=include...]
  local repo="$1" dir="$2"; shift 2
  log "下载权重 ${repo} -> ${dir}"
  if [ $# -gt 0 ]; then
    huggingface-cli download "${repo}" --local-dir "${dir}" --include "$@" --local-dir-use-symlinks False || return 1
  else
    huggingface-cli download "${repo}" --local-dir "${dir}" --local-dir-use-symlinks False || return 1
  fi
}

copy_overlay() {
  # $1=相对 deploy/overlays 的路径  $2=目标目录
  local src="${APP_DIR}/deploy/overlays/$1" dst="$2"
  if [ -f "${src}" ]; then
    mkdir -p "${dst}"
    cp -f "${src}" "${dst}/" && log "  应用覆盖文件: $(basename "${src}")"
  fi
}

start_service() {
  # $1=工作目录，其余=启动命令
  local workdir="$1"; shift
  cd "${workdir}" || return 1
  pkill -f "$*" 2>/dev/null || true
  log "启动服务: $* (cwd=${workdir})"
  nohup "$@" >>"${LOG_FILE}" 2>&1 &
  disown
  touch "${DONE_DIR}/.install_done_${SERVICE}"
  log "已在后台启动，日志: ${LOG_FILE}"
}

# ------------------------------------------------------------ 安装各服务 -- #

install_realtime() {
  [ -f "${DONE_DIR}/.install_done_realtime" ] && return 0
  local repo
  repo="$(ensure_repo MuseTalk https://github.com/TMElyralab/MuseTalk.git)" || return 1
  make_env musetalk 3.10 || return 1

  # pytorch.org 直连在国内会被限速到 ~10kB/s，优先走 SJTU 镜像直链（linux_x86_64 tag 与官方一致）
  log "安装 torch 2.0.1+cu118（SJTU 镜像直链，回退 pytorch.org）"
  local SJTU=https://mirror.sjtu.edu.cn/pytorch-wheels/cu118
  pip install \
    "${SJTU}/torch-2.0.1%2Bcu118-cp310-cp310-linux_x86_64.whl" \
    "${SJTU}/torchvision-0.15.2%2Bcu118-cp310-cp310-linux_x86_64.whl" \
    "${SJTU}/torchaudio-2.0.2%2Bcu118-cp310-cp310-linux_x86_64.whl" \
    || pip install torch==2.0.1+cu118 torchvision==0.15.2+cu118 torchaudio==2.0.2+cu118 \
      --index-url https://download.pytorch.org/whl/cu118 || return 1

  log "安装 MuseTalk 依赖（跳过 tensorflow 训练相关包）"
  grep -v -E '^(tensorflow|tensorboard)' "${repo}/requirements.txt" > /tmp/req_musetalk.txt
  pip install -r /tmp/req_musetalk.txt || log "  部分依赖安装失败，继续"

  log "安装 mmcv 2.0.1 / mmdet 3.2.0 / mmpose 1.3.2（OpenMMLab 预编译包）"
  pip install mmcv==2.0.1 -f https://download.openmmlab.com/mmcv/dist/cu118/torch2.0/index.html || return 1
  pip install mmdet==3.2.0 mmpose==1.3.2 || return 1
  pip install "numpy==1.23.5" faster-whisper fastapi uvicorn python-multipart edge-tts "yapf==0.40.2" \
    "huggingface_hub==0.30.2" || return 1

  # 自定义实时服务入口（仓库内 tools/ 副本不入库，随控制台仓库以 overlays 分发）
  copy_overlay MuseTalk/scripts/realtime_service.py "${repo}/scripts"

  log "下载 MuseTalk 权重（约 4.1GB）"
  mkdir -p "${repo}/models"
  [ -f "${repo}/models/musetalkV15/unet.pth" ] || hf_pull TMElyralab/MuseTalk "${repo}/models" "musetalkV15/*"
  [ -f "${repo}/models/sd-vae/diffusion_pytorch_model.bin" ] || hf_pull stabilityai/sd-vae-ft-mse "${repo}/models/sd-vae"
  [ -f "${repo}/models/whisper/pytorch_model.bin" ] || hf_pull openai/whisper-tiny "${repo}/models/whisper"
  [ -f "${repo}/models/dwpose/dw-ll_ucoco_384.pth" ] || hf_pull yzd-v/DWPose "${repo}/models/dwpose"

  # face-parse-bisent 上游走 Google Drive，国内不可达 → 使用仓库内置文件
  mkdir -p "${repo}/models/face-parse-bisent"
  if [ ! -s "${repo}/models/face-parse-bisent/79999_iter.pth" ]; then
    cp -f "${APP_DIR}/deploy/models/face-parse-bisent/79999_iter.pth" "${repo}/models/face-parse-bisent/" || return 1
  fi
  if [ ! -s "${repo}/models/face-parse-bisent/resnet18-5c106cde.pth" ]; then
    curl -fL https://download.pytorch.org/models/resnet18-5c106cde.pth \
      -o "${repo}/models/face-parse-bisent/resnet18-5c106cde.pth" || log "  resnet18 下载失败"
  fi

  touch "${DONE_DIR}/.install_done_realtime"
  log "realtime 环境与权重安装完成"
}

install_soulx() {
  # svs 与 svc 共用同一套环境/仓库/权重，只安装一次
  if [ -f "${DONE_DIR}/.install_done_soulx" ]; then return 0; fi
  local repo
  repo="$(ensure_repo SoulX-Singer https://github.com/Soul-AILab/SoulX-Singer.git)" || return 1
  make_env soulxsinger 3.10 || return 1

  log "安装 SoulX 依赖（Nemo/FunASR 体积较大，耐心等待）"
  pip install torch==2.2.0 torchaudio==2.2.0 || return 1
  pip install -r "${repo}/requirements.txt" || log "  部分依赖安装失败，继续"
  pip install "numpy==1.26.4" "gradio==6.3.0" "modelscope==1.40.2" "huggingface_hub>=0.20.0" || return 1

  log "下载 SoulX-Singer 权重（SVS+SVC，约 5.3GB）"
  [ -f "${repo}/pretrained_models/SoulX-Singer/model.pt" ] || \
    hf_pull Soul-AILab/SoulX-Singer "${repo}/pretrained_models/SoulX-Singer" || return 1

  log "下载 SoulX-Singer 预处理权重（约 6.6GB）"
  [ -f "${repo}/pretrained_models/SoulX-Singer-Preprocess/rmvpe/model.pt" ] || \
    hf_pull Soul-AILab/SoulX-Singer-Preprocess "${repo}/pretrained_models/SoulX-Singer-Preprocess" || return 1

  touch "${DONE_DIR}/.install_done_soulx"
  log "soulx 环境与权重安装完成"
}

install_latentsync() {
  [ -f "${DONE_DIR}/.install_done_latentsync" ] && return 0
  local repo
  repo="$(ensure_repo LatentSync https://github.com/bytedance/LatentSync.git)" || return 1
  make_env latentsync 3.10 || return 1

  log "安装 LatentSync 依赖（torch 2.5.1+cu121）"
  pip install -r "${repo}/requirements.txt" || log "  部分依赖安装失败，继续"
  pip install "insightface==0.7.3" "onnx==1.16.2" "protobuf==3.20.3" "onnxruntime-gpu==1.21.0" \
    "huggingface_hub==0.30.2" || log "  部分依赖安装失败，继续"

  copy_overlay LatentSync/gradio_app.py "${repo}"

  log "下载 LatentSync 1.6 权重（约 6.4GB）"
  [ -f "${repo}/checkpoints/latentsync_unet.pt" ] || \
    hf_pull ByteDance/LatentSync-1.6 "${repo}/checkpoints" || return 1

  touch "${DONE_DIR}/.install_done_latentsync"
  log "latentsync 环境与权重安装完成"
}

# -------------------------------------------------------------- 启动逻辑 -- #

quick_start() {
  local env repo cmd
  case "${SERVICE}" in
    realtime)
      env=musetalk
      repo="$(ensure_repo MuseTalk https://github.com/TMElyralab/MuseTalk.git)" || return 1
      cmd="python scripts/realtime_service.py --port 6006" ;;
    svs)
      env=soulxsinger
      repo="$(ensure_repo SoulX-Singer https://github.com/Soul-AILab/SoulX-Singer.git)" || return 1
      cmd="python webui.py --port 6006 --fp16" ;;
    svc)
      env=soulxsinger
      repo="$(ensure_repo SoulX-Singer https://github.com/Soul-AILab/SoulX-Singer.git)" || return 1
      cmd="python webui_svc.py --port 6006 --fp16" ;;
    latentsync)
      env=latentsync
      repo="$(ensure_repo LatentSync https://github.com/bytedance/LatentSync.git)" || return 1
      cmd="python gradio_app.py --port 6006" ;;
    *) log "未知服务: ${SERVICE}"; return 1 ;;
  esac
  conda activate "${env}" || return 1
  start_service "${repo}" ${cmd}
}

# ------------------------------------------------------------------ 主流程 -- #

case "${SERVICE}" in
  prepare)
    log "=== 构建共享镜像：安装全部服务环境与权重 ==="
    install_realtime || log "realtime 安装失败（继续其余服务）"
    install_soulx || log "soulx 安装失败（继续其余服务）"
    install_latentsync || log "latentsync 安装失败（继续其余服务）"
    log "=== prepare 完成，可保存私有镜像 ==="
    touch "${DONE_DIR}/.install_done_prepare"
    ;;
  realtime)
    install_realtime || exit 1
    quick_start ;;
  svs|svc)
    install_soulx || exit 1
    quick_start ;;
  latentsync)
    install_latentsync || exit 1
    quick_start ;;
  *)
    log "未知参数: ${SERVICE}"; exit 1 ;;
esac
