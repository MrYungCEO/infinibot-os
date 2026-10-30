/**
 * Gateway RPC methods for device pairing via invite links.
 *
 * pairing.createInvite — generate a short-lived (15-min) single-use invite URL
 * pairing.listInvites  — list active (non-expired) pending invites (partial tokens)
 *
 * Both methods require operator.admin scope (default for all RPCs).
 */

import { execSync } from "node:child_process";
import { resolveGatewayPort } from "../../config/paths.js";
import { readSavedRemoteUrl } from "../../infra/tailscale-remote.js";
import { createInviteToken, listInviteTokens } from "../pairing-invites.js";
import type { GatewayRequestHandlers } from "./types.js";

function getTailnetServeUrl(port: number): string | null {
  try {
    const out = execSync("tailscale status --json 2>/dev/null", { timeout: 3000 }).toString();
    const data = JSON.parse(out) as Record<string, unknown>;
    const self = data?.Self as Record<string, unknown> | undefined;
    if (!self) return null;
    const suffix: string = (data?.MagicDNSSuffix as string) ?? "";
    const rawHost: string =
      (self.HostName as string) ?? (self.DNSName as string | undefined)?.replace(/\.$/, "") ?? "";
    if (!rawHost || !suffix) return null;
    const hostname = rawHost.includes(".") ? rawHost : `${rawHost}.${suffix}`;

    // Check if Tailscale Serve is proxying our port at the root path.
    try {
      const serveOut = execSync("tailscale serve status --json 2>/dev/null", {
        timeout: 3000,
      }).toString();
      const serve = JSON.parse(serveOut) as Record<string, unknown>;
      const web: Record<string, unknown> = (serve?.Web as Record<string, unknown>) ?? {};
      for (const [svcKey, svc] of Object.entries(web)) {
        const handlers: Record<string, unknown> =
          ((svc as Record<string, unknown>)?.Handlers as Record<string, unknown>) ?? {};
        for (const [path, handler] of Object.entries(handlers)) {
          const proxyUrl: string = ((handler as Record<string, unknown>)?.Proxy as string) ?? "";
          if (proxyUrl.includes(`:${port}`) && path === "/") {
            const colonIdx = svcKey.lastIndexOf(":");
            const svcPort = colonIdx !== -1 ? svcKey.slice(colonIdx + 1) : "443";
            const svcHost = colonIdx !== -1 ? svcKey.slice(0, colonIdx) : svcKey;
            return svcPort === "443" ? `https://${svcHost}` : `https://${svcHost}:${svcPort}`;
          }
        }
      }
    } catch {
      // tailscale serve status not available
    }

    return `http://${hostname}:${port}`;
  } catch {
    return null;
  }
}

export const pairingHandlers: GatewayRequestHandlers = {
  "pairing.createInvite": async ({ respond }) => {
    // The request context has no port; the gateway exports its real one as
    // INFINIBOT_GATEWAY_PORT. The link saved by Remote access wins.
    const port = resolveGatewayPort();
    const { token, expiresAt } = createInviteToken();
    const baseUrl = readSavedRemoteUrl() ?? getTailnetServeUrl(port) ?? `http://localhost:${port}`;
    const url = `${baseUrl}/?invite=${token}`;
    respond(true, { ok: true, token, expiresAt, url }, undefined);
  },

  "pairing.listInvites": async ({ respond }) => {
    const invites = listInviteTokens().map((entry) => ({
      // Never expose the full token to avoid leaking it via list endpoint
      tokenPrefix: entry.token.slice(0, 8),
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt,
      remainingMs: Math.max(0, entry.expiresAt - Date.now()),
    }));
    respond(true, { ok: true, invites }, undefined);
  },
};
