'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const binaries = require('./binaries');
const settings = require('./settings');

const running = new Map(); // id -> ChildProcess

// ---------- arg building ----------

function extractorArgs(s) {
  // Only pass api_hostname when the user asked for a specific host. yt-dlp
  // defaults to the *mobile* API (api16-normal-c-useast1a.tiktokv.com), which
  // answers with an empty X-Argus and therefore needs no request signing.
  // Forcing www.tiktok.com here pushed yt-dlp onto the signed web path, which
  // is far more likely to hit the WAF challenge and geo blocks.
  const parts = [];
  const host = String(s.apiHostname || '').trim();
  if (host) parts.push('tiktok:api_hostname=' + host);
  if (s.appInfo) parts.push('tiktok:app_info=' + s.appInfo);
  if (s.deviceId) parts.push('tiktok:device_id=' + s.deviceId);
  return parts.length ? ['--extractor-args', parts.join(',')] : [];
}

function netArgs(s) {
  const args = [];
  if (s.proxy) args.push('--proxy', s.proxy.trim());
  if (s.cookiesFromBrowser && s.cookiesFromBrowser !== 'none') {
    args.push('--cookies-from-browser', s.cookiesFromBrowser);
  } else if (s.cookieFile) {
    args.push('--cookies', s.cookieFile);
  }
  if (s.navigatorLanguage) parts_push_lang(args, s.navigatorLanguage);
  // NOTE: yt-dlp has no --timezone option (the only geo flags it accepts are
  // --geo-bypass and --geo-verification-proxy). Passing one made every call die
  // with "no such option: --timezone". The timezone reaches TikTok through the
  // TZ environment variable below instead.
  return args;
}

// yt-dlp (and the Python runtime under it) reads the local timezone from TZ,
// so the emulated region stays consistent for Date-based logic and for any
// header built from it.
function envFor(s) {
  return s.timezone ? { ...process.env, TZ: s.timezone } : process.env;
}

function parts_push_lang(args, lang) {
  // yt-dlp passes browser options through --extractor-args for some sites;
  // for TikTok we only need the Accept-Language, exposed via --http-headers
  args.push('--http-headers', `Accept-Language:${lang}`);
}

// The only reliable way to exclude the watermarked variant.
//
// Measured on yt-dlp 2026.08.19 against a live TikTok video:
//   b[format_note!*=watermark]  -> ERROR: Requested format is not available
//   b[format_note!*=watermarked!] -> yt-dlp crashes with a Python traceback
// Reason: every clean TikTok format arrives with NO format_note field, and
// yt-dlp treats a missing field as a non-match, so a filter on format_note
// rejects all of them. The previous selector therefore failed on every link
// of its chain and silently fell through to a bare /best, i.e. the watermark
// filter never actually ran.
//
// The watermarked format is instead identifiable by format_id == 'download'
// (yt-dlp marks it preference -2) — see _extract_web_formats in
// yt_dlp/extractor/tiktok.py. Filtering on it works.
const CLEAN = '[format_id!=download]';
const CLEAN_H264 = `${CLEAN}[format_id^=h264]`;

// Fallback chain for video. Each link is safe on its own: no bare /best at
// the end, because /best would happily take the watermarked download format
// when it is present (yt-dlp#9704).
function videoSelector(cap, { preferH265 = false } = {}) {
  if (preferH265) {
    return [
      `bv*${CLEAN}[format_id^=bytevc1]${cap}+ba`,
      `bv*${CLEAN}[format_id^=bytevc1]${cap}`,
      `bv*${CLEAN}[format_id^=bytevc1]`,
      `bv*${CLEAN}${cap}`,
      `bv*${CLEAN}`,
    ].join('/');
  }
  // h264 first: TikTok's bytevc1 is HEVC, which many players and editors
  // refuse, and h264_540p_* already carries the highest bitrate.
  // The height cap is applied per link, never to the whole chain, because
  // "[height<=720]" alone matches nothing (the 540p formats report 1024p).
  return [
    `bv*${CLEAN_H264}${cap}+ba`,
    `bv*${CLEAN_H264}${cap}`,
    `bv*${CLEAN_H264}`,
    `bv*${CLEAN}${cap}`,
    `bv*${CLEAN}`,
  ].join('/');
}

