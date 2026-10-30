/**
 * Diagram layout engine — converts a small declarative request into a
 * laid-out Excalidraw scene the agent can hand to `create_batch`.
 *
 * Why this lives MCP-side: every layout decision (node sizing, edge
 * routing, palette mapping) is shared between the gateway RPC and the
 * MCP tool. Computing in the agent's process means the same JSON works
 * across surfaces — UI / CLI / direct MCP call — without each one
 * reinventing the math.
 *
 * Each layout writes nodes first, then edges (arrows). Arrows are bound
 * to node ids via startBinding/endBinding so the operator can drag a
 * shape and the arrow follows. This matches Excalidraw's own connector
 * behavior — no custom rendering required.
 *
 * The five supported kinds:
 *
 *   flowchart      Top-down (default) or left-right, with decisions
 *                  rendered as diamonds. One node per row/column.
 *   sequence       Actors across the top, lifelines vertical, message
 *                  arrows between lifelines (one row per edge).
 *   erd            Entities in a grid, foreign keys as labeled arrows.
 *   mindmap        Central node + radial spokes. Sub-nodes wrap.
 *   architecture   Grid of grouped boxes (system layers) with arrows
 *                  between them.
 *
 * All sizes/colors derive from `palette` below so a diagram stays
 * coherent. Operators can override by passing the resulting elements
 * through `update_batch` afterwards.
 */
import type { CanvasElement } from "./elements.js";

// ─── Public types ─────────────────────────────────────────────────────

export type DiagramKind = "flowchart" | "sequence" | "erd" | "mindmap" | "architecture";

export type NodeKind = "process" | "decision" | "data" | "actor" | "start" | "end" | "group" | "note";

export type EdgeKind = "solid" | "dashed" | "dotted";

export interface DiagramNode {
  id: string;
  label?: string;
  kind?: NodeKind;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
}

export interface DiagramRequest {
  kind: DiagramKind;
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  direction?: "LR" | "TB";
  origin?: { x: number; y: number };
  merge?: boolean;
  fit?: boolean;
}

export interface DiagramResult {
  elements: Array<Partial<CanvasElement>>;
  edges: Array<Partial<CanvasElement>>;
}

// ─── Palette ──────────────────────────────────────────────────────────
//
// Semantic colors tuned for readability on both light (Excalidraw
// default white) and the InfiniBot dark theme. Mirrored in
// skills/excalidraw/palette.json so agents can read the same source.

export const palette: Record<NodeKind, { stroke: string; fill: string; text: string }> = {
  process: { stroke: "#1e40af", fill: "#dbeafe", text: "#0f172a" },
  decision: { stroke: "#b45309", fill: "#fef3c7", text: "#0f172a" },
  data: { stroke: "#15803d", fill: "#dcfce7", text: "#0f172a" },
  actor: { stroke: "#7c3aed", fill: "#ede9fe", text: "#0f172a" },
  start: { stroke: "#15803d", fill: "#dcfce7", text: "#0f172a" },
  end: { stroke: "#b91c1c", fill: "#fee2e2", text: "#0f172a" },
  group: { stroke: "#475569", fill: "#f1f5f9", text: "#0f172a" },
  note: { stroke: "#a3a3a3", fill: "#fafafa", text: "#0f172a" },
};

const EDGE_STROKE = "#3b3b3b";

// ─── Sizing ───────────────────────────────────────────────────────────

const NODE_WIDTH = 200;
const NODE_HEIGHT = 90;
const H_GAP = 80; // horizontal gap between nodes (siblings in TB layout)
const V_GAP = 70; // vertical gap (rows in TB)
const SEQUENCE_LIFELINE_HEIGHT = 60; // spacing per message in a sequence

// Approximate width needed to render `label`. The Excalidraw runtime
// reflows on mount, but we need a starting box big enough to avoid
// truncation. 11px per char + padding is empirically close for the
// default 20px Virgil font.
function widthForLabel(label: string | undefined): number {
  if (!label) return NODE_WIDTH;
  const approx = 24 + label.length * 11;
  return Math.max(NODE_WIDTH, Math.min(360, approx));
}

