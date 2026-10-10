'use strict';

// Optional request-signing layer.
//
// Background: TikTok tightened the mobile API in May 2025 (yt-dlp#13134, still
// open). Before that, `/aweme/v1/multi/aweme/detail/` answered a request with an
// empty `X-Argus` header — which is exactly what yt-dlp and this app still send.
// Now the same endpoint can come back with a zero-length body, and the
// community workaround in that thread is the full mobile signature set:
//     x-ss-req-ticket, x-argus, x-gorgon, x-ladon, x-khronos
//
// Nothing here is required for the app to work. With signing off we behave
// exactly like before, so the hard rule is: a signing failure must never turn
// into a hard error — it degrades to an unsigned request and records why.
//
// Two providers:
//   'gnarly'    — vendored pure-JS X-Gnarly (justscrapeme/tiktok-web-reverse-
//                 engineering, MIT). Zero dependencies, only node:crypto.
//                 NOTE: X-Gnarly is a *web* signature (aid=1988 / tiktok_web).
//                 The mobile endpoint wants the X-Gorgon/X-Ladon family, so this
//                 provider is a partial match, not a full fix.
//   'mobile'    — optional Python sidecar that produces the mobile set. Runs as
//                 a short-lived child process; if Python or the module is absent
//                 it simply reports unavailable and we continue unsigned.
//
// Device registration is deliberately NOT here: yt-dlp never calls
// /service/2/device_register/ (zero occurrences in its tiktok.py) and simply
// generates random device_id/iid/openudid/cdid locally, which is the same thing
// ttapi.ensureIdentity() does.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

// The vendored encoder lives under vendor/, which electron-builder ships via
// extraResources — i.e. <resources>/vendor/x-gnarly — while in dev it sits at
// <repo>/vendor/x-gnarly. A single hardcoded path therefore resolves to
// app.asar/vendor/x-gnarly (which does not exist) in a packaged build, so
// resolve against every plausible root and use the first file that is there.
// This mirrors binaries.js, which already searches a list of roots.
let resourcesRoot = null; // set by main.js via setResourcesRoot()

function setResourcesRoot(p) {
  resourcesRoot = p;
}

function vendorDirs() {
  const roots = [];
  if (resourcesRoot) roots.push(resourcesRoot);
  roots.push(path.join(__dirname, '..', '..')); // dev: <repo>/src/main -> <repo>
  return roots.map((r) => path.join(r, 'vendor', 'x-gnarly'));
}

