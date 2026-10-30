/**
 * glow3d brain anatomy — one analytic brain shared by the knowledge-graph
 * layout (where nodes may sit), the cortex mesh (what the user sees) and the
 * tests (points inside, fissure empty). Pure math, no three.js.
 *
 * Unit space (multiply by the brain scale S for world units):
 *   X = lateral (− left / + right), Y = up, Z = front (+) / back (−).
 *
 * Parts:
 *   • two cerebral hemispheres — a long ellipsoid, flatter underneath and
 *     narrower toward the occipital pole, with a temporal lobe bulging down
 *     and forward on the lateral side. A flat medial face on each side leaves
 *     the LONGITUDINAL FISSURE (|x| < FISSURE) empty.
 *   • the lateral (Sylvian) fissure — a slit carved into the lateral surface
 *     that separates the temporal lobe from the frontal/parietal lobes.
 *   • a paired cerebellum at the lower back (fine horizontal folia on the mesh).
 *   • the brainstem: a tapered stalk with a pons bulge, on the midline.
 *
 * Lobes are regions OF this shape (`lobeAt`), not separate volumes.
 */

export type LobeId = "frontal" | "parietal" | "temporal" | "occipital" | "cerebellum" | "brainstem";

/** Lobe order = the index the cortex shader uses for per-lobe tint/emphasis. */
export const LOBE_IDS: LobeId[] = ["frontal", "parietal", "temporal", "occipital", "cerebellum", "brainstem"];

/** Half-width of the longitudinal fissure (unit space): no cerebral tissue at |x| < FISSURE. */
export const FISSURE = 0.035;

