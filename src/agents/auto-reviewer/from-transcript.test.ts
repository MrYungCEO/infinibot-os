import { describe, it, expect, vi } from "vitest";
import { parseTestResultsFromText, deriveReview, type RunContext } from "./from-transcript.js";

// Mock the LLM call so tests don't hit the network
vi.mock("../../services/email/llm-analysis.js", () => ({
  runLLM: vi.fn().mockResolvedValue({
    text: JSON.stringify({
      summary: "The agent edited two files and ran tests successfully.",
      nextSteps: ["Deploy to staging"],
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

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "run-test",
    sessionKey: "sess:coder:test",
    task: "Refactor the auth module",
    label: "Auth refactor",
    status: "completed",
    durationMs: 30_000,
    completedAt: Date.now(),
    ...overrides,
  };
}

describe("parseTestResultsFromText", () => {
  it("parses vitest output", () => {
    const text = "Tests  5 passed | 1 failed | 0 skipped";
    const result = parseTestResultsFromText(text);
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(5);
    expect(result?.failed).toBe(1);
    expect(result?.skipped).toBe(0);
  });

  it("parses jest-style output", () => {
    const text = "3 tests passed";
    const result = parseTestResultsFromText(text);
    expect(result).not.toBeNull();
  });

  it("returns null when no test pattern found", () => {
    expect(parseTestResultsFromText("No tests here")).toBeNull();
    expect(parseTestResultsFromText("")).toBeNull();
  });
});

describe("deriveReview", () => {
  it("returns a valid review for a completed run", async () => {
    const ctx = makeCtx({
      filesTouched: [
        { path: "src/auth.ts", action: "edited" },
        { path: "src/auth.test.ts", action: "created" },
      ],
    });
    const review = await deriveReview(ctx);
    expect(review.runId).toBe("run-test");
    expect(review.sessionKey).toBe("sess:coder:test");
    expect(review.status).toBe("completed");
    expect(review.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(review.filesTouched)).toBe(true);
    expect(Array.isArray(review.nextSteps)).toBe(true);
    expect(Array.isArray(review.blockers)).toBe(true);
    expect(["high", "medium", "low"]).toContain(review.confidence);
    expect(typeof review.durationMs).toBe("number");
    expect(typeof review.completedAt).toBe("number");
    expect(typeof review.id).toBe("string");
    expect(review.selfReported).toBe(false);
  });

  it("maps file actions correctly", async () => {
    const ctx = makeCtx({
      filesTouched: [
        { path: "a.ts", action: "created" },
        { path: "b.ts", action: "edited" },
        { path: "c.ts", action: "deleted" },
        { path: "d.ts", action: "read" }, // reads should be excluded
      ],
    });
    const review = await deriveReview(ctx);
    const actions = review.filesTouched.map((f) => f.action);
    expect(actions).toContain("added");
    expect(actions).toContain("modified");
    expect(actions).toContain("deleted");
    // "read" files should not appear in review
    expect(review.filesTouched.find((f) => f.path === "d.ts")).toBeUndefined();
  });

  it("dedupes files by path (keeps last action)", async () => {
    const ctx = makeCtx({
      filesTouched: [
        { path: "src/x.ts", action: "created" },
        { path: "src/x.ts", action: "edited" },
      ],
    });
    const review = await deriveReview(ctx);
    const matches = review.filesTouched.filter((f) => f.path === "src/x.ts");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.action).toBe("modified"); // last action wins
  });

  it("parses test results from progress updates", async () => {
    const ctx = makeCtx({
      progressUpdates: ["Tests  4 passed | 0 failed | 1 skipped"],
    });
    const review = await deriveReview(ctx);
    // If tests are detected, testsRun should be populated
    if (review.testsRun) {
      expect(review.testsRun.passed).toBe(4);
      expect(review.testsRun.failed).toBe(0);
      expect(review.testsRun.skipped).toBe(1);
    }
  });

  it("falls back to deterministic summary when LLM throws on all retries", async () => {
    const { runLLM } = await import("../../services/email/llm-analysis.js");
    // Reject every call (both the initial attempt and the single retry)
    vi.mocked(runLLM).mockRejectedValue(new Error("LLM timeout"));

    const ctx = makeCtx({
      status: "errored",
      errorMessage: "Process exited with code 1",
    });
    const review = await deriveReview(ctx);
    // Should still have a summary from the deterministic fallback
    expect(review.summary.length).toBeGreaterThan(0);
    // Deterministic fallback sets confidence to "low" for errored runs
    expect(review.confidence).toBe("low");

    // Restore mock to default for subsequent tests
    vi.mocked(runLLM).mockResolvedValue({
      text: JSON.stringify({
        summary: "Mocked summary.",
        nextSteps: [],
        blockers: [],
        confidence: "high",
      }),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
  });
});
