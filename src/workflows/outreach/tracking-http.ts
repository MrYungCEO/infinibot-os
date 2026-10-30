/**
 * Outreach Tracking HTTP handlers.
 *
 * Mounts three routes on the InfiniBot HTTP server:
 *   GET /api/track/open/:msg_id   → 1×1 transparent GIF, writes opened event
 *   GET /api/track/click/:msg_id  → 302 redirect to `url` param, writes click event
 *   GET /api/unsubscribe/:lead_id → opt-out handler with HMAC token verification
 *
 * Register in the gateway server via:
 *   mountTrackingRoutes(app)
 * where `app` is an Express or Hono-compatible router.
 *
 * TODO(closed-loop): wire these handlers into src/gateway/server.ts.
 * The handlers are self-contained — the gateway just needs to call mountTrackingRoutes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyUnsubscribeToken } from "./send.js";

// 1×1 transparent GIF (43 bytes, canonical minimum)
const TRACKING_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrackingEventSink {
  /** Record an "opened" event for the given messageId. */
  recordOpen(messageId: string): Promise<void> | void;
  /** Record a "clicked" event for the given messageId and url. */
  recordClick(messageId: string, url: string): Promise<void> | void;
  /** Mark a lead as unsubscribed. */
  recordUnsubscribe(leadId: string): Promise<void> | void;
}

// ── Request matching helper ───────────────────────────────────────────────────

function matchRoute(method: string, pathname: string, pattern: RegExp): RegExpMatchArray | null {
  if (method !== "GET") return null;
  return pathname.match(pattern);
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function handleTrackingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sink: TrackingEventSink,
): Promise<boolean> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Parse pathname + query
  let pathname: string;
  let query: URLSearchParams;
  try {
    const parsed = new URL(url, "http://localhost");
    pathname = parsed.pathname;
    query = parsed.searchParams;
  } catch {
    return false;
  }

  // GET /api/track/open/:msg_id
  const openMatch = matchRoute(method, pathname, /^\/api\/track\/open\/([^/]+)$/);
  if (openMatch) {
    const msgId = decodeURIComponent(openMatch[1]!);
    try {
      await sink.recordOpen(msgId);
    } catch (err) {
      console.error(`[tracking] recordOpen error: ${String(err)}`);
    }
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": TRACKING_GIF.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(TRACKING_GIF);
    return true;
  }

  // GET /api/track/click/:msg_id?url=…
  const clickMatch = matchRoute(method, pathname, /^\/api\/track\/click\/([^/]+)$/);
  if (clickMatch) {
    const msgId = decodeURIComponent(clickMatch[1]!);
    const targetUrl = query.get("url");
    if (!targetUrl) {
      res.writeHead(400);
      res.end("Missing url parameter");
      return true;
    }
    try {
      await sink.recordClick(msgId, targetUrl);
    } catch (err) {
      console.error(`[tracking] recordClick error: ${String(err)}`);
    }
    res.writeHead(302, { Location: targetUrl });
    res.end();
    return true;
  }

  // GET /api/unsubscribe/:lead_id?token=…
  const unsubMatch = matchRoute(method, pathname, /^\/api\/unsubscribe\/([^/]+)$/);
  if (unsubMatch) {
    const leadId = decodeURIComponent(unsubMatch[1]!);
    const token = query.get("token") ?? "";
    if (!verifyUnsubscribeToken(leadId, token)) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h2>Invalid unsubscribe link</h2><p>This link may have expired.</p>");
      return true;
    }
    try {
      await sink.recordUnsubscribe(leadId);
    } catch (err) {
      console.error(`[tracking] recordUnsubscribe error: ${String(err)}`);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:500px">
      <h2>You've been unsubscribed</h2>
      <p>You will not receive any further emails from us.</p>
      <p>If you unsubscribed by mistake, please reply to our last email.</p>
      </body></html>`,
    );
    return true;
  }

  // Route not matched
  return false;
}
