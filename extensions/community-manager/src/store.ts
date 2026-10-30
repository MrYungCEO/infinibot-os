/**
 * Community Manager store: one SQLite DB (WAL) at
 * `<stateDir>/plugin-data/community-manager/community.db` (plan §6.3).
 * Every row carries `guild_id` so a second server can be added later.
 *
 * Runtime settings live here (not in plugin config): a `plugins.*` config
 * write restarts the gateway, a settings row doesn't.
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  Activity,
  ActivityKind,
  Campaign,
  CampaignStatus,
  Lead,
  LeadStage,
  ModAction,
  ModActionStatus,
  Settings,
  TeamMember,
  Ticket,
  TicketState,
} from "./contract.js";
import { LIVE_MODULES, PLUGIN_ID, ROUTED_OFFERS, type RoutedOffer } from "./contract.js";
import { defaultSettings } from "./defaults.js";
import { buildCta, DEFAULT_ROUTE } from "./routing.js";

export function communityDataDir(stateDir: string): string {
  return path.join(stateDir, "plugin-data", PLUGIN_ID);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cm_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cm_members (
  guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, username TEXT NOT NULL,
  joined_at INTEGER, account_created_at INTEGER, verified_at INTEGER, risk_score INTEGER DEFAULT 0,
  intake_done_at INTEGER, last_active_at INTEGER, strikes INTEGER DEFAULT 0, welcomed_at INTEGER,
  review TEXT, PRIMARY KEY (guild_id, discord_id));
CREATE TABLE IF NOT EXISTS cm_intake (
  guild_id TEXT NOT NULL, member_id TEXT NOT NULL, question_id TEXT NOT NULL, answer TEXT NOT NULL,
  answered_at INTEGER NOT NULL, PRIMARY KEY (guild_id, member_id, question_id));
CREATE TABLE IF NOT EXISTS cm_leads (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, member_id TEXT NOT NULL, username TEXT NOT NULL,
  offer TEXT NOT NULL, score INTEGER NOT NULL, tier TEXT NOT NULL, breakdown TEXT NOT NULL,
  stage TEXT NOT NULL, assignee_id TEXT, assignee_name TEXT, sla_due_at INTEGER, thread_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS cm_leads_guild ON cm_leads (guild_id, stage);
CREATE TABLE IF NOT EXISTS cm_lead_events (
  lead_id TEXT NOT NULL, ts INTEGER NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT);
CREATE TABLE IF NOT EXISTS cm_team (
  discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, offers TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, last_assigned_at INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS cm_tickets (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, member_id TEXT NOT NULL, username TEXT NOT NULL,
  category TEXT NOT NULL, thread_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cm_mod_actions (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, target_id TEXT, target_name TEXT,
  action TEXT NOT NULL, rule TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT, evidence_expires_at INTEGER,
  status TEXT NOT NULL, approval_id TEXT, duration_ms INTEGER, guild_id TEXT, channel_id TEXT, message_id TEXT);
CREATE INDEX IF NOT EXISTS cm_mod_approval ON cm_mod_actions (approval_id);
CREATE TABLE IF NOT EXISTS cm_campaigns (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, channel_id TEXT, schedule_at INTEGER NOT NULL,
  status TEXT NOT NULL, approval_id TEXT, pings_everyone INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cm_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, dry INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cm_metrics_daily (
  date TEXT NOT NULL, guild_id TEXT NOT NULL, joins INTEGER DEFAULT 0, leaves INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0, messages INTEGER DEFAULT 0, leads INTEGER DEFAULT 0, PRIMARY KEY (date, guild_id));
CREATE TABLE IF NOT EXISTS cm_daily_active (date TEXT NOT NULL, guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
  PRIMARY KEY (date, guild_id, member_id));
CREATE TABLE IF NOT EXISTS cm_channel_counters (channel_id TEXT PRIMARY KEY, since_disclaimer INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cm_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, before TEXT, after TEXT);
`;

export type MemberRow = {
  guildId: string;
  discordId: string;
  username: string;
  joinedAt: number | null;
  accountCreatedAt: number | null;
  verifiedAt: number | null;
  riskScore: number;
  intakeDoneAt: number | null;
  welcomedAt: number | null;
  strikes: number;
  review: string | null;
};

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const json = (v: unknown) => JSON.stringify(v ?? null);
function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Keys a settings write may never smuggle in (defence in depth: tokens live in core config). */
const FORBIDDEN_SETTING_KEYS = /token|secret|password/i;

