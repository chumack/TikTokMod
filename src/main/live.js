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
const { spawn, spawnSync } = require('node:child_process');
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

/**
 * Screen mode captures the guest at whatever size the window happens to be, and a
 * maximised window on a HiDPI display is ~3000 px wide. That is not free: measured
 * with the real argv and realistic (near-incompressible) page content, ffmpeg can
 * only CONSUME 3.45 frames/s of 3004x882 PNG, 8.35 at 1920x564 and 11.85 at
 * 1600x470. Feeding it 3004 px therefore capped the whole recording at ~1.9 fps —
 * a slideshow, not video — no matter how fast the page could be captured.
 *
 * 1920 is the cap: its 8.35 fps consumption ceiling sits ABOVE what capturePage
 * can deliver anyway (~5-6 fps measured), so ffmpeg stops being the bottleneck and
 * the loop becomes bound by the capture itself — which is the floor we cannot
 * improve without a different capture API.
 *
 * The width cap alone is not enough, though: what ffmpeg actually chokes on is
 * PIXELS PER FRAME, not width. A tall narrow window (1080x2400 portrait «Обзор»
 * is 2.59 MP, the same as the 3004x883 landscape case) would sail past a
 * width-only cap and land right back at ~3.5 fps. So the canvas is also held to
 * a pixel budget, which is the quantity the measurement above is actually about.
 */
const SCREEN_MAX_WIDTH = 1600;
const SCREEN_MAX_PIXELS = 900000; // 1600x560 — sized for the raw-pixel pipe, see screenFfmpegArgs

/**
 * How long a tick waits for the compositor to hand us its next frame before it
 * gives up and takes a capturePage() instead. beginFrameSubscription delivers a
 * frame only when something actually repaints, so a quiet page needs the cap.
 */
const FRAME_WAIT_MS = 250;

/**
 * The audio sidecar is polled for growth as well as watched through its own
 * -progress stream. Measured: on a live room the ADTS file reached 256 KB while
 * `out_time_ms` never went above zero, so a check that trusts -progress alone
 * threw away a perfectly good recording's sound.
 */
const AUDIO_POLL_MS = 500;

/**
 * How long to wait after asking the audio process to stop before SIGTERM. It
 * ignores the `q` we write to its stdin — ffmpeg only reads stdin as a key source
 * when stdin IS the interactive console, and here the input is a network URL, so
 * the write is a no-op and every stop used to burn the full 5 s.
 */
const AUDIO_TERM_MS = 1500;

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
 const SCREEN_FPS_DEFAULT = 25;
 const SCREEN_QUALITY_DEFAULT = 70;
 // capturePage() on a minimized window or a hidden tab returns an empty image
 // (electron#31992/#39029: an occluded guest may stop compositing). One empty
 // frame is a blip; SCREEN_BLANK_LIMIT in a row means the user minimized the
 // window, and the recording would otherwise be an hour of black.
 const SCREEN_BLANK_LIMIT = 5;
  // A capture that never resolves must not stall the loop (see tick). One frame
  // interval is 1000/fps; 3 s is generous for a software copy of a page that is
  // visibly compositing, and short enough that a genuinely stuck guest is
  // reported as "no frames" within seconds instead of hanging forever.
  const CAPTURE_TIMEOUT_MS = 3000;
// A live FLV player typically sits 2-5 s behind the edge (the MediaLive Web
// Player SDK quotes ~5 s for traditional HTTP-FLV, 2-3 s for low-latency). Used ONLY
// when the guest cannot report how far it is buffered, because Chromium does not
// always expose a live MSE buffer through video.buffered.
const SCREEN_DEFAULT_PLAYER_LAG = 3;

  // Guest-side probe: which part of the page is actually worth recording?
  //
  // The answer is the union of two boxes — the live player card (the <video> plus
  // its controls, so the pause bar, the timer and the gift bar are kept) and the
  // chat column on the right («Зрители», the messages, the «Введите сообщение…»
  // field). Everything to the left of the player is TikTok's own navigation and is
  // deliberately left out: on a wide window that sidebar is the majority of the
  // viewport, and it was squeezing the part the user cares about into a narrow,
  // wrongly-proportioned strip in the middle of every recorded frame.
  //
  // Run in the page's main world (so it is unaffected by CSP) and written to be
  // total: any page layout returns either a rect or null, never an exception.
  // The rect is in CSS pixels of the guest viewport, which is what capturePage
  // expects and — at deviceScaleFactor 1 — the same unit as the captured bitmap.
  /**
 * How far behind the CDN live edge the guest player is showing.
 *
 * The recorded AUDIO is the CDN stream itself; the recorded PICTURE is a screen
 * capture of a <webview> that is playing that same stream through Chromium media
 * buffers, a transmuxer stash buffer and the renderer's own pipeline. So the
 * picture is systematically LATE by however much the player has buffered, and the
 * audio has to be delayed by exactly that much to line up again.
 *
 * The delay is NOT the time the audio sidecar needed to produce its first byte —
 * that is connect + probe, measured in `finalize()`, and shifting by it was tried
 * twice and produced a desync of exactly the size of the correction each time.
 *
 * `buffered.end(last) - currentTime` is the buffered-ahead span, i.e. the player
 * is rendering content from `currentTime` while holding `lag` more seconds of
 * future content that the CDN has already delivered and the audio track has
 * already recorded. Typical 2-5 s for an HTTP-FLV room.
 */
const AV_LAG_SOURCE = `(() => {
    const onScreen = (r) => r && r.right > 0 && r.bottom > 0
      && r.left < innerWidth && r.top < innerHeight;
    let best = null;
    for (const el of document.querySelectorAll('video')) {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || !(r.width > 20) || !(r.height > 20) || !onScreen(r)) continue;
      const playing = !el.paused && !el.ended && el.readyState > 2;
      const area = r.width * r.height;
      const score = (playing ? 1e9 : 0) + area;
      if (!best || score > best.score) best = { el: el, score: score };
    }
    if (!best) return null;
    const v = best.el;
    let end = 0;
    try {
      const b = v.buffered;
      if (b && b.length) end = b.end(b.length - 1);
    } catch (_) {
      return null;
    }
    if (!(end > 0)) return null;
    const ct = Number(v.currentTime) || 0;
    const lag = end - ct;
    // Outside 0..60 s this is not a playback buffer: a paused tag, a zero-length
    // range while the source is still opening, or a seek in progress.
    if (!(lag >= 0) || lag > 60) return null;
    return { lag: lag, ct: ct, end: end };
  })()`;
const SCREEN_REGION_SOURCE = `(() => {
  const rect = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!r || !(r.width > 20) || !(r.height > 20)) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  const onScreen = (r) => !!r && r.right > 0 && r.bottom > 0 && r.x < innerWidth && r.y < innerHeight;
  const union = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.right, b.right);
    const bottom = Math.max(a.bottom, b.bottom);
    return { x: x, y: y, w: right - x, h: bottom - y, right: right, bottom: bottom };
  };
  const vw = innerWidth;
  const vh = innerHeight;
  // TikTok's own fullscreen hides the navigation, so there is nothing to cut and
  // the whole screen is what the user is watching.
  if (document.fullscreenElement) {
    return { x: 0, y: 0, width: Math.round(vw), height: Math.round(vh), why: 'full' };
  }

  // 1. THE PLAYER. Scored by area with a huge bonus for actually playing, because
  // TikTok's co-host grids put several equal-sized tiles in the DOM and a plain
  // 'first in document order' tie is how the second tile used to be left out of
  // the recording entirely. Tiles are unioned, not abandoned.
  const tiles = [];
  for (const el of document.querySelectorAll('video')) {
    const r = rect(el);
    if (!r || !onScreen(r)) continue;
    const playing = !el.paused && !el.ended && el.readyState > 2;
    tiles.push({ el: el, r: r, score: (playing ? 1e9 : 0) + r.w * r.h });
  }
  tiles.sort((a, b) => b.score - a.score);
  let player = null;
  if (tiles.length) {
    const v = tiles[0];
    let box = v.r;
    let node = v.el;
    for (let i = 0; i < 8 && node; i++) {
      const up = node.parentElement;
      if (!up || up === document.body || up === document.documentElement) break;
      const q = rect(up);
      if (!q) break;
      if (q.w < box.w) break;
      const inner = [];
      for (const iv of up.querySelectorAll('video')) {
        const rr = rect(iv);
        if (rr && onScreen(rr)) inner.push(rr);
      }
      if (!inner.length) break;
      // A parent that spans the viewport is the page's flex ROW, not the player's
      // card: it also holds the chat, and adopting it is exactly what turned "cut
      // the navigation off" into "record everything".
      if (q.w >= vw * 0.9) break;
      if (inner.length === 1) {
        if (q.w <= v.r.w * 3.5) box = q;
        else break;
      } else {
        let all = inner[0];
        for (let k = 1; k < inner.length; k++) all = union(all, inner[k]);
        box = union(box, all);
      }
      if (q.w >= vw * 0.92 && q.h >= vh * 0.92) break;
      node = up;
    }
    player = box;
  }

  // 2. THE CHAT COLUMN, found by its own header. The header is SHORT ('Зрители'),
  // so the long-text guard below can be tight: an earlier version allowed 6000
  // characters of the panel's own message list and therefore threw away the chat
  // of every busy room, which is exactly when the navigation came back.
  let chat = null;
  for (const el of document.querySelectorAll('div,section,aside,span,h1,h2,h3,h4')) {
    const t = el.textContent || '';
    if (!t || t.length > 400) continue;
    if (!/зрител|viewer/i.test(t)) continue;
    const r = rect(el);
    if (!r || !onScreen(r)) continue;
    if (r.w < 80 || r.w > vw * 0.45) continue;
    if (r.x < vw * 0.4) continue;
    let panel = r;
    let node = el;
    for (let i = 0; i < 5 && node; i++) {
      const up = node.parentElement;
      if (!up) break;
      const q = rect(up);
      if (!q) break;
      if (q.w > vw * 0.5 || q.w < r.w) break;
      if (q.h >= 240) { panel = q; break; }
      node = up;
    }
    if (!chat || panel.w < chat.w) chat = panel;
  }
  // Fallback for locales whose header says something else: the tallest narrow
  // column in the right half. The limit is 60000 because a live chat's own
  // textContent is legitimately huge.
  if (!chat) {
    for (const el of document.querySelectorAll('div,section,aside')) {
      const t = el.textContent || '';
      if (!t || t.length > 60000) continue;
      const r = rect(el);
      if (!r || !onScreen(r)) continue;
      if (r.w < 140 || r.w > vw * 0.45) continue;
      if (r.x < vw * 0.5 || r.h < vh * 0.4) continue;
      if (!chat || r.w < chat.w) chat = r;
    }
  }

  // 3. THE NAVIGATION COLUMN, by its own labels. Only distinctive labels are
  // listed: words like 'home' or 'following' turn up in comments and used to drag
  // the cut line INTO the player. The position guard rejects anything that is not
  // actually on the left.
  const NAV = ['назад', 'интересные тран', 'начать эфир', 'инструменты автора',
    'подписки', 'рекомендуемые авторы', 'приобрести мон', 'go live',
    'creator tools', 'back to', 'suggested accounts'];
  let navRight = 0;
  for (const el of document.querySelectorAll('div,nav,aside,ul,section')) {
    const t = (el.textContent || '').toLowerCase();
    if (!t || t.length > 4000) continue;
    let hits = 0;
    for (let i = 0; i < NAV.length; i++) if (t.indexOf(NAV[i]) >= 0) hits++;
    if (hits < 2) continue;
    const r = rect(el);
    if (!r || !onScreen(r)) continue;
    if (r.w > vw * 0.4 || r.x > vw * 0.25) continue;
    if (r.right > navRight) navRight = r.right;
  }

  const box = union(player, chat);
  let x = box ? box.x : 0;
  // A 'navigation' that starts inside the player is a false positive from a
  // comment; ignore it rather than cut the player in half.
  if (navRight > x && !(player && navRight > player.x + player.w * 0.3)) x = navRight;
  x = Math.round(x);
  if (x < 8) x = navRight >= 8 ? Math.round(navRight) : 0;
  let why = 'full';
  if (player && chat) why = 'union';
  else if (player) why = 'player';
  if (!(x > 0) || x > vw * 0.5) { x = 0; why = 'full'; }
  return {
    x: x,
    y: 0,
    width: Math.max(8, Math.round(vw - x)),
    height: Math.round(vh),
    why: why
  };
})()`;
  // Nothing has reached ffmpeg this long after start ⇒ say so out loud. Without
  // it the row sits on «подключение…» forever and the user has no way to tell a
  // broken capture from a slow start.
  const SCREEN_FIRST_FRAME_MS = 20000;
   // The audio side process is told to stop the moment the video process exits,
   // but it is not waited for indefinitely: a CDN socket that refuses to close
   // must not hold the finished recording hostage.
   const AUDIO_WAIT_MS = 10000;