// ─── Shape helpers ────────────────────────────────────────────────────

function shapeFor(kind: NodeKind | undefined): "rectangle" | "ellipse" | "diamond" {
  switch (kind) {
    case "decision":
      return "diamond";
    case "data":
    case "start":
    case "end":
    case "actor":
      return "ellipse";
    case "group":
    case "note":
    case "process":
    default:
      return "rectangle";
  }
}

function makeNode(
  node: DiagramNode,
  x: number,
  y: number,
  width = NODE_WIDTH,
  height = NODE_HEIGHT,
): Partial<CanvasElement> {
  const kind = node.kind ?? "process";
  const color = palette[kind];
  return {
    id: node.id,
    type: shapeFor(kind),
    x,
    y,
    width,
    height,
    text: node.label ?? node.id,
    strokeColor: color.stroke,
    backgroundColor: color.fill,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    fontSize: 18,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
  };
}

function makeArrow(
  fromId: string,
  toId: string,
  fromBox: { x: number; y: number; w: number; h: number },
  toBox: { x: number; y: number; w: number; h: number },
  label?: string,
  kind: EdgeKind = "solid",
): Partial<CanvasElement> {
  const fx = fromBox.x + fromBox.w / 2;
  const fy = fromBox.y + fromBox.h / 2;
  const tx = toBox.x + toBox.w / 2;
  const ty = toBox.y + toBox.h / 2;
  const arrow: Partial<CanvasElement> = {
    type: "arrow",
    x: fx,
    y: fy,
    width: tx - fx,
    height: ty - fy,
    points: [
      [0, 0],
      [tx - fx, ty - fy],
    ],
    startBinding: { elementId: fromId, focus: 0, gap: 4 },
    endBinding: { elementId: toId, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: "arrow",
    strokeColor: EDGE_STROKE,
    strokeStyle: kind,
    strokeWidth: 2,
    roughness: 0,
  };
  if (label) arrow.text = label;
  return arrow;
}

// ─── Layouts ──────────────────────────────────────────────────────────

interface LayoutContext {
  request: DiagramRequest;
  originX: number;
  originY: number;
}

function layoutFlowchart(ctx: LayoutContext): DiagramResult {
  const { request, originX, originY } = ctx;
  const dir = request.direction ?? "TB";
  const nodes = request.nodes;
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  const elements: Array<Partial<CanvasElement>> = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const w = widthForLabel(n.label ?? n.id);
    const h = NODE_HEIGHT;
    let x: number;
    let y: number;
    if (dir === "LR") {
      x = originX + i * (NODE_WIDTH + H_GAP);
      y = originY;
    } else {
      x = originX;
      y = originY + i * (NODE_HEIGHT + V_GAP);
    }
    positions.set(n.id, { x, y, w, h });
    elements.push(makeNode(n, x, y, w, h));
  }

  const edges: Array<Partial<CanvasElement>> = [];
  for (const e of request.edges ?? []) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue;
    edges.push(makeArrow(e.from, e.to, from, to, e.label, e.kind));
  }
  return { elements, edges };
}

