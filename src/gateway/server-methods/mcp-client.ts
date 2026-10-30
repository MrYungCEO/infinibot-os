/**
 * Gateway handlers for MCP client operations
 * 
 * Allows agents to:
 * - List available MCP servers and their tools
 * - Invoke MCP tools
 * - Check MCP client status
 */

import { getMCPClientManager, getMCPToolsForAgent } from "../../mcp/client.js";
import { listFederationMCPs, invokeMCP } from "../../federation/mcp-proxy.js";
import type { GatewayRequestHandlers } from "./types.js";

export const mcpClientHandlers: GatewayRequestHandlers = {
  /**
   * List all available MCP servers (local and federated)
   */
  "mcp.servers.list": async ({ params, respond }) => {
    try {
      const nodeId = params.nodeId as string | undefined;
      const result = await listFederationMCPs(nodeId);
      respond(true, { servers: result.servers });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get all tools from all running MCP clients (for agent prompt injection)
   */
  "mcp.tools.list": async ({ respond }) => {
    try {
      const allTools = getMCPToolsForAgent();
      respond(true, {
        tools: allTools.map(({ mcp, tool }) => ({
          mcp,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Invoke an MCP tool
   */
  "mcp.tools.invoke": async ({ params, respond }) => {
    try {
      const mcp = params.mcp as string;
      const tool = params.tool as string;
      const args = (params.args as Record<string, unknown>) || {};
      const nodeId = params.nodeId as string | undefined;

      if (!mcp || !tool) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "Missing required parameters: mcp, tool",
        });
        return;
      }

      const result = await invokeMCP(mcp, tool, args, nodeId);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get status of all MCP client instances
   */
  "mcp.clients.status": async ({ respond }) => {
    try {
      const manager = getMCPClientManager();
      const instances = manager.getStatus();

      respond(true, {
        instances: instances.map((inst) => ({
          name: inst.name,
          status: inst.status,
          tools: inst.tools.map((t) => t.name),
          toolCount: inst.tools.length,
          startedAt: inst.startedAt,
          error: inst.error,
        })),
        total: instances.length,
        running: instances.filter((i) => i.status === "running").length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get tools from a specific MCP
   */
  "mcp.tools.get": async ({ params, respond }) => {
    try {
      const mcp = params.mcp as string;
      if (!mcp) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "Missing required parameter: mcp",
        });
        return;
      }

      const manager = getMCPClientManager();
      const tools = manager.getTools(mcp);

      respond(true, {
        mcp,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
