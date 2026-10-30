/**
 * Release-publisher configuration + persisted state.
 *
 * Config lives at `<stateDir>/release-publisher.json` (per-user via
 * resolveStateDir) so a non-default profile gets its own settings. The file is
 * optional — sensible defaults apply when it's missing. A companion kill-switch
 * file `<stateDir>/release-publisher.paused` short-circuits the whole daemon.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export interface ReleasePublisherConfig {
  /** Absolute path to the git repo the daemon manages. Defaults to cwd. */
  repoDir: string;
  /** Branch to commit + push to. Defaults to the repo's current branch. */
  branch: string | null;
  /** Git remote name. */
  remote: string;
  /** PR number to post summaries on via `gh pr comment`. null = skip comment. */
  prNumber: number | null;
  /**
   * Only wait on in-flight subagents whose label/task/workdir matches one of
   * these (case-insensitive substring). Empty array = wait on ANY in-flight
   * subagent (the safe default).
   */
  waitProjectHints: string[];
  /**
   * Package manager used for build + pack. "auto" detects pnpm (lockfile) →
   * npm fallback.
   */
  packageManager: "auto" | "pnpm" | "npm";
  /** Run `<pm> build` before committing. Broken builds are never committed. */
  runBuild: boolean;
  /** Verify the npm pack files[] whitelist hasn't dropped a new src/ subdir. */
  checkPackDrift: boolean;
  /** Push committed work to the remote branch. */
  push: boolean;
  /** Per-command timeout for build/pack (ms). */
  buildTimeoutMs: number;
}

export const DEFAULT_RELEASE_PUBLISHER_CONFIG: ReleasePublisherConfig = {
  repoDir: process.cwd(),
  branch: null,
  remote: "origin",
  prNumber: 24,
  waitProjectHints: [],
  packageManager: "auto",
  runBuild: true,
  checkPackDrift: true,
  push: true,
  buildTimeoutMs: 10 * 60_000,
};

/** Path to the per-user config file. */
export function configPath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "release-publisher.json");
}

/** Path to the kill-switch file. Present → daemon skips everything. */
export function pausedFlagPath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "release-publisher.paused");
}

/** True when the kill switch file exists. */
export function isPaused(stateDir = resolveStateDir()): boolean {
  try {
    return fs.existsSync(pausedFlagPath(stateDir));
  } catch {
    return false;
  }
}

/** Load config from disk merged over defaults. Never throws. */
export function loadConfig(stateDir = resolveStateDir()): ReleasePublisherConfig {
  try {
    const raw = fs.readFileSync(configPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ReleasePublisherConfig>;
    return { ...DEFAULT_RELEASE_PUBLISHER_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_RELEASE_PUBLISHER_CONFIG };
  }
}

// ── Persisted run state ──────────────────────────────────────────────

export interface ReleasePublisherState {
  /** HEAD sha after the last successful publish. */
  lastPublishedSha?: string;
  /** ISO timestamp of the last successful publish. */
  lastPublishedAt?: string;
  /** Buckets committed in the last publish. */
  lastScopes?: string[];
  /** Total commits ever pushed by the daemon. */
  totalCommits?: number;
  /** Last structured error (build failure / pack drift). */
  lastError?: { kind: string; message: string; at: string };
}

function statePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "release-publisher.state.json");
}

export function loadState(stateDir = resolveStateDir()): ReleasePublisherState {
  try {
    return JSON.parse(fs.readFileSync(statePath(stateDir), "utf8")) as ReleasePublisherState;
  } catch {
    return {};
  }
}

export function saveState(state: ReleasePublisherState, stateDir = resolveStateDir()): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* best-effort — state is advisory */
  }
}

/** Whether the daemon is in dry-run mode (RELEASE_PUBLISHER_DRY_RUN=1). */
export function isDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RELEASE_PUBLISHER_DRY_RUN ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
