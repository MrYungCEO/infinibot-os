/**
 * `GET /api/ollama/health` — report the local Ollama daemon status for this
 * node (running, host, installed models). Backed by the cached status from
 * `ollama/ensure-ollama.ts`; pass `?refresh=1` to force a live probe.
 *
 * Unauthenticated and cheap so the gateway / other federation nodes can poll
 * per-node Ollama availability.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { getLastOllamaStatus, refreshOllamaStatus } from "../ollama/ensure-ollama.js";

export async function handleOllamaHealthRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  let pathname: string;
  let refresh = false;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    pathname = url.pathname;
    refresh = url.searchParams.get("refresh") === "1" || url.searchParams.has("refresh");
  } catch {
    return false;
  }

  if (pathname !== "/api/ollama/health") return false;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  const status = refresh ? await refreshOllamaStatus() : getLastOllamaStatus();
  const body = {
    ok: status?.running ?? false,
    running: status?.running ?? false,
    host: status?.host ?? null,
    models: status?.models ?? [],
    startedByUs: status?.startedByUs ?? false,
    lastCheckedMs: status?.lastCheckedMs ?? null,
  };

  res.writeHead(status?.running ? 200 : 503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  return true;
}
