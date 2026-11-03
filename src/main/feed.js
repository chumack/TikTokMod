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
 * Collects the feed's cards in the order they appear ON SCREEN, plus whatever
 * metadata the DOM already exposes (thumbnail, author, caption, view count).
 *
 * Two things matter here, and both were wrong before:
 *
 *  - the feed's scroll container, not the whole document. TikTok renders the
 *    signed-in user's header, the navigation rail and the recommendation
 *    sidebar next to the feed; anchors from those are not "the feed" and used
 *    to be queued as if they were;
 *  - visual order, not DOM order. React recycles feed cards, so a node created
 *    later can sit above one created earlier. The queue follows the viewport
 *    rect, which is exactly what the user sees.
 */
const COLLECT_SCRIPT = `(() => {
  const out = [];
  const seen = new Set();
  const A_RE = 'a[href*="/video/"], a[href*="/photo/"]';
  const ID_RE = /\\/@([\\w.\\-]+)\\/(video|photo)\\/(\\d{6,})/;

  const parse = (a) => {
    const href = (a && a.getAttribute && a.getAttribute('href')) || '';
    const m = href.match(ID_RE);
    if (!m) return null;
    return { id: m[3], handle: m[1], kind: m[2], photo: m[2] === 'photo' };
  };

  const anchors = Array.from(document.querySelectorAll(A_RE));

  // A card is the anchor's nearest ancestor that holds exactly this one video
  // anchor and a thumbnail. Never an ancestor with several cards: that is the
  // feed itself, and its first image belongs to a different clip.
  const cardOf = (a) => {
    let el = a;
    for (let i = 0; i < 6 && el && el !== document.body; i += 1, el = el.parentElement) {
      if (!el.querySelectorAll) continue;
      const own = el.querySelectorAll(A_RE);
      if (own.length === 1 && el.querySelector('img')) return el;
    }
    return a;
  };

  const rectOf = (a) => {
    try {
      return a.getBoundingClientRect();
    } catch (_) {
      return null;
    }
  };

  const scrollable = (n) => {
    try {
      const oy = getComputedStyle(n).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      return n.scrollHeight > n.clientHeight + 40;
    } catch (_) {
      return false;
    }
  };

  // The feed is the scroll box that holds the clip currently on screen. Picking
  // the largest scrollable box instead used to select whatever column happened
  // to be tallest; on a video page that can be the recommendation sidebar.
  const currentScroll = () => {
    const vids = [];
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const area = w * h;
      if (area > 0) vids.push({ v, area });
    }
    vids.sort((a, b) => b.area - a.area);
    for (const { v } of vids) {
      let el = v.parentElement;
      for (let i = 0; i < 20 && el && el !== document.body; i += 1, el = el.parentElement) {
        if (!scrollable(el)) continue;
        for (const a of anchors) if (el.contains(a)) return el;
      }
    }
    return null;
  };

  let root = currentScroll();

  // No playing <video> yet (first load, a photo-only feed): the scroll box with
  // the most distinct clip anchors is the feed.
  if (!root) {
    let bestCount = 0;
    for (const n of document.querySelectorAll('div, main, section')) {
      if (!scrollable(n)) continue;
      let count = 0;
      const local = new Set();
      for (const a of anchors) {
        if (!n.contains(a)) continue;
        const p = parse(a);
        if (p && !local.has(p.id)) { local.add(p.id); count += 1; }
      }
      if (count > bestCount) { bestCount = count; root = n; }
    }
    if (bestCount < 2) root = null;
  }
  if (!root) root = document.body;

  const included = anchors.filter((a) => {
    if (!root.contains(a)) return false;
    if (root === document.body && a.closest('header, nav, aside')) return false;
    const r = rectOf(a);
    if (!r || r.width <= 0 || r.height <= 0) return false;
    return true;
  });

  const scroller = root === document.body
    ? (document.scrollingElement || document.documentElement)
    : root;
  const baseTop = scroller ? Number(scroller.scrollTop) || 0 : 0;
  const baseLeft = scroller ? Number(scroller.scrollLeft) || 0 : 0;

  const rows = [];
  for (const a of included) {
    const p = parse(a);
    if (!p) continue;
    const r = rectOf(a);
    if (!r) continue;
    rows.push({ a, p, r });
  }
  rows.sort((x, y) => {
    const dy = Math.round(x.r.top) - Math.round(y.r.top);
    if (dy) return dy;
    return Math.round(x.r.left) - Math.round(y.r.left);
  });

  for (const row of rows) {
    const { a, p, r } = row;
    if (seen.has(p.id)) continue;
    seen.add(p.id);

    const card = cardOf(a);
    const img = (card.querySelector && card.querySelector('img')) || a.querySelector('img');
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
      id: p.id,
      handle: p.handle,
      url: 'https://www.tiktok.com/@' + p.handle + '/' + p.kind + '/' + p.id,
      thumbnail: img ? (img.currentSrc || img.src || '') : '',
      // The card's own alt/aria text is the caption in most TikTok layouts.
      title: (img && img.alt) || a.getAttribute('aria-label') || (text.split('\\n')[0] || '').slice(0, 120),
      viewCount,
      isPhoto: p.photo,
      // Offset inside the scroll container. buildPlaylist uses it only when the
      // current clip was not part of the collected window.
      pos: baseTop + r.top,
      left: baseLeft + r.left,
    });
    if (out.length >= 200) break;
  }
  return out;
})()`;

