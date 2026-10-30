/**
 * Federation Controller
 * 
 * Manages federation state for InfiniBot's multi-node network.
 * Tracks connected nodes, current node selection, and federation mode.
 */

import type { GatewayBrowserClient } from "../gateway";

// ── Types ─────────────────────────────────────────────────

export type FederationMode = "master" | "satellite" | "standalone";

export interface NodeCapabilities {
  gpu?: string;
  gpuVRAM?: number;
  ram?: number;
  systemRAM?: number;
  hasOllama?: boolean;
  ollamaModels?: string[];
  hasComfyUI?: boolean;
  comfyUIPath?: string;
  hasVoice?: boolean;
  mcpServers?: string[];
  agents?: string[];
  workspaces?: string[];
  platform?: string;
  arch?: string;
  // Media capabilities
  ffmpeg?: {
    available: boolean;
    version?: string;
    hasNvenc: boolean;
    hasNvdec: boolean;
    hasCuda: boolean;
    codecs: string[];
  };
  imageTools?: {
    rembg: boolean;
    realesrgan: boolean;
    pillow: boolean;
    imagemagick: boolean;
  };
  mediaServices?: string[];
}

export interface FederationNode {
  id: string;
  name: string;
  hostname?: string;
  remoteIp?: string;
  status: "online" | "offline" | "connecting";
  role: "master" | "satellite";
  platform?: "ios" | "android" | "macos" | "windows" | "linux" | "unknown";
  latency?: number;
  lastSeen: number;
  capabilities: NodeCapabilities;
  version?: string;
  workspace?: string;
  isLocal?: boolean;
}

export interface MasterUrlInfo {
  type: "lan" | "tailscale" | "tunnel";
  url: string;
  label: string;
}

export interface FederationState {
  loading: boolean;
  error: string | null;
  mode: FederationMode;
  masterUrl: string;
  connectionStatus: "connected" | "disconnected" | "connecting";
  nodes: FederationNode[];
  currentNodeId: string | null;
  localNodeId: string | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  /** URLs that satellites can use to connect (for masters) */
  masterUrls: MasterUrlInfo[];
}

export interface FederationConfig {
  mode: FederationMode;
  masterUrl?: string;
  name?: string;
  advertise?: boolean;
}

// ── Default State ─────────────────────────────────────────

export function createFederationState(): FederationState {
  return {
    loading: false,
    error: null,
    mode: "standalone",
    masterUrl: "",
    connectionStatus: "disconnected",
    nodes: [],
    currentNodeId: null,
    localNodeId: null,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    masterUrls: [],
  };
}

// ── Actions ───────────────────────────────────────────────

/**
 * Load federation state including nodes and configuration
 */
