/**
 * SQLite-backed credit ledger. Lives at ~/.infinibot/credits/ledger.db.
 *
 * Migration strategy: every column added after the initial schema goes
 * through `ensureColumn()` which is a safe no-op when the column is
 * already present. `schema_version` is bumped so future code can detect
 * data older than a particular feature.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CreditBudget, CreditEntry, ProviderSyncCursor } from "./types.js";
import type { ProviderPlanUsage } from "./plan-pullers/types.js";

const log = createSubsystemLogger("credits");

const SCHEMA_VERSION = 2;

const COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "id", ddl: "TEXT PRIMARY KEY" },
  { name: "timestamp", ddl: "INTEGER NOT NULL" },
  { name: "provider", ddl: "TEXT NOT NULL" },
  { name: "model", ddl: "TEXT NOT NULL" },
  { name: "kind", ddl: "TEXT NOT NULL DEFAULT 'chat'" },
  { name: "agent_backend", ddl: "TEXT NOT NULL DEFAULT 'unknown'" },
  { name: "tokens_in", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "tokens_out", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "cache_read_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "cache_write_tokens", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "cost_usd", ddl: "REAL NOT NULL DEFAULT 0" },
  { name: "cost_breakdown", ddl: "TEXT" },
  { name: "request_id", ddl: "TEXT" },
  { name: "session_key", ddl: "TEXT" },
  { name: "task_id", ddl: "TEXT" },
  { name: "project_id", ddl: "TEXT" },
  { name: "business_id", ddl: "TEXT" },
  { name: "context_id", ddl: "TEXT" },
  { name: "workflow_id", ddl: "TEXT" },
  { name: "cron_id", ddl: "TEXT" },
  { name: "agent_id", ddl: "TEXT" },
  { name: "autonomous", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "latency_ms", ddl: "INTEGER" },
  { name: "success", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { name: "error_kind", ddl: "TEXT" },
  { name: "source", ddl: "TEXT" },
];

export interface CreditStoreOptions {
  /** Absolute path to the DB file. Defaults to ~/.infinibot/credits/ledger.db. */
  dbPath?: string;
}

export class CreditStore {
  readonly db: Database.Database;
  readonly dbPath: string;

