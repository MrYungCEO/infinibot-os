/**
 * People Network — pure graph assembly, warm-intro path finding and the AI
 * decision context. No I/O: `./service.ts` loads the stores and hands the rows
 * in, so everything here is unit-testable.
 */

import {
  ME_ID,
  type Connection,
  type Contact,
  type LinkedClientSummary,
  type NetworkEdge,
  type NetworkGraph,
  type NetworkHistoryEntry,
  type NetworkNode,
  type NetworkOpportunity,
  type NetworkPath,
} from "./types.js";
import { computeWarmScore, WARM_BANDS, warmBand } from "./warm.js";

const DAY_MS = 86_400_000;

/** Pipeline stages that end an opportunity (src/opportunity/types.ts TERMINAL_STAGES). */
export const TERMINAL_OPPORTUNITY_STAGES = ["Won", "Lost", "Hold"];

export function isOpenStage(stage: string): boolean {
  return !TERMINAL_OPPORTUNITY_STAGES.includes(String(stage));
}

/** Minimal opportunity fields the network needs. */
export interface OpportunityLite {
  id: string;
  name: string;
  stage: string;
  estimatedValue: number;
  nextAction?: string;
  nextActionDate?: string;
  owner?: string;
  clientId?: string;
}

/** contact/connection → opportunity link (from the relations store). */
export interface OpportunityLink {
  kind: "contact" | "connection";
  /** contact id or connection id */
  fromId: string;
  opportunityId: string;
  role?: string;
}

export interface GraphInput {
  contacts: Contact[];
  connections: Connection[];
  opportunities: OpportunityLite[];
  links: OpportunityLink[];
  /** clientId → live client summary (only clients that exist). */
  clients: Map<string, LinkedClientSummary>;
  /** Extra client → opportunity ids from `client_has_opportunity` edges. */
  clientOpportunityIds?: Map<string, string[]>;
  /** Tracked interactions in the warm-score window, per contact / connection id. */
  activity?: Map<string, number>;
  /** Linked workspace objects per contact id (contact_linked_to edges). */
  linkCounts?: Map<string, number>;
  meLabel?: string;
  now?: number;
}

export function connectionValueTotal(c: Pick<Connection, "values">): number {
  let sum = 0;
  for (const v of c.values ?? []) sum += Number(v.estimatedValue) || 0;
  return sum;
}

