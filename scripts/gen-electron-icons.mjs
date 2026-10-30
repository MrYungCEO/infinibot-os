/**
 * Generate electron/assets icons (icon.png, icon.ico, tray-icon.png) from
 * electron/assets/icon.svg using sharp. The .ico is hand-packed with
 * PNG-compressed entries (valid for Windows Vista+ and electron-builder).
 *
 * Usage: node scripts/gen-electron-icons.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'electron', 'assets');

const svg = await readFile(path.join(assets, 'icon.svg'));

async function png(size) {
  return sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();
}

function packIco(entries) {
  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes each) + PNG blobs
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(buf.length, o + 8); // data size
    dir.writeUInt32LE(offset, o + 12); // data offset
    offset += buf.length;
  });

  return Buffer.concat([header, dir, ...entries.map(e => e.buf)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = [];
for (const size of sizes) {
  entries.push({ size, buf: await png(size) });
}

await writeFile(path.join(assets, 'icon.ico'), packIco(entries));
await writeFile(path.join(assets, 'icon.png'), await png(512));
await writeFile(path.join(assets, 'tray-icon.png'), await png(22));

console.log('[gen-electron-icons] wrote icon.ico (7 sizes), icon.png (512), tray-icon.png (22)');
