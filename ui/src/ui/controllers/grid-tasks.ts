/**
 * Grid Tasks Controller
 * Real-time task tracking for sessions in the masonry grid.
 * Shows what each session is working on with progress and alerts.
 */

import type { GatewayBrowserClient } from "../gateway";

// ============================================================
// Types
// ============================================================

export interface GridTask {
  id: string;
  sessionKey: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "complete" | "error" | "blocked";
  progress: number; // 0-100
  phase?: string; // Current phase: "THINKING", "CODING", "TESTING", etc.
  startedAt?: number;
  completedAt?: number;
  error?: string;
  toolCalls: number;
  steps: TaskStep[];
  alerts: TaskAlert[];
}

export interface TaskStep {
  type: "tool_call" | "tool_result" | "thinking" | "text" | "spawn" | "error";
  timestamp: number;
  content: string;
  detail?: string;
}

export interface TaskAlert {
  id: string;
  type: "info" | "warning" | "error" | "success";
  message: string;
  timestamp: number;
  dismissed: boolean;
}

export interface GridTasksState {
  tasks: Map<string, GridTask>; // sessionKey -> task
  alerts: TaskAlert[];
  loading: boolean;
  pollIntervalId: number | null;
  pollInterval: number;
  lastPollAt: number | null;
}

// ============================================================
// Storage
// ============================================================

const STORAGE_KEY = "infinibot-grid-tasks";

function saveTasksToStorage(tasks: Map<string, GridTask>): void {
  try {
    const arr = Array.from(tasks.entries());
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now(), tasks: arr }));
  } catch {
    // Storage full or not available
  }
}

function loadTasksFromStorage(): Map<string, GridTask> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    // Discard if older than 1h
    if (parsed.ts && Date.now() - parsed.ts > 3600000) {
      localStorage.removeItem(STORAGE_KEY);
      return new Map();
    }
    return new Map(parsed.tasks || []);
  } catch {
    return new Map();
  }
}

// ============================================================
// State Factory
// ============================================================

export function createGridTasksState(): GridTasksState {
  return {
    tasks: loadTasksFromStorage(),
    alerts: [],
    loading: false,
    pollIntervalId: null,
    pollInterval: 5, // 5 seconds
    lastPollAt: null,
  };
}

// ============================================================
// Helpers
// ============================================================

function parseAgentId(key: string): { agentId: string; kind: "main" | "subagent" | "other" } {
  const parts = key.split(":");
  if (parts[0] === "agent") {
    const agentId = parts[1] || "unknown";
    const isSubagent = parts[2] === "subagent" || key.includes("subagent");
    return { agentId, kind: isSubagent ? "subagent" : agentId === "main" ? "main" : "other" };
  }
  return { agentId: "unknown", kind: "other" };
}

function estimateProgressFromSession(session: any): { phase: string; pct: number; status: GridTask["status"] } {
  const toolCalls = session.steps?.filter((s: any) => s.type === "tool_call").length || 0;
  const stepCount = session.steps?.length || 0;
  const lastStep = session.steps?.[session.steps.length - 1];
  const hasError = session.steps?.some((s: any) => s.type === "error");

  // Check completion
  if (!session.active && stepCount > 0) {
    return { phase: "COMPLETE", pct: 100, status: hasError ? "error" : "complete" };
  }
  if (!session.active && stepCount === 0) {
    return { phase: "IDLE", pct: 0, status: "pending" };
  }

  // Active session - estimate progress
  let phase = "WORKING";
  let pct = 10;

  if (stepCount === 0) {
    phase = "STARTING";
    pct = 5;
  } else if (lastStep?.type === "thinking") {
    phase = "THINKING";
    pct = Math.min(30 + toolCalls * 5, 80);
  } else if (lastStep?.type === "tool_call") {
    // Extract tool name for phase
    const toolName = lastStep.content?.toUpperCase() || "TOOL";
    const knownTools: Record<string, string> = {
      "READ": "READING",
      "WRITE": "WRITING",
      "EDIT": "EDITING",
      "EXEC": "EXECUTING",
      "WEB_SEARCH": "SEARCHING",
      "WEB_FETCH": "FETCHING",
      "BROWSER": "BROWSING",
      "KANBAN": "UPDATING",
    };
    phase = knownTools[toolName] || toolName;
    pct = Math.min(20 + toolCalls * 8, 90);
  } else if (lastStep?.type === "tool_result") {
    phase = "PROCESSING";
    pct = Math.min(25 + toolCalls * 8, 90);
  } else if (lastStep?.type === "text") {
    phase = "RESPONDING";
    pct = Math.min(50 + stepCount * 3, 95);
  }

  return { phase, pct, status: "in_progress" };
}

