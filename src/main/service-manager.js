'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error'
};

function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function probeHttp(host, port, urlPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath || '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}

/**
 * 子进程服务编排：启动 / 停止 / 健康检查 / 日志转发。
 * 一个服务 = 一个 Python 进程（LatentSync、SVS、SVC）。
 */
class ServiceManager extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.services = new Map();
    for (const spec of config.get('services', [])) this.register(spec);
  }

  register(spec) {
    this.services.set(spec.id, {
      spec,
      status: STATES.STOPPED,
      pid: null,
      child: null,
      startedAt: null,
      lastError: null,
      healthTimer: null,
      stopping: false,
      portBusy: false
    });
  }

  snapshot(entry) {
    const { spec } = entry;
    const entryFile = this._entryFile(spec);
    const cloud = spec.cloud || {};
    const isCloud = spec.mode === 'cloud';
    return {
      id: spec.id,
      name: spec.name,
      role: spec.role,
      mode: spec.mode || 'local',
      isCloud,
      cloud,
      endpoint: isCloud ? (cloud.endpoint || '') : '',
      port: spec.port,
      url: isCloud ? (cloud.endpoint || '') : `http://127.0.0.1:${spec.port}`,
      autoStart: Boolean(spec.autoStart),
      status: isCloud && !cloud.endpoint ? 'stopped' : entry.status,
      pid: entry.pid,
      startedAt: entry.startedAt,
      uptimeSec: entry.startedAt ? Math.floor((Date.now() - entry.startedAt) / 1000) : 0,
      lastError: entry.lastError,
      cwd: spec.cwd,
      healthPath: spec.healthPath || '/health',
      python: spec.python,
      args: spec.args || [],
      exists: isCloud ? true : (entryFile ? fs.existsSync(entryFile) : true),
      pythonExists: isCloud ? true : fs.existsSync(this.config.resolvePath(spec.python))
    };
  }

  /** 仅当第一个参数是 .py 脚本时才校验入口文件 */
  _entryFile(spec) {
    const first = (spec.args && spec.args[0]) || '';
    return /\.py$/i.test(first) ? path.resolve(this.config.resolvePath(spec.cwd), first) : '';
  }

  list() {
    return Array.from(this.services.values()).map((entry) => this.snapshot(entry));
  }

  /** 配置变更后刷新服务定义（运行中的服务保留旧 spec，需重启后生效） */
  reloadSpecs() {
    for (const spec of this.config.get('services', [])) {
      const entry = this.services.get(spec.id);
      if (!entry) this.register(spec);
      else if (entry.status === STATES.STOPPED) entry.spec = spec;
    }
    return this.list();
  }

  _update(entry, status, patch = {}) {
    entry.status = status;
    Object.assign(entry, patch);
    const snap = this.snapshot(entry);
    this.emit('status', snap);
    return snap;
  }

  get(id) {
    return this.services.get(id);
  }

  async start(id) {
    const entry = this.services.get(id);
    if (!entry) throw new Error(`未知服务: ${id}`);
    if (entry.status === STATES.RUNNING || entry.status === STATES.STARTING) {
      return this.snapshot(entry);
    }
    const { spec } = entry;

    // 云端服务不走本地 spawn，SystemMonitor 直接探测远程 endpoint
    if (spec.mode === 'cloud') {
      const endpoint = (spec.cloud || {}).endpoint || '';
      if (!endpoint) {
        const msg = `未配置云端 endpoint，请在设置中填写后再操作`;
        this.logger.warn(`svc:${id}`, msg);
        return this._update(entry, STATES.ERROR, { lastError: msg });
      }
      this.logger.info(`svc:${id}`, `云端模式已启用: ${endpoint}`);
      return this._update(entry, STATES.RUNNING);
    }

    const python = this.config.resolvePath(spec.python);
    const cwd = this.config.resolvePath(spec.cwd);

    if (!fs.existsSync(python)) {
      const msg = `Python 解释器不存在: ${python}`;
      this.logger.error(`svc:${id}`, msg);
      return this._update(entry, STATES.ERROR, { lastError: msg });
    }
    const entryFile = this._entryFile(spec);
    if (entryFile && !fs.existsSync(entryFile)) {
      const msg = `入口文件不存在: ${entryFile}`;
      this.logger.error(`svc:${id}`, msg);
      return this._update(entry, STATES.ERROR, { lastError: msg });
    }

    const busy = await probePort('127.0.0.1', spec.port);
    if (busy) {
      const msg = `端口 ${spec.port} 已被占用，无法启动 ${spec.name}`;
      this.logger.error(`svc:${id}`, msg);
      return this._update(entry, STATES.ERROR, { lastError: msg, portBusy: true });
    }

    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    env.PATH = [...(spec.envPaths || []), env.PATH || ''].join(path.delimiter);

    this.logger.info(`svc:${id}`, `启动 ${spec.name}（端口 ${spec.port}）`);
    let child;
    try {
      child = spawn(python, spec.args, {
        cwd,
        env,
        windowsHide: true,
        detached: false
      });
    } catch (err) {
      this.logger.error(`svc:${id}`, `进程创建失败: ${err.message}`);
      return this._update(entry, STATES.ERROR, { lastError: err.message });
    }

    entry.child = child;
    entry.pid = child.pid;
    entry.stopping = false;
    entry.lastError = null;
    this._update(entry, STATES.STARTING, { startedAt: Date.now() });

    const pipe = (stream, level) => {
      let rest = '';
      stream.on('data', (buf) => {
        rest += buf.toString('utf8');
        const lines = rest.split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) {
          if (line.trim()) this.logger[level](`svc:${id}`, line);
        }
      });
    };
    pipe(child.stdout, 'info');
    pipe(child.stderr, 'warn');

    child.on('error', (err) => {
      this.logger.error(`svc:${id}`, `进程错误: ${err.message}`);
      this._update(entry, STATES.ERROR, { lastError: err.message, pid: null, child: null });
    });

    child.on('close', (code) => {
      clearInterval(entry.healthTimer);
      entry.healthTimer = null;
      entry.child = null;
      entry.pid = null;
      entry.startedAt = null;
      if (entry.stopping) {
        this.logger.info(`svc:${id}`, `${spec.name} 已停止（code=${code}）`);
        this._update(entry, STATES.STOPPED, { lastError: null });
      } else {
        const msg = `进程意外退出（code=${code}）`;
        this.logger.error(`svc:${id}`, msg);
        this._update(entry, STATES.ERROR, { lastError: msg });
      }
    });

    this._startHealthWatch(entry);
    return this.snapshot(entry);
  }

  _startHealthWatch(entry) {
    const { spec } = entry;
    const deadline = Date.now() + (spec.startupTimeoutMs || 180000);
    clearInterval(entry.healthTimer);
    entry.healthTimer = setInterval(async () => {
      if (entry.status !== STATES.STARTING) {
        clearInterval(entry.healthTimer);
        entry.healthTimer = null;
        return;
      }
      const ok = await probeHttp('127.0.0.1', spec.port, spec.healthPath);
      if (ok) {
        clearInterval(entry.healthTimer);
        entry.healthTimer = null;
        this.logger.success(`svc:${spec.id}`, `${spec.name} 就绪: http://127.0.0.1:${spec.port}`);
        this._update(entry, STATES.RUNNING, { lastError: null });
      } else if (Date.now() > deadline) {
        clearInterval(entry.healthTimer);
        entry.healthTimer = null;
        const msg = `启动超时（${Math.round((spec.startupTimeoutMs || 180000) / 1000)}s 内未响应）`;
        this.logger.error(`svc:${spec.id}`, msg);
        this._update(entry, STATES.ERROR, { lastError: msg });
      }
    }, 1500);
  }

  async stop(id) {
    const entry = this.services.get(id);
    if (!entry) throw new Error(`未知服务: ${id}`);
    if (!entry.pid || !entry.child) {
      clearInterval(entry.healthTimer);
      entry.healthTimer = null;
      return this._update(entry, STATES.STOPPED, { lastError: null });
    }
    entry.stopping = true;
    clearInterval(entry.healthTimer);
    entry.healthTimer = null;
    this.logger.info(`svc:${id}`, `停止 ${entry.spec.name}（pid=${entry.pid}）`);
    this._update(entry, STATES.STOPPING);
    await killTree(entry.pid);
    return this.snapshot(entry);
  }

  async restart(id) {
    await this.stop(id);
    await new Promise((r) => setTimeout(r, 1200));
    return this.start(id);
  }

  async stopAll() {
    const ids = Array.from(this.services.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}

module.exports = { ServiceManager, STATES, probePort };
