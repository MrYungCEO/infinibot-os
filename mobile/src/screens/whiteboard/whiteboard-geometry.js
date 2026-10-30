/**
 * whiteboard-geometry — pure geometry for the native Excalidraw canvas.
 *
 * Everything here is plain JS (no React / RN) so it is unit-tested in node:
 *   · element bounds (axis-aligned, rotation-aware)
 *   · hit testing (shapes, linear elements, freedraw, text)
 *   · SVG path builders (rounded rect, diamond, polyline, arrowheads,
 *     perfect-freehand ink) with a seeded "sketchy" jitter for roughness
 *   · camera math (screen <-> scene, zoom around a focal point, fit to content)
 *   · Excalidraw's dark-mode colour transform (invert 93% + hue-rotate 180)
 *
 * Coordinates follow the Excalidraw scene model: an element's x/y is its
 * top-left (shapes/text) or origin (linear/freedraw, whose `points` are
 * relative to x/y). `angle` is radians around the element's bbox centre.
 */

import { getStroke } from 'perfect-freehand';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

const LINEAR = new Set(['arrow', 'line']);
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond', 'frame', 'image', 'embeddable', 'iframe', 'magicframe']);

export function isLinear(el) {
  return !!el && LINEAR.has(el.type);
}
export function isShape(el) {
  return !!el && SHAPES.has(el.type);
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ── Text metrics ──────────────────────────────────────────────────────────

/** Excalidraw font families → a rough average glyph width factor. */
export function glyphFactor(fontFamily) {
  if (fontFamily === 3 || fontFamily === 8) return 0.6; // Cascadia / Comic Shanns (mono)
  if (fontFamily === 2 || fontFamily === 6) return 0.52; // Helvetica / Nunito
  return 0.58; // Virgil / Excalifont / Lilita
}

export function lineHeightOf(el) {
  const lh = num(el && el.lineHeight, 1.25);
  return lh > 0 ? lh : 1.25;
}

/** Estimated {width,height} of a text block at its font size. */
export function measureText(text, fontSize = 20, fontFamily = 5, lineHeight = 1.25) {
  const lines = String(text ?? '').split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return {
    width: Math.max(fontSize * 0.6, longest * fontSize * glyphFactor(fontFamily)),
    height: Math.max(1, lines.length) * fontSize * lineHeight,
  };
}

// ── Bounds ────────────────────────────────────────────────────────────────

/** Points of a linear/freedraw element (relative), with a 2-point fallback. */
export function pointsOf(el) {
  if (Array.isArray(el.points) && el.points.length) {
    return el.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }
  return [[0, 0], [num(el.width), num(el.height)]];
}

/** Un-rotated scene bounds: { minX, minY, maxX, maxY }. */
export function elementBounds(el) {
  if (!el) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const x = num(el.x);
  const y = num(el.y);
  if (isLinear(el) || el.type === 'freedraw') {
    const pts = pointsOf(el);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of pts) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    if (!Number.isFinite(minX)) return { minX: x, minY: y, maxX: x, maxY: y };
    return { minX: x + minX, minY: y + minY, maxX: x + maxX, maxY: y + maxY };
  }
  let w = num(el.width);
  let h = num(el.height);
  if (el.type === 'text' && (!w || !h)) {
    const m = measureText(el.text, num(el.fontSize, 20), el.fontFamily, lineHeightOf(el));
    w = w || m.width;
    h = h || m.height;
  }
  return { minX: Math.min(x, x + w), minY: Math.min(y, y + h), maxX: Math.max(x, x + w), maxY: Math.max(y, y + h) };
}

