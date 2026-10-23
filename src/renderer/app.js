'use strict';

/* global consoleApi */
const api = window.consoleApi;

const state = {
  config: null,
  services: [],
  orch: null,
  queue: [],
  stream: null,
  library: null,
  logs: [],
  logLevel: 'all',
  llm: { configured: false },
  app: null,
  system: null,
  schema: null,
  voices: [],
  capabilities: null,
  probes: {},
  busy: {},
  cloud: { progress: [] },
  downloads: [],
  cloudStats: { balance: null, instances: [], error: '', updatedAt: 0 }
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec) {
  if (!sec || sec < 0) return '0s';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m${s ? ' ' + s + 's' : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtClock(ms)}`;
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('toast-stack').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s ease';
    setTimeout(() => node.remove(), 260);
  }, 3600);
}

async function call(promise, label) {
  const res = await promise;
  if (!res || !res.ok) {
    const msg = (res && res.error) || '未知错误';
    toast(`${label}: ${msg}`, 'error');
    throw new Error(msg);
  }
  return res.data;
}

function asFileUrl(p) {
  if (!p) return '';
  return encodeURI('file:///' + String(p).replace(/\\/g, '/'));
}

/* ================= 导航 ================= */
function bindNav() {
  $('nav').addEventListener('click', (event) => {
    const btn = event.target.closest('.nav-item');
    if (!btn) return;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
    if (btn.dataset.view === 'library') refreshLibrary();
    if (btn.dataset.view === 'queue') refreshQueue();
    if (btn.dataset.view === 'models') { refreshVoices(); refreshCapabilities(); }
    if (btn.dataset.view === 'overview' && Date.now() - state.cloudStats.updatedAt > 30000) refreshCloudOverview();
  });

  $('log-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.log-tab');
    if (!tab) return;
    state.logLevel = tab.dataset.level;
    document.querySelectorAll('.log-tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderLogs();
  });

  $('btn-log-toggle').addEventListener('click', () => {
    const bar = $('logbar');
    bar.classList.toggle('collapsed');
    $('btn-log-toggle').textContent = bar.classList.contains('collapsed') ? '展开' : '收起';
  });

  $('btn-log-clear').addEventListener('click', () => {
    state.logs = [];
    renderLogs();
  });
}

/* ================= 状态机 / 顶栏 ================= */
function renderOrchestrator() {
  const o = state.orch;
  if (!o) return;
  $('state-pill').dataset.state = o.state;
  $('state-label').textContent = o.label;
  $('state-uptime').textContent = fmtDuration(o.uptimeSec);
  $('state-title').textContent = o.label;
  $('state-hint').textContent = o.hint;
  $('state-reason').textContent = o.reason || '-';
  $('kpi-state').textContent = o.label;
  $('kpi-state-sub').textContent = o.currentSong ? `曲目: ${o.currentSong}` : o.hint;

  document.querySelectorAll('.rail-node').forEach((node) => {
    node.classList.toggle('active', node.dataset.state === o.state);
  });
  document.querySelectorAll('.state-actions .btn').forEach((btn) => {
    const allowed = btn.dataset.goto === o.state || (o.allowed || []).includes(btn.dataset.goto);
    btn.disabled = !allowed;
    btn.style.opacity = allowed ? '1' : '.35';
  });

  $('state-history').innerHTML = (o.history || []).slice(-6).reverse()
    .map((h) => `<span>${fmtClock(h.at)} ${esc(h.reason || '')}</span>`).join('')
    || '<span>暂无切换记录</span>';

  const liveBtn = $('live-toggle');
  liveBtn.classList.toggle('on', Boolean(o.live));
  $('live-text').textContent = o.live ? '直播中' : '未开播';

  const running = state.services.filter((s) => s.status === 'running').length;
  $('badge-services').textContent = `服务 ${running}/${state.services.length}`;
  $('badge-stream').textContent = `推流 ${streamLabel(state.stream && state.stream.status)}`;
}

function streamLabel(status) {
  return { offline: '离线', starting: '连接中', live: '直播中', stopping: '停止中', error: '异常' }[status] || '离线';
}

function renderKpis() {
  const running = state.services.filter((s) => s.status === 'running').length;
  $('kpi-services').textContent = `${running} / ${state.services.length}`;
  const starting = state.services.filter((s) => s.status === 'starting').length;
  $('kpi-services-sub').textContent = starting ? `${starting} 个启动中` : (running ? '本地推理就绪' : '全部停止');

  const active = state.queue.filter((j) => j.status === 'queued' || j.status === 'running');
  $('kpi-queue').textContent = String(active.length);
  const runningJob = state.queue.find((j) => j.status === 'running');
  $('kpi-queue-sub').textContent = runningJob ? `执行中: ${runningJob.title}` : (active.length ? '等待执行' : '无排队任务');

  $('kpi-stream').textContent = streamLabel(state.stream && state.stream.status);
  $('kpi-stream-sub').textContent = state.stream && state.stream.stats && state.stream.stats.bitrate
    ? `${state.stream.stats.fps} fps · ${state.stream.stats.bitrate}`
    : '未建立连接';

  $('mini-services').textContent = `${running}/${state.services.length}`;
  $('mini-llm').textContent = state.llm.configured ? '已配置' : '未配置';
  $('mini-llm').style.color = state.llm.configured ? 'var(--success)' : 'var(--muted)';
}

/* ================= 服务 ================= */
function healthOf(id) {
  // 手动「检测」的结果优先，直到下一次启停操作或再次检测
  if (state.probes && state.probes[id]) return state.probes[id];
  return (state.system && state.system.services && state.system.services[id]) || null;
}

/** 把 /health 结构化字段翻译成可读徽标 */
function healthBadges(svc) {
  const h = healthOf(svc.id);
  if (!h) return '';
  const badges = [];
  const add = (text, kind) => badges.push(`<span class="service-badge ${kind || ''}">${esc(text)}</span>`);
  // 部署方式标签
  const isCloud = svc.mode === 'cloud';
  const latency = h.latencyMs !== undefined ? `<span class="service-badge deploy-lat">${h.latencyMs}ms</span>` : '';
  const deployTag = isCloud
    ? `<span class="service-badge deploy-tag cloud">云端</span>`
    : `<span class="service-badge deploy-tag local">本地</span>`;
  if (h.skipped) {
    return `<div class="service-health">${deployTag}<span class="service-badge">未运行</span></div>`;
  }
  if (!h.reachable) {
    const cloudHint = isCloud && h.cloudConnected === false ? '云端未连接' : null;
    add(cloudHint ? `${cloudHint} · ${h.detail}` : `不可达 · ${h.detail || '无响应'}`, 'bad');
    return `<div class="service-health">${deployTag}${latency}${badges.join('')}</div>`;
  }
  if (isCloud && h.cloudConnected) add('云端已连接', 'ok');
  if (h.httpStatus && h.httpStatus !== 200) add(`HTTP ${h.httpStatus}`, 'warn');
  if (h.gpuLocked) add('GPU 被占用', 'warn');
  if (h.busy) add('推理中', 'warn');
  if (h.modelLoaded) add('模型已加载', 'ok');
  if (h.avatarReady) add(`形象 ${h.avatarId || ''}`, 'ok');
  if (h.sttReady) add(h.sttModel ? `识别 ${h.sttModel}` : '识别就绪', 'ok');
  if (h.device) add(h.device, '');
  if (h.lastError) add(String(h.lastError).slice(0, 40), 'bad');
  return `<div class="service-health">${deployTag}${latency}${badges.join('')}</div>`;
}

function renderServices() {
  if (!state.services.length) {
    $('service-grid').innerHTML = '<div class="panel muted">未配置任何服务</div>';
    return;
  }
  $('service-grid').innerHTML = state.services.map((svc) => {
    const running = svc.status === 'running';
    const busy = svc.status === 'starting' || svc.status === 'stopping';
    const labelMap = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常' };
    const isCloud = svc.mode === 'cloud';
    const cloudNoEndpoint = isCloud && !svc.endpoint;
    const dl = (state.downloads || []).find((d) => d.serviceId === svc.id);
    const dlMissing = !isCloud && dl && dl.state !== 'installed';
    const dlRunning = dlMissing && dl.state === 'running';
    const startDisabled = (running || busy) || (isCloud && cloudNoEndpoint) || dlMissing;
    const stopDisabled = (isCloud || (!running && svc.status !== 'starting'));
    const openDisabled = cloudNoEndpoint;
    return `
      <div class="service-card" data-id="${esc(svc.id)}">
        <div class="service-top">
          <div>
            <div class="service-name">${esc(svc.name)} <span class="deploy-chip ${isCloud ? 'cloud' : 'local'}">${isCloud ? '云端' : '本地'}</span></div>
            <div class="service-role">${svc.role === 'interact' ? '实时互动链路' : '离线渲染链路'}</div>
          </div>
          <div class="service-state" data-status="${esc(svc.status)}">
            <span class="dot"></span><span>${labelMap[svc.status] || svc.status}</span>
          </div>
        </div>
        <div class="service-meta">
          ${isCloud ? `<span>endpoint: ${esc(svc.endpoint || '未配置')}</span>` : `<span>:${esc(svc.port)}</span>`}
          <span>${svc.pid ? 'pid ' + esc(svc.pid) : (isCloud ? '远程' : '无进程')}</span>
          <span>${running ? fmtDuration(svc.uptimeSec) : '-'}</span>
        </div>
        ${healthBadges(svc)}
        ${svc.lastError ? `<div class="service-error">${esc(svc.lastError)}</div>` : ''}
        ${!svc.exists ? `<div class="service-error">入口文件缺失</div>` : ''}
        ${!svc.pythonExists ? `<div class="service-error">Python 解释器缺失</div>` : ''}
        ${cloudNoEndpoint ? `<div class="service-error">请在设置中填写云端 endpoint 后启用</div>` : ''}
        ${dlMissing ? `<div class="service-error">${dlRunning ? '依赖下载中，请稍候…' : '依赖未下载，请先在上方「服务依赖下载」中下载'}</div>` : ''}
        <div class="service-actions">
          <button class="btn tiny" data-svc="start" data-id="${esc(svc.id)}" ${startDisabled ? 'disabled' : ''}>${isCloud ? '启用云端' : '启动'}</button>
          <button class="btn tiny ghost" data-svc="stop" data-id="${esc(svc.id)}" ${stopDisabled ? 'disabled' : ''}>${isCloud ? '—' : '停止'}</button>
          <button class="btn tiny ghost" data-svc="restart" data-id="${esc(svc.id)}" ${stopDisabled ? 'disabled' : ''}>${isCloud ? '—' : '重启'}</button>
          <button class="btn tiny ghost" data-svc="probe" data-id="${esc(svc.id)}">检测</button>
          <button class="btn tiny ghost" data-svc="open" data-url="${esc(svc.url)}" ${openDisabled ? 'disabled' : ''}>打开界面</button>
        </div>
      </div>`;
  }).join('');
}

$('service-grid').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-svc]');
  if (!btn) return;
  const { svc, id } = btn.dataset;
  btn.disabled = true;
  try {
    if (svc === 'open') {
      await call(api.app.openExternal(btn.dataset.url), '打开服务界面');
      return;
    }
    if (svc === 'probe') {
      const result = await call(api.services.probe(id), '检测服务');
      state.probes = { ...(state.probes || {}), [id]: result };
      renderServices();
      toast(`检测结果：${result.detail || '未知'}`, result.reachable ? 'success' : 'warn');
      return;
    }
    if (state.busy[id]) return;
    if (state.probes) delete state.probes[id];
    state.busy[id] = true;
    toast(svc === 'start' ? '正在启动服务…' : svc === 'stop' ? '正在停止服务…' : '正在重启服务…');
    const result = await call(api.services[svc](id), '服务操作');
    if (result && result.status === 'error') toast(result.lastError || '服务异常', 'error');
  } catch (_) {
    /* toast 已提示 */
  } finally {
    state.busy[id] = false;
    btn.disabled = false;
  }
});

/* ================= 按需下载 ================= */
const DL_STATE_META = {
  installed: ['已就绪', 'ok'],
  missing: ['未下载', 'bad'],
  partial: ['部分缺失', 'warn'],
  running: ['下载中', 'warn'],
  error: ['下载失败', 'bad'],
  done: ['已就绪', 'ok']
};

async function refreshDownloads() {
  try {
    state.downloads = await call(api.downloads.status(), '读取下载状态');
    renderDownloads();
    renderServices();
  } catch (_) { /* ignore */ }
}

function renderDownloads() {
  const box = $('downloads-panel');
  if (!box) return;
  if (!state.downloads.length) {
    box.innerHTML = '<div class="muted">下载清单加载中…</div>';
    return;
  }
  box.innerHTML = state.downloads.map((d) => {
    const [label, kind] = DL_STATE_META[d.state] || [d.state, ''];
    const chips = d.components.map((c) =>
      `<span class="dl-chip ${c.ok ? 'ok' : 'miss'}" title="${c.ok ? '已就绪' : esc('缺失: ' + c.missing.join('、'))}">${esc(c.label)}</span>`).join('');
    const p = d.progress || {};
    const running = d.state === 'running';
    const bar = running
      ? `<div class="dl-progress">
           <div class="dl-bar"><i style="width:${p.percent || 0}%"></i></div>
           <span class="dl-line muted">${p.step ? `步骤 ${p.step}/${p.totalSteps} · ` : ''}${esc(p.label || p.line || '下载中…')}</span>
         </div>`
      : '';
    const err = d.state === 'error' ? `<div class="service-error">${esc(d.lastError || '下载失败，详见日志')}</div>` : '';
    const btn = running
      ? '<button class="btn tiny" disabled>下载中…</button>'
      : `<button class="btn tiny ${d.state === 'installed' ? 'ghost' : 'primary'}" data-dl="${esc(d.id)}">${d.state === 'installed' ? '重新下载' : '下载'}</button>`;
    return `<div class="dl-row" data-id="${esc(d.id)}">
      <div class="dl-main">
        <div class="dl-name"><b>${esc(d.name)}</b><span class="dl-state ${kind}">${label}</span></div>
        <div class="dl-comps">${chips}</div>
        ${bar}${err}
      </div>
      <div class="dl-actions">${btn}</div>
    </div>`;
  }).join('');
}

$('downloads-panel').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-dl]');
  if (!btn) return;
  const id = btn.dataset.dl;
  const item = state.downloads.find((d) => d.id === id);
  if (item && item.state === 'installed'
    && !window.confirm(`${item.name} 已就绪，重新下载将重装对应环境（不删除已有权重），确认继续？`)) return;
  btn.disabled = true;
  try {
    await call(api.downloads.start(id), `下载 ${item ? item.name : id}`);
    toast(`${item ? item.name : id} 下载完成`, 'success');
  } catch (_) { /* toast 已提示 */ } finally {
    btn.disabled = false;
    refreshDownloads();
    try {
      state.config = await call(api.config.get(), '读取配置');
      state.services = await call(api.services.list(), '读取服务');
      renderServices();
      renderServiceSettings();
      renderKpis();
    } catch (_) { /* ignore */ }
  }
});

/* ================= 云端（AutoDL）总览 ================= */
async function refreshCloudOverview() {
  const balEl = $('ov-cloud-balance');
  if (balEl && !state.cloudStats.balance) balEl.textContent = '查询中…';
  try {
    const [balRes, instRes] = await Promise.all([api.cloud.balance(), api.cloud.instances()]);
    if (!balRes || !balRes.ok) throw new Error((balRes && balRes.error) || '余额查询失败');
    state.cloudStats.balance = balRes.data;
    state.cloudStats.instances = (instRes && instRes.ok) ? instRes.data : [];
    state.cloudStats.error = '';
  } catch (err) {
    state.cloudStats.balance = null;
    state.cloudStats.instances = [];
    state.cloudStats.error = err.message || String(err);
  }
  state.cloudStats.updatedAt = Date.now();
  renderCloudOverview();
}

function renderCloudOverview() {
  const balEl = $('ov-cloud-balance');
  if (!balEl) return;
  const cs = state.cloudStats;
  balEl.textContent = cs.balance ? `¥${cs.balance.yuan.toFixed(2)}` : (cs.error ? '不可用' : '-');
  $('ov-cloud-updated').textContent = cs.updatedAt ? `（${fmtClock(cs.updatedAt)} 更新）` : '';

  const box = $('ov-cloud-instances');
  if (cs.error) {
    box.innerHTML = `<div class="muted">${esc(cs.error)}。请到「设置 → AutoDL」填写开发者 Token。</div>`;
  } else if (!cs.instances.length) {
    box.innerHTML = '<div class="muted">暂无云端实例记录，可在下方选择服务与 GPU 规格一键创建部署。</div>';
  } else {
    box.innerHTML = `<div class="ci-row ci-head"><span>服务</span><span>实例 ID</span><span>状态</span><span>GPU</span><span>入口</span><span>操作</span></div>`
      + cs.instances.map((it) => {
        const svc = state.services.find((s) => s.id === it.serviceId) || {};
        const statusKind = it.status === 'running' ? 'ok' : (/shutdown|released|error|查询失败/.test(it.status) ? 'bad' : 'warn');
        return `<div class="ci-row">
          <span>${esc(svc.name || it.serviceId)}</span>
          <span class="mono" title="${esc(it.uuid)}">${esc(String(it.uuid || '').slice(0, 10))}…</span>
          <span class="ci-status ${statusKind}">${esc(it.status)}</span>
          <span>${esc(it.gpuSpecUuid || '-')}</span>
          <span class="mono ci-endpoint" title="${esc(svc.endpoint || '')}">${esc(svc.endpoint || '-')}</span>
          <span class="ci-actions">
            <button class="btn tiny ghost" data-ci="save" data-id="${esc(it.serviceId)}">保存镜像</button>
            <button class="btn tiny danger" data-ci="release" data-id="${esc(it.serviceId)}">释放</button>
          </span>
        </div>`;
      }).join('');
  }

  const sel = $('ov-deploy-service');
  if (sel) {
    const rows = state.services.filter((s) => CLOUD_DEPLOYABLE.includes(s.id));
    sel.innerHTML = rows.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  }
  renderOvCloudProgress();
}

function renderOvCloudProgress() {
  const box = $('ov-cloud-progress');
  if (!box) return;
  const list = state.cloud.progress.slice(-6);
  box.innerHTML = list.length
    ? list.map((p) => `<div class="cloud-progress-line"><span class="muted">${fmtClock(p.ts)}</span> <b>${esc(p.serviceId)}</b> ${esc(p.message)}</div>`).join('')
    : '';
}

$('btn-ov-cloud-refresh').addEventListener('click', async () => {
  await refreshCloudOverview();
  toast(state.cloudStats.error ? `云端查询失败: ${state.cloudStats.error}` : '云端信息已刷新',
    state.cloudStats.error ? 'warn' : 'success');
});

$('btn-ov-deploy').addEventListener('click', async () => {
  const serviceId = $('ov-deploy-service').value;
  const gpu = $('ov-deploy-gpu').value;
  if (!serviceId) { toast('请选择要部署的服务', 'warn'); return; }
  const btn = $('btn-ov-deploy');
  btn.disabled = true;
  try {
    const result = await call(api.cloud.deploy(serviceId, gpu), `部署 ${serviceId}`);
    toast(`${serviceId} 部署完成: ${result.endpoint}`, 'success');
  } catch (_) { /* toast 已提示 */ } finally {
    btn.disabled = false;
    try {
      state.config = await call(api.config.get(), '读取配置');
      state.services = await call(api.services.list(), '读取服务');
    } catch (_) { /* ignore */ }
    renderServices();
    renderCloudPanel();
    renderServiceSettings();
    renderKpis();
    refreshCloudOverview();
  }
});

$('ov-cloud-instances').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-ci]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.ci;
  if (action === 'release' && !window.confirm(`确认释放 ${id} 的云端实例？将停止计费并切回本地模式`)) return;
  btn.disabled = true;
  try {
    if (action === 'save') {
      const result = await call(api.cloud.saveImage(id), '保存镜像');
      toast(result.imageUuid ? `镜像已保存: ${result.imageUuid}` : '镜像保存任务已提交，请到 AutoDL 控制台确认', 'success');
    } else if (action === 'release') {
      await call(api.cloud.release(id), '释放实例');
      toast(`${id} 实例已释放，已切回本地模式`, 'success');
    }
  } catch (_) { /* toast 已提示 */ } finally {
    btn.disabled = false;
    try {
      state.config = await call(api.config.get(), '读取配置');
      state.services = await call(api.services.list(), '读取服务');
    } catch (_) { /* ignore */ }
    renderServices();
    renderCloudPanel();
    renderServiceSettings();
    renderKpis();
    refreshCloudOverview();
  }
});

/* ================= 素材库 ================= */
async function refreshLibrary() {
  try {
    state.library = await call(api.library.list(), '读取素材库');
    renderLibrary();
  } catch (_) { /* ignore */ }
}

function renderLibrary() {
  const lib = state.library;
  if (!lib) return;
  $('library-summary').textContent =
    `${lib.counts.video} 个视频 · ${lib.counts.audio} 个音频 · 共 ${fmtBytes(lib.counts.totalBytes)} · 扫描 ${lib.roots.filter((r) => r.exists).length}/${lib.roots.length} 个目录`;

  if (!lib.items.length) {
    $('library-list').innerHTML = '<div class="empty-row">素材库为空。完成一次渲染或添加目录后再刷新。</div>';
    return;
  }
  $('library-list').innerHTML = lib.items.map((item) => `
    <div class="list-row">
      <div class="cell-name" title="${esc(item.path)}">
        <div>${esc(item.base)}</div>
        <div class="cell-sub">${esc(item.name)}</div>
      </div>
      <div><span class="tag ${esc(item.kind)}">${item.kind === 'video' ? '视频' : item.kind === 'audio' ? '音频' : '文件'}</span></div>
      <div class="cell-sub">${esc(item.folder)}</div>
      <div class="cell-sub">${fmtBytes(item.size)}</div>
      <div class="cell-sub">${fmtDateTime(item.mtime)}</div>
      <div class="cell-actions">
        <button class="btn tiny ghost" data-lib="open" data-path="${esc(item.path)}">播放</button>
        <button class="btn tiny ghost" data-lib="reveal" data-path="${esc(item.path)}">定位</button>
        ${item.kind === 'video' ? `<button class="btn tiny" data-lib="source" data-path="${esc(item.path)}">设为推流源</button>` : ''}
      </div>
    </div>`).join('');
}

$('library-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-lib]');
  if (!btn) return;
  const target = btn.dataset.path;
  try {
    if (btn.dataset.lib === 'open') await call(api.library.open(target), '打开文件');
    if (btn.dataset.lib === 'reveal') await call(api.library.reveal(target), '定位文件');
    if (btn.dataset.lib === 'source') {
      state.config = await call(api.config.set('stream.videoSource', target), '更新推流源');
      $('stream-source').value = target;
      toast('已设为推流视频源', 'success');
      renderStream();
    }
  } catch (_) { /* ignore */ }
});

$('btn-library-refresh').addEventListener('click', refreshLibrary);
$('btn-library-open').addEventListener('click', async () => {
  const root = state.library && state.library.roots.find((r) => r.exists);
  if (!root) return toast('没有可用的素材目录', 'warn');
  await call(api.library.open(root.abs), '打开目录');
});
$('btn-library-add').addEventListener('click', async () => {
  const dir = await call(api.dialog.pickDirectory(), '选择目录');
  if (!dir) return;
  await call(api.library.addRoot(dir), '添加目录');
  await refreshLibrary();
  toast('已添加素材目录', 'success');
});

/* ================= 渲染队列 ================= */
async function refreshQueue() {
  try {
    state.queue = await call(api.queue.list(), '读取队列');
    renderQueue();
    renderKpis();
  } catch (_) { /* ignore */ }
}

const JOB_LABELS = { 'lip-sync': '口型渲染', song: '整曲预渲染', clone: '音色克隆', annotate: '音色标注', tts: '语音合成' };
const STATUS_LABELS = { queued: '排队中', running: '执行中', done: '已完成', failed: '失败', canceled: '已取消' };

function renderQueue() {
  if (!state.queue.length) {
    $('queue-list').innerHTML = '<div class="empty-row">队列为空。可以在上方新建任务。</div>';
    return;
  }
  $('queue-list').innerHTML = state.queue.map((job) => {
    const elapsed = job.startedAt ? Math.floor(((job.finishedAt || Date.now()) - job.startedAt) / 1000) : 0;
    return `
    <div class="list-row queue-cols">
      <div class="cell-name" title="${esc(job.title)}">
        <div>${esc(job.title)}</div>
        <div class="cell-sub">${esc(job.payload?.note || job.output || '')}</div>
      </div>
      <div class="cell-sub">${JOB_LABELS[job.type] || esc(job.type)}</div>
      <div><span class="tag ${esc(job.status)}">${STATUS_LABELS[job.status] || esc(job.status)}</span></div>
      <div>
        <div class="progress"><i style="width:${Math.max(2, job.progress || 0)}%"></i></div>
        <div class="progress-text">${job.progress || 0}%${job.note ? ' · ' + esc(job.note) : ''}</div>
      </div>
      <div class="cell-sub">${elapsed ? fmtDuration(elapsed) : '-'}</div>
      <div class="cell-actions">
        ${job.status === 'failed' ? `<button class="btn tiny" data-job="retry" data-id="${esc(job.id)}">重试</button>` : ''}
        ${job.status === 'queued' ? `<button class="btn tiny ghost" data-job="cancel" data-id="${esc(job.id)}">取消</button>` : ''}
        ${job.status === 'done' ? `<button class="btn tiny ghost" data-job="reveal" data-path="${esc(job.output || '')}">定位</button>` : ''}
        ${job.error ? `<span class="cell-sub" style="color:var(--danger)" title="${esc(job.error)}">!</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

$('queue-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-job]');
  if (!btn) return;
  try {
    if (btn.dataset.job === 'retry') await call(api.queue.retry(btn.dataset.id), '重试任务');
    if (btn.dataset.job === 'cancel') await call(api.queue.cancel(btn.dataset.id), '取消任务');
    if (btn.dataset.job === 'reveal') await call(api.library.reveal(btn.dataset.path), '定位产物');
    await refreshQueue();
  } catch (_) { /* ignore */ }
});

$('btn-pick-audio').addEventListener('click', async () => {
  try {
    const file = await call(api.dialog.pickFile({
      title: '选择音频文件',
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'flac', 'aac'] }]
    }), '选择音频');
    if (file) $('job-audio').value = file;
  } catch (_) { /* ignore */ }
});

$('btn-pick-video').addEventListener('click', async () => {
  try {
    const file = await call(api.dialog.pickFile({
      title: '选择形象视频',
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv'] }]
    }), '选择视频');
    if (file) $('job-video').value = file;
  } catch (_) { /* ignore */ }
});

$('btn-queue-add').addEventListener('click', async () => {
  const title = $('job-title').value.trim();
  const type = $('job-type').value;
  const audioPath = $('job-audio').value.trim();
  const videoPath = $('job-video').value.trim();
  const text = $('job-text').value.trim();
  if (!title) return toast('请填写任务名称', 'warn');
  if (type === 'tts' && !text) return toast('文字转语音任务需要填写文案', 'warn');
  if (type !== 'tts' && !audioPath) return toast('请选择音频文件', 'warn');
  try {
    await call(api.queue.add({
      type,
      title,
      payload: { audioPath, videoPath, text }
    }), '加入队列');
    $('job-title').value = '';
    $('job-audio').value = '';
    $('job-video').value = '';
    $('job-text').value = '';
    toast('任务已入队', 'success');
    await refreshQueue();
  } catch (_) { /* ignore */ }
});

$('btn-queue-refresh').addEventListener('click', refreshQueue);
$('btn-queue-clear').addEventListener('click', async () => {
  try {
    await call(api.queue.clear(), '清理队列');
    await refreshQueue();
    toast('已清理完成的任务', 'success');
  } catch (_) { /* ignore */ }
});

/* ================= 推流 ================= */
function renderStream() {
  const s = state.stream;
  if (!s) return;
  $('stream-status').textContent = streamLabel(s.status);
  $('stream-uptime').textContent = s.uptimeSec ? fmtDuration(s.uptimeSec) : '-';
  $('stream-fps').textContent = s.stats?.fps || 0;
  $('stream-bitrate').textContent = s.stats?.bitrate || '-';
  $('stream-speed').textContent = s.stats?.speed || '-';
  $('stream-frames').textContent = s.stats?.frames || 0;
  $('stream-time').textContent = s.stats?.time || '00:00:00';
  $('stream-rtmp').value = s.rtmpUrl || '';
  $('stream-source').value = s.videoSource || '';
  $('stream-track').value = (state.config && state.config.stream && state.config.stream.track) || 'file';
  $('stream-ffmpeg').value = s.ffmpegPath || '(未配置)';
  $('btn-stream-start').disabled = s.status === 'live' || s.status === 'starting';
  $('btn-stream-stop').disabled = !(s.status === 'live' || s.status === 'starting');
  $('badge-stream').textContent = `推流 ${streamLabel(s.status)}`;
}

$('btn-stream-save').addEventListener('click', async () => {
  try {
    state.config = await call(api.config.set('stream.track', $('stream-track').value), '保存画面轨道');
    state.config = await call(api.config.set('stream.rtmpUrl', $('stream-rtmp').value.trim()), '保存推流地址');
    state.config = await call(api.config.set('stream.videoSource', $('stream-source').value.trim()), '保存视频源');
    toast('推流设置已保存', 'success');
    state.stream = await call(api.stream.status(), '读取推流状态');
    renderStream();
  } catch (_) { /* ignore */ }
});

$('btn-stream-pick').addEventListener('click', async () => {
  const file = await call(api.dialog.pickFile(), '选择视频源');
  if (file) $('stream-source').value = file;
});

$('btn-stream-start').addEventListener('click', async () => {
  try {
    const snap = await call(api.stream.start({
      rtmpUrl: $('stream-rtmp').value.trim(),
      videoSource: $('stream-source').value.trim()
    }), '启动推流');
    state.stream = snap;
    renderStream();
    if (snap.status === 'error') toast(snap.lastError || '推流启动失败', 'error');
    else toast('推流启动中…');
  } catch (_) { /* ignore */ }
});

$('btn-stream-stop').addEventListener('click', async () => {
  try {
    state.stream = await call(api.stream.stop(), '停止推流');
    renderStream();
  } catch (_) { /* ignore */ }
});

/* ================= 直播弹幕 ================= */
const DANMU_TYPE_LABEL = { chat: '弹幕', gift: '礼物', like: '点赞', enter: '进场', follow: '关注', system: '系统' };

function renderDanmuState(snap) {
  if (!snap) return;
  const s = snap.state || {};
  const labelMap = { idle: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', ended: '直播已结束', stopped: '已断开', error: '异常' };
  $('danmu-state').textContent = labelMap[s.state] || s.state || '未连接';
  $('danmu-state').dataset.state = s.state || 'idle';
  const bits = [];
  if (s.roomId) bits.push(`room_id ${s.roomId}`);
  if (s.viewers !== null && s.viewers !== undefined) bits.push(`观看 ${s.viewers}`);
  if (s.chatCount) bits.push(`弹幕 ${s.chatCount}`);
  if (s.detail) bits.push(s.detail);
  $('danmu-state-detail').textContent = bits.join(' · ') || '-';
  $('danmu-queue').textContent = `队列 ${snap.queueLength || 0}`;
  $('danmu-autoreply').checked = Boolean(snap.autoReply);
  const connected = s.state === 'connected' || s.state === 'connecting' || s.state === 'reconnecting';
  $('btn-danmu-connect').classList.toggle('hidden', connected);
  $('btn-danmu-disconnect').classList.toggle('hidden', !connected);
}

function appendDanmuEvent(ev) {
  const list = $('danmu-list');
  const empty = list.querySelector('.chat-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = `danmu-item type-${ev.type}`;
  const time = new Date(ev.ts || Date.now());
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;
  const canReply = ev.type === 'chat' || ev.type === 'gift';
  row.innerHTML = `
    <span class="danmu-clock">${clock}</span>
    <span class="danmu-type">${DANMU_TYPE_LABEL[ev.type] || ev.type}</span>
    <span class="danmu-nick">${esc(ev.nickname || '系统')}</span>
    <span class="danmu-text">${esc(ev.text || '')}</span>
    ${canReply ? '<button class="btn tiny ghost danmu-reply-btn">回复</button>' : ''}`;
  if (canReply) {
    row.querySelector('.danmu-reply-btn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await call(api.danmu.reply(ev.text), '手动回复');
        toast('已触发回复', 'success');
      } catch (_) {
        e.target.disabled = false;
      }
    });
  }
  list.appendChild(row);
  while (list.children.length > 200) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

$('danmu-mode').addEventListener('change', () => {
  $('danmu-cookie-field').classList.toggle('hidden', $('danmu-mode').value !== 'cookie');
});

$('btn-danmu-connect').addEventListener('click', async () => {
  const liveId = $('danmu-room').value.trim();
  if (!liveId) return toast('请输入直播间 ID 或链接', 'warn');
  const btn = $('btn-danmu-connect');
  btn.disabled = true;
  try {
    await call(api.danmu.connect({
      liveId,
      mode: $('danmu-mode').value,
      cookie: $('danmu-cookie').value.trim()
    }), '连接直播间');
    toast('连接请求已发送', 'success');
  } catch (_) { /* ignore */ }
  btn.disabled = false;
});

$('btn-danmu-disconnect').addEventListener('click', async () => {
  try {
    await call(api.danmu.disconnect(), '断开连接');
  } catch (_) { /* ignore */ }
});

$('danmu-autoreply').addEventListener('change', async () => {
  try {
    state.config = await call(api.config.set('danmu.autoReply', $('danmu-autoreply').checked), '保存自动回复开关');
    toast($('danmu-autoreply').checked ? '半自动回复已开启' : '半自动回复已关闭', 'success');
  } catch (_) { /* ignore */ }
});

$('btn-danmu-mock').addEventListener('click', async () => {
  const samples = [
    { text: '主播晚上好，点一首《晴天》', nickname: '路过的小鱼' },
    { text: '今天嗓子状态听起来不错', nickname: '老粉阿明' },
    { text: '能唱一首粤语歌吗', nickname: '南风' },
    { text: '主播吃饭了吗', nickname: '干饭人小赵' }
  ];
  const pick = samples[Math.floor(Math.random() * samples.length)];
  try {
    await call(api.danmu.mock({ text: pick.text, nickname: pick.nickname, type: 'chat' }), '模拟弹幕');
  } catch (_) { /* ignore */ }
});

/* ================= 互动试验台 ================= */
function setInteractStatus(text, kind = '') {
  const node = $('interact-status');
  node.textContent = text;
  node.className = `interact-status${kind ? ' ' + kind : ''}`;
}

function showInteractVideo(path) {
  if (!path) return;
  const video = $('interact-video');
  video.src = asFileUrl(path);
  video.classList.remove('hidden');
  video.play().catch(() => {});
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function appendChat(role, text, meta) {
  const log = $('chat-log');
  const empty = log.querySelector('.chat-empty');
  if (empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="msg-body">${esc(text)}</div><div class="msg-meta">${esc(meta || '')}</div>`;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

$('btn-interact-send').addEventListener('click', async () => {
  const text = $('interact-text').value.trim();
  if (!text) return toast('请输入一条弹幕内容', 'warn');
  const btn = $('btn-interact-send');
  btn.disabled = true;
  btn.textContent = '生成中…';
  appendChat('user', text, '观众弹幕');
  setInteractStatus('互动回合执行中：LLM → 语音合成 → 口型渲染…', 'busy');
  try {
    const turn = await call(api.interact.talk({ text }), '互动回合');
    appendChat('bot', turn.reply, [
      turn.llm ? `${turn.llm.model} · ${turn.llm.latencyMs}ms` : '直读模式（未配置 LLM）',
      `TTS ${turn.ttsMs}ms`,
      `口型 ${turn.inferMs}ms`,
      `总计 ${turn.totalMs}ms`
    ].join(' · '));
    showInteractVideo(turn.videoPath);
    setInteractStatus(`本轮完成 ${turn.totalMs}ms（口型视频已生成）`);
    $('interact-text').value = '';
  } catch (err) {
    setInteractStatus(`互动失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '生成回应';
  }
});

$('btn-interact-reset').addEventListener('click', async () => {
  await call(api.llm.reset(), '清空上下文');
  $('chat-log').innerHTML = '<div class="chat-empty">还没有对话，输入一条弹幕后开始。</div>';
  const video = $('interact-video');
  video.pause();
  video.removeAttribute('src');
  video.classList.add('hidden');
  setInteractStatus('上下文已清空。');
  toast('上下文已清空', 'success');
});

$('btn-interact-prepare').addEventListener('click', async () => {
  const btn = $('btn-interact-prepare');
  btn.disabled = true;
  btn.textContent = '预处理中…';
  setInteractStatus('正在预处理形象素材（首次需要数分钟，之后会复用缓存）…', 'busy');
  try {
    const result = await call(api.interact.prepareAvatar({}), '形象预处理');
    setInteractStatus(`形象 ${result.avatarId} 就绪（${Math.round(result.elapsedMs / 1000)}s）`);
    toast('形象预处理完成', 'success');
  } catch (err) {
    setInteractStatus(`形象预处理失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '预处理形象';
  }
});

let recorder = null;
let recordStream = null;
let recordChunks = [];

$('btn-interact-record').addEventListener('click', async () => {
  const btn = $('btn-interact-record');
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordChunks = [];
    recorder = new MediaRecorder(recordStream);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    recorder.onstop = async () => {
      recordStream.getTracks().forEach((track) => track.stop());
      btn.classList.remove('recording');
      btn.textContent = '录音识别';
      const blob = new Blob(recordChunks, { type: recorder.mimeType || 'audio/webm' });
      if (!blob.size) {
        setInteractStatus('没有录到音频。');
        return;
      }
      setInteractStatus('正在识别语音…', 'busy');
      try {
        const base64 = await blobToBase64(blob);
        const result = await call(api.interact.stt({ audioBase64: base64, filename: 'mic.webm', mime: blob.type }), '语音识别');
        if (result.text) {
          $('interact-text').value = result.text;
          setInteractStatus(`识别完成（${result.language || 'zh'}）：${result.text}`);
          toast('语音已转写', 'success');
        } else {
          setInteractStatus('未识别到有效语音内容。');
          toast('没有识别到内容，请靠近麦克风再试', 'warn');
        }
      } catch (err) {
        setInteractStatus(`语音识别失败: ${err.message}`, 'error');
      }
    };
    recorder.start();
    btn.classList.add('recording');
    btn.textContent = '停止录音';
    setInteractStatus('录音中…再次点击结束并识别。', 'busy');
  } catch (err) {
    setInteractStatus(`无法访问麦克风: ${err.message}`, 'error');
  }
});

async function refreshInteractStatus() {
  try {
    const result = await call(api.interact.status(), '读取互动状态');
    const svc = result.service || {};
    if (!svc.ok) {
      setInteractStatus(`实时服务不可用：${svc.detail || '请启动「MuseTalk 实时互动」'}`, 'error');
    } else if (svc.busy) {
      setInteractStatus('实时服务正在处理上一轮互动…', 'busy');
    } else {
      const model = svc.modelLoaded ? '模型已加载' : '模型未加载（首次互动会自动加载）';
      const avatar = svc.avatarReady ? `形象 ${svc.avatarId} 就绪` : '形象未预处理';
      const stt = svc.sttReady ? '识别就绪' : '识别未加载';
      setInteractStatus(`实时服务就绪 · ${model} · ${avatar} · ${stt}`);
    }
    $('interact-hint').textContent = result.llmConfigured
      ? '已配置 DeepSeek，走完整对话链路'
      : '未配置 DeepSeek API Key，将直接播报输入文本';
  } catch (err) {
    setInteractStatus(`读取互动状态失败: ${err.message}`, 'error');
  }
}

/* ================= 设置（schema 驱动） ================= */
function getByPath(obj, key) {
  return key.split('.').reduce((cur, part) => (cur === null || cur === undefined ? undefined : cur[part]), obj);
}

/** 单个字段 → 表单控件 HTML，新增配置项只需在 config-schema.js 里加一条 */
function fieldHtml(field) {
  const raw = getByPath(state.config || {}, field.key);
  const value = raw === undefined || raw === null ? '' : raw;
  const wrap = field.full ? 'field full' : (field.wide ? 'field grow' : 'field');
  const hint = field.hint ? `<span class="muted">${esc(field.hint)}</span>` : '';
  const attrs = `data-key="${esc(field.key)}" data-type="${esc(field.type)}"`;

  if (field.type === 'switch') {
    return `<label class="switch-row">
      <input type="checkbox" ${attrs} ${value ? 'checked' : ''} />
      <span>${esc(field.label)}</span>${hint}
    </label>`;
  }

  let control;
  if (field.type === 'select') {
    const options = (field.options || []).map((opt) =>
      `<option value="${esc(opt.value)}" ${String(opt.value) === String(value) ? 'selected' : ''}>${esc(opt.label)}</option>`
    ).join('');
    control = `<select ${attrs}>${options}</select>`;
  } else if (field.type === 'textarea') {
    control = `<textarea rows="${field.rows || 3}" ${attrs} placeholder="${esc(field.placeholder || '')}">${esc(value)}</textarea>`;
  } else if (field.type === 'password') {
    const shown = String(value || '');
    control = `<input type="password" ${attrs} value="" placeholder="${esc(shown ? `已保存（${shown}）` : field.placeholder || '')}" />`;
  } else if (field.type === 'number') {
    const bounds = [
      field.min !== undefined ? `min="${field.min}"` : '',
      field.max !== undefined ? `max="${field.max}"` : '',
      field.step !== undefined ? `step="${field.step}"` : ''
    ].filter(Boolean).join(' ');
    control = `<input type="number" ${attrs} value="${esc(value)}" ${bounds} />`;
  } else {
    control = `<input type="text" ${attrs} value="${esc(value)}" title="${esc(value)}" placeholder="${esc(field.placeholder || '')}" />`;
  }
  return `<div class="${wrap}"><label>${esc(field.label)}</label>${control}${hint}</div>`;
}

function renderSettingsGroups() {
  const holder = $('settings-groups');
  if (!holder || !state.schema) return;
  holder.innerHTML = state.schema.groups.map((group) => `
    <div class="panel form-panel settings-block" data-group="${esc(group.id)}">
      <h3>${esc(group.title)}</h3>
      <p class="muted group-desc">${esc(group.desc || '')}</p>
      ${group.fields.map(fieldHtml).join('')}
    </div>`).join('');
}

function readControl(el) {
  const type = el.dataset.type;
  if (type === 'switch') return el.checked;
  if (type === 'number') return el.value === '' ? 0 : Number(el.value);
  return el.value;
}

/** 保存容器内所有 [data-key] 控件；空密码视为「不修改」 */
async function saveControls(container) {
  const controls = Array.from(container.querySelectorAll('[data-key]'));
  const tasks = [];
  let skipped = 0;
  for (const el of controls) {
    if (el.dataset.type === 'password' && !el.value.trim()) {
      skipped += 1;
      continue;
    }
    tasks.push(api.config.set(el.dataset.key, readControl(el)));
  }
  const results = await Promise.all(tasks);
  const failed = results.find((res) => !res.ok);
  if (failed) throw new Error(failed.error);
  state.config = await call(api.config.get(), '读取配置');
  state.llm = await call(api.llm.status(), '读取 LLM 状态');
  return skipped;
}

/* ================= 服务进程参数 ================= */
function renderServiceSettings() {
  const holder = $('service-settings');
  if (!holder) return;
  if (!state.services.length) {
    holder.innerHTML = '<div class="empty-row">未配置服务</div>';
    return;
  }
  holder.innerHTML = state.services.map((svc) => {
    const isCloud = svc.mode === 'cloud';
    const cloud = svc.cloud || {};
    return `
    <div class="svc-row ${isCloud ? 'is-cloud' : ''}" data-id="${esc(svc.id)}">
      <div class="svc-head">
        <div class="svc-name">${esc(svc.name)}</div>
        <div class="svc-sub">${svc.role === 'interact' ? '实时互动' : '离线渲染'} · ${esc(svc.status)}</div>
      </div>
      <div class="field">
        <label>部署</label>
        <select data-svc-field="mode">
          <option value="local" ${!isCloud ? 'selected' : ''}>本地</option>
          <option value="cloud" ${isCloud ? 'selected' : ''}>云端（AutoDL）</option>
        </select>
      </div>
      <div class="svc-local">
        <div class="field">
          <label>端口</label>
          <input data-svc-field="port" type="number" min="1024" max="65535" value="${esc(svc.port)}" />
        </div>
      </div>
      <div class="svc-local">
        <div class="field">
          <label>Python 解释器</label>
          <input data-svc-field="python" value="${esc(svc.python || '')}" title="${esc(svc.python || '')}" />
        </div>
      </div>
      <div class="svc-local">
        <div class="field">
          <label>工作目录</label>
          <input data-svc-field="cwd" value="${esc(svc.cwd || '')}" title="${esc(svc.cwd || '')}" />
        </div>
      </div>
      <div class="svc-cloud">
        <div class="field full">
          <label>云端 endpoint（含协议与端口，例如 http://47.xx.xx.xx:8000）</label>
          <input data-svc-field="cloud.endpoint" value="${esc(cloud.endpoint || '')}" placeholder="http://your-autodl-instance:8000" />
        </div>
        <div class="field grow">
          <label>API Key（可选）</label>
          <input data-svc-field="cloud.apiKey" type="password" value="${esc(cloud.apiKey || '')}" placeholder="" />
        </div>
      </div>
      <label class="svc-auto svc-local">
        <input type="checkbox" data-svc-field="autoStart" ${svc.autoStart ? 'checked' : ''} />自动启动
      </label>
      <div class="field">
        <button class="btn tiny" data-svc-save="${esc(svc.id)}">保存</button>
      </div>
    </div>`;
  }).join('');
}

$('service-settings').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-svc-save]');
  if (!btn) return;
  const id = btn.dataset.svcSave;
  const row = btn.closest('.svc-row');
  const mode = row.querySelector('[data-svc-field="mode"]')?.value || 'local';
  const patch = { mode };
  row.querySelectorAll('[data-svc-field]').forEach((el) => {
    const key = el.dataset.svcField;
    if (key === 'mode') return;
    // mode 切换到 cloud 时，跳过本地字段（以免覆盖），反之亦然
    const skipLocal = mode === 'cloud' && ['port', 'python', 'cwd', 'autoStart'].includes(key);
    const skipCloud = mode === 'local' && key.startsWith('cloud.');
    if (skipLocal || skipCloud) return;
    // dot notation → 嵌套对象
    if (key.startsWith('cloud.')) {
      if (!patch.cloud) patch.cloud = {};
      const sub = key.slice('cloud.'.length);
      if (el.type === 'password' && !el.value.trim()) return; // 空密码视为不修改
      patch.cloud[sub] = el.value.trim();
      return;
    }
    if (key === 'autoStart') patch[key] = el.checked;
    else if (key === 'port') patch[key] = Number(el.value) || 0;
    else patch[key] = el.value.trim();
  });
  try {
    state.services = await call(api.config.setService(id, patch), '保存服务参数');
    renderServiceSettings();
    renderServices();
    renderKpis();
    toast('服务参数已保存，切换部署模式后自动生效', 'success');
  } catch (_) { /* toast 已提示 */ }
});

