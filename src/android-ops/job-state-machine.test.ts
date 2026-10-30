/**
 * The seven-state posting pipeline. These tests pin the guards, not just the
 * happy path — the guards are what make the pipeline trustworthy when a rack
 * of used handsets starts misbehaving.
 */

import { describe, it, expect } from "vitest";
import {
  applyTransition,
  canRetry,
  canTransition,
  isActive,
  isTerminal,
  JobTransitionError,
  nextRetryDelayMs,
  resumeStateFor,
  TRANSITIONS,
} from "./job-state-machine.js";
import { ComplianceViolationError } from "./compliance.js";
import type { JobState, PostJob } from "./types.js";

const NOW = 1_800_000_000_000;

function job(over: Partial<PostJob> = {}): PostJob {
  return {
    id: "job-1",
    mediaId: "media-1",
    accountId: "acct-1",
    deviceId: "dev-01",
    platform: "instagram",
    state: "SCHEDULED",
    caption: "hello",
    scheduledFor: NOW,
    dispatchedAt: null,
    preparedAt: null,
    postedAt: null,
    failedAt: null,
    attempt: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    lastError: null,
    actionRequired: null,
    bundleRef: null,
    permalink: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const operator = { now: NOW, actor: "operator:demo" };

describe("transition table", () => {
  it("treats POSTED as terminal and FAILED as retryable", () => {
    expect(isTerminal("POSTED")).toBe(true);
    expect(TRANSITIONS.POSTED).toEqual([]);
    expect(TRANSITIONS.FAILED).toContain("SCHEDULED");
  });

  it("counts only in-flight states as active", () => {
    const active: JobState[] = ["SCHEDULED", "DISPATCHED", "PREPARED"];
    for (const s of active) expect(isActive(s)).toBe(true);
    for (const s of ["DRAFT", "ACTION_REQUIRED", "POSTED", "FAILED"] as JobState[]) {
      expect(isActive(s)).toBe(false);
    }
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("DRAFT", "POSTED")).toBe(false);
    expect(canTransition("SCHEDULED", "POSTED")).toBe(false);
    expect(canTransition("POSTED", "SCHEDULED")).toBe(false);
    expect(() => applyTransition(job({ state: "DRAFT" }), "POSTED", operator)).toThrow(
      JobTransitionError,
    );
  });
});

describe("the happy path", () => {
  it("walks DRAFT → SCHEDULED → DISPATCHED → PREPARED → POSTED with timestamps", () => {
    let j = job({ state: "DRAFT" });
    j = applyTransition(j, "SCHEDULED", operator).job;
    expect(j.state).toBe("SCHEDULED");

    j = applyTransition(j, "DISPATCHED", { ...operator, deviceOnline: true }).job;
    expect(j.dispatchedAt).toBe(NOW);

    j = applyTransition(j, "PREPARED", operator).job;
    expect(j.preparedAt).toBe(NOW);

    const posted = applyTransition(j, "POSTED", {
      ...operator,
      permalink: "https://example.com/p/1",
    });
    expect(posted.job.state).toBe("POSTED");
    expect(posted.job.postedAt).toBe(NOW);
    expect(posted.job.permalink).toBe("https://example.com/p/1");
    expect(posted.summary).toContain("https://example.com/p/1");
  });
});

describe("guards", () => {
  it("refuses to dispatch to an unreachable handset", () => {
    expect(() =>
      applyTransition(job(), "DISPATCHED", { ...operator, deviceOnline: false }),
    ).toThrow(/not reachable/);
  });

  it("refuses to dispatch an account with no device", () => {
    expect(() => applyTransition(job({ deviceId: null }), "DISPATCHED", operator)).toThrow(
      /no device assigned/,
    );
  });

  it("refuses to prepare a job that was never dispatched", () => {
    // Reached only by constructing the state directly — the guard is the net.
    const j = job({ state: "DISPATCHED", deviceId: null });
    expect(() => applyTransition(j, "PREPARED", operator)).toThrow(/never dispatched/);
  });

  it("refuses a failure with no recorded error", () => {
    expect(() => applyTransition(job({ state: "DISPATCHED" }), "FAILED", operator)).toThrow(
      /must record an error/,
    );
  });

  it("refuses an escalation with no kind or message", () => {
    expect(() => applyTransition(job(), "ACTION_REQUIRED", operator)).toThrow(
      /needs a kind and a message/,
    );
  });
});

describe("failure, retry and backoff", () => {
  it("records the error plus the failure bundle and schedules a retry", () => {
    const failed = applyTransition(job({ state: "PREPARED", preparedAt: NOW }), "FAILED", {
      ...operator,
      error: "Upload stalled at 61%",
      bundleRef: "bundle://x/1",
    }).job;

    expect(failed.lastError).toBe("Upload stalled at 61%");
    expect(failed.bundleRef).toBe("bundle://x/1");
    expect(failed.failedAt).toBe(NOW);
    expect(failed.nextRetryAt).toBe(NOW + nextRetryDelayMs(1));
    expect(failed.attempt).toBe(1);
  });

  it("increments the attempt counter on retry and clears the failure fields", () => {
    const failed = job({ state: "FAILED", attempt: 1, lastError: "boom", failedAt: NOW });
    const retried = applyTransition(failed, "SCHEDULED", operator).job;
    expect(retried.attempt).toBe(2);
    expect(retried.failedAt).toBeNull();
    expect(retried.nextRetryAt).toBeNull();
  });

  it("stops retrying once the budget is spent", () => {
    const spent = job({ state: "FAILED", attempt: 3, maxAttempts: 3, lastError: "boom" });
    expect(canRetry(spent)).toBe(false);
    expect(() => applyTransition(spent, "SCHEDULED", operator)).toThrow(/retry budget exhausted/);
  });

  it("leaves no retry scheduled once the third attempt fails", () => {
    const last = applyTransition(job({ state: "PREPARED", attempt: 3, maxAttempts: 3 }), "FAILED", {
      ...operator,
      error: "final",
    }).job;
    expect(last.nextRetryAt).toBeNull();
  });

  it("backs off, then caps at 30 minutes", () => {
    expect(nextRetryDelayMs(1)).toBe(2 * 60_000);
    expect(nextRetryDelayMs(2)).toBe(8 * 60_000);
    expect(nextRetryDelayMs(9)).toBe(30 * 60_000);
  });
});

describe("ACTION REQUIRED is a human checkpoint", () => {
  const parked = job({
    state: "ACTION_REQUIRED",
    dispatchedAt: NOW - 1000,
    actionRequired: {
      kind: "captcha",
      message: "Human verification challenge on Phone 03.",
      raisedAt: NOW - 900,
    },
  });

  it("can be raised from any in-flight state and captures the bundle", () => {
    const raised = applyTransition(job({ state: "DISPATCHED" }), "ACTION_REQUIRED", {
      ...operator,
      actionRequired: { kind: "captcha", message: "Verification challenge." },
      bundleRef: "bundle://shot/1",
    });
    expect(raised.job.actionRequired?.kind).toBe("captcha");
    expect(raised.job.bundleRef).toBe("bundle://shot/1");
    expect(raised.summary).toContain("escalated to operator");
  });

  it("cannot be cleared by the scheduler or the simulator", () => {
    for (const actor of ["scheduler", "system", "simulator", "agent", ""]) {
      expect(() => applyTransition(parked, "DISPATCHED", { now: NOW, actor })).toThrow(
        ComplianceViolationError,
      );
    }
  });

  it("can be cleared by a named operator, recording who and when", () => {
    const resumed = applyTransition(parked, "DISPATCHED", { ...operator, deviceOnline: true }).job;
    expect(resumed.state).toBe("DISPATCHED");
    expect(resumed.actionRequired?.resolvedBy).toBe("operator:demo");
    expect(resumed.actionRequired?.resolvedAt).toBe(NOW);
  });

  it("resumes at the stage it was raised from", () => {
    expect(resumeStateFor(job({ preparedAt: NOW, dispatchedAt: NOW }))).toBe("PREPARED");
    expect(resumeStateFor(job({ dispatchedAt: NOW }))).toBe("DISPATCHED");
    expect(resumeStateFor(job())).toBe("SCHEDULED");
  });

  it("will not post a checkpointed job that never reached PREPARED", () => {
    expect(() => applyTransition(parked, "POSTED", operator)).toThrow(/must be PREPARED/);
  });
});
