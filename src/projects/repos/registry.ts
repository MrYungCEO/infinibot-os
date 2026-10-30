/**
 * Project repos — durable registry (the source of truth for repo bindings,
 * deploy branches, first-time setup progress and scan settings).
 *
 * Lives at `<stateDir>/project-repos/registry.json`. Writes are atomic
 * (temp file + fsync + rename, previous copy kept as `.bak`) and serialized
 * in-process; every mutation re-reads the file first so a concurrent writer
 * (a second gateway, the CLI) is not clobbered. A corrupt file falls back to
 * the `.bak` copy.
 *
 * Bindings are keyed by projectId but also remember the project name, so a
 * project whose id changes (local row ↔ Notion page) is re-matched by name.
 * Detach keeps a tombstone (`path: null`, `detachedPath`) so the legacy
 * `projectDirectory` / `githubLocalPath` fallback cannot resurrect a repo
 * the owner explicitly detached.
 *
 * Repo records are keyed by the repo's git common dir, so every worktree of
 * one repository shares one deploy-branch setting.
 */

import fs from "node:fs";
import path from "node:path";
import { normalizeRepoPath } from "./git-info.js";

export type DeployTargetKind = "fly" | "netlify" | "vercel" | "gateway" | "docker" | "other";

export interface DeployTarget {
  kind: DeployTargetKind;
  /** Fly app name, Netlify site, "InfiniBot gateway", ... */
  name?: string;
}

export interface DeployConfig {
  branch: string;
  /** Absolute path of the checkout/worktree the deploy runs from. */
  worktreePath: string;
  target?: DeployTarget;
  /** Command that deploys ("fly deploy -c deploy/fly/fly.toml"). */
  command?: string;
  notes?: string;
  /** "manual" when the owner set or confirmed it; "auto" for an accepted suggestion. */
  source: "manual" | "auto";
  confidence?: number;
  confirmedAt?: number;
  updatedAt: number;
  /** Owner-recorded deploy times (most recent first, max 20). */
  deploys?: Array<{ at: number; sha?: string; note?: string }>;
}

/** Branch counts are LOCAL branches; remote + worktree counts are separate. */
export interface HealthTotals {
  safe: number;
  review: number;
  active: number;
  protected: number;
  remoteSafe: number;
  remoteReview: number;
  worktreesSafe: number;
  worktreesReview: number;
  /** Local branches holding work found nowhere in the deploy branch. */
  uniqueWork: number;
  /** Local branches merged on origin's deploy branch but not pulled locally. */
  notPulled?: number;
  stashes: number;
  worktrees: number;
  branches: number;
  remoteBranches: number;
  reclaimBytes: number;
}

export interface RepoRecord {
  /** Realpath of the git common dir (…/repo/.git). */
  key: string;
  name: string;
  /** Main worktree root. */
  root: string;
  addedAt: number;
  updatedAt: number;
  deploy?: DeployConfig;
  /** Summary of the last branch-health scan (badge counts). */
  lastHealth?: { at: number; totals: HealthTotals; deployBranch?: string };
}

export interface RepoBinding {
  projectId: string;
  projectName: string;
  /** Bound checkout root; null = explicitly detached (tombstone). */
  path: string | null;
  /** Repo common-dir key (when known). */
  repoKey?: string;
  attachedAt?: number;
  detachedAt?: number;
  /** Path that was detached — suppresses the legacy fallback for it. */
  detachedPath?: string;
  updatedAt: number;
  /** Monotonic per-binding revision (last write wins, visible to clients). */
  rev: number;
  /** Whether the Notion/projectDirectory mirror has caught up. */
  mirrored?: boolean;
}