// 模式切换即时显隐（无需保存）
$('service-settings').addEventListener('change', (event) => {
  const sel = event.target.closest('[data-svc-field="mode"]');
  if (!sel) return;
  const row = sel.closest('.svc-row');
  if (!row) return;
  const cloudMode = sel.value === 'cloud';
  row.classList.toggle('is-cloud', cloudMode);
});

/* ================= 云端部署（AutoDL） ================= */
const CLOUD_GPU_OPTIONS = [
  { value: '4090D', label: '4090D · 24G（推理）' },
  { value: 'v-48g', label: '4090 · 48G（训练）' },
  { value: '5090-p', label: '5090 · 32G' }
];
/** 弹幕抓取依赖本地登录环境，不参与云端部署 */
const CLOUD_DEPLOYABLE = ['realtime', 'svs', 'svc', 'latentsync'];

function renderCloudPanel() {
  const holder = $('cloud-deploy-list');
  if (!holder) return;
  const autoDL = (state.config && state.config.cloud && state.config.cloud.autoDL) || {};
  const instances = autoDL.instances || {};
  const img = $('cloud-image-info');
  if (img) {
    img.textContent = autoDL.imageUuid
      ? `私有镜像: ${autoDL.imageUuid}（部署免安装）`
      : '未保存私有镜像，首次部署需安装环境';
  }
  const rows = state.services.filter((s) => CLOUD_DEPLOYABLE.includes(s.id));
  if (!rows.length) {
    holder.innerHTML = '<div class="empty-row">无可部署服务</div>';
    return;
  }
  holder.innerHTML = rows.map((svc) => {
    const rec = instances[svc.id];
    const isCloud = svc.mode === 'cloud';
    const last = [...state.cloud.progress].reverse().find((p) => p.serviceId === svc.id);
    const gpuOpts = CLOUD_GPU_OPTIONS.map((o) =>
      `<option value="${o.value}" ${o.value === (autoDL.gpuSpec || '4090D') ? 'selected' : ''}>${o.label}</option>`).join('');
    return `
    <div class="cloud-deploy-row" data-id="${esc(svc.id)}">
      <div class="cloud-deploy-name">
        <b>${esc(svc.name)}</b>
        <span class="deploy-chip ${isCloud ? 'cloud' : 'local'}">${isCloud ? '云端' : '本地'}</span>
        ${rec ? `<span class="muted cloud-uuid" title="实例 ID">${esc(rec.uuid)}</span>` : ''}
      </div>
      <select class="cloud-gpu" data-cloud-gpu="${esc(svc.id)}" ${rec ? 'disabled' : ''}>${gpuOpts}</select>
      <div class="cloud-deploy-actions">
        <button class="btn tiny primary" data-cloud-action="deploy" data-cloud-id="${esc(svc.id)}" ${rec ? 'disabled' : ''}>部署到云端</button>
        <button class="btn tiny" data-cloud-action="save-image" data-cloud-id="${esc(svc.id)}" ${rec ? '' : 'disabled'}>保存为镜像</button>
        <button class="btn tiny danger" data-cloud-action="release" data-cloud-id="${esc(svc.id)}" ${rec ? '' : 'disabled'}>释放实例</button>
      </div>
      <div class="cloud-deploy-status muted">${last ? `[${esc(last.step)}] ${esc(last.message)}` : ''}</div>
    </div>`;
  }).join('');
}

