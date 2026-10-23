'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * MuseTalk 离线口型渲染适配器。
 * 通过子进程调用 `python -m scripts.inference`，把形象视频 + 音频合成为口型视频。
 */
class MuseTalkAdapter {
  constructor({ config, logger, gpuLock, realtime }) {
    this.config = config;
    this.logger = logger;
    this.gpuLock = gpuLock || null;
    this.realtime = realtime || null;
    this.child = null;
  }

  _python() {
    return this.config.resolvePath(this.config.get('muse.pythonPath', 'tools/museenv/Scripts/python.exe'));
  }

  _repo() {
    return this.config.resolvePath(this.config.get('muse.repoDir', 'tools/MuseTalk'));
  }

  /** 模型版本：v15（默认）或 v10，影响权重目录与输出子目录 */
  _version() {
    return this.config.get('muse.version', 'v15') === 'v10' ? 'v10' : 'v15';
  }

  _modelDir() {
    return this._version() === 'v10' ? 'musetalk' : 'musetalkV15';
  }

  /** 校验关键文件，返回缺失项列表 */
  checkSync() {
    const python = this._python();
    const repo = this._repo();
    const missing = [];
    if (!fs.existsSync(python)) missing.push(`Python: ${python}`);
    const modelDir = this._modelDir();
    const required = {
      'scripts/inference.py': path.join(repo, 'scripts', 'inference.py'),
      [`models/${modelDir}/unet.pth`]: path.join(repo, 'models', modelDir, 'unet.pth'),
      [`models/${modelDir}/musetalk.json`]: path.join(repo, 'models', modelDir, 'musetalk.json'),
      'models/sd-vae/diffusion_pytorch_model.bin': path.join(repo, 'models', 'sd-vae', 'diffusion_pytorch_model.bin'),
      'models/whisper/pytorch_model.bin': path.join(repo, 'models', 'whisper', 'pytorch_model.bin'),
      'models/dwpose/dw-ll_ucoco_384.pth': path.join(repo, 'models', 'dwpose', 'dw-ll_ucoco_384.pth'),
      'models/face-parse-bisent/79999_iter.pth': path.join(repo, 'models', 'face-parse-bisent', '79999_iter.pth')
    };
    for (const [label, file] of Object.entries(required)) {
      if (!fs.existsSync(file)) missing.push(`${label}: ${file}`);
      else if (label.endsWith('.pth') || label.endsWith('.bin')) {
        if (fs.statSync(file).size < 1024 * 1024) missing.push(`${label} 不完整`);
      }
    }
    return { ok: missing.length === 0, missing, python, repo };
  }

  async check() {
    const state = this.checkSync();
    if (!state.ok) return { ok: false, detail: `缺少文件: ${state.missing.join('; ')}` };
    const probe = await this._probe();
    return probe;
  }

