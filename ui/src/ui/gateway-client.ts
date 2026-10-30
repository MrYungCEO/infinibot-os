/**
 * Gateway client helper for standalone components (like LitElements).
 *
 * The root custom element is `<infinibot-app>` (see ui/src/ui/app.ts).
 * We keep `<infinibot-control-ui>` as a back-compat fallback in case some
 * environment still mounts under the old name. The element exposes a
 * `client: GatewayBrowserClient | null` property that is populated once
 * the gateway WebSocket has connected — components that fire RPCs before
 * that happens see `client === null` here, which is what the
 * "not initialized" error catches.
 */

import type { GatewayBrowserClient } from "./gateway";
export type { GatewayBrowserClient } from "./gateway";

function getAppElement(): Element | null {
  return (
    document.querySelector("infinibot-app") ??
    document.querySelector("infinibot-control-ui")
  );
}

export function getGatewayClient(): GatewayBrowserClient | null {
  const app = getAppElement();
  if (app && "client" in app) {
    const c = (app as { client?: GatewayBrowserClient | null }).client;
    return c ?? null;
  }
  return null;
}

/**
 * Wait up to `timeoutMs` for the app's gateway client to be available.
 * Resolves immediately if it's already present; otherwise polls every
 * 50ms. Useful for components that race the WebSocket connection during
 * page load (the Emails page opens with `gmail.status` in
 * connectedCallback).
 */
export async function awaitGatewayClient(timeoutMs = 5000): Promise<GatewayBrowserClient> {
  const t0 = Date.now();
  while (true) {
    const client = getGatewayClient();
    if (client) return client;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("Gateway client not available - app not initialized");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function gatewayCall<T = unknown>(method: string, params: unknown): Promise<T> {
  const client = await awaitGatewayClient();
  return client.request<T>(method, params);
}