function renderCloudProgress() {
  const box = $('cloud-progress');
  if (!box) return;
  const list = state.cloud.progress.slice(-40);
  if (!list.length) {
    box.innerHTML = '<div class="muted">暂无部署记录</div>';
    return;
  }
  box.innerHTML = list.map((p) =>
    `<div class="cloud-progress-line"><span class="muted">${fmtClock(p.ts)}</span> <b>${esc(p.serviceId)}</b> ${esc(p.message)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}

$('btn-cloud-balance').addEventListener('click', async () => {
  const el = $('cloud-balance-result');
  el.textContent = '查询中…';
  try {
    const b = await call(api.cloud.balance(), '查询余额');
    el.textContent = `账户余额 ¥${b.yuan.toFixed(2)}`;
  } catch (_) {
    el.textContent = '查询失败';
  }
});

$('cloud-deploy-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-cloud-action]');
  if (!btn) return;
  const id = btn.dataset.cloudId;
  const action = btn.dataset.cloudAction;
  if (action === 'release' && !window.confirm(`确认释放 ${id} 的云端实例？将停止计费并切回本地模式`)) return;
  btn.disabled = true;
  try {
    if (action === 'deploy') {
      const gpu = document.querySelector(`select[data-cloud-gpu="${id}"]`)?.value;
      const result = await call(api.cloud.deploy(id, gpu), `部署 ${id}`);
      toast(`${id} 部署完成: ${result.endpoint}`, 'success');
    } else if (action === 'save-image') {
      const result = await call(api.cloud.saveImage(id), '保存镜像');
      toast(result.imageUuid ? `镜像已保存: ${result.imageUuid}` : '镜像保存任务已提交，请到 AutoDL 控制台确认', 'success');
    } else if (action === 'release') {
      await call(api.cloud.release(id), '释放实例');
      toast(`${id} 实例已释放，已切回本地模式`, 'success');
    }
  } catch (_) { /* toast 已提示 */ } finally {
    btn.disabled = false;
    try {
      state.config = await call(api.config.get(), '读取配置');
      state.services = await call(api.services.list(), '读取服务');
    } catch (_) { /* ignore */ }
    renderCloudPanel();
    renderServices();
    renderServiceSettings();
    renderKpis();
  }
});

$('btn-settings-save').addEventListener('click', async () => {
  try {
    const skipped = await saveControls($('settings-groups'));
    renderSettingsGroups();
    renderServiceSettings();
    renderModelForm();
    renderKpis();
    state.stream = await call(api.stream.status(), '读取推流状态');
    renderStream();
    toast(skipped ? '设置已保存（API Key 未改动）' : '设置已保存', 'success');
  } catch (err) {
    toast(`保存失败: ${err.message}`, 'error');
  }
});

$('btn-settings-open').addEventListener('click', async () => {
  if (state.app) await call(api.app.openPath(state.app.appDir + '/data'), '打开数据目录');
});

$('btn-tts-check').addEventListener('click', async () => {
  const btn = $('btn-tts-check');
  btn.disabled = true;
  $('tts-check-result').textContent = '检测中…';
  try {
    const result = await call(api.tts.check(), '检测 edge-tts');
    $('tts-check-result').textContent = result.detail;
    $('tts-check-result').style.color = result.ok ? 'var(--success)' : 'var(--danger)';
    toast(result.ok ? 'edge-tts 可用' : 'edge-tts 不可用', result.ok ? 'success' : 'warn');
  } catch (err) {
    $('tts-check-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('btn-muse-check').addEventListener('click', async () => {
  const btn = $('btn-muse-check');
  btn.disabled = true;
  $('muse-check-result').textContent = '检测中…（首次加载模型较慢）';
  try {
    const result = await call(api.muse.check(), '检测 MuseTalk');
    $('muse-check-result').textContent = result.detail;
    $('muse-check-result').style.color = result.ok ? 'var(--success)' : 'var(--danger)';
    toast(result.ok ? 'MuseTalk 可用' : 'MuseTalk 不可用', result.ok ? 'success' : 'warn');
  } catch (err) {
    $('muse-check-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('btn-soulx-check').addEventListener('click', async () => {
  const btn = $('btn-soulx-check');
  btn.disabled = true;
  $('soulx-check-result').textContent = '检测中…';
  try {
    const result = await call(api.soulx.check(), '检测 SoulX-Singer');
    $('soulx-check-result').textContent = result.detail;
    $('soulx-check-result').style.color = result.ok ? 'var(--success)' : 'var(--danger)';
    toast(result.ok ? 'SoulX-Singer 可用' : 'SoulX-Singer 不可用', result.ok ? 'success' : 'warn');
  } catch (err) {
    $('soulx-check-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('btn-realtime-check').addEventListener('click', async () => {
  const btn = $('btn-realtime-check');
  btn.disabled = true;
  $('realtime-check-result').textContent = '检测中…';
  try {
    const result = await call(api.realtime.health(), '检测实时服务');
    const bits = [];
    if (result.modelLoaded) bits.push('模型已加载');
    if (result.avatarReady) bits.push(`形象 ${result.avatarId || ''}`);
    if (result.sttReady) bits.push('识别就绪');
    if (result.busy) bits.push('推理中');
    if (result.gpuLocked) bits.push('GPU 被离线渲染占用');
    if (result.lastError) bits.push(`错误 ${result.lastError}`);
    const text = result.ok ? `就绪（${bits.join(' · ') || '空闲'}）` : `不可用：${result.detail || '未启动'}`;
    $('realtime-check-result').textContent = text;
    $('realtime-check-result').style.color = result.ok ? 'var(--success)' : 'var(--danger)';
  } catch (err) {
    $('realtime-check-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ================= 运行环境（GPU / 健康） ================= */
function renderSystem(snap) {
  if (!snap) return;
  state.system = snap;
  const gpu = snap.gpu || {};
  const lock = snap.gpuLock || {};

  if (gpu.available) {
    const ratio = gpu.totalMb ? Math.round((gpu.usedMb / gpu.totalMb) * 100) : 0;
    $('gpu-name').textContent = `${gpu.name} · ${gpu.totalMb} MB`;
    $('gpu-vram').textContent = `${gpu.usedMb} / ${gpu.totalMb} MB（${ratio}%）`;
    $('gpu-vram-bar').style.width = `${ratio}%`;
    $('gpu-util').textContent = `${gpu.utilPct}%`;
    $('gpu-util-bar').style.width = `${gpu.utilPct}%`;
    $('gpu-temp').textContent = `${gpu.tempC}°C`;
    $('gpu-temp-bar').style.width = `${Math.min(100, gpu.tempC)}%`;
    $('badge-gpu').textContent = `显存 ${ratio}%`;
    $('badge-gpu').style.color = ratio > 90 ? 'var(--danger)' : 'var(--muted)';
  } else {
    $('gpu-name').textContent = gpu.detail || '未检测到 NVIDIA GPU';
    $('gpu-vram').textContent = '不可用';
    $('gpu-vram-bar').style.width = '0%';
    $('gpu-util').textContent = '-';
    $('gpu-util-bar').style.width = '0%';
    $('gpu-temp').textContent = '-';
    $('gpu-temp-bar').style.width = '0%';
    $('badge-gpu').textContent = '显存 -';
  }

  $('gpu-lock').textContent = lock.locked ? '被占用' : '空闲';
  $('gpu-lock').style.color = lock.locked ? 'var(--warn)' : 'var(--success)';
  $('gpu-lock-detail').textContent = lock.locked
    ? `${lock.owner || '未知'} · pid ${lock.pid || '-'} · ${fmtDuration(lock.ageSec || 0)}`
    : '离线渲染与实时互动可立即抢占';

  const chips = [];
  const running = state.services.filter((s) => s.status === 'running').length;
  chips.push(`<span class="chip ${running ? 'ok' : ''}"><i class="dot"></i>服务 ${running}/${state.services.length}</span>`);
  chips.push(`<span class="chip ${state.llm.configured ? 'ok' : 'warn'}"><i class="dot"></i>LLM ${state.llm.configured ? '已配置' : '未配置'}</span>`);
  chips.push(`<span class="chip ${lock.locked ? 'warn' : 'ok'}"><i class="dot"></i>GPU ${lock.locked ? '锁定' : '空闲'}</span>`);
  $('runtime-chips').innerHTML = chips.join('');

  const services = snap.services || {};
  $('health-strip').innerHTML = state.services.map((svc) => {
    const h = services[svc.id] || { reachable: false, skipped: true, detail: '未运行' };
    let kind = '';
    let detail = h.detail || '-';
    if (h.skipped) kind = '';
    else if (!h.reachable) { kind = 'bad'; detail = h.detail || '不可达'; }
    else if (h.httpStatus && h.httpStatus !== 200) { kind = 'warn'; detail = `HTTP ${h.httpStatus}`; }
    else if (h.busy || h.gpuLocked) { kind = 'warn'; detail = h.busy ? '推理中' : 'GPU 锁定'; }
    else { kind = 'ok'; detail = h.modelLoaded ? '模型就绪' : '健康'; }
    return `<div class="health-item ${kind}">
      <i class="dot"></i><b>${esc(svc.name)}</b><span>${esc(detail)}</span>
      ${h.latencyMs !== undefined ? `<span class="lat">${h.latencyMs}ms</span>` : ''}
    </div>`;
  }).join('') || '<span class="muted">未配置服务</span>';

  renderServices();
}

/* ================= 模型与音色 ================= */
const CAP_KIND = { training: '训练', inference: '推理', prep: '预处理', prepare: '预处理' };
const MODEL_KEYS = [
  'cloud.deepseek.model',
  'cloud.tts.voice',
  'muse.version',
  'muse.useFloat16',
  'soulx.modelPath',
  'soulx.svcModelPath',
  'soulx.control',
  'soulx.device',
  'soulx.fp16'
];

function renderModelForm() {
  const holder = $('model-form');
  if (!holder || !state.schema) return;
  const fields = [];
  for (const group of state.schema.groups) {
    for (const field of group.fields) if (MODEL_KEYS.includes(field.key)) fields.push(field);
  }
  holder.innerHTML = fields.map(fieldHtml).join('') +
    '<div class="field full model-actions"><button class="btn primary" id="btn-model-save">保存模型选择</button></div>';
}

$('model-form').addEventListener('click', async (event) => {
  if (!event.target.closest('#btn-model-save')) return;
  try {
    await saveControls($('model-form'));
    renderModelForm();
    renderServices();
    toast('模型选择已保存，重启对应服务后生效', 'success');
  } catch (err) {
    toast(`保存失败: ${err.message}`, 'error');
  }
});

/** 音色试听：全局只保留一个播放器，再次点击同一条即停止 */
const voicePreview = { audio: null, btn: null };

function stopVoicePreview() {
  if (voicePreview.audio) {
    voicePreview.audio.pause();
    voicePreview.audio = null;
  }
  if (voicePreview.btn) {
    voicePreview.btn.textContent = '▶ 试听';
    voicePreview.btn = null;
  }
}

function previewVoice(btn) {
  if (voicePreview.btn === btn) {
    stopVoicePreview();
    return;
  }
  stopVoicePreview();
  const audio = new Audio(btn.dataset.src);
  voicePreview.audio = audio;
  voicePreview.btn = btn;
  btn.textContent = '■ 停止';
  audio.addEventListener('ended', stopVoicePreview);
  audio.play().catch(() => {
    stopVoicePreview();
    toast('试听失败：音频无法播放', 'error');
  });
}

async function refreshVoices() {
  stopVoicePreview();
  try {
    state.voices = await call(api.voice.list(), '读取音色库');
    renderVoices();
  } catch (_) { /* ignore */ }
}

function renderVoices() {
  const holder = $('voice-list');
  if (!holder) return;
  if (!state.voices.length) {
    holder.innerHTML = '<div class="empty-row">还没有可用音色。导入一段 10–30 秒的清晰人声，标注后即可使用。</div>';
    return;
  }
  holder.innerHTML = state.voices.map((voice) => `
    <div class="list-row voice-cols">
      <div class="cell-name" title="${esc(voice.audioPath)}">
        <div>${esc(voice.name)}</div>
        <div class="cell-sub">${esc(voice.metaPath || '')}</div>
      </div>
      <div><span class="tag ${voice.source === 'user' ? 'audio' : 'video'}">${voice.source === 'user' ? '用户' : '内置'}</span></div>
      <div class="cell-sub">${voice.segments || 0}</div>
      <div class="cell-sub">${fmtBytes(voice.size)}</div>
      <div>${voice.isDefault ? '<span class="tag done">默认</span>' : '<span class="cell-sub">备用</span>'}</div>
      <div class="cell-actions">
        <button class="btn tiny ghost voice-play" data-voice="play" data-src="${esc(asFileUrl(voice.audioPath))}">▶ 试听</button>
        <button class="btn tiny ghost" data-voice="default" data-id="${esc(voice.id)}" ${voice.isDefault ? 'disabled' : ''}>设为默认</button>
        ${voice.source === 'user' ? `<button class="btn tiny ghost" data-voice="remove" data-id="${esc(voice.id)}">删除</button>` : ''}
      </div>
    </div>`).join('');
}

function renderCapabilities() {
  const holder = $('cap-grid');
  if (!holder || !state.capabilities) return;
  const cap = state.capabilities;
  const gpu = cap.gpu || {};
  const gpuLine = gpu.available
    ? `${gpu.name} · ${gpu.usedMb}/${gpu.totalMb} MB`
    : '未检测到 NVIDIA GPU';
  if ($('training-note')) {
    $('training-note').textContent =
      `当前硬件：${gpuLine}。SoulX-Singer 属于零样本方案，官方未提供微调训练代码；` +
      'MuseTalk 训练脚本参考卡为 V100 32GB，LatentSync 训练需 23–30GB 显存，本机均无法运行。' +
      '可行路径是「音色样本标注 + 零样本克隆」与「形象预处理」，它们决定咬字、转音与真人感的上限。';
  }
  holder.innerHTML = cap.tasks.map((task) => {
    const label = task.canRun ? '可运行' : (task.blockedBy === 'not-supported' ? '本机不可行' : '显存不足');
    return `
      <div class="cap-card">
        <div class="cap-top">
          <div>
            <div class="cap-name">${esc(task.name)}</div>
            <div class="cap-kind">${esc(CAP_KIND[task.kind] || task.kind)}${task.minVramMb ? ` · 需 ${Math.round(task.minVramMb / 1024)}GB 显存` : ''}</div>
          </div>
          <span class="cap-state ${task.canRun ? 'ready' : 'blocked'}">${label}</span>
        </div>
        <div class="cap-reason">${esc(task.reason)}</div>
        ${task.alternative ? `<div class="cap-alt">替代：${esc(task.alternative)}</div>` : ''}
      </div>`;
  }).join('');
}

async function refreshCapabilities() {
  try {
    state.capabilities = await call(api.capabilities.list(), '读取能力矩阵');
    renderCapabilities();
  } catch (_) { /* ignore */ }
}

$('voice-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-voice]');
  if (!btn) return;
  if (btn.dataset.voice === 'play') {
    previewVoice(btn);
    return;
  }
  btn.disabled = true;
  try {
    if (btn.dataset.voice === 'default') {
      await call(api.voice.setDefault(btn.dataset.id), '切换默认音色');
      toast('默认音色已切换', 'success');
    } else if (btn.dataset.voice === 'remove') {
      await call(api.voice.remove(btn.dataset.id), '删除音色');
      toast('音色已删除', 'success');
    }
    await refreshVoices();
  } catch (_) {
    btn.disabled = false;
  }
});

$('btn-voice-refresh').addEventListener('click', refreshVoices);

$('btn-voice-import').addEventListener('click', async () => {
  try {
    const file = await call(api.dialog.pickFile({
      title: '选择音色样本（10–30 秒清晰人声）',
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
    }), '选择音色样本');
    if (!file) return;
    const imported = await call(api.voice.import(file), '导入音色样本');
    await refreshVoices();
    if (!imported.needsAnnotation) {
      toast('音色已导入（含标注）', 'success');
      return;
    }
    const run = window.confirm(`「${imported.name}」缺少标注 JSON，是否现在生成？（需要 GPU，约数十秒）`);
    if (!run) {
      toast('已导入，但未标注的音色暂不可用', 'warn');
      return;
    }
    toast('正在标注音色样本…');
    const info = await call(api.voice.annotate(imported.audioPath), '标注音色样本');
    toast(`标注完成：${info.segments} 个段落`, 'success');
    await refreshVoices();
  } catch (_) { /* toast 已提示 */ }
});

$('btn-clone-pick').addEventListener('click', async () => {
  try {
    const file = await call(api.dialog.pickFile({
      title: '选择源歌声',
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
    }), '选择源歌声');
    if (file) $('clone-source').value = file;
  } catch (_) { /* ignore */ }
});

$('btn-clone-add').addEventListener('click', async () => {
  const source = $('clone-source').value.trim();
  if (!source) return toast('请选择源歌声文件', 'warn');
  const pitch = Number($('clone-pitch').value) || 0;
  const name = source.split(/[\\/]/).pop();
  try {
    await call(api.queue.add({
      type: 'clone',
      title: `音色克隆 · ${name}`,
      payload: { audioPath: source, pitchShift: pitch }
    }), '加入队列');
    $('clone-source').value = '';
    toast('音色克隆任务已入队', 'success');
    await refreshQueue();
  } catch (_) { /* ignore */ }
});

/* ================= 顶栏交互 ================= */
document.querySelector('.state-actions').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-goto]');
  if (!btn) return;
  try {
    state.orch = await call(api.orchestrator.transition(btn.dataset.goto, '控制台手动切换'), '切换场景');
    renderOrchestrator();
    renderKpis();
    toast(`已切换到 ${state.orch.label}`, 'success');
  } catch (_) { /* toast 已提示 */ }
});

$('live-toggle').addEventListener('click', async () => {
  try {
    state.orch = await call(api.orchestrator.setLive(!(state.orch && state.orch.live)), '切换直播状态');
    renderOrchestrator();
  } catch (_) { /* ignore */ }
});

/* ================= 日志 ================= */
function renderLogs() {
  const body = $('log-body');
  const list = state.logs.filter((entry) => state.logLevel === 'all' || entry.level === state.logLevel);
  const slice = list.slice(-600);
  body.innerHTML = slice.map((entry) => `
    <div class="log-line ${esc(entry.level)}">
      <span class="log-time">${fmtClock(new Date(entry.time).getTime())}</span>
      <span class="log-scope">[${esc(entry.scope)}]</span>
      <span class="log-msg">${esc(entry.message)}</span>
    </div>`).join('');
  body.scrollTop = body.scrollHeight;
  $('log-count').textContent = `${list.length} 条`;
}

function pushLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 3000) state.logs.splice(0, state.logs.length - 3000);
  if (state.logLevel === 'all' || entry.level === state.logLevel) {
    const body = $('log-body');
    const div = document.createElement('div');
    div.className = `log-line ${entry.level}`;
    div.innerHTML = `<span class="log-time">${fmtClock(new Date(entry.time).getTime())}</span>
      <span class="log-scope">[${esc(entry.scope)}]</span>
      <span class="log-msg">${esc(entry.message)}</span>`;
    body.appendChild(div);
    while (body.childElementCount > 600) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }
  $('log-count').textContent = `${state.logs.filter((e) => state.logLevel === 'all' || e.level === state.logLevel).length} 条`;
}

/* ================= 定时刷新 ================= */
function startTicker() {
  setInterval(() => {
    if (state.orch) {
      state.orch.uptimeSec = Math.floor((Date.now() - state.orch.since) / 1000);
      $('state-uptime').textContent = fmtDuration(state.orch.uptimeSec);
    }
    if (state.stream && state.stream.startedAt) {
      state.stream.uptimeSec = Math.floor((Date.now() - state.stream.startedAt) / 1000);
      $('stream-uptime').textContent = fmtDuration(state.stream.uptimeSec);
    }
    if (state.services.some((s) => s.status === 'running')) {
      state.services.forEach((s) => {
        if (s.startedAt) s.uptimeSec = Math.floor((Date.now() - s.startedAt) / 1000);
      });
      renderServices();
    }
    if (state.queue.some((j) => j.status === 'running')) renderQueue();
  }, 1000);
}

/* ================= 初始化 ================= */
async function init() {
  bindNav();

  try {
    state.app = await call(api.app.info(), '读取应用信息');
    state.config = await call(api.config.get(), '读取配置');
    state.schema = await call(api.config.schema(), '读取设置表单');
    state.services = await call(api.services.list(), '读取服务');
    state.orch = await call(api.orchestrator.get(), '读取状态机');
    state.queue = await call(api.queue.list(), '读取队列');
    state.stream = await call(api.stream.status(), '读取推流状态');
    state.llm = await call(api.llm.status(), '读取 LLM 状态');
    state.logs = await call(api.logs.recent(400), '读取日志');
    state.system = await call(api.system.stats(true), '读取运行环境');
  } catch (err) {
    toast(`初始化失败: ${err.message}`, 'error');
  }

  if (state.app) {
    $('env-info').textContent =
      `Electron ${state.app.electron} · Node ${state.app.node} · ${state.app.platform} · 数据目录 ${state.app.appDir}\\data`;
    $('app-version').textContent = `v${state.app.version}`;
  }
  renderSettingsGroups();
  renderServiceSettings();
  renderCloudPanel();
  renderCloudProgress();
  renderModelForm();
  renderOrchestrator();
  renderKpis();
  renderServices();
  renderQueue();
  renderStream();
  renderLogs();
  if (state.system) renderSystem(state.system);
  startTicker();
  refreshLibrary();
  refreshVoices();
  refreshCapabilities();
  refreshDownloads();
  refreshCloudOverview();
}

api.onEvent(({ type, payload }) => {
  if (type === 'log') {
    pushLog(payload);
    return;
  }
  if (type === 'service') {
    const index = state.services.findIndex((s) => s.id === payload.id);
    if (index >= 0) state.services[index] = payload;
    else state.services.push(payload);
    renderServices();
    renderKpis();
    renderOrchestrator();
    if (payload.status === 'error') toast(`${payload.name}: ${payload.lastError || '启动失败'}`, 'error');
    if (payload.status === 'running') {
      toast(`${payload.name} 已就绪`, 'success');
      if (payload.id === 'realtime') refreshInteractStatus();
    }
    return;
  }
  if (type === 'system') {
    renderSystem(payload);
    return;
  }
  if (type === 'orchestrator') {
    state.orch = payload;
    renderOrchestrator();
    renderKpis();
    return;
  }
  if (type === 'queue') {
    refreshQueue();
    return;
  }
  if (type === 'stream') {
    state.stream = payload;
    renderStream();
    renderKpis();
    return;
  }
  if (type === 'interaction') {
    if (payload.phase === 'start') setInteractStatus('互动回合开始…', 'busy');
    if (payload.phase === 'llm') setInteractStatus('云端 LLM 生成回应…', 'busy');
    if (payload.phase === 'render') setInteractStatus('edge-tts 合成 + MuseTalk 口型渲染中…', 'busy');
    if (payload.phase === 'error') setInteractStatus(`互动失败: ${payload.error}`, 'error');
    if (payload.phase === 'done' && payload.turn) setInteractStatus(`本轮完成 ${payload.turn.totalMs}ms`);
    return;
  }
  if (type === 'danmu') {
    (payload.events || []).forEach(appendDanmuEvent);
    return;
  }
  if (type === 'danmuState') {
    renderDanmuState(payload);
    return;
  }
  if (type === 'cloud') {
    state.cloud.progress.push(payload);
    if (state.cloud.progress.length > 200) state.cloud.progress.shift();
    renderCloudProgress();
    renderCloudPanel();
    renderOvCloudProgress();
    if (payload.step === 'done' || payload.step === 'release') {
      Promise.all([api.config.get(), api.services.list()]).then(([cfg, svcs]) => {
        if (cfg && cfg.ok) state.config = cfg.data;
        if (svcs && svcs.ok) state.services = svcs.data;
        renderCloudPanel();
        renderServices();
        renderServiceSettings();
        renderKpis();
        refreshCloudOverview();
      }).catch(() => {});
    }
    return;
  }
  if (type === 'download') {
    const item = state.downloads.find((d) => d.id === payload.id);
    if (item) {
      item.progress = payload;
      if (payload.state === 'running') item.state = 'running';
      if (payload.state === 'error') { item.state = 'error'; item.lastError = payload.label; }
    }
    renderDownloads();
    if (payload.state === 'done' || payload.state === 'error') {
      api.downloads.status().then((res) => {
        if (res && res.ok) state.downloads = res.data;
        renderDownloads();
        renderServices();
      }).catch(() => {});
      // 下载成功后配置可能被回写（tools/ 路径），刷新服务与设置
      Promise.all([api.config.get(), api.services.list()]).then(([cfg, svcs]) => {
        if (cfg && cfg.ok) state.config = cfg.data;
        if (svcs && svcs.ok) state.services = svcs.data;
        renderServices();
        renderServiceSettings();
        renderKpis();
      }).catch(() => {});
    }
    return;
  }
});

init().then(async () => {
  console.log('[ui] dashboard ready');
  refreshInteractStatus();
  try {
    renderDanmuState(await call(api.danmu.status(), '读取弹幕状态'));
  } catch (_) { /* ignore */ }
});
