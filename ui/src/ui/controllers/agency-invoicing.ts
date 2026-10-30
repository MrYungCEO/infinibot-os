/**
 * Invoice authoring, backlogging and per-client revenue.
 *
 * The agency could import invoices and mark them paid, but it could not *write*
 * one: there was no create path at all, and the only payment control paid the
 * whole balance. This module adds the missing half — compose an invoice, date
 * it anywhere in the past, preview the branded document, render the PDF, and
 * read one client's invoice and income history back.
 *
 * Two rules shape everything below.
 *
 * **Money is integer cents.** Operator input arrives as text and is parsed by
 * string manipulation into a scaled integer. No `parseFloat` on a price, no
 * `toFixed` used as arithmetic, no float ever load-bearing in a total. A
 * quantity is carried as thousandths so `2.5 × $19.99` is
 * `round(2500 × 1999 / 1000)` — an exact integer product before a single
 * rounding step, not `2.5 * 19.99 * 100`.
 *
 * **A call that this gateway build does not serve says so.** The authoring
 * RPCs land behind this UI, so every one of them is resolved against the
 * `hello-ok` method list before it is fired. When the native create path is
 * absent the composer falls back to `agency.ops.invoices.ingest`, which is
 * live today and accepts a fully structured invoice — so the owner can write
 * and backdate invoices now rather than after the next gateway deploy. Every
 * failure is recorded in the shared failed-request banner; nothing here can
 * leave a panel blank in a way that reads as "no data".
 */

import type { GatewayBrowserClient } from "../gateway";
import {
  ensureAgencyOperationsState,
  loadAgencyOperations,
  type AgencyInvoice,
  type AgencyOperationsHost,
  type AgencyOperationsState,
} from "./agency-operations";

export type InvoiceCadence = "one_time" | "monthly" | "quarterly" | "annual";

export const INVOICE_CADENCES: ReadonlyArray<{ id: InvoiceCadence; label: string }> = [
  { id: "one_time", label: "One-time" },
  { id: "monthly", label: "Monthly" },
  { id: "quarterly", label: "Quarterly" },
  { id: "annual", label: "Annual" },
];

/** Currencies offered in the picker. Any ISO code can still be typed. */
export const INVOICE_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "JPY",
  "CNY",
  "HKD",
  "SGD",
  "INR",
  "AED",
  "SAR",
  "ZAR",
  "NGN",
  "KES",
  "BRL",
  "MXN",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
] as const;

/**
 * A reusable agency-level bank / payment option, mirrored from the store's
 * `AgencyPaymentAccount`. UI-local so the controller carries no server import.
 */
export interface AgencyPaymentAccount {
  id: string;
  label: string;
  currency: string | null;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  iban: string | null;
  swift: string | null;
  routingNumber: string | null;
  instructions: string | null;
  isDefault: boolean;
}

/** Editable draft for the inline "add payment option" form. */
export interface PaymentAccountDraft {
  label: string;
  currency: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  swift: string;
  routingNumber: string;
  instructions: string;
}

export function emptyPaymentAccountDraft(): PaymentAccountDraft {
  return {
    label: "",
    currency: "",
    bankName: "",
    accountName: "",
    accountNumber: "",
    iban: "",
    swift: "",
    routingNumber: "",
    instructions: "",
  };
}

/** Candidate names for the payment-account RPCs, most likely first. */
const PAYMENT_ACCOUNT_METHODS = {
  list: ["agency.ops.payment-accounts.list"],
  upsert: ["agency.ops.payment-accounts.upsert"],
  delete: ["agency.ops.payment-accounts.delete"],
} as const;

function paymentAccountMethod(
  client: GatewayBrowserClient,
  capability: keyof typeof PAYMENT_ACCOUNT_METHODS,
): string | null {
  const advertised = client.serverMethods;
  if (!advertised) return null;
  return PAYMENT_ACCOUNT_METHODS[capability].find((name) => advertised.has(name)) ?? null;
}

/** Coerces an untyped RPC row into the UI payment-account shape. */
function toPaymentAccount(raw: unknown): AgencyPaymentAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.label !== "string") return null;
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    id: r.id,
    label: r.label,
    currency: str(r.currency),
    bankName: str(r.bankName),
    accountName: str(r.accountName),
    accountNumber: str(r.accountNumber),
    iban: str(r.iban),
    swift: str(r.swift),
    routingNumber: str(r.routingNumber),
    instructions: str(r.instructions),
    isDefault: r.isDefault === true,
  };
}

/* ------------------------------------------------------------------ *
 * Method resolution
 * ------------------------------------------------------------------ */

/**
 * Candidate names for each authoring RPC, most likely first.
 *
 * The engine work landed alongside this UI and the final names were not fixed
 * when it was written, so each capability is a list rather than a constant and
 * is matched against what the gateway actually advertised.
 */
const INVOICE_METHODS = {
  create: ["agency.ops.invoice.create", "agency.ops.invoices.create"],
  update: ["agency.ops.invoice.update", "agency.ops.invoices.update"],
  issue: ["agency.ops.invoice.issue", "agency.ops.invoices.issue"],
  voidInvoice: ["agency.ops.invoice.void", "agency.ops.invoices.void"],
  backlog: ["agency.ops.invoice.backlog.record", "agency.ops.invoices.backlog.record"],
  numberNext: ["agency.ops.invoice.number.next", "agency.ops.invoices.number.next"],
  preview: [
    "agency.ops.invoice.document.preview",
    "agency.ops.invoices.document.preview",
  ],
  render: ["agency.ops.invoice.document.render", "agency.ops.invoices.document.render"],
} as const;

export type InvoiceCapability = keyof typeof INVOICE_METHODS;

/**
 * The advertised name for a capability, or `null` when this gateway does not
 * serve it.
 *
 * Deliberately stricter than `client.supports()`: that returns `true` before
 * the handshake so a control is never hidden from a feature that does exist.
 * Here `null` selects a *working fallback* rather than hiding anything, so
 * "not known yet" must resolve the same way as "not served".
 */
export function invoiceMethod(
  client: GatewayBrowserClient,
  capability: InvoiceCapability,
): string | null {
  const advertised = client.serverMethods;
  if (!advertised) return null;
  return INVOICE_METHODS[capability].find((name) => advertised.has(name)) ?? null;
}

/** True once the gateway advertises a native create path. */
export function hasNativeInvoiceAuthoring(client: GatewayBrowserClient): boolean {
  return invoiceMethod(client, "create") !== null;
}

/* ------------------------------------------------------------------ *
 * Integer money
 * ------------------------------------------------------------------ */

/**
 * Parses decimal text into an integer scaled by `10 ** decimals`, entirely
 * through string manipulation.
 *
 * `parseScaled("19.99", 2) === 1999`. Returns `null` for anything that is not
 * a clean decimal or that carries more precision than the field allows, so an
 * unparseable price is a visible validation failure rather than a silent `NaN`
 * that lands in the ledger as zero.
 */
export function parseScaled(raw: string, decimals: number): number | null {
  const text = raw.trim().replace(/[\s,_]/g, "");
  if (!text) return null;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2] ?? "";
  const frac = match[3] ?? "";
  if (!whole && !frac) return null;
  if (frac.length > decimals) return null;
  const padded = `${frac}${"0".repeat(decimals)}`.slice(0, decimals);
  const digits = `${whole || "0"}${padded}`;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  return sign * value;
}

/** Decimal text → integer cents. `"1,250.50"` → `125050`. */
export function parseCents(raw: string): number | null {
  return parseScaled(raw, 2);
}

