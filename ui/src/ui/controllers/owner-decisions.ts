import type { GatewayBrowserClient } from "../gateway";
import type { MeshAgent } from "../views/agent-ops/activity-map";

export type OwnerDecisionKind = "approval" | "run_input" | "run_owner" | "kanban_blocked";

export interface OwnerDecisionChoice {
  id: string;
  label: string;
  action: string;
  tone?: "primary" | "danger" | "neutral";
}

export interface OwnerDecision {
  id: string;
  kind: OwnerDecisionKind;
  title: string;
  question: string;
  context: string;
  risk?: string;
  createdAt: number;
  updatedAt: number;
  choices: OwnerDecisionChoice[];
  allowText: boolean;
  target: {
    runId?: string;
    sessionKey?: string;
    agentId?: string;
    taskId?: string;
    projectId?: string;
    approvalId?: string;
  };
  link: { label: string; href: string };
}

export interface OwnerDecisionList {
  decisions: OwnerDecision[];
  count: number;
  serverTime: number;
}

export async function loadOwnerDecisions(client: GatewayBrowserClient): Promise<OwnerDecisionList> {
  const result = await client.request<OwnerDecisionList>("owner.decisions.list", { limit: 200 });
  return {
    decisions: Array.isArray(result?.decisions) ? result.decisions : [],
    count: Number(result?.count) || 0,
    serverTime: Number(result?.serverTime) || Date.now(),
  };
}

function same(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a === b);
}

export function decisionMatchesAgent(decision: OwnerDecision, agent: MeshAgent): boolean {
  return (
    same(decision.target.runId, agent.runId) ||
    same(decision.target.sessionKey, agent.sessionKey) ||
    same(decision.target.agentId, agent.agentId) ||
    same(decision.target.taskId, agent.kanbanTaskId)
  );
}

export function decisionsForAgent(decisions: OwnerDecision[], agent: MeshAgent): OwnerDecision[] {
  return decisions.filter((decision) => decisionMatchesAgent(decision, agent));
}

async function resumeRun(
  client: GatewayBrowserClient,
  runId: string,
  note?: string,
): Promise<unknown> {
  try {
    return await client.request("verification.decide", { runId, action: "continue", note });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/use retry|no session id|cannot be resumed/i.test(message)) throw error;
    return await client.request("verification.decide", { runId, action: "retry", note });
  }
}

/** Keep the mesh's authoritative activity feed aligned with verification. */
async function markRunResumed(
  client: GatewayBrowserClient,
  decision: OwnerDecision,
): Promise<void> {
  if (!decision.target.runId || !decision.target.sessionKey) return;
  try {
    await client.request("subagents.progress", {
      runId: decision.target.runId,
      sessionKey: decision.target.sessionKey,
      status: "working",
      message: "Resumed by owner decision",
      notify: false,
    });
  } catch {
    // The verification continuation is already authoritative. Older gateways
    // may not expose the progress write; their next real agent event heals it.
  }
}

export async function resolveOwnerDecision(
  client: GatewayBrowserClient,
  decision: OwnerDecision,
  action: string,
  reply?: string,
): Promise<{ resumed: boolean; message: string }> {
  const note = reply?.trim() || undefined;
  if (decision.kind === "approval") {
    const approvalId = decision.target.approvalId;
    if (!approvalId) throw new Error("Approval id is missing.");
    const result = await client.request<{ ok?: boolean; error?: string }>("approvals.resolve", {
      id: approvalId,
      action,
      note,
    });
    if (result?.ok === false) throw new Error(result.error || "The approval could not be resolved.");
    return { resumed: action === "approve", message: action === "approve" ? "Approved and resumed" : "Denied" };
  }

  if (decision.kind === "run_input") {
    if (!note && !action) throw new Error("Write a reply or choose an option.");
    const response = note || action;
    // Active agents receive the answer immediately through their durable
    // inbox. A terminal needs_input run reports not_running, then the same
    // answer is supplied as the continuation note below.
    try {
      await client.request("subagents.message", {
        runId: decision.target.runId,
        childSessionKey: decision.target.sessionKey,
        message: response,
      });
    } catch {
      /* continuation below is authoritative for terminal runs */
    }
    if (!decision.target.runId) throw new Error("Run id is missing.");
    await resumeRun(client, decision.target.runId, response);
    await markRunResumed(client, decision);
    return { resumed: true, message: "Reply delivered — run resumed" };
  }

  if (decision.kind === "run_owner") {
    const runId = decision.target.runId;
    if (!runId) throw new Error("Run id is missing.");
    if (action === "continue" || action === "retry") {
      await resumeRun(client, runId, note);
      await markRunResumed(client, decision);
      return { resumed: true, message: "Run resumed" };
    }
    await client.request("verification.decide", { runId, action, note });
    return { resumed: false, message: action === "accept" ? "Accepted" : "Rejected" };
  }

  const taskId = decision.target.taskId;
  if (!taskId) throw new Error("Task id is missing.");
  await client.request("kanban.tasks.update", {
    id: taskId,
    patch: { status: "todo", autonomousStatus: "approved" },
    source: "ui",
  });
  if (decision.target.runId) {
    await resumeRun(client, decision.target.runId, note || "Owner unblocked the linked task.");
    await markRunResumed(client, decision);
  } else if (decision.target.sessionKey && note) {
    await client.request("subagents.message", {
      childSessionKey: decision.target.sessionKey,
      message: note,
    });
  }
  return { resumed: true, message: "Task unblocked" };
}

export const OWNER_DECISION_EVENTS = new Set([
  "approval.requested",
  "approval.resolved",
  "verification.completion",
  "review.message",
  "kanban:changed",
  "kanban.task.updated",
]);
