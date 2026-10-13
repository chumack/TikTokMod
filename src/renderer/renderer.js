'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  settings: null,
  jobs: new Map(), // id -> { id, title, url, status, percent, element, path }
  webview: null,
  current: null, // last probed info
  authorItems: [],
  zoom: 1, // interface scale, 0.6..1.6 — see setZoom()
};

// ---------- utils ----------

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = 'toast'), 4200);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

async function clipboardRead() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    // fallback for contexts without clipboard-read permission
    const el = document.createElement('textarea');
    el.value = '';
    document.body.appendChild(el);
    el.focus();
    let text = '';
    try {
      text = window.prompt('Вставьте ссылку:');
    } finally {
      el.remove();
    }
    return text || '';
  }
}

// ---------- tabs ----------

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
  if (btn.dataset.view === 'browser' && !state.webview) mountWebview();
});

// ---------- ui scale ----------
// The settings and geo panels are taller than the window on a 1280x840 screen.
// Scrolling already makes them reachable; this makes them FIT by scaling the app
// chrome. The scale is applied in the main process to the app window only, so
// the TikTok <webview> guest keeps its own 100% zoom.

const ZOOM_STEP = 0.1;
const ZOOM_KEY = 'tkm.uiZoom';
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.6;

const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100));

// Media queries see ZOOMED css pixels, so at 130% a 1280px window reports ~984px
// and a "wide" layout keyed off a media query would switch itself OFF exactly
// when the user asked to fit more on screen. Decide from the physical width.
const WIDE_MIN_PX = 1040;
function syncWideLayout() {
  const physical = Math.round(window.innerWidth * state.zoom);
  $('#view-settings').classList.toggle('is-wide', physical >= WIDE_MIN_PX);
}

let zoomSaveTimer = null;
function persistZoom(f) {
  // Trailing-edge debounce: a Ctrl+wheel burst fires ~10 of these per gesture,
  // so push the deadline out and write the LAST value. An early `return` here
  // would be a leading-edge throttle and would persist the first value of the
  // burst — zoom to 160%, restart, land at 110%.
  if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => {
    zoomSaveTimer = null;
    try {
      localStorage.setItem(ZOOM_KEY, String(f));
    } catch (_) {}
  }, 250);
}

// state.zoom is advanced SYNCHRONOUSLY, before the IPC round-trip. A trackpad
// Ctrl+wheel burst emits one event per frame (~16ms) — several of them land
// inside a single round-trip, and computing from an await-ed state.zoom would
// collapse them all into one step.
function setZoom(target) {
  const f = clampZoom(Number(target) || 1);
  state.zoom = f;
  $('#zoomResetBtn').textContent = `${Math.round(f * 100)}%`;
  syncWideLayout();
  persistZoom(f);
  // Never let a failed zoom call reject into boot(): an exception here would
  // abort the rest of boot() and leave the app with no listeners at all.
  Promise.resolve()
    .then(() => window.api.ui.zoom(f))
    .catch(() => {});
}

const nudgeZoom = (delta) => setZoom(state.zoom + delta);

$('#zoomInBtn').addEventListener('click', () => nudgeZoom(ZOOM_STEP));
$('#zoomOutBtn').addEventListener('click', () => nudgeZoom(-ZOOM_STEP));
$('#zoomResetBtn').addEventListener('click', () => setZoom(1));

// Capture phase: any element calling stopPropagation() on wheel would otherwise
// silently disable Ctrl+wheel.
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    nudgeZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  },
  { passive: false, capture: true }
);

window.addEventListener('resize', syncWideLayout);

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
    return;
  }
  const k = e.key;
  if (k === '=' || k === '+') nudgeZoom(ZOOM_STEP);
  else if (k === '-' || k === '_') nudgeZoom(-ZOOM_STEP);
  else if (k === '0') setZoom(1);
  else return;
  e.preventDefault();
});

// ---------- engine status ----------

async function refreshEngineStatus() {
  const [status, version] = await Promise.all([window.api.yt.status(), window.api.yt.version()]);
  $('#engineStatus').textContent =
    `yt-dlp: ${status.ytDlp || 'НЕ НАЙДЕН'}${version ? ` (v${version})` : ''}` +
    `\nffmpeg: ${status.ffmpeg || 'не найден — склейка видео+аудио недоступна'}` +
    `\nffprobe: ${status.ffprobe || 'не найден'}` +
    `\nПапка бинарников: ${status.overrideDir || 'автопоиск (vendor/bin → PATH)'}`;
  $('#engineStatus').style.whiteSpace = 'pre-wrap';
  if (!status.ytDlp) {
    $('#netDot').className = 'dot err';
    $('#netLabel').textContent = 'yt-dlp не найден';
  }
  return status;
}

async function refreshNetDot() {
  const s = state.settings;
  if (!s) return;
  const bits = [];
  bits.push(s.proxy ? 'прокси' : 'напрямую');
  if (s.cookiesFromBrowser && s.cookiesFromBrowser !== 'none') bits.push('cookies');
  $('#netLabel').textContent = bits.join(' · ');
}

// ---------- download view ----------

$('#urlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchOne();
});
$('#fetchBtn').addEventListener('click', fetchOne);
$('#pasteBtn').addEventListener('click', async () => {
  const text = await clipboardRead();
  if (text) {
    $('#urlInput').value = text.trim();
    fetchOne();
  }
});

async function fetchOne() {
  const url = $('#urlInput').value.trim();
  const st = $('#fetchStatus');
  if (!url) return (st.textContent = 'Вставьте ссылку на видео');
  st.textContent = 'Запрос к TikTok…';
  $('#fetchBtn').disabled = true;
  try {
    // A feed/profile/hashtag link has no media of its own; say so before
    // spending a yt-dlp run on a guaranteed "Unsupported URL".
    const kind = await window.api.yt.classify(url);
    if (!kind.downloadable) {
      st.textContent = '';
      showUrlHint(kind);
      return;
    }
    hideUrlHint();
    const info = await window.api.yt.probe(url);
    state.current = info;
    st.textContent = '';
    renderPreview(info);
  } catch (e) {
    hideUrlHint();
    st.textContent = e.message;
    toast(e.message, 'err');
  } finally {
    $('#fetchBtn').disabled = false;
  }
}

function showUrlHint(kind) {
  $('#fetchHintText').textContent = kind.message;
  $('#fetchHint').classList.remove('hidden');
}

function hideUrlHint() {
  $('#fetchHint').classList.add('hidden');
}

// Sends the feed webview to the address in the (hidden) url field, mounting it
// on first use. Kept as a function because the field has no visible button.
function navigateBrowser() {
  const url = $('#browserUrl')?.value.trim();
  if (url && state.webview) state.webview.setAttribute('src', url);
  else mountWebview();
}

$('#fetchHintGo')?.addEventListener('click', () => {
  const url = $('#urlInput').value.trim();
  switchTab('browser');
  if (url && /^https?:/i.test(url)) $('#browserUrl').value = url;
  navigateBrowser();
});

