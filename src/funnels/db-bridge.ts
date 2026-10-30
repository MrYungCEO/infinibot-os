/**
 * Funnel Leads ↔ Notion-style Databases bridge.
 *
 * Each business gets one shared "Leads" database in `/databases` (the
 * Notion-style row store). Every funnel lead in that business mirrors
 * to one row, keyed by the lead id. Two-way conceptually:
 *
 *   • **Funnel → DB** (this module's `upsertLeadRow`): called from
 *     `intake.ts` when a new lead lands, and from any later
 *     `funnels.lead.update` so the row stays fresh.
 *   • **DB → Funnel**: a future `database_rows.update` watcher would
 *     diff and call `funnels.lead.update`. Not wired yet — for now the
 *     funnel store is the source of truth and the row is a denormalized
 *     view for cross-tab queries (the agent reads it, the clients page
 *     can show it next to non-funnel clients, etc.).
 *
 * The bridge uses `externalRef` on each row so we can find the row
 * later by funnel-lead id without scanning. Property schema is
 * standardized across businesses so the agent's queries are portable.
 */

import { getDatabasesStore } from "../databases/store.js";
import type { PropertyType, PropertyValue } from "../databases/types.js";

// ── Schema constants ────────────────────────────────────────

const LEADS_DB_NAME = "Funnel Leads";

/** Properties every leads-DB has, in display order. Adding here is safe — `ensureLeadsDatabase` only creates missing ones. */
const LEAD_PROPS: Array<{ id: string; name: string; type: PropertyType }> = [
  { id: "name", name: "Name", type: "title" },
  { id: "email", name: "Email", type: "email" },
  { id: "phone", name: "Phone", type: "phone" },
  { id: "company", name: "Company", type: "richText" },
  { id: "stage", name: "Stage", type: "select" },
  { id: "source", name: "Source", type: "select" },
  { id: "score", name: "Score", type: "number" },
  { id: "owner", name: "Owner", type: "person" },
  { id: "funnelId", name: "Funnel", type: "richText" },
  { id: "leadId", name: "Lead id", type: "richText" },
  { id: "createdAt", name: "Created", type: "createdAt" },
  { id: "updatedAt", name: "Updated", type: "updatedAt" },
];

interface MinimalLead {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  stageId: string;
  source: string;
  score?: number | null;
  assignedTo?: string | null;
  businessId: string;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Mirror a funnel lead into the per-business leads database. Idempotent
 * — calling twice with the same lead id updates the same row instead
 * of creating a duplicate. Creates the database if it doesn't exist.
 */
export async function upsertLeadRow(
  stateDir: string,
  businessId: string,
  lead: MinimalLead,
): Promise<{ rowId: string; databaseId: string }> {
  const store = getDatabasesStore(stateDir);
  const databaseId = ensureLeadsDatabase(store, businessId);

  // Look up an existing row by the `leadId` cell so multi-call sync
  // doesn't dupe. The databases store's ExternalRef is locked to Notion
  // only — we use a dedicated cell instead. Linear scan is cheap
  // (typically <1k rows per business).
  const existing = store.listRows(databaseId).find((r) => {
    const v = r.values.leadId;
    return v?.type === "richText" && v.markdown === lead.id;
  });

  const values: Record<string, PropertyValue> = {
    name: { type: "title", text: lead.name },
    email: { type: "email", email: lead.email ?? null },
    phone: { type: "phone", phone: lead.phone ?? null },
    company: { type: "richText", markdown: lead.company ?? "" },
    stage: { type: "select", optionId: lead.stageId },
    source: { type: "select", optionId: lead.source },
    score: { type: "number", value: lead.score ?? null },
    owner: { type: "person", personIds: lead.assignedTo ? [lead.assignedTo] : [] },
    funnelId: { type: "richText", markdown: businessId },
    leadId: { type: "richText", markdown: lead.id },
  };

  const row = store.upsertRow({
    id: existing?.id,
    databaseId,
    title: lead.name,
    values,
  });

  return { rowId: row.id, databaseId };
}

// ── Schema bootstrap ─────────────────────────────────────────

/**
 * Ensure a "Funnel Leads" database exists for this business. Looks up
 * by `meta.businessId === <id>`; creates with the standard schema on
 * first call. Returns the database id.
 *
 * The agent surfaces this DB anywhere "every business needs a leads
 * table" — e.g. the business command center can render its rows next
 * to manually-added clients without caring about the funnel system.
 */
function ensureLeadsDatabase(store: ReturnType<typeof getDatabasesStore>, businessId: string): string {
  const all = store.listDatabases();
  const found = all.find((d) => {
    const meta = d.meta as { businessId?: string; kind?: string } | undefined;
    return meta?.kind === "funnel-leads" && meta?.businessId === businessId;
  });
  if (found) {
    // Sanity check — make sure every standard property is present.
    // Backfills schema additions without disturbing existing rows.
    for (const p of LEAD_PROPS) {
      const existing = store.listProperties(found.id).find((x) => x.id === p.id || x.name === p.name);
      if (!existing) {
        store.createProperty({
          databaseId: found.id,
          id: p.id,
          name: p.name,
          type: p.type,
          config: null,
          hidden: false,
          sortOrder: (LEAD_PROPS.indexOf(p) + 1) * 1000,
        });
      }
    }
    return found.id;
  }
  // First time — create the DB with all standard properties.
  const created = store.createDatabase({
    name: LEADS_DB_NAME,
    icon: "🎯",
    description: "Auto-synced from the Funnels system. One row per lead.",
    source: "native",
    meta: { businessId, kind: "funnel-leads" },
    properties: LEAD_PROPS.map((p) => ({ id: p.id, name: p.name, type: p.type })),
  });
  return created.id;
}
