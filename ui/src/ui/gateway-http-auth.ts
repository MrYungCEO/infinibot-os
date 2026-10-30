/**
 * Credentials for the gateway's HTTP routes.
 *
 * Every gateway HTTP route (except a small public allowlist) requires the
 * gateway credential. Two mechanisms cover the whole UI:
 *
 *  1. A `fetch` wrapper that adds `Authorization` + `X-InfiniBot-Request` to
 *     every request aimed at the gateway (same origin, or the configured
 *     gateway URL). Existing headers are never overwritten.
 *  2. An httpOnly session cookie minted by `POST /api/auth/session`, for the
 *     things that cannot carry headers: `<img>`, `<video>`, `<audio>`,
 *     `<iframe>`, `EventSource`, download links.
 *
 * Credential precedence: Clerk session (SaaS) → shared token/password →
 * paired-device token. Tailscale-identity setups need no credential at all;
 * the session call still succeeds for them.
 */

import { isCloudBuild } from "./cloud/cloud-env";
import { resolvedGatewayUrl } from "./gateway-endpoint";

export const CSRF_HEADER = "X-InfiniBot-Request";
export const DEVICE_ID_HEADER = "X-InfiniBot-Device-Id";

export type GatewayHttpCredentials = {
  token?: string;
  password?: string;
  deviceId?: string;
  deviceToken?: string;
  /** SaaS: fetch a fresh Clerk session token. */
  getClerkToken?: () => Promise<string | null>;
  /** ws(s):// or http(s):// URL of the gateway the UI talks to. */
  gatewayUrl?: string;
};

let creds: GatewayHttpCredentials = {};
let installed = false;
let sessionInFlight: Promise<boolean> | null = null;

export function setGatewayHttpCredentials(next: GatewayHttpCredentials): void {
  creds = { ...creds, ...next };
}

export function getGatewayHttpCredentials(): GatewayHttpCredentials {
  return creds;
}

/** http(s) origin of the configured gateway, or the page origin. */
export function gatewayHttpOrigin(): string {
  // Hosted cloud: the tenant Machine resolved by fleet-connect is the gateway,
  // whatever the (reset-on-mount) app settings say.
  const raw = resolvedGatewayUrl() ?? creds.gatewayUrl?.trim();
  if (raw) {
    try {
      const u = new URL(raw.replace(/^ws(s?):\/\//i, "http$1://"));
      return u.origin;
    } catch {
      // fall through
    }
  }
  return typeof location !== "undefined" ? location.origin : "";
}

/** Absolute base for gateway HTTP calls; "" when it is the page origin. */
export function gatewayHttpBase(): string {
  const origin = gatewayHttpOrigin();
  if (typeof location !== "undefined" && origin === location.origin) return "";
  return origin;
}

function resolveUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input, location.href);
    if (input instanceof URL) return input;
    return new URL((input as Request).url, location.href);
  } catch {
    return null;
  }
}

export function isGatewayHttpUrl(input: RequestInfo | URL): boolean {
  const url = resolveUrl(input);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin === location.origin || url.origin === gatewayHttpOrigin();
}

/** Headers carrying the best available credential (may be empty). */
export async function gatewayAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { [CSRF_HEADER]: "1" };
  // SaaS: a fresh Clerk session token first. Anything in token/settings may
  // be an earlier Clerk JWT (they live ~60s), which would 401 once expired.
  if (creds.getClerkToken) {
    try {
      const clerk = await creds.getClerkToken();
      if (clerk) {
        headers.Authorization = `Bearer ${clerk}`;
        return headers;
      }
    } catch {
      // no Clerk session yet — fall through to other credentials
    }
  }
  const shared = creds.token?.trim() || creds.password?.trim();
  if (shared) {
    headers.Authorization = `Bearer ${shared}`;
    return headers;
  }
  if (creds.deviceId && creds.deviceToken) {
    headers.Authorization = `Bearer ${creds.deviceToken}`;
    headers[DEVICE_ID_HEADER] = creds.deviceId;
    return headers;
  }
  return headers;
}

/** Synchronous variant for code that cannot await (no Clerk). */
export function gatewayAuthHeadersSync(): Record<string, string> {
  const headers: Record<string, string> = { [CSRF_HEADER]: "1" };
  const shared = creds.token?.trim() || creds.password?.trim();
  if (shared) headers.Authorization = `Bearer ${shared}`;
  else if (creds.deviceId && creds.deviceToken) {
    headers.Authorization = `Bearer ${creds.deviceToken}`;
    headers[DEVICE_ID_HEADER] = creds.deviceId;
  }
  return headers;
}

/**
 * Wrap `window.fetch` once so every gateway-bound request carries the
 * credential. Headers the caller set explicitly win.
 */
export function installGatewayFetchAuth(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isGatewayHttpUrl(input)) return original(input, init);
    const auth = await gatewayAuthHeaders();
    const base =
      init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined);
    const headers = new Headers(base);
    for (const [k, v] of Object.entries(auth)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    const url = resolveUrl(input);
    const crossOrigin = Boolean(url && url.origin !== location.origin);
    // Hosted cloud: auth is the Bearer header only. The session cookie can't
    // cross sites (SameSite=Strict), and a credentialed request would need
    // Allow-Credentials, which older tenant gateway images don't send.
    const withCookies = crossOrigin && !init?.credentials && !isCloudBuild();
    const nextInit: RequestInit = {
      ...init,
      headers,
      ...(withCookies ? { credentials: "include" as const } : {}),
    };
    if (typeof input === "object" && !(input instanceof URL)) {
      return original(new Request(input as Request, nextInit));
    }
    return original(input, nextInit);
  };
}

/**
 * Exchange the current credential for the httpOnly session cookie. Safe to
 * call repeatedly (deduped while in flight). Resolves false when the gateway
 * rejected every credential we have.
 */
export function ensureGatewaySession(opts: { requireCredential?: boolean } = {}): Promise<boolean> {
  // Hosted cloud: the tenant gateway is cross-site, so its SameSite=Strict
  // cookie would never be sent back — every call carries the Clerk Bearer.
  if (isCloudBuild()) return Promise.resolve(false);
  if (opts.requireCredential && !hasCredential()) return Promise.resolve(false);
  if (sessionInFlight) return sessionInFlight;
  sessionInFlight = (async () => {
    try {
      const body: Record<string, string> = {};
      if (creds.deviceId && creds.deviceToken) {
        body.deviceId = creds.deviceId;
        body.deviceToken = creds.deviceToken;
      }
      const res = await fetch(`${gatewayHttpBase()}/api/auth/session`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      sessionInFlight = null;
    }
  })();
  return sessionInFlight;
}

function hasCredential(): boolean {
  return Boolean(
    creds.token?.trim() || creds.password?.trim() || (creds.deviceId && creds.deviceToken),
  );
}

/** Drop the session cookie (logout). */
export async function clearGatewaySession(): Promise<void> {
  try {
    await fetch(`${gatewayHttpBase()}/api/auth/session`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch {
    // ignore
  }
}
