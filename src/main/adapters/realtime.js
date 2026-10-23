'use strict';

const http = require('http');

/**
 * MuseTalk 实时互动服务客户端（tools/MuseTalk/scripts/realtime_service.py）。
 * 服务常驻持有模型与 Avatar 缓存，负责：文本/音频 -> 口型视频、语音识别。
 */
class RealtimeAdapter {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  baseUrl() {
    return `http://127.0.0.1:${Number(this.config.get('realtime.port', 7863))}`;
  }

  _request(method, urlPath, { body, timeoutMs = 30000 } = {}) {
    const url = new URL(this.baseUrl() + urlPath);
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request(
        {
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': payload.length } : {})
          },
          timeout: timeoutMs
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch (_) { /* ignore */ }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const detail = parsed?.detail || parsed?.error || raw.slice(0, 300) || `HTTP ${res.statusCode}`;
              const err = new Error(detail);
              err.status = res.statusCode;
              return reject(err);
            }
            resolve(parsed);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`实时服务请求超时（${timeoutMs}ms）`)));
      req.on('error', (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async health() {
    try {
      const data = await this._request('GET', '/health', { timeoutMs: 4000 });
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  async prepareAvatar({ avatarId, videoPath } = {}) {
    return this._request('POST', '/avatar/prepare', {
      body: {
        avatarId: avatarId || this.config.get('realtime.avatarId', 'yongen'),
        videoPath: videoPath || this.config.get('muse.avatar', 'data/video/yongen.mp4')
      },
      timeoutMs: 30 * 60 * 1000
    });
  }

  async talk({ text, voice, rate } = {}) {
    if (!text || !text.trim()) throw new Error('待播报文本为空');
    const started = Date.now();
    const data = await this._request('POST', '/talk', {
      body: {
        avatarId: this.config.get('realtime.avatarId', 'yongen'),
        videoPath: this.config.get('muse.avatar', 'data/video/yongen.mp4'),
        text: text.trim(),
        voice: voice || this.config.get('cloud.tts.voice', 'zh-CN-XiaoxiaoNeural'),
        rate: rate || this.config.get('cloud.tts.rate', '+0%')
      },
      timeoutMs: Number(this.config.get('realtime.timeoutMs', 600000))
    });
    this.logger.success(
      'realtime',
      `口型回合完成 ${data.totalMs || Date.now() - started}ms（TTS ${data.ttsMs || '-'}ms）`
    );
    return data;
  }

  /** 仅合成干声 wav（不走 MuseTalk 推理），供后续 SVC 音色转换。 */
  async synthesizeText({ text, voice, rate } = {}) {
    if (!text || !text.trim()) throw new Error('待播报文本为空');
    const started = Date.now();
    const data = await this._request('POST', '/synthesize', {
      body: {
        text: text.trim(),
        voice: voice || this.config.get('cloud.tts.voice', 'zh-CN-XiaoxiaoNeural'),
        rate: rate || this.config.get('cloud.tts.rate', '+0%')
      },
      timeoutMs: Number(this.config.get('cloud.tts.timeoutMs', 30000))
    });
    this.logger.info('realtime', `edge-tts 合成完成 ${Date.now() - started}ms → ${data.wavPath || '(无)'}`);
    return data; // { wavPath, mp3Path, ttsMs }
  }

  /** 已有音频 → MuseTalk 口型推理（用于 SVC 转换后的歌手音色音频）。 */
  async inferWithAudio({ audioPath, avatarId, videoPath, outName } = {}) {
    if (!audioPath) throw new Error('音频路径为空');
    const started = Date.now();
    const data = await this._request('POST', '/infer', {
      body: {
        audioPath,
        avatarId: avatarId || this.config.get('realtime.avatarId', 'yongen'),
        videoPath: videoPath || this.config.get('muse.avatar', 'data/video/yongen.mp4'),
        outName: outName || `infer-${Date.now().toString(36)}`
      },
      timeoutMs: Number(this.config.get('realtime.timeoutMs', 600000))
    });
    this.logger.success(
      'realtime',
      `歌手音色口型推理完成 ${Date.now() - started}ms → ${data.videoPath || '(无)'}`
    );
    return data; // { ok, videoPath, elapsedMs }
  }

  async stt({ audioBase64, filename = 'mic.webm', mime = 'audio/webm' } = {}) {
    if (!audioBase64) throw new Error('录音数据为空');
    const buffer = Buffer.from(audioBase64, 'base64');
    const boundary = `----trae${Date.now().toString(16)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buffer, tail]);

    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl() + '/stt?language=zh');
      const req = http.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
          },
          timeout: 180000
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* ignore */ }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(parsed?.detail || `HTTP ${res.statusCode}`));
            }
            resolve(parsed);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('语音识别超时')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** 让实时服务释放显存，供离线渲染抢占 GPU；服务未启动时静默跳过。 */
  async unload({ retries = 8, intervalMs = 3000 } = {}) {
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await this._request('POST', '/admin/unload', { timeoutMs: 30000 });
      } catch (err) {
        if (err.status === 409) {
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        return { ok: false, skipped: true, detail: err.message };
      }
    }
    return { ok: false, skipped: true, detail: '实时服务持续忙碌，未释放显存' };
  }
}

module.exports = { RealtimeAdapter };
