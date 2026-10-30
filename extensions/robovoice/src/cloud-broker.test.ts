/**
 * Robovoice on InfiniBot Cloud: the plugin side of the hosted voice broker.
 * fetch is mocked — no broker, no LiveKit.
 */
import { describe, expect, it, vi } from "vitest";
import {
  bearerFrom,
  brokerConnectionDetails,
  brokerEndSession,
  cloudBrokerUrl,
  cloudLinkStatus,
} from "./cloud-broker.js";

const FLEET = { SAAS_MODE: "1", FLEET_TENANT_ID: "t-1" } as NodeJS.ProcessEnv;

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

describe("cloud broker detection", () => {
  it("only a fleet tenant Machine with FLEET_VOICE_BROKER_URL uses the broker (local path unchanged)", () => {
    expect(cloudBrokerUrl({})).toBeNull();
    expect(cloudBrokerUrl({ FLEET_VOICE_BROKER_URL: "https://cloud.infinibotos.com" })).toBeNull();
    expect(cloudBrokerUrl({ ...FLEET })).toBeNull();
    expect(cloudBrokerUrl({ ...FLEET, FLEET_VOICE_BROKER_URL: "http://evil.example" })).toBeNull();
    expect(cloudBrokerUrl({ ...FLEET, FLEET_VOICE_BROKER_URL: "https://cloud.infinibotos.com/" })).toBe(
      "https://cloud.infinibotos.com",
    );
  });

  it("reads the Bearer the cloud UI sends", () => {
    expect(bearerFrom("Bearer abc.def")).toBe("abc.def");
    expect(bearerFrom(undefined)).toBeNull();
    expect(bearerFrom("Basic x")).toBeNull();
  });
});

describe("broker client", () => {
  it("forwards the member's Clerk session and returns the LiveKit session", async () => {
    const f = fetchReturning(200, {
      serverUrl: "wss://p.livekit.cloud",
      participantToken: "jwt",
      roomName: "tenant-x-main-abcdef12",
      participantName: "user-1",
      characterId: "main",
      grantedSeconds: 600,
    });
    const conn = await brokerConnectionDetails({
      brokerUrl: "https://cloud.infinibotos.com",
      bearer: "clerk-jwt",
      agentId: "main",
      characterId: "main",
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(conn).toMatchObject({ serverUrl: "wss://p.livekit.cloud", roomName: "tenant-x-main-abcdef12", grantedSeconds: 600 });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://cloud.infinibotos.com/api/voice/connection-details?agent=main&character=main");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer clerk-jwt");
    expect(init?.method).toBe("POST");
  });

  it("keeps the broker's status + code (402 credits, 503 not configured)", async () => {
    await expect(
      brokerConnectionDetails({
        brokerUrl: "https://b",
        bearer: "x",
        fetchImpl: fetchReturning(402, { error: "Voice minutes used up — top up credits or upgrade to keep talking.", code: "insufficient_balance" }) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_balance", message: expect.stringMatching(/top up/) });
    await expect(
      brokerConnectionDetails({
        brokerUrl: "https://b",
        bearer: "x",
        fetchImpl: fetchReturning(503, { error: "voice broker not configured", code: "voice_broker_not_configured" }) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 503, code: "voice_broker_not_configured" });
  });

  it("ends a session with the room in the body", async () => {
    const f = fetchReturning(200, { ok: true, closed: true, billedSeconds: 42 });
    await expect(
      brokerEndSession({ brokerUrl: "https://b", bearer: "x", room: "tenant-r", fetchImpl: f as unknown as typeof fetch }),
    ).resolves.toMatchObject({ closed: true });
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ room: "tenant-r" });
  });

  it("cloud link status lets the Voice page show the call console", () => {
    const s = cloudLinkStatus("https://cloud.infinibotos.com", [{ agentId: "main", name: "Main" }]);
    expect(s).toMatchObject({ linked: true, pending: null, agents: [{ agentId: "main", characterId: "main" }] });
  });
});
