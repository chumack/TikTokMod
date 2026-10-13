'use strict';

// Recording of TikTok LIVE broadcasts.
//
// Why this does not use yt-dlp, which already ships with the app and does have
// a TikTokLiveIE: every maintained recorder out there resolves the broadcast
// itself and hands a plain media URL to ffmpeg — Michele0303/TikTok-Live-Recorder
// (src/core/tiktok_api.py), ihmily/DouyinLiveRecorder (src/stream.py) and
// tiktool/tiktok-live-recorder (node/dist/chunk-*.mjs) all do exactly these two
// steps:
//
//   1. resolve the broadcast to an HTTP(S) media URL
//        GET www.tiktok.com/api-live/user/room/?uniqueId=…&sourceType=54
//        GET webcast.tiktok.com/webcast/room/info/?aid=1988&room_id=…
//   2. spawn ffmpeg -c copy on that URL
//
// yt-dlp's own live path goes through the signed API first, which is the first
// thing that starts 403ing, and it is built for one-shot downloads rather than
// for a capture that has to survive an arbitrary number of hours.
//
// The WebSocket branch of the protocol (pull_data…wsUrl) carries chat/gift/like
// events, not media — there is nothing to record there.
//
// Everything runs over Electron's Chromium stack on session.defaultSession, the
// same session the embedded TikTok browser uses, so the user's proxy and cookies
// are reused without any reimplementation. That is not a convenience: TikTok
// binds live rooms to a region, so resolving from a different egress returns
// status_code 4003110 ("restricted") or an empty stream object.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { session } = require('electron');
const binaries = require('./binaries');
const ttapi = require('./ttapi');

// The web client UA. The app itself is Electron, but the webcast endpoints are a
// plain web API and answer a normal Chrome UA; the cookie jar does not care
// which UA obtained the cookies.
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// A live stream has no total length, so there is no percent to report. Progress
// is "elapsed + bytes so far", parsed out of ffmpeg's own stderr summary line.
const PROGRESS_EVERY_MS = 1000;

// Give up if the file stops growing. A broadcast that ended leaves the CDN
// connection open with no data, and without this the capture would sit at
// "recording" forever.
const STALL_POLL_MS = 10000;
const STALL_LIMIT_MS = 120000;

const running = new Map(); // id -> job

// ---------- url / input parsing ----------

/**
 * Accepts a full live URL, a profile URL, a bare @handle or a bare handle.
 * Returns { handle, roomId } or { error }.
 */
function parseTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Укажите ссылку на эфир, например https://www.tiktok.com/@nick/live' };

  const fromUrl = raw.match(/tiktok\.com\/@([A-Za-z0-9._-]+)(?:\/live(?:\/(\d{5,}))?)?/i);
  if (fromUrl) return { handle: fromUrl[1], roomId: fromUrl[2] || '' };

  // Anything that looks like a URL, a path or a sentence is a paste mistake, not
  // a handle. The bare form has to match the WHOLE string — a prefix match would
  // turn "hello world" into @hello and "https://youtube.com/x" into @https,
  // which then fails much later as a bogus "@https is not live".
  if (/[:/?#\s]/.test(raw)) {
    return {
      error:
        'Это не похоже на ссылку TikTok. Нужен адрес автора: https://www.tiktok.com/@nick/live или просто @nick.',
    };
  }
  const bare = raw.replace(/^@+/, '').match(/^([A-Za-z0-9._-]{1,40})$/);
  if (bare) return { handle: bare[1], roomId: '' };

  return { error: 'Не удалось разобрать ссылку. Нужен адрес автора, например https://www.tiktok.com/@nick/live' };
}

// ---------- transport ----------

function regionOf(s) {
  const r = String((s && (s.regionProfile || s.region)) || 'US').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(r) ? r : 'US';
}

/**
 * The web client's standard query bag. Mirrors DEFAULT_HTTP_CLIENT_PARAMS in
 * zerodytrash/TikTok-Live-Connector — TikTok rejects the webcast endpoints when
 * the device fingerprint is missing, and region/priority_region must agree with
 * the proxy actually in use or the room comes back restricted.
 */
function webParams(s, extra) {
  let tz = 'Europe/Berlin';
  let lang = 'en';
  let deviceId = '';
  try {
    const ctx = ttapi.context(s);
    tz = ctx.profile.timezone || tz;
    lang = ctx.profile.language || lang;
    deviceId = ctx.ident.device_id || '';
  } catch {}
  const region = regionOf(s);
  return {
    aid: 1988,
    app_language: lang,
    app_name: 'tiktok_web',
    browser_language: `${lang}-${region}`,
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: '5.0 (Windows)',
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    device_id: deviceId,
    device_platform: 'web_pc',
    language: lang,
    os: 'windows',
    priority_region: region,
    region,
    screen_height: 1080,
    screen_width: 1920,
    tz_name: tz,
    ...extra,
  };
}

