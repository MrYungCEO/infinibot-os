/**
 * Knowledge graph — v3 readable layout (every Group mode).
 *
 * One deterministic placement engine for brain | orbit | project | status |
 * type | cluster, built from three nested levels of non-overlapping shapes:
 *
 *   REGION  — a group (type, status band, project, cluster, brain lobe·side).
 *   UNIT    — inside a region: one linked FAMILY (a hub and everything that
 *             hangs off it), a "linked elsewhere" fragment unit, or a POCKET
 *             of UNLINKED nodes of one kind (unlinked notes together, unlinked
 *             projects together, …). Pockets never mix with linked units.
 *   NODE    — inside a unit: rings (2D modes) or shells (brain) around the
 *             unit's hub, sized so neighbours never touch.
 *
 * Every level packs circles/balls with explicit gaps (NODE_PAD < UNIT_GAP <
 * REGION_GAP), so nodes never overlap and groups read apart. Region area
 * follows member count (√n radius), regions pack into an ellipse matched to
 * the canvas aspect, so the whole canvas is used instead of one central pile.
 *
 * Big units are LOD candidates (`aggregatable`): when zoomed out the stage
 * draws them as one super-node with a count + status ring. Links between
 * units are summarised as bundles (`bundles`: one ribbon per unit pair whose
 * width shows the link count) instead of thousands of lines.
 *
 * Output is world space: [X, Y(height), Z]. The host maps it to the layout
 * (x = cx + X, y = cy + Z, z = Y).
 */

import {
  BRAIN_BOUNDS,
  FISSURE,
  LOBE_IDS,
  brainSdf,
  lobeAt,
  type LobeId,
} from "../lib/glow3d/brain-anatomy";
import { healthOf, KIND_LABEL, KIND_PALETTE, type GraphNodeKind, type ProjectHealth } from "./knowledge-graph-model";

export type V3 = [number, number, number];
export type V3Mode = "brain" | "orbit" | "project" | "status" | "type" | "cluster";

export interface V3NodeIn {
  id: string;
  kind: string;
  anchor: boolean;
  /** Visual radius (world units). */
  r: number;
  label?: string;
  meta?: Record<string, unknown>;
  /** Hierarchy parent index (sub-project → parent project). */
  parent?: number;
}

/** A group from the host's grouping (type/status/project/cluster modes). */
export interface V3GroupIn {
  key: string;
  label: string;
  color: string;
}

export interface V3Unit {
  key: string;
  region: number;
  /** family = a hub with its satellites; linked = small linked fragments; pocket = unlinked nodes of one kind. */
  type: "family" | "linked" | "pocket";
  /** Node kind (pockets). */
  nodeKind?: string;
  /** Representative node (the hub at the unit centre). */
  rep: number;
  members: number[];
  c: V3;
  r: number;
  label: string;
  color: string;
  /** Big enough to collapse into a super-node when zoomed out. */
  aggregatable: boolean;
}

export interface V3Region {
  key: string;
  label: string;
  color: string;
  members: number[];
  units: number[];
  c: V3;
  r: number;
  /** disc = a packed zone; ring = an orbit band; lobe = a brain lobe on one side. */
  shape: "disc" | "ring" | "lobe";
  lobe?: LobeId;
  side?: -1 | 0 | 1;
}

export interface V3Bundle {
  /** Representative node indices (unit hubs); −1 for region-level bundles. */
  a: number;
  b: number;
  /** Units (unit-level) or −1. */
  ua: number;
  ub: number;
  /** Regions of the two ends. */
  ra: number;
  rb: number;
  count: number;
  /** Region-level bundles connect region centres (fixed world points). */
  pa?: V3;
  pb?: V3;
}

export interface V3Layout {
  mode: V3Mode;
  /** Brain scale S (world units per brain unit), 0 outside brain mode. */
  scale: number;
  target: Float32Array;
  unitOf: Int32Array;
  regionOf: Int32Array;
  family: Int32Array;
  units: V3Unit[];
  regions: V3Region[];
  bundles: V3Bundle[];
  /** Orbit mode: band ring radii (guide rings). */
  orbitRadii: number[];
}

/** Gap between two nodes inside a unit (beyond their radii). */
export const NODE_PAD = 5;
/** Gap between two units in a region. */
export const UNIT_GAP = 34;
/** Gap between two regions. */
export const REGION_GAP = 90;
/** Units with at least this many members collapse into a super-node when zoomed out. */
export const AGG_MIN = 40;
/** Brain pockets are split into chunks of at most this many nodes (spread across lobes/sides). */
export const POCKET_CHUNK = 48;

/** Gap a unit keeps from its neighbours: pockets keep the full moat, small clusters a smaller one. */
export function unitGapFor(type: string, r: number): number {
  return type === "pocket" ? UNIT_GAP * 1.6 : Math.min(UNIT_GAP, 12 + r * 0.3);
}

/** LOD: a unit collapses when its nodes would sit closer than this on screen (px)… */
export const LOD_COLLAPSE_PX = 3.2;
/** …and expands again once they are this far apart (hysteresis, no flicker). */
export const LOD_EXPAND_PX = 4.8;

/**
 * Should a unit of `count` nodes, `screenRadius` px across on screen, draw
 * as one super-node? Mean on-screen spacing ≈ screenRadius / √count.
 */
export function lodCollapsed(count: number, screenRadius: number, wasCollapsed: boolean): boolean {
  if (count < AGG_MIN) return false;
  const spacing = screenRadius / Math.sqrt(count);
  return wasCollapsed ? spacing < LOD_EXPAND_PX : spacing < LOD_COLLAPSE_PX;
}

/** Super-node core radius (world) for a unit: grows with √count, never past the unit. */
export function superRadius(count: number, unitR: number): number {
  return Math.min(unitR * 0.62, Math.max(14, 9 + 3.4 * Math.sqrt(count)));
}

// ── Hashing ──────────────────────────────────────────────────────────

