import { describe, expect, it } from "vitest";
import { upsertContact } from "../contacts.js";
import { openHubDb, type HubDb } from "../db.js";
import { createAccount, getAccount } from "./accounts.js";
import { listLedger, listSubscriptions } from "./ledger.js";
import { reconcile } from "./reconcile.js";
import { syncAccount, type SyncDeps } from "./sync.js";
import { fixtureFetch, loadFixture, noSleep, type PagedFixture } from "./test-helpers.js";
import type { LedgerTxn } from "./types.js";

const key = () => "test_key";

async function whopAccount(db: HubDb, companyRef: string | null = "biz_test") {
  return createAccount(db, {
    provider: "whop",
    label: "Test Whop",
    companyRef,
    secretRef: "env:UNUSED_TEST_KEY",
  });
}

function deps(fetch: SyncDeps["fetch"], extra: Partial<SyncDeps> = {}): SyncDeps {
  return { fetch, rateLimit: false, sleep: noSleep, resolveSecret: key, ...extra };
}

function txn(db: HubDb, type: string, externalId: string) {
  return db
    .prepare("SELECT * FROM revenue_txns WHERE type = ? AND external_id = ?")
    .get(type, externalId) as Record<string, unknown> | undefined;
}

const count = (db: HubDb, sql: string) => (db.prepare(sql).get() as { c: number }).c;

