/**
 * MCP Config Sync Bridge
 *
 * Generates scoped MCP configuration files for CLI agents.
 * Reads Moltbot's discovered MCP servers, filters by the agent's `enabledMCPs`,
 * and writes a per-agent config file that the CLI (e.g. `claude --mcp-config`)
 * can consume.
 *
 * Important: never overwrites the user's main ~/.claude/mcp.json.
 * Scoped configs are written to ~/.claude/mcp-infinibot-{agentId}.json.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  discoverLocalMCPServers,
  type MCPServerConfig,
  type MCPConfigFile,
} from "../../mcp/local-discovery.js";
import { INFINIBOT_MCP_ENTRY_KEY, buildInfinibotEntry } from "../../mcp/claude-code-register.js";
import { loadConfig } from "../../config/config.js";
import { resolveGatewayPort } from "../../config/paths.js";
import type { CLIAgentConfig, AgentConfig } from "../types/agent-types.js";

const log = createSubsystemLogger("mcp").child("bridge");

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface SyncResult {
  configPath: string;
  serverCount: number;
  serverNames: string[];
}

// ══════════════════════════════════════════════════════════════════════════════
// Paths
// ══════════════════════════════════════════════════════════════════════════════

/** Directory where scoped MCP configs are stored. */
function getScopedConfigDir(): string {
  return join(homedir(), ".claude");
}

/** Per-agent scoped config path. Never the user's main mcp.json. */
export function getScopedConfigPath(agentId: string): string {
  const sanitized = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(getScopedConfigDir(), `mcp-infinibot-${sanitized}.json`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Core
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Gather all available MCP server configs from the local discovery system.
 * Returns a map of server name -> config.
 */
function collectAvailableMCPs(): Map<string, MCPServerConfig> {
  const servers = discoverLocalMCPServers();
  const map = new Map<string, MCPServerConfig>();
  for (const server of servers) {
    map.set(server.name, server.config);
  }
  return map;
}

/**
 * Filter MCP servers to only those the agent is allowed to access.
 */
function filterMCPsForAgent(
  available: Map<string, MCPServerConfig>,
  enabledMCPs: string[],
): Map<string, MCPServerConfig> {
  const filtered = new Map<string, MCPServerConfig>();

  for (const name of enabledMCPs) {
    const config = available.get(name);
    if (config) {
      filtered.set(name, config);
    } else {
      log.warn(`agent requested MCP "${name}" but it is not configured locally`);
    }
  }

  return filtered;
}

/**
 * Build a Claude-compatible MCP config file object from the filtered servers.
 */
function buildMCPConfigFile(servers: Map<string, MCPServerConfig>): MCPConfigFile {
  const mcpServers: Record<string, MCPServerConfig> = {};
  for (const [name, config] of servers) {
    mcpServers[name] = config;
  }
  return { mcpServers };
}

/**
 * Build the InfiniBot self-MCP entry that every spawned Claude Code
 * instance gets. This is what gives the spawned Claude access to the
 * gateway's tool registry — memory_search / memory_get for self-
 * learning, workflows for the workflow runner, skills_status for the
 * skill catalogue, notes / research / kanban / sessions_history /
 * agents_list / message / mcp passthrough, etc.
 *
 * Using --strict-mcp-config means the spawned Claude only sees what
 * we explicitly hand it; without this injection it'd lose access to
 * everything the gateway agents have unless the operator remembered
 * to put "infinibot" in agent.enabledMCPs. We don't make that an
 * opt-in — it's the whole point of using `claude_coder` from inside
 * InfiniBot.
 *
 * Tagged with the agent's id as session key + label so activity feed
 * rows attribute back to the right spawn.
 */
function buildInfinibotSelfMcpEntry(agentId: string): MCPServerConfig | null {
  try {
    const cfg = loadConfig();
    const port = resolveGatewayPort(cfg);
    const gatewayUrl = `ws://127.0.0.1:${port}`;
    const auth = (cfg as any)?.gateway?.auth ?? {};
    const password =
      typeof auth.password === "string" && auth.password.trim() ? auth.password.trim() : undefined;
    const token =
      typeof auth.token === "string" && auth.token.trim() ? auth.token.trim() : undefined;

    const entry = buildInfinibotEntry({
      gatewayUrl,
      gatewayToken: token,
      gatewayPassword: password,
      defaultSessionKey: `claude-coder:${agentId}`,
    });
    // The shape from buildInfinibotEntry is the MCP server entry record
    // (command/args/env). MCPServerConfig is intentionally loose so this
    // cast is safe.
    return entry as unknown as MCPServerConfig;
  } catch (err) {
    log.warn(
      `failed to build infinibot self-MCP entry for "${agentId}" — claude_coder spawn won't have self-access this run: ${err}`,
    );
    return null;
  }
}

/**
 * Generate a scoped MCP config file for a specific agent.
 *
 * 1. Discovers all locally configured MCP servers.
 * 2. Filters to only the agent's enabledMCPs.
 * 3. Writes to ~/.claude/mcp-infinibot-{agentId}.json
 *
 * Returns the path to the generated config and metadata about what was included.
 */
export function generateMCPConfig(agent: CLIAgentConfig): SyncResult {
  const available = collectAvailableMCPs();
  const filtered = filterMCPsForAgent(available, agent.enabledMCPs);

  // Always inject the infinibot self-MCP entry so the spawned Claude
  // Code instance has access to memory / workflows / skills / notes /
  // research / kanban / sessions_history / message / mcp passthrough
  // — the same self-learning + skill + workflow management surface
  // that native gateway agents use. Operators can't currently opt out;
  // that's intentional, since the point of spawning from inside
  // InfiniBot is precisely so the spawn participates in InfiniBot's
  // memory + workflow systems.
  const selfEntry = buildInfinibotSelfMcpEntry(agent.id);
  if (selfEntry && !filtered.has(INFINIBOT_MCP_ENTRY_KEY)) {
    filtered.set(INFINIBOT_MCP_ENTRY_KEY, selfEntry);
  }

  const configFile = buildMCPConfigFile(filtered);

  const configDir = getScopedConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = getScopedConfigPath(agent.id);
  writeFileSync(configPath, JSON.stringify(configFile, null, 2) + "\n", "utf-8");

  const serverNames = [...filtered.keys()];
  log.info(
    `wrote scoped MCP config for agent "${agent.id}": ${serverNames.join(", ") || "(none)"} -> ${configPath}`,
  );

  return {
    configPath,
    serverCount: filtered.size,
    serverNames,
  };
}

/**
 * Remove the scoped MCP config file for an agent (cleanup after run).
 */
export function cleanupMCPConfig(agentId: string): void {
  const configPath = getScopedConfigPath(agentId);
  try {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
      log.debug(`cleaned up scoped MCP config: ${configPath}`);
    }
  } catch (err) {
    log.warn(`failed to cleanup MCP config ${configPath}: ${err}`);
  }
}

/**
 * Read and return the current scoped config for an agent (if it exists).
 * Useful for diagnostics.
 */
export function readScopedMCPConfig(agentId: string): MCPConfigFile | null {
  const configPath = getScopedConfigPath(agentId);
  try {
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * List all MCP servers that an agent config would have access to,
 * without writing any files. Useful for dry-run / validation.
 */
export function previewMCPsForAgent(agent: AgentConfig): string[] {
  const available = collectAvailableMCPs();
  const matched: string[] = [];
  for (const name of agent.enabledMCPs) {
    if (available.has(name)) {
      matched.push(name);
    }
  }
  return matched;
}
