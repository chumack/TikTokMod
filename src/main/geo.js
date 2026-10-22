'use strict';

// Answers the question the user actually has: "why does TikTok only show me
// old videos?". The answer is almost never the video and almost always the
// egress IP, so the app has to be able to show it.
//
// UnleashedTikTok gets away with a SIM spoof alone because Android reports the
// fake SIM to the official APK. On desktop nothing enforces consistency between
// the claimed region and the connecting IP, so we measure the IP ourselves and
// warn when the two disagree.

const { session } = require('electron');
const regions = require('./regions');
const geobypass = require('./geobypass');

// Public, key-less geolocation services. Any of them may rate-limit or be
// unreachable; all failures are non-fatal and simply produce an unknown country.
const SERVICES = [
  { url: 'https://api.country.is/', pick: (j) => j.country || j.country_code },
  { url: 'https://ipapi.co/json/', pick: (j) => j.country_code || j.country },
  { url: 'https://ifconfig.co/json', pick: (j) => j.country_iso || j.country },
];

async function detectCountry({ timeout = 8000 } = {}) {
  for (const svc of SERVICES) {
    try {
      const res = await fetch(svc.url, {
        headers: { Accept: 'application/json', 'User-Agent': 'TikTokMod/1.0' },
        session: session.defaultSession,
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const code = String(svc.pick(json) || '').toUpperCase().slice(0, 2);
      if (/^[A-Z]{2}$/.test(code)) {
        return { country: code, ip: json.ip || null, source: svc.url };
      }
    } catch {
      // try the next service
    }
  }
  return { country: null, ip: null, source: null, failed: true };
}

/**
 * Full state of the geo setup, as shown on the "Geo" tab.
 * Cheap by design: it never touches TikTok, only the IP-location services.
 */
async function inspect(s) {
  const base = regions.getProfile(s.regionProfile || s.region || 'US', {
    carrierIndex: Number(s.carrierIndex) || 0,
    timezone: s.timezone || undefined,
    language: s.navigatorLanguage ? String(s.navigatorLanguage).split('-')[0] : undefined,
  });

  const egress = await detectCountry();
  // The request builder is synchronous, so the measured country has to be
  // published before the next API call can use it in the region model.
  geobypass.setRuntime({ ipCountry: egress.country });

  const profile = geobypass.project(base, s);
  const consistency = regions.assessConsistency(profile, egress.country);
  const audit = geobypass.audit(profile, s, egress.country);
  const bypass = geobypass.describe(profile, s);

  const notes = [];
  const systemTz = (regions.REGION_META[(profile.model || {}).system] || {}).tz;
  if (s.timezone && systemTz && s.timezone !== systemTz) {
    notes.push({
      level: 'info',
      text: `Часовой пояс ${s.timezone} не совпадает с регионом системы ${profile.model.system} (${systemTz}). В режиме «роуминг» часы должны показывать местное время, а не время SIM.`,
    });
  }
  if (!s.emulator?.device_id) {
    notes.push({
      level: 'info',
      text: 'Эмулируемое устройство ещё не создано — будет сгенерировано при первом обращении к API и затем закреплено за этой установкой.',
    });
  }

  return {
    profile: {
      region: profile.region,
      country: profile.country,
      carrier: profile.carrier,
      carrierMccmnc: profile.carrierMccmnc,
      timezone: profile.timezone,
      timezoneOffset: profile.timezoneOffset,
      language: profile.language,
      app: `${profile.app_name} ${profile.app_version} (aid ${profile.aid})`,
      carriers: profile.carriers,
      // Region model: the five sources, the market cluster and the host they
      // resolve to. This is the part that replaced the single repeated region.
      mode: bypass.mode,
      roaming: bypass.roaming,
      market: bypass.market,
      apiHost: bypass.apiHost,
      sources: bypass.sources,
    },
    egress,
    proxy: s.proxy || '',
    consistency,
    audit,
    bypass,
    notes,
    // Straight answer for the UI headline.
    verdict: buildVerdict(egress, profile, consistency, s),
  };
}

function buildVerdict(egress, profile, consistency, s) {
  const hasProxy = !!(s.proxy && String(s.proxy).trim());
  const m = profile.model || {};
  if (egress.failed) {
    return {
      ok: true,
      level: 'warn',
      text: 'Не удалось определить страну по IP (сервисы геолокации недоступны). Сверьте регион и прокси вручную.',
    };
  }
  // A roaming setup is *supposed* to disagree with the IP: the SIM is foreign
  // while the phone sits at home. Reporting that as a hard mismatch would send
  // the user chasing a configuration that is already working as intended.
  if (m.roaming && egress.country === m.system) {
    return {
      ok: true,
      level: 'warn',
      text: `IP (${egress.country}) совпадает с системным регионом, а SIM заявляет ${m.sim} — это ожидаемое состояние роуминга, на нём и работает мод. Но TikTok ограничивает и по IP, поэтому для полной выдачи нужен прокси в ${m.sim}.`,
    };
  }
  if (!consistency.ok) {
    return {
      ok: false,
      level: 'error',
      text: `IP (${egress.country}) не совпадает с заявленным регионом ${profile.region}. Без прокси в ${profile.country} TikTok продолжит показывать ограниченную выдачу — это и есть причина «старых видео».`,
    };
  }
  if (!hasProxy) {
    return {
      ok: true,
      level: 'warn',
      text: `IP (${egress.country}) совпадает с регионом ${profile.region}. Выдача должна быть полной, но прокси в ${profile.country} всё равно надёжнее при смене IP.`,
    };
  }
  return {
    ok: true,
    level: 'info',
    text: `Регион, оператор и IP согласованы (${egress.country}). Эмуляция активна.`,
  };
}

module.exports = { detectCountry, inspect };