export function h01(s: string): number {
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

function fibDir(k: number, n: number, phase: number): V3 {
  const y = n <= 1 ? 0 : 1 - (2 * (k + 0.5)) / n;
  const rad = Math.sqrt(Math.max(0, 1 - y * y));
  const t = k * 2.399963229728653 + phase;
  return [Math.cos(t) * rad, y, Math.sin(t) * rad];
}

// ── Families ─────────────────────────────────────────────────────────

export interface Families {
  parent: Int32Array;
  family: Int32Array;
  /** BFS order (roots first, then satellites outward). */
  order: number[];
  depth: Int32Array;
}

/**
 * Families: roots = anchors (projects, clients) without a hierarchy parent,
 * plus the first node of every component no anchor reaches. Sub-projects hang
 * off their parent; other satellites (BFS) off the nearest placed node.
 */
export function buildFamilies(nodes: V3NodeIn[], neighbors: number[][]): Families {
  const n = nodes.length;
  const parent = new Int32Array(n).fill(-1);
  const depth = new Int32Array(n);
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
  const order: number[] = [];
  const grow = (from: number) => {
    for (let q = from; q < order.length; q++) {
      const p = order[q];
      for (const c of hintKids[p]) {
        if (queued[c]) continue;
        queued[c] = 1;
        parent[c] = p;
        depth[c] = depth[p] + 1;
        order.push(c);
      }
      for (const c of neighbors[p] ?? []) {
        if (queued[c] || hint[c] >= 0) continue;
        queued[c] = 1;
        parent[c] = p;
        depth[c] = depth[p] + 1;
        order.push(c);
      }
    }
  };
  for (let i = 0; i < n; i++) {
    if (nodes[i].anchor && hint[i] < 0) {
      queued[i] = 1;
      order.push(i);
    }
  }
  grow(0);
  for (let i = 0; i < n; i++) {
    if (queued[i]) continue;
    queued[i] = 1;
    order.push(i);
    grow(order.length - 1);
  }
  const family = new Int32Array(n);
  for (const i of order) family[i] = parent[i] >= 0 ? family[parent[i]] : i;
  return { parent, family, order, depth };
}

// ── Node placement inside a unit ─────────────────────────────────────

/**
 * Concentric rings in the X/Z plane: first node at the centre, then rings
 * whose capacity guarantees chord ≥ 2·rmax + pad. Returns local offsets and
 * the unit radius.
 */
export function ringPack(radii: number[], pad = NODE_PAD, phase = 0, hubGap = 0): { pts: Array<[number, number]>; r: number } {
  const m = radii.length;
  const pts: Array<[number, number]> = new Array(m);
  if (!m) return { pts, r: 0 };
  pts[0] = [0, 0];
  let outer = radii[0];
  let i = 1;
  let ring = 0;
  while (i < m) {
    let rmax = radii[i];
    let R = 0;
    let count = 1;
    for (let it = 0; it < 3; it++) {
      // First ring around a hub keeps a gap so parent→child links have visible length.
      R = outer + (ring === 0 ? Math.max(pad, hubGap) : pad) + rmax;
      const s = Math.min(1, (2 * rmax + pad) / (2 * R));
      count = Math.max(1, Math.min(m - i, Math.floor(Math.PI / Math.asin(s) + 1e-9)));
      let nm = 0;
      for (let k = i; k < i + count; k++) nm = Math.max(nm, radii[k]);
      if (nm <= rmax) break;
      rmax = nm;
    }
    const off = phase + ring * 2.399963;
    for (let k = 0; k < count; k++) {
      const a = off + (k / count) * Math.PI * 2;
      pts[i + k] = [Math.cos(a) * R, Math.sin(a) * R];
    }
    i += count;
    outer = R + rmax;
    ring++;
  }
  return { pts, r: outer };
}

/** Concentric Fibonacci shells (brain units): min spacing ≥ 2·rmax + pad. */
export function shellPack(radii: number[], pad = NODE_PAD, phase = 0, hubGap = 0): { pts: V3[]; r: number } {
  const m = radii.length;
  const pts: V3[] = new Array(m);
  if (!m) return { pts, r: 0 };
  pts[0] = [0, 0, 0];
  let outer = radii[0];
  let i = 1;
  let shell = 0;
  while (i < m) {
    let rmax = radii[i];
    let R = 0;
    let count = 1;
    for (let it = 0; it < 3; it++) {
      R = outer + (shell === 0 ? Math.max(pad, hubGap) : pad) + rmax;
      const d = 2 * rmax + pad;
      // Fibonacci shells keep min spacing ≥ 2.65·R/√n (measured ≥ 2.68 for every n ≥ 2).
      count = Math.max(1, Math.min(m - i, Math.floor(((2.65 * R) / d) ** 2)));
      let nm = 0;
      for (let k = i; k < i + count; k++) nm = Math.max(nm, radii[k]);
      if (nm <= rmax) break;
      rmax = nm;
    }
    const ph = phase + shell * 1.3;
    for (let k = 0; k < count; k++) {
      const dir = count === 1 ? fibDir(0, 2, ph) : fibDir(k, count, ph);
      pts[i + k] = [dir[0] * R, dir[1] * R, dir[2] * R];
    }
    i += count;
    outer = R + rmax;
    shell++;
  }
  return { pts, r: outer };
}

// ── Circle packing (units in a region, regions on the canvas) ────────

/**
 * Greedy front packing of circles (largest first) toward the centre of an
 * ellipse (x stretched by `aspect`). Circles i and j keep at least
 * max(gap_i, gap_j) between their rims (`gap` may be one number or one per
 * circle). Candidates are tangent spots next to placed circles and between
 * neighbouring pairs; a uniform grid keeps every test local.
 * Returns centres in input order, recentred on the bounding box.
 */
export function packCircles(radii: number[], gap: number | number[], aspect = 1): Array<[number, number]> {
  const n = radii.length;
  const out: Array<[number, number]> = new Array(n);
  if (!n) return out;
  const g = (i: number) => (typeof gap === "number" ? gap : gap[i]);
  const order = radii.map((_, i) => i).sort((a, b) => radii[b] - radii[a] || a - b);
  const px = new Float64Array(n), py = new Float64Array(n);
  let maxR = 0, maxG = 0;
  for (let i = 0; i < n; i++) {
    maxR = Math.max(maxR, radii[i]);
    maxG = Math.max(maxG, g(i));
  }
  const sortedR = [...radii].sort((a, b) => a - b);
  const medR = sortedR[sortedR.length >> 1];
  const medG = typeof gap === "number" ? gap : [...gap].sort((a, b) => a - b)[gap.length >> 1];
  const cell = Math.max(16, (medR * 2 + medG) * 1.5);
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
  const placed: number[] = [];
  const front: number[] = [];
  let minR = Infinity, minG = Infinity;
  for (let i = 0; i < n; i++) {
    minR = Math.min(minR, radii[i]);
    minG = Math.min(minG, g(i));
  }
  const insert = (i: number) => {
    front.push(i);
    const cx = Math.floor(px[i] / cell), cy = Math.floor(py[i] / cell);
    // Big circles are registered in every cell they cover.
    const span = Math.ceil(radii[i] / cell);
    for (let a = -span; a <= span; a++)
      for (let b = -span; b <= span; b++) {
        const k = key(cx + a, cy + b);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
    placed.push(i);
  };
  const stamp = new Int32Array(n).fill(-1);
  let stampId = 0;
  const near = (x: number, y: number, reach: number, fn: (j: number) => boolean | void): boolean => {
    stampId++;
    const span = Math.ceil(reach / cell);
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let a = -span; a <= span; a++)
      for (let b = -span; b <= span; b++) {
        const list = grid.get(key(cx + a, cy + b));
        if (!list) continue;
        for (const j of list) {
          if (stamp[j] === stampId) continue;
          stamp[j] = stampId;
          if (fn(j) === false) return false;
        }
      }
    return true;
  };
  const fits = (x: number, y: number, r: number, gi: number) =>
    near(x, y, r + maxG + cell, (j) => Math.hypot(x - px[j], y - py[j]) >= r + radii[j] + Math.max(gi, g(j)) - 1e-6);
  const score = (x: number, y: number, r: number) => {
    const ex = (Math.abs(x) + r) / aspect, ey = Math.abs(y) + r;
    return Math.max(ex, ey) + 0.15 * Math.hypot(x / aspect, y);
  };
  let ext = 0;
  for (const i of order) {
    const r = radii[i];
    const gi = g(i);
    if (!placed.length) {
      px[i] = 0;
      py[i] = 0;
      insert(i);
      ext = r;
      continue;
    }
    let bx = 0, by = 0, best = Infinity;
    const tryAt = (x: number, y: number) => {
      const s = score(x, y, r);
      if (s >= best) return;
      if (!fits(x, y, r, gi)) return;
      best = s;
      bx = x;
      by = y;
    };
    // Only circles on the open front can host a new neighbour; a circle
    // closes for good once even the smallest circle can't fit beside it.
    for (let fi = 0; fi < front.length; fi++) {
      const j = front[fi];
      const dj = r + radii[j] + Math.max(gi, g(j));
      let any = false;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + 0.2;
        const x = px[j] + Math.cos(a) * dj, y = py[j] + Math.sin(a) * dj;
        if (fits(x, y, r, gi)) {
          any = true;
          const sc = score(x, y, r);
          if (sc < best) {
            best = sc;
            bx = x;
            by = y;
          }
        }
      }
      // Tangent to j and each neighbour k of j (tight spots between two circles).
      near(px[j], py[j], radii[j] + 2 * r + 2 * maxG + maxR, (k) => {
        if (k === j) return;
        const rb = r + radii[k] + Math.max(gi, g(k));
        const dx = px[k] - px[j], dy = py[k] - py[j];
        const d = Math.hypot(dx, dy);
        if (d > dj + rb || d < Math.abs(dj - rb) || d < 1e-9) return;
        const t = (dj * dj - rb * rb + d * d) / (2 * d);
        const hh = Math.sqrt(Math.max(0, dj * dj - t * t));
        const mx = px[j] + (dx * t) / d, my = py[j] + (dy * t) / d;
        const c1x = mx - (dy * hh) / d, c1y = my + (dx * hh) / d;
        const c2x = mx + (dy * hh) / d, c2y = my - (dx * hh) / d;
        if (score(c1x, c1y, r) < best && fits(c1x, c1y, r, gi)) { best = score(c1x, c1y, r); bx = c1x; by = c1y; any = true; }
        if (score(c2x, c2y, r) < best && fits(c2x, c2y, r, gi)) { best = score(c2x, c2y, r); bx = c2x; by = c2y; any = true; }
      });
      if (!any) {
        // Closed for the smallest circle too? Then never look at j again.
        const dm = minR + radii[j] + Math.max(minG, g(j));
        let free = false;
        for (let k = 0; k < 24 && !free; k++) {
          const a = (k / 24) * Math.PI * 2 + 0.05;
          if (fits(px[j] + Math.cos(a) * dm, py[j] + Math.sin(a) * dm, minR, minG)) free = true;
        }
        if (!free) {
          front[fi] = front[front.length - 1];
          front.pop();
          fi--;
        }
      }
    }
    if (best === Infinity) {
      bx = ext + r + gi;
      by = 0;
    }
    px[i] = bx;
    py[i] = by;
    insert(i);
    ext = Math.max(ext, Math.hypot(bx, by) + r);
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, px[i] - radii[i]);
    x1 = Math.max(x1, px[i] + radii[i]);
    y0 = Math.min(y0, py[i] - radii[i]);
    y1 = Math.max(y1, py[i] + radii[i]);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  for (let i = 0; i < n; i++) out[i] = [px[i] - mx, py[i] - my];
  return out;
}

