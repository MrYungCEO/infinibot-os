import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import {
  DEFAULT_USER_ID,
  getCurrentUserId,
  resolveSharedDir,
  resolveStateDir,
} from "../config/paths.js";
import { extractArchive, fileExists, readJsonFile } from "./archive.js";

/**
 * Full backup/restore of an InfiniBot install: the shared state dir
 * (`~/.infinibot`), the active per-user data subtree (when non-default),
 * and the agent workspace (`~/infinibot`). Output is a single .zip that
 * can be handed to `infinibot restore` or to `infinibot onboard
 * --restore-from <zip>` on a fresh machine.
 *
 * Excludes are aggressive on purpose — browser/media caches and SQLite
 * WAL sidecars are large and either rebuild on first use or are folded
 * back into the main DB on close. Keeping them out turns multi-GB
 * installs into low-MB zips.
 */

export const BACKUP_MANIFEST_FILENAME = "manifest.json";
export const BACKUP_FORMAT_VERSION = 1;

export type BackupLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type BackupManifest = {
  version: number;
  createdAt: string;
  infinibotVersion: string | null;
  userId: string;
  sharedDirSource: string;
  stateDirSource: string;
  workspaceDirSource: string | null;
  hasUserSubtree: boolean;
  hasWorkspace: boolean;
  hostname: string;
  platform: string;
};

// Path segments (relative to the dir being walked) that should NEVER end
// up in a backup. Matched as exact path components, case-sensitively.
const SHARED_EXCLUDE_DIRS = new Set<string>([
  "browser",
  "media",
  "sandboxes",
  "skills",
  "cumulative-skills",
  "work-activity",
  "logs",
  "tmp",
  "users", // per-user subtree handled separately
]);

const SHARED_EXCLUDE_FILES = new Set<string>([
  ".migrated-from-legacy",
  "auto-update-state.json",
  "update-check.json",
  "skill-create-queue.jsonl",
  "skill-healing-queue.jsonl",
]);

const USER_EXCLUDE_DIRS = new Set<string>([
  "browser",
  "media",
  "sandboxes",
  "skills",
  "cumulative-skills",
  "work-activity",
  "logs",
  "tmp",
]);

const USER_EXCLUDE_FILES = new Set<string>([
  ".migrated-from-legacy",
  "auto-update-state.json",
  "update-check.json",
]);

const WORKSPACE_EXCLUDE_DIRS = new Set<string>([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  ".next",
]);

// SQLite write-ahead sidecars are checkpointed back into the main .db on
// clean shutdown; skipping them keeps backups small without losing data.
function isExcludedSidecar(name: string): boolean {
  return (
    name.endsWith("-shm") ||
    name.endsWith("-wal") ||
    name.endsWith(".sock") ||
    name.endsWith(".lock") ||
    name.endsWith(".pid")
  );
}

type WalkOpts = {
  excludeDirs: Set<string>;
  excludeFiles: Set<string>;
};

async function* walkDir(
  root: string,
  opts: WalkOpts,
  rel = "",
): AsyncGenerator<{ absPath: string; relPath: string }> {
  const dir = rel ? path.join(root, rel) : root;
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue; // skip symlinks; we resolve content only
    if (entry.isDirectory()) {
      if (opts.excludeDirs.has(entry.name)) continue;
      yield* walkDir(root, opts, childRel);
      continue;
    }
    if (!entry.isFile()) continue;
    if (opts.excludeFiles.has(entry.name)) continue;
    if (isExcludedSidecar(entry.name)) continue;
    yield { absPath: path.join(root, childRel), relPath: childRel };
  }
}

