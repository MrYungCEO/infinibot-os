/**
 * `infinibot plugins pack` / `validate` — build and check plugin packages.
 *
 * Packing is DETERMINISTIC: the same folder contents always produce the same
 * bytes (and so the same sha256), whatever the machine, file mtimes or
 * directory order. Entries are sorted by path, stamped 1980-01-01 UTC with
 * mode 0644, stored as UNIX entries and deflated at a fixed level.
 */

import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

import { loadPluginManifest } from "../manifest.js";
import { listingAssetPaths } from "../listing.js";
import {
  PACKAGE_EXTENSION,
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST,
  resolvePackageEntries,
  validateDistributionManifest,
  type DistributionManifest,
} from "./format.js";
import { openPluginZip, PackageError, sha256OfBuffer, unsafeEntryReason } from "./zip-read.js";

/** Never packed, whatever the ignore file says. */
const ALWAYS_IGNORED_DIRS = new Set([".git", ".hg", ".svn", "node_modules/.cache"]);
const DEFAULT_IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", ".ibpluginignore"]);
/** Looks like a credential: refuse to ship it. */
const SECRET_FILE_RE =
  /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.keystore|\.npmrc)$/i;
const NATIVE_FILE_RE = /\.(node|so|dylib|dll|exe)$/i;
const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
export const PACKAGE_IGNORE_FILE = ".ibpluginignore";

export type PackFile = { path: string; abs: string; size: number };

export type PackOptions = {
  includeNodeModules?: boolean;
  /**
   * Extra ignore patterns (same syntax as `.ibpluginignore`), applied on top
   * of the plugin's own ignore file. The first-party packager passes its
   * build policy here (tests, build output, dotfiles) so every plugin folder
   * doesn't need a copy of the same ignore file.
   */
  ignore?: string;
  /** Leave out every file or folder whose name starts with a dot. */
  ignoreDotfiles?: boolean;
};

export type ValidationReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: DistributionManifest;
  files: number;
  unpackedBytes: number;
  /** Set when a zip was validated. */
  sha256?: string;
  zipBytes?: number;
};

/**
 * `.ibpluginignore`: one pattern per line, `#` comments. A pattern ending in
 * `/` ignores that folder; `*.ext` ignores by extension anywhere; anything
 * else matches a file or folder path exactly (relative to the plugin root) or
 * a bare name at any depth.
 */
