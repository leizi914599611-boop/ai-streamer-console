'use strict';

const fs = require('fs');
const path = require('path');

const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a']);

/**
 * AI 歌手音色库：管理「音色参考音频 + 标注 JSON」配对。
 * 内置来源为 SoulX 仓库 example/audio，用户样本存放于 data/voices。
 */
class VoiceLibrary {
  constructor({ config, logger, soulx }) {
    this.config = config;
    this.logger = logger;
    this.soulx = soulx;
  }

  _roots() {
    return [
      { dir: this.config.resolvePath(this.config.get('soulx.voiceDir', 'data/voices')), source: 'user' },
      { dir: this.config.resolvePath(path.join(this.config.get('soulx.repoDir', ''), 'example', 'audio')), source: 'builtin' }
    ].filter((r) => r.dir && fs.existsSync(r.dir));
  }

  list() {
    const items = [];
    const seen = new Set();
    for (const root of this._roots()) {
      let names = [];
      try { names = fs.readdirSync(root.dir); } catch (_) { continue; }
      for (const name of names) {
        const ext = path.extname(name).toLowerCase();
        if (!AUDIO_EXT.has(ext)) continue;
        const base = path.basename(name, ext);
        const audioPath = path.join(root.dir, name);
        const metaPath = path.join(root.dir, `${base}.json`);
        if (!fs.existsSync(metaPath) || seen.has(audioPath)) continue;
        seen.add(audioPath);
        let segments = 0;
        try { segments = JSON.parse(fs.readFileSync(metaPath, 'utf8')).length; } catch (_) { /* ignore */ }
        items.push({
          id: Buffer.from(audioPath).toString('base64url'),
          name: base,
          audioPath,
          metaPath,
          source: root.source,
          segments,
          size: this._size(audioPath)
        });
      }
    }
    const current = this.current();
    return items.map((item) => ({ ...item, isDefault: Boolean(current && current.audioPath === item.audioPath) }));
  }

  current() {
    const wav = this.config.resolvePath(this.config.get('soulx.promptWav', ''));
    const meta = this.config.resolvePath(this.config.get('soulx.promptMeta', ''));
    return { audioPath: wav, metaPath: meta, name: wav ? path.basename(wav, path.extname(wav)) : '' };
  }

  _find(id) {
    return this.list().find((item) => item.id === id) || null;
  }

  setDefault(id) {
    const item = this._find(id);
    if (!item) throw new Error('音色不存在');
    this.config.set('soulx.promptWav', item.audioPath);
    this.config.set('soulx.promptMeta', item.metaPath);
    this.logger.info('voice', `默认音色切换为 ${item.name}（${item.source}）`);
    return { ...item, isDefault: true };
  }

  /** 导入外部音色样本到 data/voices；若同目录已存在同名 JSON 则一并带入 */
  import(audioPath) {
    if (!audioPath || !fs.existsSync(audioPath)) throw new Error(`文件不存在: ${audioPath}`);
    const ext = path.extname(audioPath);
    if (!AUDIO_EXT.has(ext.toLowerCase())) throw new Error('仅支持 wav / mp3 / flac / m4a');
    const dir = this.config.resolvePath(this.config.get('soulx.voiceDir', 'data/voices'));
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(audioPath, ext);
    const target = path.join(dir, `${base}${ext}`);
    fs.copyFileSync(audioPath, target);
    const siblingMeta = audioPath.replace(new RegExp(`${ext}$`), '.json');
    const targetMeta = path.join(dir, `${base}.json`);
    let annotated = false;
    if (fs.existsSync(siblingMeta)) {
      fs.copyFileSync(siblingMeta, targetMeta);
      annotated = true;
    }
    return { audioPath: target, metaPath: annotated ? targetMeta : null, name: base, needsAnnotation: !annotated };
  }

  /** 对未标注的样本跑一次 SoulX 预处理，生成 metadata.json */
  async annotate(audioPath, onProgress) {
    if (!this.soulx) throw new Error('SoulX 适配器未初始化');
    const result = await this.soulx.annotateVoice({ audioPath, onProgress });
    return result;
  }

  remove(id) {
    const item = this._find(id);
    if (!item) throw new Error('音色不存在');
    if (item.source !== 'user') throw new Error('内置音色不可删除');
    for (const file of [item.audioPath, item.metaPath]) {
      try { fs.rmSync(file, { force: true }); } catch (_) { /* ignore */ }
    }
    return true;
  }

  _size(file) {
    try { return fs.statSync(file).size; } catch (_) { return 0; }
  }
}

module.exports = { VoiceLibrary };
