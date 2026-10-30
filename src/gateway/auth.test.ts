import { describe, expect, it } from "vitest";

import { authorizeGatewayConnect, resolveGatewayAuth } from "./auth.js";

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  describe("resolveGatewayAuth mode precedence", () => {
    it("env override wins over a config-pinned mode (operator runtime intent)", () => {
      // Regression guard: `infinibot quickstart` spawns the gateway with
      // `--auth token` even when the user's saved config has
      // `auth.mode = "password"`. Without env beating config, every live
      // re-resolve on a WS connect flips back to password mode and rejects
      // the very token quickstart minted, with `password_missing`.
      const r = resolveGatewayAuth({
        authConfig: { mode: "password", password: "stale" },
        env: {
          INFINIBOT_GATEWAY_AUTH_MODE: "token",
          INFINIBOT_GATEWAY_TOKEN: "t",
        } as NodeJS.ProcessEnv,
      });
      expect(r.mode).toBe("token");
      expect(r.token).toBe("t");
    });

    it("env override wins over the password-presence heuristic", () => {
      const r = resolveGatewayAuth({
        authConfig: { password: "stale" },
        env: {
          INFINIBOT_GATEWAY_AUTH_MODE: "token",
          INFINIBOT_GATEWAY_TOKEN: "t",
        } as NodeJS.ProcessEnv,
      });
      expect(r.mode).toBe("token");
    });

    it("config mode wins over the heuristic when env is unset", () => {
      const r = resolveGatewayAuth({
        authConfig: { mode: "token", password: "leftover" },
        env: {} as NodeJS.ProcessEnv,
      });
      expect(r.mode).toBe("token");
    });

    it("falls through to the password-presence heuristic when nothing is pinned", () => {
      const r = resolveGatewayAuth({
        authConfig: { password: "p" },
        env: {} as NodeJS.ProcessEnv,
      });
      expect(r.mode).toBe("password");
    });

    it("ignores garbage env mode values", () => {
      const r = resolveGatewayAuth({
        authConfig: { mode: "password", password: "p" },
        env: { INFINIBOT_GATEWAY_AUTH_MODE: "yes-please" } as NodeJS.ProcessEnv,
      });
      expect(r.mode).toBe("password");
    });
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.example-tailnet.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });
});