export async function loadFederationState(
  client: GatewayBrowserClient | null,
  state: FederationState,
  requestUpdate?: () => void,
): Promise<void> {
  if (!client) return;
  if (state.loading) return;

  state.loading = true;
  state.error = null;
  requestUpdate?.();

  try {
    // Load federation config
    const configRes = await client.request<{ config?: Record<string, unknown> }>(
      "federation.config.get",
      {},
    ).catch(() => null);

    if (configRes?.config) {
      const config = configRes.config;
      state.mode = (config.mode as FederationMode) || "standalone";
      state.masterUrl = (config.masterUrl as string) || "";
      state.localNodeId = (config.nodeId as string) || null;
    }

    // Load connected federation satellites
    const fedNodesRes = await client.request<{ nodes?: Array<Record<string, unknown>> }>(
      "federation.nodes.list",
      {},
    ).catch(() => null);

    // Also load mobile paired nodes
    const mobileNodesRes = await client.request<{ nodes?: Array<Record<string, unknown>> }>(
      "node.list",
      {},
    ).catch(() => null);

    // Combine both lists
    const fedNodes = (fedNodesRes?.nodes ?? []).map(parseNodeFromApi);
    const mobileNodes = (mobileNodesRes?.nodes ?? []).map(parseNodeFromApi);
    state.nodes = [...fedNodes, ...mobileNodes];

    // For master/standalone mode, add local node with capabilities
    if (state.mode === "master" || state.mode === "standalone") {
      // Get local capabilities
      const capsRes = await client.request<{ capabilities?: NodeCapabilities }>(
        "federation.capabilities.local",
        {},
      ).catch(() => null);

      const localNode: FederationNode = {
        id: state.localNodeId || "local",
        name: configRes?.config?.nodeName as string || "This Device",
        status: "online",
        role: "master",
        platform: (capsRes?.capabilities?.platform || "windows") as FederationNode["platform"],
        lastSeen: Date.now(),
        capabilities: capsRes?.capabilities || {},
        isLocal: true,
      };

      // Add local node at the beginning
      state.nodes = [localNode, ...state.nodes.filter(n => n.id !== localNode.id)];
    }

    // Get connection status to master (for satellites)
    if (state.mode === "satellite") {
      const statusRes = await client.request<{ connected?: boolean; latency?: number }>(
        "federation.status",
        {},
      ).catch(() => null);

      if (statusRes) {
        state.connectionStatus = statusRes.connected ? "connected" : "disconnected";
      }
    } else if (state.mode === "master") {
      state.connectionStatus = "connected";
      
      // Load master URLs that satellites can use to connect
      const urlsRes = await client.request<{ urls?: Array<{ type: string; url: string; label: string }> }>(
        "federation.urls",
        {},
      ).catch(() => null);
      
      if (urlsRes?.urls) {
        state.masterUrls = urlsRes.urls.map(u => ({
          type: u.type as MasterUrlInfo["type"],
          url: u.url,
          label: u.label,
        }));
      }
    }

    // Set current node to local if not set
    if (!state.currentNodeId && state.localNodeId) {
      state.currentNodeId = state.localNodeId;
    }

  } catch (err: unknown) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    requestUpdate?.();
  }
}

/**
 * Load just the nodes list (lightweight refresh)
 */
