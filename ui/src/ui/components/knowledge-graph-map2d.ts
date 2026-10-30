/**
 * Knowledge Graph — the flat 2D map renderer.
 *
 * The canvas drawing of the web graph's 2D mode (`<infinibot-knowledge-graph>`
 * with `?kg2d=1`, or no WebGL): status-orbit guides, group zones, curved
 * gradient links (dashed when inferred, marching ants on the focused node's
 * links), radial-gradient orbs and client hexagons with glow, progress rings,
 * the live pulse, focus / selection bezels and priority-ordered collision-free
 * labels.
 *
 * Shared by the web host and the native mobile graph (bundled into
 * mobile/src/kg/generated/kg-map2d.js by ui/scripts/build-kg-native.mjs, where
 * a Canvas2D → SVG context draws it with react-native-svg), so both maps are
 * the same drawing from the same code. Keep it free of DOM, Lit and three.js:
 * it only talks to a CanvasRenderingContext2D-shaped `ctx`.
 */

import type { Grouping } from "./knowledge-graph-ops";
import { linkAlpha, linkStyle, type ConnectionsMode } from "./knowledge-graph-links";
import { placeLabels, type LabelCandidate } from "./knowledge-graph-model";
import { labelRuleFor, LOD_MINOR_LABELS_ABOVE, type SceneNode } from "./knowledge-graph-scene";

/** Below this zoom the map draws dots only (no gradients, labels, curves). */
export const LOD_DOTS_BELOW = 0.22;
/** More visible nodes than this → the cheap dots path. */
export const CHEAP_NODE_THRESHOLD = 1500;
/** More visible nodes than this → plain squares. */
export const RECT_EMERGENCY = 6000;
/** Most labels drawn per frame. */
export const LABEL_BUDGET = 220;

export const LABEL_FONT = `600 11px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
export const MINOR_LABEL_FONT = `500 10px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
export const GROUP_LABEL_FONT = `700 10px Inter, -apple-system, "Segoe UI", sans-serif`;

/** The canvas API the map uses (a real 2D context, or the native SVG recorder). */
export type Ctx2D = CanvasRenderingContext2D;

export interface Map2DNode extends SceneNode {
  fx?: number | null;
  fy?: number | null;
}

export interface Map2DLink<N extends Map2DNode = Map2DNode> {
  source: N | string | number;
  target: N | string | number;
  rel: string;
  inferred: boolean;
  weight?: number;
}

export interface Map2DViewport {
  x: number;
  y: number;
  k: number;
}

export interface LabelInfo {
  text: string;
  pri: number;
  cls: string;
  font: string;
  quiet: boolean;
  scale: number;
}

/** Everything one frame of the map reads. */
export interface Map2DFrame<N extends Map2DNode = Map2DNode> {
  w: number;
  h: number;
  dpr: number;
  viewport: Map2DViewport;
  /** Centre of the status-orbit guide rings (layout px). */
  center: { cx: number; cy: number };
  nodes: N[];
  links: Array<Map2DLink<N>>;
  nodeById: Map<string, N>;
  grouping: Grouping | null;
  groupMode: string;
  search: string;
  connectionsMode: ConnectionsMode;
  selection: ReadonlySet<string>;
  dropTarget: { id: string } | null;
  selectedId: string | null;
  hoveredId: string | null;
  hoverScale: number;
  dashPhase: number;
  reducedMotion: boolean;
  now: number;
  emphasis(n: N, focusId: string | null, nbh: Set<string> | null): number;
  neighbourhood(focusId: string | null): Set<string> | null;
  labelInfo(n: N, k: number, focusId: string | null, nbh: Set<string> | null, minorOk: boolean): LabelInfo | null;
  labelWidth(font: string, text: string, ctx: Ctx2D): number;
}

export interface Map2DFrameResult<N extends Map2DNode = Map2DNode> {
  visible: N[];
  dotsOnly: boolean;
}

// ── Colour utilities (hex/rgb aware) ─────────────────────────────────────

