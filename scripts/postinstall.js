'use strict';
// Fetches yt-dlp + ffmpeg into ./vendor so the app works offline after install.
// Safe to skip: the app also resolves binaries from PATH at runtime.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');

const isWin = process.platform === 'win32';
const tag = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || 'Linux';
const arch = { x64: 'x86_64', arm64: 'arm64', ia32: 'i686', arm: 'armv7l' }[process.arch] || 'x86_64';

const YTDLP = {
  name: isWin ? 'yt-dlp.exe' : 'yt-dlp',
  url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp${isWin ? '.exe' : `_${tag}`}`,
};

const FFMPEG = {
  win32: {
    ffmpeg: {
      name: 'ffmpeg.exe',
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64',
    },
    ffprobe: {
      name: 'ffprobe.exe',
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffprobe-win32-x64',
    },
  },
  linux: {
    ffmpeg: {
      name: 'ffmpeg',
      url: `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch === 'x86_64' ? 'amd64' : arch}-static.tar.xz`,
      tar: true,
    },
    ffprobe: { name: 'ffprobe', url: null, tar: true },
  },
  darwin: { ffmpeg: { name: 'ffmpeg', url: null }, ffprobe: { name: 'ffprobe', url: null } },
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'tiktok-mod-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          fs.renameSync(tmp, dest);
          if (!isWin) {
            try {
              fs.chmodSync(dest, 0o755);
            } catch {}
          }
          resolve();
        });
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

async function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  fs.mkdirSync(path.join(VENDOR, 'bin'), { recursive: true });

  const ytdlpDest = path.join(VENDOR, 'bin', YTDLP.name);
  if (!(await exists(ytdlpDest))) {
    process.stdout.write('[setup] downloading yt-dlp... ');
    try {
      await download(YTDLP.url, ytdlpDest);
      console.log('ok');
    } catch (e) {
      console.log(`failed (${e.message}) — will try system yt-dlp at runtime`);
    }
  }

  const spec = FFMPEG[process.platform];
  if (spec && spec.ffmpeg && spec.ffmpeg.url) {
    const dest = path.join(VENDOR, 'bin', spec.ffmpeg.name);
    if (!(await exists(dest))) {
      process.stdout.write('[setup] downloading ffmpeg... ');
      try {
        if (spec.ffmpeg.tar) {
          throw new Error('tar-pack archives not handled; install ffmpeg via system package manager');
        }
        await download(spec.ffmpeg.url, dest);
        console.log('ok');
      } catch (e) {
        console.log(`failed (${e.message}) — merge formats will be unavailable`);
      }
    }
    if (spec.ffprobe && spec.ffprobe.url) {
      const pDest = path.join(VENDOR, 'bin', spec.ffprobe.name);
      if (!(await exists(pDest))) {
        try {
          await download(spec.ffprobe.url, pDest);
        } catch {}
      }
    }
  }

  console.log('[setup] done');
}

main().catch((e) => {
  console.warn('[setup] skipped:', e.message);
});