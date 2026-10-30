/**
 * Turn Whop payments into agency.db payments — but only when the evidence is
 * positive.
 *
 * The governing rule of this module: **a mis-attributed payment is far worse
 * than an unmatched one.** Money attached to the wrong invoice corrupts that
 * client's balance, that client's revenue recognition, and the agency's books,
 * and nobody notices until a client disputes a statement. An unmatched payment
 * sits in a queue until a human spends ten seconds on it. So every rule below
 * either produces certainty or produces `unmatched`; there is no "probably".
 *
 * ── Matching rules, strongest first ──────────────────────────────────────────
 *
 *  A. `metadata.infinibot_invoice_id` + `metadata.infinibot_link_ref`
 *     Both keys were minted by us and pushed into the Whop checkout when the
 *     link was created; Whop copies checkout metadata onto every payment made
 *     through it. A payment carrying both, where the reference matches the one
 *     stored against that very invoice, is *our* link being paid.
 *     Evidence: an identifier we generated and got back. Confidence: certain.
 *
 *  B. `checkout_configuration_id` equals a stored link's `externalId`.
 *     The checkout configuration was created by us for exactly one invoice.
 *     Evidence: a provider-side id we recorded at creation. Confidence: certain.
 *     (Weaker than A only because it survives a link being regenerated —
 *     which is why the invoice binding is re-read from our table, not trusted
 *     from the payment.)
 *
 *  C. `plan.id` equals a stored link's `planId`, and exactly one link holds
 *     that plan id. Links are created with `force_create_new_plan`, so a plan
 *     belongs to one invoice. If two links somehow share a plan the lookup
 *     returns nothing and we fall through — ambiguity is never resolved by
 *     picking one. Confidence: high.
 *
 *  D. Exact amount + currency + issue-window, **opt-in and single-candidate
 *     only** (`allowAmountMatch`). Requires a payable invoice whose
 *     *outstanding balance* equals the payment to the cent, in the same
 *     currency, issued within the window. If two or more invoices qualify, the
 *     payment is left unmatched — this is the rule most likely to be wrong, so
 *     it refuses on any ambiguity and is off by default.
 *     Confidence: circumstantial. Off unless the caller asks for it.
 *
 * Anything else is `unmatched` and surfaced for human assignment.
 *
 * A candidate found by A–D is still rejected — and recorded as unmatched with
 * the reason — if the currency disagrees with the invoice, the invoice is not
 * in a payable state, or the amount exceeds the outstanding balance. We would
 * rather queue a payment on a paid invoice than silently overpay it.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Every provider payment we have ever seen has a row in
 * `external_payment_receipts`, keyed on `(agency_id, provider, external_id)`.
 * Reconciliation skips any payment that already has a receipt — matched,
 * unmatched or ignored — before doing any work. Re-running over the same Whop
 * payments therefore writes zero rows and emits zero audit events. This
 * codebase has been burned by write amplification before; the check is at the
 * top of the loop, not buried in the store.
 */

import type { AgencyOperationsStore } from "./store.js";
import type { ExternalPaymentReceipt, Invoice, Payment } from "./types.js";
import {
  WHOP_INVOICE_ID_KEY,
  WHOP_LINK_REFERENCE_KEY,
  WHOP_PROVIDER,
  type NormalizedWhopPayment,
} from "./whop-payments.js";

/** Machine-readable `matchReason` values. The UI maps these to prose. */
export const PAYMENT_MATCH_REASONS = {
  /** Rule A — our invoice id and link reference came back on the payment. */
  linkMetadata: "link_metadata",
  /** Rule B — the payment names a checkout configuration we created. */
  checkoutConfiguration: "checkout_configuration",
  /** Rule C — the payment names a plan we created for one invoice. */
  planId: "plan_id",
  /** Rule D — sole invoice with an exactly equal outstanding balance. */
  exactAmount: "exact_amount_single_candidate",
  /** Assigned by a person. */
  manual: "manual_assignment",
  // Refusals.
  noEvidence: "no_matching_evidence",
  ambiguousAmount: "ambiguous_amount_candidates",
  currencyMismatch: "currency_mismatch",
  amountExceedsBalance: "amount_exceeds_balance",
  invoiceNotPayable: "invoice_not_payable",
  invoiceMissing: "invoice_missing",
  referenceMismatch: "link_reference_mismatch",
} as const;

const PAYABLE_STATUSES = new Set(["issued", "partially_paid", "overdue"]);

const DAY_MS = 86_400_000;
const DEFAULT_AMOUNT_MATCH_WINDOW_DAYS = 30;
const MAX_AMOUNT_MATCH_WINDOW_DAYS = 90;