function formatSelector(s) {
  if (s.audioOnly) return `ba[format_id!=download]/bestaudio`;
  const h = Number(s.maxHeight) || 0;
  const cap = h > 0 ? `[height<=${h}]` : '';
  const preferH265 = !!s.preferH265;
  switch (s.format) {
    case 'worst':
      return `wv*${CLEAN}${cap}/worst${cap}/worst`;
    case 'custom':
      return s.customFormat || videoSelector(cap, { preferH265 });
    case 'best-no-watermark':
    case 'best':
    default:
      return videoSelector(cap, { preferH265 });
  }
}

function baseArgs(s, { simulate = false } = {}) {
  // --progress is required: yt-dlp suppresses progress in non-TTY contexts
  // unless it is set explicitly, which would leave the UI with no updates.
  const args = ['--no-colors', '--ignore-config', '--no-warnings', '--progress', '--newline'];
  args.push(...extractorArgs(s));
  args.push(...netArgs(s));
  args.push('-f', formatSelector(s));
  args.push('--merge-output-format', 'mp4');
  if (simulate) {
    args.push('--simulate', '--dump-single-json');
  }
  if (s.writeThumbnail) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  if (s.writeInfoJson) args.push('--write-info-json');
  if (!binaries.ffmpeg()) args.push('--no-check-certificates');
  return args;
}

function outputTemplate(s, extra) {
  // Sanitize the NAME template only. Sanitizing the joined path also
  // rewrote the directory separators, so yt-dlp was handed
  // "C__Users_<name>_Downloads_TikTokMod_%(uploader)s - ..." and every saved
  // file literally started with the flattened download path.
  const name = extra || '%(uploader)s - %(title).100s [%(id)s].%(ext)s';
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return path.join(s.downloadDir, safe);
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'download';
}

// ---------- process helpers ----------

function runJson(url, s, { timeout = 45000 } = {}) {
  const exe = binaries.ytdlp();
  if (!exe) return Promise.reject(new Error('yt-dlp не найден'));

  const args = baseArgs(s, { simulate: true });
  args.push('--no-playlist', '--playlist-items', '1', url);

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Таймаут запроса к TikTok. Проверьте прокси и cookies.'));
    }, timeout);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('Не удалось запустить yt-dlp: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = out.trim();
      if (code === 0 && trimmed && trimmed !== 'null') {
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          reject(new Error('Некорректный JSON от yt-dlp'));
        }
        return;
      }
      reject(new Error(humanError(err) || `yt-dlp завершился с кодом ${code}`));
    });
  });
}

// Turns yt-dlp stderr into something actionable for the UI.
function humanError(stderr) {
  const t = String(stderr || '');
  const pick = (needle, msg) => (t.includes(needle) ? msg : null);
  return (
    pick('Your IP address is blocked', 'IP заблокирован TikTok. Укажите прокси в настройках (или импортируйте cookies браузера).') ||
    pick('Sign up to confirm you', 'TikTok требует подтверждение аккаунта. Импортируйте cookies из браузера.') ||
    pick('confirm your age', 'Контент ограничен по возрасту. Импортируйте cookies из браузера.') ||
    pick('Unable to extract', 'Не удалось извлечь данные. Попробуйте другой прокси или обновите yt-dlp.') ||
    pick('HTTP Error 403', 'Доступ запрещён (403). Нужен другой прокси или cookies.') ||
    pick('HTTP Error 429', 'TikTok временно ограничил запросы (429). Смените прокси и повторите.') ||
    pick('Video unavailable', 'Видео недоступно или удалено.') ||
    pick('Private', 'Видео приватное.') ||
    pick('Private video', 'Видео приватное.') ||
    pick('geo', 'Гео-ограничение: контент недоступен для текущего региона/IP.') ||
    pick('proxy', 'Ошибка прокси. Проверьте адрес и порт.') ||
    t.split('\n').filter(Boolean).slice(-1)[0] ||
    ''
  );
}

// ---------- public API ----------

async function probe(url, s) {
  const info = await runJson(url, s);
  return normalizeInfo(info);
}

async function probeBatch(urls, s, { concurrency = 3, onEach } = {}) {
  const list = [...new Set(urls.filter(Boolean))];
  const results = [];
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        const info = await runJson(url, s);
        const n = normalizeInfo(info);
        results.push(n);
        if (onEach) onEach(n);
      } catch (e) {
        results.push({ url, id: extractId(url), error: e.message });
        if (onEach) onEach({ url, id: extractId(url), error: e.message });
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, 8));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

