import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openHubDb, type HubDb } from "../db.js";
import { createAccount } from "./accounts.js";
import { upsertTxns } from "./ledger.js";
import { migrateLegacyIncome, migrateLegacyIncomeDetailed } from "./legacy.js";
import { monthlyFactor, revenueSummary } from "./metrics.js";
import { syncAccount } from "./sync.js";
import { fixtureFetch, loadFixture, noSleep } from "./test-helpers.js";
import type { LedgerRow } from "./types.js";

const MAR_1 = Date.parse("2026-03-01T00:00:00.000Z");
const FEB_1 = Date.parse("2026-02-01T00:00:00.000Z");

async function syncedWhop(): Promise<{ db: HubDb; accountId: string }> {
  const db = openHubDb(":memory:");
  const acct = await createAccount(db, {
    provider: "whop",
    label: "Test Whop",
    companyRef: "biz_test",
    secretRef: "env:UNUSED",
  });
  await syncAccount(db, acct.id, {
    mode: "backfill",
    deps: {
      fetch: fixtureFetch({ whopV1: loadFixture("whop-v1") }),
      rateLimit: false,
      sleep: noSleep,
      resolveSecret: () => "k",
    },
  });
  return { db, accountId: acct.id };
}

function charge(over: Partial<LedgerRow>): LedgerRow {
  return {
    externalId: "x",
    type: "charge",
    status: "succeeded",
    grossCents: 1000,
    feeCents: 0,
    netCents: 1000,
    refundedCents: 0,
    currency: "USD",
    amountUsdCents: 1000,
    occurredAt: MAR_1 - 86400000,
    productId: null,
    productName: null,
    planId: null,
    billingReason: null,
    customerRef: null,
    customerEmail: null,
    customerName: null,
    subscriptionRef: null,
    parentExternalId: null,
    raw: {},
    ...over,
  };
}

