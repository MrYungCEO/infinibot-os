/**
 * Persistent run-review store — flat JSON file at
 * STATE_DIR/subagents/run-reviews.json.
 *
 * Mirrors src/agents/reviews/store.ts exactly: in-memory cache backed by a
 * versioned JSON file, 30-day retention, 5 000-entry hard cap. The cache is
 * keyed by the resolved path so a profile switch reloads the new profile's
 * records (multi-user isolation).
 */

import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { type AgentRunReview, parseAgentRunReview } from "./schema.js";

const log = createSubsystemLogger("run-reviews/store");

const RUN_REVIEWS_VERSION = 1 as const;
const MAX_ENTRIES = 5_000;
const DEFAULT_RETENTION_DAYS = 30;

type PersistedRunReviews = {
  version: 1;
  reviews: AgentRunReview[];
};

let memCache: AgentRunReview[] | null = null;
let cachedForPath: string | null = null;

export function resolveRunReviewsPath(): string {
  return path.join(resolveStateDir(), "subagents", "run-reviews.json");
}

function resolveRetentionMs(): number {
  const raw = process.env.INFINIBOT_REVIEW_RETENTION_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

/** Timestamp used for retention/sort — finished time, else start time. */
function stampOf(r: AgentRunReview): number {
  return r.finishedAt ?? r.startedAt ?? 0;
}

function loadFromDisk(): AgentRunReview[] {
  try {
    const raw = loadJsonFile(resolveRunReviewsPath());
    if (!raw || typeof raw !== "object") return [];
    const wrapped = raw as Partial<PersistedRunReviews>;
    if (wrapped.version !== 1 || !Array.isArray(wrapped.reviews)) return [];
    const out: AgentRunReview[] = [];
    for (const entry of wrapped.reviews) {
      const parsed = parseAgentRunReview(entry);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch (err) {
    log.warn("failed to load run-reviews from disk", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function saveToDisk(reviews: AgentRunReview[]): void {
  try {
    pruneInPlace(reviews);
    const payload: PersistedRunReviews = { version: RUN_REVIEWS_VERSION, reviews };
    saveJsonFile(resolveRunReviewsPath(), payload);
  } catch (err) {
    log.warn("failed to persist run-reviews", {
      err: err instanceof Error ? err.message : String(err),
      size: reviews.length,
    });
  }
}

function pruneInPlace(reviews: AgentRunReview[]): void {
  const cutoff = Date.now() - resolveRetentionMs();
  let writeIdx = 0;
  for (let i = 0; i < reviews.length; i++) {
    const e = reviews[i];
    // Keep in_progress snapshots regardless of age; they get replaced on finish.
    if (e.status === "in_progress" || stampOf(e) >= cutoff) reviews[writeIdx++] = e;
  }
  reviews.length = writeIdx;
  if (reviews.length > MAX_ENTRIES) {
    reviews.sort((a, b) => stampOf(a) - stampOf(b));
    reviews.splice(0, reviews.length - MAX_ENTRIES);
  }
}

export function ensureLoaded(): AgentRunReview[] {
  const currentPath = resolveRunReviewsPath();
  if (memCache === null || cachedForPath !== currentPath) {
    memCache = loadFromDisk();
    cachedForPath = currentPath;
  }
  return memCache;
}

/** Test-only — wipe the in-memory cache so each test starts clean. */
export function resetRunReviewStoreForTests(): void {
  memCache = null;
  cachedForPath = null;
}

/** Test-only — directly insert a review without full derivation. */
export function addRunReviewForTests(review: AgentRunReview): void {
  const reviews = ensureLoaded();
  reviews.push(review);
  memCache = reviews;
  saveToDisk(reviews);
}
