/**
 * Gateway methods for Cloudflare Tunnel management.
 */

import {
  getTunnelState,
  startCloudflareTunnel,
  stopCloudflareTunnel,
  isCloudflaredAvailable,
} from "../server-cloudflare-tunnel.js";
import type { GatewayRequestHandlers } from "./types.js";

export const tunnelHandlers: GatewayRequestHandlers = {
  /**
   * Get current tunnel status.
   */
  "tunnel.status": async ({ respond, context }) => {
    const state = getTunnelState();
    const available = await isCloudflaredAvailable();
    
    respond(true, {
      ...state,
      cloudflaredAvailable: available,
    });
  },

  /**
   * Start the Cloudflare tunnel.
   */
  "tunnel.start": async ({ params, respond, context }) => {
    const port = (params.port as number) || Number(process.env.INFINIBOT_GATEWAY_PORT) || 18789;
    const protocol = (params.protocol as "http" | "https") || "http";

    const available = await isCloudflaredAvailable();
    if (!available) {
      respond(false, undefined, {
        code: "CLOUDFLARED_NOT_INSTALLED",
        message: "cloudflared not installed. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      });
      return;
    }

    const result = await startCloudflareTunnel({ port, protocol });

    if (result.error) {
      respond(false, undefined, {
        code: "TUNNEL_START_FAILED",
        message: result.error,
      });
      return;
    }

    // Broadcast the new tunnel URL
    context.broadcast("tunnel.changed", {
      url: result.url,
      status: "running",
    });

    respond(true, {
      url: result.url,
      status: "running",
    });
  },

  /**
   * Stop the Cloudflare tunnel.
   */
  "tunnel.stop": async ({ respond, context }) => {
    stopCloudflareTunnel();

    // Broadcast tunnel stopped
    context.broadcast("tunnel.changed", {
      url: null,
      status: "stopped",
    });

    respond(true, {
      status: "stopped",
    });
  },
};
