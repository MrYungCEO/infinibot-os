/**
 * meshLiveness unit tests (node env — no RN renderer, matches the existing
 * mesh-layout.test.js pattern).
 *
 * Locks in the mesh-map liveness parity rules:
 *  1. Nameplates are RUNNING-only and zoom-culled, and counter-scale so they
 *     stay readable across the zoom range.
 *  2. Progress reads determinate when there is a number and indeterminate
 *     otherwise — an agent with no metric must still look like it is working.
 *  3. Finished agents linger briefly (failed longer than completed) before
 *     departing.
 *  4. Motion is deterministic and running agents move on a wider ellipse than
 *     idle ones.
 */
'use strict';

const {
  LABEL_MIN_ZOOM,
  LABEL_MIN_SCALE,
  LABEL_MAX_SCALE,
  LABEL_MAX_CHARS,
  BAR_WIDTH,
  COMPLETED_LINGER_MS,
  FAILED_LINGER_MS,
  SEPARATION_MIN_PX,
  ACTIVE_DRIFT_X,
  IDLE_DRIFT_X,
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
} = require('../utils/meshLiveness');

describe('nameplate visibility — running only, zoom-culled', () => {
  test('a running agent is plated at normal zoom', () => {
    expect(labelVisible({ status: 'running', zoom: 1 })).toBe(true);
  });

  test('idle, completed and errored agents get no plate', () => {
    for (const status of ['idle', 'completed', 'error']) {
      expect(labelVisible({ status, zoom: 1 })).toBe(false);
    }
  });

  test('plates are culled once the camera is far enough out', () => {
    expect(labelVisible({ status: 'running', zoom: LABEL_MIN_ZOOM })).toBe(true);
    expect(labelVisible({ status: 'running', zoom: LABEL_MIN_ZOOM - 0.01 })).toBe(false);
  });

  test('the selected agent is always plated, whatever its state or zoom', () => {
    expect(labelVisible({ status: 'idle', zoom: 0.1, selected: true })).toBe(true);
    expect(labelVisible({ status: 'completed', zoom: 3, selected: true })).toBe(true);
  });
});

