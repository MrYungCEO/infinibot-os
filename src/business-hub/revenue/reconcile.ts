/**
 * Business hub revenue — reconciliation: compare the ledger with what the
 * provider reports, read-only.
 *
 * - Whop v1: page the payments list and summarise (count, paid gross,
 *   refunded) without storing anything.
 * - Whop v5: `pagination.total_count` of payments vs ledger charge count.
 * - Stripe: balance transactions over the period, summed by type
 *   (charge/payment vs refund/payment_refund) vs paid ledger charges.
 */

import type { HubDb } from "../db.js";
import { getAccount } from "./accounts.js";
import { stripePage } from "./stripe.js";
import { accountHttp, type SyncDeps } from "./sync.js";
import { REVENUE_STATUSES, majorToCents, n, rec, s, timeMs } from "./types.js";
import { detectWhopApiVersion, mapWhopPaymentStatus, whopV1Page, whopV5Page } from "./whop.js";

export type ReconcileTotals = {
  count: number | null;
  gross: number | null;
  refunds: number | null;
};

export type ReconcileResult = {
  accountId: string;
  providerName: string;
  apiVersion: string | null;
  method: string;
  range: { from: number | null; to: number | null };
  provider: ReconcileTotals;
  ledger: { count: number; gross: number; refunds: number; currencies: string[] };
  diff: ReconcileTotals;
  ok: boolean;
  pages: number;
};

export type ReconcileOptions = SyncDeps & {
  from?: number;
  to?: number;
  /** Safety cap on provider pages walked (default 5000). */
  maxPages?: number;
  signal?: AbortSignal;
};

function ledgerTotals(
  db: HubDb,
  accountId: string,
  from: number | null,
  to: number | null,
  paidOnly: boolean,
) {
  const rows = db
    .prepare(
      `SELECT type,status,gross_cents,refunded_cents,currency,external_id,parent_external_id FROM revenue_txns
       WHERE account_id = ? AND type IN ('charge','refund') AND (? IS NULL OR occurred_at >= ?) AND (? IS NULL OR occurred_at < ?)`,
    )
    .all(accountId, from, from, to, to) as Array<{
    type: string;
    status: string;
    gross_cents: number;
    refunded_cents: number;
    currency: string;
    external_id: string;
    parent_external_id: string | null;
  }>;
  const charges = rows.filter((r) => r.type === "charge");
  const paid = charges.filter((r) => REVENUE_STATUSES.has(r.status));
  return {
    count: paidOnly ? paid.length : charges.length,
    gross: paid.reduce((a, r) => a + r.gross_cents, 0),
    refunds: paid.reduce((a, r) => a + r.refunded_cents, 0),
    currencies: [...new Set(paid.map((r) => r.currency))],
  };
}

const diffOf = (p: number | null, l: number): number | null => (p === null ? null : l - p);

export async function reconcile(
  db: HubDb,
  accountId: string,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const acct = getAccount(db, accountId);
  if (!acct) throw new Error("account not found");
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const inRange = (t: number | null) =>
    t !== null && (from === null || t >= from) && (to === null || t < to);
  const maxPages = opts.maxPages ?? 5000;
  const provider: ReconcileTotals = { count: null, gross: null, refunds: null };
  let method = "none";
  let pages = 0;
  let apiVersion = acct.apiVersion;
  let paidOnly = false;

  if (acct.provider !== "legacy") {
    const http = await accountHttp(acct, opts, opts.signal);
    if (acct.provider === "whop") {
      if (apiVersion !== "v1" && apiVersion !== "v5")
        apiVersion = await detectWhopApiVersion(http, acct.companyRef);
      if (apiVersion === "v1" && acct.companyRef) {
        method = "whop-v1 payments walk";
        let cursor: string | null = null;
        let count = 0;
        let gross = 0;
        let refunds = 0;
        do {
          const page = await whopV1Page(http, "payments", acct.companyRef, { cursor });
          pages++;
          for (const it of page.items) {
            const p = rec(it);
            const at = timeMs(p.paid_at) ?? timeMs(p.created_at);
            if (!inRange(at)) continue;
            count++;
            const total = majorToCents(p.total) ?? 0;
            const refunded = majorToCents(p.refunded_amount) ?? 0;
            const st = mapWhopPaymentStatus({
              status: p.status,
              substatus: p.substatus,
              totalCents: total,
              refundedCents: refunded,
              failureMessage: p.failure_message,
            });
            if (REVENUE_STATUSES.has(st)) {
              gross += total;
              refunds += refunded;
            }
          }
          cursor = page.nextCursor;
        } while (cursor && pages < maxPages && !opts.signal?.aborted);
        Object.assign(provider, { count, gross, refunds });
      } else {
        method = "whop-v5 total_count";
        const page = await whopV5Page(http, "payments", 1, 1);
        pages++;
        provider.count = from === null && to === null ? (page.totalCount ?? null) : null;
      }
    } else if (acct.provider === "stripe") {
      method = "stripe balance_transactions";
      paidOnly = true;
      let cursor: string | null = null;
      let count = 0;
      let gross = 0;
      let refunds = 0;
      do {
        const page = await stripePage(http, "balance_transactions", {
          cursor,
          sinceMs: from,
          untilMs: to,
        });
        pages++;
        for (const it of page.items) {
          const bt = rec(it);
          const type = s(bt.type) ?? "";
          const amount = n(bt.amount) ?? 0;
          if (type === "charge" || type === "payment") {
            count++;
            gross += amount;
          } else if (type === "refund" || type === "payment_refund") refunds += Math.abs(amount);
        }
        cursor = page.nextCursor;
      } while (cursor && pages < maxPages && !opts.signal?.aborted);
      Object.assign(provider, { count, gross, refunds });
    }
  }

  const ledger = ledgerTotals(db, accountId, from, to, paidOnly);
  // Stripe balance amounts are in the settlement currency: compare gross only when single-currency.
  const grossComparable = acct.provider !== "stripe" || ledger.currencies.length <= 1;
  const diff: ReconcileTotals = {
    count: diffOf(provider.count, ledger.count),
    gross: grossComparable ? diffOf(provider.gross, ledger.gross) : null,
    refunds: grossComparable ? diffOf(provider.refunds, ledger.refunds) : null,
  };
  const ok =
    provider.count !== null &&
    diff.count === 0 &&
    (diff.gross === null || diff.gross === 0) &&
    (diff.refunds === null || diff.refunds === 0);
  return {
    accountId,
    providerName: acct.provider,
    apiVersion,
    method,
    range: { from, to },
    provider,
    ledger,
    diff,
    ok,
    pages,
  };
}
