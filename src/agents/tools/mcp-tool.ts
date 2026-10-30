/**
 * MCP Agent Tool
 * 
 * Exposes MCP server capabilities to agents via the mcp tool.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const log = createSubsystemLogger("tools").child("mcp");

const MCP_ACTIONS = ["list", "tools", "invoke", "status"] as const;

const MCPToolSchema = Type.Object({
  action: stringEnum(MCP_ACTIONS),
  mcp: Type.Optional(Type.String({ description: "MCP server name" })),
  tool: Type.Optional(Type.String({ description: "Tool name to invoke" })),
  args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Arguments for the tool" })),
  nodeId: Type.Optional(Type.String({ description: "Target node ID for federated MCPs" })),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

type MCPServer = {
  name: string;
  nodeId?: string;
  nodeName?: string;
  tools?: string[];
  status?: string;
};

type MCPToolDef = {
  mcp?: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type MCPInstance = {
  name: string;
  status: string;
  tools?: string[];
  toolCount?: number;
  startedAt?: number;
  error?: string;
};

type MCPToolOptions = {
  agentId?: string;
};

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: { text } };
}

export function createMCPTool(_options?: MCPToolOptions): AnyAgentTool {
  return {
    label: "MCP",
    name: "mcp",
    description: `Interact with external MCP (Model Context Protocol) servers.

Actions:
- **list**: List all available MCP servers
- **tools**: List all tools from all MCPs (or from specific MCP if 'mcp' param provided)
- **invoke**: Call an MCP tool (requires 'mcp' and 'tool', optionally 'args')
- **status**: Get status of all MCP client instances

Examples:
- List all MCPs: { "action": "list" }
- List all tools: { "action": "tools" }
- List tools from specific MCP: { "action": "tools", "mcp": "playwright" }
- Invoke tool: { "action": "invoke", "mcp": "playwright", "tool": "browser_navigate", "args": { "url": "https://example.com" } }
- Check status: { "action": "status" }`,
    parameters: MCPToolSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action") as typeof MCP_ACTIONS[number];
      const mcp = readStringParam(params, "mcp");
      const tool = readStringParam(params, "tool");
      const toolArgs = params.args as Record<string, unknown> | undefined;
      const nodeId = readStringParam(params, "nodeId");

      const gwOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl"),
        gatewayToken: readStringParam(params, "gatewayToken"),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      try {
        switch (action) {
          case "list": {
            const result = await callGatewayTool<{ servers: MCPServer[] }>(
              "mcp.servers.list",
              gwOpts,
              { nodeId }
            );
            const servers = result?.servers || [];
            if (servers.length === 0) {
              return textResult("No MCP servers available.");
            }
            const lines = ["Available MCP Servers:"];
            for (const server of servers) {
              const toolsInfo = server.tools && server.tools.length > 0 ? ` (${server.tools.length} tools)` : "";
              lines.push(`- ${server.name}${toolsInfo} [${server.nodeName || "local"}] - ${server.status || "unknown"}`);
            }
            return textResult(lines.join("\n"));
          }

          case "tools": {
            if (mcp) {
              const result = await callGatewayTool<{ tools: MCPToolDef[] }>(
                "mcp.tools.get",
                gwOpts,
                { mcp }
              );
              const tools = result?.tools || [];
              if (tools.length === 0) {
                return textResult(`No tools found for MCP: ${mcp}`);
              }
              const lines = [`Tools for ${mcp}:`];
              for (const t of tools) {
                lines.push(`- ${t.name}: ${t.description || "No description"}`);
              }
              return textResult(lines.join("\n"));
            } else {
              const result = await callGatewayTool<{ tools: MCPToolDef[] }>(
                "mcp.tools.list",
                gwOpts,
                {}
              );
              const tools = result?.tools || [];
              if (tools.length === 0) {
                return textResult("No MCP tools available.");
              }
              const byMcp = new Map<string, MCPToolDef[]>();
              for (const t of tools) {
                const mcpName = t.mcp || "unknown";
                if (!byMcp.has(mcpName)) byMcp.set(mcpName, []);
                byMcp.get(mcpName)!.push(t);
              }
              const lines = ["Available MCP Tools:"];
              for (const [mcpName, mcpTools] of byMcp) {
                lines.push(`\n[${mcpName}]`);
                for (const t of mcpTools) {
                  lines.push(`  - ${t.name}: ${t.description || "No description"}`);
                }
              }
              return textResult(lines.join("\n"));
            }
          }

          case "invoke": {
            if (!mcp || !tool) {
              return textResult("Error: invoke requires 'mcp' and 'tool' parameters");
            }
            log.info(`invoking MCP tool: ${mcp}.${tool}`, { args: toolArgs });
            const result = await callGatewayTool<{ success: boolean; result?: unknown; error?: string }>(
              "mcp.tools.invoke",
              { ...gwOpts, timeoutMs: gwOpts.timeoutMs ?? 30000 },
              { mcp, tool, args: toolArgs || {}, nodeId }
            );
            if (!result?.success) {
              return textResult(`MCP tool failed: ${result?.error || "Unknown error"}`);
            }
            const resultData = result.result;
            if (typeof resultData === "string") {
              return textResult(resultData);
            }
            if (resultData === undefined || resultData === null) {
              return textResult("Tool executed successfully (no output)");
            }
            return jsonResult(resultData);
          }

          case "status": {
            const result = await callGatewayTool<{ instances: MCPInstance[]; total: number; running: number }>(
              "mcp.clients.status",
              gwOpts,
              {}
            );
            const lines = [`MCP Clients: ${result?.running || 0}/${result?.total || 0} running`];
            for (const inst of result?.instances || []) {
              const toolsStr = inst.toolCount && inst.toolCount > 0 ? ` (${inst.toolCount} tools)` : "";
              const errorStr = inst.error ? ` - Error: ${inst.error}` : "";
              lines.push(`- ${inst.name}: ${inst.status}${toolsStr}${errorStr}`);
            }
            return textResult(lines.join("\n"));
          }

          default:
            return textResult(`Unknown action: ${action}. Valid actions: list, tools, invoke, status`);
        }
      } catch (err) {
        log.error(`mcp tool error: ${err}`);
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
