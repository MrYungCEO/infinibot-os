import { afterEach, describe, expect, it, vi } from "vitest";

// isCloudBuild() reads import.meta.env; force the hosted-cloud build.
vi.mock("./cloud/cloud-env", () => ({ isCloudBuild: () => true }));

import { setResolvedGatewayUrl } from "./gateway-endpoint";
import {
  gatewayAuthHeaders,
  gatewayHttpOrigin,
  isGatewayHttpUrl,
  setGatewayHttpCredentials,
} from "./gateway-http-auth";

describe("gateway HTTP credentials in the hosted cloud", () => {
  afterEach(() => {
    setResolvedGatewayUrl(null);
    setGatewayHttpCredentials({ token: undefined, getClerkToken: undefined, gatewayUrl: undefined });
    vi.unstubAllGlobals();
  });

  it("targets the resolved tenant Machine even when app settings lost the URL", () => {
    vi.stubGlobal("location", { origin: "https://infinibot-cloud.netlify.app", href: "https://infinibot-cloud.netlify.app/chat" });
    setGatewayHttpCredentials({ gatewayUrl: "" });
    setResolvedGatewayUrl("wss://ib-gw-abc.fly.dev/ws");
    expect(gatewayHttpOrigin()).toBe("https://ib-gw-abc.fly.dev");
    expect(isGatewayHttpUrl("https://ib-gw-abc.fly.dev/api/files/list")).toBe(true);
    expect(isGatewayHttpUrl("https://evil.example/api/x")).toBe(false);
  });

  it("prefers a fresh Clerk token over a stale token in settings", async () => {
    setGatewayHttpCredentials({ token: "stale-clerk-jwt", getClerkToken: async () => "fresh" });
    expect((await gatewayAuthHeaders()).Authorization).toBe("Bearer fresh");
  });

  it("falls back to the shared token when Clerk has no session", async () => {
    setGatewayHttpCredentials({ token: "shared", getClerkToken: async () => null });
    expect((await gatewayAuthHeaders()).Authorization).toBe("Bearer shared");
  });
});

describe("cloud fetch wrapper", () => {
  afterEach(() => {
    setResolvedGatewayUrl(null);
    setGatewayHttpCredentials({ getClerkToken: undefined });
    vi.unstubAllGlobals();
  });

  it("sends the Clerk Bearer without cookies to the tenant gateway", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("location", { origin: "https://infinibot-cloud.netlify.app", href: "https://infinibot-cloud.netlify.app/" });
    vi.stubGlobal("window", { fetch: async (_i: unknown, init: RequestInit) => (seen.push(init), new Response("{}")) });
    const { installGatewayFetchAuth, ensureGatewaySession } = await import("./gateway-http-auth");
    setResolvedGatewayUrl("wss://ib-gw-abc.fly.dev/ws");
    setGatewayHttpCredentials({ getClerkToken: async () => "fresh" });
    installGatewayFetchAuth();
    await (window as unknown as { fetch: typeof fetch }).fetch("https://ib-gw-abc.fly.dev/api/x");
    expect(new Headers(seen[0]!.headers).get("authorization")).toBe("Bearer fresh");
    expect(seen[0]!.credentials).toBeUndefined();
    expect(await ensureGatewaySession()).toBe(false);
  });
});
