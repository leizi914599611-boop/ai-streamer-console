'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * 运行环境监控：GPU 显存/利用率、GPU 互斥锁持有者、各服务 /health 探测。
 * 定时采集并通过 stats 事件推给渲染进程。
 */
class SystemMonitor extends EventEmitter {
  constructor({ config, logger, services, intervalMs = 4000 }) {
    super();
    this.config = config;
    this.logger = logger;
    this.services = services;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.cache = null;
    this.collecting = false;
  }

  start() {
    if (this.timer) return;
    this.collect().catch(() => {});
    this.timer = setInterval(() => {
      this.collect().catch(() => {});
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 读取缓存，过期则重新采集 */
  async stats({ force = false } = {}) {
    if (force || !this.cache || Date.now() - this.cache.at > this.intervalMs) {
      return this.collect();
    }
    return this.cache;
  }

  async collect() {
    if (this.collecting) return this.cache || null;
    this.collecting = true;
    try {
      const [gpu, health] = await Promise.all([
        this._gpu(),
        this._allHealth()
      ]);
      const snap = {
        at: Date.now(),
        gpu,
        gpuLock: this._gpuLock(),
        services: health
      };
      this.cache = snap;
      this.emit('stats', snap);
      return snap;
    } finally {
      this.collecting = false;
    }
  }

  /** 单个服务健康探测（本地 / 云端双分支） */
  async probe(id) {
    const svc = this.services.list().find((s) => s.id === id);
    if (!svc) throw new Error('服务不存在');
    return { id, ...(await this._health(svc)) };
  }

  async _allHealth() {
    const list = this.services.list();
    const entries = await Promise.all(list.map(async (svc) => {
      if (svc.mode === 'cloud') {
        // 云端服务：始终走远程探测，不依赖 process 是否在本地运行
        return [svc.id, await this._health(svc)];
      }
      if (svc.status !== 'running') {
        return [svc.id, { reachable: false, skipped: true, detail: '未运行', deploy: 'local' }];
      }
      return [svc.id, await this._health(svc)];
    }));
    return Object.fromEntries(entries);
  }

  /** 统一 HTTP 探测：支持本地 127.0.0.1 或云端 endpoint */
  _httpProbe({ host, port, path, headers = {}, timeoutMs = 2000 }) {
    return new Promise((resolve) => {
      const started = Date.now();
      const req = http.get({ host, port, path, headers, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body = (body + chunk).slice(0, 20000); });
        res.on('end', () => {
          const latencyMs = Date.now() - started;
          if (res.statusCode === 301 || res.statusCode === 302) {
            // 跟随一次重定向（处理 AutoDL 的反向代理）
            const loc = res.headers.location;
            if (loc) return resolve({ needRedirect: true, latencyMs, location: loc });
          }
          let json = null;
          try { json = JSON.parse(body); } catch (_) { /* 非 JSON */ }
          resolve({ latencyMs, httpStatus: res.statusCode, bodyOk: Boolean(json), json });
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ latencyMs: Date.now() - started, timedOut: true }); });
      req.on('error', (err) => resolve({ latencyMs: Date.now() - started, error: err.code || err.message }));
    });
  }

  /** 解析 endpoint 字符串为 host/port/path */
  _parseEndpoint(endpoint) {
    if (!endpoint) return null;
    try {
      const u = new URL(endpoint.startsWith('http') ? endpoint : `http://${endpoint}`);
      return { host: u.hostname, port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80), path: u.pathname || '/' };
    } catch (_) { return null; }
  }

