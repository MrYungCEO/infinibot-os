/**
 * Browser manager — the single facade through which the new agent
 * actions reach into the browser stack.
 *
 * Responsibilities:
 *   - Canonical filesystem layout for Chrome profiles
 *     (`~/.infinibot/chrome-profile/<name>/`) and snapshots
 *     (`~/.infinibot/chrome-profile-snapshots/`).
 *   - First-class "infini" profile: ensured present on first use, used as
 *     the default unless the caller picks otherwise.
 *   - Profile lifecycle helpers: list, ensure, delete, info.
 *   - Cookie / storageState / snapshot operations dispatched through here
 *     so the agent tool stays thin.
 *
 * Note: this does NOT replace the existing chrome.ts launch path. It
 * sits next to it and provides profile/file/policy plumbing the legacy
 * launch path doesn't expose. A follow-up can consolidate launch through
 * `safe-launch.ts` once we're sure nothing depends on the legacy clawd
 * profile path quirks.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { CONFIG_DIR } from "../utils.js";
import {
  CHROME_PROFILE_DIR_NAME,
  CHROME_PROFILE_SNAPSHOT_DIR_NAME,
  INFINI_PROFILE_NAME,
  type ProfileDescriptor,
  type ProfileSnapshotInfo,
} from "./profiles/types.js";
import {
  createProfileSnapshot,
  deleteProfileSnapshot,
  listProfileSnapshots,
  restoreProfileSnapshot,
} from "./profiles/snapshot.js";
import { DEFAULT_NAV_POLICY, type NavPolicy } from "./security/nav-policy.js";

/* ─── filesystem layout ───────────────────────────────────────── */

export function chromeProfileRoot(): string {
  return path.join(CONFIG_DIR, CHROME_PROFILE_DIR_NAME);
}

export function chromeProfileSnapshotRoot(): string {
  return path.join(CONFIG_DIR, CHROME_PROFILE_SNAPSHOT_DIR_NAME);
}

export function userDataDirFor(profileName: string): string {
  const cleaned = sanitizeProfileName(profileName);
  return path.join(chromeProfileRoot(), cleaned);
}

export function sanitizeProfileName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("profile name is required");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error(`invalid profile name "${name}": use letters/numbers/._- (max 64 chars)`);
  }
  return trimmed;
}

/* ─── per-profile nav policy registry ─────────────────────────── */

const profileNavPolicies = new Map<string, NavPolicy>([
  // The default "infini" profile gets the strict defaults — http(s)
  // public networks only, no private IPs, no file:/data: navigation.
  [INFINI_PROFILE_NAME, { ...DEFAULT_NAV_POLICY }],
]);

export function getNavPolicy(profileName: string): NavPolicy {
  return profileNavPolicies.get(sanitizeProfileName(profileName)) ?? DEFAULT_NAV_POLICY;
}

export function setNavPolicy(profileName: string, policy: NavPolicy): void {
  profileNavPolicies.set(sanitizeProfileName(profileName), { ...policy });
}

/* ─── lifecycle ───────────────────────────────────────────────── */

/**
 * Make sure the named profile's userDataDir exists on disk. No browser
 * launch — that's the existing chrome.ts path's job. Use this when the
 * agent wants to import cookies into a profile that's never been opened.
 */
export async function ensureProfile(
  profileName: string = INFINI_PROFILE_NAME,
): Promise<ProfileDescriptor> {
  const dir = userDataDirFor(profileName);
  await fsp.mkdir(dir, { recursive: true });
  return describeProfile(profileName);
}

export async function describeProfile(profileName: string): Promise<ProfileDescriptor> {
  const dir = userDataDirFor(profileName);
  const exists = fs.existsSync(dir);
  let sizeBytes: number | undefined;
  let lastUsedAt: number | undefined;
  if (exists) {
    try {
      const stat = await fsp.stat(dir);
      lastUsedAt = stat.mtimeMs;
      sizeBytes = await dirSize(dir);
    } catch {
      /* ignore */
    }
  }
  return {
    name: sanitizeProfileName(profileName),
    userDataDir: dir,
    exists,
    sizeBytes,
    lastUsedAt,
    navPolicy: getNavPolicy(profileName),
  };
}

export async function listProfiles(): Promise<ProfileDescriptor[]> {
  const root = chromeProfileRoot();
  if (!fs.existsSync(root)) return [];
  const entries = await fsp.readdir(root);
  const out: ProfileDescriptor[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      const stat = await fsp.stat(path.join(root, name));
      if (!stat.isDirectory()) continue;
      out.push(await describeProfile(name));
    } catch {
      /* ignore unreadable entries */
    }
  }
  return out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}

/**
 * Delete a profile's userDataDir. Refuses to delete the canonical
 * "infini" profile unless `confirmInfini: true` is passed — typo
 * protection for the daily-driver profile that holds real logins.
 */
export async function deleteProfile(
  profileName: string,
  opts: { confirmInfini?: boolean } = {},
): Promise<{ deleted: boolean; userDataDir: string }> {
  const name = sanitizeProfileName(profileName);
  if (name === INFINI_PROFILE_NAME && !opts.confirmInfini) {
    throw new Error(
      `refusing to delete the "${INFINI_PROFILE_NAME}" profile without confirmInfini=true (typo protection — this profile holds your real logins)`,
    );
  }
  const dir = userDataDirFor(name);
  const existed = fs.existsSync(dir);
  if (existed) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  profileNavPolicies.delete(name);
  return { deleted: existed, userDataDir: dir };
}

/* ─── snapshots ──────────────────────────────────────────────── */

export async function snapshotProfile(
  profileName: string,
  label?: string,
): Promise<ProfileSnapshotInfo> {
  const name = sanitizeProfileName(profileName);
  const dir = userDataDirFor(name);
  if (!fs.existsSync(dir)) {
    throw new Error(`profile "${name}" not found on disk at ${dir}`);
  }
  return createProfileSnapshot({
    profile: name,
    userDataDir: dir,
    snapshotDir: chromeProfileSnapshotRoot(),
    label,
  });
}

export async function restoreProfileFromSnapshot(
  archivePath: string,
  toProfile?: string,
): Promise<{ userDataDir: string; profile: string }> {
  // Derive profile name from filename when caller doesn't pass one.
  const profileFromFile = inferProfileFromSnapshotPath(archivePath);
  const target = sanitizeProfileName(toProfile ?? profileFromFile ?? INFINI_PROFILE_NAME);
  const dir = userDataDirFor(target);
  await restoreProfileSnapshot({ archivePath, userDataDir: dir });
  return { userDataDir: dir, profile: target };
}

export async function listSnapshots(profile?: string): Promise<ProfileSnapshotInfo[]> {
  return listProfileSnapshots(chromeProfileSnapshotRoot(), profile);
}

export async function deleteSnapshot(archivePath: string): Promise<void> {
  await deleteProfileSnapshot(archivePath);
}

function inferProfileFromSnapshotPath(filePath: string): string | undefined {
  const name = path.basename(filePath);
  const m = /^([^_]+(?:[^_]+)?)__/.exec(name);
  return m ? m[1] : undefined;
}

/* ─── misc ───────────────────────────────────────────────────── */

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) {
          stack.push(full);
        } else {
          const stat = await fsp.stat(full);
          total += stat.size;
        }
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return total;
}

/** For tests: clear in-process state without touching disk. */
export function _resetManagerStateForTests(): void {
  profileNavPolicies.clear();
  profileNavPolicies.set(INFINI_PROFILE_NAME, { ...DEFAULT_NAV_POLICY });
}
