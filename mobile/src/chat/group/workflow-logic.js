/**
 * workflow-logic — conversation workflow graphs on mobile.
 *
 * Part 1 mirrors src/shared/group-chat/workflow-graph.ts (the gateway executor
 * and the web builder use it) so a workflow saved here is exactly the data the
 * web saves, and vice versa. Parity: src/__tests__/group-chat-parity.test.js.
 *
 * Part 2 is the touch builder's model. The web edits a free canvas (nodes,
 * sequence edges, lead → sub-agent links). A phone edits STAGES: an ordered
 * list where each stage holds one step, or several steps that run in parallel.
 * Stages are just the graph's execution layers, so:
 *   graph → stages   topologicalLayers (exact for any graph, incl. web-made ones)
 *   stages → graph   every step of stage i links to every step of stage i+1
 * Editing a step's agent / label / prompt keeps the graph's own links; only a
 * structural change (add / remove / reorder / parallel) rebuilds them — and
 * the builder says so first when the workflow came with custom web links.
 */

export const MAX_WORKFLOW_NODES = 24;
// Same canvas metrics as ui/src/ui/features/workflow_builder/builder-logic.ts,
// so a mobile-built workflow opens tidy on the web canvas.
export const NODE_W = 180;
export const NODE_H = 72;

function rid(prefix) {
  const r = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${r.replace(/-/g, '').slice(0, 10)}`;
}

export const newNodeId = () => rid('n');
export const newEdgeId = () => rid('e');
export const newWorkflowId = () => rid('wf');

// ── Part 1: workflow-graph.ts mirror ──────────────────────────────────────

/** Every dependency pair (source must finish before target), edges + parent links, deduped. */
export function dependencyPairs(graph) {
  const seen = new Set();
  const out = [];
  const push = (a, b) => {
    const k = `${a}\u0000${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([a, b]);
  };
  for (const n of graph.nodes) if (n.parentId) push(n.parentId, n.id);
  for (const e of graph.edges) push(e.sourceId, e.targetId);
  return out;
}

export function predecessorsOf(graph, nodeId) {
  return dependencyPairs(graph).filter(([, b]) => b === nodeId).map(([a]) => a);
}

/** Stable Kahn layering. Throws on a cycle or a dangling reference. */
export function topologicalLayers(graph) {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const [a, b] of dependencyPairs(graph)) {
    if (!index.has(a) || !index.has(b)) throw new Error(`Link references a missing step (${a} → ${b})`);
    indegree.set(b, (indegree.get(b) ?? 0) + 1);
    out.get(a).push(b);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let ready = graph.nodes.filter((n) => indegree.get(n.id) === 0);
  const layers = [];
  let seen = 0;
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
    layers.push(ready);
    const next = [];
    for (const n of ready) {
      seen += 1;
      for (const t of out.get(n.id) ?? []) {
        indegree.set(t, (indegree.get(t) ?? 0) - 1);
        if (indegree.get(t) === 0) next.push(byId.get(t));
      }
    }
    ready = next;
  }
  if (seen !== graph.nodes.length) throw new Error('Workflow has a cycle — remove a link so steps flow one way');
  return layers;
}

export function validateWorkflow(graph, opts = {}) {
  const errors = [];
  if (!graph.name?.trim()) errors.push('Workflow needs a name');
  if (graph.nodes.length === 0) errors.push('Add at least one agent step');
  if (graph.nodes.length > MAX_WORKFLOW_NODES) errors.push(`At most ${MAX_WORKFLOW_NODES} steps`);
  const ids = new Set();
  for (const n of graph.nodes) {
    if (!n.id || !n.agentId) errors.push('Every step needs an agent');
    if (ids.has(n.id)) errors.push(`Duplicate step id ${n.id}`);
    ids.add(n.id);
    if (n.parentId === n.id) errors.push('A step cannot be its own lead');
    if (opts.members && n.agentId && !opts.members.includes(n.agentId)) {
      errors.push(`@${n.agentId} is not a member of this group`);
    }
  }
  for (const e of graph.edges) {
    if (e.sourceId === e.targetId) errors.push('A step cannot link to itself');
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

/** Would linking `sourceId → targetId` create a cycle? */
export function wouldCreateCycle(graph, sourceId, targetId) {
  if (sourceId === targetId) return true;
  const out = new Map();
  for (const [a, b] of dependencyPairs(graph)) {
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(b);
  }
  const stack = [targetId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === sourceId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of out.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

export function addEdge(graph, sourceId, targetId) {
  if (graph.edges.some((e) => e.sourceId === sourceId && e.targetId === targetId)) return graph;
  if (wouldCreateCycle(graph, sourceId, targetId)) throw new Error('That link would create a loop');
  return { ...graph, edges: [...graph.edges, { id: newEdgeId(), sourceId, targetId }] };
}

export function removeNode(graph, nodeId) {
  const removed = graph.nodes.find((n) => n.id === nodeId);
  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => n.id !== nodeId)
      .map((n) => (n.parentId === nodeId ? { ...n, parentId: removed?.parentId ?? null } : n)),
    edges: graph.edges.filter((e) => e.sourceId !== nodeId && e.targetId !== nodeId),
  };
}

/** Left→right layered layout (layer = column) — the web's "Tidy". */
export function autoLayout(graph, opts = {}) {
  const colWidth = opts.colWidth ?? 230;
  const rowHeight = opts.rowHeight ?? 110;
  const x0 = opts.x0 ?? 24;
  const y0 = opts.y0 ?? 24;
  let layers;
  try {
    layers = topologicalLayers(graph);
  } catch {
    return graph;
  }
  const pos = new Map();
  layers.forEach((layer, col) => layer.forEach((n, row) => pos.set(n.id, { x: x0 + col * colWidth, y: y0 + row * rowHeight })));
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, ...pos.get(n.id) })) };
}

