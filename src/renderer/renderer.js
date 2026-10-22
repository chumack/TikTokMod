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

  // Chat frames used to be relayed from here: the guest preload's
  // sendToHost() lands on this DOM event, and it was forwarded to main with
  // api.live.sendWsFrames(). Both halves are gone.
  //
  // The tap is injected by MAIN into the guest's main world (see
  // chatTapMainWorld in src/main/main.js — a preload-side tap cannot work here)
  // and its frames leave the guest through the `__tkmChat` contextBridge hop in
  // src/preload/webview-preload.js, which ipcRenderer.send()s them straight to
  // ipcMain. Nothing about chat frames crosses this process any more, and no
  // <webview> 'ipc-message' listener is needed for it.
  //
  // The «чата: N» counter is NOT dead with it: api.live.onChat (live:chat)
  // still fires, because the DOM fallback in feed.js drains the chat column and
  // main still emits live:chat for whichever source produced the message.

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
  jobs: new Map(), // id -> { id, chipEl, textEl, btnEl, ... }
  pickerItems: [], // кандидаты, показанные пользователю чипами на выбор
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
  if (!el) return;
  liveState.statusKind = kind === 'err' ? 'err' : '';
  // Ошибка отмечается ЦВЕТОМ в той же строке, а не отдельным блоком: строка
  // статуса обрезается по ширине, панель от этого не растёт по высоте.
  el.classList.toggle('is-err', liveState.statusKind === 'err');
  el.textContent = text;
}

/**
 * Единственное, чем панель «Обзора» показывает, что идёт запись.
 *
 * Никаких раскрывающихся блоков и списков: панель всегда одна строка, потому
 * что встроенный браузер (гость) должен получать одну и ту же высоту вьюпорта —
 * иначе геометрия, замороженная при старте записи «Экран», перестаёт совпадать
 * с текущей, и кадр выходит обрезанным по краям.
 */
function syncLiveDock() {
  const badge = $('#liveRunBadge');
  const n = liveState.jobs.size;
  if (badge) {
    badge.classList.toggle('hidden', n === 0);
    badge.textContent = n > 1 ? `запись: ${n}` : 'запись';
  }
  // Состояние кнопки «Очистить» ставится ЗДЕСЬ, а не в обработчике клика: иначе
  // кнопка рассинхронизируется с чипами (появился чип — она осталась выключенной).
  // Пока идёт хотя бы одна запись — неактивна: сносить идущий чип вместе с
  // завершёнными нельзя. Завершённые чипы из liveState.jobs уже удалены
  // (finishLiveJob), поэтому «есть что чистить» считается по DOM, а не по Map.
  const clearBtn = $('#liveClearBtn');
  if (clearBtn) {
    const box = $('#liveChips');
    const chips = box ? box.querySelectorAll('.live-chip').length : 0;
    clearBtn.disabled = n > 0 || chips === 0;
  }
}

function autoOpenLiveDock() {
  // Панель больше не раскрывается: она всегда одна строка постоянной высоты.
  // Функция оставлена как no-op, чтобы существующие вызовы не ломались.
}

/**
 * Что будет записано — одной строкой в #liveStatus.
 *
 * Карточки с обложкой больше нет: любая обёртка в несколько строк отдавала
 * панель высотой больше одной строки. Длинный текст обрезается по ширине
 * стилями `.live-status`, кнопка «Записать» не нужна — запись стартует сразу
 * после resolve.
 */
function renderLiveCard(res) {
  if (!res || !res.ok) {
    if (res && res.restricted) {
      return setLiveStatus(res.error || 'Эфир недоступен.', 'warn');
    }
    if (res && res.offline) {
      return setLiveStatus(
        `${res.error || ''} Появится чип, когда автор начнёт эфир — нажмите «Запись трансляции» ещё раз.`,
        'warn'
      );
    }
    return setLiveStatus((res && res.error) || 'Эфир не найден.', 'err');
  }

  const room = res.room;
  if (!room || !Array.isArray(room.streams) || !room.streams.length) {
    liveState.room = null;
    return setLiveStatus('TikTok не отдал ни одного потока для этого эфира.', 'err');
  }
  liveState.room = room;
  const title = room.title || `Эфир @${room.handle}`;
  const viewers = room.viewers ? ` · ${fmtCount(room.viewers)} зрителей` : '';
  setLiveStatus(`@${room.handle} · ${title}${viewers}`);
}

