/**
 * Pure planning logic for knowledge-graph mutations, grouping and insights.
 *
 * Nothing in here talks to the gateway or the DOM: each planner turns
 * graph state into a list of RPC calls (plus their undo calls) that the
 * `<infinibot-knowledge-graph>` host executes. Keeping the decisions here
 * means linking, re-assigning, consolidation, duplicate/insight detection
 * and clustering are unit-tested under plain node vitest.
 */

import type { GraphNodeKind, ProjectHealth } from "./knowledge-graph-model";
import { ANCHOR_KINDS, HEALTH_COLOR, HEALTH_LABEL, KIND_LABEL, KIND_PALETTE, healthOf } from "./knowledge-graph-model";
import { layoutBrain, type BrainLayout } from "./knowledge-graph-brain";
import type { V3Layout } from "./knowledge-graph-layout-v3";

export interface OpNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  weight?: number;
  meta?: Record<string, unknown>;
}

export interface OpEdge {
  source: string;
  target: string;
  rel: string;
  inferred?: boolean;
  weight?: number;
}

export interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

/** One planned mutation: what to call, how to revert it, and a human label. */
export interface PlannedOp {
  nodeId: string;
  label: string;
  call: RpcCall;
  /** Calls that revert `call`. Empty = cannot be undone. */
  undo: RpcCall[];
}

export interface Skipped {
  nodeId: string;
  reason: string;
}

export interface Plan {
  ops: PlannedOp[];
  skipped: Skipped[];
}

/** Raw store id from a graph node id (`project:abc` → `abc`). */
export function rawIdOf(nodeId: string): string {
  const i = nodeId.indexOf(":");
  return i >= 0 ? nodeId.slice(i + 1) : nodeId;
}

/** Store id for a node: prefers the explicit meta id the gateway ships. */
export function storeIdOf(n: OpNode): string {
  const m = n.meta ?? {};
  if (n.kind === "project" && typeof m.projectId === "string" && m.projectId) return m.projectId;
  if (n.kind === "client" && typeof m.clientId === "string" && m.clientId) return m.clientId;
  return rawIdOf(n.id);
}

/**
 * Documents-workspace docs are graphed as note nodes (`note:doc:<id>`) but
 * aren't rows in the notes store, so notes.* writes can't touch them.
 */
export function isDocumentNode(n: OpNode): boolean {
  return n.kind === "note" && storeIdOf(n).startsWith("doc:");
}

const DOC_REASON = "Documents are edited on the Documents page";

// ── Linking ─────────────────────────────────────────────────────────

/**
 * Kinds the typed relation store (objrel) accepts AND the graph reads back
 * as edges. Runs/sessions/rows are transient or owned elsewhere.
 */
export const LINKABLE_KINDS: ReadonlySet<GraphNodeKind> = new Set<GraphNodeKind>([
  "project",
  "task",
  "client",
  "opportunity",
  "product",
  "person",
  "decision",
  "issue",
  "note",
  "report",
  "content",
  "agent",
]);

/** Typed edges (src/relations/types.ts RELATION_EDGES) keyed `from>to`. */
const TYPED_EDGES: Record<string, string> = {
  "client>opportunity": "client_has_opportunity",
  "opportunity>project": "opportunity_becomes_project",
  "project>task": "project_has_task",
  "project>product": "project_delivers_product",
  "product>opportunity": "product_offered_in_opportunity",
  "decision>task": "decision_guides_task",
  "task>person": "task_assigned_to_person",
  "issue>task": "issue_relates_task",
  "report>client": "report_documents_client",
  "report>opportunity": "report_documents_opportunity",
  "report>project": "report_documents_project",
};

export type LinkPlan =
  | {
      ok: true;
      call: RpcCall;
      /** Undo needs the created relation id (filled in by the host from the response). */
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      edge: string;
    }
  | { ok: false; reason: string };

/** Plan an objrel link between two graph nodes. */
export function planLink(
  a: OpNode | undefined,
  b: OpNode | undefined,
  adjacency?: Map<string, Set<string>>,
): LinkPlan {
  if (!a || !b) return { ok: false, reason: "Pick two nodes to link." };
  if (a.id === b.id) return { ok: false, reason: "A node can't link to itself." };
  if (!LINKABLE_KINDS.has(a.kind) || !LINKABLE_KINDS.has(b.kind)) {
    const bad = !LINKABLE_KINDS.has(a.kind) ? a : b;
    return { ok: false, reason: `${KIND_LABEL[bad.kind] ?? bad.kind} can't be linked from the graph.` };
  }
  if (adjacency?.get(a.id)?.has(b.id)) return { ok: false, reason: "These are already linked." };
  // Orient a typed edge when the pair has one; otherwise keep the drag direction.
  let from = a;
  let to = b;
  let edge = TYPED_EDGES[`${a.kind}>${b.kind}`];
  if (!edge && TYPED_EDGES[`${b.kind}>${a.kind}`]) {
    edge = TYPED_EDGES[`${b.kind}>${a.kind}`];
    from = b;
    to = a;
  }
  edge ??= "relates_to";
  const params = {
    fromType: from.kind,
    fromId: storeIdOf(from),
    toType: to.kind,
    toId: storeIdOf(to),
    edge,
    createdBy: "knowledge-graph",
  };
  return {
    ok: true,
    call: { method: "objrel.link", params },
    fromType: params.fromType,
    fromId: params.fromId,
    toType: params.toType,
    toId: params.toId,
    edge,
  };
}

/** Undo for a link: by relation id when known, else by its identity. */
export function unlinkCall(plan: Extract<LinkPlan, { ok: true }>, relationId?: string): RpcCall {
  if (relationId) return { method: "objrel.unlink", params: { id: relationId } };
  return {
    method: "objrel.unlink",
    params: {
      fromType: plan.fromType,
      fromId: plan.fromId,
      edge: plan.edge,
      toType: plan.toType,
      toId: plan.toId,
    },
  };
}

// ── Re-assign (drag onto a project) ─────────────────────────────────

