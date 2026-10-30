/**
 * My Network (People Network) — controller state + gateway calls.
 *
 * Backed by the business-agency plugin's `network.*` RPCs (src/network). The
 * view (views/people-network.ts) is presentation only; everything that talks
 * to the gateway lives here so the graph, the table and the side panel share
 * one loaded snapshot.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Enums (kept in sync with src/network/types.ts) ──
export const ME_ID = "me";
export const CONTACT_TYPES = ["client", "prospect", "partner", "investor", "advisor", "colleague", "vendor", "friend", "other"] as const;
export const CONTACT_STATUSES = ["Active", "Warm", "Cold", "Dormant", "Archived"] as const;
export const RELATIONSHIP_TYPES = ["introduced-by", "colleague", "partner", "investor", "client-of", "referral", "mentor", "friend", "vendor", "family", "other"] as const;
export const CONNECTION_DIRECTIONS = ["mutual", "forward", "backward"] as const;
export const CONNECTION_STATUSES = ["Active", "Dormant", "Strained", "Ended"] as const;
export const VALUE_TYPES = ["intro-access", "revenue", "expertise", "capital", "distribution", "talent", "partnership", "influence", "support", "other"] as const;
export const TERMINAL_STAGES = ["Won", "Lost", "Hold"];

// ── Types (mirror src/network/types.ts) ──
export interface ConnectionValue {
  valueType: string;
  estimatedValue?: number;
  description: string;
}
export interface LinkedClient {
  id: string;
  name: string;
  pipelineStatus: string;
  email: string | null;
  phone: string | null;
}
export interface NetworkNode {
  id: string;
  kind: "me" | "contact";
  name: string;
  org: string;
  role: string;
  contactType: string;
  status: string;
  tags: string[];
  clientId: string;
  isClient: boolean;
  client?: LinkedClient | null;
  relationshipValue: number;
  pipelineValue: number;
  openOpportunities: number;
  totalOpportunities: number;
  degree: number;
  lastTouchDate: string;
  staleDays: number | null;
  nextAction: string;
  nextActionDate: string;
  valueTypes: string[];
  warmScore: number;
  warmComputed: number;
  warmOverridden: boolean;
  warmBand: string;
  warmBreakdown: Record<string, number>;
  warmTrend: "warming" | "cooling" | "steady" | "new";
  warmDelta: number | null;
  linkedObjects: number;
}
export interface NetworkEdge {
  id: string;
  from: string;
  to: string;
  relationshipType: string;
  strength: number;
  direction: string;
  status: string;
  values: ConnectionValue[];
  valueTotal: number;
  lastTouchDate: string;
  openOpportunities: number;
}
export interface NetworkOpportunity {
  id: string;
  name: string;
  stage: string;
  open: boolean;
  estimatedValue: number;
  nextAction: string;
  nextActionDate: string;
  owner: string;
  via: "contact" | "client" | "connection";
  viaId: string;
  role?: string;
}
export interface NetworkGraph {
  me: { id: string; label: string };
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  opportunities: NetworkOpportunity[];
  stats: {
    contacts: number;
    clients: number;
    connections: number;
    openOpportunities: number;
    pipelineValue: number;
    relationshipValue: number;
    stale: number;
    avgWarm?: number;
    bands?: Record<string, number>;
  };
  suggestedClients: Array<{ id: string; name: string; openOpportunities: number }>;
}
export interface NetworkPath {
  found: boolean;
  nodeIds: string[];
  edgeIds: string[];
  description: string;
  minStrength: number;
}
export interface Contact {
  id: string;
  name: string;
  org: string;
  role: string;
  contactType: string;
  tags: string[];
  channels: Record<string, string>;
  notes: string;
  status: string;
  owner: string;
  priority: string;
  nextAction?: string;
  nextActionDate?: string;
  lastTouchDate: string;
  clientId?: string;
  client?: LinkedClient | null;
  createdAt: number;
  updatedAt: number;
}
export interface HistoryEntry {
  id: string;
  objectType: string;
  objectId: string;
  field: string;
  from: string;
  to: string;
  actor: string;
  at: number;
}
export interface ContactDetail {
  contact: Contact;
  connections: Array<{
    connectionId: string;
    otherId: string;
    otherName: string;
    relationshipType: string;
    strength: number;
    direction: string;
    status: string;
    values: ConnectionValue[];
    lastTouchDate: string;
  }>;
  opportunities: NetworkOpportunity[];
  history: HistoryEntry[];
  opportunityHistory: Array<{ opportunityId: string; from: string; to: string; at: number }>;
  path: NetworkPath | null;
  warmHistory?: Array<{ score: number; at: number }>;
}

// ── Cross-object links (src/network/links.ts) ──
export interface LinkedItem {
  relationId: string;
  edge: string;
  type: string;
  id: string;
  label: string;
  subtitle: string;
  status: string;
  tone: string;
  value: number | null;
  resolved: boolean;
  role: string;
}
export interface LinkedGroup {
  type: string;
  label: string;
  items: LinkedItem[];
}
/** One link anywhere in the network (graph satellites + "linked to" filter). */
export interface NetworkLink {
  relationId: string;
  kind: "contact" | "connection";
  fromId: string;
  type: string;
  id: string;
  label: string;
  resolved: boolean;
}
export interface LinkCandidate {
  type: string;
  id: string;
  label: string;
  subtitle: string;
}
export const LINKABLE_TYPES = ["project", "task", "note", "document", "file", "idea", "goal", "report", "client", "opportunity", "event", "product", "decision", "risk", "commitment", "issue", "lead"] as const;

