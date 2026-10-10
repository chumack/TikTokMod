'use strict';

const { webContents } = require('electron');

// Reads the videos currently rendered in the built-in browser.
//
// Why the DOM and not the API: the feed is personalized per session and served
// to a real Chromium, which already has the proxy, cookies and fingerprint the
// user configured. Asking the API for "the For You feed" is not a thing TikTok
// exposes — there is no endpoint that returns the same list without an
// authenticated, device-bound session. The rendered page is that list.
//
// The page itself decides what to show, so this cannot unlock anything the
// browser has not already unlocked. It only turns the visible page into a
// download list.

// The renderer hands us the webview's webContents id once it mounts the tag;
// holding the id (not the element) keeps navigation working for free.
let guestId = null;

function setWebviewId(id) {
  guestId = Number(id) || null;
  return guestId;
}

function guest() {
  if (!guestId) return null;
  const wc = webContents.fromId(guestId);
  return wc && !wc.isDestroyed() ? wc : null;
}

/**
 * Script injected into the webview. Must be self-contained: it runs in the
 * page's main world with no access to our modules.
 *
 * Collects anchors that point at a video, plus whatever metadata the DOM
 * already exposes (thumbnail, author, caption, view count). Returns plain JSON.
 */
const COLLECT_SCRIPT = `(() => {
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/@([\\w.\\-]+)\\/(?:video|photo)\\/(\\d{6,})/);
    if (!m) continue;
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);

    // The card is the anchor's nearest ancestor that holds the thumbnail.
    let card = a;
    for (let i = 0; i < 4 && card.parentElement; i++) {
      if (card.parentElement.querySelector('img')) { card = card.parentElement; break; }
      card = card.parentElement;
    }
    const img = card.querySelector('img') || a.querySelector('img');
    const text = (card.innerText || '').trim();

    // Views are rendered as "12.3M", "1.2K views", "45K просмотров" — parse the
    // first such token rather than guessing the locale of the whole page.
    let viewCount = null;
    const vm = text.match(/([\\d.,]+)\\s*([KMB])\\b/i);
    if (vm) {
      const base = parseFloat(vm[1].replace(/,/g, '.')) || 0;
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[vm[2].toLowerCase()];
      viewCount = Math.round(base * mult);
    }

    out.push({
      id,
      handle: m[1],
      url: 'https://www.tiktok.com/@' + m[1] + '/video/' + id,
      thumbnail: img ? (img.currentSrc || img.src || '') : '',
      // The card's own alt/aria text is the caption in most TikTok layouts.
      title: (img && img.alt) || a.getAttribute('aria-label') || (text.split('\\n')[0] || '').slice(0, 120),
      viewCount,
      isPhoto: href.includes('/photo/'),
    });
  }
  return out;
})()`;

/**
 * Script that scrolls the feed so more items render. TikTok's feed is an
 * infinite scroll container, so scrolling its own element is more reliable than
 * scrolling the window.
 */
const SCROLL_SCRIPT = `(() => {
  const nodes = Array.from(document.querySelectorAll('div'));
  let target = document.scrollingElement;
  let best = -1;
  for (const n of nodes) {
    if (n.scrollHeight <= n.clientHeight + 40) continue;
    const area = n.clientWidth * n.clientHeight;
    if (area > best) { best = area; target = n; }
  }
  if (!target) return 0;
  const before = target.scrollTop;
  target.scrollTop = before + Math.round(target.clientHeight * 0.9);
  // Some layouts only react to a wheel event.
  target.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true }));
  return target.scrollTop - before;
})()`;

/**
 * TikTok's player paints its own HTML context menu on right-click ("Загрузить
 * видео", "Скорость", "Качество"), and the embedder's DOM "context-menu" event
 * never fires for a <webview> guest in Electron 33 — so this script alone
 * could only kill the page menu, leaving no menu at all.
 *
 * The real interception lives in src/preload/webview-preload.js, which runs in
 * the guest before page scripts and reports the click to the main process.
 * What is left here is a late safety net for pages that replace the document
 * after load: it only cancels the page's own menu, and never stops
 * propagation, so the preload's report still gets through. Idempotent.
 */
const HOOK_SCRIPT = `(() => {
  if (window.__tkmHooks) return 'already';
  window.__tkmHooks = true;
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  }, true);
  return 'installed';
})()`;

