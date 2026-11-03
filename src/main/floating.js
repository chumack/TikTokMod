'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, ipcMain, screen, shell } = require('electron');
const feed = require('./feed');

// The floating player is the app's replacement for TikTok's "Плавающий
// видеоплеер" menu row.
//
// TikTok's own implementation is Document Picture-in-Picture. Electron has
// never implemented it (electron/electron#39633), so the row is visible but the
// click is a silent no-op. Chromium's ordinary <video> PiP does work, and the
// app used it for a while, but it is an unstylable system window: it cannot
// switch clips, it cannot show a "back to tab" button, and the feed keeps
// auto-advancing underneath it — which is what made playback look like "через
// раз". A second BrowserWindow is the only way to own the controls and the
// queue.
//
// The window is deliberately thin: it owns the chrome, the queue and the
// pause/resume of the main tab, while renderer/floating.js drives a <webview>
// that loads one TikTok video page at a time. See floating-guest-preload.js for
// how that page is reduced to a bare <video>.

const PAGE = path.join(__dirname, '..', 'renderer', 'floating.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'floating-preload.js');
const GUEST_PRELOAD = path.join(__dirname, '..', 'preload', 'floating-guest-preload.js');

// Portrait by default: TikTok's feed is vertical, and the window is resizable
// if the user wants a different shape.
const START_WIDTH = 400;
const START_HEIGHT = 700;

let host = null;
let playlist = [];
let startIndex = 0;
let opening = false;
let installed = false;
let getMainWindow = () => null;
// True only while the floating player is the reason the main tab is paused. A
// clip the user had already paused before opening the player must stay paused.
let pausedMain = false;

function isOpen() {
  return Boolean(host && !host.isDestroyed());
}

/**
 * Registers the IPC surface once. Called from app.whenReady(); the callback is
 * how the module reaches the main window without main.js passing `win` around.
 */
function install({ getMain } = {}) {
  if (typeof getMain === 'function') getMainWindow = getMain;
  if (installed) return;
  installed = true;

  ipcMain.handle('floating:init', () => {
    if (!isOpen()) return null;
    return { playlist: playlist.slice(), index: startIndex };
  });

  ipcMain.handle('floating:guestPreloadUrl', () => pathToFileURL(GUEST_PRELOAD).href);

  // The renderer can extend its queue from the feed. The feed has to scroll for
  // TikTok to render the next batch; collect() puts the tab back where it was,
  // so the clip the user is watching stays on screen. Scrolling starts autoplay
  // in the tab, hence the pause afterwards.
  ipcMain.handle('floating:more', async (_e, previous) => {
    const prev = Array.isArray(previous) ? previous : [];
    const res = await feed.collect({ previous: prev, scroll: true, restore: true });
    if (!res || !res.ok) return { ok: false, items: prev, error: res && res.error };
    await feed.pauseForFloating();
    return { ok: true, items: res.items, added: res.added };
  });

  ipcMain.on('floating:return', () => returnToTab());
  ipcMain.on('floating:close', () => close());
}

/**
 * Builds the initial queue.
 *
 * The queue is the collected feed order, and `index` points at the clip the
 * user clicked. There is no rotation: rotating around the current clip moved
 * the whole queue "up" the feed and made the player look like a different
 * feed. Clips above the current one stay in front of it and are reached only
 * with "previous".
 *
 * Returns { items, index }. An empty list means the clicked clip could not be
 * resolved to a canonical /@handle/video/<id> URL; the caller must say so
 * instead of opening some other clip.
 */
function buildPlaylist(current, collected, limit = 60) {
  const out = [];
  const seen = new Set();

  const push = (item) => {
    if (!item || !item.id) return false;
    if (item.isPhoto) return false;
    const id = String(item.id);
    if (seen.has(id)) return false;
    // Collect everything and apply `limit` as a window at the end: cutting here
    // dropped a clicked clip that sat beyond the first `limit` cards, and the
    // player then refused to open a video that was plainly on screen.
    if (out.length >= 200) return false;
    const handle = item.handle || '';
    const url = item.url || '';
    // A page-derived item can carry '@_' when only the numeric id was known.
    // That is fine for yt-dlp but a webview gets an account-not-found page, so
    // the clip is not queued at all.
    if (!handle || handle === '_' || /\/@_\//.test(url)) return false;
    if (/\/photo\//.test(url)) return false;
    if (!/^https:\/\/www\.tiktok\.com\/@[^/]+\/(?:video|photo)\/\d{6,}/.test(url)) return false;
    seen.add(id);
    out.push({
      id,
      handle,
      url,
      title: item.title || '',
      thumbnail: item.thumbnail || '',
    });
    return true;
  };

  const items = Array.isArray(collected) ? collected.filter(Boolean) : [];
  const currentId = current && current.id ? String(current.id) : '';

  // The collected card is the canonical source for handle/url/title: the click
  // path may only know the numeric id.
  let first = current;
  if (first && currentId) {
    const match = items.find((i) => String(i.id) === currentId);
    if (match) {
      first = {
        ...first,
        handle: match.handle || first.handle,
        url: match.url || first.url,
        title: first.title || match.title || '',
        thumbnail: first.thumbnail || match.thumbnail || '',
      };
    }
  }

  let list = items.slice();
  let at = currentId ? list.findIndex((i) => String(i.id) === currentId) : -1;

  if (at >= 0) {
    const photo = Boolean((first && first.isPhoto) || list[at].isPhoto);
    list[at] = { ...list[at], ...first, isPhoto: photo };
  } else if (currentId && first) {
    // The collector did not see the current card (it may have been recycled
    // between the click and the read). Fall back to the clips below it when a
    // scroll offset is known; otherwise the current clip stands alone rather
    // than being replaced by whatever happens to be first in the list.
    const pos = Number(first.pos);
    if (Number.isFinite(pos)) {
      const below = list.findIndex((i) => Number.isFinite(Number(i.pos)) && Number(i.pos) > pos);
      list = below >= 0 ? list.slice(below) : [];
      list.unshift(first);
      at = 0;
    } else {
      list = [first];
      at = 0;
    }
  } else if (!currentId) {
    at = -1;
  }

  for (const item of list) push(item);

  if (currentId) {
    const index = out.findIndex((i) => i.id === currentId);
    if (index < 0) return { items: [], index: 0 };
    if (out.length > limit) {
      // Keep the current clip inside the window; otherwise a long feed would
      // start at the top and the click target would be cut off.
      const start = Math.max(0, Math.min(out.length - limit, index - Math.floor(limit / 2)));
      const window = out.slice(start, start + limit);
      return { items: window, index: index - start };
    }
    return { items: out, index };
  }

  return { items: out, index: 0 };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Creates and shows the window. Returns { ok } instead of throwing so the IPC
 * caller can show a message.
 */
async function open({ playlist: items, index = 0 } = {}) {
  if (opening) return { ok: false, error: 'Плавающий плеер уже открывается.' };
  if (isOpen()) {
    close();
    return { ok: true, closed: true };
  }

  const list = Array.isArray(items) ? items.filter((i) => i && i.url && i.id) : [];
  if (!list.length) return { ok: false, error: 'Нет видео, которое можно открыть в плавающем плеере.' };

  opening = true;
  playlist = list;
  startIndex = clamp(Number(index) || 0, 0, list.length - 1);

  try {
    const main = getMainWindow();
    const bounds = main && !main.isDestroyed() ? main.getBounds() : null;
    const point = bounds
      ? { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) }
      : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(point).workArea;
    const width = Math.min(START_WIDTH, Math.max(300, area.width - 16));
    const height = Math.min(START_HEIGHT, Math.max(360, area.height - 16));
    const x = clamp(
      bounds ? bounds.x + bounds.width - width - 28 : area.x + area.width - width - 28,
      area.x + 8,
      area.x + area.width - width - 8
    );
    const y = clamp(bounds ? bounds.y + 64 : area.y + 64, area.y + 8, area.y + area.height - height - 8);

    host = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 300,
      minHeight: 360,
      frame: false,
      show: false,
      backgroundColor: '#000000',
      title: 'Плавающий плеер — TikTokMod',
      autoHideMenuBar: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      fullscreenable: false,
      maximizable: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
        // The clip must keep playing while the user works in the main window.
        backgroundThrottling: false,
        spellcheck: false,
      },
    });

    // 'floating' is the level Chromium's own PiP uses on platforms that support
    // named levels; Windows ignores the level and keeps the window on top.
    host.setAlwaysOnTop(true, 'floating');

    host.on('ready-to-show', () => {
      if (!isOpen()) return;
      host.show();
      host.focus();
    });
    host.on('closed', () => {
      if (host && host.isDestroyed()) host = null;
      finishClosed();
    });
    // The page is local and never opens windows, but a TikTok popup inside the
    // guest must not become a child of the floating window.
    host.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    await host.loadFile(PAGE);
    // The first frame of the guest takes a moment; stop the main tab now so
    // both soundtracks do not overlap.
    await pauseMain();
    return { ok: true };
  } catch (e) {
    close();
    return { ok: false, error: e && (e.message || String(e)) };
  } finally {
    opening = false;
  }
}

