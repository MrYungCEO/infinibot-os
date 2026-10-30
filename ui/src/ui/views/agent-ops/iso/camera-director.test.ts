/**
 * Unit tests for the CameraDirector and its pure framing/easing helpers.
 *
 * The director is exercised through mock deps with a fake clock so every motion
 * decision is deterministic. We assert:
 *  - easing/spring math (camera-easing)
 *  - bbox + weighted-centroid + spread→scale framing (camera-targets)
 *  - multi-target framing (centroid of the active set, spread-driven zoom)
 *  - smooth pursuit (spring converges, never overshoots)
 *  - single-target follow (focusAgent pins + trails)
 *  - user override + broadcast yield timing
 *  - idle orbit
 */

import { describe, expect, it, vi } from "vitest";
import {
  CameraDirector,
  smoothstep,
  type CameraDirectorDeps,
  type CameraEvent,
} from "./camera-director";
import {
  clamp,
  criticallyDampedStep,
  cubicInOut,
  lerp,
  omegaForSettle,
  smootherstep,
  springSettled,
} from "./camera-easing";
import {
  bboxDiagonal,
  boundingBox,
  computeFrame,
  scaleFromSpread,
  weightedCentroid,
} from "./camera-targets";

// Always treat autofocus as ON regardless of localStorage state.
vi.stubGlobal("localStorage", {
  getItem: () => "1",
  setItem: vi.fn(),
});

// ── Mock factory ──────────────────────────────────────────────────────────

interface MockState {
  nowMs: number;
  pausedUntil: number;
  broadcastEnabled: boolean;
  agentPos: Record<string, { x: number; y: number } | null>;
}

function makeDeps(initial: Partial<MockState> = {}): {
  state: MockState;
  deps: CameraDirectorDeps;
  flyTo: ReturnType<typeof vi.fn>;
  ambientDrift: ReturnType<typeof vi.fn>;
} {
  const state: MockState = {
    nowMs: 10_000,
    pausedUntil: 0,
    broadcastEnabled: false,
    agentPos: {},
    ...initial,
  };

  const flyTo = vi.fn();
  const ambientDrift = vi.fn();

  const deps: CameraDirectorDeps = {
    now: () => state.nowMs,
    agentExists: (k: string) =>
      state.agentPos[k] !== null && state.agentPos[k] !== undefined
        ? true
        : Object.keys(state.agentPos).length === 0, // no pos map → default exists
    agentWorldPos: (k: string) => state.agentPos[k] ?? { x: 100, y: 200 },
    flyTo,
    ambientDrift,
    getPausedUntil: () => state.pausedUntil,
    isBroadcastEnabled: () => state.broadcastEnabled,
  };

  return { state, deps, flyTo, ambientDrift };
}

function makeEvent(kind: CameraEvent["kind"], overrides: Partial<CameraEvent> = {}): CameraEvent {
  return { kind, sessionKey: "sess:1", ts: 10_000, ...overrides };
}

/** Advance the clock and tick the director N frames at ~16ms each. */
function runFrames(d: CameraDirector, state: MockState, frames: number, stepMs = 16): void {
  for (let i = 0; i < frames; i++) {
    state.nowMs += stepMs;
    d.tick();
  }
}

function lastFly(flyTo: ReturnType<typeof vi.fn>): { x: number; y: number; scale: number } {
  const c = flyTo.mock.calls[flyTo.mock.calls.length - 1] as [number, number, number, number];
  return { x: c[0], y: c[1], scale: c[2] };
}

// ── easing: smoothstep / smootherstep / cubicInOut ──────────────────────────

describe("easing curves", () => {
  it("smoothstep is 0/0.5/1 and clamps", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5);
    expect(smoothstep(-5)).toBe(0);
    expect(smoothstep(5)).toBe(1);
  });

  it("smootherstep is symmetric S-curve clamped to [0,1]", () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5);
    expect(smootherstep(2)).toBe(1);
  });

  it("cubicInOut is monotonic and bounded", () => {
    expect(cubicInOut(0)).toBe(0);
    expect(cubicInOut(1)).toBe(1);
    expect(cubicInOut(0.5)).toBeCloseTo(0.5);
    expect(cubicInOut(0.25)).toBeLessThan(0.25); // ease-in: below the diagonal early
    expect(cubicInOut(0.75)).toBeGreaterThan(0.75); // ease-out: above it late
  });

  it("lerp + clamp behave", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
  });
});

