'use strict';

// Preload for the <webview> guest (the TikTok page itself).
//
// Why this file exists: the embedder's DOM "context-menu" event never fires
// for a <webview> guest in Electron 33 (measured: 0 events). A preload runs
// inside the guest before the page's own scripts, so it can cancel the
// contextmenu default action — that default action IS Chromium's stock menu —
// and report the click to the main process.
//
// What is deliberately NOT cancelled is propagation: preventDefault() removes
// the native menu and leaves TikTok's own HTML menu to render. The app builds
// no menu of its own, so a right-click shows TikTok's menu and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

function describe(el, ev) {
  const out = {
    x: 0,
    y: 0,
    mediaType: 'none',
    srcURL: '',
    linkURL: '',
    isVideo: false,
  };
  // NOTE: coordinates live on the EVENT, not on event.target. Reading
  // clientX/clientY off the target always gave 0,0, so every right-click
  // resolved to the centre of the screen instead of the clicked clip.
  try {
    const cx = ev && typeof ev.clientX === 'number' ? ev.clientX : (el && el.clientX);
    const cy = ev && typeof ev.clientY === 'number' ? ev.clientY : (el && el.clientY);
    out.x = (cx | 0) || 0;
    out.y = (cy | 0) || 0;
  } catch (_) {}
  try {
    let node = el;
    for (let i = 0; i < 6 && node && node.nodeType === 1; i += 1, node = node.parentElement) {
      if (node.tagName === 'VIDEO') {
        out.isVideo = true;
        out.mediaType = 'video';
        const src = node.currentSrc || node.src || '';
        out.srcURL = src.slice(0, 500);
        break;
      }
      if (node.tagName === 'IMG') {
        out.mediaType = 'image';
        out.srcURL = (node.currentSrc || node.src || '').slice(0, 500);
        break;
      }
    }
    const a = el.closest && el.closest('a[href]');
    if (a) out.linkURL = a.href.slice(0, 500);
  } catch (_) {}
  return out;
}

const DOWNLOAD_ITEM_RE = /^загрузить\s+видео$/i;

// "Плавающий видеоплеер" / "Floating Player". The data-e2e attribute is the
// stable identifier: it comes from TikTok's own i18n key pcWeb_Floating and
// its menu row, which is rendered as
//   data-e2e="more-menu-popover_mini-player"
// The text is only a fallback for locales whose label we do not know.
const FLOATING_ITEM_RE = /^плавающий\s+видеоплеер$|^floating\s+player$/i;
const FLOATING_ITEM_E2E = 'more-menu-popover_mini-player';

function install() {
  // Guard on the document, not on window: TikTok's SPA swaps the document on
  // route changes, and a listener left on the old one is dead. Re-attaching per
  // document is what makes the interception survive navigation.
  if (window.__tkmPreloadHooks && window.__tkmPreloadDoc === document) return;
  window.__tkmPreloadHooks = true;
  window.__tkmPreloadDoc = document;
  document.addEventListener(
    'contextmenu',
    (event) => {
      // Cancel Chromium's own menu so it never opens over TikTok's. The page's
      // menu is left alone on purpose: no stopPropagation, so TikTok's own
      // handler still runs and draws its menu. The report is diagnostics only —
      // main paints nothing on it.
      event.preventDefault();
      const info = describe(event.target, event);
      ipcRenderer.send('feed:guestMenu', info);
    },
    true
  );

  // TikTok's "Загрузить видео" hands Chromium the watermarked downloadAddr,
  // which main.js then cancels in will-download — so clicking it used to look
  // like a broken download. Route it into the app's own queue instead, which
  // resolves the clean playAddr via yt-dlp. Capture phase so it wins over the
  // page's own handler.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      const text = target && target.textContent ? target.textContent.trim() : '';
      if (!DOWNLOAD_ITEM_RE.test(text)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send('feed:downloadCurrent');
    },
    true
  );

  // "Плавающий видеоплеер" is TikTok's "Floating Player" menu entry. TikTok
  // implements it with Document Picture-in-Picture, which Electron has never
  // supported (electron/electron#39633): the row is rendered because Blink
  // exposes window.documentPictureInPicture, but openMiniPlayer() returns
  // silently when the UA sniff fails, and even without the sniff there is no
  // WebContents behind the pip2 request.
  //
  // Chromium's ordinary <video> PiP is reachable here, and the app used it for
  // a while, but it is a separate, unstylable window: it cannot switch clips,
  // it cannot show a "back to tab" button, and the feed auto-advances underneath
  // it — which is what made playback look like "через раз". So the click is
  // routed to the app's own floating window instead (src/main/floating.js),
  // which owns the queue, the controls and the sequential advance.
  //
  // The row is always intercepted. Letting the click through would either hit
  // TikTok's no-op or close a player the user cannot see; main.js instead opens
  // the app window or reports why it cannot (no clip on screen).
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const row = target.closest(`[data-e2e="${FLOATING_ITEM_E2E}"]`);
      const text = target.textContent ? target.textContent.trim() : '';
      if (!row && !FLOATING_ITEM_RE.test(text)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send('feed:float');
    },
    true
  );
}

