'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * edge-tts 语音合成适配器：调用本地 Python 环境里的 edge_tts 模块。
 */
class EdgeTtsAdapter {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  _python() {
    return this.config.resolvePath(this.config.get('cloud.tts.pythonPath', ''));
  }

  async check() {
    const python = this._python();
    if (!python || !fs.existsSync(python)) {
      return { ok: false, detail: `Python 不存在: ${python || '(未配置)'}` };
    }
    const result = await this._run([python, '-c', 'import edge_tts;print(edge_tts.__version__)'], 15000);
    if (result.code !== 0) {
      return { ok: false, detail: (result.stderr || result.stdout || '未安装 edge-tts').trim().split('\n')[0] };
    }
    return { ok: true, detail: `edge-tts ${result.stdout.trim()} @ ${python}` };
  }

  _run(args, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const child = spawn(args[0], args.slice(1), { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: -1, stdout, stderr: stderr + '\n(超时)' });
      }, timeoutMs);
      child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async synthesize({ text, voice, rate } = {}) {
    if (!text || !text.trim()) throw new Error('待合成文本为空');
    const python = this._python();
    if (!python || !fs.existsSync(python)) throw new Error(`Python 不存在: ${python || '(未配置)'}`);

    const outDir = this.config.resolvePath(this.config.get('cloud.tts.outputDir', 'data/audio'));
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `tts-${Date.now()}.mp3`);

    const args = [
      python, '-m', 'edge_tts',
      '--voice', voice || this.config.get('cloud.tts.voice', 'zh-CN-XiaoxiaoNeural'),
      '--rate', rate || this.config.get('cloud.tts.rate', '+0%'),
      '--volume', this.config.get('cloud.tts.volume', '+0%'),
      '--text', text,
      '--write-media', outFile
    ];

    const started = Date.now();
    const result = await this._run(args, 90000);
    if (result.code !== 0 || !fs.existsSync(outFile)) {
      throw new Error(`edge-tts 合成失败: ${(result.stderr || result.stdout || 'unknown').trim().split('\n').slice(-2).join(' ')}`);
    }
    const latencyMs = Date.now() - started;
    this.logger.info('tts', `合成完成 ${path.basename(outFile)} (${latencyMs}ms)`);
    return { file: outFile, latencyMs, voice: voice || this.config.get('cloud.tts.voice') };
  }
}

module.exports = { EdgeTtsAdapter };
