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
const live = require('./live');
const livechat = require('./livechat');

let win = null;
// The webview guest's webContents id, remembered by ipcMain.handle('feed:register')
// and read by the screen-recording path. It must be DECLARED: main.js is
// 'use strict', so assigning to an undeclared name throws a ReferenceError — which
// in `feed:register` happens on the line BEFORE feed.setWebviewId(id), leaving the
// guest permanently unregistered and every feed read answering "the embedded
// browser is not open" while the webview is plainly on screen.
let feedGuestId = null;
const ALLOWED_HOSTS = /(^|\.)(tiktok\.com|musical\.ly|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|amemv\.com|byteoversea\.com|tiktokmusic\.com)$/i;

// Counts every download the session handler cancelled. Exported so the
// selftest can tell "the event never fired" from "it fired but nothing was
// written", which look identical from the filesystem side.
let downloadInterceptions = 0;

// Makes every recording id unique even when two captures start in the same
// millisecond. See the live:start handler for why a bare Date.now() is not
// enough.
let liveJobSeq = 0;

// Quitting while a capture is in flight: ffmpeg is asked to finalise the
// container, but app.quit() does not wait for it. Set while that drain runs so
// before-quit can defer the real exit exactly once.
let quittingAfterDrain = false;
// Screen recordings being STARTED right now. startScreen() registers itself in
// live's `running` map only after its first capturePage(), so live.list() cannot
// see it during that window and two fast clicks could both pass the cap check.
let liveScreenStarting = 0;

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

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setMaxListeners(20);

  // The hidden audio-capture window must never outlive the main one: it is a
  // BrowserWindow like any other, so leaving it open would stop `window-all-closed`
  // from ever firing and the app would survive with nothing on screen.
  win.on('closed', () => {
    destroyGuestAudioWindow();
  });

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
  // Screen mode takes its sound from the guest's own audio track (see the
  // guest-audio block above). Registered once, here, because the handler has to
  // be in place before any getDisplayMedia request can arrive — the capture window
  // is created later, on the first recording that asks for sound.
  installGuestAudioCapture();

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
  stopAllDomPolls();
  live.stopAll('Приложение закрыто.');
  // Flush and close the guest capture, then drop its window. This is the one path
  // that can run with no renderer left to answer a stop request, and the file
  // handle MUST be released here or the process never exits.
  stopGuestAudioCapture();
  destroyGuestAudioWindow();
  // Chat sinks only live as long as their recording; closing them here flushes the
  // last subtitle cue so the .srt is not missing its tail on a forced exit.
  livechat.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  ytdlp.cancelAll();
  stopAllDomPolls();
  // The recorder holds an open file handle and a live getDisplayMedia stream;
  // both have to be gone before the process can reach exit(0).
  stopGuestAudioCapture();

  const n = live.status().running;
  if (!n) return;

  // Graceful: ffmpeg is asked to finalise the container so the partial recording
  // stays playable — SIGKILL would leave an unplayable file. That is NOT
  // instantaneous though, and app.quit() tears the process down immediately, so
  // the first before-quit defers the exit until the captures have closed.
  if (quittingAfterDrain) {
    live.stopAll('Приложение закрыто.');
    livechat.closeAll();
    app.exit(0);
    return;
  }
  e.preventDefault();
  quittingAfterDrain = true;
  live.stopAll('Приложение закрыто.');

  const giveUp = setTimeout(() => app.exit(0), 8000);
  if (giveUp.unref) giveUp.unref();
  const check = setInterval(() => {
    if (live.status().running === 0) {
      clearInterval(check);
      clearTimeout(giveUp);
      livechat.closeAll();
      app.quit();
    }
  }, 200);
  if (check.unref) check.unref();
});

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
        // NO resetZoom/zoomIn/zoomOut roles here on purpose. Those are Chromium
        // window roles: they zoom whichever page has focus, and the landing tab
        // holds a live TikTok <webview>. That would zoom the guest and leave
        // localStorage/the % label lying. Scaling is handled in one place only —
        // the ipcMain.handle('ui:zoom') endpoint behind the topbar buttons.
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
  feedGuestId = Number(id) || null;
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
    installChatTap(wc);
  });

  // A live room opens its webcast socket as the route change commits, so the tap
  // has to be back in place on every SPA navigation — not just on a full load,
  // where dom-ready already covers it. installChatTap is idempotent (the tap is
  // too), so the overlap is free.
  wc.on('did-navigate-in-page', (_e, url) => {
    installChatTap(wc, url);
  });
  wc.on('did-stop-loading', () => {
    installChatTap(wc);
  });

  wc.on('destroyed', () => {
    guestMenuWired.delete(wc.id);
    chatTaps.delete(wc.id);
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

// ---------- LIVE recording ----------

// Resolve a broadcast (link, @handle or bare handle) into a room descriptor.
// Returns { ok:false, error, offline?, restricted? } instead of throwing so the
// renderer can tell "nobody is live" apart from "your region is blocked".
ipcMain.handle('live:resolve', async (_e, input) => {
  try {
    return await live.resolve(input, settings.get());
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Live links reachable from the page open in the embedded browser.
ipcMain.handle('live:detect', async () => {
  try {
    return await feed.detectLive();
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// ============================================================================
// Screen mode: taking the sound from the BROWSER instead of the CDN.
//
// THE PROBLEM THIS REPLACES. Screen mode ("Экран") records page PIXELS with
// guest.capturePage(), and the pixels are what the player is showing — i.e.
// content that already went through Chromium's playback buffers and is therefore
// 2-5 s behind the live edge. The sound used to come from a SECOND, independent
// ffmpeg pointed at the signed CDN URL, which reads the live edge directly. Two
// signals, two different points of the pipeline, and nothing in between to measure
// the gap: three attempts to correct it with a constant `-itsoffset` all failed
// (see screenMuxArgs), and the player's buffer depth is not exposed through any
// API the guest page can be asked about.
//
// THE FIX. Take the sound out of the SAME Chromium that plays the picture, after
// the same buffers — Electron can hand out the audio of one webContents'
// WebFrameMain to another through a display-media request handler. Both signals
// then share one clock by construction, and the only thing left to align is the
// difference between two Date.now() stamps taken in the main process.
//
// EVERYTHING HERE IS OPTIONAL. It runs next to a recording that is already
// capturing frames; a failure anywhere below must leave "recording, no sound"
// behind and never touch the video.
// ============================================================================

// Absolute path of the page that does the capture. The file itself is an empty
// shell — the logic is injected, see GUEST_AUDIO_SOURCE.
const GUEST_AUDIO_PAGE = path.join(__dirname, '..', 'renderer', 'audio-capture.html');
const GUEST_AUDIO_PRELOAD = path.join(__dirname, '..', 'preload', 'audio-capture-preload.js');

// The capture in flight, or null. `{ fd, startedAt, stopTimer, path }` plus the
// bookkeeping below. Exactly one at a time: only one screen recording may run
// (see live:start), and a second capture would fight over the same file.
let guestAudioJob = null;
// The hidden window, created lazily on the first capture and destroyed right
// after the last one. It must never be left open: `window-all-closed` only fires
// when EVERY BrowserWindow is gone, so a lingering hidden window would keep the
// app alive after the user closes the main one.
let guestAudioWindow = null;
// Resolves once guestAudioWindow's page is loaded and can run injected source.
let guestAudioWindowReady = null;

/**
 * The recording logic, shipped to the capture page as SOURCE TEXT.
 *
 * It must run in the MAIN world: navigator.mediaDevices, getDisplayMedia and
 * MediaRecorder do not exist in the isolated world, and webContents
 * .executeJavaScript() is the only call here that reaches it. That also means it
 * is not subject to the page CSP, which is why audio-capture.html can forbid
 * script sources entirely.
 *
 * Everything is self-contained — no name from this module may be referenced — and
 * every failure is turned into `{ ok:false, error }` rather than a rejection,
 * because a rejected promise here is only visible as a silently silent recording.
 */
const GUEST_AUDIO_SOURCE = `(() => {
  const S = (window.__tkmGA = window.__tkmGA || { rec: null, stream: null, startedAt: 0 });
  const bridge = window.guestAudio || null;
  const say = (fn, v) => { try { if (bridge && typeof bridge[fn] === 'function') bridge[fn](v); } catch (_) {} };
  const bail = (m) => { say('fail', m); return { ok: false, error: String(m) }; };

  // Opus in WebM is what ffmpeg demuxes natively from the sidecar; anything else
  // (pcm, mp4) would need a bitstream filter or a re-wrap for no gain.
  const pickMime = () => {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm']) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return '';
  };

  // Byte-wise base64 without blowing the argument limit on a large chunk.
  const toB64 = (buf) => {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 4096) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 4096, u8.length)));
    }
    return btoa(s);
  };

  window.__tkmGuestAudioStart = async function () {
    if (S.rec && S.rec.state !== 'inactive') return { ok: true, startedAt: S.startedAt };
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        return bail('в окне захвата недоступен getDisplayMedia');
      }
      // No user gesture and no picker: Electron's setDisplayMediaRequestHandler
      // answers this itself (see installGuestAudioCapture). Video is NOT
      // requested — only the guest's audio track is of any use here.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true });
      const tracks = (stream.getAudioTracks ? stream.getAudioTracks() : []).filter((t) => t.kind === 'audio');
      if (!tracks.length) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        return bail('захват вернулся без аудио-дорожки — плеер эфира молчит');
      }
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      S.stream = stream;
      S.rec = rec;
      rec.ondataavailable = (e) => {
        const d = e && e.data;
        if (!d || !d.size) return;
        try { d.arrayBuffer().then((b) => say('chunk', toB64(b))).catch(() => {}); } catch (_) {}
      };
      rec.onstop = () => say('done', { startedAt: S.startedAt, stoppedAt: Date.now() });
      rec.onerror = (e) => say('fail', 'MediaRecorder: ' + ((e && e.error && e.error.name) || 'error'));
      rec.start(200);
      // The one number the whole design rests on: the wall clock at the instant
      // recording actually began, taken HERE and not in main, because everything
      // before this line is negotiation and everything after it is content.
      S.startedAt = Date.now();
      say('ready', { startedAt: S.startedAt, mime: rec.mimeType || mime || '' });
      return { ok: true, startedAt: S.startedAt };
    } catch (e) {
      return bail((e && ((e.name || '') + ': ' + (e.message || ''))) || String(e));
    }
  };

  window.__tkmGuestAudioStop = function () {
    // requestData() first: it forces the buffered tail out as one final chunk, so
    // the last few hundred milliseconds of sound are not thrown away by stop().
    const rec = S.rec;
    if (rec && rec.state !== 'inactive') {
      try { rec.requestData(); } catch (_) {}
      try { rec.stop(); } catch (_) {}
    }
    if (S.stream) {
      // Stopping the track is what actually ends the source; without it Chromium
      // keeps the capture alive and the renderer process never goes idle.
      try { S.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      S.stream = null;
    }
    return { ok: true, startedAt: S.startedAt };
  };

  return true;
})()`;

/** Promise race against a wall-clock cap. Never rejects, never leaks a timer. */
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve(promise).then((v) => v, () => fallback), guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Answers the capture window's getDisplayMedia with the GUEST's audio track.
 *
 * `{ audio: <WebFrameMain>, enableLocalEcho: true }` is the whole point: the audio
 * handed over is what that frame is actually playing, i.e. post-buffer, post-
 * player-delay — the same signal the screen capture is filming.
 *
 * `enableLocalEcho: true` means "do not mute the source while capturing it", so the
 * user keeps hearing the room. It does NOT mean the captured stream is played
 * back anywhere: nothing in the capture page ever attaches it to an <audio> or
 * <video> element, so there is no second copy of the sound to echo. With the flag
 * left at its default the guest would go SILENT in the speakers for the whole
 * recording, which is the far worse outcome.
 *
 * Deliberately NOT `loopback`: capturing the system mix is exactly the thing this
 * change removes, and it would drag every other sound the machine makes into the
 * recording. If the guest is gone there is nothing correct to substitute, so the
 * request is denied and the caller falls back to the CDN track.
 */
function installGuestAudioCapture() {
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        try {
          // Only the hidden capture window may ask. Without this check any page in
          // the app could pull the live room's audio out of the guest.
          // routingId is only unique per renderer process, so both ids are compared.
          if (
            request &&
            request.frame &&
            guestAudioWindow &&
            !guestAudioWindow.isDestroyed() &&
            (request.frame.routingId !== guestAudioWindow.webContents.mainFrame.routingId ||
              request.frame.processId !== guestAudioWindow.webContents.mainFrame.processId)
          ) {
            callback({});
            return;
          }
          const guest = feedGuestId ? webContents.fromId(Number(feedGuestId)) : null;
          if (!guest || guest.isDestroyed()) {
            console.warn('[guestAudio] запрос захвата без гостя — звук гостя недоступен');
            callback({});
            return;
          }
          callback({ audio: guest.mainFrame, enableLocalEcho: true });
        } catch (e) {
          console.warn('[guestAudio] обработчик захвата упал:', e && (e.message || e));
          try {
            callback({});
          } catch (_) {}
        }
      },
      { useSystemPicker: false }
    );
  } catch (e) {
    console.warn('[guestAudio] setDisplayMediaRequestHandler недоступен:', e && (e.message || e));
  }
}

/**
 * The hidden window the capture runs in. Never shown, never focused, never in the
 * taskbar — it exists so that getDisplayMedia has a document to live in.
 *
 * Created on demand rather than at startup: an always-open hidden window would keep
 * the app from quitting (see guestAudioWindow) and would pay a renderer process for
 * recordings that never ask for sound.
 */
function ensureGuestAudioWindow() {
  if (guestAudioWindow && !guestAudioWindow.isDestroyed()) return guestAudioWindowReady;
  try {
    guestAudioWindow = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      backgroundColor: '#000000',
      webPreferences: {
        preload: GUEST_AUDIO_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        // The capture must keep ticking while the app window is in the background,
        // which is exactly what Chromium would otherwise throttle away.
        backgroundThrottling: false,
      },
    });
  } catch (e) {
    console.warn('[guestAudio] окно захвата не создалось:', e && (e.message || e));
    guestAudioWindow = null;
    guestAudioWindowReady = Promise.resolve(null);
    return guestAudioWindowReady;
  }

  // A window created with show:false is never shown, but it still has to be torn
  // down by hand or `window-all-closed` will not fire when the user closes the
  // app window.
  guestAudioWindow.on('closed', () => {
    if (guestAudioWindow && guestAudioWindow.isDestroyed()) guestAudioWindow = null;
  });

  guestAudioWindowReady = new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 5000);
    if (timer.unref) timer.unref();
    guestAudioWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      done(guestAudioWindow && !guestAudioWindow.isDestroyed() ? guestAudioWindow.webContents : null);
    });
    try {
      guestAudioWindow.loadFile(GUEST_AUDIO_PAGE);
    } catch (_) {
      clearTimeout(timer);
      done(null);
    }
  });
  return guestAudioWindowReady;
}