export function parseIgnoreFile(text: string): (rel: string, isDir: boolean) => boolean {
  const patterns = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return (rel, isDir) => {
    const name = rel.split("/").pop() as string;
    for (const raw of patterns) {
      const dirOnly = raw.endsWith("/");
      const p = raw.replace(/^\.?\//, "").replace(/\/$/, "");
      if (dirOnly && !isDir) continue;
      if (p.startsWith("*.")) {
        if (!isDir && name.endsWith(p.slice(1))) return true;
        continue;
      }
      if (p === rel || (!p.includes("/") && p === name)) return true;
    }
    return false;
  };
}

/** Files a pack would include, sorted by path. Throws PackageError on a symlink. */
export function collectPackFiles(dir: string, opts: PackOptions = {}): PackFile[] {
  const root = path.resolve(dir);
  const ignoreFile = path.join(root, PACKAGE_IGNORE_FILE);
  const own = fs.existsSync(ignoreFile)
    ? parseIgnoreFile(fs.readFileSync(ignoreFile, "utf-8"))
    : () => false;
  const extra = opts.ignore ? parseIgnoreFile(opts.ignore) : () => false;
  const ignored = (rel: string, isDir: boolean) => {
    if (opts.ignoreDotfiles && (rel.split("/").pop() as string).startsWith(".")) return true;
    return own(rel, isDir) || extra(rel, isDir);
  };
  const out: PackFile[] = [];
  const walk = (abs: string, rel: string) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) {
        if (ignored(childRel, false) || ignored(childRel, true)) continue;
        throw new PackageError(`symlinks can't be packed: ${childRel}`, "symlink");
      }
      if (ent.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(childRel) || ALWAYS_IGNORED_DIRS.has(ent.name)) continue;
        if (ent.name === "node_modules" && !opts.includeNodeModules) continue;
        if (ignored(childRel, true)) continue;
        walk(childAbs, childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (DEFAULT_IGNORED_NAMES.has(ent.name)) continue;
      if (!rel && ent.name.endsWith(".zip")) continue; // earlier pack output
      if (ignored(childRel, false)) continue;
      out.push({ path: childRel, abs: childAbs, size: fs.statSync(childAbs).size });
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Shared file-level checks for a folder about to be packed. */
function checkFiles(files: PackFile[], errors: string[], warnings: string[]): number {
  let total = 0;
  for (const f of files) {
    const reason = unsafeEntryReason(f.path, PACKAGE_LIMITS);
    if (reason) errors.push(`${f.path}: ${reason}`);
    if (SECRET_FILE_RE.test(f.path)) {
      errors.push(`${f.path}: looks like a credential file — add it to ${PACKAGE_IGNORE_FILE}`);
    }
    if (NATIVE_FILE_RE.test(f.path)) {
      warnings.push(`${f.path}: native binary (works only on the platform it was built for)`);
    }
    if (f.size > PACKAGE_LIMITS.maxFileBytes)
      errors.push(`${f.path}: larger than the per-file limit`);
    total += f.size;
  }
  if (files.length > PACKAGE_LIMITS.maxFiles) errors.push(`too many files (${files.length})`);
  if (total > PACKAGE_LIMITS.maxUnpackedBytes)
    errors.push(`package is too large (${total} bytes unpacked)`);
  return total;
}

/** Validate a plugin FOLDER for distribution (what `pack` runs first). */
export function validatePluginDir(dir: string, opts: PackOptions = {}): ValidationReport {
  const root = path.resolve(dir);
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty = { files: 0, unpackedBytes: 0 };
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, errors: [`not a directory: ${root}`], warnings, ...empty };
  }
  const manifestPath = path.join(root, PACKAGE_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, errors: [`${PACKAGE_MANIFEST} not found in ${root}`], warnings, ...empty };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    return {
      ok: false,
      errors: [`${PACKAGE_MANIFEST} is not valid JSON: ${String(err)}`],
      warnings,
      ...empty,
    };
  }
  const dist = validateDistributionManifest(raw);
  warnings.push(...dist.warnings);
  if (!dist.ok) errors.push(...dist.errors);

  // The loader's own view (resolves contributes.learn files etc.).
  const loaded = loadPluginManifest(root);
  if (!loaded.ok && !errors.includes(loaded.error)) errors.push(loaded.error);

  let files: PackFile[] = [];
  try {
    files = collectPackFiles(root, opts);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const unpackedBytes = checkFiles(files, errors, warnings);
  const names = new Set(files.map((f) => f.path));

  const entries = resolvePackageEntries(readJson(path.join(root, "package.json")), (rel) =>
    names.has(rel),
  );
  if (typeof entries === "string") errors.push(entries);

  const pkg = readJson(path.join(root, "package.json")) as
    | { dependencies?: Record<string, string>; version?: string }
    | undefined;
  if (pkg?.dependencies && Object.keys(pkg.dependencies).length > 0 && !opts.includeNodeModules) {
    warnings.push(
      "package.json lists dependencies, but packages are installed without `npm install`: bundle them into your build, or pack with --include-node-modules",
    );
  }
  if (dist.ok && pkg?.version && pkg.version !== dist.manifest.version) {
    warnings.push(
      `package.json version (${pkg.version}) differs from the manifest (${dist.manifest.version})`,
    );
  }
  if (loaded.ok) {
    for (const asset of listingAssetPaths(loaded.manifest.listing)) {
      if (!names.has(asset)) errors.push(`listing asset "${asset}" is missing from the package`);
    }
    for (const agent of loaded.manifest.v2?.contributes.agents ?? []) {
      if (!names.has(agent))
        errors.push(`contributes.agents file "${agent}" is missing from the package`);
    }
  }
  if (!names.has("README.md"))
    warnings.push("no README.md (shown to reviewers and on the marketplace)");
  if (!names.has("CHANGELOG.md"))
    warnings.push("no CHANGELOG.md (shown to users when they update)");
  if (!names.has("LICENSE")) warnings.push("no LICENSE file");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(dist.ok ? { manifest: dist.manifest } : {}),
    files: files.length,
    unpackedBytes,
  };
}

