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

// ============================================================================
// Live chat capture: intercept the WebSocket the page already has open.
//
// TikTok's live chat rides a protobuf stream over a WebSocket the page opens
// itself, over the user's own cookies, proxy and UA. Nothing can connect to
// that socket from outside: the URL is signed by a paid service (Euler Stream
// in every open-source client) and expires in ~30 s, and there is no REST
// endpoint for live comments. So the only source that already works — and that
// always shows exactly what the viewer sees — is the page's own socket.
//
// The patch has to live in the MAIN world: this preload is an isolated world
// under contextIsolation, and assigning window.WebSocket there would not touch
// the object the page uses. An injected <script> does run in the page's world.
// It must also run before the page's own scripts, which is why the injection
// happens at preload time and not from a dom-ready hook.
//
// Deliberately NOT sent: acks and heartbeats. The page already sends them, and
// a duplicate gets the socket dropped with `1000 payload_handler_hb`.
// Deliberately NOT changed: binaryType. Forcing 'arraybuffer' could break the
// page's own decoder if it expects Blob, so both shapes are handled instead.
// ============================================================================

const WS_CHANNEL = `__tkm_ws_${Math.random().toString(36).slice(2)}`;

(function injectWebSocketTap() {
  // Self-contained tap: runs in the MAIN world (world 0) with NO closure over
  // this preload — the channel key arrives through `args`, so the function can
  // be serialized by contextBridge.executeInMainWorld. It must stay that way:
  // referencing any outer variable silently breaks the serialization.
  //
  // Bookkeeping counts EVERYTHING, not just chat: total sockets opened, how
  // many matched /webcast/i, and how many message events arrived on ANY socket.
  // The counters live on window.__tkmChatStats in the MAIN world (readable via
  // runInGuest, which executes in the main world) and are mirrored into the
  // live:wsDiag channel, so a future silent failure carries its own diagnosis.
  const tapMainWorld = function (key) {
    var stats = window.__tkmChatStats;
    if (!stats) {
      stats = { total: 0, matched: 0, messages: 0 };
      try {
        window.__tkmChatStats = stats;
      } catch (_) {}
    }
    var Orig = null;
    try {
      Orig = window.WebSocket;
    } catch (_) {
      Orig = null;
    }
    if (!Orig || Orig.__tkmChatTap) {
      try {
        window.postMessage({ k: key, hello: true, stats: stats }, '*');
      } catch (_) {}
      return 'already';
    }

    function Tap(url, protocols) {
      var ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
      var isChat = false;
      try {
        stats.total += 1;
        isChat = /webcast/i.test(String(url));
        if (isChat) stats.matched += 1;
      } catch (_) {}
      var forward = function (buffer) {
        try {
          window.postMessage({ k: key, b: buffer }, '*');
        } catch (_) {
          /* never let capture break the page */
        }
      };
      ws.addEventListener('message', function (ev) {
        try {
          stats.messages += 1;
        } catch (_) {}
        if (!isChat) return;
        var data = ev.data;
        if (typeof data === 'string') return; // control frame, no chat
        if (data instanceof ArrayBuffer) return forward(data);
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          data.arrayBuffer().then(forward).catch(function () {});
        }
      });
      return ws;
    }

    Tap.prototype = Orig.prototype;
    // WebSocket.CONNECTING/OPEN/CLOSING/CLOSED are static constants, and a few
    // libraries read them off the constructor. Forwarding keeps `new Tap()`
    // indistinguishable from `new WebSocket()` for the page.
    Tap.CONNECTING = Orig.CONNECTING;
    Tap.OPEN = Orig.OPEN;
    Tap.CLOSING = Orig.CLOSING;
    Tap.CLOSED = Orig.CLOSED;
    Tap.__tkmChatTap = true;
    try {
      window.WebSocket = Tap;
    } catch (_) {
      return 'frozen';
    }
    // Confirm the patch actually EXECUTED. the legacy <script> path below can only tell
    // that appendChild did not throw — a CSP block does not throw, it just
    // never runs the script, so injection "succeeds" and chat stays empty
    // forever. This is the only signal that separates that failure from a
    // quiet room.
    try {
      window.postMessage({ k: key, hello: true, stats: stats }, '*');
    } catch (_) {}
    // Heartbeat: evolving counters prove the tap is alive (or stuck) without
    // waiting for chat traffic. The isolated side throttles these into wsDiag.
    try {
      setInterval(function () {
        try {
          window.postMessage({ k: key, stats: window.__tkmChatStats }, '*');
        } catch (_) {}
      }, 5000);
    } catch (_) {}
    return 'installed';
  };

  // Primary channel: contextBridge.executeInMainWorld runs the function above
  // in world 0 directly — no <script> element, so page CSP (which on tiktok.com
  // has no 'unsafe-inline' in script-src) has nothing to block. Electron 33.
  const tryMainWorld = () => {
    try {
      if (
        typeof contextBridge !== 'undefined' &&
        contextBridge &&
        typeof contextBridge.executeInMainWorld === 'function'
      ) {
        contextBridge.executeInMainWorld({ func: tapMainWorld, args: [WS_CHANNEL] });
        return true;
      }
    } catch (_) {
      /* fall through to the legacy <script> path */
    }
    return false;
  };

  // Fallback: the legacy inline-<script> injection for an Electron without
  // executeInMainWorld. Same function, stringified — still self-contained, the
  // key still arrives as an argument, not a closure.
  const attachLegacy = () => {
    let code = '';
    try {
      code = `(${tapMainWorld.toString()})(${JSON.stringify(WS_CHANNEL)})`;
    } catch (_) {
      return false;
    }
    const el = document.documentElement || document.head || document.body;
    if (!el) return false;
    const s = document.createElement('script');
    s.textContent = code;
    // CSP on the page can refuse injected scripts; remove ours either way so the
    // element never lingers in the DOM.
    try {
      el.appendChild(s);
    } catch (_) {
      return false;
    }
    s.remove();
    return true;
  };

  if (tryMainWorld()) return;
  if (attachLegacy()) return;
  // documentElement is missing this early on some navigations; retry until the
  // document has a root to attach to. The main-world path is retried too: a
  // document swap replaces window.WebSocket, so the tap must be re-applied.
  const timer = setInterval(() => {
    if (tryMainWorld() || attachLegacy()) clearInterval(timer);
  }, 50);
  setTimeout(() => clearInterval(timer), 10000);
})();

