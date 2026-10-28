'use strict';

// Preload for the TikTok page loaded inside the floating player's <webview>.
//
// The page is used as a video decoder, not as a page: TikTok's header, side
// bars, comments, login prompts and player chrome are all hidden, and only the
// <video> that is actually showing the clip stays visible. Everything the user
// can press lives in the host window (renderer/floating.js), which is why the
// video is made pointer-transparent: no TikTok handler can pause it, navigate
// away, or open a modal behind the user's back.
//
// Why not keep TikTok's own mini-player? Its openMiniPlayer() is Document
// Picture-in-Picture, which Electron does not implement (electron#39633). The
// row exists, the click is a no-op. See src/preload/webview-preload.js.

const { ipcRenderer } = require('electron');

const VIDEO_STYLE = {
  position: 'fixed',
  left: '0',
  top: '0',
  right: '0',
  bottom: '0',
  width: '100vw',
  height: '100vh',
  'max-width': 'none',
  'max-height': 'none',
  'min-width': '0',
  'min-height': '0',
  margin: '0',
  padding: '0',
  border: '0',
  'border-radius': '0',
  'object-fit': 'contain',
  'background-color': '#000',
  'z-index': '2147483646',
  transform: 'none',
  filter: 'none',
  'pointer-events': 'none',
};

let video = null;
let wantPlaying = true;
let endedSent = false;
let readySent = false;
let errorSent = false;
let booted = false;
let isolateQueued = false;
let lastHref = '';
let playButton = null;

function send(channel, payload) {
  try {
    ipcRenderer.sendToHost(channel, payload);
  } catch (_) {
    /* host window already gone */
  }
}

// Original inline values of every property force() has overwritten since the
// last restore, keyed by element. See restoreHidden().
const savedStyles = new Map();

function rememberStyle(el, prop) {
  let saved = savedStyles.get(el);
  if (!saved) {
    saved = new Map();
    savedStyles.set(el, saved);
  }
  if (!saved.has(prop)) {
    saved.set(prop, {
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
    });
  }
}

function force(el, prop, value) {
  try {
    rememberStyle(el, prop);
    el.style.setProperty(prop, value, 'important');
  } catch (_) {}
}

function currentId() {
  const m = String(location.pathname || '').match(/\/(?:video|photo)\/(\d{6,})/);
  return m ? m[1] : '';
}

/**
 * The visible <video> with the largest on-screen area.
 *
 * Area first, not "is playing": a TikTok video page also renders preview
 * thumbnails in the recommendation column, and one of those can be playing
 * while the main clip is still buffering. The main clip is orders of magnitude
 * larger, so area is the discriminator.
 *
 * Tiny candidates are NOT accepted at all. Painting a 120x160 preview would
 * force it to full screen and hide the recommendation column's siblings — which
 * includes the main player's container. The real clip could then never be
 * painted, and the page would be stuck on a thumbnail. While no large video
 * exists the host's loading overlay is still up, so returning null is invisible.
 *
 * The cutoff is a fifth of the viewport, not a token 5%: sidebar previews are
 * easily 150x200 and would pass a low floor on a small floating window. A real
 * player (including a 16:9 letterboxed clip in a portrait window) covers well
 * over a fifth of it.
 */
function pickVideo() {
  const all = Array.from(document.querySelectorAll('video'));
  if (!all.length) return null;
  const vw = Math.max(1, window.innerWidth || 1);
  const vh = Math.max(1, window.innerHeight || 1);
  const scored = [];
  for (const v of all) {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = w * h;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    scored.push({
      v,
      area,
      playing: !v.paused && !v.ended,
      src: Boolean(v.currentSrc || v.src),
      dist: Math.hypot(cx - vw / 2, cy - vh / 2),
    });
  }
  const floor = vw * vh * 0.2;
  const large = scored.filter((s) => s.area >= floor);
  if (!large.length) return null;
  large.sort((a, b) => {
    if (a.area !== b.area) return b.area - a.area;
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    if (a.src !== b.src) return a.src ? -1 : 1;
    return a.dist - b.dist;
  });
  return large[0].v;
}

/**
 * Puts back every inline property paintChain()/hardenVideo() changed for the
 * previous clip. Without this a wrong early pick (a big preview, a preloaded
 * second card) would leave the real player's container display:none forever,
 * and the clip could never be painted afterwards. Undoing the styles also
 * un-hides a <video> the page reuses for the next clip, so pickVideo() can see
 * it again.
 */
function restoreHidden() {
  for (const [el, saved] of savedStyles) {
    for (const [prop, prev] of saved) {
      try {
        if (prev.value) el.style.setProperty(prop, prev.value, prev.priority);
        else el.style.removeProperty(prop);
      } catch (_) {}
    }
  }
  savedStyles.clear();
}