/**
 * Script that scrolls the feed so more items render. TikTok's feed is an
 * infinite scroll container, so scrolling its own element is more reliable than
 * scrolling the window.
 *
 * It also remembers which element and which offset it moved, so collect() can
 * put the tab back where the user left it. Growing the floating queue must not
 * scroll the feed away under the user.
 */
const SCROLL_SCRIPT = `(() => {
  const A_RE = 'a[href*="/video/"], a[href*="/photo/"]';
  const anchors = Array.from(document.querySelectorAll(A_RE));
  const scrollable = (n) => {
    try {
      const oy = getComputedStyle(n).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      return n.scrollHeight > n.clientHeight + 40;
    } catch (_) {
      return false;
    }
  };

  let target = null;
  const vids = [];
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const area = w * h;
    if (area > 0) vids.push({ v, area });
  }
  vids.sort((a, b) => b.area - a.area);
  for (const { v } of vids) {
    let el = v.parentElement;
    for (let i = 0; i < 20 && el && el !== document.body; i += 1, el = el.parentElement) {
      if (!scrollable(el)) continue;
      for (const a of anchors) if (el.contains(a)) { target = el; break; }
      if (target) break;
    }
    if (target) break;
  }

  if (!target) {
    let bestCount = 0;
    for (const n of document.querySelectorAll('div, main, section')) {
      if (!scrollable(n)) continue;
      let count = 0;
      const local = new Set();
      for (const a of anchors) {
        if (!n.contains(a)) continue;
        const m = (a.getAttribute('href') || '').match(/\\/(?:video|photo)\\/(\\d{6,})/);
        if (m && !local.has(m[1])) { local.add(m[1]); count += 1; }
      }
      if (count > bestCount) { bestCount = count; target = n; }
    }
  }
  if (!target) {
    let area = -1;
    for (const n of document.querySelectorAll('div')) {
      if (n.scrollHeight <= n.clientHeight + 40) continue;
      const a = n.clientWidth * n.clientHeight;
      if (a > area) { area = a; target = n; }
    }
  }
  if (!target) target = document.scrollingElement;
  if (!target) return 0;

  window.__tkmScrollEl = target;
  window.__tkmScrollBefore = target.scrollTop;
  const before = target.scrollTop;
  target.scrollTop = before + Math.round(target.clientHeight * 0.9);
  // Some layouts only react to a wheel event.
  target.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true }));
  return target.scrollTop - before;
})()`;

/**
 * Puts the feed back where SCROLL_SCRIPT found it. Without this, "extend the
 * floating queue" would scroll the tab the user is about to return to, so the
 * clip they were watching would no longer be on screen.
 */