function previewItemsToSteps(items: any[]): TaskStep[] {
  const steps: TaskStep[] = [];
  for (const item of items) {
    if (!item) continue;
    const timestamp = item.ts || Date.now();
    const text = item.text || item.content || "";
    if (!text) continue;

    let type: TaskStep["type"] = "text";
    let content = text;
    let detail: string | undefined;

    if (item.role === "user") {
      type = "text";
    } else if (item.role === "tool" || item.role === "tool_result") {
      type = "tool_result";
    } else if (item.role === "assistant") {
      if (text.startsWith("⚡ ") || text.match(/^Tool: /)) {
        type = "tool_call";
        const match = text.match(/^(?:⚡|Tool:)\s*(\S+)\s*(.*)/s);
        if (match) {
          content = match[1];
          detail = match[2] || undefined;
        }
      } else {
        type = "text";
      }
    }

    steps.push({ type, timestamp, content, detail });
  }
  return steps;
}

// ============================================================
// API Functions
// ============================================================

export async function loadGridTasks(
  state: GridTasksState,
  client: GatewayBrowserClient,
  activeSessionKeys: string[]
): Promise<void> {
  if (!client || activeSessionKeys.length === 0) return;

  state.loading = true;

  try {
    // Get session info for all active sessions
    const res = await client.request("sessions.list", {
      activeMinutes: 1440, // Last 24h
      limit: 50,
      includeLastMessage: true,
      includeDerivedTitles: true,
    }) as any;

    if (!res?.sessions) {
      state.loading = false;
      return;
    }

    // Filter to only sessions we care about
    const relevantSessions = res.sessions.filter((s: any) => 
      activeSessionKeys.includes(s.key)
    );

    // Load previews for these sessions
    const previewRes = await client.request("sessions.preview", {
      keys: relevantSessions.map((s: any) => s.key),
      limit: 20,
      maxChars: 1500,
    }) as any;

    const previewMap = new Map<string, any>();
    if (previewRes?.previews) {
      for (const p of previewRes.previews) {
        if (p.status === "ok") previewMap.set(p.key, p);
      }
    }

    // Build task objects
    for (const session of relevantSessions) {
      const existingTask = state.tasks.get(session.key);
      const preview = previewMap.get(session.key);
      const steps = preview?.items ? previewItemsToSteps(preview.items) : existingTask?.steps || [];
      
      const { agentId, kind } = parseAgentId(session.key);
      const activeThresholdMs = kind === "subagent" ? 600000 : 120000;
      const isActive = session.updatedAt 
        ? (Date.now() - session.updatedAt) < activeThresholdMs 
        : false;

      const { phase, pct, status } = estimateProgressFromSession({
        ...session,
        steps,
        active: isActive,
      });

      // Detect task title - prefer label, then derivedTitle, then extract from messages
      let title = session.label || session.derivedTitle;
      
      // Clean up title if it looks like a session key
      if (!title || title.includes(":") || title.length > 80) {
        // Try to extract from first user message in preview
        const userMsg = preview?.items?.find((item: any) => 
          item.role === "user" && item.text && item.text.length > 5 && item.text.length < 100
        );
        if (userMsg?.text) {
          title = userMsg.text.slice(0, 60) + (userMsg.text.length > 60 ? "..." : "");
        } else {
          // Try session displayName as fallback
          title = session.displayName || `Session ${session.key.slice(-8)}`;
        }
      }
      
      // Also try lastMessagePreview for context
      if (title === session.displayName && session.lastMessagePreview) {
        const cleanPreview = session.lastMessagePreview.slice(0, 50);
        if (cleanPreview.length > 10) {
          title = cleanPreview + (session.lastMessagePreview.length > 50 ? "..." : "");
        }
      }

      // Count tool calls
      const toolCalls = steps.filter(s => s.type === "tool_call").length;

      // Build alerts
      const alerts: TaskAlert[] = existingTask?.alerts || [];
      const hasNewError = steps.some(s => s.type === "error");
      
      if (hasNewError && !alerts.some(a => a.type === "error" && !a.dismissed)) {
        alerts.push({
          id: `alert-${Date.now()}`,
          type: "error",
          message: "Task encountered an error",
          timestamp: Date.now(),
          dismissed: false,
        });
      }

      // Check for completion
      const wasInProgress = existingTask?.status === "in_progress";
      const isNowComplete = status === "complete";
      
      if (wasInProgress && isNowComplete && !alerts.some(a => a.type === "success" && !a.dismissed)) {
        alerts.push({
          id: `alert-${Date.now()}`,
          type: "success",
          message: "Task completed",
          timestamp: Date.now(),
          dismissed: false,
        });
      }

      const task: GridTask = {
        id: session.key,
        sessionKey: session.key,
        title,
        description: session.lastMessagePreview,
        status,
        progress: pct,
        phase,
        startedAt: existingTask?.startedAt || session.createdAt,
        completedAt: status === "complete" ? session.updatedAt : undefined,
        toolCalls,
        steps: steps.slice(-10), // Keep last 10 steps
        alerts: alerts.slice(-5), // Keep last 5 alerts
      };

      state.tasks.set(session.key, task);
    }

    // Clean up tasks for sessions no longer in grid
    for (const key of state.tasks.keys()) {
      if (!activeSessionKeys.includes(key)) {
        state.tasks.delete(key);
      }
    }

    state.lastPollAt = Date.now();
    saveTasksToStorage(state.tasks);
  } catch (e) {
    console.error("Failed to load grid tasks:", e);
  } finally {
    state.loading = false;
  }
}

