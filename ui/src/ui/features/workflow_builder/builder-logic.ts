/**
 * Canvas logic for the conversation workflow builder (DOM-free).
 * Graph mutations come from the shared workflow-graph module so the builder
 * and the gateway executor agree on what a valid workflow is.
 */
import type { WorkflowGraph, WorkflowNode, WorkflowRunRecord } from "../../../../../src/shared/group-chat/types.js";
import {
  addEdge,
  dependencyPairs,
  newNodeId,
  newWorkflowId,
  setParent,
} from "../../../../../src/shared/group-chat/workflow-graph.js";

export const NODE_W = 180;
export const NODE_H = 72;

export function emptyWorkflow(name = "New workflow"): WorkflowGraph {
  return { id: newWorkflowId(), name, nodes: [], edges: [] };
}

/** Topmost node under a canvas point (later nodes paint on top). */
export function nodeAt(graph: WorkflowGraph, x: number, y: number, exceptId?: string): WorkflowNode | null {
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const n = graph.nodes[i];
    if (n.id === exceptId) continue;
    if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n;
  }
  return null;
}

/**
 * Drop an agent from the palette. Dropped on a node → becomes its sub-agent
 * (placed under it); dropped on empty canvas → a new top-level step there.
 */
export function dropAgent(
  graph: WorkflowGraph,
  agentId: string,
  point: { x: number; y: number },
  label?: string,
): { graph: WorkflowGraph; nodeId: string } {
  const target = nodeAt(graph, point.x, point.y);
  const id = newNodeId();
  if (target) {
    const siblings = graph.nodes.filter((n) => n.parentId === target.id).length;
    const node: WorkflowNode = {
      id,
      agentId,
      label,
      x: target.x + 40 + siblings * 24,
      y: target.y + NODE_H + 48 + siblings * 24,
      parentId: target.id,
    };
    return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId: id };
  }
  const node: WorkflowNode = {
    id,
    agentId,
    label,
    x: Math.max(0, Math.round(point.x - NODE_W / 2)),
    y: Math.max(0, Math.round(point.y - NODE_H / 2)),
    parentId: null,
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId: id };
}

/**
 * Tap-to-add (touch / keyboard): with a node selected the agent becomes its
 * sub-agent, otherwise it's chained after the last step.
 */
export function quickAddAgent(
  graph: WorkflowGraph,
  agentId: string,
  selectedId: string | null,
): { graph: WorkflowGraph; nodeId: string } {
  const sel = selectedId ? graph.nodes.find((n) => n.id === selectedId) : null;
  if (sel) return dropAgent(graph, agentId, { x: sel.x + 1, y: sel.y + 1 });
  const last = graph.nodes[graph.nodes.length - 1];
  const point = last ? { x: last.x + NODE_W + 70 + NODE_W / 2, y: last.y + NODE_H / 2 } : { x: 24 + NODE_W / 2, y: 24 + NODE_H / 2 };
  const res = dropAgent(graph, agentId, point);
  if (!last) return res;
  try {
    return { graph: addEdge(res.graph, last.id, res.nodeId), nodeId: res.nodeId };
  } catch {
    return res;
  }
}

/**
 * Finish dragging a node: released over another node → it becomes that
 * node's sub-agent (hierarchy); over empty canvas → just moved.
 */
