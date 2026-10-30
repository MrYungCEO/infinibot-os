/**
 * captureRunReview(runId) — assemble + persist an in-depth AgentRunReview for
 * a finished run, including an AGENT-WRITTEN markdown summary.
 *
 * Called fire-and-forget from finalizeSubagentCleanup() in
 * subagent-registry.ts, so it must never throw into the caller and never
 * block the lifecycle broadcast. Idempotent by runId; dynamic imports keep
 * the dependency edge one-directional (registry does not statically depend on
 * this module).
 *
 * Covers all three agent kinds because CLI coder runs, native gateway agent
 * runs, and subagents all register in the subagent registry and flow through
 * finalizeSubagentCleanup on completion.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGatewayBroadcaster } from "../coder-runtime/subagent-broadcast.js";
import type { AgentKind, AgentRunReview } from "./schema.js";
import { derive, type RunReviewInput } from "./derive.js";
import { generateSummaryMarkdown } from "./summary.js";
import { upsertRunReview } from "./writer.js";
import { getRunReviewByRunId } from "./query.js";

const log = createSubsystemLogger("run-reviews/capture");

/** WS event the Review page + proactive modals subscribe to. */
export const RUN_REVIEW_READY_EVENT = "agents.review.ready";

/** In-flight dedup so a double completion doesn't run the LLM twice. */
const inFlight = new Set<string>();

function titleFrom(label: string | undefined, task: string): string {
  const t = (label && label.trim()) || task.trim();
  const firstLine = t.split("\n")[0] ?? t;
  return firstLine.slice(0, 100);
}

function agentKindFrom(coderBackend: string | undefined): AgentKind {
  return coderBackend ? "cli" : "subagent";
}

function readTranscriptTail(transcriptPath: string | undefined): string {
  if (!transcriptPath) return "";
  try {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    return raw.slice(-16_000);
  } catch {
    return "";
  }
}

