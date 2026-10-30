/**
 * Remote access ("Reach InfiniBot from anywhere") RPCs for the onboarding
 * Phone step and Setup › Remote access. Logic lives in
 * src/infra/tailscale-remote.ts; these only resolve this gateway's port and
 * shape errors. Admin-only (the default scope for unlisted methods).
 *
 *   network.tailscale.remote.status   detect install/login/MagicDNS/HTTPS/link
 *   network.tailscale.remote.login    start `tailscale login`/`up`, return the auth URL
 *   network.tailscale.remote.create   serve this gateway over HTTPS (never clobbers)
 *   network.tailscale.remote.verify   fetch the ts.net link, green only when it answers
 *   network.tailscale.remote.remove   remove ONLY this gateway's mapping on one port
 *   network.tailscale.remote.open     open an allowlisted URL in this computer's browser
 */
import { resolveGatewayPort } from "../../config/paths.js";
import { openUrl } from "../../commands/onboard-helpers.js";
import {
  createRemoteLink,
  isAllowedExternalUrl,
  readRemoteStatus,
  removeRemoteLink,
  startTailscaleLogin,
  verifyRemoteLink,
} from "../../infra/tailscale-remote.js";
import type { GatewayRequestHandlers } from "./types.js";

function fail(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  err: unknown,
  code = "INTERNAL_ERROR",
) {
  respond(false, undefined, {
    code,
    message: String((err as Error)?.message ?? err).slice(0, 600),
  });
}

function portParam(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export const tailscaleRemoteHandlers: GatewayRequestHandlers = {
  "network.tailscale.remote.status": async ({ respond }) => {
    try {
      respond(true, await readRemoteStatus(resolveGatewayPort()));
    } catch (err) {
      fail(respond, err);
    }
  },

  "network.tailscale.remote.login": async ({ respond }) => {
    try {
      respond(true, await startTailscaleLogin());
    } catch (err) {
      fail(respond, err);
    }
  },

  "network.tailscale.remote.create": async ({ respond }) => {
    try {
      respond(true, await createRemoteLink(resolveGatewayPort()));
    } catch (err) {
      fail(respond, err);
    }
  },

  "network.tailscale.remote.verify": async ({ params, respond }) => {
    const url = typeof params?.url === "string" ? params.url.trim() : "";
    if (!url) return fail(respond, "url is required", "BAD_REQUEST");
    try {
      respond(true, await verifyRemoteLink(url));
    } catch (err) {
      fail(respond, err, "BAD_REQUEST");
    }
  },

  "network.tailscale.remote.remove": async ({ params, respond }) => {
    const httpsPort = portParam(params?.httpsPort);
    if (!httpsPort) return fail(respond, "httpsPort is required", "BAD_REQUEST");
    try {
      respond(true, await removeRemoteLink(resolveGatewayPort(), httpsPort));
    } catch (err) {
      fail(respond, err);
    }
  },

  "network.tailscale.remote.open": async ({ params, respond }) => {
    const url = typeof params?.url === "string" ? params.url.trim() : "";
    if (!isAllowedExternalUrl(url))
      return fail(respond, "Only tailscale.com and *.ts.net links can be opened.", "BAD_REQUEST");
    try {
      respond(true, { opened: await openUrl(url) });
    } catch (err) {
      fail(respond, err);
    }
  },
};
