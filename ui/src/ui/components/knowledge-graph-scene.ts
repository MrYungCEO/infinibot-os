/**
 * Knowledge Graph — the pure "snapshot → scene" pipeline.
 *
 * Everything between the gateway snapshot and the 3D stage that does not
 * touch the DOM: filters + search, node sizing / colour / hierarchy, the v3
 * layout (brain lobes, families, pockets), grouping, and the inputs the stage
 * takes (links, v3 layout info, group halos, status rings), plus the label and
 * emphasis rules the stage asks for every frame.
 *
 * Shared by the web graph (`<infinibot-knowledge-graph>`) and the native
 * mobile graph (mobile/src/kg — bundled by ui/scripts/build-kg-native.mjs),
 * so both draw the SAME scene from the same data. Keep it free of DOM, Lit
 * and three.js.
 */

import { layoutV3, statusMix, type V3Layout } from "./knowledge-graph-layout-v3";
import {
  clusterSubProjects,
  subProjectsOf,
} from "./knowledge-graph-consolidate";
import {
  computeGrouping,
  detectInsights,
  type GraphInsightIn,
  type GroupMode,
  type Grouping,
  type HudInsight,
} from "./knowledge-graph-ops";
import {
  ANCHOR_KINDS,
  colorFor,
  computeOrbits,
  enforceParentSize,
  healthOf,
  hierarchyRadius,
  labelScaleFor,
  nodeRadius,
  orbitFor,
  shapeFor,
  type GraphNodeKind,
  type Orbits,
  type ProjectHealth,
} from "./knowledge-graph-model";

// ── Snapshot shapes (graph.global.snapshot) ───────────────────────────────

export interface GraphNodeIn {
  id: string;
  kind: GraphNodeKind;
  label: string;
  weight?: number;
  meta?: Record<string, unknown>;
}

export interface GraphEdgeIn {
  source: string;
  target: string;
  rel: string;
  weight?: number;
  inferred?: boolean;
}

export interface GraphInsight {
  id: string;
  kind: string;
  severity: "high" | "medium" | "info";
  title: string;
  detail?: string;
  nodeIds: string[];
}

export interface GraphSnapshot {
  generatedAt: number;
  nodes: GraphNodeIn[];
  edges: GraphEdgeIn[];
  typeStats: Partial<Record<GraphNodeKind, number>>;
  insights?: GraphInsight[];
  hidden?: Partial<Record<GraphNodeKind, number>>;
  kinds?: GraphNodeKind[];
}

/** A laid-out node (the web host extends it with d3 simulation fields). */
export interface SceneNode extends GraphNodeIn {
  index?: number;
  x?: number;
  y?: number;
  r: number;
  color: string;
  anchor: boolean;
  health?: ProjectHealth;
  orbit?: number;
  /** Height (world Y in the 3D stage). */
  z?: number;
  /** Visual group key under the current grouping mode. */
  group?: string;
  /** Project nesting depth (0 = top level). */
  depth?: number;
  /** Main parent project (top level with sub-projects): label always shown. */
  mainParent?: boolean;
  /** 3D silhouette (KIND_SHAPE). */
  shape?: number;
}

export interface SceneLink<N extends SceneNode = SceneNode> {
  source: N;
  target: N;
  rel: string;
  weight: number;
  inferred: boolean;
}

export type Relation = { other: string; rel: string; out: boolean };

/** Layout-worker link (index space) — the web host's d3 springs. */
export interface WorkerLink {
  source: number;
  target: number;
  weight: number;
  distance: number;
  strength: number;
}

export interface SceneInput {
  nodes: GraphNodeIn[];
  edges: GraphEdgeIn[];
  /** Lazily expanded per-project task layers. */
  expanded?: Iterable<{ nodes: GraphNodeIn[]; edges: GraphEdgeIn[] }>;
  /** Optimistic edges (just linked) until a snapshot confirms them. */
  localEdges?: GraphEdgeIn[];
  enabledKinds: ReadonlySet<GraphNodeKind>;
  enabledHealth: ReadonlySet<ProjectHealth>;
  search?: string;
  /** Projects converted/merged by "Consolidate sub-projects" (store ids). */
  consolidatedIds?: ReadonlySet<string>;
  showConsolidated?: boolean;
  groupMode: GroupMode;
  /** Canvas aspect seen by the map camera (see `layoutAspectFor`). */
  aspect: number;
}