/**
 * Reads the video the app is currently displaying.
 *
 * No loading state is involved on purpose: this answers "what is on screen",
 * and the user does not care whether TikTok considers the feed ready. TikTok
 * also renames data-e2e attributes regularly, so the id is resolved from
 * durable things instead — the address bar, the card's own href, or any visible
 * link to /video/<id>.
 */
const PLAYING_SCRIPT = `(() => {
  const out = { id: null, handle: null, url: null, src: null, title: '', playing: false, method: null };
  const ID_RE = /\\/video\\/(\\d{6,})/;
  const HANDLE_RE = /\\/@([^/]+)\\//;

  const take = (href) => {
    const m = String(href || '').match(ID_RE);
    if (!m) return false;
    out.id = m[1];
    const h = String(href || '').match(HANDLE_RE);
    if (h) out.handle = h[1];
    return true;
  };

  // Only <video> elements with real area count: TikTok keeps zero-sized tags
  // around for prefetching the next cards.
  const scored = [];
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area <= 0) continue;
    scored.push({
      v,
      area,
      playing: !v.paused && !v.ended && v.readyState > 2,
      inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    });
  }
  scored.sort((a, b) => {
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    if (a.inView !== b.inView) return a.inView ? -1 : 1;
    return b.area - a.area;
  });
  const best = scored[0] || null;
  if (best) {
    out.src = best.v.currentSrc || best.v.src || null;
    out.playing = best.playing;
  }

  // Walk up from the on-screen <video>: the id can sit on the wrapper element
  // (xgwrapper-<idx>-<postId>) or on any ancestor anchor.
  if (best) {
    let el = best.v;
    for (let i = 0; i < 25 && el; i++) {
      const own = String(el.id || '');
      if (own.indexOf('xgwrapper-') === 0) {
        const tail = own.split('-').pop();
        if (/^\\d{6,}$/.test(tail)) { out.id = tail; break; }
      }
      const wrap = el.querySelector && el.querySelector('[id^="xgwrapper-"]');
      if (wrap) {
        const tail = wrap.id.split('-').pop();
        if (/^\\d{6,}$/.test(tail)) { out.id = tail; break; }
      }
      const a = (el.matches && el.matches('a[href*="/video/"]')) || (el.querySelector && el.querySelector('a[href*="/video/"]'));
      if (a && take(a.getAttribute('href'))) break;
      el = el.parentElement;
    }
  }

  // A dedicated video page has the answer in the address bar.
  if (!out.id) {
    const here = location.pathname.match(/\\/@([^/]+)\\/(?:video|photo)\\/(\\d{6,})/);
    if (here) { out.handle = here[1]; out.id = here[2]; }
  }

  // Last resort: any rendered link to a video, preferring one on screen. This
  // is the branch that matters on /foryou, where the feed keeps serving links
  // even mid-load.
  if (!out.id) {
    let fallback = null;
    for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')) {
      const href = a.getAttribute('href') || '';
      if (!ID_RE.test(href)) continue;
      if (!fallback) fallback = href;
      const r = a.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) { fallback = href; break; }
    }
    if (fallback) take(fallback);
  }

  if (out.id) {
    out.url = 'https://www.tiktok.com/@' + (out.handle || '_') + '/video/' + out.id;
    if (!out.method) out.method = 'dom';
  }

  const cap = document.querySelector('[data-e2e="video-desc"], [data-e2e="browse-video-desc"], [data-e2e="video-title"]');
  if (cap) out.title = (cap.textContent || '').trim().slice(0, 120);

  out.videos = scored.length;
  return out;
})()`;

async function installHooks() {
  const res = await runInGuest(HOOK_SCRIPT);
  return res.ok ? res.value : null;
}

/**
 * Runs a script in the guest page and returns its JSON result.
 * Returns { ok: false, error } instead of throwing so the UI can show it.
 */
