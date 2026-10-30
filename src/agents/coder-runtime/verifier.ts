/**
 * Verifier-gated coder completion.
 *
 * PROBLEM this solves: when an `infinibot_*_coder` sub-agent's child process
 * exits cleanly, the kanban task was auto-flipped to `done` purely on the
 * exit code — i.e. self-report. A child can exit 0 having shipped nothing.
 *
 * This module introduces an independent verifier child (no shared context with
 * the worker) that inspects the actual repo + git diff against a list of
 * acceptance criteria and returns a structured pass/fail report. The kanban
 * transition is then GATED on that report:
 *   - passed  → status "done"   (+ verifier report appended as a comment)
 *   - failed  → status "review" (+ failing criteria/evidence appended)
 *
 * Fail-closed: any verifier error (spawn failure, unparseable output, timeout)
 * is treated as NOT passed, so a broken verifier can never auto-pass a task.
 * Backwards-compat: runs with no `acceptanceCriteria` skip verification entirely
 * and keep the legacy exit-code → done behaviour.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { allowCoderBypassFlag } from "../coder-backend/approval-policy.js";

const execFileAsync = promisify(execFile);
const log = createSubsystemLogger("verifier");

export type VerifierCriterionStatus = "pass" | "fail";

export interface VerifierCriterionResult {
  criterion: string;
  status: VerifierCriterionStatus;
  evidence: string;
}

export interface VerifierReport {
  passed: boolean;
  results: VerifierCriterionResult[];
}

/**
 * Minimal shape the verifier needs off a SubagentRunRecord. Declared locally
 * (rather than importing SubagentRunRecord) so this module has no runtime
 * dependency on the registry — keeps the import edge one-directional.
 */
export interface VerifierTarget {
  runId: string;
  task?: string;
  kanbanTaskId?: string;
  acceptanceCriteria?: string[];
  workdir?: string;
  /** Commit SHA captured when the parent spawned, used as the diff base. */
  startedAtCommit?: string;
  /**
   * Bounded plain-text summary of the agent's transcript (progress updates,
   * significant assistant turns, final output).  Provided by the verification
   * gate; capped at ~8K chars so the verifier prompt stays manageable.
   * Gives the verifier access to the agent's own account of what it did —
   * particularly important when git-tracked changes are sparse (e.g. the agent
   * wrote to /tmp or made non-file changes).
   */
  transcriptSummary?: string;
}

const VERIFIER_TIMEOUT_MS = 5 * 60_000;
const MAX_DIFF_CHARS = 60_000;

/**
 * Collect the git diff from the parent's spawn-time commit to the current
 * working tree (tracked changes) plus a porcelain status (so newly created
 * untracked files are visible). Bounded to MAX_DIFF_CHARS.
 */
export async function collectRepoDiff(workdir: string, startedAtCommit?: string): Promise<string> {
  const parts: string[] = [];
  const run = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", workdir, ...args], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      return `(git ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  };

  if (startedAtCommit) {
    parts.push(`# git diff ${startedAtCommit}..(working tree)`);
    parts.push(await run(["diff", "--stat", startedAtCommit]));
    parts.push(await run(["diff", startedAtCommit]));
  } else {
    parts.push("# no base commit captured — showing working-tree diff vs HEAD");
    parts.push(await run(["diff", "--stat", "HEAD"]));
    parts.push(await run(["diff", "HEAD"]));
  }
  parts.push("# git status --porcelain (includes untracked)");
  parts.push(await run(["status", "--porcelain"]));

  let diff = parts.join("\n");
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + "\n…(diff truncated)…";
  }
  return diff;
}

const VERIFIER_SYSTEM_PROMPT = `You are an independent VERIFICATION agent. You did NOT do the work — you are auditing it with fresh eyes.

You are given: a list of acceptance criteria, the repository path, and the git diff produced by a worker agent. For EACH criterion decide whether it is genuinely satisfied. You MAY read files and run read-only commands (git, grep, build/test) to gather evidence. Do NOT modify, create, or delete any files.

Be strict and skeptical. A criterion is "pass" ONLY if you can point to concrete evidence (a file path, a diff hunk, a command output) that it is satisfied. If you are unsure, mark it "fail".

Output ONLY a single JSON object on its own line, no prose before or after, exactly matching:
{"passed": boolean, "results": [{"criterion": string, "status": "pass" | "fail", "evidence": string}]}

"passed" MUST be true only if every criterion's status is "pass".`;

