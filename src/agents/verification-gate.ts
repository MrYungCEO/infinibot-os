/**
 * Mandatory verification gate for sub-agent / coder completions.
 *
 * The "verify before done" rule is UNCONDITIONAL: every coder spawn — claude,
 * codex, opencode or gemini, any task kind, whether or not the agent emitted a
 * checkpoint — must pass an INDEPENDENT verifier before its kanban task is
 * allowed to reach "done".
 *
 * ── Root cause this module fixes ────────────────────────────────────────────
 * A real independent verifier already existed in `coder-runtime/verifier.ts`
 * (it spawns a fresh `claude -p` child that audits the git diff against
 * acceptance criteria, fail-closed). But it was ORPHANED — nothing ever called
 * `gateKanbanTransition`/`spawnVerifier`, and nothing populated
 * `acceptanceCriteria`. Meanwhile the two real completion chokepoints flipped
 * the task straight to "done" on a clean exit code:
 *   1. `finishKanban` in tools/claude-coder-tool.ts (coder MCP-tool path, all backends)
 *   2. `applyLifecycleEvent` / `triggerCleanupForEntry` in subagent-registry.ts
 *      (native agent-event lifecycle path)
 * This module is the single orchestration layer both chokepoints now route
 * through. It:
 *   - extracts acceptance criteria from the brief (so verification runs even
 *     when the spawn provided none — the un-gated bypass is closed),
 *   - parks the task in "review" BEFORE verifying (never transiently "done"),
 *   - runs the independent verifier child against the real git diff,
 *   - cross-checks off-limits files DETERMINISTICALLY (never trusted to an LLM),
 *   - promotes to "done" only on a clean pass; any fail / verifier error /
 *     timeout leaves the task in "review" (fail-closed).
 */

import fs from "node:fs/promises";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  computeOffLimitsViolations,
  extractAcceptanceCriteria,
  extractOffLimitsPatterns,
  type SpecAnalysisResult,
} from "./spec-analysis.js";
import { getProgress } from "./subagent-progress.js";
import { mcpUpdateTask } from "./tools/kanban-tool.js";
import { spawnVerifier, type VerifierReport } from "./coder-runtime/verifier.js";

const log = createSubsystemLogger("verify-gate");

/** Hard ceiling on the whole verification step. On timeout we fail-closed → review. */
const VERIFY_TIMEOUT_MS = 6 * 60_000;

/**
 * Fallback criterion used when the brief yields no explicit acceptance criteria.
 * Guarantees verification is UNCONDITIONAL — even a criteria-less task gets an
 * independent diff audit instead of an automatic pass.
 */
const DEFAULT_CRITERION =
  "The work described in the task brief was actually carried out and is evidenced by concrete, relevant changes in the git diff (not an empty or no-op diff).";

export interface VerificationVerdict {
  /** True only when the run cleanly verified (allows promotion to "done"). */
  pass: boolean;
  /** Human-readable one-liner explaining the verdict (logged + attached). */
  reason: string;
  /** True when the verdict is a fail-closed default (infra/grading gap, not a graded fail). */
  failClosed: boolean;
  /** The independent verifier's structured report, when one was produced. */
  report?: VerifierReport;
}

export interface VerifyOpts {
  runId: string;
  /** Kanban task to gate. When absent the verifier still runs (audit trail) but no status flips. */
  taskId?: string;
  /** Did the agent PROCESS exit cleanly? A dirty exit skips verification → review. */
  succeeded: boolean;
  /** Extra evidence text (terminal output / final reply) — folded into the brief context. */
  extraEvidence?: string;
  /** Backend label for logs only. */
  backend?: string;
  /** Optional explicit overrides; resolved from the registry/history by runId when omitted. */
  brief?: string;
  filesTouched?: Array<{ path: string; action?: string }>;
  workdir?: string;
  sessionKey?: string;
  /** Commit SHA captured at spawn time, used as the diff base. Falls back to HEAD. */
  startedAtCommit?: string;
  /** Absolute path to the JSONL transcript, resolved from the run record. */
  transcriptPath?: string;
}

// ── Single-flight guard ──────────────────────────────────────────────────────
// Both completion chokepoints can fire for the same run (e.g. coder `await`
// mode calls finishKanban AND the lifecycle listener sees an "end" event). The
// verifier is the expensive part, so we run it at most once per runId.
const verifyInFlight = new Set<string>();
const verifyDone = new Map<string, VerificationVerdict>();
const VERIFY_DONE_CAP = 5_000;