function daysSince(iso: string, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

function latestIso(dates: string[]): string {
  let best = "";
  for (const d of dates) if (d && d > best) best = d;
  return best;
}

/** Display name: the contact's own name, else the linked client's. */
export function contactDisplayName(c: Contact, client?: LinkedClientSummary | null): string {
  return c.name || client?.name || "(unnamed)";
}

/**
 * Every opportunity tied to each contact and connection. A contact sees its
 * direct links, its linked client's opportunities and those of its
 * connections. Returned per node / edge id, de-duplicated by opportunity.
 */
export function opportunitiesByNode(input: GraphInput): {
  byContact: Map<string, NetworkOpportunity[]>;
  byConnection: Map<string, NetworkOpportunity[]>;
} {
  const oppById = new Map(input.opportunities.map((o) => [o.id, o]));
  const byContact = new Map<string, NetworkOpportunity[]>();
  const byConnection = new Map<string, NetworkOpportunity[]>();
  const push = (
    map: Map<string, NetworkOpportunity[]>,
    key: string,
    o: OpportunityLite,
    via: NetworkOpportunity["via"],
    viaId: string,
    role?: string,
  ) => {
    const list = map.get(key) ?? [];
    if (list.some((x) => x.id === o.id)) return;
    list.push({
      id: o.id,
      name: o.name,
      stage: o.stage,
      open: isOpenStage(o.stage),
      estimatedValue: Number(o.estimatedValue) || 0,
      nextAction: o.nextAction ?? "",
      nextActionDate: o.nextActionDate ?? "",
      owner: o.owner ?? "",
      via,
      viaId,
      ...(role ? { role } : {}),
    });
    map.set(key, list);
  };

  for (const l of input.links) {
    const o = oppById.get(l.opportunityId);
    if (!o) continue;
    if (l.kind === "contact") push(byContact, l.fromId, o, "contact", l.fromId, l.role);
    else push(byConnection, l.fromId, o, "connection", l.fromId, l.role);
  }
  // Client-linked: opportunity.clientId or a client_has_opportunity edge.
  const byClient = new Map<string, Set<string>>();
  for (const o of input.opportunities) {
    if (!o.clientId) continue;
    const s = byClient.get(o.clientId) ?? new Set<string>();
    s.add(o.id);
    byClient.set(o.clientId, s);
  }
  for (const [cid, ids] of input.clientOpportunityIds ?? []) {
    const s = byClient.get(cid) ?? new Set<string>();
    for (const id of ids) s.add(id);
    byClient.set(cid, s);
  }
  for (const c of input.contacts) {
    if (!c.clientId) continue;
    for (const oid of byClient.get(c.clientId) ?? []) {
      const o = oppById.get(oid);
      if (o) push(byContact, c.id, o, "client", c.id);
    }
  }
  // An opportunity on a connection also counts for both of its endpoints.
  for (const cx of input.connections) {
    for (const o of byConnection.get(cx.id) ?? []) {
      const lite = oppById.get(o.id);
      if (!lite) continue;
      for (const end of [cx.fromId, cx.toId]) {
        if (end !== ME_ID) push(byContact, end, lite, "connection", cx.id, o.role);
      }
    }
  }
  return { byContact, byConnection };
}

export function buildNetworkGraph(input: GraphInput): NetworkGraph {
  const now = input.now ?? Date.now();
  const { byContact, byConnection } = opportunitiesByNode(input);
  const contactIds = new Set(input.contacts.map((c) => c.id));
  // Drop dangling edges (an endpoint deleted outside the store).
  const connections = input.connections.filter(
    (c) =>
      (c.fromId === ME_ID || contactIds.has(c.fromId)) &&
      (c.toId === ME_ID || contactIds.has(c.toId)),
  );
  const edgesOf = new Map<string, Connection[]>();
  for (const cx of connections) {
    for (const end of [cx.fromId, cx.toId]) {
      const list = edgesOf.get(end) ?? [];
      list.push(cx);
      edgesOf.set(end, list);
    }
  }

  const nodes: NetworkNode[] = input.contacts.map((c) => {
    const client = c.clientId ? (input.clients.get(c.clientId) ?? null) : null;
    const mine = edgesOf.get(c.id) ?? [];
    const opps = byContact.get(c.id) ?? [];
    const open = opps.filter((o) => o.open);
    const lastTouch = latestIso([c.lastTouchDate, ...mine.map((m) => m.lastTouchDate)]);
    const valueTypes = new Set<string>();
    for (const m of mine) for (const v of m.values) valueTypes.add(String(v.valueType));
    const staleDays = daysSince(lastTouch, now);
    const linkedObjects = input.linkCounts?.get(c.id) ?? 0;
    const warm = computeWarmScore(
      {
        staleDays,
        connections: mine,
        interactions:
          (input.activity?.get(c.id) ?? 0) +
          mine.reduce((s, m) => s + (input.activity?.get(m.id) ?? 0), 0),
        openOpportunities: open.length,
        linkedObjects,
      },
      c.warmOverride,
    );
    return {
      id: c.id,
      kind: "contact",
      name: contactDisplayName(c, client),
      org: c.org,
      role: c.role,
      contactType: String(c.contactType),
      status: String(c.status),
      tags: c.tags,
      clientId: c.clientId ?? "",
      isClient: Boolean(c.clientId) || c.contactType === "client",
      client,
      relationshipValue: mine.reduce((s, m) => s + connectionValueTotal(m), 0),
      pipelineValue: open.reduce((s, o) => s + o.estimatedValue, 0),
      openOpportunities: open.length,
      totalOpportunities: opps.length,
      degree: mine.length,
      lastTouchDate: lastTouch,
      staleDays,
      nextAction: c.nextAction ?? "",
      nextActionDate: c.nextActionDate ?? "",
      valueTypes: [...valueTypes],
      warmScore: warm.score,
      warmComputed: warm.computed,
      warmOverridden: warm.overridden,
      warmBand: warmBand(warm.score),
      warmBreakdown: warm.breakdown,
      warmTrend: "new" as const,
      warmDelta: null,
      linkedObjects,
    };
  });

  const edges: NetworkEdge[] = connections.map((cx) => ({
    id: cx.id,
    from: cx.fromId,
    to: cx.toId,
    relationshipType: String(cx.relationshipType),
    strength: cx.strength,
    direction: String(cx.direction),
    status: String(cx.status),
    values: cx.values,
    valueTotal: connectionValueTotal(cx),
    lastTouchDate: cx.lastTouchDate,
    openOpportunities: (byConnection.get(cx.id) ?? []).filter((o) => o.open).length,
  }));

  // All network opportunities, de-duplicated (first tie wins for `via`).
  const seen = new Map<string, NetworkOpportunity>();
  for (const list of [...byContact.values(), ...byConnection.values()])
    for (const o of list) if (!seen.has(o.id)) seen.set(o.id, o);
  const opportunities = [...seen.values()];

  // Clients with open deals that nobody in the network points at yet.
  const linkedClients = new Set(input.contacts.map((c) => c.clientId).filter(Boolean));
  const openByClient = new Map<string, number>();
  for (const o of input.opportunities)
    if (o.clientId && isOpenStage(o.stage) && !linkedClients.has(o.clientId))
      openByClient.set(o.clientId, (openByClient.get(o.clientId) ?? 0) + 1);
  const suggestedClients = [...openByClient.entries()]
    .map(([id, n]) => ({ id, name: input.clients.get(id)?.name ?? id, openOpportunities: n }))
    .filter((s) => input.clients.has(s.id))
    .sort((a, b) => b.openOpportunities - a.openOpportunities)
    .slice(0, 20);

  const open = opportunities.filter((o) => o.open);
  return {
    me: { id: ME_ID, label: input.meLabel || "You" },
    nodes,
    edges,
    opportunities,
    stats: {
      contacts: nodes.length,
      clients: nodes.filter((n) => n.isClient).length,
      connections: edges.length,
      openOpportunities: open.length,
      pipelineValue: open.reduce((s, o) => s + o.estimatedValue, 0),
      relationshipValue: edges.reduce((s, e) => s + e.valueTotal, 0),
      stale: nodes.filter((n) => n.staleDays === null || n.staleDays > 30).length,
      avgWarm: nodes.length
        ? Math.round(nodes.reduce((s, n) => s + n.warmScore, 0) / nodes.length)
        : 0,
      bands: Object.fromEntries(
        WARM_BANDS.map((b) => [b.id, nodes.filter((n) => n.warmBand === b.id).length]),
      ),
    },
    suggestedClients,
  };
}

/**
 * Warm-intro path: the cheapest route from `fromId` (default the owner) to
 * `toId`, where a strong tie is cheap (cost = 6 − strength) and ended
 * connections are not walkable. Direction is ignored — a relationship can be
 * asked for an intro either way.
 */
export function findWarmPath(
  connections: Connection[],
  toId: string,
  fromId: string = ME_ID,
  names: Map<string, string> = new Map(),
): NetworkPath {
  const none: NetworkPath = {
    found: false,
    nodeIds: [],
    edgeIds: [],
    description: "",
    minStrength: 0,
  };
  if (!toId) return none;
  const label = (id: string) => (id === ME_ID ? "You" : (names.get(id) ?? id));
  if (toId === fromId)
    return {
      found: true,
      nodeIds: [fromId],
      edgeIds: [],
      description: label(fromId),
      minStrength: 5,
    };
  const adj = new Map<string, Array<{ to: string; edge: Connection }>>();
  for (const c of connections) {
    if (String(c.status) === "Ended") continue;
    for (const [a, b] of [
      [c.fromId, c.toId],
      [c.toId, c.fromId],
    ] as const) {
      const list = adj.get(a) ?? [];
      list.push({ to: b, edge: c });
      adj.set(a, list);
    }
  }
  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { node: string; edge: Connection }>();
  const done = new Set<string>();
  while (true) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [n, d] of dist) if (!done.has(n) && d < best) ((best = d), (cur = n));
    if (cur === null) break;
    if (cur === toId) break;
    done.add(cur);
    for (const { to, edge } of adj.get(cur) ?? []) {
      const nd = best + (6 - Math.min(5, Math.max(1, edge.strength || 1)));
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, { node: cur, edge });
      }
    }
  }
  if (!dist.has(toId)) return none;
  const nodeIds = [toId];
  const edgeIds: string[] = [];
  const parts: string[] = [];
  let minStrength = 5;
  let at = toId;
  while (at !== fromId) {
    const p = prev.get(at);
    if (!p) return none;
    edgeIds.unshift(p.edge.id);
    nodeIds.unshift(p.node);
    parts.unshift(`${label(at)} (${p.edge.relationshipType}, ${p.edge.strength}/5)`);
    minStrength = Math.min(minStrength, p.edge.strength);
    at = p.node;
  }
  return {
    found: true,
    nodeIds,
    edgeIds,
    description: [label(fromId), ...parts].join(" → "),
    minStrength,
  };
}

