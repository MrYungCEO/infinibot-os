/**
 * Conversation workflow graphs: agent nodes, sequence edges and a lead →
 * sub-agent hierarchy (`parentId`). Both edges and parent links are
 * dependencies; nodes whose dependencies are met together form one layer and
 * run in parallel. Pure — shared by the gateway executor and the builder UI.
 */
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./types.js";

export const MAX_WORKFLOW_NODES = 24;

function rid(prefix: string): string {
  const r =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${r.replace(/-/g, "").slice(0, 10)}`;
}

export function newNodeId(): string {
  return rid("n");
}

export function newEdgeId(): string {
  return rid("e");
}

export function newWorkflowId(): string {
  return rid("wf");
}

/** Every dependency pair (source must finish before target), edges + parent links, deduped. */
export function dependencyPairs(
  graph: Pick<WorkflowGraph, "nodes" | "edges">,
): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  const push = (a: string, b: string) => {
    const k = `${a}\u0000${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([a, b]);
  };
  for (const n of graph.nodes) if (n.parentId) push(n.parentId, n.id);
  for (const e of graph.edges) push(e.sourceId, e.targetId);
  return out;
}

export function predecessorsOf(
  graph: Pick<WorkflowGraph, "nodes" | "edges">,
  nodeId: string,
): string[] {
  return dependencyPairs(graph)
    .filter(([, b]) => b === nodeId)
    .map(([a]) => a);
}

/** Stable Kahn layering. Throws on a cycle or a dangling reference. */
export function topologicalLayers(graph: Pick<WorkflowGraph, "nodes" | "edges">): WorkflowNode[][] {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const [a, b] of dependencyPairs(graph)) {
    if (!index.has(a) || !index.has(b))
      throw new Error(`Link references a missing step (${a} → ${b})`);
    indegree.set(b, (indegree.get(b) ?? 0) + 1);
    out.get(a)!.push(b);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let ready = graph.nodes.filter((n) => indegree.get(n.id) === 0);
  const layers: WorkflowNode[][] = [];
  let seen = 0;
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
    layers.push(ready);
    const next: WorkflowNode[] = [];
    for (const n of ready) {
      seen += 1;
      for (const t of out.get(n.id) ?? []) {
        indegree.set(t, (indegree.get(t) ?? 0) - 1);
        if (indegree.get(t) === 0) next.push(byId.get(t)!);
      }
    }
    ready = next;
  }
  if (seen !== graph.nodes.length)
    throw new Error("Workflow has a cycle — remove a link so steps flow one way");
  return layers;
}

export function validateWorkflow(
  graph: WorkflowGraph,
  opts: { members?: string[] } = {},
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!graph.name?.trim()) errors.push("Workflow needs a name");
  if (graph.nodes.length === 0) errors.push("Add at least one agent step");
  if (graph.nodes.length > MAX_WORKFLOW_NODES) errors.push(`At most ${MAX_WORKFLOW_NODES} steps`);
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id || !n.agentId) errors.push("Every step needs an agent");
    if (ids.has(n.id)) errors.push(`Duplicate step id ${n.id}`);
    ids.add(n.id);
    if (n.parentId === n.id) errors.push("A step cannot be its own lead");
    if (opts.members && n.agentId && !opts.members.includes(n.agentId)) {
      errors.push(`@${n.agentId} is not a member of this group`);
    }
  }
  for (const e of graph.edges) {
    if (e.sourceId === e.targetId) errors.push("A step cannot link to itself");
  }
  if (errors.length === 0) {
    try {
      topologicalLayers(graph);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Would linking `sourceId → targetId` (edge or hierarchy) create a cycle? */
export function wouldCreateCycle(
  graph: Pick<WorkflowGraph, "nodes" | "edges">,
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return true;
  const out = new Map<string, string[]>();
  for (const [a, b] of dependencyPairs(graph)) {
    if (!out.has(a)) out.set(a, []);
    out.get(a)!.push(b);
  }
  // Cycle iff source is already reachable from target.
  const stack = [targetId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === sourceId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of out.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

export function addEdge(graph: WorkflowGraph, sourceId: string, targetId: string): WorkflowGraph {
  if (graph.edges.some((e) => e.sourceId === sourceId && e.targetId === targetId)) return graph;
  if (wouldCreateCycle(graph, sourceId, targetId)) throw new Error("That link would create a loop");
  const edge: WorkflowEdge = { id: newEdgeId(), sourceId, targetId };
  return { ...graph, edges: [...graph.edges, edge] };
}

/** Make `childId` a sub-agent of `leadId` (null detaches it). */
export function setParent(
  graph: WorkflowGraph,
  childId: string,
  leadId: string | null,
): WorkflowGraph {
  if (leadId) {
    const without = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === childId ? { ...n, parentId: null } : n)),
    };
    if (wouldCreateCycle(without, leadId, childId))
      throw new Error("That would make a step lead itself");
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === childId ? { ...n, parentId: leadId } : n)),
    // A hierarchy link replaces a plain edge between the same pair.
    edges: leadId
      ? graph.edges.filter((e) => !(e.sourceId === leadId && e.targetId === childId))
      : graph.edges,
  };
}

