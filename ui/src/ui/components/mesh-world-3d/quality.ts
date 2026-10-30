/**
 * 3D Agent Mesh quality tiers + the auto-tier controller.
 *
 * Pure (no three.js): the scene asks `settingsFor(tier)` what to draw and
 * feeds frame times into `AutoTier`, which steps the tier down when the
 * measured frame rate stays under budget and (carefully) back up when there is
 * lots of headroom. Measurements only count while the scene is rendering
 * continuously — on-demand frames say nothing about the GPU budget.
 */

export type QualityTier = "high" | "medium" | "low";
export type QualityMode = "auto" | QualityTier;

export interface TierSettings {
  /** devicePixelRatio cap. */
  maxPixelRatio: number;
  /** UnrealBloom on top of the additive halos. */
  bloom: boolean;
  /** Directional-light shadow map. */
  shadows: boolean;
  /** Name tags drawn at once (nearest first; selected / hovered / followed always). */
  maxLabels: number;
  /** Floating dust motes. */
  dust: boolean;
  /** Spark particles per burst. */
  sparks: number;
  /** Render through the MSAA composer even without bloom. */
  compose: boolean;
  /** Env-map reflections on floors / metal / glass. */
  reflections: boolean;
  /** Live particles: data streams, tool pulses (glyphs, sparkles, scans), holo-screens. */
  particles: boolean;
  /** Ambient drones patrolling the station. */
  drones: number;
  /** 3D overlay panels above agents at once (the selected / hovered one always). */
  maxPanels: number;
}

const TIERS: Record<QualityTier, TierSettings> = {
  high: { maxPixelRatio: 2, bloom: true, shadows: true, maxLabels: 48, dust: true, sparks: 28, compose: true, reflections: true, particles: true, drones: 10, maxPanels: 8 },
  medium: { maxPixelRatio: 1.5, bloom: true, shadows: false, maxLabels: 28, dust: true, sparks: 16, compose: true, reflections: true, particles: true, drones: 6, maxPanels: 6 },
  low: { maxPixelRatio: 1, bloom: false, shadows: false, maxLabels: 12, dust: false, sparks: 0, compose: false, reflections: false, particles: false, drones: 0, maxPanels: 4 },
};

export function settingsFor(tier: QualityTier, opts: { mobile?: boolean } = {}): TierSettings {
  const s = { ...TIERS[tier] };
  // Phones: fill rate is the budget — cap harder at every tier.
  if (opts.mobile) {
    s.maxPixelRatio = Math.min(s.maxPixelRatio, tier === "high" ? 1.75 : tier === "medium" ? 1.25 : 1);
    s.maxPanels = Math.min(s.maxPanels, tier === "low" ? 2 : 4);
    s.drones = Math.min(s.drones, 4);
    if (tier !== "high") s.bloom = false;
  }
  return s;
}

export const TIER_ORDER: QualityTier[] = ["high", "medium", "low"];

