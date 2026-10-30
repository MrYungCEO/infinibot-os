/**
 * REST endpoints for mobile push token management.
 *
 * POST   /api/push-tokens/register   { token, platform, deviceLabel? } → { ok, id }
 * GET    /api/push-tokens            → { tokens: [...] }
 * DELETE /api/push-tokens/:id        → { ok }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getPushTokenStore } from "../notifications/push-token-store.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

export async function handlePushTokensRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url?.split("?")[0] ?? "";

  if (!url.startsWith("/api/push-tokens")) return false;

  const stateDir = process.env.INFINIBOT_STATE_DIR ?? process.env.MOLTBOT_STATE_DIR ?? "state";

  // POST /api/push-tokens/register
  if (req.method === "POST" && url === "/api/push-tokens/register") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const token = body?.token as string | undefined;
      const platform = (body?.platform as string | undefined) ?? "ios";
      const deviceLabel = (body?.deviceLabel as string | undefined) ?? "";

      if (!token) {
        sendJson(res, 400, { ok: false, error: "token required" });
        return true;
      }

      const store = getPushTokenStore(stateDir);
      const row = store.upsert(token, platform, deviceLabel);
      sendJson(res, 200, { ok: true, id: row.id });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return true;
  }

  // GET /api/push-tokens
  if (req.method === "GET" && url === "/api/push-tokens") {
    try {
      const store = getPushTokenStore(stateDir);
      const tokens = store.list().map((t) => ({
        id: t.id,
        tokenSuffix: t.token.slice(-12),
        platform: t.platform,
        deviceLabel: t.device_label,
        createdAt: t.created_at,
        lastSeenAt: t.last_seen_at,
        invalid: t.invalid_at !== null,
      }));
      sendJson(res, 200, { tokens });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return true;
  }

  // DELETE /api/push-tokens/:id
  const deleteMatch = url.match(/^\/api\/push-tokens\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    try {
      const id = deleteMatch[1];
      const store = getPushTokenStore(stateDir);
      store.delete(id);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return true;
  }

  return false;
}