/** Current project of a node, from meta or a containment/about edge. */
export function currentProjectOf(
  n: OpNode,
  edges: OpEdge[],
  byId: Map<string, OpNode>,
): string | null {
  const m = n.meta ?? {};
  if (n.kind === "task" && typeof m.projectId === "string" && m.projectId) return m.projectId;
  if (n.kind === "project") {
    return typeof m.parentProjectId === "string" && m.parentProjectId ? m.parentProjectId : null;
  }
  for (const e of edges) {
    const other = e.source === n.id ? e.target : e.target === n.id ? e.source : null;
    if (!other || e.inferred) continue;
    const o = byId.get(other);
    if (o?.kind === "project" && (e.rel === "about" || e.rel === "contains" || e.rel === "for project")) {
      return storeIdOf(o);
    }
  }
  return null;
}

/** True when `candidateId` is `projectId` or one of its descendants. */
function isSelfOrDescendant(projectId: string, candidateId: string, parentOf: Map<string, string | null>): boolean {
  const seen = new Set<string>();
  let cur: string | null | undefined = candidateId;
  while (cur && !seen.has(cur)) {
    if (cur === projectId) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

export type ReassignPlan =
  | { ok: true; op: PlannedOp; fromProjectId: string | null; toProjectId: string }
  | { ok: false; reason: string; fallbackLink?: boolean };

/** Whether a node can be dropped onto a project to change ownership. */
export function canReassign(kind: GraphNodeKind): boolean {
  return kind === "task" || kind === "note" || kind === "project";
}

export function planReassign(
  node: OpNode | undefined,
  target: OpNode | undefined,
  edges: OpEdge[],
  byId: Map<string, OpNode>,
): ReassignPlan {
  if (!node || !target) return { ok: false, reason: "Drop onto a project." };
  if (target.kind !== "project") return { ok: false, reason: "Drop onto a project to re-assign." };
  if (node.id === target.id) return { ok: false, reason: "Same project." };
  if (isDocumentNode(node)) return { ok: false, reason: DOC_REASON, fallbackLink: true };
  if (!canReassign(node.kind)) {
    return {
      ok: false,
      reason: `${KIND_LABEL[node.kind] ?? node.kind} belong to their own pages — linking instead.`,
      fallbackLink: LINKABLE_KINDS.has(node.kind),
    };
  }
  const to = storeIdOf(target);
  const from = currentProjectOf(node, edges, byId);
  if (from === to) return { ok: false, reason: `Already in ${target.label}.` };
  const id = storeIdOf(node);
  if (node.kind === "task") {
    return {
      ok: true,
      fromProjectId: from,
      toProjectId: to,
      op: {
        nodeId: node.id,
        label: `Moved "${node.label}" to ${target.label}`,
        call: { method: "kanban.tasks.update", params: { id, projectId: to } },
        undo: [{ method: "kanban.tasks.update", params: { id, projectId: from ?? null } }],
      },
    };
  }
  if (node.kind === "note") {
    return {
      ok: true,
      fromProjectId: from,
      toProjectId: to,
      op: {
        nodeId: node.id,
        label: `Filed "${node.label}" under ${target.label}`,
        call: { method: "notes.update", params: { id, projectId: to } },
        undo: [{ method: "notes.update", params: { id, projectId: from ?? "" } }],
      },
    };
  }
  // Project onto project → becomes a sub-project. Guard cycles client-side
  // too (the gateway enforces it authoritatively).
  const parentOf = new Map<string, string | null>();
  for (const n of byId.values()) {
    if (n.kind !== "project") continue;
    const p = n.meta?.parentProjectId;
    parentOf.set(storeIdOf(n), typeof p === "string" && p ? p : null);
  }
  if (isSelfOrDescendant(id, to, parentOf)) {
    return { ok: false, reason: `${target.label} sits under ${node.label} — that would make a loop.` };
  }
  return {
    ok: true,
    fromProjectId: from,
    toProjectId: to,
    op: {
      nodeId: node.id,
      label: `Made "${node.label}" a sub-project of ${target.label}`,
      call: { method: "kanban.projects.update", params: { id, parentProjectId: to } },
      undo: [{ method: "kanban.projects.update", params: { id, parentProjectId: from ?? null } }],
    },
  };
}

// ── Bulk operations ─────────────────────────────────────────────────

export type BulkStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

export const BULK_STATUSES: Array<{ id: BulkStatus; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** Task statuses map 1:1; projects use the kanban project vocabulary. */
const PROJECT_STATUS_FOR: Record<BulkStatus, string> = {
  backlog: "Not started",
  todo: "Not started",
  in_progress: "In progress",
  review: "Reviewing",
  done: "Completed",
};

export function planBulkStatus(nodes: OpNode[], status: BulkStatus): Plan {
  const ops: PlannedOp[] = [];
  const skipped: Skipped[] = [];
  for (const n of nodes) {
    const id = storeIdOf(n);
    const prev = typeof n.meta?.status === "string" ? (n.meta.status as string) : undefined;
    if (n.kind === "task") {
      if (prev === status) continue;
      ops.push({
        nodeId: n.id,
        label: n.label,
        call: { method: "kanban.tasks.update", params: { id, status } },
        undo: prev ? [{ method: "kanban.tasks.update", params: { id, status: prev } }] : [],
      });
    } else if (n.kind === "project") {
      const next = PROJECT_STATUS_FOR[status];
      if (prev === next) continue;
      ops.push({
        nodeId: n.id,
        label: n.label,
        call: { method: "kanban.projects.update", params: { id, status: next } },
        undo: prev ? [{ method: "kanban.projects.update", params: { id, status: prev } }] : [],
      });
    } else {
      skipped.push({ nodeId: n.id, reason: `${KIND_LABEL[n.kind] ?? n.kind} have no task status` });
    }
  }
  return { ops, skipped };
}

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 48);
}

export function planBulkTag(nodes: OpNode[], rawTag: string): Plan {
  const tag = normalizeTag(rawTag);
  const ops: PlannedOp[] = [];
  const skipped: Skipped[] = [];
  if (!tag) return { ops, skipped: nodes.map((n) => ({ nodeId: n.id, reason: "Empty tag" })) };
  for (const n of nodes) {
    const tags = n.meta?.tags;
    const id = storeIdOf(n);
    if (n.kind !== "note" && n.kind !== "task") {
      skipped.push({ nodeId: n.id, reason: `${KIND_LABEL[n.kind] ?? n.kind} can't be tagged here` });
      continue;
    }
    if (isDocumentNode(n)) {
      skipped.push({ nodeId: n.id, reason: DOC_REASON });
      continue;
    }
    // Without the current tag list a write would clobber existing tags.
    if (tags !== undefined && !Array.isArray(tags)) {
      skipped.push({ nodeId: n.id, reason: "Tags unreadable" });
      continue;
    }
    if (n.kind === "task" && tags === undefined) {
      skipped.push({ nodeId: n.id, reason: "Current tags unknown — refresh first" });
      continue;
    }
    const prev = ((tags as unknown[] | undefined) ?? []).filter((t): t is string => typeof t === "string");
    if (prev.includes(tag)) continue;
    const method = n.kind === "note" ? "notes.update" : "kanban.tasks.update";
    ops.push({
      nodeId: n.id,
      label: n.label,
      call: { method, params: { id, tags: [...prev, tag] } },
      undo: [{ method, params: { id, tags: prev } }],
    });
  }
  return { ops, skipped };
}

/** Deletes are only offered for tasks and notes; everything else lives on its own page. */
export function planBulkDelete(nodes: OpNode[]): Plan {
  const ops: PlannedOp[] = [];
  const skipped: Skipped[] = [];
  for (const n of nodes) {
    const id = storeIdOf(n);
    if (n.kind === "task") {
      ops.push({ nodeId: n.id, label: n.label, call: { method: "kanban.tasks.delete", params: { id } }, undo: [] });
    } else if (n.kind === "note" && !isDocumentNode(n)) {
      ops.push({ nodeId: n.id, label: n.label, call: { method: "notes.delete", params: { id } }, undo: [] });
    } else if (isDocumentNode(n)) {
      skipped.push({ nodeId: n.id, reason: DOC_REASON });
    } else {
      skipped.push({ nodeId: n.id, reason: `Delete ${KIND_LABEL[n.kind]?.toLowerCase() ?? n.kind} from their own page` });
    }
  }
  return { ops, skipped };
}

export function planBulkReassign(
  nodes: OpNode[],
  target: OpNode | undefined,
  edges: OpEdge[],
  byId: Map<string, OpNode>,
): Plan {
  const ops: PlannedOp[] = [];
  const skipped: Skipped[] = [];
  for (const n of nodes) {
    if (target && n.id === target.id) continue;
    const p = planReassign(n, target, edges, byId);
    if (p.ok) ops.push(p.op);
    else skipped.push({ nodeId: n.id, reason: p.reason });
  }
  return { ops, skipped };
}

export function planBulkLink(
  nodes: OpNode[],
  target: OpNode | undefined,
  adjacency?: Map<string, Set<string>>,
): { links: Array<{ nodeId: string; plan: Extract<LinkPlan, { ok: true }> }>; skipped: Skipped[] } {
  const links: Array<{ nodeId: string; plan: Extract<LinkPlan, { ok: true }> }> = [];
  const skipped: Skipped[] = [];
  for (const n of nodes) {
    if (target && n.id === target.id) continue;
    const p = planLink(n, target, adjacency);
    if (p.ok) links.push({ nodeId: n.id, plan: p });
    else skipped.push({ nodeId: n.id, reason: p.reason });
  }
  return { links, skipped };
}

// ── Consolidation ───────────────────────────────────────────────────

export interface ConsolidateInput {
  node: OpNode;
  body: string;
  degree: number;
}

export interface ConsolidatePlan {
  ok: true;
  kind: "note" | "task";
  primaryId: string;
  title: string;
  body: string;
  /** Node ids merged into the primary. */
  mergedIds: string[];
  /** Relations moved onto the primary so nothing is orphaned. */
  relinks: Array<{ from: OpNode; to: OpNode }>;
  /** Ordered calls: primary write, relinks, then duplicates removed/archived. */
  calls: RpcCall[];
}

export type ConsolidateResult = ConsolidatePlan | { ok: false; reason: string };

const CONSOLIDATABLE = new Set<GraphNodeKind>(["note", "task"]);

/** Paragraph-level de-duplication when bodies overlap. */
function mergeBodies(primary: ConsolidateInput, others: ConsolidateInput[]): string {
  const seen = new Set<string>();
  const norm = (p: string) => p.replace(/\s+/g, " ").trim().toLowerCase();
  const keep = (text: string): string =>
    text
      .split(/\n{2,}/)
      .filter((p) => {
        const k = norm(p);
        if (!k) return false;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .join("\n\n");
  const parts = [keep(primary.body)];
  for (const o of others) {
    const kept = keep(o.body);
    parts.push(`## Merged from: ${o.node.label}${kept ? `\n\n${kept}` : ""}`);
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

/**
 * Plan merging `items` (all notes or all tasks) into one. The primary is the
 * given id, else the most connected, else the longest body. Duplicates are
 * deleted (`removeMode: "delete"`) or kept and tagged `merged` (`"archive"`).
 */
export function planConsolidate(
  items: ConsolidateInput[],
  edges: OpEdge[],
  byId: Map<string, OpNode>,
  opts: { primaryId?: string; removeMode?: "delete" | "archive"; title?: string; body?: string } = {},
): ConsolidateResult {
  if (items.length < 2) return { ok: false, reason: "Select at least two items to consolidate." };
  const kind = items[0].node.kind;
  if (!CONSOLIDATABLE.has(kind) || items.some((i) => i.node.kind !== kind)) {
    return { ok: false, reason: "Consolidate works on items of one kind — all notes or all tasks." };
  }
  if (items.some((i) => isDocumentNode(i.node))) {
    return { ok: false, reason: `${DOC_REASON} — merge them there.` };
  }
  const sorted = [...items].sort(
    (a, b) => b.degree - a.degree || b.body.length - a.body.length || a.node.id.localeCompare(b.node.id),
  );
  const primary = (opts.primaryId && items.find((i) => i.node.id === opts.primaryId)) || sorted[0];
  const others = items.filter((i) => i !== primary);
  const title = (opts.title ?? primary.node.label).trim() || primary.node.label;
  const body = opts.body ?? mergeBodies(primary, others);
  const mergedSet = new Set(others.map((o) => o.node.id));

  // Carry relations over: anything linked to a duplicate (and not already to
  // the primary) gets linked to the primary. Containment edges are skipped —
  // the primary keeps its own project.
  const primaryNb = new Set<string>();
  for (const e of edges) {
    if (e.source === primary.node.id) primaryNb.add(e.target);
    if (e.target === primary.node.id) primaryNb.add(e.source);
  }
  const relinks: Array<{ from: OpNode; to: OpNode }> = [];
  const relinked = new Set<string>();
  for (const e of edges) {
    if (e.inferred || e.rel === "contains") continue;
    const dup = mergedSet.has(e.source) ? e.source : mergedSet.has(e.target) ? e.target : null;
    if (!dup) continue;
    const otherId = dup === e.source ? e.target : e.source;
    if (otherId === primary.node.id || mergedSet.has(otherId) || primaryNb.has(otherId) || relinked.has(otherId)) continue;
    const other = byId.get(otherId);
    if (!other || !LINKABLE_KINDS.has(other.kind)) continue;
    if (kind === "note" && other.kind === "project") continue; // carried by projectId below
    relinked.add(otherId);
    relinks.push({ from: primary.node, to: other });
  }

  const pid = storeIdOf(primary.node);
  const calls: RpcCall[] = [];
  if (kind === "note") {
    calls.push({ method: "notes.update", params: { id: pid, name: title, body } });
  } else {
    if (title !== primary.node.label) calls.push({ method: "kanban.tasks.update", params: { id: pid, title } });
    calls.push({ method: "kanban.tasks.content.setMarkdown", params: { taskId: pid, markdown: body } });
  }
  for (const r of relinks) {
    const p = planLink(r.from, r.to);
    if (p.ok) calls.push(p.call);
  }
  const removeMode = opts.removeMode ?? (kind === "note" ? "delete" : "archive");
  for (const o of others) {
    const oid = storeIdOf(o.node);
    if (removeMode === "delete") {
      calls.push(
        kind === "note"
          ? { method: "notes.delete", params: { id: oid } }
          : { method: "kanban.tasks.delete", params: { id: oid } },
      );
    } else {
      const prevTags = Array.isArray(o.node.meta?.tags)
        ? (o.node.meta!.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      const tags = prevTags.includes("merged") ? prevTags : [...prevTags, "merged"];
      calls.push(
        kind === "note"
          ? { method: "notes.update", params: { id: oid, tags } }
          : { method: "kanban.tasks.update", params: { id: oid, status: "done" } },
      );
    }
  }
  return {
    ok: true,
    kind: kind as "note" | "task",
    primaryId: primary.node.id,
    title,
    body,
    mergedIds: others.map((o) => o.node.id),
    relinks,
    calls,
  };
}

// ── Text similarity (duplicates + suggested links) ──────────────────

const STOPWORDS = new Set(
  "a an and the of for to in on at by with from or is are be this that it its as into via vs v2 v3 copy new old draft final notes note task tasks project".split(
    " ",
  ),
);

export function tokensOf(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/\(\d+\)/g, " ")
    .replace(/[^a-z0-9À-￿]+/g, " ")
    .split(" ")
    // Numbers stay (Sprint 12 ≠ Sprint 13); copy counters like "(1)" were stripped above.
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const DUP_KINDS = new Set<GraphNodeKind>(["note", "task", "project", "client", "opportunity", "issue", "decision", "product"]);

/**
 * Likely duplicates: same kind, near-identical titles. Candidate pairs come
 * from an inverted token index (tokens shared by too many labels are
 * ignored) so this stays well under O(n²) on thousands of nodes.
 */
export function findDuplicates(nodes: OpNode[], threshold = 0.75, maxBucket = 120): string[][] {
  const toks = new Map<string, Set<string>>();
  const exact = new Map<string, string[]>();
  const index = new Map<string, string[]>();
  for (const n of nodes) {
    if (!DUP_KINDS.has(n.kind)) continue;
    const t = tokensOf(n.label);
    if (!t.length) continue;
    const set = new Set(t);
    toks.set(n.id, set);
    const key = `${n.kind}|${[...set].sort().join(" ")}`;
    (exact.get(key) ?? exact.set(key, []).get(key)!).push(n.id);
    for (const tok of set) {
      const k = `${n.kind}|${tok}`;
      (index.get(k) ?? index.set(k, []).get(k)!).push(n.id);
    }
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const ids of toks.keys()) parent.set(ids, ids);
  for (const group of exact.values()) for (let i = 1; i < group.length; i++) union(group[0], group[i]);
  const compared = new Set<string>();
  for (const ids of index.values()) {
    if (ids.length < 2 || ids.length > maxBucket) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (compared.has(key)) continue;
        compared.add(key);
        const ta = toks.get(a)!;
        const tb = toks.get(b)!;
        // Single-token titles only match exactly (handled above).
        if (Math.min(ta.size, tb.size) < 2) continue;
        if (jaccard(ta, tb) >= threshold) union(a, b);
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of toks.keys()) {
    const r = find(id);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(id);
  }
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

export interface LinkSuggestion {
  a: string;
  b: string;
  score: number;
  reason: string;
}

/**
 * Suggested links between unconnected nodes: shared distinctive title words
 * (idf-weighted) plus common neighbours (Adamic–Adar). Optional `focus`
 * restricts suggestions to pairs touching those ids ("find related").
 */
export function suggestLinks(
  nodes: OpNode[],
  edges: OpEdge[],
  opts: { focus?: Set<string>; limit?: number; maxBucket?: number } = {},
): LinkSuggestion[] {
  const limit = opts.limit ?? 12;
  const maxBucket = opts.maxBucket ?? 60;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nb = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    (nb.get(e.source) ?? nb.set(e.source, new Set()).get(e.source)!).add(e.target);
    (nb.get(e.target) ?? nb.set(e.target, new Set()).get(e.target)!).add(e.source);
  }
  const eligible = nodes.filter((n) => LINKABLE_KINDS.has(n.kind));
  const toks = new Map<string, Set<string>>();
  const index = new Map<string, string[]>();
  for (const n of eligible) {
    const set = new Set(tokensOf(n.label));
    toks.set(n.id, set);
    for (const t of set) (index.get(t) ?? index.set(t, []).get(t)!).push(n.id);
  }
  const total = Math.max(1, eligible.length);
  const scores = new Map<string, { score: number; words: string[]; common: number }>();
  const add = (a: string, b: string, s: number, word?: string, common = 0) => {
    if (a === b) return;
    if (opts.focus && !opts.focus.has(a) && !opts.focus.has(b)) return;
    if (nb.get(a)?.has(b)) return;
    const na = byId.get(a);
    const nbn = byId.get(b);
    if (!na || !nbn || !LINKABLE_KINDS.has(na.kind) || !LINKABLE_KINDS.has(nbn.kind)) return;
    if (na.kind === "task" && nbn.kind === "task") return; // task↔task is noise
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const cur = scores.get(key) ?? { score: 0, words: [], common: 0 };
    cur.score += s;
    if (word) cur.words.push(word);
    cur.common += common;
    scores.set(key, cur);
  };
  for (const [tok, ids] of index) {
    if (ids.length < 2 || ids.length > maxBucket || tok.length < 4) continue;
    const idf = Math.log(total / ids.length);
    if (idf <= 0.5) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], idf, tok);
  }
  // Common neighbours via each hub (skip mega-hubs, they say nothing).
  for (const [hub, set] of nb) {
    if (set.size < 2 || set.size > maxBucket) continue;
    const w = 1 / Math.log(set.size + 1.5);
    const ids = [...set];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], w * 1.4, undefined, 1);
    void hub;
  }
  const out: LinkSuggestion[] = [];
  for (const [key, v] of scores) {
    if (v.score < 1.6) continue;
    const [a, b] = key.split("|");
    const reasons: string[] = [];
    if (v.words.length) reasons.push(`both mention “${v.words.slice(0, 2).join("”, “")}”`);
    if (v.common) reasons.push(`${v.common} shared connection${v.common > 1 ? "s" : ""}`);
    out.push({ a, b, score: Math.round(v.score * 100) / 100, reason: reasons.join(" · ") });
  }
  out.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a));
  return out.slice(0, limit);
}

