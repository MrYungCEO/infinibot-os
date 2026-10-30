/**
 * World map cross-device sync.
 *
 * `world.camera` is a tiny fire-and-forget relay: a client (today the web
 * <agency-world-viz>) publishes its settled camera transform, and the gateway
 * re-broadcasts it on the `world.camera` event topic to every connected client.
 * The mobile app subscribes and mirrors the transform onto its WebView engine.
 *
 * Payload is deliberately ~32 bytes — {zoom, centerX, centerY, easeMs, source,
 * publisherId}. The `publisherId` lets a client ignore its own echo; `source`
 * ('web' | 'mobile' | 'auto') is advisory. No state is persisted.
 *
 * NOTE: new gateway RPC methods are only served after a gateway restart.
 */

import type { GatewayRequestHandlers } from "./types.js";

export const worldHandlers: GatewayRequestHandlers = {
  "world.camera": async ({ params, respond, context }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const zoom = Number(p.zoom);
    const centerX = Number(p.centerX);
    const centerY = Number(p.centerY);
    if (!Number.isFinite(zoom) || !Number.isFinite(centerX) || !Number.isFinite(centerY)) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "world.camera requires numeric zoom, centerX, centerY",
      });
      return;
    }
    const easeRaw = Number(p.easeMs);
    const payload = {
      zoom,
      centerX,
      centerY,
      easeMs: Number.isFinite(easeRaw) ? Math.max(0, Math.min(5000, easeRaw)) : 600,
      source: typeof p.source === "string" ? p.source : "web",
      publisherId: typeof p.publisherId === "string" ? p.publisherId : undefined,
    };
    // dropIfSlow: a stale camera frame is worthless — never back up a slow socket.
    context.broadcast("world.camera", payload, { dropIfSlow: true });
    respond(true, { ok: true });
  },
};
