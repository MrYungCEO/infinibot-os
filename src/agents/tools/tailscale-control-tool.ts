/**
 * Tailscale Control - Agent tool for runtime Tailscale exposure control.
 *
 * Wraps the same helpers the gateway's `network.tailscale.*` RPCs use,
 * so an agent can read tailnet status and flip serve/funnel without the
 * operator dropping to a shell. Mutating actions inherit the sudo
 * fallback already in src/infra/tailscale.ts.
 */

import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { resolveGatewayPort } from "../../config/paths.js";
import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  findTailscaleBinary,
  getTailnetHostname,
  readTailscaleStatusJson,
} from "../../infra/tailscale.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readNumberParam, readStringParam, type AnyAgentTool } from "./common.js";

function summariseStatus(raw: Record<string, unknown>): Record<string, unknown> {
  const self = (raw as { Self?: Record<string, unknown> }).Self;
  const hostname =
    self && typeof self.DNSName === "string"
      ? (self.DNSName as string).replace(/\.$/, "")
      : undefined;
  const ips =
    self && Array.isArray((self as { TailscaleIPs?: unknown }).TailscaleIPs)
      ? (self as { TailscaleIPs: string[] }).TailscaleIPs
      : undefined;
  const peers = (raw as { Peer?: Record<string, unknown> }).Peer;
  return {
    backendState: (raw as { BackendState?: string }).BackendState ?? "Unknown",
    hostname,
    ip: ips?.[0],
    tailnetName: (raw as { MagicDNSSuffix?: string }).MagicDNSSuffix,
    peerCount: peers && typeof peers === "object" ? Object.keys(peers).length : 0,
  };
}

async function resolvePort(input: number | undefined): Promise<number> {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) return input;
  try {
    return resolveGatewayPort(loadConfig());
  } catch {
    return resolveGatewayPort();
  }
}

export function createTailscaleControlTool(): AnyAgentTool {
  return {
    label: "Tailscale Control",
    name: "tailscale_control",
    description: `Read and control Tailscale exposure for this InfiniBot gateway.
Actions:
- status: Inspect tailnet state, hostname, IP, peer count
- enable: Turn on \`tailscale serve\` (tailnet-only) or \`funnel\` (public) for the gateway port
- disable: Reset serve / funnel / both
- hostname: Resolve this node's tailnet DNS name (or IP fallback)`,

    parameters: Type.Object({
      action: stringEnum(["status", "enable", "disable", "hostname"], {
        description: "Action to perform",
      }),
      mode: Type.Optional(
        stringEnum(["serve", "funnel", "both"], {
          description:
            "Required for enable/disable. 'serve' = tailnet-only HTTPS; 'funnel' = public via funnel.ts.net; 'both' = reset both (disable only).",
        }),
      ),
      port: Type.Optional(
        Type.Number({
          description: "Override exposed port (default: resolved gateway port)",
        }),
      ),
    }),

    async execute(_toolCallId: string, args: Record<string, unknown>) {
      const action = readStringParam(args, "action", { required: true });

      try {
        if (action === "status") {
          const binary = await findTailscaleBinary();
          if (!binary) {
            return jsonResult({
              installed: false,
              backendState: "NotInstalled",
              message: "Tailscale binary not found on PATH.",
            });
          }
          try {
            const raw = await readTailscaleStatusJson();
            const summary = summariseStatus(raw);
            return jsonResult({ installed: true, binary, ...summary });
          } catch (err) {
            return jsonResult({
              installed: true,
              binary,
              backendState: "Unreachable",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (action === "hostname") {
          try {
            const host = await getTailnetHostname();
            return jsonResult({ hostname: host });
          } catch (err) {
            return jsonResult({
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (action === "enable") {
          const mode = readStringParam(args, "mode", { required: true });
          if (mode !== "serve" && mode !== "funnel") {
            return jsonResult({ error: "mode must be 'serve' or 'funnel'" });
          }
          const port = await resolvePort(readNumberParam(args, "port"));
          if (mode === "funnel") await enableTailscaleFunnel(port);
          else await enableTailscaleServe(port);
          return jsonResult({ enabled: mode, port });
        }

        if (action === "disable") {
          const mode = (readStringParam(args, "mode") ?? "both") as "serve" | "funnel" | "both";
          const disabled: string[] = [];
          if (mode === "serve" || mode === "both") {
            await disableTailscaleServe();
            disabled.push("serve");
          }
          if (mode === "funnel" || mode === "both") {
            await disableTailscaleFunnel();
            disabled.push("funnel");
          }
          return jsonResult({ disabled });
        }

        return jsonResult({ error: `unknown action: ${action}` });
      } catch (err) {
        return jsonResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
