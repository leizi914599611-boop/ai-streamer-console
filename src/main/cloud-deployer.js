'use strict';

const { EventEmitter } = require('events');

/** AutoDL OpenAPI HOST（鉴权: Authorization: <开发者Token>，均为 POST JSON） */
const API_HOST = 'https://api.autodl.com';

/**
 * GPU 规格：stockNames 对应 /api/v1/dev/machine/region/gpu_stock 返回的前台 GPU 型号名；
 * priceRank 越小越便宜（AutoDL 无价格查询接口，按档位标注）
 */
const GPU_SPECS = {
  '4090D': { label: 'RTX 4090D · 24GB（推理首选）', vramMb: 24576, priceRank: 1, priceLabel: '最低价位', stockNames: ['RTX 4090D'] },
  'v-48g': { label: 'RTX 4090 · 48GB（训练/大模型）', vramMb: 49152, priceRank: 2, priceLabel: '中价位', stockNames: ['vGPU-48GB', 'vGPU-48GB-425W', 'vGPU-48GB-350W'] },
  '5090-p': { label: 'RTX 5090 · 32GB', vramMb: 32768, priceRank: 3, priceLabel: '较高价位', stockNames: ['RTX 5090'] }
};

/** 机房候选：运行时优先从 AutoDL 公共配置接口动态获取，失败时回退该列表 */
const FALLBACK_DATA_CENTERS = [
  { dataCenter: 'chongqingDC1', name: '重庆A区' },
  { dataCenter: 'westDC3', name: '西北B区' },
  { dataCenter: 'beijingDC2', name: '北京B区' },
  { dataCenter: 'neimengDC3', name: '内蒙B区' }
];

/** 公共机房配置（匿名可访问），用于动态获取机房列表 */
const COMMON_API = 'https://www.autodl.com/api/v1/common';


/** 公共基础镜像 cuda11.8 + torch2.0（未保存私有镜像前的首次部署使用） */
const BASE_IMAGE_UUID = 'base-image-l2t43iu6uk';

const HEALTH_POLL_INTERVAL_MS = 15000;
const STATUS_POLL_INTERVAL_MS = 5000;
/** 首次部署需装环境+下权重，健康检查最长等 30 分钟 */
const HEALTH_TIMEOUT_MS = 30 * 60 * 1000;
const STATUS_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AutoDL 云端部署器：创建实例 → 等待服务就绪 → 回写配置；
 * 支持保存私有镜像（二次部署免安装）与释放实例。
 * 事件: progress({ serviceId, step, message, ts })
 */