export interface Scene<N extends SceneNode = SceneNode> {
  nodes: N[];
  links: SceneLink<N>[];
  workerLinks: WorkerLink[];
  nodeById: Map<string, N>;
  adjacency: Map<string, Set<string>>;
  relations: Map<string, Relation[]>;
  degree: number[];
  /** Sub-project index → parent project index. */
  projectParent: Map<number, number>;
  orbits: Orbits;
  v3: V3Layout;
  grouping: Grouping;
  /** Ids matching the search (null when no search). */
  searchMatchIds: Set<string> | null;
  /** Topology signature: an unchanged poll is a no-op for the layout. */
  sig: string;
}

export const MAX_LABEL_CHARS = 34;

export function truncate(s: string, n = MAX_LABEL_CHARS): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Darken a #rrggbb colour toward black by `k` (0..1 = fraction kept). */
export function dimColor(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const ch = (sh: number) => Math.round(((v >> sh) & 255) * k).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** Canvas aspect seen by the map camera (steep view ≈ 0.84 foreshortening). */
export function layoutAspectFor(w: number, h: number): number {
  if (!w || !h) return 1.7;
  return Math.max(0.7, Math.min(2.8, w / h / 0.84));
}

/** Project with an agent working on it, or an active run (breathes / pulses). */
export function isLiveNode(n: { kind: GraphNodeKind; meta?: Record<string, unknown> }): boolean {
  return (n.kind === "project" && n.meta?.live === true) || (n.kind === "run" && n.meta?.active === true);
}

/**
 * Snapshot → scene: filters, search, sizing, hierarchy, v3 layout, grouping.
 * `make` lets the web host build its d3 node objects in the same pass.
 */
export function buildScene<N extends SceneNode = SceneNode>(input: SceneInput, make?: (base: SceneNode) => N): Scene<N> {
  const srcNodes: GraphNodeIn[] = [...input.nodes];
  const srcEdges: GraphEdgeIn[] = [...input.edges];
  const expandedTaskIds = new Set<string>();
  const seen = new Set(srcNodes.map((n) => n.id));
  for (const layer of input.expanded ?? []) {
    for (const n of layer.nodes) {
      expandedTaskIds.add(n.id);
      if (!seen.has(n.id)) {
        seen.add(n.id);
        srcNodes.push(n);
      }
    }
    srcEdges.push(...layer.edges);
  }
  if (input.localEdges?.length) srcEdges.push(...input.localEdges);

  const q = (input.search ?? "").trim().toLowerCase();
  const allowed = input.enabledKinds;
  const consolidated = input.consolidatedIds;
  const passes = (n: GraphNodeIn): boolean => {
    if (!allowed.has(n.kind) && !expandedTaskIds.has(n.id)) return false;
    if (n.kind === "project" && !input.enabledHealth.has(healthOf(n.meta))) return false;
    // Sub-projects already consolidated into tasks/another project stay out of the map.
    if (n.kind === "project" && !input.showConsolidated && consolidated?.size) {
      const pid = typeof n.meta?.projectId === "string" ? n.meta.projectId : n.id.slice(8);
      if (consolidated.has(pid)) return false;
    }
    return true;
  };
  let candidates = srcNodes.filter(passes);
  let searchMatchIds: Set<string> | null = null;
  if (q) {
    // Search keeps matches plus their direct neighbours for context.
    const match = new Set(
      candidates.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id),
    );
    const keep = new Set(match);
    for (const e of srcEdges) {
      if (match.has(e.source)) keep.add(e.target);
      if (match.has(e.target)) keep.add(e.source);
    }
    candidates = candidates.filter((n) => keep.has(n.id));
    searchMatchIds = match;
  }

  const nodeIndex = new Map<string, N>();
  const nodes: N[] = [];
  let sig = 0x811c9dc5;
  const feed = (s: string): void => {
    for (let c = 0; c < s.length; c++) {
      sig ^= s.charCodeAt(c);
      sig = Math.imul(sig, 0x01000193);
    }
  };

  const healthCounts = { open: 0, backlog: 0, done: 0 };
  for (const n of candidates) {
    if (n.kind !== "project") continue;
    const hh = healthOf(n.meta);
    if (hh === "done") healthCounts.done++;
    else if (hh === "backlog") healthCounts.backlog++;
    else healthCounts.open++;
  }
  const orbits = computeOrbits(healthCounts);

  for (const n of candidates) {
    const i = nodes.length;
    const health = n.kind === "project" ? healthOf(n.meta) : undefined;
    const base: SceneNode = {
      ...n,
      index: i,
      r: hierarchyRadius(n.kind, 0, n.weight),
      shape: shapeFor(n.kind),
      color: colorFor(n.kind, n.meta),
      anchor: ANCHOR_KINDS.has(n.kind),
      health,
      orbit: health ? orbitFor(health, orbits) : undefined,
    };
    const sim = (make ? make(base) : base) as N;
    nodeIndex.set(n.id, sim);
    nodes.push(sim);
    feed(n.id);
  }

  const links: SceneLink<N>[] = [];
  const workerLinks: WorkerLink[] = [];
  const degree: number[] = Array.from({ length: nodes.length }, () => 0);
  const relations = new Map<string, Relation[]>();
  const adjacency = new Map<string, Set<string>>();
  for (const e of srcEdges) {
    const a = nodeIndex.get(e.source);
    const b = nodeIndex.get(e.target);
    if (!a || !b || a === b) continue;
    const weight = e.weight ?? 1;
    const inferred = e.inferred === true;
    links.push({ source: a, target: b, rel: e.rel, weight, inferred });
    const kinds = [a.kind, b.kind];
    const isTask = kinds.includes("task");
    const isClientProject = kinds.includes("client") && kinds.includes("project");
    workerLinks.push({
      source: a.index!,
      target: b.index!,
      weight,
      distance: isTask ? 26 : isClientProject ? 70 : e.rel === "sub-project of" ? 60 : 48,
      strength: inferred ? 0.1 : isTask ? 0.6 : 0.3,
    });
    degree[a.index!] += 1;
    degree[b.index!] += 1;
    (adjacency.get(a.id) ?? adjacency.set(a.id, new Set()).get(a.id)!).add(b.id);
    (adjacency.get(b.id) ?? adjacency.set(b.id, new Set()).get(b.id)!).add(a.id);
    (relations.get(a.id) ?? relations.set(a.id, []).get(a.id)!).push({ other: b.id, rel: e.rel, out: true });
    (relations.get(b.id) ?? relations.set(b.id, []).get(b.id)!).push({ other: a.id, rel: e.rel, out: false });
    sig = (sig ^ Math.imul(a.index! + 1, 73856093) ^ Math.imul(b.index! + 1, 19349663)) >>> 0;
  }
  // Hierarchy: sub-project depth from "sub-project of" (child → parent)
  // edges. Size and brightness follow depth, so a busy sub-project never
  // outgrows its parent.
  const projectParent = new Map<number, number>();
  for (const l of links) {
    if (l.rel === "sub-project of" && l.source.kind === "project" && l.target.kind === "project") projectParent.set(l.source.index!, l.target.index!);
  }
  const hasSub = new Set(projectParent.values());
  for (const n of nodes) {
    let depth = 0;
    let cur = n.index!;
    const seenP = new Set<number>([cur]);
    while (projectParent.has(cur) && depth < 8) {
      cur = projectParent.get(cur)!;
      if (seenP.has(cur)) break;
      seenP.add(cur);
      depth++;
    }
    n.depth = depth;
    n.mainParent = n.kind === "project" && depth === 0 && hasSub.has(n.index!);
    if (n.kind === "project" && depth > 0) n.color = dimColor(n.color, 0.62);
  }
  // Size by connections: max(hierarchy floor, base × f(degree) × hub), then
  // every parent lifted above its children (see knowledge-graph-model).
  const projNb = new Map<number, number>();
  for (const l of links) {
    if (l.source.kind === "project" && l.target.kind === "project") {
      projNb.set(l.source.index!, (projNb.get(l.source.index!) ?? 0) + 1);
      projNb.set(l.target.index!, (projNb.get(l.target.index!) ?? 0) + 1);
    }
  }
  const radii = nodes.map((n) =>
    nodeRadius({
      kind: n.kind,
      depth: n.depth ?? 0,
      weight: n.weight,
      degree: degree[n.index!] ?? 0,
      hub: n.kind === "project" && (hasSub.has(n.index!) || Number(n.meta?.tasks ?? 0) > 0 || (projNb.get(n.index!) ?? 0) >= 2),
    }),
  );
  const parentIdx = nodes.map((n) => projectParent.get(n.index!) ?? -1);
  enforceParentSize(radii, parentIdx, nodes.map((n) => n.depth ?? 0));
  for (const n of nodes) n.r = radii[n.index!];
  // Unconnected minor nodes drift to an outer "stray" orbit.
  for (const n of nodes) {
    if (n.orbit == null && degree[n.index!] === 0 && !n.anchor) n.orbit = orbits.stray;
  }
  const opEdges = links.map((l) => ({ source: l.source.id, target: l.target.id, rel: l.rel, inferred: l.inferred }));
  // v3 readable layout: regions → units (families / unlinked pockets) → nodes.
  const mode = input.groupMode;
  const base = computeGrouping(nodes, opEdges, mode === "brain" ? "orbit" : mode);
  const nbIdx: number[][] = nodes.map((n) =>
    [...(adjacency.get(n.id) ?? [])].map((id) => nodeIndex.get(id)?.index).filter((i): i is number => i != null),
  );
  const v3 = layoutV3(
    nodes.map((n) => ({ id: n.id, kind: n.kind, anchor: n.anchor, r: n.r, label: n.label, meta: n.meta, parent: projectParent.get(n.index!) })),
    nbIdx,
    { mode, groupOf: nodes.map((n) => base.groupOf.get(n.id)), groups: base.groups, aspect: input.aspect },
  );
  const grouping: Grouping = {
    mode,
    groups: v3.regions
      .filter((r) => r.members.length)
      .map((r) => ({ key: r.key, label: r.label, color: r.color, memberIds: r.members.map((i) => nodes[i].id) }))
      .sort((a, b) => b.memberIds.length - a.memberIds.length),
    groupOf: new Map(nodes.map((n, i) => [n.id, v3.regions[v3.regionOf[i]]?.key ?? "unfiled"])),
    v3,
  };
  for (const n of nodes) n.group = grouping.groupOf.get(n.id);
  return {
    nodes,
    links,
    workerLinks,
    nodeById: nodeIndex,
    adjacency,
    relations,
    degree,
    projectParent,
    orbits,
    v3,
    grouping,
    searchMatchIds,
    sig: `${(sig >>> 0).toString(36)}:${nodes.length}:${links.length}:${mode}`,
  };
}

