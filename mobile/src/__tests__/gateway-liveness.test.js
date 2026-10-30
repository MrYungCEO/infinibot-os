/**
 * Unit tests for the gateway socket liveness rules used by useGateway:
 *   1. Reconnect exponential backoff (1s, 2s, 4s, 8s, capped 10s).
 *   2. Heartbeat staleness (15s silent socket → reconnect).
 */

'use strict';

const {
  reconnectBackoff,
  isHeartbeatStale,
  HEARTBEAT_ACK_TIMEOUT_MS,
} = require('../lib/gateway-liveness');

describe('reconnectBackoff', () => {
  test('follows the 1/2/4/8s exponential schedule', () => {
    expect(reconnectBackoff(1)).toBe(1000);
    expect(reconnectBackoff(2)).toBe(2000);
    expect(reconnectBackoff(3)).toBe(4000);
    expect(reconnectBackoff(4)).toBe(8000);
  });

  test('caps at 10s for later attempts', () => {
    expect(reconnectBackoff(5)).toBe(10_000);
    expect(reconnectBackoff(6)).toBe(10_000);
    expect(reconnectBackoff(99)).toBe(10_000);
  });

  test('clamps non-positive / fractional attempts to attempt 1', () => {
    expect(reconnectBackoff(0)).toBe(1000);
    expect(reconnectBackoff(-3)).toBe(1000);
    expect(reconnectBackoff(1.9)).toBe(1000);
  });
});

describe('isHeartbeatStale', () => {
  test('not stale when traffic seen inside the ack window', () => {
    const now = 1_000_000;
    expect(isHeartbeatStale(now - 5_000, now)).toBe(false);
    expect(isHeartbeatStale(now - (HEARTBEAT_ACK_TIMEOUT_MS - 1), now)).toBe(false);
  });

  test('stale once the socket is silent past the ack window', () => {
    const now = 1_000_000;
    expect(isHeartbeatStale(now - HEARTBEAT_ACK_TIMEOUT_MS, now)).toBe(true);
    expect(isHeartbeatStale(now - 30_000, now)).toBe(true);
  });

  test('a socket that never received a frame is not yet "stale"', () => {
    expect(isHeartbeatStale(null, 1_000_000)).toBe(false);
    expect(isHeartbeatStale(0, 1_000_000)).toBe(false);
  });
});
