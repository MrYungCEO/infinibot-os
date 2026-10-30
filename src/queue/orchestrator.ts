/**
 * Persistent queue orchestrator — gateway-side singleton (NOT a subagent).
 *
 * All state lives in queue.db (src/queue/store.ts), every transition is
 * conditional (exactly-once), and a lease guarantees one dispatching
 * orchestrator per state dir. Each tick:
 *
 *   1. Renew the lease (standby when another live gateway holds it).
 *   2. Reconcile running entries: poll the attempt through the phase runner,
 *      enforce per-phase + per-entry timeouts, and settle finished attempts:
 *        verdict VERIFIED/ACCEPTED (verified-completion) → phase gate checks
 *          → pass: advance (exactly once) · fail: retry with feedback
 *        verdict UNVERIFIED/FAILED/STALLED → retry on the SAME session
 *        agent RESULT blocked / needs_input → blocked (human input)
 *        crash / lost / spawn failure → transient retry with backoff,
 *          dead-letter after N in a row
 *      Counted failures consume `maxAttempts`, then the entry is blocked with
 *      a kind + human-readable fix.
 *   3. Dispatch eligible entries up to `maxConcurrent` (deps done, backoff
 *      elapsed, no conflict, backend available — else a persisted
 *      waiting reason / block), each through one backend-agnostic runner.
 *
 * Restart: nothing is swept. Running entries are simply polled again —
 * durable CLI attempts are still alive in tmux (or finished and are reviewed
 * from disk), attempts lost with the process are re-queued (uncounted) and
 * resume the same agent session.
 *
 * NOTE: this lives in the gateway process; do not import from `ui/`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import { getQueueStore, type QueueStore } from "./store.js";
import { broadcastQueueEvent, type QueueEventKind } from "./events.js";
import type {
  QueueAttempt,
  QueueAttemptOutcome,
  QueueBlockedKind,
  QueueEntry,
  QueueGateResult,
  QueuePhase,
} from "./types.js";
import {
  describeCheck,
  gateCriteriaToChecks,
  runChecks,
  type CheckContext,
} from "../autonomy/goals/checks.js";
import type { GoalCheck } from "../autonomy/goals/types.js";
import type { AttemptPoll, PhaseRunner } from "./phase-runner.js";
import {
  LOGIN_FIX,
  mapModelForBackend,
  resolveAgent,
  type BackendAvailability,
  type ResolvedAgent,
} from "./backends.js";
import type { QueueCliBackend } from "./types.js";
import { ensureWorktree, repoRoot, worktreeNames, type QueueWorktree } from "./worktree.js";

const log = createSubsystemLogger("queue-orchestrator");

export const DEFAULT_TICK_MS = 4_000;
export const DEFAULT_GATE_ATTEMPTS = 3;
export const DEFAULT_PHASE_TIMEOUT_SEC = 30 * 60;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_TRANSIENT = 5;

export interface OrchestratorDeps {
  runner: PhaseRunner;
  /** CLI availability (cached probe). Missing → assume available. */
  availability?: {
    get: (b: QueueCliBackend, refresh?: boolean) => Promise<BackendAvailability>;
    invalidate?: () => void;
  };
  /** Non-queue runs for `blockers[]` conflict detection. */
  listActiveRuns?: () => Array<{ runId: string; workdir?: string; task?: string }>;
  /** Injectable judge for llm gate checks (tests). */
  judge?: CheckContext["judge"];
  /** Worktree creation (tests inject a fake). */
  ensureWorktree?: typeof ensureWorktree;
  /** W5: permission bypass decision for an entry. Default: trusted entries only. */
  autoApprove?: (entry: QueueEntry) => boolean;
  /** Completion-contract text appended to every fresh CLI session. */
  contractPrompt?: string;
}

export interface OrchestratorOptions {
  tickMs?: number;
  orchestratorId?: string;
  maxConcurrent?: number;
  leaseTtlMs?: number;
  /** Counted-failure retry backoff: base * 2^(n-1), capped. */
  retryBackoffMs?: { base: number; max: number };
  /** Transient-failure backoff (crash / spawn / lost). */
  transientBackoffMs?: { base: number; max: number };
  /** Consecutive transient failures before the entry is dead-lettered. */
  maxTransientFailures?: number;
  /** Scratch workdir root for entries without a workdir. */
  scratchRoot?: string;
}

function phaseChecks(phase: QueuePhase): GoalCheck[] {
  try {
    return gateCriteriaToChecks(phase.gateCriteria);
  } catch (err) {
    log.warn("invalid gateCriteria — treating as a failing gate", { error: String(err) });
    return [
      {
        id: "invalid",
        type: "shell",
        command: "false",
        label: `invalid gateCriteria: ${String(err)}`,
      },
    ];
  }
}

/** `blockers[]` vs other runs' workdir/task text. */
function blockerConflict(
  phase: QueuePhase,
  active: ReadonlyArray<{ workdir?: string; task?: string }>,
): string | null {
  const blockers = phase.blockers ?? [];
  if (!blockers.length || !active.length) return null;
  for (const a of active) {
    const hay = `${a.workdir ?? ""}\n${a.task ?? ""}`;
    for (const b of blockers) {
      if (b && hay.includes(b)) return `${a.workdir ?? a.task ?? "active run"} touches ${b}`;
    }
  }
  return null;
}

function backoff(n: number, cfg: { base: number; max: number }): number {
  const exp = Math.min(cfg.max, cfg.base * 2 ** Math.max(0, n - 1));
  return Math.round(exp * (0.85 + Math.random() * 0.3));
}

