'use strict';
// Generates build/icon.png — the app icon electron-builder packages on Linux.
//
// The icon is produced from code rather than committed as an opaque binary so
// it can be re-tuned without a design tool: run `node scripts/make-icon.js`
// after changing a colour or a coordinate below.
//
// Dependency-free by design (zlib + a CRC table is all a PNG needs) so it runs
// in the same postinstall/build environment as the rest of the project.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024; // electron-builder downsamples; 1024 keeps every size crisp
const SS = 3; // supersampling factor, for antialiased edges

const BG = [0x0b, 0x0b, 0x0f];
const CYAN = [0x25, 0xf4, 0xee];
const MAGENTA = [0xfe, 0x2c, 0x55];
const WHITE = [0xff, 0xff, 0xff];

// ---------- geometry, in normalised 0..1 space ----------

// Rounded square filling the canvas; x/y/w/h/r in 0..1.
const CARD = { x: 0.04, y: 0.04, w: 0.92, h: 0.92, r: 0.22 };

// The note: a head ellipse plus a stem with a flag. Kept as plain signed
// distances so it can be evaluated per sample during supersampling.
// Proportions follow a beamed eighth note: a small head slung to the left of a
// slim stem, with a flag arcing right from the top.
const HEAD = { cx: 0.355, cy: 0.690, rx: 0.120, ry: 0.066, tilt: -0.32 };
const STEM = { x0: 0.448, x1: 0.490, y0: 0.250, y1: 0.665 };
// Flag as a thick quadratic arc sweeping from the stem top to the right.
const FLAG = { x0: 0.490, y0: 0.250, cx: 0.730, cy: 0.305, x1: 0.690, y1: 0.455, width: 0.042 };

function roundedRect(x, y, c) {
  const dx = Math.max(c.x - x, 0, x - (c.x + c.w));
  const dy = Math.max(c.y - y, 0, y - (c.y + c.h));
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy) - c.r;
  const qx = Math.max(c.x + c.r - x, 0, x - (c.x + c.w - c.r));
  const qy = Math.max(c.y + c.r - y, 0, y - (c.y + c.h - c.r));
  return Math.hypot(qx, qy) - c.r;
}

function ellipse(x, y, e) {
  const ct = Math.cos(e.tilt);
  const st = Math.sin(e.tilt);
  const rx = x - e.cx;
  const ry = y - e.cy;
  const u = (rx * ct + ry * st) / e.rx;
  const v = (-rx * st + ry * ct) / e.ry;
  return (Math.hypot(u, v) - 1) * Math.min(e.rx, e.ry);
}

function rect(x, y, r) {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}

// Distance to the flag's quadratic curve; negative inside the stroke.
function flag(x, y) {
  const f = FLAG;
  let best = Infinity;
  const STEPS = 48;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const mt = 1 - t;
    const px = mt * mt * f.x0 + 2 * mt * t * f.cx + t * t * f.x1;
    const py = mt * mt * f.y0 + 2 * mt * t * f.cy + t * t * f.y1;
    const d = Math.hypot(x - px, y - py);
    if (d < best) best = d;
  }
  return best - f.width / 2;
}

// Signed distance to the whole note, evaluated at an offset — the same shape
// drawn twice with a small offset is what makes the TikTok-style chromatic
// fringe.
function noteDistance(x, y, ox, oy) {
  const px = x - ox;
  const py = y - oy;
  return Math.min(ellipse(px, py, HEAD), rect(px, py, STEM), flag(px, py));
}

// ---------- rasteriser ----------

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const inv = 1 / (SIZE * SS);
  for (let py = 0; py < SIZE; py++) {
    for (let pxi = 0; pxi < SIZE; pxi++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxi * SS + sx + 0.5) * inv;
          const y = (py * SS + sy + 0.5) * inv;

          if (roundedRect(x, y, CARD) > 0) continue; // transparent outside

          let cr = BG[0];
          let cg = BG[1];
          let cb = BG[2];

          // Magenta and cyan fringe layers, then white on top.
          for (const [colour, ox, oy] of [
            [MAGENTA, -0.022, 0.022],
            [CYAN, 0.022, -0.022],
            [WHITE, 0, 0],
          ]) {
            if (noteDistance(x, y, ox, oy) <= 0) {
              cr = colour[0];
              cg = colour[1];
              cb = colour[2];
            }
          }

          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const total = SS * SS;
      const i = (py * SIZE + pxi) * 4;
      if (a === 0) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
      } else {
        px[i] = Math.round(r / (a / 255));
        px[i + 1] = Math.round(g / (a / 255));
        px[i + 2] = Math.round(b / (a / 255));
        px[i + 3] = Math.round(a / total);
      }
    }
  }
  return px;
}

// ---------- minimal PNG encoder ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba) {
  const stride = SIZE * 4;
  // One filter byte (0 = None) per scanline, as PNG requires.
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
const png = encodePng(render());
fs.writeFileSync(out, png);
console.log(`[icon] ${out} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB)`);