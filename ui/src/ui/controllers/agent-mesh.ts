/**
 * Agent Mesh Controller
 * State management and WebSocket communication for Agent Operations Center
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════

export interface MeshNode {
  id: string;
  name: string;
  role: 'hub' | 'satellite' | 'local';
  status: 'online' | 'offline' | 'connecting';
  agentCount: number;
  capabilities?: string[];
  lastSeen?: number;
  /** Externally-reachable federation WebSocket URL for this node, e.g. ws://100.x.x.x:47913/federation. Null when the node hasn't advertised one. */
  url?: string | null;
  /** Raw gatewayUrl the node advertised in its manifest (may differ from `url` on older nodes). */
  gatewayUrl?: string | null;
  connectedAt?: number;
  load?: number;
  activeSessions?: number;
  isLocal?: boolean;
}

export interface MeshAgent {
  sessionKey: string;
  agentId: string;
  label: string;
  nodeId: string;
  nodeName: string;
  status: 'starting' | 'idle' | 'working' | 'blocked' | 'finishing' | 'completed' | 'failed';
  progress: number;
  currentTask?: string;
  parent?: string;
  children?: string[];
  capabilities?: string[];
  spawnedAt: number;
  lastActivity: number;
  messageCount: number;
  // Last tool the agent invoked (drives Agency World zone choice)
  lastActivityKind?: string;
  lastActivityLabel?: string;
  // Token usage
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  /**
   * Coarse role on the mesh. "orchestrator" = a session that drives work and
   * delegates (UI-spawned Claude terminals, MCP-connected 3rd-party AIs).
   * "agent" = the worker side (CLI sub-agents, autonomy runs). The isometric
   * map and mesh sidebar use this to badge orchestrators distinctly from
   * the agents they spawn.
   */
  role?: 'orchestrator' | 'agent';
  /** Channel of origin (e.g. "mcp", "voice", "webchat"). Drives orchestrator detection. */
  channel?: string;
  /** Friendly origin surface label (e.g. "claude-code", "cursor", "claude-desktop"). */
  originSurface?: string;
  /** Coder backend if known — drives provider-specific avatars / logos. */
  coderBackend?: 'claude-code' | 'opencode' | 'codex' | 'gemini' | 'grok';
}

export interface MeshMessage {
  id: string;
  from: string;
  fromLabel?: string;
  to: string;
  toLabel?: string;
  type: 'request' | 'response' | 'broadcast' | 'event';
  payload?: {
    action?: string;
    message?: string;
    data?: Record<string, unknown>;
  };
  timestamp: number;
  delivered: boolean;
  read: boolean;
}

export interface MCPServer {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error';
  toolCount: number;
  nodeId?: string;
  uptime?: number;
}

export interface KanbanTask {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  agentSessionKey?: string;
  priority: string;
  projectId?: string;
}

export interface AgentMeshState {
  // Core data
  nodes: Map<string, MeshNode>;
  agents: Map<string, MeshAgent>;
  messages: MeshMessage[];
  mcpServers: MCPServer[];
  tasks: KanbanTask[];

  // UI state
  loading: boolean;
  error: string | null;
  connected: boolean;
  selectedAgentKey: string | null;
  selectedNodeId: string | null;
  activeTab: 'agents' | 'nodes' | 'mcps' | 'tasks';
  showSpawnDialog: boolean;

  // Stats
  stats: {
    totalAgents: number;
    activeAgents: number;
    totalNodes: number;
    onlineNodes: number;
    totalMessages: number;
    messagesPerMinute: number;
  };

  // Filters
  filterAgentStatus: string | null;
  filterNodeId: string | null;
  searchQuery: string;
}

// ════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ════════════════════════════════════════════════════════════════

let meshState: AgentMeshState = {
  nodes: new Map(),
  agents: new Map(),
  messages: [],
  mcpServers: [],
  tasks: [],

  loading: false,
  error: null,
  connected: false,
  selectedAgentKey: null,
  selectedNodeId: null,
  activeTab: 'agents',
  showSpawnDialog: false,

  stats: {
    totalAgents: 0,
    activeAgents: 0,
    totalNodes: 0,
    onlineNodes: 0,
    totalMessages: 0,
    messagesPerMinute: 0,
  },

  filterAgentStatus: null,
  filterNodeId: null,
  searchQuery: '',
};

