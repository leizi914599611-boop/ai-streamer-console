'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Windows 上 Defender/杀软会瞬时锁定新建目录导致 recursive mkdir EPERM，重试几次 */
function mkdirRetry(dir, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return;
    } catch (err) {
      if (i >= attempts - 1 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
      const deadline = Date.now() + 400 * i;
      while (Date.now() < deadline) { /* busy wait */ }
    }
  }
}

/**
 * SoulX-Singer 制曲适配器。
 * 管线：原曲 → preprocess（人声/伴奏分离 + 歌词/音符转写）→ SVS 推理（AI 干声）
 *       → ffmpeg 混音（干声 + 原伴奏）→ 完整歌曲 wav（交给 MuseTalk 做口型）。
 * 与离线渲染共用 GPU 互斥锁，开始前先释放实时服务显存。
 */
class SoulXAdapter {
  constructor({ config, logger, gpuLock, realtime }) {
    this.config = config;
    this.logger = logger;
    this.gpuLock = gpuLock || null;
    this.realtime = realtime || null;
    this.child = null;
  }

  _python() {
    return this.config.resolvePath(this.config.get('soulx.pythonPath'));
  }

  _repo() {
    return this.config.resolvePath(this.config.get('soulx.repoDir'));
  }

  /** 校验关键文件，返回缺失项列表 */
  checkSync() {
    const repo = this._repo();
    const python = this._python();
    const missing = [];
    if (!fs.existsSync(python)) missing.push(`Python: ${python}`);
    const required = {
      'cli/inference.py': path.join(repo, 'cli', 'inference.py'),
      'preprocess/pipeline.py': path.join(repo, 'preprocess', 'pipeline.py'),
      'SVS 模型': path.join(repo, 'pretrained_models', 'SoulX-Singer', 'model.pt'),
      '预处理模型目录': path.join(repo, 'pretrained_models', 'SoulX-Singer-Preprocess'),
      '音色参考': path.join(repo, this.config.get('soulx.promptWav', 'example/audio/zh_prompt.mp3')),
      '音色标注': path.join(repo, this.config.get('soulx.promptMeta', 'example/audio/zh_prompt.json'))
    };
    for (const [label, file] of Object.entries(required)) {
      if (!fs.existsSync(file)) missing.push(`${label}: ${file}`);
    }
    return { ok: missing.length === 0, missing, python, repo };
  }

  async check() {
    const state = this.checkSync();
    if (!state.ok) return { ok: false, detail: `缺少文件: ${state.missing.join('; ')}` };
    return new Promise((resolve) => {
      const child = spawn(state.python, ['-c', 'import torch;print(torch.__version__);print(torch.cuda.is_available())'], {
        cwd: state.repo,
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
        resolve({ ok: true, detail: `torch ${ver} / CUDA ${cuda === 'True' ? '可用' : '不可用'}` });
      });
    });
  }

  /** 抢占 GPU：先释放实时服务显存，再拿跨进程互斥锁 */
  async withGpu(fn) {
    if (this.realtime) {
      const released = await this.realtime.unload();
      if (released && released.ok) this.logger.info('soulx', '已释放实时服务显存');
    }
    let locked = false;
    if (this.gpuLock) {
      locked = await this.gpuLock.acquire({
        onWait: () => this.logger.info('soulx', '等待 GPU 释放（实时互动进行中）…')
      });
      if (!locked) throw new Error('等待 GPU 超时，请稍后重试');
    }
    try {
      return await fn();
    } finally {
      if (locked) this.gpuLock.release();
    }
  }

  /**
   * 制曲：产出「AI 干声 + 原伴奏」混合后的完整歌曲 wav。
   * @param {object} opts { songPath, jobId, onProgress, promptWav?, promptMeta?, pitchShift? }
   * @returns {Promise<string>} 混音后的 wav 绝对路径（位于控制台 data/audio 下）
   */
  async produce(opts) {
    return this.withGpu(() => this._produceUnlocked(opts));
  }

