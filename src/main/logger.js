'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * 全局日志：内存环形缓冲 + 按日期落盘 + 向渲染进程广播。
 */
class Logger extends EventEmitter {
  constructor(logDir, { maxEntries = 3000 } = {}) {
    super();
    this.logDir = logDir;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.seq = 0;
    fs.mkdirSync(logDir, { recursive: true });
    this.stream = null;
    this.streamDate = null;
    this._openStream();
  }

  _openStream() {
    const date = new Date().toISOString().slice(0, 10);
    if (this.streamDate === date && this.stream) return;
    if (this.stream) this.stream.end();
    this.streamDate = date;
    this.stream = fs.createWriteStream(path.join(this.logDir, `${date}.log`), { flags: 'a' });
  }

  _write(level, scope, message) {
    const entry = {
      seq: ++this.seq,
      time: new Date().toISOString(),
      level,
      scope,
      message: String(message)
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    try {
      this._openStream();
      this.stream.write(`[${entry.time}] [${level.toUpperCase()}] [${scope}] ${entry.message}\n`);
    } catch (_) {
      /* 落盘失败不影响运行 */
    }
    this.emit('log', entry);
  }

  info(scope, message) { this._write('info', scope, message); }
  warn(scope, message) { this._write('warn', scope, message); }
  error(scope, message) { this._write('error', scope, message); }
  success(scope, message) { this._write('success', scope, message); }
  /** 仅落盘、不入内存缓冲、不广播：用于健康检查 200 OK 等正常轮询降噪 */
  trace(scope, message) {
    try {
      this._openStream();
      this.stream.write(`[${new Date().toISOString()}] [TRACE] [${scope}] ${String(message)}\n`);
    } catch (_) { /* 忽略 */ }
  }

  recent(limit = 300) {
    return this.entries.slice(-limit);
  }
}

module.exports = { Logger };
