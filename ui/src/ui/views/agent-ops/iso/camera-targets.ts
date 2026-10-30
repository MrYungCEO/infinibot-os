/**
 * camera-targets — pure framing math for the CameraDirector.
 *
 * Turns a weighted set of agent positions into a "frame": a center point the
 * camera should look at, plus a scale that encloses the interesting agents with
 * padding. All functions are side-effect free and deterministic so they can be
 * unit-tested directly.
 */

import { clamp, lerp, smoothstep } from "./camera-easing";

export interface WeightedPoint {
  x: number;
  y: number;
  /** Relative importance — drives the centroid pull. Must be >= 0. */
  weight: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Frame {
  /** World-space point the camera centers on. */
  x: number;
  y: number;
  /** Camera scale (zoom). */
  scale: number;
}

/** Axis-aligned bounding box over a point set, or null if empty. */
export function boundingBox(points: { x: number; y: number }[]): BBox | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxWidth(b: BBox): number {
  return b.maxX - b.minX;
}

export function bboxHeight(b: BBox): number {
  return b.maxY - b.minY;
}

export function bboxCenter(b: BBox): { x: number; y: number } {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** Diagonal length of a bbox — a single scalar for "how spread out" a set is. */
export function bboxDiagonal(b: BBox): number {
  return Math.hypot(bboxWidth(b), bboxHeight(b));
}

/**
 * Weighted centroid of a point set. Weights are clamped to >= 0; if every
 * weight is zero (or the set is empty) it falls back to the unweighted mean,
 * and null only when there are no points at all.
 *
 * The weighted centroid biases the camera toward the *most interesting* agents
 * (busy / alerting / recently spawned) rather than the geometric middle, so a
 * lone hot agent on the edge of a calm crowd still gets framed.
 */
export function weightedCentroid(points: WeightedPoint[]): { x: number; y: number } | null {
  if (points.length === 0) return null;
  let sw = 0, sx = 0, sy = 0;
  for (const p of points) {
    const w = Math.max(0, p.weight);
    sw += w;
    sx += p.x * w;
    sy += p.y * w;
  }
  if (sw <= 0) {
    // Degenerate weights → plain mean so we never divide by zero.
    const n = points.length;
    let mx = 0, my = 0;
    for (const p of points) { mx += p.x; my += p.y; }
    return { x: mx / n, y: my / n };
  }
  return { x: sx / sw, y: sy / sw };
}

export interface ScaleFromSpreadOpts {
  /** Scale used when the set is tightly clustered (zoomed in). */
  tightScale: number;
  /** Scale used when the set is widely spread (zoomed out). */
  wideScale: number;
  /**
   * Diagonal (world px) at/above which we use the fully-zoomed-out wideScale.
   * Below it, we interpolate up toward tightScale on an S-curve.
   */
  referenceSpanPx: number;
  /** Hard zoom clamps (engine also clamps, but we respect intent locally). */
  minScale: number;
  maxScale: number;
}

/**
 * Map a cluster's spread (bbox diagonal) to a camera scale.
 *
 * Tight cluster (diagonal → 0)  → tightScale (zoom IN).
 * Wide cluster  (diagonal → ref) → wideScale (zoom OUT).
 * Blended with smoothstep so the zoom eases rather than ramping linearly.
 */
export function scaleFromSpread(diagonalPx: number, o: ScaleFromSpreadOpts): number {
  const t = smoothstep(clamp(diagonalPx / Math.max(1, o.referenceSpanPx), 0, 1));
  const s = lerp(o.tightScale, o.wideScale, t);
  return clamp(s, o.minScale, o.maxScale);
}

export interface FitScaleOpts {
  viewportWidth: number;
  viewportHeight: number;
  paddingPx: number;
  minScale: number;
  maxScale: number;
}

/**
 * Exact scale-to-fit: the largest scale at which the (padded) bbox still fits
 * inside the viewport. Used only when real viewport dimensions are available.
 */
export function fitScaleToViewport(b: BBox, o: FitScaleOpts): number {
  const w = bboxWidth(b) + o.paddingPx * 2;
  const h = bboxHeight(b) + o.paddingPx * 2;
  const sx = o.viewportWidth / Math.max(1, w);
  const sy = o.viewportHeight / Math.max(1, h);
  return clamp(Math.min(sx, sy), o.minScale, o.maxScale);
}

/**
 * Compute the desired camera frame for a weighted target set.
 *
 * - Center  = weighted centroid (biased toward hot agents).
 * - Scale   = exact viewport-fit when `fit` is supplied, otherwise the
 *             spread-heuristic mapping (`spread`).
 *
 * Returns null when there are no points to frame.
 */
export function computeFrame(
  points: WeightedPoint[],
  opts: { spread: ScaleFromSpreadOpts; fit?: FitScaleOpts },
): Frame | null {
  const center = weightedCentroid(points);
  if (!center) return null;
  const box = boundingBox(points)!;
  const scale = opts.fit
    ? fitScaleToViewport(box, opts.fit)
    : scaleFromSpread(bboxDiagonal(box), opts.spread);
  return { x: center.x, y: center.y, scale };
}

/** Euclidean distance between two frames' centers. */
export function frameCenterDist(a: Frame, b: Frame): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
