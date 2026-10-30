/**
 * Business hub automation — the one place business events turn into
 * pipeline moves, so tracking, email, revenue and lead intake stay decoupled:
 *
 *   form submitted  → contact (lead) + open deal in the first stage → `form.submitted` rule
 *   email replied / clicked / sent → matching rules
 *   payment succeeded → `payment.succeeded` rule (Won) → client conversion
 *
 * Won deals become agency clients (agency.db, the client source of truth) by
 * ID: an existing client with the same email / name is linked, otherwise one
 * is created. Nothing else is copied.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgencyOperationsStore } from "../agency-operations/store.js";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import type { HubDb } from "./db.js";
import { getMeta } from "./db.js";
import {
  ensureCampaignByUtm,
  ensureSource,
  getCompany,
  getContact,
  logActivity,
  upsertContact,
  type ContactInput,
  type SourceKind,
} from "./contacts.js";
import {
  applyEvent,
  createDeal,
  ensureDefaultPipeline,
  type Deal,
  type PipelineEvent,
} from "./pipeline.js";
import { normalizeEmail, str } from "./util.js";

export type HubSettings = {
  /** Open a deal in the first stage for every new lead from forms / lead-gen / imports. */
  autoCreateDeals: boolean;
  /** Create (or link) an agency client when a deal is won. */
  convertWonToClient: boolean;
};

export const DEFAULT_SETTINGS: HubSettings = { autoCreateDeals: true, convertWonToClient: true };

