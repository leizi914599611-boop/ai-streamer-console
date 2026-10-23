'use strict';

const fs = require('fs');
const path = require('path');

const KIND_BY_EXT = {
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video',
  '.wav': 'audio', '.mp3': 'audio', '.flac': 'audio', '.m4a': 'audio'
};

/**
 * 素材 / 曲目库：扫描配置中的目录，列出可播出与可渲染的素材。
 */
class AssetLibrary {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  roots() {
    return (this.config.get('library.roots', []) || []).map((root) => {
      const abs = this.config.resolvePath(root);
      return { root, abs, exists: fs.existsSync(abs) };
    });
  }

  addRoot(root) {
    const roots = this.config.get('library.roots', []);
    if (!roots.includes(root)) {
      this.config.set('library.roots', [...roots, root]);
    }
    return this.roots();
  }

  list() {
    const exts = new Set((this.config.get('library.extensions', []) || []).map((e) => e.toLowerCase()));
    const items = [];
    for (const { abs, exists } of this.roots()) {
      if (!exists) continue;
      const walk = (dir, depth) => {
        if (depth > 3) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
            continue;
          }
          const ext = path.extname(entry.name).toLowerCase();
          if (!exts.has(ext)) continue;
          let stat;
          try {
            stat = fs.statSync(full);
          } catch (_) {
            continue;
          }
          items.push({
            name: entry.name,
            base: path.basename(entry.name, ext),
            path: full,
            ext,
            kind: KIND_BY_EXT[ext] || 'other',
            size: stat.size,
            mtime: stat.mtimeMs,
            folder: path.basename(path.dirname(full))
          });
        }
      };
      walk(abs, 0);
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return {
      roots: this.roots(),
      extensions: Array.from(exts),
      items,
      counts: {
        video: items.filter((i) => i.kind === 'video').length,
        audio: items.filter((i) => i.kind === 'audio').length,
        totalBytes: items.reduce((sum, i) => sum + i.size, 0)
      }
    };
  }
}

module.exports = { AssetLibrary };
