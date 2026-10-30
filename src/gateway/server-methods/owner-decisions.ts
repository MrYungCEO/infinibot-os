/**
 * Unified read model for every decision that currently needs the owner.
 *
 * This is deliberately a thin aggregator. Resolution stays with the owning
 * subsystem (`approvals.resolve`, `verification.decide`,
 * `subagents.message`, and `kanban.tasks.update`) so there is still only one
 * source of truth for each decision.
 */

import { listApprovalRequests, type ApprovalRecord } from "../../autonomy/approval-registry.js";
import { getSubagentRunByKanbanTaskId } from "../../agents/subagent-registry.js";
import { getSubagentHistoryEntryByKanbanTaskId } from "../../agents/subagent-history.js";
import { getReviewThread, type ReviewThreadSummary } from "../../verification/review-thread.js";
import {
  listRecords,
  type CompletionRecord,
  type CompletionState,
} from "../../verification/store.js";
import { kanbanHandlers } from "./kanban.js";
import type { GatewayRequestHandlers } from "./types.js";

export const OWNER_DECISIONS_READ_METHODS = ["owner.decisions.list"] as const;

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

const WAITING_STATES: CompletionState[] = ["needs_input", "needs_owner", "blocked"];
const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function clip(value: unknown, max = 1200): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function approvalRunId(record: ApprovalRecord): string | undefined {
  return record.requester.runId ?? record.sourceRef?.runId;
}

export function decisionFromApproval(record: ApprovalRecord): OwnerDecision {
  const runId = approvalRunId(record);
  return {
    id: `approval:${record.id}`,
    kind: "approval",
    title: record.title,
    question: clip(record.summary || record.title, 600),
    context: clip(record.details || record.context, 1600),
    risk: record.risk,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    choices: [
      { id: "approve", label: "Approve", action: "approve", tone: "primary" },
      { id: "deny", label: "Deny", action: "deny", tone: "danger" },
    ],
    allowText: record.options.includes("approve-with-note") || record.options.includes("redirect"),
    target: {
      approvalId: record.id,
      ...(runId ? { runId } : {}),
      ...(record.requester.sessionKey ? { sessionKey: record.requester.sessionKey } : {}),
      ...(record.requester.agentId ? { agentId: record.requester.agentId } : {}),
    },
    link: runId
      ? { label: "Open run", href: `#/mesh?run=${encodeURIComponent(runId)}` }
      : {
          label: "Open approval",
          href: `#/autonomy?view=approvals&approval=${encodeURIComponent(record.id)}`,
        },
  };
}

function runQuestion(record: CompletionRecord, thread: ReviewThreadSummary | undefined): string {
  return clip(
    thread?.escalation?.decision ??
      record.result?.open_issues?.[0] ??
      record.review?.reasons?.[0] ??
      record.result?.summary ??
      record.task,
    900,
  );
}

/**
 * The completion contract keeps owner prompts in `open_issues`. Agents
 * commonly put choices either after the first question or on `Options:` /
 * bulleted lines in that first item. Preserve those choices as one-tap
 * replies while always retaining the free-text escape hatch.
 */
export function runInputOptions(record: CompletionRecord): string[] {
  const issues = record.result?.open_issues ?? [];
  const inline = issues[0]?.match(/(?:options?|choices?)\s*:\s*(.+)$/i)?.[1];
  const candidates = inline ? inline.split(/\s*(?:\||;|,\s+(?=[A-Z0-9]))\s*/) : issues.slice(1);
  return candidates
    .map((value) => clip(value.replace(/^[-*\d.)\s]+/, ""), 160))
    .filter(Boolean)
    .filter((value, index, rows) => rows.indexOf(value) === index)
    .slice(0, 6);
}

export function decisionFromCompletion(
  record: CompletionRecord,
  thread?: ReviewThreadSummary,
): OwnerDecision {
  const input = record.state === "needs_input";
  const choices: OwnerDecisionChoice[] = input
    ? runInputOptions(record).map((option, index) => ({
        id: `option-${index + 1}`,
        label: option,
        action: option,
        tone: index === 0 ? "primary" : "neutral",
      }))
    : [
        { id: "continue", label: "Continue", action: "continue", tone: "primary" },
        { id: "accept", label: "Accept as-is", action: "accept", tone: "neutral" },
        { id: "reject", label: "Reject", action: "reject", tone: "danger" },
      ];
  return {
    id: `run:${record.runId}`,
    kind: input ? "run_input" : "run_owner",
    title: record.label || "Agent run",
    question: runQuestion(record, thread),
    context: clip(
      thread?.escalation?.reason ??
        record.result?.summary ??
        record.review?.reasons?.slice(0, 3).join(" · ") ??
        record.task,
      1600,
    ),
    createdAt: record.startedAt,
    updatedAt: record.updatedAt,
    choices,
    allowText: input || record.state === "blocked",
    target: { runId: record.runId, sessionKey: record.childSessionKey },
    link: { label: "Open run", href: `#/mesh?run=${encodeURIComponent(record.runId)}` },
  };
}

