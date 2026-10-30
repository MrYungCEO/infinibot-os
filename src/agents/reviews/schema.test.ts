import { describe, it, expect } from "vitest";
import {
  isValidAgentReview,
  isValidReviewStatus,
  isValidReviewConfidence,
  parseAgentReview,
  parseFileTouched,
  REVIEW_STATUSES,
  REVIEW_CONFIDENCES,
} from "./schema.js";

const VALID_REVIEW = {
  id: "rev-abc123",
  runId: "run-xyz",
  sessionKey: "sess:coder:abc",
  status: "completed" as const,
  summary: "Agent completed the task successfully.",
  filesTouched: [{ path: "src/foo.ts", action: "modified", linesAdded: 10, linesRemoved: 2 }],
  nextSteps: ["Deploy to staging"],
  blockers: [],
  confidence: "high" as const,
  durationMs: 5000,
  completedAt: Date.now(),
};

describe("isValidReviewStatus", () => {
  it("accepts all valid statuses", () => {
    for (const s of REVIEW_STATUSES) {
      expect(isValidReviewStatus(s)).toBe(true);
    }
  });
  it("rejects unknown strings", () => {
    expect(isValidReviewStatus("done")).toBe(false);
    expect(isValidReviewStatus(null)).toBe(false);
    expect(isValidReviewStatus(42)).toBe(false);
  });
});

describe("isValidReviewConfidence", () => {
  it("accepts all valid confidences", () => {
    for (const c of REVIEW_CONFIDENCES) {
      expect(isValidReviewConfidence(c)).toBe(true);
    }
  });
  it("rejects unknown values", () => {
    expect(isValidReviewConfidence("very-high")).toBe(false);
    expect(isValidReviewConfidence(undefined)).toBe(false);
  });
});

describe("isValidAgentReview", () => {
  it("accepts a complete review", () => {
    expect(isValidAgentReview(VALID_REVIEW)).toBe(true);
  });

  it("rejects missing required fields", () => {
    const { id: _id, ...noId } = VALID_REVIEW;
    expect(isValidAgentReview(noId)).toBe(false);

    const { runId: _r, ...noRunId } = VALID_REVIEW;
    expect(isValidAgentReview(noRunId)).toBe(false);

    const { summary: _s, ...noSummary } = VALID_REVIEW;
    expect(isValidAgentReview(noSummary)).toBe(false);

    expect(isValidAgentReview(null)).toBe(false);
    expect(isValidAgentReview("string")).toBe(false);
    expect(isValidAgentReview(42)).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(isValidAgentReview({ ...VALID_REVIEW, status: "done" })).toBe(false);
  });

  it("rejects invalid confidence", () => {
    expect(isValidAgentReview({ ...VALID_REVIEW, confidence: "very-high" })).toBe(false);
  });

  it("accepts optional fields as missing", () => {
    const minimal = {
      id: "rev-1",
      runId: "run-1",
      sessionKey: "s",
      status: "errored" as const,
      summary: "It failed.",
      filesTouched: [],
      nextSteps: [],
      blockers: [],
      confidence: "low" as const,
      durationMs: 100,
      completedAt: Date.now(),
    };
    expect(isValidAgentReview(minimal)).toBe(true);
  });
});

describe("parseFileTouched", () => {
  it("parses a valid file entry", () => {
    const result = parseFileTouched({
      path: "src/foo.ts",
      action: "added",
      linesAdded: 5,
      linesRemoved: 0,
    });
    expect(result).toEqual({
      path: "src/foo.ts",
      action: "added",
      linesAdded: 5,
      linesRemoved: 0,
    });
  });

  it("defaults linesAdded/linesRemoved to 0", () => {
    const result = parseFileTouched({ path: "x.ts", action: "deleted" });
    expect(result?.linesAdded).toBe(0);
    expect(result?.linesRemoved).toBe(0);
  });

  it("coerces unknown action to modified", () => {
    const result = parseFileTouched({ path: "x.ts", action: "read" });
    expect(result?.action).toBe("modified");
  });

  it("returns null for missing path", () => {
    expect(parseFileTouched({ action: "added" })).toBeNull();
    expect(parseFileTouched(null)).toBeNull();
    expect(parseFileTouched("string")).toBeNull();
  });
});

describe("parseAgentReview", () => {
  it("parses a complete valid review", () => {
    const result = parseAgentReview(VALID_REVIEW);
    expect(result).not.toBeNull();
    expect(result?.runId).toBe("run-xyz");
    expect(result?.status).toBe("completed");
    expect(result?.filesTouched).toHaveLength(1);
    expect(result?.filesTouched[0]?.action).toBe("modified");
  });

  it("returns null for missing required fields", () => {
    expect(parseAgentReview(null)).toBeNull();
    expect(parseAgentReview({ runId: "x" })).toBeNull(); // missing id
    expect(parseAgentReview({ id: "r", runId: "x", status: "done" })).toBeNull(); // bad status
  });

  it("defaults arrays to empty when absent", () => {
    const result = parseAgentReview({
      id: "r1",
      runId: "run-1",
      sessionKey: "s",
      status: "completed",
      summary: "ok",
      confidence: "medium",
      durationMs: 100,
      completedAt: 1000,
    });
    expect(result?.filesTouched).toEqual([]);
    expect(result?.nextSteps).toEqual([]);
    expect(result?.blockers).toEqual([]);
  });
});
