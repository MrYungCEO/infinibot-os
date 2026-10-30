/**
 * Tailscale runtime control RPC.
 *
 * Wraps the helpers in src/infra/tailscale.ts so the UI and MCP tools
 * can flip serve/funnel on the fly without re-running onboard. All
 * mutating actions go through the same sudo-fallback path the gateway
 * uses at boot, so behaviour matches the onboarded experience.
 */

import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  findTailscaleBinary,
  getTailnetHostname,
  readTailscaleServeStatusJson,
  readTailscaleStatusJson,
} from "../../infra/tailscale.js";
import { isGatewayServed } from "../../agency-collaboration/tailscale-service.js";
import { loadConfig } from "../../config/config.js";
import { resolveGatewayPort } from "../../config/paths.js";
import type { GatewayRequestHandlers } from "./types.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNonEmptyArray<T = unknown>(v: unknown): T[] | undefined {
  return Array.isArray(v) && v.length > 0 ? (v as T[]) : undefined;
}

async function resolveExposurePort(paramPort: unknown): Promise<number> {
  if (typeof paramPort === "number" && Number.isFinite(paramPort) && paramPort > 0) {
    return paramPort;
  }
  if (typeof paramPort === "string") {
    const parsed = Number.parseInt(paramPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  try {
    const cfg = loadConfig();
    return resolveGatewayPort(cfg);
  } catch {
    return resolveGatewayPort();
  }
}

function buildStatusSummary(raw: Record<string, unknown>): {
  state: string;
  hostname?: string;
  ip?: string;
  tailnetName?: string;
  exitNodeOnline?: boolean;
  peerCount?: number;
} {
  const backend = asString((raw as { BackendState?: unknown }).BackendState);
  const self = (raw as { Self?: Record<string, unknown> }).Self;
  const hostname = self ? asString(self.DNSName)?.replace(/\.$/, "") : undefined;
  const ips = self ? asNonEmptyArray<string>(self.TailscaleIPs) : undefined;
  const ip = ips?.[0];
  const tailnetName = asString((raw as { MagicDNSSuffix?: unknown }).MagicDNSSuffix);
  const peers = (raw as { Peer?: Record<string, unknown> }).Peer;
  const peerCount = peers && typeof peers === "object" ? Object.keys(peers).length : undefined;
  return {
    state: backend ?? "Unknown",
    hostname,
    ip,
    tailnetName,
    peerCount,
  };
}

export const networkTailscaleHandlers: GatewayRequestHandlers = {
  /**
   * Returns whether the tailscale CLI is reachable and a digest of
   * `tailscale status --json`. Cheap and safe to call at any cadence —
   * the UI polls this for the "Network" widget.
   */
  "network.tailscale.status": async ({ respond }) => {
    try {
      const binary = await findTailscaleBinary();
      if (!binary) {
        respond(true, {
          installed: false,
          backendState: "NotInstalled",
          message: "tailscale binary not found on PATH. Install Tailscale to enable exposure.",
        });
        return;
      }
      try {
        const raw = await readTailscaleStatusJson();
        const summary = buildStatusSummary(raw);
        // getTailnetHostname is best-effort — it can fail if the
        // backend is unauthenticated. Don't block the status response.
        let preferredHost = summary.hostname;
        if (!preferredHost) {
          try {
            preferredHost = await getTailnetHostname();
          } catch {
            /* ignore */
          }
        }
        // Live serve state, so the UI shows what is actually configured right
        // now rather than what config says should be configured.
        const exposurePort = await resolveExposurePort(undefined);
        let serveEnabled = false;
        try {
          serveEnabled = isGatewayServed(await readTailscaleServeStatusJson(), exposurePort);
        } catch {
          // No serve configuration is equivalent to "not configured".
        }
        respond(true, {
          installed: true,
          binary,
          backendState: summary.state,
          hostname: preferredHost,
          ip: summary.ip,
          tailnetName: summary.tailnetName,
          peerCount: summary.peerCount,
          serveEnabled,
          servePort: exposurePort,
          url: serveEnabled && preferredHost ? `https://${preferredHost}/` : undefined,
        });
      } catch (err) {
        respond(true, {
          installed: true,
          binary,
          backendState: "Unreachable",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Turn on `tailscale serve` (tailnet-only) or `tailscale funnel`
   * (public via funnel.ts.net) for the gateway's HTTP port. Honours
   * the explicit `port` param, else falls back to the resolved
   * gateway port.
   */
  "network.tailscale.enable": async ({ params, respond }) => {
    const mode = asString(params?.mode);
    if (mode !== "serve" && mode !== "funnel") {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "mode must be 'serve' or 'funnel'",
      });
      return;
    }
    try {
      const port = await resolveExposurePort(params?.port);
      if (mode === "funnel") await enableTailscaleFunnel(port);
      else await enableTailscaleServe(port);
      respond(true, { mode, port });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Reset whichever exposure mode is currently active. `mode=both` (or
   * omitted) resets serve AND funnel.
   */
  "network.tailscale.disable": async ({ params, respond }) => {
    const mode = asString(params?.mode) ?? "both";
    if (mode !== "serve" && mode !== "funnel" && mode !== "both") {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "mode must be 'serve', 'funnel', or 'both'",
      });
      return;
    }
    try {
      const results: string[] = [];
      if (mode === "serve" || mode === "both") {
        await disableTailscaleServe();
        results.push("serve");
      }
      if (mode === "funnel" || mode === "both") {
        await disableTailscaleFunnel();
        results.push("funnel");
      }
      respond(true, { disabled: results });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
