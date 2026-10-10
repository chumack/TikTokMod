'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell, session, dialog, Menu, webContents } = require('electron');

const settings = require('./settings');
const binaries = require('./binaries');
const ytdlp = require('./ytdlp');
const engine = require('./engine');
const geo = require('./geo');
const regions = require('./regions');
const ttapi = require('./ttapi');
const signer = require('./signer');
const feed = require('./feed');

let win = null;
const ALLOWED_HOSTS = /(^|\.)(tiktok\.com|musical\.ly|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|amemv\.com|byteoversea\.com|tiktokmusic\.com)$/i;

// Counts every download the session handler cancelled. Exported so the
// selftest can tell "the event never fired" from "it fired but nothing was
// written", which look identical from the filesystem side.
let downloadInterceptions = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0b0b0f',
    title: 'TikTokMod',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  // Zoom with ctrl/cmd + wheel, common for browser-like apps
  win.webContents.on('wheel', (e) => {});

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setMaxListeners(20);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The same for the guest page inside <webview>. Measured on Electron 33:
  // the DOM "new-window" event on the <webview> element never fires here
  // (0 events over two different popup triggers), while setWindowOpenHandler
  // on the guest fires for every one of them. So this hook — not the DOM
  // listener in renderer.js — is what actually hands external links to the
  // system browser.
  // Note: will-attach-webview passes webPreferences as its 2nd argument,
  // not webContents, so the guest is picked up from web-contents-created.
  // allowpopups on the <webview> stays: without it nothing reaches either hook.
  const openExternal = ({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  };
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(openExternal);
    // Safety net for the right-click path: wired here as well as in
    // feed:register, so the guest is covered even if the renderer never
    // reports its id (or reports it too late). Cancels Chromium's own menu;
    // the app paints nothing.
    attachGuestMenu(contents.id);
  });

  applyProxyToSession(session.defaultSession);

  // Chromium's own download manager must never get to save a TikTok file.
  //
  // Verified from real user output: downloads triggered inside the <webview>
  // landed in the Electron default download folder (~/Videos) as
  // "Download.mp4", "Download1.mp4", ... instead of the app's own naming
  // template, and the bytes carried the moving TikTok watermark — because the
  // URL the page itself offers is downloadAddr, the watermarked variant.
  // Nothing in the app noticed or reported it, so yt-dlp's no-watermark
  // selector never even ran.
  //
  // So: cancel every download initiated inside the browser tab, and route
  // anything we can resolve to a normal queue job (clean format, progress,
  // cancellation). What we cannot resolve is blocked with an explanation
  // rather than silently saved with a watermark.
  session.defaultSession.on('will-download', (event, item) => {
    const url = item.getURL();
    event.preventDefault();
    downloadInterceptions += 1;

    // TikTok's own "Save video" button hands Chromium a direct CDN link. The
    // page that triggered it is in the referrer, so the real video URL can be
    // recovered and routed through the queue instead of being dropped.
    const referrer = item.referrer || '';
    const candidates = [referrer, url];
    const known = candidates.find((c) => ytdlp.isDownloadableUrl(c));

    const send = (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('yt:redirectDownload', payload);
    };

    if (known) {
      send({ ok: true, url: known, filename: item.getFilename(), via: known === referrer ? 'referrer' : 'url' });
      return;
    }
    send({
      ok: false,
      url,
      filename: item.getFilename(),
      message: isDirectVideoUrl(url)
        ? 'Браузер пытался сохранить видео по прямой ссылке на CDN TikTok — это версия с водяным знаком, поэтому сохранение отменено. Скопируйте адрес страницы ролика из адресной строки и вставьте его в поле «Скачать», либо нажмите правую кнопку мыши по ролику во вкладке «Обзор».'
        : 'Загрузка из встроенного браузера перехвачена, чтобы она не обошла очередь приложения. Для видео используйте правую кнопку мыши по ролику или вкладку «Скачать».',
    });
  });

  win.on('closed', () => {
    win = null;
  });
}

// Where Chromium would drop a file that escaped the queue — the session's real
// default path (on Windows: ~/Videos), which is exactly where the watermarked
// user files appeared. Watching it is how the selftest proves the will-download
// handler really cancels the save.
function downloadWatchDir() {
  try {
    const p = session.defaultSession.downloadPath;
    // Electron leaves downloadPath empty until it is set explicitly and then
    // falls back to the OS "Videos" folder — which is exactly where the
    // watermarked user files turned up.
    return p && p.trim() ? p : app.getPath('videos');
  } catch (e) {
    return app.getPath('videos');
  }
}

function diskListing(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
}

// A CDN link handed to the embedded browser (…/video/tos/….mp4 etc.). Such a
// file is always downloadAddr, i.e. watermarked, so it must not be saved as-is.
function isDirectVideoUrl(url) {
  return /^https?:\/\//i.test(String(url)) && /\.(mp4|m3u8|webm)(\?|$)/i.test(String(url));
}

// The embedded browser must use the same proxy as the downloader,
// otherwise downloads fail while browsing succeeds (or vice versa).
async function applyProxyToSession(sess) {
  const s = settings.get();
  try {
    await sess.setProxy({ mode: s.proxy && s.proxy.trim() ? 'fixed_servers' : 'system' , proxyRules: s.proxy || '' });
    await sess.clearCache();
  } catch (e) {
    console.warn('[proxy]', e.message);
  }
}

// Serves random bytes locally so the download pipeline can be verified
// without depending on TikTok reachability from the build machine.
function localPipelineCheck() {
  const http = require('node:http');
  const payload = Buffer.alloc(3 * 1024 * 1024);
  require('node:crypto').randomFillSync(payload);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length });
    res.end(payload);
  });

  return new Promise((resolve) => {
    const outDir = path.join(app.getPath('temp'), 'tiktokmod-selftest');
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      // Never touch the user's settings.json from the selftest. An earlier
      // version wrote downloadDir to the settings file and then "restored"
      // it from the value returned by set(), which is the already-merged
      // new one — so every selftest run silently moved the user's download
      // folder into the temp dir. Pass an override object instead.
      const testSettings = { ...settings.get(), downloadDir: outDir, writeThumbnail: false };
      let progressSeen = false;
      const result = await new Promise((resolve2) => {
        const timer = setTimeout(() => resolve2({ done: false, reason: 'timeout' }), 60000);
        ytdlp.startDownload('selftest_local', `http://127.0.0.1:${port}/video.mp4`, testSettings, {
          onProgress: () => (progressSeen = true),
          onDone: (r) => {
            clearTimeout(timer);
            resolve2({ done: true, path: r.path, size: r.size });
          },
          onError: (m) => {
            clearTimeout(timer);
            resolve2({ done: false, reason: m });
          },
        });
      });
      server.close();
      if (result.done) {
        try {
          const st = fs.statSync(result.path);
          result.sizeOnDisk = st.size;
          if (st.size !== payload.length) result.sizeMismatch = `${st.size} != ${payload.length}`;
        } catch (e) {
          result.sizeMismatch = 'stat failed: ' + e.message;
        }
      }
      // The saved filename must not start with the flattened download path:
      // sanitizing the joined path used to turn the directory separators into
      // underscores, so every file began with "C__Users_..._TikTokMod_".
      result.fileName = path.basename(result.path || '');
      result.pathNotFlattened = !result.fileName.startsWith('C__') && !/__Users_|_Downloads_/.test(result.fileName);
      resolve({ ...result, progressSeen, settingsUntouched: settings.get().downloadDir !== outDir });
    });
  });
}