// ── easing: critically-damped spring ────────────────────────────────────────

describe("critically-damped spring", () => {
  it("at rest on target stays put", () => {
    const next = criticallyDampedStep({ x: 50, v: 0 }, 50, omegaForSettle(400), 16);
    expect(next.x).toBeCloseTo(50);
    expect(next.v).toBeCloseTo(0);
  });

  it("converges monotonically without overshoot", () => {
    let s = { x: 0, v: 0 };
    const omega = omegaForSettle(400);
    let prev = -1;
    for (let i = 0; i < 200; i++) {
      s = criticallyDampedStep(s, 100, omega, 16);
      // never overshoots the target
      expect(s.x).toBeLessThanOrEqual(100.0001);
      // moves toward target every step
      expect(s.x).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = s.x;
    }
    expect(s.x).toBeCloseTo(100, 1);
  });

  it("settles to within ~1% by the configured settle time", () => {
    let s = { x: 0, v: 0 };
    const settleMs = 400;
    const omega = omegaForSettle(settleMs);
    // integrate exactly settleMs worth of 16ms frames
    const frames = Math.round(settleMs / 16);
    for (let i = 0; i < frames; i++) s = criticallyDampedStep(s, 100, omega, 16);
    expect(s.x).toBeGreaterThan(98); // ~99% there
  });

  it("is frame-rate independent (one big step ≈ many small steps)", () => {
    const omega = omegaForSettle(400);
    let small = { x: 0, v: 0 };
    for (let i = 0; i < 10; i++) small = criticallyDampedStep(small, 100, omega, 8);
    const big = criticallyDampedStep({ x: 0, v: 0 }, 100, omega, 80);
    expect(small.x).toBeCloseTo(big.x, 3);
  });

  it("respects max speed clamp", () => {
    // Huge displacement but tiny speed cap → bounded travel in one step.
    const next = criticallyDampedStep({ x: 0, v: 0 }, 1_000_000, omegaForSettle(50), 16, 100);
    // velocity is clamped to 100 px/s → at most ~100*0.016 ≈ 1.6px of travel
    expect(Math.abs(next.x)).toBeLessThan(5);
  });

  it("springSettled reports true only when near target and slow", () => {
    expect(springSettled({ x: 100, v: 0 }, 100, 0.5, 0.5)).toBe(true);
    expect(springSettled({ x: 90, v: 0 }, 100, 0.5, 0.5)).toBe(false);
    expect(springSettled({ x: 100, v: 50 }, 100, 0.5, 0.5)).toBe(false);
  });
});

// ── targets: bbox / centroid / spread ───────────────────────────────────────