export function buildVerifierPrompt(target: VerifierTarget, diff: string): string {
  const criteria = (target.acceptanceCriteria ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `Repository: ${target.workdir ?? "(unknown)"}`,
    `Parent run id: ${target.runId}`,
    target.task ? `Worker task (for context only):\n${target.task.slice(0, 2000)}` : "",
    "",
    target.transcriptSummary
      ? `AGENT TRANSCRIPT SUMMARY (what the worker reported it did):\n${target.transcriptSummary}`
      : "",
    "",
    "ACCEPTANCE CRITERIA (verify each one):",
    criteria,
    "",
    "GIT DIFF PRODUCED BY THE WORKER:",
    "```diff",
    diff,
    "```",
    "",
    "Now inspect the repository as needed and emit the JSON verdict.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Extract the first balanced JSON object containing a `"passed"` key from a
 * blob of CLI output (which may include surrounding prose or a wrapper).
 */
export function extractVerifierReport(raw: string): VerifierReport | null {
  if (!raw) return null;

  // Some CLIs (claude -p --output-format json) wrap the answer in {result:"..."}.
  // Try that envelope first, then fall back to scanning the raw text.
  const candidates: string[] = [raw];
  try {
    const env = JSON.parse(raw);
    if (env && typeof env === "object" && typeof (env as any).result === "string") {
      candidates.unshift((env as any).result);
    }
  } catch {
    /* not an envelope */
  }

  for (const text of candidates) {
    const report = scanForReport(text);
    if (report) return report;
  }
  return null;
}

function scanForReport(text: string): VerifierReport | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        if (slice.includes('"passed"')) {
          try {
            const parsed = JSON.parse(slice);
            if (parsed && typeof parsed.passed === "boolean" && Array.isArray(parsed.results)) {
              return normalizeReport(parsed);
            }
          } catch {
            /* keep scanning */
          }
        }
        start = -1;
      }
    }
  }
  return null;
}

function normalizeReport(parsed: any): VerifierReport {
  const results: VerifierCriterionResult[] = Array.isArray(parsed.results)
    ? parsed.results.map((r: any) => ({
        criterion: String(r?.criterion ?? ""),
        status: r?.status === "pass" ? "pass" : "fail",
        evidence: String(r?.evidence ?? ""),
      }))
    : [];
  // Recompute `passed` defensively: only true if every result passed.
  const passed = results.length > 0 && results.every((r) => r.status === "pass");
  return { passed: Boolean(parsed.passed) && passed, results };
}

/** Resolve a PATH that includes the usual user/global bin dirs, since the
 *  gateway daemon may run with a stripped PATH. */
