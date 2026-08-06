#!/usr/bin/env node
// Generate fixture PNGs + fixtures/figma-file.json so the whole pipeline runs
// with zero credentials and zero committed binaries. Each PNG is a solid color
// with a darker band whose position varies by index, so 16 frames are visually
// distinct when Claude does its QA pass.
//
// Usage: node scripts/make-fixtures.mjs [count]   (default 16)

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadConfig } from "../lib/config.mjs";

const W = 800;
const H = 600;

// --- minimal PNG writer (truecolor, 8-bit) ---

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
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makePng(rgbFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // raw scanlines: filter byte 0 + W*3 bytes
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgbFn(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- fixture generation ---

const count = Number(process.argv[2]) || 16;
const cfg = loadConfig();
const framesDir = path.join(cfg.abs.fixtures_dir, "frames");
mkdirSync(framesDir, { recursive: true });

const frames = [];
for (let i = 0; i < count; i++) {
  const name = `frame-${String(i + 1).padStart(2, "0")}`;
  const hue = (i * 137) % 360; // golden-angle spacing, visually distinct
  const base = hslToRgb(hue, 0.55, 0.6);
  const band = hslToRgb(hue, 0.7, 0.35);
  const bandY = 60 + ((i * 33) % (H - 180));
  const png = makePng((x, y) => (y >= bandY && y < bandY + 60 ? band : base));
  writeFileSync(path.join(framesDir, `${name}.png`), png);
  frames.push({ id: `1:${100 + i}`, name, type: "FRAME" });
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255);
  };
  return [f(0), f(8), f(4)];
}

// Canned frame tree in the exact shape lib/figma.mjs parses.
const fileJson = {
  name: "FIXTURE — worksnap cleared frames",
  document: {
    children: [
      {
        name: "Page 1",
        type: "CANVAS",
        children: frames,
      },
    ],
  },
};
writeFileSync(path.join(cfg.abs.fixtures_dir, "figma-file.json"), JSON.stringify(fileJson, null, 2) + "\n");

console.log(`wrote ${count} PNGs to ${framesDir} and figma-file.json`);