export type V3 = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Approximate signed distance to an axis-aligned ellipsoid (negative inside). */
export function sdEllipsoid(px: number, py: number, pz: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number {
  const x = px - cx, y = py - cy, z = pz - cz;
  const k0 = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2);
  const k1 = Math.sqrt((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2 + (z / (rz * rz)) ** 2);
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

function smin(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Height of the Sylvian fissure line on the lateral surface at depth z. */
export function sylvianY(z: number): number {
  return -0.16 + (0.42 - z) * (0.26 / 0.8);
}

/** Right-hemisphere centre (mirror x for the left). Rays from here define the surface. */
export const HEMI_CENTER: V3 = [0.41, 0.02, 0.0];
/** Cerebellum half centre (mirror x for the left). */
export const CEREBELLUM_CENTER: V3 = [0.25, -0.52, -0.64];

const softMin = (a: number, b: number, k: number) => -k * Math.log(Math.exp(-a / k) + Math.exp(-b / k));

/**
 * Base (unfolded) hemisphere radius along unit direction d from HEMI_CENTER
 * (right side, d[0] may be negative toward the midline). Long ellipsoid,
 * flatter underneath, narrower at the occipital pole, temporal lobe bulging
 * down/forward laterally, flat medial wall at x = FISSURE.
 */
export function hemiBaseRadius(dx: number, dy: number, dz: number): number {
  const taper = 1 - 0.2 * smoothstep(-0.15, -0.95, dz) - 0.06 * smoothstep(0.4, 0.95, dz);
  const rx = 0.385 * taper;
  const ry = dy > 0 ? 0.57 - 0.06 * smoothstep(0.2, 0.9, dz) : 0.4;
  const rz = dz > 0 ? 0.96 : 1.0;
  // Superquadric on the medial side (hemispheres meet along the whole top),
  // a plain ellipsoid laterally.
  const e = dx < 0 ? 2.0 + 1.6 * smoothstep(0, -0.6, dx) : 2.0;
  let r = Math.pow(Math.abs(dx / rx) ** e + Math.abs(dy / ry) ** e + Math.abs(dz / rz) ** 2 * Math.pow(Math.abs(dz / rz) ** 2 + 1e-9, e / 2 - 1), -1 / e);
  // Temporal lobe: lateral, low, forward of the middle.
  const lat = smoothstep(-0.05, 0.55, dx);
  const low = Math.exp(-(((dy + 0.62) / 0.36) ** 2));
  const fwd = Math.exp(-(((dz - 0.12) / 0.55) ** 2));
  r += 0.17 * lat * low * fwd;
  // Orbital (under-)surface of the frontal lobe sits higher than the
  // temporal pole: a notch in the side silhouette between the two lobes.
  const front = smoothstep(0.25, 0.75, dz);
  const under = smoothstep(-0.15, -0.6, dy);
  r -= 0.11 * front * under * (1 - 0.6 * lat);
  // Flat medial wall (the longitudinal fissure stays open).
  if (dx < -1e-4) r = softMin(r, (HEMI_CENTER[0] - FISSURE) / -dx, 0.025);
  return r;
}

/** Depth of the Sylvian groove at a base-surface point (0..1). */
export function sylvianGroove(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  if (z < -0.42 || z > 0.5) return 0;
  const lateral = smoothstep(0.5, 0.72, ax);
  const along = smoothstep(0.5, 0.36, z) * smoothstep(-0.42, -0.25, z);
  return lateral * along * Math.exp(-(((y - sylvianY(z)) / 0.035) ** 2));
}

/** Final (folded) hemisphere surface radius along d, for a hemisphere on `side`. */
export function hemiRadius(dx: number, dy: number, dz: number, folds = true): number {
  const r0 = hemiBaseRadius(dx, dy, dz);
  if (!folds) return r0;
  const px = HEMI_CENTER[0] + dx * r0, py = HEMI_CENTER[1] + dy * r0, pz = HEMI_CENTER[2] + dz * r0;
  const medial = px < FISSURE + 0.02 ? 0 : 1;
  return r0 - 0.026 * sulcusAt(px, py, pz) * medial - 0.075 * sylvianGroove(px, py, pz);
}

/**
 * Cerebrum: one hemisphere (mirrored by |x|). Negative inside. Not an exact
 * distance — "how far inside along the ray from the hemisphere centre".
 */
export function sdCerebrum(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  if (ax < FISSURE) return FISSURE - ax + 1e-6;
  const vx = ax - HEMI_CENTER[0], vy = y - HEMI_CENTER[1], vz = z - HEMI_CENTER[2];
  const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (d < 1e-9) return -0.3;
  return d - hemiRadius(vx / d, vy / d, vz / d, false);
}

/** Cerebellum half radius along d from CEREBELLUM_CENTER (right side). */
export function cerebellumRadius(dx: number, dy: number, dz: number): number {
  let r = 1 / Math.sqrt((dx / 0.25) ** 2 + (dy / (dy > 0 ? 0.17 : 0.2)) ** 2 + (dz / 0.25) ** 2);
  if (dx < -1e-4) r = softMin(r, (CEREBELLUM_CENTER[0] - 0.012) / -dx, 0.02);
  return r;
}

/** Paired cerebellum at the lower back. */
export function sdCerebellum(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const vx = ax - CEREBELLUM_CENTER[0], vy = y - CEREBELLUM_CENTER[1], vz = z - CEREBELLUM_CENTER[2];
  const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (d < 1e-9) return -0.15;
  return d - cerebellumRadius(vx / d, vy / d, vz / d);
}

/** Brainstem: tapered stalk from under the cerebrum down, with a pons bulge. */
export function sdBrainstem(x: number, y: number, z: number): number {
  // Segment a→b.
  const ax = 0, ay = -0.22, az = -0.24;
  const bx = 0, by = -0.98, bz = -0.4;
  const px = x - ax, py = y - ay, pz = z - az;
  const vx = bx - ax, vy = by - ay, vz = bz - az;
  const h = clamp01((px * vx + py * vy + pz * vz) / (vx * vx + vy * vy + vz * vz));
  const dx = px - vx * h, dy = py - vy * h, dz = pz - vz * h;
  const r = 0.1 - 0.035 * h;
  const stalk = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
  const pons = sdEllipsoid(x, y, z, 0, -0.46, -0.24, 0.13, 0.11, 0.12);
  return smin(stalk, pons, 0.05);
}

/** Whole brain (negative inside). */
export function brainSdf(x: number, y: number, z: number): number {
  return Math.min(sdCerebrum(x, y, z), sdCerebellum(x, y, z), sdBrainstem(x, y, z));
}

/** Which lobe a point inside the brain belongs to (unit space). */
export function lobeAt(x: number, y: number, z: number): LobeId {
  const c = sdCerebrum(x, y, z);
  const cb = sdCerebellum(x, y, z);
  const bs = sdBrainstem(x, y, z);
  if (c > 0 || (cb < c && cb <= 0) || (bs < c && bs <= 0)) {
    if (bs <= cb) return "brainstem";
    return "cerebellum";
  }
  if (y < sylvianY(z) && z > -0.58) return "temporal";
  if (z < -0.6 + 0.1 * y) return "occipital";
  if (z > 0.06 - 0.22 * y) return "frontal";
  return "parietal";
}

/** Hemisphere side of a point: −1 left, +1 right, 0 midline (brainstem). */
export function sideAt(x: number, lobe: LobeId): -1 | 0 | 1 {
  if (lobe === "brainstem") return 0;
  return x < 0 ? -1 : 1;
}

/** Brain bounding box (unit space) — framing the silhouette. */
export const BRAIN_BOUNDS = { min: [-0.9, -1.0, -1.02] as V3, max: [0.9, 0.64, 1.0] as V3 };

// ── Noise (gyri / sulci) ─────────────────────────────────────────────

const PERM = (() => {
  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
})();

const GRAD: V3[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Classic 3D Perlin noise in about −1..1. */
export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const xf = x - X, yf = y - Y, zf = z - Z;
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const g = (i: number, j: number, k: number, dx: number, dy: number, dz: number) => {
    const gr = GRAD[PERM[i + PERM[j + PERM[k]]] % 12];
    return gr[0] * dx + gr[1] * dy + gr[2] * dz;
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x0 = lerp(g(xi, yi, zi, xf, yf, zf), g(xi + 1, yi, zi, xf - 1, yf, zf), u);
  const x1 = lerp(g(xi, yi + 1, zi, xf, yf - 1, zf), g(xi + 1, yi + 1, zi, xf - 1, yf - 1, zf), u);
  const x2 = lerp(g(xi, yi, zi + 1, xf, yf, zf - 1), g(xi + 1, yi, zi + 1, xf - 1, yf, zf - 1), u);
  const x3 = lerp(g(xi, yi + 1, zi + 1, xf, yf - 1, zf - 1), g(xi + 1, yi + 1, zi + 1, xf - 1, yf - 1, zf - 1), u);
  return lerp(lerp(x0, x1, v), lerp(x2, x3, v), w);
}

/**
 * Sulcus strength at a cortex point (0 = gyrus crown, 1 = bottom of a
 * sulcus). Zero-contours of domain-warped noise form the meandering network
 * of folds a real cortex shows.
 */
export function sulcusAt(x: number, y: number, z: number): number {
  // Domain-warped noise, then many iso-lines of it (|sin(K·n)|): dense,
  // meandering, roughly parallel folds like a real cortex.
  const wx = noise3(x * 1.6 + 11.3, y * 1.6, z * 1.6) * 0.4;
  const wy = noise3(x * 1.6, y * 1.6 + 7.1, z * 1.6) * 0.4;
  const wz = noise3(x * 1.6, y * 1.6, z * 1.6 + 3.7) * 0.4;
  const f = 2.4;
  const n = noise3((x + wx) * f, (y + wy) * f, (z + wz) * f * 0.8) + 0.5 * noise3((x - wz) * f * 2.1, (y + wx) * f * 2.1, (z - wy) * f * 2.1);
  return 1 - smoothstep(0.0, 0.32, Math.abs(Math.sin(n * 7.5)));
}

/** Folium strength on the cerebellum (fine, near-horizontal folds). */
export function foliumAt(x: number, y: number, z: number): number {
  const s = Math.sin((y + noise3(x * 3, y * 3, z * 3) * 0.03 + z * 0.12) * 64);
  return 1 - smoothstep(0.0, 0.5, Math.abs(s));
}
