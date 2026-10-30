/**
 * Per-entry / per-phase git worktree isolation for queue phases, so parallel
 * entries on the same repo never share (and clobber) one working tree.
 *
 *   isolation "entry": one worktree + branch `queue/<id8>` for all phases of
 *                      the entry (phase N sees phase N-1's commits/files).
 *   isolation "phase": a worktree + branch `queue/<id8>-p<N>` per phase,
 *                      branched from the previous phase's branch head (or the
 *                      repo HEAD for the first phase).
 *
 * Worktrees live under `<stateDir>/queue/worktrees/`. Creation is idempotent:
 * an existing worktree dir / branch is reused (restart-safe).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export interface QueueWorktree {
  path: string;
  branch: string;
  repo: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }).trim();
}

/** Top-level of the repo containing `dir`, or null when it isn't a git repo. */
export function repoRoot(dir: string): string | null {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]) || null;
  } catch {
    return null;
  }
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function worktreeRoot(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "queue", "worktrees");
}

/**
 * Ensure a worktree exists for `branch` at `<root>/<dirName>`, created from
 * `base` (a ref) when the branch doesn't exist yet.
 */
export function ensureWorktree(params: {
  repo: string;
  branch: string;
  dirName: string;
  base?: string;
  root?: string;
}): QueueWorktree {
  const root = params.root ?? worktreeRoot();
  mkdirSync(root, { recursive: true });
  const wtPath = path.join(root, params.dirName);
  if (existsSync(path.join(wtPath, ".git"))) {
    return { path: wtPath, branch: params.branch, repo: params.repo };
  }
  // A stale registration (dir deleted by hand) blocks `worktree add`.
  try {
    git(params.repo, ["worktree", "prune"]);
  } catch {
    /* best effort */
  }
  if (branchExists(params.repo, params.branch)) {
    git(params.repo, ["worktree", "add", wtPath, params.branch]);
  } else {
    git(params.repo, ["worktree", "add", "-b", params.branch, wtPath, params.base ?? "HEAD"]);
  }
  return { path: wtPath, branch: params.branch, repo: params.repo };
}

/** Branch + dir names for an entry / phase worktree. */
export function worktreeNames(entryId: string, phaseIdx: number | null) {
  const id8 = entryId.replace(/-/g, "").slice(0, 8);
  return phaseIdx === null
    ? { branch: `queue/${id8}`, dirName: id8 }
    : { branch: `queue/${id8}-p${phaseIdx + 1}`, dirName: `${id8}-p${phaseIdx + 1}` };
}