/** Region gap that grows with region size (tiny zones don't need a moat). */
export function regionGapFor(r: number): number {
  return Math.min(REGION_GAP, 28 + r * 0.3);
}

// ── Labels / colours ─────────────────────────────────────────────────

const PLURAL: Record<string, string> = {
  project: "projects", client: "clients", opportunity: "opportunities", product: "products", issue: "issues",
  decision: "decisions", person: "people", note: "notes", task: "tasks", report: "reports", content: "content", file: "files", topic: "topics",
  agent: "agents", run: "agent runs", skill: "skills", session: "sessions", database: "databases", row: "rows",
  node: "nodes", user: "users",
};
export const pluralKind = (k: string) => PLURAL[k] ?? `${KIND_LABEL[k as GraphNodeKind] ?? k}s`.toLowerCase();

/** Status buckets for super-node rings: [open, at risk / blocked, backlog / todo, done]. */
export function statusMix(nodes: V3NodeIn[], members: number[]): [number, number, number, number] {
  const c = [0, 0, 0, 0];
  for (const i of members) {
    const nd = nodes[i];
    let b = 0;
    if (nd.kind === "project") {
      const h = healthOf(nd.meta);
      b = h === "done" ? 3 : h === "backlog" ? 2 : h === "at_risk" || h === "blocked" ? 1 : 0;
    } else {
      const s = String(nd.meta?.status ?? "").toLowerCase();
      b = /done|complete|closed|archiv/.test(s) ? 3 : /block|risk|overdue|fail/.test(s) ? 1 : /backlog|todo|open|new|idea/.test(s) ? 2 : 0;
    }
    c[b]++;
  }
  const t = members.length || 1;
  return [c[0] / t, c[1] / t, c[2] / t, c[3] / t];
}

// ── Brain lobe assignment ────────────────────────────────────────────

/** Graph kind → preferred lobe, then the order it may spill to when full. */
export const KIND_LOBE_ORDER: Record<string, LobeId[]> = {
  project: ["frontal", "parietal", "temporal", "occipital"],
  opportunity: ["frontal", "parietal", "temporal", "occipital"],
  decision: ["frontal", "parietal", "temporal", "occipital"],
  product: ["frontal", "parietal", "temporal", "occipital"],
  task: ["parietal", "frontal", "occipital", "temporal"],
  issue: ["parietal", "frontal", "occipital", "temporal"],
  row: ["parietal", "occipital", "frontal", "temporal"],
  database: ["parietal", "occipital", "frontal", "temporal"],
  note: ["temporal", "occipital", "parietal", "frontal"],
  person: ["temporal", "occipital", "parietal", "frontal"],
  client: ["temporal", "frontal", "parietal", "occipital"],
  report: ["occipital", "temporal", "parietal", "frontal"],
  content: ["occipital", "temporal", "parietal", "frontal"],
  agent: ["cerebellum"],
  run: ["cerebellum"],
  skill: ["cerebellum"],
  session: ["cerebellum"],
  node: ["brainstem"],
  user: ["brainstem"],
};
const DONE_ORDER: LobeId[] = ["occipital", "temporal", "parietal", "frontal"];

export const LOBE_LABEL: Record<LobeId, string> = {
  frontal: "Frontal · plans",
  parietal: "Parietal · tasks",
  temporal: "Temporal · memory",
  occipital: "Occipital · reports",
  cerebellum: "Cerebellum · agents",
  brainstem: "Brainstem · core",
};
export const LOBE_COLOR: Record<LobeId, string> = {
  frontal: "#f5c542",
  parietal: "#5ee7ff",
  temporal: "#fdba74",
  occipital: "#5eead4",
  cerebellum: "#a78bfa",
  brainstem: "#fde68a",
};

interface BrainCand {
  p: V3; // unit space
  depth: number;
  lobe: LobeId;
  side: -1 | 0 | 1;
}

let brainCandCache: { step: number; cands: BrainCand[]; volume: Map<string, number> } | null = null;