/** First existing encode.js across the candidate roots, or null. */
function resolveVendored(name) {
  for (const dir of vendorDirs()) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function vendorDir() {
  return path.dirname(resolveVendored('encode.js') || vendorDirs()[0]);
}

let gnarlyEncode = null;
let gnarlyMeta = { loaded: false, version: null, error: null };

function loadGnarly() {
  if (gnarlyMeta.loaded || gnarlyMeta.error) return gnarlyEncode;
  try {
    const file = resolveVendored('encode.js');
    if (!file) throw new Error('vendor/x-gnarly/encode.js не найден');
    const mod = require(file);
    if (typeof mod.encode !== 'function') throw new Error('encode is not a function');
    gnarlyEncode = mod.encode;
    gnarlyMeta.loaded = true;
    // encode() stamps the webmssdk version it was written against into field 9.
    // We report the vendored build rather than pretending to be newer.
    gnarlyMeta.version = '5.1.0';
  } catch (e) {
    gnarlyMeta.error = e.message;
    gnarlyEncode = null;
  }
  return gnarlyEncode;
}

/** Small helper: is a string a plausible X-Gnarly blob? */
function looksLikeGnarly(v) {
  return typeof v === 'string' && v.length > 64 && /^[A-Za-z0-9+/=_-]+$/.test(v);
}

// ---------- provider: gnarly (in-process, JS) ----------

function signWithGnarly({ queryString, body, userAgent }) {
  const encode = loadGnarly();
  if (!encode) return null;
  try {
    const out = encode({ queryString, body, userAgent });
    return looksLikeGnarly(out) ? out : null;
  } catch {
    return null;
  }
}

// ---------- provider: mobile (optional Python sidecar) ----------

const MOBILE_HEADER_KEYS = [
  'x-argus',
  'x-gorgon',
  'x-ladon',
  'x-khronos',
  'x-ss-stub',
  'x-ss-req-ticket',
];

function pythonCommand() {
  for (const c of (process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'])) {
    try {
      const r = require('node:child_process').spawnSync(c, ['-c', 'import sys;print(1)'], {
        timeout: 5000,
        windowsHide: true,
      });
      if (r.status === 0) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Runs the sidecar once per process and caches the verdict: spawning Python per
 * request would dominate the latency of a small metadata call.
 */
let mobileProbe = null;

function probeMobile(signerPath) {
  const key = String(signerPath || '');
  if (mobileProbe && mobileProbe.key === key) return mobileProbe;
  const py = pythonCommand();
  if (!py) {
    mobileProbe = { key, ok: false, reason: 'Python не найден в системе' };
    return mobileProbe;
  }
  mobileProbe = { key, ok: true, python: py, reason: null };
  return mobileProbe;
}

/**
 * The sidecar contract is deliberately tiny: it reads one JSON object from argv
 * and prints one JSON object. That keeps us independent of whichever third-party
 * package the user installs — ship our own runner, or point at your own script.
 */
function signWithMobile({ url, method, body, cookie, ts }, s) {
  const p = probeMobile(s && s.signerPath);
  if (!p.ok) return { error: p.reason };

  return new Promise((resolve) => {
    const script = (s && s.signerPath) || '';
    let child;
    try {
      child = spawn(p.python, ['-u', '-c', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ error: `Не удалось запустить подписант: ${e.message}` });
      return;
    }

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ error: 'Подписант не ответил за 8 с' });
    }, 8000);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: `Подписант недоступен: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ error: `Подписант завершился с кодом ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}` });
        return;
      }
      try {
        const line = out.trim().split('\n').filter(Boolean).pop();
        const parsed = JSON.parse(line);
        const headers = parsed.headers || parsed;
        const picked = {};
        for (const [k, v] of Object.entries(headers)) {
          if (MOBILE_HEADER_KEYS.includes(String(k).toLowerCase()) && v) picked[k] = String(v);
        }
        resolve(Object.keys(picked).length ? { headers: picked } : { error: 'Подписант не вернул ни одной подписи' });
      } catch (e) {
        resolve({ error: `Не удалось разобрать ответ подписанта: ${e.message}` });
      }
    });

    try {
      child.stdin.end(JSON.stringify({ url, method, body: body || '', cookie: cookie || '', ts: ts || Date.now() }));
    } catch (e) {
      clearTimeout(timer);
      resolve({ error: `Не удалось передать данные подписанту: ${e.message}` });
    }
  });
}

// ---------- public API ----------

/**
 * Adds signatures to `headers` if possible. Never throws.
 *
 * @param {object} ctx  { url, queryString, body, userAgent, method, cookie }
 * @param {object} s    settings
 * @returns {Promise<{added: object, note: string|null}>}
 */
async function applySignatures(ctx, s = {}) {
  const cfg = s.signer || {};
  const out = { added: {}, note: null };

  if (!cfg.enabled) {
    out.note = 'подпись выключена';
    return out;
  }

  if (cfg.provider === 'mobile') {
    const r = await signWithMobile(ctx, s);
    if (r.headers) {
      Object.assign(out.added, r.headers);
    } else {
      out.note = r.error || 'подписант недоступен';
    }
    return out;
  }

  // gnarly (default)
  const g = signWithGnarly({
    queryString: ctx.queryString || '',
    body: ctx.body || '',
    userAgent: ctx.userAgent || '',
  });
  if (g) {
    out.added['X-Gnarly'] = g;
  } else {
    out.note = gnarlyMeta.error || 'X-Gnarly не вычислен';
  }
  return out;
}

/** Health for the diagnostics window and the settings page. */
function status(s = {}) {
  const cfg = s.signer || {};
  const probe = cfg.provider === 'mobile' ? probeMobile(cfg.signerPath) : null;
  return {
    enabled: !!cfg.enabled,
    provider: cfg.provider || 'gnarly',
    signerPath: cfg.signerPath || '',
    gnarly: {
      ...gnarlyMeta,
      path: resolveVendored('encode.js') || path.join(vendorDir(), 'encode.js'),
      present: !!resolveVendored('encode.js'),
    },
    mobile: probe
      ? { ok: probe.ok, python: probe.python || null, reason: probe.reason }
      : { ok: false, python: null, reason: 'не проверялось — провайдер не выбран' },
    note:
      'X-Gnarly — веб-подпись (aid=1988). Мобильный эндпоинт требует семейство ' +
      'X-Gorgon/X-Ladon/X-Argus/X-Khronos, это провайдер «mobile» (Python sidecar).',
  };
}

/**
 * Round-trip self-check: encode a signature and decode it back, comparing the
 * three MD5 fields. This proves the vendored code is intact and not truncated by
 * the packager, without needing TikTok to be reachable.
 */
function selfTest() {
  const encode = loadGnarly();
  if (!encode) throw new Error(gnarlyMeta.error || 'encode.js не загрузился');
  const queryString = 'aid=1988&region=BY&device_id=123&app_name=tiktok_web';
  const body = 'aweme_ids=[7123456789012345678]';
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
  const gnarly = encode({ queryString, body, userAgent });
  if (!looksLikeGnarly(gnarly)) throw new Error('X-Gnarly имеет неверный формат');

  let decoded = null;
  try {
    const decodeFile = resolveVendored('decode.js');
    if (!decodeFile) throw new Error('vendor/x-gnarly/decode.js не найден');
    const { decode } = require(decodeFile);
    decoded = decode(gnarly);
  } catch (e) {
    throw new Error(`decode.js не отработал: ${e.message}`);
  }
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const checks = {
    queryHash: decoded[3] === md5(queryString),
    bodyHash: decoded[4] === md5(body),
    uaHash: decoded[5] === md5(userAgent),
    version: String(decoded[9] || ''),
  };
  if (!checks.queryHash || !checks.bodyHash || !checks.uaHash) {
    throw new Error(`X-Gnarly round-trip не сошёлся: ${JSON.stringify(checks)}`);
  }
  return { length: gnarly.length, ...checks };
}

module.exports = {
  applySignatures,
  status,
  selfTest,
  loadGnarly,
  looksLikeGnarly,
  setResourcesRoot,
  vendorDir,
  resolveVendored,
};