/**
 * People Network service — the I/O side. Loads the network store, the
 * opportunity store, the typed-edge relations and the CRM clients, and hands
 * them to the pure builders in ./graph.ts. Shared by the gateway `network.*`
 * handlers and the `people_network` agent tool so both see identical data.
 */

import { getAuditStore } from "../business-objects/audit.js";
import { resolveStateDir } from "../config/paths.js";
import { getOpportunityStore } from "../opportunity/store.js";
import { getRelationsStore } from "../relations/store.js";
import {
  buildContactContext,
  buildNetworkGraph,
  buildOpportunityContext,
  buildOverviewContext,
  findWarmPath,
  opportunitiesByNode,
  type GraphInput,
  type OpportunityLink,
  type OpportunityLite,
} from "./graph.js";
import { getNetworkStore } from "./store.js";
import { FREQUENCY_WINDOW_DAYS, warmTrend } from "./warm.js";
import { ME_ID, type Contact, type LinkedClientSummary, type NetworkGraph } from "./types.js";

export const NETWORK_AGENT = "network-agent";
export const EDGE_CONTACT_OPP = "contact_involved_in_opportunity";
export const EDGE_CONNECTION_OPP = "connection_supports_opportunity";

/** Minimal slice of the agency store this module reads. */
interface ClientRow {
  id: string;
  name: string;
  pipelineStatusLabel?: string;
  pipelineStatus?: string;
  email: string | null;
  phone: string | null;
  billingEmail?: string | null;
  whatsapp?: string | null;
  telegram?: string | null;
  instagram?: string | null;
}
interface ClientSource {
  getClient(id: string, agencyId?: string): ClientRow | null;
  listClients(agencyId?: string): ClientRow[];
}

let clientSourceOverride: ClientSource | null | undefined;
/** Test seam: replace the agency.db client reader (null = no clients). */
export function setNetworkClientSourceForTest(src: ClientSource | null | undefined): void {
  clientSourceOverride = src;
}

async function clientSource(): Promise<ClientSource | null> {
  if (clientSourceOverride !== undefined) return clientSourceOverride;
  try {
    const { getAgencyOperationsStore } = await import("../agency-operations/store.js");
    return getAgencyOperationsStore(resolveStateDir()) as unknown as ClientSource;
  } catch {
    return null;
  }
}

async function resolveAgencyId(agencyId?: string): Promise<string> {
  if (agencyId?.trim()) return agencyId.trim();
  try {
    const { activeAgencyId } = await import("../ideas/client-source.js");
    return activeAgencyId();
  } catch {
    return "default";
  }
}

function toSummary(c: ClientRow): LinkedClientSummary {
  return {
    id: c.id,
    name: c.name,
    pipelineStatus: c.pipelineStatusLabel || c.pipelineStatus || "",
    email: c.email ?? c.billingEmail ?? null,
    phone: c.phone ?? null,
  };
}

/** Look a client up in the active business, then the "default" agency. */
export async function findClient(clientId: string, agencyId?: string): Promise<ClientRow | null> {
  const src = await clientSource();
  if (!src || !clientId) return null;
  const agency = await resolveAgencyId(agencyId);
  try {
    return (
      src.getClient(clientId, agency) ??
      (agency !== "default" ? src.getClient(clientId, "default") : null)
    );
  } catch {
    return null;
  }
}

/** Client picker for "add from clients": name search over the active business. */
export async function searchClients(
  query: string,
  opts: { agencyId?: string; limit?: number } = {},
): Promise<Array<LinkedClientSummary & { inNetwork: string | null }>> {
  const src = await clientSource();
  if (!src) return [];
  const agency = await resolveAgencyId(opts.agencyId);
  let rows: ClientRow[] = [];
  try {
    rows = src.listClients(agency);
    if (!rows.length && agency !== "default") rows = src.listClients("default");
  } catch {
    rows = [];
  }
  const q = query.trim().toLowerCase();
  if (q)
    rows = rows.filter((r) =>
      [r.name, r.email ?? "", r.phone ?? ""].join(" ").toLowerCase().includes(q),
    );
  const store = getNetworkStore();
  return rows.slice(0, Math.min(Math.max(opts.limit ?? 25, 1), 100)).map((r) => ({
    ...toSummary(r),
    inNetwork: store.findContactByClient(r.id)?.id ?? null,
  }));
}

