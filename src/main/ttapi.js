'use strict';

// Direct TikTok mobile-API client.
//
// Why this exists: yt-dlp answers the mobile API with a hardcoded device —
// current_region=US, sys_region=US, residence=US, carrier_region=US,
// op_region=US, timezone_name=America/New_York — and exposes no way to change
// it through --extractor-args (only api_hostname / app_info / device_id are
// configurable). A Russian egress therefore keeps being served the trimmed
// feed, whatever the browser says.
//
// This module speaks the same protocol with the region, operator, timezone and
// device identity we choose. It is the network-layer equivalent of the
// TelephonyManager hooks in UnleashedTikTok's RegionBypass.java.
//
// No reverse engineering is involved: yt-dlp proves the API accepts an empty
// X-Argus header, so no X-Gorgon/X-Dynosaur signing is required.
//
// Transport is Electron's Chromium network stack (net.fetch + session), so the
// user-configured HTTP/HTTPS/SOCKS5 proxy and the cookie jar are shared with the
// embedded browser instead of being reimplemented.

const crypto = require('node:crypto');
const { session } = require('electron');
const regions = require('./regions');
const signer = require('./signer');

const randHex = (chars) => crypto.randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);

// TikTok started returning zero-length bodies from the mobile API in May 2025
// (yt-dlp#13134). It is the signature of a rejected request rather than of a
// missing video, so it needs its own message instead of a confusing parse error.
//
// Measured on 2026-10-08: yt-dlp does NOT use this endpoint at all — it downloads
// the www.tiktok.com HTML page and parses __UNIVERSAL_DATA_FOR_REHYDRATION__ from
// it, over a curl_cffi connection impersonating chrome-146. So a green yt-dlp
// download says nothing about the mobile API being reachable. Do not blame the
// signature alone here: the honest list of causes is a server-side signature
// check, an IP/region block, or a rejection of this TLS fingerprint.
const EMPTY_BODY_HINT =
  'TikTok вернул пустой ответ на запрос к мобильному API (yt-dlp#13134). Причины, ' +
  'по убыванию вероятности: (1) серверная проверка подписей — тогда включите подпись в ' +
  'Настройках → Движок; (2) блокировка по IP — тогда нужен прокси целевой страны; ' +
  '(3) отвержение TLS-отпечатка клиента. ВАЖНО: yt-dlp успешно скачивает это же ' +
  'видео, потому что идёт другим маршрутом — через HTML-страницу tiktok.com с ' +
  ' impersonation браузера, а не через /aweme/v1/. Режим «Движок: авто» уже ' +
  'переключается на этот рабочий путь.';

// ---------- device identity ----------

/**
 * A stable "phone" is important: TikTok throttles or returns empty lists when
 * the same device_id is recycled across wildly different clients, and yt-dlp
 * itself retries with a fresh device_id when the API repeats pages.
 * The identity is persisted by the caller (settings) so restarts reuse it.
 */
function ensureIdentity(stored) {
  const id = (stored && typeof stored === 'object') ? stored : {};
  return {
    device_id: id.device_id || String(7250000000000000000n + BigInt(crypto.randomBytes(6).readUIntBE(0, 6)) % 7550998999999994577n),
    iid: id.iid || String(7000000000000000000n + BigInt(crypto.randomBytes(6).readUIntBE(0, 6)) % 7599999999999999999n),
    cdid: id.cdid || crypto.randomUUID(),
    openudid: id.openudid || randHex(16),
  };
}

function appUserAgent(profile) {
  const pkg =
    profile.app_name === 'musical_ly'
      ? `com.zhiliaoapp.musically/${profile.manifest_app_version}`
      : `com.ss.android.ugc.${profile.app_name}/${profile.manifest_app_version}`;
  return `${pkg} (Linux; U; Android 13; ${profile.language}_${profile.region}; Pixel 7; Build/TD1A.220804.031; Cronet/58.0.2991.0)`;
}

// ---------- request building ----------

