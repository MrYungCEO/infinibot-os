/**
 * Federation Resources Controller
 *
 * Manages cross-node resource sharing:
 * - Shared projects and tasks
 * - Shared business databases
 * - Shared MCP servers
 * - Cross-node agent coordination
 */

import type { GatewayBrowserClient } from "../gateway";
import type { FederationNode, NodeCapabilities } from "./federation";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export type ResourceType = "projects" | "tasks" | "agents" | "mcp" | "business";
export type SyncStatus = "synced" | "pending" | "conflict" | "error" | "offline";

/** Shared project across federation */
export interface SharedProject {
  id: string;
  name: string;
  description?: string;
  sourceNode: string;
  sharedWith: string[];
  status: string;
  lastSync: number;
  syncStatus: SyncStatus;
  taskCount?: number;
  notionId?: string;
}

/** Shared task across federation */
export interface SharedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  projectId?: string;
  projectName?: string;
  sourceNode: string;
  assignedNode?: string;
  assignedAgent?: string;
  lastSync: number;
  syncStatus: SyncStatus;
  notionId?: string;
}

/** MCP server available in federation */
export interface FederatedMCP {
  id: string;
  name: string;
  description?: string;
  nodeId: string;
  nodeName: string;
  status: "running" | "stopped" | "error" | "unknown" | "configured";
  tools: string[];
  sharedToFederation: boolean;
  lastSeen: number;
  /** Source of the MCP config (claude, cline, infinibot, custom) */
  source?: "claude" | "cline" | "infinibot" | "custom";
  /** MCP server config (command, args, etc.) */
  config?: {
    command?: string;
    args?: string[];
  };
}

/** Agent available across federation */
export interface FederatedAgent {
  id: string;
  name?: string;
  nodeId: string;
  nodeName: string;
  status: "active" | "idle" | "busy" | "offline";
  specialties?: string[];
  currentTask?: string;
  activeSessions: number;
  lastSeen: number;
  isDefault?: boolean;
}

/** Business data source in federation */
export interface FederatedBusinessSource {
  id: string;
  type: "income" | "expenses" | "clients" | "leads" | "analytics";
  name: string;
  nodeId: string;
  nodeName: string;
  sharedToFederation: boolean;
  lastSync: number;
  recordCount?: number;
  status: SyncStatus;
}

/** Node gateway info with full access details */
export interface NodeGatewayInfo {
  nodeId: string;
  nodeName: string;
  gatewayUrl: string;
  gatewayPort: number;
  wsUrl?: string;
  httpUrl?: string;
  connected: boolean;
  latency?: number;
  version?: string;
  capabilities: NodeCapabilities;
  agents: string[];
  mcpServers: string[];
  lastSeen: number;
}

/** Resource sync conflict */
export interface ResourceConflict {
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  localValue: unknown;
  remoteValue: unknown;
  localNode: string;
  remoteNode: string;
  timestamp: number;
}

/** Federation resources state */
export interface FederationResourcesState {
  loading: boolean;
  error: string | null;

  // Node gateways
  nodeGateways: NodeGatewayInfo[];
  selectedNodeId: string | null;

  // Shared resources
  projects: SharedProject[];
  tasks: SharedTask[];
  agents: FederatedAgent[];
  mcpServers: FederatedMCP[];
  businessSources: FederatedBusinessSource[];

  // Sync state
  syncInProgress: boolean;
  lastFullSync: number | null;
  conflicts: ResourceConflict[];