export function emptyWorkflow(name = 'New workflow') {
  return { id: newWorkflowId(), name, nodes: [], edges: [] };
}

/** The web's "Start from a template": lead plans, a member builds, another reviews. */
export function starterWorkflow(memberIds) {
  const g = emptyWorkflow('Plan → build → review');
  const [a, b, c] = [memberIds[0], memberIds[1] ?? memberIds[0], memberIds[2] ?? memberIds[0]];
  const lead = { id: newNodeId(), agentId: a, label: 'Plan', prompt: 'Break the request into a short plan and hand clear instructions to the next step.', x: 24, y: 40, parentId: null };
  const build = { id: newNodeId(), agentId: b, label: 'Build', prompt: 'Carry out the plan and report exactly what you produced.', x: 24 + NODE_W + 70, y: 40, parentId: null };
  const review = { id: newNodeId(), agentId: c, label: 'Review', prompt: 'Review the result, list issues and give a final verdict.', x: 24 + 2 * (NODE_W + 70), y: 40, parentId: null };
  let graph = { ...g, nodes: [lead, build, review] };
  graph = addEdge(graph, lead.id, build.id);
  graph = addEdge(graph, build.id, review.id);
  return graph;
}

/** Human summary of the execution order, e.g. "Plan → (Backend ∥ Tests) → Ship". */
export function describeOrder(graph, nameOf) {
  if (graph.nodes.length === 0) return '';
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const [a, b] of dependencyPairs(graph)) {
    if (!indeg.has(a) || !indeg.has(b)) continue;
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
    out.get(a).push(b);
  }
  let ready = graph.nodes.filter((n) => indeg.get(n.id) === 0);
  const parts = [];
  let seen = 0;
  while (ready.length) {
    parts.push(ready.length > 1 ? `(${ready.map(nameOf).join(' ∥ ')})` : nameOf(ready[0]));
    const next = [];
    for (const n of ready) {
      seen++;
      for (const t of out.get(n.id) ?? []) {
        indeg.set(t, (indeg.get(t) ?? 0) - 1);
        if (indeg.get(t) === 0) next.push(graph.nodes.find((x) => x.id === t));
      }
    }
    ready = next;
  }
  return seen === graph.nodes.length ? parts.join(' → ') : '';
}

/** Status of each node in the latest run of this workflow. */
export function nodeStatuses(graph, runs) {
  const run = [...(runs || [])].reverse().find((r) => r.workflowId === graph.id) ?? null;
  const byNode = {};
  if (run) for (const s of run.steps) byNode[s.nodeId] = s.status;
  return { run, byNode };
}

// ── Part 2: the stage builder ─────────────────────────────────────────────

/** Graph → ordered stages (`[[node, …], …]`). A broken graph degrades to one step per stage. */
export function graphToStages(graph) {
  try {
    return topologicalLayers(graph).map((layer) => [...layer]);
  } catch {
    return graph.nodes.map((n) => [n]);
  }
}

