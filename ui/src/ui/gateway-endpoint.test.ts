import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  gatewayHttpBase,
  gatewayHttpUrl,
  gatewayOrigin,
  gatewayWsBase,
  gatewayWsUrl,
  installGatewayRouting,
  resolvedGatewayUrl,
  routeToGateway,
  setResolvedGatewayUrl,
} from "./gateway-endpoint";

const TENANT_WS = "wss://tenant-abc123.fly.dev/ws";
const TENANT_HTTP = "https://tenant-abc123.fly.dev";

describe("gateway-endpoint (local build)", () => {
  it("keeps same-origin behaviour and ignores a resolved URL", () => {
    setResolvedGatewayUrl(TENANT_WS); // not a cloud build: must be ignored
    expect(resolvedGatewayUrl()).toBeNull();
    expect(gatewayHttpBase()).toBe("");
    expect(gatewayHttpUrl("/api/stt")).toBe("/api/stt");
    expect(gatewayOrigin()).toBe(window.location.origin);
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    expect(gatewayWsBase()).toBe(`${wsProto}://${window.location.host}`);
    expect(routeToGateway("/api/stt")).toBeNull();
  });

  it("does not patch fetch outside the cloud build", () => {
    const before = window.fetch;
    installGatewayRouting();
    expect(window.fetch).toBe(before);
  });
});

describe("gateway-endpoint (cloud build, resolved tenant gateway)", () => {
  const seen: string[] = [];
  const realFetch = window.fetch;

  beforeAll(() => {
    vi.stubEnv("VITE_INFINIBOT_CLOUD", "1");
    window.fetch = (async (input: RequestInfo | URL) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    setResolvedGatewayUrl(TENANT_WS);
    installGatewayRouting();
  });
  afterAll(() => {
    window.fetch = realFetch;
    setResolvedGatewayUrl(null);
    vi.unstubAllEnvs();
  });

  it("derives HTTP and WS bases from the resolved gateway, not the page origin", () => {
    expect(resolvedGatewayUrl()).toBe(TENANT_WS);
    expect(gatewayOrigin()).toBe(TENANT_HTTP);
    expect(gatewayHttpUrl("/api/stt")).toBe(`${TENANT_HTTP}/api/stt`);
    expect(gatewayWsUrl("/ws")).toBe("wss://tenant-abc123.fly.dev/ws");
    expect(gatewayOrigin()).not.toContain(window.location.host);
  });

  it("routes relative gateway fetches (STT, uploads, avatars) to the tenant Machine", async () => {
    seen.length = 0;
    await fetch("/api/stt", { method: "POST", body: "x" });
    await fetch("/api/voice/stt?lang=en");
    await fetch(`${window.location.origin}/api/workspace/upload`, { method: "POST", body: "x" });
    await fetch(new Request(`${window.location.origin}/avatar/main?meta=1`));
    expect(seen).toEqual([
      `${TENANT_HTTP}/api/stt`,
      `${TENANT_HTTP}/api/voice/stt?lang=en`,
      `${TENANT_HTTP}/api/workspace/upload`,
      `${TENANT_HTTP}/avatar/main?meta=1`,
    ]);
  });

  it("leaves static assets, SPA routes, Netlify Functions and foreign hosts alone", async () => {
    seen.length = 0;
    await fetch("/assets/app.js");
    await fetch("/chat/main");
    await fetch("/api/me");
    await fetch("/api/onboarding/state");
    await fetch("/fleet/resolve", { method: "POST" });
    await fetch("https://api.example.com/api/x");
    expect(seen).toEqual([
      "/assets/app.js",
      "/chat/main",
      "/api/me",
      "/api/onboarding/state",
      "/fleet/resolve",
      "https://api.example.com/api/x",
    ]);
  });

  it("routes EventSource streams to the tenant Machine", () => {
    const es = new EventSource("/api/hardware/stream");
    try {
      expect(es.url).toBe(`${TENANT_HTTP}/api/hardware/stream`);
    } finally {
      es.close();
    }
  });

  it("keeps marketplace, affiliate and Whop Functions on the static host", () => {
    expect(routeToGateway("/api/marketplace/index.json")).toBeNull();
    expect(routeToGateway("/api/marketplace/plugins/flypic")).toBeNull();
    expect(routeToGateway("/api/affiliate/me")).toBeNull();
    expect(routeToGateway("/api/whop-checkout")).toBeNull();
    expect(routeToGateway("/api/stt")).toBe(`${TENANT_HTTP}/api/stt`);
  });

  it("follows a re-resolve (Machine moved)", () => {
    setResolvedGatewayUrl("wss://tenant-abc123-2.fly.dev/ws");
    expect(routeToGateway("/api/stt")).toBe("https://tenant-abc123-2.fly.dev/api/stt");
    setResolvedGatewayUrl(TENANT_WS);
  });
});
