/**
 * Report System — SQLite store.
 *
 * Tables live in the shared `~/.infinibot/databases.db` (same file the generic
 * DatabasesStore uses) but in their own dedicated tables (`reports`,
 * `report_schedules`, `report_triggers`, `report_insights`). We open our own
 * better-sqlite3 connection rather than going through DatabasesStore because the
 * render worker is a *separate process* and needs an independent handle — WAL
 * mode makes concurrent connections to the same file safe.
 *
 * The schema is created idempotently on first open (`CREATE TABLE IF NOT
 * EXISTS`) and column-add migrations follow the project's `safeAddColumn`
 * pattern, so both the gateway and the worker can call {@link getReportsStore}
 * and converge on the same schema regardless of who boots first.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { ensureReportParityColumns } from "./migrations/0002-report-parity.js";
import type {
  ReportInsightRecord,
  ReportKind,
  ReportRecord,
  ReportScheduleRecord,
  ReportSink,
  ReportStatus,
  ReportTrigger,
  ReportTriggerRecord,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  theme           TEXT NOT NULL DEFAULT 'black-gold',
  status          TEXT NOT NULL DEFAULT 'queued',
  source_record_id TEXT,
  trigger         TEXT NOT NULL DEFAULT 'manual',
  created_at      INTEGER NOT NULL,
  rendered_at     INTEGER,
  file_path       TEXT,
  file_size       INTEGER,
  summary_text    TEXT,
  config_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_kind ON reports(kind);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

CREATE TABLE IF NOT EXISTS report_schedules (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  cron         TEXT NOT NULL,
  theme        TEXT NOT NULL DEFAULT 'black-gold',
  enabled      INTEGER NOT NULL DEFAULT 1,
  sinks_json   TEXT NOT NULL DEFAULT '["ui"]',
  last_run_at  INTEGER,
  next_run_at  INTEGER,
  config_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS report_triggers (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  theme        TEXT NOT NULL DEFAULT 'black-gold',
  sinks_json   TEXT NOT NULL DEFAULT '["ui","telegram"]',
  config_json  TEXT NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_triggers_event ON report_triggers(event_type);

CREATE TABLE IF NOT EXISTS report_insights (
  id          TEXT PRIMARY KEY,
  report_id   TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  action      TEXT,
  severity    TEXT NOT NULL DEFAULT 'info',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_created ON report_insights(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insights_kind ON report_insights(kind);
`;

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getReportsStore(stateDir?: string): ReportsStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new ReportsStore(db, dir);
}

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new Database(resolve(stateDir, "databases.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

/** Idempotent column-add migrations (project convention: never throw on dup). */
function applyMigrations(db: Database.Database): void {
  const safeAddColumn = (table: string, column: string, def: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message ?? "")) throw err;
    }
  };
  // Reserved for future columns — keep the hook wired so installs created
  // against an older schema converge on the latest shape.
  safeAddColumn("reports", "config_json", "TEXT NOT NULL DEFAULT '{}'");
  // Parity-context columns (category + markdown copy). Idempotent — both the
  // gateway and the render worker converge on the same shape on boot.
  ensureReportParityColumns(db);
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> RECORD MAPPING
// ═══════════════════════════════════════════════════════════════════

