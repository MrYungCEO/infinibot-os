/**
 * Baseline runs — "did this check already fail before the run touched anything?"
 *
 * When a claimed-passing check fails on re-run, the reviewer re-runs the same
 * command at the run's base commit in a throwaway worktree. If the base fails
 * too, the failure is pre-existing: reported as a note, never as evidence the
 * run broke something. Dependencies are shared by symlinking node_modules from
 * the run tree (no installs). The temp worktree is always removed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRunCommand, type BaselineRunFn, type RunCommandFn } from "./evidence.js";

const log = createSubsystemLogger("verification.baseline");

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** node_modules dirs in the tree root and its package dirs (depth ≤ 2). */
function nodeModulesDirs(top: string): string[] {
  const out: string[] = [];
  const visit = (rel: string, depth: number) => {
    const abs = path.join(top, rel);
    if (existsSync(path.join(abs, "node_modules"))) out.push(rel);
    if (depth >= 2) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "dist")
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const e of entries.slice(0, 80)) visit(path.join(rel, e), depth + 1);
  };
  visit("", 0);
  return out.slice(0, 60);
}

export function createBaselineRunner(runCommand: RunCommandFn = defaultRunCommand): BaselineRunFn {
  return async ({ command, top, cwd, baseCommit, env, timeoutSec }) => {
    const rel = path.relative(top, cwd);
    if (rel.startsWith("..")) return null;
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ib-review-baseline-"));
    const wt = path.join(tmpRoot, "wt");
    if (git(top, ["worktree", "add", "--detach", wt, baseCommit]) === null) {
      rmSync(tmpRoot, { recursive: true, force: true });
      return null;
    }
    try {
      for (const d of nodeModulesDirs(top)) {
        const target = path.join(wt, d, "node_modules");
        if (!existsSync(path.dirname(target)) || existsSync(target)) continue;
        try {
          symlinkSync(path.join(top, d, "node_modules"), target, "dir");
        } catch {
          /* best effort */
        }
      }
      const runCwd = path.join(wt, rel);
      if (!existsSync(runCwd)) return null;
      const r = await runCommand(command, runCwd, timeoutSec, env);
      if (r.timedOut) return null;
      log.info("baseline run", { command, baseCommit: baseCommit.slice(0, 10), code: r.code });
      return { code: r.code, output: r.output };
    } finally {
      git(top, ["worktree", "remove", "--force", wt]);
      rmSync(tmpRoot, { recursive: true, force: true });
      git(top, ["worktree", "prune"]);
    }
  };
}