/**
 * Base query for every mobile-API call. Mirrors yt-dlp's _build_api_query, but
 * with region/carrier/timezone taken from the chosen profile instead of 'US'.
 */
function buildQuery(profile, ident, s, extra = {}) {
  const now = Date.now();
  const versionCode = profile.app_version
    .split('.')
    .map((v) => String(parseInt(v, 10)).padStart(2, '0'))
    .join('');
  const q = {
    // device
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    _rticket: String(now),
    cdid: ident.cdid,
    channel: 'googleplay',
    aid: profile.aid,
    app_name: profile.app_name,
    version_code: versionCode,
    version_name: profile.app_version,
    manifest_version_code: profile.manifest_app_version,
    update_version_code: profile.manifest_app_version,
    ab_version: profile.app_version,
    build_number: profile.app_version,
    resolution: '1080*2400',
    dpi: 420,
    device_type: 'Pixel 7',
    device_brand: 'Google',
    device_model: 'Pixel 7',
    os_api: '29',
    os_version: '13',
    host_abi: 'armeabi-v7a',
    ac: 'wifi',
    ac2: 'wifi5g',
    is_pad: '0',
    uoo: '1',
    // ---- the region story: these three are what the SIM hooks would provide ----
    region: profile.region,
    current_region: profile.region,
    sys_region: profile.region,
    residence: profile.region,
    carrier_region: profile.region,
    op_region: profile.region,
    // operator identity (MCC+MNC of the spoofed SIM)
    mcc_mnc: profile.carrierMccmnc || '',
    // locale / timezone must agree with the region or the mix is obvious
    timezone_name: profile.timezone,
    timezone_offset: String(profile.timezoneOffset),
    language: profile.language,
    locale: profile.language,
    app_language: profile.language,
    // identity
    device_id: ident.device_id,
    iid: ident.iid,
    openudid: ident.openudid,
    last_install_time: String(Math.floor(now / 1000) - Math.floor(Math.random() * 3) * 86400),
    ts: String(Math.floor(now / 1000)),
    ...extra,
  };
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function apiHost(s) {
  const h = String(s.apiHostname || '').trim();
  if (!h) return regions.API_HOSTS[0];
  return h.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function context(s) {
  const profile = regions.getProfile(s.regionProfile || s.region || 'US', {
    carrierIndex: Number(s.carrierIndex) || 0,
    timezone: s.timezone || undefined,
    language: s.navigatorLanguage ? String(s.navigatorLanguage).split('-')[0] : undefined,
  });
  const ident = ensureIdentity(s.emulator);
  return { profile, ident };
}

// ---------- transport ----------

/**
 * Chromium's stack honours session.setProxy(), so HTTP/HTTPS/SOCKS5 all work
 * without any tunnelling code, and cookies persist across calls.
 */
async function apiRequest(endpoint, { profile, ident, s, query = {}, body = null, timeout = 20000 }) {
  const host = apiHost(s);
  const url = new URL(`https://${host}/aweme/v1/${endpoint}/`);
  for (const [k, v] of Object.entries(buildQuery(profile, ident, s, query))) {
    url.searchParams.set(k, String(v));
  }

  // odin_tt is what yt-dlp also sets before every call; sid_tt, when the user
  // imported cookies, is copied over from the web host.
  await seedCookies(host, s);

  const ua = appUserAgent(profile);
  const bodyString = body ? new URLSearchParams(body).toString() : '';
  const headers = {
    'User-Agent': ua,
    Accept: 'application/json',
    'Accept-Language': `${profile.language}-${profile.region},${profile.language};q=0.9`,
    // yt-dlp sends an empty X-Argus; the mobile API accepts it unsigned.
    'X-Argus': '',
    'X-SS-REQ-TICKET': String(Date.now()),
  };

  // Optional: only runs when the user turned signing on. A failure here is
  // reported but must never abort the request — we still try unsigned.
  let signNote = null;
  try {
    const signed = await signer.applySignatures(
      {
        url: url.toString(),
        queryString: url.search.replace(/^\?/, ''),
        body: bodyString,
        userAgent: ua,
        method: bodyString ? 'POST' : 'GET',
        cookie: s.ttwid ? `ttwid=${s.ttwid}` : '',
      },
      s
    );
    Object.assign(headers, signed.added);
    signNote = signed.note;
  } catch (e) {
    signNote = `подпись не применена: ${e.message}`;
  }

  const init = { method: body ? 'POST' : 'GET', headers, session: session.defaultSession };
  if (bodyString) {
    init.body = bodyString;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  init.signal = AbortSignal.timeout(timeout);

  let res;
  try {
    res = await fetch(url.toString(), init);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`TikTok API не ответил за ${Math.round(timeout / 1000)} с. Проверьте прокси и доступность сети.`);
    }
    throw new Error(`Сеть недоступна: ${e.message}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(await explainStatus(res.status, text, s));

  // A zero-length body means the request was rejected before any payload was
  // produced. Since yt-dlp#13134 that is the usual symptom of a missing
  // signature — report it as such instead of "unexpected token < in JSON".
  if (!text.trim()) {
    const err = new Error(EMPTY_BODY_HINT);
    err.code = 'empty-body';
    err.signNote = signNote;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error('TikTok вернул не-JSON ответ (возможно, WAF-заглушка). Смените прокси.');
    err.code = 'bad-json';
    err.signNote = signNote;
    throw err;
  }
  if (json.status_code && json.status_code !== 0) {
    const err = new Error(apiStatusError(json, profile));
    err.code = 'status-code';
    err.signNote = signNote;
    throw err;
  }
  if (signNote) {
    Object.defineProperty(json, '__signNote', { value: signNote, enumerable: false });
  }
  return json;
}

async function seedCookies(host, s) {
  const cookies = session.defaultSession.cookies;
  try {
    await cookies.set({
      url: `https://${host}/`,
      name: 'odin_tt',
      value: randHex(160),
      expirationDate: Math.floor(Date.now() / 1000) + 86400,
    });
    if (s.ttwid) {
      await cookies.set({
        url: `https://${host}/`,
        name: 'ttwid',
        value: String(s.ttwid),
        expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30,
      });
    }
    if (s.msToken) {
      await cookies.set({
        url: `https://${host}/`,
        name: 'msToken',
        value: String(s.msToken),
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
      });
    }
    // Region hint that the web client stores; harmless and sometimes required.
    if (s.regionProfile || s.region) {
      await cookies.set({
        url: `https://www.tiktok.com/`,
        name: 'store-country-code',
        value: String(s.regionProfile || s.region).toLowerCase(),
        expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30,
      });
    }
  } catch {
    // cookie writes are best-effort
  }
}

