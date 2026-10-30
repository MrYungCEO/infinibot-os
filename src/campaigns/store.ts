/**
 * Campaigns — SQLite data store.
 *
 * Self-contained DB at `state/campaigns/campaigns.db` (same convention as
 * funnels). Single `campaigns` table. CRUD + stats recompute. Idempotent
 * `CREATE TABLE IF NOT EXISTS` plus an idempotent column-add migration
 * so re-running on an existing DB is safe.
 *
 * Stats are derived: `recomputeStats(id)` walks funnel leads stamped
 * with this campaignId and counts qualified / converted. Email + reply
 * counters are bumped by upstream subsystems via `bumpStat()`.
 */

import { mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { getFunnelStore } from "../funnels/store.js";
import type {
  Campaign,
  CampaignFilters,
  CampaignInput,
  CampaignPatch,
  CampaignStats,
  CampaignStatus,
} from "./types.js";

// ─── Singleton ──────────────────────────────────────────────────

let instance: CampaignsStore | null = null;

export function getCampaignsStore(dbPath?: string): CampaignsStore {
  if (!instance) {
    const path = dbPath ?? join(process.cwd(), "state", "campaigns", "campaigns.db");
    instance = new CampaignsStore(path);
  }
  return instance;
}

export function resetCampaignsStore(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// ─── Store ──────────────────────────────────────────────────────

export class CampaignsStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
    this.runMigrations();
  }

  close(): void {
    this.db.close();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        business_id TEXT NOT NULL,
        product_ids TEXT NOT NULL DEFAULT '[]',
        funnel_id TEXT,
        target_audience TEXT NOT NULL DEFAULT '{}',
        goal TEXT NOT NULL DEFAULT '{}',
        context TEXT NOT NULL DEFAULT '{}',
        stats TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaigns_business ON campaigns(business_id);
      CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
      CREATE INDEX IF NOT EXISTS idx_campaigns_funnel ON campaigns(funnel_id);
    `);
  }

  private runMigrations(): void {
    const safeAddColumn = (table: string, column: string, def: string) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    };
    // Reserved for future evolution — kept here so the pattern matches
    // funnels/store.ts and adding columns later is a one-line change.
    void safeAddColumn;
  }

  // ─── CRUD ─────────────────────────────────────────────────────

  list(filters?: CampaignFilters): Campaign[] {
    let sql = "SELECT * FROM campaigns WHERE 1=1";
    const params: unknown[] = [];
    if (filters?.businessId) {
      sql += " AND business_id = ?";
      params.push(filters.businessId);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToCampaign(r));
  }

  get(id: string): Campaign | null {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as any;
    return row ? this.rowToCampaign(row) : null;
  }

  create(input: CampaignInput): Campaign {
    if (!input.name?.trim()) throw new Error("name required");
    if (!input.businessId?.trim()) throw new Error("businessId required");

    const id = randomUUID();
    const now = Date.now();
    const campaign: Campaign = {
      id,
      name: input.name.trim(),
      status: input.status ?? "draft",
      businessId: input.businessId,
      productIds: input.productIds ?? [],
      funnelId: input.funnelId ?? null,
      targetAudience: {
        description: input.targetAudience?.description ?? "",
        industry: input.targetAudience?.industry,
        region: input.targetAudience?.region,
        companySize: input.targetAudience?.companySize,
        customFilters: input.targetAudience?.customFilters,
      },
      goal: {
        primaryConversion: input.goal?.primaryConversion ?? "",
        secondaryConversion: input.goal?.secondaryConversion,
        targetCount: input.goal?.targetCount,
        targetDate: input.goal?.targetDate,
      },
      context: {
        valueProp: input.context?.valueProp ?? "",
        differentiators: input.context?.differentiators,
        tone: input.context?.tone,
        notes: input.context?.notes,
      },
      stats: emptyStats(),
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO campaigns (id, name, status, business_id, product_ids, funnel_id, target_audience, goal, context, stats, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.businessId,
        JSON.stringify(campaign.productIds),
        campaign.funnelId,
        JSON.stringify(campaign.targetAudience),
        JSON.stringify(campaign.goal),
        JSON.stringify(campaign.context),
        JSON.stringify(campaign.stats),
        campaign.createdAt,
        campaign.updatedAt,
      );

    return campaign;
  }

  update(id: string, patch: CampaignPatch): Campaign | null {
    const existing = this.get(id);
    if (!existing) return null;

    const merged: Campaign = {
      ...existing,
      name: patch.name?.trim() || existing.name,
      status: patch.status ?? existing.status,
      productIds: patch.productIds ?? existing.productIds,
      funnelId: patch.funnelId !== undefined ? patch.funnelId : existing.funnelId,
      targetAudience: patch.targetAudience
        ? { ...existing.targetAudience, ...patch.targetAudience }
        : existing.targetAudience,
      goal: patch.goal ? { ...existing.goal, ...patch.goal } : existing.goal,
      context: patch.context ? { ...existing.context, ...patch.context } : existing.context,
      updatedAt: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE campaigns
         SET name = ?, status = ?, product_ids = ?, funnel_id = ?,
             target_audience = ?, goal = ?, context = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.status,
        JSON.stringify(merged.productIds),
        merged.funnelId,
        JSON.stringify(merged.targetAudience),
        JSON.stringify(merged.goal),
        JSON.stringify(merged.context),
        merged.updatedAt,
        id,
      );

    return merged;
  }

  delete(id: string): boolean {
    const res = this.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
    return res.changes > 0;
  }

  /**
   * Recompute leadsTotal / leadsQualified / leadsConverted by scanning
   * funnel leads stamped with this campaignId. Email + reply counters
   * are not touched — those are bumped by the dispatcher when sends
   * succeed and by inbound handlers when replies land.
   */
  recomputeStats(id: string): Campaign | null {
    const existing = this.get(id);
    if (!existing) return null;

    let leadsTotal = 0;
    let leadsQualified = 0;
    let leadsConverted = 0;

    try {
      const funnelStore = getFunnelStore();
      const all = funnelStore.listLeads({
        businessId: existing.businessId,
        limit: 10_000,
      });
      for (const lead of all) {
        const lcid = (lead as { campaignId?: string }).campaignId;
        if (lcid !== id) continue;
        leadsTotal += 1;
        if (typeof lead.score === "number" && lead.score >= 50) leadsQualified += 1;
        if (lead.status === "won" || lead.wonAt) leadsConverted += 1;
      }
    } catch {
      // Funnel store may not be initialized in tests — fall back to 0s.
    }

    const stats: CampaignStats = {
      ...existing.stats,
      leadsTotal,
      leadsQualified,
      leadsConverted,
    };
    this.db
      .prepare("UPDATE campaigns SET stats = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(stats), Date.now(), id);

    return { ...existing, stats, updatedAt: Date.now() };
  }

  /** Bump one counter on the stats blob (used by email dispatcher etc.). */
  bumpStat(id: string, key: keyof CampaignStats, by = 1): void {
    const existing = this.get(id);
    if (!existing) return;
    const stats = { ...existing.stats, [key]: (existing.stats[key] ?? 0) + by };
    this.db
      .prepare("UPDATE campaigns SET stats = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(stats), Date.now(), id);
  }

  // ─── Row mapping ──────────────────────────────────────────────

  private rowToCampaign(row: any): Campaign {
    return {
      id: row.id,
      name: row.name,
      status: row.status as CampaignStatus,
      businessId: row.business_id,
      productIds: safeJson<string[]>(row.product_ids, []),
      funnelId: row.funnel_id ?? null,
      targetAudience: safeJson<Campaign["targetAudience"]>(row.target_audience, {
        description: "",
      }),
      goal: safeJson<Campaign["goal"]>(row.goal, { primaryConversion: "" }),
      context: safeJson<Campaign["context"]>(row.context, { valueProp: "" }),
      stats: { ...emptyStats(), ...safeJson<Partial<CampaignStats>>(row.stats, {}) },
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

function emptyStats(): CampaignStats {
  return {
    leadsTotal: 0,
    leadsQualified: 0,
    leadsConverted: 0,
    emailsSent: 0,
    repliesReceived: 0,
  };
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
