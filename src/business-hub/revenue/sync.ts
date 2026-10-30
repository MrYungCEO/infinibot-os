/**
 * Business hub revenue — the sync engine. `syncAccount` walks each provider
 * object with a resumable cursor in `revenue_sync_state` (persisted in the
 * same transaction as the page's upserts, so a crash resumes at the next
 * page), records the high-water mark, and on incremental runs re-reads from
 * high-water minus two days. Upserts are idempotent; after every page the
 * touched charges are linked to contacts / clients / deals and `onPayment`
 * fires once per newly-paid charge (the pipeline uses it for
 * payment.succeeded → Won). One sync per account at a time.
 *
 * `scheduleRevenueSync` runs an incremental sync of every active account
 * every 30 minutes; the gateway wires start/stop.
 */

import type { HubDb } from "../db.js";
import {
  getAccount,
  getAccounts,
  resolveAccountSecret,
  setAccountStatus,
  type RevenueAccount,
  type SecretCodec,
} from "./accounts.js";
import { createRevenueHttp, type FetchLike, type RevenueHttp } from "./http.js";
import {
  buildCatalog,
  linkLedger,
  linkSubscriptions,
  upsertProducts,
  upsertSubscriptions,
  upsertTxns,
  type PaymentEvent,
} from "./ledger.js";
import { stripeSpecs } from "./stripe.js";
import { errMessage, type LedgerTxn, type ObjectSpec, type SyncMode } from "./types.js";
import { detectWhopApiVersion, whopV1Specs, whopV5Specs, type WhopApiVersion } from "./whop.js";

export const INCREMENTAL_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;

export type SyncDeps = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** false disables throttling (tests). */
  rateLimit?: boolean | number;
  codec?: SecretCodec;
  /** Override key resolution (tests / dry runs). */
  resolveSecret?: (account: RevenueAccount) => Promise<string | null> | string | null;
  /** Fired once per charge that becomes paid and is linked to a contact. */
  onPayment?: (contactId: string, txn: LedgerTxn) => void | Promise<void>;
  log?: (msg: string) => void;
};

export type SyncOptions = {
  mode: SyncMode;
  objects?: string[];
  /** Max pages per object for this run (the cursor keeps the rest for later). */
  maxPages?: number;
  signal?: AbortSignal;
  deps?: SyncDeps;
};

export type ObjectSyncResult = {
  object: string;
  pages: number;
  fetched: number;
  inserted: number;
  updated: number;
  /** Walk reached the end (false when stopped by maxPages / error / abort). */
  complete: boolean;
  backfillDone: boolean;
  error: string | null;
};

export type SyncResult = {
  accountId: string;
  provider: string;
  apiVersion: string | null;
  mode: SyncMode;
  ok: boolean;
  error: string | null;
  pagesFetched: number;
  requests: number;
  payments: number;
  objects: ObjectSyncResult[];
  startedAt: number;
  finishedAt: number;
};

type StateRow = {
  cursor: string | null;
  backfill_done: number;
  high_water: number | null;
  fetched: number;
  pages: number;
};

function readState(db: HubDb, accountId: string, object: string): StateRow {
  const r = db
    .prepare(
      "SELECT cursor, backfill_done, high_water, fetched, pages FROM revenue_sync_state WHERE account_id = ? AND object = ?",
    )
    .get(accountId, object) as StateRow | undefined;
  return r ?? { cursor: null, backfill_done: 0, high_water: null, fetched: 0, pages: 0 };
}

function writeState(
  db: HubDb,
  accountId: string,
  object: string,
  st: StateRow,
  lastError: string | null,
): void {
  db.prepare(
    `INSERT INTO revenue_sync_state(account_id,object,cursor,backfill_done,high_water,fetched,pages,last_run_at,last_error)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id,object) DO UPDATE SET cursor=excluded.cursor, backfill_done=excluded.backfill_done,
       high_water=excluded.high_water, fetched=excluded.fetched, pages=excluded.pages,
       last_run_at=excluded.last_run_at, last_error=excluded.last_error`,
  ).run(
    accountId,
    object,
    st.cursor,
    st.backfill_done,
    st.high_water,
    st.fetched,
    st.pages,
    Date.now(),
    lastError,
  );
}

/** A GET-only client for an account's provider (throws when the key is unavailable). */
export async function accountHttp(
  acct: RevenueAccount,
  deps: SyncDeps = {},
  signal?: AbortSignal,
): Promise<RevenueHttp> {
  const key = deps.resolveSecret
    ? await deps.resolveSecret(acct)
    : await resolveAccountSecret(acct, deps.codec);
  if (!key) throw new Error("API key not available (check the secret / reference)");
  return createRevenueHttp({
    provider: acct.provider,
    apiKey: key,
    fetch: deps.fetch,
    sleep: deps.sleep,
    rateLimit: deps.rateLimit,
    signal,
  });
}