let eventUnsubscribe: (() => void) | null = null;

export function getMeshState(): AgentMeshState {
  return meshState;
}

export function updateMeshState(partial: Partial<AgentMeshState>): void {
  meshState = { ...meshState, ...partial };
}

// ════════════════════════════════════════════════════════════════
// DATA LOADING
// ════════════════════════════════════════════════════════════════

export async function loadMeshStatus(
  client: GatewayBrowserClient,
  state: AppViewState
): Promise<void> {
  updateMeshState({ loading: true, error: null });

  try {
    // Load nodes from federation
    await loadNodes(client);

    // Load agents from sessions
    await loadAgents(client);

    // Load MCP servers
    await loadMCPServers(client);

    // Load recent kanban tasks
    await loadTasks(client);

    // Calculate stats
    updateStats();

    updateMeshState({ loading: false, connected: true });
    state.requestUpdate?.();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to load mesh status';
    updateMeshState({ loading: false, error: errorMsg });
    state.requestUpdate?.();
  }
}

async function loadNodes(client: GatewayBrowserClient): Promise<void> {
  try {
    // federation.status only returns {role, connected, nodeCount, nodes:[{id,name,state}]}
    // — no per-node URL/capabilities/connectedAt. federation.nodes.list is the
    // richer endpoint (also used by the Terminals/Grid device pickers) that
    // carries the reachable URL and capabilities the side panel needs.
    const res = await client.request('federation.nodes.list', {}) as any;
    const nodes = new Map<string, MeshNode>();

    if (res?.success && Array.isArray(res.nodes)) {
      for (const n of res.nodes) {
        const role: MeshNode['role'] = n.isLocal ? 'hub' : 'satellite';
        const status: MeshNode['status'] =
          n.status === 'online' ? 'online' : n.status === 'connecting' ? 'connecting' : 'offline';
        nodes.set(n.id, {
          id: n.id,
          name: n.name || n.id,
          role,
          status,
          agentCount: 0,
          capabilities: Array.isArray(n.capabilities)
            ? n.capabilities
            : n.capabilities
              ? Object.keys(n.capabilities)
              : [],
          lastSeen: n.lastSeen,
          url: n.url ?? null,
          gatewayUrl: n.gatewayUrl ?? null,
          connectedAt: n.connectedAt,
          load: n.load,
          activeSessions: n.activeSessions,
          isLocal: !!n.isLocal,
        });
      }
    }

    if (nodes.size === 0) {
      // Fallback if no federation
      nodes.set('local', {
        id: 'local',
        name: 'Local Gateway',
        role: 'hub',
        status: 'online',
        agentCount: 0,
        isLocal: true,
      });
    }

    updateMeshState({ nodes });
  } catch (err) {
    console.warn('Failed to load federation nodes:', err);
    // Add fallback local node
    const nodes = new Map<string, MeshNode>();
    nodes.set('local', {
      id: 'local',
      name: 'Local Gateway',
      role: 'hub',
      status: 'online',
      agentCount: 0,
      isLocal: true,
    });
    updateMeshState({ nodes });
  }
}