/** Warm bands (src/network/warm.ts). */
export const WARM_BANDS = [
  { id: "inner", label: "Inner circle", min: 70 },
  { id: "active", label: "Active", min: 45 },
  { id: "warmable", label: "Warm-able", min: 20 },
  { id: "dormant", label: "Dormant", min: 0 },
] as const;
export const WARM_FACTORS: Array<{ key: string; label: string; max: number; hint: string }> = [
  { key: "recency", label: "Recency", max: 35, hint: "last touch, halves every 45 days" },
  { key: "strength", label: "Strength", max: 20, hint: "strongest live connection" },
  { key: "frequency", label: "Frequency", max: 15, hint: "tracked interactions, last 90 days" },
  { key: "opportunities", label: "Open deals", max: 15, hint: "open opportunities (3 = max)" },
  { key: "reciprocity", label: "Reciprocity", max: 5, hint: "mutual beats one-way" },
  { key: "links", label: "Linked work", max: 10, hint: "projects, notes, tasks… linked (5 = max)" },
];
export function bandLabel(id: string): string {
  return WARM_BANDS.find((b) => b.id === id)?.label ?? id;
}
export interface ClientHit extends LinkedClient {
  inNetwork: string | null;
}
export interface OpportunityOption {
  id: string;
  name: string;
  stage: string;
  estimatedValue: number;
}

export interface ContactDraft {
  name: string;
  org: string;
  role: string;
  contactType: string;
  status: string;
  tags: string;
  email: string;
  phone: string;
  linkedin: string;
  website: string;
  notes: string;
  nextAction: string;
  nextActionDate: string;
  lastTouchDate: string;
  // create-only "connect to me"
  connectToMe: boolean;
  meRelationship: string;
  meStrength: number;
  meValueType: string;
  meValueAmount: number;
  meValueDescription: string;
}
export interface ConnectionDraft {
  fromId: string;
  toId: string;
  relationshipType: string;
  strength: number;
  direction: string;
  status: string;
  lastTouchDate: string;
  notes: string;
  values: ConnectionValue[];
}

export type NetworkModal =
  | { kind: "contact"; editingId: string | null; draft: ContactDraft }
  | { kind: "connect"; editingId: string | null; draft: ConnectionDraft }
  | { kind: "link"; contactId: string; target: string; opportunityId: string; role: string; options: OpportunityOption[]; loading: boolean }
  | { kind: "clients"; query: string; results: ClientHit[]; loading: boolean }
  | {
      kind: "linkObject";
      target: "contact" | "connection";
      id: string;
      title: string;
      type: string;
      query: string;
      results: LinkCandidate[];
      loading: boolean;
      role: string;
      /** Return to the connection editor after linking a connection. */
      back: NetworkModal | null;
    };

