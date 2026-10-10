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
  const profile = regions.getProfile(s.regionProfile || s.region || 'US', {
    carrierIndex: Number(s.carrierIndex) || 0,
    timezone: s.timezone || undefined,
    language: s.navigatorLanguage ? String(s.navigatorLanguage).split('-')[0] : undefined,
  });

  const egress = await detectCountry();
  const consistency = regions.assessConsistency(profile, egress.country);

  const notes = [];
  if (!s.proxy || !String(s.proxy).trim()) {
    notes.push({
      level: 'warn',
      text:
        'Прокси не задан. Подмена региона меняет то, что приложение сообщает о себе, ' +
        'но TikTok всё равно видит ваш реальный IP. Для свежих видео нужен прокси в ' +
        `${profile.country} или соседней стране без ограничений.`,
    });
  }
  if (s.timezone && s.timezone !== profile.timezone) {
    notes.push({
      level: 'info',
      text: `Часовой пояс в настройках (${s.timezone}) не совпадает с регионом ${profile.region} (${profile.timezone}). Лучше оставить ${profile.timezone}.`,
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
    },
    egress,
    proxy: s.proxy || '',
    consistency,
    notes,
    // Straight answer for the UI headline.
    verdict: buildVerdict(egress, profile, consistency, s),
  };
}

function buildVerdict(egress, profile, consistency, s) {
  const hasProxy = !!(s.proxy && String(s.proxy).trim());
  if (egress.failed) {
    return {
      ok: true,
      level: 'warn',
      text: 'Не удалось определить страну по IP (сервисы геолокации недоступны). Сверьте регион и прокси вручную.',
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