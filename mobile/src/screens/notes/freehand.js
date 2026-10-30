// freehand — turn raw pointer samples into smooth variable-width ink.
//
// We use `perfect-freehand` (pure JS, no native module) to build a filled
// outline polygon for each stroke, then emit an SVG path string. This is the
// same engine GoodNotes-style apps use for pressure-tapered ink. Rendered via
// react-native-svg <Path fill=...> (already a mobile dependency), so nothing
// native has to be added for the canvas itself.

import { getStroke } from 'perfect-freehand';

// Per-tool freehand tuning. Highlighter is fat + flat; pen tapers with speed
// and pressure for a natural nib feel.
export function strokeOptionsFor(tool, size) {
  if (tool === 'highlighter') {
    return {
      size: size * 2.2,
      thinning: 0,
      smoothing: 0.6,
      streamline: 0.5,
      simulatePressure: false,
      last: true,
      start: { cap: false, taper: 0 },
      end: { cap: false, taper: 0 },
    };
  }
  // pen (and eraser preview)
  return {
    size,
    thinning: 0.6,
    smoothing: 0.62,
    streamline: 0.5,
    simulatePressure: true,
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: size * 2 },
  };
}

// points: [[x, y, pressure], ...]  -> SVG path "d"
export function pointsToSvgPath(points, tool, size) {
  if (!points || points.length === 0) return '';
  const outline = getStroke(points, strokeOptionsFor(tool, size));
  if (!outline || outline.length < 2) return '';
  return outlineToPath(outline);
}

function outlineToPath(pts) {
  const d = pts.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', ...pts[0], 'Q'],
  );
  d.push('Z');
  // Round to keep the serialized path small.
  return d.map((v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)).join(' ');
}

// ── Geometry helpers for eraser + lasso selection ─────────────────────────

export function strokeBBox(stroke) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of stroke.points || []) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

export function shapeBBox(shape) {
  const x1 = Math.min(shape.x, shape.x + shape.w);
  const y1 = Math.min(shape.y, shape.y + shape.h);
  const x2 = Math.max(shape.x, shape.x + shape.w);
  const y2 = Math.max(shape.y, shape.y + shape.h);
  return { minX: x1, minY: y1, maxX: x2, maxY: y2 };
}

export function pointInBox(x, y, box, pad = 0) {
  return (
    x >= box.minX - pad && x <= box.maxX + pad && y >= box.minY - pad && y <= box.maxY + pad
  );
}

// Distance from point to a stroke's polyline (used by the whole-stroke eraser).
export function distToStroke(x, y, stroke) {
  const pts = stroke.points || [];
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (d < best) best = d;
  }
  if (pts.length === 1) best = Math.hypot(x - pts[0][0], y - pts[0][1]);
  return best;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Split a stroke around an eraser hit at (x,y,radius): returns the surviving
// sub-strokes (pixel-style erase). Points within the radius are dropped and
// the remaining runs become separate strokes.
export function eraseFromStroke(stroke, x, y, radius) {
  const pts = stroke.points || [];
  const runs = [];
  let cur = [];
  for (const p of pts) {
    if (Math.hypot(p[0] - x, p[1] - y) <= radius) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length) runs.push(cur);
  return runs
    .filter((r) => r.length >= 2)
    .map((r, i) => ({ ...stroke, id: `${stroke.id}_s${i}`, points: r }));
}
