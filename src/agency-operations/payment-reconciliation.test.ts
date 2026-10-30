import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PAYMENT_MATCH_REASONS,
  matchPaymentToInvoice,
  reconcilePayments,
} from "./payment-reconciliation.js";
import { AgencyOperationsStore } from "./store.js";
import { DEFAULT_AGENCY_ID } from "./types.js";
import {
  WHOP_INVOICE_ID_KEY,
  WHOP_LINK_REFERENCE_KEY,
  WHOP_PROVIDER,
  type NormalizedWhopPayment,
} from "./whop-payments.js";

const MARCH_2024 = Date.UTC(2024, 2, 15);
const APRIL_2024 = Date.UTC(2024, 3, 2);

describe("Whop payment reconciliation", () => {
  let dir: string;
  let store: AgencyOperationsStore;
  let clientId: string;
  let otherClientId: string;

  /** An issued invoice for `totalCents`, ready to be paid. */
  function issuedInvoice(
    totalCents: number,
    overrides: { currency?: string; issuedAt?: number; clientId?: string } = {},
  ) {
    const created = store.createInvoiceDraft({
      clientId: overrides.clientId ?? clientId,
      currency: overrides.currency,
      lineItems: [{ description: "Work", quantity: 1, unitPriceCents: totalCents }],
    });
    store.issueInvoice(created.invoice.id, undefined, {
      issuedAt: overrides.issuedAt ?? MARCH_2024,
    });
    return store.getInvoice(created.invoice.id)!;
  }

  /** Bind a link to an invoice, as `paymentLink.create` would. */
  function attachLink(
    invoiceId: string,
    overrides: {
      reference?: string;
      externalId?: string;
      planId?: string | null;
      currency?: string;
    } = {},
  ) {
    return store.upsertInvoicePaymentLink({
      invoiceId,
      provider: WHOP_PROVIDER,
      externalId: overrides.externalId ?? `ch_${invoiceId}`,
      url: `https://whop.com/checkout/${invoiceId}`,
      label: "Pay online",
      reference: overrides.reference ?? `ref-${invoiceId}`,
      amountCents: store.getInvoice(invoiceId)!.balanceCents,
      currency: overrides.currency ?? "usd",
      planId: overrides.planId === undefined ? `plan_${invoiceId}` : overrides.planId,
    });
  }

  function payment(overrides: Partial<NormalizedWhopPayment> = {}): NormalizedWhopPayment {
    return {
      externalId: "pay_1",
      amountCents: 50_000,
      currency: "usd",
      paidAt: APRIL_2024,
      checkoutConfigurationId: null,
      planId: null,
      metadata: {},
      customerName: "Jane Buyer",
      customerEmail: "jane@acme.test",
      productTitle: null,
      ...overrides,
    };
  }

  function countRows(table: string): number {
    return (store as unknown as { db: { prepare(sql: string): { pluck(): { get(): number } } } }).db
      .prepare(`SELECT COUNT(*) FROM ${table}`)
      .pluck()
      .get();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-whop-recon-"));
    store = new AgencyOperationsStore(join(dir, "operations.sqlite"));
    clientId = store.createClient({ name: "Acme", billingEmail: "ap@acme.test" }).id;
    otherClientId = store.createClient({ name: "Globex", billingEmail: "ap@globex.test" }).id;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Positive evidence ────────────────────────────────────────────────────

  describe("matches only on positive evidence", () => {
    it("rule A: our invoice id + link reference echoed back", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { reference: "ref-secret" });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({
          metadata: {
            [WHOP_INVOICE_ID_KEY]: invoice.id,
            [WHOP_LINK_REFERENCE_KEY]: "ref-secret",
          },
        }),
      );
      expect(outcome).toEqual({
        matched: true,
        invoiceId: invoice.id,
        reason: PAYMENT_MATCH_REASONS.linkMetadata,
      });
    });

    it("rule B: a checkout configuration id we created", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { externalId: "ch_abc" });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({ checkoutConfigurationId: "ch_abc" }),
      );
      expect(outcome.matched).toBe(true);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.checkoutConfiguration);
    });

    it("rule C: a plan id held by exactly one link", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { planId: "plan_solo" });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({ planId: "plan_solo" }),
      );
      expect(outcome.matched).toBe(true);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.planId);
    });

    it("refuses a plan id shared by two links rather than picking one", () => {
      const first = issuedInvoice(50_000);
      const second = issuedInvoice(50_000);
      attachLink(first.id, { planId: "plan_shared", externalId: "ch_1" });
      attachLink(second.id, { planId: "plan_shared", externalId: "ch_2" });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({ planId: "plan_shared" }),
      );
      expect(outcome.matched).toBe(false);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.noEvidence);
    });
  });

  // ── Refusals ─────────────────────────────────────────────────────────────

  describe("refuses to match on weak evidence", () => {
    it("leaves a payment with no evidence at all unmatched", () => {
      issuedInvoice(50_000);
      const outcome = matchPaymentToInvoice(store, DEFAULT_AGENCY_ID, payment());
      expect(outcome).toEqual({
        matched: false,
        invoiceId: null,
        reason: PAYMENT_MATCH_REASONS.noEvidence,
      });
    });

    it("refuses a stale link reference — the link was regenerated", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { reference: "ref-current" });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({
          metadata: {
            [WHOP_INVOICE_ID_KEY]: invoice.id,
            [WHOP_LINK_REFERENCE_KEY]: "ref-OLD",
          },
        }),
      );
      expect(outcome.matched).toBe(false);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.referenceMismatch);
    });

    it("refuses a bare metadata claim with no link on the invoice", () => {
      const invoice = issuedInvoice(50_000);
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({
          metadata: {
            [WHOP_INVOICE_ID_KEY]: invoice.id,
            [WHOP_LINK_REFERENCE_KEY]: "ref-forged",
          },
        }),
      );
      expect(outcome.matched).toBe(false);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.noEvidence);
    });

    it("never converts across currencies", () => {
      const invoice = issuedInvoice(50_000, { currency: "EUR" });
      attachLink(invoice.id, { externalId: "ch_eur" });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({ checkoutConfigurationId: "ch_eur", currency: "usd" }),
      );
      expect(outcome.matched).toBe(false);
      expect(outcome.invoiceId).toBe(invoice.id);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.currencyMismatch);
    });

    it("queues rather than overpaying when the amount exceeds the balance", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { externalId: "ch_over" });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({ checkoutConfigurationId: "ch_over", amountCents: 50_001 }),
      );
      expect(outcome.matched).toBe(false);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.amountExceedsBalance);
    });

    it("queues a payment for an invoice that is no longer payable", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { externalId: "ch_paid" });
      store.recordPayment(invoice.id, { amountCents: 50_000 });
      const outcome = matchPaymentToInvoice(
        store,
        DEFAULT_AGENCY_ID,
        payment({ checkoutConfigurationId: "ch_paid" }),
      );
      expect(outcome.matched).toBe(false);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.invoiceNotPayable);
    });
  });

  // ── Rule D: the opt-in circumstantial rule ───────────────────────────────

  describe("exact-amount matching is opt-in and single-candidate only", () => {
    it("is off by default even when exactly one invoice fits", () => {
      issuedInvoice(50_000);
      expect(matchPaymentToInvoice(store, DEFAULT_AGENCY_ID, payment()).matched).toBe(false);
    });

    it("matches a sole candidate when asked for", () => {
      const invoice = issuedInvoice(50_000);
      const outcome = matchPaymentToInvoice(store, DEFAULT_AGENCY_ID, payment(), {
        allowAmountMatch: true,
      });
      expect(outcome).toEqual({
        matched: true,
        invoiceId: invoice.id,
        reason: PAYMENT_MATCH_REASONS.exactAmount,
      });
    });

    it("refuses when two invoices share the amount, even across clients", () => {
      issuedInvoice(50_000);
      issuedInvoice(50_000, { clientId: otherClientId });
      const outcome = matchPaymentToInvoice(store, DEFAULT_AGENCY_ID, payment(), {
        allowAmountMatch: true,
      });
      expect(outcome.matched).toBe(false);
      expect(outcome.reason).toBe(PAYMENT_MATCH_REASONS.ambiguousAmount);
    });

    it("respects the issue window", () => {
      // Issued in March, paid in April — 18 days apart.
      issuedInvoice(50_000, { issuedAt: MARCH_2024 });
      expect(
        matchPaymentToInvoice(store, DEFAULT_AGENCY_ID, payment(), {
          allowAmountMatch: true,
          windowDays: 5,
        }).matched,
      ).toBe(false);
      expect(
        matchPaymentToInvoice(store, DEFAULT_AGENCY_ID, payment(), {
          allowAmountMatch: true,
          windowDays: 30,
        }).matched,
      ).toBe(true);
    });
  });

  // ── The run ──────────────────────────────────────────────────────────────

  describe("reconcilePayments", () => {
    it("records the payment at the real Whop payment date, not at sync time", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { externalId: "ch_x" });
      const result = reconcilePayments({
        store,
        agencyId: DEFAULT_AGENCY_ID,
        payments: [payment({ checkoutConfigurationId: "ch_x", paidAt: APRIL_2024 })],
      });

      expect(result.matched).toBe(1);
      expect(result.appliedCents).toBe(50_000);
      expect(store.getInvoice(invoice.id)!.status).toBe("paid");

      const [recorded] = store.listInvoicePayments(DEFAULT_AGENCY_ID, invoice.id);
      expect(recorded.paidAt).toBe(APRIL_2024);
      expect(recorded.method).toBe(WHOP_PROVIDER);
      expect(recorded.reference).toBe("pay_1");
      // Revenue recognises in April, where the money actually landed.
      const revenue = store.revenueSummary(
        DEFAULT_AGENCY_ID,
        Date.UTC(2024, 3, 1),
        Date.UTC(2024, 4, 1),
      );
      expect(revenue.collectedRevenueCents).toBe(50_000);
      // …and not in March, where the invoice was issued.
      expect(
        store.revenueSummary(DEFAULT_AGENCY_ID, Date.UTC(2024, 2, 1), Date.UTC(2024, 3, 1))
          .collectedRevenueCents,
      ).toBe(0);
    });

    it("is idempotent: a second run over the same payments writes nothing", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { externalId: "ch_x" });
      const batch = [
        payment({ externalId: "pay_matched", checkoutConfigurationId: "ch_x" }),
        payment({ externalId: "pay_orphan", amountCents: 1_234 }),
      ];

      const first = reconcilePayments({ store, agencyId: DEFAULT_AGENCY_ID, payments: batch });
      expect(first).toMatchObject({ considered: 2, matched: 1, unmatched: 1, alreadyRecorded: 0 });

      const paymentsAfter = countRows("payments");
      const revenueAfter = countRows("revenue_entries");
      const receiptsAfter = countRows("external_payment_receipts");
      const auditAfter = countRows("audit_events");

      const second = reconcilePayments({ store, agencyId: DEFAULT_AGENCY_ID, payments: batch });
      expect(second).toMatchObject({
        considered: 0,
        matched: 0,
        unmatched: 0,
        alreadyRecorded: 2,
        appliedCents: 0,
      });
      expect(second.entries).toEqual([]);

      // Zero new rows, zero new audit entries — the write-amplification guard.
      expect(countRows("payments")).toBe(paymentsAfter);
      expect(countRows("revenue_entries")).toBe(revenueAfter);
      expect(countRows("external_payment_receipts")).toBe(receiptsAfter);
      expect(countRows("audit_events")).toBe(auditAfter);
      expect(store.getInvoice(invoice.id)!.amountPaidCents).toBe(50_000);
    });

    it("dry-run reports the same decisions and writes nothing at all", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id, { externalId: "ch_x" });
      const batch = [
        payment({ externalId: "pay_matched", checkoutConfigurationId: "ch_x" }),
        payment({ externalId: "pay_orphan", amountCents: 1_234 }),
      ];

      const before = {
        payments: countRows("payments"),
        revenue: countRows("revenue_entries"),
        receipts: countRows("external_payment_receipts"),
        audit: countRows("audit_events"),
      };

      const preview = reconcilePayments({
        store,
        agencyId: DEFAULT_AGENCY_ID,
        payments: batch,
        dryRun: true,
      });

      expect(preview.dryRun).toBe(true);
      expect(preview).toMatchObject({ considered: 2, matched: 1, unmatched: 1 });
      expect(preview.entries.map((entry) => entry.reason)).toEqual([
        PAYMENT_MATCH_REASONS.checkoutConfiguration,
        PAYMENT_MATCH_REASONS.noEvidence,
      ]);
      expect(preview.entries[0].invoiceNumber).toBe(invoice.number);

      expect(countRows("payments")).toBe(before.payments);
      expect(countRows("revenue_entries")).toBe(before.revenue);
      expect(countRows("external_payment_receipts")).toBe(before.receipts);
      expect(countRows("audit_events")).toBe(before.audit);
      expect(store.getInvoice(invoice.id)!.status).toBe("issued");

      // And the real run afterwards produces exactly what the preview promised.
      const real = reconcilePayments({ store, agencyId: DEFAULT_AGENCY_ID, payments: batch });
      expect(real.entries).toEqual(preview.entries.map((entry) => ({ ...entry })));
    });

    it("surfaces unmatched payments for human assignment instead of guessing", () => {
      const invoice = issuedInvoice(50_000);
      reconcilePayments({
        store,
        agencyId: DEFAULT_AGENCY_ID,
        payments: [payment({ externalId: "pay_orphan" })],
      });

      const queued = store.listExternalPaymentReceipts(DEFAULT_AGENCY_ID, { status: "unmatched" });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        externalId: "pay_orphan",
        status: "unmatched",
        invoiceId: null,
        matchReason: PAYMENT_MATCH_REASONS.noEvidence,
      });
      // Enough context for a person to assign it — and no API key anywhere.
      expect(queued[0].payload.customerEmail).toBe("jane@acme.test");
      expect(store.getInvoice(invoice.id)!.amountPaidCents).toBe(0);

      const { payment: applied } = store.resolveExternalPaymentReceipt(
        DEFAULT_AGENCY_ID,
        queued[0].id,
        invoice.id,
      );
      expect(applied.amountCents).toBe(50_000);
      expect(applied.paidAt).toBe(APRIL_2024);
      expect(store.getInvoice(invoice.id)!.status).toBe("paid");
      expect(
        store.listExternalPaymentReceipts(DEFAULT_AGENCY_ID, { status: "unmatched" }),
      ).toHaveLength(0);
    });

    it("refuses to assign or ignore a receipt twice", () => {
      const invoice = issuedInvoice(50_000);
      reconcilePayments({
        store,
        agencyId: DEFAULT_AGENCY_ID,
        payments: [payment({ externalId: "pay_orphan" })],
      });
      const [receipt] = store.listExternalPaymentReceipts(DEFAULT_AGENCY_ID, {
        status: "unmatched",
      });
      store.resolveExternalPaymentReceipt(DEFAULT_AGENCY_ID, receipt.id, invoice.id);
      expect(() =>
        store.resolveExternalPaymentReceipt(DEFAULT_AGENCY_ID, receipt.id, invoice.id),
      ).toThrow(/already matched/);
      expect(() => store.ignoreExternalPaymentReceipt(DEFAULT_AGENCY_ID, receipt.id)).toThrow(
        /already matched/,
      );
      expect(store.listInvoicePayments(DEFAULT_AGENCY_ID, invoice.id)).toHaveLength(1);
    });
  });

  // ── Link storage ─────────────────────────────────────────────────────────

  describe("invoice payment links", () => {
    it("keeps one live link per invoice and preserves createdAt across a regenerate", () => {
      const invoice = issuedInvoice(50_000);
      const first = attachLink(invoice.id, { externalId: "ch_1", reference: "ref-1" });
      const second = attachLink(invoice.id, { externalId: "ch_2", reference: "ref-2" });

      expect(second.createdAt).toBe(first.createdAt);
      expect(store.getInvoicePaymentLink(DEFAULT_AGENCY_ID, invoice.id)!.externalId).toBe("ch_2");
      // The replaced configuration is no longer evidence for anything.
      expect(
        store.findInvoicePaymentLinkByExternalId(DEFAULT_AGENCY_ID, WHOP_PROVIDER, "ch_1"),
      ).toBeNull();
      expect(countRows("invoice_payment_links")).toBe(1);
    });

    it("detaches, and reports whether there was anything to detach", () => {
      const invoice = issuedInvoice(50_000);
      attachLink(invoice.id);
      expect(store.deleteInvoicePaymentLink(DEFAULT_AGENCY_ID, invoice.id)).toBe(true);
      expect(store.deleteInvoicePaymentLink(DEFAULT_AGENCY_ID, invoice.id)).toBe(false);
      expect(store.getInvoicePaymentLink(DEFAULT_AGENCY_ID, invoice.id)).toBeNull();
    });

    it("refuses to bind a link to an invoice that does not exist", () => {
      expect(() =>
        store.upsertInvoicePaymentLink({
          invoiceId: "nope",
          provider: WHOP_PROVIDER,
          externalId: "ch_x",
          url: "https://whop.com/checkout/x",
          reference: "ref",
          amountCents: 1_000,
          currency: "usd",
        }),
      ).toThrow(/invoice not found/);
    });
  });
});
