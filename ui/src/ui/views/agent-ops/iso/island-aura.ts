/**
 * Island aura — animated, activity-driven perimeter border for one territory
 * (a station district zone, or a satellite federation pod).
 *
 * Implements the Agent-Mesh-upgrade-plan "islands" flourishes (Phase 1/2
 * visual + atmosphere): a pulsing/shimmering perimeter stroke whose intensity,
 * speed, and colour track REAL activity on the island, plus corner sparks,
 * ambient rising motes (spawn-rate ∝ activity), and a ripple ring fired on a
 * real tool dispatch / completion event.
 *
 * This object draws NOTHING on its own timer-driven schedule that isn't gated
 * by a real signal: the ambient breath always exists (so an idle island reads
 * as "alive but quiet"), but its brightness/speed/particle-rate/colour are a
 * pure function of the {@link IslandActivitySample} the engine feeds in from
 * live agent counts + status, and ripples only fire when the engine routes a
 * genuine tool-pulse / completion event here. No fake random pulses.
 *
 * Owned and ticked by ActivityMap (the live engine); never self-mounts. The
 * engine adds `container` to the appropriate world-panning parent and calls
 * `tick()` every frame from its render loop.
 */
import * as PIXI from "pixi.js";

export type IslandMood = "idle" | "working" | "blocked" | "failed";

export interface IslandActivitySample {
  /** Agents currently on this island. */
  total: number;
  /** Subset of `total` that are actively working. */
  working: number;
  /** Dominant status on the island, drives the border tint. */
  mood: IslandMood;
}

export interface IslandAuraColors {
  base: number;
  ok: number;
  warn: number;
  err: number;
  bright: number;
}

export interface IslandAuraOptions {
  /** Flat [x0,y0,x1,y1,...] polygon in the container's LOCAL space. */
  poly: number[];
  colors: IslandAuraColors;
  /** Local-space island centroid (ripple origin). Defaults to poly average. */
  center?: { x: number; y: number };
  /** When true, draw a static intensity-scaled border — no motion. */
  reducedMotion?: boolean;
}

interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  len: number;
  /** Cumulative arc-length at the START of this edge. */
  start: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

interface Ripple {
  age: number;
  life: number;
  strength: number;
  color: number;
}

const MAX_MOTES = 26;
const MAX_RIPPLES = 6;

export class IslandAura {
  readonly container: PIXI.Container;

  private readonly border: PIXI.Graphics;
  private readonly motesG: PIXI.Graphics;
  private readonly ripplesG: PIXI.Graphics;

  private readonly poly: number[];
  private readonly colors: IslandAuraColors;
  private readonly reducedMotion: boolean;
  private readonly edges: Edge[] = [];
  private readonly perimeter: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly maxR: number;

  // Smoothed 0..1 activity level (eased toward target so it never snaps).
  private level = 0;
  private targetLevel = 0;
  private mood: IslandMood = "idle";

  private pulsePhase = 0;
  private shimmerU = 0;
  private moteAccum = 0;
  private motes: Mote[] = [];
  private ripples: Ripple[] = [];
  private destroyed = false;

  constructor(opts: IslandAuraOptions) {
    this.poly = opts.poly.slice();
    this.colors = opts.colors;
    this.reducedMotion = opts.reducedMotion ?? false;

    this.container = new PIXI.Container();
    this.border = new PIXI.Graphics();
    this.motesG = new PIXI.Graphics();
    this.ripplesG = new PIXI.Graphics();
    (this.border as unknown as { blendMode: number }).blendMode = PIXI.BLEND_MODES.ADD;
    (this.motesG as unknown as { blendMode: number }).blendMode = PIXI.BLEND_MODES.ADD;
    (this.ripplesG as unknown as { blendMode: number }).blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.ripplesG, this.border, this.motesG);

