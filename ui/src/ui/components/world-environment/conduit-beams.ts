/**
 * conduit-beams.ts — animated energy-flow overlay for atrium conduits.
 *
 * A single <canvas> controller that augments the world's conduit beams with a
 * moving dashed gradient (data flowing), a thin glow halo, and soft particle
 * bursts at the endpoints. It does NOT read or mutate the PIXI atrium system in
 * activity-map.ts — that geometry is internal to <agency-world-viz>. Instead the
 * host feeds beam coordinates through addBeam()/removeBeam() (or the
 * `world-env:beam-*` window events). See world-environment.ts for the contract.
 *
 * Coordinates are fractions of the element (0..1, origin top-left) so the
 * overlay stays aligned regardless of the host's pixel size.
 */

export interface BeamSpec {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** 0..1 — drives flow speed, dash density, glow strength, burst rate. */
  intensity?: number;
  /** CSS color for the beam; defaults to gold. */
  color?: string;
}

interface Beam extends Required<Omit<BeamSpec, "color">> {
  id: string;
  color: string;
  phase: number;
  burstAccum: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

const GOLD = "#d4af37";

function rgba(hex: string, a: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class ConduitBeams {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private beams = new Map<string, Beam>();
  private particles: Particle[] = [];
  private raf = 0;
  private last = 0;
  private seq = 0;
  private activity = 0.3;
  private reduced = false;
  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("conduit-beams: 2d context unavailable");
    this.ctx = ctx;
    this.reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  setActivity(v: number): void {
    this.activity = Math.max(0, Math.min(1, v));
  }

  addBeam(spec: BeamSpec): string {
    const id = `beam_${++this.seq}`;
    this.beams.set(id, {
      id,
      from: spec.from,
      to: spec.to,
      intensity: Math.max(0, Math.min(1, spec.intensity ?? 0.5)),
      color: spec.color ?? GOLD,
      phase: 0,
      burstAccum: 0,
    });
    return id;
  }

  updateBeam(id: string, spec: Partial<BeamSpec>): void {
    const b = this.beams.get(id);
    if (!b) return;
    if (spec.from) b.from = spec.from;
    if (spec.to) b.to = spec.to;
    if (spec.intensity != null) b.intensity = Math.max(0, Math.min(1, spec.intensity));
    if (spec.color) b.color = spec.color;
  }

  removeBeam(id: string): void {
    this.beams.delete(id);
  }

  clear(): void {
    this.beams.clear();
    this.particles.length = 0;
  }

  /** Replace the full beam set (used by the `world-env:beams` event). */
  setBeams(specs: BeamSpec[]): void {
    this.clear();
    for (const s of specs) this.addBeam(s);
  }

  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    this.w = cssW;
    this.h = cssH;
    this.canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  start(): void {
    if (this.raf) return;
    const loop = (t: number) => {
      const dt = this.last ? Math.min(64, t - this.last) : 16;
      this.last = t;
      this.step(dt / 1000);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  private step(dt: number): void {
    const act = this.activity;
    for (const b of this.beams.values()) {
      // Flow speed scales with traffic (beam intensity) and global activity.
      const speed = 0.25 + 1.4 * b.intensity * (0.4 + 0.6 * act);
      b.phase = (b.phase + speed * dt) % 1;
      // Endpoint particle bursts — rate scales with traffic.
      if (!this.reduced) {
        b.burstAccum += dt * (2 + 10 * b.intensity);
        while (b.burstAccum >= 1) {
          b.burstAccum -= 1;
          this.spawnBurst(b);
        }
      }
    }
    // Advance particles.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
    }
  }

  private spawnBurst(b: Beam): void {
    const end = Math.random() < 0.5 ? b.from : b.to;
    const x = end.x * this.w;
    const y = end.y * this.h;
    const n = 1 + Math.floor(2 * b.intensity);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 6 + Math.random() * 26 * b.intensity;
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0.4 + Math.random() * 0.5,
        max: 0.9,
        color: b.color,
      });
    }
  }

  private draw(): void {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    for (const b of this.beams.values()) {
      const x1 = b.from.x * w;
      const y1 = b.from.y * h;
      const x2 = b.to.x * w;
      const y2 = b.to.y * h;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const inten = b.intensity * (0.45 + 0.55 * this.activity);

      // Thin glow halo (wide, soft, low alpha).
      ctx.strokeStyle = rgba(b.color, 0.05 + 0.12 * inten);
      ctx.lineWidth = 7 + 8 * inten;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Base beam line.
      ctx.strokeStyle = rgba(b.color, 0.12 + 0.2 * inten);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Moving dashed gradient — the "data flowing" effect.
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      const head = rgba(b.color, 0.85 * (0.4 + 0.6 * inten));
      grad.addColorStop(0, rgba(b.color, 0));
      grad.addColorStop(0.5, head);
      grad.addColorStop(1, rgba(b.color, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.5;
      const dash = Math.max(8, 22 - 12 * b.intensity);
      ctx.setLineDash([dash, dash * 1.6]);
      ctx.lineDashOffset = -b.phase * (dash * 2.6) - (len % (dash * 2.6));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Endpoint cores.
      for (const e of [b.from, b.to]) {
        const ex = e.x * w;
        const ey = e.y * h;
        const r = 2 + 3 * inten;
        const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, r * 3.5);
        g.addColorStop(0, rgba(b.color, 0.9));
        g.addColorStop(0.4, rgba(b.color, 0.35));
        g.addColorStop(1, rgba(b.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(ex, ey, r * 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Particle bursts.
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.fillStyle = rgba(p.color, 0.7 * a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5 * a + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
  }
}
