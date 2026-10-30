/**
 * Loops event log + KPI cache.
 *
 * Loops's API gives you read access to contacts/lists/properties but not
 * to historical campaign analytics — those flow in via webhooks
 * (configured at https://app.loops.so/settings/webhooks). We persist
 * every webhook hit here so the UI dashboard can compute opens/clicks/
 * bounces over arbitrary time windows without paginating Loops on every
 * load.
 *
 * Schema is deliberately denormalized — Loops's payload shape changes
 * occasionally and we want raw JSON archived for forensic queries.
 *
 * Storage: SQLite at `${stateDir}/loops.db`. Keep this file separate from
 * the main config DB so rolling back a Loops experiment doesn't risk
 * corrupting other state.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveConfigDir } from "../utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("loops").child("store");

let dbInstance: Database.Database | null = null;

export function getLoopsDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = `${resolveConfigDir()}/loops.db`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS loops_events (
      id            TEXT PRIMARY KEY,
      ts            INTEGER NOT NULL,
      event         TEXT NOT NULL,
      email         TEXT,
      contact_id    TEXT,
      campaign_id   TEXT,
      campaign_name TEXT,
      template_id   TEXT,
      template_name TEXT,
      raw           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loops_events_email_ts    ON loops_events(email, ts);
    CREATE INDEX IF NOT EXISTS idx_loops_events_event_ts    ON loops_events(event, ts);
    CREATE INDEX IF NOT EXISTS idx_loops_events_campaign_ts ON loops_events(campaign_id, ts);

    CREATE TABLE IF NOT EXISTS loops_templates (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,           -- "campaign" | "transactional" | "loop"
      subject     TEXT,
      preview     TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      data        TEXT NOT NULL            -- JSON: variables, body snippet, tags
    );

    CREATE TABLE IF NOT EXISTS loops_groups (
      id          TEXT PRIMARY KEY,        -- our id; matches Loops mailingList id when synced
      name        TEXT NOT NULL,
      description TEXT,
      source      TEXT NOT NULL,           -- "loops" | "crm-segment"
      filter      TEXT,                    -- JSON segment definition (CRM-derived only)
      member_count INTEGER NOT NULL DEFAULT 0,
      synced_at   INTEGER NOT NULL DEFAULT 0,
      data        TEXT NOT NULL            -- JSON
    );

    CREATE TABLE IF NOT EXISTS loops_sync_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      kind        TEXT NOT NULL,           -- "contact" | "list" | "event" | "transactional"
      action      TEXT NOT NULL,           -- "upsert" | "delete" | "send"
      target      TEXT,                    -- email or list id
      success     INTEGER NOT NULL,        -- 0 | 1
      message     TEXT,
      data        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loops_sync_log_ts ON loops_sync_log(ts DESC);
  `);
  dbInstance = db;
  log.info(`opened ${dbPath}`);
  return db;
}

// ── Webhook ingest ──────────────────────────────────────────────

export interface WebhookEventInput {
  /** Loops event id — used as primary key for idempotency. */
  id: string;
  ts: number; // ms
  event: string;
  email?: string;
  contactId?: string;
  campaignId?: string;
  campaignName?: string;
  templateId?: string;
  templateName?: string;
  raw: unknown;
}

export function recordWebhookEvent(input: WebhookEventInput): void {
  const db = getLoopsDb();
  const stmt = db.prepare(`
    INSERT INTO loops_events (id, ts, event, email, contact_id, campaign_id, campaign_name, template_id, template_name, raw)
    VALUES (@id, @ts, @event, @email, @contactId, @campaignId, @campaignName, @templateId, @templateName, @raw)
    ON CONFLICT(id) DO NOTHING
  `);
  stmt.run({
    id: input.id,
    ts: input.ts,
    event: input.event,
    email: input.email ?? null,
    contactId: input.contactId ?? null,
    campaignId: input.campaignId ?? null,
    campaignName: input.campaignName ?? null,
    templateId: input.templateId ?? null,
    templateName: input.templateName ?? null,
    raw: JSON.stringify(input.raw),
  });
}

// ── KPI summary ─────────────────────────────────────────────────

export interface KpiSummary {
  windowMs: number;
  since: number;
  totals: Record<string, number>; // event → count
  byCampaign: Array<{
    campaignId: string;
    campaignName: string | null;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    unsubscribed: number;
    openRate: number;
    clickRate: number;
  }>;
  recent: Array<{
    id: string;
    ts: number;
    event: string;
    email: string | null;
    campaignName: string | null;
  }>;
}