  constructor(opts: CreditStoreOptions = {}) {
    this.dbPath = opts.dbPath ?? path.join(resolveStateDir(), "credits", "ledger.db");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credit_entries (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS credit_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS credit_budgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope_axis TEXT NOT NULL,
        scope_value TEXT,
        monthly_limit_usd REAL NOT NULL,
        warn_threshold_pct REAL NOT NULL DEFAULT 80,
        hard_threshold_pct REAL NOT NULL DEFAULT 100,
        block_on_hard INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credit_sync_cursors (
        provider TEXT PRIMARY KEY,
        last_sync_at INTEGER,
        last_reconciled_total_usd REAL,
        status TEXT NOT NULL DEFAULT 'configured',
        message TEXT
      );

      CREATE TABLE IF NOT EXISTS provider_plan_usage (
        provider TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        detected_plan TEXT,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        used_tokens INTEGER,
        used_usd REAL,
        remaining_tokens INTEGER,
        remaining_usd REAL,
        limit_usd REAL,
        limit_tokens INTEGER,
        source TEXT NOT NULL DEFAULT 'estimated',
        status TEXT NOT NULL DEFAULT 'ok',
        message TEXT,
        fetched_at INTEGER NOT NULL
      );
    `);

    const existing = new Set<string>(
      (this.db.prepare("PRAGMA table_info(credit_entries)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const col of COLUMNS) {
      if (!existing.has(col.name)) {
        try {
          this.db.exec(
            `ALTER TABLE credit_entries ADD COLUMN ${col.name} ${col.ddl.replace(/^TEXT PRIMARY KEY$/, "TEXT")}`,
          );
        } catch (e) {
          // PRIMARY KEY can't be added via ALTER; ignore for the id column.
          if (col.name !== "id")
            log.warn("credits.alter-failed", { col: col.name, err: String(e) });
        }
      }
    }

    // Additive migration for pre-existing provider_plan_usage tables that
    // predate the detected_plan column (CREATE IF NOT EXISTS won't add it).
    {
      const ppuCols = new Set<string>(
        (
          this.db.prepare("PRAGMA table_info(provider_plan_usage)").all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      if (!ppuCols.has("detected_plan")) {
        try {
          this.db.exec("ALTER TABLE provider_plan_usage ADD COLUMN detected_plan TEXT");
        } catch (e) {
          log.warn("credits.alter-failed", { col: "detected_plan", err: String(e) });
        }
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_credit_timestamp ON credit_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_credit_provider_ts ON credit_entries(provider, timestamp);
      CREATE INDEX IF NOT EXISTS idx_credit_backend_ts ON credit_entries(agent_backend, timestamp);
      CREATE INDEX IF NOT EXISTS idx_credit_project_ts ON credit_entries(project_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_credit_session ON credit_entries(session_key);
      CREATE INDEX IF NOT EXISTS idx_credit_task ON credit_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_credit_workflow ON credit_entries(workflow_id);
    `);

    this.db
      .prepare(
        `INSERT INTO credit_meta(key, value) VALUES('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(SCHEMA_VERSION));

    const count = (
      this.db.prepare("SELECT COUNT(*) AS c FROM credit_entries").get() as { c: number }
    ).c;
    log.info("Credit ledger loaded", { path: this.dbPath, entries: count, schema: SCHEMA_VERSION });
  }

  insert(entry: CreditEntry, source: string): CreditEntry {
    const stmt = this.db.prepare(`
      INSERT INTO credit_entries (
        id, timestamp, provider, model, kind, agent_backend,
        tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
        cost_usd, cost_breakdown, request_id, session_key, task_id,
        project_id, business_id, context_id, workflow_id, cron_id, agent_id,
        autonomous, latency_ms, success, error_kind, source
      ) VALUES (
        @id, @timestamp, @provider, @model, @kind, @agentBackend,
        @tokensIn, @tokensOut, @cacheReadTokens, @cacheWriteTokens,
        @costUsd, @costBreakdown, @requestId, @sessionKey, @taskId,
        @projectId, @businessId, @contextId, @workflowId, @cronId, @agentId,
        @autonomous, @latencyMs, @success, @errorKind, @source
      )
      ON CONFLICT(id) DO NOTHING
    `);
    stmt.run({
      id: entry.id,
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      kind: entry.kind,
      agentBackend: entry.agentBackend,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      costUsd: entry.costUsd,
      costBreakdown: entry.costBreakdown ? JSON.stringify(entry.costBreakdown) : null,
      requestId: entry.requestId ?? null,
      sessionKey: entry.sessionKey ?? null,
      taskId: entry.taskId ?? null,
      projectId: entry.projectId ?? null,
      businessId: entry.businessId ?? null,
      contextId: entry.contextId ?? null,
      workflowId: entry.workflowId ?? null,
      cronId: entry.cronId ?? null,
      agentId: entry.agentId ?? null,
      autonomous: entry.autonomous ? 1 : 0,
      latencyMs: entry.latencyMs ?? null,
      success: entry.success ? 1 : 0,
      errorKind: entry.errorKind ?? null,
      source,
    });
    return entry;
  }

  recent(limit = 50, cursor?: number): CreditEntry[] {
    const where = cursor ? "WHERE timestamp < ?" : "";
    const args: unknown[] = cursor ? [cursor, limit] : [limit];
    const rows = this.db
      .prepare(`SELECT * FROM credit_entries ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...args) as RawRow[];
    return rows.map(rowToEntry);
  }