/** Grid of candidate centres inside the brain (unit space), with depth/lobe/side. Cached. */
export function brainCandidates(step = 0.034): { cands: BrainCand[]; volume: Map<string, number> } {
  if (brainCandCache && brainCandCache.step === step) return brainCandCache;
  const cands: BrainCand[] = [];
  const volume = new Map<string, number>();
  const { min, max } = BRAIN_BOUNDS;
  let gi = 0;
  for (let x = min[0]; x <= max[0]; x += step) {
    for (let y = min[1]; y <= max[1]; y += step) {
      for (let z = min[2]; z <= max[2]; z += step) {
        gi++;
        const hx = Math.imul(gi, 0x9e3779b1) >>> 0;
        const jx = x + ((hx & 1023) / 1023 - 0.5) * step * 0.5;
        const jy = y + (((hx >>> 10) & 1023) / 1023 - 0.5) * step * 0.5;
        const jz = z + (((hx >>> 20) & 1023) / 1023 - 0.5) * step * 0.5;
        const d = brainSdf(jx, jy, jz);
        if (d >= 0) continue;
        const lobe = lobeAt(jx, jy, jz);
        const side: -1 | 0 | 1 = lobe === "brainstem" ? 0 : jx < 0 ? -1 : 1;
        const key = `${lobe}:${side}`;
        volume.set(key, (volume.get(key) ?? 0) + 1);
        cands.push({ p: [jx, jy, jz], depth: -d, lobe, side });
      }
    }
  }
  cands.sort((a, b) => a.depth - b.depth);
  brainCandCache = { step, cands, volume };
  return brainCandCache;
}

const BALL_SAMPLES: V3[] = (() => {
  const s: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const k = 1 / Math.sqrt(3);
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) s.push([a * k, b * k, c * k]);
  return s;
})();

/** Lobe occupancy (load ÷ lobe volume, normalised to the mean) for the 4 cerebral lobes. */
export function lobeOccupancy(layout: V3Layout): Record<string, number> {
  const { volume } = brainCandidates();
  const load = new Map<string, number>();
  for (const u of layout.units) {
    const rg = layout.regions[u.region];
    if (!rg.lobe) continue;
    load.set(rg.lobe, (load.get(rg.lobe) ?? 0) + u.members.length);
  }
  const vol = new Map<string, number>();
  for (const [k, v] of volume) {
    const l = k.split(":")[0];
    vol.set(l, (vol.get(l) ?? 0) + v);
  }
  const out: Record<string, number> = {};
  const cer = ["frontal", "parietal", "temporal", "occipital"];
  let mean = 0;
  for (const l of cer) mean += (load.get(l) ?? 0) / (vol.get(l) ?? 1);
  mean /= cer.length;
  for (const l of cer) out[l] = mean > 0 ? (load.get(l) ?? 0) / (vol.get(l) ?? 1) / mean : 0;
  return out;
}

// ── Main entry ───────────────────────────────────────────────────────

export interface V3Options {
  mode: V3Mode;
  /** Region key per node (type/status/project/cluster); undefined = unfiled. */
  groupOf?: Array<string | undefined>;
  groups?: V3GroupIn[];
  /** Canvas aspect (w / h) after the camera's foreshortening. */
  aspect?: number;
}

interface UnitDraft {
  key: string;
  regionKey: string;
  type: V3Unit["type"];
  nodeKind?: string;
  members: number[];
  label: string;
  color: string;
  /** Brain: lobe preference order. */
  lobes?: LobeId[];
}

