/**
 * Business hub revenue — the ledger store: idempotent upserts of
 * `revenue_txns` (unique on account × type × external id),
 * `revenue_subscriptions` and `revenue_products`, the plan/product catalog
 * the normalisers read, contact / client / deal linking (with exactly one
 * `payment` activity per charge) and the ledger / subscription queries
 * behind the RPCs.
 */

import { ensureSource, getContact, logActivity, upsertContact } from "../contacts.js";
import type { HubDb } from "../db.js";
import { hubId, parseJson } from "../util.js";
import {
  REVENUE_STATUSES,
  rec,
  type Catalog,
  type LedgerRow,
  type LedgerTxn,
  type PlanInfo,
  type ProductRow,
  type SubscriptionRow,
} from "./types.js";

type Row = Record<string, unknown>;

export type UpsertStats = { inserted: number; updated: number; touchedIds: string[] };

export function emptyStats(): UpsertStats {
  return { inserted: 0, updated: 0, touchedIds: [] };
}

/** Insert or update ledger rows; unchanged rows are left alone. */
export function upsertTxns(
  db: HubDb,
  account: { id: string; provider: string },
  rows: LedgerRow[],
): UpsertStats {
  const stats = emptyStats();
  const find = db.prepare(
    "SELECT id,status,gross_cents,fee_cents,net_cents,refunded_cents,amount_usd_cents,product_name,customer_email FROM revenue_txns WHERE account_id = ? AND type = ? AND external_id = ?",
  );
  const ins = db.prepare(
    `INSERT INTO revenue_txns(id,account_id,provider,external_id,type,status,gross_cents,fee_cents,net_cents,refunded_cents,currency,amount_usd_cents,occurred_at,product_id,product_name,plan_id,billing_reason,customer_ref,customer_email,customer_name,subscription_ref,parent_external_id,raw,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const upd = db.prepare(
    `UPDATE revenue_txns SET status=?,gross_cents=?,fee_cents=?,net_cents=?,refunded_cents=?,currency=?,amount_usd_cents=?,occurred_at=?,
       product_id=COALESCE(?,product_id),product_name=COALESCE(?,product_name),plan_id=COALESCE(?,plan_id),billing_reason=COALESCE(?,billing_reason),
       customer_ref=COALESCE(?,customer_ref),customer_email=COALESCE(?,customer_email),customer_name=COALESCE(?,customer_name),
       subscription_ref=COALESCE(?,subscription_ref),parent_external_id=COALESCE(?,parent_external_id),raw=?,updated_at=? WHERE id=?`,
  );
  const now = Date.now();
  for (const r of rows) {
    const cur = find.get(account.id, r.type, r.externalId) as Row | undefined;
    const raw = JSON.stringify(r.raw ?? {});
    if (!cur) {
      const id = hubId("txn");
      ins.run(
        id,
        account.id,
        account.provider,
        r.externalId,
        r.type,
        r.status,
        r.grossCents,
        r.feeCents,
        r.netCents,
        r.refundedCents,
        r.currency,
        r.amountUsdCents,
        r.occurredAt,
        r.productId,
        r.productName,
        r.planId,
        r.billingReason,
        r.customerRef,
        r.customerEmail,
        r.customerName,
        r.subscriptionRef,
        r.parentExternalId,
        raw,
        now,
        now,
      );
      stats.inserted++;
      stats.touchedIds.push(id);
      continue;
    }
    const changed =
      cur.status !== r.status ||
      cur.gross_cents !== r.grossCents ||
      cur.fee_cents !== r.feeCents ||
      cur.net_cents !== r.netCents ||
      cur.refunded_cents !== r.refundedCents ||
      (cur.amount_usd_cents ?? null) !== r.amountUsdCents ||
      (!cur.product_name && !!r.productName) ||
      (!cur.customer_email && !!r.customerEmail);
    if (!changed) continue;
    upd.run(
      r.status,
      r.grossCents,
      r.feeCents,
      r.netCents,
      r.refundedCents,
      r.currency,
      r.amountUsdCents,
      r.occurredAt,
      r.productId,
      r.productName,
      r.planId,
      r.billingReason,
      r.customerRef,
      r.customerEmail,
      r.customerName,
      r.subscriptionRef,
      r.parentExternalId,
      raw,
      now,
      cur.id,
    );
    stats.updated++;
    stats.touchedIds.push(cur.id as string);
  }
  return stats;
}

export function upsertSubscriptions(
  db: HubDb,
  account: { id: string; provider: string },
  rows: SubscriptionRow[],
): UpsertStats {
  const stats = emptyStats();
  const find = db.prepare(
    "SELECT id,status,amount_cents,canceled_at,current_period_end,interval FROM revenue_subscriptions WHERE account_id = ? AND external_id = ?",
  );
  const now = Date.now();
  for (const r of rows) {
    const cur = find.get(account.id, r.externalId) as Row | undefined;
    const vals = [
      r.status,
      r.productId,
      r.productName,
      r.planId,
      r.interval,
      r.intervalCount,
      r.amountCents,
      r.currency,
      r.customerRef,
      r.customerEmail,
      r.startedAt,
      r.canceledAt,
      r.currentPeriodEnd,
      JSON.stringify(r.raw ?? {}),
      now,
    ];
    if (!cur) {
      const id = hubId("rsub");
      db.prepare(
        `INSERT INTO revenue_subscriptions(id,account_id,provider,external_id,status,product_id,product_name,plan_id,interval,interval_count,amount_cents,currency,customer_ref,customer_email,started_at,canceled_at,current_period_end,raw,updated_at,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, account.id, account.provider, r.externalId, ...vals, now);
      stats.inserted++;
      stats.touchedIds.push(id);
      continue;
    }
    if (
      cur.status === r.status &&
      cur.amount_cents === r.amountCents &&
      (cur.canceled_at ?? null) === r.canceledAt &&
      (cur.current_period_end ?? null) === r.currentPeriodEnd &&
      (cur.interval ?? null) === r.interval
    )
      continue;
    db.prepare(
      `UPDATE revenue_subscriptions SET status=?,product_id=?,product_name=?,plan_id=?,interval=?,interval_count=?,amount_cents=?,currency=?,customer_ref=?,customer_email=?,started_at=?,canceled_at=?,current_period_end=?,raw=?,updated_at=? WHERE id=?`,
    ).run(...vals, cur.id);
    stats.updated++;
    stats.touchedIds.push(cur.id as string);
  }
  return stats;
}

