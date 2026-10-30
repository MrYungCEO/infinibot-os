/**
 * Business hub RPC — revenue (`hub.revenue.*`): connected Whop / Stripe
 * accounts (masked; keys are never returned), key discovery, async sync
 * with status, metrics summary, ledger, subscriptions and reconciliation.
 * The pipeline wires `configureRevenueRpc({ onPayment })` so payments from
 * RPC-, webhook- or schedule-triggered syncs reach `pipeline.applyEvent`.
 */

import { resolveStateDirWithLegacyEnv } from "../../config/paths.js";
import {
  connectDiscovered,
  createAccount,
  discoverAccounts,
  getAccount,
  listAccounts,
  maskAccount,
  removeAccount,
  updateAccount,
  type AccountPatch,
} from "../revenue/accounts.js";
import { listLedger, listSubscriptions } from "../revenue/ledger.js";
import { revenueSummary } from "../revenue/metrics.js";
import {
  listProductProjectMappings,
  revenueArAging,
  setProductProjectMapping,
  syncAgencyRevenueToLedger,
} from "../revenue/canonical.js";
import { migrateLegacyIncomeDetailed } from "../revenue/legacy.js";
import { reconcile } from "../revenue/reconcile.js";
import {
  activeAccounts,
  isSyncRunning,
  runningSyncs,
  syncAccount,
  type SyncDeps,
} from "../revenue/sync.js";
import type { RevenueProvider, SyncMode } from "../revenue/types.js";
import {
  HubError,
  defineHubHandlers,
  optBool,
  optNum,
  optStr,
  reqStr,
  strArr,
  type HubCtx,
} from "./helpers.js";

let rpcDeps: SyncDeps = {};

/** Wire hooks used by RPC-triggered syncs (pipeline automation, logging). */
export function configureRevenueRpc(deps: SyncDeps): void {
  rpcDeps = { ...rpcDeps, ...deps };
}

export const REVENUE_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = {
  "hub.revenue.accounts.list": "read",
  "hub.revenue.accounts.discover": "read",
  "hub.revenue.accounts.connect": "admin",
  "hub.revenue.accounts.update": "admin",
  "hub.revenue.accounts.remove": "admin",
  "hub.revenue.sync": "write",
  "hub.revenue.syncStatus": "read",
  "hub.revenue.summary": "read",
  "hub.revenue.ledger": "read",
  "hub.revenue.reconcile": "read",
  "hub.revenue.subscriptions": "read",
  "hub.revenue.arAging": "read",
  "hub.revenue.projectMappings.list": "read",
  "hub.revenue.projectMappings.set": "write",
  "hub.revenue.invoices.sync": "write",
};

const PROVIDERS: readonly RevenueProvider[] = ["whop", "stripe"];

