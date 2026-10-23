'use strict';

const { ipcMain, shell, dialog, BrowserWindow } = require('electron');
const path = require('path');
const { GROUPS } = require('./config-schema');
const { capabilities } = require('./training');

function ok(data) { return { ok: true, data }; }
function fail(error) { return { ok: false, error: error.message || String(error) }; }

function wrap(fn) {
  return async (_event, payload) => {
    try {
      return ok(await fn(payload));
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * 主进程 IPC 注册：渲染进程通过 preload 暴露的 consoleApi 调用。
 */
function registerIpc(ctx) {
  const { config, logger, services, orchestrator, queue, stream, library, llm, tts, muse, soulx, realtime, interaction, danmuCtl, monitor, voices, cloudDeployer, downloadManager, preview, appDir } = ctx;

  ipcMain.handle('app:info', wrap(async () => ({
    appDir,
    version: process.env.npm_package_version || '0.1.0',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform
  })));

  ipcMain.handle('config:get', wrap(async () => config.publicView()));
  ipcMain.handle('config:set', wrap(async ({ path: key, value }) => {
    config.set(key, value);
    logger.info('config', `配置更新: ${key}`);
    return config.publicView();
  }));
  ipcMain.handle('config:schema', wrap(async () => ({ groups: GROUPS })));

  ipcMain.handle('services:list', wrap(async () => services.list()));
  ipcMain.handle('services:start', wrap(async ({ id }) => services.start(id)));
  ipcMain.handle('services:stop', wrap(async ({ id }) => services.stop(id)));
  ipcMain.handle('services:restart', wrap(async ({ id }) => services.restart(id)));
  ipcMain.handle('services:stopAll', wrap(async () => { await services.stopAll(); return services.list(); }));
  ipcMain.handle('services:probe', wrap(async ({ id }) => (monitor ? monitor.probe(id) : { id, reachable: false, detail: '监控未初始化' })));
  ipcMain.handle('config:setService', wrap(async ({ id, patch }) => {
    config.setService(id, patch);
    services.reloadSpecs();
    logger.info('config', `服务参数更新: ${id}`);
    return services.list();
  }));

  ipcMain.handle('system:stats', wrap(async ({ force } = {}) => (monitor ? monitor.stats({ force: Boolean(force) }) : null)));
  ipcMain.handle('capability:list', wrap(async () => {
    const snap = monitor ? await monitor.stats() : null;
    return capabilities({ config, gpu: snap ? snap.gpu : null, services: services.list() });
  }));

  ipcMain.handle('voice:list', wrap(async () => (voices ? voices.list() : [])));
  ipcMain.handle('voice:import', wrap(async ({ audioPath }) => voices.import(audioPath)));
  ipcMain.handle('voice:setDefault', wrap(async ({ id }) => voices.setDefault(id)));
  ipcMain.handle('voice:remove', wrap(async ({ id }) => voices.remove(id)));
  ipcMain.handle('voice:annotate', wrap(async ({ audioPath }) => voices.annotate(config.resolvePath(audioPath))));

  ipcMain.handle('orchestrator:get', wrap(async () => orchestrator.snapshot()));
  ipcMain.handle('orchestrator:transition', wrap(async ({ next, reason, song }) =>
    orchestrator.transition(next, reason || '手动切换', { song })));
  ipcMain.handle('orchestrator:live', wrap(async ({ live }) => orchestrator.setLive(live)));

  ipcMain.handle('queue:list', wrap(async () => queue.list()));
  ipcMain.handle('queue:add', wrap(async (job) => queue.add(job)));
  ipcMain.handle('queue:retry', wrap(async ({ id }) => queue.retry(id)));
  ipcMain.handle('queue:cancel', wrap(async ({ id }) => queue.cancel(id)));
  ipcMain.handle('queue:clear', wrap(async () => queue.clearFinished()));

  ipcMain.handle('stream:status', wrap(async () => stream.snapshot()));
  ipcMain.handle('stream:start', wrap(async (opts) => {
    const options = opts || {};
    if (config.get('stream.track', 'file') === 'interact') {
      const turns = interaction.snapshot().turns;
      const last = turns[turns.length - 1];
      if (!last) throw new Error('暂无互动画面，请先在互动试验台生成一次回复');
      return stream.start({ ...options, videoSource: last.videoPath });
    }
    return stream.start(options);
  }));
  ipcMain.handle('stream:stop', wrap(async () => stream.stop()));

  ipcMain.handle('library:list', wrap(async () => library.list()));
  ipcMain.handle('library:addRoot', wrap(async ({ root }) => library.addRoot(root)));
  ipcMain.handle('library:reveal', wrap(async ({ target }) => {
    shell.showItemInFolder(target);
    return true;
  }));
  ipcMain.handle('library:open', wrap(async ({ target }) => {
    await shell.openPath(target);
    return true;
  }));

  ipcMain.handle('llm:chat', wrap(async (opts) => llm.chat(opts)));
  ipcMain.handle('llm:reset', wrap(async () => { llm.reset(); return true; }));
  ipcMain.handle('llm:status', wrap(async () => ({
    configured: llm.isConfigured(),
    model: config.get('cloud.deepseek.model'),
    baseUrl: config.get('cloud.deepseek.baseUrl')
  })));

  ipcMain.handle('tts:check', wrap(async () => tts.check()));
  ipcMain.handle('tts:speak', wrap(async (opts) => tts.synthesize(opts)));

  ipcMain.handle('muse:check', wrap(async () => muse.check()));
  ipcMain.handle('muse:stop', wrap(async () => muse.stop()));

  ipcMain.handle('soulx:check', wrap(async () => (soulx ? soulx.check() : { ok: false, detail: '适配器未初始化' })));

  ipcMain.handle('interact:talk', wrap(async (opts) => interaction.talk(opts || {})));
  ipcMain.handle('interact:stt', wrap(async (opts) => interaction.stt(opts || {})));
  ipcMain.handle('interact:status', wrap(async () => interaction.status()));
  ipcMain.handle('interact:prepareAvatar', wrap(async (opts) => interaction.prepareAvatar(opts || {})));

  ipcMain.handle('danmu:status', wrap(async () => danmuCtl.snapshot()));
  ipcMain.handle('danmu:connect', wrap(async (opts) => danmuCtl.connect(opts || {})));
  ipcMain.handle('danmu:disconnect', wrap(async () => danmuCtl.disconnect()));
  ipcMain.handle('danmu:reply', wrap(async ({ text }) => danmuCtl.manualReply(text)));
  ipcMain.handle('danmu:mock', wrap(async (opts) => danmuCtl.mock(opts || {})));
  ipcMain.handle('realtime:health', wrap(async () => realtime.health()));
  ipcMain.handle('realtime:unload', wrap(async () => realtime.unload()));

  ipcMain.handle('cloud:balance', wrap(async () => cloudDeployer.balance()));
  ipcMain.handle('cloud:deploy', wrap(async ({ serviceId, gpuSpecUuid } = {}) => cloudDeployer.deploy({ serviceId, gpuSpecUuid })));
  ipcMain.handle('cloud:instances', wrap(async () => cloudDeployer.instances()));
  ipcMain.handle('cloud:release', wrap(async ({ serviceId } = {}) => cloudDeployer.release({ serviceId })));
  ipcMain.handle('cloud:save-image', wrap(async ({ serviceId, imageName } = {}) => cloudDeployer.saveImage({ serviceId, imageName })));
  ipcMain.handle('cloud:images', wrap(async () => cloudDeployer.listImages()));

  ipcMain.handle('download:status', wrap(async () => (downloadManager ? downloadManager.list() : [])));
  ipcMain.handle('download:start', wrap(async ({ id } = {}) => {
    if (!downloadManager) throw new Error('下载管理器未初始化');
    return downloadManager.start(id);
  }));

  ipcMain.handle('preview:status', wrap(async () => (preview ? preview.snapshot() : null)));
  ipcMain.handle('preview:start', wrap(async (opts = {}) => {
    if (!preview) throw new Error('预览模块未初始化');
    return preview.start(opts);
  }));
  ipcMain.handle('preview:stop', wrap(async () => {
    if (!preview) return null;
    preview.stop();
    return preview.snapshot();
  }));
  ipcMain.handle('preview:set-source', wrap(async ({ source } = {}) => {
    if (!preview) throw new Error('预览模块未初始化');
    return preview.setSource(source);
  }));

  ipcMain.handle('logs:recent', wrap(async ({ limit } = {}) => logger.recent(limit || 400)));

  ipcMain.handle('dialog:pickFile', wrap(async ({ filters, title } = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: title || '选择文件',
      properties: ['openFile'],
      filters: filters || [{ name: '媒体文件', extensions: ['mp4', 'mov', 'mkv', 'wav', 'mp3'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  }));

  ipcMain.handle('dialog:pickDirectory', wrap(async ({ title } = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: title || '选择目录',
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  }));

  ipcMain.handle('app:openExternal', wrap(async ({ url }) => { await shell.openExternal(url); return true; }));
  ipcMain.handle('app:openPath', wrap(async ({ target }) => { await shell.openPath(path.resolve(target)); return true; }));
}

module.exports = { registerIpc };
