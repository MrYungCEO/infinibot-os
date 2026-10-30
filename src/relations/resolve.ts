/**
 * Object resolution for the relation graph — turning `(type, id)` edges into
 * something a human can read and click.
 *
 * `objrel.graph` answers "what is connected to what", but every node it returns
 * is a bare `{ type, id }`. A Connections panel rendered from that shows a wall
 * of `a3f9c1…` chips, so the graph is technically complete and practically
 * useless. This module is the missing half: it looks each node up in the store
 * that owns it and returns a display-ready record (label, subtitle, status,
 * a small field list) so the UI can render a navigable card per connection.
 *
 * DESIGN
 *  - One resolver per object type, all behind `resolveObject()`. Every resolver
 *    is individually try/catch'd: a store that is missing, empty, or throwing
 *    degrades that ONE card to an "unresolved" placeholder rather than failing
 *    the whole panel.
 *  - Resolution is read-only. Nothing here writes, migrates, or creates.
 *  - `connectionsFor()` is deliberately depth-1. The Connections panel shows a
 *    client's DIRECT neighborhood; deeper traversal happens by navigating INTO
 *    a connection (which resolves that object's own depth-1 set), which is what
 *    makes the surface feel like a graph rather than one giant dump.
 *
 * Consumed by `objrel.connections` / `objrel.object`
 * (src/gateway/server-methods/object-connections.ts).
 */

import { getRelationsStore } from "./store.js";
import type { ObjectRelation } from "./types.js";
import { resolveStateDir } from "../config/paths.js";

/** A display-ready object, resolved from whichever store owns its type. */
export interface ResolvedObject {
  type: string;
  id: string;
  /** Primary display name. Falls back to a short id when unresolvable. */
  label: string;
  /** Secondary line (role, company, kind, …). May be empty. */
  subtitle: string;
  /** Human status label (stage, pipeline status, …). May be empty. */
  status: string;
  /** Coarse tone for the status chip: ok | warn | bad | info | neutral. */
  tone: "ok" | "warn" | "bad" | "info" | "neutral";
  /** Monetary value in whole currency units, when the object has one. */
  value: number | null;
  /** Ordered property list for a focus page. */
  fields: Array<{ label: string; value: string }>;
  /** Unix ms; drives "updated 3d ago" and chronological ordering. */
  updatedAt: number;
  /** False when no store could resolve the id (dangling edge). */
  resolved: boolean;
}

/** One connection: the resolved neighbor plus the edge that reached it. */
export interface Connection extends ResolvedObject {
  /** objrel row id — lets the UI unlink this exact edge. */
  relationId: string;
  edge: string;
  /** "out" when the root is the edge's `from`, "in" when it is the `to`. */
  direction: "out" | "in";
  /** Free-form edge metadata (label, note, …). */
  edgeMeta: Record<string, unknown>;
}

/** Connections grouped by neighbor type, which is how the panel renders. */
export interface ConnectionGroup {
  type: string;
  label: string;
  items: Connection[];
}

const NEUTRAL: ResolvedObject["tone"] = "neutral";

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Build the `fields` list, dropping empties so a focus page has no dead rows. */
function fields(pairs: Array<[string, unknown]>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [label, raw] of pairs) {
    const value = Array.isArray(raw) ? raw.map(str).filter(Boolean).join(", ") : str(raw);
    if (value) out.push({ label, value });
  }
  return out;
}

/**
 * Map an arbitrary status string onto a chip tone. Deliberately generous with
 * synonyms — every object type invented its own vocabulary for "this is fine".
 */
