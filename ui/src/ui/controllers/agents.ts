// ============================================================
// InfiniBot Agent Management — Controller (State + API)
// ============================================================
// Manages agent state via GatewayBrowserClient.request() calls,
// following the same pattern as skills.ts controller.

import type { GatewayBrowserClient } from "../gateway";

// ---------- Types ----------

export type AgentStatus = "running" | "idle" | "error" | "paused" | "archived";
export type AgentType = "main" | "sub";

export interface AgentEntry {
  id: string;
  name: string;
  description: string;
  type: AgentType;
  status: AgentStatus;
  model: string;
  provider: string;
  reasoning: "on" | "off" | "auto";
  systemPrompt: string;
  parentId: string | null;
  createdAt: string;
  lastActive: string;
  sessions: number;
  pendingTasks: number;
  cpuUsage: number;
  memoryUsage: number;
  maxConcurrent: number;
  taskQueueSize: number;
  tags: string[];
  protocol: AgentProtocol;
  metrics: AgentMetrics;
  promptVersions: PromptVersion[];
}

export interface AgentProtocol {
  id: string;
  name: string;
  inputHandling: "strict" | "flexible" | "permissive";
  toolStrategy: "conservative" | "balanced" | "aggressive";
  errorHandling: "retry" | "escalate" | "fallback" | "abort";
  maxToolCalls: number;
  timeoutMs: number;
  thinkingEnabled: boolean;
  thinkingBudget: "low" | "medium" | "high";
  allowedTools: string[];
  retryCount: number;
  nodes: ProtocolNode[];
}

export interface ProtocolNode {
  id: string;
  type: "start" | "process" | "decision" | "tool" | "end" | "error";
  label: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
  connections: string[];
}

export interface AgentMetrics {
  totalTasks: number;
  successRate: number;
  avgResponseTime: number;
  tokenUsage: number;
  estimatedCost: number;
  responseTimes: number[];
  taskHistory: TaskRecord[];
}

export interface TaskRecord {
  id: string;
  timestamp: string;
  type: string;
  status: "success" | "error" | "timeout";
  duration: number;
  tokens: number;
  toolCalls: number;
  error?: string;
}

export interface PromptVersion {
  id: string;
  content: string;
  timestamp: string;
  label: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  category: "role-based" | "task-based" | "custom";
  content: string;
  description: string;
}

export interface SubAgentSpawnRequest {
  task: string;
  model: string;
  systemPrompt: string;
  maxRuntimeMs: number;
  parentId: string;
}

// ---------- Agent Message Map ----------

export type AgentMessage = {
  kind: "success" | "error";
  message: string;
};

export type AgentMessageMap = Record<string, AgentMessage>;

// ---------- State ----------

export type AgentsManagerState = {
  client: GatewayBrowserClient | null;
  connected: boolean;

  // List / loading
  agentsMgmtLoading: boolean;
  agentsMgmtError: string | null;
  agentsMgmtList: AgentEntry[];

  // Filters
  agentsSearch: string;
  agentsStatusFilter: string;
  agentsTypeFilter: string;
  agentsModelFilter: string;
  agentsSortField: string;
  agentsSortDir: "asc" | "desc";

  // Selection & detail
  agentsSelectedId: string | null;
  agentsDetailTab: "info" | "prompt" | "protocol" | "subagents" | "perf";

  // Edit state
  agentsEditDraft: Partial<AgentEntry> | null;
  agentsShowCreateForm: boolean;
  agentsShowCloneForm: boolean;
  agentsCloneSourceId: string | null;

  // Prompt editor
  agentsPromptDraft: string;
  agentsPromptShowTemplates: boolean;
  agentsPromptTemplates: PromptTemplate[];

  // Protocol editor
  agentsProtocolTab: "settings" | "flow";

  // Sub-agent spawn
  agentsSpawnTask: string;
  agentsSpawnModel: string;
  agentsSpawnPrompt: string;

  // Per-agent messages
  agentsMessages: AgentMessageMap;
  agentsBusyId: string | null;

  // Logs
  agentsLogs: string[];
};

// ---------- Helpers ----------

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function setAgentMessage(state: AgentsManagerState, id: string, msg?: AgentMessage) {
  const next = { ...state.agentsMessages };
  if (msg) next[id] = msg;
  else delete next[id];
  state.agentsMessages = next;
}

// ---------- Defaults for locally drafted agents ----------

const MODELS = [
  { id: "claude-opus-4", provider: "anthropic" },
  { id: "claude-sonnet-4", provider: "anthropic" },
  { id: "claude-haiku-3.5", provider: "anthropic" },
  { id: "gpt-4.1", provider: "openai" },
  { id: "o3", provider: "openai" },
  { id: "gemini-2.5-pro", provider: "google" },
  { id: "deepseek-r1", provider: "deepseek" },
];

