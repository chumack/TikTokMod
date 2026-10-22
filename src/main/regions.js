'use strict';

// Desktop counterpart of the Android TelephonyManager hooks used by
// "UnleashedTikTok" (eXtreames/UnleashedTikTok) to unblock TikTok in Russia.
//
// The Xposed module spoofs what the Android API reports about the SIM card:
//     getSimCountryIso   -> "BY"
//     getSimOperator     -> "25704"   (MCC+MNC of life:) )
//     getNetworkCountryIso/getNetworkOperator -> same
// and the official TikTok APK then behaves as if the phone were in Belarus.
//
// There are no such hooks on desktop, but the mobile API accepts the very same
// facts as request parameters: region / carrier_region / sys_region /
// op_region / residence / current_region (+ timezone, language, app_info,
// device_id). So the same deception is made at the network layer instead.

/** Operators (MCC+MNC) per country, so the "SIM card" story stays consistent. */
const CARRIERS = {
  BY: [['25704', 'life:)']],
  KZ: [
    ['40101', 'Kcell'],
    ['40102', 'beeline'],
    ['40177', 'Tele2'],
  ],
  UA: [
    ['25501', 'Kyivstar'],
    ['25502', 'Kyivstar'],
    ['25503', 'life:'],
  ],
  GE: [
    ['28201', 'Magti'],
    ['28202', 'TBC'],
  ],
  AM: [['28301', 'Armavir']],
  UZ: [
    ['43404', 'Uzmobile'],
    ['43402', 'Beeline'],
  ],
  TR: [
    ['28601', 'Turkcell'],
    ['28603', 'Vodafone'],
  ],
  AE: [['42005', 'Etisalat']],
  DE: [
    ['26201', 'Telekom'],
    ['26202', 'Vodafone'],
  ],
  NL: [['20404', 'KPN']],
  GB: [['23430', 'EE']],
  US: [
    ['310260', 'T-Mobile'],
    ['310410', 'AT&T'],
  ],
  CA: [['302720', 'Rogers']],
  JP: [['44010', 'NTT Docomo']],
  ID: [['51001', 'Telkomsel']],
  IN: [['40445', 'Airtel']],
  AU: [['50501', 'Telstra']],
  BR: [['72406', 'Vivo']],
  MX: [['334020', 'Telcel']],
};

const REGION_META = {
  BY: { name: 'Беларусь', tz: 'Europe/Minsk', lang: 'ru', currency: 'BYN' },
  KZ: { name: 'Казахстан', tz: 'Asia/Almaty', lang: 'kk', currency: 'KZT' },
  UA: { name: 'Украина', tz: 'Europe/Kyiv', lang: 'uk', currency: 'UAH' },
  GE: { name: 'Грузия', tz: 'Asia/Tbilisi', lang: 'ka', currency: 'GEL' },
  AM: { name: 'Армения', tz: 'Asia/Yerevan', lang: 'hy', currency: 'AMD' },
  UZ: { name: 'Узбекистан', tz: 'Asia/Tashkent', lang: 'uz', currency: 'UZS' },
  TR: { name: 'Турция', tz: 'Europe/Istanbul', lang: 'tr', currency: 'TRY' },
  AE: { name: 'ОАЭ', tz: 'Asia/Dubai', lang: 'ar', currency: 'AED' },
  DE: { name: 'Германия', tz: 'Europe/Berlin', lang: 'de', currency: 'EUR' },
  NL: { name: 'Нидерланды', tz: 'Europe/Amsterdam', lang: 'nl', currency: 'EUR' },
  GB: { name: 'Великобритания', tz: 'Europe/London', lang: 'en', currency: 'GBP' },
  US: { name: 'США', tz: 'America/New_York', lang: 'en', currency: 'USD' },
  CA: { name: 'Канада', tz: 'America/Toronto', lang: 'en', currency: 'CAD' },
  JP: { name: 'Япония', tz: 'Asia/Tokyo', lang: 'ja', currency: 'JPY' },
  ID: { name: 'Индонезия', tz: 'Asia/Jakarta', lang: 'id', currency: 'IDR' },
  IN: { name: 'Индия', tz: 'Asia/Kolkata', lang: 'hi', currency: 'INR' },
  AU: { name: 'Австралия', tz: 'Australia/Sydney', lang: 'en', currency: 'AUD' },
  BR: { name: 'Бразилия', tz: 'America/Sao_Paulo', lang: 'pt', currency: 'BRL' },
  MX: { name: 'Мексика', tz: 'America/Mexico_City', lang: 'es', currency: 'MXN' },
};

// TikTok ships different app builds per market: musical_ly everywhere except
// trill for KR/PH/TW/TH/VN. aid must match the app_name, otherwise the API
// answers with an empty item list.
const APP_INFO = {
  trill: { app_name: 'trill', app_version: '35.1.3', manifest_app_version: '2023501030', aid: '1180' },
  musical_ly: { app_name: 'musical_ly', app_version: '35.1.3', manifest_app_version: '2023501030', aid: '1233' },
  aweme: { app_name: 'aweme', app_version: '35.1.3', manifest_app_version: '2023501030', aid: '1128' },
};
const TRILL_MARKETS = ['KR', 'PH', 'TW', 'TH', 'VN'];

