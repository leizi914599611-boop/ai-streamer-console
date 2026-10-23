'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * 推流控制：把画面 + 音轨用 ffmpeg 推到 RTMP。
 * 无视频源时使用测试画面（testsrc + 静音），便于先验证推流链路。
 */
class StreamController extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.child = null;
    this.status = 'offline';
    this.stats = { fps: 0, bitrate: '', time: '', frames: 0, speed: '' };
    this.startedAt = null;
    this.lastError = null;
  }

  snapshot() {
    return {
      status: this.status,
      stats: this.stats,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      lastError: this.lastError,
      rtmpUrl: this.config.get('stream.rtmpUrl', ''),
      videoSource: this.config.get('stream.videoSource', ''),
      ffmpegPath: this.config.get('stream.ffmpegPath', ''),
      ffmpegExists: Boolean(this.config.get('stream.ffmpegPath')) && fs.existsSync(this.config.get('stream.ffmpegPath'))
    };
  }

  _update(status, patch = {}) {
    this.status = status;
    Object.assign(this, patch);
    const snap = this.snapshot();
    this.emit('stream', snap);
    return snap;
  }

  _buildArgs(rtmpUrl, videoSource) {
    const fps = this.config.get('stream.fps', 30);
    const width = this.config.get('stream.width', 1280);
    const height = this.config.get('stream.height', 720);
    const bitrate = this.config.get('stream.bitrate', '3500k');
    const preset = this.config.get('stream.preset', 'veryfast');

    const input = [];
    const maps = [];
    if (videoSource && fs.existsSync(videoSource)) {
      // 循环播放视频源，并复用其自带音轨（互动轨的人声、曲目轨的伴奏）
      input.push('-re', '-stream_loop', '-1', '-i', videoSource);
      maps.push('-map', '0:v:0', '-map', '0:a:0?');
    } else {
      input.push('-re', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}`);
      input.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
      maps.push('-map', '0:v:0', '-map', '1:a:0');
    }

    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-stats_period', '1',
      ...input,
      ...maps,
      '-c:v', 'libx264',
      '-preset', preset,
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-shortest',
      '-f', 'flv',
      rtmpUrl
    ];
  }

  start({ rtmpUrl, videoSource } = {}) {
    if (this.child) return this.snapshot();
    const url = rtmpUrl || this.config.get('stream.rtmpUrl', '');
    const src = videoSource !== undefined ? videoSource : this.config.get('stream.videoSource', '');
    const ffmpegPath = this.config.get('stream.ffmpegPath', '');

    if (!url) {
      this.lastError = '请先填写 RTMP 推流地址';
      this.logger.error('stream', this.lastError);
      return this._update('error');
    }
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      this.lastError = `ffmpeg 不存在: ${ffmpegPath || '(未配置)'}`;
      this.logger.error('stream', this.lastError);
      return this._update('error');
    }

    const args = this._buildArgs(url, src);
    this.logger.info('stream', `推流启动 → ${url}${src ? '' : '（测试画面）'}`);
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    this.child = child;
    this.startedAt = Date.now();
    this.lastError = null;
    this._update('starting');

    const handleLine = (line) => {
      if (!line.trim()) return;
      const fps = /fps=\s*([\d.]+)/.exec(line);
      const bitrate = /bitrate=\s*([\d.]+\w+)/.exec(line);
      const time = /time=\s*([\d:.]+)/.exec(line);
      const frames = /frame=\s*(\d+)/.exec(line);
      const speed = /speed=\s*([\d.]+x)/.exec(line);
      if (fps || bitrate || time || frames || speed) {
        this.stats = {
          fps: fps ? Number(fps[1]) : this.stats.fps,
          bitrate: bitrate ? bitrate[1] : this.stats.bitrate,
          time: time ? time[1] : this.stats.time,
          frames: frames ? Number(frames[1]) : this.stats.frames,
          speed: speed ? speed[1] : this.stats.speed
        };
        this.emit('stream', this.snapshot());
      } else {
        this.logger.warn('stream', line);
      }
    };

    let rest = '';
    child.stderr.on('data', (buf) => {
      rest += buf.toString('utf8');
      const lines = rest.split(/\r|\n/);
      rest = lines.pop();
      lines.forEach(handleLine);
    });

    setTimeout(() => {
      if (this.child === child && this.status === 'starting') {
        this._update('live');
        this.logger.success('stream', '推流已建立');
      }
    }, 2500);

    child.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error('stream', `ffmpeg 启动失败: ${err.message}`);
      this.child = null;
      this.startedAt = null;
      this._update('error');
    });

    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.startedAt = null;
      if (this.status === 'stopping' || code === 0) {
        this.logger.info('stream', `推流结束（code=${code}）`);
        this._update('offline');
      } else {
        this.lastError = `ffmpeg 退出（code=${code}）`;
        this.logger.error('stream', this.lastError);
        this._update('error');
      }
    });

    return this.snapshot();
  }

  /** 直播中切换画面源（用于互动轨：播放最新一轮口型视频）。 */
  async switchSource(videoSource) {
    const url = this.config.get('stream.rtmpUrl', '');
    const live = this.status === 'live' || this.status === 'starting';
    if (!live || !this.child || !url || !videoSource) return this.snapshot();
    if (this.switching) {
      this.logger.warn('stream', '上一次画面切换尚未完成，跳过本次切换');
      return this.snapshot();
    }
    this.switching = true;
    const child = this.child;
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      this.logger.info('stream', `切换画面源 → ${path.basename(videoSource)}`);
      this.stop();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 4000))]);
      return this.start({ rtmpUrl: url, videoSource });
    } finally {
      this.switching = false;
    }
  }

  stop() {
    if (!this.child) return this.snapshot();
    this._update('stopping');
    this.logger.info('stream', '停止推流');
    const pid = this.child.pid;
    this.child.kill('SIGINT');
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return this.snapshot();
  }
}

module.exports = { StreamController };