export function parseColor(c: string): [number, number, number, number] {
  c = c.trim();
  if (c.startsWith("#")) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    const num = parseInt(h, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255, 1];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((s) => parseFloat(s));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] ?? 1];
  }
  return [255, 255, 255, 1];
}

export function withAlpha(c: string, a: number): string {
  const [r, g, b] = parseColor(c);
  return `rgba(${r},${g},${b},${a})`;
}

export function lighten(c: string, amt: number): string {
  const [r, g, b] = parseColor(c);
  return `rgb(${Math.round(r + (255 - r) * amt)},${Math.round(g + (255 - g) * amt)},${Math.round(b + (255 - b) * amt)})`;
}

export function darken(c: string, amt: number): string {
  const [r, g, b] = parseColor(c);
  return `rgb(${Math.round(r * (1 - amt))},${Math.round(g * (1 - amt))},${Math.round(b * (1 - amt))})`;
}

// ── Label rule (2D) ──────────────────────────────────────────────────────

/** The 2D map's label: the shared rule + its canvas font (scaled for big nodes). */
export function labelInfo2d(
  n: SceneNode,
  k: number,
  ctx: { focusId: string | null; nbh: Set<string> | null; highlightSet: Set<string> | null; minorOk: boolean; degree: ArrayLike<number>; stage3d: boolean },
): LabelInfo | null {
  const rule = labelRuleFor(n, k, ctx);
  if (!rule) return null;
  const font = n.anchor && !rule.quiet ? LABEL_FONT : MINOR_LABEL_FONT;
  const scale = rule.scale;
  return {
    ...rule,
    font: scale > 1.01 ? font.replace(/(\d+(?:\.\d+)?)px/, (_m, px: string) => `${(Number(px) * scale).toFixed(1)}px`) : font,
  };
}

// ── Frame ────────────────────────────────────────────────────────────────

