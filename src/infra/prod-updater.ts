/**
 * Production updater — the npm-install update path for InfiniBot instances
 * installed via a global package manager (`npm i -g infinibot`).
 *
 * This is deliberately separate from `update-runner.ts`, which targets dev /
 * source checkouts (it runs `pnpm build && pnpm ui:build` against a git tree).
 * A user who installed the published package has no git checkout, so the
 * dev path can never work for them. The two paths are picked by
 * `detectInstallKind()`:
 *   - dev  → `ui/vite.config.ts` exists next to the running package → update-runner
 *   - prod → no vite config → this module (`npm install -g infinibot@<latest>`)
 *
 * Everything here is a small, pure-where-possible building block so the
 * gateway RPC layer and any Settings UI can share ONE updater (no parallel
 * code paths). The flow the UI drives:
 *   checkForUpdate() → preflight() → runInstall() → (user restarts)
 *
 * We never auto-restart: the running gateway carries live state, so we hand
 * the user a "restart to apply" CTA instead.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as FS } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { VERSION } from "../version.js";
import { compareSemverStrings, fetchNpmTagVersion } from "./update-check.js";
import { resolveInfiniBotPackageRoot } from "./infinibot-root.js";

const log = createSubsystemLogger("updater");

const PACKAGE_NAME = "infinibot";
const REGISTRY_BASE = "https://registry.npmjs.org";
/** Result cache TTL — 10 minutes per the product spec. */
export const CHECK_CACHE_TTL_MS = 10 * 60_000;
/** Minimum free disk required before we attempt a global install. */
export const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;
const NETWORK_PROBE_TIMEOUT_MS = 1500;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type InstallManager = "npm" | "pnpm" | "yarn" | "bun";

export type UpdateErrorKind =
  | "network"
  | "permission"
  | "rate-limit"
  | "version-not-found"
  | "disk"
  | "registry"
  | "unknown";

export type ProdUpdateCheck = {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  manager: InstallManager;
  installKind: "dev" | "prod";
  /** Epoch ms the underlying registry result was produced. */
  cachedAt: number;
  /** True when this check was served from the in-process 10-min cache. */
  fromCache: boolean;
  error?: string;
  errorKind?: UpdateErrorKind;
};

export type PreflightResult = {
  ok: boolean;
  network: { ok: boolean; ms?: number; error?: string };
  writable: { ok: boolean; path: string | null; error?: string; errorKind?: UpdateErrorKind };
  disk: { ok: boolean; freeBytes: number | null; requiredBytes: number };
  /** Exact remediation command when a preflight check fails (e.g. sudo). */
  hint?: string;
};

export type InstallProgress =
  | { kind: "phase"; phase: string; pct: number }
  | { kind: "line"; line: string; stream: "stdout" | "stderr" };

export type InstallResult = {
  ok: boolean;
  exitCode: number | null;
  manager: InstallManager;
  spec: string;
  commandLine: string;
  errorKind?: UpdateErrorKind;
  /** Remediation hint, e.g. the exact `sudo npm i -g …` to run in a terminal. */
  hint?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the package manager that installed us. `npm_config_user_agent` is set
 * by whichever manager spawned the current process (e.g.
 * "pnpm/8.15.0 npm/? node/v20…"). When unset (daemon started by systemd /
 * a bare node invocation), fall back to npm — the most universally present.
 */
export function detectInstallManager(ua = process.env.npm_config_user_agent): InstallManager {
  const s = (ua ?? "").trim().toLowerCase();
  if (s.startsWith("pnpm")) return "pnpm";
  if (s.startsWith("yarn")) return "yarn";
  if (s.startsWith("bun")) return "bun";
  return "npm";
}

/**
 * Resolve the executable name for the manager, honoring Windows shims.
 * On Windows, npm/pnpm/yarn are `.cmd` batch shims that MUST be invoked by
 * their `.cmd` name when spawning without a shell; bun ships as `bun.exe`
 * and resolves fine by bare name on PATH.
 */
export function resolveManagerBinary(
  manager: InstallManager,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" && manager !== "bun") return `${manager}.cmd`;
  return manager;
}

/** Global-install argv (excluding the binary) for `<pkg>@<version>`. */
export function buildInstallArgs(manager: InstallManager, spec: string): string[] {
  switch (manager) {
    case "pnpm":
      return ["add", "-g", spec];
    case "yarn":
      return ["global", "add", spec];
    case "bun":
      return ["add", "-g", spec];
    default:
      return ["install", "-g", spec];
  }
}

export function installSpec(version?: string | null): string {
  const v = (version ?? "").trim();
  return `${PACKAGE_NAME}@${v || "latest"}`;
}

/** The full command line the spawn will run — shown to the user / in hints. */
export function installCommandLine(
  manager: InstallManager,
  version?: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  const bin = resolveManagerBinary(manager, platform);
  return [bin, ...buildInstallArgs(manager, installSpec(version))].join(" ");
}

/** Map a registry/fetch failure string to a user-meaningful cause. */
export function classifyRegistryError(error?: string | null): UpdateErrorKind {
  const s = (error ?? "").toLowerCase();
  if (!s) return "registry";
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests")) {
    return "rate-limit";
  }
  if (s.includes("404") || s.includes("not found")) return "version-not-found";
  if (
    s.includes("abort") ||
    s.includes("timeout") ||
    s.includes("enotfound") ||
    s.includes("econnrefused") ||
    s.includes("econnreset") ||
    s.includes("network") ||
    s.includes("getaddrinfo") ||
    s.includes("fetch failed")
  ) {
    return "network";
  }
  return "registry";
}

