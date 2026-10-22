'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  downloadDir: null, // resolved to ~/Downloads at first run
  binDir: '',
  proxy: '', // http://user:pass@host:port | socks5://host:port
  cookiesFromBrowser: 'none', // none | chrome | firefox | edge | brave | opera
  cookieFile: '',
  // Which engine resolves metadata. 'api' uses the region-aware TikTok mobile
  // API, 'ytdlp' uses yt-dlp, 'auto' tries the API first and falls back.
  engine: 'auto', // auto | api | ytdlp
  region: 'BY', // two-letter country code sent as region/current_region/sys_region
  regionProfile: 'BY', // named profile (also fills carrier/timezone/language)
  carrierIndex: 0, // which operator of that country to present
  emulator: {}, // persistent emulated device: device_id, iid, cdid, openudid
  ttwid: '', // optional: browser-exported ttwid cookie
  msToken: '', // optional: browser-exported msToken cookie
  apiHostname: '', // e.g. api16-normal-c-useast1a.tiktokv.com for mobile API
  // Region-bypass model (see src/main/geobypass.js). 'roaming' reproduces the
  // state the Android mod creates: a foreign SIM in a phone that sits in
  // another country, so carrier_region and sys_region legitimately disagree.
  bypass: {
    mode: 'roaming', // off | strict | roaming
    localRegion: '', // physical country; measured from the IP when empty
    cdnRegion: '', // last region the CDN reported (x-tt-app-cdn-region)
    adoptCdnRegion: false, // replace the claim with the CDN's own answer
    sources: {}, // per-source overrides: { sim, network, system, account }
    regionHeaders: {}, // captured region SDK header map, replayed on requests
    storeRegionId: '', // user_selected_region for passport calls
    storeRegionSourceClient: '',
    storeRegionSourceApi: '',
  },
  appInfo: 'musical_ly/35.1.3/2023501030',
  deviceId: '',
  format: 'best', // best | best-no-watermark | worst | custom
  customFormat: '',
  // TikTok ships h264 and bytevc1 (HEVC). h264 is preferred because it plays
  // everywhere and already carries the highest bitrate; flip this only if you
  // want the smaller HEVC files.
  preferH265: false,
  writeThumbnail: true,
  writeInfoJson: false,
  audioOnly: false,
  maxHeight: 0, // 0 = unlimited
  concurrency: 2,
  embedBrowser: true,
  navigatorLanguage: '', // e.g. en-US, ru-RU — helps region consistency
  timezone: '', // e.g. Europe/Moscow
  // Optional request signing (yt-dlp#13134). Off by default: with it off the app
  // behaves exactly as before. 'gnarly' is the vendored pure-JS X-Gnarly, a WEB
  // signature. 'mobile' shells out to a user-supplied Python script that emits
  // the X-Gorgon/X-Ladon/X-Argus/X-Khronos family the mobile endpoint wants.
  signer: { enabled: false, provider: 'gnarly', signerPath: '' },
};

// Bump when a migration changes the meaning of an existing key. Kept OUT of
// DEFAULTS on purpose: get() merges DEFAULTS into its result, so a version in
// DEFAULTS would look "already migrated" on every install and migrations would
// never run. See raw() and migrateSettings().
const SCHEMA_VERSION = 2;

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

let cache = null;

function defaults() {
  const d = { ...DEFAULTS };
  if (!d.downloadDir) d.downloadDir = path.join(app.getPath('downloads'), 'TikTokMod');
  return d;
}

function get() {
  if (cache) return cache;
  cache = defaults();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = { ...cache, ...parsed };
  } catch {
    // no settings yet — use defaults
  }
  return cache;
}

/**
 * The on-disk file exactly as written, without DEFAULTS merged in.
 *
 * Migrations need this: get() fills in defaults for absent keys, so it cannot
 * tell "the user never set this" from "the user set it to the default value".
 * A schema-version gate must therefore read the raw file.
 */
function raw() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

function set(patch) {
  const next = { ...get(), ...patch };
  if (patch.downloadDir === '') next.downloadDir = defaults().downloadDir;
  // Keep the signer block shaped: a flat patch from the UI must not wipe the
  // provider/path when it only toggles `enabled`.
  next.signer = { ...DEFAULTS.signer, ...(get().signer || {}), ...(patch.signer || {}) };
  // Same for the bypass block: the UI patches one switch at a time, and a
  // shallow merge would drop the captured headers or the local region.
  next.bypass = { ...DEFAULTS.bypass, ...(get().bypass || {}), ...(patch.bypass || {}) };
  cache = next;
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

function reset() {
  cache = defaults();
  return cache;
}

module.exports = { get, set, reset, raw, DEFAULTS, SCHEMA_VERSION };