export function upsertProducts(db: HubDb, accountId: string, rows: ProductRow[]): UpsertStats {
  const stats = emptyStats();
  const now = Date.now();
  for (const r of rows) {
    const cur = db
      .prepare("SELECT id,name,raw FROM revenue_products WHERE account_id = ? AND external_id = ?")
      .get(accountId, r.externalId) as Row | undefined;
    const raw = JSON.stringify(r.raw ?? {});
    if (!cur) {
      const id = hubId("rprod");
      db.prepare(
        "INSERT INTO revenue_products(id,account_id,external_id,name,raw,updated_at) VALUES(?,?,?,?,?,?)",
      ).run(id, accountId, r.externalId, r.name, raw, now);
      stats.inserted++;
      stats.touchedIds.push(id);
    } else if (cur.name !== r.name || cur.raw !== raw) {
      db.prepare("UPDATE revenue_products SET name=?, raw=?, updated_at=? WHERE id=?").run(
        r.name,
        raw,
        now,
        cur.id,
      );
      stats.updated++;
      stats.touchedIds.push(cur.id as string);
    }
  }
  return stats;
}

/** Plan / product lookups over what has been synced for an account. */
export function buildCatalog(db: HubDb, accountId: string): Catalog {
  const plans = new Map<string, PlanInfo>();
  const products = new Map<string, string>();
  for (const r of db
    .prepare("SELECT external_id, name, raw FROM revenue_products WHERE account_id = ?")
    .all(accountId) as Array<{ external_id: string; name: string; raw: string }>) {
    const raw = rec(parseJson<unknown>(r.raw, {}));
    if (raw.kind === "plan") {
      plans.set(r.external_id, {
        productId: (raw.productId as string) ?? null,
        productName: (raw.productName as string) ?? null,
        interval: (raw.interval as PlanInfo["interval"]) ?? null,
        intervalCount: typeof raw.intervalCount === "number" ? raw.intervalCount : 1,
        renewalCents: typeof raw.renewalCents === "number" ? raw.renewalCents : null,
        initialCents: typeof raw.initialCents === "number" ? raw.initialCents : null,
        currency: (raw.currency as string) ?? null,
      });
    } else products.set(r.external_id, r.name);
  }
  return {
    plan: (id) => (id ? (plans.get(id) ?? null) : null),
    productName: (id) => (id ? (products.get(id) ?? null) : null),
  };
}

// ── Linking ───────────────────────────────────────────────────────────────────

