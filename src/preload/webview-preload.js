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

/**
 * The clip id the open "..." menu belongs to, or ''.
 *
 * The menu is rendered in a body-level portal outside the card, so the id is
 * read from (in order): an ancestor carrying data-more-menu-item-id, the
 * expanded trigger button, or the trigger whose card contains the centre of the
 * viewport. The id is TikTok's own video id; pickVisibleVideo() resolves it
 * through the #xgwrapper-0-<id> player wrapper.
 */
function menuItemVideoId(target) {
  try {
    const holder = target.closest && target.closest('[data-more-menu-item-id]');
    if (holder) {
      const id = holder.getAttribute('data-more-menu-item-id');
      if (id) return id;
    }
  } catch (_) {}

  try {
    const open = document.querySelector(
      '[data-e2e="more-menu-icon"][aria-expanded="true"][data-more-menu-item-id]'
    );
    if (open) {
      const id = open.getAttribute('data-more-menu-item-id');
      if (id) return id;
    }
  } catch (_) {}

  // TikTok has been seen without aria-expanded on the trigger. The menu is
  // opened on the card in the middle of the window, so take that card's id.
  let best = '';
  let bestDist = Infinity;
  try {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const buttons = document.querySelectorAll(
      'button[data-e2e="more-menu-icon"][data-more-menu-item-id]'
    );
    for (let i = 0; i < buttons.length; i += 1) {
      const b = buttons[i];
      let card = null;
      try {
        card = b.closest('article, section[data-e2e="feed-video"]');
      } catch (_) {
        card = null;
      }
      if (!card) continue;
      const r = card.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      const dx = (r.left + r.right) / 2 - cx;
      const dy = (r.top + r.bottom) / 2 - cy;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = b.getAttribute('data-more-menu-item-id') || '';
      }
    }
  } catch (_) {}
  return best;
}

/**
 * The <video> the user is actually watching, or null when there is nothing
 * floatable on screen.
 *
 * Why the old ranking (playing -> area -> centre distance) is wrong for the
 * feed: "playing" says nothing about what is painted on top. TikTok keeps
 * several <video> tags in the DOM (the previous card, the next card, prefetch
 * tags, a hidden background player); a hidden one can be playing and can have a
 * larger rect than the visible card. A paused card can be the one on display.
 * Area is equally misleading: stacked feed cards have identical rects.
 *
 * preferredId is the clip id read from the "..." menu that opened the click
 * (button[data-e2e="more-menu-icon"][data-more-menu-item-id]). It is the only
 * exact signal: TikTok wraps each card's player in #xgwrapper-0-<id>, so the
 * clip the menu belongs to can be named, not guessed. Note the menu lives in a
 * body-level portal, outside the card, so the id has to travel through the
 * click target or the menu button.
 *
 * With no id, Chromium's own paint order at the centre of each candidate is
 * used: elementsFromPoint() returns the whole hit-test stack, top first.
 * Overlay nodes (subtitles, the open "more" menu) are skipped by climbing to
 * the nearest ancestor that owns exactly ONE visible video; shared ancestors
 * (the feed container, body) are never allowed to answer, because their first
 * <video> belongs to another card. Geometry is the fallback.
 *
 * Hard filters before ranking:
 *   - display:none / visibility:hidden anywhere up the tree;
 *   - visible area (viewport + overflow-clipping ancestors) of at least 0.5%
 *     of the viewport, so a 1px sliver of a prefetch tag cannot win;
 *   - disablePictureInPicture: if the clip the user sees forbids PiP, return
 *     null instead of floating a different clip just because that one allows it.
 *
 * Effective opacity is a ranking demotion, not a hard cut: a headless TikTok
 * run reported opacity 0 on the clip whose frame was plainly painted, so when
 * every candidate reports zero the signal is ignored rather than losing PiP
 * altogether.
 *
 * "playing" is deliberately not part of the ranking at all. Paused is a normal
 * state of the clip the user is looking at; playing is not evidence of being
 * visible. readyState is checked only at the very end, so an unready top card
 * blocks the clips underneath instead of silently handing PiP to another card.
 */
