import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditLicense: vi.fn(),
  extendCommercialLicense: vi.fn(),
  getCommercialTier: vi.fn(),
  getLicense: vi.fn(),
  issueCommercialLicense: vi.fn(),
  listCommercialLicenses: vi.fn(),
  listCommercialTiers: vi.fn(),
  listWebhookEvents: vi.fn(),
  revokeCommercialLicense: vi.fn(),
  updateCommercialTier: vi.fn(),
  sendCommercialLicenseEmail: vi.fn(),
  syncCommercialWhopCatalog: vi.fn(),
  commercialPrivateKey: vi.fn(),
}));

vi.mock("./store.js", () => ({
  auditLicense: mocks.auditLicense,
  extendCommercialLicense: mocks.extendCommercialLicense,
  getCommercialTier: mocks.getCommercialTier,
  getLicense: mocks.getLicense,
  issueCommercialLicense: mocks.issueCommercialLicense,
  listCommercialLicenses: mocks.listCommercialLicenses,
  listCommercialTiers: mocks.listCommercialTiers,
  listWebhookEvents: mocks.listWebhookEvents,
  revokeCommercialLicense: mocks.revokeCommercialLicense,
  updateCommercialTier: mocks.updateCommercialTier,
}));
vi.mock("./email.js", () => ({ sendCommercialLicenseEmail: mocks.sendCommercialLicenseEmail }));
vi.mock("./whop.js", () => ({ syncCommercialWhopCatalog: mocks.syncCommercialWhopCatalog }));
vi.mock("./token.js", () => ({ commercialPrivateKey: mocks.commercialPrivateKey }));

import { handleCommercialLicenseAdmin } from "./admin-api.js";

const LICENSE_ID = "11111111-1111-4111-8111-111111111111";
const tier = {
  id: "indie",
  name: "Indie Commercial",
  priceCents: 29_900,
  billingInterval: "year",
  billingDays: 365,
  seats: 1,
  organizations: 1,
  revenueCapUsd: 1_000_000,
  whiteLabel: false,
  summary: "Solo commercial use",
  features: ["Competing use"],
  whopProductId: "prod_test",
  whopPlanId: "plan_test",
  active: true,
} as const;
const license = {
  id: LICENSE_ID,
  checkoutRef: null,
  jti: "22222222-2222-4222-8222-222222222222",
  tierId: "indie",
  licensee: "Northwind Studio",
  email: "ops@northwind.example",
  status: "active",
  seats: 1,
  organizations: 1,
  source: "manual",
  whopMembershipId: null,
  whopPaymentId: null,
  whopPlanId: null,
  token: "signed-token",
  issuedAt: "2026-10-26T00:00:00.000Z",
  expiresAt: "2027-10-26T00:00:00.000Z",
  graceUntil: "2027-11-09T00:00:00.000Z",
  revokedAt: null,
  revokeReason: null,
} as const;
const sql = Object.assign(vi.fn(), { json: vi.fn((value) => value) });
const owner = { ok: true as const, status: 200 as const, email: "owner@infinibot.cloud" };
const deps = {
  authenticate: vi.fn(async () => owner),
  sql: vi.fn(async () => sql as never),
  env: { COMMERCIAL_LICENSE_PRIVATE_KEY: "test" },
  fetchImpl: vi.fn() as never,
};
const request = (method: string, path: string, body?: unknown) =>
  new Request(`https://example.test/api/licenses/admin/${path}`, {
    method,
    headers: {
      authorization: "Bearer owner-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commercialPrivateKey.mockReturnValue("private-key");
  mocks.getCommercialTier.mockResolvedValue(tier);
  mocks.getLicense.mockResolvedValue(license);
  mocks.issueCommercialLicense.mockResolvedValue(license);
  mocks.extendCommercialLicense.mockResolvedValue(license);
  mocks.revokeCommercialLicense.mockResolvedValue({ ...license, status: "revoked" });
  mocks.updateCommercialTier.mockResolvedValue(tier);
  mocks.sendCommercialLicenseEmail.mockResolvedValue({ delivered: true, provider: "resend" });
  mocks.syncCommercialWhopCatalog.mockResolvedValue({ productId: "prod_test", tiers: [] });
  mocks.listCommercialLicenses.mockResolvedValue([license]);
  mocks.listCommercialTiers.mockResolvedValue([tier]);
  mocks.listWebhookEvents.mockResolvedValue([
    { eventId: "evt_test", eventType: "payment.succeeded", action: "issued", status: "processed" },
  ]);
});

describe("commercial license admin auth", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "owner_not_configured"],
  ] as const)("rejects before touching the database (%s)", async (status, error) => {
    const rejectedSql = vi.fn(async () => {
      throw new Error("must not run");
    });
    const response = await handleCommercialLicenseAdmin(
      new Request("https://example.test/api/licenses/admin/licenses", {
        headers: { authorization: "Bearer nope" },
      }),
      { authenticate: async () => ({ ok: false, status }), sql: rejectedSql as never, env: {} },
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(rejectedSql).not.toHaveBeenCalled();
  });

  it("requires owner auth even when no bearer is sent", async () => {
    let token: string | undefined = "sentinel";
    const response = await handleCommercialLicenseAdmin(
      new Request("https://example.test/api/licenses/admin/licenses"),
      {
        authenticate: async (value) => {
          token = value;
          return { ok: false, status: 401 };
        },
        sql: (async () => {
          throw new Error("must not run");
        }) as never,
        env: {},
      },
    );
    expect(response.status).toBe(401);
    expect(token).toBeUndefined();
  });
});

