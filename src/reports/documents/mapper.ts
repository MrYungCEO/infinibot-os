/**
 * Store rows → document models.
 *
 * The gateway side owns this step: it has the agency-operations store open
 * already, builds a plain-JSON {@link InvoiceDocumentModel} /
 * {@link ProposalDocumentModel}, and hands it to `reports.generate` inside
 * `config.document`. The render worker then needs nothing but the JSON — it
 * never opens `agency.db`, which keeps the two processes' database handles
 * fully separate (the same reason the worker owns puppeteer and the gateway
 * does not).
 *
 * All agency-operations imports here are `import type`, so this module adds no
 * runtime dependency on that subsystem.
 */

import type {
  AgencyProfile,
  Client,
  Contact,
  Invoice,
  InvoiceLineItem,
  Payment,
  Proposal,
} from "../../agency-operations/types.js";
import type { Theme } from "../types.js";
import { getTheme } from "../themes/index.js";
import { goldLetterhead } from "../themes/gold-letterhead.js";
import { resolveDocumentBrand, splitAddress, type AgencyBrandSource } from "./brand.js";
import { normalizeCurrency, sumCents } from "./money.js";
import type {
  DocumentLineItem,
  DocumentParty,
  DocumentTotals,
  InvoiceBankDetails,
  InvoiceDocumentModel,
  InvoicePaymentRecord,
  ProposalDocumentModel,
  ProposalSection,
} from "./types.js";

/** Documents default to the client-facing letterhead theme, not the console theme. */
export const DEFAULT_DOCUMENT_THEME = goldLetterhead.name;

function themeOf(theme?: Theme | string | null): Theme {
  if (theme && typeof theme === "object") return theme;
  return getTheme(theme ?? DEFAULT_DOCUMENT_THEME);
}

/** Brand source from an `agency_profiles` row plus the agency's display name. */
export function brandSourceFrom(
  profile: Partial<AgencyProfile> | null | undefined,
  agencyName?: string | null,
): AgencyBrandSource {
  return {
    name: agencyName ?? null,
    logo: profile?.logo ?? null,
    website: profile?.website ?? null,
    email: profile?.email ?? null,
    phone: profile?.phone ?? null,
    address: profile?.address ?? null,
    tagline: profile?.tagline ?? null,
    branding: profile?.branding ?? null,
    socialMedia: profile?.socialMedia ?? null,
  };
}

