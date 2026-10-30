/**
 * KPI Analytics System — SQLite Data Store
 * High-performance storage for analytics events, sessions, and conversions
 */

import { mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import type {
  KPISite,
  KPISiteSettings,
  KPISession,
  KPIEvent,
  KPIConversion,
  KPIGoal,
  KPIFunnel,
  EventType,
  UTMParams,
  DeviceInfo,
  AttributionData,
  AnalyticsQuery,
  TimeRange,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════
// SINGLETON STORE
// ═══════════════════════════════════════════════════════════════

let instance: KPIStore | null = null;

export function getKPIStore(dbPath?: string): KPIStore {
  if (!instance) {
    const path = dbPath ?? join(process.cwd(), "state", "analytics", "kpi.db");
    instance = new KPIStore(path);
  }
  return instance;
}

export function resetKPIStore(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// TIME HELPERS
// ═══════════════════════════════════════════════════════════════

function getTimeRangeFilter(range: TimeRange): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();
  let start: Date;

  switch (range) {
    case "1h":
      start = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case "24h":
      start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case "7d":
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "30d":
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "90d":
      start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case "1y":
      start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case "all":
    default:
      start = new Date(0);
  }

  return { start: start.toISOString(), end };
}

// ═══════════════════════════════════════════════════════════════
// KPI STORE CLASS
// ═══════════════════════════════════════════════════════════════

export class KPIStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.createTables();
  }

  close(): void {
    this.db.close();
  }

  private createTables(): void {
    this.db.exec(`
      -- SITES (tracking configurations)
      CREATE TABLE IF NOT EXISTS kpi_sites (
        id TEXT PRIMARY KEY,
        community_id TEXT,
        domain TEXT NOT NULL,
        name TEXT NOT NULL,
        script_key TEXT NOT NULL UNIQUE,
        settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sites_domain ON kpi_sites(domain);
      CREATE INDEX IF NOT EXISTS idx_sites_script_key ON kpi_sites(script_key);
      CREATE INDEX IF NOT EXISTS idx_sites_community ON kpi_sites(community_id);

      -- SESSIONS (visitor sessions)
      CREATE TABLE IF NOT EXISTS kpi_sessions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        page_count INTEGER DEFAULT 0,
        event_count INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        entry_page TEXT,
        exit_page TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_term TEXT,
        utm_content TEXT,
        referrer TEXT,
        device_type TEXT,
        browser TEXT,
        browser_version TEXT,
        os TEXT,
        os_version TEXT,
        screen_width INTEGER,
        screen_height INTEGER,
        country TEXT,
        city TEXT,
        is_new INTEGER DEFAULT 1,
        bounced INTEGER DEFAULT 1,
        converted INTEGER DEFAULT 0,
        FOREIGN KEY (site_id) REFERENCES kpi_sites(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_site ON kpi_sessions(site_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_fingerprint ON kpi_sessions(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON kpi_sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_activity ON kpi_sessions(last_activity_at);

      -- EVENTS (all tracked events)
      CREATE TABLE IF NOT EXISTS kpi_events (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (site_id) REFERENCES kpi_sites(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES kpi_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_site ON kpi_events(site_id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON kpi_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON kpi_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON kpi_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_site_time ON kpi_events(site_id, timestamp);

      -- CONVERSIONS (goal completions)
      CREATE TABLE IF NOT EXISTS kpi_conversions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        type TEXT NOT NULL,
        value REAL,
        currency TEXT DEFAULT 'USD',
        attribution TEXT NOT NULL DEFAULT '{}',
        funnel_path TEXT DEFAULT '[]',
        timestamp TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES kpi_sites(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES kpi_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (goal_id) REFERENCES kpi_goals(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_conversions_site ON kpi_conversions(site_id);
      CREATE INDEX IF NOT EXISTS idx_conversions_goal ON kpi_conversions(goal_id);
      CREATE INDEX IF NOT EXISTS idx_conversions_timestamp ON kpi_conversions(timestamp);

      -- GOALS (conversion definitions)
      CREATE TABLE IF NOT EXISTS kpi_goals (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        value REAL,
        active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES kpi_sites(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_goals_site ON kpi_goals(site_id);
      CREATE INDEX IF NOT EXISTS idx_goals_active ON kpi_goals(active);

      -- FUNNELS (conversion funnels)
      CREATE TABLE IF NOT EXISTS kpi_funnels (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        steps TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES kpi_sites(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_funnels_site ON kpi_funnels(site_id);

      -- REALTIME METRICS (rolling window for live stats)
      CREATE TABLE IF NOT EXISTS kpi_realtime (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        page TEXT NOT NULL,
        country TEXT,
        last_seen TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES kpi_sites(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_realtime_site ON kpi_realtime(site_id);
      CREATE INDEX IF NOT EXISTS idx_realtime_seen ON kpi_realtime(last_seen);

      -- DAILY AGGREGATES (pre-computed daily stats)
      CREATE TABLE IF NOT EXISTS kpi_daily_stats (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        date TEXT NOT NULL,
        page_views INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        sessions INTEGER DEFAULT 0,
        new_visitors INTEGER DEFAULT 0,
        returning_visitors INTEGER DEFAULT 0,
        bounces INTEGER DEFAULT 0,
        conversions INTEGER DEFAULT 0,
        conversion_value REAL DEFAULT 0,
        total_duration INTEGER DEFAULT 0,
        FOREIGN KEY (site_id) REFERENCES kpi_sites(id) ON DELETE CASCADE,
        UNIQUE(site_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_site_date ON kpi_daily_stats(site_id, date);
    `);
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  private now(): string {
    return new Date().toISOString();
  }

  private uuid(): string {
    return crypto.randomUUID();
  }

  // ═══════════════════════════════════════════════════════════════
  // SITE OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  createSite(data: {
    communityId?: string;
    domain: string;
    name: string;
    settings?: Partial<KPISiteSettings>;
  }): KPISite {
    const now = this.now();
    const id = this.uuid();
    const scriptKey = this.generateScriptKey();

    const defaultSettings: KPISiteSettings = {
      trackPageViews: true,
      trackClicks: true,
      trackScrollDepth: true,
      trackFormSubmits: true,
      trackConversions: true,
      anonymizeIp: true,
      respectDnt: true,
      sessionTimeout: 30,
      excludePaths: [],
      customDimensions: [],
      ...data.settings,
    };

    this.db
      .prepare(`
      INSERT INTO kpi_sites (id, community_id, domain, name, script_key, settings, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.communityId ?? null,
        data.domain,
        data.name,
        scriptKey,
        JSON.stringify(defaultSettings),
        now,
        now,
      );

    return this.getSite(id)!;
  }

  private generateScriptKey(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let key = "kpi_";
    for (let i = 0; i < 24; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
  }

  getSite(id: string): KPISite | null {
    const row = this.db.prepare("SELECT * FROM kpi_sites WHERE id = ?").get(id) as any;
    return row ? this.rowToSite(row) : null;
  }

  getSiteByScriptKey(scriptKey: string): KPISite | null {
    const row = this.db
      .prepare("SELECT * FROM kpi_sites WHERE script_key = ?")
      .get(scriptKey) as any;
    return row ? this.rowToSite(row) : null;
  }

  getSiteByDomain(domain: string): KPISite | null {
    const row = this.db.prepare("SELECT * FROM kpi_sites WHERE domain = ?").get(domain) as any;
    return row ? this.rowToSite(row) : null;
  }

  listSites(communityId?: string): KPISite[] {
    let sql = "SELECT * FROM kpi_sites";
    const params: any[] = [];

    if (communityId) {
      sql += " WHERE community_id = ?";
      params.push(communityId);
    }

    sql += " ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToSite(r));
  }

  updateSite(
    id: string,
    updates: Partial<Omit<KPISite, "id" | "scriptKey" | "createdAt">>,
  ): KPISite | null {
    const existing = this.getSite(id);
    if (!existing) return null;

    const now = this.now();
    const settings = updates.settings
      ? { ...existing.settings, ...updates.settings }
      : existing.settings;

    this.db
      .prepare(`
      UPDATE kpi_sites SET domain = ?, name = ?, settings = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.domain ?? existing.domain,
        updates.name ?? existing.name,
        JSON.stringify(settings),
        now,
        id,
      );

    return this.getSite(id);
  }

  deleteSite(id: string): boolean {
    return this.db.prepare("DELETE FROM kpi_sites WHERE id = ?").run(id).changes > 0;
  }

  regenerateScriptKey(siteId: string): string | null {
    const newKey = this.generateScriptKey();
    const result = this.db
      .prepare("UPDATE kpi_sites SET script_key = ?, updated_at = ? WHERE id = ?")
      .run(newKey, this.now(), siteId);
    return result.changes > 0 ? newKey : null;
  }

  private rowToSite(row: any): KPISite {
    return {
      id: row.id,
      communityId: row.community_id ?? undefined,
      domain: row.domain,
      name: row.name,
      scriptKey: row.script_key,
      settings: JSON.parse(row.settings || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  createSession(data: {
    siteId: string;
    fingerprint: string;
    entryPage: string;
    utm?: UTMParams;
    referrer?: string;
    device?: DeviceInfo;
    country?: string;
    city?: string;
  }): KPISession {
    const now = this.now();
    const id = this.uuid();

    // Check if this is a new visitor
    const existingVisitor = this.db
      .prepare("SELECT 1 FROM kpi_sessions WHERE site_id = ? AND fingerprint = ? LIMIT 1")
      .get(data.siteId, data.fingerprint);
    const isNew = !existingVisitor;

    this.db
      .prepare(`
      INSERT INTO kpi_sessions (
        id, site_id, fingerprint, started_at, last_activity_at, entry_page,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        referrer, device_type, browser, browser_version, os, os_version,
        screen_width, screen_height, country, city, is_new
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.siteId,
        data.fingerprint,
        now,
        now,
        data.entryPage,
        data.utm?.source ?? null,
        data.utm?.medium ?? null,
        data.utm?.campaign ?? null,
        data.utm?.term ?? null,
        data.utm?.content ?? null,
        data.referrer ?? null,
        data.device?.type ?? "unknown",
        data.device?.browser ?? null,
        data.device?.browserVersion ?? null,
        data.device?.os ?? null,
        data.device?.osVersion ?? null,
        data.device?.screenWidth ?? null,
        data.device?.screenHeight ?? null,
        data.country ?? null,
        data.city ?? null,
        isNew ? 1 : 0,
      );

    return this.getSession(id)!;
  }

  getSession(id: string): KPISession | null {
    const row = this.db.prepare("SELECT * FROM kpi_sessions WHERE id = ?").get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  getOrCreateSession(
    siteId: string,
    fingerprint: string,
    timeoutMinutes: number = 30,
  ): KPISession | null {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

    // Look for recent session
    const recent = this.db
      .prepare(`
      SELECT * FROM kpi_sessions 
      WHERE site_id = ? AND fingerprint = ? AND last_activity_at > ?
      ORDER BY last_activity_at DESC LIMIT 1
    `)
      .get(siteId, fingerprint, cutoff) as any;

    return recent ? this.rowToSession(recent) : null;
  }

  updateSessionActivity(sessionId: string, page?: string): void {
    const now = this.now();
    const session = this.getSession(sessionId);
    if (!session) return;

    const duration = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000);
    const bounced = session.pageCount <= 1 && duration < 10;

    let sql = "UPDATE kpi_sessions SET last_activity_at = ?, duration = ?, bounced = ?";
    const params: any[] = [now, duration, bounced ? 1 : 0];

    if (page) {
      sql += ", exit_page = ?, page_count = page_count + 1";
      params.push(page);
    }

    sql += " WHERE id = ?";
    params.push(sessionId);

    this.db.prepare(sql).run(...params);
  }

  incrementSessionEvents(sessionId: string): void {
    this.db
      .prepare("UPDATE kpi_sessions SET event_count = event_count + 1 WHERE id = ?")
      .run(sessionId);
  }

  markSessionConverted(sessionId: string): void {
    this.db.prepare("UPDATE kpi_sessions SET converted = 1 WHERE id = ?").run(sessionId);
  }

  private rowToSession(row: any): KPISession {
    return {
      id: row.id,
      siteId: row.site_id,
      fingerprint: row.fingerprint,
      startedAt: row.started_at,
      lastActivityAt: row.last_activity_at,
      pageCount: row.page_count || 0,
      eventCount: row.event_count || 0,
      duration: row.duration || 0,
      entryPage: row.entry_page || "",
      exitPage: row.exit_page ?? undefined,
      utm: {
        source: row.utm_source ?? undefined,
        medium: row.utm_medium ?? undefined,
        campaign: row.utm_campaign ?? undefined,
        term: row.utm_term ?? undefined,
        content: row.utm_content ?? undefined,
      },
      referrer: row.referrer ?? undefined,
      device: {
        type: row.device_type || "unknown",
        browser: row.browser || "unknown",
        browserVersion: row.browser_version ?? undefined,
        os: row.os || "unknown",
        osVersion: row.os_version ?? undefined,
        screenWidth: row.screen_width ?? undefined,
        screenHeight: row.screen_height ?? undefined,
      },
      country: row.country ?? undefined,
      city: row.city ?? undefined,
      isNew: row.is_new === 1,
      bounced: row.bounced === 1,
      converted: row.converted === 1,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  recordEvent(data: {
    siteId: string;
    sessionId: string;
    eventType: EventType;
    eventData: Record<string, unknown>;
  }): KPIEvent {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO kpi_events (id, site_id, session_id, event_type, timestamp, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(id, data.siteId, data.sessionId, data.eventType, now, JSON.stringify(data.eventData));

    this.incrementSessionEvents(data.sessionId);

    return {
      id,
      siteId: data.siteId,
      sessionId: data.sessionId,
      eventType: data.eventType,
      timestamp: now,
      data: data.eventData as any,
    };
  }

  getEvents(query: AnalyticsQuery): KPIEvent[] {
    const { start, end } = query.timeRange
      ? getTimeRangeFilter(query.timeRange)
      : { start: query.startDate || "1970-01-01", end: query.endDate || this.now() };

    let sql = "SELECT * FROM kpi_events WHERE site_id = ? AND timestamp BETWEEN ? AND ?";
    const params: any[] = [query.siteId, start, end];

    // Apply filters
    if (query.filters) {
      for (const filter of query.filters) {
        if (filter.field === "event_type") {
          sql += ` AND event_type ${filter.operator === "eq" ? "=" : "IN"} ?`;
          params.push(filter.value);
        }
      }
    }

    sql += " ORDER BY timestamp DESC";

    if (query.limit) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    if (query.offset) {
      sql += " OFFSET ?";
      params.push(query.offset);
    }

    return (this.db.prepare(sql).all(...params) as any[]).map((row) => ({
      id: row.id,
      siteId: row.site_id,
      sessionId: row.session_id,
      eventType: row.event_type as EventType,
      timestamp: row.timestamp,
      data: JSON.parse(row.data || "{}"),
    }));
  }

  countEvents(siteId: string, eventType?: EventType, timeRange?: TimeRange): number {
    const { start, end } = timeRange
      ? getTimeRangeFilter(timeRange)
      : { start: "1970-01-01", end: this.now() };

    let sql =
      "SELECT COUNT(*) as count FROM kpi_events WHERE site_id = ? AND timestamp BETWEEN ? AND ?";
    const params: any[] = [siteId, start, end];

    if (eventType) {
      sql += " AND event_type = ?";
      params.push(eventType);
    }

    return (this.db.prepare(sql).get(...params) as any).count;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONVERSION OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  recordConversion(data: {
    siteId: string;
    sessionId: string;
    goalId: string;
    type: string;
    value?: number;
    currency?: string;
    attribution: AttributionData;
    funnelPath?: string[];
  }): KPIConversion {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO kpi_conversions (id, site_id, session_id, goal_id, type, value, currency, attribution, funnel_path, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.siteId,
        data.sessionId,
        data.goalId,
        data.type,
        data.value ?? null,
        data.currency ?? "USD",
        JSON.stringify(data.attribution),
        JSON.stringify(data.funnelPath || []),
        now,
      );

    this.markSessionConverted(data.sessionId);

    return {
      id,
      siteId: data.siteId,
      sessionId: data.sessionId,
      goalId: data.goalId,
      type: data.type,
      value: data.value,
      currency: data.currency ?? "USD",
      attribution: data.attribution,
      funnelPath: data.funnelPath || [],
      timestamp: now,
    };
  }

  getConversions(siteId: string, timeRange?: TimeRange, goalId?: string): KPIConversion[] {
    const { start, end } = timeRange
      ? getTimeRangeFilter(timeRange)
      : { start: "1970-01-01", end: this.now() };

    let sql = "SELECT * FROM kpi_conversions WHERE site_id = ? AND timestamp BETWEEN ? AND ?";
    const params: any[] = [siteId, start, end];

    if (goalId) {
      sql += " AND goal_id = ?";
      params.push(goalId);
    }

    sql += " ORDER BY timestamp DESC";

    return (this.db.prepare(sql).all(...params) as any[]).map((row) => ({
      id: row.id,
      siteId: row.site_id,
      sessionId: row.session_id,
      goalId: row.goal_id,
      type: row.type,
      value: row.value ?? undefined,
      currency: row.currency,
      attribution: JSON.parse(row.attribution || "{}"),
      funnelPath: JSON.parse(row.funnel_path || "[]"),
      timestamp: row.timestamp,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // GOAL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  createGoal(data: Omit<KPIGoal, "id" | "createdAt" | "updatedAt">): KPIGoal {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO kpi_goals (id, site_id, name, description, type, config, value, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.siteId,
        data.name,
        data.description ?? null,
        data.type,
        JSON.stringify(data.config),
        data.value ?? null,
        data.active ? 1 : 0,
        now,
        now,
      );

    return this.getGoal(id)!;
  }

  getGoal(id: string): KPIGoal | null {
    const row = this.db.prepare("SELECT * FROM kpi_goals WHERE id = ?").get(id) as any;
    return row ? this.rowToGoal(row) : null;
  }

  listGoals(siteId: string, activeOnly = true): KPIGoal[] {
    let sql = "SELECT * FROM kpi_goals WHERE site_id = ?";
    const params: any[] = [siteId];

    if (activeOnly) {
      sql += " AND active = 1";
    }

    sql += " ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToGoal(r));
  }

  updateGoal(id: string, updates: Partial<KPIGoal>): KPIGoal | null {
    const existing = this.getGoal(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE kpi_goals SET name = ?, description = ?, type = ?, config = ?, value = ?, active = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.type ?? existing.type,
        JSON.stringify(updates.config ?? existing.config),
        updates.value ?? existing.value,
        updates.active !== undefined ? (updates.active ? 1 : 0) : existing.active ? 1 : 0,
        now,
        id,
      );

    return this.getGoal(id);
  }

  deleteGoal(id: string): boolean {
    return this.db.prepare("DELETE FROM kpi_goals WHERE id = ?").run(id).changes > 0;
  }

  private rowToGoal(row: any): KPIGoal {
    return {
      id: row.id,
      siteId: row.site_id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type,
      config: JSON.parse(row.config || "{}"),
      value: row.value ?? undefined,
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // FUNNEL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  createFunnel(data: Omit<KPIFunnel, "id" | "createdAt" | "updatedAt">): KPIFunnel {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO kpi_funnels (id, site_id, name, description, steps, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.siteId,
        data.name,
        data.description ?? null,
        JSON.stringify(data.steps),
        now,
        now,
      );

    return this.getFunnel(id)!;
  }

  getFunnel(id: string): KPIFunnel | null {
    const row = this.db.prepare("SELECT * FROM kpi_funnels WHERE id = ?").get(id) as any;
    return row ? this.rowToFunnel(row) : null;
  }

  listFunnels(siteId: string): KPIFunnel[] {
    return (
      this.db
        .prepare("SELECT * FROM kpi_funnels WHERE site_id = ? ORDER BY created_at DESC")
        .all(siteId) as any[]
    ).map((r) => this.rowToFunnel(r));
  }

  updateFunnel(id: string, updates: Partial<KPIFunnel>): KPIFunnel | null {
    const existing = this.getFunnel(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE kpi_funnels SET name = ?, description = ?, steps = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        JSON.stringify(updates.steps ?? existing.steps),
        now,
        id,
      );

    return this.getFunnel(id);
  }

  deleteFunnel(id: string): boolean {
    return this.db.prepare("DELETE FROM kpi_funnels WHERE id = ?").run(id).changes > 0;
  }

  private rowToFunnel(row: any): KPIFunnel {
    return {
      id: row.id,
      siteId: row.site_id,
      name: row.name,
      description: row.description ?? undefined,
      steps: JSON.parse(row.steps || "[]"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // REALTIME TRACKING
  // ═══════════════════════════════════════════════════════════════

  updateRealtimeVisitor(siteId: string, sessionId: string, page: string, country?: string): void {
    const now = this.now();

    this.db
      .prepare(`
      INSERT INTO kpi_realtime (id, site_id, session_id, page, country, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET page = ?, last_seen = ?
    `)
      .run(sessionId, siteId, sessionId, page, country ?? null, now, page, now);
  }

  getActiveVisitors(siteId: string, minutesWindow = 5): number {
    const cutoff = new Date(Date.now() - minutesWindow * 60 * 1000).toISOString();
    return (
      this.db
        .prepare(
          "SELECT COUNT(DISTINCT session_id) as count FROM kpi_realtime WHERE site_id = ? AND last_seen > ?",
        )
        .get(siteId, cutoff) as any
    ).count;
  }

  getActivePages(siteId: string, minutesWindow = 5): { path: string; visitors: number }[] {
    const cutoff = new Date(Date.now() - minutesWindow * 60 * 1000).toISOString();
    return this.db
      .prepare(`
      SELECT page as path, COUNT(DISTINCT session_id) as visitors
      FROM kpi_realtime WHERE site_id = ? AND last_seen > ?
      GROUP BY page ORDER BY visitors DESC LIMIT 20
    `)
      .all(siteId, cutoff) as any[];
  }

  cleanupRealtimeData(minutesOld = 15): number {
    const cutoff = new Date(Date.now() - minutesOld * 60 * 1000).toISOString();
    return this.db.prepare("DELETE FROM kpi_realtime WHERE last_seen < ?").run(cutoff).changes;
  }

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS AGGREGATIONS
  // ═══════════════════════════════════════════════════════════════

  getOverviewMetrics(
    siteId: string,
    timeRange: TimeRange,
  ): {
    pageViews: number;
    uniqueVisitors: number;
    sessions: number;
    avgSessionDuration: number;
    bounceRate: number;
    newVisitors: number;
    returningVisitors: number;
  } {
    const { start, end } = getTimeRangeFilter(timeRange);

    const stats = this.db
      .prepare(`
      SELECT 
        COUNT(*) as sessions,
        COUNT(DISTINCT fingerprint) as unique_visitors,
        SUM(page_count) as page_views,
        AVG(duration) as avg_duration,
        SUM(CASE WHEN bounced = 1 THEN 1 ELSE 0 END) as bounces,
        SUM(CASE WHEN is_new = 1 THEN 1 ELSE 0 END) as new_visitors
      FROM kpi_sessions
      WHERE site_id = ? AND started_at BETWEEN ? AND ?
    `)
      .get(siteId, start, end) as any;

    const sessions = stats.sessions || 0;
    return {
      pageViews: stats.page_views || 0,
      uniqueVisitors: stats.unique_visitors || 0,
      sessions,
      avgSessionDuration: Math.round(stats.avg_duration || 0),
      bounceRate: sessions > 0 ? Math.round((stats.bounces / sessions) * 100) : 0,
      newVisitors: stats.new_visitors || 0,
      returningVisitors: sessions - (stats.new_visitors || 0),
    };
  }

  getTopPages(
    siteId: string,
    timeRange: TimeRange,
    limit = 10,
  ): { path: string; views: number; avgDuration: number }[] {
    const { start, end } = getTimeRangeFilter(timeRange);

    return this.db
      .prepare(`
      SELECT 
        json_extract(data, '$.path') as path,
        COUNT(*) as views,
        AVG(COALESCE(json_extract(data, '$.duration'), 0)) as avg_duration
      FROM kpi_events
      WHERE site_id = ? AND event_type = 'page_view' AND timestamp BETWEEN ? AND ?
      GROUP BY path
      ORDER BY views DESC
      LIMIT ?
    `)
      .all(siteId, start, end, limit) as any[];
  }

  getTrafficSources(
    siteId: string,
    timeRange: TimeRange,
  ): { source: string; visits: number; percentage: number }[] {
    const { start, end } = getTimeRangeFilter(timeRange);

    const results = this.db
      .prepare(`
      SELECT 
        COALESCE(utm_source, CASE WHEN referrer IS NULL OR referrer = '' THEN 'direct' ELSE 'referral' END) as source,
        COUNT(*) as visits
      FROM kpi_sessions
      WHERE site_id = ? AND started_at BETWEEN ? AND ?
      GROUP BY source
      ORDER BY visits DESC
    `)
      .all(siteId, start, end) as any[];

    const total = results.reduce((sum, r) => sum + r.visits, 0);
    return results.map((r) => ({
      source: r.source,
      visits: r.visits,
      percentage: total > 0 ? Math.round((r.visits / total) * 100) : 0,
    }));
  }

  getConversionMetrics(
    siteId: string,
    timeRange: TimeRange,
  ): {
    totalConversions: number;
    conversionRate: number;
    totalValue: number;
    avgOrderValue: number;
  } {
    const { start, end } = getTimeRangeFilter(timeRange);

    const sessions = (
      this.db
        .prepare(`
      SELECT COUNT(*) as count FROM kpi_sessions WHERE site_id = ? AND started_at BETWEEN ? AND ?
    `)
        .get(siteId, start, end) as any
    ).count;

    const conversions = this.db
      .prepare(`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(value), 0) as total_value
      FROM kpi_conversions
      WHERE site_id = ? AND timestamp BETWEEN ? AND ?
    `)
      .get(siteId, start, end) as any;

    return {
      totalConversions: conversions.count || 0,
      conversionRate:
        sessions > 0 ? Math.round((conversions.count / sessions) * 100 * 100) / 100 : 0,
      totalValue: conversions.total_value || 0,
      avgOrderValue:
        conversions.count > 0
          ? Math.round((conversions.total_value / conversions.count) * 100) / 100
          : 0,
    };
  }

  getTimeSeries(
    siteId: string,
    timeRange: TimeRange,
    metric: "page_views" | "sessions" | "visitors",
  ): { timestamp: string; value: number }[] {
    const { start, end } = getTimeRangeFilter(timeRange);

    // Determine granularity based on time range
    let dateFormat: string;
    let granularity: string;

    if (timeRange === "1h" || timeRange === "24h") {
      dateFormat = "%Y-%m-%dT%H:00:00Z";
      granularity = "hour";
    } else if (timeRange === "7d" || timeRange === "30d") {
      dateFormat = "%Y-%m-%d";
      granularity = "day";
    } else {
      dateFormat = "%Y-%m-%d";
      granularity = "day";
    }

    let sql: string;
    if (metric === "page_views") {
      sql = `
        SELECT strftime('${dateFormat}', timestamp) as timestamp, COUNT(*) as value
        FROM kpi_events
        WHERE site_id = ? AND event_type = 'page_view' AND timestamp BETWEEN ? AND ?
        GROUP BY strftime('${dateFormat}', timestamp)
        ORDER BY timestamp
      `;
    } else if (metric === "sessions") {
      sql = `
        SELECT strftime('${dateFormat}', started_at) as timestamp, COUNT(*) as value
        FROM kpi_sessions
        WHERE site_id = ? AND started_at BETWEEN ? AND ?
        GROUP BY strftime('${dateFormat}', started_at)
        ORDER BY timestamp
      `;
    } else {
      sql = `
        SELECT strftime('${dateFormat}', started_at) as timestamp, COUNT(DISTINCT fingerprint) as value
        FROM kpi_sessions
        WHERE site_id = ? AND started_at BETWEEN ? AND ?
        GROUP BY strftime('${dateFormat}', started_at)
        ORDER BY timestamp
      `;
    }

    return this.db.prepare(sql).all(siteId, start, end) as any[];
  }

  // ═══════════════════════════════════════════════════════════════
  // FUNNEL ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  getFunnelAnalytics(
    funnelId: string,
    timeRange: TimeRange,
  ): {
    steps: {
      stepId: string;
      stepName: string;
      entered: number;
      completed: number;
      dropoffRate: number;
    }[];
    overallConversion: number;
    completions: number;
  } {
    const funnel = this.getFunnel(funnelId);
    if (!funnel) return { steps: [], overallConversion: 0, completions: 0 };

    const { start, end } = getTimeRangeFilter(timeRange);
    const steps = funnel.steps.sort((a, b) => a.order - b.order);

    // This is a simplified funnel analysis
    // In production, you'd want to track actual funnel progressions
    const stepAnalytics = steps.map((step, index) => {
      let entered = 0;

      if (step.type === "page") {
        const matchClause =
          step.config.matchType === "exact"
            ? `json_extract(data, '$.path') = ?`
            : step.config.matchType === "starts_with"
              ? `json_extract(data, '$.path') LIKE ?`
              : `json_extract(data, '$.path') REGEXP ?`;

        const matchValue =
          step.config.matchType === "starts_with" ? `${step.config.url}%` : step.config.url;

        entered = (
          this.db
            .prepare(`
          SELECT COUNT(DISTINCT session_id) as count
          FROM kpi_events
          WHERE site_id = ? AND event_type = 'page_view' AND timestamp BETWEEN ? AND ?
          AND ${matchClause}
        `)
            .get(funnel.siteId, start, end, matchValue) as any
        ).count;
      } else {
        entered = (
          this.db
            .prepare(`
          SELECT COUNT(DISTINCT session_id) as count
          FROM kpi_events
          WHERE site_id = ? AND event_type = 'custom' AND timestamp BETWEEN ? AND ?
          AND json_extract(data, '$.name') = ?
        `)
            .get(funnel.siteId, start, end, step.config.eventName) as any
        ).count;
      }

      return {
        stepId: step.id,
        stepName: step.name,
        entered,
        completed: 0, // Would need proper tracking to calculate
        dropoffRate: 0,
      };
    });

    // Calculate dropoffs
    for (let i = 0; i < stepAnalytics.length - 1; i++) {
      const current = stepAnalytics[i];
      const next = stepAnalytics[i + 1];
      current.completed = next.entered;
      current.dropoffRate =
        current.entered > 0
          ? Math.round(((current.entered - next.entered) / current.entered) * 100)
          : 0;
    }

    const firstStep = stepAnalytics[0]?.entered || 0;
    const lastStep = stepAnalytics[stepAnalytics.length - 1]?.entered || 0;

    return {
      steps: stepAnalytics,
      overallConversion: firstStep > 0 ? Math.round((lastStep / firstStep) * 100) : 0,
      completions: lastStep,
    };
  }
}