export class CommunityStore {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    if (file !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive column migrations (older DBs). */
  private migrate(): void {
    const cols = new Set((this.db.prepare("PRAGMA table_info(cm_leads)").all() as Array<{ name: string }>).map((c) => c.name));
    const add: Array<[string, string]> = [
      ["secondary_offer", "TEXT"],
      ["cta", "TEXT"],
      ["route_reason", "TEXT"],
    ];
    for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE cm_leads ADD COLUMN ${name} ${type}`);
  }

  close(): void {
    this.db.close();
  }

  // ── settings ──
  getSettings(): Settings {
    const row = this.db.prepare("SELECT v FROM cm_settings WHERE k = 'settings'").get() as { v: string } | undefined;
    const base = defaultSettings();
    if (!row) return base;
    const stored = parse<Partial<Settings>>(row.v, {});
    return {
      ...base,
      ...stored,
      moderation: { ...base.moderation, ...stored.moderation },
      compliance: { ...base.compliance, ...stored.compliance },
      liveModules: (Array.isArray(stored.liveModules) ? stored.liveModules : []).filter((m) => LIVE_MODULES.includes(m)),
      channelMap: { ...stored.channelMap },
      roleMap: { ...stored.roleMap },
    };
  }

  saveSettings(patch: Partial<Settings>, actor = "owner"): Settings {
    for (const key of Object.keys(patch)) {
      if (FORBIDDEN_SETTING_KEYS.test(key)) throw new Error(`settings key "${key}" is not allowed`);
    }
    const before = this.getSettings();
    const next: Settings = { ...before, ...patch, version: before.version + 1 };
    this.db
      .prepare("INSERT INTO cm_settings (k, v, updated_at) VALUES ('settings', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
      .run(json(next), Date.now());
    this.audit(actor, "settings", diffKeys(before, next), Object.keys(patch));
    return next;
  }

  audit(actor: string, kind: string, before: unknown, after: unknown): void {
    this.db
      .prepare("INSERT INTO cm_audit (ts, actor, kind, before, after) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), actor, kind, json(before), json(after));
  }

  // ── members + intake ──
  getMember(guildId: string, discordId: string): MemberRow | null {
    const r = this.db
      .prepare("SELECT * FROM cm_members WHERE guild_id = ? AND discord_id = ?")
      .get(guildId, discordId) as Record<string, unknown> | undefined;
    return r ? rowToMember(r) : null;
  }

  upsertMember(guildId: string, discordId: string, username: string, patch: Partial<MemberRow> = {}): MemberRow {
    const prev = this.getMember(guildId, discordId);
    const m: MemberRow = {
      guildId,
      discordId,
      username: username || prev?.username || discordId,
      joinedAt: patch.joinedAt ?? prev?.joinedAt ?? null,
      accountCreatedAt: patch.accountCreatedAt ?? prev?.accountCreatedAt ?? null,
      verifiedAt: patch.verifiedAt ?? prev?.verifiedAt ?? null,
      riskScore: patch.riskScore ?? prev?.riskScore ?? 0,
      intakeDoneAt: patch.intakeDoneAt ?? prev?.intakeDoneAt ?? null,
      welcomedAt: patch.welcomedAt ?? prev?.welcomedAt ?? null,
      strikes: patch.strikes ?? prev?.strikes ?? 0,
      review: patch.review !== undefined ? patch.review : (prev?.review ?? null),
    };
    this.db
      .prepare(
        `INSERT INTO cm_members (guild_id, discord_id, username, joined_at, account_created_at, verified_at, risk_score, intake_done_at, welcomed_at, strikes, review, last_active_at)
         VALUES (@guildId, @discordId, @username, @joinedAt, @accountCreatedAt, @verifiedAt, @riskScore, @intakeDoneAt, @welcomedAt, @strikes, @review, @now)
         ON CONFLICT(guild_id, discord_id) DO UPDATE SET username = excluded.username, joined_at = excluded.joined_at,
           account_created_at = excluded.account_created_at, verified_at = excluded.verified_at, risk_score = excluded.risk_score,
           intake_done_at = excluded.intake_done_at, welcomed_at = excluded.welcomed_at, strikes = excluded.strikes,
           review = excluded.review, last_active_at = excluded.last_active_at`,
      )
      .run({ ...m, now: Date.now() });
    return m;
  }

  recordAnswer(guildId: string, memberId: string, questionId: string, answer: string): void {
    this.db
      .prepare(
        "INSERT INTO cm_intake (guild_id, member_id, question_id, answer, answered_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET answer = excluded.answer, answered_at = excluded.answered_at",
      )
      .run(guildId, memberId, questionId, answer, Date.now());
  }

  answers(guildId: string, memberId: string): Record<string, string> {
    const rows = this.db
      .prepare("SELECT question_id, answer FROM cm_intake WHERE guild_id = ? AND member_id = ?")
      .all(guildId, memberId) as Array<{ question_id: string; answer: string }>;
    return Object.fromEntries(rows.map((r) => [r.question_id, r.answer]));
  }

  deleteMemberData(guildId: string, memberId: string): void {
    this.db.prepare("DELETE FROM cm_intake WHERE guild_id = ? AND member_id = ?").run(guildId, memberId);
    this.db.prepare("DELETE FROM cm_members WHERE guild_id = ? AND discord_id = ?").run(guildId, memberId);
    const leads = this.db.prepare("SELECT id FROM cm_leads WHERE guild_id = ? AND member_id = ?").all(guildId, memberId) as Array<{ id: string }>;
    for (const l of leads) this.db.prepare("DELETE FROM cm_lead_events WHERE lead_id = ?").run(l.id);
    this.db.prepare("DELETE FROM cm_leads WHERE guild_id = ? AND member_id = ?").run(guildId, memberId);
  }

  // ── leads ──
  createLead(input: Omit<Lead, "id" | "createdAt" | "updatedAt" | "offer"> & { offer?: Lead["offer"] }): Lead {
    const now = Date.now();
    // No dead ends: a lead without a routed offer or a CTA is refused at the store boundary.
    if (!input.primaryOffer || !input.secondaryOffer || !input.cta?.trim()) {
      throw new Error("lead needs a primary offer, a secondary offer and a CTA");
    }
    const lead: Lead = { ...input, offer: input.primaryOffer, id: uid("lead"), createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO cm_leads (id, guild_id, member_id, username, offer, secondary_offer, cta, route_reason, score, tier, breakdown, stage, assignee_id, assignee_name, sla_due_at, thread_id, created_at, updated_at)
         VALUES (@id, @guildId, @memberId, @username, @offer, @secondaryOffer, @cta, @routeReason, @score, @tier, @breakdown, @stage, @assigneeId, @assigneeName, @slaDueAt, @threadId, @createdAt, @updatedAt)`,
      )
      .run({ ...lead, breakdown: json(lead.breakdown) });
    this.leadEvent(lead.id, "engine", "created", {
      score: lead.score,
      tier: lead.tier,
      offer: lead.primaryOffer,
      secondaryOffer: lead.secondaryOffer,
      routeReason: lead.routeReason,
    });
    return lead;
  }

