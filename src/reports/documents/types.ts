/**
 * Typed models for client-facing documents (invoices, proposals).
 *
 * These are *presentation* models: everything a template needs, already
 * resolved, with no dependency on `agency-operations` or SQLite. `mapper.ts`
 * builds them from store rows; the report worker receives them as plain JSON in
 * `report.config.document`, which is what keeps the worker process free of any
 * agency-store handle (it must never open `agency.db`).
 *
 * Because the model is JSON-serializable end-to-end, `reports.generate` with
 * `{ kind: "agency_invoice", config: { document } }` is all the wiring the
 * gateway needs — no new render path.
 */

/**
 * Resolved, render-ready branding sourced from `agency_profiles`, layered on
 * top of a report {@link Theme}. Produced by `resolveDocumentBrand()`; never
 * partial, so templates never have to null-check.
 */
export interface DocumentBrand {
  /** Agency display name. Falls back to a generic label, never empty. */
  name: string;
  tagline: string | null;
  /** `data:` image URI only — remote logos are dropped so rendering stays offline. */
  logoDataUri: string | null;
  /** Up to two initials, used when no logo is embeddable. */
  monogram: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** Postal address, already split into display lines. */
  addressLines: string[];
  /** Theme tokens with any `branding_json` colour overrides applied. */
  colors: DocumentBrandColors;
  /** Free-form footer note (registration number, bank details header, ...). */
  footerNote: string | null;
}

export interface DocumentBrandColors {
  /** Page background. */
  bg: string;
  /** Panel background. */
  surface: string;
  /** Zebra / secondary panel background. */
  surfaceAlt: string;
  /** Hairline rules. */
  border: string;
  /** Body text. */
  text: string;
  /** De-emphasised labels. */
  textMuted: string;
  /** Primary brand accent (headings, rules, total emphasis). */
  accent: string;
  /** Deeper accent for strong emphasis. */
  accentStrong: string;
  fontHeading: string;
  fontBody: string;
}

export interface DocumentParty {
  name: string;
  /** Registered/legal entity name, shown under the display name. */
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLines?: string[];
  /** Named contact ("Attn: Dana Cole"). */
  attention?: string | null;
}

export interface DocumentLineItem {
  description: string;
  /** Optional second line under the description. */
  detail?: string | null;
  quantity: number;
  unitPriceCents: number;
  /**
   * Line total in cents. Optional — omitted means the renderer computes
   * `round(quantity * unitPriceCents)`. Supplying it lets historical stored
   * rows round-trip byte-exactly even if they were rounded differently.
   */
  totalCents?: number;
  /** Billing cadence badge; `one_time` renders no badge. */
  cadence?: "one_time" | "monthly" | "quarterly" | "annual";
}

export interface DocumentTotals {
  subtotalCents: number;
  /** Positive discount amount, subtracted from the subtotal. */
  discountCents?: number;
  taxCents?: number;
  /** Label beside the tax row, e.g. "VAT 20%". */
  taxLabel?: string | null;
  totalCents: number;
}

export type InvoiceDocumentStatus =
  | "draft"
  | "issued"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "void";

export interface InvoicePaymentRecord {
  paidAt: number;
  amountCents: number;
  method?: string | null;
  reference?: string | null;
}

/**
 * Where the client sends money — a saved agency payment option, rendered as a
 * labelled block of bank details on the document. Every field is optional so a
 * partially-filled account still prints cleanly.
 */
export interface InvoiceBankDetails {
  /** e.g. "USD Wise" / "GBP Barclays". */
  label?: string | null;
  bankName?: string | null;
  accountName?: string | null;
  accountNumber?: string | null;
  iban?: string | null;
  swift?: string | null;
  /** Routing / sort code. */
  routingNumber?: string | null;
  /** Free-form extra instructions. */
  instructions?: string | null;
}

export interface InvoiceDocumentModel {
  kind: "invoice";
  /** Source invoice id — becomes the report row's `sourceRecordId`. */
  id: string;
  agencyId: string;
  number: string;
  status: InvoiceDocumentStatus;
  currency: string;
  brand: DocumentBrand;
  client: DocumentParty;
  issuedAt: number | null;
  dueAt: number | null;
  lineItems: DocumentLineItem[];
  totals: DocumentTotals;
  amountPaidCents: number;
  payments?: InvoicePaymentRecord[];
  /** Purchase-order / external reference shown in the meta block. */
  reference?: string | null;
  /** Linked project names (also mirrored into the report association columns). */
  projects?: string[];
  notes?: string | null;
  /** Terms paragraph printed above the footer. */
  paymentTerms?: string | null;
  /**
   * Where the client pays. `url` is optional: without it the button renders as
   * a neutral placeholder so the layout is identical either way.
   */
  paymentLink?: { url?: string | null; label?: string | null } | null;
  /** Saved bank / payment option details, printed under the payment callout. */
  bankDetails?: InvoiceBankDetails | null;
  /**
   * Reference instant for "overdue" and "due in N days". Supplied explicitly —
   * the renderer never calls `Date.now()` — so output is deterministic.
   */
  asOf: number;
}

export type ProposalDocumentStatus =
  | "draft"
  | "internal_review"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired";

export interface ProposalSection {
  heading: string;
  /** Prose; blank lines become paragraphs, "- " lines become bullets. */
  body: string;
}

export interface ProposalDocumentModel {
  kind: "proposal";
  /** Source proposal id — becomes the report row's `sourceRecordId`. */
  id: string;
  agencyId: string;
  /** Human-facing reference; the mapper falls back to a short id. */
  number: string;
  title: string;
  status: ProposalDocumentStatus;
  currency: string;
  brand: DocumentBrand;
  client: DocumentParty;
  /** One-paragraph executive summary above the scope. */
  summary?: string | null;
  /** Main scope-of-work prose. */
  scope: string;
  /** Extra prose sections (timeline, assumptions, exclusions...). */
  sections?: ProposalSection[];
  lineItems: DocumentLineItem[];
  totals: DocumentTotals;
  preparedAt: number | null;
  validUntil: number | null;
  /** Bullet list of acceptance terms. */
  acceptanceTerms?: string[];
  /** Signature block labels. */
  signature?: { agencySignatory?: string | null; clientSignatory?: string | null } | null;
  notes?: string | null;
  asOf: number;
}

export type AgencyDocumentModel = InvoiceDocumentModel | ProposalDocumentModel;

/** Report kind ids registered by this module. */
export const INVOICE_REPORT_KIND = "agency_invoice";
export const PROPOSAL_REPORT_KIND = "agency_proposal";
