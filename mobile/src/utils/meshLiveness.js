/**
 * meshLiveness — pure helpers for the agent neural map's liveness layer.
 *
 * Mobile parity for the web mesh-map liveness upgrade
 * (`ui/src/ui/views/agent-ops/activity-map.ts`, feat/mesh-map-liveness):
 * running-agent nameplates, live progress bars, fast cleanup of finished
 * agents, anti-cluster spacing and subtle idle motion.
 *
 * Everything here is deterministic — no Math.random, no Date.now — so a
 * re-render can never make a planet jump or a label hop rows. Same rule as
 * meshLayout.js, and for the same reason. Kept separate from the screen so
 * the numbers are testable in a plain Node environment.
 */

import { seedHash } from './meshLayout';

// ── Nameplate (running agents only) ───────────────────────────────────────
// A plate is drawn ONLY for an agent that is actually running. Idle hubs stay
// clean; a live agent always gets its name. Below LABEL_MIN_ZOOM the map reads
// as a star-field anyway, so the plates are culled rather than shrunk to mush.
export const LABEL_MIN_ZOOM = 0.5;
export const LABEL_MIN_SCALE = 0.8;
export const LABEL_MAX_SCALE = 1.55;
export const LABEL_MAX_CHARS = 14;
/** Two label rows, so plates on the same visual row don't collide. */
export const LABEL_ROW_OFFSET = 13;

// ── Progress bar ──────────────────────────────────────────────────────────
export const BAR_WIDTH = 54;
export const BAR_HEIGHT = 4;
/** Width of the travelling segment in the indeterminate sweep, as a fraction. */
export const SWEEP_SEGMENT = 0.36;
/** Sweeps per second. */
export const SWEEP_SPEED = 0.9;
/** At/above this percent the determinate fill turns from gold to green. */
export const BAR_DONE_PCT = 90;

// ── Fast cleanup ──────────────────────────────────────────────────────────
// Finished agents should not linger — the map is meant to show what is
// actually running. Failed lingers longer so the red state is readable before
// it leaves.
export const COMPLETED_LINGER_MS = 3200;
export const FAILED_LINGER_MS = 5500;
/** Duration of the shrink + rise + fade depart animation. */
export const DEPART_MS = 500;

// ── Anti-cluster spacing ──────────────────────────────────────────────────
// The web tuned its render-space repulsion to a 52px floor. The mobile map
// uses a frozen force-directed pass instead of a live repulsion loop, so the
// same guarantee is bought up-front by raising the layout's minimum distance.
export const SEPARATION_MIN_PX = 52;

// ── Idle / active motion ──────────────────────────────────────────────────
// A running agent drifts on a wider, slower ellipse so it visibly breathes
// between tool calls; an idle one keeps the barely-there wobble it had.
export const ACTIVE_DRIFT_X = 7;
export const ACTIVE_DRIFT_Y = 4;
export const IDLE_DRIFT_X = 3;
export const IDLE_DRIFT_Y = 3;

/** Statuses that mean "this agent is doing work right now". */
export function isRunning(status) {
  return status === 'running';
}

/** Statuses that are terminal — the agent is done and should depart. */
export function isFinished(status) {
  return status === 'completed' || status === 'error';
}

/** How long a finished agent stays on the map before it departs. */
export function lingerMs(status) {
  return status === 'error' ? FAILED_LINGER_MS : COMPLETED_LINGER_MS;
}

/**
 * Should this agent's nameplate + progress bar render right now?
 * Running only, and only once the camera is close enough to read them. A
 * selected agent is always plated so the bottom sheet has a visual anchor.
 */
export function labelVisible({ status, zoom, selected = false }) {
  if (selected) return true;
  if (!isRunning(status)) return false;
  return (zoom || 1) >= LABEL_MIN_ZOOM;
}

/**
 * Counter-scale for the plate so it stays readable across the zoom range:
 * the map scales up, the label scales back down (clamped both ways).
 */
export function labelScale(zoom) {
  const z = zoom || 1;
  return Math.min(Math.max(1 / z, LABEL_MIN_SCALE), LABEL_MAX_SCALE);
}

/**
 * Deterministic 0/1 row for an agent's plate. Two agents that end up on the
 * same visual row drop to alternating label rows instead of overlapping.
 */
export function labelRow(id) {
  return seedHash(`row:${id}`) < 0.5 ? 0 : 1;
}

/** Vertical offset (px) of the plate stack for an agent. */
export function labelOffsetY(id) {
  return labelRow(id) * LABEL_ROW_OFFSET;
}

/** Trim a label to the plate's character budget, with an ellipsis. */
export function truncateLabel(raw, max = LABEL_MAX_CHARS) {
  const s = String(raw || 'AGENT');
  if (s.length <= max) return s.toUpperCase();
  return `${s.slice(0, max - 1)}…`.toUpperCase();
}

/**
 * Normalise whatever the server sent for progress into 0..100, or null when
 * there is no numeric progress (which is the signal to render the
 * indeterminate sweep instead of a fake determinate bar).
 */
export function normalizeProgress(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Some producers report 0..1, others 0..100.
  const pct = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Geometry of the travelling segment in the indeterminate sweep, in px along
 * a `trackWidth` track. Returns null when the segment is entirely off-track.
 *
 * @param elapsedSeconds monotonic animation clock
 * @param id             agent id — seeds a per-agent phase offset so a row of
 *                       working agents doesn't sweep in lockstep
 */
export function sweepSegment(elapsedSeconds, id, trackWidth = BAR_WIDTH) {
  const inner = trackWidth - 2;
  const segW = trackWidth * SWEEP_SEGMENT;
  const t = ((elapsedSeconds * SWEEP_SPEED + seedHash(id)) % 1 + 1) % 1;
  const travel = (inner + segW) * t - segW;
  const x = Math.max(0, travel);
  const end = Math.min(inner, travel + segW);
  if (end <= x) return null;
  return { x, width: end - x };
}

/**
 * Per-agent drift offset around its frozen layout position.
 *
 * `phase` is the shared -1..1 oscillator the screen already drives; the seed
 * gives each agent its own point on the ellipse so the field never moves in
 * lockstep. Running agents get the wider, slower ellipse (they "breathe"
 * between tool calls); everything else keeps the tiny idle wobble.
 */
export function driftOffset(status, seed, phase) {
  const running = isRunning(status);
  const rx = running ? ACTIVE_DRIFT_X : IDLE_DRIFT_X;
  const ry = running ? ACTIVE_DRIFT_Y : IDLE_DRIFT_Y;
  const angle = seed * Math.PI * 2;
  return {
    dx: Math.cos(angle) * phase * rx,
    // Quarter-turn out of phase so the path is an ellipse, not a diagonal line.
    dy: Math.sin(angle + Math.PI / 2) * phase * ry,
  };
}

export default {
  LABEL_MIN_ZOOM,
  LABEL_MIN_SCALE,
  LABEL_MAX_SCALE,
  LABEL_MAX_CHARS,
  LABEL_ROW_OFFSET,
  BAR_WIDTH,
  BAR_HEIGHT,
  BAR_DONE_PCT,
  COMPLETED_LINGER_MS,
  FAILED_LINGER_MS,
  DEPART_MS,
  SEPARATION_MIN_PX,
  isRunning,
  isFinished,
  lingerMs,
  labelVisible,
  labelScale,
  labelRow,
  labelOffsetY,
  truncateLabel,
  normalizeProgress,
  sweepSegment,
  driftOffset,
};
