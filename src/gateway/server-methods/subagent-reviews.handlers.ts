/**
 * Gateway RPC handlers for the agent review system.
 *
 * subagent_reviews_list   — list reviews with filters
 * subagent_review_get     — fetch one review by runId
 * subagent_review_upsert  — agents self-report a structured review
 * subagent_review_force   — re-run the auto-reviewer for a given runId
 */

import { randomUUID } from "node:crypto";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listReviews,
  getReviewByRunId,
  upsertReview,
  patchReview,
  isValidAgentReview,
  parseAgentReview,
  type ReviewStatus,
  type ReviewDecision,
} from "../../agents/reviews/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway/subagent-reviews");

const ALLOWED_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  "completed",
  "aborted",
  "errored",
  "partial",
]);

function coerceStatus(raw: unknown): ReviewStatus | undefined {
  if (typeof raw !== "string") return undefined;
  return ALLOWED_STATUSES.has(raw as ReviewStatus) ? (raw as ReviewStatus) : undefined;
}

export const subagentReviewsHandlers: GatewayRequestHandlers = {
  /**
   * List reviews with optional filters.
   * params: { projectId?, sessionKey?, status?, since?, limit? }
   */
  subagent_reviews_list: ({ params, respond }) => {
    const projectId = typeof params?.projectId === "string" ? params.projectId : undefined;
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    const status = coerceStatus(params?.status);
    const since =
      typeof params?.since === "number" && Number.isFinite(params.since) && params.since > 0
        ? params.since
        : undefined;
    const limit =
      typeof params?.limit === "number" && params.limit > 0
        ? Math.min(Math.floor(params.limit), 500)
        : 30;

    const { reviews, total } = listReviews({ projectId, sessionKey, status, since, limit });
    respond(true, { ok: true, reviews, total, serverTime: Date.now() }, undefined);
  },

  /**
   * Fetch one review by runId.
   * params: { runId: string }
   */
  /**
   * Record an operator oversight decision (the inline Approve / Send-back
   * actions on the Oversight page). Patches the existing review in place so
   * the web + mobile feeds reflect it on the next poll.
   * params: { runId: string, decision: "approved" | "sent_back" | "pending", note?, by? }
   */
  subagent_review_decide: ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }
    const raw = typeof params?.decision === "string" ? params.decision : "";
    const decision: ReviewDecision | undefined =
      raw === "approved" || raw === "sent_back" || raw === "pending" ? raw : undefined;
    if (!decision) {
      respond(
        true,
        { ok: false, error: "decision must be 'approved', 'sent_back', or 'pending'" },
        undefined,
      );
      return;
    }
    const existing = getReviewByRunId(runId);
    if (!existing) {
      respond(true, { ok: false, error: "Review not found for this runId" }, undefined);
      return;
    }
    const note = typeof params?.note === "string" ? params.note.slice(0, 2000) : undefined;
    const by = typeof params?.by === "string" ? params.by.slice(0, 256) : undefined;
    const updated = patchReview(runId, {
      decision,
      decisionNote: note,
      decidedBy: by,
      decidedAt: Date.now(),
    });
    log.info("subagent_review_decide: decision recorded", { runId, decision });
    respond(true, { ok: true, review: updated }, undefined);
  },

  subagent_review_get: ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }
    const review = getReviewByRunId(runId);
    if (!review) {
      respond(true, { ok: false, error: "Review not found for this runId" }, undefined);
      return;
    }
    respond(true, { ok: true, review }, undefined);
  },

  /**
   * Agents call this as their final action to self-report a review.
   * params: { review: Partial<AgentReview> }
   *
   * Missing fields are filled in from the run record if possible.
   * If the agent provides a complete review, it is persisted as-is with selfReported:true.
   */
  subagent_review_upsert: ({ params, respond }) => {
    const raw = params?.review;
    if (!raw || typeof raw !== "object") {
      respond(true, { ok: false, error: "review object is required" }, undefined);
      return;
    }

    const parsed = parseAgentReview({
      id: randomUUID(),
      ...raw,
    });
    if (!parsed || !parsed.runId) {
      respond(
        true,
        { ok: false, error: "review is missing required fields (runId, status, summary)" },
        undefined,
      );
      return;
    }

    // Override: self-reported reviews are always flagged as such.
    const review = { ...parsed, selfReported: true };

    // Validate the coerced shape before persisting.
    if (!isValidAgentReview(review)) {
      respond(true, { ok: false, error: "review failed validation" }, undefined);
      return;
    }

    upsertReview(review);
    log.info("subagent_review_upsert: review stored", {
      runId: review.runId,
      reviewId: review.id,
      selfReported: true,
    });
    respond(true, { ok: true, reviewId: review.id }, undefined);
  },

  /**
   * Force (re-)generate the auto-review for a finished run. Overwrites any
   * existing auto-generated review but does NOT overwrite self-reported ones.
   * params: { runId: string, force?: boolean }
   */
  subagent_review_force: async ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }

    const force = params?.force === true;

    // Check if a self-reported review exists and force is not set.
    const existing = getReviewByRunId(runId);
    if (existing?.selfReported && !force) {
      respond(
        true,
        {
          ok: false,
          error:
            "A self-reported review exists for this run. Pass force:true to overwrite it with an auto-generated one.",
        },
        undefined,
      );
      return;
    }

    try {
      const { autoReview } = await import("../../agents/auto-reviewer/index.js");

      // Clear existing review so autoReview doesn't skip due to dedup.
      if (existing) {
        const { upsertReview: upsert } = await import("../../agents/reviews/index.js");
        upsert({ ...existing, selfReported: false });
      }

      // Re-derive. autoReview is idempotent by runId; we cleared above so it runs fresh.
      await autoReview(runId);

      const updated = getReviewByRunId(runId);
      if (!updated) {
        respond(
          true,
          { ok: false, error: "Run not found or still active — no review generated" },
          undefined,
        );
        return;
      }
      respond(true, { ok: true, review: updated }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("subagent_review_force: failed", { runId, err: message });
      respond(true, { ok: false, error: message }, undefined);
    }
  },
};