/** Put every node on its v3 target (layout px around `center`; z = world Y). */
export function placeOnTargets(nodes: SceneNode[], v3: V3Layout, center: { cx: number; cy: number }): void {
  const t = v3.target;
  for (const n of nodes) {
    const i = n.index!;
    n.x = center.cx + t[i * 3];
    n.y = center.cy + t[i * 3 + 2];
    n.z = t[i * 3 + 1];
  }
}

// ── Stage inputs ──────────────────────────────────────────────────────────

export interface StageLinkIn {
  s: number;
  t: number;
  heavy: boolean;
  inferred: boolean;
  tree?: boolean;
  cross?: boolean;
  rel?: string;
  weight?: number;
}

export function stageLinksOf(links: SceneLink[], v3: V3Layout | null): StageLinkIn[] {
  return links.map((l) => ({
    s: l.source.index!,
    t: l.target.index!,
    heavy: l.source.anchor && l.target.anchor,
    inferred: l.inferred,
    tree: l.rel === "sub-project of",
    cross: v3 ? v3.unitOf[l.source.index!] !== v3.unitOf[l.target.index!] : false,
    rel: l.rel,
    weight: l.weight,
  }));
}

/** v3 layout info for the stage (null when the layout doesn't match the node list). */
export function stageLayoutV3Of(nodes: SceneNode[], v3: V3Layout | null) {
  if (!v3 || v3.target.length !== nodes.length * 3) return null;
  return {
    mode: v3.mode,
    brainScale: v3.scale,
    unitOf: v3.unitOf,
    regionOf: v3.regionOf,
    units: v3.units.map((u) => ({
      key: u.key,
      c: u.c,
      r: u.r,
      members: u.members,
      rep: u.rep,
      aggregatable: u.aggregatable,
      label: u.label,
      color: u.color,
      type: u.type,
      region: u.region,
      mix: statusMix(nodes, u.members),
    })),
    regions: v3.regions.map((r) => ({ key: r.key, label: r.label, color: r.color, c: r.c, r: r.r, shape: r.shape, lobe: r.lobe, side: r.side, count: r.members.length })),
    bundles: v3.bundles,
  };
}

