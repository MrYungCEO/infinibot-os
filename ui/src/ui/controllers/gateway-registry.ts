/**
 * Gateway Registry — Manage connections to multiple Infinibot instances
 * 
 * Stores connections, fetches agents, handles cross-gateway routing
 */

import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway-browser-client";
import { gatewayWsBase, resolvedGatewayUrl } from "../gateway-endpoint";

// ── Types ─────────────────────────────────────────────────

export interface MCPServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  url?: string;
  command?: string[];
  args?: string[];
}

export interface AgentSkillConfig {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
}

export interface AgentToolConfig {
  name: string;
  enabled: boolean;
  label?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  gatewayId: string;
  gatewayName: string;
  
  // Config
  workspace?: string;
  systemPrompt?: string;
  model?: string;
  isDefault?: boolean;
  
  // MCP (per-agent)
  mcp: {
    servers: MCPServerConfig[];
    enabled: boolean;
  };
  
  // Skills (per-agent)
  skills: AgentSkillConfig[];
  
  // Tools (per-agent)
  tools: AgentToolConfig[];
  
  // Status
  status: "available" | "busy" | "offline";
  currentTasks: number;
}

export interface GatewayConnection {
  id: string;
  name: string;
  url: string;
  status: "connected" | "disconnected" | "connecting" | "error";
  isLocal: boolean;
  agents: AgentProfile[];
  lastSeen: number;
  capabilities: string[];
  version?: string;
  error?: string;
}

export interface GatewayRegistryState {
  gateways: GatewayConnection[];
  defaultGatewayId: string;
  loading: boolean;
  error: string | null;
  lastRefresh: number;
}

// ── State ─────────────────────────────────────────────────

const STORAGE_KEY = "infinibot-gateway-registry";

let registryState: GatewayRegistryState = {
  gateways: [],
  defaultGatewayId: "local",
  loading: false,
  error: null,
  lastRefresh: 0,
};

// ── Persistence ───────────────────────────────────────────

function loadFromStorage(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      // Only restore non-local gateways (local is always added fresh)
      registryState.gateways = (data.gateways || []).filter((g: GatewayConnection) => !g.isLocal);
      registryState.defaultGatewayId = data.defaultGatewayId || "local";
    }
  } catch (e) {
    console.warn("[GatewayRegistry] Failed to load from storage:", e);
  }
}

