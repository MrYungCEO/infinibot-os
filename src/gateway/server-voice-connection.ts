import type { IncomingMessage, ServerResponse } from "node:http";
import { AccessToken } from "livekit-server-sdk";

import {
  getExplicitLivekitExternalUrl,
  resolveLivekitPort,
  resolveVoiceUrls,
} from "./server-voice-urls.js";
import { ensureLocalVoiceProvider } from "./voice/local-provider.js";
import {
  resolveVoiceProvider,
  isVoiceProviderError,
  type VoiceRealtimeRequest,
  type VoiceRealtimeSession,
} from "./voice/provider-registry.js";

/**
 * The LiveKit URL to hand the browser. An explicit external override (config
 * `voice.livekitUrlExternal` or env LIVEKIT_URL_EXTERNAL) always wins — that's
 * for reverse-proxy / federation setups. Otherwise we derive the URL from the
 * host the browser used to reach the gateway, so a remote (Tailscale / LAN)
 * client gets a reachable address instead of `ws://localhost:7882` (which
 * points at the client's own machine and silently fails to connect). LiveKit's
 * signal port binds all interfaces, so `<same-host>:<port>` is reachable.
 */
function resolveBrowserLivekitUrl(hostHeader: string | undefined, secure: boolean): string {
  const explicit = getExplicitLivekitExternalUrl();
  if (explicit) return explicit;

  if (hostHeader) {
    const hostname = hostHeader.split(":")[0];
    if (hostname) {
      const scheme = secure ? "wss" : "ws";
      return `${scheme}://${hostname}:${resolveLivekitPort()}`;
    }
  }
  // Last resort: whatever resolveVoiceUrls settles on (localhost default).
  return resolveVoiceUrls().livekitExternal;
}

// Read on every request — federation identity-sync writes the master's
// LIVEKIT_API_KEY / LIVEKIT_API_SECRET into the satellite's process env
// AFTER this module is first loaded, so a module-level constant would
// permanently cache the `devkey`/`secret` defaults and master's LiveKit
// container would reject every token the satellite mints.
function getLivekitCreds(): { apiKey: string; apiSecret: string } {
  return {
    apiKey: process.env.LIVEKIT_API_KEY || "devkey",
    apiSecret: process.env.LIVEKIT_API_SECRET || "secret",
  };
}

/**
 * Mint a LiveKit session against this gateway's own LiveKit (the built-in
 * "local" voice provider). Unique room per call unless the client proposes one.
 */
export async function mintLocalLivekitSession(
  req: VoiceRealtimeRequest,
): Promise<VoiceRealtimeSession> {
  const room = req.room || `voice-${Date.now()}`;
  const participant = req.participant || "user";
  // Generate LiveKit access token (creds resolved per-request)
  const { apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET } = getLivekitCreds();
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: participant,
    ttl: "1h",
  });
  at.addGrant({
    room,
    roomJoin: true,
    roomCreate: true,
    canPublish: true,
    canSubscribe: true,
    agent: true, // Enable agent dispatch
  });
  const token = await at.toJwt();
  // Resolved fresh on each request: explicit external override wins, else
  // derive from the browser's own request host so remote (Tailscale / LAN)
  // clients don't get an unreachable localhost URL.
  const url = resolveBrowserLivekitUrl(req.requestHost, req.secure === true);
  return { token, url, room, participant };
}

export async function handleVoiceConnectionRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url) return false;

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Handle both /api/connection-details and /api/voice/connection
  if (pathname !== "/api/connection-details" && pathname !== "/api/voice/connection") {
    return false;
  }

  console.log(`[VoiceConnection] Handling ${req.method} ${pathname}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const sessionReq: VoiceRealtimeRequest = {
    room: url.searchParams.get("room") || undefined,
    participant: url.searchParams.get("participant") || undefined,
    agentId: url.searchParams.get("agent") || undefined,
    requestHost: req.headers.host,
    secure: forwardedProto === "https",
  };

  try {
    // Whichever voice provider is active (built-in "local" or a plugin such
    // as Robovoice) issues the session. See voice/provider-registry.ts.
    ensureLocalVoiceProvider();
    const resolved = resolveVoiceProvider("realtime");
    if (!resolved.provider?.createRealtimeSession) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: 'Local voice isn\'t set up yet. Use "Set up voice for me" in Voice settings.',
          code: "no_voice_provider",
        }),
      );
      return true;
    }
    // "auto" is always local voice; cloud voice (Robovoice) runs only when the
    // user picked it, and its errors (e.g. cloud_voice_busy) reach the UI,
    // which offers the switch to local voice. No automatic fallback either way.
    const provider = resolved.provider;
    const fellBack = resolved.fellBack;
    const fallbackReason = resolved.reason;
    const session: VoiceRealtimeSession = await provider.createRealtimeSession!(sessionReq);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        token: session.token,
        url: session.url,
        room: session.room,
        participant: session.participant,
        provider: provider.id,
        characterId: session.characterId,
        characterName: session.characterName,
        ...(fellBack ? { fellBack: true, fallbackReason } : {}),
      }),
    );
    return true;
  } catch (err: any) {
    if (isVoiceProviderError(err)) {
      res.writeHead(err.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message, code: err.code }));
      return true;
    }
    console.error("[VoiceConnection] Error generating token:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Failed to generate token" }));
    return true;
  }
}