export const networkState = {
  loaded: false,
  loading: false,
  error: null as string | null,
  graph: null as NetworkGraph | null,
  view: "graph" as "graph" | "list",
  selectedId: null as string | null,
  selectedEdgeId: null as string | null,
  detail: null as ContactDetail | null,
  detailFor: null as string | null,
  detailLoading: false,
  filterType: "",
  filterTag: "",
  filterOpen: false,
  filterStaleDays: 0,
  filterBand: "",
  /** `${type}:${id}` of a linked object — show only people linked to it. */
  filterLinked: "",
  query: "",
  /** Graph layout: warm-score rings around you, or free force. */
  layout: "rings" as "rings" | "free",
  /** Draw linked objects as satellites on the graph. */
  showSatellites: false,
  /** Table sort. */
  sortBy: "value" as "value" | "warm",
  /** Every link in the network (network.links.list {all}). */
  links: [] as NetworkLink[],
  /** Linked objects of the selected contact (side panel). */
  linked: null as { kind: "contact" | "connection"; id: string; groups: LinkedGroup[] } | null,
  /** Linked objects of the connection open in the editor. */
  connLinked: null as { kind: "contact" | "connection"; id: string; groups: LinkedGroup[] } | null,
  linkedLoading: false,
  modal: null as NetworkModal | null,
  modalError: null as string | null,
  saving: false,
  toast: null as string | null,
};

const s = networkState;

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toast(app: AppViewState, msg: string) {
  s.toast = msg;
  rerender(app);
  setTimeout(() => {
    if (s.toast === msg) {
      s.toast = null;
      rerender(app);
    }
  }, 2600);
}

// ── Loading ──

export async function loadNetwork(app: AppViewState, client: GatewayBrowserClient): Promise<void> {
  s.loading = true;
  s.error = null;
  rerender(app);
  try {
    const [graph, links] = await Promise.all([
      client.request("network.graph", {}) as Promise<NetworkGraph>,
      (client.request("network.links.list", { all: true }) as Promise<{ links: NetworkLink[] }>).catch(() => ({ links: [] as NetworkLink[] })),
    ]);
    s.graph = graph;
    s.links = links.links ?? [];
    s.loaded = true;
    if (s.selectedId && s.selectedId !== ME_ID && !s.graph.nodes.some((n) => n.id === s.selectedId)) {
      s.selectedId = null;
      s.detail = null;
    }
    if (s.selectedId && s.selectedId !== ME_ID) void loadDetail(app, client, s.selectedId);
  } catch (e) {
    s.error = errMsg(e);
    s.loaded = true;
  } finally {
    s.loading = false;
    rerender(app);
  }
}

async function loadDetail(app: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  s.detailLoading = true;
  s.detailFor = id;
  rerender(app);
  try {
    const d = (await client.request("network.contacts.get", { id })) as ContactDetail;
    if (s.detailFor === id) s.detail = d;
    void loadLinked(app, client, "contact", id);
  } catch (e) {
    if (s.detailFor === id) s.error = errMsg(e);
  } finally {
    if (s.detailFor === id) s.detailLoading = false;
    rerender(app);
  }
}

export function selectNode(app: AppViewState, client: GatewayBrowserClient, id: string | null): void {
  s.selectedEdgeId = null;
  if (!id || id === s.selectedId) {
    s.selectedId = id === s.selectedId ? null : id;
    if (!s.selectedId) s.detail = null;
    rerender(app);
    if (!s.selectedId) return;
  }
  s.selectedId = id;
  s.detail = null;
  if (id && id !== ME_ID) void loadDetail(app, client, id);
  rerender(app);
}

// ── Filters ──

