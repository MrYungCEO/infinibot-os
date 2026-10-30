/**
 * Pure reconnect/heartbeat rules for the gateway WS layer (useGateway).
 * Extracted so they can be unit-tested without a React renderer.
 *
 * (These used to live in lib/voice-call-logic.js next to the mobile app's
 * old phone-side voice pipeline. Voice now runs through the InfiniBot call
 * page — local voice by default — and only these socket rules remain.)
 */

'use strict';

// ── Reconnect backoff ────────────────────────────────────────────────────────
// Exponential schedule capped low so a dropped socket resumes fast:
// 1s, 2s, 4s, … capped at 10s.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_FACTOR = 2;
const RECONNECT_CAP_MS = 10_000;

/**
 * Delay (ms) before reconnect attempt `attempt` (1-based).
 *   attempt 1 → 1000, 2 → 2000, 3 → 4000, 4 → 8000, 5+ → 10000 (capped).
 */
function reconnectBackoff(
  attempt,
  { base = RECONNECT_BASE_MS, factor = RECONNECT_FACTOR, cap = RECONNECT_CAP_MS } = {},
) {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(base * Math.pow(factor, n - 1), cap);
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
// If no frame arrives for 15s, treat the socket as dead and reconnect.
const HEARTBEAT_ACK_TIMEOUT_MS = 15_000;

/**
 * Given the timestamp of the last frame received from the gateway and `now`,
 * decide whether the socket should be considered dead (no traffic within the
 * ack window). Any inbound frame — ping ack, event, response — counts as life.
 */
function isHeartbeatStale(lastFrameAtMs, now, timeout = HEARTBEAT_ACK_TIMEOUT_MS) {
  if (!lastFrameAtMs) return false; // never received anything yet → not "stale"
  return now - lastFrameAtMs >= timeout;
}

module.exports = {
  RECONNECT_BASE_MS,
  RECONNECT_FACTOR,
  RECONNECT_CAP_MS,
  reconnectBackoff,
  HEARTBEAT_ACK_TIMEOUT_MS,
  isHeartbeatStale,
};