/** Validate a package ZIP exactly as the installer would see it. */
export async function validatePluginZip(zipPath: string): Promise<ValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty = { files: 0, unpackedBytes: 0 };
  let buf: Buffer;
  try {
    const stat = fs.statSync(zipPath);
    if (stat.size > PACKAGE_LIMITS.maxZipBytes) {
      return {
        ok: false,
        errors: [`package is larger than ${PACKAGE_LIMITS.maxZipBytes} bytes`],
        warnings,
        ...empty,
      };
    }
    buf = fs.readFileSync(zipPath);
  } catch (err) {
    return { ok: false, errors: [`cannot read ${zipPath}: ${String(err)}`], warnings, ...empty };
  }
  try {
    const zip = await openPluginZip(buf);
    let raw: unknown;
    try {
      raw = JSON.parse((await zip.read(PACKAGE_MANIFEST)).toString("utf-8"));
    } catch (err) {
      errors.push(`${PACKAGE_MANIFEST} is not valid JSON: ${String(err)}`);
    }
    const dist = validateDistributionManifest(raw);
    warnings.push(...dist.warnings);
    if (!dist.ok) errors.push(...dist.errors);
    let pkg: unknown;
    if (zip.has("package.json")) {
      try {
        pkg = JSON.parse((await zip.read("package.json")).toString("utf-8"));
      } catch {
        errors.push("package.json is not valid JSON");
      }
    }
    const entries = resolvePackageEntries(pkg, (rel) => zip.has(rel));
    if (typeof entries === "string") errors.push(entries);
    for (const f of zip.files) {
      if (NATIVE_FILE_RE.test(f.path)) warnings.push(`${f.path}: native binary`);
    }
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      ...(dist.ok ? { manifest: dist.manifest } : {}),
      files: zip.files.length,
      unpackedBytes: zip.unpackedBytes,
      sha256: zip.sha256,
      zipBytes: zip.zipBytes,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      warnings,
      ...empty,
    };
  }
}

export type PackResult = {
  ok: true;
  file: string;
  sha256: string;
  sha256File: string;
  sizeBytes: number;
  files: number;
  manifest: DistributionManifest;
  warnings: string[];
};

/** Build the deterministic zip bytes for a set of files. */
export async function buildPackageZip(files: PackFile[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.path, fs.readFileSync(f.abs), {
      date: FIXED_DATE,
      unixPermissions: 0o644,
      createFolders: false,
      binary: true,
    });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
}

export type PackedBuffer = {
  ok: true;
  buffer: Buffer;
  sha256: string;
  sizeBytes: number;
  files: number;
  manifest: DistributionManifest;
  warnings: string[];
};

/**
 * Validate `dir` and build its package in memory (nothing is written). The
 * one packer: `infinibot plugins pack` and the first-party packager
 * (scripts/package-first-party-plugins.mjs) both go through here.
 */
export async function packPluginBuffer(
  dir: string,
  opts: PackOptions = {},
): Promise<PackedBuffer | { ok: false; errors: string[]; warnings: string[] }> {
  const report = validatePluginDir(dir, opts);
  if (!report.ok || !report.manifest) {
    return { ok: false, errors: report.errors, warnings: report.warnings };
  }
  const files = collectPackFiles(dir, opts);
  const buf = await buildPackageZip(files);
  if (buf.length > PACKAGE_LIMITS.maxZipBytes) {
    return {
      ok: false,
      errors: [`package is ${buf.length} bytes; the limit is ${PACKAGE_LIMITS.maxZipBytes}`],
      warnings: report.warnings,
    };
  }
  return {
    ok: true,
    buffer: buf,
    sha256: sha256OfBuffer(buf),
    sizeBytes: buf.length,
    files: files.length,
    manifest: report.manifest,
    warnings: report.warnings,
  };
}

/**
 * Validate `dir` and write `<id>-<version>.ibplugin.zip` plus a `.sha256`
 * sidecar. `out` may be a file path or a folder (default: the current folder).
 */
export async function packPluginDir(
  dir: string,
  opts: PackOptions & { out?: string; cwd?: string } = {},
): Promise<PackResult | { ok: false; errors: string[]; warnings: string[] }> {
  const packed = await packPluginBuffer(dir, opts);
  if (!packed.ok) return packed;
  const defaultName = `${packed.manifest.id}-${packed.manifest.version}${PACKAGE_EXTENSION}`;
  const cwd = opts.cwd ?? process.cwd();
  let file = opts.out ? path.resolve(cwd, opts.out) : path.join(cwd, defaultName);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, defaultName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, packed.buffer);
  const sha256File = `${file}.sha256`;
  fs.writeFileSync(sha256File, `${packed.sha256}  ${path.basename(file)}\n`);
  return {
    ok: true,
    file,
    sha256: packed.sha256,
    sha256File,
    sizeBytes: packed.sizeBytes,
    files: packed.files,
    manifest: packed.manifest,
    warnings: packed.warnings,
  };
}
