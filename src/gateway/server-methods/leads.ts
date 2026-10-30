/**
 * Lead Generation Gateway Handlers
 */

import { applySatelliteProxy } from "../../federation/satellite-context.js";
import { getLeadService } from "../../services/lead-generation/index.js";
import type {
  Lead as GenLead,
  LeadSearchParams,
  LeadSource,
  LeadType,
} from "../../services/lead-generation/types.js";
import { getFunnelStore } from "../../funnels/store.js";
import type { Lead as FunnelLead } from "../../funnels/types.js";
import { listRuns as listQualifierRuns } from "../../services/qualifier/store.js";
import type { QualifierResult } from "../../services/qualifier/store.js";
import type { GatewayRequestHandlers } from "./types.js";
import {
  deleteRowForBusinessRole,
  describeBusinessRoleBridge,
  ensureBusinessRoleDatabase,
  getRoleModeForBusiness,
  upsertRowForBusinessRole,
} from "../../databases/system-role-bridge.js";
import { resolveStateDir } from "../../config/paths.js";
import { getDatabasesStore } from "../../databases/store.js";
import { getLeadTemperature } from "../../funnels/ai-engine.js";
import {
  ensureLeadTemperaturePropertyForBusiness,
  findTemperatureProperty,
} from "../../databases/lead-temperature-seed.js";
import type { DatabaseRow, PropertyValue } from "../../databases/types.js";

/** Latest qualifier verdict for one lead — used as a per-lead badge. */
interface LeadVerdict {
  result: QualifierResult;
  note: string;
  completedAt: number | null;
  receivedAt: number;
}

/**
 * Pipeline columns of last resort — used by `leads.pipeline` when no
 * leads database is mapped yet, OR when the mapped database has no
 * status property. Mirrors the closed-loop lifecycle in
 * `src/databases/lead-pipeline-seed.ts` (kept narrower for default UX
 * density — the kanban is still readable without horizontal scroll).
 */
const PIPELINE_COLUMN_FALLBACK: Array<{ id: string; label: string; color: string }> = [
  { id: "new", label: "New", color: "#94a3b8" },
  { id: "raw", label: "Raw", color: "#94a3b8" },
  { id: "enriched", label: "Enriched", color: "#34d399" },
  { id: "qualified", label: "Qualified", color: "#34d399" },
  { id: "queued", label: "Queued", color: "#fbbf24" },
  { id: "contacted", label: "Contacted", color: "#60a5fa" },
  { id: "opened", label: "Opened", color: "#818cf8" },
  { id: "replied", label: "Replied", color: "#34d399" },
  { id: "engaged", label: "Engaged", color: "#10b981" },
  { id: "won", label: "Won", color: "#10b981" },
  { id: "lost", label: "Lost", color: "#ef4444" },
  { id: "disqualified", label: "Disqualified", color: "#f87171" },
];

/**
 * Map a funnel-store Lead to one of three temperature buckets.
 *
 * Primary signal: the explicit qualifier/funnel `score` (0–100). Buckets
 * align with `getLeadTemperature` in src/funnels/ai-engine.ts.
 *
 * Recency-fallback (no score): a lead is "hot" when its status is
 * qualified AND it was contacted within 3 days, "warm" when it had any
 * activity within 7 days, "cold" otherwise. This keeps the dashboard's
 * cold/warm/hot tiles populated for users whose CRM hasn't been
 * AI-scored yet.
 */
function deriveTemperature(row: FunnelLead, now: number): "cold" | "warm" | "hot" {
  if (typeof row.score === "number") return getLeadTemperature(row.score);
  const D = 24 * 60 * 60 * 1000;
  const lastAct = Date.parse(row.lastActivityAt ?? row.lastContactAt ?? row.updatedAt) || 0;
  if (!lastAct) return "cold";
  const ageMs = now - lastAct;
  if (row.status === "qualified" && row.lastContactAt && ageMs <= 3 * D) return "hot";
  if (ageMs <= 7 * D) return "warm";
  return "cold";
}

/**
 * Resolve the businessId for the current request: explicit param wins,
 * otherwise fall back to state/business.json activeBusinessId. Returns null
 * if nothing is configured (handlers can no-op the business-scoped paths).
 */
async function resolveBusinessId(params: Record<string, unknown>): Promise<string | null> {
  if (typeof params.businessId === "string") return params.businessId;
  try {
    const fs = await import("fs");
    const path = await import("path");
    const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
    const file = path.join(stateDir, "business.json");
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
    return raw.activeBusinessId ?? null;
  } catch {
    return null;
  }
}

/**
 * Project a funnel-store Lead row back into the lead-gen Lead shape the
 * leads UI expects. The mirror writes lead-gen fields into custom_fields
 * verbatim, so we reverse the same mapping on read. Anything the funnel
 * store added (timestamps, score, internal status) overrides the cached
 * value because the funnel store is the authoritative version.
 */
