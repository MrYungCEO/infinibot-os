/**
 * Business hub revenue — Whop. Read-only pagers for the v1 company API
 * (`/api/v1/<object>?company_id=biz_…`, cursor `first`/`after`) and the
 * legacy v5 API (`/v5/company/<object>?per&page`, app keys / older company
 * keys), API-version auto-detection, and normalisers from Whop objects to
 * ledger rows, subscriptions and products.
 *
 * Whop amounts are major units (29.99) — verified against live data — and
 * are stored as minor units. Plans are stored as product rows with
 * `raw.kind = "plan"` so memberships and payments can resolve interval,
 * renewal price and product title.
 */

import type { RevenueHttp } from "./http.js";
import { ProviderHttpError } from "./http.js";
import {
  emptyBatch,
  list,
  majorToCents,
  n,
  rec,
  s,
  timeMs,
  upperCurrency,
  type Catalog,
  type LedgerRow,
  type NormalizedBatch,
  type ObjectSpec,
  type PageResult,
  type PlanInfo,
  type ProductRow,
  type SubInterval,
  type SubscriptionRow,
  type SyncMode,
} from "./types.js";
import { coerceString } from "../../shared/text/coerce.js";

export const WHOP_V1 = "https://api.whop.com/api/v1";
export const WHOP_V5 = "https://api.whop.com/v5/company";
export type WhopApiVersion = "v1" | "v5";

export const WHOP_V1_OBJECTS = [
  "products",
  "plans",
  "memberships",
  "payments",
  "refunds",
  "disputes",
] as const;
export const WHOP_V5_OBJECTS = ["products", "memberships", "payments"] as const;

const lower = (v: unknown) => (s(v) ?? "").toLowerCase();

// ── Pagers ────────────────────────────────────────────────────────────────────

/** Incremental filter per v1 object (payments/memberships change in place). */
const V1_SINCE_FIELD: Record<string, string> = {
  payments: "updated_after",
  memberships: "updated_after",
  refunds: "created_after",
  disputes: "created_after",
};
const V1_ORDERED = new Set(["payments", "memberships", "plans"]);

export async function whopV1Page(
  http: RevenueHttp,
  object: string,
  companyId: string,
  args: { cursor: string | null; sinceMs?: number | null; first?: number },
): Promise<PageResult> {
  const query: Record<string, string | number | undefined> = {
    company_id: companyId,
    first: args.first ?? 100,
    after: args.cursor ?? undefined,
  };
  if (V1_ORDERED.has(object)) {
    query.order = "created_at";
    query.direction = "asc";
  }
  const since = V1_SINCE_FIELD[object];
  if (since && args.sinceMs) query[since] = new Date(args.sinceMs).toISOString();
  const j = rec(await http.get(`${WHOP_V1}/${object}`, query));
  const items = list(j.data);
  const pi = rec(j.page_info);
  const end = s(pi.end_cursor);
  return {
    items,
    nextCursor: pi.has_next_page === true && end && items.length ? end : null,
    totalCount: n(j.total_count),
  };
}

export async function whopV5Page(
  http: RevenueHttp,
  object: string,
  page: number,
  per = 50,
): Promise<PageResult> {
  const j = rec(await http.get(`${WHOP_V5}/${object}`, { per, page }));
  const items = list(j.data);
  const pg = rec(j.pagination);
  const current = n(pg.current_page) ?? page;
  const total = n(pg.total_pages);
  const next = n(pg.next_page) ?? (total !== null && current < total ? current + 1 : null);
  return {
    items,
    nextCursor: next !== null && items.length ? String(next) : null,
    totalCount: n(pg.total_count),
  };
}

/**
 * v1 with `company_id` when a company is known; on 401/403/404 (e.g. "Bot
 * was not found" for app keys) fall back to v5. Throws when neither works.
 */
export async function detectWhopApiVersion(
  http: RevenueHttp,
  companyRef: string | null,
): Promise<WhopApiVersion> {
  let v1Err: unknown = null;
  if (companyRef) {
    try {
      await whopV1Page(http, "payments", companyRef, { cursor: null, first: 1 });
      return "v1";
    } catch (err) {
      if (!(err instanceof ProviderHttpError) || ![401, 403, 404].includes(err.status)) throw err;
      v1Err = err;
    }
  }
  try {
    await whopV5Page(http, "payments", 1, 1);
    return "v5";
  } catch (err) {
    const a = v1Err instanceof Error ? `v1: ${v1Err.message}; ` : "";
    throw new Error(
      `Whop key rejected (${a}v5: ${err instanceof Error ? err.message : coerceString(err)})`,
      {
        cause: err,
      },
    );
  }
}