export function toneForStatus(status: string): ResolvedObject["tone"] {
  const s = status.trim().toLowerCase();
  if (!s) return NEUTRAL;
  if (
    /(won|active|approved|paid|complete|completed|done|delivered|healthy|in progress|live)/.test(s)
  )
    return "ok";
  if (
    /(lost|cancelled|canceled|churn|churned|failed|blocked|overdue|rejected|disqualified)/.test(s)
  )
    return "bad";
  if (/(risk|hold|on_hold|on hold|pending|waiting|review|at risk|nurturing|paused|draft)/.test(s))
    return "warn";
  if (/(lead|prospect|new|open|qualified|proposal|negotiation|discovery|planned)/.test(s))
    return "info";
  return NEUTRAL;
}

const TYPE_LABEL: Record<string, string> = {
  client: "Clients",
  opportunity: "Opportunities",
  project: "Projects",
  task: "Tasks",
  product: "Products",
  decision: "Decisions",
  risk: "Risks",
  commitment: "Financial Commitments",
  person: "People",
  issue: "System Issues",
  report: "Reports",
  lead: "Leads",
  funnel: "Funnels",
  idea: "Ideas",
  note: "Notes",
  document: "Documents",
  file: "Files",
  goal: "Goals",
  event: "Events",
  contact: "Contacts",
  connection: "Connections",
};