export function boundsCenter(b) {
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

export function rotatePoint(px, py, cx, cy, angle) {
  if (!angle) return [px, py];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = px - cx;
  const dy = py - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** Axis-aligned bounds of the element AFTER its rotation. */
export function rotatedBounds(el) {
  const b = elementBounds(el);
  const angle = num(el && el.angle);
  if (!angle) return b;
  const [cx, cy] = boundsCenter(b);
  const corners = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ].map(([px, py]) => rotatePoint(px, py, cx, cy, angle));
  return {
    minX: Math.min(...corners.map((p) => p[0])),
    minY: Math.min(...corners.map((p) => p[1])),
    maxX: Math.max(...corners.map((p) => p[0])),
    maxY: Math.max(...corners.map((p) => p[1])),
  };
}

export function unionBounds(list) {
  let out = null;
  for (const b of list) {
    if (!b) continue;
    if (!out) out = { ...b };
    else {
      out.minX = Math.min(out.minX, b.minX);
      out.minY = Math.min(out.minY, b.minY);
      out.maxX = Math.max(out.maxX, b.maxX);
      out.maxY = Math.max(out.maxY, b.maxY);
    }
  }
  return out;
}

export function sceneBounds(elements) {
  return unionBounds((elements || []).filter((e) => e && !e.isDeleted).map(rotatedBounds));
}

// ── Hit testing ───────────────────────────────────────────────────────────

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolyline(px, py, pts, ox = 0, oy = 0) {
  if (!pts.length) return Infinity;
  if (pts.length === 1) return Math.hypot(px - (ox + pts[0][0]), py - (oy + pts[0][1]));
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegment(px, py, ox + pts[i - 1][0], oy + pts[i - 1][1], ox + pts[i][0], oy + pts[i][1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Does scene point (px,py) hit the element? `tol` is in scene units.
 * Shapes are hit anywhere inside (friendlier for fingers than Excalidraw's
 * stroke-only rule for transparent shapes); lines/ink within tol of the path.
 */
export function hitTest(el, px, py, tol = 8) {
  if (!el || el.isDeleted) return false;
  const b = elementBounds(el);
  const [cx, cy] = boundsCenter(b);
  // Move the probe into the element's un-rotated frame.
  const [x, y] = rotatePoint(px, py, cx, cy, -num(el.angle));
  if (isLinear(el) || el.type === 'freedraw') {
    const pad = tol + num(el.strokeWidth, 2) / 2;
    return distToPolyline(x, y, pointsOf(el), num(el.x), num(el.y)) <= pad;
  }
  const hw = (b.maxX - b.minX) / 2;
  const hh = (b.maxY - b.minY) / 2;
  const dx = x - cx;
  const dy = y - cy;
  if (el.type === 'ellipse') {
    const rx = hw + tol;
    const ry = hh + tol;
    if (rx <= 0 || ry <= 0) return false;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }
  if (el.type === 'diamond') {
    const rx = hw + tol;
    const ry = hh + tol;
    if (rx <= 0 || ry <= 0) return false;
    return Math.abs(dx) / rx + Math.abs(dy) / ry <= 1;
  }
  return Math.abs(dx) <= hw + tol && Math.abs(dy) <= hh + tol;
}

/** Topmost element id under the point (bound text resolves to its container). */
export function hitTestScene(elements, px, py, tol = 8) {
  const list = elements || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const el = list[i];
    if (!el || el.isDeleted || el.locked) continue;
    if (hitTest(el, px, py, tol)) {
      if (el.type === 'text' && el.containerId && list.some((c) => c.id === el.containerId && !c.isDeleted)) {
        return el.containerId;
      }
      return el.id;
    }
  }
  return null;
}

// ── Selection handles ─────────────────────────────────────────────────────

export const HANDLES = ['nw', 'ne', 'se', 'sw'];

export function handlePositions(b) {
  return {
    nw: [b.minX, b.minY],
    ne: [b.maxX, b.minY],
    se: [b.maxX, b.maxY],
    sw: [b.minX, b.maxY],
  };
}

/** Which corner handle of bounds `b` is within `tol` of the point, or null. */
export function hitHandle(b, px, py, tol) {
  if (!b) return null;
  const pos = handlePositions(b);
  for (const h of HANDLES) {
    if (Math.hypot(px - pos[h][0], py - pos[h][1]) <= tol) return h;
  }
  return null;
}

/**
 * New bounds when dragging handle `h` of bounds `b` to scene point (px,py).
 * Never collapses below `min` and keeps the opposite corner anchored.
 */
export function resizeBounds(b, h, px, py, min = 4, keepAspect = false) {
  let { minX, minY, maxX, maxY } = b;
  if (h.includes('w')) minX = Math.min(px, maxX - min);
  if (h.includes('e')) maxX = Math.max(px, minX + min);
  if (h.includes('n')) minY = Math.min(py, maxY - min);
  if (h.includes('s')) maxY = Math.max(py, minY + min);
  if (keepAspect) {
    const ow = b.maxX - b.minX || 1;
    const oh = b.maxY - b.minY || 1;
    const s = Math.max((maxX - minX) / ow, (maxY - minY) / oh);
    const w = ow * s;
    const hh = oh * s;
    if (h.includes('w')) minX = maxX - w;
    else maxX = minX + w;
    if (h.includes('n')) minY = maxY - hh;
    else maxY = minY + hh;
  }
  return { minX, minY, maxX, maxY };
}

// ── Camera ────────────────────────────────────────────────────────────────
// camera = { x, y, zoom }: screen = scene * zoom + (x, y)

export function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, num(z, 1)));
}