describe("framing math", () => {
  it("boundingBox spans all points", () => {
    const b = boundingBox([{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: -5, y: 5 }])!;
    expect(b).toEqual({ minX: -5, minY: 0, maxX: 10, maxY: 20 });
    expect(bboxDiagonal(b)).toBeCloseTo(Math.hypot(15, 20));
  });

  it("boundingBox of empty set is null", () => {
    expect(boundingBox([])).toBeNull();
  });

  it("weightedCentroid biases toward heavy points", () => {
    const c = weightedCentroid([
      { x: 0, y: 0, weight: 1 },
      { x: 100, y: 0, weight: 3 },
    ])!;
    expect(c.x).toBeCloseTo(75); // pulled toward the weight-3 point
    expect(c.y).toBe(0);
  });

  it("weightedCentroid falls back to mean when all weights zero", () => {
    const c = weightedCentroid([
      { x: 0, y: 0, weight: 0 },
      { x: 10, y: 10, weight: 0 },
    ])!;
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(5);
  });

  it("scaleFromSpread zooms IN when tight, OUT when wide", () => {
    const o = { tightScale: 1.45, wideScale: 0.85, referenceSpanPx: 1000, minScale: 0.4, maxScale: 2.2 };
    expect(scaleFromSpread(0, o)).toBeCloseTo(1.45); // single point / tight
    expect(scaleFromSpread(1000, o)).toBeCloseTo(0.85); // fully spread
    const mid = scaleFromSpread(500, o);
    expect(mid).toBeLessThan(1.45);
    expect(mid).toBeGreaterThan(0.85);
  });

  it("computeFrame centers on weighted centroid and picks a fitting scale", () => {
    const spread = { tightScale: 1.45, wideScale: 0.85, referenceSpanPx: 1000, minScale: 0.4, maxScale: 2.2 };
    const frame = computeFrame(
      [
        { x: 0, y: 0, weight: 1 },
        { x: 200, y: 0, weight: 1 },
      ],
      { spread },
    )!;
    expect(frame.x).toBeCloseTo(100);
    expect(frame.y).toBe(0);
    expect(frame.scale).toBeLessThan(1.45); // some spread → slightly zoomed out
  });

  it("computeFrame uses exact viewport fit when provided", () => {
    const spread = { tightScale: 1.45, wideScale: 0.85, referenceSpanPx: 1000, minScale: 0.1, maxScale: 5 };
    const frame = computeFrame(
      [
        { x: 0, y: 0, weight: 1 },
        { x: 400, y: 0, weight: 1 },
      ],
      { spread, fit: { viewportWidth: 800, viewportHeight: 800, paddingPx: 0, minScale: 0.1, maxScale: 5 } },
    )!;
    // width 400 fits in 800 → scale 2 (height is 0 so width dominates)
    expect(frame.scale).toBeCloseTo(2);
  });
});

// ── director: multi-target framing ──────────────────────────────────────────

describe("multi-target framing", () => {
  it("frames the weighted centroid of all active agents, not just one", () => {
    const { state, deps, flyTo } = makeDeps({
      agentPos: { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } },
    });
    const d = new CameraDirector(deps, { referenceSpanPx: 1000 });

    d.noteEvent(makeEvent("tool", { sessionKey: "a", ts: state.nowMs }));
    d.noteEvent(makeEvent("tool", { sessionKey: "b", ts: state.nowMs }));

    runFrames(d, state, 1); // first tick seeds + commits at the centroid
    expect(flyTo).toHaveBeenCalled();
    const f = lastFly(flyTo);
    // Two equally-weighted agents → centroid at x≈200.
    expect(f.x).toBeCloseTo(200, 0);
    expect(f.y).toBeCloseTo(0, 0);
  });

  it("zooms IN for a tight cluster and OUT for a spread one", () => {
    // Tight cluster.
    {
      const { state, deps, flyTo } = makeDeps({
        agentPos: { a: { x: 0, y: 0 }, b: { x: 30, y: 0 } },
      });
      const d = new CameraDirector(deps, { referenceSpanPx: 1000, focusScale: 1.45, idleScale: 0.85 });
      d.noteEvent(makeEvent("tool", { sessionKey: "a", ts: state.nowMs }));
      d.noteEvent(makeEvent("tool", { sessionKey: "b", ts: state.nowMs }));
      runFrames(d, state, 1);
      expect(lastFly(flyTo).scale).toBeGreaterThan(1.3); // near focusScale
    }
    // Spread cluster.
    {
      const { state, deps, flyTo } = makeDeps({
        agentPos: { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 } },
      });
      const d = new CameraDirector(deps, { referenceSpanPx: 1000, focusScale: 1.45, idleScale: 0.85 });
      d.noteEvent(makeEvent("tool", { sessionKey: "a", ts: state.nowMs }));
      d.noteEvent(makeEvent("tool", { sessionKey: "b", ts: state.nowMs }));
      runFrames(d, state, 1);
      expect(lastFly(flyTo).scale).toBeCloseTo(0.85, 1); // near idleScale
    }
  });

  it("a single fresh event lands the camera right on that agent at focusScale", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps, { focusScale: 1.45 });
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    runFrames(d, state, 1);
    const f = lastFly(flyTo);
    expect(f.x).toBe(100);
    expect(f.y).toBe(200);
    expect(f.scale).toBeCloseTo(1.45);
  });

  it("custom weights pull the centroid (setWeights)", () => {
    const { state, deps, flyTo } = makeDeps({
      agentPos: { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } },
    });
    const d = new CameraDirector(deps, { referenceSpanPx: 1000 });
    d.setWeights((k) => (k === "b" ? 9 : 1)); // strongly favor b
    d.noteEvent(makeEvent("tool", { sessionKey: "a", ts: state.nowMs }));
    d.noteEvent(makeEvent("tool", { sessionKey: "b", ts: state.nowMs }));
    runFrames(d, state, 1);
    expect(lastFly(flyTo).x).toBeGreaterThan(300); // pulled toward b@400
  });
});

