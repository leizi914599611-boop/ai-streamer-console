#!/usr/bin/env bash
# AutoDL 云端实例自举脚本：由实例 start_command 调用。
# 用法: bash deploy/cloud_bootstrap.sh <service>
#   service: realtime | svc | svs | latentsync
#
# 职责：
#   1) 开启 network_turbo（加速 GitHub / HuggingFace）
#   2) 拉取/更新服务代码（优先用控制台仓库内 tools/ 副本，缺失则克隆上游仓库）
#   3) 创建 conda 环境并安装依赖（版本与本地对齐：python3.10 + torch2.0.1+cu118）
#   4) 下载模型权重（HF 走 hf-mirror.com 镜像）
#   5) 以 --port 6006 后台启动服务（AutoDL 仅公网暴露 6006/6008）
#
# 幂等：安装完成后写入 /root/.bootstrap_done_<service>，二次启动（私有镜像）直接起服务。
set -u

SERVICE="${1:-}"
if [ -z "${SERVICE}" ]; then
  echo "[bootstrap] 用法: cloud_bootstrap.sh <realtime|svc|svs|latentsync>" >&2
  exit 1
fi

APP_DIR=/root/app
REPO_DIR=/root/repos
DONE_MARK="/root/.bootstrap_done_${SERVICE}"
LOG_FILE="/root/bootstrap_${SERVICE}.log"

export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
export PYTHONUNBUFFERED=1

log() { echo "[bootstrap $(date +%H:%M:%S)] $*" >&2; }

# AutoDL 学术资源加速（GitHub / HF / pip 均受益）
if [ -f /etc/network_turbo ]; then
  # shellcheck disable=SC1091
  source /etc/network_turbo || true
  log "network_turbo 已开启"
fi

mkdir -p "${REPO_DIR}"
cd "${APP_DIR}" 2>/dev/null || { log "缺少 ${APP_DIR}（start_command 应先 git clone 控制台仓库）"; exit 1; }

CONDA_BASE="$(conda info --base 2>/dev/null || echo /root/miniconda3)"
# shellcheck disable=SC1091
source "${CONDA_BASE}/etc/profile.d/conda.sh"

# 确保服务代码存在：优先控制台仓库 tools/ 下的副本，否则克隆上游
ensure_repo() {
  # $1=目录名 $2=上游 git 地址
  local name="$1" upstream="$2"
  if [ -d "${APP_DIR}/tools/${name}" ]; then
    echo "${APP_DIR}/tools/${name}"
    return 0
  fi
  if [ ! -d "${REPO_DIR}/${name}" ]; then
    log "克隆上游仓库 ${upstream}"
    git clone --depth 1 "${upstream}" "${REPO_DIR}/${name}" || return 1
  fi
  echo "${REPO_DIR}/${name}"
}

make_env() {
  # $1=环境名
  local env="$1"
  if ! conda env list | grep -qE "^${env} "; then
    log "创建 conda 环境 ${env} (python=3.10)"
    conda create -n "${env}" python=3.10 -y || return 1
  fi
  conda activate "${env}" || return 1
  pip install --upgrade pip >/dev/null
  log "安装 torch 2.0.1+cu118"
  pip install torch==2.0.1+cu118 torchvision==0.15.2+cu118 torchaudio==2.0.2 \
    --index-url https://download.pytorch.org/whl/cu118 || return 1
}

hf_pull() {
  # $1=HF 仓库 $2=本地目录
  log "下载权重 $1 -> $2（hf-mirror）"
  huggingface-cli download "$1" --local-dir "$2" --local-dir-use-symlinks False || return 1
}

start_service() {
  # $1=工作目录，其余=启动命令
  local workdir="$1"; shift
  cd "${workdir}" || return 1
  pkill -f "$*" 2>/dev/null || true
  log "启动服务: $* (cwd=${workdir})"
  nohup "$@" >>"${LOG_FILE}" 2>&1 &
  disown
  # 记录依赖清单指纹，供下次启动判断是否需要刷新
  if [ -f "${workdir}/requirements.txt" ]; then
    sha1sum "${workdir}/requirements.txt" | cut -d' ' -f1 > "${DONE_MARK}.deps"
  fi
  touch "${DONE_MARK}"
  log "已在后台启动，日志: ${LOG_FILE}"
}