export function layoutV3(nodes: V3NodeIn[], neighbors: number[][], opts: V3Options): V3Layout {
  const n = nodes.length;
  const mode = opts.mode;
  const fam = buildFamilies(nodes, neighbors);
  const degree = neighbors.map((l) => l?.length ?? 0);
  const rank = new Int32Array(n);
  fam.order.forEach((i, k) => (rank[i] = k));

  // 1. Region key per node.
  const regionMeta = new Map<string, { label: string; color: string }>();
  const regionKeyOf: string[] = new Array(n);
  const UNLINKED = "unlinked";
  if (mode === "brain") {
    // Decided per unit below (lobe:side).
  } else if (mode === "orbit") {
    const band = (i: number): string => {
      const root = fam.family[i];
      const nd = nodes[root];
      if (degree[i] === 0 && root === i) return UNLINKED;
      if (nd.kind !== "project") return "open";
      const h = healthOf(nd.meta);
      return h === "done" ? "done" : h === "backlog" ? "backlog" : "open";
    };
    regionMeta.set("open", { label: "Open work", color: "#f5c542" });
    regionMeta.set("backlog", { label: "Backlog", color: "#9ca3af" });
    regionMeta.set("done", { label: "Done", color: "#5eead4" });
    regionMeta.set(UNLINKED, { label: "Unlinked", color: "#8a8474" });
    for (let i = 0; i < n; i++) regionKeyOf[i] = band(i);
  } else {
    for (const g of opts.groups ?? []) regionMeta.set(g.key, { label: g.label, color: g.color });
    regionMeta.set(UNLINKED, { label: "Unlinked", color: "#8a8474" });
    regionMeta.set("unfiled", { label: "Unfiled", color: "#8a8474" });
    for (let i = 0; i < n; i++) {
      const g = opts.groupOf?.[i];
      // Project / cluster groups are defined BY links: an unlinked node has
      // no business in one — it goes to the shared Unlinked region.
      if (degree[i] === 0 && (mode === "project" || mode === "cluster")) regionKeyOf[i] = UNLINKED;
      else regionKeyOf[i] = g != null && regionMeta.has(g) ? g : "unfiled";
    }
    // Project mode: a "group" that is only its own project (no satellites)
    // isn't a zone — those projects share one region instead of 300 moats.
    if (mode === "project") {
      // Sub-projects live in their top-level parent's zone.
      for (let i = 0; i < n; i++) {
        let top = i;
        for (let d = 0; d < 8; d++) {
          const p = nodes[top].parent;
          if (p == null || p < 0 || p >= n || p === top) break;
          top = p;
        }
        if (top !== i && regionKeyOf[top] !== UNLINKED) regionKeyOf[i] = regionKeyOf[top];
      }
      const size = new Map<string, number>();
      for (let i = 0; i < n; i++) size.set(regionKeyOf[i], (size.get(regionKeyOf[i]) ?? 0) + 1);
      regionMeta.set("solo", { label: "Projects without satellites", color: "#c9a227" });
      for (let i = 0; i < n; i++) if (regionKeyOf[i] !== UNLINKED && regionKeyOf[i] !== "unfiled" && size.get(regionKeyOf[i]) === 1) regionKeyOf[i] = "solo";
    }
  }

  // 2. Units.
  const drafts: UnitDraft[] = [];
  const draftByKey = new Map<string, UnitDraft>();
  const addTo = (key: string, mk: () => UnitDraft, i: number) => {
    let d = draftByKey.get(key);
    if (!d) {
      d = mk();
      draftByKey.set(key, d);
      drafts.push(d);
    }
    d.members.push(i);
  };
  const byRank = (a: number, b: number) => rank[a] - rank[b];
  const ordered = [...fam.order];
  if (mode === "brain") {
    for (const i of ordered) {
      if (degree[i] === 0 && fam.family[i] === i) {
        const k = nodes[i].kind;
        const done = k === "project" && healthOf(nodes[i].meta) === "done";
        addTo(`pocket:${k}${done ? ":done" : ""}`, () => ({
          key: `pocket:${k}${done ? ":done" : ""}`,
          regionKey: "",
          type: "pocket",
          nodeKind: k,
          members: [],
          label: `Unlinked ${done ? "done " : ""}${pluralKind(k)}`,
          color: KIND_PALETTE[k as GraphNodeKind] ?? "#9ca3af",
          lobes: done ? DONE_ORDER : (KIND_LOBE_ORDER[k] ?? ["temporal"]),
        }), i);
      } else {
        const root = fam.family[i];
        const rn = nodes[root];
        const done = rn.kind === "project" && healthOf(rn.meta) === "done";
        addTo(`fam:${rn.id}`, () => ({
          key: `fam:${rn.id}`,
          regionKey: "",
          type: "family",
          members: [],
          label: rn.label ?? rn.id,
          color: KIND_PALETTE[rn.kind as GraphNodeKind] ?? "#9ca3af",
          lobes: done ? DONE_ORDER : (KIND_LOBE_ORDER[rn.kind] ?? ["temporal"]),
        }), i);
      }
    }
    // Small families (a hub + one satellite, or a hub alone with a link
    // elsewhere) share one "linked pairs" unit per kind instead of each
    // claiming a moat; pairs stay adjacent (ordered by family).
    for (const d of [...drafts]) {
      if (d.type !== "family" || d.members.length > 2) continue;
      const root = fam.family[d.members[0]];
      const rk = nodes[root].kind;
      const done = rk === "project" && healthOf(nodes[root].meta) === "done";
      const key = `linked:${rk}${done ? ":done" : ""}`;
      let m = draftByKey.get(key);
      if (!m) {
        m = { key, regionKey: "", type: "linked", members: [], label: `Linked ${done ? "done " : ""}${pluralKind(rk)}`, color: KIND_PALETTE[rk as GraphNodeKind] ?? d.color, lobes: d.lobes };
        draftByKey.set(key, m);
        drafts.push(m);
      }
      m.members.push(...d.members);
      d.members = [];
    }
    // Split huge pockets into chunks that can spread across lobes / sides.
    for (const d of [...drafts]) {
      if ((d.type !== "pocket" && d.type !== "linked") || d.members.length <= POCKET_CHUNK) continue;
      const all = d.members;
      const chunks = Math.ceil(all.length / POCKET_CHUNK);
      const size = Math.ceil(all.length / chunks);
      d.members = all.slice(0, size);
      for (let c = 1; c < chunks; c++) {
        const nd: UnitDraft = { ...d, key: `${d.key}#${c}`, members: all.slice(c * size, (c + 1) * size) };
        drafts.push(nd);
        draftByKey.set(nd.key, nd);
      }
    }
  } else {
    for (const i of ordered) {
      const rk = regionKeyOf[i];
      if (degree[i] === 0) {
        const k = nodes[i].kind;
        addTo(`${rk}|pocket:${k}`, () => ({
          key: `${rk}|pocket:${k}`,
          regionKey: rk,
          type: "pocket",
          nodeKind: k,
          members: [],
          label: `Unlinked ${pluralKind(k)}`,
          color: KIND_PALETTE[k as GraphNodeKind] ?? "#9ca3af",
        }), i);
      } else {
        const root = fam.family[i];
        addTo(`${rk}|fam:${nodes[root].id}`, () => ({
          key: `${rk}|fam:${nodes[root].id}`,
          regionKey: rk,
          type: "family",
          members: [],
          label: nodes[root].label ?? nodes[root].id,
          color: KIND_PALETTE[nodes[root].kind as GraphNodeKind] ?? "#9ca3af",
        }), i);
      }
    }
    // Small families (≤ 2 nodes here: a pair, or a node whose family lives in
    // another region) merge into one "linked" unit per region, ordered by
    // family so partners stay side by side.
    const kindsIn = new Map<string, Set<string>>();
    for (let i = 0; i < n; i++) (kindsIn.get(regionKeyOf[i]) ?? kindsIn.set(regionKeyOf[i], new Set()).get(regionKeyOf[i])!).add(nodes[i].kind);
    for (const d of [...drafts]) {
      if (d.type !== "family" || d.members.length > 2) continue;
      const key = `${d.regionKey}|linked`;
      let m = draftByKey.get(key);
      if (!m) {
        const ks = kindsIn.get(d.regionKey);
        const label = ks && ks.size === 1 ? `Linked ${pluralKind([...ks][0])}` : "Linked pairs";
        const kc = ks && ks.size === 1 ? KIND_PALETTE[[...ks][0] as GraphNodeKind] : undefined;
        m = { key, regionKey: d.regionKey, type: "linked", members: [], label, color: kc ?? d.color };
        draftByKey.set(key, m);
        drafts.push(m);
      }
      m.members.push(...d.members);
      d.members = [];
    }
  }
  const live = drafts.filter((d) => d.members.length > 0);
  for (const d of live) {
    if (d.type === "linked") d.members.sort((a, b) => fam.family[a] - fam.family[b] || byRank(a, b));
    else if (d.type === "pocket") d.members.sort((a, b) => {
      const ha = nodes[a].kind === "project" ? healthOf(nodes[a].meta) : "";
      const hb = nodes[b].kind === "project" ? healthOf(nodes[b].meta) : "";
      return ha < hb ? -1 : ha > hb ? 1 : nodes[a].id < nodes[b].id ? -1 : nodes[a].id > nodes[b].id ? 1 : 0;
    });
    else d.members.sort(byRank);
  }

  // 3. Node placement inside each unit (local offsets).
  const brain = mode === "brain";
  const local = new Float32Array(n * 3);
  const unitR = new Float64Array(live.length);
  live.forEach((d, ui) => {
    const radii = d.members.map((i) => nodes[i].r);
    const phase = h01(`ph:${d.key}`) * Math.PI * 2;
    // A family led by a big hub: its members orbit clear of it (links readable).
    const hubGap = d.type !== "pocket" && radii.length > 1 && radii[0] > 1.4 * Math.max(...radii.slice(1)) ? radii[0] * 0.9 : 0;
    if (brain) {
      const { pts, r } = shellPack(radii, NODE_PAD, phase, hubGap);
      d.members.forEach((i, k) => {
        local[i * 3] = pts[k][0];
        local[i * 3 + 1] = pts[k][1];
        local[i * 3 + 2] = pts[k][2];
      });
      unitR[ui] = r;
    } else {
      const { pts, r } = ringPack(radii, NODE_PAD, phase, hubGap);
      // Gentle dome so a unit reads as a 3D cluster (heights never break the
      // X/Z separation, so nodes still never overlap).
      const dome = d.members.length > 2 ? Math.min(30, r * 0.22) * (d.type === "pocket" ? 0.5 : 1) : 0;
      d.members.forEach((i, k) => {
        const [x, z] = pts[k];
        const q = r > 0 ? Math.hypot(x, z) / r : 0;
        local[i * 3] = x;
        local[i * 3 + 1] = dome * (1 - q * q);
        local[i * 3 + 2] = z;
      });
      unitR[ui] = r;
    }
  });

  const target = new Float32Array(n * 3);
  const unitOf = new Int32Array(n).fill(-1);
  const regionOf = new Int32Array(n).fill(-1);
  const units: V3Unit[] = [];
  const regions: V3Region[] = [];
  const orbitRadii: number[] = [];
  let scale = 0;

  const finishUnit = (d: UnitDraft, ui: number, region: number, c: V3) => {
    const id = units.length;
    const rep = d.members[0];
    units.push({
      key: d.key,
      region,
      type: d.type,
      nodeKind: d.nodeKind,
      rep,
      members: d.members,
      c,
      r: unitR[ui],
      label: d.label,
      color: d.color,
      aggregatable: d.members.length >= AGG_MIN,
    });
    for (const i of d.members) {
      unitOf[i] = id;
      regionOf[i] = region;
      target[i * 3] = c[0] + local[i * 3];
      target[i * 3 + 1] = c[1] + local[i * 3 + 1];
      target[i * 3 + 2] = c[2] + local[i * 3 + 2];
    }
    regions[region].units.push(id);
    regions[region].members.push(...d.members);
  };

  if (brain) {
    scale = placeBrain(live, unitR, (d, ui, regionKey, c, lobe, side) => {
      let ri = regions.findIndex((r) => r.key === regionKey);
      if (ri < 0) {
        ri = regions.length;
        regions.push({
          key: regionKey,
          label: `${LOBE_LABEL[lobe]}${side ? ` · ${side < 0 ? "L" : "R"}` : ""}`,
          color: LOBE_COLOR[lobe],
          members: [],
          units: [],
          c: [0, 0, 0],
          r: 0,
          shape: "lobe",
          lobe,
          side,
        });
      }
      finishUnit(d, ui, ri, c);
    });
    // Region centre/radius from its units (labels + framing); every lobe·side exists.
    const have = new Set(regions.map((r) => r.key));
    for (const lobe of LOBE_IDS) {
      for (const side of lobe === "brainstem" ? [0] : [-1, 1]) {
        const key = `${lobe}:${side < 0 ? "L" : side > 0 ? "R" : "M"}`;
        if (have.has(key)) continue;
        regions.push({ key, label: `${LOBE_LABEL[lobe]}${side ? ` · ${side < 0 ? "L" : "R"}` : ""}`, color: LOBE_COLOR[lobe], members: [], units: [], c: [0, 0, 0], r: 0, shape: "lobe", lobe, side: side as -1 | 0 | 1 });
      }
    }
    for (const rg of regions) boundRegion(rg, units);
  } else if (mode === "orbit") {
    placeOrbit(live, unitR, regionMeta, (d, ui, rk, c) => {
      let ri = regions.findIndex((r) => r.key === rk);
      if (ri < 0) {
        ri = regions.length;
        const m = regionMeta.get(rk)!;
        regions.push({ key: rk, label: m.label, color: m.color, members: [], units: [], c: [0, 0, 0], r: 0, shape: rk === "open" ? "disc" : "ring" });
      }
      finishUnit(d, ui, ri, c);
    }, orbitRadii);
    for (const rg of regions) {
      if (rg.shape === "disc") boundRegion(rg, units);
      else {
        let r = 0;
        for (const u of rg.units) r = Math.max(r, Math.hypot(units[u].c[0], units[u].c[2]) + units[u].r);
        rg.r = r;
      }
    }
  } else {
    // Units per region → pack inside the region; regions → pack on the canvas.
    const regionKeys: string[] = [];
    const unitsOfRegion = new Map<string, number[]>();
    live.forEach((d, ui) => {
      if (!unitsOfRegion.has(d.regionKey)) {
        unitsOfRegion.set(d.regionKey, []);
        regionKeys.push(d.regionKey);
      }
      unitsOfRegion.get(d.regionKey)!.push(ui);
    });
    const local2 = new Map<number, [number, number]>();
    const regionR: number[] = [];
    for (const rk of regionKeys) {
      const list = unitsOfRegion.get(rk)!;
      // Pockets keep the full moat from linked units; small clusters a smaller one.
      const radii = list.map((ui) => unitR[ui]);
      const pos = packCircles(radii, list.map((ui) => unitGapFor(live[ui].type, unitR[ui])), 1);
      let R = 0;
      list.forEach((ui, k) => {
        local2.set(ui, pos[k]);
        R = Math.max(R, Math.hypot(pos[k][0], pos[k][1]) + unitR[ui]);
      });
      regionR.push(R + 18);
    }
    const centres = packCircles(regionR, regionR.map(regionGapFor), Math.max(1, Math.min(3, opts.aspect ?? 1.6)));
    regionKeys.forEach((rk, k) => {
      const m = regionMeta.get(rk) ?? { label: rk, color: "#8a8474" };
      // All zones share one base height: a seeded height per zone would shift
      // it in projection and visually eat the gap to its neighbours.
      const base = 0;
      regions.push({ key: rk, label: m.label, color: m.color, members: [], units: [], c: [centres[k][0], base, centres[k][1]], r: regionR[k], shape: "disc" });
    });
    regionKeys.forEach((rk, k) => {
      for (const ui of unitsOfRegion.get(rk)!) {
        const p = local2.get(ui)!;
        finishUnit(live[ui], ui, k, [centres[k][0] + p[0], regions[k].c[1], centres[k][1] + p[1]]);
      }
    });
  }

  // 4. Bundles: links between units of one region → one ribbon per unit
  // pair; links between regions → one ribbon per REGION pair (centre to
  // centre), so a hundred project→client links read as one thick band.
  const bmap = new Map<string, V3Bundle>();
  for (let a = 0; a < n; a++) {
    for (const b of neighbors[a] ?? []) {
      if (b <= a) continue;
      const ua = unitOf[a], ub = unitOf[b];
      if (ua < 0 || ub < 0 || ua === ub) continue;
      const ra = regionOf[a], rb = regionOf[b];
      if (ra === rb) {
        const lo = Math.min(ua, ub), hi = Math.max(ua, ub);
        const key = `u${lo}|${hi}`;
        const cur = bmap.get(key);
        if (cur) cur.count++;
        else bmap.set(key, { a: units[lo].rep, b: units[hi].rep, ua: lo, ub: hi, ra, rb, count: 1 });
      } else {
        const lo = Math.min(ra, rb), hi = Math.max(ra, rb);
        const key = `r${lo}|${hi}`;
        const cur = bmap.get(key);
        if (cur) cur.count++;
        else bmap.set(key, { a: -1, b: -1, ua: -1, ub: -1, ra: lo, rb: hi, count: 1, pa: regions[lo].c, pb: regions[hi].c });
      }
    }
  }
  const bundles = [...bmap.values()].sort((x, y) => y.count - x.count || x.ra - y.ra || x.rb - y.rb || x.ua - y.ua || x.ub - y.ub).slice(0, 600);

  return { mode, scale, target, unitOf, regionOf, family: fam.family, units, regions, bundles, orbitRadii };
}