function enrichedPath(): string {
  const home = process.env.HOME || "";
  const extra = [
    home ? `${home}/.local/bin` : "",
    home ? `${home}/.bun/bin` : "",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  const current = process.env.PATH || "";
  return [current, ...extra].filter(Boolean).join(":");
}

/**
 * Spawn a REAL independent verifier child (`claude -p`), feed it the criteria +
 * diff, and parse its JSON verdict. Fail-closed on any error.
 */
export async function spawnVerifier(target: VerifierTarget): Promise<VerifierReport> {
  const criteria = target.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    return { passed: true, results: [] };
  }
  const workdir = target.workdir || process.cwd();

  let diff = "";
  try {
    diff = await collectRepoDiff(workdir, target.startedAtCommit);
  } catch (err) {
    log.warn("verifier: diff collection failed", {
      runId: target.runId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const prompt = buildVerifierPrompt(target, diff);
  const command = process.env.INFINIBOT_VERIFIER_CMD || "claude";

  return new Promise<VerifierReport>((resolve) => {
    let settled = false;
    const finish = (report: VerifierReport) => {
      if (settled) return;
      settled = true;
      resolve(report);
    };

    let stdout = "";
    let stderr = "";
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: enrichedPath() };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY_OLD;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        command,
        [
          "-p",
          "--output-format",
          "json",
          // The verifier only reads the prompt (criteria + diff, which is
          // untrusted content); in SaaS it never gets the permission bypass.
          ...(allowCoderBypassFlag(true) ? ["--dangerously-skip-permissions"] : []),
          "--append-system-prompt",
          VERIFIER_SYSTEM_PROMPT,
          prompt,
        ],
        { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      log.warn("verifier: spawn threw", {
        runId: target.runId,
        err: err instanceof Error ? err.message : String(err),
      });
      finish(failClosed(criteria, `verifier spawn failed: ${String(err)}`));
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      log.warn("verifier: timed out", { runId: target.runId });
      finish(failClosed(criteria, "verifier timed out before returning a verdict"));
    }, VERIFIER_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      log.warn("verifier: child error", { runId: target.runId, err: err.message });
      finish(failClosed(criteria, `verifier child error: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const report = extractVerifierReport(stdout);
      if (report) {
        log.info("verifier: verdict parsed", {
          runId: target.runId,
          passed: report.passed,
          criteria: report.results.length,
        });
        finish(report);
        return;
      }
      log.warn("verifier: could not parse verdict — failing closed", {
        runId: target.runId,
        exitCode: code,
        stderr: stderr.slice(0, 500),
        stdoutTail: stdout.slice(-500),
      });
      finish(
        failClosed(
          criteria,
          `verifier produced no parseable verdict (exit ${code}); failing closed`,
        ),
      );
    });
  });
}

function failClosed(criteria: string[], reason: string): VerifierReport {
  return {
    passed: false,
    results: criteria.map((c) => ({ criterion: c, status: "fail" as const, evidence: reason })),
  };
}

export function formatVerifierComment(report: VerifierReport): string {
  const header = report.passed
    ? "✅ Verifier PASSED — all acceptance criteria satisfied."
    : "🛑 Verifier FAILED — task held in review (self-report alone cannot mark this done).";
  const lines = report.results.map(
    (r) => `${r.status === "pass" ? "✓" : "✗"} ${r.criterion}\n    evidence: ${r.evidence}`,
  );
  return [header, "", ...lines].join("\n");
}

/** Dependencies for the gate, injected so it is unit-testable without a real
 *  child process or live kanban backend. */
export interface KanbanGateDeps {
  spawnVerifier: (target: VerifierTarget) => Promise<VerifierReport>;
  updateTask: (taskId: string, patch: { status: string }) => Promise<unknown> | unknown;
  appendComment: (taskId: string, body: string) => Promise<unknown> | unknown;
}

export interface KanbanGateResult {
  status: "done" | "review";
  verified: boolean;
  report?: VerifierReport;
}

/**
 * THE GATE. Decides the kanban status for a finished run and applies it.
 *
 *  - outcome "error"          → "review" (no verification; worker failed)
 *  - no acceptanceCriteria    → "done"   (legacy un-gated path; backwards compat)
 *  - criteria + verifier pass → "done"   (+ report comment)
 *  - criteria + verifier fail → "review" (+ failing-criteria comment), NEVER done
 */
export async function gateKanbanTransition(
  args: { target: VerifierTarget; outcomeStatus: "ok" | "error" | undefined },
  deps: KanbanGateDeps,
): Promise<KanbanGateResult> {
  const { target, outcomeStatus } = args;
  const taskId = target.kanbanTaskId;

  // Worker itself failed — straight to review, no verification.
  if (outcomeStatus === "error") {
    if (taskId) await deps.updateTask(taskId, { status: "review" });
    return { status: "review", verified: false };
  }

  const criteria = target.acceptanceCriteria ?? [];
  // Legacy / un-gated spawn: no criteria → keep exit-code → done behaviour.
  if (criteria.length === 0) {
    if (taskId) await deps.updateTask(taskId, { status: "done" });
    return { status: "done", verified: false };
  }

  // Verifier-gated path.
  const report = await deps.spawnVerifier(target);
  const status: "done" | "review" = report.passed ? "done" : "review";
  if (taskId) {
    await deps.updateTask(taskId, { status });
    await deps.appendComment(taskId, formatVerifierComment(report));
  }
  return { status, verified: true, report };
}
