import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFleetGateway } from "./fleet-connect";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("resolveFleetGateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serverless plan → kind serverless with the entitlements, no gateway URL", async () => {
    const entitlements = { plan: "free", mode: "serverless", features: { data: true, agents: false }, locked: ["agents"] };
    vi.stubGlobal("fetch", reply(200, { mode: "serverless", status: "serverless", tenantId: "t", plan: "free", entitlements }));
    expect(await resolveFleetGateway("jwt")).toEqual({ kind: "serverless", plan: "free", entitlements });
  });

  it("gateway tenants are unchanged: 200 with a wss URL → ready", async () => {
    vi.stubGlobal("window", { location: { hostname: "app.example.com", protocol: "https:" } });
    vi.stubGlobal("fetch", reply(200, { gatewayWsUrl: "wss://ib-gw-x.fly.dev/ws", status: "ready", tenantId: "t" }));
    const r = await resolveFleetGateway("jwt");
    expect(r.kind).toBe("ready");
  });
});