describe("revenue metrics", () => {
  it("normalises billing intervals to monthly", () => {
    expect(Math.round(1200 * monthlyFactor("week"))).toBe(5200);
    expect(12000 * monthlyFactor("year")).toBe(1000);
    expect(3000 * monthlyFactor("month", 3)).toBe(1000);
    expect(Math.round(100 * monthlyFactor("day"))).toBe(3042);
    expect(monthlyFactor(null)).toBe(0);
  });

  it("computes totals, MRR, churn, cohorts and breakdowns from a synced Whop account", async () => {
    const { db, accountId } = await syncedWhop();
    const all = revenueSummary(db, { now: MAR_1 });
    expect(all.totals).toMatchObject({
      grossCents: 34497,
      refundsCents: 5500,
      feesCents: 1722,
      disputesLostCents: 2999,
      netCents: 34497 - 5500 - 1722 - 2999,
      count: 5,
      avgOrderCents: Math.round(34497 / 5),
      customers: 4,
      newCustomers: 4,
      returningCustomers: 0,
    });
    expect(all.mrrSource).toBe("subscriptions");
    expect(all.mrrCents).toBe(2999 + 2000);
    expect(all.arrCents).toBe((2999 + 2000) * 12);
    expect(all.activeSubscribers).toBe(2);
    expect(all.byMonth).toEqual([
      {
        month: "2026-01",
        grossCents: 31498,
        refundsCents: 5500,
        netCents: 25998,
        count: 4,
        customers: 4,
      },
      {
        month: "2026-02",
        grossCents: 2999,
        refundsCents: 0,
        netCents: 2999,
        count: 1,
        customers: 1,
      },
    ]);
    expect(all.byProduct).toEqual([
      { product: "Pro Plan", grossCents: 32997, count: 4 },
      { product: "Course", grossCents: 1500, count: 1 },
    ]);
    expect(all.byAccount[0]).toMatchObject({
      accountId,
      label: "Test Whop",
      grossCents: 34497,
      count: 5,
    });
    expect(all.bySource).toEqual([
      expect.objectContaining({ name: "Test Whop", kind: "whop", grossCents: 34497, customers: 4 }),
    ]);
    expect(all.byCampaign[0]).toMatchObject({ campaignId: null, name: "(no campaign)" });
    expect(all.cohorts).toEqual([
      {
        cohort: "2026-01",
        customers: 4,
        cells: [
          { offset: 0, revenueCents: 31498, retained: 4 },
          { offset: 1, revenueCents: 2999, retained: 1 },
        ],
      },
    ]);
    expect(all.topCustomers[0]).toMatchObject({ email: "e@example.com", grossCents: 24000 });
    expect(all.refunds.map((r) => r.type).sort()).toEqual(["dispute", "refund"]);
    expect(all.perCurrency).toEqual([
      { currency: "USD", grossCents: 34497, refundsCents: 5500, count: 5, usdGrossCents: 34497 },
    ]);
    expect(all.ltv.cents).toBeGreaterThan(0);

    const feb = revenueSummary(db, { from: FEB_1, to: MAR_1, now: MAR_1 });
    expect(feb.totals).toMatchObject({
      grossCents: 2999,
      count: 1,
      customers: 1,
      newCustomers: 0,
      returningCustomers: 1,
      disputesLostCents: 2999,
    });
    // mem_1, mem_2, mem_3 active on Feb 1; mem_2 canceled Feb 15.
    expect(feb.churn).toMatchObject({ activeAtStart: 3, canceled: 1, windowDays: 28 });
    expect(feb.churn.rate).toBeCloseTo(1 / 3);
    expect(feb.ltv.method).toBe("arpu/churn");
    expect(revenueSummary(db, { accountIds: ["nope"] }).totals.count).toBe(0);
    // A drafted membership with no dates must not inflate "active at start".
    db.prepare(
      "INSERT INTO revenue_subscriptions(id,account_id,provider,external_id,status,created_at,updated_at) VALUES('rs_d',?,'whop','mem_draft','drafted',0,0)",
    ).run(accountId);
    expect(revenueSummary(db, { from: FEB_1, to: MAR_1, now: MAR_1 }).churn.activeAtStart).toBe(3);
  });

  it("includes provider refund cents omitted from linked refund rows", async () => {
    const { db, accountId } = await syncedWhop();
    db.prepare(
      "UPDATE revenue_txns SET refunded_cents = 1600 WHERE account_id = ? AND type = 'charge' AND external_id = 'pay_3'",
    ).run(accountId);

    const summary = revenueSummary(db, { now: MAR_1 });
    expect(summary.totals.refundsCents).toBe(5600);
    expect(summary.totals.netCents).toBe(34497 - 5600 - 1722 - 2999);
    expect(summary.byRevenueSource[0]).toMatchObject({ refundsCents: 5600 });
  });

  it("falls back to trailing-30-day recurring charges when there are no subscriptions", () => {
    const db = openHubDb(":memory:");
    db.prepare(
      "INSERT INTO revenue_accounts(id,provider,label,status,created_at,updated_at) VALUES('ra','stripe','S','ok',0,0)",
    ).run();
    upsertTxns(db, { id: "ra", provider: "stripe" }, [
      charge({
        externalId: "c1",
        billingReason: "subscription_cycle",
        customerEmail: "a@example.com",
      }),
      charge({
        externalId: "c2",
        billingReason: "subscription_cycle",
        customerEmail: "b@example.com",
        grossCents: 2000,
        amountUsdCents: 2000,
      }),
      charge({ externalId: "c3", billingReason: "one_time", customerEmail: "c@example.com" }),
      charge({
        externalId: "c4",
        billingReason: "subscription_cycle",
        occurredAt: MAR_1 - 40 * 86400000,
      }),
      charge({ externalId: "c5", currency: "EUR", amountUsdCents: null, grossCents: 900 }),
    ]);
    const s = revenueSummary(db, { now: MAR_1 });
    expect(s.mrrSource).toBe("recurring_charges");
    expect(s.mrrCents).toBe(3000);
    expect(s.activeSubscribers).toBe(2);
    expect(s.totals.unconvertedCount).toBe(1);
    expect(s.perCurrency.find((c) => c.currency === "EUR")).toMatchObject({
      grossCents: 900,
      usdGrossCents: null,
    });
  });

  it("imports legacy income.json idempotently and skips entries duplicated by a synced account", async () => {
    const { db } = await syncedWhop();
    const dir = mkdtempSync(join(tmpdir(), "rev-legacy-"));
    const file = join(dir, "income.json");
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          {
            id: "inc_1",
            amount: 29.99,
            source: "whop",
            description: "Whop Payment",
            date: "2026-01-05T00:00:00.000Z",
            metadata: { whopId: "pay_1", currency: "usd" },
          },
          {
            id: "inc_2",
            amount: 500,
            source: "manual",
            description: "Consulting",
            date: "2026-02-20T00:00:00.000Z",
          },
          {
            id: "inc_3",
            amount: "1,250.00",
            source: "stripe",
            description: "Retainer",
            date: "2026-02-21",
          },
        ],
        streams: [],
      }),
    );
    const before = revenueSummary(db, { now: MAR_1 }).totals.grossCents;
    const r1 = await migrateLegacyIncomeDetailed(db, dir, { paths: [file] });
    expect(r1).toMatchObject({ entries: 3, inserted: 3 });
    expect(existsSync(join(dir, "backups", "revenue-ledger-v1", "0-income.json.bak"))).toBe(true);
    const r2 = await migrateLegacyIncomeDetailed(db, dir, { paths: [file] });
    expect(r2).toMatchObject({ entries: 3, inserted: 0, updated: 0, accountId: r1.accountId });
    expect(await migrateLegacyIncome(db, dir, { paths: [file] })).toBe(0);
    const after = revenueSummary(db, { now: MAR_1 });
    expect(after).toMatchObject({
      grossCents: after.totals.grossCents,
      chargeCount: after.totals.count,
      refundCents: after.totals.refundsCents,
      feeCents: after.totals.feesCents,
      netCents: after.totals.netCents,
      activeSubscriptions: after.activeSubscribers,
      churnRate: after.churn.rate,
    });
    expect(after.totals.grossCents).toBe(before + 50000 + 125000);
    expect(after.byAccount.find((a) => a.label === "Imported income")?.count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