const TOOLS_LIST = [
  "web_search", "web_fetch", "browser", "exec", "read", "write", "edit",
  "canvas", "nodes", "message", "image", "tts", "process",
];

const PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: "pt1", name: "Helpful Assistant", category: "role-based", content: "You are a helpful, harmless, and honest AI assistant.", description: "General-purpose assistant" },
  { id: "pt2", name: "Code Expert", category: "role-based", content: "You are an expert software engineer. Write clean, efficient code.", description: "Programming specialist" },
  { id: "pt3", name: "Research Agent", category: "task-based", content: "Search the web, compile findings, and produce structured reports.", description: "Web research agent" },
  { id: "pt4", name: "Customer Support", category: "role-based", content: "You are a friendly customer support agent. Resolve issues efficiently.", description: "Support representative" },
  { id: "pt5", name: "Data Analyst", category: "task-based", content: "Analyze datasets, identify trends, and provide actionable insights.", description: "Data analysis" },
];

function generateId(): string {
  return "agt_" + Math.random().toString(36).substr(2, 12);
}

export function createAgentsManagerState(): Omit<AgentsManagerState, "client" | "connected"> {
  return {
    agentsMgmtLoading: false,
    agentsMgmtError: null,
    agentsMgmtList: [],
    agentsSearch: "",
    agentsStatusFilter: "all",
    agentsTypeFilter: "all",
    agentsModelFilter: "all",
    agentsSortField: "name",
    agentsSortDir: "asc",
    agentsSelectedId: null,
    agentsDetailTab: "info",
    agentsEditDraft: null,
    agentsShowCreateForm: false,
    agentsShowCloneForm: false,
    agentsCloneSourceId: null,
    agentsPromptDraft: "",
    agentsPromptShowTemplates: false,
    agentsPromptTemplates: PROMPT_TEMPLATES,
    agentsProtocolTab: "settings",
    agentsSpawnTask: "",
    agentsSpawnModel: "claude-sonnet-4",
    agentsSpawnPrompt: "",
    agentsMessages: {},
    agentsBusyId: null,
    agentsLogs: [],
  };
}

// ---------- API calls ----------

export async function loadAgentsMgmt(state: AgentsManagerState) {
  if (state.agentsMgmtLoading) return;
  state.agentsMgmtLoading = true;
  state.agentsMgmtError = null;
  try {
    if (state.client && state.connected) {
      const res = await state.client.request("agents.management.list", {});
      state.agentsMgmtList = res && Array.isArray((res as any).agents) ? (res as any).agents : [];
      return;
    }
    // Not connected: show nothing rather than invented agents.
    state.agentsMgmtList = [];
  } catch (err) {
    // Surface the failure; never seed mock agents (they fed wake-word sync).
    state.agentsMgmtList = [];
    state.agentsMgmtError = getErrorMessage(err);
  } finally {
    state.agentsMgmtLoading = false;
  }
}

export async function updateAgentMgmt(state: AgentsManagerState, id: string, data: Partial<AgentEntry>) {
  state.agentsBusyId = id;
  try {
    if (state.client && state.connected) {
      try {
        await state.client.request("agents.management.update", { id, ...data });
        await loadAgentsMgmt(state);
        setAgentMessage(state, id, { kind: "success", message: "Agent updated" });
        return;
      } catch { /* fallback to local */ }
    }
    // Local update
    const idx = state.agentsMgmtList.findIndex((a) => a.id === id);
    if (idx >= 0) {
      state.agentsMgmtList = [...state.agentsMgmtList];
      state.agentsMgmtList[idx] = { ...state.agentsMgmtList[idx], ...data, lastActive: new Date().toISOString() };
      if (data.systemPrompt && data.systemPrompt !== state.agentsMgmtList[idx].systemPrompt) {
        state.agentsMgmtList[idx].promptVersions = [
          ...state.agentsMgmtList[idx].promptVersions,
          { id: "v" + Date.now(), content: data.systemPrompt, timestamp: new Date().toISOString(), label: "Update" },
        ];
      }
    }
    setAgentMessage(state, id, { kind: "success", message: "Agent updated" });
  } catch (err) {
    setAgentMessage(state, id, { kind: "error", message: getErrorMessage(err) });
  } finally {
    state.agentsBusyId = null;
  }
}