function renderPreview(info) {
  const box = $('#preview');
  const fmtRows = (info.formats || [])
    .map(
      (f) =>
        `<span class="tag">${escapeHtml(f.formatId)} · ${escapeHtml(f.ext)} · ${f.height || '?'}p${f.note ? ' · ' + escapeHtml(f.note) : ''}${
          f.watermarked === true ? ' ⚠ watermark' : ''
        }</span>`
    )
    .join(' ');

  const engineNote = info.engineNote
    ? `<div class="note warn"><b>Подсказка</b> ${escapeHtml(info.engineNote)}</div>`
    : '';
  const photoRow = info.isPhoto
    ? `<div class="meta-row"><span class="tag">${info.images.length} фото</span></div>
       <div class="row"><button id="dlPhotoBtn" class="btn primary">Скачать все фото</button></div>`
    : '';

  box.innerHTML = `
    <div class="preview-body">
      ${info.thumbnail ? `<img src="${escapeHtml(info.thumbnail)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <div class="preview-meta">
        <h3>${escapeHtml(info.title)}</h3>
        <div class="meta-row">
          <span>Автор: ${escapeHtml(info.uploader || '—')}</span>
          <span>Длительность: ${fmtDuration(info.duration)}</span>
          <span>Просмотры: ${fmtCount(info.viewCount)}</span>
          <span>Лайки: ${fmtCount(info.likeCount)}</span>
          <span>ID: ${escapeHtml(info.id || '—')}</span>
          <span>Источник: ${escapeHtml(info.extractor || 'yt-dlp')}</span>
        </div>
        ${info.description ? `<p>${escapeHtml(info.description.slice(0, 300))}</p>` : ''}
        ${engineNote}
        ${fmtRows ? `<div class="meta-row">${fmtRows}</div>` : ''}
        ${photoRow}
        <div class="row">
          ${info.isPhoto ? '' : '<button id="dlBtn" class="btn primary">Скачать видео</button>'}
          <button id="dlCopyBtn" class="btn">Скачать обложку</button>
          ${info.isPhoto ? '' : '<button id="dlAudioBtn" class="btn">Только аудио</button>'}
        </div>
      </div>
    </div>`;
  box.classList.remove('hidden');

  const dl = $('#dlBtn');
  if (dl) dl.onclick = () => enqueue(info);
  const dlA = $('#dlAudioBtn');
  if (dlA) dlA.onclick = () => enqueue(info, { audioOnly: true });
  const dlC = $('#dlCopyBtn');
  if (dlC) dlC.onclick = () => enqueue(info, { thumbnailOnly: true });
  const dlP = $('#dlPhotoBtn');
  if (dlP) dlP.onclick = () => savePhotoSet(info);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- queue ----------

// A TikTok video page is the only thing yt-dlp can resolve to one specific
// clip. Anything else (profile, feed, hashtag, a bare CDN .mp4) either
// downloads whatever happens to be first on that page or the wrong file —
// which is exactly how several different jobs ended up saving the same
// video. Refuse loudly instead of silently producing the wrong file.
const VIDEO_PAGE_RE = /\/@(?:[\w.\-]+)\/(?:video|photo)\/\d{6,}|\/video\/\d{6,}/i;

function enqueue(info, { audioOnly = false, thumbnailOnly = false } = {}) {
  const url = info.url;
  const title = info.title || info.url || '';
  // DIAGNOSTIC — log exactly what goes into the queue so we can compare
  // with the video ID shown in the feed card title / URL hint.
  console.log('[enqueue] url=', url, 'title=', title.slice(0, 60), 'audio=', audioOnly);
  if (!url) return toast('Нет ссылки на видео', 'err');
  if (!VIDEO_PAGE_RE.test(String(url))) {
    const shown = String(url).slice(0, 120);
    toast(`Это не ссылка на конкретный ролик, качать нечего: ${shown}`, 'err');
    return;
  }
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id,
    url,
    title: info.title || info.url,
    status: 'queued',
    percent: 0,
    audioOnly,
    thumbnailOnly,
  };
  state.jobs.set(id, job);
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `
    <div class="job-top">
      <div>
        <div class="job-title" title="${escapeHtml(job.title)}&#10;URL: ${escapeHtml(job.url)}">${escapeHtml(job.title)}</div>
        <div class="job-sub"></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="job-state state-dl">в очереди</span>
        <button class="btn small">Отмена</button>
      </div>
    </div>
    <div class="bar"><i></i></div>`;
  el.querySelector('button').onclick = () => window.api.yt.cancel(id);
  $('#queue').prepend(el);
  job.element = el;
  job.stateEl = el.querySelector('.job-state');
  job.subEl = el.querySelector('.job-sub');
  job.barEl = el.querySelector('.bar > i');
  $('#queueEmpty').classList.add('hidden');
  updateCount();
  startJob(job);
}

async function startJob(job) {
  try {
    await window.api.yt.download(job.url, job.id);
  } catch (e) {
    setJobError(job, e.message);
  }
}

function setJobState(job, status, sub) {
  job.status = status;
  const labels = {
    queued: ['в очереди', 'state-dl'],
    downloading: ['загрузка', 'state-dl'],
    merging: ['обработка', 'state-merge'],
    done: ['готово', 'state-ok'],
    error: ['ошибка', 'state-err'],
  };
  const [label, cls] = labels[status] || ['—', 'state-dl'];
  job.stateEl.textContent = label;
  job.stateEl.className = `job-state ${cls}`;
  job.subEl.textContent = sub || '';
  job.element.classList.toggle('ok', status === 'done');
  job.element.classList.toggle('err', status === 'error');
  updateCount();
}

function setJobError(job, message) {
  setJobState(job, 'error', message);
  toast(message, 'err');
}

const ACTIVE_STATES = ['queued', 'downloading', 'merging'];

function updateCount() {
  const active = Array.from(state.jobs.values()).filter((j) => ACTIVE_STATES.includes(j.status));
  const done = Array.from(state.jobs.values()).filter((j) => j.status === 'done');
  $('#queueEmpty').classList.toggle('hidden', state.jobs.size > 0);
  const total = state.jobs.size;
  $('#cancelAllBtn').disabled = active.length === 0;
  $('#queueClearBtn').disabled = total === 0;
  if (total && active.length === 0 && done.length === total) {
    toast(`Готово: ${done.length} файл(ов)`, 'ok');
  }
}

$('#cancelAllBtn').addEventListener('click', () => window.api.yt.cancelAll());

// «Очистить» empties the LIST ONLY: it drops the rows from #queue and the
// matching state.jobs entries. It never deletes anything on disk and never
// touches the download folder — already saved files stay exactly where yt-dlp
// put them, and the only side effect on the main process is stopping the
// still-running yt-dlp children of the jobs it removes.
$('#queueClearBtn').addEventListener('click', () => {
  const jobs = Array.from(state.jobs.values());
  if (!jobs.length) return;
  const active = jobs.filter((j) => ACTIVE_STATES.includes(j.status));
  if (active.length) {
    const go = confirm(
      `Активных загрузок: ${active.length}. Очистить список? ` +
        'Они будут отменены. Уже скачанные файлы останутся на диске.'
    );
    if (!go) return;
    // Stop yt-dlp first: otherwise the child keeps writing into a folder the
    // user can no longer see from the list.
    active.forEach((j) => window.api.yt.cancel(j.id));
  }
  jobs.forEach((j) => j.element?.remove());
  state.jobs.clear();
  updateCount();
  toast(
    active.length ? `Очередь очищена: ${jobs.length}, отменено: ${active.length}` : `Очищено: ${jobs.length}`,
    'ok'
  );
});

window.api.yt.onProgress((p) => {
  const job = state.jobs.get(p.id);
  if (!job) return;
  const pct = p.total ? Math.round((p.downloaded / p.total) * 100) : 0;
  job.barEl.style.width = `${p.percent * 100}%`;
  const sub = [
    `${fmtBytes(p.downloaded)}${p.total ? ' / ' + fmtBytes(p.total) : ''}`,
    p.filename ? p.filename.split(/[\\/]/).pop() : '',
  ]
    .filter(Boolean)
    .join(' · ');
  setJobState(job, p.status === 'merging' ? 'merging' : 'downloading', sub + (pct ? ` (${pct}%)` : ''));
});

window.api.yt.onDone((r) => {
  const job = state.jobs.get(r.id);
  if (!job) return;
  job.barEl.style.width = '100%';
  setJobState(job, 'done', `${r.path} · ${fmtBytes(r.size)}`);
  const btns = job.element.querySelectorAll('button');
  btns.forEach((b) => (b.disabled = true));
  const open = document.createElement('button');
  open.className = 'btn small';
  open.textContent = 'Показать';
  open.onclick = () => window.api.settings.reveal(r.path);
  job.element.querySelector('div:last-child').prepend(open);
});

window.api.yt.onError(({ id, message }) => {
  const job = state.jobs.get(id);
  if (job) setJobError(job, message);
  else toast(message, 'err');
});

// ---------- author view ----------

$('#authorPasteBtn').addEventListener('click', async () => {
  const text = await clipboardRead();
  if (text) {
    $('#authorInput').value = text.trim();
    loadAuthor();
  }
});
$('#authorInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadAuthor();
});
$('#authorFetchBtn').addEventListener('click', loadAuthor);

function authorHandleFromInput() {
  const raw = $('#authorInput').value.trim();
  if (!raw) return null;
  const m = raw.match(/@([\w.\-]+)/);
  if (m && !/\/video\//.test(raw)) return m[1];
  return null;
}

async function loadAuthor() {
  const st = $('#authorStatus');
  const handle = authorHandleFromInput();
  if (!handle) return (st.textContent = 'Вставьте ссылку на профиль');
  st.textContent = 'Загружаю список видео…';
  $('#authorFetchBtn').disabled = true;
  state.authorItems = [];
  state.authorCursor = 0;
  $('#authorGrid').innerHTML = '';

  try {
    const res = await window.api.yt.author(handle, 0);
    applyAuthorPage(res);
    st.textContent = `Видео у @${handle}: ${state.authorItems.length}${res.total ? ` из ${res.total}` : ''}`;
  } catch (apiErr) {
    // The mobile API can refuse a profile that yt-dlp's web scraper still reads.
    const urls = [`https://www.tiktok.com/@${handle}`];
    try {
      const items = await window.api.yt.probeBatch(urls);
      const videos = items.filter((i) => i.url && !i.error);
      state.authorItems = videos;
      if (videos.length) {
        $('#authorName').textContent = videos[0].uploader ? `· ${videos[0].uploader}` : '';
        renderAuthorGrid();
        st.textContent = `Найдено видео: ${videos.length} (через yt-dlp)`;
      } else {
        st.textContent = items[0]?.error || apiErr.message;
      }
    } catch (e) {
      st.textContent = e.message;
      toast(e.message, 'err');
    }
  } finally {
    $('#authorFetchBtn').disabled = false;
    $('#authorEmpty').classList.toggle('hidden', state.authorItems.length > 0);
  }
}

