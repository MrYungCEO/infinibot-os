import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Redirect STATE_DIR to a temp dir so tests don't touch ~/.infinibot
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-reviews-test-"));
vi.stubEnv("INFINIBOT_STATE_DIR", tmpDir);

import { upsertReview } from "./writer.js";
import { listReviews, getReview, getReviewByRunId, hasReviewForRun } from "./query.js";
import { resetReviewStoreForTests, addReviewForTests, resolveReviewsPath } from "./store.js";
import type { AgentReview } from "./schema.js";

function makeReview(overrides: Partial<AgentReview> = {}): AgentReview {
  const now = Date.now();
  return {
    id: `rev-${Math.random().toString(36).slice(2)}`,
    runId: `run-${Math.random().toString(36).slice(2)}`,
    sessionKey: "sess:coder:test",
    status: "completed",
    summary: "Agent completed the task.",
    filesTouched: [],
    nextSteps: [],
    blockers: [],
    confidence: "medium",
    durationMs: 1000,
    completedAt: now,
    ...overrides,
  };
}

function cleanDisk() {
  try {
    fs.rmSync(resolveReviewsPath(), { force: true });
  } catch {
    // ignore
  }
  resetReviewStoreForTests();
}

describe("Review store", () => {
  beforeEach(() => {
    cleanDisk();
  });

  afterEach(() => {
    cleanDisk();
  });

  it("upsert stores a review and getReviewByRunId finds it", () => {
    const r = makeReview({ runId: "run-abc" });
    upsertReview(r);
    const found = getReviewByRunId("run-abc");
    expect(found).not.toBeUndefined();
    expect(found?.id).toBe(r.id);
    expect(found?.summary).toBe(r.summary);
  });

  it("upsert dedupes by runId — second write replaces first", () => {
    const r1 = makeReview({ runId: "run-dedup", summary: "First summary." });
    const r2 = makeReview({ runId: "run-dedup", id: r1.id, summary: "Updated summary." });
    upsertReview(r1);
    upsertReview(r2);
    const { reviews } = listReviews();
    const matches = reviews.filter((r) => r.runId === "run-dedup");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.summary).toBe("Updated summary.");
  });

  it("getReview finds by id", () => {
    const r = makeReview({ id: "rev-known-id" });
    addReviewForTests(r);
    const found = getReview("rev-known-id");
    expect(found?.id).toBe("rev-known-id");
  });

  it("hasReviewForRun returns true when review exists", () => {
    const r = makeReview({ runId: "run-exists" });
    upsertReview(r);
    expect(hasReviewForRun("run-exists")).toBe(true);
    expect(hasReviewForRun("run-missing")).toBe(false);
  });

  it("listReviews returns most-recent-first", () => {
    const now = Date.now();
    const r1 = makeReview({ completedAt: now - 5000, runId: "run-old" });
    const r2 = makeReview({ completedAt: now, runId: "run-new" });
    upsertReview(r1);
    upsertReview(r2);
    const { reviews } = listReviews();
    expect(reviews[0]?.runId).toBe("run-new");
    expect(reviews[1]?.runId).toBe("run-old");
  });

  it("listReviews filters by status", () => {
    upsertReview(makeReview({ runId: "r1", status: "completed" }));
    upsertReview(makeReview({ runId: "r2", status: "errored" }));
    const { reviews } = listReviews({ status: "errored" });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.runId).toBe("r2");
  });

  it("listReviews filters by projectId", () => {
    upsertReview(makeReview({ runId: "r1", projectId: "proj-A" }));
    upsertReview(makeReview({ runId: "r2", projectId: "proj-B" }));
    const { reviews, total } = listReviews({ projectId: "proj-A" });
    expect(total).toBe(1);
    expect(reviews[0]?.projectId).toBe("proj-A");
  });

  it("listReviews filters by sessionKey", () => {
    upsertReview(makeReview({ runId: "r1", sessionKey: "sess:a" }));
    upsertReview(makeReview({ runId: "r2", sessionKey: "sess:b" }));
    const { reviews } = listReviews({ sessionKey: "sess:b" });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.sessionKey).toBe("sess:b");
  });

  it("listReviews filters by since", () => {
    const now = Date.now();
    upsertReview(makeReview({ runId: "r1", completedAt: now - 10_000 }));
    upsertReview(makeReview({ runId: "r2", completedAt: now - 1_000 }));
    const { reviews } = listReviews({ since: now - 5_000 });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.runId).toBe("r2");
  });

  it("listReviews respects limit", () => {
    for (let i = 0; i < 10; i++) {
      upsertReview(makeReview());
    }
    const { reviews, total } = listReviews({ limit: 3 });
    expect(reviews).toHaveLength(3);
    expect(total).toBe(10);
  });

  it("persists reviews across cache reset (round-trip)", () => {
    const r = makeReview({ runId: "run-persist", summary: "Persisted." });
    upsertReview(r);
    // Wipe the in-memory cache to force a disk reload.
    resetReviewStoreForTests();
    const found = getReviewByRunId("run-persist");
    expect(found).not.toBeUndefined();
    expect(found?.summary).toBe("Persisted.");
  });
});