/** Map combined install stdout/stderr to a cause (used on non-zero exit). */
export function classifyInstallError(output: string): UpdateErrorKind {
  const s = output.toLowerCase();
  if (s.includes("eacces") || s.includes("permission denied") || s.includes("eperm")) {
    return "permission";
  }
  if (s.includes("enospc") || s.includes("no space left")) return "disk";
  if (
    s.includes("e404") ||
    s.includes("404") ||
    s.includes("not in the registry") ||
    s.includes("not found in the registry") ||
    s.includes("no matching version")
  ) {
    return "version-not-found";
  }
  if (
    s.includes("enotfound") ||
    s.includes("econnrefused") ||
    s.includes("etimedout") ||
    s.includes("network") ||
    s.includes("getaddrinfo")
  ) {
    return "network";
  }
  if (s.includes("429") || s.includes("rate limit")) return "rate-limit";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Install-kind detection
// ─────────────────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveRoot(): Promise<string | null> {
  return resolveInfiniBotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
}

/**
 * dev = a source checkout (has `ui/vite.config.ts` next to the package root),
 * prod = a published npm install (no vite config to build the UI from).
 */
export async function detectInstallKind(rootArg?: string | null): Promise<"dev" | "prod"> {
  const root = rootArg ?? (await resolveRoot());
  if (!root) return "prod";
  return (await exists(path.join(root, "ui", "vite.config.ts"))) ? "dev" : "prod";
}

// ─────────────────────────────────────────────────────────────────────────────
// Update check (10-minute cached)
// ─────────────────────────────────────────────────────────────────────────────

let checkCache: { result: ProdUpdateCheck; at: number } | null = null;

/** Test seam / "Check now" support — drop the cached result. */
export function invalidateCheckCache(): void {
  checkCache = null;
}

export async function checkForUpdate(opts?: {
  force?: boolean;
  timeoutMs?: number;
  now?: number;
}): Promise<ProdUpdateCheck> {
  const now = opts?.now ?? Date.now();
  if (!opts?.force && checkCache && now - checkCache.at < CHECK_CACHE_TTL_MS) {
    return { ...checkCache.result, fromCache: true };
  }

  const manager = detectInstallManager();
  const installKind = await detectInstallKind();
  log.info("check", { manager, installKind, current: VERSION });

  const reg = await fetchNpmTagVersion({ tag: "latest", timeoutMs: opts?.timeoutMs ?? 4000 });
  if (!reg.version) {
    const errorKind = classifyRegistryError(reg.error);
    // Errors are never cached — the next open / "Check now" retries immediately.
    log.warn("check failed", { error: reg.error, errorKind });
    return {
      hasUpdate: false,
      currentVersion: VERSION,
      latestVersion: null,
      manager,
      installKind,
      cachedAt: now,
      fromCache: false,
      error: reg.error ?? "registry unavailable",
      errorKind,
    };
  }

  const cmp = compareSemverStrings(VERSION, reg.version);
  const hasUpdate = cmp != null && cmp < 0;
  const result: ProdUpdateCheck = {
    hasUpdate,
    currentVersion: VERSION,
    latestVersion: reg.version,
    manager,
    installKind,
    cachedAt: now,
    fromCache: false,
  };
  checkCache = { result, at: now };
  log.info("check ok", { hasUpdate, latest: reg.version });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight
// ─────────────────────────────────────────────────────────────────────────────

async function probeNetwork(
  timeoutMs = NETWORK_PROBE_TIMEOUT_MS,
): Promise<PreflightResult["network"]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(250, timeoutMs));
  const started = Date.now();
  try {
    const res = await fetch(`${REGISTRY_BASE}/${PACKAGE_NAME}/latest`, {
      method: "HEAD",
      signal: ctrl.signal,
    });
    // Any HTTP answer (even 4xx) proves reachability.
    return { ok: res.status > 0, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  } finally {
    clearTimeout(t);
  }
}