describe("commercial license admin controls", () => {
  it("lists and searches licenses and loads tiers and webhook events", async () => {
    const licensesResponse = await handleCommercialLicenseAdmin(
      request("GET", "licenses?q=northwind"),
      deps,
    );
    const tiersResponse = await handleCommercialLicenseAdmin(request("GET", "tiers"), deps);
    const eventsResponse = await handleCommercialLicenseAdmin(request("GET", "events"), deps);

    expect(licensesResponse.status).toBe(200);
    expect(await licensesResponse.json()).toEqual({ licenses: [license] });
    expect(mocks.listCommercialLicenses).toHaveBeenCalledWith(sql, "northwind");
    expect(await tiersResponse.json()).toEqual({ tiers: [tier] });
    expect(await eventsResponse.json()).toMatchObject({
      events: [{ action: "issued", status: "processed" }],
    });
  });

  it.each([
    [false, "manual"],
    [true, "complimentary"],
  ] as const)("issues and emails a %s license", async (complimentary, source) => {
    const response = await handleCommercialLicenseAdmin(
      request("POST", "licenses", {
        licensee: "Northwind Studio",
        email: "OPS@NORTHWIND.EXAMPLE",
        tierId: "indie",
        complimentary,
      }),
      deps,
    );

    expect(response.status).toBe(201);
    expect(mocks.issueCommercialLicense).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        tier,
        licensee: "Northwind Studio",
        email: "ops@northwind.example",
        source,
        privateKeyPem: "private-key",
      }),
    );
    expect(mocks.sendCommercialLicenseEmail).toHaveBeenCalledWith(
      license,
      deps.env,
      deps.fetchImpl,
    );
    expect(mocks.auditLicense).toHaveBeenCalledWith(sql, owner.email, "license.issue", license.id, {
      tier: "indie",
      source,
    });
  });

  it("revokes a license and audits the reason", async () => {
    const response = await handleCommercialLicenseAdmin(
      request("POST", `licenses/${LICENSE_ID}/revoke`, { reason: "Refunded" }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(mocks.revokeCommercialLicense).toHaveBeenCalledWith(sql, LICENSE_ID, "Refunded");
    expect(mocks.auditLicense).toHaveBeenCalledWith(
      sql,
      owner.email,
      "license.revoke",
      LICENSE_ID,
      { reason: "Refunded" },
    );
  });

  it("extends and re-signs a license", async () => {
    const response = await handleCommercialLicenseAdmin(
      request("POST", `licenses/${LICENSE_ID}/extend`, { days: 45 }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(mocks.extendCommercialLicense).toHaveBeenCalledWith(
      sql,
      license,
      tier,
      45,
      "private-key",
    );
    expect(mocks.auditLicense).toHaveBeenCalledWith(
      sql,
      owner.email,
      "license.extend",
      LICENSE_ID,
      { days: 45 },
    );
  });

  it("resends the signed key and audits delivery", async () => {
    const response = await handleCommercialLicenseAdmin(
      request("POST", `licenses/${LICENSE_ID}/resend`, {}),
      deps,
    );
    expect(response.status).toBe(200);
    expect(mocks.sendCommercialLicenseEmail).toHaveBeenCalledWith(
      license,
      deps.env,
      deps.fetchImpl,
    );
    expect(mocks.auditLicense).toHaveBeenCalledWith(
      sql,
      owner.email,
      "license.resend",
      LICENSE_ID,
      { delivered: true, provider: "resend" },
    );
  });

  it("updates tier pricing and feature copy", async () => {
    const response = await handleCommercialLicenseAdmin(
      request("PATCH", "tiers/indie", {
        priceCents: 34_900,
        summary: "Updated summary",
        features: ["Hosted use", "Resale"],
      }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(mocks.updateCommercialTier).toHaveBeenCalledWith(sql, "indie", {
      priceCents: 34_900,
      summary: "Updated summary",
      features: ["Hosted use", "Resale"],
    });
    expect(mocks.auditLicense).toHaveBeenCalledWith(sql, owner.email, "tier.update", null, {
      tier: "indie",
      fields: ["priceCents", "summary", "features"],
    });
  });

  it("syncs one edited tier to Whop", async () => {
    const response = await handleCommercialLicenseAdmin(
      request("POST", "tiers/indie/sync-whop", {}),
      deps,
    );
    expect(response.status).toBe(200);
    expect(mocks.syncCommercialWhopCatalog).toHaveBeenCalledWith({
      sql,
      env: deps.env,
      apply: true,
      onlyTier: "indie",
      fetchImpl: deps.fetchImpl,
    });
    expect(mocks.auditLicense).toHaveBeenCalledWith(sql, owner.email, "tier.sync_whop", null, {
      tier: "indie",
    });
  });
});