function broadcastReady(review: AgentRunReview): void {
  const broadcaster = getGatewayBroadcaster();
  if (!broadcaster) return;
  try {
    broadcaster(RUN_REVIEW_READY_EVENT, {
      id: review.id,
      runId: review.runId,
      projectId: review.projectId,
      title: review.title,
      status: review.status,
      built: review.built,
      agentKind: review.agentKind,
      ts: review.finishedAt ?? Date.now(),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Build a RunReviewInput from the live registry record or the history archive.
 * Returns null when the run cannot be resolved or is still active.
 */
async function resolveInput(runId: string): Promise<{
  input: RunReviewInput;
  transcriptPath?: string;
} | null> {
  const { getSubagentRun } = await import("../subagent-registry.js");
  const { getSubagentHistoryEntryByRunId } = await import("../subagent-history.js");
  const { getProgress } = await import("../subagent-progress.js");

  const live = getSubagentRun(runId);
  const archived = !live ? getSubagentHistoryEntryByRunId(runId) : undefined;
  if (!live && !archived) return null;
  // Don't capture a review for a run that is still active.
  if (live && !live.endedAt) return null;

  const progressRec = getProgress(runId);
  const progress = (progressRec?.updates ?? []).map((u) => ({
    ts: u.timestamp,
    kind: u.status,
    message: u.message,
  }));

  if (live) {
    const startedAt = live.startedAt ?? live.createdAt;
    return {
      transcriptPath: live.transcriptPath,
      input: {
        runId: live.runId,
        title: titleFrom(live.label, live.task),
        task: live.task,
        agentKind: agentKindFrom(live.coderBackend),
        backend: live.coderBackend,
        taskId: live.parentGoalId,
        kanbanTaskId: live.kanbanTaskId,
        projectId:
          typeof (live as { projectId?: string }).projectId === "string"
            ? (live as { projectId?: string }).projectId
            : undefined,
        outcomeStatus: live.outcome?.status,
        errorMessage: live.outcome?.error,
        startedAt,
        finishedAt: live.endedAt,
        workdir: live.workdir,
        filesTouched: live.filesTouched?.map((f) => ({ path: f.path, action: f.action })),
        progress,
      },
    };
  }

  const arc = archived!;
  const startedAt = arc.startedAt ?? arc.endedAt;
  return {
    transcriptPath: arc.transcriptPath,
    input: {
      runId: arc.runId,
      title: titleFrom(arc.label, arc.task),
      task: arc.task,
      agentKind: agentKindFrom(arc.coderBackend),
      backend: arc.coderBackend,
      kanbanTaskId: arc.kanbanTaskId,
      outcomeStatus: arc.outcome?.status,
      errorMessage: arc.error ?? arc.outcome?.error,
      startedAt,
      finishedAt: arc.endedAt,
      workdir: arc.workdir,
      filesTouched: (arc.filesTouchedSample ?? []).map((path) => ({
        path,
        action: "edited" as const,
      })),
      progress,
    },
  };
}

/**
 * Capture a review for a finished run.
 * @param opts.regenerate when true, re-generate even if a review already exists.
 * @returns the review, or null when the run couldn't be resolved.
 */
export async function captureRunReview(
  runId: string,
  opts: { regenerate?: boolean } = {},
): Promise<AgentRunReview | null> {
  if (!runId) return null;
  if (inFlight.has(runId)) return null;
  inFlight.add(runId);
  try {
    const existing = getRunReviewByRunId(runId);
    if (existing && !opts.regenerate) return existing;

    const resolved = await resolveInput(runId);
    if (!resolved) {
      if (!existing) log.warn("run-reviews: run not resolvable", { runId });
      return existing ?? null;
    }

    const draft = derive(resolved.input);
    const transcriptTail = readTranscriptTail(resolved.transcriptPath);
    const { markdown, fromLLM } = await generateSummaryMarkdown(draft, transcriptTail);

    const review: AgentRunReview = {
      id: existing?.id ?? randomUUID(),
      runId: draft.runId,
      taskId: draft.taskId,
      kanbanTaskId: draft.kanbanTaskId,
      projectId: draft.projectId,
      title: draft.title,
      agentKind: draft.agentKind,
      backend: draft.backend,
      model: draft.model,
      status: draft.status,
      startedAt: draft.startedAt,
      finishedAt: draft.finishedAt,
      durationMs: draft.durationMs,
      summaryMarkdown: markdown,
      filesTouched: draft.filesTouched,
      actions: draft.actions,
      issues: draft.issues,
      built: draft.built,
      buildEvidence: draft.buildEvidence,
      forwardActions: draft.forwardActions,
    };

    // Kanban moves the verification reconciler already made (it may settle
    // the board before this review is captured).
    try {
      const { getLedgerUpdatesForRun, mergeKanbanUpdatesIntoReview } =
        await import("../../verification/kanban-reconcile.js");
      const ledger = await getLedgerUpdatesForRun(runId);
      const prior = existing?.kanbanUpdates ?? [];
      if (ledger.length || prior.length) {
        const merged = mergeKanbanUpdatesIntoReview(
          { actions: review.actions, kanbanUpdates: prior },
          ledger
            .filter((e) => !e.taskId.startsWith("suggest-"))
            .map((e) => ({
              runId,
              taskId: e.taskId,
              title: e.title,
              relation: e.relation ?? ("primary" as const),
              from: e.from,
              to: e.status,
              blocked: e.blocked,
              outcome: "applied" as const,
              state: e.state as never,
              at: e.at,
            })),
        );
        review.actions = merged.actions;
        review.kanbanUpdates = merged.kanbanUpdates;
      }
    } catch {
      /* best-effort */
    }

    upsertRunReview(review);
    log.info("run-reviews: review captured", {
      runId,
      reviewId: review.id,
      status: review.status,
      built: review.built,
      files: review.filesTouched.length,
      summaryFromLLM: fromLLM,
    });
    broadcastReady(review);
    return review;
  } catch (err) {
    log.warn("run-reviews: capture failed", {
      runId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    inFlight.delete(runId);
  }
}
