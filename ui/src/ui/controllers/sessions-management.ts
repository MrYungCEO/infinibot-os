/**
 * Sessions Management Controller
 * Track active agents, concurrent tasks, and project assignments
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { KanbanTask, TaskStatus } from "../types";

// ============================================================
// Types
// ============================================================

export interface ActiveAgent {
  id: string;
  name: string;
  status: "idle" | "active" | "busy" | "offline";
  currentTask?: {
    id: string;
    title: string;
    status: string;
  };
  currentProject?: {
    id: string;
    name: string;
  };
  sessionKey?: string;
  lastActivity?: string;
  taskCount: number;
  completedCount: number;
  cpuUsage?: number;
  memoryUsage?: number;
}

export interface SessionTaskSummary {
  total: number;
  completed: number;
  inProgress: number;
  todo: number;
  blocked: number;
  progressPercent: number;
  tasks: KanbanTask[];
}

export interface AgentTaskSummary {
  agentId: string;
  total: number;
  completed: number;
  inProgress: number;
  progressPercent: number;
  tasks: KanbanTask[];
}

export interface SessionInfo {
  key: string;
  agentId: string;
  agentName: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  tokenUsage: number;
  model: string;
  status: "active" | "idle" | "complete";
}

export interface AgentWorkload {
  agentId: string;
  totalConcurrent: number;
  queued: number;
  capacity: number;
  utilizationPercent: number;
}

// ============================================================
// State Management
// ============================================================

export async function loadActiveSessions(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<SessionInfo[]> {
  try {
    // RPC name is `sessions.list` (`sessions_list` is the MCP tool name).
    // The payload is `{ sessions, count, ... }`, not an ok/result envelope.
    const res = await client.request<{ sessions?: any[] }>("sessions.list", {
      limit: 100,
      includeGlobal: false,
    });

    const sessions = res?.sessions ?? [];
    return sessions.map((s: any) => ({
      key: s.key,
      agentId: extractAgentId(s.key),
      agentName: s.agentId || "Unknown",
      createdAt: s.createdAt || new Date().toISOString(),
      lastActivity: s.lastActivity || new Date().toISOString(),
      messageCount: s.messageCount || 0,
      tokenUsage: s.tokenUsage || 0,
      model: s.model || "default",
      status: "active" as const,
    }));
  } catch (err) {
    console.error("Failed to load sessions:", err);
    return [];
  }
}

function extractAgentId(sessionKey: string): string {
  // Format: agent:main:main or agent:coder:task:123
  const parts = sessionKey.split(":");
  return parts[1] || "unknown";
}

export async function getAgentWorkload(
  agentId: string,
  sessions: SessionInfo[]
): Promise<AgentWorkload> {
  const agentSessions = sessions.filter((s) => s.agentId === agentId);

  return {
    agentId,
    totalConcurrent: agentSessions.length,
    queued: 0, // Would come from task queue
    capacity: 4, // Default from config
    utilizationPercent: (agentSessions.length / 4) * 100,
  };
}

export async function createNewSession(
  state: AppViewState,
  agentId?: string,
  initialMessage?: string
): Promise<string | null> {
  if (!state.client) return null;

  try {
    // Use provided agent or current
    const targetAgent = agentId || state.assistantAgentId || "main";

    // Set session key
    const newSessionKey = `agent:${targetAgent}:${Date.now()}`;
    state.sessionKey = newSessionKey;

    if (initialMessage) {
      // Send first message to new session
      await state.handleSendChat(initialMessage);
    }

    return newSessionKey;
  } catch (err) {
    console.error("Failed to create session:", err);
    return null;
  }
}

export async function switchToSession(
  state: AppViewState,
  sessionKey: string
): Promise<void> {
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  state.chatRunId = null;
  state.chatQueue = [];
  state.resetToolStream?.();
  state.resetChatScroll?.();

  // Load history for new session
  const { loadChatHistory } = await import("./chat");
  await loadChatHistory(state);
}

export async function getAgentSessions(
  agentId: string,
  sessions: SessionInfo[]
): Promise<SessionInfo[]> {
  return sessions.filter((s) => s.agentId === agentId);
}

export async function getSessionStats(
  sessions: SessionInfo[]
): Promise<{
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  totalTokens: number;
  agentStats: Record<string, { sessions: number; messages: number; tokens: number }>;
}> {
  const stats = {
    totalSessions: sessions.length,
    activeSessions: sessions.filter((s) => s.status === "active").length,
    totalMessages: sessions.reduce((sum, s) => sum + s.messageCount, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.tokenUsage, 0),
    agentStats: {} as Record<
      string,
      { sessions: number; messages: number; tokens: number }
    >,
  };

  for (const session of sessions) {
    const agentId = session.agentId;
    if (!stats.agentStats[agentId]) {
      stats.agentStats[agentId] = {
        sessions: 0,
        messages: 0,
        tokens: 0,
      };
    }
    stats.agentStats[agentId].sessions += 1;
    stats.agentStats[agentId].messages += session.messageCount;
    stats.agentStats[agentId].tokens += session.tokenUsage;
  }

  return stats;
}

// ============================================================
// Task Integration
// ============================================================

/** Load all kanban tasks */
export async function loadKanbanTasks(
  client: GatewayBrowserClient
): Promise<KanbanTask[]> {
  try {
    // `kanban` is the MCP *tool* name; the RPC is `kanban.tasks.list`, and it
    // resolves with a BARE array of tasks (no ok/result envelope).
    const res = await client.request<any>("kanban.tasks.list", {});
    if (Array.isArray(res)) return res as KanbanTask[];
    return (res?.tasks as KanbanTask[]) ?? [];
  } catch (err) {
    console.error("Failed to load kanban tasks:", err);
    return [];
  }
}

