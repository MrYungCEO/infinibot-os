/**
 * Business hub revenue — REAL read-only dry run against live Whop accounts.
 *
 * Keys are never read into this script's output: accounts are connected
 * with `env-file:` references (resolved by the sync at request time) and the
 * legacy income.json key is only compared by fingerprint. A full backfill
 * runs into a THROWAWAY sqlite file under /tmp, only per-account aggregates
 * are printed (no emails, names or ids), and the /tmp directory is deleted
 * at the end because it holds personal data.
 *
 * Usage:
 *   BH_DRYRUN_ACCOUNTS="FlyPic Studio=/path/to/.env.local,KinglyVault=/path/to/.env" \
 *   [BH_DRYRUN_LEGACY_INCOME=/path/to/state/business/income.json] \
 *   npx tsx scripts/business-hub/revenue-dry-run.mts
 * Each env file must define WHOP_API_KEY and WHOP_COMPANY_ID.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";

const TMP = "/tmp/bizhub-dryrun";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(`${TMP}/state`, { recursive: true });
// Isolate every state/config lookup from ~/.infinibot before loading modules.
process.env.INFINIBOT_STATE_DIR = `${TMP}/state`;

const ACCOUNTS = (process.env.BH_DRYRUN_ACCOUNTS ?? "")
  .split(",")
  .map((pair) => pair.trim())
  .filter(Boolean)
  .map((pair) => {
    const at = pair.indexOf("=");
    return { label: pair.slice(0, at).trim(), envFile: pair.slice(at + 1).trim() };
  });
if (!ACCOUNTS.length) {
  console.error('set BH_DRYRUN_ACCOUNTS="Label=/abs/path/.env,…"');
  process.exit(2);
}
const LEGACY_INCOME = process.env.BH_DRYRUN_LEGACY_INCOME ?? "";

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const { openHubDb } = await import("../../src/business-hub/db.js");
  const acc = await import("../../src/business-hub/revenue/accounts.js");
  const { syncAccount } = await import("../../src/business-hub/revenue/sync.js");
  const { revenueSummary, monthKey } = await import("../../src/business-hub/revenue/metrics.js");
  const { reconcile } = await import("../../src/business-hub/revenue/reconcile.js");

  // In-memory codec: nothing is encrypted to disk by this run.
  const vault = new Map<string, string>();
  const codec = {
    encrypt: (p: string) => {
      const id = `mem${vault.size}`;
      vault.set(id, p);
      return id;
    },
    decrypt: (b: string) => vault.get(b) ?? null,
  };

  const db = openHubDb(`${TMP}/hub.db`);
  try {
    const ids: Array<{ id: string; label: string }> = [];
    const fps = new Map<string, string>();
    for (const a of ACCOUNTS) {
      if (!existsSync(a.envFile)) {
        console.log(`${a.label}: env file missing — skipped`);
        continue;
      }
      const key = acc.readEnvFileVar(a.envFile, "WHOP_API_KEY");
      if (!key) {
        console.log(`${a.label}: WHOP_API_KEY not set — skipped`);
        continue;
      }
      fps.set(acc.fingerprint(key), a.label);
      const row = await acc.createAccount(
        db,
        {
          provider: "whop",
          label: a.label,
          companyRef: acc.readEnvFileVar(a.envFile, "WHOP_COMPANY_ID"),
          secretRef: `env-file:${a.envFile}#WHOP_API_KEY`,
        },
        codec,
      );
      ids.push({ id: row.id, label: a.label });
    }

    // Third key: legacy income.json — compare by fingerprint only.
    const cands = await acc.discoverAccounts(db, {
      env: {},
      incomePaths: LEGACY_INCOME ? [LEGACY_INCOME] : [],
      readConfig: () => undefined,
      codec,
    });
    for (const c of cands) {
      const same = fps.get(c.fingerprint);
      console.log(
        `legacy income.json ${c.provider} key: ${same ? `same key as ${same} (already connected, skipped)` : c.companyConnected ? "distinct key but same company as an already-connected account (skipped: would duplicate it)" : "distinct key"}`,
      );
      if (!same && !c.companyConnected && c.provider === "whop") {
        const row = await acc.connectDiscovered(
          db,
          c.fingerprint,
          { label: "Legacy income.json Whop" },
          {
            env: {},
            incomePaths: LEGACY_INCOME ? [LEGACY_INCOME] : [],
            readConfig: () => undefined,
            codec,
          },
        );
        ids.push({ id: row.id, label: row.label });
      }
    }

    for (const { id, label } of ids) {
      const t0 = Date.now();
      const r = await syncAccount(db, id, { mode: "backfill", deps: { codec } });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const count = (sql: string) => (db.prepare(sql).get(id) as { c: number }).c;
      const s = revenueSummary(db, { accountIds: [id] });
      const span = db
        .prepare(
          "SELECT MIN(occurred_at) a, MAX(occurred_at) b FROM revenue_txns WHERE account_id = ? AND type = 'charge' AND status IN ('succeeded','refunded','partially_refunded')",
        )
        .get(id) as { a: number | null; b: number | null };
      const statuses = db
        .prepare(
          "SELECT status, COUNT(*) c FROM revenue_txns WHERE account_id = ? AND type = 'charge' GROUP BY status ORDER BY c DESC",
        )
        .all(id) as Array<{ status: string; c: number }>;
      const refundStatuses = db
        .prepare(
          "SELECT r.status, COUNT(*) c, SUM(r.gross_cents) cents, SUM(CASE WHEN p.status IN ('succeeded','refunded','partially_refunded') THEN 1 ELSE 0 END) paidParent FROM revenue_txns r LEFT JOIN revenue_txns p ON p.account_id = r.account_id AND p.type = 'charge' AND p.external_id = r.parent_external_id WHERE r.account_id = ? AND r.type = 'refund' GROUP BY r.status",
        )
        .all(id) as Array<{ status: string; c: number; cents: number; paidParent: number }>;
      const subStatuses = db
        .prepare(
          "SELECT status, COUNT(*) c FROM revenue_subscriptions WHERE account_id = ? GROUP BY status ORDER BY c DESC",
        )
        .all(id) as Array<{ status: string; c: number }>;
      let rec: string;
      try {
        const x = await reconcile(db, id, { codec });
        rec = `${x.method}: provider count=${x.provider.count ?? "n/a"} gross=${x.provider.gross === null ? "n/a" : usd(x.provider.gross)} refunds=${x.provider.refunds === null ? "n/a" : usd(x.provider.refunds)} | ledger count=${x.ledger.count} gross=${usd(x.ledger.gross)} refunds=${usd(x.ledger.refunds)} | diff count=${x.diff.count ?? "n/a"} gross=${x.diff.gross ?? "n/a"} refunds=${x.diff.refunds ?? "n/a"} | ok=${x.ok}`;
      } catch (err) {
        rec = `failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      console.log(`\n=== ${label} ===`);
      console.log(
        `sync: ok=${r.ok}${r.error ? ` error="${r.error}"` : ""} apiVersion=${r.apiVersion} pages=${r.pagesFetched} requests=${r.requests} time=${secs}s`,
      );
      console.log(
        `objects: ${r.objects.map((o) => `${o.object}(pages=${o.pages}, rows=${o.fetched}, done=${o.backfillDone})`).join(", ")}`,
      );
      console.log(
        `rows: payments=${count("SELECT COUNT(*) c FROM revenue_txns WHERE account_id = ? AND type='charge'")} refunds=${count("SELECT COUNT(*) c FROM revenue_txns WHERE account_id = ? AND type='refund'")} disputes=${count("SELECT COUNT(*) c FROM revenue_txns WHERE account_id = ? AND type='dispute'")} memberships=${count("SELECT COUNT(*) c FROM revenue_subscriptions WHERE account_id = ?")} products+plans=${count("SELECT COUNT(*) c FROM revenue_products WHERE account_id = ?")}`,
      );
      console.log(
        `payment statuses: ${statuses.map((x) => `${x.status}=${x.c}`).join(", ") || "-"}`,
      );
      console.log(
        `refund rows: ${refundStatuses.map((x) => `${x.status}=${x.c} (${usd(x.cents)}, paid parent ${x.paidParent})`).join(", ") || "-"}`,
      );
      console.log(
        `membership statuses: ${subStatuses.map((x) => `${x.status}=${x.c}`).join(", ") || "-"}`,
      );
      console.log(
        `revenue (USD): paid=${s.totals.count} gross=${usd(s.totals.grossCents)} refunds=${usd(s.totals.refundsCents)} fees=${usd(s.totals.feesCents)} disputesLost=${usd(s.totals.disputesLostCents)} net=${usd(s.totals.netCents)} avgOrder=${usd(s.totals.avgOrderCents)} customers=${s.totals.customers} unconverted=${s.totals.unconvertedCount}`,
      );
      console.log(
        `first/last paid month: ${span.a ? monthKey(span.a) : "-"} / ${span.b ? monthKey(span.b) : "-"}`,
      );
      console.log(
        `MRR=${usd(s.mrrCents)} (${s.mrrSource}) ARR=${usd(s.arrCents)} activeSubs=${s.activeSubscribers} churn30d=${s.churn.rate === null ? "n/a" : `${(s.churn.rate * 100).toFixed(1)}%`} LTV=${usd(s.ltv.cents)} (${s.ltv.method})`,
      );
      console.log(
        `currencies: ${s.perCurrency.map((c) => `${c.currency}:${c.count}`).join(", ") || "-"}`,
      );
      console.log(`reconcile: ${rec}`);
    }
    const contacts = (db.prepare("SELECT COUNT(*) c FROM contacts").get() as { c: number }).c;
    console.log(`\ncontacts linked (throwaway DB): ${contacts}`);
  } finally {
    db.close();
    rmSync(TMP, { recursive: true, force: true });
    console.log(`removed ${TMP}: ${!existsSync(TMP)}`);
  }
}

main().catch((err: unknown) => {
  rmSync(TMP, { recursive: true, force: true });
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
