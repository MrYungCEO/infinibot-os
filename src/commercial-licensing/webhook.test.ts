import { beforeEach, describe, expect, it, vi } from "vitest";
import { signWhopPayload } from "../saas/cloud/whop.js";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  tier: vi.fn(),
  issue: vi.fn(),
  renew: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("./store.js", () => ({
  findLicenseForWhop: mocks.find,
  tierForWhopPlan: mocks.tier,
  issueCommercialLicense: mocks.issue,
  renewCommercialLicense: mocks.renew,
  revokeCommercialLicense: mocks.revoke,
}));
const { handleCommercialLicenseWebhook } = await import("./webhook.js");
const secret = "test-secret-that-is-not-production";
const now = new Date("2026-10-26T00:00:00Z");
const tier = {
  id: "indie",
  name: "Indie Commercial",
  priceCents: 29900,
  billingInterval: "year",
  billingDays: 365,
  seats: 1,
  organizations: 1,
  revenueCapUsd: 1_000_000,
  whiteLabel: false,
  summary: "",
  features: [],
  whopProductId: "prod_test",
  whopPlanId: "plan_indie",
  active: true,
};
const active = {
  id: "11111111-1111-4111-8111-111111111111",
  checkoutRef: "ref_test_abcdefghijklmnop",
  jti: "22222222-2222-4222-8222-222222222222",
  tierId: "indie",
  licensee: "Ada Labs",
  email: "ada@example.test",
  status: "active",
  seats: 1,
  organizations: 1,
  source: "whop",
  whopMembershipId: "mem_1",
  whopPaymentId: "pay_1",
  whopPlanId: "plan_indie",
  token: "jwt",
  issuedAt: now.toISOString(),
  expiresAt: "2027-10-26T00:00:00Z",
  graceUntil: "2027-11-09T00:00:00Z",
  revokedAt: null,
  revokeReason: null,
};
function fakeSql() {
  const tag: any = async (strings: TemplateStringsArray) =>
    String(strings[0]).includes("insert into commercial_license_webhook_events") ? [{ id: 1 }] : [];
  tag.begin = async (fn: any) => fn(tag);
  tag.json = (v: any) => v;
  return tag;
}
function request(type: string, data: Record<string, unknown>, valid = true) {
  const body = JSON.stringify({ id: `evt_${type}`, type, data });
  const ts = Math.floor(now.getTime() / 1000);
  const id = `msg_${type}`;
  const sig = signWhopPayload(Buffer.from(secret), id, ts, body);
  return new Request("https://example.test/api/licenses/webhook", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": `v1,${valid ? sig : "bad"}`,
    },
    body,
  });
}
const deps = () => ({
  env: { WHOP_WEBHOOK_SECRET: secret, COMMERCIAL_LICENSE_PRIVATE_KEY: "private" },
  now: () => now,
  sql: async () => fakeSql(),
  sendEmail: vi.fn(async () => ({ sent: true })),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tier.mockResolvedValue(tier);
  mocks.issue.mockResolvedValue(active);
  mocks.renew.mockResolvedValue({ ...active, jti: "renewed" });
  mocks.revoke.mockResolvedValue({ ...active, status: "revoked" });
});
describe("commercial Whop webhook", () => {
  it("rejects an invalid signature", async () => {
    const res = await handleCommercialLicenseWebhook(
      request("payment.succeeded", {}, false),
      deps() as never,
    );
    expect(res.status).toBe(401);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("issues on a valid purchase", async () => {
    mocks.find.mockResolvedValue(null);
    const res = await handleCommercialLicenseWebhook(
      request("payment.succeeded", {
        id: "pay_1",
        membership_id: "mem_1",
        plan_id: "plan_indie",
        user: { email: "ada@example.test", name: "Ada Labs" },
        metadata: { infinibot_license_checkout_ref: "ref_test_abcdefghijklmnop" },
      }),
      deps() as never,
    );
    expect(await res.json()).toMatchObject({ result: "issued", licenseId: active.id });
    expect(mocks.issue).toHaveBeenCalledOnce();
  });
  it("renews an existing membership", async () => {
    mocks.find.mockResolvedValue(active);
    const res = await handleCommercialLicenseWebhook(
      request("payment.succeeded", { id: "pay_2", membership_id: "mem_1", plan_id: "plan_indie" }),
      deps() as never,
    );
    expect(await res.json()).toMatchObject({ result: "renewed" });
    expect(mocks.renew).toHaveBeenCalledOnce();
  });
  it.each(["membership.cancelled", "payment.refunded"])("revokes on %s", async (type) => {
    mocks.find.mockResolvedValue(active);
    const res = await handleCommercialLicenseWebhook(
      request(type, {
        id: type.startsWith("payment") ? "pay_1" : "mem_1",
        membership_id: "mem_1",
        plan_id: "plan_indie",
      }),
      deps() as never,
    );
    expect(await res.json()).toMatchObject({ result: "revoked" });
    expect(mocks.revoke).toHaveBeenCalledOnce();
  });
});
