/**
 * Knowledge graph — true 3D "galaxy" layout.
 *
 * d3-force only integrates x/y, so the third axis is added here as plain
 * custom forces on the same simulation:
 *
 *   • `link3d`   — a 3D spring (replaces forceLink): link length is measured
 *                   in x/y/z, so satellites sit on a SHELL around their hub
 *                   instead of a flat ring.
 *   • `zPlan`    — each node is pulled toward a seeded height. Hubs (projects,
 *                   clients, strays) get an absolute galaxy height (spherical
 *                   shells per status orbit: |z| up to ~0.7 R); satellites get
 *                   an offset relative to their hub that is never ~0, so no
 *                   child ever shares its hub's plane.
 *   • `zIntegrate` — velocity decay + position step for z (runs last, the
 *                   same way d3 steps x/y after all forces).
 *
 * Axes: layout x → world X, layout y → world Z, layout z → world Y (height).
 * Everything is deterministic per node id (no Math.random), so refreshes and
 * reloads reproduce the same galaxy.
 */

import {
  forceCenter,
  forceCollide,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";

/** Deterministic 0..1 hash of a string (FNV-1a + murmur3 finaliser, so ids
 * that differ only in the last character still land far apart). */
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
const signedHash = (id: string, salt: string): number => h01(`${salt}:${id}`) * 2 - 1;

/** Per-node height plan handed to the layout. */
export interface ZPlan {
  /** Absolute target height (used when `parent` < 0). */
  gz: number;
  /** Index of the hub this node orbits in 3D (-1 = absolute target). */
  parent: number;
  /** Height offset from the parent (|zOff| ≥ MIN_CHILD_OFFSET). */
  zOff: number;
  /** Pull strength toward the target height. */
  zs: number;
  /** Horizontal (x/y) orbit radius after tilting the node onto its shell. */
  orbitXY?: number;
}

export const MIN_CHILD_OFFSET = 14;
/** Max |sin(elevation)| of a hub on its status shell. */
const SHELL_TILT = 0.72;

export interface GalaxyNodeIn {
  id: string;
  kind: string;
  anchor: boolean;
  orbit?: number;
  group?: string;
}

/**
 * Seeded galaxy heights. `neighbors[i]` lists node indices linked to i.
 * `scale` ≈ galaxy radius in layout px (heights for orbit-less hubs).
 * `groupZ` gives sector-grouped layouts a height per group.
 */
export function planGalaxy(
  nodes: GalaxyNodeIn[],
  neighbors: number[][],
  opts: { scale: number; groupZ?: Map<string, number> },
): ZPlan[] {
  const n = nodes.length;
  const plans: ZPlan[] = new Array(n);
  const scale = Math.max(120, opts.scale);
  const isHub = (i: number) => nodes[i].anchor || (neighbors[i]?.length ?? 0) === 0;

  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    if (!isHub(i)) continue;
    const s = signedHash(nd.id, "elev");
    const gz0 = nd.group != null ? opts.groupZ?.get(nd.group) : undefined;
    if (nd.orbit != null && nd.orbit > 0 && gz0 == null) {
      // Spherical status shell: lift the hub off the equator and pull it in
      // horizontally by cos(elevation), so the shell keeps radius R.
      const sinE = s * SHELL_TILT;
      plans[i] = {
        gz: nd.orbit * sinE,
        parent: -1,
        zOff: 0,
        zs: nd.kind === "project" ? 0.08 : 0.05,
        orbitXY: nd.orbit * Math.sqrt(1 - sinE * sinE),
      };
    } else {
      plans[i] = {
        gz: (gz0 ?? 0) + s * scale * (gz0 != null ? 0.22 : 0.45),
        parent: -1,
        zOff: 0,
        zs: 0.06,
        orbitXY: nd.orbit,
      };
    }
  }

  // Satellites: BFS outward from the hubs so each one orbits the nearest
  // already-placed node (anchors first, then satellite chains).
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (plans[i]) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const p = queue[q];
    for (const c of neighbors[p] ?? []) {
      if (plans[c]) continue;
      const s = signedHash(nodes[c].id, "zoff");
      const mag = MIN_CHILD_OFFSET + Math.abs(s) * 34 + h01(`zmag:${nodes[c].id}`) * 10;
      plans[c] = {
        gz: 0,
        parent: p,
        zOff: (s < 0 ? -1 : 1) * mag,
        zs: 0.18,
        orbitXY: nodes[c].orbit,
      };
      queue.push(c);
    }
  }
  // Anything left (isolated cycles without a hub) gets an absolute height.
  for (let i = 0; i < n; i++) {
    if (plans[i]) continue;
    plans[i] = { gz: signedHash(nodes[i].id, "elev") * scale * 0.4, parent: -1, zOff: 0, zs: 0.05, orbitXY: nodes[i].orbit };
  }
  return plans;
}

