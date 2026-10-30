/**
 * Verified-completion pipeline — what happens when a spawned run's process exits.
 *
 *   exit → digest transcript → classify
 *     premature / no RESULT      → resume SAME session with a "Continue: …" prompt
 *     complete / blocked / input → evidence checks + LLM review → verdict
 *       UNVERIFIED with fixable gaps (e.g. visual change without screenshots)
 *                                → resume with the gaps listed
 *     → terminal state (exactly one per round), written to the inbox first,
 *       then pushed (UI / MCP / Telegram), and mirrored into the reviews store.
 *
 * Bounded: at most `maxContinuations` resumes per round, then `stalled`.
 * Everything that touches processes / models / git is injectable for tests.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildContinuationPrompt } from "./contract.js";
import { classifyExit, type ExitClassification } from "./classifier.js";
import { collectEvidence, type EvidenceInput } from "./evidence.js";
import { composeVerdict, runLlmReview, type JudgeFn, type ReviewOutcome } from "./reviewer.js";
import {
  createRecord,
  getRecord,
  isTerminal,
  listRecords,
  resettleRecord,
  markTerminal,
  recordEvent,
  updateRecord,
  type CompletionAttempt,
  type CompletionRecord,
  type CompletionState,
} from "./store.js";
import { digestTranscript } from "./transcript.js";
import { detectVisualChanges } from "./visual-files.js";
import { isGatewayStopping, isSignalExit } from "./lifecycle.js";
import {
  actionMessage,
  challengeMessage,
  decideEscalation,
  reviewerActions,
  verdictMessage,
  workerMessage,
} from "./review-dialogue.js";
import {
  REVIEW_ROUND_CAP,
  REVIEWER_AGENT,
  appendReviewMessage,
  currentReviewRound,
  formatChallengeForWorker,
  readReviewThread,
  type ReviewEscalation,
  type ReviewMessage,
} from "./review-thread.js";
import type { BaselineRunFn } from "./evidence.js";

const log = createSubsystemLogger("verification");

export interface AttemptOutcome {
  exitCode: number | null;
  killed?: boolean;
  /**
   * The attempt died with a gateway restart/shutdown or could not be started
   * (e.g. dist being rebuilt). Not a failure of the agent's work.
   */
  interrupted?: boolean;
  interruptReason?: string;
  /** Raw CLI stdout (NDJSON or text) of THIS attempt. */
  rawOutput: string;
  /** Parsed final text the launcher already extracted (SessionInfo.output). */
  outputText?: string;
  sessionId?: string | null;
}

export interface ContinuationRequest {
  runId: string;
  prompt: string;
  sessionId: string;
  attempt: number;
  /** Durable tmux key for the continuation (distinct per attempt). */
  durableKey: string;
}

export type ContinuationSpawner = (req: ContinuationRequest) => Promise<AttemptOutcome>;

export interface PipelineDeps {
  judge?: JudgeFn;
  runCommand?: EvidenceInput["runCommand"];
  rerunCommands?: boolean;
  /** Push fan-out; defaults to notify.ts deliverTerminal. */
  deliver?: (
    rec: CompletionRecord,
    ev: NonNullable<ReturnType<typeof markTerminal>>,
  ) => Promise<void> | void;
  /** Mirror into the reviews store; defaults to reviews-bridge.ts. */
  mirrorReview?: (rec: CompletionRecord) => Promise<void> | void;
  onContinue?: (req: ContinuationRequest) => void;
  /** Baseline (base-commit) re-runner; defaults to a temp-worktree runner. Null disables. */
  baselineRun?: BaselineRunFn | null;
  /** Deliver a reviewer challenge into the worker's run inbox (defaults to subagent-inbox). */
  deliverChallenge?: (rec: CompletionRecord, msg: ReviewMessage, text: string) => void;
}

/** Review-thread messages on (INFINIBOT_REVIEW_THREAD=0 turns the dialogue off). */
export function isReviewThreadEnabled(): boolean {
  return process.env.INFINIBOT_REVIEW_THREAD !== "0";
}

function post(
  runId: string,
  draft: Parameters<typeof appendReviewMessage>[1],
): ReviewMessage | null {
  if (!isReviewThreadEnabled()) return null;
  try {
    return appendReviewMessage(runId, draft);
  } catch (err) {
    log.warn("review thread append failed", { runId, err: String(err) });
    return null;
  }
}

