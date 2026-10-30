/**
 * Agent Management Controller
 * Real integration with InfiniBot config and state
 * Follows the pattern of skills.ts and other controllers
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { gatewayHttpUrl } from "../gateway-endpoint";

// Helper to patch config with proper format
async function patchConfig(
  client: GatewayBrowserClient,
  patch: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await client.request("config.patch", {
      raw: JSON.stringify(patch),
    });
    return (res as any)?.ok !== false;
  } catch (err) {
    console.error("Config patch failed:", err);
    return false;
  }
}

// ============================================================
// Types
// ============================================================

export type AgentType = "native" | "cli";

export interface AgentIdentityConfig {
  /**
   * Avatar source — accepts a `data:` URI (uploaded images are stored this
   * way), an http(s) URL, or a workspace-relative path served through the
   * gateway's `/avatar/<id>` route.
   */
  avatar?: string;
  description?: string;
}

export interface InfiniBotAgent {
  id: string;
  name?: string;
  workspace: string;
  agentDir?: string;
  /** Discriminant: "native" (direct LLM API) or "cli" (spawned subprocess). Defaults to "native". */
  type?: AgentType;
  model?: string;
  default?: boolean;
  disabled?: boolean;
  identity?: AgentIdentityConfig;
  systemPrompt?: string;
  tools?: {
    allow?: string[];
  };
  skills?: string[] | {
    allow?: string[];
  };
  mcp?: {
    allow?: string[];
  };
  subagents?: {
    allowAgents?: string[];
  };
  references?: string[];
  // CLI agent fields
  /** CLI executable name or path (e.g. "claude", "codex"). Only for type="cli". */
  cliCommand?: string;
  /** Extra arguments appended to the CLI command. Only for type="cli". */
  cliArgs?: string[];
  /** Whether to run with full auto-approve (--dangerously-skip-permissions). Only for type="cli". */
  autoApprove?: boolean;
  /** Hard timeout in minutes for the spawned process. Only for type="cli". */
  timeoutMinutes?: number;
  /** Allowed tool categories for the CLI agent (Edit, Bash, Read, etc.). Only for type="cli". */
  allowedTools?: string[];
  /** Roster-seed marker written by standard-roster / plugin seeders. */
  _seedVersion?: string;
  /** Owning plugin id for plugin-contributed roster agents. */
  _plugin?: string;
  /** Secure Mode: this agent only ever runs in the secure lane. */
  secureOnly?: boolean;
}

export interface AgentSessionInfo {
  key: string;
  label?: string;
  derivedTitle?: string;
  displayName?: string;
  kind: string;
  channel?: string;
  updatedAt: number | null;
  active: boolean;
  totalTokens?: number;
}

export interface AgentListEntry {
  id: string;
  name: string;
  workspace: string;
  type: AgentType;
  model: string;
  isDefault: boolean;
  isDisabled: boolean;
  sessionCount: number;
  activeSessionCount: number;
  sessions: AgentSessionInfo[];
  systemPrompt: string;
  tools: string[];
  skills: string[];
  mcps: string[];
  subagents: string[];
  references: string[];
  // CLI agent fields
  cliCommand: string;
  cliArgs: string[];
  autoApprove: boolean;
  timeoutMinutes: number;
  allowedTools: string[];
  /**
   * Resolved avatar URL for the gallery card thumbnail. Empty string when
   * no avatar is set — the card then renders a deterministic gradient tile
   * keyed off the agent id.
   */
  avatarUrl: string;
  /** Owning plugin id when the agent was contributed by a plugin pack (`_plugin`). */
  plugin: string | null;
  /** Roster-seed marker (`_seedVersion`); set for seeded core + plugin agents. */
  seedVersion: string | null;
  /** Free-text description from `identity.description`. */
  description: string;
  /** `secureOnly` — always run in Secure Mode (normal-lane runs are refused). */
  secureOnly?: boolean;
}

export interface AgentsManagementState {
  agents: AgentListEntry[];
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;
  editingAgent: Partial<InfiniBotAgent> | null;
  showCreateDialog: boolean;
  isDirty: boolean;
  /** The global default system prompt from agents.defaults.systemPrompt */
  defaultSystemPrompt: string;
  /** The default workspace path from agents.defaults.workspace */
  defaultWorkspace: string;
  /** Available models grouped by provider */
  availableModels: Record<string, string[]>;
  /** Available skills */
  availableSkills: string[];
  /** Available tools */
  availableTools: string[];
  /** Available MCP servers */
  availableMcps: string[];
  /** agents.defaults.model primary ("provider/model"), used when an agent has no model of its own. */
  defaultModel?: string;
}