function layoutSequence(ctx: LayoutContext): DiagramResult {
  const { request, originX, originY } = ctx;
  const actors = request.nodes;
  const messages = request.edges ?? [];
  const actorY = originY;
  const actorH = 60;
  const lifelineStartY = actorY + actorH + 20;
  const lifelineEndY = lifelineStartY + Math.max(120, messages.length * SEQUENCE_LIFELINE_HEIGHT + 40);

  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  const elements: Array<Partial<CanvasElement>> = [];

  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    const w = widthForLabel(a.label ?? a.id);
    const x = originX + i * (NODE_WIDTH + H_GAP);
    const y = actorY;
    positions.set(a.id, { x, y, w, h: actorH });
    // Actor box at top
    elements.push(makeNode({ ...a, kind: a.kind ?? "actor" }, x, y, w, actorH));
    // Lifeline (dashed vertical line)
    elements.push({
      id: `lifeline-${a.id}`,
      type: "line",
      x: x + w / 2,
      y: lifelineStartY,
      width: 0,
      height: lifelineEndY - lifelineStartY,
      points: [
        [0, 0],
        [0, lifelineEndY - lifelineStartY],
      ],
      strokeColor: palette.actor.stroke,
      strokeStyle: "dashed",
      strokeWidth: 1,
      roughness: 0,
    });
  }

  const edges: Array<Partial<CanvasElement>> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const from = positions.get(m.from);
    const to = positions.get(m.to);
    if (!from || !to) continue;
    const y = lifelineStartY + 30 + i * SEQUENCE_LIFELINE_HEIGHT;
    const fx = from.x + from.w / 2;
    const tx = to.x + to.w / 2;
    edges.push({
      type: "arrow",
      x: fx,
      y,
      width: tx - fx,
      height: 0,
      points: [
        [0, 0],
        [tx - fx, 0],
      ],
      endArrowhead: "arrow",
      strokeColor: EDGE_STROKE,
      strokeStyle: m.kind ?? "solid",
      strokeWidth: 2,
      roughness: 0,
      text: m.label,
    });
  }
  return { elements, edges };
}

function layoutErd(ctx: LayoutContext): DiagramResult {
  const { request, originX, originY } = ctx;
  const nodes = request.nodes;
  const columns = Math.ceil(Math.sqrt(nodes.length)) || 1;
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  const elements: Array<Partial<CanvasElement>> = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const col = i % columns;
    const row = Math.floor(i / columns);
    const w = widthForLabel(n.label ?? n.id);
    const h = NODE_HEIGHT + 30;
    const x = originX + col * (NODE_WIDTH + H_GAP + 40);
    const y = originY + row * (h + V_GAP);
    positions.set(n.id, { x, y, w, h });
    elements.push(makeNode({ ...n, kind: n.kind ?? "data" }, x, y, w, h));
  }

  const edges: Array<Partial<CanvasElement>> = [];
  for (const e of request.edges ?? []) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue;
    edges.push(makeArrow(e.from, e.to, from, to, e.label ?? "FK", e.kind ?? "solid"));
  }
  return { elements, edges };
}

function layoutMindmap(ctx: LayoutContext): DiagramResult {
  const { request, originX, originY } = ctx;
  const nodes = request.nodes;
  if (nodes.length === 0) return { elements: [], edges: [] };
  const [center, ...rest] = nodes;
  const radius = 260;
  const cx = originX + 400;
  const cy = originY + 300;
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  const elements: Array<Partial<CanvasElement>> = [];

  const centerW = widthForLabel(center.label ?? center.id);
  const centerH = NODE_HEIGHT;
  const centerX = cx - centerW / 2;
  const centerY = cy - centerH / 2;
  positions.set(center.id, { x: centerX, y: centerY, w: centerW, h: centerH });
  elements.push(makeNode({ ...center, kind: center.kind ?? "process" }, centerX, centerY, centerW, centerH));

  for (let i = 0; i < rest.length; i++) {
    const n = rest[i];
    const angle = (i / rest.length) * Math.PI * 2 - Math.PI / 2;
    const w = widthForLabel(n.label ?? n.id);
    const h = NODE_HEIGHT;
    const x = cx + Math.cos(angle) * radius - w / 2;
    const y = cy + Math.sin(angle) * radius - h / 2;
    positions.set(n.id, { x, y, w, h });
    elements.push(makeNode(n, x, y, w, h));
  }

  // Auto-connect the center to every other node if no edges supplied;
  // otherwise honor the supplied edges.
  const edges: Array<Partial<CanvasElement>> = [];
  const supplied = request.edges ?? [];
  const sources: DiagramEdge[] =
    supplied.length > 0 ? supplied : rest.map((r) => ({ from: center.id, to: r.id }));
  for (const e of sources) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue;
    edges.push(makeArrow(e.from, e.to, from, to, e.label, e.kind));
  }
  return { elements, edges };
}

