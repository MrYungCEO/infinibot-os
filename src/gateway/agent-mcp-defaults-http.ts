/**
 * HTTP handlers for agent MCP defaults and workflow visualization.
 *
 * GET /api/agents/:id/mcp-defaults  → { agentId, defaults: string[] }
 * GET /api/workflows/active         → { arcs: WorkflowArc[] }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getMcpDefaultsForAgent, getAllMcpDefaults } from "./agent-mcp-defaults.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(data);
}

export async function handleAgentMcpDefaultsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // GET /api/agents/:id/mcp-defaults
  const mcpMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/mcp-defaults$/);
  if (mcpMatch) {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return true;
    }
    const agentId = decodeURIComponent(mcpMatch[1]);
    sendJson(res, 200, {
      agentId,
      defaults: getMcpDefaultsForAgent(agentId),
    });
    return true;
  }

  // GET /api/agents/mcp-defaults  (full map)
  if (url.pathname === "/api/agents/mcp-defaults") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return true;
    }
    sendJson(res, 200, { defaults: getAllMcpDefaults() });
    return true;
  }

  // GET /api/workflows/active
  if (url.pathname === "/api/workflows/active") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end("Method Not Allowed");
      return true;
    }
    // Returns live workflow arcs. Initially empty; will be populated
    // when the orchestrator emits active workflow state.
    sendJson(res, 200, { arcs: [] });
    return true;
  }

  return false;
}