export function knownTags(): string[] {
  const set = new Set<string>();
  for (const n of s.graph?.nodes ?? []) for (const t of n.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function filteredNodes(): NetworkNode[] {
  const nodes = s.graph?.nodes ?? [];
  const q = s.query.trim().toLowerCase();
  const linkedTo = s.filterLinked ? peopleLinkedTo(s.filterLinked) : null;
  return nodes.filter((n) => {
    if (s.filterType && n.contactType !== s.filterType) return false;
    if (s.filterTag && !n.tags.some((t) => t.toLowerCase() === s.filterTag.toLowerCase())) return false;
    if (s.filterOpen && n.openOpportunities === 0) return false;
    if (s.filterStaleDays > 0 && !(n.staleDays === null || n.staleDays > s.filterStaleDays)) return false;
    if (s.filterBand && n.warmBand !== s.filterBand) return false;
    if (linkedTo && !linkedTo.has(n.id)) return false;
    if (q && ![n.name, n.org, n.role, n.tags.join(" "), n.client?.name ?? ""].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
}

export function filtersActive(): boolean {
  return Boolean(s.filterType || s.filterTag || s.filterOpen || s.filterStaleDays || s.filterBand || s.filterLinked || s.query.trim());
}

export function clearFilters(app: AppViewState): void {
  s.filterType = "";
  s.filterTag = "";
  s.filterOpen = false;
  s.filterStaleDays = 0;
  s.filterBand = "";
  s.filterLinked = "";
  s.query = "";
  rerender(app);
}

// ── Cross-object links ──

/** Contact ids linked to an object key (`type:id`) — connection links count for both ends. */
export function peopleLinkedTo(key: string): Set<string> {
  const out = new Set<string>();
  const edges = s.graph?.edges ?? [];
  for (const l of s.links) {
    if (`${l.type}:${l.id}` !== key) continue;
    if (l.kind === "contact") out.add(l.fromId);
    else {
      const e = edges.find((x) => x.id === l.fromId);
      if (e) {
        if (e.from !== ME_ID) out.add(e.from);
        if (e.to !== ME_ID) out.add(e.to);
      }
    }
  }
  return out;
}

/** Distinct linked objects for the "Linked to…" filter, grouped by type then label. */
export function linkedObjectOptions(): Array<{ key: string; type: string; label: string; people: number }> {
  const byKey = new Map<string, { key: string; type: string; label: string; people: number }>();
  for (const l of s.links) {
    const key = `${l.type}:${l.id}`;
    if (!byKey.has(key)) byKey.set(key, { key, type: l.type, label: l.label, people: 0 });
  }
  for (const o of byKey.values()) o.people = peopleLinkedTo(o.key).size;
  return [...byKey.values()].sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
}

/** Graph satellites for the visible people (linked objects tethered to their owners). */
export function satellitesFor(visible: Set<string>): Array<{ key: string; type: string; id: string; label: string; ownerIds: string[] }> {
  const map = new Map<string, { key: string; type: string; id: string; label: string; ownerIds: string[] }>();
  for (const l of s.links) {
    const key = `${l.type}:${l.id}`;
    const owners = [...peopleLinkedTo(key)].filter((id) => visible.has(id));
    if (!owners.length) continue;
    map.set(key, { key, type: l.type, id: l.id, label: l.label, ownerIds: owners });
  }
  return [...map.values()].slice(0, 120);
}

export async function loadLinked(app: AppViewState, client: GatewayBrowserClient, kind: "contact" | "connection", id: string): Promise<void> {
  const slot = kind === "contact" ? "linked" : "connLinked";
  s.linkedLoading = true;
  if (s[slot]?.id !== id) s[slot] = null;
  rerender(app);
  try {
    const r = (await client.request("network.links.list", { kind, id })) as { groups: LinkedGroup[] };
    s[slot] = { kind, id, groups: r.groups ?? [] };
  } catch {
    s[slot] = { kind, id, groups: [] };
  } finally {
    s.linkedLoading = false;
    rerender(app);
  }
}

async function refreshLinks(app: AppViewState, client: GatewayBrowserClient) {
  try {
    const r = (await client.request("network.links.list", { all: true })) as { links: NetworkLink[] };
    s.links = r.links ?? [];
  } catch {
    /* keep the old list */
  }
  rerender(app);
}

let linkSearchSeq = 0;
let linkSearchTimer: ReturnType<typeof setTimeout> | null = null;

export function openLinkPicker(app: AppViewState, client: GatewayBrowserClient, target: "contact" | "connection", id: string, title: string): void {
  const back = s.modal && s.modal.kind === "connect" ? s.modal : null;
  s.modal = { kind: "linkObject", target, id, title, type: "", query: "", results: [], loading: true, role: "", back };
  s.modalError = null;
  rerender(app);
  void runLinkSearch(app, client);
}

export function setLinkPickerQuery(app: AppViewState, client: GatewayBrowserClient, query: string, type?: string): void {
  const m = s.modal;
  if (!m || m.kind !== "linkObject") return;
  m.query = query;
  if (type !== undefined) m.type = type;
  m.loading = true;
  rerender(app);
  if (linkSearchTimer) clearTimeout(linkSearchTimer);
  linkSearchTimer = setTimeout(() => void runLinkSearch(app, client), type !== undefined ? 0 : 220);
}

async function runLinkSearch(app: AppViewState, client: GatewayBrowserClient) {
  const m = s.modal;
  if (!m || m.kind !== "linkObject") return;
  const seq = ++linkSearchSeq;
  try {
    const r = (await client.request("network.links.search", {
      query: m.query,
      types: m.type ? [m.type] : undefined,
      limit: m.type ? 30 : 6,
    })) as { results: LinkCandidate[] };
    if (seq !== linkSearchSeq || s.modal !== m) return;
    m.results = r.results ?? [];
  } catch (e) {
    if (s.modal === m) s.modalError = errMsg(e);
  } finally {
    if (s.modal === m && seq === linkSearchSeq) {
      m.loading = false;
      rerender(app);
    }
  }
}

function closeLinkPicker(app: AppViewState) {
  const m = s.modal;
  s.modal = m && m.kind === "linkObject" ? m.back : null;
  s.modalError = null;
  rerender(app);
}
export { closeLinkPicker };

export async function saveObjectLink(app: AppViewState, client: GatewayBrowserClient, c: LinkCandidate): Promise<void> {
  const m = s.modal;
  if (!m || m.kind !== "linkObject") return;
  s.saving = true;
  rerender(app);
  try {
    await client.request("network.links.add", { kind: m.target, id: m.id, objectType: c.type, objectId: c.id, role: m.role.trim() || undefined });
    toast(app, `Linked ${c.label}`);
    const target = m.target;
    const id = m.id;
    closeLinkPicker(app);
    await Promise.all([loadLinked(app, client, target, id), refreshLinks(app, client)]);
    if (c.type === "opportunity" || target === "contact") void reloadGraphQuietly(app, client);
  } catch (e) {
    s.modalError = errMsg(e);
  } finally {
    s.saving = false;
    rerender(app);
  }
}

export async function removeObjectLink(app: AppViewState, client: GatewayBrowserClient, item: LinkedItem, kind: "contact" | "connection" = "contact"): Promise<void> {
  const owner = kind === "contact" ? s.linked : s.connLinked;
  try {
    await client.request("network.links.remove", { relationId: item.relationId });
    toast(app, `Unlinked ${item.label}`);
    if (owner) await loadLinked(app, client, owner.kind, owner.id);
    await refreshLinks(app, client);
    void reloadGraphQuietly(app, client);
  } catch (e) {
    s.error = errMsg(e);
    rerender(app);
  }
}

/** Re-read graph + detail without flashing skeletons (warm scores move with links). */
async function reloadGraphQuietly(app: AppViewState, client: GatewayBrowserClient) {
  try {
    s.graph = (await client.request("network.graph", {})) as NetworkGraph;
    if (s.selectedId && s.selectedId !== ME_ID) {
      const d = (await client.request("network.contacts.get", { id: s.selectedId })) as ContactDetail;
      if (s.detailFor === s.selectedId) s.detail = d;
    }
  } catch {
    /* next full load picks it up */
  }
  rerender(app);
}

export async function setWarmOverride(app: AppViewState, client: GatewayBrowserClient, id: string, value: number | null): Promise<void> {
  try {
    await client.request("network.contacts.update", { id, warmOverride: value });
    toast(app, value === null ? "Warm score back to the formula" : `Warm score pinned at ${value}`);
    await reloadGraphQuietly(app, client);
  } catch (e) {
    s.error = errMsg(e);
    rerender(app);
  }
}

// ── Contact modal ──

function emptyContactDraft(): ContactDraft {
  return {
    name: "",
    org: "",
    role: "",
    contactType: "other",
    status: "Active",
    tags: "",
    email: "",
    phone: "",
    linkedin: "",
    website: "",
    notes: "",
    nextAction: "",
    nextActionDate: "",
    lastTouchDate: "",
    connectToMe: true,
    meRelationship: "other",
    meStrength: 3,
    meValueType: "expertise",
    meValueAmount: 0,
    meValueDescription: "",
  };
}

export function openAddContact(app: AppViewState): void {
  s.modal = { kind: "contact", editingId: null, draft: emptyContactDraft() };
  s.modalError = null;
  rerender(app);
}

export function openEditContact(app: AppViewState, c: Contact): void {
  s.modal = {
    kind: "contact",
    editingId: c.id,
    draft: {
      ...emptyContactDraft(),
      name: c.name,
      org: c.org,
      role: c.role,
      contactType: c.contactType,
      status: c.status,
      tags: c.tags.join(", "),
      email: c.channels.email ?? "",
      phone: c.channels.phone ?? "",
      linkedin: c.channels.linkedin ?? "",
      website: c.channels.website ?? "",
      notes: c.notes,
      nextAction: c.nextAction ?? "",
      nextActionDate: c.nextActionDate ?? "",
      lastTouchDate: c.lastTouchDate,
      connectToMe: false,
    },
  };
  s.modalError = null;
  rerender(app);
}

export function closeModal(app: AppViewState): void {
  s.modal = null;
  s.modalError = null;
  rerender(app);
}

export async function saveContact(app: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const m = s.modal;
  if (!m || m.kind !== "contact") return;
  const d = m.draft;
  const payload: Record<string, unknown> = {
    name: d.name.trim(),
    org: d.org,
    role: d.role,
    contactType: d.contactType,
    status: d.status,
    tags: d.tags,
    channels: { email: d.email, phone: d.phone, linkedin: d.linkedin, website: d.website },
    notes: d.notes,
    nextAction: d.nextAction,
    nextActionDate: d.nextActionDate,
    lastTouchDate: d.lastTouchDate,
  };
  if (!m.editingId && !payload.name) {
    s.modalError = "A name is required.";
    rerender(app);
    return;
  }
  s.saving = true;
  s.modalError = null;
  rerender(app);
  try {
    if (m.editingId) {
      // A client-linked contact may keep an empty name (it shows the client's).
      await client.request("network.contacts.update", { ...payload, id: m.editingId });
      toast(app, "Contact saved");
    } else {
      if (d.connectToMe)
        payload.connectToMe = {
          relationshipType: d.meRelationship,
          strength: d.meStrength,
          values:
            d.meValueDescription.trim() || d.meValueAmount
              ? [{ valueType: d.meValueType, estimatedValue: d.meValueAmount || undefined, description: d.meValueDescription }]
              : [],
        };
      const res = (await client.request("network.contacts.create", payload)) as { contact: Contact };
      s.selectedId = res.contact.id;
      toast(app, `${res.contact.name} added to your network`);
    }
    s.modal = null;
    await loadNetwork(app, client);
  } catch (e) {
    s.modalError = errMsg(e);
  } finally {
    s.saving = false;
    rerender(app);
  }
}

export async function setContactStatus(app: AppViewState, client: GatewayBrowserClient, id: string, status: string): Promise<void> {
  try {
    await client.request("network.contacts.update", { id, status });
    toast(app, `Status → ${status}`);
    await loadNetwork(app, client);
  } catch (e) {
    s.error = errMsg(e);
    rerender(app);
  }
}

export async function touchContact(app: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await client.request("network.contacts.update", { id, lastTouchDate: today });
    toast(app, "Marked as touched today");
    await loadNetwork(app, client);
  } catch (e) {
    s.error = errMsg(e);
    rerender(app);
  }
}

export async function deleteContact(app: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const name = s.graph?.nodes.find((n) => n.id === id)?.name ?? "this contact";
  if (typeof confirm === "function" && !confirm(`Remove ${name} and their connections from your network? A linked CRM client is not touched.`)) return;
  try {
    await client.request("network.contacts.delete", { id });
    s.selectedId = null;
    s.detail = null;
    toast(app, `${name} removed`);
    await loadNetwork(app, client);
  } catch (e) {
    s.error = errMsg(e);
    rerender(app);
  }
}

// ── Connection modal ──

export function openConnect(app: AppViewState, fromId?: string, toId?: string): void {
  s.modal = {
    kind: "connect",
    editingId: null,
    draft: {
      fromId: fromId ?? ME_ID,
      toId: toId ?? "",
      relationshipType: "colleague",
      strength: 3,
      direction: "mutual",
      status: "Active",
      lastTouchDate: "",
      notes: "",
      values: [{ valueType: "intro-access", description: "" }],
    },
  };
  s.modalError = null;
  rerender(app);
}

export function openEditConnection(app: AppViewState, edgeId: string, client?: GatewayBrowserClient): void {
  const e = s.graph?.edges.find((x) => x.id === edgeId);
  if (!e) return;
  if (client) void loadLinked(app, client, "connection", e.id);
  s.modal = {
    kind: "connect",
    editingId: e.id,
    draft: {
      fromId: e.from,
      toId: e.to,
      relationshipType: e.relationshipType,
      strength: e.strength,
      direction: e.direction,
      status: e.status,
      lastTouchDate: e.lastTouchDate,
      notes: "",
      values: e.values.length ? e.values.map((v) => ({ ...v })) : [{ valueType: "other", description: "" }],
    },
  };
  s.modalError = null;
  rerender(app);
}

export async function saveConnection(app: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const m = s.modal;
  if (!m || m.kind !== "connect") return;
  const d = m.draft;
  if (!m.editingId && (!d.fromId || !d.toId)) {
    s.modalError = "Pick both people.";
    rerender(app);
    return;
  }
  if (!m.editingId && d.fromId === d.toId) {
    s.modalError = "Pick two different people.";
    rerender(app);
    return;
  }
  const values = d.values
    .map((v) => ({ ...v, estimatedValue: Number(v.estimatedValue) || undefined, description: v.description.trim() }))
    .filter((v) => v.description || v.estimatedValue);
  s.saving = true;
  s.modalError = null;
  rerender(app);
  try {
    const common = {
      relationshipType: d.relationshipType,
      strength: d.strength,
      direction: d.direction,
      status: d.status,
      lastTouchDate: d.lastTouchDate,
      values,
    };
    if (m.editingId) {
      await client.request("network.connections.update", { id: m.editingId, ...common, ...(d.notes ? { notes: d.notes } : {}) });
      toast(app, "Connection saved");
    } else {
      await client.request("network.connections.create", { fromId: d.fromId, toId: d.toId, notes: d.notes, ...common });
      toast(app, "Connected");
    }
    s.modal = null;
    await loadNetwork(app, client);
  } catch (e) {
    s.modalError = errMsg(e);
  } finally {
    s.saving = false;
    rerender(app);
  }
}

export async function deleteConnection(app: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  if (typeof confirm === "function" && !confirm("Remove this connection?")) return;
  try {
    await client.request("network.connections.delete", { id });
    s.modal = null;
    s.selectedEdgeId = null;
    toast(app, "Connection removed");
    await loadNetwork(app, client);
  } catch (e) {
    s.modalError = errMsg(e);
    rerender(app);
  }
}

// ── Opportunity links ──

export async function openLinkOpportunity(app: AppViewState, client: GatewayBrowserClient, contactId: string): Promise<void> {
  s.modal = { kind: "link", contactId, target: `contact:${contactId}`, opportunityId: "", role: "", options: [], loading: true };
  s.modalError = null;
  rerender(app);
  try {
    const res = (await client.request("opportunity.list", {})) as { opportunities?: OpportunityOption[] };
    const m = s.modal as NetworkModal | null;
    if (m && m.kind === "link") {
      m.options = (res.opportunities ?? []).map((o) => ({ id: o.id, name: o.name, stage: o.stage, estimatedValue: o.estimatedValue }));
      m.opportunityId = m.options.find((o) => !TERMINAL_STAGES.includes(o.stage))?.id ?? m.options[0]?.id ?? "";
      m.loading = false;
    }
  } catch (e) {
    s.modalError = errMsg(e);
  }
  rerender(app);
}

export async function saveLink(app: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const m = s.modal;
  if (!m || m.kind !== "link") return;
  if (!m.opportunityId) {
    s.modalError = "Pick an opportunity.";
    rerender(app);
    return;
  }
  const [kind, id] = m.target.split(":") as ["contact" | "connection", string];
  s.saving = true;
  rerender(app);
  try {
    await client.request("network.opportunities.link", { kind, id, opportunityId: m.opportunityId, role: m.role });
    s.modal = null;
    toast(app, "Opportunity linked");
    await loadNetwork(app, client);
  } catch (e) {
    s.modalError = errMsg(e);
  } finally {
    s.saving = false;
    rerender(app);
  }
}

export async function unlinkOpportunity(
  app: AppViewState,
  client: GatewayBrowserClient,
  o: NetworkOpportunity,
): Promise<void> {
  if (o.via === "client") return;
  try {
    await client.request("network.opportunities.unlink", { kind: o.via, id: o.viaId, opportunityId: o.id });
    toast(app, "Opportunity unlinked");
    await loadNetwork(app, client);
  } catch (e) {
    s.error = errMsg(e);
    rerender(app);
  }
}

// ── Clients → network ──

export function openClientPicker(app: AppViewState, client: GatewayBrowserClient): void {
  s.modal = { kind: "clients", query: "", results: [], loading: true };
  s.modalError = null;
  rerender(app);
  void searchClients(app, client, "");
}

let clientSearchSeq = 0;
export async function searchClients(app: AppViewState, client: GatewayBrowserClient, query: string): Promise<void> {
  const m = s.modal;
  if (!m || m.kind !== "clients") return;
  m.query = query;
  m.loading = true;
  const seq = ++clientSearchSeq;
  rerender(app);
  try {
    const res = (await client.request("network.clients.search", { query, limit: 30 })) as { clients: ClientHit[] };
    const cur = s.modal as NetworkModal | null;
    if (seq === clientSearchSeq && cur && cur.kind === "clients") {
      cur.results = res.clients ?? [];
      cur.loading = false;
    }
  } catch (e) {
    s.modalError = errMsg(e);
  }
  rerender(app);
}

export async function promoteClient(app: AppViewState, client: GatewayBrowserClient, clientId: string): Promise<void> {
  try {
    const res = (await client.request("network.contacts.promoteClient", { clientId })) as { contact: Contact; created: boolean };
    toast(app, res.created ? `${res.contact.name} added from your clients` : `${res.contact.name} is already in your network`);
    const m = s.modal as NetworkModal | null;
    if (m && m.kind === "clients") {
      const hit = m.results.find((r) => r.id === clientId);
      if (hit) hit.inNetwork = res.contact.id;
    }
    s.selectedId = res.contact.id;
    await loadNetwork(app, client);
  } catch (e) {
    s.modalError = errMsg(e);
    rerender(app);
  }
}

// ── Formatting ──

export function fmtMoney(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return `$${v.toLocaleString()}`;
}

/** Node colour per contact type (graph fill, chips, legend). */
export const TYPE_COLORS: Record<string, string> = {
  client: "#e2b65a",
  prospect: "#f0904a",
  partner: "#3fc1b0",
  investor: "#a98cf0",
  advisor: "#5aa7f0",
  colleague: "#7ccf6a",
  vendor: "#8d9bb0",
  friend: "#ef7fae",
  other: "#a7a197",
};
export function typeColor(t: string): string {
  return TYPE_COLORS[t] ?? TYPE_COLORS.other;
}