  getLead(id: string): Lead | null {
    const r = this.db.prepare("SELECT * FROM cm_leads WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowToLead(r) : null;
  }

  listLeads(opts: { guildId?: string | null; open?: boolean; limit?: number } = {}): Lead[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.guildId) {
      where.push("guild_id = ?");
      args.push(opts.guildId);
    }
    if (opts.open) where.push("stage NOT IN ('converted','lost')");
    const sql = `SELECT * FROM cm_leads ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, score DESC, created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, opts.limit ?? 200) as Array<Record<string, unknown>>).map(rowToLead);
  }

  updateLead(id: string, patch: Partial<Pick<Lead, "stage" | "assigneeId" | "assigneeName" | "threadId" | "slaDueAt">>, actor = "owner"): Lead | null {
    const lead = this.getLead(id);
    if (!lead) return null;
    const next = { ...lead, ...patch, updatedAt: Date.now() };
    this.db
      .prepare("UPDATE cm_leads SET stage = ?, assignee_id = ?, assignee_name = ?, thread_id = ?, sla_due_at = ?, updated_at = ? WHERE id = ?")
      .run(next.stage, next.assigneeId, next.assigneeName, next.threadId, next.slaDueAt, next.updatedAt, id);
    this.leadEvent(id, actor, "updated", patch);
    return next;
  }

  leadEvent(leadId: string, actor: string, type: string, data: unknown): void {
    this.db.prepare("INSERT INTO cm_lead_events (lead_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)").run(leadId, Date.now(), actor, type, json(data));
  }

  openLoad(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT assignee_id, COUNT(*) AS n FROM cm_leads WHERE assignee_id IS NOT NULL AND stage NOT IN ('converted','lost') GROUP BY assignee_id")
      .all() as Array<{ assignee_id: string; n: number }>;
    return new Map(rows.map((r) => [r.assignee_id, r.n]));
  }

  // ── team ──
  listTeam(): Array<TeamMember & { lastAssignedAt: number }> {
    return (this.db.prepare("SELECT * FROM cm_team ORDER BY name").all() as Array<Record<string, unknown>>).map((r) => ({
      discordId: String(r.discord_id),
      name: String(r.name),
      role: r.role as TeamMember["role"],
      offers: parse(r.offers, []),
      active: r.active === 1,
      lastAssignedAt: Number(r.last_assigned_at ?? 0),
    }));
  }

  saveTeam(team: TeamMember[]): void {
    const tx = this.db.transaction((list: TeamMember[]) => {
      const keep = new Set(list.map((t) => t.discordId));
      for (const row of this.listTeam()) {
        if (!keep.has(row.discordId)) this.db.prepare("DELETE FROM cm_team WHERE discord_id = ?").run(row.discordId);
      }
      for (const t of list) {
        this.db
          .prepare(
            "INSERT INTO cm_team (discord_id, name, role, offers, active) VALUES (?, ?, ?, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, role = excluded.role, offers = excluded.offers, active = excluded.active",
          )
          .run(t.discordId, t.name, t.role, json(t.offers), t.active ? 1 : 0);
      }
    });
    tx(team);
  }

  markAssigned(discordId: string): void {
    this.db.prepare("UPDATE cm_team SET last_assigned_at = ? WHERE discord_id = ?").run(Date.now(), discordId);
  }

  // ── moderation ──
  createModAction(input: Omit<ModAction, "id" | "ts"> & { guildId?: string | null; channelId?: string | null; messageId?: string | null }): ModAction {
    const action: ModAction = {
      id: uid("mod"),
      ts: Date.now(),
      actor: input.actor,
      targetId: input.targetId,
      targetName: input.targetName,
      action: input.action,
      rule: input.rule,
      reason: input.reason,
      evidence: input.evidence,
      status: input.status,
      approvalId: input.approvalId,
      durationMs: input.durationMs,
    };
    this.db
      .prepare(
        `INSERT INTO cm_mod_actions (id, ts, actor, target_id, target_name, action, rule, reason, evidence, evidence_expires_at, status, approval_id, duration_ms, guild_id, channel_id, message_id)
         VALUES (@id, @ts, @actor, @targetId, @targetName, @action, @rule, @reason, @evidence, @expires, @status, @approvalId, @durationMs, @guildId, @channelId, @messageId)`,
      )
      .run({
        ...action,
        expires: action.evidence ? action.ts + 30 * 86_400_000 : null,
        guildId: input.guildId ?? null,
        channelId: input.channelId ?? null,
        messageId: input.messageId ?? null,
      });
    return action;
  }

  getModAction(id: string): (ModAction & { guildId: string | null }) | null {
    const r = this.db.prepare("SELECT * FROM cm_mod_actions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? { ...rowToMod(r), guildId: (r.guild_id as string) ?? null } : null;
  }

  setModStatus(id: string, status: ModActionStatus, approvalId?: string | null): void {
    if (approvalId !== undefined) {
      this.db.prepare("UPDATE cm_mod_actions SET status = ?, approval_id = ? WHERE id = ?").run(status, approvalId, id);
    } else {
      this.db.prepare("UPDATE cm_mod_actions SET status = ? WHERE id = ?").run(status, id);
    }
  }

  listModActions(opts: { status?: ModActionStatus; limit?: number } = {}): ModAction[] {
    // Evidence older than 30 days is dropped on read (retention).
    this.db.prepare("UPDATE cm_mod_actions SET evidence = NULL WHERE evidence_expires_at IS NOT NULL AND evidence_expires_at < ?").run(Date.now());
    const rows = opts.status
      ? this.db.prepare("SELECT * FROM cm_mod_actions WHERE status = ? ORDER BY ts DESC LIMIT ?").all(opts.status, opts.limit ?? 100)
      : this.db.prepare("SELECT * FROM cm_mod_actions ORDER BY ts DESC LIMIT ?").all(opts.limit ?? 100);
    return (rows as Array<Record<string, unknown>>).map(rowToMod);
  }

  // ── tickets ──
  createTicket(input: Omit<Ticket, "id" | "createdAt" | "updatedAt">): Ticket {
    const now = Date.now();
    const t: Ticket = { ...input, id: uid("tkt"), createdAt: now, updatedAt: now };
    this.db
      .prepare("INSERT INTO cm_tickets (id, guild_id, member_id, username, category, thread_id, state, created_at, updated_at) VALUES (@id, @guildId, @memberId, @username, @category, @threadId, @state, @createdAt, @updatedAt)")
      .run(t);
    return t;
  }

  listTickets(opts: { open?: boolean; limit?: number } = {}): Ticket[] {
    const sql = `SELECT * FROM cm_tickets ${opts.open ? "WHERE state NOT IN ('resolved','closed')" : ""} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(opts.limit ?? 100) as Array<Record<string, unknown>>).map(rowToTicket);
  }

  openTicketFor(guildId: string, memberId: string): Ticket | null {
    const r = this.db
      .prepare("SELECT * FROM cm_tickets WHERE guild_id = ? AND member_id = ? AND state NOT IN ('resolved','closed') ORDER BY created_at DESC LIMIT 1")
      .get(guildId, memberId) as Record<string, unknown> | undefined;
    return r ? rowToTicket(r) : null;
  }

  updateTicket(id: string, state: TicketState): Ticket | null {
    this.db.prepare("UPDATE cm_tickets SET state = ?, updated_at = ? WHERE id = ?").run(state, Date.now(), id);
    const r = this.db.prepare("SELECT * FROM cm_tickets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowToTicket(r) : null;
  }

  // ── campaigns ──
  createCampaign(input: Omit<Campaign, "id" | "createdAt" | "approvalId"> & { approvalId?: string | null }): Campaign {
    const c: Campaign = { ...input, approvalId: input.approvalId ?? null, id: uid("cmp"), createdAt: Date.now() };
    this.db
      .prepare("INSERT INTO cm_campaigns (id, title, content, channel_id, schedule_at, status, approval_id, pings_everyone, created_at) VALUES (@id, @title, @content, @channelId, @scheduleAt, @status, @approvalId, @pe, @createdAt)")
      .run({ ...c, pe: c.pingsEveryone ? 1 : 0 });
    return c;
  }

  getCampaign(id: string): Campaign | null {
    const r = this.db.prepare("SELECT * FROM cm_campaigns WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowToCampaign(r) : null;
  }

  listCampaigns(limit = 100): Campaign[] {
    return (this.db.prepare("SELECT * FROM cm_campaigns ORDER BY schedule_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map(rowToCampaign);
  }

  dueCampaigns(now: number): Campaign[] {
    return (this.db.prepare("SELECT * FROM cm_campaigns WHERE status = 'scheduled' AND schedule_at <= ?").all(now) as Array<Record<string, unknown>>).map(rowToCampaign);
  }

  setCampaignStatus(id: string, status: CampaignStatus, approvalId?: string | null): void {
    if (approvalId !== undefined) {
      this.db.prepare("UPDATE cm_campaigns SET status = ?, approval_id = ? WHERE id = ?").run(status, approvalId, id);
    } else {
      this.db.prepare("UPDATE cm_campaigns SET status = ? WHERE id = ?").run(status, id);
    }
  }

  // ── activity + metrics ──
  addActivity(kind: ActivityKind, text: string, dry = false): Activity {
    const ts = Date.now();
    const info = this.db.prepare("INSERT INTO cm_activity (ts, kind, text, dry) VALUES (?, ?, ?, ?)").run(ts, kind, text.slice(0, 500), dry ? 1 : 0);
    // Keep the feed bounded.
    this.db.prepare("DELETE FROM cm_activity WHERE id <= ? - 5000").run(Number(info.lastInsertRowid));
    return { id: Number(info.lastInsertRowid), ts, kind, text, dry };
  }

  listActivity(opts: { afterId?: number; limit?: number } = {}): Activity[] {
    const rows = this.db
      .prepare("SELECT * FROM cm_activity WHERE id > ? ORDER BY id DESC LIMIT ?")
      .all(opts.afterId ?? 0, opts.limit ?? 100) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), ts: Number(r.ts), kind: r.kind as ActivityKind, text: String(r.text), dry: r.dry === 1 }));
  }

  bumpMetric(guildId: string, field: "joins" | "leaves" | "verified" | "messages" | "leads", n = 1, at = Date.now()): void {
    const date = dayKey(at);
    this.db.prepare("INSERT INTO cm_metrics_daily (date, guild_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(date, guildId);
    this.db.prepare(`UPDATE cm_metrics_daily SET ${field} = ${field} + ? WHERE date = ? AND guild_id = ?`).run(n, date, guildId);
  }

  markActive(guildId: string, memberId: string, at = Date.now()): void {
    this.db.prepare("INSERT OR IGNORE INTO cm_daily_active (date, guild_id, member_id) VALUES (?, ?, ?)").run(dayKey(at), guildId, memberId);
  }

  metricsSince(guildId: string | null, fromDate: string): Array<{ date: string; joins: number; leaves: number; verified: number; messages: number; leads: number; active: number }> {
    const rows = this.db
      .prepare(
        `SELECT m.date, SUM(m.joins) joins, SUM(m.leaves) leaves, SUM(m.verified) verified, SUM(m.messages) messages, SUM(m.leads) leads,
           (SELECT COUNT(*) FROM cm_daily_active a WHERE a.date = m.date ${guildId ? "AND a.guild_id = @g" : ""}) active
         FROM cm_metrics_daily m WHERE m.date >= @from ${guildId ? "AND m.guild_id = @g" : ""} GROUP BY m.date ORDER BY m.date`,
      )
      .all({ from: fromDate, g: guildId }) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      date: String(r.date),
      joins: Number(r.joins ?? 0),
      leaves: Number(r.leaves ?? 0),
      verified: Number(r.verified ?? 0),
      messages: Number(r.messages ?? 0),
      leads: Number(r.leads ?? 0),
      active: Number(r.active ?? 0),
    }));
  }

  /** Messages since the last disclaimer in this channel (incremented, returned). */
  bumpChannelCounter(channelId: string): number {
    this.db.prepare("INSERT INTO cm_channel_counters (channel_id, since_disclaimer) VALUES (?, 1) ON CONFLICT(channel_id) DO UPDATE SET since_disclaimer = since_disclaimer + 1").run(channelId);
    const r = this.db.prepare("SELECT since_disclaimer n FROM cm_channel_counters WHERE channel_id = ?").get(channelId) as { n: number };
    return r.n;
  }

  resetChannelCounter(channelId: string): void {
    this.db.prepare("UPDATE cm_channel_counters SET since_disclaimer = 0 WHERE channel_id = ?").run(channelId);
  }

  count(sql: string, ...args: unknown[]): number {
    const r = this.db.prepare(sql).get(...args) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  }
}