  bySession(sessionKey: string, limit = 200): CreditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM credit_entries WHERE session_key = ? ORDER BY timestamp ASC LIMIT ?`)
      .all(sessionKey, limit) as RawRow[];
    return rows.map(rowToEntry);
  }

  byTask(taskId: string): CreditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM credit_entries WHERE task_id = ? ORDER BY timestamp ASC`)
      .all(taskId) as RawRow[];
    return rows.map(rowToEntry);
  }

  byProject(projectId: string, limit = 1000): CreditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM credit_entries WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(projectId, limit) as RawRow[];
    return rows.map(rowToEntry);
  }

  rawSql(sql: string, ...params: unknown[]): unknown[] {
    return this.db.prepare(sql).all(...params) as unknown[];
  }

  // ── Budgets ─────────────────────────────────────────────────

  listBudgets(): CreditBudget[] {
    return (
      this.db.prepare("SELECT * FROM credit_budgets ORDER BY created_at DESC").all() as Array<
        Record<string, unknown>
      >
    ).map(rowToBudget);
  }

  upsertBudget(b: CreditBudget): void {
    this.db
      .prepare(
        `INSERT INTO credit_budgets
         (id, name, scope_axis, scope_value, monthly_limit_usd, warn_threshold_pct, hard_threshold_pct, block_on_hard, created_at, updated_at)
       VALUES (@id, @name, @scopeAxis, @scopeValue, @monthlyLimitUsd, @warnThresholdPct, @hardThresholdPct, @blockOnHard, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         scope_axis = excluded.scope_axis,
         scope_value = excluded.scope_value,
         monthly_limit_usd = excluded.monthly_limit_usd,
         warn_threshold_pct = excluded.warn_threshold_pct,
         hard_threshold_pct = excluded.hard_threshold_pct,
         block_on_hard = excluded.block_on_hard,
         updated_at = excluded.updated_at`,
      )
      .run({
        id: b.id,
        name: b.name,
        scopeAxis: b.scopeAxis,
        scopeValue: b.scopeValue ?? null,
        monthlyLimitUsd: b.monthlyLimitUsd,
        warnThresholdPct: b.warnThresholdPct,
        hardThresholdPct: b.hardThresholdPct,
        blockOnHard: b.blockOnHard ? 1 : 0,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      });
  }

  deleteBudget(id: string): void {
    this.db.prepare("DELETE FROM credit_budgets WHERE id = ?").run(id);
  }

  // ── Sync cursors ────────────────────────────────────────────

  listSyncCursors(): ProviderSyncCursor[] {
    return (
      this.db.prepare("SELECT * FROM credit_sync_cursors").all() as Array<Record<string, unknown>>
    ).map((r) => ({
      provider: String(r.provider),
      lastSyncAt: (r.last_sync_at as number | null) ?? undefined,
      lastReconciledTotalUsd: (r.last_reconciled_total_usd as number | null) ?? undefined,
      status: ((r.status as string) ?? "configured") as ProviderSyncCursor["status"],
      message: (r.message as string | null) ?? undefined,
    }));
  }

  upsertSyncCursor(c: ProviderSyncCursor): void {
    this.db
      .prepare(
        `INSERT INTO credit_sync_cursors (provider, last_sync_at, last_reconciled_total_usd, status, message)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         last_reconciled_total_usd = excluded.last_reconciled_total_usd,
         status = excluded.status,
         message = excluded.message`,
      )
      .run(
        c.provider,
        c.lastSyncAt ?? null,
        c.lastReconciledTotalUsd ?? null,
        c.status,
        c.message ?? null,
      );
  }

  // ── Plan usage cache (provider_plan_usage) ──────────────────

  listPlanUsage(): ProviderPlanUsage[] {
    return (
      this.db.prepare("SELECT * FROM provider_plan_usage").all() as Array<Record<string, unknown>>
    ).map(rowToPlanUsage);
  }

  getPlanUsage(provider: string): ProviderPlanUsage | undefined {
    const row = this.db
      .prepare("SELECT * FROM provider_plan_usage WHERE provider = ?")
      .get(provider) as Record<string, unknown> | undefined;
    return row ? rowToPlanUsage(row) : undefined;
  }

  upsertPlanUsage(u: ProviderPlanUsage): void {
    this.db
      .prepare(
        `INSERT INTO provider_plan_usage
           (provider, plan, detected_plan, period_start, period_end, used_tokens, used_usd,
            remaining_tokens, remaining_usd, limit_usd, limit_tokens, source, status, message, fetched_at)
         VALUES
           (@provider, @plan, @detectedPlan, @periodStart, @periodEnd, @usedTokens, @usedUsd,
            @remainingTokens, @remainingUsd, @limitUsd, @limitTokens, @source, @status, @message, @fetchedAt)
         ON CONFLICT(provider) DO UPDATE SET
            plan = excluded.plan,
            detected_plan = excluded.detected_plan,
            period_start = excluded.period_start,
            period_end = excluded.period_end,
            used_tokens = excluded.used_tokens,
            used_usd = excluded.used_usd,
            remaining_tokens = excluded.remaining_tokens,
            remaining_usd = excluded.remaining_usd,
            limit_usd = excluded.limit_usd,
            limit_tokens = excluded.limit_tokens,
            source = excluded.source,
            status = excluded.status,
            message = excluded.message,
            fetched_at = excluded.fetched_at`,
      )
      .run({
        provider: u.provider,
        plan: u.plan,
        detectedPlan: u.detectedPlan ?? null,
        periodStart: u.periodStart,
        periodEnd: u.periodEnd,
        usedTokens: u.usedTokens ?? null,
        usedUsd: u.usedUsd ?? null,
        remainingTokens: u.remainingTokens ?? null,
        remainingUsd: u.remainingUsd ?? null,
        limitUsd: u.limitUsd ?? null,
        limitTokens: u.limitTokens ?? null,
        source: u.source,
        status: u.status,
        message: u.message ?? null,
        fetchedAt: u.fetchedAt,
      });
  }

  deletePlanUsage(provider: string): void {
    this.db.prepare("DELETE FROM provider_plan_usage WHERE provider = ?").run(provider);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

// ── Per-state-dir instances ────────────────────────────────────
//
// Keyed by the ledger db path so concurrent tenants (SaaS mode) each get their
// own ledger, and a profile switch never leaks one tenant's ledger to another.
// Single-user local mode keeps exactly one entry.

const stores = new Map<string, CreditStore>();

function ledgerPathFor(dbPath?: string): string {
  return dbPath ?? path.join(resolveStateDir(), "credits", "ledger.db");
}

export function initCreditLedger(opts: CreditStoreOptions = {}): CreditStore {
  const key = ledgerPathFor(opts.dbPath);
  let store = stores.get(key);
  if (!store) {
    store = new CreditStore(opts);
    stores.set(key, store);
  }
  return store;
}

export function getCreditStore(): CreditStore {
  const key = ledgerPathFor();
  let store = stores.get(key);
  if (!store) {
    store = new CreditStore();
    stores.set(key, store);
  }
  return store;
}

export function isCreditStoreInitialized(): boolean {
  return stores.size > 0;
}

export function closeCreditStore(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}

// ── Row helpers ────────────────────────────────────────────────

interface RawRow {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  kind: string;
  agent_backend: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  cost_breakdown: string | null;
  request_id: string | null;
  session_key: string | null;
  task_id: string | null;
  project_id: string | null;
  business_id: string | null;
  context_id: string | null;
  workflow_id: string | null;
  cron_id: string | null;
  agent_id: string | null;
  autonomous: number;
  latency_ms: number | null;
  success: number;
  error_kind: string | null;
}

function rowToEntry(r: RawRow): CreditEntry {
  return {
    id: r.id,
    timestamp: r.timestamp,
    provider: r.provider,
    model: r.model,
    kind: (r.kind as CreditEntry["kind"]) ?? "chat",
    agentBackend: (r.agent_backend as CreditEntry["agentBackend"]) ?? "unknown",
    tokensIn: r.tokens_in ?? 0,
    tokensOut: r.tokens_out ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0,
    costUsd: r.cost_usd ?? 0,
    costBreakdown: r.cost_breakdown ? safeJson(r.cost_breakdown) : undefined,
    requestId: r.request_id ?? undefined,
    sessionKey: r.session_key ?? undefined,
    taskId: r.task_id ?? undefined,
    projectId: r.project_id ?? undefined,
    businessId: r.business_id ?? undefined,
    contextId: r.context_id ?? undefined,
    workflowId: r.workflow_id ?? undefined,
    cronId: r.cron_id ?? undefined,
    agentId: r.agent_id ?? undefined,
    autonomous: r.autonomous === 1,
    latencyMs: r.latency_ms ?? undefined,
    success: r.success !== 0,
    errorKind: r.error_kind ?? undefined,
  };
}

function rowToBudget(r: Record<string, unknown>): CreditBudget {
  return {
    id: String(r.id),
    name: String(r.name),
    scopeAxis: (r.scope_axis as CreditBudget["scopeAxis"]) ?? "all",
    scopeValue: (r.scope_value as string | null) ?? undefined,
    monthlyLimitUsd: Number(r.monthly_limit_usd ?? 0),
    warnThresholdPct: Number(r.warn_threshold_pct ?? 80),
    hardThresholdPct: Number(r.hard_threshold_pct ?? 100),
    blockOnHard: (r.block_on_hard as number) === 1,
    createdAt: Number(r.created_at ?? Date.now()),
    updatedAt: Number(r.updated_at ?? Date.now()),
  };
}

function rowToPlanUsage(r: Record<string, unknown>): ProviderPlanUsage {
  const num = (v: unknown): number | undefined =>
    v === null || v === undefined ? undefined : Number(v);
  return {
    provider: String(r.provider),
    plan: String(r.plan),
    detectedPlan: (r.detected_plan as string | null) ?? undefined,
    periodStart: Number(r.period_start ?? 0),
    periodEnd: Number(r.period_end ?? 0),
    usedTokens: num(r.used_tokens),
    usedUsd: num(r.used_usd),
    remainingTokens: num(r.remaining_tokens),
    remainingUsd: num(r.remaining_usd),
    limitUsd: num(r.limit_usd),
    limitTokens: num(r.limit_tokens),
    source: ((r.source as string) ?? "estimated") as ProviderPlanUsage["source"],
    status: ((r.status as string) ?? "ok") as ProviderPlanUsage["status"],
    message: (r.message as string | null) ?? undefined,
    fetchedAt: Number(r.fetched_at ?? 0),
  };
}

function safeJson<T = unknown>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}