/** Resolve the global node_modules dir the install would write into. */
export async function resolveGlobalNodeModules(
  manager: InstallManager,
  timeoutMs = 5000,
): Promise<string | null> {
  if (manager === "bun") {
    const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
    return path.join(bunInstall, "install", "global", "node_modules");
  }
  const bin = resolveManagerBinary(manager);
  const argv = manager === "yarn" ? [bin, "global", "dir"] : [bin, "root", "-g"];
  const res = await runCommandWithTimeout(argv, { timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const out = res.stdout.trim();
  return out || null;
}

async function probeWritable(
  manager: InstallManager,
): Promise<{ result: PreflightResult["writable"]; targetPath: string | null }> {
  const target = await resolveGlobalNodeModules(manager);
  if (!target) {
    return {
      result: { ok: false, path: null, error: "could not resolve global node_modules dir" },
      targetPath: null,
    };
  }
  // Walk up to the first existing ancestor and test write permission there —
  // npm needs to create the dir if it doesn't already exist.
  let probe = target;
  while (probe && !(await exists(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    await fs.access(probe, FS.W_OK);
    return { result: { ok: true, path: target }, targetPath: target };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      result: {
        ok: false,
        path: target,
        error: `${code ?? "EACCES"}: no write permission on ${probe}`,
        errorKind: "permission",
      },
      targetPath: target,
    };
  }
}

async function probeDisk(targetPath: string | null): Promise<PreflightResult["disk"]> {
  const checkPath = targetPath ?? os.tmpdir();
  try {
    // statfs is stable since Node 18.15. Fall back gracefully if unavailable.
    const sf = await (
      fs as unknown as {
        statfs?: (p: string) => Promise<{ bsize: number; bavail: number }>;
      }
    ).statfs?.(checkPath);
    if (!sf) return { ok: true, freeBytes: null, requiredBytes: MIN_FREE_DISK_BYTES };
    const freeBytes = sf.bsize * sf.bavail;
    return { ok: freeBytes >= MIN_FREE_DISK_BYTES, freeBytes, requiredBytes: MIN_FREE_DISK_BYTES };
  } catch {
    // If we can't measure, don't block the install on a phantom failure.
    return { ok: true, freeBytes: null, requiredBytes: MIN_FREE_DISK_BYTES };
  }
}

export async function preflight(opts?: { manager?: InstallManager }): Promise<PreflightResult> {
  const manager = opts?.manager ?? detectInstallManager();
  log.info("preflight start", { manager });

  const [network, writableProbe] = await Promise.all([probeNetwork(), probeWritable(manager)]);
  const disk = await probeDisk(writableProbe.targetPath);

  const ok = network.ok && writableProbe.result.ok && disk.ok;
  let hint: string | undefined;
  if (!writableProbe.result.ok && writableProbe.result.errorKind === "permission") {
    // Surface the exact escalated command — never auto-sudo.
    hint = `Need elevated permissions to write to ${writableProbe.result.path}. Open a terminal and run:\n  sudo ${installCommandLine(manager, "latest")}`;
  } else if (!network.ok) {
    hint = "Can't reach the npm registry. Check your network / VPN / proxy and retry.";
  } else if (!disk.ok) {
    const freeMb = disk.freeBytes != null ? Math.round(disk.freeBytes / (1024 * 1024)) : "?";
    hint = `Low disk space (${freeMb} MB free, need ${Math.round(MIN_FREE_DISK_BYTES / (1024 * 1024))} MB). Free up space and retry.`;
  }

  const result: PreflightResult = { ok, network, writable: writableProbe.result, disk, hint };
  log.info("preflight done", {
    ok,
    network: network.ok,
    writable: writableProbe.result.ok,
    disk: disk.ok,
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install (streaming, no restart)
// ─────────────────────────────────────────────────────────────────────────────

/** Coarse phase/percent heuristic from a global-install log line. */
function phaseFromLine(line: string): { phase: string; pct: number } | null {
  const s = line.toLowerCase();
  if (s.includes("resolv")) return { phase: "Resolving", pct: 20 };
  if (s.includes("fetch") || s.includes("download")) return { phase: "Downloading", pct: 45 };
  if (s.includes("extract") || s.includes("unpack")) return { phase: "Extracting", pct: 65 };
  if (s.includes("link") || s.includes("install") || s.includes("add")) {
    return { phase: "Linking", pct: 80 };
  }
  if (s.includes("postinstall") || s.includes("build")) return { phase: "Finalizing", pct: 92 };
  return null;
}

/**
 * Spawn the global install, streaming each output line to `onProgress`.
 * Resolves once the child exits — NEVER restarts the gateway. The caller
 * shows a "restart to apply" CTA on `ok`.
 */
export async function runInstall(opts: {
  version?: string | null;
  onProgress?: (p: InstallProgress) => void;
  /** Hard cap; global installs are usually < 2 min. */
  timeoutMs?: number;
}): Promise<InstallResult> {
  const manager = detectInstallManager();
  const bin = resolveManagerBinary(manager);
  const spec = installSpec(opts.version);
  const args = buildInstallArgs(manager, spec);
  const commandLine = [bin, ...args].join(" ");
  const onProgress = opts.onProgress ?? (() => {});

  log.info("install start", { manager, spec, commandLine });
  onProgress({ kind: "phase", phase: "Starting", pct: 5 });

  return await new Promise<InstallResult>((resolve) => {
    let settled = false;
    let collected = "";
    let lastPct = 5;

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // shell:false — args are not user-controlled; avoids injection + quoting bugs.
      shell: false,
      env: process.env,
    });

    const timer = setTimeout(
      () => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      },
      opts.timeoutMs ?? 5 * 60_000,
    );

    const pump = (buf: Buffer, stream: "stdout" | "stderr") => {
      const text = buf.toString("utf-8");
      collected += text;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;
        onProgress({ kind: "line", line, stream });
        const ph = phaseFromLine(line);
        if (ph && ph.pct > lastPct) {
          lastPct = ph.pct;
          onProgress({ kind: "phase", phase: ph.phase, pct: ph.pct });
        }
      }
    };

    child.stdout?.on("data", (b: Buffer) => pump(b, "stdout"));
    child.stderr?.on("data", (b: Buffer) => pump(b, "stderr"));

    const finish = (code: number | null, spawnErr?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ok = code === 0 && !spawnErr;
      let errorKind: UpdateErrorKind | undefined;
      let hint: string | undefined;
      if (!ok) {
        const blob = `${collected}\n${spawnErr?.message ?? ""}`;
        if (spawnErr && (spawnErr as NodeJS.ErrnoException).code === "ENOENT") {
          errorKind = "unknown";
          hint = `${bin} not found on PATH. Reinstall the package manager or run the command manually:\n  ${commandLine}`;
        } else {
          errorKind = classifyInstallError(blob);
          if (errorKind === "permission") {
            hint = `Permission denied. Run with elevated rights in a terminal:\n  sudo ${commandLine}`;
          } else if (errorKind === "disk") {
            hint = "Out of disk space mid-install. Free up space and retry.";
          } else if (errorKind === "network") {
            hint = "Network dropped mid-install. Reconnect and retry.";
          }
        }
      } else {
        onProgress({ kind: "phase", phase: "Done", pct: 100 });
      }
      log.info(`install end exit=${code ?? "null"}`, { ok, errorKind });
      resolve({ ok, exitCode: code, manager, spec, commandLine, errorKind, hint });
    };

    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable error copy (shared by UI states)
// ─────────────────────────────────────────────────────────────────────────────

export function describeErrorKind(kind: UpdateErrorKind | undefined): string {
  switch (kind) {
    case "network":
      return "Network unreachable";
    case "permission":
      return "Permission denied";
    case "rate-limit":
      return "Registry rate-limited";
    case "version-not-found":
      return "Version not found";
    case "disk":
      return "Not enough disk space";
    case "registry":
      return "Registry error";
    default:
      return "Update error";
  }
}
