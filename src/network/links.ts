/**
 * People Network cross-object links — a contact or connection tied to any
 * other workspace object (project, note, document, file, idea, task, goal,
 * report, client, opportunity, calendar event, and the rest of the Business
 * Control Layer objects).
 *
 * No parallel store: every link is one row in the shared typed-edge relations
 * store (src/relations). The network object is always `from`:
 *
 *   contact    --contact_linked_to-->    <any type>
 *   connection --connection_linked_to--> <any type>
 *
 * Opportunities keep their dedicated edges (`contact_involved_in_opportunity`
 * / `connection_supports_opportunity`) so the graph's deal maths and the old
 * `network.opportunities.*` RPCs see links made here, and vice versa.
 *
 * Reads go both ways: `linksForNetworkObject` ("what is Ana linked to") and
 * `peopleForObject` ("who is on this project"), the latter folding connection
 * links into their two endpoint contacts.
 */

import { getAuditStore } from "../business-objects/audit.js";
import { resolveStateDir } from "../config/paths.js";
import { getOpportunityStore } from "../opportunity/store.js";
import { resolveObject, typeGroupLabel, type ResolvedObject } from "../relations/resolve.js";
import { getRelationsStore } from "../relations/store.js";
import type { ObjectRelation } from "../relations/types.js";
import { connectionValueTotal, isOpenStage } from "./graph.js";
import {
  EDGE_CONNECTION_OPP,
  EDGE_CONTACT_OPP,
  getNetworkGraph,
  linkOpportunity,
  NETWORK_AGENT,
  searchClients,
  unlinkOpportunity,
} from "./service.js";
import { getNetworkStore } from "./store.js";
import { ME_ID, type NetworkNode } from "./types.js";

export type NetworkKind = "contact" | "connection";

export const EDGE_CONTACT_LINK = "contact_linked_to";
export const EDGE_CONNECTION_LINK = "connection_linked_to";

/**
 * Object types a contact / connection can be linked to, in picker order.
 * `report` covers research reports (the Research page lists reports).
 */
export const LINKABLE_TYPES = [
  "project",
  "task",
  "note",
  "document",
  "file",
  "idea",
  "goal",
  "report",
  "client",
  "opportunity",
  "event",
  "product",
  "decision",
  "risk",
  "commitment",
  "issue",
  "lead",
] as const;
export type LinkableType = (typeof LINKABLE_TYPES)[number];

export function isLinkableType(t: string): t is LinkableType {
  return (LINKABLE_TYPES as readonly string[]).includes(t);
}

export function linkEdgeFor(kind: NetworkKind, objectType: string): string {
  if (objectType === "opportunity")
    return kind === "contact" ? EDGE_CONTACT_OPP : EDGE_CONNECTION_OPP;
  return kind === "contact" ? EDGE_CONTACT_LINK : EDGE_CONNECTION_LINK;
}

const LINK_EDGES = new Set([
  EDGE_CONTACT_LINK,
  EDGE_CONNECTION_LINK,
  EDGE_CONTACT_OPP,
  EDGE_CONNECTION_OPP,
]);

/** One linked object as the UI / AI see it. */
export interface LinkedItem {
  relationId: string;
  edge: string;
  type: string;
  id: string;
  label: string;
  subtitle: string;
  status: string;
  tone: ResolvedObject["tone"];
  value: number | null;
  resolved: boolean;
  role: string;
  createdAt: number;
  createdBy: string;
}

export interface LinkedGroup {
  type: string;
  label: string;
  items: LinkedItem[];
}

function assertKind(kind: string): asserts kind is NetworkKind {
  if (kind !== "contact" && kind !== "connection")
    throw new Error('kind must be "contact" or "connection"');
}

function networkObjectExists(kind: NetworkKind, id: string): boolean {
  const store = getNetworkStore();
  return kind === "contact" ? Boolean(store.getContact(id)) : Boolean(store.getConnection(id));
}

function toItem(rel: ObjectRelation, r: ResolvedObject): LinkedItem {
  return {
    relationId: rel.id,
    edge: rel.edge,
    type: r.type,
    id: r.id,
    label: r.label,
    subtitle: r.subtitle,
    status: r.status,
    tone: r.tone,
    value: r.value,
    resolved: r.resolved,
    role: typeof rel.meta?.role === "string" ? rel.meta.role : "",
    createdAt: rel.createdAt,
    createdBy: rel.createdBy,
  };
}

