/**
 * Gateway RPC handlers for the AgentRunReview system (the rich, durable,
 * look-back-any-time run review with an agent-written markdown summary).
 *
 *   agents.reviews.list             — list reviews (status, projectId, since, limit)
 *   agents.reviews.get              — fetch one by { id } or { runId }
 *   agents.reviews.regenerateSummary — re-run capture (fresh agent-written summary)
 *
 * Contract note: these return AgentRunReview records verbatim (see
 * src/agents/run-reviews/schema.ts). The Review-page UI renders that exact
 * shape — keep field names stable.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listRunReviews,
  getRunReview,
  getRunReviewByRunId,
  getRunReviewByIdOrRunId,
  isValidRunReviewStatus,
  type RunReviewStatus,
} from "../../agents/run-reviews/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway/agents-reviews");

function coerceStatus(raw: unknown): RunReviewStatus | undefined {
  return isValidRunReviewStatus(raw) ? raw : undefined;
}

export const agentsReviewsHandlers: GatewayRequestHandlers = {
  /** List run reviews. params: { status?, projectId?, since?, limit? } */
  "agents.reviews.list": ({ params, respond }) => {
    const status = coerceStatus(params?.status);
    const projectId = typeof params?.projectId === "string" ? params.projectId : undefined;
    const since =
      typeof params?.since === "number" && Number.isFinite(params.since) && params.since > 0
        ? params.since
        : undefined;
    const limit =
      typeof params?.limit === "number" && params.limit > 0
        ? Math.min(Math.floor(params.limit), 500)
        : 30;

    const { reviews, total } = listRunReviews({ status, projectId, since, limit });
    respond(true, { ok: true, reviews, total, serverTime: Date.now() }, undefined);
  },

  /** Fetch one review. params: { id?, runId? } (id preferred, runId fallback). */
  "agents.reviews.get": ({ params, respond }) => {
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    if (!id && !runId) {
      respond(true, { ok: false, error: "id or runId is required" }, undefined);
      return;
    }
    const review = id ? getRunReview(id) : getRunReviewByRunId(runId);
    if (!review) {
      respond(true, { ok: false, error: "Review not found" }, undefined);
      return;
    }
    respond(true, { ok: true, review }, undefined);
  },

  /**
   * Regenerate the agent-written summary (and re-derive the record) for an
   * existing review. params: { id? , runId? }.
   */
  "agents.reviews.regenerateSummary": async ({ params, respond }) => {
    const key =
      (typeof params?.id === "string" && params.id.trim()) ||
      (typeof params?.runId === "string" && params.runId.trim()) ||
      "";
    if (!key) {
      respond(true, { ok: false, error: "id or runId is required" }, undefined);
      return;
    }
    const existing = getRunReviewByIdOrRunId(key);
    if (!existing) {
      respond(true, { ok: false, error: "Review not found" }, undefined);
      return;
    }
    try {
      const { captureRunReview } = await import("../../agents/run-reviews/index.js");
      const updated = await captureRunReview(existing.runId, { regenerate: true });
      if (!updated) {
        respond(
          true,
          { ok: false, error: "Run not resolvable — summary not regenerated" },
          undefined,
        );
        return;
      }
      log.info("agents.reviews.regenerateSummary: regenerated", { runId: existing.runId });
      respond(true, { ok: true, review: updated }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("agents.reviews.regenerateSummary: failed", { key, err: message });
      respond(true, { ok: false, error: message }, undefined);
    }
  },
};