    // Precompute edges + cumulative arc-length for shimmer travel + mote spawn.
    const n = this.poly.length / 2;
    let acc = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      const ax = this.poly[i * 2];
      const ay = this.poly[i * 2 + 1];
      const j = (i + 1) % n;
      const bx = this.poly[j * 2];
      const by = this.poly[j * 2 + 1];
      const len = Math.hypot(bx - ax, by - ay);
      this.edges.push({ ax, ay, bx, by, len, start: acc });
      acc += len;
      sx += ax;
      sy += ay;
    }
    this.perimeter = acc || 1;
    this.cx = opts.center?.x ?? (n ? sx / n : 0);
    this.cy = opts.center?.y ?? (n ? sy / n : 0);
    let maxR = 1;
    for (let i = 0; i < n; i++) {
      maxR = Math.max(maxR, Math.hypot(this.poly[i * 2] - this.cx, this.poly[i * 2 + 1] - this.cy));
    }
    this.maxR = maxR;

    this.drawBorder(0.25, this.colors.base, 1.5);
  }

  /** Feed the latest real activity reading. Eased into the live level in tick. */
  setActivity(sample: IslandActivitySample): void {
    if (this.destroyed) return;
    const { total, working } = sample;
    const occupancy = Math.min(1, total / 5);
    const workRatio = total > 0 ? working / total : 0;
    // Presence is the floor; working agents push it toward full.
    this.targetLevel = Math.max(
      0,
      Math.min(1, (total > 0 ? 0.28 : 0) + 0.42 * occupancy + 0.3 * workRatio),
    );
    this.mood = sample.mood;
  }

  /** Fire an expanding ring from the island centre — call on a real event. */
  ripple(strength = 1, color?: number): void {
    if (this.destroyed || this.reducedMotion) return;
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift();
    this.ripples.push({
      age: 0,
      life: 0.7 + 0.25 * strength,
      strength: Math.max(0.4, Math.min(2, strength)),
      color: color ?? this.moodColor(),
    });
  }

  private moodColor(): number {
    switch (this.mood) {
      case "failed":
        return this.colors.err;
      case "blocked":
        return this.colors.warn;
      case "working":
        return this.colors.bright;
      default:
        return this.colors.base;
    }
  }

  tick(dtSeconds: number): void {
    if (this.destroyed) return;
    const dt = Math.max(0, Math.min(0.05, dtSeconds));
    // Ease the live level toward the latest sample (~0.5 s settle).
    this.level += (this.targetLevel - this.level) * Math.min(1, dt * 4);
    const lvl = this.level;
    const color = this.moodColor();

    if (this.reducedMotion) {
      this.drawBorder(0.3 + 0.5 * lvl, color, 1.5 + 2 * lvl);
      this.drawRipples(dt); // ripples are suppressed at source under reduced motion
      return;
    }

    // Perimeter breath: faster + brighter the busier the island.
    this.pulsePhase += dt * (1.0 + 3.2 * lvl);
    const wave = 0.5 + 0.5 * Math.sin(this.pulsePhase);
    const alpha = 0.22 + 0.55 * lvl * (0.55 + 0.45 * wave);
    const width = 1.5 + 2.6 * lvl;
    this.drawBorder(alpha, color, width, lvl);

    this.updateMotes(dt, lvl, color);
    this.drawRipples(dt);
  }

  /** Stroke the polygon + corner sparks + (when lvl>0) a travelling shimmer. */
  private drawBorder(alpha: number, color: number, width: number, lvl = 0): void {
    const g = this.border;
    g.clear();
    g.lineStyle(width, color, alpha);
    g.moveTo(this.poly[0], this.poly[1]);
    for (let i = 1; i < this.poly.length / 2; i++) {
      g.lineTo(this.poly[i * 2], this.poly[i * 2 + 1]);
    }
    g.closePath();
    g.lineStyle(0);

    // Corner sparks — small glowing diamonds at each vertex.
    const sparkA = Math.min(1, alpha + 0.2);
    const sparkR = 2.4 + 2.6 * lvl;
    for (let i = 0; i < this.poly.length / 2; i++) {
      g.beginFill(this.colors.bright, sparkA);
      g.drawCircle(this.poly[i * 2], this.poly[i * 2 + 1], sparkR);
      g.endFill();
    }

    // Travelling shimmer: a bright arc segment running the perimeter, speed ∝ lvl.
    if (lvl > 0.02) {
      this.shimmerU = (this.shimmerU + (0.12 + 0.55 * lvl) * 0.016) % 1;
      const headLen = this.perimeter * 0.12;
      const startD = this.shimmerU * this.perimeter;
      const steps = 8;
      g.lineStyle(width + 1.4, this.colors.bright, Math.min(0.9, 0.35 + 0.6 * lvl));
      let started = false;
      for (let s = 0; s <= steps; s++) {
        const d = (startD + (headLen * s) / steps) % this.perimeter;
        const p = this.pointAt(d);
        if (!started) {
          g.moveTo(p.x, p.y);
          started = true;
        } else {
          g.lineTo(p.x, p.y);
        }
      }
      g.lineStyle(0);
    }
  }

  /** Point at arc-length `d` (0..perimeter) along the polygon perimeter. */
  private pointAt(d: number): { x: number; y: number } {
    for (const e of this.edges) {
      if (d >= e.start && d <= e.start + e.len) {
        const t = e.len > 0 ? (d - e.start) / e.len : 0;
        return { x: e.ax + (e.bx - e.ax) * t, y: e.ay + (e.by - e.ay) * t };
      }
    }
    const last = this.edges[this.edges.length - 1];
    return { x: last.bx, y: last.by };
  }

  /** Ambient rising motes — spawn rate scales with activity, never random-only. */
  private updateMotes(dt: number, lvl: number, color: number): void {
    this.moteAccum += dt * (0.6 + 11 * lvl);
    while (this.moteAccum >= 1 && this.motes.length < MAX_MOTES) {
      this.moteAccum -= 1;
      const d = Math.random() * this.perimeter;
      const p = this.pointAt(d);
      this.motes.push({
        x: p.x,
        y: p.y,
        vx: (p.x - this.cx) * 0.0006 + (Math.random() - 0.5) * 6,
        vy: -10 - 14 * Math.random() - 8 * lvl,
        age: 0,
        life: 1.0 + 0.8 * Math.random(),
      });
    }
    if (this.moteAccum > MAX_MOTES) this.moteAccum = 0;

    const g = this.motesG;
    g.clear();
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i];
      m.age += dt;
      if (m.age >= m.life) {
        this.motes.splice(i, 1);
        continue;
      }
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const a = (1 - m.age / m.life) * 0.7;
      g.beginFill(color, a);
      g.drawCircle(m.x, m.y, 1.6 + 0.8 * (1 - m.age / m.life));
      g.endFill();
    }
  }

  private drawRipples(dt: number): void {
    const g = this.ripplesG;
    g.clear();
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      if (r.age >= r.life) {
        this.ripples.splice(i, 1);
        continue;
      }
      const t = r.age / r.life;
      const radius = this.maxR * (0.15 + 0.95 * t) * Math.min(1.3, r.strength);
      const a = (1 - t) * 0.6;
      g.lineStyle(2 + 1.5 * r.strength, r.color, a);
      g.drawCircle(this.cx, this.cy, radius);
      g.lineStyle(0);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.motes = [];
    this.ripples = [];
    this.container.destroy({ children: true });
  }
}