/**
 * Эфиры, найденные на текущей странице, рисуются чипами в общей строке
 * #liveChips. Кандидаты и идущие записи делят одну строку, поэтому чипы
 * кандидатов помечены классом .live-cand и снимаются точечно — записи в
 * #liveChips при этом не трогаются.
 */
function renderLiveCandidates(items) {
  const box = $('#liveChips');
  if (!box) return;
  clearLiveCandidates();
  liveState.pickerItems = items;
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'live-chip live-cand';
    b.textContent = '@' + it.handle;
    b.title = it.title ? `${it.title} — ${it.url}` : it.url;
    b.addEventListener('click', () => {
      clearLiveCandidates();
      resolveAndRecord(it.url);
    });
    box.appendChild(b);
  });
  syncLiveDock();
}

function clearLiveCandidates() {
  liveState.pickerItems = [];
  const box = $('#liveChips');
  if (box) Array.from(box.querySelectorAll('.live-cand')).forEach((el) => el.remove());
  syncLiveDock();
}

/**
 * «Очистить» снимает все чипы из строки #liveChips — и завершённые, и чипы
 * кандидатов — и чистит связанное состояние. Файлы на диске не трогаются: кнопка
 * «Показать» исчезает вместе с чипом, а сам файл остаётся там, куда его положил
 * ffmpeg.
 *
 * Пока идёт запись, кнопка неактивна (это решает syncLiveDock), но проверка
 * продублирована: выключенная кнопка — ещё не гарантия, что её никто не вызовет.
 */
function clearLiveChips() {
  if (liveState.jobs.size > 0) return toast('Сначала остановите запись', 'err');
  clearLiveCandidates();
  const box = $('#liveChips');
  const removed = box ? box.children.length : 0;
  // textContent вместо remove() по каждому чипу: заодно убирает текстовые узлы
  // и всё, что могло остаться в строке от прошлых отрисовок.
  if (box) box.textContent = '';
  liveState.jobs.clear();
  syncLiveDock();
  toast(removed ? `Очищено записей: ${removed}` : 'Список записей и так пуст', 'ok');
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

    const page = res.page || null;
    const pageHandle = page && page.handle ? String(page.handle).toLowerCase() : '';
    // Кандидат с тем же @ником, что и текущая страница, — это и есть тот эфир,
    // на котором пользователь уже стоит: он записывается сразу, клик не нужен.
    const items = (Array.isArray(res.candidates) ? res.candidates : [])
      .filter((c) => c && c.url)
      .filter((c) => !pageHandle || String(c.handle || '').toLowerCase() !== pageHandle)
      .slice(0, 6)
      .map((c) => ({ url: c.url, handle: c.handle || '', title: c.title || '' }));

    if (page) {
      clearLiveCandidates();
      return await resolveAndRecord(page.url);
    }

    // Не на эфире: показываем то, что нашлось на странице, и ждём выбора.
    if (!items.length) {
      clearLiveCandidates();
      return setLiveStatus(
        'Здесь не видно трансляции. Откройте эфир во встроенном браузере — или нажмите сюда ещё раз на странице профиля автора с эфиром.',
        'warn'
      );
    }
    renderLiveCandidates(items);
    setLiveStatus('Выберите эфир чипом слева — или откройте эфир во встроенном браузере.');
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
    clearLiveCandidates();
    if (!res || !res.ok) {
      renderLiveCard(res || { ok: false, error: 'Пустой ответ от main-процесса.' });
      return;
    }
    renderLiveCard(res);
    // Нашли эфир — стартуем сразу, без второго нажатия и без кнопки в карточке.
    return startLiveRecording(res.room);
  } catch (e) {
    setLiveStatus(e.message || String(e), 'err');
  }
}

// One start in flight at a time. A double-click on «Записать» would otherwise
// spawn a second ffmpeg before the first IPC returns — main's re-resolve makes
// that start slower, which widens the window rather than closing it.
let liveStarting = false;

function startLiveRecording(room) {
  if (liveStarting) return;
  liveStarting = true;
const withChat = Boolean($('#liveChatCheck') && $('#liveChatCheck').checked);
  const withAudio = Boolean($('#liveAudioCheck') && $('#liveAudioCheck').checked);
  const mode = $('#liveModeScreen') && $('#liveModeScreen').checked ? 'screen' : 'stream';
  Promise.resolve()
    .then(() => window.api.live.start(room, { withChat, withAudio, mode }))
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
      // Sound in «Экран» comes from a separate process that may fail on its own
      // (stream gone, room ended, no audio track). Warn now rather than let the
      // user find a silent file afterwards.
      if (mode === 'screen' && withAudio && r.withAudio === false) {
        toast('Звук недоступен: эфир не отдаёт аудиопоток. Видео записывается без звука.', 'err');
      }
      toast('Запись началась.', 'ok');
      autoOpenLiveDock();
    })
    .catch((e) => toast(e.message || String(e), 'err'))
    .finally(() => {
      liveStarting = false;
    });
}

