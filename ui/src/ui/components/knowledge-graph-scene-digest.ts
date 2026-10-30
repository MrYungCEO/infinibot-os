/**
 * Compact, deterministic digest of a knowledge-graph scene — what the stage
 * would be handed (nodes, layout targets, links, groups, rings, labels,
 * emphasis, signals). The web suite pins it to a golden file and the mobile
 * suite checks the native bundle produces the same digest from the same
 * snapshot (web ↔ native parity).
 */

import { GROUP_MODES, type GroupMode } from "./knowledge-graph-ops";
import { DEFAULT_HEALTH, DEFAULT_KINDS, type GraphNodeKind, type ProjectHealth } from "./knowledge-graph-model";
import {
  buildScene,
  emphasisOf,
  highlightSetOf,
  labelRuleFor,
  neighbourhoodOf,
  sceneInsights,
  stageGroupsOf,
  stageLayoutV3Of,
  stageLinksOf,
  stageRingsOf,
  type GraphEdgeIn,
  type GraphNodeIn,
  type Scene,
} from "./knowledge-graph-scene";

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const round = (v: number, p = 1000) => Math.round(v * p) / p;

function hashOf(v: unknown): string {
  return fnv(
    JSON.stringify(v, (_k, x) => {
      if (typeof x === "number") return round(x);
      if (ArrayBuffer.isView(x)) return Array.from(x as unknown as ArrayLike<number>, (n) => round(n));
      if (x instanceof Set) return [...x];
      if (x instanceof Map) return [...x.entries()];
      return x;
    }),
  );
}

export interface DigestInput {
  nodes: GraphNodeIn[];
  edges: GraphEdgeIn[];
  insights?: Array<{ id: string; kind: string; severity: "high" | "medium" | "info"; title: string; detail?: string; nodeIds: string[] }>;
}

/** Digest of one grouping mode. */
export function digestScene(scene: Scene, insightsIn: DigestInput["insights"]): Record<string, unknown> {
  const { nodes, v3 } = scene;
  // The biggest hub is the focus for the label / emphasis samples.
  let hub = nodes[0];
  for (const n of nodes) if (n.r > (hub?.r ?? 0)) hub = n;
  const focusId = hub?.id ?? null;
  const nbh = neighbourhoodOf(scene.adjacency, focusId);
  const selection = new Set(nodes.slice(0, 3).map((n) => n.id));
  const insights = sceneInsights(scene, insightsIn, 1_760_000_000_000, new Set());
  const highlightSet = highlightSetOf(insights[0] ?? null, scene.nodeById, scene.adjacency);
  const focus = { selection: new Set<string>(), selectedId: focusId, hoveredId: null, adjacency: scene.adjacency, highlightSet: null, activeInsight: null };
  const multi = { ...focus, selection, selectedId: null };
  const labels = (k: number, fid: string | null, hl: Set<string> | null) =>
    nodes.map((n) => labelRuleFor(n, k, { focusId: fid, nbh: fid ? nbh : null, highlightSet: hl, minorOk: k > 1.15, degree: scene.degree, stage3d: true }));
  return {
    count: nodes.length,
    links: scene.links.length,
    sig: scene.sig,
    ids: hashOf(nodes.map((n) => n.id)),
    radii: hashOf(nodes.map((n) => n.r)),
    colors: hashOf(nodes.map((n) => n.color)),
    shapes: hashOf(nodes.map((n) => n.shape)),
    depth: hashOf(nodes.map((n) => [n.depth, n.mainParent, n.anchor, n.health ?? null])),
    groups: hashOf(nodes.map((n) => n.group)),
    target: hashOf(v3.target),
    units: hashOf(v3.units.map((u) => [u.key, u.c, u.r, u.members, u.rep, u.aggregatable, u.type, u.region])),
    regions: v3.regions.map((r) => `${r.key}:${r.members.length}`),
    stageLinks: hashOf(stageLinksOf(scene.links, v3)),
    stageV3: hashOf(stageLayoutV3Of(nodes, v3)),
    stageGroups: hashOf(stageGroupsOf(scene.grouping, scene.nodeById)),
    rings: hashOf(stageRingsOf(nodes, { selection, selectedId: focusId, dropTarget: null })),
    labelsOverview: hashOf(labels(1, null, null)),
    labelsFocus: hashOf(labels(1.6, focusId, null)),
    labelsInsight: hashOf(labels(1, null, highlightSet)),
    emphasisFocus: hashOf(nodes.map((n) => emphasisOf(n, focusId, nbh, focus))),
    emphasisMulti: hashOf(nodes.map((n) => emphasisOf(n, null, null, multi))),
    insights: insights.map((i) => i.id),
    sample: nodes.slice(0, 4).map((n) => ({ id: n.id, r: round(n.r), color: n.color, group: n.group ?? null, t: Array.from(v3.target.slice(n.index! * 3, n.index! * 3 + 3), (x) => round(x, 10)) })),
  };
}

/** Digest of every grouping mode for one snapshot (fixed filters and aspect). */
export function digestAllModes(input: DigestInput, opts: { aspect?: number; kinds?: GraphNodeKind[]; health?: ProjectHealth[]; search?: string } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const kinds = new Set<GraphNodeKind>(opts.kinds ?? [...DEFAULT_KINDS, "task"]);
  const health = new Set<ProjectHealth>(opts.health ?? [...DEFAULT_HEALTH, "done"]);
  for (const m of GROUP_MODES) {
    const scene = buildScene({
      nodes: input.nodes,
      edges: input.edges,
      enabledKinds: kinds,
      enabledHealth: health,
      search: opts.search,
      groupMode: m.id as GroupMode,
      aspect: opts.aspect ?? 0.55,
    });
    out[m.id] = digestScene(scene, input.insights);
  }
  return out;
}