// ============================================================================
// Live chat capture used to live here. It is gone, and the tap that replaced it
// must never come back here — see the long note in src/main/main.js
// (chatTapMainWorld). The short version, all of it measured on Electron
// 33.4.11, for the three ways an isolated-world tap cannot work:
//
//   * contextBridge.executeInMainWorld — the API this file used — DOES NOT EXIST
//     in Electron 33 (zero hits in node_modules/electron/electron.d.ts), so the
//     guard fell through to the inline-<script> path;
//   * tiktok.com's CSP has no 'unsafe-inline' in script-src, and appendChild on
//     a blocked inline script does NOT throw — it silently never runs, which is
//     why the only symptom was an armed:false warning;
//   * even installed, window.postMessage from the MAIN world never reaches a
//     'message' listener in the ISOLATED world (verified with a live harness),
//     so the transport carried nothing.
//
// webFrame.executeJavaScript / executeJavaScriptInIsolatedWorld from a preload
// are the same dead end: they land in the ISOLATED world, invisible to page
// scripts. What does work is main-side executeJavaScript(code, true) into the
// MAIN world, plus the contextBridge hop below. Nothing else about this file's
// job is chat-related, so the rest of it is untouched.
// ============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install, { once: true });
} else {
  install();
}

// SPA route changes replace the document without a full load; re-arm so the
// right-click handling keeps working after the user scrolls the feed or taps a card.
const rearm = () => {
  if (window.__tkmPreloadDoc !== document) install();
};
window.addEventListener('popstate', rearm);
window.addEventListener('hashchange', rearm);
window.addEventListener('yt-navigate-finish', rearm);
setInterval(rearm, 1000);

contextBridge.exposeInMainWorld('tkmHost', {
  // Lets page-level code report a right-click on a specific element without
  // going through the renderer. Diagnostics only: the main-process handler for
  // this channel paints nothing.
  reportContextMenu: (info) => ipcRenderer.send('feed:guestMenu', info),
});

// The tap itself is injected by the MAIN process into the MAIN world, because
// the page's CSP forbids inline scripts and preload-side injection lands in the
// isolated world where page scripts cannot see it. It hands frames here; this is
// the only hop between the two worlds that Electron 33 actually delivers.
// (Verified on 33.4.11: contextBridge.exposeInMainWorld works in both
// directions, while window.postMessage main-world -> isolated-world does not.)
//
// The ONE ipcRenderer.send() here is what keeps the renderer out of the path
// entirely: a guest preload is an ordinary renderer, so this lands directly on
// ipcMain.on('live:wsFrames') in main.js and the app window never sees a frame.
// (sendToHost() was the first choice and is WRONG for this: measured on
// 33.4.11, a sendToHost from a <webview> guest reaches only the embedder's DOM
// 'ipc-message' event — neither webContents.on('ipc-message') nor ipcMain sees
// it — so it would have re-created the renderer relay this is meant to kill.)
const MAX_WS_BATCH = 64; // same ceiling the tap flushes at
contextBridge.exposeInMainWorld('__tkmChat', {
  post: (batch) => {
    try {
      // Defensive: this is a page-visible global, so anything on the page can
      // call it. A non-array, or one absurd batch, must not reach main.
      if (!Array.isArray(batch) || !batch.length) return;
      if (batch.length > MAX_WS_BATCH) batch = batch.slice(0, MAX_WS_BATCH);
      ipcRenderer.send('live:wsFrames', batch);
    } catch (_) {}
  },
});
