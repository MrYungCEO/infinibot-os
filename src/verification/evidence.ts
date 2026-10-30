/**
 * Deterministic evidence checks — the part of the review that does not need
 * a model. Every claim in a RESULT block is checked against something real:
 *
 *   commits        exist and are on the run's OWN branch (ancestor of the run
 *                  worktree's HEAD — not the owner's checkout)
 *   files_changed  match that branch's diff vs the base commit
 *   checks_run     cheap + safe build/test commands are re-run in the run's
 *                  worktree with its node_modules/.bin and a Node matching the
 *                  repo's engines; "could not run here" (exit 127, engines
 *                  mismatch, missing deps/worktree) is an environment warning,
 *                  never a failed claim
 *   screenshots    exist, are non-empty images, and are newer than the run start
 *   claims         each claim's evidence_ref resolves to one of the above
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { partitionConsoleMessages } from "./console-noise.js";
import type { ResultCheck, RunResult } from "./contract.js";
import {
  expandEvidenceGlob,
  extractPathRefs,
  inspectEvidenceFile,
  resolveEvidencePath,
  worstStatus,
  type EvidenceFileCheck,
} from "./evidence-files.js";
import {
  buildRerunEnv,
  environmentProblem,
  preflightProblem,
  resolveNodeBinDir,
  resolveRunWorkspace,
  stripEnvPrefix,
  type NodeChoice,
  type RunWorkspace,
} from "./run-env.js";
import { resolveReplayCwd, type ReplayCwdSource } from "./replay-cwd.js";
import { resolveScreenshotRef, runVisualCaptures } from "./screenshot-resolve.js";

export type EvidenceStatus = "pass" | "fail" | "warn" | "skipped";

export interface EvidenceItem {
  kind: "commit" | "files" | "command" | "screenshot" | "claim" | "visual";
  ref: string;
  status: EvidenceStatus;
  detail: string;
  /** The check could not be re-run for environmental reasons (not evidence against the claim). */
  environment?: boolean;
  /** Bounded content of referenced evidence files (JSON summary / log tail) for the LLM reviewer. */
  excerpt?: string;
  /** Directory a command was replayed in. */
  cwd?: string;
  /** The failure also happens at the base commit (proven by a baseline run). */
  baseline?: boolean;
}

export interface EvidenceReport {
  items: EvidenceItem[];
  /** Files git says changed since the run started (repo-relative). */
  actualChangedFiles: string[];
  /** Commits added on HEAD since the base commit. */
  actualCommits: string[];
  /** `git diff --stat` + truncated patch since the base, for the LLM reviewer. */
  diffText: string;
  failures: number;
  warnings: number;
  /** The tree the run worked in (may differ from the record's spawn workdir). */
  workspace: RunWorkspace;
  /** Checks that could not be re-run for environmental reasons. */
  environmentSkips: number;
}

export type BaselineRunFn = (p: {
  command: string;
  top: string;
  cwd: string;
  baseCommit: string;
  env: Record<string, string>;
  timeoutSec: number;
}) => Promise<{ code: number | null; output: string } | null>;

export type RunCommandFn = (
  command: string,
  cwd: string,
  timeoutSec: number,
  env?: Record<string, string>,
) => Promise<{ code: number | null; output: string; timedOut: boolean }>;

export interface EvidenceInput {
  workdir: string | null | undefined;
  /** Run id — resolves visual_verify captures (`<stateDir>/verification/<runId>/visual-*`). */
  runId?: string | null;
  /** Directories the agent worked in (transcript), for workspace + replay-cwd resolution. */
  agentDirs?: string[];
  /** visual_verify capture dirs seen in the agent's transcript. */
  visualDirs?: string[];
  /**
   * Re-run a command at the base commit (temp worktree) to tell a pre-existing
   * failure from one the run introduced. Null result = could not run a baseline.
   */
  baselineRun?: BaselineRunFn | null;
  /** HEAD at spawn time (null when the workdir is not a git repo). */
  baseCommit: string | null;
  /** ms epoch the run started; screenshots must be newer. */
  runStartedAt: number;
  result: RunResult | null;
  /** Re-run safe claimed commands (default true). */
  rerunCommands?: boolean;
  /** Per-command timeout (default 180s). */
  commandTimeoutSec?: number;
  /** Max commands to re-run (default 5). */
  maxReruns?: number;
  /** Injected for tests. */
  runCommand?: RunCommandFn;
  /** Node installs to choose from (tests); defaults to nvm + the gateway's Node. */
  nodeCandidates?: NodeChoice[];
}

// ── git helpers ─────────────────────────────────────────────────────────────

function git(cwd: string, args: string[], timeoutMs = 15_000): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