/** Integer cents → plain decimal text for an input value. Never arithmetic. */
export function centsToInput(cents: number): string {
  const negative = cents < 0;
  const digits = String(Math.abs(Math.trunc(cents))).padStart(3, "0");
  const text = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return negative ? `-${text}` : text;
}

/** Integer cents → localized currency, always with the minor unit shown. */
export function moneyCents(cents: number, currency = "USD"): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe / 100);
  } catch {
    // An operator-typed currency code that is not ISO 4217 must not throw the
    // whole panel away — show the number and the code as written.
    return `${centsToInput(safe)} ${currency}`;
  }
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

/** `yyyy-mm-dd` for a timestamp, in the operator's own timezone. */
export function isoDay(value: number = Date.now()): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * `yyyy-mm-dd` → local noon.
 *
 * Noon, not midnight: a backdated invoice keyed to midnight local time can
 * land in the previous day once the gateway re-reads it in UTC, which silently
 * moves a historical invoice into the wrong month. Midday is far from either
 * boundary in every real timezone.
 */
export function dayToTimestamp(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return null;
  const value = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0,
    0,
  ).getTime();
  return Number.isFinite(value) ? value : null;
}

/** Adds days to a `yyyy-mm-dd`, returning `yyyy-mm-dd`. */
export function shiftDay(day: string, days: number): string {
  const base = dayToTimestamp(day) ?? Date.now();
  return isoDay(base + days * 86_400_000);
}

/** Last day of the month `offset` months back from today. */
export function endOfMonthsAgo(offset: number): string {
  const now = new Date();
  return isoDay(new Date(now.getFullYear(), now.getMonth() - offset + 1, 0, 12).getTime());
}

/** True when the day is strictly before today — i.e. this is a backlog entry. */
export function isBackdated(day: string): boolean {
  const value = dayToTimestamp(day);
  return value !== null && value < dayToTimestamp(isoDay())!;
}

/** "March 2025" — the period a backdated document will be recorded into. */
export function describePeriod(day: string): string {
  const value = dayToTimestamp(day);
  if (value === null) return "an unknown period";
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(value);
}

/* ------------------------------------------------------------------ *
 * Composer state
 * ------------------------------------------------------------------ */

export interface InvoiceComposerLine {
  /** Stable local key so lit keeps input focus while lines are reordered. */
  key: string;
  description: string;
  /** Raw text; parsed to thousandths. */
  quantity: string;
  /** Raw text; parsed to cents. */
  unitPrice: string;
  cadence: InvoiceCadence;
}

export interface ClientRevenueDetail {
  clientId: string;
  clientName: string;
  currency: string;
  invoices: AgencyInvoice[];
  invoicedCents: number;
  collectedCents: number;
  outstandingCents: number;
  overdueCents: number;
  paidCount: number;
  openCount: number;
  overdueCount: number;
}

export interface AgencyInvoicingState {
  composerOpen: boolean;
  /** Set when re-opening a stored draft; `null` for a new invoice. */
  invoiceId: string | null;
  number: string;
  clientId: string;
  clientQuery: string;
  projectId: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  taxPercent: string;
  taxLabel: string;
  reference: string;
  notes: string;
  terms: string;
  /** Saved payment option attached to this invoice, or `""` for none. */
  paymentAccountId: string;
  /** Reusable agency payment options, loaded when the composer opens. */
  paymentAccounts: AgencyPaymentAccount[];
  paymentAccountsLoaded: boolean;
  /** Inline "add payment option" form state. */
  newAccountOpen: boolean;
  newAccount: PaymentAccountDraft;
  savingAccount: boolean;
  accountError: string | null;
  lines: InvoiceComposerLine[];
  /**
   * Money already received against a historical invoice, and when. Only ever
   * offered on a backlog entry — the whole point of backlogging is that the
   * payment happened too.
   */
  paidAmount: string;
  paidDate: string;
  saving: boolean;
  savedNotice: string | null;
  error: string | null;

  previewHtml: string | null;
  previewSummary: string | null;
  previewStatus: string | null;
  previewBalanceCents: number | null;
  previewWarnings: string[];
  previewLoading: boolean;
  previewError: string | null;
  /** Where the visible document came from, so the pane can never lie. */
  previewSource: "gateway" | "local";
  previewGeneration: number;

  rendering: boolean;
  renderedReportId: string | null;
  renderNotice: string | null;
  renderError: string | null;

  /** Per-invoice `paid at` drafts (`yyyy-mm-dd`), for backdated payments. */
  paymentDates: Record<string, string>;

  clientDetailId: string | null;
  clientDetail: ClientRevenueDetail | null;
  clientDetailLoading: boolean;
  clientDetailError: string | null;

  /**
   * In-progress MRR edits from the revenue modal, as plain decimal text keyed
   * by `client:<id>` / `project:<id>`. An absent key means "show the stored
   * value"; a present one means "the operator is editing this field".
   */
  mrrDrafts: Record<string, string>;
  /** The `client:<id>` / `project:<id>` currently being saved, or `null`. */
  mrrSavingId: string | null;
}

let lineKeySeed = 0;

function newLine(): InvoiceComposerLine {
  lineKeySeed += 1;
  return {
    key: `line-${lineKeySeed}`,
    description: "",
    quantity: "1",
    unitPrice: "",
    cadence: "one_time",
  };
}

export function createAgencyInvoicingState(): AgencyInvoicingState {
  const today = isoDay();
  return {
    composerOpen: false,
    invoiceId: null,
    number: "",
    clientId: "",
    clientQuery: "",
    projectId: "",
    currency: "USD",
    issueDate: today,
    dueDate: shiftDay(today, 30),
    taxPercent: "0",
    taxLabel: "Tax",
    reference: "",
    notes: "",
    terms: "",
    paymentAccountId: "",
    paymentAccounts: [],
    paymentAccountsLoaded: false,
    newAccountOpen: false,
    newAccount: emptyPaymentAccountDraft(),
    savingAccount: false,
    accountError: null,
    lines: [newLine()],
    paidAmount: "",
    paidDate: today,
    saving: false,
    savedNotice: null,
    error: null,
    previewHtml: null,
    previewSummary: null,
    previewStatus: null,
    previewBalanceCents: null,
    previewWarnings: [],
    previewLoading: false,
    previewError: null,
    previewSource: "local",
    previewGeneration: 0,
    rendering: false,
    renderedReportId: null,
    renderNotice: null,
    renderError: null,
    paymentDates: {},
    clientDetailId: null,
    clientDetail: null,
    clientDetailLoading: false,
    clientDetailError: null,
    mrrDrafts: {},
    mrrSavingId: null,
  };
}

export function invoicingState(host: AgencyOperationsHost): AgencyInvoicingState {
  const state = ensureAgencyOperationsState(host);
  state.invoicing ??= createAgencyInvoicingState();
  return state.invoicing;
}

