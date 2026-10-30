/**
 * Plugin folder → zip, in the browser, so a folder dropped on the Plugins page
 * (or picked with "Import from folder") goes through the exact same upload +
 * review as a .zip. Stored (no compression): the gateway re-checks every entry
 * with its hardened reader, and plugin folders are small.
 *
 * Skips what never belongs in a package: node_modules, .git and OS junk.
 */

export type FolderFile = { path: string; data: Uint8Array };

const SKIP_DIR = /(^|\/)(node_modules|\.git|\.svn|\.hg|__pycache__)(\/|$)/;
const SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

export function keepPath(rel: string): boolean {
  return Boolean(rel) && !SKIP_DIR.test(rel) && !SKIP_FILE.test(rel);
}

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A plain stored zip (UTF-8 names). Exported for tests. */
export function zipFiles(files: FolderFile[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  // 1980-01-01 00:00 — fixed, so the same folder zips to the same bytes.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Files from `<input webkitdirectory>` (webkitRelativePath = "folder/…"). */
export async function filesFromDirectoryInput(list: FileList | File[]): Promise<{ name: string; files: FolderFile[] }> {
  const files: FolderFile[] = [];
  let name = "plugin";
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (!keepPath(rel)) continue;
    name = rel.split("/")[0] || name;
    files.push({ path: rel, data: new Uint8Array(await f.arrayBuffer()) });
  }
  return { name, files };
}

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: Entry[]) => void, err: (e: unknown) => void) => void };
};

async function walk(entry: Entry, out: FolderFile[]): Promise<void> {
  const rel = entry.fullPath.replace(/^\//, "");
  if (!keepPath(rel)) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ path: rel, data: new Uint8Array(await file.arrayBuffer()) });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns batches until an empty one.
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

/** A folder dropped on the page, or null when the drop is files only. */
export async function droppedFolder(dt: DataTransfer | null): Promise<{ name: string; files: FolderFile[] } | null> {
  const items = dt?.items ? Array.from(dt.items) : [];
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      const files: FolderFile[] = [];
      await walk(entry, files);
      return { name: entry.name, files };
    }
  }
  return null;
}
