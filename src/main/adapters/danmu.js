'use strict';

const http = require('http');

/**
 * 弹幕服务 HTTP 适配器：连接/断开/状态/事件拉取/模拟弹幕。
 */
class DanmuAdapter {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  baseUrl() {
    return `http://127.0.0.1:${this.config.get('danmu.port', 7864)}`;
  }

  _request(method, urlPath, body, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const url = new URL(this.baseUrl() + urlPath);
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          timeout: timeoutMs,
          headers: data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}
        },
        (res) => {
          let raw = '';
          res.on('data', (b) => { raw += b.toString('utf8'); });
          res.on('end', () => {
            try {
              const json = JSON.parse(raw);
              if (res.statusCode >= 400) {
                resolve({ ok: false, error: json.detail || `HTTP ${res.statusCode}` });
              } else {
                resolve(json);
              }
            } catch (err) {
              resolve({ ok: false, error: `响应解析失败: ${err.message}` });
            }
          });
        }
      );
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      if (data) req.write(data);
      req.end();
    });
  }

  async health() {
    const res = await this._request('GET', '/health', null, 5000);
    if (!res || res.ok !== true) return { ok: false, detail: (res && res.error) || '服务未响应' };
    return res;
  }

  connect({ liveId, mode, cookie }) {
    return this._request('POST', '/connect', { liveId, mode: mode || 'anonymous', cookie: cookie || '' }, 20000);
  }

  disconnect() {
    return this._request('POST', '/disconnect');
  }

  events(cursor, limit = 100) {
    return this._request('GET', `/events?cursor=${cursor}&limit=${limit}`, null, 10000);
  }

  mock({ text, nickname, type }) {
    return this._request('POST', '/mock', { text, nickname, type: type || 'chat' });
  }
}

module.exports = { DanmuAdapter };