export const SETUP_STEPS = ["pick", "branch", "learn", "github", "scan", "done"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupProgress {
  /** Steps completed or skipped. */
  steps: Partial<Record<SetupStep, { at: number; skipped?: boolean }>>;
  repoKey?: string;
  projectId?: string;
  dismissedAt?: number;
  completedAt?: number;
  updatedAt?: number;
}

export interface RegistryFile {
  version: 1;
  bindings: Record<string, RepoBinding>;
  repos: Record<string, RepoRecord>;
  setup: SetupProgress;
  scan: { daily: boolean; lastRunAt?: number; lastNotifiedAt?: number };
}

function emptyRegistry(): RegistryFile {
  return { version: 1, bindings: {}, repos: {}, setup: { steps: {} }, scan: { daily: false } };
}

export function registryPath(stateDir: string): string {
  return path.join(stateDir, "project-repos", "registry.json");
}

function sanitize(raw: unknown): RegistryFile {
  const base = emptyRegistry();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<RegistryFile>;
  return {
    version: 1,
    bindings: r.bindings && typeof r.bindings === "object" ? r.bindings : {},
    repos: r.repos && typeof r.repos === "object" ? r.repos : {},
    setup:
      r.setup && typeof r.setup === "object"
        ? {
            ...r.setup,
            steps: r.setup.steps && typeof r.setup.steps === "object" ? r.setup.steps : {},
          }
        : base.setup,
    scan:
      r.scan && typeof r.scan === "object"
        ? { ...r.scan, daily: r.scan.daily === true }
        : base.scan,
  };
}

function readFileJson(file: string): RegistryFile | null {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

const cache = new Map<string, { mtimeMs: number; size: number; data: RegistryFile }>();

/** Read the registry (cached by mtime). Never throws. */
export function readRegistry(stateDir: string): RegistryFile {
  const file = registryPath(stateDir);
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(file);
  } catch {
    st = null;
  }
  if (!st) {
    // Missing primary — maybe a crash between rename steps; try the backup.
    return readFileJson(`${file}.bak`) ?? emptyRegistry();
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return structuredClone(hit.data);
  const data = readFileJson(file) ?? readFileJson(`${file}.bak`) ?? emptyRegistry();
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return structuredClone(data);
}

function writeAtomic(file: string, data: RegistryFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {
    /* backup best-effort */
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
  } catch {
    /* directory fsync unsupported on some fs */
  }
  cache.delete(file);
}

// One write chain per registry file.
const chains = new Map<string, Promise<unknown>>();

/**
 * Apply `mutate` to the freshest on-disk registry and persist it atomically.
 * Calls are serialized per file; the mutator may return a value.
 */
export function updateRegistry<T>(stateDir: string, mutate: (reg: RegistryFile) => T): Promise<T> {
  const file = registryPath(stateDir);
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.then(() => {
    cache.delete(file);
    const reg = readRegistry(stateDir);
    const out = mutate(reg);
    writeAtomic(file, reg);
    return out;
  });
  // Keep the chain alive after failures.
  chains.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

// ── Repo keys ─────────────────────────────────────────────────────────

/**
 * Resolve a checkout path to { root, commonDir } without spawning git: walks
 * up to the nearest `.git` (dir or `gitdir:` file) and follows `commondir`.
 */
export function resolveRepoKeySync(dir: string): { root: string; key: string } | null {
  let cur = normalizeRepoPath(dir);
  if (!cur) return null;
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(cur, ".git");
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) return { root: cur, key: realpathSafe(dotGit) };
    if (st?.isFile()) {
      try {
        const m = fs.readFileSync(dotGit, "utf8").match(/gitdir:\s*(.+)/);
        if (m) {
          const gitdir = path.resolve(cur, m[1].trim());
          let common = gitdir;
          try {
            const rel = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
            common = path.resolve(gitdir, rel);
          } catch {
            /* a submodule gitdir has no commondir */
          }
          return { root: cur, key: realpathSafe(common) };
        }
      } catch {
        /* unreadable */
      }
      return null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The main worktree root for a common dir (…/repo/.git → …/repo). */
export function mainRootForKey(key: string): string {
  return path.basename(key) === ".git" ? path.dirname(key) : key;
}

/** Filesystem-safe repo slug: "flypic", "IB-live-release"... */
export function repoSlug(rec: Pick<RepoRecord, "name" | "key">): string {
  const base = (rec.name || path.basename(mainRootForKey(rec.key)) || "repo")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "repo";
}

// ── High-level helpers ────────────────────────────────────────────────

export function ensureRepoRecord(reg: RegistryFile, checkoutPath: string): RepoRecord | null {
  const resolved = resolveRepoKeySync(checkoutPath);
  if (!resolved) return null;
  const now = Date.now();
  const existing = reg.repos[resolved.key];
  if (existing) return existing;
  const root = mainRootForKey(resolved.key);
  const rec: RepoRecord = {
    key: resolved.key,
    name: path.basename(root),
    root,
    addedAt: now,
    updatedAt: now,
  };
  reg.repos[resolved.key] = rec;
  return rec;
}

export function findRepoRecord(reg: RegistryFile, checkoutPath: string): RepoRecord | null {
  const resolved = resolveRepoKeySync(checkoutPath);
  if (!resolved) return null;
  return reg.repos[resolved.key] ?? null;
}

/**
 * Match a binding for a project: by id first, else by name (ids can change
 * when a project moves between the local store and Notion).
 */
export function findBinding(
  reg: RegistryFile,
  projectId: string,
  projectName?: string,
): RepoBinding | null {
  const byId = reg.bindings[projectId];
  if (byId) return byId;
  if (!projectName) return null;
  const want = projectName.trim().toLowerCase();
  const byName = Object.values(reg.bindings).filter(
    (b) => b.projectName.trim().toLowerCase() === want,
  );
  return byName.length === 1 ? byName[0] : null;
}

export function setBinding(
  reg: RegistryFile,
  input: { projectId: string; projectName: string; path: string | null; repoKey?: string },
): RepoBinding {
  const now = Date.now();
  const prev = findBinding(reg, input.projectId, input.projectName);
  if (prev && prev.projectId !== input.projectId) delete reg.bindings[prev.projectId];
  const next: RepoBinding = input.path
    ? {
        projectId: input.projectId,
        projectName: input.projectName,
        path: input.path,
        repoKey: input.repoKey,
        attachedAt: now,
        updatedAt: now,
        rev: (prev?.rev ?? 0) + 1,
        mirrored: false,
      }
    : {
        projectId: input.projectId,
        projectName: input.projectName,
        path: null,
        detachedAt: now,
        detachedPath: prev?.path ?? prev?.detachedPath ?? undefined,
        updatedAt: now,
        rev: (prev?.rev ?? 0) + 1,
        mirrored: false,
      };
  reg.bindings[input.projectId] = next;
  return next;
}
