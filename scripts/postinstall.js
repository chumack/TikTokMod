'use strict';
// Fetches yt-dlp + ffmpeg into ./vendor so the app works offline after install.
// Safe to skip: the app also resolves binaries from PATH at runtime.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');

const isWin = process.platform === 'win32';

// yt-dlp ships one self-contained binary per platform/arch pair, and the
// release asset names do NOT share a single scheme: Windows uses the bare
// ".exe" suffix, Linux/macOS put the platform in the middle, and only some
// arches have a prebuilt binary at all. Building the name from platform+arch
// keeps a 32-bit or ARM host from downloading the x86_64 build and failing at
// runtime with an exec format error.
function ytdlpAsset() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    if (arch === 'ia32') return { name: 'yt-dlp_x86.exe', asset: 'yt-dlp_x86.exe' };
    if (arch === 'arm64') return { name: 'yt-dlp_arm64.exe', asset: 'yt-dlp_arm64.exe' };
    return { name: 'yt-dlp.exe', asset: 'yt-dlp.exe' };
  }
  if (platform === 'darwin') {
    // macOS builds are universal; yt-dlp publishes no arm64-specific asset.
    return { name: 'yt-dlp', asset: 'yt-dlp_macos' };
  }
  const linuxArch = { x64: '', arm64: '_aarch64', arm: '_armv7l', ia32: null }[arch];
  if (linuxArch === null) return { name: 'yt-dlp', asset: 'yt-dlp' }; // zip/py fallback
  return { name: 'yt-dlp', asset: `yt-dlp_linux${linuxArch}` };
}

const YTDLP = {
  name: ytdlpAsset().name,
  url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset().asset}`,
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
    // BtbN/FFmpeg-Builds publishes one tar.xz per platform/arch that holds
    // ffmpeg, ffprobe and ffplay in a versioned subdirectory.
    //
    // It replaces the johnvansickle build this project used before, and the
    // reason is a crash, not a version number: the johnvansickle binaries are
    // linked against glibc 2.19 and are FULLY static, so they have no NSS
    // modules to load and die with SIGSEGV the moment they resolve a name.
    // Measured on Manjaro: every network input crashed them — a plain
    // http:// to a local server included — while the same input through the
    // distro's own ffmpeg wrote megabytes. The crash happens before a single
    // byte of media is read, so recording a live stream produced an empty
    // file and the user was told TikTok had delivered nothing.
    //
    // The BtbN builds link against the system glibc, so the resolver works.
    // The LGPL flavour is used: it is smaller and redistributable.
    archive: {
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux${
        { x64: '64', arm64: 'arm64', arm: 'armv7l', ia32: '32' }[process.arch] || '64'
      }-lgpl.tar.xz`,
    },
    ffmpeg: { name: 'ffmpeg' },
    // ffprobe is deliberately NOT bundled: nothing in the app ever spawns it
    // — binaries.ffprobe() only feeds the diagnostics panel, and yt-dlp falls
    // back to ffmpeg when it is absent. Recording and format merging both run
    // through ffmpeg alone.
    ffprobe: { name: 'ffprobe', bundled: false },
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

/**
 * Checks that a freshly downloaded ffmpeg can actually open a network URL.
 *
 * The static build this project used to ship (johnvansickle, 7.0.2, linked
 * against glibc 2.19) dies with SIGSEGV the moment it resolves a hostname —
 * measured on Manjaro, EVERY network input crashed it, including a plain
 * http:// to a local server, while the same input through the distro's own
 * ffmpeg wrote megabytes. A statically linked glibc has no NSS modules to
 * dlopen, and this build faults instead of reporting the failure.
 *
 * Shipping that binary means every recording of a live stream dies before the
 * first frame, and the user is told TikTok delivered nothing — while the
 * actual fault is the file we put there ourselves. So the binary is checked
 * before it is kept, and a broken one is discarded in favour of the system
 * ffmpeg.
 *
 * The probe uses a hostname on purpose: a literal IP skips the resolver
 * entirely, which is exactly where the crash lives. The name is in the
 * reserved ".invalid" TLD, so it never leaves the machine — a healthy ffmpeg
 * fails the lookup in milliseconds, while the broken one still crashes inside
 * the resolver it cannot survive. No network traffic, no waiting.
 */
