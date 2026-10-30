/**
 * Pure resolution of `gateway.tailscale.*` into the exposure plan the gateway
 * acts on at startup.
 *
 * Two spellings exist for historical reasons and both are supported:
 *   - `mode: "off" | "serve" | "funnel"` — the original, explicit form.
 *   - `autoServe: true` / `funnel: true` — the shorthands.
 * Explicit `mode` always wins. Everything defaults to OFF: an install that has
 * never asked for tailnet exposure must keep booting exactly as before.
 *
 * SECURITY: `serve` publishes to your tailnet only. `funnel` publishes to the
 * PUBLIC INTERNET via funnel.ts.net. `autoServe` never implies funnel — funnel
 * requires `mode: "funnel"` or `funnel: true` spelled out by hand.
 */
import type { GatewayTailscaleConfig, GatewayTailscaleMode } from "../config/config.js";

export const DEFAULT_EXPO_PORT = 8081;

export type TailscaleExposurePlan = {
  mode: GatewayTailscaleMode;
  /** Local port to expose. */
  port: number;
  /** Expo Metro port to expose over tailnet-only serve, or null to skip. */
  expoPort: number | null;
  resetOnExit: boolean;
  /** True when the exposure reaches the public internet. */
  publicExposure: boolean;
};

export function resolveTailscaleMode(
  cfg: GatewayTailscaleConfig | undefined,
): GatewayTailscaleMode {
  if (cfg?.mode) return cfg.mode;
  if (cfg?.funnel === true) return "funnel";
  if (cfg?.autoServe === true) return "serve";
  return "off";
}

export function resolveTailscaleExposurePlan(params: {
  cfg: GatewayTailscaleConfig | undefined;
  gatewayPort: number;
}): TailscaleExposurePlan {
  const cfg = params.cfg;
  const mode = resolveTailscaleMode(cfg);
  const port =
    typeof cfg?.port === "number" && Number.isInteger(cfg.port) && cfg.port > 0
      ? cfg.port
      : params.gatewayPort;
  // Opt-in only, and OFF by default even when the gateway is exposed.
  //
  // `tailscale serve --bg <port>` mounts that port at the tailnet root (`/`), so
  // there is exactly one root rule per node: serving Expo overwrites the
  // gateway's rule and the control UI's tailnet URL starts returning Metro.
  // This used to run unconditionally on every boot, which is precisely how the
  // tailnet control-UI URL got hijacked. Expo does not need it — the phone can
  // reach `exp://<tailnet-host>:8081` directly over the tailnet.
  const exposeExpo = cfg?.exposeExpo === true;
  const expoPort = exposeExpo
    ? typeof cfg?.expoPort === "number" && Number.isInteger(cfg.expoPort) && cfg.expoPort > 0
      ? cfg.expoPort
      : DEFAULT_EXPO_PORT
    : null;
  return {
    mode,
    port,
    expoPort,
    resetOnExit: cfg?.resetOnExit === true,
    publicExposure: mode === "funnel",
  };
}