/**
 * The webcast endpoints want the region cookie the web client normally sets.
 * Best-effort — a failure here must never abort the resolve.
 *
 * tt-target-idc picks a CDN POP and is region-specific (useast1a, euwest1a, …).
 * Hard-coding the US-East value — which is what the reference connectors do —
 * actively fights the user's own proxy and is a direct route to the 4003110
 * "restricted" answer this code is trying to avoid. The embedded TikTok browser
 * has already set the correct POP for whatever egress it uses, so this only
 * fills the value in when the cookie is missing entirely, and never overwrites
 * it.
 */
async function seedSession(s) {
  const cookies = session.defaultSession.cookies;
  const expiry = Math.floor(Date.now() / 1000) + 86400 * 30;
  try {
    const existing = await cookies.get({ name: 'tt-target-idc', url: 'https://www.tiktok.com/' });
    if (!existing || !existing.length) {
      await cookies.set({
        url: 'https://www.tiktok.com/',
        name: 'tt-target-idc',
        value: 'useast1a',
        expirationDate: expiry,
      });
    }
  } catch {}
  try {
    await cookies.set({
      url: 'https://www.tiktok.com/',
      name: 'store-country-code',
      value: regionOf(s).toLowerCase(),
      expirationDate: expiry,
    });
  } catch {}
}