/**
 * ffmpeg argv for the VIDEO process of screen mode.
 *
 * The frames are fed as PNG, not JPEG. `NativeImage.toJPEG()` is broken in the
 * Electron build this app ships with: it throws
 *   TypeError: Error processing argument at index 0, conversion failure from
 * on EVERY input — guest captures, embedder captures, and even a hand-built 8x8
 * PNG that never touched `capturePage`. It is a dead encoder, not a data problem,
 * and silently so: the old `catch { jpeg = null }` made a thrown TypeError look
 * exactly like a zero-length buffer. `toPNG()` is verified working on the same
 * captures.
 *
 * PNG rather than raw BGRA because it keeps the demuxer size-agnostic: every
 * frame carries its own dimensions, so resizing the window mid-recording is
 * absorbed instead of corrupting the stream. Raw BGRA would need the size frozen
 * before ffmpeg starts, i.e. a synchronous first capture, an async startScreen(),
 * and ~93 MB/s down the pipe at 10 fps for a 1774x1318 guest.
 *
 * TIMING — this is what makes the recording run at real-world speed. The pipe
 * cannot deliver 10 fps on a real machine: measured on a live room, the loop
 * settled at ~2.2 fps because every capturePage + PNG encode + write costs more
 * than the 100 ms frame interval. Declaring `-framerate 10` on the input and
 * `-r 10` on the output therefore told ffmpeg the 90 delivered frames were 9 s
 * of content when they were 31 s, and the file played ~3.3x too fast. The fix is
 * to stop lying about the clock:
 *   -use_wallclock_as_timestamps 1  timestamps each frame with the wall clock at
 *     which ffmpeg actually read it, so gaps between frames become real gaps;
 *   -fps_mode:v vfr keeps those real timestamps instead of resampling to a
 *     constant rate;
 *   the output -r is GONE — it is exactly what forced the wrong duration.
 * `-framerate` stays on the INPUT: the rawvideo demuxer needs it to build a
 * time base, but it no longer dictates playback speed.
 * Verified by measurement: 30 frames delivered over 10 s at 3 fps produced a
 * 3.00 s file with the old flags and a 9.80 s file with these.
 *
 * ONE FIXED CANVAS — `canvasW`/`canvasH` are frozen from the very first captured
 * frame and every later frame is RESIZED to exactly that box before it is sent,
 * so the file has one geometry for its whole life. This is not cosmetic. The
 * guest viewport changes height on its own during a recording (measured: 3004x883
 * for the first ticks, 3004x793 from the sixth as the page reflowed), and the
 * earlier `scale=trunc(iw/2)*2:trunc(ih/2)*2` reconfigured the filter graph
 * instead: samples of two different heights ended up in one MP4. Players that take
 * the display size from the track header then render every frame at 882 rows and
 * stretch the 792-row ones — which is exactly the "the picture looks squashed"
 * report.
 *
 * That is also why there is NO -vf any more. rawvideo needs every frame to be
 * exactly w*h*4 bytes, so the fit has to happen in JS anyway (NativeImage.resize)
 * — and once it does, `scale=…:decrease,pad=…` became redundant. It was actively
 * harmful: `pad` letterboxes every frame whose aspect differs from the canvas by
 * even 1 %, which is what put the black bars in the picture. Resizing straight to
 * the canvas instead costs at most the ~2 % aspect difference between the first
 * frame and a later one, and can never leave a bar.
 */
function screenFfmpegArgs(fps, out, canvasW, canvasH) {
  const w = even(canvasW);
  const h = even(canvasH);
  return [
    '-y', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats',
    // Give the demuxer room so a burst of frames is never the reason the pipe
    // fills; the producer is paced by the tick loop, not by this.
    '-thread_queue_size', '512',
    // rawvideo has no header to probe, so the usual probing budgets only add
    // latency before the first frame is accepted.
    '-probesize', '32', '-analyzeduration', '0',
    // RAW BGRA, not PNG. Measured on a live room: 197 PNG frames over 50 s with
    // stdin back-pressured on EVERY tick, and the delivered rate never exceeded
    // 4.9 fps — ffmpeg's single-threaded zlib inflate of a ~500 KB PNG per frame
    // is ~50-100 ms on its own, so the encoder, not the capture, was the floor.
    // NativeImage.toBitmap() hands over the pixels with no compression at all
    // (4 bytes/pixel, BGRA order), which removes both our encode and ffmpeg's
    // decode from the per-frame cost. The price is pipe volume: w*h*4 bytes per
    // frame, ~1.9 MB at the 1600x560 cap — 47 MB/s at 25 fps, which a Windows
    // pipe sustains comfortably.
    '-f', 'rawvideo',
    '-pixel_format', 'bgra',
    '-video_size', `${w}x${h}`,
    '-framerate', String(fps),
    // Input option: must sit BEFORE the -i it applies to. This is what makes the
    // file's duration match the wall clock instead of N_frames/fps — see above.
    '-use_wallclock_as_timestamps', '1',
    '-i', '-',
    '-map', '0:v',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    // Output option: variable frame rate — keep the real timestamps.
    '-fps_mode:v', 'vfr',
    // A GOP of 2 s rather than the default 250 frames. With `frag_keyframe`
    // this is also the fragment size, so a long recording stays seekable and
    // recoverable instead of writing one fragment per four minutes.
    '-g', String(Math.max(2, Math.round(fps * 2))),
    '-movflags', 'frag_keyframe+empty_moov',
    out,
  ];
}

/** Rounds to the nearest even pixel — H.264 with yuv420p rejects odd dimensions. */
function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * ffmpeg argv for the AUDIO side process of screen mode.
 *
 * The CDN stream must NOT be a second input of the video process. Measured on a
 * live room: with the FLV as input 1, ffmpeg blocks in avformat_find_stream_info()
 * on it — that probe is unbounded work it does BEFORE it writes anything, and no
 * flag makes an input non-blocking. The symptom was unmistakable: 197 healthy
 * PNG frames delivered over 50 s, stdin back-pressured on every single tick, and
 * the output frozen at the 36-byte container header with an empty stderr.
 *
 * So the audio lives in its OWN process that only demuxes and re-encodes audio,
 * and is muxed into the finished video afterwards (screenMuxArgs). The point is
 * not tidiness, it is containment: an audio process that dies, 403s or hits an
 * expired signature can no longer take the video down with it.
 *
 * Re-encoded to AAC rather than copied, which drops the aac_adtstoasc question
 * entirely (that bitstream filter is only needed when copying AAC out of FLV into
 * MP4) and decouples us from whatever codec the room happens to serve.
 * Output is raw ADTS, not .m4a: ADTS has no moov atom, so it is playable from any
 * prefix and survives the process being killed rather than only a clean exit.
 */
function screenAudioArgs(audioUrl, out) {
  return [
    '-y', '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats',
    // The CDN drops long-lived connections; these are the same flags ffmpegArgs()
    // uses for stream mode.
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '10000000',
    // Cap the probe so a silent room fails fast instead of hanging.
    '-analyzeduration', '3000000',
    '-probesize', '1000000',
    '-fflags', '+discardcorrupt',
    '-i', audioUrl,
    // No `?` here on purpose: a stream with no audio track should fail fast and
    // loudly so the caller falls back to a silent video.
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'adts',
    out,
  ];
}

/**
 * ffmpeg argv for the final `-c copy` mux of video + audio.
 *
 * `offsetSec` is a timeline shift for the AUDIO input, in seconds. It exists, and
 * the caller currently passes 0 — but the reasoning behind that zero is the whole
 * point of this comment, because getting it wrong produced an audible desync twice.
 *
 * The trap: "the audio sidecar produced its first byte 2.4 s after the recording
 * started" does NOT mean "the audio content is 2.4 s late". It means ffmpeg spent
 * 2.4 s connecting and probing the live FLV before it could hand over the first
 * audio frame. When it finally starts writing it emits the OLDEST packets it
 * buffered during that probe, so position 0 of the ADTS file already holds the
 * content that was live when the process started — aligned with the first captured
 * frame.
 *
 * Two failed corrections, both provable from the user's own recordings:
 *   1. clamping the shift to [-1, 0] pulled the audio EARLIER; ffprobe then showed
 *      video start_time 1.000000 against audio start_time 0.000000, and the tracks
 *      were 3.8-7 s apart.
 *   2. flipping it to shift FORWARD by the measured delay made the picture and sound
 *      2.4-6 s apart again — the desync was always exactly the size of the
 *      correction we had invented.
 * `ffprobe` is the check that settles it: with the shift applied, audio start_time
 * came out as precisely the value we had shifted by (2.430000), and the picture
 * still did not match the sound.
 *
 * `-shortest` is deliberately NOT used. The audio is shorter than the video (it
 * starts late and the video process is what gets stopped first), so `-shortest`
 * would cut the video off — losing the opening seconds of every recording. The
 * default (longest) keeps the full video and simply runs silent where there is no
 * audio.
 */