function rememberVerdict(runId: string, verdict: VerificationVerdict): void {
  verifyDone.set(runId, verdict);
  if (verifyDone.size > VERIFY_DONE_CAP) {
    const oldest = verifyDone.keys().next().value;
    if (oldest !== undefined) verifyDone.delete(oldest);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Resolve the verifier inputs (brief / files / workdir / sessionKey / transcriptPath)
 * from the subagent registry (live) or history (archived) when the caller didn't
 * supply them.  Dynamic import avoids a static cycle (the registry imports this module).
 */
async function resolveRunInputs(opts: VerifyOpts): Promise<{
  brief: string;
  filesTouched: Array<{ path: string; action?: string }>;
  workdir?: string;
  sessionKey?: string;
  transcriptPath?: string;
}> {
  let brief = opts.brief ?? "";
  let filesTouched = opts.filesTouched ?? [];
  let workdir = opts.workdir;
  let sessionKey = opts.sessionKey;
  let transcriptPath = opts.transcriptPath;
  try {
    const reg = await import("./subagent-registry.js");
    const live = reg.getSubagentRun(opts.runId);
    if (live) {
      if (!brief) brief = live.task ?? "";
      if (!filesTouched.length && live.filesTouched?.length) {
        filesTouched = live.filesTouched.map((f) => ({ path: f.path, action: f.action }));
      }
      workdir = workdir ?? live.workdir;
      sessionKey = sessionKey ?? live.requesterSessionKey;
      transcriptPath = transcriptPath ?? live.transcriptPath;
    } else {
      const hist = await import("./subagent-history.js");
      const arc = hist.getSubagentHistoryEntryByRunId(opts.runId);
      if (arc) {
        if (!brief) brief = arc.task ?? "";
        if (!filesTouched.length && arc.filesTouchedSample?.length) {
          filesTouched = arc.filesTouchedSample.map((p) => ({ path: p, action: "edited" }));
        }
        workdir = workdir ?? arc.workdir;
        sessionKey = sessionKey ?? arc.requesterSessionKey;
        transcriptPath = transcriptPath ?? arc.transcriptPath;
      }
    }
  } catch (err) {
    log.debug("[verify] could not resolve run inputs from registry", {
      runId: opts.runId,
      err: msg(err),
    });
  }
  return { brief, filesTouched, workdir, sessionKey, transcriptPath };
}

const MAX_TRANSCRIPT_SUMMARY_CHARS = 8000;

/**
 * Read the JSONL transcript file and return a bounded plain-text summary.
 * Extracts role:content lines, skips empty turns, caps at MAX_TRANSCRIPT_SUMMARY_CHARS.
 */
async function readTranscriptSummary(transcriptPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(transcriptPath, "utf-8");
    const lines: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const role = String(obj.role ?? "");
        const content =
          typeof obj.content === "string"
            ? obj.content.trim()
            : Array.isArray(obj.content)
              ? (obj.content as Array<{ text?: string }>)
                  .map((p) => p.text ?? "")
                  .join(" ")
                  .trim()
              : "";
        if (content) lines.push(`${role}: ${content.slice(0, 500)}`);
      } catch {
        /* skip malformed lines */
      }
    }
    return lines.join("\n").slice(0, MAX_TRANSCRIPT_SUMMARY_CHARS);
  } catch {
    return "";
  }
}

/** Fold recent progress updates + the brief into context for the verifier prompt. */
function buildBriefContext(runId: string, brief: string, extra?: string): string {
  const progress = getProgress(runId);
  const updates = (progress?.updates ?? [])
    .map((u) => u.message)
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    .slice(-12);
  const parts: string[] = [brief.trim()].filter(Boolean);
  if (updates.length) parts.push("=== AGENT PROGRESS UPDATES ===", updates.join("\n"));
  if (extra && extra.trim()) parts.push("=== FINAL OUTPUT ===", extra.trim().slice(0, 2000));
  return parts.join("\n\n");
}

