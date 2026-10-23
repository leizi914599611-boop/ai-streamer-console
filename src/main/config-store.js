'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * 配置存储：config/default.json 为基线，data/config.json 为用户覆盖。
 */
class ConfigStore extends EventEmitter {
  constructor({ appDir, logger }) {
    super();
    this.appDir = appDir;
    this.logger = logger;
    this.defaultFile = path.join(appDir, 'config', 'default.json');
    this.userFile = path.join(appDir, 'data', 'config.json');
    this.defaults = JSON.parse(fs.readFileSync(this.defaultFile, 'utf8'));
    this.user = this._readUser();
    this.data = deepMerge(this.defaults, this.user);
  }

  _readUser() {
    try {
      if (!fs.existsSync(this.userFile)) return {};
      return JSON.parse(fs.readFileSync(this.userFile, 'utf8'));
    } catch (err) {
      this.logger.warn('config', `用户配置读取失败，回退默认值: ${err.message}`);
      return {};
    }
  }

  get(pathExpr, fallback) {
    if (!pathExpr) return this.data;
    const parts = String(pathExpr).split('.');
    let cur = this.data;
    for (const part of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
      cur = cur[part];
    }
    return cur === undefined ? fallback : cur;
  }

  set(pathExpr, value) {
    const parts = String(pathExpr).split('.');
    let cur = this.user;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    this.data = deepMerge(this.defaults, this.user);
    this.save();
    this.emit('change', pathExpr, value);
  }

  save() {
    fs.mkdirSync(path.dirname(this.userFile), { recursive: true });
    fs.writeFileSync(this.userFile, JSON.stringify(this.user, null, 2), 'utf8');
  }

  /** 按 id 修改 services 数组中的单个服务（数组整体写入用户配置，避免 deepMerge 覆盖丢项） */
  setService(id, patch) {
    const list = (this.data.services || []).map((spec) => ({ ...spec }));
    const index = list.findIndex((spec) => spec.id === id);
    if (index < 0) throw new Error(`服务不存在: ${id}`);
    list[index] = { ...list[index], ...patch };
    // 端口同时体现在 spec.port 与启动参数 --port 中，避免两处不一致
    if (patch.port !== undefined) {
      const args = Array.isArray(list[index].args) ? list[index].args.slice() : [];
      const flag = args.indexOf('--port');
      if (flag >= 0 && flag + 1 < args.length) args[flag + 1] = String(patch.port);
      list[index].args = args;
    }
    this.user.services = list;
    this.data = deepMerge(this.defaults, this.user);
    this.save();
    this.emit('change', `services.${id}`, patch);
  }

  /** 返回给渲染进程的可展示配置（脱敏 API Key 之外全部可见） */
  publicView() {
    return {
      ...this.data,
      cloud: {
        ...this.data.cloud,
        deepseek: {
          ...this.data.cloud.deepseek,
          apiKey: this.data.cloud.deepseek.apiKey ? '******' + this.data.cloud.deepseek.apiKey.slice(-4) : ''
        }
      },
      _meta: {
        defaultFile: this.defaultFile,
        userFile: this.userFile
      }
    };
  }

  resolvePath(p) {
    if (!p) return p;
    return path.isAbsolute(p) ? p : path.join(this.appDir, p);
  }
}

module.exports = { ConfigStore, deepMerge };
