'use strict';
// electron-builder `beforePack` hook: drops vendor/bin binaries that do not
// belong to the platform being packaged.
//
// vendor/bin is filled by scripts/postinstall.js, which downloads for the host
// platform only. The build config copies all of vendor/ into extraResources, so
// on a machine that built for Windows once, a Linux package would ship
// yt-dlp.exe — 17 MB of dead weight that cannot run there — and, worse, ship no
// yt-dlp of its own to fall back on. Pruning here keeps every artifact
// self-contained regardless of what the build host happened to download.
//
// The hook deletes files in the working tree. That is safe because
// vendor/bin/ is gitignored and re-created on the next `npm install`.

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function beforePack(context) {
  const platform = context.electronPlatformName; // 'linux' | 'win32' | 'mac'
  const binDir = path.join(context.packager.projectDir, 'vendor', 'bin');

  let entries;
  try {
    entries = fs.readdirSync(binDir);
  } catch {
    return; // nothing downloaded — binaries.js will fall back to system PATH
  }

  const keep = (name) => (platform === 'win32' ? name.toLowerCase().endsWith('.exe') : !name.endsWith('.exe'));

  const removed = [];
  for (const name of entries) {
    const full = path.join(binDir, name);
    if (!fs.statSync(full).isFile() || keep(name)) continue;
    fs.rmSync(full, { force: true });
    removed.push(name);
  }

  if (removed.length) {
    console.log(`[before-pack] ${platform}: dropped ${removed.join(', ')} from vendor/bin`);
  }
};