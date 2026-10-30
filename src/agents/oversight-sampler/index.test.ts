import { describe, it, expect } from "vitest";

import { recheckReview } from "./index.js";
import type { AgentReview } from "../reviews/index.js";

function review(overrides: Partial<AgentReview>): AgentReview {
  return {
    id: "id",
    runId: "run",
    sessionKey: "sk",
    status: "completed",
    summary: "did the thing",
    filesTouched: [{ path: "a.ts", action: "modified", linesAdded: 1, linesRemoved: 0 }],
    nextSteps: [],
    blockers: [],
    confidence: "high",
    durationMs: 1000,
    completedAt: Date.now(),
    buildPassed: true,
    ...overrides,
  };
}

describe("oversight-sampler recheckReview", () => {
  it("passes a clean completed run", () => {
    expect(recheckReview(review({})).verdict).toBe("clean");
  });

  it("flags a completed run that touched nothing and had no build as reopened", () => {
    const r = review({ filesTouched: [], buildPassed: undefined });
    expect(recheckReview(r).verdict).toBe("reopened");
  });

  it("flags drift on a failing build", () => {
    expect(recheckReview(review({ buildPassed: false })).verdict).toBe("drift");
  });

  it("flags drift when blockers remain on a closed run", () => {
    expect(recheckReview(review({ blockers: ["db migration pending"] })).verdict).toBe("drift");
  });

  it("flags drift on an errored run", () => {
    expect(recheckReview(review({ status: "errored" })).verdict).toBe("drift");
  });

  it("flags drift on low-confidence auto-review", () => {
    expect(recheckReview(review({ confidence: "low" })).verdict).toBe("drift");
  });
});