  async _produceUnlocked({ songPath, jobId, onProgress = () => {}, promptWav, promptMeta, pitchShift }) {
    const state = this.checkSync();
    if (!state.ok) throw new Error(`SoulX-Singer 环境不完整: ${state.missing.join('; ')}`);
    if (!songPath || !fs.existsSync(songPath)) throw new Error(`原曲不存在: ${songPath}`);
    const repo = state.repo;

    // 工作目录放在仓库内英文相对路径（cwd=repo），避免 Windows 中文路径导致
    // libsndfile/OpenCV 读取失败。所有传给 Python 的路径均为相对路径。
    const workRoot = path.join(repo, 'outputs', '_console', jobId);
    const prepDir = path.join(workRoot, 'prep');
    const svsDir = path.join(workRoot, 'svs');
    mkdirRetry(prepDir);
    mkdirRetry(svsDir);
    const relRoot = `outputs/_console/${jobId}`;

    const songExt = path.extname(songPath) || '.mp3';
    const localSong = path.join(workRoot, `song${songExt}`);
    fs.copyFileSync(songPath, localSong);

    const env = this._env();
    const tag = path.basename(songPath);

    // ---------- 阶段 1：预处理（人声/伴奏分离 + 歌词/音符转写） ----------
    onProgress(2, '人声分离与转写');
    this.logger.info('soulx', `预处理原曲 ${tag}`);
    const prepArgs = [
      '-m', 'preprocess.pipeline',
      '--audio_path', toPosix(path.join(relRoot, `song${songExt}`)),
      '--save_dir', toPosix(path.join(relRoot, 'prep')),
      '--language', this.config.get('soulx.language', 'Mandarin'),
      '--device', this.config.get('soulx.device', 'cuda'),
      '--vocal_sep', 'True',
      '--max_merge_duration', String(this.config.get('soulx.maxMergeDuration', 60000)),
      '--midi_transcribe', 'True'
    ];
    let sawAcc = false;
    let sawSegments = false;
    await this._spawn(prepArgs, { cwd: repo, env }, (line) => {
      if (!sawAcc && /acc\.wav|accompaniment/i.test(line)) {
        sawAcc = true;
        onProgress(12, '人声/伴奏已分离');
      } else if (!sawSegments && /segment|merge/i.test(line)) {
        sawSegments = true;
        onProgress(25, '歌词/音符转写');
      } else if (/error|traceback/i.test(line)) {
        this.logger.warn('soulx', line.trim().slice(0, 300));
      } else if (line.trim() && !/^\s*\d+%\|/.test(line)) {
        this.logger.info('soulx', line.trim().slice(0, 300));
      }
    });
    const metadataPath = path.join(prepDir, 'metadata.json');
    const accPath = path.join(prepDir, 'acc.wav');
    if (!fs.existsSync(metadataPath)) throw new Error('预处理未产出 metadata.json，请检查日志');
    if (!fs.existsSync(accPath)) throw new Error('预处理未产出伴奏 acc.wav，请检查日志');
    const segCount = (() => {
      try { return JSON.parse(fs.readFileSync(metadataPath, 'utf8')).length; } catch (_) { return 0; }
    })();
    if (!segCount) throw new Error('metadata.json 为空：未识别到可演唱段落');
    this.logger.info('soulx', `预处理完成，共 ${segCount} 个演唱段落`);

    // ---------- 阶段 2：SVS 推理（AI 干声） ----------
    onProgress(35, `SVS 推理（${segCount} 段）`);
    this.logger.info('soulx', '开始 SVS 歌声合成');
    const svsArgs = [
      '-m', 'cli.inference',
      '--device', this.config.get('soulx.device', 'cuda'),
      '--model_path', this.config.get('soulx.modelPath', 'pretrained_models/SoulX-Singer/model.pt'),
      '--config', this.config.get('soulx.modelConfig', 'soulxsinger/config/soulxsinger.yaml'),
      '--prompt_wav_path', promptWav || this.config.get('soulx.promptWav', 'example/audio/zh_prompt.mp3'),
      '--prompt_metadata_path', promptMeta || this.config.get('soulx.promptMeta', 'example/audio/zh_prompt.json'),
      '--target_metadata_path', toPosix(path.join(relRoot, 'prep', 'metadata.json')),
      '--phoneset_path', this.config.get('soulx.phoneset', 'soulxsinger/utils/phoneme/phone_set.json'),
      '--save_dir', toPosix(path.join(relRoot, 'svs')),
      '--auto_shift',
      '--pitch_shift', String(Number.isFinite(pitchShift) ? pitchShift : this.config.get('soulx.pitchShift', 0)),
      '--control', this.config.get('soulx.control', 'score')
    ];
    if (this.config.get('soulx.fp16', true)) svsArgs.push('--fp16');

    let lastSeg = 0;
    await this._spawn(svsArgs, { cwd: repo, env }, (line) => {
      const m = line.match(/(\d+)\s*\/\s*(\d+)\s*\[/);
      if (m && /Inferring segments/.test(line)) {
        const done = Number(m[1]);
        const total = Number(m[2]);
        if (total > 0 && done !== lastSeg) {
          lastSeg = done;
          onProgress(35 + Math.round((done / total) * 40), `SVS 推理 ${done}/${total} 段`);
        }
        return;
      }
      if (line.includes('Model checkpoint loaded')) {
        onProgress(38, '模型已加载');
      } else if (/error|traceback/i.test(line)) {
        this.logger.warn('soulx', line.trim().slice(0, 300));
      } else if (line.trim() && !/^\s*\d+%\|/.test(line) && !/it\/s|s\/it/.test(line)) {
        this.logger.info('soulx', line.trim().slice(0, 300));
      }
    });
    const generatedPath = path.join(svsDir, 'generated.wav');
    if (!fs.existsSync(generatedPath)) throw new Error('SVS 未产出 generated.wav，请检查日志');
    this.logger.info('soulx', 'SVS 干声合成完成');

    // ---------- 阶段 3：混音（AI 干声 + 原伴奏） ----------
    onProgress(80, '混合伴奏');
    const outDir = this.config.resolvePath(this.config.get('cloud.tts.outputDir', 'data/audio'));
    fs.mkdirSync(outDir, { recursive: true });
    const mixedPath = path.join(outDir, `song-${jobId.slice(0, 8)}.wav`);
    await this._mix(generatedPath, accPath, mixedPath);
    if (!fs.existsSync(mixedPath)) throw new Error('混音失败：未产出混合音频');
    this.logger.info('soulx', `混音完成: ${mixedPath}`);

    onProgress(85, '制曲完成，转口型渲染');
    try {
      fs.rmSync(workRoot, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('soulx', `临时目录清理失败: ${err.message}`);
    }
    return mixedPath;
  }

  /** 把外部文件复制到仓库内英文工作目录 */
  _stage(jobId, srcPath, name) {
    const dir = path.join(this._repo(), 'outputs', '_console', jobId);
    mkdirRetry(dir);
    const target = path.join(dir, name + (path.extname(srcPath) || ''));
    fs.copyFileSync(srcPath, target);
    return { dir, target, rel: `outputs/_console/${jobId}/${name}${path.extname(srcPath) || ''}` };
  }

  /** 预处理：midi=false 时只产出 vocal.wav + vocal_f0.npy（+ 伴奏） */
  async _preprocessStage({ jobId, audioPath, name, vocalSep, midi, onLine }) {
    const repo = this._repo();
    const staged = this._stage(jobId, audioPath, name);
    const relOut = `outputs/_console/${jobId}/${name}-prep`;
    const args = [
      '-m', 'preprocess.pipeline',
      '--audio_path', toPosix(staged.rel),
      '--save_dir', relOut,
      '--language', this.config.get('soulx.language', 'Mandarin'),
      '--device', this.config.get('soulx.device', 'cuda'),
      '--vocal_sep', vocalSep ? 'True' : 'False',
      '--max_merge_duration', String(this.config.get('soulx.maxMergeDuration', 60000)),
      '--midi_transcribe', midi ? 'True' : 'False'
    ];
    await this._spawn(args, { cwd: repo, env: this._env() }, onLine || (() => {}));
    return {
      dir: path.join(repo, relOut.replace(/\//g, path.sep)),
      staged,
      relOut
    };
  }

  /**
   * 音色样本标注：为用户上传的一小段人声生成 SoulX 需要的 metadata.json。
   * 产物写入控制台 data/voices 目录，作为 AI 歌手音色参考。
   */
  async annotateVoice(opts) {
    return this.withGpu(() => this._annotateUnlocked(opts));
  }

  async _annotateUnlocked({ audioPath, onProgress = () => {} }) {
    if (!audioPath || !fs.existsSync(audioPath)) throw new Error(`音色样本不存在: ${audioPath}`);
    const id = `voice-${Date.now().toString(36)}`;
    onProgress(10, '转写歌词与音符');
    const { dir } = await this._preprocessStage({
      jobId: id,
      audioPath,
      name: 'voice',
      vocalSep: false,
      midi: true,
      onLine: (line) => {
        if (/error|traceback/i.test(line)) this.logger.warn('soulx', line.trim().slice(0, 300));
      }
    });
    const metaFile = path.join(dir, 'metadata.json');
    if (!fs.existsSync(metaFile)) throw new Error('标注失败：未生成 metadata.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (!meta.length) throw new Error('标注失败：样本中没有识别到可演唱段落，请换一段清晰人声');
    onProgress(80, `识别到 ${meta.length} 个段落`);

    const voiceDir = this.config.resolvePath(this.config.get('soulx.voiceDir', 'data/voices'));
    fs.mkdirSync(voiceDir, { recursive: true });
    const base = path.basename(audioPath, path.extname(audioPath));
    const ext = path.extname(audioPath) || '.wav';
    const savedAudio = path.join(voiceDir, `${base}${ext}`);
    const savedMeta = path.join(voiceDir, `${base}.json`);
    fs.copyFileSync(audioPath, savedAudio);
    fs.copyFileSync(metaFile, savedMeta);
    try { fs.rmSync(path.join(this._repo(), 'outputs', '_console', id), { recursive: true, force: true }); } catch (_) { /* ignore */ }
    onProgress(100, '音色样本已入库');
    return { name: base, audioPath: savedAudio, metaPath: savedMeta, segments: meta.length };
  }

  /**
   * 零样本音色克隆（SVC）：把源歌声转换成目标音色。
   * 这是 SoulX 官方支持的「音色迁移」路径，无需训练。
   */
  /**
   * 说话音色转换：把 edge-tts 干声 → 同歌手音色的干声。
   * 与 cloneVoice 的区别：
   *  - 源音频已是干声，跳过 vocalSep
   *  - 不混伴奏（说话场景无伴奏）
   *  - prompt f0 缓存（音色不变时只做一次 preprocess）
   * 延迟目标：缓存命中时 ≤ 5s / 次；首次（冷启动）≤ 10s
   */
  async convertSpeak({ sourceWav, promptWav, promptMeta, pitchShift, onProgress = () => {} }) {
    return this.withGpu(() => this._convertSpeakUnlocked({ sourceWav, promptWav, promptMeta, pitchShift, onProgress }));
  }

  async _convertSpeakUnlocked({ sourceWav, promptWav, promptMeta, pitchShift, onProgress = () => {} }) {
    if (!sourceWav || !fs.existsSync(sourceWav)) throw new Error(`源干声不存在: ${sourceWav}`);
    const repo = this._repo();
    const id = `spk-${Date.now().toString(36)}`;
    const workDir = path.join(repo, 'outputs', '_console', id);
    mkdirRetry(workDir);
    const env = this._env();

    const promptAudio = this.config.resolvePath(promptWav || this.config.get('soulx.promptWav', 'example/audio/zh_prompt.mp3'));
    const promptMetaPath = this.config.resolvePath(promptMeta || this.config.get('soulx.promptMeta', 'example/audio/zh_prompt.json'));
    if (!fs.existsSync(promptAudio)) throw new Error(`歌手音色参考不存在: ${promptAudio}`);
    if (!fs.existsSync(promptMetaPath)) throw new Error(`歌手音色标注不存在: ${promptMetaPath}`);

    // 1) prompt f0（缓存：按音色文件 mtime 判断）
    const cacheFile = `${promptAudio}.prompt-cache.json`;
    let promptVocal, promptF0;
    onProgress(10, '检查音色缓存');
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const stat = fs.statSync(promptAudio);
        if (cache.mtimeMs === stat.mtimeMs && fs.existsSync(cache.promptVocal) && fs.existsSync(cache.promptF0)) {
          promptVocal = cache.promptVocal;
          promptF0 = cache.promptF0;
          onProgress(20, '命中音色缓存');
        }
      } catch (_) { /* cache 损坏 → 重算 */ }
    }
    if (!promptVocal) {
      onProgress(15, '提取音色特征');
      const ps = await this._preprocessStage({
        jobId: id, audioPath: promptAudio, name: 'prompt', vocalSep: false, midi: false
      });
      promptVocal = path.join(ps.dir, 'vocal.wav');
      promptF0 = path.join(ps.dir, 'vocal_f0.npy');
      if (!fs.existsSync(promptF0)) throw new Error('音色参考 f0 提取失败');
      // 写缓存
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({
          mtimeMs: fs.statSync(promptAudio).mtimeMs,
          promptVocal, promptF0
        }));
      } catch (_) { /* ignore */ }
      onProgress(25, '音色缓存已更新');
    }

    // 2) 源干声 f0（edge-tts 已是干声 → vocalSep=false）
    onProgress(35, '提取源音频 f0');
    const ts = await this._preprocessStage({
      jobId: id, audioPath: sourceWav, name: 'target', vocalSep: false, midi: false
    });
    const targetVocal = path.join(ts.dir, 'vocal.wav');
    const targetF0 = path.join(ts.dir, 'vocal_f0.npy');
    if (!fs.existsSync(targetF0)) throw new Error('源音频 f0 提取失败');

    // 3) SVC 推理
    onProgress(60, '音色转换中');
    const outDir = path.join(workDir, 'svc');
    fs.mkdirSync(outDir, { recursive: true });
    const rel = (abs) => toPosix(path.relative(repo, abs));
    const args = [
      '-m', 'cli.inference_svc',
      '--device', this.config.get('soulx.device', 'cuda'),
      '--model_path', this.config.get('soulx.svcModelPath', 'pretrained_models/SoulX-Singer/model-svc.pt'),
      '--config', this.config.get('soulx.modelConfig', 'soulxsinger/config/soulxsinger.yaml'),
      '--prompt_wav_path', rel(promptVocal),
      '--prompt_f0_path', rel(promptF0),
      '--target_wav_path', rel(targetVocal),
      '--target_f0_path', rel(targetF0),
      '--save_dir', rel(outDir),
      '--auto_shift',
      '--pitch_shift', String(Number.isFinite(pitchShift) ? pitchShift : 0)
    ];
    if (this.config.get('soulx.fp16', true)) args.push('--fp16');
    await this._spawn(args, { cwd: repo, env }, (line) => {
      if (/error|traceback/i.test(line)) this.logger.warn('soulx', line.trim().slice(0, 300));
      else if (line.trim() && !/^\s*\d+%\|/.test(line)) this.logger.info('soulx', line.trim().slice(0, 300));
    });
    const generated = path.join(outDir, 'generated.wav');
    if (!fs.existsSync(generated)) throw new Error('音色转换未产出 generated.wav');

    // 4) 直接输出（说话无伴奏）
    onProgress(95, '写出歌手音色干声');
    const finalDir = this.config.resolvePath(this.config.get('cloud.tts.outputDir', 'data/audio'));
    fs.mkdirSync(finalDir, { recursive: true });
    const finalPath = path.join(finalDir, `speak-svc-${id}.wav`);
    fs.copyFileSync(generated, finalPath);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    onProgress(100, '说话音色转换完成');
    return { output: finalPath, promptUsed: path.basename(promptAudio), promptCached: fs.existsSync(cacheFile) };
  }

  async cloneVoice(opts) {
    return this.withGpu(() => this._cloneUnlocked(opts));
  }

  async _cloneUnlocked({ sourceSongPath, promptWav, promptMeta, pitchShift, onProgress = () => {} }) {
    if (!sourceSongPath || !fs.existsSync(sourceSongPath)) throw new Error(`源歌声不存在: ${sourceSongPath}`);
    const repo = this._repo();
    const id = `svc-${Date.now().toString(36)}`;
    const workDir = path.join(repo, 'outputs', '_console', id);
    mkdirRetry(workDir);
    const env = this._env();

    const promptAudio = this.config.resolvePath(promptWav || this.config.get('soulx.promptWav', 'example/audio/zh_prompt.mp3'));
    const promptMetaPath = this.config.resolvePath(promptMeta || this.config.get('soulx.promptMeta', 'example/audio/zh_prompt.json'));
    if (!fs.existsSync(promptAudio)) throw new Error(`音色参考不存在: ${promptAudio}`);
    if (!fs.existsSync(promptMetaPath)) throw new Error(`音色标注不存在: ${promptMetaPath}`);

    // 1) 音色参考的 f0
    onProgress(5, '提取音色特征');
    const promptStage = await this._preprocessStage({
      jobId: id, audioPath: promptAudio, name: 'prompt', vocalSep: false, midi: false
    });
    const promptVocal = path.join(promptStage.dir, 'vocal.wav');
    const promptF0 = path.join(promptStage.dir, 'vocal_f0.npy');
    if (!fs.existsSync(promptF0)) throw new Error('音色参考 f0 提取失败');

    // 2) 源歌声分离 + f0
    onProgress(25, '分离源歌声');
    const targetStage = await this._preprocessStage({
      jobId: id, audioPath: sourceSongPath, name: 'target', vocalSep: true, midi: false
    });
    const targetVocal = path.join(targetStage.dir, 'vocal.wav');
    const targetF0 = path.join(targetStage.dir, 'vocal_f0.npy');
    const accPath = path.join(targetStage.dir, 'acc.wav');
    if (!fs.existsSync(targetF0)) throw new Error('源歌声 f0 提取失败');

    // 3) SVC 推理
    onProgress(45, '音色转换');
    const outDir = path.join(workDir, 'svc');
    fs.mkdirSync(outDir, { recursive: true });
    const rel = (abs) => toPosix(path.relative(repo, abs));
    const args = [
      '-m', 'cli.inference_svc',
      '--device', this.config.get('soulx.device', 'cuda'),
      '--model_path', this.config.get('soulx.svcModelPath', 'pretrained_models/SoulX-Singer/model-svc.pt'),
      '--config', this.config.get('soulx.modelConfig', 'soulxsinger/config/soulxsinger.yaml'),
      '--prompt_wav_path', rel(promptVocal),
      '--prompt_f0_path', rel(promptF0),
      '--target_wav_path', rel(targetVocal),
      '--target_f0_path', rel(targetF0),
      '--save_dir', rel(outDir),
      '--auto_shift',
      '--pitch_shift', String(Number.isFinite(pitchShift) ? pitchShift : 0)
    ];
    if (this.config.get('soulx.fp16', true)) args.push('--fp16');
    await this._spawn(args, { cwd: repo, env }, (line) => {
      if (/error|traceback/i.test(line)) this.logger.warn('soulx', line.trim().slice(0, 300));
      else if (line.trim() && !/^\s*\d+%\|/.test(line)) this.logger.info('soulx', line.trim().slice(0, 300));
    });
    const generated = path.join(outDir, 'generated.wav');
    if (!fs.existsSync(generated)) throw new Error('音色转换未产出 generated.wav');

    // 4) 混回伴奏
    onProgress(85, '混回伴奏');
    const finalDir = this.config.resolvePath(this.config.get('cloud.tts.outputDir', 'data/audio'));
    fs.mkdirSync(finalDir, { recursive: true });
    const finalPath = path.join(finalDir, `clone-${id}.wav`);
    if (fs.existsSync(accPath)) await this._mix(generated, accPath, finalPath);
    else fs.copyFileSync(generated, finalPath);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    onProgress(100, '音色克隆完成');
    return { output: finalPath, promptUsed: path.basename(promptAudio) };
  }

  _env() {
    const tmpDir = path.join(this.config.appDir, 'data', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: this._repo(),
      TEMP: tmpDir,
      TMP: tmpDir
    };
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    const envPaths = this.config.get('soulx.envPaths', []) || [];
    env.PATH = [...envPaths, env.PATH || ''].join(path.delimiter);
    return env;
  }

  _ffmpeg() {
    const dir = this.config.resolvePath(this.config.get('muse.ffmpegPath', 'tools/ffmpeg'));
    const exe = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!fs.existsSync(exe)) throw new Error(`ffmpeg 不存在: ${exe}`);
    return exe;
  }

  /** 干声 + 伴奏 → 混合 wav（保留尾奏，限幅防削波） */
  _mix(vocalPath, accPath, outPath) {
    const args = [
      '-y',
      '-i', vocalPath,
      '-i', accPath,
      '-filter_complex',
      '[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];' +
      '[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[out]',
      '-map', '[out]',
      '-ar', '44100',
      '-c:a', 'pcm_s16le',
      outPath
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this._ffmpeg(), args, { windowsHide: true });
      let tail = '';
      child.stderr.on('data', (b) => { tail = (tail + b.toString('utf8')).slice(-3000); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg 混音失败(${code}): ${tail.split('\n').slice(-3).join(' ')}`));
        resolve();
      });
    });
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
      let tail = '';
      child.stdout.on('data', (b) => { const s = b.toString('utf8'); tail = (tail + s).slice(-4000); feed(s); });
      child.stderr.on('data', (b) => { const s = b.toString('utf8'); tail = (tail + s).slice(-4000); feed(s); });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        this.child = null;
        if (code !== 0) {
          return reject(new Error(`SoulX 子进程退出码 ${code}: ${tail.trim().split('\n').slice(-3).join(' ')}`));
        }
        resolve();
      });
    });
  }
}

module.exports = { SoulXAdapter };