// ── Grouping / clustering ───────────────────────────────────────────

export type GroupMode = "brain" | "orbit" | "project" | "status" | "type" | "cluster";

export const GROUP_MODES: Array<{ id: GroupMode; label: string }> = [
  { id: "brain", label: "Brain" },
  { id: "orbit", label: "Orbits" },
  { id: "project", label: "Projects" },
  { id: "status", label: "Status" },
  { id: "type", label: "Types" },
  { id: "cluster", label: "Clusters" },
];

export interface NodeGroup {
  key: string;
  label: string;
  color: string;
  memberIds: string[];
}

export interface Grouping {
  mode: GroupMode;
  groups: NodeGroup[];
  groupOf: Map<string, string>;
  /** Brain mode: lobe regions + per-node targets (see knowledge-graph-brain.ts). */
  brain?: BrainLayout;
  /** v3 readable layout (regions → units → nodes) for every mode. */
  v3?: V3Layout;
}

/** Deterministic label propagation (same algorithm as graph.summary). */
export function communities(ids: string[], edges: OpEdge[], rounds = 8): Map<string, string> {
  const label = new Map<string, string>();
  for (const id of ids) label.set(id, id);
  const nb = new Map<string, string[]>();
  for (const e of edges) {
    if (!label.has(e.source) || !label.has(e.target)) continue;
    (nb.get(e.source) ?? nb.set(e.source, []).get(e.source)!).push(e.target);
    (nb.get(e.target) ?? nb.set(e.target, []).get(e.target)!).push(e.source);
  }
  const order = [...ids].sort();
  for (let r = 0; r < rounds; r++) {
    let changed = false;
    for (const id of order) {
      const ns = nb.get(id);
      if (!ns?.length) continue;
      const counts = new Map<string, number>();
      for (const n of ns) {
        const l = label.get(n)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id)!;
      let bestC = -1;
      for (const [l, c] of counts) {
        if (c > bestC || (c === bestC && l < best)) {
          best = l;
          bestC = c;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

const CLUSTER_COLORS = ["#f5c542", "#5eead4", "#c4b5fd", "#f0abfc", "#93c5fd", "#fdba74", "#86efac", "#fb7185"];

export function computeGrouping(nodes: OpNode[], edges: OpEdge[], mode: GroupMode): Grouping {
  const groupOf = new Map<string, string>();
  const groups = new Map<string, NodeGroup>();
  const put = (id: string, key: string, label: string, color: string) => {
    groupOf.set(id, key);
    const g = groups.get(key) ?? groups.set(key, { key, label, color, memberIds: [] }).get(key)!;
    g.memberIds.push(id);
  };
  if (mode === "orbit") return { mode, groups: [], groupOf };
  if (mode === "brain") {
    // Groups = brain lobe regions (all of them, even empty, in lobe order).
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const neighbors: number[][] = nodes.map(() => []);
    for (const e of edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a == null || b == null || a === b) continue;
      neighbors[a].push(b);
      neighbors[b].push(a);
    }
    // Sub-projects orbit their parent ("sub-project of": child → parent).
    const hint = new Map<number, number>();
    for (const e of edges) {
      if (e.rel !== "sub-project of") continue;
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a != null && b != null && nodes[a].kind === "project" && nodes[b].kind === "project") hint.set(a, b);
    }
    const brain = layoutBrain(
      nodes.map((n, i) => ({ id: n.id, kind: n.kind, anchor: ANCHOR_KINDS.has(n.kind), meta: n.meta, parent: hint.get(i) })),
      neighbors,
    );
    for (const r of brain.regions) groups.set(r.key, { key: r.key, label: r.label, color: r.color, memberIds: [] });
    nodes.forEach((n, i) => {
      const r = brain.regionOf[i];
      groupOf.set(n.id, r);
      groups.get(r)?.memberIds.push(n.id);
    });
    return { mode, groups: [...groups.values()], groupOf, brain };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Each satellite's owning project: explicit edges first, then any project neighbour.
  const projectOf = new Map<string, string>();
  const strong = (rel: string) => rel === "contains" || rel === "about" || rel === "for project";
  for (const pass of [true, false]) {
    for (const e of edges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) continue;
      if (pass && (!strong(e.rel) || e.inferred)) continue;
      if (s.kind === "project" && t.kind !== "project" && !projectOf.has(t.id)) projectOf.set(t.id, s.id);
      if (t.kind === "project" && s.kind !== "project" && !projectOf.has(s.id)) projectOf.set(s.id, t.id);
    }
  }
  if (mode === "project") {
    for (const n of nodes) {
      const pid = n.kind === "project" ? n.id : projectOf.get(n.id);
      if (!pid) continue;
      const p = byId.get(pid)!;
      put(n.id, pid, p.label, HEALTH_COLOR[healthOf(p.meta)]);
    }
  } else if (mode === "status") {
    for (const n of nodes) {
      const pid = n.kind === "project" ? n.id : projectOf.get(n.id);
      const h: ProjectHealth | "unfiled" = pid ? healthOf(byId.get(pid)!.meta) : "unfiled";
      if (h === "unfiled") put(n.id, "unfiled", "No project", "#8a8474");
      else put(n.id, `h:${h}`, HEALTH_LABEL[h], HEALTH_COLOR[h]);
    }
  } else if (mode === "type") {
    for (const n of nodes) put(n.id, `k:${n.kind}`, KIND_LABEL[n.kind] ?? n.kind, KIND_PALETTE[n.kind] ?? "#9ca3af");
  } else {
    const lab = communities(
      nodes.map((n) => n.id),
      edges.filter((e) => !e.inferred),
    );
    const members = new Map<string, string[]>();
    for (const [id, l] of lab) (members.get(l) ?? members.set(l, []).get(l)!).push(id);
    let ci = 0;
    const sortedClusters = [...members.values()].filter((m) => m.length >= 3).sort((a, b) => b.length - a.length);
    for (const m of sortedClusters) {
      // Name a cluster after its best-connected anchor (project/client) or its first member.
      const anchor =
        m.map((id) => byId.get(id)!).find((n) => n.kind === "project") ??
        m.map((id) => byId.get(id)!).find((n) => n.kind === "client") ??
        byId.get(m[0])!;
      const key = `c:${anchor.id}`;
      const color = CLUSTER_COLORS[ci++ % CLUSTER_COLORS.length];
      for (const id of m) put(id, key, `${anchor.label} cluster`, color);
    }
  }
  const list = [...groups.values()].sort((a, b) => b.memberIds.length - a.memberIds.length);
  return { mode, groups: list, groupOf };
}

/**
 * Layout targets for sector grouping: groups are placed on a ring around
 * the centre, sized by membership, so the force layout pulls each group into
 * its own region. Returns key → {x, y, r}.
 */
export function groupTargets(
  groups: NodeGroup[],
  center: { cx: number; cy: number },
): Map<string, { x: number; y: number; r: number }> {
  const out = new Map<string, { x: number; y: number; r: number }>();
  const n = groups.length;
  if (!n) return out;
  const radii = groups.map((g) => 40 + 16 * Math.sqrt(g.memberIds.length));
  const circumference = radii.reduce((a, r) => a + r * 2.4, 0);
  const ring = n === 1 ? 0 : Math.max(160, circumference / (2 * Math.PI));
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const share = (radii[i] * 2.4) / circumference;
    const angle = (acc + share / 2) * Math.PI * 2 - Math.PI / 2;
    acc += share;
    out.set(groups[i].key, { x: center.cx + ring * Math.cos(angle), y: center.cy + ring * Math.sin(angle), r: radii[i] });
  }
  return out;
}

// ── Insights (client-side, complementing the gateway's) ─────────────

export type InsightAction =
  | "focus"
  | "select"
  | "consolidate"
  | "subs"
  | "link"
  | "suggest"
  | "chat"
  | "spawn"
  | "dismiss";

export interface GraphInsightIn {
  id: string;
  kind: string;
  severity: "high" | "medium" | "info";
  title: string;
  detail?: string;
  nodeIds: string[];
}

export interface HudInsight extends GraphInsightIn {
  actions: InsightAction[];
  /** For `suggested-link`: the pair to link in one click. */
  pair?: [string, string];
  source: "gateway" | "graph";
}

const STALE_MS = 14 * 86_400_000;
const ORPHAN_KINDS = new Set<GraphNodeKind>(["note", "issue", "decision", "opportunity", "product", "report", "content", "task"]);

function namesOf(ids: string[], byId: Map<string, OpNode>, max = 3): string {
  const names = ids.slice(0, max).map((id) => byId.get(id)?.label ?? id);
  return ids.length > max ? `${names.join(", ")} +${ids.length - max}` : names.join(", ");
}

const SERVER_ACTIONS: Record<string, InsightAction[]> = {
  blocked: ["focus", "chat", "spawn"],
  stale: ["focus", "chat", "spawn"],
  overdue: ["focus", "chat", "spawn"],
  "agents-now": ["focus", "select"],
};

/**
 * Merge the gateway's insights with graph-derived ones: orphans, likely
 * duplicates, suggested links, projects with blocked tasks, and a stale
 * fallback. `dismissed` ids are dropped.
 */
export function detectInsights(
  nodes: OpNode[],
  edges: OpEdge[],
  server: GraphInsightIn[] | undefined,
  now: number,
  dismissed: ReadonlySet<string> = new Set(),
): HudInsight[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: HudInsight[] = [];
  const serverIds = new Set<string>();
  for (const s of server ?? []) {
    if (!s || typeof s.id !== "string") continue;
    serverIds.add(s.kind);
    const ids = (s.nodeIds ?? []).filter((id) => byId.has(id));
    out.push({ ...s, nodeIds: ids, actions: SERVER_ACTIONS[s.kind] ?? ["focus", "select"], source: "gateway" });
  }
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const projects = nodes.filter((n) => n.kind === "project");

  if (!serverIds.has("stale")) {
    const stale = projects.filter((p) => {
      const h = healthOf(p.meta);
      const last = Number(p.meta?.lastActivityAt ?? 0);
      return h !== "done" && h !== "backlog" && last > 0 && now - last > STALE_MS;
    });
    if (stale.length) {
      out.push({
        id: "g:stale",
        kind: "stale",
        severity: "medium",
        title: `${stale.length} open project${stale.length > 1 ? "s" : ""} gone quiet`,
        detail: namesOf(stale.map((p) => p.id), byId),
        nodeIds: stale.map((p) => p.id),
        actions: ["focus", "chat", "spawn"],
        source: "graph",
      });
    }
  }

  const blockedTasks = projects.filter((p) => Number(p.meta?.blocked ?? 0) > 0 && healthOf(p.meta) !== "blocked");
  if (blockedTasks.length) {
    const total = blockedTasks.reduce((a, p) => a + Number(p.meta?.blocked ?? 0), 0);
    out.push({
      id: "g:blocked-tasks",
      kind: "blocked-tasks",
      severity: "high",
      title: `${total} blocked task${total > 1 ? "s" : ""} in ${blockedTasks.length} project${blockedTasks.length > 1 ? "s" : ""}`,
      detail: namesOf(blockedTasks.map((p) => p.id), byId),
      nodeIds: blockedTasks.map((p) => p.id),
      actions: ["focus", "chat", "spawn"],
      source: "graph",
    });
  }

  const orphans = nodes.filter((n) => ORPHAN_KINDS.has(n.kind) && !degree.get(n.id));
  if (orphans.length) {
    out.push({
      id: "g:orphans",
      kind: "orphans",
      severity: orphans.length > 10 ? "medium" : "info",
      title: `${orphans.length} orphan${orphans.length > 1 ? "s" : ""} with no links`,
      detail: namesOf(orphans.map((n) => n.id), byId),
      nodeIds: orphans.map((n) => n.id),
      actions: ["select", "suggest", "focus"],
      source: "graph",
    });
  }

  const dups = findDuplicates(nodes);
  for (const g of dups.slice(0, 4)) {
    const first = byId.get(g[0])!;
    out.push({
      id: `g:dup:${g.slice().sort().join(",")}`,
      kind: "duplicates",
      severity: "medium",
      title: `${g.length} look-alike ${KIND_LABEL[first.kind]?.toLowerCase() ?? first.kind}`,
      detail: namesOf(g, byId),
      nodeIds: g,
      actions: first.kind === "note" || first.kind === "task" ? ["consolidate", "focus", "select"] : ["focus", "select"],
      source: "graph",
    });
  }
  if (dups.length > 4) {
    const ids = dups.slice(4).flat();
    out.push({
      id: "g:dup:more",
      kind: "duplicates",
      severity: "info",
      title: `${dups.length - 4} more duplicate groups`,
      detail: namesOf(ids, byId),
      nodeIds: ids,
      actions: ["select", "focus"],
      source: "graph",
    });
  }

  for (const s of suggestLinks(nodes, edges, { limit: 3 })) {
    out.push({
      id: `g:link:${s.a}|${s.b}`,
      kind: "suggested-link",
      severity: "info",
      title: `Link ${byId.get(s.a)?.label ?? s.a} ↔ ${byId.get(s.b)?.label ?? s.b}?`,
      detail: s.reason,
      nodeIds: [s.a, s.b],
      pair: [s.a, s.b],
      actions: ["link", "focus"],
      source: "graph",
    });
  }

  const sevRank = { high: 0, medium: 1, info: 2 } as const;
  return out
    .filter((i) => !dismissed.has(i.id) && i.nodeIds.length > 0)
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
}

// ── Activity diff between snapshots (proactive feed) ────────────────

export interface ActivityItem {
  id: string;
  at: number;
  nodeId: string;
  text: string;
  tone: "new" | "status" | "live" | "gone";
}

/** What changed between two polls: new nodes, status/health flips, agents starting. */
export function diffActivity(prev: OpNode[] | null, next: OpNode[], now: number, max = 12): ActivityItem[] {
  if (!prev?.length) return [];
  const before = new Map(prev.map((n) => [n.id, n]));
  const out: ActivityItem[] = [];
  for (const n of next) {
    const p = before.get(n.id);
    const kindName = (n.kind as string) === "project" ? "Project" : (KIND_LABEL[n.kind] ?? n.kind).replace(/s$/, "");
    if (!p) {
      out.push({ id: `new:${n.id}:${now}`, at: now, nodeId: n.id, text: `New ${kindName.toLowerCase()} · ${n.label}`, tone: "new" });
      continue;
    }
    const st = (m?: Record<string, unknown>) =>
      String(m?.health ?? m?.status ?? m?.pipelineStatus ?? "");
    if (st(p.meta) && st(n.meta) && st(p.meta) !== st(n.meta)) {
      out.push({
        id: `st:${n.id}:${now}`,
        at: now,
        nodeId: n.id,
        text: `${n.label} · ${st(p.meta).replace(/_/g, " ")} → ${st(n.meta).replace(/_/g, " ")}`,
        tone: "status",
      });
    }
    const live = (m?: Record<string, unknown>) => m?.live === true || m?.active === true;
    if (!live(p.meta) && live(n.meta)) {
      out.push({ id: `live:${n.id}:${now}`, at: now, nodeId: n.id, text: `Agent started on ${n.label}`, tone: "live" });
    }
  }
  if (out.length > max) return out.slice(0, max);
  return out;
}

// ── Selection geometry ──────────────────────────────────────────────

/** Even-odd point-in-polygon; `poly` is a flat [x0,y0,x1,y1,…] list. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Ids whose screen position falls inside the lasso. A lasso that barely
 * moved (≤ 3 points or a tiny area) is treated as a box from its bounds.
 */
export function selectInLasso(
  poly: number[],
  points: Array<{ id: string; x: number; y: number; visible: boolean }>,
): string[] {
  if (poly.length < 6) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i]);
    x1 = Math.max(x1, poly[i]);
    y0 = Math.min(y0, poly[i + 1]);
    y1 = Math.max(y1, poly[i + 1]);
  }
  const out: string[] = [];
  for (const p of points) {
    if (!p.visible || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
    if (pointInPolygon(p.x, p.y, poly)) out.push(p.id);
  }
  return out;
}

