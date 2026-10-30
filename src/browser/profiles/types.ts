/**
 * Shared types for the browser-profile management subsystem.
 *
 * A Profile is a named slot whose state (cookies, localStorage,
 * IndexedDB, history, extensions) lives in a dedicated userDataDir on
 * disk. The agent never types a path — it picks a profile by name.
 */

import type { NavPolicy } from "../security/nav-policy.js";

export const INFINI_PROFILE_NAME = "infini";

/** Filesystem layout under CONFIG_DIR (`~/.infinibot/`): */
export const CHROME_PROFILE_DIR_NAME = "chrome-profile";
export const CHROME_PROFILE_SNAPSHOT_DIR_NAME = "chrome-profile-snapshots";

export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  url?: string;
}

/** Playwright-compatible storageState (cookies + origin-keyed storage). */
export interface StorageStateSnapshot {
  cookies: BrowserCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface ProfileSnapshotInfo {
  /** Profile this snapshot was taken from. */
  profile: string;
  /** Absolute path to the .tar.gz archive. */
  path: string;
  /** Snapshot ID (timestamp + short token). */
  id: string;
  /** Bytes on disk. */
  size: number;
  /** ms epoch when the snapshot was taken. */
  createdAt: number;
  /** Free-form label set by the caller (e.g. "before-rebrand-test"). */
  label?: string;
}

export interface ProfileDescriptor {
  name: string;
  userDataDir: string;
  /** True when the userDataDir exists on disk. */
  exists: boolean;
  /** Bytes used by the userDataDir, or undefined if not measured. */
  sizeBytes?: number;
  /** ms epoch when Chrome last wrote to the profile. */
  lastUsedAt?: number;
  /** Per-profile navigation policy. Falls back to DEFAULT_NAV_POLICY. */
  navPolicy?: NavPolicy;
}
