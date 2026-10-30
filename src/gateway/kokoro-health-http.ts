/**
 * `GET /api/kokoro/health` — report the local Kokoro TTS container status for
 * this node (selected provider? endpoint reachable?). Backed by the cached
 * status from `gateway/kokoro-bootstrap.ts`; pass `?refresh=1` to force a live
 * probe.
 *
 * Unauthenticated and cheap so the UI / other federation nodes can poll
 * per-node Kokoro availability and render a status badge.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { getLastKokoroStatus, refreshKokoroStatus } from "./kokoro-bootstrap.js";

export async function handleKokoroHealthRequest(
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

  if (pathname !== "/api/kokoro/health") return false;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  const status = refresh ? await refreshKokoroStatus() : getLastKokoroStatus();
  const body = {
    ok: status?.ready ?? false,
    kokoroReady: status?.ready ?? false,
    selected: status?.selected ?? false,
    url: status?.url ?? null,
    startedByUs: status?.startedByUs ?? false,
    lastCheckedMs: status?.lastCheckedMs ?? null,
    dockerMissing: status?.dockerMissing ?? false,
    warning: status?.warning ?? null,
  };

  res.writeHead(status?.ready ? 200 : 503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  return true;
}