  _probe() {
    return new Promise((resolve) => {
      const child = spawn(this._python(), ['-c', 'import torch,sys;print(torch.__version__);print(torch.cuda.is_available())'], {
        cwd: this._repo(),
        windowsHide: true
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => { out += b.toString('utf8'); });
      child.stderr.on('data', (b) => { err += b.toString('utf8'); });
      child.on('error', (e) => resolve({ ok: false, detail: e.message }));
      child.on('close', (code) => {
        if (code !== 0) return resolve({ ok: false, detail: (err || out).trim().split('\n').slice(-2).join(' ') });
        const [ver, cuda] = out.trim().split(/\r?\n/);
        resolve({ ok: true, detail: `torch ${ver} / CUDA ${cuda === 'True' ? '可用' : '不可用'} @ ${this._python()}` });
      });
    });
  }

  /**
   * 渲染单个任务（先释放实时服务显存并抢占 GPU 互斥锁）。
   * @param {object} opts { videoPath, audioPath, jobId, onProgress }
   * @returns {Promise<string>} 输出视频绝对路径
   */
  async render(opts) {
    if (this.realtime) {
      const released = await this.realtime.unload();
      if (released && released.ok) this.logger.info('muse', '已释放实时服务显存');
    }
    let locked = false;
    if (this.gpuLock) {
      locked = await this.gpuLock.acquire({
        onWait: () => this.logger.info('muse', '等待 GPU 释放（实时互动进行中）…')
      });
      if (!locked) throw new Error('等待 GPU 超时，请稍后重试');
    }
    try {
      return await this._renderUnlocked(opts);
    } finally {
      if (locked) this.gpuLock.release();
    }
  }

  async _renderUnlocked({ videoPath, audioPath, jobId, onProgress = () => {} }) {
    const state = this.checkSync();
    if (!state.ok) throw new Error(`MuseTalk 环境不完整: ${state.missing.join('; ')}`);
    if (!videoPath || !fs.existsSync(videoPath)) throw new Error(`形象素材不存在: ${videoPath}`);
    if (!audioPath || !fs.existsSync(audioPath)) throw new Error(`音频不存在: ${audioPath}`);

    const repo = state.repo;
    // 注意：OpenCV 在 Windows 上无法读取含中文的绝对路径，因此所有输入输出都放在
    // 仓库内的相对工作目录中（cwd=repo），避免路径里出现中文。
    const resultRoot = path.join(repo, 'results', '_work', jobId);
    const resultDir = path.join(resultRoot, 'out');
    const relRoot = `results/_work/${jobId}`;
    fs.mkdirSync(resultDir, { recursive: true });

    const videoExt = path.extname(videoPath) || '.mp4';
    const audioExt = path.extname(audioPath) || '.wav';
    const localVideo = path.join(resultRoot, `input-video${videoExt}`);
    const localAudio = path.join(resultRoot, `input-audio${audioExt}`);
    fs.copyFileSync(videoPath, localVideo);
    fs.copyFileSync(audioPath, localAudio);

    const resultName = `out-${jobId.slice(0, 8)}.mp4`;
    const configPath = path.join(resultRoot, 'task.yaml');
    fs.writeFileSync(
      configPath,
      [
        'task_0:',
        `  video_path: "${toPosix(path.join(relRoot, `input-video${videoExt}`))}"`,
        `  audio_path: "${toPosix(path.join(relRoot, `input-audio${audioExt}`))}"`,
        `  result_name: "${resultName}"`,
        ''
      ].join('\n'),
      'utf8'
    );

    const ffmpegDir = this.config.resolvePath(this.config.get('muse.ffmpegPath', 'tools/ffmpeg'));
    const args = [
      '-m', 'scripts.inference',
      '--inference_config', toPosix(path.join(relRoot, 'task.yaml')),
      '--result_dir', toPosix(path.join(relRoot, 'out')),
      '--unet_model_path', `models/${this._modelDir()}/unet.pth`,
      '--unet_config', `models/${this._modelDir()}/musetalk.json`,
      '--version', this._version(),
      '--ffmpeg_path', ffmpegDir,
      '--batch_size', String(this.config.get('muse.batchSize', 4)),
      '--fps', String(this.config.get('muse.fps', 25)),
      '--extra_margin', String(this.config.get('muse.extraMargin', 10))
    ];
    if (this.config.get('muse.useFloat16', true)) args.push('--use_float16');

    const tmpDir = path.join(this.config.appDir, 'data', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', TEMP: tmpDir, TMP: tmpDir };
    env.PATH = `${ffmpegDir}${path.delimiter}${env.PATH || ''}`;

    this.logger.info('muse', `开始渲染 ${path.basename(videoPath)} + ${path.basename(audioPath)}`);
    onProgress(3, '加载模型');

    let totalFrames = 0;
    let lastPct = 0;
    const expected = path.join(resultDir, this._version(), resultName);

    try {
      await this._spawn(args, { cwd: repo, env }, (line) => {
        if (/(\d+)%\|/.test(line)) {
          const pct = Number(RegExp.$1);
          if (pct >= lastPct + 5) {
            lastPct = pct;
            onProgress(20 + Math.round(pct * 0.55), `口型推理 ${pct}%`);
          }
          return;
        }
        if (/Number of frames:\s*(\d+)/.test(line)) {
          totalFrames = Number(RegExp.$1);
          onProgress(12, `预处理 ${totalFrames} 帧`);
        } else if (line.includes('Starting inference')) {
          onProgress(20, '口型推理中');
        } else if (line.includes('Padding generated')) {
          onProgress(80, '画面融合');
        } else if (line.includes('Video generation command')) {
          onProgress(90, '编码视频');
        } else if (line.includes('Results saved to')) {
          onProgress(98, '收尾');
        } else if (/Error occurred/i.test(line)) {
          this.logger.warn('muse', line.trim());
        } else if (line.trim() && !/^\s*\d+%\|/.test(line)) {
          this.logger.info('muse', line.trim().slice(0, 300));
        }
      });
    } catch (err) {
      throw err;
    } finally {
      this.child = null;
    }

    if (!fs.existsSync(expected)) {
      throw new Error('渲染结束但未找到输出文件，请检查控制台日志');
    }
    const outDir = this.config.resolvePath(this.config.get('queue.outputDir', 'data/renders'));
    fs.mkdirSync(outDir, { recursive: true });
    const finalPath = path.join(outDir, `lip-sync-${jobId.slice(0, 8)}.mp4`);
    fs.copyFileSync(expected, finalPath);
    onProgress(100, '完成');
    try {
      fs.rmSync(resultRoot, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('muse', `临时目录清理失败: ${err.message}`);
    }
    this.logger.success('muse', `渲染完成: ${finalPath}`);
    return finalPath;
  }

  _spawn(args, options, onLine) {
    return new Promise((resolve, reject) => {
      const child = spawn(this._python(), args, { cwd: options.cwd, env: options.env, windowsHide: true });
      this.child = child;
      let buffer = '';
      const feed = (chunk) => {
        buffer += chunk;
        const parts = buffer.split(/\r?\n|\r/);
        buffer = parts.pop();
        for (const line of parts) {
          if (line.trim()) onLine(line);
        }
      };
      child.stdout.on('data', (b) => feed(b.toString('utf8')));
      child.stderr.on('data', (b) => feed(b.toString('utf8')));
      let tail = '';
      child.stdout.on('data', (b) => { tail = (tail + b.toString('utf8')).slice(-4000); });
      child.stderr.on('data', (b) => { tail = (tail + b.toString('utf8')).slice(-4000); });
      child.on('error', (err) => reject(new Error(`渲染进程启动失败: ${err.message}`)));
      child.on('close', (code) => {
        this.child = null;
        if (code === 0) resolve();
        else reject(new Error(`渲染进程退出 code=${code}: ${tail.trim().split('\n').slice(-3).join(' ')}`));
      });
    });
  }

  stop() {
    if (!this.child) return false;
    try {
      this.child.kill();
    } catch (err) {
      this.logger.warn('muse', `停止渲染失败: ${err.message}`);
    }
    return true;
  }
}

module.exports = { MuseTalkAdapter };