/** The links `stagesToGraph` would draw — every step of a stage → every step of the next. */
function stageEdges(stages, existing = []) {
  const reuse = new Map(existing.map((e) => [`${e.sourceId}\u0000${e.targetId}`, e.id]));
  const edges = [];
  for (let i = 0; i + 1 < stages.length; i++) {
    for (const a of stages[i]) {
      for (const b of stages[i + 1]) {
        edges.push({ id: reuse.get(`${a.id}\u0000${b.id}`) ?? newEdgeId(), sourceId: a.id, targetId: b.id });
      }
    }
  }
  return edges;
}

/**
 * True when the graph is exactly what the stage builder would draw (no lead →
 * sub-agent links, no skip-a-stage links). Then structural edits lose nothing.
 */
export function isStageShaped(graph) {
  if (graph.nodes.some((n) => n.parentId)) return false;
  let layers;
  try {
    layers = topologicalLayers(graph);
  } catch {
    return false;
  }
  const want = new Set(stageEdges(layers).map((e) => `${e.sourceId}\u0000${e.targetId}`));
  const have = new Set(graph.edges.map((e) => `${e.sourceId}\u0000${e.targetId}`));
  if (want.size !== have.size) return false;
  for (const k of want) if (!have.has(k)) return false;
  return true;
}

/** Stages → a saveable graph: sequence links between stages, tidy canvas positions. */
export function stagesToGraph(base, stages) {
  const clean = stages.filter((s) => s.length > 0);
  const nodes = clean.flat().map((n) => ({ ...n, parentId: null }));
  const graph = { ...base, nodes, edges: stageEdges(clean, base.edges) };
  return autoLayout(graph);
}

function locate(stages, nodeId) {
  for (let i = 0; i < stages.length; i++) {
    const j = stages[i].findIndex((n) => n.id === nodeId);
    if (j >= 0) return { stage: i, index: j };
  }
  return null;
}

/**
 * Add a step for `agentId`. `parallelWith` = a stage index → join that stage
 * (runs alongside it); otherwise a new stage at the end.
 */
export function addStep(stages, agentId, { parallelWith = null, label, prompt } = {}) {
  const node = { id: newNodeId(), agentId, label: label || undefined, prompt: prompt || undefined, x: 0, y: 0, parentId: null };
  const next = stages.map((s) => [...s]);
  if (parallelWith != null && next[parallelWith]) next[parallelWith].push(node);
  else next.push([node]);
  return { stages: next, nodeId: node.id };
}

export function removeStep(stages, nodeId) {
  return stages.map((s) => s.filter((n) => n.id !== nodeId)).filter((s) => s.length > 0);
}

export function updateStep(stages, nodeId, patch) {
  return stages.map((s) => s.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)));
}

/** Move a whole stage (drag reorder). */
export function moveStage(stages, from, to) {
  if (from === to || from < 0 || from >= stages.length) return stages;
  const next = [...stages];
  const [s] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, s);
  return next;
}

/**
 * Parallel ⇄ sequential for one step:
 *   in a shared stage → split out into its own stage right after it
 *   alone in a stage  → join the previous stage (run alongside it)
 */
export function toggleParallel(stages, nodeId) {
  const at = locate(stages, nodeId);
  if (!at) return stages;
  const next = stages.map((s) => [...s]);
  const [node] = next[at.stage].splice(at.index, 1);
  if (next[at.stage].length > 0) {
    next.splice(at.stage + 1, 0, [node]);
    return next;
  }
  if (at.stage === 0) {
    next[0].push(node); // first and alone — nothing before it to join
    return next;
  }
  next[at.stage - 1].push(node);
  return next.filter((s) => s.length > 0);
}

/**
 * Where a dragged stage lands: `from` index, finger travel `dy`, and the
 * measured height of each stage row. Crossing half of a neighbour swaps.
 */
export function dragTargetIndex(from, dy, heights) {
  let to = from;
  let travel = dy;
  if (dy > 0) {
    while (to + 1 < heights.length && travel > (heights[to + 1] || 0) / 2) {
      travel -= heights[to + 1] || 0;
      to += 1;
    }
  } else {
    while (to - 1 >= 0 && -travel > (heights[to - 1] || 0) / 2) {
      travel += heights[to - 1] || 0;
      to -= 1;
    }
  }
  return to;
}

/** Run filter chips: newest first, each run's id + label + live progress. */
export function runOptions(runs) {
  return [...(runs || [])].reverse().map((r) => ({
    id: r.id,
    workflowId: r.workflowId,
    name: r.workflowName,
    status: r.status,
    done: r.steps.filter((s) => s.status === 'done').length,
    total: r.steps.length,
    startedAt: r.startedAt,
  }));
}