/** Height every node should start at (parents resolved in plan order). */
export function seedHeights(plans: ZPlan[], existing: Array<number | undefined> = []): number[] {
  const z = new Array<number>(plans.length);
  const done = new Uint8Array(plans.length);
  const resolve = (i: number, depth = 0): number => {
    if (done[i]) return z[i];
    const ex = existing[i];
    const p = plans[i];
    let v: number;
    if (ex != null && Number.isFinite(ex)) v = ex;
    else if (p.parent >= 0 && depth < 64) v = resolve(p.parent, depth + 1) + p.zOff;
    else v = p.gz;
    z[i] = v;
    done[i] = 1;
    return v;
  };
  for (let i = 0; i < plans.length; i++) resolve(i);
  return z;
}

/** Sector-grouped layouts: one height per group key (stable per key). */
export function groupHeights(keys: Iterable<string>, ring: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, signedHash(k, "gz") * Math.max(140, ring) * 0.55);
  return out;
}

// ── Simulation ───────────────────────────────────────────────────────

export type GNode = SimulationNodeDatum & {
  index: number;
  r: number;
  z: number;
  vz: number;
  fz?: number | null;
  orbit?: number;
  orbitStrength: number;
  charge: number;
  gx: number;
  gy: number;
  gs: number;
  plan: ZPlan;
  /** Hemisphere side for the fissure constraint (−1, +1; 0/undefined = free). */
  side?: number;
};

export interface GLink {
  source: number;
  target: number;
  distance: number;
  strength: number;
}

/** How much of a link's pull acts on height. Lower than 1 so the seeded
 * height plan (not the 2D charge that inflates x/y distances) decides the
 * vertical arrangement, while links still drag connected hubs together. */
const LINK_Z_COUPLING = 0.3;

/** d3 forceLink, extended to x/y/z (same bias + jitter semantics). */
export function link3dForce(links: GLink[]) {
  let nodes: GNode[] = [];
  let bias: Float32Array = new Float32Array(0);
  const force = (alpha: number) => {
    for (let k = 0; k < links.length; k++) {
      const l = links[k];
      const s = nodes[l.source];
      const t = nodes[l.target];
      if (!s || !t) continue;
      let x = t.x! + t.vx! - s.x! - s.vx! || 1e-6 * (k % 7 + 1);
      let y = t.y! + t.vy! - s.y! - s.vy! || 1e-6 * (k % 5 + 1);
      let z = t.z + t.vz - s.z - s.vz || 1e-6 * (k % 3 + 1);
      let d = Math.sqrt(x * x + y * y + z * z);
      d = ((d - l.distance) / d) * alpha * l.strength;
      x *= d;
      y *= d;
      z *= d * LINK_Z_COUPLING;
      const b = bias[k];
      t.vx! -= x * b;
      t.vy! -= y * b;
      t.vz -= z * b;
      s.vx! += x * (1 - b);
      s.vy! += y * (1 - b);
      s.vz += z * (1 - b);
    }
  };
  force.initialize = (ns: GNode[]) => {
    nodes = ns;
    const count = new Uint32Array(ns.length);
    for (const l of links) {
      count[l.source]++;
      count[l.target]++;
    }
    bias = new Float32Array(links.length);
    links.forEach((l, k) => {
      bias[k] = count[l.source] / (count[l.source] + count[l.target] || 1);
    });
  };
  return force;
}