const RESTORE_SCROLL_SCRIPT = `(() => {
  const el = window.__tkmScrollEl;
  if (!el || !el.isConnected) return 0;
  const before = Number(el.scrollTop) || 0;
  const want = Math.max(0, Number(window.__tkmScrollBefore) || 0);
  el.scrollTop = want;
  window.__tkmScrollEl = null;
  return before - want;
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
    // Visibility first: a playing clip that has already scrolled off screen is
    // not what the user is looking at. Ranking by playing alone used to return
    // the previous card after the feed advanced.
    if (a.inView !== b.inView) return a.inView ? -1 : 1;
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    return b.area - a.area;
  });
  const best = scored[0] || null;
  if (best) {
    out.src = best.v.currentSrc || best.v.src || null;
    out.playing = best.playing;
  }

  // Walk up from the on-screen <video>: the id can sit on the wrapper element
  // (xgwrapper-<idx>-<postId>) or on an ancestor anchor.
  if (best) {
    let el = best.v;
    for (let i = 0; i < 25 && el; i++) {
      const own = String(el.id || '');
      if (own.indexOf('xgwrapper-') === 0) {
        const tail = own.split('-').pop();
        if (/^\\d{6,}$/.test(tail)) { out.id = tail; break; }
      }
      // An anchor is only trustworthy while the chain still belongs to ONE
      // card. On a shared feed container querySelector returns the first anchor
      // in document order — a different clip — which is how the floating player
      // used to open the wrong video.
      const self = el.matches && el.matches('a[href*="/video/"], a[href*="/photo/"]') ? el : null;
      if (self && take(self.getAttribute('href'))) break;
      const alone = el.querySelectorAll && el.querySelectorAll('video').length === 1;
      if (alone) {
        const wrap = el.querySelector('[id^="xgwrapper-"]');
        if (wrap) {
          const tail = wrap.id.split('-').pop();
          if (/^\\d{6,}$/.test(tail)) { out.id = tail; break; }
        }
        const a = el.querySelector('a[href*="/video/"], a[href*="/photo/"]');
        if (a && take(a.getAttribute('href'))) break;
      }
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

  // Caption scoped to the card that owns THIS video. A document-wide query
  // returns the first card's caption and used to label the wrong clip.
  if (best) {
    let card = best.v;
    for (let i = 0; i < 8 && card && card.parentElement; i += 1) {
      card = card.parentElement;
      if (card.querySelectorAll && card.querySelectorAll('video').length === 1) break;
    }
    const cap =
      card.querySelector &&
      card.querySelector('[data-e2e="video-desc"], [data-e2e="browse-video-desc"], [data-e2e="video-title"]');
    if (cap) out.title = (cap.textContent || '').trim().slice(0, 120);
  }

  out.videos = scored.length;
  return out;
})()`;

 /**
  * BEST-EFFORT DOM fallback for live chat. The WebSocket tap (see
  * src/preload/webview-preload.js) is the primary source; this harvests what
  * the user SEES in the chat column for the case the socket lives somewhere
  * unreachable (e.g. opened inside a Worker).
  *
  * The selectors are HEURISTIC — TikTok hashes its class names, so this locates
  * the chat column by its visible text (/зрител|viewer/i) or, failing that, by
  * the densest short-text container in the right third of the viewport — and
  * may break on a TikTok redesign. It must NEVER throw into the recording
  * path: every DOM touch is guarded, and main.js only calls the drain script
  * through runInGuest(), which itself never throws.
  *
  * Self-contained IIFE, idempotent via window.__tkmChatWatch. Rows accumulate
* in window.__tkmDomChat (capped, consecutive-duplicate-free) for
   * CHAT_DRAIN_SCRIPT to collect.
   *
   * The buffer name is NOT __tkmChat: that one belongs to the contextBridge
   * object exposed by webview-preload.js for the socket tap, and it is an object,
   * not an array. Reusing it would make `arr.push` throw and silently kill the
   * DOM fallback that actually works today.
   */
  const CHAT_WATCH_SCRIPT = `(() => {
    if (window.__tkmChatWatch) return "already";
    window.__tkmChatWatch = true;
    if (!window.__tkmDomChat) window.__tkmDomChat = [];
    var MAX = 500;
   var lastAuthor = "##none##";
   var lastText = "##none##";
   var column = null;
   var columnAt = 0;
   function isSpace(code) {
     return code === 9 || code === 10 || code === 13 || code === 32 || code === 160;
   }
   function clean(s) {
     s = String(s == null ? "" : s);
     var out = "";
     var pendingSpace = false;
     var started = false;
     for (var i = 0; i < s.length; i++) {
       var code = s.charCodeAt(i);
       if (isSpace(code)) {
         if (started) pendingSpace = true;
         continue;
       }
       if (pendingSpace) {
         out += " ";
         pendingSpace = false;
       }
       out += s.charAt(i);
       started = true;
     }
     return out;
   }
   function push(author, text) {
     author = clean(author);
     text = clean(text);
     if (!text) return;
     if (text.length > 300) text = text.slice(0, 300);
     if (author === lastAuthor && text === lastText) return;
     lastAuthor = author;
     lastText = text;
var arr = window.__tkmDomChat;
      arr.push({ text: text, author: author, time: Date.now() });
     if (arr.length > MAX) arr.splice(0, arr.length - MAX);
   }
   function authorOf(el) {
     try {
       var cand = el.querySelector("b, strong, a");
       if (cand) {
         var name = clean(cand.textContent);
         if (name && name.length <= 60) return name;
       }
     } catch (_) {}
     return "";
   }
   function rowText(el) {
     try {
       if (typeof el.innerText === "string") return el.innerText;
       return el.textContent || "";
     } catch (_) {
       return "";
     }
   }
   function findColumn() {
     var all = null;
     try {
       all = document.querySelectorAll("div");
     } catch (_) {
       return null;
     }
     var i, el, t;
     var best = null;
     var bestLen = 0;
     for (i = 0; i < all.length; i++) {
       el = all[i];
       try {
         t = el.innerText || "";
       } catch (_) {
         continue;
       }
       if (!t) continue;
       if (/зрител|viewer/i.test(t.slice(0, 2000))) {
         if (best === null || t.length < bestLen) {
           best = el;
           bestLen = t.length;
         }
       }
     }
     if (best) return best;
     var vw = 1280;
     try {
       vw = window.innerWidth || 1280;
     } catch (_) {}
     var bestEl = null;
     var bestScore = 0;
     for (i = 0; i < all.length; i++) {
       el = all[i];
       var r = null;
       try {
         r = el.getBoundingClientRect();
       } catch (_) {
         continue;
       }
       if (!r || r.width <= 0 || r.height <= 0) continue;
       if (r.left < vw * 0.66) continue;
       var kids = null;
       try {
         kids = el.children;
       } catch (_) {
         continue;
       }
       if (!kids || !kids.length) continue;
       var short = 0;
       var lim = kids.length > 50 ? 50 : kids.length;
       for (var k = 0; k < lim; k++) {
         var kt = "";
         try {
           kt = clean(kids[k].innerText);
         } catch (_) {
           continue;
         }
         if (kt && kt.length <= 200) short++;
       }
       if (short > bestScore) {
         bestScore = short;
         bestEl = el;
       }
     }
     return bestScore > 0 ? bestEl : null;
   }
   function getColumn() {
     var now = 0;
     try {
       now = Date.now();
     } catch (_) {}
     if (column && column.isConnected && now - columnAt < 10000) return column;
     column = findColumn();
     columnAt = now;
     return column;
   }
   function harvestNode(node, depth) {
     if (!node || node.nodeType !== 1) return;
     if (depth > 6) return;
     var tag = "";
     try {
       tag = node.tagName || "";
     } catch (_) {
       return;
     }
     if (tag === "SCRIPT" || tag === "STYLE" || tag === "VIDEO" || tag === "IMG" || tag === "SVG") return;
     var col = getColumn();
     if (col) {
       var inCol = false;
       try {
         inCol = col.contains(node);
       } catch (_) {
         inCol = false;
       }
       if (!inCol) {
         var wrapsCol = false;
         try {
           wrapsCol = node.contains(col);
         } catch (_) {
           wrapsCol = false;
         }
         if (!wrapsCol) return;
       }
     }
     var text = clean(rowText(node));
     if (text && text.length <= 300) {
       push(authorOf(node), text);
       return;
     }
     var kids = null;
     try {
       kids = node.children;
     } catch (_) {
       return;
     }
     if (!kids) return;
     for (var i = 0; i < kids.length; i++) harvestNode(kids[i], depth + 1);
   }
   var obs = null;
   try {
     obs = new MutationObserver(function (muts) {
       try {
         for (var i = 0; i < muts.length; i++) {
           var added = muts[i].addedNodes;
           if (!added) continue;
           for (var j = 0; j < added.length; j++) harvestNode(added[j], 0);
         }
       } catch (_) {}
     });
   } catch (_) {
     return "no-observer";
   }
   try {
     obs.observe(document.body, { childList: true, subtree: true });
   } catch (_) {
     try {
       obs.observe(document.documentElement, { childList: true, subtree: true });
     } catch (_) {
       return "no-body";
     }
   }
   return "installed";
 })()`;

 /**
* Returns window.__tkmDomChat and clears it. Run via runInGuest() (CSP-immune
   * main-world executeJavaScript), so it works even where page CSP blocks every
   * other injection channel.
   */
  const CHAT_DRAIN_SCRIPT = `(() => {
    var a = window.__tkmDomChat || [];
    window.__tkmDomChat = [];
    return a;
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
 *
 * `scroll` makes TikTok render the next batch. `restore` (used by the floating
 * player) puts the tab back where it was first: growing the queue must not move
 * the clip the user is watching.
 */
async function collect({ scroll = false, restore = false, previous = [] } = {}) {
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

  let res = null;
  let items = [];
  let failure = null;
  let restored = null;
  try {
    res = await runInGuest(COLLECT_SCRIPT);
    if (!res || !res.ok) failure = res || { ok: false, error: 'Страница не ответила.' };
    else items = Array.isArray(res.value) ? res.value : [];
  } finally {
    if (scroll && restore) {
      // Let the scrolled batch settle before moving the tab back. The items are
      // already read above, so restoring cannot lose them.
      await new Promise((r) => setTimeout(r, 120));
      const back = await runInGuest(RESTORE_SCROLL_SCRIPT);
      if (back.ok) restored = back.value;
    }
  }
  if (failure) return failure;

  const merged = new Map();
  for (const it of previous) if (it && it.id) merged.set(it.id, it);
  for (const it of items) if (it && it.id && !merged.has(it.id)) merged.set(it.id, it);
  const all = Array.from(merged.values());

  return {
    ok: true,
    url,
    scrolled,
    restored,
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
    out.url =
      'https://www.tiktok.com/@' +
      (out.handle || '_') +
      '/' +
      (out.isPhoto ? 'photo/' : 'video/') +
      out.vid;
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
 * Converts a CURRENT_SCRIPT result into the queue's item shape. Kept next to
 * currentPlaying() because the click path in main.js resolves coordinates with
 * currentVideo() directly and must produce the same shape.
 */
function videoFromCurrent(v) {
  if (!v || !v.vid) return null;
  const isPhoto = Boolean(v.isPhoto);
  const handle = v.handle || '';
  const url =
    v.url ||
    'https://www.tiktok.com/@' + (handle || '_') + (isPhoto ? '/photo/' : '/video/') + v.vid;
  return {
    id: String(v.vid),
    handle,
    url,
    title: v.title || '',
    thumbnail: v.thumb || '',
    isPhoto,
    playing: Boolean(v.playing),
    src: v.srcUrl || null,
  };
}

/**
 * Resolves the video the app is showing right now, whatever state the feed is in.
 *
 * It never waits for the feed: the user wants whatever is on screen, and TikTok
 * renders anchors to /video/<id> continuously while more cards stream in.
 *
 * CURRENT_SCRIPT is the primary resolver (same one as the right-click path): it
 * ranks by visible area and resolves the anchor of THAT element. PLAYING_SCRIPT
 * is only a fallback for pages where CURRENT_SCRIPT finds no <video> at all —
 * it used to be the primary and could return an off-screen or neighbouring
 * card, which is exactly how the floating player opened a different clip.
 */
async function currentPlaying() {
  const cur = await currentVideo();
  if (cur && cur.ok && cur.video) {
    const mapped = videoFromCurrent(cur.video);
    if (mapped) return { ok: true, video: mapped };
  }

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

/**
 * Pauses whatever the built-in browser is playing, and remembers it, so the
 * floating player can own the speakers while it is open.
 *
 * The marker is an attribute rather than a JS variable on purpose: `runInGuest`
 * executes a fresh script every time, and an element reference cannot survive
 * between calls. The attribute also survives a TikTok re-render of the
 * surrounding card, which is why it is not a WeakSet either.
 *
 * Only <video> elements that are actually playing and have real area are
 * paused. TikTok keeps zero-sized prefetch tags around, and marking those
 * would make resumeAfterFloating() start a hidden clip later.
 */
const FLOAT_PAUSE_SCRIPT = `(() => {
  let n = 0;
  for (const v of document.querySelectorAll('video')) {
    if (v.paused || v.ended) continue;
    const r = v.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    v.setAttribute('data-tkm-float-paused', '1');
    try { v.pause(); } catch (_) {}
    n += 1;
  }
  return n;
})()`;

/**
 * Resumes exactly the clips pauseForFloating() stopped. A clip that TikTok has
 * already moved away from is gone with the attribute, so nothing else starts.
 */
const FLOAT_RESUME_SCRIPT = `(() => {
  let n = 0;
  for (const v of document.querySelectorAll('video[data-tkm-float-paused]')) {
    v.removeAttribute('data-tkm-float-paused');
    // The user may have scrolled the tab while the player was open. A marked
    // clip that is no longer on screen must not start playing next to whatever
    // TikTok shows now.
    const r = v.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    try {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      n += 1;
    } catch (_) {}
  }
  return n;
})()`;

async function pauseForFloating() {
  const res = await runInGuest(FLOAT_PAUSE_SCRIPT);
  return res.ok ? Number(res.value) || 0 : 0;
}

async function resumeAfterFloating() {
  const res = await runInGuest(FLOAT_RESUME_SCRIPT);
  return res.ok ? Number(res.value) || 0 : 0;
}

/**
 * Finds LIVE broadcasts reachable from the page currently open in the embedded
 * browser: the room the user navigated to, plus every live link the feed
 * happens to render.
 *
 * Read-only and cheap by design. The actual media URL is NOT resolved here: a
 * cross-origin fetch to webcast.tiktok.com from inside the page is blocked by
 * CORS, so src/main/live.js does that over the main-process session instead,
 * which also carries the user's proxy.
 */
const LIVE_SCRIPT = `(() => {
  const out = { page: null, candidates: [] };

  const onLive = (location.pathname || '').match(/\\/@([A-Za-z0-9._-]+)\\/live(?:\\/(\\d{5,}))?/i);
  if (onLive) {
    out.page = {
      handle: onLive[1],
      roomId: onLive[2] || '',
      url: location.origin + location.pathname,
    };
  }

  const seen = new Map();
  const anchors = document.querySelectorAll('a[href*="/live"]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/@([A-Za-z0-9._-]+)\\/live(?:\\/(\\d{5,}))?/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    const r = a.getBoundingClientRect();
    const onScreen =
      r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    seen.set(key, {
      handle: m[1],
      roomId: m[2] || '',
      url: 'https://www.tiktok.com/@' + m[1] + '/live',
      title: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      visible: onScreen,
    });
  }

  // On-screen links first: those are the broadcasts the user is looking at.
  out.candidates = [...seen.values()]
    .sort((x, y) => (x.visible === y.visible ? 0 : x.visible ? -1 : 1))
    .slice(0, 40);
  return out;
})()`;

async function detectLive() {
  const res = await runInGuest(LIVE_SCRIPT, { timeout: 12000 });
  if (!res.ok) return res;
  const v = res.value || {};
  return {
    ok: true,
    page: v.page || null,
    candidates: Array.isArray(v.candidates) ? v.candidates : [],
  };
}

module.exports = {
  collect,
  currentVideo,
  currentPlaying,
  videoFromCurrent,
  pauseForFloating,
  resumeAfterFloating,
  detectLive,
  installHooks,
  runInGuest,
  setWebviewId,
  COLLECT_SCRIPT,
  SCROLL_SCRIPT,
  RESTORE_SCROLL_SCRIPT,
  CURRENT_SCRIPT,
  PLAYING_SCRIPT,
  LIVE_SCRIPT,
  HOOK_SCRIPT,
  CHAT_WATCH_SCRIPT,
  CHAT_DRAIN_SCRIPT,
};
