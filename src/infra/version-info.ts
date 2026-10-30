/**
 * Version Info Module
 *
 * Provides system version information including:
 * - Package version from package.json
 * - Git commit and branch info
 * - Build time
 * - System info (platform, arch, hostname)
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveInfiniBotPackageRoot } from "./infinibot-root.js";
import { runCommandWithTimeout } from "../process/exec.js";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface VersionInfo {
  version: string;
  buildTime: string | null;
  gitCommit: string | null;
  gitBranch: string | null;
  nodeVersion: string;
  platform: string;
  arch: string;
  hostname: string;
  uptime: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Version Info Cache
// ══════════════════════════════════════════════════════════════════════════════

let cachedVersionInfo: VersionInfo | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get local version info with caching
 */
export async function getLocalVersionInfo(): Promise<VersionInfo> {
  const now = Date.now();
  if (cachedVersionInfo && now - cacheTimestamp < CACHE_TTL_MS) {
    return { ...cachedVersionInfo, uptime: process.uptime() };
  }

  const root = await resolveInfiniBotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  let version = "unknown";
  let buildTime: string | null = null;

  // Read version from package.json
  if (root) {
    try {
      const pkgPath = path.join(root, "package.json");
      const pkgRaw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      if (pkg.version) version = pkg.version;
    } catch {
      // ignore
    }

    // Try to get build time from dist stat
    try {
      const distPath = path.join(root, "dist", "index.js");
      const stat = await fs.stat(distPath);
      buildTime = stat.mtime.toISOString();
    } catch {
      // ignore
    }
  }

  // Get git info
  let gitCommit: string | null = null;
  let gitBranch: string | null = null;

  if (root) {
    try {
      const shaResult = await runCommandWithTimeout(
        ["git", "-C", root, "rev-parse", "--short", "HEAD"],
        { timeoutMs: 5000 }
      );
      if (shaResult.code === 0) {
        gitCommit = shaResult.stdout.trim() || null;
      }
    } catch {
      // ignore
    }

    try {
      const branchResult = await runCommandWithTimeout(
        ["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeoutMs: 5000 }
      );
      if (branchResult.code === 0) {
        gitBranch = branchResult.stdout.trim() || null;
      }
    } catch {
      // ignore
    }
  }

  cachedVersionInfo = {
    version,
    buildTime,
    gitCommit,
    gitBranch,
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime: process.uptime(),
  };
  cacheTimestamp = now;

  return cachedVersionInfo;
}

/**
 * Clear the version info cache
 * Useful after an update to force re-reading version info
 */
export function clearVersionInfoCache(): void {
  cachedVersionInfo = null;
  cacheTimestamp = 0;
}

/**
 * Get just the version string (fast, no git checks)
 */
export async function getVersionString(): Promise<string> {
  const root = await resolveInfiniBotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  if (!root) return "unknown";

  try {
    const pkgPath = path.join(root, "package.json");
    const pkgRaw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgRaw) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