/** Height pull toward the plan (hub-relative for satellites). */
export function zPlanForce() {
  let nodes: GNode[] = [];
  const force = (alpha: number) => {
    for (const n of nodes) {
      const p = n.plan;
      const target = p.parent >= 0 ? nodes[p.parent].z + p.zOff : p.gz;
      n.vz += (target - n.z) * p.zs * alpha;
    }
  };
  force.initialize = (ns: GNode[]) => {
    nodes = ns;
  };
  return force;
}

/** Steps z with the simulation's velocity decay (register LAST). */
export function zIntegrateForce(velocityDecay: number) {
  let nodes: GNode[] = [];
  const keep = 1 - velocityDecay;
  const force = () => {
    for (const n of nodes) {
      if (n.fz != null) {
        n.z = n.fz;
        n.vz = 0;
      } else {
        n.vz *= keep;
        n.z += n.vz;
      }
    }
  };
  force.initialize = (ns: GNode[]) => {
    nodes = ns;
  };
  return force;
}

export interface LayoutNodeIn {
  r: number;
  x?: number;
  y?: number;
  z?: number;
  orbit?: number;
  orbitStrength?: number;
  charge?: number;
  pinned?: boolean;
  gx?: number;
  gy?: number;
  gs?: number;
  plan?: ZPlan;
  side?: number;
}

export interface LayoutLinkIn {
  source: number;
  target: number;
  distance?: number;
  strength?: number;
}

export const VELOCITY_DECAY = 0.5;

export interface LayoutOptions {
  /** forceCenter strength (0 = off, e.g. when every node has its own target). */
  centerStrength?: number;
  /** Many-body cut-off distance (short = local de-overlap only). */
  chargeRange?: number;
  /** Keep sided nodes (LayoutNodeIn.side ±1) at least `gap` from x = `x` (a brain's fissure). */
  fissure?: { x: number; gap: number };
  /** 2D collision (off for true-3D volume layouts where nodes are apart in height). */
  collide?: boolean;
  /** When the simulation settles, snap every target-pulled node exactly onto its target. */
  snap?: boolean;
}

/** Put target-pulled nodes exactly on their targets (gx/gy + absolute height plan). */
export function snapToTargets(nodes: GNode[]): void {
  for (const n of nodes) {
    if (n.fx != null || n.gs <= 0) continue;
    n.x = n.gx;
    n.y = n.gy;
    n.vx = 0;
    n.vy = 0;
    if (n.plan.parent < 0) {
      n.z = n.plan.gz;
      n.vz = 0;
    }
  }
}

/** Velocity clamp so sided nodes never cross into the fissure (register after x/y forces). */
export function fissureForce(x0: number, gap: number) {
  let nodes: GNode[] = [];
  const force = () => {
    for (const n of nodes) {
      const s = n.side;
      if (!s || n.fx != null) continue;
      const next = n.x! + n.vx! * (1 - VELOCITY_DECAY);
      if ((next - x0) * s < gap) n.vx = (x0 + s * gap - n.x!) / (1 - VELOCITY_DECAY);
    }
  };
  force.initialize = (ns: GNode[]) => {
    nodes = ns;
  };
  return force;
}

