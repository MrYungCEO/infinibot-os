import { describe, expect, it } from "vitest";
import { estimateProgress } from "./progress-estimate";
import type { AgentSession } from "../controllers/agent-activity";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    key: "agent:main:test",
    agentId: "main",
    agentName: "Main",
    kind: "main",
    active: true,
    steps: [],
    expanded: false,
    loadingHistory: false,
    previewLoaded: false,
    updatedAt: Date.now(),
    ...overrides,
  } as AgentSession;
}

describe("estimateProgress", () => {
  it("returns COMPLETE at 100 when completedViaEvent is set", () => {
    const s = makeSession({ completedViaEvent: true, completionState: "done", active: false });
    expect(estimateProgress(s)).toEqual({ phase: "COMPLETE", pct: 100 });
  });

  it("returns ERROR at 100 when completedViaEvent with error state", () => {
    const s = makeSession({ completedViaEvent: true, completionState: "error", active: false });
    expect(estimateProgress(s)).toEqual({ phase: "ERROR", pct: 100 });
  });

  it("returns STARTING at 5 when active with no steps", () => {
    const s = makeSession({ active: true, steps: [] });
    expect(estimateProgress(s)).toEqual({ phase: "STARTING", pct: 5 });
  });

  it("returns THINKING phase when last step is thinking", () => {
    const s = makeSession({
      active: true,
      steps: [{ type: "thinking", content: "hmm", timestamp: Date.now() }],
    });
    const r = estimateProgress(s)!;
    expect(r.phase).toBe("THINKING");
    expect(r.pct).toBeGreaterThanOrEqual(30);
  });

  it("returns PROCESSING phase when last step is tool_result", () => {
    const s = makeSession({
      active: true,
      steps: [
        { type: "tool_call", content: "read_file", timestamp: Date.now() },
        { type: "tool_result", content: "result", timestamp: Date.now() },
      ],
    });
    const r = estimateProgress(s)!;
    expect(r.phase).toBe("PROCESSING");
    expect(r.pct).toBeGreaterThanOrEqual(25);
  });

  it("caps pct at 100 regardless of step count", () => {
    const steps = Array.from({ length: 50 }, (_, i) => ({
      type: "tool_call" as const,
      content: `tool${i}`,
      timestamp: Date.now(),
    }));
    const s = makeSession({ active: true, steps });
    const r = estimateProgress(s)!;
    expect(r.pct).toBeLessThanOrEqual(100);
  });

  it("returns null for inactive session with no steps", () => {
    const s = makeSession({ active: false, steps: [] });
    expect(estimateProgress(s)).toBeNull();
  });

  it("assumes WORKING for a recent subagent session that went inactive", () => {
    const s = makeSession({
      kind: "subagent",
      active: false,
      updatedAt: Date.now() - 60_000,
      steps: [{ type: "tool_call", content: "write_file", timestamp: Date.now() - 60_000 }],
    });
    const r = estimateProgress(s)!;
    expect(r.phase).toBe("WORKING");
  });
});
