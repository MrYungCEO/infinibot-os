import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgencyOperationsStore } from "./store.js";
import { DEFAULT_AGENCY_ID } from "./types.js";

/** UTC month window `[start, end)` — the shape `revenueSummary` expects. */
function utcMonth(year: number, month: number): { startAt: number; endAt: number } {
  return {
    startAt: Date.UTC(year, month - 1, 1),
    endAt: Date.UTC(year, month, 1),
  };
}

const MARCH_2024 = Date.UTC(2024, 2, 15);
const APRIL_2024 = Date.UTC(2024, 3, 2);
const MAY_2024 = Date.UTC(2024, 4, 20);

describe("invoice authoring", () => {
  let dir: string;
  let store: AgencyOperationsStore;
  let clientId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-invoicing-"));
    store = new AgencyOperationsStore(join(dir, "operations.sqlite"));
    clientId = store.createClient({ name: "Acme", billingEmail: "ap@acme.test" }).id;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs draft -> issue -> partially paid -> paid and keeps totals to the cent", () => {
    const created = store.createInvoiceDraft({
      clientId,
      // 2.5 × 1999 = 4997.5 cents. The half-cent is rounded ONCE, at write
      // time, so the stored line total, the subtotal and the revenue entry can
      // never disagree with each other.
      lineItems: [
        { description: "Retainer", quantity: 3, unitPriceCents: 33_333 },
        { description: "Hourly overage", quantity: 2.5, unitPriceCents: 1_999 },
      ],
      taxCents: 1_000,
      taxLabel: "VAT",
    });

    expect(created.lineItems.map((item) => item.totalCents)).toEqual([99_999, 4_998]);
    expect(created.invoice.subtotalCents).toBe(104_997);
    expect(created.invoice.totalCents).toBe(105_997);
    expect(created.invoice.status).toBe("draft");
    expect(created.invoice.balanceCents).toBe(105_997);

    const issued = store.issueInvoice(created.invoice.id);
    expect(issued.status).toBe("issued");
    expect(issued.issuedAt).not.toBeNull();

    const first = store.recordPayment(created.invoice.id, { amountCents: 5_997 });
    expect(first.amountCents).toBe(5_997);
    expect(store.getInvoice(created.invoice.id)!.status).toBe("partially_paid");
    expect(store.getInvoice(created.invoice.id)!.balanceCents).toBe(100_000);

    store.recordPayment(created.invoice.id, { amountCents: 100_000 });
    const settled = store.getInvoice(created.invoice.id)!;
    expect(settled.status).toBe("paid");
    expect(settled.amountPaidCents).toBe(105_997);
    expect(settled.balanceCents).toBe(0);
  });

  it("refuses a payment larger than the outstanding balance", () => {
    const created = store.createInvoiceDraft({
      clientId,
      lineItems: [{ description: "Sprint", quantity: 1, unitPriceCents: 50_000 }],
    });
    store.issueInvoice(created.invoice.id);
    expect(() => store.recordPayment(created.invoice.id, { amountCents: 50_001 })).toThrow(
      /exceeds outstanding balance/,
    );
  });

  it("edits line items only while the invoice is a draft, recomputing totals each time", () => {
    const created = store.createInvoiceDraft({
      clientId,
      lineItems: [{ description: "Design", quantity: 1, unitPriceCents: 20_000 }],
    });
    const id = created.invoice.id;

    const added = store.addInvoiceLineItem(id, {
      description: "Build",
      quantity: 2,
      unitPriceCents: 15_000,
    });
    expect(added.invoice.subtotalCents).toBe(50_000);
    expect(added.lineItems.map((item) => item.sortOrder)).toEqual([0, 1]);

    const updated = store.updateInvoiceLineItem(id, added.lineItems[1].id, { quantity: 3 });
    expect(updated.invoice.subtotalCents).toBe(65_000);

    const reordered = store.reorderInvoiceLineItems(id, [
      added.lineItems[1].id,
      added.lineItems[0].id,
    ]);
    expect(reordered.lineItems.map((item) => item.description)).toEqual(["Build", "Design"]);

    const removed = store.removeInvoiceLineItem(id, added.lineItems[0].id);
    expect(removed.lineItems.map((item) => item.description)).toEqual(["Build"]);
    expect(removed.lineItems.map((item) => item.sortOrder)).toEqual([0]);
    expect(removed.invoice.subtotalCents).toBe(45_000);

    store.issueInvoice(id);
    expect(() =>
      store.addInvoiceLineItem(id, { description: "Late", quantity: 1, unitPriceCents: 1 }),
    ).toThrow(/only be edited while the invoice is a draft/);
    expect(() =>
      store.updateInvoice(id, {
        lineItems: [{ description: "x", quantity: 1, unitPriceCents: 1 }],
      }),
    ).toThrow(/only be edited while the invoice is a draft/);
    // Presentation fields stay editable after issue.
    const noted = store.updateInvoice(id, { notes: "Thanks!", terms: "Net 14" });
    expect(noted.invoice.notes).toBe("Thanks!");
    expect(noted.invoice.terms).toBe("Net 14");
  });

  it("numbers invoices per agency, honours overrides and never reuses a number", () => {
    const other = store.createAgency({ name: "Other", slug: "other", ownerUserId: "u2" });
    const otherClient = store.createClient({ name: "Beta" }, { agencyId: other.id }).id;
    const year = new Date().getUTCFullYear();

    const a = store.createInvoiceDraft({
      clientId,
      lineItems: [{ description: "A", quantity: 1, unitPriceCents: 100 }],
    });
    const b = store.createInvoiceDraft({
      clientId,
      lineItems: [{ description: "B", quantity: 1, unitPriceCents: 100 }],
    });
    expect(a.invoice.number).toBe(`INV-${year}-0001`);
    expect(b.invoice.number).toBe(`INV-${year}-0002`);

    // A second agency has its own run.
    const c = store.createInvoiceDraft(
      {
        clientId: otherClient,
        lineItems: [{ description: "C", quantity: 1, unitPriceCents: 100 }],
      },
      { agencyId: other.id },
    );
    expect(c.invoice.number).toBe(`INV-${year}-0001`);

    // Voiding does not release the number back into the pool.
    store.voidInvoice(b.invoice.id);
    const d = store.createInvoiceDraft({
      clientId,
      lineItems: [{ description: "D", quantity: 1, unitPriceCents: 100 }],
    });
    expect(d.invoice.number).toBe(`INV-${year}-0003`);

    // An explicit number is honoured, and the counter steps past a collision.
    const manual = store.createInvoiceDraft({
      clientId,
      number: `INV-${year}-0004`,
      lineItems: [{ description: "E", quantity: 1, unitPriceCents: 100 }],
    });
    expect(manual.invoice.number).toBe(`INV-${year}-0004`);
    const next = store.createInvoiceDraft({
      clientId,
      lineItems: [{ description: "F", quantity: 1, unitPriceCents: 100 }],
    });
    expect(next.invoice.number).toBe(`INV-${year}-0005`);

    // Same number twice within an agency is a hard error.
    expect(() =>
      store.createInvoiceDraft({
        clientId,
        number: `INV-${year}-0001`,
        lineItems: [{ description: "dup", quantity: 1, unitPriceCents: 100 }],
      }),
    ).toThrow();
  });

  it("backdates the issue date into a historical period rather than the current month", () => {
    const created = store.createInvoiceDraft({
      clientId,
      issuedAt: MARCH_2024,
      lineItems: [{ description: "March retainer", quantity: 1, unitPriceCents: 250_000 }],
    });
    store.issueInvoice(created.invoice.id, undefined, { issuedAt: MARCH_2024 });

    const march = utcMonth(2024, 3);
    const summary = store.revenueSummary(DEFAULT_AGENCY_ID, march.startAt, march.endAt);
    expect(summary.invoicedRevenueCents).toBe(250_000);
    expect(summary.collectedRevenueCents).toBe(0);

    const now = utcMonth(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1);
    const current = store.revenueSummary(DEFAULT_AGENCY_ID, now.startAt, now.endAt);
    expect(current.invoicedRevenueCents).toBe(0);
  });

  it("lands a backdated partial payment in the month it was actually received", () => {
    const detail = store.recordHistoricalInvoice({
      clientId,
      issuedAt: MARCH_2024,
      dueAt: APRIL_2024,
      lineItems: [{ description: "Q1 project", quantity: 1, unitPriceCents: 400_000 }],
      payments: [
        { amountCents: 150_000, paidAt: APRIL_2024, method: "bank" },
        { amountCents: 250_000, paidAt: MAY_2024, method: "bank" },
      ],
    });

    expect(detail.invoice.status).toBe("paid");
    expect(detail.invoice.issuedAt).toBe(MARCH_2024);
    // The row itself is dated when the work was billed, not when it was typed.
    expect(detail.invoice.createdAt).toBe(MARCH_2024);
    expect(detail.payments.map((payment) => payment.paidAt)).toEqual([APRIL_2024, MAY_2024]);

    const march = utcMonth(2024, 3);
    const april = utcMonth(2024, 4);
    const may = utcMonth(2024, 5);

    const marchSummary = store.revenueSummary(DEFAULT_AGENCY_ID, march.startAt, march.endAt);
    expect(marchSummary.invoicedRevenueCents).toBe(400_000);
    expect(marchSummary.collectedRevenueCents).toBe(0);

    const aprilSummary = store.revenueSummary(DEFAULT_AGENCY_ID, april.startAt, april.endAt);
    expect(aprilSummary.invoicedRevenueCents).toBe(0);
    expect(aprilSummary.collectedRevenueCents).toBe(150_000);

    const maySummary = store.revenueSummary(DEFAULT_AGENCY_ID, may.startAt, may.endAt);
    expect(maySummary.collectedRevenueCents).toBe(250_000);

    // And nothing at all leaks into today.
    const now = utcMonth(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1);
    const current = store.revenueSummary(DEFAULT_AGENCY_ID, now.startAt, now.endAt);
    expect(current.invoicedRevenueCents).toBe(0);
    expect(current.collectedRevenueCents).toBe(0);
  });

  it("settles a historical invoice in full on its issue date with paidInFullAt", () => {
    const detail = store.recordHistoricalInvoice({
      clientId,
      issuedAt: MARCH_2024,
      paidInFullAt: MARCH_2024,
      lineItems: [{ description: "One-off", quantity: 1, unitPriceCents: 12_345 }],
    });
    expect(detail.invoice.status).toBe("paid");
    expect(detail.invoice.amountPaidCents).toBe(12_345);

    const march = utcMonth(2024, 3);
    const summary = store.revenueSummary(DEFAULT_AGENCY_ID, march.startAt, march.endAt);
    expect(summary.invoicedRevenueCents).toBe(12_345);
    expect(summary.collectedRevenueCents).toBe(12_345);
  });

  it("backdates recurring revenue profiles so activeSince moves earlier, never later", () => {
    store.recordHistoricalInvoice({
      clientId,
      issuedAt: MAY_2024,
      lineItems: [
        { description: "Care plan", quantity: 1, unitPriceCents: 90_000, cadence: "monthly" },
      ],
    });
    expect(store.getClientRevenueProfile(DEFAULT_AGENCY_ID, clientId)).toMatchObject({
      mrrCents: 90_000,
      arrCents: 1_080_000,
      activeSince: MAY_2024,
    });

    // An older invoice entered afterwards must pull `activeSince` backwards.
    store.recordHistoricalInvoice({
      clientId,
      issuedAt: MARCH_2024,
      lineItems: [
        { description: "Care plan", quantity: 1, unitPriceCents: 90_000, cadence: "monthly" },
      ],
    });
    expect(store.getClientRevenueProfile(DEFAULT_AGENCY_ID, clientId)!.activeSince).toBe(
      MARCH_2024,
    );
  });

  it("derives monthly-equivalent revenue from each line item's cadence", () => {
    const detail = store.createInvoiceDraft({
      clientId,
      lineItems: [
        { description: "Setup", quantity: 1, unitPriceCents: 100_000, cadence: "one_time" },
        { description: "Monthly", quantity: 1, unitPriceCents: 30_000, cadence: "monthly" },
        { description: "Quarterly", quantity: 1, unitPriceCents: 30_000, cadence: "quarterly" },
        { description: "Annual", quantity: 1, unitPriceCents: 120_000, cadence: "annual" },
      ],
    });
    // 30 000 + 10 000 + 10 000 = 50 000; the one-off contributes nothing.
    expect(store.invoiceRecurringMonthlyCents(DEFAULT_AGENCY_ID, detail.invoice.id)).toBe(50_000);
  });

  it("voids an unpaid invoice and removes the revenue it had recognised", () => {
    const detail = store.recordHistoricalInvoice({
      clientId,
      issuedAt: MARCH_2024,
      lineItems: [{ description: "Cancelled work", quantity: 1, unitPriceCents: 75_000 }],
    });
    const march = utcMonth(2024, 3);
    expect(
      store.revenueSummary(DEFAULT_AGENCY_ID, march.startAt, march.endAt).invoicedRevenueCents,
    ).toBe(75_000);

    const voided = store.voidInvoice(detail.invoice.id, undefined, "duplicate");
    expect(voided.status).toBe("void");
    expect(
      store.revenueSummary(DEFAULT_AGENCY_ID, march.startAt, march.endAt).invoicedRevenueCents,
    ).toBe(0);

    const paid = store.recordHistoricalInvoice({
      clientId,
      issuedAt: MARCH_2024,
      paidInFullAt: MARCH_2024,
      lineItems: [{ description: "Real work", quantity: 1, unitPriceCents: 1_000 }],
    });
    expect(() => store.voidInvoice(paid.invoice.id)).toThrow(/payments cannot be voided/);
  });

  it("imports a batch of historical invoices atomically", () => {
    const second = store.createClient({ name: "Globex" }).id;
    const result = store.importHistoricalInvoices([
      {
        clientId,
        issuedAt: MARCH_2024,
        paidInFullAt: MARCH_2024,
        lineItems: [{ description: "Jan-Mar", quantity: 1, unitPriceCents: 100_000 }],
      },
      {
        clientId: second,
        issuedAt: APRIL_2024,
        lineItems: [{ description: "Apr", quantity: 1, unitPriceCents: 55_500 }],
      },
    ]);
    expect(result.imported).toHaveLength(2);
    expect(result.totalCents).toBe(155_500);
    expect(result.collectedCents).toBe(100_000);

    // A bad row aborts the whole batch — no half-written revenue history.
    const before = store.listInvoices(DEFAULT_AGENCY_ID).length;
    expect(() =>
      store.importHistoricalInvoices([
        {
          clientId,
          issuedAt: MAY_2024,
          lineItems: [{ description: "ok", quantity: 1, unitPriceCents: 100 }],
        },
        {
          clientId: "missing-client",
          issuedAt: MAY_2024,
          lineItems: [{ description: "bad", quantity: 1, unitPriceCents: 100 }],
        },
      ]),
    ).toThrow(/row 2: client not found/);
    expect(store.listInvoices(DEFAULT_AGENCY_ID)).toHaveLength(before);
  });

  it("splits an invoice across projects so the allocations add up to the total", () => {
    const one = store.createProject(DEFAULT_AGENCY_ID, { name: "Site", clientId }).id;
    const two = store.createProject(DEFAULT_AGENCY_ID, { name: "Brand", clientId }).id;
    const detail = store.createInvoiceDraft({
      clientId,
      projectIds: [one, two],
      // An odd total, so an even split has a remainder to place.
      lineItems: [{ description: "Combined", quantity: 1, unitPriceCents: 100_001 }],
    });
    const allocations = detail.projectLinks.map((link) => link.allocationCents);
    expect(allocations.reduce((sum, value) => sum + value, 0)).toBe(100_001);
    expect([...allocations].sort((a, b) => a - b)).toEqual([50_000, 50_001]);
  });
});

