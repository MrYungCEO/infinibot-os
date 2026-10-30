/**
 * Persistent review store — flat JSON file at STATE_DIR/subagents/reviews.json.
 *
 * Follows the exact same pattern as subagent-history.ts: in-memory cache
 * backed by a versioned JSON file, 30-day retention, 5 000-entry hard cap.
 *
 * Two secondary indices live in memory only (rebuilt on load):
 *   - bySessionKey — lets `query.ts` resolve by sessionKey in O(n)
 *   - byProjectId  — same for projectId
 * Actual filtering is done on the sorted `memCache` array; these help unit
 * tests verify index behaviour without re-sorting.
 */

import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { type AgentReview, parseAgentReview } from "./schema.js";

const log = createSubsystemLogger("agent-reviews/store");

const REVIEWS_VERSION = 1 as const;
const MAX_ENTRIES = 5_000;
const DEFAULT_RETENTION_DAYS = 30;

type PersistedReviews = {
  version: 1;
  reviews: AgentReview[];
};

let memCache: AgentReview[] | null = null;
// Path `memCache` was loaded for; resolved under the ACTIVE profile so a
// profile switch invalidates the cache and reloads the new profile's reviews.
let cachedForPath: string | null = null;

export function resolveReviewsPath(): string {
  return path.join(resolveStateDir(), "subagents", "reviews.json");
}

function resolveRetentionMs(): number {
  const raw = process.env.INFINIBOT_REVIEW_RETENTION_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

function loadFromDisk(): AgentReview[] {
  try {
    const raw = loadJsonFile(resolveReviewsPath());
    if (!raw || typeof raw !== "object") return [];
    const wrapped = raw as Partial<PersistedReviews>;
    if (wrapped.version !== 1 || !Array.isArray(wrapped.reviews)) return [];
    const out: AgentReview[] = [];
    for (const entry of wrapped.reviews) {
      const parsed = parseAgentReview(entry);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch (err) {
    log.warn("failed to load reviews from disk", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function saveToDisk(reviews: AgentReview[]): void {
  try {
    const payload: PersistedReviews = { version: REVIEWS_VERSION, reviews };
    saveJsonFile(resolveReviewsPath(), payload);
  } catch (err) {
    log.warn("failed to persist reviews", {
      err: err instanceof Error ? err.message : String(err),
      size: reviews.length,
    });
  }
}

function pruneInPlace(reviews: AgentReview[]): void {
  const cutoff = Date.now() - resolveRetentionMs();
  let writeIdx = 0;
  for (let i = 0; i < reviews.length; i++) {
    const e = reviews[i];
    if (e.completedAt >= cutoff) reviews[writeIdx++] = e;
  }
  reviews.length = writeIdx;
  if (reviews.length > MAX_ENTRIES) {
    reviews.sort((a, b) => a.completedAt - b.completedAt);
    reviews.splice(0, reviews.length - MAX_ENTRIES);
  }
}

export function ensureLoaded(): AgentReview[] {
  const currentPath = resolveReviewsPath();
  if (memCache === null || cachedForPath !== currentPath) {
    memCache = loadFromDisk();
    cachedForPath = currentPath;
  }
  return memCache;
}

/** Test-only — wipe the in-memory cache so each test starts clean. */
export function resetReviewStoreForTests(): void {
  memCache = null;
  cachedForPath = null;
}

/** Test-only — directly insert a review without full persist round-trip. */
export function addReviewForTests(review: AgentReview): void {
  const reviews = ensureLoaded();
  reviews.push(review);
  memCache = reviews;
  saveToDisk(reviews);
}
