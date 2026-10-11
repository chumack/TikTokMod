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

// The <video> the user is actually watching. Ranking mirrors CURRENT_SCRIPT in
// src/main/feed.js, which was rewritten precisely because area alone is not
// enough: in TikTok's vertical feed every card has the SAME size and several are
// in the DOM at once, so an area-only sort falls back to document order and
// returns the same clip every time. Three keys, in order: playing, then visible
// area, then distance from the centre of the viewport.
//
// Unlike feed.js this returns null when nothing is on screen — NO "first <video>
// in the document" fallback. The caller must be able to decline the click when
// there is no clip to float, and a fallback to document order is exactly how you
// float the wrong one (or a prefetch tag with no data, which throws
// InvalidStateError). Nothing on screen means: leave the click to TikTok.
function pickVisibleVideo() {
  const cx = innerWidth / 2;
  const cy = innerHeight / 2;
  const scored = [];
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const visH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const visW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const area = visH * visW;
    if (area <= 0) continue;
    const mx = r.left + r.width / 2;
    const my = r.top + r.height / 2;
    scored.push({
      v,
      area,
      playing: !v.paused && !v.ended && v.readyState > 2,
      centerDist: Math.hypot(mx - cx, my - cy),
    });
  }
  scored.sort((a, b) => {
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    if (a.area !== b.area) return b.area - a.area;
    return a.centerDist - b.centerDist;
  });
  return scored.length ? scored[0].v : null;
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
  // Two independent reasons it could never work here, in fact:
  //   1. the UA sniff above, and
  //   2. Electron has never implemented Document PiP (electron/electron#39633,
  //      open since Aug 2023, relabelled "enhancement" in Jul 2026): Blink
  //      exposes window.documentPictureInPicture, but WebContents::AddNewContents()
  //      returns nullptr for the disposition pip2 hands it, so the child
  //      WebContents is destroyed and no window is ever created.
  //
  // What IS implemented, and reachable from a <webview> guest, is the ordinary
  // VIDEO Picture-in-Picture API (HTMLVideoElement.requestPictureInPicture) —
  // WebContents::EnterPictureInPicture(), electron#17686, shipped in Electron 7.
  // So this handler performs a native PiP on the clip the user is watching. The
  // result is Chromium's own always-on-top video window, not TikTok's styled
  // mini-player with its item list: that part is unrecoverable in Electron.
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
      const video = closing ? null : pickVisibleVideo();
      if (!closing && (!video || video.disablePictureInPicture)) return;

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
