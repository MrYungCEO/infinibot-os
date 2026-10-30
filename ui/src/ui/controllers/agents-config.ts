/**
 * Agent Configuration & Specialization
 * Handles agent metadata, tools, specialties, and MCP bindings
 */

import type { GatewayBrowserClient } from "../gateway";

// ============================================================
// MCP Management
// ============================================================

export interface InstalledMcp {
  id: string;
  name: string;
  description?: string;
  installed: boolean;
  isDefault: boolean;
}

export async function getInstalledMcps(
  client: GatewayBrowserClient
): Promise<InstalledMcp[]> {
  try {
    const config = (await client.request("config.get", {})) as any;
    
    // Default MCPs that should always be available
    const defaultMcps = ["tasks", "kanban", "memory", "code"];
    const mcpMap = new Map<string, InstalledMcp>();
    
    // Add defaults
    defaultMcps.forEach(id => {
      mcpMap.set(id, {
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        description: `Default MCP: ${id}`,
        installed: true,
        isDefault: true,
      });
    });
    
    // Add custom MCPs from config if they exist
    const customMcps = config?.mcp?.installed || [];
    if (Array.isArray(customMcps)) {
      customMcps.forEach((mcp: any) => {
        const id = typeof mcp === "string" ? mcp : mcp.id;
        if (id && !mcpMap.has(id)) {
          mcpMap.set(id, {
            id,
            name: typeof mcp === "string" ? id : mcp.name || id,
            description: typeof mcp === "object" ? mcp.description : undefined,
            installed: true,
            isDefault: false,
          });
        }
      });
    }
    
    return Array.from(mcpMap.values());
  } catch (err) {
    console.error("Failed to fetch installed MCPs:", err);
    // Fallback to defaults
    const defaultMcps = ["tasks", "kanban", "memory", "code"];
    return defaultMcps.map(id => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      description: `Default MCP: ${id}`,
      installed: true,
      isDefault: true,
    }));
  }
}

// ============================================================
// Types
// ============================================================

export interface AgentSpecialty {
  name: string;
  description?: string;
  keywords?: string[];
}

export interface AgentToolConfig {
  available: string[];
  restricted?: string[];
}

export interface AgentMcpConfig {
  enabled?: string[];
  protocols?: Record<string, Record<string, unknown>>;
}

export type AgentType = "native" | "cli";

export interface AgentProfile {
  id: string;
  name: string;
  workspace: string;
  type: AgentType;
  description: string;
  specialties: string[];
  tools: AgentToolConfig;
  mcp?: AgentMcpConfig;
  systemPrompt?: string;
  maxConcurrent?: number;
  model?: string;
  // CLI agent fields
  cliCommand?: string;
  cliArgs?: string[];
  autoApprove?: boolean;
  timeoutMinutes?: number;
  allowedTools?: string[];
}

export interface AgentCapabilities {
  id: string;
  name: string;
  specialties: string[];
  tools: string[];
  availableMcp: string[];
  workload?: {
    current: number;
    queued: number;
    maxConcurrent: number;
  };
}

// ============================================================
// Agent Discovery & Introspection
// ============================================================

export async function getAgentProfiles(
  client: GatewayBrowserClient
): Promise<AgentProfile[]> {
  try {
    // `config.get` is the served method (the colon-namespaced
    // `gateway:config.*` names were never registered) and it resolves with
    // the config-file snapshot itself — no ok/result envelope.
    const res = await client.request("config.get", {}) as any;
    const config = res?.config as any;
    const agents = config?.agents?.list || [];

    return agents.map((a: any) => ({
      id: a.id,
      name: a.name || a.id,
      workspace: a.workspace,
      type: a.type || "native",
      description: a.description || "No description",
      specialties: a.specialties || [],
      tools: a.tools || { available: [] },
      mcp: a.mcp || {},
      systemPrompt: a.systemPrompt,
      maxConcurrent: a.maxConcurrent,
      model: a.model,
      cliCommand: a.cliCommand,
      cliArgs: a.cliArgs,
      autoApprove: a.autoApprove,
      timeoutMinutes: a.timeoutMinutes,
      allowedTools: a.allowedTools,
    }));
  } catch (err) {
    console.error("Failed to get agent profiles:", err);
    return [];
  }
}

