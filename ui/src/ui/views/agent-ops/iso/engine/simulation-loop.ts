/**
 * Fixed-step simulation loop with interpolated render.
 * ────────────────────────────────────────────────────
 * Decouples the *data tick* (deterministic, fixed-timestep physics/state
 * update) from the *render frame* (variable, vsync-driven). This is the
 * canonical "Fix Your Timestep" accumulator pattern (Glenn Fiedler):
 *
 *   accumulator += min(frameTime, maxFrameDt) * timeScale
 *   while (accumulator >= dtFixed) { update(dtFixed); accumulator -= dtFixed }
 *   render(accumulator / dtFixed)   // alpha ∈ [0,1) → interpolate prev→curr
 *
 * Why it matters for the world viz:
 *  - Simulation advances in identical discrete steps regardless of frame rate,
 *    so behaviour is reproducible (see {@link ./determinism.ts}) and stable.
 *  - Render interpolates between the last two sim states, so motion stays
 *    smooth even when the display refresh and the tick rate diverge.
 *  - A `maxFrameDt` clamp prevents the "spiral of death" when a tab is
 *    backgrounded and `requestAnimationFrame` resumes with a huge delta.
 *
 * Clock + scheduler are injectable so the loop is fully testable under a fake
 * clock with zero real time elapsing (see `simulation-loop.test.ts`).
 */

import { rafLoop, type SchedulerHandle } from "../../../../perf/visibility-scheduler";

export interface SimulationConsumer {
  /** Advance simulation state by exactly `dt` seconds (the fixed step). */
  update?(dt: number): void;
  /**
   * Draw the world. `alpha` ∈ [0,1) is the fraction of a fixed step the
   * accumulator currently holds — use it to interpolate prev→curr state so
   * rendering stays smooth between discrete ticks.
   */
  render?(alpha: number): void;
}

export type FrameScheduler = (cb: (nowMs: number) => void) => number;
export type FrameCanceller = (handle: number) => void;

export interface SimulationLoopOptions {
  /** Fixed update rate in Hz. Default 60. */
  hz?: number;
  /**
   * Maximum real frame delta (seconds) fed into the accumulator per frame.
   * Clamps catch-up after a stall so we never run an unbounded update burst.
   * Default 0.25 (i.e. at most ~15 catch-up ticks at 60Hz).
   */
  maxFrameDt?: number;
  /** Monotonic millisecond clock. Default `performance.now`. */
  now?: () => number;
  /** Frame scheduler. Default `requestAnimationFrame`. */
  schedule?: FrameScheduler;
  /** Frame canceller. Default `cancelAnimationFrame`. */
  cancel?: FrameCanceller;
}

export interface SimulationMetrics {
  /** Smoothed rendered frames per second. */
  fps: number;
  /** Smoothed simulation updates per second (≈ hz × timeScale once warm). */
  tickRate: number;
  /** Total fixed updates run since start. */
  tickCount: number;
  /** Total render frames since start. */
  frameCount: number;
  /** Current interpolation alpha ∈ [0,1). */
  alpha: number;
  /** Active time scale. */
  timeScale: number;
  /** Whether the loop is running. */
  running: boolean;
}

const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const defaultSchedule: FrameScheduler = (cb) =>
  typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame((t) => cb(t))
    : (setTimeout(() => cb(defaultNow()), 16) as unknown as number);

const defaultCancel: FrameCanceller = (h) => {
  if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(h);
  else clearTimeout(h);
};

export class SimulationLoop {
  private readonly hz: number;
  private readonly dtFixed: number; // seconds
  private readonly maxFrameDt: number;
  private readonly now: () => number;
  private readonly schedule: FrameScheduler;
  private readonly cancel: FrameCanceller;
  private readonly useVisibilityScheduler: boolean;

  private consumers = new Set<SimulationConsumer>();
  private running = false;
  private rafHandle: number | null = null;
  private visibilityLoop: SchedulerHandle | null = null;

  private accumulator = 0; // seconds
  private lastTimeMs = 0;
  private timeScale = 1;

  private tickCount = 0;
  private frameCount = 0;
  private alpha = 0;

  // EMA-smoothed rates for the telemetry HUD.
  private fpsEma = 0;
  private tickEma = 0;
  private static readonly EMA = 0.1;

  constructor(opts: SimulationLoopOptions = {}) {
    this.hz = Math.max(1, opts.hz ?? 60);
    this.dtFixed = 1 / this.hz;
    this.maxFrameDt = opts.maxFrameDt ?? 0.25;
    this.now = opts.now ?? defaultNow;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.cancel = opts.cancel ?? defaultCancel;
    this.useVisibilityScheduler = opts.schedule == null && opts.cancel == null;
  }

  /** Register a consumer; returns an unregister thunk. */
  register(consumer: SimulationConsumer): () => void {
    this.consumers.add(consumer);
    return () => {
      this.consumers.delete(consumer);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = this.now();
    this.accumulator = 0;
    if (this.useVisibilityScheduler) {
      this.visibilityLoop = rafLoop((t) => this.frame(t));
    } else {
      this.rafHandle = this.schedule((t) => this.frame(t));
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rafHandle != null) {
      this.cancel(this.rafHandle);
      this.rafHandle = null;
    }
    this.visibilityLoop?.cancel();
    this.visibilityLoop = null;
  }

  /** 0 = paused (render still interpolates), 1 = realtime, >1 = fast-forward. */
  setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, scale);
  }

  getTimeScale(): number {
    return this.timeScale;
  }

  isRunning(): boolean {
    return this.running;
  }

  getMetrics(): SimulationMetrics {
    return {
      fps: this.fpsEma,
      tickRate: this.tickEma,
      tickCount: this.tickCount,
      frameCount: this.frameCount,
      alpha: this.alpha,
      timeScale: this.timeScale,
      running: this.running,
    };
  }

  /**
   * Run a single frame given the current wall time (ms). Public so tests can
   * drive the loop deterministically under a fake clock without scheduling.
   */
  frame(nowMs: number): void {
    const frameTimeSec = Math.min(
      Math.max(0, (nowMs - this.lastTimeMs) / 1000),
      this.maxFrameDt,
    );
    this.lastTimeMs = nowMs;

    if (frameTimeSec > 0) {
      this.fpsEma = lerp(this.fpsEma, 1 / frameTimeSec, SimulationLoop.EMA);
    }

    this.accumulator += frameTimeSec * this.timeScale;

    let ticksThisFrame = 0;
    // Tiny epsilon so a frame delta that lands *exactly* on a step boundary
    // (e.g. a real 16.667ms frame at 60Hz) reliably produces its tick despite
    // float rounding, instead of stalling one update behind.
    const stepThreshold = this.dtFixed - 1e-9;
    while (this.accumulator >= stepThreshold) {
      for (const c of this.consumers) c.update?.(this.dtFixed);
      this.accumulator -= this.dtFixed;
      this.tickCount++;
      ticksThisFrame++;
    }

    if (frameTimeSec > 0) {
      const instTickRate = ticksThisFrame / frameTimeSec;
      this.tickEma = lerp(this.tickEma, instTickRate, SimulationLoop.EMA);
    }

    this.alpha = Math.max(0, this.accumulator / this.dtFixed);
    for (const c of this.consumers) c.render?.(this.alpha);
    this.frameCount++;

    if (this.running && !this.useVisibilityScheduler) {
      this.rafHandle = this.schedule((t) => this.frame(t));
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