/** Build the 3D galaxy simulation (worker + tests share this). */
export function createGalaxyLayout(
  raw: LayoutNodeIn[],
  rawLinks: LayoutLinkIn[],
  w: number,
  h: number,
  alpha = 1,
  opts: LayoutOptions = {},
): { sim: Simulation<GNode, undefined>; nodes: GNode[] } {
  const seeded = seedHeights(
    raw.map((n) => n.plan ?? { gz: 0, parent: -1, zOff: 0, zs: 0 }),
    raw.map((n) => n.z),
  );
  const nodes: GNode[] = raw.map((n, index) => {
    const pinned = n.pinned === true && n.x != null && n.y != null;
    const plan = n.plan ?? { gz: seeded[index], parent: -1, zOff: 0, zs: 0 };
    const orbit = plan.orbitXY ?? n.orbit;
    return {
      index,
      r: n.r,
      x: n.x,
      y: n.y,
      z: seeded[index],
      vz: 0,
      fx: pinned ? n.x : undefined,
      fy: pinned ? n.y : undefined,
      fz: pinned ? seeded[index] : undefined,
      orbit,
      orbitStrength: orbit != null ? (n.orbitStrength ?? 0.08) : 0,
      charge: n.charge ?? -120,
      gx: n.gx ?? 0,
      gy: n.gy ?? 0,
      gs: n.gx != null && n.gy != null ? (n.gs ?? 0.12) : 0,
      plan,
      side: n.side,
    };
  });
  const links: GLink[] = rawLinks
    .filter((l) => l.source < nodes.length && l.target < nodes.length)
    .map((l) => {
      // A satellite's planned height offset is part of its rest length, so the
      // 3D spring doesn't flatten the cloud back onto the hub's plane.
      const d = l.distance ?? 60;
      const ps = nodes[l.source].plan;
      const pt = nodes[l.target].plan;
      const off = pt.parent === l.source ? pt.zOff : ps.parent === l.target ? ps.zOff : 0;
      return { source: l.source, target: l.target, distance: Math.hypot(d, off), strength: l.strength ?? 0.25 };
    });
  const hasOrbits = nodes.some((n) => n.orbit != null);
  const hasGroups = nodes.some((n) => n.gs > 0);
  const sim = forceSimulation<GNode>(nodes)
    .force("link", link3dForce(links))
    .force("charge", forceManyBody<GNode>().strength((d) => d.charge).distanceMax(opts.chargeRange ?? 380).theta(0.9))
    .force("center", (opts.centerStrength ?? 0.05) > 0 ? forceCenter(w / 2, h / 2).strength(opts.centerStrength ?? 0.05) : null)
    .force("collide", opts.collide === false ? null : forceCollide<GNode>((d) => d.r + 2))
    .force("orbit", hasOrbits ? orbitForce(w, h) : null)
    .force("groupX", hasGroups ? forceX<GNode>((d) => d.gx).strength((d) => d.gs) : null)
    .force("groupY", hasGroups ? forceY<GNode>((d) => d.gy).strength((d) => d.gs) : null)
    .force("fissure", opts.fissure ? fissureForce(opts.fissure.x, opts.fissure.gap) : null)
    .force("zPlan", zPlanForce())
    .force("zIntegrate", zIntegrateForce(VELOCITY_DECAY))
    .velocityDecay(VELOCITY_DECAY)
    .alphaDecay(0.04)
    .alpha(alpha);
  return { sim, nodes };
}

export function orbitForce(w: number, h: number) {
  return forceRadial<GNode>((d) => d.orbit ?? 0, w / 2, h / 2).strength((d) => d.orbitStrength);
}

/** Height spread vs horizontal spread (both as per-axis standard deviations). */
export function spreadMetrics(pts: Array<{ x?: number; y?: number; z?: number }>): {
  heightStd: number;
  horizontalStd: number;
  ratio: number;
} {
  const n = pts.length;
  if (!n) return { heightStd: 0, horizontalStd: 0, ratio: 0 };
  let mx = 0, my = 0, mz = 0;
  for (const p of pts) {
    mx += p.x ?? 0;
    my += p.y ?? 0;
    mz += p.z ?? 0;
  }
  mx /= n;
  my /= n;
  mz /= n;
  let vx = 0, vy = 0, vz = 0;
  for (const p of pts) {
    vx += ((p.x ?? 0) - mx) ** 2;
    vy += ((p.y ?? 0) - my) ** 2;
    vz += ((p.z ?? 0) - mz) ** 2;
  }
  const heightStd = Math.sqrt(vz / n);
  const horizontalStd = Math.sqrt((vx + vy) / (2 * n));
  return { heightStd, horizontalStd, ratio: horizontalStd > 0 ? heightStd / horizontalStd : 0 };
}
