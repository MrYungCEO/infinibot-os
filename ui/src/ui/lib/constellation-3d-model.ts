/**
 * Pure (DOM/WebGL-free) model for the 3D agents constellation.
 *
 * Everything the three.js engine needs that can be unit-tested lives here:
 * the deterministic cluster layout lifted into 3D, curved beam geometry,
 * team palette assignment, focus/dim sets, label LOD and the quality caps
 * per device class. The renderer (agents-constellation-3d.ts) stays a thin
 * GPU layer over this.
 */

export type Vec3 = [number, number, number];

export interface LayoutInputNode {
  id: string;
  cluster: string;
  clusterLabel: string;
  /** 0..1 activity → radius. */
  size: number;
}

export interface LayoutNode3D {
  id: string;
  x: number;
  y: number;
  z: number;
  r: number;
  cluster: string;
}

export interface LayoutCluster3D {
  key: string;
  label: string;
  x: number;
  y: number;
  z: number;
  r: number;
  count: number;
  /** Unit normal of the cluster's disc (slightly tilted off +Y). */
  normal: Vec3;
  /** Palette slot (deterministic by layout order). */
  paletteIndex: number;
}

export interface Layout3D {
  nodes: Map<string, LayoutNode3D>;
  clusters: LayoutCluster3D[];
  center: Vec3;
  /** Bounding-sphere radius of all clusters (incl. their discs) — grid / minimap extent. */
  radius: number;
  /** Tight bounds of the agents themselves (what "frame all" fits). */
  frame: { center: Vec3; radius: number };
}

export const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** World units between neighbouring nodes inside a cluster. */
export const NODE_SPACING = 58;

export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

/** Radius in world units for an activity score (matches the 2D engine). */
export function nodeRadius(size: number): number {
  return 14 + clamp(size, 0, 1) * 17;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Orthonormal basis (u, v) spanning the plane perpendicular to `n`. */
export function discBasis(n: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(ref, n));
  const v = normalize(cross(n, u));
  return [u, v];
}

/**
 * Deterministic layout: clusters are packed on a spiral in the XZ plane
 * (largest first), each cluster is a slightly tilted disc floating at its own
 * height, nodes sit on a golden-angle sunflower inside the disc. Same roster
 * → same positions, so polling never reshuffles the scene.
 */
export function layout3D(input: LayoutInputNode[]): Layout3D {
  const byCluster = new Map<string, LayoutInputNode[]>();
  for (const n of input) {
    const arr = byCluster.get(n.cluster) ?? [];
    arr.push(n);
    byCluster.set(n.cluster, arr);
  }
  const groups = [...byCluster.entries()]
    .map(([key, list]) => ({
      key,
      label: list[0].clusterLabel,
      list: list.slice().sort((a, b) => b.size - a.size || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.list.length - a.list.length || a.key.localeCompare(b.key));

  const clusters: LayoutCluster3D[] = [];
  const nodes = new Map<string, LayoutNode3D>();
  groups.forEach((g, gi) => {
    const n = g.list.length;
    const r = Math.max(64, NODE_SPACING * Math.sqrt(n) + 44);
    let x = 0;
    let z = 0;
    if (clusters.length > 0) {
      let found = false;
      for (let step = 0; step < 4000 && !found; step++) {
        const a = step * 0.35;
        const d = 18 + step * 3.2;
        x = Math.cos(a) * d * 1.25;
        z = Math.sin(a) * d * 0.8;
        found = clusters.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + r + 56);
      }
    }
    const h = hash01(g.key);
    const h2 = hash01(`${g.key}/y`);
    // Floating height: the biggest cluster sits on the reference plane, the
    // rest drift ±60 so the scene reads as volume rather than a flat map.
    const y = gi === 0 ? 0 : (h2 - 0.5) * 120;
    const tilt = 0.12 + h * 0.16;
    const az = h2 * TAU;
    const normal = normalize([Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az)]);
    const [u, v] = discBasis(normal);
    clusters.push({ key: g.key, label: g.label, x, y, z, r, count: n, normal, paletteIndex: gi });
    g.list.forEach((node, i) => {
      const rad = n === 1 ? 0 : NODE_SPACING * 0.92 * Math.sqrt(i + 0.35);
      const ang = i * GOLDEN + h * TAU;
      const px = Math.cos(ang) * rad;
      const pz = Math.sin(ang) * rad;
      const lift = (hash01(`${node.id}/lift`) - 0.5) * 18;
      nodes.set(node.id, {
        id: node.id,
        x: x + u[0] * px + v[0] * pz + normal[0] * lift,
        y: y + u[1] * px + v[1] * pz + normal[1] * lift,
        z: z + u[2] * px + v[2] * pz + normal[2] * lift,
        r: nodeRadius(node.size),
        cluster: g.key,
      });
    });
  });

  if (!clusters.length) return { nodes, clusters, center: [0, 0, 0], radius: 200, frame: { center: [0, 0, 0], radius: 120 } };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const c of clusters) {
    minX = Math.min(minX, c.x - c.r);
    maxX = Math.max(maxX, c.x + c.r);
    minZ = Math.min(minZ, c.z - c.r);
    maxZ = Math.max(maxZ, c.z + c.r);
    minY = Math.min(minY, c.y - c.r * 0.35);
    maxY = Math.max(maxY, c.y + c.r * 0.35);
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let radius = 0;
  for (const c of clusters) {
    radius = Math.max(radius, Math.hypot(c.x - center[0], c.y - center[1], c.z - center[2]) + c.r);
  }
  // Tight frame: the agents' own extent (cluster packing radii are much larger than small clusters).
  let nMinX = Infinity, nMinY = Infinity, nMinZ = Infinity, nMaxX = -Infinity, nMaxY = -Infinity, nMaxZ = -Infinity;
  for (const n of nodes.values()) {
    nMinX = Math.min(nMinX, n.x - n.r); nMaxX = Math.max(nMaxX, n.x + n.r);
    nMinY = Math.min(nMinY, n.y - n.r); nMaxY = Math.max(nMaxY, n.y + n.r);
    nMinZ = Math.min(nMinZ, n.z - n.r); nMaxZ = Math.max(nMaxZ, n.z + n.r);
  }
  const fc: Vec3 = [(nMinX + nMaxX) / 2, (nMinY + nMaxY) / 2, (nMinZ + nMaxZ) / 2];
  let fr = 0;
  for (const n of nodes.values()) fr = Math.max(fr, Math.hypot(n.x - fc[0], n.y - fc[1], n.z - fc[2]) + n.r);
  return { nodes, clusters, center, radius: Math.max(radius, 120), frame: { center: fc, radius: Math.max(fr + 40, 120) } };
}

// ─── Beams ──────────────────────────────────────────────────────────────

/**
 * Control point of the curved beam a→b: bowed sideways (so parallel links
 * don't overlap) and lifted so beams arc above the cluster discs.
 */
export function beamControl(a: Vec3, b: Vec3): Vec3 {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, b[1] - a[1], dz);
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const mz = (a[2] + b[2]) / 2;
  return [mx - dz * 0.16, my + len * 0.12 + 8, mz + dx * 0.16];
}

