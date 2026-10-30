/**
 * Named browser profiles for agents.
 *
 * A profile is one managed Chrome user-data dir: cookies, localStorage,
 * IndexedDB and logins live there, so they survive gateway restarts.
 *
 *   default  → the gateway's managed default profile (the one the live browser
 *              panel shows). Its data dir stays where it always was
 *              (<state>/browser/clawd/user-data) so existing logins are kept.
 *   <name>   → <state>/browser/profiles/<name>/user-data
 *   secure   → an ephemeral dir on tmpfs (/dev/shm), wiped when the browser
 *              stops and on gateway start. Only Secure Mode sessions may use it,
 *              and Secure Mode sessions may use nothing else.
 *
 * Each data dir gets an `infinibot-profile.lock` next to it (pid + CDP port) so
 * two gateways (or a gateway and a CLI) never run Chrome on the same profile.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_DIR } from "../../utils.js";
import { DEFAULT_CLAWD_BROWSER_PROFILE_NAME } from "../constants.js";

export const AGENT_DEFAULT_PROFILE = "default";
export const SECURE_BROWSER_PROFILE = "secure";
/** The user's own Chrome through the Browser Relay extension. */
export const RELAY_BROWSER_PROFILE = "chrome";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOCK_FILE = "infinibot-profile.lock";

export function browserStateRoot(): string {
  return path.join(CONFIG_DIR, "browser");
}

export function browserProfilesRoot(): string {
  return path.join(browserStateRoot(), "profiles");
}

/**
 * Normalize what a model passes as `profile`. Empty → "default"; aliases for
 * the user's own Chrome map to "chrome". Throws a clear error on junk.
 */
export function normalizeAgentProfileName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s || s === "default" || s === "infini" || s === "clawd" || s === "managed") {
    return AGENT_DEFAULT_PROFILE;
  }
  if (s === "relay" || s === "extension" || s === "my-chrome" || s === "user") {
    return RELAY_BROWSER_PROFILE;
  }
  const cleaned = s.replace(/[\s_]+/g, "-");
  if (!NAME_RE.test(cleaned)) {
    throw new Error(
      `Invalid browser profile name "${String(raw)}". Use lowercase letters, digits and dashes (max 32), e.g. "work".`,
    );
  }
  return cleaned;
}

/**
 * The secure profile lives on tmpfs, keyed by the state dir so a side gateway
 * never shares it with the live one.
 */
export function secureProfileRoot(): string {
  const base = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
  const key = crypto.createHash("sha256").update(CONFIG_DIR).digest("hex").slice(0, 12);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(base, `infinibot-${uid}-${key}`, "secure-browser");
}

/**
 * Chrome user-data dir for a managed browser profile name (the name the
 * browser control service uses: "clawd", "work", "secure"…).
 *
 * Legacy layout <state>/browser/<name>/user-data wins when it already exists so
 * an upgrade never orphans a signed-in profile.
 */
export function userDataDirForManagedProfile(name: string): string {
  if (name === SECURE_BROWSER_PROFILE) return path.join(secureProfileRoot(), "user-data");
  const legacy = path.join(browserStateRoot(), name, "user-data");
  if (name === DEFAULT_CLAWD_BROWSER_PROFILE_NAME || fs.existsSync(legacy)) return legacy;
  return path.join(browserProfilesRoot(), name, "user-data");
}

// ── lock files ──────────────────────────────────────────────────────────────

export type ProfileLock = {
  pid: number;
  cdpPort?: number;
  stateDir: string;
  startedAt: string;
};

function lockPathFor(userDataDir: string): string {
  return path.join(path.dirname(userDataDir), LOCK_FILE);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readProfileLock(userDataDir: string): ProfileLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPathFor(userDataDir), "utf8")) as ProfileLock;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Which live Chrome holds the profile (Chrome's own SingletonLock), if any. */
export function chromeSingletonPid(userDataDir: string): number | null {
  try {
    const target = fs.readlinkSync(path.join(userDataDir, "SingletonLock"));
    const pid = Number(target.split("-").pop());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the profile lock for this process. A lock held by another LIVE process
 * is an error; a stale one (crashed gateway) is taken over, and Chrome's own
 * Singleton* files are removed when no Chrome holds them any more (a stale
 * SingletonLock makes Chrome refuse the profile).
 */
export function acquireProfileLock(
  userDataDir: string,
  opts: { cdpPort?: number; pid?: number } = {},
): ProfileLock {
  const pid = opts.pid ?? process.pid;
  fs.mkdirSync(path.dirname(userDataDir), { recursive: true });
  const existing = readProfileLock(userDataDir);
  if (existing && existing.pid !== pid && pidAlive(existing.pid)) {
    throw new Error(
      `Browser profile at ${path.dirname(userDataDir)} is in use by another InfiniBot process (pid ${existing.pid}, state ${existing.stateDir}). Use a different profile name or stop that process.`,
    );
  }
  const chromePid = chromeSingletonPid(userDataDir);
  if (chromePid === null || !pidAlive(chromePid)) {
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      try {
        fs.rmSync(path.join(userDataDir, f), { force: true });
      } catch {
        // ignore
      }
    }
  }
  const lock: ProfileLock = {
    pid,
    cdpPort: opts.cdpPort,
    stateDir: CONFIG_DIR,
    startedAt: new Date().toISOString(),
  };
  const tmp = `${lockPathFor(userDataDir)}.${pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600 });
  fs.renameSync(tmp, lockPathFor(userDataDir));
  return lock;
}

export function releaseProfileLock(userDataDir: string, pid = process.pid): void {
  const existing = readProfileLock(userDataDir);
  if (existing && existing.pid !== pid) return;
  try {
    fs.rmSync(lockPathFor(userDataDir), { force: true });
  } catch {
    // ignore
  }
}

/** Remove the secure profile's tmpfs dir (on stop and at gateway start). */
export function wipeSecureProfile(): void {
  try {
    fs.rmSync(secureProfileRoot(), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ── listing ────────────────────────────────────────────────────────────────

export type StoredProfileInfo = {
  /** Agent-facing name ("default", "work", "secure"). */
  name: string;
  /** Managed browser profile name used by the control service. */
  managedName: string;
  userDataDir: string;
  exists: boolean;
  sizeBytes: number;
  ephemeral: boolean;
  lock: ProfileLock | null;
  lockedByOther: boolean;
};

function dirSize(dir: string, budget = { files: 20_000 }): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.files-- <= 0) break;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p, budget);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      // ignore
    }
  }
  return total;
}

export function describeStoredProfile(
  name: string,
  managedName: string,
  opts: { withSize?: boolean } = {},
): StoredProfileInfo {
  const userDataDir = userDataDirForManagedProfile(managedName);
  const exists = fs.existsSync(userDataDir);
  const lock = readProfileLock(userDataDir);
  return {
    name,
    managedName,
    userDataDir,
    exists,
    sizeBytes: exists && opts.withSize !== false ? dirSize(userDataDir) : 0,
    ephemeral: managedName === SECURE_BROWSER_PROFILE,
    lock,
    lockedByOther: Boolean(lock && lock.pid !== process.pid && pidAlive(lock.pid)),
  };
}

/** Profile names that have a data dir under <state>/browser/profiles. */
export function listStoredProfileNames(): string[] {
  try {
    return fs
      .readdirSync(browserProfilesRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