async function defaultBaselineRun(): Promise<BaselineRunFn> {
  const { createBaselineRunner } = await import("./baseline.js");
  return createBaselineRunner();
}

function defaultDeliverChallenge(rec: CompletionRecord, msg: ReviewMessage, text: string): void {
  void import("../agents/subagent-inbox/store.js")
    .then(({ enqueueInboxMessage, appendInboxEvent }) => {
      const m = enqueueInboxMessage({
        runId: rec.runId,
        text,
        from: `${REVIEWER_AGENT.id} (review ${msg.id})`,
        childSessionKey: rec.childSessionKey,
      });
      // The continuation prompt carries it — never inject it a second time.
      appendInboxEvent(rec.runId, {
        id: m.id,
        type: "delivered",
        at: Date.now(),
        via: "review-continuation",
        note: msg.id,
      });
    })
    .catch(() => {
      /* the continuation prompt still carries the challenge */
    });
}

export function isVerificationEnabled(): boolean {
  return process.env.INFINIBOT_VERIFIED_COMPLETION !== "0";
}

const defaultJudge: JudgeFn = async (input) => {
  const { judgeTextDetailed } = await import("../autonomy/goal-judge.js");
  return judgeTextDetailed(input);
};

async function defaultDeliver(
  rec: CompletionRecord,
  ev: NonNullable<ReturnType<typeof markTerminal>>,
): Promise<void> {
  const { deliverTerminal } = await import("./notify.js");
  await deliverTerminal(rec, ev);
}

async function defaultMirror(rec: CompletionRecord): Promise<void> {
  const { mirrorCompletionIntoReviews } = await import("./reviews-bridge.js");
  mirrorCompletionIntoReviews(rec);
}

export { createRecord as beginVerifiedRun };

function currentAttempt(rec: CompletionRecord): CompletionAttempt {
  return rec.attempts[rec.attempts.length - 1];
}

function continuationsUsedThisRound(rec: CompletionRecord): number {
  // Attempts started by the pipeline this round (operator reopen resets the budget).
  return rec.attempts.filter((a) => a.prompt && a.round === rec.round).length;
}

/** Visible for tests + the review-only path. */
export async function reviewRecord(
  rec: CompletionRecord,
  classification: ExitClassification,
  finalText: string,
  deps: PipelineDeps,
): Promise<ReviewOutcome> {
  const baselineRun =
    deps.baselineRun === undefined
      ? deps.runCommand
        ? null // injected test runner: no implicit git worktrees
        : await defaultBaselineRun()
      : deps.baselineRun;
  const evidence = await collectEvidence({
    workdir: rec.workdir,
    runId: rec.runId,
    agentDirs: rec.agentWorkdirs,
    visualDirs: rec.visualDirs,
    baseCommit: rec.baseCommit,
    runStartedAt: rec.startedAt,
    result: classification.result,
    rerunCommands: deps.rerunCommands,
    runCommand: deps.runCommand,
    baselineRun,
  });
  const visualFiles = detectVisualChanges([
    ...evidence.actualChangedFiles,
    ...(classification.result?.files_changed ?? []),
  ]);
  const llm =
    classification.kind === "failed"
      ? null
      : await runLlmReview({
          task: rec.task,
          laterInstructions: rec.attempts.map((a) => a.prompt ?? "").filter(Boolean),
          result: classification.result,
          evidence,
          finalText,
          judge: deps.judge ?? defaultJudge,
        });
  const outcome = composeVerdict({ classification, evidence, visualFiles, llm });
  updateRecord(rec.runId, (r) => {
    r.result = classification.result ?? r.result;
    r.review = {
      verdict: outcome.verdict,
      reasons: outcome.reasons,
      evidence: evidence.items,
      visualFiles,
      visualSatisfied: outcome.visualSatisfied,
      screenshots: (classification.result?.screenshots ?? []).filter((s) =>
        evidence.items.some((i) => i.kind === "screenshot" && i.ref === s && i.status === "pass"),
      ),
      llm,
      changedFiles: evidence.actualChangedFiles,
      commits: evidence.actualCommits,
      reviewedAt: Date.now(),
      warnings: outcome.warnings,
      workspace: {
        top: evidence.workspace.top,
        branch: evidence.workspace.branch,
        source: evidence.workspace.source,
      },
    };
    const a = currentAttempt(r);
    a.verdict = outcome.verdict;
    a.reviewReasons = outcome.reasons;
  });
  return outcome;
}

