import { isGatewayServed } from "../agency-collaboration/tailscale-service.js";
import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
  findTailscaleBinary,
  getTailnetHostname,
  readTailscaleServeStatusJson,
} from "../infra/tailscale.js";
import type { TailscaleExposurePlan } from "./tailscale-config.js";

export type TailscaleExposureLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

/** Injection seam so tests never touch a real `tailscale` binary. */
export type TailscaleExposureDeps = {
  findBinary: typeof findTailscaleBinary;
  readServeStatus: typeof readTailscaleServeStatusJson;
  enableServe: typeof enableTailscaleServe;
  enableFunnel: typeof enableTailscaleFunnel;
  disableServe: typeof disableTailscaleServe;
  disableFunnel: typeof disableTailscaleFunnel;
  tailnetHostname: typeof getTailnetHostname;
};

const defaultDeps: TailscaleExposureDeps = {
  findBinary: findTailscaleBinary,
  readServeStatus: readTailscaleServeStatusJson,
  enableServe: enableTailscaleServe,
  enableFunnel: enableTailscaleFunnel,
  disableServe: disableTailscaleServe,
  disableFunnel: disableTailscaleFunnel,
  tailnetHostname: getTailnetHostname,
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when serve/funnel already proxies `port`, so re-running would be churn. */
async function isAlreadyServed(
  deps: TailscaleExposureDeps,
  port: number,
): Promise<boolean | "unknown"> {
  try {
    return isGatewayServed(await deps.readServeStatus(), port);
  } catch {
    // No serve config at all, or the CLI could not be reached. Treat as
    // "unknown" so the caller still attempts to enable and reports the real
    // failure from that call rather than from a probe.
    return "unknown";
  }
}

export type GatewayTailscaleExposureParams = {
  plan: TailscaleExposurePlan;
  controlUiBasePath?: string;
  logTailscale: TailscaleExposureLog;
  deps?: Partial<TailscaleExposureDeps>;
};

/**
 * Bring `tailscale serve` (or funnel) up for the gateway, and log the resulting
 * tailnet URL once.
 *
 * Contract, in order of importance:
 *  - NEVER throws. Tailnet exposure is optional; a missing binary, a logged-out
 *    daemon or a permission error must not take the gateway down with it.
 *  - No-ops entirely when the plan is off (the default).
 *  - Idempotent: if the port is already served, it logs the URL and leaves the
 *    existing rule alone instead of tearing it down and recreating it.
 */
export async function startGatewayTailscaleExposure(
  params: GatewayTailscaleExposureParams,
): Promise<(() => Promise<void>) | null> {
  const { plan, logTailscale } = params;
  const deps = { ...defaultDeps, ...params.deps };

  if (plan.mode === "off" && plan.expoPort === null) return null;

  // One clear, actionable line if Tailscale simply is not usable here. This is
  // the common "gateway restarted after a reboot" case on a box without
  // Tailscale, and it must stay quiet and non-fatal.
  let binary: string | null = null;
  try {
    binary = await deps.findBinary();
  } catch (err) {
    logTailscale.warn(`tailscale binary lookup failed: ${errText(err)}`);
    return null;
  }
  if (!binary) {
    logTailscale.warn(
      "tailscale exposure requested but the tailscale CLI was not found " +
        "(looked on PATH and in the default install locations). " +
        "Install Tailscale and sign in, or set gateway.tailscale.autoServe=false. Continuing without it.",
    );
    return null;
  }

  if (plan.publicExposure) {
    logTailscale.warn(
      "tailscale FUNNEL is enabled — this gateway is reachable from the PUBLIC INTERNET, " +
        "not just your tailnet. Set gateway.tailscale.funnel=false (or mode=serve) for tailnet-only access.",
    );
  }

  // Expo first, gateway second. Serve mounts exactly one port at the tailnet
  // root, so whichever runs last wins it — and the control UI must win.
  // Serve, never funnel: funnel rejects ports outside 443/8443/10000.
  if (plan.expoPort !== null) {
    if (plan.mode !== "off") {
      logTailscale.warn(
        `gateway.tailscale.exposeExpo is on: Expo (port ${plan.expoPort}) and the control UI ` +
          "share one tailnet root path. The control UI takes it; reach Expo directly at " +
          `exp://<tailnet-host>:${plan.expoPort} instead.`,
      );
    }
    try {
      const already = await isAlreadyServed(deps, plan.expoPort);
      if (already !== true) await deps.enableServe(plan.expoPort);
      const host = await deps.tailnetHostname().catch(() => null);
      logTailscale.info(
        host
          ? `Expo serve enabled (exp://${host}:${plan.expoPort})`
          : `Expo serve enabled on port ${plan.expoPort}`,
      );
    } catch (err) {
      logTailscale.warn(`Expo serve failed (port ${plan.expoPort}): ${errText(err)}`);
    }
  }

  if (plan.mode !== "off") {
    try {
      const already = await isAlreadyServed(deps, plan.port);
      if (already === true) {
        await logExposureUrl(deps, params, `${plan.mode} already configured`);
      } else {
        if (plan.mode === "serve") await deps.enableServe(plan.port);
        else await deps.enableFunnel(plan.port);
        await logExposureUrl(deps, params, `${plan.mode} enabled`);
      }
    } catch (err) {
      logTailscale.warn(
        `${plan.mode} failed: ${errText(err)} — the gateway is still running on its local port. ` +
          "Check `tailscale status`; the gateway will retry on next startup.",
      );
    }
  }

  // Only return a cleanup handle when the gateway has exposure configured.
  // The Expo serve rule persists (and gets re-established on next startup).
  if (!plan.resetOnExit || plan.mode === "off") return null;

  return async () => {
    try {
      if (plan.mode === "serve") await deps.disableServe();
      else await deps.disableFunnel();
    } catch (err) {
      logTailscale.warn(`${plan.mode} cleanup failed: ${errText(err)}`);
    }
  };
}

async function logExposureUrl(
  deps: TailscaleExposureDeps,
  params: GatewayTailscaleExposureParams,
  prefix: string,
): Promise<void> {
  const host = await deps.tailnetHostname().catch(() => null);
  if (!host) {
    params.logTailscale.info(prefix);
    return;
  }
  const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
  params.logTailscale.info(`${prefix}: https://${host}${uiPath} (WS via wss://${host})`);
}

/**
 * Fire-and-forget wrapper used at gateway boot. Returns immediately with a
 * cleanup handle that waits for the in-flight setup, so startup is never
 * blocked on the tailscale CLI (which can take seconds, or hang on a wedged
 * daemon) and never fails because of it.
 */
export function startGatewayTailscaleExposureDetached(
  params: GatewayTailscaleExposureParams,
): () => Promise<void> {
  const pending = startGatewayTailscaleExposure(params).catch((err) => {
    // startGatewayTailscaleExposure is written not to throw; this is a belt-and
    // -braces guard so a bug in it can never produce an unhandled rejection.
    params.logTailscale.warn(`tailscale exposure setup failed: ${errText(err)}`);
    return null;
  });
  return async () => {
    const cleanup = await pending;
    if (cleanup) await cleanup();
  };
}
