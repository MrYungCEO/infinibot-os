/**
 * Knowledge graph — 3D BRAIN formation.
 *
 * The whole graph is laid out as a recognisable brain: two cerebral
 * hemispheres (left/right, split by a visible longitudinal fissure) shaped as
 * an ellipsoid that is longer front-to-back than it is tall, a cerebellum at
 * the lower back and a short brainstem going down. Each lobe is a section of
 * the knowledge graph (see `KIND_LOBE`), so categories read as regions.
 *
 * Output coordinates are "brain space" in layout px, centred on the origin:
 *   X = lateral (−left / +right), Y = height (up), Z = front (+) / back (−).
 * The host maps them to the layout (x = cx + X, y = cy + Z, z = Y), and the
 * 3D stage maps layout → world (X, Y, Z) — so brain space IS world space.
 *
 * Everything is deterministic per node id (no randomness), so a refresh or a
 * reload rebuilds the same brain.
 */

import { healthOf, type GraphNodeKind, type ProjectHealth } from "./knowledge-graph-model";

export type LobeId = "frontal" | "parietal" | "temporal" | "occipital" | "cerebellum" | "brainstem";

export interface LobeDef {
  id: LobeId;
  label: string;
  /** What lives here (shown in docs/tooltips). */
  holds: string;
  color: string;
  /** Paired lobes exist once per hemisphere (x mirrored). */
  paired: boolean;
  /** Ellipsoid centre and radii in units of the brain scale S (right hemisphere for paired lobes). */
  c: [number, number, number];
  r: [number, number, number];
}

/**
 * Lobe config table. Mapping of graph sections to brain regions:
 *   frontal    — projects, plans, opportunities, decisions, products (executive planning)
 *   parietal   — tasks, issues, kanban rows, databases (doing / working memory)
 *   temporal   — notes, people, clients (memory, language, relationships)
 *   occipital  — reports and content/media (what we look at)
 *   cerebellum — agents, agent runs, skills, sessions (automations, coordination)
 *   brainstem  — infrastructure: federation nodes and system users (core / life support)
 */
export const LOBES: LobeDef[] = [
  { id: "frontal", label: "Frontal · plans", holds: "projects, plans, opportunities, decisions, products", color: "#f5c542", paired: true, c: [0.44, 0.18, 0.5], r: [0.38, 0.5, 0.48] },
  { id: "parietal", label: "Parietal · tasks", holds: "tasks, issues, kanban rows, databases", color: "#5ee7ff", paired: true, c: [0.44, 0.44, -0.24], r: [0.36, 0.32, 0.42] },
  { id: "temporal", label: "Temporal · memory", holds: "notes, people, clients", color: "#fdba74", paired: true, c: [0.53, -0.26, 0.06], r: [0.3, 0.24, 0.48] },
  { id: "occipital", label: "Occipital · reports", holds: "reports, content, media", color: "#5eead4", paired: true, c: [0.42, 0.08, -0.74], r: [0.32, 0.36, 0.26] },
  { id: "cerebellum", label: "Cerebellum · agents", holds: "agents, runs, skills, sessions", color: "#a78bfa", paired: true, c: [0.3, -0.52, -0.66], r: [0.27, 0.22, 0.28] },
  { id: "brainstem", label: "Brainstem · core", holds: "federation nodes, system", color: "#fde68a", paired: false, c: [0, -0.74, -0.34], r: [0.1, 0.24, 0.1] },
];

/** Graph kind → lobe. */
export const KIND_LOBE: Record<GraphNodeKind, LobeId> = {
  project: "frontal",
  opportunity: "frontal",
  decision: "frontal",
  product: "frontal",
  task: "parietal",
  issue: "parietal",
  row: "parietal",
  database: "parietal",
  note: "temporal",
  person: "temporal",
  client: "temporal",
  report: "occipital",
  content: "occipital",
  file: "occipital",
  topic: "temporal",
  agent: "cerebellum",
  run: "cerebellum",
  skill: "cerebellum",
  session: "cerebellum",
  node: "brainstem",
  user: "brainstem",
};

/**
 * Projects spill along these orders when a lobe would exceed its volume share
 * (processed by health: active → … → done). Open work stays frontal; finished
 * projects are "looked back on", so they start in the occipital lobe.
 */
export const PROJECT_SPILL: LobeId[] = ["frontal", "parietal", "temporal", "occipital"];
export const DONE_PROJECT_SPILL: LobeId[] = ["occipital", "temporal", "parietal", "frontal"];
const HEALTH_RANK: Record<ProjectHealth, number> = { active: 0, at_risk: 1, blocked: 2, review: 3, backlog: 4, done: 5 };

