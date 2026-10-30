/**
 * Review write API — upsert-by-runId.
 *
 * Idempotent: calling twice for the same runId replaces the existing entry
 * rather than duplicating it, so the auto-reviewer and the manual RPC can
 * both call without coordination.
 */

import { type AgentReview } from "./schema.js";
import { ensureLoaded, saveToDisk } from "./store.js";

/**
 * Upsert a review. Deduped by runId — a second write replaces the first.
 * Returns the review as stored (same object after a write).
 */
export function upsertReview(review: AgentReview): AgentReview {
  const reviews = ensureLoaded();
  const idx = reviews.findIndex((r) => r.runId === review.runId);
  if (idx >= 0) {
    // A verified-completion verdict is authoritative: a later auto/self review
    // that lacks one must not wipe it.
    const prev = reviews[idx];
    reviews[idx] =
      review.completion || !prev.completion ? review : { ...review, completion: prev.completion };
  } else {
    reviews.push(review);
  }
  saveToDisk(reviews);
  return review;
}

/**
 * Update specific fields of an existing review without replacing the whole
 * record. No-op when the runId is not found.
 */
export function patchReview(runId: string, patch: Partial<AgentReview>): AgentReview | undefined {
  const reviews = ensureLoaded();
  const idx = reviews.findIndex((r) => r.runId === runId);
  if (idx < 0) return undefined;
  const updated = { ...reviews[idx], ...patch, runId } as AgentReview;
  reviews[idx] = updated;
  saveToDisk(reviews);
  return updated;
}