async function runInGuest(script, { timeout = 15000 } = {}) {
  const wc = guest();
  if (!wc) return { ok: false, error: 'Встроенный браузер не открыт. Перейдите на вкладку «Обзор».' };
  // Chromium refuses executeJavaScript while the guest's frame is detached and
  // answers with "not attached to the DOM". Waiting for the next dom-ready and
  // retrying once turns the most common failure of this whole module — a right
  // click during a TikTok SPA route change — into a normal read.
  if (await waitForDomReady(wc)) {
    try {
      return { ok: true, value: await withTimeout(wc.executeJavaScript(script, true), timeout) };
    } catch (e) {
      return { ok: false, error: friendlyError(e) };
    }
  }
  try {
    return { ok: true, value: await withTimeout(wc.executeJavaScript(script, true), timeout) };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
}

function withTimeout(promise, timeout) {
  return Promise.race([
    promise,
    new Promise((_r, rej) => setTimeout(() => rej(new Error('Страница не отвечает')), timeout)),
  ]);
}

function friendlyError(e) {
  const msg = String((e && e.message) || e || '');
  return /attached to the DOM|dom-ready/i.test(msg)
    ? 'Страница ещё загружается. Дождитесь ленты и попробуйте снова.'
    : msg;
}

/**
 * Resolves true when the guest was not ready and we waited for it to become
 * ready (so the caller can retry), false when it was ready all along.
 */
function waitForDomReady(wc, timeout = 8000) {
  if (!wc || wc.isDestroyed()) return Promise.resolve(false);
  try {
    const url = wc.getURL();
    if (url && url !== 'about:blank') return Promise.resolve(false);
  } catch (_) {}

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.off('dom-ready', onReady);
      resolve(value);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    wc.once('dom-ready', onReady);
    wc.once('destroyed', () => finish(false));
  });
}

/**
 * Collects the videos rendered in the browser tab, merging with what was
 * already gathered so repeated clicks grow the list instead of replacing it.
 */
async function collect({ scroll = false, previous = [] } = {}) {
  await installHooks();
  let url = '';
  const u = await runInGuest('location.href');
  if (u.ok && typeof u.value === 'string') url = u.value;

  let scrolled = null;
  if (scroll) {
    const s = await runInGuest(SCROLL_SCRIPT);
    if (s.ok) scrolled = s.value;
    // Give the feed time to render the next batch before reading the DOM.
    await new Promise((r) => setTimeout(r, 1800));
  }

  const res = await runInGuest(COLLECT_SCRIPT);
  if (!res.ok) return res;
  const items = Array.isArray(res.value) ? res.value : [];

  const merged = new Map();
  for (const it of previous) if (it && it.id) merged.set(it.id, it);
  for (const it of items) if (it && it.id && !merged.has(it.id)) merged.set(it.id, it);
  const all = Array.from(merged.values());

  return {
    ok: true,
    url,
    scrolled,
    total: all.length,
    added: all.length - (previous.length || 0),
    items: all,
    hint: all.length
      ? ''
      : 'На странице не найдено ни одной ссылки на видео. Прокрутите ленту и повторите, либо откройте профиль автора — там видео видны сразу.',
  };
}

/**
 * Resolves the video that is playing right now (or, at given coordinates, the
 * one under the cursor) back to a canonical /@handle/video/<id> URL.
 *
 * Why not video.currentSrc: in the feed the <video> element is fed by Media
 * Source Extensions, so src/srcList is a blob: URL that yt-dlp cannot fetch.
 * What survives is the surrounding anchor / data attribute holding the id.
 */