export function screenToScene(cam, sx, sy) {
  return [(sx - cam.x) / cam.zoom, (sy - cam.y) / cam.zoom];
}

export function sceneToScreen(cam, x, y) {
  return [x * cam.zoom + cam.x, y * cam.zoom + cam.y];
}

/** Zoom to `zoom` keeping the scene point under screen (fx,fy) fixed. */
export function zoomAround(cam, zoom, fx, fy) {
  const z = clampZoom(zoom);
  const [sx, sy] = screenToScene(cam, fx, fy);
  return { x: fx - sx * z, y: fy - sy * z, zoom: z };
}

/** Camera that fits `bounds` into a w×h viewport with `pad` px of margin. */
export function fitCamera(bounds, w, h, pad = 32, maxZoom = 1) {
  if (!bounds || !(w > 0) || !(h > 0)) return { x: w / 2 || 0, y: h / 2 || 0, zoom: 1 };
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = clampZoom(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, maxZoom));
  const [cx, cy] = boundsCenter(bounds);
  return { x: w / 2 - cx * zoom, y: h / 2 - cy * zoom, zoom };
}

/** Camera centred on scene point (x,y) at the current (or given) zoom. */
export function centerOn(cam, x, y, w, h, zoom) {
  const z = clampZoom(zoom ?? cam.zoom);
  return { x: w / 2 - x * z, y: h / 2 - y * z, zoom: z };
}

// ── Colour (Excalidraw dark theme) ────────────────────────────────────────

