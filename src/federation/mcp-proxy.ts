/**
 * MCP Proxy
 *
 * Provides transparent routing of MCP invocations across the federation.
 * Local MCPs are called directly, remote MCPs are routed via the federation hub.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getFederationHub } from "./hub.js";
import { getFederationSatellite } from "./satellite.js";
import type { MCPServerInfo, MCPInvokeResult, MCPListResult } from "./types.js";
import { loadConfig } from "../config/config.js";

const log = createSubsystemLogger("federation").child("mcp-proxy");

// =============================================================================
// MCP Registry - tracks available MCPs
// =============================================================================

/** Local MCP server registry */
interface LocalMCPRegistry {
  servers: Map<
    string,
    {
      name: string;
      tools: string[];
      invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }
  >;
}

const localRegistry: LocalMCPRegistry = {
  servers: new Map(),
};

/**
 * Register a local MCP server for federation access.
 */
export function registerLocalMCP(
  name: string,
  tools: string[],
  invoker: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): void {
  localRegistry.servers.set(name, { name, tools, invoke: invoker });
  log.info(`registered local MCP: ${name} with ${tools.length} tools`);
}

/**
 * Unregister a local MCP server.
 */
export function unregisterLocalMCP(name: string): void {
  localRegistry.servers.delete(name);
  log.info(`unregistered local MCP: ${name}`);
}

/**
 * Get locally registered MCP servers.
 */
export function getLocalMCPServers(): MCPServerInfo[] {
  const config = loadConfig();
  const localNodeId = config.federation?.nodeId ?? "local";
  const localNodeName = config.federation?.nodeName ?? "This Node";

  return Array.from(localRegistry.servers.values()).map((server) => ({
    name: server.name,
    nodeId: localNodeId,
    nodeName: localNodeName,
    tools: server.tools,
    status: "running" as const,
  }));
}

// =============================================================================
// MCP Discovery
// =============================================================================

/**
 * List all MCP servers available in the federation.
 * Includes local MCPs and MCPs from all connected nodes.
 */
export async function listFederationMCPs(filterNodeId?: string): Promise<MCPListResult> {
  const servers: MCPServerInfo[] = [];

  // Add local MCPs
  const localServers = getLocalMCPServers();
  if (!filterNodeId || filterNodeId === "local") {
    servers.push(...localServers);
  }

  // Check if we're a master (have hub)
  const hub = getFederationHub();
  if (hub) {
    const federatedServers = hub.getMCPServers(filterNodeId);
    servers.push(...federatedServers);
  }

  // Check if we're a satellite (connected to master)
  const satellite = getFederationSatellite();
  if (satellite && satellite.getState() === "connected") {
    // Get MCPs from federated nodes (via state sync)
    const federatedNodes = satellite.getFederatedNodes();
    for (const node of federatedNodes) {
      if (filterNodeId && filterNodeId !== node.id) continue;
      const nodeMCPs = node.capabilities.mcpServers ?? [];
      for (const mcpName of nodeMCPs) {
        servers.push({
          name: mcpName,
          nodeId: node.id,
          nodeName: node.name,
          tools: [],
          status: "running",
        });
      }
    }
  }

  return { servers };
}

/**
 * Find which node owns an MCP server.
 */
export function findMCPNode(mcpName: string): { nodeId: string; nodeName: string } | null {
  // Check local first
  if (localRegistry.servers.has(mcpName)) {
    const config = loadConfig();
    return {
      nodeId: config.federation?.nodeId ?? "local",
      nodeName: config.federation?.nodeName ?? "This Node",
    };
  }

  // Check hub (if master)
  const hub = getFederationHub();
  if (hub) {
    const servers = hub.getMCPServers();
    const found = servers.find((s) => s.name === mcpName);
    if (found) {
      return { nodeId: found.nodeId, nodeName: found.nodeName };
    }
  }

  // Check satellite state (if connected to master)
  const satellite = getFederationSatellite();
  if (satellite && satellite.getState() === "connected") {
    const federatedNodes = satellite.getFederatedNodes();
    for (const node of federatedNodes) {
      const nodeMCPs = node.capabilities.mcpServers ?? [];
      if (nodeMCPs.includes(mcpName)) {
        return { nodeId: node.id, nodeName: node.name };
      }
    }
  }

  return null;
}

