/**
 * Hardened reader for plugin package zips.
 *
 * `openPluginZip` checks the whole archive BEFORE a single byte is written:
 *  - size, entry-count and declared-size caps (zip bombs), ZIP64 refused;
 *  - every entry name on its ORIGINAL bytes (JSZip normalises names, which
 *    would hide a traversal): no absolute paths, drive letters, backslashes,
 *    `..`/`.` segments, control characters, over-long or over-deep paths;
 *  - no symlinks or other special files, no duplicate / case-colliding paths;
 *  - the manifest sits at the root or inside exactly one top-level folder.
 * `extractTo` then streams each file with a running byte count, so an entry
 * that lies about its size is cut off at the cap instead of filling the disk.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

import { PACKAGE_LIMITS, PACKAGE_MANIFEST, type PackageLimits } from "./format.js";

export class PackageError extends Error {
  constructor(
    message: string,
    readonly code:
      | "too-large"
      | "bad-zip"
      | "unsafe-path"
      | "symlink"
      | "layout"
      | "manifest"
      | "checksum"
      | "collision"
      | "policy"
      | "host"
      | "permissions"
      | "payment"
      | "network" = "bad-zip",
  ) {
    super(message);
    this.name = "PackageError";
  }
}

export type ZipFileEntry = {
  /** Path inside the package (root prefix stripped, forward slashes). */
  path: string;
  /** Declared uncompressed size. */
  size: number;
};

export type OpenedPluginZip = {
  sha256: string;
  zipBytes: number;
  /** Top-level folder the package was wrapped in, or "" when at the root. */
  rootPrefix: string;
  files: ZipFileEntry[];
  unpackedBytes: number;
  has(rel: string): boolean;
  /** Read one file fully (bounded). */
  read(rel: string, maxBytes?: number): Promise<Buffer>;
  /** Extract every file into `destDir` (must be empty). Returns bytes written. */
  extractTo(destDir: string): Promise<number>;
};

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Junk that archivers add; ignored rather than failing the layout check. */
function isArchiverJunk(name: string): boolean {
  return (
    name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name) || /(^|\/)Thumbs\.db$/.test(name)
  );
}

/** Null when the entry name is safe; otherwise why it is not. */
export function unsafeEntryReason(name: string, limits: PackageLimits): string | null {
  if (!name) return "empty name";
  if (name.length > limits.maxPathLength) return "path too long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control character in path";
  if (name.includes("\\")) return "backslash in path";
  if (name.startsWith("/")) return "absolute path";
  if (/^[a-zA-Z]:/.test(name)) return "drive-letter path";
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.length > limits.maxPathDepth) return "path too deep";
  for (const s of segments) {
    if (s === "") return "empty path segment";
    if (s === "." || s === "..") return "relative path segment";
  }
  return null;
}

/** Entry count from the End Of Central Directory record (before parsing). */
function readEntryCount(buf: Buffer): number {
  const min = 22;
  if (buf.length < min) throw new PackageError("not a zip archive");
  const stop = Math.max(0, buf.length - min - 0xffff);
  for (let i = buf.length - min; i >= stop; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const total = buf.readUInt16LE(i + 10);
    const cdSize = buf.readUInt32LE(i + 12);
    const cdOffset = buf.readUInt32LE(i + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new PackageError("ZIP64 archives are not supported", "too-large");
    }
    return total;
  }
  throw new PackageError("not a zip archive (no end-of-central-directory record)");
}

type RawEntry = { name: string; dir: boolean; size: number; object: JSZip.JSZipObject };

