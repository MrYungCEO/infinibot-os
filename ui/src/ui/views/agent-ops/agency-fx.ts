/**
 * Agency World — ambient + event-driven effects.
 *
 * Provides:
 *  - FxLayer: pooled particle system (per-tool work glyphs, confetti, alarm
 *    pulses) + weather (rain/snow).
 *  - SkyCycle: a full-world day/night gradient driven by the browser clock,
 *    with a star field that fades in at night and a moon that tracks the hour.
 *  - AudioBus: a muted-by-default WebAudio synth (chime / alert / ding) — no
 *    asset files are shipped.
 *  - cameraShake: a reduced-motion-aware viewport jitter.
 *
 * Everything here is side-effect-free on import (declarations only). All
 * runtime work happens inside methods, driven by the engine ticker.
 */

import * as PIXI from "pixi.js";
import gsap from "gsap";

// ════════════════════════════════════════════════════════════════
// SHARED CONSTANTS (mirrors agency-world.ts theme)
// ════════════════════════════════════════════════════════════════

const GOLD = 0xd4af37;
const WHITE = 0xffffff;

// Zone colors reused for per-tool particle tinting.
const TOOL_COLORS = {
  terminal: 0x22c55e,
  library: GOLD,
  drafting: 0x60a5fa,
  browser: 0x3aa8c8,
  comm: 0xa78bfa,
  spark: 0xffd700,
} as const;

// Provider palette shirt colors — reused for confetti so a node's celebration
// reads as its own color family (kept local; agency-world.ts owns the canon).
const PROVIDER_CONFETTI = [
  0xc97a4a, // claude
  0x10a37f, // openai
  0x4285f4, // gemini
  0x6b46c1, // ollama
  0xe4e4e7, // xai
  0xffd700, // default / gold
];

type ParticleKind = "tool" | "confetti" | "alarm";

// ════════════════════════════════════════════════════════════════
// PARTICLE — internal pooled effect primitive
// ════════════════════════════════════════════════════════════════

class FxParticle {
  g: PIXI.Graphics;
  kind: ParticleKind;
  vx = 0;
  vy = 0;
  gravity = 0;
  life: number;
  age = 0;
  rot = 0;
  rotVel = 0;
  baseScale = 1;
  // alarm-specific
  ringMaxR = 0;
  ringColor = 0;
  active = false;

  constructor() {
    this.g = new PIXI.Graphics();
    this.kind = "tool";
    this.life = 1;
  }

  reset() {
    this.g.clear();
    this.g.position.set(0, 0);
    this.g.scale.set(1, 1);
    this.g.rotation = 0;
    this.g.alpha = 1;
    this.vx = 0;
    this.vy = 0;
    this.gravity = 0;
    this.age = 0;
    this.rot = 0;
    this.rotVel = 0;
    this.baseScale = 1;
    this.ringMaxR = 0;
    this.ringColor = 0;
  }
}

// ════════════════════════════════════════════════════════════════
// WEATHER — long-lived ambient overlay (rain / snow)
// ════════════════════════════════════════════════════════════════

interface Drop {
  g: PIXI.Graphics;
  x: number;
  y: number;
  vy: number;
  vx: number;
  swayPhase: number;
}

// ════════════════════════════════════════════════════════════════
// FX LAYER
// ════════════════════════════════════════════════════════════════

export class FxLayer {
  private layer: PIXI.Container;
  private maxParticles: number;

  // Active particle list (oldest first) + free pool to avoid churn.
  private active: FxParticle[] = [];
  private pool: FxParticle[] = [];

  // Weather state.
  private weather: "none" | "rain" | "snow" = "none";
  private weatherLayer: PIXI.Container;
  private drops: Drop[] = [];
  private weatherBounds = { x: -200, y: -200, w: 3600, h: 2400 };

  constructor(layer: PIXI.Container, opts?: { maxParticles?: number }) {
    this.layer = layer;
    this.maxParticles = Math.max(20, opts?.maxParticles ?? 200);
    this.weatherLayer = new PIXI.Container();
    this.weatherLayer.zIndex = 99000;
    this.layer.addChild(this.weatherLayer);
  }

