/**
 * Git helpers for scheduled tasks: read-only ref snapshots for the suggestion
 * phase, and isolated worktrees + diff summaries for the dev phase. Dev work
 * never happens in the reviewed checkout (which may be the owner's shared
 * tree) — every approved item gets its own worktree on its own branch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GoalCheck } from "../goals/types.js";
import type { RepoSpec } from "./types.js";

function git(cwd: string, args: string[], timeoutMs = 20_000): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function isGitRepo(path: string): boolean {
  return existsSync(path) && tryGit(path, ["rev-parse", "--git-dir"]) !== null;
}

/** label → sha of the reviewed branch (HEAD when no branch is set). */
export function snapshotRefs(repos: RepoSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of repos) {
    const sha = tryGit(r.path, ["rev-parse", r.branch || "HEAD"]);
    if (sha) out[r.label] = sha;
  }
  return out;
}

/** Repos whose reviewed branch moved while the read-only review ran. */
export function refViolations(repos: RepoSpec[], before: Record<string, string>): string[] {
  const after = snapshotRefs(repos);
  return Object.keys(before)
    .filter((label) => after[label] && after[label] !== before[label])
    .map((label) => `${label}: ${before[label].slice(0, 8)} → ${after[label].slice(0, 8)}`);
}

export function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "task"
  );
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

/**
 * Create (or re-use after a restart) the item's worktree. Branch:
 * `sched/<task-slug>/<item-id>`, based on the repo's reviewed branch.
 */
export function ensureWorktree(repo: RepoSpec, dir: string, branch: string): Worktree {
  if (!isGitRepo(repo.path)) throw new Error(`not a git repository: ${repo.path}`);
  if (existsSync(dir) && isGitRepo(dir)) {
    const baseSha =
      tryGit(dir, ["merge-base", "HEAD", repo.branch || "HEAD"]) ?? git(dir, ["rev-parse", "HEAD"]);
    return { path: dir, branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), baseSha };
  }
  const baseSha = git(repo.path, ["rev-parse", repo.branch || "HEAD"]);
  mkdirSync(dirname(dir), { recursive: true });
  const exists = tryGit(repo.path, ["rev-parse", "--verify", `refs/heads/${branch}`]) !== null;
  git(
    repo.path,
    exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, baseSha],
    120_000,
  );
  return { path: dir, branch, baseSha };
}

/** Commits + diffstat of the worktree against its base (committed and uncommitted). */
export function diffSummary(worktree: string, baseSha: string): string {
  const log = tryGit(worktree, ["log", "--oneline", "--no-decorate", `${baseSha}..HEAD`]) ?? "";
  const stat = tryGit(worktree, ["diff", "--stat", baseSha]) ?? "";
  const status = tryGit(worktree, ["status", "--porcelain"]) ?? "";
  const parts = [
    log ? `Commits:\n${log}` : "Commits: none",
    stat ? `Diffstat vs ${baseSha.slice(0, 8)}:\n${stat}` : "No diff vs base",
    status ? `Uncommitted:\n${status}` : "",
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 6000);
}

/** Auto-added dev check: the worktree must actually contain a change. */
export function hasChangesCheck(baseSha: string): GoalCheck {
  return {
    id: "has-changes",
    type: "shell",
    label: "worktree has changes vs base",
    command: `test -n "$(git log --oneline ${baseSha}..HEAD)$(git status --porcelain)"`,
  };
}
