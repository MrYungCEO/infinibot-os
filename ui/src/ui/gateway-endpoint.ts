/**
 * Single source of truth for "where is the gateway" when building HTTP / WS
 * endpoints outside the GatewayBrowserClient RPC socket.
 *
 * Local / self-hosted (and Electron): the gateway serves the page, so every
 * accessor falls back to the page origin and relative URLs stay relative —
 * behaviour is identical to before this module existed.
 *
 * Hosted cloud (VITE_INFINIBOT_CLOUD=1): the page is static on Netlify and the
 * member's gateway is a per-tenant Fly Machine whose WSS URL comes only from
 * POST /fleet/resolve (cloud/fleet-connect.ts). fleet-connect calls
 * setResolvedGatewayUrl() with it before the app boots; from then on:
 *   - gatewayHttpBase()/gatewayWsBase()/gatewayOrigin() point at that Machine,
 *   - installGatewayRouting() rewrites same-origin fetch()/EventSource calls to
 *     gateway paths (/api/…, /media/…, …) onto it, so the ~90 relative call
 *     sites across the views need no per-site change.
 * URLs that are *displayed* or handed to third parties (webhook URLs, OAuth
 * redirect URIs, QR images) are not fetched, so those call sites use
 * gatewayOrigin() explicitly.
 */
import { isCloudBuild } from "./cloud/cloud-env";
import { isGatewaySleeping, onSleepChange } from "./cloud/gateway-sleep";

let resolvedWsUrl: string | null = null;

/** Set by the cloud connect flow once /fleet/resolve answers. Cloud-only. */
export function setResolvedGatewayUrl(wsUrl: string | null): void {
  resolvedWsUrl = wsUrl && isCloudBuild() ? wsUrl : null;
}

/** The resolved tenant gateway WS URL (cloud), or null (local / not yet resolved). */
export function resolvedGatewayUrl(): string | null {
  return resolvedWsUrl;
}

function resolvedUrl(): URL | null {
  if (!resolvedWsUrl) return null;
  try {
    return new URL(resolvedWsUrl);
  } catch {
    return null;
  }
}

/**
 * HTTP(S) origin of the gateway for building absolute URLs. Cloud: the
 * tenant Machine (https://<host>); otherwise the page origin.
 */
export function gatewayOrigin(): string {
  const u = resolvedUrl();
  if (u) return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
  return window.location.origin;
}

/**
 * Prefix for gateway HTTP paths. "" locally (keep relative, same-origin URLs
 * exactly as before); the tenant Machine's https origin in the cloud.
 */
export function gatewayHttpBase(): string {
  return resolvedUrl() ? gatewayOrigin() : "";
}

/** `${gatewayHttpBase()}${path}` — path must start with "/". */
export function gatewayHttpUrl(path: string): string {
  return `${gatewayHttpBase()}${path}`;
}

/** ws(s)://host of the gateway (no path). Cloud: the tenant Machine; else page origin. */
export function gatewayWsBase(): string {
  const u = resolvedUrl();
  if (u) return `${u.protocol}//${u.host}`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

/** `${gatewayWsBase()}${path}` — path must start with "/". */
export function gatewayWsUrl(path: string): string {
  return `${gatewayWsBase()}${path}`;
}

// ── Cloud fetch / EventSource routing ───────────────────────────────────────

/** Page-relative paths that are gateway endpoints (not static assets / SPA routes). */
const GATEWAY_PATH_PREFIXES = [
  "/api/",
  "/media/",
  "/avatar/",
  "/files/",
  "/plugins/",
  "/gmail/oauth/",
  "/__infinibot__/",
];

/**
 * Same-origin routes that stay on the static host in the cloud: the Netlify
 * data Functions (netlify/functions/*.mts `config.path`) other than
 * /api/channels, whose only UI caller is the gateway's nostr profile route.
 * The full app does not call these today; they are excluded so a caller that
 * deliberately targets the Functions API is never silently re-pointed.
 */
const STATIC_HOST_PATHS = [
  "/api/health",
  "/api/me",
  "/api/profile",
  "/api/business",
  "/api/onboarding/",
  "/api/hooks/",
  "/api/chat/",
  // Marketplace registry, purchases and affiliate storefront are Netlify
  // Functions; re-pointing them at the tenant gateway 404s the Plugins tab.
  "/api/marketplace/",
  "/api/affiliate/",
  "/api/whop-checkout",
  "/api/whop-webhook",
  // Commercial licenses (tiers, checkout, receipt, owner admin): Netlify Functions.
  "/api/licenses/",
  // Hosted Free's daily limit (meter heartbeats, gate polling) and the voice
  // broker: re-pointed at the tenant gateway they 404, so the meter, upsells
  // and gate freeze once the workspace connects (docs/saas/FREE_PLAN.md).
  "/api/usage",
  "/api/usage/",
  "/api/voice/",
];

/** A same-origin path served by the static host's Functions, never the tenant gateway. */
export function isStaticHostPath(pathname: string): boolean {
  return STATIC_HOST_PATHS.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

function isGatewayPath(pathname: string): boolean {
  if (isStaticHostPath(pathname)) return false;
  return GATEWAY_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Map a URL the app would request from the page origin onto the resolved
 * gateway. Returns null when it should be left alone (not cloud / not resolved
 * / cross-origin already / not a gateway path).
 */
export function routeToGateway(input: string | URL): string | null {
  const gw = resolvedUrl();
  if (!gw) return null;
  let u: URL;
  try {
    u = new URL(String(input), document.baseURI);
  } catch {
    return null;
  }
  if (u.origin !== window.location.origin) return null;
  if (!isGatewayPath(u.pathname)) return null;
  return `${gatewayOrigin()}${u.pathname}${u.search}${u.hash}`;
}

let installed = false;

/**
 * Cloud only: patch window.fetch and window.EventSource so same-origin
 * requests to gateway paths go to the resolved tenant gateway. No-op locally.
 * Idempotent. The rewrite is decided per call, so it follows a re-resolve.
 */
export function installGatewayRouting(): void {
  if (installed || !isCloudBuild()) return;
  installed = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const target = routeToGateway(input instanceof Request ? input.url : input);
    // Asleep: a request would start the Machine through Fly's proxy, so the
    // views' background refreshes are answered here instead of on the network.
    if (target && isGatewaySleeping()) return Promise.resolve(sleepingResponse());
    if (input instanceof Request) {
      return nativeFetch(target ? new Request(target, input) : input, init);
    }
    return nativeFetch(target ?? input, init);
  };

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    // An open stream is a connection that keeps the Machine awake, and a
    // dropped one reconnects by itself (waking it): streams are closed when the
    // workspace goes to sleep. A view re-opens its stream when it is next shown.
    const open = new Set<EventSource>();
    class GatewayEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        const target = routeToGateway(url);
        super(target ?? url, init);
        if (!target) return;
        if (isGatewaySleeping()) {
          this.close();
          return;
        }
        open.add(this);
      }
      close(): void {
        open.delete(this);
        super.close();
      }
    }
    window.EventSource = GatewayEventSource;
    onSleepChange((phase) => {
      if (phase !== "sleeping") return;
      for (const es of [...open]) es.close();
    });
  }
}

/** What a gateway fetch gets while the workspace is asleep (never sent). */
export function sleepingResponse(): Response {
  return new Response(JSON.stringify({ ok: false, error: "workspace_sleeping" }), {
    status: 503,
    statusText: "Workspace sleeping",
    headers: { "content-type": "application/json", "x-infinibot-sleeping": "1" },
  });
}
