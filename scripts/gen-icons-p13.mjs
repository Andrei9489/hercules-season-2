/**
 * Faza 13 — Generator iconițe PWA pentru StreamVerse
 * Replică designul logo.svg (pătrat rotunjit #2D2D2D + „Z” alb) pe fundal #0a0a0f.
 * PNG encoder pur (zlib + CRC32), supersampling 3x pentru margini netede.
 * Output: public/icon-192.png, public/icon-512.png, public/icon-maskable-512.png,
 *         public/apple-touch-icon.png (180)
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public");

// ---------- PNG encoder (RGBA, filter 0) ----------
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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines cu filter byte 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- rasterizare ----------
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function blend(dst, src, a) {
  return [
    dst[0] + (src[0] - dst[0]) * a,
    dst[1] + (src[1] - dst[1]) * a,
    dst[2] + (src[2] - dst[2]) * a,
  ];
}

/** punct în poligon (ray casting, cu margini inclusive) */
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Desenează iconul la rezoluție s (supersampling intern 3x).
 * Layout în coordonate viewBox 30x30 din logo.svg:
 *  - card rotunjit 1.49..28.51, r=4, fill #2D2D2D, contur alb 0.63
 *  - „Z” alb: bară sus + diagonală + bară jos (poligoane din SVG)
 */
function render(size, { maskable = false } = {}) {
  const SS = 3;
  const S = size * SS;
  const bg = hex("#0a0a0f");
  const card = hex("#2d2d2d");
  const white = [255, 255, 255];

  // la maskable, zona sigură: conținut ≤ 80% din lățime → micșoram cardul
  const pad = maskable ? 4.6 : 1.49; // în unități viewBox (0..30)
  const r = maskable ? 3.2 : 4;
  const strokeW = maskable ? 0.5 : 0.6317;

  // scala Z: la maskable micșorăm marca spre centrul sigur
  const zScale = maskable ? 0.72 : 1.0;
  const cx = 15,
    cy = 15;
  const sz = (p) => [cx + (p[0] - cx) * zScale, cy + (p[1] - cy) * zScale];

  const topBar = [sz([15.47, 7.1]), sz([13.3, 9.42]), sz([6.17, 9.42]), sz([6.17, 7.09])];
  const diag = [sz([24.3, 7.1]), sz([16.86, 7.1]), sz([5.7, 22.91]), sz([13.14, 22.91])];
  const botBar = [sz([14.53, 22.91]), sz([15.84, 21.05]), sz([22.93, 21.05]), sz([22.93, 22.91])];

  const img = Buffer.alloc(S * S * 4);
  const vb = 30; // viewBox 0..30 → pixeli
  const k = S / vb;

  /** distanța la rect-ul miezului [m, 30−m] (SDF exact) */
  const distCore = (px, py, m) => {
    const nx = Math.min(Math.max(px, m), 30 - m);
    const ny = Math.min(Math.max(py, m), 30 - m);
    return Math.hypot(px - nx, py - ny);
  };

  for (let y = 0; y < S; y++) {
    const vy = (y + 0.5) / k; // coordonată viewBox
    for (let x = 0; x < S; x++) {
      const vx = (x + 0.5) / k;
      let c = bg;

      // cardul rotunjit: boundary la distanța r de miez; stroke alb = bandă r±half
      const core = pad + r; // miezul cardului
      const d = distCore(vx, vy, core);
      if (d <= r - strokeW / 2) c = card; // umplere
      else if (d <= r + strokeW / 2) c = white; // contur (stroke centrat)

      // „Z”
      if (inPoly(vx, vy, topBar) || inPoly(vx, vy, diag) || inPoly(vx, vy, botBar)) c = white;

      const o = (y * S + x) * 4;
      img[o] = Math.round(c[0]);
      img[o + 1] = Math.round(c[1]);
      img[o + 2] = Math.round(c[2]);
      img[o + 3] = 255;
    }
  }

  // box-downsample 3x → 1x
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rS = 0,
        gS = 0,
        bS = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const o = ((y * SS + dy) * S + x * SS + dx) * 4;
          rS += img[o];
          gS += img[o + 1];
          bS += img[o + 2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(rS / n);
      out[o + 1] = Math.round(gS / n);
      out[o + 2] = Math.round(bS / n);
      out[o + 3] = 255;
    }
  }
  return encodePNG(size, size, out);
}

const targets = [
  { file: "icon-192.png", size: 192, opts: {} },
  { file: "icon-512.png", size: 512, opts: {} },
  { file: "icon-maskable-512.png", size: 512, opts: { maskable: true } },
  { file: "apple-touch-icon.png", size: 180, opts: {} },
];
for (const t of targets) {
  const png = render(t.size, t.opts);
  fs.writeFileSync(path.join(OUT, t.file), png);
  console.log(`OK ${t.file} (${png.length} bytes)`);
}
console.log("Iconițe PWA generate.");
