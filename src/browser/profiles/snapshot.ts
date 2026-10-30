/**
 * Profile snapshots — tar.gz archives of a full userDataDir.
 *
 * Distinct from storageState (cookies + localStorage JSON):
 *   - storageState is small, portable, and Playwright-native — good for
 *     auth bootstrapping or moving sessions across profiles.
 *   - A snapshot is a complete byte-for-byte capture of the profile,
 *     including extensions, IndexedDB, cache, history. Use it as a
 *     "pin known-good state" before letting the agent run something
 *     irreversible (filling a form, deleting items, changing settings).
 *
 * Snapshots live under `~/.infinibot/chrome-profile-snapshots/`. Each
 * snapshot file name encodes the source profile + timestamp + optional
 * label so you can pick one without reading metadata.
 *
 *   chrome-profile-snapshots/
 *     infini__2026-05-11T031200Z__before-bank-task.tar.gz
 *
 * Restore is an atomic-ish operation: we untar into a temp dir next to
 * the destination, then rename. If the rename fails the original
 * userDataDir is untouched.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import type { ProfileSnapshotInfo } from "./types.js";

export interface CreateSnapshotOptions {
  profile: string;
  userDataDir: string;
  snapshotDir: string;
  /** Optional human-readable label. Sanitized to [-A-Za-z0-9_]. */
  label?: string;
}

/**
 * Tar+gzip the userDataDir into the snapshot dir. Uses the system `tar`
 * binary so we don't pull a new dependency for what's already available
 * everywhere we run.
 */
export async function createProfileSnapshot(
  opts: CreateSnapshotOptions,
): Promise<ProfileSnapshotInfo> {
  if (!fs.existsSync(opts.userDataDir)) {
    throw new Error(`profile not found on disk: ${opts.userDataDir}`);
  }
  await fsp.mkdir(opts.snapshotDir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-(\d{3})Z$/, "Z");
  const label = sanitizeLabel(opts.label);
  const id = `${stamp}__${randomBytes(2).toString("hex")}`;
  const filename = label
    ? `${opts.profile}__${id}__${label}.tar.gz`
    : `${opts.profile}__${id}.tar.gz`;
  const outPath = path.join(opts.snapshotDir, filename);

  // Run tar from the userDataDir's parent so the archive contains a
  // top-level dir matching the profile name — restore can untar into
  // either the parent (and rename) or a clean target.
  const parent = path.dirname(opts.userDataDir);
  const base = path.basename(opts.userDataDir);

  await runTar([
    "-czf",
    outPath,
    "-C",
    parent,
    // Skip ephemeral / large files that bloat snapshots without buying
    // any session fidelity.
    "--exclude=Cache",
    "--exclude=Code Cache",
    "--exclude=GPUCache",
    "--exclude=Service Worker/CacheStorage",
    "--exclude=Crashpad",
    "--exclude=Singleton*",
    "--exclude=ShaderCache",
    base,
  ]);

  const stat = await fsp.stat(outPath);
  return {
    profile: opts.profile,
    path: outPath,
    id,
    size: stat.size,
    createdAt: Date.now(),
    label: opts.label,
  };
}

export interface RestoreSnapshotOptions {
  archivePath: string;
  /** Absolute path where the profile should live after restore. */
  userDataDir: string;
}

/**
 * Restore a snapshot over an existing userDataDir. Steps:
 *   1. Extract to a sibling .restoring-<rand> directory
 *   2. Rename the current userDataDir to .stale-<rand> (or remove if empty)
 *   3. Rename the extracted dir to the final userDataDir path
 *   4. Best-effort cleanup of .stale
 *
 * The caller MUST ensure no Chrome instance is currently writing to the
 * userDataDir — restoring a live profile is corruption-prone.
 */
export async function restoreProfileSnapshot(
  opts: RestoreSnapshotOptions,
): Promise<{ userDataDir: string }> {
  if (!fs.existsSync(opts.archivePath)) {
    throw new Error(`snapshot not found: ${opts.archivePath}`);
  }
  const parent = path.dirname(opts.userDataDir);
  const base = path.basename(opts.userDataDir);
  await fsp.mkdir(parent, { recursive: true });

  const restoreTag = randomBytes(3).toString("hex");
  const tempExtract = path.join(parent, `.restoring-${restoreTag}`);
  await fsp.mkdir(tempExtract, { recursive: true });

  try {
    await runTar(["-xzf", opts.archivePath, "-C", tempExtract]);
    // Verify the archive produced an entry matching the original base
    // name (we tarred from the parent so the archive root has `base`).
    const extractedRoot = path.join(tempExtract, base);
    if (!fs.existsSync(extractedRoot)) {
      // Some archives might have been built from inside the dir. Find
      // a single child of the temp extract.
      const children = await fsp.readdir(tempExtract);
      if (children.length === 1) {
        const only = path.join(tempExtract, children[0]);
        await fsp.rename(only, extractedRoot);
      } else {
        throw new Error(
          `snapshot did not contain a single root matching "${base}"; got entries: ${children.join(", ")}`,
        );
      }
    }

    // Park the current dir before swapping in the restored one.
    const stalePath = path.join(parent, `.stale-${restoreTag}`);
    if (fs.existsSync(opts.userDataDir)) {
      await fsp.rename(opts.userDataDir, stalePath);
    }
    try {
      await fsp.rename(extractedRoot, opts.userDataDir);
    } catch (err) {
      // Roll back: put the original back.
      if (fs.existsSync(stalePath)) {
        try {
          await fsp.rename(stalePath, opts.userDataDir);
        } catch {
          /* ignore — leave the .stale dir for forensic recovery */
        }
      }
      throw err;
    }

    // Best-effort: clean up the stale snapshot.
    if (fs.existsSync(stalePath)) {
      await fsp.rm(stalePath, { recursive: true, force: true }).catch(() => {});
    }
    return { userDataDir: opts.userDataDir };
  } finally {
    if (fs.existsSync(tempExtract)) {
      await fsp.rm(tempExtract, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function listProfileSnapshots(
  snapshotDir: string,
  profile?: string,
): Promise<ProfileSnapshotInfo[]> {
  if (!fs.existsSync(snapshotDir)) return [];
  const entries = await fsp.readdir(snapshotDir);
  const out: ProfileSnapshotInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith(".tar.gz")) continue;
    const m = /^(.+?)__([^_]+(?:__[^_]+)?)(?:__(.+))?\.tar\.gz$/.exec(name);
    if (!m) continue;
    const [, prof, id, label] = m;
    if (profile && prof !== profile) continue;
    const full = path.join(snapshotDir, name);
    try {
      const stat = await fsp.stat(full);
      out.push({
        profile: prof,
        path: full,
        id,
        size: stat.size,
        createdAt: stat.mtimeMs,
        label,
      });
    } catch {
      /* ignore unreadable entry */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteProfileSnapshot(snapshotPath: string): Promise<void> {
  await fsp.rm(snapshotPath, { force: true });
}

function sanitizeLabel(label?: string): string | undefined {
  if (!label) return undefined;
  const cleaned = label
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return cleaned || undefined;
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}