# 依赖清单变化时刷新环境（私有镜像跟随仓库更新）
refresh_deps() {
  # $1=conda 环境名 $2=仓库目录
  local env="$1" repo="$2" want have
  [ -f "${repo}/requirements.txt" ] || return 0
  want="$(sha1sum "${repo}/requirements.txt" | cut -d' ' -f1)"
  have="$(cat "${DONE_MARK}.deps" 2>/dev/null || true)"
  [ "${want}" = "${have}" ] && return 0
  log "依赖清单有变化，刷新 ${env} 环境依赖"
  conda activate "${env}" >/dev/null 2>&1 || return 1
  pip install -r "${repo}/requirements.txt" 2>&1 | tail -3 || true
  echo "${want}" > "${DONE_MARK}.deps"
}

install_realtime() {
  local repo
  repo="$(ensure_repo MuseTalk https://github.com/TMElyralab/MuseTalk.git)" || return 1
  make_env musetalk || return 1
  [ -f "${repo}/requirements.txt" ] && pip install -r "${repo}/requirements.txt"
  pip install "yapf==0.40.2" "numpy==1.23.5" "mmcv==2.0.1" "mmdet==3.2.0" "mmpose==1.3.2" \
    edge-tts fastapi uvicorn python-multipart soundfile librosa
  mkdir -p "${repo}/models"
  [ -d "${repo}/models/musetalkV15" ] || hf_pull TMElyralab/MuseTalk "${repo}/models"
  start_service "${repo}" python scripts/realtime_service.py --port 6006
}

install_svs() {
  local repo
  repo="$(ensure_repo SoulX-Singer https://github.com/Soul-AILab/SoulX-Singer.git)" || return 1
  make_env soulxsinger || return 1
  [ -f "${repo}/requirements.txt" ] && pip install -r "${repo}/requirements.txt"
  if [ ! -f "${repo}/pretrained_models/SoulX-Singer/model.pt" ]; then
    hf_pull "${SOULX_HF_REPO:-Soul-AILab/SoulX-Singer}" "${repo}/pretrained_models/SoulX-Singer"
  fi
  start_service "${repo}" python webui.py --port 6006 --fp16
}

install_svc() {
  local repo
  repo="$(ensure_repo SoulX-Singer https://github.com/Soul-AILab/SoulX-Singer.git)" || return 1
  make_env soulxsinger || return 1
  [ -f "${repo}/requirements.txt" ] && pip install -r "${repo}/requirements.txt"
  if [ ! -f "${repo}/pretrained_models/SoulX-Singer/model-svc.pt" ]; then
    hf_pull "${SOULX_HF_REPO:-Soul-AILab/SoulX-Singer}" "${repo}/pretrained_models/SoulX-Singer"
  fi
  start_service "${repo}" python webui_svc.py --port 6006 --fp16
}

install_latentsync() {
  local repo
  repo="$(ensure_repo LatentSync https://github.com/bytedance/LatentSync.git)" || return 1
  make_env latentsync || return 1
  [ -f "${repo}/requirements.txt" ] && pip install -r "${repo}/requirements.txt"
  if [ ! -d "${repo}/checkpoints" ]; then
    hf_pull "${LATENTSYNC_HF_REPO:-ByteDance/LatentSync-1.6}" "${repo}/checkpoints"
  fi
  start_service "${repo}" python gradio_app.py --port 6006
}

# 二次启动（私有镜像已含环境）：先按需刷新依赖，再直接起服务
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
  refresh_deps "${env}" "${repo}"
  conda activate "${env}" || return 1
  # shellcheck disable=SC2086
  start_service "${repo}" ${cmd}
}

if [ -f "${DONE_MARK}" ]; then
  log "检测到 ${DONE_MARK}，跳过安装直接启动 ${SERVICE}"
  quick_start
  exit $?
fi

log "首次部署 ${SERVICE}，开始安装环境"
case "${SERVICE}" in
  realtime) install_realtime ;;
  svs) install_svs ;;
  svc) install_svc ;;
  latentsync) install_latentsync ;;
  *) log "未知服务: ${SERVICE}"; exit 1 ;;
esac