export function rowToTxn(r: Row, withRaw = false): LedgerTxn {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    provider: r.provider as string,
    externalId: r.external_id as string,
    type: r.type as LedgerTxn["type"],
    status: r.status as string,
    grossCents: r.gross_cents as number,
    feeCents: r.fee_cents as number,
    netCents: r.net_cents as number,
    refundedCents: r.refunded_cents as number,
    currency: r.currency as string,
    amountUsdCents: (r.amount_usd_cents as number) ?? null,
    occurredAt: r.occurred_at as number,
    productId: (r.product_id as string) ?? null,
    productName: (r.product_name as string) ?? null,
    planId: (r.plan_id as string) ?? null,
    billingReason: (r.billing_reason as string) ?? null,
    customerRef: (r.customer_ref as string) ?? null,
    customerEmail: (r.customer_email as string) ?? null,
    customerName: (r.customer_name as string) ?? null,
    subscriptionRef: (r.subscription_ref as string) ?? null,
    parentExternalId: (r.parent_external_id as string) ?? null,
    contactId: (r.contact_id as string) ?? null,
    clientId: (r.client_id as string) ?? null,
    companyId: (r.company_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    dealId: (r.deal_id as string) ?? null,
    campaignId: (r.campaign_id as string) ?? null,
    invoiceId: (r.invoice_id as string) ?? null,
    raw: withRaw ? parseJson<unknown>(r.raw, {}) : undefined,
  };
}

export type PaymentEvent = { contactId: string; txn: LedgerTxn };

function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * Link charges (by customer email) to contacts, clients and deals; log one
 * `payment` activity per paid charge; copy links from charges onto their
 * refunds / disputes. Returns the payment events for `onPayment`.
 */
export function linkLedger(
  db: HubDb,
  account: { id: string; provider: string; label: string },
  txnIds: string[],
): PaymentEvent[] {
  const events: PaymentEvent[] = [];
  if (txnIds.length) {
    const sourceKind =
      account.provider === "stripe" ? "stripe" : account.provider === "whop" ? "whop" : "legacy";
    let sourceId: string | null = null;
    const getRow = db.prepare("SELECT * FROM revenue_txns WHERE id = ?");
    const hasActivity = db.prepare(
      "SELECT 1 FROM activities WHERE subject_type = 'contact' AND subject_id = ? AND type = 'payment' AND json_extract(data, '$.txnId') = ? LIMIT 1",
    );
    const dealFor = db.prepare(
      "SELECT id FROM deals WHERE contact_id = ? AND status IN ('won','open') ORDER BY (status = 'won') DESC, updated_at DESC LIMIT 1",
    );
    const setLinks = db.prepare(
      "UPDATE revenue_txns SET contact_id = ?, client_id = COALESCE(?, client_id), deal_id = COALESCE(?, deal_id), campaign_id = COALESCE(?, campaign_id) WHERE id = ?",
    );
    for (const id of txnIds) {
      const r = getRow.get(id) as Row | undefined;
      if (!r || r.type !== "charge" || !r.customer_email) continue;
      const paid = REVENUE_STATUSES.has(r.status as string);
      let contactId = (r.contact_id as string) ?? null;
      if (!contactId || paid) {
        sourceId ??= ensureSource(db, sourceKind, account.label);
        const res = upsertContact(
          db,
          {
            email: r.customer_email as string,
            name: (r.customer_name as string) ?? null,
            lifecycle: paid ? "customer" : undefined,
          },
          { sourceId, actor: "revenue-sync", matchOnly: !paid },
        );
        contactId = res?.contact.id ?? contactId;
      }
      if (!contactId) continue;
      const contact = getContact(db, contactId);
      const deal = dealFor.get(contactId) as { id: string } | undefined;
      setLinks.run(
        contactId,
        contact?.clientId ?? null,
        deal?.id ?? null,
        contact?.firstCampaignId ?? null,
        id,
      );
      if (paid && !hasActivity.get(contactId, id)) {
        const txn = rowToTxn(getRow.get(id) as Row);
        logActivity(db, {
          subjectType: "contact",
          subjectId: contactId,
          type: "payment",
          summary: `Payment ${formatMoney(txn.grossCents, txn.currency)}${txn.productName ? ` — ${txn.productName}` : ""}`,
          actor: "revenue-sync",
          occurredAt: txn.occurredAt,
          data: {
            txnId: id,
            externalId: txn.externalId,
            accountId: account.id,
            provider: account.provider,
            amountCents: txn.grossCents,
            currency: txn.currency,
            product: txn.productName,
            status: txn.status,
          },
        });
        events.push({ contactId, txn });
      }
    }
  }
  // Refunds / disputes inherit customer + links from their parent charge.
  db.prepare(
    `UPDATE revenue_txns AS r SET
       customer_email = COALESCE(r.customer_email, p.customer_email),
       customer_name = COALESCE(r.customer_name, p.customer_name),
       customer_ref = COALESCE(r.customer_ref, p.customer_ref),
       product_name = COALESCE(r.product_name, p.product_name),
       contact_id = COALESCE(r.contact_id, p.contact_id),
       client_id = COALESCE(r.client_id, p.client_id),
       deal_id = COALESCE(r.deal_id, p.deal_id),
       campaign_id = COALESCE(r.campaign_id, p.campaign_id)
     FROM revenue_txns AS p
     WHERE r.account_id = ? AND r.type IN ('refund','dispute') AND p.account_id = r.account_id
       AND p.type = 'charge' AND p.external_id = r.parent_external_id
       AND (r.contact_id IS NULL OR r.customer_email IS NULL)
       AND (p.contact_id IS NOT NULL OR p.customer_email IS NOT NULL)`,
  ).run(account.id);
  return events;
}

