import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pollToken,
  refreshToken,
  resolveVaultBaseUrl,
  revokeToken,
  startDevice,
  validateToken,
  VaultError,
} from "./vault-client.js";

function makeFetch(response: { status: number; body: unknown }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const ORIGINAL_URL = process.env.INFINIBOT_VAULT_URL;

beforeEach(() => {
  delete process.env.INFINIBOT_VAULT_URL;
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.INFINIBOT_VAULT_URL;
  else process.env.INFINIBOT_VAULT_URL = ORIGINAL_URL;
  vi.restoreAllMocks();
});

describe("resolveVaultBaseUrl", () => {
  it("strips trailing slashes and honors env override", () => {
    process.env.INFINIBOT_VAULT_URL = "https://other.example///";
    expect(resolveVaultBaseUrl()).toBe("https://other.example");
    expect(resolveVaultBaseUrl("https://override.test/")).toBe("https://override.test");
  });
});

describe("vault-client endpoints", () => {
  it("startDevice POSTs the expected body", async () => {
    const f = makeFetch({
      status: 200,
      body: {
        device_code: "dc",
        user_code: "U",
        verification_uri: "x",
        verification_uri_complete: "x",
        expires_in: 600,
        interval: 5,
      },
    });
    const res = await startDevice(
      { scopes: ["gateway"], device_label: "laptop" },
      { fetchImpl: f.fetch, baseUrl: "https://v.test" },
    );
    expect(res.device_code).toBe("dc");
    expect(f.calls[0].url).toBe("https://v.test/functions/v1/cli-device-start");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body).toEqual({
      client_id: "infinibot-cli",
      scopes: ["gateway"],
      device_label: "laptop",
    });
  });

  it("surfaces VaultError with the server's error code", async () => {
    const f = makeFetch({ status: 400, body: { error: "authorization_pending" } });
    await expect(
      pollToken({ device_code: "dc" }, { fetchImpl: f.fetch, baseUrl: "https://v.test" }),
    ).rejects.toMatchObject({ code: "authorization_pending", httpStatus: 400 });
  });

  it("refreshToken sends the refresh body", async () => {
    const f = makeFetch({
      status: 200,
      body: {
        access_token: "a",
        refresh_token: "r2",
        expires_in: 3600,
        token_type: "Bearer",
        tenant_id: "t",
        scopes: ["gateway"],
      },
    });
    const out = await refreshToken(
      { refresh_token: "r1" },
      { fetchImpl: f.fetch, baseUrl: "https://v.test" },
    );
    expect(out.refresh_token).toBe("r2");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      refresh_token: "r1",
      client_id: "infinibot-cli",
    });
  });

  it("validateToken passes the Authorization header", async () => {
    const f = makeFetch({
      status: 200,
      body: { valid: true, tenant_id: "t", user_id: "u", scopes: [], expires_at: 0 },
    });
    await validateToken("abc", { fetchImpl: f.fetch, baseUrl: "https://v.test" });
    const headers = (f.calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer abc");
  });

  it("revokeToken returns the revoked payload", async () => {
    const f = makeFetch({ status: 200, body: { revoked: true } });
    const out = await revokeToken("abc", { fetchImpl: f.fetch, baseUrl: "https://v.test" });
    expect(out.revoked).toBe(true);
  });

  it("throws VaultError on non-JSON 500", async () => {
    const fetchImpl = (async () =>
      new Response("oops", { status: 500 })) as unknown as typeof fetch;
    await expect(
      validateToken("abc", { fetchImpl, baseUrl: "https://v.test" }),
    ).rejects.toBeInstanceOf(VaultError);
  });
});