export async function loadNodes(
  client: GatewayBrowserClient | null,
  state: FederationState,
  opts?: { quiet?: boolean },
  requestUpdate?: () => void,
): Promise<void> {
  if (!client) return;
  if (state.loading) return;

  state.loading = true;
  if (!opts?.quiet) state.error = null;
  requestUpdate?.();

  try {
    // Load both federation and mobile nodes
    const [fedRes, mobileRes] = await Promise.all([
      client.request<{ nodes?: Array<Record<string, unknown>> }>("federation.nodes.list", {}).catch(() => null),
      client.request<{ nodes?: Array<Record<string, unknown>> }>("node.list", {}).catch(() => null),
    ]);
    const fedNodes = (fedRes?.nodes ?? []).map(parseNodeFromApi);
    const mobileNodes = (mobileRes?.nodes ?? []).map(parseNodeFromApi);
    state.nodes = [...fedNodes, ...mobileNodes];
  } catch (err: unknown) {
    if (!opts?.quiet) {
      state.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    state.loading = false;
    requestUpdate?.();
  }
}

/**
 * Switch current node context
 */
export function setCurrentNode(
  state: FederationState,
  nodeId: string | null,
  requestUpdate?: () => void,
): void {
  state.currentNodeId = nodeId;
  // Persist selection
  try {
    if (nodeId) {
      localStorage.setItem("infinibot-current-node", nodeId);
    } else {
      localStorage.removeItem("infinibot-current-node");
    }
  } catch {
    // ignore storage errors
  }
  requestUpdate?.();
}

/**
 * Load persisted node selection
 */
export function loadPersistedNodeSelection(state: FederationState): void {
  try {
    const stored = localStorage.getItem("infinibot-current-node");
    if (stored) {
      state.currentNodeId = stored;
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Save federation configuration
 */
export async function saveFederationConfig(
  client: GatewayBrowserClient | null,
  state: FederationState,
  config: FederationConfig,
  requestUpdate?: () => void,
): Promise<boolean> {
  if (!client) return false;
  if (state.configSaving) return false;

  state.configSaving = true;
  state.error = null;
  requestUpdate?.();

  try {
    await client.request("federation.config.set", {
      mode: config.mode,
      masterUrl: config.masterUrl,
      name: config.name,
      advertise: config.advertise,
    });

    state.mode = config.mode;
    state.masterUrl = config.masterUrl || "";
    state.configDirty = false;

    return true;
  } catch (err: unknown) {
    state.error = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    state.configSaving = false;
    requestUpdate?.();
  }
}

/**
 * Connect to master node (for satellites)
 */
export async function connectToMaster(
  client: GatewayBrowserClient | null,
  state: FederationState,
  masterUrl: string,
  requestUpdate?: () => void,
): Promise<boolean> {
  if (!client) return false;

  state.connectionStatus = "connecting";
  state.error = null;
  requestUpdate?.();

  try {
    const res = await client.request<{ success?: boolean; nodeId?: string }>(
      "federation.connect",
      { masterUrl },
    );

    if (res?.success) {
      state.connectionStatus = "connected";
      state.masterUrl = masterUrl;
      // Refresh nodes after connecting
      await loadNodes(client, state, { quiet: true }, requestUpdate);
      return true;
    } else {
      state.connectionStatus = "disconnected";
      state.error = "Connection failed";
      return false;
    }
  } catch (err: unknown) {
    state.connectionStatus = "disconnected";
    state.error = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    requestUpdate?.();
  }
}

/**
 * Disconnect from master (for satellites)
 */
export async function disconnectFromMaster(
  client: GatewayBrowserClient | null,
  state: FederationState,
  requestUpdate?: () => void,
): Promise<void> {
  if (!client) return;

  try {
    await client.request("federation.disconnect", {});
    state.connectionStatus = "disconnected";
    state.nodes = state.nodes.filter((n) => n.isLocal);
  } catch (err: unknown) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    requestUpdate?.();
  }
}

/**
 * Add a new node (for masters)
 */
export async function addNode(
  client: GatewayBrowserClient | null,
  state: FederationState,
  nodeUrl: string,
  name?: string,
  requestUpdate?: () => void,
): Promise<boolean> {
  if (!client) return false;

  try {
    const res = await client.request<{ success?: boolean; node?: Record<string, unknown> }>(
      "federation.node.add",
      { url: nodeUrl, name },
    );

    if (res?.success && res.node) {
      state.nodes.push(parseNodeFromApi(res.node));
      requestUpdate?.();
      return true;
    }

    return false;
  } catch (err: unknown) {
    state.error = err instanceof Error ? err.message : String(err);
    requestUpdate?.();
    return false;
  }
}

/**
 * Remove a node (for masters)
 */
export async function removeNode(
  client: GatewayBrowserClient | null,
  state: FederationState,
  nodeId: string,
  requestUpdate?: () => void,
): Promise<boolean> {
  if (!client) return false;

  try {
    await client.request("federation.node.remove", { nodeId });
    state.nodes = state.nodes.filter((n) => n.id !== nodeId);
    
    if (state.currentNodeId === nodeId) {
      state.currentNodeId = state.localNodeId;
    }

    requestUpdate?.();
    return true;
  } catch (err: unknown) {
    state.error = err instanceof Error ? err.message : String(err);
    requestUpdate?.();
    return false;
  }
}

/**
 * Scan network for discoverable nodes
 */
export async function scanNetwork(
  client: GatewayBrowserClient | null,
  state: FederationState,
  requestUpdate?: () => void,
): Promise<FederationNode[]> {
  if (!client) return [];

  state.loading = true;
  requestUpdate?.();

  try {
    const res = await client.request<{ nodes?: Array<Record<string, unknown>> }>(
      "federation.scan",
      {},
    );

    const discovered = Array.isArray(res?.nodes) ? res.nodes.map(parseNodeFromApi) : [];
    return discovered;
  } catch (err: unknown) {
    state.error = err instanceof Error ? err.message : String(err);
    return [];
  } finally {
    state.loading = false;
    requestUpdate?.();
  }
}

// ── Helpers ───────────────────────────────────────────────

function parseNodeFromApi(raw: Record<string, unknown>): FederationNode {
  // Federation nodes have status: "registered", mobile nodes have connected: true
  const connected = Boolean(raw.connected) || raw.status === "registered" || raw.status === "online";
  const capabilities: NodeCapabilities = {};

  // Parse capabilities
  if (raw.capabilities && typeof raw.capabilities === "object") {
    const caps = raw.capabilities as Record<string, unknown>;
    capabilities.gpu = typeof caps.gpu === "string" ? caps.gpu : undefined;
    capabilities.ram = typeof caps.ram === "number" ? caps.ram : undefined;
    capabilities.hasOllama = Boolean(caps.hasOllama);
    capabilities.hasComfyUI = Boolean(caps.hasComfyUI);
    capabilities.hasVoice = Boolean(caps.hasVoice);
    capabilities.mcpServers = Array.isArray(caps.mcpServers) 
      ? caps.mcpServers.filter((s) => typeof s === "string") 
      : undefined;
    capabilities.agents = Array.isArray(caps.agents) 
      ? caps.agents.filter((a) => typeof a === "string") 
      : undefined;
  }

  // Also check top-level fields for capabilities
  const caps = Array.isArray(raw.caps) ? raw.caps : [];
  if (caps.includes("ollama")) capabilities.hasOllama = true;
  if (caps.includes("voice")) capabilities.hasVoice = true;
  if (caps.includes("comfyui")) capabilities.hasComfyUI = true;

  return {
    id: typeof raw.nodeId === "string" ? raw.nodeId : String(raw.id || "unknown"),
    name: typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : typeof raw.name === "string" 
        ? raw.name 
        : typeof raw.nodeId === "string" 
          ? raw.nodeId 
          : "Unknown Node",
    hostname: typeof raw.hostname === "string" ? raw.hostname : undefined,
    remoteIp: typeof raw.remoteIp === "string" ? raw.remoteIp : undefined,
    status: connected ? "online" : "offline",
    role: raw.role === "master" ? "master" : "satellite",
    latency: typeof raw.latency === "number" ? raw.latency : undefined,
    lastSeen: typeof raw.lastSeen === "number" ? raw.lastSeen : Date.now(),
    capabilities,
    version: typeof raw.version === "string" ? raw.version : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace : undefined,
    isLocal: Boolean(raw.isLocal ?? raw.local),
  };
}

/**
 * Get the current node object
 */
export function getCurrentNode(state: FederationState): FederationNode | null {
  if (!state.currentNodeId) return null;
  return state.nodes.find((n) => n.id === state.currentNodeId) ?? null;
}

/**
 * Get only online nodes
 */
export function getOnlineNodes(state: FederationState): FederationNode[] {
  return state.nodes.filter((n) => n.status === "online");
}

/**
 * Format node capabilities for display
 */
export function formatCapabilities(caps: NodeCapabilities): string {
  const parts: string[] = [];
  
  if (caps.gpu) parts.push(`GPU: ${caps.gpu}`);
  if (caps.ram) parts.push(`RAM: ${caps.ram}GB`);
  if (caps.hasOllama) parts.push("Ollama");
  if (caps.hasVoice) parts.push("Voice");
  if (caps.hasComfyUI) parts.push("ComfyUI");
  if (caps.agents?.length) parts.push(`${caps.agents.length} agents`);
  if (caps.mcpServers?.length) parts.push(`${caps.mcpServers.length} MCP servers`);
  
  return parts.join(" · ");
}

/**
 * Check if federation features are available
 */
export function isFederationEnabled(state: FederationState): boolean {
  return state.mode !== "standalone" || state.nodes.length > 1;
}
