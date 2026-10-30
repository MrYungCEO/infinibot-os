/**
 * Integration test for the `license.state` RPC against a live dev gateway.
 *
 * Confirms the response shape (plan/features/chat) for the default
 * self-hosted install — no INFINIBOT_LICENSE_JWT present, SaaS mode off. A
 * self-hosted install is ungated: top plan, every feature, no chat cap.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;

beforeAll(async () => {
  delete process.env.INFINIBOT_LICENSE_JWT;
  delete process.env.INFINIBOT_FEATURE_OVERRIDE;
  delete process.env.SAAS_MODE;
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("license.state RPC", () => {
  test("returns an ungated payload on an unlicensed self-hosted install", async () => {
    const res = (await rpcReq(ws, "license.state", {})) as {
      ok: boolean;
      payload: {
        licensed: boolean;
        plan: string;
        rank: number;
        features: string[];
        chat: { used: number; cap: number | null };
      };
    };
    expect(res.ok).toBe(true);
    expect(res.payload.licensed).toBe(false);
    expect(res.payload.plan).toBe("vip");
    expect(Array.isArray(res.payload.features)).toBe(true);
    // Self-hosted: baseline and premium features alike.
    expect(res.payload.features).toContain("ai_chat_basic");
    expect(res.payload.features).toContain("agent_builder");
    // A self-hosted install reports NO chat cap. `cap: null` is what the UI
    // reads as unlimited; reporting 15 here would show the user a limit that
    // nothing enforces, since the daily cap is off unless the install opts in
    // with INFINIBOT_ENFORCE_CHAT_CAP (see src/license/chat-counter.ts).
    expect(res.payload.chat.cap).toBeNull();
  });
});