// Verifies the feed collector against a real Chromium rendering a TikTok-shaped
// page. The script that walks the DOM is the fragile part (nested cards, img
// resolution, dedupe), so it is exercised for real rather than trusted.
async function localFeedCheck() {
  const http = require('node:http');
  const html = `<!DOCTYPE html><html><body>
<div id="now" style="position:absolute;left:0;top:0;width:400px;height:400px;z-index:1">
  <a href="/@now.user/video/7000000000000000009">
    <video src="blob:https://www.tiktok.com/1234-5678" muted playsinline style="width:400px;height:400px"></video>
    <img alt="Текущий ролик" src="https://p16.example/n1.jpg">
  </a>
</div>
<div id="stack" style="position:absolute;left:200px;top:100px;width:400px;height:400px;z-index:2">
  <div style="position:absolute;left:0;top:0;width:400px;height:400px;z-index:1"><a href="/@second/video/7000000000000000011"><video src="blob:https://www.tiktok.com/b" muted playsinline style="width:400px;height:400px"></video></a></div>
  <div style="position:absolute;left:0;top:0;width:400px;height:400px;z-index:2"><a href="/@first/video/7000000000000000010"><video src="blob:https://www.tiktok.com/a" muted playsinline style="width:400px;height:400px"></video></a></div>
</div>
<div id="row" style="position:absolute;left:0;top:0;width:800px;height:120px;z-index:3">
  <div style="position:absolute;left:0;top:0;width:400px;height:120px"><a href="/@left.user/video/7000000000000000012"><video src="blob:https://www.tiktok.com/l" muted playsinline style="width:400px;height:120px"></video><img alt="Левый ролик" src="https://p16.example/l.jpg"></a></div>
  <div style="position:absolute;left:400px;top:0;width:400px;height:120px"><a href="/@right.user/video/7000000000000000013"><video src="blob:https://www.tiktok.com/r" muted playsinline style="width:400px;height:120px"></video><img alt="Правый ролик" src="https://p16.example/r.jpg"></a></div>
</div>
<div id="feed" style="height:200px;overflow-y:auto">
  <div data-e2e="scroll-list-item"><a href="/@alpha.one/video/7000000000000000001"><img alt="Первый ролик" src="https://p16.example/a1.jpg"></a><span>1.2M views</span></div>
  <div data-e2e="scroll-list-item"><a href="/@beta/video/7000000000000000002"><img alt="Второй ролик" src="https://p16.example/a2.jpg"></a><span>45K просмотров</span></div>
  <div data-e2e="scroll-list-item"><a href="/@gamma/photo/7000000000000000003"><img alt="Фото-пост" src="https://p16.example/a3.jpg"></a></div>
  <div data-e2e="scroll-list-item"><a href="/@alpha.one/video/7000000000000000001"><img alt="Дубль" src="https://p16.example/a1.jpg"></a></div>
  <div data-e2e="scroll-list-item"><a href="/@page/about">Не видео</a></div>
  ${'<div style="height:300px">заполнитель</div>'.repeat(6)}
</div></body></html>`;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const probe = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true },
      });
      try {
        await probe.loadURL(`http://127.0.0.1:${port}/foryou`);
        feed.setWebviewId(probe.webContents.id);
        const first = await feed.collect({ previous: [] });
        if (!first.ok) return finish({ ok: false, reason: first.error, summary: { ok: false } });
        // The merge path must grow the list instead of replacing it.
        const second = await feed.collect({ previous: first.items });
        // "Догрузить ещё" only helps if the feed container actually moves.
        const scrolled = await feed.collect({ scroll: true, previous: second.items });

        const summary = {
          first: first.total,
          second: second.total,
          scrolled: scrolled.scrolled,
          ids: first.items.map((i) => i.id).join(','),
        };
        const v1 = first.items.find((i) => i.id === '7000000000000000001');
        const photo = first.items.find((i) => i.id === '7000000000000000003');
        if (first.total !== 8) return finish({ ok: false, reason: `ожидалось 8 уникальных видео, получено ${first.total}`, summary });
        if (second.total !== 8) return finish({ ok: false, reason: `повторный сбор должен сохранять 8, получено ${second.total}`, summary });
        if (!(scrolled.scrolled > 0)) return finish({ ok: false, reason: `прокрутка не сработала: ${scrolled.scrolled}`, summary });
        if (!v1 || v1.handle !== 'alpha.one') return finish({ ok: false, reason: 'handle не извлечён: ' + JSON.stringify(v1), summary });
        if (!v1 || v1.url !== 'https://www.tiktok.com/@alpha.one/video/7000000000000000001') {
          return finish({ ok: false, reason: 'url не собран: ' + JSON.stringify(v1), summary });
        }
        if (!v1 || !/Первый ролик/.test(v1.title)) return finish({ ok: false, reason: 'подпись не извлечена: ' + JSON.stringify(v1), summary });
        if (!v1 || v1.viewCount !== 1200000) return finish({ ok: false, reason: 'просмотры не разобраны: ' + v1?.viewCount, summary });
        if (!v1 || v1.thumbnail !== 'https://p16.example/a1.jpg') return finish({ ok: false, reason: 'обложка не извлечена', summary });
        if (!photo || !photo.isPhoto) return finish({ ok: false, reason: 'фото-пост не помечен', summary });
        // /@page/about is not a video and must be ignored.
        if (first.items.some((i) => i.url.includes('/about'))) return finish({ ok: false, reason: 'не-видео ссылка попала в список', summary });

        // Right-click path: resolve the playing video back to a canonical URL.
        // The <video> src is a blob: URL on purpose — that is what the real
        // feed serves, and it is why the surrounding anchor must be used.
        // (100,300) is inside #now (0..400 both axes) but below #row (y<=120),
        // so the answer must be 009 and nothing else.
        const nowRes = await feed.currentVideo(100, 300);
        const nowV = nowRes && nowRes.video;
        summary.current = nowV ? `${nowV.vid}/${nowV.srcKind}` : 'null';
        if (!nowRes || !nowRes.ok) return finish({ ok: false, reason: 'currentVideo не отработал: ' + JSON.stringify(nowRes), summary });
        if (!nowV) return finish({ ok: false, reason: 'текущее видео не определено', summary });
        if (nowV.vid !== '7000000000000000009') return finish({ ok: false, reason: 'vid текущего видео не извлечён: ' + JSON.stringify(nowV), summary });
        if (nowV.url !== 'https://www.tiktok.com/@now.user/video/7000000000000000009') {
          return finish({ ok: false, reason: 'url текущего видео неверен: ' + JSON.stringify(nowV), summary });
        }
        if (nowV.srcKind !== 'blob') return finish({ ok: false, reason: 'ожидался blob: src, получено ' + nowV.srcKind, summary });
        // Same lookup, but from the coordinates of a right-click. (50,350) is inside
        // #now and OUTSIDE #stack (which starts at x=200), so the area/centre
        // ranking would answer 0010/0011 here. Getting 009 proves the point was
        // actually honoured — that is the regression this guards.
        const atRes = await feed.currentVideo(50, 350);
        const atV = atRes && atRes.video;
        summary.currentAt = atV ? atV.vid : 'null';
        if (!atV || atV.vid !== '7000000000000000009') {
          return finish({ ok: false, reason: 'по координатам видео не определено: ' + JSON.stringify(atV), summary });
        }

        // Regression guard for "the same clip downloads every time", part 2:
        // two videos side by side inside ONE shared container. The old code
        // ran querySelectorAll on the shared ancestor and took the first
        // anchor in document order, so right-clicking the RIGHT card still
        // resolved the LEFT clip (same file, wrong title). (600,60) is the
        // centre of the right card; the answer must be 013 with its own title.
        const sideRes = await feed.currentVideo(600, 60);
        const sideV = sideRes && sideRes.video;
        summary.sideVid = sideV ? `${sideV.vid}/${sideV.title}` : 'null';
        if (!sideV || sideV.vid !== '7000000000000000013') {
          return finish({ ok: false, reason: 'правый ролик в общем контейнере определён неверно: ' + JSON.stringify(sideV), summary });
        }
        if (sideV.url !== 'https://www.tiktok.com/@right.user/video/7000000000000000013') {
          return finish({ ok: false, reason: 'url правого ролика неверен: ' + JSON.stringify(sideV), summary });
        }
        if (!/Правый ролик/.test(sideV.title || '')) {
          return finish({ ok: false, reason: 'заголовок утёк с соседней карточки: ' + JSON.stringify(sideV), summary });
        }

        // Regression guard for "the same clip downloads every time": several
        // stacked <video> elements of identical size, none of them playing.
        // Ranking by area alone falls back to document order there, so the
        // clip under the middle of the screen must win instead.
        const centerRes = await feed.currentVideo();
        const centerV = centerRes && centerRes.video;
        summary.centerVid = centerV ? centerV.vid : 'null';
        if (!centerV || !centerV.url) return finish({ ok: false, reason: 'видео в центре экрана не определено', summary });
        if (centerV.vid !== '7000000000000000010') {
          return finish({
            ok: false,
            reason: 'ожидался верхний по z-ролик 7000000000000000010 (перекрывает остальные), получено ' + centerV.vid,
            summary,
          });
        }

        // Cancelling the contextmenu default action is what keeps Chromium's
        // stock menu from opening over TikTok's own one. The hook never stops
        // propagation, so TikTok's HTML menu still renders — it is the only
        // menu a right-click produces.
        summary.hooks = await feed.runInGuest('String(window.__tkmHooks)');
        summary.contextMenuBlocked = await feed.runInGuest(
          '(() => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return String(e.defaultPrevented); })()'
        );
        if (summary.hooks.value !== 'true') return finish({ ok: false, reason: 'хуки в госте не установлены: ' + JSON.stringify(summary.hooks), summary });
        if (summary.contextMenuBlocked.value !== 'true') {
          return finish({ ok: false, reason: 'нативное меню Chromium не подавлено', summary });
        }
        finish({ ok: true, summary });
      } catch (e) {
        finish({ ok: false, reason: e.message, summary: { error: e.message } });
      }

      function finish(result) {
        feed.setWebviewId(null);
        server.close();
        if (!probe.isDestroyed()) probe.destroy();
        resolve(result);
      }
    });
  });
}

