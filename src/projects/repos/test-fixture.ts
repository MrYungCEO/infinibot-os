/**
 * Throwaway git fixture for branch-health tests and the side-gateway e2e.
 *
 * Builds <dir>/app with a deploy branch `release/live` and one branch per
 * case, all committed 30 days in the past (so nothing is "recent"):
 *
 *   feat/merged        merged with --no-ff               → safe (ancestor)
 *   feat/merged-wt     merged, clean worktree             → safe (+ worktree)
 *   feat/squashed      squash-merged                      → safe (content)
 *   feat/squash-edit   squash-merged, file edited again   → safe (squash / patch-id)
 *   feat/picked        cherry-picked                      → safe (cherry)
 *   feat/unmerged      2 commits not in release/live      → review
 *   feat/dirty-wt      merged, worktree with an edit      → review (dirty)
 *   feat/busy-wt       merged, worktree in use            → active (via injected user)
 *   main               default branch                     → protected
 * plus one stash ("fixture stash: half-done idea").
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface FixtureRepo {
  root: string;
  deployBranch: string;
  worktrees: { mergedWt: string; dirtyWt: string; busyWt: string };
  sha: (ref: string) => string;
}

const DAY = 86_400;

export function buildFixtureRepo(dir: string, opts: { daysAgo?: number } = {}): FixtureRepo {
  const root = path.join(dir, "app");
  fs.mkdirSync(root, { recursive: true });
  let clock = Math.floor(Date.now() / 1000) - (opts.daysAgo ?? 30) * DAY;
  const env = () => {
    clock += 60;
    const d = `${clock} +0000`;
    return {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: d,
      GIT_COMMITTER_DATE: d,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: env(), stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  const write = (cwd: string, rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), body);
  };
  const commit = (cwd: string, rel: string, body: string, msg: string) => {
    write(cwd, rel, body);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", msg);
  };

  git(root, "init", "-q", "-b", "main");
  commit(root, "README.md", "# app\n", "init");
  commit(root, "src/a.txt", "a1\n", "a");
  git(root, "branch", "release/live");

  const branchWork = (name: string, files: Array<[string, string]>) => {
    git(root, "checkout", "-q", "-b", name, "release/live");
    for (const [f, b] of files) commit(root, f, b, `${name}: ${f}`);
  };

  branchWork("feat/merged", [["src/merged.txt", "m\n"]]);
  branchWork("feat/merged-wt", [["src/merged-wt.txt", "mw\n"]]);
  branchWork("feat/squashed", [
    ["src/sq.txt", "s1\n"],
    ["src/sq.txt", "s2\n"],
  ]);
  branchWork("feat/squash-edit", [
    ["src/se.txt", "se1\n"],
    ["src/se-notes.txt", "n\n"],
  ]);
  branchWork("feat/picked", [["src/picked.txt", "p\n"]]);
  branchWork("feat/unmerged", [
    ["src/wip.txt", "w1\n"],
    ["src/wip2.txt", "w2\n"],
  ]);
  branchWork("feat/dirty-wt", [["src/dirty.txt", "d\n"]]);
  branchWork("feat/busy-wt", [["src/busy.txt", "b\n"]]);

  git(root, "checkout", "-q", "release/live");
  for (const b of ["feat/merged", "feat/merged-wt", "feat/dirty-wt", "feat/busy-wt"]) {
    git(root, "merge", "-q", "--no-ff", "-m", `merge ${b}`, b);
  }
  git(root, "merge", "-q", "--squash", "feat/squashed");
  git(root, "commit", "-q", "-m", "squash feat/squashed");
  git(root, "merge", "-q", "--squash", "feat/squash-edit");
  git(root, "commit", "-q", "-m", "squash feat/squash-edit");
  // Edit the squash-merged file again so plain content no longer matches.
  commit(root, "src/se.txt", "se1\nmore\n", "later edit to se.txt");
  git(root, "cherry-pick", "-x", git(root, "rev-parse", "feat/picked"));
  git(root, "checkout", "-q", "main");

  // Stash on main.
  write(root, "README.md", "# app\nhalf-done idea\n");
  git(root, "stash", "push", "-q", "-m", "fixture stash: half-done idea");

  const mergedWt = path.join(dir, "app-merged-wt");
  const dirtyWt = path.join(dir, "app-dirty-wt");
  const busyWt = path.join(dir, "app-busy-wt");
  git(root, "worktree", "add", "-q", mergedWt, "feat/merged-wt");
  git(root, "worktree", "add", "-q", dirtyWt, "feat/dirty-wt");
  git(root, "worktree", "add", "-q", busyWt, "feat/busy-wt");
  write(dirtyWt, "src/dirty.txt", "d\nuncommitted\n");

  return {
    root,
    deployBranch: "release/live",
    worktrees: { mergedWt, dirtyWt, busyWt },
    sha: (ref: string) => git(root, "rev-parse", ref),
  };
}
