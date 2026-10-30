/**
 * Goal checks — the single verification primitive shared by goal runs and the
 * persistent queue's phase `gateCriteria`.
 *
 *   shell — `bash -lc <command>` in the workdir; exit 0 = pass (timeout = fail)
 *   file  — path exists (or, with `negate`, does not)
 *   grep  — regex matches the file content (or, with `negate`, does not)
 *   llm   — goal-judge evaluates a natural-language criterion vs output + diff
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { evaluateCriterion, type CriterionVerdict } from "../goal-judge.js";
import type { GoalCheck, GoalCheckResult } from "./types.js";

const OUTPUT_CAP = 4_000;
const DEFAULT_CHECK_TIMEOUT_SEC = 120;

export interface CheckContext {
  workdir: string | null;
  goalText: string;
  /** Lazily fetched agent output tail (only llm checks need it). */
  getAgentOutput?: () => Promise<string> | string;
  iteration: number;
  trigger: GoalCheckResult["trigger"];
  /** Injectable judge for tests. */
  judge?: (input: {
    goalText: string;
    criterion: string;
    agentOutput: string;
    diff?: string;
  }) => Promise<CriterionVerdict>;
  /** Skip llm checks (used by the periodic timer until cheap checks pass). */
  skipLlm?: boolean;
}

function capTail(s: string, n = OUTPUT_CAP): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function expandPath(p: string, workdir: string | null): string {
  let out = p.trim();
  if (out.startsWith("~/")) out = resolve(homedir(), out.slice(2));
  if (!isAbsolute(out)) out = resolve(workdir ?? process.cwd(), out);
  return out;
}

export function describeCheck(c: GoalCheck): string {
  if (c.label?.trim()) return c.label.trim();
  switch (c.type) {
    case "shell":
      return `$ ${c.command ?? ""}`;
    case "file":
      return `${c.negate ? "absent" : "exists"}: ${c.path ?? ""}`;
    case "grep":
      return `${c.negate ? "!" : ""}/${c.pattern ?? ""}/ in ${c.path ?? ""}`;
    case "llm":
      return `judge: ${c.criterion ?? ""}`;
    case "visual":
      return `visual: ${(c.routes ?? []).join(", ")}${c.expectation ? ` — ${c.expectation.slice(0, 60)}` : ""}`;
  }
}

/** Assign stable ids (`c1`, `c2`, …) and validate required fields. Throws on invalid input. */
export function normalizeChecks(input: unknown): GoalCheck[] {
  if (!Array.isArray(input)) throw new Error("checks must be an array");
  const out: GoalCheck[] = [];
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`check ${i + 1}: must be an object`);
    const c = raw as Record<string, unknown>;
    const type = c.type;
    if (
      type !== "shell" &&
      type !== "file" &&
      type !== "grep" &&
      type !== "llm" &&
      type !== "visual"
    ) {
      throw new Error(`check ${i + 1}: type must be shell | file | grep | llm | visual`);
    }
    const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string).trim() : "");
    const check: GoalCheck = { type };
    if (type === "shell") {
      if (!str("command")) throw new Error(`check ${i + 1}: shell check needs a command`);
      check.command = str("command");
    } else if (type === "file") {
      if (!str("path")) throw new Error(`check ${i + 1}: file check needs a path`);
      check.path = str("path");
    } else if (type === "grep") {
      if (!str("path") || !str("pattern")) {
        throw new Error(`check ${i + 1}: grep check needs path and pattern`);
      }
      try {
        new RegExp(str("pattern"), "m");
      } catch (err) {
        throw new Error(`check ${i + 1}: invalid regex: ${String(err)}`, { cause: err });
      }
      check.path = str("path");
      check.pattern = str("pattern");
    } else if (type === "visual") {
      const routes = Array.isArray(c.routes)
        ? (c.routes as unknown[]).filter(
            (r): r is string => typeof r === "string" && r.trim() !== "",
          )
        : [];
      if (routes.length === 0) throw new Error(`check ${i + 1}: visual check needs routes`);
      check.routes = routes;
      if (str("expectation")) check.expectation = str("expectation");
      if (str("worktree")) check.worktree = str("worktree");
    } else {
      if (!str("criterion")) throw new Error(`check ${i + 1}: llm check needs a criterion`);
      check.criterion = str("criterion");
    }
    if (c.negate === true) check.negate = true;
    if (str("label")) check.label = str("label");
    if (typeof c.timeoutSec === "number" && c.timeoutSec > 0) {
      check.timeoutSec = Math.min(3600, Math.floor(c.timeoutSec));
    }
    let id = str("id") || `c${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    check.id = id;
    out.push(check);
  });
  return out;
}

export function runShell(
  command: string,
  cwd: string | null,
  timeoutSec: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolveP) => {
    const dir = cwd && existsSync(cwd) ? cwd : process.cwd();
    const child = spawn("bash", ["-lc", command], {
      cwd: dir,
      // Marks the process as the verifier (lets check scripts distinguish
      // themselves from the agent running the same command).
      env: { ...process.env, INFINIBOT_GOAL_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > OUTPUT_CAP * 4) buf = buf.slice(-OUTPUT_CAP * 2);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole process group (bash + children like `pnpm test`).
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutSec * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ exitCode: null, output: `spawn error: ${String(err)}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ exitCode: code, output: capTail(buf), timedOut });
    });
  });
}

async function workdirDiff(workdir: string | null): Promise<string> {
  if (!workdir || !existsSync(workdir)) return "";
  const r = await runShell(
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1 && { git status --short | head -50; echo; git diff --stat | tail -30; echo; git diff | head -c 12000; }",
    workdir,
    20,
  );
  return r.output;
}