function ffmpegWorks(binPath) {
  const res = spawnSync(
    binPath,
    ['-hide_banner', '-loglevel', 'quiet', '-i', 'http://nonexistent.invalid:1/', '-t', '1', '-f', 'null', '-'],
    { timeout: 20000, stdio: 'pipe' }
  );
  if (res.error) return false;
  // A signal means it crashed. SIGKILL is our own timeout, not a verdict.
  if (res.signal) return res.signal === 'SIGKILL';
  return true;
}

/**
 * Unpacks the static ffmpeg tar.xz and copies the binaries out of the
 * versioned directory it ships in, so `vendor/bin/ffmpeg` and
 * `vendor/bin/ffprobe` sit next to where binaries.js looks for them.
 *
 * Shelling out to `tar` is deliberate: xz decompression is not something Node
 * can do without a dependency, and tar is present on every Linux distribution
 * this app targets (it is also what the .deb/AppImage unpack path already
 * relies on). When tar is missing the caller reports a soft failure and the
 * app falls back to a system ffmpeg from PATH.
 */
function extractFfmpegTar(archivePath, destDir, names) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktokmod-ffmpeg-'));
  try {
    const res = spawnSync('tar', ['-xJf', archivePath, '-C', tmpDir], { stdio: 'pipe' });
    if (res.error) throw new Error(res.error.message);
    if (res.status !== 0) {
      throw new Error((res.stderr || Buffer.alloc(0)).toString().trim().split('\n').pop() || `tar exit ${res.status}`);
    }

    const found = new Map();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (names.includes(entry.name) && !found.has(entry.name)) found.set(entry.name, full);
      }
    };
    walk(tmpDir);

    const missing = names.filter((n) => !found.has(n));
    if (missing.length) throw new Error(`tar archive is missing ${missing.join(', ')}`);

    for (const name of names) {
      const dest = path.join(destDir, name);
      fs.copyFileSync(found.get(name), dest);
      if (!isWin) fs.chmodSync(dest, 0o755);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function fetchFfmpeg(spec, destDir) {
  // A binary is wanted when the platform keeps it bundled and it is not
  // already on disk from an earlier install.
  const wanted = [spec.ffmpeg, spec.ffprobe]
    .filter((s) => s && s.name && s.bundled !== false)
    .filter((s) => !fs.existsSync(path.join(destDir, s.name)));
  if (!wanted.length) return;

  // Windows: two independent single-binary downloads.
  if (!spec.archive) {
    for (const s of wanted) {
      if (!s.url) continue;
      try {
        await download(s.url, path.join(destDir, s.name));
      } catch {}
    }
    return;
  }

  // Linux: one archive holding the binaries in a versioned subdirectory.
  process.stdout.write('[setup] downloading ffmpeg archive... ');
  const archivePath = path.join(os.tmpdir(), `tiktokmod-ffmpeg-${process.pid}.tar.xz`);
  try {
    await download(spec.archive.url, archivePath);
    extractFfmpegTar(archivePath, destDir, wanted.map((s) => s.name));
    console.log('ok');
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  // A binary that cannot open a URL is worse than no binary at all: it turns
  // every live recording into an empty file and blames TikTok for it. Drop it
  // and let the app use the system ffmpeg instead.
  const ffmpegPath = path.join(destDir, 'ffmpeg');
  if (fs.existsSync(ffmpegPath) && !ffmpegWorks(ffmpegPath)) {
    fs.rmSync(ffmpegPath, { force: true });
    throw new Error('the downloaded ffmpeg crashes on any network input (SIGSEGV) — discarded');
  }
}

async function main() {
  const binDir = path.join(VENDOR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ytdlpDest = path.join(binDir, YTDLP.name);
  if (!(await exists(ytdlpDest))) {
    process.stdout.write(`[setup] downloading yt-dlp (${process.platform}/${process.arch})... `);
    try {
      await download(YTDLP.url, ytdlpDest);
      console.log('ok');
    } catch (e) {
      console.log(`failed (${e.message}) — will try system yt-dlp at runtime`);
    }
  }

  const spec = FFMPEG[process.platform];
  if (spec && spec.ffmpeg) {
    try {
      await fetchFfmpeg(spec, binDir);
    } catch (e) {
      console.warn(`[setup] ffmpeg unavailable (${e.message}) — install it via your package manager for merge formats`);
    }
  }

  console.log('[setup] done');
}

main().catch((e) => {
  console.warn('[setup] skipped:', e.message);
});