/**
 * Hides every element that is not on the path from <body> to the video.
 *
 * Inline styles with !important rather than an injected <style>: tiktok.com's
 * CSP is not under our control, and a blocked stylesheet would leave the whole
 * page visible. Styles set through CSSOM are not subject to style-src.
 */
function paintChain(v) {
  const chain = [];
  let el = v;
  while (el && el !== document.body) {
    chain.push(el);
    el = el.parentElement;
  }
  // The video is not inside <body> (a detached/portal node): leave it alone
  // until React attaches it.
  if (!el) return false;

  chain.push(document.body);
  chain.reverse();

  for (let i = 0; i < chain.length; i += 1) {
    const node = chain[i];
    force(node, 'display', 'block');
    force(node, 'visibility', 'visible');
    force(node, 'opacity', '1');
    force(node, 'transform', 'none');
    force(node, 'filter', 'none');
    force(node, 'perspective', 'none');
    force(node, 'contain', 'none');
    force(node, 'zoom', '1');
    force(node, 'overflow', 'visible');
    force(node, 'clip', 'auto');
    force(node, 'clip-path', 'none');
    force(node, 'background-color', '#000');
    force(node, 'z-index', '2147483640');

    const next = chain[i + 1];
    if (!next) continue;
    for (const child of node.children) {
      if (child === next) continue;
      // Non-visual tags are cheap to leave alone and React may look for them.
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK' || child.tagName === 'META') {
        continue;
      }
      force(child, 'display', 'none');
    }
  }

  force(document.documentElement, 'overflow', 'hidden');
  force(document.documentElement, 'background-color', '#000');
  force(document.body, 'overflow', 'hidden');
  return true;
}

function hardenVideo(v) {
  for (const prop of Object.keys(VIDEO_STYLE)) force(v, prop, VIDEO_STYLE[prop]);

  // No native controls: they would be the only part of the video that is not
  // pointer-transparent, and the host already draws play/pause and a seek bar.
  try {
    v.controls = false;
  } catch (_) {}
  if (v.hasAttribute('controls')) v.removeAttribute('controls');

  // Loop is what makes "the next clip never starts": TikTok sets it on feed
  // videos, and an ended event never fires while it is on. The interval below
  // re-applies this in case the page's player writes it back.
  try {
    v.loop = false;
  } catch (_) {}
  if (v.hasAttribute('loop')) v.removeAttribute('loop');

  try {
    v.muted = false;
    v.defaultMuted = false;
    v.volume = 1;
  } catch (_) {}
  try {
    v.playsInline = true;
  } catch (_) {}
  try {
    v.disablePictureInPicture = true;
  } catch (_) {}
  v.setAttribute('controlsList', 'nofullscreen noremoteplayback');
  v.setAttribute('disablepictureinpicture', '');
}

/**
 * Stops a <video> that is no longer the one on screen before the next clip is
 * painted. The inline styles are put back by restoreHidden(), which runs right
 * after this: remembering the page's own values (instead of forcing
 * `display:none`) matters because TikTok reuses the same <video> element for
 * the next clip — a permanently hidden element has zero area and pickVideo()
 * would never select it again.
 */
function releaseVideo(v) {
  if (!v) return;
  try {
    v.pause();
  } catch (_) {}
  if (v.hasAttribute('loop')) v.removeAttribute('loop');
}

function showPlayButton() {
  if (playButton || !document.documentElement) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '▶ Воспроизвести';
  b.setAttribute('aria-label', 'Воспроизвести');
  // Inline styles are the one thing on this page we fully own; the page's CSP
  // cannot block them because they are set through CSSOM.
  b.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:50%',
    'transform:translate(-50%,-50%)',
    'z-index:2147483647',
    'padding:12px 22px',
    'border:0',
    'border-radius:999px',
    'background:#fe2c55',
    'color:#fff',
    'font:600 15px system-ui,sans-serif',
    'cursor:pointer',
    'box-shadow:0 6px 28px rgba(0,0,0,.45)',
  ].join(';');
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!video) return;
    wantPlaying = true;
    if (video.ended) {
      endedSent = false;
      video.currentTime = 0;
    }
    safePlay(video);
    // The 'play' event hides the button on success; leaving it up on failure is
    // what lets the user try again.
  });
  playButton = b;
  document.documentElement.appendChild(b);
}

function hidePlayButton() {
  if (!playButton) return;
  try {
    playButton.remove();
  } catch (_) {}
  playButton = null;
}

/**
 * play() can reject (autoplay policy, a source that disappeared mid-load) and
 * can also throw synchronously (NotSupportedError). Neither may break the
 * isolation loop; a rejection shows the manual play overlay instead.
 */