/** Gather every input the graph builder needs. */
export async function loadGraphInput(
  opts: { agencyId?: string; meLabel?: string } = {},
): Promise<GraphInput> {
  const store = getNetworkStore();
  const contacts = store.listContacts();
  const connections = store.listConnections();
  let opportunities: OpportunityLite[] = [];
  try {
    opportunities = getOpportunityStore()
      .list()
      .map((o) => ({
        id: o.id,
        name: o.name,
        stage: String(o.stage),
        estimatedValue: Number(o.estimatedValue) || 0,
        nextAction: o.nextAction ?? "",
        nextActionDate: o.nextActionDate ?? "",
        owner: o.owner,
        clientId: o.clientId ?? "",
      }));
  } catch {
    opportunities = [];
  }
  const rel = getRelationsStore();
  const links: OpportunityLink[] = [];
  for (const r of rel.list({ edge: EDGE_CONTACT_OPP }))
    links.push({
      kind: "contact",
      fromId: r.fromId,
      opportunityId: r.toId,
      role: str(r.meta.role),
    });
  for (const r of rel.list({ edge: EDGE_CONNECTION_OPP }))
    links.push({
      kind: "connection",
      fromId: r.fromId,
      opportunityId: r.toId,
      role: str(r.meta.role),
    });
  const clientOpportunityIds = new Map<string, string[]>();
  for (const r of rel.list({ edge: "client_has_opportunity" })) {
    const list = clientOpportunityIds.get(r.fromId) ?? [];
    list.push(r.toId);
    clientOpportunityIds.set(r.fromId, list);
  }
  // Live client summaries for linked contacts + clients with open deals.
  const clients = new Map<string, LinkedClientSummary>();
  const wanted = new Set<string>();
  for (const c of contacts) if (c.clientId) wanted.add(c.clientId);
  for (const o of opportunities)
    if (o.clientId && !["Won", "Lost", "Hold"].includes(o.stage)) wanted.add(o.clientId);
  for (const id of wanted) {
    const row = await findClient(id, opts.agencyId);
    if (row) clients.set(id, toSummary(row));
  }
  // Warm-score inputs: recent tracked interactions + linked workspace objects.
  const activity = store.activityCounts(Date.now() - FREQUENCY_WINDOW_DAYS * 86_400_000);
  const linkCounts = new Map<string, number>();
  for (const r of rel.list({ edge: "contact_linked_to" }))
    linkCounts.set(r.fromId, (linkCounts.get(r.fromId) ?? 0) + 1);
  return {
    contacts,
    connections,
    opportunities,
    links,
    clients,
    clientOpportunityIds,
    activity,
    linkCounts,
    meLabel: opts.meLabel,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Trend baseline: the score about a week ago (or the oldest point in the last 30 days). */
const TREND_LOOKBACK_MS = 7 * 86_400_000;

/**
 * Snapshot warm scores (for the trend line) and stamp each node's trend.
 * Best-effort: a history write failure never breaks a graph read.
 */
export function applyWarmTrends(graph: NetworkGraph, now = Date.now()): NetworkGraph {
  try {
    const store = getNetworkStore();
    store.recordWarmScores(
      graph.nodes.map((n) => ({ id: n.id, score: n.warmScore })),
      now,
    );
    const baseline = store.warmBaseline(now - TREND_LOOKBACK_MS);
    const earliest = store.warmEarliest(now - 30 * 86_400_000);
    for (const n of graph.nodes) {
      const prev = baseline.get(n.id) ?? earliest.get(n.id);
      n.warmTrend = warmTrend(n.warmScore, prev);
      n.warmDelta = prev === undefined ? null : n.warmScore - prev;
    }
  } catch {
    /* trend is decoration */
  }
  return graph;
}

export async function getNetworkGraph(opts: { agencyId?: string } = {}): Promise<NetworkGraph> {
  return applyWarmTrends(buildNetworkGraph(await loadGraphInput(opts)));
}

/** A contact with its linked client hydrated (name falls back to the client's). */
export async function hydrateContact(c: Contact, agencyId?: string): Promise<Contact> {
  if (!c.clientId) return { ...c, client: null };
  const row = await findClient(c.clientId, agencyId);
  const client = row ? toSummary(row) : null;
  return { ...c, name: c.name || client?.name || "", client };
}

export async function warmPath(toId: string, fromId = ME_ID) {
  const store = getNetworkStore();
  const names = new Map(store.listContacts().map((c) => [c.id, c.name] as const));
  // Clients-only contacts have no own name; the path should still read well.
  for (const c of store.listContacts())
    if (!c.name && c.clientId) names.set(c.id, (await findClient(c.clientId))?.name ?? c.id);
  return findWarmPath(store.listConnections(), toId, fromId, names);
}

/**
 * AI decision context. `contactId` → one person; `opportunityId` → who is
 * involved in a deal and how to reach them; neither → whole-network overview.
 */
export async function networkContext(opts: {
  contactId?: string;
  opportunityId?: string;
  /** Any linked object (project, note, task, …) → who is linked to it. */
  objectType?: string;
  objectId?: string;
  agencyId?: string;
}): Promise<Record<string, unknown>> {
  const links = await import("./links.js");
  if (opts.objectType && opts.objectId && !opts.contactId && !opts.opportunityId) {
    const r = await links.peopleForObject(opts.objectType, opts.objectId);
    return {
      found: true,
      scope: "object",
      objectType: opts.objectType,
      objectId: opts.objectId,
      people: r.people,
      text: r.text || `No people from My Network are linked to this ${opts.objectType}.`,
    };
  }
  const input = await loadGraphInput(opts);
  const graph = applyWarmTrends(buildNetworkGraph(input));
  const store = getNetworkStore();
  if (opts.contactId) {
    const { byContact } = opportunitiesByNode(input);
    const connIds = input.connections
      .filter((c) => c.fromId === opts.contactId || c.toId === opts.contactId)
      .map((c) => c.id);
    const history = store.history({ objectIds: [opts.contactId, ...connIds], limit: 30 });
    const ctx = buildContactContext(
      graph,
      input.connections,
      opts.contactId,
      history,
      byContact.get(opts.contactId) ?? [],
    );
    if (!ctx) return { found: false, error: `contact "${opts.contactId}" not found` };
    // Deal stage moves (audited by opportunity.update) so the AI sees momentum.
    const audit = getAuditStore();
    const moves: string[] = [];
    for (const o of ctx.opportunities)
      for (const e of audit.list({ objectType: "opportunity", objectId: o.id, limit: 5 }))
        if (e.meta?.field === "stage")
          moves.push(
            `- ${new Date(e.when).toISOString().slice(0, 10)} ${o.name}: ${String(e.meta.from)} → ${String(e.meta.to)}`,
          );
    let text = moves.length
      ? `${ctx.text}\nDeal stage history:\n${moves.slice(0, 12).join("\n")}`
      : ctx.text;
    // Linked workspace objects (projects, notes, tasks, files…) for this person.
    const linked = await links.linksForNetworkObject("contact", opts.contactId);
    const linkedLines = linked.groups
      .filter((g) => g.type !== "opportunity")
      .map(
        (g) =>
          `- ${g.label}: ${g.items
            .slice(0, 8)
            .map(
              (i) =>
                `${i.label} [${i.type} ${i.id}]${i.status ? ` (${i.status})` : ""}${i.role ? ` — ${i.role}` : ""}`,
            )
            .join("; ")}`,
      );
    if (linkedLines.length) text = `${text}\nLinked to:\n${linkedLines.join("\n")}`;
    return { found: true, scope: "contact", ...ctx, linked: linked.groups, text };
  }
  if (opts.opportunityId) {
    const { byContact, byConnection } = opportunitiesByNode(input);
    const ctx = buildOpportunityContext(
      graph,
      input.connections,
      opts.opportunityId,
      byContact,
      byConnection,
    );
    return { found: true, scope: "opportunity", ...ctx };
  }
  return { found: true, scope: "overview", stats: graph.stats, text: buildOverviewContext(graph) };
}

/** Link a contact or connection to an opportunity (idempotent). */
export function linkOpportunity(p: {
  kind: "contact" | "connection";
  id: string;
  opportunityId: string;
  role?: string;
  actor?: string;
}) {
  const store = getNetworkStore();
  const exists = p.kind === "contact" ? store.getContact(p.id) : store.getConnection(p.id);
  if (!exists) throw new Error(`${p.kind} "${p.id}" not found`);
  const opp = getOpportunityStore().get(p.opportunityId);
  if (!opp) throw new Error(`opportunity "${p.opportunityId}" not found`);
  const edge = getRelationsStore().create({
    fromType: p.kind,
    fromId: p.id,
    edge: p.kind === "contact" ? EDGE_CONTACT_OPP : EDGE_CONNECTION_OPP,
    toType: "opportunity",
    toId: p.opportunityId,
    createdBy: p.actor || NETWORK_AGENT,
    meta: p.role ? { role: p.role } : {},
  });
  store.record(
    p.kind,
    p.id,
    "opportunity.linked",
    "",
    `${opp.name} [${opp.stage}]`,
    p.actor || "user",
  );
  getAuditStore().log({
    what: `Linked ${p.kind} to opportunity "${opp.name}"`,
    trigger: "network.opportunities.link",
    agent: NETWORK_AGENT,
    action: `${p.kind} ${p.id} → opportunity ${opp.id}`,
    objectType: p.kind,
    objectId: p.id,
    meta: { opportunityId: opp.id, role: p.role ?? "" },
  });
  return { edge, opportunity: { id: opp.id, name: opp.name, stage: opp.stage } };
}

export function unlinkOpportunity(p: {
  kind: "contact" | "connection";
  id: string;
  opportunityId: string;
  actor?: string;
}): number {
  const n = getRelationsStore().deleteMatch({
    fromType: p.kind,
    fromId: p.id,
    edge: p.kind === "contact" ? EDGE_CONTACT_OPP : EDGE_CONNECTION_OPP,
    toType: "opportunity",
    toId: p.opportunityId,
  });
  if (n) {
    getNetworkStore().record(
      p.kind,
      p.id,
      "opportunity.unlinked",
      p.opportunityId,
      "",
      p.actor || "user",
    );
    getAuditStore().log({
      what: `Unlinked ${p.kind} from opportunity ${p.opportunityId}`,
      trigger: "network.opportunities.unlink",
      agent: NETWORK_AGENT,
      objectType: p.kind,
      objectId: p.id,
      meta: { opportunityId: p.opportunityId },
    });
  }
  return n;
}

/**
 * Bring an existing CRM client into the network without copying it: a contact
 * row that points at the client (name/channels stay on the client), plus a
 * `client-of` connection to the owner. Idempotent per client.
 */
export async function promoteClient(p: {
  clientId: string;
  agencyId?: string;
  strength?: number;
  actor?: string;
}): Promise<{ contact: Contact; created: boolean; connectionId: string | null }> {
  const store = getNetworkStore();
  const existing = store.findContactByClient(p.clientId);
  if (existing)
    return {
      contact: await hydrateContact(existing, p.agencyId),
      created: false,
      connectionId: null,
    };
  const client = await findClient(p.clientId, p.agencyId);
  if (!client) throw new Error(`client "${p.clientId}" not found`);
  const contact = store.createContact(
    {
      name: "",
      clientId: client.id,
      contactType: "client",
      status: "Active",
      channels: {},
    },
    p.actor || "user",
  );
  const cx = store.createConnection(
    {
      fromId: ME_ID,
      toId: contact.id,
      relationshipType: "client-of",
      strength: p.strength ?? 3,
      direction: "mutual",
      values: [{ valueType: "revenue", description: "CRM client" }],
    },
    p.actor || "user",
  );
  getAuditStore().log({
    what: `Client "${client.name}" added to the network`,
    trigger: "network.contacts.promoteClient",
    agent: NETWORK_AGENT,
    action: `contact ${contact.id} linked to client ${client.id}`,
    objectType: "contact",
    objectId: contact.id,
    meta: { clientId: client.id },
  });
  return { contact: await hydrateContact(contact, p.agencyId), created: true, connectionId: cx.id };
}

/** Remove every relations edge touching a network object (on delete). */
export function dropNetworkEdges(kind: "contact" | "connection", id: string): void {
  const rel = getRelationsStore();
  for (const r of rel.linksAround(kind, id)) rel.delete(r.id);
}
