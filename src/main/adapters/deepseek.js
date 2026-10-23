'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * DeepSeek 对话适配器（OpenAI 兼容 /chat/completions）。
 */
class DeepSeekClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.history = [];
  }

  _endpoint() {
    const base = (this.config.get('cloud.deepseek.baseUrl', 'https://api.deepseek.com') || '').replace(/\/$/, '');
    return `${base}/chat/completions`;
  }

  isConfigured() {
    return Boolean(this.config.get('cloud.deepseek.apiKey', ''));
  }

  reset() {
    this.history = [];
  }

  async chat({ text, systemPrompt, reset = false } = {}) {
    const apiKey = this.config.get('cloud.deepseek.apiKey', '');
    if (!apiKey) throw new Error('未配置 DeepSeek API Key');
    if (!text || !text.trim()) throw new Error('输入内容为空');
    if (reset) this.history = [];

    const system = systemPrompt || this.config.get('cloud.deepseek.systemPrompt', '');
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...this.history.slice(-12),
      { role: 'user', content: text }
    ];

    const payload = JSON.stringify({
      model: this.config.get('cloud.deepseek.model', 'deepseek-chat'),
      messages,
      temperature: Number(this.config.get('cloud.deepseek.temperature', 0.8)),
      max_tokens: Number(this.config.get('cloud.deepseek.maxTokens', 400)),
      stream: false
    });

    const url = new URL(this._endpoint());
    const transport = url.protocol === 'http:' ? http : https;
    const timeoutMs = Number(this.config.get('cloud.deepseek.timeoutMs', 30000));
    const started = Date.now();

    const body = await new Promise((resolve, reject) => {
      const req = transport.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + url.search,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: timeoutMs
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch (_) {
              return reject(new Error(`响应解析失败: ${raw.slice(0, 200)}`));
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const msg = parsed?.error?.message || `HTTP ${res.statusCode}`;
              return reject(new Error(`DeepSeek 请求失败: ${msg}`));
            }
            resolve(parsed);
          });
        }
      );
      req.on('timeout', () => { req.destroy(new Error(`请求超时（${timeoutMs}ms）`)); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const content = body?.choices?.[0]?.message?.content?.trim() || '';
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content });
    if (this.history.length > 20) this.history = this.history.slice(-20);

    const result = {
      content,
      usage: body?.usage || null,
      latencyMs: Date.now() - started,
      model: body?.model || this.config.get('cloud.deepseek.model', 'deepseek-chat')
    };
    this.logger.info('llm', `回复 ${content.length} 字 / ${result.latencyMs}ms`);
    return result;
  }
}

module.exports = { DeepSeekClient };
