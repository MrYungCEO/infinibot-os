/**
 * Funnel System — SQLite Data Store
 * Full CRUD operations using better-sqlite3
 */

import { mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import type {
  Business,
  Funnel,
  FunnelStatus,
  FunnelType,
  Stage,
  StageType,
  StageConnection,
  Lead,
  LeadFilters,
  LeadActivity,
  LeadStageHistory,
  Offer,
  FunnelTask,
  TaskFilters,
  Conversation,
  ConversationMessage,
  QualificationRule,
  KPIMetric,
  KPISnapshot,
  FunnelFilters,
  FunnelAnalytics,
  MetricPeriod,
  FunnelFlowMap,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════
// SINGLETON STORE
// ═══════════════════════════════════════════════════════════════

let instance: FunnelStore | null = null;

export function getFunnelStore(dbPath?: string): FunnelStore {
  if (!instance) {
    const path = dbPath ?? join(process.cwd(), "state", "funnels", "funnels.db");
    instance = new FunnelStore(path);
  }
  return instance;
}

export function resetFunnelStore(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// FUNNEL STORE CLASS
// ═══════════════════════════════════════════════════════════════

export type LeadStoreEvent =
  | { kind: "lead_created"; lead: Lead }
  | {
      kind: "lead_updated";
      lead: Lead;
      before: Lead;
      changed: ReadonlyArray<keyof Lead>;
    }
  | {
      kind: "stage_changed";
      lead: Lead;
      fromStageId: string;
      toStageId: string;
      reason?: string;
    }
  | { kind: "tag_added"; lead: Lead; tag: string }
  | { kind: "tag_removed"; lead: Lead; tag: string }
  | { kind: "score_changed"; lead: Lead; oldScore?: number; newScore?: number };

export type LeadEventHandler = (event: LeadStoreEvent) => void;

// ─── Slice C helpers: derive stage type / legacy node type from libraryId ──
//
// The unified model treats canvas nodes and funnel stages as the same
// record. A node's `libraryId` (production taxonomy) is the source of
// truth; we project it into a StageType (entry/standard/exit) for the
// funnel side and into a legacy FlowNodeType (entry/social/landing/…)
// for the canvas side so the existing UI render code keeps working.

const SOURCE_LIBRARY_IDS = new Set([
  "instagram",
  "tiktok",
  "youtube",
  "twitter",
  "linkedin",
  "paid_ad",
  "referral",
  "organic_search",
  "cold_outreach",
]);
const TERMINAL_LIBRARY_IDS = new Set([
  "course_community",
  "membership_tier",
  "coaching_program",
  "dfy_service",
  "won",
  "lost",
  "promoted_to_crm",
]);

function deriveStageType(
  libraryId?: string,
  fallback?: import("./types.js").StageType,
): import("./types.js").StageType {
  if (libraryId) {
    if (SOURCE_LIBRARY_IDS.has(libraryId)) return "entry";
    if (TERMINAL_LIBRARY_IDS.has(libraryId)) return "exit";
    return "standard";
  }
  return fallback ?? "standard";
}

function deriveLegacyNodeType(
  libraryId?: string,
  fallback?: import("./types.js").StageType,
): string {
  if (!libraryId) return fallback ?? "custom";
  // Map library ids to the legacy FlowNodeType strings the UI renders.
  switch (libraryId) {
    case "instagram":
    case "tiktok":
    case "youtube":
    case "twitter":
    case "linkedin":
    case "retargeting_ad":
      return "social";
    case "email_seq":
    case "sms_seq":
    case "dm_followup":
    case "drip_course":
      return "messaging";
    case "lead_magnet":
    case "newsletter_signup":
    case "calendar_booking":
    case "webinar_reg":
    case "sales_page":
    case "discovery_call":
    case "application_form":
      return "landing";
    case "checkout":
    case "tripwire":
      return "offer";
    case "lead_scorer":
    case "manual_review":
    case "tag_route":
    case "quiz":
      return "qualification";
    case "course_community":
    case "membership_tier":
      return "community";
    case "coaching_program":
    case "dfy_service":
      return "offer";
    case "affiliate_hub":
      return "hub";
    case "paid_ad":
    case "referral":
    case "organic_search":
    case "cold_outreach":
      return "entry";
    default:
      return "custom";
  }
}

export class FunnelStore {
  private db: Database.Database;
  private leadEventHandlers: LeadEventHandler[] = [];

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
    this.runMigrations();
  }

  /**
   * Idempotent column-add migrations for SQLite. Each line either adds
   * the column or no-ops if the column already exists. SQLite has no
   * `ADD COLUMN IF NOT EXISTS` so we catch the duplicate-column error.
   */
  private runMigrations(): void {
    const safeAddColumn = (table: string, column: string, def: string) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    };
    // Slice B: flow_maps.funnel_id — binding from a flow map to the
    // live funnel record materialized by funnels.flowmap.promote.
    safeAddColumn("flow_maps", "funnel_id", "TEXT");
    // Index lives here (not in createTables) because on pre-existing
    // DBs the column was just added by the ALTER above.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_flow_maps_funnel ON flow_maps(funnel_id)");

    // Slice C: stages get canvas visual fields. A funnel + its stages
    // is now THE canvas — these columns hold the visual + integration
    // state the old `flow_maps.nodes` JSON used to carry. All optional
    // so existing funnels keep rendering with sensible defaults.
    safeAddColumn("stages", "library_id", "TEXT");
    safeAddColumn("stages", "emoji", "TEXT");
    safeAddColumn("stages", "canvas_row", "INTEGER");
    safeAddColumn("stages", "canvas_column", "INTEGER");
    safeAddColumn("stages", "items_json", "TEXT");
    safeAddColumn("stages", "integration_json", "TEXT");
    safeAddColumn("stages", "page_link_json", "TEXT");
    safeAddColumn("stages", "kpi_tracking_json", "TEXT");

    // Outreach-campaign linkage. A lead carries the originating campaign
    // so the qualifier can assemble campaign context (business + products
    // + audience + funnel + goal) and pass it into email/doc generation.
    safeAddColumn("leads", "campaign_id", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id)");
  }

  close(): void {
    this.db.close();
  }

  onLeadEvent(handler: LeadEventHandler): () => void {
    this.leadEventHandlers.push(handler);
    return () => {
      const i = this.leadEventHandlers.indexOf(handler);
      if (i >= 0) this.leadEventHandlers.splice(i, 1);
    };
  }

  private emitLeadEvent(event: LeadStoreEvent): void {
    for (const h of this.leadEventHandlers) {
      try {
        h(event);
      } catch {
        // Handlers must not break store writes.
      }
    }
  }

  private createTables(): void {
    this.db.exec(`
      -- BUSINESSES
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        industry TEXT,
        website TEXT,
        logo TEXT,
        email TEXT,
        phone TEXT,
        address TEXT,
        timezone TEXT DEFAULT 'UTC',
        currency TEXT DEFAULT 'USD',
        owner_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_id);

      -- FUNNELS
      CREATE TABLE IF NOT EXISTS funnels (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'sales',
        status TEXT NOT NULL DEFAULT 'draft',
        color TEXT,
        icon TEXT,
        automation_enabled INTEGER DEFAULT 0,
        webhook_url TEXT,
        total_leads INTEGER DEFAULT 0,
        conversion_rate REAL,
        avg_days_in_funnel REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_funnels_business ON funnels(business_id);
      CREATE INDEX IF NOT EXISTS idx_funnels_status ON funnels(status);

      -- STAGES
      CREATE TABLE IF NOT EXISTS stages (
        id TEXT PRIMARY KEY,
        funnel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'standard',
        position INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        icon TEXT,
        auto_move_after_days INTEGER,
        max_days_allowed INTEGER,
        qualification_rules TEXT DEFAULT '[]',
        lead_count INTEGER DEFAULT 0,
        avg_time_in_stage REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stages_funnel ON stages(funnel_id);

      -- STAGE CONNECTIONS
      CREATE TABLE IF NOT EXISTS stage_connections (
        id TEXT PRIMARY KEY,
        funnel_id TEXT NOT NULL,
        source_stage_id TEXT NOT NULL,
        target_stage_id TEXT NOT NULL,
        label TEXT,
        condition_type TEXT DEFAULT 'manual',
        condition_config TEXT,
        transition_count INTEGER DEFAULT 0,
        avg_transition_time REAL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE,
        FOREIGN KEY (source_stage_id) REFERENCES stages(id) ON DELETE CASCADE,
        FOREIGN KEY (target_stage_id) REFERENCES stages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_connections_funnel ON stage_connections(funnel_id);

      -- LEADS
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        funnel_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        title TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'new',
        priority TEXT NOT NULL DEFAULT 'medium',
        score INTEGER,
        estimated_value REAL,
        currency TEXT DEFAULT 'USD',
        assigned_to TEXT,
        tags TEXT DEFAULT '[]',
        custom_fields TEXT DEFAULT '{}',
        first_contact_at TEXT,
        last_contact_at TEXT,
        last_activity_at TEXT,
        expected_close_date TEXT,
        actual_value REAL,
        lost_reason TEXT,
        won_at TEXT,
        lost_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE,
        FOREIGN KEY (stage_id) REFERENCES stages(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id);
      CREATE INDEX IF NOT EXISTS idx_leads_funnel ON leads(funnel_id);
      CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage_id);
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);

      -- LEAD ACTIVITIES
      CREATE TABLE IF NOT EXISTS lead_activities (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        metadata TEXT,
        performed_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_activities_lead ON lead_activities(lead_id);

      -- LEAD STAGE HISTORY
      CREATE TABLE IF NOT EXISTS lead_stage_history (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL,
        from_stage_id TEXT,
        to_stage_id TEXT NOT NULL,
        reason TEXT,
        performed_by TEXT,
        time_in_previous_stage INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stage_history_lead ON lead_stage_history(lead_id);

      -- OFFERS
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'product',
        status TEXT NOT NULL DEFAULT 'draft',
        price REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        discount_percent REAL,
        discount_amount REAL,
        valid_from TEXT,
        valid_until TEXT,
        max_redemptions INTEGER,
        current_redemptions INTEGER DEFAULT 0,
        target_stages TEXT DEFAULT '[]',
        target_tags TEXT DEFAULT '[]',
        min_score INTEGER,
        hero_image TEXT,
        features TEXT DEFAULT '[]',
        terms TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_offers_business ON offers(business_id);

      -- OFFER PRESENTATIONS
      CREATE TABLE IF NOT EXISTS offer_presentations (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        presented_at TEXT NOT NULL,
        presented_by TEXT,
        response TEXT,
        responded_at TEXT,
        notes TEXT,
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_presentations_offer ON offer_presentations(offer_id);
      CREATE INDEX IF NOT EXISTS idx_presentations_lead ON offer_presentations(lead_id);

      -- FUNNEL TASKS
      CREATE TABLE IF NOT EXISTS funnel_tasks (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        funnel_id TEXT,
        lead_id TEXT,
        stage_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'follow_up',
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        assigned_to TEXT,
        created_by TEXT,
        due_at TEXT,
        reminder_at TEXT,
        completed_at TEXT,
        auto_generated INTEGER DEFAULT 0,
        rule_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE SET NULL,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_business ON funnel_tasks(business_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_lead ON funnel_tasks(lead_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON funnel_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON funnel_tasks(due_at);

      -- CONVERSATIONS
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        subject TEXT,
        external_id TEXT,
        external_url TEXT,
        participant_ids TEXT DEFAULT '[]',
        assigned_to TEXT,
        message_count INTEGER DEFAULT 0,
        last_message_at TEXT,
        last_message_by TEXT,
        sentiment TEXT,
        sentiment_score REAL,
        started_at TEXT NOT NULL,
        closed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_lead ON conversations(lead_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

      -- CONVERSATION MESSAGES
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        attachments TEXT DEFAULT '[]',
        read_at TEXT,
        delivered_at TEXT,
        summary TEXT,
        extracted_data TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages(conversation_id);

      -- QUALIFICATION RULES
      CREATE TABLE IF NOT EXISTS qualification_rules (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        funnel_id TEXT,
        stage_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        trigger_on TEXT NOT NULL DEFAULT 'lead_updated',
        trigger_field TEXT,
        conditions TEXT NOT NULL DEFAULT '[]',
        actions TEXT NOT NULL DEFAULT '[]',
        trigger_count INTEGER DEFAULT 0,
        last_triggered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_rules_business ON qualification_rules(business_id);
      CREATE INDEX IF NOT EXISTS idx_rules_enabled ON qualification_rules(enabled);

      -- KPI METRICS
      CREATE TABLE IF NOT EXISTS kpi_metrics (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        funnel_id TEXT,
        stage_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'count',
        formula TEXT,
        source_field TEXT,
        aggregation TEXT,
        current_value REAL NOT NULL DEFAULT 0,
        previous_value REAL,
        change_percent REAL,
        target_value REAL,
        warning_threshold REAL,
        critical_threshold REAL,
        unit TEXT,
        precision INTEGER DEFAULT 2,
        display_format TEXT,
        period TEXT NOT NULL DEFAULT 'monthly',
        period_start TEXT,
        period_end TEXT,
        calculated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_business ON kpi_metrics(business_id);

      -- KPI SNAPSHOTS
      CREATE TABLE IF NOT EXISTS kpi_snapshots (
        id TEXT PRIMARY KEY,
        metric_id TEXT NOT NULL,
        value REAL NOT NULL,
        period TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (metric_id) REFERENCES kpi_metrics(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_metric ON kpi_snapshots(metric_id);

      -- FLOW MAPS (Visual Funnel Builder)
      CREATE TABLE IF NOT EXISTS flow_maps (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        name TEXT NOT NULL,
        nodes TEXT NOT NULL DEFAULT '[]',
        connections TEXT NOT NULL DEFAULT '[]',
        funnel_id TEXT, -- optional binding to a live funnel record (set by funnels.flowmap.promote)
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_flow_maps_business ON flow_maps(business_id);
      -- idx_flow_maps_funnel is created in runMigrations() below — on
      -- pre-existing DBs the funnel_id column is ADDed by migration, so
      -- the index must be created AFTER the column exists.

      -- FORM → FUNNEL BINDINGS
      -- Links a published qualifier form to a funnel + entry stage so
      -- submissions auto-create a lead in the right place. Single
      -- binding per form id (one form feeds one funnel/stage) — if the
      -- user wants fan-out they create duplicate forms.
      CREATE TABLE IF NOT EXISTS funnel_form_bindings (
        form_id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        funnel_id TEXT NOT NULL,
        entry_stage_id TEXT NOT NULL,
        tag TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_funnel_form_bindings_funnel
        ON funnel_form_bindings(funnel_id);
      CREATE INDEX IF NOT EXISTS idx_funnel_form_bindings_business
        ON funnel_form_bindings(business_id);

      -- LANDING-PAGE → FUNNEL BINDINGS (mirrors the form binding shape
      -- so the same intake path serves either source).
      CREATE TABLE IF NOT EXISTS funnel_page_bindings (
        page_id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        funnel_id TEXT NOT NULL,
        entry_stage_id TEXT NOT NULL,
        tag TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_funnel_page_bindings_funnel
        ON funnel_page_bindings(funnel_id);
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
  // BUSINESS OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  createBusiness(data: Omit<Business, "id" | "createdAt" | "updatedAt">): Business {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO businesses (id, name, description, industry, website, logo, email, phone, address, timezone, currency, owner_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.name,
        data.description ?? null,
        data.industry ?? null,
        data.website ?? null,
        data.logo ?? null,
        data.email ?? null,
        data.phone ?? null,
        data.address ?? null,
        data.timezone ?? "UTC",
        data.currency ?? "USD",
        data.ownerId ?? null,
        now,
        now,
      );

    return this.getBusiness(id)!;
  }

  /**
   * Insert-or-update a business row at a specific id. Used to mirror rows
   * from the main business store (state/business.json) into funnels.db so
   * funnel/lead/offer FK constraints to `businesses(id)` stay satisfied
   * when a funnel is created against a business that was first set up in
   * the main app, not in the funnels-onboarding wizard.
   *
   * Skips updates to created_at when the row already exists so the audit
   * timestamp reflects the original creation, not the mirror.
   */
  /**
   * Return (or create) the per-business "Inbox" funnel — a default landing
   * funnel for unrouted leads coming from the lead generator, the qualifier,
   * or any external integration. The inbox has exactly one entry stage
   * ("New") so every external lead can be persisted into the canonical lead
   * store without the caller having to invent a funnel context.
   *
   * The inbox is created lazily on first call and reused thereafter. Naming
   * is stable (`__Inbox`) so it's distinct from user-named funnels and won't
   * collide with future user creations.
   */
  ensureInboxFunnel(businessId: string): { funnel: Funnel; stage: Stage } {
    const INBOX_NAME = "__Inbox";
    // Try to find an existing inbox first.
    const existingRow = this.db
      .prepare(
        "SELECT id FROM funnels WHERE business_id = ? AND name = ? AND archived_at IS NULL LIMIT 1",
      )
      .get(businessId, INBOX_NAME) as { id: string } | undefined;
    let funnel: Funnel;
    if (existingRow) {
      funnel = this.getFunnel(existingRow.id)!;
    } else {
      funnel = this.createFunnel({
        businessId,
        name: INBOX_NAME,
        description: "Unrouted leads from the lead generator + external sources.",
        type: "custom",
        status: "active",
      });
    }
    // Ensure exactly one entry stage exists.
    const stageRow = this.db
      .prepare(
        "SELECT id FROM stages WHERE funnel_id = ? AND type = 'entry' ORDER BY position ASC LIMIT 1",
      )
      .get(funnel.id) as { id: string } | undefined;
    const stage = stageRow
      ? this.getStage(stageRow.id)!
      : this.addStage({
          funnelId: funnel.id,
          name: "New",
          description: "Newly discovered leads awaiting triage.",
          type: "entry",
          position: 0,
        });
    return { funnel, stage };
  }

  /**
   * Upsert a lead originating from an external system (lead generator,
   * webhook, qualifier action, etc.) into the canonical leads table.
   *
   * Routes to the per-business Inbox funnel when no explicit funnel/stage
   * is provided. Dedupes by `externalId` (preferred) or by
   * `(businessId, email|phone|website)` so re-running a search doesn't
   * spawn duplicates.
   *
   * Returns the persisted Lead with the funnel id stamped in custom_fields
   * so callers can correlate back to the external system.
   */
  upsertLeadFromExternal(payload: {
    businessId: string;
    /** External system id (e.g. lead-gen Lead.id). Used for dedup. */
    externalId?: string;
    /** External source ("google_maps", "manual", "qualifier", etc.). */
    source?: string;
    /** Display name — falls back to company when missing. */
    name?: string;
    company?: string;
    title?: string;
    email?: string;
    phone?: string;
    /** Anything else worth keeping — stashed verbatim into custom_fields. */
    metadata?: Record<string, unknown>;
    /** Optional override for which funnel/stage to land in. Defaults to inbox. */
    funnelId?: string;
    stageId?: string;
    /** Initial tags. Merged with any existing tags on dedup. */
    tags?: string[];
  }): Lead {
    // Mirror the business row so the FK to businesses(id) holds. Callers
    // shouldn't have to pre-call upsertBusinessRaw; the inbox flow is the
    // canonical entry point for external systems and needs to be safe to
    // call on a fresh database.
    const existingBiz = this.getBusiness(payload.businessId);
    if (!existingBiz) {
      this.upsertBusinessRaw({
        id: payload.businessId,
        name: payload.businessId, // will be overwritten by the business-mirror call
      });
    }

    const { funnel, stage } =
      payload.funnelId && payload.stageId
        ? {
            funnel: this.getFunnel(payload.funnelId)!,
            stage: this.getStage(payload.stageId)!,
          }
        : this.ensureInboxFunnel(payload.businessId);

    // Dedup lookup. Prefer externalId match (stored in custom_fields.externalId);
    // fall back to email/phone match within the same business.
    let existingRow: { id: string; custom_fields: string; tags: string } | undefined;
    if (payload.externalId) {
      existingRow = this.db
        .prepare(
          // SQLite has json_extract; matching the raw JSON substring is faster
          // and avoids the JSON1 dependency in pathological deployments.
          "SELECT id, custom_fields, tags FROM leads WHERE business_id = ? AND custom_fields LIKE ? AND archived_at IS NULL LIMIT 1",
        )
        .get(payload.businessId, `%"externalId":"${payload.externalId.replace(/"/g, '\\"')}"%`) as
        | { id: string; custom_fields: string; tags: string }
        | undefined;
    }
    if (!existingRow && payload.email) {
      existingRow = this.db
        .prepare(
          "SELECT id, custom_fields, tags FROM leads WHERE business_id = ? AND email = ? AND archived_at IS NULL LIMIT 1",
        )
        .get(payload.businessId, payload.email) as
        | { id: string; custom_fields: string; tags: string }
        | undefined;
    }
    if (!existingRow && payload.phone) {
      existingRow = this.db
        .prepare(
          "SELECT id, custom_fields, tags FROM leads WHERE business_id = ? AND phone = ? AND archived_at IS NULL LIMIT 1",
        )
        .get(payload.businessId, payload.phone) as
        | { id: string; custom_fields: string; tags: string }
        | undefined;
    }

    const now = this.now();
    const parseJsonOr = <T>(raw: string | null | undefined, fallback: T): T => {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };

    const customFields: Record<string, unknown> = existingRow
      ? parseJsonOr<Record<string, unknown>>(existingRow.custom_fields, {})
      : {};
    if (payload.externalId) customFields.externalId = payload.externalId;
    if (payload.metadata) Object.assign(customFields, payload.metadata);

    const mergedTags = existingRow
      ? Array.from(
          new Set([...parseJsonOr<string[]>(existingRow.tags, []), ...(payload.tags ?? [])]),
        )
      : (payload.tags ?? []);

    const displayName = payload.name ?? payload.company ?? payload.email ?? "Untitled Lead";

    if (existingRow) {
      this.db
        .prepare(
          `UPDATE leads SET name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone), company = COALESCE(?, company), title = COALESCE(?, title), source = COALESCE(?, source), tags = ?, custom_fields = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          displayName,
          payload.email ?? null,
          payload.phone ?? null,
          payload.company ?? null,
          payload.title ?? null,
          payload.source ?? null,
          JSON.stringify(mergedTags),
          JSON.stringify(customFields),
          now,
          now,
          existingRow.id,
        );
      this.addLeadActivity({
        leadId: existingRow.id,
        type: "system",
        description: `Refreshed from external source${payload.source ? ` (${payload.source})` : ""}`,
      });
      return this.getLead(existingRow.id)!;
    }

    const created = this.createLead({
      businessId: payload.businessId,
      funnelId: funnel.id,
      stageId: stage.id,
      name: displayName,
      email: payload.email,
      phone: payload.phone,
      company: payload.company,
      title: payload.title,
      source: (payload.source ?? "manual") as Lead["source"],
      status: "new",
      priority: "medium",
      tags: mergedTags,
      customFields,
    } as Omit<Lead, "id" | "createdAt" | "updatedAt"> & { stageId?: string });

    this.addLeadActivity({
      leadId: created.id,
      type: "system",
      description: `Imported from ${payload.source ?? "external source"}`,
    });
    return created;
  }

  upsertBusinessRaw(data: Partial<Business> & { id: string; name: string }): Business {
    const now = this.now();
    const existing = this.getBusiness(data.id);
    if (existing) {
      this.db
        .prepare(`
        UPDATE businesses SET name = ?, description = ?, industry = ?, website = ?, logo = ?, email = ?, phone = ?, address = ?, timezone = ?, currency = ?, owner_id = ?, updated_at = ?
        WHERE id = ?
      `)
        .run(
          data.name,
          data.description ?? existing.description ?? null,
          data.industry ?? existing.industry ?? null,
          data.website ?? existing.website ?? null,
          data.logo ?? existing.logo ?? null,
          data.email ?? existing.email ?? null,
          data.phone ?? existing.phone ?? null,
          data.address ?? existing.address ?? null,
          data.timezone ?? existing.timezone ?? "UTC",
          data.currency ?? existing.currency ?? "USD",
          data.ownerId ?? existing.ownerId ?? null,
          now,
          data.id,
        );
    } else {
      this.db
        .prepare(`
        INSERT INTO businesses (id, name, description, industry, website, logo, email, phone, address, timezone, currency, owner_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          data.id,
          data.name,
          data.description ?? null,
          data.industry ?? null,
          data.website ?? null,
          data.logo ?? null,
          data.email ?? null,
          data.phone ?? null,
          data.address ?? null,
          data.timezone ?? "UTC",
          data.currency ?? "USD",
          data.ownerId ?? null,
          now,
          now,
        );
    }
    return this.getBusiness(data.id)!;
  }

  getBusiness(id: string): Business | null {
    const row = this.db.prepare("SELECT * FROM businesses WHERE id = ?").get(id) as any;
    return row ? this.rowToBusiness(row) : null;
  }

  listBusinesses(options?: {
    ownerId?: string;
    includeArchived?: boolean;
    limit?: number;
  }): Business[] {
    let sql = options?.includeArchived
      ? "SELECT * FROM businesses"
      : "SELECT * FROM businesses WHERE archived_at IS NULL";
    const params: any[] = [];

    if (options?.ownerId) {
      sql += sql.includes("WHERE") ? " AND" : " WHERE";
      sql += " owner_id = ?";
      params.push(options.ownerId);
    }

    sql += " ORDER BY created_at DESC";
    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToBusiness(r));
  }

  updateBusiness(id: string, updates: Partial<Business>): Business | null {
    const existing = this.getBusiness(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE businesses SET name = ?, description = ?, industry = ?, website = ?, logo = ?, email = ?, phone = ?, address = ?, timezone = ?, currency = ?, owner_id = ?, updated_at = ?, archived_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.industry ?? existing.industry,
        updates.website ?? existing.website,
        updates.logo ?? existing.logo,
        updates.email ?? existing.email,
        updates.phone ?? existing.phone,
        updates.address ?? existing.address,
        updates.timezone ?? existing.timezone,
        updates.currency ?? existing.currency,
        updates.ownerId ?? existing.ownerId,
        now,
        updates.archivedAt ?? existing.archivedAt,
        id,
      );
    return this.getBusiness(id);
  }

  archiveBusiness(id: string): boolean {
    const now = this.now();
    const result = this.db
      .prepare("UPDATE businesses SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    return result.changes > 0;
  }

  deleteBusiness(id: string): boolean {
    return this.db.prepare("DELETE FROM businesses WHERE id = ?").run(id).changes > 0;
  }

  private rowToBusiness(row: any): Business {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      industry: row.industry ?? undefined,
      website: row.website ?? undefined,
      logo: row.logo ?? undefined,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      address: row.address ?? undefined,
      timezone: row.timezone ?? "UTC",
      currency: row.currency ?? "USD",
      ownerId: row.owner_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // FUNNEL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  createFunnel(data: {
    businessId: string;
    name: string;
    description?: string;
    type: FunnelType;
    status?: FunnelStatus;
    color?: string;
    icon?: string;
    automationEnabled?: boolean;
    webhookUrl?: string;
  }): Funnel {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO funnels (id, business_id, name, description, type, status, color, icon, automation_enabled, webhook_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.name,
        data.description ?? null,
        data.type,
        data.status ?? "draft",
        data.color ?? null,
        data.icon ?? null,
        data.automationEnabled ? 1 : 0,
        data.webhookUrl ?? null,
        now,
        now,
      );

    return this.getFunnel(id)!;
  }

  getFunnel(
    id: string,
    options?: { includeStages?: boolean; includeStats?: boolean },
  ): Funnel | null {
    const row = this.db.prepare("SELECT * FROM funnels WHERE id = ?").get(id) as any;
    if (!row) return null;

    const funnel = this.rowToFunnel(row);

    if (options?.includeStats) {
      const stats = this.db
        .prepare(`
        SELECT COUNT(*) as total, 
          SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
          AVG(estimated_value) as avg_value
        FROM leads WHERE funnel_id = ? AND archived_at IS NULL
      `)
        .get(id) as any;
      funnel.totalLeads = stats.total ?? 0;
      funnel.conversionRate = stats.total > 0 ? Math.round((stats.won / stats.total) * 100) : 0;
    }

    return funnel;
  }

  listFunnels(filters?: FunnelFilters): Funnel[] {
    let sql = "SELECT * FROM funnels WHERE archived_at IS NULL";
    const params: any[] = [];

    if (filters?.businessId) {
      sql += " AND business_id = ?";
      params.push(filters.businessId);
    }
    if (filters?.type) {
      const types = Array.isArray(filters.type) ? filters.type : [filters.type];
      sql += ` AND type IN (${types.map(() => "?").join(",")})`;
      params.push(...types);
    }
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      sql += ` AND status IN (${statuses.map(() => "?").join(",")})`;
      params.push(...statuses);
    }
    if (filters?.search) {
      sql += " AND (name LIKE ? OR description LIKE ?)";
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    sql += " ORDER BY created_at DESC";
    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }
    if (filters?.offset) {
      sql += " OFFSET ?";
      params.push(filters.offset);
    }

    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToFunnel(r));
  }

  updateFunnel(id: string, updates: Partial<Funnel>): Funnel | null {
    const existing = this.getFunnel(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE funnels SET name = ?, description = ?, type = ?, status = ?, color = ?, icon = ?, automation_enabled = ?, webhook_url = ?, updated_at = ?, archived_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.type ?? existing.type,
        updates.status ?? existing.status,
        updates.color ?? existing.color,
        updates.icon ?? existing.icon,
        updates.automationEnabled !== undefined
          ? updates.automationEnabled
            ? 1
            : 0
          : existing.automationEnabled
            ? 1
            : 0,
        updates.webhookUrl ?? existing.webhookUrl,
        now,
        updates.archivedAt ?? existing.archivedAt,
        id,
      );
    return this.getFunnel(id);
  }

  duplicateFunnel(id: string, newName?: string, targetBusinessId?: string): Funnel | null {
    const source = this.getFunnel(id);
    if (!source) return null;

    const now = this.now();
    const newId = this.uuid();
    const businessId = targetBusinessId ?? source.businessId;

    this.db
      .prepare(`
      INSERT INTO funnels (id, business_id, name, description, type, status, color, icon, automation_enabled, webhook_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
    `)
      .run(
        newId,
        businessId,
        newName ?? `${source.name} (Copy)`,
        source.description ?? null,
        source.type,
        source.color ?? null,
        source.icon ?? null,
        source.automationEnabled ? 1 : 0,
        source.webhookUrl ?? null,
        now,
        now,
      );

    // Copy stages
    const stages = this.getStages(id);
    const stageMap = new Map<string, string>();
    for (const stage of stages) {
      const newStageId = this.uuid();
      stageMap.set(stage.id, newStageId);
      this.db
        .prepare(`
        INSERT INTO stages (id, funnel_id, name, description, type, position, color, icon, auto_move_after_days, max_days_allowed, qualification_rules, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          newStageId,
          newId,
          stage.name,
          stage.description ?? null,
          stage.type,
          stage.position,
          stage.color ?? null,
          stage.icon ?? null,
          stage.autoMoveAfterDays ?? null,
          stage.maxDaysAllowed ?? null,
          JSON.stringify(stage.qualificationRules ?? []),
          now,
          now,
        );
    }

    // Copy connections
    const connections = this.getConnections(id);
    for (const conn of connections) {
      const newSource = stageMap.get(conn.sourceStageId);
      const newTarget = stageMap.get(conn.targetStageId);
      if (newSource && newTarget) {
        this.db
          .prepare(`
          INSERT INTO stage_connections (id, funnel_id, source_stage_id, target_stage_id, label, condition_type, condition_config, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            this.uuid(),
            newId,
            newSource,
            newTarget,
            conn.label ?? null,
            conn.conditionType ?? "manual",
            conn.conditionConfig ? JSON.stringify(conn.conditionConfig) : null,
            now,
          );
      }
    }

    return this.getFunnel(newId);
  }

  deleteFunnel(id: string): boolean {
    return this.db.prepare("DELETE FROM funnels WHERE id = ?").run(id).changes > 0;
  }

  private rowToFunnel(row: any): Funnel {
    return {
      id: row.id,
      businessId: row.business_id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type as FunnelType,
      status: row.status as FunnelStatus,
      color: row.color ?? undefined,
      icon: row.icon ?? undefined,
      automationEnabled: row.automation_enabled === 1,
      webhookUrl: row.webhook_url ?? undefined,
      totalLeads: row.total_leads ?? 0,
      conversionRate: row.conversion_rate ?? undefined,
      averageDaysInFunnel: row.avg_days_in_funnel ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // STAGE OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  addStage(data: {
    funnelId: string;
    name: string;
    description?: string;
    type: StageType;
    position?: number;
    color?: string;
    icon?: string;
    autoMoveAfterDays?: number;
    maxDaysAllowed?: number;
    // ── Slice C: canvas visual fields ──────────────────────────
    libraryId?: string;
    emoji?: string;
    row?: number;
    column?: number;
    items?: Stage["items"];
    integration?: Stage["integration"];
    pageLink?: Stage["pageLink"];
    kpiTracking?: Stage["kpiTracking"];
  }): Stage {
    const now = this.now();
    const id = this.uuid();

    let position = data.position;
    if (position === undefined) {
      const max = this.db
        .prepare("SELECT MAX(position) as m FROM stages WHERE funnel_id = ?")
        .get(data.funnelId) as { m: number | null };
      position = (max.m ?? -1) + 1;
    }

    this.db
      .prepare(`
      INSERT INTO stages (
        id, funnel_id, name, description, type, position, color, icon,
        auto_move_after_days, max_days_allowed, qualification_rules,
        library_id, emoji, canvas_row, canvas_column,
        items_json, integration_json, page_link_json, kpi_tracking_json,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.funnelId,
        data.name,
        data.description ?? null,
        data.type,
        position,
        data.color ?? null,
        data.icon ?? null,
        data.autoMoveAfterDays ?? null,
        data.maxDaysAllowed ?? null,
        data.libraryId ?? null,
        data.emoji ?? null,
        data.row ?? null,
        data.column ?? null,
        data.items ? JSON.stringify(data.items) : null,
        data.integration ? JSON.stringify(data.integration) : null,
        data.pageLink ? JSON.stringify(data.pageLink) : null,
        data.kpiTracking ? JSON.stringify(data.kpiTracking) : null,
        now,
        now,
      );

    return this.getStage(id)!;
  }

  getStage(id: string): Stage | null {
    const row = this.db.prepare("SELECT * FROM stages WHERE id = ?").get(id) as any;
    return row ? this.rowToStage(row) : null;
  }

  getStages(funnelId: string): Stage[] {
    return (
      this.db
        .prepare("SELECT * FROM stages WHERE funnel_id = ? ORDER BY position ASC")
        .all(funnelId) as any[]
    ).map((r) => this.rowToStage(r));
  }

  updateStage(id: string, updates: Partial<Stage>): Stage | null {
    const existing = this.getStage(id);
    if (!existing) return null;

    const now = this.now();
    const stringifyJSON = <T>(v: T | undefined): string | null =>
      v !== undefined ? JSON.stringify(v) : null;
    this.db
      .prepare(`
      UPDATE stages SET
        name = ?, description = ?, type = ?, position = ?, color = ?, icon = ?,
        auto_move_after_days = ?, max_days_allowed = ?, qualification_rules = ?,
        library_id = ?, emoji = ?, canvas_row = ?, canvas_column = ?,
        items_json = ?, integration_json = ?, page_link_json = ?, kpi_tracking_json = ?,
        updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.type ?? existing.type,
        updates.position ?? existing.position,
        updates.color ?? existing.color,
        updates.icon ?? existing.icon,
        updates.autoMoveAfterDays ?? existing.autoMoveAfterDays,
        updates.maxDaysAllowed ?? existing.maxDaysAllowed,
        JSON.stringify(updates.qualificationRules ?? existing.qualificationRules ?? []),
        updates.libraryId ?? existing.libraryId ?? null,
        updates.emoji ?? existing.emoji ?? null,
        updates.row ?? existing.row ?? null,
        updates.column ?? existing.column ?? null,
        stringifyJSON(updates.items ?? existing.items),
        stringifyJSON(updates.integration ?? existing.integration),
        stringifyJSON(updates.pageLink ?? existing.pageLink),
        stringifyJSON(updates.kpiTracking ?? existing.kpiTracking),
        now,
        id,
      );
    return this.getStage(id);
  }

  deleteStage(id: string, moveLeadsTo?: string): boolean {
    if (moveLeadsTo) {
      this.db.prepare("UPDATE leads SET stage_id = ? WHERE stage_id = ?").run(moveLeadsTo, id);
    }
    return this.db.prepare("DELETE FROM stages WHERE id = ?").run(id).changes > 0;
  }

  reorderStages(funnelId: string, stageOrder: string[]): boolean {
    const now = this.now();
    const stmt = this.db.prepare(
      "UPDATE stages SET position = ?, updated_at = ? WHERE id = ? AND funnel_id = ?",
    );
    for (let i = 0; i < stageOrder.length; i++) {
      stmt.run(i, now, stageOrder[i], funnelId);
    }
    return true;
  }

  getStageKPIs(
    stageId: string,
    period?: MetricPeriod,
  ): { leadCount: number; avgTimeInStage: number; conversionRate: number; value: number } {
    const leadCount = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM leads WHERE stage_id = ? AND archived_at IS NULL")
        .get(stageId) as any
    ).c;
    const valueRow = this.db
      .prepare(
        "SELECT COALESCE(SUM(estimated_value), 0) as v FROM leads WHERE stage_id = ? AND archived_at IS NULL",
      )
      .get(stageId) as any;
    const avgTime = (
      this.db
        .prepare(
          "SELECT AVG(time_in_previous_stage) as a FROM lead_stage_history WHERE from_stage_id = ? AND time_in_previous_stage IS NOT NULL",
        )
        .get(stageId) as any
    ).a;
    const entered = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM lead_stage_history WHERE to_stage_id = ?")
        .get(stageId) as any
    ).c;
    const exited = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM lead_stage_history WHERE from_stage_id = ?")
        .get(stageId) as any
    ).c;

    return {
      leadCount,
      avgTimeInStage: avgTime ? Math.round(avgTime / 3600) : 0,
      conversionRate: entered > 0 ? Math.round((exited / entered) * 100) : 0,
      value: valueRow.v,
    };
  }

  private rowToStage(row: any): Stage {
    const parseJSON = <T>(s: unknown): T | undefined => {
      if (typeof s !== "string" || !s.trim()) return undefined;
      try {
        return JSON.parse(s) as T;
      } catch {
        return undefined;
      }
    };
    return {
      id: row.id,
      funnelId: row.funnel_id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type as StageType,
      position: row.position,
      color: row.color ?? undefined,
      icon: row.icon ?? undefined,
      autoMoveAfterDays: row.auto_move_after_days ?? undefined,
      maxDaysAllowed: row.max_days_allowed ?? undefined,
      qualificationRules: JSON.parse(row.qualification_rules || "[]"),
      leadCount: row.lead_count ?? 0,
      avgTimeInStage: row.avg_time_in_stage ?? undefined,
      // ── Slice C canvas visual fields ────────────────────────────
      libraryId: row.library_id ?? undefined,
      emoji: row.emoji ?? undefined,
      row: typeof row.canvas_row === "number" ? row.canvas_row : undefined,
      column: typeof row.canvas_column === "number" ? row.canvas_column : undefined,
      items: parseJSON<Stage["items"]>(row.items_json),
      integration: parseJSON<Stage["integration"]>(row.integration_json),
      pageLink: parseJSON<Stage["pageLink"]>(row.page_link_json),
      kpiTracking: parseJSON<Stage["kpiTracking"]>(row.kpi_tracking_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // STAGE CONNECTIONS
  // ═══════════════════════════════════════════════════════════════

  connectStages(data: {
    funnelId: string;
    sourceStageId: string;
    targetStageId: string;
    label?: string;
    conditionType?: "manual" | "auto" | "rule";
    conditionConfig?: Record<string, unknown>;
  }): StageConnection {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO stage_connections (id, funnel_id, source_stage_id, target_stage_id, label, condition_type, condition_config, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.funnelId,
        data.sourceStageId,
        data.targetStageId,
        data.label ?? null,
        data.conditionType ?? "manual",
        data.conditionConfig ? JSON.stringify(data.conditionConfig) : null,
        now,
      );

    return this.getConnection(id)!;
  }

  getConnection(id: string): StageConnection | null {
    const row = this.db.prepare("SELECT * FROM stage_connections WHERE id = ?").get(id) as any;
    return row ? this.rowToConnection(row) : null;
  }

  getConnections(funnelId: string): StageConnection[] {
    return (
      this.db.prepare("SELECT * FROM stage_connections WHERE funnel_id = ?").all(funnelId) as any[]
    ).map((r) => this.rowToConnection(r));
  }

  deleteConnection(id: string): boolean {
    return this.db.prepare("DELETE FROM stage_connections WHERE id = ?").run(id).changes > 0;
  }

  private rowToConnection(row: any): StageConnection {
    return {
      id: row.id,
      funnelId: row.funnel_id,
      sourceStageId: row.source_stage_id,
      targetStageId: row.target_stage_id,
      label: row.label ?? undefined,
      conditionType: row.condition_type ?? "manual",
      conditionConfig: row.condition_config ? JSON.parse(row.condition_config) : undefined,
      transitionCount: row.transition_count ?? 0,
      avgTransitionTime: row.avg_transition_time ?? undefined,
      createdAt: row.created_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // LEAD OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  createLead(data: Omit<Lead, "id" | "createdAt" | "updatedAt"> & { stageId?: string }): Lead {
    const now = this.now();
    const id = this.uuid();

    // Get first stage if not specified
    let finalStageId = data.stageId;
    if (!finalStageId) {
      const firstStage = this.db
        .prepare(
          "SELECT id FROM stages WHERE funnel_id = ? AND type = 'entry' ORDER BY position ASC LIMIT 1",
        )
        .get(data.funnelId) as { id: string } | undefined;
      if (firstStage) {
        finalStageId = firstStage.id;
      } else {
        const anyStage = this.db
          .prepare("SELECT id FROM stages WHERE funnel_id = ? ORDER BY position ASC LIMIT 1")
          .get(data.funnelId) as { id: string } | undefined;
        if (anyStage) {
          finalStageId = anyStage.id;
        }
      }
    }

    if (!finalStageId) throw new Error("No stage available for lead");

    this.db
      .prepare(`
      INSERT INTO leads (id, business_id, funnel_id, stage_id, name, email, phone, company, title, source, status, priority, score, estimated_value, currency, assigned_to, tags, custom_fields, first_contact_at, last_contact_at, last_activity_at, expected_close_date, campaign_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.funnelId,
        finalStageId,
        data.name,
        data.email ?? null,
        data.phone ?? null,
        data.company ?? null,
        data.title ?? null,
        data.source ?? "manual",
        data.status ?? "new",
        data.priority ?? "medium",
        data.score ?? null,
        data.estimatedValue ?? null,
        data.currency ?? "USD",
        data.assignedTo ?? null,
        JSON.stringify(data.tags ?? []),
        JSON.stringify(data.customFields ?? {}),
        data.firstContactAt ?? null,
        data.lastContactAt ?? null,
        now,
        data.expectedCloseDate ?? null,
        data.campaignId ?? null,
        now,
        now,
      );

    // Update counts
    this.db.prepare("UPDATE stages SET lead_count = lead_count + 1 WHERE id = ?").run(finalStageId);
    this.db
      .prepare("UPDATE funnels SET total_leads = total_leads + 1 WHERE id = ?")
      .run(data.funnelId);

    // Add initial stage history
    this.db
      .prepare(`
      INSERT INTO lead_stage_history (id, lead_id, to_stage_id, reason, created_at)
      VALUES (?, ?, ?, 'Lead created', ?)
    `)
      .run(this.uuid(), id, finalStageId, now);

    const created = this.getLead(id)!;
    this.emitLeadEvent({ kind: "lead_created", lead: created });
    return created;
  }

  getLead(
    id: string,
    options?: { includeActivities?: boolean; includeStageHistory?: boolean },
  ): (Lead & { activities?: LeadActivity[]; stageHistory?: LeadStageHistory[] }) | null {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;
    if (!row) return null;

    const lead: Lead & { activities?: LeadActivity[]; stageHistory?: LeadStageHistory[] } =
      this.rowToLead(row);

    if (options?.includeActivities) {
      lead.activities = this.getLeadActivities(id);
    }
    if (options?.includeStageHistory) {
      lead.stageHistory = this.getLeadStageHistory(id);
    }

    return lead;
  }

  listLeads(filters?: LeadFilters): Lead[] {
    let sql = "SELECT * FROM leads WHERE archived_at IS NULL";
    const params: any[] = [];

    if (filters?.businessId) {
      sql += " AND business_id = ?";
      params.push(filters.businessId);
    }
    if (filters?.funnelId) {
      sql += " AND funnel_id = ?";
      params.push(filters.funnelId);
    }
    if (filters?.stageId) {
      sql += " AND stage_id = ?";
      params.push(filters.stageId);
    }
    if (filters?.campaignId) {
      sql += " AND campaign_id = ?";
      params.push(filters.campaignId);
    }
    if (filters?.status) {
      const s = Array.isArray(filters.status) ? filters.status : [filters.status];
      sql += ` AND status IN (${s.map(() => "?").join(",")})`;
      params.push(...s);
    }
    if (filters?.priority) {
      const p = Array.isArray(filters.priority) ? filters.priority : [filters.priority];
      sql += ` AND priority IN (${p.map(() => "?").join(",")})`;
      params.push(...p);
    }
    if (filters?.assignedTo) {
      sql += " AND assigned_to = ?";
      params.push(filters.assignedTo);
    }
    if (filters?.minScore !== undefined) {
      sql += " AND score >= ?";
      params.push(filters.minScore);
    }
    if (filters?.maxScore !== undefined) {
      sql += " AND score <= ?";
      params.push(filters.maxScore);
    }
    if (filters?.search) {
      sql += " AND (name LIKE ? OR email LIKE ? OR company LIKE ?)";
      params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }
    if (filters?.createdAfter) {
      sql += " AND created_at >= ?";
      params.push(filters.createdAfter);
    }
    if (filters?.createdBefore) {
      sql += " AND created_at <= ?";
      params.push(filters.createdBefore);
    }

    sql += ` ORDER BY ${filters?.orderBy ?? "created_at"} ${(filters?.orderDir ?? "desc").toUpperCase()}`;
    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }
    if (filters?.offset) {
      sql += " OFFSET ?";
      params.push(filters.offset);
    }

    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToLead(r));
  }

  searchLeads(query: string, filters?: LeadFilters): Lead[] {
    return this.listLeads({ ...filters, search: query });
  }

  updateLead(id: string, updates: Partial<Lead>): Lead | null {
    const existing = this.getLead(id);
    if (!existing) return null;

    const now = this.now();

    // Handle stage change
    if (updates.stageId && updates.stageId !== existing.stageId) {
      this.moveLead(id, updates.stageId);
      delete updates.stageId; // Already handled
    }

    this.db
      .prepare(`
      UPDATE leads SET name = ?, email = ?, phone = ?, company = ?, title = ?, source = ?, status = ?, priority = ?, score = ?, estimated_value = ?, currency = ?, assigned_to = ?, tags = ?, custom_fields = ?, first_contact_at = ?, last_contact_at = ?, last_activity_at = ?, expected_close_date = ?, actual_value = ?, lost_reason = ?, won_at = ?, lost_at = ?, updated_at = ?, archived_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.email ?? existing.email,
        updates.phone ?? existing.phone,
        updates.company ?? existing.company,
        updates.title ?? existing.title,
        updates.source ?? existing.source,
        updates.status ?? existing.status,
        updates.priority ?? existing.priority,
        updates.score ?? existing.score,
        updates.estimatedValue ?? existing.estimatedValue,
        updates.currency ?? existing.currency,
        updates.assignedTo ?? existing.assignedTo,
        JSON.stringify(updates.tags ?? existing.tags ?? []),
        JSON.stringify(updates.customFields ?? existing.customFields ?? {}),
        updates.firstContactAt ?? existing.firstContactAt,
        updates.lastContactAt ?? existing.lastContactAt,
        now,
        updates.expectedCloseDate ?? existing.expectedCloseDate,
        updates.actualValue ?? existing.actualValue,
        updates.lostReason ?? existing.lostReason,
        updates.wonAt ?? existing.wonAt,
        updates.lostAt ?? existing.lostAt,
        now,
        updates.archivedAt ?? existing.archivedAt,
        id,
      );

    const after = this.getLead(id);
    if (after) {
      const changed: Array<keyof Lead> = [];
      for (const k of Object.keys(updates) as Array<keyof Lead>) {
        if (
          (existing as unknown as Record<string, unknown>)[k as string] !==
          (after as unknown as Record<string, unknown>)[k as string]
        ) {
          changed.push(k);
        }
      }
      this.emitLeadEvent({ kind: "lead_updated", lead: after, before: existing, changed });
      if (
        (existing.score ?? undefined) !== (after.score ?? undefined) &&
        updates.score !== undefined
      ) {
        this.emitLeadEvent({
          kind: "score_changed",
          lead: after,
          oldScore: existing.score,
          newScore: after.score,
        });
      }
      const prevTags = new Set(existing.tags ?? []);
      const nextTags = new Set(after.tags ?? []);
      for (const t of nextTags) {
        if (!prevTags.has(t)) this.emitLeadEvent({ kind: "tag_added", lead: after, tag: t });
      }
      for (const t of prevTags) {
        if (!nextTags.has(t)) this.emitLeadEvent({ kind: "tag_removed", lead: after, tag: t });
      }
    }
    return after;
  }

  moveLead(
    leadId: string,
    targetStageId: string,
    reason?: string,
    performedBy?: string,
  ): Lead | null {
    const lead = this.getLead(leadId);
    if (!lead) return null;

    const now = this.now();
    const oldStageId = lead.stageId;

    // Calculate time in previous stage
    const lastMove = this.db
      .prepare(
        "SELECT created_at FROM lead_stage_history WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(leadId) as { created_at: string } | undefined;
    const timeInPrev = lastMove
      ? Math.round((Date.now() - new Date(lastMove.created_at).getTime()) / 1000)
      : undefined;

    // Update lead
    this.db
      .prepare("UPDATE leads SET stage_id = ?, last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run(targetStageId, now, now, leadId);

    // Update counts
    this.db.prepare("UPDATE stages SET lead_count = lead_count - 1 WHERE id = ?").run(oldStageId);
    this.db
      .prepare("UPDATE stages SET lead_count = lead_count + 1 WHERE id = ?")
      .run(targetStageId);

    // Record history
    this.db
      .prepare(`
      INSERT INTO lead_stage_history (id, lead_id, from_stage_id, to_stage_id, reason, performed_by, time_in_previous_stage, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        this.uuid(),
        leadId,
        oldStageId,
        targetStageId,
        reason ?? null,
        performedBy ?? null,
        timeInPrev ?? null,
        now,
      );

    // Add activity
    this.addLeadActivity({
      leadId,
      type: "stage_change",
      description: `Moved to new stage${reason ? `: ${reason}` : ""}`,
      metadata: { from: oldStageId, to: targetStageId },
      performedBy,
    });

    const moved = this.getLead(leadId);
    if (moved) {
      this.emitLeadEvent({
        kind: "stage_changed",
        lead: moved,
        fromStageId: oldStageId,
        toStageId: targetStageId,
        reason,
      });
    }
    return moved;
  }

  scoreLead(id: string, delta: number): Lead | null {
    const lead = this.getLead(id);
    if (!lead) return null;

    const newScore = Math.max(0, Math.min(100, (lead.score ?? 0) + delta));
    const now = this.now();

    this.db
      .prepare("UPDATE leads SET score = ?, updated_at = ? WHERE id = ?")
      .run(newScore, now, id);
    this.addLeadActivity({
      leadId: id,
      type: "score_change",
      description: `Score ${delta > 0 ? "+" : ""}${delta} → ${newScore}`,
      metadata: { delta, oldScore: lead.score, newScore },
    });

    const after = this.getLead(id);
    if (after) {
      this.emitLeadEvent({
        kind: "score_changed",
        lead: after,
        oldScore: lead.score,
        newScore,
      });
    }
    return after;
  }

  qualifyLead(id: string, qualified: boolean, reason?: string): Lead | null {
    const lead = this.getLead(id);
    if (!lead) return null;

    const now = this.now();
    const newStatus = qualified ? "qualified" : "disqualified";

    this.db
      .prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?")
      .run(newStatus, now, id);
    this.addLeadActivity({
      leadId: id,
      type: "system",
      description: `Lead ${qualified ? "qualified" : "disqualified"}${reason ? `: ${reason}` : ""}`,
      metadata: { qualified, reason },
    });

    return this.getLead(id);
  }

  convertLead(id: string, actualValue?: number): Lead | null {
    const lead = this.getLead(id);
    if (!lead) return null;

    const now = this.now();
    this.db
      .prepare(
        "UPDATE leads SET status = ?, won_at = ?, actual_value = ?, updated_at = ? WHERE id = ?",
      )
      .run("won", now, actualValue ?? lead.estimatedValue ?? null, now, id);
    this.addLeadActivity({
      leadId: id,
      type: "system",
      description: `Lead converted (won)`,
      metadata: { actualValue },
    });

    return this.getLead(id);
  }

  loseLead(id: string, reason?: string): Lead | null {
    const lead = this.getLead(id);
    if (!lead) return null;

    const now = this.now();
    this.db
      .prepare(
        "UPDATE leads SET status = ?, lost_at = ?, lost_reason = ?, updated_at = ? WHERE id = ?",
      )
      .run("lost", now, reason ?? null, now, id);
    this.addLeadActivity({
      leadId: id,
      type: "system",
      description: `Lead lost${reason ? `: ${reason}` : ""}`,
      metadata: { reason },
    });

    return this.getLead(id);
  }

  deleteLead(id: string): boolean {
    const lead = this.getLead(id);
    if (lead) {
      this.db
        .prepare("UPDATE stages SET lead_count = lead_count - 1 WHERE id = ?")
        .run(lead.stageId);
      this.db
        .prepare("UPDATE funnels SET total_leads = total_leads - 1 WHERE id = ?")
        .run(lead.funnelId);
    }
    return this.db.prepare("DELETE FROM leads WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Stamp (or clear) the campaign id on an existing lead. Used by the
   * campaigns.assignLead RPC and by intake paths that learn the campaign
   * after the lead row has been inserted.
   */
  setLeadCampaign(leadId: string, campaignId: string | null): Lead | null {
    const existing = this.getLead(leadId);
    if (!existing) return null;
    const now = this.now();
    this.db
      .prepare("UPDATE leads SET campaign_id = ?, updated_at = ? WHERE id = ?")
      .run(campaignId, now, leadId);
    return this.getLead(leadId);
  }

  private rowToLead(row: any): Lead {
    return {
      id: row.id,
      businessId: row.business_id,
      funnelId: row.funnel_id,
      stageId: row.stage_id,
      name: row.name,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      company: row.company ?? undefined,
      title: row.title ?? undefined,
      source: row.source,
      status: row.status,
      priority: row.priority,
      score: row.score ?? undefined,
      campaignId: row.campaign_id ?? undefined,
      estimatedValue: row.estimated_value ?? undefined,
      currency: row.currency ?? "USD",
      assignedTo: row.assigned_to ?? undefined,
      tags: JSON.parse(row.tags || "[]"),
      customFields: JSON.parse(row.custom_fields || "{}"),
      firstContactAt: row.first_contact_at ?? undefined,
      lastContactAt: row.last_contact_at ?? undefined,
      lastActivityAt: row.last_activity_at ?? undefined,
      expectedCloseDate: row.expected_close_date ?? undefined,
      actualValue: row.actual_value ?? undefined,
      lostReason: row.lost_reason ?? undefined,
      wonAt: row.won_at ?? undefined,
      lostAt: row.lost_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // LEAD ACTIVITIES & HISTORY
  // ═══════════════════════════════════════════════════════════════

  addLeadActivity(data: Omit<LeadActivity, "id" | "createdAt">): LeadActivity {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO lead_activities (id, lead_id, type, description, metadata, performed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.leadId,
        data.type,
        data.description,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.performedBy ?? null,
        now,
      );

    this.db.prepare("UPDATE leads SET last_activity_at = ? WHERE id = ?").run(now, data.leadId);

    return { id, ...data, createdAt: now };
  }

  getLeadActivities(leadId: string, limit?: number): LeadActivity[] {
    let sql = "SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC";
    if (limit) sql += ` LIMIT ${limit}`;

    return (this.db.prepare(sql).all(leadId) as any[]).map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      type: r.type,
      description: r.description,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      performedBy: r.performed_by ?? undefined,
      createdAt: r.created_at,
    }));
  }

  getLeadStageHistory(leadId: string): LeadStageHistory[] {
    return (
      this.db
        .prepare("SELECT * FROM lead_stage_history WHERE lead_id = ? ORDER BY created_at ASC")
        .all(leadId) as any[]
    ).map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      fromStageId: r.from_stage_id ?? undefined,
      toStageId: r.to_stage_id,
      reason: r.reason ?? undefined,
      performedBy: r.performed_by ?? undefined,
      timeInPreviousStage: r.time_in_previous_stage ?? undefined,
      createdAt: r.created_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // OFFERS
  // ═══════════════════════════════════════════════════════════════

  createOffer(data: Omit<Offer, "id" | "createdAt" | "updatedAt">): Offer {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO offers (id, business_id, name, description, type, status, price, currency, discount_percent, discount_amount, valid_from, valid_until, max_redemptions, target_stages, target_tags, min_score, hero_image, features, terms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.name,
        data.description ?? null,
        data.type,
        data.status,
        data.price,
        data.currency,
        data.discountPercent ?? null,
        data.discountAmount ?? null,
        data.validFrom ?? null,
        data.validUntil ?? null,
        data.maxRedemptions ?? null,
        JSON.stringify(data.targetStages ?? []),
        JSON.stringify(data.targetTags ?? []),
        data.minScore ?? null,
        data.heroImage ?? null,
        JSON.stringify(data.features ?? []),
        data.terms ?? null,
        now,
        now,
      );

    return this.getOffer(id)!;
  }

  getOffer(id: string): Offer | null {
    const row = this.db.prepare("SELECT * FROM offers WHERE id = ?").get(id) as any;
    return row ? this.rowToOffer(row) : null;
  }

  listOffers(businessId: string, status?: string): Offer[] {
    let sql = "SELECT * FROM offers WHERE business_id = ?";
    const params: any[] = [businessId];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToOffer(r));
  }

  updateOffer(id: string, updates: Partial<Offer>): Offer | null {
    const existing = this.getOffer(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE offers SET name = ?, description = ?, type = ?, status = ?, price = ?, currency = ?, discount_percent = ?, discount_amount = ?, valid_from = ?, valid_until = ?, max_redemptions = ?, target_stages = ?, target_tags = ?, min_score = ?, hero_image = ?, features = ?, terms = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.type ?? existing.type,
        updates.status ?? existing.status,
        updates.price ?? existing.price,
        updates.currency ?? existing.currency,
        updates.discountPercent ?? existing.discountPercent,
        updates.discountAmount ?? existing.discountAmount,
        updates.validFrom ?? existing.validFrom,
        updates.validUntil ?? existing.validUntil,
        updates.maxRedemptions ?? existing.maxRedemptions,
        JSON.stringify(updates.targetStages ?? existing.targetStages ?? []),
        JSON.stringify(updates.targetTags ?? existing.targetTags ?? []),
        updates.minScore ?? existing.minScore,
        updates.heroImage ?? existing.heroImage,
        JSON.stringify(updates.features ?? existing.features ?? []),
        updates.terms ?? existing.terms,
        now,
        id,
      );
    return this.getOffer(id);
  }

  deleteOffer(id: string): boolean {
    return this.db.prepare("DELETE FROM offers WHERE id = ?").run(id).changes > 0;
  }

  private rowToOffer(row: any): Offer {
    return {
      id: row.id,
      businessId: row.business_id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type,
      status: row.status,
      price: row.price,
      currency: row.currency,
      discountPercent: row.discount_percent ?? undefined,
      discountAmount: row.discount_amount ?? undefined,
      validFrom: row.valid_from ?? undefined,
      validUntil: row.valid_until ?? undefined,
      maxRedemptions: row.max_redemptions ?? undefined,
      currentRedemptions: row.current_redemptions ?? 0,
      targetStages: JSON.parse(row.target_stages || "[]"),
      targetTags: JSON.parse(row.target_tags || "[]"),
      minScore: row.min_score ?? undefined,
      heroImage: row.hero_image ?? undefined,
      features: JSON.parse(row.features || "[]"),
      terms: row.terms ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // TASKS
  // ═══════════════════════════════════════════════════════════════

  createTask(data: Omit<FunnelTask, "id" | "createdAt" | "updatedAt">): FunnelTask {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO funnel_tasks (id, business_id, funnel_id, lead_id, stage_id, title, description, type, status, priority, assigned_to, created_by, due_at, reminder_at, auto_generated, rule_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.funnelId ?? null,
        data.leadId ?? null,
        data.stageId ?? null,
        data.title,
        data.description ?? null,
        data.type,
        data.status,
        data.priority,
        data.assignedTo ?? null,
        data.createdBy ?? null,
        data.dueAt ?? null,
        data.reminderAt ?? null,
        data.autoGenerated ? 1 : 0,
        data.ruleId ?? null,
        now,
        now,
      );

    return this.getTask(id)!;
  }

  getTask(id: string): FunnelTask | null {
    const row = this.db.prepare("SELECT * FROM funnel_tasks WHERE id = ?").get(id) as any;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(filters?: TaskFilters): FunnelTask[] {
    let sql = "SELECT * FROM funnel_tasks WHERE 1=1";
    const params: any[] = [];

    if (filters?.businessId) {
      sql += " AND business_id = ?";
      params.push(filters.businessId);
    }
    if (filters?.funnelId) {
      sql += " AND funnel_id = ?";
      params.push(filters.funnelId);
    }
    if (filters?.leadId) {
      sql += " AND lead_id = ?";
      params.push(filters.leadId);
    }
    if (filters?.assignedTo) {
      sql += " AND assigned_to = ?";
      params.push(filters.assignedTo);
    }
    if (filters?.status) {
      const s = Array.isArray(filters.status) ? filters.status : [filters.status];
      sql += ` AND status IN (${s.map(() => "?").join(",")})`;
      params.push(...s);
    }
    if (filters?.overdue) {
      sql += " AND due_at < ? AND status NOT IN ('completed', 'cancelled')";
      params.push(this.now());
    }

    sql += " ORDER BY due_at ASC NULLS LAST, created_at DESC";
    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }
    if (filters?.offset) {
      sql += " OFFSET ?";
      params.push(filters.offset);
    }

    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToTask(r));
  }

  updateTask(id: string, updates: Partial<FunnelTask>): FunnelTask | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE funnel_tasks SET title = ?, description = ?, type = ?, status = ?, priority = ?, assigned_to = ?, due_at = ?, reminder_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.title ?? existing.title,
        updates.description ?? existing.description,
        updates.type ?? existing.type,
        updates.status ?? existing.status,
        updates.priority ?? existing.priority,
        updates.assignedTo ?? existing.assignedTo,
        updates.dueAt ?? existing.dueAt,
        updates.reminderAt ?? existing.reminderAt,
        updates.completedAt ?? existing.completedAt,
        now,
        id,
      );
    return this.getTask(id);
  }

  completeTask(id: string): FunnelTask | null {
    return this.updateTask(id, { status: "completed", completedAt: this.now() });
  }

  deleteTask(id: string): boolean {
    return this.db.prepare("DELETE FROM funnel_tasks WHERE id = ?").run(id).changes > 0;
  }

  private rowToTask(row: any): FunnelTask {
    return {
      id: row.id,
      businessId: row.business_id,
      funnelId: row.funnel_id ?? undefined,
      leadId: row.lead_id ?? undefined,
      stageId: row.stage_id ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      type: row.type,
      status: row.status,
      priority: row.priority,
      assignedTo: row.assigned_to ?? undefined,
      createdBy: row.created_by ?? undefined,
      dueAt: row.due_at ?? undefined,
      reminderAt: row.reminder_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      autoGenerated: row.auto_generated === 1,
      ruleId: row.rule_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════

  createConversation(data: Omit<Conversation, "id" | "createdAt" | "updatedAt">): Conversation {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO conversations (id, business_id, lead_id, channel, status, subject, external_id, external_url, participant_ids, assigned_to, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.leadId,
        data.channel,
        data.status,
        data.subject ?? null,
        data.externalId ?? null,
        data.externalUrl ?? null,
        JSON.stringify(data.participantIds ?? []),
        data.assignedTo ?? null,
        data.startedAt,
        now,
        now,
      );

    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return row ? this.rowToConversation(row) : null;
  }

  listConversations(leadId: string, status?: string): Conversation[] {
    let sql = "SELECT * FROM conversations WHERE lead_id = ?";
    const params: any[] = [leadId];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToConversation(r));
  }

  updateConversation(id: string, updates: Partial<Conversation>): Conversation | null {
    const existing = this.getConversation(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE conversations SET status = ?, subject = ?, assigned_to = ?, message_count = ?, last_message_at = ?, last_message_by = ?, sentiment = ?, sentiment_score = ?, closed_at = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.status ?? existing.status,
        updates.subject ?? existing.subject,
        updates.assignedTo ?? existing.assignedTo,
        updates.messageCount ?? existing.messageCount,
        updates.lastMessageAt ?? existing.lastMessageAt,
        updates.lastMessageBy ?? existing.lastMessageBy,
        updates.sentiment ?? existing.sentiment,
        updates.sentimentScore ?? existing.sentimentScore,
        updates.closedAt ?? existing.closedAt,
        now,
        id,
      );
    return this.getConversation(id);
  }

  private rowToConversation(row: any): Conversation {
    return {
      id: row.id,
      businessId: row.business_id,
      leadId: row.lead_id,
      channel: row.channel,
      status: row.status,
      subject: row.subject ?? undefined,
      externalId: row.external_id ?? undefined,
      externalUrl: row.external_url ?? undefined,
      participantIds: JSON.parse(row.participant_ids || "[]"),
      assignedTo: row.assigned_to ?? undefined,
      messageCount: row.message_count ?? 0,
      lastMessageAt: row.last_message_at ?? undefined,
      lastMessageBy: row.last_message_by ?? undefined,
      sentiment: row.sentiment ?? undefined,
      sentimentScore: row.sentiment_score ?? undefined,
      startedAt: row.started_at,
      closedAt: row.closed_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  addMessage(data: Omit<ConversationMessage, "id" | "createdAt">): ConversationMessage {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO conversation_messages (id, conversation_id, direction, sender_type, sender_id, sender_name, content, content_type, attachments, summary, extracted_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.conversationId,
        data.direction,
        data.senderType,
        data.senderId ?? null,
        data.senderName ?? null,
        data.content,
        data.contentType ?? "text",
        JSON.stringify(data.attachments ?? []),
        data.summary ?? null,
        data.extractedData ? JSON.stringify(data.extractedData) : null,
        now,
      );

    // Update conversation
    this.db
      .prepare(
        "UPDATE conversations SET message_count = message_count + 1, last_message_at = ?, last_message_by = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, data.senderType, now, data.conversationId);

    return { id, ...data, createdAt: now };
  }

  getMessages(conversationId: string, limit?: number): ConversationMessage[] {
    let sql =
      "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC";
    if (limit) sql += ` LIMIT ${limit}`;

    return (this.db.prepare(sql).all(conversationId) as any[]).map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      direction: r.direction,
      senderType: r.sender_type,
      senderId: r.sender_id ?? undefined,
      senderName: r.sender_name ?? undefined,
      content: r.content,
      contentType: r.content_type ?? "text",
      attachments: JSON.parse(r.attachments || "[]"),
      readAt: r.read_at ?? undefined,
      deliveredAt: r.delivered_at ?? undefined,
      summary: r.summary ?? undefined,
      extractedData: r.extracted_data ? JSON.parse(r.extracted_data) : undefined,
      createdAt: r.created_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // QUALIFICATION RULES
  // ═══════════════════════════════════════════════════════════════

  createRule(data: Omit<QualificationRule, "id" | "createdAt" | "updatedAt">): QualificationRule {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO qualification_rules (id, business_id, funnel_id, stage_id, name, description, enabled, priority, trigger_on, trigger_field, conditions, actions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.funnelId ?? null,
        data.stageId ?? null,
        data.name,
        data.description ?? null,
        data.enabled ? 1 : 0,
        data.priority,
        data.triggerOn,
        data.triggerField ?? null,
        JSON.stringify(data.conditions),
        JSON.stringify(data.actions),
        now,
        now,
      );

    return this.getRule(id)!;
  }

  getRule(id: string): QualificationRule | null {
    const row = this.db.prepare("SELECT * FROM qualification_rules WHERE id = ?").get(id) as any;
    return row ? this.rowToRule(row) : null;
  }

  listRules(businessId: string, funnelId?: string, enabled?: boolean): QualificationRule[] {
    let sql = "SELECT * FROM qualification_rules WHERE business_id = ?";
    const params: any[] = [businessId];

    if (funnelId) {
      sql += " AND (funnel_id = ? OR funnel_id IS NULL)";
      params.push(funnelId);
    }
    if (enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(enabled ? 1 : 0);
    }

    sql += " ORDER BY priority ASC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToRule(r));
  }

  updateRule(id: string, updates: Partial<QualificationRule>): QualificationRule | null {
    const existing = this.getRule(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE qualification_rules SET name = ?, description = ?, enabled = ?, priority = ?, trigger_on = ?, trigger_field = ?, conditions = ?, actions = ?, trigger_count = ?, last_triggered_at = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
        updates.priority ?? existing.priority,
        updates.triggerOn ?? existing.triggerOn,
        updates.triggerField ?? existing.triggerField,
        JSON.stringify(updates.conditions ?? existing.conditions),
        JSON.stringify(updates.actions ?? existing.actions),
        updates.triggerCount ?? existing.triggerCount,
        updates.lastTriggeredAt ?? existing.lastTriggeredAt,
        now,
        id,
      );
    return this.getRule(id);
  }

  deleteRule(id: string): boolean {
    return this.db.prepare("DELETE FROM qualification_rules WHERE id = ?").run(id).changes > 0;
  }

  private rowToRule(row: any): QualificationRule {
    return {
      id: row.id,
      businessId: row.business_id,
      funnelId: row.funnel_id ?? undefined,
      stageId: row.stage_id ?? undefined,
      name: row.name,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
      priority: row.priority,
      triggerOn: row.trigger_on,
      triggerField: row.trigger_field ?? undefined,
      conditions: JSON.parse(row.conditions || "[]"),
      actions: JSON.parse(row.actions || "[]"),
      triggerCount: row.trigger_count ?? 0,
      lastTriggeredAt: row.last_triggered_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // KPI METRICS
  // ═══════════════════════════════════════════════════════════════

  createMetric(data: Omit<KPIMetric, "id" | "createdAt" | "updatedAt">): KPIMetric {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO kpi_metrics (id, business_id, funnel_id, stage_id, name, description, type, formula, source_field, aggregation, current_value, previous_value, change_percent, target_value, warning_threshold, critical_threshold, unit, precision, display_format, period, period_start, period_end, calculated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.funnelId ?? null,
        data.stageId ?? null,
        data.name,
        data.description ?? null,
        data.type,
        data.formula ?? null,
        data.sourceField ?? null,
        data.aggregation ?? null,
        data.currentValue,
        data.previousValue ?? null,
        data.changePercent ?? null,
        data.targetValue ?? null,
        data.warningThreshold ?? null,
        data.criticalThreshold ?? null,
        data.unit ?? null,
        data.precision ?? 2,
        data.displayFormat ?? null,
        data.period,
        data.periodStart ?? null,
        data.periodEnd ?? null,
        data.calculatedAt,
        now,
        now,
      );

    return this.getMetric(id)!;
  }

  getMetric(id: string): KPIMetric | null {
    const row = this.db.prepare("SELECT * FROM kpi_metrics WHERE id = ?").get(id) as any;
    return row ? this.rowToMetric(row) : null;
  }

  listMetrics(businessId: string, funnelId?: string): KPIMetric[] {
    let sql = "SELECT * FROM kpi_metrics WHERE business_id = ?";
    const params: any[] = [businessId];
    if (funnelId) {
      sql += " AND (funnel_id = ? OR funnel_id IS NULL)";
      params.push(funnelId);
    }
    sql += " ORDER BY name ASC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.rowToMetric(r));
  }

  updateMetric(id: string, updates: Partial<KPIMetric>): KPIMetric | null {
    const existing = this.getMetric(id);
    if (!existing) return null;

    const now = this.now();
    this.db
      .prepare(`
      UPDATE kpi_metrics SET name = ?, description = ?, type = ?, formula = ?, source_field = ?, aggregation = ?, current_value = ?, previous_value = ?, change_percent = ?, target_value = ?, warning_threshold = ?, critical_threshold = ?, unit = ?, precision = ?, display_format = ?, period = ?, period_start = ?, period_end = ?, calculated_at = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.type ?? existing.type,
        updates.formula ?? existing.formula,
        updates.sourceField ?? existing.sourceField,
        updates.aggregation ?? existing.aggregation,
        updates.currentValue ?? existing.currentValue,
        updates.previousValue ?? existing.previousValue,
        updates.changePercent ?? existing.changePercent,
        updates.targetValue ?? existing.targetValue,
        updates.warningThreshold ?? existing.warningThreshold,
        updates.criticalThreshold ?? existing.criticalThreshold,
        updates.unit ?? existing.unit,
        updates.precision ?? existing.precision,
        updates.displayFormat ?? existing.displayFormat,
        updates.period ?? existing.period,
        updates.periodStart ?? existing.periodStart,
        updates.periodEnd ?? existing.periodEnd,
        updates.calculatedAt ?? now,
        now,
        id,
      );
    return this.getMetric(id);
  }

  deleteMetric(id: string): boolean {
    return this.db.prepare("DELETE FROM kpi_metrics WHERE id = ?").run(id).changes > 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // ALIASES (for MCP/Gateway compatibility)
  // ═══════════════════════════════════════════════════════════════

  getBusinesses(ownerId?: string): Business[] {
    return this.listBusinesses({ ownerId });
  }
  getFunnels(filters?: FunnelFilters): Funnel[] {
    return this.listFunnels(filters);
  }
  getLeads(filters?: LeadFilters): Lead[] {
    return this.listLeads(filters);
  }
  getOffers(businessId: string, status?: string): Offer[] {
    return this.listOffers(businessId, status);
  }
  getTasks(filters?: TaskFilters): FunnelTask[] {
    return this.listTasks(filters);
  }
  getRules(businessId: string, funnelId?: string, enabled?: boolean): QualificationRule[] {
    return this.listRules(businessId, funnelId, enabled);
  }
  getConversations(leadId: string, status?: string): Conversation[] {
    return this.listConversations(leadId, status);
  }
  getMetrics(businessId: string, funnelId?: string): KPIMetric[] {
    return this.listMetrics(businessId, funnelId);
  }
  createStage(data: {
    funnelId: string;
    name: string;
    description?: string;
    type: StageType;
    position?: number;
    color?: string;
    icon?: string;
    autoMoveAfterDays?: number;
    maxDaysAllowed?: number;
  }): Stage {
    return this.addStage(data);
  }
  createConnection(data: {
    funnelId: string;
    sourceStageId: string;
    targetStageId: string;
    label?: string;
    conditionType?: "manual" | "auto" | "rule";
    conditionConfig?: Record<string, unknown>;
  }): StageConnection {
    return this.connectStages(data);
  }

  private rowToMetric(row: any): KPIMetric {
    return {
      id: row.id,
      businessId: row.business_id,
      funnelId: row.funnel_id ?? undefined,
      stageId: row.stage_id ?? undefined,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type,
      formula: row.formula ?? undefined,
      sourceField: row.source_field ?? undefined,
      aggregation: row.aggregation ?? undefined,
      currentValue: row.current_value,
      previousValue: row.previous_value ?? undefined,
      changePercent: row.change_percent ?? undefined,
      targetValue: row.target_value ?? undefined,
      warningThreshold: row.warning_threshold ?? undefined,
      criticalThreshold: row.critical_threshold ?? undefined,
      unit: row.unit ?? undefined,
      precision: row.precision ?? 2,
      displayFormat: row.display_format ?? undefined,
      period: row.period,
      periodStart: row.period_start ?? undefined,
      periodEnd: row.period_end ?? undefined,
      calculatedAt: row.calculated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  addSnapshot(data: Omit<KPISnapshot, "id" | "createdAt">): KPISnapshot {
    const now = this.now();
    const id = this.uuid();

    this.db
      .prepare(`
      INSERT INTO kpi_snapshots (id, metric_id, value, period, period_start, period_end, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.metricId,
        data.value,
        data.period,
        data.periodStart,
        data.periodEnd,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now,
      );

    return { id, ...data, createdAt: now };
  }

  getSnapshots(metricId: string, limit?: number): KPISnapshot[] {
    let sql = "SELECT * FROM kpi_snapshots WHERE metric_id = ? ORDER BY period_start DESC";
    if (limit) sql += ` LIMIT ${limit}`;

    return (this.db.prepare(sql).all(metricId) as any[]).map((r) => ({
      id: r.id,
      metricId: r.metric_id,
      value: r.value,
      period: r.period,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      createdAt: r.created_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  getFunnelAnalytics(
    funnelId: string,
    startDate?: string,
    endDate?: string,
    compareWithPrevious?: boolean,
  ): FunnelAnalytics {
    const end = endDate ?? this.now();
    const start = startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const totalLeads = (
      this.db
        .prepare(
          "SELECT COUNT(*) as c FROM leads WHERE funnel_id = ? AND created_at >= ? AND created_at <= ?",
        )
        .get(funnelId, start, end) as any
    ).c;
    const newLeads = totalLeads;
    const convertedLeads = (
      this.db
        .prepare(
          "SELECT COUNT(*) as c FROM leads WHERE funnel_id = ? AND won_at >= ? AND won_at <= ?",
        )
        .get(funnelId, start, end) as any
    ).c;
    const lostLeads = (
      this.db
        .prepare(
          "SELECT COUNT(*) as c FROM leads WHERE funnel_id = ? AND lost_at >= ? AND lost_at <= ?",
        )
        .get(funnelId, start, end) as any
    ).c;

    const valueStats = this.db
      .prepare(`
      SELECT COALESCE(SUM(estimated_value), 0) as total, COALESCE(SUM(CASE WHEN status = 'won' THEN actual_value ELSE 0 END), 0) as won,
        COALESCE(SUM(CASE WHEN status = 'lost' THEN estimated_value ELSE 0 END), 0) as lost, COALESCE(AVG(CASE WHEN status = 'won' THEN actual_value END), 0) as avg
      FROM leads WHERE funnel_id = ? AND created_at >= ? AND created_at <= ?
    `)
      .get(funnelId, start, end) as any;

    const stages = this.getStages(funnelId);
    const leadsPerStage: Record<string, number> = {};
    const valuePerStage: Record<string, number> = {};
    const stageConversionRates: Record<string, number> = {};
    const avgTimePerStage: Record<string, number> = {};

    for (const stage of stages) {
      const stageStats = this.db
        .prepare(
          "SELECT COUNT(*) as c, COALESCE(SUM(estimated_value), 0) as v FROM leads WHERE stage_id = ? AND archived_at IS NULL",
        )
        .get(stage.id) as any;
      leadsPerStage[stage.id] = stageStats.c;
      valuePerStage[stage.id] = stageStats.v;

      const kpis = this.getStageKPIs(stage.id);
      stageConversionRates[stage.id] = kpis.conversionRate;
      avgTimePerStage[stage.id] = kpis.avgTimeInStage;
    }

    const activityStats = this.db
      .prepare(`
      SELECT type, COUNT(*) as c FROM lead_activities la JOIN leads l ON la.lead_id = l.id
      WHERE l.funnel_id = ? AND la.created_at >= ? AND la.created_at <= ? GROUP BY type
    `)
      .all(funnelId, start, end) as any[];

    const activitiesByType: Record<string, number> = {};
    let totalActivities = 0;
    for (const r of activityStats) {
      activitiesByType[r.type] = r.c;
      totalActivities += r.c;
    }

    return {
      funnelId,
      period: { start, end },
      totalLeads,
      newLeads,
      convertedLeads,
      lostLeads,
      overallConversionRate: totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0,
      stageConversionRates,
      totalValue: valueStats.total,
      wonValue: valueStats.won,
      lostValue: valueStats.lost,
      averageDealSize: valueStats.avg,
      averageDaysToClose: 0,
      averageTimePerStage: avgTimePerStage,
      totalActivities,
      activitiesByType,
      leadsPerStage,
      valuePerStage,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // FLOW MAP OPERATIONS (Visual Funnel Builder)
  // ═══════════════════════════════════════════════════════════════

  private rowToFlowMap(row: any): FunnelFlowMap {
    return {
      id: row.id,
      name: row.name,
      businessId: row.business_id,
      nodes: JSON.parse(row.nodes || "[]"),
      connections: JSON.parse(row.connections || "[]"),
      funnelId: row.funnel_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createFlowMap(data: {
    name: string;
    businessId: string;
    nodes?: any[];
    connections?: any[];
    funnelId?: string;
  }): FunnelFlowMap {
    const id = this.uuid();
    const now = this.now();

    this.db
      .prepare(`
      INSERT INTO flow_maps (id, business_id, name, nodes, connections, funnel_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        data.businessId,
        data.name,
        JSON.stringify(data.nodes || []),
        JSON.stringify(data.connections || []),
        data.funnelId ?? null,
        now,
        now,
      );

    return {
      id,
      name: data.name,
      businessId: data.businessId,
      nodes: data.nodes || [],
      connections: data.connections || [],
      funnelId: data.funnelId,
      createdAt: now,
      updatedAt: now,
    };
  }

  getFlowMap(id: string): FunnelFlowMap | null {
    const row = this.db.prepare("SELECT * FROM flow_maps WHERE id = ?").get(id) as any;
    return row ? this.rowToFlowMap(row) : null;
  }

  getFlowMapByBusiness(businessId: string): FunnelFlowMap | null {
    const row = this.db
      .prepare("SELECT * FROM flow_maps WHERE business_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(businessId) as any;
    return row ? this.rowToFlowMap(row) : null;
  }

  getFlowMapByFunnel(funnelId: string): FunnelFlowMap | null {
    const row = this.db
      .prepare("SELECT * FROM flow_maps WHERE funnel_id = ? LIMIT 1")
      .get(funnelId) as any;
    return row ? this.rowToFlowMap(row) : null;
  }

  listFlowMaps(businessId?: string): FunnelFlowMap[] {
    const sql = businessId
      ? "SELECT * FROM flow_maps WHERE business_id = ? ORDER BY updated_at DESC"
      : "SELECT * FROM flow_maps ORDER BY updated_at DESC";
    const rows = (
      businessId ? this.db.prepare(sql).all(businessId) : this.db.prepare(sql).all()
    ) as any[];
    return rows.map((r) => this.rowToFlowMap(r));
  }

  updateFlowMap(
    id: string,
    data: Partial<{ name: string; nodes: any[]; connections: any[]; funnelId: string | null }>,
  ): FunnelFlowMap | null {
    const existing = this.getFlowMap(id);
    if (!existing) return null;

    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [this.now()];

    if (data.name !== undefined) {
      updates.push("name = ?");
      values.push(data.name);
    }
    if (data.nodes !== undefined) {
      updates.push("nodes = ?");
      values.push(JSON.stringify(data.nodes));
    }
    if (data.connections !== undefined) {
      updates.push("connections = ?");
      values.push(JSON.stringify(data.connections));
    }
    if (data.funnelId !== undefined) {
      updates.push("funnel_id = ?");
      values.push(data.funnelId);
    }

    values.push(id);
    this.db.prepare(`UPDATE flow_maps SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    return this.getFlowMap(id);
  }

  upsertFlowMap(data: {
    id?: string;
    name: string;
    businessId: string;
    nodes: any[];
    connections: any[];
    funnelId?: string;
  }): FunnelFlowMap {
    if (data.id) {
      const existing = this.getFlowMap(data.id);
      if (existing) {
        return this.updateFlowMap(data.id, {
          name: data.name,
          nodes: data.nodes,
          connections: data.connections,
          ...(data.funnelId !== undefined ? { funnelId: data.funnelId } : {}),
        })!;
      }
      // Caller passed an id we don't have — honor it (insert with that id).
      // Falling through to createFlowMap-with-id would lose the supplied id,
      // so handle inline.
      const now = this.now();
      this.db
        .prepare(`
          INSERT INTO flow_maps (id, business_id, name, nodes, connections, funnel_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          data.id,
          data.businessId,
          data.name,
          JSON.stringify(data.nodes || []),
          JSON.stringify(data.connections || []),
          data.funnelId ?? null,
          now,
          now,
        );
      return this.getFlowMap(data.id)!;
    }

    return this.createFlowMap(data);
  }

  deleteFlowMap(id: string): boolean {
    const result = this.db.prepare("DELETE FROM flow_maps WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // SLICE C: UNIFIED CANVAS — a funnel + its stages IS the flow map
  // ═══════════════════════════════════════════════════════════════
  //
  // The flow_maps table stays around for backward compat with operators
  // who saved canvases pre-unification. New writes go through these
  // helpers — a save creates/updates a funnel + stages + stage_connections,
  // and reads project them back as FunnelFlowMap-shaped objects so the
  // existing UI code doesn't need to know the difference.

  /**
   * Project a funnel + its stages + stage_connections as a FunnelFlowMap.
   * This is the read-side of the unified model.
   */
  buildFlowMapFromFunnel(funnelId: string): FunnelFlowMap | null {
    const funnel = this.getFunnel(funnelId);
    if (!funnel) return null;
    const stages = this.getStages(funnelId);
    const connections = this.getConnections(funnelId);

    // Stages → FlowNodes. Persist the per-stage visual fields verbatim;
    // anything not set falls back to a sensible default the canvas
    // can still render.
    const nodes = stages.map((s, idx) => ({
      id: s.id,
      type: deriveLegacyNodeType(s.libraryId, s.type),
      libraryId: s.libraryId,
      name: s.name,
      emoji: s.emoji,
      color: s.color,
      row: typeof s.row === "number" ? s.row : idx,
      column: typeof s.column === "number" ? s.column : 0,
      items: s.items ?? [],
      integration: s.integration,
      pageLink: s.pageLink,
      kpiTracking: s.kpiTracking,
      stageId: s.id,
    }));

    const flowConnections = connections.map((c) => ({
      id: c.id,
      from: c.sourceStageId,
      to: c.targetStageId,
      label: c.label,
      conditionType: c.conditionType,
      conditionConfig: c.conditionConfig,
      transitionCount: c.transitionCount,
    }));

    return {
      id: `funnel:${funnelId}`,
      name: funnel.name,
      businessId: funnel.businessId,
      nodes: nodes as never,
      connections: flowConnections as never,
      funnelId,
      createdAt: funnel.createdAt,
      updatedAt: funnel.updatedAt,
    };
  }

  /**
   * Persist a FunnelFlowMap as a funnel + stages + stage_connections.
   * Creates the funnel if missing; otherwise rewrites the canvas in
   * place (drops stages/connections that disappeared, upserts the rest).
   *
   * This is the write-side of the unified model. Replaces the old
   * "save to flow_maps, then promote to funnel" two-step.
   */
  saveFlowMapAsFunnel(input: {
    flowMapId?: string;
    funnelId?: string;
    name: string;
    businessId: string;
    nodes: any[];
    connections: any[];
    funnelType?: import("./types.js").FunnelType;
  }): { funnel: import("./types.js").Funnel; stageIdByNodeId: Map<string, string> } {
    // Resolve funnel: explicit funnelId wins, then a flowMapId that
    // happens to be of the form "funnel:<id>", otherwise create fresh.
    let funnelId = input.funnelId;
    if (!funnelId && input.flowMapId?.startsWith("funnel:")) {
      funnelId = input.flowMapId.slice("funnel:".length);
    }
    let funnel = funnelId ? this.getFunnel(funnelId) : null;
    if (!funnel) {
      funnel = this.createFunnel({
        businessId: input.businessId,
        name: input.name,
        type: input.funnelType ?? "sales",
        status: "active",
      });
      funnelId = funnel.id;
    } else if (funnel.name !== input.name) {
      this.updateFunnel(funnel.id, { name: input.name });
    }

    // Existing stages keyed by id + an ordered list for position fallback.
    const existingStages = new Map(this.getStages(funnel.id).map((s) => [s.id, s]));
    const existingStagesByPosition = [...existingStages.values()].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    );
    const stageIdByNodeId = new Map<string, string>();
    const keepStageIds = new Set<string>();

    input.nodes.forEach((node: any, idx: number) => {
      const nodeId: string = node.id ?? node.stageId ?? `node-${idx}`;
      // Resolve the target stage in priority order:
      //   1. node.stageId points at an existing stage → reuse it
      //   2. node.id happens to match a stage id → reuse it
      //   3. there's already a stage at this canvas position → reuse it
      //      (this is what makes re-saving an unchanged canvas idempotent
      //      even if the caller didn't stamp stageIds onto nodes)
      const targetStageId: string | undefined =
        (typeof node.stageId === "string" && existingStages.has(node.stageId)
          ? (node.stageId as string)
          : undefined) ??
        (existingStages.has(nodeId) ? nodeId : undefined) ??
        (existingStagesByPosition[idx] && !keepStageIds.has(existingStagesByPosition[idx].id)
          ? existingStagesByPosition[idx].id
          : undefined);

      const stageType = deriveStageType(node.libraryId, node.type);

      const patch: Partial<Stage> = {
        name: node.name ?? `Step ${idx + 1}`,
        type: stageType,
        position: idx,
        color: node.color,
        libraryId: node.libraryId,
        emoji: node.emoji,
        row: typeof node.row === "number" ? node.row : idx,
        column: typeof node.column === "number" ? node.column : 0,
        items: Array.isArray(node.items) ? node.items : undefined,
        integration: node.integration,
        pageLink: node.pageLink,
        kpiTracking: node.kpiTracking,
      };

      if (targetStageId) {
        this.updateStage(targetStageId, patch);
        keepStageIds.add(targetStageId);
        stageIdByNodeId.set(nodeId, targetStageId);
      } else {
        const created = this.addStage({
          funnelId: funnel.id,
          name: patch.name!,
          type: stageType,
          position: idx,
          color: patch.color,
          libraryId: patch.libraryId,
          emoji: patch.emoji,
          row: patch.row,
          column: patch.column,
          items: patch.items,
          integration: patch.integration,
          pageLink: patch.pageLink,
          kpiTracking: patch.kpiTracking,
        });
        keepStageIds.add(created.id);
        stageIdByNodeId.set(nodeId, created.id);
      }
    });

    // Drop stages the canvas no longer references. Use moveLeadsTo on
    // the first surviving stage so leads don't get orphaned.
    const survivor = keepStageIds.size > 0 ? Array.from(keepStageIds)[0] : undefined;
    for (const stageId of existingStages.keys()) {
      if (!keepStageIds.has(stageId)) {
        this.deleteStage(stageId, survivor);
      }
    }

    // Reconcile connections. Map the canvas's from/to (which may use
    // node ids that aren't stage ids) onto real stage ids.
    const existingConns = new Map(this.getConnections(funnel.id).map((c) => [c.id, c]));
    const keepConnIds = new Set<string>();
    for (const conn of input.connections as Array<any>) {
      const fromStage = stageIdByNodeId.get(conn.from) ?? conn.from;
      const toStage = stageIdByNodeId.get(conn.to) ?? conn.to;
      if (!fromStage || !toStage) continue;
      // Reuse existing connection id if the same pair already exists.
      const existing = Array.from(existingConns.values()).find(
        (c) => c.sourceStageId === fromStage && c.targetStageId === toStage,
      );
      if (existing) {
        keepConnIds.add(existing.id);
        continue;
      }
      const created = this.connectStages({
        funnelId: funnel.id,
        sourceStageId: fromStage,
        targetStageId: toStage,
        label: conn.label,
        conditionType: conn.conditionType,
        conditionConfig: conn.conditionConfig,
      });
      keepConnIds.add(created.id);
    }
    for (const cid of existingConns.keys()) {
      if (!keepConnIds.has(cid)) this.deleteConnection(cid);
    }

    return { funnel, stageIdByNodeId };
  }

  /**
   * List every funnel as a FunnelFlowMap projection. Used by
   * funnels.flowmap.list under the unified model.
   */
  listFunnelsAsFlowMaps(businessId?: string): FunnelFlowMap[] {
    const funnels = this.getFunnels({ businessId });
    return funnels
      .map((f) => this.buildFlowMapFromFunnel(f.id))
      .filter((m): m is FunnelFlowMap => !!m);
  }

  // ═══════════════════════════════════════════════════════════════
  // FORM / PAGE → FUNNEL BINDINGS
  // ═══════════════════════════════════════════════════════════════
  //
  // Used by the end-to-end flow: a published qualifier form or landing
  // page is bound to a (funnel, entryStage) pair. The intake handler
  // looks up the binding when a submission arrives and creates a lead
  // in the right stage, tagged with a source marker. This is the wire
  // that turned six isolated systems into one funnel.

  bindFormToFunnel(input: {
    formId: string;
    businessId: string;
    funnelId: string;
    entryStageId: string;
    tag?: string;
  }): { formId: string; funnelId: string; entryStageId: string } {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO funnel_form_bindings (form_id, business_id, funnel_id, entry_stage_id, tag, created_at, updated_at)
         VALUES (@form_id, @business_id, @funnel_id, @entry_stage_id, @tag, @now, @now)
         ON CONFLICT(form_id) DO UPDATE SET
           business_id = excluded.business_id,
           funnel_id   = excluded.funnel_id,
           entry_stage_id = excluded.entry_stage_id,
           tag         = excluded.tag,
           updated_at  = excluded.updated_at`,
      )
      .run({
        form_id: input.formId,
        business_id: input.businessId,
        funnel_id: input.funnelId,
        entry_stage_id: input.entryStageId,
        tag: input.tag ?? null,
        now,
      });
    return {
      formId: input.formId,
      funnelId: input.funnelId,
      entryStageId: input.entryStageId,
    };
  }

  getFormBinding(formId: string): {
    formId: string;
    businessId: string;
    funnelId: string;
    entryStageId: string;
    tag: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT form_id, business_id, funnel_id, entry_stage_id, tag
           FROM funnel_form_bindings WHERE form_id = ?`,
      )
      .get(formId) as
      | {
          form_id: string;
          business_id: string;
          funnel_id: string;
          entry_stage_id: string;
          tag: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      formId: row.form_id,
      businessId: row.business_id,
      funnelId: row.funnel_id,
      entryStageId: row.entry_stage_id,
      tag: row.tag,
    };
  }

  listFormBindings(filters?: { businessId?: string; funnelId?: string }): Array<{
    formId: string;
    businessId: string;
    funnelId: string;
    entryStageId: string;
    tag: string | null;
  }> {
    let sql =
      "SELECT form_id, business_id, funnel_id, entry_stage_id, tag FROM funnel_form_bindings";
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filters?.businessId) {
      where.push("business_id = @businessId");
      params.businessId = filters.businessId;
    }
    if (filters?.funnelId) {
      where.push("funnel_id = @funnelId");
      params.funnelId = filters.funnelId;
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    const rows = this.db.prepare(sql).all(params) as Array<{
      form_id: string;
      business_id: string;
      funnel_id: string;
      entry_stage_id: string;
      tag: string | null;
    }>;
    return rows.map((r) => ({
      formId: r.form_id,
      businessId: r.business_id,
      funnelId: r.funnel_id,
      entryStageId: r.entry_stage_id,
      tag: r.tag,
    }));
  }

  unbindForm(formId: string): boolean {
    const r = this.db.prepare("DELETE FROM funnel_form_bindings WHERE form_id = ?").run(formId);
    return r.changes > 0;
  }

  // ── Landing-page bindings (same shape) ──
  bindPageToFunnel(input: {
    pageId: string;
    businessId: string;
    funnelId: string;
    entryStageId: string;
    tag?: string;
  }): { pageId: string; funnelId: string; entryStageId: string } {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO funnel_page_bindings (page_id, business_id, funnel_id, entry_stage_id, tag, created_at, updated_at)
         VALUES (@page_id, @business_id, @funnel_id, @entry_stage_id, @tag, @now, @now)
         ON CONFLICT(page_id) DO UPDATE SET
           business_id = excluded.business_id,
           funnel_id   = excluded.funnel_id,
           entry_stage_id = excluded.entry_stage_id,
           tag         = excluded.tag,
           updated_at  = excluded.updated_at`,
      )
      .run({
        page_id: input.pageId,
        business_id: input.businessId,
        funnel_id: input.funnelId,
        entry_stage_id: input.entryStageId,
        tag: input.tag ?? null,
        now,
      });
    return {
      pageId: input.pageId,
      funnelId: input.funnelId,
      entryStageId: input.entryStageId,
    };
  }

  getPageBinding(pageId: string): {
    pageId: string;
    businessId: string;
    funnelId: string;
    entryStageId: string;
    tag: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT page_id, business_id, funnel_id, entry_stage_id, tag
           FROM funnel_page_bindings WHERE page_id = ?`,
      )
      .get(pageId) as
      | {
          page_id: string;
          business_id: string;
          funnel_id: string;
          entry_stage_id: string;
          tag: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      pageId: row.page_id,
      businessId: row.business_id,
      funnelId: row.funnel_id,
      entryStageId: row.entry_stage_id,
      tag: row.tag,
    };
  }

  listPageBindings(filters?: { businessId?: string; funnelId?: string }): Array<{
    pageId: string;
    businessId: string;
    funnelId: string;
    entryStageId: string;
    tag: string | null;
  }> {
    let sql =
      "SELECT page_id, business_id, funnel_id, entry_stage_id, tag FROM funnel_page_bindings";
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filters?.businessId) {
      where.push("business_id = @businessId");
      params.businessId = filters.businessId;
    }
    if (filters?.funnelId) {
      where.push("funnel_id = @funnelId");
      params.funnelId = filters.funnelId;
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    const rows = this.db.prepare(sql).all(params) as Array<{
      page_id: string;
      business_id: string;
      funnel_id: string;
      entry_stage_id: string;
      tag: string | null;
    }>;
    return rows.map((r) => ({
      pageId: r.page_id,
      businessId: r.business_id,
      funnelId: r.funnel_id,
      entryStageId: r.entry_stage_id,
      tag: r.tag,
    }));
  }

  unbindPage(pageId: string): boolean {
    const r = this.db.prepare("DELETE FROM funnel_page_bindings WHERE page_id = ?").run(pageId);
    return r.changes > 0;
  }
}
