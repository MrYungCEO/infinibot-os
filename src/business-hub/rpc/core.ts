/**
 * Business hub RPCs — contacts, companies, clients (agency.db, joined live by
 * ID), deals + pipeline, imports, tags, sources, the timeline, settings and
 * the migration. Lead-gen, email, tracking and revenue live in sibling files.
 */

import { join } from "node:path";
import { getAgencyOperationsStore } from "../../agency-operations/store.js";
import { resolveStateDirWithLegacyEnv } from "../../config/paths.js";
import {
  activeBusinessId,
  agencyClientLinker,
  DEFAULT_SETTINGS,
  wonHandler,
  emitPipelineEvent,
  getSettings,
  ingestLead,
  type HubSettings,
} from "../automation.js";
import {
  deleteContact,
  findDuplicateContacts,
  getCompany,
  getContact,
  LIFECYCLES,
  listCompanies,
  listContacts,
  listSources,
  listTags,
  logActivity,
  mergeCompanies,
  mergeContacts,
  tagSubject,
  timeline,
  untagSubject,
  updateContact,
  upsertCompany,
  upsertContact,
  type CompanyInput,
  type ContactQuery,
  type Lifecycle,
  type SubjectType,
} from "../contacts.js";
import { setMeta, type HubDb } from "../db.js";
import {
  commitImport,
  getImport,
  listImports,
  previewImport,
  revalidateImport,
  undoImport,
  type ImportOptions,
} from "../imports.js";
import type { ColumnMapping } from "../import-parse.js";
import { migrateLegacyBusinessData, migrationStatus, defaultMigrationDeps } from "../migration.js";
import {
  createDeal,
  deleteDeal,
  getDeal,
  getPipeline,
  kanbanReminderSink,
  listDeals,
  listPipelines,
  listRules,
  moveDeal,
  pipelineMetrics,
  PIPELINE_EVENTS,
  REQUIRABLE_FIELDS,
  saveRules,
  saveStages,
  StageRequirementError,
  syncReminders,
  updateDeal,
  type Deal,
  type DealInput,
  type PipelineEvent,
  type Stage,
  type StageRule,
} from "../pipeline.js";
import { defineHubHandlers, HubError, optBool, optNum, optStr, reqStr, strArr } from "./helpers.js";

function stateDir(): string {
  return resolveStateDirWithLegacyEnv();
}

function importsDir(): string {
  return join(stateDir(), "business-hub", "imports");
}

function contactQuery(p: Record<string, unknown>): ContactQuery {
  const lifecycle = p.lifecycle;
  return {
    search: optStr(p, "search"),
    lifecycle: Array.isArray(lifecycle)
      ? (lifecycle as Lifecycle[])
      : typeof lifecycle === "string" && lifecycle
        ? (lifecycle as Lifecycle)
        : undefined,
    tag: optStr(p, "tag"),
    companyId: optStr(p, "companyId"),
    clientId: optStr(p, "clientId"),
    sourceId: optStr(p, "sourceId"),
    campaignId: optStr(p, "campaignId"),
    hasEmail: optBool(p, "hasEmail"),
    emailStatus: optStr(p, "emailStatus") as ContactQuery["emailStatus"],
    minScore: optNum(p, "minScore"),
    sort: optStr(p, "sort") as ContactQuery["sort"],
    limit: optNum(p, "limit"),
    offset: optNum(p, "offset"),
  };
}

