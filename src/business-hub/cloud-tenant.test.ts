/**
 * Business hub on an InfiniBot Cloud tenant Machine (FLEET_TENANT_ID set):
 * keys are BYOK only (never the platform's env or files), and outbound
 * provider / SMTP traffic cannot target the platform's private network.
 */
import { describe, expect, it } from "vitest";
import { openHubDb } from "./db.js";
import { assertCloudSmtpHost } from "./email/transport.js";
import { cloudGuardedFetch, resolveApiKey } from "./leadgen/config.js";
import { getProvider } from "./leadgen/providers.js";
import {
  CLOUD_SECRET_REF_ERROR,
  discoverAccounts,
  parseSecretRef,
  resolveSecretRef,
} from "./revenue/accounts.js";

const FLEET = { FLEET_TENANT_ID: "dc9e3ba5", SAAS_MODE: "1" } as NodeJS.ProcessEnv;

describe("business hub on a fleet tenant Machine", () => {
  it("refuses env:/env-file: key references", () => {
    expect(() => parseSecretRef("env:CLERK_SECRET_KEY", FLEET)).toThrow(CLOUD_SECRET_REF_ERROR);
    expect(() => parseSecretRef("env-file:/app/.env#NEON_DATABASE_URL", FLEET)).toThrow(
      CLOUD_SECRET_REF_ERROR,
    );
    expect(resolveSecretRef("env:CLERK_SECRET_KEY", { ...FLEET, CLERK_SECRET_KEY: "sk" })).toBe(
      null,
    );
    // Self-hosted keeps references.
    expect(parseSecretRef("env:WHOP_API_KEY", {})).toEqual({ kind: "env", name: "WHOP_API_KEY" });
    expect(resolveSecretRef("env:WHOP_API_KEY", { WHOP_API_KEY: "k1" })).toBe("k1");
  });

  it("never discovers the Machine env's Whop / Stripe keys", async () => {
    const db = openHubDb(":memory:");
    const env = { ...FLEET, WHOP_API_KEY: "owner-whop", STRIPE_SECRET_KEY: "sk_owner" };
    const found = await discoverAccounts(db, { env, incomePaths: [], readConfig: () => ({}) });
    expect(found.filter((c) => c.sources.some((x) => x.source === "env"))).toEqual([]);
    const local = await discoverAccounts(db, {
      env: { WHOP_API_KEY: "owner-whop" },
      incomePaths: [],
      readConfig: () => ({}),
    });
    expect(local.some((c) => c.sources.some((x) => x.source === "env"))).toBe(true);
    db.close();
  });

  it("lead-gen providers use only the tenant's saved key", () => {
    const hunter = getProvider("hunter")!;
    const cfg = { providers: {} } as never;
    expect(resolveApiKey(hunter, cfg, { env: { ...FLEET, HUNTER_API_KEY: "owner" } }).key).toBe(
      null,
    );
    expect(resolveApiKey(hunter, cfg, { env: { HUNTER_API_KEY: "mine" } }).key).toBe("mine");
  });

  it("provider calls cannot reach private / internal hosts", async () => {
    const calls: string[] = [];
    const base = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}");
    }) as typeof fetch;
    const deps = { lookupHost: async () => [{ address: "93.184.216.34", family: 4 }] } as never;
    const guarded = cloudGuardedFetch(base, deps, FLEET);
    await expect(guarded("http://localhost:8080/api/v1/jobs")).rejects.toThrow(/blocked/);
    await expect(guarded("http://ib-fleet-orchestrator.internal/x")).rejects.toThrow(/blocked/);
    await expect(guarded("http://10.0.0.5/x")).rejects.toThrow(/blocked/);
    await guarded("https://api.hunter.io/v2/x");
    expect(calls).toEqual(["https://api.hunter.io/v2/x"]);
    // Off the fleet the fetch is passed through untouched.
    expect(cloudGuardedFetch(base, deps, {})).toBe(base);
  });

  it("SMTP senders must name a public mail host", () => {
    for (const h of ["localhost", "mail.internal", "10.1.2.3", "fdaa::3", "mailhost"])
      expect(() => assertCloudSmtpHost(h, FLEET)).toThrow(/public mail server/);
    expect(() => assertCloudSmtpHost("smtp.gmail.com", FLEET)).not.toThrow();
    expect(() => assertCloudSmtpHost("localhost", {})).not.toThrow();
  });
});