const API_HOSTS = [
  'api16-normal-c-useast1a.tiktokv.com',
  'api16-normal-c-alisg.tiktokv.com',
  'api19-normal-c-useast1a.tiktokv.com',
  'api-h2.tiktokv.com',
  'api.tiktokv.com',
];

// TikTok runs two market clusters and the region-control SDK dispatches between
// them per region: `c-useast1a` for Europe/Americas/Africa, `c-alisg` for
// Asia-Pacific and Latin America. Asking the wrong cluster for a region returns
// a trimmed or empty feed even when every region parameter is correct — the Mod
// Cloud ships a separate market build for exactly this reason.
const MARKET_HOSTS = {
  useast1a: 'api16-normal-c-useast1a.tiktokv.com',
  alisg: 'api16-normal-c-alisg.tiktokv.com',
};

const ALISG_MARKETS = [
  'JP', 'KR', 'TW', 'HK', 'TH', 'VN', 'PH', 'ID', 'MY', 'SG',
  'IN', 'PK', 'BD', 'LK', 'KH', 'LA', 'MM', 'NP', 'MN',
  'AU', 'NZ', 'BR', 'MX', 'AR', 'CL', 'CO', 'PE',
];

const MARKET_LABELS = {
  useast1a: 'Европа / Америка / Африка (c-useast1a)',
  alisg: 'Азия и Латинская Америка (c-alisg)',
};

/** Which market cluster serves a region, and its API host. */
function marketFor(region) {
  const code = String(region || '').toUpperCase().slice(0, 2);
  const family = ALISG_MARKETS.includes(code) ? 'alisg' : 'useast1a';
  return { family, region: code, host: MARKET_HOSTS[family], label: MARKET_LABELS[family] };
}

/** Current UTC offset in seconds for an IANA zone, DST-aware (Intl/ICU). */
function tzOffsetSeconds(timezone, at = Date.now()) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUTC - Math.floor(at / 1000) * 1000) / 1000);
  } catch {
    return 0;
  }
}

function appInfoFor(region) {
  return TRILL_MARKETS.includes(region) ? APP_INFO.trill : APP_INFO.musical_ly;
}

function carriersFor(region) {
  return (CARRIERS[region] || []).map(([mccmnc, name]) => ({ mccmnc, name }));
}

/**
 * Full, internally consistent region description. `carrierIndex` picks which
 * operator of that country to present (0 = first).
 */
function getProfile(region, { carrierIndex = 0, timezone, language } = {}) {
  const code = String(region || 'US').toUpperCase().slice(0, 2);
  const meta = REGION_META[code] || { name: code, tz: 'Europe/London', lang: 'en' };
  const carriers = carriersFor(code);
  const carrier = carriers[carrierIndex % Math.max(1, carriers.length)] || { mccmnc: '', name: '' };
  const app = appInfoFor(code);
  const tz = timezone || meta.tz;
  return {
    region: code,
    country: meta.name,
    timezone: tz,
    timezoneOffset: tzOffsetSeconds(tz),
    language: language || meta.lang,
    currency: meta.currency || 'USD',
    // device identity
    app_name: app.app_name,
    app_version: app.app_version,
    manifest_app_version: app.manifest_app_version,
    aid: app.aid,
    // "SIM card"
    carrier: carrier.name,
    carrierMccmnc: carrier.mccmnc,
    mcc: carrier.mccmnc.slice(0, 3),
    mnc: carrier.mccmnc.slice(3),
    carriers,
  };
}

/** Profiles offered in the UI, with the labels a Russian user expects. */
function listProfiles() {
  return Object.keys(REGION_META).map((code) => {
    const p = getProfile(code);
    return {
      region: code,
      country: p.country,
      timezone: p.timezone,
      carrier: p.carriers[0]?.name || '',
      carrierList: p.carriers,
      recommended: ['BY', 'KZ', 'UA', 'GE', 'AM', 'UZ', 'TR'].includes(code),
    };
  });
}

/**
 * Health of the current setup. A region spoof without a matching egress IP is
 * the single most common reason for "TikTok only shows old videos": the
 * network layer still resolves the visitor as RU.
 */
function assessConsistency(profile, ipCountry) {
  const problems = [];
  if (ipCountry && ipCountry.toUpperCase() !== profile.region) {
    problems.push({
      level: 'warn',
      code: 'ip-mismatch',
      text: `IP-адрес определяется как ${ipCountry.toUpperCase()}, а устройство заявляет регион ${profile.region}. Сервер TikTok всё равно применит ограничения по IP — нужен прокси в ${profile.country}.`,
    });
  }
  if (!profile.carrierMccmnc) {
    problems.push({
      level: 'info',
      code: 'no-carrier',
      text: `Для региона ${profile.region} нет оператора в таблице — регион будет заявлен без MCC/MNC.`,
    });
  }
  return {
    ok: problems.every((p) => p.level !== 'warn'),
    problems,
  };
}

module.exports = {
  getProfile,
  listProfiles,
  assessConsistency,
  tzOffsetSeconds,
  carriersFor,
  marketFor,
  CARRIERS,
  REGION_META,
  API_HOSTS,
  MARKET_HOSTS,
  ALISG_MARKETS,
  APP_INFO,
};