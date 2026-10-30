/**
 * Business hub revenue — Stripe. Read-only list pagers (`limit=100`,
 * `starting_after=<last id>`, `has_more`; `created[gte]` for incremental
 * runs) and normalisers from charges / refunds / disputes / subscriptions /
 * products / payouts to ledger rows. Charges are listed with
 * `expand[]=data.balance_transaction` so fee and net come from Stripe's own
 * balance ledger. Use a restricted read-only key (rk_…).
 */

import type { RevenueHttp } from "./http.js";
import {
  emptyBatch,
  list,
  n,
  rec,
  s,
  timeMs,
  upperCurrency,
  type Catalog,
  type LedgerRow,
  type ObjectSpec,
  type PageResult,
  type ProductRow,
  type SubInterval,
  type SubscriptionRow,
} from "./types.js";

export const STRIPE_API = "https://api.stripe.com/v1";

export const STRIPE_OBJECTS = [
  "products",
  "subscriptions",
  "charges",
  "refunds",
  "disputes",
  "payouts",
] as const;

const PATHS: Record<string, string> = {
  charges: "charges",
  refunds: "refunds",
  disputes: "disputes",
  subscriptions: "subscriptions",
  products: "products",
  payouts: "payouts",
  balance_transactions: "balance_transactions",
  invoices: "invoices",
};

const EXTRA: Record<string, Record<string, string | string[]>> = {
  charges: { "expand[]": ["data.balance_transaction"] },
  subscriptions: { status: "all", "expand[]": ["data.customer"] },
};

export async function stripePage(
  http: RevenueHttp,
  object: string,
  args: { cursor: string | null; sinceMs?: number | null; untilMs?: number | null; limit?: number },
): Promise<PageResult> {
  const path = PATHS[object];
  if (!path) throw new Error(`unknown Stripe object: ${object}`);
  const query: Record<string, string | number | string[] | undefined> = {
    limit: args.limit ?? 100,
    starting_after: args.cursor ?? undefined,
    ...EXTRA[object],
  };
  if (args.sinceMs) query["created[gte]"] = Math.floor(args.sinceMs / 1000);
  if (args.untilMs) query["created[lt]"] = Math.floor(args.untilMs / 1000);
  const j = rec(await http.get(`${STRIPE_API}/${path}`, query));
  const items = list(j.data);
  const last = s(rec(items[items.length - 1]).id);
  return { items, nextCursor: j.has_more === true && last ? last : null };
}

const lower = (v: unknown) => (s(v) ?? "").toLowerCase();

/** Stripe objects may be an id string or an expanded object. */
function idOf(v: unknown): string | null {
  return typeof v === "string" ? s(v) : s(rec(v).id);
}

export function normalizeStripeCharge(raw: unknown): LedgerRow | null {
  const c = rec(raw);
  const id = s(c.id);
  if (!id) return null;
  const amount = n(c.amount) ?? 0;
  const refunded = n(c.amount_refunded) ?? 0;
  const currency = upperCurrency(c.currency);
  const bt = rec(c.balance_transaction);
  const fee = n(bt.fee) ?? 0;
  const st = lower(c.status);
  let status = st === "succeeded" ? "succeeded" : st === "failed" ? "failed" : st || "pending";
  if (st === "succeeded" && refunded > 0)
    status = c.refunded === true || refunded >= amount ? "refunded" : "partially_refunded";
  const btUsd = lower(bt.currency) === "usd" ? n(bt.amount) : null;
  const bd = rec(c.billing_details);
  const cust = rec(c.customer);
  const invoice = rec(c.invoice);
  const md = rec(c.metadata);
  return {
    externalId: id,
    type: "charge",
    status,
    grossCents: amount,
    feeCents: fee,
    netCents: n(bt.net) ?? amount - fee,
    refundedCents: refunded,
    currency,
    amountUsdCents: currency === "USD" ? amount : btUsd,
    occurredAt: timeMs(c.created) ?? Date.now(),
    productId: s(md.product_id),
    productName: s(c.description) ?? s(c.statement_descriptor) ?? s(md.product),
    planId: null,
    billingReason: s(invoice.billing_reason) ?? (c.invoice ? "invoice" : "one_time"),
    customerRef: idOf(c.customer),
    customerEmail: (s(bd.email) ?? s(c.receipt_email) ?? s(cust.email))?.toLowerCase() ?? null,
    customerName: s(bd.name) ?? s(cust.name),
    subscriptionRef: idOf(invoice.subscription),
    parentExternalId: null,
    raw: c,
  };
}

export function normalizeStripeRefund(raw: unknown): LedgerRow | null {
  const r = rec(raw);
  const id = s(r.id);
  if (!id) return null;
  const amount = n(r.amount) ?? 0;
  const currency = upperCurrency(r.currency);
  return {
    externalId: id,
    type: "refund",
    status: lower(r.status) || "unknown",
    grossCents: amount,
    feeCents: 0,
    netCents: -amount,
    refundedCents: amount,
    currency,
    amountUsdCents: currency === "USD" ? amount : null,
    occurredAt: timeMs(r.created) ?? Date.now(),
    productId: null,
    productName: null,
    planId: null,
    billingReason: s(r.reason),
    customerRef: null,
    customerEmail: null,
    customerName: null,
    subscriptionRef: null,
    parentExternalId: idOf(r.charge),
    raw: r,
  };
}