export interface StageGroupIn {
  key: string;
  label: string;
  color: string;
  members: number[];
  anchor?: number;
  volume?: { c: [number, number, number]; r: [number, number, number] };
  disc?: { c: [number, number, number]; r: number; emphasis?: number };
}

/** Halos / zones for the active grouping (empty for the orbit mode). */
export function stageGroupsOf(g: Grouping | null, nodeById: Map<string, SceneNode>): StageGroupIn[] {
  if (!g || g.mode === "orbit" || !g.groups.length) return [];
  const groups: StageGroupIn[] = [];
  if (g.v3) {
    // v3: fixed zone discs for regions and unlinked pockets (the cortex shell
    // replaces lobe volumes; orbit bands use guide rings). Tags are drawn by
    // the stage at each region's edge.
    const v3 = g.v3;
    if (v3.mode !== "brain") {
      for (const r of v3.regions) {
        if (r.shape !== "disc" || !r.members.length) continue;
        groups.push({ key: r.key, label: "", color: r.color, members: r.members, disc: { c: r.c, r: r.r + 6, emphasis: 0.5 } });
      }
    }
    for (const u of v3.units) {
      if (u.type !== "pocket" || u.members.length < 3) continue;
      groups.push({ key: `pocket:${u.key}`, label: "", color: u.color, members: u.members, disc: { c: u.c, r: u.r + 9, emphasis: 0.3 } });
    }
    return groups;
  }
  if (g.brain) {
    // Lobes: fixed translucent volumes (brain space == world space).
    const regions = new Map(g.brain.regions.map((r) => [r.key, r]));
    for (const grp of g.groups) {
      const r = regions.get(grp.key);
      if (!r) continue;
      const members: number[] = [];
      for (const id of grp.memberIds) {
        const n = nodeById.get(id);
        if (n?.index != null) members.push(n.index);
      }
      // One label per lobe (on the right-hemisphere region, counting both sides).
      const twin = r.hemi === 1 ? g.groups.find((x) => x.key === `${r.lobe}:L`) : undefined;
      const total = members.length + (twin?.memberIds.length ?? 0);
      const lobe = { label: r.label.replace(/ · [LR]$/, "") };
      const label = r.hemi === -1 || total === 0 ? "" : `${lobe?.label ?? grp.label} · ${total}`;
      groups.push({ key: grp.key, label, color: grp.color, members, volume: { c: r.c, r: r.r } });
    }
    return groups;
  }
  for (const grp of g.groups.slice(0, 80)) {
    const members: number[] = [];
    for (const id of grp.memberIds) {
      const n = nodeById.get(id);
      if (n?.index != null) members.push(n.index);
    }
    // A lone project with nothing around it doesn't need a zone.
    if (members.length < (g.mode === "project" ? 2 : 1)) continue;
    const hub = g.mode === "project" ? nodeById.get(grp.key)?.index : undefined;
    groups.push({ key: grp.key, label: `${grp.label} · ${members.length}`, color: grp.color, members, ...(hub != null ? { anchor: hub } : {}) });
  }
  return groups;
}

