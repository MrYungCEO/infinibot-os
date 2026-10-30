/**
 * Business hub revenue — metrics over the ledger: gross / refunds / fees /
 * net, MRR / ARR (subscriptions normalised to monthly, falling back to
 * trailing-30-day recurring charges), churn, LTV, new vs returning
 * customers, time series, breakdowns by product / account / source /
 * campaign, first-purchase cohorts, top customers and refunds / disputes.
 *
 * Only paid charges (succeeded / refunded / partially_refunded) count as
 * revenue. USD figures use `amount_usd_cents` (Whop usd_total, Stripe USD
 * balance) when present; other currencies are reported per currency.
 * Legacy imported rows that duplicate a synced provider charge are skipped.
 */

import type { HubDb } from "../db.js";
import { parseJson } from "../util.js";
import { defaultProjectForProduct, productKey } from "./canonical.js";
import { RECURRING_REASONS, REVENUE_STATUSES, type SubInterval } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;

export type SummaryOptions = {
  from?: number;
  to?: number;
  accountIds?: string[];
  currency?: "USD";
  now?: number;
};

type TxnRow = {
  id: string;
  account_id: string;
  provider: string;
  external_id: string;
  type: string;
  status: string;
  gross_cents: number;
  fee_cents: number;
  refunded_cents: number;
  currency: string;
  amount_usd_cents: number | null;
  occurred_at: number;
  product_name: string | null;
  product_id: string | null;
  plan_id: string | null;
  billing_reason: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer_ref: string | null;
  contact_id: string | null;
  client_id: string | null;
  project_id: string | null;
  campaign_id: string | null;
  parent_external_id: string | null;
  first_source_id: string | null;
  first_campaign_id: string | null;
  raw: string;
};

type SubRow = {
  account_id: string;
  status: string;
  interval: string | null;
  interval_count: number;
  amount_cents: number;
  currency: string;
  started_at: number | null;
  canceled_at: number | null;
  current_period_end: number | null;
  customer_email: string | null;
  contact_id: string | null;
};

export type Money = { grossCents: number; count: number };

export type RevenueSummary = {
  // Flat headline fields (read by the Overview RPC); same values as totals / mrr / churn below.
  grossCents: number;
  netCents: number;
  feeCents: number;
  refundCents: number;
  chargeCount: number;
  activeSubscriptions: number;
  /** Subscriptions churned in the window / active at its start (0..1), or null. */
  churnRate: number | null;
  range: { from: number | null; to: number | null };
  currency: "USD";
  totals: {
    grossCents: number;
    refundsCents: number;
    feesCents: number;
    disputesLostCents: number;
    netCents: number;
    count: number;
    avgOrderCents: number;
    customers: number;
    newCustomers: number;
    returningCustomers: number;
    /** Paid charges whose USD value is unknown (non-USD without a USD figure). */
    unconvertedCount: number;
  };
  perCurrency: Array<{
    currency: string;
    grossCents: number;
    refundsCents: number;
    count: number;
    usdGrossCents: number | null;
  }>;
  mrrCents: number;
  arrCents: number;
  mrrSource: "subscriptions" | "recurring_charges" | "none";
  mrrByCurrency: Record<string, number>;
  activeSubscribers: number;
  churn: { rate: number | null; canceled: number; activeAtStart: number; windowDays: number };
  ltv: { cents: number; method: "arpu/churn" | "lifetime-average" | "none" };
  byMonth: Array<{
    month: string;
    grossCents: number;
    refundsCents: number;
    netCents: number;
    count: number;
    customers: number;
  }>;
  byProduct: Array<{ product: string; grossCents: number; count: number }>;
  byProductPlan: Array<{ product: string; plan: string | null; grossCents: number; count: number }>;
  byProject: Array<{ project: string; grossCents: number; count: number }>;
  byRevenueSource: Array<{
    accountId: string;
    source: string;
    provider: string;
    grossCents: number;
    refundsCents: number;
    feesCents: number;
    netCents: number;
    count: number;
  }>;
  byTime: {
    daily: Array<{ period: string; grossCents: number; netCents: number; count: number }>;
    weekly: Array<{ period: string; grossCents: number; netCents: number; count: number }>;
    monthly: Array<{ period: string; grossCents: number; netCents: number; count: number }>;
  };
  sourceSeries: Array<{
    source: string;
    points: Array<{ period: string; grossCents: number; netCents: number }>;
  }>;
  revenueMix: {
    recurringCents: number;
    oneTimeCents: number;
    recurringCount: number;
    oneTimeCount: number;
  };
  byAccount: Array<{
    accountId: string;
    label: string;
    provider: string;
    grossCents: number;
    refundsCents: number;
    netCents: number;
    count: number;
  }>;
  bySource: Array<{
    sourceId: string | null;
    name: string;
    kind: string | null;
    grossCents: number;
    count: number;
    customers: number;
  }>;
  byCampaign: Array<{
    campaignId: string | null;
    name: string;
    grossCents: number;
    count: number;
    customers: number;
  }>;
  cohorts: Array<{
    cohort: string;
    customers: number;
    cells: Array<{ offset: number; revenueCents: number; retained: number }>;
  }>;
  topCustomers: Array<{
    key: string;
    contactId: string | null;
    clientId: string | null;
    email: string | null;
    name: string | null;
    grossCents: number;
    count: number;
  }>;
  refunds: Array<{
    id: string;
    type: string;
    status: string;
    amountCents: number;
    currency: string;
    occurredAt: number;
    customerEmail: string | null;
    product: string | null;
    parentExternalId: string | null;
  }>;
};