// ═══════════════════════════════════════════════════════════════════
// AI CONTEXT
// ═══════════════════════════════════════════════════════════════════

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function valueLine(cx: Connection): string {
  if (!cx.values.length) return "no value recorded";
  return cx.values
    .map(
      (v) =>
        `${v.valueType}${v.estimatedValue ? ` ${money(v.estimatedValue)}` : ""}${v.description ? `: ${v.description}` : ""}`,
    )
    .join("; ");
}

export interface ContactContext {
  contact: NetworkNode;
  connections: Array<{
    connectionId: string;
    otherId: string;
    otherName: string;
    relationshipType: string;
    strength: number;
    direction: string;
    status: string;
    values: Connection["values"];
    lastTouchDate: string;
  }>;
  opportunities: NetworkOpportunity[];
  path: NetworkPath;
  history: NetworkHistoryEntry[];
  text: string;
}

export function buildContactContext(
  graph: NetworkGraph,
  connections: Connection[],
  contactId: string,
  history: NetworkHistoryEntry[],
  opps: NetworkOpportunity[],
): ContactContext | null {
  const node = graph.nodes.find((n) => n.id === contactId);
  if (!node) return null;
  const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const mine = connections
    .filter((c) => c.fromId === contactId || c.toId === contactId)
    .sort((a, b) => b.strength - a.strength);
  const conns = mine.map((c) => {
    const other = c.fromId === contactId ? c.toId : c.fromId;
    return {
      connectionId: c.id,
      otherId: other,
      otherName: other === ME_ID ? "You" : (names.get(other) ?? other),
      relationshipType: String(c.relationshipType),
      strength: c.strength,
      direction: String(c.direction),
      status: String(c.status),
      values: c.values,
      lastTouchDate: c.lastTouchDate,
    };
  });
  const path = findWarmPath(connections, contactId, ME_ID, names);
  const lines: string[] = [];
  lines.push(
    `${node.name}${node.role ? `, ${node.role}` : ""}${node.org ? ` at ${node.org}` : ""} — ${node.contactType}${node.isClient ? " (CRM client" + (node.client ? `: ${node.client.name}, ${node.client.pipelineStatus || "no status"}` : "") + ")" : ""}; status ${node.status}.`,
  );
  lines.push(
    `Relationship value ${money(node.relationshipValue)}; open pipeline ${money(node.pipelineValue)} across ${node.openOpportunities} open opportunit${node.openOpportunities === 1 ? "y" : "ies"}.`,
  );
  const b = node.warmBreakdown;
  lines.push(
    `Warm score ${node.warmScore}/100 (${WARM_BANDS.find((x) => x.id === node.warmBand)?.label ?? node.warmBand}${node.warmOverridden ? `, owner override; formula says ${node.warmComputed}` : ""}${node.warmTrend === "warming" || node.warmTrend === "cooling" ? `, ${node.warmTrend}${node.warmDelta != null ? ` ${node.warmDelta > 0 ? "+" : ""}${node.warmDelta}` : ""}` : ""}) — recency ${b.recency}, strength ${b.strength}, frequency ${b.frequency}, opportunities ${b.opportunities}, reciprocity ${b.reciprocity}, links ${b.links}.`,
  );
  lines.push(
    node.staleDays === null
      ? "Never touched (no last-touch date)."
      : `Last touch ${node.lastTouchDate} (${node.staleDays} days ago)${node.staleDays > 30 ? " — STALE" : ""}.`,
  );
  if (node.nextAction)
    lines.push(
      `Next action: ${node.nextAction}${node.nextActionDate ? ` by ${node.nextActionDate}` : ""}.`,
    );
  lines.push(
    path.found
      ? `Warm path: ${path.description} (weakest tie ${path.minStrength}/5).`
      : "No warm path from you yet.",
  );
  if (conns.length) {
    lines.push("Connections:");
    for (const c of conns.slice(0, 25)) {
      const cx = mine.find((m) => m.id === c.connectionId)!;
      lines.push(
        `- ${c.otherName}: ${c.relationshipType}, strength ${c.strength}/5, ${c.status}${c.lastTouchDate ? `, last touch ${c.lastTouchDate}` : ""} — value: ${valueLine(cx)}`,
      );
    }
  }
  if (opps.length) {
    lines.push("Opportunities:");
    for (const o of opps)
      lines.push(
        `- ${o.name} [${o.stage}${o.open ? ", open" : ""}] ${money(o.estimatedValue)} via ${o.via}${o.role ? ` (${o.role})` : ""}${o.nextAction ? ` — next: ${o.nextAction}` : ""}`,
      );
  }
  if (history.length) {
    lines.push("Recent changes:");
    for (const h of history.slice(0, 10))
      lines.push(
        `- ${new Date(h.at).toISOString().slice(0, 10)} ${h.objectType} ${h.field}: ${h.from || "∅"} → ${h.to || "∅"} (${h.actor})`,
      );
  }
  return {
    contact: node,
    connections: conns,
    opportunities: opps,
    path,
    history,
    text: lines.join("\n"),
  };
}