const CURRENT_SCRIPT = `(() => {
  const VID_RE = /\\/@([\\w.\\-]+)\\/(?:video|photo)\\/(\\d{6,})/;

  // Ranking is deliberately NOT by area. In TikTok's vertical feed every card
  // has the same size and several are in the DOM at once, so equal areas make
  // the sort fall back to document order — which returns the same clip on
  // every press. Distance from the viewport centre is what actually
  // distinguishes "the video the user is looking at".
  const measure = (v) => {
    const r = v.getBoundingClientRect();
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return {
      v,
      playing: !v.paused && !v.ended && v.readyState > 2,
      visible: h * w,
      centerDist: Math.hypot(cx - innerWidth / 2, cy - innerHeight / 2),
    };
  };
  const better = (a, b) => {
    if (a.playing !== b.playing) return Number(b.playing) - Number(a.playing);
    if (a.visible !== b.visible) return b.visible - a.visible;
    return a.centerDist - b.centerDist;
  };

  let host = null;
  const hasPoint = typeof __TKM_X === 'number' && typeof __TKM_Y === 'number';
  if (hasPoint) {
    const el = document.elementFromPoint(__TKM_X, __TKM_Y);
    host = el && (el.closest('video') || (el.querySelector && el.querySelector('video')));
  }
  let videos = host ? [host] : Array.from(document.querySelectorAll('video'));
  if (!videos.length && host) videos = Array.from(document.querySelectorAll('video'));
  if (!videos.length) return null;

  let best = videos.map(measure).sort(better)[0];
  // Nothing is actually playing (TikTok preloads neighbours): prefer whatever
  // sits under the middle of the screen, that is the one on display.
  // Explicit right-click coordinates must win over that, hence !hasPoint.
  if (!hasPoint && !best.playing) {
    // elementsFromPoint returns the whole stack at that spot, so the <video>
    // is found even when an <img> or a wrapper sits on top of it.
    const stackEls = document.elementsFromPoint
      ? document.elementsFromPoint(innerWidth / 2, innerHeight / 2)
      : [];
    let midVideo = stackEls.find((e) => e.tagName === 'VIDEO');
    if (!midVideo) {
      const mid = stackEls[0];
      midVideo = mid && (mid.closest('video') || (mid.querySelector && mid.querySelector('video')));
    }
    if (midVideo) {
      const m = measure(midVideo);
      if (m.visible > 0) { best = m; best.atCenter = true; }
    }
  }
  const video = best.v;

  const out = {
    vid: '', handle: '', url: '', title: '', thumb: '',
    isPhoto: false, playing: best.playing, srcKind: '', srcUrl: '',
    durationSec: 0, currentSec: 0,
  };
  try {
    const cur = video.currentSrc || video.src || '';
    out.srcUrl = cur;
    out.srcKind = cur.slice(0, 5) === 'blob:' ? 'blob' : (cur ? 'direct' : 'none');
  } catch (_) {}
  if (video.duration && isFinite(video.duration)) out.durationSec = Math.round(video.duration);
  if (video.currentTime) out.currentSec = Math.round(video.currentTime);

  // Walk up looking for the anchor that carries the canonical id; the video
  // tag itself never contains it.
  //
  // CRITICAL: never use querySelectorAll on a shared ancestor and take the
  // first match. In the real feed many cards live inside one container, so the
  // first anchor in document order belongs to a DIFFERENT video — every press
  // then resolves to the same clip (same file, different titles). Resolution
  // order below is: direct ancestor link -> data attributes on the chain ->
  // anchor overlapping this exact <video> rect -> nearest anchor by centre.
  const vr = video.getBoundingClientRect();
  const overlap = (r) => {
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    void h; void w;
    const ih = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
    const iw = Math.max(0, Math.min(r.right, vr.right) - Math.max(r.left, vr.left));
    return ih * iw;
  };
  const centreDist = (r) => Math.hypot(
    (r.left + r.width / 2) - (vr.left + vr.width / 2),
    (r.top + r.height / 2) - (vr.top + vr.height / 2)
  );

  const applyAnchor = (href) => {
    const m = String(href || '').match(VID_RE);
    if (!m) return false;
    out.vid = m[2];
    out.handle = m[1];
    out.isPhoto = /\\/photo\\//.test(String(href || ''));
    out.url = 'https://www.tiktok.com/@' + m[1] + '/' + (out.isPhoto ? 'photo/' : 'video/') + m[2];
    return true;
  };

  // 1. Direct ancestor link — the only 100% reliable source.
  try {
    const direct = video.closest ? video.closest('a[href*="/video/"], a[href*="/photo/"]') : null;
    if (direct) applyAnchor(direct.getAttribute('href'));
  } catch (_) {}

  // 2. Data attributes on the element and its ancestors (card-scoped).
  if (!out.vid) {
    let el2 = video;
    for (let i = 0; i < 8 && el2; i += 1, el2 = el2.parentElement) {
      const attrs = ['data-e2e-vid', 'data-vid', 'data-video-id', 'data-aweme-id'];
      for (const a of attrs) {
        const v = el2.getAttribute && el2.getAttribute(a);
        if (v && /^\\d{6,}$/.test(v)) { out.vid = v; break; }
      }
      if (out.vid) break;
    }
  }

  // 3. Anchor geometrically overlapping THIS video element.
  if (!out.vid) {
    const all = document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
    let bestA = null; let bestOv = 0;
    let nearA = null; let nearD = Infinity; let nearHref = '';
    for (const a of all) {
      const href = a.getAttribute('href') || '';
      if (!VID_RE.test(href)) continue;
      let r = null;
      try { r = a.getBoundingClientRect(); } catch (_) { continue; }
      if (!r || (r.width === 0 && r.height === 0)) continue;
      const ov = overlap(r);
      if (ov > bestOv) { bestOv = ov; bestA = href; }
      const d = centreDist(r);
      if (d < nearD) { nearD = d; nearA = href; nearHref = href; }
      void nearA;
    }
    if (bestOv > 0 && bestA) applyAnchor(bestA);
    else if (nearHref && nearD < 1200) applyAnchor(nearHref);
  }

  // Card-scoped title/thumbnail: the nearest ancestor holding exactly this
  // video (not the whole feed), so titles do not leak across cards.
  let card = video;
  try {
    let el3 = video;
    for (let i = 0; i < 8 && el3 && el3.parentElement; i += 1) {
      el3 = el3.parentElement;
      if (!el3.querySelectorAll) continue;
      const vids = el3.querySelectorAll('video');
      if (vids.length === 1) { card = el3; break; }
      if (i >= 5) { card = el3; break; }
    }
  } catch (_) {}
  try {
    const img = card.querySelector ? card.querySelector('img') : null;
    if (img) {
      out.thumb = img.currentSrc || img.src || '';
      if (img.alt) out.title = String(img.alt).split('\\n')[0].slice(0, 300);
    }
    if (!out.title) {
      const cap = card.innerText || '';
      const line = cap.split('\\n').map((s) => s.trim()).filter(Boolean)[0];
      if (line) out.title = line.slice(0, 300);
    }
  } catch (_) {}
  if (out.vid && !out.handle) {
    try {
      const link = card.querySelector ? card.querySelector('a[href*="/@"]') : null;
      if (link) {
        const m = String(link.getAttribute('href') || '').match(/\\/@([\\w.\\-]+)\\//);
        if (m) out.handle = m[1];
      }
    } catch (_) {}
  }

  if (!out.url && out.vid) {
    out.url = 'https://www.tiktok.com/video/' + out.vid;
  }
  if (!out.title) {
    const t = (document.title || '').trim();
    if (t) out.title = t.slice(0, 300);
  }
  return out;
})()`;

