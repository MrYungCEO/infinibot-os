/**
 * Federation Control Center Controller
 *
 * Manages state and data loading for the enhanced federation control center:
 * - Node load metrics (CPU/RAM/GPU per node)
 * - Session distribution across federation
 * - State sync status
 * - Capability matrix
 */

import type { GatewayBrowserClient } from "../gateway";
import type { FederationState, FederationNode } from "./federation";
import type {
  FederationResourcesState,
  FederatedAgent,
} from "./federation-resources";
import type {
  NodeLoadMetrics,
  SessionInfo,
  StateSyncItem,
  ControlCenterProps,
  UpdateState,
  NodeVersionInfo,
  UpdateProgress,
} from "../views/federation-control-center";
import type { NetworkPanelState } from "../views/network-control-panel";
import {
  createNetworkPanelState,
  createNetworkPanelHandlers,
  type NetworkPanelHandlers,
} from "./network-tailscale";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface ControlCenterState {
  loading: boolean;
  error: string | null;

  // Node metrics
  loadMetrics: Map<string, NodeLoadMetrics>;
  metricsLastUpdate: number | null;

  // Sessions
  sessions: SessionInfo[];
  sessionsLastUpdate: number | null;

  // Sync status
  syncItems: StateSyncItem[];
  vectorClock: Record<string, number>;
  conflictCount: number;

  // UI state
  selectedMcpId: string | null;
  mcpDetailsOpen: boolean;
  mcpTestResult: string | null;

  // Update state
  updateState: UpdateState;

  // Service discovery state
  serviceState: ServiceDiscoveryState;

  // Network / Tailscale exposure panel
  networkPanel: NetworkPanelState;
}

// Service Discovery Types
export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: "running" | "exited" | "paused" | "created";
  ports: Array<{ hostPort: number; containerPort: number; protocol: string }>;
  created: string;
  networks: string[];
}