/** Synthesize a SpecAnalysisResult-shaped object so the existing oversight tab can render the verdict. */
function reportToSpecShape(
  brief: string,
  report: VerifierReport,
  offLimitsPatterns: string[],
  offLimitsViolations: ReturnType<typeof computeOffLimitsViolations>,
  verdict: VerificationVerdict,
  criteriaInferred: boolean,
): Record<string, unknown> {
  const criteria: SpecAnalysisResult["criteria"] = report.results.map((r) => ({
    text: r.criterion,
    status: r.status === "pass" ? ("met" as const) : ("unmet" as const),
    evidence: r.evidence?.slice(0, 160) ?? "",
    inferred: criteriaInferred,
  }));
  const spec: SpecAnalysisResult = {
    brief,
    criteria,
    deferred: [],
    offLimitsPatterns,
    offLimitsViolations,
    summary: verdict.reason,
    heuristicOnly: false,
    criteriaInferred,
    analyzedAt: Date.now(),
  };
  return {
    ...(spec as unknown as Record<string, unknown>),
    verification: {
      pass: verdict.pass,
      reason: verdict.reason,
      failClosed: verdict.failClosed,
      verifiedAt: Date.now(),
    },
  };
}

/**
 * Run the independent verifier + deterministic off-limits check and return a
 * verdict. No kanban side effects. Exported for tests.
 */
export async function runVerifier(opts: VerifyOpts): Promise<VerificationVerdict> {
  const { brief, filesTouched, workdir, transcriptPath } = await resolveRunInputs(opts);

  // Read the full transcript so the verifier has the agent's own account of the work.
  const transcriptSummary = transcriptPath ? await readTranscriptSummary(transcriptPath) : "";

  // Deterministic, highest-priority signal — computed here, never trusted to the LLM.
  const offLimitsPatterns = extractOffLimitsPatterns(brief);
  const offLimitsViolations = computeOffLimitsViolations(offLimitsPatterns, filesTouched);

  // Always have at least one criterion so verification is unconditional.
  const extracted = extractAcceptanceCriteria(brief);
  const acceptanceCriteria = extracted.length ? extracted : [DEFAULT_CRITERION];
  // When we fell back to the default criterion the brief stated none — the
  // oversight tab labels these "(inferred)" just like the spec-analysis path.
  const criteriaInferred = extracted.length === 0;

  const report = await spawnVerifier({
    runId: opts.runId,
    task: buildBriefContext(opts.runId, brief, opts.extraEvidence),
    kanbanTaskId: opts.taskId,
    acceptanceCriteria,
    workdir,
    startedAtCommit: opts.startedAtCommit,
    transcriptSummary: transcriptSummary || undefined,
  });

  let verdict: VerificationVerdict;
  if (offLimitsViolations.length > 0) {
    const list = offLimitsViolations
      .map((v) => v.path)
      .slice(0, 5)
      .join(", ");
    verdict = {
      pass: false,
      failClosed: false,
      reason: `off-limits files modified: ${list}`,
      report,
    };
  } else if (report.passed) {
    verdict = {
      pass: true,
      failClosed: false,
      reason: `independent verifier passed ${report.results.length} acceptance criteria, no off-limits violations`,
      report,
    };
  } else {
    const failing = report.results.filter((r) => r.status === "fail");
    const sample = failing
      .map((r) => r.criterion)
      .slice(0, 3)
      .join("; ");
    // failClosed when the verifier produced no graded results (spawn/parse/timeout fail).
    const failClosed = report.results.every(
      (r) => r.status === "fail" && /verifier/i.test(r.evidence),
    );
    verdict = {
      pass: false,
      failClosed,
      reason: failing.length
        ? `verifier failed ${failing.length} criteria: ${sample}`
        : "verifier did not pass",
      report,
    };
  }

  // Cache onto the run record so the Spec-vs-Result oversight tab shows it.
  try {
    const reg = await import("./subagent-registry.js");
    reg.updateSubagentRunSpecAnalysis(
      opts.runId,
      reportToSpecShape(
        brief,
        report,
        offLimitsPatterns,
        offLimitsViolations,
        verdict,
        criteriaInferred,
      ),
    );
  } catch {
    /* best-effort */
  }

  return verdict;
}

/**
 * Injectable seams so the gate is testable without a real verifier child or a
 * live Notion-backed kanban. Production call sites pass nothing and get the
 * real `mcpUpdateTask` + `runVerifier`.
 */
export interface GateDeps {
  updateTask?: (taskId: string, patch: { status: string }) => Promise<unknown>;
  runVerifier?: (opts: VerifyOpts) => Promise<VerificationVerdict>;
  /**
   * True when the verified-completion pipeline owns this run's kanban status
   * (src/verification/kanban-reconcile.ts moves the task from the run's
   * verdict). The gate then runs audit-only — it still verifies, but never
   * writes the status, so the two verdicts can't flap the card.
   * Defaults to "pipeline + reconciler enabled" unless a test injects updateTask.
   */
  pipelineOwnsKanban?: (runId: string) => boolean;
}