function dealInput(p: Record<string, unknown>): DealInput {
  const out: DealInput = {};
  const s = (k: keyof DealInput) => {
    if (p[k] === null) (out as Record<string, unknown>)[k] = null;
    else if (typeof p[k] === "string") (out as Record<string, unknown>)[k] = p[k];
  };
  const n = (k: keyof DealInput) => {
    if (p[k] === null) (out as Record<string, unknown>)[k] = null;
    else {
      const v = optNum(p, k);
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
  };
  (
    [
      "title",
      "pipelineId",
      "stageId",
      "currency",
      "nextAction",
      "lostReason",
      "contactId",
      "companyId",
      "clientId",
      "sourceId",
      "campaignId",
      "projectId",
      "owner",
    ] as const
  ).forEach(s);
  (["valueCents", "probability", "expectedCloseAt", "nextActionAt"] as const).forEach(n);
  if (p.custom && typeof p.custom === "object") out.custom = p.custom as Record<string, unknown>;
  return out;
}

function linker(db: HubDb) {
  return agencyClientLinker(db, stateDir());
}

function asRequirementError(err: unknown): never {
  if (err instanceof StageRequirementError) throw new HubError(`${err.message}`, "INVALID_REQUEST");
  throw err;
}

/** Agency clients for the active business, enriched with hub stats. */
function listClientsJoined(
  db: HubDb,
  q: { search?: string; limit?: number; offset?: number; status?: string },
) {
  const store = getAgencyOperationsStore(stateDir());
  const agencies = store.listAgencies();
  const biz = activeBusinessId(stateDir());
  const agencyId = agencies.find((a) => a.id === biz)?.id ?? "default";
  let clients = store.listClients(agencyId);
  if (q.status) clients = clients.filter((c) => c.pipelineStatus === q.status);
  if (q.search) {
    const s = q.search.toLowerCase();
    clients = clients.filter(
      (c) => c.name.toLowerCase().includes(s) || (c.email ?? "").toLowerCase().includes(s),
    );
  }
  const total = clients.length;
  // Paying clients first, then most recently updated.
  const ltvRows = db
    .prepare(
      `SELECT COALESCE(t.client_id, c.client_id) AS cid, SUM(t.net_cents) AS net, MAX(t.occurred_at) AS last
       FROM revenue_txns t LEFT JOIN contacts c ON c.id = t.contact_id
       WHERE t.type = 'charge' AND t.status IN ('succeeded','paid','partially_refunded') GROUP BY cid`,
    )
    .all() as Array<{ cid: string | null; net: number; last: number }>;
  const ltv = new Map(ltvRows.filter((r) => r.cid).map((r) => [r.cid!, r]));
  const dealRows = db
    .prepare(
      "SELECT client_id AS cid, COUNT(*) AS n, SUM(CASE WHEN status='open' THEN value_cents ELSE 0 END) AS openv FROM deals WHERE client_id IS NOT NULL GROUP BY client_id",
    )
    .all() as Array<{ cid: string; n: number; openv: number }>;
  const deals = new Map(dealRows.map((r) => [r.cid, r]));
  const contactRows = db
    .prepare(
      "SELECT COALESCE(c.client_id, co.client_id) AS cid, COUNT(*) AS n FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE COALESCE(c.client_id, co.client_id) IS NOT NULL GROUP BY cid",
    )
    .all() as Array<{ cid: string; n: number }>;
  const contacts = new Map(contactRows.map((r) => [r.cid, r.n]));
  clients.sort(
    (a, b) => (ltv.get(b.id)?.net ?? 0) - (ltv.get(a.id)?.net ?? 0) || b.updatedAt - a.updatedAt,
  );
  const page = clients.slice(q.offset ?? 0, (q.offset ?? 0) + Math.min(q.limit ?? 50, 500));
  return {
    agencyId,
    total,
    statuses: store.listClientPipelineStatusCounts(agencyId),
    clients: page.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email ?? c.billingEmail,
      phone: c.phone,
      status: c.pipelineStatus,
      statusLabel: c.pipelineStatusLabel,
      notionLinked: Boolean(c.notionPageId),
      updatedAt: c.updatedAt,
      ltvCents: ltv.get(c.id)?.net ?? 0,
      lastPaymentAt: ltv.get(c.id)?.last ?? null,
      deals: deals.get(c.id)?.n ?? 0,
      openDealCents: deals.get(c.id)?.openv ?? 0,
      contacts: contacts.get(c.id) ?? 0,
    })),
  };
}