// ── Normalisers ───────────────────────────────────────────────────────────────

/** Whop `billing_period` (days) → interval. */
export function intervalFromDays(days: unknown): { interval: SubInterval; count: number } | null {
  const d = n(days);
  if (!d || d <= 0) return null;
  if (d >= 360 && d <= 366) return { interval: "year", count: 1 };
  if (d % 365 === 0) return { interval: "year", count: d / 365 };
  if (d >= 28 && d <= 31) return { interval: "month", count: 1 };
  if (d % 30 === 0) return { interval: "month", count: d / 30 };
  if (d % 7 === 0) return { interval: "week", count: d / 7 };
  return { interval: "day", count: d };
}

export function mapWhopPaymentStatus(p: {
  status: unknown;
  substatus?: unknown;
  totalCents: number;
  refundedCents: number;
  failureMessage?: unknown;
}): string {
  const st = lower(p.status);
  const sub = lower(p.substatus);
  if (p.refundedCents > 0 && p.totalCents > 0)
    return p.refundedCents >= p.totalCents ? "refunded" : "partially_refunded";
  if (sub === "refunded" || sub === "auto_refunded" || st === "refunded") return "refunded";
  if (sub === "partially_refunded" || st === "partially_refunded") return "partially_refunded";
  if (["paid", "succeeded", "success", "completed", "captured"].includes(st)) return "succeeded";
  if (st === "void" || st === "canceled" || st === "cancelled") return "canceled";
  if (st === "uncollectible" || st === "failed" || sub === "failed") return "failed";
  if (st === "open" || st === "pending" || st === "draft")
    return s(p.failureMessage) ? "failed" : "pending";
  return st || "unknown";
}

function customer(user: unknown) {
  const u = rec(user);
  return {
    ref: s(u.id),
    email: s(u.email)?.toLowerCase() ?? null,
    name: s(u.name) ?? s(u.username),
  };
}

export function normalizeWhopV1Payment(raw: unknown, catalog: Catalog): LedgerRow | null {
  const p = rec(raw);
  const id = s(p.id);
  if (!id) return null;
  const total = majorToCents(p.total) ?? majorToCents(p.subtotal) ?? 0;
  const refunded = majorToCents(p.refunded_amount) ?? 0;
  const status = mapWhopPaymentStatus({
    status: p.status,
    substatus: p.substatus,
    totalCents: total,
    refundedCents: refunded,
    failureMessage: p.failure_message,
  });
  const paid = status === "succeeded" || status.includes("refunded");
  const after = majorToCents(p.amount_after_fees);
  const fee = paid && after !== null && total > 0 ? Math.max(0, total - after) : 0;
  const planId = s(rec(p.plan).id) ?? s(p.plan);
  const plan = catalog.plan(planId);
  const product = rec(p.product);
  const productId = s(product.id) ?? plan?.productId ?? null;
  const currency = upperCurrency(p.currency);
  const usd = majorToCents(p.usd_total);
  const c = customer(p.user);
  return {
    externalId: id,
    type: "charge",
    status,
    grossCents: total,
    feeCents: fee,
    netCents: total - fee,
    refundedCents: refunded,
    currency,
    amountUsdCents: usd ?? (currency === "USD" ? total : null),
    occurredAt: timeMs(p.paid_at) ?? timeMs(p.created_at) ?? Date.now(),
    productId,
    productName: s(product.title) ?? plan?.productName ?? catalog.productName(productId),
    planId,
    billingReason: s(p.billing_reason),
    customerRef: c.ref,
    customerEmail: c.email,
    customerName: c.name,
    subscriptionRef: s(rec(p.membership).id) ?? s(p.membership),
    parentExternalId: null,
    raw: p,
  };
}