function notify(host: AgencyOperationsHost): void {
  host.requestUpdate?.();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records a failed write on the shared banner as well as inline.
 *
 * Mirrors `recordMutationFailure` in the operations controller: an RPC this
 * build does not serve has to be visible as a named method, not as a control
 * that quietly did nothing.
 */
function recordFailure(
  state: AgencyOperationsState,
  method: string,
  error: unknown,
): void {
  const entry = `${method} — ${errorText(error)}`;
  if (!state.failedRequests.includes(entry)) {
    state.failedRequests = [...state.failedRequests, entry];
  }
}

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */

export interface InvoiceLineTotal {
  key: string;
  /** `null` when the line's own numbers do not parse. */
  totalCents: number | null;
  quantityValid: boolean;
  priceValid: boolean;
}

export interface InvoiceTotals {
  lines: InvoiceLineTotal[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Monthly-normalised recurring value, matching the engine's own rollup. */
  recurringMonthlyCents: number;
  taxValid: boolean;
  /** Lines that carry a description or a price but do not compute. */
  invalidLines: number;
  /** Lines with a description and a parsed price — what actually gets billed. */
  billableLines: number;
}

function monthlyEquivalent(totalCents: number, cadence: InvoiceCadence): number {
  if (cadence === "monthly") return totalCents;
  if (cadence === "quarterly") return Math.round(totalCents / 3);
  if (cadence === "annual") return Math.round(totalCents / 12);
  return 0;
}

/**
 * Subtotal, tax and total for a draft, in integer cents throughout.
 *
 * A line total is `round(quantityThousandths × unitPriceCents / 1000)`: the
 * multiplication is an exact integer product and there is exactly one rounding
 * step, so the printed line, the subtotal and the stored row always agree.
 */
export function computeInvoiceTotals(
  lines: readonly InvoiceComposerLine[],
  taxPercent: string,
): InvoiceTotals {
  const results: InvoiceLineTotal[] = [];
  let subtotalCents = 0;
  let recurringMonthlyCents = 0;
  let invalidLines = 0;
  let billableLines = 0;

  for (const line of lines) {
    const quantity = parseScaled(line.quantity, 3);
    const price = parseCents(line.unitPrice);
    const quantityValid = quantity !== null && quantity >= 0;
    const priceValid = price !== null;
    const touched =
      line.description.trim().length > 0 ||
      line.unitPrice.trim().length > 0 ||
      line.quantity.trim() !== "1";
    if (!quantityValid || !priceValid) {
      results.push({ key: line.key, totalCents: null, quantityValid, priceValid });
      if (touched) invalidLines += 1;
      continue;
    }
    const totalCents = Math.round((quantity * price) / 1000);
    results.push({ key: line.key, totalCents, quantityValid: true, priceValid: true });
    subtotalCents += totalCents;
    recurringMonthlyCents += monthlyEquivalent(totalCents, line.cadence);
    if (line.description.trim()) billableLines += 1;
    else if (touched) invalidLines += 1;
  }

  const taxBasisPoints = parseScaled(taxPercent || "0", 2);
  const taxValid = taxBasisPoints !== null && taxBasisPoints >= 0;
  const taxCents = taxValid ? Math.round((subtotalCents * taxBasisPoints) / 10_000) : 0;

  return {
    lines: results,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    recurringMonthlyCents,
    taxValid,
    invalidLines,
    billableLines,
  };
}

/** Human-readable reasons the draft cannot be saved yet. Empty means valid. */
export function invoiceDraftProblems(
  draft: AgencyInvoicingState,
  totals: InvoiceTotals,
): string[] {
  const problems: string[] = [];
  if (!draft.clientId) problems.push("Choose the client this invoice bills.");
  if (!draft.number.trim()) problems.push("Give the invoice a number.");
  if (totals.billableLines === 0) problems.push("Add at least one described line item.");
  if (totals.invalidLines > 0) {
    problems.push(
      `${totals.invalidLines} line item${totals.invalidLines === 1 ? "" : "s"} ${
        totals.invalidLines === 1 ? "has" : "have"
      } a description, quantity or price that does not parse.`,
    );
  }
  if (!totals.taxValid) problems.push("Tax percentage is not a number.");
  if (totals.totalCents <= 0) problems.push("Invoice total must be greater than zero.");
  if (dayToTimestamp(draft.issueDate) === null) problems.push("Issue date is not a valid date.");
  if (draft.dueDate && dayToTimestamp(draft.dueDate) === null) {
    problems.push("Due date is not a valid date.");
  }
  const issuedAt = dayToTimestamp(draft.issueDate);
  const dueAt = draft.dueDate ? dayToTimestamp(draft.dueDate) : null;
  if (issuedAt !== null && dueAt !== null && dueAt < issuedAt) {
    problems.push("Due date is before the issue date.");
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Composer actions
 * ------------------------------------------------------------------ */

/** Next unused invoice number, continuing whatever series is already stored. */
function suggestInvoiceNumber(state: AgencyOperationsState): string {
  const year = new Date().getFullYear();
  let highest = 0;
  for (const invoice of state.invoices) {
    const match = /(\d+)\s*$/.exec(invoice.number ?? "");
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `INV-${year}-${String(highest + 1).padStart(4, "0")}`;
}

export function openInvoiceComposer(
  host: AgencyOperationsHost,
  options: { clientId?: string; backdated?: boolean } = {},
): void {
  const state = ensureAgencyOperationsState(host);
  const fresh = createAgencyInvoicingState();
  const previous = state.invoicing;
  fresh.paymentDates = previous?.paymentDates ?? {};
  fresh.composerOpen = true;
  fresh.number = suggestInvoiceNumber(state);
  fresh.currency = state.revenue?.currency || state.finance.currency || "USD";
  fresh.clientId = options.clientId ?? "";
  fresh.terms =
    "Payment is due by the date shown above. Please quote the invoice number on the remittance.";
  if (options.backdated) {
    // Open a backlog entry already sitting in last month, so the operator is
    // recording history from the first keystroke instead of correcting today.
    fresh.issueDate = endOfMonthsAgo(1);
    fresh.dueDate = shiftDay(fresh.issueDate, 30);
    fresh.paidDate = fresh.issueDate;
  }
  state.invoicing = fresh;
  notify(host);
}

/**
 * Replaces the locally guessed invoice number with the one the gateway would
 * actually allocate, so the composer does not propose a number that collides
 * with a series the register has not loaded.
 */
export async function primeInvoiceNumber(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  const method = invoiceMethod(client, "numberNext");
  if (!method || !state.selectedAgencyId || !draft.composerOpen) return;
  try {
    const response = (await client.request(method, {
      agencyId: state.selectedAgencyId,
      issuedAt: dayToTimestamp(draft.issueDate) ?? undefined,
    })) as { number?: string };
    if (typeof response?.number === "string" && response.number && draft.composerOpen) {
      draft.number = response.number;
      notify(host);
      // The document was drawn from the locally guessed number moments ago.
      // Redraw it, or the preview prints a different invoice number to the one
      // in the field — which reads as two invoices.
      await refreshInvoicePreview(host, client);
    }
  } catch (error) {
    // A number the gateway would not confirm is not worth failing over — the
    // locally derived one still saves, and the write path reports any clash.
    recordFailure(state, method, error);
    notify(host);
  }
}

/**
 * Moves the issue date, carrying the payment window with it.
 *
 * Without this, backdating an invoice to last quarter leaves a due date in the
 * future, which then reads as "not yet due" on a historical invoice.
 */
export function setInvoiceIssueDate(host: AgencyOperationsHost, day: string): void {
  const draft = invoicingState(host);
  const previousIssue = dayToTimestamp(draft.issueDate);
  const previousDue = draft.dueDate ? dayToTimestamp(draft.dueDate) : null;
  draft.issueDate = day;
  if (previousIssue !== null && previousDue !== null) {
    const netDays = Math.round((previousDue - previousIssue) / 86_400_000);
    draft.dueDate = shiftDay(day, netDays);
  }
  // A historical payment defaults to the invoice's own date rather than today,
  // which is almost always closer to the truth and never silently books last
  // quarter's cash into this month.
  draft.paidDate = day;
  draft.savedNotice = null;
  notify(host);
}

export function closeInvoiceComposer(host: AgencyOperationsHost): void {
  const draft = invoicingState(host);
  draft.composerOpen = false;
  draft.savedNotice = null;
  notify(host);
}

/** Patches scalar composer fields, invalidating the preview that described them. */
export function patchInvoiceDraft(
  host: AgencyOperationsHost,
  patch: Partial<
    Pick<
      AgencyInvoicingState,
      | "number"
      | "clientId"
      | "clientQuery"
      | "projectId"
      | "currency"
      | "issueDate"
      | "dueDate"
      | "taxPercent"
      | "taxLabel"
      | "reference"
      | "notes"
      | "terms"
      | "paymentAccountId"
      | "paidAmount"
      | "paidDate"
    >
  >,
): void {
  const draft = invoicingState(host);
  Object.assign(draft, patch);
  draft.error = null;
  draft.savedNotice = null;
  notify(host);
}

/* ------------------------------------------------------------------ *
 * Payment options (reusable bank details)
 * ------------------------------------------------------------------ */

/**
 * Loads the agency's saved payment options into the open composer and
 * pre-selects the default one when the invoice does not already name an
 * account. A gateway that does not serve the list RPC just leaves the picker
 * empty with only the inline "add" affordance.
 */
export async function loadPaymentAccounts(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  const method = paymentAccountMethod(client, "list");
  if (!method || !state.selectedAgencyId) {
    draft.paymentAccountsLoaded = true;
    notify(host);
    return;
  }
  try {
    const response = (await client.request(method, { agencyId: state.selectedAgencyId })) as {
      accounts?: unknown[];
    };
    const accounts = Array.isArray(response?.accounts)
      ? response.accounts
          .map(toPaymentAccount)
          .filter((entry): entry is AgencyPaymentAccount => entry !== null)
      : [];
    draft.paymentAccounts = accounts;
    draft.paymentAccountsLoaded = true;
    // Only auto-pick a default for a brand-new invoice — never override a
    // stored draft's own selection when it is re-opened.
    if (!draft.paymentAccountId && !draft.invoiceId) {
      draft.paymentAccountId = accounts.find((account) => account.isDefault)?.id ?? "";
    }
  } catch (error) {
    recordFailure(state, method, error);
    draft.paymentAccountsLoaded = true;
  }
  notify(host);
}

/** Opens or closes the inline "add payment option" form. */
export function togglePaymentAccountForm(host: AgencyOperationsHost, open: boolean): void {
  const draft = invoicingState(host);
  draft.newAccountOpen = open;
  draft.accountError = null;
  if (open && !draft.newAccount.currency) {
    // Default the new account's currency to the invoice's own, the common case.
    draft.newAccount = { ...draft.newAccount, currency: draft.currency };
  }
  if (!open) draft.newAccount = emptyPaymentAccountDraft();
  notify(host);
}

/** Patches the inline add-account form. */
export function patchPaymentAccountDraft(
  host: AgencyOperationsHost,
  patch: Partial<PaymentAccountDraft>,
): void {
  const draft = invoicingState(host);
  draft.newAccount = { ...draft.newAccount, ...patch };
  draft.accountError = null;
  notify(host);
}

/**
 * Persists the inline add-account form through the upsert RPC, then selects the
 * newly saved option on the invoice.
 */
export async function savePaymentAccount(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  if (draft.savingAccount) return;
  const form = draft.newAccount;
  if (!form.label.trim()) {
    draft.accountError = "Give this payment option a label, e.g. “USD Wise”.";
    notify(host);
    return;
  }
  const method = paymentAccountMethod(client, "upsert");
  if (!method || !state.selectedAgencyId) {
    draft.accountError = "This gateway build does not serve payment-option saving yet.";
    notify(host);
    return;
  }
  draft.savingAccount = true;
  draft.accountError = null;
  notify(host);
  try {
    const response = (await client.request(method, {
      agencyId: state.selectedAgencyId,
      label: form.label.trim(),
      currency: form.currency.trim() || undefined,
      bankName: form.bankName.trim() || undefined,
      accountName: form.accountName.trim() || undefined,
      accountNumber: form.accountNumber.trim() || undefined,
      iban: form.iban.trim() || undefined,
      swift: form.swift.trim() || undefined,
      routingNumber: form.routingNumber.trim() || undefined,
      instructions: form.instructions.trim() || undefined,
    })) as { account?: unknown };
    const saved = toPaymentAccount(response?.account);
    if (saved) {
      draft.paymentAccounts = [saved, ...draft.paymentAccounts.filter((a) => a.id !== saved.id)];
      draft.paymentAccountId = saved.id;
    }
    draft.newAccountOpen = false;
    draft.newAccount = emptyPaymentAccountDraft();
    scheduleInvoicePreview(host, client);
  } catch (error) {
    draft.accountError = errorText(error);
    recordFailure(state, method, error);
  } finally {
    draft.savingAccount = false;
    notify(host);
  }
}

/** Deletes a saved payment option and clears it from the invoice if selected. */
export async function deletePaymentAccount(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  accountId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  const method = paymentAccountMethod(client, "delete");
  if (!method || !state.selectedAgencyId) return;
  try {
    await client.request(method, { agencyId: state.selectedAgencyId, id: accountId });
    draft.paymentAccounts = draft.paymentAccounts.filter((account) => account.id !== accountId);
    if (draft.paymentAccountId === accountId) {
      draft.paymentAccountId = "";
      scheduleInvoicePreview(host, client);
    }
  } catch (error) {
    recordFailure(state, method, error);
  }
  notify(host);
}

export function addInvoiceLine(host: AgencyOperationsHost): void {
  const draft = invoicingState(host);
  draft.lines = [...draft.lines, newLine()];
  notify(host);
}

export function removeInvoiceLine(host: AgencyOperationsHost, key: string): void {
  const draft = invoicingState(host);
  const remaining = draft.lines.filter((line) => line.key !== key);
  // Never leave the editor with no rows — an empty table reads as broken.
  draft.lines = remaining.length ? remaining : [newLine()];
  notify(host);
}

export function patchInvoiceLine(
  host: AgencyOperationsHost,
  key: string,
  patch: Partial<Omit<InvoiceComposerLine, "key">>,
): void {
  const draft = invoicingState(host);
  draft.lines = draft.lines.map((line) => (line.key === key ? { ...line, ...patch } : line));
  draft.savedNotice = null;
  notify(host);
}

export function moveInvoiceLine(
  host: AgencyOperationsHost,
  key: string,
  direction: -1 | 1,
): void {
  const draft = invoicingState(host);
  const index = draft.lines.findIndex((line) => line.key === key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= draft.lines.length) return;
  const lines = [...draft.lines];
  const [moved] = lines.splice(index, 1);
  lines.splice(target, 0, moved);
  draft.lines = lines;
  notify(host);
}

/* ------------------------------------------------------------------ *
 * Document payloads
 * ------------------------------------------------------------------ */

interface StructuredLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  cadence: InvoiceCadence;
}

/**
 * The draft as the engine's own structured-invoice shape.
 *
 * Amounts go out in major units because that is what the parser reads, but
 * they are produced *from* the integer cents (`cents / 100`), never
 * accumulated as decimals — the parser multiplies by 100 and rounds, so the
 * cents that arrive are byte-identical to the cents computed here.
 */
export function structuredInvoicePayload(
  draft: AgencyInvoicingState,
  totals: InvoiceTotals,
  state: AgencyOperationsState,
  options: { status: "draft" | "issued" },
): Record<string, unknown> {
  const clientName =
    state.clients.find((entry) => entry.id === draft.clientId)?.name ?? "Unknown client";
  const projectName = state.projects.find((entry) => entry.id === draft.projectId)?.name ?? null;
  const lineItems: StructuredLineItem[] = [];
  draft.lines.forEach((line, index) => {
    const computed = totals.lines[index];
    if (!computed || computed.totalCents === null || !line.description.trim()) return;
    const quantity = parseScaled(line.quantity, 3) ?? 1000;
    const unitPriceCents = parseCents(line.unitPrice) ?? 0;
    lineItems.push({
      description: line.description.trim(),
      quantity: quantity / 1000,
      unitPrice: unitPriceCents / 100,
      total: computed.totalCents / 100,
      cadence: line.cadence,
    });
  });
  return {
    invoiceNumber: draft.number.trim(),
    clientName,
    projectName,
    currency: draft.currency.trim().toUpperCase() || "USD",
    status: options.status,
    issuedAt: dayToTimestamp(draft.issueDate),
    dueAt: draft.dueDate ? dayToTimestamp(draft.dueDate) : null,
    subtotal: totals.subtotalCents / 100,
    tax: totals.taxCents / 100,
    total: totals.totalCents / 100,
    amountPaid: 0,
    reference: draft.reference.trim() || null,
    notes: draft.notes.trim() || null,
    terms: draft.terms.trim() || null,
    lineItems,
  };
}

/**
 * The draft in the shape `agency.ops.invoice.create` and
 * `agency.ops.invoice.backlog.record` read.
 *
 * Line totals are deliberately *not* sent: the engine recomputes
 * `quantity × unitPriceCents` itself and rejects fractional cents, so shipping
 * a second opinion on the total would only create a way for the two to
 * disagree. The composer's arithmetic is the same one rounding step, so the
 * printed preview and the stored row match.
 */
export function nativeInvoicePayload(
  draft: AgencyInvoicingState,
  totals: InvoiceTotals,
  state: AgencyOperationsState,
): Record<string, unknown> {
  const lineItems = draft.lines
    .map((line, index) => ({ line, computed: totals.lines[index] }))
    .filter(({ line, computed }) => computed?.totalCents !== null && line.description.trim())
    .map(({ line }) => ({
      description: line.description.trim(),
      quantity: (parseScaled(line.quantity, 3) ?? 1000) / 1000,
      unitPriceCents: parseCents(line.unitPrice) ?? 0,
      cadence: line.cadence,
    }));
  const dueAt = draft.dueDate ? dayToTimestamp(draft.dueDate) : null;
  return {
    agencyId: state.selectedAgencyId,
    clientId: draft.clientId,
    projectIds: draft.projectId ? [draft.projectId] : [],
    number: draft.number.trim() || undefined,
    currency: draft.currency.trim().toUpperCase() || "USD",
    issuedAt: dayToTimestamp(draft.issueDate) ?? undefined,
    dueAt: dueAt ?? undefined,
    taxCents: totals.taxCents,
    taxLabel: draft.taxLabel.trim() || undefined,
    reference: draft.reference.trim() || undefined,
    notes: draft.notes.trim() || undefined,
    terms: draft.terms.trim() || undefined,
    paymentAccountId: draft.paymentAccountId || undefined,
    lineItems,
  };
}

/** Historical payments captured on a backlog entry, if any. */
function backlogPayments(
  draft: AgencyInvoicingState,
  totals: InvoiceTotals,
): Array<{ amountCents: number; paidAt: number; method: string }> {
  const amountCents = parseCents(draft.paidAmount);
  const paidAt = dayToTimestamp(draft.paidDate);
  if (amountCents === null || amountCents <= 0 || paidAt === null) return [];
  return [
    { amountCents: Math.min(amountCents, totals.totalCents), paidAt, method: "historical" },
  ];
}

/* ------------------------------------------------------------------ *
 * Save
 * ------------------------------------------------------------------ */

function readId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  for (const key of ["invoice", "result", "created"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const id = (nested as Record<string, unknown>).id;
      if (typeof id === "string") return id;
      const deeper = (nested as Record<string, unknown>).invoice;
      if (deeper && typeof deeper === "object") {
        const deepId = (deeper as Record<string, unknown>).id;
        if (typeof deepId === "string") return deepId;
      }
    }
  }
  return null;
}

/**
 * Writes the draft, as a draft invoice or straight to issued.
 *
 * Prefers the native create RPC and falls back to the structured-ingest path
 * that ships today, so the composer is never a dead control. Which path ran is
 * reported back to the operator rather than hidden.
 */
export async function saveInvoiceDraft(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  options: { issue: boolean },
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  if (draft.saving || !state.selectedAgencyId) return;
  const totals = computeInvoiceTotals(draft.lines, draft.taxPercent);
  const problems = invoiceDraftProblems(draft, totals);
  if (problems.length) {
    draft.error = problems[0];
    notify(host);
    return;
  }

  draft.saving = true;
  draft.error = null;
  draft.savedNotice = null;
  notify(host);

  const status = options.issue ? "issued" : "draft";
  const createMethod = invoiceMethod(client, "create");
  const backlogMethod = invoiceMethod(client, "backlog");
  const backdated = isBackdated(draft.issueDate);
  const payments = backdated ? backlogPayments(draft, totals) : [];
  const payload = nativeInvoicePayload(draft, totals, state);
  // A backlog entry goes through the dedicated historical path when there is
  // one: it creates, issues and settles in a single transaction with every
  // date set to the historical instant, so nothing is recognised as having
  // been transacted today.
  const useBacklog = Boolean(backlogMethod) && backdated && options.issue;
  let method = useBacklog
    ? backlogMethod!
    : (createMethod ?? "agency.ops.invoices.ingest");

  try {
    let invoiceId: string | null = null;
    if (useBacklog) {
      const response = await client.request(backlogMethod!, { ...payload, payments });
      invoiceId = readId(response);
    } else if (createMethod) {
      const response = await client.request(createMethod, payload);
      invoiceId = readId(response);
      const issueMethod = invoiceMethod(client, "issue");
      if (options.issue && invoiceId) {
        if (!issueMethod) {
          throw new Error(
            "the invoice was created as a draft, but this gateway build does not serve agency.ops.invoice.issue",
          );
        }
        method = issueMethod;
        await client.request(issueMethod, {
          agencyId: state.selectedAgencyId,
          invoiceId,
          issuedAt: dayToTimestamp(draft.issueDate) ?? undefined,
          dueAt: draft.dueDate ? (dayToTimestamp(draft.dueDate) ?? undefined) : undefined,
        });
      }
    } else {
      // Compatibility path for a gateway older than the authoring RPCs. The
      // structured-ingest endpoint has shipped for far longer and stores the
      // same invoice, line items and revenue entries.
      const response = (await client.request("agency.ops.invoices.ingest", {
        agencyId: state.selectedAgencyId,
        structured: structuredInvoicePayload(draft, totals, state, { status }),
        clientId: draft.clientId,
        projectId: draft.projectId || undefined,
        sourceName: `composed:${draft.number.trim()}`,
        confirmWarnings: true,
      })) as { result?: { duplicate?: boolean; invoice?: { id?: string } } };
      if (response?.result?.duplicate) {
        throw new Error(
          `Invoice ${draft.number.trim()} already exists in this agency. Use a new number.`,
        );
      }
      invoiceId = response?.result?.invoice?.id ?? null;
    }

    draft.invoiceId = invoiceId;
    const label = draft.number.trim() || "the invoice";
    draft.savedNotice = options.issue
      ? `Issued ${label} for ${moneyCents(totals.totalCents, draft.currency)}.`
      : `Saved ${label} as a draft.`;
    if (backdated) draft.savedNotice += ` Recorded into ${describePeriod(draft.issueDate)}.`;
    if (payments.length) {
      draft.savedNotice += ` ${moneyCents(payments[0].amountCents, draft.currency)} logged as received on ${draft.paidDate}.`;
    }
    await loadAgencyOperations(host, client, { background: true });
    if (draft.clientDetailId) await loadClientRevenue(host, client, draft.clientDetailId);
    // The stored invoice now exists, so the branded renderer can describe it.
    await refreshInvoicePreview(host, client);
  } catch (error) {
    draft.error = errorText(error);
    recordFailure(state, method, error);
  } finally {
    draft.saving = false;
    notify(host);
  }
}

/** Voids a stored invoice, when the gateway serves a void path. */
export async function voidInvoice(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoiceId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const method = invoiceMethod(client, "voidInvoice");
  if (!method) {
    recordFailure(
      state,
      "agency.ops.invoice.void",
      new Error("this gateway build does not serve invoice voiding yet"),
    );
    notify(host);
    return;
  }
  state.secondaryBusyId = invoiceId;
  notify(host);
  try {
    await client.request(method, { agencyId: state.selectedAgencyId, invoiceId });
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    state.error = errorText(error);
    recordFailure(state, method, error);
  } finally {
    state.secondaryBusyId = null;
    notify(host);
  }
}

/* ------------------------------------------------------------------ *
 * Backdated payments
 * ------------------------------------------------------------------ */

export function setInvoicePaymentDate(
  host: AgencyOperationsHost,
  invoiceId: string,
  day: string,
): void {
  const draft = invoicingState(host);
  draft.paymentDates = { ...draft.paymentDates, [invoiceId]: day };
  notify(host);
}

/** The `paid at` day for an invoice, defaulting to today. */
export function invoicePaymentDate(host: AgencyOperationsHost, invoiceId: string): string {
  return invoicingState(host).paymentDates[invoiceId] ?? isoDay();
}

/* ------------------------------------------------------------------ *
 * Document preview and render
 * ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolves a theme token to a concrete colour.
 *
 * The preview is rendered inside a sandboxed iframe, which cannot inherit the
 * page's custom properties, so the values are resolved here and inlined.
 *
 * It has to go through a probe element rather than reading the property off
 * the root: several design tokens are declared as `color-mix(... var(--g-primary) ...)`,
 * and the raw declaration text still contains `var()` references that mean
 * nothing inside the iframe. Assigning it to `color` and reading the *computed*
 * value collapses the whole chain to an `rgb()` string. The literal arguments
 * are last-resort fallbacks for a document with no stylesheet attached — they
 * are not a second palette.
 */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = `position:absolute;left:-9999px;top:0;color:var(${name}, ${fallback})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value || fallback;
}

/**
/** The bank-details footer block for the local preview, from the attached account. */
function localBankDetailsHtml(draft: AgencyInvoicingState): string {
  const account = draft.paymentAccounts.find((entry) => entry.id === draft.paymentAccountId);
  if (!account) return "";
  const rows: Array<[string, string | null]> = [
    ["Bank", account.bankName],
    ["Account name", account.accountName],
    ["Account number", account.accountNumber],
    ["IBAN", account.iban],
    ["SWIFT/BIC", account.swift],
    ["Routing / sort code", account.routingNumber],
  ];
  const lines = rows
    .filter(([, value]) => !!value?.trim())
    .map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml((value ?? "").trim())}`);
  const instructions = account.instructions?.trim();
  if (instructions) lines.push(escapeHtml(instructions));
  const heading = account.label.trim()
    ? `Payment details — ${escapeHtml(account.label.trim())}`
    : "Payment details";
  if (!lines.length) return `<h4>${heading}</h4>`;
  return `<h4>${heading}</h4><p>${lines.join("<br />")}</p>`;
}

/**
 * A local rendering of the draft, used until the gateway serves the real
 * document renderer.
 *
 * This is explicitly labelled in the UI as an approximation. It exists so the
 * pane is never an empty rectangle that an operator could mistake for "this
 * invoice is blank" — the single failure mode this page has already suffered.
 */
export function localInvoiceDocument(
  draft: AgencyInvoicingState,
  totals: InvoiceTotals,
  state: AgencyOperationsState,
): string {
  const accent = token("--g-primary", "#8b5cf6");
  const ink = token("--g-fg", "#e4e4e7");
  const dim = token("--g-fg-dim", "#a1a1aa");
  const line = token("--g-border-strong", "rgba(255,255,255,0.22)");
  // The page background must be opaque: an iframe has nothing behind it, so a
  // translucent surface token would composite onto the browser's default white
  // and wash the whole document out.
  const paper = token("--g-bg", "#0b0b12");
  const agency = state.agencies.find((entry) => entry.id === state.selectedAgencyId);
  const clientName =
    state.clients.find((entry) => entry.id === draft.clientId)?.name ?? "No client selected";
  const projectName = state.projects.find((entry) => entry.id === draft.projectId)?.name ?? null;
  const currency = draft.currency || "USD";
  const rows = draft.lines
    .map((entry, index) => ({ entry, computed: totals.lines[index] }))
    .filter(({ entry }) => entry.description.trim() || entry.unitPrice.trim())
    .map(
      ({ entry, computed }) => `
        <tr>
          <td>
            ${escapeHtml(entry.description.trim() || "Untitled line item")}
            ${entry.cadence !== "one_time" ? `<span class="cadence">${escapeHtml(entry.cadence)}</span>` : ""}
          </td>
          <td class="num">${escapeHtml(entry.quantity.trim() || "1")}</td>
          <td class="num">${escapeHtml(
            parseCents(entry.unitPrice) === null
              ? "—"
              : moneyCents(parseCents(entry.unitPrice)!, currency),
          )}</td>
          <td class="num strong">${
            computed?.totalCents === null || computed === undefined
              ? "—"
              : escapeHtml(moneyCents(computed.totalCents, currency))
          }</td>
        </tr>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 30px 32px 36px;
    font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: ${ink}; background: ${paper};
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; color: ${accent}; }
  .agency { font-size: 15px; font-weight: 650; }
  .muted { color: ${dim}; font-size: 11.5px; }
  .meta { text-align: right; font-size: 11.5px; color: ${dim}; }
  .meta b { display: block; color: ${ink}; font-size: 13px; font-weight: 600; }
  .parties { display: flex; gap: 32px; margin: 26px 0 20px; }
  .parties section { flex: 1 1 0; min-width: 0; }
  .label { text-transform: uppercase; letter-spacing: 0.09em; font-size: 9.5px; color: ${dim}; margin-bottom: 5px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: ${dim};
       padding: 0 0 7px; border-bottom: 1px solid ${line}; }
  th.num, td.num { text-align: right; }
  td { padding: 9px 0; border-bottom: 1px solid ${line}; vertical-align: top; }
  td.strong { font-weight: 650; }
  .cadence { display: inline-block; margin-left: 7px; padding: 1px 7px; border-radius: 999px;
             border: 1px solid ${line}; font-size: 9.5px; color: ${dim}; text-transform: capitalize; }
  .totals { margin: 16px 0 0 auto; width: 260px; font-size: 12.5px; }
  .totals div { display: flex; justify-content: space-between; padding: 5px 0; }
  .totals .grand { border-top: 2px solid ${accent}; margin-top: 5px; padding-top: 9px;
                   font-size: 17px; font-weight: 700; color: ${accent}; }
  footer { margin-top: 26px; padding-top: 14px; border-top: 1px solid ${line}; font-size: 11px; color: ${dim}; }
  footer h4 { margin: 0 0 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em; color: ${ink}; }
</style></head><body>
  <header>
    <div>
      <div class="agency">${escapeHtml(agency?.name ?? "Your agency")}</div>
      <div class="muted">Invoice document</div>
    </div>
    <div class="meta">
      <h1>${escapeHtml(draft.number.trim() || "INV-DRAFT")}</h1>
      <b>${escapeHtml(draft.issueDate || "—")}</b>Issued
      <b>${escapeHtml(draft.dueDate || "On receipt")}</b>Due
      ${draft.reference.trim() ? `<b>${escapeHtml(draft.reference.trim())}</b>Reference` : ""}
    </div>
  </header>
  <div class="parties">
    <section><div class="label">Billed to</div><div class="agency">${escapeHtml(clientName)}</div>
      ${projectName ? `<div class="muted">${escapeHtml(projectName)}</div>` : ""}</section>
    <section><div class="label">Amount due</div>
      <div class="agency">${escapeHtml(moneyCents(totals.totalCents, currency))}</div>
      <div class="muted">${escapeHtml(currency)}</div></section>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="muted">No line items added yet.</td></tr>`}</tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${escapeHtml(moneyCents(totals.subtotalCents, currency))}</span></div>
    <div><span>${escapeHtml(draft.taxLabel.trim() || "Tax")} (${escapeHtml(draft.taxPercent || "0")}%)</span><span>${escapeHtml(moneyCents(totals.taxCents, currency))}</span></div>
    <div class="grand"><span>Total</span><span>${escapeHtml(moneyCents(totals.totalCents, currency))}</span></div>
  </div>
  <footer>
    ${localBankDetailsHtml(draft)}
    ${draft.terms.trim() ? `<h4>Terms</h4><p>${escapeHtml(draft.terms.trim())}</p>` : ""}
    ${draft.notes.trim() ? `<h4>Notes</h4><p>${escapeHtml(draft.notes.trim())}</p>` : ""}
  </footer>
</body></html>`;
}

let previewTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Refreshes the document preview, debounced against typing.
 *
 * When the gateway serves the document renderer its `html` is the same markup
 * the PDF is produced from, so it is shown verbatim; the `warnings` from its
 * totals-consistency check are surfaced next to it, never swallowed. Without
 * that RPC the pane falls back to a local rendering and says so.
 */
export function scheduleInvoicePreview(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  delayMs = 450,
): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void refreshInvoicePreview(host, client);
  }, delayMs);
}

export async function refreshInvoicePreview(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  if (!draft.composerOpen) return;
  const totals = computeInvoiceTotals(draft.lines, draft.taxPercent);
  const generation = ++draft.previewGeneration;

  const method = invoiceMethod(client, "preview");
  // The branded renderer describes a *stored* invoice — it takes an invoiceId,
  // not a draft. Until the invoice is saved the pane shows the local rendering
  // and says so, rather than firing a call that can only fail.
  if (!method || !state.selectedAgencyId || !draft.invoiceId) {
    draft.previewHtml = localInvoiceDocument(draft, totals, state);
    draft.previewSource = "local";
    draft.previewSummary = null;
    draft.previewStatus = null;
    draft.previewBalanceCents = totals.totalCents;
    draft.previewWarnings = [];
    draft.previewError = null;
    draft.previewLoading = false;
    notify(host);
    return;
  }

  draft.previewLoading = true;
  draft.previewError = null;
  notify(host);
  try {
    const response = (await client.request(method, {
      agencyId: state.selectedAgencyId,
      invoiceId: draft.invoiceId,
    })) as {
      html?: string;
      summaryText?: string;
      status?: string;
      balanceCents?: number;
      warnings?: string[];
    };
    if (generation !== draft.previewGeneration) return;
    if (typeof response?.html === "string" && response.html.trim()) {
      draft.previewHtml = response.html;
      draft.previewSource = "gateway";
    } else {
      // A response without markup is a broken renderer, not an empty invoice.
      draft.previewHtml = localInvoiceDocument(draft, totals, state);
      draft.previewSource = "local";
      draft.previewError = `${method} returned no document markup.`;
    }
    draft.previewSummary = response?.summaryText ?? null;
    draft.previewStatus = response?.status ?? null;
    draft.previewBalanceCents =
      typeof response?.balanceCents === "number" ? response.balanceCents : totals.totalCents;
    draft.previewWarnings = Array.isArray(response?.warnings)
      ? response.warnings.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch (error) {
    if (generation !== draft.previewGeneration) return;
    draft.previewHtml = localInvoiceDocument(draft, totals, state);
    draft.previewSource = "local";
    draft.previewError = errorText(error);
    recordFailure(state, method, error);
  } finally {
    if (generation === draft.previewGeneration) draft.previewLoading = false;
    notify(host);
  }
}

/** Produces the branded PDF through the reports system. */
export async function renderInvoiceDocument(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  const method = invoiceMethod(client, "render");
  draft.renderError = null;
  draft.renderNotice = null;
  if (!method) {
    draft.renderError =
      "This gateway build does not serve invoice PDF rendering yet. Save the invoice — the PDF can be produced once the gateway is updated.";
    notify(host);
    return;
  }
  if (!draft.invoiceId) {
    draft.renderError = "Save the invoice first — the PDF is rendered from the stored record.";
    notify(host);
    return;
  }
  draft.rendering = true;
  notify(host);
  try {
    // The PDF is rendered from the *stored* record, not from this composer's
    // live fields — so any edit made since the invoice was saved (most visibly
    // the due date) must be flushed to the store first, or the document prints
    // the previously-saved value. Presentation and date fields stay editable
    // after issue (`agency.ops.invoice.update` only guards money fields), so
    // this is safe on any non-void invoice. Best-effort: an older gateway that
    // does not serve the update method still renders the stored record.
    const updateMethod = invoiceMethod(client, "update");
    if (updateMethod) {
      const issuedAt = dayToTimestamp(draft.issueDate);
      const dueAt = draft.dueDate ? dayToTimestamp(draft.dueDate) : null;
      try {
        await client.request(updateMethod, {
          agencyId: state.selectedAgencyId,
          invoiceId: draft.invoiceId,
          ...(issuedAt !== null ? { issuedAt } : {}),
          dueAt,
          reference: draft.reference.trim() || null,
          notes: draft.notes.trim() || null,
          terms: draft.terms.trim() || null,
          taxLabel: draft.taxLabel.trim() || null,
          paymentAccountId: draft.paymentAccountId || null,
        });
      } catch (error) {
        // A failed flush must not silently print a stale document: surface it
        // and stop, rather than rendering the old due date as if nothing changed.
        draft.renderError = `Could not save the invoice before rendering, so the PDF was not produced (it would show the previously-saved details): ${errorText(error)}`;
        recordFailure(state, updateMethod, error);
        return;
      }
    }
    const response = (await client.request(method, {
      agencyId: state.selectedAgencyId,
      invoiceId: draft.invoiceId,
    })) as { reportId?: string; status?: string };
    draft.renderedReportId = response?.reportId ?? null;
    draft.renderNotice = response?.reportId
      ? `PDF queued as report ${response.reportId}${response.status ? ` (${response.status})` : ""}.`
      : "Render accepted, but the gateway did not return a report id.";
  } catch (error) {
    draft.renderError = errorText(error);
    recordFailure(state, method, error);
  } finally {
    draft.rendering = false;
    notify(host);
  }
}

/* ------------------------------------------------------------------ *
 * Per-client revenue
 * ------------------------------------------------------------------ */

const OPEN_STATUSES = new Set(["issued", "partially_paid", "overdue"]);

/** True when an invoice is past its due date with money still outstanding. */
export function isOverdue(invoice: AgencyInvoice, asOf = Date.now()): boolean {
  if (invoice.status === "overdue") return true;
  if (!OPEN_STATUSES.has(invoice.status)) return false;
  return invoice.balanceCents > 0 && invoice.dueAt !== null && invoice.dueAt < asOf;
}

function summarizeClientInvoices(
  clientId: string,
  clientName: string,
  currency: string,
  invoices: AgencyInvoice[],
): ClientRevenueDetail {
  let invoicedCents = 0;
  let collectedCents = 0;
  let outstandingCents = 0;
  let overdueCents = 0;
  let paidCount = 0;
  let openCount = 0;
  let overdueCount = 0;
  for (const invoice of invoices) {
    if (invoice.status === "void") continue;
    invoicedCents += invoice.totalCents;
    collectedCents += invoice.amountPaidCents;
    if (invoice.balanceCents > 0 && invoice.status !== "draft") {
      outstandingCents += invoice.balanceCents;
      openCount += 1;
      if (isOverdue(invoice)) {
        overdueCents += invoice.balanceCents;
        overdueCount += 1;
      }
    }
    if (invoice.status === "paid") paidCount += 1;
  }
  return {
    clientId,
    clientName,
    currency,
    invoices,
    invoicedCents,
    collectedCents,
    outstandingCents,
    overdueCents,
    paidCount,
    openCount,
    overdueCount,
  };
}

/**
 * Normalises a relations payload's invoices into the list shape the register
 * already renders, so one component draws both views.
 */
function normalizeInvoices(value: unknown, clientName: string): AgencyInvoice[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      id: String(entry.id ?? ""),
      clientId: String(entry.clientId ?? ""),
      clientName: typeof entry.clientName === "string" ? entry.clientName : clientName,
      number: String(entry.number ?? "—"),
      status: (entry.status as AgencyInvoice["status"]) ?? "draft",
      currency: typeof entry.currency === "string" ? entry.currency : "USD",
      totalCents: Number(entry.totalCents ?? 0),
      amountPaidCents: Number(entry.amountPaidCents ?? 0),
      balanceCents: Number(
        entry.balanceCents ?? Number(entry.totalCents ?? 0) - Number(entry.amountPaidCents ?? 0),
      ),
      issuedAt: typeof entry.issuedAt === "number" ? entry.issuedAt : null,
      dueAt: typeof entry.dueAt === "number" ? entry.dueAt : null,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
      lineItems: Array.isArray(entry.lineItems)
        ? (entry.lineItems as AgencyInvoice["lineItems"])
        : [],
      projects: Array.isArray(entry.projects) ? (entry.projects as AgencyInvoice["projects"]) : [],
    }))
    .filter((invoice) => invoice.id);
}

/**
 * Loads one client's invoices and income.
 *
 * Falls back to the already-loaded register when the relations RPC fails, and
 * says which of the two is on screen — a client with genuinely no invoices and
 * a client whose history we could not fetch must never look the same.
 */
export async function loadClientRevenue(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  clientId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  draft.clientDetailId = clientId;
  draft.clientDetailLoading = true;
  draft.clientDetailError = null;
  notify(host);

  const record = state.clients.find((entry) => entry.id === clientId);
  const clientName = record?.name ?? "Client";
  const currency = state.revenue?.currency || state.finance.currency || "USD";
  const method = "agency.ops.relations.client";
  try {
    const response = (await client.request(method, {
      agencyId: state.selectedAgencyId,
      clientId,
    })) as { invoices?: unknown; client?: { name?: string } };
    const invoices = normalizeInvoices(response?.invoices, clientName);
    draft.clientDetail = summarizeClientInvoices(
      clientId,
      response?.client?.name ?? clientName,
      currency,
      invoices,
    );
  } catch (error) {
    // Degrade to the register we already hold rather than showing nothing.
    const local = state.invoices.filter((invoice) => invoice.clientId === clientId);
    draft.clientDetail = summarizeClientInvoices(clientId, clientName, currency, local);
    draft.clientDetailError = errorText(error);
    recordFailure(state, method, error);
  } finally {
    draft.clientDetailLoading = false;
    notify(host);
  }
}

export function closeClientRevenue(host: AgencyOperationsHost): void {
  const draft = invoicingState(host);
  draft.clientDetailId = null;
  draft.clientDetail = null;
  draft.clientDetailError = null;
  notify(host);
}

/* ------------------------------------------------------------------ *
 * Manual MRR (monthly recurring revenue)
 * ------------------------------------------------------------------ */

/** The editing MRR text for a field, defaulting to the stored value. */
export function mrrDraftValue(
  host: AgencyOperationsHost,
  key: string,
  storedCents: number,
): string {
  const draft = invoicingState(host);
  const held = draft.mrrDrafts[key];
  return held === undefined ? centsToInput(storedCents) : held;
}

/** Record an in-progress MRR edit without firing a save. */
export function setMrrDraft(host: AgencyOperationsHost, key: string, value: string): void {
  const draft = invoicingState(host);
  draft.mrrDrafts = { ...draft.mrrDrafts, [key]: value };
  notify(host);
}

/** Persist a client's manually-set MRR, then refresh the loaded data. */
export async function saveClientMrr(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  clientId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  if (!state.selectedAgencyId || draft.mrrSavingId) return;
  const key = `client:${clientId}`;
  const record = state.clients.find((entry) => entry.id === clientId);
  const raw = draft.mrrDrafts[key];
  const cents = raw === undefined ? record?.mrrCents ?? 0 : parseCents(raw);
  if (cents === null || cents < 0) {
    state.error = "Enter a valid, non-negative MRR amount.";
    notify(host);
    return;
  }
  const method = "agency.ops.client.mrr.set";
  draft.mrrSavingId = key;
  state.error = null;
  notify(host);
  try {
    await client.request(method, {
      agencyId: state.selectedAgencyId,
      clientId,
      mrrCents: cents,
    });
    const { [key]: _cleared, ...rest } = draft.mrrDrafts;
    draft.mrrDrafts = rest;
    await loadAgencyOperations(host, client, { background: true });
    await loadClientRevenue(host, client, clientId);
  } catch (error) {
    state.error = errorText(error);
    recordFailure(state, method, error);
  } finally {
    draft.mrrSavingId = null;
    notify(host);
  }
}

/** Persist a project's manually-set MRR, then refresh the loaded data. */
export async function saveProjectMrr(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  projectId: string,
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const draft = invoicingState(host);
  if (!state.selectedAgencyId || draft.mrrSavingId) return;
  const key = `project:${projectId}`;
  const record = state.projects.find((entry) => entry.id === projectId);
  const raw = draft.mrrDrafts[key];
  const cents = raw === undefined ? record?.mrrCents ?? 0 : parseCents(raw);
  if (cents === null || cents < 0) {
    state.error = "Enter a valid, non-negative MRR amount.";
    notify(host);
    return;
  }
  const method = "agency.ops.project.mrr.set";
  draft.mrrSavingId = key;
  state.error = null;
  notify(host);
  try {
    await client.request(method, {
      agencyId: state.selectedAgencyId,
      projectId,
      mrrCents: cents,
    });
    const { [key]: _cleared, ...rest } = draft.mrrDrafts;
    draft.mrrDrafts = rest;
    await loadAgencyOperations(host, client, { background: true });
  } catch (error) {
    state.error = errorText(error);
    recordFailure(state, method, error);
  } finally {
    draft.mrrSavingId = null;
    notify(host);
  }
}
