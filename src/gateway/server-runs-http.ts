/**
 * GET /api/runs/:runId/stream — SSE endpoint for live run output.
 *
 * Replays all buffered activity lines for a run, then streams new ones in
 * real time until the client disconnects or the run completes.
 *
 * Event shape:
 *   data: {"type":"line","lineType":"tool|checkpoint|progress|lifecycle|status","text":"...","ts":12345}\n\n
 *   data: {"type":"complete"}\n\n   (sent when the run ends; stream stays open for late lines)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getBufferedLines, subscribeRunLines } from "../agents/run-output-buffer.js";

const STREAM_PATH_PREFIX = "/api/runs/";
const STREAM_PATH_SUFFIX = "/stream";

export async function handleRunStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  // Match /api/runs/<runId>/stream
  if (!url.startsWith(STREAM_PATH_PREFIX)) return false;
  const afterPrefix = url.slice(STREAM_PATH_PREFIX.length);
  if (!afterPrefix.endsWith(STREAM_PATH_SUFFIX)) return false;
  const runId = afterPrefix.slice(0, afterPrefix.length - STREAM_PATH_SUFFIX.length);
  if (!runId || runId.includes("/")) return false;

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  function sendEvent(payload: object): void {
    if (res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* client disconnected */
    }
  }

  // Replay buffered lines immediately
  const buffered = getBufferedLines(runId);
  for (const line of buffered) {
    sendEvent({ type: "line", lineType: line.type, text: line.text, ts: line.ts });
  }

  // Flush what we have and start live push
  if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
    (res as unknown as { flush: () => void }).flush();
  }

  const unsub = subscribeRunLines(runId, (line) => {
    sendEvent({ type: "line", lineType: line.type, text: line.text, ts: line.ts });
  });

  // Heartbeat every 15s to keep proxy connections alive
  const heartbeat = setInterval(() => {
    if (res.destroyed) return;
    try {
      res.write(": heartbeat\n\n");
    } catch {
      /* ignore */
    }
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
  });

  // Never resolves — the SSE stream stays open until the client disconnects.
  await new Promise<void>((resolve) => {
    req.on("close", resolve);
    res.on("close", resolve);
    res.on("error", resolve);
  });

  return true;
}