function applyAuthorPage(res) {
  const incoming = (res.items || []).filter((i) => i && i.url);
  state.authorItems = state.authorItems.concat(incoming);
  state.authorCursor = res.nextCursor ?? 0;
  state.authorHasMore = !!res.hasMore;
  if (res.user) {
    $('#authorName').textContent = `· ${res.user.nickname} (@${res.user.uniqueId})`;
  }
  renderAuthorGrid();
  $('#authorLoadMore').disabled = !state.authorHasMore;
}

$('#authorLoadMore').addEventListener('click', async () => {
  const handle = authorHandleFromInput();
  if (!handle) return;
  const btn = $('#authorLoadMore');
  btn.disabled = true;
  try {
    const res = await window.api.yt.author(handle, state.authorCursor || 0);
    applyAuthorPage(res);
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
  }
});

function renderAuthorGrid() {
  const grid = $('#authorGrid');
  grid.innerHTML = state.authorItems
    .map(
      (it, i) => `
    <div class="card" data-i="${i}">
      ${it.thumbnail ? `<img class="thumb" src="${it.thumbnail}" loading="lazy" referrerpolicy="no-referrer" alt="" />` : '<div class="thumb"></div>'}
      ${it.isPhoto ? '<span class="photo-badge">фото</span>' : ''}
      <div class="cap">
        <b>${escapeHtml(it.title || 'video')}</b>
        ${it.error ? `<span class="err-mark">${escapeHtml(it.error)}</span>` : `<span class="ok-mark">${it.height || '?'}p · ${fmtCount(it.viewCount)}</span>`}
      </div>
    </div>`
    )
    .join('');
  $$('#authorGrid .card').forEach((card) => {
    card.onclick = async () => {
      const it = state.authorItems[Number(card.dataset.i)];
      if (!it) return;
      if (it.error) return toast(it.error, 'err');
      if (it.isPhoto) return savePhotoSet(it);
      switchTab('download');
      await fetchOneWith(it.url);
    };
  });
}

// Photo posts have no video stream; yt-dlp cannot fetch them, so they go
// straight through the proxied Chromium stack instead.
async function savePhotoSet(info) {
  const imgs = info.images || [];
  if (!imgs.length) return toast('У поста нет фотографий', 'err');
  const base = `${(info.uploader || 'tiktok').replace(/[<>:"/\\|?*]/g, '_')}_${info.id}`;
  toast(`Сохраняю ${imgs.length} фото…`);
  let ok = 0;
  for (const img of imgs) {
    try {
      await window.api.media.save(img.url, `${base}_${String(img.index).padStart(2, '0')}.jpg`);
      ok++;
    } catch (e) {
      toast(`Фото ${img.index}: ${e.message}`, 'err');
      break;
    }
  }
  toast(ok ? `Сохранено фото: ${ok}` : 'Не удалось сохранить фото', ok ? 'ok' : 'err');
}

$('#authorDownloadAll').addEventListener('click', () => {
  if (!state.authorItems.length) return toast('Список пуст');
  let i = 0;
  const step = async () => {
    if (i >= state.authorItems.length) return;
    const it = state.authorItems[i++];
    if (!it.error) enqueue(it);
    setTimeout(step, 350);
  };
  step();
});

$('#authorCancelAll').addEventListener('click', () => window.api.yt.cancelAll());

// ---------- browser view ----------