export interface MatchOptions {
  /**
   * Enable rule D. Off by default: an exact-amount match is circumstantial
   * evidence, and the caller has to say they want it.
   */
  allowAmountMatch?: boolean;
  /** Rule D window, in days before the payment, that the invoice was issued. */
  windowDays?: number;
}

export interface MatchOutcome {
  matched: boolean;
  invoiceId: string | null;
  reason: string;
}

/**
 * Decide what a single provider payment settles. Pure with respect to the
 * database — it reads, it never writes — so the dry-run preview and the real
 * run call exactly the same function and cannot disagree.
 */
export function matchPaymentToInvoice(
  store: AgencyOperationsStore,
  agencyId: string,
  payment: NormalizedWhopPayment,
  options: MatchOptions = {},
): MatchOutcome {
  const candidate = findCandidateInvoice(store, agencyId, payment, options);
  if (!candidate) {
    return { matched: false, invoiceId: null, reason: PAYMENT_MATCH_REASONS.noEvidence };
  }
  if (candidate.reason && !candidate.invoice) {
    return { matched: false, invoiceId: candidate.invoiceId ?? null, reason: candidate.reason };
  }
  const invoice = candidate.invoice!;

  // Sanity gates. Each of these means "we know which invoice, but applying the
  // payment would be wrong" — so the payment is queued with the reason, not
  // dropped and not forced through.
  if (invoice.currency.trim().toLowerCase() !== payment.currency) {
    return {
      matched: false,
      invoiceId: invoice.id,
      reason: PAYMENT_MATCH_REASONS.currencyMismatch,
    };
  }
  if (!PAYABLE_STATUSES.has(invoice.status)) {
    return {
      matched: false,
      invoiceId: invoice.id,
      reason: PAYMENT_MATCH_REASONS.invoiceNotPayable,
    };
  }
  if (payment.amountCents > invoice.balanceCents) {
    return {
      matched: false,
      invoiceId: invoice.id,
      reason: PAYMENT_MATCH_REASONS.amountExceedsBalance,
    };
  }
  return { matched: true, invoiceId: invoice.id, reason: candidate.reason! };
}

interface Candidate {
  invoice: Invoice | null;
  invoiceId: string | null;
  reason: string | null;
}

function findCandidateInvoice(
  store: AgencyOperationsStore,
  agencyId: string,
  payment: NormalizedWhopPayment,
  options: MatchOptions,
): Candidate | null {
  // ── Rule A: our own metadata round-tripped ──
  const metaInvoiceId = payment.metadata[WHOP_INVOICE_ID_KEY];
  const metaReference = payment.metadata[WHOP_LINK_REFERENCE_KEY];
  if (metaInvoiceId && metaReference) {
    const link = store.getInvoicePaymentLink(agencyId, metaInvoiceId);
    // The reference must match the link currently on that invoice. A stale
    // reference means the link was regenerated — possibly for a different
    // amount — so it is not evidence any more.
    if (link && link.reference === metaReference) {
      const invoice = store.getInvoice(metaInvoiceId, agencyId);
      if (!invoice) {
        return {
          invoice: null,
          invoiceId: metaInvoiceId,
          reason: PAYMENT_MATCH_REASONS.invoiceMissing,
        };
      }
      return { invoice, invoiceId: invoice.id, reason: PAYMENT_MATCH_REASONS.linkMetadata };
    }
    if (link) {
      return {
        invoice: null,
        invoiceId: metaInvoiceId,
        reason: PAYMENT_MATCH_REASONS.referenceMismatch,
      };
    }
    // No link on that invoice at all — fall through to the weaker rules
    // rather than trusting a bare metadata claim.
  }

  // ── Rule B: the checkout configuration we created ──
  if (payment.checkoutConfigurationId) {
    const link = store.findInvoicePaymentLinkByExternalId(
      agencyId,
      WHOP_PROVIDER,
      payment.checkoutConfigurationId,
    );
    if (link) {
      const invoice = store.getInvoice(link.invoiceId, agencyId);
      if (!invoice) {
        return {
          invoice: null,
          invoiceId: link.invoiceId,
          reason: PAYMENT_MATCH_REASONS.invoiceMissing,
        };
      }
      return {
        invoice,
        invoiceId: invoice.id,
        reason: PAYMENT_MATCH_REASONS.checkoutConfiguration,
      };
    }
  }

  // ── Rule C: the per-invoice plan ──
  if (payment.planId) {
    const link = store.findInvoicePaymentLinkByPlanId(agencyId, payment.planId);
    if (link) {
      const invoice = store.getInvoice(link.invoiceId, agencyId);
      if (!invoice) {
        return {
          invoice: null,
          invoiceId: link.invoiceId,
          reason: PAYMENT_MATCH_REASONS.invoiceMissing,
        };
      }
      return { invoice, invoiceId: invoice.id, reason: PAYMENT_MATCH_REASONS.planId };
    }
  }

  // ── Rule D: exact amount, opt-in, single candidate only ──
  if (options.allowAmountMatch) {
    const windowDays = Math.min(
      Math.max(options.windowDays ?? DEFAULT_AMOUNT_MATCH_WINDOW_DAYS, 1),
      MAX_AMOUNT_MATCH_WINDOW_DAYS,
    );
    const candidates = store.findInvoicesByOutstandingAmount(
      agencyId,
      payment.amountCents,
      payment.currency,
      payment.paidAt - windowDays * DAY_MS,
      // A day of slack forward absorbs clock skew between Whop and the local
      // clock without opening the window to invoices issued after the fact.
      payment.paidAt + DAY_MS,
    );
    if (candidates.length === 1) {
      return {
        invoice: candidates[0],
        invoiceId: candidates[0].id,
        reason: PAYMENT_MATCH_REASONS.exactAmount,
      };
    }
    if (candidates.length > 1) {
      return { invoice: null, invoiceId: null, reason: PAYMENT_MATCH_REASONS.ambiguousAmount };
    }
  }

  return null;
}