export interface StageRingIn {
  index: number;
  progress: number;
  live: boolean;
  mark: number;
}

/** Progress rings on every top-level project + selection / drop-target bezels. */
export function stageRingsOf(
  nodes: SceneNode[],
  sel: { selection: ReadonlySet<string>; selectedId: string | null; dropTarget?: { id: string; ok: boolean } | null },
): StageRingIn[] {
  const rings: StageRingIn[] = [];
  for (const n of nodes) {
    const i = n.index!;
    const selected = sel.selection.has(n.id) || sel.selectedId === n.id;
    const drop = sel.dropTarget?.id === n.id && sel.dropTarget.ok;
    const mark = drop ? 2 : selected ? 1 : 0;
    if (n.kind === "project" && (n.depth ?? 0) === 0) {
      const tasks = Number(n.meta?.tasks ?? 0);
      rings.push({
        index: i,
        progress: tasks > 0 ? Math.max(0, Math.min(1, Number(n.meta?.progress ?? 0))) : -1,
        live: n.meta?.live === true,
        mark,
      });
    } else if (mark || (n.kind === "run" && n.meta?.active === true)) {
      rings.push({ index: i, progress: -1, live: n.meta?.active === true, mark });
    }
  }
  return rings;
}

// ── Focus, emphasis and labels ────────────────────────────────────────────

