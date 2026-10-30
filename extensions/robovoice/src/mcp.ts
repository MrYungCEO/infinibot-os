/**
 * /plugins/robovoice/mcp — plugin-owned replacement for the host-side
 * Robovoice→InfiniBot MCP bridge (Robovoice-Prod scripts/infinibot-mcp-http.mjs
 * on :8793, which spawns dist/cli/mcp-stdio.js per session).
 *
 * Minimal MCP "streamable HTTP" server, JSON responses only (no SSE):
 * initialize, notifications/*, ping, tools/list, tools/call. Tools are the
 * allowlist from plugin settings (default = the bridge's curated list).
 * Calls go through the gateway's own POST /tools/invoke on loopback with the
 * caller's credentials, so the gateway's tool policy still applies.
 *
 * LIMITATION (host API gap): plugins can't enumerate agent tools with their
 * JSON schemas yet, so tools/list advertises a permissive object schema. See
 * HOST-API-NEEDS.md "runtime.tools". Until that lands keep the old bridge for
 * characters that need precise tool schemas.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { NEVER_MCP_TOOLS } from "./settings.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export type ToolInvoker = (
  name: string,
  args: Record<string, unknown>,
  ctx: { req: IncomingMessage },
) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

/** Loopback invoker: POST /tools/invoke on the gateway that received the request. */
export const loopbackToolInvoker: ToolInvoker = async (name, args, { req }) => {
  const port = req.socket.localPort;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = req.headers.authorization;
  if (typeof auth === "string") headers.authorization = auth;
  const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tool: name, args }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown; error?: { message?: string } }
    | null;
  if (res.ok && body?.ok) return { ok: true, result: body.result };
  return { ok: false, error: body?.error?.message ?? `tools/invoke http ${res.status}` };
};

function resultText(result: unknown, maxChars = 12_000): string {
  let text: string;
  if (isRecord(result) && Array.isArray(result.content)) {
    text = result.content
      .map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
  } else {
    text = typeof result === "string" ? result : JSON.stringify(result ?? null);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

export async function handleMcpMessage(
  msg: JsonRpc,
  tools: string[],
  invoke: ToolInvoker,
  req: IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = msg.method ?? "";
  if (method.startsWith("notifications/")) return null;
  // Never reachable from a voice call, whatever the allowlist says.
  tools = tools.filter((t) => !NEVER_MCP_TOOLS.has(t));
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "infinibot-robovoice", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: tools.map((name) => ({
          name,
          description: `InfiniBot "${name}" tool (via the Robovoice plugin).`,
          inputSchema: { type: "object", additionalProperties: true },
        })),
      });
    case "tools/call": {
      const p = isRecord(msg.params) ? msg.params : {};
      const name = typeof p.name === "string" ? p.name : "";
      if (!tools.includes(name)) return fail(-32602, `tool not allowed: ${name}`);
      const args = isRecord(p.arguments) ? p.arguments : {};
      try {
        const r = await invoke(name, args, { req });
        return ok({
          content: [{ type: "text", text: r.ok ? resultText(r.result) : (r.error ?? "tool failed") }],
          isError: !r.ok,
        });
      } catch (err) {
        return ok({
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  tools: string[],
  invoke: ToolInvoker = loopbackToolInvoker,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      res.writeHead(413).end();
      return;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }),
    );
    return;
  }
  const batch = Array.isArray(parsed) ? parsed : [parsed];
  const out: Record<string, unknown>[] = [];
  for (const m of batch) {
    const r = await handleMcpMessage(isRecord(m) ? (m as JsonRpc) : {}, tools, invoke, req);
    if (r) out.push(r);
  }
  if (out.length === 0) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
}
