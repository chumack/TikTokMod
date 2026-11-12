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

// TikTok clip ids are numeric (e.g. 7701697613590072597). A
// data-more-menu-item-id that does not look like one names a menu row, not a
// clip, and must never be resolved as a #xgwrapper-0-<id> key.
const VIDEO_ID_RE = /^\d{6,}$/;

// The "..." trigger the user actually pressed, remembered in the capture phase.
// The open menu is a body-level portal that carries no clip id, and TikTok
// leaves aria-expanded="true" on triggers of previously opened menus. Asking
// for "the expanded trigger" can therefore name an older card; the button that
// opened this menu cannot.
let lastMenuTrigger = null;

function rectOf(el) {
  try {
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!r || !(r.width > 0) || !(r.height > 0)) return null;
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
    };
  } catch (_) {
    return null;
  }
}

function rectDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(
    a.left + a.width / 2 - (b.left + b.width / 2),
    a.top + a.height / 2 - (b.top + b.height / 2)
  );
}

function rememberMenuTrigger(el) {
  try {
    const id = el.getAttribute('data-more-menu-item-id') || '';
    if (!VIDEO_ID_RE.test(id)) return;
    lastMenuTrigger = { id, el, at: Date.now() };
  } catch (_) {}
}

/**
 * Clip ids the open "..." menu may belong to, most exact first.
 *
 * The menu is rendered in a body-level portal outside the card, so nothing
 * inside it names the clip unless TikTok itself put data-more-menu-item-id on
 * the row. The signals, in order:
 *
 *   1. the "..." trigger the user pressed (remembered on pointerdown/click);
 *   2. a numeric data-more-menu-item-id on the row or a portal ancestor;
 *   3. the trigger nearest the menu row: the menu is anchored to the trigger
 *      that opened it, so the nearest "..." is its owner even when
 *      aria-expanded is missing or stale;
 *   4. the trigger on the card covering the centre of the viewport.
 *
 * Only ONE trigger is taken from step 3. Offering its neighbours as fallbacks
 * would bring the original bug back: an id that cannot be resolved would float
 * the next card.
 */
