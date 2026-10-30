/**
 * Run-review query API. All reads go through the in-memory cache maintained
 * by store.ts. Results are most-recent-first (by finished/start time).
 */

import { type AgentRunReview, type RunReviewStatus } from "./schema.js";
import { ensureLoaded } from "./store.js";

export type ListRunReviewsOptions = {
  status?: RunReviewStatus;
  projectId?: string;
  since?: number;
  limit?: number;
};

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 500;

function stampOf(r: AgentRunReview): number {
  return r.finishedAt ?? r.startedAt ?? 0;
}

export function listRunReviews(opts: ListRunReviewsOptions = {}): {
  reviews: AgentRunReview[];
  total: number;
} {
  const all = ensureLoaded();
  const since = typeof opts.since === "number" && opts.since > 0 ? opts.since : 0;
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  let filtered = all.filter((r) => {
    if (since && stampOf(r) < since) return false;
    if (opts.status && r.status !== opts.status) return false;
    if (opts.projectId && r.projectId !== opts.projectId) return false;
    return true;
  });

  filtered.sort((a, b) => stampOf(b) - stampOf(a));
  const total = filtered.length;
  if (filtered.length > limit) filtered = filtered.slice(0, limit);
  return { reviews: filtered, total };
}

/** Get a review by its primary id. */
export function getRunReview(id: string): AgentRunReview | undefined {
  if (!id) return undefined;
  return ensureLoaded().find((r) => r.id === id);
}

/** Get a review by runId (the subagent registry dedup key). */
export function getRunReviewByRunId(runId: string): AgentRunReview | undefined {
  if (!runId) return undefined;
  return ensureLoaded().find((r) => r.runId === runId);
}

/** Resolve by id first, then fall back to runId. Handler convenience. */
export function getRunReviewByIdOrRunId(key: string): AgentRunReview | undefined {
  if (!key) return undefined;
  return getRunReview(key) ?? getRunReviewByRunId(key);
}

/** True when a review already exists for this runId. */
export function hasRunReviewForRun(runId: string): boolean {
  return getRunReviewByRunId(runId) !== undefined;
}