export function normalizeStripeDispute(raw: unknown): LedgerRow | null {
  const d = rec(raw);
  const id = s(d.id);
  if (!id) return null;
  const amount = n(d.amount) ?? 0;
  const currency = upperCurrency(d.currency);
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
    occurredAt: timeMs(d.created) ?? Date.now(),
    productId: null,
    productName: null,
    planId: null,
    billingReason: s(d.reason),
    customerRef: null,
    customerEmail: null,
    customerName: null,
    subscriptionRef: null,
    parentExternalId: idOf(d.charge),
    raw: d,
  };
}

export function normalizeStripePayout(raw: unknown): LedgerRow | null {
  const p = rec(raw);
  const id = s(p.id);
  if (!id) return null;
  const amount = n(p.amount) ?? 0;
  const currency = upperCurrency(p.currency);
  return {
    externalId: id,
    type: "payout",
    status: lower(p.status) || "unknown",
    grossCents: amount,
    feeCents: 0,
    netCents: 0,
    refundedCents: 0,
    currency,
    amountUsdCents: currency === "USD" ? amount : null,
    occurredAt: timeMs(p.arrival_date) ?? timeMs(p.created) ?? Date.now(),
    productId: null,
    productName: null,
    planId: null,
    billingReason: null,
    customerRef: null,
    customerEmail: null,
    customerName: null,
    subscriptionRef: null,
    parentExternalId: null,
    raw: p,
  };
}

const INTERVALS: ReadonlySet<string> = new Set(["day", "week", "month", "year"]);

export function normalizeStripeSubscription(
  raw: unknown,
  catalog: Catalog,
): SubscriptionRow | null {
  const sub = rec(raw);
  const id = s(sub.id);
  if (!id) return null;
  const items = list(rec(sub.items).data).map(rec);
  let amount = 0;
  let interval: SubInterval | null = null;
  let count = 1;
  let productId: string | null = null;
  let planId: string | null = null;
  for (const it of items) {
    const price = rec(it.price ?? it.plan);
    const rc = rec(price.recurring);
    const iv = lower(rc.interval ?? price.interval);
    const qty = n(it.quantity) ?? 1;
    const unit = n(price.unit_amount) ?? n(price.amount) ?? 0;
    if (!interval && INTERVALS.has(iv)) {
      interval = iv as SubInterval;
      count = n(rc.interval_count ?? price.interval_count) ?? 1;
    }
    amount += unit * qty;
    productId ??= idOf(price.product);
    planId ??= s(price.id);
  }
  const cust = rec(sub.customer);
  const firstItem = items[0] ?? {};
  return {
    externalId: id,
    status: lower(sub.status) || "unknown",
    productId,
    productName: catalog.productName(productId),
    planId,
    interval,
    intervalCount: count,
    amountCents: amount,
    currency: upperCurrency(sub.currency),
    customerRef: idOf(sub.customer),
    customerEmail: s(cust.email)?.toLowerCase() ?? null,
    startedAt: timeMs(sub.start_date) ?? timeMs(sub.created),
    canceledAt: timeMs(sub.canceled_at) ?? timeMs(sub.ended_at),
    currentPeriodEnd: timeMs(sub.current_period_end) ?? timeMs(firstItem.current_period_end),
    raw: sub,
  };
}

export function normalizeStripeProduct(raw: unknown): ProductRow | null {
  const p = rec(raw);
  const id = s(p.id);
  if (!id) return null;
  return { externalId: id, name: s(p.name) ?? id, raw: { kind: "product", id, name: s(p.name) } };
}

function keep<T>(items: unknown[], fn: (x: unknown) => T | null): T[] {
  return items.map(fn).filter((x): x is T => x !== null);
}

export function stripeSpecs(http: RevenueHttp, objects?: readonly string[]): ObjectSpec[] {
  return STRIPE_OBJECTS.filter((o) => !objects || objects.includes(o)).map((object) => ({
    object,
    fullRefresh: object === "products" || object === "subscriptions",
    fetchPage: ({ cursor, mode, sinceMs }) =>
      stripePage(http, object, { cursor, sinceMs: mode === "incremental" ? sinceMs : null }),
    itemTime: (it: unknown) => timeMs(rec(it).created),
    normalize: (items: unknown[], c: Catalog) => {
      const b = emptyBatch();
      if (object === "products") b.products = keep(items, normalizeStripeProduct);
      else if (object === "subscriptions")
        b.subs = keep(items, (x) => normalizeStripeSubscription(x, c));
      else if (object === "charges") b.txns = keep(items, normalizeStripeCharge);
      else if (object === "refunds") b.txns = keep(items, normalizeStripeRefund);
      else if (object === "disputes") b.txns = keep(items, normalizeStripeDispute);
      else if (object === "payouts") b.txns = keep(items, normalizeStripePayout);
      return b;
    },
  }));
}
