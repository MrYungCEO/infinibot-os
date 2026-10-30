/**
 * Where the InfiniBot Browser Relay Chrome extension lives on disk.
 *
 * The extension ships in `assets/chrome-extension/` next to `dist/`. That is
 * the repo root in a checkout, the package root in an npm install, and
 * `resources/app/` in the packaged desktop app. The desktop app runs the
 * gateway with its cwd set to the state dir, so nothing here may depend on
 * `process.cwd()` alone (that is how the desktop app ended up saying the
 * extension was "not found in the repo").
 *
 * Chrome's "Load unpacked" keeps pointing at whatever folder the user picked,
 * and the install dir of the desktop app is read-only and moves on every
 * update. So the bundled copy is mirrored into a stable, user-writable folder
 * (`<state dir>/browser/chrome-extension`) and that is the path we hand out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STATE_DIR, resolveRepoRoot } from "../config/paths.js";

export const EXTENSION_ASSET_DIR = path.join("assets", "chrome-extension");
export const EXTENSION_ZIP_NAME = "infinibot-browser-relay.zip";

export type ExtensionManifestInfo = { name?: string; version?: string };

export function readExtensionManifest(dir: string): ExtensionManifestInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")) as {
      name?: unknown;
      version?: unknown;
      manifest_version?: unknown;
    };
    if (raw.manifest_version !== 3) return null;
    return {
      name: typeof raw.name === "string" ? raw.name : undefined,
      version: typeof raw.version === "string" ? raw.version : undefined,
    };
  } catch {
    return null;
  }
}

/** Ordered, de-duplicated list of places the bundled extension may be. */
export function bundledExtensionCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const add = (dir: string | undefined | null) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (!out.includes(abs)) out.push(abs);
  };
  add(env.INFINIBOT_BROWSER_EXTENSION_DIR?.trim());
  // Packaged desktop app: the Electron launcher sets INFINIBOT_REPO_ROOT to
  // resources/app before the gateway starts.
  add(path.join(resolveRepoRoot(env), EXTENSION_ASSET_DIR));
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) add(path.join(resourcesPath, "app", EXTENSION_ASSET_DIR));
  // Walk up from this module: src/browser/ in dev, dist/ (flattened chunks)
  // in builds, node_modules/infinibot/dist/ in npm installs.
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      add(path.join(dir, EXTENSION_ASSET_DIR));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* non-file module URL */
  }
  const cwd = process.cwd();
  add(path.join(cwd, EXTENSION_ASSET_DIR));
  add(path.join(cwd, "..", EXTENSION_ASSET_DIR));
  add(path.join(cwd, "..", "..", EXTENSION_ASSET_DIR));
  return out;
}

/** The read-only copy that ships with this install, or null. */
export function resolveBundledExtensionDir(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of bundledExtensionCandidates(env)) {
    if (readExtensionManifest(dir)) return dir;
  }
  return null;
}

/** Zipped copy built next to the bundled folder at release time, if present. */
export function resolveBundledExtensionZip(bundledDir: string | null): string | null {
  if (!bundledDir) return null;
  const zip = path.join(path.dirname(bundledDir), EXTENSION_ZIP_NAME);
  return fs.existsSync(zip) ? zip : null;
}

/**
 * Legacy hidden location (`<state dir>/browser/chrome-extension`). Dot folders
 * (`~/.infinibot`) and AppData/Library are invisible in Chrome's folder picker,
 * so this is only kept in sync for existing installs; users are pointed at
 * {@link visibleExtensionDir} instead.
 */
export function installedExtensionDir(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, "browser", "chrome-extension");
}

/**
 * User-visible folder for Chrome's "Load unpacked":
 * Linux `~/InfiniBot/browser-extension`, macOS `~/InfiniBot/Browser Extension`,
 * Windows `%USERPROFILE%\Documents\InfiniBot\browser-extension`.
 * `INFINIBOT_BROWSER_EXTENSION_VISIBLE_DIR` overrides it.
 */
export function visibleExtensionDir(opts?: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = opts?.env ?? process.env;
  const override = env.INFINIBOT_BROWSER_EXTENSION_VISIBLE_DIR?.trim();
  if (override) return path.resolve(override);
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? env.USERPROFILE?.trim() ?? os.homedir();
  if (platform === "win32") {
    return path.win32.join(home, "Documents", "InfiniBot", "browser-extension");
  }
  if (platform === "darwin") return path.posix.join(home, "InfiniBot", "Browser Extension");
  return path.posix.join(home, "InfiniBot", "browser-extension");
}

/** Optional "Install from Chrome Web Store" listing; becomes the primary option once set. */
export function chromeWebStoreUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.INFINIBOT_CHROME_WEBSTORE_URL?.trim() || undefined;
}

export type InstalledExtension = {
  /** Folder to give "Load unpacked" (the visible copy when there is one). */
  path: string;
  version?: string;
  /** True when this call (re)wrote any folder. */
  copied: boolean;
  /** Hidden legacy copy, when it still exists. */
  legacyPath?: string;
};

function sameManifest(a: string, b: string): boolean {
  try {
    return (
      fs.readFileSync(path.join(a, "manifest.json"), "utf-8") ===
      fs.readFileSync(path.join(b, "manifest.json"), "utf-8")
    );
  } catch {
    return false;
  }
}

function mirrorDir(src: string, dest: string, force?: boolean): boolean {
  if (!force && readExtensionManifest(dest) && sameManifest(src, dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Copy beside the target, then swap, so a failed copy never leaves Chrome
  // pointing at a half-written folder.
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.cpSync(src, tmp, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  if (!readExtensionManifest(dest)) {
    throw new Error("Browser extension install failed (manifest.json missing).");
  }
  return true;
}

/**
 * Mirror the bundled extension into the visible folder (primary) and, for
 * existing installs, the hidden legacy folder. Copies when a folder is missing,
 * when its manifest differs from the source (app update), or when `force` is
 * set. A legacy-only install is migrated by copying. Returns null when there is
 * nothing to install and nothing installed already.
 *
 * `visibleDir: null` disables the visible copy; when `stateDir` is passed
 * without `visibleDir`, only the legacy folder is used (keeps tests hermetic).
 */
export function ensureInstalledExtension(opts?: {
  stateDir?: string;
  visibleDir?: string | null;
  sourceDir?: string | null;
  force?: boolean;
}): InstalledExtension | null {
  const legacy = installedExtensionDir(opts?.stateDir);
  const visible =
    opts?.visibleDir !== undefined
      ? opts.visibleDir
      : opts?.stateDir
        ? null
        : visibleExtensionDir();
  const bundled = opts?.sourceDir === undefined ? resolveBundledExtensionDir() : opts.sourceDir;
  // Source of truth: bundled copy, else an existing install (migration).
  const src = [bundled, legacy, visible].find(
    (d): d is string => !!d && !!readExtensionManifest(d),
  );
  const primary = visible ?? legacy;
  if (!src) return null;
  let copied = false;
  const legacyExists = !!readExtensionManifest(legacy);
  if (visible) copied = mirrorDir(src, visible, opts?.force && src !== visible) || copied;
  // Keep the old hidden path working for existing installs (and when it is
  // the only location).
  if (!visible || legacyExists) {
    if (src !== legacy) copied = mirrorDir(src, legacy, opts?.force) || copied;
  }
  const after = readExtensionManifest(primary);
  if (!after) throw new Error("Browser extension install failed (manifest.json missing).");
  return {
    path: primary,
    version: after.version,
    copied,
    legacyPath: readExtensionManifest(legacy) ? legacy : undefined,
  };
}
