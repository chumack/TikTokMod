'use strict';

// Bridge for the hidden audio-capture window (src/renderer/audio-capture.html).
//
// It exists for ONE reason: the recording logic runs in the page's MAIN world —
// getDisplayMedia, MediaRecorder and navigator.mediaDevices do not exist in the
// isolated world — and the main world has no ipcRenderer. contextBridge is the
// only hop Electron 33 actually delivers between the two worlds here (the same
// finding the chat tap is built on, see chatTapMainWorld in main.js).
//
// Everything is base64 in a plain string rather than a Uint8Array. contextBridge
// supports structured-clone-ish types, but a plain string survives any version of
// the serialiser, and the payload is ~0.5 KB of Opus per 200 ms chunk — the
// encode/decode cost is invisible next to the MediaRecorder itself.
//
// Every export is wrapped: this window is best-effort machinery, and an exception
// thrown across the bridge must never become an unhandled error in a renderer that
// has no user and no UI.

const { contextBridge, ipcRenderer } = require('electron');

function emit(channel, payload) {
  try {
    ipcRenderer.send(channel, payload);
  } catch (_) {
    /* the main-side capture is gone; nothing useful left to do */
  }
}

contextBridge.exposeInMainWorld('guestAudio', {
  /** One Opus chunk, base64. */
  chunk: (b64) => emit('guestAudio:chunks', String(b64 || '')),
  /** Recording actually started — carries the absolute Date.now() at that instant. */
  ready: (info) => emit('guestAudio:ready', info || {}),
  /** MediaRecorder stopped; everything it produced has been flushed. */
  done: (info) => emit('guestAudio:done', info || {}),
  /** getDisplayMedia / MediaRecorder refused. Reported, never thrown. */
  fail: (message) => emit('guestAudio:fail', String(message || '')),
});