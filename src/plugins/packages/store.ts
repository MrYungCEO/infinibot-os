/**
 * On-disk layout for plugin packages (everything under the config dir, on one
 * filesystem so moves between these folders are atomic renames):
 *
 *   <configDir>/extensions/<id>/                  the installed version (loader scans this)
 *   <configDir>/plugin-packages/staging/<id>-*    extraction in progress
 *   <configDir>/plugin-packages/versions/<id>/*   the one previous version (rollback)
 *   <configDir>/plugin-packages/uploads/*         chunked uploads being received
 *   <configDir>/plugin-packages/updates.json      last update-check result (badge)
 *
 * Staging/versions live OUTSIDE extensions/ so a half-extracted or retired
 * version can never be discovered and loaded.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveConfigDir } from "../../utils.js";

export type PackagePaths = {
  extensionsDir: string;
  stateDir: string;
  stagingDir: string;
  versionsDir: string;
  uploadsDir: string;
  updatesFile: string;
};

/** `configDir` override is for tests; production always uses the real config dir. */
export function resolvePackagePaths(configDir: string = resolveConfigDir()): PackagePaths {
  const stateDir = path.join(configDir, "plugin-packages");
  return {
    extensionsDir: path.join(configDir, "extensions"),
    stateDir,
    stagingDir: path.join(stateDir, "staging"),
    versionsDir: path.join(stateDir, "versions"),
    uploadsDir: path.join(stateDir, "uploads"),
    updatesFile: path.join(stateDir, "updates.json"),
  };
}

export function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

// ── update-check cache ───────────────────────────────────────────────────

export type PluginUpdateInfo = {
  id: string;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  /** Why the newer version can't be installed here (host too old, payment…). */
  blocked?: string;
  minHostVersion?: string;
  sha256?: string;
  sizeBytes?: number;
  paid?: boolean;
  /** Changelog entries newer than the installed version, newest first. */
  changelog: { version: string; releasedAt?: string; notes: string }[];
  registryUrl: string;
  error?: string;
};

export type PluginUpdateState = {
  checkedAt: string | null;
  registryUrl: string | null;
  error?: string;
  plugins: Record<string, PluginUpdateInfo>;
  /** Auto-updates applied on disk that need a gateway restart to take effect. */
  pendingRestart?: Record<string, string>;
};

export function readUpdateState(paths = resolvePackagePaths()): PluginUpdateState {
  const v = readJsonFile<PluginUpdateState>(paths.updatesFile);
  if (v && typeof v === "object" && v.plugins && typeof v.plugins === "object") return v;
  return { checkedAt: null, registryUrl: null, plugins: {} };
}

export function writeUpdateState(state: PluginUpdateState, paths = resolvePackagePaths()): void {
  writeJsonFile(paths.updatesFile, state, 0o644);
}

/** Remove staging/upload leftovers older than `maxAgeMs` (crashed installs). */
export function sweepStaleStaging(
  paths = resolvePackagePaths(),
  maxAgeMs = 6 * 60 * 60_000,
): number {
  let removed = 0;
  for (const dir of [paths.stagingDir, paths.uploadsDir]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(abs).mtimeMs < maxAgeMs) continue;
        fs.rmSync(abs, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* best effort */
      }
    }
  }
  return removed;
}
