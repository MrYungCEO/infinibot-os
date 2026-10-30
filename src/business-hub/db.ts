/**
 * Business hub — the one SQLite file behind the connected business model
 * (docs/business/DATA_MODEL.md). One handle per state dir, so SaaS tenants
 * each get their own `business-hub.db`.
 *
 * The schema lives here in full so every hub module (contacts, pipeline,
 * tracking, email, imports, lead-gen, revenue) shares one contract. Columns
 * are added through numbered migrations (`PRAGMA user_version`).
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";

export type HubDb = Database.Database;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS hub_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, business_id TEXT, kind TEXT NOT NULL, name TEXT NOT NULL,
  utm_source TEXT, utm_medium TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sources_key ON sources(kind, name);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL, utm_campaign TEXT,
  channel TEXT NOT NULL DEFAULT 'email', status TEXT NOT NULL DEFAULT 'draft',
  goal TEXT, budget_cents INTEGER, legacy_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaigns_utm ON campaigns(utm_campaign) WHERE utm_campaign IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaigns_legacy ON campaigns(legacy_ref) WHERE legacy_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL, domain TEXT, website TEXT,
  industry TEXT, size TEXT, phone TEXT, address TEXT, city TEXT, region TEXT, country TEXT,
  lat REAL, lon REAL, social TEXT NOT NULL DEFAULT '{}', custom TEXT NOT NULL DEFAULT '{}',
  client_id TEXT, source_id TEXT, import_batch_id TEXT, legacy_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_domain ON companies(domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_client ON companies(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_legacy ON companies(legacy_ref) WHERE legacy_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_companies_name ON companies(lower(name));

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL DEFAULT '',
  first_name TEXT, last_name TEXT, email TEXT, phone TEXT, phone_e164 TEXT, title TEXT,
  company_id TEXT, client_id TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'lead', score INTEGER NOT NULL DEFAULT 0,
  email_status TEXT NOT NULL DEFAULT 'unknown',
  email_opt_in INTEGER NOT NULL DEFAULT 0, consent_at INTEGER, consent_source TEXT,
  owner TEXT, city TEXT, country TEXT,
  social TEXT NOT NULL DEFAULT '{}', custom TEXT NOT NULL DEFAULT '{}',
  first_source_id TEXT, first_campaign_id TEXT, first_page_id TEXT,
  last_activity_at INTEGER, import_batch_id TEXT, legacy_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_contacts_phone ON contacts(phone_e164);
CREATE INDEX IF NOT EXISTS ix_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS ix_contacts_client ON contacts(client_id);
CREATE INDEX IF NOT EXISTS ix_contacts_lifecycle ON contacts(lifecycle);
CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_legacy ON contacts(legacy_ref) WHERE legacy_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'open', probability INTEGER NOT NULL DEFAULT 0,
  required_fields TEXT NOT NULL DEFAULT '[]', rot_days INTEGER, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stages_pipeline ON stages(pipeline_id, position);
CREATE TABLE IF NOT EXISTS stage_rules (
  id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, event TEXT NOT NULL, to_stage_id TEXT NOT NULL,
  only_from TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY, business_id TEXT, title TEXT NOT NULL, pipeline_id TEXT NOT NULL,
  stage_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  value_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
  probability INTEGER, expected_close_at INTEGER, next_action TEXT, next_action_at INTEGER,
  lost_reason TEXT, contact_id TEXT, company_id TEXT, client_id TEXT, source_id TEXT,
  campaign_id TEXT, project_id TEXT, kanban_task_id TEXT, owner TEXT,
  stage_entered_at INTEGER NOT NULL, won_at INTEGER, lost_at INTEGER,
  custom TEXT NOT NULL DEFAULT '{}', legacy_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_deals_stage ON deals(pipeline_id, stage_id);
CREATE INDEX IF NOT EXISTS ix_deals_contact ON deals(contact_id);
CREATE INDEX IF NOT EXISTS ix_deals_company ON deals(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_deals_legacy ON deals(legacy_ref) WHERE legacy_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  type TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  actor TEXT, occurred_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_act_subject ON activities(subject_type, subject_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_act_type ON activities(type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_name ON tags(lower(name));
CREATE TABLE IF NOT EXISTS taggings (
  tag_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (tag_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS ix_taggings_subject ON taggings(subject_type, subject_id);

-- Landing-page tracking ------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL, public_key TEXT NOT NULL,
  origins TEXT NOT NULL DEFAULT '[]', consent_mode TEXT NOT NULL DEFAULT 'cookieless',
  funnel_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sites_key ON sites(public_key);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pages_path ON pages(site_id, path);
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY, site_id TEXT, anon_id TEXT NOT NULL, contact_id TEXT,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  first_utm TEXT NOT NULL DEFAULT '{}', first_referrer TEXT, first_page_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_visitors_anon ON visitors(site_id, anon_id);
CREATE INDEX IF NOT EXISTS ix_visitors_contact ON visitors(contact_id);
CREATE TABLE IF NOT EXISTS track_events (
  id TEXT PRIMARY KEY, site_id TEXT, page_id TEXT, visitor_id TEXT, contact_id TEXT,
  session_id TEXT, type TEXT NOT NULL, name TEXT, url TEXT, referrer TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  campaign_id TEXT, props TEXT NOT NULL DEFAULT '{}', occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_te_site ON track_events(site_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_te_visitor ON track_events(visitor_id);
CREATE INDEX IF NOT EXISTS ix_te_contact ON track_events(contact_id);
CREATE INDEX IF NOT EXISTS ix_te_type ON track_events(type, occurred_at);

-- Email campaigns ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL, subject TEXT NOT NULL,
  html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL, filter TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_campaigns (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, segment_id TEXT, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', from_name TEXT, from_email TEXT, reply_to TEXT,
  account_id TEXT, provider_hint TEXT,
  per_minute INTEGER NOT NULL DEFAULT 20, per_day INTEGER NOT NULL DEFAULT 400,
  stop_on_reply INTEGER NOT NULL DEFAULT 1, track_opens INTEGER NOT NULL DEFAULT 1,
  track_clicks INTEGER NOT NULL DEFAULT 1, require_opt_in INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_steps (
  id TEXT PRIMARY KEY, email_campaign_id TEXT NOT NULL, position INTEGER NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0, template_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_steps_campaign ON email_steps(email_campaign_id, position);
CREATE TABLE IF NOT EXISTS email_enrollments (
  id TEXT PRIMARY KEY, email_campaign_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', next_step INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER, stopped_reason TEXT, enrolled_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_enroll ON email_enrollments(email_campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS ix_enroll_due ON email_enrollments(status, next_send_at);
CREATE TABLE IF NOT EXISTS email_sends (
  id TEXT PRIMARY KEY, email_campaign_id TEXT, step_id TEXT, enrollment_id TEXT,
  contact_id TEXT, to_email TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL,
  provider TEXT, provider_message_id TEXT, error TEXT,
  sent_at INTEGER, opened_at INTEGER, open_count INTEGER NOT NULL DEFAULT 0,
  clicked_at INTEGER, click_count INTEGER NOT NULL DEFAULT 0,
  replied_at INTEGER, bounced_at INTEGER, bounce_type TEXT, complained_at INTEGER,
  unsubscribed_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sends_campaign ON email_sends(email_campaign_id);
CREATE INDEX IF NOT EXISTS ix_sends_contact ON email_sends(contact_id);
CREATE INDEX IF NOT EXISTS ix_sends_msg ON email_sends(provider_message_id);
CREATE INDEX IF NOT EXISTS ix_sends_sent ON email_sends(sent_at);
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL
);

-- Imports --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, business_id TEXT, file_name TEXT NOT NULL, format TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'contacts', mapping TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'previewed',
  total INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]', source_id TEXT,
  committed_at INTEGER, undone_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_changes (
  batch_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  action TEXT NOT NULL, before TEXT, PRIMARY KEY (batch_id, subject_type, subject_id)
);

-- Lead generation ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leadgen_jobs (
  id TEXT PRIMARY KEY, business_id TEXT, query TEXT NOT NULL, location TEXT,
  providers TEXT NOT NULL DEFAULT '[]', options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', progress TEXT NOT NULL DEFAULT '{}', error TEXT,
  result_count INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS leadgen_results (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, data TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new',
  contact_id TEXT, company_id TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lgr ON leadgen_results(job_id, dedupe_key);

-- Revenue --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revenue_accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, company_ref TEXT,
  api_version TEXT, secret TEXT, secret_ref TEXT, webhook_secret TEXT,
  status TEXT NOT NULL DEFAULT 'idle', last_error TEXT, last_sync_at INTEGER,
  business_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revenue_sync_state (
  account_id TEXT NOT NULL, object TEXT NOT NULL, cursor TEXT, backfill_done INTEGER NOT NULL DEFAULT 0,
  high_water INTEGER, fetched INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER, last_error TEXT, PRIMARY KEY (account_id, object)
);
CREATE TABLE IF NOT EXISTS revenue_txns (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL, gross_cents INTEGER NOT NULL DEFAULT 0,
  fee_cents INTEGER NOT NULL DEFAULT 0, net_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
  amount_usd_cents INTEGER, occurred_at INTEGER NOT NULL,
  product_id TEXT, product_name TEXT, plan_id TEXT, billing_reason TEXT,
  customer_ref TEXT, customer_email TEXT, customer_name TEXT, subscription_ref TEXT,
  parent_external_id TEXT, contact_id TEXT, client_id TEXT, deal_id TEXT, campaign_id TEXT,
  invoice_id TEXT, raw TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_txn_ext ON revenue_txns(account_id, type, external_id);
CREATE INDEX IF NOT EXISTS ix_txn_time ON revenue_txns(occurred_at);
CREATE INDEX IF NOT EXISTS ix_txn_contact ON revenue_txns(contact_id);
CREATE INDEX IF NOT EXISTS ix_txn_email ON revenue_txns(customer_email);
CREATE TABLE IF NOT EXISTS revenue_subscriptions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
  status TEXT NOT NULL, product_id TEXT, product_name TEXT, plan_id TEXT,
  interval TEXT, interval_count INTEGER NOT NULL DEFAULT 1, amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD', customer_ref TEXT, customer_email TEXT, contact_id TEXT,
  started_at INTEGER, canceled_at INTEGER, current_period_end INTEGER,
  raw TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_ext ON revenue_subscriptions(account_id, external_id);
CREATE TABLE IF NOT EXISTS revenue_products (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL,
  raw TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_prod_ext ON revenue_products(account_id, external_id);
CREATE TABLE IF NOT EXISTS revenue_webhook_events (
  id TEXT PRIMARY KEY, account_id TEXT, provider TEXT NOT NULL, event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, error TEXT
);
`;

const SCHEMA_V2 = `
ALTER TABLE revenue_txns ADD COLUMN company_id TEXT;
ALTER TABLE revenue_txns ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS ix_txn_client ON revenue_txns(client_id);
CREATE INDEX IF NOT EXISTS ix_txn_invoice ON revenue_txns(invoice_id);
CREATE INDEX IF NOT EXISTS ix_txn_project ON revenue_txns(project_id);

-- User-editable product -> business-project classification. Product names are
-- still classified deterministically when there is no row here; this table is
-- only the explicit override, so newly synced products appear immediately.
CREATE TABLE IF NOT EXISTS revenue_project_mappings (
  product_key TEXT PRIMARY KEY, account_id TEXT, product_id TEXT, product_name TEXT NOT NULL,
  project TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_revenue_project_mapping_account
  ON revenue_project_mappings(account_id, product_id);
`;

const SCHEMA_V3 = `
-- Lead Autopilot -------------------------------------------------------------
-- Offers and every downstream object live in the same business-hub database,
-- so contacts, deals, email, bookings and revenue share stable IDs.
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY, business_id TEXT, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  product_source TEXT, product_id TEXT, plan_id TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
  icp TEXT NOT NULL DEFAULT '{}', value_prop TEXT NOT NULL DEFAULT '',
  proof TEXT NOT NULL DEFAULT '[]', objections TEXT NOT NULL DEFAULT '[]',
  cta TEXT NOT NULL DEFAULT '{}', playbook TEXT NOT NULL DEFAULT '{}',
  booking TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_offers_status ON offers(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_offers_product ON offers(product_source, product_id, plan_id);

CREATE TABLE IF NOT EXISTS autopilot_campaigns (
  id TEXT PRIMARY KEY, business_id TEXT, offer_id TEXT NOT NULL,
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  source_query TEXT NOT NULL, location TEXT, providers TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT '{}', sequence TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL DEFAULT '{}', send_mode TEXT NOT NULL DEFAULT 'approval',
  daily_cap INTEGER NOT NULL DEFAULT 25, warmup_days INTEGER NOT NULL DEFAULT 7,
  stop_on_reply INTEGER NOT NULL DEFAULT 1, stop_on_book INTEGER NOT NULL DEFAULT 1,
  live_send_enabled INTEGER NOT NULL DEFAULT 0,
  email_campaign_id TEXT, leadgen_job_id TEXT,
  last_run_at INTEGER, next_run_at INTEGER, lease_token TEXT, lease_until INTEGER,
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ap_campaign_due ON autopilot_campaigns(status, next_run_at);
CREATE INDEX IF NOT EXISTS ix_ap_campaign_offer ON autopilot_campaigns(offer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS autopilot_messages (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, offer_id TEXT NOT NULL,
  contact_id TEXT NOT NULL, deal_id TEXT, step_index INTEGER NOT NULL DEFAULT 0,
  direction TEXT NOT NULL DEFAULT 'outbound', status TEXT NOT NULL DEFAULT 'draft',
  category TEXT, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}', due_at INTEGER, approved_at INTEGER,
  sent_at INTEGER, replied_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_message_step
  ON autopilot_messages(campaign_id, contact_id, step_index, direction);
CREATE INDEX IF NOT EXISTS ix_ap_message_due ON autopilot_messages(status, due_at);
CREATE INDEX IF NOT EXISTS ix_ap_message_contact ON autopilot_messages(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS autopilot_replies (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, offer_id TEXT NOT NULL,
  contact_id TEXT NOT NULL, deal_id TEXT, message_id TEXT,
  inbound_id TEXT, subject TEXT, body TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0,
  draft_response TEXT, status TEXT NOT NULL DEFAULT 'needs_approval',
  received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_reply_inbound
  ON autopilot_replies(inbound_id) WHERE inbound_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ap_reply_status ON autopilot_replies(status, received_at DESC);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, campaign_id TEXT,
  contact_id TEXT, deal_id TEXT, name TEXT NOT NULL, email TEXT NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked', notes TEXT,
  public_token TEXT NOT NULL, calendar_event_id TEXT, calendar_link TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_token ON bookings(public_token);
CREATE INDEX IF NOT EXISTS ix_booking_time ON bookings(starts_at, status);
CREATE INDEX IF NOT EXISTS ix_booking_offer ON bookings(offer_id, starts_at);

CREATE TABLE IF NOT EXISTS autopilot_attribution (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, offer_id TEXT NOT NULL,
  campaign_id TEXT, contact_id TEXT, deal_id TEXT, message_id TEXT,
  booking_id TEXT, revenue_txn_id TEXT, event TEXT NOT NULL,
  value_cents INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}', occurred_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_attr_dedupe ON autopilot_attribution(dedupe_key);
CREATE INDEX IF NOT EXISTS ix_ap_attr_offer ON autopilot_attribution(offer_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_ap_attr_campaign ON autopilot_attribution(campaign_id, occurred_at);

CREATE TABLE IF NOT EXISTS autopilot_audit (
  id TEXT PRIMARY KEY, idempotency_key TEXT, campaign_id TEXT, offer_id TEXT,
  action TEXT NOT NULL, subject_type TEXT, subject_id TEXT,
  status TEXT NOT NULL DEFAULT 'ok', detail TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_audit_idem
  ON autopilot_audit(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ap_audit_campaign ON autopilot_audit(campaign_id, occurred_at DESC);
`;

const MIGRATIONS: Array<(db: HubDb) => void> = [
  (db) => db.exec(SCHEMA_V1),
  (db) => db.exec(SCHEMA_V2),
  (db) => db.exec(SCHEMA_V3),
];

const handles = new Map<string, HubDb>();

/** Path of the hub database for a state dir. */
export function hubDbPath(stateDir?: string): string {
  return join(stateDir || resolveStateDirWithLegacyEnv(), "business-hub.db");
}

/** The shared hub handle for a state dir (opens + migrates on first use). */
export function getHubDb(stateDir?: string): HubDb {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = handles.get(dir);
  if (db && db.open) return db;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = openHubDb(join(dir, "business-hub.db"));
  handles.set(dir, db);
  return db;
}

/** Open (and migrate) a hub database at an explicit path — tests use ":memory:". */
export function openHubDb(path: string): HubDb {
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

/** Close every cached handle (tests). */
export function closeHubDbs(): void {
  for (const db of handles.values()) if (db.open) db.close();
  handles.clear();
}

export function getMeta(db: HubDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM hub_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: HubDb, key: string, value: string): void {
  db.prepare(
    "INSERT INTO hub_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}