export async function runCheck(check: GoalCheck, ctx: CheckContext): Promise<GoalCheckResult> {
  const started = Date.now();
  const base = { checkId: check.id ?? "?", iteration: ctx.iteration, trigger: ctx.trigger };
  const done = (pass: boolean, output: string, extra: Partial<GoalCheckResult> = {}) => ({
    ...base,
    pass,
    output: capTail(output),
    durationMs: Date.now() - started,
    at: Date.now(),
    ...extra,
  });
  try {
    switch (check.type) {
      case "shell": {
        const r = await runShell(
          check.command ?? "false",
          ctx.workdir,
          check.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC,
        );
        const pass = !r.timedOut && r.exitCode === 0;
        const head = r.timedOut
          ? `timed out after ${check.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC}s`
          : `exit ${r.exitCode}`;
        return done(pass, `${head}\n${r.output}`, { exitCode: r.exitCode, timedOut: r.timedOut });
      }
      case "file": {
        const p = expandPath(check.path ?? "", ctx.workdir);
        const exists = existsSync(p);
        const pass = check.negate ? !exists : exists;
        let detail = exists ? `exists (${statSync(p).size} bytes)` : "does not exist";
        detail = `${p}: ${detail}`;
        return done(pass, detail);
      }
      case "grep": {
        const p = expandPath(check.path ?? "", ctx.workdir);
        if (!existsSync(p)) return done(Boolean(check.negate), `${p}: does not exist`);
        const content = readFileSync(p, "utf8");
        const re = new RegExp(check.pattern ?? "", "m");
        const m = content.match(re);
        const pass = check.negate ? !m : Boolean(m);
        return done(
          pass,
          m ? `${p}: matched "${capTail(m[0], 200)}"` : `${p}: no match for /${check.pattern}/`,
        );
      }
      case "visual": {
        if (ctx.skipLlm) return done(false, "skipped (waiting for cheaper checks)");
        const { existsSync: exists } = await import("node:fs");
        const { join } = await import("node:path");
        const wt =
          check.worktree ??
          (ctx.workdir && exists(join(ctx.workdir, "dist", "control-ui", "index.html"))
            ? ctx.workdir
            : "live");
        const { runVisualVerify } = await import("../../verification/visual/index.js");
        const res = await runVisualVerify({
          routes: check.routes ?? [],
          expectation: check.expectation ?? null,
          worktree: wt,
          runId: `goal-${check.id ?? "visual"}`,
          timeoutSec: check.timeoutSec ?? 600,
        });
        const assess = res.assessment;
        const pass = res.screenshots.length > 0 && !res.error && assess?.pass === true;
        const lines = [
          `${res.screenshots.length} screenshot(s) in ${res.outDir}`,
          assess
            ? `vision: ${assess.available ? (assess.pass ? "PASS" : "FAIL") : "unavailable"} — ${assess.summary}`
            : "no vision assessment",
          ...(assess?.issues ?? []).slice(0, 5).map((x) => `- ${x}`),
          res.consoleErrors ? `${res.consoleErrors} console error(s)` : "",
          res.failedRpcs ? `${res.failedRpcs} failed RPC(s)` : "",
          res.error ? `error: ${res.error}` : "",
        ].filter(Boolean);
        return done(pass, lines.join("\n"));
      }
      case "llm": {
        if (ctx.skipLlm) return done(false, "skipped (waiting for cheaper checks)");
        const agentOutput = ctx.getAgentOutput ? await ctx.getAgentOutput() : "";
        const diff = await workdirDiff(ctx.workdir);
        const judge = ctx.judge ?? evaluateCriterion;
        const timeoutMs = (check.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC) * 1000;
        const verdict = await Promise.race([
          judge({ goalText: ctx.goalText, criterion: check.criterion ?? "", agentOutput, diff }),
          new Promise<CriterionVerdict>((r) =>
            setTimeout(() => r({ pass: false, rationale: "judge timed out" }), timeoutMs).unref?.(),
          ),
        ]);
        return done(verdict.pass, verdict.rationale);
      }
    }
  } catch (err) {
    return done(false, `check error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface CheckSuiteResult {
  allPass: boolean;
  results: GoalCheckResult[];
  failing: GoalCheckResult[];
}

/**
 * Run every check. Non-llm checks first; llm checks run only when `skipLlm`
 * is false. Results are returned in the checks' declared order.
 */
export async function runChecks(checks: GoalCheck[], ctx: CheckContext): Promise<CheckSuiteResult> {
  const results: GoalCheckResult[] = [];
  for (const c of checks) {
    results.push(await runCheck(c, ctx));
  }
  const failing = results.filter((r) => !r.pass);
  return { allPass: checks.length > 0 && failing.length === 0, results, failing };
}

/**
 * Parse the queue's legacy free-form `gateCriteria` into checks. Strings are
 * one llm criterion each (a leading `$ ` makes a line a shell command).
 */
export function gateCriteriaToChecks(gate: unknown): GoalCheck[] {
  if (!gate) return [];
  if (Array.isArray(gate)) return normalizeChecks(gate);
  if (typeof gate === "string") {
    const lines = gate
      .split("\n")
      .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean);
    return normalizeChecks(
      lines.map((l) =>
        l.startsWith("$ ") ? { type: "shell", command: l.slice(2) } : { type: "llm", criterion: l },
      ),
    );
  }
  return [];
}