// Verifies that external links keep working through the <webview>.
//
// The app mounts <webview allowpopups> deliberately. Electron prints a
// security advisory about that attribute ("popups are just BrowserWindows"),
// and mounting the webview at startup means the advisory now shows up in
// dev runs. Deleting the attribute would silence the warning, but it also
// silently breaks external links — measured: without it, target=_blank and
// window.open produce ZERO "new-window" events, so they never reach the
// system browser. This check pins the behaviour so nobody "fixes" the
// warning by breaking link handling.
async function localPopupCheck() {
  const http = require('node:http');
  const { pathToFileURL } = require('node:url');
  // The guest preload is the thing that cancels Chromium's menu and rewrites
  // «Загрузить видео», so the fixture loads the very same file the app uses.
  const preloadUrl = pathToFileURL(path.join(__dirname, '..', 'preload', 'webview-preload.js')).href;
  const guest = `<!DOCTYPE html><html><body>
<a id="blank" href="https://example.com/popup" target="_blank">popup</a>
<button id="jswin">js</button>
<a id="dl" download>download</a>
<video id="vid" src="blob:https://example.com/x" style="width:300px;height:200px"></video>
<script>document.getElementById('jswin').addEventListener('click', () => window.open('https://example.com/js', '_blank'));</script>
</body></html>`;

  // Same attributes as src/renderer/renderer.js mountWebview(), including the
  // guest preload that handles the right-click.
  const host = (port, preloadUrl) => `<!DOCTYPE html><html><body>
<webview id="wv" allowpopups preload="${preloadUrl}" src="http://127.0.0.1:${port}/guest" style="width:600px;height:400px"></webview>
<script>
  window.__events = [];
  const wv = document.getElementById('wv');
  wv.addEventListener('new-window', (e) => { window.__events.push(e.url); e.preventDefault(); });
</script>
</body></html>`;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/video.mp4')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 8 });
      res.end(Buffer.alloc(8));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/guest') ? guest : host(server.address().port, preloadUrl));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      const probe = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true },
      });
      const summary = {};
      // The will-download handler in createWindow() reports to the main
      // window, so listen there instead of on the throwaway probe.
      const intercepted = [];
      const onRedirect = (_e, payload) => intercepted.push(payload);
      if (win && !win.isDestroyed()) win.webContents.on('yt:redirectDownload', onRedirect);
      // Right-clicks reported by the guest preload.
      const guestMenus = [];
      const onGuestMenu = (_e, payload) => guestMenus.push(payload);
      ipcMain.on('feed:guestMenu', onGuestMenu);
      try {
        await probe.loadURL(`${base}/host`);
        await new Promise((r) => setTimeout(r, 1500));

        // A synthetic click from executeJavaScript carries no user activation,
        // so the popup blocker swallows it. Real input events do not.
        const guestId = await probe.webContents.executeJavaScript(
          'document.getElementById("wv").getWebContentsId()',
          true
        );
        const guest = webContents.fromId(guestId);
        if (!guest) throw new Error('гостевая страница webview недоступна');

        // Electron 33 may have moved popup handling off the DOM event.
        let viaHandler = 0;
        guest.setWindowOpenHandler(({ url }) => {
          viaHandler += 1;
          return { action: 'deny' };
        });

        const clickAt = async (selector) => {
          // Ask the page where the element actually is instead of guessing
          // viewport coordinates.
          const box = await guest.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)});
               if (!el) return null; const r = el.getBoundingClientRect();
               return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`,
            true
          );
          if (!box) throw new Error('нет элемента ' + selector);
          const { x, y } = JSON.parse(box);
          guest.sendInputEvent({ type: 'mouseMove', x, y });
          guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 500));
        };
        await clickAt('#blank'); // the target=_blank link
        await clickAt('#jswin'); // the window.open() button

        const events = await probe.webContents.executeJavaScript('window.__events', true);
        summary.domEvents = Array.isArray(events) ? events.length : events;
        summary.viaHandler = viaHandler;
        // The guest must reach setWindowOpenHandler for every popup request;
        // that is the hook createWindow() installs via will-attach-webview.
        if (viaHandler < 2) {
          return finish({ ok: false, reason: `ожидалось 2 windowOpenHandler, получено ${viaHandler}`, summary });
        }

        // --- a download clicked inside the guest must be intercepted ---
        // Chromium's manager saves the page's own CDN file, which is
        // downloadAddr: the watermarked variant with the moving logo. Real
        // user output proved it (~/Videos/Download4.mp4, generic name,
        // Lavf58 tag = untouched CDN bytes). So the session handler must
        // cancel it, and nothing may be written to disk.
        const watch = downloadWatchDir();
        summary.watchDir = watch;
        const before = diskListing(watch);
        // Give the link a real href, then click it with real input events —
        // a programmatic .click() carries no user activation, and Chromium
        // treats that differently for downloads.
        await guest.executeJavaScript(
          `(() => { document.getElementById('dl').href = ${JSON.stringify(`${base}/video.mp4`)}; return 'href'; })()`,
          true
        );
        await clickAt('#dl');
        await new Promise((r) => setTimeout(r, 2500));

        // --- right-click inside the guest must reach the main process ---
        // The embedder's DOM "context-menu" event never fires for a <webview>
        // guest (measured: 0 events), so this only works because the guest
        // preload reports it. Nothing is painted on that report any more — the
        // app's own menu is gone — but the report is what proves the preload is
        // attached, and the attachment is what makes «Загрузить видео» work.
        const box = await guest.executeJavaScript(
          `(() => { const r = document.getElementById('vid').getBoundingClientRect();
             return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`,
          true
        );
        const at = JSON.parse(box);
        guest.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        guest.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
        guest.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 900));
        summary.guestMenuReports = guestMenus.length;
        summary.guestMenuMedia = guestMenus.length ? guestMenus[0].mediaType : 'none';
        if (guestMenus.length === 0) {
          return finish({ ok: false, reason: 'правый клик в госте не дошёл до main (preload не отработал)', summary });
        }
        if (guestMenus[0].mediaType !== 'video') {
          return finish({ ok: false, reason: 'правый клик не опознан как клик по видео: ' + JSON.stringify(guestMenus[0]), summary });
        }

        const after = diskListing(watch);
        summary.downloadIntercepted = intercepted.length > 0 || downloadInterceptions > 0;
        summary.interceptions = downloadInterceptions;
        summary.downloadWritten = after.length - before.length;
        if (!summary.downloadIntercepted) {
          return finish({ ok: false, reason: 'will-download не сработал', summary });
        }
        if (summary.downloadWritten !== 0) {
          return finish({ ok: false, reason: `файл сохранён в обход очереди (${summary.downloadWritten} шт.)`, summary });
        }
        finish({ ok: true, summary });
      } catch (e) {
        finish({ ok: false, reason: e.message, summary: { error: e.message } });
      }

      function finish(result) {
        if (win && !win.isDestroyed()) win.webContents.removeListener('yt:redirectDownload', onRedirect);
        ipcMain.removeListener('feed:guestMenu', onGuestMenu);
        server.close();
        if (!probe.isDestroyed()) probe.destroy();
        resolve(result);
      }
    });
  });
}

// The emulated "phone" must stay identical across restarts: TikTok reacts badly
// to a device_id that suddenly changes its region or client, so the identity is
// generated once and then persisted in settings.json.
function ensureEmulatorPersisted() {
  const s = settings.get();
  const ident = ttapi.ensureIdentity(s.emulator);
  const changed = !s.emulator || Object.keys(ident).some((k) => s.emulator[k] !== ident[k]);
  if (changed) settings.set({ emulator: ident });
  return ident;
}

/**
 * Upgrade settings written by older builds.
 *
 * v1 -> v2: the geo-bypass work changed the default region from 'US' to 'BY'
 * (the SIM that the Xposed module spoofs, and the region the app ships aimed
 * at). A settings.json created before that still carries region/regionProfile
 * 'US' because those were the old defaults — not because anyone chose them — so
 * the new default never applies on an existing install and the app silently
 * keeps querying as a US device.
 *
 * Gated on schemaVersion rather than on the absence of regionProfile: an older
 * settings:set() already back-filled regionProfile, so key-presence cannot
 * distinguish "defaulted to US" from "user picked US". Version stamps can.
 * The user can always switch the region back in Настройки.
 */
function migrateSettings() {
  const raw = settings.raw();
  const cur = Number(raw.schemaVersion) || 0;
  if (cur >= settings.SCHEMA_VERSION) return null;

  const patch = { schemaVersion: settings.SCHEMA_VERSION };
  if (
    cur < 2 &&
    String(raw.region || '').toUpperCase() === 'US' &&
    String(raw.regionProfile || 'US').toUpperCase() === 'US'
  ) {
    patch.region = 'BY';
    patch.regionProfile = 'BY';
    // Clear the old derived timezone so the BY profile's Europe/Minsk applies
    // instead of a stale America/New_York that would contradict the region.
    patch.timezone = '';
  }
  settings.set(patch);
  return patch;
}

app.whenReady().then(async () => {
  binaries.setResourcesRoot(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..'));
  binaries.setBinDir(settings.get().binDir);
  // signer resolves vendor/x-gnarly the same way binaries resolves vendor/bin:
  // <resources>/vendor when packaged, <repo>/vendor in dev.
  signer.setResourcesRoot(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..'));
  migrateSettings();
  ensureEmulatorPersisted();
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  if (process.argv.includes('--selftest')) runSelfTest();

  const apiArg = process.argv.indexOf('--apiprobe');
  if (apiArg !== -1) runApiProbe(process.argv[apiArg + 1]);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Live probe against the real TikTok mobile API: `npx electron . --apiprobe <url>`.
// Unlike the selftest this touches the network, so it is a separate flag — but
// it is the only way to confirm the region spoof actually changes what TikTok
// returns, which is the whole point of the geo layer.
async function runApiProbe(url) {
  const log = (...a) => console.log('[apiprobe]', ...a);
  const s = settings.get();
  const id = ytdlp.extractId(url);
  log('id:', id);
  log('profile:', JSON.stringify(regions.getProfile(s.regionProfile || s.region, { carrierIndex: Number(s.carrierIndex) || 0 })));
  try {
    const info = await ttapi.probe(url, s);
    log('OK engine:', info.engine, '| title:', info.title, '| author:', info.author && info.author.name);
    log('formats:', (info.formats || []).map((f) => f.format_id + ':' + (f.height || '?') + (f.note ? '(' + f.note + ')' : '')).join(', '));
    log('thumb:', info.thumbnail ? 'yes' : 'no');
    if (info.engineNote) log('engineNote:', info.engineNote);
  } catch (e) {
    log('FAILED:', e.code || '-', e.message);
    if (e.signNote) log('signNote:', e.signNote);
  }
  app.exit(0);
}

// Headless-ish smoke check used by CI / dev: verifies the renderer booted,
// yt-dlp is callable, and error mapping works, then exits.
async function runSelfTest() {
  const log = (...a) => console.log('[selftest]', ...a);
  const errors = [];
  // Electron's own security advisories are design decisions we make on
  // purpose (allowpopups on <webview> is required — dropping it silently
  // breaks external links, which localPopupCheck() proves). They are printed
  // only in unpackaged runs, so they must not count as failures.
  const isElectronAdvisory = (msg) => /Electron Security Warning/.test(String(msg));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 && !isElectronAdvisory(message)) {
      errors.push(`renderer console: ${message} (${sourceId}:${line})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('renderer gone: ' + JSON.stringify(d)));

  await new Promise((r) => setTimeout(r, 3000));

  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    log('index.html bytes:', html.length);
    const v = await ytdlp.version();
    log('yt-dlp version:', v || 'NOT FOUND');
    if (!v) errors.push('yt-dlp не найден');
    const st = binaries.status();
    log('ffmpeg:', st.ffmpeg || 'not found');
    log('settings file:', settings.get().downloadDir);
    log('extractId:', ytdlp.extractId('https://www.tiktok.com/@u/video/6718335390845095173'));

    // --- geo bypass layer: pure logic, must be verifiable without network ---
    const byProfile = regions.getProfile('BY');
    log('profile BY:', JSON.stringify({
      region: byProfile.region,
      carrier: byProfile.carrier,
      mccmnc: byProfile.carrierMccmnc,
      timezone: byProfile.timezone,
      offset: byProfile.timezoneOffset,
      aid: byProfile.aid,
    }));
    if (byProfile.carrierMccmnc !== '25704') errors.push(`профиль BY: ожидался MCC/MNC 25704 (life:)), получено ${byProfile.carrierMccmnc}`);
    if (byProfile.timezone !== 'Europe/Minsk') errors.push(`профиль BY: ожидался Europe/Minsk, получено ${byProfile.timezone}`);
    if (byProfile.timezoneOffset !== 10800) errors.push(`профиль BY: ожидался UTC+3 (10800), получено ${byProfile.timezoneOffset}`);

    // The emulated "SIM" is the whole point: every region field must carry it.
    const geoSettings = { ...settings.get(), region: 'BY', regionProfile: 'BY', timezone: '' };
    const ctx = ttapi.context(geoSettings);
    const q = ttapi.buildQuery(ctx.profile, ctx.ident, geoSettings, {});
    const regionFields = ['region', 'current_region', 'sys_region', 'residence', 'carrier_region', 'op_region'];
    for (const f of regionFields) {
      if (q[f] !== 'BY') errors.push(`параметр ${f} должен быть BY, получено ${JSON.stringify(q[f])}`);
    }
    if (q.mcc_mnc !== '25704') errors.push(`mcc_mnc должен быть 25704, получено ${q.mcc_mnc}`);
    if (q.timezone_name !== 'Europe/Minsk') errors.push(`timezone_name должен быть Europe/Minsk, получено ${q.timezone_name}`);
    if (q.timezone_offset !== '10800') errors.push(`timezone_offset должен быть 10800, получено ${q.timezone_offset}`);
    if (!/musically|zhiliaoapp|ss\.android/.test(ttapi.appUserAgent(ctx.profile))) {
      errors.push('User-Agent не похож на мобильный: ' + ttapi.appUserAgent(ctx.profile));
    }
    log('request region fields:', JSON.stringify(Object.fromEntries(regionFields.map((f) => [f, q[f]]))), 'mcc_mnc=' + q.mcc_mnc);
    log('app UA:', ttapi.appUserAgent(ctx.profile));

    // Identity must be stable across calls, or TikTok sees a new phone every time.
    const ident1 = ttapi.ensureIdentity(ctx.ident);
    const ident2 = ttapi.ensureIdentity(ident1);
    if (JSON.stringify(ident1) !== JSON.stringify(ident2)) errors.push('идентификатор устройства нестабилен между вызовами');
    const fresh = ttapi.ensureIdentity({});
    if (fresh.device_id === ident1.device_id) errors.push('ensureIdentity({}) должен выдавать новый device_id');

    // Mismatch between claimed region and real IP is the classic cause of the
    // "only old videos" symptom, so it must be detected, not ignored.
    const mismatch = regions.assessConsistency(regions.getProfile('BY'), 'RU');
    if (mismatch.ok) errors.push('рассогласование IP и региона не обнаружено');
    log('consistency RU vs BY:', JSON.stringify(mismatch.problems.map((p) => p.code)));
    if (regions.assessConsistency(regions.getProfile('BY'), 'BY').ok !== true) {
      errors.push('совпадение IP и региона ошибочно помечено как проблема');
    }

    // yt-dlp must not be forced onto the signed web host by default.
    const argsFor = ytdlp.baseArgs({ ...settings.get(), apiHostname: '', appInfo: '', deviceId: '' }, { simulate: true });
    log('yt-dlp args:', argsFor.join(' '));
    if (argsFor.includes('www.tiktok.com')) {
      errors.push('yt-dlp принудительно переключён на подписанный веб-хост www.tiktok.com');
    }
    if (!argsFor.includes('--progress')) errors.push('в аргументах yt-dlp нет --progress, прогресс не будет отображаться');
    if (ytdlp.extractorArgs({ apiHostname: 'api16-normal-c-useast1a.tiktokv.com' }).join(' ') !== '--extractor-args tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com') {
      errors.push('extractorArgs формирует неверные аргументы для явного api_hostname: ' + JSON.stringify(ytdlp.extractorArgs({ apiHostname: 'api16-normal-c-useast1a.tiktokv.com' })));
    }
    if (ytdlp.extractorArgs({}).length !== 0) {
      errors.push('extractorArgs без настроек не должен ничего добавлять: ' + JSON.stringify(ytdlp.extractorArgs({})));
    }
    log('probe maps blocked-IP error:', ytdlp.humanError('ERROR: [TikTok] 123: Your IP address is blocked from accessing this post'));

    // --- format selector: the watermark filter used to be a no-op ---
    // `format_note!*=watermark` rejects every clean TikTok format (they carry
    // no note at all), so the old chain failed all the way down to a bare
    // /best and the watermark exclusion never ran. Assert the replacement.
    const selDefault = ytdlp.formatSelector({ format: 'best' });
    log('format selector:', selDefault);
    if (/format_note/.test(selDefault)) {
      errors.push('селектор формата фильтрует по format_note — так отсекаются все чистые форматы: ' + selDefault);
    }
    if (!/format_id!=download/.test(selDefault)) {
      errors.push('селектор формата не исключает watermarked-формат download: ' + selDefault);
    }
    if (/\/best(\s|$)/.test(selDefault)) {
      errors.push('в конце селектора остался голый /best — он возьмёт watermarked-формат: ' + selDefault);
    }
    for (const link of selDefault.split('/')) {
      if (link && !/format_id!=download/.test(link)) {
        errors.push('звено селектора не фильтрует watermark: ' + link);
      }
    }
    // The height cap must be per link, not global: "[height<=720]" alone
    // matches nothing because the 540p formats report 1024p.
    const selCap = ytdlp.formatSelector({ format: 'best', maxHeight: 720 });
    log('format selector (cap 720):', selCap);
    if (!/height<=720/.test(selCap)) errors.push('ограничение высоты не попало в селектор: ' + selCap);
    const selLast = selCap.split('/').pop();
    if (/height<=720/.test(selLast)) {
      errors.push('последнее звено селектора не должно требовать height<=720 — это отсекает всё: ' + selLast);
    }
    if (!/format_id!=download/.test(ytdlp.formatSelector({ audioOnly: true }))) {
      errors.push('аудиоселектор не исключает watermarked-формат');
    }

    // Optional signer layer (yt-dlp#13134). Off by default, and a failure to
    // sign must degrade to an unsigned request instead of breaking the call.
    const sigOff = await signer.applySignatures({ queryString: 'a=1', body: '', userAgent: 'ua' }, {});
    if (Object.keys(sigOff.added).length !== 0) {
      errors.push('подпись применяется, хотя выключена: ' + JSON.stringify(sigOff.added));
    }
    let sigRes = null;
    try {
      sigRes = signer.selfTest();
      log('X-Gnarly selfTest:', JSON.stringify(sigRes));
      if (!sigRes.queryHash || !sigRes.bodyHash || !sigRes.uaHash) {
        errors.push('X-Gnarly round-trip не сошёлся: ' + JSON.stringify(sigRes));
      }
      const sigOn = await signer.applySignatures(
        { queryString: 'a=1&b=2', body: 'x=1', userAgent: 'ua' },
        { signer: { enabled: true, provider: 'gnarly' } }
      );
      if (!sigOn.added['X-Gnarly']) {
        errors.push('включённая подпись gnarly не добавила заголовок X-Gnarly');
      }
      if (!signer.looksLikeGnarly(sigOn.added['X-Gnarly'])) {
        errors.push('X-Gnarly имеет неверный формат: ' + String(sigOn.added['X-Gnarly']).slice(0, 32));
      }
    } catch (e) {
      errors.push('подписант не прошёл self-test: ' + e.message);
    }
    // A missing Python sidecar is a normal state, not a failure.
    const sigMobile = await signer.applySignatures({ url: 'https://x/', method: 'GET' }, { signer: { enabled: true, provider: 'mobile' } });
    if (!sigMobile.note && Object.keys(sigMobile.added).length === 0) {
      errors.push('провайдер mobile не сообщил ни подписи, ни причину');
    }
    log('signer status:', JSON.stringify(signer.status({ signer: { enabled: true, provider: 'gnarly' } })));

    // end-to-end: the download path must emit a clean error, not crash,
    // and must pass the proxy/region args through to yt-dlp.
    const s = settings.get();
    const probeErr = await ytdlp
      .probe('https://www.tiktok.com/@scout2015/video/6718335390845095173', s)
      .then(() => 'unexpected success')
      .catch((e) => e.message);
    log('probe result (offline sandbox expected):', probeErr.slice(0, 90));

    const dl = await new Promise((resolve) => {
      const events = [];
      ytdlp.startDownload('selftest_job', 'https://www.tiktok.com/@scout2015/video/6718335390845095173', s, {
        onProgress: (p) => events.push('progress:' + p.status),
        onDone: (r) => events.push('done:' + r.path),
        onError: (m) => {
          events.push('error:' + m);
          resolve(events);
        },
      });
      setTimeout(() => {
        ytdlp.cancel('selftest_job');
        resolve(events.length ? events : ['no events, and no error — investigate']);
      }, 30000);
    });
    log('download events:', JSON.stringify(dl));
    // Either outcome is a pass: a real download, a clean mapped error, or
    // visible progress cut by the timeout (slow/blocked network still proves
    // the child is alive and parsing works). What is NOT acceptable is
    // silence — that would mean the child died unnoticed.
    if (!dl.some((e) => e.startsWith('error:') || e.startsWith('done:') || e.startsWith('progress:'))) {
      errors.push('download не отдал ни успеха, ни ошибки: ' + JSON.stringify(dl));
    }
    const liveDone = dl.find((e) => e.startsWith('done:'));
    if (liveDone) {
      log('LIVE: реальная выкачка с TikTok удалась ->', liveDone.slice(5));
    }

    // Full pipeline against a local HTTP server: verifies progress parsing,
    // the DONE template, the output template and the download dir creation.
    const local = await localPipelineCheck();
    log('local pipeline:', JSON.stringify(local));
    if (!local.done) errors.push('локальный прогон пайплайна не завершился: ' + local.reason);
    if (!local.progressSeen) errors.push('PROG-события не распарсились');
    if (local.sizeMismatch) errors.push('размер не совпал: ' + local.sizeMismatch);
    if (local.settingsUntouched === false) errors.push('selftest изменил папку загрузок пользователя');
    // The saved name must not start with the flattened download path: the old
    // output template sanitized the joined path, turning the directory
    // separators into "_", so every file began with "C__Users_..._TikTokMod_".
    if (local.pathNotFlattened === false) {
      errors.push('имя файла содержит «расплющенный» путь загрузок: ' + local.fileName);
    }

    log('isTikTokUrl checks:', ytdlp.isTikTokUrl('https://vm.tiktok.com/abc'), ytdlp.isTikTokUrl('https://youtube.com/x'));

    // --- link classification: a feed URL must be explained, not handed to
    // yt-dlp (it answers "Unsupported URL", which reads like a crash) ---
    const classifyCases = [
      ['https://www.tiktok.com/foryou', 'feed'],
      ['https://www.tiktok.com/', 'feed'],
      ['https://www.tiktok.com/explore', 'feed'],
      ['https://www.tiktok.com/@user', 'profile'],
      ['https://www.tiktok.com/tag/dance', 'hashtag'],
      ['https://www.tiktok.com/music/some-sound', 'sound'],
      ['https://www.tiktok.com/@u/video/6718335390845095173', 'video'],
      ['https://vm.tiktok.com/ZSabc123/', 'short'],
      ['https://youtube.com/watch', 'other'],
    ];
    for (const [u, kind] of classifyCases) {
      const got = ytdlp.classifyUrl(u).kind;
      if (got !== kind) errors.push(`classifyUrl(${u}) → ${got}, ожидался ${kind}`);
    }
    if (ytdlp.isDownloadableUrl('https://www.tiktok.com/foryou')) {
      errors.push('ссылка на ленту помечена как доступная для скачивания');
    }
    if (!ytdlp.isDownloadableUrl('https://vm.tiktok.com/ZSabc123/')) {
      errors.push('короткая ссылка vm.tiktok.com должна проходить в yt-dlp');
    }
    log('feed URL is rejected with:', ytdlp.explainUnsupported('https://www.tiktok.com/foryou').slice(0, 60) + '…');

    // The strict guard must fire before any yt-dlp process starts.
    let strictMsg = '';
    try {
      await engine.probe('https://www.tiktok.com/foryou', settings.get());
      errors.push('engine.probe принял ссылку на ленту');
    } catch (e) {
      strictMsg = e.message;
      if (e.code !== 'unsupported-url') errors.push('ожидался код unsupported-url, получено ' + e.code);
    }
    if (!/лента/i.test(strictMsg)) errors.push('сообщение о ленте не распознаётся: ' + strictMsg);

    // --- feed collection: run the injected script in a real Chromium against a
    // TikTok-shaped page, so the DOM walking is verified, not assumed ---
    const feedCheck = await localFeedCheck();
    log('feed collect:', JSON.stringify(feedCheck.summary));
    if (!feedCheck.ok) errors.push('сбор ленты: ' + feedCheck.reason);

    // --- external links: <webview> must still emit "new-window" so links
    // opened in a new tab are handed to the system browser ---
    const popupCheck = await localPopupCheck();
    log('webview popup:', JSON.stringify(popupCheck.summary));
    if (!popupCheck.ok) errors.push('ссылки в новом окне: ' + popupCheck.reason);
  } catch (e) {
    errors.push('exception: ' + e.message);
  }

  const report = { ok: errors.length === 0, errors, at: new Date().toISOString() };
  const reportPath = path.join(app.getPath('temp'), 'tiktokmod-selftest.json');
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('[selftest] report:', reportPath);
  } catch {}

  if (errors.length) {
    console.error('[selftest] FAIL\n' + errors.join('\n'));
    app.exit(1);
  } else {
    log('PASS');
    app.exit(0);
  }
}

