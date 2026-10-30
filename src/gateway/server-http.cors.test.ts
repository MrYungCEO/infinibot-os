import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin } from "./http-auth.js";
import { applyUiOriginCors } from "./server-http.js";

function fake(method: string, origin?: string, reqHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    ended: false,
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    end() {
      this.ended = true;
    },
  };
  const req = { method, headers: { ...(origin ? { origin } : {}), ...reqHeaders } };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse & { ended: boolean },
    headers,
  };
}

const ENV = {
  INFINIBOT_UI_ORIGINS: "https://infinibot-cloud.netlify.app, https://app.example.com/",
};

describe("applyUiOriginCors", () => {
  it("is a no-op when INFINIBOT_UI_ORIGINS is unset (local installs)", () => {
    const { req, res, headers } = fake("OPTIONS", "https://infinibot-cloud.netlify.app");
    expect(applyUiOriginCors(req, res, {})).toBe(false);
    expect(headers).toEqual({});
  });

  it("echoes an allowed origin on normal requests and lets routing continue", () => {
    const { req, res, headers } = fake("POST", "https://infinibot-cloud.netlify.app");
    expect(applyUiOriginCors(req, res, ENV)).toBe(false);
    expect(headers["access-control-allow-origin"]).toBe("https://infinibot-cloud.netlify.app");
    expect(headers.vary).toBe("Origin");
  });

  it("answers the preflight for an allowed origin (trailing slash in config tolerated)", () => {
    const { req, res, headers } = fake("OPTIONS", "https://app.example.com", {
      "access-control-request-headers": "content-type",
    });
    expect(applyUiOriginCors(req, res, ENV)).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(headers["access-control-allow-headers"]).toBe("content-type");
  });

  it("ignores other origins", () => {
    const { req, res, headers } = fake("OPTIONS", "https://evil.example.net");
    expect(applyUiOriginCors(req, res, ENV)).toBe(false);
    expect(headers).toEqual({});
  });
});

describe("hosted UI origin is a CORS/CSRF-allowed origin (fleet)", () => {
  it("INFINIBOT_UI_ORIGINS counts for the http-auth gate", () => {
    const env = { INFINIBOT_UI_ORIGINS: "https://infinibot-cloud.netlify.app" };
    expect(isAllowedCorsOrigin("https://infinibot-cloud.netlify.app", env)).toBe(true);
    expect(isAllowedCorsOrigin("https://evil.example", env)).toBe(false);
    expect(isAllowedCorsOrigin("https://infinibot-cloud.netlify.app", {})).toBe(false);
  });
});
