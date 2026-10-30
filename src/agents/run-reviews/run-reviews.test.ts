import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { derive, type RunReviewInput } from "./derive.js";
import { parseAgentRunReview, isValidAgentRunReview, type AgentRunReview } from "./schema.js";
import { upsertRunReview } from "./writer.js";
import { listRunReviews, getRunReview, getRunReviewByRunId } from "./query.js";
import { resetRunReviewStoreForTests, resolveRunReviewsPath } from "./store.js";
import fs from "node:fs";

function baseInput(overrides: Partial<RunReviewInput> = {}): RunReviewInput {
  return {
    runId: "run-1",
    title: "Add feature X",
    task: "Add feature X to the widget",
    agentKind: "cli",
    backend: "claude-code",
    outcomeStatus: "ok",
    startedAt: 1_000,
    finishedAt: 4_000,
    filesTouched: [
      { path: "src/a.ts", action: "created" },
      { path: "src/b.ts", action: "edited" },
      { path: "src/a.ts", action: "edited" }, // dedupe → last non-read
      { path: "src/c.ts", action: "read" }, // dropped
    ],
    progress: [
      { ts: 1_100, kind: "working", message: "Editing files" },
      { ts: 3_900, kind: "finishing", message: "tsc: 0 errors, build passed" },
    ],
    ...overrides,
  };
}

describe("derive()", () => {
  it("builds a review with deduped files, timeline, status, forward actions", () => {
    const d = derive(baseInput());
    expect(d.status).toBe("built"); // ok + positive build evidence
    expect(d.built).toBe(true);
    expect(d.buildEvidence).toBeTruthy();
    const paths = d.filesTouched.map((f) => f.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]); // c.ts (read) dropped, a.ts deduped
    expect(d.filesTouched.find((f) => f.path === "src/a.ts")?.changeKind).toBe("modified");
    expect(d.durationMs).toBe(3_000);
    expect(d.actions.length).toBe(2);
    // built → a "verify" forward action
    expect(d.forwardActions.some((a) => a.kind === "verify")).toBe(true);
  });

  it("marks an errored run with files as partial and offers respawn", () => {
    const d = derive(
      baseInput({ outcomeStatus: "error", errorMessage: "boom", progress: [] }),
    );
    expect(d.status).toBe("partial");
    expect(d.issues.some((i) => i.severity === "error")).toBe(true);
    expect(d.forwardActions.some((a) => a.kind === "respawn")).toBe(true);
  });

  it("marks an errored run with no files as failed", () => {
    const d = derive(
      baseInput({ outcomeStatus: "error", filesTouched: [], progress: [] }),
    );
    expect(d.status).toBe("failed");
  });

  it("detects a build failure as not-built even when outcome is ok", () => {
    const d = derive(
      baseInput({
        progress: [{ ts: 2_000, kind: "working", message: "error TS2304: cannot find name" }],
      }),
    );
    expect(d.built).toBe(false);
    expect(d.status).toBe("not_built");
    expect(d.buildEvidence).toMatch(/TS2304/);
  });
});

describe("schema", () => {
  it("parses and validates a full record round-trip", () => {
    const d = derive(baseInput());
    const review: AgentRunReview = {
      id: "rev-1",
      runId: d.runId,
      projectId: "proj-1",
      title: d.title,
      agentKind: d.agentKind,
      backend: d.backend,
      status: d.status,
      startedAt: d.startedAt,
      finishedAt: d.finishedAt,
      durationMs: d.durationMs,
      summaryMarkdown: "## Summary\nDid the thing.",
      filesTouched: d.filesTouched,
      actions: d.actions,
      issues: d.issues,
      built: d.built,
      buildEvidence: d.buildEvidence,
      forwardActions: d.forwardActions,
    };
    expect(isValidAgentRunReview(review)).toBe(true);
    const parsed = parseAgentRunReview(JSON.parse(JSON.stringify(review)));
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe(d.status);
    expect(parsed?.summaryMarkdown).toContain("Summary");
  });
});

describe("store round-trip + persistence", () => {
  beforeEach(() => resetRunReviewStoreForTests());
  afterEach(() => {
    resetRunReviewStoreForTests();
    try {
      fs.unlinkSync(resolveRunReviewsPath());
    } catch {
      /* ignore */
    }
  });

  it("upserts (dedup by runId), lists filtered, and survives a cache reset (disk reload)", () => {
    const now = Date.now();
    const mk = (runId: string, projectId: string, status: AgentRunReview["status"]) => ({
      id: `id-${runId}`,
      runId,
      projectId,
      title: runId,
      agentKind: "cli" as const,
      status,
      startedAt: now - 1_000,
      finishedAt: now,
      summaryMarkdown: "## S",
      filesTouched: [],
      actions: [],
      issues: [],
      built: status === "built",
      forwardActions: [],
    });

    upsertRunReview(mk("run-a", "p1", "built"));
    upsertRunReview(mk("run-b", "p2", "failed"));
    // Second write for run-a replaces, doesn't duplicate.
    upsertRunReview({ ...mk("run-a", "p1", "not_built"), title: "run-a-v2" });

    expect(listRunReviews({}).total).toBe(2);
    expect(listRunReviews({ projectId: "p1" }).reviews[0].title).toBe("run-a-v2");
    expect(listRunReviews({ status: "failed" }).reviews.map((r) => r.runId)).toEqual(["run-b"]);

    // Simulate restart: drop the in-memory cache, reload from disk.
    resetRunReviewStoreForTests();
    expect(getRunReviewByRunId("run-a")?.title).toBe("run-a-v2");
    expect(getRunReview("id-run-b")?.status).toBe("failed");
    expect(listRunReviews({}).total).toBe(2);
  });
});
