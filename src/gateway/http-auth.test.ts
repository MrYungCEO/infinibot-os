import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { ResolvedGatewayAuth } from "./auth.js";
import {
  authenticateHttpRequest,
  checkCsrf,
  classifyHttpRoute,
  createFailureLimiter,
  isAllowedHostHeader,
  mintSessionValue,
  resetSessionSigningKeyForTest,
  sessionCookieName,
  verifySessionValue,
} from "./http-auth.js";

resetSessionSigningKeyForTest(Buffer.alloc(32, 7));

const passwordAuth: ResolvedGatewayAuth = {
  mode: "password",
  password: "correct-horse",
  allowTailscale: false,
};

function fakeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  remote?: string;
}): IncomingMessage {
  return {
    method: opts.method ?? "GET",
    url: opts.url ?? "/",
    headers: Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    socket: { remoteAddress: opts.remote ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

const noDevice = {
  verifyDeviceToken: async () => ({ ok: false }),
  isSaasMode: () => false,
  verifyClerkToken: async () => null,
};

describe("classifyHttpRoute", () => {
  it("keeps the reviewed public allowlist public", () => {
    for (const p of [
      "/install.sh",
      "/api/users/login",
      "/api/auth/session",
      "/gmail/oauth/callback",
      "/oauth/canva/callback",
      "/loops/webhook",
      "/api/pages/track",
      "/api/ollama/health",
    ]) {
      expect(classifyHttpRoute("POST", p), p).toBe("public");
    }
  });

  it("treats the SPA shell and static pages as static (GET only)", () => {
    expect(classifyHttpRoute("GET", "/")).toBe("static");
    expect(classifyHttpRoute("GET", "/chat")).toBe("static");
    expect(classifyHttpRoute("GET", "/assets/index-abc.js")).toBe("static");
    expect(classifyHttpRoute("GET", "/avatar/main")).toBe("static");
    expect(classifyHttpRoute("GET", "/mobile-web/index.html")).toBe("static");
    expect(classifyHttpRoute("POST", "/chat")).toBe("protected");
  });

  it("protects every API/data route", () => {
    for (const [m, p] of [
      ["POST", "/tools/invoke"],
      ["GET", "/backup/download"],
      ["POST", "/backup/restore"],
      ["GET", "/api/settings"],
      ["POST", "/api/voice/chat"],
      ["POST", "/api/voice/chat/stream"],
      ["POST", "/api/voice/spawn"],
      ["GET", "/api/runs/abc/stream"],
      ["GET", "/api/reports"],
      ["POST", "/api/coder/mcp-install"],
      ["POST", "/api/voice/stt"],
      ["GET", "/media/screenshot.png"],
      ["GET", "/canvas/abc"],
      ["GET", "/plugins/infinicode/ui-panel.js"],
      ["GET", "/oauth/canva/start"],
      ["POST", "/v1/chat/completions"],
    ] as const) {
      expect(classifyHttpRoute(m, p), `${m} ${p}`).toBe("protected");
    }
  });
});

describe("isAllowedHostHeader", () => {
  const env = {} as NodeJS.ProcessEnv;
  it("allows loopback names, IP literals, tailnet and this machine", () => {
    for (const h of [
      "localhost:18789",
      "127.0.0.1:18789",
      "[::1]:18789",
      "192.168.1.120:18789",
      "box.tail1234.ts.net",
      "myhost",
      "myhost.local:18789",
      "app.localhost",
    ]) {
      expect(isAllowedHostHeader(h, { env, hostname: "myhost" }), h).toBe(true);
    }
  });

  it("rejects foreign names (DNS rebinding)", () => {
    expect(isAllowedHostHeader("evil.example:18789", { env, hostname: "myhost" })).toBe(false);
    expect(isAllowedHostHeader("localhost.evil.example", { env, hostname: "myhost" })).toBe(false);
  });

  it("honours bind host, extra hosts and INFINIBOT_HTTP_ALLOWED_HOSTS", () => {
    expect(
      isAllowedHostHeader("gw.example.com", { env, hostname: "x", extraHosts: ["gw.example.com"] }),
    ).toBe(true);
    expect(
      isAllowedHostHeader("a.corp.example", {
        env: { INFINIBOT_HTTP_ALLOWED_HOSTS: "*.corp.example" } as NodeJS.ProcessEnv,
        hostname: "x",
      }),
    ).toBe(true);
  });
});

describe("session cookie", () => {
  it("round-trips and is bound to the current secret", () => {
    const value = mintSessionValue(passwordAuth);
    expect(verifySessionValue(value, passwordAuth)).toBe(true);
    expect(verifySessionValue(value, { ...passwordAuth, password: "rotated" })).toBe(false);
    expect(verifySessionValue(`${value}x`, passwordAuth)).toBe(false);
  });

  it("expires", () => {
    const value = mintSessionValue(passwordAuth, 0);
    expect(verifySessionValue(value, passwordAuth, 8 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("uses a per-port cookie name", () => {
    expect(sessionCookieName(18789)).not.toBe(sessionCookieName(18901));
  });
});

describe("authenticateHttpRequest", () => {
  const ctx = { auth: passwordAuth, staticAuth: true, port: 18789, deps: noDevice };

  it("rejects requests without a credential — including loopback", async () => {
    const r = await authenticateHttpRequest(fakeReq({ remote: "127.0.0.1" }), ctx);
    expect(r.ok).toBe(false);
  });

  it("accepts the shared secret as Bearer", async () => {
    const r = await authenticateHttpRequest(
      fakeReq({ headers: { authorization: "Bearer correct-horse" } }),
      ctx,
    );
    expect(r).toEqual({ ok: true, via: "bearer" });
  });

  it("rejects a wrong Bearer and flags it for rate limiting", async () => {
    const r = await authenticateHttpRequest(
      fakeReq({ headers: { authorization: "Bearer nope" } }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.presentedCredential).toBe(true);
  });

  it("accepts a valid session cookie", async () => {
    const cookie = `${sessionCookieName(18789)}=${encodeURIComponent(mintSessionValue(passwordAuth))}`;
    const r = await authenticateHttpRequest(fakeReq({ headers: { cookie } }), ctx);
    expect(r).toEqual({ ok: true, via: "cookie" });
  });

  it("does not accept another port's cookie", async () => {
    const cookie = `${sessionCookieName(18901)}=${encodeURIComponent(mintSessionValue(passwordAuth))}`;
    const r = await authenticateHttpRequest(fakeReq({ headers: { cookie } }), ctx);
    expect(r.ok).toBe(false);
  });

  it("accepts a paired device token with its device id", async () => {
    const r = await authenticateHttpRequest(
      fakeReq({ headers: { authorization: "Bearer dev-tok", "x-infinibot-device-id": "dev1" } }),
      {
        ...ctx,
        deps: {
          ...noDevice,
          verifyDeviceToken: async (p) => ({ ok: p.deviceId === "dev1" && p.token === "dev-tok" }),
        },
      },
    );
    expect(r).toEqual({ ok: true, via: "device" });
  });
});

describe("checkCsrf", () => {
  const post = (headers: Record<string, string>) =>
    fakeReq({ method: "POST", headers: { host: "127.0.0.1:18789", ...headers } });

  it("requires the custom header for cookie-authenticated writes", () => {
    expect(checkCsrf(post({ "content-type": "application/json" }), "cookie")).toBe(
      "missing_csrf_header",
    );
    expect(
      checkCsrf(post({ "content-type": "application/json", "x-infinibot-request": "1" }), "cookie"),
    ).toBeNull();
  });

  it("rejects simple-request content types even with the header", () => {
    expect(
      checkCsrf(post({ "content-type": "text/plain", "x-infinibot-request": "1" }), "cookie"),
    ).toBe("unsupported_content_type");
  });

  it("rejects cross-origin writes regardless of credential", () => {
    expect(checkCsrf(post({ origin: "https://evil.example" }), "bearer")).toBe(
      "cross_origin_request",
    );
  });

  it("lets same-origin and header-authenticated writes through", () => {
    expect(checkCsrf(post({ origin: "http://127.0.0.1:18789" }), "bearer")).toBeNull();
    expect(checkCsrf(post({}), "bearer")).toBeNull();
  });

  it("ignores reads", () => {
    expect(checkCsrf(fakeReq({ method: "GET" }), "cookie")).toBeNull();
  });
});

describe("createFailureLimiter", () => {
  it("locks out after too many failures and resets on success", () => {
    const l = createFailureLimiter({ maxFailures: 3, windowMs: 60_000, lockoutMs: 30_000 });
    l.fail("ip", 0);
    l.fail("ip", 1);
    expect(l.check("ip", 2)).toBe(0);
    l.fail("ip", 2);
    expect(l.check("ip", 3)).toBeGreaterThan(0);
    expect(l.check("ip", 40_000)).toBe(0);
    l.fail("ip2", 0);
    l.succeed("ip2");
    expect(l.check("ip2", 1)).toBe(0);
  });
});
