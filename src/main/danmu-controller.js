'use strict';

const { EventEmitter } = require('events');

/**
 * 弹幕编排控制器：
 *   轮询弹幕服务事件 → 去重/冷却过滤 → 广播到渲染进程；
 *   自动回复开启时，按队列逐条触发 InteractionController（口型服务忙时排队等待）。
 *
 * 任何异常只记录日志，不阻塞主线程（降级逃生通道）。
 */
class DanmuController extends EventEmitter {
  constructor({ config, logger, danmu, interaction }) {
    super();
    this.config = config;
    this.logger = logger;
    this.danmu = danmu;
    this.interaction = interaction;
    this.cursor = 0;
    this.serviceState = { state: 'idle' };
    this.replyQueue = [];
    this.userCooldown = new Map(); // userId -> lastReplyTs
    this.seen = new Set();         // 防同一事件重复入队
    this.pollTimer = null;
    this.replyTimer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const pollMs = Number(this.config.get('danmu.pollMs', 2000)) || 2000;
    this.pollTimer = setInterval(() => this._poll().catch(() => {}), pollMs);
    this.replyTimer = setInterval(() => this._drainReplyQueue().catch(() => {}), 1000);
    this.logger.info('danmu', `弹幕轮询已启动（${pollMs}ms）`);
  }

  stop() {
    this.running = false;
    clearInterval(this.pollTimer);
    clearInterval(this.replyTimer);
    this.pollTimer = null;
    this.replyTimer = null;
  }

  snapshot() {
    return {
      state: this.serviceState,
      autoReply: Boolean(this.config.get('danmu.autoReply', false)),
      cooldownSec: Number(this.config.get('danmu.cooldownSec', 30)),
      queueLength: this.replyQueue.length
    };
  }

  async connect(opts) {
    const res = await this.danmu.connect(opts || {});
    if (!res.ok) throw new Error(res.error || '连接失败');
    this.logger.info('danmu', `连接直播间: ${opts.liveId}`);
    return res;
  }

  async disconnect() {
    const res = await this.danmu.disconnect();
    this.serviceState = { state: 'idle' };
    this.emit('state', this.snapshot());
    return res;
  }

  async mock(opts) {
    return this.danmu.mock(opts || {});
  }

  /** 手动回复某条弹幕文本 */
  async manualReply(text) {
    const input = String(text || '').trim();
    if (!input) throw new Error('弹幕内容为空');
    return this.interaction.talk({ text: input });
  }

  async _poll() {
    const res = await this.danmu.events(this.cursor);
    if (!res || res.ok !== true) return; // 服务未启动时静默跳过
    this.cursor = res.cursor || this.cursor;
    const prevState = this.serviceState && this.serviceState.state;
    this.serviceState = res.state || this.serviceState;
    const events = res.events || [];
    if (events.length) {
      this.emit('events', events);
      this._maybeAutoReply(events);
    }
    if (this.serviceState.state !== prevState) {
      this.emit('state', this.snapshot());
    }
  }

  _maybeAutoReply(events) {
    if (!this.config.get('danmu.autoReply', false)) return;
    const maxQueue = Number(this.config.get('danmu.maxQueue', 10)) || 10;
    const cooldownMs = (Number(this.config.get('danmu.cooldownSec', 30)) || 30) * 1000;
    const giftThanks = Boolean(this.config.get('danmu.giftThanks', true));

    for (const ev of events) {
      if (ev.type !== 'chat' && !(giftThanks && ev.type === 'gift')) continue;
      if (!ev.text || this.seen.has(ev.seq)) continue;
      this.seen.add(ev.seq);
      if (this.seen.size > 1000) this.seen.clear();

      const now = Date.now();
      const last = this.userCooldown.get(ev.userId) || 0;
      if (now - last < cooldownMs) continue;
      if (this.replyQueue.length >= maxQueue) {
        this.logger.warn('danmu', '自动回复队列已满，丢弃新弹幕');
        continue;
      }
      this.userCooldown.set(ev.userId, now);
      const text = ev.type === 'gift'
        ? `感谢 ${ev.nickname} 送出的${ev.giftName || '礼物'}！`
        : ev.text;
      this.replyQueue.push({ text, forceDirect: ev.type === 'gift', nickname: ev.nickname, type: ev.type });
      this.logger.info('danmu', `弹幕入队(${this.replyQueue.length}): [${ev.nickname}] ${text.slice(0, 40)}`);
      this.emit('state', this.snapshot());
    }
  }

  async _drainReplyQueue() {
    if (!this.replyQueue.length) return;
    if (this.interaction.busy) return;
    const item = this.replyQueue.shift();
    this.emit('state', this.snapshot());
    try {
      await this.interaction.talk({ text: item.text, forceDirect: item.forceDirect });
    } catch (err) {
      this.logger.warn('danmu', `自动回复失败: ${err.message}`);
    }
  }
}

module.exports = { DanmuController };