  // ──────────────────────────────────────────────────────────────
  // POOLING
  // ──────────────────────────────────────────────────────────────

  private take(): FxParticle {
    let p = this.pool.pop();
    if (!p) p = new FxParticle();
    p.reset();
    p.active = true;
    this.layer.addChild(p.g);
    this.active.push(p);
    // Evict oldest when over cap.
    while (this.active.length > this.maxParticles) {
      const old = this.active.shift();
      if (old) this.release(old);
    }
    return p;
  }

  private release(p: FxParticle) {
    if (!p.active) return;
    p.active = false;
    if (p.g.parent) p.g.parent.removeChild(p.g);
    this.pool.push(p);
  }

  // ──────────────────────────────────────────────────────────────
  // TOOL PARTICLES
  // ──────────────────────────────────────────────────────────────

  /**
   * Per-tool work glyph: bash=green keyboard, edit/write=blue ink dot,
   * read/glob/grep=floating page, webfetch/websearch=network packet,
   * task/agent=envelope, else=spark.
   */
  spawnToolParticle(x: number, y: number, toolKind: string): void {
    const k = String(toolKind || "").toLowerCase();
    const glyph = this.glyphFor(k);
    const color = this.colorFor(k);

    const p = this.take();
    p.kind = "tool";
    p.life = 1.0 + Math.random() * 0.4; // < 1.5s
    p.vx = (Math.random() - 0.5) * 14;
    p.vy = -26 - Math.random() * 16;
    p.gravity = 20;
    p.g.position.set(x, y);

    this.drawGlyph(p.g, glyph, color);
  }

  private glyphFor(
    k: string,
  ): "keyboard" | "ink" | "page" | "packet" | "envelope" | "spark" {
    if (k === "bash" || k === "bashoutput" || k === "terminal")
      return "keyboard";
    if (
      k === "edit" ||
      k === "write" ||
      k === "notebookedit" ||
      k === "drafting"
    )
      return "ink";
    if (
      k === "read" ||
      k === "glob" ||
      k === "grep" ||
      k === "toolsearch" ||
      k === "search" ||
      k === "library"
    )
      return "page";
    if (
      k === "webfetch" ||
      k === "websearch" ||
      k === "browser"
    )
      return "packet";
    if (
      k === "task" ||
      k === "agent" ||
      k === "message" ||
      k === "comm"
    )
      return "envelope";
    return "spark";
  }

  private colorFor(k: string): number {
    const g = this.glyphFor(k);
    switch (g) {
      case "keyboard":
        return TOOL_COLORS.terminal;
      case "ink":
        return TOOL_COLORS.drafting;
      case "page":
        return TOOL_COLORS.library;
      case "packet":
        return TOOL_COLORS.browser;
      case "envelope":
        return TOOL_COLORS.comm;
      default:
        return TOOL_COLORS.spark;
    }
  }