function liveModeLabel(m) {
  return m === 'screen' ? 'экран' : 'поток';
}

/**
 * Содержимое чипа записи: @ник · таймер · размер · fps (только «Экран»).
 *
 * Всё это раньше занимало отдельную строку в списке «Идущие записи» и
 * распирало панель по высоте. Теперь строка ровно одна, поэтому чип обрезается
 * по ширине стилями `.live-chip`, а всё, что в одну строку не влезло (режим,
 * диагностика захвата экрана), уходит в его `title`.
 */
function paintLiveChip(job) {
  if (!job || !job.textEl) return;
  const parts = [liveTick(job.startedAt)];
  if (job.downloaded) parts.push(fmtBytes(job.downloaded));
  if (job.resolution) parts.push(job.resolution);
  if (job.mode === 'screen' && Number.isFinite(job.frames)) parts.push(`кадров: ${job.frames}`);
  // Реальная скорость захвата, а не номинальная: «Экран» упирается в то, как
  // быстро capturePage отдаёт кадры, и именно это число отвечает на вопрос,
  // будет запись похожа на видео или на слайд-шоу.
  if (job.mode === 'screen' && Number.isFinite(job.fps)) parts.push(`${job.fps.toFixed(1)} кадр/с`);
  if (job.chat) parts.push(`чата: ${job.chat}`);
  const text = `${job.handle ? '@' + job.handle + ' · ' : ''}${parts.join(' · ')}`;
  job.textEl.textContent = text;
  if (job.chipEl) {
    const head = `${liveModeLabel(job.mode)} · ${text}`;
    // Жёлтая диагностика capturePage уходит в title чипа: раньше она была
    // отдельной строкой и растягивала панель.
    job.chipEl.title = job.note ? `${head}\n${job.note}` : head;
  }
}

function addLiveJob(id, room, mode) {
  if (liveState.jobs.has(id)) return liveState.jobs.get(id);
  const box = $('#liveChips');

  const chip = document.createElement('span');
  chip.className = 'live-chip is-live';
  const text = document.createElement('span');
  text.className = 'live-chip-text';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn small';
  btn.textContent = '✕';
  btn.title = 'Остановить запись';
  btn.addEventListener('click', () => window.api.live.stop(id));
  chip.appendChild(text);
  chip.appendChild(btn);
  if (box) box.appendChild(chip);

  const job = {
    id,
    chipEl: chip,
    textEl: text,
    btnEl: btn,
    startedAt: Date.now(),
    handle: room.handle,
    mode: mode === 'screen' ? 'screen' : 'stream',
    // roomId links this chip to the chat messages main routes to it.
    roomId: room.roomId ? String(room.roomId) : '',
    downloaded: 0,
    resolution: '',
    frames: null,
    fps: null,
    note: '',
    chat: 0,
  };
  liveState.jobs.set(id, job);
  paintLiveChip(job);
  syncLiveDock();
  return job;
}

function dropLiveJob(id) {
  const job = liveState.jobs.get(id);
  if (job && job.chipEl) job.chipEl.remove();
  liveState.jobs.delete(id);
  syncLiveDock();
}

/**
 * Завершённая запись остаётся в строке как чип с рамкой «сохранено» и кнопкой
 * «Показать», ровно как завершённая загрузка в очереди. Авто-открытие Проводника
 * здесь было бы окном на каждую закончившуюся запись.
 */
