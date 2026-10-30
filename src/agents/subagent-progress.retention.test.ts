/**
 * Subagent progress store retention tests.
 *
 * Asserts that:
 * 1. Active records are retained across many reportProgress calls.
 * 2. "finishing" records stay in listActiveProgress for 10 minutes (not 60 s).
 * 3. Active records are NOT deleted based on heartbeat silence (< 30 min).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// subagent-progress.ts only needs callGateway from the outside.
vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({})),
}));

import {
  initProgressTracking,
  reportProgress,
  completeProgress,
  getProgress,
  listActiveProgress,
} from "./subagent-progress.js";

const REQUESTER = "agent:main:requester-1";

describe("subagent progress store retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains an active progress record across many reportProgress calls", async () => {
    initProgressTracking({
      runId: "prog-retain-1",
      sessionKey: "agent:coder:prog-1",
      task: "Test task",
      requesterSessionKey: REQUESTER,
    });

    for (let i = 0; i < 10; i++) {
      await reportProgress({
        runId: "prog-retain-1",
        sessionKey: "agent:coder:prog-1",
        status: "working",
        message: `Step ${i}`,
        progress: i * 10,
        notifyRequester: false,
      });
    }

    const after = getProgress("prog-retain-1");
    expect(after).toBeDefined();
    expect(after!.status).toBe("working");
    expect(after!.progress).toBe(90); // last call: i=9 → 90
  });

  it("keeps 'finishing' records in listActiveProgress for 10 minutes (not 60 seconds)", () => {
    initProgressTracking({
      runId: "prog-finish-1",
      sessionKey: "agent:coder:fin-1",
      task: "Finish test",
      requesterSessionKey: REQUESTER,
    });

    completeProgress("prog-finish-1", "Done");

    // At 61 seconds (the old 60-second threshold) the record must still be visible.
    vi.advanceTimersByTime(61_000);
    expect(listActiveProgress().some((r) => r.runId === "prog-finish-1")).toBe(true);

    // At 9 minutes total — still inside the new 10-min window.
    vi.advanceTimersByTime(9 * 60_000 - 61_000);
    expect(listActiveProgress().some((r) => r.runId === "prog-finish-1")).toBe(true);
  });

  it("does NOT delete a non-finishing record based on heartbeat silence (< 30 min)", () => {
    initProgressTracking({
      runId: "prog-silent-1",
      sessionKey: "agent:coder:sil-1",
      task: "Silent test",
      requesterSessionKey: REQUESTER,
    });

    // 25 minutes of silence — stale cleanup threshold is 30 min.
    vi.advanceTimersByTime(25 * 60_000);

    expect(getProgress("prog-silent-1")).toBeDefined();
    expect(listActiveProgress().some((r) => r.runId === "prog-silent-1")).toBe(true);
  });
});
