import { describe, expect, it, vi } from "vitest";

import type { GatewayBrowserClient } from "../gateway";
import type { MeshAgent } from "../views/agent-ops/activity-map";
import {
  decisionMatchesAgent,
  resolveOwnerDecision,
  type OwnerDecision,
} from "./owner-decisions";

function decision(overrides: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: "run:r1",
    kind: "run_input",
    title: "Need input",
    question: "Choose a region",
    context: "The rollout is waiting.",
    createdAt: 1,
    updatedAt: 2,
    choices: [],
    allowText: true,
    target: { runId: "r1", sessionKey: "agent:one" },
    link: { label: "Open run", href: "#/mesh?run=r1" },
    ...overrides,
  };
}

describe("mesh owner decisions", () => {
  it("matches decisions to a card through run, session, agent, or task", () => {
    const agent = { runId: "r1", sessionKey: "agent:one", agentId: "coder", kanbanTaskId: "t1" } as MeshAgent;
    expect(decisionMatchesAgent(decision(), agent)).toBe(true);
    expect(decisionMatchesAgent(decision({ target: { taskId: "t1" } }), agent)).toBe(true);
    expect(decisionMatchesAgent(decision({ target: { runId: "other" } }), agent)).toBe(false);
  });

  it("delivers a needs_input reply and resumes the run", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const client = { request } as unknown as GatewayBrowserClient;

    await expect(resolveOwnerDecision(client, decision(), "reply", "Asia first")).resolves.toEqual({
      resumed: true,
      message: "Reply delivered — run resumed",
    });
    expect(request).toHaveBeenNthCalledWith(1, "subagents.message", {
      runId: "r1",
      childSessionKey: "agent:one",
      message: "Asia first",
    });
    expect(request).toHaveBeenNthCalledWith(2, "verification.decide", {
      runId: "r1",
      action: "continue",
      note: "Asia first",
    });
    expect(request).toHaveBeenNthCalledWith(3, "subagents.progress", {
      runId: "r1",
      sessionKey: "agent:one",
      status: "working",
      message: "Resumed by owner decision",
      notify: false,
    });
  });

  it("resolves an approval through the existing approval API", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const client = { request } as unknown as GatewayBrowserClient;
    const approval = decision({
      id: "approval:a1",
      kind: "approval",
      target: { approvalId: "a1", runId: "r1" },
    });

    await expect(resolveOwnerDecision(client, approval, "approve", "Proceed")).resolves.toMatchObject({ resumed: true });
    expect(request).toHaveBeenCalledWith("approvals.resolve", { id: "a1", action: "approve", note: "Proceed" });
  });
});