/** Focused node + its direct neighbours. */
export function neighbourhoodOf(adjacency: Map<string, Set<string>>, focusId: string | null): Set<string> | null {
  if (!focusId) return null;
  const set = new Set<string>([focusId]);
  for (const id of adjacency.get(focusId) ?? []) set.add(id);
  return set;
}

/** Insight highlight set: its nodes plus their direct neighbours. */
export function highlightSetOf(
  ins: { nodeIds: string[] } | null,
  nodeById: Map<string, SceneNode>,
  adjacency: Map<string, Set<string>>,
): Set<string> | null {
  if (!ins) return null;
  const set = new Set<string>();
  for (const id of ins.nodeIds) {
    if (!nodeById.has(id)) continue;
    set.add(id);
    for (const nb of adjacency.get(id) ?? []) set.add(nb);
  }
  return set;
}

export interface FocusState {
  selection: ReadonlySet<string>;
  selectedId: string | null;
  hoveredId: string | null;
  adjacency: Map<string, Set<string>>;
  highlightSet: Set<string> | null;
  activeInsight: { nodeIds: string[] } | null;
}

/** 0..1 visibility of a node without multi-selection (focus + context, insight, hierarchy). */
export function baseEmphasis(n: SceneNode, focusId: string | null, nbh: Set<string> | null, f: Pick<FocusState, "highlightSet" | "activeInsight">): number {
  if (focusId) return n.id === focusId || nbh?.has(n.id) ? 1 : 0.07;
  if (f.highlightSet) {
    if (f.activeInsight?.nodeIds.includes(n.id)) return 1;
    return f.highlightSet.has(n.id) ? 0.7 : 0.1;
  }
  if (n.anchor) return n.kind === "project" && n.health === "done" ? 0.6 : 1;
  return 0.55;
}

/** 0..1 visibility of a node given focus / multi-selection / highlight state. */
export function emphasisOf(n: SceneNode, focusId: string | null, nbh: Set<string> | null, f: FocusState): number {
  // Multi-selection without a hover focus: selection bright, its neighbours
  // readable, everything else recedes.
  if (f.selection.size > 1 && !f.hoveredId) {
    if (f.selection.has(n.id)) return 1;
    for (const id of f.adjacency.get(n.id) ?? []) if (f.selection.has(id)) return 0.6;
    return 0.22;
  }
  return baseEmphasis(n, focusId, nbh, f);
}

/** The node the stage centres focus on (hover wins only under multi-selection). */
export function stageFocusId(f: Pick<FocusState, "selection" | "selectedId" | "hoveredId">): string | null {
  return f.selection.size > 1 ? (f.hoveredId ?? null) : (f.selectedId ?? f.hoveredId);
}

/** The 3D stage's emphasisFor rule (lifts the floor when nothing is focused). */
export function stageEmphasis(n: SceneNode, f: FocusState, nbhOf: (id: string | null) => Set<string> | null): number {
  const focusId = f.selection.size > 1 ? f.hoveredId : (f.selectedId ?? f.hoveredId);
  const e = emphasisOf(n, focusId, nbhOf(focusId), f);
  if (f.selection.size > 1) return e;
  // Without a focus the whole galaxy should glow; keep the 2D "minor nodes
  // are quieter" hierarchy but lift the floor.
  return focusId || f.highlightSet ? e : 0.45 + 0.55 * e;
}

/** Below this zoom (2D only): backlog/done project names stay hidden. */
export const LOD_BACKLOG_LABELS_ABOVE = 0.8;
/** Above this zoom: minor (non-anchor) nodes get labels too. */
export const LOD_MINOR_LABELS_ABOVE = 1.15;

export interface LabelRule {
  text: string;
  pri: number;
  cls: string;
  quiet: boolean;
  scale: number;
}

/**
 * Label + priority for a node at zoom `k`, or null. `stage3d` labels every
 * hub (collision-free placement keeps open work on top).
 */