function normalizeInfo(info) {
  const formats = (info.formats || []).map((f) => ({
    formatId: f.format_id,
    ext: f.ext,
    note: f.format_note || null,
    height: f.height || null,
    fps: f.fps || null,
    vcodec: f.vcodec || null,
    acodec: f.acodec || null,
    filesize: f.filesize || f.filesize_approx || null,
    // A format is the watermarked one if yt-dlp says so (format_note), or if it
    // is the download variant that the web extractor marks preference -2.
    // Checking only format_note missed the case where the note is absent.
    watermarked:
      /watermark/i.test(f.format_note || '') || f.format_id === 'download' || f.preference === -2
        ? true
        : undefined,
  }));
  return {
    id: info.id,
    url: info.webpage_url || info.original_url,
    title: info.title || 'TikTok',
    description: info.description || '',
    uploader: info.uploader || info.uploader_id || '',
    uploaderUrl: info.uploader_url || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || null,
    viewCount: info.view_count ?? null,
    likeCount: info.like_count ?? null,
    commentCount: info.comment_count ?? null,
    uploadDate: info.upload_date || null,
    width: info.width || null,
    height: info.height || null,
    ext: info.ext || 'mp4',
    filesize: info.filesize || info.filesize_approx || null,
    extractor: info.extractor_key || info.extractor || null,
    formats,
  };
}

const ID_RE = /(?:video|photo|v)\/(\d{6,})|aweme_id=(\d{6,})|aweme\/v1\/(\d{6,})/;

function extractId(url) {
  const m = String(url || '').match(ID_RE);
  return m ? m[1] || m[2] || m[3] : null;
}

function isTikTokUrl(url) {
  return /(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|musical\.ly)/i.test(String(url || ''));
}

/**
 * Tells apart the kinds of TikTok link the user can paste.
 *
 * Only 'video' (and a short link that redirects to one) can be handed to
 * yt-dlp directly. A feed, profile, hashtag or sound page has no media of its
 * own — yt-dlp answers "Unsupported URL", and the raw message leaves the user
 * with no idea what to do. Classifying first lets us say what the link is and
 * point at the tab that can actually handle it.
 *
 * Returns { kind, id, handle, tag } where kind is one of:
 *   video | short | feed | profile | hashtag | sound | other
 */
function classifyUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return { kind: 'empty', id: null };

  const id = extractId(raw);
  if (id) return { kind: 'video', id };

  // vm./vt. tiktok.com short links carry no id in the text: yt-dlp follows the
  // redirect, so let them through.
  if (/(?:vm|vt)\.tiktok\.com\/\w+/i.test(raw)) return { kind: 'short', id: null };

  if (!isTikTokUrl(raw)) return { kind: 'other', id: null };

  let path = raw;
  try {
    path = new URL(raw.includes('://') ? raw : `https://${raw}`).pathname;
  } catch {
    path = raw;
  }
  const clean = path.replace(/\/+$/, '') || '/';

  if (/^\/(foryou|following|explore|discover|search|recommend|feed|favorites)(\/|$)/i.test(clean)) {
    return { kind: 'feed', id: null };
  }
  if (/^\/tag\//i.test(clean)) return { kind: 'hashtag', id: null, tag: clean.split('/')[2] || '' };
  if (/^\/music\//i.test(clean)) return { kind: 'sound', id: null };

  const handle = clean.match(/^\/@([\w.-]+)(?:\/(?!video\/|photo\/)[^/]*)*$/i);
  if (handle) return { kind: 'profile', id: null, handle: handle[1] };

  // Bare host or '/' is the For You feed.
  if (clean === '/' || /^\/(tiktok|)(?:\/|$)/i.test(clean)) return { kind: 'feed', id: null };

  return { kind: 'other', id: null };
}

/** Human-readable explanation for a link that is not a single video. */
function explainUnsupported(url) {
  const c = classifyUrl(url);
  switch (c.kind) {
    case 'feed':
      return 'Это лента TikTok (рекомендации), а не отдельное видео — скачать её целиком нельзя. ' +
        'Откройте вкладку «Обзор», дождитесь загрузки ленты и нажмите «Собрать видео из ленты»: ' +
        'приложение соберёт список роликов, и их можно будет скачать по одному или все сразу.';
    case 'profile':
      return `Это страница автора @${c.handle}, а не видео. Откройте вкладку «Автор» и вставьте ссылку туда — ` +
        'приложение покажет все видео автора и позволит скачать их. Один ролик можно скачать, скопировав его адрес из браузера.';
    case 'hashtag':
      return `Это страница хештега #${c.tag || ''}, а не видео. Откройте вкладку «Обзор», загрузите этот хештег и нажмите «Собрать видео из ленты».`;
    case 'sound':
      return 'Это страница звука, а не видео. Откройте вкладку «Обзор», загрузите страницу звука и нажмите «Собрать видео из ленты».';
    case 'other':
      return 'Похоже, это не ссылка на видео TikTok. Нужен адрес вида https://www.tiktok.com/@user/video/1234567890';
    case 'empty':
      return 'Вставьте ссылку на видео TikTok.';
    default:
      return 'Не удалось извлечь ID видео из ссылки.';
  }
}

/** True when yt-dlp can be pointed at this URL directly. */
function isDownloadableUrl(url) {
  const k = classifyUrl(url).kind;
  return k === 'video' || k === 'short';
}

function startDownload(id, url, s, { onProgress, onDone, onError } = {}) {
  const exe = binaries.ytdlp();
  if (!exe) {
    onError?.('yt-dlp не найден');
    return { id: null };
  }

  const args = baseArgs(s);
  args.push('--paths', s.downloadDir);
  args.push('-o', outputTemplate(s));
  args.push('--newline', '--progress-template', 'PROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._percent_str)s|%(info._filename)s');
  args.push('--no-playlist');
  args.push('--print', 'after_move:DONE|%(filepath)s|%(filesize)s');
  args.push(url);

  // spawn() fails with ENOENT when cwd does not exist
  try {
    fs.mkdirSync(s.downloadDir, { recursive: true });
  } catch {}

  const child = spawn(exe, args, { windowsHide: true, cwd: s.downloadDir, env: envFor(s) });
  running.set(id, child);

  const startedAt = Date.now();
  let stderrTail = '';
  let lastFile = null;

  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line.startsWith('PROG|')) {
        const [, status, dl, total, est, , filename] = line.split('|');
        const totalBytes = Number(total) || Number(est) || 0;
        const downloaded = Number(dl) || 0;
        onProgress?.({
          id,
          status: status === 'finished' ? 'merging' : 'downloading',
          percent: totalBytes ? downloaded / totalBytes : 0,
          downloaded,
          total: totalBytes,
          eta: Math.max(0, (Date.now() - startedAt) / 1000),
          filename: filename || null,
        });
      } else if (line.startsWith('DONE|')) {
        const [, filepath, filesize] = line.split('|');
        // %(filesize)s can be NA (unknown at print time) — prefer the real stat.
        let size = Number(filesize) || 0;
        if (!size && filepath) {
          try {
            size = fs.statSync(filepath).size;
          } catch {}
        }
        lastFile = { path: filepath, size };
      }
    }
  });

  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });

  child.on('error', (e) => {
    running.delete(id);
    onError?.('Ошибка запуска: ' + e.message);
  });

  child.on('close', (code) => {
    running.delete(id);
    if (code === 0 && lastFile) {
      onDone?.({ id, ...lastFile, sidecars: collectSidecars(lastFile.path, s) });
    } else {
      onError?.(humanError(stderrTail) || `yt-dlp завершился с кодом ${code}`);
    }
  });

  return { id };
}

function collectSidecars(filepath, s) {
  if (!filepath) return [];
  const dir = path.dirname(filepath);
  const base = path.basename(filepath).replace(/\.[^.]+$/, '');
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(base) && name !== path.basename(filepath)) {
        out.push(path.join(dir, name));
      }
    }
  } catch {}
  return out;
}

function cancel(id) {
  const child = running.get(id);
  if (!child) return false;
  try {
    child.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 3000);
  running.delete(id);
  return true;
}

function cancelAll() {
  for (const id of [...running.keys()]) cancel(id);
}

function version() {
  const exe = binaries.ytdlp();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(exe, ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(out.trim() || null));
    child.on('error', () => resolve(null));
  });
}

module.exports = {
  probe,
  probeBatch,
  startDownload,
  cancel,
  cancelAll,
  version,
  extractId,
  isTikTokUrl,
  classifyUrl,
  isDownloadableUrl,
  explainUnsupported,
  humanError,
  // exported for the selftest: both used to silently push yt-dlp onto the
  // signed web endpoint, which is the single most likely cause of geo failures
  extractorArgs,
  baseArgs,
  // exported for the selftest: the format selector had to be verified against
  // a real yt-dlp because "looks right" silently dropped the watermark filter
  formatSelector,
  runningCount: () => running.size,
};