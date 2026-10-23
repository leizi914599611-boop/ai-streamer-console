'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * 按需下载管理器：服务的本地依赖（仓库 / Python 环境 / 模型权重）不再要求一次性备齐，
 * 每个条目对应 deploy/local/<id>.cmd 安装脚本，脚本通过 `##STEP## n/m 说明` 输出进度。
 * 事件: progress({ id, state, step, totalSteps, label, line, percent, ts })
 */

const ALIYUN_PIP = 'https://mirrors.aliyun.com/pypi/simple/';

/** 组件路径说明：rel 相对项目根 */
function componentPaths(comp, ctx) {
  if (comp.rel) return comp.rel.map((p) => path.join(ctx.appDir, p));
  return [];
}

/** 下载清单：id 即脚本名 deploy/local/<id>.cmd */
const MANIFESTS = [
  {
    id: 'danmu',
    name: '弹幕获取（抖音）',
    serviceId: 'danmu',
    components: [
      { id: 'src', label: '服务源码', rel: ['tools/danmu-service/danmu_service.py', 'tools/danmu-service/sign.js', 'tools/danmu-service/douyin_proto.py'] },
      { id: 'env', label: 'Python 环境', rel: ['tools/danmuenv/Scripts/python.exe'] }
    ]
  },
  {
    id: 'realtime',
    name: 'MuseTalk 实时互动',
    serviceId: 'realtime',
    components: [
      { id: 'repo', label: '仓库', rel: ['tools/MuseTalk/scripts/realtime_service.py'] },
      { id: 'env', label: 'Python 环境', rel: ['tools/museenv/Scripts/python.exe'] },
      {
        id: 'weights', label: '模型权重', rel: [
          'tools/MuseTalk/models/musetalkV15/unet.pth',
          'tools/MuseTalk/models/dwpose/dw-ll_ucoco_384.pth',
          'tools/MuseTalk/models/whisper/pytorch_model.bin',
          'tools/MuseTalk/models/face-parse-bisent/79999_iter.pth',
          'tools/MuseTalk/models/sd-vae/diffusion_pytorch_model.bin'
        ]
      },
      { id: 'ffmpeg', label: 'ffmpeg', rel: ['tools/ffmpeg/ffmpeg.exe'] }
    ]
  },
  {
    id: 'latentsync',
    name: 'LatentSync 口型驱动',
    serviceId: 'latentsync',
    components: [
      { id: 'repo', label: '仓库', rel: ['tools/LatentSync/gradio_app.py'] },
      { id: 'env', label: 'Python 环境', rel: ['tools/lsenv/python.exe'] },
      { id: 'weights', label: '权重', rel: ['tools/LatentSync/checkpoints/latentsync_unet.pt', 'tools/LatentSync/checkpoints/syncnet.pt'] }
    ],
    configPatch: {
      service: {
        cwd: 'tools/LatentSync',
        python: 'tools/lsenv/python.exe',
        envPaths: ['tools/lsenv', 'tools/lsenv/Library/bin', 'tools/lsenv/Scripts']
      }
    }
  },
  {
    id: 'svs',
    name: 'SoulX-Singer 歌声合成',
    serviceId: 'svs',
    script: 'soulx',
    components: [
      { id: 'repo', label: '仓库', rel: ['tools/SoulX-Singer/webui.py'] },
      { id: 'env', label: 'Python 环境', rel: ['tools/soulxenv/python.exe'] },
      { id: 'weights', label: 'SVS 权重', rel: ['tools/SoulX-Singer/pretrained_models/SoulX-Singer/model.pt'] }
    ],
    configPatch: {
      service: {
        cwd: 'tools/SoulX-Singer',
        python: 'tools/soulxenv/python.exe',
        envPaths: ['tools/soulxenv', 'tools/soulxenv/Library/bin', 'tools/soulxenv/Scripts']
      },
      keys: {
        'soulx.pythonPath': 'tools/soulxenv/python.exe',
        'soulx.repoDir': 'tools/SoulX-Singer',
        'soulx.envPaths': ['tools/soulxenv', 'tools/soulxenv/Library/bin', 'tools/soulxenv/Scripts']
      }
    }
  },
  {
    id: 'svc',
    name: 'SoulX-Singer 音色转换',
    serviceId: 'svc',
    script: 'soulx',
    components: [
      { id: 'repo', label: '仓库', rel: ['tools/SoulX-Singer/webui_svc.py'] },
      { id: 'env', label: 'Python 环境', rel: ['tools/soulxenv/python.exe'] },
      { id: 'weights', label: 'SVC 权重', rel: ['tools/SoulX-Singer/pretrained_models/SoulX-Singer/model-svc.pt'] }
    ],
    configPatch: {
      service: {
        cwd: 'tools/SoulX-Singer',
        python: 'tools/soulxenv/python.exe',
        envPaths: ['tools/soulxenv', 'tools/soulxenv/Library/bin', 'tools/soulxenv/Scripts']
      },
      keys: {
        'soulx.pythonPath': 'tools/soulxenv/python.exe',
        'soulx.repoDir': 'tools/SoulX-Singer',
        'soulx.envPaths': ['tools/soulxenv', 'tools/soulxenv/Library/bin', 'tools/soulxenv/Scripts']
      }
    }
  },
  {
    id: 'edge-tts',
    name: 'edge-tts 语音合成',
    serviceId: null,
    components: [
      { id: 'env', label: 'Python 环境', rel: ['tools/pyenv/Scripts/python.exe'] }
    ]
  }
];