function safePlay(v) {
  if (!v) return;
  try {
    const p = v.play();
    if (p && p.catch) p.catch(() => showPlayButton());
  } catch (_) {
    showPlayButton();
  }
}

function sendTime() {
  if (!video) return;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  send('floating:time', {
    href: location.href,
    id: currentId(),
    current: Number(video.currentTime) || 0,
    duration,
    paused: Boolean(video.paused),
    ended: Boolean(video.ended),
  });
}

function sendMeta() {
  const desc =
    document.querySelector('[data-e2e="browse-video-desc"]') ||
    document.querySelector('[data-e2e="video-desc"]') ||
    document.querySelector('meta[property="og:title"]');
  let title = '';
  if (desc) title = desc.getAttribute && desc.getAttribute('content') ? desc.getAttribute('content') : desc.textContent || '';
  if (!title) title = document.title || '';
  title = String(title).replace(/\s+/g, ' ').trim().slice(0, 180);
  const handle = (String(location.pathname || '').match(/\/@([\w.\-]+)\//) || [])[1] || '';
  send('floating:meta', { href: location.href, id: currentId(), handle, title });
}

function markReady() {
  if (!video || readySent) return;
  readySent = true;
  send('floating:ready', { href: location.href, id: currentId() });
  sendMeta();
  sendTime();
  // TikTok fills the description/title after the player is up.
  setTimeout(sendMeta, 1500);
}

function markError() {
  if (video || errorSent) return;
  errorSent = true;
  send('floating:error', { href: location.href, reason: 'no-video' });
}

function scheduleIsolate(delay) {
  if (isolateQueued) return;
  isolateQueued = true;
  setTimeout(() => {
    isolateQueued = false;
    try {
      isolate();
    } catch (_) {}
  }, delay);
}

function isolate() {
  const v = pickVideo();
  if (!v) return;

  const isNew = v !== video;
  if (isNew) {
    releaseVideo(video);
    // A previous pick may have hidden ancestors of the real player; put them
    // back before the new chain is painted.
    restoreHidden();
    video = v;
    endedSent = false;
    // The previous page's play button belongs to the previous clip.
    hidePlayButton();
  }

  hardenVideo(v);
  if (!paintChain(v)) return;

  if (wantPlaying && v.paused && !v.ended) safePlay(v);
  if (isNew) {
    markReady();
  }
}

function onEnded(event) {
  const v = event.target;
  if (!v || v.tagName !== 'VIDEO') return;
  if (!video || v !== video) return;
  // Capture-phase listener on document: runs before any handler TikTok put on
  // the element, so the page cannot auto-advance on its own.
  event.stopImmediatePropagation();
  if (endedSent) return;
  endedSent = true;
  wantPlaying = false;
  // The timeupdate fallback below can reach this before the real end; pausing
  // stops a re-enabled `loop` from replaying the clip for the moment it takes
  // the host to load the next one.
  try {
    v.pause();
  } catch (_) {}
  hidePlayButton();
  send('floating:ended', {
    href: location.href,
    id: currentId(),
    current: Number(v.currentTime) || 0,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
  });
}

function toggleLocal() {
  const v = video;
  if (!v) return;
  if (v.paused || v.ended) {
    wantPlaying = true;
    if (v.ended) {
      endedSent = false;
      v.currentTime = 0;
    }
    safePlay(v);
  } else {
    wantPlaying = false;
    v.pause();
  }
  sendTime();
}

function seekBy(delta) {
  const v = video;
  if (!v) return;
  const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  if (!duration) return;
  v.currentTime = Math.max(0, Math.min(duration - 0.05, (Number(v.currentTime) || 0) + delta));
  if (v.paused && wantPlaying) safePlay(v);
  sendTime();
}

function watchLocation() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  // A same-document navigation swapped the clip. Treat it as a fresh page so a
  // stale ended flag cannot swallow the new video's end.
  releaseVideo(video);
  restoreHidden();
  video = null;
  endedSent = false;
  readySent = false;
  errorSent = false;
  wantPlaying = true;
  hidePlayButton();
  scheduleIsolate(0);
}

function boot() {
  if (booted) return;
  booted = true;
  lastHref = location.href;

  // Capture phase on document: this is the only place that is guaranteed to run
  // before TikTok's own listeners, and it is installed before page scripts.
  document.addEventListener('ended', onEnded, true);

  // The page runs its own player logic. If it pauses the clip while the host
  // still considers it playing (visibility heuristics, its own overlay), put it
  // back. A user pause arrives as a host command that clears wantPlaying first.
  document.addEventListener(
    'pause',
    (event) => {
      const v = event.target;
      if (!v || v.tagName !== 'VIDEO' || v !== video) return;
      if (!wantPlaying || endedSent || document.hidden) return;
      setTimeout(() => {
        if (video !== v || !wantPlaying || endedSent) return;
        if (v.paused && !v.ended) safePlay(v);
      }, 220);
    },
    true
  );

  document.addEventListener(
    'timeupdate',
    (event) => {
      const v = event.target;
      if (!v || v !== video || endedSent) return;
      const d = Number(v.duration);
      if (!Number.isFinite(d) || d <= 0) return;
      // If the player re-enabled loop, ended will never fire. Catch the last
      // fraction of a second ourselves instead of letting the clip repeat.
      if (v.loop && d - (Number(v.currentTime) || 0) < 0.3) {
        onEnded({ target: v, stopImmediatePropagation() {} });
      }
    },
    true
  );

  document.addEventListener(
    'play',
    (event) => {
      if (event.target === video) hidePlayButton();
    },
    true
  );

  // TikTok may create the <video> long after load, and it re-renders the page
  // while the clip plays. Both are covered: childList mutation -> isolate soon,
  // and a slow timer for style/loop changes that do not mutate the tree.
  try {
    const obs = new MutationObserver(() => scheduleIsolate(180));
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  window.setInterval(() => {
    watchLocation();
    // Once a clip is up, a hidden window needs no work. Before that, isolate
    // anyway: a brand-new guest can briefly report itself hidden, and skipping
    // the first isolation would leave the host on the loading screen forever.
    if (document.hidden && readySent) return;
    scheduleIsolate(0);
    sendTime();
  }, 700);

  setTimeout(markError, 12000);
  scheduleIsolate(0);

  // Disabled by design: floating queue uses main feed only.

  window.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) return;
      const raw = Number(event.deltaY) || 0;
      if (!raw) return;
      event.preventDefault();
      event.stopPropagation();
      let delta = raw;
      if (event.deltaMode === 1) delta *= 16;
      else if (event.deltaMode === 2) delta *= window.innerHeight;
      send('floating:wheel', { delta, href: location.href });
    },
    { passive: false, capture: true }
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const t = event.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = event.key;
      if (key === ' ' || key === 'Spacebar') {
        event.preventDefault();
        event.stopPropagation();
        toggleLocal();
        return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        seekBy(key === 'ArrowRight' ? 5 : -5);
        return;
      }
      const action =
        key === 'ArrowDown' || key === 'PageDown'
          ? 'next'
          : key === 'ArrowUp' || key === 'PageUp'
            ? 'prev'
            : key === 'Escape'
              ? 'close'
              : '';
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      send('floating:key', { action, key });
    },
    true
  );

  // The video is pointer-transparent and everything around it is hidden, so a
  // click lands on an ancestor that may still carry TikTok's pause/navigate
  // handler. Swallow those events before the page sees them, then treat a click
  // on the clip as play/pause. The one exception is our own "play" overlay.
  const onOverlay = (target) =>
    Boolean(playButton && target instanceof Node && (target === playButton || playButton.contains(target)));

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    window.addEventListener(
      type,
      (event) => {
        if (onOverlay(event.target)) return;
        event.stopPropagation();
      },
      true
    );
  }
  window.addEventListener(
    'click',
    (event) => {
      if (onOverlay(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleLocal();
    },
    true
  );
}

// The IPC listeners are registered at preload time, NOT from boot(): the host
// sends `floating:ping` on the webview's dom-ready, and that can run before the
// page's DOMContentLoaded handler. A listener added in boot() would miss the
// first ping (and the play/pause state the host re-sends with it), leaving the
// new clip frozen until the user pressed something.
function onCommand(_event, cmd) {
  if (!cmd || typeof cmd !== 'object') return;
  if (cmd.type === 'play') {
    wantPlaying = true;
    safePlay(video);
    return;
  }
  if (cmd.type === 'pause') {
    wantPlaying = false;
    if (video) {
      try {
        video.pause();
      } catch (_) {}
    }
    hidePlayButton();
    sendTime();
    return;
  }
  if (cmd.type === 'toggle') {
    toggleLocal();
    return;
  }
  if (cmd.type === 'seek') {
    if (!video) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const fraction = Math.max(0, Math.min(1, Number(cmd.value) || 0));
    if (!duration) return;
    video.currentTime = fraction * duration;
    if (video.paused && wantPlaying) safePlay(video);
    sendTime();
  }
}

function onPing() {
  if (video) markReady();
  else scheduleIsolate(0);
}

ipcRenderer.on('floating:cmd', onCommand);
ipcRenderer.on('floating:ping', onPing);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