export function typeGroupLabel(type: string): string {
  return TYPE_LABEL[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}s`;
}

function unresolved(type: string, id: string): ResolvedObject {
  return {
    type,
    id,
    label: id.length > 12 ? `${id.slice(0, 10)}…` : id || "(unknown)",
    subtitle: "",
    status: "",
    tone: NEUTRAL,
    value: null,
    fields: [],
    updatedAt: 0,
    resolved: false,
  };
}

function base(
  type: string,
  id: string,
  partial: Partial<ResolvedObject> & { label: string },
): ResolvedObject {
  return {
    type,
    id,
    subtitle: "",
    status: "",
    tone: toneForStatus(partial.status ?? ""),
    value: null,
    fields: [],
    updatedAt: 0,
    resolved: true,
    ...partial,
  };
}

// ═══════════════════════════════════════════════════════════════════
// PER-TYPE RESOLVERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Find a client by id WITHOUT knowing which business owns it.
 *
 * `store.getClient` is agency-scoped and defaults to DEFAULT_AGENCY_ID, but
 * real installs keep their clients under a business id (`biz-…`) — so scoping
 * the lookup to the default agency resolved nothing and every client node in
 * the graph rendered as a dangling edge. A relation carries no agency, so the
 * resolver has to search every agency; the default is tried first because it is
 * the common case on a single-business install.
 */
async function findClientAnyAgency(
  id: string,
): Promise<import("../agency-operations/types.js").Client | null> {
  const { getAgencyOperationsStore } = await import("../agency-operations/store.js");
  const { DEFAULT_AGENCY_ID } = await import("../agency-operations/types.js");
  const store = getAgencyOperationsStore(resolveStateDir());
  const direct = store.getClient(id, DEFAULT_AGENCY_ID);
  if (direct) return direct;
  for (const agency of store.listAgencies()) {
    if (agency.id === DEFAULT_AGENCY_ID) continue;
    const hit = store.getClient(id, agency.id);
    if (hit) return hit;
  }
  return null;
}

type Resolver = (id: string) => Promise<ResolvedObject | null> | ResolvedObject | null;

const RESOLVERS: Record<string, Resolver> = {
  client: async (id) => {
    const c = await findClientAnyAgency(id);
    if (!c) return null;
    const data = (c.data ?? {}) as Record<string, unknown>;
    return base("client", id, {
      label: c.name || "(unnamed client)",
      subtitle: str(data["Company"] ?? data["company"] ?? c.legalName ?? ""),
      status: c.pipelineStatusLabel || c.status || "",
      updatedAt: c.updatedAt ?? 0,
      fields: fields([
        ["Status", c.pipelineStatusLabel || c.status],
        ["Email", c.email ?? c.billingEmail],
        ["Phone", c.phone],
        ["WhatsApp", c.whatsapp],
        ["Telegram", c.telegram],
        ["Instagram", c.instagram],
        ["Owner", c.ownerId],
        ["Notes", c.notes],
      ]),
    });
  },

  opportunity: async (id) => {
    const { getOpportunityStore } = await import("../opportunity/store.js");
    const o = getOpportunityStore().get(id);
    if (!o) return null;
    return base("opportunity", id, {
      label: o.name || "(untitled opportunity)",
      subtitle: str(o.opportunityType),
      status: str(o.stage),
      value: num(o.estimatedValue),
      updatedAt: num(o.updatedAt) ?? 0,
      fields: fields([
        ["Stage", o.stage],
        ["Type", o.opportunityType],
        ["Owner", (o as unknown as Record<string, unknown>).owner],
        [
          "Estimated value",
          o.estimatedValue ? `$${Number(o.estimatedValue).toLocaleString()}` : "",
        ],
        ["Score", o.opportunityScore],
        ["Expected close", o.expectedCloseDate],
        ["Revenue type", o.revenueType],
        ["Problem / need", o.problemNeed],
        ["Proposed solution", o.proposedSolution],
      ]),
    });
  },

  project: async (id) => {
    const { projectsGet } = await import("../gateway/server-methods/projects.js");
    let p = (await projectsGet({ id })) as Record<string, unknown> | null;
    if (!p) {
      // Local-first installs (Notion off) keep board projects in the role databases.
      try {
        const ops = await import("../databases/kanban-store-ops.js");
        p = ops.getProject(id) as unknown as Record<string, unknown> | null;
      } catch {
        p = null;
      }
    }
    if (!p) return null;
    return base("project", id, {
      label: str(p.name ?? p.title ?? p.projectId) || "(untitled project)",
      subtitle: str(p.agentId ?? p.repo ?? ""),
      status: str(p.status),
      updatedAt: num(p.lastActivityAt ?? p.updatedAt) ?? 0,
      fields: fields([
        ["Status", p.status],
        ["Agent", p.agentId],
        ["Branch", p.branch],
        ["Repo", p.repo],
        ["Summary", p.summary ?? p.description],
      ]),
    });
  },

  task: async (id) => {
    const { getKanbanStore } = await import("../tasks/store.js");
    let t = getKanbanStore().getTaskById(id) as Record<string, unknown> | null;
    if (!t) {
      // Local-first installs (Notion off) keep tasks in the role databases.
      try {
        const ops = await import("../databases/kanban-store-ops.js");
        t = ops.getTask(id) as unknown as Record<string, unknown> | null;
      } catch {
        t = null;
      }
    }
    if (!t) return null;
    return base("task", id, {
      label: str(t.title ?? t.name) || "(untitled task)",
      subtitle: str(t.projectId ?? ""),
      status: str(t.status),
      updatedAt: num(t.updatedAt ?? t.updated_at) ?? 0,
      fields: fields([
        ["Status", t.status],
        ["Priority", t.priority],
        ["Assignee", t.assignee ?? t.agentId],
        ["Due", t.dueDate],
        ["Description", t.description],
      ]),
    });
  },

  product: async (id) => {
    const { getProductStore } = await import("../product/store.js");
    const p = getProductStore().get(id);
    if (!p) return null;
    return base("product", id, {
      label: p.name || "(untitled product)",
      subtitle: str(p.productType),
      status: str(p.validationStage),
      updatedAt: num(p.updatedAt) ?? 0,
      fields: fields([
        ["Validation stage", p.validationStage],
        ["Type", p.productType],
        ["Technical owner", p.technicalOwner],
        ["Target customer", p.targetCustomer],
        ["Revenue model", p.revenueModel],
        ["Pricing", p.pricing],
      ]),
    });
  },

  decision: async (id) => {
    const { getDecisionStore } = await import("../decision/store.js");
    const d = getDecisionStore().get(id);
    if (!d) return null;
    return base("decision", id, {
      label: d.title || "(untitled decision)",
      subtitle: str(d.decisionType),
      status: str(d.status),
      updatedAt: num(d.updatedAt) ?? 0,
      fields: fields([
        ["Status", d.status],
        ["Type", d.decisionType],
        ["Requested by", d.requestedBy],
        ["Deadline", d.decisionDeadline],
        ["Decision required", d.decisionRequired],
        ["Recommendation", d.recommendation],
      ]),
    });
  },

  risk: async (id) => {
    const { getRiskStore } = await import("../risk/store.js");
    const r = getRiskStore().get(id);
    if (!r) return null;
    const score = num(r.riskScore);
    return base("risk", id, {
      label: r.title || "(untitled risk)",
      subtitle: str(r.category),
      status:
        score != null && score >= 12
          ? "At risk"
          : str((r as unknown as Record<string, unknown>).status),
      updatedAt: num(r.updatedAt) ?? 0,
      fields: fields([
        ["Category", r.category],
        ["Probability", r.probability],
        ["Impact", r.impact],
        ["Risk score", r.riskScore],
        ["Mitigation", r.mitigation],
        ["Next review", r.nextReviewDate],
      ]),
    });
  },

  commitment: async (id) => {
    const { getCommitmentStore } = await import("../commitment/store.js");
    const c = getCommitmentStore().get(id);
    if (!c) return null;
    return base("commitment", id, {
      label: c.name || "(untitled commitment)",
      subtitle: `${str(c.commitmentType)}${c.direction ? ` · ${str(c.direction)}` : ""}`,
      status: c.overdue ? "Overdue" : str(c.status),
      value: num(c.amount),
      updatedAt: num(c.updatedAt) ?? 0,
      fields: fields([
        ["Status", c.overdue ? "Overdue" : c.status],
        ["Type", c.commitmentType],
        ["Direction", c.direction],
        ["Amount", c.amount ? `$${Number(c.amount).toLocaleString()}` : ""],
        ["Paid", c.amountPaid ? `$${Number(c.amountPaid).toLocaleString()}` : ""],
        ["Remaining", c.remainingBalance ? `$${Number(c.remainingBalance).toLocaleString()}` : ""],
        ["Due", c.dueDate],
      ]),
    });
  },

  person: async (id) => {
    const { getPersonStore } = await import("../person/store.js");
    const p = getPersonStore().get(id);
    if (!p) return null;
    return base("person", id, {
      label: p.name || "(unnamed person)",
      subtitle: str(p.role) || str(p.relationshipType),
      status: str(p.availability),
      updatedAt: num(p.updatedAt) ?? 0,
      fields: fields([
        ["Role", p.role],
        ["Relationship", p.relationshipType],
        ["Email", p.email],
        ["Phone", p.phone],
        ["Capabilities", p.capabilities],
        ["Availability", p.availability],
        ["Access level", p.accessLevel],
      ]),
    });
  },

  issue: async (id) => {
    const { getIssuesStore } = await import("../issues/store.js");
    const i = getIssuesStore().get(id) as Record<string, unknown> | null;
    if (!i) return null;
    return base("issue", id, {
      label: str(i.title) || "(untitled issue)",
      subtitle: str(i.category ?? i.issueType),
      status: str(i.status),
      updatedAt: num(i.updatedAt) ?? 0,
      fields: fields([
        ["Status", i.status],
        ["Severity", i.severity],
        ["Category", i.category ?? i.issueType],
        ["Description", i.description],
      ]),
    });
  },

  report: async (id) => {
    const { getReportsStore } = await import("../reports/store.js");
    const r = getReportsStore().getReport(id) as Record<string, unknown> | null;
    if (!r) return null;
    return base("report", id, {
      label: str(r.title) || "(untitled report)",
      subtitle: str(r.kind ?? r.category),
      status: str(r.status),
      updatedAt: num(r.updatedAt ?? r.updated_at ?? r.createdAt ?? r.created_at) ?? 0,
      fields: fields([
        ["Status", r.status],
        ["Kind", r.kind],
        ["Category", r.category],
        ["File", r.filePath ?? r.file_path],
      ]),
    });
  },

  /**
   * `lead` covers BOTH lead systems: the scraped lead-generation store
   * (src/services/lead-generation, the /leads route) and funnel-captured leads
   * (src/funnels). They are separate stores with separate id spaces, so try
   * each in turn rather than forcing a merge neither system asked for.
   */
  lead: async (id) => {
    try {
      const { getLeadService } = await import("../services/lead-generation/lead-service.js");
      const l = getLeadService().getLead(id);
      if (l) {
        return base("lead", id, {
          label: l.companyName || l.contactName || "(unnamed lead)",
          subtitle: [l.industry, l.city].filter(Boolean).join(" · "),
          status: str(l.status),
          updatedAt: num(l.lastUpdated) ?? 0,
          fields: fields([
            ["Status", l.status],
            ["Quality", l.quality],
            ["Source", l.source],
            ["Contact", l.contactName],
            ["Email", l.email ?? l.contactEmail],
            ["Phone", l.phone ?? l.contactPhone],
            ["Website", l.website],
            ["Saved to CRM", l.notionPageId ? "yes" : ""],
          ]),
        });
      }
    } catch {
      /* lead-generation service unavailable — fall through to funnels */
    }
    try {
      const { getFunnelStore } = await import("../funnels/store.js");
      const l = getFunnelStore()
        .listLeads()
        .find((row) => row.id === id);
      if (l) {
        return base("lead", id, {
          label: l.name || l.company || l.email || "(unnamed lead)",
          subtitle: [l.company, l.title].filter(Boolean).join(" · "),
          status: str(l.status),
          value: num(l.estimatedValue),
          updatedAt: num((l as unknown as Record<string, unknown>).updatedAt) ?? 0,
          fields: fields([
            ["Status", l.status],
            ["Priority", l.priority],
            ["Source", l.source],
            ["Score", l.score],
            ["Email", l.email],
            ["Phone", l.phone],
            ["Company", l.company],
            ["Funnel", l.funnelId],
          ]),
        });
      }
    } catch {
      /* funnel store unavailable */
    }
    return null;
  },

  funnel: async (id) => {
    const { getFunnelStore } = await import("../funnels/store.js");
    const f = getFunnelStore().getFunnel(id) as Record<string, unknown> | null;
    if (!f) return null;
    return base("funnel", id, {
      label: str(f.name) || "(untitled funnel)",
      subtitle: str(f.type ?? f.goal),
      status: str(f.status),
      updatedAt: num(f.updatedAt) ?? 0,
      fields: fields([
        ["Status", f.status],
        ["Type", f.type],
        ["Goal", f.goal],
        ["Slug", f.slug],
      ]),
    });
  },

  idea: async (id) => {
    const { getIdeaStore } = await import("../ideas/store.js");
    const i = getIdeaStore().get(id);
    if (!i) return null;
    return base("idea", id, {
      label: i.title || "(untitled idea)",
      subtitle: i.tags.join(", "),
      status: str(i.status),
      updatedAt: Date.parse(i.updatedAt) || 0,
      fields: fields([
        ["Status", i.status],
        ["Tags", i.tags],
        ["Review on", i.reviewOn],
        ["Body", i.body.slice(0, 280)],
      ]),
    });
  },

  /** A notes.* note (database role or the legacy file store). */
  note: async (id) => {
    const { getNote } = await import("../documents/notes-bridge.js");
    const n = getNote(id);
    if (!n) return null;
    return base("note", id, {
      label: n.name || "(untitled note)",
      subtitle: str(n.category) || (n.tags ?? []).join(", "),
      updatedAt: Date.parse(str(n.updatedAt)) || 0,
      fields: fields([
        ["Category", n.category],
        ["Tags", n.tags],
        ["Project", n.projectId],
        ["Excerpt", (n.body ?? "").slice(0, 280)],
      ]),
    });
  },

  /** A Documents-workspace doc node. */
  document: async (id) => {
    const { DocumentStore } = await import("../documents/store.js");
    const { resolve: resolvePath } = await import("node:path");
    const store = DocumentStore.at(resolvePath(resolveStateDir(), "documents"));
    if (!store.hasIndex()) return null;
    const d = store.getNode(id);
    if (!d || d.deletedAt) return null;
    return base("document", id, {
      label: d.title || "(untitled document)",
      subtitle: str(d.type ?? d.category ?? d.kind),
      updatedAt: Date.parse(d.updatedAt) || 0,
      fields: fields([
        ["Type", d.type],
        ["Category", d.category],
        ["Tags", d.tags],
        ["Excerpt", d.preview],
      ]),
    });
  },

  /** A workspace file by its Files-page path (relative to the files root). */
  file: async (id) => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { resolveFilesRoot } = await import("../ocr/runtime.js");
    const root = path.resolve(resolveFilesRoot());
    const abs = path.isAbsolute(id) ? path.normalize(id) : path.resolve(root, id);
    if (!path.isAbsolute(id) && !abs.startsWith(root + path.sep)) return null;
    let st: import("node:fs").Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return null;
    }
    return base("file", id, {
      label: path.basename(abs),
      subtitle: path.dirname(id) === "." ? "Files" : path.dirname(id),
      updatedAt: st.mtimeMs,
      fields: fields([
        ["Path", id],
        ["Size", st.isFile() ? `${Math.max(1, Math.round(st.size / 1024))} KB` : "folder"],
      ]),
    });
  },

  goal: async (id) => {
    const { getGoalStore } = await import("../autonomy/goals/store.js");
    const g = getGoalStore().get(id);
    if (!g) return null;
    return base("goal", id, {
      label: g.title || "(untitled goal)",
      subtitle: str(g.workdir),
      status: str(g.status),
      updatedAt: num(g.updatedAt) ?? 0,
      fields: fields([
        ["Status", g.status],
        ["Iterations", g.iterations.length],
        ["Workdir", g.workdir],
      ]),
    });
  },

  /** A synced calendar event, id `<source>:<eventId>` (bare ids search all sources). */
  event: async (id) => {
    const { listStoredEvents } = await import("../calendar/store.js");
    const idx = id.indexOf(":");
    const source = idx > 0 ? id.slice(0, idx) : "";
    const eventId = idx > 0 ? id.slice(idx + 1) : id;
    const events = await listStoredEvents(
      source === "google" || source === "calendly" ? { source } : undefined,
    );
    const e = events.find((x) => x.id === eventId);
    if (!e) return null;
    const when = e.startIso || e.startDate || "";
    return base("event", id, {
      label: e.summary || "(untitled event)",
      subtitle: when ? when.replace("T", " ").slice(0, 16) : "",
      status: str(e.status),
      updatedAt: e.remoteUpdatedAtMs ?? e.cachedAtMs ?? 0,
      fields: fields([
        ["When", when],
        ["Location", e.location],
        ["Source", e.source],
        ["Description", (e.description ?? "").slice(0, 280)],
      ]),
    });
  },

  /** People Network contact (name falls back to the linked CRM client's). */
  contact: async (id) => {
    const { getNetworkStore } = await import("../network/store.js");
    const c = getNetworkStore().getContact(id);
    if (!c) return null;
    let label = c.name;
    if (!label && c.clientId) label = (await findClientAnyAgency(c.clientId))?.name ?? "";
    return base("contact", id, {
      label: label || "(unnamed contact)",
      subtitle: [c.role, c.org].filter(Boolean).join(" · ") || str(c.contactType),
      status: str(c.status),
      updatedAt: num(c.updatedAt) ?? 0,
      fields: fields([
        ["Type", c.contactType],
        ["Org", c.org],
        ["Role", c.role],
        ["Last touch", c.lastTouchDate],
        ["Next action", c.nextAction],
      ]),
    });
  },

  connection: async (id) => {
    const { getNetworkStore } = await import("../network/store.js");
    const store = getNetworkStore();
    const cx = store.getConnection(id);
    if (!cx) return null;
    const nameOf = (nid: string) =>
      nid === "me" ? "You" : store.getContact(nid)?.name || nid.slice(0, 8);
    const total = cx.values.reduce((s, v) => s + (Number(v.estimatedValue) || 0), 0);
    return base("connection", id, {
      label: `${nameOf(cx.fromId)} ↔ ${nameOf(cx.toId)}`,
      subtitle: `${cx.relationshipType} · ${cx.strength}/5`,
      status: str(cx.status),
      value: total || null,
      updatedAt: num(cx.updatedAt) ?? 0,
      fields: fields([
        ["Relationship", cx.relationshipType],
        ["Strength", `${cx.strength}/5`],
        ["Value", cx.values.map((v) => v.description || v.valueType)],
        ["Last touch", cx.lastTouchDate],
      ]),
    });
  },
};

/**
 * Resolve one `(type, id)` to a display record. Never throws: an unknown type,
 * a missing row, or a store that blows up all degrade to `resolved: false`.
 */
export async function resolveObject(type: string, id: string): Promise<ResolvedObject> {
  if (!type || !id) return unresolved(type, id);
  const resolver = RESOLVERS[type];
  if (!resolver) return unresolved(type, id);
  try {
    const out = await resolver(id);
    return out ?? unresolved(type, id);
  } catch {
    return unresolved(type, id);
  }
}

/** Resolve many refs concurrently, preserving input order. */
export async function resolveObjects(
  refs: Array<{ type: string; id: string }>,
): Promise<ResolvedObject[]> {
  return Promise.all(refs.map((r) => resolveObject(r.type, r.id)));
}

// ═══════════════════════════════════════════════════════════════════
// ORIGIN INFERENCE (lead → client)
// ═══════════════════════════════════════════════════════════════════

/**
 * Find the lead a client originated from when no explicit edge exists.
 *
 * `leads.saveToCRM` stamps the created CRM page id onto the lead
 * (`lead.notionPageId`) but writes no relation back, so historic conversions
 * have no edge to traverse. Matching on that page id recovers the link for
 * every lead converted before this feature existed; email is the fallback for
 * clients created by hand from a lead.
 *
 * Returns inferred connections tagged with `edge: "lead_becomes_client"` and
 * `edgeMeta.inferred = true` so the UI can distinguish a real edge from a
 * recovered one.
 */
async function inferLeadOrigins(clientId: string): Promise<Connection[]> {
  const out: Connection[] = [];
  let notionPageId = "";
  let email = "";
  let name = "";
  try {
    const c = await findClientAnyAgency(clientId);
    if (!c) return out;
    notionPageId = c.notionPageId ?? "";
    email = (c.email ?? c.billingEmail ?? "").toLowerCase();
    name = (c.name ?? "").toLowerCase();
  } catch {
    return out;
  }
  if (!notionPageId && !email && !name) return out;

  const push = (o: ResolvedObject, note: string) => {
    out.push({
      ...o,
      relationId: `inferred:${o.type}:${o.id}`,
      edge: "lead_becomes_client",
      direction: "in",
      edgeMeta: { inferred: true, matchedOn: note },
    });
  };

  try {
    const { getLeadService } = await import("../services/lead-generation/lead-service.js");
    for (const l of getLeadService().getAllLeads()) {
      const byPage = notionPageId && l.notionPageId === notionPageId;
      const byEmail =
        !byPage &&
        email &&
        [l.email, l.contactEmail].some((e) => (e ?? "").toLowerCase() === email);
      if (!byPage && !byEmail) continue;
      const r = await resolveObject("lead", l.id);
      if (r.resolved) push(r, byPage ? "crm page id" : "email");
      if (out.length >= 5) break;
    }
  } catch {
    /* lead-generation service unavailable */
  }

  try {
    const { getFunnelStore } = await import("../funnels/store.js");
    for (const l of getFunnelStore().listLeads()) {
      const byEmail = email && (l.email ?? "").toLowerCase() === email;
      const byName = !byEmail && name && (l.company ?? "").toLowerCase() === name;
      if (!byEmail && !byName) continue;
      const r = await resolveObject("lead", l.id);
      if (r.resolved) push(r, byEmail ? "email" : "company name");
      // The funnel that captured the lead is itself a navigable origin card.
      if (l.funnelId) {
        const f = await resolveObject("funnel", l.funnelId);
        if (f.resolved && !out.some((x) => x.type === "funnel" && x.id === f.id)) {
          out.push({
            ...f,
            relationId: `inferred:funnel:${f.id}`,
            edge: "funnel_captured_lead",
            direction: "in",
            edgeMeta: { inferred: true, matchedOn: "funnel lead" },
          });
        }
      }
      if (out.length >= 8) break;
    }
  } catch {
    /* funnel store unavailable */
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * The resolved, depth-1 connected neighborhood of one object, grouped by
 * neighbor type and ordered so the types a user acts on land first.
 */
export async function connectionsFor(
  type: string,
  id: string,
  opts: { inferOrigins?: boolean } = {},
): Promise<{ root: ResolvedObject; groups: ConnectionGroup[]; total: number }> {
  const root = await resolveObject(type, id);

  let edges: ObjectRelation[] = [];
  try {
    edges = getRelationsStore().linksAround(type, id);
  } catch {
    edges = [];
  }

  const seen = new Set<string>();
  const conns: Connection[] = [];
  for (const rel of edges) {
    const isOut = rel.fromType === type && rel.fromId === id;
    const nType = isOut ? rel.toType : rel.fromType;
    const nId = isOut ? rel.toId : rel.fromId;
    if (nType === type && nId === id) continue; // self-edge
    const key = `${nType}::${nId}::${rel.edge}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resolvedNode = await resolveObject(nType, nId);
    conns.push({
      ...resolvedNode,
      relationId: rel.id,
      edge: rel.edge,
      direction: isOut ? "out" : "in",
      edgeMeta: rel.meta ?? {},
    });
  }

  if (opts.inferOrigins && type === "client") {
    for (const inferredConn of await inferLeadOrigins(id)) {
      const key = `${inferredConn.type}::${inferredConn.id}::${inferredConn.edge}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conns.push(inferredConn);
    }
  }

  // Group order: the objects a user acts on, then the ones they reference.
  const ORDER = [
    "opportunity",
    "project",
    "task",
    "report",
    "commitment",
    "person",
    "product",
    "decision",
    "risk",
    "issue",
    "lead",
    "funnel",
    "client",
    "contact",
    "connection",
    "note",
    "document",
    "file",
    "idea",
    "goal",
    "event",
  ];
  const byType = new Map<string, Connection[]>();
  for (const c of conns) {
    const arr = byType.get(c.type) ?? [];
    arr.push(c);
    byType.set(c.type, arr);
  }
  const groups: ConnectionGroup[] = [...byType.entries()]
    .sort((a, b) => {
      const ai = ORDER.indexOf(a[0]);
      const bi = ORDER.indexOf(b[0]);
      return (ai < 0 ? ORDER.length : ai) - (bi < 0 ? ORDER.length : bi);
    })
    .map(([t, items]) => ({
      type: t,
      label: typeGroupLabel(t),
      // Newest first within a group; unresolved rows sink to the bottom.
      items: items.sort((a, b) => {
        if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      }),
    }));

  return { root, groups, total: conns.length };
}