function clientDetail(db: HubDb, clientId: string) {
  const store = getAgencyOperationsStore(stateDir());
  const agencies = store.listAgencies();
  let client = null;
  let agencyId: string | null = null;
  for (const a of agencies) {
    client = store.getClient(clientId, a.id);
    if (client) {
      agencyId = a.id;
      break;
    }
  }
  if (!client || !agencyId) throw new HubError("client not found", "NOT_FOUND");
  const contacts = listContacts(db, { clientId, limit: 200 }).contacts;
  const companies = (
    db.prepare("SELECT id FROM companies WHERE client_id = ?").all(clientId) as Array<{
      id: string;
    }>
  ).map((r) => getCompany(db, r.id));
  const deals = listDeals(db, { clientId }).deals;
  const invoices = store
    .listInvoices(agencyId)
    .filter((i) => i.clientId === clientId)
    .map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      currency: i.currency,
      totalCents: i.totalCents,
      balanceCents: i.balanceCents,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
    }));
  const contactIds = contacts.map((c) => c.id);
  const payments = db
    .prepare(
      `SELECT id, provider, type, status, gross_cents, net_cents, refunded_cents, currency, occurred_at, product_name FROM revenue_txns
       WHERE client_id = ? ${contactIds.length ? `OR contact_id IN (${contactIds.map(() => "?").join(",")})` : ""} ORDER BY occurred_at DESC LIMIT 200`,
    )
    .all(clientId, ...contactIds);
  return {
    client: {
      id: client.id,
      agencyId,
      name: client.name,
      legalName: client.legalName,
      email: client.email,
      billingEmail: client.billingEmail,
      phone: client.phone,
      status: client.pipelineStatus,
      statusLabel: client.pipelineStatusLabel,
      notes: client.notes,
      instagram: client.instagram,
      whatsapp: client.whatsapp,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    },
    contacts,
    companies,
    deals,
    invoices,
    payments,
    timeline: timeline(db, "client", clientId, { limit: 150 }),
  };
}