function parseHex(c) {
  if (typeof c !== 'string') return null;
  let s = c.trim();
  if (!s.startsWith('#')) return null;
  s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split('').map((ch) => ch + ch).join('');
  if (s.length !== 6 && s.length !== 8) return null;
  const n = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

const hex2 = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

export function isTransparent(c) {
  return !c || c === 'transparent' || c === 'none';
}

/**
 * Excalidraw renders dark mode by filtering the light canvas with
 * `invert(93%) hue-rotate(180deg)`. Apply the same transform to one colour so
 * scenes authored on the (white) web canvas read correctly on a dark board.
 */
export function darkModeColor(c) {
  if (isTransparent(c)) return c;
  const rgb = parseHex(c);
  if (!rgb) return c;
  const a = 0.93;
  let [r, g, b] = rgb.slice(0, 3).map((v) => {
    const n = v / 255;
    return (a * (1 - n) + (1 - a) * n) * 255;
  });
  // hue-rotate(180deg) matrix (CSS filter effects spec)
  const cos = -1;
  const sin = 0;
  const m = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  const nr = m[0] * r + m[1] * g + m[2] * b;
  const ng = m[3] * r + m[4] * g + m[5] * b;
  const nb = m[6] * r + m[7] * g + m[8] * b;
  r = nr; g = ng; b = nb;
  const alpha = rgb[3] < 1 ? hex2(rgb[3] * 255) : '';
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha}`;
}

export function renderColor(c, dark) {
  return dark ? darkModeColor(c) : c;
}

// ── Sketchy jitter (roughness) ────────────────────────────────────────────

/** Small deterministic PRNG so an element's wobble is stable across renders. */
export function seededRandom(seed) {
  let s = (Math.abs(Math.floor(num(seed, 1))) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function jitterFn(roughness, seed, size) {
  const r = num(roughness, 0);
  if (r <= 0) return null;
  const rand = seededRandom(seed);
  const amp = Math.min(r * 1.1, Math.max(0.4, size * 0.02 * r));
  return () => (rand() - 0.5) * 2 * amp;
}

const f1 = (v) => Math.round(v * 10) / 10;

// ── SVG path builders (element-local: origin at the element's x/y) ───────

/** Excalidraw corner radius for a roundness descriptor at side length `x`. */
export function cornerRadius(roundness, x) {
  if (!roundness) return 0;
  if (roundness.type === 2) return x * 0.25; // PROPORTIONAL_RADIUS
  if (roundness.type === 3) {
    const fixed = typeof roundness.value === 'number' ? roundness.value : 32; // ADAPTIVE_RADIUS
    const cutoff = fixed / 0.25;
    return x <= cutoff ? x * 0.25 : fixed;
  }
  return 0;
}

export function rectPath(w, h, radius = 0, jitter = null) {
  const j = jitter || (() => 0);
  const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  if (!r) {
    return `M${f1(j())} ${f1(j())} L${f1(w + j())} ${f1(j())} L${f1(w + j())} ${f1(h + j())} L${f1(j())} ${f1(h + j())} Z`;
  }
  return [
    `M${f1(r + j())} ${f1(j())}`,
    `L${f1(w - r + j())} ${f1(j())}`,
    `Q${f1(w)} 0 ${f1(w + j())} ${f1(r + j())}`,
    `L${f1(w + j())} ${f1(h - r + j())}`,
    `Q${f1(w)} ${f1(h)} ${f1(w - r + j())} ${f1(h + j())}`,
    `L${f1(r + j())} ${f1(h + j())}`,
    `Q0 ${f1(h)} ${f1(j())} ${f1(h - r + j())}`,
    `L${f1(j())} ${f1(r + j())}`,
    `Q0 0 ${f1(r + j())} ${f1(j())}`,
    'Z',
  ].join(' ');
}

export function diamondPath(w, h, radius = 0, jitter = null) {
  const j = jitter || (() => 0);
  const top = [w / 2, 0];
  const right = [w, h / 2];
  const bottom = [w / 2, h];
  const left = [0, h / 2];
  if (!radius) {
    return `M${f1(top[0] + j())} ${f1(top[1] + j())} L${f1(right[0] + j())} ${f1(right[1] + j())} L${f1(bottom[0] + j())} ${f1(bottom[1] + j())} L${f1(left[0] + j())} ${f1(left[1] + j())} Z`;
  }
  // Rounded diamond: cut each corner by `t` along both edges, curve through the vertex.
  const t = Math.min(0.25, radius / Math.max(1, Math.hypot(w / 2, h / 2)));
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const pts = [top, right, bottom, left];
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4];
    const cur = pts[i];
    const next = pts[(i + 1) % 4];
    const a = lerp(cur, prev, t);
    const b = lerp(cur, next, t);
    parts.push(`${i === 0 ? 'M' : 'L'}${f1(a[0] + j())} ${f1(a[1] + j())}`);
    parts.push(`Q${f1(cur[0])} ${f1(cur[1])} ${f1(b[0] + j())} ${f1(b[1] + j())}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/** Ellipse inside a w×h box as an SVG path (4 cubic arcs). */
export function ellipsePath(w, h, jitter = null) {
  const j = jitter || (() => 0);
  const rx = w / 2;
  const ry = h / 2;
  const k = 0.5522847498;
  const cx = rx;
  const cy = ry;
  return [
    `M${f1(cx + rx + j())} ${f1(cy + j())}`,
    `C${f1(cx + rx)} ${f1(cy + ry * k)} ${f1(cx + rx * k)} ${f1(cy + ry)} ${f1(cx + j())} ${f1(cy + ry + j())}`,
    `C${f1(cx - rx * k)} ${f1(cy + ry)} ${f1(cx - rx)} ${f1(cy + ry * k)} ${f1(cx - rx + j())} ${f1(cy + j())}`,
    `C${f1(cx - rx)} ${f1(cy - ry * k)} ${f1(cx - rx * k)} ${f1(cy - ry)} ${f1(cx + j())} ${f1(cy - ry + j())}`,
    `C${f1(cx + rx * k)} ${f1(cy - ry)} ${f1(cx + rx)} ${f1(cy - ry * k)} ${f1(cx + rx)} ${f1(cy)}`,
    'Z',
  ].join(' ');
}

/** Polyline through relative points; `round` smooths with midpoint quadratics. */
export function polylinePath(pts, round = false, jitter = null) {
  const j = jitter || (() => 0);
  if (!pts || !pts.length) return '';
  if (pts.length === 1) return `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  if (!round || pts.length < 3) {
    return pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0] + (i ? j() : 0))} ${f1(p[1] + (i ? j() : 0))}`).join(' ');
  }
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${f1(pts[i][0])} ${f1(pts[i][1])} ${f1(mx)} ${f1(my)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${f1(last[0])} ${f1(last[1])}`;
  return d;
}

/**
 * Arrowhead geometry at the end of segment from→tip.
 * Returns { kind, path, filled, cx, cy, r } in the same local space.
 */
export function arrowheadPath(kind, from, tip, strokeWidth = 2) {
  if (!kind) return null;
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return null;
  const ux = dx / len;
  const uy = dy / len;
  const size = Math.min(len * 0.6, 18 + strokeWidth * 2);
  if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') {
    const r = Math.max(3, size * 0.28);
    return { kind, filled: kind !== 'circle_outline', cx: tip[0] - ux * r, cy: tip[1] - uy * r, r };
  }
  if (kind === 'bar') {
    const half = size * 0.5;
    return {
      kind,
      filled: false,
      path: `M${f1(tip[0] - uy * half)} ${f1(tip[1] + ux * half)} L${f1(tip[0] + uy * half)} ${f1(tip[1] - ux * half)}`,
    };
  }
  const ang = (kind === 'triangle' || kind === 'triangle_outline' ? 25 : 22) * (Math.PI / 180);
  const back = (a) => [tip[0] - size * (ux * Math.cos(a) - uy * Math.sin(a)), tip[1] - size * (uy * Math.cos(a) + ux * Math.sin(a))];
  const p1 = back(ang);
  const p2 = back(-ang);
  if (kind === 'triangle' || kind === 'triangle_outline' || kind === 'diamond' || kind === 'diamond_outline') {
    return {
      kind,
      filled: !kind.endsWith('_outline'),
      path: `M${f1(tip[0])} ${f1(tip[1])} L${f1(p1[0])} ${f1(p1[1])} L${f1(p2[0])} ${f1(p2[1])} Z`,
    };
  }
  return {
    kind: 'arrow',
    filled: false,
    path: `M${f1(p1[0])} ${f1(p1[1])} L${f1(tip[0])} ${f1(tip[1])} L${f1(p2[0])} ${f1(p2[1])}`,
  };
}

/** perfect-freehand options matching Excalidraw's freedraw renderer. */
export function freedrawOptions(el) {
  const sw = num(el && el.strokeWidth, 2);
  return {
    size: sw * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    simulatePressure: !!(el && el.simulatePressure !== false && !(Array.isArray(el.pressures) && el.pressures.length)),
    last: true,
  };
}

/** Filled outline path for a freedraw element (element-local coordinates). */
export function freedrawPath(el) {
  const pts = pointsOf(el);
  if (!pts.length) return '';
  const pressures = Array.isArray(el.pressures) ? el.pressures : [];
  const input = pts.map((p, i) => [p[0], p[1], typeof pressures[i] === 'number' ? pressures[i] : 0.5]);
  if (input.length === 1) input.push([input[0][0] + 0.1, input[0][1] + 0.1, input[0][2]]);
  const outline = getStroke(input, freedrawOptions(el));
  if (!outline || outline.length < 2) return '';
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(f1(x0), f1(y0), f1((x0 + x1) / 2), f1((y0 + y1) / 2));
      return acc;
    },
    ['M', f1(outline[0][0]), f1(outline[0][1]), 'Q'],
  );
  d.push('Z');
  return d.join(' ');
}

/**
 * Everything the renderer needs for one element, in element-local space
 * (translate by el.x/el.y, rotate by angle around `center`).
 *   { kind: 'path', d, fillable, extraD? } | { kind: 'text' } | { kind: 'ink', d }
 */
export function elementGeometry(el) {
  const w = num(el.width);
  const h = num(el.height);
  const rough = num(el.roughness, 0);
  const size = Math.max(Math.abs(w), Math.abs(h), 1);
  const jitter = (pass) => jitterFn(rough, num(el.seed, 1) + pass * 7919, size);
  if (el.type === 'rectangle' || el.type === 'frame' || el.type === 'image' || el.type === 'embeddable' || el.type === 'iframe') {
    const r = cornerRadius(el.roundness, Math.min(Math.abs(w), Math.abs(h)));
    return {
      kind: 'path',
      fillable: el.type !== 'frame',
      d: rectPath(w, h, r, jitter(0)),
      sketch: rough > 0 ? rectPath(w, h, r, jitter(1)) : null,
    };
  }
  if (el.type === 'diamond') {
    const r = el.roundness ? cornerRadius(el.roundness, Math.min(Math.abs(w), Math.abs(h))) : 0;
    return { kind: 'path', fillable: true, d: diamondPath(w, h, r, jitter(0)), sketch: rough > 0 ? diamondPath(w, h, r, jitter(1)) : null };
  }
  if (el.type === 'ellipse') {
    return { kind: 'path', fillable: true, d: ellipsePath(w, h, jitter(0)), sketch: rough > 0 ? ellipsePath(w, h, jitter(1)) : null };
  }
  if (isLinear(el)) {
    const pts = pointsOf(el);
    const round = !!el.roundness;
    const sw = num(el.strokeWidth, 2);
    const heads = [];
    if (pts.length >= 2) {
      if (el.type === 'arrow' || el.endArrowhead) {
        const end = el.endArrowhead === undefined && el.type === 'arrow' ? 'arrow' : el.endArrowhead;
        const hd = arrowheadPath(end, pts[pts.length - 2], pts[pts.length - 1], sw);
        if (hd) heads.push(hd);
      }
      if (el.startArrowhead) {
        const hd = arrowheadPath(el.startArrowhead, pts[1], pts[0], sw);
        if (hd) heads.push(hd);
      }
    }
    const closed = el.type === 'line' && pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1;
    return {
      kind: 'line',
      fillable: closed,
      d: polylinePath(pts, round, jitter(0)),
      sketch: rough > 0 ? polylinePath(pts, round, jitter(1)) : null,
      heads,
    };
  }
  if (el.type === 'freedraw') return { kind: 'ink', d: freedrawPath(el) };
  if (el.type === 'text') return { kind: 'text' };
  return { kind: 'path', fillable: true, d: rectPath(w, h, 0) };
}

/** SVG stroke-dasharray for an Excalidraw strokeStyle. */
export function dashArray(strokeStyle, strokeWidth = 2) {
  if (strokeStyle === 'dashed') return [8, 8 + strokeWidth];
  if (strokeStyle === 'dotted') return [1.5, 6 + strokeWidth];
  return undefined;
}

/**
 * Text layout for a text element (or a label inside a container).
 * Returns { lines: [{ text, x, y }], anchor } in SCENE coordinates — y is the
 * baseline of each line.
 */
export function layoutText(el, container) {
  const fontSize = num(el.fontSize, 20);
  const lh = lineHeightOf(el) * fontSize;
  const lines = String(el.text ?? el.originalText ?? '').split('\n');
  const align = el.textAlign || (container ? 'center' : 'left');
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  let left = num(el.x);
  let top = num(el.y);
  let width = num(el.width) || measureText(el.text, fontSize, el.fontFamily, lineHeightOf(el)).width;
  const blockH = lines.length * lh;
  if (container) {
    const cb = elementBounds(container);
    const pad = 5;
    left = cb.minX + pad;
    width = cb.maxX - cb.minX - pad * 2;
    if (isLinear(container)) {
      const [mx, my] = boundsCenter(cb);
      left = mx - width / 2;
      top = my - blockH / 2;
    } else {
      const va = el.verticalAlign || 'middle';
      if (va === 'top') top = cb.minY + pad;
      else if (va === 'bottom') top = cb.maxY - pad - blockH;
      else top = (cb.minY + cb.maxY) / 2 - blockH / 2;
    }
  }
  const ax = anchor === 'middle' ? left + width / 2 : anchor === 'end' ? left + width : left;
  // Baseline sits ~0.8 em below the line box top, centred in the line height.
  const baseline = (i) => top + i * lh + (lh - fontSize) / 2 + fontSize * 0.82;
  return { lines: lines.map((t, i) => ({ text: t, x: ax, y: baseline(i) })), anchor, fontSize };
}

// ── Render transforms + selection frame ───────────────────────────────────

/**
 * SVG matrix for an element: translate to x/y, rotated by `angle` around the
 * element's bbox centre. Local drawing coordinates start at (0,0) = (x,y).
 */
export function elementMatrix(el) {
  const x = num(el.x);
  const y = num(el.y);
  const angle = num(el.angle);
  if (!angle) return [1, 0, 0, 1, x, y];
  const [cx, cy] = boundsCenter(elementBounds(el));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // R(about c) · T(x,y): p' = R(p + (x,y) - c) + c
  return [c, s, -s, c, c * (x - cx) - s * (y - cy) + cx, s * (x - cx) + c * (y - cy) + cy];
}

export function matrixString(m) {
  return `matrix(${m.map((v) => Math.round(v * 1000) / 1000).join(' ')})`;
}

/**
 * Selection outline in SCENE space. A single element gets its rotated box
 * (with a rotate handle above the top edge); several get the union AABB.
 *   { corners: {nw,ne,se,sw}, angle, center, rotateHandle | null, single }
 */
export function selectionFrame(elements, ids, rotateOffset = 28) {
  const set = new Set(ids || []);
  const picked = (elements || []).filter((e) => set.has(e.id));
  if (!picked.length) return null;
  if (picked.length === 1) {
    const el = picked[0];
    const b = elementBounds(el);
    const angle = num(el.angle);
    const center = boundsCenter(b);
    const rot = (p) => rotatePoint(p[0], p[1], center[0], center[1], angle);
    const corners = {
      nw: rot([b.minX, b.minY]),
      ne: rot([b.maxX, b.minY]),
      se: rot([b.maxX, b.maxY]),
      sw: rot([b.minX, b.maxY]),
    };
    return { corners, angle, center, single: true, rotateHandle: rot([center[0], b.minY - rotateOffset]) };
  }
  const b = unionBounds(picked.map(rotatedBounds));
  return {
    corners: { nw: [b.minX, b.minY], ne: [b.maxX, b.minY], se: [b.maxX, b.maxY], sw: [b.minX, b.maxY] },
    angle: 0,
    center: boundsCenter(b),
    single: false,
    rotateHandle: null,
  };
}

/** Angle (radians) that points the rotate handle at (px,py) from centre (cx,cy). */
export function angleFromHandle(cx, cy, px, py, snap = Math.PI / 12) {
  let a = Math.atan2(py - cy, px - cx) + Math.PI / 2;
  if (snap) {
    const snapped = Math.round(a / snap) * snap;
    if (Math.abs(snapped - a) < 0.06) a = snapped;
  }
  const tau = Math.PI * 2;
  return ((a % tau) + tau) % tau;
}