async function explainStatus(status, body, s) {
  const t = String(body || '').slice(0, 400);
  if (status === 403) return `Доступ запрещён (403). IP заблокирован — нужен прокси в стране без ограничений.${t ? ` [${t}]` : ''}`;
  if (status === 429) return 'TikTok ограничил частоту запросов (429). Сделайте паузу или смените прокси.';
  if (status === 404) return 'Эндпоинт TikTok API не найден — возможно, он изменился. Обновите приложение.';
  return `TikTok API вернул HTTP ${status}.${t ? ` ${t}` : ''}`;
}

function apiStatusError(json, profile) {
  const code = json.status_code;
  if (code === 2154 || code === 8) {
    return `TikTok требует проверку аккаунта для региона ${profile.region} (status_code ${code}). Импортируйте cookies браузера.`;
  }
  if (code === 102) return `Аккаунт заблокирован в регионе ${profile.region} (status_code ${code}).`;
  if (code === 2153) return `Проверка региона не пройдена (status_code ${code}). Попробуйте другой регион или прокси.`;
  return `TikTok API отклонил запрос: status_code ${code}${
    json.status_msg ? `, ${String(json.status_msg).slice(0, 120)}` : ''
  }`;
}

// ---------- endpoints ----------

/** POST /aweme/v1/multi/aweme/detail/ — the same call yt-dlp makes. */
async function awemeDetail(videoId, s) {
  const { profile, ident } = context(s);
  const json = await apiRequest('multi/aweme/detail', {
    profile,
    ident,
    s,
    body: { aweme_ids: `[${videoId}]`, request_source: '0' },
  });
  const detail = json.aweme_details && json.aweme_details[0];
  if (!detail) throw new Error('TikTok не вернул данные по видео — возможно, оно недоступно из текущего региона.');
  return detail;
}