/** Drops the capture window. Safe to call at any time, including twice. */
function destroyGuestAudioWindow() {
  const w = guestAudioWindow;
  guestAudioWindow = null;
  guestAudioWindowReady = null;
  if (!w || w.isDestroyed()) return;
  try {
    w.destroy();
  } catch (_) {}
}

/**
 * Appends one Opus chunk from the capture page to the sidecar, and remembers when
 * the first real byte landed. The file is opened once with 'a' and written with
 * writeSync: chunks arrive every 200 ms and a stream would only add buffering
 * between the recorder and the disk for no benefit.
 */
ipcMain.on('guestAudio:chunks', (e, b64) => {
  const job = guestAudioJob;
  if (!job || job.fd === null) return;
  if (!job.wc || e.sender !== job.wc) return;
  let buf;
  try {
    buf = Buffer.from(typeof b64 === 'string' ? b64 : '', 'base64');
  } catch (_) {
    return;
  }
  if (!buf.length) return;
  try {
    fs.writeSync(job.fd, buf, 0, buf.length);
    job.bytes += buf.length;
    if (!job.firstBytes) {
      job.firstBytes = true;
      try {
        job.resolveFirst(true);
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[guestAudio] запись чанка не удалась:', err && (err.message || err));
  }
});

ipcMain.on('guestAudio:ready', (e, info) => {
  const job = guestAudioJob;
  if (!job || !job.wc || e.sender !== job.wc) return;
  const at = Number(info && info.startedAt);
  if (Number.isFinite(at) && at > 0) job.startedAt = at;
});

ipcMain.on('guestAudio:done', (e, info) => {
  const job = guestAudioJob;
  if (!job || !job.wc || e.sender !== job.wc) return;
  const at = Number(info && info.startedAt);
  if (!job.startedAt && Number.isFinite(at) && at > 0) job.startedAt = at;
  job.stoppedAt = Number(info && info.stoppedAt) || Date.now();
  try {
    job.resolveDone(true);
  } catch (_) {}
});

ipcMain.on('guestAudio:fail', (e, message) => {
  const job = guestAudioJob;
  if (!job || !job.wc || e.sender !== job.wc) return;
  job.error = String(message || 'захват звука не удался');
  try {
    job.resolveDone(false);
  } catch (_) {}
});

// Control surface. main drives these directly from live:start; they are registered
// as handlers so the two channels exist on both sides of the bridge and cannot
// drift apart.
ipcMain.handle('guestAudio:start', (_e, payload) => startGuestAudioCapture(payload || {}));
ipcMain.handle('guestAudio:stop', () => stopGuestAudioCapture());

/**
 * Starts the guest capture into <video base>.guest.webm.
 *
 * Returns `{ ok:true, startedAt }` or `{ ok:false, error }` with plain Russian
 * text — the caller shows it and continues recording regardless. Nothing here
 * throws: a capture failure is a missing soundtrack, not a failed recording.
 */
async function startGuestAudioCapture({ path: file, videoStartedAt } = {}) {
  // Whatever was running must be finished and closed before a new file is opened.
  await stopGuestAudioCapture();

  const target = typeof file === 'string' && file ? file : '';
  // Allowlist, because this function opens a file for APPENDING and the handler
  // below is reachable over IPC: the only path it will ever touch is
  // <downloadDir>/live/<base>.guest.webm, the name live.js generated.
  const liveDir = path.resolve(settings.get().downloadDir || '.', 'live');
  if (
    !path.isAbsolute(target) ||
    path.resolve(path.dirname(target)) !== liveDir ||
    !/\.guest\.webm$/i.test(target)
  ) {
    return { ok: false, error: 'недопустимый путь для файла звука' };
  }
  try {
    fs.mkdirSync(liveDir, { recursive: true });
  } catch (_) {}
  // A stale sidecar from an earlier attempt would be muxed in as if it were this
  // recording's audio.
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (_) {}

  const wc = await ensureGuestAudioWindow();
  if (!wc) {
    destroyGuestAudioWindow();
    return { ok: false, error: 'окно захвата звука не открылось' };
  }

  let fd;
  try {
    fd = fs.openSync(target, 'a');
  } catch (e) {
    destroyGuestAudioWindow();
    return { ok: false, error: `не удалось создать файл звука: ${e.message || e}` };
  }

  // The resolvers are attached to the job AFTER the literal is built. Writing them
  // as properties of that same literal captures the initial no-ops — property
  // values are read in source order, and the Promise constructors that replace the
  // no-ops come later in the object — so the "first bytes" wait below could never
  // be released early and always burned its full timeout.
  let resolveFirst = () => {};
  let resolveDone = () => {};
  const firstBytesPromise = new Promise((r) => {
    resolveFirst = r;
  });
  const donePromise = new Promise((r) => {
    resolveDone = r;
  });
  const job = {
    fd,
    path: target,
    // The absolute wall clock at which MediaRecorder actually began, reported by
    // the page. `videoStartedAt` is the counterpart the shift is computed from.
    startedAt: 0,
    videoStartedAt: Number(videoStartedAt) || 0,
    // Armed when a stop is requested; see stopGuestAudioCapture.
    stopTimer: null,
    bytes: 0,
    firstBytes: false,
    error: null,
    wc,
    resolveFirst,
    resolveDone,
    firstBytesPromise,
    donePromise,
  };
  guestAudioJob = job;

  let started = null;
  try {
    started = await withTimeout(wc.executeJavaScript(GUEST_AUDIO_SOURCE + '\n;__tkmGuestAudioStart();', true), 8000, null);
  } catch (_) {
    started = null;
  }

  // The recording may have been stopped while this function was still waiting on
  // the page. The capture is already gone in that case; saying so beats reporting a
  // success for a stream nobody is holding.
  if (guestAudioJob !== job) {
    return { ok: false, error: 'захват остановлен, пока запускался' };
  }
  if (!started || started.ok !== true) {
    const error = (started && started.error) || job.error || 'страница захвата не ответила';
    await stopGuestAudioCapture();
    return { ok: false, error };
  }
  if (!job.startedAt) job.startedAt = Number(started.startedAt) || Date.now();

  // Give the recorder a moment to produce real output. Silence is not a failure —
  // a room with nothing playing legitimately writes nothing — so the bytes are
  // waited for but NOT required; finalize() decides on the file that results.
  await withTimeout(firstBytesPromise, 5000, false);

  return { ok: true, startedAt: job.startedAt, path: target, bytes: job.bytes };
}

/**
 * Flushes and closes the capture. Idempotent, always closes the fd, and never
 * rejects: it is called from stop(), from quit paths and from the start of the
 * next capture.
 */
function stopGuestAudioCapture() {
  const job = guestAudioJob;
  if (!job) return Promise.resolve({ ok: true, stopped: false });
  if (job.stopPromise) return job.stopPromise;

  job.stopped = true;
  job.stopPromise = (async () => {
    const wc = job.wc;
    // Armed HERE, not at start: the watchdog exists for a page that does not answer
    // the stop, so arming it while the capture is healthy would only ever fire
    // during a recording the user still wants. Destroying the window drops the
    // getDisplayMedia track and kills the renderer; the fd is closed below on every
    // path regardless, so nothing can outlive the function.
    job.stopTimer = setTimeout(() => {
      if (guestAudioJob === job) {
        console.warn('[guestAudio] страница не ответила на остановку — окно уничтожено');
        destroyGuestAudioWindow();
      }
    }, 4000);
    if (job.stopTimer.unref) job.stopTimer.unref();
    try {
      if (wc && !wc.isDestroyed()) {
        await withTimeout(
          wc.executeJavaScript('(window.__tkmGuestAudioStop ? window.__tkmGuestAudioStop() : null)', true),
          2000,
          null
        );
      }
    } catch (_) {}
    // Wait for MediaRecorder's `stop` so the final ondataavailable chunk is written
    // BEFORE the fd is closed. Capped: a wedged recorder must not hold the file.
    await withTimeout(job.donePromise, 2500, false);
    try {
      if (job.fd !== null) {
        fs.closeSync(job.fd);
      }
    } catch (_) {}
    job.fd = null;
    if (job.stopTimer) {
      clearTimeout(job.stopTimer);
      job.stopTimer = null;
    }
    destroyGuestAudioWindow();
    const result = { ok: true, path: job.path, startedAt: job.startedAt, bytes: job.bytes, error: job.error };
    if (guestAudioJob === job) guestAudioJob = null;
    return result;
  })()
    // Several callers fire this without awaiting (stop, quit, the reap backstop in
    // live). An escaping rejection there would be an unhandledRejection in the main
    // process, which Electron surfaces as a modal "A JavaScript error occurred" over
    // the user's recording — so it cannot be allowed to escape.
    .catch((e) => {
      console.warn('[guestAudio] остановка упала:', e && (e.message || e));
      return { ok: false, path: job.path, startedAt: job.startedAt, bytes: job.bytes, error: job.error };
    });
  return job.stopPromise;
}

// Start a recording.
//
// The room the renderer holds was resolved when the user pressed «Запись
// трансляции», which may have been minutes ago, and the CDN URLs inside it are
// SIGNED — they go stale. So the handle is re-resolved here, immediately before
// ffmpeg is spawned, and the fresh descriptor is what gets recorded. Without
// this the capture either fails outright or, worse, silently records an empty
// file from an expired URL.
//
// The re-resolve is also the trust boundary: everything ffmpeg is about to
// fetch comes from main's own response, never from the renderer's copy.
ipcMain.handle('live:start', async (_e, room, opts = {}) => {
  if (!room || typeof room.handle !== 'string' || !room.handle) {
    return { ok: false, error: 'Эфир не определён. Нажмите «Запись трансляции» ещё раз.' };
  }
  const s = settings.get();
  const withChat = opts && opts.withChat === true;
  // Sound defaults to ON. A screen recording with no sound is rarely what
  // anyone wants, and because the audio lives in its own process its failure can
  // only ever downgrade the result to silence — never fail the recording. Stream
  // mode ignores this entirely: the CDN stream carries its own audio.
  const withAudio = !opts || opts.withAudio !== false;
  // 'stream' (default) records the clean CDN stream; 'screen' records the page
  // pixels via guest capturePage(), with the CDN stream as audio-only.
  const mode = opts && opts.mode === 'screen' ? 'screen' : 'stream';

  // A runaway set of parallel captures would spawn an unbounded number of
  // ffmpeg processes; three is well past what any user records at once.
  if (live.status().running >= 3) {
    return { ok: false, error: 'Уже идёт 3 записи. Остановите одну из них перед началом новой.' };
  }
  // Screen captures are CPU-heavy (capturePage + x264 on every tick):
  // at most one at a time, independent of the stream cap.
  //
  // The counter alone is not enough any more. startScreen() is async and takes its
  // first capturePage() — which can take seconds — BEFORE it registers itself in
  // live's `running` map, so two fast clicks both used to sail past this check and
  // start two screen recordings. The in-flight counter covers that window; it is
  // released in a finally below whatever the outcome.
  if (mode === 'screen' && live.list().some((j) => j && j.mode === 'screen')) {
    return { ok: false, error: 'Экранная запись уже идёт. Остановите её перед началом новой.' };
  }

  let resolved = null;
  let fresh = null;
  try {
    fresh = await live.resolve(room.pageUrl || `@${room.handle}`, s);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  resolved = fresh && fresh.ok ? fresh.room : null;
  if (!resolved) {
    const resolveError = (fresh && fresh.error) || 'Не удалось обновить данные эфира.';
    if (mode !== 'screen') {
      return { ok: false, error: resolveError };
    }
    // Screen mode records page PIXELS, so a missing CDN stream is not fatal —
    // but the room identity still is (roomId routes the chat, pageUrl names the
    // room). Offline/restricted rooms stay hard failures: recording a dead page
    // is pointless. Anything else (e.g. "no streams") degrades to silent pixels.
    if ((fresh && (fresh.offline || fresh.restricted)) || !room.handle) {
      return { ok: false, error: resolveError };
    }
    resolved = {
      roomId: String(room.roomId || ''),
      handle: room.handle,
      title: room.title || '',
      cover: '',
      viewers: 0,
      startedAt: 0,
      pageUrl: room.pageUrl || ('https://www.tiktok.com/@' + room.handle + '/live'),
      streams: [],
    };
  }

  // A counter, not a bare timestamp: two starts inside the same millisecond
  // would reuse an id, the second Map.set would overwrite the first, and
  // stop(id) would then kill the wrong process while the first leaks.
  const jobId = `live_${Date.now()}_${++liveJobSeq}`;

  // Chat files sit next to the video under the same base name, so
  // <handle>_<stamp>.mp4 / .chat.jsonl / .chat.srt travel together.
  let chat = null;
  let chatPoll = null;
  const finishChat = () => {
    chatPoll = clearDomTimer(chatPoll);
    stopChatTapStats();
    if (!chat) return null;
    const roomId = chat.roomId;
    const res = livechat.close(roomId);
    chat = null;
    liveChatEmitAt.delete(roomId);
    return res;
  };

  // Screen mode sources: the guest page for pixels, the best CDN URL (if any)
  // for the AUDIO track only. The room was re-resolved above, so the URL is
  // fresh and comes from main's own response, never the renderer's copy.
  let screenGuest = null;
  let screenAudioUrl = null;
  if (mode === 'screen') {
    const candidates = Array.isArray(resolved.streams) ? resolved.streams : [];
    const https = candidates.filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url));
    // FLV first, HLS only as a fallback. The audio process is a plain
    // `ffmpeg -i <url> -vn -c:a aac -f adts`, and an FLV feed needs no demuxer
    // gymnastics; HLS would also drag a segment playlist into a process that is
    // supposed to be as dumb and as unbreakable as possible.
    screenAudioUrl = (https.find((x) => x.kind === 'flv') || https[0] || {}).url || null;
    try {
      const wc = webContents.fromId(Number(feedGuestId));
      screenGuest = wc && !wc.isDestroyed() ? wc : null;
    } catch (_) {
      screenGuest = null;
    }
    if (!screenGuest) {
      return { ok: false, error: 'Встроенный браузер не открыт. Откройте эфир во вкладке «Обзор».' };
    }
  }

  let started;
  // The in-flight guard for the exact vulnerable window. startScreen() is async
  // and takes its first capturePage() — which can take seconds — BEFORE it
  // registers itself in live's `running` map, so `live.list()` above cannot see it
  // yet and two fast clicks both used to start two screen recordings. The flag is
  // taken here, immediately before the call, and released in the finally below, so
  // every early return above leaves no state behind.
  const screenSlot = mode === 'screen';
  if (screenSlot) liveScreenStarting += 1;
  try {
    const liveCallbacks = {
      onProgress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('live:progress', p);
      },
      onDone: (r) => {
        r.chat = finishChat();
        if (win && !win.isDestroyed()) win.webContents.send('live:done', r);
      },
      onError: (message) => {
        finishChat();
        if (win && !win.isDestroyed()) win.webContents.send('live:error', { id: jobId, message });
      },
    };
    started =
      mode === 'screen'
        ? await live.startScreen(jobId, resolved, s, {
            guest: screenGuest,
            // Sound for screen mode comes from a SECOND, independent ffmpeg
            // that demuxes audio only, and is merged into the finished video
            // afterwards. It deliberately is not a second input of the video
            // process: measured on a live room, that made ffmpeg block forever
            // in the probe of the signed CDN URL — 197 frames captured, zero
            // written, file stuck at the 36-byte container header. Splitting the
            // processes means a dead or 403ing audio stream can no longer take
            // the video down with it; the worst case is a silent recording.
            // Stream mode ("Поток") is unaffected: there the CDN URL is the only
            // input and sound comes along for free.
            audioUrl: withAudio ? screenAudioUrl : null,
            // Not a target but a ceiling: the real rate is whatever the compositor
            // produces, capped at the frame interval (1/fps). See screenFfmpegArgs.
            fps: 25,
            quality: 70,
            // The dock's manual A/V correction, in seconds. It is applied when the
            // recording is muxed, so the user can change it while recording runs.
            avShift: Number(opts && opts.avShift) || 0,
            ...liveCallbacks,
          })
        : live.start(jobId, resolved, s, liveCallbacks);
  } catch (e) {
    return { ok: false, error: `Не удалось запустить запись: ${e.message || e}` };
  } finally {
    if (screenSlot) liveScreenStarting = Math.max(0, liveScreenStarting - 1);
  }
  if (!started || started.error) {
    return { ok: false, error: (started && started.error) || 'Не удалось запустить запись.' };
  }

  // ---- screen mode: the sound comes out of the browser, after the player's ----
  // ---- own buffers, so it is in sync with the picture by construction. -------
  //
  // Started AFTER startScreen(), i.e. after the video ffmpeg is already running
  // and taking frames: the recording must never wait on the capture. The video's
  // own start stamp is handed over here and comes back with the audio's, and the
  // difference of the two is the only shift the final mux applies (see
  // screenGuestMuxArgs in live.js).
  let guestAudioOk = false;
  if (mode === 'screen' && withAudio && started.guestAudioPath) {
    try {
      const res = await startGuestAudioCapture({
        path: started.guestAudioPath,
        videoStartedAt: started.startedAt,
      });
      guestAudioOk = Boolean(res && res.ok);
      // The recording can end while the capture was still starting — a stall
      // watchdog, a manual stop, a crash. finalize() has then already run and
      // deleted the sidecar, so there is nothing left to attach to and nothing
      // left to stop.
      const stillRunning = live.list().some((j) => j && j.id === jobId);
      if (guestAudioOk && stillRunning) {
        // live owns the ORDER of shutdown: it must not mux (and then delete) the
        // sidecar while the recorder is still appending to it, so hand it the
        // stopper it calls from stop() and from its video-close handler.
        try {
          live.attachGuestAudio(jobId, {
            stop: () => {
              stopGuestAudioCapture();
            },
            startedAt: res.startedAt,
            videoStartedAt: started.startedAt,
          });
        } catch (_) {}
      } else if (guestAudioOk) {
        guestAudioOk = false;
        stopGuestAudioCapture();
      }
      if (!guestAudioOk) {
        // NOT fatal. The frame loop is already running; say what happened and fall
        // back to the CDN track.
        try {
          live.jobNote(jobId, `гостевой звук недоступен: ${(res && res.error) || 'запись уже остановлена'} — запись без звука из плеера`);
        } catch (_) {}
      }
    } catch (e) {
      try {
        live.jobNote(jobId, `гостевой звук не запустился: ${e.message || e} — запись без звука из плеера`);
      } catch (_) {}
    }
  }

  if (withChat && resolved.roomId) {
    // Prime the DOM fallback collector (idempotent no-op if already armed).
    try {
      feed.runInGuest(feed.CHAT_WATCH_SCRIPT).catch(() => {});
    } catch (_) {}
    // Make sure the WebSocket tap is in place before the room's socket opens,
    // and start the slow counter poll that proves it is actually running.
    startChatTapStats();
    // Single guarded ~1s drain timer for this chat session; cleared in
    // finishChat() and on app teardown. runInGuest never throws, pollDomChat
    // never throws — a dead guest just yields empty drains.
    const domRoomId = String(resolved.roomId || '');
    chatPoll = clearDomTimer(chatPoll);
    chatPoll = trackDomTimer(
      setInterval(() => {
        pollDomChat(domRoomId).catch(() => {});
      }, 1000)
    );
    if (chatPoll && chatPoll.unref) chatPoll.unref();
    try {
      chat = livechat.open(
        {
          dir: path.dirname(started.path),
          baseName: path.basename(started.path, '.mp4'),
          roomId: resolved.roomId,
          handle: resolved.handle,
        },
        // Anchors the subtitle timeline to the video, not to the first message.
        started.startedAt || Date.now()
      );
    } catch (_) {
      chat = null;
    }
    // No sink, no session: do not poll a chat nobody writes to.
    if (!chat) chatPoll = clearDomTimer(chatPoll);
  }

  return {
    ok: true,
    id: jobId,
    path: started.path,
    mode,
    room: resolved,
withChat: Boolean(chat),
    // What was actually requested, not what happened — the recording may still
    // come out silent, which is only knowable after the mux. Screen mode counts
    // EITHER audio source: the browser capture is preferred, the CDN process is
    // kept running as the fallback finalize() falls back to.
    withAudio: mode === 'screen' ? withAudio && (guestAudioOk || Boolean(started.audioUrl)) : mode !== 'screen',
    // Which of the two actually took. Diagnostic only — nothing in the renderer
    // reads it, and no renderer change was made for this feature.
    guestAudio: mode === 'screen' ? guestAudioOk : false,
  };
});