function finishLiveJob(r) {
  const job = liveState.jobs.get(r.id);
  if (!job) return;
  liveState.jobs.delete(r.id);

  if (job.chipEl) {
    job.chipEl.classList.remove('is-live');
    job.chipEl.classList.add('is-done');
  }
  // r.chat is normally the { count, ... } object from main finishChat();
  // never interpolate it directly — that prints "[object Object]".
  let chatPart = '';
  if (r.chat && typeof r.chat === 'object') {
    chatPart = ` · чата: ${Number(r.chat.count) || 0}`;
  } else if (typeof r.chat === 'number' && Number.isFinite(r.chat)) {
    chatPart = ` · чата: ${r.chat}`;
  }
  const text =
    `@${r.handle || job.handle || ''} · ${fmtDuration(r.elapsedSec)} · ${fmtBytes(r.size)}` +
    chatPart +
    // Screen mode decides the sound question only at the very end, when the two
    // ffmpeg runs are merged — so this is the first and only honest place to
    // state it.
    (r.mode === 'screen' ? (r.hasAudio ? ' · со звуком' : ' · без звука') : '') +
    (r.reason ? ` · ${r.reason.charAt(0).toLowerCase() + r.reason.slice(1)}` : '');
  if (job.textEl) job.textEl.textContent = text;
  if (job.chipEl) job.chipEl.title = `${liveModeLabel(r.mode || job.mode)} · ${text}`;

  // Кнопку пересоздаём, а не переиспользуем: у идущей записи на ней висит
  // live.stop(id), и оставлять её рядом с «Показать» было бы вторым обработчиком.
  if (job.btnEl) {
    const revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'btn small';
    revealBtn.textContent = 'Показать';
    revealBtn.title = r.path || 'Открыть папку с записью';
    revealBtn.addEventListener('click', () => window.api.settings.reveal(r.path));
    job.btnEl.replaceWith(revealBtn);
    job.btnEl = revealBtn;
  }

  syncLiveDock();
  toast(`Запись сохранена: ${r.handle ? '@' + r.handle + ' · ' : ''}${fmtBytes(r.size)}`, 'ok');
}

// Everything below only WIRES the live tab up. If the preload ever ships without
// the `live` namespace — a stale preload against a new renderer, or a partially
// failed update — an unguarded `window.api.live.onProgress(...)` throws a
// TypeError at module top level, and that aborts the REST of renderer.js
// including boot(), which blacks out the whole window. This project has been
// bitten by exactly that shape of bug before, so the wiring is skipped instead.
if (window.api && window.api.live) {
  const recBtn = $('#liveRecBtn');
  if (recBtn) {
    recBtn.addEventListener('click', () => {
      recordCurrentLive().catch((e) => setLiveStatus(e.message || String(e), 'err'));
    });
  }
const clearBtn = $('#liveClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearLiveChips);
  syncLiveDock();

  // Отдельной строки-подсказки больше нет: объяснение режима уезжает в title
  // статус-строки, чтобы панель оставалась высотой ровно в одну строку.
  // «Чат» и «звук» — это не самостоятельные переключатели, а часть выбранного
  // режима, поэтому живут в одной функции вместе с подсказкой статуса.
  //  - «Поток» пишется с CDN целиком: звук там уже есть по определению, а чат
  //    всё равно снимается отдельным перехватом. Оба входа в этом режиме
  //    бессмысленны — гасим их, чтобы не предлагать недоступное.
  //  - «Экран» берёт звук из гостя через setDisplayMediaRequestHandler и пишет
  //    его отдельной дорожкой, поэтому здесь оба входа осмысленны и включаются.
  // Отметки при уходе в «Поток» НЕ сбрасываем: `.checked` у disabled-инпута
  // читается из JS как обычно, иначе возврат к «Экрану» терял бы настройки.
  // `.checked` также читается в startLiveRecording, поэтому синхронизация
  // обязана завершиться до старта записи — она и вызывается оттуда же.
  const syncLiveModeInputs = () => {
    const isScreen = Boolean($('#liveModeScreen') && $('#liveModeScreen').checked);
    const chat = $('#liveChatCheck');
    const audio = $('#liveAudioCheck');
    if (chat) {
      chat.disabled = !isScreen;
      if (isScreen) chat.checked = true;
    }
    if (audio) {
      audio.disabled = !isScreen;
      if (isScreen) audio.checked = true;
    }
  };
  const syncLiveModeHint = () => {
    const el = $('#liveStatus');
    if (!el) return;
    el.title =
      $('#liveModeScreen') && $('#liveModeScreen').checked
        ? 'Экран: записывается окно страницы — видео, зрители и чат. Не сворачивайте окно и не переключайте вкладки. Скорость зависит от нагрузки, обычно 5–15 кадров в секунду. Звук пишется отдельно и приклеивается в конце.'
        : 'Поток: пишется чистое видео эфира с CDN вместе со звуком. Качество максимальное. Можно переключаться на другие вкладки.';
    syncLiveModeInputs();
  };
  if ($('#liveModeStream')) $('#liveModeStream').addEventListener('change', syncLiveModeHint);
  if ($('#liveModeScreen')) $('#liveModeScreen').addEventListener('change', syncLiveModeHint);
  syncLiveModeHint();

  window.api.live.onProgress((p) => {
    const job = liveState.jobs.get(p.id);
    if (!job) return;
    if (p.handle) job.handle = p.handle;
    if (p.downloaded) job.downloaded = p.downloaded;
    if (p.resolution) job.resolution = p.resolution;
    if (Number.isFinite(p.frames)) job.frames = p.frames;
    if (Number.isFinite(p.fps)) job.fps = p.fps;
    // `note` is the tail of the main process's screen-capture journal. It exists
    // because screen mode failed three rounds of static analysis: the chip alone
    // ("подключение…") cannot say whether capturePage hangs, returns blanks, or
    // ffmpeg refuses the audio input. It goes into the chip's title — a fact the
    // user can screenshot, without growing the panel by a line.
    if (p.mode === 'screen' && p.note) job.note = p.note;
    paintLiveChip(job);
    // The per-chip stop button is deliberately left ENABLED here. Disabling it on
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
      paintLiveChip(job);
    }
  });

  window.api.live.onDone((r) => {
    finishLiveJob(r);
  });

  window.api.live.onError(({ id, message }) => {
    // A recording the user no longer sees is gone from the map; its late error
    // must not pop a toast about something that is off the screen.
    if (!liveState.jobs.has(id)) return;
    dropLiveJob(id);
    toast(message || 'Запись прервана', 'err');
  });
} else {
  const box = $('#liveStatus');
  if (box) box.textContent = 'Запись эфиров недоступна: перезапустите приложение.';
}