const running = new Map<string, Promise<SyncResult>>();

export function isSyncRunning(accountId: string): boolean {
  return running.has(accountId);
}

export function runningSyncs(): string[] {
  return [...running.keys()];
}

/** Sync one account. A second call while one is running joins the running sync. */
export function syncAccount(db: HubDb, accountId: string, opts: SyncOptions): Promise<SyncResult> {
  const cur = running.get(accountId);
  if (cur) return cur;
  const p = runSync(db, accountId, opts).finally(() => running.delete(accountId));
  running.set(accountId, p);
  return p;
}

async function specsFor(
  db: HubDb,
  acct: RevenueAccount,
  http: RevenueHttp,
  objects?: string[],
): Promise<{ specs: ObjectSpec[]; apiVersion: string | null }> {
  if (acct.provider === "stripe") return { specs: stripeSpecs(http, objects), apiVersion: "v1" };
  if (acct.provider !== "whop") return { specs: [], apiVersion: null };
  let version = acct.apiVersion as WhopApiVersion | null;
  if (version !== "v1" && version !== "v5") {
    version = await detectWhopApiVersion(http, acct.companyRef);
    setAccountStatus(db, acct.id, "syncing", { apiVersion: version });
  }
  if (version === "v1") {
    if (!acct.companyRef) throw new Error("Whop v1 needs a company id (biz_…)");
    return { specs: whopV1Specs(http, acct.companyRef, objects), apiVersion: version };
  }
  return { specs: whopV5Specs(http, objects), apiVersion: version };
}

async function runSync(db: HubDb, accountId: string, opts: SyncOptions): Promise<SyncResult> {
  const startedAt = Date.now();
  const deps = opts.deps ?? {};
  const acct = getAccount(db, accountId);
  if (!acct) throw new Error("account not found");
  const result: SyncResult = {
    accountId,
    provider: acct.provider,
    apiVersion: acct.apiVersion,
    mode: opts.mode,
    ok: true,
    error: null,
    pagesFetched: 0,
    requests: 0,
    payments: 0,
    objects: [],
    startedAt,
    finishedAt: startedAt,
  };
  if (acct.provider === "legacy") {
    result.finishedAt = Date.now();
    return result;
  }
  const fail = (msg: string) => {
    result.ok = false;
    result.error = msg;
    result.finishedAt = Date.now();
    setAccountStatus(db, accountId, "error", { lastError: msg });
    return result;
  };
  let key: string | null;
  try {
    key = deps.resolveSecret
      ? await deps.resolveSecret(acct)
      : await resolveAccountSecret(acct, deps.codec);
  } catch (err) {
    return fail(`could not resolve key: ${errMessage(err)}`);
  }
  if (!key) return fail("API key not available (check the secret / reference)");
  const http = createRevenueHttp({
    provider: acct.provider,
    apiKey: key,
    fetch: deps.fetch,
    sleep: deps.sleep,
    rateLimit: deps.rateLimit,
    signal: opts.signal,
  });
  setAccountStatus(db, accountId, "syncing");
  let specs: ObjectSpec[];
  try {
    const r = await specsFor(db, acct, http, opts.objects);
    specs = r.specs;
    result.apiVersion = r.apiVersion;
  } catch (err) {
    result.requests = http.requests;
    return fail(errMessage(err));
  }
  const pending: PaymentEvent[] = [];
  for (const spec of specs) {
    if (opts.signal?.aborted) break;
    const r = await syncObject(db, acct, spec, opts, pending);
    result.objects.push(r);
    result.pagesFetched += r.pages;
    if (r.error) {
      result.ok = false;
      result.error ??= `${spec.object}: ${r.error}`;
    }
    // Fire pipeline hooks after each object so a later failure never loses them.
    result.payments += await firePayments(pending.splice(0), deps);
  }
  linkSubscriptions(db, accountId);
  result.requests = http.requests;
  result.finishedAt = Date.now();
  if (opts.signal?.aborted && result.ok) {
    result.ok = false;
    result.error = "sync aborted";
  }
  setAccountStatus(db, accountId, result.ok ? "ok" : "error", {
    lastError: result.error,
    lastSyncAt: result.finishedAt,
  });
  deps.log?.(
    `[revenue] ${acct.provider} ${acct.label}: ${opts.mode} ${result.ok ? "ok" : "error"} pages=${result.pagesFetched}`,
  );
  return result;
}