export const coreHubHandlers = defineHubHandlers({
  // ── contacts ──
  "hub.contacts.list": (p, { db }) => listContacts(db, contactQuery(p)),
  "hub.contacts.get": (p, { db }) => {
    const contact = getContact(db, reqStr(p, "id"));
    if (!contact) throw new HubError("contact not found", "NOT_FOUND");
    const company = contact.companyId ? getCompany(db, contact.companyId) : null;
    const sends = db
      .prepare(
        "SELECT s.id, s.subject, s.status, s.sent_at, s.opened_at, s.clicked_at, s.replied_at, s.bounced_at, c.name AS campaign FROM email_sends s LEFT JOIN email_campaigns c ON c.id = s.email_campaign_id WHERE s.contact_id = ? ORDER BY s.created_at DESC LIMIT 50",
      )
      .all(contact.id);
    const payments = db
      .prepare(
        "SELECT id, provider, type, status, gross_cents, net_cents, refunded_cents, currency, occurred_at, product_name FROM revenue_txns WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT 100",
      )
      .all(contact.id);
    const visits = db
      .prepare(
        "SELECT COUNT(*) AS events, MIN(occurred_at) AS first, MAX(occurred_at) AS last FROM track_events WHERE contact_id = ?",
      )
      .get(contact.id);
    const source = contact.firstSourceId
      ? db.prepare("SELECT id, kind, name FROM sources WHERE id = ?").get(contact.firstSourceId)
      : null;
    const campaign = contact.firstCampaignId
      ? db.prepare("SELECT id, name FROM campaigns WHERE id = ?").get(contact.firstCampaignId)
      : null;
    const suppressed = contact.email
      ? (db
          .prepare("SELECT reason, created_at FROM suppressions WHERE email = ?")
          .get(contact.email) ?? null)
      : null;
    return {
      contact,
      company,
      deals: listDeals(db, { contactId: contact.id }).deals,
      sends,
      payments,
      visits,
      source,
      campaign,
      suppressed,
      timeline: timeline(db, "contact", contact.id, { limit: 150 }),
    };
  },
  "hub.contacts.save": (p, { db, broadcast }) => {
    const id = optStr(p, "id");
    const input = (p.contact ?? p) as Record<string, unknown>;
    const patch = {
      name: input.name as string | undefined,
      firstName: input.firstName as string | undefined,
      lastName: input.lastName as string | undefined,
      email: input.email as string | undefined,
      phone: input.phone as string | undefined,
      title: input.title as string | undefined,
      companyId: input.companyId as string | undefined,
      lifecycle: input.lifecycle as Lifecycle | undefined,
      score: typeof input.score === "number" ? input.score : undefined,
      owner: input.owner as string | undefined,
      city: input.city as string | undefined,
      country: input.country as string | undefined,
      emailOptIn: typeof input.emailOptIn === "boolean" ? input.emailOptIn : undefined,
      tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
      custom:
        input.custom && typeof input.custom === "object"
          ? (input.custom as Record<string, unknown>)
          : undefined,
    };
    if (patch.lifecycle && !LIFECYCLES.includes(patch.lifecycle))
      throw new HubError("invalid lifecycle");
    let contact;
    if (id) contact = updateContact(db, id, patch, "user");
    else {
      const companyName = typeof input.companyName === "string" ? input.companyName : null;
      const res = upsertContact(
        db,
        {
          ...patch,
          company: !patch.companyId && companyName ? { name: companyName } : null,
          consentSource: patch.emailOptIn ? "manual" : null,
        },
        { sourceId: undefined, actor: "user" },
      );
      if (!res) throw new HubError("a contact needs a name, email or phone");
      contact = res.contact;
      if (optBool(p, "createDeal") && getSettings(db).autoCreateDeals)
        createDeal(
          db,
          { title: res.contact.name, contactId: res.contact.id, companyId: res.contact.companyId },
          { actor: "user", enforce: false },
        );
    }
    broadcast("hub.changed", { kind: "contact", id: contact.id });
    return { contact };
  },
  "hub.contacts.delete": (p, { db, broadcast }) => {
    const id = reqStr(p, "id");
    deleteContact(db, id);
    broadcast("hub.changed", { kind: "contact", id, deleted: true });
    return { ok: true };
  },
  "hub.contacts.merge": (p, { db }) => ({
    contact: mergeContacts(db, reqStr(p, "winnerId"), reqStr(p, "loserId"), "user"),
  }),
  "hub.contacts.duplicates": (p, { db }) => ({
    pairs: findDuplicateContacts(db, optNum(p, "limit") ?? 50),
  }),
  "hub.contacts.note": (p, { db }) => {
    const subjectType = (optStr(p, "subjectType") ?? "contact") as SubjectType;
    return {
      activity: logActivity(db, {
        subjectType,
        subjectId: reqStr(p, "id"),
        type: optStr(p, "type") ?? "note",
        summary: reqStr(p, "text").slice(0, 5000),
        actor: "user",
      }),
    };
  },
  "hub.contacts.tag": (p, { db }) => {
    const ids = strArr(p, "ids") ?? [reqStr(p, "id")];
    const add = strArr(p, "add") ?? [];
    const remove = strArr(p, "remove") ?? [];
    const subjectType = (optStr(p, "subjectType") ?? "contact") as SubjectType;
    for (const id of ids) {
      tagSubject(db, subjectType, id, add);
      untagSubject(db, subjectType, id, remove);
    }
    return { ok: true, count: ids.length };
  },
  "hub.contacts.bulk": (p, { db }) => {
    const ids = strArr(p, "ids") ?? [];
    const action = reqStr(p, "action");
    let n = 0;
    for (const id of ids) {
      if (action === "delete") deleteContact(db, id);
      else if (action === "lifecycle")
        updateContact(db, id, { lifecycle: reqStr(p, "lifecycle") as Lifecycle }, "user");
      else if (action === "createDeals") {
        if (db.prepare("SELECT 1 FROM deals WHERE contact_id = ? AND status='open'").get(id))
          continue;
        const c = getContact(db, id);
        if (c)
          createDeal(
            db,
            { title: c.name, contactId: id, companyId: c.companyId },
            { actor: "user", enforce: false },
          );
      } else throw new HubError(`unknown bulk action: ${action}`);
      n++;
    }
    return { ok: true, count: n };
  },
  // ── companies ──
  "hub.companies.list": (p, { db }) =>
    listCompanies(db, {
      search: optStr(p, "search"),
      tag: optStr(p, "tag"),
      hasClient: optBool(p, "hasClient"),
      limit: optNum(p, "limit"),
      offset: optNum(p, "offset"),
    }),
  "hub.companies.get": (p, { db }) => {
    const company = getCompany(db, reqStr(p, "id"));
    if (!company) throw new HubError("company not found", "NOT_FOUND");
    return {
      company,
      contacts: listContacts(db, { companyId: company.id, limit: 200 }).contacts,
      deals: listDeals(db, { companyId: company.id }).deals,
      timeline: timeline(db, "company", company.id),
    };
  },
  "hub.companies.save": (p, { db }) => {
    const input = (p.company ?? p) as Record<string, unknown>;
    const id = optStr(p, "id");
    if (id) {
      const cols: Record<string, string> = {
        name: "name",
        website: "website",
        industry: "industry",
        size: "size",
        phone: "phone",
        address: "address",
        city: "city",
        region: "region",
        country: "country",
      };
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, col] of Object.entries(cols))
        if (typeof input[k] === "string") {
          sets.push(`${col} = ?`);
          vals.push((input[k] as string).trim() || null);
        }
      if (sets.length)
        db.prepare(`UPDATE companies SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(
          ...vals,
          Date.now(),
          id,
        );
      return { company: getCompany(db, id) };
    }
    const res = upsertCompany(db, input as CompanyInput, { actor: "user" });
    if (!res) throw new HubError("a company needs a name or website");
    return { company: res.company };
  },
  "hub.companies.merge": (p, { db }) => ({
    company: mergeCompanies(db, reqStr(p, "winnerId"), reqStr(p, "loserId"), "user"),
  }),
  // ── clients (agency.db, joined) ──
  "hub.clients.list": (p, { db }) =>
    listClientsJoined(db, {
      search: optStr(p, "search"),
      limit: optNum(p, "limit"),
      offset: optNum(p, "offset"),
      status: optStr(p, "status"),
    }),
  "hub.clients.get": (p, { db }) => clientDetail(db, reqStr(p, "id")),
  // ── deals + pipeline ──
  "hub.pipeline.get": (p, { db }) => {
    const pipelines = listPipelines(db);
    const pipeline = optStr(p, "pipelineId")
      ? getPipeline(db, optStr(p, "pipelineId")!)
      : pipelines[0];
    if (!pipeline) throw new HubError("pipeline not found", "NOT_FOUND");
    return {
      pipelines: pipelines.map((x) => ({ id: x.id, name: x.name, isDefault: x.isDefault })),
      pipeline,
      rules: listRules(db, pipeline.id),
      events: PIPELINE_EVENTS,
      requirableFields: REQUIRABLE_FIELDS,
    };
  },
  "hub.pipeline.saveStages": (p, { db }) => ({
    pipeline: saveStages(
      db,
      reqStr(p, "pipelineId"),
      Array.isArray(p.stages) ? (p.stages as Array<Partial<Stage> & { name: string }>) : [],
      optStr(p, "moveDealsTo"),
    ),
  }),
  "hub.pipeline.saveRules": (p, { db }) => ({
    rules: saveRules(
      db,
      reqStr(p, "pipelineId"),
      Array.isArray(p.rules) ? (p.rules as Array<Omit<StageRule, "id"> & { id?: string }>) : [],
    ),
  }),
  "hub.pipeline.metrics": (p, { db }) =>
    pipelineMetrics(db, optStr(p, "pipelineId"), { from: optNum(p, "from"), to: optNum(p, "to") }),
  "hub.pipeline.syncReminders": async (_p, { db }) =>
    syncReminders(db, kanbanReminderSink(db, stateDir())),
  "hub.pipeline.event": (p, { db }) => {
    const event = reqStr(p, "event") as PipelineEvent;
    if (!PIPELINE_EVENTS.includes(event)) throw new HubError(`unknown event: ${event}`);
    return {
      moved: emitPipelineEvent(
        db,
        reqStr(p, "contactId"),
        event,
        { linkClient: linker(db) },
        { reason: optStr(p, "reason") },
      ),
    };
  },
  "hub.deals.list": (p, { db }) =>
    listDeals(db, {
      pipelineId: optStr(p, "pipelineId"),
      stageId: optStr(p, "stageId"),
      status: optStr(p, "status") as Deal["status"] | undefined,
      contactId: optStr(p, "contactId"),
      companyId: optStr(p, "companyId"),
      clientId: optStr(p, "clientId"),
      sourceId: optStr(p, "sourceId"),
      campaignId: optStr(p, "campaignId"),
      search: optStr(p, "search"),
      rotting: optBool(p, "rotting"),
      dueBefore: optNum(p, "dueBefore"),
      limit: optNum(p, "limit"),
      offset: optNum(p, "offset"),
    }),
  "hub.deals.get": (p, { db }) => {
    const deal = getDeal(db, reqStr(p, "id"));
    if (!deal) throw new HubError("deal not found", "NOT_FOUND");
    return {
      deal,
      contact: deal.contactId ? getContact(db, deal.contactId) : null,
      company: deal.companyId ? getCompany(db, deal.companyId) : null,
      timeline: timeline(db, "deal", deal.id),
    };
  },
  "hub.deals.save": (p, { db, broadcast }) => {
    const id = optStr(p, "id");
    try {
      const deal = id
        ? updateDeal(db, id, dealInput(p), "user")
        : createDeal(db, dealInput(p), { actor: "user" });
      broadcast("hub.changed", { kind: "deal", id: deal.id });
      return { deal };
    } catch (err) {
      return asRequirementError(err);
    }
  },
  "hub.deals.move": (p, { db, broadcast }) => {
    try {
      const deal = moveDeal(db, reqStr(p, "id"), reqStr(p, "stageId"), {
        actor: "user",
        patch:
          p.patch && typeof p.patch === "object"
            ? dealInput(p.patch as Record<string, unknown>)
            : undefined,
        onWon: wonHandler(db, { linkClient: linker(db) }),
      });
      broadcast("hub.changed", { kind: "deal", id: deal.id });
      return { deal: getDeal(db, deal.id) };
    } catch (err) {
      if (err instanceof StageRequirementError)
        return { ok: false, needs: err.missing, stage: err.stage, message: err.message };
      throw err;
    }
  },
  "hub.deals.delete": (p, { db }) => {
    deleteDeal(db, reqStr(p, "id"));
    return { ok: true };
  },
  // ── intake ──
  "hub.intake.lead": (p, { db }) => {
    const res = ingestLead(
      db,
      {
        email: optStr(p, "email"),
        name: optStr(p, "name"),
        phone: optStr(p, "phone"),
        company: optStr(p, "company"),
        website: optStr(p, "website"),
        message: optStr(p, "message"),
        consent: optBool(p, "consent"),
        source: { kind: "manual", name: optStr(p, "source") ?? "Manual intake" },
        utmCampaign: optStr(p, "utmCampaign"),
      },
      { linkClient: linker(db) },
    );
    if (!res) throw new HubError("a lead needs a name, email or phone");
    return res;
  },
  // ── imports ──
  "hub.imports.preview": async (p, { db }) => {
    const fileName = reqStr(p, "fileName");
    const b64 = optStr(p, "contentBase64");
    const text = typeof p.text === "string" ? p.text : undefined;
    if (!b64 && text === undefined) throw new HubError("contentBase64 or text required");
    const bytes = b64 ? new Uint8Array(Buffer.from(b64, "base64")) : new TextEncoder().encode(text);
    return previewImport(db, importsDir(), {
      fileName,
      bytes,
      mapping: p.mapping as ColumnMapping | undefined,
      options: p.options as ImportOptions | undefined,
      businessId: activeBusinessId(stateDir()),
    });
  },
  "hub.imports.revalidate": (p, { db }) => ({
    batch: revalidateImport(
      db,
      importsDir(),
      reqStr(p, "id"),
      (p.mapping ?? {}) as ColumnMapping,
      (p.options ?? {}) as ImportOptions,
    ),
  }),
  "hub.imports.commit": (p, { db, broadcast }) => {
    const batch = commitImport(db, importsDir(), reqStr(p, "id"), {
      mapping: p.mapping as ColumnMapping | undefined,
      options: p.options as ImportOptions | undefined,
      actor: "user",
    });
    broadcast("hub.changed", { kind: "import", id: batch.id });
    return { batch };
  },
  "hub.imports.undo": (p, { db }) => undoImport(db, reqStr(p, "id"), "user"),
  "hub.imports.list": (p, { db }) => ({ imports: listImports(db, optNum(p, "limit") ?? 50) }),
  "hub.imports.get": (p, { db }) => ({ batch: getImport(db, reqStr(p, "id")) }),
  // ── misc ──
  "hub.tags.list": (_p, { db }) => ({ tags: listTags(db) }),
  "hub.sources.list": (_p, { db }) => ({ sources: listSources(db) }),
  "hub.timeline": (p, { db }) => ({
    activities: timeline(db, reqStr(p, "subjectType") as SubjectType, reqStr(p, "id"), {
      limit: optNum(p, "limit"),
      before: optNum(p, "before"),
    }),
  }),
  "hub.settings.get": (_p, { db }) => ({ settings: getSettings(db), defaults: DEFAULT_SETTINGS }),
  "hub.settings.set": (p, { db }) => {
    const next: HubSettings = { ...getSettings(db) };
    if (typeof p.autoCreateDeals === "boolean") next.autoCreateDeals = p.autoCreateDeals;
    if (typeof p.convertWonToClient === "boolean") next.convertWonToClient = p.convertWonToClient;
    setMeta(db, "settings", JSON.stringify(next));
    return { settings: next };
  },
  "hub.migration.status": (_p, { db }) => ({ report: migrationStatus(db) }),
  "hub.migration.run": async (_p, { db }) => {
    const dir = stateDir();
    const deps = defaultMigrationDeps(dir);
    const { migrateLegacyIncome } = await import("../revenue/legacy.js");
    deps.migrateIncome = async (hubDb, sd) => {
      const r: unknown = await migrateLegacyIncome(hubDb, sd);
      return typeof r === "number" ? r : Number((r as { imported?: number } | null)?.imported ?? 0);
    };
    return { report: await migrateLegacyBusinessData(db, dir, deps, { force: true }) };
  },
});

export const CORE_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = Object.fromEntries(
  Object.keys(coreHubHandlers).map((m) => [
    m,
    /\.(list|get|duplicates|metrics|status)$/.test(m) ||
    m === "hub.timeline" ||
    m === "hub.pipeline.get"
      ? "read"
      : m === "hub.migration.run" || m === "hub.settings.set"
        ? "admin"
        : "write",
  ]),
);