export interface OpportunityNetworkContext {
  opportunityId: string;
  people: Array<{
    contactId: string;
    name: string;
    via: string;
    role?: string;
    path: NetworkPath;
    relationshipValue: number;
  }>;
  connections: Array<{
    connectionId: string;
    between: [string, string];
    relationshipType: string;
    strength: number;
    values: Connection["values"];
  }>;
  text: string;
}

export function buildOpportunityContext(
  graph: NetworkGraph,
  connections: Connection[],
  opportunityId: string,
  byContact: Map<string, NetworkOpportunity[]>,
  byConnection: Map<string, NetworkOpportunity[]>,
): OpportunityNetworkContext {
  const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const people: OpportunityNetworkContext["people"] = [];
  for (const [cid, list] of byContact) {
    const hit = list.find((o) => o.id === opportunityId);
    if (!hit) continue;
    const node = graph.nodes.find((n) => n.id === cid);
    if (!node) continue;
    people.push({
      contactId: cid,
      name: node.name,
      via: hit.via,
      ...(hit.role ? { role: hit.role } : {}),
      path: findWarmPath(connections, cid, ME_ID, names),
      relationshipValue: node.relationshipValue,
    });
  }
  const conns: OpportunityNetworkContext["connections"] = [];
  for (const [xid, list] of byConnection) {
    if (!list.some((o) => o.id === opportunityId)) continue;
    const cx = connections.find((c) => c.id === xid);
    if (!cx) continue;
    const n = (id: string) => (id === ME_ID ? "You" : (names.get(id) ?? id));
    conns.push({
      connectionId: xid,
      between: [n(cx.fromId), n(cx.toId)],
      relationshipType: String(cx.relationshipType),
      strength: cx.strength,
      values: cx.values,
    });
  }
  const lines: string[] = [];
  if (!people.length && !conns.length) {
    lines.push("No one in your network is linked to this opportunity yet.");
  } else {
    lines.push("People involved:");
    for (const p of people)
      lines.push(
        `- ${p.name} (via ${p.via}${p.role ? `, ${p.role}` : ""}) — ${p.path.found ? `warm path ${p.path.description}` : "no warm path"}; relationship value ${money(p.relationshipValue)}`,
      );
    for (const c of conns)
      lines.push(
        `- Connection ${c.between[0]} ↔ ${c.between[1]} (${c.relationshipType}, ${c.strength}/5) supports this deal`,
      );
  }
  return { opportunityId, people, connections: conns, text: lines.join("\n") };
}