/** Rectangle → polygon (box select). */
export function boxPolygon(ax: number, ay: number, bx: number, by: number): number[] {
  return [ax, ay, bx, ay, bx, by, ax, by];
}

// ── Undo ────────────────────────────────────────────────────────────

export interface UndoEntry {
  label: string;
  calls: RpcCall[];
  at: number;
}

export class UndoStack {
  private items: UndoEntry[] = [];
  constructor(private readonly max = 25) {}
  push(label: string, calls: RpcCall[], at = Date.now()): void {
    if (!calls.length) return;
    this.items.push({ label, calls, at });
    if (this.items.length > this.max) this.items.shift();
  }
  pop(): UndoEntry | undefined {
    return this.items.pop();
  }
  peek(): UndoEntry | undefined {
    return this.items[this.items.length - 1];
  }
  get size(): number {
    return this.items.length;
  }
}

// ── AI context ──────────────────────────────────────────────────────

/** Compact, bounded text description of nodes + their relations for an agent prompt. */
export function buildAiContext(
  nodes: OpNode[],
  edges: OpEdge[],
  byId: Map<string, OpNode>,
  maxChars = 6000,
): string {
  const ids = new Set(nodes.map((n) => n.id));
  const lines: string[] = [];
  for (const n of nodes) {
    const m = n.meta ?? {};
    const bits: string[] = [`[${n.kind}] ${n.label} (id ${n.id})`];
    if (n.kind === "project") {
      bits.push(`status ${HEALTH_LABEL[healthOf(m)]}`);
      if (Number(m.tasks ?? 0) > 0) bits.push(`${Number(m.done ?? 0)}/${Number(m.tasks)} tasks done`);
      if (Number(m.blocked ?? 0) > 0) bits.push(`${m.blocked} blocked`);
      if (Number(m.overdue ?? 0) > 0) bits.push(`${m.overdue} overdue`);
    } else if (m.status) bits.push(`status ${String(m.status)}`);
    if (Array.isArray(m.tags) && m.tags.length) bits.push(`tags ${(m.tags as string[]).slice(0, 6).join(", ")}`);
    const rels: string[] = [];
    for (const e of edges) {
      const other = e.source === n.id ? e.target : e.target === n.id ? e.source : null;
      if (!other) continue;
      const o = byId.get(other);
      if (!o) continue;
      rels.push(`${e.rel} ${o.kind} "${o.label}"${ids.has(other) ? " (in selection)" : ""}`);
      if (rels.length >= 8) break;
    }
    if (rels.length) bits.push(`relations: ${rels.join("; ")}`);
    lines.push(`- ${bits.join(" · ")}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 40)}\n… (${nodes.length} items, truncated)`;
  return text;
}

export type AiIntent = "chat" | "summarize" | "related" | "consolidate" | "cluster";

/** Opening prompt for an AI action over a selection. */
export function aiPrompt(intent: AiIntent, context: string, count: number): string {
  const head = `These ${count === 1 ? "is one item" : `are ${count} items`} from my InfiniBot knowledge graph:\n\n${context}\n\n`;
  switch (intent) {
    case "summarize":
      return `${head}Summarize them in a few tight bullets: what they are, their status, what's blocked or stale, and the single most useful next step.`;
    case "related":
      return `${head}Which other projects, notes, tasks or clients in my workspace are most related to these and should be linked? Use your tools to look them up, then list the best candidates with one line each on why.`;
    case "consolidate":
      return `${head}Which of these overlap or duplicate each other? Propose how to merge them into fewer items (which one to keep, what to fold in). Don't change anything yet.`;
    case "cluster":
      return `${head}Group these into a few meaningful clusters and name each cluster. Keep it short.`;
    default:
      return `${head}I want to talk about these. Start with a two-line read of where they stand, then wait for my question.`;
  }
}

/** Task text for "Spawn agent on this". */
export function spawnTask(context: string, count: number, goal: string): string {
  const g = goal.trim() || "Review these items, move them forward, and report back what you changed.";
  return `${g}\n\nContext — ${count} item${count === 1 ? "" : "s"} selected in the InfiniBot knowledge graph:\n${context}`;
}

// ── Snapshot hardening ──────────────────────────────────────────────

const KNOWN_KINDS = new Set<string>(Object.keys(KIND_PALETTE));

export interface SafeSnapshot {
  generatedAt: number;
  nodes: OpNode[];
  edges: OpEdge[];
  typeStats: Partial<Record<GraphNodeKind, number>>;
  insights?: GraphInsightIn[];
  hidden?: Partial<Record<GraphNodeKind, number>>;
  kinds?: GraphNodeKind[];
  /** Records dropped while sanitizing (malformed input). */
  dropped: number;
}

/**
 * Defensive copy of a gateway snapshot: drops nodes without a string id,
 * unknown kinds become "node", labels are clamped, duplicate ids keep the
 * first, edges must reference kept nodes. Never throws.
 */
export function sanitizeSnapshot(raw: unknown, maxNodes = 60_000): SafeSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawNodes = Array.isArray(r.nodes) ? r.nodes : [];
  const rawEdges = Array.isArray(r.edges) ? r.edges : [];
  let dropped = 0;
  const seen = new Set<string>();
  const nodes: OpNode[] = [];
  for (const n of rawNodes) {
    if (nodes.length >= maxNodes) {
      dropped++;
      continue;
    }
    const o = n as Record<string, unknown> | null;
    const id = o && typeof o.id === "string" ? o.id : o && typeof o.id === "number" ? String(o.id) : "";
    if (!id || seen.has(id)) {
      dropped++;
      continue;
    }
    seen.add(id);
    const kind = (typeof o!.kind === "string" && KNOWN_KINDS.has(o!.kind) ? o!.kind : "node") as GraphNodeKind;
    const label = typeof o!.label === "string" && o!.label.trim() ? o!.label.trim().slice(0, 240) : id;
    const meta = o!.meta && typeof o!.meta === "object" && !Array.isArray(o!.meta) ? (o!.meta as Record<string, unknown>) : undefined;
    const weight = typeof o!.weight === "number" && Number.isFinite(o!.weight) ? (o!.weight as number) : undefined;
    nodes.push({ id, kind, label, meta, ...(weight != null ? { weight } : {}) });
  }
  const edges: OpEdge[] = [];
  for (const e of rawEdges) {
    const o = e as Record<string, unknown> | null;
    const s = o && typeof o.source === "string" ? o.source : "";
    const t = o && typeof o.target === "string" ? o.target : "";
    if (!s || !t || s === t || !seen.has(s) || !seen.has(t)) {
      dropped++;
      continue;
    }
    edges.push({
      source: s,
      target: t,
      rel: typeof o!.rel === "string" ? o!.rel : "relates to",
      ...(o!.inferred === true ? { inferred: true } : {}),
      ...(typeof o!.weight === "number" && Number.isFinite(o!.weight) ? { weight: o!.weight as number } : {}),
    });
  }
  const insights = Array.isArray(r.insights)
    ? (r.insights as unknown[]).filter(
        (i): i is GraphInsightIn =>
          !!i && typeof i === "object" && typeof (i as GraphInsightIn).id === "string" && Array.isArray((i as GraphInsightIn).nodeIds),
      )
    : undefined;
  return {
    generatedAt: typeof r.generatedAt === "number" ? r.generatedAt : Date.now(),
    nodes,
    edges,
    typeStats: r.typeStats && typeof r.typeStats === "object" ? (r.typeStats as SafeSnapshot["typeStats"]) : {},
    insights,
    hidden: r.hidden && typeof r.hidden === "object" ? (r.hidden as SafeSnapshot["hidden"]) : undefined,
    kinds: Array.isArray(r.kinds) ? (r.kinds as GraphNodeKind[]) : undefined,
    dropped,
  };
}
