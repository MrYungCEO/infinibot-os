import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getAgencyOperationsStore,
  resetAgencyOperationsStores,
} from "../../agency-operations/store.js";
import { openHubDb, type HubDb } from "../db.js";
import {
  defaultProjectForProduct,
  listProductProjectMappings,
  revenueArAging,
  setProductProjectMapping,
  syncAgencyRevenueToLedger,
} from "./canonical.js";
import { revenueSummary } from "./metrics.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

describe("canonical client revenue ledger", () => {
  let stateDir: string;
  let db: HubDb;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "revenue-canonical-"));
    db = openHubDb(":memory:");
  });

  afterEach(() => {
    resetAgencyOperationsStores();
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("merges every invoice state and payments idempotently, with links and period math", () => {
    const store = getAgencyOperationsStore(stateDir);
    const client = store.createClient({
      name: "Acme",
      email: "owner@acme.test",
      billingEmail: "ap@acme.test",
    });
    const project = store.createProject("default", { name: "Acme launch", clientId: client.id });

    const partial = store.createInvoiceDraft({
      clientId: client.id,
      dueAt: NOW - 45 * 86_400_000,
      projectIds: [project.id],
      lineItems: [
        {
          description: "Monthly retainer",
          quantity: 1,
          unitPriceCents: 100_000,
          cadence: "monthly",
        },
      ],
    });
    store.issueInvoice(partial.invoice.id);
    store.recordPayment(partial.invoice.id, { amountCents: 40_000, paidAt: NOW - 10_000 });

    const paid = store.createInvoiceDraft({
      clientId: client.id,
      dueAt: NOW + 86_400_000,
      lineItems: [{ description: "Site", quantity: 1, unitPriceCents: 25_000 }],
    });
    store.issueInvoice(paid.invoice.id);
    store.recordPayment(paid.invoice.id, { amountCents: 25_000, paidAt: NOW - 5_000 });

    const voided = store.createInvoiceDraft({
      clientId: client.id,
      lineItems: [{ description: "Canceled", quantity: 1, unitPriceCents: 5_000 }],
    });
    store.issueInvoice(voided.invoice.id);
    store.voidInvoice(voided.invoice.id);

    const first = syncAgencyRevenueToLedger(db, { stateDir, now: NOW });
    const second = syncAgencyRevenueToLedger(db, { stateDir, now: NOW });
    expect(first).toMatchObject({ invoices: 3, payments: 2, inserted: 5 });
    expect(second).toMatchObject({ invoices: 3, payments: 2, inserted: 0, updated: 0 });

    const rows = db
      .prepare(
        "SELECT type,status,client_id,invoice_id,project_id FROM revenue_txns ORDER BY type,status",
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(5);
    expect(
      rows
        .filter((row) => row.type === "invoice")
        .map((row) => row.status as string)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual(["overdue", "paid", "void"]);
    expect(rows.every((row) => row.client_id === client.id && row.invoice_id)).toBe(true);
    expect(rows.some((row) => row.project_id === "Acme launch")).toBe(true);

    const all = revenueSummary(db, { now: NOW });
    expect(all.totals).toMatchObject({ grossCents: 65_000, count: 2, netCents: 65_000 });
    expect(all.revenueMix).toEqual({
      recurringCents: 40_000,
      oneTimeCents: 25_000,
      recurringCount: 1,
      oneTimeCount: 1,
    });
    expect(all.byProject).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: "Acme launch", grossCents: 40_000 }),
        expect.objectContaining({ project: "Agency clients", grossCents: 25_000 }),
      ]),
    );
    const recent = revenueSummary(db, { from: NOW - 7_000, to: NOW, now: NOW });
    expect(recent.totals.grossCents).toBe(25_000);

    const aging = revenueArAging(db, NOW);
    expect(aging).toMatchObject({ totalCents: 60_000, overdueCents: 60_000 });
    expect(aging.invoices).toHaveLength(3);
    expect(
      aging.invoices.find((invoice) => invoice.invoiceId === partial.invoice.id),
    ).toMatchObject({ status: "overdue", balanceCents: 60_000, bucket: "60", open: true });
    expect(aging.invoices.find((invoice) => invoice.invoiceId === paid.invoice.id)).toMatchObject({
      status: "paid",
      balanceCents: 0,
      open: false,
    });
    expect(aging.invoices.find((invoice) => invoice.invoiceId === voided.invoice.id)).toMatchObject(
      { status: "void", open: false },
    );
  });

  it("derives editable product-to-project mappings", () => {
    expect(defaultProjectForProduct("FlyPic creator plan")).toBe("FlyPic");
    expect(defaultProjectForProduct("KinglyVault yearly")).toBe("KinglyVault");
    expect(defaultProjectForProduct("Automation Mastery")).toBe("Courses / digital products");
    expect(defaultProjectForProduct("1 on 1 Call")).toBe("Agency clients");
    db.prepare(
      `INSERT INTO revenue_accounts(id,provider,label,status,created_at,updated_at) VALUES('a','whop','Whop','ok',1,1)`,
    ).run();
    db.prepare(
      `INSERT INTO revenue_products(id,account_id,external_id,name,raw,updated_at) VALUES('catalog-only','a','never-sold','AI Agent Mastery','{"kind":"product"}',1)`,
    ).run();
    db.prepare(
      `INSERT INTO revenue_products(id,account_id,external_id,name,raw,updated_at) VALUES('plan','a','plan-1','FlyPic monthly','{"kind":"plan"}',1)`,
    ).run();
    db.prepare(
      `INSERT INTO revenue_txns(id,account_id,provider,external_id,type,status,gross_cents,fee_cents,net_cents,refunded_cents,currency,occurred_at,product_id,product_name,raw,created_at,updated_at) VALUES('t','a','whop','p','charge','succeeded',100,0,100,0,'USD',1,'prod','FlyPic creator plan','{}',1,1)`,
    ).run();
    const initial = listProductProjectMappings(db);
    expect(initial).toHaveLength(2);
    expect(initial).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: "never-sold",
          project: "Courses / digital products",
          catalog: true,
        }),
        expect.objectContaining({ productId: "prod", project: "FlyPic", explicit: false }),
      ]),
    );
    setProductProjectMapping(db, {
      accountId: "a",
      productId: "prod",
      productName: "FlyPic creator plan",
      project: "InfiniBot Cloud",
    });
    expect(listProductProjectMappings(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: "prod", project: "InfiniBot Cloud", explicit: true }),
      ]),
    );
    expect(revenueSummary(db).byProject[0]).toMatchObject({
      project: "InfiniBot Cloud",
      grossCents: 100,
    });
  });

  it("merges invoices from every agency into the owner-wide hub", () => {
    const store = getAgencyOperationsStore(stateDir);
    const agency = store.createAgency({
      name: "Studio Two",
      slug: "studio-two",
      ownerUserId: "owner",
    });
    const client = store.createClient({ name: "Second client" }, { agencyId: agency.id });
    const detail = store.createInvoiceDraft(
      {
        clientId: client.id,
        lineItems: [{ description: "Delivery", quantity: 1, unitPriceCents: 77_000 }],
      },
      { agencyId: agency.id },
    );
    store.issueInvoice(detail.invoice.id, { agencyId: agency.id });
    store.recordPayment(detail.invoice.id, { amountCents: 77_000 }, { agencyId: agency.id });
    expect(syncAgencyRevenueToLedger(db, { stateDir })).toMatchObject({
      invoices: 1,
      payments: 1,
      inserted: 2,
    });
    expect(revenueSummary(db).totals).toMatchObject({ grossCents: 77_000, count: 1 });
  });

  it("keeps client invoices inside their tenant state directory", () => {
    const tenantADir = join(stateDir, "tenant-a");
    const tenantBDir = join(stateDir, "tenant-b");
    const tenantA = getAgencyOperationsStore(tenantADir);
    const tenantB = getAgencyOperationsStore(tenantBDir);
    const dbA = openHubDb(":memory:");
    const dbB = openHubDb(":memory:");
    try {
      const clientA = tenantA.createClient({ name: "Tenant A client" });
      const invoiceA = tenantA.createInvoiceDraft({
        clientId: clientA.id,
        lineItems: [{ description: "A delivery", quantity: 1, unitPriceCents: 11_000 }],
      });
      tenantA.issueInvoice(invoiceA.invoice.id);

      const clientB = tenantB.createClient({ name: "Tenant B client" });
      const invoiceB = tenantB.createInvoiceDraft({
        clientId: clientB.id,
        lineItems: [{ description: "B delivery", quantity: 1, unitPriceCents: 22_000 }],
      });
      tenantB.issueInvoice(invoiceB.invoice.id);

      expect(syncAgencyRevenueToLedger(dbA, { stateDir: tenantADir })).toMatchObject({
        invoices: 1,
      });
      expect(syncAgencyRevenueToLedger(dbB, { stateDir: tenantBDir })).toMatchObject({
        invoices: 1,
      });

      const invoiceIds = (tenantDb: HubDb) =>
        (
          tenantDb
            .prepare("SELECT invoice_id FROM revenue_txns WHERE type='invoice'")
            .all() as Array<{ invoice_id: string }>
        ).map((row) => row.invoice_id);
      expect(invoiceIds(dbA)).toEqual([invoiceA.invoice.id]);
      expect(invoiceIds(dbB)).toEqual([invoiceB.invoice.id]);
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});
