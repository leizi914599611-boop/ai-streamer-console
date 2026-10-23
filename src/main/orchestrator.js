'use strict';

const { EventEmitter } = require('events');

const STATE_LABELS = {
  idle: '待机',
  interact: '实时互动',
  song: '曲目播出',
  degraded: '降级运行'
};

const STATE_HINTS = {
  idle: '循环播放待机画面，等待直播事件',
  interact: '口型驱动链路实时响应观众互动',
  song: '播出已预渲染的演唱曲目',
  degraded: '实时链路不可用，仅保留音频 / 静态画面'
};

const TRANSITIONS = {
  idle: ['interact', 'song', 'degraded'],
  interact: ['idle', 'song', 'degraded'],
  song: ['idle', 'interact', 'degraded'],
  degraded: ['idle', 'interact']
};

/**
 * 直播状态机：idle / interact / song / degraded。
 * 负责状态迁移校验、失败计数自动降级、状态广播。
 */
class Orchestrator extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.state = 'idle';
    this.since = Date.now();
    this.reason = '初始化';
    this.live = false;
    this.failures = 0;
    this.currentSong = null;
    this.history = [];
    this.idleTimer = null;
  }

  snapshot() {
    return {
      state: this.state,
      label: STATE_LABELS[this.state],
      hint: STATE_HINTS[this.state],
      since: this.since,
      uptimeSec: Math.floor((Date.now() - this.since) / 1000),
      reason: this.reason,
      live: this.live,
      failures: this.failures,
      currentSong: this.currentSong,
      allowed: TRANSITIONS[this.state] || [],
      history: this.history.slice(-30)
    };
  }

  transition(next, reason, extra = {}) {
    if (!TRANSITIONS[this.state]) throw new Error(`非法状态: ${this.state}`);
    if (next !== this.state && !TRANSITIONS[this.state].includes(next)) {
      throw new Error(`不允许从 ${STATE_LABELS[this.state]} 切换到 ${STATE_LABELS[next] || next}`);
    }
    const prev = this.state;
    this.state = next;
    this.since = Date.now();
    this.reason = reason || '';
    if (next === 'song') this.currentSong = extra.song || this.currentSong;
    if (next === 'idle') this.currentSong = null;
    if (next !== 'degraded') this.failures = 0;

    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const idleSec = Number(this.config.get('orchestrator.idleAfterInteractSec', 0));
    if (next === 'interact' && idleSec > 0) {
      this.idleTimer = setTimeout(() => {
        this.logger.info('orchestrator', `互动空闲 ${idleSec}s，自动回到待机`);
        this.transition('idle', '互动空闲超时');
      }, idleSec * 1000);
    }

    this.history.push({ from: prev, to: next, at: Date.now(), reason: this.reason });
    if (this.history.length > 100) this.history.shift();
    this.logger.info('orchestrator', `${STATE_LABELS[prev]} → ${STATE_LABELS[next]}（${this.reason}）`);
    this.emit('state', this.snapshot());
    return this.snapshot();
  }

  setLive(live, reason = '') {
    this.live = Boolean(live);
    this.logger.info('orchestrator', `直播状态: ${this.live ? '开播' : '停播'}${reason ? ' - ' + reason : ''}`);
    this.emit('state', this.snapshot());
    return this.snapshot();
  }

  reportRenderResult(ok, job) {
    if (ok) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    const threshold = Number(this.config.get('orchestrator.autoDegradeAfterFailures', 3)) || 3;
    this.logger.warn('orchestrator', `渲染失败计数 ${this.failures}/${threshold}${job ? ' - ' + job.title : ''}`);
    if (this.failures >= threshold && this.state !== 'degraded') {
      this.transition('degraded', `连续 ${threshold} 次渲染失败`);
    }
  }

  stopAutoTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

module.exports = { Orchestrator, STATE_LABELS, STATE_HINTS };
