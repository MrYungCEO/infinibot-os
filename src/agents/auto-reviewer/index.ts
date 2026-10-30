/**
 * autoReview(runId) — idempotent entry point for the auto-reviewer.
 *
 * Checks if a review already exists (self-reported or auto-generated) before
 * doing anything. If not, resolves the run from the live registry or history
 * archive, derives a review, and persists it.
 *
 * Intentionally fire-and-forget friendly: the caller in subagent-registry.ts
 * calls `void autoReview(runId)` after `finalizeSubagentCleanup` without
 * awaiting, so completion latency (~LLM roundtrip) never blocks the
 * lifecycle broadcast.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getSubagentRun } from "../subagent-registry.js";
import { getSubagentHistoryEntryByRunId } from "../subagent-history.js";
import { getProgress } from "../subagent-progress.js";
import { hasReviewForRun, upsertReview } from "../reviews/index.js";
import { deriveReview, type RunContext } from "./from-transcript.js";
import type { ReviewStatus } from "../reviews/schema.js";

const log = createSubsystemLogger("auto-reviewer");

/** In-flight dedup: runIds currently being reviewed to avoid parallel double-runs. */
const inFlight = new Set<string>();

/**
 * Convert an outcome status to a ReviewStatus.
 * A "partial" run is one that ended in error but touched at least some files.
 */
function deriveReviewStatus(
  outcomeStatus: string | undefined,
  filesTouchedCount: number,
): ReviewStatus {
  if (outcomeStatus === "ok") return "completed";
  if (outcomeStatus === "error") {
    return filesTouchedCount > 0 ? "partial" : "errored";
  }
  return "errored";
}

/**
 * Auto-generate a review for a finished run.
 *
 * Idempotent — safe to call multiple times for the same runId.
 * Returns null when the run can't be found or is still active.
 */
export async function autoReview(runId: string): Promise<void> {
  if (!runId) return;

  // Dedup concurrent calls for the same runId.
  if (inFlight.has(runId)) return;
  inFlight.add(runId);

  try {
    // If a review already exists (agent self-reported), skip.
    if (hasReviewForRun(runId)) {
      log.debug("auto-reviewer: review already exists, skipping", { runId });
      return;
    }

    // Resolve the run from the live registry first, then fall back to archive.
    const liveRun = getSubagentRun(runId);
    const archived = !liveRun ? getSubagentHistoryEntryByRunId(runId) : undefined;

    if (!liveRun && !archived) {
      log.warn("auto-reviewer: run not found in registry or archive", { runId });
      return;
    }

    // Don't auto-review runs that are still active.
    if (liveRun && !liveRun.endedAt) {
      log.debug("auto-reviewer: run is still active, skipping", { runId });
      return;
    }

    // Collect progress updates for the LLM prompt.
    const progress = getProgress(runId);
    const progressUpdates = (progress?.updates ?? []).map((u) => u.message);

    let ctx: RunContext;

    if (liveRun) {
      const filesTouchedCount = liveRun.filesTouched?.length ?? 0;
      const startedAt = liveRun.startedAt ?? liveRun.createdAt;
      const endedAt = liveRun.endedAt ?? Date.now();
      ctx = {
        runId: liveRun.runId,
        sessionKey: liveRun.childSessionKey,
        label: liveRun.label,
        task: liveRun.task,
        status: deriveReviewStatus(liveRun.outcome?.status, filesTouchedCount),
        durationMs: endedAt - startedAt,
        completedAt: endedAt,
        errorMessage: liveRun.outcome?.error,
        workdir: liveRun.workdir,
        filesTouched: liveRun.filesTouched?.map((f) => ({
          path: f.path,
          action: f.action as "created" | "edited" | "deleted" | "read",
        })),
        progressUpdates,
      };
    } else {
      // archived run
      const arc = archived!;
      const filesTouchedCount = arc.filesTouchedCount ?? 0;
      const startedAt = arc.startedAt ?? arc.endedAt;
      ctx = {
        runId: arc.runId,
        sessionKey: arc.requesterSessionKey,
        label: arc.label,
        task: arc.task,
        status: deriveReviewStatus(arc.outcome?.status, filesTouchedCount),
        durationMs: arc.endedAt - startedAt,
        completedAt: arc.endedAt,
        errorMessage: arc.error,
        workdir: arc.workdir,
        filesTouched: (arc.filesTouchedSample ?? []).map((path) => ({
          path,
          action: "edited" as const,
        })),
        progressUpdates,
      };
    }

    log.info("auto-reviewer: deriving review", {
      runId,
      status: ctx.status,
      filesTouchedCount: ctx.filesTouched?.length ?? 0,
    });

    const review = await deriveReview(ctx);
    upsertReview(review);

    log.info("auto-reviewer: review persisted", {
      runId,
      reviewId: review.id,
      confidence: review.confidence,
      selfReported: review.selfReported,
    });
  } catch (err) {
    log.warn("auto-reviewer: failed to generate review", {
      runId,
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight.delete(runId);
  }
}