/** Whole-network summary for decisions when no single contact is in focus. */
export function buildOverviewContext(graph: NetworkGraph, limit = 12): string {
  const lines: string[] = [];
  const s = graph.stats;
  lines.push(
    `Network: ${s.contacts} contacts (${s.clients} clients), ${s.connections} connections, ${s.openOpportunities} open opportunities worth ${money(s.pipelineValue)}, recorded relationship value ${money(s.relationshipValue)}, ${s.stale} stale (>30 days or never touched).`,
  );
  if (graph.nodes.length) {
    lines.push(
      `Warm score: average ${s.avgWarm}/100; rings — ${WARM_BANDS.map((b) => `${b.label} ${s.bands?.[b.id] ?? 0}`).join(", ")}.`,
    );
    const cooling = graph.nodes.filter((n) => n.warmTrend === "cooling").slice(0, 6);
    if (cooling.length)
      lines.push(
        `Cooling: ${cooling.map((n) => `${n.name} ${n.warmScore}${n.warmDelta != null ? ` (${n.warmDelta})` : ""}`).join(", ")}.`,
      );
  }
  const top = [...graph.nodes]
    .sort((a, b) => b.relationshipValue + b.pipelineValue - (a.relationshipValue + a.pipelineValue))
    .slice(0, limit);
  if (top.length) {
    lines.push("Most valuable relationships:");
    for (const n of top)
      lines.push(
        `- ${n.name} (${n.contactType}${n.isClient ? ", client" : ""}) — warm ${n.warmScore}, value ${money(n.relationshipValue)}, ${n.openOpportunities} open opp(s) ${money(n.pipelineValue)}${n.staleDays !== null && n.staleDays > 30 ? `, stale ${n.staleDays}d` : ""}${n.nextAction ? `, next: ${n.nextAction}` : ""}`,
      );
  }
  const open = graph.opportunities.filter((o) => o.open);
  if (open.length) {
    lines.push("Open opportunities in the network:");
    const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
    for (const o of open.slice(0, limit))
      lines.push(
        `- ${o.name} [${o.stage}] ${money(o.estimatedValue)} — via ${o.via} ${nameOf.get(o.viaId) ?? o.viaId}`,
      );
  }
  if (graph.suggestedClients.length)
    lines.push(
      `Clients with open deals not yet in the network: ${graph.suggestedClients
        .map((c) => c.name)
        .slice(0, 8)
        .join(", ")}.`,
    );
  return lines.join("\n");
}
