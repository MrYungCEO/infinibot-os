/**
 * Pure simulation + draw core for <agent-fx-layer>, decoupled from Lit/DOM so it
 * can be unit-tested or driven from any canvas.
 *
 * Responsibilities:
 *   - Track each agent's last position + status across frames.
 *   - Emit fading particle trails behind *moving* agents (backend-coloured).
 *   - Emit a radial burst on a real status transition (not on first paint).
 *   - Draw a soft pulsating glow ring per agent (status-coloured).
 *
 * Frame-rate independence: every motion uses delta-time (seconds). The global
 * particle pool is capped; oldest particles are dropped first. LOD scales
 * emission down as the world zooms out.
 */

import { backendColor, statusColor, rgba, type RGB } from "./colors.js";
import type { FxAgent, FxEffect } from "./types.js";

const MAX_PARTICLES = 500;
const TRAIL_LIFE = 0.6; // seconds — ~600ms fade
const BURST_LIFE = 0.45; // seconds
const MOVE_EPS = 0.6; // px/frame below which an agent is "stationary"
const TRAIL_SPACING = 6; // px of travel between emitted trail dots
const MAX_TRAIL_PER_FRAME = 4; // clamp emission for teleports

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  color: RGB;
  size: number;
}

interface Burst {
  x: number;
  y: number;
  born: number;
  life: number;
  color: RGB;
}

interface Track {
  x: number;
  y: number;
  status: string;
  backend?: string;
  /** Distance carried over from last frame for evenly-spaced trail dots. */
  carry: number;
  /** False until the first frame we've seen this agent — gates bursts. */
  seen: boolean;
  /** Last status used for transition detection. */
  lastStatus: string;
  /** Marked each frame the source still reports this agent (GC stale tracks). */
  alive: boolean;
}

export interface FxFlags {
  trails: boolean;
  glow: boolean;
  bursts: boolean;
  reducedMotion: boolean;
}

export class FxEngine {
  private tracks = new Map<string, Track>();
  private particles: Particle[] = [];
  private bursts: Burst[] = [];

  /** Advance the simulation. `now` and `dt` are in seconds. `lod` ∈ (0,1]. */
  update(agents: FxAgent[], now: number, dt: number, flags: FxFlags, lod: number): void {
    for (const t of this.tracks.values()) t.alive = false;

    for (const a of agents) {
      let t = this.tracks.get(a.id);
      if (!t) {
        // First sighting: seed position, do NOT emit a trail or burst.
        t = {
          x: a.x,
          y: a.y,
          status: a.status,
          backend: a.backend,
          carry: 0,
          seen: true,
          lastStatus: a.status,
          alive: true,
        };
        this.tracks.set(a.id, t);
        continue;
      }
      t.alive = true;

      const dx = a.x - t.x;
      const dy = a.y - t.y;
      const dist = Math.hypot(dx, dy);

      // ── Trails: only for genuinely moving agents ──
      if (
        flags.trails &&
        !flags.reducedMotion &&
        dist > MOVE_EPS &&
        dist < 400 // skip teleports/camera jumps
      ) {
        const col = backendColor(a.backend);
        t.carry += dist;
        const spacing = TRAIL_SPACING / lod; // fewer dots when zoomed out
        let emitted = 0;
        while (t.carry >= spacing && emitted < MAX_TRAIL_PER_FRAME) {
          t.carry -= spacing;
          const f = emitted === 0 ? 0 : (t.carry / dist) % 1;
          this.spawnTrail(t.x + dx * f, t.y + dy * f, col, now);
          emitted++;
        }
      } else {
        t.carry = 0;
      }

      // ── Burst on real status transition ──
      if (a.status !== t.lastStatus) {
        if (t.seen && flags.bursts && !flags.reducedMotion) {
          this.bursts.push({ x: a.x, y: a.y, born: now, life: BURST_LIFE, color: statusColor(a.status) });
        }
        t.lastStatus = a.status;
      }

      t.x = a.x;
      t.y = a.y;
      t.status = a.status;
      t.backend = a.backend;
    }

    // GC tracks the source stopped reporting.
    for (const [id, t] of this.tracks) if (!t.alive) this.tracks.delete(id);

    // Age particles + bursts.
    this.particles = this.particles.filter((p) => now - p.born < p.life);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.bursts = this.bursts.filter((b) => now - b.born < b.life);

    // Global cap — drop oldest first.
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
  }

