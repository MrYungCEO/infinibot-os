import { describe, expect, it } from "vitest";

import { ageLabel, buildHoverExtras, roleOf } from "./agent-hover-extras";
import type { MeshAgent } from "./activity-map";

const NOW = 1_800_000_000_000;

function agent(patch: Partial<MeshAgent> = {}): MeshAgent {
  return {
    sessionKey: "agent:main:subagent:abc",
    agentId: "main",
    label: "UI fix",
    nodeId: "local",
    status: "working",
    progress: 40,
    ...patch,
  };
}

describe("hover extras", () => {
  it("roles and ages", () => {
    expect(roleOf(agent()).role).toBe("Sub-agent");
    expect(roleOf(agent({ coderBackend: "codex" })).role).toBe("Coder sub-agent");
    expect(roleOf(agent({ sessionKey: "agent:main:main" })).role).toBe("main · main session");
    expect(ageLabel(NOW - 2000, NOW)).toBe("just now");
    expect(ageLabel(NOW - 42_000, NOW)).toBe("42s ago");
    expect(ageLabel(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(ageLabel(undefined, NOW)).toBe("");
  });

  it("lineage, files and placeholders without review data", () => {
    const parent = agent({ sessionKey: "agent:main:main", label: "Main" });
    const me = agent({ parent: "agent:main:main", filesTouchedCount: 3, kanbanTaskId: "t1", lastActivityAt: NOW - 10_000 });
    const kid = agent({ sessionKey: "agent:main:subagent:kid", parent: me.sessionKey });
    const x = buildHoverExtras(me, { now: NOW, agents: [parent, me, kid] });
    expect(x.parent).toBe("Main");
    expect(x.children).toBe(1);
    expect(x.files).toBe("3");
    expect(x.commits).toBe("—");
    expect(x.verdict).toBe("—");
    expect(x.latest).toBeNull();
    expect(x.kanbanTaskId).toBe("t1");
    expect(x.activityAge).toBe("10s ago");
    expect(x.running).toBe(true);
  });

  it("verdict + latest review message + attempt/round from the thread and record", () => {
    const x = buildHoverExtras(agent({ status: "completed" }), {
      now: NOW,
      thread: {
        summary: { verdict: "VERIFIED", rounds: 2, escalated: false, state: "verified" } as never,
        messages: [
          { kind: "submission", title: "RESULT", seq: 1 } as never,
          { kind: "verdict", verdict: "VERIFIED", title: "VERIFIED: ok", seq: 2 } as never,
        ],
      },
      record: { runId: "r", state: "verified", attempts: [{}, {}], result: { commits: ["a", "b"], files_changed: ["x"] } },
    });
    expect(x.verdict).toBe("Verified");
    expect(x.attemptRound).toBe("A2 · R2");
    expect(x.latest?.title).toBe("VERIFIED: ok");
    expect(x.latest?.kind).toBe("Verified");
    expect(x.commits).toBe("2");
    expect(x.files).toBe("1");
    expect(x.running).toBe(false);
  });

  it("falls back to the completion record verdict, then escalation", () => {
    expect(buildHoverExtras(agent(), { now: NOW, record: { runId: "r", state: "failed" } }).verdict).toBe("Failed");
    const esc = buildHoverExtras(agent(), {
      now: NOW,
      thread: { summary: { verdict: null, escalated: true, rounds: 1, state: "needs_owner" } as never, messages: [] },
    });
    expect(esc.verdict).toBe("Owner decision");
  });
});
