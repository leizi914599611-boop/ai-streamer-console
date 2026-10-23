'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 能力矩阵：动态探测后计算真实可行性。
 * 每个任务：supported 依据仓库是否有对应训练脚本；canRun = supported && VRAM 达标。
 * 调用方传入完整 config（用于解析 spec.cwd 与 cloud.autoDL）+ SystemMonitor.collect() 返回的 gpu + services。
 */

const TASK_DEFS = [
  {
    id: 'svs-finetune',
    name: 'AI 歌手音色微调训练',
    kind: 'training',
    supported: false, // SoulX-Singer 官方为零样本方案，仓库无训练代码（README "no fine-tuning needed"）
    minVramMb: 0,
    reason: 'SoulX-Singer 官方未提供微调训练代码，README 明确 "no fine-tuning needed"',
    alternative: '改用「零样本音色克隆（SVC）」；咬字与转音效果主要取决于音色样本质量'
  },
  {
    id: 'musetalk-train',
    name: '口型 / 形象训练（MuseTalk）',
    kind: 'training',
    minVramMb: 24576,
    scripts: ['train.py', 'configs/training'],
    reason: 'tools/MuseTalk/train.py 基于 Accelerator 做全量训练，官方参考卡为 V100 32GB',
    alternative: '8GB 显存可用「形象预处理」提升贴合度，但不改变模型权重'
  },
  {
    id: 'latentsync-train',
    name: '口型训练（LatentSync）',
    kind: 'training',
    minVramMb: 23552,
    scripts: ['train.py', 'train.sh', 'scripts/train.py'],
    repoByService: 'latentsync',
    reason: 'LatentSync 训练 stage1 约 23GB、stage2 约 30GB 显存',
    alternative: '仅可运行推理（v1.5 最低 8GB）'
  },
  {
    id: 'svc-clone',
    name: '零样本音色克隆（SVC）',
    kind: 'inference',
    minVramMb: 6144,
    reason: '官方支持免训练音色迁移：音色参考 + 源歌声 → 目标音色',
    alternative: ''
  },
  {
    id: 'avatar-prepare',
    name: '形象预处理（口型对齐）',
    kind: 'prepare',
    minVramMb: 5120,
    reason: '抽取人脸关键点并缓存，直接影响真人感与表情稳定性',
    alternative: ''
  }
];

function _repoOf(config, id) {
  const list = (config.get('services') || []).filter((s) => s.id === id && s.mode !== 'cloud');
  if (list.length && list[0].cwd) {
    const cwd = list[0].cwd;
    return path.isAbsolute(cwd) ? cwd : config.resolvePath(cwd);
  }
  // 兜底：从 muse / soulx 专属字段推导
  if (id === 'latentsync') return config.resolvePath(config.get('muse.repoDir', ''));
  return null;
}

/** 检查一组相对路径是否存在（全部存在才算 supported） */
function _hasAny(parent, relatives) {
  if (!parent) return { ok: false, missing: relatives.join(', ') };
  const missing = relatives.filter((p) => !fs.existsSync(path.join(parent, p)));
  return { ok: missing.length === 0, missing: missing.join(', ') };
}

/**
 * 合成 GPU 视角：本地 GPU + 已配置的云端 GPU（AutoDL）。
 * 云端 GPU 默认叠加在本地 GPU 上，取「最大可用 VRAM」作为训练判定依据。
 */
function _resolveVram(gpu, config) {
  const local = gpu && gpu.available ? gpu.totalMb : 0;
  const cloud = config.get('cloud.autoDL.vramMb', 0) || 0;
  const autoDLOn = Boolean(config.get('cloud.autoDL.endpoint')) && cloud > 0;
  return { local, cloud, autoDLOn, effective: Math.max(local, cloud) };
}

/**
 * 根据 config + gpu + services（可选）实时计算任务矩阵。
 * @param {object} opts { config, gpu, services }
 * @returns {object} { gpu, effectiveVramMb, cloud, tasks }
 */
function capabilities({ config, gpu, services }) {
  const vram = _resolveVram(gpu, config);
  const tasks = [];
  for (const def of TASK_DEFS) {
    let supported = def.supported !== undefined ? def.supported : true;
    let missingScripts = '';
    let scriptSource = '';

    if (def.scripts) {
      const repoId = def.repoByService || (def.id === 'musetalk-train' ? 'realtime' : null);
      if (repoId) scriptSource = repoId;
      const repo = _repoOf(config, repoId);
      const check = _hasAny(repo, def.scripts);
      supported = check.ok;
      missingScripts = check.missing;
    }

    const vramOk = supported && vram.effective >= def.minVramMb;
    tasks.push({
      id: def.id,
      name: def.name,
      kind: def.kind,
      supported,
      minVramMb: def.minVramMb,
      canRun: Boolean(vramOk),
      blockedBy: !supported ? 'not-supported' : (vramOk ? null : 'vram'),
      reason: def.reason,
      alternative: def.alternative,
      scriptSource,
      missingScripts,
      autoDLAvailable: vram.autoDLOn && vram.cloud >= def.minVramMb && !vramOk
        ? `AutoDL ${Math.round(vram.cloud / 1024)}GB 可运行`
        : ''
    });
  }
  return {
    gpu: gpu || { available: false },
    autoDL: {
      enabled: vram.autoDLOn,
      endpoint: config.get('cloud.autoDL.endpoint', '') || null,
      vramMb: vram.cloud,
      provider: config.get('cloud.autoDL.provider', 'AutoDL')
    },
    effectiveVramMb: vram.effective,
    tasks
  };
}

module.exports = { capabilities, TASKS: TASK_DEFS };
