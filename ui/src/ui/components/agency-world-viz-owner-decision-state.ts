import type { MeshAgent } from "../views/agent-ops/activity-map";

/** Apply the immediate card state shown after an owner answer resumes a run. */
export function settleResumedOwnerDecisionAgent(
  agent: MeshAgent | undefined,
  resumedAgents: Map<string, number>,
  now = Date.now(),
): boolean {
  if (!agent) return false;
  agent.status = "working";
  agent.activityLabel = "Resumed by owner decision";
  agent.lastUpdateAt = now;
  agent.lastActivityAt = now;
  resumedAgents.set(agent.sessionKey, now + 10_000);
  return true;
}