function gitHeadOf(dir: string): string | null {
  try {
    return (
      execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}

export class QueueOrchestrator {
  private timer: NodeJS.Timeout | null = null;
  readonly id: string;
  readonly store: QueueStore;
  private readonly deps: OrchestratorDeps;
  private readonly tickMs: number;
  readonly maxConcurrent: number;
  private readonly leaseTtlMs: number;
  private readonly retryBackoff: { base: number; max: number };
  private readonly transientBackoff: { base: number; max: number };
  private readonly maxTransient: number;
  private readonly scratchRoot: string;
  private ticking = false;
  private leader = false;
  /** Entries with an operator action in flight (skip in the tick). */
  private readonly busy = new Set<string>();

  constructor(store: QueueStore, deps: OrchestratorDeps, opts: OrchestratorOptions = {}) {
    this.store = store;
    this.deps = deps;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.id = opts.orchestratorId ?? `orch-${randomUUID().slice(0, 8)}`;
    this.maxConcurrent = Math.max(
      1,
      opts.maxConcurrent ??
        (Number(process.env.INFINIBOT_QUEUE_MAX_CONCURRENT) || DEFAULT_MAX_CONCURRENT),
    );
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.retryBackoff = opts.retryBackoffMs ?? { base: 5_000, max: 5 * 60_000 };
    this.transientBackoff = opts.transientBackoffMs ?? { base: 15_000, max: 10 * 60_000 };
    this.maxTransient = opts.maxTransientFailures ?? DEFAULT_MAX_TRANSIENT;
    this.scratchRoot = opts.scratchRoot ?? path.join(resolveStateDir(), "queue", "work");
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
    log.info("queue orchestrator started", {
      id: this.id,
      tickMs: this.tickMs,
      maxConcurrent: this.maxConcurrent,
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.store.releaseLease(this.id);
    } catch {
      /* db closed */
    }
    this.leader = false;
  }

  isLeader(): boolean {
    return this.leader;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const leader = this.store.acquireLease(this.id, this.leaseTtlMs);
      if (leader !== this.leader) {
        log.info(leader ? "queue lease acquired" : "queue lease held elsewhere — standby", {
          id: this.id,
        });
        this.leader = leader;
      }
      if (!leader) return;
      await this.reconcileRunning();
      await this.reconcileAccepted();
      await this.dispatch();
    } catch (err) {
      log.warn("orchestrator tick failed", { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  private emit(
    kind: QueueEventKind,
    entry: QueueEntry,
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    const phaseIdx = (extra.phaseIdx as number | undefined) ?? entry.currentPhaseIdx;
    const phase = entry.phaseSpec[phaseIdx];
    const payload = {
      id: entry.id,
      status: entry.status,
      phaseIdx,
      phaseName: phase?.name,
      totalPhases: entry.phaseSpec.length,
      reason: message,
      ...extra,
    };
    try {
      this.store.addEvent(entry.id, kind, message, phaseIdx, extra);
    } catch (err) {
      log.warn("event persist failed", { error: String(err) });
    }
    log.info(kind, { entry: entry.id, phase: phaseIdx, msg: message, ...extra });
    broadcastQueueEvent(kind, payload as never);
  }

  // ── reconcile running attempts ────────────────────────────────────────────

  private async reconcileRunning(): Promise<void> {
    for (const entry of this.store.list({ status: "running", limit: 1000 })) {
      if (this.busy.has(entry.id)) continue;
      try {
        await this.reconcileEntry(entry);
      } catch (err) {
        log.warn("reconcile failed", { id: entry.id, error: String(err) });
      }
    }
  }

  private async reconcileEntry(entry: QueueEntry): Promise<void> {
    const attempt = entry.currentRunId ? this.store.getAttemptByRunId(entry.currentRunId) : null;
    if (!attempt) {
      // Legacy (pre-runner) running row — its run was never tracked per attempt.
      this.store.markBlocked(
        entry.id,
        "running entry from before the phase-runner upgrade; its agent is not tracked",
        "restart",
        "Check the working tree, then `queue retry` to re-run the phase or `queue advance` to skip it.",
        ["running"],
      );
      this.emit(
        "queue.entry.blocked",
        this.store.get(entry.id)!,
        "legacy running entry blocked after upgrade",
      );
      return;
    }
    const phase = entry.phaseSpec[attempt.phaseIdx];
    const target = resolveAgent(attempt.agent);
    const now = Date.now();

    // Entry wall-clock budget.
    if (entry.timeoutSec && entry.startedAt && now - entry.startedAt > entry.timeoutSec * 1000) {
      await this.stopAttempt(attempt, target, "entry timeout");
      if (
        this.store.settleAttempt(attempt.id, {
          outcome: "timeout",
          counted: true,
          error: "entry timeout",
        })
      ) {
        this.store.bumpPhaseAttempts(entry.id);
        this.store.markBlocked(
          entry.id,
          `entry exceeded its ${Math.round(entry.timeoutSec / 60)} min budget`,
          "timeout",
          "Raise the entry timeout or split the work, then `queue retry`.",
          ["running"],
        );
        this.emit("queue.phase.timeout", this.store.get(entry.id)!, "entry timeout", {
          attemptId: attempt.id,
        });
        this.emit("queue.entry.blocked", this.store.get(entry.id)!, "entry timeout");
      }
      return;
    }

    const poll = await this.deps.runner.poll(attempt.runId, target);

    // Per-attempt timeout.
    const timeoutSec = phase?.timeoutSec ?? DEFAULT_PHASE_TIMEOUT_SEC;
    if (poll.state === "running" && now - attempt.startedAt > timeoutSec * 1000) {
      await this.stopAttempt(attempt, target, "phase attempt timeout");
      if (
        this.store.settleAttempt(attempt.id, {
          outcome: "timeout",
          counted: true,
          error: `no result within ${timeoutSec}s`,
        })
      ) {
        this.emit(
          "queue.phase.timeout",
          entry,
          `attempt ${attempt.n} timed out after ${timeoutSec}s`,
          {
            attemptId: attempt.id,
            runId: attempt.runId,
          },
        );
        this.countedFailure(
          entry,
          attempt,
          phase,
          `Phase attempt ${attempt.n} timed out after ${timeoutSec}s without a result. Finish faster: commit what works, then end with the RESULT block.`,
          "timeout",
        );
      }
      return;
    }

    if (poll.state === "running") {
      if (attempt.outcome === "starting")
        this.store.attemptStarted(attempt.id, { sessionId: poll.sessionId });
      else if (poll.sessionId && poll.sessionId !== attempt.sessionId) {
        this.store.setAttemptSession(attempt.id, poll.sessionId);
      }
      return;
    }

    if (poll.state === "missing") {
      if (
        this.store.settleAttempt(attempt.id, {
          outcome: "crashed",
          counted: false,
          error: poll.reason,
        })
      ) {
        this.emit("queue.phase.settled", entry, `attempt ${attempt.n} lost: ${poll.reason}`, {
          attemptId: attempt.id,
          runId: attempt.runId,
          outcome: "crashed",
        });
        this.transientFailure(entry, attempt, `agent run lost: ${poll.reason}`);
      }
      return;
    }

    await this.settleFinished(entry, attempt, phase, poll);
  }

  /**
   * An attempt finished: combine the verified-completion verdict with the
   * phase gate. Exactly-once via settleAttempt / completePhase guards.
   */
  private async settleFinished(
    entry: QueueEntry,
    attempt: QueueAttempt,
    phase: QueuePhase | undefined,
    poll: Extract<AttemptPoll, { state: "settled" }>,
  ): Promise<void> {
    if (!phase) {
      this.store.settleAttempt(attempt.id, {
        outcome: "failed",
        counted: true,
        error: "phase missing",
      });
      this.store.markFailed(entry.id, `no phase at index ${attempt.phaseIdx}`, "invalid");
      this.emit("queue.entry.failed", this.store.get(entry.id)!, "phase spec missing");
      return;
    }
    const requireVerified = phase.requireVerified !== false;
    const verdict = poll.verdict;
    const verdictOk = verdict === "verified" || verdict === "accepted";
    const base = {
      exitCode: poll.exitCode,
      verdict,
      verdictReasons: poll.reasons,
      sessionId: poll.sessionId,
    };

    // The CLI could not authenticate: not the agent's fault, retrying can't help.
    if (poll.authError && attempt.backend) {
      if (
        !this.store.settleAttempt(attempt.id, {
          ...base,
          outcome: "unavailable",
          counted: false,
          error: poll.authError,
        })
      )
        return;
      this.deps.availability?.invalidate?.();
      const reason = `${attempt.backend} CLI failed to authenticate: ${poll.authError}`;
      if (
        this.store.markBlocked(
          entry.id,
          reason,
          "backend_unavailable",
          `${LOGIN_FIX[attempt.backend]} Then \`queue retry\`.`,
          ["running"],
        )
      ) {
        this.emit("queue.entry.blocked", this.store.get(entry.id)!, reason, {
          attemptId: attempt.id,
          agent: attempt.agent,
        });
      }
      return;
    }

    // Retired / unknown model or exhausted credits: another model/agent is needed.
    if (poll.modelError && attempt.backend) {
      if (
        !this.store.settleAttempt(attempt.id, {
          ...base,
          outcome: "unavailable",
          counted: false,
          error: poll.modelError,
        })
      )
        return;
      const reason = `${attempt.backend} model ${attempt.model ?? "(default)"} is unavailable: ${poll.modelError}`;
      if (
        this.store.markBlocked(
          entry.id,
          reason,
          "model_unavailable",
          `Pick another model or agent for this phase: \`queue retry ${short(entry.id)} --model <model>\` (or \`--agent <agent>\`), or top up the provider.`,
          ["running"],
        )
      ) {
        this.emit("queue.entry.blocked", this.store.get(entry.id)!, reason, {
          attemptId: attempt.id,
          agent: attempt.agent,
        });
      }
      return;
    }

    // The agent itself reported it is blocked / needs input.
    if (
      verdict === "blocked" ||
      verdict === "needs_input" ||
      poll.resultStatus === "blocked" ||
      poll.resultStatus === "needs_input"
    ) {
      if (
        !this.store.settleAttempt(attempt.id, { ...base, outcome: "needs_input", counted: false })
      )
        return;
      const issues = [...(poll.openIssues ?? []), ...(poll.summary ? [poll.summary] : [])];
      this.store.markBlocked(
        entry.id,
        `agent reported ${poll.resultStatus ?? verdict}: ${issues.join("; ") || poll.reasons.join("; ") || "no details"}`,
        "needs_input",
        'Answer the agent\'s open issues, then `queue retry --instruction "…"` (resumes the same session).',
        ["running"],
      );
      this.emit("queue.entry.blocked", this.store.get(entry.id)!, "agent needs input", {
        attemptId: attempt.id,
        verdict,
      });
      return;
    }

    const verificationSaysNo = requireVerified && verdict !== null && !verdictOk;
    const exitSaysNo = verdict === null && requireVerified && poll.exitCode !== 0;
    if (verificationSaysNo || exitSaysNo) {
      if (
        !this.store.settleAttempt(attempt.id, {
          ...base,
          outcome: exitSaysNo ? "failed" : "unverified",
          counted: true,
        })
      ) {
        return;
      }
      this.emit(
        "queue.phase.settled",
        entry,
        `attempt ${attempt.n}: ${verdict ?? `exit ${poll.exitCode}`}`,
        {
          attemptId: attempt.id,
          runId: attempt.runId,
          verdict,
        },
      );
      const reasons = poll.reasons.length
        ? poll.reasons
        : [verdict ? `verdict ${verdict}` : `exit code ${poll.exitCode}`];
      this.countedFailure(
        entry,
        attempt,
        phase,
        [
          `Phase "${phase.name}" attempt ${attempt.n} was not verified (${verdict ?? `exit ${poll.exitCode}`}):`,
          ...reasons.map((r) => `- ${r}`),
        ].join("\n"),
        "unverified",
      );
      return;
    }

    // Verified (or verification not required) → the gate decides.
    const checks = phaseChecks(phase);
    let gate: QueueGateResult | null = null;
    if (checks.length) {
      gate = await this.runGate(entry, attempt, phase, checks);
      this.emit("queue.phase.gate", entry, gate.pass ? "gate passed" : "gate failed", {
        attemptId: attempt.id,
        pass: gate.pass,
      });
    } else if (!requireVerified && verdict === null && poll.exitCode !== 0) {
      // No verification, no gate: exit status is the only signal left.
      if (!this.store.settleAttempt(attempt.id, { ...base, outcome: "failed", counted: true }))
        return;
      this.countedFailure(
        entry,
        attempt,
        phase,
        `Phase attempt ${attempt.n} exited with code ${poll.exitCode}.`,
        "unverified",
      );
      return;
    }

    if (!gate || gate.pass) {
      if (
        !this.store.settleAttempt(attempt.id, { ...base, outcome: "passed", counted: true, gate })
      )
        return;
      const after = this.store.completePhase(entry.id, attempt.phaseIdx);
      if (!after) return;
      this.emit(
        "queue.phase.completed",
        after,
        poll.summary ? `${phase.name}: ${poll.summary}` : `${phase.name} completed`,
        {
          phaseIdx: attempt.phaseIdx,
          attemptId: attempt.id,
          runId: attempt.runId,
          agent: attempt.agent,
          model: attempt.model,
          verdict,
          summary: poll.summary ?? null,
        },
      );
      if (after.status === "done") this.emit("queue.entry.done", after, "all phases completed");
      else if (after.status === "paused")
        this.emit("queue.entry.paused", after, "paused after phase completed");
      return;
    }
    if (
      !this.store.settleAttempt(attempt.id, {
        ...base,
        outcome: "gate_failed",
        counted: true,
        gate,
      })
    )
      return;
    const failing = gate.results.filter((r) => !r.pass);
    this.countedFailure(
      entry,
      attempt,
      phase,
      [
        `Phase "${phase.name}" attempt ${attempt.n} did not pass its gate:`,
        ...failing.map(
          (f) =>
            `- ${f.label}\n${f.output
              .split("\n")
              .map((l) => `    ${l}`)
              .join("\n")}`,
        ),
      ].join("\n"),
      "gate_failed",
    );
  }

  private async runGate(
    entry: QueueEntry,
    attempt: QueueAttempt,
    phase: QueuePhase,
    checks: GoalCheck[],
  ): Promise<QueueGateResult> {
    const suite = await runChecks(checks, {
      workdir: attempt.workdir,
      goalText: `${entry.briefMd}\n\n# Phase: ${phase.name}\n${phase.brief}`,
      iteration: attempt.n,
      trigger: "iteration",
      judge: this.deps.judge,
      getAgentOutput: async () =>
        (
          await this.deps.runner
            .output(attempt.runId, resolveAgent(attempt.agent), 12_000)
            .catch(() => null)
        )?.text ?? "",
    });
    const byId = new Map(checks.map((c) => [c.id, c]));
    const gate: QueueGateResult = {
      pass: suite.allPass,
      at: Date.now(),
      phaseIdx: attempt.phaseIdx,
      attempt: attempt.n,
      results: suite.results.map((r) => ({
        checkId: r.checkId,
        label: describeCheck(byId.get(r.checkId) ?? { type: "shell" }),
        pass: r.pass,
        output: r.output.slice(-1500),
      })),
    };
    this.store.setGate(entry.id, gate);
    return gate;
  }

  /** A counted failure: retry (backoff, same session) until maxAttempts, then block. */
  private countedFailure(
    entry: QueueEntry,
    attempt: QueueAttempt,
    phase: QueuePhase | undefined,
    feedback: string,
    kind: QueueBlockedKind,
  ): void {
    const fresh = this.store.get(entry.id);
    if (!fresh) return;
    const used = fresh.phaseAttempts + 1;
    const max = Math.max(1, phase?.maxAttempts ?? DEFAULT_GATE_ATTEMPTS);
    if (used < max) {
      const after = this.store.requeuePhase(entry.id, attempt.phaseIdx, {
        feedback,
        counted: true,
        nextAttemptAt: Date.now() + backoff(used, this.retryBackoff),
        waitingReason: `retrying after attempt ${attempt.n} (${kind.replace("_", " ")})`,
      });
      if (after) {
        this.emit("queue.phase.retrying", after, `${kind}: retry ${used + 1}/${max}`, {
          phaseIdx: attempt.phaseIdx,
          attemptId: attempt.id,
        });
      }
      return;
    }
    this.store.bumpPhaseAttempts(entry.id);
    const fix =
      kind === "gate_failed"
        ? "Fix the failing gate checks by hand (or relax the gate), then `queue retry` — or `queue advance` if the phase is actually done."
        : kind === "timeout"
          ? "Raise the phase timeoutSec or split the phase, then `queue retry`."
          : 'Read the verification reasons + logs; accept the run with verification.decide (accept) or `queue retry --instruction "…"`.';
    if (
      this.store.markBlocked(entry.id, `${feedback}\n\n(${max}/${max} attempts used)`, kind, fix, [
        "running",
      ])
    ) {
      this.emit("queue.entry.blocked", this.store.get(entry.id)!, `${kind} after ${max} attempts`, {
        phaseIdx: attempt.phaseIdx,
        attemptId: attempt.id,
      });
    }
  }

  /** Crash / lost / spawn failure: backoff retry (uncounted), dead-letter at the cap. */
  private transientFailure(entry: QueueEntry, attempt: QueueAttempt | null, reason: string): void {
    const fresh = this.store.get(entry.id);
    if (!fresh) return;
    const n = fresh.transientFailures + 1;
    if (n >= this.maxTransient) {
      if (
        this.store.markDead(
          entry.id,
          `dead-lettered after ${n} consecutive transient failures; last: ${reason}`,
          "The agent keeps crashing or failing to start. Check `queue logs` and the backend (`queue backends`), fix the cause, then `queue retry`.",
        )
      ) {
        this.emit("queue.entry.dead", this.store.get(entry.id)!, `dead-lettered: ${reason}`);
      }
      return;
    }
    const phaseIdx = attempt?.phaseIdx ?? fresh.currentPhaseIdx;
    const delay = backoff(n, this.transientBackoff);
    const after =
      fresh.status === "running"
        ? this.store.requeuePhase(entry.id, phaseIdx, {
            feedback: fresh.lastError,
            counted: false,
            transient: true,
            nextAttemptAt: Date.now() + delay,
            waitingReason: `transient failure ${n}/${this.maxTransient}: ${reason.slice(0, 160)}`,
          })
        : null;
    if (after) {
      this.emit(
        "queue.phase.retrying",
        after,
        `transient: ${reason} — retry in ${Math.round(delay / 1000)}s`,
        {
          phaseIdx,
          attemptId: attempt?.id,
        },
      );
    }
  }

  /**
   * Blocked-because-unverified entries whose run an operator later ACCEPTED
   * (verification.decide accept): run the gate and advance.
   */
  private async reconcileAccepted(): Promise<void> {
    for (const entry of this.store.list({ status: "blocked", limit: 200 })) {
      if (entry.blockedKind !== "unverified" || this.busy.has(entry.id)) continue;
      const attempt = this.store.latestAttempt(entry.id, entry.currentPhaseIdx);
      if (!attempt || attempt.outcome !== "unverified") continue;
      const poll = await this.deps.runner
        .poll(attempt.runId, resolveAgent(attempt.agent))
        .catch(() => null);
      if (poll?.state !== "settled" || poll.verdict !== "accepted") continue;
      const phase = entry.phaseSpec[attempt.phaseIdx];
      const checks = phase ? phaseChecks(phase) : [];
      const gate = checks.length ? await this.runGate(entry, attempt, phase!, checks) : null;
      if (gate && !gate.pass) {
        this.store.annotateAttempt(attempt.id, { gate, verdict: "accepted" });
        this.store.markBlocked(
          entry.id,
          "run accepted by the operator but the phase gate still fails",
          "gate_failed",
          "Fix the failing gate checks, then `queue retry` or `queue advance`.",
          ["blocked"],
        );
        continue;
      }
      this.store.annotateAttempt(attempt.id, { outcome: "passed", verdict: "accepted", gate });
      const after = this.store.completePhase(entry.id, attempt.phaseIdx, "blocked");
      if (after) {
        this.emit(
          "queue.phase.completed",
          after,
          `${phase?.name ?? "phase"} accepted by operator`,
          {
            phaseIdx: attempt.phaseIdx,
            attemptId: attempt.id,
            verdict: "accepted",
          },
        );
        if (after.status === "done") this.emit("queue.entry.done", after, "all phases completed");
      }
    }
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  private async dispatch(): Promise<void> {
    this.updateWaitingReasons();
    if (this.store.isDispatchPaused()) return;
    const running = this.store.list({ status: "running", limit: 1000 });
    let capacity = this.maxConcurrent - running.length;
    if (capacity <= 0) return;
    const busyRepos = new Map<string, string>();
    for (const r of running) {
      const a = r.currentRunId ? this.store.getAttemptByRunId(r.currentRunId) : null;
      const repo = a?.workdir ? (repoRoot(a.workdir) ?? a.workdir) : null;
      if (repo) busyRepos.set(repo, r.id);
    }
    for (const entry of this.store.eligible()) {
      if (capacity <= 0) break;
      if (this.busy.has(entry.id)) continue;
      const started = await this.dispatchEntry(entry, busyRepos).catch((err) => {
        log.warn("dispatch failed", { id: entry.id, error: String(err) });
        return false;
      });
      if (started) capacity--;
    }
  }

  /** Persist why queued entries are waiting; block dependents of dead deps. */
  private updateWaitingReasons(): void {
    const now = Date.now();
    for (const e of this.store.list({ status: "queued", limit: 1000 })) {
      let reason: string | null = null;
      for (const d of e.dependsOn) {
        const dep = this.store.get(d);
        if (!dep) {
          reason = `dependency ${short(d)} no longer exists`;
          break;
        }
        if (dep.status === "failed" || dep.status === "canceled" || dep.status === "dead") {
          if (
            this.store.markBlocked(
              e.id,
              `dependency ${short(d)} ended ${dep.status}`,
              "dependency_failed",
              `Retry or fix entry ${short(d)} ("${dep.title}"), then \`queue retry ${short(e.id)}\`.`,
              ["queued"],
            )
          ) {
            this.emit(
              "queue.entry.blocked",
              this.store.get(e.id)!,
              `dependency ${short(d)} ${dep.status}`,
            );
          }
          reason = null;
          break;
        }
        if (dep.status !== "done") {
          reason = `waiting for ${short(d)} (${dep.status})`;
          break;
        }
      }
      // In backoff: keep the retry reason written by the failure path.
      if (!reason && e.nextAttemptAt && e.nextAttemptAt > now) continue;
      if (reason || e.waitingReason?.startsWith("waiting for")) this.store.setWaiting(e.id, reason);
    }
  }

  private resolveWorkdir(entry: QueueEntry, phase: QueuePhase): string {
    const dir = phase.workdir ?? entry.workdir;
    if (dir) return dir;
    const scratch = path.join(this.scratchRoot, short(entry.id));
    mkdirSync(scratch, { recursive: true });
    return scratch;
  }

  /** Worktree isolation → the effective workdir for this phase (or a block reason). */
  private isolate(
    entry: QueueEntry,
    phaseIdx: number,
    phase: QueuePhase,
    workdir: string,
  ): { workdir: string } | { error: string } {
    const mode = phase.isolation ?? entry.isolation;
    if (mode === "none") return { workdir };
    const repo = repoRoot(workdir);
    if (!repo) return { error: `isolation "${mode}" needs a git repo, but ${workdir} is not one` };
    const sub = path.relative(repo, workdir);
    const ensure = this.deps.ensureWorktree ?? ensureWorktree;
    let wt: QueueWorktree;
    try {
      if (mode === "entry") {
        const existing = entry.worktrees.entry;
        const names = worktreeNames(entry.id, null);
        wt = ensure({ repo, branch: existing?.branch ?? names.branch, dirName: names.dirName });
        this.store.setWorktree(entry.id, "entry", wt);
      } else {
        const names = worktreeNames(entry.id, phaseIdx);
        const prev = phaseIdx > 0 ? entry.worktrees[`p${phaseIdx - 1}`] : undefined;
        wt = ensure({
          repo,
          branch: names.branch,
          dirName: names.dirName,
          base: prev?.branch ?? "HEAD",
        });
        this.store.setWorktree(entry.id, `p${phaseIdx}`, wt);
      }
    } catch (err) {
      return {
        error: `worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { workdir: sub ? path.join(wt.path, sub) : wt.path };
  }

  private buildPrompt(
    entry: QueueEntry,
    phaseIdx: number,
    phase: QueuePhase,
    resuming: boolean,
  ): string {
    const checks = phaseChecks(phase);
    const gateText = checks.length
      ? `# Phase gate (verified automatically — the phase only advances when all pass)\n${checks
          .map((c, i) => `${i + 1}. ${describeCheck(c)}`)
          .join("\n")}`
      : "";
    const feedback = entry.phaseAttempts > 0 || entry.lastError ? entry.lastError : null;
    const instruction = entry.pendingInstruction?.trim()
      ? `# Operator instruction\n${entry.pendingInstruction.trim()}`
      : "";
    if (resuming) {
      return [
        `Continue phase ${phaseIdx + 1}/${entry.phaseSpec.length} "${phase.name}" of queue entry "${entry.title}".`,
        feedback ? `# Why the previous attempt did not complete\n${feedback}` : "",
        instruction,
        gateText,
        "Fix the problems above, verify, and end with exactly one RESULT block.",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    const done = this.store
      .listEvents(entry.id, 400)
      .filter((e) => e.kind === "queue.phase.completed" && (e.phaseIdx ?? 99) < phaseIdx)
      .map((e) => `- phase ${(e.phaseIdx ?? 0) + 1}: ${e.message}`);
    return [
      entry.briefMd?.trim() ? `# Project brief\n${entry.briefMd.trim()}` : "",
      `# Phase ${phaseIdx + 1}/${entry.phaseSpec.length}: ${phase.name}`,
      phase.brief?.trim() ?? "",
      done.length
        ? `# Earlier phases (already completed — their work is in this working tree)\n${done.join("\n")}`
        : "",
      gateText,
      feedback
        ? `# Previous attempt did not complete\n${feedback}\nFix these and finish the phase.`
        : "",
      instruction,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async dispatchEntry(entry: QueueEntry, busyRepos: Map<string, string>): Promise<boolean> {
    const phaseIdx = entry.currentPhaseIdx;
    const phase = entry.phaseSpec[phaseIdx];
    if (!phase) {
      if (this.store.markFailed(entry.id, `no phase at index ${phaseIdx}`, "invalid")) {
        this.emit("queue.entry.failed", this.store.get(entry.id)!, "missing phase spec");
      }
      return false;
    }

    // Conflicts: declared blockers vs other runs; same repo without isolation.
    const conflict = blockerConflict(phase, this.deps.listActiveRuns?.() ?? []);
    if (conflict) {
      if (this.store.setWaiting(entry.id, `conflict: ${conflict}`)) {
        this.store.addEvent(
          entry.id,
          "queue.entry.waiting",
          `waiting on conflict: ${conflict}`,
          entry.currentPhaseIdx,
        );
        broadcastQueueEvent("queue.changed", { id: entry.id });
      }
      return false;
    }
    const baseWorkdir = this.resolveWorkdir(entry, phase);
    const mode = phase.isolation ?? entry.isolation;
    if (mode === "none") {
      const repo = repoRoot(baseWorkdir) ?? baseWorkdir;
      const holder = busyRepos.get(repo);
      if (holder && holder !== entry.id) {
        this.store.setWaiting(
          entry.id,
          `repo busy: entry ${short(holder)} is running in ${repo} (use isolation "entry" to run in parallel)`,
        );
        return false;
      }
    }

    // Target + availability (+ fallback agent).
    let target: ResolvedAgent = resolveAgent(phase.agent);
    let fallbackFrom: string | null = null;
    if (target.kind === "cli" && this.deps.availability) {
      const av = await this.deps.availability.get(target.backend);
      if (!av.available) {
        const fb = phase.fallbackAgent ? resolveAgent(phase.fallbackAgent) : null;
        const fbAv = fb?.kind === "cli" ? await this.deps.availability.get(fb.backend) : null;
        if (fb && (fb.kind === "agent" || fbAv?.available)) {
          fallbackFrom = target.label;
          this.store.addEvent(
            entry.id,
            "queue.phase.fallback",
            `${target.label} unavailable (${av.reason}); using fallback ${fb.label}`,
            phaseIdx,
          );
          target = fb;
        } else {
          const reason = `${target.label} is not available: ${av.reason ?? av.authState}`;
          if (
            this.store.markBlocked(entry.id, reason, "backend_unavailable", av.fix ?? null, [
              "queued",
            ])
          ) {
            this.emit("queue.entry.blocked", this.store.get(entry.id)!, reason, {
              agent: target.label,
            });
          }
          return false;
        }
      }
    }

    // Workdir (+ worktree isolation).
    const iso = this.isolate(entry, phaseIdx, phase, baseWorkdir);
    if ("error" in iso) {
      if (
        this.store.markBlocked(
          entry.id,
          iso.error,
          "invalid",
          'Point the entry/phase workdir at a git repo or set isolation "none".',
          ["queued"],
        )
      ) {
        this.emit("queue.entry.blocked", this.store.get(entry.id)!, iso.error);
      }
      return false;
    }
    const workdir = iso.workdir;

    // Model mapping.
    let model: string | undefined = phase.model;
    if (target.kind === "cli") {
      const mapped = mapModelForBackend(target.backend, phase.model);
      model = mapped.model;
      if (mapped.note) this.store.addEvent(entry.id, "queue.phase.model", mapped.note, phaseIdx);
    }

    // Same-session resume: the latest attempt of this phase on the same agent.
    const prev = this.store.latestAttempt(entry.id, phaseIdx);
    const resumeSession =
      !entry.freshSession &&
      prev &&
      prev.agent === target.label &&
      prev.sessionId &&
      prev.outcome !== "canceled"
        ? prev.sessionId
        : null;

    const n = (prev?.n ?? 0) + 1;
    // Evidence baseline: where the PHASE started (first attempt), else HEAD now.
    const firstOfPhase = this.store
      .listAttempts(entry.id)
      .find((a) => a.phaseIdx === phaseIdx && a.baseCommit && a.workdir === workdir);
    const baseCommit = firstOfPhase?.baseCommit ?? gitHeadOf(workdir);
    const runId = `q-${short(entry.id)}-p${phaseIdx + 1}-a${n}-${randomUUID().slice(0, 4)}`;
    const attempt = this.store.claim({
      id: entry.id,
      phaseIdx,
      orchestratorId: this.id,
      runId,
      agent: target.label,
      backend: target.kind === "cli" ? target.backend : null,
      modelRequested: phase.model ?? null,
      model: model ?? null,
      resumedSession: resumeSession,
      fallbackFrom,
      workdir,
      baseCommit,
    });
    if (!attempt) return false;
    const claimed = this.store.get(entry.id)!;
    if (mode === "none") busyRepos.set(repoRoot(workdir) ?? workdir, entry.id);

    const prompt = this.buildPrompt(entry, phaseIdx, phase, Boolean(resumeSession));
    const label = `queue:${short(entry.id)}:${phase.name}`.slice(0, 80);
    const autoApprove = this.deps.autoApprove ? this.deps.autoApprove(entry) : entry.trusted;
    const timeoutSec = phase.timeoutSec ?? DEFAULT_PHASE_TIMEOUT_SEC;
    try {
      const res = await this.deps.runner.start({
        runId,
        entryId: entry.id,
        phaseIdx,
        target,
        model,
        prompt,
        systemPrompt: [
          this.deps.contractPrompt ?? "",
          `You are running phase ${phaseIdx + 1}/${entry.phaseSpec.length} ("${phase.name}") of InfiniBot queue entry ${short(entry.id)}. The queue verifies your RESULT and the phase gate before advancing.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        workdir,
        resumeSessionId: resumeSession,
        baseCommit,
        timeoutSec,
        label,
        autoApprove,
      });
      this.store.attemptStarted(attempt.id, { sessionId: res.sessionId ?? null });
      this.store.consumeInstruction(entry.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        this.store.settleAttempt(attempt.id, {
          outcome: "spawn_failed",
          counted: false,
          error: msg,
        })
      ) {
        this.emit("queue.phase.settled", claimed, `spawn failed: ${msg}`, {
          attemptId: attempt.id,
          outcome: "spawn_failed",
        });
        this.transientFailure(claimed, attempt, `spawn failed: ${msg}`);
      }
      return false;
    }
    const started = this.store.get(entry.id)!;
    if (claimed.attempts === 1) this.emit("queue.entry.started", started, "entry started");
    this.emit(
      "queue.phase.started",
      started,
      `${phase.name} → ${target.label}${model ? ` (${model})` : ""}${resumeSession ? " — resuming session" : ""}${fallbackFrom ? ` — fallback from ${fallbackFrom}` : ""}`,
      { runId, attemptId: attempt.id, agent: target.label, model: model ?? null, workdir },
    );
    return true;
  }

  private async stopAttempt(
    attempt: QueueAttempt,
    target: ResolvedAgent,
    reason: string,
  ): Promise<void> {
    try {
      await this.deps.runner.kill(attempt.runId, target, reason);
    } catch (err) {
      log.warn("attempt kill failed", { runId: attempt.runId, error: String(err) });
    }
  }

  // ── operator controls (RPC / tool / CLI) ─────────────────────────────────

  private async withEntry<T>(id: string, fn: (e: QueueEntry) => Promise<T>): Promise<T> {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`queue entry not found: ${id}`);
    this.busy.add(id);
    try {
      return await fn(entry);
    } finally {
      this.busy.delete(id);
    }
  }

  /** Stop the running attempt (if any) and settle it with `outcome`. */
  private async interruptCurrent(
    entry: QueueEntry,
    outcome: Extract<QueueAttemptOutcome, "canceled" | "interrupted">,
    reason: string,
  ): Promise<QueueAttempt | null> {
    if (entry.status !== "running" || !entry.currentRunId) return null;
    const attempt = this.store.getAttemptByRunId(entry.currentRunId);
    if (!attempt) return null;
    await this.stopAttempt(attempt, resolveAgent(attempt.agent), reason);
    this.store.settleAttempt(attempt.id, { outcome, counted: false, error: reason });
    return attempt;
  }

  async cancel(id: string, reason = "operator cancel"): Promise<QueueEntry> {
    return this.withEntry(id, async (entry) => {
      if (entry.status === "done" || entry.status === "canceled") {
        throw new Error(`entry is already ${entry.status}`);
      }
      await this.interruptCurrent(entry, "canceled", reason);
      this.store.markCanceled(id, reason);
      const after = this.store.get(id)!;
      this.emit("queue.entry.canceled", after, reason);
      return after;
    });
  }

  async pause(id: string, force = false): Promise<QueueEntry> {
    return this.withEntry(id, async (entry) => {
      if (entry.status === "running") {
        if (force) {
          await this.interruptCurrent(entry, "interrupted", "paused by operator");
          this.store.markPaused(id, ["running"]);
        } else {
          this.store.requestPause(id);
        }
      } else if (!this.store.markPaused(id, ["queued", "blocked"])) {
        throw new Error(`cannot pause an entry that is ${entry.status}`);
      }
      const after = this.store.get(id)!;
      this.emit(
        "queue.entry.paused",
        after,
        force || entry.status !== "running"
          ? "paused"
          : "pause requested (after the current attempt)",
      );
      return after;
    });
  }

  async resume(id: string): Promise<QueueEntry> {
    return this.withEntry(id, async (entry) => {
      if (!this.store.resume(id)) throw new Error(`cannot resume an entry that is ${entry.status}`);
      const after = this.store.get(id)!;
      this.emit("queue.entry.resumed", after, "resumed");
      return after;
    });
  }

  async retry(
    id: string,
    opts: {
      fromPhase?: number;
      instruction?: string;
      freshSession?: boolean;
      /** Switch the phase being retried to another agent/model (recorded in the spec). */
      agent?: string;
      model?: string;
    } = {},
  ): Promise<QueueEntry> {
    return this.withEntry(id, async (entry) => {
      if (entry.status === "running" || entry.status === "queued") {
        throw new Error(`entry is ${entry.status}; pause or cancel it first`);
      }
      if (typeof opts.fromPhase === "number" && opts.fromPhase >= entry.phaseSpec.length) {
        throw new Error(
          `fromPhase ${opts.fromPhase} is out of range (entry has ${entry.phaseSpec.length} phases)`,
        );
      }
      if (!this.store.retry(id, opts))
        throw new Error(`cannot retry an entry that is ${entry.status}`);
      const after = this.store.get(id)!;
      this.emit(
        "queue.entry.retried",
        after,
        `retry from phase ${after.currentPhaseIdx + 1}${opts.instruction ? " with instruction" : ""}`,
      );
      return after;
    });
  }

  async advance(id: string, reason = "no reason given"): Promise<QueueEntry> {
    return this.withEntry(id, async (entry) => {
      if (["done", "failed", "canceled", "dead"].includes(entry.status)) {
        throw new Error(`cannot advance an entry that is ${entry.status}`);
      }
      await this.interruptCurrent(entry, "canceled", `operator skipped the phase: ${reason}`);
      const after = this.store.advancePhase(id);
      if (!after) throw new Error("advance failed (entry changed concurrently)");
      this.emit("queue.entry.advanced", after, `operator-advance: ${reason}`, {
        phaseIdx: entry.currentPhaseIdx,
      });
      this.emit(
        "queue.phase.completed",
        after,
        `${entry.phaseSpec[entry.currentPhaseIdx]?.name ?? "phase"} skipped by operator: ${reason}`,
        {
          phaseIdx: entry.currentPhaseIdx,
          operator: true,
        },
      );
      if (after.status === "done") this.emit("queue.entry.done", after, "all phases completed");
      return after;
    });
  }

  reorder(id: string, priority: number): QueueEntry {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`queue entry not found: ${id}`);
    this.store.setPriority(id, priority);
    const after = this.store.get(id)!;
    this.emit("queue.entry.reordered", after, `priority ${entry.priority} → ${priority}`);
    return after;
  }

  /** Agent output of an attempt (durable CLI log or gateway session). */
  async attemptOutput(
    attempt: QueueAttempt,
    maxChars = 20_000,
  ): Promise<{ text: string; source: "durable" | "session" | "none"; tmuxAttach?: string }> {
    return this.deps.runner.output(attempt.runId, resolveAgent(attempt.agent), maxChars);
  }

  created(entry: QueueEntry): void {
    this.emit("queue.entry.created", entry, `created with ${entry.phaseSpec.length} phase(s)`);
    // Kick a dispatch soon instead of waiting a full tick.
    setTimeout(() => void this.tick(), 50).unref?.();
  }
}

let _instance: QueueOrchestrator | null = null;

export function getQueueOrchestrator(
  deps?: OrchestratorDeps,
  opts?: OrchestratorOptions,
): QueueOrchestrator {
  if (_instance) return _instance;
  if (!deps) throw new Error("getQueueOrchestrator requires deps on first call");
  _instance = new QueueOrchestrator(getQueueStore(), deps, opts);
  return _instance;
}

/** The running orchestrator, or null before boot (RPCs fall back to store-only ops). */
export function peekQueueOrchestrator(): QueueOrchestrator | null {
  return _instance;
}

export function resetQueueOrchestratorForTests(): void {
  _instance?.stop();
  _instance = null;
}

export function isQueueOrchestratorStartedForTests(): boolean {
  return _instance !== null;
}

export type { QueueEntry, QueuePhase } from "./types.js";