// Isolated-world side: collect frames and ship them to the embedder in small
// batches. One IPC per frame would be absurd on a busy room; 250 ms of latency
// is invisible on a chat log that is timestamped by the server anyway.
(function collectWsFrames() {
  const queue = [];
  let timer = null;
  let lastStatsAt = 0;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    try {
      ipcRenderer.sendToHost('live:wsFrames', batch);
    } catch (_) {
      /* embedder gone; drop silently */
    }
  };

  // Mirrors the tap's counters into live:wsDiag (throttled): armed:true means
  // "the tap runs, here is what it sees" — the renderer logs those and only
  // toasts when armed is false.
  const sendStats = (stats) => {
    const now = Date.now();
    if (now - lastStatsAt < 10000) return;
    lastStatsAt = now;
    try {
      ipcRenderer.sendToHost('live:wsDiag', { armed: true, stats: stats || null });
    } catch (_) {
      /* embedder gone */
    }
  };

  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || typeof data !== 'object' || data.k !== WS_CHANNEL) return;

    // The injection confirmation below proves the tap is installed, which is
    // the only thing that distinguishes "the room is quiet" from "the chat tap
    // never ran". A CSP block or a patched/frozen window.WebSocket both land
    // here with nothing arriving, and without this the user sees an empty chat
    // log and no explanation anywhere.
    if (data.hello) {
      window.__tkmChatArmed = true;
      sendStats(data.stats);
      return;
    }

    // Heartbeat from the tap (no frame attached): just the counters.
    if (data.b === undefined) {
      if (data.stats) sendStats(data.stats);
      return;
    }

    // Duck-typed rather than `instanceof ArrayBuffer`: postMessage structurally
    // clones, so the receiver's own ArrayBuffer is what usually arrives, but a
    // Uint8Array or a cross-realm buffer would be dropped silently and the
    // whole feature would look broken.
    const buf = data.b;
    if (!buf || typeof buf.byteLength !== 'number') return;
    // Backpressure: a chat frame is a few KB. Anything this big is not chat,
    // and forwarding it would hand an unbounded frame to gunzipSync and to
    // synchronous disk writes on the main thread.
    if (buf.byteLength > 512 * 1024) return;

    queue.push(buf);
    if (queue.length >= 64) flush();
    else if (!timer) timer = setTimeout(flush, 250);
  });

  // The tap posts `hello` the moment it installs. If that never arrives the
  // patch is not running — CSP, or the page froze window.WebSocket — and chat
  // will stay empty no matter how long the recording runs.
  setTimeout(() => {
    if (window.__tkmChatArmed) return;
    try {
      ipcRenderer.sendToHost('live:wsDiag', {
        armed: false,
        reason: 'chat tap did not install (CSP or frozen WebSocket?)',
      });
    } catch (_) {
      /* embedder gone */
    }
  }, 6000);
})();

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
