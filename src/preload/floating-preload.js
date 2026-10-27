'use strict';

// Preload for the floating player's own window (not the TikTok guest).
//
// The window is a plain local page. Everything it is allowed to do is listed
// here: read the queue the main process built, resolve the guest preload path,
// ask the feed for more clips, and close/return. No DOM of the main app and no
// filesystem access cross this bridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('floatApi', {
  init: () => ipcRenderer.invoke('floating:init'),
  guestPreloadUrl: () => ipcRenderer.invoke('floating:guestPreloadUrl'),
  more: (previous) => ipcRenderer.invoke('floating:more', previous),
  returnToTab: () => ipcRenderer.send('floating:return'),
  close: () => ipcRenderer.send('floating:close'),
});