  private drawGlyph(g: PIXI.Graphics, glyph: string, color: number) {
    g.clear();
    switch (glyph) {
      case "keyboard": {
        // Tiny keyboard: a row of keys.
        g.beginFill(color, 0.9);
        g.drawRect(-4, -2, 8, 4);
        g.endFill();
        g.beginFill(0x0a0e1a, 0.8);
        g.drawRect(-3, -1, 1, 1);
        g.drawRect(-1, -1, 1, 1);
        g.drawRect(1, -1, 1, 1);
        g.drawRect(-2, 1, 4, 1);
        g.endFill();
        break;
      }
      case "ink": {
        // Blue ink dot with a small drip.
        g.beginFill(color, 0.95);
        g.drawCircle(0, 0, 2);
        g.endFill();
        g.beginFill(color, 0.6);
        g.drawRect(-0.5, 1, 1, 2);
        g.endFill();
        break;
      }
      case "page": {
        // Floating page: a small dog-eared sheet with text lines.
        g.beginFill(WHITE, 0.92);
        g.drawRect(-3, -4, 6, 8);
        g.endFill();
        g.beginFill(color, 0.85);
        g.drawRect(-2, -2, 4, 1);
        g.drawRect(-2, 0, 4, 1);
        g.drawRect(-2, 2, 3, 1);
        g.endFill();
        break;
      }
      case "packet": {
        // Network packet: a diamond with a center spark.
        g.beginFill(color, 0.9);
        g.drawPolygon([0, -3, 3, 0, 0, 3, -3, 0]);
        g.endFill();
        g.beginFill(WHITE, 0.7);
        g.drawRect(-0.5, -0.5, 1, 1);
        g.endFill();
        break;
      }
      case "envelope": {
        // Tiny envelope with a flap.
        g.beginFill(0xfaf3e0, 0.95);
        g.drawRect(-4, -3, 8, 6);
        g.endFill();
        g.lineStyle(0.75, color, 0.9);
        g.moveTo(-4, -3);
        g.lineTo(0, 0);
        g.lineTo(4, -3);
        g.lineStyle(0);
        break;
      }
      default: {
        // Spark: a tiny plus.
        g.beginFill(color, 0.9);
        g.drawRect(-2, -0.5, 4, 1);
        g.drawRect(-0.5, -2, 1, 4);
        g.endFill();
        break;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // CONFETTI (completion celebration)
  // ──────────────────────────────────────────────────────────────

  confettiBurst(x: number, y: number, color: number): void {
    const count = 14;
    for (let i = 0; i < count; i++) {
      const p = this.take();
      p.kind = "confetti";
      p.life = 0.9 + Math.random() * 0.5; // < 1.5s
      const ang = Math.random() * Math.PI * 2;
      const speed = 30 + Math.random() * 60;
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed - 40;
      p.gravity = 160;
      p.rot = Math.random() * Math.PI;
      p.rotVel = (Math.random() - 0.5) * 12;
      p.g.position.set(x, y);
      p.g.rotation = p.rot;
      // Mix the agent's provider color with a random confetti color.
      const c =
        i % 3 === 0
          ? color
          : PROVIDER_CONFETTI[
              Math.floor(Math.random() * PROVIDER_CONFETTI.length)
            ];
      const s = 1.4 + Math.random() * 1.4;
      p.g.clear();
      p.g.beginFill(c, 0.95);
      p.g.drawRect(-s / 2, -s / 2, s, s);
      p.g.endFill();
    }
  }

  // ──────────────────────────────────────────────────────────────
  // ALARM PULSE (blocked)
  // ──────────────────────────────────────────────────────────────

  alarmPulse(x: number, y: number): void {
    // Expanding red ring.
    const ring = this.take();
    ring.kind = "alarm";
    ring.life = 1.0; // < 1.2s
    ring.ringMaxR = 26;
    ring.ringColor = 0xef4444;
    ring.g.position.set(x, y);

    // "!" glyph that floats up and fades.
    const bang = this.take();
    bang.kind = "tool";
    bang.life = 1.0;
    bang.vx = 0;
    bang.vy = -24;
    bang.gravity = 0;
    bang.g.position.set(x, y - 14);
    bang.g.clear();
    // exclamation: a vertical bar + a dot, in alarm red.
    bang.g.beginFill(0xef4444, 1);
    bang.g.drawRect(-1, -6, 2, 6);
    bang.g.drawRect(-1, 2, 2, 2);
    bang.g.endFill();
  }

  // ──────────────────────────────────────────────────────────────
  // WEATHER
  // ──────────────────────────────────────────────────────────────

  setWeather(kind: "none" | "rain" | "snow"): void {
    if (kind === this.weather) return;
    this.weather = kind;
    // Tear down existing drops.
    for (const d of this.drops) {
      if (d.g.parent) d.g.parent.removeChild(d.g);
      d.g.destroy();
    }
    this.drops = [];
    if (kind === "none") return;

    const b = this.weatherBounds;
    const density = kind === "rain" ? 160 : 90;
    for (let i = 0; i < density; i++) {
      const g = new PIXI.Graphics();
      if (kind === "rain") {
        g.beginFill(0x9fc6e0, 0.5);
        g.drawRect(0, 0, 1, 7);
        g.endFill();
      } else {
        g.beginFill(WHITE, 0.85);
        g.drawCircle(0, 0, 1.4);
        g.endFill();
      }
      const x = b.x + Math.random() * b.w;
      const y = b.y + Math.random() * b.h;
      g.position.set(x, y);
      this.weatherLayer.addChild(g);
      this.drops.push({
        g,
        x,
        y,
        vy: kind === "rain" ? 520 + Math.random() * 220 : 50 + Math.random() * 40,
        vx: kind === "rain" ? -60 : (Math.random() - 0.5) * 20,
        swayPhase: Math.random() * Math.PI * 2,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────
  // TICK
  // ──────────────────────────────────────────────────────────────

  /** dt is in seconds; nowMs is performance.now()-style millis. */
  tick(dt: number, nowMs: number): void {
    // dt can be passed as ms or seconds; normalize defensively.
    let d = dt;
    if (d > 1) d = d / 1000;
    if (d <= 0) return;
    if (d > 0.1) d = 0.1; // clamp huge frame gaps

    // Particles.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.age += d;
      const t = p.age / p.life;
      if (t >= 1) {
        this.release(p);
        // active was shifted by release only when over cap; here we splice.
        this.active.splice(i, 1);
        continue;
      }
      if (p.kind === "alarm") {
        // Expanding ring + fade.
        const r = p.ringMaxR * t;
        p.g.clear();
        p.g.lineStyle(2, p.ringColor, 1 - t);
        p.g.drawCircle(0, 0, r);
        p.g.lineStyle(0);
      } else {
        p.vy += p.gravity * d;
        p.g.position.x += p.vx * d;
        p.g.position.y += p.vy * d;
        if (p.rotVel) {
          p.g.rotation += p.rotVel * d;
        }
        p.g.alpha = Math.max(0, 1 - t);
      }
    }

    // Weather.
    if (this.weather !== "none" && this.drops.length) {
      const b = this.weatherBounds;
      for (const drop of this.drops) {
        if (this.weather === "snow") {
          drop.swayPhase += d * 2;
          drop.g.position.x += (drop.vx + Math.sin(drop.swayPhase) * 14) * d;
        } else {
          drop.g.position.x += drop.vx * d;
        }
        drop.g.position.y += drop.vy * d;
        if (drop.g.position.y > b.y + b.h) {
          drop.g.position.y = b.y - 10;
          drop.g.position.x = b.x + Math.random() * b.w;
        }
        if (drop.g.position.x < b.x) drop.g.position.x = b.x + b.w;
        if (drop.g.position.x > b.x + b.w) drop.g.position.x = b.x;
      }
    }
  }

  destroy(): void {
    for (const p of this.active) {
      if (p.g.parent) p.g.parent.removeChild(p.g);
      p.g.destroy();
    }
    this.active = [];
    for (const p of this.pool) p.g.destroy();
    this.pool = [];
    for (const d of this.drops) {
      if (d.g.parent) d.g.parent.removeChild(d.g);
      d.g.destroy();
    }
    this.drops = [];
    if (this.weatherLayer.parent)
      this.weatherLayer.parent.removeChild(this.weatherLayer);
    this.weatherLayer.destroy({ children: true });
  }
}

// ════════════════════════════════════════════════════════════════
// SKY CYCLE — day/night gradient + stars + moon, driven by local clock
// ════════════════════════════════════════════════════════════════

export class SkyCycle {
  private skyLayer: PIXI.Container;
  private worldWidth: number;
  private worldHeight: number;

  private gradient: PIXI.Graphics;
  private stars: PIXI.Graphics;
  private moon: PIXI.Graphics;

  private lastHourBucket = -1;
  private lastDrawAt = 0;
  private starAlpha = 0;

  constructor(skyLayer: PIXI.Container, worldWidth: number, worldHeight: number) {
    this.skyLayer = skyLayer;
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;

    this.gradient = new PIXI.Graphics();
    this.stars = new PIXI.Graphics();
    this.moon = new PIXI.Graphics();
    this.gradient.alpha = 0.5; // ambient tint, kept subtle over the bg
    this.skyLayer.addChild(this.gradient, this.stars, this.moon);

    this.drawStarField();
  }

  /** Interpolate the day/night tint from the browser clock. */
  tick(nowMs: number): void {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const hourFrac = hour + minute / 60;

    // Recompute only when the hour bucket changes or every ~2s.
    const bucketChanged = hour !== this.lastHourBucket;
    const stale = nowMs - this.lastDrawAt > 2000;
    if (!bucketChanged && !stale) return;
    this.lastHourBucket = hour;
    this.lastDrawAt = nowMs;

    this.drawGradient(hourFrac);
    this.updateNight(hourFrac);
  }

  // 0 at midnight → 1 at midday → 0 at midnight again.
  private dayFactor(hourFrac: number): number {
    // Cosine curve peaking at 13:00 (slightly after solar noon for warmth).
    const x = ((hourFrac - 13) / 24) * Math.PI * 2;
    return (Math.cos(x) + 1) / 2;
  }

  private drawGradient(hourFrac: number) {
    const g = this.gradient;
    g.clear();
    const day = this.dayFactor(hourFrac);

    // Night tint = deep blue; day tint = warm/transparent.
    // We draw a few horizontal bands to fake a vertical gradient cheaply.
    const top = this.lerpColor(0x0a1430, 0x6ea0d8, day);
    const bottom = this.lerpColor(0x05060f, 0x244060, day);
    // Dawn/dusk warm push around 6 and 19.
    const duskAmt = this.duskFactor(hourFrac);
    const topMix = this.lerpColor(top, 0xc97a4a, duskAmt * 0.5);

    const bands = 8;
    const w = this.worldWidth + 400;
    const h = this.worldHeight + 400;
    const x0 = -200;
    const y0 = -200;
    for (let i = 0; i < bands; i++) {
      const f = i / (bands - 1);
      const c = this.lerpColor(topMix, bottom, f);
      g.beginFill(c, 1);
      g.drawRect(x0, y0 + (h / bands) * i, w, h / bands + 1);
      g.endFill();
    }
    // Overall opacity: stronger overlay at night, lighter by day.
    this.gradient.alpha = 0.55 - day * 0.3;
  }

  // Peaks near sunrise (~6) and sunset (~19).
  private duskFactor(hourFrac: number): number {
    const dawn = Math.max(0, 1 - Math.abs(hourFrac - 6.5) / 1.5);
    const dusk = Math.max(0, 1 - Math.abs(hourFrac - 18.5) / 1.5);
    return Math.max(dawn, dusk);
  }

  private drawStarField() {
    const g = this.stars;
    g.clear();
    const w = this.worldWidth;
    const h = this.worldHeight;
    // Deterministic-ish scatter so stars don't twinkle-jump on redraw.
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const count = 140;
    for (let i = 0; i < count; i++) {
      const x = rnd() * w;
      const y = rnd() * (h * 0.6); // upper portion of the world
      const s = rnd() < 0.15 ? 2 : 1;
      g.beginFill(WHITE, 0.7 + rnd() * 0.3);
      g.drawRect(x, y, s, s);
      g.endFill();
    }
    g.alpha = 0;
  }

  // Stars in 19:00–07:00; moon arcs across by hour.
  private updateNight(hourFrac: number) {
    const isNight = hourFrac >= 19 || hourFrac < 7;
    this.starAlpha = isNight ? 1 : 0;
    this.stars.alpha = this.starAlpha;

    // Moon visible at night; x tracks the hour across the world.
    this.moon.clear();
    if (isNight) {
      // Map night hours (19→31 wrap) to 0..1 across the world width.
      const nh = hourFrac >= 19 ? hourFrac - 19 : hourFrac + 5; // 0..12
      const t = nh / 12;
      const mx = 80 + t * (this.worldWidth - 160);
      const my = this.worldHeight * 0.12 + Math.sin(t * Math.PI) * -40;
      this.moon.beginFill(0xf4f1d0, 0.95);
      this.moon.drawCircle(mx, my, 16);
      this.moon.endFill();
      // Crater shadow / crescent hint.
      this.moon.beginFill(0xcdc89a, 0.6);
      this.moon.drawCircle(mx + 5, my - 3, 4);
      this.moon.drawCircle(mx - 4, my + 4, 3);
      this.moon.endFill();
      // Soft glow.
      this.moon.beginFill(0xf4f1d0, 0.12);
      this.moon.drawCircle(mx, my, 26);
      this.moon.endFill();
    }
  }

  private lerpColor(a: number, b: number, t: number): number {
    const tt = Math.max(0, Math.min(1, t));
    const ar = (a >> 16) & 0xff;
    const ag = (a >> 8) & 0xff;
    const ab = a & 0xff;
    const br = (b >> 16) & 0xff;
    const bg = (b >> 8) & 0xff;
    const bb = b & 0xff;
    const r = Math.round(ar + (br - ar) * tt);
    const gg = Math.round(ag + (bg - ag) * tt);
    const bl = Math.round(ab + (bb - ab) * tt);
    return (r << 16) | (gg << 8) | bl;
  }

  destroy(): void {
    if (this.gradient.parent) this.gradient.parent.removeChild(this.gradient);
    if (this.stars.parent) this.stars.parent.removeChild(this.stars);
    if (this.moon.parent) this.moon.parent.removeChild(this.moon);
    this.gradient.destroy();
    this.stars.destroy();
    this.moon.destroy();
  }
}

// ════════════════════════════════════════════════════════════════
// AUDIO BUS — WebAudio synth, muted by default, persisted
// ════════════════════════════════════════════════════════════════

const MUTE_KEY = "agencyWorld.muted";

export class AudioBus {
  private static _shared: AudioBus | null = null;

  private ctx: AudioContext | null = null;
  private _muted: boolean;

  private constructor() {
    this._muted = this.readMuted();
  }

  static shared(): AudioBus {
    if (!AudioBus._shared) AudioBus._shared = new AudioBus();
    return AudioBus._shared;
  }

  private readMuted(): boolean {
    try {
      const v = window.localStorage.getItem(MUTE_KEY);
      if (v === null) return true; // default muted
      return v === "true" || v === "1";
    } catch {
      return true;
    }
  }

  private writeMuted(v: boolean) {
    try {
      window.localStorage.setItem(MUTE_KEY, v ? "true" : "false");
    } catch {
      /* ignore storage failures (private mode etc.) */
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(v: boolean) {
    this._muted = v;
    this.writeMuted(v);
  }

  private ensureCtx(): AudioContext | null {
    if (this._muted) return null;
    if (!this.ctx) {
      try {
        const Ctor: typeof AudioContext =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return null;
        this.ctx = new Ctor();
      } catch {
        return null;
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      // Best-effort resume after a user gesture; ignore rejection.
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  play(kind: "chime" | "alert" | "ding"): void {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    if (kind === "chime") {
      // Major triad, short pluck envelope.
      const freqs = [523.25, 659.25, 783.99]; // C5 E5 G5
      freqs.forEach((f, i) => {
        this.blip(ctx, f, now + i * 0.06, 0.45, "triangle", 0.12);
      });
    } else if (kind === "alert") {
      // Two descending tones.
      this.blip(ctx, 660, now, 0.18, "square", 0.1);
      this.blip(ctx, 440, now + 0.16, 0.26, "square", 0.1);
    } else {
      // Single ding.
      this.blip(ctx, 880, now, 0.32, "sine", 0.12);
    }
  }

  private blip(
    ctx: AudioContext,
    freq: number,
    start: number,
    dur: number,
    type: OscillatorType,
    peak: number,
  ) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
}

// ════════════════════════════════════════════════════════════════
// PACING SYSTEM — frame-rate-independent timing for the world engine
// ════════════════════════════════════════════════════════════════

export interface PacingConfig {
  walkCycleFps: number;
  courierFlyFps: number;
  receptionistWaveFps: number;
  beaconIntervalMs: number;
  ledIntervalMs: number;
  smokeFps: number;
  conveyorFps: number;
  cameraTransitionMs: number;
}

export const DEFAULT_PACING: PacingConfig = {
  walkCycleFps: 8,
  courierFlyFps: 12,
  receptionistWaveFps: 3,
  beaconIntervalMs: 1000,
  ledIntervalMs: 500,
  smokeFps: 2,
  conveyorFps: 6,
  cameraTransitionMs: 800,
};

export class PacingController {
  worldTimeScale: number;
  elapsed = 0;

  constructor(worldTimeScale = 1) {
    this.worldTimeScale = Math.max(0.1, Math.min(3, worldTimeScale));
  }

  tick(deltaMs: number): number {
    const scaled = deltaMs * this.worldTimeScale;
    this.elapsed += scaled;
    return scaled;
  }

  setTimeScale(s: number) {
    this.worldTimeScale = Math.max(0.1, Math.min(3, s));
  }

  getTimeScale(): number {
    return this.worldTimeScale;
  }
}

export class PacedTimer {
  private accum = 0;
  private intervalMs: number;
  private cb: () => void;

  constructor(intervalMs: number, cb: () => void) {
    this.intervalMs = intervalMs;
    this.cb = cb;
  }

  setRate(ms: number) {
    this.intervalMs = ms;
  }

  update(worldDeltaMs: number): void {
    this.accum += worldDeltaMs;
    while (this.accum >= this.intervalMs) {
      this.accum -= this.intervalMs;
      this.cb();
    }
  }
}

export class PacedAnimator {
  private frames: number;
  private fps: number;
  private msPerFrame: number;
  private accum = 0;
  currentFrame = 0;

  constructor(frames: number, fps: number) {
    this.frames = frames;
    this.fps = fps;
    this.msPerFrame = 1000 / fps;
  }

  setFps(fps: number) {
    this.fps = fps;
    this.msPerFrame = 1000 / fps;
  }

  setFrames(n: number) {
    this.frames = n;
  }

  update(worldDeltaMs: number): number {
    this.accum += worldDeltaMs;
    while (this.accum >= this.msPerFrame) {
      this.accum -= this.msPerFrame;
      this.currentFrame = (this.currentFrame + 1) % this.frames;
    }
    return this.currentFrame;
  }
}

// ════════════════════════════════════════════════════════════════
// CAMERA SHAKE — reduced-motion-aware viewport jitter
// ════════════════════════════════════════════════════════════════

export function cameraShake(
  viewport: { x: number; y: number },
  intensity = 6,
  timeScale = 1,
): void {
  try {
    if (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
  } catch {
    /* matchMedia unavailable — proceed with shake */
  }

  const ox = viewport.x;
  const oy = viewport.y;
  const amt = Math.max(1, intensity);
  gsap.killTweensOf(viewport);
  // Decaying random-offset shake built from a small timeline of jitters,
  // always returning to origin. Uses only default-registered eases.
  const tl = gsap.timeline();
  tl.timeScale(timeScale);
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    const decay = 1 - i / steps;
    tl.to(viewport, {
      x: ox + (Math.random() - 0.5) * amt * 2 * decay,
      y: oy + (Math.random() - 0.5) * amt * 2 * decay,
      duration: 0.05,
      ease: "power1.inOut",
    });
  }
  tl.to(viewport, { x: ox, y: oy, duration: 0.08, ease: "power2.out" });
}