export function releaseNode(
  graph: WorkflowGraph,
  nodeId: string,
  pos: { x: number; y: number },
  pointer: { x: number; y: number },
): { graph: WorkflowGraph; reparentedTo: string | null; error?: string } {
  const moved: WorkflowGraph = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) } : n)),
  };
  const over = nodeAt(moved, pointer.x, pointer.y, nodeId);
  if (!over) return { graph: moved, reparentedTo: null };
  const current = moved.nodes.find((n) => n.id === nodeId);
  if (current?.parentId === over.id) return { graph: moved, reparentedTo: null };
  try {
    const re = setParent(moved, nodeId, over.id);
    // Tuck the sub-agent under its new lead.
    const siblings = re.nodes.filter((n) => n.parentId === over.id && n.id !== nodeId).length;
    return {
      graph: {
        ...re,
        nodes: re.nodes.map((n) =>
          n.id === nodeId ? { ...n, x: over.x + 40 + siblings * 24, y: over.y + NODE_H + 48 + siblings * 24 } : n,
        ),
      },
      reparentedTo: over.id,
    };
  } catch (err) {
    return { graph: moved, reparentedTo: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Connect two nodes with a sequence edge (drag from the output handle). */
export function connect(graph: WorkflowGraph, sourceId: string, targetId: string): { graph: WorkflowGraph; error?: string } {
  if (sourceId === targetId) return { graph };
  try {
    return { graph: addEdge(graph, sourceId, targetId) };
  } catch (err) {
    return { graph, error: err instanceof Error ? err.message : String(err) };
  }
}

export type Link = {
  id: string;
  sourceId: string;
  targetId: string;
  kind: "edge" | "hierarchy";
  path: string;
};

/** Every drawable link: sequence edges (right → left, curved) and hierarchy links (bottom → top, dashed). */
export function links(graph: WorkflowGraph): Link[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Link[] = [];
  for (const n of graph.nodes) {
    const p = n.parentId ? byId.get(n.parentId) : null;
    if (!p) continue;
    const x1 = p.x + NODE_W / 2;
    const y1 = p.y + NODE_H;
    const x2 = n.x + NODE_W / 2;
    const y2 = n.y;
    const my = (y1 + y2) / 2;
    out.push({ id: `h-${n.id}`, sourceId: p.id, targetId: n.id, kind: "hierarchy", path: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}` });
  }
  for (const e of graph.edges) {
    const a = byId.get(e.sourceId);
    const b = byId.get(e.targetId);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    out.push({ id: e.id, sourceId: a.id, targetId: b.id, kind: "edge", path: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` });
  }
  return out;
}

/** Canvas size that fits every node plus a margin. */
export function canvasSize(graph: WorkflowGraph, min = { w: 640, h: 360 }): { w: number; h: number } {
  let w = min.w;
  let h = min.h;
  for (const n of graph.nodes) {
    w = Math.max(w, n.x + NODE_W + 80);
    h = Math.max(h, n.y + NODE_H + 80);
  }
  return { w, h };
}

/** Status of each node in the latest run of this workflow. */
export function nodeStatuses(
  graph: WorkflowGraph,
  runs: WorkflowRunRecord[],
): { run: WorkflowRunRecord | null; byNode: Map<string, string> } {
  const run = [...runs].reverse().find((r) => r.workflowId === graph.id) ?? null;
  const byNode = new Map<string, string>();
  if (run) for (const s of run.steps) byNode.set(s.nodeId, s.status);
  return { run, byNode };
}

/** Human summary of the execution order, e.g. "Plan → (Backend ∥ Tests) → Ship". */
export function describeOrder(graph: WorkflowGraph, nameOf: (n: WorkflowNode) => string): string {
  if (graph.nodes.length === 0) return "";
  // Inline Kahn so a mid-edit cycle degrades to "" instead of throwing.
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const [a, b] of dependencyPairs(graph)) {
    if (!indeg.has(a) || !indeg.has(b)) continue;
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
    out.get(a)!.push(b);
  }
  let ready = graph.nodes.filter((n) => indeg.get(n.id) === 0);
  const parts: string[] = [];
  let seen = 0;
  while (ready.length) {
    parts.push(ready.length > 1 ? `(${ready.map(nameOf).join(" ∥ ")})` : nameOf(ready[0]));
    const next: WorkflowNode[] = [];
    for (const n of ready) {
      seen++;
      for (const t of out.get(n.id) ?? []) {
        indeg.set(t, (indeg.get(t) ?? 0) - 1);
        if (indeg.get(t) === 0) next.push(graph.nodes.find((x) => x.id === t)!);
      }
    }
    ready = next;
  }
  return seen === graph.nodes.length ? parts.join(" → ") : "";
}

/** A ready-made starter: lead plans, two members work in parallel, lead wraps up. */
export function starterWorkflow(memberIds: string[]): WorkflowGraph {
  const g = emptyWorkflow("Plan → build → review");
  const [a, b, c] = [memberIds[0], memberIds[1] ?? memberIds[0], memberIds[2] ?? memberIds[0]];
  const lead: WorkflowNode = { id: newNodeId(), agentId: a, label: "Plan", prompt: "Break the request into a short plan and hand clear instructions to the next step.", x: 24, y: 40, parentId: null };
  const build: WorkflowNode = { id: newNodeId(), agentId: b, label: "Build", prompt: "Carry out the plan and report exactly what you produced.", x: 24 + NODE_W + 70, y: 40, parentId: null };
  const review: WorkflowNode = { id: newNodeId(), agentId: c, label: "Review", prompt: "Review the result, list issues and give a final verdict.", x: 24 + 2 * (NODE_W + 70), y: 40, parentId: null };
  let graph: WorkflowGraph = { ...g, nodes: [lead, build, review] };
  graph = addEdge(graph, lead.id, build.id);
  graph = addEdge(graph, build.id, review.id);
  return graph;
}