async function addDirToZip(
  zip: JSZip,
  rootDir: string,
  zipPrefix: string,
  opts: WalkOpts,
  logger?: BackupLogger,
): Promise<number> {
  let count = 0;
  for await (const entry of walkDir(rootDir, opts)) {
    try {
      const data = await fs.readFile(entry.absPath);
      const zipPath = path.posix.join(zipPrefix, entry.relPath.split(path.sep).join("/"));
      zip.file(zipPath, data);
      count += 1;
    } catch (err) {
      logger?.warn?.(
        `[backup] skipped ${entry.absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return count;
}

async function readInfinibotVersion(): Promise<string | null> {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    for (let depth = 0; depth < 8; depth += 1) {
      const dir = path.resolve(here, "../".repeat(depth) || ".");
      const candidate = path.join(dir, "package.json");
      try {
        const raw = await fs.readFile(candidate, "utf-8");
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        if (
          typeof pkg.name === "string" &&
          /^(@[^/]+\/)?(infinibot|moltbot)/i.test(pkg.name) &&
          typeof pkg.version === "string"
        ) {
          return pkg.version;
        }
      } catch {
        // keep walking
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export type CreateBackupOptions = {
  outPath: string;
  includeWorkspace?: boolean;
  workspaceDir?: string;
  logger?: BackupLogger;
};

export type CreateBackupResult = {
  zipPath: string;
  manifest: BackupManifest;
  bytes: number;
  fileCount: number;
};

export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const includeWorkspace = opts.includeWorkspace ?? true;
  const sharedDir = resolveSharedDir();
  const stateDir = resolveStateDir();
  const userId = getCurrentUserId();
  const workspaceDir = opts.workspaceDir ?? resolveDefaultAgentWorkspaceDir();

  const zip = new JSZip();
  let fileCount = 0;

  // shared/ — the ~/.infinibot root (excluding users/ subtree)
  if (await fileExists(sharedDir)) {
    fileCount += await addDirToZip(
      zip,
      sharedDir,
      "shared",
      { excludeDirs: SHARED_EXCLUDE_DIRS, excludeFiles: SHARED_EXCLUDE_FILES },
      opts.logger,
    );
  }

  // user/ — per-user subtree, only when not the default user (else it's
  // already inside shared/ and would be empty anyway).
  const hasUserSubtree = userId !== DEFAULT_USER_ID && stateDir !== sharedDir;
  if (hasUserSubtree && (await fileExists(stateDir))) {
    fileCount += await addDirToZip(
      zip,
      stateDir,
      "user",
      { excludeDirs: USER_EXCLUDE_DIRS, excludeFiles: USER_EXCLUDE_FILES },
      opts.logger,
    );
  }

  // workspace/ — agent identity dir (~/infinibot or ~/clawd)
  const hasWorkspace = includeWorkspace && (await fileExists(workspaceDir));
  if (hasWorkspace) {
    fileCount += await addDirToZip(
      zip,
      workspaceDir,
      "workspace",
      { excludeDirs: WORKSPACE_EXCLUDE_DIRS, excludeFiles: new Set() },
      opts.logger,
    );
  }

  const manifest: BackupManifest = {
    version: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    infinibotVersion: await readInfinibotVersion(),
    userId,
    sharedDirSource: sharedDir,
    stateDirSource: stateDir,
    workspaceDirSource: hasWorkspace ? workspaceDir : null,
    hasUserSubtree,
    hasWorkspace,
    hostname: os.hostname(),
    platform: process.platform,
  };
  zip.file(BACKUP_MANIFEST_FILENAME, JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.writeFile(opts.outPath, buffer);

  return {
    zipPath: opts.outPath,
    manifest,
    bytes: buffer.byteLength,
    fileCount,
  };
}

export type RestoreBackupOptions = {
  zipPath: string;
  force?: boolean;
  skipWorkspace?: boolean;
  workspaceDir?: string;
  logger?: BackupLogger;
};

export type RestoreBackupResult = {
  manifest: BackupManifest;
  targets: {
    sharedDir: string;
    stateDir: string;
    workspaceDir: string | null;
  };
  rotated: string[];
};

async function rotateExisting(
  targetDir: string,
  rotatedSuffix: string,
  rotated: string[],
  logger?: BackupLogger,
): Promise<void> {
  if (!(await fileExists(targetDir))) return;
  const entries = await fs.readdir(targetDir).catch(() => [] as string[]);
  if (entries.length === 0) return;
  const backupPath = `${targetDir}.bak-${rotatedSuffix}`;
  await fs.rename(targetDir, backupPath);
  rotated.push(backupPath);
  logger?.info?.(`[restore] rotated existing ${targetDir} → ${backupPath}`);
}

async function copyTree(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  await fs.cp(src, dst, { recursive: true, force: true, dereference: false });
}

export async function restoreBackup(opts: RestoreBackupOptions): Promise<RestoreBackupResult> {
  if (!(await fileExists(opts.zipPath))) {
    throw new Error(`backup zip not found: ${opts.zipPath}`);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-restore-"));
  try {
    await extractArchive({
      archivePath: opts.zipPath,
      destDir: tmpRoot,
      timeoutMs: 5 * 60_000,
      logger: opts.logger,
    });

    const manifestPath = path.join(tmpRoot, BACKUP_MANIFEST_FILENAME);
    if (!(await fileExists(manifestPath))) {
      throw new Error(`not a valid InfiniBot backup — missing ${BACKUP_MANIFEST_FILENAME}`);
    }
    const manifest = await readJsonFile<BackupManifest>(manifestPath);
    if (manifest.version !== BACKUP_FORMAT_VERSION) {
      throw new Error(
        `unsupported backup format version ${manifest.version} (expected ${BACKUP_FORMAT_VERSION})`,
      );
    }

    const sharedTarget = resolveSharedDir();
    const stateTarget = resolveStateDir();
    const workspaceTarget =
      opts.workspaceDir ?? manifest.workspaceDirSource ?? resolveDefaultAgentWorkspaceDir();
    const rotateSuffix = new Date().toISOString().replace(/[:.]/g, "-");
    const rotated: string[] = [];

    const sharedSrc = path.join(tmpRoot, "shared");
    const userSrc = path.join(tmpRoot, "user");
    const workspaceSrc = path.join(tmpRoot, "workspace");

    const hasSharedSrc = await fileExists(sharedSrc);
    const hasUserSrc = await fileExists(userSrc);
    const hasWorkspaceSrc = await fileExists(workspaceSrc);

    if (!opts.force) {
      const nonEmpty = async (dir: string): Promise<boolean> => {
        if (!(await fileExists(dir))) return false;
        const entries = await fs.readdir(dir).catch(() => [] as string[]);
        return entries.length > 0;
      };
      const blockers: string[] = [];
      if (hasSharedSrc && (await nonEmpty(sharedTarget))) blockers.push(sharedTarget);
      if (hasUserSrc && sharedTarget !== stateTarget && (await nonEmpty(stateTarget))) {
        blockers.push(stateTarget);
      }
      if (hasWorkspaceSrc && !opts.skipWorkspace && (await nonEmpty(workspaceTarget))) {
        blockers.push(workspaceTarget);
      }
      if (blockers.length > 0) {
        throw new Error(
          `restore would overwrite existing data at: ${blockers.join(
            ", ",
          )}. Re-run with --force to rotate them to .bak-* and proceed.`,
        );
      }
    }

    if (hasSharedSrc) {
      if (opts.force) await rotateExisting(sharedTarget, rotateSuffix, rotated, opts.logger);
      await copyTree(sharedSrc, sharedTarget);
      opts.logger?.info?.(`[restore] shared → ${sharedTarget}`);
    }

    if (hasUserSrc && sharedTarget !== stateTarget) {
      if (opts.force) await rotateExisting(stateTarget, rotateSuffix, rotated, opts.logger);
      await copyTree(userSrc, stateTarget);
      opts.logger?.info?.(`[restore] user → ${stateTarget}`);
    }

    if (hasWorkspaceSrc && !opts.skipWorkspace) {
      if (opts.force) await rotateExisting(workspaceTarget, rotateSuffix, rotated, opts.logger);
      await copyTree(workspaceSrc, workspaceTarget);
      opts.logger?.info?.(`[restore] workspace → ${workspaceTarget}`);
    }

    return {
      manifest,
      targets: {
        sharedDir: sharedTarget,
        stateDir: stateTarget,
        workspaceDir: hasWorkspaceSrc && !opts.skipWorkspace ? workspaceTarget : null,
      },
      rotated,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Quick header read for previewing a backup zip without unpacking it.
 */
export async function readBackupManifest(zipPath: string): Promise<BackupManifest> {
  const buffer = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(BACKUP_MANIFEST_FILENAME);
  if (!entry) throw new Error(`not a valid InfiniBot backup — missing ${BACKUP_MANIFEST_FILENAME}`);
  const raw = await entry.async("string");
  return JSON.parse(raw) as BackupManifest;
}

export function defaultBackupFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `infinibot-backup-${stamp}.zip`;
}