app.on('window-all-closed', () => {
  ytdlp.cancelAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => ytdlp.cancelAll());

// ---------- menu ----------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Открыть папку загрузок',
          click: () => shell.openPath(settings.get().downloadDir),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'Диагностика окружения',
          click: () => showDiagnostics(),
        },
        {
          label: 'Обновить yt-dlp',
          click: async () => {
            const exe = binaries.ytdlp();
            if (!exe) return dialog.showErrorBox('yt-dlp', 'Бинарник не найден.');
            const { spawn } = require('node:child_process');
            const child = spawn(exe, ['-U'], { windowsHide: true });
            child.on('close', async (code) => {
              const v = await ytdlp.version();
              dialog.showMessageBox(win, {
                type: code === 0 ? 'info' : 'warning',
                message: code === 0 ? 'yt-dlp обновлён' : 'Не удалось обновить yt-dlp',
                detail: `Версия: ${v || 'неизвестно'}`,
              });
            });
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function signerLine(s) {
  const cfg = (s && s.signer) || {};
  if (!cfg.enabled) return 'выключена';
  if (cfg.provider === 'mobile') {
    const p = signer.status(s).mobile;
    return `mobile (${p.ok ? `Python ${p.python}` : p.reason})`;
  }
  return `gnarly X-Gnarly ${signer.status(s).gnarly.version || '?'}`;
}

async function showDiagnostics() {
  const st = binaries.status();
  const v = await ytdlp.version();
  const s = settings.get();
  const profile = regions.getProfile(s.regionProfile || s.region, { carrierIndex: Number(s.carrierIndex) || 0 });
  const geoReport = await geo.inspect(s).catch((e) => ({ verdict: { text: 'ошибка диагностики: ' + e.message } }));
  const details = [
    `yt-dlp: ${st.ytDlp || 'НЕ НАЙДЕН'} (версия ${v || '?'})`,
    `ffmpeg: ${st.ffmpeg || 'не найден (склейка форматов недоступна)'}`,
    `ffprobe: ${st.ffprobe || 'не найден'}`,
    `Папка загрузок: ${s.downloadDir}`,
    `Прокси: ${s.proxy || 'не задан'}`,
    `Cookies из браузера: ${s.cookiesFromBrowser}`,
    `Движок метаданных: ${engine.engineOf(s)}`,
    `Подпись запросов: ${signLine(s)}`,
    '',
    `Эмулируемое устройство:`,
    `  регион: ${profile.region} (${profile.country}), оператор ${profile.carrier || '—'} ${profile.carrierMccmnc}`,
    `  часовой пояс: ${profile.timezone} (UTC${profile.timezoneOffset / 3600 >= 0 ? '+' : ''}${profile.timezoneOffset / 3600}), язык ${profile.language}`,
    `  приложение: ${profile.app_name} ${profile.app_version} (aid ${profile.aid})`,
    `  device_id: ${s.emulator?.device_id || 'не создан'}`,
    '',
    `IP: ${geoReport.egress?.country || 'не определён'}`,
    geoReport.verdict?.text || '',
  ].join('\n');
  dialog.showMessageBox(win, { type: 'info', message: 'Диагностика', detail: details });
}

// ---------- ipc ----------

ipcMain.handle('settings:get', () => {
  const s = settings.get();
  binaries.setBinDir(s.binDir);
  return s;
});

ipcMain.handle('settings:set', async (_e, patch) => {
  const p = { ...(patch || {}) };
  // Keep the region pair in sync: the UI may send either field.
  if (p.region && !p.regionProfile) p.regionProfile = p.region;
  if (p.regionProfile && !p.region) p.region = p.regionProfile;
  // Picking a profile should adopt its timezone/language unless the user
  // explicitly set them, otherwise the mix of region and timezone is obvious
  // to TikTok (this is the SIM story falling apart).
  if (p.regionProfile && !Object.prototype.hasOwnProperty.call(p, 'timezone')) {
    p.timezone = regions.getProfile(p.regionProfile).timezone;
  }
  const next = settings.set(p);
  binaries.setBinDir(next.binDir);
  ensureEmulatorPersisted();
  await applyProxyToSession(session.defaultSession);
  return next;
});

ipcMain.handle('settings:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.get().downloadDir,
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('settings:reveal', (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.handle('yt:probe', async (_e, url) => {
  const s = settings.get();
  return await engine.probe(url, s);
});

// Lets the renderer classify a pasted link without a round-trip through the
// engines, so the UI can explain a feed/profile link instead of showing a raw
// yt-dlp "Unsupported URL".
ipcMain.handle('yt:classify', (_e, url) => {
  const c = ytdlp.classifyUrl(url);
  return { ...c, downloadable: ytdlp.isDownloadableUrl(url), message: ytdlp.explainUnsupported(url) };
});

// ---------- feed ----------

// The renderer mounts <webview id="feedWebview"> lazily and reports its
// webContents id; feed.js then runs scripts inside the loaded TikTok page.
ipcMain.handle('feed:register', async (_e, id) => {
  feed.setWebviewId(id);
  attachGuestMenu(id);
  return await feed.installHooks();
});

// Right-click: TikTok's menu, and nothing else.
//
// The app used to pop its own native Menu here. That widget is painted by the
// browser process through Chromium Views (Menu.buildFromTemplate(...).popup()
// -> views::MenuRunner::RunMenuAt), so it has no DOM node and cannot be hidden
// by anything the page does — four separate attempts at pruning the DOM all
// failed for exactly that reason, and the user was left with two menus stacked
// on every right-click. The fix is not to hide that menu but to stop building
// it: a right-click inside the guest now produces TikTok's own HTML menu only.
//
// What still has to happen here is the opposite of showing something: cancel
// Chromium's default menu. preventDefault() on the contextmenu default action
// is the only thing between a right-click and the stock "Open link in new tab /
// ..." popup, and it holds even when the guest preload failed to attach (the
// packaged asar path, a page that swaps the document, a reload racing the
// attribute write) — webContents 'context-menu' is a main-process event and
// fires for every guest regardless of preload state.
const guestMenuWired = new Set();

function attachGuestMenu(id) {
  const wc = webContents.fromId(Number(id));
  if (!wc || wc.isDestroyed()) return false;
  if (guestMenuWired.has(wc.id)) return true;
  guestMenuWired.add(wc.id);

  wc.on('context-menu', (event) => {
    // Suppress Chromium's default menu, and paint nothing in its place.
    event.preventDefault();
  });

  // The guest side needs the same cancel for pages that replace the document
  // after the preload ran (see HOOK_SCRIPT in feed.js). It calls
  // preventDefault() without stopping propagation, so TikTok's own HTML menu is
  // unaffected.
  wc.on('dom-ready', () => {
    feed.installHooks();
  });

  wc.on('destroyed', () => {
    guestMenuWired.delete(wc.id);
  });
  return true;
}

ipcMain.handle('feed:collect', async (_e, opts = {}) => feed.collect(opts));

// Resolves the video currently playing in the browser tab (or the one under
// the right-clicked coordinates) to a canonical /@handle/video/<id> URL. The
// <video> src is a blob: URL, so the surrounding anchor is the only reliable
// source of the id — see the note in feed.js.
ipcMain.handle('feed:currentVideo', async (_e, { x = null, y = null } = {}) => {
  return await feed.currentVideo(x, y);
});

// The item the recommendations feed is playing right now. Separate from
// currentVideo(): that one answers "which video is under these coordinates",
// this one answers "which video is on screen", which is what the single
// "Скачать текущее видео" button needs.
ipcMain.handle('feed:currentPlaying', async () => {
  return await feed.currentPlaying();
});

// "Загрузить видео" in TikTok's own context menu. The page's handler is
// intercepted by src/preload/webview-preload.js, which cannot resolve the
// clip on its own — so the same resolution the toolbar button uses runs here
// and the result is handed to the renderer as an ordinary download action.
ipcMain.on('feed:downloadCurrent', async () => {
  const res = await feed.currentPlaying();
  const video = res && res.ok ? res.video : null;
  if (!win || win.isDestroyed()) return;
  if (!video || !video.url) {
    win.webContents.send('feed:menuAction', {
      action: 'notice',
      message: (res && res.error) || 'Видео не найдено: дождитесь, пока ролик начнёт играть',
    });
    return;
  }
  win.webContents.send('feed:menuAction', {
    action: 'download',
    url: video.url,
    title: video.title || video.url,
  });
});

// Absolute file:// URL for the <webview> preload. The renderer cannot build it
// itself: it has no filesystem access and the packaged path differs from the
// repo one.
ipcMain.handle('feed:guestPreloadUrl', () => {
  const { pathToFileURL } = require('node:url');
  return pathToFileURL(path.join(__dirname, '..', 'preload', 'webview-preload.js')).href;
});

// Right-click reported from inside the guest (see src/preload/webview-preload.js).
//
// Diagnostics only. The app paints no menu on a right-click, so there is
// nothing to decide here and nothing to send back — the handler is deliberately
// empty. The channel is kept because runSelfTest()'s localPopupCheck() listens
// on it to prove the guest preload is attached, and an unattached preload is
// otherwise invisible: «Загрузить видео» still "works" through the will-download
// cancellation in createWindow(), so it can never be used as proof.
ipcMain.on('feed:guestMenu', () => {});

ipcMain.handle('yt:probeBatch', async (e, urls) => {
  const s = settings.get();
  return await engine.probeBatch(urls, s, {
    concurrency: s.concurrency,
    onEach: (item) => e.sender.send('yt:probeItem', item),
  });
});

ipcMain.handle('yt:author', async (_e, { handle, cursor = 0 } = {}) => {
  const s = settings.get();
  return await engine.author(handle, s, { cursor });
});

ipcMain.handle('media:save', async (_e, { url, filename }) => {
  const s = settings.get();
  const name = String(filename || 'media.jpg').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const dest = path.join(s.downloadDir, name);
  return await engine.saveMedia(url, dest, s);
});

// ---------- geo ----------

ipcMain.handle('geo:inspect', async () => {
  try {
    return await geo.inspect(settings.get());
  } catch (e) {
    return { error: e.message, profile: null, egress: { country: null }, notes: [], verdict: { ok: false, level: 'error', text: e.message } };
  }
});

ipcMain.handle('geo:profiles', () => regions.listProfiles());

ipcMain.handle('signer:status', () => signer.status(settings.get()));
ipcMain.handle('signer:selfTest', () => {
  try {
    return { ok: true, ...signer.selfTest() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Shows the exact request that will be sent, so a failing setup can be
// debugged without guessing which region/operator/device actually went out.
ipcMain.handle('geo:params', () => {
  const s = settings.get();
  const { profile, ident } = ttapi.context(s);
  return {
    endpoint: `POST https://${(s.apiHostname || regions.API_HOSTS[0])}/aweme/v1/multi/aweme/detail/`,
    userAgent: ttapi.appUserAgent(profile),
    body: { aweme_ids: '[<video id>]', request_source: '0' },
    query: ttapi.buildQuery(profile, ident, s, { aweme_ids: '[<video id>]', request_source: '0' }),
  };
});

ipcMain.handle('geo:check', async (_e, videoUrl) => {
  const s = settings.get();
  const report = await geo.inspect(s);
  let probeResult = null;
  try {
    const info = await engine.probe(videoUrl, s);
    probeResult = { ok: true, id: info.id, title: info.title, height: info.height, engine: info.extractor };
  } catch (e) {
    probeResult = { ok: false, error: e.message };
  }
  return { ...report, probe: probeResult };
});

ipcMain.handle('yt:download', (e, { url, id }) => {
  const s = settings.get();
  fs.mkdirSync(s.downloadDir, { recursive: true });
  const jobId = id || `job_${Date.now()}`;
  ytdlp.startDownload(jobId, url, s, {
    onProgress: (p) => e.sender.send('yt:progress', p),
    onDone: (r) => e.sender.send('yt:done', r),
    onError: (m) => e.sender.send('yt:error', { id: jobId, message: m }),
  });
  return jobId;
});

ipcMain.handle('yt:cancel', (_e, id) => ytdlp.cancel(id));
ipcMain.handle('yt:cancelAll', () => ytdlp.cancelAll());
ipcMain.handle('yt:version', () => ytdlp.version());
ipcMain.handle('yt:status', () => binaries.status());

ipcMain.handle('net:probe', async (_e, url) => {
  const s = settings.get();
  const target = url || 'https://www.tiktok.com/@tiktok';
  try {
    const info = await engine.probe(target, s);
    return {
      ok: true,
      message: `Доступ работает через ${info.extractor === 'tiktok-api' ? 'мобильный API' : 'yt-dlp'}: ${info.title}`,
      info,
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('nav:url', (e, url) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && /^https?:/i.test(url)) {
    const host = new URL(url).hostname;
    if (ALLOWED_HOSTS.test(host) || /^\d/.test(host)) return;
    shell.openExternal(url);
  }
});

ipcMain.handle('clipboard:write', (_e, text) => {
  require('electron').clipboard.writeText(String(text || ''));
  return true;
});