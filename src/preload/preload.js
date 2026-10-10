'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
};

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    pickDir: () => invoke('settings:pickDir'),
    reveal: (p) => invoke('settings:reveal', p),
  },
  yt: {
    probe: (url) => invoke('yt:probe', url),
    classify: (url) => invoke('yt:classify', url),
    probeBatch: (urls) => invoke('yt:probeBatch', urls),
    author: (handle, cursor) => invoke('yt:author', { handle, cursor }),
    download: (url, id) => invoke('yt:download', { url, id }),
    cancel: (id) => invoke('yt:cancel', id),
    cancelAll: () => invoke('yt:cancelAll'),
    version: () => invoke('yt:version'),
    status: () => invoke('yt:status'),
    onProbeItem: (cb) => on('yt:probeItem', cb),
    onRedirectDownload: (cb) => on('yt:redirectDownload', cb),
    onProgress: (cb) => on('yt:progress', cb),
    onDone: (cb) => on('yt:done', cb),
    onError: (cb) => on('yt:error', cb),
  },
  media: {
    save: (url, filename) => invoke('media:save', { url, filename }),
  },
  feed: {
    register: (webContentsId) => invoke('feed:register', webContentsId),
    collect: (opts) => invoke('feed:collect', opts),
    currentVideo: (x, y) => invoke('feed:currentVideo', { x, y }),
    currentPlaying: () => invoke('feed:currentPlaying'),
    guestPreloadUrl: () => invoke('feed:guestPreloadUrl'),
    onMenuAction: (cb) => on('feed:menuAction', cb),
  },
  geo: {
    inspect: () => invoke('geo:inspect'),
    profiles: () => invoke('geo:profiles'),
    params: () => invoke('geo:params'),
    check: (videoUrl) => invoke('geo:check', videoUrl),
  },
  signer: {
    status: () => invoke('signer:status'),
    selfTest: () => invoke('signer:selfTest'),
  },
  net: {
    probe: (url) => invoke('net:probe', url),
  },
  nav: {
    open: (url) => invoke('nav:url', url),
  },
  clipboard: {
    write: (text) => invoke('clipboard:write', text),
  },
  platform: process.platform,
});