// ============================================================
// API Functions
// ============================================================

export async function loadAgentsList(
  state: AppViewState,
  client: GatewayBrowserClient
): Promise<void> {
  if (!state.agentsManagementState) {
    state.agentsManagementState = {
      agents: [],
      loading: true,
      error: null,
      selectedAgentId: null,
      editingAgent: null,
      showCreateDialog: false,
      isDirty: false,
      defaultSystemPrompt: "",
      defaultWorkspace: "",
      availableModels: {},
      availableSkills: [],
      availableTools: [
        "exec", "read", "write", "edit", "web_search", "web_fetch", "browser", 
        "kanban", "image", "sessions_spawn", "subagent_progress", "subagents_list", 
        "cron", "message", "gateway", "tts", "vision", "memory_search", "memory_get", 
        "notes", "research", "workflows", "budget"
      ],
      availableMcps: [],
    };
  }

  state.agentsManagementState.loading = true;
  state.agentsManagementState.error = null;

  try {
    const res = (await client.request("config.get", {})) as any;

    if (!res) {
      throw new Error("Failed to load config");
    }

    const snapshot = res as any;
    // config.get returns a snapshot with config nested under .config
    const config = snapshot?.config || snapshot;
    const agentsList = config?.agents?.list || [];
    const defaults = config?.agents?.defaults || {};

    // Store global defaults
    state.agentsManagementState.defaultSystemPrompt = defaults.systemPrompt || "";
    state.agentsManagementState.defaultWorkspace = defaults.workspace || "";
    state.agentsManagementState.defaultModel =
      (typeof defaults.model === "string" ? defaults.model : defaults.model?.primary) || "";

    // Load available models from config.models.providers
    const modelsConfig = config?.models?.providers || {};
    const availableModels: Record<string, string[]> = {};
    for (const [provider, providerConfig] of Object.entries(modelsConfig)) {
      if (providerConfig && typeof providerConfig === 'object') {
        const models = (providerConfig as any).models || {};
        availableModels[provider] = Object.keys(models);
      }
    }
    state.agentsManagementState.availableModels = availableModels;

    // Load available skills (via skills.status - returns SkillStatusReport)
    try {
      const skillsRes = await client.request("skills.status", {});
      const skillEntries = (skillsRes as any)?.skills || [];
      state.agentsManagementState.availableSkills = skillEntries.map((s: any) => s.name).filter(Boolean);
    } catch {
      // Skills status unavailable
      state.agentsManagementState.availableSkills = [];
    }

    // Load available MCP servers (external only - from federation discovery)
    try {
      const mcpRes = await client.request("federation.resources.mcp", {});
      const mcpServers = (mcpRes as any)?.servers || [];
      // Each MCP has { id, name, ... } - use name as the identifier
      state.agentsManagementState.availableMcps = mcpServers
        .map((m: any) => m.name || m.id)
        .filter(Boolean)
        .filter((name: string, idx: number, arr: string[]) => arr.indexOf(name) === idx)
        .sort();
    } catch {
      // External MCP list unavailable
      state.agentsManagementState.availableMcps = [];
    }

    // Fetch real sessions to get counts and names per agent
    let sessionRows: any[] = [];
    try {
      const sessRes = (await client.request("sessions.list", {
        activeMinutes: 1440, // last 24h
        limit: 100,
        includeDerivedTitles: true,
        includeLastMessage: true,
      })) as any;
      sessionRows = sessRes?.sessions || [];
    } catch {
      // Sessions unavailable � continue without
    }

    // Group sessions by agent ID
    const sessionsByAgent = new Map<string, AgentSessionInfo[]>();
    for (const row of sessionRows) {
      // Parse agent ID from session key like "agent:main:main" or "agent:webdev:subagent:..."
      const parts = (row.key || "").split(":");
      const agentId = parts[0] === "agent" ? (parts[1] || "unknown") : "unknown";
      const isSubagent = row.key?.includes("subagent") ?? false;
      const activeThreshold = isSubagent ? 600000 : 120000;
      const isActive = row.updatedAt ? (Date.now() - row.updatedAt) < activeThreshold : false;

      const info: AgentSessionInfo = {
        key: row.key,
        label: row.label,
        derivedTitle: row.derivedTitle,
        displayName: row.displayName || row.label || row.derivedTitle || row.key,
        kind: isSubagent ? "subagent" : (agentId === "main" ? "main" : "other"),
        channel: row.lastChannel || row.channel,
        updatedAt: row.updatedAt,
        active: isActive,
        totalTokens: row.totalTokens,
      };

      if (!sessionsByAgent.has(agentId)) sessionsByAgent.set(agentId, []);
      sessionsByAgent.get(agentId)!.push(info);
    }

    // Convert to display format with real session data
    const agents: AgentListEntry[] = agentsList.map((a: InfiniBotAgent) => {
      const agentSessions = sessionsByAgent.get(a.id) || [];
      const activeSessions = agentSessions.filter(s => s.active);
      return {
        id: a.id,
        name: a.name || a.id,
        workspace: a.workspace,
        type: (a.type as AgentType) || "native",
        // `model` may be a string or `{ primary, fallbacks }` (AgentModelSchema).
        model:
          (typeof a.model === "string"
            ? a.model
            : (a.model as { primary?: string } | undefined)?.primary) || "default",
        isDefault: a.default ?? false,
        isDisabled: a.disabled ?? false,
        sessionCount: agentSessions.length,
        activeSessionCount: activeSessions.length,
        sessions: agentSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        systemPrompt: a.systemPrompt || "",
        tools: a.tools?.allow || [],
        // Canonical config shape is `string[]`; legacy `{ allow }` still accepted.
        skills: Array.isArray(a.skills) ? (a.skills as string[]) : a.skills?.allow || [],
        mcps: a.mcp?.allow || [],
        subagents: a.subagents?.allowAgents || [],
        references: a.references || [],
        cliCommand: a.cliCommand || "",
        cliArgs: a.cliArgs || [],
        autoApprove: a.autoApprove ?? false,
        timeoutMinutes: a.timeoutMinutes ?? 30,
        allowedTools: a.allowedTools || [],
        avatarUrl: resolveAvatarUrlForCard(a),
        plugin: typeof a._plugin === "string" && a._plugin ? a._plugin : null,
        seedVersion: typeof a._seedVersion === "string" && a._seedVersion ? a._seedVersion : null,
        description: a.identity?.description || "",
        secureOnly: a.secureOnly === true,
      };
    });

    state.agentsManagementState.agents = agents;
    state.agentsManagementState.loading = false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    state.agentsManagementState.loading = false;
  }
}