/** Order-insensitive fingerprint of an attempt's problems (shas / numbers blurred). */
export function reasonsSignature(reasons: string[]): string {
  return [
    ...new Set(
      reasons
        .map((r) =>
          r
            .toLowerCase()
            .replace(/\b[0-9a-f]{7,40}\b/g, "#")
            .replace(/\d+/g, "#")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean),
    ),
  ]
    .sort()
    .join("\n");
}

function attemptReasons(a: CompletionAttempt | undefined): string[] {
  return a?.reviewReasons ?? [];
}

/**
 * True when the attempt that just ended was reviewed with the same reasons as
 * the attempt before it (same round) — continuing again would just loop.
 * Premature exits are not compared (the continuation cap bounds those).
 */
export function isRepeatedFailure(rec: CompletionRecord): boolean {
  const n = rec.attempts.length;
  if (n < 2) return false;
  const cur = rec.attempts[n - 1];
  const prev = rec.attempts[n - 2];
  if ((cur.round ?? 1) !== (prev.round ?? 1)) return false;
  const a = reasonsSignature(attemptReasons(cur));
  return a.length > 0 && a === reasonsSignature(attemptReasons(prev));
}

function terminalStateFor(
  classification: ExitClassification,
  outcome: ReviewOutcome,
  exhausted: boolean,
): CompletionState {
  if (outcome.verdict === "VERIFIED") return "verified";
  if (outcome.verdict === "FAILED") return "failed";
  const status = classification.result?.status;
  if (status === "blocked") return "blocked";
  if (status === "needs_input") return "needs_input";
  if (exhausted && (classification.kind === "premature" || classification.kind === "no_result"))
    return "stalled";
  return exhausted ? "stalled" : "unverified";
}

/**
 * Handle the exit of the current attempt and drive the run to a terminal
 * state. Resolves with the final record. Never throws — a pipeline error
 * degrades to an UNVERIFIED terminal state with the error as the reason.
 */