// ── director: smooth pursuit ────────────────────────────────────────────────

describe("smooth pursuit", () => {
  it("eases toward a moved agent over multiple frames without overshoot", () => {
    const { state, deps, flyTo } = makeDeps({ agentPos: { "sess:1": { x: 0, y: 0 } } });
    const d = new CameraDirector(deps, { followSettleMs: 480, commitMinIntervalMs: 0 });

    d.noteEvent(makeEvent("tool", { sessionKey: "sess:1", ts: state.nowMs }));
    runFrames(d, state, 1); // seed + commit at (0,0)
    expect(lastFly(flyTo).x).toBeCloseTo(0, 0);

    // Move the agent far; keep it "active" with fresh events.
    state.agentPos["sess:1"] = { x: 1000, y: 0 };
    const xs: number[] = [];
    for (let i = 0; i < 40; i++) {
      state.nowMs += 16;
      d.noteEvent(makeEvent("tool", { sessionKey: "sess:1", ts: state.nowMs }));
      d.tick();
      xs.push(lastFly(flyTo).x);
    }
    // Monotonic, no overshoot past the target.
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-6);
    expect(xs[xs.length - 1]).toBeLessThanOrEqual(1000.001);
    expect(xs[xs.length - 1]).toBeGreaterThan(900); // got most of the way there
    // It did NOT teleport on the first pursuit frame.
    expect(xs[0]).toBeLessThan(500);
  });

  it("does not re-dispatch when the frame is steady (anti-jitter)", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps, { commitMinIntervalMs: 100 });
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    runFrames(d, state, 1);
    const callsAfterFirst = flyTo.mock.calls.length;
    // Settled on a static single agent → further frames shouldn't spam flyTo.
    runFrames(d, state, 30);
    expect(flyTo.mock.calls.length - callsAfterFirst).toBeLessThanOrEqual(1);
  });
});

// ── director: single-target follow (focusAgent) ─────────────────────────────

describe("single-target follow", () => {
  it("pins to a clicked agent and trails it as it moves", () => {
    const { state, deps, flyTo } = makeDeps({
      agentPos: { hero: { x: 0, y: 0 }, noise: { x: 999, y: 999 } },
    });
    const d = new CameraDirector(deps, { commitMinIntervalMs: 0, pinScale: 1.7 });

    // Lots of noise from another agent — must be ignored while pinned.
    d.noteEvent(makeEvent("complete", { sessionKey: "noise", ts: state.nowMs }));
    d.focusAgent("hero");
    runFrames(d, state, 1);
    let f = lastFly(flyTo);
    expect(f.x).toBeCloseTo(0, 0);
    expect(f.scale).toBeCloseTo(1.7, 1);
    expect(d.getPinnedAgent()).toBe("hero");

    // Move hero; camera should trail toward it (not toward the noise agent).
    state.agentPos.hero = { x: 600, y: 0 };
    runFrames(d, state, 60);
    f = lastFly(flyTo);
    expect(f.x).toBeGreaterThan(550);
    expect(f.x).toBeLessThan(700); // never near the noise agent at 999

    // Release → pin cleared.
    d.focusAgent(null);
    expect(d.getPinnedAgent()).toBeNull();
  });

  it("auto-releases the pin if the agent leaves the map", () => {
    const { state, deps } = makeDeps({ agentPos: { hero: { x: 0, y: 0 } } });
    const d = new CameraDirector(deps, { commitMinIntervalMs: 0 });
    d.focusAgent("hero");
    runFrames(d, state, 1);
    expect(d.getPinnedAgent()).toBe("hero");
    // Agent disappears.
    state.agentPos.hero = null;
    runFrames(d, state, 1);
    expect(d.getPinnedAgent()).toBeNull();
  });
});