export function lowerTier(t: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(t);
  return i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

export function higherTier(t: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(t);
  return i > 0 ? TIER_ORDER[i - 1] : null;
}

/** Starting tier before any measurement. */
export function initialTier(opts: { mobile?: boolean; cores?: number; memoryGb?: number }): QualityTier {
  if (opts.mobile) return (opts.memoryGb ?? 4) >= 6 && (opts.cores ?? 4) >= 8 ? "medium" : "low";
  if ((opts.cores ?? 8) <= 4) return "medium";
  return "high";
}

/** Frame gaps longer than this are pauses, not slow frames. */
const PAUSE_MS = 1000;

export interface AutoTierOptions {
  /** Frame rate the tier must hold. Default 50 (60 Hz target with headroom for jitter). */
  minFps?: number;
  /** Frame rate that justifies trying the next tier up. Default 58. */
  upgradeFps?: number;
  /** Sample window (ms). Default 2000. */
  windowMs?: number;
  /** Windows of headroom needed before stepping up. Default 5 (10 s). */
  upgradeWindows?: number;
  /** After a downgrade from tier X, never auto-upgrade back into X. */
  stickyDowngrades?: boolean;
  /** Ignore frames for this long after start / a tier change (shader compiles, texture uploads). Default 2500. */
  warmupMs?: number;
}

/**
 * Feed `frame(dtMs, now)` for every continuously-rendered frame. Returns the
 * new tier when it changes, otherwise null.
 */
export class AutoTier {
  private frames = 0;
  private sum = 0;
  private windowStart = -1;
  private goodWindows = 0;
  private readonly banned = new Set<QualityTier>();
  private readonly minFps: number;
  private readonly upgradeFps: number;
  private readonly windowMs: number;
  private readonly upgradeWindows: number;
  private readonly sticky: boolean;
  private readonly warmupMs: number;
  private warmFrom = -1;
  /** Last completed window's average fps (for HUD / tests). */
  lastFps = 0;

  constructor(public tier: QualityTier, opts: AutoTierOptions = {}) {
    this.minFps = opts.minFps ?? 50;
    this.upgradeFps = opts.upgradeFps ?? 58;
    this.windowMs = opts.windowMs ?? 2000;
    this.upgradeWindows = opts.upgradeWindows ?? 5;
    this.sticky = opts.stickyDowngrades ?? true;
    this.warmupMs = opts.warmupMs ?? 2500;
  }

  /** Restart the warm-up window (call after a tier change made elsewhere). */
  rewarm(): void {
    this.warmFrom = -1;
    this.reset();
  }

  /** Drop the current window (camera stopped, tab hidden, tier forced…). */
  reset(): void {
    this.frames = 0;
    this.sum = 0;
    this.windowStart = -1;
  }

  frame(dtMs: number, now: number): QualityTier | null {
    // A gap this long is a pause (tab hidden, loop stopped), not a slow frame.
    // Slower frames still count: software GL runs at 3–5 fps and must step down.
    if (!(dtMs > 0) || dtMs > PAUSE_MS) {
      this.reset();
      return null;
    }
    if (this.warmFrom < 0) this.warmFrom = now;
    if (now - this.warmFrom < this.warmupMs) return null;
    if (this.windowStart < 0) this.windowStart = now;
    this.frames++;
    this.sum += dtMs;
    if (now - this.windowStart < this.windowMs || this.frames < 8) return null;
    const fps = 1000 / (this.sum / this.frames);
    this.lastFps = fps;
    this.reset();
    if (fps < this.minFps) {
      this.goodWindows = 0;
      const next = lowerTier(this.tier);
      if (!next) return null;
      if (this.sticky) this.banned.add(this.tier);
      this.tier = next;
      this.warmFrom = -1;
      return next;
    }
    if (fps >= this.upgradeFps) {
      this.goodWindows++;
      const up = higherTier(this.tier);
      if (up && !this.banned.has(up) && this.goodWindows >= this.upgradeWindows) {
        this.goodWindows = 0;
        this.tier = up;
        this.warmFrom = -1;
        return up;
      }
    } else this.goodWindows = 0;
    return null;
  }
}

/** Rolling FPS meter for the HUD / perf probes (continuous frames only). */
export class FpsMeter {
  private times: number[] = [];
  constructor(private readonly span = 60) {}
  push(dtMs: number): void {
    if (!(dtMs > 0) || dtMs > PAUSE_MS) return;
    this.times.push(dtMs);
    if (this.times.length > this.span) this.times.shift();
  }
  get fps(): number {
    if (!this.times.length) return 0;
    const avg = this.times.reduce((a, b) => a + b, 0) / this.times.length;
    return 1000 / avg;
  }
  /** 95th-percentile frame time (ms). */
  get p95(): number {
    if (!this.times.length) return 0;
    const s = [...this.times].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }
  clear(): void {
    this.times = [];
  }
}
