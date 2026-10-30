/**
 * camera-easing — pure, deterministic motion math for the CameraDirector.
 *
 * Nothing here touches PIXI, the DOM, or wall-clock time: every function takes
 * its inputs explicitly so it can be unit-tested with a fake clock. The two
 * pillars are:
 *
 *  1. `criticallyDampedStep` — a critically-damped spring integrator. It moves
 *     a value toward a target with NO overshoot and NO oscillation, settling in
 *     a predictable time. Unlike a linear lerp, its velocity is continuous, so
 *     a moving target produces buttery pursuit instead of stair-stepping.
 *
 *  2. Easing curves (`smoothstep`, `cubicInOut`) — S-curves with zero slope at
 *     both ends, used for discrete blends (e.g. spread→scale mapping).
 *
 * The spring is integrated with the analytic solution of a critically-damped
 * harmonic oscillator, which is exact for any dt (frame-rate independent) and
 * unconditionally stable — large dt spikes can never explode the value the way
 * an explicit Euler spring would.
 */

/** Smoothstep: cubic S-curve, clamped to [0,1]. Zero 1st-derivative at ends. */
export function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/** Smootherstep: quintic S-curve — zero 1st AND 2nd derivative at ends. */
export function smootherstep(t: number): number {
  const c = clamp01(t);
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/** Symmetric cubic ease-in-out over [0,1]. */
export function cubicInOut(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Convert a desired settle time (≈99% of the way there) into an angular
 * frequency (omega) for the critically-damped spring. A critically-damped
 * system reaches ~99% in roughly 6/omega seconds, so omega ≈ 6 / settleSec.
 */
export function omegaForSettle(settleMs: number): number {
  const settleSec = Math.max(0.0001, settleMs / 1000);
  return 6 / settleSec;
}

export interface SpringState {
  /** Current position. */
  x: number;
  /** Current velocity (units per second). */
  v: number;
}

/**
 * Advance a critically-damped spring by dt seconds toward `target`.
 *
 * Uses the closed-form solution of  x'' + 2ω x' + ω² (x − target) = 0  with the
 * critical-damping assumption (damping ratio = 1). This is exact for any dt and
 * never overshoots or oscillates — the hallmark of a "director" camera that
 * glides and settles instead of snapping or ringing.
 *
 * @param state   current {x, v}
 * @param target  goal position
 * @param omega   angular frequency (use omegaForSettle); larger = snappier
 * @param dtMs    elapsed time in milliseconds
 * @param maxSpeed optional clamp on |velocity| (units/sec) to cap pan speed
 */
export function criticallyDampedStep(
  state: SpringState,
  target: number,
  omega: number,
  dtMs: number,
  maxSpeed = Infinity,
): SpringState {
  const dt = Math.max(0, dtMs) / 1000;
  if (dt === 0 || omega <= 0) return { x: state.x, v: state.v };

  // Clamp velocity going in so a fast-moving goalpost can't fling the camera.
  let v0 = state.v;
  if (Number.isFinite(maxSpeed)) v0 = clamp(v0, -maxSpeed, maxSpeed);

  const d = state.x - target; // displacement from target
  const e = Math.exp(-omega * dt);
  // Critically-damped closed form:
  //   x(t) = target + (d + (v0 + omega*d)*t) * e^(-omega t)
  //   v(t) = (v0 - omega*(d + (v0 + omega*d)*t)) * e^(-omega t)
  const c = v0 + omega * d;
  const x = target + (d + c * dt) * e;
  let v = (v0 - c * omega * dt) * e;
  if (Number.isFinite(maxSpeed)) v = clamp(v, -maxSpeed, maxSpeed);
  return { x, v };
}

/** True once a spring has effectively reached its target (within eps + slow). */
export function springSettled(
  state: SpringState,
  target: number,
  posEps: number,
  velEps: number,
): boolean {
  return Math.abs(state.x - target) <= posEps && Math.abs(state.v) <= velEps;
}