  /** 探测服务健康：本地走 127.0.0.1，云端走 endpoint */
  async _health(svc) {
    const healthPath = svc.healthPath || '/health';
    const deploy = svc.mode === 'cloud' ? 'cloud' : 'local';

    // 云端分支
    if (deploy === 'cloud') {
      const cloud = svc.cloud || {};
      const endpoint = cloud.endpoint || '';
      if (!endpoint) {
        return { reachable: false, detail: '云端 endpoint 未配置', deploy: 'cloud', latencyMs: 0, cloudConnected: false };
      }
      const parsed = this._parseEndpoint(endpoint);
      if (!parsed) {
        return { reachable: false, detail: `endpoint 格式错误: ${endpoint}`, deploy: 'cloud', latencyMs: 0, cloudConnected: false };
      }
      const auth = cloud.apiKey ? { Authorization: `Bearer ${cloud.apiKey}` } : {};
      const baseHeaders = { ...auth };
      const res = await this._httpProbe({
        host: parsed.host, port: parsed.port, path: (parsed.path || '/') === '/' ? healthPath : healthPath,
        headers: baseHeaders, timeoutMs: 3000
      });
      if (res.needRedirect) {
        const redir = this._parseEndpoint(res.location);
        if (redir) {
          const res2 = await this._httpProbe({ host: redir.host, port: redir.port, path: healthPath, headers: baseHeaders, timeoutMs: 3000 });
          return this._composeResult(res2, deploy);
        }
      }
      return this._composeResult(res, deploy);
    }

    // 本地分支
    const res = await this._httpProbe({ host: '127.0.0.1', port: svc.port, path: healthPath, timeoutMs: 1500 });
    return this._composeResult(res, deploy);
  }

  _composeResult(res, deploy) {
    if (res.timedOut) {
      return { reachable: false, detail: '探测超时', deploy, latencyMs: res.latencyMs, cloudConnected: deploy === 'cloud' ? false : undefined };
    }
    if (res.error) {
      const ok = res.error === 'ECONNREFUSED' || res.error === 'ENOTFOUND' || res.error === 'ETIMEDOUT' || res.error === 'ECONNRESET';
      return {
        reachable: false,
        detail: res.error,
        deploy,
        latencyMs: res.latencyMs,
        cloudConnected: deploy === 'cloud' ? !ok : undefined
      };
    }
    const httpOk = res.httpStatus >= 200 && res.httpStatus < 500;
    const base = { reachable: httpOk, httpStatus: res.httpStatus, latencyMs: res.latencyMs, deploy };
    if (deploy === 'cloud') base.cloudConnected = true;
    if (res.json) {
      const j = res.json;
      return {
        ...base,
        busy: Boolean(j.busy),
        modelLoaded: Boolean(j.modelLoaded),
        avatarReady: Boolean(j.avatarReady),
        sttReady: Boolean(j.sttReady),
        avatarId: j.avatarId || null,
        sttModel: j.sttModel || null,
        device: j.device || null,
        gpuLocked: Boolean(j.gpuLocked),
        lastError: j.lastError || null,
        detail: '健康'
      };
    }
    return { ...base, detail: res.httpStatus === 200 ? 'HTTP 200（无结构化状态）' : `HTTP ${res.httpStatus}` };
  }

  /** nvidia-smi 采集显存与利用率 */
  _gpu() {
    return new Promise((resolve) => {
      const args = [
        '--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu',
        '--format=csv,noheader,nounits'
      ];
      let out = '';
      let failed = false;
      let child;
      try {
        child = spawn('nvidia-smi', args, { windowsHide: true });
      } catch (err) {
        return resolve({ available: false, detail: err.message });
      }
      child.stdout.on('data', (b) => { out += b.toString('utf8'); });
      child.on('error', () => {
        failed = true;
        resolve({ available: false, detail: '未检测到 nvidia-smi（可能是 CPU 环境）' });
      });
      child.on('close', (code) => {
        if (failed) return;
        if (code !== 0 || !out.trim()) {
          return resolve({ available: false, detail: 'nvidia-smi 执行失败' });
        }
        const row = out.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
        resolve({
          available: true,
          name: row[0] || 'GPU',
          usedMb: Number(row[1]) || 0,
          totalMb: Number(row[2]) || 0,
          utilPct: Number(row[3]) || 0,
          tempC: Number(row[4]) || 0
        });
      });
    });
  }

  /** GPU 互斥锁文件当前持有者 */
  _gpuLock() {
    const file = this.config.resolvePath(
      this.config.get('realtime.gpuLockFile', 'tools/MuseTalk/results/_realtime/gpu.lock')
    );
    try {
      if (!fs.existsSync(file)) return { locked: false, file };
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        locked: true,
        file,
        owner: raw.owner || 'unknown',
        pid: raw.pid || null,
        ageSec: Math.max(0, Math.floor((Date.now() - fs.statSync(file).mtimeMs) / 1000)),
        dir: path.basename(path.dirname(file))
      };
    } catch (err) {
      return { locked: false, file, detail: err.message };
    }
  }
}

module.exports = { SystemMonitor };