// ============================================================================
// Live chat, source A: the guest's own webcast WebSocket.
//
// WHY THE TAP LIVES HERE AND NOT IN THE PRELOAD. It used to live in
// src/preload/webview-preload.js and was 100% dead — three independent causes,
// all measured on the real Electron 33.4.11, each fatal on its own:
//
//   1. Its primary installer was contextBridge.executeInMainWorld(...). That API
//      DOES NOT EXIST in Electron 33 (zero hits in electron.d.ts), so the guard
//      silently fell through to the legacy inline-<script> path.
//   2. tiktok.com's CSP has no 'unsafe-inline' in script-src, and appendChild()
//      on a blocked inline script does NOT throw — it never runs. Injection
//      "succeeded", the page was untouched, and the only symptom was one
//      armed:false warning.
//   3. Even installed it would have carried nothing: window.postMessage() from
//      the MAIN world does NOT reach a 'message' listener in the ISOLATED world
//      (proven with a live harness — the preload received nothing).
//
// What does work, measured on the same build:
//   * webContents.executeJavaScript(code, true) called from MAIN lands in the
//     MAIN world and is not subject to the page's CSP  -> installs the tap;
//   * contextBridge.exposeInMainWorld is the only hop Electron 33 actually
//     delivers between the two worlds -> __tkmChat in webview-preload.js.
//   (webFrame.executeJavaScript / executeJavaScriptInIsolatedWorld called from
//   a preload land in the ISOLATED world, invisible to page scripts — not used.)
//
// Deliberately NOT done: nothing is sent on the socket. The page already acks
// and heartbeats, and a duplicate gets the stream dropped with
// `1000 payload_handler_hb`.
// ============================================================================