  // UI state
  activeTab: "overview" | "gateways" | "projects" | "tasks" | "agents" | "mcp" | "business";
  resourceFilter: {
    nodeId?: string;
    status?: string;
    search?: string;
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Initial State
// ══════════════════════════════════════════════════════════════════════════════

export function createFederationResourcesState(): FederationResourcesState {
  return {
    loading: false,
    error: null,
    nodeGateways: [],
    selectedNodeId: null,
    projects: [],
    tasks: [],
    agents: [],
    mcpServers: [],
    businessSources: [],
    syncInProgress: false,
    lastFullSync: null,
    conflicts: [],
    activeTab: "overview",
    resourceFilter: {},
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Load Functions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Load all federation resources
 */
export async function loadFederationResources(
  client: GatewayBrowserClient | null,
  state: FederationResourcesState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client || state.loading) return;

  state.loading = true;
  state.error = null;
  requestUpdate?.();

  try {
    // Load in parallel
    const [gateways, projects, tasks, agents, mcps, business] = await Promise.all([
      loadNodeGateways(client),
      loadSharedProjects(client),
      loadSharedTasks(client),
      loadFederatedAgents(client),
      loadFederatedMCPs(client),
      loadBusinessSources(client),
    ]);

    state.nodeGateways = gateways;
    state.projects = projects;
    state.tasks = tasks;
    state.agents = agents;
    state.mcpServers = mcps;
    state.businessSources = business;
    state.lastFullSync = Date.now();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    requestUpdate?.();
  }
}

/**
 * Load node gateway information
 */
async function loadNodeGateways(client: GatewayBrowserClient): Promise<NodeGatewayInfo[]> {
  try {
    // Get both mobile nodes AND federation nodes
    const [mobileRes, fedRes] = await Promise.all([
      client.request<{ nodes?: Array<Record<string, unknown>> }>("node.list", {}).catch(() => null),
      client.request<{ nodes?: Array<Record<string, unknown>> }>("federation.nodes.list", {}).catch(() => null),
    ]);
    
    // Combine both sources, deduplicating by nodeId
    const mobileNodes = (mobileRes?.nodes ?? []).map(n => ({ ...n, source: "mobile" }));
    const fedNodes = (fedRes?.nodes ?? []).map(n => ({ ...n, source: "federation" }));
    const seenIds = new Set<string>();
    const nodes: Array<Record<string, unknown>> = [];
    
    // Federation nodes first (they have richer info)
    for (const node of fedNodes) {
      const id = String(node.id || node.nodeId || "");
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        nodes.push(node);
      }
    }
    // Then mobile nodes
    for (const node of mobileNodes) {
      const id = String(node.id || node.nodeId || "");
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        nodes.push(node);
      }
    }
    const gateways: NodeGatewayInfo[] = [];

    for (const node of nodes) {
      const nodeId = String(node.nodeId || node.id || "");
      if (!nodeId) continue;

      // Try to get detailed gateway info
      let gatewayInfo: Record<string, unknown> = {};
      try {
        const infoRes = await client.request<{ info?: Record<string, unknown> }>(
          "federation.node.gateway",
          { nodeId }
        );
        gatewayInfo = infoRes?.info ?? {};
      } catch {
        // Node might not support this endpoint
      }

      const capabilities: NodeCapabilities = {};
      if (node.capabilities && typeof node.capabilities === "object") {
        const caps = node.capabilities as Record<string, unknown>;
        capabilities.hasOllama = Boolean(caps.hasOllama);
        capabilities.hasComfyUI = Boolean(caps.hasComfyUI);
        capabilities.hasVoice = Boolean(caps.hasVoice);
        capabilities.gpu = typeof caps.gpu === "string" ? caps.gpu : undefined;
        capabilities.mcpServers = Array.isArray(caps.mcpServers) ? caps.mcpServers : [];
        capabilities.agents = Array.isArray(caps.agents) ? caps.agents : [];
      }

      // Determine connected status from various fields
      const isConnected = Boolean(
        node.connected || 
        node.status === "online" || 
        node.status === "registered" ||
        node.isLocal
      );

      gateways.push({
        nodeId,
        nodeName: String(node.displayName || node.name || nodeId),
        gatewayUrl: String(gatewayInfo.url || node.remoteIp || ""),
        gatewayPort: typeof gatewayInfo.port === "number" ? gatewayInfo.port : 
                     typeof node.port === "number" ? node.port : 18789,
        wsUrl: typeof gatewayInfo.wsUrl === "string" ? gatewayInfo.wsUrl : undefined,
        httpUrl: typeof gatewayInfo.httpUrl === "string" ? gatewayInfo.httpUrl : undefined,
        connected: isConnected,
        latency: typeof node.latency === "number" ? node.latency : undefined,
        version: typeof node.version === "string" ? (node.version as string) : 
                 typeof node.capabilities === "object" && (node.capabilities as Record<string,unknown>)?.version 
                   ? String((node.capabilities as Record<string,unknown>).version) 
                   : undefined,
        capabilities,
        agents: capabilities.agents ?? [],
        mcpServers: capabilities.mcpServers ?? [],
        lastSeen: typeof node.lastSeen === "number" ? node.lastSeen : Date.now(),
      });
    }

    return gateways;
  } catch {
    return [];
  }
}

/**
 * Load shared projects across federation
 */
async function loadSharedProjects(client: GatewayBrowserClient): Promise<SharedProject[]> {
  try {
    const res = await client.request<{ projects?: Array<Record<string, unknown>> }>(
      "federation.resources.projects",
      {}
    );

    return (res?.projects ?? []).map((p) => ({
      id: String(p.id || ""),
      name: String(p.name || "Untitled"),
      description: typeof p.description === "string" ? p.description : undefined,
      sourceNode: String(p.sourceNode || "local"),
      sharedWith: Array.isArray(p.sharedWith) ? p.sharedWith.map(String) : [],
      status: String(p.status || "active"),
      lastSync: typeof p.lastSync === "number" ? p.lastSync : Date.now(),
      syncStatus: parseSyncStatus(p.syncStatus),
      taskCount: typeof p.taskCount === "number" ? p.taskCount : undefined,
      notionId: typeof p.notionId === "string" ? p.notionId : undefined,
    }));
  } catch {
    // Fallback: try local kanban
    try {
      const res = await client.request<{ projects?: Array<Record<string, unknown>> }>(
        "kanban.list",
        { type: "projects" }
      );
      return (res?.projects ?? []).map((p) => ({
        id: String(p.id || ""),
        name: String(p.name || "Untitled"),
        description: typeof p.description === "string" ? p.description : undefined,
        sourceNode: "local",
        sharedWith: [],
        status: String(p.status || "active"),
        lastSync: Date.now(),
        syncStatus: "synced" as SyncStatus,
        taskCount: typeof p.taskCount === "number" ? p.taskCount : undefined,
        notionId: typeof p.notionId === "string" ? p.notionId : undefined,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Load shared tasks across federation
 */
async function loadSharedTasks(client: GatewayBrowserClient): Promise<SharedTask[]> {
  try {
    const res = await client.request<{ tasks?: Array<Record<string, unknown>> }>(
      "federation.resources.tasks",
      {}
    );

    return (res?.tasks ?? []).map((t) => ({
      id: String(t.id || ""),
      title: String(t.title || "Untitled"),
      status: String(t.status || "todo"),
      priority: String(t.priority || "medium"),
      projectId: typeof t.projectId === "string" ? t.projectId : undefined,
      projectName: typeof t.projectName === "string" ? t.projectName : undefined,
      sourceNode: String(t.sourceNode || "local"),
      assignedNode: typeof t.assignedNode === "string" ? t.assignedNode : undefined,
      assignedAgent: typeof t.assignedAgent === "string" ? t.assignedAgent : undefined,
      lastSync: typeof t.lastSync === "number" ? t.lastSync : Date.now(),
      syncStatus: parseSyncStatus(t.syncStatus),
      notionId: typeof t.notionId === "string" ? t.notionId : undefined,
    }));
  } catch {
    // Fallback: try local kanban
    try {
      const res = await client.request<{ tasks?: Array<Record<string, unknown>> }>(
        "kanban.list",
        { type: "tasks" }
      );
      return (res?.tasks ?? []).map((t) => ({
        id: String(t.id || ""),
        title: String(t.title || "Untitled"),
        status: String(t.status || "todo"),
        priority: String(t.priority || "medium"),
        projectId: typeof t.projectId === "string" ? t.projectId : undefined,
        projectName: typeof t.projectName === "string" ? t.projectName : undefined,
        sourceNode: "local",
        assignedNode: undefined,
        assignedAgent: typeof t.assignee === "string" ? t.assignee : undefined,
        lastSync: Date.now(),
        syncStatus: "synced" as SyncStatus,
        notionId: typeof t.notionId === "string" ? t.notionId : undefined,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Load federated agents
 */
async function loadFederatedAgents(client: GatewayBrowserClient): Promise<FederatedAgent[]> {
  try {
    const res = await client.request<{ agents?: Array<Record<string, unknown>> }>(
      "federation.resources.agents",
      {}
    );

    return (res?.agents ?? []).map((a) => ({
      id: String(a.id || ""),
      name: typeof a.name === "string" ? a.name : undefined,
      nodeId: String(a.nodeId || "local"),
      nodeName: String(a.nodeName || "Local"),
      status: parseAgentStatus(a.status),
      specialties: Array.isArray(a.specialties) ? a.specialties.map(String) : undefined,
      currentTask: typeof a.currentTask === "string" ? a.currentTask : undefined,
      activeSessions: typeof a.activeSessions === "number" ? a.activeSessions : 0,
      lastSeen: typeof a.lastSeen === "number" ? a.lastSeen : Date.now(),
      isDefault: Boolean(a.isDefault),
    }));
  } catch {
    // Fallback: get local agents
    try {
      // Served name is `config.get`; `gateway:config.get` never existed.
      const res = await client.request<{ config?: Record<string, unknown> }>(
        "config.get",
        {}
      );
      const agents = (res?.config?.agents as Record<string, unknown>)?.list;
      if (!Array.isArray(agents)) return [];

      return agents.map((a: unknown) => {
        const agent = a as Record<string, unknown>;
        return {
          id: String(agent.id || "main"),
          name: typeof agent.name === "string" ? agent.name : undefined,
          nodeId: "local",
          nodeName: "This Node",
          status: "idle" as const,
          specialties: undefined,
          currentTask: undefined,
          activeSessions: 0,
          lastSeen: Date.now(),
          isDefault: Boolean(agent.default),
        };
      });
    } catch {
      return [];
    }
  }
}

/**
 * Load federated MCP servers
 */
async function loadFederatedMCPs(client: GatewayBrowserClient): Promise<FederatedMCP[]> {
  try {
    const res = await client.request<{ servers?: Array<Record<string, unknown>> }>(
      "federation.resources.mcp",
      {}
    );

    return (res?.servers ?? []).map((m) => ({
      id: String(m.id || ""),
      name: String(m.name || "Unknown"),
      description: typeof m.description === "string" ? m.description : undefined,
      nodeId: String(m.nodeId || "local"),
      nodeName: String(m.nodeName || "Local"),
      status: parseMCPStatus(m.status),
      tools: Array.isArray(m.tools) ? m.tools.map(String) : [],
      sharedToFederation: Boolean(m.sharedToFederation ?? true),
      lastSeen: typeof m.lastSeen === "number" ? m.lastSeen : Date.now(),
    }));
  } catch {
    // Fallback: get local MCP config
    try {
      const res = await client.request<{ config?: Record<string, unknown> }>(
        "config.get",
        {}
      );
      const mcpConfig = res?.config?.mcp as Record<string, unknown> | undefined;
      const servers = mcpConfig?.servers as Record<string, unknown> | undefined;

      if (!servers || typeof servers !== "object") return [];

      return Object.entries(servers).map(([name, config]) => {
        const serverConfig = config as Record<string, unknown>;
        return {
          id: name,
          name,
          description: typeof serverConfig.description === "string" ? serverConfig.description : undefined,
          nodeId: "local",
          nodeName: "This Node",
          status: "unknown" as const,
          tools: [],
          sharedToFederation: true,
          lastSeen: Date.now(),
        };
      });
    } catch {
      return [];
    }
  }
}

/**
 * Load business data sources
 */
async function loadBusinessSources(client: GatewayBrowserClient): Promise<FederatedBusinessSource[]> {
  try {
    const res = await client.request<{ sources?: Array<Record<string, unknown>> }>(
      "federation.resources.business",
      {}
    );

    return (res?.sources ?? []).map((s) => ({
      id: String(s.id || ""),
      type: parseBusinessType(s.type),
      name: String(s.name || "Unknown"),
      nodeId: String(s.nodeId || "local"),
      nodeName: String(s.nodeName || "Local"),
      sharedToFederation: Boolean(s.sharedToFederation ?? true),
      lastSync: typeof s.lastSync === "number" ? s.lastSync : Date.now(),
      recordCount: typeof s.recordCount === "number" ? s.recordCount : undefined,
      status: parseSyncStatus(s.status),
    }));
  } catch {
    // Return default local business sources
    return [
      {
        id: "local-income",
        type: "income",
        name: "Income Streams",
        nodeId: "local",
        nodeName: "This Node",
        sharedToFederation: true,
        lastSync: Date.now(),
        status: "synced",
      },
    ];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Sync Functions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Sync all resources across federation
 */
export async function syncFederationResources(
  client: GatewayBrowserClient | null,
  state: FederationResourcesState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client || state.syncInProgress) return;

  state.syncInProgress = true;
  state.error = null;
  requestUpdate?.();

  try {
    await client.request("federation.sync", { full: true });
    await loadFederationResources(client, state, requestUpdate);
    state.conflicts = [];
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.syncInProgress = false;
    requestUpdate?.();
  }
}

/**
 * Share a project to federation
 */
export async function shareProjectToFederation(
  client: GatewayBrowserClient | null,
  projectId: string,
  targetNodes: string[],
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  try {
    await client.request("federation.share.project", {
      projectId,
      targetNodes,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Assign a task to a specific node/agent
 */
export async function assignTaskToNode(
  client: GatewayBrowserClient | null,
  taskId: string,
  nodeId: string,
  agentId?: string,
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  try {
    await client.request("federation.assign.task", {
      taskId,
      nodeId,
      agentId,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Share MCP server to federation
 */
export async function shareMCPToFederation(
  client: GatewayBrowserClient | null,
  mcpId: string,
  share: boolean,
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  try {
    await client.request("federation.share.mcp", {
      mcpId,
      share,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Connect to a specific node's gateway directly
 */
export async function connectToNodeGateway(
  client: GatewayBrowserClient | null,
  nodeId: string,
  state: FederationResourcesState,
  requestUpdate?: () => void
): Promise<{ wsUrl: string } | null> {
  if (!client) return null;

  try {
    // federation.node.gateway resolves the node's reachable gateway endpoint
    // from the hub. (The old `federation.node.connect` was never served, and
    // there is no credential-minting RPC — remote calls go through
    // `federation.node.invoke`, which is already authenticated by this
    // connection, so no per-node token is needed.)
    const res = await client.request<{
      info?: { hostname?: string; port?: number; connected?: boolean };
    }>("federation.node.gateway", { nodeId });

    const info = res?.info;
    if (info?.hostname && info.connected) {
      const wsUrl = `ws://${info.hostname}:${info.port ?? 18789}`;
      state.selectedNodeId = nodeId;
      requestUpdate?.();
      return { wsUrl };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Invoke a method on a remote node's gateway
 */
export async function invokeOnNodeGateway(
  client: GatewayBrowserClient | null,
  nodeId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (!client) throw new Error("No client");

  return await client.request("federation.node.invoke", {
    nodeId,
    method,
    params,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// UI State Functions
// ══════════════════════════════════════════════════════════════════════════════

export function setActiveTab(
  state: FederationResourcesState,
  tab: FederationResourcesState["activeTab"],
  requestUpdate?: () => void
): void {
  state.activeTab = tab;
  requestUpdate?.();
}

export function setResourceFilter(
  state: FederationResourcesState,
  filter: Partial<FederationResourcesState["resourceFilter"]>,
  requestUpdate?: () => void
): void {
  state.resourceFilter = { ...state.resourceFilter, ...filter };
  requestUpdate?.();
}

export function selectNode(
  state: FederationResourcesState,
  nodeId: string | null,
  requestUpdate?: () => void
): void {
  state.selectedNodeId = nodeId;
  requestUpdate?.();
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function parseSyncStatus(value: unknown): SyncStatus {
  if (value === "synced" || value === "pending" || value === "conflict" || value === "error" || value === "offline") {
    return value;
  }
  return "synced";
}

function parseAgentStatus(value: unknown): "active" | "idle" | "busy" | "offline" {
  if (value === "active" || value === "idle" || value === "busy" || value === "offline") {
    return value;
  }
  return "idle";
}

function parseMCPStatus(value: unknown): "running" | "stopped" | "error" | "unknown" {
  if (value === "running" || value === "stopped" || value === "error" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function parseBusinessType(value: unknown): FederatedBusinessSource["type"] {
  if (value === "income" || value === "expenses" || value === "clients" || value === "leads" || value === "analytics") {
    return value;
  }
  return "income";
}

// ══════════════════════════════════════════════════════════════════════════════
// Computed Getters
// ══════════════════════════════════════════════════════════════════════════════

export function getResourceStats(state: FederationResourcesState) {
  return {
    totalNodes: state.nodeGateways.length,
    onlineNodes: state.nodeGateways.filter((n) => n.connected).length,
    totalProjects: state.projects.length,
    sharedProjects: state.projects.filter((p) => p.sharedWith.length > 0).length,
    totalTasks: state.tasks.length,
    pendingTasks: state.tasks.filter((t) => t.status === "todo" || t.status === "in_progress").length,
    totalAgents: state.agents.length,
    activeAgents: state.agents.filter((a) => a.status === "active" || a.status === "busy").length,
    totalMCPs: state.mcpServers.length,
    runningMCPs: state.mcpServers.filter((m) => m.status === "running").length,
    conflicts: state.conflicts.length,
  };
}

export function getFilteredResources<T extends { sourceNode?: string; nodeId?: string }>(
  resources: T[],
  filter: FederationResourcesState["resourceFilter"]
): T[] {
  return resources.filter((r) => {
    if (filter.nodeId) {
      const nodeId = ("sourceNode" in r ? r.sourceNode : r.nodeId) ?? "";
      if (nodeId !== filter.nodeId) return false;
    }
    return true;
  });
}

export function getNodesWithResource(
  state: FederationResourcesState,
  resourceType: ResourceType
): NodeGatewayInfo[] {
  switch (resourceType) {
    case "agents":
      return state.nodeGateways.filter((n) => n.agents.length > 0);
    case "mcp":
      return state.nodeGateways.filter((n) => n.mcpServers.length > 0);
    default:
      return state.nodeGateways;
  }
}