function boundRegion(rg: V3Region, units: V3Unit[]): void {
  if (!rg.units.length) return;
  let sx = 0, sy = 0, sz = 0, w = 0;
  for (const u of rg.units) {
    const m = units[u].members.length;
    sx += units[u].c[0] * m;
    sy += units[u].c[1] * m;
    sz += units[u].c[2] * m;
    w += m;
  }
  const c: V3 = [sx / w, sy / w, sz / w];
  let r = 0;
  for (const u of rg.units) r = Math.max(r, Math.hypot(units[u].c[0] - c[0], units[u].c[1] - c[1], units[u].c[2] - c[2]) + units[u].r);
  rg.c = c;
  rg.r = r;
}

/** Orbit mode: open work packed in the core, then backlog / done / unlinked bands as rings outward. */
function placeOrbit(
  live: UnitDraft[],
  unitR: Float64Array,
  _meta: Map<string, { label: string; color: string }>,
  put: (d: UnitDraft, ui: number, rk: string, c: V3) => void,
  orbitRadii: number[],
): void {
  const bands = ["open", "backlog", "done", "unlinked"];
  let outer = 0;
  for (const band of bands) {
    const list = live.map((d, ui) => ({ d, ui })).filter((x) => x.d.regionKey === band);
    if (!list.length) continue;
    if (band === "open") {
      const pos = packCircles(list.map((x) => unitR[x.ui]), UNIT_GAP, 1);
      list.forEach((x, k) => {
        put(x.d, x.ui, band, [pos[k][0], 0, pos[k][1]]);
        outer = Math.max(outer, Math.hypot(pos[k][0], pos[k][1]) + unitR[x.ui]);
      });
      continue;
    }
    // Rings: biggest units first, each ring as tight as its circumference allows.
    list.sort((a, b) => unitR[b.ui] - unitR[a.ui] || (a.d.key < b.d.key ? -1 : 1));
    let i = 0;
    let first = true;
    while (i < list.length) {
      const rmax = unitR[list[i].ui];
      const R = outer + (first ? REGION_GAP : UNIT_GAP) + rmax;
      first = false;
      // Fill the ring by arc length (chord ≥ r_a + r_b + gap between neighbours).
      let used = 0;
      const ring: typeof list = [];
      while (i < list.length) {
        const r = unitR[list[i].ui];
        const need = 2 * Math.asin(Math.min(1, (r + UNIT_GAP / 2) / R)) * 2;
        if (ring.length && used + need > Math.PI * 2) break;
        ring.push(list[i]);
        used += need;
        i++;
      }
      // Spread evenly around the ring (keeps the gaps symmetric).
      const slack = (Math.PI * 2 - used) / ring.length;
      let a = h01(`ring:${band}:${R.toFixed(0)}`) * Math.PI * 2;
      for (const x of ring) {
        const r = unitR[x.ui];
        const need = 2 * Math.asin(Math.min(1, (r + UNIT_GAP / 2) / R)) * 2;
        a += need / 2 + slack / 2;
        put(x.d, x.ui, band, [Math.cos(a) * R, 0, Math.sin(a) * R]);
        a += need / 2 + slack / 2;
      }
      orbitRadii.push(R);
      outer = R + rmax;
    }
  }
}