export async function superviseRunExit(params: {
  runId: string;
  outcome: AttemptOutcome;
  spawnContinuation?: ContinuationSpawner | null;
  deps?: PipelineDeps;
}): Promise<CompletionRecord | undefined> {
  const deps = params.deps ?? {};
  let outcome = params.outcome;
  const rec0 = getRecord(params.runId);
  if (!rec0) return undefined;
  if (isTerminal(rec0)) return rec0;

  try {
    for (;;) {
      const digest = digestTranscript(outcome.rawOutput || outcome.outputText || "");
      const classification = classifyExit({
        exitCode: outcome.exitCode,
        killed: outcome.killed,
        digest,
        extraText: outcome.outputText,
      });
      const sessionId = outcome.sessionId ?? digest.sessionId ?? null;
      const prior = getRecord(params.runId);
      const interrupted =
        classification.kind === "failed" &&
        (outcome.interrupted === true ||
          (isGatewayStopping() && (outcome.killed === true || isSignalExit(outcome.exitCode))));
      if (interrupted) {
        // A restart / deploy / failed start killed this attempt. That says
        // nothing about the work: park the run and recheck it after boot.
        const why =
          outcome.interruptReason ??
          (isGatewayStopping()
            ? "attempt ended by a gateway restart/shutdown"
            : "attempt was interrupted");
        updateRecord(params.runId, (r) => {
          const a = currentAttempt(r);
          a.endedAt = Date.now();
          a.exitCode = outcome.exitCode;
          a.kind = "interrupted";
          a.reasons = [why];
          a.sessionId = sessionId ?? a.sessionId;
          r.state = "interrupted";
        });
        recordEvent(params.runId, "run.attempt", {
          summary: `attempt ${prior?.attempts.length ?? "?"} interrupted — will be rechecked after the gateway restarts`,
          reasons: [why],
        });
        log.info("run attempt interrupted", { runId: params.runId, why });
        return getRecord(params.runId);
      }
      // A later continuation was killed (timeout / stop) without a RESULT: the
      // run's work is whatever the last complete attempt reported. Review that
      // instead of failing work that was already done.
      let killedContinuation: string | null = null;
      if (
        classification.kind === "failed" &&
        prior &&
        prior.attempts.length > 1 &&
        prior.result &&
        prior.attempts.slice(0, -1).some((a) => a.kind === "complete")
      ) {
        killedContinuation = classification.reasons.join("; ") || "continuation killed";
        const res = prior.result;
        classification.kind =
          res.status === "blocked"
            ? "blocked"
            : res.status === "needs_input"
              ? "needs_input"
              : "complete";
        classification.result = res;
        classification.reasons = [];
      }
      let rec = updateRecord(params.runId, (r) => {
        const a = currentAttempt(r);
        a.endedAt = Date.now();
        a.exitCode = outcome.exitCode;
        a.kind = killedContinuation ? "failed" : classification.kind;
        a.reasons = killedContinuation
          ? [`${killedContinuation} — reviewed the last complete RESULT instead`]
          : classification.reasons;
        a.sessionId = sessionId ?? a.sessionId;
        a.workdirs = digest.workdirs;
        r.result = classification.result ?? r.result;
        r.state = "reviewing";
        if (digest.workdirs.length)
          r.agentWorkdirs = [...new Set([...digest.workdirs, ...(r.agentWorkdirs ?? [])])].slice(0, 32);
        if (digest.visualDirs.length)
          r.visualDirs = [...new Set([...(r.visualDirs ?? []), ...digest.visualDirs])].slice(-60);
      })!;
      // Worker → Auditor: first report is a submission, later ones answer a challenge.
      const thread = readReviewThread(rec.runId);
      if (!thread.some((m) => m.from === "worker" && m.attempt === rec.attempts.length)) {
        post(rec.runId, {
          ...workerMessage({
            classification,
            isResponse: thread.some((m) => m.kind === "challenge"),
            attemptKind: classification.kind,
          }),
          attempt: rec.attempts.length,
        });
      }
      recordEvent(rec.runId, "run.attempt", {
        summary: `attempt ${rec.attempts.length} exited (${classification.kind})`,
        reasons: classification.reasons,
      });
      log.info("run attempt classified", {
        runId: rec.runId,
        attempt: rec.attempts.length,
        kind: classification.kind,
        exitCode: outcome.exitCode,
      });

      const lastSession =
        sessionId ?? [...rec.attempts].reverse().find((a) => a.sessionId)?.sessionId ?? null;
      const used = continuationsUsedThisRound(rec);
      // Review rounds are capped: at most REVIEW_ROUND_CAP evaluations per round.
      const budget = Math.min(rec.maxContinuations, REVIEW_ROUND_CAP - 1);
      const canContinue = Boolean(params.spawnContinuation && lastSession && used < budget);

      // 1. Premature exit / missing RESULT → continue before spending a review.
      let continuePrompt: string | null = null;
      let review: ReviewOutcome | null = null;
      if (
        (classification.kind === "premature" || classification.kind === "no_result") &&
        canContinue
      ) {
        continuePrompt = buildContinuationPrompt(classification.reasons);
        const ch = post(rec.runId, {
          from: "reviewer",
          to: "worker",
          kind: "challenge",
          title: "You stopped before finishing — finish and report",
          text: "I can't review this yet: your run ended before it was done.",
          items: [
            ...classification.reasons.slice(0, 5),
            "finish the remaining work, wait for background jobs, then end with the RESULT block",
          ],
        });
        if (ch) {
          continuePrompt = `${continuePrompt}\n\n(This is a challenge from ${REVIEWER_AGENT.name}, the verification reviewer — round ${ch.round}/${REVIEW_ROUND_CAP}. Your RESULT block is your reply; record each check's "cwd" in checks_run.)`;
          (deps.deliverChallenge ?? defaultDeliverChallenge)(rec, ch, continuePrompt);
        }
      } else {
        review = await reviewRecord(
          rec,
          classification,
          killedContinuation
            ? `${rec.result?.summary ?? ""}\n(continuation attempt killed: ${killedContinuation})`
            : digest.fullText || outcome.outputText || "",
          deps,
        );
        const humanStop =
          classification.result?.status === "blocked" ||
          classification.result?.status === "needs_input";
        const reviewed = getRecord(rec.runId) ?? rec;
        const act = actionMessage(
          reviewerActions(reviewed.review?.evidence ?? [], review.warnings),
        );
        if (act) post(rec.runId, act);
        if (
          review.verdict !== "VERIFIED" &&
          review.fixable.length > 0 &&
          !humanStop &&
          canContinue &&
          !killedContinuation &&
          classification.kind !== "failed" &&
          !isRepeatedFailure(reviewed)
        ) {
          continuePrompt = buildContinuationPrompt(
            review.reasons.slice(0, 8),
            `Close these gaps:\n- ${review.fixable.slice(0, 8).join("\n- ")}`,
          );
          const ch = post(rec.runId, {
            ...challengeMessage({
              outcome: review,
              items: reviewed.review?.evidence ?? [],
              round: currentReviewRound(readReviewThread(rec.runId)),
            }),
          });
          if (ch) {
            // The continuation IS the worker's reply to the Auditor's challenge.
            continuePrompt = `${formatChallengeForWorker(ch)}\n\nDo not end your turn while background work is still running. End with the <<<RESULT … RESULT>>> block.`;
            (deps.deliverChallenge ?? defaultDeliverChallenge)(rec, ch, continuePrompt);
          }
        }
      }

      // 2. Same problems as the previous attempt → continuing would only loop.
      let repeated = false;
      if (review && review.verdict !== "VERIFIED") {
        const latest = getRecord(rec.runId) ?? rec;
        if (isRepeatedFailure(latest)) {
          repeated = true;
          continuePrompt = null;
          recordEvent(rec.runId, "run.attempt", {
            summary: "auto-continuation stopped: identical review reasons on consecutive attempts",
            reasons: attemptReasons(currentAttempt(latest)),
          });
        }
      }

      if (continuePrompt && params.spawnContinuation && lastSession) {
        const attemptN = rec.attempts.length + 1;
        const durableKey = `${rec.runId}-c${attemptN}`;
        rec = updateRecord(rec.runId, (r) => {
          r.state = "continuing";
          r.attempts.push({
            n: attemptN,
            startedAt: Date.now(),
            endedAt: null,
            exitCode: null,
            kind: null,
            reasons: [],
            sessionId: lastSession,
            durableKey,
            prompt: continuePrompt!,
            round: r.round,
          });
        })!;
        recordEvent(rec.runId, "run.continued", {
          summary: `auto-continuing (attempt ${attemptN})`,
          reasons: review?.reasons ?? classification.reasons,
        });
        const req: ContinuationRequest = {
          runId: rec.runId,
          prompt: continuePrompt,
          sessionId: lastSession,
          attempt: attemptN,
          durableKey,
        };
        deps.onContinue?.(req);
        try {
          outcome = await params.spawnContinuation(req);
        } catch (err) {
          outcome = {
            exitCode: null,
            killed: true,
            interrupted: true,
            interruptReason: `continuation could not start: ${err instanceof Error ? err.message : String(err)}`,
            rawOutput: "",
            outputText: "",
          };
        }
        continue;
      }

      // Terminal.
      if (!review) review = await reviewRecord(rec, classification, digest.fullText, deps);
      const evidenceItems = (getRecord(rec.runId) ?? rec).review?.evidence ?? [];
      const escalation = decideEscalation({
        classification,
        outcome: review,
        repeated,
        items: evidenceItems,
      });
      if (repeated && review.verdict !== "VERIFIED") {
        return await finish(
          rec.runId,
          "needs_owner",
          [
            "stopped auto-continuing: the same problems came back on consecutive attempts",
            ...review.reasons,
          ],
          deps,
          { outcome: review, escalation },
        );
      }
      const exhausted =
        Boolean(params.spawnContinuation) && !canContinue && review.verdict === "UNVERIFIED";
      const state = terminalStateFor(
        classification,
        review,
        exhausted && review.fixable.length > 0,
      );
      return await finish(rec.runId, state, review.reasons, deps, { outcome: review, escalation });
    }
  } catch (err) {
    log.warn("verification pipeline error", {
      runId: params.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    updateRecord(params.runId, (r) => {
      r.review = r.review ?? {
        verdict: "UNVERIFIED",
        reasons: [],
        evidence: [],
        visualFiles: [],
        visualSatisfied: false,
        screenshots: [],
        llm: null,
        changedFiles: [],
        commits: [],
        reviewedAt: Date.now(),
      };
      r.review.verdict = r.review.verdict === "VERIFIED" ? "UNVERIFIED" : r.review.verdict;
      r.review.reasons = [...r.review.reasons, `verification pipeline error: ${String(err)}`];
    });
    return await finish(
      params.runId,
      "unverified",
      [`verification pipeline error: ${String(err)}`],
      deps,
    );
  }
}

async function finish(
  runId: string,
  state: CompletionState,
  reasons: string[],
  deps: PipelineDeps,
  dialogue?: { outcome: ReviewOutcome | null; escalation: ReviewEscalation | null },
): Promise<CompletionRecord | undefined> {
  const rec = getRecord(runId);
  const escalation =
    dialogue?.escalation ??
    (state === "needs_owner"
      ? {
          category: "contradiction" as const,
          decision: `Review the open problems and Accept, Reject or Continue the run: ${reasons[0] ?? ""}`.slice(0, 600),
          reason: "the reviewer could not settle this run on its own",
        }
      : null);
  const ev = markTerminal(runId, state, {
    summary: rec?.result?.summary || `${state}`,
    reasons: escalation ? [`owner decision: ${escalation.decision}`, ...reasons] : reasons,
  });
  const final = getRecord(runId);
  if (ev && final) {
    post(runId, {
      ...verdictMessage({
        state,
        outcome: dialogue?.outcome ?? null,
        reasons,
        escalation,
        items: final.review?.evidence ?? [],
        rounds: currentReviewRound(readReviewThread(runId)),
      }),
    });
    log.info("run terminal", { runId, state, verdict: final.review?.verdict });
    try {
      await (deps.mirrorReview ?? defaultMirror)(final);
    } catch (err) {
      log.warn("review mirror failed", { runId, err: String(err) });
    }
    void import("./screenshot-index.js")
      .then((m) => m.noteRunScreenshots(runId))
      .catch(() => {});
    try {
      await (deps.deliver ?? defaultDeliver)(final, ev);
    } catch (err) {
      log.warn("terminal delivery failed (inbox still has it)", { runId, err: String(err) });
    }
  }
  return final;
}

/**
 * Review-only path for runs the pipeline did not supervise (gateway
 * sub-agents via sessions_spawn, legacy runs). Creates the record if needed,
 * classifies the final reply, reviews, and settles a terminal state.
 */
export async function reviewFinishedRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label: string;
  task: string;
  workdir?: string | null;
  startedAt?: number;
  finalText: string;
  exitOk: boolean;
  backend?: string | null;
  deps?: PipelineDeps;
}): Promise<CompletionRecord | undefined> {
  const existing = getRecord(params.runId);
  if (
    existing &&
    (isTerminal(existing) || existing.state === "continuing" || existing.state === "reviewing")
  ) {
    return existing;
  }
  if (!existing) {
    createRecord({
      runId: params.runId,
      childSessionKey: params.childSessionKey,
      requesterSessionKey: params.requesterSessionKey,
      label: params.label,
      task: params.task,
      workdir: params.workdir ?? null,
      baseCommit: null,
      startedAt: params.startedAt,
      backend: params.backend ?? null,
      maxContinuations: 0,
    });
  }
  return superviseRunExit({
    runId: params.runId,
    outcome: { exitCode: params.exitOk ? 0 : 1, rawOutput: "", outputText: params.finalText },
    spawnContinuation: null,
    deps: params.deps,
  });
}