export function getSettings(db: HubDb): HubSettings {
  try {
    return {
      ...DEFAULT_SETTINGS,
      ...(JSON.parse(getMeta(db, "settings") ?? "{}") as Partial<HubSettings>),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The active business id (business.json) — agencies are keyed by it. */
export function activeBusinessId(stateDir = resolveStateDirWithLegacyEnv()): string | null {
  const p = join(stateDir, "business.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { activeBusinessId?: string };
    return j.activeBusinessId ?? null;
  } catch {
    return null;
  }
}

export type ClientLinker = (deal: Deal) => string | null;

/**
 * Link or create the agency client for a won deal. Matches an existing client
 * by email (contact or billing email) then by exact company name.
 */
export function agencyClientLinker(
  db: HubDb,
  stateDir = resolveStateDirWithLegacyEnv(),
): ClientLinker {
  return (deal) => {
    if (deal.clientId) return deal.clientId;
    const store = getAgencyOperationsStore(stateDir);
    const agencies = store.listAgencies();
    const biz = activeBusinessId(stateDir);
    const agencyId =
      agencies.find((a) => a.id === biz)?.id ??
      agencies.find((a) => a.id === "default")?.id ??
      agencies[0]?.id;
    if (!agencyId) return null;
    const contact = deal.contactId ? getContact(db, deal.contactId) : null;
    const company = deal.companyId
      ? getCompany(db, deal.companyId)
      : contact?.companyId
        ? getCompany(db, contact.companyId)
        : null;
    if (company?.clientId) return company.clientId;
    if (contact?.clientId) return contact.clientId;
    const clients = store.listClients(agencyId);
    const email = contact?.email ?? null;
    const name = (company?.name ?? contact?.name ?? deal.title).trim();
    const match =
      (email &&
        clients.find(
          (c) => normalizeEmail(c.email) === email || normalizeEmail(c.billingEmail) === email,
        )) ||
      clients.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    const client =
      match ??
      store.createClient(
        {
          name,
          email,
          billingEmail: email ?? undefined,
          phone: contact?.phoneE164 ?? company?.phone ?? null,
          pipelineStatus: "active",
          notes: `Won in Business hub (deal ${deal.id}).`,
          data: {
            hubDealId: deal.id,
            hubContactId: contact?.id ?? null,
            hubCompanyId: company?.id ?? null,
          },
        },
        { agencyId, actorId: "business-hub" },
      );
    return client.id;
  };
}

export type AutomationDeps = {
  linkClient?: ClientLinker;
};

/** What happens when a deal is won: link/create the client and log it on both sides. */
export function wonHandler(db: HubDb, deps: AutomationDeps) {
  return (deal: Deal) => {
    if (!getSettings(db).convertWonToClient || !deps.linkClient) return;
    let clientId: string | null = null;
    try {
      clientId = deps.linkClient(deal);
    } catch (err) {
      logActivity(db, {
        subjectType: "deal",
        subjectId: deal.id,
        type: "client.link_failed",
        summary: `Could not create the client: ${String(err)}`,
      });
      return;
    }
    if (!clientId) return;
    db.prepare("UPDATE deals SET client_id = ? WHERE id = ?").run(clientId, deal.id);
    if (deal.companyId)
      db.prepare(
        "UPDATE companies SET client_id = COALESCE(client_id, ?) WHERE id = ? AND (client_id IS NULL OR client_id = ?)",
      ).run(clientId, deal.companyId, clientId);
    if (deal.contactId)
      db.prepare("UPDATE contacts SET client_id = COALESCE(client_id, ?) WHERE id = ?").run(
        clientId,
        deal.contactId,
      );
    logActivity(db, {
      subjectType: "deal",
      subjectId: deal.id,
      type: "client.linked",
      summary: "Won — now a client",
      data: { clientId },
    });
    logActivity(db, {
      subjectType: "client",
      subjectId: clientId,
      type: "deal.won",
      summary: `Deal won: ${deal.title}`,
      data: { dealId: deal.id, valueCents: deal.valueCents },
    });
  };
}

/** Open a first-stage deal for a contact that has none open. */
export function ensureOpenDeal(
  db: HubDb,
  contactId: string,
  extra: { sourceId?: string | null; campaignId?: string | null; title?: string } = {},
): Deal | null {
  if (db.prepare("SELECT 1 FROM deals WHERE contact_id = ? AND status = 'open'").get(contactId))
    return null;
  const contact = getContact(db, contactId);
  if (!contact || contact.lifecycle === "customer") return null;
  const pipeline = ensureDefaultPipeline(db);
  const company = contact.companyId ? getCompany(db, contact.companyId) : null;
  return createDeal(
    db,
    {
      title: extra.title ?? company?.name ?? contact.name,
      contactId,
      companyId: contact.companyId,
      stageId: pipeline.stages[0].id,
      sourceId: extra.sourceId ?? contact.firstSourceId,
      campaignId: extra.campaignId ?? contact.firstCampaignId,
    },
    { actor: "automation", enforce: false },
  );
}

/** Feed a business event into the pipeline. Returns moved deals. */
export function emitPipelineEvent(
  db: HubDb,
  contactId: string,
  event: PipelineEvent,
  deps: AutomationDeps = {},
  opts: { reason?: string; valueCents?: number } = {},
): Deal[] {
  return applyEvent(db, contactId, event, {
    reason: opts.reason,
    valueCents: opts.valueCents,
    onWon: wonHandler(db, deps),
  });
}

export type LeadSubmission = {
  email?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  company?: string | null;
  website?: string | null;
  message?: string | null;
  consent?: boolean;
  fields?: Record<string, unknown>;
  /** Where it came from — e.g. { kind: "form", name: "Lead qualifier: roofing" }. */
  source: { kind: SourceKind; name: string };
  utmCampaign?: string | null;
  pageRef?: string | null;
  occurredAt?: number;
  businessId?: string | null;
};

/**
 * Ingest a lead from any intake path (tracking snippet, legacy form
 * endpoints, funnel pages): contact + timeline + deal + `form.submitted`.
 */
export function ingestLead(
  db: HubDb,
  sub: LeadSubmission,
  deps: AutomationDeps = {},
): { contactId: string; created: boolean; dealId: string | null } | null {
  const sourceId = ensureSource(db, sub.source.kind, sub.source.name);
  const campaignId = sub.utmCampaign ? ensureCampaignByUtm(db, sub.utmCampaign) : null;
  const input: ContactInput = {
    email: sub.email,
    name: sub.name,
    firstName: sub.firstName,
    lastName: sub.lastName,
    phone: sub.phone,
    company:
      sub.company || sub.website ? { name: str(sub.company), website: str(sub.website) } : null,
    lifecycle: "lead",
    emailOptIn: sub.consent === true ? true : undefined,
    consentSource: sub.consent ? sub.source.name : null,
    firstCampaignId: campaignId,
    businessId: sub.businessId ?? null,
  };
  const res = upsertContact(db, input, { sourceId, actor: "intake" });
  if (!res) return null;
  const fields = Object.fromEntries(
    Object.entries(sub.fields ?? {})
      .filter(([k]) => !/pass|card|cvv|ssn|token|secret/i.test(k))
      .slice(0, 40),
  );
  logActivity(db, {
    subjectType: "contact",
    subjectId: res.contact.id,
    type: "form.submitted",
    summary: `Submitted ${sub.source.name}`,
    occurredAt: sub.occurredAt,
    data: {
      source: sub.source,
      pageRef: sub.pageRef ?? null,
      campaignId,
      message: str(sub.message),
      fields,
    },
  });
  let dealId: string | null = null;
  if (getSettings(db).autoCreateDeals)
    dealId = ensureOpenDeal(db, res.contact.id, { sourceId, campaignId })?.id ?? null;
  emitPipelineEvent(db, res.contact.id, "form.submitted", deps, { reason: sub.source.name });
  return { contactId: res.contact.id, created: res.created, dealId };
}

/**
 * Open a deal for an imported lead (lead-gen import hook): by contact when
 * there is one, else by company — skipped when either already has an open deal.
 */
export function openLeadDeal(
  db: HubDb,
  args: { contactId: string | null; companyId: string | null; stageName?: string },
): Deal | null {
  const pipeline = ensureDefaultPipeline(db);
  const stage =
    (args.stageName &&
      pipeline.stages.find((s) => s.name.toLowerCase() === args.stageName!.toLowerCase())) ||
    pipeline.stages[0];
  if (args.contactId) {
    if (
      db.prepare("SELECT 1 FROM deals WHERE contact_id = ? AND status = 'open'").get(args.contactId)
    )
      return null;
  } else if (args.companyId) {
    if (
      db.prepare("SELECT 1 FROM deals WHERE company_id = ? AND status = 'open'").get(args.companyId)
    )
      return null;
  } else return null;
  const contact = args.contactId ? getContact(db, args.contactId) : null;
  const company = args.companyId
    ? getCompany(db, args.companyId)
    : contact?.companyId
      ? getCompany(db, contact.companyId)
      : null;
  return createDeal(
    db,
    {
      title: company?.name ?? contact?.name ?? "Lead",
      contactId: args.contactId,
      companyId: company?.id ?? args.companyId,
      stageId: stage.id,
      sourceId: contact?.firstSourceId ?? company?.sourceId ?? null,
    },
    { actor: "leadgen", enforce: false },
  );
}