/** Cerebral hemisphere ellipsoid (right side; mirror x for left), in S units. */
export const HEMISPHERE = { c: [0.44, 0.08, 0] as [number, number, number], r: [0.41, 0.68, 1.02] as [number, number, number] };
/** Half-width of the longitudinal fissure (no cerebral node closer to x = 0), in S units. */
export const FISSURE = 0.07;

/** One concrete region: a lobe on one side (hemi −1 left, +1 right, 0 midline). */
export interface BrainRegion {
  key: string;
  lobe: LobeId;
  hemi: -1 | 0 | 1;
  /** Inside a cerebral hemisphere (paired lobes except the cerebellum). */
  cerebral: boolean;
  label: string;
  color: string;
  /** Centre / radii in brain space (px, already scaled). */
  c: [number, number, number];
  r: [number, number, number];
}

export function brainRegions(scale: number): BrainRegion[] {
  const out: BrainRegion[] = [];
  for (const l of LOBES) {
    const sides: Array<-1 | 0 | 1> = l.paired ? [-1, 1] : [0];
    for (const hemi of sides) {
      out.push({
        key: l.paired ? `${l.id}:${hemi < 0 ? "L" : "R"}` : l.id,
        lobe: l.id,
        hemi,
        cerebral: l.paired && l.id !== "cerebellum",
        label: l.paired ? `${l.label} · ${hemi < 0 ? "L" : "R"}` : l.label,
        color: l.color,
        c: [l.c[0] * scale * (hemi || 1), l.c[1] * scale, l.c[2] * scale],
        r: [l.r[0] * scale, l.r[1] * scale, l.r[2] * scale],
      });
    }
  }
  return out;
}

/** Brain size (S, in layout px) for a graph of n nodes. */
export function brainScale(n: number): number {
  return 260 + 26 * Math.sqrt(Math.max(1, n));
}

/** Ellipsoid "radius" of p in a region (≤ 1 inside). */
export function ellipsoidRho(p: [number, number, number], c: [number, number, number], r: [number, number, number]): number {
  const x = (p[0] - c[0]) / r[0], y = (p[1] - c[1]) / r[1], z = (p[2] - c[2]) / r[2];
  return Math.sqrt(x * x + y * y + z * z);
}

function hemisphereRho(p: [number, number, number], hemi: number, scale: number): number {
  const s = hemi || (p[0] < 0 ? -1 : 1);
  return ellipsoidRho(
    p,
    [HEMISPHERE.c[0] * scale * s, HEMISPHERE.c[1] * scale, HEMISPHERE.c[2] * scale],
    [HEMISPHERE.r[0] * scale, HEMISPHERE.r[1] * scale, HEMISPHERE.r[2] * scale],
  );
}

/** True when p (brain space) lies inside the brain silhouette (union of regions, with slack). */
export function insideBrain(p: [number, number, number], scale: number, slack = 1): boolean {
  for (const rg of brainRegions(scale)) {
    if (ellipsoidRho(p, rg.c, rg.r) > slack) continue;
    if (rg.cerebral && hemisphereRho(p, rg.hemi, scale) > slack * 1.04) continue;
    return true;
  }
  return false;
}

/** Pull p toward the region centre until it is inside the region (and its hemisphere, off the fissure). */
function clampInto(p: [number, number, number], rg: BrainRegion, scale: number, slack: number): [number, number, number] {
  let q = p;
  for (let i = 0; i < 14; i++) {
    const ok = ellipsoidRho(q, rg.c, rg.r) <= slack && (!rg.cerebral || hemisphereRho(q, rg.hemi, scale) <= slack);
    if (ok) break;
    q = [q[0] + (rg.c[0] - q[0]) * 0.18, q[1] + (rg.c[1] - q[1]) * 0.18, q[2] + (rg.c[2] - q[2]) * 0.18];
  }
  if (rg.hemi !== 0) {
    const gap = FISSURE * scale;
    if (q[0] * rg.hemi < gap) q = [gap * rg.hemi, q[1], q[2]];
  }
  return q;
}

function h01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** k-th of n directions spread evenly over a sphere (golden spiral). */
function fibDir(k: number, n: number, phase: number): [number, number, number] {
  const y = n <= 1 ? 0 : 1 - (2 * (k + 0.5)) / n;
  const rad = Math.sqrt(Math.max(0, 1 - y * y));
  const t = k * 2.399963229728653 + phase;
  return [Math.cos(t) * rad, y, Math.sin(t) * rad];
}