function layoutArchitecture(ctx: LayoutContext): DiagramResult {
  const { request, originX, originY } = ctx;
  const nodes = request.nodes;
  // Group nodes into rows by `kind === "group"` boundaries. Every group
  // marker starts a new row; subsequent non-group nodes pack into that
  // row. If no groups present, fall back to the flowchart layout.
  const groups: Array<{ name: string; members: DiagramNode[] }> = [];
  let current: { name: string; members: DiagramNode[] } | null = null;
  for (const n of nodes) {
    if (n.kind === "group") {
      current = { name: n.label ?? n.id, members: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { name: "Layer", members: [] };
        groups.push(current);
      }
      current.members.push(n);
    }
  }
  if (groups.length === 0) return layoutFlowchart(ctx);

  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  const elements: Array<Partial<CanvasElement>> = [];
  const rowH = NODE_HEIGHT + 60;

  for (let r = 0; r < groups.length; r++) {
    const g = groups[r];
    const rowY = originY + r * (rowH + 30);
    const widths = g.members.map((m) => widthForLabel(m.label ?? m.id));
    const totalW = widths.reduce((s, w) => s + w, 0) + Math.max(0, g.members.length - 1) * H_GAP;
    const groupX = originX;
    const groupW = Math.max(totalW + 40, 400);
    // Group frame
    elements.push({
      id: `group-${r}`,
      type: "rectangle",
      x: groupX,
      y: rowY,
      width: groupW,
      height: rowH,
      strokeColor: palette.group.stroke,
      backgroundColor: palette.group.fill,
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "dashed",
      roughness: 0,
      opacity: 100,
    });
    // Group label as a text element pinned to the top-left
    elements.push({
      id: `group-${r}-label`,
      type: "text",
      x: groupX + 14,
      y: rowY + 8,
      width: 200,
      height: 22,
      text: g.name,
      fontSize: 14,
      fontFamily: 1,
      strokeColor: palette.group.stroke,
      backgroundColor: "transparent",
      textAlign: "left",
      verticalAlign: "top",
    });

    let cursorX = groupX + 20;
    const innerY = rowY + 36;
    for (let i = 0; i < g.members.length; i++) {
      const m = g.members[i];
      const w = widths[i];
      const h = NODE_HEIGHT;
      positions.set(m.id, { x: cursorX, y: innerY, w, h });
      elements.push(makeNode(m, cursorX, innerY, w, h));
      cursorX += w + H_GAP;
    }
  }

  const edges: Array<Partial<CanvasElement>> = [];
  for (const e of request.edges ?? []) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue;
    edges.push(makeArrow(e.from, e.to, from, to, e.label, e.kind));
  }
  return { elements, edges };
}

// ─── Entry point ──────────────────────────────────────────────────────

export function buildDiagram(req: DiagramRequest): DiagramResult {
  if (!req || typeof req !== "object") throw new Error("invalid diagram request");
  if (!Array.isArray(req.nodes)) throw new Error("nodes must be an array");
  const originX = req.origin?.x ?? 80;
  const originY = req.origin?.y ?? 80;
  const ctx: LayoutContext = { request: req, originX, originY };
  switch (req.kind) {
    case "flowchart":
      return layoutFlowchart(ctx);
    case "sequence":
      return layoutSequence(ctx);
    case "erd":
      return layoutErd(ctx);
    case "mindmap":
      return layoutMindmap(ctx);
    case "architecture":
      return layoutArchitecture(ctx);
    default:
      throw new Error(`unknown diagram kind: ${req.kind}`);
  }
}
