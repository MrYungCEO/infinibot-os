import { mkdirSync, existsSync } from "fs";
import path from "path";
import Database from "better-sqlite3";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("notification-history");

export type NotificationCategory =
  | "agent.completed"
  | "agent.error"
  | "agent.input_required"
  | "terminal.exit"
  | "cron.fired"
  | "discipline.alert"
  | "kanban.task.assigned"
  | "kanban.task.completed"
  | "kanban.task.due"
  | "business.lead.new"
  | "business.income.logged"
  | "federation.node.online"
  | "federation.node.offline"
  | "system.update.available"
  | "voice.call.incoming"
  | "voice.call.missed"
  | "chat.mentions"
  | "autonomy.checkpoint"
  | "autonomy.budget.warning"
  | "autonomy.budget.hit"
  | "credits.threshold"
  | "manual";

export type NotificationSeverity = "info" | "success" | "warn" | "error" | "critical";

export interface NotificationRow {
  id: string;
  ts: number;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string;
  source: string;
  sourceId: string | null;
  deepLink: string | null;
  dataJson: string | null;
  deviceTokens: string; // JSON array
  readByToken: string; // JSON array
  dismissedByToken: string; // JSON array
  ackByToken: string; // JSON array
  snoozeUntil: number | null;
  expiresAt: number | null;
}

export interface NotificationEntry extends Omit<
  NotificationRow,
  "dataJson" | "deviceTokens" | "readByToken" | "dismissedByToken" | "ackByToken"
> {
  data: Record<string, unknown> | null;
  deviceTokens: string[];
  readByToken: string[];
  dismissedByToken: string[];
  ackByToken: string[];
}

export interface NotificationFilters {
  categories?: NotificationCategory[];
  severities?: NotificationSeverity[];
  sources?: string[];
  unreadOnly?: boolean;
  text?: string;
  fromTs?: number;
  toTs?: number;
  token?: string; // if set, read/dismissed checks use this token
}

export interface PaginatedResult {
  items: NotificationEntry[];
  nextCursor: string | null;
  total: number;
}

export interface CategorySummary {
  category: string;
  count: number;
  unread: number;
}

export interface NotificationPreferences {
  categories: Record<string, CategoryPreference>;
  quietHoursStart: string | null; // "22:00"
  quietHoursEnd: string | null; // "08:00"
  timezone: string | null;
}

export interface CategoryPreference {
  enabled: boolean;
  sound: boolean;
  vibrate: boolean;
  banner: boolean;
  minSeverity: NotificationSeverity;
}

const DEFAULT_CATEGORY_PREF: CategoryPreference = {
  enabled: true,
  sound: true,
  vibrate: true,
  banner: true,
  minSeverity: "info",
};

let _store: NotificationHistoryStore | null = null;

export function getNotificationHistoryStore(stateDir?: string): NotificationHistoryStore {
  if (!_store) {
    const dir = stateDir ?? STATE_DIR;
    _store = new NotificationHistoryStore(path.join(dir, "notifications", "history.db"));
  }
  return _store;
}

export function resetNotificationHistoryStore(): void {
  _store = null;
}