export function computeKpiSummary(windowMs: number = 7 * 86_400_000): KpiSummary {
  const db = getLoopsDb();
  const since = Date.now() - windowMs;

  const totals: Record<string, number> = {};
  for (const row of db
    .prepare(`SELECT event, COUNT(*) AS n FROM loops_events WHERE ts >= ? GROUP BY event`)
    .all(since) as Array<{ event: string; n: number }>) {
    totals[row.event] = row.n;
  }

  const campaignRows = db
    .prepare(
      `SELECT campaign_id AS campaignId,
              COALESCE(MAX(campaign_name), NULL) AS campaignName,
              SUM(CASE WHEN event IN ('email.sent', 'sent') THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN event IN ('email.delivered', 'delivered') THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN event IN ('email.opened', 'opened') THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN event IN ('email.clicked', 'clicked') THEN 1 ELSE 0 END) AS clicked,
              SUM(CASE WHEN event IN ('email.bounced', 'bounced') THEN 1 ELSE 0 END) AS bounced,
              SUM(CASE WHEN event IN ('email.unsubscribed', 'unsubscribed') THEN 1 ELSE 0 END) AS unsubscribed
       FROM loops_events
       WHERE ts >= ? AND campaign_id IS NOT NULL
       GROUP BY campaign_id
       ORDER BY MAX(ts) DESC
       LIMIT 50`,
    )
    .all(since) as Array<{
    campaignId: string;
    campaignName: string | null;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    unsubscribed: number;
  }>;

  const byCampaign = campaignRows.map((r) => {
    const denom = r.delivered || r.sent || 0;
    return {
      ...r,
      openRate: denom > 0 ? r.opened / denom : 0,
      clickRate: denom > 0 ? r.clicked / denom : 0,
    };
  });

  const recent = db
    .prepare(
      `SELECT id, ts, event, email, campaign_name AS campaignName
       FROM loops_events
       WHERE ts >= ?
       ORDER BY ts DESC
       LIMIT 25`,
    )
    .all(since) as KpiSummary["recent"];

  return { windowMs, since, totals, byCampaign, recent };
}

// ── Sync log ────────────────────────────────────────────────────

export function recordSyncLog(entry: {
  kind: "contact" | "list" | "event" | "transactional";
  action: "upsert" | "delete" | "send";
  target?: string;
  success: boolean;
  message?: string;
  data?: unknown;
}): void {
  const db = getLoopsDb();
  db.prepare(
    `INSERT INTO loops_sync_log (ts, kind, action, target, success, message, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    entry.kind,
    entry.action,
    entry.target ?? null,
    entry.success ? 1 : 0,
    entry.message ?? null,
    entry.data !== undefined ? JSON.stringify(entry.data) : null,
  );
}

export function listSyncLog(limit = 50): Array<{
  id: number;
  ts: number;
  kind: string;
  action: string;
  target: string | null;
  success: boolean;
  message: string | null;
}> {
  const db = getLoopsDb();
  return (
    db
      .prepare(
        `SELECT id, ts, kind, action, target, success, message
         FROM loops_sync_log
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      ts: number;
      kind: string;
      action: string;
      target: string | null;
      success: number;
      message: string | null;
    }>
  ).map((r) => ({ ...r, success: r.success === 1 }));
}

// ── Group / segment storage ─────────────────────────────────────

export interface StoredGroup {
  id: string;
  name: string;
  description: string | null;
  source: "loops" | "crm-segment";
  filter: { table: "clients" | "leads"; where?: Record<string, string> } | null;
  memberCount: number;
  syncedAt: number;
  data: Record<string, unknown>;
}

export function upsertGroup(g: Omit<StoredGroup, "syncedAt"> & { syncedAt?: number }): void {
  const db = getLoopsDb();
  db.prepare(
    `INSERT INTO loops_groups (id, name, description, source, filter, member_count, synced_at, data)
     VALUES (@id, @name, @description, @source, @filter, @memberCount, @syncedAt, @data)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       source = excluded.source,
       filter = excluded.filter,
       member_count = excluded.member_count,
       synced_at = excluded.synced_at,
       data = excluded.data`,
  ).run({
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    source: g.source,
    filter: g.filter ? JSON.stringify(g.filter) : null,
    memberCount: g.memberCount,
    syncedAt: g.syncedAt ?? Date.now(),
    data: JSON.stringify(g.data ?? {}),
  });
}

export function listGroups(): StoredGroup[] {
  const db = getLoopsDb();
  return (
    db
      .prepare(
        `SELECT id, name, description, source, filter, member_count AS memberCount, synced_at AS syncedAt, data
         FROM loops_groups
         ORDER BY synced_at DESC`,
      )
      .all() as Array<{
      id: string;
      name: string;
      description: string | null;
      source: "loops" | "crm-segment";
      filter: string | null;
      memberCount: number;
      syncedAt: number;
      data: string;
    }>
  ).map((r) => ({
    ...r,
    filter: r.filter ? (JSON.parse(r.filter) as StoredGroup["filter"]) : null,
    data: JSON.parse(r.data) as Record<string, unknown>,
  }));
}

export function deleteGroup(id: string): void {
  getLoopsDb().prepare(`DELETE FROM loops_groups WHERE id = ?`).run(id);
}