function groupItems(items: LinkedItem[]): LinkedGroup[] {
  const byType = new Map<string, LinkedItem[]>();
  for (const it of items) {
    const arr = byType.get(it.type) ?? [];
    arr.push(it);
    byType.set(it.type, arr);
  }
  const order = LINKABLE_TYPES as readonly string[];
  return [...byType.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
    })
    .map(([type, list]) => ({ type, label: typeGroupLabel(type), items: list }));
}

/** Everything one contact / connection is linked to, resolved and grouped by type. */
export async function linksForNetworkObject(
  kind: NetworkKind,
  id: string,
): Promise<{ groups: LinkedGroup[]; total: number }> {
  assertKind(kind);
  const rels = getRelationsStore()
    .linksFrom(kind, id)
    .filter((r) => LINK_EDGES.has(r.edge));
  const items = await Promise.all(
    rels.map(async (rel) => toItem(rel, await resolveObject(rel.toType, rel.toId))),
  );
  return { groups: groupItems(items), total: items.length };
}

/** Link a contact / connection to any linkable object. Idempotent per (from, edge, to). */
export async function linkObject(p: {
  kind: NetworkKind;
  id: string;
  objectType: string;
  objectId: string;
  role?: string;
  actor?: string;
}): Promise<{ relationId: string; created: boolean; item: LinkedItem }> {
  assertKind(p.kind);
  if (!p.id || !p.objectType || !p.objectId)
    throw new Error("id, objectType and objectId are required");
  if (!isLinkableType(p.objectType))
    throw new Error(
      `objectType "${p.objectType}" is not linkable (expected one of: ${LINKABLE_TYPES.join(", ")})`,
    );
  if (!networkObjectExists(p.kind, p.id)) throw new Error(`${p.kind} "${p.id}" not found`);
  const actor = p.actor || "user";
  if (p.objectType === "opportunity") {
    const before = getRelationsStore().findMatch({
      fromType: p.kind,
      fromId: p.id,
      edge: linkEdgeFor(p.kind, "opportunity"),
      toType: "opportunity",
      toId: p.objectId,
    });
    const r = linkOpportunity({
      kind: p.kind,
      id: p.id,
      opportunityId: p.objectId,
      role: p.role,
      actor,
    });
    const resolved = await resolveObject("opportunity", p.objectId);
    return { relationId: r.edge.id, created: !before, item: toItem(r.edge, resolved) };
  }
  const resolved = await resolveObject(p.objectType, p.objectId);
  if (!resolved.resolved) throw new Error(`${p.objectType} "${p.objectId}" not found`);
  const rel = getRelationsStore();
  const edge = linkEdgeFor(p.kind, p.objectType);
  const before = rel.findMatch({
    fromType: p.kind,
    fromId: p.id,
    edge,
    toType: p.objectType,
    toId: p.objectId,
  });
  const row =
    before ??
    rel.create({
      fromType: p.kind,
      fromId: p.id,
      edge,
      toType: p.objectType,
      toId: p.objectId,
      createdBy: actor === "user" ? NETWORK_AGENT : actor,
      meta: p.role ? { role: p.role } : {},
    });
  if (!before) {
    getNetworkStore().record(
      p.kind,
      p.id,
      "link.added",
      "",
      `${p.objectType}: ${resolved.label}`,
      actor,
    );
    getAuditStore().log({
      what: `Linked ${p.kind} to ${p.objectType} "${resolved.label}"`,
      trigger: "network.links.add",
      agent: NETWORK_AGENT,
      action: `${p.kind} ${p.id} → ${p.objectType} ${p.objectId}`,
      objectType: p.kind,
      objectId: p.id,
      meta: { objectType: p.objectType, objectId: p.objectId, relationId: row.id, actor },
    });
  }
  return { relationId: row.id, created: !before, item: toItem(row, resolved) };
}

/**
 * Remove a link — by `relationId`, or by `(kind, id, objectType, objectId)`.
 * Only network link edges can be removed here (never an unrelated objrel row).
 */
