/**
 * Federation Satellite Context
 *
 * Thin helper for gateway handlers to check whether this process is
 * running as a federation satellite and, if so, proxy RPC calls through
 * to the master node instead of hitting the local store.
 *
 * Usage in a gateway handler file:
 *
 *   import { applySatelliteProxy } from "../../federation/satellite-context.js";
 *
 *   const _rawHandlers: GatewayRequestHandlers = { ... };
 *   export const myHandlers = applySatelliteProxy(_rawHandlers);
 *
 * When the gateway boots in satellite mode and the satellite is connected
 * to master, every wrapped handler is forwarded to master via
 * `satellite.invokeOnMaster(method, params)` rather than running locally.
 * If the satellite is disconnected, the local handler is used as fallback.
 */

import { loadConfig } from "../config/config.js";
import { getFederationSatellite } from "./satellite.js";
import type { FederationSatellite } from "./satellite.js";
import type {
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns the connected satellite instance if this process is a satellite
 * AND is currently connected to master. Returns null in master/standalone
 * mode or when disconnected (so callers fall back to local).
 */
export function getConnectedSatellite(): FederationSatellite | null {
  const cfg = loadConfig();
  if (cfg.federation?.mode !== "satellite") return null;

  const sat = getFederationSatellite();
  if (!sat) return null;

  return sat.getState() === "connected" ? sat : null;
}

/**
 * True if this process is configured as a federation satellite,
 * regardless of current connection state.
 */
export function isSatelliteMode(): boolean {
  const cfg = loadConfig();
  return cfg.federation?.mode === "satellite";
}

// ── Proxy wrapper ─────────────────────────────────────────────────────────────

/**
 * Wraps a gateway handler map so that, when running in connected satellite
 * mode, each call is forwarded to the master gateway instead of handled
 * locally. Falls back to the local handler when disconnected.
 *
 * Idempotent — safe to call on handlers that are already plain objects.
 */
export function applySatelliteProxy(handlers: GatewayRequestHandlers): GatewayRequestHandlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      async (opts: GatewayRequestHandlerOptions): Promise<void> => {
        const sat = getConnectedSatellite();
        if (sat) {
          const result = await sat.invokeOnMaster(method, opts.params as Record<string, unknown>);
          if (result.success) {
            opts.respond(true, result.data);
          } else {
            opts.respond(false, undefined, {
              code: (result.error?.code ?? "PROXY_ERROR") as string,
              message: result.error?.message ?? "Master invocation failed (satellite proxy)",
            });
          }
          return;
        }
        // Not connected or not satellite — run locally.
        return handler(opts);
      },
    ]),
  );
}

/**
 * Proxy a single RPC call to master and return the raw result object.
 * Useful for one-off forwarding inside a handler that has mixed logic.
 */
export async function proxyToMaster(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ success: boolean; data?: unknown; error?: { code?: string; message?: string } }> {
  const sat = getConnectedSatellite();
  if (!sat) {
    return {
      success: false,
      error: { code: "NOT_SATELLITE", message: "Not in connected satellite mode" },
    };
  }
  return sat.invokeOnMaster(method, params);
}

/**
 * Like `applySatelliteProxy`, but only wraps the methods named in
 * `methodNames`. Useful for handler files that mix master-owned state
 * (which should proxy) with per-node side effects (which must run
 * locally on the satellite, e.g. inbound webhook delivery, local PTY
 * lifecycle, FS I/O).
 *
 * Unknown method names are silently ignored — the helper only wraps
 * methods that actually exist in the handlers map. Methods not in
 * `methodNames` pass through unchanged.
 */
export function proxyMethodsToMaster(
  handlers: GatewayRequestHandlers,
  methodNames: readonly string[],
): GatewayRequestHandlers {
  const allowSet = new Set(methodNames);
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => {
      if (!allowSet.has(method)) return [method, handler];
      return [
        method,
        async (opts: GatewayRequestHandlerOptions): Promise<void> => {
          const sat = getConnectedSatellite();
          if (sat) {
            const result = await sat.invokeOnMaster(method, opts.params as Record<string, unknown>);
            if (result.success) {
              opts.respond(true, result.data);
            } else {
              opts.respond(false, undefined, {
                code: (result.error?.code ?? "PROXY_ERROR") as string,
                message: result.error?.message ?? "Master invocation failed (satellite proxy)",
              });
            }
            return;
          }
          return handler(opts);
        },
      ];
    }),
  );
}
