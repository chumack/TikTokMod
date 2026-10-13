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
  live: {
    resolve: (input) => invoke('live:resolve', input),
    detect: () => invoke('live:detect'),
    // `opts` carries `{ withChat }`. Dropping it here silently killed chat: the
    // main handler's second parameter would always be `{}`, so the ChatSink was
    // never opened and no .chat.* files were written, with no error anywhere.
    start: (room, opts) => invoke('live:start', room, opts),
    stop: (id) => invoke('live:stop', id),
    stopAll: () => invoke('live:stopAll'),
    status: () => invoke('live:status'),
    // High-frequency one-way path for intercepted chat frames, so it is a send
    // rather than an invoke: nothing waits on a reply, and an unhandled invoke
    // rejection on every frame would be noise in a busy room.
    sendWsFrames: (frames) => ipcRenderer.send('live:wsFrames', frames),
    onProgress: (cb) => on('live:progress', cb),
    onDone: (cb) => on('live:done', cb),
    onError: (cb) => on('live:error', cb),
    onChat: (cb) => on('live:chat', cb),
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
  ui: {
    zoom: (factor) => invoke('ui:zoom', factor),
  },
  clipboard: {
    write: (text) => invoke('clipboard:write', text),
  },
  platform: process.platform,
});