type TaskRow = Record<string, unknown>;

function textField(task: TaskRow, key: string): string {
  return typeof task[key] === "string" ? String(task[key]) : "";
}

function linkedRun(taskId: string): { runId: string; childSessionKey?: string } | undefined {
  const live = getSubagentRunByKanbanTaskId(taskId);
  if (live) return live;
  const archived = getSubagentHistoryEntryByKanbanTaskId(taskId);
  return archived
    ? { runId: archived.runId, childSessionKey: archived.childSessionKey }
    : undefined;
}

export function decisionFromBlockedTask(task: TaskRow): OwnerDecision | null {
  const taskId = textField(task, "id");
  const title = textField(task, "title");
  if (!taskId || !title) return null;
  const run = linkedRun(taskId);
  const assigned = textField(task, "assignedAgent") || textField(task, "delegatedTo");
  const context = clip(textField(task, "description") || textField(task, "content"), 1600);
  const updatedAt = Number(task.updatedAt) || Number(task.createdAt) || Date.now();
  return {
    id: `task:${taskId}`,
    kind: "kanban_blocked",
    title,
    question:
      context || `This task is blocked in Review and needs your decision before work can continue.`,
    context: context
      ? `Blocked kanban task · ${context}`
      : "Blocked kanban task waiting on the owner.",
    createdAt: Number(task.createdAt) || updatedAt,
    updatedAt,
    choices: [{ id: "unblock", label: "Unblock", action: "unblock", tone: "primary" }],
    allowText: true,
    target: {
      taskId,
      ...(textField(task, "projectId") ? { projectId: textField(task, "projectId") } : {}),
      ...(run?.runId ? { runId: run.runId } : {}),
      ...(run?.childSessionKey
        ? { sessionKey: run.childSessionKey }
        : assigned
          ? { sessionKey: assigned }
          : {}),
    },
    link: { label: "Open task", href: `#/projects?task=${encodeURIComponent(taskId)}` },
  };
}

async function listKanbanTasks(): Promise<TaskRow[]> {
  const handler = kanbanHandlers["kanban.tasks.list"];
  if (!handler) return [];
  return await new Promise<TaskRow[]>((resolve) => {
    const respond = (ok: boolean, payload?: unknown) => {
      if (!ok) return resolve([]);
      const rows = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { tasks?: unknown[] } | undefined)?.tasks)
          ? (payload as { tasks: unknown[] }).tasks
          : [];
      resolve(rows.filter((row): row is TaskRow => Boolean(row && typeof row === "object")));
    };
    Promise.resolve(
      handler({
        req: {
          type: "req",
          id: `owner-decisions-${Date.now()}`,
          method: "kanban.tasks.list",
          params: {},
        } as never,
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond: respond as never,
        context: undefined as never,
      }),
    ).catch(() => resolve([]));
  });
}

export async function listOwnerDecisions(limit = 100): Promise<OwnerDecision[]> {
  const approvals = listApprovalRequests({ status: "pending", limit }).map(decisionFromApproval);
  const records = listRecords({ states: WAITING_STATES, limit });
  const runDecisions = records.map((record) => {
    const thread = getReviewThread(record.runId)?.summary;
    return decisionFromCompletion(record, thread);
  });
  const runIds = new Set(runDecisions.map((d) => d.target.runId).filter(Boolean));
  const tasks = await listKanbanTasks();
  const taskDecisions = tasks
    .filter(
      (task) =>
        textField(task, "status").toLowerCase() === "review" &&
        textField(task, "autonomousStatus").toLowerCase() === "blocked",
    )
    .map(decisionFromBlockedTask)
    .filter((decision): decision is OwnerDecision => Boolean(decision))
    // Verification is the richer decision for a run-linked task. Avoid two
    // badges for the same owner question while still listing standalone tasks.
    .filter((decision) => !decision.target.runId || !runIds.has(decision.target.runId));

  return [...approvals, ...runDecisions, ...taskDecisions]
    .sort((a, b) => {
      const risk = (RISK_ORDER[a.risk ?? ""] ?? 9) - (RISK_ORDER[b.risk ?? ""] ?? 9);
      return risk || b.updatedAt - a.updatedAt;
    })
    .slice(0, Math.max(1, Math.min(limit, 250)));
}

export const ownerDecisionsHandlers: GatewayRequestHandlers = {
  "owner.decisions.list": async ({ params, respond }) => {
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.min(250, Math.floor(params.limit)))
        : 100;
    try {
      const decisions = await listOwnerDecisions(limit);
      respond(true, { decisions, count: decisions.length, serverTime: Date.now() });
    } catch (error) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