// «Обновить страницу» — перезагрузка встроенного браузера на месте. Раньше
// непрогрузившуюся ленту можно было вылечить только перезапуском приложения.
// `reload()` на <webview> сохраняет текущий URL, поэтому открытый эфир или ролик
// остаются там же; если гостя ещё нет, он просто создаётся. Кнопка работает с
// любой вкладки: перезагружать скрытый webview не мешает, а ждать перехода на
// «Обзор» не нужно.
$('#reloadWebBtn').addEventListener('click', () => {
  const wv = state.webview;
  if (!wv) {
    mountWebview();
    toast('Страница загружается', 'ok');
    return;
  }
  try {
    wv.reload();
    toast('Страница обновляется', 'ok');
  } catch (e) {
    toast('Не удалось обновить страницу: ' + (e && (e.message || e)), 'err');
  }
});

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
  if (p.sources?.length) {
    facts.push([
      'Источники региона',
      p.sources.map((x) => `${x.label}: ${x.value || '—'}`).join(' · '),
    ]);
  }
  if (p.apiHost) {
    facts.push(['Кластер API', `${p.market === 'alisg' ? 'Азия/ЛатАм' : 'Европа/Америка'} · ${p.apiHost}`]);
  }
  if (r.bypass?.regionHeaders?.length) {
    facts.push(['Заголовки региона', r.bypass.regionHeaders.join(', ')]);
  }
  $('#geoFacts').innerHTML = facts
    .map(([k, val]) => `<div class="fact"><span>${escapeHtml(k)}</span><b>${escapeHtml(val)}</b></div>`)
    .join('');

  const notes = [...(r.notes || []), ...((r.audit && r.audit.problems) || [])];
  $('#geoNotes').innerHTML = notes.length
    ? notes.map((n) => `<div class="note ${n.level}"><b>${LEVEL_LABEL[n.level] || ''}</b> ${escapeHtml(n.text)}</div>`).join('')
    : '';

  const s = state.settings || {};
  $('#geoRegion').value = s.regionProfile || s.region || '';
  $('#geoTimezone').value = s.timezone || '';
  $('#geoProxy').value = s.proxy || '';
  $('#geoBypassMode').value = p.mode || 'roaming';
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

$('#geoBypassMode').addEventListener('change', async (e) => {
  const mode = e.target.value;
  try {
    await window.api.geo.setBypass({ mode });
    const s = await window.api.settings.get();
    state.settings = s;
    fillSettings(s);
    await refreshGeo();
    toast(`Режим обхода: ${e.target.selectedOptions[0]?.textContent || mode}`, 'ok');
  } catch (err) {
    toast('Не удалось сменить режим: ' + err.message, 'err');
    await refreshGeo();
  }
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