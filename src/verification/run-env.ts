/**
 * Where and how the verifier re-runs a run's claimed checks.
 *
 * Coder briefs make agents work in their OWN worktree branch, while the
 * completion record's `workdir` is where the run was spawned (usually the
 * owner's checkout). Re-running `pnpm build` or checking commits there tests
 * the wrong tree, and the gateway daemon's stripped PATH (system Node 20, no
 * node_modules/.bin) makes every re-run fail for reasons that say nothing about
 * the agent's work. This module:
 *
 *   resolveRunWorkspace   finds the worktree the run actually worked in
 *   resolveNodeBinDir     picks a Node that satisfies the repo's .nvmrc/engines
 *   buildRerunEnv         PATH = <dir>/node_modules/.bin + that Node + a sane
 *                         fallback; HOME kept, secrets scrubbed
 *   environmentProblem    tells "could not run here" apart from "ran and failed"
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunResult } from "./contract.js";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

// ── workspace ───────────────────────────────────────────────────────────────

export interface RunWorkspace {
  /** Git toplevel the run worked in (null when nothing is a git repo). */
  top: string | null;
  /** How it was found. */
  source: "commits" | "result-paths" | "agent-dirs" | "workdir" | "none";
  branch: string | null;
  /** True when the run's tree differs from the record's spawn workdir. */
  isSeparateWorktree: boolean;
}