// ── director: user override ─────────────────────────────────────────────────

describe("user override", () => {
  it("yields while the host getPausedUntil is in the future", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps);
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    state.pausedUntil = state.nowMs + 4000;
    runFrames(d, state, 3);
    expect(flyTo).not.toHaveBeenCalled();
  });

  it("setUserOverride pauses the director for the given window then resumes", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps, { userOverrideMs: 4000 });

    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    d.setUserOverride(); // default 4000ms
    expect(d.isOverridden()).toBe(true);
    runFrames(d, state, 5); // ~80ms — still inside override
    expect(flyTo).not.toHaveBeenCalled();

    // Advance past the override and feed a fresh event.
    state.nowMs += 4200;
    expect(d.isOverridden()).toBe(false);
    d.noteEvent(makeEvent("complete", { ts: state.nowMs }));
    runFrames(d, state, 1);
    expect(flyTo).toHaveBeenCalled();
  });

  it("setUserOverride accepts a custom duration", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps);
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    d.setUserOverride(1000);
    runFrames(d, state, 5); // ~80ms in
    expect(flyTo).not.toHaveBeenCalled();
    state.nowMs += 1100;
    d.noteEvent(makeEvent("complete", { ts: state.nowMs }));
    runFrames(d, state, 1);
    expect(flyTo).toHaveBeenCalled();
  });
});

// ── director: broadcast yield ───────────────────────────────────────────────

describe("broadcast yield", () => {
  it("does not move the camera while BroadcastDirector is enabled", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps);
    state.broadcastEnabled = true;
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    runFrames(d, state, 3);
    expect(flyTo).not.toHaveBeenCalled();
  });

  it("resumes once broadcast is turned off", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps);
    state.broadcastEnabled = true;
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    runFrames(d, state, 2);
    expect(flyTo).not.toHaveBeenCalled();

    state.broadcastEnabled = false;
    state.nowMs += 200;
    d.noteEvent(makeEvent("complete", { ts: state.nowMs }));
    runFrames(d, state, 1);
    expect(flyTo).toHaveBeenCalled();
  });
});

// ── director: idle orbit ────────────────────────────────────────────────────

describe("idle orbit", () => {
  it("calls ambientDrift after idleTriggerMs of no events", () => {
    const { state, deps, ambientDrift } = makeDeps();
    const d = new CameraDirector(deps, { idleTriggerMs: 12_000, idleOrbitMs: 9_000 });
    state.nowMs += 13_000;
    d.tick();
    expect(ambientDrift).toHaveBeenCalledOnce();
  });

  it("does NOT orbit while there are fresh events", () => {
    const { state, deps, ambientDrift } = makeDeps();
    const d = new CameraDirector(deps, { idleTriggerMs: 12_000 });
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    runFrames(d, state, 1);
    expect(ambientDrift).not.toHaveBeenCalled();
  });

  it("throttles orbit to one drift per idleOrbitMs window", () => {
    const { state, deps, ambientDrift } = makeDeps();
    const d = new CameraDirector(deps, { idleTriggerMs: 12_000, idleOrbitMs: 9_000 });
    state.nowMs += 13_000;
    d.tick();
    d.tick();
    state.nowMs += 1_000;
    d.tick();
    expect(ambientDrift).toHaveBeenCalledTimes(1);
  });
});

// ── director: enabled state ─────────────────────────────────────────────────

describe("enabled state", () => {
  it("is ON by default", () => {
    const { deps } = makeDeps();
    expect(new CameraDirector(deps).isEnabled()).toBe(true);
  });

  it("does not tick when disabled", () => {
    const { state, deps, flyTo } = makeDeps();
    const d = new CameraDirector(deps);
    d.setEnabled(false);
    d.noteEvent(makeEvent("spawn", { ts: state.nowMs }));
    runFrames(d, state, 3);
    expect(flyTo).not.toHaveBeenCalled();
  });

  it("getCurrentSubject returns null when disabled", () => {
    const { deps } = makeDeps();
    const d = new CameraDirector(deps);
    d.setEnabled(false);
    expect(d.getCurrentSubject()).toBeNull();
  });
});
