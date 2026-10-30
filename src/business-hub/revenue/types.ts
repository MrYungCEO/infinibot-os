/**
 * Business hub revenue — shared types for the ledger (`revenue_txns`),
 * subscriptions and products, plus tiny accessors for untyped provider JSON.
 *
 * Amount convention: every `*Cents` value is in minor units. Refund and
 * dispute rows store the positive magnitude in `grossCents`; their
 * `netCents` is the negative impact (-gross). Charges keep `netCents` =
 * gross - fee (provider net when known).
 */

export type RevenueProvider = "whop" | "stripe" | "legacy" | "invoice" | "manual";
export type TxnType = "charge" | "refund" | "dispute" | "fee" | "payout" | "invoice";

/** Charge statuses that represent money actually received. */
export const REVENUE_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "refunded",
  "partially_refunded",
]);

/** Billing reasons that mark a charge as recurring (MRR fallback). */
export const RECURRING_REASONS: ReadonlySet<string> = new Set([
  "subscription_cycle",
  "subscription_create",
  "subscription_update",
  "subscription",
  "renewal",
]);

export type LedgerRow = {
  externalId: string;
  type: TxnType;
  status: string;
  grossCents: number;
  feeCents: number;
  netCents: number;
  refundedCents: number;
  currency: string;
  amountUsdCents: number | null;
  occurredAt: number;
  productId: string | null;
  productName: string | null;
  planId: string | null;
  billingReason: string | null;
  customerRef: string | null;
  customerEmail: string | null;
  customerName: string | null;
  subscriptionRef: string | null;
  parentExternalId: string | null;
  raw: unknown;
};

export type SubInterval = "day" | "week" | "month" | "year";

export type SubscriptionRow = {
  externalId: string;
  status: string;
  productId: string | null;
  productName: string | null;
  planId: string | null;
  interval: SubInterval | null;
  intervalCount: number;
  amountCents: number;
  currency: string;
  customerRef: string | null;
  customerEmail: string | null;
  startedAt: number | null;
  canceledAt: number | null;
  currentPeriodEnd: number | null;
  raw: unknown;
};

export type ProductRow = { externalId: string; name: string; raw: unknown };

export type NormalizedBatch = {
  txns: LedgerRow[];
  subs: SubscriptionRow[];
  products: ProductRow[];
};

export function emptyBatch(): NormalizedBatch {
  return { txns: [], subs: [], products: [] };
}

/** A ledger row as stored (what `onPayment` and the ledger RPC receive). */
export type LedgerTxn = LedgerRow & {
  id: string;
  accountId: string;
  provider: string;
  contactId: string | null;
  clientId: string | null;
  companyId: string | null;
  projectId: string | null;
  dealId: string | null;
  campaignId: string | null;
  invoiceId: string | null;
};

// ── Untyped JSON accessors ────────────────────────────────────────────────────

export type Json = Record<string, unknown>;

export function rec(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function s(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function n(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Major units (12.34) → minor units (1234). */
export function majorToCents(v: unknown): number | null {
  const x = n(v);
  return x === null ? null : Math.round(x * 100);
}

/** ISO string or unix seconds/ms → epoch ms. */
export function timeMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    if (/^\d{9,10}$/.test(v.trim())) return Number(v) * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function upperCurrency(v: unknown): string {
  return (s(v) ?? "USD").toUpperCase();
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Sync object specs (implemented per provider in whop.ts / stripe.ts) ───────

export type SyncMode = "backfill" | "incremental";

/** What a plan / price tells us (Whop plans are stored as product rows, kind "plan"). */
export type PlanInfo = {
  productId: string | null;
  productName: string | null;
  interval: SubInterval | null;
  intervalCount: number;
  renewalCents: number | null;
  initialCents: number | null;
  currency: string | null;
};

/** Read-only lookups over already-synced products / plans of an account. */
export type Catalog = {
  plan(id: string | null): PlanInfo | null;
  productName(id: string | null): string | null;
};

export type FetchPageArgs = { cursor: string | null; mode: SyncMode; sinceMs: number | null };
export type PageResult = {
  items: unknown[];
  nextCursor: string | null;
  totalCount?: number | null;
};

export type ObjectSpec = {
  object: string;
  /** Re-read the whole list on incremental runs (catalogs that change in place). */
  fullRefresh?: boolean;
  fetchPage(args: FetchPageArgs): Promise<PageResult>;
  /** created/updated time used for the high-water mark. */
  itemTime(item: unknown): number | null;
  normalize(items: unknown[], catalog: Catalog): NormalizedBatch;
};