describe('label scale + stagger', () => {
  test('counter-scales against zoom, clamped both ways', () => {
    expect(labelScale(1)).toBe(1);
    // Zoomed in -> the plate scales back down, but never below the floor.
    expect(labelScale(4)).toBe(LABEL_MIN_SCALE);
    // Zoomed out -> the plate grows, but never past the ceiling.
    expect(labelScale(0.1)).toBe(LABEL_MAX_SCALE);
    // A missing zoom must not produce NaN or Infinity.
    expect(labelScale(undefined)).toBe(1);
  });

  test('scale is monotonic across the zoom range', () => {
    let prev = Infinity;
    for (const z of [0.2, 0.5, 0.8, 1, 1.5, 2, 3]) {
      const s = labelScale(z);
      expect(s <= prev + 1e-9).toBe(true);
      prev = s;
    }
  });

  test('row assignment is deterministic and uses both rows', () => {
    expect(labelRow('agent-a')).toBe(labelRow('agent-a'));
    const rows = new Set();
    for (let i = 0; i < 40; i++) rows.add(labelRow(`agent-${i}`));
    // Both rows must actually be used or the stagger buys nothing.
    expect(rows.size).toBe(2);
    expect(labelOffsetY('agent-a') >= 0).toBe(true);
  });

  test('long names are ellipsised to the plate budget, short ones are not', () => {
    const long = truncateLabel('a-really-long-agent-name-here');
    expect(long.length).toBe(LABEL_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(truncateLabel('scout')).toBe('SCOUT');
    // Never render an empty plate.
    expect(truncateLabel('')).toBe('AGENT');
    expect(truncateLabel(null)).toBe('AGENT');
  });
});

describe('progress normalisation', () => {
  test('accepts both 0..1 and 0..100 producers', () => {
    expect(normalizeProgress(0.5)).toBe(50);
    expect(normalizeProgress(50)).toBe(50);
    expect(normalizeProgress(1)).toBe(100);
  });

  test('clamps out-of-range values instead of overflowing the bar', () => {
    expect(normalizeProgress(180)).toBe(100);
  });

  test('absent / zero / junk progress reads as indeterminate, not as 0%', () => {
    // This is the distinction that matters: a working agent with no metric
    // must show a sweep, not an empty bar that looks stalled.
    for (const v of [null, undefined, 0, -5, NaN, 'abc']) {
      expect(normalizeProgress(v)).toBeNull();
    }
  });
});

describe('indeterminate sweep', () => {
  test('the segment stays inside the track at every phase', () => {
    for (let t = 0; t < 4; t += 0.05) {
      const seg = sweepSegment(t, 'agent-a', BAR_WIDTH);
      if (!seg) continue;
      expect(seg.x >= 0).toBe(true);
      expect(seg.x + seg.width <= BAR_WIDTH - 2 + 1e-9).toBe(true);
      expect(seg.width > 0).toBe(true);
    }
  });

  test('is deterministic for a given clock + agent', () => {
    expect(sweepSegment(1.234, 'agent-a')).toEqual(sweepSegment(1.234, 'agent-a'));
  });

  test('different agents are out of phase — a row of workers does not pulse in lockstep', () => {
    const a = sweepSegment(0.4, 'agent-a');
    const b = sweepSegment(0.4, 'agent-zzz');
    expect(a).not.toEqual(b);
  });

  test('the segment actually travels over time', () => {
    const start = sweepSegment(0.05, 'agent-a');
    const later = sweepSegment(0.55, 'agent-a');
    expect(start).not.toEqual(later);
  });
});

describe('fast cleanup timing', () => {
  test('completed and errored agents are the ones that depart', () => {
    expect(isFinished('completed')).toBe(true);
    expect(isFinished('error')).toBe(true);
    expect(isFinished('running')).toBe(false);
    expect(isFinished('idle')).toBe(false);
  });

  test('failed lingers longer than completed so the red state is readable', () => {
    expect(lingerMs('completed')).toBe(COMPLETED_LINGER_MS);
    expect(lingerMs('error')).toBe(FAILED_LINGER_MS);
    expect(FAILED_LINGER_MS > COMPLETED_LINGER_MS).toBe(true);
  });

  test('both lingers are short enough that the map reflects live work', () => {
    expect(COMPLETED_LINGER_MS <= 5000).toBe(true);
  });
});

describe('motion', () => {
  test('a running agent drifts on a wider ellipse than an idle one', () => {
    expect(ACTIVE_DRIFT_X > IDLE_DRIFT_X).toBe(true);
    // At the oscillator's extreme with a zero seed, the X component is the
    // full radius, so the amplitudes are directly comparable.
    const run = driftOffset('running', 0, 1);
    const idle = driftOffset('idle', 0, 1);
    expect(Math.abs(run.dx) > Math.abs(idle.dx)).toBe(true);
  });

  test('drift is deterministic — a re-render never makes a planet jump', () => {
    expect(driftOffset('running', 0.37, 0.5)).toEqual(
      driftOffset('running', 0.37, 0.5),
    );
  });

  test('drift is zero at the oscillator centre, so planets rest on their layout point', () => {
    const d = driftOffset('running', 0.37, 0);
    // Compared numerically: a zero-phase cosine can yield -0, which is equal
    // to 0 but not Object.is-identical to it.
    expect(d.dx === 0).toBe(true);
    expect(d.dy === 0).toBe(true);
  });

  test('drift never exceeds its declared radius', () => {
    for (let seed = 0; seed < 1; seed += 0.05) {
      for (const phase of [-1, -0.5, 0, 0.5, 1]) {
        const d = driftOffset('running', seed, phase);
        expect(Math.abs(d.dx) <= ACTIVE_DRIFT_X + 1e-9).toBe(true);
      }
    }
  });
});

describe('anti-cluster', () => {
  test('the separation floor matches the tuned web value and beats the old one', () => {
    expect(SEPARATION_MIN_PX).toBe(52);
    // The map previously used PLANET_RADIUS * 2.5 === 35px, which let running
    // agents sit close enough for their nameplates to overlap.
    expect(SEPARATION_MIN_PX > 35).toBe(true);
  });
});

describe('isRunning', () => {
  test('only the running status counts as live work', () => {
    expect(isRunning('running')).toBe(true);
    expect(isRunning('idle')).toBe(false);
    expect(isRunning('completed')).toBe(false);
  });
});