export interface BrainNodeIn {
  id: string;
  kind: GraphNodeKind | string;
  anchor: boolean;
  meta?: Record<string, unknown>;
  /** Hierarchy parent (index), e.g. a sub-project's parent project: it orbits close to that node. */
  parent?: number;
}

export interface BrainLayout {
  scale: number;
  regions: BrainRegion[];
  /** Region key per node. */
  regionOf: string[];
  /** Target per node in brain space: [X, Y, Z] × n. */
  target: Float32Array;
  /** Node a node clusters around (-1 = a root, placed directly in its lobe). */
  parent: Int32Array;
  /** Family root per node (its cluster); orphans are their own root. */
  family: Int32Array;
  /** Roots with no links at all (placed in their lobe's sparse core). */
  orphan: Uint8Array;
}

/** Min gap between any linked cluster and an unlinked (orphan) node. */
export const ORPHAN_CLEARANCE = 64;
/** Min gap between two clusters' bounding spheres. */
export const CLUSTER_GAP = 22;
/** Orphan core zone, as a fraction of the lobe radii. */
const ORPHAN_ZONE = 0.34;
/** Footprint of a node itself (largest main-project radius + glow). */
const NODE_PAD = 20;

/** Uniform 3D hash grid of spheres for fast clearance checks. */
class SphereGrid {
  private readonly cells = new Map<string, number[]>();
  readonly items: Array<[number, number, number, number]> = [];
  maxR = 0;
  constructor(private readonly cell: number) {}
  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
  }
  add(x: number, y: number, z: number, r: number): void {
    const id = this.items.push([x, y, z, r]) - 1;
    this.maxR = Math.max(this.maxR, r);
    const k = this.key(x, y, z);
    (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(id);
  }
  /** Smallest (distance − r_other − r) over spheres near p (Infinity when none). */
  clearance(x: number, y: number, z: number, r: number, reach: number): number {
    const span = Math.ceil((r + this.maxR + reach) / this.cell);
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell);
    let best = Infinity;
    for (let i = -span; i <= span; i++)
      for (let j = -span; j <= span; j++)
        for (let k = -span; k <= span; k++) {
          const list = this.cells.get(`${cx + i},${cy + j},${cz + k}`);
          if (!list) continue;
          for (const id of list) {
            const it = this.items[id];
            const d = Math.hypot(it[0] - x, it[1] - y, it[2] - z) - it[3] - r;
            if (d < best) best = d;
          }
        }
    return best;
  }
}

/**
 * Assign every node a lobe region and a target point.
 *  1. Families: roots = anchors (projects, clients) without a hierarchy
 *     parent, plus anything unreachable from them. Sub-projects hang off
 *     their parent project; other satellites (BFS) off the nearest placed
 *     node — each family is one CLUSTER.
 *  2. Roots go to their kind's lobe; projects spill (PROJECT_SPILL /
 *     DONE_PROJECT_SPILL) when a lobe would exceed its volume share.
 *  3. Paired lobes balance their load across hemispheres.
 *  4. Unlinked roots (orphans) fill a sparse core zone of their lobe; linked
 *     clusters are packed on the cortex (outer shell first) so no two
 *     clusters overlap and every cluster keeps ORPHAN_CLEARANCE from orphans.
 *  5. Members sit in a 3D cloud around their parent, closest for sub-projects.
 */