async function loadAgents(client: GatewayBrowserClient): Promise<void> {
  try {
    // Fetch sessions + subagents in parallel. Subagents carry the rich
    // per-tool activity needed by Agency World to choose work zones.
    const [sessionsRes, subagentsRes] = await Promise.all([
      // includeUnknown stays false (those rows are gateway-internal scratch
      // entries with no agentId, no value on the map). Everything else —
      // MCP-connected orchestrators, UI-spawned Claude terminals, group
      // sessions, autonomy runs — is surfaced. The user expects every live
      // gateway session to appear on the isometric map, not just sub-agents.
      client.request('sessions.list', {
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: true,
        includeFederated: true,
        limit: 200,
      }) as Promise<any>,
      client
        .request('subagents.list', { includeCompleted: false, limit: 100, compact: true })
        .catch(() => ({ subagents: [] })) as Promise<any>,
    ]);

    const rows = sessionsRes?.rows || sessionsRes?.sessions || [];
    const subagents: any[] = Array.isArray(subagentsRes?.subagents)
      ? subagentsRes.subagents
      : Array.isArray(subagentsRes?.items)
        ? subagentsRes.items
        : Array.isArray(subagentsRes)
          ? subagentsRes
          : [];

    // Index subagents by sessionKey for merge
    const saByKey = new Map<string, any>();
    for (const sa of subagents) {
      const key = sa.sessionKey || sa.childSessionKey || sa.runId;
      if (key) saByKey.set(key, sa);
    }

    const agents = new Map<string, MeshAgent>();
    const nodeCounts = new Map<string, number>();

    for (const row of rows) {
      // Skip only the gateway's internal control rows. Everything else maps
      // to a sprite on the isometric map: sub-agents, autonomy parents,
      // group/channel sessions, voice sessions, and MCP-connected
      // orchestrators (Claude Desktop, Cursor, Codex CLI, …) that auto-
      // registered through agent.tools.list. The legacy filter (only
      // kind==='main'|'subagent') dropped MCP and group rows on the floor;
      // the user explicitly asked to see all of them.
      const key: string = row.key || '';
      if (!key || key === 'global' || key === 'unknown') continue;

      const keyParts = key.split(':');
      const agentId = keyParts[1] || 'unknown';
      const nodeId = row.nodeId || 'local';
      const sa = saByKey.get(row.key);

      // Detect orchestrator origin: MCP channel, MCP provider, or a session
      // whose origin surface looks like a third-party AI client. The auto-
      // register path in src/gateway/server-methods/agent-tools.ts stamps
      // channel="mcp" and origin.provider="mcp" the moment a 3rd-party AI
      // connects — that's the seam we read here.
      const originBlock = (row.origin || {}) as { provider?: string; surface?: string; label?: string };
      const isMcpOrigin =
        row.channel === 'mcp' ||
        originBlock.provider === 'mcp' ||
        key.startsWith('mcp:') ||
        (typeof originBlock.surface === 'string' &&
          /^(claude-code|claude-desktop|codex|opencode|cursor)$/i.test(originBlock.surface));
      const role: MeshAgent['role'] = isMcpOrigin ? 'orchestrator' : undefined as any;

      // Determine status: prefer subagent status (richer states)
      let status: MeshAgent['status'] = 'idle';
      if (sa?.status) {
        const m: Record<string, MeshAgent['status']> = {
          starting: 'starting',
          working: 'working',
          checkpoint: 'working',
          blocked: 'blocked',
          finishing: 'finishing',
          completed: 'completed',
          failed: 'failed',
        };
        status = m[sa.status] || 'working';
      } else if (row.completedViaEvent) {
        status = row.completionState === 'error' ? 'failed' : 'completed';
      } else if (row.active) {
        status = 'working';
      }

      const la = sa?.lastActivity || null;
      const agent: MeshAgent = {
        sessionKey: row.key,
        agentId,
        label: row.label || row.derivedTitle || sa?.label || row.key,
        nodeId,
        nodeName: row.nodeName || 'Local',
        status,
        progress: Number(sa?.progress ?? row.progress ?? 0),
        currentTask: sa?.task || row.currentTask || row.derivedTitle,
        parent: row.parentSessionKey,
        children: row.children || [],
        spawnedAt: sa?.createdAt || row.createdAt || Date.now(),
        lastActivity: sa?.lastUpdateAt || row.updatedAt || Date.now(),
        lastActivityKind: la?.kind || undefined,
        lastActivityLabel: la?.label || undefined,
        messageCount: row.messageCount || 0,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        estimatedCost: row.estimatedCost,
        role: role || (row.kind === 'subagent' || key.includes(':subagent:') ? 'agent' : undefined),
        channel: row.channel,
        originSurface: originBlock.surface,
        coderBackend: row.coderBackend,
      };

      agents.set(row.key, agent);
      nodeCounts.set(nodeId, (nodeCounts.get(nodeId) || 0) + 1);
    }

    // Surface any subagents that don't have a matching session row
    for (const sa of subagents) {
      const key = sa.sessionKey || sa.childSessionKey || sa.runId;
      if (!key || agents.has(key)) continue;
      const nodeId = sa.nodeId || 'local';
      const la = sa.lastActivity || null;
      const statusMap: Record<string, MeshAgent['status']> = {
        starting: 'starting',
        working: 'working',
        checkpoint: 'working',
        blocked: 'blocked',
        finishing: 'finishing',
        completed: 'completed',
        failed: 'failed',
      };
      agents.set(key, {
        sessionKey: key,
        agentId: sa.agentId || 'sub',
        label: sa.label || key,
        nodeId,
        nodeName: 'Local',
        status: statusMap[sa.status] || 'working',
        progress: Number(sa.progress || 0),
        currentTask: sa.task,
        spawnedAt: sa.createdAt || Date.now(),
        lastActivity: sa.lastUpdateAt || Date.now(),
        lastActivityKind: la?.kind,
        lastActivityLabel: la?.label,
        messageCount: 0,
      });
      nodeCounts.set(nodeId, (nodeCounts.get(nodeId) || 0) + 1);
    }

    // Reflect node agent counts
    meshState.nodes.forEach((n, id) => {
      n.agentCount = nodeCounts.get(id) || 0;
    });

    updateMeshState({ agents });
  } catch (err) {
    console.warn('Failed to load agents:', err);
  }
}