export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  const removed = graph.nodes.find((n) => n.id === nodeId);
  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => n.id !== nodeId)
      // Sub-agents of a removed lead move up to the removed node's own lead.
      .map((n) => (n.parentId === nodeId ? { ...n, parentId: removed?.parentId ?? null } : n)),
    edges: graph.edges.filter((e) => e.sourceId !== nodeId && e.targetId !== nodeId),
  };
}

export function removeEdge(graph: WorkflowGraph, edgeId: string): WorkflowGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/** Left→right layered layout (layer = column), used by the "Tidy" button. */
export function autoLayout(
  graph: WorkflowGraph,
  opts: { colWidth?: number; rowHeight?: number; x0?: number; y0?: number } = {},
): WorkflowGraph {
  const colWidth = opts.colWidth ?? 230;
  const rowHeight = opts.rowHeight ?? 110;
  const x0 = opts.x0 ?? 24;
  const y0 = opts.y0 ?? 24;
  let layers: WorkflowNode[][];
  try {
    layers = topologicalLayers(graph);
  } catch {
    return graph;
  }
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, col) =>
    layer.forEach((n, row) => pos.set(n.id, { x: x0 + col * colWidth, y: y0 + row * rowHeight })),
  );
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, ...pos.get(n.id) })) };
}

/** Sanitize an untrusted graph (from the UI / RPC) into a storable one. */
export function normalizeWorkflow(raw: unknown): WorkflowGraph {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
  const nodes: WorkflowNode[] = (Array.isArray(r.nodes) ? r.nodes : [])
    .slice(0, MAX_WORKFLOW_NODES)
    .map((n) => (n && typeof n === "object" ? (n as Record<string, unknown>) : {}))
    .map((n) => ({
      id: str(n.id, 64) || newNodeId(),
      agentId: str(n.agentId, 64),
      label: str(n.label, 80) || undefined,
      prompt: str(n.prompt, 8000) || undefined,
      x: num(n.x),
      y: num(n.y),
      parentId: str(n.parentId, 64) || null,
    }));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parentId && !ids.has(n.parentId)) n.parentId = null;
  const edges: WorkflowEdge[] = (Array.isArray(r.edges) ? r.edges : [])
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
    .map((e) => ({
      id: str(e.id, 64) || newEdgeId(),
      sourceId: str(e.sourceId, 64),
      targetId: str(e.targetId, 64),
    }))
    .filter((e) => ids.has(e.sourceId) && ids.has(e.targetId) && e.sourceId !== e.targetId);
  return {
    id: str(r.id, 64) || newWorkflowId(),
    name: str(r.name, 120).trim() || "Untitled workflow",
    nodes,
    edges,
    updatedAt: Date.now(),
  };
}