async function webJson(url, { s, timeout = 20000 } = {}) {
  await seedSession(s);
  const region = regionOf(s);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': WEB_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': `${region},en;q=0.9`,
        Referer: 'https://www.tiktok.com/',
        Origin: 'https://www.tiktok.com',
      },
      session: session.defaultSession,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`TikTok не ответил за ${Math.round(timeout / 1000)} с. Проверьте прокси и сеть.`);
    }
    throw new Error(`Сеть недоступна: ${e.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TikTok ответил HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('TikTok вернул не-JSON ответ — смените прокси или обновите приложение.');
  }
}

// ---------- stream extraction ----------

/**
 * room/info -> data.stream_url carries the media URLs twice over.
 *
 * Preferred shape: live_core_sdk_data.pull_data.stream_data, a JSON *string*
 * holding {data:{<sdk_key>:{main:{flv,hls},sdk_params}}}, ranked by
 * live_core_sdk_data.pull_data.options.qualities[].level.
 *
 * Legacy shape, still served: flv_pull_url.{FULL_HD1,HD1,SD2,SD1} and a flat
 * hls_pull_url. Both are read so a change on TikTok's side degrades to "worse
 * quality" instead of "no recording".
 */
function parseStreams(su) {
  const out = [];

  const levels = new Map();
  const quals = su && su.live_core_sdk_data && su.live_core_sdk_data.pull_data && su.live_core_sdk_data.pull_data.options
    ? su.live_core_sdk_data.pull_data.options.qualities
    : null;
  if (Array.isArray(quals)) {
    for (const q of quals) {
      if (q && q.sdk_key) levels.set(String(q.sdk_key), Number(q.level) || 0);
    }
  }

  let parsed = null;
  try {
    const raw = su && su.live_core_sdk_data && su.live_core_sdk_data.pull_data
      ? su.live_core_sdk_data.pull_data.stream_data
      : null;
    // Documented as a JSON *string*, but if TikTok ever hands back an object
    // JSON.parse() would throw and silently drop every SDK stream, degrading to
    // legacy without a trace. Accept both.
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw && typeof raw === 'object' ? raw : null;
  } catch {}
  const groups = parsed && typeof parsed === 'object' && parsed.data ? parsed.data : null;

  // TIER separates the two scales. SDK levels are small integers while the legacy
  // ranks below are hand-picked tens — sorting them together in one `level` would
  // make any legacy URL beat any SDK URL regardless of real quality.
  const TIER_SDK = 2;
  const TIER_LEGACY = 1;
  const TIER_FLAT = 0;

  if (groups) {
    for (const [key, group] of Object.entries(groups)) {
      const main = group && group.main;
      if (!main) continue;
      let params = null;
      try {
        const sp = group.sdk_params;
        params = typeof sp === 'string' ? JSON.parse(sp || 'null') : sp && typeof sp === 'object' ? sp : null;
      } catch {}
      out.push({
        label: key === 'ORIGIN' ? 'origin' : String(key).toLowerCase(),
        tier: TIER_SDK,
        level: levels.has(key) ? levels.get(key) : 0,
        resolution: String((params && params.resolution) || ''),
        codec: String((params && params.VCodec) || ''),
        flv: typeof main.flv === 'string' ? main.flv : '',
        hls: typeof main.hls === 'string' ? main.hls : '',
      });
    }
  }

  const legacy = su && su.flv_pull_url;
  if (legacy && typeof legacy === 'object') {
    const rank = { FULL_HD1: 40, HD1: 30, SD2: 20, SD1: 10 };
    for (const [k, v] of Object.entries(legacy)) {
      if (typeof v === 'string' && v) {
        out.push({
          label: String(k).toLowerCase().replace(/_/g, ''),
          tier: TIER_LEGACY,
          level: rank[k] || 0,
          resolution: '',
          codec: '',
          flv: v,
          hls: '',
        });
      }
    }
  }
  if (su && typeof su.hls_pull_url === 'string' && su.hls_pull_url) {
    out.push({ label: 'hls', tier: TIER_FLAT, level: 0, resolution: '', codec: '', flv: '', hls: su.hls_pull_url });
  }

  const seen = new Set();
  const flat = [];
  for (const g of out) {
    for (const kind of ['flv', 'hls']) {
      const url = g[kind];
      if (!url) continue;
      const key = kind + '|' + url;
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push({
        label: g.label,
        kind,
        url,
        tier: g.tier,
        level: g.level,
        resolution: g.resolution,
        codec: g.codec,
      });
    }
  }

  // Best first. FLV wins a tie over HLS: it is one continuous TCP connection,
  // whereas an HLS playlist can be rotated away mid-recording. The last clause
  // must return 0 for equal kinds — returning a constant ±1 there breaks the
  // comparator contract and reverses the order inside a tier.
  flat.sort((a, b) => {
    return b.tier - a.tier || b.level - a.level || (a.kind === b.kind ? 0 : a.kind === 'flv' ? -1 : 1);
  });
  return flat;
}

// ---------- resolve ----------

/**
 * input -> a room descriptor, or { ok:false, error } with a message that tells
 * the user which of the three possible failures they hit.
 */
async function resolve(input, s) {
  const target = parseTarget(input);
  if (target.error) return { ok: false, error: target.error };

  let handle = target.handle;
  let roomId = target.roomId;
  let title = '';

  if (!roomId) {
    const url =
      'https://www.tiktok.com/api-live/user/room/?' +
      new URLSearchParams(webParams(s, { uniqueId: handle, sourceType: 54, user_is_login: 'true' })).toString();
    let json;
    try {
      json = await webJson(url, { s });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const data = json && json.data;
    if (!data) {
      // TikTok uses status_code on the webcast API and statusCode on this one;
      // check both rather than reporting a data-less "try later".
      const code = (json && (json.status_code ?? json.statusCode)) || '';
      return {
        ok: false,
        error: code
          ? `TikTok не дал данных по @${handle} (код ${code}). Проверьте ник или смените прокси.`
          : `TikTok не дал данных по @${handle}. Проверьте ник.`,
      };
    }
    const user = data.user || {};
    roomId = String(user.roomId || (data.liveRoom && data.liveRoom.roomId) || '');
    title = String((data.liveRoom && data.liveRoom.title) || '');
    if (String(user.uniqueId || '')) handle = String(user.uniqueId);
  }

  if (!roomId) {
    return { ok: false, error: `@${handle} сейчас не в эфире.`, offline: true, handle };
  }

  const infoUrl =
    'https://webcast.tiktok.com/webcast/room/info/?' +
    new URLSearchParams(
      webParams(s, { room_id: roomId, user_is_login: 'true', web_ranking: '1', sourceType: 54 })
    ).toString();

  let info;
  try {
    info = await webJson(infoUrl, { s });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 4003110 is what TikTok returns when the room exists but is closed to this
  // region. It is a proxy problem, not a "nobody is live" answer.
  const statusCode = info && (info.status_code ?? info.statusCode);
  if (statusCode === 4003110) {
    return {
      ok: false,
      error: 'Трансляция недоступна из вашего региона (TikTok 4003110). Нужен прокси в поддерживаемой стране.',
      restricted: true,
      handle,
    };
  }
  // Any other non-zero code means the response itself is an error, even if it
  // happens to carry a `data` block. Treating that as a live room would start a
  // recording against whatever half-populated payload came back.
  if (statusCode !== undefined && Number(statusCode) !== 0) {
    const msg = String((info && (info.status_msg || info.statusMsg)) || '').trim();
    return {
      ok: false,
      error: `TikTok вернул ошибку ${statusCode}${msg ? `: ${msg}` : ''}. Попробуйте позже или смените прокси.`,
      handle,
    };
  }

  const data = info && info.data;
  if (!data) {
    return { ok: false, error: 'TikTok не вернул данных о трансляции. Попробуйте позже.', handle };
  }

  // Only unique_id is safe to rebuild a page URL from: display_id is the free-text
  // display name and may contain spaces and characters that make a broken URL.
  const owner = data.owner || {};
  handle = String(owner.unique_id || handle);
  title = String(data.title || title || '').slice(0, 200);
  const cover = String(
    (data.cover && (data.cover.url_list || [])[0]) || (data.cover && data.cover.url) || ''
  );
  const streams = parseStreams(data.stream_url);
  const liveStatus = Number(data.status || 0);

  if (liveStatus !== 2) {
    return {
      ok: false,
      offline: true,
      handle,
      title,
      cover,
      error: `@${handle} сейчас не в эфире.`,
    };
  }

  // Live but no streams is a different failure from "offline" and must not be
  // reported as one: the broadcast is running, TikTok just did not hand over a
  // media payload in any shape this code understands.
  if (!streams.length) {
    return {
      ok: false,
      handle,
      title,
      cover,
      error:
        'Эфир идёт, но TikTok не отдал ни одного потока — похоже, изменился формат ответа. Попробуйте позже или обновите приложение.',
    };
  }

  return {
    ok: true,
    room: {
      roomId: String(data.room_id || roomId),
      handle,
      title,
      cover,
      viewers: Number((data.stats && data.stats.viewer_count) || 0),
      startedAt: Number(data.create_time || 0) * 1000 || 0,
      pageUrl: `https://www.tiktok.com/@${handle}/live`,
      streams,
    },
  };
}