export function startTaskPolling(
  state: GridTasksState,
  client: GatewayBrowserClient,
  getActiveSessionKeys: () => string[],
  onUpdate: () => void
): void {
  if (state.pollIntervalId) return;

  // Initial load
  void loadGridTasks(state, client, getActiveSessionKeys()).then(onUpdate);

  // Start polling
  state.pollIntervalId = window.setInterval(async () => {
    await loadGridTasks(state, client, getActiveSessionKeys());
    onUpdate();
  }, state.pollInterval * 1000);
}

export function stopTaskPolling(state: GridTasksState): void {
  if (state.pollIntervalId) {
    window.clearInterval(state.pollIntervalId);
    state.pollIntervalId = null;
  }
}

export function dismissAlert(state: GridTasksState, taskId: string, alertId: string): void {
  const task = state.tasks.get(taskId);
  if (task) {
    const alert = task.alerts.find(a => a.id === alertId);
    if (alert) alert.dismissed = true;
  }
}

export function getTasksForSessions(state: GridTasksState, sessionKeys: string[]): GridTask[] {
  return sessionKeys
    .map(key => state.tasks.get(key))
    .filter((t): t is GridTask => !!t)
    .sort((a, b) => {
      // Active tasks first, then by progress
      if (a.status === "in_progress" && b.status !== "in_progress") return -1;
      if (b.status === "in_progress" && a.status !== "in_progress") return 1;
      return b.progress - a.progress;
    });
}

export function getActiveAlerts(state: GridTasksState): TaskAlert[] {
  const allAlerts: TaskAlert[] = [];
  for (const task of state.tasks.values()) {
    for (const alert of task.alerts) {
      if (!alert.dismissed) {
        allAlerts.push(alert);
      }
    }
  }
  return allAlerts.sort((a, b) => b.timestamp - a.timestamp);
}

export function getTotalProgress(state: GridTasksState): number {
  const tasks = Array.from(state.tasks.values());
  if (tasks.length === 0) return 0;
  
  const sum = tasks.reduce((acc, t) => acc + t.progress, 0);
  return Math.round(sum / tasks.length);
}

export function getActiveTaskCount(state: GridTasksState): number {
  return Array.from(state.tasks.values()).filter(t => t.status === "in_progress").length;
}
