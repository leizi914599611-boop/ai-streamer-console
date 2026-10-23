'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * 直播画面预览：独立 ffmpeg 把当前视频源循环推成 MJPEG 流，
 * 浏览器端用 <img src="http://127.0.0.1:PORT/stream"> 直接渲染。
 * - 多客户端共享同一个 ffmpeg 进程（PassThrough 广播）
 * - 无人观看 15s 后自动停 ffmpeg，节省 CPU/GPU
 * - HTTP server 独立于 Electron，不依赖 BrowserWindow
 */
class StreamPreview extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.server = null;
    this.port = 0;
    this.child = null;
    this.source = null;
    this.fps = 30;
    this.width = 1280;
    this.height = 720;
    this.clients = new Set();
    this.buffer = Buffer.alloc(0);
    this.idleTimer = null;
    this.startedAt = null;
    this.lastError = null;
    this.fsClosed = false;
  }

  snapshot() {
    return {
      running: Boolean(this.server),
      ffmpegAlive: Boolean(this.child),
      port: this.port,
      url: this.port ? `http://127.0.0.1:${this.port}/stream` : '',
      source: this.source,
      fps: this.fps,
      width: this.width,
      height: this.height,
      clients: this.clients.size,
      startedAt: this.startedAt,
      lastError: this.lastError || ''
    };
  }

  async start({ source, fps, width, height } = {}) {
    // 并发锁：HTTP server listen 回调前快速连点会重入
    if (this._startingPromise) return this._startingPromise;

    // 已在跑且参数一致 → 只返回快照
    if (this.server && this.child) {
      const sameSource = source === undefined || source === this.source;
      if (sameSource && (fps === undefined || fps === this.fps) &&
          (width === undefined || width === this.width) &&
          (height === undefined || height === this.height)) {
        return this.snapshot();
      }
      // 源/尺寸变了 → 热切换 ffmpeg（server 端口不动）
      if (sameSource && source !== undefined) this.source = source;
      if (fps) this.fps = fps;
      if (width) this.width = width;
      if (height) this.height = height;
      this._spawnFfmpeg();
      return this.snapshot();
    }

    const cfg = this.config;
    const ffmpegPath = cfg.get('stream.ffmpegPath', '');
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      this.lastError = `ffmpeg 不存在: ${ffmpegPath || '(未配置)'}`;
      this.logger.error('preview', this.lastError);
      return this.snapshot();
    }

    this.source = source !== undefined ? source : cfg.get('stream.videoSource', '');
    this.fps = fps || cfg.get('stream.fps', 30);
    this.width = width || cfg.get('stream.width', 1280);
    this.height = height || cfg.get('stream.height', 720);
    this.lastError = null;
    this.fsClosed = false;

    this.server = http.createServer((req, res) => this._onRequest(req, res));
    this._startingPromise = (async () => {
      await new Promise((resolve, reject) => {
        const onErr = (err) => { this.server.removeListener('listening', onListening); reject(err); };
        const onListening = () => { this.server.removeListener('error', onErr); resolve(); };
        this.server.once('error', onErr);
        this.server.once('listening', onListening);
        this.server.listen(0, '127.0.0.1');
      });
      this.port = this.server.address().port;
      this.logger.info('preview', `预览 HTTP server http://127.0.0.1:${this.port} ${this.source ? path.basename(this.source) : 'testsrc'}`);
    })().catch((err) => { this._startingPromise = null; throw err; });
    await this._startingPromise;
    this._startingPromise = null;

    this._spawnFfmpeg();
    this.startedAt = Date.now();
    this.emit('preview', this.snapshot());
    return this.snapshot();
  }

  setSource(source) {
    if (!this.server) { this.source = source; return this.snapshot(); }
    this.source = source;
    this._spawnFfmpeg();
    return this.snapshot();
  }

  stop() {
    this._killChild();
    this._closeAll();
    if (this.server) {
      try { this.server.close(); } catch (_) { /* ignore */ }
      this.server = null;
    }
    this.port = 0;
    this.startedAt = null;
    this.logger.info('preview', '预览已停止');
    this.emit('preview', this.snapshot());
  }

  dispose() { this.stop(); }

  /* --------- 内部 --------- */

  _onRequest(req, res) {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.snapshot()));
      return;
    }
    if (req.url !== '/stream') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 0\r\n\r\n');

    this.clients.add(res);
    clearTimeout(this.idleTimer);

    const onClose = () => {
      this.clients.delete(res);
      res.removeListener('close', onClose);
      res.removeListener('error', onClose);
      res.destroyed = true;
      if (this.clients.size === 0 && this.child) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          if (this.clients.size === 0) this._killChild();
        }, 15000);
      }
      this.emit('preview', this.snapshot());
    };
    res.on('close', onClose);
    res.on('error', onClose);

    this.emit('preview', this.snapshot());
  }

  _closeAll() {
    for (const res of this.clients) {
      try { res.end(); res.destroy(); } catch (_) { /* ignore */ }
    }
    this.clients.clear();
    clearTimeout(this.idleTimer);
  }

  _killChild() {
    if (!this.child) return;
    const pid = this.child.pid;
    try { this.child.kill('SIGINT'); } catch (_) { /* ignore */ }
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
    this.child = null;
  }

  _spawnFfmpeg() {
    this._killChild();
    this.buffer = Buffer.alloc(0);
    clearTimeout(this.idleTimer);

    const cfg = this.config;
    const ffmpegPath = cfg.get('stream.ffmpegPath', '');
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      this.lastError = `ffmpeg 不存在: ${ffmpegPath || '(未配置)'}`;
      this.logger.error('preview', this.lastError);
      return;
    }

    const args = ['-hide_banner', '-loglevel', 'warning', '-re'];
    if (this.source && fs.existsSync(this.source)) {
      args.push('-stream_loop', '-1', '-i', this.source);
    } else {
      args.push('-f', 'lavfi', '-i', `testsrc=size=${this.width}x${this.height}:rate=${this.fps}`);
    }
      args.push(
      '-an',                     // 预览只要画面
      '-f', 'mjpeg',
      '-update', '1',            // MJPEG 单帧更新，浏览器重连友好
      '-q:v', '5',
      '-r', String(this.fps),
      '-s', `${this.width}x${this.height}`,
      '-pix_fmt', 'yuvj420p',    // 消 swscaler deprecated 警告，兼容 Chromium MJPEG
      '-'
    );

    this.logger.info('preview', `ffmpeg 起 MJPEG → ${this.source ? path.basename(this.source) : 'testsrc'}`);
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    this.child = child;

    let rest = '';
    child.stderr.on('data', (buf) => {
      rest += buf.toString('utf8');
      const lines = rest.split(/\r|\n/);
      rest = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.logger.warn('preview', trimmed);
      }
    });

    child.stdout.on('data', (buf) => this._onStdout(buf));

    child.on('error', (err) => {
      this.lastError = `ffmpeg 启动失败: ${err.message}`;
      this.logger.error('preview', this.lastError);
      this.child = null;
      this._closeAll();
      this.emit('preview', this.snapshot());
    });

    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (code !== 0 && !this.fsClosed) {
        this.logger.warn('preview', `ffmpeg 退出 code=${code}`);
      }
      this.emit('preview', this.snapshot());
    });

    this.emit('preview', this.snapshot());
  }

  /** ffmpeg stdout: 原始 MJPEG frame 流，拆出完整 JPEG 帧再加 multipart boundary 广播 */
  _onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const soi = this.buffer.indexOf(Buffer.from([0xff, 0xd8])); // JPEG SOI
      if (soi < 0) {
        if (this.buffer.length > 4096) this.buffer = Buffer.alloc(0);
        return;
      }
      if (soi > 0) this.buffer = this.buffer.slice(soi);
      const eoi = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), 2); // JPEG EOI
      if (eoi < 0) return;
      const frameEnd = eoi + 2;
      const frame = this.buffer.slice(0, frameEnd);
      this.buffer = this.buffer.slice(frameEnd);
      this._broadcastFrame(frame);
    }
  }

  _broadcastFrame(frame) {
    const header = Buffer.concat([
      Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: '),
      Buffer.from(String(frame.length)),
      Buffer.from('\r\n\r\n')
    ]);
    const data = Buffer.concat([header, frame, Buffer.from('\r\n')]);
    for (const res of this.clients) {
      try {
        if (!res.destroyed) res.write(data);
      } catch (_) { /* client disconnected */ }
    }
  }
}

module.exports = { StreamPreview };