/**
 * Brain mode: units (balls) → lobes with capacity balancing → packed inside
 * the real brain shape (cortex-first) per lobe and hemisphere. Grows the
 * brain scale until everything fits. Returns the scale S.
 */
function placeBrain(
  live: UnitDraft[],
  unitR: Float64Array,
  put: (d: UnitDraft, ui: number, regionKey: string, c: V3, lobe: LobeId, side: -1 | 0 | 1) => void,
): number {
  const { cands, volume } = brainCandidates();
  const lobeVol = new Map<LobeId, number>();
  let cerebralVol = 0;
  for (const [k, v] of volume) {
    const l = k.split(":")[0] as LobeId;
    lobeVol.set(l, (lobeVol.get(l) ?? 0) + v);
    if (l !== "cerebellum" && l !== "brainstem") cerebralVol += v;
  }
  // Load = ball volume (+ gap shell).
  const load = live.map((_, ui) => (unitR[ui] + UNIT_GAP * 0.5) ** 3);
  const total = load.reduce((a, b) => a + b, 0);
  // Initial scale: balls fill ~20 % of the cerebrum (cortex-first packing is loose).
  const cellVol = 0.034 ** 3;
  let S = Math.max(320, Math.cbrt((total * (4 / 3) * Math.PI) / (0.2 * cerebralVol * cellVol)));

  // Lobe per unit: fixed kinds first (cerebellum/brainstem), then by size, spilling by capacity.
  const lobeOf: LobeId[] = new Array(live.length);
  const lobeLoad = new Map<LobeId, number>();
  const cerebralLoad = live.reduce((a, d, ui) => a + ((d.lobes?.[0] === "cerebellum" || d.lobes?.[0] === "brainstem") ? 0 : load[ui]), 0);
  const cap = (l: LobeId) => ((lobeVol.get(l) ?? 0) / cerebralVol) * cerebralLoad * 1.08;
  const orderU = live.map((_, ui) => ui).sort((a, b) => {
    const pa = live[a].lobes?.length === 1 ? 0 : 1, pb = live[b].lobes?.length === 1 ? 0 : 1;
    return pa - pb || load[b] - load[a] || (live[a].key < live[b].key ? -1 : 1);
  });
  for (const ui of orderU) {
    const order = live[ui].lobes ?? ["temporal"];
    let pick: LobeId | null = null;
    if (order.length === 1) pick = order[0];
    else {
      for (const l of order) {
        if ((lobeLoad.get(l) ?? 0) + load[ui] <= cap(l)) {
          pick = l;
          break;
        }
      }
      if (!pick) pick = order.reduce((best, l) => ((lobeLoad.get(l) ?? 0) / cap(l) < (lobeLoad.get(best) ?? 0) / cap(best) ? l : best), order[0]);
    }
    lobeOf[ui] = pick;
    lobeLoad.set(pick, (lobeLoad.get(pick) ?? 0) + load[ui]);
  }
  // Side per unit (balance hemispheres; chunks of one pocket alternate).
  const sideOf: Array<-1 | 0 | 1> = new Array(live.length);
  const sideLoad = new Map<string, number>();
  for (const ui of orderU) {
    const l = lobeOf[ui];
    if (l === "brainstem") {
      sideOf[ui] = 0;
      continue;
    }
    const L = sideLoad.get(`${l}:-1`) ?? 0, R = sideLoad.get(`${l}:1`) ?? 0;
    const s: -1 | 1 = L < R || (L === R && h01(`side:${live[ui].key}`) < 0.5) ? -1 : 1;
    sideOf[ui] = s;
    sideLoad.set(`${l}:${s}`, (s < 0 ? L : R) + load[ui]);
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const placed: Array<{ ui: number; c: V3 }> = [];
    // Spatial hash of placed balls. Integer cell keys (cell indices stay far
    // inside ±512 at any brain scale) — string keys here dominated layout time.
    const grid = new Map<number, number[]>();
    const cell = 160;
    const ckey = (cx: number, cy: number, cz: number) => ((cx + 512) * 1024 + (cy + 512)) * 1024 + (cz + 512);
    const gkey = (x: number, y: number, z: number) => ckey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
    const balls: Array<[number, number, number, number, number]> = [];
    let maxR = 0;
    const clear = (x: number, y: number, z: number, r: number, g: number): boolean => {
      const span = Math.ceil((r + maxR + UNIT_GAP) / cell);
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      for (let i = -span; i <= span; i++)
        for (let j = -span; j <= span; j++)
          for (let k = -span; k <= span; k++) {
            const list = grid.get(ckey(cx + i, cy + j, cz + k));
            if (!list) continue;
            for (const id of list) {
              const b = balls[id];
              const dx = b[0] - x, dy = b[1] - y, dz = b[2] - z;
              const lim = b[3] + r + Math.max(g, b[4]);
              if (dx * dx + dy * dy + dz * dz < lim * lim) return false;
            }
          }
      return true;
    };
    let ok = true;
    const byRegion = new Map<string, number[]>();
    for (const ui of orderU) {
      const k = `${lobeOf[ui]}:${sideOf[ui]}`;
      (byRegion.get(k) ?? byRegion.set(k, []).get(k)!).push(ui);
    }
    const prevChunk = new Map<string, V3>();
    outer: for (const [rk, list] of byRegion) {
      const [lobe, sideS] = rk.split(":");
      const side = Number(sideS) as -1 | 0 | 1;
      const pool = cands.filter((c) => c.lobe === lobe && (side === 0 || c.side === side));
      // Candidates swallowed by a placed ball are dead for every later ball.
      const dead = new Uint8Array(pool.length);
      const pcell = 0.08;
      const pgrid = new Map<number, number[]>();
      const pk = (x: number, y: number, z: number) => Math.floor(x / pcell) * 73856093 + Math.floor(y / pcell) * 19349663 + Math.floor(z / pcell) * 83492791;
      pool.forEach((c, ci) => {
        const k = pk(c.p[0], c.p[1], c.p[2]);
        (pgrid.get(k) ?? pgrid.set(k, []).get(k)!).push(ci);
      });
      const kill = (p: V3, rad: number) => {
        const span = Math.ceil(rad / pcell);
        const cx = Math.floor(p[0] / pcell), cy = Math.floor(p[1] / pcell), cz = Math.floor(p[2] / pcell);
        for (let i = -span; i <= span; i++)
          for (let j = -span; j <= span; j++)
            for (let k = -span; k <= span; k++) {
              const list = pgrid.get((cx + i) * 73856093 + (cy + j) * 19349663 + (cz + k) * 83492791);
              if (!list) continue;
              for (const ci of list) {
                const q = pool[ci].p;
                const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
                if (dx * dx + dy * dy + dz * dz < rad * rad) dead[ci] = 1;
              }
            }
      };
      list.sort((a, b) => unitR[b] - unitR[a] || (live[a].key < live[b].key ? -1 : 1));
      for (const ui of list) {
        const r = unitR[ui];
        const gapU = unitGapFor(live[ui].type, r);
        const ru = (r + NODE_PAD) / S; // unit-space radius
        const base = live[ui].key.split("#")[0];
        const near = prevChunk.get(base);
        let best: V3 | null = null;
        let bestScore = Infinity;
        let feasible = 0;
        // Cortex first: candidates are sorted by depth; skip those too shallow for this ball.
        let lo = 0, hi = pool.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (pool[m].depth < ru) lo = m + 1;
          else hi = m;
        }
        for (let ci = lo; ci < pool.length; ci++) {
          if (dead[ci]) continue;
          const cd = pool[ci];
          const p = cd.p;
          if (side !== 0 && Math.abs(p[0]) < FISSURE + ru) continue;
          const wx = p[0] * S, wy = p[1] * S, wz = p[2] * S;
          if (!clear(wx, wy, wz, r, gapU)) continue;
          let inLobe = 0, inside = true;
          for (const s of BALL_SAMPLES) {
            const qx = p[0] + s[0] * ru * 1.1, qy = p[1] + s[1] * ru * 1.1, qz = p[2] + s[2] * ru * 1.1;
            if (brainSdf(qx, qy, qz) > -0.004) {
              inside = false;
              break;
            }
            if (lobeAt(qx, qy, qz) === lobe) inLobe++;
            if (side !== 0 && (qx < 0 ? -1 : 1) !== side) {
              inside = false;
              break;
            }
          }
          if (!inside || inLobe < BALL_SAMPLES.length - 4) continue;
          const score = cd.depth + (near ? Math.hypot(p[0] - near[0], p[1] - near[1], p[2] - near[2]) * 0.6 : 0) + h01(`j:${live[ui].key}:${ci}`) * 0.01;
          if (score < bestScore) {
            bestScore = score;
            best = p;
          }
          if (++feasible >= (near ? 40 : 6)) break;
        }
        if (!best) {
          ok = false;
          break outer;
        }
        const c: V3 = [best[0] * S, best[1] * S, best[2] * S];
        const id = balls.push([c[0], c[1], c[2], r, gapU]) - 1;
        maxR = Math.max(maxR, r);
        const gk = gkey(c[0], c[1], c[2]);
        (grid.get(gk) ?? grid.set(gk, []).get(gk)!).push(id);
        placed.push({ ui, c });
        prevChunk.set(base, best);
        kill(best, (r + gapU) / S);
      }
    }
    if (ok) {
      for (const { ui, c } of placed) {
        const lobe = lobeOf[ui];
        const side = sideOf[ui];
        put(live[ui], ui, `${lobe}:${side < 0 ? "L" : side > 0 ? "R" : "M"}`, c, lobe, side);
      }
      return S;
    }
    S *= 1.12;
  }
  // Could not fit (pathological): place at lobe centroids, scaled huge.
  for (const ui of orderU) put(live[ui], ui, `${lobeOf[ui]}:M`, [0, 0, 0], lobeOf[ui], 0);
  return S;
}