function screenMuxArgs(videoPath, audioPath, offsetSec, out) {
  // See the doc comment above: the caller passes 0 because the sidecar is already
  // aligned with the video. The plumbing stays so a genuinely measured shift can be
  // reintroduced without touching the signature.
  const shift = Math.max(0, Math.min(30, Number(offsetSec) || 0));
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    // Input option: belongs to the audio input and must precede its -i.
    '-itsoffset', shift.toFixed(2),
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    out,
  ];
}

/**
 * ffmpeg argv for the final mux when the audio came from THE BROWSER instead of
 * the CDN — a WebM/Opus sidecar recorded straight off the guest player's output.
 *
 * Why this path exists at all: the picture is filmed from a player that sits 2-5 s
 * behind the live edge, while a CDN capture reads the live edge directly, so the
 * two can never be lined up by a constant (three attempts failed — see
 * screenMuxArgs). Taking the sound from the same Chromium, after the same buffers,
 * makes them share one clock; the only number left is the difference between the
 * two Date.now() stamps, which is what `shiftSec` is.
 *
 * `shiftSec` is signed and small on purpose. It is the wall-clock difference between
 * the two recordings' start stamps, measured in seconds, and POSITIVE means "the
 * audio recording began later than the picture", which shifts the audio FORWARD
 * onto the video — the ordinary case here, because the capture can only start once
 * the video process is already running. (Verified against ffmpeg 9.0.2: `-itsoffset S`
 * places audio sample p at output time p + S, so S > 0 moves the track later.)
 * It is clamped to [-5, 5] because a larger value means the stamp is wrong, not that
 * the audio really is half a minute away — and a wrong shift of that size is exactly
 * the artefact this whole change exists to remove.
 *
 * Opus must be re-encoded: `-c copy` of Opus into MP4 is not a combination any
 * player agrees on, and the AAC pass also removes the WebM->MP4 sample-rate and
 * channel-layout surprises (Opus is 48 kHz by definition; the rest of the file is
 * 44.1 kHz stereo). The VIDEO is copied untouched — re-encoding it would cost a
 * second full pass for nothing.
 *
 * `-movflags frag_keyframe+empty_moov` mirrors the video process's own output
 * settings (see screenFfmpegArgs): the video input is a fragmented MP4, and
 * writing those packets into a plain moov-at-the-end MP4 is what produced a file
 * that played only after a full download in the earlier attempts.
 *
 * `-avoid_negative_ts make_zero` is load-bearing for a NEGATIVE shift, where the
 * shifted audio starts before zero.
 */
function screenGuestMuxArgs(videoPath, audioPath, shiftSec, out) {
  const shift = Math.max(-5, Math.min(5, Number(shiftSec) || 0));
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    // Input option: belongs to the audio input and must precede its -i.
    '-itsoffset', shift.toFixed(3),
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov',
    out,
  ];
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

    // Symmetry with the audio side: a write to a dying pipe must never become an
    // unhandled 'error' event in the main process. Attached HERE, after the job
    // literal — `job` is a `const` declared below the spawn, so touching it any
    // earlier is a temporal-dead-zone ReferenceError that kills every screen
    // recording before ffmpeg ever starts.
    try {
      job.child.stdin.on('error', () => {});
    } catch (_) {}

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

    // ---- audio side process -------------------------------------------------
    // Two things are measured here and both are load-bearing:
    //  1. WHEN the first audio sample existed. The process has to connect to
    //     TikTok's live edge and get through its probe before any sample is
    //     written, which measured at ~2.5 s. That lag is what screenMuxArgs
    //     shifts the track by, otherwise the sound trails the picture by that
    //     much for the whole recording. Read from -progress (out_time_ms is in
    //     MICROseconds) rather than by watching the file grow: on this machine
    //     the whole sidecar can be flushed in one go at exit, so file size is
    //     not a reliable clock.
    //  2. WHETHER it produced anything at all, so a silent room is reported as
    //     a silent recording instead of pretending the track is there.
    // Stream mode has no audio sidecar: the CDN URL is ffmpeg's only input and sound
// comes along for free. The audio side process belongs to screen mode only (see
// startScreen) — it was briefly wired up here, where `job.audioChild` is always
// null, so the block could never run and screen mode was left with no audio
// plumbing at all.

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
*   quality  — accepted for backwards compatibility and logged in the journal,
   *              but UNUSED: frames are PNG, which has no quality knob. Kept so
   *              an old caller passing it does not break.
   *
   * The loop is a recursive setTimeout, NOT setInterval: a stalled capturePage()
   * must delay the next tick rather than pile overlapping captures on top of it
   * (parallel capturePage calls are not allowed). Backpressure is bounded the
   * same way: when stdin.write() returns false the loop awaits ONE drain (capped
   * at one frame interval) instead of queueing frames without bound.
  *
* Progress stays backward compatible with the stream renderer:
 * { id, elapsedSec, durationSec, downloaded, resolution } plus
 * { frames, dropped, mode:'screen' }.
 *
 * ASYNC, deliberately. One capture has to happen BEFORE ffmpeg is spawned: the
 * output canvas is frozen from the first frame (see screenFfmpegArgs), because a
 * file that changes geometry mid-stream is what makes players stretch the picture.
 * The returned promise resolves to the same { id, path, startedAt } object as
 * before, so the only caller change is an `await`.
 */
 /**
 * One probe of the guest player's buffer lag. Same shape as every other guest
 * call in this file: raced against a timeout, and any failure is simply "unknown"
 * rather than an exception, because a recording must start even when the player
 * cannot be interrogated.
 */
async function measureAvLag(guest) {
  try {
    const res = await Promise.race([
      guest.executeJavaScript(AV_LAG_SOURCE, true),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
        if (t.unref) t.unref();
      }),
    ]);
    if (res && Number.isFinite(res.lag) && res.lag >= 0 && res.lag <= 60) return res.lag;
  } catch (_) {}
  return null;
}

// Three probes a third of a second apart, median wins. The player jitters as it
// catches up to and falls behind the live edge, so a single reading is a sample
// of a moving quantity; the middle of three is far steadier than any one of them.
async function measureAvLagStable(guest) {
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const lag = await measureAvLag(guest);
    if (lag !== null) seen.push(lag);
    if (i < 2) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 300);
        if (t.unref) t.unref();
      });
    }
  }
  if (!seen.length) return null;
  seen.sort((a, b) => a - b);
  return seen[Math.floor(seen.length / 2)];
}
async function startScreen(id, room, s, { guest, audioUrl = null, fps = SCREEN_FPS_DEFAULT, quality = SCREEN_QUALITY_DEFAULT, avShift = 0, onProgress, onDone, onError } = {}) {
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
   fps = Math.max(5, Math.min(30, Number(fps) || SCREEN_FPS_DEFAULT));
   quality = Math.max(10, Math.min(100, Number(quality) || SCREEN_QUALITY_DEFAULT));

   const dir = path.join(s.downloadDir || '.', 'live');
   try {
     fs.mkdirSync(dir, { recursive: true });
   } catch {}

const base = `${safeSegment(room.handle) || 'live'}_${localStamp()}`;
    let out = path.join(dir, `${base}.mp4`);
    for (let n = 2; fs.existsSync(out) && n < 100; n++) out = path.join(dir, `${base}_${n}.mp4`);

    // Video and audio are produced by two independent processes into side files
    // and combined once, at the very end. Nothing is ever muxed in place: a
    // failed or skipped mux must leave a perfectly playable video behind, which
    // is the whole reason for the split (see screenAudioArgs).
    const videoTmp = path.join(dir, `${base}.video.mp4`);
    const audioTmp = path.join(dir, `${base}.audio.aac`);
    const muxTmp = path.join(dir, `${base}.mux.mp4`);
    // Audio recorded from the BROWSER instead of the CDN (see screenGuestMuxArgs).
    // main fills this file through the hidden capture window; live.js only owns its
    // name, its liveness test and its deletion, so the two halves cannot disagree
    // about which file they are talking about.
    const guestTmp = path.join(dir, `${base}.guest.webm`);

/**
    * First capture, BEFORE ffmpeg exists. Two reasons, both learned the hard way:
    *   1. it fixes the output canvas for the whole recording (screenFfmpegArgs);
    *   2. it scales the pipe down. At the guest's native 3004 px, ffmpeg can only
    *      consume 3.45 frames/s of realistic PNG, which is what turned the
    *      recording into a 1.9 fps slideshow. At SCREEN_MAX_WIDTH it consumes
    *      8.35 — above what capturePage can deliver anyway.
    * The frame itself is reused as tick 1, so nothing is captured twice.
    */
let firstFrame = null;
    let firstSize = null;

    // WHAT gets recorded: the player card plus the chat column, and nothing else.
    // The guest viewport also contains TikTok's left sidebar (logo, «Назад»,
    // «Интересные трансляции», the subscriptions list, the «Купить монеты» button),
    // which is several hundred pixels of pure chrome that the user never asked to
    // keep — and it is what made the recorded picture look "distorted": a wide
    // window is mostly sidebar, so the interesting part ended up squeezed into the
    // middle of the frame at a strange proportion.
    //
    // The rect is returned in CSS pixels of the guest viewport, which is also the
    // unit capturePage(rect) expects and — at deviceScaleFactor 1 — the same unit
    // the captured bitmap is in, so no scale factor juggling is needed.
        // The layout must settle before anything is frozen. The output canvas is chosen
    // once, at spawn, and a rawvideo pipe cannot change its -video_size afterwards,
    // so a canvas measured while the page was still rearranging itself (or while
    // the user was toggling fullscreen) stays wrong for the entire recording and
    // shows up as frames cropped off the top and bottom. Three probes a third of a
    // second apart cost under a second and the LAST one wins.
    // A region and the frame captured for it are one observation. Keeping the
    // last region but the last NON-EMPTY frame let a timeout mix the two, and a
    // scale factor divided from mismatched widths is what put the cut in the
    // wrong place for the whole recording. They are stored together now.
    let region = null;
    let best = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let probe = null;
      try {
        probe = await Promise.race([
          guest.executeJavaScript(SCREEN_REGION_SOURCE, true),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
            if (t.unref) t.unref();
          }),
        ]);
      } catch (_) {
        probe = null;
      }
      if (!(probe && Number.isFinite(probe.x) && probe.width > 0 && probe.height > 0)) {
        probe = null;
      }
      let shot = null;
      try {
        shot = await Promise.race([
          probe ? guest.capturePage(probe) : guest.capturePage(),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
            if (t.unref) t.unref();
          }),
        ]);
      } catch (_) {
        shot = null;
      }
      if (shot && !shot.isEmpty()) best = { region: probe, shot: shot };
      if (attempt < 2) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 350);
          if (t.unref) t.unref();
        });
      }
    }
    if (best) {
      region = best.region;
      firstFrame = best.shot;
    }if (firstFrame && !firstFrame.isEmpty()) {
     try {
       firstSize = firstFrame.getSize();
     } catch (_) {
       firstSize = null;
     }
   }
    if (!firstSize || !firstSize.width || !firstSize.height) {
      return fail(
        'Не удалось получить первый кадр страницы. Вкладка «Обзор» должна быть открыта на эфире, ' +
          'окно — развёрнуто и не перекрыто.'
      );
    }
    // Device pixels per CSS pixel, measured rather than assumed. The region comes
    // back from the page in CSS pixels, capturePage() takes CSS pixels, but the
    // bitmap it returns — and NativeImage.crop() — work in DEVICE pixels. On a
    // HiDPI display those differ by the scale factor, and using one unit where
    // the other is expected is what cropped a zoomed corner out of the player
    // instead of cutting the navigation off.
    //
    // Both locals are declared here rather than further up: this function is
    // 'use strict', so an undeclared name throws a ReferenceError and the
    // recording dies before ffmpeg is ever spawned.
    let job_dsf = 1;
    let regionPx = null;
    const dsf = region && region.width ? firstSize.width / region.width : 1;
    job_dsf = Number.isFinite(dsf) && dsf > 0.2 && dsf < 8 ? dsf : 1;
    regionPx = region && region.width ? {
      x: Math.round(region.x * job_dsf),
      y: Math.round(region.y * job_dsf),
      width: Math.round(region.width * job_dsf),
      height: Math.round(region.height * job_dsf),
    } : null;
   // Scale by whichever limit binds first: the width cap, or the pixel budget
   // (see SCREEN_MAX_PIXELS — ffmpeg's ceiling is about pixels per frame, so a
   // tall narrow window must be capped by area too or it keeps the 3.5 fps).
   const srcPx = firstSize.width * firstSize.height;
   const scale = Math.min(
 1,
     SCREEN_MAX_WIDTH / firstSize.width,
     Math.sqrt(SCREEN_MAX_PIXELS / srcPx)
   );
   // How far the player is behind the live edge, measured while the page is already