export interface FederationService {
  id: string;
  name: string;
  type: "docker" | "directory" | "api";
  nodeId: string;
  containerId?: string;
  containerName?: string;
  path?: string;
  baseUrl?: string;
  docsUrl?: string;
  ports?: number[];
  protocol?: string;
  capabilities?: string[];
  mcpServerId?: string;
  mcpStatus?: "none" | "building" | "built" | "error";
  mcpError?: string;
  exposed: boolean;
  exposedTo?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ServiceDiscoveryState {
  loading: boolean;
  dockerContainers: DockerContainer[];
  services: FederationService[];
  lastScan: number | null;
  addingDirectory: boolean;
  directoryPath: string;
  selectedNodeForScan: string | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// State Factory
// ══════════════════════════════════════════════════════════════════════════════

// Stable handler cache so the Tailscale poller isn't restarted every
// render. Keyed by the ControlCenterState identity (each control
// center instance has its own state object).
const networkHandlerCache = new WeakMap<ControlCenterState, NetworkPanelHandlers>();

function getNetworkHandlers(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  requestUpdate: () => void,
): NetworkPanelHandlers {
  let h = networkHandlerCache.get(state);
  if (!h) {
    h = createNetworkPanelHandlers(client, state.networkPanel, requestUpdate);
    networkHandlerCache.set(state, h);
    // Kick off slow polling so the UI shows live tailnet status even
    // before the operator touches the panel. start() is idempotent.
    h.start();
  }
  return h;
}

export function createControlCenterState(): ControlCenterState {
  return {
    loading: false,
    error: null,
    loadMetrics: new Map(),
    metricsLastUpdate: null,
    sessions: [],
    sessionsLastUpdate: null,
    syncItems: getDefaultSyncItems(),
    vectorClock: {},
    conflictCount: 0,
    selectedMcpId: null,
    mcpDetailsOpen: false,
    mcpTestResult: null,
    updateState: {
      loading: false,
      nodeVersions: [],
      latestVersion: null,
      updateInProgress: new Map(),
      lastCheck: null,
    },
    serviceState: {
      loading: false,
      dockerContainers: [],
      services: [],
      lastScan: null,
      addingDirectory: false,
      directoryPath: "",
      selectedNodeForScan: null,
    },
    networkPanel: createNetworkPanelState(),
  };
}

function getDefaultSyncItems(): StateSyncItem[] {
  return [
    {
      category: "Memory Files",
      icon: "📁",
      status: "synced",
      lastSync: Date.now(),
    },
    {
      category: "Kanban Tasks",
      icon: "✅",
      status: "synced",
      lastSync: Date.now(),
    },
    {
      category: "Transcripts",
      icon: "📝",
      status: "synced",
      lastSync: Date.now(),
    },
    {
      category: "Config",
      icon: "⚙️",
      status: "synced",
      lastSync: Date.now(),
    },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// Data Loading
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Load all control center data
 */
export async function loadControlCenterData(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  federationState: FederationState,
  resourcesState: FederationResourcesState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client || state.loading) return;

  state.loading = true;
  state.error = null;
  requestUpdate?.();

  try {
    // Load in parallel
    await Promise.all([
      loadNodeMetrics(client, state, federationState, requestUpdate),
      loadSessions(client, state, resourcesState, requestUpdate),
      loadSyncStatus(client, state, federationState, requestUpdate),
      loadServices(client, state, undefined, requestUpdate),
    ]);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    requestUpdate?.();
  }
}

/**
 * Load node resource metrics (CPU/RAM/GPU)
 */
export async function loadNodeMetrics(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  federationState: FederationState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;

  try {
    // Try to get fleet health from federation endpoint
    const res = await client.request<{
      nodes?: Array<{
        nodeId: string;
        cpuPercent?: number;
        memoryPercent?: number;
        gpuPercent?: number;
        loadScore?: number;
        activeSessions?: number;
      }>;
    }>("federation.fleet.health", {}).catch(() => null);

    state.loadMetrics.clear();

    if (res?.nodes) {
      for (const node of res.nodes) {
        state.loadMetrics.set(node.nodeId, {
          nodeId: node.nodeId,
          cpuPercent: node.cpuPercent ?? 0,
          memoryPercent: node.memoryPercent ?? 0,
          gpuPercent: node.gpuPercent,
          loadScore: node.loadScore ?? calculateLoadScore(node.cpuPercent ?? 0, node.memoryPercent ?? 0, node.gpuPercent),
          activeSessions: node.activeSessions ?? 0,
          lastUpdate: Date.now(),
        });
      }
    } else {
      // Fallback: Try to get metrics from individual nodes or compute endpoints
      for (const node of federationState.nodes.filter((n) => n.status === "online")) {
        try {
          const nodeRes = await client.request<{
            metrics?: {
              cpuPercent?: number;
              memoryPercent?: number;
              gpuPercent?: number;
              loadScore?: number;
            };
          }>("compute.node.status", { nodeId: node.id }).catch(() => null);

          if (nodeRes?.metrics) {
            state.loadMetrics.set(node.id, {
              nodeId: node.id,
              cpuPercent: nodeRes.metrics.cpuPercent ?? 0,
              memoryPercent: nodeRes.metrics.memoryPercent ?? 0,
              gpuPercent: nodeRes.metrics.gpuPercent,
              loadScore: nodeRes.metrics.loadScore ?? calculateLoadScore(
                nodeRes.metrics.cpuPercent ?? 0,
                nodeRes.metrics.memoryPercent ?? 0,
                nodeRes.metrics.gpuPercent
              ),
              activeSessions: 0,
              lastUpdate: Date.now(),
            });
          } else {
            // Generate placeholder metrics for online nodes
            state.loadMetrics.set(node.id, generatePlaceholderMetrics(node.id));
          }
        } catch {
          // Generate placeholder for nodes we can't reach
          state.loadMetrics.set(node.id, generatePlaceholderMetrics(node.id));
        }
      }
    }

    state.metricsLastUpdate = Date.now();
  } catch (err) {
    console.warn("[FCC] Failed to load node metrics:", err);
    // Generate placeholders for all online nodes
    for (const node of federationState.nodes.filter((n) => n.status === "online")) {
      state.loadMetrics.set(node.id, generatePlaceholderMetrics(node.id));
    }
  }

  requestUpdate?.();
}

/**
 * Load active sessions across federation
 */
export async function loadSessions(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  resourcesState: FederationResourcesState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;

  try {
    // Try to get federated sessions
    const res = await client.request<{
      sessions?: Array<{
        id: string;
        sessionKey: string;
        nodeId: string;
        nodeName?: string;
        agentId: string;
        channel?: string;
        tokens?: number;
        lastActive?: number;
        status?: string;
      }>;
    }>("sessions.list", { includeFederated: true }).catch(() => null);

    if (res?.sessions) {
      state.sessions = res.sessions.map((s) => ({
        id: s.id,
        sessionKey: s.sessionKey,
        nodeId: s.nodeId,
        nodeName: s.nodeName ?? s.nodeId,
        agentId: s.agentId,
        channel: s.channel ?? "unknown",
        tokens: s.tokens ?? 0,
        lastActive: s.lastActive ?? Date.now(),
        status: parseSessionStatus(s.status),
      }));
    } else {
      // Fallback: Generate sessions from agents
      state.sessions = generateSessionsFromAgents(resourcesState.agents);
    }

    state.sessionsLastUpdate = Date.now();
  } catch (err) {
    console.warn("[FCC] Failed to load sessions:", err);
    // Fallback to agents
    state.sessions = generateSessionsFromAgents(resourcesState.agents);
  }

  requestUpdate?.();
}

/**
 * Load sync status for state synchronization
 */
export async function loadSyncStatus(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  federationState: FederationState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;

  try {
    // Try to get sync status from federation endpoint
    const res = await client.request<{
      items?: Array<{
        category: string;
        status: string;
        lastSync?: number;
        pendingCount?: number;
      }>;
      vectorClock?: Record<string, number>;
      conflicts?: number;
    }>("federation.state.status", {}).catch(() => null);

    if (res) {
      if (res.items) {
        state.syncItems = res.items.map((item) => ({
          category: item.category,
          icon: getSyncItemIcon(item.category),
          status: parseSyncStatus(item.status),
          lastSync: item.lastSync ?? Date.now(),
          pendingCount: item.pendingCount,
        }));
      }

      if (res.vectorClock) {
        state.vectorClock = res.vectorClock;
      } else {
        // Generate placeholder vector clock
        state.vectorClock = {};
        for (const node of federationState.nodes) {
          state.vectorClock[node.name] = Math.floor(Math.random() * 200) + 1;
        }
      }

      state.conflictCount = res.conflicts ?? 0;
    } else {
      // Keep defaults but update timestamps
      state.syncItems = state.syncItems.map((item) => ({
        ...item,
        lastSync: Date.now() - Math.floor(Math.random() * 3600000),
      }));

      // Generate placeholder vector clock
      state.vectorClock = {};
      for (const node of federationState.nodes) {
        state.vectorClock[node.name] = Math.floor(Math.random() * 200) + 1;
      }
    }
  } catch (err) {
    console.warn("[FCC] Failed to load sync status:", err);
  }

  requestUpdate?.();
}

// ══════════════════════════════════════════════════════════════════════════════
// Actions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Test an MCP server
 */
export async function testMCP(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  mcpId: string,
  nodeId: string,
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  state.selectedMcpId = mcpId;
  state.mcpTestResult = null;
  requestUpdate?.();

  try {
    const res = await client.request<{ success?: boolean; message?: string }>(
      "federation.mcp.test",
      { mcpId, nodeId }
    ).catch(() => null);

    if (res?.success) {
      state.mcpTestResult = "✅ MCP is responding";
      requestUpdate?.();
      return true;
    } else {
      state.mcpTestResult = `❌ ${res?.message ?? "Test failed"}`;
      requestUpdate?.();
      return false;
    }
  } catch (err) {
    state.mcpTestResult = `❌ ${err instanceof Error ? err.message : "Test failed"}`;
    requestUpdate?.();
    return false;
  }
}

/**
 * Migrate a session to another node
 */
export async function migrateSession(
  _client: GatewayBrowserClient | null,
  sessionId: string,
  targetNodeId: string,
  requestUpdate?: () => void
): Promise<boolean> {
  // Cross-node session migration has no gateway implementation: moving a live
  // agent session would need its full conversation + process state to be
  // transferred, and no such transport exists. The old
  // `federation.session.migrate` call was never served and hard-errored on
  // every click. Until a real migration path lands, report the limitation
  // instead of pretending to move anything — spawning a fresh session on the
  // target node (`sessions.spawn` with `node`) is the working alternative.
  console.warn(
    `[FCC] Session migration is not supported (session ${sessionId} -> node ${targetNodeId})`
  );
  requestUpdate?.();
  return false;
}

/**
 * Kill a session
 */
export async function killSession(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  sessionId: string,
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  // sessions.delete is keyed by the session KEY, not the list `id`, so map
  // back through the loaded roster before calling it.
  const key = state.sessions.find((s) => s.id === sessionId)?.sessionKey ?? sessionId;

  try {
    const res = await client.request<{ deleted?: boolean; ok?: boolean }>(
      "sessions.delete",
      { key }
    ).catch(() => null);

    const ok = res?.deleted ?? res?.ok ?? Boolean(res);
    if (ok) {
      state.sessions = state.sessions.filter((s) => s.id !== sessionId);
      requestUpdate?.();
    }
    return ok;
  } catch {
    return false;
  }
}

/**
 * Wake a node via Wake-on-LAN
 */
export async function wakeNode(
  client: GatewayBrowserClient | null,
  nodeId: string,
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  try {
    const res = await client.request<{ success?: boolean }>(
      "federation.node.wake",
      { nodeId }
    ).catch(() => null);

    return res?.success ?? false;
  } catch {
    return false;
  }
}

/**
 * Ping a node
 */
export async function pingNode(
  client: GatewayBrowserClient | null,
  nodeId: string,
  requestUpdate?: () => void
): Promise<number | null> {
  if (!client) return null;

  try {
    const start = Date.now();
    // federation.ping forwards to `nodeId` and the answering node echoes its
    // own id back — a reply at all is the pong.
    const res = await client.request<{ nodeId?: string; ts?: number }>(
      "federation.ping",
      { nodeId }
    ).catch(() => null);

    if (res?.nodeId) {
      return Date.now() - start;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Force sync a specific category
 */
export async function forceSyncCategory(
  client: GatewayBrowserClient | null,
  category: string,
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  try {
    const res = await client.request<{ success?: boolean }>(
      // Server-side sync is fleet-wide; `category` scopes it where supported.
      "federation.sync",
      { category }
    ).catch(() => null);

    return res?.success ?? false;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Update Actions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check for updates across all nodes
 */
export async function checkForUpdates(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;

  state.updateState.loading = true;
  requestUpdate?.();

  try {
    const res = await client.request<{
      nodes?: NodeVersionInfo[];
      latestVersion?: string;
      timestamp?: number;
    }>("federation.fleet.versions", {}).catch(() => null);

    if (res?.nodes) {
      state.updateState.nodeVersions = res.nodes;
      state.updateState.latestVersion = res.latestVersion ?? null;
      state.updateState.lastCheck = res.timestamp ?? Date.now();
    }
  } catch (err) {
    console.warn("[FCC] Failed to check for updates:", err);
  } finally {
    state.updateState.loading = false;
    requestUpdate?.();
  }
}

/**
 * Update a specific node
 */
export async function updateNode(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  nodeId: string,
  actions: { gitPull?: boolean; build?: boolean; restart?: boolean },
  requestUpdate?: () => void
): Promise<boolean> {
  if (!client) return false;

  // Set initial progress
  const progress: UpdateProgress = {
    nodeId,
    status: "pending",
    progress: 0,
    currentStep: "Starting update...",
  };
  state.updateState.updateInProgress.set(nodeId, progress);
  requestUpdate?.();

  try {
    // Simulate progress updates (in real impl, this would come from SSE or WebSocket)
    const updateProgress = (status: UpdateProgress["status"], step: string, pct: number) => {
      progress.status = status;
      progress.currentStep = step;
      progress.progress = pct;
      state.updateState.updateInProgress.set(nodeId, { ...progress });
      requestUpdate?.();
    };

    if (actions.gitPull) {
      updateProgress("pulling", "Running git pull...", 10);
    }

    const res = await client.request<{
      success?: boolean;
      nodeId?: string;
      result?: {
        status?: string;
        steps?: Array<{ name: string; exitCode: number | null }>;
      };
      error?: string;
    }>("federation.node.update", {
      nodeId,
      actions: {
        gitPull: actions.gitPull ?? true,
        npmInstall: true,
        build: actions.build ?? true,
        restart: actions.restart ?? false,
      },
    }).catch(() => null);

    if (res?.success) {
      // Update progress based on response
      if (res.result?.steps) {
        const steps = res.result.steps;
        const depsStep = steps.find((s) => s.name.includes("deps") || s.name.includes("install"));
        const buildStep = steps.find((s) => s.name.includes("build"));
        
        if (depsStep) {
          updateProgress("installing", "Installing dependencies...", 40);
          await new Promise((r) => setTimeout(r, 500)); // Brief pause for visual feedback
        }
        if (buildStep) {
          updateProgress("building", "Building project...", 70);
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      if (actions.restart) {
        updateProgress("restarting", "Restarting gateway...", 90);
        // Note: The connection may drop here as the gateway restarts
      }

      updateProgress("complete", "Update complete!", 100);
      
      // Clear progress after a delay
      setTimeout(() => {
        state.updateState.updateInProgress.delete(nodeId);
        requestUpdate?.();
      }, 3000);

      // Refresh version info
      await checkForUpdates(client, state, requestUpdate);
      return true;
    } else {
      progress.status = "error";
      progress.error = res?.error ?? "Update failed";
      progress.currentStep = "Update failed";
      state.updateState.updateInProgress.set(nodeId, { ...progress });
      requestUpdate?.();
      return false;
    }
  } catch (err) {
    progress.status = "error";
    progress.error = err instanceof Error ? err.message : "Update failed";
    progress.currentStep = "Update failed";
    state.updateState.updateInProgress.set(nodeId, { ...progress });
    requestUpdate?.();
    return false;
  }
}

/**
 * Update all online nodes in the federation
 */
export async function updateAllNodes(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;

  // Get all online nodes with updates available
  const nodesToUpdate = state.updateState.nodeVersions.filter(
    (n) => n.status === "online" && (n.updateAvailable || n.nodeId === "local")
  );

  // Update each node sequentially (to avoid overwhelming the system)
  for (const node of nodesToUpdate) {
    await updateNode(client, state, node.nodeId, { gitPull: true, build: true }, requestUpdate);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Props Builder
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build ControlCenterProps from controller states
 */
export function buildControlCenterProps(
  client: GatewayBrowserClient | null,
  federationState: FederationState,
  resourcesState: FederationResourcesState,
  controlCenterState: ControlCenterState,
  requestUpdate: () => void
): ControlCenterProps {
  return {
    federationState,
    resourcesState,
    loadMetrics: controlCenterState.loadMetrics,
    sessions: controlCenterState.sessions,
    syncItems: controlCenterState.syncItems,
    vectorClock: controlCenterState.vectorClock,
    conflictCount: controlCenterState.conflictCount,
    updateState: controlCenterState.updateState,
    serviceState: controlCenterState.serviceState,
    networkState: controlCenterState.networkPanel,
    onRefreshNetwork: () => {
      void getNetworkHandlers(client, controlCenterState, requestUpdate).refresh();
    },
    onEnableNetwork: (mode) => {
      void getNetworkHandlers(client, controlCenterState, requestUpdate).enable(mode);
    },
    onDisableNetwork: (mode) => {
      void getNetworkHandlers(client, controlCenterState, requestUpdate).disable(mode);
    },

    onRefresh: () => {
      void loadControlCenterData(client, controlCenterState, federationState, resourcesState, requestUpdate);
      void checkForUpdates(client, controlCenterState, requestUpdate);
    },

    onSyncAll: async () => {
      if (!client) return;
      await client.request("federation.sync", { full: true }).catch(() => null);
      await loadControlCenterData(client, controlCenterState, federationState, resourcesState, requestUpdate);
    },

    onSelectNode: (nodeId: string | null) => {
      resourcesState.selectedNodeId = nodeId;
      requestUpdate();
    },

    onTestMCP: (mcpId: string, nodeId: string) => {
      void testMCP(client, controlCenterState, mcpId, nodeId, requestUpdate);
    },

    onMCPDetails: (mcpId: string, nodeId: string) => {
      controlCenterState.selectedMcpId = mcpId;
      controlCenterState.mcpDetailsOpen = true;
      requestUpdate();
      // TODO: Open modal with MCP details
    },

    onMigrateSession: async (sessionId: string, targetNodeId: string) => {
      const success = await migrateSession(client, sessionId, targetNodeId, requestUpdate);
      if (success) {
        await loadSessions(client, controlCenterState, resourcesState, requestUpdate);
      }
    },

    onKillSession: async (sessionId: string) => {
      const success = await killSession(client, controlCenterState, sessionId, requestUpdate);
      if (success) {
        await loadSessions(client, controlCenterState, resourcesState, requestUpdate);
      }
    },

    onAddNode: async (url: string) => {
      if (!client) return;
      await client.request("federation.node.add", { url }).catch(() => null);
      requestUpdate();
    },

    onRemoveNode: async (nodeId: string) => {
      if (!client) return;
      await client.request("federation.node.remove", { nodeId }).catch(() => null);
      requestUpdate();
    },

    onWakeNode: (nodeId: string) => {
      void wakeNode(client, nodeId, requestUpdate);
    },

    onPingNode: async (nodeId: string) => {
      const latency = await pingNode(client, nodeId, requestUpdate);
      if (latency !== null) {
        console.log(`[FCC] Node ${nodeId} responded in ${latency}ms`);
      } else {
        console.log(`[FCC] Node ${nodeId} did not respond`);
      }
    },

    onConfigureNode: (nodeId: string) => {
      // TODO: Navigate to node config page
      console.log(`[FCC] Configure node: ${nodeId}`);
    },

    onLinkSshDevice: async (params: {
      nodeId: string;
      username: string;
      password?: string;
      privateKey?: string;
      host?: string;
      port?: number;
      setActive?: boolean;
    }) => {
      if (!client) return;
      try {
        const res = await client.request<{
          success?: boolean;
          device?: { id: string; name: string };
        }>("federation.node.linkSshDevice", params);
        if (res?.success) {
          console.log(
            `[FCC] Linked ${params.nodeId} as SSH device ${res.device?.name ?? "?"}`,
          );
        }
      } catch (err) {
        console.error("[FCC] Failed to link SSH device:", err);
      } finally {
        requestUpdate();
      }
    },

    onScanNetwork: async () => {
      if (!client) return;
      await client.request("federation.scan", {}).catch(() => null);
      requestUpdate();
    },

    onForceSyncItem: (category: string) => {
      void forceSyncCategory(client, category, requestUpdate);
    },

    // Update actions
    onCheckForUpdates: () => {
      void checkForUpdates(client, controlCenterState, requestUpdate);
    },

    onUpdateNode: (nodeId: string, actions: { gitPull?: boolean; build?: boolean; restart?: boolean }) => {
      void updateNode(client, controlCenterState, nodeId, actions, requestUpdate);
    },

    onUpdateAllNodes: () => {
      void updateAllNodes(client, controlCenterState, requestUpdate);
    },
    
    // Service Discovery Actions
    onScanDocker: (nodeId?: string) => {
      void scanDockerContainers(client, controlCenterState, nodeId, requestUpdate);
    },
    
    onAddDirectory: (path: string, nodeId?: string) => {
      void registerDirectoryService(client, controlCenterState, path, nodeId, requestUpdate);
    },
    
    onRegisterService: (container: DockerContainer, nodeId: string) => {
      void registerDockerService(client, controlCenterState, container, nodeId, requestUpdate);
    },
    
    onExposeService: (serviceId: string, exposed: boolean, exposedTo?: string[]) => {
      void updateServiceExposure(client, controlCenterState, serviceId, exposed, exposedTo, requestUpdate);
    },
    
    onBuildMCP: (serviceId: string) => {
      void triggerMCPBuild(client, controlCenterState, serviceId, requestUpdate);
    },
    
    onDeleteService: (serviceId: string) => {
      void deleteService(client, controlCenterState, serviceId, requestUpdate);
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Service Discovery Actions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Scan for Docker containers on the specified node
 */
export async function scanDockerContainers(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  nodeId?: string,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;
  
  state.serviceState.loading = true;
  state.serviceState.selectedNodeForScan = nodeId ?? null;
  requestUpdate?.();
  
  try {
    const res = await client.request<{
      success?: boolean;
      containers?: DockerContainer[];
      scannedAt?: number;
    }>("services.docker.scan", { nodeId }).catch(() => null);
    
    if (res?.success && res.containers) {
      state.serviceState.dockerContainers = res.containers;
      state.serviceState.lastScan = res.scannedAt ?? Date.now();
    }
  } catch (err) {
    console.warn("[FCC] Docker scan failed:", err);
  } finally {
    state.serviceState.loading = false;
    requestUpdate?.();
  }
}

/**
 * Load registered services
 */
export async function loadServices(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  nodeId?: string,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;
  
  try {
    const res = await client.request<{
      success?: boolean;
      services?: FederationService[];
    }>("services.list", { nodeId }).catch(() => null);
    
    if (res?.success && res.services) {
      state.serviceState.services = res.services;
    }
  } catch (err) {
    console.warn("[FCC] Failed to load services:", err);
  } finally {
    requestUpdate?.();
  }
}

/**
 * Register a Docker container as a federation service
 */
export async function registerDockerService(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  container: DockerContainer,
  nodeId: string,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;
  
  try {
    const res = await client.request<{
      success?: boolean;
      service?: FederationService;
    }>("services.register", {
      name: container.name,
      type: "docker",
      nodeId,
      containerId: container.id,
      containerName: container.name,
      ports: container.ports.map(p => p.hostPort),
      exposed: false,
    }).catch(() => null);
    
    if (res?.success && res.service) {
      state.serviceState.services.push(res.service);
      // Remove from containers list since it's now registered
      state.serviceState.dockerContainers = state.serviceState.dockerContainers.filter(
        c => c.id !== container.id
      );
    }
  } catch (err) {
    console.warn("[FCC] Failed to register Docker service:", err);
  } finally {
    requestUpdate?.();
  }
}

/**
 * Register a directory as a federation service
 */
export async function registerDirectoryService(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  path: string,
  nodeId?: string,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;
  
  state.serviceState.addingDirectory = true;
  requestUpdate?.();
  
  try {
    // First analyze the directory
    const analyzeRes = await client.request<{
      success?: boolean;
      profile?: { name: string; capabilities: string[] };
    }>("services.directory.analyze", { path }).catch(() => null);
    
    if (!analyzeRes?.success) {
      console.warn("[FCC] Failed to analyze directory");
      return;
    }
    
    // Register the service
    const res = await client.request<{
      success?: boolean;
      service?: FederationService;
    }>("services.register", {
      name: analyzeRes.profile?.name || path.split(/[/\\]/).pop(),
      type: "directory",
      nodeId: nodeId || "local",
      path,
      capabilities: analyzeRes.profile?.capabilities,
      exposed: false,
    }).catch(() => null);
    
    if (res?.success && res.service) {
      state.serviceState.services.push(res.service);
    }
  } catch (err) {
    console.warn("[FCC] Failed to register directory service:", err);
  } finally {
    state.serviceState.addingDirectory = false;
    requestUpdate?.();
  }
}

/**
 * Update service federation exposure
 */
export async function updateServiceExposure(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  serviceId: string,
  exposed: boolean,
  exposedTo?: string[],
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;
  
  try {
    const res = await client.request<{
      success?: boolean;
      service?: FederationService;
    }>("services.expose", { serviceId, exposed, exposedTo }).catch(() => null);
    
    if (res?.success && res.service) {
      const idx = state.serviceState.services.findIndex(s => s.id === serviceId);
      if (idx !== -1) {
        state.serviceState.services[idx] = res.service;
      }
    }
  } catch (err) {
    console.warn("[FCC] Failed to update service exposure:", err);
  } finally {
    requestUpdate?.();
  }
}

/**
 * Delete a federation service
 */
export async function deleteService(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  serviceId: string,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;
  
  try {
    const res = await client.request<{
      success?: boolean;
    }>("services.delete", { serviceId }).catch(() => null);
    
    if (res?.success) {
      state.serviceState.services = state.serviceState.services.filter(s => s.id !== serviceId);
    }
  } catch (err) {
    console.warn("[FCC] Failed to delete service:", err);
  } finally {
    requestUpdate?.();
  }
}

/**
 * Trigger MCP build for a service (spawns sub-agent)
 */
export async function triggerMCPBuild(
  client: GatewayBrowserClient | null,
  state: ControlCenterState,
  serviceId: string,
  requestUpdate?: () => void
): Promise<void> {
  if (!client) return;
  
  const service = state.serviceState.services.find(s => s.id === serviceId);
  if (!service) return;
  
  try {
    // First, get build params from gateway
    const buildRes = await client.request<{
      success?: boolean;
      buildParams?: Record<string, unknown>;
      workflow?: string;
    }>("services.mcp.build", { serviceId }).catch(() => null);
    
    if (!buildRes?.success) {
      console.warn("[FCC] Failed to get MCP build params");
      return;
    }
    
    // Update local state to show building
    const idx = state.serviceState.services.findIndex(s => s.id === serviceId);
    if (idx !== -1) {
      state.serviceState.services[idx].mcpStatus = "building";
    }
    requestUpdate?.();
    
    // Spawn sub-agent to do the actual build
    // This uses the MCP Service Integration Builder workflow
    const task = `
Build MCP integration for service "${service.name}" using the "mcp-service-integration-builder" workflow.

Service Details:
- Type: ${service.type}
- Node: ${service.nodeId}
${service.containerName ? `- Container: ${service.containerName}` : ""}
${service.path ? `- Path: ${service.path}` : ""}
${service.ports?.length ? `- Ports: ${service.ports.join(", ")}` : ""}
${service.capabilities?.length ? `- Capabilities: ${service.capabilities.join(", ")}` : ""}

Follow the workflow phases:
1. Service Discovery & Analysis
2. MCP Server Generation
3. Federation Integration
4. Testing & Validation
5. Deployment & Registration

After completion, update the service MCP status via services.mcp.status gateway call.
`.trim();

    await client.request("sessions.spawn", {
      agentId: "coder",
      label: `🔧 Build MCP: ${service.name}`,
      task,
      cleanup: "keep",
    }).catch(() => null);
    
  } catch (err) {
    console.warn("[FCC] Failed to trigger MCP build:", err);
    // Revert status
    const idx = state.serviceState.services.findIndex(s => s.id === serviceId);
    if (idx !== -1) {
      state.serviceState.services[idx].mcpStatus = "error";
      state.serviceState.services[idx].mcpError = "Failed to spawn build agent";
    }
    requestUpdate?.();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function calculateLoadScore(cpu: number, memory: number, gpu?: number): number {
  // Simple weighted average
  if (gpu !== undefined) {
    return Math.round((cpu * 0.3 + memory * 0.4 + gpu * 0.3));
  }
  return Math.round((cpu * 0.4 + memory * 0.6));
}

function generatePlaceholderMetrics(nodeId: string): NodeLoadMetrics {
  return {
    nodeId,
    cpuPercent: Math.random() * 50 + 10,
    memoryPercent: Math.random() * 40 + 20,
    gpuPercent: Math.random() > 0.5 ? Math.random() * 30 : undefined,
    loadScore: Math.random() * 40 + 10,
    activeSessions: Math.floor(Math.random() * 5),
    lastUpdate: Date.now(),
  };
}

function generateSessionsFromAgents(agents: FederatedAgent[]): SessionInfo[] {
  const sessions: SessionInfo[] = [];

  for (const agent of agents.filter((a) => a.activeSessions > 0)) {
    for (let i = 0; i < agent.activeSessions; i++) {
      sessions.push({
        id: `${agent.id}-session-${i}`,
        sessionKey: `agent:${agent.id}:session-${Math.random().toString(36).substring(7)}`,
        nodeId: agent.nodeId,
        nodeName: agent.nodeName,
        agentId: agent.id,
        channel: "webchat",
        tokens: Math.floor(Math.random() * 50000) + 5000,
        lastActive: Date.now() - Math.floor(Math.random() * 3600000),
        status: "active",
      });
    }
  }

  return sessions;
}

function parseSessionStatus(status: unknown): "active" | "idle" | "finishing" {
  if (status === "active" || status === "idle" || status === "finishing") {
    return status;
  }
  return "active";
}

function parseSyncStatus(status: unknown): "synced" | "pending" | "conflict" | "error" {
  if (status === "synced" || status === "pending" || status === "conflict" || status === "error") {
    return status;
  }
  return "synced";
}

function getSyncItemIcon(category: string): string {
  const icons: Record<string, string> = {
    "Memory Files": "📁",
    "Kanban Tasks": "✅",
    "Transcripts": "📝",
    "Config": "⚙️",
    "Notes": "📒",
    "Research": "📚",
    "Workflows": "🔄",
  };
  return icons[category] ?? "📦";
}