/**
 * Video under the given viewport coordinates, or the one currently playing
 * when x/y are omitted.
 */
async function currentVideo(x, y) {
  // Hooks are lost on navigation, so re-install before every read.
  await installHooks();
  // Coordinates must be spliced in as NUMBER literals, not as quoted strings:
  // the script decides whether a right-click point was supplied with
  // `typeof __TKM_X === 'number'`, and a spliced "100" would be a string,
  // making every right-click silently fall back to "whatever is in the
  // middle of the screen" — the bug that made the app download one clip
  // over and over. Undefined coordinates stay undefined for the same reason.
  const nx = x === null || x === undefined ? 'undefined' : String(Number(x) || 0);
  const ny = y === null || y === undefined ? 'undefined' : String(Number(y) || 0);
  const script = CURRENT_SCRIPT.replace(/__TKM_X/g, nx).replace(/__TKM_Y/g, ny);
  const res = await runInGuest(script);
  if (!res.ok) return res;
  return { ok: true, video: res.value || null };
}

/**
 * Resolves the video the app is showing right now, whatever state the feed is in.
 *
 * It never waits for the feed: the user wants whatever is on screen, and TikTok
 * renders anchors to /video/<id> continuously while more cards stream in.
 */
async function currentPlaying() {
  const res = await runInGuest(PLAYING_SCRIPT);
  if (!res.ok) return res;
  const v = res.value;
  if (!v || !v.id) {
    return {
      ok: false,
      error: 'На странице нет ни одной ссылки на ролик. Прокрутите ленту и попробуйте снова.',
      debug: v || null,
    };
  }
  return { ok: true, video: v };
}

module.exports = {
  collect,
  currentVideo,
  currentPlaying,
  installHooks,
  runInGuest,
  setWebviewId,
  COLLECT_SCRIPT,
  SCROLL_SCRIPT,
  CURRENT_SCRIPT,
  PLAYING_SCRIPT,
  HOOK_SCRIPT,
};
