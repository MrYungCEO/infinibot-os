/**
 * Per-coder status for Setup › Coders: installed?, where, which version,
 * signed in?, which API-key vars are stored, running job, update available.
 *
 * Nothing here returns a secret: keys are reported by env-var name only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describeBinSearch } from "../coder-backend/bin-detect.js";
import { getCoderBackendId } from "../coder-backend/registry.js";
import {
  CODER_CATALOG,
  apiKeyEnvVars,
  isInstallable,
  type CoderCatalogEntry,
  type CoderId,
} from "./catalog.js";
import {
  detectHostTools,
  getJob,
  latestNpmVersion,
  managedBinPath,
  planInstall,
  probeVersion,
  readManifest,
  runProcess,
  scrubbedEnv,
  type CoderJob,
  type HostTools,
} from "./installer.js";
import { coderKeyEnv, coderKeyNames } from "./keys.js";
import { codersBinDir, codersRoot, coderInstallPolicy } from "./paths.js";

export type CoderAuthState = "signed-in" | "api-key" | "env" | "signed-out" | "unknown" | "n/a";

export interface CoderStatus {
  id: CoderId;
  installed: boolean;
  /** Installed by InfiniBot into the managed prefix. */
  managed: boolean;
  /** Resolved binary (managed shim or a system install). */
  binPath?: string;
  version?: string;
  managedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  auth: CoderAuthState;
  /** Env var names with a stored key (never values). */
  keys: string[];
  /** Key vars already present in the gateway's own environment. */
  envKeys: string[];
  /** This coder is the configured `coder.backend`. */
  isDefault: boolean;
  installable: boolean;
  /** Why Install is unavailable here (policy, missing uv, manual). */
  installBlocked?: { code: string; message: string; url?: string };
  job?: Omit<CoderJob, "log"> & { log: string[] };
  error?: string;
}

// Version probes run the CLI; cache them per binary for a minute so the UI
// can poll status while a job runs without re-spawning ten CLIs each time.
const versionCache = new Map<string, { at: number; version?: string; error?: string }>();
const authCache = new Map<string, { at: number; state: CoderAuthState }>();
const latestCache = new Map<string, { at: number; version: string | null }>();
const VERSION_TTL = 60_000;
const AUTH_TTL = 30_000;
const LATEST_TTL = 60 * 60_000;

/** Drop cached version/auth probes (after an install, sign-in or key change). */
export function invalidateCoderStatus(): void {
  versionCache.clear();
  authCache.clear();
}

async function cachedVersion(
  entry: CoderCatalogEntry,
  bin: string,
): Promise<{ version?: string; error?: string }> {
  const key = `${bin}::${entry.id}`;
  const hit = versionCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_TTL) return hit;
  let res: { version?: string; error?: string };
  try {
    res = { version: await probeVersion(bin, entry.versionArgs) };
  } catch (err) {
    res = { error: (err as Error).message };
  }
  versionCache.set(key, { at: Date.now(), ...res });
  return res;
}

/** Signed-in probe via the CLI's own status command (exit 0 = signed in). */
async function cachedAuth(entry: CoderCatalogEntry, bin: string): Promise<CoderAuthState> {
  if (!entry.authStatusArgs) return "unknown";
  const key = `${codersRoot()}::${entry.id}`;
  const hit = authCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_TTL) return hit.state;
  const res = await runProcess(bin, entry.authStatusArgs, {
    env: scrubbedEnv(coderKeyEnv(entry.id)),
    timeoutMs: 10_000,
  });
  let state: CoderAuthState = res.code === 0 ? "signed-in" : "signed-out";
  // `claude auth status` prints JSON; trust loggedIn over the exit code.
  const m = res.output.match(/"loggedIn"\s*:\s*(true|false)/);
  if (m) state = m[1] === "true" ? "signed-in" : "signed-out";
  authCache.set(key, { at: Date.now(), state });
  return state;
}