type ReportRow = {
  id: string;
  kind: string;
  title: string;
  theme: string;
  status: string;
  source_record_id: string | null;
  trigger: string;
  created_at: number;
  rendered_at: number | null;
  file_path: string | null;
  file_size: number | null;
  summary_text: string | null;
  config_json: string;
  category: string | null;
  source_agent: string | null;
  source_session: string | null;
  original_format: string | null;
  markdown_path: string | null;
  markdown_body: string | null;
};

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function rowToReport(r: ReportRow): ReportRecord {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    theme: r.theme,
    status: r.status as ReportStatus,
    sourceRecordId: r.source_record_id,
    trigger: r.trigger as ReportTrigger,
    createdAt: r.created_at,
    renderedAt: r.rendered_at,
    filePath: r.file_path,
    fileSize: r.file_size,
    summaryText: r.summary_text,
    config: safeParse<Record<string, unknown>>(r.config_json, {}),
    category: r.category ?? null,
    sourceAgent: r.source_agent ?? null,
    sourceSession: r.source_session ?? null,
    originalFormat: r.original_format ?? null,
    markdownPath: r.markdown_path ?? null,
    markdownBody: r.markdown_body ?? null,
    department: ((r as Record<string, unknown>).department as string | null) ?? null,
    tags: [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class ReportsStore {
  constructor(
    private readonly db: Database.Database,
    public readonly stateDir: string,
  ) {}

  // ── reports ──────────────────────────────────────────────────────

  createReport(input: {
    kind: ReportKind;
    title?: string;
    theme?: string;
    trigger?: ReportTrigger;
    sourceRecordId?: string | null;
    config?: Record<string, unknown>;
    category?: string | null;
    sourceAgent?: string | null;
    sourceSession?: string | null;
    originalFormat?: string | null;
  }): ReportRecord {
    const id = `rpt_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO reports
          (id, kind, title, theme, status, source_record_id, trigger, created_at, config_json,
           category, source_agent, source_session, original_format)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.title ?? `${input.kind} report`,
        input.theme ?? "black-gold",
        input.sourceRecordId ?? null,
        input.trigger ?? "manual",
        now,
        JSON.stringify(input.config ?? {}),
        input.category ?? null,
        input.sourceAgent ?? null,
        input.sourceSession ?? null,
        input.originalFormat ?? null,
      );
    return this.getReport(id)!;
  }

  getReport(id: string): ReportRecord | null {
    const row = this.db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as
      | ReportRow
      | undefined;
    return row ? rowToReport(row) : null;
  }

  listReports(
    opts: {
      kind?: string;
      status?: ReportStatus;
      category?: string;
      department?: string;
      excludeKind?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): { reports: ReportRecord[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.excludeKind) {
      where.push("kind != ?");
      args.push(opts.excludeKind);
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.category) {
      where.push("category = ?");
      args.push(opts.category);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM reports ${whereSql}`).get(...args) as {
        n: number;
      }
    ).n;
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM reports ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as ReportRow[];
    return { reports: rows.map(rowToReport), total };
  }

  updateReport(
    id: string,
    patch: Partial<{
      status: ReportStatus;
      title: string;
      renderedAt: number | null;
      filePath: string | null;
      fileSize: number | null;
      summaryText: string | null;
      sourceRecordId: string | null;
      config: Record<string, unknown>;
      category: string | null;
      sourceAgent: string | null;
      sourceSession: string | null;
      originalFormat: string | null;
      markdownPath: string | null;
      markdownBody: string | null;
    }>,
  ): ReportRecord | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    const map: Record<string, string> = {
      status: "status",
      title: "title",
      renderedAt: "rendered_at",
      filePath: "file_path",
      fileSize: "file_size",
      summaryText: "summary_text",
      sourceRecordId: "source_record_id",
      category: "category",
      sourceAgent: "source_agent",
      sourceSession: "source_session",
      originalFormat: "original_format",
      markdownPath: "markdown_path",
      markdownBody: "markdown_body",
    };
    for (const [key, col] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${col} = ?`);
        args.push((patch as Record<string, unknown>)[key] ?? null);
      }
    }
    if ("config" in patch) {
      sets.push("config_json = ?");
      args.push(JSON.stringify(patch.config ?? {}));
    }
    if (!sets.length) return this.getReport(id);
    args.push(id);
    this.db.prepare(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.getReport(id);
  }

  deleteReport(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM reports WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM report_insights WHERE report_id = ?`).run(id);
    return info.changes > 0;
  }

  /**
   * Atomically claim the oldest queued report, flipping it to `rendering` so a
   * second worker (or a duplicate poll tick) can't pick the same row. Returns
   * null when the queue is empty.
   */
  claimNextQueued(): ReportRecord | null {
    const txn = this.db.transaction((): ReportRow | null => {
      const row = this.db
        .prepare(`SELECT * FROM reports WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
        .get() as ReportRow | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE reports SET status = 'rendering' WHERE id = ?`).run(row.id);
      return { ...row, status: "rendering" };
    });
    const claimed = txn();
    return claimed ? rowToReport(claimed) : null;
  }

  /** Reset any rows stuck in `rendering` (e.g. worker killed mid-render). */
  requeueStuckRendering(olderThanMs = 5 * 60_000): number {
    const cutoff = Date.now() - olderThanMs;
    const info = this.db
      .prepare(
        `UPDATE reports SET status = 'queued'
         WHERE status = 'rendering' AND created_at < ?`,
      )
      .run(cutoff);
    return info.changes;
  }

  // ── schedules ────────────────────────────────────────────────────

  listSchedules(): ReportScheduleRecord[] {
    const rows = this.db.prepare(`SELECT * FROM report_schedules ORDER BY kind`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      cron: r.cron as string,
      theme: r.theme as string,
      enabled: !!(r.enabled as number),
      sinks: safeParse<ReportSink[]>(r.sinks_json as string, ["ui"]),
      lastRunAt: (r.last_run_at as number) ?? null,
      nextRunAt: (r.next_run_at as number) ?? null,
      config: safeParse<Record<string, unknown>>(r.config_json as string, {}),
    }));
  }

  upsertSchedule(
    input: Partial<ReportScheduleRecord> & { kind: ReportKind; cron: string },
  ): ReportScheduleRecord {
    const id = input.id ?? `sch_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO report_schedules
          (id, kind, cron, theme, enabled, sinks_json, last_run_at, next_run_at, config_json)
         VALUES (@id, @kind, @cron, @theme, @enabled, @sinks, @last_run_at, @next_run_at, @config)
         ON CONFLICT(id) DO UPDATE SET
           kind=@kind, cron=@cron, theme=@theme, enabled=@enabled,
           sinks_json=@sinks, last_run_at=@last_run_at, next_run_at=@next_run_at,
           config_json=@config`,
      )
      .run({
        id,
        kind: input.kind,
        cron: input.cron,
        theme: input.theme ?? "black-gold",
        enabled: input.enabled === false ? 0 : 1,
        sinks: JSON.stringify(input.sinks ?? ["ui"]),
        last_run_at: input.lastRunAt ?? null,
        next_run_at: input.nextRunAt ?? null,
        config: JSON.stringify(input.config ?? {}),
      });
    return this.listSchedules().find((s) => s.id === id)!;
  }

  deleteSchedule(id: string): boolean {
    return this.db.prepare(`DELETE FROM report_schedules WHERE id = ?`).run(id).changes > 0;
  }

  // ── triggers ─────────────────────────────────────────────────────

  listTriggers(eventType?: string): ReportTriggerRecord[] {
    const rows = (
      eventType
        ? this.db.prepare(`SELECT * FROM report_triggers WHERE event_type = ?`).all(eventType)
        : this.db.prepare(`SELECT * FROM report_triggers ORDER BY event_type`).all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      eventType: r.event_type as string,
      theme: r.theme as string,
      sinks: safeParse<ReportSink[]>(r.sinks_json as string, ["ui", "telegram"]),
      config: safeParse<Record<string, unknown>>(r.config_json as string, {}),
      enabled: !!(r.enabled as number),
    }));
  }

  upsertTrigger(
    input: Partial<ReportTriggerRecord> & { kind: ReportKind; eventType: string },
  ): ReportTriggerRecord {
    const id = input.id ?? `trg_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO report_triggers
          (id, kind, event_type, theme, sinks_json, config_json, enabled)
         VALUES (@id, @kind, @event_type, @theme, @sinks, @config, @enabled)
         ON CONFLICT(id) DO UPDATE SET
           kind=@kind, event_type=@event_type, theme=@theme,
           sinks_json=@sinks, config_json=@config, enabled=@enabled`,
      )
      .run({
        id,
        kind: input.kind,
        event_type: input.eventType,
        theme: input.theme ?? "black-gold",
        sinks: JSON.stringify(input.sinks ?? ["ui", "telegram"]),
        config: JSON.stringify(input.config ?? {}),
        enabled: input.enabled === false ? 0 : 1,
      });
    return this.listTriggers().find((t) => t.id === id)!;
  }

  deleteTrigger(id: string): boolean {
    return this.db.prepare(`DELETE FROM report_triggers WHERE id = ?`).run(id).changes > 0;
  }

  // ── insights ─────────────────────────────────────────────────────

  insertInsight(
    input: Omit<ReportInsightRecord, "id" | "createdAt"> & { createdAt?: number },
  ): ReportInsightRecord {
    const id = `ins_${randomUUID()}`;
    const createdAt = input.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO report_insights
          (id, report_id, kind, title, body, action, severity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.reportId ?? null,
        input.kind,
        input.title,
        input.body,
        input.action ?? null,
        input.severity,
        createdAt,
      );
    return { ...input, id, createdAt };
  }

  listInsights(
    opts: { since?: number; kind?: string; limit?: number } = {},
  ): ReportInsightRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.since) {
      where.push("created_at >= ?");
      args.push(opts.since);
    }
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const rows = this.db
      .prepare(`SELECT * FROM report_insights ${whereSql} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      reportId: (r.report_id as string) ?? null,
      kind: r.kind as string,
      title: r.title as string,
      body: r.body as string,
      action: (r.action as string) ?? null,
      severity: r.severity as ReportInsightRecord["severity"],
      createdAt: r.created_at as number,
    }));
  }
}