function diffKeys(a: Settings, b: Settings): string[] {
  return (Object.keys(b) as Array<keyof Settings>).filter((k) => k !== "version" && json(a[k]) !== json(b[k]));
}

function rowToMember(r: Record<string, unknown>): MemberRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    guildId: String(r.guild_id),
    discordId: String(r.discord_id),
    username: String(r.username),
    joinedAt: n(r.joined_at),
    accountCreatedAt: n(r.account_created_at),
    verifiedAt: n(r.verified_at),
    riskScore: Number(r.risk_score ?? 0),
    intakeDoneAt: n(r.intake_done_at),
    welcomedAt: n(r.welcomed_at),
    strikes: Number(r.strikes ?? 0),
    review: (r.review as string) ?? null,
  };
}

function rowToLead(r: Record<string, unknown>): Lead {
  // Rows written before offer routing may say "none" and have no secondary/CTA: give them the
  // default route (InfiniBot free + KinglyVault free) so no lead ever reads as a dead end.
  const primary = (ROUTED_OFFERS as string[]).includes(String(r.offer)) ? (r.offer as RoutedOffer) : DEFAULT_ROUTE.primaryOffer;
  const secondaryRaw = String(r.secondary_offer ?? "");
  const secondary = (ROUTED_OFFERS as string[]).includes(secondaryRaw) && secondaryRaw !== primary
    ? (secondaryRaw as RoutedOffer)
    : primary === "infinibot" ? "kinglyvault" : "infinibot";
  const cta = typeof r.cta === "string" && r.cta.trim() ? r.cta : buildCta(primary, secondary);
  return {
    id: String(r.id),
    guildId: String(r.guild_id),
    memberId: String(r.member_id),
    username: String(r.username),
    offer: primary,
    primaryOffer: primary,
    secondaryOffer: secondary,
    cta,
    routeReason: typeof r.route_reason === "string" && r.route_reason ? r.route_reason : "default",
    score: Number(r.score),
    tier: r.tier as Lead["tier"],
    breakdown: parse(r.breakdown, []),
    stage: r.stage as LeadStage,
    assigneeId: (r.assignee_id as string) ?? null,
    assigneeName: (r.assignee_name as string) ?? null,
    slaDueAt: r.sla_due_at == null ? null : Number(r.sla_due_at),
    threadId: (r.thread_id as string) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToMod(r: Record<string, unknown>): ModAction {
  return {
    id: String(r.id),
    ts: Number(r.ts),
    actor: String(r.actor),
    targetId: (r.target_id as string) ?? null,
    targetName: (r.target_name as string) ?? null,
    action: r.action as ModAction["action"],
    rule: String(r.rule),
    reason: String(r.reason),
    evidence: (r.evidence as string) ?? null,
    status: r.status as ModActionStatus,
    approvalId: (r.approval_id as string) ?? null,
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
  };
}

function rowToTicket(r: Record<string, unknown>): Ticket {
  return {
    id: String(r.id),
    guildId: String(r.guild_id),
    memberId: String(r.member_id),
    username: String(r.username),
    category: String(r.category),
    threadId: (r.thread_id as string) ?? null,
    state: r.state as TicketState,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToCampaign(r: Record<string, unknown>): Campaign {
  return {
    id: String(r.id),
    title: String(r.title),
    content: String(r.content),
    channelId: (r.channel_id as string) ?? null,
    scheduleAt: Number(r.schedule_at),
    status: r.status as CampaignStatus,
    approvalId: (r.approval_id as string) ?? null,
    pingsEveryone: r.pings_everyone === 1,
    createdAt: Number(r.created_at),
  };
}
