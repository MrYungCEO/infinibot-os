/**
 * Network / Tailscale controller.
 *
 * State + RPC dispatchers for the Tailscale exposure panel. Polls
 * `network.tailscale.status` on a slow interval, exposes refresh and
 * enable/disable actions, and surfaces the last error to the view.
 */

import type { GatewayBrowserClient } from "../gateway";
import type {
  NetworkPanelState,
  NetworkTailscaleStatus,
} from "../views/network-control-panel";

export function createNetworkPanelState(): NetworkPanelState {
  return {
    loading: false,
    status: null,
    exposure: {},
    busy: null,
    lastError: undefined,
    lastUpdated: null,
  };
}

type RequestUpdate = () => void;

export type NetworkPanelHandlers = {
  refresh: () => Promise<void>;
  enable: (mode: "serve" | "funnel") => Promise<void>;
  disable: (mode: "serve" | "funnel" | "both") => Promise<void>;
  start: () => void;
  stop: () => void;
};

export function createNetworkPanelHandlers(
  client: GatewayBrowserClient | null,
  state: NetworkPanelState,
  requestUpdate: RequestUpdate,
  options?: { pollIntervalMs?: number },
): NetworkPanelHandlers {
  const pollMs = options?.pollIntervalMs ?? 10_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    if (!client) return;
    state.loading = true;
    state.lastError = undefined;
    requestUpdate();
    try {
      const res = await client.request<NetworkTailscaleStatus>(
        "network.tailscale.status",
        {},
      );
      state.status = res ?? null;
      // Reflect what the daemon actually has configured. Without this the
      // panel only knows about serve rules created by clicking these buttons,
      // so a rule the gateway brought up at startup (or one that survived a
      // reboot) rendered as "inactive".
      if (typeof res?.serveEnabled === "boolean") {
        state.exposure.serve = { active: res.serveEnabled, port: res.servePort };
      }
      state.lastUpdated = Date.now();
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
      requestUpdate();
    }
  }

  async function enable(mode: "serve" | "funnel"): Promise<void> {
    if (!client) return;
    state.busy = mode;
    state.lastError = undefined;
    requestUpdate();
    try {
      await client.request("network.tailscale.enable", { mode });
      if (mode === "serve") state.exposure.serve = { active: true };
      else state.exposure.funnel = { active: true };
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      state.busy = null;
      requestUpdate();
      void refresh();
    }
  }

  async function disable(mode: "serve" | "funnel" | "both"): Promise<void> {
    if (!client) return;
    state.busy = mode === "both" ? "disable" : mode;
    state.lastError = undefined;
    requestUpdate();
    try {
      await client.request("network.tailscale.disable", { mode });
      if (mode === "serve" || mode === "both") state.exposure.serve = { active: false };
      if (mode === "funnel" || mode === "both") state.exposure.funnel = { active: false };
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      state.busy = null;
      requestUpdate();
      void refresh();
    }
  }

  function start(): void {
    if (pollTimer) return;
    void refresh();
    pollTimer = setInterval(() => {
      void refresh();
    }, pollMs);
  }

  function stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return { refresh, enable, disable, start, stop };
}