class CloudDeployer extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.deploying = new Set();
    this.syncing = new Set();
  }

  _apiKey() {
    const key = this.config.get('cloud.autoDL.apiKey', '');
    if (!key) throw new Error('请先在设置页填写 AutoDL 开发者 Token（控制台 → 设置 → 开发者Token）');
    return key;
  }

  /** AutoDL OpenAPI 请求封装；返回 data 字段，业务码非 Success 即抛错 */
  async _request(path, body = {}) {
    const resp = await fetch(`${API_HOST}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': this._apiKey(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`AutoDL 接口返回非 JSON（HTTP ${resp.status}）: ${text.slice(0, 120)}`);
    }
    if (!resp.ok) throw new Error(`AutoDL HTTP ${resp.status}: ${json.msg || text.slice(0, 120)}`);
    if (json.code && json.code !== 'Success') throw new Error(`AutoDL ${json.code}: ${json.msg || '未知错误'}`);
    return json.data;
  }

  _progress(serviceId, step, message) {
    const payload = { serviceId, step, message, ts: Date.now() };
    this.logger.info('cloud', `[${serviceId}] ${step}: ${message}`);
    this.emit('progress', payload);
  }

  /** 部分查询接口（status/snapshot）只接受 GET + query，POST 会 404 */
  async _get(path) {
    const resp = await fetch(`${API_HOST}${path}`, {
      headers: { 'Authorization': this._apiKey() }
    });
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`AutoDL 接口返回非 JSON（HTTP ${resp.status}）: ${text.slice(0, 120)}`);
    }
    if (!resp.ok) throw new Error(`AutoDL HTTP ${resp.status}: ${json.msg || text.slice(0, 120)}`);
    if (json.code && json.code !== 'Success') throw new Error(`AutoDL ${json.code}: ${json.msg || '未知错误'}`);
    return json.data;
  }

  async _status(uuid) {
    const data = await this._get(`/api/v1/dev/instance/pro/status?instance_uuid=${uuid}`);
    return typeof data === 'string' ? data : (data?.status || '');
  }

  async _snapshot(uuid) {
    return await this._get(`/api/v1/dev/instance/pro/snapshot?instance_uuid=${uuid}`);
  }

  /** 账户余额（AutoDL 返回毫，/1000 = 元） */
  async balance() {
    const data = await this._request('/api/v1/dev/wallet/balance');
    const assets = Number(data?.assets ?? 0);
    return { assets, yuan: assets / 1000 };
  }

  /** 已保存的私有镜像列表（空列表时接口返回 list: null） */
  async listImages() {
    const data = await this._request('/api/v1/dev/instance/pro/image/private/list', { page_index: 1, page_size: 50 });
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.list) ? data.list : [];
  }

  /** 机房列表：优先取 AutoDL 公共配置接口（匿名），失败回退内置列表 */
  async dataCenters() {
    try {
      const resp = await fetch(COMMON_API);
      const json = await resp.json();
      const list = (json && json.data && json.data.region_list) || [];
      const seen = new Map();
      for (const r of list) {
        if (!r || !r.data_center || r.visible !== 'all') continue;
        if (!seen.has(r.data_center)) seen.set(r.data_center, { dataCenter: r.data_center, name: r.region_name });
      }
      if (seen.size) return [...seen.values()];
    } catch (err) {
      this.logger.warn('cloud', `机房列表获取失败，使用内置列表: ${err.message}`);
    }
    return FALLBACK_DATA_CENTERS;
  }

  /** 单个机房库存 → { 'RTX 4090D': { idle, total } } */
  async _stockOf(dataCenter) {
    const data = await this._request('/api/v1/dev/machine/region/gpu_stock', {
      region_sign: dataCenter,
      cuda_v_from: 113
    });
    const map = {};
    for (const item of Array.isArray(data) ? data : []) {
      for (const [name, s] of Object.entries(item || {})) {
        map[name] = {
          idle: Number(s.idle_gpu_num || 0),
          total: Number(s.total_gpu_num || 0)
        };
      }
    }
    return map;
  }

  /** 实时库存：各机房 × 各规格（每次创建前都重新拉取，不做缓存） */
  async gpuStock() {
    const centers = await this.dataCenters();
    const matrix = await Promise.all(centers.map(async (c) => {
      try {
        return { ...c, stock: await this._stockOf(c.dataCenter) };
      } catch (err) {
        return { ...c, stock: {}, error: err.message };
      }
    }));
    const specs = Object.entries(GPU_SPECS).map(([id, v]) => {
      let idle = 0;
      let total = 0;
      const available = [];
      for (const c of matrix) {
        const nums = (v.stockNames || []).map((n) => c.stock[n]).filter(Boolean);
        if (!nums.length) continue;
        const ci = nums.reduce((a, b) => a + b.idle, 0);
        const ct = nums.reduce((a, b) => a + b.total, 0);
        idle += ci;
        total += ct;
        if (ci > 0) available.push({ dataCenter: c.dataCenter, name: c.name, idle: ci, total: ct });
      }
      available.sort((a, b) => b.idle - a.idle);
      return { id, label: v.label, vramMb: v.vramMb, priceRank: v.priceRank, priceLabel: v.priceLabel, idle, total, available };
    }).sort((a, b) => a.priceRank - b.priceRank);
    return {
      checkedAt: Date.now(),
      centers: matrix.map((c) => ({ dataCenter: c.dataCenter, name: c.name, error: c.error || '' })),
      specs
    };
  }

  _serviceSpec(serviceId) {
    const spec = (this.config.get('services', []) || []).find((s) => s.id === serviceId);
    if (!spec) throw new Error(`服务不存在: ${serviceId}`);
    return spec;
  }

  _recordInstance(serviceId, record) {
    const instances = { ...(this.config.get('cloud.autoDL.instances', {}) || {}) };
    if (record) instances[serviceId] = record;
    else delete instances[serviceId];
    this.config.set('cloud.autoDL.instances', instances);
  }

  /** 控制台记录的云端实例（含实时状态） */
  async instances() {
    const records = this.config.get('cloud.autoDL.instances', {}) || {};
    const out = [];
    for (const [serviceId, rec] of Object.entries(records)) {
      let status = 'unknown';
      try {
        status = (await this._status(rec.uuid)) || status;
      } catch (err) {
        status = `查询失败: ${err.message}`;
      }
      out.push({ serviceId, ...rec, status });
    }
    return out;
  }

  /** 生成实例开机启动命令；sync=true 时先把 /root/app 更新到 GitHub 最新提交 */
  _bootCommand(serviceId, sync = false) {
    const repoUrl = this.config.get('cloud.autoDL.repoUrl', '');
    if (!repoUrl) throw new Error('请先在设置页 AutoDL 分组填写 GitHub 仓库地址（含 deploy/cloud_bootstrap.sh）');
    const branch = this.config.get('cloud.autoDL.branch', 'main') || 'main';
    const clone = `git clone --depth 1 -b ${branch} ${repoUrl} /root/app`;
    const prepare = sync
      ? 'if [ -d /root/app/.git ]; then '
        + `( git -C /root/app remote set-url origin ${repoUrl} 2>/dev/null || git -C /root/app remote add origin ${repoUrl} 2>/dev/null || true; `
        + `git -C /root/app fetch --depth 1 origin ${branch} && git -C /root/app reset --hard FETCH_HEAD ) `
        + '|| echo "[deploy] 代码同步失败，沿用镜像内版本"; '
        + `else ${clone}; fi;`
      : `([ -d /root/app ] || ${clone});`;
    return [
      'source /etc/network_turbo 2>/dev/null || true;',
      prepare,
      `bash /root/app/deploy/cloud_bootstrap.sh ${serviceId} >> /root/bootstrap_${serviceId}_cmd.log 2>&1`
    ].join(' ');
  }

  /**
   * 一键部署：创建实例 → bootstrap 装环境 → 健康检查 → 回写 endpoint/mode。
   * 若已配置私有镜像（cloud.autoDL.imageUuid）则跳过安装直接起服务。
   */
  async deploy({ serviceId, gpuSpecUuid, dataCenter }) {
    if (this.deploying.has(serviceId)) throw new Error(`${serviceId} 正在部署中，请勿重复点击`);
    this.deploying.add(serviceId);
    try {
      return await this._deploy({ serviceId, gpuSpecUuid, dataCenter });
    } finally {
      this.deploying.delete(serviceId);
    }
  }

  async _deploy({ serviceId, gpuSpecUuid, dataCenter }) {
    const spec = this._serviceSpec(serviceId);
    const gpu = gpuSpecUuid || this.config.get('cloud.autoDL.gpuSpec', '4090D');
    if (!GPU_SPECS[gpu]) throw new Error(`未知 GPU 规格: ${gpu}`);
    const imageUuid = this.config.get('cloud.autoDL.imageUuid', '');
    /** 仅在用户显式指定时才锁定机房；默认空 → 每次创建前实时检测 */
    const preferred = dataCenter || this.config.get('cloud.autoDL.dataCenter', '') || '';

    // 不预设机房：每次创建前实时检测各机房库存，选有卡且空闲最多的一处
    this._progress(serviceId, 'stock', '检测各机房实时库存…');
    const stock = await this.gpuStock();
    const target = stock.specs.find((s) => s.id === gpu);
    const summary = target && target.available.length
      ? target.available.map((a) => `${a.name} ${a.idle} 张`).join('、')
      : '各机房均为 0';
    let chosen = null;
    if (preferred) {
      chosen = (target && target.available.find((a) => a.dataCenter === preferred)) || null;
      if (!chosen) throw new Error(`${preferred} 当前没有 ${GPU_SPECS[gpu].label} 空闲卡（${summary}）`);
    } else {
      chosen = (target && target.available[0]) || null;
    }
    if (!chosen) {
      throw new Error(`各机房均无 ${GPU_SPECS[gpu].label} 空闲卡，请稍后再试（已检测：${summary}）`);
    }
    this._progress(serviceId, 'stock', `${chosen.name} 空闲 ${chosen.idle}/${chosen.total} 张（AutoDL 按库存自动调度机房）`);

    // start_command：仓库不在则克隆，然后执行仓库内自举脚本（幂等）
    const startCommand = this._bootCommand(serviceId);

    // 注意：AutoDL 新版 OpenAPI 不接受 data_center_list（传了会 RequestParameterIsWrong），
    // 调度由平台按实时库存自动完成；上面已提前探测库存用于失败前预警。
    this._progress(serviceId, 'create', `创建实例（${GPU_SPECS[gpu].label}${imageUuid ? ' · 私有镜像' : ' · 基础镜像'}）`);
    const created = await this._request('/api/v1/dev/instance/pro/create', {
      req_gpu_amount: 1,
      expand_system_disk_by_gb: 0,
      gpu_spec_uuid: gpu,
      image_uuid: imageUuid || BASE_IMAGE_UUID,
      cuda_v_from: 113,
      instance_name: `ai-singer-${serviceId}`,
      start_command: startCommand
    });
    const uuid = typeof created === 'string' ? created : (created?.instance_uuid || created?.uuid);
    if (!uuid) throw new Error(`创建实例未返回 ID: ${JSON.stringify(created).slice(0, 200)}`);
    this._recordInstance(serviceId, { uuid, gpuSpecUuid: gpu, createdAt: Date.now() });
    this._progress(serviceId, 'create', `实例已创建: ${uuid}`);

    // 等待实例 running
    this._progress(serviceId, 'status', '等待实例开机…');
    const statusDeadline = Date.now() + STATUS_TIMEOUT_MS;
    let status = '';
    while (Date.now() < statusDeadline) {
      status = await this._status(uuid);
      if (status === 'running') break;
      if (['shutdown', 'released', 'error'].includes(status)) throw new Error(`实例进入异常状态: ${status}`);
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    if (status !== 'running') throw new Error(`等待实例 running 超时（当前: ${status || 'unknown'}）`);
    this._progress(serviceId, 'status', '实例已开机');

    // 取 6006 端口公网反代域名
    this._progress(serviceId, 'endpoint', '获取公网访问域名…');
    let domain = '';
    const snapDeadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < snapDeadline && !domain) {
      const snap = await this._snapshot(uuid);
      domain = snap?.service_6006_domain || '';
      if (!domain) await sleep(STATUS_POLL_INTERVAL_MS);
    }
    if (!domain) throw new Error('未获取到 6006 端口公网域名');
    const endpoint = domain.startsWith('http') ? domain : `https://${domain}`;
    this._progress(serviceId, 'endpoint', `公网入口: ${endpoint}`);

    // 健康检查（首次部署需装环境，耐心等待）
    const healthPath = spec.healthPath || '/';
    this._progress(serviceId, 'health', imageUuid
      ? '等待服务就绪（镜像模式，约 1-3 分钟）…'
      : '等待服务就绪（首次部署需安装环境+下载权重，可能 10-25 分钟）…');
    const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    const startedAt = Date.now();
    let ready = false;
    let lastErr = '';
    while (Date.now() < healthDeadline && !ready) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const resp = await fetch(`${endpoint}${healthPath}`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) ready = true;
        else lastErr = `HTTP ${resp.status}`;
      } catch (err) {
        lastErr = err.name === 'AbortError' ? '连接超时' : err.message;
      }
      if (!ready) {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        this._progress(serviceId, 'health', `服务尚未就绪（${elapsed}s，${lastErr || '等待中'}）…`);
        await sleep(HEALTH_POLL_INTERVAL_MS);
      }
    }
    if (!ready) throw new Error(`健康检查超时（30 分钟）: ${endpoint}${healthPath} ${lastErr}`);

    // 回写配置：endpoint + mode=cloud + 显存并入能力矩阵
    this.config.setService(serviceId, {
      mode: 'cloud',
      cloud: { ...(spec.cloud || {}), endpoint }
    });
    this.config.set('cloud.autoDL.vramMb', GPU_SPECS[gpu].vramMb);
    const totalSec = Math.floor((Date.now() - startedAt) / 1000);
    this._progress(serviceId, 'done', `部署完成 ✔ ${endpoint}（${chosen.name} · 服务就绪耗时 ${totalSec}s）`);
    return { uuid, endpoint, dataCenter: chosen.dataCenter, elapsedSec: totalSec };
  }

  /** 保存当前实例为私有镜像，写入 cloud.autoDL.imageUuid（之后部署免安装） */
  async saveImage({ serviceId, imageName }) {
    const records = this.config.get('cloud.autoDL.instances', {}) || {};
    const rec = records[serviceId];
    if (!rec) throw new Error(`服务 ${serviceId} 没有已部署的实例记录`);
    const name = imageName || `ai-singer-${serviceId}-${new Date().toISOString().slice(0, 10)}`;
    this._progress(serviceId, 'image', `保存私有镜像 ${name}（需数分钟）…`);
    const data = await this._request('/api/v1/dev/instance/pro/image/save', {
      instance_uuid: rec.uuid,
      image_name: name
    });
    const imageUuid = data?.image_uuid || (typeof data === 'string' ? data : '');
    if (imageUuid) {
      this.config.set('cloud.autoDL.imageUuid', imageUuid);
      this._progress(serviceId, 'image', `镜像已保存: ${imageUuid}，后续部署将直接使用`);
    } else {
      this._progress(serviceId, 'image', '镜像保存任务已提交，镜像 ID 请在 AutoDL 控制台确认后填入设置');
    }
    return { imageUuid, imageName: name };
  }

  /** 命令触发：重启实例并把 /root/app 同步到 GitHub 最新提交（AutoDL 只能在开机时下发命令） */
  async syncRepo({ serviceId }) {
    if (this.syncing.has(serviceId)) throw new Error(`${serviceId} 正在同步中，请勿重复点击`);
    this.syncing.add(serviceId);
    try {
      return await this._syncRepo({ serviceId });
    } finally {
      this.syncing.delete(serviceId);
    }
  }

  async _syncRepo({ serviceId }) {
    const rec = (this.config.get('cloud.autoDL.instances', {}) || {})[serviceId];
    if (!rec || !rec.uuid) throw new Error(`服务 ${serviceId} 没有已部署的实例记录`);
    const uuid = rec.uuid;
    const spec = this._serviceSpec(serviceId);
    const startCommand = this._bootCommand(serviceId, true);

    let status = '';
    try {
      status = await this._status(uuid);
    } catch (err) {
      throw new Error(`查询实例状态失败: ${err.message}`);
    }
    if (['released', 'releasing'].includes(status)) throw new Error(`实例已释放（${status}），请重新部署`);

    if (status === 'running') {
      this._progress(serviceId, 'sync', '关机以重载启动命令…');
      await this._request('/api/v1/dev/instance/pro/power_off', { instance_uuid: uuid });
      const offDeadline = Date.now() + STATUS_TIMEOUT_MS;
      while (Date.now() < offDeadline) {
        status = await this._status(uuid);
        if (status === 'shutdown') break;
        await sleep(STATUS_POLL_INTERVAL_MS);
      }
      if (status !== 'shutdown') throw new Error(`等待关机超时（当前: ${status || 'unknown'}）`);
      this._progress(serviceId, 'sync', '实例已关机');
    }

    this._progress(serviceId, 'sync', '开机并同步 GitHub 最新代码…');
    await this._request('/api/v1/dev/instance/pro/power_on', {
      instance_uuid: uuid,
      payload: 'gpu',
      start_command: startCommand
    });

    const runDeadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < runDeadline) {
      status = await this._status(uuid);
      if (status === 'running') break;
      if (['released', 'error'].includes(status)) throw new Error(`实例进入异常状态: ${status}`);
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    if (status !== 'running') throw new Error(`等待实例 running 超时（当前: ${status || 'unknown'}）`);
    this._progress(serviceId, 'sync', '实例已开机，等待服务重新就绪…');

    // 刷新 6006 公网域名（同一实例通常不变，变了就回写配置）
    let endpoint = '';
    const snapDeadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < snapDeadline && !endpoint) {
      const snap = await this._snapshot(uuid);
      const domain = snap?.service_6006_domain || '';
      if (domain) endpoint = domain.startsWith('http') ? domain : `https://${domain}`;
      else await sleep(STATUS_POLL_INTERVAL_MS);
    }
    if (!endpoint) endpoint = (spec.cloud && spec.cloud.endpoint) || '';
    if (!endpoint) {
      this._progress(serviceId, 'sync', '代码已同步并重启（未拿到入口域名，请重新部署）');
      return { uuid, synced: true, endpoint: '' };
    }

    // 等服务重启就绪（依赖清单有变化时会先 pip install）
    const healthPath = spec.healthPath || '/';
    const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    const startedAt = Date.now();
    let ready = false;
    let lastErr = '';
    while (Date.now() < healthDeadline && !ready) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const resp = await fetch(`${endpoint}${healthPath}`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) ready = true;
        else lastErr = `HTTP ${resp.status}`;
      } catch (err) {
        lastErr = err.name === 'AbortError' ? '连接超时' : err.message;
      }
      if (!ready) {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        this._progress(serviceId, 'sync', `服务尚未就绪（${elapsed}s，${lastErr || '等待中'}）…`);
        await sleep(HEALTH_POLL_INTERVAL_MS);
      }
    }
    if (!ready) throw new Error(`同步后服务未就绪（30 分钟）: ${endpoint}${healthPath} ${lastErr}`);

    this.config.setService(serviceId, { cloud: { ...(spec.cloud || {}), endpoint } });
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    this._progress(serviceId, 'sync', `代码已同步并重启完成 ✔（就绪耗时 ${elapsedSec}s）`);
    return { uuid, synced: true, endpoint, elapsedSec };
  }

  /** 释放实例：先关机再释放，回写服务为本地模式 */
  async release({ serviceId }) {
    const records = this.config.get('cloud.autoDL.instances', {}) || {};
    const rec = records[serviceId];
    if (!rec) throw new Error(`服务 ${serviceId} 没有已部署的实例记录`);
    this._progress(serviceId, 'release', `释放实例 ${rec.uuid}…`);
    try {
      await this._request('/api/v1/dev/instance/pro/power_off', { instance_uuid: rec.uuid });
    } catch (err) {
      this.logger.warn('cloud', `关机失败（可能已关机）: ${err.message}`);
    }
    await this._request('/api/v1/dev/instance/pro/release', { instance_uuid: rec.uuid });
    this._recordInstance(serviceId, null);
    const spec = this._serviceSpec(serviceId);
    this.config.setService(serviceId, { mode: 'local', cloud: { ...(spec.cloud || {}), endpoint: '' } });
    this._progress(serviceId, 'release', '实例已释放，服务已切回本地模式');
    return { released: true };
  }
}

module.exports = { CloudDeployer, GPU_SPECS };
