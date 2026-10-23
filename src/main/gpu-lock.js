'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 跨进程 GPU 互斥锁（文件锁）。
 * 离线 MuseTalk 渲染与实时互动服务共用同一张显卡，同一时刻只允许一个任务持有。
 */
class GpuLock {
  constructor({ file, owner, logger, staleMs = 2 * 60 * 60 * 1000 }) {
    this.file = file;
    this.owner = owner || 'unknown';
    this.logger = logger;
    this.staleMs = staleMs;
  }

  isLocked() {
    return fs.existsSync(this.file);
  }

  _stale() {
    try {
      return Date.now() - fs.statSync(this.file).mtimeMs > this.staleMs;
    } catch (_) {
      return true;
    }
  }

  async acquire({ waitMs = 15 * 60 * 1000, pollMs = 2000, onWait } = {}) {
    const deadline = Date.now() + waitMs;
    let notified = false;
    for (;;) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const fd = fs.openSync(this.file, 'wx');
        fs.writeSync(fd, JSON.stringify({ owner: this.owner, pid: process.pid, ts: Date.now() }));
        fs.closeSync(fd);
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (this._stale()) {
          try {
            fs.rmSync(this.file, { force: true });
          } catch (_) { /* ignore */ }
          continue;
        }
        if (Date.now() > deadline) return false;
        if (!notified && onWait) {
          notified = true;
          try { onWait(); } catch (_) { /* ignore */ }
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  release() {
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      if (this.logger) this.logger.warn('gpu', `释放 GPU 锁失败: ${err.message}`);
    }
  }
}

module.exports = { GpuLock };