  private spawnTrail(x: number, y: number, color: RGB, now: number): void {
    // Slight jitter + slow drift so trails feel organic, not a hard polyline.
    const ang = Math.atan2(0, 0) + (x * 0.013 + y * 0.017); // deterministic per-pos
    this.particles.push({
      x,
      y,
      vx: Math.cos(ang) * 4,
      vy: Math.sin(ang) * 4 - 6, // gentle upward drift
      born: now,
      life: TRAIL_LIFE,
      color,
      size: 2.6,
    });
  }

  /** Draw the whole frame. `live` is the set of currently-tracked agents for rings. */
  draw(ctx: CanvasRenderingContext2D, now: number, flags: FxFlags, lod: number): void {
    // ── Trails (additive for a soft glow stack) ──
    if (flags.trails && this.particles.length) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const p of this.particles) {
        const age = (now - p.born) / p.life; // 0..1
        const a = (1 - age) * 0.85;
        const r = p.size * (1 + age * 1.4);
        // Saturated core + soft halo so the backend colour reads even when the
        // additive stack of overlapping dots would otherwise wash toward white.
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.0);
        g.addColorStop(0, rgba(p.color, a));
        g.addColorStop(0.45, rgba(p.color, a * 0.5));
        g.addColorStop(1, rgba(p.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // ── Glow rings (always, even under reduced motion — static then) ──
    // Idle/ambient underglow: kept ~50% of its former radius so it tucks under
    // the agent sprite (an opaque underglow the character reads on top of) rather
    // than ringing it. Status-change BURSTS below are intentionally left at full
    // scale — only this ambient loop is dialled down.
    if (flags.glow) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const pulse = flags.reducedMotion ? 0 : Math.sin(now * 3.0);
      for (const t of this.tracks.values()) {
        const col = statusColor(t.status);
        const base = 7.5 * lod; // ~50% of former 15px — subtle underglow
        const ringR = base + pulse * 1.2; // breathing scaled to the smaller ring
        // Soft filled halo.
        const halo = ctx.createRadialGradient(t.x, t.y, ringR * 0.3, t.x, t.y, ringR * 1.5);
        halo.addColorStop(0, rgba(col, 0.0));
        halo.addColorStop(0.62, rgba(col, 0.16 + (pulse + 1) * 0.04));
        halo.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(t.x, t.y, ringR * 1.5, 0, Math.PI * 2);
        ctx.fill();
        // Crisp ring stroke.
        ctx.lineWidth = 1.2 * lod;
        ctx.strokeStyle = rgba(col, 0.42 + (pulse + 1) * 0.1);
        ctx.beginPath();
        ctx.arc(t.x, t.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Status-change bursts (expanding fading rings) ──
    if (flags.bursts && this.bursts.length) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const b of this.bursts) {
        const age = (now - b.born) / b.life; // 0..1
        const r = 10 + age * 64 * lod;
        const a = (1 - age) * 0.95;
        ctx.lineWidth = (4.2 - age * 3.2) * lod;
        ctx.strokeStyle = rgba(b.color, a);
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.stroke();
        // Inner flash for the first third of life.
        if (age < 0.34) {
          const fg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
          fg.addColorStop(0, rgba(b.color, (0.34 - age) * 1.4));
          fg.addColorStop(1, rgba(b.color, 0));
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /** True while anything is still animating (lets the host idle the rAF). */
  get busy(): boolean {
    return this.particles.length > 0 || this.bursts.length > 0;
  }

  get particleCount(): number {
    return this.particles.length;
  }

  reset(): void {
    this.tracks.clear();
    this.particles = [];
    this.bursts = [];
  }

  /** Toggle helper kept here so the element stays thin. */
  static defaultFlags(reducedMotion: boolean): FxFlags {
    return { trails: true, glow: true, bursts: true, reducedMotion };
  }

  static applyToggle(flags: FxFlags, name: FxEffect, on: boolean): FxFlags {
    return { ...flags, [name]: on };
  }
}
