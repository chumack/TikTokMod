'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function ytdlp() {
  return find('yt-dlp');
}

function ffmpeg() {
  const p = find('ffmpeg');
  if (p) {
    // yt-dlp locates ffmpeg via PATH; make sure our copy wins
    const dir = path.dirname(p);
    if (!(process.env.PATH || '').split(path.delimiter).includes(dir)) {
      process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
    }
  }
  return p;
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