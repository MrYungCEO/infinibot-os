/**
 * Closed-Loop Lead Pipeline — database seed + migration.
 *
 * Adds the new closed-loop lifecycle properties to the existing Leads database
 * and creates the Campaigns, OutreachMessages, and OutreachTemplates databases.
 *
 * Idempotent: safe to call on every gateway boot.
 * Additive only: never removes existing properties or rows.
 */

import type { DatabasesStore } from "./store.js";
import type { PropertyType, PropertyConfig } from "./types.js";

// ── Lead lifecycle Status options ─────────────────────────────────────────────

const LIFECYCLE_STATUS_OPTIONS = [
  { id: "raw", name: "Raw", color: "#94a3b8" },
  { id: "enriching", name: "Enriching", color: "#60a5fa" },
  { id: "enriched", name: "Enriched", color: "#34d399" },
  { id: "enrichment_failed", name: "Enrichment Failed", color: "#f87171" },
  { id: "scoring", name: "Scoring", color: "#a78bfa" },
  { id: "qualified", name: "Qualified", color: "#34d399" },
  { id: "disqualified", name: "Disqualified", color: "#f87171" },
  { id: "queued", name: "Queued", color: "#fbbf24" },
  { id: "contacted", name: "Contacted", color: "#60a5fa" },
  { id: "opened", name: "Opened", color: "#818cf8" },
  { id: "replied", name: "Replied", color: "#34d399" },
  { id: "engaged", name: "Engaged", color: "#10b981" },
  { id: "not_interested", name: "Not Interested", color: "#f87171" },
  { id: "unsubscribed", name: "Unsubscribed", color: "#6b7280" },
  { id: "oof", name: "Out of Office", color: "#f59e0b" },
  { id: "bounced", name: "Bounced", color: "#ef4444" },
  { id: "unresponsive", name: "Unresponsive", color: "#9ca3af" },
  { id: "meeting_booked", name: "Meeting Booked", color: "#06b6d4" },
  { id: "won", name: "Won", color: "#10b981" },
  { id: "lost", name: "Lost", color: "#ef4444" },
  { id: "needs_review", name: "Needs Review", color: "#f59e0b" },
  { id: "dead", name: "Dead", color: "#374151" },
  { id: "quarantined", name: "Quarantined", color: "#6b7280" },
];

// ── New lead properties to add to the existing Leads database ─────────────────

interface TemplateProperty {
  name: string;
  type: PropertyType;
  config?: PropertyConfig;
}

const NEW_LEAD_PROPERTIES: TemplateProperty[] = [
  {
    name: "LifecycleStatus",
    type: "select",
    config: { options: LIFECYCLE_STATUS_OPTIONS },
  },
  { name: "Website", type: "url" },
  { name: "Address", type: "richText" },
  { name: "Rating", type: "number" },
  { name: "ReviewCount", type: "number" },
  { name: "QualifierScore", type: "number" },
  { name: "QualifierReason", type: "richText" },
  { name: "RecommendedPitch", type: "richText" },
  { name: "FollowUpCount", type: "number" },
  { name: "LastContactedAt", type: "date" },
  { name: "NextTouchAt", type: "date" },
  { name: "ReplyCount", type: "number" },
  { name: "Opens", type: "number" },
  { name: "Clicks", type: "number" },
  { name: "Paused", type: "checkbox" },
  { name: "CampaignId", type: "richText" },
  { name: "SourceQuery", type: "richText" },
  {
    name: "LeadSource",
    type: "select",
    config: {
      options: [
        { id: "google_maps", name: "Google Maps" },
        { id: "instagram", name: "Instagram" },
        { id: "directory", name: "Directory" },
        { id: "manual", name: "Manual" },
        { id: "csv", name: "CSV Import" },
        { id: "other", name: "Other" },
      ],
    },
  },
  { name: "Unsubscribed", type: "checkbox" },
];

// ── Campaigns database ────────────────────────────────────────────────────────

const CAMPAIGNS_TEMPLATE = {
  name: "Campaigns",
  icon: "📣",
  description: "Outreach campaigns — seed queries, qualifier rules, and funnel KPIs.",
  properties: [
    { name: "Name", type: "title" as PropertyType },
    { name: "SeedQuery", type: "richText" as PropertyType },
    {
      name: "SourceList",
      type: "multiSelect" as PropertyType,
      config: {
        options: [
          { id: "google_maps", name: "Google Maps" },
          { id: "instagram", name: "Instagram" },
          { id: "directory", name: "Directory" },
          { id: "csv", name: "CSV Import" },
        ],
      },
    },
    { name: "QualifierTemplate", type: "richText" as PropertyType },
    { name: "OutreachTemplate", type: "richText" as PropertyType },
    { name: "AutoPromote", type: "checkbox" as PropertyType },
    { name: "QualifierThreshold", type: "number" as PropertyType },
    { name: "StartedAt", type: "date" as PropertyType },
    { name: "OwnerAgentId", type: "richText" as PropertyType },
    { name: "LeadCount", type: "number" as PropertyType },
    { name: "QualifiedCount", type: "number" as PropertyType },
    { name: "ContactedCount", type: "number" as PropertyType },
    { name: "RepliedCount", type: "number" as PropertyType },
    { name: "WonCount", type: "number" as PropertyType },
    {
      name: "Status",
      type: "select" as PropertyType,
      config: {
        options: [
          { id: "draft", name: "Draft", color: "#94a3b8" },
          { id: "active", name: "Active", color: "#10b981" },
          { id: "paused", name: "Paused", color: "#f59e0b" },
          { id: "completed", name: "Completed", color: "#6b7280" },
        ],
      },
    },
    { name: "Notes", type: "richText" as PropertyType },
  ],
};

