/**
 * Business hub revenue — import of the old `business/income.json` entries
 * (business.income.* store) into the ledger, under one provider "legacy"
 * account labelled "Imported income". Idempotent: entries are keyed by
 * their income id, so re-running only adds new entries. Entries that came
 * from Whop / Stripe keep the provider id in `parent_external_id`, which
 * metrics use to skip them once the real account is synced.
 * Never modifies income.json.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getMeta, setMeta, type HubDb } from "../db.js";
import { toCents, toMs } from "../util.js";
import { createAccount, getAccounts, legacyIncomePaths } from "./accounts.js";
import { linkLedger, upsertTxns } from "./ledger.js";
import { list, rec, s, upperCurrency, type LedgerRow } from "./types.js";

export const LEGACY_ACCOUNT_LABEL = "Imported income";
const BACKUP_META_KEY = "revenue.manualIncomeBackup.v1";

export type LegacyImportResult = {
  accountId: string | null;
  files: string[];
  entries: number;
  inserted: number;
  updated: number;
};

function entryToRow(raw: unknown): LedgerRow | null {
  const e = rec(raw);
  const id = s(e.id);
  if (!id) return null;
  const md = rec(e.metadata);
  const cents = toCents(e.amount);
  const occurred = toMs(e.date) ?? toMs(e.createdAt) ?? Date.now();
  const source = (s(e.source) ?? "manual").toLowerCase();
  const providerId = s(md.whopId) ?? s(md.stripeId) ?? s(md.chargeId) ?? s(md.squareId);
  const currency = upperCurrency(md.currency);
  return {
    externalId: id,
    type: cents < 0 ? "refund" : "charge",
    status: "succeeded",
    grossCents: Math.abs(cents),
    feeCents: 0,
    netCents: cents,
    refundedCents: 0,
    currency,
    amountUsdCents: currency === "USD" ? Math.abs(cents) : null,
    occurredAt: occurred,
    productId: s(md.productId),
    productName: s(e.description),
    planId: null,
    billingReason: source,
    customerRef: s(md.customerId),
    customerEmail: s(md.customerEmail)?.toLowerCase() ?? null,
    customerName: s(md.customerName),
    subscriptionRef: null,
    parentExternalId: providerId,
    raw: { source, streamId: s(e.streamId), businessId: s(e.businessId), legacy: true },
  };
}

/** Import income.json entries from <stateDir>/business and the old cwd-relative path. */
/** Import legacy income; returns the number of newly imported ledger rows. */
export async function migrateLegacyIncome(
  db: HubDb,
  stateDir: string,
  opts: { paths?: string[] } = {},
): Promise<number> {
  return (await migrateLegacyIncomeDetailed(db, stateDir, opts)).inserted;
}

export async function migrateLegacyIncomeDetailed(
  db: HubDb,
  stateDir: string,
  opts: { paths?: string[] } = {},
): Promise<LegacyImportResult> {
  const files = (opts.paths ?? legacyIncomePaths(stateDir)).filter((p) => existsSync(p));
  if (files.length && !getMeta(db, BACKUP_META_KEY)) {
    const backupDir = join(stateDir, "backups", "revenue-ledger-v1");
    mkdirSync(backupDir, { recursive: true });
    for (const [index, file] of files.entries()) {
      copyFileSync(file, join(backupDir, `${index}-${basename(file)}.bak`));
    }
    setMeta(db, BACKUP_META_KEY, JSON.stringify({ at: Date.now(), files }));
  }
  const rows: LedgerRow[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    for (const e of list(rec(data).entries)) {
      const row = entryToRow(e);
      if (!row || seen.has(row.externalId)) continue;
      seen.add(row.externalId);
      rows.push(row);
    }
  }
  const result: LegacyImportResult = {
    accountId: null,
    files,
    entries: rows.length,
    inserted: 0,
    updated: 0,
  };
  if (!rows.length) return result;
  let acct = getAccounts(db).find(
    (a) => a.provider === "legacy" && a.label === LEGACY_ACCOUNT_LABEL,
  );
  acct ??= await createAccount(db, { provider: "legacy", label: LEGACY_ACCOUNT_LABEL });
  result.accountId = acct.id;
  const account = { id: acct.id, provider: "legacy", label: acct.label };
  db.transaction(() => {
    const st = upsertTxns(db, account, rows);
    result.inserted = st.inserted;
    result.updated = st.updated;
    linkLedger(db, account, st.touchedIds);
  })();
  return result;
}
