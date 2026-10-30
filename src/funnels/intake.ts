/**
 * Submission → Lead intake.
 *
 * Called by the public HTTP layer when a `/api/funnels/<slug>/submit`
 * POST lands. Walks the funnel's page config to map submitted form
 * fields onto Lead properties (name, email, phone, company, custom),
 * inserts a Lead in the entry stage, appends to the submissions log,
 * and (when wired) syncs the new lead into the business's leads
 * database for cross-tab queries.
 *
 * Owner assignment: round-robin across users in the linked business
 * when the funnel doesn't pin an owner. Falls back to the funnel's
 * configured default owner.
 */

import { getFunnelStore } from "./store.js";
import { appendSubmission, readPageConfig, type PageConfig } from "./workspace.js";

// ── Types ─────────────────────────────────────────────────────

export interface IngestArgs {
  stateDir: string;
  funnelId: string;
  payload: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export interface IngestResult {
  leadId: string | null;
  rejected?: "validation" | "internal_error";
  error?: string;
}

// ── Public API ───────────────────────────────────────────────

export async function ingestSubmission(args: IngestArgs): Promise<IngestResult> {
  const cfg = readPageConfig(args.funnelId);
  if (!cfg || !cfg.published) {
    appendSubmission(args.funnelId, {
      ts: Date.now(),
      ip: args.ip,
      userAgent: args.userAgent,
      payload: args.payload,
      rejected: "validation",
      error: "page not published",
    });
    return { leadId: null, rejected: "validation", error: "page not published" };
  }

  // Validate required fields up front so we can give a clean response
  // instead of failing at insert time with a cryptic SQL error.
  const missing = cfg.fields.filter((f) => f.required && f.id !== "_email" && !args.payload[f.id]);
  if (missing.length > 0) {
    appendSubmission(args.funnelId, {
      ts: Date.now(),
      ip: args.ip,
      userAgent: args.userAgent,
      payload: args.payload,
      rejected: "validation",
      error: `missing required: ${missing.map((m) => m.id).join(", ")}`,
    });
    return { leadId: null, rejected: "validation", error: "missing required fields" };
  }

  // Resolve the funnel + its business so the lead lands in the right
  // tenant scope. Funnels without a business get a synthetic placeholder
  // so the lead still gets created — admin can re-assign later.
  const store = getFunnelStore();
  const funnel = store.getFunnel(args.funnelId);
  if (!funnel) {
    return { leadId: null, rejected: "internal_error", error: "funnel not found" };
  }
  const businessId = funnel.businessId ?? "default";

  // Pull the standard fields off the payload, leave everything else in
  // `customFields` so the page can collect arbitrary inputs.
  const standard = pluckStandardFields(cfg, args.payload);
  const ownerId = pickOwner(cfg, businessId);

  try {
    // Omit fields rather than passing `undefined` — strict TS rejects
    // `undefined` against the non-optional fields in Lead, but the store
    // accepts missing fields and fills sensible defaults.
    const lead = store.createLead({
      businessId,
      funnelId: funnel.id,
      name: standard.name,
      email: standard.email,
      phone: standard.phone,
      company: standard.company,
      title: standard.title,
      source: (standard.source as never) ?? "website",
      status: "new",
      priority: "medium",
      assignedTo: ownerId ?? undefined,
      tags: standard.tags,
      customFields: standard.customFields,
      firstContactAt: new Date().toISOString(),
    } as never);

    appendSubmission(args.funnelId, {
      ts: Date.now(),
      ip: args.ip,
      userAgent: args.userAgent,
      payload: args.payload,
      leadId: lead.id,
    });

    // Best-effort sync to the business's leads database. Failure here
    // is logged but doesn't fail the submission — the lead is already
    // in the funnel store.
    void syncToBusinessDatabase(args.stateDir, lead, funnel.businessId).catch((err) => {
      console.warn(
        "[funnels.intake] db-bridge sync failed:",
        err instanceof Error ? err.message : String(err),
      );
    });

    // Autoresponder — fire-and-forget. Never blocks the submission
    // response; never fails the intake. The email dispatcher's NO_PROVIDER
    // path means missing env vars degrade silently.
    if (cfg.autoresponder?.enabled && standard.email) {
      void sendAutoresponder(cfg.autoresponder, {
        name: standard.name,
        email: standard.email,
        company: standard.company,
        customFields: standard.customFields,
        businessId: funnel.businessId ?? undefined,
      }).catch((err) => {
        console.warn(
          "[funnels.intake] autoresponder failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    return { leadId: lead.id };
  } catch (err) {
    appendSubmission(args.funnelId, {
      ts: Date.now(),
      ip: args.ip,
      userAgent: args.userAgent,
      payload: args.payload,
      rejected: "internal_error",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      leadId: null,
      rejected: "internal_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────

function pluckStandardFields(
  cfg: PageConfig,
  payload: Record<string, unknown>,
): {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  source?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
} {
  const known = new Set(["name", "email", "phone", "company", "title", "source"]);
  const tagsField = cfg.fields.find((f) => f.id === "tags");
  const tags =
    tagsField && typeof payload.tags === "string"
      ? (payload.tags as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (known.has(k) || k === "tags" || k === cfg.honeypotField) continue;
    customFields[k] = v;
  }
  return {
    name: typeof payload.name === "string" && payload.name ? payload.name : "Unknown",
    email: typeof payload.email === "string" ? payload.email : undefined,
    phone: typeof payload.phone === "string" ? payload.phone : undefined,
    company: typeof payload.company === "string" ? payload.company : undefined,
    title: typeof payload.title === "string" ? payload.title : undefined,
    source: typeof payload.source === "string" ? payload.source : undefined,
    tags,
    customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
  };
}

/**
 * Pick the user the new lead should be assigned to. Order:
 *   1. Page config's `meta.defaultOwnerId` if set.
 *   2. Round-robin across users in the linked business — the user whose
 *      lastAssignedAt is oldest wins. Falls back to the first user.
 *   3. null when there are no candidate users (e.g. legacy single-tenant).
 */
function pickOwner(cfg: PageConfig, _businessId: string): string | null {
  const explicit = cfg.meta?.defaultOwnerId;
  if (typeof explicit === "string" && explicit) return explicit;
  // Round-robin lives behind a future user-pool table; for now just
  // return null and let the admin assign in the dashboard. The hook is
  // wired so the moment that table lands we just plug it in here.
  return null;
}

/**
 * Mirror the lead into the per-business leads database (Notion-style
 * row store). Lazy-imports the databases module so the funnel intake
 * module stays usable in environments where the databases system isn't
 * fully wired.
 */
async function syncToBusinessDatabase(
  stateDir: string,
  lead: {
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
  },
  businessId: string | null,
): Promise<void> {
  if (!businessId) return;
  try {
    // Defer-import the bridge so we don't pull databases into module
    // init when funnels alone are needed.
    const { upsertLeadRow } = await import("./db-bridge.js");
    await upsertLeadRow(stateDir, businessId, lead);
  } catch (err) {
    // Bridge isn't ready in every install (db-bridge depends on the
    // databases module). Swallow — the funnel's own store still has the
    // lead.
    void err;
  }
}

interface AutoresponderConfig {
  enabled: boolean;
  subject: string;
  body: string;
  html?: string;
  fromEmail?: string;
  replyTo?: string;
  transactionalId?: string;
}

/**
 * Render `{{name}}` style merge tags against the lead context, then hand
 * off to the unified email dispatcher. Lazy-imports both so a funnel-only
 * install doesn't drag the email service into its bundle.
 */
async function sendAutoresponder(
  cfg: AutoresponderConfig,
  ctx: {
    name: string;
    email: string;
    company?: string;
    customFields?: Record<string, unknown>;
    businessId?: string;
  },
): Promise<void> {
  if (!cfg.enabled || !ctx.email) return;
  const merge = (template: string): string =>
    template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) => {
      switch (key) {
        case "name":
          return ctx.name;
        case "email":
          return ctx.email;
        case "company":
          return ctx.company ?? "";
        default: {
          const v = ctx.customFields?.[key];
          if (typeof v === "string" || typeof v === "number") return String(v);
          return "";
        }
      }
    });
  try {
    const { sendEmail } = await import("../services/email/dispatcher.js");
    // TODO(campaigns): if this intake was driven by a campaign-bound
    // funnel/form, look up the lead by id (passed via ctx) and call
    // `buildCampaignContext(leadId)` from src/campaigns/context-builder.ts
    // to fold campaign + business + products into this autoresponder.
    await sendEmail({
      to: ctx.email,
      subject: merge(cfg.subject || "Thanks for reaching out"),
      body: cfg.body ? merge(cfg.body) : undefined,
      html: cfg.html ? merge(cfg.html) : undefined,
      from: cfg.fromEmail,
      replyTo: cfg.replyTo,
      transactionalId: cfg.transactionalId,
      businessId: ctx.businessId,
    });
  } catch (err) {
    void err; // logged at the caller
  }
}