class DownloadManager extends EventEmitter {
  constructor({ config, logger, services }) {
    super();
    this.config = config;
    this.logger = logger;
    this.services = services;
    this.appDir = path.resolve(__dirname, '..', '..');
    this.tasks = new Map();
  }

  _specOf(manifest) {
    if (!manifest.serviceId) return null;
    return (this.config.get('services', []) || []).find((s) => s.id === manifest.serviceId) || null;
  }

  /** 单个条目状态：state = installed | partial | missing | running | error */
  status(manifest) {
    const task = this.tasks.get(manifest.id);
    const spec = this._specOf(manifest);
    const components = manifest.components.map((comp) => {
      const paths = componentPaths(comp, { appDir: this.appDir, config: this.config, spec });
      const missing = paths.filter((p) => !fs.existsSync(p));
      return {
        id: comp.id,
        label: comp.label,
        ok: paths.length > 0 && missing.length === 0,
        missing: missing.map((p) => path.relative(this.appDir, p))
      };
    });
    const okCount = components.filter((c) => c.ok).length;
    let state = okCount === components.length ? 'installed' : (okCount === 0 ? 'missing' : 'partial');
    if (task) state = task.state;
    return {
      id: manifest.id,
      name: manifest.name,
      serviceId: manifest.serviceId,
      state,
      components,
      progress: task ? task.progress : null,
      lastError: task && task.state === 'error' ? task.error : null
    };
  }

  list() {
    return MANIFESTS.map((m) => this.status(m));
  }

  /** 服务是否具备本地启动条件（云端模式或未关联下载条目时视为就绪） */
  serviceReady(serviceId) {
    const manifest = MANIFESTS.find((m) => m.serviceId === serviceId);
    if (!manifest) return true;
    return this.status(manifest).state === 'installed';
  }

  _emit(id, patch) {
    const task = this.tasks.get(id);
    const progress = { ...(task ? task.progress : {}), ...patch, ts: Date.now() };
    if (task) task.progress = progress;
    this.emit('progress', { id, ...progress });
  }