/** Operator decisions (UI buttons / Telegram / RPC). */
export async function applyDecision(params: {
  runId: string;
  action: "continue" | "retry" | "accept" | "reject";
  by?: string | null;
  note?: string;
  spawnContinuation?: ContinuationSpawner | null;
  deps?: PipelineDeps;
}): Promise<{ ok: boolean; error?: string; record?: CompletionRecord }> {
  const rec = getRecord(params.runId);
  if (!rec) return { ok: false, error: "unknown run" };
  const at = Date.now();
  if (params.action === "accept" || params.action === "reject") {
    updateRecord(rec.runId, (r) => {
      r.decision = { action: params.action, by: params.by ?? null, at, note: params.note };
      r.state = params.action === "accept" ? "accepted" : "rejected";
      r.terminalAt = at;
    });
    recordEvent(rec.runId, "run.decision", {
      summary: `${params.action}ed by ${params.by ?? "operator"}`,
    });
    const final = getRecord(rec.runId)!;
    try {
      await (params.deps?.mirrorReview ?? defaultMirror)(final);
    } catch {
      /* non-fatal */
    }
    return { ok: true, record: final };
  }
  // continue / retry → reopen with a fresh continuation budget.
  const sessionId = [...rec.attempts].reverse().find((a) => a.sessionId)?.sessionId ?? null;
  if (!params.spawnContinuation)
    return { ok: false, error: "this run's backend cannot be resumed from here" };
  if (params.action === "continue" && !sessionId)
    return { ok: false, error: "no session id recorded — use retry" };
  updateRecord(rec.runId, (r) => {
    r.decision = { action: params.action, by: params.by ?? null, at, note: params.note };
    r.state = "continuing";
    r.terminalAt = null;
    r.round += 1;
    const n = r.attempts.length + 1;
    r.attempts.push({
      n,
      startedAt: at,
      endedAt: null,
      exitCode: null,
      kind: null,
      reasons: [],
      sessionId: params.action === "continue" ? sessionId : null,
      durableKey: `${r.runId}-c${n}`,
      prompt: params.note || (params.action === "retry" ? r.task : "operator continue"),
      round: r.round,
    });
  });
  recordEvent(rec.runId, "run.decision", {
    summary: `${params.action} by ${params.by ?? "operator"}`,
  });
  const cur = getRecord(rec.runId)!;
  const attempt = currentAttempt(cur);
  const prompt =
    params.action === "retry"
      ? `${cur.task}\n\n(Retry requested by the operator${params.note ? `: ${params.note}` : ""}. Previous review: ${(cur.review?.reasons ?? []).slice(0, 5).join("; ")})`
      : buildContinuationPrompt(
          cur.review?.reasons ?? [],
          params.note ? `Operator: ${params.note}` : undefined,
        );
  void (async () => {
    let outcome: AttemptOutcome;
    try {
      outcome = await params.spawnContinuation!({
        runId: cur.runId,
        prompt,
        sessionId: params.action === "continue" ? sessionId! : "",
        attempt: attempt.n,
        durableKey: attempt.durableKey ?? `${cur.runId}-c${attempt.n}`,
      });
    } catch (err) {
      outcome = { exitCode: null, killed: true, rawOutput: "", outputText: String(err) };
    }
    await superviseRunExit({
      runId: cur.runId,
      outcome,
      spawnContinuation: params.spawnContinuation,
      deps: params.deps,
    });
  })();
  return { ok: true, record: cur };
}

