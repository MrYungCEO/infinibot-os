/**
 * Integration test for the mandatory verification gate.
 *
 * Proves — without a live gateway or a real verifier child — that
 * `verifyAndFinalizeKanban` enforces "verify before done" across the four
 * required scenarios, using injected fakes for the verifier + kanban update:
 *   (a) clean exit + verifier PASS  → review → done
 *   (b) clean exit + verifier FAIL  → review, NEVER done
 *   (c) verifier error / timeout    → fail-closed, stays in review
 *   (d) dirty exit                  → review, verifier never invoked
 * Plus the single-flight guard (one verifier run per runId across both chokepoints).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyAndFinalizeKanban,
  __resetVerificationGateForTests,
  type VerifyOpts,
  type VerificationVerdict,
} from "./verification-gate.js";

afterEach(() => {
  __resetVerificationGateForTests();
});

function fakeKanban() {
  const transitions: string[] = [];
  return {
    transitions,
    updateTask: vi.fn(async (_taskId: string, patch: { status: string }) => {
      transitions.push(patch.status);
    }),
  };
}

const baseOpts = (over: Partial<VerifyOpts> = {}): VerifyOpts => ({
  runId: `run-${Math.random().toString(36).slice(2)}`,
  taskId: "task-1",
  succeeded: true,
  ...over,
});

describe("verifyAndFinalizeKanban", () => {
  it("(a) clean exit + verifier PASS → review then done", async () => {
    const kb = fakeKanban();
    const verify = vi.fn(
      async (): Promise<VerificationVerdict> => ({
        pass: true,
        failClosed: false,
        reason: "all criteria met",
      }),
    );
    const verdict = await verifyAndFinalizeKanban(baseOpts(), {
      updateTask: kb.updateTask,
      runVerifier: verify,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verdict.pass).toBe(true);
    // Parked in review BEFORE the done flip — order matters.
    expect(kb.transitions).toEqual(["review", "done"]);
  });

  it("audit-only when the verified-completion pipeline owns the kanban status", async () => {
    const kb = fakeKanban();
    const verify = vi.fn(
      async (): Promise<VerificationVerdict> => ({ pass: true, failClosed: false, reason: "ok" }),
    );
    const verdict = await verifyAndFinalizeKanban(baseOpts(), {
      updateTask: kb.updateTask,
      runVerifier: verify,
      pipelineOwnsKanban: () => true,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verdict.pass).toBe(true);
    // The reconciler (src/verification/kanban-reconcile.ts) moves the card.
    expect(kb.transitions).toEqual([]);
    const dirty = fakeKanban();
    await verifyAndFinalizeKanban(baseOpts({ succeeded: false }), {
      updateTask: dirty.updateTask,
      pipelineOwnsKanban: () => true,
    });
    expect(dirty.transitions).toEqual([]);
  });

  it("(b) clean exit + verifier FAIL → stays in review, never done", async () => {
    const kb = fakeKanban();
    const verify = vi.fn(
      async (): Promise<VerificationVerdict> => ({
        pass: false,
        failClosed: false,
        reason: "2 criteria unmet",
      }),
    );
    const verdict = await verifyAndFinalizeKanban(baseOpts(), {
      updateTask: kb.updateTask,
      runVerifier: verify,
    });
    expect(verdict.pass).toBe(false);
    expect(kb.transitions).toEqual(["review"]);
    expect(kb.transitions).not.toContain("done");
  });

  it("(c) verifier throws (spawn-error/timeout) → fail-closed, stays in review", async () => {
    const kb = fakeKanban();
    const verify = vi.fn(async (): Promise<VerificationVerdict> => {
      throw new Error("verifier timed out after 360000ms");
    });
    const verdict = await verifyAndFinalizeKanban(baseOpts(), {
      updateTask: kb.updateTask,
      runVerifier: verify,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.failClosed).toBe(true);
    expect(verdict.reason).toMatch(/verifier error/i);
    expect(kb.transitions).toEqual(["review"]);
    expect(kb.transitions).not.toContain("done");
  });

  it("(d) dirty agent exit → review, verifier never invoked", async () => {
    const kb = fakeKanban();
    const verify = vi.fn(
      async (): Promise<VerificationVerdict> => ({ pass: true, failClosed: false, reason: "x" }),
    );
    const verdict = await verifyAndFinalizeKanban(baseOpts({ succeeded: false }), {
      updateTask: kb.updateTask,
      runVerifier: verify,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(verdict.pass).toBe(false);
    expect(kb.transitions).toEqual(["review"]);
  });

  it("single-flight: a second chokepoint for the same run reuses the verdict (verifier runs once)", async () => {
    const kb = fakeKanban();
    const verify = vi.fn(
      async (): Promise<VerificationVerdict> => ({ pass: true, failClosed: false, reason: "ok" }),
    );
    const opts = baseOpts();
    const first = await verifyAndFinalizeKanban(opts, {
      updateTask: kb.updateTask,
      runVerifier: verify,
    });
    const second = await verifyAndFinalizeKanban(opts, {
      updateTask: kb.updateTask,
      runVerifier: verify,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(first.pass).toBe(true);
    expect(second).toEqual(first);
    // No extra kanban churn on the duplicate call.
    expect(kb.transitions).toEqual(["review", "done"]);
  });

  it("no taskId → verifier still runs (audit trail) but no kanban transitions", async () => {
    const kb = fakeKanban();
    const verify = vi.fn(
      async (): Promise<VerificationVerdict> => ({ pass: true, failClosed: false, reason: "ok" }),
    );
    const verdict = await verifyAndFinalizeKanban(baseOpts({ taskId: undefined }), {
      updateTask: kb.updateTask,
      runVerifier: verify,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verdict.pass).toBe(true);
    expect(kb.transitions).toEqual([]);
  });
});