export function normalizeWhopV5Payment(raw: unknown, catalog: Catalog): LedgerRow | null {
  const p = rec(raw);
  const id = s(p.id);
  if (!id) return null;
  const total = majorToCents(p.final_amount) ?? majorToCents(p.subtotal) ?? 0;
  const refunded = majorToCents(p.refunded_amount) ?? 0;
  const status = mapWhopPaymentStatus({
    status: p.status,
    totalCents: total,
    refundedCents: refunded,
  });
  const planId = s(p.plan_id);
  const plan = catalog.plan(planId);
  const productId = s(p.product_id) ?? plan?.productId ?? null;
  const currency = upperCurrency(p.currency);
  return {
    externalId: id,
    type: "charge",
    status,
    grossCents: total,
    feeCents: 0,
    netCents: total,
    refundedCents: refunded,
    currency,
    amountUsdCents: currency === "USD" ? total : null,
    occurredAt: timeMs(p.paid_at) ?? timeMs(p.created_at) ?? Date.now(),
    productId,
    productName: catalog.productName(productId) ?? plan?.productName ?? null,
    planId,
    billingReason: s(p.billing_reason),
    customerRef: s(p.user_id),
    customerEmail: s(p.user_email)?.toLowerCase() ?? null,
    customerName: s(p.user_username),
    subscriptionRef: s(p.membership_id),
    parentExternalId: null,
    raw: p,
  };
}

export function normalizeWhopRefund(raw: unknown): LedgerRow | null {
  const r = rec(raw);
  const id = s(r.id);
  if (!id) return null;
  const amount = majorToCents(r.amount) ?? 0;
  const currency = upperCurrency(r.currency);
  const st = lower(r.status);
  return {
    externalId: id,
    type: "refund",
    status: st === "succeeded" || st === "success" ? "succeeded" : st || "unknown",
    grossCents: amount,
    feeCents: 0,
    netCents: -amount,
    refundedCents: amount,
    currency,
    amountUsdCents: currency === "USD" ? amount : null,
    occurredAt: timeMs(r.created_at) ?? Date.now(),
    productId: null,
    productName: null,
    planId: null,
    billingReason: null,
    customerRef: null,
    customerEmail: null,
    customerName: null,
    subscriptionRef: null,
    parentExternalId: s(rec(r.payment).id) ?? s(r.payment_id),
    raw: r,
  };
}

export function normalizeWhopDispute(raw: unknown, catalog: Catalog): LedgerRow | null {
  const d = rec(raw);
  const id = s(d.id);
  if (!id) return null;
  const amount = majorToCents(d.amount) ?? 0;
  const currency = upperCurrency(d.currency);
  const product = rec(d.product);
  const productId = s(product.id);
  return {
    externalId: id,
    type: "dispute",
    status: lower(d.status) || "unknown",
    grossCents: amount,
    feeCents: 0,
    netCents: -amount,
    refundedCents: 0,
    currency,
    amountUsdCents: currency === "USD" ? amount : null,
    occurredAt: timeMs(d.created_at) ?? Date.now(),
    productId,
    productName: s(product.title) ?? catalog.productName(productId),
    planId: s(rec(d.plan).id),
    billingReason: s(d.reason),
    customerRef: null,
    customerEmail: null,
    customerName: null,
    subscriptionRef: null,
    parentExternalId: s(rec(d.payment).id) ?? s(d.payment_id),
    raw: d,
  };
}

export function normalizeWhopProduct(raw: unknown): ProductRow | null {
  const p = rec(raw);
  const id = s(p.id);
  if (!id) return null;
  return {
    externalId: id,
    name: s(p.title) ?? s(p.name) ?? id,
    raw: { kind: "product", id, title: s(p.title) ?? s(p.name), visibility: s(p.visibility) },
  };
}

export function normalizeWhopPlan(raw: unknown): ProductRow | null {
  const p = rec(raw);
  const id = s(p.id);
  if (!id) return null;
  const product = rec(p.product);
  const iv = lower(p.plan_type) === "one_time" ? null : intervalFromDays(p.billing_period);
  const plan: PlanInfo = {
    productId: s(product.id),
    productName: s(product.title),
    interval: iv?.interval ?? null,
    intervalCount: iv?.count ?? 1,
    renewalCents: majorToCents(p.renewal_price),
    initialCents: majorToCents(p.initial_price),
    currency: s(p.currency)?.toUpperCase() ?? null,
  };
  return {
    externalId: id,
    name: s(p.title) ?? s(product.title) ?? id,
    raw: {
      kind: "plan",
      id,
      planType: s(p.plan_type),
      billingPeriod: n(p.billing_period),
      ...plan,
    },
  };
}

/** Parse "$29.99" / "29.99" / "$29.99 / month" → cents. */
function priceText(v: unknown): number | null {
  const t = s(v);
  if (!t) return null;
  const m = t.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Math.round(Number(m[0]) * 100) : null;
}