// ── Metrics (tests + harness) ────────────────────────────────────────

/** Smallest (distance − r_a − r_b) over all node pairs (grid accelerated). */
export function minNodeGap(target: Float32Array, radii: number[]): number {
  const n = radii.length;
  let maxR = 0;
  for (const r of radii) maxR = Math.max(maxR, r);
  const cell = Math.max(8, maxR * 4);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(target[i * 3] / cell)},${Math.floor(target[i * 3 + 1] / cell)},${Math.floor(target[i * 3 + 2] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(target[i * 3] / cell), cy = Math.floor(target[i * 3 + 1] / cell), cz = Math.floor(target[i * 3 + 2] / cell);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let c = -1; c <= 1; c++) {
          for (const j of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
            if (j <= i) continue;
            const d = Math.hypot(target[i * 3] - target[j * 3], target[i * 3 + 1] - target[j * 3 + 1], target[i * 3 + 2] - target[j * 3 + 2]);
            best = Math.min(best, d - radii[i] - radii[j]);
          }
        }
  }
  return best;
}

/** Smallest gap between two different regions' discs (X/Z plane), non-brain modes. */
export function minRegionGap(layout: V3Layout): number {
  let best = Infinity;
  const rs = layout.regions.filter((r) => r.shape === "disc" && r.members.length);
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const d = Math.hypot(rs[i].c[0] - rs[j].c[0], rs[i].c[2] - rs[j].c[2]) - rs[i].r - rs[j].r;
      best = Math.min(best, d);
    }
  return best;
}

/** Smallest gap between two units (3D distance between their balls/discs). */
export function minUnitGap(layout: V3Layout, filter?: (a: V3Unit, b: V3Unit) => boolean): number {
  let best = Infinity;
  const us = layout.units;
  for (let i = 0; i < us.length; i++)
    for (let j = i + 1; j < us.length; j++) {
      if (filter && !filter(us[i], us[j])) continue;
      const a = us[i], b = us[j];
      const d = layout.mode === "brain"
        ? Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2])
        : Math.hypot(a.c[0] - b.c[0], a.c[2] - b.c[2]);
      best = Math.min(best, d - a.r - b.r);
    }
  return best;
}

/** Share of unlinked nodes sitting in a pocket made only of unlinked nodes of their own kind. */
export function unlinkedPurity(layout: V3Layout, nodes: V3NodeIn[], neighbors: number[][]): number {
  let total = 0, good = 0;
  for (let i = 0; i < nodes.length; i++) {
    if ((neighbors[i]?.length ?? 0) > 0) continue;
    total++;
    const u = layout.units[layout.unitOf[i]];
    if (u?.type === "pocket" && u.members.every((m) => nodes[m].kind === nodes[i].kind && (neighbors[m]?.length ?? 0) === 0)) good++;
  }
  return total ? good / total : 1;
}

export type { ProjectHealth };