export async function openPluginZip(
  input: Buffer,
  limitOverrides: Partial<PackageLimits> = {},
): Promise<OpenedPluginZip> {
  const limits: PackageLimits = { ...PACKAGE_LIMITS, ...limitOverrides };
  if (input.length > limits.maxZipBytes) {
    throw new PackageError(
      `package is ${input.length} bytes; the limit is ${limits.maxZipBytes}`,
      "too-large",
    );
  }
  const declaredCount = readEntryCount(input);
  if (declaredCount > limits.maxFiles * 2) {
    throw new PackageError(
      `package has ${declaredCount} entries; the limit is ${limits.maxFiles}`,
      "too-large",
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input, { createFolders: false });
  } catch (err) {
    throw new PackageError(
      `could not read zip: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const raw: RawEntry[] = [];
  for (const object of Object.values(zip.files)) {
    // JSZip rewrites unsafe names; judge the name the archive actually holds.
    const original = (object as { unsafeOriginalName?: string }).unsafeOriginalName ?? object.name;
    const reason = unsafeEntryReason(original, limits);
    if (reason) throw new PackageError(`unsafe entry "${original}": ${reason}`, "unsafe-path");
    if (isArchiverJunk(original)) continue;
    const mode = typeof object.unixPermissions === "number" ? object.unixPermissions : null;
    if (mode !== null && (mode & S_IFMT) !== 0) {
      const type = mode & S_IFMT;
      if (type !== S_IFREG && type !== S_IFDIR) {
        throw new PackageError(
          type === 0o120000
            ? `symlinks are not allowed in a package: "${original}"`
            : `special files are not allowed in a package: "${original}"`,
          "symlink",
        );
      }
    }
    const size = Number(
      (object as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
    );
    raw.push({ name: original, dir: object.dir, size: Number.isFinite(size) ? size : 0, object });
  }

  const fileEntries = raw.filter((e) => !e.dir);
  if (fileEntries.length === 0) throw new PackageError("package is empty", "layout");
  if (fileEntries.length > limits.maxFiles) {
    throw new PackageError(
      `package has ${fileEntries.length} files; the limit is ${limits.maxFiles}`,
      "too-large",
    );
  }

  // Layout: manifest at the root, or inside exactly one top-level folder.
  let rootPrefix = "";
  if (!fileEntries.some((e) => e.name === PACKAGE_MANIFEST)) {
    const tops = new Set(raw.map((e) => e.name.split("/")[0] as string));
    const loose = fileEntries.some((e) => !e.name.includes("/"));
    if (tops.size !== 1 || loose) {
      throw new PackageError(
        `${PACKAGE_MANIFEST} must be at the zip root or inside exactly one top-level folder`,
        "layout",
      );
    }
    rootPrefix = `${[...tops][0]}/`;
    if (!fileEntries.some((e) => e.name === `${rootPrefix}${PACKAGE_MANIFEST}`)) {
      throw new PackageError(`package has no ${PACKAGE_MANIFEST}`, "layout");
    }
  }

  const byPath = new Map<string, RawEntry>();
  const lower = new Set<string>();
  let unpackedBytes = 0;
  for (const e of fileEntries) {
    const rel = e.name.slice(rootPrefix.length);
    const key = rel.toLowerCase();
    if (lower.has(key)) {
      throw new PackageError(`duplicate or case-colliding entry "${rel}"`, "unsafe-path");
    }
    lower.add(key);
    if (e.size > limits.maxFileBytes) {
      throw new PackageError(
        `"${rel}" is ${e.size} bytes; the per-file limit is ${limits.maxFileBytes}`,
        "too-large",
      );
    }
    unpackedBytes += e.size;
    if (unpackedBytes > limits.maxUnpackedBytes) {
      throw new PackageError(
        `package unpacks to more than ${limits.maxUnpackedBytes} bytes`,
        "too-large",
      );
    }
    byPath.set(rel, e);
  }
  // A file can't also be a folder of another file (a/b and a/b/c).
  for (const rel of byPath.keys()) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (lower.has(parts.slice(0, i).join("/").toLowerCase())) {
        throw new PackageError(`entry "${rel}" nests under a file`, "unsafe-path");
      }
    }
  }
  if (
    unpackedBytes > 1024 * 1024 &&
    unpackedBytes / Math.max(1, input.length) > limits.maxCompressionRatio
  ) {
    throw new PackageError("package compression ratio is implausible (zip bomb?)", "too-large");
  }

  /** Stream one entry, failing as soon as it exceeds `cap` bytes. */
  const pump = (entry: RawEntry, cap: number, sink: (chunk: Buffer) => void): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      let seen = 0;
      let done = false;
      const stream = entry.object.nodeStream("nodebuffer");
      const fail = (err: Error) => {
        if (done) return;
        done = true;
        (stream as unknown as { destroy?: () => void }).destroy?.();
        reject(err);
      };
      stream.on("data", (chunk: Buffer) => {
        if (done) return;
        seen += chunk.length;
        if (seen > cap) {
          fail(
            new PackageError(
              `"${entry.name}" unpacks past its size limit (zip bomb?)`,
              "too-large",
            ),
          );
          return;
        }
        try {
          sink(chunk);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });
      stream.on("error", (err: Error) =>
        fail(new PackageError(`corrupt entry "${entry.name}": ${err.message}`)),
      );
      stream.on("end", () => {
        if (done) return;
        done = true;
        resolve(seen);
      });
    });

  return {
    sha256: createHash("sha256").update(input).digest("hex"),
    zipBytes: input.length,
    rootPrefix,
    files: [...byPath.entries()]
      .map(([p, e]) => ({ path: p, size: e.size }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    unpackedBytes,
    has: (rel) => byPath.has(rel),
    async read(rel, maxBytes = limits.maxManifestBytes) {
      const entry = byPath.get(rel);
      if (!entry) throw new PackageError(`"${rel}" is not in the package`, "layout");
      const chunks: Buffer[] = [];
      await pump(entry, maxBytes, (c) => chunks.push(c));
      return Buffer.concat(chunks);
    },
    async extractTo(destDir) {
      const root = path.resolve(destDir);
      fs.mkdirSync(root, { recursive: true, mode: 0o755 });
      if (fs.readdirSync(root).length > 0) {
        throw new PackageError("extract target is not empty", "layout");
      }
      let written = 0;
      for (const [rel, entry] of byPath) {
        const out = path.resolve(root, ...rel.split("/"));
        // Belt and braces: names were validated above, re-check the result.
        if (out !== root && !out.startsWith(root + path.sep)) {
          throw new PackageError(`entry "${rel}" escapes the package folder`, "unsafe-path");
        }
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o755 });
        // "wx": never follow or overwrite anything already there.
        const fd = fs.openSync(out, "wx", 0o644);
        try {
          // The declared size is the cap: an entry that inflates past what it
          // declared is cut off (and the declared sizes were budgeted above).
          written += await pump(entry, entry.size, (chunk) => {
            fs.writeSync(fd, chunk);
          });
        } finally {
          fs.closeSync(fd);
        }
        if (written > limits.maxUnpackedBytes) {
          throw new PackageError(
            `package unpacks to more than ${limits.maxUnpackedBytes} bytes`,
            "too-large",
          );
        }
      }
      return written;
    },
  };
}

export function sha256OfBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Lowercase hex sha256, tolerant of a `sha256:` prefix and surrounding space. */
export function normalizeSha256(value: string | undefined | null): string | null {
  if (!value) return null;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/^sha256[:=-]/, "");
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}