export function normalizeWhopMembership(raw: unknown, catalog: Catalog): SubscriptionRow | null {
  const m = rec(raw);
  const id = s(m.id);
  if (!id) return null;
  const planId = s(rec(m.plan).id) ?? s(m.plan_id) ?? s(m.plan);
  const plan = catalog.plan(planId);
  const product = rec(m.product);
  const productId = s(product.id) ?? s(m.product_id) ?? plan?.productId ?? null;
  const c = customer(m.user);
  const amount =
    plan?.renewalCents ??
    priceText(m.formatted_renewal_price) ??
    priceText(m.initial_price_paid) ??
    plan?.initialCents ??
    0;
  return {
    externalId: id,
    status: lower(m.status) || "unknown",
    productId,
    productName: s(product.title) ?? plan?.productName ?? catalog.productName(productId),
    planId,
    interval: plan?.interval ?? null,
    intervalCount: plan?.intervalCount ?? 1,
    amountCents: amount,
    currency: upperCurrency(m.currency ?? plan?.currency),
    customerRef: c.ref ?? s(m.user_id),
    customerEmail: c.email ?? s(m.email)?.toLowerCase() ?? null,
    startedAt: timeMs(m.joined_at) ?? timeMs(m.created_at),
    canceledAt: timeMs(m.canceled_at),
    currentPeriodEnd: timeMs(m.renewal_period_end) ?? timeMs(m.expires_at),
    raw: m,
  };
}

// ── Object specs for the sync engine ──────────────────────────────────────────

function batchOf<T>(items: unknown[], fn: (x: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const it of items) {
    const r = fn(it);
    if (r) out.push(r);
  }
  return out;
}

const itemTimeOf = (it: unknown): number | null => {
  const r = rec(it);
  const a = timeMs(r.updated_at);
  const b = timeMs(r.created_at);
  return a !== null && b !== null ? Math.max(a, b) : (a ?? b);
};

function normalizer(object: string): (items: unknown[], c: Catalog) => NormalizedBatch {
  return (items, c) => {
    const b = emptyBatch();
    if (object === "products") b.products = batchOf(items, normalizeWhopProduct);
    else if (object === "plans") b.products = batchOf(items, normalizeWhopPlan);
    else if (object === "memberships")
      b.subs = batchOf(items, (x) => normalizeWhopMembership(x, c));
    else if (object === "payments") b.txns = batchOf(items, (x) => normalizeWhopV1Payment(x, c));
    else if (object === "refunds") b.txns = batchOf(items, normalizeWhopRefund);
    else if (object === "disputes") b.txns = batchOf(items, (x) => normalizeWhopDispute(x, c));
    return b;
  };
}

export function whopV1Specs(
  http: RevenueHttp,
  companyId: string,
  objects?: readonly string[],
): ObjectSpec[] {
  return WHOP_V1_OBJECTS.filter((o) => !objects || objects.includes(o)).map((object) => ({
    object,
    fullRefresh: object === "products" || object === "plans",
    fetchPage: ({ cursor, mode, sinceMs }) =>
      whopV1Page(http, object, companyId, {
        cursor,
        sinceMs: mode === "incremental" ? sinceMs : null,
      }),
    itemTime: itemTimeOf,
    normalize: normalizer(object),
  }));
}

export function whopV5Specs(http: RevenueHttp, objects?: readonly string[]): ObjectSpec[] {
  return WHOP_V5_OBJECTS.filter((o) => !objects || objects.includes(o)).map((object) => ({
    object,
    fullRefresh: object === "products" || object === "memberships",
    fetchPage: async ({
      cursor,
      mode,
      sinceMs,
    }: {
      cursor: string | null;
      mode: SyncMode;
      sinceMs: number | null;
    }) => {
      const page = await whopV5Page(http, object, cursor ? Number(cursor) : 1);
      // v5 has no date filter: on incremental runs stop once a whole page is older.
      if (mode === "incremental" && sinceMs && page.items.length) {
        const times = page.items.map(itemTimeOf).filter((t): t is number => t !== null);
        if (times.length && times.every((t) => t < sinceMs)) page.nextCursor = null;
      }
      return page;
    },
    itemTime: itemTimeOf,
    normalize: (items: unknown[], c: Catalog) => {
      const b = emptyBatch();
      if (object === "products") b.products = batchOf(items, normalizeWhopProduct);
      else if (object === "memberships")
        b.subs = batchOf(items, (x) => normalizeWhopMembership(x, c));
      else b.txns = batchOf(items, (x) => normalizeWhopV5Payment(x, c));
      return b;
    },
  }));
}