// =============================================================================
// MCP Invocation
// =============================================================================

/**
 * Invoke an MCP tool transparently across the federation.
 *
 * This function:
 * 1. Checks if the MCP is available locally → calls directly
 * 2. Checks if we're master with the MCP on a satellite → routes via hub
 * 3. Checks if we're satellite and MCP is on master → routes via satellite
 *
 * @param mcpName Name of the MCP server
 * @param tool Tool to invoke
 * @param args Arguments for the tool
 * @param targetNodeId Optional: specific node to target
 * @returns Result of the MCP invocation
 */
export async function invokeMCP(
  mcpName: string,
  tool: string,
  args: Record<string, unknown>,
  targetNodeId?: string,
): Promise<MCPInvokeResult> {
  const config = loadConfig();
  const localNodeId = config.federation?.nodeId ?? "local";

  log.debug(`invoking MCP: ${mcpName}.${tool}`, { targetNodeId });

  // 1. Check if MCP is local
  const localServer = localRegistry.servers.get(mcpName);
  if (localServer && (!targetNodeId || targetNodeId === localNodeId || targetNodeId === "local")) {
    try {
      log.debug(`invoking local MCP: ${mcpName}.${tool}`);
      const result = await localServer.invoke(tool, args);
      return {
        success: true,
        result,
        sourceNodeId: localNodeId,
      };
    } catch (err) {
      log.error(`local MCP invoke failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        sourceNodeId: localNodeId,
      };
    }
  }

  // 2. Check if we're master with hub
  const hub = getFederationHub();
  if (hub) {
    log.debug(`routing MCP invoke via hub: ${mcpName}.${tool}`);
    return hub.invokeFederatedMCP(mcpName, tool, args, targetNodeId);
  }

  // 3. Check if we're satellite connected to master
  const satellite = getFederationSatellite();
  if (satellite && satellite.getState() === "connected") {
    log.debug(`routing MCP invoke via satellite: ${mcpName}.${tool}`);
    return invokeMCPViaSatellite(satellite, mcpName, tool, args, targetNodeId);
  }

  // 4. MCP not found anywhere
  return {
    success: false,
    error: `MCP "${mcpName}" not found locally or in federation`,
    sourceNodeId: localNodeId,
  };
}

/**
 * Invoke an MCP tool via satellite connection to master.
 */
async function invokeMCPViaSatellite(
  satellite: ReturnType<typeof getFederationSatellite>,
  mcpName: string,
  tool: string,
  args: Record<string, unknown>,
  targetNodeId?: string,
  timeoutMs = 30000,
): Promise<MCPInvokeResult> {
  if (!satellite || satellite.getState() !== "connected") {
    return {
      success: false,
      error: "Satellite not connected to master",
      sourceNodeId: "satellite",
    };
  }

  log.debug(`routing MCP invoke via satellite: ${mcpName}.${tool}`);

  // Use the satellite's public method to send the request
  return satellite.sendMCPInvokeRequest(mcpName, tool, args, targetNodeId, timeoutMs);
}

// =============================================================================
// Agent Tool Helpers
// =============================================================================

/**
 * Get a description of available MCPs for agent system prompts.
 * Formats MCPs with their source node for clarity.
 */
export async function getMCPDescriptionForAgent(): Promise<string> {
  const { servers } = await listFederationMCPs();

  if (servers.length === 0) {
    return "No MCP servers available.";
  }

  const lines: string[] = ["Available MCP Servers:"];

  // Group by node
  const byNode = new Map<string, MCPServerInfo[]>();
  for (const server of servers) {
    const key = server.nodeName;
    if (!byNode.has(key)) {
      byNode.set(key, []);
    }
    byNode.get(key)!.push(server);
  }

  for (const [nodeName, nodeServers] of byNode) {
    lines.push(`\n[${nodeName}]`);
    for (const server of nodeServers) {
      const toolsStr = server.tools.length > 0 ? ` (${server.tools.length} tools)` : "";
      const statusStr = server.status !== "running" ? ` [${server.status}]` : "";
      lines.push(`  - ${server.name}${toolsStr}${statusStr}`);
    }
  }

  return lines.join("\n");
}

/**
 * Check if an MCP is available (locally or via federation).
 */
export function isMCPAvailable(mcpName: string): boolean {
  return findMCPNode(mcpName) !== null;
}