function startSync(ctx: HubCtx, accountId: string, mode: SyncMode): boolean {
  if (isSyncRunning(accountId)) return false;
  ctx.broadcast("hub.revenue.sync", { accountId, phase: "started", mode });
  void syncAccount(ctx.db, accountId, { mode, deps: rpcDeps })
    .then((r) =>
      ctx.broadcast("hub.revenue.sync", {
        accountId,
        phase: "done",
        ok: r.ok,
        error: r.error,
        pagesFetched: r.pagesFetched,
        payments: r.payments,
      }),
    )
    .catch((err: unknown) =>
      ctx.broadcast("hub.revenue.sync", {
        accountId,
        phase: "done",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  return true;
}

function mustAccount(ctx: HubCtx, id: string) {
  const a = getAccount(ctx.db, id);
  if (!a) throw new HubError("account not found", "NOT_FOUND");
  return a;
}

function mode(p: Record<string, unknown>): SyncMode {
  const m = optStr(p, "mode") ?? "incremental";
  if (m !== "backfill" && m !== "incremental")
    throw new HubError("mode must be backfill or incremental");
  return m;
}

export const revenueHubHandlers = defineHubHandlers({
  "hub.revenue.accounts.list": (_p, ctx) => ({
    accounts: listAccounts(ctx.db).filter(
      (account) => account.provider === "whop" || account.provider === "stripe",
    ),
  }),

  "hub.revenue.accounts.discover": async (_p, ctx) => ({
    candidates: await discoverAccounts(ctx.db, { stateDir: resolveStateDirWithLegacyEnv() }),
  }),

  "hub.revenue.accounts.connect": async (p, ctx) => {
    const candidate = optStr(p, "candidate");
    let account;
    if (candidate) {
      account = await connectDiscovered(
        ctx.db,
        candidate,
        { label: optStr(p, "label"), businessId: optStr(p, "businessId") ?? null },
        { stateDir: resolveStateDirWithLegacyEnv() },
      );
    } else {
      const provider = reqStr(p, "provider") as RevenueProvider;
      if (!PROVIDERS.includes(provider)) throw new HubError("provider must be whop or stripe");
      account = await createAccount(ctx.db, {
        provider,
        label: reqStr(p, "label"),
        companyRef: optStr(p, "companyRef") ?? null,
        secret: optStr(p, "secret") ?? null,
        secretRef: optStr(p, "secretRef") ?? null,
        webhookSecret: optStr(p, "webhookSecret") ?? null,
        businessId: optStr(p, "businessId") ?? null,
      });
    }
    const syncStarted =
      optBool(p, "sync") === false ? false : startSync(ctx, account.id, "backfill");
    return { account: maskAccount(ctx.db, account), syncStarted };
  },

  "hub.revenue.accounts.update": async (p, ctx) => {
    const id = reqStr(p, "id");
    mustAccount(ctx, id);
    const patch: AccountPatch = {};
    const label = optStr(p, "label");
    if (label) patch.label = label;
    if ("companyRef" in p) patch.companyRef = optStr(p, "companyRef") ?? null;
    const secret = optStr(p, "secret");
    if (secret) patch.secret = secret;
    const secretRef = optStr(p, "secretRef");
    if (secretRef) patch.secretRef = secretRef;
    if ("webhookSecret" in p) patch.webhookSecret = optStr(p, "webhookSecret") ?? null;
    const paused = optBool(p, "paused");
    if (paused !== undefined) patch.status = paused ? "paused" : "idle";
    if ("businessId" in p) patch.businessId = optStr(p, "businessId") ?? null;
    const a = await updateAccount(ctx.db, id, patch);
    return { account: maskAccount(ctx.db, a) };
  },

  "hub.revenue.accounts.remove": (p, ctx) => {
    const id = reqStr(p, "id");
    if (isSyncRunning(id))
      throw new HubError("a sync is running for this account; try again shortly");
    return removeAccount(ctx.db, id, { purgeLedger: optBool(p, "purgeLedger") === true });
  },

  "hub.revenue.sync": (p, ctx) => {
    const m = mode(p);
    const id = optStr(p, "accountId");
    const ids = id ? [mustAccount(ctx, id).id] : activeAccounts(ctx.db).map((a) => a.id);
    const started: string[] = [];
    const alreadyRunning: string[] = [];
    for (const a of ids) (startSync(ctx, a, m) ? started : alreadyRunning).push(a);
    return { started, alreadyRunning, mode: m };
  },

  "hub.revenue.syncStatus": (_p, ctx) => ({
    running: runningSyncs(),
    accounts: listAccounts(ctx.db).map((a) => ({
      id: a.id,
      label: a.label,
      provider: a.provider,
      status: a.status,
      lastSyncAt: a.lastSyncAt,
      lastError: a.lastError,
      sync: a.sync,
      counts: a.counts,
    })),
  }),

  "hub.revenue.summary": async (p, ctx) => {
    const stateDir = resolveStateDirWithLegacyEnv();
    const invoiceMerge = syncAgencyRevenueToLedger(ctx.db, { stateDir });
    const manualMerge = await migrateLegacyIncomeDetailed(ctx.db, stateDir);
    const from = optNum(p, "from");
    const to = optNum(p, "to");
    const accountIds = strArr(p, "accountIds");
    const summary = revenueSummary(ctx.db, { from, to, accountIds });
    const duration = from !== undefined && to !== undefined ? to - from : 0;
    const previous =
      duration > 0
        ? revenueSummary(ctx.db, { from: from! - duration, to: from, accountIds })
        : null;
    return {
      ...summary,
      previousPeriod: previous
        ? {
            grossCents: previous.grossCents,
            netCents: previous.netCents,
            feeCents: previous.feeCents,
            refundsCents: previous.totals.refundsCents,
            disputesLostCents: previous.totals.disputesLostCents,
            mrrCents: previous.mrrCents,
          }
        : null,
      arAging: revenueArAging(ctx.db, optNum(p, "asOf") ?? Date.now()),
      merge: { invoices: invoiceMerge, manual: manualMerge },
    };
  },

  "hub.revenue.ledger": async (p, ctx) => {
    const stateDir = resolveStateDirWithLegacyEnv();
    syncAgencyRevenueToLedger(ctx.db, { stateDir });
    await migrateLegacyIncomeDetailed(ctx.db, stateDir);
    return listLedger(ctx.db, {
      accountId: optStr(p, "accountId"),
      type: optStr(p, "type"),
      status: optStr(p, "status"),
      q: optStr(p, "q"),
      from: optNum(p, "from"),
      to: optNum(p, "to"),
      contactId: optStr(p, "contactId"),
      limit: optNum(p, "limit"),
      offset: optNum(p, "offset"),
    });
  },

  "hub.revenue.reconcile": async (p, ctx) => {
    const id = reqStr(p, "accountId");
    mustAccount(ctx, id);
    return reconcile(ctx.db, id, { ...rpcDeps, from: optNum(p, "from"), to: optNum(p, "to") });
  },

  "hub.revenue.subscriptions": (p, ctx) =>
    listSubscriptions(ctx.db, {
      accountId: optStr(p, "accountId"),
      status: optStr(p, "status"),
      contactId: optStr(p, "contactId"),
      limit: optNum(p, "limit"),
      offset: optNum(p, "offset"),
    }),

  "hub.revenue.arAging": (_p, ctx) => {
    syncAgencyRevenueToLedger(ctx.db, { stateDir: resolveStateDirWithLegacyEnv() });
    return revenueArAging(ctx.db);
  },

  "hub.revenue.projectMappings.list": (_p, ctx) => ({
    projects: listProductProjectMappings(ctx.db),
  }),

  "hub.revenue.projectMappings.set": (p, ctx) => ({
    mapping: setProductProjectMapping(ctx.db, {
      accountId: reqStr(p, "accountId"),
      productId: optStr(p, "productId") ?? null,
      productName: reqStr(p, "productName"),
      project: reqStr(p, "project"),
    }),
  }),

  "hub.revenue.invoices.sync": (_p, ctx) =>
    syncAgencyRevenueToLedger(ctx.db, { stateDir: resolveStateDirWithLegacyEnv() }),
});