function pickVisibleVideo(preferredId) {
  const win = window;
  const doc = win.document;
  const vw = win.innerWidth || 0;
  const vh = win.innerHeight || 0;
  if (!doc || vw <= 0 || vh <= 0) return null;

  const MIN_AREA = Math.max(400, vw * vh * 0.005); // 0.5% of the viewport

  const styleOf = (el) => {
    try {
      return win.getComputedStyle ? win.getComputedStyle(el) : null;
    } catch (_) {
      return null;
    }
  };

  // Effective visibility of the whole ancestor chain, not just the element:
  // a video inside a visibility:hidden wrapper is not visible even though its
  // own computed style says "visible". Opacity is reported separately.
  const styleInfo = (el) => {
    let opacity = 1;
    let n = el;
    for (let i = 0; i < 40 && n && n.nodeType === 1; i += 1, n = n.parentElement) {
      const cs = styleOf(n);
      if (!cs) continue;
      if (cs.display === 'none') return { hidden: true, opacity: 0 };
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return { hidden: true, opacity: 0 };
      const o = Number.parseFloat(cs.opacity);
      if (Number.isFinite(o)) opacity *= o;
    }
    return { hidden: false, opacity };
  };

  // Viewport intersection further clipped by ancestor overflow boxes. The feed
  // scroll box and cards with overflow:hidden are exactly the ancestors that
  // matter; body/html are handled by the viewport intersection itself.
  const visibleRect = (el) => {
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    if (!r || !(r.width > 0) || !(r.height > 0)) return null;

    let left = Math.max(0, r.left);
    let top = Math.max(0, r.top);
    let right = Math.min(vw, r.right);
    let bottom = Math.min(vh, r.bottom);

    let n = el.parentElement;
    for (
      let i = 0;
      i < 40 && n && n.nodeType === 1 && n !== doc.body && n !== doc.documentElement;
      i += 1, n = n.parentElement
    ) {
      const cs = styleOf(n);
      if (!cs) continue;
      if (cs.display === 'none') return null;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return null;
      const ox = cs.overflowX || cs.overflow;
      const oy = cs.overflowY || cs.overflow;
      if ((ox && ox !== 'visible') || (oy && oy !== 'visible')) {
        let ar;
        try {
          ar = n.getBoundingClientRect();
        } catch (_) {
          ar = null;
        }
        if (ar) {
          left = Math.max(left, ar.left);
          top = Math.max(top, ar.top);
          right = Math.min(right, ar.right);
          bottom = Math.min(bottom, ar.bottom);
        }
      }
    }

    const width = right - left;
    const height = bottom - top;
    if (!(width > 0) || !(height > 0)) return null;
    return { left, top, right, bottom, width, height, area: width * height };
  };

  const visibleCache = new WeakMap();
  const visibleRectOf = (v) => {
    if (!v || v.tagName !== 'VIDEO' || v.isConnected === false) return null;
    if (visibleCache.has(v)) return visibleCache.get(v);
    let r = null;
    if (!styleInfo(v).hidden) {
      r = visibleRect(v);
      if (r && r.area < MIN_AREA) r = null;
    }
    visibleCache.set(v, r);
    return r;
  };

  const finish = (v) => {
    if (!v || v.isConnected === false) return null;
    // The visible clip cannot be floated: decline. Do not fall through to a
    // neighbour card, that would be the original bug in a new form.
    if (v.disablePictureInPicture) return null;
    if (v.error) return null;
    if (!(v.readyState > 0)) return null;
    return v;
  };

  // Exact clip named by the menu. TikTok's player wrapper is
  // #xgwrapper-0-<videoId>, the same id the "..." button carries in
  // data-more-menu-item-id. Older markup may lack the wrapper id, in which case
  // the trigger with this id is climbed to its article/section card.
  const videoForId = (id) => {
    if (!id) return null;
    const wrapperId = 'xgwrapper-0-' + id;
    let wrapper = null;
    try {
      if (typeof doc.getElementById === 'function') wrapper = doc.getElementById(wrapperId);
    } catch (_) {}
    if (!wrapper) {
      try {
        const triggers = doc.querySelectorAll(
          'button[data-e2e="more-menu-icon"][data-more-menu-item-id]'
        );
        for (let i = 0; i < triggers.length; i += 1) {
          const t = triggers[i];
          if (t.getAttribute('data-more-menu-item-id') !== id) continue;
          try {
            wrapper = t.closest('article, section[data-e2e="feed-video"]');
          } catch (_) {
            wrapper = null;
          }
          if (wrapper) break;
        }
      } catch (_) {}
    }
    if (!wrapper) return null;
    if (wrapper.tagName === 'VIDEO') return wrapper;
    try {
      return wrapper.querySelector('video');
    } catch (_) {
      return null;
    }
  };

  if (preferredId) {
    const exact = videoForId(preferredId);
    // A resolved clip that cannot float is a deliberate "no" — never a
    // neighbour. An id that cannot be resolved at all (older markup) falls
    // through to the geometric path.
    if (exact) return visibleRectOf(exact) ? finish(exact) : null;
  }

  const list = doc.querySelectorAll('video');
  const candidates = [];
  for (let i = 0; i < list.length; i += 1) {
    const v = list[i];
    const r = visibleRectOf(v);
    if (!r) continue;
    const cx = vw / 2;
    const cy = vh / 2;
    const covers = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    candidates.push({
      v,
      r,
      covers,
      dist: covers ? 0 : Math.hypot(dx, dy),
      index: i,
      transparent: styleInfo(v).opacity <= 0.01,
    });
  }
  if (!candidates.length) return null;

  // Headless Chromium sometimes reports opacity:0 on the clip that is plainly
  // painted (measured on tiktok.com); in that case ignore the signal for the
  // whole set instead of refusing to float anything.
  if (candidates.every((c) => c.transparent)) {
    for (let i = 0; i < candidates.length; i += 1) candidates[i].transparent = false;
  }

  // The card that covers the middle of the window is the one on display; among
  // equal cards DOM order is the last key so the result never depends on sort
  // stability. "playing" is intentionally absent.
  candidates.sort((a, b) => {
    if (a.transparent !== b.transparent) return a.transparent ? 1 : -1;
    if (a.covers !== b.covers) return a.covers ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (a.r.area !== b.r.area) return b.r.area - a.r.area;
    return a.index - b.index;
  });

  // The node itself, or the nearest ancestor that owns exactly one VISIBLE
  // video. A shared container with two or more visible videos must not answer:
  // its first <video> in document order is a different clip.
  const ownerVideo = (node) => {
    let el = node;
    for (let i = 0; i < 16 && el && el.nodeType === 1; i += 1, el = el.parentElement) {
      if (el.tagName === 'VIDEO') return visibleRectOf(el) ? el : null;
      if (el === doc.body || el === doc.documentElement) return null;
      let videos = null;
      try {
        videos = el.querySelectorAll ? el.querySelectorAll('video') : null;
      } catch (_) {
        videos = null;
      }
      if (!videos || !videos.length) continue;
      let only = null;
      let count = 0;
      for (let j = 0; j < videos.length; j += 1) {
        if (visibleRectOf(videos[j])) {
          only = videos[j];
          count += 1;
        }
      }
      if (count === 1) return only;
      if (count > 1) return null; // ambiguous layer: never guess
    }
    return null;
  };

  const videoAt = (x, y) => {
    let stack = [];
    try {
      if (typeof doc.elementsFromPoint === 'function') {
        stack = doc.elementsFromPoint(x, y) || [];
      } else if (typeof doc.elementFromPoint === 'function') {
        const el = doc.elementFromPoint(x, y);
        stack = el ? [el] : [];
      }
    } catch (_) {
      stack = [];
    }
    for (let i = 0; i < stack.length; i += 1) {
      const v = ownerVideo(stack[i]);
      if (v) return v;
    }
    return null;
  };

  const clampX = (x) => Math.max(0, Math.min(vw - 0.5, x));
  const clampY = (y) => Math.max(0, Math.min(vh - 0.5, y));

  // Probe the centre of each candidate in centrality order. The first one that
  // is also the topmost visible video at that point wins. A candidate hidden
  // under another card, or behind a higher card, is rejected by the probe.
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const x = clampX(c.r.left + c.r.width / 2);
    const y = clampY(c.r.top + c.r.height / 2);
    const top = videoAt(x, y);
    if (top && top !== c.v) continue;
    return finish(c.v);
  }

  return null;
}

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
      ipcRenderer.send('feed:guestMenu', describe(event.target, event));
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

  // "Плавающий видеоплеер" is TikTok's "Floating Player" menu entry. It is a
  // DOCUMENT Picture-in-Picture feature, not the ordinary video PiP one.
  //
  // From TikTok's own web bundle (static/js/async/72184.*.js):
  //   isDocumentPipSupporting = "documentPictureInPicture" in window
  //     && browser is Chrome/Edge/Opera        <-- a User-Agent sniff
  //     && /Chrom(e|ium)\/(\d+)/ >= 126 && !== 133
  //   openMiniPlayer() then does
  //     if (!isDocumentPipSupporting) return;               <-- silent no-op
  //     window.documentPictureInPicture.requestWindow({width, height})
  // The menu ROW is rendered under the looser test `"documentPictureInPicture"
  // in window`, which Electron 33 / Chromium 130 passes — which is why the item
  // appears at all. The click then reaches openMiniPlayer(), the UA sniff fails
  // on `Electron/33.4.11 ...`, and the function returns without doing anything.
  //
  // What IS implemented, and reachable from a <webview> guest, is the ordinary
  // VIDEO Picture-in-Picture API (HTMLVideoElement.requestPictureInPicture) —
  // WebContents::EnterPictureInPicture(), electron#17686, shipped in Electron 7.
  // So this handler performs a native PiP on the clip the user is watching. The
  // result is Chromium's own always-on-top video window, not TikTok's styled
  // mini-player with its item list: that part is unrecoverable in Electron.
  //
  // This is deliberately the SAME behaviour the app had before the custom
  // floating window (6c71608): the click floats one <video> natively, with no
  // queue and no switching inside the window. The clip is resolved from the id
  // of the "..." menu's card before the click is cancelled; if that id is not
  // available, the card covering the centre of the viewport wins. A resolved
  // clip that cannot float declines the click instead of substituting a
  // neighbour.
  //
  // When it cannot act — native PiP unavailable, or nothing is on screen to
  // float — the click is deliberately NOT intercepted, so TikTok's own handler
  // still runs. Swallowing the click there would just reproduce the no-op this
  // replaces.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const row = target.closest(`[data-e2e="${FLOATING_ITEM_E2E}"]`);
      const text = target.textContent ? target.textContent.trim() : '';
      if (!row && !FLOATING_ITEM_RE.test(text)) return;
      if (typeof document.exitPictureInPicture !== 'function') return;
      if (!document.pictureInPictureEnabled) return;

      // Resolve everything BEFORE cancelling: preventDefault() +
      // stopImmediatePropagation() cannot be undone, so the decision to take the
      // click over from TikTok must be complete by this point.
      const closing = Boolean(document.pictureInPictureElement);
      const clipId = closing ? '' : menuItemVideoId(target);
      const video = closing ? null : pickVisibleVideo(clipId);
      if (!closing && (!video || video.disablePictureInPicture || video.isConnected === false)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      // Already floating: the same item closes it again.
      if (closing) {
        document.exitPictureInPicture().catch(() => {});
        return;
      }
      video.requestPictureInPicture().catch(() => {});
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
