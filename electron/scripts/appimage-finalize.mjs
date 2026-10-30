/**
 * Re-packs electron-builder's AppImage so it runs on a stock Ubuntu 24.04
 * (ported from Robovoice Desktop):
 *
 *   node scripts/appimage-finalize.mjs <out>/InfiniBot-x86_64.AppImage
 *
 * 1. Runtime. electron-builder 24/25 ship the old type-2 runtime (appimage-12.0.1),
 *    which dlopen()s libfuse.so.2 — not installed on Ubuntu 22.04+/24.04 →
 *    "AppImages require FUSE to run". It is swapped for the static runtime from
 *    AppImage/type2-runtime (pinned tag + sha256 below): libfuse3 is linked in,
 *    it only needs the fusermount/fusermount3 binary every desktop has, and
 *    with no FUSE at all it can still run via APPIMAGE_EXTRACT_AND_RUN=1.
 * 2. AppRun. Replaced by build/appimage/AppRun: probes the Chromium sandbox and
 *    adds --no-sandbox ONLY when neither the user-namespace sandbox nor the
 *    setuid helper can work (see the comments in that file).
 * 3. Desktop entry. electron-builder writes `Exec=AppRun --no-sandbox %U`
 *    unconditionally; it becomes `Exec=AppRun %U` so the probe decides.
 *
 * Needs unsquashfs + mksquashfs (squashfs-tools) on the build host.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync, createReadStream, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUNTIME = {
  tag: '20251108',
  url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
  sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
};

const input = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'InfiniBot-x86_64.AppImage'));
const work = path.join(path.dirname(input), '.appimage-work');

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}`);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function runtimeBinary() {
  const dir = path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'infinibot-appimage-runtime');
  const file = path.join(dir, `runtime-x86_64-${RUNTIME.tag}`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[appimage] downloading static runtime ${RUNTIME.tag}`);
    const res = await fetch(RUNTIME.url);
    if (!res.ok) throw new Error(`runtime download failed: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const buf = readFileSync(file);
  if (sha256(buf) !== RUNTIME.sha256) {
    rmSync(file, { force: true });
    throw new Error(`runtime sha256 mismatch for ${file} (deleted; re-run to download again)`);
  }
  return buf;
}

/** End of the ELF runtime = start of the squashfs image (section headers come last). */
function squashfsOffset(file) {
  const fd = openSync(file, 'r');
  try {
    const h = Buffer.alloc(64);
    readSync(fd, h, 0, 64, 0);
    if (h.readUInt32BE(0) !== 0x7f454c46 || h[4] !== 2) throw new Error(`${file}: not an ELF64 AppImage`);
    const off = Number(h.readBigUInt64LE(0x28)) + h.readUInt16LE(0x3a) * h.readUInt16LE(0x3c);
    const magic = Buffer.alloc(4);
    readSync(fd, magic, 0, 4, off);
    if (magic.toString('latin1') !== 'hsqs') throw new Error(`${file}: no squashfs at offset ${off}`);
    return off;
  } finally {
    closeSync(fd);
  }
}

const runtime = await runtimeBinary();
const offset = squashfsOffset(input);
console.log(`[appimage] ${path.basename(input)}: old runtime ${offset} B → static runtime ${runtime.length} B (${RUNTIME.tag})`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const appDir = path.join(work, 'AppDir');
sh('unsquashfs', ['-q', '-no-xattrs', '-o', String(offset), '-d', appDir, input]);

// AppRun with the sandbox probe.
copyFileSync(path.join(root, 'build', 'appimage', 'AppRun'), path.join(appDir, 'AppRun'));
chmodSync(path.join(appDir, 'AppRun'), 0o755);

// Desktop entry: no blanket --no-sandbox.
const desktop = path.join(appDir, 'infinibot-desktop.desktop');
const entry = readFileSync(desktop, 'utf8');
const fixed = entry.replace(/^Exec=.*$/m, 'Exec=AppRun %U');
if (!/^Icon=infinibot-desktop$/m.test(fixed) || !/^StartupWMClass=/m.test(fixed)) throw new Error('unexpected infinibot-desktop.desktop: ' + entry);
writeFileSync(desktop, fixed);
if (!existsSync(path.join(appDir, 'usr/share/icons/hicolor/512x512/apps/infinibot-desktop.png'))) throw new Error('icon missing from AppDir');

const help = spawnSync('mksquashfs', ['-help'], { encoding: 'utf8' });
const comp = /\bzstd\b/.test(`${help.stdout}${help.stderr}`) ? ['-comp', 'zstd', '-Xcompression-level', '19'] : ['-comp', 'gzip'];
const fsImage = path.join(work, 'fs.squashfs');
sh('mksquashfs', [appDir, fsImage, '-root-owned', '-noappend', '-no-xattrs', '-quiet', '-b', '1M', ...comp]);

const out = `${input}.new`;
writeFileSync(out, runtime);
await pipeline(createReadStream(fsImage), createWriteStream(out, { flags: 'a' }));
chmodSync(out, 0o755);
if (squashfsOffset(out) !== runtime.length) throw new Error('re-packed AppImage: squashfs offset mismatch');
rmSync(input);
sh('mv', [out, input]);
rmSync(work, { recursive: true, force: true });

// The blockmap describes the old bytes (electron-updater then just downloads
// the whole file). latest-linux.yml is the update feed: rewrite its sha512 and
// size for the re-packed AppImage so auto-update verification still passes.
rmSync(`${input}.blockmap`, { force: true });
const feed = path.join(path.dirname(input), 'latest-linux.yml');
if (existsSync(feed)) {
  const sha512 = createHash('sha512').update(readFileSync(input)).digest('base64');
  const size = statSync(input).size;
  // Only the AppImage's own entry (files[] item + top-level path/sha512);
  // other entries such as the .deb keep their hashes.
  const name = path.basename(input);
  const lines = readFileSync(feed, 'utf8').split('\n');
  let inEntry = false;
  const yml = lines
    .map((l) => {
      const url = l.match(/^\s*- url: (.+)$/);
      if (url) inEntry = url[1].trim() === name;
      else if (/^\S/.test(l)) inEntry = /^path: /.test(l) ? l.slice(6).trim() === name : inEntry && /^sha512: /.test(l);
      if (!inEntry) return l;
      if (/^\s*sha512: /.test(l)) return l.replace(/sha512: .*/, `sha512: ${sha512}`);
      if (/^\s*size: /.test(l)) return l.replace(/size: .*/, `size: ${size}`);
      if (/^\s*blockMapSize: /.test(l)) return null;
      return l;
    })
    .filter((l) => l !== null)
    .join('\n');
  writeFileSync(feed, yml);
  console.log(`[appimage] latest-linux.yml updated (sha512 ${sha512.slice(0, 16)}…, ${size} B)`);
}

console.log(`[appimage] done: ${input} (${statSync(input).size} B, ${comp[1]})`);
