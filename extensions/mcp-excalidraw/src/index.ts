#!/usr/bin/env node
/**
 * InfiniBot Excalidraw MCP server.
 *
 * Stdio MCP server that exposes 20 canvas tools (read / create / update /
 * delete / arrange / view / IO covering every Excalidraw element type)
 * and bridges every mutation back into the Control UI's whiteboard via
 * the InfiniBot gateway.
 *
 * Usage (Claude Code MCP config):
 *
 *   {
 *     "mcpServers": {
 *       "excalidraw": {
 *         "command": "node",
 *         "args": ["./extensions/mcp-excalidraw/dist/index.js"],
 *         "env": {
 *           "INFINIBOT_GATEWAY_URL": "ws://127.0.0.1:18789",
 *           "INFINIBOT_GATEWAY_PASSWORD": "your-gateway-password"
 *         }
 *       }
 *     }
 *   }
 *
 * Env vars:
 *   INFINIBOT_GATEWAY_URL       defaults to ws://127.0.0.1:18789
 *   INFINIBOT_GATEWAY_TOKEN     gateway token (token-auth gateways)
 *   INFINIBOT_GATEWAY_PASSWORD  gateway password (password-auth gateways)
 *   MCP_EXCALIDRAW_VERBOSE      set to "1" for chatty stderr logging
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { configureBridge } from "./gateway-bridge.js";
import { TOOLS, TOOL_COUNT } from "./tools.js";

const SERVER_NAME = "infinibot-excalidraw";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  configureBridge({
    url: process.env.INFINIBOT_GATEWAY_URL || "ws://127.0.0.1:18789",
    token: process.env.INFINIBOT_GATEWAY_TOKEN || undefined,
    password: process.env.INFINIBOT_GATEWAY_PASSWORD || undefined,
    verbose: process.env.MCP_EXCALIDRAW_VERBOSE === "1",
  });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // List-tools handler — surface every tool to the agent.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as never,
    })),
  }));

  // Call-tool handler — dispatch to the registered handler.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = tool.handler((args ?? {}) as Record<string, unknown>);
      return result as { content: Array<{ type: "text"; text: string }> };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `${tool.name} failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr only — stdout is the MCP transport channel.
  console.error(`[mcp-excalidraw] ${SERVER_NAME} v${SERVER_VERSION} ready (${TOOL_COUNT} tools)`);
}

main().catch((err) => {
  console.error("[mcp-excalidraw] fatal:", err);
  process.exit(1);
});
