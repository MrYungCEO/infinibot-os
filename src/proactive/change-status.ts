/**
 * Change-status detection for completion overlays.
 *
 * Derives two indicators for a finished agent/task run, server-side, so the
 * completion pop-up can show forward-action affordances:
 *   - commitStatus : is the change committed in git (and pushed)?  Derived from
 *                    `git status --porcelain` scoped to the changed paths, plus
 *                    `rev-list @{upstream}..HEAD` for the pushed flag.
 *   - buildStatus  : has the UI been rebuilt after the change?  Heuristic:
 *                    compare the newest changed `ui/src/**` file mtime against
 *                    the UI build marker (`ui/dist/index.html`). If the source
 *                    is newer than the marker → unbuilt. A change that touches
 *                    no UI source needs no build → reported `built`.
 *
 * Every helper is guarded and NEVER throws — a missing repo / absent git / no
 * dist folder degrades to a sensible default instead of breaking emit.
 */

import { execFileSync } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

export type BuildStatus = "built" | "unbuilt";
export type CommitStatus = "committed" | "uncommitted";

export interface ChangeStatus {
  buildStatus: BuildStatus;
  commitStatus: CommitStatus;
  /** True only when committed AND an upstream exists AND HEAD is not ahead. */
  pushed: boolean;
  /** Current branch (best-effort; "" when undetectable). */
  branch: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    // Isolate git env (avoid hook/env contamination), like server-methods/git.ts.
    const env = { ...process.env } as Record<string, string | undefined>;
    for (const k of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ])
      delete env[k];
    env.HUSKY = "0";
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 6000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: env as NodeJS.ProcessEnv,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Repo root for a workdir, or null when it isn't a git repo. */
export function repoRoot(workdir: string): string | null {
  return git(["rev-parse", "--show-toplevel"], workdir);
}

/**
 * Commit status scoped to `paths` (relative to the repo). When `paths` is empty
 * the whole tree is inspected. Uncommitted = any porcelain output for the scope.
 */
export function computeCommitStatus(
  workdir: string,
  paths: string[] = [],
): { commitStatus: CommitStatus; pushed: boolean; branch: string } {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], workdir) ?? "";
  // Scope porcelain to the changed paths so unrelated dirt in a shared tree
  // (the daemon churn on this repo) doesn't mislabel a committed change.
  const args = ["status", "--porcelain=v1"];
  const scoped = paths.filter((p) => typeof p === "string" && p.trim());
  if (scoped.length) args.push("--", ...scoped);
  const porcelain = git(args, workdir);
  if (porcelain == null) {
    // Not a git repo / git absent — can't prove committed, so surface as such.
    return { commitStatus: "uncommitted", pushed: false, branch };
  }
  const dirty = porcelain.split("\n").some((l) => l.trim().length > 0);
  const commitStatus: CommitStatus = dirty ? "uncommitted" : "committed";

  let pushed = false;
  if (!dirty) {
    const ahead = git(["rev-list", "--count", "@{upstream}..HEAD"], workdir);
    // ahead === null → no upstream configured → treat as not-pushed (has remote work to do).
    pushed = ahead != null && Number(ahead) === 0;
  }
  return { commitStatus, pushed, branch };
}

/** Files under the UI source tree that would require a `pnpm -C ui build`. */
function uiSourcePaths(paths: string[]): string[] {
  return paths.filter((p) => /(^|\/)ui\/src\//.test(p) || /(^|\/)ui\/index\.html$/.test(p));
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Build status heuristic. Returns "built" when the change touches no UI source
 * (nothing to rebuild) or when the dist marker is newer than every changed UI
 * source file; "unbuilt" when a UI source file is newer than the marker (or the
 * marker is missing).
 */
export function computeBuildStatus(
  repo: string,
  paths: string[] = [],
): BuildStatus {
  const uiPaths = uiSourcePaths(paths);
  if (uiPaths.length === 0) return "built"; // no UI change → no build owed

  // The control UI is built by `pnpm -C ui build` into <repo>/dist/control-ui
  // (see ui/vite.config.ts outDir). index.html is rewritten on every build, so
  // its mtime is the reliable "last built" marker.
  const marker = ["dist/control-ui/index.html", "dist/control-ui", "ui/dist/index.html"]
    .map((m) => resolve(repo, m))
    .find(existsSync);
  if (!marker) return "unbuilt"; // never built

  const markerMtime = mtimeOf(marker);
  const newestChange = Math.max(
    0,
    ...uiPaths.map((p) => mtimeOf(isAbsolute(p) ? p : resolve(repo, p))),
  );
  // If we couldn't stat any changed file (deleted / moved), fall back to built
  // — we have no evidence the source is newer than the marker.
  if (newestChange === 0) return "built";
  return markerMtime >= newestChange ? "built" : "unbuilt";
}

/** Combined build + commit status for a finished run's changed paths. */
export function computeChangeStatus(
  workdir: string | undefined,
  paths: string[] = [],
): ChangeStatus {
  const wd = workdir && workdir.trim() ? workdir : process.cwd();
  const root = repoRoot(wd) ?? wd;
  const { commitStatus, pushed, branch } = computeCommitStatus(wd, paths);
  const buildStatus = computeBuildStatus(root, paths);
  return { buildStatus, commitStatus, pushed, branch };
}
