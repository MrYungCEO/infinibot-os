/**
 * reconnect-policy — the gateway socket's reconnect state machine (pure, so
 * src/__tests__/reconnect-policy.test.js covers it without a renderer).
 *
 *   network failure → back off (1s, 2s, 4s … 10s) and retry
 *   auth / pairing  → HALT: no automatic retry until the user acts (Retry,
 *                     edit the connection, switch profile). Retrying a wrong
 *                     password just hammers the gateway once a second and the
 *                     user only ever sees "not connecting".
 *
 * A device token is the one exception: it is bound to the gateway that issued
 * it and can go stale, so an auth failure while one was used clears it and
 * retries ONCE immediately with the profile's own secret.
 */
import { reconnectBackoff } from '../lib/gateway-liveness';
import { classifyConnectFailure } from './connection-logic';

export function initialReconnectState() {
  return { attempt: 0, halted: null };
}

/**
 * @param state  { attempt, halted }
 * @param error  the connect failure (Error with code/details, or a message)
 * @param opts   { usedDeviceToken }
 * @returns { state, action:'retry'|'halt', delayMs, failure, clearDeviceToken }
 */
export function onConnectFailure(state, error, { usedDeviceToken = false } = {}) {
  const failure = classifyConnectFailure(error);
  if (failure.kind !== 'network') {
    if (usedDeviceToken && failure.kind === 'auth') {
      return { state: { attempt: state.attempt, halted: null }, action: 'retry', delayMs: 0, failure, clearDeviceToken: true };
    }
    return { state: { attempt: state.attempt, halted: failure }, action: 'halt', delayMs: null, failure, clearDeviceToken: false };
  }
  const attempt = state.attempt + 1;
  return { state: { attempt, halted: null }, action: 'retry', delayMs: reconnectBackoff(attempt), failure, clearDeviceToken: false };
}

/** A socket that closed without a classified handshake failure. */
export function onSocketClosed(state) {
  if (state.halted) return { state, action: 'halt', delayMs: null };
  const attempt = state.attempt + 1;
  return { state: { attempt, halted: null }, action: 'retry', delayMs: reconnectBackoff(attempt) };
}

export function onConnected() {
  return initialReconnectState();
}

/** The user pressed Retry / saved a connection / switched profile. */
export function onUserRetry() {
  return initialReconnectState();
}

/** May an automatic path (timer, app foreground, status effect) reconnect? */
export function canAutoReconnect(state) {
  return !state.halted;
}