// ── OutreachMessages database ─────────────────────────────────────────────────

const OUTREACH_MESSAGES_TEMPLATE = {
  name: "OutreachMessages",
  icon: "📧",
  description: "Per-lead outreach message log — sent emails, thread tracking, open/click events.",
  properties: [
    { name: "Subject", type: "title" as PropertyType },
    { name: "LeadId", type: "richText" as PropertyType },
    { name: "CampaignId", type: "richText" as PropertyType },
    { name: "TemplateId", type: "richText" as PropertyType },
    { name: "Body", type: "richText" as PropertyType },
    { name: "SentAt", type: "date" as PropertyType },
    { name: "ThreadId", type: "richText" as PropertyType },
    { name: "MessageId", type: "richText" as PropertyType },
    {
      name: "Status",
      type: "select" as PropertyType,
      config: {
        options: [
          { id: "queued", name: "Queued", color: "#94a3b8" },
          { id: "sent", name: "Sent", color: "#3b82f6" },
          { id: "delivered", name: "Delivered", color: "#60a5fa" },
          { id: "opened", name: "Opened", color: "#818cf8" },
          { id: "clicked", name: "Clicked", color: "#a78bfa" },
          { id: "replied", name: "Replied", color: "#34d399" },
          { id: "bounced", name: "Bounced", color: "#f87171" },
          { id: "failed", name: "Failed", color: "#ef4444" },
        ],
      },
    },
    { name: "OpenedAt", type: "date" as PropertyType },
    { name: "RepliedAt", type: "date" as PropertyType },
    { name: "ReplyBody", type: "richText" as PropertyType },
    { name: "ReplyClassification", type: "richText" as PropertyType },
    { name: "FollowUpNumber", type: "number" as PropertyType },
  ],
};

// ── OutreachTemplates DB ──────────────────────────────────────────────────────

const OUTREACH_TEMPLATES_DB_TEMPLATE = {
  name: "OutreachTemplates",
  icon: "📝",
  description: "Index of outreach template files in ~/.infinibot/outreach/templates/",
  properties: [
    { name: "Name", type: "title" as PropertyType },
    { name: "Subject", type: "richText" as PropertyType },
    { name: "FilePath", type: "richText" as PropertyType },
    { name: "CadenceDays", type: "richText" as PropertyType },
    { name: "MaxFollowups", type: "number" as PropertyType },
    { name: "VariantOf", type: "richText" as PropertyType },
    { name: "LastIndexed", type: "date" as PropertyType },
    {
      name: "Status",
      type: "select" as PropertyType,
      config: {
        options: [
          { id: "active", name: "Active", color: "#10b981" },
          { id: "draft", name: "Draft", color: "#94a3b8" },
          { id: "retired", name: "Retired", color: "#6b7280" },
        ],
      },
    },
  ],
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Idempotently seed the closed-loop lead pipeline databases and migrate
 * the existing Leads database to include all closed-loop properties.
 */
export function ensureLeadPipelineTemplates(store: DatabasesStore): void {
  _migrateLeadsProperties(store);
  _ensureDb(store, CAMPAIGNS_TEMPLATE);
  _ensureDb(store, OUTREACH_MESSAGES_TEMPLATE);
  _ensureDb(store, OUTREACH_TEMPLATES_DB_TEMPLATE);
}

function _migrateLeadsProperties(store: DatabasesStore): void {
  // Migrate ALL native Leads databases — there can be more than one when a
  // business-role DB was auto-created from the generic kanban template before
  // the lifecycle seed ran. Each gets LifecycleStatus + closed-loop fields.
  const leadsDbs = store.listDatabases().filter((d) => d.name === "Leads" && d.source === "native");
  for (const leadsDb of leadsDbs) {
    const existing = store.listProperties(leadsDb.id);
    const existingNames = new Set(existing.map((p) => p.name));

    for (const prop of NEW_LEAD_PROPERTIES) {
      if (existingNames.has(prop.name)) continue;
      store.createProperty({
        databaseId: leadsDb.id,
        name: prop.name,
        type: prop.type,
        config: prop.config ?? null,
        hidden: false,
      });
    }
  }
}

function _ensureDb(
  store: DatabasesStore,
  tpl: { name: string; icon: string; description: string; properties: TemplateProperty[] },
): void {
  const existing = store.listDatabases().find((d) => d.name === tpl.name && d.source === "native");
  if (existing) return;

  store.createDatabase({
    name: tpl.name,
    icon: tpl.icon,
    description: tpl.description,
    source: "native",
    properties: tpl.properties,
  });
}
