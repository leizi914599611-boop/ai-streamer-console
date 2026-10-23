'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu } = require('electron');

const { Logger } = require('./logger');
const { ConfigStore } = require('./config-store');
const { ServiceManager } = require('./service-manager');
const { Orchestrator } = require('./orchestrator');
const { RenderQueue } = require('./render-queue');
const { StreamController } = require('./stream-controller');
const { AssetLibrary } = require('./asset-library');
const { DeepSeekClient } = require('./adapters/deepseek');
const { EdgeTtsAdapter } = require('./adapters/edge-tts');
const { MuseTalkAdapter } = require('./adapters/musetalk');
const { SoulXAdapter } = require('./adapters/soulx');
const { RealtimeAdapter } = require('./adapters/realtime');
const { DanmuAdapter } = require('./adapters/danmu');
const { DanmuController } = require('./danmu-controller');
const { InteractionController } = require('./interaction');
const { GpuLock } = require('./gpu-lock');
const { SystemMonitor } = require('./system-monitor');
const { VoiceLibrary } = require('./voice-library');
const { CloudDeployer } = require('./cloud-deployer');
const { DownloadManager } = require('./download-manager');
const { StreamPreview } = require('./stream-preview');
const { registerIpc } = require('./ipc');

const appDir = path.resolve(__dirname, '..', '..');
const dataDir = path.join(appDir, 'data');

for (const dir of ['logs', 'audio', 'renders']) {
  fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
}

const logger = new Logger(path.join(dataDir, 'logs'));
const config = new ConfigStore({ appDir, logger });

const services = new ServiceManager({ config, logger });
const orchestrator = new Orchestrator({ config, logger });
const tts = new EdgeTtsAdapter({ config, logger });
const realtime = new RealtimeAdapter({ config, logger });
const gpuLock = new GpuLock({
  file: config.resolvePath(config.get('realtime.gpuLockFile', 'tools/MuseTalk/results/_realtime/gpu.lock')),
  owner: 'render-queue',
  logger
});
const muse = new MuseTalkAdapter({ config, logger, gpuLock, realtime });
const soulx = new SoulXAdapter({ config, logger, gpuLock, realtime });
const queue = new RenderQueue({ config, logger, orchestrator, muse, tts, soulx });
const stream = new StreamController({ config, logger });
const library = new AssetLibrary({ config, logger });
const llm = new DeepSeekClient({ config, logger });
const interaction = new InteractionController({ config, logger, orchestrator, realtime, llm, stream, soulx });
const danmu = new DanmuAdapter({ config, logger });
const danmuCtl = new DanmuController({ config, logger, danmu, interaction });
const monitor = new SystemMonitor({ config, logger, services });
const voices = new VoiceLibrary({ config, logger, soulx });
const cloudDeployer = new CloudDeployer({ config, logger });
const downloadManager = new DownloadManager({ config, logger, services });
const preview = new StreamPreview({ config, logger });

let mainWindow = null;

function broadcast(type, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('push:event', { type, payload });
}

logger.on('log', (entry) => broadcast('log', entry));
services.on('status', (snap) => broadcast('service', snap));
orchestrator.on('state', (snap) => broadcast('orchestrator', snap));
queue.on('job', (job) => broadcast('queue', job));
interaction.on('turn', (payload) => broadcast('interaction', payload));
danmuCtl.on('events', (events) => broadcast('danmu', { events }));
danmuCtl.on('state', (snap) => broadcast('danmuState', snap));
monitor.on('stats', (snap) => broadcast('system', snap));
cloudDeployer.on('progress', (payload) => broadcast('cloud', payload));
downloadManager.on('progress', (payload) => broadcast('download', payload));
preview.on('preview', (snap) => broadcast('preview', snap));

// 推流状态变化 → 预览自动启停 & 同步源
stream.on('stream', (snap) => {
  broadcast('stream', snap);
  if (snap.status === 'live' || snap.status === 'starting') {
    if (!preview.server) preview.start({ source: snap.videoSource });
    else preview.setSource(snap.videoSource);
  } else if (snap.status === 'offline' || snap.status === 'stopped') {
    // 推流停了不强制停预览，预览可以独立开（便于先看效果再开推流）
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#0a0d12',
    title: 'AI 歌手直播控制台',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const where = `${path.basename(sourceId || '')}:${line}`;
    if (level >= 2) logger.error('renderer', `${message} (${where})`);
    else logger.info('renderer', `${message} (${where})`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    logger.error('renderer', `页面加载失败 ${code}: ${desc}`);
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

registerIpc({
  config, logger, services, orchestrator, queue, stream, library, llm, tts, muse, soulx, realtime, interaction, danmuCtl,
  monitor, voices, cloudDeployer, downloadManager, preview, appDir
});

app.whenReady().then(async () => {
  logger.info('app', `控制台启动 ${appDir}`);
  createWindow();
  danmuCtl.start();
  monitor.start();

  for (const spec of services.list()) {
    if (spec.autoStart) {
      logger.info('app', `自动启动服务 ${spec.name}`);
      services.start(spec.id).catch((err) => logger.error('app', err.message));
    }
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  logger.info('app', '正在关闭：停止所有子服务');
  try {
    monitor.stop();
    preview.dispose();
    stream.stop();
    danmuCtl.stop();
    await services.stopAll();
  } catch (err) {
    logger.error('app', `关闭清理失败: ${err.message}`);
  }
  setTimeout(() => app.exit(0), 800);
});

process.on('uncaughtException', (err) => {
  logger.error('app', `未捕获异常: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error('app', `未处理 Promise 拒绝: ${reason?.stack || reason}`);
});
