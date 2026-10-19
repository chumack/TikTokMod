'use strict';
// End-to-end check of the fix, with the BROKEN ffmpeg deliberately present
// in vendor/bin — exactly the situation of the package the user was running.
//
// It resolves a live room and records it through live.start(), the same call
// the renderer's «Запись трансляции» button ends up in.

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const REPO = '/home/chumak/Документы/!OpencodeProject!/tiktok-mod';
const live = require(path.join(REPO, 'src/main/live.js'));
const settings = require(path.join(REPO, 'src/main/settings.js'));
const binaries = require(path.join(REPO, 'src/main/binaries.js'));

const outDir = '/tmp/e2e-recording';

function log(...a) { console.log('[e2e]', ...a); }

app.whenReady().then(async () => {
  // Point at the old package: its vendor/bin still holds the crashing ffmpeg.
  binaries.setResourcesRoot('/home/chumak/tiktok-mod-0.3.1-СТАРАЯ-ВЕРСИЯ/resources');
  const s = { ...settings.get(), downloadDir: outDir };
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

  log('ffmpeg chosen by the app:', binaries.ffmpeg());

  const res = await live.resolve('@grilltok46', s);
  if (!res || !res.ok) { log('resolve failed:', res && res.error); app.exit(1); return; }

  const result = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 40000);
    live.start('e2e_job', res.room, s, {
      onProgress: (p) => { if (p.elapsedSec % 10 === 0) log('  bytes=', p.downloaded); },
      onDone: (r) => { clearTimeout(t); resolve({ ok: true, r }); },
      onError: (m) => { clearTimeout(t); resolve({ ok: false, error: m }); },
    });
  });

  if (result.timeout) { log('TIMED OUT — no frames in 40s'); app.exit(2); return; }
  if (!result.ok) { log('FAILED:', result.error); app.exit(3); return; }

  log('RECORDED:', result.r.path, result.r.size + 'B');
  const file = path.join(outDir, 'live', '_stream.log');
  log('--- _stream.log ---');
  try { log(fs.readFileSync(file, 'utf8')); } catch (e) { log('not created:', e.message); }
  app.exit(result.r.size > 100000 ? 0 : 4);
});