export function bezierPoint(a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 {
  const u = 1 - t;
  const w0 = u * u;
  const w1 = 2 * u * t;
  const w2 = t * t;
  return [
    w0 * a[0] + w1 * c[0] + w2 * b[0],
    w0 * a[1] + w1 * c[1] + w2 * b[1],
    w0 * a[2] + w1 * c[2] + w2 * b[2],
  ];
}

/** Sampled beam as `segments + 1` points. */
export function beamPoints(a: Vec3, b: Vec3, segments = 20): Vec3[] {
  const c = beamControl(a, b);
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) out.push(bezierPoint(a, c, b, i / segments));
  return out;
}

// ─── Palette ────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

/**
 * Team/role palette — jewel tones that read as one universe next to the gold
 * theme accent. Clusters claim a slot in layout order (deterministic).
 */
export const TEAM_PALETTE: RGB[] = [
  [96, 195, 255], // ice cyan
  [244, 114, 182], // rose
  [167, 139, 250], // violet
  [52, 211, 153], // emerald
  [251, 191, 36], // amber
  [125, 211, 252], // sky
  [45, 212, 191], // teal
  [251, 146, 60], // coral
];

export function teamColor(paletteIndex: number): RGB {
  return TEAM_PALETTE[((paletteIndex % TEAM_PALETTE.length) + TEAM_PALETTE.length) % TEAM_PALETTE.length];
}

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, sat, l];
}