/**
 * The tap itself. Runs in the guest's MAIN world, which is why it is a function
 * rather than an IPC handler: webContents.executeJavaScript below ships it to the
 * page as SOURCE TEXT (Function.prototype.toString), so it must be completely
 * self-contained. Referencing any variable from this module would throw a
 * ReferenceError inside the page, where nothing here could catch it.
 *
 * Writes only window.__tkmChatTap and window.__tkmChatStats; the only thing it
 * ever calls is the preload's contextBridge object. Every error path swallows,
 * because a chat bug must never break the page it is watching.
 */
function chatTapMainWorld() {
  try {
    // Idempotent. An SPA route change keeps the same window (and therefore the
    // same wrapper), so reinstalling here would wrap the wrapper and deliver
    // every frame twice. A full navigation gets a fresh window, where the flag
    // is naturally absent again.
    if (window.__tkmChatTap === true) return 'already';
  } catch (_) {
    return 'blocked';
  }

  var Orig = null;
  try {
    Orig = window.WebSocket;
  } catch (_) {
    return 'no-websocket';
  }
  if (typeof Orig !== 'function') return 'no-websocket';

  var URL_RE = /webcast/i; // TikTok chat lives on wss://…/webcast/im/push/v2/
  var FLUSH_MS = 250; // a log timestamped by the server does not notice
  var MAX_BATCH = 64; // one IPC hop per 64 frames, not per frame
  var MAX_FRAME = 512 * 1024; // a chat frame is KBs; this is backpressure
  var QUEUE_MAX = 256; // never let a missing bridge grow this without bound
  var BRIDGE_TRIES = 40; // ~10 s of retries for the preload's contextBridge

  // Bookkeeping for every socket the page opens, not just the chat one: a room
  // where `matched` is 0 is a different failure from a room where `frames` is 0,
  // and "the .chat.jsonl is empty" cannot tell them apart. Read back from main
  // with executeJavaScript('window.__tkmChatStats').
  var stats = { total: 0, matched: 0, messages: 0, frames: 0, dropped: 0, installedAt: Date.now() };
  try {
    window.__tkmChatStats = stats;
  } catch (_) {}

  var queue = [];
  var timer = null;
  var bridgeTries = BRIDGE_TRIES;

  // Re-read the bridge on every flush instead of caching it. The tap installs
  // from dom-ready, which on a cold navigation can run BEFORE the guest
  // preload's exposeInMainWorld call lands; caching a null there is exactly how
  // a perfectly good tap ends up recording nothing for a whole session.
  var bridge = function () {
    try {
      var b = window.__tkmChat;
      return b && typeof b.post === 'function' ? b : null;
    } catch (_) {
      return null;
    }
  };

  var schedule = function () {
    if (timer || !queue.length) return;
    try {
      timer = setTimeout(flush, FLUSH_MS);
    } catch (_) {
      timer = null;
    }
  };

  var flush = function () {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return 0;
    var b = bridge();
    if (!b) {
      // The preload has not run yet: KEEP the frames and try again. Dropping
      // them is how a tap that installed a moment too early looks broken.
      if (bridgeTries-- > 0) schedule();
      else queue.length = 0;
      return 0;
    }
    var batch = queue.splice(0, queue.length);
    try {
      b.post(batch);
    } catch (_) {
      /* a chat bug must never break the page */
    }
    return batch.length;
  };

  var push = function (buf) {
    try {
      // Duck-typed rather than `instanceof ArrayBuffer`: a Blob that came back
      // through arrayBuffer() is a same-realm buffer here, but a page that hands
      // us a view or a cross-realm buffer would otherwise vanish silently.
      if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength === 0) {
        stats.dropped += 1;
        return;
      }
      if (buf.byteLength > MAX_FRAME) {
        stats.dropped += 1;
        return;
      }
      queue.push(buf);
      stats.frames += 1;
      if (queue.length >= MAX_BATCH) flush();
      else schedule();
      while (queue.length > QUEUE_MAX) {
        queue.shift();
        stats.dropped += 1;
      }
    } catch (_) {
      /* never let capture break the page */
    }
  };

  function Tap(url, protocols) {
    // The spec allows calling the constructor without `new`; behave like the
    // real one instead of throwing on `this`.
    if (!(this instanceof Tap)) return new Tap(url, protocols);
    var ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    var isChat = false;
    try {
      stats.total += 1;
      isChat = URL_RE.test(String(url));
      if (isChat) stats.matched += 1;
    } catch (_) {}
    // Everything else is left strictly alone: no listener, no timer, no property
    // writes on a socket the chat does not ride.
    if (!isChat) return ws;

    // binaryType: 'arraybuffer' is what makes a frame cheap to hand across the
    // contextBridge, but the page's own decoder may expect Blob — so its choice
    // always wins. "The caller set one" is not observable at construction time
    // (the default is already 'blob', and the caller has not run yet), so the
    // instance gets a binaryType setter for one turn: any assignment made after
    // `new WebSocket(…)` returns is recorded, and only an untouched socket is
    // upgraded. The page still reads and writes the real value either way, and
    // both payload shapes are handled below regardless.
    var initial = null;
    var callerSet = false;
    try {
      initial = ws.binaryType;
    } catch (_) {}
    try {
      var current = initial;
      Object.defineProperty(ws, 'binaryType', {
        configurable: true,
        enumerable: true,
        get: function () {
          return current;
        },
        set: function (v) {
          callerSet = true;
          current = v;
        },
      });
    } catch (_) {
      // No interceptor: fall back to "did it differ from what we saw".
      callerSet = null;
    }
    try {
      setTimeout(function () {
        try {
          if (callerSet === null ? ws.binaryType === initial : !callerSet) ws.binaryType = 'arraybuffer';
        } catch (_) {}
      }, 0);
    } catch (_) {}

    try {
      ws.addEventListener('message', function (ev) {
        try {
          stats.messages += 1;
          var data = ev ? ev.data : null;
          // Text frames are pongs and acks — no chat in them, and forwarding
          // them would hand the decoder a payload it must reject.
          if (typeof data === 'string') return;
          if (data instanceof ArrayBuffer) return push(data);
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            data.arrayBuffer().then(push, function () {});
          }
        } catch (_) {
          /* never let capture break the page */
        }
      });
    } catch (_) {}
    return ws;
  }

  // `new Tap(...)` returns the real socket object, so instanceof and prototype
  // chains are untouched; sharing the prototype explicitly keeps that true for
  // libraries that compare constructors.
  Tap.prototype = Orig.prototype;
  // WebSocket.CONNECTING/OPEN/CLOSING/CLOSED are read off the constructor by
  // more than a few libraries, so `new WebSocket()` must stay indistinguishable.
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
  try {
    window.__tkmChatTap = true;
  } catch (_) {
    // Without the flag a re-install would wrap this wrapper. Undo the wrap
    // rather than risk every frame arriving twice.
    try {
      window.WebSocket = Orig;
    } catch (_) {}
    return 'frozen';
  }
  return 'installed';
}