function funnelLeadToGenLead(lead: FunnelLead): GenLead {
  const cf = (lead.customFields ?? {}) as Record<string, unknown>;
  const externalId = typeof cf.externalId === "string" ? cf.externalId : lead.id;
  const str = (key: string): string | undefined =>
    typeof cf[key] === "string" ? (cf[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof cf[key] === "number" ? (cf[key] as number) : undefined;
  return {
    id: externalId,
    companyName: lead.company || lead.name || "Untitled",
    website: str("website"),
    industry: str("industry"),
    description: str("description"),
    email: lead.email,
    phone: lead.phone,
    address: str("address"),
    city: str("city"),
    state: str("state"),
    country: str("country"),
    postalCode: str("postalCode"),
    contactName: lead.name,
    contactTitle: lead.title,
    contactEmail: lead.email,
    contactPhone: lead.phone,
    contactLinkedIn: str("linkedInUrl"),
    employeeCount: str("employeeCount"),
    revenue: str("revenue"),
    founded: str("founded"),
    linkedInUrl: str("linkedInUrl"),
    facebookUrl: str("facebookUrl"),
    twitterUrl: str("twitterUrl"),
    instagramUrl: str("instagramUrl"),
    rating: num("rating"),
    reviewCount: num("reviewCount"),
    type: (str("type") as GenLead["type"]) ?? "business",
    source: (lead.source as GenLead["source"]) ?? "manual",
    status: (lead.status as GenLead["status"]) ?? "new",
    quality: (str("quality") as GenLead["quality"]) ?? "unknown",
    tags: lead.tags ?? [],
    scrapedAt: new Date(lead.createdAt).getTime(),
    lastUpdated: new Date(lead.updatedAt).getTime(),
    notionPageId: str("notionPageId"),
    notes: str("notes"),
    // Carry the funnel store's lead id under a stable key so the UI can
    // round-trip back for activity-timeline / stage-history lookups.
    rawData: { funnelLeadId: lead.id, funnelId: lead.funnelId, stageId: lead.stageId },
  };
}

/**
 * Build a map of leadId → latest qualifier verdict for one business by
 * walking the qualifier runs file. Used to decorate lead rows with a
 * "Qualified / Unqualified" badge so the inbox shows verdict context
 * without the user having to drill into the qualifier audit log.
 */
function latestVerdictsByLead(businessId: string): Map<string, LeadVerdict> {
  const out = new Map<string, LeadVerdict>();
  try {
    const runs = listQualifierRuns(businessId);
    // `listQualifierRuns` returns newest-first, so the first hit per leadId
    // is the latest. Skip runs that didn't land in CRM (no leadId).
    for (const run of runs) {
      if (!run.leadId) continue;
      if (out.has(run.leadId)) continue;
      out.set(run.leadId, {
        result: run.result,
        note: run.note,
        completedAt: run.completedAt,
        receivedAt: run.receivedAt,
      });
    }
  } catch {
    // Qualifier file missing or malformed — fine, just return empty map.
  }
  return out;
}

/**
 * Mirror lead-generator results into the canonical funnel store so the leads
 * a user discovers via search become permanent CRM records (not just an
 * in-memory cache). Each lead is routed to the business's auto-created
 * "Inbox" funnel and dedup'd by external id / email / phone — re-running
 * the same search doesn't spawn duplicates.
 *
 * Failures are swallowed: the lead-gen search itself must keep working
 * even when the funnel store is unavailable. We surface a warning so the
 * gap is visible in logs.
 */
/**
 * Mirror leads to the per-business leads database (db_rows). This is the
 * "single source of truth" path for the lead RECORD — funnels.db still
 * owns the stage/funnel relationships and activity timeline, but the flat
 * lead data (name/email/phone/company/score/etc) is now also in db_rows
 * so the /databases tab + Notion sync + agent tools converge on the same
 * rows.
 *
 * Idempotent: rows are keyed by the lead's id, so re-running this for the
 * same lead just updates the row in place.
 */
function mirrorLeadsToDatabaseRows(leads: GenLead[] | undefined, businessId: string | null): void {
  if (!businessId || !leads || leads.length === 0) return;
  try {
    // Ensure the per-business leads database exists. The bridge auto-
    // creates it the first time we touch it.
    ensureBusinessRoleDatabase(
      businessId,
      "leads",
      `Leads`,
      "Per-business leads — mirrored from the funnel store so Notion sync and the /databases tab see the same rows.",
    );
    for (const lead of leads) {
      try {
        const title = lead.contactName || lead.companyName || lead.id;
        const values: Record<string, unknown> = {
          source: lead.source,
          status: lead.status,
          quality: lead.quality,
          type: lead.type,
          email: lead.contactEmail || lead.email,
          phone: lead.contactPhone || lead.phone,
          company: lead.companyName,
          contactName: lead.contactName,
          contactTitle: lead.contactTitle,
          website: lead.website,
          industry: lead.industry,
          rating: lead.rating,
          reviewCount: lead.reviewCount,
          employeeCount: lead.employeeCount,
          linkedInUrl: lead.linkedInUrl,
          address: lead.address,
          city: lead.city,
          state: lead.state,
          country: lead.country,
          tags: lead.tags,
          lastUpdated: lead.lastUpdated,
        };
        upsertRowForBusinessRole("leads", businessId, {
          id: lead.id,
          title,
          values: values as Record<string, import("../../databases/types.js").PropertyValue>,
        });
      } catch (perLeadErr) {
        console.warn(
          `[leads] db-row mirror failed for ${lead.id}:`,
          perLeadErr instanceof Error ? perLeadErr.message : String(perLeadErr),
        );
      }
    }
  } catch (err) {
    console.warn(
      "[leads] db-row mirror unavailable:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function unmirrorLeadFromDatabaseRows(leadId: string, businessId: string | null): void {
  if (!businessId || !leadId) return;
  try {
    deleteRowForBusinessRole("leads", businessId, leadId);
  } catch {
    /* mirror is best-effort; never block the delete */
  }
}

function mirrorLeadsToFunnelStore(leads: GenLead[] | undefined, businessId: string | null): void {
  if (!businessId || !leads || leads.length === 0) return;
  try {
    const store = getFunnelStore();
    for (const lead of leads) {
      try {
        store.upsertLeadFromExternal({
          businessId,
          externalId: lead.id,
          source: lead.source,
          name: lead.contactName || lead.companyName,
          company: lead.companyName,
          title: lead.contactTitle,
          email: lead.contactEmail || lead.email,
          phone: lead.contactPhone || lead.phone,
          tags: lead.tags,
          metadata: {
            website: lead.website,
            industry: lead.industry,
            address: lead.address,
            city: lead.city,
            state: lead.state,
            country: lead.country,
            rating: lead.rating,
            reviewCount: lead.reviewCount,
            quality: lead.quality,
            employeeCount: lead.employeeCount,
            linkedInUrl: lead.linkedInUrl,
          },
        });
      } catch (perLeadErr) {
        console.warn(
          `[leads] mirror upsert failed for ${lead.id}:`,
          perLeadErr instanceof Error ? perLeadErr.message : String(perLeadErr),
        );
      }
    }
  } catch (err) {
    console.warn(
      "[leads] funnel-store mirror unavailable:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Lead-status clients: Clients-role rows whose status property contains
// a lead-like keyword (lead, prospect, cold, warm, hot, qualified,
// unqualified). Surfaced on the unified Lead Dashboard so a single page
// shows every prospect regardless of whether the row lives in the Leads
// DB or the Clients DB.
// ─────────────────────────────────────────────────────────────────────

const LEAD_LIKE_STATUS_KEYWORDS: ReadonlyArray<string> = [
  "lead",
  "prospect",
  "cold",
  "warm",
  "hot",
  "qualified",
  "unqualified",
];

interface LeadStatusClientRow {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  website?: string;
  lifecycleStatus: string;
  temperature: "cold" | "warm" | "hot" | null;
  createdAt: number;
  updatedAt: number;
  source: "clients";
  rawRow: DatabaseRow;
}

function _resolveStatusOptionName(
  row: DatabaseRow,
  props: ReturnType<ReturnType<typeof getDatabasesStore>["listProperties"]>,
): { propertyName: string; value: string } | null {
  const statusProp = props.find(
    (p) =>
      (p.type === "select" || p.type === "status") &&
      /(^|[^a-z])status($|[^a-z])|^lifecycle|^stage$/i.test(p.name),
  );
  if (!statusProp) return null;
  const v = row.values?.[statusProp.id];
  if (!v || typeof v !== "object" || !("optionId" in v)) return null;
  const optionId = (v as { optionId: string | null }).optionId;
  if (!optionId) return null;
  const opt = (statusProp.config?.options ?? []).find((o) => o.id === optionId);
  return { propertyName: statusProp.name, value: opt?.name ?? optionId };
}

function _statusValueIsLeadLike(status: string | null | undefined): boolean {
  if (!status) return true; // empty status counts as lead-like
  const lc = status.toLowerCase();
  return LEAD_LIKE_STATUS_KEYWORDS.some((kw) => lc.includes(kw));
}

function _temperatureFromOptionName(
  status: string | null,
  temperatureValue: string | null,
): "cold" | "warm" | "hot" | null {
  const candidate = (temperatureValue ?? status ?? "").toLowerCase();
  if (candidate.includes("hot")) return "hot";
  if (candidate.includes("warm")) return "warm";
  if (candidate.includes("cold")) return "cold";
  return null;
}

function _readTemperatureValue(
  row: DatabaseRow,
  props: ReturnType<ReturnType<typeof getDatabasesStore>["listProperties"]>,
): string | null {
  const tempProp = props.find((p) => /^lead[\s_-]?temperature$|^temperature$|^heat$/i.test(p.name));
  if (!tempProp) return null;
  const v = row.values?.[tempProp.id];
  if (!v || typeof v !== "object" || !("optionId" in v)) return null;
  const optionId = (v as { optionId: string | null }).optionId;
  if (!optionId) return null;
  const opt = (tempProp.config?.options ?? []).find((o) => o.id === optionId);
  return opt?.name ?? optionId;
}

/**
 * Walk the Clients-role database for the active business and return rows
 * whose status looks lead-like (or is empty). Honors the user's actual
 * status options — never hardcodes a set.
 */
function listLeadStatusClients(businessId: string | null): LeadStatusClientRow[] {
  if (!businessId) return [];
  try {
    const resolved = getRoleModeForBusiness("clients", businessId);
    if (resolved.mode !== "database" || !resolved.databaseId) return [];
    const store = getDatabasesStore();
    const props = store.listProperties(resolved.databaseId);
    const rows = resolved.perBusiness
      ? store.listRows(resolved.databaseId)
      : store.listRows(resolved.databaseId, { businessId });

    const out: LeadStatusClientRow[] = [];
    for (const row of rows) {
      const status = _resolveStatusOptionName(row, props);
      const statusValue = status?.value ?? null;
      if (!_statusValueIsLeadLike(statusValue)) continue;

      const tempValue = _readTemperatureValue(row, props);
      const temperature = _temperatureFromOptionName(statusValue, tempValue);

      // Best-effort projection of common contact fields by property name.
      const findVal = (re: RegExp): string | undefined => {
        const prop = props.find((p) => re.test(p.name));
        if (!prop) return undefined;
        const v = row.values?.[prop.id];
        if (!v || typeof v !== "object") return undefined;
        const obj = v as Record<string, unknown>;
        if (typeof obj.email === "string") return obj.email;
        if (typeof obj.phone === "string") return obj.phone;
        if (typeof obj.url === "string") return obj.url;
        if (typeof obj.text === "string") return obj.text;
        if (typeof obj.markdown === "string") return obj.markdown;
        return undefined;
      };

      out.push({
        id: row.id,
        name: row.title || "Untitled",
        company: findVal(/^company$/i),
        email: findVal(/^email$/i),
        phone: findVal(/^phone$/i),
        website: findVal(/^website$|^url$|^site$/i),
        lifecycleStatus: statusValue ?? "uncategorized",
        temperature,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        source: "clients",
        rawRow: row,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Write a row's Temperature option. Looks up the canonical Temperature
 * property on the mapped role database; idempotently ensures one exists
 * via the per-business seed if not. Returns the option name that was
 * persisted, or null if no temperature property could be resolved.
 */
function writeTemperatureForRow(args: {
  businessId: string;
  role: "leads" | "clients";
  rowId: string;
  value: "cold" | "warm" | "hot";
}): { ok: boolean; propertyName: string | null; optionId: string | null } {
  const { businessId, role, rowId, value } = args;
  const resolved = getRoleModeForBusiness(role, businessId);
  if (resolved.mode !== "database" || !resolved.databaseId) {
    return { ok: false, propertyName: null, optionId: null };
  }
  const store = getDatabasesStore();
  // Ensure a temperature property exists (creates one on first write).
  ensureLeadTemperaturePropertyForBusiness(store, businessId);

  const found = findTemperatureProperty(store, resolved.databaseId);
  if (!found) return { ok: false, propertyName: null, optionId: null };

  const optionId = found.canonicalOptionIds[value];
  const opt = (found.property.config?.options ?? []).find((o) => o.id === optionId);
  if (!opt) return { ok: false, propertyName: found.property.name, optionId: null };

  const row = store.getRow(rowId);
  if (!row) return { ok: false, propertyName: found.property.name, optionId };

  const nextValues = { ...row.values } as Record<string, PropertyValue>;
  const valShape: PropertyValue =
    found.property.type === "status" ? { type: "status", optionId } : { type: "select", optionId };
  nextValues[found.property.id] = valShape;
  // Stamp a manual-set timestamp so auto-bump from stage changes can
  // back off for 24h.
  nextValues["__temperature_manually_set_at"] = {
    type: "number",
    value: Date.now(),
  } as unknown as PropertyValue;

  store.upsertRow({
    id: row.id,
    databaseId: row.databaseId,
    title: row.title,
    body: row.body,
    values: nextValues,
    businessId: row.businessId,
    externalRef: row.externalRef,
  });
  return { ok: true, propertyName: found.property.name, optionId };
}

/**
 * Infer the temperature implied by a stage transition. Returns null when
 * the stage doesn't carry strong-enough signal to bump temperature.
 */
function temperatureFromStage(stage: string): "cold" | "warm" | "hot" | null {
  const s = stage.toLowerCase();
  if (s.includes("hot")) return "hot";
  if (s.includes("won") || s.includes("engaged") || s.includes("meeting")) return "hot";
  if (s.includes("warm")) return "warm";
  if (s.includes("qualified") || s.includes("replied") || s.includes("contacted")) return "warm";
  if (s.includes("cold")) return "cold";
  if (s.includes("lost") || s.includes("dead") || s.includes("unresponsive")) return "cold";
  return null;
}

/**
 * Read the manual-set timestamp if any, used to back off auto-bumps for
 * 24h after a user explicitly sets temperature.
 */
function getManualTemperatureAt(row: DatabaseRow | null): number {
  if (!row) return 0;
  const v = row.values?.["__temperature_manually_set_at"];
  if (!v || typeof v !== "object") return 0;
  const obj = v as { value?: unknown };
  return typeof obj.value === "number" ? obj.value : 0;
}

const _rawLeadHandlers: GatewayRequestHandlers = {
  /**
   * Search for leads
   * @param params.query - Search query (business name, industry, etc.)
   * @param params.location - Location to search in
   * @param params.type - Lead type (business, b2b, agency, etc.)
   * @param params.sources - Specific sources to use
   * @param params.limit - Max results
   * @param params.minRating - Minimum rating filter
   * @param params.hasEmail - Filter for leads with email
   * @param params.hasPhone - Filter for leads with phone
   */
  "leads.search": async ({ params, respond }) => {
    try {
      const searchParams: LeadSearchParams = {
        query: params.query as string,
        location: params.location as string | undefined,
        type: params.type as LeadType | undefined,
        industry: params.industry as string | undefined,
        sources: params.sources as LeadSource[] | undefined,
        limit: typeof params.limit === "number" ? params.limit : 20,
        offset: typeof params.offset === "number" ? params.offset : 0,
        minRating: params.minRating as number | undefined,
        minReviews: params.minReviews as number | undefined,
        hasEmail: params.hasEmail as boolean | undefined,
        hasPhone: params.hasPhone as boolean | undefined,
        hasWebsite: params.hasWebsite as boolean | undefined,
      };

      if (!searchParams.query) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "query is required" });
        return;
      }

      // Resolve a businessId for scoping — explicit param wins, otherwise
      // fall back to the current activeBusinessId from state/business.json
      // so callers don't have to thread it through from the UI on every call.
      const explicitBusinessId = typeof params.businessId === "string" ? params.businessId : null;
      let businessId: string | null = explicitBusinessId;
      if (!businessId) {
        try {
          const fs = await import("fs");
          const path = await import("path");
          const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
          const file = path.join(stateDir, "business.json");
          if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
            businessId = raw.activeBusinessId ?? null;
          }
        } catch {
          /* state file unreadable — fall through with null */
        }
      }

      const service = getLeadService();
      // Annotate the search context so caching / rate-limiting can scope
      // to a business. The service may ignore unknown fields safely.
      const result = await service.search({ ...searchParams, businessId } as LeadSearchParams);

      // Persist every result into the canonical funnel store inbox so it
      // becomes a real CRM lead (not just an ephemeral search hit).
      mirrorLeadsToFunnelStore(result.leads, businessId);

      respond(
        true,
        {
          leads: result.leads,
          total: result.total,
          source: result.source,
          cached: result.cached,
          errors: result.errors,
          businessId,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Search using a specific source
   */
  "leads.searchWithSource": async ({ params, respond }) => {
    try {
      const source = params.source as LeadSource;
      const searchParams: LeadSearchParams = {
        query: params.query as string,
        location: params.location as string | undefined,
        type: params.type as LeadType | undefined,
        industry: params.industry as string | undefined,
        limit: typeof params.limit === "number" ? params.limit : 20,
        offset: typeof params.offset === "number" ? params.offset : 0,
      };

      if (!source) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "source is required" });
        return;
      }
      if (!searchParams.query) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "query is required" });
        return;
      }

      const service = getLeadService();
      const result = await service.searchWithSource(source, searchParams);

      // Resolve the active business so source-scoped searches also mirror
      // into the canonical funnel store. Without this, leads found via a
      // specific source path skip CRM persistence entirely.
      let businessId: string | null =
        typeof params.businessId === "string" ? params.businessId : null;
      if (!businessId) {
        try {
          const fs = await import("fs");
          const path = await import("path");
          const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
          const file = path.join(stateDir, "business.json");
          if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
            businessId = raw.activeBusinessId ?? null;
          }
        } catch {
          /* state file unreadable */
        }
      }
      mirrorLeadsToFunnelStore(result.leads, businessId);

      respond(
        true,
        {
          leads: result.leads,
          total: result.total,
          source: result.source,
          cached: result.cached,
          errors: result.errors,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Get a single lead by ID
   */
  "leads.get": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const service = getLeadService();
      let lead: GenLead | undefined = service.getLead(id);

      // Fall back to the funnel store for historical leads that aren't in
      // the in-memory cache anymore (e.g. discovered in a previous session).
      // The lead id may be either the lead-gen external id (stored on the
      // funnel row's customFields.externalId) or the funnel row's own id.
      if (!lead) {
        const businessId = await resolveBusinessId(params);
        if (businessId) {
          try {
            const store = getFunnelStore();
            const allRows = store.listLeads({ businessId });
            const match = allRows.find((row) => {
              if (row.id === id) return true;
              const cf = (row.customFields ?? {}) as { externalId?: unknown };
              return cf.externalId === id;
            });
            if (match) lead = funnelLeadToGenLead(match);
          } catch {
            /* funnel store unavailable — fall through to 404 */
          }
        }
      }

      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Attach the latest qualifier verdict so the detail view shows it
      // without an extra round-trip to the qualifier RPCs.
      const businessId = await resolveBusinessId(params);
      let verdict: LeadVerdict | null = null;
      if (businessId) {
        const verdicts = latestVerdictsByLead(businessId);
        const funnelId =
          (lead.rawData as { funnelLeadId?: string } | undefined)?.funnelLeadId ?? lead.id;
        verdict = verdicts.get(funnelId) ?? null;
      }

      respond(true, { lead: { ...lead, qualifierVerdict: verdict } }, undefined);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * List leads — merges the in-memory lead-gen cache (current session
   * search results) with the canonical funnel store (every historical
   * lead ever discovered, qualified, or imported). Optionally decorates
   * each lead with the latest qualifier verdict so the inbox is a single
   * source of truth instead of forcing the user to flip between three
   * separate views.
   *
   * Dedup: funnel-store rows store the lead-gen id in customFields.externalId,
   * so we project funnel rows back into the gen-Lead shape and prefer the
   * in-memory copy when the same id appears in both.
   */
  "leads.list": async ({ params, respond }) => {
    try {
      const service = getLeadService();
      const inMemory = service.getAllLeads();
      const businessId = await resolveBusinessId(params);

      // Historical: pull every non-archived lead for this business from
      // the funnel store and project back to the gen-Lead shape.
      const historical: GenLead[] = [];
      if (businessId) {
        try {
          const funnelRows = getFunnelStore().listLeads({ businessId });
          for (const row of funnelRows) historical.push(funnelLeadToGenLead(row));
        } catch (storeErr) {
          console.warn(
            "[leads] funnel-store list failed:",
            storeErr instanceof Error ? storeErr.message : String(storeErr),
          );
        }
      }

      // Merge — in-memory wins for matching ids (it's freshest within the
      // current session). Anything in funnel-store-only is purely historical.
      const byId = new Map<string, GenLead>();
      for (const l of historical) byId.set(l.id, l);
      for (const l of inMemory) byId.set(l.id, l);
      let merged = Array.from(byId.values());

      // Verdict join: attach the latest qualifier verdict by lead id so
      // each row carries its "Qualified" / "Unqualified" / null badge.
      // Qualifier runs are keyed by the funnel-store lead id (not the
      // external/gen id), so we look up the funnel id from rawData.
      let verdictRows: Array<GenLead & { qualifierVerdict?: LeadVerdict | null }> = merged;
      if (businessId) {
        const verdicts = latestVerdictsByLead(businessId);
        if (verdicts.size > 0) {
          verdictRows = merged.map((l) => {
            const funnelId =
              (l.rawData as { funnelLeadId?: string } | undefined)?.funnelLeadId ?? l.id;
            const v = verdicts.get(funnelId) ?? null;
            return { ...l, qualifierVerdict: v };
          });
        }
      }

      // Apply filters
      let filtered = verdictRows;
      if (params.status) {
        filtered = filtered.filter((l) => l.status === params.status);
      }
      if (params.quality) {
        filtered = filtered.filter((l) => l.quality === params.quality);
      }
      if (params.type) {
        filtered = filtered.filter((l) => l.type === params.type);
      }
      if (params.source) {
        filtered = filtered.filter((l) => l.source === params.source);
      }
      // New verdict filter so the UI can hide non-qualified rows.
      if (params.qualifierVerdict) {
        filtered = filtered.filter((l) => l.qualifierVerdict?.result === params.qualifierVerdict);
      }

      // Sort newest-first so a fresh search/import floats to the top.
      filtered.sort((a, b) => (b.lastUpdated ?? 0) - (a.lastUpdated ?? 0));

      // Optional merge: surface Clients-role rows whose status is
      // lead-like (lead/prospect/cold/warm/hot/qualified/etc.) so the
      // unified Lead Dashboard shows EVERY prospect regardless of which
      // database holds the row. Off by default to preserve historical
      // callers; the dashboard opts in explicitly.
      const includeLeadStatusClients = params.includeLeadStatusClients === true;
      type EnrichedRow = GenLead & {
        qualifierVerdict?: LeadVerdict | null;
        origin?: "leads" | "clients";
      };
      const taggedLeads: EnrichedRow[] = (filtered as EnrichedRow[]).map((l) => ({
        ...l,
        origin: "leads" as const,
      }));
      let mergedAll: EnrichedRow[] = taggedLeads;
      let leadStatusClientCount = 0;
      if (includeLeadStatusClients) {
        const clients = listLeadStatusClients(businessId);
        leadStatusClientCount = clients.length;
        for (const c of clients) {
          // Project a client row into the GenLead shape so the existing
          // UI list renderer can consume it without a new code path.
          mergedAll.push({
            id: `client:${c.id}`,
            companyName: c.company ?? c.name,
            contactName: c.name,
            email: c.email,
            phone: c.phone,
            contactEmail: c.email,
            contactPhone: c.phone,
            website: c.website,
            status: (c.lifecycleStatus as GenLead["status"]) ?? "new",
            quality: "unknown",
            type: "business",
            source: "manual",
            tags: [],
            scrapedAt: c.createdAt,
            lastUpdated: c.updatedAt,
            origin: "clients",
          } as EnrichedRow);
        }
        mergedAll.sort((a, b) => (b.lastUpdated ?? 0) - (a.lastUpdated ?? 0));
      }

      // Pagination
      const offset = typeof params.offset === "number" ? params.offset : 0;
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const paginated = mergedAll.slice(offset, offset + limit);

      respond(
        true,
        {
          leads: paginated,
          total: mergedAll.length,
          offset,
          limit,
          businessId,
          leadStatusClientCount,
          includeLeadStatusClients,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Update a lead
   */
  "leads.update": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const updates = params.updates as Record<string, any>;
      if (!updates || typeof updates !== "object") {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "updates object is required",
        });
        return;
      }

      const service = getLeadService();
      const updated = service.updateLead(id, updates);

      if (!updated) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      // Mirror the edit into the canonical funnel store so the CRM view
      // reflects the latest field values. Resolves businessId the same way
      // search does (explicit param or active business in state/business.json).
      let businessId: string | null =
        typeof params.businessId === "string" ? params.businessId : null;
      if (!businessId) {
        try {
          const fs = await import("fs");
          const path = await import("path");
          const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
          const file = path.join(stateDir, "business.json");
          if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
            businessId = raw.activeBusinessId ?? null;
          }
        } catch {
          /* state file unreadable */
        }
      }
      mirrorLeadsToFunnelStore([updated], businessId);
      mirrorLeadsToDatabaseRows([updated], businessId);

      respond(true, { lead: updated }, undefined);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Delete a lead
   */
  "leads.delete": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const service = getLeadService();
      const deleted = service.deleteLead(id);

      // Unmirror from the per-business leads database. We try the
      // explicit param first, then the active business — best-effort,
      // never block the delete on the mirror failing.
      let businessId: string | null =
        typeof params.businessId === "string" ? params.businessId : null;
      if (!businessId) {
        try {
          const fs = await import("fs");
          const path = await import("path");
          const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
          const file = path.join(stateDir, "business.json");
          if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
            businessId = raw.activeBusinessId ?? null;
          }
        } catch {
          /* ignore */
        }
      }
      unmirrorLeadFromDatabaseRows(id, businessId);

      respond(true, { deleted }, undefined);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Save lead to the CRM (local clients; Notion mirrored when connected)
   */
  "leads.saveToCRM": async ({ params, respond }) => {
    try {
      const id = params.id as string;
      const databaseId = (params.databaseId as string | undefined) || null;
      const businessId = (params.businessId as string | undefined) || null;

      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      // databaseId (a Notion CRM) is optional — the lead always lands in the
      // local CRM; Notion is mirrored in the background when connected.

      const service = getLeadService();
      const lead = service.getLead(id);

      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      const result = await service.saveLeadToCRM({
        lead,
        databaseId,
        businessId,
        mapping: params.mapping as Record<string, string> | undefined,
        updateIfExists: params.updateIfExists !== false,
      });

      respond(
        true,
        {
          clientId: result.clientId,
          notionPageId: result.notionPageId,
          notionSync: result.notionSync,
          lead,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Bulk save leads to CRM
   */
  "leads.bulkSaveToCRM": async ({ params, respond }) => {
    try {
      const ids = params.ids as string[];
      const databaseId = (params.databaseId as string | undefined) || null;
      const businessId = (params.businessId as string | undefined) || null;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "ids array is required" });
        return;
      }
      const service = getLeadService();
      const leads = ids
        .map((id) => service.getLead(id))
        .filter((l): l is NonNullable<typeof l> => !!l);

      const result = await service.bulkSaveToCRM(leads, databaseId, businessId);

      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Get available sources and their status
   */
  "leads.sources": async ({ respond }) => {
    try {
      const service = getLeadService();
      const sources = service.getAvailableSources();
      respond(true, { sources }, undefined);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Get scraper statistics + dashboard rollups (temperature, lifecycle stage,
   * last-7-day activity, conversion funnel). The temperature axis derives
   * from each lead's qualifier/funnel score when present, otherwise from
   * recency of activity (cold = no activity 14d+, warm = activity within 7d,
   * hot = qualified + contacted within 3d).
   */
  "leads.stats": async ({ params, respond }) => {
    try {
      const service = getLeadService();
      const stats = service.getStats();

      // Roll up everything we need for the dashboard hero tiles.
      // Pulls from the funnel store (authoritative per-business CRM) so
      // counts always match what the pipeline/CRM tabs show — even if the
      // user wired a Notion or wizard DB, those still mirror into the
      // funnel store via mirrorLeadsToFunnelStore.
      const businessId = await resolveBusinessId(params ?? {});
      // Default to including lead-status clients on the dashboard call;
      // legacy callers (no param) get the merged view too because the
      // unified counts are the authoritative ones now.
      const includeLeadStatusClients = params?.includeLeadStatusClients !== false;
      let total = 0;
      let temperature = { cold: 0, warm: 0, hot: 0 };
      let lifecycle: Record<string, number> = {};
      let activity = { last7d: 0, last24h: 0 };
      let funnel = { qualified: 0, contacted: 0, replied: 0, won: 0, lost: 0 };
      let leadStatusClientCount = 0;
      if (businessId) {
        try {
          const rows = getFunnelStore().listLeads({ businessId });
          total = rows.length;
          const now = Date.now();
          const D = 24 * 60 * 60 * 1000;
          for (const row of rows) {
            // Temperature: score-based when available, recency-based otherwise.
            const t = deriveTemperature(row, now);
            temperature[t] += 1;

            const status = row.status ?? "unknown";
            lifecycle[status] = (lifecycle[status] ?? 0) + 1;

            const updated = Date.parse(row.updatedAt) || 0;
            const lastAct = Date.parse(row.lastActivityAt ?? row.updatedAt) || updated;
            if (now - lastAct <= 7 * D) activity.last7d += 1;
            if (now - lastAct <= 1 * D) activity.last24h += 1;

            if (row.status === "qualified") funnel.qualified += 1;
            if (row.lastContactAt) funnel.contacted += 1;
            if (row.status === "won") funnel.won += 1;
            if (row.status === "lost") funnel.lost += 1;
          }
          // "replied" is tracked on the lead-pipeline-seed DB row but not on
          // the funnel-store Lead — approximate via activity-type scan.
          // Cheap because the funnel store keeps activities small per lead.
          try {
            const store = getFunnelStore();
            for (const row of rows) {
              const acts = store.getLeadActivities(row.id);
              if (acts.some((a) => a.type === "email" && /repl(y|ied)/i.test(a.description))) {
                funnel.replied += 1;
              }
            }
          } catch {
            /* activities table missing — skip replied count */
          }
        } catch {
          /* funnel store unavailable — return zeros */
        }

        // ── Merge in Clients-role rows with a lead-like status ───────
        // These show up on the Lead Dashboard so a single page reflects
        // every prospect, regardless of which database they're stored in.
        if (includeLeadStatusClients) {
          try {
            const clients = listLeadStatusClients(businessId);
            const now = Date.now();
            const D = 24 * 60 * 60 * 1000;
            for (const c of clients) {
              total += 1;
              leadStatusClientCount += 1;
              const t = c.temperature ?? "cold";
              temperature[t] += 1;
              const status = c.lifecycleStatus ?? "uncategorized";
              lifecycle[status] = (lifecycle[status] ?? 0) + 1;
              const lastAct = c.updatedAt || c.createdAt;
              if (now - lastAct <= 7 * D) activity.last7d += 1;
              if (now - lastAct <= 1 * D) activity.last24h += 1;
              const lc = status.toLowerCase();
              if (lc.includes("qualified") && !lc.includes("un")) funnel.qualified += 1;
              if (lc.includes("contacted")) funnel.contacted += 1;
            }
          } catch {
            /* clients merge is best-effort */
          }
        }
      }

      respond(
        true,
        {
          stats,
          total,
          temperature,
          lifecycle,
          activity,
          funnel,
          businessId,
          leadStatusClientCount,
          includeLeadStatusClients,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Pipeline view — returns leads + the columns to render them under,
   * derived from the active leads database's status/lifecycle property
   * options (NOT a hard-coded list).
   *
   * Source priority:
   *   1. Per-business mapped leads DB (`db_rows`) via system-role-bridge
   *      — works for Notion imports + wizard-mapped DBs + the default
   *      business-template seed.
   *   2. Fallback: project funnel-store leads with the seed lifecycle
   *      columns (PIPELINE_COLUMN_FALLBACK below). This keeps the view
   *      functional even when no database is mapped yet.
   *
   * `groupBy` switches the column axis:
   *   - "stage" (default): one column per Status/LifecycleStatus option.
   *   - "temperature": three columns (cold/warm/hot) derived from score
   *     or activity recency.
   */
  "leads.pipeline": async ({ params, respond }) => {
    try {
      const businessId = await resolveBusinessId(params ?? {});
      const groupBy = params?.groupBy === "temperature" ? "temperature" : "stage";

      // ── Resolve column source: mapped DB property options OR fallback. ──
      let columns: Array<{ id: string; label: string; color: string }> = [];
      let columnsSource: "mapped" | "fallback" | "temperature" = "fallback";
      let mappedDatabaseId: string | null = null;
      let statusPropertyId: string | null = null;
      let statusPropertyName: string | null = null;

      if (groupBy === "temperature") {
        columns = [
          { id: "cold", label: "Cold", color: "#60a5fa" },
          { id: "warm", label: "Warm", color: "#fbbf24" },
          { id: "hot", label: "Hot", color: "#ef4444" },
        ];
        columnsSource = "temperature";
      } else if (businessId) {
        const resolved = getRoleModeForBusiness("leads", businessId);
        if (resolved.mode === "database" && resolved.databaseId) {
          mappedDatabaseId = resolved.databaseId;
          const store = getDatabasesStore();
          const props = store.listProperties(resolved.databaseId);
          // Pick the user's status property by name (case-insensitive),
          // preferring richer names over plain "Status" so a custom
          // "LifecycleStatus" wins over a generic "Status" if both exist.
          const statusProp =
            props.find((p) => /lifecycle.*status/i.test(p.name)) ||
            props.find((p) => p.type === "select" && /status/i.test(p.name)) ||
            props.find((p) => p.type === "status") ||
            props.find((p) => p.type === "select");
          if (statusProp) {
            statusPropertyId = statusProp.id;
            statusPropertyName = statusProp.name;
            const options = statusProp.config?.options ?? [];
            if (options.length > 0) {
              // Guard: if the mapped DB was seeded from the generic kanban
              // template (todo/in_progress/done) and has no lifecycle IDs,
              // discard those options and fall through to PIPELINE_COLUMN_FALLBACK.
              // This fixes installs where the business-role Leads DB was
              // auto-created with kanban defaults instead of the lead lifecycle.
              const GENERIC_KANBAN_IDS = new Set([
                "todo",
                "in_progress",
                "done",
                "not_started",
                "completed",
                "review",
                "in-progress",
                "paused",
                "cancelled",
              ]);
              const LIFECYCLE_IDS = new Set([
                "raw",
                "enriching",
                "enriched",
                "scoring",
                "qualified",
                "disqualified",
                "queued",
                "contacted",
                "opened",
                "replied",
                "engaged",
                "won",
                "lost",
                "new",
                "bounced",
                "unsubscribed",
                "meeting_booked",
                "needs_review",
                "dead",
              ]);
              const isGenericKanban =
                options.every((o) => GENERIC_KANBAN_IDS.has(o.id)) &&
                !options.some((o) => LIFECYCLE_IDS.has(o.id));
              if (!isGenericKanban) {
                columns = options.map((o) => ({
                  id: o.id,
                  label: o.name,
                  color: o.color ?? "#94a3b8",
                }));
                columnsSource = "mapped";
              }
            }
          }
        }
      }

      if (columns.length === 0 && groupBy === "stage") {
        // Seed columns — kept in sync with src/databases/lead-pipeline-seed.ts
        // so a brand-new install gets the closed-loop lifecycle out of the
        // box without requiring the user to map a DB first.
        columns = PIPELINE_COLUMN_FALLBACK.slice();
        columnsSource = "fallback";
      }

      // ── Build leads list, normalized to a uniform shape. ──
      // Always source from the funnel store for now — mirroring keeps it in
      // sync with the mapped DB, and walking funnel rows lets us project
      // lifecycle status the same way regardless of which DB the user wired.
      // Each row is tagged with an `origin` so the dashboard can render a
      // small badge that says where the row actually lives.
      const includeLeadStatusClients = params?.includeLeadStatusClients !== false;
      // Quarantined leads are hidden from the default pipeline view.
      // Pass includeQuarantined=true to opt in (e.g. for operator review).
      const includeQuarantined = params?.includeQuarantined === true;
      const leads: Array<{
        id: string;
        name: string;
        company?: string;
        email?: string;
        phone?: string;
        website?: string;
        lifecycleStatus: string;
        score?: number;
        temperature: "cold" | "warm" | "hot";
        lastContactedAt?: string;
        lastActivityAt?: string;
        opens: number;
        clicks: number;
        replyCount: number;
        followUpCount: number;
        paused: boolean;
        campaignId?: string;
        createdAt: number;
        updatedAt: number;
        rating?: number;
        reviewCount?: number;
        qualifierScore?: number;
        origin: "leads" | "clients";
      }> = [];

      let leadStatusClientCount = 0;
      // Look up the canonical Temperature property on the mapped leads DB
      // so we can prefer the user-set value over the heuristic derivation.
      let leadsTempProperty: ReturnType<typeof findTemperatureProperty> | null = null;
      if (businessId && mappedDatabaseId) {
        try {
          leadsTempProperty = findTemperatureProperty(getDatabasesStore(), mappedDatabaseId);
        } catch {
          /* fall back to heuristic temperature */
        }
      }
      if (businessId) {
        try {
          const rows = getFunnelStore().listLeads({ businessId });
          const now = Date.now();
          const dbStore = getDatabasesStore();
          for (const row of rows) {
            const cf = (row.customFields ?? {}) as Record<string, unknown>;
            const num = (k: string): number | undefined =>
              typeof cf[k] === "number" ? (cf[k] as number) : undefined;
            const str = (k: string): string | undefined =>
              typeof cf[k] === "string" ? (cf[k] as string) : undefined;
            // Prefer canonical temperature when the mirrored DB row has it set.
            let temperature: "cold" | "warm" | "hot" = deriveTemperature(row, now);
            if (leadsTempProperty) {
              try {
                const externalId = typeof cf.externalId === "string" ? cf.externalId : row.id;
                const dbRow = dbStore.getRow(externalId);
                if (dbRow) {
                  const tv = dbRow.values?.[leadsTempProperty.property.id];
                  if (tv && typeof tv === "object" && "optionId" in tv) {
                    const optId = (tv as { optionId: string | null }).optionId;
                    const opt = (leadsTempProperty.property.config?.options ?? []).find(
                      (o) => o.id === optId,
                    );
                    const name = opt?.name?.toLowerCase() ?? "";
                    if (name.includes("hot")) temperature = "hot";
                    else if (name.includes("warm")) temperature = "warm";
                    else if (name.includes("cold")) temperature = "cold";
                  }
                }
              } catch {
                /* leave heuristic value */
              }
            }
            leads.push({
              id: row.id,
              name: row.name || row.company || "Untitled",
              company: row.company,
              email: row.email,
              phone: row.phone,
              website: str("website"),
              lifecycleStatus: row.status ?? "raw",
              score: row.score ?? undefined,
              temperature,
              lastContactedAt: row.lastContactAt,
              lastActivityAt: row.lastActivityAt,
              opens: num("opens") ?? 0,
              clicks: num("clicks") ?? 0,
              replyCount: num("replyCount") ?? 0,
              followUpCount: num("followUpCount") ?? 0,
              paused: cf.paused === true,
              campaignId: str("campaignId"),
              createdAt: Date.parse(row.createdAt) || Date.now(),
              updatedAt: Date.parse(row.updatedAt) || Date.now(),
              rating: num("rating"),
              reviewCount: num("reviewCount"),
              qualifierScore: row.score ?? undefined,
              origin: "leads",
            });
          }
        } catch {
          /* funnel store unavailable — return empty list */
        }
        if (includeLeadStatusClients) {
          try {
            const clients = listLeadStatusClients(businessId);
            for (const c of clients) {
              leads.push({
                id: `client:${c.id}`,
                name: c.name,
                company: c.company,
                email: c.email,
                phone: c.phone,
                website: c.website,
                lifecycleStatus: c.lifecycleStatus,
                temperature: c.temperature ?? "cold",
                lastContactedAt: undefined,
                lastActivityAt: undefined,
                opens: 0,
                clicks: 0,
                replyCount: 0,
                followUpCount: 0,
                paused: false,
                campaignId: undefined,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
                origin: "clients",
              });
              leadStatusClientCount += 1;
            }
          } catch {
            /* clients merge is best-effort */
          }
        }
      }

      const visibleLeads = includeQuarantined
        ? leads
        : leads.filter((l) => l.lifecycleStatus !== "quarantined");

      respond(
        true,
        {
          leads: visibleLeads,
          columns,
          columnsSource,
          groupBy,
          mappedDatabaseId,
          statusPropertyId,
          statusPropertyName,
          businessId,
          leadStatusClientCount,
          includeLeadStatusClients,
          temperatureCounts: visibleLeads.reduce(
            (acc, l) => {
              acc[l.temperature] += 1;
              return acc;
            },
            { cold: 0, warm: 0, hot: 0 } as Record<"cold" | "warm" | "hot", number>,
          ),
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Update a lead's pipeline stage. Writes through the role-bridge so the
   * change lands in whichever database the user wired (Notion-import,
   * wizard-mapped, or default seed). Also updates the funnel-store status
   * so the legacy UI stays in sync.
   */
  "leads.setStage": async ({ params, respond }) => {
    try {
      const rawId = typeof params?.leadId === "string" ? params.leadId : "";
      const stage = typeof params?.stage === "string" ? params.stage : "";
      if (!rawId || !stage) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "leadId and stage required" });
        return;
      }
      const businessId = await resolveBusinessId(params);
      if (!businessId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "no active business" });
        return;
      }

      // Client-origin rows have the prefix `client:` baked in by
      // leads.pipeline. Route those into the clients database directly.
      if (rawId.startsWith("client:")) {
        const clientRowId = rawId.slice("client:".length);
        try {
          const dbStore = getDatabasesStore();
          const row = dbStore.getRow(clientRowId);
          if (!row) {
            respond(false, undefined, { code: "NOT_FOUND", message: "client row not found" });
            return;
          }
          const resolved = getRoleModeForBusiness("clients", businessId);
          if (!resolved.databaseId) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "clients role unmapped",
            });
            return;
          }
          const props = dbStore.listProperties(resolved.databaseId);
          const statusProp =
            props.find(
              (p) => (p.type === "status" || p.type === "select") && /status/i.test(p.name),
            ) || props.find((p) => p.type === "status");
          if (!statusProp) {
            respond(false, undefined, { code: "INVALID_REQUEST", message: "no status property" });
            return;
          }
          const opt = (statusProp.config?.options ?? []).find(
            (o) => o.id === stage || o.name.toLowerCase() === stage.toLowerCase(),
          );
          if (!opt) {
            respond(false, undefined, {
              code: "INVALID_PARAMS",
              message: "stage not in property options",
            });
            return;
          }
          const nextValues = { ...row.values } as Record<string, PropertyValue>;
          nextValues[statusProp.id] =
            statusProp.type === "status"
              ? { type: "status", optionId: opt.id }
              : { type: "select", optionId: opt.id };
          dbStore.upsertRow({
            id: row.id,
            databaseId: row.databaseId,
            title: row.title,
            body: row.body,
            values: nextValues,
            businessId: row.businessId,
            externalRef: row.externalRef,
          });

          // Auto-bump temperature when the stage implies it AND the user
          // hasn't manually set temperature within the last 24h.
          const implied = temperatureFromStage(stage);
          if (implied) {
            const manualAt = getManualTemperatureAt(row);
            if (Date.now() - manualAt > 24 * 60 * 60 * 1000) {
              writeTemperatureForRow({
                businessId,
                role: "clients",
                rowId: row.id,
                value: implied,
              });
            }
          }
          respond(true, { ok: true, leadId: rawId, stage, origin: "clients" }, undefined);
          return;
        } catch (err) {
          respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
          return;
        }
      }

      // Authoritative write: funnel store row.
      const store = getFunnelStore();
      const lead = store.getLead(rawId);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "lead not found" });
        return;
      }
      store.updateLead(rawId, { status: stage as FunnelLead["status"] });

      // Mirror into the per-business leads database via role-bridge. If the
      // user mapped a Notion DB, bidirectional-sync will propagate this.
      try {
        const cf = (lead.customFields ?? {}) as Record<string, unknown>;
        const externalId = typeof cf.externalId === "string" ? cf.externalId : lead.id;
        const values: Record<string, unknown> = {
          status: stage,
          lastUpdated: Date.now(),
        };
        upsertRowForBusinessRole("leads", businessId, {
          id: externalId,
          title: lead.name || lead.company || externalId,
          values: values as Record<string, import("../../databases/types.js").PropertyValue>,
        });

        // Auto-bump temperature on the leads-DB mirror row too.
        const implied = temperatureFromStage(stage);
        if (implied) {
          const dbStore = getDatabasesStore();
          const dbRow = dbStore.getRow(externalId);
          const manualAt = getManualTemperatureAt(dbRow);
          if (Date.now() - manualAt > 24 * 60 * 60 * 1000) {
            writeTemperatureForRow({
              businessId,
              role: "leads",
              rowId: externalId,
              value: implied,
            });
          }
        }
      } catch {
        /* mirror is best-effort; never block the stage write */
      }

      respond(true, { ok: true, leadId: rawId, stage, origin: "leads" }, undefined);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Write a lead/client row's Temperature option. Supports either a
   * canonical leads row id OR a `client:<rowId>` id originating from the
   * unified pipeline payload. Persists to the row's canonical Temperature
   * property; idempotently seeds the property if it doesn't exist yet.
   */
  "leads.setTemperature": async ({ params, respond }) => {
    try {
      const rawId =
        typeof params?.id === "string"
          ? params.id
          : typeof params?.leadId === "string"
            ? params.leadId
            : "";
      const value = typeof params?.value === "string" ? params.value.toLowerCase() : "";
      if (!rawId || (value !== "cold" && value !== "warm" && value !== "hot")) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "id + value (cold|warm|hot) required",
        });
        return;
      }
      const businessId = await resolveBusinessId(params ?? {});
      if (!businessId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "no active business" });
        return;
      }
      let role: "leads" | "clients" = "leads";
      let rowId = rawId;
      if (rawId.startsWith("client:")) {
        role = "clients";
        rowId = rawId.slice("client:".length);
      } else {
        // Resolve funnel-store lead id → its mirrored leads-DB row id
        // (which is the lead-gen externalId).
        try {
          const store = getFunnelStore();
          const lead = store.getLead(rawId);
          if (lead) {
            const cf = (lead.customFields ?? {}) as Record<string, unknown>;
            const externalId = typeof cf.externalId === "string" ? cf.externalId : lead.id;
            rowId = externalId;
          }
        } catch {
          /* fall through with raw id */
        }
      }

      const result = writeTemperatureForRow({
        businessId,
        role,
        rowId,
        value: value as "cold" | "warm" | "hot",
      });

      respond(
        true,
        {
          ok: result.ok,
          id: rawId,
          role,
          value,
          temperaturePropertyName: result.propertyName,
          optionId: result.optionId,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Lead timeline — one merged chronological feed of everything that
   * happened to a lead: imports, stage transitions, qualifier verdicts,
   * notes, emails, calls, meetings, tasks. Powers the "what's the story
   * of this lead?" panel that joins lead-gen + qualifier + funnel into
   * a single narrative without forcing the user to hop between views.
   *
   * Accepts either the funnel-store lead id OR the lead-gen external id;
   * resolves to the canonical funnel-store id internally so the timeline
   * always pulls from the authoritative tables.
   */
  "leads.timeline": async ({ params, respond }) => {
    try {
      const rawId = typeof params.id === "string" ? params.id : "";
      const requestedLeadId = typeof params.leadId === "string" ? params.leadId : "";
      const id = rawId || requestedLeadId;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }

      const businessId = await resolveBusinessId(params);
      const store = getFunnelStore();

      // Resolve to the funnel-store lead id. The UI may pass either form
      // — the gen-Lead id (which lives in custom_fields.externalId) or
      // the funnel-store row id directly.
      let funnelLeadId: string | null = null;
      const direct = store.getLead(id);
      if (direct) {
        funnelLeadId = direct.id;
      } else if (businessId) {
        const rows = store.listLeads({ businessId });
        const match = rows.find((row) => {
          const cf = (row.customFields ?? {}) as { externalId?: unknown };
          return cf.externalId === id;
        });
        if (match) funnelLeadId = match.id;
      }
      if (!funnelLeadId) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Lead not found" });
        return;
      }

      const lead = store.getLead(funnelLeadId)!;
      const activities = store.getLeadActivities(funnelLeadId);
      const stageHistory = store.getLeadStageHistory(funnelLeadId);

      // Build a stageId → stageName lookup so transitions render with
      // human labels instead of opaque uuids. Cheap: one query per
      // distinct stage referenced in the history.
      const stageIds = new Set<string>();
      for (const h of stageHistory) {
        if (h.fromStageId) stageIds.add(h.fromStageId);
        if (h.toStageId) stageIds.add(h.toStageId);
      }
      const stageNameById = new Map<string, string>();
      for (const sid of stageIds) {
        const s = store.getStage(sid);
        if (s) stageNameById.set(sid, s.name);
      }

      // Qualifier verdicts for THIS lead — walk runs and filter. The
      // qualifier file is small (capped at 200 runs per business) so a
      // linear scan is fine.
      const verdictEvents: Array<{
        type: "verdict";
        at: string;
        result: QualifierResult;
        note: string;
        runId: string;
      }> = [];
      if (businessId) {
        try {
          const runs = listQualifierRuns(businessId);
          for (const run of runs) {
            if (run.leadId !== funnelLeadId) continue;
            verdictEvents.push({
              type: "verdict",
              at: new Date(run.completedAt ?? run.receivedAt).toISOString(),
              result: run.result,
              note: run.note,
              runId: run.id,
            });
          }
        } catch {
          /* qualifier file missing — skip */
        }
      }

      // Unified timeline shape — each event has at minimum a kind, a
      // timestamp, and a one-line label. Extra detail rides in `detail`.
      type TimelineEvent =
        | {
            kind: "activity";
            at: string;
            activityType: string;
            label: string;
            detail?: string;
            performedBy?: string;
          }
        | {
            kind: "stage";
            at: string;
            label: string;
            fromStage?: string;
            toStage: string;
            reason?: string;
            timeInPreviousSeconds?: number;
          }
        | {
            kind: "verdict";
            at: string;
            result: QualifierResult;
            label: string;
            detail?: string;
            runId: string;
          };

      const events: TimelineEvent[] = [];

      for (const a of activities) {
        events.push({
          kind: "activity",
          at: a.createdAt,
          activityType: a.type,
          label: a.description,
          detail: a.metadata ? JSON.stringify(a.metadata) : undefined,
          performedBy: a.performedBy,
        });
      }

      for (const h of stageHistory) {
        const toName = stageNameById.get(h.toStageId) ?? h.toStageId;
        const fromName = h.fromStageId
          ? (stageNameById.get(h.fromStageId) ?? h.fromStageId)
          : undefined;
        events.push({
          kind: "stage",
          at: h.createdAt,
          label: fromName ? `Moved ${fromName} → ${toName}` : `Entered ${toName}`,
          fromStage: fromName,
          toStage: toName,
          reason: h.reason,
          timeInPreviousSeconds: h.timeInPreviousStage,
        });
      }

      for (const v of verdictEvents) {
        events.push({
          kind: "verdict",
          at: v.at,
          result: v.result,
          label:
            v.result === "qualified"
              ? "Qualifier ✓ Qualified"
              : v.result === "unqualified"
                ? "Qualifier ✗ Unqualified"
                : "Qualifier ⚠ Error",
          detail: v.note || undefined,
          runId: v.runId,
        });
      }

      // Oldest-first — the timeline reads top-down as the lead's story.
      events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

      respond(
        true,
        {
          leadId: funnelLeadId,
          businessId,
          lead: {
            id: lead.id,
            name: lead.name,
            company: lead.company,
            email: lead.email,
            status: lead.status,
            source: lead.source,
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt,
          },
          events,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * One-shot migrate: walk every funnel-store lead for the active (or
   * requested) business and mirror them into the per-business leads
   * database. Idempotent — repeated runs upsert in place using the lead
   * id as the row id.
   */
  "leads.migrate_to_database": async ({ params, respond }) => {
    try {
      let businessId: string | null =
        typeof params?.businessId === "string" ? params.businessId : null;
      if (!businessId) {
        try {
          const fs = await import("fs");
          const path = await import("path");
          const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
          const file = path.join(stateDir, "business.json");
          if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
            businessId = raw.activeBusinessId ?? null;
          }
        } catch {
          /* ignore */
        }
      }
      if (!businessId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "businessId is required (no active business in state)",
        });
        return;
      }

      const store = getFunnelStore();
      const funnelLeads = store.listLeads({ businessId });
      const genLeads: GenLead[] = funnelLeads.map(funnelLeadToGenLead);
      mirrorLeadsToDatabaseRows(genLeads, businessId);
      respond(true, {
        ok: true,
        businessId,
        migrated: genLeads.length,
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /** Quick status snapshot for the /databases system-roles panel + /leads banner. */
  "leads.bridge_status": async ({ params, respond }) => {
    try {
      let businessId: string | null =
        typeof params?.businessId === "string" ? params.businessId : null;
      if (!businessId) {
        try {
          const fs = await import("fs");
          const path = await import("path");
          const stateDir = resolveStateDir(); // same dir business.ts writes business.json to
          const file = path.join(stateDir, "business.json");
          if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { activeBusinessId?: string };
            businessId = raw.activeBusinessId ?? null;
          }
        } catch {
          /* ignore */
        }
      }
      const legacyCount = businessId ? getFunnelStore().listLeads({ businessId }).length : 0;
      const status = businessId
        ? describeBusinessRoleBridge("leads", businessId, legacyCount)
        : { mode: "legacy", databaseId: null, drift: "in_sync", businessId };
      respond(true, status);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Compute and persist a heuristic qualifier score for a single lead.
   * Derives from signals: email, phone, rating, email engagement
   * (opens/clicks/replies), temperature. Stores the result in both the
   * funnel-store score field and customFields.qualifierScore/qualifierReason.
   */
  "leads.qualify": async ({ params, respond }) => {
    try {
      const rawId = typeof params?.leadId === "string" ? params.leadId : "";
      if (!rawId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "leadId required" });
        return;
      }
      const store = getFunnelStore();
      const lead = store.getLead(rawId);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "lead not found" });
        return;
      }

      const cf = (lead.customFields ?? {}) as Record<string, unknown>;
      const numCf = (k: string): number => (typeof cf[k] === "number" ? (cf[k] as number) : 0);

      let score = 20;
      const signals: string[] = [];

      if (lead.email) {
        score += 10;
        signals.push("email");
      }
      if (lead.phone) {
        score += 10;
        signals.push("phone");
      }

      const rating = numCf("rating");
      if (rating >= 4.0) {
        score += 20;
        signals.push(`${rating}★`);
      } else if (rating >= 3.0) {
        score += 8;
      }

      const opens = numCf("opens");
      if (opens >= 3) {
        score += 15;
        signals.push(`${opens} opens`);
      } else if (opens > 0) {
        score += 8;
      }

      const clicks = numCf("clicks");
      if (clicks > 0) {
        score += 10;
        signals.push(`${clicks} clicks`);
      }

      const replies = numCf("replyCount");
      if (replies > 0) {
        score += 20;
        signals.push(`${replies} replies`);
      }

      const temp = deriveTemperature(lead, Date.now());
      if (temp === "hot") {
        score += 10;
        signals.push("hot");
      } else if (temp === "warm") {
        score += 5;
      }

      score = Math.min(100, Math.max(0, score));
      const reason =
        signals.length > 0 ? `Signals: ${signals.join(", ")}` : "Baseline — no strong signals yet";

      store.updateLead(rawId, {
        score,
        customFields: {
          ...cf,
          qualifierScore: score,
          qualifierReason: reason,
          qualifierUpdatedAt: new Date().toISOString(),
        },
      });

      respond(true, { leadId: rawId, qualifierScore: score, qualifierReason: reason });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },

  /**
   * Toggle the cadence pause flag for a lead.
   * Pass `paused` explicitly to force a value; omit to flip current state.
   * `paused: true` → excluded from next cadence tick.
   * `paused: false` → re-enrolled.
   */
  "leads.toggleCadence": async ({ params, respond }) => {
    try {
      const rawId = typeof params?.leadId === "string" ? params.leadId : "";
      if (!rawId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "leadId required" });
        return;
      }
      const store = getFunnelStore();
      const lead = store.getLead(rawId);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: "lead not found" });
        return;
      }

      const cf = (lead.customFields ?? {}) as Record<string, unknown>;
      const currentPaused = cf.paused === true;
      const nextPaused = typeof params?.paused === "boolean" ? params.paused : !currentPaused;

      store.updateLead(rawId, {
        customFields: { ...cf, paused: nextPaused },
      });

      respond(true, { leadId: rawId, paused: nextPaused });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: (err as Error).message });
    }
  },
};

// In satellite mode, proxy all leads.* calls to master (lead data is master-owned).
export const leadHandlers: GatewayRequestHandlers = applySatelliteProxy(_rawLeadHandlers);