export async function createAgentEntry(
  state: AppViewState,
  client: GatewayBrowserClient,
  agent: Partial<InfiniBotAgent>
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    // Validate required fields
    if (!agent.id || !agent.workspace) {
      state.agentsManagementState.error = "Agent ID and workspace are required";
      return false;
    }

    // Check for duplicate
    if (state.agentsManagementState.agents.some((a) => a.id === agent.id)) {
      state.agentsManagementState.error = `Agent "${agent.id}" already exists`;
      return false;
    }

    // Get current config
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) {
      throw new Error("Failed to get current config");
    }

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    // Add new agent
    const newAgent: Record<string, unknown> = {
      id: agent.id,
      name: agent.name || agent.id,
      workspace: agent.workspace,
      type: agent.type || "native",
    };
    if (agent.agentDir) newAgent.agentDir = agent.agentDir;
    if (agent.model) newAgent.model = agent.model;
    if (agent.default) newAgent.default = agent.default;
    if (agent.systemPrompt?.trim()) newAgent.systemPrompt = agent.systemPrompt.trim();
    // CLI-specific fields
    if (agent.type === "cli") {
      if (agent.cliCommand) newAgent.cliCommand = agent.cliCommand;
      if (agent.cliArgs?.length) newAgent.cliArgs = agent.cliArgs;
      newAgent.autoApprove = agent.autoApprove ?? false;
      newAgent.timeoutMinutes = agent.timeoutMinutes ?? 30;
      if (agent.allowedTools?.length) newAgent.allowedTools = agent.allowedTools;
    }
    agentsList.push(newAgent);

    // Patch config
    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    // Reload
    await loadAgentsList(state, client);
    state.agentsManagementState.showCreateDialog = false;
    state.agentsManagementState.editingAgent = null;
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function deleteAgentEntry(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    // Get current config
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) {
      throw new Error("Failed to get current config");
    }

    const config = configRes?.config || configRes;
    const agentsList = (config?.agents?.list || []).filter(
      (a: InfiniBotAgent) => a.id !== agentId
    );

    // Patch config
    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    // Reload
    await loadAgentsList(state, client);
    if (state.agentsManagementState.selectedAgentId === agentId) {
      state.agentsManagementState.selectedAgentId = null;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function setDefaultAgent(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    // Get current config
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) {
      throw new Error("Failed to get current config");
    }

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    // Set all to non-default, then set target
    agentsList.forEach((a: InfiniBotAgent) => (a.default = false));
    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx >= 0) {
      agentsList[idx].default = true;
    }

    // Patch config
    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    // Reload
    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function updateAgentSystemPrompt(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  systemPrompt: string
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    // Set or clear systemPrompt
    const trimmed = systemPrompt.trim();
    if (trimmed && trimmed !== "default") {
      agentsList[idx] = { ...agentsList[idx], systemPrompt: trimmed };
    } else {
      const { systemPrompt: _removed, ...rest } = agentsList[idx];
      agentsList[idx] = rest;
    }

    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

// ============================================================
// New Configuration Functions
// ============================================================

export async function updateAgentModel(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  model: string
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    // Update model
    if (model && model !== "default") {
      agentsList[idx] = { ...agentsList[idx], model };
    } else {
      const { model: _removed, ...rest } = agentsList[idx];
      agentsList[idx] = rest;
    }

    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

/**
 * Set / clear `secureOnly` (always run in Secure Mode) on one agent. Goes
 * through agents.management.update, which writes the config without the
 * gateway restart config.patch schedules.
 */
export async function updateAgentSecureOnly(
  client: GatewayBrowserClient,
  agentId: string,
  on: boolean
): Promise<void> {
  const res = (await client.request("agents.management.update", { id: agentId, secureOnly: on })) as
    | { agent?: { secureOnly?: boolean } }
    | undefined;
  if (Boolean(res?.agent?.secureOnly) !== on) {
    throw new Error("This gateway build does not save the Secure Mode agent policy yet — restart it onto the new build.");
  }
}

/** Set an agent's primary model without the config.patch restart (agents.management.update). */
export async function setAgentPrimaryModel(client: GatewayBrowserClient, agentId: string, model: string): Promise<void> {
  await client.request("agents.management.update", { id: agentId, model });
}

export async function updateAgentType(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  type: AgentType
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    agentsList[idx] = { ...agentsList[idx], type };

    // If switching to native, clear CLI fields
    if (type === "native") {
      delete agentsList[idx].cliCommand;
      delete agentsList[idx].cliArgs;
      delete agentsList[idx].autoApprove;
      delete agentsList[idx].timeoutMinutes;
      delete agentsList[idx].allowedTools;
    }

    // If switching to cli, clear native-only fields
    if (type === "cli") {
      delete agentsList[idx].model;
      delete agentsList[idx].systemPrompt;
    }

    await patchConfig(client, { agents: { ...config?.agents, list: agentsList } });
    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function updateAgentCLIConfig(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  updates: {
    cliCommand?: string;
    cliArgs?: string[];
    autoApprove?: boolean;
    timeoutMinutes?: number;
    allowedTools?: string[];
  }
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    agentsList[idx] = { ...agentsList[idx], ...updates };

    await patchConfig(client, { agents: { ...config?.agents, list: agentsList } });
    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function updateAgentTools(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  tools: string[]
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    // Update tools allowlist
    agentsList[idx] = {
      ...agentsList[idx],
      tools: tools.length > 0 ? { allow: tools } : undefined,
    };

    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function updateAgentSkills(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  skills: string[]
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    // Update skills allowlist
    agentsList[idx] = {
      ...agentsList[idx],
      skills: skills.length > 0 ? { allow: skills } : undefined,
    };

    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function updateAgentMcps(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  mcps: string[]
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    // Update MCP allowlist
    agentsList[idx] = {
      ...agentsList[idx],
      mcp: mcps.length > 0 ? { allow: mcps } : undefined,
    };

    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function updateAgentSubagents(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  subagents: string[]
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    // Update subagents allowlist
    agentsList[idx] = {
      ...agentsList[idx],
      subagents: subagents.length > 0 ? { allowAgents: subagents } : undefined,
    };

    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

export async function updateAgentReferences(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  references: string[]
): Promise<boolean> {
  if (!state.agentsManagementState) return false;

  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");

    const config = configRes?.config || configRes;
    const agentsList = [...(config?.agents?.list || [])];

    const idx = agentsList.findIndex((a: InfiniBotAgent) => a.id === agentId);
    if (idx < 0) {
      state.agentsManagementState.error = `Agent "${agentId}" not found`;
      return false;
    }

    // Update references
    agentsList[idx] = {
      ...agentsList[idx],
      references: references.length > 0 ? references : undefined,
    };

    await patchConfig(client, { agents: {
          ...config?.agents,
          list: agentsList,
        },
      });

    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.agentsManagementState.error = msg;
    return false;
  }
}

// ============================================================
// Avatar / identity helpers
// ============================================================

/** Hard cap on uploaded avatars — config is loaded into memory on every
 *  config.get, so multi-MB data URIs would balloon every load. ~512KB
 *  fits comfortably for a square thumbnail. */
const MAX_AVATAR_BYTES = 512 * 1024;

/**
 * Decide the card thumbnail URL for an agent. Priority:
 *  1. data: URIs render inline (uploaded avatars live here).
 *  2. http(s) URLs render directly.
 *  3. Any other non-empty value (workspace-relative path) is served
 *     through the gateway's existing /avatar/<id> route.
 *  4. No avatar set → empty string → card draws the gradient default.
 */
function resolveAvatarUrlForCard(a: InfiniBotAgent): string {
  const raw = a.identity?.avatar?.trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("http://") || lower.startsWith("https://")) {
    return raw;
  }
  return gatewayHttpUrl(`/avatar/${encodeURIComponent(a.id)}?t=${Date.now()}`);
}

/**
 * Read a File as a data URI and patch the agent's identity.avatar via
 * config.patch. Surfaces errors through agentsManagementState.error.
 */
export async function uploadAgentAvatar(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  file: File,
): Promise<boolean> {
  if (!state.agentsManagementState) return false;
  if (!file.type.startsWith("image/")) {
    state.agentsManagementState.error = "Avatar must be an image file";
    return false;
  }
  if (file.size > MAX_AVATAR_BYTES) {
    state.agentsManagementState.error =
      `Image too large (${Math.round(file.size / 1024)} KB) — keep avatars under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB`;
    return false;
  }

  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.onload = () => {
      const out = reader.result;
      if (typeof out !== "string") {
        reject(new Error("Unexpected FileReader payload"));
        return;
      }
      resolve(out);
    };
    reader.readAsDataURL(file);
  }).catch((err: Error) => {
    if (state.agentsManagementState) state.agentsManagementState.error = err.message;
    return "";
  });
  if (!dataUri) return false;

  return updateAgentIdentity(state, client, agentId, { avatar: dataUri });
}

/** Clear the avatar back to the gradient default. */
export async function clearAgentAvatar(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
): Promise<boolean> {
  return updateAgentIdentity(state, client, agentId, { avatar: "" });
}

async function updateAgentIdentity(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
  patch: Partial<AgentIdentityConfig>,
): Promise<boolean> {
  if (!state.agentsManagementState) return false;
  try {
    const configRes = (await client.request("config.get", {})) as any;
    if (!configRes) throw new Error("Failed to get current config");
    const config = configRes?.config || configRes;
    const agentsList = [...((config?.agents?.list as InfiniBotAgent[]) || [])];
    const idx = agentsList.findIndex((a) => a.id === agentId);
    if (idx === -1) throw new Error(`Agent "${agentId}" not found`);

    const existing = agentsList[idx].identity ?? {};
    const next: AgentIdentityConfig = { ...existing };
    if (patch.avatar !== undefined) {
      if (patch.avatar) next.avatar = patch.avatar;
      else delete next.avatar;
    }
    if (patch.description !== undefined) {
      if (patch.description) next.description = patch.description;
      else delete next.description;
    }
    agentsList[idx] = {
      ...agentsList[idx],
      identity: Object.keys(next).length > 0 ? next : undefined,
    };

    await patchConfig(client, { agents: { ...config?.agents, list: agentsList } });
    await loadAgentsList(state, client);
    return true;
  } catch (err) {
    if (state.agentsManagementState) {
      state.agentsManagementState.error = err instanceof Error ? err.message : "Unknown error";
    }
    return false;
  }
}

/**
 * Deterministic gradient + initial for the default card thumbnail.
 * Hashing the agent id keeps each agent's tile stable across reloads so
 * operators recognise them by colour alone. Saturation is deliberately
 * low so the tile reads as a refined slate instead of a poster paint.
 */
export function defaultAvatarStyle(agentId: string): { gradient: string; initial: string } {
  const id = agentId || "?";
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 24) % 360;
  const gradient = `linear-gradient(135deg, hsl(${h1} 22% 22%) 0%, hsl(${h2} 26% 12%) 100%)`;
  const initial = id.charAt(0).toUpperCase();
  return { gradient, initial };
}

