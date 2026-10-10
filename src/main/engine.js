'use strict';

// Picks the engine for each operation and falls back between them.
//
//   ttapi  — our own region-aware TikTok mobile API client. Full control over
//            region/operator/timezone/device, which is what unblocks the
//            trimmed feed. Needs no signatures.
//   ytdlp  — mature extractor with resume, retries and ffmpeg merging. Its
//            region parameters are hardcoded to 'US' and cannot be changed,
//            so it stays the byte downloader and the fallback metadata reader.
//
// Bytes always come from yt-dlp: it handles merging, resume and progress more
// reliably than a hand-rolled HTTP downloader.

const ytdlp = require('./ytdlp');
const ttapi = require('./ttapi');

function engineOf(s) {
  const e = String(s.engine || 'auto').toLowerCase();
  return ['api', 'ytdlp'].includes(e) ? e : 'auto';
}

function isGeoBlocked(err) {
  const t = String((err && err.message) || '').toLowerCase();
  return (
    t.includes('ip') && (t.includes('блок') || t.includes('blocked')) ||
    t.includes('403') || t.includes('429') ||
    t.includes('регион') || t.includes('region') || t.includes('geoblock') ||
    t.includes('недоступно') || t.includes('waf')
  );
}

/**
 * Metadata for one video. 'auto' prefers the API (fresh feed, region spoof),
 * but silently switches to yt-dlp when the API is unavailable — including when
 * a region really is blocked, which is exactly the case worth retrying.
 *
 * Links that are not a single video (feed, profile, hashtag, sound) are rejected
 * up front with an explanation: yt-dlp would only answer "Unsupported URL",
 * which reads like a failure rather than an unsupported input.
 */
async function probe(url, s, { strict = true } = {}) {
  if (strict && !ytdlp.isDownloadableUrl(url)) {
    const err = new Error(ytdlp.explainUnsupported(url));
    err.code = 'unsupported-url';
    err.kind = ytdlp.classifyUrl(url).kind;
    throw err;
  }
  const engine = engineOf(s);
  if (engine === 'ytdlp') return ytdlp.probe(url, s);
  if (engine === 'api') return ttapi.probe(url, s);

  try {
    return await ttapi.probe(url, s);
  } catch (apiErr) {
    try {
      const info = await ytdlp.probe(url, s);
      info.engineNote = `API недоступен (${apiErr.message}); метаданные получены через yt-dlp`;
      return info;
    } catch (ytErr) {
      // Report whichever failure is more likely to be the real cause.
      if (isGeoBlocked(apiErr)) throw apiErr;
      throw new Error(`${apiErr.message} | yt-dlp: ${ytErr.message}`);
    }
  }
}

async function probeBatch(urls, s, { concurrency = 3, onEach } = {}) {
  const engine = engineOf(s);
  if (engine === 'ytdlp') return ytdlp.probeBatch(urls, s, { concurrency, onEach });
  if (engine === 'api') return ttapi.probeBatch(urls, s, { concurrency, onEach });

  const list = [...new Set(urls.filter(Boolean))];
  const results = [];
  const queue = [...list];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const n = await probe(url, s);
        results.push(n);
        onEach?.(n);
      } catch (e) {
        const item = { url, id: ytdlp.extractId(url), error: e.message };
        results.push(item);
        onEach?.(item);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Author feed, only available through the API (yt-dlp's list is web-scraped). */
async function author(input, s, { cursor = 0 } = {}) {
  const user = await ttapi.resolveUser(input, s);
  const page = await ttapi.userPosts(user.secUid, { cursor }, s);
  return { user, ...page };
}

/** Saves a photo/cover URL directly; yt-dlp cannot fetch bare CDN images. */
async function saveMedia(url, destPath, s) {
  return ttapi.fetchMedia(url, destPath, s);
}

module.exports = { probe, probeBatch, author, saveMedia, engineOf };