async function mountWebview() {
  const host = $('#browserHost');
  const url = $('#browserUrl').value.trim() || 'https://www.tiktok.com/foryou';
  // The guest preload is what takes over the right-click menu, so it must be
  // set before the element is attached (otherwise the first navigation misses
  // it). The renderer has no filesystem access, hence the main process.
  let guestPreload = state.guestPreloadUrl;
  if (!guestPreload) {
    try {
      guestPreload = await window.api.feed.guestPreloadUrl();
      state.guestPreloadUrl = guestPreload;
    } catch (e) {
      console.warn('guest preload unavailable:', e.message);
    }
  }
  const wv = document.createElement('webview');
  wv.setAttribute('id', 'feedWebview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('useragent', navigator.userAgent);
  if (guestPreload) wv.setAttribute('preload', guestPreload);
  host.innerHTML = '';
  host.appendChild(wv);
  state.webview = wv;

  wv.addEventListener('did-navigate', (e) => {
    if (e.url && /^https?:/.test(e.url)) $('#browserUrl').value = e.url;
    // Remember a real video page URL: it is the thing worth pasting when the
    // page's own Save button is intercepted.
    if (e.url && /\/video\/|\/photo\//.test(e.url)) currentPageVideoUrl = e.url;
  });
  wv.addEventListener('new-window', (e) => {
    window.api.nav.open(e.url);
    e.preventDefault();
  });

  // Chat frames intercepted from the guest's own webcast WebSocket. The preload
  // batches them, so this is a few messages a second, not a firehose. Guarded
  // because `window.api.live` is absent in a preload that predates the feature,
  // and a throw here would abort mountWebview() — and with it the webview the
  // user was waiting for.
  wv.addEventListener('ipc-message', (e) => {
    if (!e) return;
    if (e.channel === 'live:wsFrames') {
      if (!window.api || !window.api.live) return;
      if (!Array.isArray(e.args) || !e.args[0]) return;
      try {
        window.api.live.sendWsFrames(e.args[0]);
      } catch (_) {}
      return;
    }
    // The guest preload reports when its WebSocket tap never installed.
    if (e.channel === 'live:wsDiag') {
      const diag = (e.args && e.args[0]) || {};
      console.warn('[live-chat]', JSON.stringify(diag));
      // armed:true is the tap stats heartbeat (total/matched/messages) —
      // proof the tap runs, not a failure.
      if (diag && diag.armed) return;
      // No toast: the socket tap cannot install on tiktok.com (its CSP blocks
      // inline scripts and Electron 33.4.11 has no contextBridge.executeInMainWorld),
      // so this fires on every single page load and would cry wolf forever. Chat
      // is still recorded — the DOM column watcher in feed.js reads the same
      // messages off the page. See README «Чат эфира».
    }
  });

  // Right-click on a video -> native menu with "Скачать видео".
  // Electron 33: context-menu on <webview> does not fire; menu handled by preload.
  // Redundant listener removed.

  // Hand the main process a handle to the guest page so "Собрать видео из
  // ленты" can read the rendered DOM. The id survives navigation.
  // getWebContentsId() throws until the webview is attached and dom-ready
  // has fired, so every attempt is guarded.
  const report = () => {
    try {
      if (typeof wv.getWebContentsId !== 'function') return;
      const id = wv.getWebContentsId();
      if (!id) return;
      // invoke() returns a promise, so a throwing handler rejects it ASYNCHRONOUSLY
      // — the try/catch above only ever caught synchronous throws. Without this
      // catch a failed registration is completely invisible: the webview is on
      // screen, the button works, and every feed read answers "the embedded
      // browser is not open".
      Promise.resolve(window.api.feed.register(id)).catch((e) => {
        console.error('[feed:register]', e && (e.message || e));
      });
    } catch (_) {
      /* not ready yet — dom-ready will report */
    }
  };
  wv.addEventListener('dom-ready', report);
  setTimeout(report, 400);
}

$('#browserGo')?.addEventListener('click', navigateBrowser);

// A download triggered by the page inside the <webview> is intercepted in the
// main process (Chromium's own manager would save the watermarked CDN file).
// Route what we understand into the queue, and explain what we do not.
window.api.yt.onRedirectDownload((p) => {
  if (!p) return;
  if (p.ok) {
    switchTab('download');
    enqueue({ url: p.url, title: p.filename || p.url });
    toast(
      p.via === 'referrer'
        ? 'Кнопка «Сохранить» на странице ролика перехвачена — качаю через очередь, без водяного знака'
        : 'Загрузка из браузера перенаправлена в очередь (без водяного знака)',
      'ok'
    );
    return;
  }
  toast(p.message, 'err');
  // Put the address bar in front of the user: they need to copy the page URL.
  switchTab('browser');
  const bar = $('#browserUrl');
  if (bar && !ytdlpUnsafeUrl(p.url)) bar.value = currentPageVideoUrl || bar.value;
});

// The CDN URL we were given is useless to paste (it is the watermarked one),
// so only ever prefill the bar with a real video page URL.
function ytdlpUnsafeUrl(u) {
  return !u || !/\/video\/|\/photo\//.test(u);
}

let currentPageVideoUrl = '';

// "Скачать видео со страницы" only works on a page that IS a video. On a feed
// or profile the useful action is collecting the whole page instead, so hand
// the URL to the download tab and let the hint route the user to the browser.
$('#browserDownloadPage')?.addEventListener('click', async () => {
  const url = state.webview?.getAttribute('src') || $('#browserUrl')?.value.trim();
  if (!url) return;
  if (/\/(?:video|photo)\/\d+/.test(url)) return fetchOneWith(url);
  const kind = await window.api.yt.classify(url);
  if (!kind.downloadable) {
    toast(kind.message, 'err');
    switchTab('download');
    $('#urlInput').value = url;
    showUrlHint(kind);
    return;
  }
  $('#urlInput').value = url;
  switchTab('download');
  fetchOne();
});

async function fetchOneWith(url) {
  const st = $('#fetchStatus');
  st.textContent = 'Запрос к TikTok…';
  try {
    const info = await window.api.yt.probe(url);
    state.current = info;
    st.textContent = '';
    renderPreview(info);
  } catch (e) {
    st.textContent = e.message;
    toast(e.message, 'err');
  }
}

// ---------- feed collection ----------

// ---------- download whatever is playing ----------

/** Downloads the video the recommendations feed is playing right now. */
async function downloadCurrentFeedVideo() {
  // Ask the page, never a cache: the feed scrolls, so a remembered id would
  // download the video the user just scrolled past.
  const res = await window.api.feed.currentPlaying();
  const v = res && res.ok ? res.video : null;
  if (!v || !v.url) {
    return toast((res && res.error) || 'Видео не найдено: дождитесь, пока ролик начнёт играть', 'err');
  }

  switchTab('download');
  enqueue({ url: v.url, title: v.title || v.url });
  toast(v.playing ? 'Скачиваю то, что сейчас играет' : 'Скачиваю ролик из ленты', 'ok');
}

// Actions coming back from feed:downloadCurrent — TikTok's own «Загрузить
// видео», which the guest preload rewrites into a clean (watermark-free)
// download. The app paints no context menu, so nothing else feeds this channel.
// The other branches are unreachable today and kept only so a future sender of
// the same channel does not silently lose its action.
window.api.feed.onMenuAction(({ action, url, title, message }) => {
  if (action === 'notice') {
    // No video under the cursor and none playing — say so instead of silently
    // doing nothing, which is what made this look like "download is broken".
    return toast(message || 'Видео не найдено: страница ещё загружается', 'err');
  }
  if (action === 'download') {
    switchTab('download');
    enqueue({ url, title: title || url });
  } else if (action === 'downloadAudio') {
    switchTab('download');
    enqueue({ url, title: title || url }, { audioOnly: true });
  } else if (action === 'copy') {
    window.api.clipboard.write(url);
    toast('Ссылка скопирована', 'ok');
  } else if (action === 'openInDownload' || action === 'probe') {
    switchTab('download');
    $('#urlInput').value = url;
    $('#fetchBtn').click();
  }
});

$('#feedNowBtn').addEventListener('click', () => {
  downloadCurrentFeedVideo().catch((e) => toast(e.message, 'err'));
});

// ---------- live view ----------

// One resolved broadcast at a time (state.liveRoom) and any number of running
// captures (state.liveJobs). Both are kept separate on purpose: re-resolving a
// link must never disturb a capture that is already writing to disk.
const liveState = {
  room: null, // last successfully resolved room
  jobs: new Map(), // id -> { id, element, subEl, stateEl }
  pickerItems: [], // кандидаты, показанные пользователю на выбор
  expanded: false, // ручной выбор раскрытия панели
  autoOpen: false, // панель раскрыта сама: ошибка, кандидаты или идёт запись
  statusKind: '', // последний тип подсказки: '' | 'warn' | 'err'
};

function liveTick(startedAt) {
  const ms = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = String(Math.floor(ms / 3600)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600) / 60)).padStart(2, '0');
  const s = String(ms % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function setLiveStatus(text, kind) {
  const el = $('#liveStatus');
  liveState.statusKind = kind || '';
  el.className = `hint${kind ? ' ' + kind : ''}`;
  el.textContent = text;
  // Ошибку или предупреждение надо показать, даже если панель свернута.
  if (kind === 'err' || kind === 'warn') autoOpenLiveDock();
  else syncLiveDock();
}

/**
 * Рекорд-панель по умолчанию свернута в одну строку кнопок: видео должно
 * получать всю остальную высоту окна. Всё, что ниже строки кнопок, живёт в
 * #liveExtra с собственным скроллом и капом, поэтому даже длинный список
 * записей не вытолкнет webview из окна.
 *
 * Панель раскрывается сама, когда пользователю есть что прочитать (ошибка,
 * предупреждение, карточка эфира, список кандидатов) или когда идёт запись.
 * Свернуть вручную можно только когда ничего не пишется и не показано —
 * иначе кнопка закрыла бы то, что пользователь обязан увидеть.
 */
function syncLiveDock() {
  const extra = $('#liveExtra');
  const toggle = $('#liveToggleBtn');
  if (!extra) return;
  // Активная запись — единственное, что раскрывает панель НАВСЕГДА: в списке
  // кнопка «Остановить», и прятать её под кнопку — значит запретить остановить
  // запись, не сказав об этом.
  const shown = liveState.expanded || liveState.autoOpen || liveState.jobs.size > 0;
  extra.classList.toggle('hidden', !shown);
  if (toggle) {
    toggle.setAttribute('aria-expanded', shown ? 'true' : 'false');
    toggle.textContent = shown ? '▴' : '▾';
    toggle.disabled = liveState.jobs.size > 0;
    toggle.title = liveState.jobs.size > 0
      ? 'Пока идёт запись, панель остаётся раскрытой'
      : 'Настройки записи и идущие записи';
  }
  const badge = $('#liveRunBadge');
  if (badge) {
    const n = liveState.jobs.size;
    badge.classList.toggle('hidden', n === 0);
    badge.textContent = n > 1 ? `запись: ${n}` : 'запись';
  }
}

function toggleLiveDock() {
  // Ручной клик снимает автооткрытие: пользователь, прочитавший подсказку,
  // вправе вернуть панель в строку кнопок.
  liveState.expanded = !liveState.expanded;
  liveState.autoOpen = false;
  syncLiveDock();
}

function autoOpenLiveDock() {
  liveState.autoOpen = true;
  syncLiveDock();
}

function renderLiveCard(res) {
  const card = $('#liveCard');
  if (!res.ok) {
    card.classList.add('hidden');
    if (res.restricted) {
      setLiveStatus(res.error, 'warn');
    } else if (res.offline) {
      setLiveStatus(`${res.error} Появится кнопка, когда автор начнёт эфир — нажмите «Запись трансляции» ещё раз.`, 'warn');
    } else {
      setLiveStatus(res.error, 'err');
    }
    return;
  }

  const room = res.room;
  if (!room || !Array.isArray(room.streams) || !room.streams.length) {
    liveState.room = null;
    card.classList.add('hidden');
    return setLiveStatus('TikTok не отдал ни одного потока для этого эфира.', 'err');
  }
  liveState.room = room;
  const stream = room.streams[0];
  const quality = stream.resolution || stream.label || stream.kind;
  const extra = room.streams.length > 1
    ? ` · доступно качеств: ${room.streams.length}`
    : '';
  card.className = 'live-card';
  card.innerHTML = `
    <div class="live-thumb"><span class="live-dot">LIVE</span></div>
    <div class="live-body">
      <div class="live-title">${escapeHtml(room.title || `Эфир @${room.handle}`)}</div>
      <div class="live-meta">
        @${escapeHtml(room.handle)} · ${escapeHtml(quality)} · ${stream.kind.toUpperCase()}${extra}
        ${room.viewers ? ` · зрителей ${fmtCount(room.viewers)}` : ''}
      </div>
    </div>
    <div class="live-actions">
      <button id="liveRecordBtn" class="btn primary">Записать</button>
    </div>
  `;
  setLiveStatus('Эфир найден. Можно записывать.');
  autoOpenLiveDock();

  const recordBtn = $('#liveRecordBtn');
  recordBtn.addEventListener('click', () => startLiveRecording(room, recordBtn));
}

/**
 * Единственная точка входа для кнопки «Запись трансляции».
 *
 * Ссылку вводить не нужно: источник — то, что уже показывает встроенный браузер.
 * Это ровно то, на что жаловался пользователь: раньше кнопка жила на отдельной
 * вкладке, и запись не имела смысла, пока «Обзор» смотрит в другую сторону.
 *
 * Порядок: текущая страница (если это /@ник/live) → иначе компактный выбор из
 * найденных на странице эфиров. Автовыбор первого видимого НЕ делается: в ленте
 * постоянно мелькают чужие превью эфиров, и «записал не то» хуже, чем один
 * дополнительный клик.
 */
async function recordCurrentLive() {
  const btn = $('#liveRecBtn');
  if (btn) btn.disabled = true;
  setLiveStatus('Смотрю страницу во встроенном браузере…');
  try {
    const res = await window.api.live.detect();
    if (!res || !res.ok) {
      return setLiveStatus((res && res.error) || 'Не удалось прочитать страницу.', 'err');
    }

    if (res.page) {
      liveState.pickerItems = [];
      $('#liveCandidates').classList.add('hidden');
      return await resolveAndRecord(res.page.url);
    }

    // Не на эфире: показываем то, что нашлось на странице, и ждём выбора.
    const box = $('#liveCandidates');
    const items = (res.candidates || []).slice(0, 12).map((c) => ({
      url: c.url,
      title: c.title || `@${c.handle}`,
    }));
    if (!items.length) {
      box.classList.add('hidden');
      return setLiveStatus(
        'Здесь не видно трансляции. Откройте эфир во встроенном браузере — или нажмите сюда ещё раз на странице профиля автора с эфиром.',
        'warn'
      );
    }
    liveState.pickerItems = items;
    box.classList.remove('hidden');
    autoOpenLiveDock();
    box.innerHTML =
      '<div class="hint">Найдено на странице — выберите эфир:</div>' +
      items
        .map(
          (it, i) =>
            `<button class="cand" data-i="${i}">${escapeHtml(it.title)} <span class="muted">${escapeHtml(it.url)}</span></button>`
        )
        .join('');
    box.querySelectorAll('.cand').forEach((b) => {
      b.addEventListener('click', () => {
        const it = liveState.pickerItems[Number(b.dataset.i)];
        if (it) resolveAndRecord(it.url);
      });
    });
    setLiveStatus('Выберите трансляцию выше — или откройте эфир во встроенном браузере.');
  } catch (e) {
    setLiveStatus(e.message || String(e), 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function resolveAndRecord(url) {
  setLiveStatus('Ищу трансляцию…');
  try {
    const res = await window.api.live.resolve(url);
    $('#liveCandidates').classList.add('hidden');
    liveState.pickerItems = [];
    if (!res || !res.ok) {
      renderLiveCard(res || { ok: false, error: 'Пустой ответ от main-процесса.' });
      return;
    }
    renderLiveCard(res);
    // Нашли эфир — стартуем сразу, без второго нажатия: кнопка «Записать» в
    // карточке остаётся как запасной вариант и для перезаписи другого эфира.
    return startLiveRecording(res.room);
  } catch (e) {
    setLiveStatus(e.message || String(e), 'err');
  }
}

// One start in flight at a time. A double-click on «Записать» would otherwise
// spawn a second ffmpeg before the first IPC returns — main's re-resolve makes
// that start slower, which widens the window rather than closing it.
let liveStarting = false;

function startLiveRecording(room, btn) {
  if (liveStarting) return;
  liveStarting = true;
  if (btn) btn.disabled = true;
  const withChat = Boolean($('#liveChatCheck') && $('#liveChatCheck').checked);
  const mode = $('#liveModeScreen') && $('#liveModeScreen').checked ? 'screen' : 'stream';
  Promise.resolve()
    .then(() => window.api.live.start(room, { withChat, mode }))
    .then((r) => {
      if (!r || !r.ok) {
        return toast((r && r.error) || 'Не удалось начать запись.', 'err');
      }
      // Prefer main's freshly-resolved room: it may carry a newer title or a
      // different handle than the card the user is looking at.
      const job = addLiveJob(r.id, r.room || room, (r && r.mode) || mode);
      if (job && withChat) job.chat = 0;
      if (withChat && r.withChat === false) {
        // main swallowed an error opening the sink. Say so instead of leaving
        // a recording that looks like it is saving chat and is not.
        toast(
          'Чат не пишется: не удалось открыть файл чата. Видео записывается.',
          'err'
        );
      }
      toast('Запись началась.', 'ok');
      autoOpenLiveDock();
    })
    .catch((e) => toast(e.message || String(e), 'err'))
    .finally(() => {
      liveStarting = false;
      if (btn) btn.disabled = false;
    });
}

/**
 * Single source of truth for the «Идущие записи» panel state.
 *
 * Counts ROWS, not `liveState.jobs`: a finished capture is deliberately removed
 * from that map (it is no longer controllable) but its row stays on screen, so
 * counting the map would report "0 записей" while rows are plainly visible and
 * the «Очистить» button would have nothing to act on.
 */
function syncLivePanel() {
  const rows = $('#liveList').children.length;
  $('#liveStopAllBtn').disabled = liveState.jobs.size === 0;
  $('#liveClearBtn').disabled = rows === 0;
  $('#liveCount').textContent = rows ? `· ${rows}` : '';
  $('#liveEmpty').classList.toggle('hidden', rows > 0);
  syncLiveDock();
}

function liveModeLabel(m) {
  return m === 'screen' ? 'экран' : 'поток';
}

function addLiveJob(id, room, mode) {
  if (liveState.jobs.has(id)) return liveState.jobs.get(id);
  const el = document.createElement('div');
  el.className = 'job live-job';
  el.innerHTML = `
    <div class="job-top">
      <div class="job-text">
        <div class="job-title">${escapeHtml(room.title || `Эфир @${room.handle}`)}</div>
        <div class="job-sub">@${escapeHtml(room.handle)} · ${liveModeLabel(mode)} · подключение…</div>
      </div>
      <span class="rec-badge">запись</span>
      <button class="btn small">Остановить</button>
    </div>
  `;
  const sub = el.querySelector('.job-sub');
  const stopBtn = el.querySelector('button');
  stopBtn.addEventListener('click', () => window.api.live.stop(id));
  $('#liveList').prepend(el);

  const job = {
    id,
    element: el,
    subEl: sub,
    stopBtn,
    startedAt: Date.now(),
    handle: room.handle,
    mode: mode === 'screen' ? 'screen' : 'stream',
    // roomId links this row to the chat messages main routes to it.
    roomId: room.roomId ? String(room.roomId) : '',
    chat: 0,
  };
  liveState.jobs.set(id, job);
  syncLivePanel();
  return job;
}

function dropLiveJob(id) {
  const job = liveState.jobs.get(id);
  if (job) job.element.remove();
  liveState.jobs.delete(id);
  syncLivePanel();
}

/**
 * A finished capture stays in the list as a plain row with a «Показать» button,
 * exactly like a completed download in the queue. Auto-opening Explorer here
 * would pop a window for every recording that ends.
 */
function finishLiveJob(r) {
  const job = liveState.jobs.get(r.id);
  if (!job) return;
  liveState.jobs.delete(r.id);

  job.element.classList.add('ok');
  job.element.classList.remove('live-job');
  const badge = job.element.querySelector('.rec-badge');
  if (badge) {
    badge.textContent = 'сохранено';
    badge.style.animation = 'none';
    badge.style.background = 'var(--ok)';
    badge.style.color = '#04220f';
  }
  // r.chat is normally the { count, ... } object from main finishChat();
  // never interpolate it directly — that prints "[object Object]".
  let chatPart = '';
  if (r.chat && typeof r.chat === 'object') {
    chatPart = ` · чата: ${Number(r.chat.count) || 0}`;
  } else if (typeof r.chat === 'number' && Number.isFinite(r.chat)) {
    chatPart = ` · чата: ${r.chat}`;
  }
  job.subEl.textContent =
    `@${r.handle || ''} · ${liveModeLabel(r.mode || job.mode)} · ${fmtDuration(r.elapsedSec)} записи · ${fmtBytes(r.size)}` +
    chatPart +
    (r.reason ? ` · ${r.reason.charAt(0).toLowerCase() + r.reason.slice(1)}` : '');
  job.stopBtn.textContent = 'Показать';
  job.stopBtn.disabled = false;
  job.stopBtn.onclick = () => window.api.settings.reveal(r.path);

  syncLivePanel();
  toast(`Запись сохранена: ${r.handle ? '@' + r.handle + ' · ' : ''}${fmtBytes(r.size)}`, 'ok');
}

// Everything below only WIRES the live tab up. If the preload ever ships without
// the `live` namespace — a stale preload against a new renderer, or a partially
// failed update — an unguarded `window.api.live.onProgress(...)` throws a
// TypeError at module top level, and that aborts the REST of renderer.js
// including boot(), which blacks out the whole window. This project has been
// bitten by exactly that shape of bug before, so the wiring is skipped instead.
if (window.api && window.api.live) {
  $('#liveRecBtn').addEventListener('click', () => {
    recordCurrentLive().catch((e) => setLiveStatus(e.message || String(e), 'err'));
  });
  $('#liveToggleBtn').addEventListener('click', toggleLiveDock);
  syncLiveDock();
  $('#liveStopAllBtn').addEventListener('click', async () => {
    const n = liveState.jobs.size;
    if (!n) return;
    if (!confirm(`Остановить все записи (${n})? Файлы закроются и останутся на диске.`)) return;
    await window.api.live.stopAll();
    toast('Записи остановлены');
  });
  // «Очистить» empties the LIST ONLY: it drops the rows from #liveList. It never
  // deletes anything on disk — finished captures stay in <downloadDir>\live\.
  // The one side effect on the main process is stopping recordings that are
  // still running, otherwise their rows would vanish while ffmpeg kept writing
  // to a folder the user can no longer see or stop from the list.
  $('#liveClearBtn').addEventListener('click', async () => {
    const rows = Array.from($('#liveList').children);
    if (!rows.length) return;
    const active = liveState.jobs.size;
    if (active > 0) {
      const go = confirm(
        `Активных записей: ${active}. Очистить список? ` +
          'Они будут остановлены, файлы закроются и останутся на диске.'
      );
      if (!go) return;
      await window.api.live.stopAll();
    }
    rows.forEach((el) => el.remove());
    liveState.jobs.clear();
    syncLivePanel();
    toast(`Очищено: ${rows.length}`, 'ok');
  });

  // Mode hint under the radio row: plain words for what each mode records.
  const syncLiveModeHint = () => {
    const el = $('#liveModeHint');
    if (!el) return;
    el.textContent =
      $('#liveModeScreen') && $('#liveModeScreen').checked
        ? 'Записывается окно страницы: видео, зрители и чат — как на экране. Не переключайтесь на другие вкладки и не сворачивайте окно.'
        : 'Поток: пишется чистое видео эфира с CDN. Качество максимальное. Можно переключаться на другие вкладки.';
  };
  if ($('#liveModeStream')) $('#liveModeStream').addEventListener('change', syncLiveModeHint);
  if ($('#liveModeScreen')) $('#liveModeScreen').addEventListener('change', syncLiveModeHint);
  syncLiveModeHint();

  window.api.live.onProgress((p) => {
    const job = liveState.jobs.get(p.id);
    if (!job) return;
    const parts = [liveTick(job.startedAt), liveModeLabel(job.mode)];
    if (p.downloaded) parts.push(fmtBytes(p.downloaded));
    if (p.resolution) parts.push(p.resolution);
    if (p.mode === 'screen' && Number.isFinite(p.frames)) parts.push(`кадров: ${p.frames}`);
    if (job.chat) parts.push(`чата: ${job.chat}`);
    job.subEl.textContent = `${p.handle ? '@' + p.handle + ' · ' : ''}${parts.join(' · ')}`;
    // The per-row stop button is deliberately left ENABLED here. Disabling it on
    // progress made it permanently dead: nothing re-enabled it until the job
    // finished, so per-recording stop was impossible. live.stop() is idempotent,
    // so a double click is harmless.
  });

  // Chat counter. It stays at 0 when nothing is arriving, which is the honest
  // signal: the capture reads the page's socket, and if the browser is not
  // sitting on that live room there is nothing to intercept.
  window.api.live.onChat(({ roomId, count }) => {
    for (const job of liveState.jobs.values()) {
      if (roomId && job.roomId && job.roomId !== roomId) continue;
      job.chat = count;
    }
  });

  window.api.live.onDone((r) => {
    finishLiveJob(r);
  });

  window.api.live.onError(({ id, message }) => {
    // A job the user already removed via «Очистить» is gone from the map; its
    // late error must not pop a toast about a recording that is off the screen.
    if (!liveState.jobs.has(id)) return;
    dropLiveJob(id);
    toast(message || 'Запись прервана', 'err');
  });
} else {
  const box = $('#liveStatus');
  if (box) box.textContent = 'Запись эфиров недоступна: перезапустите приложение.';
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'browser' && !state.webview) mountWebview();
}

// ---------- geo view ----------

const LEVEL_LABEL = { error: 'Проблема', warn: 'Внимание', info: 'Подсказка' };

async function refreshGeo() {
  const verdict = $('#geoVerdict');
  verdict.textContent = 'проверяю регион и IP…';
  verdict.className = 'verdict';
  let report;
  try {
    report = await window.api.geo.inspect();
  } catch (e) {
    verdict.textContent = 'Не удалось выполнить диагностику: ' + e.message;
    verdict.className = 'verdict bad';
    return;
  }
  renderGeoReport(report);
  return report;
}

function renderGeoReport(r) {
  const verdict = $('#geoVerdict');
  const v = r.verdict || { level: 'info', text: '—' };
  verdict.textContent = v.text;
  verdict.className = `verdict ${v.level === 'error' ? 'bad' : v.level === 'warn' ? 'warn' : 'ok'}`;

  const p = r.profile || {};
  const facts = [
    ['Заявленный регион', `${p.country || '—'} (${p.region || '?'})`],
    ['Оператор', p.carrier ? `${p.carrier} · MCC/MNC ${p.carrierMccmnc}` : '—'],
    ['Часовой пояс', p.timezone ? `${p.timezone} (UTC${(p.timezoneOffset / 3600 >= 0 ? '+' : '') + p.timezoneOffset / 3600})` : '—'],
    ['Приложение', p.app || '—'],
    ['Ваш IP', r.egress?.country ? `${r.egress.country}${r.egress.ip ? ` (${r.egress.ip})` : ''}` : 'не определён'],
    ['Прокси', r.proxy || 'не задан'],
  ];
  $('#geoFacts').innerHTML = facts
    .map(([k, val]) => `<div class="fact"><span>${escapeHtml(k)}</span><b>${escapeHtml(val)}</b></div>`)
    .join('');

  const notes = [...(r.notes || []), ...((r.consistency && r.consistency.problems) || [])];
  $('#geoNotes').innerHTML = notes.length
    ? notes.map((n) => `<div class="note ${n.level}"><b>${LEVEL_LABEL[n.level] || ''}</b> ${escapeHtml(n.text)}</div>`).join('')
    : '';

  const s = state.settings || {};
  $('#geoRegion').value = s.regionProfile || s.region || '';
  $('#geoTimezone').value = s.timezone || '';
  $('#geoProxy').value = s.proxy || '';
  fillCarrierOptions(s.regionProfile || s.region, Number(s.carrierIndex) || 0);
}

function fillCarrierOptions(regionCode, selectedIndex) {
  const sel = $('#geoCarrier');
  const profile = state.profiles?.find((x) => x.region === regionCode);
  const carriers = profile?.carrierList || [];
  sel.innerHTML = carriers.length
    ? carriers.map((c, i) => `<option value="${i}" ${i === selectedIndex ? 'selected' : ''}>${escapeHtml(c.name)} (${c.mccmnc})</option>`).join('')
    : '<option value="0">оператор не задан для этого региона</option>';
  sel.disabled = carriers.length === 0;
}

async function loadProfiles() {
  try {
    state.profiles = await window.api.geo.profiles();
    const sel = $('#geoRegion');
    sel.innerHTML = state.profiles
      .map((p) => `<option value="${p.region}">${escapeHtml(p.country)} (${p.region})${p.recommended ? ' — рекомендуется' : ''}</option>`)
      .join('');
  } catch (e) {
    toast('Не удалось загрузить список регионов: ' + e.message, 'err');
  }
}

$('#geoRefreshBtn').addEventListener('click', () => refreshGeo());

$('#geoRegion').addEventListener('change', (e) => {
  const code = e.target.value;
  fillCarrierOptions(code, 0);
  const p = state.profiles?.find((x) => x.region === code);
  if (p) $('#geoTimezone').value = p.timezone;
});

$('#geoShowAdvanced').addEventListener('change', (e) => {
  $('#geoParams').classList.toggle('hidden', !e.target.checked);
  if (e.target.checked) showRequestParams();
});

async function showRequestParams() {
  try {
    const r = await window.api.geo.params();
    $('#geoParams').textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    $('#geoParams').textContent = 'Не удалось построить запрос: ' + e.message;
  }
}

$('#geoApplyBtn').addEventListener('click', async () => {
  const out = $('#geoApplyOut');
  out.textContent = 'применяю…';
  const region = $('#geoRegion').value;
  const saved = await window.api.settings.set({
    regionProfile: region,
    region,
    carrierIndex: Number($('#geoCarrier').value) || 0,
    timezone: $('#geoTimezone').value.trim(),
    proxy: $('#geoProxy').value.trim(),
  });
  state.settings = saved;
  fillSettings(saved);
  await refreshGeo();
  out.textContent = 'применено';
  setTimeout(() => (out.textContent = ''), 2500);
  toast(`Регион ${region} применён.`, 'ok');
});

$('#geoCheckBtn').addEventListener('click', async () => {
  const out = $('#geoCheckOut');
  out.textContent = 'проверяю…';
  const url = $('#geoCheckUrl').value.trim();
  try {
    const r = await window.api.geo.check(url || undefined);
    renderGeoReport(r);
    const p = r.probe;
    out.textContent = p
      ? p.ok
        ? `Видео получено через ${p.engine}: ${p.title} (${p.height || '?'}p)`
        : `Метаданные не получены: ${p.error}`
      : 'Проверка региона завершена.';
    if (r.verdict?.level === 'error') out.textContent += ' Сначала согласуйте регион и IP — см. состояние выше.';
  } catch (e) {
    out.textContent = e.message;
  }
});

// ---------- settings view ----------

function fillSettings(s) {
  $('#setProxy').value = s.proxy || '';
  $('#setCookiesBrowser').value = s.cookiesFromBrowser || 'none';
  $('#setCookieFile').value = s.cookieFile || '';
  $('#setRegion').value = s.region || '';
  $('#setLang').value = s.navigatorLanguage || '';
  $('#setTimezone').value = s.timezone || '';
  $('#setApiHost').value = s.apiHostname || '';
  $('#setEngine').value = s.engine || 'auto';
  $('#setTtwid').value = s.ttwid || '';
  $('#setMsToken').value = s.msToken || '';
  const sgn = s.signer || {};
  $('#setSignerEnabled').value = sgn.enabled ? (sgn.provider || 'gnarly') : 'off';
  $('#setSignerPath').value = sgn.signerPath || '';
  $('#setAppInfo').value = s.appInfo || '';
  $('#setDeviceId').value = s.deviceId || '';
  $('#setDir').value = s.downloadDir || '';
  $('#setFormat').value = s.format || 'best';
  $('#setCustomFormat').value = s.customFormat || '';
  $('#setMaxHeight').value = s.maxHeight ?? 0;
  $('#setPreferH265').checked = !!s.preferH265;
  $('#setConcurrency').value = s.concurrency ?? 2;
  $('#setThumb').checked = !!s.writeThumbnail;
  $('#setInfoJson').checked = !!s.writeInfoJson;
  $('#setAudio').checked = !!s.audioOnly;
  $('#setBinDir').value = s.binDir || '';
  $('#customFormatField').classList.toggle('hidden', s.format !== 'custom');
}

$('#setFormat').addEventListener('change', (e) => {
  $('#customFormatField').classList.toggle('hidden', e.target.value !== 'custom');
});

$('#pickDirBtn').addEventListener('click', async () => {
  const dir = await window.api.settings.pickDir();
  if (dir) $('#setDir').value = dir;
});
$('#openDirBtn').addEventListener('click', () => window.api.settings.reveal($('#setDir').value));

$('#saveBtn').addEventListener('click', async () => {
  const patch = {
    proxy: $('#setProxy').value.trim(),
    cookiesFromBrowser: $('#setCookiesBrowser').value,
    cookieFile: $('#setCookieFile').value.trim(),
    region: $('#setRegion').value.trim().toUpperCase(),
    regionProfile: $('#setRegion').value.trim().toUpperCase(),
    navigatorLanguage: $('#setLang').value.trim(),
    timezone: $('#setTimezone').value.trim(),
    apiHostname: $('#setApiHost').value.trim(),
    engine: $('#setEngine').value,
    ttwid: $('#setTtwid').value.trim(),
    msToken: $('#setMsToken').value.trim(),
    signer: {
      enabled: $('#setSignerEnabled').value !== 'off',
      provider: $('#setSignerEnabled').value === 'mobile' ? 'mobile' : 'gnarly',
      signerPath: $('#setSignerPath').value.trim(),
    },
    appInfo: $('#setAppInfo').value.trim(),
    deviceId: $('#setDeviceId').value.trim(),
    downloadDir: $('#setDir').value.trim(),
    format: $('#setFormat').value,
    customFormat: $('#setCustomFormat').value.trim(),
    preferH265: $('#setPreferH265').checked,
    maxHeight: Number($('#setMaxHeight').value) || 0,
    concurrency: Math.max(1, Math.min(8, Number($('#setConcurrency').value) || 2)),
    writeThumbnail: $('#setThumb').checked,
    writeInfoJson: $('#setInfoJson').checked,
    audioOnly: $('#setAudio').checked,
    binDir: $('#setBinDir').value.trim(),
  };
  const saved = await window.api.settings.set(patch);
  state.settings = saved;
  fillSettings(saved);
  await refreshEngineStatus();
  await refreshNetDot();
  $('#saveOut').textContent = 'Сохранено';
  setTimeout(() => ($('#saveOut').textContent = ''), 2500);
  toast('Настройки сохранены. Прокси применён к встроенному браузеру.', 'ok');
});

$('#signerTestBtn').addEventListener('click', async () => {
  const out = $('#signerTestOut');
  out.textContent = 'Проверяю…';
  const sel = $('#setSignerEnabled').value;
  // Test what the user picked, regardless of what is currently saved.
  if (sel === 'off') {
    out.textContent = 'Подпись выключена — запросы уйдут без подписей.';
    return;
  }
  await window.api.settings.set({
    signer: {
      enabled: true,
      provider: sel === 'mobile' ? 'mobile' : 'gnarly',
      signerPath: $('#setSignerPath').value.trim(),
    },
  });
  if (sel === 'mobile') {
    const st = await window.api.signer.status();
    out.textContent = st.mobile.ok
      ? `Python найден: ${st.mobile.python}`
      : `Мобильный подписант недоступен: ${st.mobile.reason}`;
    return;
  }
  const r = await window.api.signer.selfTest();
  out.textContent = r.ok
    ? `X-Gnarly ${r.version}: подпись ${r.length} символов, round-trip сошёлся`
    : `Ошибка X-Gnarly: ${r.error}`;
});

$('#netTestBtn').addEventListener('click', async () => {
  const out = $('#netTestOut');
  out.textContent = 'Проверяю…';
  const r = await window.api.net.probe('https://www.tiktok.com/@tiktok');
  out.textContent = r.message;
  $('#netDot').className = `dot ${r.ok ? 'ok' : 'err'}`;
  $('#netLabel').textContent = r.ok ? 'доступ работает' : 'доступ закрыт';
});

// ---------- boot ----------

(async function boot() {
  // "Обзор" is the landing tab: mount the webview before anything that can
  // block on the network, so the feed starts loading right away.
  switchTab('browser');

// Restore the saved interface scale before anything measures the layout.
  let savedZoom = 1;
  try {
    savedZoom = Number(localStorage.getItem(ZOOM_KEY)) || 1;
  } catch (_) {}
  setZoom(savedZoom);

  state.settings = await window.api.settings.get();
  fillSettings(state.settings);
  await loadProfiles();
  await refreshEngineStatus();
  await refreshNetDot();
  refreshGeo().then((r) => {
    if (r?.verdict?.level === 'error') {
      toast('Регион и IP не согласованы — подробности на вкладке «Гео-обход».', 'err');
    }
  });

  if (!state.settings.proxy && (state.settings.cookiesFromBrowser === 'none' || !state.settings.cookiesFromBrowser)) {
    toast('Совет: без прокси TikTok ограничивает выдачу по вашему IP. См. вкладку «Гео-обход».', '');
  }
})();