// Shipped to the page as source text, because executeJavaScript is the only
// channel that reaches the MAIN world without the page's CSP getting a vote.
const CHAT_TAP_SOURCE = `(${chatTapMainWorld.toString()})()`;

// Per-guest install bookkeeping, keyed by webContents id: id -> { url, result }.
// Deduplicating on the URL is what keeps this from running executeJavaScript
// dozens of times per navigation — dom-ready, did-navigate-in-page and
// did-stop-loading all fire for a single load, and the SPA fires them again on
// every route change.
const chatTaps = new Map();

/**
 * Installs the tap in a guest's main world. Never throws: a chat failure must
 * not take down a recording that is otherwise fine, and the DOM fallback keeps
 * writing chat files either way.
 */
async function installChatTap(wc, urlHint = null) {
  try {
    if (!wc || wc.isDestroyed()) return false;
    let url = urlHint;
    if (url === null || url === undefined) url = String(wc.getURL() || '');
    const prev = chatTaps.get(wc.id);
    if (prev && prev.url === url && (prev.result === 'installed' || prev.result === 'already')) return true;

    let result = '';
    try {
      // userGesture is irrelevant here; what matters is that this runs in the
      // MAIN world and is exempt from the page's CSP.
      result = String(await wc.executeJavaScript(CHAT_TAP_SOURCE, true));
    } catch (e) {
      result = 'error';
      console.warn('[live-chat] tap install failed:', (e && e.message) || e);
    }
    chatTaps.set(wc.id, { url, result });
    return result === 'installed' || result === 'already';
  } catch (_) {
    return false;
  }
}

