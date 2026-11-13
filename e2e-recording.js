'use strict';
// End-to-end check of the fix, with the BROKEN ffmpeg deliberately present
// in vendor/bin — exactly the situation of the package the user was running.
//
// It resolves a live room and records it through live.start(), the same call
// the renderer's «Запись трансляции» button ends up in.
//
// Usage:
//   npx electron e2e-recording.js [@handle] [resourcesRoot]
//
// `resourcesRoot` points binaries.js at another package's resources (the old
// build whose vendor/bin still holds the crashing ffmpeg). Without it the
// repository's own binaries are used.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const REPO = __dirname;
const live = require(path.join(REPO, 'src/main/live.js'));
const settings = require(path.join(REPO, 'src/main/settings.js'));
const binaries = require(path.join(REPO, 'src/main/binaries.js'));

const handle = process.argv[2] || '@grilltok46';
const resourcesRoot = process.argv[3] || '';
const outDir = path.join(os.tmpdir(), 'tiktok-mod-e2e');

// Stop after this many bytes: a live recording has no end of its own, so
// without a stop condition live.start() never reaches onDone and every run
// ended with the 40s timeout.
const STOP_AFTER_BYTES = 2 * 1024 * 1024;

const log = (...a) => console.log('[e2e]', ...a);

app.whenReady().then(async () => {
  if (resourcesRoot) binaries.setResourcesRoot(resourcesRoot);
  const s = { ...settings.get(), downloadDir: outDir };
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {}

  log('ffmpeg chosen by the app:', binaries.ffmpeg());

  const res = await live.resolve(handle, s);
  if (!res || !res.ok) {
    log('resolve failed:', res && res.error);
    app.exit(1);
    return;
  }

  const result = await new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      live.stop('e2e_job', 'e2e');
    };
    const t = setTimeout(() => resolve({ timeout: true }), 40000);
    live.start('e2e_job', res.room, s, {
      onProgress: (p) => {
        if (p.elapsedSec % 10 === 0) log('  bytes=', p.downloaded);
        if (p.downloaded >= STOP_AFTER_BYTES) {
          log('  reached', p.downloaded, 'bytes — stopping');
          stop();
        }
      },
      onDone: (r) => {
        clearTimeout(t);
        resolve({ ok: true, r });
      },
      onError: (m) => {
        clearTimeout(t);
        resolve({ ok: false, error: m });
      },
    });
  });

  if (result.timeout) {
    log('TIMED OUT — no frames in 40s');
    // The recording is still running: stop it so ffmpeg does not outlive the
    // app and keep appending to the mp4.
    live.stop('e2e_job', 'e2e-timeout');
    setTimeout(() => app.exit(2), 500);
    return;
  }
  if (!result.ok) {
    log('FAILED:', result.error);
    app.exit(3);
    return;
  }

  log('RECORDED:', result.r.path, result.r.size + 'B');
  const file = path.join(outDir, 'live', '_stream.log');
  log('--- _stream.log ---');
  try {
    log(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('not created:', e.message);
  }
  app.exit(result.r.size > 100000 ? 0 : 4);
});