'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// yt-dlp / ffmpeg resolution order:
//   1. user-configured override dir (settings.binDir)
//   2. bundled vendor/bin (next to app resources when packaged, repo root in dev)
//   3. system PATH

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';

let binDirOverride = null;
let resourcesRoot = null; // set by main.js

function setResourcesRoot(p) {
  resourcesRoot = p;
}

function setBinDir(dir) {
  binDirOverride = dir && dir.trim() ? dir.trim() : null;
}

function vendorDirs() {
  const roots = [];
  if (resourcesRoot) roots.push(resourcesRoot);
  roots.push(path.join(__dirname, '..', '..')); // dev: <repo>/src/main -> <repo>
  return roots;
}

function bundledPaths(name) {
  const out = [];
  for (const r of vendorDirs()) {
    out.push(path.join(r, 'vendor', 'bin', name + EXE));
    out.push(path.join(r, 'bin', name + EXE));
  }
  return out;
}

function fromPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, name + (ext || EXE));
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function find(name) {
  if (binDirOverride) {
    const p = path.join(binDirOverride, name + EXE);
    if (isExecutable(p)) return p;
  }
  for (const p of bundledPaths(name)) {
    if (isExecutable(p)) return p;
  }
  return fromPath(name);
}

// Every candidate for a given tool, best first. `find` returns only the first,
// but the ffmpeg lookup has to be able to fall through to the next one when the
// chosen binary turns out to be broken.
function candidates(name) {
  const out = [];
  if (binDirOverride) {
    const p = path.join(binDirOverride, name + EXE);
    if (isExecutable(p)) out.push(p);
  }
  for (const p of bundledPaths(name)) {
    if (isExecutable(p) && !out.includes(p)) out.push(p);
  }
  const onPath = fromPath(name);
  if (onPath && !out.includes(onPath)) out.push(onPath);
  return out;
}

function ytdlp() {
  return find('yt-dlp');
}

// Cached verdict per ffmpeg path: does it survive a network read?
//
// WHY THIS EXISTS. The static ffmpeg that ships with the Linux package
// (johnvansickle, 7.0.2, linked against glibc 2.19) dies with SIGSEGV the
// moment it resolves a hostname: measured on Manjaro, EVERY network input
// crashed it — a plain http:// to a local server included — while the same
// input through the distro's own ffmpeg wrote megabytes. The crash happens in
// the resolver, before a single byte of media is read, so the recording ends
// with an empty file and the user is told "the stream did not deliver a
// single frame" — a message that points at TikTok while the real fault is
// three directories deeper, in a binary we put there ourselves.
//
// The check below asks the binary to open a URL and reports what happened. A
// SIGSEGV shows up as a null exit code with a signal, which is exactly what
// distinguishes "crashed" from "answered and had nothing to offer".
let ffmpegHealth = new Map();
// Binaries already reported as broken — the warning is printed once each.
const warnedBroken = new Set();

function probeFfmpeg(p) {
  if (ffmpegHealth.has(p)) return ffmpegHealth.get(p);

  // The URL uses a HOSTNAME on purpose. A literal IP skips the resolver
  // entirely, and that is precisely where the crash lives: the broken build
  // survives http://127.0.0.1/ and dies on any name.
  //
  // The name is in the reserved ".invalid" TLD, so it never leaves the
  // machine: a healthy ffmpeg fails the lookup in milliseconds, while the
  // broken one still crashes inside the resolver it cannot survive. That
  // keeps the check fast (tens of milliseconds) and free of network traffic.
  const res = spawnSync(p, ['-hide_banner', '-loglevel', 'quiet', '-i', 'http://nonexistent.invalid:1/', '-t', '1', '-f', 'null', '-'], {
    timeout: 20000,
    windowsHide: true,
  });

  let ok;
  if (res.error) {
    // Could not even run it (missing library, not executable) — unusable.
    ok = false;
  } else if (res.signal) {
    // Killed by a signal: SIGSEGV (null address) and SIGABRT are the crash
    // modes we are looking for. SIGKILL means our own timeout expired, which
    // is not a verdict on the binary.
    ok = res.signal === 'SIGKILL';
  } else {
    // Ran to completion. Any exit code is fine here: ffmpeg exits non-zero
    // when the input is not media, and that still proves the resolver and the
    // network stack work.
    ok = true;
  }

  ffmpegHealth.set(p, ok);
  return ok;
}

function ffmpeg() {
  const list = candidates('ffmpeg');
  let chosen = null;
  for (const p of list) {
    if (probeFfmpeg(p)) {
      chosen = p;
      break;
    }
    // The verdict is cached, so this line would otherwise repeat on every
    // call. Say it once per binary.
    if (!warnedBroken.has(p)) {
      warnedBroken.add(p);
      console.warn(`[binaries] ffmpeg at ${p} is broken on this system — trying the next one`);
    }
  }
  if (!chosen) return list[0] || null;

  // yt-dlp locates ffmpeg via PATH; make sure our copy wins
  const dir = path.dirname(chosen);
  if (!(process.env.PATH || '').split(path.delimiter).includes(dir)) {
    process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
  }
  return chosen;
}

function ffprobe() {
  return find('ffprobe');
}

function status() {
  const y = ytdlp();
  return {
    ytDlp: y,
    ytDlpBundled: Boolean(y && y.includes('vendor')),
    ffmpeg: ffmpeg(),
    ffprobe: ffprobe(),
    overrideDir: binDirOverride,
  };
}

module.exports = { ytdlp, ffmpeg, ffprobe, setBinDir, setResourcesRoot, status, EXE };