/** installChatTap against the registered feed guest, if there is one. */
function installChatTapForGuest() {
  try {
    return installChatTap(webContents.fromId(Number(feedGuestId)));
  } catch (_) {
    return false;
  }
}

// The diagnostic that tells us whether the tap is alive on a real live room.
// Read once per recording: an empty .chat.jsonl is ambiguous (quiet room vs.
// dead tap), while these counters are not.
const CHAT_TAP_STATS_MS = 5000;
let chatTapStats = null;
let chatTapStatsTimer = null;

async function readChatTapStats() {
  try {
    const wc = webContents.fromId(Number(feedGuestId));
    if (!wc || wc.isDestroyed()) return null;
    return await wc.executeJavaScript('window.__tkmChatStats || null', true);
  } catch (_) {
    return null;
  }
}

function startChatTapStats() {
  installChatTapForGuest();
  if (chatTapStatsTimer) return;
  const tick = () => {
    readChatTapStats().then((stats) => {
      if (!stats) return;
      const first = !chatTapStats;
      chatTapStats = stats;
      if (first) console.warn('[live-chat] tap stats:', JSON.stringify(stats));
    });
  };
  chatTapStatsTimer = trackDomTimer(setInterval(tick, CHAT_TAP_STATS_MS));
  if (chatTapStatsTimer && chatTapStatsTimer.unref) chatTapStatsTimer.unref();
}