/** Client row (+ optional primary contact) → the "Billed to" / "Prepared for" block. */
export function clientPartyFrom(
  client: Pick<Client, "name" | "legalName" | "billingEmail"> & { address?: string | null },
  contact?: Pick<Contact, "firstName" | "lastName" | "email" | "phone"> | null,
): DocumentParty {
  const attention = contact
    ? [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || null
    : null;
  return {
    name: client.name?.trim() || "Client",
    legalName: client.legalName?.trim() || null,
    email: client.billingEmail?.trim() || contact?.email?.trim() || null,
    phone: contact?.phone?.trim() || null,
    addressLines: splitAddress(client.address ?? null),
    attention,
  };
}

function lineItemFrom(
  row: Pick<InvoiceLineItem, "description" | "quantity" | "unitPriceCents" | "totalCents"> & {
    cadence?: InvoiceLineItem["cadence"];
  },
): DocumentLineItem {
  return {
    description: row.description?.trim() || "Item",
    // Emitted explicitly (not left undefined) so the model survives a JSON
    // round-trip through `config_json` unchanged — see parse.ts.
    detail: null,
    quantity: Number.isFinite(row.quantity) ? row.quantity : 0,
    unitPriceCents: Math.trunc(row.unitPriceCents ?? 0),
    totalCents: Math.trunc(row.totalCents ?? 0),
    cadence: row.cadence,
  };
}

/**
 * Totals as recorded by the store. The stored figures are authoritative — they
 * are what the client was already told and what revenue recognition used — so
 * the mapper never silently recomputes them. Use
 * {@link checkTotalsConsistency} if you want to know they disagree with the
 * line items.
 */
function totalsFrom(
  source: { subtotalCents: number; taxCents: number; totalCents: number },
  taxLabel?: string | null,
): DocumentTotals {
  return {
    subtotalCents: Math.trunc(source.subtotalCents ?? 0),
    // The store has no discount column today; the field is emitted explicitly
    // (rather than left undefined) so a model survives a JSON round-trip
    // through `config_json` unchanged — see parse.ts.
    discountCents: 0,
    taxCents: Math.trunc(source.taxCents ?? 0),
    taxLabel: taxLabel ?? null,
    totalCents: Math.trunc(source.totalCents ?? 0),
  };
}

/**
 * Report whether stored totals agree with the line items, in cents. Returns an
 * empty array when everything reconciles. Callers can surface these as
 * warnings; the document still prints the stored figures either way.
 */
export function checkTotalsConsistency(
  totals: DocumentTotals,
  lineItems: readonly DocumentLineItem[],
): string[] {
  const problems: string[] = [];
  if (lineItems.length) {
    const itemSum = sumCents(
      lineItems.map((item) =>
        typeof item.totalCents === "number"
          ? item.totalCents
          : Math.round(item.quantity * item.unitPriceCents),
      ),
    );
    if (itemSum !== totals.subtotalCents) {
      problems.push(
        `line items sum to ${itemSum} cents but the stored subtotal is ${totals.subtotalCents} cents`,
      );
    }
  }
  const expected =
    totals.subtotalCents - Math.abs(totals.discountCents ?? 0) + (totals.taxCents ?? 0);
  if (expected !== totals.totalCents) {
    problems.push(
      `subtotal ${totals.subtotalCents} − discount ${totals.discountCents ?? 0} + tax ${
        totals.taxCents ?? 0
      } = ${expected} cents, but the stored total is ${totals.totalCents} cents`,
    );
  }
  return problems;
}

export interface BuildInvoiceModelInput {
  invoice: Invoice;
  client: Parameters<typeof clientPartyFrom>[0];
  lineItems?: ReadonlyArray<Parameters<typeof lineItemFrom>[0]>;
  payments?: ReadonlyArray<Pick<Payment, "amountCents" | "paidAt" | "method" | "reference">>;
  contact?: Parameters<typeof clientPartyFrom>[1];
  profile?: Partial<AgencyProfile> | null;
  /** Agency display name (the `agencies` row) — the profile has no name column. */
  agencyName?: string | null;
  /** Linked project names, shown in the document and mirrored to associations. */
  projects?: readonly string[];
  theme?: Theme | string | null;
  reference?: string | null;
  notes?: string | null;
  paymentTerms?: string | null;
  paymentLink?: { url?: string | null; label?: string | null } | null;
  bankDetails?: InvoiceBankDetails | null;
  taxLabel?: string | null;
  /** Reference instant for overdue/"due in N days". Defaults to now at build time. */
  asOf?: number;
}

export function buildInvoiceDocumentModel(input: BuildInvoiceModelInput): InvoiceDocumentModel {
  const theme = themeOf(input.theme);
  const currency = normalizeCurrency(input.invoice.currency);
  const lineItems = (input.lineItems ?? []).map(lineItemFrom);
  const payments: InvoicePaymentRecord[] = (input.payments ?? []).map((payment) => ({
    paidAt: payment.paidAt,
    amountCents: Math.trunc(payment.amountCents ?? 0),
    method: payment.method ?? null,
    reference: payment.reference ?? null,
  }));
  return {
    kind: "invoice",
    id: input.invoice.id,
    agencyId: input.invoice.agencyId,
    number: input.invoice.number?.trim() || input.invoice.id.slice(0, 8).toUpperCase(),
    status: input.invoice.status,
    currency,
    brand: resolveDocumentBrand(brandSourceFrom(input.profile, input.agencyName), theme),
    client: clientPartyFrom(input.client, input.contact),
    issuedAt: input.invoice.issuedAt,
    dueAt: input.invoice.dueAt,
    lineItems,
    totals: totalsFrom(input.invoice, input.taxLabel),
    amountPaidCents: Math.trunc(input.invoice.amountPaidCents ?? 0),
    payments,
    reference: input.reference ?? null,
    projects: [...(input.projects ?? [])],
    notes: input.notes ?? null,
    paymentTerms: input.paymentTerms ?? null,
    paymentLink: input.paymentLink ?? null,
    bankDetails: input.bankDetails ?? null,
    asOf: input.asOf ?? Date.now(),
  };
}

export interface BuildProposalModelInput {
  proposal: Proposal;
  client: Parameters<typeof clientPartyFrom>[0];
  contact?: Parameters<typeof clientPartyFrom>[1];
  profile?: Partial<AgencyProfile> | null;
  agencyName?: string | null;
  theme?: Theme | string | null;
  /** Human-facing reference; defaults to a short form of the proposal id. */
  number?: string | null;
  summary?: string | null;
  sections?: ProposalSection[];
  acceptanceTerms?: string[];
  signature?: { agencySignatory?: string | null; clientSignatory?: string | null } | null;
  notes?: string | null;
  taxLabel?: string | null;
  asOf?: number;
}

export function buildProposalDocumentModel(input: BuildProposalModelInput): ProposalDocumentModel {
  const theme = themeOf(input.theme);
  const currency = normalizeCurrency(input.proposal.currency);
  const lineItems = (input.proposal.lineItems ?? []).map(lineItemFrom);
  return {
    kind: "proposal",
    id: input.proposal.id,
    agencyId: input.proposal.agencyId,
    number: input.number?.trim() || `P-${input.proposal.id.slice(0, 8).toUpperCase()}`,
    title: input.proposal.title?.trim() || "Proposal",
    status: input.proposal.status,
    currency,
    brand: resolveDocumentBrand(brandSourceFrom(input.profile, input.agencyName), theme),
    client: clientPartyFrom(input.client, input.contact),
    summary: input.summary ?? null,
    scope: input.proposal.scope ?? "",
    sections: input.sections ?? [],
    lineItems,
    totals: totalsFrom(input.proposal, input.taxLabel),
    preparedAt: input.proposal.createdAt ?? null,
    validUntil: input.proposal.validUntil,
    acceptanceTerms: input.acceptanceTerms,
    signature: input.signature ?? null,
    notes: input.notes ?? null,
    asOf: input.asOf ?? Date.now(),
  };
}