describe("proposals and expected revenue", () => {
  let dir: string;
  let store: AgencyOperationsStore;
  let clientId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-proposals-"));
    store = new AgencyOperationsStore(join(dir, "operations.sqlite"));
    clientId = store.createClient({ name: "Initech" }).id;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens an opportunity for a client-only proposal and numbers it", () => {
    const proposal = store.createProposal({
      clientId,
      title: "Rebuild",
      scope: "Discovery, design, build",
      summary: "A full rebuild in three phases.",
      sections: [{ heading: "Timeline", body: "12 weeks" }],
      acceptanceTerms: ["50% up front"],
      lineItems: [
        { description: "Discovery", quantity: 1, unitPriceCents: 500_000 },
        { description: "Build", quantity: 1, unitPriceCents: 1_500_000 },
      ],
    });

    expect(proposal.clientId).toBe(clientId);
    expect(proposal.number).toMatch(/^PRO-\d{4}-0001$/);
    expect(proposal.totalCents).toBe(2_000_000);
    expect(proposal.sections).toEqual([{ heading: "Timeline", body: "12 weeks" }]);
    expect(proposal.acceptanceTerms).toEqual(["50% up front"]);
    expect(store.getOpportunity(proposal.opportunityId)!.stage).toBe("proposal");
  });

  it("moves expected revenue when a proposal is accepted and again when it is invoiced", () => {
    const proposal = store.createProposal({
      clientId,
      title: "Retainer",
      scope: "Ongoing",
      lineItems: [{ description: "Year one", quantity: 1, unitPriceCents: 1_200_000 }],
    });

    const open = store.revenuePipelineSummary();
    expect(open.openProposalCents).toBe(1_200_000);
    expect(open.acceptedUninvoicedCents).toBe(0);
    // Still an open opportunity at 50% probability.
    expect(open.weightedPipelineCents).toBe(600_000);
    expect(open.expectedRevenueCents).toBe(600_000);

    const accepted = store.acceptProposal(proposal.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedAt).not.toBeNull();
    expect(store.getOpportunity(proposal.opportunityId)!.stage).toBe("won");

    const won = store.revenuePipelineSummary();
    expect(won.openProposalCents).toBe(0);
    expect(won.acceptedProposalCents).toBe(1_200_000);
    expect(won.acceptedUninvoicedCents).toBe(1_200_000);
    // The opportunity has left the open pipeline, so nothing double-counts.
    expect(won.weightedPipelineCents).toBe(0);
    expect(won.expectedRevenueCents).toBe(1_200_000);

    // Billing half of it moves half out of "expected" and into "invoiced".
    store.recordHistoricalInvoice({
      clientId,
      proposalId: proposal.id,
      issuedAt: MARCH_2024,
      lineItems: [{ description: "Phase 1", quantity: 1, unitPriceCents: 600_000 }],
    });
    const billed = store.revenuePipelineSummary();
    expect(billed.acceptedUninvoicedCents).toBe(600_000);
    expect(billed.expectedRevenueCents).toBe(600_000);

    const march = utcMonth(2024, 3);
    const summary = store.revenueSummary(DEFAULT_AGENCY_ID, march.startAt, march.endAt);
    expect(summary.invoicedRevenueCents).toBe(600_000);
    expect(summary.pipeline.acceptedUninvoicedCents).toBe(600_000);
  });

  it("walks the status machine rather than skipping states", () => {
    const proposal = store.createProposal({
      clientId,
      title: "Sprint",
      scope: "Two weeks",
      lineItems: [{ description: "Sprint", quantity: 1, unitPriceCents: 300_000 }],
    });
    store.advanceProposalTo(proposal.id, "sent");
    expect(store.listAuditEvents("proposal", proposal.id).map((event) => event.action)).toEqual([
      "created",
      "status_changed",
      "status_changed",
    ]);
    // `accepted` is terminal — there is no route out of it.
    store.acceptProposal(proposal.id);
    expect(() => store.advanceProposalTo(proposal.id, "rejected")).toThrow(
      /Invalid proposal transition/,
    );
  });

  it("locks proposal money once it has been sent", () => {
    const proposal = store.createProposal({
      clientId,
      title: "Audit",
      scope: "One week",
      lineItems: [{ description: "Audit", quantity: 1, unitPriceCents: 100_000 }],
    });
    const raised = store.updateProposal(proposal.id, {
      lineItems: [{ description: "Audit", quantity: 2, unitPriceCents: 100_000 }],
    });
    expect(raised.totalCents).toBe(200_000);
    // The opportunity tracks the new figure, so the pipeline never goes stale.
    expect(store.getOpportunity(proposal.opportunityId)!.valueCents).toBe(200_000);

    store.advanceProposalTo(proposal.id, "sent");
    expect(() => store.updateProposal(proposal.id, { taxCents: 500 })).toThrow(
      /money cannot be edited/,
    );
    // Prose is still editable.
    expect(store.updateProposal(proposal.id, { summary: "Updated" }).summary).toBe("Updated");
  });
});
