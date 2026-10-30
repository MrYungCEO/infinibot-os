/**
 * Fake-clock determinism tests for SimulationLoop.
 *
 * We drive the loop with an injected clock + scheduler so zero real time
 * elapses and every update/render decision is reproducible. We assert:
 *  - fixed-step accumulation (N ticks for a known elapsed time at a given Hz)
 *  - render runs once per frame with a correct interpolation alpha
 *  - maxFrameDt clamps the catch-up burst (no spiral of death)
 *  - timeScale scales the tick count
 *  - the same scripted frame sequence yields the same tick count every run
 */

import { describe, expect, it } from "vitest";
import { SimulationLoop } from "./simulation-loop";

/** Manual scheduler: stores the pending frame cb so the test flushes it. */
function makeHarness(hz = 60, maxFrameDt = 0.25) {
  let nowMs = 0;
  let pending: ((t: number) => void) | null = null;
  let handleSeq = 1;

  const loop = new SimulationLoop({
    hz,
    maxFrameDt,
    now: () => nowMs,
    schedule: (cb) => {
      pending = cb;
      return handleSeq++;
    },
    cancel: () => {
      pending = null;
    },
  });

  let ticks = 0;
  let renders = 0;
  let lastAlpha = -1;
  loop.register({
    update: () => {
      ticks++;
    },
    render: (alpha) => {
      renders++;
      lastAlpha = alpha;
    },
  });

  /** Advance the clock by `ms` and run exactly one scheduled frame. */
  const advanceFrame = (ms: number) => {
    nowMs += ms;
    const cb = pending;
    pending = null;
    cb?.(nowMs);
  };

  return {
    loop,
    advanceFrame,
    get ticks() {
      return ticks;
    },
    get renders() {
      return renders;
    },
    get lastAlpha() {
      return lastAlpha;
    },
  };
}

describe("SimulationLoop", () => {
  it("accumulates exactly one fixed step per 1/Hz of elapsed time", () => {
    const h = makeHarness(60);
    h.loop.start();
    // 10 frames of 16.6667ms ≈ 166.67ms → 10 ticks at 60Hz.
    for (let i = 0; i < 10; i++) h.advanceFrame(1000 / 60);
    expect(h.ticks).toBe(10);
    expect(h.renders).toBe(10);
  });

  it("runs multiple catch-up ticks within one long frame", () => {
    const h = makeHarness(60);
    h.loop.start();
    // First frame establishes the baseline (dt 0 → 0 ticks).
    h.advanceFrame(0);
    // One 100ms frame → floor(0.1 / (1/60)) = 6 ticks.
    h.advanceFrame(100);
    expect(h.ticks).toBe(6);
    expect(h.renders).toBe(2);
  });

  it("interpolation alpha is the leftover accumulator fraction", () => {
    const h = makeHarness(60);
    h.loop.start();
    h.advanceFrame(0);
    // Half a fixed step (8.3333ms) leaves alpha ≈ 0.5, zero ticks.
    h.advanceFrame(1000 / 120);
    expect(h.ticks).toBe(0);
    expect(h.lastAlpha).toBeCloseTo(0.5, 2);
  });

  it("clamps a huge frame delta to maxFrameDt (no spiral of death)", () => {
    const h = makeHarness(60, 0.25);
    h.loop.start();
    h.advanceFrame(0);
    // 10 seconds backgrounded → clamped to 0.25s → 15 ticks, not 600.
    h.advanceFrame(10_000);
    expect(h.ticks).toBe(15);
  });

  it("setTimeScale scales the number of ticks", () => {
    const h = makeHarness(60);
    h.loop.setTimeScale(2);
    h.loop.start();
    h.advanceFrame(0);
    h.advanceFrame(100); // 0.1s × 2 = 0.2s → 12 ticks
    expect(h.ticks).toBe(12);
  });

  it("timeScale 0 pauses simulation but still renders", () => {
    const h = makeHarness(60);
    h.loop.setTimeScale(0);
    h.loop.start();
    h.advanceFrame(0);
    h.advanceFrame(100);
    expect(h.ticks).toBe(0);
    expect(h.renders).toBe(2);
  });

  it("is deterministic: identical frame scripts → identical tick counts", () => {
    const script = [0, 16, 16, 33, 8, 50, 16, 16, 16, 100];
    const run = () => {
      const h = makeHarness(60);
      h.loop.start();
      for (const ms of script) h.advanceFrame(ms);
      return h.ticks;
    };
    expect(run()).toBe(run());
  });

  it("stop() halts further frames", () => {
    const h = makeHarness(60);
    h.loop.start();
    h.advanceFrame(1000 / 60);
    const ticksBefore = h.ticks;
    h.loop.stop();
    h.advanceFrame(1000); // nothing scheduled → no-op
    expect(h.ticks).toBe(ticksBefore);
  });

  it("supports multiple registered consumers", () => {
    const h = makeHarness(60);
    let secondTicks = 0;
    h.loop.register({ update: () => secondTicks++ });
    h.loop.start();
    h.advanceFrame(0);
    h.advanceFrame(1000 / 60);
    expect(secondTicks).toBe(h.ticks);
    expect(secondTicks).toBeGreaterThan(0);
  });
});
