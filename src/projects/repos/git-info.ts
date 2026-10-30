/**
 * Project repos — git inspection helpers.
 *
 * A project's repo binding is its existing `projectDirectory` field (local
 * SQLite row + the Notion "Project Directory" property). These helpers turn
 * such a path into a small status card: repo root, branch, origin remote,
 * last commit, dirty count and ahead/behind against the upstream.
 *
 * Every git call is read-only, has a short timeout and never prompts
 * (GIT_TERMINAL_PROMPT=0, no fetch), so a slow network or a broken repo can
 * never block an RPC for long. Results are cached briefly per path.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoCommit {
  sha: string;
  subject: string;
  /** Unix ms. */
  at: number;
  author?: string;
}

export interface RepoInfo {
  /** The path as given (normalised). */
  path: string;
  /** `git rev-parse --show-toplevel`, or null when not a repo. */
  root: string | null;
  isRepo: boolean;
  name: string;
  branch?: string;
  detached?: boolean;
  remote?: string;
  /** Pretty "owner/name" when the origin remote is a GitHub-style URL. */
  remoteSlug?: string;
  lastCommit?: RepoCommit;
  /** Number of changed/untracked entries in `git status --porcelain`. */
  dirtyCount?: number;
  dirty?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** True when the path is a linked worktree (its .git is a file). */
  worktree?: boolean;
  error?: string;
  checkedAt: number;
}

const GIT_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 15_000;

const cache = new Map<string, { at: number; info: Promise<RepoInfo> }>();

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function normalizeRepoPath(p: string): string {
  const expanded = expandHome(String(p ?? "").trim());
  if (!expanded) return "";
  const abs = path.resolve(expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
}

// Cap concurrent git processes: the picker can inspect dozens of checkouts
// at once and each inspection spawns ~5 git commands.
const MAX_GIT_PROCS = 10;
let activeGit = 0;
const gitQueue: Array<() => void> = [];

function acquireGit(): Promise<void> {
  if (activeGit < MAX_GIT_PROCS) {
    activeGit++;
    return Promise.resolve();
  }
  return new Promise((resolve) => gitQueue.push(resolve));
}

function releaseGit(): void {
  const next = gitQueue.shift();
  if (next) next();
  else activeGit--;
}

export async function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  await acquireGit();
  try {
    return await spawnGit(cwd, args, opts);
  } finally {
    releaseGit();
  }
}

function spawnGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "--no-optional-locks", ...args],
      {
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** "git@github.com:me/app.git" / "https://github.com/me/app" → "me/app". */
export function remoteSlug(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const m = remote.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Strip credentials from an https remote before it leaves the gateway. */
export function redactRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  return remote.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

async function inspectUncached(p: string): Promise<RepoInfo> {
  const now = Date.now();
  const base: RepoInfo = {
    path: p,
    root: null,
    isRepo: false,
    name: path.basename(p) || p,
    checkedAt: now,
  };
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return { ...base, error: "not a directory" };
  } catch {
    return { ...base, error: "path does not exist" };
  }
  const top = await runGit(p, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout.trim()) return { ...base, error: "not a git repository" };
  const root = top.stdout.trim();
  const info: RepoInfo = { ...base, root, isRepo: true, name: path.basename(root) };
  try {
    info.worktree = fs.statSync(path.join(root, ".git")).isFile();
  } catch {
    /* ignore */
  }

  const [head, remote, log, status, upstream] = await Promise.all([
    runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(root, ["remote", "get-url", "origin"]),
    runGit(root, ["log", "-1", "--format=%H%x1f%s%x1f%ct%x1f%an"]),
    runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"], {
      timeoutMs: 6000,
    }),
    runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);

  if (head.ok && head.stdout.trim()) {
    info.branch = head.stdout.trim();
  } else {
    const short = await runGit(root, ["rev-parse", "--short", "HEAD"]);
    info.detached = true;
    info.branch = short.ok ? short.stdout.trim() : undefined;
  }
  if (remote.ok && remote.stdout.trim()) {
    info.remote = redactRemote(remote.stdout.trim());
    info.remoteSlug = remoteSlug(info.remote);
  }
  if (log.ok && log.stdout.trim()) {
    const [sha, subject, ct, author] = log.stdout.trim().split("\x1f");
    info.lastCommit = { sha, subject: subject ?? "", at: Number(ct) * 1000, author };
  }
  if (status.ok) {
    const lines = status.stdout.split("\n").filter((l) => l.trim() !== "");
    info.dirtyCount = lines.length;
    info.dirty = lines.length > 0;
  }
  if (upstream.ok && upstream.stdout.trim()) {
    info.upstream = upstream.stdout.trim();
    const counts = await runGit(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (counts.ok) {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(ahead)) info.ahead = ahead;
      if (Number.isFinite(behind)) info.behind = behind;
    }
  }
  return info;
}

/** Inspect a directory; cached for 15 s unless `fresh`. */
export function inspectRepo(rawPath: string, opts: { fresh?: boolean } = {}): Promise<RepoInfo> {
  const p = normalizeRepoPath(rawPath);
  if (!p) {
    return Promise.resolve({
      path: "",
      root: null,
      isRepo: false,
      name: "",
      error: "path is required",
      checkedAt: Date.now(),
    });
  }
  const hit = cache.get(p);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
  const info = inspectUncached(p);
  cache.set(p, { at: Date.now(), info });
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return info;
}

export function invalidateRepoInfo(rawPath?: string): void {
  if (!rawPath) {
    cache.clear();
    return;
  }
  cache.delete(normalizeRepoPath(rawPath));
}

/** Cheap synchronous "is this a git checkout root" check (no git spawn). */
export function hasGitDir(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}
