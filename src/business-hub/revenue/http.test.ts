import { describe, expect, it } from "vitest";
import {
  createRevenueHttp,
  ProviderHttpError,
  ReadOnlyViolation,
  retryAfterMs,
  TokenBucket,
} from "./http.js";
import { response } from "./test-helpers.js";

describe("revenue http client", () => {
  it("refuses every method other than GET before any request is made", async () => {
    let called = 0;
    const http = createRevenueHttp({
      provider: "whop",
      apiKey: "k",
      rateLimit: false,
      fetch: async () => {
        called++;
        return response(200, {});
      },
    });
    for (const m of ["POST", "put", "PATCH", "DELETE"])
      await expect(http.request(m, "https://api.whop.com/api/v1/payments")).rejects.toBeInstanceOf(
        ReadOnlyViolation,
      );
    expect(called).toBe(0);
    await expect(http.get("https://api.whop.com/api/v1/payments")).resolves.toEqual({});
    expect(called).toBe(1);
  });

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const http = createRevenueHttp({
      provider: "stripe",
      apiKey: "k",
      rateLimit: false,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () =>
        ++n < 3 ? response(429, "slow down", { "Retry-After": "2" }) : response(200, { ok: 1 }),
    });
    await expect(http.get("https://api.stripe.com/v1/charges", { limit: 100 })).resolves.toEqual({
      ok: 1,
    });
    expect(sleeps).toEqual([2000, 2000]);
    expect(http.requests).toBe(3);
  });

  it("gives up after 5 tries on 5xx and does not retry 4xx", async () => {
    let n = 0;
    const http = createRevenueHttp({
      provider: "whop",
      apiKey: "secret-key-value",
      rateLimit: false,
      sleep: async () => {},
      fetch: async () => {
        n++;
        return response(503, "down");
      },
    });
    const err = await http.get("https://api.whop.com/api/v1/payments").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(n).toBe(5);
    expect(String(err)).not.toContain("secret-key-value");
    n = 0;
    const http2 = createRevenueHttp({
      provider: "whop",
      apiKey: "k",
      rateLimit: false,
      fetch: async () => {
        n++;
        return response(401, { error: { message: "bad key for a@example.com" } });
      },
    });
    const err2 = await http2.get("https://api.whop.com/api/v1/payments").catch((e: unknown) => e);
    expect((err2 as ProviderHttpError).status).toBe(401);
    expect(String(err2)).not.toContain("a@example.com");
    expect(n).toBe(1);
  });

  it("parses Retry-After dates and throttles with a token bucket", async () => {
    expect(retryAfterMs("1.5")).toBe(1500);
    expect(retryAfterMs(new Date(Date.now() + 3000).toUTCString())).toBeGreaterThan(1000);
    let now = 0;
    const waits: number[] = [];
    const bucket = new TokenBucket(
      2,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    for (let i = 0; i < 4; i++) await bucket.take();
    expect(waits.length).toBe(2);
  });
});