/** Get task summary for a specific agent */
export function getAgentTaskSummary(
  agentId: string,
  tasks: KanbanTask[]
): AgentTaskSummary {
  // Match tasks where assignee matches agent id (case-insensitive)
  const agentTasks = tasks.filter((t) => {
    const assignee = (t.assignee || t.assignedAgent || "").toLowerCase();
    return assignee === agentId.toLowerCase() || 
           assignee.includes(agentId.toLowerCase());
  });

  const completed = agentTasks.filter((t) => t.status === "done").length;
  const inProgress = agentTasks.filter((t) => t.status === "in_progress").length;
  const total = agentTasks.length;
  const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    agentId,
    total,
    completed,
    inProgress,
    progressPercent,
    tasks: agentTasks,
  };
}

/** Get task summary for a session (by session key or agent) */
export function getSessionTaskSummary(
  sessionKey: string,
  tasks: KanbanTask[]
): SessionTaskSummary {
  // Extract agent from session key
  const agentId = extractAgentId(sessionKey);
  
  // Match tasks by agent or session reference
  const sessionTasks = tasks.filter((t) => {
    const assignee = (t.assignee || t.assignedAgent || "").toLowerCase();
    const desc = (t.description || "").toLowerCase();
    return assignee === agentId.toLowerCase() ||
           assignee.includes(agentId.toLowerCase()) ||
           desc.includes(sessionKey);
  });

  const completed = sessionTasks.filter((t) => t.status === "done").length;
  const inProgress = sessionTasks.filter((t) => t.status === "in_progress").length;
  const todo = sessionTasks.filter((t) => t.status === "todo" || t.status === "backlog").length;
  const blocked = sessionTasks.filter((t) => t.status === "review").length;
  const total = sessionTasks.length;
  const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    total,
    completed,
    inProgress,
    todo,
    blocked,
    progressPercent,
    tasks: sessionTasks,
  };
}

/** Get all tasks grouped by agent */
export function getTasksByAgent(
  tasks: KanbanTask[]
): Map<string, KanbanTask[]> {
  const map = new Map<string, KanbanTask[]>();
  
  for (const task of tasks) {
    const agent = (task.assignee || task.assignedAgent || "unassigned").toLowerCase();
    if (!map.has(agent)) {
      map.set(agent, []);
    }
    map.get(agent)!.push(task);
  }
  
  return map;
}

/** Sort tasks by status priority */
export function sortTasksByStatus(tasks: KanbanTask[]): KanbanTask[] {
  const statusOrder: Record<TaskStatus, number> = {
    in_progress: 0,
    review: 1,
    todo: 2,
    backlog: 3,
    done: 4,
  };
  
  return [...tasks].sort((a, b) => {
    return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
  });
}