export function gitHead(cwd: string | null | undefined): string | null {
  if (!cwd || !existsSync(cwd)) return null;
  return git(cwd, ["rev-parse", "HEAD"]);
}

function gitTop(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

function splitLines(s: string | null): string[] {
  return (s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function listChangedFiles(cwd: string, baseCommit: string | null): string[] {
  const out = new Set<string>();
  if (baseCommit)
    for (const f of splitLines(git(cwd, ["diff", "--name-only", `${baseCommit}..HEAD`])))
      out.add(f);
  for (const f of splitLines(git(cwd, ["diff", "--name-only", "HEAD"]))) out.add(f);
  for (const f of splitLines(git(cwd, ["ls-files", "--others", "--exclude-standard"]))) out.add(f);
  return [...out];
}

function buildDiffText(cwd: string, baseCommit: string | null, cap = 24_000): string {
  const range = baseCommit ?? "HEAD";
  const stat = git(cwd, ["diff", "--stat", range]) ?? "";
  const patch = git(cwd, ["diff", range]) ?? "";
  const untracked = splitLines(git(cwd, ["ls-files", "--others", "--exclude-standard"]));
  const body = `${stat}\n${untracked.length ? `untracked: ${untracked.slice(0, 50).join(", ")}\n` : ""}\n${patch}`;
  return body.length > cap ? `${body.slice(0, cap)}\n…(diff truncated)` : body;
}

function toRepoRelative(top: string, p: string): string {
  let cleaned = p.replace(/\\/g, "/").trim();
  if (cleaned.startsWith("~/")) cleaned = path.join(os.homedir(), cleaned.slice(2));
  if (path.isAbsolute(cleaned)) {
    const rel = path.relative(top, cleaned).replace(/\\/g, "/");
    return rel.startsWith("..") ? cleaned : rel;
  }
  return cleaned.replace(/^\.\//, "");
}

// ── command safety ──────────────────────────────────────────────────────────

const SAFE_COMMAND_RE =
  /^(cd [^;&|]+ && )?(timeout \d+ )?((pnpm|npm|yarn|bun)( -C [^\s]+| --filter [^\s]+| --dir [^\s]+)? (run )?(test|build|lint|typecheck|check|tsc|vitest|jest)\b|(npx|pnpm exec|pnpm dlx)? ?(vitest|jest|tsc|eslint|biome|oxlint)\b|pnpm( -C [^\s]+| --dir [^\s]+)? exec (vitest|jest|tsc|eslint)\b|node --check |node --test |python3? -m (pytest|py_compile|unittest)|pytest\b|go (test|build|vet)\b|cargo (test|build|check)\b|git( -C [^\s]+)? (status|log|diff|show|rev-parse|merge-base|ls-files|branch --show-current|branch --contains)\b)/;

const DANGEROUS_RE =
  /(\brm\s+-|\bgit\s+(push|reset|checkout|clean|commit|merge|rebase)\b|\bsudo\b|\bcurl\b|\bwget\b|\bdeploy\b|\brestart\b|\bkill(all)?\b|\bdocker\b|\bsystemctl\b|\bnetlify\b|\bfly\b|>\s*\/|\bdd\b|\bmkfs\b|\bchmod\b|\bchown\b|\bpnpm (install|add|remove)\b|\bnpm (install|i|publish)\b)/;

/** Read-only inspection commands (writes are impossible once redirection is rejected). */
const READ_ONLY_RE = /^(grep|egrep|rg|test|\[|ls|cat|wc|head|tail|diff|cmp|stat|file|jq|find)\b/;

export function isSafeToRerun(command: string): boolean {
  const c = command
    .trim()
    .replace(/\s+2>&1/g, "")
    .replace(/\s+2>\/dev\/null/g, "");
  if (!c || c.length > 400) return false;
  if (DANGEROUS_RE.test(c)) return false;
  // No redirection, command substitution, sequencing or backgrounding.
  if (/[;`<>]|\$\(|(^|[^&])&($|[^&])|\|\|/.test(c)) return false;
  if (/\bfind\b.*\s-(exec|execdir|delete|ok|fprint)/.test(c)) return false;
  // `a && b` chains only if every segment is safe; pipes only into read-only filters.
  return c.split(/\s*&&\s*/).every((seg) => {
    if (/^cd [^|]+$/.test(seg)) return true;
    const [head, ...piped] = seg.split(/\s*\|\s*/);
    if (!(SAFE_COMMAND_RE.test(head) || READ_ONLY_RE.test(head))) return false;
    return piped.every((p) => /^(grep|egrep|head|tail|wc|sort|uniq|jq)\b/.test(p));
  });
}

export const defaultRunCommand: RunCommandFn = (command, cwd, timeoutSec, env) => {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    // No login/rc files: they would re-order PATH (nvm, profile) behind our back.
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env: env ?? { ...process.env, INFINIBOT_VERIFY_RERUN: "1", CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > 64_000) out = out.slice(-32_000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, timeoutSec * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: out.slice(-2000), timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(err), timedOut: false });
    });
  });
};

// ── screenshots ─────────────────────────────────────────────────────────────

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPG_MAGIC = [0xff, 0xd8, 0xff];

export function checkScreenshot(file: string, runStartedAt: number): EvidenceItem {
  if (!file || !path.isAbsolute(file)) {
    return { kind: "screenshot", ref: file, status: "fail", detail: "not an absolute path" };
  }
  if (!existsSync(file))
    return { kind: "screenshot", ref: file, status: "fail", detail: "file does not exist" };
  const st = statSync(file);
  if (!st.isFile() || st.size < 1024) {
    return {
      kind: "screenshot",
      ref: file,
      status: "fail",
      detail: `empty or tiny file (${st.size} bytes)`,
    };
  }
  // 2s slack for filesystem timestamp granularity.
  if (st.mtimeMs + 2000 < runStartedAt) {
    return {
      kind: "screenshot",
      ref: file,
      status: "fail",
      detail: `older than the run (${new Date(st.mtimeMs).toISOString()} < start ${new Date(runStartedAt).toISOString()})`,
    };
  }
  const head = Buffer.alloc(4);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const isPng = PNG_MAGIC.every((b, i) => head[i] === b);
  const isJpg = JPG_MAGIC.every((b, i) => head[i] === b);
  if (!isPng && !isJpg)
    return { kind: "screenshot", ref: file, status: "fail", detail: "not a PNG/JPEG image" };
  return {
    kind: "screenshot",
    ref: file,
    status: "pass",
    detail: `${Math.round(st.size / 1024)} KB, ${isPng ? "png" : "jpeg"}`,
  };
}

/** Read a visual_verify result.json (vision assessment + diagnostics) for a capture dir. */
export function readVisualAssessment(dir: string): EvidenceItem | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as {
      assessment?: {
        available?: boolean;
        pass?: boolean | null;
        summary?: string;
        issues?: string[];
      } | null;
      consoleErrors?: number;
      failedRpcs?: number;
      shots?: Array<{ consoleErrors?: string[]; pageErrors?: string[] }>;
    };
    const a = raw.assessment;
    // Recount with the benign-noise classifier (older result.json files counted GL chatter).
    let consoleErrors = raw.consoleErrors ?? 0;
    let benign = 0;
    if (Array.isArray(raw.shots)) {
      consoleErrors = 0;
      for (const sh of raw.shots) {
        const p = partitionConsoleMessages(sh.consoleErrors ?? []);
        consoleErrors += p.errors.length + (sh.pageErrors ?? []).length;
        benign += p.benign.length;
      }
    }
    const diag = `${consoleErrors} console error(s)${benign ? ` (+${benign} benign headless GL/driver message(s) ignored)` : ""}, ${raw.failedRpcs ?? 0} failed RPC(s)`;
    if (!a || !a.available) {
      return {
        kind: "visual",
        ref: dir,
        status: "warn",
        detail: `visual_verify ran; vision assessment unavailable; ${diag}`,
      };
    }
    return {
      kind: "visual",
      ref: dir,
      status: a.pass ? "pass" : "fail",
      detail: `visual_verify vision assessment ${a.pass ? "PASS" : "FAIL"}: ${a.summary ?? ""}${a.issues?.length ? ` Issues: ${a.issues.slice(0, 4).join("; ")}` : ""} (${diag})`,
    };
  } catch {
    return null;
  }
}

/** `src/a.ts:12`, `src/a.ts#L3-L9`, `src/a.ts line 2`, `src/a.ts (lines 4-8)` → `src/a.ts`. */
export function stripLocationSuffix(ref: string): string {
  return ref
    .trim()
    .replace(/\s*\((?:line|lines|l)\.?\s*[\d\s,-]+\)\s*$/i, "")
    .replace(/\s+(?:line|lines|l\.)\s*[\d\s,-]+$/i, "")
    .replace(/#L\d+(?:-L?\d+)?$/i, "")
    .replace(/:\d+(?::\d+)?(?:-\d+)?$/, "")
    .trim();
}

// ── main ────────────────────────────────────────────────────────────────────

/**
 * The command part of an evidence ref. Models often append the observed
 * output: "cat marker.txt -> ready", "pnpm test => 12 passed", "git log (exit 0)".
 */
export function commandOfRef(ref: string): string {
  let out = ref
    .replace(/^\$\s+/, "")
    .replace(/\s+(?:->|=>|→)\s.*$/s, "")
    .trim();
  // Trailing annotations: "(node22)", "(worktree, exit 0)", "— exit 0", ", exit code 0".
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/\s+\([^()]*\)\s*$/, "")
      .replace(/\s*(?:[—–,]|\s-)\s*exit(?: code)?\s*\d+\s*$/i, "")
      .replace(/\s+exit(?: code)?\s*\d+\s*$/i, "")
      .trim();
    if (next === out || !next) break;
    out = next;
  }
  return out;
}

function sameCommand(a: string, b: string): boolean {
  const n = (s: string) =>
    stripEnvPrefix(commandOfRef(s))
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^cd [^&]+&& /, "");
  if (!n(a) || !n(b)) return false;
  return n(a) === n(b) || n(a).includes(n(b)) || n(b).includes(n(a));
}

/** Source/script files: the program a command ran, not a record of its output. */
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|sh|bash|rb|go|rs)$/i;

/** "a; b", "a && b" (as separate claims), "a, then b" → command parts. */
export function splitCompoundRef(ref: string): string[] {
  return commandOfRef(ref)
    .split(/\s*(?:;|&&|\bthen\b)\s*/)
    .map((x) => commandOfRef(x))
    .filter(Boolean);
}

/** Base of the run's branch: the recorded base when it is an ancestor, else the merge-base. */
function effectiveBase(top: string, baseCommit: string | null): string | null {
  if (!baseCommit) return null;
  const full = git(top, ["rev-parse", "--verify", "--quiet", `${baseCommit}^{commit}`]);
  if (!full) return null;
  if (git(top, ["merge-base", "--is-ancestor", full, "HEAD"]) !== null) return full;
  return git(top, ["merge-base", full, "HEAD"]);
}

export async function collectEvidence(input: EvidenceInput): Promise<EvidenceReport> {
  const items: EvidenceItem[] = [];
  const result = input.result;
  const workspace = resolveRunWorkspace({
    workdir: input.workdir,
    result,
    agentDirs: input.agentDirs,
    runStartedAt: input.runStartedAt,
  });
  const top = workspace.top;
  const cwd = top ?? (input.workdir && existsSync(input.workdir) ? input.workdir : null);
  const base = top ? effectiveBase(top, input.baseCommit) : null;

  let actualChangedFiles: string[] = [];
  let actualCommits: string[] = [];
  let diffText = "";
  if (top) {
    actualChangedFiles = listChangedFiles(top, base);
    actualCommits = base ? splitLines(git(top, ["rev-list", `${base}..HEAD`])) : [];
    diffText = buildDiffText(top, base);
  }
  const where = workspace.isSeparateWorktree ? ` (${workspace.branch ?? "detached"} @ ${top})` : "";

  // Commits — must be reachable from the RUN's HEAD, not the owner's branch.
  for (const sha of result?.commits ?? []) {
    if (!top) {
      items.push({
        kind: "commit",
        ref: sha,
        status: "skipped",
        detail: "workdir is not a git repo",
      });
      continue;
    }
    const full = git(top, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (!full) {
      items.push({ kind: "commit", ref: sha, status: "fail", detail: "commit does not exist" });
      continue;
    }
    const onBranch = git(top, ["merge-base", "--is-ancestor", full, "HEAD"]) !== null;
    if (!onBranch) {
      const branches = splitLines(
        git(top, ["for-each-ref", "--contains", full, "--format=%(refname:short)", "refs/heads"]),
      );
      items.push({
        kind: "commit",
        ref: sha,
        status: "warn",
        detail: branches.length
          ? `commit exists on ${branches.slice(0, 3).join(", ")} but not on the run's branch${where}`
          : `commit exists but is not on any branch${where}`,
      });
      continue;
    }
    const isNew = !base || actualCommits.includes(full);
    items.push({
      kind: "commit",
      ref: sha,
      status: isNew ? "pass" : "warn",
      detail: isNew
        ? `on the run's branch${where} (${full.slice(0, 10)})`
        : `on the run's branch${where} but older than the run start`,
    });
  }

  // files_changed vs the run branch's diff since its base.
  if (top && result) {
    const claimed = result.files_changed.map((f) => toRepoRelative(top, f));
    const actual = new Set(actualChangedFiles);
    const missing = claimed.filter((f) => !actual.has(f) && !path.isAbsolute(f));
    const outside = claimed.filter((f) => path.isAbsolute(f));
    const unreported = actualChangedFiles.filter((f) => !claimed.includes(f));
    if (missing.length > 0) {
      items.push({
        kind: "files",
        ref: missing.slice(0, 10).join(", "),
        status: "fail",
        detail: `${missing.length} claimed changed file(s) show no change in git since the run began${where}`,
      });
    }
    if (outside.length > 0) {
      items.push({
        kind: "files",
        ref: outside.slice(0, 5).join(", "),
        status: "warn",
        detail: "claimed files outside the repo",
      });
    }
    if (unreported.length > 0) {
      items.push({
        kind: "files",
        ref: unreported.slice(0, 10).join(", "),
        status: "warn",
        detail: `${unreported.length} changed file(s) not listed in files_changed`,
      });
    }
    if (missing.length === 0 && claimed.length > 0) {
      items.push({
        kind: "files",
        ref: `${claimed.length} file(s)`,
        status: "pass",
        detail: `files_changed matches git${where}`,
      });
    }
  }

  // Re-run claimed checks in the run's tree with the right toolchain.
  const rerunEnabled = input.rerunCommands !== false && Boolean(cwd);
  const maxReruns = input.maxReruns ?? 5;
  const timeoutSec = input.commandTimeoutSec ?? 180;
  const runCmd = input.runCommand ?? defaultRunCommand;
  const node = resolveNodeBinDir(top, input.nodeCandidates);
  let reruns = 0;
  type Rerun = {
    code: number | null;
    ok: boolean;
    env: string | null;
    output: string;
    cwd: string | null;
    cwdSource: ReplayCwdSource | null;
    baseline?: { code: number | null; output: string } | null;
  };
  const rerunResults = new Map<string, Rerun>();
  const claimRefs = (result?.claims ?? []).map((c) => c.evidence_ref).filter(Boolean);
  let baselines = 0;
  const rerun = async (command: string, declaredCwd?: string | null): Promise<Rerun> => {
    const where = resolveReplayCwd({
      command,
      declaredCwd,
      top,
      fallbackCwd: cwd,
      claimRefs,
      agentDirs: input.agentDirs,
    });
    const runCwd = where?.cwd ?? cwd;
    const base = { cwd: runCwd, cwdSource: where?.source ?? null };
    const pre = preflightProblem(command, runCwd, top);
    if (pre) return { code: null, ok: false, env: pre, output: "", ...base };
    const env = buildRerunEnv({ command, cwd: runCwd!, top, node });
    const r = await runCmd(command, runCwd!, timeoutSec, env);
    if (r.timedOut)
      return {
        code: r.code,
        ok: false,
        env: `timed out after ${timeoutSec}s`,
        output: r.output,
        ...base,
      };
    const out: Rerun = {
      code: r.code,
      ok: r.code === 0,
      env: environmentProblem(r),
      output: r.output,
      ...base,
    };
    // A real failure: is it new, or does the base commit fail the same way?
    if (!out.ok && !out.env && input.baselineRun && top && runCwd && base && baselines < 2) {
      const baseSha = effectiveBase(top, input.baseCommit);
      const head = git(top, ["rev-parse", "HEAD"]);
      if (baseSha && head && baseSha !== head) {
        baselines++;
        out.baseline = await input
          .baselineRun({ command, top, cwd: runCwd, baseCommit: baseSha, env, timeoutSec })
          .catch(() => null);
      }
    }
    return out;
  };
  const cwdNote = (r: Rerun) =>
    r.cwd ? ` in ${r.cwd}${r.cwdSource && r.cwdSource !== "run-tree" ? ` (${r.cwdSource})` : ""}` : "";
  const envDetail = (why: string, claimed: number | string | null) =>
    `could not re-run (environment): ${why} — claimed exit ${claimed}; not counted against the run`;
  for (const check of result?.checks_run ?? []) {
    const ref = check.command;
    const cmd = stripEnvPrefix(commandOfRef(ref));
    if (!rerunEnabled) {
      items.push({
        kind: "command",
        ref,
        status: "skipped",
        detail: "re-run disabled / no workdir",
      });
      continue;
    }
    if (!isSafeToRerun(cmd)) {
      items.push({
        kind: "command",
        ref,
        status: "skipped",
        detail: "not on the safe re-run allowlist (claimed exit " + check.exit_code + ")",
      });
      continue;
    }
    if (reruns >= maxReruns) {
      items.push({ kind: "command", ref, status: "skipped", detail: "re-run budget exhausted" });
      continue;
    }
    reruns++;
    const r = await rerun(cmd, (check as ResultCheck).cwd);
    rerunResults.set(ref, r);
    const claimedOk = (check as ResultCheck).exit_code === 0;
    const at = r.cwd ? { cwd: r.cwd } : {};
    if (r.env) {
      items.push({
        kind: "command",
        ref,
        status: "warn",
        environment: true,
        detail: envDetail(r.env, check.exit_code) + cwdNote(r),
        ...at,
      });
    } else if (claimedOk === r.ok) {
      items.push({
        kind: "command",
        ref,
        status: r.ok ? "pass" : "warn",
        detail: `re-run exit ${r.code}${cwdNote(r)} matches claimed ${check.exit_code}${where}`,
        ...at,
      });
    } else if (r.baseline && r.baseline.code !== 0 && claimedOk && !r.ok) {
      items.push({
        kind: "command",
        ref,
        status: "warn",
        baseline: true,
        detail: `pre-existing failure: re-run exited ${r.code}${cwdNote(r)} and the base commit fails the same check (baseline exit ${r.baseline.code}) — not introduced by this run`,
        ...at,
      });
    } else {
      items.push({
        kind: "command",
        ref,
        status: "fail",
        detail: `claimed exit ${check.exit_code} but re-run exited ${r.code}${cwdNote(r)}${where}: ${r.output.split("\n").slice(-6).join(" | ").slice(0, 400)}`,
        ...at,
      });
    }
  }

  // Screenshots.
  const screenshotItems = new Map<string, EvidenceItem>();
  const shotCtx = { runId: input.runId ?? null, top, visualDirs: input.visualDirs };
  const seenShotFiles = new Set<string>();
  for (const shot of result?.screenshots ?? []) {
    // Absolute image path: check it directly (keeps the precise failure detail).
    const direct = path.isAbsolute(shot) && /\.(png|jpe?g|webp)$/i.test(shot) && existsSync(shot);
    const resolved = direct ? null : resolveScreenshotRef(shot, shotCtx);
    if (direct || !resolved || resolved.files.length === 0) {
      const item = checkScreenshot(shot, input.runStartedAt);
      screenshotItems.set(shot, item);
      items.push(item);
      seenShotFiles.add(shot);
      continue;
    }
    for (const f of resolved.files.slice(0, 12)) {
      if (seenShotFiles.has(f)) continue;
      seenShotFiles.add(f);
      const item = checkScreenshot(f, input.runStartedAt);
      item.detail = `${item.detail} (resolved from "${shot.slice(0, 80)}")`;
      screenshotItems.set(f, item);
      items.push(item);
    }
    screenshotItems.set(shot, {
      kind: "screenshot",
      ref: shot,
      status: worstStatus(resolved.files.map((f) => screenshotItems.get(f)!).filter(Boolean)),
      detail: resolved.notes.join("; ") || `${resolved.files.length} image(s)`,
    });
  }
  // visual_verify captures produced for THIS run count even when the agent
  // listed them badly (or not at all) — they are resolved by run id.
  if (input.runId) {
    for (const cap of runVisualCaptures(input.runId, {
      visualDirs: input.visualDirs,
      since: input.runStartedAt,
    }).slice(-6)) {
      for (const f of cap.screenshots.slice(0, 8)) {
        if (seenShotFiles.has(f)) continue;
        seenShotFiles.add(f);
        const item = checkScreenshot(f, input.runStartedAt);
        item.detail = `${item.detail} (visual_verify capture for this run, resolved by run id)`;
        screenshotItems.set(f, item);
        items.push(item);
      }
    }
  }
  // visual_verify's own vision assessment (result.json next to the shots) is
  // independent evidence for visual claims — surface it once per capture dir.
  const seenDirs = new Set<string>();
  const visuals: Array<{ dir: string; item: EvidenceItem; routes: Set<string>; at: number }> = [];
  for (const [shot, item] of screenshotItems) {
    if (item.status !== "pass" || !/\.(png|jpe?g|webp)$/i.test(shot)) continue;
    const dir = path.dirname(shot);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const visual = readVisualAssessment(dir);
    if (!visual) continue;
    const routes = new Set(
      [...screenshotItems.keys()]
        .filter((k) => path.dirname(k) === dir && /\.(png|jpe?g|webp)$/i.test(k))
        // route + viewport: a desktop-only re-check does not clear a mobile failure.
        .map((k) => path.basename(k).split("__").slice(0, 2).join("__")),
    );
    let at = 0;
    try {
      at = statSync(path.join(dir, "result.json")).mtimeMs;
    } catch {
      /* keep 0 */
    }
    visuals.push({ dir, item: visual, routes, at });
  }
  // A failed vision assessment is superseded when a NEWER passing capture of
  // the same run covers every route it showed (the agent fixed and re-checked).
  for (const v of visuals) {
    if (v.item.status === "fail") {
      const newer = visuals.filter((o) => o.at > v.at && o.item.status === "pass");
      const covered = [...v.routes].every((r) => newer.some((o) => o.routes.has(r)));
      if (covered && newer.length) {
        v.item.status = "warn";
        v.item.detail = `superseded by newer passing capture ${path.basename(newer[newer.length - 1].dir)}: ${v.item.detail}`;
      }
    }
    items.push(v.item);
  }

  // Evidence files named in a ref (result JSON, logs, screenshots) — read, not re-run.
  const fileBase = top ?? cwd ?? null;
  const fileEvidence = (
    ref: string,
    claim: string,
    outputsOnly = false,
  ): { checks: EvidenceFileCheck[]; status: EvidenceStatus; detail: string; excerpt?: string } => {
    const checks = extractPathRefs(ref)
      // For command claims the script being run is not evidence of its output.
      .filter((p) => !outputsOnly || !CODE_FILE_RE.test(p))
      .map((p) => ({ p, abs: resolveEvidencePath(p, fileBase) }))
      // Relative paths only count when they exist (they may be prose like "a/b").
      .filter(({ p, abs }) => path.isAbsolute(p) || p.startsWith("~/") || existsSync(abs))
      .flatMap(({ abs }) => {
        const hits = expandEvidenceGlob(abs);
        return hits.length ? hits : [abs];
      })
      .slice(0, 8)
      .map((abs) => inspectEvidenceFile(abs, input.runStartedAt, `${claim}\n${ref}`));
    if (!checks.length) return { checks, status: "warn", detail: "" };
    const detail = checks
      .map((f) => `${f.path}: ${f.detail}`)
      .join("; ")
      .slice(0, 900);
    const excerpt = checks
      .filter((f) => f.excerpt)
      .map((f) => `--- ${f.path}\n${f.excerpt}`)
      .join("\n")
      .slice(0, 3000);
    return { checks, status: worstStatus(checks), detail, excerpt: excerpt || undefined };
  };
  const segmentEvidence = (seg: string): { status: EvidenceStatus; detail: string } | null => {
    const r = [...rerunResults.entries()].find(([k]) => sameCommand(k, seg))?.[1];
    if (r && !r.env)
      return { status: r.ok ? "pass" : "fail", detail: `${seg}: re-run exit ${r.code}` };
    if (r?.env) return { status: "warn", detail: `${seg}: could not re-run (environment)` };
    const m = (result?.checks_run ?? []).find((k) => sameCommand(k.command, seg));
    if (m)
      return {
        status: m.exit_code === 0 ? "warn" : "fail",
        detail: `${seg}: reported exit ${m.exit_code} (not re-run)`,
      };
    return null;
  };

  /** checks_run entry whose command names every test file mentioned in a prose ref. */
  const testFileMatch = (ref: string) => {
    const names = [...ref.matchAll(/([\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)].map((m) => m[1]);
    if (!names.length) return null;
    const hit = (result?.checks_run ?? []).find((k) => names.every((n) => k.command.includes(n)));
    return hit ? { command: hit.command, exit_code: hit.exit_code, files: [...new Set(names)] } : null;
  };

  // Claims → evidence refs.
  for (const c of result?.claims ?? []) {
    const ref = c.evidence_ref;
    let status: EvidenceStatus = "warn";
    let detail = "no evidence reference";
    let environment = false;
    let excerpt: string | undefined;
    if (!ref) {
      status = "fail";
    } else if (c.evidence_type === "screenshot") {
      const it = screenshotItems.get(ref);
      const resolved = it ? null : resolveScreenshotRef(ref, shotCtx);
      const paths = resolved?.files ?? [];
      if (it || paths.length === 0) {
        const fallback = extractPathRefs(ref).find((p) => path.isAbsolute(p) || p.startsWith("~/"));
        const one =
          it ??
          (fallback
            ? checkScreenshot(resolveEvidencePath(fallback, null), input.runStartedAt)
            : {
                kind: "screenshot" as const,
                ref,
                status: "fail" as const,
                detail: `no image found for this reference${resolved?.unresolved.length ? ` (unresolved: ${resolved.unresolved.slice(0, 3).join(", ")})` : ""}`,
              });
        status = one.status;
        detail = `screenshot: ${one.detail}`;
      } else if (paths.length === 1) {
        const one = screenshotItems.get(paths[0]) ?? checkScreenshot(paths[0], input.runStartedAt);
        status = one.status;
        detail = `screenshot: ${one.detail}${resolved?.notes.length ? ` (${resolved.notes.join("; ").slice(0, 200)})` : ""}`;
      } else {
        const shots = paths.map((p) => {
          const r = screenshotItems.get(p) ?? checkScreenshot(p, input.runStartedAt);
          return { ...r, ref: p };
        });
        status = worstStatus(shots);
        const bad = shots.filter((x) => x.status !== "pass");
        detail = `${shots.length} screenshots: ${
          bad.length
            ? bad
                .map((b) => `${b.ref}: ${b.detail}`)
                .slice(0, 3)
                .join("; ")
            : "all valid"
        }`;
      }
    } else if (c.evidence_type === "command" || c.evidence_type === "test") {
      const matched = (result?.checks_run ?? []).find((k) => sameCommand(k.command, ref));
      const prior = [...rerunResults.entries()].find(([k]) => sameCommand(k, ref))?.[1];
      const cmd = stripEnvPrefix(commandOfRef(ref));
      const segments = splitCompoundRef(ref);
      const files = fileEvidence(ref, c.claim, true);
      if (prior?.env) {
        status = "warn";
        environment = true;
        detail = envDetail(prior.env, matched?.exit_code ?? 0);
      } else if (prior) {
        status = prior.ok ? "pass" : "fail";
        detail = `re-run exit ${prior.code}`;
      } else if (matched) {
        status = matched.exit_code === 0 ? "warn" : "fail";
        detail = `reported in checks_run with exit ${matched.exit_code} (not re-run)`;
      } else if (segments.length > 1 && segments.every((seg) => segmentEvidence(seg))) {
        // "pnpm build; pnpm -C ui build" — each part matched a re-run / checks_run entry.
        const st = segments.map((seg) => segmentEvidence(seg)!);
        status = worstStatus(st);
        detail = `each part matched: ${st.map((x) => x.detail).join("; ")}`;
      } else if (rerunEnabled && reruns < maxReruns + 2 && isSafeToRerun(cmd)) {
        // Not in checks_run, but cheap + safe: prove it ourselves.
        reruns++;
        const r = await rerun(cmd);
        rerunResults.set(cmd, r);
        if (r.env) {
          status = files.checks.length ? files.status : "warn";
          environment = !files.checks.length;
          detail = `not in checks_run; ${envDetail(r.env, "n/a")}${files.checks.length ? `; result file(s): ${files.detail}` : ""}`;
        } else {
          status = r.ok ? "pass" : "fail";
          detail = `not in checks_run; re-run by the gateway: exit ${r.code}${r.ok ? "" : ` — ${r.output.split("\n").slice(-3).join(" | ").slice(0, 200)}`}`;
        }
      } else if (testFileMatch(ref)) {
        // "a.test.ts and b.test.ts: 4/4 passed" — prose naming the test files of a checks_run entry.
        const m = testFileMatch(ref)!;
        const r = [...rerunResults.entries()].find(([k]) => k === m.command)?.[1];
        if (r && !r.env) {
          status = r.ok ? "pass" : "fail";
          detail = `matched checks_run \`${m.command.slice(0, 120)}\` by test file(s) ${m.files.join(", ")}: re-run exit ${r.code}${cwdNote(r)}`;
        } else {
          status = m.exit_code === 0 ? "warn" : "fail";
          detail = `matched checks_run \`${m.command.slice(0, 120)}\` by test file(s) ${m.files.join(", ")}: reported exit ${m.exit_code} (not re-run${r?.env ? `: ${r.env}` : ""})`;
          environment = Boolean(r?.env);
        }
      } else if (files.checks.length) {
        // Not re-runnable, but the ref names the result files it produced — read them.
        status = files.status;
        detail = `not re-run; checked the referenced result file(s): ${files.detail}`;
        excerpt = files.excerpt;
      } else {
        status = "fail";
        detail = "command/test not listed in checks_run (and not safe to re-run)";
      }
      if (!excerpt && files.excerpt) excerpt = files.excerpt;
    } else if (c.evidence_type === "file") {
      const files = fileEvidence(ref, c.claim);
      if (files.checks.length) {
        status = files.status;
        detail = files.detail;
        excerpt = files.excerpt;
      } else {
        const fileRef = stripLocationSuffix(ref);
        const abs = path.isAbsolute(fileRef)
          ? fileRef
          : path.join(top ?? cwd ?? process.cwd(), fileRef);
        status = existsSync(abs) ? "pass" : "fail";
        detail = status === "pass" ? "file exists" : "file does not exist";
      }
    } else if (c.evidence_type === "url") {
      status = "warn";
      detail = "URL evidence is not fetched automatically";
    }
    items.push({
      kind: "claim",
      ref: `${c.claim} ← ${ref}`,
      status,
      detail,
      ...(environment ? { environment: true } : {}),
      ...(excerpt ? { excerpt } : {}),
    });
  }

  return {
    items,
    actualChangedFiles,
    actualCommits,
    diffText,
    failures: items.filter((i) => i.status === "fail").length,
    warnings: items.filter((i) => i.status === "warn").length,
    workspace,
    environmentSkips: items.filter((i) => i.environment).length,
  };
}