export function hslToRgb([h, sat, l]: [number, number, number]): RGB {
  h = ((h % 1) + 1) % 1;
  if (sat === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/**
 * Team tints that stay inside the theme's accent family: lightness / warmth
 * steps of `--g-primary` (gold → amber → champagne → ivory → honey → bronze…)
 * rather than distinct hues. Follows whatever accent the active branding sets.
 */
export const TEAM_STEPS: Array<{ dh: number; ds: number; dl: number }> = [
  { dh: 0, ds: 0, dl: 0 }, // gold — the accent itself
  { dh: -0.02, ds: 0.02, dl: -0.08 }, // amber — warmer, deeper
  { dh: 0.015, ds: -0.3, dl: 0.14 }, // champagne — lighter, softer
  { dh: 0.02, ds: -0.55, dl: 0.26 }, // ivory — near-white warm
  { dh: 0.01, ds: -0.12, dl: 0.06 }, // honey
  { dh: -0.035, ds: -0.1, dl: -0.16 }, // bronze
  { dh: 0.03, ds: -0.4, dl: 0.18 }, // pale gold
  { dh: -0.01, ds: -0.2, dl: -0.03 }, // old gold
];

export function teamTint(primary: RGB, paletteIndex: number): RGB {
  const step = TEAM_STEPS[((paletteIndex % TEAM_STEPS.length) + TEAM_STEPS.length) % TEAM_STEPS.length];
  const [h, sat, l] = rgbToHsl(primary);
  return hslToRgb([h + step.dh, clamp(sat + step.ds, 0.08, 1), clamp(l + step.dl, 0.3, 0.92)]);
}

/** Lighten toward white (t = 0..1). */
export function lighten(c: RGB, t: number): RGB {
  return [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t];
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ─── Focus / dim ────────────────────────────────────────────────────────

export interface EdgeLike {
  from: string;
  to: string;
}

/** The focused agent plus everything it is linked to; null when nothing is focused. */
export function focusSet(focusId: string | null, edges: EdgeLike[]): Set<string> | null {
  if (!focusId) return null;
  const s = new Set<string>([focusId]);
  for (const e of edges) {
    if (e.from === focusId) s.add(e.to);
    if (e.to === focusId) s.add(e.from);
  }
  return s;
}

export function isEdgeHot(e: EdgeLike, focusId: string | null): boolean {
  return !!focusId && (e.from === focusId || e.to === focusId);
}

/** Visibility weight 0..1 of a node given filters (dimSet) and hover/selection focus. */
export function nodeVisibility(id: string, dimSet: Set<string> | null, focus: Set<string> | null): number {
  if (dimSet && !dimSet.has(id)) return 0.18;
  if (focus && !focus.has(id)) return 0.22;
  return 1;
}

// ─── LOD ────────────────────────────────────────────────────────────────

/** Name labels fade out between `near` and `far` camera distance. */
export function labelAlpha(dist: number, near: number, far: number): number {
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  const t = (dist - near) / (far - near);
  return 1 - t * t;
}

/** Cluster captions do the opposite: visible from afar, gone when you are inside the cluster. */
export function clusterLabelAlpha(dist: number, clusterR: number): number {
  const near = clusterR * 1.4;
  const far = clusterR * 2.6;
  if (dist <= near) return 0;
  if (dist >= far) return 1;
  return (dist - near) / (far - near);
}

// ─── Camera ─────────────────────────────────────────────────────────────

/** Distance at which a sphere of `radius` fits the viewport (with padding). */
export function frameDistance(radius: number, fovDeg: number, aspect: number, pad = 1.04): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(aspect, 0.1));
  const fov = Math.min(vFov, hFov);
  return (radius * pad) / Math.sin(fov / 2);
}

/** Default framing direction: elevated three-quarter view. */
export function frameDirection(azimuth = 0.35, polar = 1.05): Vec3 {
  return normalize([Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)]);
}

// ─── Quality caps ───────────────────────────────────────────────────────

export interface Quality {
  pixelRatio: number;
  /** Bloom render-target scale (1 = full res). */
  bloomScale: number;
  stars: number;
  dust: number;
  /** Name labels drawn at rest (hover/selection always show). */
  maxLabels: number;
  orbitParticles: number;
  maxSatellites: number;
  maxPulses: number;
}

export function qualityFor(opts: { width: number; dpr: number; lowEnd: boolean }): Quality {
  const phone = opts.width < 560;
  if (phone || opts.lowEnd) {
    return {
      pixelRatio: Math.min(opts.dpr, 1.5),
      bloomScale: 0.5,
      stars: 500,
      dust: 180,
      maxLabels: 10,
      orbitParticles: 6,
      maxSatellites: 24,
      maxPulses: 12,
    };
  }
  return {
    pixelRatio: Math.min(opts.dpr, 2),
    bloomScale: 0.75,
    stars: 1400,
    dust: 420,
    maxLabels: 60,
    orbitParticles: 10,
    maxSatellites: 64,
    maxPulses: 32,
  };
}

/** Rank nodes for resting labels: focus first, then working, then activity. */
export function labelPriority(n: { id: string; state: string; size: number }, hoverId: string | null, selectedId: string | null): number {
  if (n.id === hoverId || n.id === selectedId) return 3;
  if (n.state === "working") return 2;
  return 1 + clamp(n.size, 0, 1) * 0.9;
}

/** Satellite orbit (sub-agent run `i` of `count` around a parent of radius `r`) at time `t`. */
export function satelliteOffset(i: number, count: number, r: number, t: number, seed: number): Vec3 {
  const orbit = r * 2.1 + i * r * 0.35;
  const speed = 0.55 - i * 0.07;
  const a = t * speed + (i / Math.max(1, count)) * TAU + seed * TAU;
  const tilt = 0.45 + seed * 0.5;
  const x = Math.cos(a) * orbit;
  const yy = Math.sin(a) * orbit;
  return [x, yy * Math.sin(tilt), yy * Math.cos(tilt)];
}
