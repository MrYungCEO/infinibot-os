/**
 * Run-review write API — upsert-by-runId (idempotent). A second write for the
 * same runId replaces the first, so the capture hook and the manual
 * regenerate RPC can both call without coordination.
 */

import { type AgentRunReview } from "./schema.js";
import { ensureLoaded, saveToDisk } from "./store.js";

export function upsertRunReview(review: AgentRunReview): AgentRunReview {
  const reviews = ensureLoaded();
  const idx = reviews.findIndex((r) => r.runId === review.runId);
  if (idx >= 0) reviews[idx] = review;
  else reviews.push(review);
  saveToDisk(reviews);
  return review;
}

/** Patch specific fields of an existing review. No-op when runId is unknown. */
export function patchRunReview(
  runId: string,
  patch: Partial<AgentRunReview>,
): AgentRunReview | undefined {
  const reviews = ensureLoaded();
  const idx = reviews.findIndex((r) => r.runId === runId);
  if (idx < 0) return undefined;
  const updated = { ...reviews[idx], ...patch, runId } as AgentRunReview;
  reviews[idx] = updated;
  saveToDisk(reviews);
  return updated;
}