export async function createAgentMgmt(state: AgentsManagerState, data: Partial<AgentEntry>) {
  state.agentsBusyId = "_new";
  try {
    const now = new Date().toISOString();
    const newAgent: AgentEntry = {
      id: generateId(),
      name: data.name || "New Agent",
      description: data.description || "",
      type: data.type || "sub",
      status: "idle",
      model: data.model || "claude-sonnet-4",
      provider: MODELS.find((m) => m.id === (data.model || "claude-sonnet-4"))?.provider || "anthropic",
      reasoning: data.reasoning || "auto",
      systemPrompt: data.systemPrompt || "",
      parentId: data.parentId || "agt_main_001",
      createdAt: now,
      lastActive: now,
      sessions: 0,
      pendingTasks: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      maxConcurrent: data.maxConcurrent || 3,
      taskQueueSize: data.taskQueueSize || 10,
      tags: data.tags || [],
      protocol: data.protocol || {
        id: generateId(), name: "Default", inputHandling: "flexible", toolStrategy: "balanced",
        errorHandling: "retry", maxToolCalls: 20, timeoutMs: 60000, thinkingEnabled: true,
        thinkingBudget: "medium", allowedTools: [...TOOLS_LIST], retryCount: 3, nodes: [],
      },
      metrics: { totalTasks: 0, successRate: 0, avgResponseTime: 0, tokenUsage: 0, estimatedCost: 0, responseTimes: [], taskHistory: [] },
      promptVersions: data.systemPrompt ? [{ id: "v1", content: data.systemPrompt, timestamp: now, label: "Initial" }] : [],
    };
    state.agentsMgmtList = [...state.agentsMgmtList, newAgent];
    state.agentsShowCreateForm = false;
    state.agentsEditDraft = null;
    setAgentMessage(state, newAgent.id, { kind: "success", message: "Agent created" });
  } catch (err) {
    state.agentsMgmtError = getErrorMessage(err);
  } finally {
    state.agentsBusyId = null;
  }
}

export async function deleteAgentMgmt(state: AgentsManagerState, id: string) {
  state.agentsBusyId = id;
  try {
    state.agentsMgmtList = state.agentsMgmtList.filter((a) => a.id !== id);
    if (state.agentsSelectedId === id) state.agentsSelectedId = null;
    setAgentMessage(state, id, { kind: "success", message: "Agent deleted" });
  } catch (err) {
    setAgentMessage(state, id, { kind: "error", message: getErrorMessage(err) });
  } finally {
    state.agentsBusyId = null;
  }
}

export async function cloneAgentMgmt(state: AgentsManagerState, sourceId: string, newName: string) {
  const source = state.agentsMgmtList.find((a) => a.id === sourceId);
  if (!source) return;
  await createAgentMgmt(state, { ...source, name: newName, status: "idle" });
  state.agentsShowCloneForm = false;
  state.agentsCloneSourceId = null;
}

export async function spawnSubAgent(state: AgentsManagerState, req: SubAgentSpawnRequest) {
  await createAgentMgmt(state, {
    name: "Sub: " + req.task.slice(0, 30),
    description: req.task,
    type: "sub",
    model: req.model,
    systemPrompt: req.systemPrompt,
    parentId: req.parentId,
  });
  state.agentsSpawnTask = "";
  state.agentsSpawnModel = "claude-sonnet-4";
  state.agentsSpawnPrompt = "";
}

export async function pauseAgentMgmt(state: AgentsManagerState, id: string) {
  await updateAgentMgmt(state, id, { status: "paused" });
}

export async function resumeAgentMgmt(state: AgentsManagerState, id: string) {
  await updateAgentMgmt(state, id, { status: "running" });
}

export async function killAgentMgmt(state: AgentsManagerState, id: string) {
  await updateAgentMgmt(state, id, { status: "archived" });
}

// ---------- Filtering & sorting ----------

export function getFilteredAgents(state: AgentsManagerState): AgentEntry[] {
  let list = [...state.agentsMgmtList];

  // Status filter
  if (state.agentsStatusFilter !== "all") {
    list = list.filter((a) => a.status === state.agentsStatusFilter);
  } else {
    list = list.filter((a) => a.status !== "archived");
  }

  // Type filter
  if (state.agentsTypeFilter !== "all") {
    list = list.filter((a) => a.type === state.agentsTypeFilter);
  }

  // Model filter
  if (state.agentsModelFilter !== "all") {
    list = list.filter((a) => a.model === state.agentsModelFilter);
  }

  // Search
  if (state.agentsSearch.trim()) {
    const q = state.agentsSearch.toLowerCase();
    list = list.filter(
      (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
    );
  }

  // Sort
  const dir = state.agentsSortDir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    const field = state.agentsSortField as keyof AgentEntry;
    const va = a[field];
    const vb = b[field];
    if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * dir;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return 0;
  });

  return list;
}

export function getUniqueModels(state: AgentsManagerState): string[] {
  const models = new Set(state.agentsMgmtList.map((a) => a.model));
  return [...models].sort();
}