/**
 * After a gateway boot: settle runs whose attempt was interrupted by the
 * restart (state `interrupted`, or `reviewing` / `continuing` left behind by
 * the previous gateway process). Runs still owned by a live durable process are skipped —
 * the subagent registry supervises those when they exit.
 *
 * Each run is re-reviewed from its last RESULT (no re-spawn). A run with no
 * RESULT at all becomes `stalled` so the owner can Continue it.
 */
export async function recheckInterruptedRuns(opts: {
  /** True when the registry still owns a live process for this run. */
  isRunLive?: (runId: string) => boolean;
  /** Only records last touched before this (the current boot). */
  bootedAt?: number;
  deps?: PipelineDeps;
}): Promise<Array<{ runId: string; before: CompletionState; after: CompletionState | null }>> {
  const bootedAt = opts.bootedAt ?? Date.now();
  const out: Array<{ runId: string; before: CompletionState; after: CompletionState | null }> = [];
  const candidates = listRecords({
    states: ["interrupted", "reviewing", "continuing"],
    limit: 200,
  }).filter((r) => r.state === "interrupted" || r.updatedAt < bootedAt);
  for (const rec of candidates) {
    if (opts.isRunLive?.(rec.runId)) continue;
    const before = rec.state;
    try {
      const final = await recheckRecord(rec.runId, opts.deps ?? {});
      out.push({ runId: rec.runId, before, after: final?.state ?? null });
    } catch (err) {
      log.warn("interrupted-run recheck failed", { runId: rec.runId, err: String(err) });
      out.push({ runId: rec.runId, before, after: null });
    }
  }
  if (out.length) log.info("rechecked interrupted runs", { count: out.length });
  return out;
}