// ---------- recording ----------

function safeSegment(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 48);
}

function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ffmpegArgs(stream, out) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];

  // Machine-readable progress on stdout. The human "size=/time=" summary line is
  // a loglevel-info message and is suppressed at "warning", which left the UI
  // clock frozen at 00:00 for the whole recording. -progress is independent of
  // the log level, and -nostats suppresses the periodic stderr stats line that
  // would otherwise be parsed for nothing.
  args.push('-progress', 'pipe:1', '-nostats');

  // Reconnect on a dropped transport, but never reconnect_at_eof: EOF is exactly
  // how a finished broadcast looks, and retrying there would loop forever.
  args.push(
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '30000000'
  );

  args.push('-i', stream.url, '-c', 'copy');

  // FLV carries AAC with the ADTS header that MP4 does not accept.
  if (stream.kind === 'flv') args.push('-bsf:a', 'aac_adtstoasc');

  // Fragmented MP4 rather than +faststart: the moov atom is written as the
  // recording grows instead of in one final pass, so a multi-hour capture is
  // playable even if the app is killed instead of stopped.
  args.push('-movflags', 'frag_keyframe+empty_moov', out);
  return args;
}
 // ---------- screen recording ("record the page as seen on screen") ----------

 // Same lifecycle as start(): same filename scheme, spawn, settled guard,
 // cleanup(), stop(), stall/kill timers and result(). Only the INPUT differs:
 // instead of a CDN URL the video comes from guest capturePage() frames piped
 // as MJPEG, with the CDN stream (if any) attached as the AUDIO track only.
 //
 // ffmpeg video-from-pipe requirements, all verified against the project's
 // ffmpeg: -f image2pipe -framerate N -vcodec mjpeg -i - for the input, H.264
 // with yuv420p for the output, and the even-dimension scale filter — without
 // it libx264 fails on any odd viewport size. +faststart stays out for the same
 // reason as in ffmpegArgs(): the moov atom must grow with the recording.
 const SCREEN_FPS_DEFAULT = 10;
 const SCREEN_QUALITY_DEFAULT = 70;
 // capturePage() on a minimized window or a hidden tab returns an empty image
 // (electron#31992/#39029: an occluded guest may stop compositing). One empty
 // frame is a blip; SCREEN_BLANK_LIMIT in a row means the user minimized the
 // window, and the recording would otherwise be an hour of black.
 const SCREEN_BLANK_LIMIT = 5;

 function screenFfmpegArgs(fps, audioUrl, out) {
   const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats'];
   args.push('-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'mjpeg', '-i', '-');
   // The CDN stream, when there is one, carries AUDIO only. It is deliberately
   // NOT required: a room with no downloadable stream can still be recorded as
   // pixels (silently, with -an).
   if (audioUrl) args.push('-i', audioUrl, '-map', '0:v', '-map', '1:a');
   args.push(
     '-c:v', 'libx264',
     '-preset', 'ultrafast',
     '-tune', 'zerolatency',
     '-pix_fmt', 'yuv420p',
     '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
     '-r', String(fps)
   );
   if (!audioUrl) args.push('-an');
   args.push('-movflags', 'frag_keyframe+empty_moov', out);
   return args;
 }


function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Spawns ffmpeg on an already-resolved room. Does NOT resolve: callers resolve
 * first, and must re-resolve immediately before calling this — the CDN URLs are
 * signed and go stale (see main.js live:start).
 *
 * Returns { id, path } on success or { error } after having already reported the
 * same text through onError, so the caller can always return { ok, ... }.
 */
function start(id, room, s, { onProgress, onDone, onError } = {}) {
  const fail = (msg) => {
    onError && onError(msg);
    return { error: msg };
  };

  const exe = binaries.ffmpeg();
  if (!exe) return fail('ffmpeg не найден. Укажите папку с бинарниками в настройках.');

  // Only http(s) may reach ffmpeg's -i. The room descriptor arrives over IPC from
  // the renderer, and a file:// or bare path there would turn the recorder into
  // an arbitrary local-file reader.
  const streams = Array.isArray(room.streams)
    ? room.streams.filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
    : [];
  if (!streams.length) return fail('Для этого эфира нет доступного потока.');

  const stream = streams[0];
  const dir = path.join(s.downloadDir || '.', 'live');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}

  // The stamp has one-second resolution, so two recordings started inside the
  // same second would fight over the same file. Bump rather than overwrite.
  const base = `${safeSegment(room.handle) || 'live'}_${localStamp()}`;
  let out = path.join(dir, `${base}.mp4`);
  for (let n = 2; fs.existsSync(out) && n < 100; n++) out = path.join(dir, `${base}_${n}.mp4`);

  let child;
  try {
    child = spawn(exe, ffmpegArgs(stream, out), {
      windowsHide: true,
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return fail(`Не удалось запустить ffmpeg: ${e.message}`);
  }

  const job = {
    id,
    child,
    out,
    stream,
    room,
    startedAt: Date.now(),
    durationSec: 0,
    lastProgress: 0,
    lastGrow: Date.now(),
    lastSize: -1,
    stopping: false,
    stopReason: null,
    settled: false,
    stderrTail: '',
    stallTimer: null,
    hardTimer: null,
    killTimer: null,
    reapTimer: null,
    onProgress,
    onDone,
    onError,
  };
  running.set(id, job);

  const emit = (force) => {
    const now = Date.now();
    if (!force && now - job.lastProgress < PROGRESS_EVERY_MS) return;
    job.lastProgress = now;
    onProgress &&
      onProgress({
        id,
        elapsedSec: Math.floor((now - job.startedAt) / 1000),
        durationSec: job.durationSec,
        downloaded: fileSize(out),
        resolution: stream.resolution || stream.label,
      });
  };

  const result = () => ({
    id,
    path: out,
    size: fileSize(out),
    elapsedSec: Math.floor((Date.now() - job.startedAt) / 1000),
    durationSec: job.durationSec,
    reason: job.stopReason,
    title: room.title || '',
    handle: room.handle,
  });

  // -progress writes `key=value` lines; out_time_ms is in MICROseconds.
  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.startsWith('out_time_ms=')) continue;
      const us = Number(line.slice(12));
      if (Number.isFinite(us) && us > 0) job.durationSec = Math.floor(us / 1e6);
    }
    emit(false);
  });

  // stderr is diagnostics only now — no parsing, no guessing at log levels.
  child.stderr.on('data', (buf) => {
    job.stderrTail = (job.stderrTail + buf.toString()).slice(-4000);
  });

  // Stall watchdog: a finished broadcast leaves the connection open with no
  // data. Without this the row would sit at "recording" indefinitely.
  job.stallTimer = setInterval(() => {
    if (job.stopping || job.settled) return;
    const size = fileSize(out);
    if (size !== job.lastSize) {
      job.lastSize = size;
      job.lastGrow = Date.now();
      return;
    }
    if (Date.now() - job.lastGrow > STALL_LIMIT_MS) {
      stop(id, 'Поток перестал поступать — запись остановлена.');
    }
  }, STALL_POLL_MS);
  if (job.stallTimer.unref) job.stallTimer.unref();

  emit(true);

  child.on('error', (e) => {
    // Node emits 'error' for ENOENT/EACCES and then ALWAYS follows with 'close'.
    // Without this guard both handlers would fire the callback: two toasts, and
    // dropLiveJob racing finishLiveJob.
    if (job.settled) return;
    job.settled = true;
    cleanup(job);
    running.delete(id);
    onError && onError(`Не удалось запустить ffmpeg: ${e.message}`);
  });

  child.on('close', (code, signal) => {
    if (job.settled) return;
    job.settled = true;
    cleanup(job);
    running.delete(id);

    if (fileSize(out) <= 0) {
      // A user stop before the first frame is not a CDN failure and must not be
      // reported as one.
      if (job.stopping) {
        onError && onError('Остановлено до того, как поток отдал первый кадр.');
        return;
      }
      const tail = job.stderrTail;
      onError &&
        onError(
          /404 Not Found|403 Forbidden|HTTP error 40[34]/.test(tail)
            ? 'CDN не отдал поток (404/403). Эфир, возможно, уже закончился, либо закрыт для вашего региона.'
            : 'Запись пустая — поток не отдал ни одного кадра.'
        );
      return;
    }

    // A crash after some bytes still leaves a playable fragmented MP4, so the
    // capture is kept and the reason reported — discarding hours of video
    // because ffmpeg exited non-zero would be worse than the crash.
    const r = result();
    if (!job.stopping) {
      r.reason =
        code === 0
          ? 'ffmpeg завершился сам.'
          : `ffmpeg прерван (код ${code}${signal ? `, ${signal}` : ''}) — запись сохранена частично.`;
    }
    onDone && onDone(r);
  });

  // startedAt anchors the chat subtitle timeline to this recording.
  return { id, path: out, startedAt: job.startedAt };
}


 /**
  * Screen-recording twin of start(): captures what the user SEES on the live
  * room page (portrait video, viewer list, chat column with avatars) instead of
  * the clean CDN stream.
  *
  * opts: { guest, audioUrl, fps, quality, onProgress, onDone, onError }
  *   guest    — the live room's guest webContents (the capturePage source).
  *   audioUrl — best CDN stream URL for the AUDIO track, or null (silent, -an).
  *   fps      — capture rate, default 10 (capturePage does 5-15 in practice).
  *   quality  — JPEG quality for the pipe, default 70 (toJPEG is far cheaper
  *              than toPNG and the pipe is the bottleneck).
  *
  * The loop is a recursive setTimeout, NOT setInterval: a stalled capturePage()
  * must delay the next tick rather than pile overlapping captures on top of it
  * (parallel capturePage calls are not allowed). Backpressure is bounded the
  * same way: when stdin.write() returns false the loop awaits ONE drain (capped
  * at one frame interval) instead of queueing JPEGs without bound.
  *
  * Progress stays backward compatible with the stream renderer:
  * { id, elapsedSec, durationSec, downloaded, resolution } plus
  * { frames, dropped, mode:'screen' }.
  */
 function startScreen(id, room, s, { guest, audioUrl = null, fps = SCREEN_FPS_DEFAULT, quality = SCREEN_QUALITY_DEFAULT, onProgress, onDone, onError } = {}) {
   const fail = (msg) => {
     onError && onError(msg);
     return { error: msg };
   };

   const exe = binaries.ffmpeg();
   if (!exe) return fail('ffmpeg не найден. Укажите папку с бинарниками в настройках.');
   if (!guest || typeof guest.capturePage !== 'function') {
     return fail('Встроенный браузер не открыт. Откройте эфир во вкладке «Обзор».');
   }
   // Only http(s) may reach ffmpeg's -i — same trust boundary as start().
   if (audioUrl && !/^https?:\/\//i.test(audioUrl)) audioUrl = null;
   fps = Math.max(1, Math.min(15, Number(fps) || SCREEN_FPS_DEFAULT));
   quality = Math.max(10, Math.min(100, Number(quality) || SCREEN_QUALITY_DEFAULT));

   const dir = path.join(s.downloadDir || '.', 'live');
   try {
     fs.mkdirSync(dir, { recursive: true });
   } catch {}

   const base = `${safeSegment(room.handle) || 'live'}_${localStamp()}`;
   let out = path.join(dir, `${base}.mp4`);
   for (let n = 2; fs.existsSync(out) && n < 100; n++) out = path.join(dir, `${base}_${n}.mp4`);

   let child;
   try {
     child = spawn(exe, screenFfmpegArgs(fps, audioUrl, out), {
       windowsHide: true,
       cwd: dir,
       stdio: ['pipe', 'pipe', 'pipe'],
     });
   } catch (e) {
     return fail(`Не удалось запустить ffmpeg: ${e.message}`);
   }

   const job = {
     id,
     child,
     out,
     stream: { kind: 'screen', label: 'screen', url: '', resolution: '' },
     room,
     mode: 'screen',
     guest,
     fps,
     quality,
     audioUrl: audioUrl || null,
     frames: 0,
     dropped: 0,
     blankCount: 0,
     resolution: '',
     startedAt: Date.now(),
     durationSec: 0,
     lastProgress: 0,
     lastGrow: Date.now(),
     lastSize: -1,
     stopping: false,
     stopReason: null,
     settled: false,
     stderrTail: '',
     stallTimer: null,
     hardTimer: null,
     killTimer: null,
     reapTimer: null,
     screenTimer: null,
     screenStopped: false,
     onProgress,
     onDone,
     onError,
   };
   running.set(id, job);

   const emit = (force) => {
     const now = Date.now();
     if (!force && now - job.lastProgress < PROGRESS_EVERY_MS) return;
     job.lastProgress = now;
     onProgress &&
       onProgress({
         id,
         elapsedSec: Math.floor((now - job.startedAt) / 1000),
         durationSec: job.durationSec,
         downloaded: fileSize(out),
         resolution: job.resolution || 'экран',
         frames: job.frames,
         dropped: job.dropped,
         mode: 'screen',
       });
   };

   const result = () => ({
     id,
     path: out,
     size: fileSize(out),
     elapsedSec: Math.floor((Date.now() - job.startedAt) / 1000),
     durationSec: job.durationSec,
     reason: job.stopReason,
     title: room.title || '',
     handle: room.handle,
     mode: 'screen',
     frames: job.frames,
     dropped: job.dropped,
   });

   const failScreen = (msg) => {
     if (job.settled) return;
     job.settled = true;
     job.screenStopped = true;
     if (job.screenTimer) {
       clearTimeout(job.screenTimer);
       job.screenTimer = null;
     }
     cleanup(job);
     running.delete(id);
     try {
       job.child.stdin.destroy();
     } catch {}
     try {
       job.child.kill('SIGTERM');
     } catch {}
     job.hardTimer = setTimeout(() => {
       try {
         job.child.kill('SIGKILL');
       } catch {}
     }, 5000);
     if (job.hardTimer.unref) job.hardTimer.unref();
     onError && onError(msg);
   };

   // -progress writes `key=value` lines; out_time_ms is in MICROseconds.
   child.stdout.on('data', (buf) => {
     for (const line of buf.toString().split(/\r?\n/)) {
       if (!line.startsWith('out_time_ms=')) continue;
       const us = Number(line.slice(12));
       if (Number.isFinite(us) && us > 0) job.durationSec = Math.floor(us / 1e6);
     }
     emit(false);
   });

   child.stderr.on('data', (buf) => {
     job.stderrTail = (job.stderrTail + buf.toString()).slice(-4000);
   });

   // Same stall watchdog as start(): a broadcast that ended leaves ffmpeg with
   // no new frames and the row would sit at "recording" forever.
   job.stallTimer = setInterval(() => {
     if (job.stopping || job.settled) return;
     const size = fileSize(out);
     if (size !== job.lastSize) {
       job.lastSize = size;
       job.lastGrow = Date.now();
       return;
     }
     if (Date.now() - job.lastGrow > STALL_LIMIT_MS) {
       stop(id, 'Поток перестал поступать — запись остановлена.');
     }
   }, STALL_POLL_MS);
   if (job.stallTimer.unref) job.stallTimer.unref();

   // The capture loop. Recursive setTimeout (see the doc comment above); every
   // exit path either schedules the next tick or ends in failScreen/stop.
   const intervalMs = Math.max(40, Math.round(1000 / job.fps));
   const schedule = () => {
     if (job.stopping || job.settled || job.screenStopped) return;
     job.screenTimer = setTimeout(tick, intervalMs);
     if (job.screenTimer.unref) job.screenTimer.unref();
   };
   const noteBlank = () => {
     job.blankCount += 1;
     if (job.blankCount >= SCREEN_BLANK_LIMIT) {
       failScreen(
         'Запись экрана остановлена: страница отдаёт пустые кадры. ' +
           'Разверните окно приложения и не сворачивайте вкладку «Обзор» во время записи.'
       );
       return;
     }
     schedule();
   };
   const tick = async () => {
     job.screenTimer = null;
     if (job.stopping || job.settled || job.screenStopped) return;
     let img = null;
     try {
       // capturePage resolves with a NativeImage of the guest web content only
       // (no Electron chrome, no OS UI). One at a time — never parallel.
       img = await guest.capturePage();
     } catch (_) {
       img = null;
     }
     if (job.stopping || job.settled || job.screenStopped) return;
     if (!img || img.isEmpty()) {
       noteBlank();
       return;
     }
     let size = null;
     try {
       size = img.getSize();
     } catch (_) {
       size = null;
     }
     if (!size || !size.width || !size.height) {
       noteBlank();
       return;
     }
     job.blankCount = 0;
     if (!job.resolution) job.resolution = `${size.width}x${size.height}`;
     let jpeg = null;
     try {
       // JPEG, not PNG: far cheaper to encode, and the pipe forgives it.
       jpeg = img.toJPEG({ quality: job.quality });
     } catch (_) {
       jpeg = null;
     }
     if (!jpeg || !jpeg.length) {
       job.dropped += 1;
       schedule();
       return;
     }
     let accepted = false;
     try {
       accepted = job.child.stdin.write(jpeg);
     } catch (_) {
       // EPIPE — ffmpeg is already gone; the 'close' handler reports it.
       job.dropped += 1;
       schedule();
       return;
     }
     job.frames += 1;
     if (!accepted) {
       // Backpressure: await ONE drain, bounded by a single frame interval, so
       // a stalled ffmpeg can delay us by one frame but never build an
       // unbounded JPEG queue in memory.
       try {
         await new Promise((resolve) => {
           const t = setTimeout(resolve, intervalMs);
           try {
             job.child.stdin.once('drain', () => {
               clearTimeout(t);
               resolve();
             });
           } catch (_) {
             clearTimeout(t);
             resolve();
           }
         });
       } catch {}
     }
     emit(false);
     schedule();
   };

   emit(true);
   schedule();

   child.on('error', (e) => {
     if (job.settled) return;
     job.settled = true;
     job.screenStopped = true;
     if (job.screenTimer) {
       clearTimeout(job.screenTimer);
       job.screenTimer = null;
     }
     cleanup(job);
     running.delete(id);
     onError && onError(`Не удалось запустить ffmpeg: ${e.message}`);
   });

   child.on('close', (code, signal) => {
     if (job.settled) return;
     job.settled = true;
     job.screenStopped = true;
     if (job.screenTimer) {
       clearTimeout(job.screenTimer);
       job.screenTimer = null;
     }
     cleanup(job);
     running.delete(id);

     if (fileSize(out) <= 0) {
       if (job.stopping) {
         onError && onError('Остановлено до того, как страница отдала первый кадр.');
         return;
       }
       const tail = job.stderrTail;
       onError &&
         onError(
           /No such file|Connection|404|403|HTTP error/i.test(tail)
             ? 'Не удалось записать экран: ffmpeg не принял кадры или звук. Оставьте вкладку «Обзор» открытой и попробуйте снова.'
             : 'Запись пустая — страница не отдала ни одного кадра.'
         );
       return;
     }

     const r = result();
     if (!job.stopping) {
       r.reason =
         code === 0
           ? 'ffmpeg завершился сам.'
           : `ffmpeg прерван (код ${code}${signal ? `, ${signal}` : ''}) — запись сохранена частично.`;
     }
     onDone && onDone(r);
   });

   return { id, path: out, startedAt: job.startedAt };
 }

function cleanup(job) {
  if (job.stallTimer) clearInterval(job.stallTimer);
  if (job.screenTimer) clearTimeout(job.screenTimer);
  if (job.hardTimer) clearTimeout(job.hardTimer);
  if (job.killTimer) clearTimeout(job.killTimer);
  if (job.reapTimer) clearTimeout(job.reapTimer);
  try {
    job.child.stdout.destroy();
    job.child.stderr.destroy();
  } catch {}
}

/**
 * Graceful stop. "q" on stdin makes ffmpeg finalise the container and exit 0;
 * only if that hangs do we escalate to signals, so the file is always closed
 * cleanly. Idempotent — a second call must not re-arm the escalation timers.
 */
function stop(id, reason) {
  const job = running.get(id);
  if (!job) return false;
  if (job.stopping) return true;
  job.stopping = true;
  job.stopReason = reason || 'Остановлено вручную.';
  if (job.mode === 'screen') {
    // stdin is the MJPEG frame pipe, not the command channel: writing 'q'
    // there would inject garbage bytes into the video. EOF alone makes
    // ffmpeg finalise the container; the SIGTERM/SIGKILL escalation below
    // then finishes it exactly like a stream job.
    job.screenStopped = true;
    if (job.screenTimer) {
      clearTimeout(job.screenTimer);
      job.screenTimer = null;
    }
    try {
      job.child.stdin.end();
    } catch {}
  } else {
    try {
      job.child.stdin.write('q\n');
      job.child.stdin.end();
    } catch {}
  }

  // Every timer is tracked so cleanup() can cancel it. An untracked SIGKILL
  // would fire 12s into an already-closed job.
  job.hardTimer = setTimeout(() => {
    try {
      job.child.kill('SIGTERM');
    } catch {}
  }, 8000);
  if (job.hardTimer.unref) job.hardTimer.unref();

  job.killTimer = setTimeout(() => {
    try {
      job.child.kill('SIGKILL');
    } catch {}
  }, 12000);
  if (job.killTimer.unref) job.killTimer.unref();

  // Absolute backstop: should 'close' never arrive (an unkillable process on
  // Windows is rare but not impossible), the job would otherwise stay in
  // `running` forever with a live watchdog attached.
  job.reapTimer = setTimeout(() => {
    if (running.get(id) !== job) return;
    running.delete(id);
    cleanup(job);
    try {
      job.child.removeAllListeners('close');
    } catch {}
    try {
      job.child.kill('SIGKILL');
    } catch {}
    const size = fileSize(job.out);
    if (size > 0) {
      job.onDone &&
        job.onDone({
          id,
          path: job.out,
          size,
          elapsedSec: Math.floor((Date.now() - job.startedAt) / 1000),
          durationSec: job.durationSec,
          reason: job.stopReason,
          title: job.room.title || '',
          handle: job.room.handle,
        });
    } else {
      job.onError && job.onError('Остановлено до того, как поток отдал первый кадр.');
    }
  }, 15000);
  if (job.reapTimer.unref) job.reapTimer.unref();

  return true;
}

function stopAll(reason) {
  let n = 0;
  for (const id of [...running.keys()]) if (stop(id, reason)) n++;
  return n;
}

function list() {
  return [...running.values()].map((j) => ({
    id: j.id,
    path: j.out,
    handle: j.room.handle,
    title: j.room.title,
    mode: j.mode || 'stream',
    resolution: j.mode === 'screen' ? j.resolution || 'экран' : j.stream.resolution || j.stream.label,
    startedAt: j.startedAt,
  }));
}

function status() {
  return { ffmpeg: binaries.ffmpeg(), running: running.size, jobs: list() };
}

module.exports = { parseTarget, parseStreams, resolve, start, startScreen, screenFfmpegArgs, stop, stopAll, list, status };