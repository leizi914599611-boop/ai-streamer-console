'use strict';

const { EventEmitter } = require('events');

/**
 * 实时互动回合编排：
 *   观众文本/语音 -> DeepSeek 生成回应 -> edge-tts 合成干声
 *   -> SoulX-Singer SVC 转换为歌手音色 -> MuseTalk 口型 -> 互动轨视频。
 *
 * 「说话音色 = 歌手音色」强制链路：SVC 转换复用与 SVS 同一份 promptWav/promptMeta。
 * 任何环节失败都会记录并按阈值触发状态机降级，不阻塞主线程。
 */
class InteractionController extends EventEmitter {
  constructor({ config, logger, orchestrator, realtime, llm, stream, soulx }) {
    super();
    this.config = config;
    this.logger = logger;
    this.orchestrator = orchestrator;
    this.realtime = realtime;
    this.llm = llm;
    this.stream = stream || null;
    this.soulx = soulx || null;
    this.failures = 0;
    this.turns = [];
    this.busy = false;
  }

  snapshot() {
    const consistency = this.config.get('voice.consistencyEnabled', true) && !!this.soulx;
    return {
      busy: this.busy,
      failures: this.failures,
      llmConfigured: this.llm.isConfigured(),
      voiceConsistency: consistency,
      turns: this.turns.slice(-12)
    };
  }

  _enterInteract(reason) {
    if (this.orchestrator.state === 'interact') return;
    this.orchestrator.transition('interact', reason);
  }

  /**
   * 优先链路（音色一致）：LLM → edge-tts → SVC 歌手音色 → MuseTalk /infer
   * 降级链路：任一环节失败 → 回退 realtime.talk()（edge-tts 合成 + MuseTalk /talk，音色不一致）
   */
  async talk({ text, voice, forceDirect = false } = {}) {
    const input = String(text || '').trim();
    if (!input) throw new Error('互动文本为空');
    if (this.busy) throw new Error('上一轮互动仍在生成中');

    this.busy = true;
    const started = Date.now();
    this.emit('turn', { phase: 'start', input });
    this.logger.info('interact', `收到互动输入: ${input.slice(0, 60)}`);

    try {
      this._enterInteract('观众互动触发');

      let replyText = input;
      let llmMeta = null;
      if (!forceDirect) {
        if (!this.llm.isConfigured()) {
          this.logger.warn('interact', '未配置 DeepSeek API Key，直接播报输入文本');
        } else {
          this.emit('turn', { phase: 'llm', input });
          const reply = await this.llm.chat({ text: input });
          replyText = reply.content;
          llmMeta = { model: reply.model, latencyMs: reply.latencyMs, usage: reply.usage };
        }
      }

      const consistency = this.config.get('voice.consistencyEnabled', true) && !!this.soulx;
      let turn;
      if (consistency) {
        turn = await this._renderWithConsistency(replyText, voice);
      } else {
        turn = await this._renderDirect(replyText, voice);
      }
      turn.input = input;
      turn.reply = replyText;
      turn.llm = llmMeta;
      turn.totalMs = turn.totalMs || Date.now() - started;

      this.turns.push(turn);
      if (this.turns.length > 40) this.turns.shift();
      this.failures = 0;
      this.logger.success(
        'interact',
        `回合完成 ${turn.totalMs}ms「${replyText.slice(0, 40)}」` +
          (turn.consistency ? `（音色一致 SVC ${turn.svcMs || '-'}ms）` : '')
      );
      this.emit('turn', { phase: 'done', turn });
      this._pushToStream(turn);
      return turn;
    } catch (err) {
      this.failures += 1;
      this.logger.error('interact', `互动回合失败: ${err.message}`);
      this.emit('turn', { phase: 'error', input, error: err.message });
      const threshold = Number(this.config.get('orchestrator.autoDegradeAfterFailures', 3)) || 3;
      if (this.failures >= threshold && this.orchestrator.state === 'interact') {
        this.orchestrator.transition('degraded', `连续 ${threshold} 次互动失败`);
      }
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** 链路 A：edge-tts → SVC → MuseTalk /infer（音色一致） */
  async _renderWithConsistency(text, voice) {
    const t0 = Date.now();
    this.emit('turn', { phase: 'synthesize', text });
    const syn = await this.realtime.synthesizeText({ text, voice });
    const ttsMs = Date.now() - t0;
    this.logger.info('interact', `edge-tts 干声就绪 ${ttsMs}ms → ${syn.wavPath}`);

    this.emit('turn', { phase: 'svc', text });
    const t1 = Date.now();
    const converted = await this.soulx.convertSpeak({
      sourceWav: syn.wavPath,
      promptWav: this.config.get('soulx.promptWav'),
      promptMeta: this.config.get('soulx.promptMeta')
    });
    const svcMs = Date.now() - t1;
    this.logger.success('interact', `SVC 转换完成 ${svcMs}ms (cache=${converted.promptCached}) → ${converted.output}`);

    this.emit('turn', { phase: 'infer', text });
    const t2 = Date.now();
    const rendered = await this.realtime.inferWithAudio({
      audioPath: converted.output
    });
    const inferMs = Date.now() - t2;
    return {
      videoPath: rendered.videoPath,
      audioPath: converted.output,
      consistency: true,
      ttsMs, svcMs, inferMs,
      promptCached: converted.promptCached
    };
  }

  /** 链路 B：直接调 /talk（音色不一致，降级/兼容路径） */
  async _renderDirect(text, voice) {
    const rendered = await this.realtime.talk({ text, voice });
    return {
      videoPath: rendered.videoPath,
      audioPath: rendered.audioPath,
      consistency: false,
      ttsMs: rendered.ttsMs,
      inferMs: rendered.inferMs,
      totalMs: rendered.totalMs
    };
  }

  /** 直播中且推流使用互动轨时，把最新回合视频切到推流画面源。 */
  _pushToStream(turn) {
    if (!this.stream) return;
    if (this.config.get('stream.track', 'file') !== 'interact') return;
    const live = this.stream.status === 'live' || this.stream.status === 'starting';
    if (!live) return;
    this.stream
      .switchSource(turn.videoPath)
      .catch((err) => this.logger.warn('interact', `推流画面切换失败: ${err.message}`));
  }

  async stt({ audioBase64, filename, mime } = {}) {
    const result = await this.realtime.stt({ audioBase64, filename, mime });
    this.logger.info('interact', `语音识别: ${(result.text || '').slice(0, 60) || '(空)'}`);
    return result;
  }

  async prepareAvatar({ avatarId, videoPath } = {}) {
    const started = Date.now();
    const result = await this.realtime.prepareAvatar({ avatarId, videoPath });
    this.logger.success('interact', `形象预处理完成 ${Date.now() - started}ms`);
    return result;
  }

  async status() {
    const health = await this.realtime.health();
    return { ...this.snapshot(), service: health };
  }
}

module.exports = { InteractionController };