/** Leading `cd X`, `git -C X`, `pnpm -C X`, and absolute file paths named in a RESULT. */
export function pathsNamedInResult(result: RunResult | null): string[] {
  if (!result) return [];
  const out: string[] = [];
  const texts = [
    ...result.checks_run.map((c) => c.command),
    ...result.claims.map((c) => c.evidence_ref),
  ];
  for (const t of texts) {
    for (const m of t.matchAll(/(?:^|&&\s*|;\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g))
      out.push(m[1].replace(/^["']|["']$/g, ""));
    for (const m of t.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g))
      out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  for (const f of result.files_changed) if (path.isAbsolute(f)) out.push(path.dirname(f));
  return out
    .map((p) => p.replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$HOME(?=\/|$)/, os.homedir()))
    .filter((p) => path.isAbsolute(p));
}

function toplevelOf(dir: string): string | null {
  let d = dir;
  // Walk up to an existing directory (files_changed may name new dirs).
  while (d && !existsSync(d) && d !== path.dirname(d)) d = path.dirname(d);
  return existsSync(d) ? git(d, ["rev-parse", "--show-toplevel"]) : null;
}

export function listWorktrees(repoDir: string): string[] {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  return (out ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter((p) => existsSync(p));
}

function containsAll(top: string, shas: string[]): boolean {
  return shas.every((s) => git(top, ["merge-base", "--is-ancestor", s, "HEAD"]) !== null);
}

/**
 * Find the tree the run worked in:
 *   1. claimed commits → the candidate whose HEAD contains all of them
 *      (explicit paths from the RESULT first, then every worktree of the repo)
 *   2. no commits → the first git repo named in the RESULT's commands/paths
 *   3. fall back to the record's workdir
 */
export function resolveRunWorkspace(input: {
  workdir: string | null | undefined;
  result: RunResult | null;
  /** Directories the agent worked in (transcript cwd / cd targets / edited files). */
  agentDirs?: string[];
  /** ms epoch the run started (scores candidates by files changed since then). */
  runStartedAt?: number;
}): RunWorkspace {
  const workdirTop = input.workdir && existsSync(input.workdir) ? toplevelOf(input.workdir) : null;
  const named: string[] = [];
  for (const p of pathsNamedInResult(input.result)) {
    const t = toplevelOf(p);
    if (t && !named.includes(t)) named.push(t);
  }
  // The agent's own working dirs come after the RESULT's explicit paths.
  const agentTops: string[] = [];
  for (const d of input.agentDirs ?? []) {
    if (!path.isAbsolute(d)) continue;
    const t = toplevelOf(d);
    if (t && !named.includes(t) && !agentTops.includes(t)) agentTops.push(t);
  }
  const mk = (top: string | null, source: RunWorkspace["source"]): RunWorkspace => ({
    top,
    source,
    branch: top ? git(top, ["rev-parse", "--abbrev-ref", "HEAD"]) : null,
    isSeparateWorktree: Boolean(
      top && workdirTop && path.resolve(top) !== path.resolve(workdirTop),
    ),
  });

  const anchor = workdirTop ?? named[0] ?? agentTops[0] ?? null;
  const commits = (input.result?.commits ?? [])
    .map((s) => {
      for (const a of [anchor, ...named, ...agentTops]) {
        if (!a) continue;
        const full = git(a, ["rev-parse", "--verify", "--quiet", `${s}^{commit}`]);
        if (full) return full;
      }
      return null;
    })
    .filter((s): s is string => Boolean(s));
  if (commits.length > 0 && anchor) {
    const candidates = [...named, ...agentTops];
    for (const base of [anchor, ...agentTops])
      for (const w of listWorktrees(base)) if (!candidates.includes(w)) candidates.push(w);
    // The spawn workdir last: a commit on the owner's branch is fine, but a
    // dedicated worktree that also contains it is the better match.
    if (workdirTop) {
      const i = candidates.indexOf(workdirTop);
      if (i >= 0) candidates.splice(i, 1);
      candidates.push(workdirTop);
    }
    const hit = candidates.find((c) => containsAll(c, commits));
    if (hit) return mk(hit, hit === workdirTop ? "workdir" : "commits");
  }
  if (named.length > 0) {
    // Prefer a named tree that is not the spawn workdir — that's the agent's worktree.
    const other = named.find((n) => n !== workdirTop);
    return mk(other ?? named[0], other ? "result-paths" : "workdir");
  }
  // No commits and no explicit paths: the tree whose working changes match
  // the claimed (repo-relative) files_changed best — among the agent's dirs
  // and the spawn workdir.
  const relClaimed = (input.result?.files_changed ?? []).filter((f) => !path.isAbsolute(f));
  const pool = [...agentTops, ...(workdirTop && !agentTops.includes(workdirTop) ? [workdirTop] : [])];
  if (relClaimed.length > 0 && pool.length > 0) {
    let best: { top: string; score: number } | null = null;
    for (const top of pool) {
      const score = changedFilesScore(top, relClaimed, input.runStartedAt);
      if (score > 0 && (!best || score > best.score)) best = { top, score };
    }
    if (best) return mk(best.top, best.top === workdirTop ? "workdir" : "agent-dirs");
  }
  if (agentTops.length > 0 && (!workdirTop || !isGitRepoWithChanges(workdirTop))) {
    return mk(agentTops[0], "agent-dirs");
  }
  return workdirTop ? mk(workdirTop, "workdir") : mk(null, "none");
}

/** How many of `rels` show a change in `top` (working tree, or commits since the run start). */
export function changedFilesScore(top: string, rels: string[], since?: number): number {
  const changed = new Set<string>();
  for (const line of (git(top, ["status", "--porcelain", "--untracked-files=all"]) ?? "").split("\n")) {
    const f = line.slice(3).trim().replace(/^"|"$/g, "");
    if (f) changed.add(f.includes(" -> ") ? f.split(" -> ")[1] : f);
  }
  if (since) {
    const log = git(top, ["log", `--since=@${Math.floor(since / 1000) - 60}`, "--name-only", "--format="]);
    for (const f of (log ?? "").split("\n")) if (f.trim()) changed.add(f.trim());
  }
  return rels.filter((r) => changed.has(r.replace(/^\.\//, ""))).length;
}

function isGitRepoWithChanges(top: string): boolean {
  return Boolean(git(top, ["status", "--porcelain"]));
}

// ── node selection ──────────────────────────────────────────────────────────

type Ver = [number, number, number];

function parseVer(v: string): Ver | null {
  const m = v
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!m) return null;
  const n = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : 0);
  return [Number(m[1]), n(m[2]), n(m[3])];
}

function cmp(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function satisfiesComparator(v: Ver, c: string): boolean {
  const m = c.match(/^(>=|<=|>|<|=|\^|~)?\s*v?(.+)$/);
  if (!m) return false;
  const op = m[1] ?? "";
  const raw = m[2];
  const t = parseVer(raw);
  if (!t) return raw === "*" || raw === "x";
  const parts = raw.split(".").filter((p) => /^\d+$/.test(p)).length;
  switch (op) {
    case ">=":
      return cmp(v, t) >= 0;
    case ">":
      return cmp(v, t) > 0;
    case "<=":
      return cmp(v, t) <= 0;
    case "<":
      return cmp(v, t) < 0;
    case "^":
      return cmp(v, t) >= 0 && v[0] === t[0];
    case "~":
      return cmp(v, t) >= 0 && v[0] === t[0] && (parts < 2 || v[1] === t[1]);
    default:
      // Bare / "=": `22` means 22.x.x, `22.12` means 22.12.x.
      return v[0] === t[0] && (parts < 2 || v[1] === t[1]) && (parts < 3 || v[2] === t[2]);
  }
}

/** Tiny semver range check: `>=22.12.0`, `^22`, `22`, `>=20 <23`, `18 || >=22`. */
export function versionSatisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  return range
    .split("||")
    .map((r) => r.trim())
    .some((r) => {
      if (!r || r === "*") return true;
      const hyphen = r.match(/^(\S+)\s+-\s+(\S+)$/);
      if (hyphen)
        return satisfiesComparator(v, `>=${hyphen[1]}`) && satisfiesComparator(v, `<=${hyphen[2]}`);
      return r
        .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
        .split(/\s+/)
        .every((c) => satisfiesComparator(v, c));
    });
}

/** Node requirements for a tree (.nvmrc and package.json engines.node); all must hold. */
export function nodeRequirements(top: string): string[] {
  const out: string[] = [];
  try {
    const nvmrc = readFileSync(path.join(top, ".nvmrc"), "utf8").trim().replace(/^v/, "");
    if (/^\d/.test(nvmrc)) out.push(nvmrc);
  } catch {
    /* no .nvmrc */
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(top, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const engines = pkg.engines?.node?.trim();
    if (engines) out.push(engines);
  } catch {
    /* no package.json */
  }
  return out;
}

export interface NodeChoice {
  binDir: string;
  version: string;
}

/** Candidate Node installs: nvm versions, the gateway's own Node. Injectable for tests. */
export function nodeCandidates(): NodeChoice[] {
  const out: NodeChoice[] = [];
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
  const base = path.join(nvmDir, "versions", "node");
  try {
    for (const d of readdirSync(base)) {
      const bin = path.join(base, d, "bin");
      if (existsSync(path.join(bin, "node")))
        out.push({ binDir: bin, version: d.replace(/^v/, "") });
    }
  } catch {
    /* no nvm */
  }
  out.push({ binDir: path.dirname(process.execPath), version: process.versions.node });
  return out;
}

/**
 * Highest installed Node satisfying the tree's requirement, or null when
 * nothing does (or there is no requirement — then PATH order decides).
 */
export function resolveNodeBinDir(
  top: string | null,
  candidates: NodeChoice[] = nodeCandidates(),
): NodeChoice | null {
  if (!top) return null;
  const reqs = nodeRequirements(top);
  if (reqs.length === 0) return null;
  const ok = (v: string) => reqs.every((r) => versionSatisfies(v, r));
  const fits = candidates.filter((c) => ok(c.version));
  fits.sort((a, b) => cmp(parseVer(b.version)!, parseVer(a.version)!));
  return fits[0] ?? null;
}

// ── env ─────────────────────────────────────────────────────────────────────

const SECRET_ENV_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|COOKIE|SESSION|AUTH|DSN|DATABASE_URL|CONNECTION_STRING|WEBHOOK|_KEY$)/i;

/** Keys that match the secret pattern but are needed and harmless. */
const KEEP_ENV = new Set([
  "SSH_AUTH_SOCK",
  "XDG_SESSION_TYPE",
  "XDG_SESSION_CLASS",
  "XDG_SESSION_DESKTOP",
]);

export function scrubSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SECRET_ENV_RE.test(k) && !KEEP_ENV.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Directories a command `cd`s into, resolved against cwd (in order). */
export function cdTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  let cur = cwd;
  for (const seg of command.split(/\s*&&\s*/)) {
    const m = seg.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*$/);
    if (!m) continue;
    const target = m[1]
      .replace(/^["']|["']$/g, "")
      .replace(/^~(?=\/|$)/, os.homedir())
      .replace(/^\$HOME(?=\/|$)/, os.homedir());
    cur = path.resolve(cur, target);
    out.push(cur);
  }
  return out;
}

export function buildRerunEnv(params: {
  command: string;
  cwd: string;
  top: string | null;
  node: NodeChoice | null;
  baseEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const base = scrubSecrets(params.baseEnv ?? process.env);
  const home = base.HOME || os.homedir();
  const bins: string[] = [];
  const push = (d: string | null | undefined) => {
    if (d && !bins.includes(d)) bins.push(d);
  };
  // The innermost `cd` target's local bins win (e.g. `cd ui && vitest`).
  for (const d of cdTargets(params.command, params.cwd).reverse())
    push(path.join(d, "node_modules", ".bin"));
  push(path.join(params.cwd, "node_modules", ".bin"));
  if (params.top) push(path.join(params.top, "node_modules", ".bin"));
  push(params.node?.binDir);
  for (const p of (base.PATH ?? "").split(":")) push(p);
  for (const p of [
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ])
    push(p);
  return {
    ...base,
    HOME: home,
    PATH: bins.join(":"),
    INFINIBOT_VERIFY_RERUN: "1",
    CI: "1",
    FORCE_COLOR: "0",
  };
}

/** `PATH=… FOO=bar pnpm build` → `pnpm build` (the verifier sets PATH itself). */
export function stripEnvPrefix(command: string): string {
  return command
    .split(/(\s*&&\s*)/)
    .map((seg) => seg.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)+/, ""))
    .join("");
}

// ── environment failures ────────────────────────────────────────────────────

const NODE_TOOL_RE =
  /(^|&&\s*|\|\s*)(pnpm|npm|npx|yarn|bun|vitest|jest|tsc|eslint|biome|oxlint|node)\b/;

/**
 * The checkout the running gateway serves from (its dist/ and control UI).
 * Re-running a build there would overwrite the live gateway's files mid-flight.
 */
export function liveGatewayRoot(): string | null {
  if (process.env.INFINIBOT_LIVE_ROOT) return path.resolve(process.env.INFINIBOT_LIVE_ROOT);
  try {
    // <root>/dist/verification/run-env.js or <root>/src/verification/run-env.ts
    const here = path.dirname(new URL(import.meta.url).pathname);
    const root = path.resolve(here, "..", "..");
    return existsSync(path.join(root, "package.json")) ? root : null;
  } catch {
    return null;
  }
}

const BUILD_CMD_RE = /\b(?:pnpm|npm|yarn|bun)(?:\s+-C\s+\S+|\s+--filter\s+\S+|\s+--dir\s+\S+)?\s+(?:run\s+)?build\b/;

/** Reason a build must not be replayed in `cwd` (it is the live gateway's checkout), else null. */
export function liveTreeBuildProblem(command: string, cwd: string | null): string | null {
  if (!cwd || !BUILD_CMD_RE.test(command)) return null;
  const live = liveGatewayRoot();
  if (!live) return null;
  const top = toplevelOf(cwd) ?? cwd;
  if (path.resolve(top) !== live) return null;
  return `not re-run: a build here would overwrite the running gateway's dist (${live})`;
}

/** package.json exists and declares packages to install (a dep-free package needs no node_modules). */
function declaresDependencies(pkgPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some(
      (k) => pkg[k] && typeof pkg[k] === "object" && Object.keys(pkg[k] as object).length > 0,
    );
  } catch {
    return false;
  }
}

/** Pre-flight: reasons the command cannot run in this tree at all. */
export function preflightProblem(
  command: string,
  cwd: string | null,
  top: string | null,
): string | null {
  if (!cwd || !existsSync(cwd)) return `worktree ${cwd ?? "(unknown)"} no longer exists`;
  const live = liveTreeBuildProblem(command, cwd);
  if (live) return live;
  for (const d of cdTargets(command, cwd))
    if (!existsSync(d)) return `directory ${d} does not exist`;
  if (NODE_TOOL_RE.test(command) && declaresDependencies(path.join(top ?? cwd, "package.json"))) {
    if (!existsSync(path.join(top ?? cwd, "node_modules")))
      return `node_modules missing in ${top ?? cwd} (dependencies not installed)`;
  }
  return null;
}

const ENV_PATTERNS: Array<[RegExp, string]> = [
  [
    /command not found|: not found\b|No such file or directory.*\b(vitest|jest|tsc|pnpm|npx|node)\b/i,
    "command not found",
  ],
  [
    /ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported engine|Expected version: .*\n?.*Got: v?\d|engines\.node/i,
    "Node version does not satisfy the repo's engines",
  ],
  [/ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL.*not found|Command "[^"]+" not found/i, "command not found"],
  [
    /node_modules (?:is )?missing|Local package\.json exists, but node_modules missing/i,
    "node_modules missing",
  ],
  [
    /Cannot find module '[^']*node_modules\/\.bin|Cannot find module '[^']*\/(vitest|typescript|jest)\/[^']*'/i,
    "tooling not installed",
  ],
  [/spawn \S+ ENOENT/i, "shell/tool binary missing"],
  [/ENOSPC|no space left on device/i, "host disk is full (ENOSPC)"],
  // Replayed from a directory where the agent's relative paths do not exist.
  [
    /No test files found, exiting with code 1/i,
    "the test filter matched no files in this directory (replayed from the wrong cwd)",
  ],
  [
    /fatal: cannot change to '[^']+': No such file or directory/i,
    "a relative directory in the command does not exist here (replayed from the wrong cwd)",
  ],
  [/ENOMEM|JavaScript heap out of memory|Cannot allocate memory/i, "host out of memory"],
  // The ref was prose, not a runnable command (e.g. "pnpm build (node22)").
  [
    /^bash: (?:-c: )?line \d+: syntax error|syntax error near unexpected token/m,
    "evidence ref is not a runnable shell command (bash syntax error)",
  ],
];

/**
 * Classify a finished re-run: a string reason when it failed because the
 * command could not run here (not evidence against the claim), else null.
 */
export function environmentProblem(r: { code: number | null; output: string }): string | null {
  if (r.code === 0) return null;
  if (r.code === 127) return "command not found (exit 127)";
  // Vitest finished every test green but a leaked handle kept it alive past
  // teardown — the exit code reflects the host, not the tests.
  if (
    /Tests closed successfully but something prevents (?:Vite server|the main process) from exiting/i.test(
      r.output,
    ) &&
    !/\b[1-9]\d* failed\b/i.test(r.output)
  )
    return "vitest passed but did not exit (hanging handle after teardown)";
  for (const [re, why] of ENV_PATTERNS) if (re.test(r.output)) return why;
  return null;
}