function defaultPipelineOwnsKanban(): boolean {
  return (
    process.env.INFINIBOT_VERIFIED_COMPLETION !== "0" &&
    process.env.INFINIBOT_KANBAN_RECONCILE !== "0"
  );
}

/**
 * UNCONDITIONAL verification gate. Route every coder / sub-agent completion
 * through here. Sets the terminal kanban status with a fail-closed independent
 * verifier in the loop. Idempotent per runId via the single-flight guard.
 */
export async function verifyAndFinalizeKanban(
  opts: VerifyOpts,
  deps: GateDeps = {},
): Promise<VerificationVerdict> {
  const { runId } = opts;
  const pipelineOwns = deps.pipelineOwnsKanban
    ? deps.pipelineOwnsKanban(runId)
    : deps.updateTask
      ? false
      : defaultPipelineOwnsKanban();
  // Audit-only when the verification pipeline reconciles the board.
  const taskId = pipelineOwns ? undefined : opts.taskId;
  if (pipelineOwns && opts.taskId)
    log.debug("[verify] kanban owned by the verification pipeline — audit only", {
      runId,
      taskId: opts.taskId,
    });
  const updateTask = deps.updateTask ?? ((id, patch) => mcpUpdateTask(id, patch));
  const verify = deps.runVerifier ?? runVerifier;

  const prior = verifyDone.get(runId);
  if (prior) {
    log.debug("[verify] already handled, reusing verdict", { runId, taskId, pass: prior.pass });
    return prior;
  }
  if (verifyInFlight.has(runId)) {
    log.debug("[verify] already in flight, skipping duplicate", { runId, taskId });
    return { pass: false, failClosed: true, reason: "verification already in flight" };
  }
  verifyInFlight.add(runId);

  try {
    // A dirty agent exit → nothing verifiable, park in review.
    if (!opts.succeeded) {
      if (taskId) {
        await updateTask(taskId, { status: "review" }).catch((err) =>
          log.warn("[verify] review-park failed (agent-failed path)", {
            runId,
            taskId,
            err: msg(err),
          }),
        );
      }
      log.info("[verify] skipped agent did-not-exit-cleanly → review", { runId, taskId });
      const verdict: VerificationVerdict = {
        pass: false,
        failClosed: true,
        reason: "agent process did not exit cleanly",
      };
      rememberVerdict(runId, verdict);
      return verdict;
    }

    log.info("[verify] start", { runId, taskId, backend: opts.backend });

    // Park in "review" BEFORE verifying — the task is never transiently "done".
    if (taskId) {
      await updateTask(taskId, { status: "review" }).catch((err) =>
        log.warn("[verify] could not park task in review", { runId, taskId, err: msg(err) }),
      );
    }

    let verdict: VerificationVerdict;
    try {
      verdict = await withTimeout(verify(opts), VERIFY_TIMEOUT_MS, "verifier");
    } catch (err) {
      // Fail-closed: verifier failed to launch or timed out → stay in review.
      log.warn("[verify] spawn-error → staying in review (fail-closed)", {
        runId,
        taskId,
        err: msg(err),
      });
      verdict = { pass: false, failClosed: true, reason: `verifier error: ${msg(err)}` };
      rememberVerdict(runId, verdict);
      return verdict;
    }

    if (verdict.pass) {
      if (taskId) {
        await updateTask(taskId, { status: "done" }).catch((err) =>
          log.warn("[verify] pass but kanban done-flip failed", { runId, taskId, err: msg(err) }),
        );
      }
      log.info("[verify] pass → done", { runId, taskId, reason: verdict.reason });
    } else {
      // Already parked in "review"; this is the needs-changes state given the
      // kanban status vocabulary (backlog/todo/in_progress/review/done).
      log.warn("[verify] fail → held in review", {
        runId,
        taskId,
        reason: verdict.reason,
        failClosed: verdict.failClosed,
      });
    }

    rememberVerdict(runId, verdict);
    return verdict;
  } finally {
    verifyInFlight.delete(runId);
  }
}

/** Test/diagnostic helper — clear the single-flight memory. */
export function __resetVerificationGateForTests(): void {
  verifyInFlight.clear();
  verifyDone.clear();
}
