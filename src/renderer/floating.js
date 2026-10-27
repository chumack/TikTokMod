'use strict';

// Renderer for the floating player window. Owns the queue, the chrome and the
// <webview>; the guest preload owns the video element. See src/main/floating.js
// for why this window exists at all.

const $ = (sel) => document.querySelector(sel);

const state = {
  playlist: [],
  index: 0,
  guestPreload: '',
  wv: null,
  loadedAt: 0,
  duration: 0,
  current: 0,
  paused: true,
  seeking: false,
  busy: false,
  errorStreak: 0,
  wheelAcc: 0,
  wheelLast: 0,
  wheelAt: 0,
  wheelTimer: 0,
};

function fmt(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function videoId(url) {
  const m = String(url || '').match(/\/(?:video|photo)\/(\d{6,})/);
  return m ? m[1] : '';
}

function sameVideo(a, b) {
  const ia = videoId(a);
  const ib = videoId(b);
  if (ia && ib) return ia === ib;
  return true;
}

function isCurrent(payload) {
  const item = state.playlist[state.index];
  if (!item) return false;
  if (!payload || !payload.href) return true;
  return sameVideo(payload.href, item.url);
}

function showLoading(text, isError = false) {
  const box = $('#loading');
  box.hidden = false;
  box.classList.toggle('error', Boolean(isError));
  $('#loadingText').textContent = text || 'Загрузка…';
}

function hideLoading() {
  $('#loading').hidden = true;
}

function setPlayIcon(playing) {
  const btn = $('#play');
  btn.textContent = playing ? '⏸' : '▶';
  btn.title = playing ? 'Пауза (пробел)' : 'Воспроизвести (пробел)';
  btn.setAttribute('aria-label', btn.title);
}

function setMeta(meta) {
  if (!meta || !isCurrent(meta)) return;
  const item = state.playlist[state.index] || {};
  const handle = meta.handle || item.handle || '';
  const title = String(meta.title || item.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  const label = (handle ? '@' + handle : 'TikTok') + (title ? ' · ' + title : '');
  const clipped = label.length > 110 ? label.slice(0, 107) + '…' : label;
  $('#title').textContent = clipped;
  $('#title').title = label;
  document.title = (handle ? '@' + handle + ' — ' : '') + 'плавающий плеер';
}

function sendCmd(cmd) {
  const wv = state.wv;
  if (!wv) return;
  try {
    // The guest may not be on a document yet (first navigation); the command is
    // simply dropped and the next user action works.
    wv.send('floating:cmd', cmd);
  } catch (_) {}
}

function merge(items) {
  if (!Array.isArray(items)) return;
  const seen = new Set(state.playlist.map((i) => i && i.id).filter(Boolean));
  for (const item of items) {
    if (!item || !item.url || item.isPhoto) continue;
    const id = item.id ? String(item.id) : '';
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    state.playlist.push({
      id,
      handle: item.handle || '',
      url: item.url,
      title: item.title || '',
      thumbnail: item.thumbnail || '',
    });
    if (state.playlist.length >= 200) break;
  }
}

async function grow() {
  const before = state.playlist.length;
  let res = null;
  try {
    res = await window.floatApi.more(state.playlist);
  } catch (_) {}
  if (res && res.ok) merge(res.items);
  return state.playlist.length > before;
}

function load(index, { first = false } = {}) {
  const item = state.playlist[index];
  if (!item) return;

  state.index = index;
  state.loadedAt = Date.now();
  state.duration = 0;
  state.current = 0;
  // A new clip starts playing by itself; the guest reports the real state
  // within half a second. Setting this to true here would make the host send a
  // "pause" command on dom-ready and freeze every clip at its first frame.
  state.paused = false;
  $('#seek').value = '0';
  $('#pos').textContent = '0:00';
  $('#dur').textContent = '0:00';
  setPlayIcon(true);
  setMeta({ href: item.url, handle: item.handle, title: item.title });
  showLoading('Загрузка…');

  const wv = state.wv;
  if (!wv) return;
  // Hide the guest until the new document reports a painted clip; otherwise the
  // previous clip (or the unstyled page) stays visible behind the spinner.
  wv.classList.remove('ready');
  try {
    if (first) {
      // The preload attribute is already on the element; the first navigation
      // must go through src so it is applied before the guest is attached.
      wv.setAttribute('src', item.url);
    } else {
      const p = wv.loadURL(item.url);
      if (p && p.catch) p.catch(() => {});
    }
  } catch (e) {
    onGuestError({ href: item.url, reason: e && (e.message || String(e)) });
  }
}

async function next() {
  if (state.busy || !state.playlist.length) return;
  state.busy = true;
  try {
    if (state.index + 1 < state.playlist.length) {
      load(state.index + 1);
      return;
    }
    await grow();
    if (state.index + 1 < state.playlist.length) load(state.index + 1);
    else load(0);
  } finally {
    setTimeout(() => {
      state.busy = false;
    }, 700);
  }
}

function prev() {
  if (state.busy || !state.playlist.length) return;
  state.busy = true;
  try {
    load(state.index > 0 ? state.index - 1 : state.playlist.length - 1);
  } finally {
    setTimeout(() => {
      state.busy = false;
    }, 700);
  }
}

function onTime(t) {
  if (!t || !isCurrent(t)) return;
  state.duration = Number(t.duration) || 0;
  state.current = Number(t.current) || 0;
  state.paused = Boolean(t.paused);
  if (state.duration > 0 && !state.paused) state.errorStreak = 0;

  if (!state.seeking) {
    const pos = state.duration > 0 ? Math.round((state.current / state.duration) * 1000) : 0;
    $('#seek').value = String(Math.max(0, Math.min(1000, pos)));
    $('#pos').textContent = fmt(state.current);
  }
  $('#dur').textContent = state.duration ? fmt(state.duration) : '0:00';
  setPlayIcon(!state.paused);
}

function onEnded(payload) {
  if (!payload || !isCurrent(payload)) return;
  // A page can fire ended for a preview or while the next navigation is already
  // starting. Both would skip a clip — the exact "через раз" this replaces.
  // Defer instead of dropping: a genuinely short clip that ends inside the
  // grace window must still advance once the window is over.
  const duration = Number(payload.duration) || 0;
  if (duration > 0 && duration < 0.5) return;
  const wait = Math.max(0, 1200 - (Date.now() - state.loadedAt));
  if (wait > 0) {
    const at = state.loadedAt;
    setTimeout(() => {
      if (state.loadedAt !== at || state.busy) return;
      next();
    }, wait);
    return;
  }
  if (state.busy) return;
  next();
}

function onGuestError(payload) {
  if (payload && payload.href && !isCurrent(payload)) return;
  if (state.wv) state.wv.classList.remove('ready');
  state.errorStreak += 1;
  // Six failed clips in a row is a network/region problem, not a bad video.
  // The streak survives load() on purpose: otherwise every navigation reset it
  // and the queue retried a broken session forever. A successful `ready` clears
  // it (see onGuestMessage).
  const limit = Math.min(6, Math.max(2, state.playlist.length));
  if (state.errorStreak >= limit) {
    showLoading('Не удалось воспроизвести ни одно видео из очереди', true);
    return;
  }
  showLoading('Видео не открылось — пропускаю…', true);
  const at = state.loadedAt;
  setTimeout(() => {
    if (state.loadedAt === at) next();
  }, 2200);
}

function onFailLoad(event) {
  if (!event || event.isMainFrame === false) return;
  // -3 is ERR_ABORTED: the normal result of asking the webview to load the next
  // clip while the previous one is still in flight.
  if (Number(event.errorCode) === -3) return;
  onGuestError({ href: event.validatedURL || '', reason: event.errorDescription || '' });
}

function onWheel(payload) {
  if (!payload || !isCurrent(payload)) return;
  const delta = Number(payload.delta) || 0;
  if (!delta) return;
  const now = Date.now();
  if (now - state.wheelAt < 450) return;
  if (now - state.wheelLast > 260) state.wheelAcc = 0;
  state.wheelLast = now;
  state.wheelAcc += delta;
  clearTimeout(state.wheelTimer);
  state.wheelTimer = setTimeout(() => {
    state.wheelAcc = 0;
  }, 300);
  if (Math.abs(state.wheelAcc) < 80) return;

  const forward = state.wheelAcc > 0;
  state.wheelAcc = 0;
  state.wheelAt = now;
  if (forward) next();
  else prev();
}

function onGuestMessage(event) {
  const payload = event.args && event.args[0];
  switch (event.channel) {
    case 'floating:ready':
      if (isCurrent(payload)) {
        state.errorStreak = 0;
        if (state.wv) state.wv.classList.add('ready');
        hideLoading();
      }
      break;
    case 'floating:meta':
      setMeta(payload);
      break;
    case 'floating:time':
      onTime(payload);
      break;
    case 'floating:ended':
      onEnded(payload);
      break;
    case 'floating:error':
      onGuestError(payload);
      break;
    case 'floating:wheel':
      onWheel(payload);
      break;
    case 'floating:key':
      if (payload && payload.action === 'next') next();
      else if (payload && payload.action === 'prev') prev();
      else if (payload && payload.action === 'close') window.floatApi.close();
      break;
    case 'floating:related':
      merge(payload);
      break;
    default:
      break;
  }
}

async function boot() {
  if (!window.floatApi) {
    document.body.textContent = 'Плавающий плеер не загрузился.';
    return;
  }
  const info = await window.floatApi.init().catch(() => null);
  if (!info || !Array.isArray(info.playlist) || !info.playlist.length) {
    window.floatApi.close();
    return;
  }

  state.playlist = info.playlist.slice();
  state.index = Math.max(0, Math.min(Number(info.index) || 0, state.playlist.length - 1));

  try {
    state.guestPreload = await window.floatApi.guestPreloadUrl();
  } catch (_) {}
  if (!state.guestPreload) {
    // Without the guest preload the full TikTok page would be shown and nothing
    // in this window would work. Fail visibly instead.
    showLoading('Не удалось загрузить плеер: нет доступа к preload.', true);
    return;
  }

  const wv = document.createElement('webview');
  wv.id = 'player';
  // Must be set before the first src, otherwise the first document has no
  // preload and the full TikTok page is shown.
  if (state.guestPreload) wv.setAttribute('preload', state.guestPreload);
  wv.setAttribute('useragent', navigator.userAgent);
  wv.setAttribute('webpreferences', 'backgroundThrottling=no');
  wv.addEventListener('ipc-message', onGuestMessage);
  wv.addEventListener('dom-ready', () => {
    try {
      wv.send('floating:ping');
    } catch (_) {}
    // A full navigation recreates the guest's module state. Re-apply the
    // play/pause state the user last chose before the new clip got here.
    sendCmd({ type: state.paused ? 'pause' : 'play' });
  });
  wv.addEventListener('did-start-loading', () => showLoading('Загрузка…'));
  wv.addEventListener('did-fail-load', onFailLoad);
  $('#stage').appendChild(wv);
  state.wv = wv;

  load(state.index, { first: true });
}

$('#prev').addEventListener('click', prev);
$('#next').addEventListener('click', next);
$('#close').addEventListener('click', () => window.floatApi.close());
$('#return').addEventListener('click', () => window.floatApi.returnToTab());
$('#play').addEventListener('click', () => {
  state.paused = !state.paused;
  setPlayIcon(!state.paused);
  sendCmd({ type: state.paused ? 'pause' : 'play' });
});

const seek = $('#seek');
seek.addEventListener('pointerdown', () => {
  state.seeking = true;
});
seek.addEventListener('input', () => {
  state.seeking = true;
  if (state.duration > 0) {
    $('#pos').textContent = fmt((Number(seek.value) / 1000) * state.duration);
  }
});
seek.addEventListener('change', () => {
  state.seeking = false;
  sendCmd({ type: 'seek', value: Number(seek.value) / 1000 });
});
seek.addEventListener('pointerup', () => {
  state.seeking = false;
});

// When focus is on the host chrome (not inside the guest), the guest's key
// handler never sees the key. Mirror the important ones here.
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // Escape must work even when the seek slider has focus.
  if (event.key === 'Escape') {
    event.preventDefault();
    window.floatApi.close();
    return;
  }
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (event.key === 'ArrowDown' || event.key === 'PageDown') {
    event.preventDefault();
    next();
  } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
    event.preventDefault();
    prev();
  } else if (event.key === ' ') {
    event.preventDefault();
    $('#play').click();
  }
});

boot();