/** Attach subscriptions to existing contacts by email (never creates contacts). */
export function linkSubscriptions(db: HubDb, accountId: string): number {
  return db
    .prepare(
      `UPDATE revenue_subscriptions SET contact_id = (SELECT id FROM contacts WHERE email = lower(revenue_subscriptions.customer_email))
       WHERE account_id = ? AND contact_id IS NULL AND customer_email IS NOT NULL
         AND EXISTS (SELECT 1 FROM contacts WHERE email = lower(revenue_subscriptions.customer_email))`,
    )
    .run(accountId).changes;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export type LedgerQuery = {
  accountId?: string;
  type?: string;
  status?: string;
  q?: string;
  from?: number;
  to?: number;
  contactId?: string;
  limit?: number;
  offset?: number;
};

export function listLedger(db: HubDb, q: LedgerQuery = {}): { rows: LedgerTxn[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...p: unknown[]) => {
    where.push(sql);
    params.push(...p);
  };
  if (q.accountId) add("account_id = ?", q.accountId);
  if (q.type) add("type = ?", q.type);
  if (q.status) add("status = ?", q.status);
  if (q.contactId) add("contact_id = ?", q.contactId);
  if (q.from !== undefined) add("occurred_at >= ?", q.from);
  if (q.to !== undefined) add("occurred_at < ?", q.to);
  if (q.q) {
    const like = `%${q.q.toLowerCase()}%`;
    add(
      "(lower(COALESCE(customer_email,'')) LIKE ? OR lower(COALESCE(customer_name,'')) LIKE ? OR lower(COALESCE(product_name,'')) LIKE ? OR external_id = ?)",
      like,
      like,
      like,
      q.q,
    );
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM revenue_txns ${w}`).get(...params) as { c: number }
  ).c;
  const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
  const rows = db
    .prepare(`SELECT * FROM revenue_txns ${w} ORDER BY occurred_at DESC, id LIMIT ? OFFSET ?`)
    .all(...params, limit, Math.max(0, q.offset ?? 0)) as Row[];
  return { rows: rows.map((r) => rowToTxn(r)), total };
}

export type SubscriptionView = Omit<SubscriptionRow, "raw"> & {
  id: string;
  accountId: string;
  provider: string;
  contactId: string | null;
};

export function listSubscriptions(
  db: HubDb,
  q: {
    accountId?: string;
    status?: string;
    contactId?: string;
    limit?: number;
    offset?: number;
  } = {},
): { rows: SubscriptionView[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.accountId) {
    where.push("account_id = ?");
    params.push(q.accountId);
  }
  if (q.status) {
    where.push("status = ?");
    params.push(q.status);
  }
  if (q.contactId) {
    where.push("contact_id = ?");
    params.push(q.contactId);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM revenue_subscriptions ${w}`).get(...params) as {
      c: number;
    }
  ).c;
  const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
  const rows = db
    .prepare(
      `SELECT * FROM revenue_subscriptions ${w} ORDER BY COALESCE(started_at, created_at) DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, Math.max(0, q.offset ?? 0)) as Row[];
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id as string,
      accountId: r.account_id as string,
      provider: r.provider as string,
      externalId: r.external_id as string,
      status: r.status as string,
      productId: (r.product_id as string) ?? null,
      productName: (r.product_name as string) ?? null,
      planId: (r.plan_id as string) ?? null,
      interval: (r.interval as SubscriptionRow["interval"]) ?? null,
      intervalCount: r.interval_count as number,
      amountCents: r.amount_cents as number,
      currency: r.currency as string,
      customerRef: (r.customer_ref as string) ?? null,
      customerEmail: (r.customer_email as string) ?? null,
      contactId: (r.contact_id as string) ?? null,
      startedAt: (r.started_at as number) ?? null,
      canceledAt: (r.canceled_at as number) ?? null,
      currentPeriodEnd: (r.current_period_end as number) ?? null,
    })),
  };
}
