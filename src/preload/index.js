'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('consoleApi', {
  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', { url }),
    openPath: (target) => invoke('app:openPath', { target })
  },
  config: {
    get: () => invoke('config:get'),
    set: (path, value) => invoke('config:set', { path, value }),
    schema: () => invoke('config:schema'),
    setService: (id, patch) => invoke('config:setService', { id, patch })
  },
  services: {
    list: () => invoke('services:list'),
    start: (id) => invoke('services:start', { id }),
    stop: (id) => invoke('services:stop', { id }),
    restart: (id) => invoke('services:restart', { id }),
    stopAll: () => invoke('services:stopAll'),
    probe: (id) => invoke('services:probe', { id })
  },
  system: {
    stats: (force) => invoke('system:stats', { force: Boolean(force) })
  },
  capabilities: {
    list: () => invoke('capability:list')
  },
  voice: {
    list: () => invoke('voice:list'),
    import: (audioPath) => invoke('voice:import', { audioPath }),
    setDefault: (id) => invoke('voice:setDefault', { id }),
    remove: (id) => invoke('voice:remove', { id }),
    annotate: (audioPath) => invoke('voice:annotate', { audioPath })
  },
  orchestrator: {
    get: () => invoke('orchestrator:get'),
    transition: (next, reason, song) => invoke('orchestrator:transition', { next, reason, song }),
    setLive: (live) => invoke('orchestrator:live', { live })
  },
  queue: {
    list: () => invoke('queue:list'),
    add: (job) => invoke('queue:add', job),
    retry: (id) => invoke('queue:retry', { id }),
    cancel: (id) => invoke('queue:cancel', { id }),
    clear: () => invoke('queue:clear')
  },
  stream: {
    status: () => invoke('stream:status'),
    start: (opts) => invoke('stream:start', opts),
    stop: () => invoke('stream:stop')
  },
  library: {
    list: () => invoke('library:list'),
    addRoot: (root) => invoke('library:addRoot', { root }),
    reveal: (target) => invoke('library:reveal', { target }),
    open: (target) => invoke('library:open', { target })
  },
  llm: {
    chat: (opts) => invoke('llm:chat', opts),
    reset: () => invoke('llm:reset'),
    status: () => invoke('llm:status')
  },
  tts: {
    check: () => invoke('tts:check'),
    speak: (opts) => invoke('tts:speak', opts)
  },
  muse: {
    check: () => invoke('muse:check'),
    stop: () => invoke('muse:stop')
  },
  soulx: {
    check: () => invoke('soulx:check')
  },
  interact: {
    talk: (opts) => invoke('interact:talk', opts),
    stt: (opts) => invoke('interact:stt', opts),
    status: () => invoke('interact:status'),
    prepareAvatar: (opts) => invoke('interact:prepareAvatar', opts)
  },
  danmu: {
    status: () => invoke('danmu:status'),
    connect: (opts) => invoke('danmu:connect', opts),
    disconnect: () => invoke('danmu:disconnect'),
    reply: (text) => invoke('danmu:reply', { text }),
    mock: (opts) => invoke('danmu:mock', opts)
  },
  realtime: {
    health: () => invoke('realtime:health'),
    unload: () => invoke('realtime:unload')
  },
  cloud: {
    balance: () => invoke('cloud:balance'),
    deploy: (serviceId, gpuSpecUuid) => invoke('cloud:deploy', { serviceId, gpuSpecUuid }),
    instances: () => invoke('cloud:instances'),
    release: (serviceId) => invoke('cloud:release', { serviceId }),
    saveImage: (serviceId, imageName) => invoke('cloud:save-image', { serviceId, imageName }),
    images: () => invoke('cloud:images')
  },
  downloads: {
    status: () => invoke('download:status'),
    start: (id) => invoke('download:start', { id })
  },
  logs: {
    recent: (limit) => invoke('logs:recent', { limit })
  },
  dialog: {
    pickFile: (filters) => invoke('dialog:pickFile', { filters }),
    pickDirectory: () => invoke('dialog:pickDirectory')
  },
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('push:event', listener);
    return () => ipcRenderer.removeListener('push:event', listener);
  }
});