function stopChatTapStats() {
  chatTapStatsTimer = clearDomTimer(chatTapStatsTimer);
  chatTapStats = null;
}

// Last-known tap counters, for the renderer's dev console and for diagnosing a
// recording whose chat file came out empty.
ipcMain.handle('live:wsStats', () => ({ stats: chatTapStats }));

// ---------- live chat plumbing ----------
//
// Two sources feed one ChatSink per recording:
//
//  1. the guest's own webcast WebSocket — tapped by chatTapMainWorld() above,
//     which main installs into the MAIN world and which hands frames over via
//     the guest preload's `__tkmChat` contextBridge hop (channel
//     `live:wsFrames`) — complete, with server-side msgId and createTime;
//  2. the chat column rendered in the page, drained once a second by
//     `pollDomChat` — best effort, used when the tap cannot install or the
//     socket is not there.
//
// Both write into the same sink, so they de-duplicate against each other: a
// text seen on the socket within DOM_DEDUP_MS is dropped when it next shows up
// in a DOM drain.
const DOM_DEDUP_MS = 10000;
const CHAT_EMIT_MS = 1000;
let chatPoll = null;
const domPollTimers = new Set();
const recentChatTexts = new Map();

function trackDomTimer(t) {
  if (t) domPollTimers.add(t);
  return t;
}

