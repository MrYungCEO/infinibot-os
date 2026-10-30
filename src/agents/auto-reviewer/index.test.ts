import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Redirect state dir to a temp directory
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-auto-review-test-"));
vi.stubEnv("INFINIBOT_STATE_DIR", tmpDir);

// Mock LLM
vi.mock("../../services/email/llm-analysis.js", () => ({
  runLLM: vi.fn().mockResolvedValue({
    text: JSON.stringify({
      summary: "Mocked LLM review summary.",
      nextSteps: [],
      blockers: [],
      confidence: "high",
    }),
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  }),
  getActiveLLM: vi
    .fn()
    .mockReturnValue({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }),
}));

// Mock subagent-registry and subagent-history so we control what the auto-reviewer sees
const mockRegistry = new Map();
const mockHistory = new Map();

vi.mock("../subagent-registry.js", () => ({
  getSubagentRun: (runId) => mockRegistry.get(runId),
}));

vi.mock("../subagent-history.js", () => ({
  getSubagentHistoryEntryByRunId: (runId) => mockHistory.get(runId),
}));

vi.mock("../subagent-progress.js", () => ({
  getProgress: () => undefined,
}));

import { autoReview } from "./index.js";
import { hasReviewForRun, getReviewByRunId, resetReviewStoreForTests } from "../reviews/index.js";

function makeRunRecord(overrides = {}) {
  const now = Date.now();
  return {
    runId: "run-test",
    childSessionKey: "sess:coder:test",
    requesterSessionKey: "sess:main",
    requesterDisplayKey: "main",
    task: "Fix the bug in auth module",
    label: "Auth fix",
    cleanup: "delete",
    createdAt: now - 10_000,
    startedAt: now - 10_000,
    endedAt: now,
    outcome: { status: "ok" },
    filesTouched: [{ path: "src/auth.ts", action: "edited", at: now }],
    ...overrides,
  };
}

function makeHistoryEntry(overrides = {}) {
  const now = Date.now();
  return {
    runId: "run-hist",
    label: "History run",
    task: "Migrate DB schema",
    status: "complete",
    startedAt: now - 30_000,
    endedAt: now,
    outcome: { status: "ok" },
    requesterSessionKey: "sess:main",
    filesTouchedCount: 2,
    filesTouchedSample: ["migrations/001.sql"],
    ...overrides,
  };
}

describe("autoReview", () => {
  beforeEach(() => {
    mockRegistry.clear();
    mockHistory.clear();
    resetReviewStoreForTests();
  });

  it("generates a review from a live registry run", async () => {
    const rec = makeRunRecord({ runId: "run-live" });
    mockRegistry.set("run-live", rec);

    await autoReview("run-live");

    expect(hasReviewForRun("run-live")).toBe(true);
    const review = getReviewByRunId("run-live");
    expect(review).not.toBeUndefined();
    expect(review?.runId).toBe("run-live");
    expect(review?.selfReported).toBe(false);
  });

  it("generates a review from archive when run not in live registry", async () => {
    const entry = makeHistoryEntry({ runId: "run-archived" });
    mockHistory.set("run-archived", entry);

    await autoReview("run-archived");

    expect(hasReviewForRun("run-archived")).toBe(true);
  });

  it("is idempotent — second call skips when review exists", async () => {
    const rec = makeRunRecord({ runId: "run-idem" });
    mockRegistry.set("run-idem", rec);

    await autoReview("run-idem");
    const reviewAfterFirst = getReviewByRunId("run-idem");

    // Run again — should not overwrite
    await autoReview("run-idem");
    const reviewAfterSecond = getReviewByRunId("run-idem");

    expect(reviewAfterFirst?.id).toBe(reviewAfterSecond?.id);
  });

  it("skips runs still in progress (no endedAt)", async () => {
    const rec = makeRunRecord({ runId: "run-active", endedAt: undefined, outcome: undefined });
    mockRegistry.set("run-active", rec);

    await autoReview("run-active");

    expect(hasReviewForRun("run-active")).toBe(false);
  });

  it("skips when runId is not found anywhere", async () => {
    await autoReview("run-ghost");
    expect(hasReviewForRun("run-ghost")).toBe(false);
  });

  it("skips empty runId without throwing", async () => {
    await expect(autoReview("")).resolves.not.toThrow();
  });

  it("dedupes concurrent calls — parallel calls produce one review", async () => {
    const rec = makeRunRecord({ runId: "run-concurrent" });
    mockRegistry.set("run-concurrent", rec);

    // Fire three concurrent calls; only one should write a review
    await Promise.all([
      autoReview("run-concurrent"),
      autoReview("run-concurrent"),
      autoReview("run-concurrent"),
    ]);

    const { listReviews } = await import("../reviews/index.js");
    const { reviews } = listReviews();
    const matches = reviews.filter((r) => r.runId === "run-concurrent");
    expect(matches).toHaveLength(1);
  });
});