export class NotificationHistoryStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");

    this.migrate();
    log.info("notification history store ready", { path: dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id              TEXT PRIMARY KEY,
        ts              INTEGER NOT NULL,
        category        TEXT NOT NULL,
        severity        TEXT NOT NULL DEFAULT 'info',
        title           TEXT NOT NULL DEFAULT '',
        body            TEXT NOT NULL DEFAULT '',
        source          TEXT NOT NULL DEFAULT '',
        sourceId        TEXT,
        deepLink        TEXT,
        dataJson        TEXT,
        deviceTokens    TEXT NOT NULL DEFAULT '[]',
        readByToken     TEXT NOT NULL DEFAULT '[]',
        dismissedByToken TEXT NOT NULL DEFAULT '[]',
        ackByToken      TEXT NOT NULL DEFAULT '[]',
        snoozeUntil     INTEGER,
        expiresAt       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_cat_ts ON notifications(category, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_sev_ts ON notifications(severity, ts DESC);

      CREATE TABLE IF NOT EXISTS notification_preferences (
        id      INTEGER PRIMARY KEY DEFAULT 1,
        json    TEXT NOT NULL DEFAULT '{}'
      );
      INSERT OR IGNORE INTO notification_preferences(id, json) VALUES(1, '{}');
    `);
  }

  insert(
    entry: Omit<NotificationEntry, "readByToken" | "dismissedByToken" | "ackByToken">,
  ): NotificationEntry {
    const row: NotificationRow = {
      id: entry.id,
      ts: entry.ts,
      category: entry.category,
      severity: entry.severity,
      title: entry.title,
      body: entry.body,
      source: entry.source,
      sourceId: entry.sourceId ?? null,
      deepLink: entry.deepLink ?? null,
      dataJson: entry.data ? JSON.stringify(entry.data) : null,
      deviceTokens: JSON.stringify(entry.deviceTokens ?? []),
      readByToken: "[]",
      dismissedByToken: "[]",
      ackByToken: "[]",
      snoozeUntil: entry.snoozeUntil ?? null,
      expiresAt: entry.expiresAt ?? null,
    };

    this.db
      .prepare(
        `INSERT INTO notifications
          (id,ts,category,severity,title,body,source,sourceId,deepLink,dataJson,deviceTokens,readByToken,dismissedByToken,ackByToken,snoozeUntil,expiresAt)
         VALUES
          (@id,@ts,@category,@severity,@title,@body,@source,@sourceId,@deepLink,@dataJson,@deviceTokens,@readByToken,@dismissedByToken,@ackByToken,@snoozeUntil,@expiresAt)`,
      )
      .run(row);

    return this.toEntry(row);
  }

  get(id: string): NotificationEntry | null {
    const row = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
      | NotificationRow
      | undefined;
    return row ? this.toEntry(row) : null;
  }

  list(opts: { limit?: number; cursor?: string; filters?: NotificationFilters }): PaginatedResult {
    const { limit = 50, cursor, filters = {} } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (cursor) {
      conditions.push("ts < ?");
      params.push(Number(cursor));
    }
    if (filters.categories?.length) {
      conditions.push(`category IN (${filters.categories.map(() => "?").join(",")})`);
      params.push(...filters.categories);
    }
    if (filters.severities?.length) {
      conditions.push(`severity IN (${filters.severities.map(() => "?").join(",")})`);
      params.push(...filters.severities);
    }
    if (filters.sources?.length) {
      conditions.push(`source IN (${filters.sources.map(() => "?").join(",")})`);
      params.push(...filters.sources);
    }
    if (filters.fromTs !== undefined) {
      conditions.push("ts >= ?");
      params.push(filters.fromTs);
    }
    if (filters.toTs !== undefined) {
      conditions.push("ts <= ?");
      params.push(filters.toTs);
    }
    if (filters.text) {
      conditions.push("(title LIKE ? OR body LIKE ?)");
      const like = `%${filters.text}%`;
      params.push(like, like);
    }
    // Don't show dismissed (unless explicitly overridden by token check)
    if (filters.token) {
      conditions.push("(dismissedByToken NOT LIKE ?)");
      params.push(`%"${filters.token}"%`);
    }
    if (filters.unreadOnly && filters.token) {
      conditions.push("(readByToken NOT LIKE ?)");
      params.push(`%"${filters.token}"%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM notifications ${where} ORDER BY ts DESC LIMIT ?`)
      .all([...params, limit + 1]) as NotificationRow[];

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      rows.pop();
      nextCursor = String(rows[rows.length - 1].ts);
    }

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM notifications ${where}`)
      .get(params) as { cnt: number };

    return {
      items: rows.map((r) => this.toEntry(r)),
      nextCursor,
      total: countRow.cnt,
    };
  }

  unreadCount(token: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM notifications
         WHERE readByToken NOT LIKE ? AND dismissedByToken NOT LIKE ?`,
      )
      .get(`%"${token}"%`, `%"${token}"%`) as { cnt: number };
    return row.cnt;
  }

  byCategorySummary(period: "day" | "week" | "month", token?: string): CategorySummary[] {
    const now = Date.now();
    const periodMs = period === "day" ? 86400000 : period === "week" ? 604800000 : 2592000000;
    const fromTs = now - periodMs;

    const rows = this.db
      .prepare(
        `SELECT category,
                COUNT(*) as count,
                SUM(CASE WHEN readByToken NOT LIKE ? AND dismissedByToken NOT LIKE ? THEN 1 ELSE 0 END) as unread
         FROM notifications
         WHERE ts >= ?
         GROUP BY category
         ORDER BY count DESC`,
      )
      .all(`%"${token ?? "_none_"}"%`, `%"${token ?? "_none_"}"%`, fromTs) as Array<{
      category: string;
      count: number;
      unread: number;
    }>;

    return rows.map((r) => ({
      category: r.category,
      count: r.count,
      unread: r.unread,
    }));
  }

  markRead(ids: string[], token: string): void {
    const stmt = this.db.prepare(
      `UPDATE notifications
       SET readByToken = json_insert(readByToken, '$[#]', ?)
       WHERE id = ? AND readByToken NOT LIKE ?`,
    );
    const run = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(token, id, `%"${token}"%`);
      }
    });
    run();
  }

  markAllRead(token: string): number {
    const result = this.db
      .prepare(
        `UPDATE notifications
         SET readByToken = json_insert(readByToken, '$[#]', ?)
         WHERE readByToken NOT LIKE ?`,
      )
      .run(token, `%"${token}"%`);
    return result.changes;
  }

  markUnread(ids: string[], token: string): void {
    const stmt = this.db.prepare(
      `UPDATE notifications
       SET readByToken = json_remove(readByToken, json_each.fullkey)
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM json_each(readByToken) WHERE json_each.value = ?
       )`,
    );
    const run = this.db.transaction(() => {
      for (const id of ids) stmt.run(id, token);
    });
    run();
  }

  dismiss(ids: string[], token: string): void {
    const stmt = this.db.prepare(
      `UPDATE notifications
       SET dismissedByToken = json_insert(dismissedByToken, '$[#]', ?)
       WHERE id = ? AND dismissedByToken NOT LIKE ?`,
    );
    const run = this.db.transaction(() => {
      for (const id of ids) stmt.run(token, id, `%"${token}"%`);
    });
    run();
  }

  ack(ids: string[], token: string): void {
    const stmt = this.db.prepare(
      `UPDATE notifications
       SET ackByToken = json_insert(ackByToken, '$[#]', ?)
       WHERE id = ? AND ackByToken NOT LIKE ?`,
    );
    const run = this.db.transaction(() => {
      for (const id of ids) stmt.run(token, id, `%"${token}"%`);
    });
    run();
  }

  snooze(id: string, until: number): void {
    this.db.prepare("UPDATE notifications SET snoozeUntil = ? WHERE id = ?").run(until, id);
  }

  findBySourceId(sourceId: string, limit = 20): NotificationEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications WHERE sourceId = ? ORDER BY ts DESC LIMIT ?")
      .all(sourceId, limit) as NotificationRow[];
    return rows.map((r) => this.toEntry(r));
  }

  getPreferences(): NotificationPreferences {
    const row = this.db.prepare("SELECT json FROM notification_preferences WHERE id = 1").get() as {
      json: string;
    };
    const empty: NotificationPreferences = {
      categories: {},
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: null,
    };
    let parsed: Partial<NotificationPreferences> = {};
    try {
      parsed = JSON.parse(row.json) as Partial<NotificationPreferences>;
    } catch {
      return empty;
    }
    // The notification_preferences row is seeded with '{}' on first run, so
    // a freshly-migrated DB has no `categories` key. Without this normalize
    // step `getCategoryPreference` would throw, which made every
    // `emitNotification` call fail silently and left history.db empty.
    return {
      categories: parsed.categories ?? {},
      quietHoursStart: parsed.quietHoursStart ?? null,
      quietHoursEnd: parsed.quietHoursEnd ?? null,
      timezone: parsed.timezone ?? null,
    };
  }

  setPreferences(prefs: NotificationPreferences): void {
    this.db
      .prepare("UPDATE notification_preferences SET json = ? WHERE id = 1")
      .run(JSON.stringify(prefs));
  }

  getCategoryPreference(category: string): CategoryPreference {
    const prefs = this.getPreferences();
    return prefs.categories[category] ?? DEFAULT_CATEGORY_PREF;
  }

  pruneExpired(): number {
    const result = this.db
      .prepare("DELETE FROM notifications WHERE expiresAt IS NOT NULL AND expiresAt < ?")
      .run(Date.now());
    return result.changes;
  }

  private toEntry(row: NotificationRow): NotificationEntry {
    return {
      id: row.id,
      ts: row.ts,
      category: row.category as NotificationCategory,
      severity: row.severity as NotificationSeverity,
      title: row.title,
      body: row.body,
      source: row.source,
      sourceId: row.sourceId,
      deepLink: row.deepLink,
      data: row.dataJson ? this.tryParse(row.dataJson) : null,
      deviceTokens: this.tryParseArr(row.deviceTokens),
      readByToken: this.tryParseArr(row.readByToken),
      dismissedByToken: this.tryParseArr(row.dismissedByToken),
      ackByToken: this.tryParseArr(row.ackByToken),
      snoozeUntil: row.snoozeUntil,
      expiresAt: row.expiresAt,
    };
  }

  private tryParse(s: string): Record<string, unknown> | null {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  private tryParseArr(s: string): string[] {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
}
