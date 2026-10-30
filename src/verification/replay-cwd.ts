/**
 * Where to replay a claimed check.
 *
 * False "claimed-passing check fails on re-run" verdicts came from replaying
 * commands in the wrong directory: the spawn workdir (/home/…/clawd-main), the
 * repo root for a `ui/` vitest run, or a relative `git -C sibling`. The agent
 * knew where it ran each command; now it says so (`checks_run[].cwd`) and the
 * verifier replays there. When the cwd is missing, it is inferred, in order:
 *
 *   1. declared      checks_run[].cwd (absolute, or relative to the run's tree)
 *   2. claim-cd      a claim ref for the same command that starts `cd X && …`
 *   3. path-args     the first candidate dir where every path-like argument of
 *                    the command exists (run tree, its sub-packages such as
 *                    ui/ or extensions/*, the agent's own working dirs, the
 *                    tree's parent for sibling repos)
 *   4. run-tree      the run's worktree root (previous behaviour)
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ReplayCwdSource = "declared" | "claim-cd" | "path-args" | "agent-dir" | "run-tree";

export interface ReplayCwd {
  cwd: string;
  source: ReplayCwdSource;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$HOME(?=\/|$)/, os.homedir());
}

/** Leading `cd X && rest` → { dir: X, rest }. */
export function splitLeadingCd(command: string): { dir: string | null; rest: string } {
  const m = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*([\s\S]*)$/);
  if (!m) return { dir: null, rest: command };
  return { dir: m[1].replace(/^["']|["']$/g, ""), rest: m[2] };
}

const FLAG_WITH_VALUE = new Set([
  "--config",
  "-c",
  "--project",
  "-p",
  "--reporter",
  "--dir",
  "--root",
  "--outDir",
  "--filter",
  "-t",
  "--testNamePattern",
]);

/**
 * Path-like arguments of a command: tokens with a `/` or a file extension
 * that are not flags, URLs, env assignments or the program itself.
 * `git -C X` / `pnpm -C X` targets are returned separately as dir args.
 */
export function pathArgs(command: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const tokens = command
    .replace(/\s+2>&1|\s+2>\/dev\/null/g, "")
    .split(/\s*(?:&&|\|\||;|\|)\s*/)[0]
    .match(/"[^"]*"|'[^']*'|\S+/g);
  if (!tokens) return { files, dirs };
  let skipNext = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^["']|["']$/g, "");
    if (skipNext) {
      skipNext = false;
      if (tokens[i - 1] === "-C" || tokens[i - 1] === "--dir") dirs.push(t);
      else if (/[/.]/.test(t) && /\.\w{1,6}$/.test(t) && tokens[i - 1] === "--config") files.push(t);
      continue;
    }
    if (t === "-C" || FLAG_WITH_VALUE.has(t)) {
      skipNext = true;
      continue;
    }
    if (i === 0 || t.startsWith("-") || /^[A-Z_][A-Z0-9_]*=/.test(t) || /^\w+:\/\//.test(t)) continue;
    if (/[*?{}$`]/.test(t)) continue;
    // A path: has a slash, or a source-file extension.
    if (/\//.test(t) || /\.(?:[cm]?[jt]sx?|json|py|go|rs|mjs|cjs|css|md|sh)$/.test(t)) {
      if (/^\d+(\.\d+)*$/.test(t)) continue;
      files.push(t);
    }
  }
  return { files, dirs };
}

function allExistUnder(base: string, rels: string[]): boolean {
  return rels.every((r) => existsSync(path.isAbsolute(r) ? r : path.join(base, r)));
}

const subpackageCache = new Map<string, { at: number; dirs: string[] }>();

/** Package roots inside a tree (ui/, apps/x, extensions/y, packages/z), depth ≤ 2. */
export function subpackageDirs(top: string): string[] {
  const hit = subpackageCache.get(top);
  if (hit && Date.now() - hit.at < 60_000) return hit.dirs;
  let listed: string[] = [];
  try {
    listed = execFileSync("git", ["ls-files", "--", "*/package.json", "*/*/package.json"], {
      cwd: top,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    /* not a git repo */
  }
  const dirs = listed
    .map((f) => path.join(top, path.dirname(f)))
    .filter((d) => !/node_modules|\/dist\b|__fixtures__|\/test\//.test(d))
    // ui/ first: it is the most common "ran from a sub-package" case.
    .sort((a, b) => Number(!a.endsWith("/ui")) - Number(!b.endsWith("/ui")) || a.length - b.length)
    .slice(0, 200);
  subpackageCache.set(top, { at: Date.now(), dirs });
  return dirs;
}

/**
 * Decide the directory to replay `command` in. `claimRefs` are the RESULT's
 * claim evidence refs (a ref like `cd ui && npx vitest run x` pins the cwd of
 * a checks_run entry that dropped the `cd`).
 */
export function resolveReplayCwd(input: {
  command: string;
  declaredCwd?: string | null;
  top: string | null;
  fallbackCwd: string | null;
  claimRefs?: string[];
  agentDirs?: string[];
}): ReplayCwd | null {
  const base = input.top ?? input.fallbackCwd;
  const resolveDir = (d: string, from: string | null): string | null => {
    const e = expandHome(d);
    const abs = path.isAbsolute(e) ? e : from ? path.join(from, e) : null;
    return abs && isDir(abs) ? path.resolve(abs) : null;
  };

  // 1. declared by the agent
  if (input.declaredCwd) {
    const d = resolveDir(input.declaredCwd, base);
    if (d) return { cwd: d, source: "declared" };
  }

  const { dir: leadingCd, rest } = splitLeadingCd(input.command);
  // A command that cds itself: the shell does it, relative to our base.
  if (leadingCd && base) {
    return { cwd: base, source: "run-tree" };
  }

  // 2. a claim ref with the same command and a leading cd
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const ref of input.claimRefs ?? []) {
    const { dir, rest: refRest } = splitLeadingCd(ref);
    if (!dir) continue;
    const a = norm(refRest);
    const b = norm(rest);
    if (!a || !b || !(a === b || a.includes(b) || b.includes(a))) continue;
    const d = resolveDir(dir, base);
    if (d) return { cwd: d, source: "claim-cd" };
  }

  // 3. where every path-like argument exists
  const { files, dirs } = pathArgs(rest);
  const rels = [...files, ...dirs];
  if (rels.length > 0) {
    const candidates: Array<{ dir: string; source: ReplayCwdSource }> = [];
    if (base) candidates.push({ dir: base, source: "run-tree" });
    if (input.top) for (const s of subpackageDirs(input.top)) candidates.push({ dir: s, source: "path-args" });
    for (const a of input.agentDirs ?? []) if (isDir(a)) candidates.push({ dir: a, source: "agent-dir" });
    if (input.top) candidates.push({ dir: path.dirname(input.top), source: "path-args" });
    for (const c of candidates) {
      if (allExistUnder(c.dir, rels)) return { cwd: c.dir, source: c.source };
    }
  }

  // 4. the run tree
  if (base && isDir(base)) return { cwd: base, source: "run-tree" };
  const agent = (input.agentDirs ?? []).find(isDir);
  return agent ? { cwd: agent, source: "agent-dir" } : null;
}

export function resetReplayCwdCacheForTests(): void {
  subpackageCache.clear();
}
