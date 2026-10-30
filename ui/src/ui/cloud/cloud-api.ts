/**
 * HTTPS client for serverless InfiniBot Cloud (netlify/functions → src/saas/cloud/api.ts):
 * the account surfaces and the assistant workspace (chat over SSE, channels).
 *
 * Exposes the same `request(method, params)` shape as GatewayBrowserClient for
 * the handful of RPCs the SaaS surfaces use, so the onboarding views and the
 * account menu run unchanged against either backend. Every call carries the
 * member's Clerk session JWT as a bearer token; the server derives the tenant
 * from it. Nothing here ever sends a tenant id.
 */
import { getClerkToken } from "../saas-clerk";
import { cloudApiBase } from "./cloud-env";

type Route = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: (p: Record<string, unknown>) => string; body?: boolean };

/** Gateway RPC name → Functions endpoint. */
const ROUTES: Record<string, Route> = {
  "saas.me": { method: "GET", path: () => "/me" },
  "saas.onboarding.status": { method: "GET", path: () => "/onboarding/status" },
  "saas.onboarding.saveKey": { method: "POST", path: () => "/onboarding/keys", body: true },
  "saas.onboarding.removeKey": {
    method: "DELETE",
    path: (p) => `/onboarding/keys/${encodeURIComponent(String(p.provider ?? ""))}`,
  },
  "saas.onboarding.step": { method: "PUT", path: () => "/onboarding/step", body: true },
  "saas.onboarding.complete": { method: "POST", path: () => "/onboarding/complete", body: true },
  "saas.onboarding.business.save": { method: "PUT", path: () => "/business", body: true },
  "saas.business.get": { method: "GET", path: () => "/business" },
  "saas.profile.get": { method: "GET", path: () => "/profile" },
  "saas.profile.update": { method: "PATCH", path: () => "/profile", body: true },
  "cloud.chat.models": { method: "GET", path: () => "/chat/models" },
  "cloud.chat.conversations": { method: "GET", path: () => "/chat/conversations" },
  "cloud.chat.conversation": {
    method: "GET",
    path: (p) => `/chat/conversations/${encodeURIComponent(String(p.id ?? ""))}`,
  },
  "cloud.chat.conversation.update": {
    method: "PATCH",
    path: (p) => `/chat/conversations/${encodeURIComponent(String(p.id ?? ""))}`,
    body: true,
  },
  "cloud.chat.conversation.delete": {
    method: "DELETE",
    path: (p) => `/chat/conversations/${encodeURIComponent(String(p.id ?? ""))}`,
  },
  "cloud.channels.list": { method: "GET", path: () => "/channels" },
  "cloud.channels.telegram": { method: "POST", path: () => "/channels/telegram", body: true },
  "cloud.channels.slack": { method: "POST", path: () => "/channels/slack", body: true },
  "cloud.channels.remove": {
    method: "DELETE",
    path: (p) => `/channels/${encodeURIComponent(String(p.channel ?? ""))}`,
  },
};

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class CloudApiClient {
  /** Mirrors GatewayBrowserClient.connected for code that checks it. */
  readonly connected = true;

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const route = ROUTES[method];
    if (!route) throw new CloudApiError(501, `${method} is not available in the cloud workspace yet.`);
    return this.fetchJson<T>(route.method, route.path(params), route.body ? params : undefined);
  }

  async fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Idempotent calls survive one network blip (flaky mobile links, a
    // browser "network changed" abort). POSTs are never replayed.
    const idempotent = method !== "POST";
    const send = async (fresh: boolean): Promise<Response> => {
      const token = await getClerkToken({ fresh });
      if (!token) throw new CloudApiError(401, "You're signed out. Sign in again to continue.");
      const attempt = () => fetch(`${cloudApiBase()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: "omit",
        cache: "no-store",
      });
      try {
        return await attempt();
      } catch (err) {
        if (!idempotent) throw err;
        await new Promise((r) => setTimeout(r, 700));
        return attempt();
      }
    };
    let res = await send(false);
    // Clerk tokens live ~60s: one retry with a freshly minted token.
    if (res.status === 401) res = await send(true);
    const data = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
    if (!res.ok) {
      throw new CloudApiError(res.status, data?.error ?? `The workspace API returned HTTP ${res.status}.`);
    }
    return data as T;
  }

  /**
   * POST and read a Server-Sent Events stream (the chat Function streams the
   * assistant's reply). Resolves when the stream ends. A 401 before the stream
   * starts is retried once with a fresh Clerk token; POSTs are never replayed
   * after the server accepted them.
   */
  async stream(
    path: string,
    body: unknown,
    onEvent: (event: string, data: any) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const open = async (fresh: boolean) => {
      const token = await getClerkToken({ fresh });
      if (!token) throw new CloudApiError(401, "You're signed out. Sign in again to continue.");
      return fetch(`${cloudApiBase()}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        signal,
      });
    };
    let res = await open(false);
    if (res.status === 401) res = await open(true);
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new CloudApiError(res.status, data?.error ?? `The workspace API returned HTTP ${res.status}.`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          onEvent(event, JSON.parse(data));
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }

  /** No socket to close; kept so teardown code can call it blindly. */
  stop(): void {}
}