export function labelRuleFor(
  n: SceneNode,
  k: number,
  ctx: { focusId: string | null; nbh: Set<string> | null; highlightSet: Set<string> | null; minorOk: boolean; degree: ArrayLike<number>; stage3d: boolean },
): LabelRule | null {
  const hl = ctx.highlightSet;
  const focusId = ctx.focusId;
  let pri: number;
  const inFocus = focusId ? n.id === focusId || !!ctx.nbh?.has(n.id) : false;
  const inHl = hl ? hl.has(n.id) : false;
  if (focusId && !inFocus) return null;
  if (hl && !inHl && !inFocus) return null;
  const bulk = n.kind === "task" || n.kind === "row";
  if (n.id === focusId) pri = 10_000;
  else if (inFocus && bulk && !ctx.minorOk) return null;
  else if (inFocus) pri = 5_000 + (n.anchor ? 500 : 0) - (bulk ? 1_000 : 0);
  else if (inHl) pri = 4_000 + (n.anchor ? 500 : 0);
  else if (n.mainParent) pri = 4_800 + (n.meta?.live ? 100 : 0);
  else if (n.kind === "project") {
    const open = n.health !== "backlog" && n.health !== "done";
    // Backlog/done names only earn a label once zoomed in (2D); the 3D stage
    // labels every hub — an unnamed orb reads as broken.
    if (!open && k < LOD_BACKLOG_LABELS_ABOVE && !ctx.stage3d) return null;
    pri = (open ? 3_000 : n.health === "backlog" ? 1_500 : 1_000) + (n.meta?.live ? 400 : 0);
    pri += Math.round((n.weight ?? 0) * 100);
  } else if (n.kind === "client") pri = 2_500 + (ctx.degree[n.index!] ?? 0) * 10;
  else if (ctx.minorOk) pri = 200 + (ctx.degree[n.index!] ?? 0);
  else return null;
  const quiet = n.kind === "project" && (n.health === "backlog" || n.health === "done");
  const cls = n.id === focusId ? "focus" : quiet ? "quiet" : n.kind === "client" ? "client" : n.anchor ? "anchor" : "minor";
  // Bigger (better-connected) nodes get bigger names that win placement.
  const scale = labelScaleFor(n.r);
  if (n.id !== focusId) pri += Math.round(n.r * 24);
  return { text: truncate(n.label), pri, cls, quiet, scale };
}

// ── Signals ──────────────────────────────────────────────────────────────

/** "N duplicate sub-projects in <project>" for projects with look-alike sub-projects (top 3). */
export function subDuplicateInsights(
  nodes: SceneNode[],
  edges: Array<{ source: string; target: string; rel: string; inferred?: boolean }>,
  adjacency: Map<string, Set<string>>,
  nodeById: Map<string, SceneNode>,
): HudInsight[] {
  const out: Array<HudInsight & { n: number }> = [];
  for (const p of nodes) {
    if (p.kind !== "project" || (adjacency.get(p.id)?.size ?? 0) < 4) continue;
    const subs = subProjectsOf(p, nodes, edges);
    if (subs.length < 3) continue;
    const clusters = clusterSubProjects(p, subs, (id) => adjacency.get(id)?.size ?? 0);
    const n = clusters.reduce((a, c) => a + c.ids.length, 0);
    if (!n) continue;
    const dup = clusters.filter((c) => c.tier === "duplicate").length;
    out.push({
      id: `g:subdup:${p.id}:${n}`,
      kind: "sub-duplicates",
      severity: dup ? "medium" : "info",
      title: `${n} duplicate sub-projects in ${truncate(p.label, 28)}`,
      detail: `${clusters.length} cluster${clusters.length === 1 ? "" : "s"} · e.g. ${clusters[0].ids.map((id) => nodeById.get(id)?.label ?? id).slice(0, 2).join(" ≈ ")}`,
      nodeIds: [p.id, ...clusters.flatMap((c) => c.ids)],
      actions: ["subs", "focus", "select"],
      source: "graph",
      n,
    });
  }
  return out.sort((a, b) => b.n - a.n).slice(0, 3).map(({ n: _n, ...i }) => i);
}

/** The Signals list: sub-project duplicates first, then gateway + graph insights. */
export function sceneInsights(
  scene: Pick<Scene, "nodes" | "links" | "adjacency" | "nodeById">,
  gatewayInsights: GraphInsightIn[] | undefined,
  now: number,
  dismissed: ReadonlySet<string>,
): HudInsight[] {
  const edges = scene.links.map((l) => ({ source: l.source.id, target: l.target.id, rel: l.rel, inferred: l.inferred }));
  const base = detectInsights(scene.nodes, edges, gatewayInsights, now, dismissed as Set<string>);
  const subs = subDuplicateInsights(scene.nodes, edges, scene.adjacency, scene.nodeById).filter((i) => !dismissed.has(i.id));
  return subs.length ? [...subs, ...base] : base;
}