  async start(id) {
    const manifest = MANIFESTS.find((m) => m.id === id);
    if (!manifest) throw new Error(`未知下载项: ${id}`);
    const running = this.tasks.get(id);
    if (running && running.state === 'running') throw new Error(`${manifest.name} 正在下载中`);

    const scriptName = manifest.script || manifest.id;
    const script = path.join(this.appDir, 'deploy', 'local', `${scriptName}.cmd`);
    if (!fs.existsSync(script)) throw new Error(`安装脚本缺失: ${path.relative(this.appDir, script)}`);

    const tmpDir = path.join(this.appDir, 'tools', '_tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    const task = { state: 'running', error: null, progress: { state: 'running', percent: 0, label: '准备中', line: '' } };
    this.tasks.set(id, task);
    this.logger.info('download', `[${id}] 开始下载/安装 ${manifest.name}`);
    this._emit(id, { state: 'running', percent: 0, label: '准备中', line: '' });

    return new Promise((resolve, reject) => {
      const child = spawn('cmd.exe', ['/c', script], {
        cwd: this.appDir,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PIP_INDEX_URL: ALIYUN_PIP,
          HF_ENDPOINT: 'https://hf-mirror.com',
          TEMP: tmpDir,
          TMP: tmpDir
        }
      });

      const onLine = (line) => {
        const text = line.trim();
        if (!text) return;
        this.logger.info('download', `[${id}] ${text}`);
        const stepMatch = text.match(/^##STEP##\s+(\d+)\s*\/\s*(\d+)\s*(.*)$/);
        if (stepMatch) {
          const step = Number(stepMatch[1]);
          const totalSteps = Number(stepMatch[2]);
          const label = stepMatch[3] || '';
          this._emit(id, { state: 'running', step, totalSteps, label, line: text, percent: Math.round((step / totalSteps) * 100) });
        } else {
          this._emit(id, { state: 'running', line: text });
        }
      };

      let restOut = '';
      let restErr = '';
      child.stdout.on('data', (buf) => {
        restOut += buf.toString('utf8');
        const lines = restOut.split(/\r?\n/);
        restOut = lines.pop();
        lines.forEach(onLine);
      });
      child.stderr.on('data', (buf) => {
        restErr += buf.toString('utf8');
        const lines = restErr.split(/\r?\n/);
        restErr = lines.pop();
        lines.forEach((l) => l.trim() && this.logger.warn('download', `[${id}] ${l.trim()}`));
      });
      child.on('error', (err) => {
        task.state = 'error';
        task.error = err.message;
        this._emit(id, { state: 'error', label: err.message });
        reject(err);
      });
      child.on('close', (code) => {
        if (code === 0) {
          task.state = 'done';
          try {
            this._applyConfigPatch(manifest);
          } catch (err) {
            this.logger.error('download', `[${id}] 配置回写失败: ${err.message}`);
          }
          this._emit(id, { state: 'done', percent: 100, label: '下载完成' });
          this.logger.success('download', `[${id}] ${manifest.name} 下载完成`);
          this.tasks.delete(id);
          resolve(this.status(manifest));
        } else {
          task.state = 'error';
          task.error = `安装脚本退出码 ${code}，详见日志`;
          this._emit(id, { state: 'error', label: task.error });
          this.logger.error('download', `[${id}] 安装失败（code=${code}）`);
          reject(new Error(task.error));
        }
      });
    });
  }

  /** 下载成功后把服务/适配器配置指向项目内 tools/ 路径，并刷新服务定义 */
  _applyConfigPatch(manifest) {
    const patch = manifest.configPatch;
    if (!patch) return;
    if (patch.service && manifest.serviceId) {
      this.config.setService(manifest.serviceId, patch.service);
      this.logger.info('download', `[${manifest.id}] 服务配置已指向项目内环境`);
    }
    if (patch.keys) {
      for (const [key, value] of Object.entries(patch.keys)) this.config.set(key, value);
    }
    if (this.services && this.services.reloadSpecs) this.services.reloadSpecs();
  }
}

module.exports = { DownloadManager, MANIFESTS };