function saveToStorage(): void {
  try {
    const data = {
      gateways: registryState.gateways.filter(g => !g.isLocal), // Don't persist local
      defaultGatewayId: registryState.defaultGatewayId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("[GatewayRegistry] Failed to save to storage:", e);
  }
}

// ── Actions ───────────────────────────────────────────────

export function getRegistryState(): GatewayRegistryState {
  return registryState;
}

export function getAllAgents(): AgentProfile[] {
  const agents: AgentProfile[] = [];
  for (const gateway of registryState.gateways) {
    if (gateway.status === "connected") {
      agents.push(...gateway.agents);
    }
  }
  return agents;
}

export function getAgentsByGateway(): Map<string, AgentProfile[]> {
  const map = new Map<string, AgentProfile[]>();
  for (const gateway of registryState.gateways) {
    if (gateway.status === "connected" && gateway.agents.length > 0) {
      map.set(gateway.id, gateway.agents);
    }
  }
  return map;
}

export function findAgent(agentId: string, gatewayId?: string): AgentProfile | undefined {
  for (const gateway of registryState.gateways) {
    if (gatewayId && gateway.id !== gatewayId) continue;
    const agent = gateway.agents.find(a => a.id === agentId);
    if (agent) return agent;
  }
  return undefined;
}

export function getGateway(gatewayId: string): GatewayConnection | undefined {
  return registryState.gateways.find(g => g.id === gatewayId);
}

export function getLocalGateway(): GatewayConnection | undefined {
  return registryState.gateways.find(g => g.isLocal);
}

// ── Initialize Local Gateway ──────────────────────────────

async function initLocalGateway(state: AppViewState): Promise<GatewayConnection> {
  const client = state.client;
  if (!client) {
    throw new Error("No gateway client");
  }

  // Get config to extract agents. Served name is `config.get`
  // (`gateway:config.get` was never registered); it resolves with the
  // config-file snapshot, whose `config` field is the validated object.
  const config = await client.request("config.get", {}) as any;
  const parsedConfig = config?.config || config?.parsed || {};
  
  // Extract agents from config
  const agentsList = parsedConfig?.agents?.list || [];
  const agentDefaults = parsedConfig?.agents?.defaults || {};
  
  // Get available skills
  let availableSkills: AgentSkillConfig[] = [];
  try {
    // Served name is `skills.status`; it returns the same `{ skills: [...] }`
    // workspace report the picker needs.
    const skillsResult = await client.request("skills.status", {}) as any;
    availableSkills = (skillsResult?.skills || []).map((s: any) => ({
      id: s.id || s.name,
      name: s.name || s.id,
      enabled: true,
      description: s.description,
    }));
  } catch (e) {
    console.warn("[GatewayRegistry] Failed to fetch skills:", e);
  }
  
  // Get available MCP servers
  let availableMCPs: MCPServerConfig[] = [];
  try {
    const mcpResult = await client.request("mcp.servers.list", {});
    availableMCPs = (mcpResult?.servers || []).map((m: any) => ({
      id: m.id || m.name,
      name: m.name || m.id,
      enabled: m.enabled !== false,
      url: m.url,
      command: m.command,
      args: m.args,
    }));
  } catch (e) {
    // MCP might not be configured
  }
  
  // All standard tools
  const allTools: AgentToolConfig[] = [
    { name: "exec", enabled: true, label: "Execute Commands" },
    { name: "read", enabled: true, label: "Read Files" },
    { name: "write", enabled: true, label: "Write Files" },
    { name: "edit", enabled: true, label: "Edit Files" },
    { name: "web_search", enabled: true, label: "Web Search" },
    { name: "web_fetch", enabled: true, label: "Fetch URLs" },
    { name: "browser", enabled: true, label: "Browser Control" },
    { name: "nodes", enabled: true, label: "Node Control" },
    { name: "cron", enabled: true, label: "Cron Jobs" },
    { name: "message", enabled: true, label: "Messaging" },
    { name: "kanban", enabled: true, label: "Kanban Board" },
    { name: "notes", enabled: true, label: "Notes" },
    { name: "research", enabled: true, label: "Research" },
    { name: "workflows", enabled: true, label: "Workflows" },
    { name: "sessions_spawn", enabled: true, label: "Spawn Agents" },
    { name: "vision", enabled: true, label: "Vision" },
    { name: "tts", enabled: true, label: "Text-to-Speech" },
    { name: "image", enabled: true, label: "Image Analysis" },
  ];
  
  // Build agent profiles
  const agents: AgentProfile[] = agentsList.map((agent: any) => {
    const allowedTools = agent.tools?.allow || [];
    const deniedTools = agent.tools?.deny || [];
    
    return {
      id: agent.id,
      name: agent.name || capitalize(agent.id),
      gatewayId: "local",
      gatewayName: "Local",
      workspace: agent.workspace || agentDefaults.workspace,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      isDefault: agent.default === true,
      mcp: {
        servers: availableMCPs.map(m => ({ ...m })),
        enabled: true,
      },
      skills: availableSkills.map(s => ({ ...s })),
      tools: allTools.map(t => ({
        ...t,
        enabled: allowedTools.length === 0 
          ? !deniedTools.includes(t.name)
          : allowedTools.includes(t.name),
      })),
      status: "available" as const,
      currentTasks: 0,
    };
  });
  
  // If no agents defined, add a default
  if (agents.length === 0) {
    agents.push({
      id: "main",
      name: "Main",
      gatewayId: "local",
      gatewayName: "Local",
      workspace: agentDefaults.workspace,
      isDefault: true,
      mcp: { servers: availableMCPs, enabled: true },
      skills: availableSkills,
      tools: allTools,
      status: "available",
      currentTasks: 0,
    });
  }
  
  return {
    id: "local",
    name: parsedConfig?.instance?.name || "Infinibot",
    url: resolvedGatewayUrl() ? gatewayWsBase() : `ws://${window.location.host}`,
    status: "connected",
    isLocal: true,
    agents,
    lastSeen: Date.now(),
    capabilities: detectCapabilities(parsedConfig),
    version: parsedConfig?.version || config?.meta?.lastTouchedVersion,
  };
}

function detectCapabilities(config: any): string[] {
  const caps: string[] = [];
  if (config?.auth?.profiles?.["anthropic:clawd"]) caps.push("claude");
  if (config?.models?.providers?.ollama) caps.push("ollama");
  if (config?.channels?.telegram?.enabled !== false && config?.channels?.telegram?.botToken) caps.push("telegram");
  if (config?.channels?.discord?.botToken) caps.push("discord");
  if (config?.channels?.whatsapp?.enabled !== false) caps.push("whatsapp");
  return caps;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Add Remote Gateway ────────────────────────────────────

export async function addGateway(
  url: string,
  name?: string,
  state?: AppViewState
): Promise<GatewayConnection> {
  // Check if already exists
  const existing = registryState.gateways.find(g => g.url === url);
  if (existing) {
    return existing;
  }
  
  const gateway: GatewayConnection = {
    id: `remote-${Date.now()}`,
    name: name || new URL(url).hostname,
    url,
    status: "connecting",
    isLocal: false,
    agents: [],
    lastSeen: 0,
    capabilities: [],
  };
  
  registryState.gateways.push(gateway);
  state?.requestUpdate?.();
  
  // Try to connect and fetch agents
  await refreshGateway(gateway.id, state);
  saveToStorage();
  
  return gateway;
}

export function removeGateway(gatewayId: string, state?: AppViewState): void {
  const idx = registryState.gateways.findIndex(g => g.id === gatewayId);
  if (idx >= 0 && !registryState.gateways[idx].isLocal) {
    registryState.gateways.splice(idx, 1);
    saveToStorage();
    state?.requestUpdate?.();
  }
}

// ── Refresh ───────────────────────────────────────────────

async function refreshGateway(gatewayId: string, state?: AppViewState): Promise<void> {
  const gateway = registryState.gateways.find(g => g.id === gatewayId);
  if (!gateway) return;
  
  gateway.status = "connecting";
  state?.requestUpdate?.();
  
  try {
    if (gateway.isLocal && state?.client) {
      // Refresh local gateway
      const refreshed = await initLocalGateway(state);
      Object.assign(gateway, refreshed);
    } else {
      // Refresh remote gateway
      // TODO: Implement remote gateway client
      // For now, mark as error
      gateway.status = "error";
      gateway.error = "Remote gateway connection not yet implemented";
    }
  } catch (err: any) {
    gateway.status = "error";
    gateway.error = err.message;
  }
  
  state?.requestUpdate?.();
}

export async function refreshAllGateways(state: AppViewState): Promise<void> {
  registryState.loading = true;
  registryState.error = null;
  state.requestUpdate?.();
  
  try {
    // Initialize local gateway first
    const localGateway = await initLocalGateway(state);
    
    // Remove any existing local gateway and add fresh one
    registryState.gateways = registryState.gateways.filter(g => !g.isLocal);
    registryState.gateways.unshift(localGateway);
    
    // Refresh remote gateways
    const remoteRefreshes = registryState.gateways
      .filter(g => !g.isLocal)
      .map(g => refreshGateway(g.id, state));
    
    await Promise.allSettled(remoteRefreshes);
    
    registryState.lastRefresh = Date.now();
  } catch (err: any) {
    registryState.error = err.message;
  } finally {
    registryState.loading = false;
    state.requestUpdate?.();
  }
}

// ── Update Agent Config ───────────────────────────────────

export async function updateAgentConfig(
  agentId: string,
  gatewayId: string,
  updates: Partial<AgentProfile>,
  state?: AppViewState
): Promise<void> {
  const gateway = registryState.gateways.find(g => g.id === gatewayId);
  if (!gateway) throw new Error("Gateway not found");
  
  const agent = gateway.agents.find(a => a.id === agentId);
  if (!agent) throw new Error("Agent not found");
  
  // Update local state
  Object.assign(agent, updates);
  state?.requestUpdate?.();
  
  // If local gateway, persist to config
  if (gateway.isLocal && state?.client) {
    // Build config patch
    const configPatch: any = {
      agents: {
        list: gateway.agents.map(a => {
          if (a.id !== agentId) return undefined; // Only include changed agent
          return {
            id: a.id,
            name: a.name,
            workspace: a.workspace,
            systemPrompt: a.systemPrompt,
            model: a.model,
            default: a.isDefault,
            tools: {
              allow: a.tools.filter(t => t.enabled).map(t => t.name),
              deny: a.tools.filter(t => !t.enabled).map(t => t.name),
            },
            // MCP and skills would need separate handling
          };
        }).filter(Boolean),
      },
    };
    
    try {
      // `config.patch` takes a raw JSON5 merge patch + the current snapshot
      // hash for optimistic concurrency.
      const snapshot = await state.client.request("config.get", {}) as any;
      const baseHash = snapshot?.hash;
      if (!baseHash) throw new Error("could not read config snapshot hash");
      await state.client.request("config.patch", {
        raw: JSON.stringify(configPatch),
        baseHash,
      });
    } catch (err: any) {
      console.error("[GatewayRegistry] Failed to persist agent config:", err);
      throw err;
    }
  }
}

// ── Initialize ────────────────────────────────────────────

export async function initGatewayRegistry(state: AppViewState): Promise<void> {
  loadFromStorage();
  await refreshAllGateways(state);
}

export default {
  getRegistryState,
  getAllAgents,
  getAgentsByGateway,
  findAgent,
  getGateway,
  getLocalGateway,
  addGateway,
  removeGateway,
  refreshAllGateways,
  updateAgentConfig,
  initGatewayRegistry,
};
