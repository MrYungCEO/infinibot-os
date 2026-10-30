import { describe, expect, it } from "vitest";

import type { MeshAgent } from "../views/agent-ops/activity-map";
import { settleResumedOwnerDecisionAgent } from "./agency-world-viz-owner-decision-state";

describe("agency-world-viz owner decision card settlement", () => {
  it("settles a blocked card to WORKING with a temporary RESUMED state", () => {
    const now = Date.parse("2026-10-16T08:00:00.000Z");
    const agent = {
      sessionKey: "agent:one",
      agentId: "coder",
      label: "Rollout planner",
      nodeId: "local",
      status: "blocked",
      progress: 60,
      activityLabel: "Waiting for owner",
      lastUpdateAt: 1,
      lastActivityAt: 1,
    } satisfies MeshAgent;
    const resumedAgents = new Map<string, number>();

    expect(settleResumedOwnerDecisionAgent(agent, resumedAgents, now)).toBe(true);
    expect(agent).toMatchObject({
      status: "working",
      activityLabel: "Resumed by owner decision",
      lastUpdateAt: now,
      lastActivityAt: now,
    });
    expect(resumedAgents.get(agent.sessionKey)).toBe(now + 10_000);
  });

  it("does not create a resumed marker when no matching card exists", () => {
    const resumedAgents = new Map<string, number>();
    expect(settleResumedOwnerDecisionAgent(undefined, resumedAgents, 1)).toBe(false);
    expect(resumedAgents).toEqual(new Map());
  });
});
