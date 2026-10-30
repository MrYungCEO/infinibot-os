/**
 * graph-engine.ts — lightweight ambient knowledge-graph feed.
 *
 * A SMALL, self-contained event graph that lives anchored in the iso world (the
 * host element passes a world-anchored centre each frame, so the cluster drifts
 * with the map). This is intentionally NOT the heavy <infinibot-knowledge-graph>
 * — hard cap of MAX_NODES, oldest evicted, canvas-rendered, with a cheap
 * spring/repulsion layout plus a slow orbital drift.
 *
 * Nodes are recent events (spawn / tool / edit / federation / utterance).
 * Edges are causal links (an agent's tool/edit nodes link back to its spawn;
 * an utterance links to the spawn it triggered).
 */

import { type EventKind, type PerfTier, rgba } from "./core.js";

const MAX_NODES = 40;

interface GNode {
  id: string;
  kind: EventKind;
  label: string;
  /** Causal key (e.g. sessionKey) used to wire edges. */
  group?: string;
  born: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

interface GEdge {
  from: string;
  to: string;
  born: number;
}

export class GraphEngine {
  private nodes: GNode[] = [];
  private edges: GEdge[] = [];
  private order = 0;

  get nodeCount(): number {
    return this.nodes.length;
  }

  /**
   * Push an event node. `group` (sessionKey) wires a causal edge to the most
   * recent node sharing it. Spawns become hubs; tool/edit/utterance orbit them.
   */
  push(opts: {
    id: string;
    kind: EventKind;
    label: string;
    group?: string;
    now: number;
    seedAngle: number;
  }): void {
    if (this.nodes.some((n) => n.id === opts.id)) return;

    // Spawn near the most recent same-group node (so a run clusters), else ring.
    const anchor = opts.group
      ? [...this.nodes].reverse().find((n) => n.group === opts.group)
      : undefined;
    const radius = 26 + (this.order % 5) * 6;
    const ang = opts.seedAngle;
    const node: GNode = {
      id: opts.id,
      kind: opts.kind,
      label: opts.label.slice(0, 22),
      group: opts.group,
      born: opts.now,
      x: (anchor?.x ?? 0) + Math.cos(ang) * radius,
      y: (anchor?.y ?? 0) + Math.sin(ang) * radius,
      vx: 0,
      vy: 0,
      r: opts.kind === "spawn" ? 5.5 : opts.kind === "utterance" ? 3 : 4,
    };
    this.nodes.push(node);
    this.order++;

    if (anchor) this.edges.push({ from: anchor.id, to: node.id, born: opts.now });

    // Evict oldest beyond the hard cap (and any dangling edges).
    while (this.nodes.length > MAX_NODES) {
      const dead = this.nodes.shift()!;
      this.edges = this.edges.filter((e) => e.from !== dead.id && e.to !== dead.id);
    }
  }

  /**
   * One physics + decay step. `cx,cy` is the world-anchored cluster centre in
   * canvas-local px. `dt` is clamped seconds. When `frozen` (reduced motion) we
   * skip integration and just hold positions.
   */
  step(cx: number, cy: number, dt: number, frozen: boolean): void {
    const n = this.nodes.length;
    if (n === 0) return;
    if (frozen) return;

    const k = Math.min(dt, 0.05);
    // Repulsion (O(n²) but n≤40 → ≤1600 cheap ops).
    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (i - j) * 0.1;
          dy = 0.1;
          d2 = 0.02;
        }
        const force = 320 / d2;
        const inv = 1 / Math.sqrt(d2);
        const fx = dx * inv * force;
        const fy = dy * inv * force;
        a.vx += fx * k;
        a.vy += fy * k;
        b.vx -= fx * k;
        b.vy -= fy * k;
      }
    }
    // Spring along edges.
    for (const e of this.edges) {
      const a = this.byId(e.from);
      const b = this.byId(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = 34;
      const f = (d - target) * 0.6;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      a.vx += ux * k;
      a.vy += uy * k;
      b.vx -= ux * k;
      b.vy -= uy * k;
    }
    // Gentle centring + slow orbital swirl + damping.
    for (const node of this.nodes) {
      node.vx += -node.x * 0.9 * k;
      node.vy += -node.y * 0.9 * k;
      // Swirl: perpendicular nudge for a living, orbital feel.
      node.vx += -node.y * 0.12 * k;
      node.vy += node.x * 0.12 * k;
      node.vx *= 0.9;
      node.vy *= 0.9;
      node.x += node.vx * k;
      node.y += node.vy * k;
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    now: number,
    palette: Record<EventKind, string>,
    tier: PerfTier,
    zoom: number,
  ): void {
    if (this.nodes.length === 0) return;
    ctx.save();
    ctx.translate(cx, cy);
    const s = Math.max(0.6, Math.min(1.1, zoom));
    ctx.scale(s, s);

    // Edges first.
    for (const e of this.edges) {
      const a = this.byId(e.from);
      const b = this.byId(e.to);
      if (!a || !b) continue;
      const age = now - Math.max(a.born, b.born);
      const fade = Math.max(0.12, 1 - age / 30);
      const rgb = parse(palette[b.kind]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = rgba(rgb, 0.22 * fade);
      ctx.stroke();
    }

    // Nodes.
    for (const node of this.nodes) {
      const age = now - node.born;
      const fade = Math.max(0.18, 1 - age / 40); // older = dimmer (recency feed)
      const appear = Math.min(1, age / 0.4); // pop-in
      const rgb = parse(palette[node.kind]);
      const r = node.r * appear;
      if (tier === 0) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = rgba(rgb, 0.1 * fade);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(rgb, 0.82 * fade);
      ctx.fill();
      // Newest node carries a thin ring pulse.
      if (age < 1.2 && tier < 2) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3 + age * 8, 0, Math.PI * 2);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = rgba(rgb, 0.4 * (1 - age / 1.2));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private byId(id: string): GNode | undefined {
    // n≤40 — linear scan is fine and avoids map churn.
    for (const node of this.nodes) if (node.id === id) return node;
    return undefined;
  }
}

const rgbCache = new Map<string, { r: number; g: number; b: number }>();
function parse(color: string): { r: number; g: number; b: number } {
  let v = rgbCache.get(color);
  if (v) return v;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(",").map((x) => parseFloat(x));
    v = { r: r || 0, g: g || 0, b: b || 0 };
  } else if (color.startsWith("#")) {
    const hex = color.slice(1);
    const nn = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    v = { r: parseInt(nn.slice(0, 2), 16), g: parseInt(nn.slice(2, 4), 16), b: parseInt(nn.slice(4, 6), 16) };
  } else {
    v = { r: 200, g: 164, b: 90 };
  }
  rgbCache.set(color, v);
  return v;
}
