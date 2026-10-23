'use strict';

const { EventEmitter } = require('events');

/** AutoDL OpenAPI HOST（鉴权: Authorization: <开发者Token>，均为 POST JSON） */
const API_HOST = 'https://api.autodl.com';

/** GPU 规格 → 显存（用于能力矩阵合并） */
const GPU_SPECS = {
  '4090D': { label: 'RTX 4090D · 24GB（推理首选）', vramMb: 24576 },
  'v-48g': { label: 'RTX 4090 · 48GB（训练/大模型）', vramMb: 49152 },
  '5090-p': { label: 'RTX 5090 · 32GB', vramMb: 32768 }
};

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

  /** 账户余额（AutoDL 返回毫，/1000 = 元） */
  async balance() {
    const data = await this._request('/api/v1/dev/wallet/balance');
    const assets = Number(data?.assets ?? 0);
    return { assets, yuan: assets / 1000 };
  }

  /** 已保存的私有镜像列表 */
  async listImages() {
    const data = await this._request('/api/v1/dev/instance/pro/image/private/list', { page_index: 1, page_size: 50 });
    return data?.list || data || [];
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
        const data = await this._request('/api/v1/dev/instance/pro/status', { instance_uuid: rec.uuid });
        status = data?.status || status;
      } catch (err) {
        status = `查询失败: ${err.message}`;
      }
      out.push({ serviceId, ...rec, status });
    }
    return out;
  }

  /**
   * 一键部署：创建实例 → bootstrap 装环境 → 健康检查 → 回写 endpoint/mode。
   * 若已配置私有镜像（cloud.autoDL.imageUuid）则跳过安装直接起服务。
   */
  async deploy({ serviceId, gpuSpecUuid }) {
    if (this.deploying.has(serviceId)) throw new Error(`${serviceId} 正在部署中，请勿重复点击`);
    this.deploying.add(serviceId);
    try {
      return await this._deploy({ serviceId, gpuSpecUuid });
    } finally {
      this.deploying.delete(serviceId);
    }
  }

  async _deploy({ serviceId, gpuSpecUuid }) {
    const spec = this._serviceSpec(serviceId);
    const repoUrl = this.config.get('cloud.autoDL.repoUrl', '');
    if (!repoUrl) throw new Error('请先在设置页 AutoDL 分组填写 GitHub 仓库地址（含 deploy/cloud_bootstrap.sh）');
    const branch = this.config.get('cloud.autoDL.branch', 'main') || 'main';
    const dataCenter = this.config.get('cloud.autoDL.dataCenter', 'westDC3') || 'westDC3';
    const gpu = gpuSpecUuid || this.config.get('cloud.autoDL.gpuSpec', '4090D');
    if (!GPU_SPECS[gpu]) throw new Error(`未知 GPU 规格: ${gpu}`);
    const imageUuid = this.config.get('cloud.autoDL.imageUuid', '');

    // 私有镜像二次启动也跟随 GitHub 仓库更新（可用 cloud.autoDL.syncOnStart 关闭）
    const syncOnStart = this.config.get('cloud.autoDL.syncOnStart', true) !== false;
    const appSync = syncOnStart
      ? [
          'if [ -d /root/app/.git ]; then',
          `( git -C /root/app remote set-url origin ${repoUrl} 2>/dev/null || git -C /root/app remote add origin ${repoUrl} 2>/dev/null || true;`,
          `git -C /root/app fetch --depth 1 origin ${branch} && git -C /root/app reset --hard FETCH_HEAD )`,
          '|| echo "[deploy] 代码同步失败，沿用镜像内版本";',
          `else git clone --depth 1 -b ${branch} ${repoUrl} /root/app; fi;`
        ].join(' ')
      : `([ -d /root/app ] || git clone --depth 1 -b ${branch} ${repoUrl} /root/app);`;

    // start_command：同步仓库（无则克隆）后执行仓库内自举脚本（幂等）
    const startCommand = [
      'source /etc/network_turbo 2>/dev/null || true;',
      appSync,
      `bash /root/app/deploy/cloud_bootstrap.sh ${serviceId} >> /root/bootstrap_${serviceId}_cmd.log 2>&1`
    ].join(' ');

    this._progress(serviceId, 'create', `创建实例（${GPU_SPECS[gpu].label}${imageUuid ? ' · 私有镜像' : ' · 基础镜像'}）`);
    const created = await this._request('/api/v1/dev/instance/pro/create', {
      data_center_list: [dataCenter],
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
      const data = await this._request('/api/v1/dev/instance/pro/status', { instance_uuid: uuid });
      status = data?.status || '';
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
      const snap = await this._request('/api/v1/dev/instance/pro/snapshot', { instance_uuid: uuid });
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
    this._progress(serviceId, 'done', `部署完成 ✔ ${endpoint}（服务就绪耗时 ${totalSec}s）`);
    return { uuid, endpoint, elapsedSec: totalSec };
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