/** Draw one frame of the map into `ctx` (device px = CSS px × dpr). */
export function drawMap2d<N extends Map2DNode>(ctx: Ctx2D, f: Map2DFrame<N>): Map2DFrameResult<N> {
  const { w, h } = f;
  const k = f.viewport.k;
  const ox = f.viewport.x;
  const oy = f.viewport.y;

  ctx.save();
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.translate(ox, oy);
  ctx.scale(k, k);

  // Viewport culling bounds (world space, with margin).
  const margin = 80 / k;
  const minX = (0 - ox) / k - margin;
  const minY = (0 - oy) / k - margin;
  const maxX = (w - ox) / k + margin;
  const maxY = (h - oy) / k + margin;
  const inView = (x?: number, y?: number): boolean =>
    x != null && y != null && x >= minX && x <= maxX && y >= minY && y <= maxY;

  const visible: N[] = [];
  for (const n of f.nodes) {
    if (inView(n.x, n.y)) visible.push(n);
  }
  const dotsOnly = k < LOD_DOTS_BELOW || visible.length > CHEAP_NODE_THRESHOLD;

  const focusId = f.selectedId ?? f.hoveredId;
  const nbh = f.neighbourhood(focusId);

  // Faint orbit guides give the status rings a sense of place.
  if (!dotsOnly && f.nodes.length && !f.search && f.groupMode === "orbit") drawOrbitGuides(ctx, f, k);
  const groupLabels = drawGroupHalos2d(ctx, f, k);

  // ── Edges ──────────────────────────────────────────────────
  const edgeInView = (s: N, t: N): boolean =>
    !(
      Math.max(s.x!, t.x!) < minX ||
      Math.min(s.x!, t.x!) > maxX ||
      Math.max(s.y!, t.y!) < minY ||
      Math.min(s.y!, t.y!) > maxY
    );

  if (dotsOnly) {
    ctx.lineWidth = Math.max(0.6 / k, 0.4);
    ctx.strokeStyle = "rgba(212,175,55,0.22)";
    ctx.beginPath();
    for (const l of f.links) {
      const s = l.source as N;
      const t = l.target as N;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
      if (!edgeInView(s, t)) continue;
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
    }
    ctx.stroke();
  } else {
    ctx.lineCap = "round";
    const active: Array<Map2DLink<N>> = [];
    for (const l of f.links) {
      const s = l.source as N;
      const t = l.target as N;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
      if (!edgeInView(s, t)) continue;
      if (focusId && (s.id === focusId || t.id === focusId)) {
        if (f.connectionsMode !== "none") active.push(l);
        continue;
      }
      const e = Math.min(f.emphasis(s, focusId, nbh), f.emphasis(t, focusId, nbh));
      const a = linkAlpha({
        mode: f.connectionsMode,
        focused: false,
        hasFocus: !!focusId,
        inNeighbourhood: !!nbh && nbh.has(s.id) && nbh.has(t.id),
        style: linkStyle(l.rel, l.inferred),
        emphasis: e,
        cross: false,
        hubDamp: 1,
        density: 0,
      });
      drawCurvedEdge(ctx, f, l, k, a, false);
    }
    // A hub with a big fan-out (an expanded project's tasks) gets calm,
    // static spokes — hundreds of marching-ant curves are pure noise.
    const calm = active.length > 40;
    for (const l of active) drawCurvedEdge(ctx, f, l, k, calm ? 0.45 : 1, !calm);
    ctx.setLineDash([]);
  }

  // ── Nodes ──────────────────────────────────────────────────
  if (visible.length > RECT_EMERGENCY) {
    const byColour = new Map<string, N[]>();
    for (const n of visible) {
      let arr = byColour.get(n.color);
      if (!arr) byColour.set(n.color, (arr = []));
      arr.push(n);
    }
    for (const [colour, group] of byColour) {
      ctx.fillStyle = colour;
      for (const n of group) ctx.fillRect(n.x! - n.r, n.y! - n.r, n.r * 2, n.r * 2);
    }
  } else if (dotsOnly) {
    const byColour = new Map<string, N[]>();
    for (const n of visible) {
      let arr = byColour.get(n.color);
      if (!arr) byColour.set(n.color, (arr = []));
      arr.push(n);
    }
    for (const [colour, group] of byColour) {
      ctx.fillStyle = colour;
      ctx.beginPath();
      for (const n of group) {
        ctx.moveTo(n.x! + n.r, n.y!);
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  } else {
    // Minor nodes first, anchors on top, the focused node last.
    const minor: N[] = [];
    const anchors: N[] = [];
    for (const n of visible) (n.anchor ? anchors : minor).push(n);
    for (const n of minor) drawNode(ctx, f, n, k, f.emphasis(n, focusId, nbh));
    for (const n of anchors) drawNode(ctx, f, n, k, f.emphasis(n, focusId, nbh));
  }
  if (focusId) {
    const fn = f.nodeById.get(focusId);
    if (fn && fn.x != null) drawFocusRing(ctx, fn, k);
  }
  // Selection + drop-target bezels (cyan, dashed).
  if (f.selection.size || f.dropTarget) {
    ctx.save();
    ctx.lineWidth = 1.6 / k;
    ctx.setLineDash([5 / k, 4 / k]);
    ctx.strokeStyle = "rgba(94, 231, 255, 0.9)";
    ctx.beginPath();
    for (const id of f.selection) {
      const n = f.nodeById.get(id);
      if (!n || !inView(n.x, n.y)) continue;
      ctx.moveTo(n.x! + n.r + 5 / k, n.y!);
      ctx.arc(n.x!, n.y!, n.r + 5 / k, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── Labels (screen space, collision-free) ──────────────────
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  drawLabels(ctx, f, visible, k, ox, oy, focusId, nbh, dotsOnly);
  if (groupLabels.length) {
    ctx.font = GROUP_LABEL_FONT;
    ctx.textAlign = "center";
    for (const g of groupLabels) {
      const sx = g.x * k + ox;
      const sy = (g.y + g.r) * k + oy + 14;
      if (sx < -40 || sx > w + 40 || sy < -10 || sy > h + 20) continue;
      ctx.fillStyle = withAlpha(g.color, 0.85);
      ctx.fillText(g.label.toUpperCase(), sx, sy);
    }
    ctx.textAlign = "start";
  }
  ctx.restore();
  return { visible, dotsOnly };
}

/** Group zones for the flat map: soft disc + rim per group. Returns label anchors. */
export function drawGroupHalos2d<N extends Map2DNode>(
  ctx: Ctx2D,
  f: Pick<Map2DFrame<N>, "grouping" | "nodeById">,
  k: number,
): Array<{ x: number; y: number; r: number; label: string; color: string }> {
  const g = f.grouping;
  if (!g || g.mode === "orbit" || !g.groups.length) return [];
  const out: Array<{ x: number; y: number; r: number; label: string; color: string }> = [];
  for (const grp of g.groups.slice(0, 80)) {
    let sx = 0, sy = 0, n = 0;
    const members: N[] = [];
    for (const id of grp.memberIds) {
      const m = f.nodeById.get(id);
      if (!m || m.x == null || m.y == null) continue;
      sx += m.x;
      sy += m.y;
      n++;
      members.push(m);
    }
    if (n < (g.mode === "project" ? 2 : 1)) continue;
    const cx = sx / n, cy = sy / n;
    let r = 0;
    for (const m of members) r = Math.max(r, Math.hypot(m.x! - cx, m.y! - cy) + m.r * 1.6);
    r = Math.max(30, r + 14);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, withAlpha(grp.color, 0.07));
    grad.addColorStop(1, withAlpha(grp.color, 0.015));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.2 / k;
    ctx.strokeStyle = withAlpha(grp.color, 0.4);
    ctx.stroke();
    out.push({ x: cx, y: cy, r, label: `${grp.label} · ${n}`, color: grp.color });
  }
  return out;
}

export function drawOrbitGuides<N extends Map2DNode>(ctx: Ctx2D, f: Pick<Map2DFrame<N>, "nodes" | "center">, k: number): void {
  const radii = new Set<number>();
  for (const n of f.nodes) if (n.kind === "project" && n.orbit) radii.add(n.orbit);
  ctx.save();
  ctx.setLineDash([2 / k, 7 / k]);
  ctx.lineWidth = 1 / k;
  ctx.strokeStyle = "rgba(212,175,55,0.09)";
  for (const r of radii) {
    ctx.beginPath();
    ctx.arc(f.center.cx, f.center.cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Curved, gradient-stroked bezier edge; inferred links are dashed. */
export function drawCurvedEdge<N extends Map2DNode>(
  ctx: Ctx2D,
  f: Pick<Map2DFrame<N>, "reducedMotion" | "dashPhase">,
  l: Map2DLink<N>,
  k: number,
  alpha: number,
  active: boolean,
): void {
  if (alpha < 0.03) return;
  const s = l.source as N;
  const t = l.target as N;
  const sx = s.x!, sy = s.y!, tx = t.x!, ty = t.y!;
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist, ny = dy / dist;
  const startX = sx + nx * s.r;
  const startY = sy + ny * s.r;
  const endX = tx - nx * (t.r + 2);
  const endY = ty - ny * (t.r + 2);
  const px = -ny, py = nx;
  const bow = Math.min(dist * 0.12, 30);
  const c1x = startX + dx * 0.25 + px * bow;
  const c1y = startY + dy * 0.25 + py * bow;
  const c2x = startX + dx * 0.75 + px * bow;
  const c2y = startY + dy * 0.75 + py * bow;

  ctx.globalAlpha = alpha;
  const st = linkStyle(l.rel, l.inferred);
  if (active) {
    ctx.strokeStyle = st.cls === "relates" || st.cls === "other" ? "#f5c542" : st.color;
    ctx.lineWidth = (st.width * 1.2) / k;
    ctx.setLineDash(f.reducedMotion ? [] : [6 / k, 5 / k]);
    ctx.lineDashOffset = -f.dashPhase / k;
  } else {
    const grad = ctx.createLinearGradient(startX, startY, endX, endY);
    grad.addColorStop(0, withAlpha(st.color, 0.6));
    grad.addColorStop(0.5, withAlpha(st.color, 0.9));
    grad.addColorStop(1, withAlpha(st.color, 0.6));
    ctx.strokeStyle = grad;
    ctx.lineWidth = (st.width * (s.anchor && t.anchor ? 0.8 : 0.6)) / k;
    ctx.setLineDash(l.inferred ? [3 / k, 4 / k] : []);
  }
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, endX, endY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export function drawNode<N extends Map2DNode>(
  ctx: Ctx2D,
  f: Pick<Map2DFrame<N>, "hoveredId" | "hoverScale" | "reducedMotion" | "now">,
  n: N,
  k: number,
  emphasis: number,
): void {
  const x = n.x!, y = n.y!;
  const hovered = n.id === f.hoveredId;
  const r = n.r * (hovered ? f.hoverScale : 1);
  const alpha = hovered ? 1 : emphasis;
  if (alpha < 0.03) return;
  ctx.globalAlpha = alpha;

  const live =
    (n.kind === "project" && n.meta?.live === true) || (n.kind === "run" && n.meta?.active === true);
  if (live && !f.reducedMotion && alpha > 0.5) {
    // Soft outward pulse while an agent is working here.
    const phase = (f.now % 1800) / 1800;
    ctx.beginPath();
    ctx.arc(x, y, r + 3 + phase * 16, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(n.color, 0.55 * (1 - phase));
    ctx.lineWidth = 2 / k;
    ctx.stroke();
  }

  const open = n.kind === "project" && n.health !== "backlog" && n.health !== "done";
  if (open || hovered) {
    ctx.shadowColor = withAlpha(n.color, 0.75);
    ctx.shadowBlur = (hovered ? 18 : 12) * Math.min(1, k * 1.5);
  }
  ctx.beginPath();
  if (n.kind === "client") hexPath(ctx, x, y, r);
  else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = nodeGradient(ctx, n.color, x, y, r);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  if (n.anchor) {
    ctx.lineWidth = Math.max(1.1 / k, 0.6);
    ctx.strokeStyle = n.kind === "client" ? "rgba(255,236,170,0.9)" : lighten(n.color, 0.5);
    ctx.stroke();
  }

  if (n.kind === "project" && Number(n.meta?.tasks ?? 0) > 0) {
    // Progress ring: faint track + gold arc for the done fraction.
    const progress = Math.max(0, Math.min(1, Number(n.meta?.progress ?? 0)));
    const rr = r + 3.2;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.stroke();
    if (progress > 0) {
      ctx.beginPath();
      ctx.arc(x, y, rr, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = "#f5c542";
      ctx.lineCap = "round";
      ctx.stroke();
    }
  } else if (n.kind === "client") {
    ctx.beginPath();
    hexPath(ctx, x, y, r + 3.5);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "rgba(232,197,107,0.35)";
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawFocusRing(ctx: Ctx2D, n: Map2DNode, k: number): void {
  ctx.beginPath();
  ctx.arc(n.x!, n.y!, n.r + 8, 0, Math.PI * 2);
  ctx.lineWidth = 1.4 / k;
  ctx.strokeStyle = "rgba(245,197,66,0.9)";
  ctx.setLineDash([4 / k, 3 / k]);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function hexPath(ctx: Ctx2D, x: number, y: number, r: number): void {
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Radial gradient (bright crown → saturated rim). */
export function nodeGradient(ctx: Ctx2D, color: string, x: number, y: number, r: number): CanvasGradient {
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, lighten(color, 0.5));
  g.addColorStop(0.55, color);
  g.addColorStop(1, darken(color, 0.3));
  return g;
}

/** Priority-ordered, collision-free labels in screen space. */
export function drawLabels<N extends Map2DNode>(
  ctx: Ctx2D,
  f: Pick<Map2DFrame<N>, "labelInfo" | "labelWidth">,
  visible: N[],
  k: number,
  ox: number,
  oy: number,
  focusId: string | null,
  nbh: Set<string> | null,
  dotsOnly: boolean,
): void {
  const minorOk = k > LOD_MINOR_LABELS_ABOVE && !dotsOnly;
  type Cand = LabelCandidate & { n: N; text: string; font: string; pri: number };
  const cands: Cand[] = [];
  for (const n of visible) {
    const info = f.labelInfo(n, k, focusId, nbh, minorOk);
    if (!info) continue;
    const sx = n.x! * k + ox + n.r * k + 5;
    const sy = n.y! * k + oy;
    cands.push({
      n,
      text: info.text,
      font: info.font,
      pri: info.pri,
      x: sx,
      y: sy,
      width: f.labelWidth(info.font, info.text, ctx) + 4,
      height: 14 * info.scale,
    });
  }
  cands.sort((a, b) => b.pri - a.pri);
  const accepted = placeLabels(cands, 48, LABEL_BUDGET);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const i of accepted) {
    const c = cands[i];
    const n = c.n;
    ctx.font = c.font;
    const focused = n.id === focusId;
    const quiet = n.kind === "project" && (n.health === "backlog" || n.health === "done");
    ctx.globalAlpha = focused || c.pri >= 4_000 ? 1 : quiet ? 0.55 : n.anchor ? 0.94 : 0.72;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(6,4,12,0.85)";
    ctx.strokeText(c.text, c.x, c.y);
    ctx.fillStyle = focused
      ? "#ffd970"
      : n.kind === "client"
        ? "#f6ead0"
        : n.kind === "project"
          ? "#f4efe2"
          : "rgba(212,212,216,0.9)";
    ctx.fillText(c.text, c.x, c.y);
  }
  ctx.globalAlpha = 1;
}

// ── Viewport maths (shared by the web map and the native 2D stage) ───────

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 6;

/** Frame `ids` (world px) in a w×h stage with side pads, capped at `maxK`. */
export function fitViewport(
  nodes: Iterable<Map2DNode | undefined>,
  size: { w: number; h: number },
  opts: { maxK?: number; leftPad?: number; rightPad?: number } = {},
): Map2DViewport | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let n = 0;
  for (const node of nodes) {
    if (!node || node.x == null || node.y == null) continue;
    x0 = Math.min(x0, node.x - node.r);
    y0 = Math.min(y0, node.y - node.r);
    x1 = Math.max(x1, node.x + node.r);
    y1 = Math.max(y1, node.y + node.r);
    n++;
  }
  if (!n) return null;
  const { w, h } = size;
  const leftPad = opts.leftPad ?? 40;
  const rightPad = opts.rightPad ?? 40;
  const availW = Math.max(200, w - leftPad - rightPad);
  const pad = 60;
  const k = Math.max(MIN_ZOOM, Math.min(opts.maxK ?? 1.8, Math.min(availW / (x1 - x0 + pad * 2), h / (y1 - y0 + pad * 2))));
  return {
    x: leftPad + availW / 2 - ((x0 + x1) / 2) * k,
    y: h / 2 - ((y0 + y1) / 2) * k,
    k,
  };
}

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAround(v: Map2DViewport, factor: number, px: number, py: number): Map2DViewport {
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
  const k0 = v.k;
  return {
    x: px - (px - v.x) * (next / k0),
    y: py - (py - v.y) * (next / k0),
    k: next,
  };
}

/** Nearest node to world (x, y) within the tap reach (null when none). */
export function hitTest2d<N extends Map2DNode>(nodes: readonly N[], x: number, y: number, k: number, exclude: N | null = null, extraReach = 0): N | null {
  const reach = Math.max(10 / k, 20) + extraReach;
  let best: N | null = null;
  let bestD = Infinity;
  for (const d of nodes) {
    if (d === exclude || d.x == null || d.y == null) continue;
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist > reach || dist >= bestD) continue;
    best = d;
    bestD = dist;
  }
  if (!best) return null;
  return bestD <= best.r + 6 / k ? best : null;
}

/** Nearest node whose disc (+6 px) contains world (x, y), skipping `exclude` (drop / link targets). */
export function hitTestExcept2d<N extends Map2DNode>(nodes: readonly N[], x: number, y: number, k: number, exclude: N | null): N | null {
  let best: N | null = null;
  let bestD = Infinity;
  for (const d of nodes) {
    if (d === exclude || d.x == null || d.y == null) continue;
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist <= d.r + 6 / k && dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}
