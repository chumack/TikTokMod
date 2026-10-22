'use strict';

// Region-bypass engine — the desktop port of the mechanism used by
// "TikTok Mod Cloud" (TikTok MC 1.0.2 Beta, TikTok 47.4.3).
//
// What the Android mod actually does (established by disassembling the APK):
//
//   1. It does NOT patch TikTok's own region code. A ContentProvider hidden
//      under the obfuscated name `X.5u1a` loads the native library
//      `libnpth_ext.so`, starts an ART method-hooking framework ("wear") and
//      installs hooks on the platform methods that report the SIM, the network
//      and the system region. Every consumer inside the app — TikTok's
//      `com.bytedance.i18n.region.RegionManager`, the request builders, the CDN
//      dispatcher — then reads the same fake country, and the app stays
//      internally consistent without a single patch to its own logic.
//
//   2. TikTok derives the request fields from those platform facts and sends
//      them SEPARATELY: region, current_region, sys_region, residence,
//      carrier_region, op_region, mcc_mnc, timezone_name, timezone_offset,
//      language. That separation is the whole trick: a phone with a Belarusian
//      SIM that is physically in Russia reports carrier_region=BY while
//      sys_region=RU, and TikTok's region priority rules then treat the SIM as
//      the home region instead of the IP.
//
//   3. `RegionParamInterceptor` injects the header map produced by the region
//      SDK into matching requests, and `StoreRegionSource$cdnInterceptor`
//      adopts the region named by the RESPONSE header `x-tt-app-cdn-region` as
//      the authoritative source.
//
//   4. Account/registration calls additionally carry `reg_store_region` and
//      `user_selected_region` (+ the `sign_up_store_region_source_*` headers)
//      from `StoreRegionInterceptor`.
//
//   5. The market-specific backend is chosen per region
//      (`api16-normal-c-useast1a` vs `api16-normal-c-alisg`) and a VPN with an
//      IP in the chosen country is part of the recipe — a region claim that
//      contradicts the egress IP is ignored by the server.
//
// There are no hooks to install on desktop, so the same facts are modelled
// explicitly and projected onto the parameters TikTok would have computed.

const regions = require('./regions');

// 'off'     — legacy behaviour: one region repeated in every field.
// 'strict'  — a phone that really is in the chosen country.
// 'roaming' — a foreign SIM in a phone that sits elsewhere (what the mod does).
const MODES = ['off', 'strict', 'roaming'];

// Facts the mod's hooks make the platform report. `cdn` is not a platform fact
// but the server's answer, kept here so the model has one shape.
const SOURCE_KEYS = ['sim', 'network', 'system', 'account', 'cdn'];

const SOURCE_LABELS = {
  sim: 'SIM-карта',
  network: 'сеть / роуминг',
  system: 'система',
  account: 'аккаунт',
  cdn: 'CDN',
};

