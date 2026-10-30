/**
 * Review query API.
 *
 * All reads go through the in-memory cache maintained by store.ts.
 * Results are always most-recent-first (by completedAt).
 */

import { type AgentReview, type ReviewStatus } from "./schema.js";
import { ensureLoaded, saveToDisk } from "./store.js";

export type ListReviewsOptions = {
  projectId?: string;
  sessionKey?: string;
  status?: ReviewStatus;
  since?: number;
  limit?: number;
};

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 500;

export function listReviews(opts: ListReviewsOptions = {}): {
  reviews: AgentReview[];
  total: number;
} {
  const all = ensureLoaded();

  const since = typeof opts.since === "number" && opts.since > 0 ? opts.since : 0;
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.min(opts.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  let filtered = all.filter((r) => {
    if (since && r.completedAt < since) return false;
    if (opts.status && r.status !== opts.status) return false;
    if (opts.projectId && r.projectId !== opts.projectId) return false;
    if (opts.sessionKey && r.sessionKey !== opts.sessionKey) return false;
    return true;
  });

  filtered.sort((a, b) => b.completedAt - a.completedAt);
  const total = filtered.length;
  if (filtered.length > limit) filtered = filtered.slice(0, limit);
  return { reviews: filtered, total };
}

/** Get a review by its primary id. */
export function getReview(id: string): AgentReview | undefined {
  if (!id) return undefined;
  return ensureLoaded().find((r) => r.id === id);
}

/** Get a review by runId (the subagent registry dedup key). */
export function getReviewByRunId(runId: string): AgentReview | undefined {
  if (!runId) return undefined;
  return ensureLoaded().find((r) => r.runId === runId);
}

/** True when a review already exists for this runId. */
export function hasReviewForRun(runId: string): boolean {
  return getReviewByRunId(runId) !== undefined;
}

/** Persist the current in-memory state (call after mutations). */
export function flushReviews(): void {
  saveToDisk(ensureLoaded());
}