export async function getAgentCapabilities(
  client: GatewayBrowserClient,
  agentId: string
): Promise<AgentCapabilities | null> {
  try {
    const profiles = await getAgentProfiles(client);
    const profile = profiles.find((p) => p.id === agentId);

    if (!profile) return null;

    return {
      id: profile.id,
      name: profile.name,
      specialties: profile.specialties,
      tools: profile.tools.available,
      availableMcp: profile.mcp?.enabled || [],
      workload: {
        current: 0, // TODO: fetch from sessions
        queued: 0,
        maxConcurrent: profile.maxConcurrent || 4,
      },
    };
  } catch (err) {
    console.error("Failed to get agent capabilities:", err);
    return null;
  }
}

export async function getAgentsForSpecialty(
  client: GatewayBrowserClient,
  specialty: string
): Promise<AgentCapabilities[]> {
  try {
    const profiles = await getAgentProfiles(client);
    return profiles
      .filter((p) => p.specialties.includes(specialty))
      .map((p) => ({
        id: p.id,
        name: p.name,
        specialties: p.specialties,
        tools: p.tools.available,
        availableMcp: p.mcp?.enabled || [],
      }));
  } catch (err) {
    console.error("Failed to get agents for specialty:", err);
    return [];
  }
}

export async function findBestAgent(
  client: GatewayBrowserClient,
  options: {
    requiredSpecialties?: string[];
    requiredTools?: string[];
    requiredMcp?: string[];
    avoid?: string[];
  }
): Promise<AgentCapabilities | null> {
  try {
    const profiles = await getAgentProfiles(client);

    // Filter by requirements
    let candidates = profiles.filter((p) => {
      if (options.avoid?.includes(p.id)) return false;

      // Check specialties
      if (
        options.requiredSpecialties?.length &&
        !options.requiredSpecialties.some((s) => p.specialties.includes(s))
      ) {
        return false;
      }

      // Check tools
      if (
        options.requiredTools?.length &&
        !options.requiredTools.every((t) => p.tools.available.includes(t))
      ) {
        return false;
      }

      // Check MCP
      if (
        options.requiredMcp?.length &&
        !options.requiredMcp.every((m) => p.mcp?.enabled?.includes(m))
      ) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) return null;

    // Sort by specialties count (most specialized first)
    candidates.sort((a, b) => b.specialties.length - a.specialties.length);

    const best = candidates[0];
    return {
      id: best.id,
      name: best.name,
      specialties: best.specialties,
      tools: best.tools.available,
      availableMcp: best.mcp?.enabled || [],
    };
  } catch (err) {
    console.error("Failed to find best agent:", err);
    return null;
  }
}

// ============================================================
// Agent Configuration Updates
// ============================================================

export async function updateAgentProfile(
  client: GatewayBrowserClient,
  agentId: string,
  updates: Partial<AgentProfile>
): Promise<boolean> {
  try {
    const res = await client.request("config.get", {}) as any;
    const config = res?.config as any;
    const agents = [...(config?.agents?.list || [])];
    const idx = agents.findIndex((a: any) => a.id === agentId);

    if (idx === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    // Merge updates
    agents[idx] = {
      ...agents[idx],
      ...(updates.name && { name: updates.name }),
      ...(updates.description && { description: updates.description }),
      ...(updates.specialties && { specialties: updates.specialties }),
      ...(updates.tools && { tools: updates.tools }),
      ...(updates.mcp && { mcp: updates.mcp }),
      ...(updates.systemPrompt && { systemPrompt: updates.systemPrompt }),
      // Agent type fields
      ...(updates.type !== undefined && { type: updates.type }),
      ...(updates.cliCommand !== undefined && { cliCommand: updates.cliCommand }),
      ...(updates.cliArgs !== undefined && { cliArgs: updates.cliArgs }),
      ...(updates.autoApprove !== undefined && { autoApprove: updates.autoApprove }),
      ...(updates.timeoutMinutes !== undefined && { timeoutMinutes: updates.timeoutMinutes }),
      ...(updates.allowedTools !== undefined && { allowedTools: updates.allowedTools }),
    };

    // `config.patch` takes a raw JSON5 merge patch plus the snapshot hash
    // for optimistic concurrency.
    const baseHash = res?.hash;
    if (!baseHash) throw new Error("could not read config snapshot hash");
    await client.request("config.patch", {
      raw: JSON.stringify({ agents: { ...config?.agents, list: agents } }),
      baseHash,
    });

    return true;
  } catch (err) {
    console.error("Failed to update agent profile:", err);
    return false;
  }
}

export async function addSpecialty(
  client: GatewayBrowserClient,
  agentId: string,
  specialty: string
): Promise<boolean> {
  try {
    const profiles = await getAgentProfiles(client);
    const profile = profiles.find((p) => p.id === agentId);

    if (!profile) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    const specialties = [...new Set([...profile.specialties, specialty])];
    return updateAgentProfile(client, agentId, { specialties });
  } catch (err) {
    console.error("Failed to add specialty:", err);
    return false;
  }
}

export async function removeSpecialty(
  client: GatewayBrowserClient,
  agentId: string,
  specialty: string
): Promise<boolean> {
  try {
    const profiles = await getAgentProfiles(client);
    const profile = profiles.find((p) => p.id === agentId);

    if (!profile) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    const specialties = profile.specialties.filter((s) => s !== specialty);
    return updateAgentProfile(client, agentId, { specialties });
  } catch (err) {
    console.error("Failed to remove specialty:", err);
    return false;
  }
}

export async function updateAgentTools(
  client: GatewayBrowserClient,
  agentId: string,
  tools: { available: string[]; restricted?: string[] }
): Promise<boolean> {
  try {
    return updateAgentProfile(client, agentId, { tools });
  } catch (err) {
    console.error("Failed to update agent tools:", err);
    return false;
  }
}

export async function updateAgentMcp(
  client: GatewayBrowserClient,
  agentId: string,
  mcp: AgentMcpConfig
): Promise<boolean> {
  try {
    return updateAgentProfile(client, agentId, { mcp });
  } catch (err) {
    console.error("Failed to update agent MCP:", err);
    return false;
  }
}

// ============================================================
// Skill File Management
// ============================================================

export interface SkillFileInfo {
  skillId: string;
  path: string;
  content: string;
  exists: boolean;
}

/**
 * Get the content of a SKILL.md file for a given skill
 */
export async function getSkillFileContent(
  client: GatewayBrowserClient,
  skillId: string
): Promise<SkillFileInfo | null> {
  try {
    // Skills are located at infinibot/skills/{skillId}/SKILL.md
    const skillPath = `skills/${skillId}/SKILL.md`;
    
    // Served method is `files.read` (plural); it answers { path, content, size }.
    const result = await client.request("files.read", { path: skillPath }) as any;
    
    if (result?.content !== undefined) {
      return {
        skillId,
        path: skillPath,
        content: result.content,
        exists: true,
      };
    }
    
    return {
      skillId,
      path: skillPath,
      content: "",
      exists: false,
    };
  } catch (err) {
    console.error(`Failed to read skill file for ${skillId}:`, err);
    return null;
  }
}

/**
 * Save content to a SKILL.md file
 */
export async function saveSkillFileContent(
  client: GatewayBrowserClient,
  skillId: string,
  content: string
): Promise<boolean> {
  try {
    const skillPath = `skills/${skillId}/SKILL.md`;
    
    const result = await client.request("files.write", { 
      path: skillPath, 
      content 
    }) as any;
    
    // files.write answers { path, size, ... } — a resolved call is a success
    // (the client rejects on gateway errors).
    return result != null;
  } catch (err) {
    console.error(`Failed to save skill file for ${skillId}:`, err);
    return false;
  }
}

/**
 * Get all skill files for an agent's assigned skills
 */
export async function getAgentSkillFiles(
  client: GatewayBrowserClient,
  skills: string[]
): Promise<SkillFileInfo[]> {
  const results: SkillFileInfo[] = [];
  
  for (const skillId of skills) {
    const info = await getSkillFileContent(client, skillId);
    if (info) {
      results.push(info);
    }
  }
  
  return results;
}

/**
 * Get actual tools available to an agent (from config)
 */
export async function getAgentActualTools(
  client: GatewayBrowserClient,
  agentId: string
): Promise<string[]> {
  try {
    const config = (await client.request("config.get", {})) as any;
    const agentConfig = config?.config?.agents?.list?.find((a: any) => a.id === agentId);
    
    if (!agentConfig) return [];
    
    const tools = agentConfig.tools?.alsoAllow || agentConfig.tools?.allow || [];
    return Array.isArray(tools) ? tools : [];
  } catch (err) {
    console.error("Failed to get agent tools:", err);
    return [];
  }
}

/**
 * Get actual MCPs available to an agent (from Claude config)
 */
export async function getAgentActualMcps(
  client: GatewayBrowserClient
): Promise<string[]> {
  try {
    const result = await client.request("mcp.internal.list", {}) as {
      servers?: Array<{ name?: string }>;
    };
    return (result?.servers ?? [])
      .map((server) => server.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  } catch (err) {
    console.error("Failed to get MCPs:", err);
    return [];
  }
}
