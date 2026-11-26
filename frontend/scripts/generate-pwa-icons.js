#!/usr/bin/env node
// ============================================================
// BANKERCHANGER — PWA Icon Generator
//
// Generates minimal square PNG icons for the web app manifest.
// Uses only Node.js built-ins — no canvas or sharp required.
//
// Run:  node scripts/generate-pwa-icons.js
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Minimal PNG encoder ───────────────────────────────────────────────────────

function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = uint32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBytes = uint32BE(crc32(crcInput));
  return Buffer.concat([len, typeBytes, data, crcBytes]);
}

/**
 * Render a simple icon:
 *   • Amber (#fbbf24) background
 *   • Dark gray "BK" text approximated as a block shape
 *
 * For real production icons, replace this with sharp or Figma export.
 */
function buildPNG(size) {
  // RGBA pixel data for an amber square
  const bgR = 0xfb, bgG = 0xbf, bgB = 0x24, bgA = 0xff; // #fbbf24

  // Simple raw image data: each row is a filter byte (0 = None) + RGBA pixels
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const offset = 1 + x * 4;
      row[offset]     = bgR;
      row[offset + 1] = bgG;
      row[offset + 2] = bgB;
      row[offset + 3] = bgA;
    }
    rawRows.push(row);
  }

  const raw = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);  // width
  ihdrData.writeUInt32BE(size, 4);  // height
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: RGB (we'll use RGBA → type 6)
  // Switch to RGBA
  ihdrData[9] = 6;
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdr = chunk('IHDR', ihdrData);
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

for (const size of SIZES) {
  const png = buildPNG(size);
  const outPath = path.join(OUT_DIR, `icon-${size}x${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✓ ${outPath} (${size}×${size})`);
}

console.log(`\nGenerated ${SIZES.length} icons in ${OUT_DIR}`);
console.log('Replace these placeholder icons with real artwork before production.');