function menuItemVideoIds(target) {
  const ids = [];
  const seen = Object.create(null);
  const add = (value) => {
    if (typeof value !== 'string') return;
    const id = value.trim();
    if (!VIDEO_ID_RE.test(id) || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  };

  const row = rectOf(target);

  // The user pressed this "..." moments before the menu row was clicked. A
  // remembered id older than a couple of minutes is not trusted: menus do not
  // stay open that long, so it must belong to an earlier one.
  if (lastMenuTrigger && Date.now() - lastMenuTrigger.at < 2 * 60 * 1000) {
    add(lastMenuTrigger.id);
  }

  // Newer markup may put the clip id on the row or on the portal around it.
  try {
    let el = target;
    for (let i = 0; i < 8 && el && el.nodeType === 1; i += 1, el = el.parentElement) {
      if (el.getAttribute) add(el.getAttribute('data-more-menu-item-id'));
    }
  } catch (_) {}

  let triggers = [];
  try {
    triggers = Array.prototype.slice.call(
      document.querySelectorAll('[data-e2e="more-menu-icon"][data-more-menu-item-id]')
    );
  } catch (_) {
    triggers = [];
  }

  // Nearest trigger by the menu row's position. Without a usable row rect this
  // signal is skipped: "nearest" would then be arbitrary.
  let nearest = null;
  let nearestDist = Infinity;
  for (let i = 0; i < triggers.length; i += 1) {
    const d = rectDistance(row, rectOf(triggers[i]));
    if (d < nearestDist) {
      nearestDist = d;
      nearest = triggers[i];
    }
  }
  if (nearest && Number.isFinite(nearestDist)) {
    add(nearest.getAttribute('data-more-menu-item-id'));
  }

  // display:contents can give the row no box of its own. Exactly one expanded
  // trigger is still a usable structural signal then; never guess among
  // several, because that is the stale-button case.
  if (!row) {
    const expanded = triggers.filter((t) => t.getAttribute('aria-expanded') === 'true');
    if (expanded.length === 1) add(expanded[0].getAttribute('data-more-menu-item-id'));
  }

  // Last structural resort: the card in the middle of the window.
  let best = '';
  let bestDist = Infinity;
  try {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    for (let i = 0; i < triggers.length; i += 1) {
      const b = triggers[i];
      let card = null;
      try {
        card = b.closest('article, section[data-e2e="feed-video"]');
      } catch (_) {
        card = null;
      }
      if (!card) continue;
      const r = rectOf(card);
      if (!r) continue;
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
  add(best);

  return ids;
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
 * preferredIds is the ordered list of clip ids read from the "..." menu that
 * opened the click ([data-e2e="more-menu-icon"][data-more-menu-item-id]
 * via menuItemVideoIds()). It is the only exact signal: TikTok wraps each
 * card's player in #xgwrapper-0-<id>, so the clip the menu belongs to can be
 * named, not guessed. Note the menu lives in a body-level portal, outside the
 * card, so the id has to travel through the click target or the menu button.
 * An id that names an off-screen clip is stale (a previously opened menu, a
 * duplicate wrapper); it is skipped, not turned into a verdict. The first id
 * that names a VISIBLE clip decides: if that clip cannot float, the answer is
 * null, not a neighbour.
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
function pickVisibleVideo(preferredIds) {
  const win = window;
  const doc = win.document;
  const vw = win.innerWidth || 0;
  const vh = win.innerHeight || 0;
  if (!doc || vw <= 0 || vh <= 0) return null;

  const ids = Array.isArray(preferredIds)
    ? preferredIds
    : preferredIds
      ? [preferredIds]
      : [];

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
  // the trigger with this id is climbed to its article/section card. A wrapper
  // that survived an SPA swap but no longer holds a video is treated the same
  // way: climb from the trigger instead of giving up.
  const bestVideoIn = (root) => {
    let list = [];
    try {
      list =
        root.tagName === 'VIDEO'
          ? [root]
          : Array.prototype.slice.call(root.querySelectorAll('video'));
    } catch (_) {
      list = [];
    }
    let best = null;
    let bestArea = -1;
    for (let i = 0; i < list.length; i += 1) {
      const r = visibleRectOf(list[i]);
      const area = r ? r.area : -1;
      if (area > bestArea) {
        bestArea = area;
        best = list[i];
      }
    }
    return best || list[0] || null;
  };

  const videoForId = (id) => {
    if (!id) return null;

    let wrapper = null;
    try {
      if (typeof doc.getElementById === 'function') {
        wrapper = doc.getElementById('xgwrapper-0-' + id);
      }
    } catch (_) {}

    if (wrapper) {
      const video = bestVideoIn(wrapper);
      if (video) return video;
    }

    try {
      const triggers = doc.querySelectorAll(
        '[data-e2e="more-menu-icon"][data-more-menu-item-id]'
      );
      for (let i = 0; i < triggers.length; i += 1) {
        const t = triggers[i];
        if (t.getAttribute('data-more-menu-item-id') !== id) continue;
        let card = null;
        try {
          card = t.closest('article, section[data-e2e="feed-video"]');
        } catch (_) {
          card = null;
        }
        if (!card) continue;
        const video = bestVideoIn(card);
        if (video) return video;
      }
    } catch (_) {}

    return null;
  };

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (!id) continue;
    const exact = videoForId(id);
    if (!exact) continue;
    // The id names a clip that is not on screen (a stale menu id, a duplicate
    // wrapper elsewhere in the SPA). That is not evidence about the visible
    // card, so try the next signal instead of declining or floating it.
    if (!visibleRectOf(exact)) continue;
    // The named clip is the one the user sees. If it cannot float, decline:
    // never fall through to a neighbour card.
    return finish(exact);
  }

  // The card, not the <video> box, is what the feed scrolls: a letterboxed
  // player may not contain the viewport centre even though its card does.
  const cardBox = (v) => {
    let card = null;
    try {
      card = v.closest && v.closest('article, section[data-e2e="feed-video"]');
    } catch (_) {
      card = null;
    }
    if (!card) return { covers: false, area: 0 };
    let r;
    try {
      r = card.getBoundingClientRect();
    } catch (_) {
      return { covers: false, area: 0 };
    }
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(vw, r.right);
    const bottom = Math.min(vh, r.bottom);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    const cx = vw / 2;
    const cy = vh / 2;
    const covers = area > 0 && cx >= left && cx <= right && cy >= top && cy <= bottom;
    return { covers, area };
  };

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
    const card = cardBox(v);
    candidates.push({
      v,
      r,
      covers,
      cardCovers: card.covers,
      cardArea: card.area,
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
    if (a.cardCovers !== b.cardCovers) return a.cardCovers ? -1 : 1;
    if (a.covers !== b.covers) return a.covers ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (a.cardArea !== b.cardArea) return b.cardArea - a.cardArea;
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

// ============================================================================
// The floating player is a MIRROR of the "Обзор" feed
// ============================================================================
//
// THE BUG THIS FIXES, measured from the user's own report: the floating window
// played "the right clip, then a clip that is not in the recommendations feed
// at all, then the next clip of the feed, and so on every time".
//
// That cycle is not a picking error — the clip is resolved correctly at the
// moment of the click (menuItemVideoIds + pickVisibleVideo below). It is what
// native Picture-in-Picture does afterwards:
//
//   * PiP is bound to ONE <video> ELEMENT for the whole session. There is no
//     API to hand the window a playlist, and the window has no idea a feed
//     exists.
//   * TikTok's feed is a list of CARDS served by a small pool of recycled
//     xgplayer instances. The element that played the floated clip is handed
//     the next-but-one clip to prefetch (a clip that is not on screen and may
//     never be rendered), then a feed clip again. The window follows the
//     element, so it alternates between "the feed" and "whatever this element
//     was recycled to".
//   * Scrolling the feed under the window makes it worse: the page keeps
//     advancing its own cards while the window stays on its element.
//
// So the window can never be "the feed" on its own. What DOES work is to keep
// re-pointing it at the clip the feed is showing:
//
//   * the feed stays the single source of truth — no second window, no second
//     TikTok session, no queue built from a different page (that is what the
//     removed custom player did, and why its recommendations differed);
//   * whenever the visible card's <video> is not the PiP element, PiP is
//     re-requested on it. Per the PiP spec, step 7 of requestPictureInPicture(),
//     user activation is required ONLY while document.pictureInPictureElement
//     is null — swapping the video of an ALREADY OPEN window needs no gesture.
//     That is what makes the mirror possible at all;
//   * "next" is a scroll of the real feed, so the window, the feed and the
//     recommendations order can never diverge: they are the same list.
//
// Auto-advance: TikTok's own «Автоматическая прокрутка» moves the feed when a
// clip ends, and the mirror follows it. When that toggle is off, the ended clip
// would sit in the window forever, so the mirror scrolls the feed itself after
// a grace period.

const PIP_POLL_MS = 400; // idle re-check; events below cover the fast paths
const PIP_SWAP_MIN_MS = 400; // throttle: a scroll animation must not flap the window
const PIP_ENDED_GRACE_MS = 2500; // let TikTok's own auto-scroll act first
const PIP_ADVANCE_CHECK_MS = 800; // did the feed actually move?
const PIP_MAX_CONSECUTIVE_FAILURES = 5; // Chromium refuses the swap -> stop trying

const pip = {
  active: false,
  timer: 0,
  swappedAt: 0,
  swapping: false,
  lastId: '',
  lastVisiblePrint: '',
  anchorVideo: null,
  anchorPrint: '',
  swaps: 0,
  failures: 0,
  consecutiveFailures: 0,
  advances: 0,
  endedTimer: 0,
  advanceTimers: [],
  lastReportedAt: {},
  lastReason: '',
};

/** Diagnostics for the app's «Диагностика» dialog and the main-process log. */
function pipReport(type, detail) {
  try {
    const now = Date.now();
    // Swaps happen on every card change; a long session must not flood IPC.
    // Every type is throttled on its own: a failure must not silence the
    // success that follows it.
    const last = pip.lastReportedAt[type] || 0;
    if (now - last < 250) return;
    pip.lastReportedAt[type] = now;
    ipcRenderer.send('feed:pip', {
      type,
      detail: detail || null,
      id: pip.lastId || '',
      swaps: pip.swaps,
      failures: pip.failures,
      advances: pip.advances,
    });
  } catch (_) {}
}

/**
 * The clip id a <video> belongs to, or ''. The player wrapper is
 * #xgwrapper-0-<clipId>; older markup carries the id on a data attribute or on
 * the card's own "..." trigger. Used only to tell "the feed moved" from "the
 * same card is still on screen", never to guess which clip to float.
 */
function pipClipId(video) {
  if (!video) return '';
  let el = video;
  for (let i = 0; i < 14 && el && el.nodeType === 1; i += 1, el = el.parentElement) {
    const own = typeof el.id === 'string' ? el.id : '';
    if (own.indexOf('xgwrapper-') === 0) {
      const tail = own.split('-').pop();
      if (VIDEO_ID_RE.test(tail)) return tail;
    }
    try {
      const attrs = ['data-more-menu-item-id', 'data-e2e-vid', 'data-vid', 'data-video-id', 'data-aweme-id'];
      for (let j = 0; j < attrs.length; j += 1) {
        const v = el.getAttribute && el.getAttribute(attrs[j]);
        if (v && VIDEO_ID_RE.test(v)) return v;
      }
    } catch (_) {}
    if (el === document.body) break;
  }
  try {
    const card = video.closest('article, section[data-e2e="feed-video"], [data-e2e="feed-video"]');
    const trigger = card && card.querySelector('[data-e2e="more-menu-icon"][data-more-menu-item-id]');
    const id = trigger && trigger.getAttribute('data-more-menu-item-id');
    if (id && VIDEO_ID_RE.test(id)) return id;
  } catch (_) {}
  return '';
}

/**
 * The scroll box the feed actually scrolls — the same rule as feed.js: the
 * scrollable box that holds the clip links of the feed. Taking the first
 * scrollable ancestor instead used to pick whatever column happened to be
 * scrollable, and on a video page that can be the recommendation sidebar.
 */
function pipScrollBox(video) {
  const scrollable = (el) => {
    try {
      const cs = window.getComputedStyle(el);
      const oy = (cs && (cs.overflowY || cs.overflow)) || '';
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      return el.scrollHeight > el.clientHeight + 40;
    } catch (_) {
      return false;
    }
  };

  // The feed's own links to clips.
  const anchors = [];
  try {
    const links = document.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i += 1) {
      const href = links[i].getAttribute('href') || '';
      if (href.indexOf('/video/') >= 0) anchors.push(links[i]);
    }
  } catch (_) {}

  // Start from the biggest visible video, like feed.js does.
  const starts = [];
  try {
    const list = document.querySelectorAll('video');
    const sized = [];
    for (let i = 0; i < list.length; i += 1) {
      const r = rectOf(list[i]);
      sized.push({ v: list[i], area: r ? r.width * r.height : 0 });
    }
    sized.sort((a, b) => b.area - a.area);
    for (const it of sized) starts.push(it.v);
  } catch (_) {}
  if (video) starts.unshift(video);

  for (let s = 0; s < starts.length; s += 1) {
    let el = starts[s] && starts[s].parentElement;
    for (let i = 0; i < 25 && el && el.nodeType === 1 && el !== document.body; i += 1, el = el.parentElement) {
      if (!scrollable(el)) continue;
      if (!anchors.length) return el; // no clip links: this column is all we have
      for (const a of anchors) {
        if (el.contains(a)) return el;
      }
    }
  }
  // Nothing found: the window itself must NOT be scrolled — that would throw
  // the user out of the feed.
  return null;
}

function pipCardOf(video) {
  try {
    return video.closest('article, section[data-e2e="feed-video"], [data-e2e="feed-video"]');
  } catch (_) {
    return null;
  }
}

/**
 * TikTok's own chevron for "next / previous clip", if this layout renders one.
 * Clicking it is the most faithful way to advance: the page runs its own
 * prefetch and play logic. Only visible buttons inside this feed are accepted,
 * so a chevron belonging to another column cannot be pressed by mistake.
 */
function pipSwitchButton(dir, box, card) {
  const selectors = dir > 0
    ? ['[data-e2e="feed-arrow-down"]', '[data-e2e="arrow-down"]', '[data-e2e="feed-arrow-right"]', '[data-e2e="arrow-right"]']
    : ['[data-e2e="feed-arrow-up"]', '[data-e2e="arrow-up"]', '[data-e2e="feed-arrow-left"]', '[data-e2e="arrow-left"]'];
  const wanted = dir > 0 ? /следующ|вниз|next|down/i : /предыдущ|вверх|previous|prev|up/i;
  const found = [];
  const push = (el) => {
    if (!el || found.indexOf(el) !== -1) return;
    const r = rectOf(el);
    if (!r) return;
    // Only a button of THIS feed column may be pressed. Without a column and
    // a card the check would accept any button on the page — «Скачать» or
    // «прокрутить вниз» included.
    if (!box && !card) return;
    if (box && el !== box && !box.contains(el) && !(card && card.contains(el))) return;
    if (!box && card && !card.contains(el)) return;
    found.push(el);
  };
  for (let i = 0; i < selectors.length; i += 1) {
    let list = [];
    try {
      list = document.querySelectorAll(selectors[i]);
    } catch (_) {
      list = [];
    }
    for (let j = 0; j < list.length; j += 1) push(list[j]);
    if (found.length) break;
  }
  if (!found.length) {
    // Locales without a known data-e2e: the aria-label still names the action.
    let buttons = [];
    try {
      buttons = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    } catch (_) {
      buttons = [];
    }
    for (let i = 0; i < buttons.length; i += 1) {
      const label = buttons[i].getAttribute('aria-label') || '';
      if (wanted.test(label)) push(buttons[i]);
    }
  }
  return found.length ? found[0] : null;
}

/**
 * Moves the REAL feed one card forward/back. Strategies are tried in order and
 * each is verified by the clip id actually changing, because a scroll that the
 * page ignores must not look like a successful "next".
 */
function pipAdvance(dir, reason) {
  if (!pip.active) return;
  const step = dir >= 0 ? 1 : -1;
  const current = pipVisible();
  const fromPrint = (current && pipFingerprint(current.video)) || pip.anchorPrint;
  const video = (current && current.video) || document.pictureInPictureElement;
  const box = pipScrollBox(video);
  const card = pipCardOf(video);
  pip.advances += 0;
  pipReport('advance-try', `${reason || 'manual'} ${step > 0 ? 'next' : 'prev'}`);

  const moved = () => {
    const now = pipVisible();
    if (!now || !now.video) return false;
    const print = pipFingerprint(now.video);
    // No identity in this markup at all: "a different element is on screen" is
    // then the only available evidence that the feed moved.
    if (!print && !fromPrint) return now.video !== video;
    return Boolean(print && print !== fromPrint);
  };

  const strategies = [
    () => {
      const btn = pipSwitchButton(step, box, card);
      if (!btn) return false;
      try {
        btn.click();
        return true;
      } catch (_) {
        return false;
      }
    },
    () => {
      if (!box) return false;
      const h = card && card.offsetHeight ? card.offsetHeight : 0;
      // The step of feed.js: a little less than a screen, so a card is not
      // skipped over.
      const unit =
        h > box.clientHeight * 0.5 && h < box.clientHeight * 1.5
          ? h
          : Math.round(box.clientHeight * 0.9);
      if (!(unit > 0)) return false;
      try {
        box.scrollTo({ top: box.scrollTop + step * unit, behavior: 'smooth' });
        return true;
      } catch (_) {
        box.scrollTop += step * unit;
        return true;
      }
    },
    () => {
      if (!box) return false;
      const unit = Math.round((box.clientHeight || window.innerHeight) * 0.9);
      try {
        box.scrollTop += step * unit;
        // Some layouts only react to a wheel event (same trick as feed.js).
        box.dispatchEvent(new WheelEvent('wheel', { deltaY: step * 1200, bubbles: true }));
        return true;
      } catch (_) {
        return false;
      }
    },
  ];

  let attempt = 0;
  let misses = 0;
  const tryNext = () => {
    if (!pip.active) return;
    if (moved()) {
      // Only a confirmed move counts: a scroll the page ignored must not look
      // like a successful "next".
      pip.advances += 1;
      pipReport('advance', (reason || 'manual') + ' ok');
      pipSync('advanced');
      return;
    }
    misses += 1;
    if (misses >= 2 && attempt < strategies.length) {
      // The previous strategy did not move the feed: try the next one. Two
      // strategies in a row would skip a clip, so the next one is used only
      // after the current one has clearly failed.
      misses = 0;
      const run = strategies[attempt];
      attempt += 1;
      let ok = false;
      try {
        ok = run();
      } catch (_) {
        ok = false;
      }
      if (!ok) {
        tryNext();
        return;
      }
    } else if (attempt >= strategies.length) {
      // End of the loaded feed, or a layout none of the strategies moves.
      pipReport('advance-stuck', reason || null);
      return;
    }
    const t = setTimeout(() => {
      pip.advanceTimers = pip.advanceTimers.filter((x) => x !== t);
      tryNext();
    }, PIP_ADVANCE_CHECK_MS);
    if (t.unref) t.unref();
    pip.advanceTimers.push(t);
  };
  tryNext();
}

/** The clip the feed is showing right now: the same resolver as the click path. */
function pipVisible() {
  const video = pickVisibleVideo([]);
  if (!video) return null;
  return { video, id: pipClipId(video) };
}

/**
 * Identity of what a <video> is playing: the clip id when the markup carries
 * one, otherwise the media URL. MSE hands TikTok a fresh blob: URL every time
 * a player is re-bound to another clip, so a changed fingerprint is the signal
 * that the element was recycled — which is precisely the moment the floating
 * window starts showing a clip that is not in the feed.
 */
function pipFingerprint(video) {
  if (!video) return '';
  // Both parts matter: the id names the clip, the media URL names the MEDIA
  // the element currently carries. MSE hands TikTok a fresh blob: URL every
  // time a player is re-bound to another clip, so the URL is the signal that
  // the element was recycled even when the wrapper kept its id.
  const parts = [];
  const id = pipClipId(video);
  if (id) parts.push('id:' + id);
  try {
    const src = video.currentSrc || video.src || '';
    if (src) parts.push('src:' + src);
  } catch (_) {}
  return parts.join('|');
}

/**
 * Re-points the open PiP window at the clip the feed is showing.
 *
 * Two conditions can trigger a swap, and nothing else can:
 *   * the feed moved — the visible clip is not the one it was a moment ago;
 *   * the floated element was recycled — it no longer plays the clip it was
 *     floated with (TikTok handed it a prefetch clip).
 *
 * The second condition is what kills the reported "right clip → foreign clip →
 * next feed clip" cycle. The first is what keeps the window on the feed when
 * the user scrolls, or when auto-scroll advances it.
 *
 * Deliberately NOT a trigger: "the PiP element is not the visible one" on its
 * own. The user may have floated a neighbour card on purpose, and taking that
 * away one tick later would be its own bug.
 *
 * Declines (keeps the window as it is) when nothing is visible, when the clip
 * is not ready, or when PiP is not open — it never opens a window on its own,
 * because that DOES need a user gesture.
 */
function pipSync(reason) {
  if (!pip.active) return;
  let open = null;
  try {
    open = document.pictureInPictureElement;
  } catch (_) {
    return;
  }
  // The window is gone: there is nothing to mirror. The leavepictureinpicture
  // event cannot be trusted for this — the spec fires it for a SWAP as well —
  // so the poll is the reliable place to notice a real close.
  if (!open) {
    pipStop();
    return;
  }
  const now = Date.now();
  if (pip.swapping || now - pip.swappedAt < PIP_SWAP_MIN_MS) return;
  const visible = pipVisible();
  if (!visible || !visible.video) return;
  const next = visible.video;
  const visiblePrint = pipFingerprint(next);

  if (next === open) {
    pip.lastId = visible.id || pip.lastId;
    // The window already shows the feed's clip, so the movement is accounted
    // for and the next tick must not mistake it for a new card.
    pip.lastVisiblePrint = visiblePrint;
    return;
  }

  const openPrint = pipFingerprint(open);
  const feedMoved = Boolean(visiblePrint && pip.lastVisiblePrint && visiblePrint !== pip.lastVisiblePrint);
  const recycled = Boolean(openPrint && pip.anchorPrint && openPrint !== pip.anchorPrint);
  const anchorGone = Boolean(pip.anchorVideo && pip.anchorVideo.isConnected === false);
  // pip.lastVisiblePrint is deliberately NOT updated here: while the new clip
  // is not ready yet, the movement must stay "unseen" so the next tick tries
  // again. Updating it now would leave the window on the old clip for good.
  if (reason !== 'advanced' && !feedMoved && !recycled && !anchorGone) return;

  if (next.disablePictureInPicture || next.error) return;
  if (!(next.readyState > 0)) return; // prefetch tag with no track yet
  if (typeof next.requestPictureInPicture !== 'function') return;

  const wasPlaying = !open.paused && !open.ended;
  const prev = open;
  pip.swapping = true;
  pip.swappedAt = now;
  pip.lastId = visible.id || '';
  let p = null;
  try {
    p = next.requestPictureInPicture();
  } catch (_) {
    p = null;
  }
  if (!p || typeof p.then !== 'function') {
    pip.swapping = false;
    pip.failures += 1;
    pip.consecutiveFailures += 1;
    pipReport('swap-failed', 'no-promise');
    return;
  }
  p.then(
    () => {
      pip.swapping = false;
      pip.swaps += 1;
      pip.consecutiveFailures = 0;
      pip.lastVisiblePrint = visiblePrint;
      pip.lastReason = reason || (recycled ? 'recycled' : 'feed');
      pip.anchorVideo = next;
      pip.anchorPrint = pipFingerprint(next);
      // The element the window came from is either off screen or handed to the
      // prefetcher, but it keeps playing in the page: that would be a second
      // audio track on top of the window.
      if (prev && prev !== next) {
        try {
          prev.pause();
        } catch (_) {}
      }
      pipReport('swap', pip.lastReason);
      // Continuity: the window was playing, so the clip it now shows plays too.
      // A window the user paused stays paused — wasPlaying is false then.
      if (wasPlaying && next.paused && !next.ended) {
        try {
          const play = next.play();
          if (play && typeof play.catch === 'function') play.catch(() => {});
        } catch (_) {}
      }
    },
    (err) => {
      pip.swapping = false;
      pip.failures += 1;
      pip.consecutiveFailures += 1;
      const name = (err && (err.name || err.message)) || 'error';
      pipReport('swap-failed', name);
      // Chromium can refuse the swap (it wants a user gesture). Retrying
      // forever would spam the page and the log, and the mirror must not keep
      // scrolling the feed while it cannot do its job: after a few refusals it
      // gives up and reports why.
      if (pip.consecutiveFailures >= PIP_MAX_CONSECUTIVE_FAILURES) {
        pip.active = false;
        if (pip.timer) clearInterval(pip.timer);
        pip.timer = 0;
        pipReport('mirror-disabled', 'swap failed ' + pip.consecutiveFailures + 'x: ' + name);
      }
    }
  );
}

/** Media Session is what puts «next / previous» buttons in the PiP window. */
function pipInstallActions() {
  try {
    const ms = navigator.mediaSession;
    if (!ms || typeof ms.setActionHandler !== 'function') return;
    // The handlers are NOT released when the window closes: the Media Session
    // API has no getter, so removing them would take the page's own handlers
    // with them, irreversibly. Our handlers check pip.active themselves and
    // do nothing once the mirror is off.
    ms.setActionHandler('nexttrack', () => pipAdvance(1, 'mediasession'));
    ms.setActionHandler('previoustrack', () => pipAdvance(-1, 'mediasession'));
  } catch (_) {}
}

function pipStart(anchorEl) {
  const el = anchorEl || null;
  if (pip.active) {
    // The window was opened again on another clip (the user pressed Chromium's
    // own PiP button). That clip is the new anchor: taking the window away
    // from it one tick later would be its own bug.
    if (el && el !== pip.anchorVideo) {
      pip.anchorVideo = el;
      pip.anchorPrint = pipFingerprint(el);
    }
    return;
  }
  pip.active = true;
  pip.consecutiveFailures = 0;
  // What the user floated is the anchor: the mirror only takes the window away
  // from it when the feed moves or the element is recycled, never just because
  // another card happens to be the visible one.
  pip.anchorVideo = el || document.pictureInPictureElement || null;
  pip.anchorPrint = pipFingerprint(pip.anchorVideo);
  pip.lastId = pipClipId(pip.anchorVideo);
  const visible = pipVisible();
  pip.lastVisiblePrint = visible ? pipFingerprint(visible.video) : pip.anchorPrint;
  pipInstallActions();
  pip.timer = setInterval(() => pipSync('poll'), PIP_POLL_MS);
  if (pip.timer.unref) pip.timer.unref();
  pipReport('open', null);
}

function pipStop() {
  if (!pip.active) return;
  pip.active = false;
  if (pip.timer) clearInterval(pip.timer);
  pip.timer = 0;
  if (pip.endedTimer) clearTimeout(pip.endedTimer);
  pip.endedTimer = 0;
  for (const t of pip.advanceTimers) clearTimeout(t);
  pip.advanceTimers = [];
  pip.swapping = false;
  pip.anchorVideo = null;
  pip.anchorPrint = '';
  pip.lastVisiblePrint = '';
  pipReport('close', null);
}

/**
 * A window that was closed by the user must stop the mirror; a window whose
 * video was SWAPPED must not. The spec fires leavepictureinpicture on the old
 * element before the new one is assigned, so the decision is taken one task
 * later, when document.pictureInPictureElement is settled.
 */
function pipCheckStillOpen() {
  setTimeout(() => {
    let open = null;
    try {
      open = document.pictureInPictureElement;
    } catch (_) {}
    if (open) pipStart(open);
    else pipStop();
  }, 60);
}

function installPipMirror() {
  if (window.__tkmPipMirrorDoc === document) return;
  window.__tkmPipMirrorDoc = document;

  // The event carries the element the window was opened on: that is the
  // anchor, even when the mirror was already running.
  document.addEventListener(
    'enterpictureinpicture',
    (event) => pipStart((event && event.target) || null),
    true
  );
  document.addEventListener('leavepictureinpicture', () => pipCheckStillOpen(), true);

  // The fast paths. A recycled element announces itself with loadstart/emptied
  // long before the next poll: that is the exact moment the window would start
  // showing a clip that is not in the feed.
  const onFeedSignal = () => pipSync('signal');
  document.addEventListener('scroll', onFeedSignal, true);
  document.addEventListener('loadstart', onFeedSignal, true);
  document.addEventListener('emptied', onFeedSignal, true);
  document.addEventListener('loadeddata', onFeedSignal, true);
  document.addEventListener('playing', onFeedSignal, true);
  window.addEventListener('resize', onFeedSignal);

  // Auto-advance when TikTok's own «Автоматическая прокрутка» is off. The grace
  // period lets the page move the feed first, so the two never fight.
  document.addEventListener(
    'ended',
    (event) => {
      if (!pip.active) return;
      const target = event.target;
      if (!target || target !== document.pictureInPictureElement) return;
      if (pip.endedTimer) clearTimeout(pip.endedTimer);
      const endedId = pipClipId(target);
      // The fingerprint, not the element: the page reuses the same <video> for
      // the next clip, so "the element changed" would never fire and the
      // mirror would scroll the feed a second time, past a clip.
      const endedPrint = pipFingerprint(target);
      pip.endedTimer = setTimeout(() => {
        pip.endedTimer = 0;
        if (!pip.active) return;
        // A mirror that cannot switch the window must not move the feed.
        if (pip.consecutiveFailures > pip.swaps) return;
        const now = pipVisible();
        if (!now || !now.video) return;
        if (endedPrint && pipFingerprint(now.video) !== endedPrint) return; // page moved
        if (now.id && endedId && now.id !== endedId) return; // page moved
        pipAdvance(1, 'ended');
      }, PIP_ENDED_GRACE_MS);
      if (pip.endedTimer.unref) pip.endedTimer.unref();
    },
    true
  );

  // A window that was already open when this document was armed (SPA swap).
  try {
    if (document.pictureInPictureElement) pipStart(document.pictureInPictureElement);
  } catch (_) {}

  // Read-only handle for the self-test and for debugging in the guest console.
  window.__tkmPip = {
    get active() {
      return pip.active;
    },
    get swaps() {
      return pip.swaps;
    },
    get failures() {
      return pip.failures;
    },
    get advances() {
      return pip.advances;
    },
    get lastId() {
      return pip.lastId;
    },
    sync: (why) => pipSync(why || 'manual'),
    next: () => pipAdvance(1, 'manual'),
    prev: () => pipAdvance(-1, 'manual'),
  };
}

function install() {
  // Guard on the document, not on window: TikTok's SPA swaps the document on
  // route changes, and a listener left on the old one is dead. Re-attaching per
  // document is what makes the interception survive navigation.
  if (window.__tkmPreloadHooks && window.__tkmPreloadDoc === document) return;
  window.__tkmPreloadHooks = true;
  window.__tkmPreloadDoc = document;

  // The floating window must follow the feed for the whole session, not just
  // resolve the right clip once at the click. Armed independently of the menu
  // interception: PiP opened by Chromium's own toolbar button is mirrored too.
  installPipMirror();
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

  // TikTok leaves aria-expanded="true" on the "..." buttons of previously
  // opened menus, so "the expanded trigger" can be an older card. Remember the
  // button the user actually pressed instead. Pointerdown covers menus that
  // open before a click is dispatched; click covers keyboard activation.
  const rememberTrigger = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    let trigger = null;
    try {
      trigger = target.closest(
        '[data-e2e="more-menu-icon"][data-more-menu-item-id]'
      );
    } catch (_) {
      trigger = null;
    }
    if (trigger) rememberMenuTrigger(trigger);
  };
  document.addEventListener('pointerdown', rememberTrigger, true);
  document.addEventListener('click', rememberTrigger, true);

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
  // queue and no switching inside the window. The clip is resolved from the
  // "..." trigger the user pressed before the click is cancelled; if that id is
  // not available, the trigger nearest the open menu wins, then the card
  // covering the centre of the viewport. A resolved clip that cannot float
  // declines the click instead of substituting a neighbour.
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
      const clipIds = closing ? [] : menuItemVideoIds(target);
      const video = closing ? null : pickVisibleVideo(clipIds);
      if (!closing && (!video || video.disablePictureInPicture || video.isConnected === false)) return;

      // The menu click is consumed: a remembered trigger must not leak into the
      // next menu (for example another surface's "..." without a clip id).
      lastMenuTrigger = null;

      event.preventDefault();
      event.stopImmediatePropagation();

      // Already floating: the same item closes it again.
      if (closing) {
        document.exitPictureInPicture().catch(() => {});
        return;
      }
      // The mirror takes over from the enterpictureinpicture event; anchoring it
      // here as well means the clicked clip is the reference even if that event
      // is delivered before this promise settles.
      pip.anchorVideo = video;
      pip.anchorPrint = pipFingerprint(video);
      pip.lastId = clipIds.length ? clipIds[0] : pipClipId(video);
      video.requestPictureInPicture().then(
        () => pipStart(),
        (err) => pipReport('open-failed', (err && (err.name || err.message)) || 'error')
      );
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