export function layoutBrain(nodes: BrainNodeIn[], neighbors: number[][]): BrainLayout {
  const n = nodes.length;
  const scale = brainScale(n);
  const regions = brainRegions(scale);
  const regionByKey = new Map(regions.map((r) => [r.key, r]));
  const parent = new Int32Array(n).fill(-1);

  // 1. Families.
  const hint = new Int32Array(n).fill(-1);
  const hintKids: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const h = nodes[i].parent;
    if (h != null && h >= 0 && h < n && h !== i) {
      hint[i] = h;
      hintKids[h].push(i);
    }
  }
  const queued = new Uint8Array(n);
  const queue: number[] = [];
  const grow = (from: number) => {
    for (let q = from; q < queue.length; q++) {
      const p = queue[q];
      for (const c of hintKids[p]) {
        if (queued[c]) continue;
        queued[c] = 1;
        parent[c] = p;
        queue.push(c);
      }
      for (const c of neighbors[p] ?? []) {
        if (queued[c] || hint[c] >= 0) continue; // hinted nodes wait for their own parent
        queued[c] = 1;
        parent[c] = p;
        queue.push(c);
      }
    }
  };
  for (let i = 0; i < n; i++) {
    if (nodes[i].anchor && hint[i] < 0) {
      queued[i] = 1;
      queue.push(i);
    }
  }
  grow(0);
  // Components without a root anchor (or hint cycles): their first node becomes a root.
  for (let i = 0; i < n; i++) {
    if (queued[i]) continue;
    queued[i] = 1;
    queue.push(i);
    grow(queue.length - 1);
  }
  const children: number[][] = Array.from({ length: n }, () => []);
  for (const i of queue) if (parent[i] >= 0) children[parent[i]].push(i);
  const family = new Int32Array(n);
  for (const i of queue) family[i] = parent[i] >= 0 ? family[parent[i]] : i;
  const weight = new Float64Array(n);
  // Cluster radius (bottom-up): kids orbit at `base + R(kid)`.
  const R = new Float64Array(n);
  const kidDist = new Float64Array(n);
  for (let q = queue.length - 1; q >= 0; q--) {
    const i = queue[q];
    weight[i] += 1;
    if (parent[i] >= 0) weight[parent[i]] += weight[i];
    const kids = children[i];
    if (!kids.length) continue;
    const base = 14 + 5 * Math.sqrt(kids.length);
    let r = 0;
    for (const c of kids) {
      kidDist[c] = (hint[c] === i ? base * 0.8 : base) * (0.85 + 0.15 * h01(`dist:${nodes[c].id}`)) + R[c] * 0.9;
      r = Math.max(r, kidDist[c] + R[c]);
    }
    R[i] = r;
  }
  const roots: number[] = queue.filter((i) => parent[i] < 0);
  const orphan = new Uint8Array(n);
  for (const i of roots) if (!children[i].length && !(neighbors[i]?.length ?? 0)) orphan[i] = 1;

  // 2. Lobe per root (capacity = volume share).
  const lobeVol = new Map<LobeId, number>();
  let volSum = 0;
  for (const l of LOBES) {
    const v = l.r[0] * l.r[1] * l.r[2] * (l.paired ? 2 : 1);
    lobeVol.set(l.id, v);
    volSum += v;
  }
  const total = roots.reduce((a, i) => a + weight[i], 0);
  const cap = (l: LobeId) => (lobeVol.get(l)! / volSum) * total * 1.35 + 2;
  const load = new Map<LobeId, number>(LOBES.map((l) => [l.id, 0]));
  const lobeOf = new Map<number, LobeId>();
  const byId = (a: number, b: number) => (nodes[a].id < nodes[b].id ? -1 : nodes[a].id > nodes[b].id ? 1 : 0);
  const projects = roots.filter((i) => nodes[i].kind === "project");
  const others = roots.filter((i) => nodes[i].kind !== "project").sort(byId);
  for (const i of others) {
    const l = KIND_LOBE[nodes[i].kind as GraphNodeKind] ?? "temporal";
    lobeOf.set(i, l);
    load.set(l, load.get(l)! + weight[i]);
  }
  projects.sort((a, b) => {
    const ha = HEALTH_RANK[healthOf(nodes[a].meta)] ?? 9;
    const hb = HEALTH_RANK[healthOf(nodes[b].meta)] ?? 9;
    return ha - hb || byId(a, b);
  });
  for (const i of projects) {
    const order = healthOf(nodes[i].meta) === "done" ? DONE_PROJECT_SPILL : PROJECT_SPILL;
    let pick: LobeId | null = null;
    for (const l of order) {
      if (load.get(l)! + weight[i] <= cap(l)) {
        pick = l;
        break;
      }
    }
    if (!pick) {
      pick = order.reduce((best, l) => (load.get(l)! / cap(l) < load.get(best)! / cap(best) ? l : best), order[0]);
    }
    lobeOf.set(i, pick);
    load.set(pick, load.get(pick)! + weight[i]);
  }

  // 3. Region (hemisphere) per root, balanced by weight.
  const regionOf: string[] = new Array(n);
  const members = new Map<string, number[]>();
  const regionLoad = new Map<string, number>();
  for (const i of [...others, ...projects]) {
    const l = LOBES.find((x) => x.id === lobeOf.get(i))!;
    let key: string;
    if (!l.paired) key = l.id;
    else {
      const L = regionLoad.get(`${l.id}:L`) ?? 0;
      const Rr = regionLoad.get(`${l.id}:R`) ?? 0;
      key = `${l.id}:${L < Rr || (L === Rr && h01(`hemi:${nodes[i].id}`) < 0.5) ? "L" : "R"}`;
    }
    regionOf[i] = key;
    regionLoad.set(key, (regionLoad.get(key) ?? 0) + weight[i]);
    (members.get(key) ?? members.set(key, []).get(key)!).push(i);
  }

  // 4a. Orphans: a sparse core zone per region.
  const target = new Float32Array(n * 3);
  const set = (i: number, p: [number, number, number]) => {
    target[i * 3] = p[0];
    target[i * 3 + 1] = p[1];
    target[i * 3 + 2] = p[2];
  };
  const orphanGrid = new SphereGrid(90);
  const gap = FISSURE * scale;
  for (const rg of regions) {
    const list = (members.get(rg.key) ?? []).filter((i) => orphan[i]);
    const phase = h01(`orph:${rg.key}`) * Math.PI * 2;
    list.forEach((i, k) => {
      const d = fibDir(k, list.length, phase);
      const rho = list.length === 1 ? 0 : 0.3 + 0.7 * Math.cbrt(h01(`orho:${nodes[i].id}`));
      let p: [number, number, number] = [
        rg.c[0] + d[0] * rho * rg.r[0] * ORPHAN_ZONE,
        rg.c[1] + d[1] * rho * rg.r[1] * ORPHAN_ZONE,
        rg.c[2] + d[2] * rho * rg.r[2] * ORPHAN_ZONE,
      ];
      if (rg.hemi !== 0 && p[0] * rg.hemi < gap) p = [gap * rg.hemi, p[1], p[2]];
      set(i, p);
      orphanGrid.add(p[0], p[1], p[2], 6);
    });
  }

  // 4b. Linked clusters: packed on the cortex, biggest first.
  const clusterGrid = new SphereGrid(140);
  const rhoLevels = [0.92, 0.82, 0.72, 0.62, 0.52, 0.42];
  for (const rg of regions) {
    const list = (members.get(rg.key) ?? []).filter((i) => !orphan[i]).sort((a, b) => R[b] - R[a] || byId(a, b));
    const M = Math.max(48, list.length * 4);
    const phase = h01(`phase:${rg.key}`) * Math.PI * 2;
    const minR = Math.min(rg.r[0], rg.r[1], rg.r[2]);
    let cursor = 0;
    for (const i of list) {
      const rad = R[i] + NODE_PAD;
      let best: [number, number, number] | null = null;
      let bestScore = -Infinity;
      search: for (const rho of rhoLevels) {
        for (let t = 0; t < M; t++) {
          const d = fibDir((t + cursor) % M, M, phase);
          let p: [number, number, number] = [rg.c[0] + d[0] * rho * rg.r[0], rg.c[1] + d[1] * rho * rg.r[1], rg.c[2] + d[2] * rho * rg.r[2]];
          if (rg.hemi !== 0 && p[0] * rg.hemi < gap + rad) p = [(gap + rad) * rg.hemi, p[1], p[2]];
          // Slack per constraint (≥ 0 = satisfied); the worst one scores the spot.
          const inLobe = (0.98 - ellipsoidRho(p, rg.c, rg.r)) * minR - rad * 0.6;
          const inHemi = !rg.cerebral ? Infinity : (1.0 - hemisphereRho(p, rg.hemi, scale)) * minR - rad * 0.5;
          const fromOrphans = orphanGrid.clearance(p[0], p[1], p[2], rad, ORPHAN_CLEARANCE) - ORPHAN_CLEARANCE;
          const fromClusters = clusterGrid.clearance(p[0], p[1], p[2], rad, CLUSTER_GAP) - CLUSTER_GAP;
          const score = Math.min(inLobe, inHemi, fromOrphans, fromClusters);
          if (score > bestScore) {
            bestScore = score;
            best = p;
          }
          if (score >= 0) {
            cursor = (t + cursor + 1) % M;
            break search;
          }
        }
      }
      const p = best ?? [rg.c[0], rg.c[1], rg.c[2]];
      set(i, p);
      clusterGrid.add(p[0], p[1], p[2], rad);
    }
  }

  // 5. Members: a 3D cloud around their parent, inside the root's region.
  for (const p of queue) {
    const kids = children[p];
    if (!kids.length) continue;
    const rg = regionByKey.get(regionOf[family[p]])!;
    const phase = h01(`kids:${nodes[p].id}`) * Math.PI * 2;
    kids.forEach((c, k) => {
      regionOf[c] = regionOf[family[p]];
      const d = fibDir(k, kids.length, phase);
      const m = kidDist[c];
      set(c, clampInto([target[p * 3] + d[0] * m, target[p * 3 + 1] + d[1] * m, target[p * 3 + 2] + d[2] * m], rg, scale, 1.06));
    });
  }
  return { scale, regions, regionOf, target, parent, family, orphan };
}