// ── The run ────────────────────────────────────────────────────────────────

export interface ReconcilePlanEntry {
  externalId: string;
  amountCents: number;
  currency: string;
  paidAt: number;
  matched: boolean;
  invoiceId: string | null;
  invoiceNumber: string | null;
  reason: string;
}

export interface ReconcileResult {
  dryRun: boolean;
  /** Provider payments considered on this run (already-seen ones excluded). */
  considered: number;
  /** Payments skipped because a receipt already existed. */
  alreadyRecorded: number;
  matched: number;
  unmatched: number;
  /** Total applied to invoices, in integer cents. */
  appliedCents: number;
  entries: ReconcilePlanEntry[];
}

export interface ReconcileInput {
  store: AgencyOperationsStore;
  agencyId: string;
  actorId?: string | null;
  payments: NormalizedWhopPayment[];
  dryRun?: boolean;
  match?: MatchOptions;
}

/**
 * Apply (or, in dry-run, merely describe) a batch of provider payments.
 *
 * `dryRun` shares every line of decision logic with the real run and differs
 * only in whether `recordExternalPaymentReceipt` is called — so the preview an
 * operator approves is the run they get.
 */
export function reconcilePayments(input: ReconcileInput): ReconcileResult {
  const { store, agencyId, payments } = input;
  const dryRun = input.dryRun === true;
  const result: ReconcileResult = {
    dryRun,
    considered: 0,
    alreadyRecorded: 0,
    matched: 0,
    unmatched: 0,
    appliedCents: 0,
    entries: [],
  };

  for (const payment of payments) {
    // Idempotency gate, before any work: a payment with a receipt has already
    // been decided, and re-deciding it is exactly the write amplification we
    // are guarding against.
    if (store.getExternalPaymentReceipt(agencyId, WHOP_PROVIDER, payment.externalId)) {
      result.alreadyRecorded += 1;
      continue;
    }
    result.considered += 1;
    const outcome = matchPaymentToInvoice(store, agencyId, payment, input.match ?? {});
    const invoice = outcome.invoiceId ? store.getInvoice(outcome.invoiceId, agencyId) : null;
    result.entries.push({
      externalId: payment.externalId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      paidAt: payment.paidAt,
      matched: outcome.matched,
      invoiceId: outcome.matched ? outcome.invoiceId : null,
      invoiceNumber: outcome.matched ? (invoice?.number ?? null) : null,
      reason: outcome.reason,
    });
    if (outcome.matched) {
      result.matched += 1;
      result.appliedCents += payment.amountCents;
    } else {
      result.unmatched += 1;
    }
    if (dryRun) continue;
    store.recordExternalPaymentReceipt(
      {
        provider: WHOP_PROVIDER,
        externalId: payment.externalId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        paidAt: payment.paidAt,
        status: outcome.matched ? "matched" : "unmatched",
        matchReason: outcome.reason,
        invoiceId: outcome.matched ? outcome.invoiceId : null,
        payload: {
          customerName: payment.customerName,
          customerEmail: payment.customerEmail,
          checkoutConfigurationId: payment.checkoutConfigurationId,
          planId: payment.planId,
          productTitle: payment.productTitle,
          // Keys only. Metadata values are operator-supplied and could carry
          // anything; the two keys we care about are already resolved above.
          metadataKeys: Object.keys(payment.metadata),
        },
      },
      { agencyId, actorId: input.actorId ?? null },
    );
  }
  return result;
}

export type { ExternalPaymentReceipt, Payment };
