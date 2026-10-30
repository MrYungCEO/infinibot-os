import fs from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.server.js";
import { testState } from "./test-helpers.mocks.js";

installGatewayTestHooks({ scope: "suite" });

function rawStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  // fetch() silently drops a custom Host header; http.request does not.
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * End-to-end check of the central HTTP gate against a real gateway server:
 * the probes from the OSS security audit must all be refused, while the same
 * requests with the gateway credential (header or session cookie) succeed.
 */
describe("gateway HTTP auth gate", () => {
  let port = 0;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let token = "";
  const EVIL = "https://evil.example";

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;

  // /api/settings persists to <cwd>/voice-settings.json; put it back afterwards.
  const voiceSettingsFile = path.join(process.cwd(), "voice-settings.json");
  let voiceSettingsBackup: string | null = null;

  beforeAll(async () => {
    voiceSettingsBackup = fs.existsSync(voiceSettingsFile)
      ? fs.readFileSync(voiceSettingsFile, "utf8")
      : null;
    delete process.env.INFINIBOT_GATEWAY_PASSWORD;
    token = "gate-test-token-0123456789";
    testState.gatewayAuth = { mode: "token", token };
    process.env.INFINIBOT_GATEWAY_TOKEN = token;
    port = await getFreePort();
    server = await startGatewayServer(port, { bind: "loopback" });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (voiceSettingsBackup === null) fs.rmSync(voiceSettingsFile, { force: true });
    else fs.writeFileSync(voiceSettingsFile, voiceSettingsBackup);
  });

  const unauthenticatedProbes: Array<[string, string, RequestInit?]> = [
    [
      "POST",
      "/tools/invoke",
      {
        headers: { "content-type": "text/plain", origin: EVIL },
        body: JSON.stringify({ tool: "gateway", args: { action: "config.get" } }),
      },
    ],
    ["GET", "/backup/download", { headers: { origin: EVIL } }],
    [
      "POST",
      "/backup/restore",
      { headers: { "content-type": "multipart/form-data; boundary=x" }, body: "--x--" },
    ],
    [
      "POST",
      "/api/voice/chat",
      {
        headers: { "content-type": "text/plain", origin: EVIL },
        body: '{"message":"say CSRF-OK"}',
      },
    ],
    ["POST", "/api/voice/chat/stream", { headers: { "content-type": "text/plain" }, body: "{}" }],
    ["POST", "/api/voice/spawn", { headers: { "content-type": "text/plain" }, body: "{}" }],
    ["GET", "/api/settings", { headers: { origin: EVIL } }],
    [
      "POST",
      "/api/settings",
      { headers: { "content-type": "text/plain" }, body: '{"voice_route":"codex"}' },
    ],
    ["GET", "/api/reports"],
    ["GET", "/api/runs/x/stream"],
    ["GET", "/api/coder/backends"],
    ["POST", "/api/coder/mcp-install", { body: "{}" }],
    ["POST", "/api/voice/tts", { body: "{}" }],
    ["POST", "/api/voice/stt", { body: "x" }],
    ["GET", "/api/hardware/snapshot"],
    ["POST", "/api/push-tokens/register", { body: "{}" }],
    ["POST", "/api/proactive/emit", { body: "{}" }],
    ["GET", "/api/workflow-engine"],
    ["GET", "/api/docs/tree"],
    ["GET", "/media/x.png"],
    ["GET", "/api/plugin-assets/omniclinic/assets/cover.svg"],
    ["GET", "/api/plugin-assets/omniclinic/..%2F..%2Fpackage.json"],
  ];

  it.each(unauthenticatedProbes)(
    "refuses unauthenticated %s %s (even from loopback)",
    async (method, path, init) => {
      const res = await fetch(url(path), { method, ...init });
      expect(res.status).toBe(401);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    },
  );

  it("serves protected routes with the Bearer credential", async () => {
    const res = await fetch(url("/api/settings"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("tts_provider");
  });

  it("serves plugin listing assets only past the gate, and never outside the plugin", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const declared = await fetch(url("/api/plugin-assets/omniclinic/assets/cover.svg"), {
      headers: auth,
    });
    expect(declared.status).not.toBe(401);
    for (const probe of [
      "/api/plugin-assets/omniclinic/..%2F..%2Fpackage.json",
      "/api/plugin-assets/omniclinic/../../package.json",
      "/api/plugin-assets/omniclinic/index.ts",
    ]) {
      expect([400, 404]).toContain((await fetch(url(probe), { headers: auth })).status);
    }
  });

  it("rejects a wrong Bearer", async () => {
    const res = await fetch(url("/api/settings"), { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("keeps the public allowlist reachable without credentials", async () => {
    expect((await fetch(url("/install.sh"))).status).not.toBe(401);
    expect((await fetch(url("/"))).status).not.toBe(401);
    expect((await fetch(url("/chat"))).status).not.toBe(401);
    const login = await fetch(url("/api/users/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "x", password: "y" }),
    });
    // Reaches the login handler (token-mode gateway has no password → 503),
    // rather than being stopped by the gate.
    expect(login.status).toBe(503);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    expect(
      await rawStatus(port, "/api/settings", {
        authorization: `Bearer ${token}`,
        host: "evil.example:18789",
      }),
    ).toBe(403);
    expect(
      await rawStatus(port, "/api/settings", {
        authorization: `Bearer ${token}`,
        host: "localhost",
      }),
    ).toBe(200);
  });

  it("answers CORS preflight without granting a foreign origin", async () => {
    const res = await fetch(url("/tools/invoke"), {
      method: "OPTIONS",
      headers: {
        origin: EVIL,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  describe("session cookie", () => {
    let cookie = "";

    it("is minted by POST /api/auth/session with the credential", async () => {
      const bad = await fetch(url("/api/auth/session"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "nope" }),
      });
      expect(bad.status).toBe(401);

      const res = await fetch(url("/api/auth/session"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(new RegExp(`^infinibot_session_${port}=`));
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      cookie = setCookie.split(";")[0]!;
    });

    it("authenticates reads (img/EventSource/download)", async () => {
      const res = await fetch(url("/api/settings"), { headers: { cookie } });
      expect(res.status).toBe(200);
    });

    it("rejects cookie writes without the CSRF header", async () => {
      const res = await fetch(url("/api/settings"), {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    });

    it("rejects cookie writes with a simple-request content type", async () => {
      const res = await fetch(url("/api/settings"), {
        method: "POST",
        headers: { cookie, "content-type": "text/plain", "x-infinibot-request": "1" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    });

    it("rejects cross-origin cookie writes", async () => {
      const res = await fetch(url("/api/settings"), {
        method: "POST",
        headers: {
          cookie,
          origin: EVIL,
          "content-type": "application/json",
          "x-infinibot-request": "1",
        },
        body: "{}",
      });
      expect(res.status).toBe(403);
    });

    it("accepts same-origin cookie writes with the CSRF header", async () => {
      const res = await fetch(url("/api/settings"), {
        method: "POST",
        headers: {
          cookie,
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
          "x-infinibot-request": "1",
        },
        body: JSON.stringify({ vad_enabled: true }),
      });
      expect(res.status).toBe(200);
    });
  });

  it("never echoes secrets from /api/settings", async () => {
    await fetch(url("/api/settings"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ elevenlabs_api_key: "xi-secret-value" }),
    });
    const res = await fetch(url("/api/settings"), {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    expect(text).not.toContain("xi-secret-value");
    expect(JSON.parse(text).elevenlabs_api_key_set).toBe(true);
  });
});
