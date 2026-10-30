import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetApprovalRegistry,
  getApprovalRequest,
  resolveApprovalRequest,
} from "../autonomy/approval-registry.js";
import { createCheckpointReportTool } from "./tools/checkpoint-report-tool.js";
import {
  clearCheckpointsForRun,
  decideCheckpoint,
  initProgressTracking,
  listCheckpoints,
  recordCheckpoint,
  registerCheckpointConfig,
} from "./subagent-progress.js";

vi.mock("./coder-runtime/subagent-broadcast.js", () => ({ broadcastSubagentCheckpoint: vi.fn() }));

let n = 0;
function gatedRun(opts?: { approvalTimeoutMs?: number }) {
  n += 1;
  const runId = `run-gated-${n}`;
  const sessionKey = `agent:main:subagent:gated-${n}`;
  initProgressTracking({
    runId,
    sessionKey,
    label: "fix login",
    task: "fix the login bug",
    requesterSessionKey: "agent:main:main",
  });
  registerCheckpointConfig({ runId, sessionKey, requireApproval: true, ...opts });
  return { runId, sessionKey };
}

beforeEach(() => _resetApprovalRegistry());
afterEach(() => {
  vi.useRealTimers();
  _resetApprovalRegistry();
});

describe("gated check-ins → unified approvals", () => {
  it("creates a check-in approval (approve/stop/redirect) with drift raising risk", async () => {
    const { runId, sessionKey } = gatedRun();
    const { checkpoint, wait } = recordCheckpoint({
      sessionKey,
      summary: "Fixed the null check",
      next: "Rewrite the whole auth module from scratch",
      deviations: ["touching src/auth/*"],
    });
    expect(wait).toBeDefined();
    const rec = getApprovalRequest(checkpoint.approvalId!)!;
    expect(rec).toMatchObject({
      source: "subagent-checkpoint",
      title: "Check-in: fix login",
      summary: "Fixed the null check",
      risk: "high",
      resumable: false,
      sourceRef: { runId, checkpointId: checkpoint.id },
    });
    expect(rec.options).toEqual(expect.arrayContaining(["approve", "deny", "redirect"]));
    expect(rec.details).toContain("NEXT: Rewrite the whole auth module");
    expect(rec.details).toContain("touching src/auth/*");
    resolveApprovalRequest(rec.id, { action: "approve", via: "telegram" });
    expect(await wait).toMatchObject({ decision: "approve" });
    clearCheckpointsForRun(runId);
  });

  it("Telegram redirect unblocks the agent with the note as the revised plan", async () => {
    const { runId, sessionKey } = gatedRun();
    const tool = createCheckpointReportTool({ agentSessionKey: sessionKey });
    const pending = tool.execute("t1", { summary: "did A", next: "do B" }) as Promise<{
      details: Record<string, unknown>;
    }>;
    const cp = listCheckpoints(runId).at(-1)!;
    resolveApprovalRequest(cp.approvalId!, {
      action: "redirect",
      note: "Do C instead of B",
      by: "@boss",
      via: "telegram",
    });
    const result = await pending;
    expect(result.details).toMatchObject({
      status: "redirected",
      decision: "redirect",
      revisedPlan: "Do C instead of B",
    });
    expect(listCheckpoints(runId).at(-1)).toMatchObject({ pending: false, decision: "redirect" });
    clearCheckpointsForRun(runId);
  });

  it("Telegram deny = Stop", async () => {
    const { runId, sessionKey } = gatedRun();
    const { checkpoint, wait } = recordCheckpoint({ sessionKey, summary: "s", next: "n" });
    resolveApprovalRequest(checkpoint.approvalId!, { action: "deny", via: "telegram" });
    expect(await wait).toMatchObject({ decision: "stop" });
    clearCheckpointsForRun(runId);
  });

  it("focus-modal decision closes the approval (first wins, Telegram tap loses)", async () => {
    const { runId, sessionKey } = gatedRun();
    const { checkpoint, wait } = recordCheckpoint({ sessionKey, summary: "s", next: "n" });
    expect(
      decideCheckpoint({
        runId,
        checkpointId: checkpoint.id,
        decision: "redirect",
        editedNext: "smaller scope",
        by: "Control UI",
      }).ok,
    ).toBe(true);
    expect(await wait).toMatchObject({ decision: "redirect", editedNext: "smaller scope" });
    expect(getApprovalRequest(checkpoint.approvalId!)).toMatchObject({
      status: "redirected",
      note: "smaller scope",
      decidedVia: "ui",
      decidedBy: "Control UI",
    });
    expect(
      resolveApprovalRequest(checkpoint.approvalId!, { action: "approve", via: "telegram" }),
    ).toMatchObject({ ok: false, error: "already_resolved" });
    clearCheckpointsForRun(runId);
  });

  it("expiry STOPS the agent (never auto-approves)", async () => {
    vi.useFakeTimers();
    const { runId, sessionKey } = gatedRun({ approvalTimeoutMs: 60_000 });
    const { checkpoint, wait } = recordCheckpoint({ sessionKey, summary: "s", next: "n" });
    vi.advanceTimersByTime(61_000);
    const res = await wait;
    expect(res.decision).toBe("stop");
    expect(res.note).toContain("No operator response");
    expect(getApprovalRequest(checkpoint.approvalId!)).toMatchObject({
      status: "denied",
      reason: "expired",
    });
    clearCheckpointsForRun(runId);
  });

  it("soft (ungated) check-ins never create approvals", () => {
    n += 1;
    const sessionKey = `agent:main:subagent:soft-${n}`;
    registerCheckpointConfig({ runId: `run-soft-${n}`, sessionKey, requireApproval: false });
    const { checkpoint, wait } = recordCheckpoint({ sessionKey, summary: "s", next: "n" });
    expect(wait).toBeUndefined();
    expect(checkpoint.approvalId).toBeUndefined();
    clearCheckpointsForRun(`run-soft-${n}`);
  });
});