async function loadMCPServers(client: GatewayBrowserClient): Promise<void> {
  try {
    const res = await client.request('mcp.status', {}) as any;
    const servers: MCPServer[] = [];

    if (res?.servers && Array.isArray(res.servers)) {
      for (const srv of res.servers) {
        servers.push({
          id: srv.id || srv.name,
          name: srv.name,
          status: srv.running ? 'running' : srv.error ? 'error' : 'stopped',
          toolCount: srv.toolCount || 0,
          nodeId: srv.nodeId,
          uptime: srv.uptime,
        });
      }
    }

    updateMeshState({ mcpServers: servers });
  } catch (err) {
    console.warn('Failed to load MCP servers:', err);
  }
}

async function loadTasks(client: GatewayBrowserClient): Promise<void> {
  try {
    const res = await client.request('kanban.tasks.list', {
      filter_status: 'in_progress',
      limit: 20,
    }) as any;

    const tasks: KanbanTask[] = [];

    if (res?.tasks && Array.isArray(res.tasks)) {
      for (const task of res.tasks) {
        tasks.push({
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
          agentSessionKey: task.agentSessionKey,
          priority: task.priority || 'medium',
          projectId: task.project_id,
        });
      }
    }

    updateMeshState({ tasks });
  } catch (err) {
    console.warn('Failed to load tasks:', err);
  }
}

function updateStats(): void {
  const agents = Array.from(meshState.agents.values());
  const nodes = Array.from(meshState.nodes.values());

  meshState.stats = {
    totalAgents: agents.length,
    activeAgents: agents.filter(a => a.status === 'working' || a.status === 'starting').length,
    totalNodes: nodes.length,
    onlineNodes: nodes.filter(n => n.status === 'online').length,
    totalMessages: meshState.messages.length,
    messagesPerMinute: calculateMessagesPerMinute(),
  };
}

function calculateMessagesPerMinute(): number {
  const oneMinuteAgo = Date.now() - 60000;
  return meshState.messages.filter(m => m.timestamp > oneMinuteAgo).length;
}

// ════════════════════════════════════════════════════════════════
// EVENT SUBSCRIPTION
// ════════════════════════════════════════════════════════════════

export function subscribeToEvents(
  client: GatewayBrowserClient,
  state: AppViewState
): void {
  if (eventUnsubscribe) {
    eventUnsubscribe();
  }

  const handleEvent = (event: any) => {
    switch (event.type) {
      case 'agent.spawn':
        handleAgentSpawn(event.data, state);
        break;
      case 'agent.progress':
        handleAgentProgress(event.data, state);
        break;
      case 'agent.complete':
        handleAgentComplete(event.data, state);
        break;
      case 'mesh.message':
        handleMeshMessage(event.data, state);
        break;
      case 'node.connected':
        handleNodeConnected(event.data, state);
        break;
      case 'node.disconnected':
        handleNodeDisconnected(event.data, state);
        break;
    }
  };

  // Subscribe to gateway events
  // Note: This depends on gateway event subscription mechanism
  try {
    if (typeof (client as any).subscribe === 'function') {
      const result = (client as any).subscribe('mesh.*', handleEvent);
      if (result && typeof result === 'function') {
        eventUnsubscribe = result;
      } else if (result && typeof result.unsubscribe === 'function') {
        eventUnsubscribe = () => result.unsubscribe();
      }
    }
  } catch (err) {
    console.warn('Failed to subscribe to mesh events:', err);
  }
}