async function pauseMain() {
  const n = await feed.pauseForFloating();
  // The window can be closed while the pause round-trip is in flight (the guest
  // may be mid-navigation and take seconds to answer). finishClosed() already
  // ran with pausedMain === false in that case, so resuming here is the only
  // thing that keeps the main tab from staying silent forever.
  if (!isOpen()) {
    if (n > 0) feed.resumeAfterFloating().catch(() => {});
    return n;
  }
  pausedMain = n > 0;
  return n;
}

/**
 * Idempotent cleanup. Called from 'closed' and from close(); the flag makes the
 * second call harmless.
 */
function finishClosed() {
  playlist = [];
  startIndex = 0;
  opening = false;
  if (!pausedMain) return;
  pausedMain = false;
  // The main window may be gone (app quit): feed.runInGuest() answers with
  // "browser not open" and nothing else happens.
  feed.resumeAfterFloating().catch(() => {});
}

/** Closes the player, if any, and restores the main tab's playback. */
function close() {
  const w = host;
  host = null;
  if (w && !w.isDestroyed()) {
    try {
      w.destroy();
    } catch (_) {
      finishClosed();
    }
    return;
  }
  finishClosed();
}

/**
 * "На вкладку": bring the main window back and show the browser tab again.
 * Closing the player first means the main tab is resumed before it gets focus.
 */
function returnToTab() {
  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    main.webContents.send('feed:returnToTab');
  }
  close();
}

module.exports = {
  install,
  open,
  close,
  isOpen,
  buildPlaylist,
};
