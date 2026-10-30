/**
 * Defensive normalisation of a document model that arrived as untrusted JSON.
 *
 * `report.config.document` crosses two trust boundaries before it reaches a
 * template: an RPC caller wrote it, and it was round-tripped through
 * `config_json` in SQLite. Escaping (documents/html.ts) makes the *content*
 * safe to render; this module makes the *shape* safe, so a malformed payload
 * produces a slightly empty document instead of a `TypeError` that fails the
 * report row.
 *
 * Numbers are coerced with `Math.trunc`, never `parseFloat` into a float total:
 * a cents field that arrives as `"1999.7"` becomes 1999 cents, not a fractional
 * cent that would poison every downstream sum.
 */

import type { Theme } from "../types.js";
import { resolveDocumentBrand, type AgencyBrandSource } from "./brand.js";
import { normalizeCurrency } from "./money.js";
import type {
  DocumentBrand,
  DocumentLineItem,
  DocumentParty,
  DocumentTotals,
  InvoiceDocumentModel,
  InvoiceDocumentStatus,
  InvoicePaymentRecord,
  ProposalDocumentModel,
  ProposalDocumentStatus,
  ProposalSection,
} from "./types.js";

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optStr(value: unknown): string | null {
  const text = str(value);
  return text ? text : null;
}

/** Integer cents. Rejects NaN/Infinity and truncates fractional input. */
function cents(value: unknown, fallback = 0): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/** A quantity may legitimately be fractional (7.5 hours). */
function quantity(value: unknown): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : 0;
}

function epoch(value: unknown): number | null {
  const num = typeof value === "number" ? value : NaN;
  return Number.isFinite(num) ? num : null;
}