// Paths that get the store-region parameters. Mirrors StoreRegionInterceptor:
// /passport/** plus the age-check screens. Matched against the endpoint, which
// may or may not carry a leading `/aweme/v1/`, so the passport segment is
// anchored on a boundary instead of on the start of the string.
const STORE_REGION_PATHS = [/(^|\/)passport\//i, /age[-_]?check/i, /register_region/i];

// Runtime facts (fresh IP/CDN answers). Kept in memory so the synchronous
// request builder can use them without writing settings on every refresh.
const runtime = { ipCountry: null, cdnRegion: null, seenAt: 0 };

function setRuntime(patch = {}) {
  if (patch.ipCountry !== undefined) runtime.ipCountry = twoLetter(patch.ipCountry);
  if (patch.cdnRegion !== undefined) runtime.cdnRegion = twoLetter(patch.cdnRegion);
  runtime.seenAt = Date.now();
  return { ...runtime };
}

function getRuntime() {
  return { ...runtime };
}

function twoLetter(value) {
  const code = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Region subtag of a BCP-47 locale ("ru-RU" -> "RU", "en" -> null). */
function localeRegion(value) {
  const parts = String(value || '').trim().replace(/_/g, '-').split('-');
  for (const part of parts.slice(1)) {
    const code = twoLetter(part);
    if (code) return code;
  }
  return null;
}

/** Mode with a safe fallback, so an old settings file still works. */
function modeOf(s) {
  const mode = String((s.bypass && s.bypass.mode) || '').toLowerCase();
  return MODES.includes(mode) ? mode : 'roaming';
}

/**
 * Where the phone physically is. Preference: explicit override, then the
 * measured egress country, then the region of the UI locale.
 */
function localRegion(s) {
  const b = s.bypass || {};
  return twoLetter(b.localRegion) || twoLetter(runtime.ipCountry) || localeRegion(s.navigatorLanguage) || null;
}

/**
 * The five region sources and the effective region derived from them.
 *
 * In 'roaming' the system/network sources keep the real country while the SIM
 * and the account carry the chosen one — the state that makes TikTok accept a
 * foreign SIM without a matching IP. In 'strict' everything is the chosen
 * country, which is also the legacy behaviour.
 */
function model(profile, s) {
  const b = s.bypass || {};
  const mode = modeOf(s);
  const override = b.sources && typeof b.sources === 'object' ? b.sources : {};
  const base = twoLetter(profile.region) || 'US';
  const local = localRegion(s) || base;
  const cdn = twoLetter(runtime.cdnRegion) || twoLetter(b.cdnRegion);

  const pick = (key, fallback) => twoLetter(override[key]) || fallback;

  if (mode === 'off') {
    return {
      mode,
      base,
      sim: base,
      network: base,
      system: base,
      account: base,
      cdn,
      effective: base,
      local,
      roaming: false,
      market: null,
    };
  }

  const sim = pick('sim', base);
  const network = pick('network', sim);
  const system = pick('system', mode === 'roaming' ? local : sim);
  const account = pick('account', base);
  const effective = b.adoptCdnRegion && cdn ? cdn : account;

  return {
    mode,
    base,
    sim,
    network,
    system,
    account,
    cdn,
    effective,
    local,
    // A foreign SIM in a phone that is somewhere else. Not an error: it is the
    // exact state the Android mod reproduces.
    roaming: sim !== system,
    market: regions.marketFor(effective),
  };
}

/** The machine's own IANA zone — the honest "where is this phone" answer. */
function machineTimezone() {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  } catch {
    return '';
  }
}

/**
 * The profile every request is built from: the region sources are collapsed
 * into the concrete carrier/timezone/language values their real Android
 * counterparts would produce. The mobile API never sees the model, only these.
 */
function project(profile, s) {
  const m = model(profile, s);
  const systemMeta = regions.REGION_META[m.system] || {};
  const simCarrier = m.sim === profile.region
    ? { mccmnc: profile.carrierMccmnc || '', name: profile.carrier || '' }
    : regions.carriersFor(m.sim)[0] || { mccmnc: '', name: '' };

  // The clock follows the physical location: the system region's zone, or the
  // machine's own zone when that region has no profile (RU/CN are not offered
  // as spoof targets but are perfectly valid places to be sitting in).
  const localZone = m.mode === 'roaming' && m.system === m.local ? machineTimezone() : '';
  const timezone = s.timezone || systemMeta.tz || localZone || profile.timezone;
  const language =
    (s.navigatorLanguage ? String(s.navigatorLanguage).split('-')[0] : '') ||
    systemMeta.lang ||
    profile.language;

  return {
    ...profile,
    region: m.effective,
    country: (regions.REGION_META[m.effective] || {}).name || m.effective,
    currency: (regions.REGION_META[m.effective] || {}).currency || profile.currency,
    timezone,
    timezoneOffset: regions.tzOffsetSeconds(timezone),
    language,
    carrier: simCarrier.name,
    carrierMccmnc: simCarrier.mccmnc,
    mcc: String(simCarrier.mccmnc || '').slice(0, 3),
    mnc: String(simCarrier.mccmnc || '').slice(3),
    model: m,
  };
}

/**
 * The region fields of the query, exactly as TikTok would have computed them
 * from the hooked platform. `mcc_mnc` stays the SIM operator even in roaming —
 * the SIM did not change, only its location did.
 */
function queryFields(projected) {
  const m = projected.model || model(projected, {});
  return {
    region: m.effective,
    current_region: m.account,
    sys_region: m.system,
    residence: m.system,
    carrier_region: m.sim,
    op_region: m.network,
    mcc_mnc: projected.carrierMccmnc || '',
  };
}

/**
 * The API host for the chosen region. The market families are not
 * interchangeable: an Asian/LatAm region is served by the `c-alisg` cluster and
 * asking `c-useast1a` for it returns a trimmed or empty answer, which is why the
 * mod ships separate builds for those markets.
 */
function apiHost(s, projected) {
  const explicit = String(s.apiHostname || '').trim();
  if (explicit) return explicit.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const m = (projected && projected.model) || model(projected || { region: 'US' }, s);
  return (m.market && m.market.host) || regions.API_HOSTS[0];
}

/**
 * Header map captured from the region SDK, replayed on every request. TikTok
 * gets this map from `region/submit`; we cannot derive it, so it is only used
 * when the user supplied one (Settings -> bypass.regionHeaders).
 */
function requestHeaders(s) {
  const stored = (s.bypass && s.bypass.regionHeaders) || {};
  const out = {};
  for (const [k, v] of Object.entries(stored)) {
    const name = String(k || '').trim();
    if (name && v != null && String(v).trim()) out[name] = String(v);
  }
  return out;
}

/** Store-region parameters/headers for passport and age-check paths. */
function storeRegion(pathname, projected, s) {
  const p = String(pathname || '');
  if (!STORE_REGION_PATHS.some((re) => re.test(p))) return { params: {}, headers: {} };
  const b = s.bypass || {};
  const params = { reg_store_region: (projected && projected.region) || model(projected || {}, s).effective };
  if (b.storeRegionId != null && String(b.storeRegionId).trim()) {
    params.user_selected_region = String(b.storeRegionId).trim();
  }
  const headers = {};
  if (b.storeRegionSourceClient) headers.sign_up_store_region_source_client = String(b.storeRegionSourceClient);
  if (b.storeRegionSourceApi) headers.sign_up_store_region_source_api = String(b.storeRegionSourceApi);
  return { params, headers };
}

/**
 * Reads the region the CDN says it is serving from. This is the desktop port of
 * StoreRegionSource$cdnInterceptor: TikTok itself adopts this header as the
 * authoritative region source, so a value that contradicts the claim proves the
 * bypass is not taking effect.
 */
function observe(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const cdn = twoLetter(headers.get('x-tt-app-cdn-region'));
  if (cdn) {
    runtime.cdnRegion = cdn;
    runtime.seenAt = Date.now();
  }
  return cdn;
}

/**
 * Consistency audit of the story being told. Every entry names the source pair
 * that disagrees, because "region mismatch" without the pair is not actionable.
 */
function audit(projected, s, ipCountry) {
  const m = (projected && projected.model) || model(projected || {}, s);
  const ip = twoLetter(ipCountry) || twoLetter(runtime.ipCountry);
  const b = s.bypass || {};
  // The newest answer from the CDN outranks the snapshot taken when the request
  // was built: the audit is about what the server said, not what we assumed.
  const cdn = twoLetter(runtime.cdnRegion) || twoLetter(b.cdnRegion) || m.cdn;
  const problems = [];

  if (ip && ip !== m.effective) {
    problems.push({
      level: 'error',
      code: 'ip-mismatch',
      text:
        `IP-адрес определяется как ${ip}, а приложение заявляет регион ${m.effective}. ` +
        `TikTok применяет ограничения и по IP, поэтому нужен прокси в ${m.effective} (или соседней стране без ограничений).`,
    });
  }
  if (cdn && cdn !== m.effective) {
    problems.push({
      level: 'error',
      code: 'cdn-mismatch',
      text:
        `CDN отдаёт регион ${cdn} (заголовок x-tt-app-cdn-region), а заявлен ${m.effective}. ` +
        'Это прямой признак того, что подмена не сработала: подпись/прокси/CDN-узел всё ещё указывают на другой регион.',
    });
  }
  if (m.mode === 'roaming' && !m.roaming) {
    problems.push({
      level: 'info',
      code: 'roaming-collapsed',
      text:
        `Режим «роуминг» включён, но локальная страна не определена, поэтому sys_region тоже ${m.system}. ` +
        'Обновите состояние на вкладке «Гео-обход», чтобы приложение увидело реальную страну IP.',
    });
  }
  if (m.roaming) {
    problems.push({
      level: 'info',
      code: 'roaming',
      text:
        `Роуминг: SIM/аккаунт — ${m.sim}, система/сеть — ${m.system}. Так выглядит иностранная SIM в телефоне, ` +
        'который физически находится в другой стране — именно это состояние воспроизводит мод.',
    });
  }
  if (!projected.carrierMccmnc) {
    problems.push({
      level: 'warn',
      code: 'no-carrier',
      text: `Для региона ${m.sim} нет оператора в таблице — mcc_mnc уйдёт пустым, и история про SIM станет неполной.`,
    });
  }
  if (!b.adoptCdnRegion && cdn) {
    problems.push({
      level: 'info',
      code: 'cdn-not-adopted',
      text: `CDN сообщил регион ${cdn}; он не подставлен в параметры (как это делает сам TikTok), но учтён в проверке.`,
    });
  }
  if (!s.proxy || !String(s.proxy).trim()) {
    problems.push({
      level: 'warn',
      code: 'no-proxy',
      text: 'Прокси не задан: подмена региона меняет только то, что приложение сообщает о себе.',
    });
  }

  return {
    ok: problems.every((p) => p.level !== 'error'),
    problems,
    sources: snapshot({ ...m, cdn }),
  };
}

function snapshot(m) {
  return SOURCE_KEYS.map((key) => ({
    key,
    label: SOURCE_LABELS[key],
    value: m[key] || null,
    active: Boolean(m[key]),
  }));
}

/** Everything the Geo tab needs, in one serialisable object. */
function describe(projected, s) {
  const m = projected.model || model(projected, s);
  const b = s.bypass || {};
  // Reporting always shows the newest CDN answer available.
  const cdn = twoLetter(runtime.cdnRegion) || twoLetter(b.cdnRegion) || m.cdn;
  return {
    mode: m.mode,
    modes: MODES.slice(),
    local: m.local,
    effective: m.effective,
    roaming: m.roaming,
    market: m.market ? m.market.family : null,
    apiHost: apiHost(s, projected),
    sources: snapshot({ ...m, cdn }),
    regionHeaders: Object.keys(requestHeaders(s)),
    storeRegion: storeRegion('/passport/app/region/register_region_list', projected, s),
  };
}

module.exports = {
  MODES,
  SOURCE_KEYS,
  setRuntime,
  getRuntime,
  model,
  project,
  queryFields,
  apiHost,
  requestHeaders,
  storeRegion,
  observe,
  audit,
  describe,
  localRegion,
  localeRegion,
};
