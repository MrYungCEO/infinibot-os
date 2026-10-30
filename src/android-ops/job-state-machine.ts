/**
 * Android Social Ops — the posting job state machine.
 *
 * §4 of the plan defines seven explicit states. Reliability comes from making
 * the transitions *explicit and guarded* rather than letting a worker mutate a
 * status column ad hoc, so this module is the single place a job's state may
 * change. It is pure — no I/O, no clock beyond an injected `now` — which is
 * what makes it directly testable.
 *
 *   DRAFT ──► SCHEDULED ──► DISPATCHED ──► PREPARED ──► POSTED
 *                 ▲             │             │
 *                 │             ▼             ▼
 *                 └──────── ACTION_REQUIRED ◄─┤   (human checkpoint)
 *                 │             │             │
 *                 └───────── FAILED ◄─────────┘   (retry w/ backoff)
 */

import { assertHumanCheckpoint } from "./compliance.js";
import type { ActionRequired, ActionRequiredKind, JobState, PostJob } from "./types.js";

export const JOB_STATES: JobState[] = [
  "DRAFT",
  "SCHEDULED",
  "DISPATCHED",
  "PREPARED",
  "ACTION_REQUIRED",
  "POSTED",
  "FAILED",
];

/** Legal successors for each state. Anything absent is rejected. */
export const TRANSITIONS: Record<JobState, JobState[]> = {
  DRAFT: ["SCHEDULED"],
  SCHEDULED: ["DISPATCHED", "ACTION_REQUIRED", "FAILED", "DRAFT"],
  DISPATCHED: ["PREPARED", "ACTION_REQUIRED", "FAILED"],
  PREPARED: ["POSTED", "ACTION_REQUIRED", "FAILED"],
  // A cleared checkpoint rejoins the pipeline at the stage it was raised from.
  ACTION_REQUIRED: ["SCHEDULED", "DISPATCHED", "PREPARED", "POSTED", "FAILED"],
  // POSTED is terminal. FAILED is only re-enterable via an explicit retry.
  POSTED: [],
  FAILED: ["SCHEDULED", "ACTION_REQUIRED"],
};

/** Terminal for the purposes of the queue — nothing further will be attempted. */
export function isTerminal(state: JobState): boolean {
  return state === "POSTED";
}

/** States the scheduler considers "in flight". */
export function isActive(state: JobState): boolean {
  return state === "SCHEDULED" || state === "DISPATCHED" || state === "PREPARED";
}