function stringList(value: unknown, max = 40): string[] {
  return arr(value)
    .map((entry) => str(entry))
    .filter(Boolean)
    .slice(0, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = str(value);
  return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

const INVOICE_STATUSES: readonly InvoiceDocumentStatus[] = [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "overdue",
  "void",
];

const PROPOSAL_STATUSES: readonly ProposalDocumentStatus[] = [
  "draft",
  "internal_review",
  "sent",
  "accepted",
  "rejected",
  "expired",
];

const CADENCES = ["one_time", "monthly", "quarterly", "annual"] as const;

/** Hard cap so a hostile or runaway payload cannot produce a thousand-page PDF. */
export const MAX_LINE_ITEMS = 250;

function parseParty(value: unknown): DocumentParty {
  const source = obj(value);
  return {
    name: str(source.name, "Client"),
    legalName: optStr(source.legalName),
    email: optStr(source.email),
    phone: optStr(source.phone),
    addressLines: stringList(source.addressLines, 6),
    attention: optStr(source.attention),
  };
}

function parseLineItems(value: unknown): DocumentLineItem[] {
  return arr(value)
    .slice(0, MAX_LINE_ITEMS)
    .map((entry): DocumentLineItem => {
      const source = obj(entry);
      const item: DocumentLineItem = {
        description: str(source.description, "Item"),
        detail: optStr(source.detail),
        quantity: quantity(source.quantity),
        unitPriceCents: cents(source.unitPriceCents),
        cadence: oneOf(source.cadence, CADENCES, "one_time"),
      };
      if (source.totalCents !== undefined && source.totalCents !== null) {
        item.totalCents = cents(source.totalCents);
      }
      return item;
    });
}

function parseTotals(value: unknown): DocumentTotals {
  const source = obj(value);
  return {
    subtotalCents: cents(source.subtotalCents),
    discountCents: cents(source.discountCents),
    taxCents: cents(source.taxCents),
    taxLabel: optStr(source.taxLabel),
    totalCents: cents(source.totalCents),
  };
}

/**
 * Resolve the brand for a document.
 *
 * `config.brandSource` (raw `agency_profiles` fields) wins when present, because
 * it lets the brand be re-layered against the report row's *own* theme at
 * render time. Otherwise the already-resolved `document.brand` is reused, with
 * a theme-derived default filling anything missing.
 */
function parseBrand(document: Json, config: Json, theme: Theme): DocumentBrand {
  const brandSource = config.brandSource ?? document.brandSource;
  if (brandSource && typeof brandSource === "object") {
    return resolveDocumentBrand(brandSource as AgencyBrandSource, theme);
  }
  const stored = obj(document.brand);
  const fallback = resolveDocumentBrand(null, theme, str(stored.name, "Your Agency"));
  const colors = obj(stored.colors);
  return {
    name: str(stored.name, fallback.name),
    tagline: optStr(stored.tagline),
    logoDataUri:
      typeof stored.logoDataUri === "string" && stored.logoDataUri.startsWith("data:image/")
        ? stored.logoDataUri
        : null,
    monogram: str(stored.monogram, fallback.monogram).slice(0, 3),
    email: optStr(stored.email),
    phone: optStr(stored.phone),
    website: optStr(stored.website),
    addressLines: stringList(stored.addressLines, 5),
    // Route stored colours back through the validator — they may have been
    // hand-edited in config_json since they were resolved.
    colors: resolveDocumentBrand(
      {
        branding: {
          bg: colors.bg,
          surface: colors.surface,
          surfaceAlt: colors.surfaceAlt,
          border: colors.border,
          text: colors.text,
          textMuted: colors.textMuted,
          accent: colors.accent,
          accentStrong: colors.accentStrong,
        },
      },
      theme,
    ).colors,
    footerNote: optStr(stored.footerNote),
  };
}

function parsePayments(value: unknown): InvoicePaymentRecord[] {
  return arr(value)
    .slice(0, 100)
    .map((entry): InvoicePaymentRecord => {
      const source = obj(entry);
      return {
        paidAt: epoch(source.paidAt) ?? 0,
        amountCents: cents(source.amountCents),
        method: optStr(source.method),
        reference: optStr(source.reference),
      };
    });
}

function parseSections(value: unknown): ProposalSection[] {
  return arr(value)
    .slice(0, 20)
    .map((entry) => {
      const source = obj(entry);
      return { heading: str(source.heading, "Section"), body: str(source.body) };
    })
    .filter((section) => !!section.body);
}

/** Normalise `report.config` into a render-ready invoice model. */
export function parseInvoiceDocument(
  config: Json,
  theme: Theme,
  now: number,
): InvoiceDocumentModel {
  const document = obj(config.document);
  const paymentLink = obj(document.paymentLink);
  return {
    kind: "invoice",
    id: str(document.id, ""),
    agencyId: str(document.agencyId, "default"),
    number: str(document.number, "DRAFT"),
    status: oneOf(document.status, INVOICE_STATUSES, "draft"),
    currency: normalizeCurrency(str(document.currency, "USD")),
    brand: parseBrand(document, config, theme),
    client: parseParty(document.client),
    issuedAt: epoch(document.issuedAt),
    dueAt: epoch(document.dueAt),
    lineItems: parseLineItems(document.lineItems),
    totals: parseTotals(document.totals),
    amountPaidCents: cents(document.amountPaidCents),
    payments: parsePayments(document.payments),
    reference: optStr(document.reference),
    projects: stringList(document.projects, 20),
    notes: optStr(document.notes),
    paymentTerms: optStr(document.paymentTerms),
    paymentLink: { url: optStr(paymentLink.url), label: optStr(paymentLink.label) },
    asOf: epoch(document.asOf) ?? now,
  };
}

/** Normalise `report.config` into a render-ready proposal model. */
export function parseProposalDocument(
  config: Json,
  theme: Theme,
  now: number,
): ProposalDocumentModel {
  const document = obj(config.document);
  const signature = obj(document.signature);
  return {
    kind: "proposal",
    id: str(document.id, ""),
    agencyId: str(document.agencyId, "default"),
    number: str(document.number, "DRAFT"),
    title: str(document.title, "Proposal"),
    status: oneOf(document.status, PROPOSAL_STATUSES, "draft"),
    currency: normalizeCurrency(str(document.currency, "USD")),
    brand: parseBrand(document, config, theme),
    client: parseParty(document.client),
    summary: optStr(document.summary),
    scope: str(document.scope),
    sections: parseSections(document.sections),
    lineItems: parseLineItems(document.lineItems),
    totals: parseTotals(document.totals),
    preparedAt: epoch(document.preparedAt),
    validUntil: epoch(document.validUntil),
    acceptanceTerms: stringList(document.acceptanceTerms, 12),
    signature: {
      agencySignatory: optStr(signature.agencySignatory),
      clientSignatory: optStr(signature.clientSignatory),
    },
    notes: optStr(document.notes),
    asOf: epoch(document.asOf) ?? now,
  };
}