function firstUrl(addr) {
  if (!addr) return null;
  const list = Array.isArray(addr.url_list) ? addr.url_list : addr.url_list ? [addr.url_list] : [];
  // Prefer https, then the widest-looking CDN host.
  return list.find((u) => String(u).startsWith('https://')) || list[0] || null;
}

/** Collects playable, watermark-free sources out of an aweme object. */
function extractFormats(detail) {
  const v = detail.video || {};
  const out = [];
  const push = (addr, meta) => {
    const url = firstUrl(addr);
    if (!url) return;
    out.push({
      formatId: meta.formatId,
      ext: 'mp4',
      note: meta.note,
      width: addr.width || meta.width || null,
      height: addr.height || meta.height || null,
      vcodec: meta.vcodec || 'h264',
      acodec: 'aac',
      filesize: addr.data_size || null,
      watermarked: meta.watermarked,
      url,
    });
  };

  push(v.play_addr, { formatId: 'play_addr', note: 'Прямое видео, без водяного знака', vcodec: v.is_h265 ? 'h265' : 'h264', width: v.width, height: v.height });
  push(v.play_addr_h264, { formatId: 'play_addr_h264', note: 'Прямое видео h264', vcodec: 'h264', width: v.width, height: v.height });
  push(v.download_addr, {
    formatId: 'download_addr',
    note: v.has_watermark ? 'Загрузка, с водяным знаком' : 'Загрузка',
    vcodec: 'h264',
    watermarked: !!v.has_watermark,
  });
  for (const br of v.bit_rate || []) {
    push(br.play_addr, {
      formatId: br.gear_name || 'bitrate',
      note: `Поток ${br.bit_rate ? Math.round(br.bit_rate / 1000) + ' kbps' : ''}`.trim(),
      vcodec: br.is_h265 ? 'h265' : 'h264',
      height: br.play_addr?.height,
    });
  }

  // Deduplicate by URL, keeping the best note for each.
  const seen = new Set();
  return out.filter((f) => {
    if (seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });
}

function extractImages(detail) {
  const imgs = detail.images || detail.image_post?.images;
  if (!Array.isArray(imgs)) return [];
  return imgs
    .map((img, i) => {
      const url = firstUrl(img) || firstUrl({ url_list: img.url_list });
      return url ? { index: i + 1, url } : null;
    })
    .filter(Boolean);
}

/** Same shape as ytdlp.normalizeInfo, so the renderer needs no changes. */
function normalizeAweme(detail, s) {
  const author = detail.author || {};
  const v = detail.video || {};
  const stats = detail.statistics || {};
  const music = detail.music || {};
  const images = extractImages(detail);
  const formats = extractFormats(detail);
  const id = String(detail.aweme_id || '');
  const username = author.unique_id || author.uniqueId || '';

  return {
    id,
    url: username ? `https://www.tiktok.com/@${username}/video/${id}` : `https://www.tiktok.com/@_/video/${id}`,
    title: detail.desc || music.title || 'TikTok',
    description: detail.desc || '',
    uploader: author.nickname || username,
    uploaderUrl: username ? `https://www.tiktok.com/@${username}` : '',
    duration: v.duration ? Math.round(v.duration / 1000) : 0,
    thumbnail: firstUrl(v.cover || v.dynamic_cover || v.origin_cover),
    viewCount: stats.play_count ?? null,
    likeCount: stats.digg_count ?? null,
    commentCount: stats.comment_count ?? null,
    shareCount: stats.share_count ?? null,
    uploadDate: detail.create_time ? new Date(detail.create_time * 1000).toISOString().slice(0, 10) : null,
    width: v.width || null,
    height: v.height || null,
    ext: 'mp4',
    filesize: v.play_addr?.data_size || null,
    extractor: 'tiktok-api',
    formats,
    images,
    isPhoto: images.length > 0,
    musicTitle: music.title || null,
    engine: 'api',
  };
}

/** Resolves a short URL or @username to the internal sec_uid needed for lists. */
async function resolveUser(input, s) {
  const { profile, ident } = context(s);
  const handle = String(input || '').trim().replace(/^@/, '');
  let uniqueId = handle;
  if (!/^[\w.-]+$/.test(handle)) {
    // not a plain handle: expand a short link by following it through the stack
    const short = await followRedirect(input, s);
    const m = short.match(/@([\w.-]+)/);
    if (!m) throw new Error('Не удалось определить автора по ссылке.');
    uniqueId = m[1];
  }
  const json = await apiRequest('user', {
    profile,
    ident,
    s,
    query: { unique_id: uniqueId },
    timeout: 20000,
  });
  const user = json.user_info;
  if (!user) throw new Error(`Автор @${uniqueId} не найден через мобильный API.`);
  return {
    uniqueId: user.unique_id || user.uniqueId || uniqueId,
    nickname: user.nickname || uniqueId,
    secUid: user.sec_uid || user.secUid,
    avatar: firstUrl({ url_list: user.avatar_larger?.url_list }),
    signature: user.signature || '',
    region: profile.region,
  };
}

async function followRedirect(url, s) {
  const init = { method: 'GET', session: session.defaultSession, signal: AbortSignal.timeout(15000) };
  if (s.proxy) init.headers = {};
  const res = await fetch(url, init);
  // Chromium exposes the final URL of a followed redirect chain.
  return res.url || url;
}

/** POST /aweme/v1/aweme/post/ — the author's video list. */
async function userPosts(secUid, { cursor = 0, count = 30 } = {}, s) {
  const { profile, ident } = context(s);
  const json = await apiRequest('aweme/post', {
    profile,
    ident,
    s,
    query: {
      sec_user_id: secUid,
      count: String(count),
      max_cursor: String(cursor),
      publish_video_strategy_type: '2',
      loc: 'query',
      verifyFp: 'verify_' + randHex(7),
    },
    timeout: 25000,
  });
  const items = Array.isArray(json.aweme_list) ? json.aweme_list : [];
  return {
    items: items.map((d) => normalizeAweme(d, s)),
    hasMore: json.has_more === 1,
    nextCursor: json.max_cursor,
    total: json.aweme_count ?? null,
  };
}

// ---------- public API ----------

async function probe(urlOrId, s) {
  const id = String(urlOrId || '').match(/(\d{6,})/)?.[1];
  if (!id) throw new Error('Не удалось извлечь ID видео из ссылки.');
  return normalizeAweme(await awemeDetail(id, s), s);
}

async function probeBatch(urls, s, { concurrency = 3, onEach } = {}) {
  const queue = [...new Set(urls.filter(Boolean))];
  const results = [];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const n = await probe(url, s);
        results.push(n);
        onEach?.(n);
      } catch (e) {
        const item = { url, id: (typeof url === 'string' ? url.match(/(\d{6,})/)?.[1] : null) || null, error: e.message };
        results.push(item);
        onEach?.(item);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetches a media URL (photo/cover) to disk through the proxied stack. */
async function fetchMedia(url, destPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const res = await fetch(url, { session: session.defaultSession, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Не удалось загрузить файл: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { path: destPath, size: buf.length };
}

module.exports = {
  probe,
  probeBatch,
  resolveUser,
  userPosts,
  fetchMedia,
  normalizeAweme,
  ensureIdentity,
  buildQuery,
  context,
  appUserAgent,
};