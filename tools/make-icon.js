'use strict';
// Draws the StoryCast icon (blue-purple tile, 3-part story ring, play button) and writes
// assets/icon.png (256 px) and assets/icon.ico (16–256 px). Run: node tools/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance to a rounded box centred at (cx, cy).
function box(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
function segment(x, y, ax, ay, bx, by, r) {
  const pax = x - ax; const pay = y - ay; const bax = bx - ax; const bay = by - ay;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * t, pay - bay * t) - r;
}

// Colour of one point in a 1x1 unit square, as [r, g, b, a] (0..1), by layering shapes.

// Signed distance to a triangle (a, b, c).
function triangle(x, y, a, b, c) {
  const d = Math.min(segment(x, y, a[0], a[1], b[0], b[1], 0), segment(x, y, b[0], b[1], c[0], c[1], 0), segment(x, y, c[0], c[1], a[0], a[1], 0));
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const P = [x, y];
  const d1 = s(P, a, b), d2 = s(P, b, c), d3 = s(P, c, a);
  const inside = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  return inside ? -d : d;
}
// Ring split into 3 arcs with gaps (like Telegram's story ring for several stories = several accounts).
function arcRing(x, y, cx, cy, r, w) {
  const ring = Math.abs(Math.hypot(x - cx, y - cy) - r) - w;
  let ang = Math.atan2(y - cy, x - cx) + Math.PI / 2;             // 0 at the top
  ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const seg = (2 * Math.PI) / 3, gap = 0.30;                        // radians of gap between arcs
  const into = ang % seg;
  const fromGap = Math.min(into - gap / 2, seg - gap / 2 - into);   // < 0 inside a gap
  const gapDist = fromGap < 0 ? -fromGap * r : 0;
  return Math.max(ring, gapDist > 0 ? gapDist : -Infinity) ;
}

// StoryCast: blue→purple tile, white 3-part story ring, white play button.
function shade(x, y, px) {
  const layers = [];
  const aa = (d) => Math.max(0, Math.min(1, 0.5 - d / px));
  const t = Math.max(0, Math.min(1, (x + y) / 2));                 // diagonal gradient
  const top = [0x2a / 255, 0xab / 255, 0xee / 255], bot = [0x7c / 255, 0x3a / 255, 0xed / 255];
  layers.push([aa(box(x, y, 0.5, 0.5, 0.46, 0.46, 0.22)), top.map((v, i) => v + (bot[i] - v) * t)]);
  layers.push([aa(arcRing(x, y, 0.5, 0.5, 0.29, 0.04)), [1, 1, 1]]);
  // play triangle, slightly right of centre so it looks centred
  const tri = triangle(x, y, [0.43, 0.36], [0.43, 0.64], [0.65, 0.5]) - 0.012;
  layers.push([aa(tri), [1, 1, 1]]);

  let r = 0, g = 0, b = 0, a = 0;
  for (const [alpha, c] of layers) {
    if (alpha <= 0) continue;
    r = c[0] * alpha + r * (1 - alpha);
    g = c[1] * alpha + g * (1 - alpha);
    b = c[2] * alpha + b * (1 - alpha);
    a = alpha + a * (1 - alpha);
  }
  return [r, g, b, a];
}
function render(size) {
  const ss = 4; // supersampling per axis
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [pr, pg, pb, pa] = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, 1 / size);
          r += pr; g += pg; b += pb; a += pa;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const A = a / n;
      buf[i] = A ? Math.round((r / n / A) * 255) : 0;
      buf[i + 1] = A ? Math.round((g / n / A) * 255) : 0;
      buf[i + 2] = A ? Math.round((b / n / A) * 255) : 0;
      buf[i + 3] = Math.round(A * 255);
    }
  }
  return png(size, buf);
}

function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.data)]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, data: render(size) }));
fs.writeFileSync(path.join(out, 'icon.png'), pngs[pngs.length - 1].data);
fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs));
console.log('wrote assets/icon.png and assets/icon.ico');
