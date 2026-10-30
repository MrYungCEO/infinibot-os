/**
 * /plugins/robovoice/agent-mcp — the per-agent MCP endpoint Robovoice characters call.
 *
 * Self-authenticating (declared in the manifest's contributes.selfAuthHttp, so
 * the gateway dispatches it before its shared-secret gate — like channel
 * webhooks): the
 * caller presents `Authorization: Bearer rvib_…`, a token minted for exactly
 * ONE InfiniBot agent at sync time. The token decides the agent; `?agent=`
 * is informational and must match when present.
 *
 * Tools run as that agent: the plugin calls the gateway's own
 * `POST /tools/invoke` with the gateway secret (resolveSelfCallAuthHeaders)
 * and `sessionKey: agent:<id>:robovoice`, so agent X's tool policy
 * (agents.list[X].tools.allow) is what applies — a call to X runs X's tools.
 * The plugin allowlist narrows further, and NEVER_MCP_TOOLS (gateway, exec…)
 * are refused regardless.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { handleMcpHttp, type ToolInvoker } from "./mcp.js";
import { DEFAULT_MCP_TOOLS, NEVER_MCP_TOOLS, type RobovoiceSettingsStore } from "./settings.js";

export type SelfAuth = () => Promise<Record<string, string>>;

export function agentSessionKey(agentId: string): string {
  return `agent:${agentId}:robovoice`;
}

/** Loopback invoker that runs tools as `agentId` with the gateway's own credential. */
export function agentToolInvoker(agentId: string, selfAuth: SelfAuth, fetchImpl: typeof fetch = fetch): ToolInvoker {
  return async (name, args, { req }) => {
    const port = req.socket.localPort;
    const res = await fetchImpl(`http://127.0.0.1:${port}/tools/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await selfAuth()) },
      body: JSON.stringify({ tool: name, args, sessionKey: agentSessionKey(agentId) }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; error?: { message?: string } }
      | null;
    if (res.ok && body?.ok) return { ok: true, result: body.result };
    return { ok: false, error: body?.error?.message ?? `tools/invoke http ${res.status}` };
  };
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1] : null;
}

export async function handleAgentMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  store: RobovoiceSettingsStore,
  selfAuth: SelfAuth,
  invokerFor: (agentId: string) => ToolInvoker = (id) => agentToolInvoker(id, selfAuth),
): Promise<void> {
  const deny = (status: number, message: string): void => {
    res
      .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }));
  };
  const agentId = store.agentForMcpToken(bearer(req));
  if (!agentId) return deny(401, "unauthorized");
  const url = new URL(req.url ?? "/", "http://localhost");
  const named = url.searchParams.get("agent");
  if (named && named !== agentId) return deny(403, "token is not valid for this agent");
  const s = store.get();
  const tools = (s.mcpTools ?? DEFAULT_MCP_TOOLS).filter((t) => !NEVER_MCP_TOOLS.has(t));
  await handleMcpHttp(req, res, tools, invokerFor(agentId));
}
