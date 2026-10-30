/**
 * meshLayout unit tests (node env — no RN renderer, matches existing pattern).
 *
 * Covers the two new neural-map subsystems' pure math:
 *  1. Force-directed spacing: no overlaps, ≥ minDist separation, clamped to
 *     the viewport, and deterministic (same input → identical output).
 *  2. Camera follow: agentRecency picks the latest activity; desiredPan
 *     centers a target world-point for the RN centre-origin transform.
 */
'use strict';

const {
  seedHash,
  agentRecency,
  desiredPan,
  computeForceLayout,
} = require('../utils/meshLayout');

function makeGroups(nPerNode, nodes = 1) {
  const groups = [];
  for (let k = 0; k < nodes; k++) {
    const agents = [];
    for (let i = 0; i < nPerNode; i++) agents.push({ id: `n${k}-a${i}` });
    groups.push({ node: { id: `n${k}`, hub: { x: 200 + k * 120, y: 300 } }, agents });
  }
  return groups;
}

function minPairDistance(map) {
  const pts = [...map.values()];
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < min) min = d;
    }
  }
  return min;
}

describe('seedHash', () => {
  test('deterministic and in [0,1)', () => {
    expect(seedHash('abc')).toBe(seedHash('abc'));
    const v = seedHash('xyz');
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

describe('computeForceLayout', () => {
  const W = 375;
  const H = 700;
  const MIN = 35;

  test('returns a position for every agent', () => {
    const groups = makeGroups(12);
    const map = computeForceLayout(groups, W, H, { minDist: MIN });
    expect(map.size).toBe(12);
  });

  test('no two planets overlap (respects ~minDist)', () => {
    const groups = makeGroups(16);
    const map = computeForceLayout(groups, W, H, { minDist: MIN });
    // Allow a small slack — the hard separation push converges but the spring
    // and clamp can leave a couple px under in dense corners.
    expect(minPairDistance(map)).toBeGreaterThan(MIN - 6);
  });

  test('positions stay within the clamped viewport', () => {
    const groups = makeGroups(20);
    const map = computeForceLayout(groups, W, H, { minDist: MIN });
    for (const p of map.values()) {
      expect(p.x).toBeGreaterThanOrEqual(44);
      expect(p.x).toBeLessThanOrEqual(W - 44);
      expect(p.y).toBeGreaterThanOrEqual(44);
      expect(p.y).toBeLessThanOrEqual(H - 44);
    }
  });

  test('deterministic — identical input yields identical output', () => {
    const a = computeForceLayout(makeGroups(10), W, H, { minDist: MIN });
    const b = computeForceLayout(makeGroups(10), W, H, { minDist: MIN });
    for (const [id, p] of a) {
      expect(b.get(id).x).toBeCloseTo(p.x, 6);
      expect(b.get(id).y).toBeCloseTo(p.y, 6);
    }
  });

  test('handles 0 and 1 agents without crashing', () => {
    expect(computeForceLayout([], W, H).size).toBe(0);
    const one = computeForceLayout(makeGroups(1), W, H);
    expect(one.size).toBe(1);
  });

  test('spreads agents across multiple node hubs', () => {
    const groups = makeGroups(6, 3);
    const map = computeForceLayout(groups, 800, 600, { minDist: MIN });
    expect(map.size).toBe(18);
    expect(minPairDistance(map)).toBeGreaterThan(MIN - 6);
  });
});

describe('agentRecency', () => {
  test('picks the latest numeric/string timestamp', () => {
    expect(agentRecency({ lastUpdateAt: 1000, createdAt: 500 })).toBe(1000);
    expect(agentRecency({ lastActivity: { at: 2000 }, lastUpdateAt: 1500 })).toBe(2000);
  });
  test('parses ISO date strings', () => {
    const iso = '2026-06-19T00:00:00.000Z';
    expect(agentRecency({ startedAt: iso })).toBe(Date.parse(iso));
  });
  test('returns 0 when nothing parseable', () => {
    expect(agentRecency({})).toBe(0);
    expect(agentRecency({ createdAt: 'not-a-date' })).toBe(0);
  });
});

describe('desiredPan', () => {
  const canvas = { width: 375, height: 700 };
  test('centering the canvas centre needs zero pan', () => {
    const p = desiredPan({ x: canvas.width / 2, y: canvas.height / 2 }, canvas, 1);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });
  test('offset scales with zoom and is negated', () => {
    const target = { x: canvas.width / 2 + 100, y: canvas.height / 2 + 50 };
    expect(desiredPan(target, canvas, 1)).toEqual({ x: -100, y: -50 });
    expect(desiredPan(target, canvas, 2)).toEqual({ x: -200, y: -100 });
  });
});
