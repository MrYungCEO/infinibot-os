import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openHubDb } from "../db.js";
import { createAccount } from "./accounts.js";
import type { SyncResult } from "./sync.js";
import {
  handleRevenueWebhook,
  signStandardWebhook,
  signStripeWebhook,
  verifyStripeWebhook,
  verifyWhopWebhook,
} from "./webhooks.js";

const keyBytes = randomBytes(24);
const WHOP_SECRET = `whsec_${keyBytes.toString("base64")}`;
const NOW = 1_780_000_000;

function whopHeaders(body: string, ts = NOW, id = "msg_1") {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${signStandardWebhook(keyBytes, id, ts, body)}`,
  };
}

describe("webhook signatures", () => {
  const body = JSON.stringify({ type: "payment.succeeded", data: { id: "pay_1", total: 1 } });

  it("verifies Whop Standard Webhooks signatures (valid / tampered / stale)", () => {
    expect(verifyWhopWebhook(body, whopHeaders(body), WHOP_SECRET, NOW)).toEqual({ ok: true });
    expect(
      verifyWhopWebhook(body.replace("1}", "999}"), whopHeaders(body), WHOP_SECRET, NOW),
    ).toEqual({
      ok: false,
      reason: "signature mismatch",
    });
    expect(verifyWhopWebhook(body, whopHeaders(body, NOW - 301), WHOP_SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale timestamp",
    });
    expect(verifyWhopWebhook(body, { "webhook-id": "x" }, WHOP_SECRET, NOW).ok).toBe(false);
    // Multiple signatures in the header: any valid one passes.
    const h = whopHeaders(body);
    h["webhook-signature"] = `v1,AAAA ${h["webhook-signature"]}`;
    expect(verifyWhopWebhook(body, new Headers(h), WHOP_SECRET, NOW).ok).toBe(true);
  });

  it("verifies Stripe signatures (valid / tampered / stale)", () => {
    const secret = "whsec_test_stripe";
    const sig = `t=${NOW},v1=${signStripeWebhook(secret, NOW, body)}`;
    expect(verifyStripeWebhook(body, sig, secret, NOW)).toEqual({ ok: true });
    expect(verifyStripeWebhook(`${body} `, sig, secret, NOW)).toEqual({
      ok: false,
      reason: "signature mismatch",
    });
    expect(verifyStripeWebhook(body, sig, secret, NOW + 600)).toEqual({
      ok: false,
      reason: "stale timestamp",
    });
    expect(verifyStripeWebhook(body, null, secret, NOW).ok).toBe(false);
  });
});

describe("handleRevenueWebhook", () => {
  afterEach(() => {
    delete process.env.REVENUE_TEST_WH_SECRET;
  });

  it("verifies, records each event once and triggers a sync (never trusting payload amounts)", async () => {
    process.env.REVENUE_TEST_WH_SECRET = WHOP_SECRET;
    const db = openHubDb(":memory:");
    const acct = await createAccount(db, {
      provider: "whop",
      label: "W",
      companyRef: "biz_1",
      secretRef: "env:UNUSED",
      webhookSecret: "env:REVENUE_TEST_WH_SECRET",
    });
    const triggered: string[] = [];
    const triggerSync = async (_db: unknown, id: string) => {
      triggered.push(id);
      return { ok: true, error: null } as SyncResult;
    };
    const body = JSON.stringify({ type: "payment.succeeded", data: { id: "pay_9" } });
    const r1 = await handleRevenueWebhook(
      db,
      "whop",
      acct.id,
      body,
      whopHeaders(body, NOW, "evt_1"),
      { triggerSync, nowSeconds: NOW },
    );
    expect(r1.status).toBe(200);
    await r1.sync;
    const r2 = await handleRevenueWebhook(
      db,
      "whop",
      acct.id,
      body,
      whopHeaders(body, NOW, "evt_1"),
      { triggerSync, nowSeconds: NOW },
    );
    expect(r2.body).toMatchObject({ ok: true, duplicate: true });
    expect(triggered).toEqual([acct.id]);
    expect(db.prepare("SELECT event_type, processed FROM revenue_webhook_events").all()).toEqual([
      { event_type: "payment.succeeded", processed: 1 },
    ]);
    const bad = await handleRevenueWebhook(
      db,
      "whop",
      acct.id,
      `${body}x`,
      whopHeaders(body, NOW, "evt_2"),
      { triggerSync, nowSeconds: NOW },
    );
    expect(bad.status).toBe(401);
    expect(
      (await handleRevenueWebhook(db, "stripe", acct.id, body, {}, { triggerSync })).status,
    ).toBe(404);
  });

  it("refuses when no webhook secret is configured", async () => {
    const db = openHubDb(":memory:");
    const acct = await createAccount(db, {
      provider: "stripe",
      label: "S",
      secretRef: "env:UNUSED",
    });
    const r = await handleRevenueWebhook(db, "stripe", acct.id, "{}", {});
    expect(r.status).toBe(503);
  });
});