// settled. This is the value that lines the audio up with the picture.
const avLag = await measureAvLagStable(guest);
const canvasW = even(firstSize.width * scale);
   const canvasH = even(Math.max(2, firstSize.height * scale));

   let child;
   try {
     child = spawn(exe, screenFfmpegArgs(fps, videoTmp, canvasW, canvasH), {
        windowsHide: true,
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return fail(`Не удалось запустить ffmpeg: ${e.message}`);
    }

    // The audio process is best-effort: any failure here must degrade to a
    // silent recording, never to a failed one.
    let audioChild = null;
    if (audioUrl) {
      try {
        audioChild = spawn(exe, screenAudioArgs(audioUrl, audioTmp), {
          windowsHide: true,
          cwd: dir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        audioChild = null;
      }
      // A guest ffmpeg's stdin is a network input, so it never reads our `q`; if
      // the stream is gone the write lands on a half-torn-down pipe instead.
      // Swallowing stdin errors keeps that from becoming an unhandled 'error'
      // event, which is what crashed the main process on every manual stop.
      if (audioChild) {
        try {
          audioChild.stdin.on('error', () => {});
        } catch (_) {}
      }
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
      // Diagnostic tail, mirrored into the job row so the UI can show WHY a
      // screen recording is stuck. Screen mode has failed three rounds of
      // static analysis with three wrong guesses; a journal beats a guess.
      diag: '',
      diagTicks: 0,
      // Real-frame-rate bookkeeping for the UI readout (see emit()).
      fpsRate: 0,
lastFpsAt: 0,
      lastFpsFrames: 0,
    needsDrain: false,
      // Frozen output geometry for the whole recording + the first captured
      // frame, which is pushed as frame 1 so the pre-spawn capture is not wasted.
      canvasW,
      canvasH,
      firstFrame,
      // The player+chat rect in FULL-viewport CSS pixels, or null. Frames that
      // arrive whole (a compositor subscription frame always is) get cropped to
      // it before being fitted, so every source of pixels ends up showing exactly
      // the same thing.
      region,
      // The same rectangle in DEVICE pixels, for NativeImage.crop(). The scale
      // factor is measured from the first frame instead of read from a setting,
      // because the two disagree in exactly the situations that matter.
      regionPx,
      dsf: job_dsf,
      lastRegionCheck: 0,
      videoClosed: false,
      finalized: false,
      audioWaitTimer: null,
      audioPollTimer: null,
      // stopAudioProcess can be reached twice: once from stop() and again from
      // finishScreen() when the video process closes. The second call used to
      // write to an already-ended stdin and crash the app with
      // ERR_STREAM_WRITE_AFTER_END, so the "asked to stop" state is explicit.
      audioStopping: false,
      videoTmp,
      guestTmp,
      // --- audio side process (see screenAudioArgs) ---
      audioChild,
      audioUrl: audioUrl || null,
      audioTmp,
      muxTmp,
      // --- audio from the browser (see screenGuestMuxArgs) ---
      // The stopper main installs once its capture is actually running. Until then
      // `flushed` is true: there is nothing to wait for, so finalize() proceeds
      // exactly as it did before this feature existed.
      guestAudioStop: null,
      guestAudioFlushed: true,
      guestAudioWaitTimer: null,
      // Absolute stamps from the two sources, both Date.now() taken in main or in
      // the capture page. Their difference is the only shift the mux applies.
      guestAudioStartAt: null,
      guestAudioVideoAt: null,
      // Wall clock at which the audio process produced its first sample, taken
      // from its own -progress stream. The difference against startedAt is how
      // far the audio lags the video, and it is what screenMuxArgs shifts by.
      audioStartedAt: null,
      audioClosed: false,
      audioStopTimer: null,
      audioKillTimer: null,
      audioErrTail: '',
      audioOk: false,
      onProgress,
     onDone,
     onError,
   };
running.set(id, job);
    // Seconds of audio to delay by so it matches the picture. null means "not
  // measurable" and is handled as 0 with a journal note.
  job.avOffsetSec = avLag;
    // The dock's own correction in seconds, carried into the final mux.
    job.avUserShift = Number.isFinite(Number(avShift)) ? Number(avShift) : 0;

    // ---- screen-mode diagnostics -------------------------------------------
    // Everything below is inert unless something asks for it, and costs one
    // appendFileSync per line while a screen recording runs. The log lives next
    // to the recordings so a user can just send the file back.
    const diagFile = path.join(s.downloadDir || '.', 'live', '_screen.log');
    const journal = (text) => {
      const line = `${new Date().toISOString()} ${text}`;
      try {
        fs.appendFileSync(diagFile, line + '\n');
      } catch (_) {
        /* the log is best-effort; never let it break a recording */
      }
      // Keep the last ~2 lines in the row: long enough to be read in a
      // screenshot, short enough not to blow the layout up.
      const prev = job.diag ? job.diag.split('\u001f') : [];
      prev.push(text);
      job.diag = prev.slice(-2).join(' \u2014 ');
      return line;
    };
    // On the job, so the module-level jobNote() reaches the same log file.
    job.journal = journal;
    journal(
      `start handle=${room.handle || '?'} mode=screen fps=${job.fps} ` +
        `quality=${job.quality} audio=${audioUrl ? 'yes' : 'no'} ` +
        `guest=${guest && guest.id}`
    );
    try {
      journal(`guest url ${String(guest.getURL()).slice(0, 120)}`);
    } catch (_) {
      journal('guest url unavailable');
    }
    try {
      journal(`video argv ${JSON.stringify(screenFfmpegArgs(job.fps, videoTmp, job.canvasW, job.canvasH))}`);
    } catch (e) {
      journal(`video argv unavailable: ${e.message}`);
    }
    // The resolved rect is journalled here, not where it was measured: this is
    // the first point below the declaration of `journal` itself.
    if (job.region) {
      journal(
        `capture: region ${Math.round(job.region.x)},${Math.round(job.region.y)} ` +
          `${Math.round(job.region.width)}x${Math.round(job.region.height)} css, ` +
          `${job.regionPx ? job.regionPx.width + 'x' + job.regionPx.height : '?'} px, ` +
          `x${job.dsf.toFixed(2)} (${job.region.why || 'player'})`
      );
    } else {
      journal('capture: region not resolved — recording the whole page');
    }
    if (job.audioChild) {
      try {
        journal(`audio argv ${JSON.stringify(screenAudioArgs(audioUrl, audioTmp))}`);
      } catch (e) {
        journal(`audio argv unavailable: ${e.message}`);
      }
    } else if (audioUrl) {
      journal('audio process could not be spawned — recording without sound');
    }

const emit = (force) => {
      const now = Date.now();
  if (!force && now - job.lastProgress < PROGRESS_EVERY_MS) return;
      job.lastProgress = now;
      // Real frames per second, measured over the last reporting window. The
      // nominal 10 is a lie on a real machine — capturePage plus the encode
      // decide this — and it is exactly the number a user needs to judge whether
 // the recording will look like video or like a slideshow.
      const spanSec = job.lastFpsAt ? (now - job.lastFpsAt) / 1000 : 0;
      if (spanSec >= 0.5) {
      job.fpsRate = (job.frames - job.lastFpsFrames) / spanSec;
job.lastFpsAt = now;
        job.lastFpsFrames = job.frames;
      }
      onProgress &&
  onProgress({
     id,
        elapsedSec: Math.floor((now - job.startedAt) / 1000),
        durationSec: job.durationSec,
        downloaded: fileSize(videoTmp),
        resolution: job.resolution || 'экран',
    frames: job.frames,
        dropped: job.dropped,
   fps: job.fpsRate,
        mode: 'screen',
        note: job.diag || '',
      });
    };

   // On the JOB, not a local: finalize() runs from the audio process's close
   // handler, which is a different callback entirely and cannot see locals.
   job.result = () => ({
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

// Stall watchdog — and in screen mode it must watch the FRAME COUNTER, not
    // the output file. Measured: a perfectly healthy recording leaves the output
    // at the 36-byte container header for its entire run and jumps to full size
    // only when ffmpeg is asked to stop. Watching file size would therefore have
    // killed every screen recording at the 2-minute mark, and the older
    // "30s of frames but a tiny file" mux-stall check (added when the audio was a
    // second input and really could block the muxer) would have cried wolf on
    // every long run. Both premises are gone; frame arrival is the honest signal.
    job.stallTimer = setInterval(() => {
      if (job.stopping || job.settled) return;
      if (job.frames !== job.lastSize) {
        job.lastSize = job.frames;
        job.lastGrow = Date.now();
        return;
      }
      if (Date.now() - job.lastGrow > STALL_LIMIT_MS) {
        stop(id, 'Страница перестала отдавать кадры — запись остановлена.');
      }
    }, STALL_POLL_MS);
if (job.stallTimer.unref) job.stallTimer.unref();

    // "Nothing is being captured" watchdog. The stall timer below watches the
    // OUTPUT FILE, which stays at 0 bytes for the whole first two minutes of a
    // healthy screen recording, so it cannot tell "slow start" from "capture is
    // dead". This one watches the frame counter and speaks up in 20 s.
    job.firstFrameTimer = setTimeout(() => {
      if (job.settled || job.stopping || job.frames > 0) return;
      failScreen(
        'Запись экрана не началась: страница не отдаёт кадров. ' +
          'Окно приложения должно быть развёрнуто и не перекрыто другими окнами, ' +
          'а вкладка «Обзор» — активной. Если окно свёрнуто, Chromium перестаёт ' +
          'рисовать страницу, и кадровать её нечего.'
      );
    }, SCREEN_FIRST_FRAME_MS);
    if (job.firstFrameTimer.unref) job.firstFrameTimer.unref();

   // The capture loop. Recursive setTimeout (see the doc comment above); every
   // exit path either schedules the next tick or ends in failScreen/stop.
   const intervalMs = Math.max(40, Math.round(1000 / job.fps));
   // Heartbeat cadence for the journal. Time-based, not tick-based: the delivered
   // rate varies with what the compositor is doing, and a tick counter would make
   // the gap between log lines a function of that rate.
   let lastLogAt = 0;
   const schedule = () => {
     if (job.stopping || job.settled || job.screenStopped) return;
     job.screenTimer = setTimeout(tick, intervalMs);
     if (job.screenTimer.unref) job.screenTimer.unref();
   };

   /**
    * Frames straight from the compositor, when the guest supports it.
    *
    * capturePage() is a COPY of the rendered surface: a GPU readback plus a
    * round trip into the browser process. Measured on the user's own window at
    * 2466x713 that is ~200 ms, which alone caps a polling loop at ~5 fps no matter
    * how fast the encoder is — the frame rate is not a codec problem.
    *
    * beginFrameSubscription hands over the composited frame itself as the event
    * fires, with no copy at all, so the ceiling becomes "how often does the page
    * repaint" instead of "how slow is the readback". A live room repaints
    * constantly, which is exactly where this pays off.
    *
    * It is a best-effort path: availability is checked, every failure is caught,
    * and a tick that gets no frame within FRAME_WAIT_MS falls back to capturePage().
    * A page that simply stops repainting (a paused stream) must not stall the
    * recording, so the wait is capped rather than open-ended.
    */
   let frameWaiters = [];
   let pendingFrame = null;
   let usingSubscription = false;
   let subMisses = 0;
    // A frame from the compositor subscription covers the WHOLE viewport, so the
    // region has to be cut out of it — and that is where the recording kept going
    // wrong. The bitmap Electron hands over here is not reliably anchored at the
    // viewport's top-left corner, so cutting it with the region's own coordinates
    // lands on the wrong rows: the recording showed the page shifted up, with the
    // player's header gone and the bottom row of the gift bar sliced off. Nothing
    // in the image says where it starts, so there is no way to correct it after
    // the fact.
    //
    // capturePage(job.region), by contrast, is asked for that rectangle and gets
    // exactly that rectangle — the device-pixel scale factor and the origin are
    // the capture pipeline's problem, not ours. Measured cost of dropping the
    // subscription when a region is active: about 13 fps to about 9, which is
    // well above what the rest of the pipeline sustains anyway.
    //
    // So the subscription is used only when there is nothing to cut.
    if (region && region.why && region.why !== 'full') {
      journal(`capture: region active (${region.why || 'player'}) — polling capturePage for exact framing`);
    } else if (typeof guest.beginFrameSubscription === 'function') {
      // The options object is tried FIRST and the bare call is the fallback,
      // because in this Electron build the conversion layer rejects it:
      //   "Error processing argument at index 1, conversion failure from"
      // — index 1 IS the options. Exactly the same failure NativeImage.toJPEG()
      // hits, and the same broken argument marshalling behind both. So the
      // subscription is retried without options before giving up: without it
      // we would keep polling at ~half the rate for a purely cosmetic reason.
      const onFrame = (image) => {
        const waiters = frameWaiters;
        frameWaiters = [];
        if (waiters.length) {
          for (const resolve of waiters) resolve(image);
        } else {
          // Nobody waiting — keep only the newest; older ones are already stale.
          pendingFrame = image;
        }
      };
      let lastErr = null;
      for (const opts of [{ onlyDirty: false }, undefined]) {
        try {
          if (opts) guest.beginFrameSubscription(onFrame, opts);
          else guest.beginFrameSubscription(onFrame);
          usingSubscription = true;
          journal(`capture: compositor frame subscription active (${opts ? 'with options' : 'no options'})`);
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!usingSubscription) {
        journal(`capture: frame subscription unavailable (${lastErr && (lastErr.message || lastErr)}) — polling`);
      }
    } else {
      journal('capture: beginFrameSubscription not supported — polling');
    }

   const takePendingFrame = () => {
     const f = pendingFrame;
     pendingFrame = null;
     return f;
   };

   /** Resolves with the next compositor frame, or null if none arrives in time. */
   const waitForCompositedFrame = () =>
     new Promise((resolve) => {
       let settled = false;
       const finish = (img) => {
         if (settled) return;
         settled = true;
         clearTimeout(t);
         frameWaiters = frameWaiters.filter((r) => r !== onFrame);
         resolve(img);
       };
       const onFrame = (img) => finish(img);
       const t = setTimeout(() => finish(null), FRAME_WAIT_MS);
       if (t.unref) t.unref();
       frameWaiters.push(onFrame);
     });

   /** The old path: an explicit copy of the guest surface, with a deadline.
    *  Takes the player+chat rect when we have one, so the sidebar is never copied. */
   const captureWithDeadline = () =>
     Promise.race([
       job.region ? guest.capturePage(job.region) : guest.capturePage(),
       new Promise((resolve) => {
         const t = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
         if (t.unref) t.unref();
       }),
     ]);

   /** One frame, whichever way we can get it. */
   const nextFrame = async () => {
     const ready = takePendingFrame();
     if (ready) return ready;
     if (usingSubscription) {
       const img = await waitForCompositedFrame();
       if (img && !img.isEmpty()) {
         subMisses = 0;
         return img;
       }
       // The compositor went quiet. A paused stream is normal, so fall back to the
       // copy rather than stalling — but if that keeps happening the subscription
       // is not delivering and polling is the better tool.
       subMisses += 1;
       if (subMisses > 10 && subMisses * FRAME_WAIT_MS > 5000) {
         usingSubscription = false;
         journal('capture: subscription went quiet after repeated misses — polling from now on');
       }
     }
     return await captureWithDeadline();
   };

   job.stopFrameSubscription = () => {
     if (typeof guest.endFrameSubscription === 'function') {
       try {
         guest.endFrameSubscription();
       } catch (_) {}
     }
     frameWaiters = [];
     pendingFrame = null;
   };

const noteBlank = (why) => {
      job.blankCount += 1;
      if (job.diagTicks < 12) journal(`blank#${job.blankCount} (${why})`);
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
      if (job.stopping || job.settled || job.screenStopped) {
        journal('tick skipped: stopping/settled/screenStopped');
        return;
      }
      // Backpressure gate — checked BEFORE capturing anything. The previous code
      // wrote the frame even after write() returned false and then merely waited
      // for one 'drain' afterwards, which does not undo the write: stdin.write()
      // returns false AFTER accepting the chunk. With a 500 KB PNG every 100 ms
      // the buffer therefore grew without bound (the journal's `dropped=0` was an
      // artefact of that, not evidence of a healthy pipeline) and the frames
      // queued up further and further behind the live screen.
      //
      // Dropping is both the bounded-memory option and the correct one now: with
      // -use_wallclock_as_timestamps a missing frame just means the previous one
      // is held that much longer, so the recording stays true to real time
      // instead of being compressed. That is only safe BECAUSE the timing fix
      // landed — dropping under the old fixed-rate flags would have silently
      // shortened every recording.
      if (job.needsDrain) {
        job.dropped += 1;
        if (job.diagTicks < 20) journal('dropped: pipe still full, ffmpeg is behind');
        emit(false);
        schedule();
        return;
      }
      job.diagTicks += 1;
      const tickNo = job.diagTicks;
      // First 10 ticks are logged individually; after that one line a second is
      // plenty to show whether the loop is alive and productive.
      const loud = tickNo <= 10;
      let img = null;
      // The pre-spawn capture is handed straight to the first tick: it is already
      // in hand, it is exactly the frame the canvas was derived from, and
      // capturing again would both waste a frame interval and race the resize.
      if (job.firstFrame) {
        img = job.firstFrame;
        job.firstFrame = null;
        if (loud) journal('tick 1: frame 1 reused from the pre-spawn capture');
      } else {
        try {
          img = await nextFrame();
        if (loud) journal(`tick ${tickNo}: capture ${img ? 'ok' : 'TIMEOUT'}`);
      } catch (e) {
        img = null;
        journal(`tick ${tickNo}: capture threw ${e && (e.message || e)}`);
        }
      }
      if (job.stopping || job.settled || job.screenStopped) return;
      if (!img || img.isEmpty()) {
        noteBlank(img ? 'empty image' : 'no image');
        return;
      }
     let size = null;
     try {
       size = img.getSize();
     } catch (_) {
       size = null;
     }
if (!size || !size.width || !size.height) {
        noteBlank(`zero size ${size ? size.width + 'x' + size.height : 'no size'}`);
        return;
      }
job.blankCount = 0;
      if (!job.resolution) job.resolution = `${job.canvasW}x${job.canvasH}`;

      // Fit every frame to exactly the frozen canvas. rawvideo needs each sample to
      // be precisely canvasW*canvasH*4 bytes with no padding, so the fit has to
      // happen here regardless.
      //
      // It happens by CROP-THEN-SCALE, never by stretching to the canvas. A rawvideo
      // input has a fixed -video_size, so a mismatched frame must be brought to it
      // somehow, and the two options are not equivalent: stretching rescales x and y
      // by different factors and silently changes the geometry of everything in the
      // picture, whereas cropping discards the overflow and leaves every remaining
      // pixel at its true proportion. Cropping also cannot produce black bars, which
      // is what ffmpeg's scale+pad used to give the user frame after frame. The
      // canvas is frozen from the first frame so in practice the crop is a sliver;
      // it only grows when the user resizes the window mid-recording, and then the
      // correct choice is still to lose an edge rather than to squash the picture.
      let frame = img;
      let pad = null;
      try {
        // Frames that came from a compositor subscription cover the WHOLE viewport,
        // so they still carry the sidebar and have to be cut down to the region
        // first. Polling frames were already captured with the rect as the
        // argument and need nothing; comparing sizes tells the two apart without
        // threading a flag through.
        if (job.regionPx && Math.abs(size.width - job.regionPx.width) > 2) {
          const r = job.regionPx;
          const cw = Math.min(size.width, Math.max(2, Math.round(r.width)));
          const ch = Math.min(size.height, Math.max(2, Math.round(r.height)));
          const cx = Math.max(0, Math.min(size.width - cw, Math.round(r.x)));
          const cy = Math.max(0, Math.min(size.height - ch, Math.round(r.y)));
          frame = img.crop({ x: cx, y: cy, width: cw, height: ch });
        }
        if (size.width !== job.canvasW || size.height !== job.canvasH) {
          // FIT, NEVER CROP. The output canvas is frozen, so when the captured
          // rectangle changes shape - the window is resized, the recording panel
          // opens, the stream goes fullscreen - a centre-crop silently throws away
          // an edge: that is how the player header and the right-hand side of the
          // chat disappeared. Scaling the frame down until it fits and leaving the
          // remainder black keeps every pixel of the page. Short edges are never
          // scaled UP either, so a small capture is not blown up into blur.
          const fit = Math.min(job.canvasW / size.width, job.canvasH / size.height);
          const nw = Math.max(2, Math.min(job.canvasW, Math.round(size.width * fit)));
          const nh = Math.max(2, Math.min(job.canvasH, Math.round(size.height * fit)));
          frame = frame.resize({ width: nw, height: nh, quality: 'good' });
          if (nw === job.canvasW && nh === job.canvasH) {
            pad = null;
          } else {
            pad = { w: nw, h: nh,
                    x: Math.floor((job.canvasW - nw) / 2),
                    y: Math.floor((job.canvasH - nh) / 2) };
          }
        } else {
          pad = null;
        }
      } catch (e) {
        journal(`tick ${tickNo}: crop/resize threw ${e && (e.message || e)}`);
        frame = img;
        pad = null;
      }
      // RAW PIXELS, not PNG. See screenFfmpegArgs: the PNG encode here plus
      // ffmpeg's zlib inflate of it was the measured floor at ~5 fps.
      let raw = null;
      try {
        const small = frame.toBitmap();
        if (!pad) {
          raw = small;
        } else {
          // Letterbox: a fresh black canvas of exactly the frozen size with the
          // scaled frame copied in row by row. rawvideo needs every sample to be
          // precisely canvasW*canvasH*4 bytes, so the padding has to happen here,
          // and doing it as a copy is far cheaper than any per-pixel loop in JS.
          raw = Buffer.alloc(job.canvasW * job.canvasH * 4);
          const rowBytes = pad.w * 4;
          for (let row = 0; row < pad.h; row++) {
            small.copy(raw, ((pad.y + row) * job.canvasW + pad.x) * 4,
              row * rowBytes, (row + 1) * rowBytes);
          }
        }
      } catch (e) {
        journal(`tick ${tickNo}: toBitmap threw ${e && (e.message || e)}`);
        raw = null;
      }
      const want = job.canvasW * job.canvasH * 4;
      if (!raw || raw.length !== want) {
        job.dropped += 1;
        if (loud) journal(`tick ${tickNo}: bitmap ${raw ? raw.length : 0}B, expected ${want}B`);
        schedule();
        return;
      }
 let accepted = false;
      try {
        accepted = job.child.stdin.write(raw);
     } catch (_) {
       // EPIPE — ffmpeg is already gone; the 'close' handler reports it.
job.dropped += 1;
       journal(`tick ${tickNo}: stdin write threw (ffmpeg gone?)`);
       schedule();
       return;
     }
job.frames += 1;
      if (!accepted) {
        // Mark the pipe as full and forget this frame. The gate at the top of
        // tick does the waiting; the timeout is a safety net in case 'drain'
        // never fires because ffmpeg died (the 'close' handler reports that).
        job.needsDrain = true;
        const clearFlag = () => {
          job.needsDrain = false;
        };
        try {
          job.child.stdin.once('drain', clearFlag);
        } catch (_) {}
        const t = setTimeout(clearFlag, Math.max(250, intervalMs * 4));
        if (t.unref) t.unref();
      }
      if (loud) {
        journal(
          `tick ${tickNo}: frame ${job.frames} ${size.width}x${size.height}→${job.canvasW}x${job.canvasH} ` +
            `${Math.round(raw.length / 1024)}KB backpressure=${!accepted} file=${fileSize(videoTmp)}B`
        );
} else if (Date.now() - lastLogAt >= 1000) {
        lastLogAt = Date.now();
        const secs = Math.round((Date.now() - job.startedAt) / 1000);
        // The region was measured once, before ffmpeg was spawned. The page keeps
        // living after that: the user can resize the window, or TikTok can reflow
        // when a gift panel opens. A region that has gone stale does not produce an
        // error — it quietly records the wrong thing for the rest of the session —
        // so it is re-measured every few seconds. Only the crop moves; the output
        // canvas stays frozen, which is what keeps the file geometry valid.
        if (secs > 0 && secs % 5 === 0 && job.lastRegionCheck !== secs) {
          job.lastRegionCheck = secs;
          try {
            guest
              .executeJavaScript(SCREEN_REGION_SOURCE, true)
              .then((fresh) => {
                if (job.settled) return;
                const was = job.region;
                const same =
                  (!was && !fresh) ||
                  (was &&
                    fresh &&
                    Math.abs(was.x - fresh.x) < 8 &&
                    Math.abs(was.width - fresh.width) < 8 &&
                    (was.why || '') === (fresh.why || ''));
                if (same) return;
                job.region = fresh && fresh.width ? fresh : null;
                // The device-pixel rectangle is derived from a scale measured once
                // at spawn. A re-probed region invalidates it: it is recomputed from
                // the next frame's actual size rather than from a stale assumption.
                job.regionPx = null;
                journal(
                  job.region
                    ? `capture: region moved to ${job.region.x},${job.region.y} ${job.region.width}x${job.region.height}`
                    : 'capture: region lost - recording the whole page from now on'
                );
              })
              .catch(() => {});
          } catch (_) {
            /* the probe is advisory; a failure must not disturb the recording */
          }
        }
        // The delivered rate is whatever the compositor produces, capped by the
        // frame interval. That is no longer a timing problem — the wallclock
        // timestamps in screenFfmpegArgs turn any delivery rate into a correctly
        // long file.
        journal(
          `t+${secs}s frames=${job.frames} ` +
            `dropped=${job.dropped} file=${fileSize(videoTmp)}B ` +
            `rate=${(job.frames / Math.max(1, secs)).toFixed(1)}fps ` +
            `src=${usingSubscription ? 'subscription' : 'poll'} ` +
            `audio=${job.audioChild ? 'yes' : 'no'}`
        );
      }
emit(false);
      schedule();
    };

    emit(true);
    schedule();

    child.on('error', (e) => {
      journal(`child error: ${e && (e.message || e)}`);
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

/**
   * Combines the finished video and audio sidecars into the final file.
   *
   * Order matters and is the reason this is a function at all:
   *   1. the video process must have closed (its output is complete),
   *   2. the audio process must have closed too — but never at the cost of
   *      waiting forever for it; AUDIO_WAIT_MS is an absolute cap,
   *   3. the mux runs into a THIRD path and is then renamed over the final name,
   *   4. if any of that fails, the video sidecar is renamed into place on its
   *      own. Losing the audio is acceptable; losing the recording is not.
   */
const finishScreen = () => {
      if (job.finalized || !job.videoClosed) return;
      // The browser capture is still appending to its sidecar: ask it to flush and
      // give it a bounded moment to do so. Without this the file can be mid-chunk
      // when the mux reads it, and — worse — it can be deleted while the recorder
      // holds it open.
      if (!job.guestAudioFlushed && job.guestAudioStop) {
        try {
          job.guestAudioStop();
        } catch (_) {}
        if (!job.guestAudioWaitTimer) {
          job.guestAudioWaitTimer = setTimeout(() => {
            job.guestAudioFlushed = true;
            journal(`guest audio: still writing ${AUDIO_WAIT_MS}ms after video exit — continuing anyway`);
            finishScreen();
          }, AUDIO_WAIT_MS);
          if (job.guestAudioWaitTimer.unref) job.guestAudioWaitTimer.unref();
        }
        return;
      }
      if (job.audioChild && !job.audioClosed) {
        stopAudioProcess();
        if (!job.audioWaitTimer) {
          journal(`audio still running ${AUDIO_WAIT_MS}ms after video exit — continuing without it`);
          job.audioWaitTimer = setTimeout(() => {
            markAudioClosed();
            finalize();
          }, AUDIO_WAIT_MS);
          if (job.audioWaitTimer.unref) job.audioWaitTimer.unref();
        }
        return;
      }
      finalize();
    };

    const finalize = () => {
      if (job.finalized) return;
      job.finalized = true;
      if (job.audioWaitTimer) {
        clearTimeout(job.audioWaitTimer);
        job.audioWaitTimer = null;
      }
      if (job.guestAudioWaitTimer) {
        clearTimeout(job.guestAudioWaitTimer);
        job.guestAudioWaitTimer = null;
      }

      const videoSize = fileSize(videoTmp);
      if (videoSize <= 0) {
        job.onError &&
          job.onError(
            job.stopping
              ? 'Остановлено до того, как страница отдала первый кадр.'
              : 'Запись пустая — страница не отдала ни одного кадра.'
          );
        return;
      }

      let hasAudio = false;
      // ---- audio taken from the BROWSER (preferred) --------------------------
      // The whole point of screenGuestMuxArgs: the sound was recorded off the same
      // Chromium that produced the picture, so it needs no guesswork — just the
      // difference between the two wall clocks.
      //
      // 8192 bytes is the same threshold the CDN sidecar uses and for the same
      // reason: below it there is no header plus a meaningful payload, so the file
      // is a capture that started and never produced sound (silent room, muted
      // player, a request that never resolved).
      const guestSize = fileSize(guestTmp);
      const guestUsable = guestSize > 8192;
      // Why the browser track is unusable, in words the user could act on. Only
      // built when it is unusable — the value is journalled, not shipped anywhere.
      const guestReason = !job.guestAudioStop
        ? 'захват из плеера не запускался'
        : guestSize > 0
          ? `в файле только ${guestSize}B`
          : 'файл не создан или пуст';
      if (guestUsable) {
        const audioStartedAt = Number(job.guestAudioStartAt) || 0;
        const videoStartedAt = Number(job.guestAudioVideoAt) || job.startedAt;
        // Positive when the recording of the sound began LATER than the video's
        // first frame — the normal case, since the capture starts after
        // startScreen(). It shifts the AUDIO timeline forward onto the picture.
        //
        // SIGN, MEASURED NOT GUESSED. `-itsoffset S` places audio sample p at
        // output time p + S, so POSITIVE S moves the track LATER. Verified against
        // ffmpeg 9.0.2 with a 0.25 s tone at the head of the webm: at
        // `-itsoffset 1.250` the tone ends 1.267 s later in the output than it does
        // unmuxed, and a 4 s video + 3 s audio pair comes out 4.25 s long (the
        // audio tail hangs past the picture) rather than 4.00.
        //
        // Therefore the sign is audioStartedAt MINUS videoStartedAt, and it is
        // positive in the ordinary case: the capture can only start once
        // startScreen() has returned, so the sound necessarily begins LATER than
        // the first captured frame and has to be pushed forward by that much.
        // Algebra, since it is short: audio input timestamp p was captured at wall
        // clock T_audio + p and lands at output p + S; video output time t was
        // captured at T_video + t. Same content means T_audio + (t - S) = T_video + t,
        // i.e. S = T_audio - T_video.
        const shift = audioStartedAt
          ? Math.max(-5, Math.min(5, (audioStartedAt - videoStartedAt) / 1000))
          : 0;
        journal(
          `guest audio: startedAt=${audioStartedAt} videoStartedAt=${videoStartedAt} ` +
            `shift=${shift.toFixed(3)}s bytes=${guestSize}`
        );
        try {
          const mux = spawnSync(
            binaries.ffmpeg() || 'ffmpeg',
            screenGuestMuxArgs(videoTmp, guestTmp, shift, muxTmp),
            { windowsHide: true, cwd: dir, encoding: 'utf8', timeout: 120000 }
          );
          if (mux.status === 0 && fileSize(muxTmp) > 0) {
            fs.renameSync(muxTmp, out);
            hasAudio = true;
            journal(`guest audio: muxed from ${guestTmp}`);
            try {
              if (fs.existsSync(videoTmp)) fs.unlinkSync(videoTmp);
            } catch (_) {}
          } else {
            journal(
              `guest audio: mux failed status=${mux.status} ${String(mux.stderr || '').slice(-300)}`
            );
          }
        } catch (e) {
          journal(`guest audio: mux threw ${e && (e.message || e)}`);
        }
      }

      // ---- fallback: the CDN sidecar (see screenAudioArgs) ------------------
      // Layered liveness test. Requiring audioStartedAt alone silently discarded
      // real recordings: measured on a live room the ADTS sidecar reached 256 KB
      // while -progress never reported out_time_ms above zero, so the audio was
      // thrown away and the user got a silent file with no explanation. A sidecar
      // with real bytes in it is usable evidence on its own; the offset only
      // affects sync, and 0 is a better guess than discarding the track.
      const audioSize = fileSize(audioTmp);
      if (!hasAudio && job.audioChild && audioSize > 8192) {
        const rawDelay = job.audioStartedAt
          ? (job.audioStartedAt - job.startedAt) / 1000
          : 0;
        // NO SHIFT AT ALL. The measured delay is when the audio process wrote its
        // first byte to the sidecar, which is ffmpeg's connect + probe + buffering
        // time — NOT how late the audio content is. ffmpeg outputs the OLDEST
        // packets it buffered during probing, so the first sample it writes is
        // already the content that was live when the process started, and the sidecar
        // is aligned with the first captured frame.
        //
        // Proof from the user's own file: audio start_time came out as exactly the
        // value we had shifted by (2.430000 == "audio first sample after 2.43s"),
        // and the picture still did not match the sound — the desync was the size of
        // the correction we had invented. Shifting by it put the audio 2.4 s late.
        // The delay is still journalled: it is a useful health signal (a healthy
        // room is 2-6 s), it just has no business touching the timeline.
        // THE SHIFT IS THE SUM OF TWO INDEPENDENT DELAYS. Both were applied on their
        // own first, and each desynced by roughly the size of the missing half:
        //
        //   D_probe - the audio sidecar's t=0 is not the live edge from when the video
        //     started, it is the live edge from when the audio process had finished
        //     connecting and probing, i.e. `rawDelay` seconds later. Nothing to do with
        //     content latency; it is only connect + probe.
        //   L - the picture is the SAME stream after Chromium's playback buffers, so it
        //     shows content that was already `L` seconds old when we captured it.
        //
        // Aligning them: video position q shows content live at (startedAt + q) - L,
        // while audio position p is live at (startedAt + D_probe + p). They are equal
        // when p = q - (D_probe + L), i.e. at the very first frame the audio is ALREADY
        // D_probe + L seconds ahead - so it must be delayed by exactly that sum.
        // Applying D_probe alone (2.4 s) left an L-sized error; applying L alone left a
        // D_probe-sized one; the sum is what the geometry actually says.
        //
        // L is measured from the guest player's buffer when Chromium exposes one, and
        // otherwise assumed to be SCREEN_DEFAULT_PLAYER_LAG. The dock also carries a
        // manual correction. All three parts are journalled, so any remaining error can
        // be read straight off the numbers.
        const measuredLag = Number.isFinite(job.avOffsetSec) ? job.avOffsetSec : null;
        const playerLag = measuredLag === null ? SCREEN_DEFAULT_PLAYER_LAG : measuredLag;
        const userShift = Number.isFinite(job.avUserShift) ? job.avUserShift : 0;
        const offset = Math.max(0, Math.min(60, rawDelay + playerLag + userShift));
        journal(
          `mux offset ${offset.toFixed(2)}s = probe ${rawDelay.toFixed(2)}`
          + ` + player ${playerLag.toFixed(2)}${measuredLag === null ? ' (assumed)' : ''}`
          + ` + user ${userShift.toFixed(2)}`
        );
        journal(`mux offset ${offset.toFixed(2)}s audio=${audioSize}B video=${videoSize}B`);
        try {
          // -c copy over two finished files: seconds, not minutes.
          const mux = spawnSync(
            binaries.ffmpeg() || 'ffmpeg',
            screenMuxArgs(videoTmp, audioTmp, offset, muxTmp),
            { windowsHide: true, cwd: dir, encoding: 'utf8', timeout: 120000 }
          );
          if (mux.status === 0 && fileSize(muxTmp) > 0) {
            fs.renameSync(muxTmp, out);
            hasAudio = true;
            // The silent sidecar is now redundant. Leaving it behind is what made
            // one recording show up as two files — the silent .video.mp4 and the
            // muxed .mp4 with sound. Only reachable once the rename succeeded, so
            // the fallback path below still has the video.
            try {
              if (fs.existsSync(videoTmp)) fs.unlinkSync(videoTmp);
            } catch (_) {}
          } else {
            journal(`mux failed status=${mux.status} ${String(mux.stderr || '').slice(-300)}`);
          }
        } catch (e) {
          journal(`mux threw ${e && (e.message || e)}`);
        }
      } else if (job.audioChild) {
        journal(
          `no usable CDN audio (startedAt=${job.audioStartedAt} size=${audioSize}B ` +
            `err=${String(job.audioErrTail).slice(-200)}) — silent video`
        );
      }

      // Written whenever the browser capture was in play at all, so the log answers
      // "why is there no in-sync soundtrack?" without anyone having to guess.
      if (!guestUsable && (job.guestAudioStop || guestSize > 0)) {
        journal(`guest audio: unavailable (${guestReason}) — falling back to CDN audio`);
      }

      // Whatever happened above, the video must land under its real name.
      if (!hasAudio) {
        try {
          fs.renameSync(videoTmp, out);
        } catch (e) {
          journal(`rename failed ${e && (e.message || e)}`);
        }
      }
      // Every sidecar goes, whichever branch won. A leftover *.guest.webm next to
      // the recording is what makes one take look like two downloads.
      for (const tmp of [audioTmp, muxTmp, guestTmp]) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch (_) {}
      }

      const r = job.result();
      r.hasAudio = hasAudio;
      if (!job.stopping && !job.stopReason) job.stopReason = job.autoReason || null;
      job.onDone && job.onDone(r);
    };

/** Stops the audio process the same way stop() stops the video one. */
   const stopAudioProcess = () => {
     // Idempotent. stop() gets here first, and then the video's close handler
     // runs finishScreen() → stopAudioProcess() a second time; writing 'q' to the
     // already-ended stdin raised ERR_STREAM_WRITE_AFTER_END as an unhandled
     // 'error' event and popped the "A JavaScript error occurred" dialog.
     if (!job.audioChild || job.audioClosed || job.audioStopping) return;
     job.audioStopping = true;
     try {
       const sin = job.audioChild.stdin;
       if (sin && !sin.destroyed && !sin.writableEnded) {
// ffmpeg only treats stdin as an interactive key source in some builds/modes,
      // and with a network input it is plainly not always reading it — measured, the
      // process was still alive 10 s after `q` + end(). So the write is best-effort
      // and the SIGTERM below is what actually stops it; that is why the wait is
      // short. ADTS output survives the kill: it has no moov to finalise.
         try {
           sin.write('q\n');
         } catch (_) {}
         sin.end();
       }
     } catch (_) {}
     job.audioStopTimer = setTimeout(() => {
       try {
         job.audioChild.kill('SIGTERM');
       } catch (_) {}
     }, AUDIO_TERM_MS);
     if (job.audioStopTimer.unref) job.audioStopTimer.unref();
     job.audioKillTimer = setTimeout(() => {
       try {
         job.audioChild.kill('SIGKILL');
       } catch (_) {}
     }, AUDIO_TERM_MS + 3000);
     if (job.audioKillTimer.unref) job.audioKillTimer.unref();
   };

    // Exposed on the job so the module-level stop() can reach it.
    job.stopAudio = stopAudioProcess;

    /**
     * Audio side-process wiring. This block lived inside start() (stream mode) by
     * mistake, where `job.audioChild` is always null — so it never ran, and the
     * consequences in screen mode were exactly the two symptoms the user reported:
     *   - `audioStartedAt` stayed null forever, because nothing was listening to the
     *     audio process's -progress output, and finalize() then discarded a
     *     perfectly good 256 KB ADTS sidecar as "no usable audio";
     *   - `audioClosed` was never set either, so finishScreen() always took the
     *     "audio still running" branch and burned the full wait before muxing.
     */
    if (job.audioChild) {
      const ac = job.audioChild;
      let abuf = '';
      ac.stdout.on('data', (d) => {
        if (job.audioStartedAt !== null) return;
        abuf += d.toString();
        const lines = abuf.split(/\r?\n/);
        abuf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('out_time_ms=')) continue;
          const us = Number(line.slice(12));
          if (Number.isFinite(us) && us > 0) {
            job.audioStartedAt = Date.now();
            journal(
              `audio first sample after ${((job.audioStartedAt - job.startedAt) / 1000).toFixed(2)}s`
            );
          }
        }
      });
      ac.stderr.on('data', (d) => {
        job.audioErrTail = (job.audioErrTail + d.toString()).slice(-2000);
      });
// Single place that marks the audio side finished, so every path (exit,
   // crash, wait-timeout) cancels the pending escalation timers and stops the
   // growth poller. Nulling the handles without clearTimeout left live SIGTERM /
      // SIGKILL timers pointing at an already-dead process.
    const markAudioClosed = () => {
      if (job.audioClosed) return false;
   job.audioClosed = true;
    if (job.audioStopTimer) {
   clearTimeout(job.audioStopTimer);
      job.audioStopTimer = null;
 }
      if (job.audioKillTimer) {
        clearTimeout(job.audioKillTimer);
        job.audioKillTimer = null;
      }
      if (job.audioPollTimer) {
     clearInterval(job.audioPollTimer);
   job.audioPollTimer = null;
      }
    return true;
    };

      ac.on('error', (e) => {
      journal(`audio process error: ${e && (e.message || e)}`);
        if (!markAudioClosed()) return;
        finishScreen();
      });
    ac.on('close', (code) => {
      journal(`audio process close code=${code} size=${fileSize(audioTmp)}B`);
      if (!markAudioClosed()) return;
   finishScreen();
    });

      // Second, independent liveness signal. -progress can stay silent for a
      // whole recording while the sidecar is in fact filling up, so the file's own
      // growth is watched too; whichever fires first wins.
      job.audioPollTimer = setInterval(() => {
        if (job.audioStartedAt !== null || job.audioClosed) return;
        if (fileSize(audioTmp) > 4096) {
          job.audioStartedAt = Date.now();
          journal(
            `audio data seen (size probe) after ${((job.audioStartedAt - job.startedAt) / 1000).toFixed(2)}s`
          );
        }
      }, AUDIO_POLL_MS);
      if (job.audioPollTimer.unref) job.audioPollTimer.unref();
    }

 child.on('close', (code, signal) => {
      journal(
        `video close code=${code} signal=${signal} stopping=${job.stopping} ` +
          `frames=${job.frames} dropped=${job.dropped} file=${fileSize(videoTmp)}B ` +
          `stderr=${String(job.stderrTail).slice(-400)}`
      );
      if (job.settled) return;
      job.settled = true;
      job.screenStopped = true;
     if (job.screenTimer) {
        clearTimeout(job.screenTimer);
        job.screenTimer = null;
      }
      cleanup(job);
      running.delete(id);
      job.videoClosed = true;

      if (fileSize(videoTmp) <= 0) {
        stopAudioProcess();
        // Nothing will mux anything, so the browser capture is stopped and its
        // sidecar dropped here rather than left behind as an orphan next to the
        // (nonexistent) recording.
        if (job.guestAudioStop) {
          try {
            job.guestAudioStop();
          } catch (_) {}
          job.guestAudioFlushed = true;
        }
        try {
          if (fs.existsSync(guestTmp)) fs.unlinkSync(guestTmp);
        } catch (_) {}
        // Mark it finalised, or the audio process's own close handler will run
        // finishScreen() -> finalize() and report the SAME empty recording a
        // second time as a second toast.
        job.finalized = true;
        const tail = job.stderrTail;
        onError &&
          onError(
            job.stopping
              ? 'Остановлено до того, как страница отдала первый кадр.'
              : /No such file|Connection|404|403|HTTP error/i.test(tail)
                ? 'Не удалось записать экран: ffmpeg не принял кадры. Оставьте вкладку «Обзор» открытой и попробуйте снова.'
                : 'Запись пустая — страница не отдала ни одного кадра.'
          );
        return;
      }

      if (!job.stopping) {
        job.autoReason =
          code === 0
            ? 'ffmpeg завершился сам.'
            : `ffmpeg прерван (код ${code}${signal ? `, ${signal}` : ''}) — запись сохранена частично.`;
      }
      finishScreen();
    });

return {
      id,
      path: out,
      startedAt: job.startedAt,
      audioUrl: job.audioChild ? audioUrl : null,
      // Where main must put the audio it takes from the browser, and the stamp it
      // must pair that file's own start mark with. Both are returned rather than
      // recomputed so the two halves cannot drift apart on the filename.
      guestAudioPath: guestTmp,
      videoStartedAt: job.startedAt,
    };
 }

/**
 * Hands a screen job the stopper for the audio main is recording off the BROWSER,
 * together with the two wall clocks that make the tracks comparable.
 *
 * `info.stop` is called from stop() and from the video-close handler, so finalize()
 * may not read, rename or delete the sidecar while main is still appending to it.
 * `info.startedAt` is the capture's own start stamp (taken in the capture page at
 * the instant MediaRecorder began) and `info.videoStartedAt` is this job's; their
 * difference is the only shift the mux applies (see screenGuestMuxArgs).
 *
 * Called once, after the capture actually started — not before, because a job that
 * never opened a file handle must not make stop() wait for one. `flushed` starts
 * true and is cleared here, which is what makes finalize() wait exactly once: the
 * first pass asks for the flush, the stopper flips the flag, finishScreen proceeds.
 */
function attachGuestAudio(id, info) {
  const job = running.get(id);
  const stopFn = info && info.stop;
  if (!job || job.mode !== 'screen' || typeof stopFn !== 'function') return false;
  job.guestAudioStop = stopFn;
  job.guestAudioFlushed = false;
  const at = Number(info.startedAt);
  if (Number.isFinite(at) && at > 0) job.guestAudioStartAt = at;
  const videoAt = Number(info.videoStartedAt);
  job.guestAudioVideoAt = Number.isFinite(videoAt) && videoAt > 0 ? videoAt : job.startedAt;
  return true;
}

/**
 * Appends a line to a running job's diagnostics — the same text that reaches
 * <downloadDir>/live/_screen.log and the `note` the dock shows on the recording
 * chip. Used for events that happen outside this module, such as "the browser's
 * audio capture could not be started".
 */
function jobNote(id, text) {
  const job = running.get(id);
  if (!job || !text) return false;
  const line = String(text);
  if (typeof job.journal === 'function') {
    try {
      job.journal(line);
      return true;
    } catch (_) {}
  }
  const prev = job.diag ? job.diag.split('\u001f') : [];
  prev.push(line);
  job.diag = prev.slice(-2).join(' \u2014 ');
  return true;
}

function cleanup(job) {
  if (job.stallTimer) clearInterval(job.stallTimer);
  if (job.screenTimer) clearTimeout(job.screenTimer);
  if (job.firstFrameTimer) clearTimeout(job.firstFrameTimer);
  if (job.audioWaitTimer) clearTimeout(job.audioWaitTimer);
  if (job.guestAudioWaitTimer) clearTimeout(job.guestAudioWaitTimer);
  if (job.audioPollTimer) clearInterval(job.audioPollTimer);
  if (job.audioStopTimer) clearTimeout(job.audioStopTimer);
  if (job.audioKillTimer) clearTimeout(job.audioKillTimer);
  if (job.hardTimer) clearTimeout(job.hardTimer);
  if (job.killTimer) clearTimeout(job.killTimer);
  if (job.reapTimer) clearTimeout(job.reapTimer);
  // The compositor subscription outlives ffmpeg unless it is explicitly ended —
  // it belongs to the guest, not to this recording, and a leaked one keeps
  // pushing frames at a NativeImage nobody consumes.
  if (job.stopFrameSubscription) {
    try {
      job.stopFrameSubscription();
    } catch {}
  }
  try {
    job.child.stdout.destroy();
    job.child.stderr.destroy();
  } catch {}
  if (job.audioChild) {
    try {
      job.audioChild.stdout.destroy();
      job.audioChild.stderr.destroy();
    } catch {}
  }
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
    // The audio side process has no business outliving the video one.
    if (job.stopAudio) job.stopAudio();
    // Nor does the browser capture: its file handle lives in main, and leaving the
    // stream running would keep the app from ever exiting cleanly.
    if (job.guestAudioStop) {
      try {
        job.guestAudioStop();
      } catch (_) {}
    }
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
if (job.stopAudio) job.stopAudio();
    if (job.guestAudioStop) {
      try {
        job.guestAudioStop();
      } catch (_) {}
    }
    // Screen mode writes to a sidecar first (see finishScreen). The absolute
    // backstop cannot wait for that machinery, but it must still publish the
    // video under its real name or the file looks like it vanished.
    if (job.mode === 'screen' && job.videoTmp) {
      try {
        if (fs.existsSync(job.videoTmp) && fileSize(job.videoTmp) > 0 && !fs.existsSync(job.out)) {
          fs.renameSync(job.videoTmp, job.out);
        }
      } catch (_) {}
      // The audio and mux sidecars have no consumer on this path — the backstop
      // publishes the video as-is — so leaving them behind would litter the
      // downloads folder with *.audio.aac / *.mux.mp4 after every hard stop.
      for (const tmp of [job.audioTmp, job.muxTmp, job.guestTmp]) {
        try {
          if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch (_) {}
      }
    }
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

module.exports = {
  parseTarget,
  parseStreams,
  resolve,
  start,
  startScreen,
  screenFfmpegArgs,
  screenAudioArgs,
  screenMuxArgs,
  screenGuestMuxArgs,
  attachGuestAudio,
  jobNote,
  stop,
  stopAll,
  list,
  status,
};