/** Re-review a record from its stored RESULT and settle a terminal state. */
export async function recheckRecord(
  runId: string,
  deps: PipelineDeps,
): Promise<CompletionRecord | undefined> {
  const rec = getRecord(runId);
  if (!rec) return undefined;
  const result = rec.result;
  const lastKind = currentAttempt(rec).kind;
  const note =
    lastKind === "interrupted"
      ? `last attempt was interrupted (${currentAttempt(rec).reasons.join("; ") || "gateway restart"}) — rechecked after boot`
      : null;
  if (!result) {
    return finish(
      runId,
      "stalled",
      [note ?? "run was interrupted before it reported a RESULT", "use Continue to resume it"],
      deps,
    );
  }
  const classification = classificationFromResult(result);
  const review = await reviewRecord(rec, classification, result.summary ?? "", deps);
  const state = terminalStateFor(classification, review, false);
  const escalation = decideEscalation({
    classification,
    outcome: review,
    repeated: false,
    items: getRecord(runId)?.review?.evidence ?? [],
  });
  return finish(runId, state, note ? [...review.reasons, note] : review.reasons, deps, {
    outcome: review,
    escalation,
  });
}

function classificationFromResult(result: CompletionRecord["result"]): ExitClassification {
  if (!result) return { kind: "no_result", reasons: ["no RESULT block"], result: null };
  return {
    kind:
      result.status === "blocked"
        ? "blocked"
        : result.status === "needs_input"
          ? "needs_input"
          : "complete",
    reasons: [],
    result,
  };
}