describe("Whop v1 sync", () => {
  it("backfills 3 payment pages with refunded / failed / partial payments, refunds, disputes, memberships", async () => {
    const db = openHubDb(":memory:");
    const acct = await whopAccount(db);
    const f = fixtureFetch({ whopV1: loadFixture("whop-v1") });
    const payments: Array<{ contactId: string; txn: LedgerTxn }> = [];
    const r = await syncAccount(db, acct.id, {
      mode: "backfill",
      deps: deps(f, { onPayment: (contactId, t) => void payments.push({ contactId, txn: t }) }),
    });
    expect(r.ok).toBe(true);
    expect(r.apiVersion).toBe("v1");
    expect(getAccount(db, acct.id)?.apiVersion).toBe("v1");
    expect(f.methods.every((m) => m === "GET")).toBe(true);
    expect(r.objects.find((o) => o.object === "payments")?.pages).toBe(3);
    expect(
      f.calls.filter((u) => u.includes("/payments?")).some((u) => u.includes("after=c2")),
    ).toBe(true);

    expect(count(db, "SELECT COUNT(*) c FROM revenue_txns WHERE type='charge'")).toBe(6);
    expect(txn(db, "charge", "pay_1")).toMatchObject({
      status: "succeeded",
      gross_cents: 2999,
      fee_cents: 149,
      net_cents: 2850,
      amount_usd_cents: 2999,
      product_name: "Pro Plan",
      customer_email: "a@example.com",
      subscription_ref: "mem_1",
      billing_reason: "subscription_create",
    });
    expect(txn(db, "charge", "pay_3")).toMatchObject({
      status: "refunded",
      refunded_cents: 1500,
      product_name: "Course",
    });
    expect(txn(db, "charge", "pay_4")).toMatchObject({ status: "failed", fee_cents: 0 });
    expect(txn(db, "charge", "pay_6")).toMatchObject({
      status: "partially_refunded",
      refunded_cents: 4000,
    });
    // Refund row: negative impact, linked to its payment and inherits the customer.
    expect(txn(db, "refund", "rf_1")).toMatchObject({
      gross_cents: 1500,
      net_cents: -1500,
      parent_external_id: "pay_3",
      customer_email: "c@example.com",
    });
    expect(txn(db, "refund", "rf_1")?.contact_id).toBe(txn(db, "charge", "pay_3")?.contact_id);
    expect(txn(db, "dispute", "dp_1")).toMatchObject({
      status: "lost",
      gross_cents: 2999,
      parent_external_id: "pay_2",
    });

    const subs = listSubscriptions(db).rows;
    expect(subs).toHaveLength(3);
    expect(subs.find((x) => x.externalId === "mem_3")).toMatchObject({
      interval: "year",
      amountCents: 24000,
    });
    expect(subs.find((x) => x.externalId === "mem_1")).toMatchObject({
      interval: "month",
      amountCents: 2999,
    });
    expect(count(db, "SELECT COUNT(*) c FROM revenue_products")).toBe(5);

    // Contacts: paid customers become customers; the failed-only payer is not created.
    const lc = db.prepare("SELECT email, lifecycle FROM contacts ORDER BY email").all();
    expect(lc).toEqual([
      { email: "a@example.com", lifecycle: "customer" },
      { email: "b@example.com", lifecycle: "customer" },
      { email: "c@example.com", lifecycle: "customer" },
      { email: "e@example.com", lifecycle: "customer" },
    ]);
    expect(count(db, "SELECT COUNT(*) c FROM activities WHERE type='payment'")).toBe(5);
    expect(payments).toHaveLength(5);
    const src = db.prepare("SELECT kind, name FROM sources").all();
    expect(src).toEqual([{ kind: "whop", name: "Test Whop" }]);
    expect(subs.every((x) => x.contactId !== null)).toBe(true);
  });

  it("links ledger rows to the contact's client and open/won deal", async () => {
    const db = openHubDb(":memory:");
    const c = upsertContact(db, {
      email: "a@example.com",
      name: "Alice",
      clientId: "cl_1",
    })!.contact;
    const now = Date.now();
    db.prepare(
      "INSERT INTO deals(id,title,pipeline_id,stage_id,status,contact_id,stage_entered_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run("dl_1", "Alice deal", "pl", "st", "open", c.id, now, now, now);
    const acct = await whopAccount(db);
    await syncAccount(db, acct.id, {
      mode: "backfill",
      deps: deps(fixtureFetch({ whopV1: loadFixture("whop-v1") })),
    });
    expect(txn(db, "charge", "pay_1")).toMatchObject({
      contact_id: c.id,
      client_id: "cl_1",
      deal_id: "dl_1",
    });
    expect(listLedger(db, { contactId: c.id }).total).toBe(2);
  });

  it("is idempotent and picks up status changes", async () => {
    const db = openHubDb(":memory:");
    const acct = await whopAccount(db);
    const fx = loadFixture("whop-v1");
    const fired: string[] = [];
    const d = deps(fixtureFetch({ whopV1: fx }), {
      onPayment: (_c, t) => void fired.push(t.externalId),
    });
    await syncAccount(db, acct.id, { mode: "backfill", deps: d });
    const snapshot = () => ({
      txns: count(db, "SELECT COUNT(*) c FROM revenue_txns"),
      subs: count(db, "SELECT COUNT(*) c FROM revenue_subscriptions"),
      contacts: count(db, "SELECT COUNT(*) c FROM contacts"),
      acts: count(db, "SELECT COUNT(*) c FROM activities"),
    });
    const first = snapshot();
    const again = await syncAccount(db, acct.id, { mode: "backfill", deps: d });
    expect(snapshot()).toEqual(first);
    expect(again.objects.reduce((a, o) => a + o.inserted + o.updated, 0)).toBe(0);
    expect(fired).toHaveLength(5);

    // pay_4 is retried successfully; pay_1 gets refunded.
    const changed = structuredClone(fx) as PagedFixture;
    const p2 = changed.payments[1] as { data: Array<Record<string, unknown>> };
    Object.assign(p2.data[1], {
      status: "paid",
      substatus: "succeeded",
      paid_at: "2026-01-17T00:00:00.000Z",
      amount_after_fees: 28.5,
      failure_message: null,
    });
    const p1 = changed.payments[0] as { data: Array<Record<string, unknown>> };
    Object.assign(p1.data[0], { refunded_amount: 29.99, substatus: "refunded" });
    await syncAccount(db, acct.id, {
      mode: "backfill",
      deps: { ...d, fetch: fixtureFetch({ whopV1: changed }) },
    });
    expect(txn(db, "charge", "pay_4")).toMatchObject({ status: "succeeded", fee_cents: 149 });
    expect(txn(db, "charge", "pay_1")).toMatchObject({ status: "refunded", refunded_cents: 2999 });
    expect(count(db, "SELECT COUNT(*) c FROM revenue_txns")).toBe(first.txns);
    expect(fired.filter((x) => x === "pay_4")).toHaveLength(1);
    expect(db.prepare("SELECT lifecycle FROM contacts WHERE email='d@example.com'").get()).toEqual({
      lifecycle: "customer",
    });
  });

  it("resumes a crashed backfill from the persisted cursor without duplicates", async () => {
    const db = openHubDb(":memory:");
    const acct = await whopAccount(db);
    const fx = loadFixture("whop-v1");
    const crashing = fixtureFetch(
      { whopV1: fx },
      { fail: (u) => u.pathname.endsWith("/payments") && u.searchParams.get("after") === "c1" },
    );
    const r1 = await syncAccount(db, acct.id, {
      mode: "backfill",
      objects: ["plans", "payments"],
      deps: deps(crashing),
    });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("payments");
    expect(getAccount(db, acct.id)?.status).toBe("error");
    const st = db
      .prepare(
        "SELECT cursor, backfill_done, pages FROM revenue_sync_state WHERE object='payments'",
      )
      .get();
    expect(st).toEqual({ cursor: "c1", backfill_done: 0, pages: 1 });
    expect(count(db, "SELECT COUNT(*) c FROM revenue_txns")).toBe(2);

    const good = fixtureFetch({ whopV1: fx });
    const r2 = await syncAccount(db, acct.id, {
      mode: "incremental",
      objects: ["payments"],
      deps: deps(good),
    });
    expect(r2.ok).toBe(true);
    const payCalls = good.calls.filter((u) => u.includes("/payments?"));
    expect(new URL(payCalls[0]).searchParams.get("after")).toBe("c1");
    expect(payCalls).toHaveLength(2);
    expect(count(db, "SELECT COUNT(*) c FROM revenue_txns")).toBe(6);
    expect(count(db, "SELECT COUNT(DISTINCT external_id) c FROM revenue_txns")).toBe(6);
    expect(
      db
        .prepare(
          "SELECT cursor, backfill_done, pages FROM revenue_sync_state WHERE object='payments'",
        )
        .get(),
    ).toEqual({
      cursor: null,
      backfill_done: 1,
      pages: 3,
    });
  });

  it("respects maxPages and runs incremental syncs from high-water minus 2 days", async () => {
    const db = openHubDb(":memory:");
    const acct = await whopAccount(db);
    const fx = loadFixture("whop-v1");
    const r = await syncAccount(db, acct.id, {
      mode: "backfill",
      objects: ["payments"],
      maxPages: 2,
      deps: deps(fixtureFetch({ whopV1: fx })),
    });
    expect(r.objects[0]).toMatchObject({ pages: 2, complete: false, backfillDone: false });
    await syncAccount(db, acct.id, {
      mode: "backfill",
      objects: ["payments"],
      deps: deps(fixtureFetch({ whopV1: fx })),
    });
    const hw = (
      db.prepare("SELECT high_water h FROM revenue_sync_state WHERE object='payments'").get() as {
        h: number;
      }
    ).h;
    expect(hw).toBe(Date.parse("2026-02-05T00:00:00.000Z"));
    const f = fixtureFetch({ whopV1: fx });
    await syncAccount(db, acct.id, { mode: "incremental", objects: ["payments"], deps: deps(f) });
    const u = new URL(f.calls[0]);
    expect(u.searchParams.get("updated_after")).toBe("2026-02-03T00:00:00.000Z");
    expect(u.searchParams.get("after")).toBeNull();
  });

  it("allows one sync per account at a time", async () => {
    const db = openHubDb(":memory:");
    const acct = await whopAccount(db);
    const d = deps(fixtureFetch({ whopV1: loadFixture("whop-v1") }));
    const a = syncAccount(db, acct.id, { mode: "backfill", deps: d });
    const b = syncAccount(db, acct.id, { mode: "backfill", deps: d });
    expect(b).toBe(a);
    await a;
  });

  it("reconciles against the provider's payment list", async () => {
    const db = openHubDb(":memory:");
    const acct = await whopAccount(db);
    const fx = loadFixture("whop-v1");
    await syncAccount(db, acct.id, { mode: "backfill", deps: deps(fixtureFetch({ whopV1: fx })) });
    const rec = await reconcile(db, acct.id, deps(fixtureFetch({ whopV1: fx })));
    expect(rec.provider).toEqual({ count: 6, gross: 34497, refunds: 5500 });
    expect(rec.ledger).toMatchObject({ count: 6, gross: 34497, refunds: 5500 });
    expect(rec.ok).toBe(true);
    expect(rec.pages).toBe(3);
  });
});

describe("Whop v5 sync", () => {
  it("falls back to v5 when v1 says 'Bot was not found' and walks page numbers", async () => {
    const db = openHubDb(":memory:");
    const acct = await whopAccount(db, "biz_v5");
    const f = fixtureFetch({ whopV5: loadFixture("whop-v5") });
    const r = await syncAccount(db, acct.id, { mode: "backfill", deps: deps(f) });
    expect(r.ok).toBe(true);
    expect(r.apiVersion).toBe("v5");
    expect(getAccount(db, acct.id)?.apiVersion).toBe("v5");
    expect(f.calls.some((u) => u.includes("/v5/company/payments?per=50&page=2"))).toBe(true);
    expect(txn(db, "charge", "pv5_1")).toMatchObject({
      status: "succeeded",
      gross_cents: 700,
      product_name: "Vault",
      customer_email: "x@example.com",
      occurred_at: 1767600000 * 1000,
    });
    expect(txn(db, "charge", "pv5_2")?.status).toBe("pending");
    expect(txn(db, "charge", "pv5_3")?.gross_cents).toBe(25000);
    const rec = await reconcile(
      db,
      acct.id,
      deps(fixtureFetch({ whopV5: loadFixture("whop-v5") })),
    );
    expect(rec).toMatchObject({ provider: { count: 3 }, ledger: { count: 3 }, ok: true });
  });
});

describe("Stripe sync", () => {
  it("pages charges with has_more, uses balance transactions for fee/net and USD", async () => {
    const db = openHubDb(":memory:");
    const acct = await createAccount(db, {
      provider: "stripe",
      label: "Stripe",
      secretRef: "env:UNUSED_TEST_KEY",
    });
    const fx = loadFixture("stripe");
    const f = fixtureFetch({ stripe: fx });
    const r = await syncAccount(db, acct.id, { mode: "backfill", deps: deps(f) });
    expect(r.ok).toBe(true);
    expect(f.calls.some((u) => u.includes("starting_after=ch_2"))).toBe(true);
    expect(f.calls.find((u) => u.includes("/v1/charges"))).toContain(
      "expand%5B%5D=data.balance_transaction",
    );
    expect(txn(db, "charge", "ch_3")).toMatchObject({
      currency: "EUR",
      gross_cents: 5000,
      fee_cents: 187,
      net_cents: 5213,
      amount_usd_cents: 5400,
    });
    expect(txn(db, "charge", "ch_2")).toMatchObject({
      status: "partially_refunded",
      refunded_cents: 500,
      customer_email: "s2@example.com",
    });
    expect(txn(db, "charge", "ch_1")).toMatchObject({
      customer_email: "s1@example.com",
      billing_reason: "invoice",
    });
    expect(txn(db, "charge", "ch_0")?.status).toBe("failed");
    expect(txn(db, "refund", "re_1")).toMatchObject({
      parent_external_id: "ch_2",
      customer_email: "s2@example.com",
    });
    expect(txn(db, "payout", "po_1")?.gross_cents).toBe(15000);
    const subs = listSubscriptions(db).rows;
    expect(subs.find((x) => x.externalId === "sub_2")).toMatchObject({
      interval: "week",
      amountCents: 2400,
      productName: "Agency Retainer",
    });
    const rec = await reconcile(db, acct.id, deps(fixtureFetch({ stripe: fx })));
    expect(rec.provider).toEqual({ count: 3, gross: 17400, refunds: 500 });
    expect(rec.diff.count).toBe(0);
    expect(rec.diff.gross).toBeNull(); // EUR + USD ledger: gross not comparable in balance currency
    expect(rec.ok).toBe(true);
  });

  it("incremental uses created[gte] and fully refreshes subscriptions", async () => {
    const db = openHubDb(":memory:");
    const acct = await createAccount(db, {
      provider: "stripe",
      label: "Stripe",
      secretRef: "env:UNUSED_TEST_KEY",
    });
    const fx = loadFixture("stripe");
    await syncAccount(db, acct.id, { mode: "backfill", deps: deps(fixtureFetch({ stripe: fx })) });
    const f = fixtureFetch({ stripe: fx });
    await syncAccount(db, acct.id, { mode: "incremental", deps: deps(f) });
    const charges = new URL(f.calls.find((u) => u.includes("/v1/charges"))!);
    expect(Number(charges.searchParams.get("created[gte]"))).toBe(1769904000 - 2 * 86400);
    const subs = new URL(f.calls.find((u) => u.includes("/v1/subscriptions"))!);
    expect(subs.searchParams.get("created[gte]")).toBeNull();
    expect(subs.searchParams.get("status")).toBe("all");
  });
});

describe("sync failures", () => {
  it("records a missing key as an account error", async () => {
    const db = openHubDb(":memory:");
    const acct = await createAccount(db, {
      provider: "whop",
      label: "W",
      companyRef: "biz_x",
      secretRef: "env:REVENUE_TEST_SURELY_UNSET_KEY",
    });
    const r = await syncAccount(db, acct.id, { mode: "backfill", deps: { rateLimit: false } });
    expect(r.ok).toBe(false);
    expect(getAccount(db, acct.id)).toMatchObject({ status: "error" });
  });
});