export function canTransition(from: JobState, to: JobState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class JobTransitionError extends Error {
  readonly from: JobState;
  readonly to: JobState;
  constructor(from: JobState, to: JobState, reason: string) {
    super(`Cannot move job ${from} → ${to}: ${reason}`);
    this.name = "JobTransitionError";
    this.from = from;
    this.to = to;
  }
}

export interface TransitionContext {
  now: number;
  /** Who is driving the transition — "operator:demo", "scheduler", "simulator". */
  actor: string;
  error?: string;
  permalink?: string;
  bundleRef?: string;
  actionRequired?: { kind: ActionRequiredKind; message: string };
  /** Where a cleared ACTION_REQUIRED job should rejoin the pipeline. */
  resumeTo?: JobState;
  deviceId?: string | null;
  /** True when the target device is reachable — guards SCHEDULED → DISPATCHED. */
  deviceOnline?: boolean;
}

export interface TransitionResult {
  job: PostJob;
  /** One-line summary written to the audit trail. */
  summary: string;
}

/**
 * Exponential backoff with a 30-minute ceiling: 2m, 8m, 18m, 30m…
 * Argument is the number of attempts already spent.
 */
export function nextRetryDelayMs(attemptsSpent: number): number {
  const minutes = Math.min(30, 2 * Math.max(1, attemptsSpent) ** 2);
  return minutes * 60_000;
}

/** A job has budget left while it has made fewer than `maxAttempts` attempts. */
export function canRetry(job: Pick<PostJob, "attempt" | "maxAttempts" | "state">): boolean {
  return job.state === "FAILED" && job.attempt < job.maxAttempts;
}

/**
 * Apply a guarded transition and return a *new* job object. Guards enforce the
 * preconditions that make each state meaningful — a job cannot be DISPATCHED
 * without a reachable device, cannot be POSTED without having been PREPARED,
 * and cannot leave ACTION_REQUIRED without a named human.
 */
export function applyTransition(
  job: PostJob,
  to: JobState,
  ctx: TransitionContext,
): TransitionResult {
  const from = job.state;

  if (!canTransition(from, to)) {
    const legal = TRANSITIONS[from]?.join(", ") || "(terminal)";
    throw new JobTransitionError(from, to, `legal transitions from ${from} are: ${legal}`);
  }

  const next: PostJob = { ...job, state: to, updatedAt: ctx.now };
  let summary = `${from} → ${to}`;

  switch (to) {
    case "SCHEDULED": {
      if (!next.accountId) throw new JobTransitionError(from, to, "job has no account");
      if (!next.scheduledFor) throw new JobTransitionError(from, to, "job has no scheduled time");
      if (from === "FAILED") {
        if (!canRetry(job)) {
          throw new JobTransitionError(
            from,
            to,
            `retry budget exhausted (${job.attempt}/${job.maxAttempts})`,
          );
        }
        next.attempt = job.attempt + 1;
        next.nextRetryAt = null;
        next.failedAt = null;
        summary = `retry ${next.attempt}/${next.maxAttempts} after: ${job.lastError ?? "unknown failure"}`;
      }
      if (from === "ACTION_REQUIRED")
        next.actionRequired = clearCheckpoint(job.actionRequired, ctx);
      next.dispatchedAt = null;
      next.preparedAt = null;
      break;
    }

    case "DISPATCHED": {
      const deviceId = ctx.deviceId !== undefined ? ctx.deviceId : job.deviceId;
      if (!deviceId) throw new JobTransitionError(from, to, "no device assigned to the account");
      if (ctx.deviceOnline === false) {
        throw new JobTransitionError(from, to, `device ${deviceId} is not reachable`);
      }
      next.deviceId = deviceId;
      next.dispatchedAt = ctx.now;
      if (from === "ACTION_REQUIRED")
        next.actionRequired = clearCheckpoint(job.actionRequired, ctx);
      summary = `dispatched to ${deviceId}`;
      break;
    }

    case "PREPARED": {
      if (!next.deviceId)
        throw new JobTransitionError(from, to, "job was never dispatched to a device");
      next.preparedAt = ctx.now;
      if (from === "ACTION_REQUIRED")
        next.actionRequired = clearCheckpoint(job.actionRequired, ctx);
      summary = "media cached on device, app session verified";
      break;
    }

    case "POSTED": {
      if (from === "ACTION_REQUIRED" ? !job.preparedAt : from !== "PREPARED") {
        throw new JobTransitionError(from, to, "a job must be PREPARED before it can be POSTED");
      }
      if (from === "ACTION_REQUIRED")
        next.actionRequired = clearCheckpoint(job.actionRequired, ctx);
      next.postedAt = ctx.now;
      next.nextRetryAt = null;
      next.lastError = null;
      next.permalink = ctx.permalink ?? job.permalink;
      summary = ctx.permalink ? `posted — ${ctx.permalink}` : "posted";
      break;
    }

    case "ACTION_REQUIRED": {
      const req = ctx.actionRequired;
      if (!req?.kind || !req.message?.trim()) {
        throw new JobTransitionError(
          from,
          to,
          "an ACTION REQUIRED escalation needs a kind and a message",
        );
      }
      next.actionRequired = { kind: req.kind, message: req.message.trim(), raisedAt: ctx.now };
      if (ctx.bundleRef) next.bundleRef = ctx.bundleRef;
      summary = `escalated to operator — ${req.kind}: ${req.message.trim()}`;
      break;
    }

    case "FAILED": {
      const reason = ctx.error?.trim();
      if (!reason) throw new JobTransitionError(from, to, "a failure must record an error");
      next.failedAt = ctx.now;
      next.lastError = reason;
      // A failure bundle (screenshot + logcat) is what makes a FAILED job
      // actionable; the adapter supplies the ref, we just record it.
      next.bundleRef = ctx.bundleRef ?? job.bundleRef;
      next.nextRetryAt = canRetry({ ...next, state: "FAILED" })
        ? ctx.now + nextRetryDelayMs(next.attempt)
        : null;
      summary = `failed: ${reason}`;
      break;
    }

    case "DRAFT": {
      next.scheduledFor = job.scheduledFor;
      next.dispatchedAt = null;
      next.preparedAt = null;
      summary = "unscheduled back to draft";
      break;
    }
  }

  return { job: next, summary };
}

/**
 * Clearing a checkpoint is the one transition that *must* be human. The guard
 * lives here so every exit path from ACTION_REQUIRED goes through it.
 */
function clearCheckpoint(
  current: ActionRequired | null,
  ctx: TransitionContext,
): ActionRequired | null {
  assertHumanCheckpoint(ctx.actor);
  if (!current) return null;
  return { ...current, resolvedBy: ctx.actor, resolvedAt: ctx.now };
}

/**
 * Where a cleared checkpoint should rejoin the pipeline, inferred from how far
 * the job had already progressed.
 */
export function resumeStateFor(job: PostJob): JobState {
  if (job.preparedAt) return "PREPARED";
  if (job.dispatchedAt) return "DISPATCHED";
  return "SCHEDULED";
}