/** Signed-in probe for CLIs that only leave a credential file behind. */
export function authFilesPresent(
  entry: Pick<CoderCatalogEntry, "authFiles" | "authHomeEnv">,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): boolean {
  for (const raw of entry.authFiles ?? []) {
    let file = raw;
    const relocated = entry.authHomeEnv && env[entry.authHomeEnv.env]?.trim();
    if (relocated && entry.authHomeEnv && file.startsWith(entry.authHomeEnv.replaces)) {
      file = path.join(relocated, file.slice(entry.authHomeEnv.replaces.length));
    } else if (file.startsWith("~/")) {
      file = path.join(home, file.slice(2));
    }
    try {
      if (fs.statSync(file).size > 0) return true;
    } catch {
      /* not there */
    }
  }
  return false;
}

export async function coderStatus(
  entry: CoderCatalogEntry,
  opts: { host?: HostTools; checkUpdates?: boolean; activeBackend?: string } = {},
): Promise<CoderStatus> {
  const host = opts.host ?? detectHostTools();
  const manifest = readManifest(entry.id);
  const managedBin = managedBinPath(entry);
  const binPath = managedBin ?? describeBinSearch(entry.bin).resolved;
  const keys = coderKeyNames(entry.id);
  const envKeys = apiKeyEnvVars(entry).filter((k) => Boolean(process.env[k]?.trim()));
  const plan = planInstall(entry, host);
  const job = getJob(entry.id);
  const status: CoderStatus = {
    id: entry.id,
    installed: Boolean(binPath),
    managed: Boolean(managedBin),
    binPath,
    managedVersion: manifest?.version,
    auth: "n/a",
    keys,
    envKeys,
    isDefault: entry.backend !== null && entry.backend === (opts.activeBackend ?? safeBackendId()),
    installable: isInstallable(entry) && plan.ok,
    installBlocked: plan.ok ? undefined : { code: plan.code, message: plan.message, url: plan.url },
    job: job ? { ...job, log: job.log.slice(-40) } : undefined,
  };

  if (binPath) {
    const v = await cachedVersion(entry, binPath);
    status.version = v.version;
    if (v.error) status.error = v.error;
    if (keys.length) status.auth = "api-key";
    else if (entry.authFiles?.length) {
      status.auth = authFilesPresent(entry) ? "signed-in" : envKeys.length ? "env" : "signed-out";
    } else if (entry.authStatusArgs) {
      status.auth = await cachedAuth(entry, binPath).catch(() => "unknown" as const);
      if (status.auth === "signed-out" && envKeys.length) status.auth = "env";
    } else status.auth = envKeys.length ? "env" : entry.auth.length ? "signed-out" : "n/a";
  }

  const npm = entry.install.find((m) => m.kind === "npm");
  if (opts.checkUpdates && manifest && npm && npm.kind === "npm") {
    const hit = latestCache.get(npm.package);
    let latest = hit && Date.now() - hit.at < LATEST_TTL ? hit.version : undefined;
    if (latest === undefined) {
      latest = await latestNpmVersion(npm.package, host);
      latestCache.set(npm.package, { at: Date.now(), version: latest });
    }
    if (latest) {
      status.latestVersion = latest;
      status.updateAvailable = latest !== manifest.version;
    }
  }
  return status;
}

function safeBackendId(): string | undefined {
  try {
    return getCoderBackendId();
  } catch {
    return undefined;
  }
}

export async function allCoderStatuses(opts: { checkUpdates?: boolean } = {}) {
  const host = detectHostTools();
  const activeBackend = safeBackendId();
  const coders = await Promise.all(
    CODER_CATALOG.map((e) =>
      coderStatus(e, { host, checkUpdates: opts.checkUpdates, activeBackend }),
    ),
  );
  const policy = coderInstallPolicy();
  return {
    coders,
    activeBackend,
    policy: policy.allowed
      ? { allowed: true, mode: policy.mode }
      : { allowed: false, mode: policy.mode, reason: policy.reason },
    // Paths are shown so an operator can see where installs land; relative to
    // nothing secret. In SaaS they're the tenant's own volume paths.
    root: codersRoot(),
    binDir: codersBinDir(),
    prerequisites: {
      npm: Boolean(host.npm),
      uv: Boolean(host.uv),
      pipx: Boolean(host.pipx),
      node: host.nodeVersion,
    },
  };
}