export function unlinkObject(p: {
  relationId?: string;
  kind?: string;
  id?: string;
  objectType?: string;
  objectId?: string;
  actor?: string;
}): number {
  const actor = p.actor || "user";
  const rel = getRelationsStore();
  let row: ObjectRelation | null = null;
  if (p.relationId) {
    row = rel.get(p.relationId);
    if (!row) return 0;
    if (!LINK_EDGES.has(row.edge) || (row.fromType !== "contact" && row.fromType !== "connection"))
      throw new Error(`relation "${p.relationId}" is not a network link`);
  } else {
    const kind = String(p.kind ?? "");
    assertKind(kind);
    if (!p.id || !p.objectType || !p.objectId)
      throw new Error("relationId, or kind + id + objectType + objectId, is required");
    row = rel.findMatch({
      fromType: kind,
      fromId: p.id,
      edge: linkEdgeFor(kind, p.objectType),
      toType: p.objectType,
      toId: p.objectId,
    });
    if (!row) return 0;
  }
  const kind = row.fromType as NetworkKind;
  if (row.toType === "opportunity")
    return unlinkOpportunity({ kind, id: row.fromId, opportunityId: row.toId, actor });
  const n = rel.delete(row.id) ? 1 : 0;
  if (n) {
    getNetworkStore().record(
      kind,
      row.fromId,
      "link.removed",
      `${row.toType}: ${row.toId}`,
      "",
      actor,
    );
    getAuditStore().log({
      what: `Unlinked ${kind} from ${row.toType} ${row.toId}`,
      trigger: "network.links.remove",
      agent: NETWORK_AGENT,
      objectType: kind,
      objectId: row.fromId,
      meta: { objectType: row.toType, objectId: row.toId, relationId: row.id, actor },
    });
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════
// OBJECT SIDE — who is linked to this project / note / task …
// ═══════════════════════════════════════════════════════════════════

/** A linked person as an object page / agent sees it. */
export interface LinkedPerson {
  contactId: string;
  name: string;
  org: string;
  role: string;
  contactType: string;
  status: string;
  /** How they are tied in: directly, or through a linked connection. */
  via: "contact" | "connection";
  /** Relation row to unlink (direct links only; connection links share one row). */
  relationId: string;
  connectionId: string;
  linkRole: string;
  relationshipValue: number;
  pipelineValue: number;
  openOpportunities: number;
  nextAction: string;
  staleDays: number | null;
}

export async function peopleForObject(
  objectType: string,
  objectId: string,
): Promise<{ people: LinkedPerson[]; text: string }> {
  if (!objectType || !objectId) throw new Error("objectType and objectId are required");
  const rels = getRelationsStore()
    .linksTo(objectType, objectId)
    .filter(
      (r) => LINK_EDGES.has(r.edge) && (r.fromType === "contact" || r.fromType === "connection"),
    );
  if (!rels.length) return { people: [], text: "" };
  const graph = await getNetworkGraph();
  const nodes = new Map<string, NetworkNode>(graph.nodes.map((n) => [n.id, n]));
  const store = getNetworkStore();
  const out = new Map<string, LinkedPerson>();
  const add = (
    contactId: string,
    via: LinkedPerson["via"],
    rel: ObjectRelation,
    connectionId = "",
  ) => {
    if (contactId === ME_ID || out.has(contactId)) return;
    const n = nodes.get(contactId);
    if (!n) return;
    out.set(contactId, {
      contactId,
      name: n.name,
      org: n.org,
      role: n.role,
      contactType: n.contactType,
      status: n.status,
      via,
      relationId: rel.id,
      connectionId,
      linkRole: typeof rel.meta?.role === "string" ? rel.meta.role : "",
      relationshipValue: n.relationshipValue,
      pipelineValue: n.pipelineValue,
      openOpportunities: n.openOpportunities,
      nextAction: n.nextAction,
      staleDays: n.staleDays,
    });
  };
  // Direct contact links first so a person linked both ways reads as direct.
  for (const r of rels) if (r.fromType === "contact") add(r.fromId, "contact", r);
  for (const r of rels) {
    if (r.fromType !== "connection") continue;
    const cx = store.getConnection(r.fromId);
    if (!cx) continue;
    add(cx.fromId, "connection", r, cx.id);
    add(cx.toId, "connection", r, cx.id);
  }
  const people = [...out.values()];
  return { people, text: peopleText(objectType, people) };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Compact decision context: one line per linked person. */
export function peopleText(objectType: string, people: LinkedPerson[]): string {
  if (!people.length) return "";
  const lines = people.map((p) => {
    const bits = [
      p.role || p.org ? [p.role, p.org].filter(Boolean).join(" @ ") : p.contactType,
      p.status,
      p.relationshipValue ? `relationship value ${money(p.relationshipValue)}` : "",
      p.openOpportunities
        ? `${p.openOpportunities} open opportunit${p.openOpportunities === 1 ? "y" : "ies"} (${money(p.pipelineValue)})`
        : "",
      p.linkRole ? `role here: ${p.linkRole}` : "",
      p.via === "connection" ? "via a linked relationship" : "",
      p.nextAction ? `next: ${p.nextAction}` : "",
      p.staleDays != null && p.staleDays > 45 ? `last touch ${p.staleDays}d ago` : "",
    ].filter(Boolean);
    return `- ${p.name} [contact ${p.contactId}] — ${bits.join("; ")}`;
  });
  return `Linked people on this ${objectType} (My Network):\n${lines.join("\n")}`;
}

/** Best-effort people block for agent context builders; never throws. */
export async function linkedPeopleContext(objectType: string, objectId: string): Promise<string> {
  try {
    return (await peopleForObject(objectType, objectId)).text;
  } catch {
    return "";
  }
}

/**
 * Fields to spread into an agent tool result for a project / note / task:
 * `{ linkedPeople, linkedPeopleContext }` when anyone is linked, else `{}`.
 * Never throws — a missing network store just adds nothing.
 */
export async function linkedPeopleFields(
  objectType: string,
  objectId: string,
): Promise<{ linkedPeople?: LinkedPerson[]; linkedPeopleContext?: string }> {
  try {
    const r = await peopleForObject(objectType, objectId);
    return r.people.length ? { linkedPeople: r.people, linkedPeopleContext: r.text } : {};
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════
// GRAPH SATELLITES
// ═══════════════════════════════════════════════════════════════════

/** Every non-opportunity link in the network, resolved, for satellite nodes + filters. */
export async function allNetworkLinks(limit = 600): Promise<
  Array<{
    relationId: string;
    kind: NetworkKind;
    fromId: string;
    type: string;
    id: string;
    label: string;
    resolved: boolean;
  }>
> {
  const rel = getRelationsStore();
  const rows = [
    ...rel.list({ edge: EDGE_CONTACT_LINK }),
    ...rel.list({ edge: EDGE_CONNECTION_LINK }),
  ].slice(0, limit);
  const cache = new Map<string, ResolvedObject>();
  const out = [];
  for (const r of rows) {
    const key = `${r.toType}::${r.toId}`;
    let resolved = cache.get(key);
    if (!resolved) {
      resolved = await resolveObject(r.toType, r.toId);
      cache.set(key, resolved);
    }
    out.push({
      relationId: r.id,
      kind: r.fromType as NetworkKind,
      fromId: r.fromId,
      type: r.toType,
      id: r.toId,
      label: resolved.label,
      resolved: resolved.resolved,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// PICKER SEARCH — candidates across every linkable type
// ═══════════════════════════════════════════════════════════════════

export interface LinkCandidate {
  type: string;
  id: string;
  label: string;
  subtitle: string;
}

type Loader = (q: string, limit: number) => Promise<LinkCandidate[]>;

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const match = (q: string, ...parts: unknown[]) =>
  !q || parts.map(s).join(" ").toLowerCase().includes(q);

async function walkFiles(q: string, limit: number): Promise<LinkCandidate[]> {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { resolveFilesRoot } = await import("../ocr/runtime.js");
  const root = path.resolve(resolveFilesRoot());
  const out: LinkCandidate[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 4 || visited > 4000) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || visited++ > 4000) return;
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.isFile() && match(q, e.name)) {
        const rel = path.relative(root, abs);
        out.push({
          type: "file",
          id: rel,
          label: e.name,
          subtitle: path.dirname(rel) === "." ? "Files" : path.dirname(rel),
        });
      }
    }
  };
  walk(root, 0);
  return out;
}

const LOADERS: Record<LinkableType, Loader> = {
  project: async (q, limit) => {
    // Board projects: local-first role databases (Notion off) + the kanban
    // mirror / legacy sessions that projects.list serves; de-duplicated by id.
    let rows: Array<Record<string, unknown>> = [];
    try {
      const ops = await import("../databases/kanban-store-ops.js");
      rows = ops.listProjects() as unknown as Array<Record<string, unknown>>;
    } catch {
      rows = [];
    }
    try {
      const { projectsList } = await import("../gateway/server-methods/projects.js");
      const seen = new Set(rows.map((r) => s(r.id)));
      for (const p of (await projectsList()).sessions as unknown as Array<Record<string, unknown>>)
        if (!seen.has(s(p.id ?? p.projectId))) rows.push(p);
    } catch {
      /* legacy store unavailable */
    }
    return rows
      .filter((p) => match(q, p.name, p.title, p.projectId))
      .slice(0, limit)
      .map((p) => ({
        type: "project",
        id: s(p.id ?? p.projectId),
        label: s(p.name ?? p.title) || s(p.id),
        subtitle: s(p.status),
      }));
  },
  task: async (q, limit) => {
    let rows: Array<Record<string, unknown>> = [];
    try {
      const ops = await import("../databases/kanban-store-ops.js");
      rows = ops.listTasks() as unknown as Array<Record<string, unknown>>;
    } catch {
      rows = [];
    }
    if (!rows.length) {
      const { getKanbanStore } = await import("../tasks/store.js");
      rows = getKanbanStore().getRecentTasks(500) as unknown as Array<Record<string, unknown>>;
    }
    return rows
      .filter((t) => match(q, t.title, t.description))
      .slice(0, limit)
      .map((t) => ({
        type: "task",
        id: s(t.id),
        label: s(t.title) || s(t.id),
        subtitle: s(t.status),
      }));
  },
  note: async (q, limit) => {
    const { listAllNotes } = await import("../documents/notes-bridge.js");
    return listAllNotes()
      .filter((n) => match(q, n.name, n.tags?.join(" "), n.category))
      .sort((a, b) => s(b.updatedAt).localeCompare(s(a.updatedAt)))
      .slice(0, limit)
      .map((n) => ({ type: "note", id: n.id, label: n.name, subtitle: s(n.category) }));
  },
  document: async (q, limit) => {
    const { DocumentStore } = await import("../documents/store.js");
    const { resolve } = await import("node:path");
    const store = DocumentStore.at(resolve(resolveStateDir(), "documents"));
    if (!store.hasIndex()) return [];
    return store
      .tree()
      .filter(
        (d) =>
          d.kind === "doc" && d.source?.type !== "note" && match(q, d.title, d.tags?.join(" ")),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((d) => ({
        type: "document",
        id: d.id,
        label: d.title,
        subtitle: s(d.type ?? d.category),
      }));
  },
  file: walkFiles,
  idea: async (q, limit) => {
    const { getIdeaStore } = await import("../ideas/store.js");
    return getIdeaStore()
      .list({})
      .filter((i) => match(q, i.title, i.tags.join(" ")))
      .slice(0, limit)
      .map((i) => ({ type: "idea", id: i.id, label: i.title, subtitle: s(i.status) }));
  },
  goal: async (q, limit) => {
    const { getGoalStore } = await import("../autonomy/goals/store.js");
    return getGoalStore()
      .list({ limit: 300 })
      .filter((g) => match(q, g.title))
      .slice(0, limit)
      .map((g) => ({ type: "goal", id: g.id, label: g.title, subtitle: s(g.status) }));
  },
  report: async (q, limit) => {
    const { getReportsStore } = await import("../reports/store.js");
    return getReportsStore()
      .listReports({ limit: 400 })
      .reports.map((r) => r as unknown as Record<string, unknown>)
      .filter((r) => match(q, r.title, r.kind, r.category))
      .slice(0, limit)
      .map((r) => ({
        type: "report",
        id: s(r.id),
        label: s(r.title) || s(r.id),
        subtitle: s(r.kind),
      }));
  },
  client: async (q, limit) =>
    (await searchClients(q, { limit })).map((c) => ({
      type: "client",
      id: c.id,
      label: c.name,
      subtitle: c.pipelineStatus,
    })),
  opportunity: async (q, limit) =>
    getOpportunityStore()
      .list()
      .filter((o) => match(q, o.name))
      .slice(0, limit)
      .map((o) => ({
        type: "opportunity",
        id: o.id,
        label: o.name,
        subtitle: `${s(o.stage)}${isOpenStage(String(o.stage)) && o.estimatedValue ? ` · ${money(Number(o.estimatedValue))}` : ""}`,
      })),
  event: async (q, limit) => {
    const { listStoredEvents } = await import("../calendar/store.js");
    return (await listStoredEvents())
      .filter((e) => match(q, e.summary, e.location))
      .slice(-limit)
      .reverse()
      .map((e) => ({
        type: "event",
        id: `${e.source}:${e.id}`,
        label: e.summary || "(untitled event)",
        subtitle: (e.startIso || e.startDate || "").replace("T", " ").slice(0, 16),
      }));
  },
  product: async (q, limit) => {
    const { getProductStore } = await import("../product/store.js");
    return getProductStore()
      .list()
      .filter((p) => match(q, p.name))
      .slice(0, limit)
      .map((p) => ({ type: "product", id: p.id, label: p.name, subtitle: s(p.productType) }));
  },
  decision: async (q, limit) => {
    const { getDecisionStore } = await import("../decision/store.js");
    return getDecisionStore()
      .list()
      .filter((d) => match(q, d.title))
      .slice(0, limit)
      .map((d) => ({ type: "decision", id: d.id, label: d.title, subtitle: s(d.status) }));
  },
  risk: async (q, limit) => {
    const { getRiskStore } = await import("../risk/store.js");
    return getRiskStore()
      .list()
      .filter((r) => match(q, r.title))
      .slice(0, limit)
      .map((r) => ({ type: "risk", id: r.id, label: r.title, subtitle: s(r.category) }));
  },
  commitment: async (q, limit) => {
    const { getCommitmentStore } = await import("../commitment/store.js");
    return getCommitmentStore()
      .list()
      .filter((c) => match(q, c.name))
      .slice(0, limit)
      .map((c) => ({ type: "commitment", id: c.id, label: c.name, subtitle: s(c.status) }));
  },
  issue: async (q, limit) => {
    const { getIssuesStore } = await import("../issues/store.js");
    return getIssuesStore()
      .list()
      .map((i) => i as unknown as Record<string, unknown>)
      .filter((i) => match(q, i.title))
      .slice(0, limit)
      .map((i) => ({ type: "issue", id: s(i.id), label: s(i.title), subtitle: s(i.status) }));
  },
  lead: async (q, limit) => {
    try {
      const { getLeadService } = await import("../services/lead-generation/lead-service.js");
      return getLeadService()
        .getAllLeads()
        .filter((l) => match(q, l.companyName, l.contactName))
        .slice(0, limit)
        .map((l) => ({
          type: "lead",
          id: l.id,
          label: l.companyName || l.contactName || l.id,
          subtitle: s(l.status),
        }));
    } catch {
      return [];
    }
  },
};

/**
 * Search linkable objects. Each type's loader reads the same store its own
 * `*.list` RPC serves, and is isolated: a missing / failing store contributes
 * nothing instead of failing the picker.
 */
export async function searchLinkables(
  query: string,
  opts: { types?: string[]; limit?: number } = {},
): Promise<{ results: LinkCandidate[]; byType: Record<string, number> }> {
  const q = query.trim().toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
  const types = (opts.types?.length ? opts.types : [...LINKABLE_TYPES]).filter(isLinkableType);
  const lists = await Promise.all(
    types.map(async (t) => {
      try {
        return (await LOADERS[t](q, limit)).filter((c) => c.id);
      } catch {
        return [];
      }
    }),
  );
  const byType: Record<string, number> = {};
  types.forEach((t, i) => (byType[t] = lists[i].length));
  return { results: lists.flat(), byType };
}

/** Sum of `$` value on one connection (re-exported for the tool's summary). */
export { connectionValueTotal };
