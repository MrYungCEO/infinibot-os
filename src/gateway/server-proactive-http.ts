/**
 * HTTP POST /api/proactive/emit — gateway-token-guarded proactive emit endpoint.
 *
 * Allows external callers (curl, webhooks, CI pipelines) to push a proactive
 * pop-up into the InfiniBot UI without needing a live WS connection.
 *
 * Auth: the gateway credential (Bearer / X-InfiniBot-Token / session cookie),
 * enforced by the central HTTP gate in http-auth.ts. No loopback shortcut.
 *
 * Body shape mirrors proactive.emit RPC params exactly so callers can reuse the
 * same payload for both the RPC and HTTP paths.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { STATE_DIR } from "../config/paths.js";
import {
  sendJson,
  sendMethodNotAllowed,
  readJsonBodyOrError,
  sendInvalidRequest,
} from "./http-common.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeHandlerRequest } from "./http-auth.js";
import { emitProactiveServerSide } from "../proactive/emit.js";
import { TIER_ORDER, validatePopupMedia, validatePopupInteract } from "../proactive/popup-types.js";
import type { PopupTier, PopupAttribution, PopupAction } from "../proactive/popup-types.js";
import { bakeScenesNarration } from "../proactive/canvas-narration.js";
import { getPopupStore } from "../proactive/popup-store.js";
import { getGatewayBroadcaster } from "../agents/coder-runtime/subagent-broadcast.js";

export async function handleProactiveEmitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; trustedProxies?: string[]; preAuthorized?: boolean },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/proactive/interact") {
    return handleProactiveInteractRequest(req, res, opts);
  }
  if (url.pathname !== "/api/proactive/emit") return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // Auth: central HTTP gate (no loopback trust).
  if (!(await authorizeHandlerRequest(req, res, opts))) return true;

  const bodyUnknown = await readJsonBodyOrError(req, res, 1 * 1024 * 1024);
  if (bodyUnknown === undefined) return true;

  const body = (bodyUnknown ?? {}) as Record<string, unknown>;

  // Validate tier.
  const rawTier = typeof body.tier === "string" ? body.tier.toUpperCase() : "";
  if (!TIER_ORDER.includes(rawTier as PopupTier)) {
    sendInvalidRequest(res, `tier must be one of ${TIER_ORDER.join(", ")}`);
    return true;
  }
  const tier = rawTier as PopupTier;

  // Validate title.
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    sendInvalidRequest(res, "title is required");
    return true;
  }

  // Validate attribution.
  const attr = body.attribution as Record<string, unknown> | undefined;
  if (!attr || typeof attr.agentId !== "string" || !attr.agentId.trim()) {
    sendInvalidRequest(
      res,
      "attribution.agentId is required (pass { agentId: '<your-agent-id>' })",
    );
    return true;
  }
  const attribution: PopupAttribution = {
    agentId: attr.agentId,
    agentName: typeof attr.agentName === "string" ? attr.agentName : undefined,
    cardId: typeof attr.cardId === "string" ? attr.cardId : undefined,
    goalId: typeof attr.goalId === "string" ? attr.goalId : undefined,
  };

  // dedupKey.
  const dedupKey = typeof body.dedupKey === "string" ? body.dedupKey.trim() : "";
  if (!dedupKey) {
    sendInvalidRequest(res, "dedupKey is required");
    return true;
  }

  // Optional media.
  let media: ReturnType<typeof validatePopupMedia>["media"] = undefined;
  if (body.media != null) {
    const v = validatePopupMedia(body.media);
    if (v.error) {
      sendInvalidRequest(res, `Invalid media: ${v.error}`);
      return true;
    }
    media = v.media;
    // Pre-bake per-scene narration for the infinite-canvas walkthrough so the
    // overlay plays scene-owned audio (and the orchestrator stays silent).
    // Best-effort: unbaked scenes degrade to live /api/voice/tts on the client.
    if (media && media.kind === "infinite-canvas-walkthrough") {
      try {
        await bakeScenesNarration(media.payload, STATE_DIR);
      } catch {
        /* baking is best-effort — never blocks the emit */
      }
    }
  }

  const built = emitProactiveServerSide(
    {
      tier,
      title,
      body: typeof body.body === "string" ? body.body : "",
      attribution,
      actions: Array.isArray(body.actions) ? (body.actions as PopupAction[]) : [],
      dedupKey,
      voice: typeof body.voice === "string" ? body.voice : undefined,
      media,
      // Optional tap target (docs/mobile/DEEP-LINKS.md); normalized in emit.
      deepLink: typeof body.deepLink === "string" ? body.deepLink : undefined,
    },
    STATE_DIR,
  );

  if (!built) {
    sendJson(res, 500, { ok: false, error: "emit failed — see gateway logs" });
    return true;
  }

  sendJson(res, 200, { ok: true, event: built.event, routing: built.routing });
  return true;
}

async function handleProactiveInteractRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; trustedProxies?: string[]; preAuthorized?: boolean },
): Promise<boolean> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  if (!(await authorizeHandlerRequest(req, res, opts))) return true;
  const bodyUnknown = await readJsonBodyOrError(req, res, 64 * 1024);
  if (bodyUnknown === undefined) return true;
  const body = (bodyUnknown ?? {}) as Record<string, unknown>;
  const v = validatePopupInteract(body.interact ?? body);
  if (v.error || !v.interact) {
    sendInvalidRequest(res, v.error || "invalid interact");
    return true;
  }
  const event = getPopupStore(STATE_DIR).get(v.interact.eventId);
  if (!event) {
    sendJson(res, 404, { ok: false, error: "event not found" });
    return true;
  }
  const broadcast = getGatewayBroadcaster();
  if (!broadcast) {
    sendJson(res, 503, { ok: false, error: "broadcaster not wired" });
    return true;
  }
  broadcast("proactive.interact", { interact: v.interact });
  sendJson(res, 200, { ok: true, interact: v.interact });
  return true;
}
