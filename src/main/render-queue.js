'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled'
};

/**
 * 渲染队列：串行执行任务，持久化到 data/queue.json。
 * 真实执行器调用 MuseTalk 离线推理（queue.simulate=true 时退回进度模拟）。
 */
class RenderQueue extends EventEmitter {
  constructor({ config, logger, orchestrator, muse, tts, soulx }) {
    super();
    this.config = config;
    this.logger = logger;
    this.orchestrator = orchestrator;
    this.muse = muse;
    this.tts = tts;
    this.soulx = soulx || null;
    this.stateFile = path.join(config.appDir, 'data', 'queue.json');
    this.jobs = this._load();
    this.running = 0;
    this.titleSeq = 0;
  }

  _load() {
    try {
      if (!fs.existsSync(this.stateFile)) return [];
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      // 上次异常退出时处于 running 的任务标记为失败
      return raw.map((job) =>
        job.status === JOB_STATUS.RUNNING
          ? { ...job, status: JOB_STATUS.FAILED, error: '应用重启中断' }
          : job
      );
    } catch (err) {
      this.logger.warn('queue', `队列状态读取失败: ${err.message}`);
      return [];
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.jobs, null, 2), 'utf8');
    } catch (err) {
      this.logger.error('queue', `队列状态写入失败: ${err.message}`);
    }
  }

  list() {
    return this.jobs.slice().reverse();
  }

  add({ type, title, payload = {} }) {
    const job = {
      id: randomUUID(),
      type: type || 'lip-sync',
      title: title || `未命名任务 ${++this.titleSeq}`,
      payload,
      status: JOB_STATUS.QUEUED,
      progress: 0,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      output: null
    };
    this.jobs.push(job);
    this.logger.info('queue', `任务入队: ${job.title}（${job.type}）`);
    this._persist();
    this.emit('job', job);
    this.pump();
    return this.snapshot(job);
  }

  snapshot(job) {
    const list = this.jobs;
    const index = list.findIndex((j) => j.id === job.id);
    return {
      ...job,
      position: index >= 0 ? list.filter((j) => j.status === JOB_STATUS.QUEUED).findIndex((j) => j.id === job.id) + 1 : 0
    };
  }

  retry(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error('任务不存在');
    if (job.status === JOB_STATUS.RUNNING) throw new Error('任务正在执行');
    job.status = JOB_STATUS.QUEUED;
    job.progress = 0;
    job.error = null;
    job.startedAt = null;
    job.finishedAt = null;
    this._persist();
    this.emit('job', job);
    this.pump();
    return this.snapshot(job);
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error('任务不存在');
    if (job.status !== JOB_STATUS.QUEUED) throw new Error('仅排队中的任务可取消');
    job.status = JOB_STATUS.CANCELED;
    this._persist();
    this.emit('job', job);
    return this.snapshot(job);
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === JOB_STATUS.QUEUED || j.status === JOB_STATUS.RUNNING);
    this._persist();
    this.emit('job', null);
    return this.list();
  }

  pump() {
    const max = Number(this.config.get('queue.maxConcurrent', 1)) || 1;
    while (this.running < max) {
      const next = this.jobs.find((j) => j.status === JOB_STATUS.QUEUED);
      if (!next) break;
      this._run(next);
    }
  }

  async _run(job) {
    this.running += 1;
    job.status = JOB_STATUS.RUNNING;
    job.startedAt = Date.now();
    job.progress = 0;
    this._persist();
    this.emit('job', job);
    this.logger.info('queue', `开始执行: ${job.title}`);

    try {
      const output = await this._execute(job, (progress, note) => {
        job.progress = Math.max(job.progress, Math.min(100, Math.round(progress)));
        if (note) job.note = note;
        this.emit('job', job);
      });
      job.status = JOB_STATUS.DONE;
      job.progress = 100;
      job.finishedAt = Date.now();
      job.output = output || null;
      this.logger.success('queue', `任务完成: ${job.title}`);
      if (this.orchestrator) this.orchestrator.reportRenderResult(true);
    } catch (err) {
      job.status = JOB_STATUS.FAILED;
      job.error = err.message;
      job.finishedAt = Date.now();
      this.logger.error('queue', `任务失败: ${job.title} -> ${err.message}`);
      if (this.orchestrator) this.orchestrator.reportRenderResult(false, job);
    } finally {
      this.running -= 1;
      this._persist();
      this.emit('job', job);
      setImmediate(() => this.pump());
    }
  }

  /** 渲染执行器：调用 MuseTalk 真实推理；queue.simulate=true 时退回模拟进度。 */
  async _execute(job, onProgress) {
    if (!this.config.get('queue.simulate', false)) {
      return this._executeReal(job, onProgress);
    }
    return this._executeSimulated(job, onProgress);
  }

  async _executeReal(job, onProgress) {
    const payload = job.payload || {};
    let audioPath = payload.audioPath || payload.audio || '';
    let renderProgress = onProgress;

    // 音色标注：只产出 metadata.json，不需要口型渲染
    if (job.type === 'annotate') {
      if (!this.soulx) throw new Error('SoulX-Singer 适配器未初始化');
      if (!audioPath) throw new Error('音色标注缺少音频文件');
      const result = await this.soulx.annotateVoice({
        audioPath: this.config.resolvePath(audioPath),
        onProgress
      });
      return result.metaPath;
    }

    // 零样本音色克隆：产出音频，不需要口型渲染
    if (job.type === 'clone') {
      if (!this.soulx) throw new Error('SoulX-Singer 适配器未初始化');
      if (!audioPath) throw new Error('音色克隆缺少源歌声文件');
      const result = await this.soulx.cloneVoice({
        sourceSongPath: this.config.resolvePath(audioPath),
        promptWav: payload.promptWav,
        promptMeta: payload.promptMeta,
        pitchShift: payload.pitchShift,
        onProgress
      });
      return result.output;
    }

    if (!this.muse) throw new Error('MuseTalk 适配器未初始化');
    if (job.type === 'tts') {
      if (!payload.text || !payload.text.trim()) throw new Error('TTS 任务缺少文本');
      onProgress(2, '语音合成');
      const ttsResult = await this.tts.synthesize({ text: payload.text, voice: payload.voice });
      audioPath = ttsResult.file;
    } else if (job.type === 'song') {
      if (!this.soulx) throw new Error('SoulX-Singer 适配器未初始化');
      if (!audioPath) throw new Error('制曲任务缺少原曲文件（payload.audioPath）');
      audioPath = await this.soulx.produce({
        songPath: this.config.resolvePath(audioPath),
        jobId: job.id,
        promptWav: payload.promptWav,
        promptMeta: payload.promptMeta,
        pitchShift: payload.pitchShift,
        onProgress
      });
      // 制曲占 0-85%，口型渲染映射到 85-100%
      renderProgress = (p, note) => onProgress(85 + Math.round((p / 100) * 15), note);
    }
    const videoPath = payload.videoPath || payload.video || this.config.resolvePath(this.config.get('muse.avatar', ''));
    if (!audioPath) throw new Error('任务缺少音频文件（payload.audioPath）');
    return this.muse.render({
      videoPath: this.config.resolvePath(videoPath),
      audioPath: audioPath,
      jobId: job.id,
      onProgress: renderProgress
    });
  }

  _executeSimulated(job, onProgress) {
    if (!this.config.get('queue.simulate', false)) {
      return Promise.reject(new Error('模拟渲染已关闭（queue.simulate=false）'));
    }
    const totalMs = 6000 + Math.round(Math.random() * 3000);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const ratio = (Date.now() - start) / totalMs;
        onProgress(ratio * 100, '模拟渲染中');
        if (ratio >= 1) {
          clearInterval(timer);
          const outDir = this.config.resolvePath(this.config.get('queue.outputDir', 'data/renders'));
          fs.mkdirSync(outDir, { recursive: true });
          const file = path.join(outDir, `${job.type}-${job.id.slice(0, 8)}.mp4`);
          fs.writeFileSync(file, '');
          resolve(file);
        }
      }, 400);
      if (job.status === JOB_STATUS.CANCELED) {
        clearInterval(timer);
        reject(new Error('任务被取消'));
      }
    });
  }
}

module.exports = { RenderQueue, JOB_STATUS };
