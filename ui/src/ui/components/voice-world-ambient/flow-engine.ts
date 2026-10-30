/**
 * flow-engine.ts — in-world connector flows for the Voice Terminal mesh.
 *
 * A "flow" is a curved bézier link between two logical endpoints that resolve to
 * live screen coordinates each frame (so the line tracks pan/zoom of the iso
 * map). The curve bows upward off the iso ground plane, with perpendicular
 * spread so parallel flows fan out, and particles/dashes stream along it in the
 * event-type colour. Flows fade in on the triggering event and fade out when the
 * work they represent completes (or after a default lifetime).
 *
 * Pure canvas. No allocations in the hot path beyond a handful of point objects.
 */

import { type EventKind, type PerfTier, type Pt, rgba } from "./core.js";

export interface FlowSpec {
  id: string;
  kind: EventKind;
  /** Endpoint resolvers — re-evaluated every frame; null → endpoint not (yet) placed. */
  from: () => Pt | null;
  to: () => Pt | null;
  /** Group key used to spread parallel flows between the same pair apart. */
  pair?: string;
  /** Seconds. Defaults chosen so instantaneous events still read as a pulse. */
  inDur?: number;
  holdDur?: number;
  outDur?: number;
}

interface Flow extends Required<Omit<FlowSpec, "pair">> {
  pair: string;
  born: number;
  expiring: boolean;
  spread: number; // perpendicular offset index for fanning
  seed: number;
}

const PARTICLES_BY_TIER: Record<PerfTier, number> = { 0: 5, 1: 3, 2: 0 };

export class FlowEngine {
  private flows = new Map<string, Flow>();
  private pairCounts = new Map<string, number>();

  get size(): number {
    return this.flows.size;
  }

  /** Add or refresh a flow. Re-adding an existing id resets its fade-out. */
  add(spec: FlowSpec, now: number): void {
    const existing = this.flows.get(spec.id);
    if (existing) {
      existing.expiring = false;
      existing.born = now; // re-pulse
      return;
    }
    const pair = spec.pair ?? spec.id;
    const spread = this.pairCounts.get(pair) ?? 0;
    this.pairCounts.set(pair, spread + 1);
    this.flows.set(spec.id, {
      id: spec.id,
      kind: spec.kind,
      from: spec.from,
      to: spec.to,
      pair,
      inDur: spec.inDur ?? 0.45,
      holdDur: spec.holdDur ?? 2.2,
      outDur: spec.outDur ?? 0.8,
      born: now,
      expiring: false,
      spread,
      // Deterministic phase offset from the id (no Math.random in the loop).
      seed: (hashStr(spec.id) % 1000) / 1000,
    });
  }

  /** Begin fade-out for every flow whose id starts with `prefix` (e.g. a sessionKey). */
  expire(prefix: string): void {
    for (const f of this.flows.values()) {
      if (f.id.startsWith(prefix)) f.expiring = true;
    }
  }

  /** Drop dead flows. Call once per frame before draw. */
  update(now: number): void {
    for (const [id, f] of this.flows) {
      const age = now - f.born;
      const total = f.inDur + f.holdDur + f.outDur;
      // Expiring flows are cut to fade out immediately from wherever they are.
      const done = f.expiring ? age > f.inDur + f.outDur : age > total;
      if (done) {
        this.flows.delete(id);
        const c = (this.pairCounts.get(f.pair) ?? 1) - 1;
        if (c <= 0) this.pairCounts.delete(f.pair);
        else this.pairCounts.set(f.pair, c);
      }
    }
  }

  /** Envelope alpha 0..1 for the current age. */
  private alpha(f: Flow, now: number): number {
    const age = now - f.born;
    if (age < f.inDur) return age / f.inDur; // fade in
    if (f.expiring) {
      const t = (age - f.inDur) / f.outDur;
      return Math.max(0, 1 - t);
    }
    if (age < f.inDur + f.holdDur) return 1; // hold
    const t = (age - f.inDur - f.holdDur) / f.outDur;
    return Math.max(0, 1 - t);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    now: number,
    palette: Record<EventKind, string>,
    tier: PerfTier,
    zoom: number,
  ): void {
    if (this.flows.size === 0) return;
    const particles = PARTICLES_BY_TIER[tier];
    ctx.save();
    ctx.lineCap = "round";

    for (const f of this.flows.values()) {
      const a = f.from();
      const b = f.to();
      if (!a || !b) continue;
      const env = this.alpha(f, now);
      if (env <= 0.01) continue;

      const color = palette[f.kind];
      const rgb = parseRGB(color);

      // ── Iso-aware control point ──────────────────────────────────────────
      // Bow the curve upward (screen -y) so it reads as an arc lifting off the
      // ground plane, plus a perpendicular fan offset for parallel flows.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // Perpendicular unit (screen space).
      const px = -dy / len;
      const py = dx / len;
      const fan = (f.spread % 2 === 0 ? 1 : -1) * Math.ceil(f.spread / 2) * 14 * zoom;
      const lift = Math.min(120, len * 0.28) * zoom;
      const cx = mx + px * fan;
      const cy = my - lift + py * fan; // -lift = upward bow

      // ── Base curve ───────────────────────────────────────────────────────
      const width = (tier === 0 ? 1.6 : 1.1) * Math.max(0.7, zoom);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.lineWidth = width;
      ctx.strokeStyle = rgba(rgb, 0.16 * env);
      ctx.stroke();

      // Brighter core stroke.
      ctx.lineWidth = width * 0.5;
      ctx.strokeStyle = rgba(rgb, 0.4 * env);
      ctx.stroke();

      // ── Endpoint nodes ───────────────────────────────────────────────────
      dot(ctx, a, 2.2 * zoom, rgba(rgb, 0.55 * env));
      dot(ctx, b, 2.6 * zoom, rgba(rgb, 0.7 * env));

      // ── Flowing particles along the bézier ───────────────────────────────
      if (particles > 0) {
        const speed = 0.45; // loops per second
        for (let i = 0; i < particles; i++) {
          let t = (now * speed + f.seed + i / particles) % 1;
          // Direction: from → to (a → b).
          const p = quadPoint(a, { x: cx, y: cy }, b, t);
          const glow = (tier === 0 ? 5 : 3) * zoom;
          // Comet head brightens toward the leading edge.
          const headBoost = 0.5 + 0.5 * Math.sin(t * Math.PI);
          ctx.beginPath();
          ctx.arc(p.x, p.y, glow * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = rgba(rgb, 0.85 * env * headBoost);
          ctx.fill();
          if (tier === 0) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, glow, 0, Math.PI * 2);
            ctx.fillStyle = rgba(rgb, 0.18 * env * headBoost);
            ctx.fill();
          }
        }
      }
    }
    ctx.restore();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────
function quadPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const mt = 1 - t;
  return {
    x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x,
    y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y,
  };
}

function dot(ctx: CanvasRenderingContext2D, p: Pt, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const rgbCache = new Map<string, { r: number; g: number; b: number }>();
function parseRGB(color: string): { r: number; g: number; b: number } {
  let v = rgbCache.get(color);
  if (v) return v;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(",").map((s) => parseFloat(s));
    v = { r: r || 0, g: g || 0, b: b || 0 };
  } else if (color.startsWith("#")) {
    const hex = color.slice(1);
    const n = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    v = {
      r: parseInt(n.slice(0, 2), 16),
      g: parseInt(n.slice(2, 4), 16),
      b: parseInt(n.slice(4, 6), 16),
    };
  } else {
    v = { r: 200, g: 164, b: 90 };
  }
  rgbCache.set(color, v);
  return v;
}