/**
 * Owner-requested re-review of an existing record (verification.review RPC,
 * re-review harness). Reviews the stored RESULT again with today's judge +
 * evidence rules. With `settle`, the record's state follows the new verdict
 * (terminal records are corrected in place; owner Accept/Reject is kept).
 */
export async function reReviewRecord(
  runId: string,
  opts: { settle?: boolean; deps?: PipelineDeps } = {},
): Promise<{ before: CompletionState; after: CompletionState; outcome: ReviewOutcome } | null> {
  const rec = getRecord(runId);
  if (!rec) return null;
  const deps = opts.deps ?? {};
  const before = rec.state;
  const classification = classificationFromResult(rec.result);
  const outcome = await reviewRecord(rec, classification, rec.result?.summary ?? "", deps);
  let after = before;
  if (opts.settle && before !== "accepted" && before !== "rejected") {
    let state: CompletionState = rec.result
      ? terminalStateFor(classification, outcome, false)
      : before === "unverified" || before === "needs_owner"
        ? before
        : "stalled";
    // Still not verified: keep the more specific state the run already had.
    if (state === "unverified" && (before === "stalled" || before === "needs_owner"))
      state = before;
    if (isTerminal(getRecord(runId))) {
      const ev = resettleRecord(runId, state, {
        summary: `re-reviewed: ${outcome.verdict}`,
        reasons: outcome.reasons,
      });
      const final = getRecord(runId);
      if (ev && final) {
        const act = actionMessage(reviewerActions(final.review?.evidence ?? [], outcome.warnings));
        if (act) post(runId, act);
        post(runId, {
          ...verdictMessage({
            state,
            outcome,
            reasons: outcome.reasons,
            escalation: decideEscalation({
              classification,
              outcome,
              repeated: false,
              items: final.review?.evidence ?? [],
            }),
            items: final.review?.evidence ?? [],
            rounds: currentReviewRound(readReviewThread(runId)),
          }),
          title: `Re-reviewed: ${outcome.verdict}`,
        });
        try {
          await (deps.mirrorReview ?? defaultMirror)(final);
        } catch (err) {
          log.warn("review mirror failed", { runId, err: String(err) });
        }
        try {
          const { broadcastCompletion } = await import("./notify.js");
          broadcastCompletion(final, ev);
        } catch {
          /* UI push is best effort */
        }
      }
    } else if (before === "interrupted" || before === "reviewing") {
      await finish(runId, state, outcome.reasons, deps);
    }
    after = getRecord(runId)?.state ?? before;
  }
  return { before, after, outcome };
}