/** Returns null so call sites can write `poll = clearDomTimer(poll)`. */
function clearDomTimer(t) {
  if (t) {
    clearInterval(t);
    domPollTimers.delete(t);
  }
  return null;
}

/** Called from window-all-closed / before-quit; a live interval keeps main up. */
function stopAllDomPolls() {
  for (const t of domPollTimers) {
    try {
      clearInterval(t);
    } catch (_) {
      /* already gone */
    }
  }
  domPollTimers.clear();
  chatPoll = null;
  chatTapStatsTimer = null;
  chatTapStats = null;
  recentChatTexts.clear();
}

function noteChatText(text) {
  const key = String(text || '').trim();
  if (!key) return;
  const now = Date.now();
  for (const [k, at] of recentChatTexts) {
    if (now - at > DOM_DEDUP_MS) recentChatTexts.delete(k);
  }
  recentChatTexts.set(key, now);
}

function seenChatText(text) {
  const key = String(text || '').trim();
  if (!key) return false;
  const at = recentChatTexts.get(key);
  return at !== undefined && Date.now() - at <= DOM_DEDUP_MS;
}

/** Throttled per room: the row shows a live count, four updates a second is noise. */
function emitChatCount(roomId) {
  const key = String(roomId || '');
  if (!key || !win || win.isDestroyed()) return;
  const now = Date.now();
  if (now - (liveChatEmitAt.get(key) || 0) < CHAT_EMIT_MS) return;
  liveChatEmitAt.set(key, now);
  const sink = livechat.status().find((s) => livechat.sameRoom(s.roomId, key));
  if (!sink) return;
  win.webContents.send('live:chat', {
    roomId: key,
    handle: sink.handle || '',
    count: sink.count || 0,
  });
}

/**
 * One drain of the page's chat column. Never throws: `runInGuest` resolves to
 * { ok:false } on every failure, and a dead guest just yields no rows. Anything
 * the socket already reported in the last DOM_DEDUP_MS is dropped so the two
 * sources do not double-write the same message.
 */
async function pollDomChat(roomId) {
  const res = await feed.runInGuest(feed.CHAT_DRAIN_SCRIPT, { timeout: 8000 });
  if (!res || !res.ok || !Array.isArray(res.value) || !res.value.length) return;
  const out = [];
  for (const row of res.value) {
    const text = String((row && row.text) || '').trim();
    if (!text) continue;
    if (seenChatText(text)) continue;
    // The page gives us no server timestamp, so a sane one is used when it is
    // there and local time otherwise.
    const raw = Number(row && row.time);
    const t = raw > 0 && raw < 4e12 ? raw : Date.now();
    const author = String((row && row.author) || '').trim();
    out.push({
      roomId: String(roomId || ''),
      msgId: '',
      t,
      displayId: author,
      nickname: author,
      content: text,
    });
  }
  if (!out.length) return;
  livechat.route(out);
  emitChatCount(String(roomId || ''));
}

// Live chat arrives from the guest webview as raw WebSocket frames (see
// chatTapMainWorld above and the `__tkmChat` hop in src/preload/webview-preload.js).
// They are decoded here because the decoder needs zlib and Buffer, neither of
// which the sandboxed preload can do cheaply, and because this is where the
// room-to-recording mapping lives.
//
// The transport is a `send`, not an `invoke`: up to four times a second and
// nobody waits on a reply. It arrives here directly from the guest preload's
// `__tkmChat` bridge — a guest preload is an ordinary renderer, so the batch
// lands on ipcMain without the app window relaying anything.
let liveChatEmitAt = new Map();
function handleWsFrames(frames) {
  if (!Array.isArray(frames) || !frames.length) return;
  let messages = [];
  for (const buf of frames) {
    try {
      // A frame crosses the contextBridge hop and then one IPC hop (contextBridge
      // clone → ipcRenderer.send), and can arrive as a plain ArrayBuffer or Uint8Array.
      // eachField() calls
      // readUInt32LE / readBigUInt64LE, which throw on those and would make the
      // decode return [] — the fixed-width branches are exactly where a chat
      // frame's numbers live.
      const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf && (buf.buffer || buf), buf ? (buf.byteOffset || 0) : 0, buf ? (buf.byteLength || 0) : 0);
      if (!raw.length) continue;
      for (const m of livechat.decodeFrame(raw)) messages.push(m);
    } catch (_) {
      /* one malformed frame must not drop the rest of the batch */
    }
  }
  if (!messages.length) return;
  // Remember socket texts so the DOM fallback does not duplicate them.
  for (const m of messages) {
    if (m && m.content) noteChatText(m.content);
  }
  livechat.route(messages);

  // Keyed per room, not off messages[0]: one batch can span two rooms when two
  // streams are captured at once, and the other counter would never move.
  const roomIds = new Set(messages.map((m) => m.roomId).filter(Boolean));
  for (const roomId of roomIds) emitChatCount(roomId);
}
ipcMain.on('live:wsFrames', (_e, frames) => handleWsFrames(frames));

ipcMain.handle('live:stop', (_e, id) => {
  const r = live.stop(id, 'Остановлено вручную.');
  // live.stop() already asks the capture to stop through the stopper it was given
  // at start, but that hook only exists if the capture actually started. Calling it
  // again is free — stopGuestAudioCapture() is idempotent — and it is the only
  // thing guaranteeing the open file handle is closed on this path.
  if (r) stopGuestAudioCapture();
  return r;
});
ipcMain.handle('live:stopAll', () => {
  const stopped = live.stopAll('Остановлено вручную.');
  stopGuestAudioCapture();
  return { stopped };
});
ipcMain.handle('live:status', () => live.status());

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

// Interface scale. Deliberately applied to the app window only: the <webview>
// guest is a separate WebContents with its own zoom controller, and Chromium's
// HostZoomMap is keyed per origin (file:// here, https://www.tiktok.com there),
// so shrinking the UI to fit more settings on screen never makes the TikTok page
// blurry or unreadable.
//
// ZOOM_MIN/ZOOM_MAX are duplicated in src/renderer/renderer.js. The clamp here is
// the authoritative one: a value outside the range coming from the renderer is
// clamped here, not trusted.
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.6;
ipcMain.handle('ui:zoom', (_e, factor) => {
  const f = Number(factor);
  if (!Number.isFinite(f) || !win || win.isDestroyed()) return null;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(f * 100) / 100));
  win.webContents.setZoomFactor(clamped);
  return clamped;
});