export function unsubscribeFromEvents(): void {
  if (eventUnsubscribe) {
    eventUnsubscribe();
    eventUnsubscribe = null;
  }
}

function handleAgentSpawn(data: any, state: AppViewState): void {
  const agent: MeshAgent = {
    sessionKey: data.sessionKey,
    agentId: data.agentId,
    label: data.label || data.sessionKey,
    nodeId: data.nodeId || 'local',
    nodeName: data.nodeName || 'Local',
    status: 'starting',
    progress: 0,
    currentTask: data.task,
    parent: data.parent,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
  };

  meshState.agents.set(data.sessionKey, agent);

  // Update node agent count
  const node = meshState.nodes.get(agent.nodeId);
  if (node) {
    node.agentCount++;
  }

  updateStats();
  state.requestUpdate?.();
}

function handleAgentProgress(data: any, state: AppViewState): void {
  const agent = meshState.agents.get(data.sessionKey);
  if (!agent) return;

  agent.status = data.status || agent.status;
  agent.progress = data.progress ?? agent.progress;
  agent.currentTask = data.message || agent.currentTask;
  agent.lastActivity = Date.now();

  updateStats();
  state.requestUpdate?.();
}

function handleAgentComplete(data: any, state: AppViewState): void {
  const agent = meshState.agents.get(data.sessionKey);
  if (!agent) return;

  agent.status = data.success ? 'completed' : 'failed';
  agent.progress = 100;
  agent.lastActivity = Date.now();

  updateStats();
  state.requestUpdate?.();
}

function handleMeshMessage(data: any, state: AppViewState): void {
  const message: MeshMessage = {
    id: data.id || `msg-${Date.now()}`,
    from: data.from,
    fromLabel: data.fromLabel,
    to: data.to,
    toLabel: data.toLabel,
    type: data.type || 'request',
    payload: data.payload,
    timestamp: data.timestamp || Date.now(),
    delivered: data.delivered ?? true,
    read: false,
  };

  // Add to messages, keep last 100
  meshState.messages = [message, ...meshState.messages].slice(0, 100);

  // Update agent message count
  const fromAgent = meshState.agents.get(data.from);
  if (fromAgent) {
    fromAgent.messageCount++;
  }

  updateStats();
  state.requestUpdate?.();
}

function handleNodeConnected(data: any, state: AppViewState): void {
  const node = meshState.nodes.get(data.nodeId);
  if (node) {
    node.status = 'online';
    node.lastSeen = Date.now();
  } else {
    meshState.nodes.set(data.nodeId, {
      id: data.nodeId,
      name: data.nodeName || data.nodeId,
      role: 'satellite',
      status: 'online',
      agentCount: 0,
      lastSeen: Date.now(),
    });
  }

  updateStats();
  state.requestUpdate?.();
}

function handleNodeDisconnected(data: any, state: AppViewState): void {
  const node = meshState.nodes.get(data.nodeId);
  if (node) {
    node.status = 'offline';
  }

  updateStats();
  state.requestUpdate?.();
}

// ════════════════════════════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════════════════════════════

export async function spawnAgent(
  client: GatewayBrowserClient,
  params: {
    agentId: string;
    task: string;
    label?: string;
    node?: string;
  },
  state: AppViewState
): Promise<{ success: boolean; sessionKey?: string; error?: string }> {
  try {
    const res = await client.request('sessions.spawn', {
      agentId: params.agentId,
      task: params.task,
      label: params.label,
      node: params.node,
      // Canonical param name accepted by the gateway (matches
      // terminal.spawnAgent); the legacy `node` is also still read.
      nodeId: params.node,
    }) as any;

    const sessionKey = res?.sessionKey || res?.childSessionKey;
    if (sessionKey) {
      // Refresh the mesh status
      await loadMeshStatus(client, state);
      return { success: true, sessionKey };
    }

    return { success: false, error: 'No session key returned' };
  } catch (err) {
    return { 
      success: false, 
      error: err instanceof Error ? err.message : 'Failed to spawn agent' 
    };
  }
}