async function firePayments(events: PaymentEvent[], deps: SyncDeps): Promise<number> {
  if (!deps.onPayment) return events.length;
  for (const e of events) {
    try {
      await deps.onPayment(e.contactId, e.txn);
    } catch (err) {
      deps.log?.(`[revenue] onPayment hook failed: ${errMessage(err)}`);
    }
  }
  return events.length;
}

async function syncObject(
  db: HubDb,
  acct: RevenueAccount,
  spec: ObjectSpec,
  opts: SyncOptions,
  pending: PaymentEvent[],
): Promise<ObjectSyncResult> {
  const out: ObjectSyncResult = {
    object: spec.object,
    pages: 0,
    fetched: 0,
    inserted: 0,
    updated: 0,
    complete: false,
    backfillDone: false,
    error: null,
  };
  const st = readState(db, acct.id, spec.object);
  // Full walk when asked, when history is incomplete, or for small catalogs.
  const backfill = opts.mode === "backfill" || st.backfill_done !== 1 || spec.fullRefresh === true;
  if (backfill && st.backfill_done === 1) {
    st.backfill_done = 0; // explicit re-walk (or catalog refresh) starts from the top
    st.cursor = null;
  }
  const sinceMs =
    !backfill && st.high_water !== null
      ? Math.max(0, st.high_water - INCREMENTAL_OVERLAP_MS)
      : null;
  let cursor: string | null = backfill ? st.cursor : null;
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const account = { id: acct.id, provider: acct.provider, label: acct.label };
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("sync aborted");
      if (out.pages >= maxPages) break;
      const page = await spec.fetchPage({
        cursor,
        mode: backfill ? "backfill" : "incremental",
        sinceMs,
      });
      const batch = spec.normalize(page.items, buildCatalog(db, acct.id));
      let hw = st.high_water;
      for (const it of page.items) {
        const t = spec.itemTime(it);
        if (t !== null && (hw === null || t > hw)) hw = t;
      }
      const touched = db.transaction(() => {
        const p = upsertProducts(db, acct.id, batch.products);
        const sub = upsertSubscriptions(db, account, batch.subs);
        const t = upsertTxns(db, account, batch.txns);
        out.inserted += p.inserted + sub.inserted + t.inserted;
        out.updated += p.updated + sub.updated + t.updated;
        st.high_water = hw;
        st.fetched += page.items.length;
        st.pages += 1;
        if (backfill) {
          st.cursor = page.nextCursor;
          if (!page.nextCursor) st.backfill_done = 1;
        }
        writeState(db, acct.id, spec.object, st, null);
        return t.touchedIds;
      })();
      out.pages++;
      out.fetched += page.items.length;
      if (touched.length || batch.txns.length) {
        const events = db.transaction(() => linkLedger(db, account, touched))();
        pending.push(...events);
      }
      cursor = page.nextCursor;
      if (!cursor) {
        out.complete = true;
        break;
      }
    }
  } catch (err) {
    out.error = errMessage(err);
    writeState(db, acct.id, spec.object, st, out.error);
  }
  out.backfillDone = st.backfill_done === 1;
  return out;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export const REVENUE_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export type RevenueScheduler = { stop(): void; tick(): Promise<SyncResult[]> };

let activeScheduler: RevenueScheduler | null = null;

/** Accounts the scheduler syncs: Whop/Stripe, not paused. */
export function activeAccounts(db: HubDb): RevenueAccount[] {
  return getAccounts(db).filter(
    (a) => (a.provider === "whop" || a.provider === "stripe") && a.status !== "paused",
  );
}

/**
 * Start the incremental sync loop (replaces any previous one). The first
 * tick runs after `initialDelayMs` (default 60 s) so gateway start stays fast.
 */
export function scheduleRevenueSync(opts: {
  getDb: () => HubDb;
  intervalMs?: number;
  initialDelayMs?: number;
  deps?: SyncDeps;
}): RevenueScheduler {
  activeScheduler?.stop();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<SyncResult[]> => {
    const db = opts.getDb();
    const out: SyncResult[] = [];
    for (const a of activeAccounts(db)) {
      if (stopped) break;
      try {
        out.push(await syncAccount(db, a.id, { mode: "incremental", deps: opts.deps }));
      } catch (err) {
        opts.deps?.log?.(`[revenue] scheduled sync failed: ${errMessage(err)}`);
      }
    }
    return out;
  };
  const loop = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(() => loop(opts.intervalMs ?? REVENUE_SYNC_INTERVAL_MS));
    }, delay);
    timer.unref?.();
  };
  loop(opts.initialDelayMs ?? 60_000);
  const sched: RevenueScheduler = {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (activeScheduler === sched) activeScheduler = null;
    },
    tick,
  };
  activeScheduler = sched;
  return sched;
}

export function stopRevenueSync(): void {
  activeScheduler?.stop();
}