const ACTIVE_SUB = new Set(["active", "past_due"]);
const LIVE_SUB = new Set(["active", "past_due", "trialing"]);
const VOID_REFUND = new Set(["failed", "canceled", "cancelled"]);
const LOST_DISPUTE = new Set(["lost", "charge_refunded"]);

/** Monthly factor for a billing interval. */
export function monthlyFactor(interval: string | null, count = 1): number {
  const c = count > 0 ? count : 1;
  switch (interval as SubInterval | null) {
    case "day":
      return 365 / 12 / c;
    case "week":
      return 52 / 12 / c;
    case "month":
      return 1 / c;
    case "year":
      return 1 / (12 * c);
    default:
      return 0;
  }
}

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function weekKey(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

function accountFilter(ids: string[] | undefined, col: string): { sql: string; params: string[] } {
  if (!ids?.length) return { sql: "", params: [] };
  return { sql: ` AND ${col} IN (${ids.map(() => "?").join(",")})`, params: ids };
}

function customerKey(r: TxnRow): string {
  return r.contact_id ?? r.customer_email ?? r.customer_ref ?? `anon:${r.id}`;
}

type Bucket = { grossCents: number; count: number; customers: Set<string> };
const bucket = (): Bucket => ({ grossCents: 0, count: 0, customers: new Set() });

export function revenueSummary(db: HubDb, opts: SummaryOptions = {}): RevenueSummary {
  const now = opts.now ?? Date.now();
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const inRange = (t: number) => (from === null || t >= from) && (to === null || t < to);
  const af = accountFilter(opts.accountIds, "t.account_id");
  const all = db
    .prepare(
      `SELECT t.id,t.account_id,t.provider,t.external_id,t.type,t.status,t.gross_cents,t.fee_cents,t.refunded_cents,t.currency,
              t.amount_usd_cents,t.occurred_at,t.product_id,t.product_name,t.plan_id,t.billing_reason,t.customer_email,t.customer_name,t.customer_ref,
              t.contact_id,t.client_id,t.project_id,t.campaign_id,t.parent_external_id,t.raw,c.first_source_id,c.first_campaign_id
       FROM revenue_txns t LEFT JOIN contacts c ON c.id = t.contact_id WHERE 1=1${af.sql}`,
    )
    .all(...af.params) as TxnRow[];

  // Legacy imports that duplicate a synced provider charge are skipped.
  const providerIds = new Set(
    all
      .filter((r) => r.type === "charge" && (r.provider === "whop" || r.provider === "stripe"))
      .map((r) => r.external_id),
  );
  const rows = all.filter(
    (r) =>
      !(
        (r.provider === "legacy" || r.provider === "invoice") &&
        r.parent_external_id &&
        providerIds.has(r.parent_external_id)
      ),
  );
  const charges = new Map<string, TxnRow>();
  for (const r of rows) if (r.type === "charge") charges.set(`${r.account_id}|${r.external_id}`, r);

  const usdOf = (r: TxnRow): number | null => {
    if (r.amount_usd_cents !== null) return r.amount_usd_cents;
    if (r.currency === "USD") return r.gross_cents;
    return null;
  };
  /** Convert a native amount of a charge (fee / refund) to USD via the charge's ratio. */
  const usdScale = (charge: TxnRow, amount: number): number | null => {
    if (charge.currency === "USD") return amount;
    const u = usdOf(charge);
    return u !== null && charge.gross_cents > 0
      ? Math.round((amount * u) / charge.gross_cents)
      : null;
  };

  const paid = rows.filter((r) => r.type === "charge" && REVENUE_STATUSES.has(r.status));

  // Refund rows per parent charge; charges without rows fall back to refunded_cents.
  const refundRowsByParent = new Map<string, TxnRow[]>();
  for (const r of rows) {
    if (r.type !== "refund" || VOID_REFUND.has(r.status) || !r.parent_external_id) continue;
    const k = `${r.account_id}|${r.parent_external_id}`;
    const arr = refundRowsByParent.get(k) ?? [];
    arr.push(r);
    refundRowsByParent.set(k, arr);
  }
  type RefundEvt = {
    at: number;
    usd: number | null;
    native: number;
    currency: string;
    accountId: string;
  };
  const refundEvents: RefundEvt[] = [];
  for (const r of rows) {
    if (r.type !== "refund" || VOID_REFUND.has(r.status)) continue;
    const parent = r.parent_external_id
      ? charges.get(`${r.account_id}|${r.parent_external_id}`)
      : undefined;
    const usd =
      r.amount_usd_cents ??
      (parent ? usdScale(parent, r.gross_cents) : r.currency === "USD" ? r.gross_cents : null);
    refundEvents.push({
      at: r.occurred_at,
      usd,
      native: r.gross_cents,
      currency: r.currency,
      accountId: r.account_id,
    });
  }
  for (const c of paid) {
    if (c.refunded_cents <= 0) continue;
    const linked = refundRowsByParent.get(`${c.account_id}|${c.external_id}`) ?? [];
    // Provider payment objects are the reconciliation source of truth. Some
    // Whop v1 refund rows omit tax/adjustment cents even though the payment's
    // refunded_amount includes them, so add only the missing remainder.
    const rowTotal = linked.reduce((total, refund) => total + refund.gross_cents, 0);
    const remainder = Math.max(0, c.refunded_cents - rowTotal);
    if (remainder === 0) continue;
    refundEvents.push({
      at: linked.reduce((latest, refund) => Math.max(latest, refund.occurred_at), c.occurred_at),
      usd: usdScale(c, remainder),
      native: remainder,
      currency: c.currency,
      accountId: c.account_id,
    });
  }

  // ── Totals ──
  const firstPaid = new Map<string, number>();
  for (const c of paid) {
    const k = customerKey(c);
    const t = firstPaid.get(k);
    if (t === undefined || c.occurred_at < t) firstPaid.set(k, c.occurred_at);
  }
  const periodPaid = paid.filter((c) => inRange(c.occurred_at));
  let gross = 0;
  let fees = 0;
  let unconverted = 0;
  const customers = new Set<string>();
  const perCur = new Map<
    string,
    { grossCents: number; refundsCents: number; count: number; usd: number; usdKnown: boolean }
  >();
  for (const c of periodPaid) {
    const u = usdOf(c);
    if (u === null) unconverted++;
    else gross += u;
    fees += usdScale(c, c.fee_cents) ?? 0;
    customers.add(customerKey(c));
    const pc = perCur.get(c.currency) ?? {
      grossCents: 0,
      refundsCents: 0,
      count: 0,
      usd: 0,
      usdKnown: true,
    };
    pc.grossCents += c.gross_cents;
    pc.count++;
    if (u === null) pc.usdKnown = false;
    else pc.usd += u;
    perCur.set(c.currency, pc);
  }
  let refunds = 0;
  for (const e of refundEvents) {
    if (!inRange(e.at)) continue;
    refunds += e.usd ?? 0;
    const pc = perCur.get(e.currency) ?? {
      grossCents: 0,
      refundsCents: 0,
      count: 0,
      usd: 0,
      usdKnown: true,
    };
    pc.refundsCents += e.native;
    perCur.set(e.currency, pc);
  }
  const disputes = rows.filter((r) => r.type === "dispute");
  let disputesLost = 0;
  for (const d of disputes) {
    if (!inRange(d.occurred_at) || !LOST_DISPUTE.has(d.status)) continue;
    const parent = d.parent_external_id
      ? charges.get(`${d.account_id}|${d.parent_external_id}`)
      : undefined;
    disputesLost +=
      d.amount_usd_cents ??
      (parent ? (usdScale(parent, d.gross_cents) ?? 0) : d.currency === "USD" ? d.gross_cents : 0);
  }
  let newCustomers = 0;
  for (const k of customers) {
    const t = firstPaid.get(k);
    if (t !== undefined && inRange(t)) newCustomers++;
  }

  // ── Subscriptions: MRR, churn ──
  const sf = accountFilter(opts.accountIds, "account_id");
  const subs = db
    .prepare(
      `SELECT account_id,status,interval,interval_count,amount_cents,currency,started_at,canceled_at,current_period_end,customer_email,contact_id
       FROM revenue_subscriptions WHERE 1=1${sf.sql}`,
    )
    .all(...sf.params) as SubRow[];
  const mrrByCurrency: Record<string, number> = {};
  let activeSubscribers = 0;
  let mrrSubs = 0;
  for (const sub of subs) {
    if (LIVE_SUB.has(sub.status)) activeSubscribers++;
    if (!ACTIVE_SUB.has(sub.status) || sub.amount_cents <= 0) continue;
    const f = monthlyFactor(sub.interval, sub.interval_count);
    if (!f) continue;
    mrrSubs++;
    mrrByCurrency[sub.currency] =
      (mrrByCurrency[sub.currency] ?? 0) + Math.round(sub.amount_cents * f);
  }
  let mrr = mrrByCurrency.USD ?? 0;
  let mrrSource: RevenueSummary["mrrSource"] = mrrSubs ? "subscriptions" : "none";
  if (!mrrSubs) {
    const end = to ?? now;
    const recurring = paid.filter(
      (c) =>
        c.occurred_at >= end - 30 * DAY &&
        c.occurred_at < end &&
        RECURRING_REASONS.has(c.billing_reason ?? ""),
    );
    if (recurring.length) {
      mrrSource = "recurring_charges";
      mrr = recurring.reduce((a, c) => a + (usdOf(c) ?? 0), 0);
      activeSubscribers = new Set(recurring.map(customerKey)).size;
      mrrByCurrency.USD = mrr;
    }
  }
  const churnEnd = to ?? now;
  const churnStart = from ?? churnEnd - 30 * DAY;
  let activeAtStart = 0;
  let canceled = 0;
  for (const sub of subs) {
    const started = sub.started_at ?? 0;
    const ended = !LIVE_SUB.has(sub.status);
    const endAt = ended ? (sub.canceled_at ?? sub.current_period_end ?? null) : null;
    if (started > churnStart) continue;
    // Ended with no end time (e.g. Whop "drafted"): never verifiably active.
    if (ended && endAt === null) continue;
    if (endAt !== null && endAt <= churnStart) continue;
    activeAtStart++;
    if (endAt !== null && endAt < churnEnd) canceled++;
  }
  const windowDays = Math.max(1, (churnEnd - churnStart) / DAY);
  const churnRate = activeAtStart ? canceled / activeAtStart : null;

  // ── LTV ──
  const monthlyChurn = churnRate !== null ? 1 - (1 - churnRate) ** (30 / windowDays) : null;
  let ltv: RevenueSummary["ltv"] = { cents: 0, method: "none" };
  const arpu = activeSubscribers ? mrr / activeSubscribers : 0;
  if (monthlyChurn && monthlyChurn > 0 && arpu > 0)
    ltv = { cents: Math.round(arpu / monthlyChurn), method: "arpu/churn" };
  else if (firstPaid.size) {
    const allGross = paid.reduce((a, c) => a + (usdOf(c) ?? 0), 0);
    const allRefunds = refundEvents.reduce((a, e) => a + (e.usd ?? 0), 0);
    ltv = {
      cents: Math.round((allGross - allRefunds) / firstPaid.size),
      method: "lifetime-average",
    };
  }

  // ── Breakdowns ──
  const months = new Map<string, Bucket & { refundsCents: number }>();
  const monthOf = (k: string) => {
    let m = months.get(k);
    if (!m) {
      m = { ...bucket(), refundsCents: 0 };
      months.set(k, m);
    }
    return m;
  };
  const byProduct = new Map<string, Bucket>();
  const byProductPlan = new Map<string, Bucket>();
  const byProject = new Map<string, Bucket>();
  const byAccount = new Map<string, Bucket & { refundsCents: number; feesCents: number }>();
  const bySource = new Map<string, Bucket>();
  const byCampaign = new Map<string, Bucket>();
  const top = new Map<string, Bucket & { row: TxnRow }>();
  type TimeBucket = { grossCents: number; netCents: number; count: number };
  const daily = new Map<string, TimeBucket>();
  const weekly = new Map<string, TimeBucket>();
  const monthly = new Map<string, TimeBucket>();
  const sourceTime = new Map<string, Map<string, { grossCents: number; netCents: number }>>();
  const projectMappings = new Map(
    (
      db.prepare("SELECT product_key,project FROM revenue_project_mappings").all() as Array<{
        product_key: string;
        project: string;
      }>
    ).map((row) => [row.product_key, row.project]),
  );
  const accountMeta = new Map(
    (
      db.prepare("SELECT id,label,provider FROM revenue_accounts").all() as Array<{
        id: string;
        label: string;
        provider: string;
      }>
    ).map((r) => [r.id, r]),
  );
  const addTime = (
    map: Map<string, TimeBucket>,
    key: string,
    gross: number,
    net: number,
    count = 1,
  ) => {
    const b = map.get(key) ?? { grossCents: 0, netCents: 0, count: 0 };
    b.grossCents += gross;
    b.netCents += net;
    b.count += count;
    map.set(key, b);
  };
  let recurringCents = 0;
  let recurringCount = 0;
  let oneTimeCents = 0;
  let oneTimeCount = 0;
  const add = (map: Map<string, Bucket>, key: string, c: TxnRow, usd: number) => {
    let b = map.get(key);
    if (!b) {
      b = bucket();
      map.set(key, b);
    }
    b.grossCents += usd;
    b.count++;
    b.customers.add(customerKey(c));
  };
  for (const c of periodPaid) {
    const usd = usdOf(c) ?? 0;
    const m = monthOf(monthKey(c.occurred_at));
    m.grossCents += usd;
    m.count++;
    m.customers.add(customerKey(c));
    add(byProduct, c.product_name ?? "(unknown)", c, usd);
    add(byProductPlan, JSON.stringify([c.product_name ?? "(unknown)", c.plan_id]), c, usd);
    const raw = parseJson<Record<string, unknown>>(c.raw, {});
    const allocations = Array.isArray(raw.projectAllocations)
      ? (raw.projectAllocations as Array<Record<string, unknown>>)
      : [];
    if (allocations.length) {
      const specified = allocations.reduce(
        (sum, allocation) =>
          sum + (typeof allocation.amountCents === "number" ? allocation.amountCents : 0),
        0,
      );
      for (const allocation of allocations) {
        const project =
          typeof allocation.project === "string" && allocation.project
            ? allocation.project
            : "Agency clients";
        const native =
          typeof allocation.amountCents === "number" && specified > 0
            ? Math.round((usd * allocation.amountCents) / specified)
            : Math.round(usd / allocations.length);
        add(byProject, project, c, native);
      }
    } else {
      add(
        byProject,
        c.project_id ??
          projectMappings.get(
            productKey(c.account_id, c.product_id, c.product_name ?? "(unknown)"),
          ) ??
          defaultProjectForProduct(c.product_name, {
            accountId: c.account_id,
            ...accountMeta.get(c.account_id),
          }),
        c,
        usd,
      );
    }
    let a = byAccount.get(c.account_id);
    if (!a) {
      a = { ...bucket(), refundsCents: 0, feesCents: 0 };
      byAccount.set(c.account_id, a);
    }
    a.grossCents += usd;
    a.count++;
    a.feesCents += usdScale(c, c.fee_cents) ?? 0;
    const fee = usdScale(c, c.fee_cents) ?? 0;
    addTime(daily, dayKey(c.occurred_at), usd, usd - fee);
    addTime(weekly, weekKey(c.occurred_at), usd, usd - fee);
    addTime(monthly, monthKey(c.occurred_at), usd, usd - fee);
    const sourcePeriods = sourceTime.get(c.account_id) ?? new Map();
    const sourcePeriod = sourcePeriods.get(monthKey(c.occurred_at)) ?? {
      grossCents: 0,
      netCents: 0,
    };
    sourcePeriod.grossCents += usd;
    sourcePeriod.netCents += usd - fee;
    sourcePeriods.set(monthKey(c.occurred_at), sourcePeriod);
    sourceTime.set(c.account_id, sourcePeriods);
    if (RECURRING_REASONS.has(c.billing_reason ?? "")) {
      recurringCents += usd;
      recurringCount++;
    } else {
      oneTimeCents += usd;
      oneTimeCount++;
    }
    add(bySource, c.contact_id ? (c.first_source_id ?? "") : "-", c, usd);
    add(byCampaign, c.campaign_id ?? c.first_campaign_id ?? "", c, usd);
    const k = customerKey(c);
    let t = top.get(k);
    if (!t) {
      t = { ...bucket(), row: c };
      top.set(k, t);
    }
    t.grossCents += usd;
    t.count++;
  }
  for (const e of refundEvents) {
    if (!inRange(e.at)) continue;
    monthOf(monthKey(e.at)).refundsCents += e.usd ?? 0;
    const a = byAccount.get(e.accountId);
    if (a) a.refundsCents += e.usd ?? 0;
    const sourcePeriods = sourceTime.get(e.accountId) ?? new Map();
    const sourcePeriod = sourcePeriods.get(monthKey(e.at)) ?? { grossCents: 0, netCents: 0 };
    sourcePeriod.netCents -= e.usd ?? 0;
    sourcePeriods.set(monthKey(e.at), sourcePeriod);
    sourceTime.set(e.accountId, sourcePeriods);
    addTime(daily, dayKey(e.at), 0, -(e.usd ?? 0), 0);
    addTime(weekly, weekKey(e.at), 0, -(e.usd ?? 0), 0);
    addTime(monthly, monthKey(e.at), 0, -(e.usd ?? 0), 0);
  }
  for (const d of disputes) {
    if (!inRange(d.occurred_at) || !LOST_DISPUTE.has(d.status)) continue;
    const parent = d.parent_external_id
      ? charges.get(`${d.account_id}|${d.parent_external_id}`)
      : undefined;
    const loss =
      d.amount_usd_cents ??
      (parent ? (usdScale(parent, d.gross_cents) ?? 0) : d.currency === "USD" ? d.gross_cents : 0);
    addTime(daily, dayKey(d.occurred_at), 0, -loss, 0);
    addTime(weekly, weekKey(d.occurred_at), 0, -loss, 0);
    addTime(monthly, monthKey(d.occurred_at), 0, -loss, 0);
  }
  const sourceMeta = new Map(
    (
      db.prepare("SELECT id,name,kind FROM sources").all() as Array<{
        id: string;
        name: string;
        kind: string;
      }>
    ).map((r) => [r.id, r]),
  );
  const campaignMeta = new Map(
    (db.prepare("SELECT id,name FROM campaigns").all() as Array<{ id: string; name: string }>).map(
      (r) => [r.id, r.name],
    ),
  );

  // ── Cohorts (first-purchase month × months since) ──
  const cohortMap = new Map<
    string,
    { customers: Set<string>; cells: Map<number, { revenue: number; retained: Set<string> }> }
  >();
  for (const c of paid) {
    const k = customerKey(c);
    const first = firstPaid.get(k);
    if (first === undefined) continue;
    const cohort = monthKey(first);
    const offset = monthsBetween(cohort, monthKey(c.occurred_at));
    let co = cohortMap.get(cohort);
    if (!co) {
      co = { customers: new Set(), cells: new Map() };
      cohortMap.set(cohort, co);
    }
    co.customers.add(k);
    if (offset > 12) continue;
    let cell = co.cells.get(offset);
    if (!cell) {
      cell = { revenue: 0, retained: new Set() };
      co.cells.set(offset, cell);
    }
    cell.revenue += usdOf(c) ?? 0;
    cell.retained.add(k);
  }

  const sortDesc = <T extends { grossCents: number }>(a: T[]) =>
    a.sort((x, y) => y.grossCents - x.grossCents);
  const netTotal = gross - refunds - fees - disputesLost;
  return {
    grossCents: gross,
    netCents: netTotal,
    feeCents: fees,
    refundCents: refunds,
    chargeCount: periodPaid.length,
    activeSubscriptions: activeSubscribers,
    churnRate,
    range: { from, to },
    currency: "USD",
    totals: {
      grossCents: gross,
      refundsCents: refunds,
      feesCents: fees,
      disputesLostCents: disputesLost,
      netCents: netTotal,
      count: periodPaid.length,
      avgOrderCents: periodPaid.length
        ? Math.round(gross / Math.max(1, periodPaid.length - unconverted))
        : 0,
      customers: customers.size,
      newCustomers,
      returningCustomers: customers.size - newCustomers,
      unconvertedCount: unconverted,
    },
    perCurrency: [...perCur.entries()]
      .map(([currency, v]) => ({
        currency,
        grossCents: v.grossCents,
        refundsCents: v.refundsCents,
        count: v.count,
        usdGrossCents: v.usdKnown ? v.usd : null,
      }))
      .sort((a, b) => b.grossCents - a.grossCents),
    mrrCents: mrr,
    arrCents: mrr * 12,
    mrrSource,
    mrrByCurrency,
    activeSubscribers,
    churn: { rate: churnRate, canceled, activeAtStart, windowDays: Math.round(windowDays) },
    ltv,
    byMonth: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({
        month,
        grossCents: m.grossCents,
        refundsCents: m.refundsCents,
        netCents: m.grossCents - m.refundsCents,
        count: m.count,
        customers: m.customers.size,
      })),
    byProduct: sortDesc(
      [...byProduct.entries()].map(([product, b]) => ({
        product,
        grossCents: b.grossCents,
        count: b.count,
      })),
    ).slice(0, 50),
    byProductPlan: sortDesc(
      [...byProductPlan.entries()].map(([key, b]) => {
        const [product, plan] = JSON.parse(key) as [string, string | null];
        return { product, plan, grossCents: b.grossCents, count: b.count };
      }),
    ).slice(0, 100),
    byProject: sortDesc(
      [...byProject.entries()].map(([project, b]) => ({
        project,
        grossCents: b.grossCents,
        count: b.count,
      })),
    ),
    byAccount: sortDesc(
      [...byAccount.entries()].map(([accountId, b]) => ({
        accountId,
        label: accountMeta.get(accountId)?.label ?? "(removed account)",
        provider: accountMeta.get(accountId)?.provider ?? "unknown",
        grossCents: b.grossCents,
        refundsCents: b.refundsCents,
        netCents: b.grossCents - b.refundsCents - b.feesCents,
        count: b.count,
      })),
    ),
    byRevenueSource: sortDesc(
      [...byAccount.entries()].map(([accountId, b]) => {
        const meta = accountMeta.get(accountId);
        const provider = meta?.provider ?? "unknown";
        const source =
          provider === "invoice"
            ? "Client invoices"
            : provider === "legacy" || provider === "manual"
              ? "Manual"
              : provider === "whop"
                ? `Whop ${meta?.label ?? ""}`.trim()
                : provider === "stripe"
                  ? `Stripe ${meta?.label ?? ""}`.trim()
                  : (meta?.label ?? provider);
        return {
          accountId,
          source,
          provider,
          grossCents: b.grossCents,
          refundsCents: b.refundsCents,
          feesCents: b.feesCents,
          netCents: b.grossCents - b.refundsCents - b.feesCents,
          count: b.count,
        };
      }),
    ),
    byTime: {
      daily: [...daily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, b]) => ({ period, ...b })),
      weekly: [...weekly.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, b]) => ({ period, ...b })),
      monthly: [...monthly.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, b]) => ({ period, ...b })),
    },
    sourceSeries: [...sourceTime.entries()]
      .map(([accountId, periods]) => {
        const meta = accountMeta.get(accountId);
        const provider = meta?.provider ?? "unknown";
        const source =
          provider === "invoice"
            ? "Client invoices"
            : provider === "legacy" || provider === "manual"
              ? "Manual"
              : provider === "whop"
                ? `Whop ${meta?.label ?? ""}`.trim()
                : provider === "stripe"
                  ? `Stripe ${meta?.label ?? ""}`.trim()
                  : (meta?.label ?? provider);
        return {
          source,
          points: [...periods.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([period, value]) => ({ period, ...value })),
        };
      })
      .sort(
        (a, b) =>
          b.points.reduce((sum, point) => sum + point.grossCents, 0) -
          a.points.reduce((sum, point) => sum + point.grossCents, 0),
      ),
    revenueMix: { recurringCents, oneTimeCents, recurringCount, oneTimeCount },
    bySource: sortDesc(
      [...bySource.entries()].map(([id, b]) => {
        const meta = id && id !== "-" ? sourceMeta.get(id) : undefined;
        return {
          sourceId: meta ? id : null,
          name: meta?.name ?? (id === "-" ? "(no contact)" : "(unattributed)"),
          kind: meta?.kind ?? null,
          grossCents: b.grossCents,
          count: b.count,
          customers: b.customers.size,
        };
      }),
    ),
    byCampaign: sortDesc(
      [...byCampaign.entries()].map(([id, b]) => ({
        campaignId: id || null,
        name: id ? (campaignMeta.get(id) ?? "(deleted campaign)") : "(no campaign)",
        grossCents: b.grossCents,
        count: b.count,
        customers: b.customers.size,
      })),
    ),
    cohorts: [...cohortMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([cohort, co]) => ({
        cohort,
        customers: co.customers.size,
        cells: [...co.cells.entries()]
          .sort(([a], [b]) => a - b)
          .map(([offset, cell]) => ({
            offset,
            revenueCents: cell.revenue,
            retained: cell.retained.size,
          })),
      })),
    topCustomers: sortDesc(
      [...top.entries()].map(([key, t]) => ({
        key,
        contactId: t.row.contact_id,
        clientId: t.row.client_id,
        email: t.row.customer_email,
        name: t.row.customer_name,
        grossCents: t.grossCents,
        count: t.count,
      })),
    ).slice(0, 10),
    refunds: rows
      .filter((r) => (r.type === "refund" || r.type === "dispute") && inRange(r.occurred_at))
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        amountCents: r.gross_cents,
        currency: r.currency,
        occurredAt: r.occurred_at,
        customerEmail: r.customer_email,
        product: r.product_name,
        parentExternalId: r.parent_external_id,
      })),
  };
}