export async function killAgent(
  client: GatewayBrowserClient,
  sessionKey: string,
  state: AppViewState
): Promise<boolean> {
  try {
    await client.request('agent.abort', { sessionKey });
    
    // Remove from local state
    meshState.agents.delete(sessionKey);
    updateStats();
    state.requestUpdate?.();
    
    return true;
  } catch (err) {
    console.error('Failed to kill agent:', err);
    return false;
  }
}

export async function sendMeshMessage(
  client: GatewayBrowserClient,
  params: {
    to: string;
    message: string;
    type?: 'request' | 'response' | 'broadcast';
  },
  state: AppViewState
): Promise<boolean> {
  try {
    await client.request('sessions.send', {
      sessionKey: params.to,
      message: params.message,
    });

    // Add to local messages
    const message: MeshMessage = {
      id: `msg-${Date.now()}`,
      from: 'user',
      to: params.to,
      type: params.type || 'request',
      payload: { message: params.message },
      timestamp: Date.now(),
      delivered: true,
      read: false,
    };

    meshState.messages = [message, ...meshState.messages].slice(0, 100);
    updateStats();
    state.requestUpdate?.();

    return true;
  } catch (err) {
    console.error('Failed to send message:', err);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
// FILTERED DATA
// ════════════════════════════════════════════════════════════════

export function getFilteredAgents(): MeshAgent[] {
  let agents = Array.from(meshState.agents.values());

  // Filter by status
  if (meshState.filterAgentStatus) {
    agents = agents.filter(a => a.status === meshState.filterAgentStatus);
  }

  // Filter by node
  if (meshState.filterNodeId) {
    agents = agents.filter(a => a.nodeId === meshState.filterNodeId);
  }

  // Search filter
  if (meshState.searchQuery) {
    const query = meshState.searchQuery.toLowerCase();
    agents = agents.filter(a =>
      a.label.toLowerCase().includes(query) ||
      a.agentId.toLowerCase().includes(query) ||
      a.sessionKey.toLowerCase().includes(query)
    );
  }

  // Sort by last activity
  agents.sort((a, b) => b.lastActivity - a.lastActivity);

  return agents;
}

export function getFilteredNodes(): MeshNode[] {
  let nodes = Array.from(meshState.nodes.values());

  // Search filter
  if (meshState.searchQuery) {
    const query = meshState.searchQuery.toLowerCase();
    nodes = nodes.filter(n =>
      n.name.toLowerCase().includes(query) ||
      n.id.toLowerCase().includes(query)
    );
  }

  // Sort: online first, then by agent count
  nodes.sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (a.status !== 'online' && b.status === 'online') return 1;
    return b.agentCount - a.agentCount;
  });

  return nodes;
}

// ════════════════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════════════════

export function setActiveTab(tab: AgentMeshState['activeTab'], state: AppViewState): void {
  updateMeshState({ activeTab: tab });
  state.requestUpdate?.();
}

export function setSelectedAgent(sessionKey: string | null, state: AppViewState): void {
  updateMeshState({ selectedAgentKey: sessionKey });
  state.requestUpdate?.();
}

export function setSelectedNode(nodeId: string | null, state: AppViewState): void {
  updateMeshState({ selectedNodeId: nodeId });
  state.requestUpdate?.();
}

export function toggleSpawnDialog(state: AppViewState): void {
  updateMeshState({ showSpawnDialog: !meshState.showSpawnDialog });
  state.requestUpdate?.();
}

export function setSearchQuery(query: string, state: AppViewState): void {
  updateMeshState({ searchQuery: query });
  state.requestUpdate?.();
}

export function setFilterStatus(status: string | null, state: AppViewState): void {
  updateMeshState({ filterAgentStatus: status });
  state.requestUpdate?.();
}

export function setFilterNode(nodeId: string | null, state: AppViewState): void {
  updateMeshState({ filterNodeId: nodeId });
  state.requestUpdate?.();
}

// ════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════

export async function initAgentMesh(
  client: GatewayBrowserClient,
  state: AppViewState
): Promise<void> {
  await loadMeshStatus(client, state);
  subscribeToEvents(client, state);
}

export function cleanupAgentMesh(): void {
  unsubscribeFromEvents();
}
