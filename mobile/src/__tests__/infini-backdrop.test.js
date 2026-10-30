/**
 * Infini backdrop helpers: the dust field is deterministic (drawn once, never
 * re-generated per frame), keeps the face clear, and the light pool picks a
 * tint per face state.
 */
import { dustField, moodLight, seeded } from '../infini/backdrop-math';

describe('dustField', () => {
  const box = { width: 420, height: 880, cx: 210, cy: 400, hole: 150 };

  test('same seed and box → identical field (static SVG, rasterised once)', () => {
    expect(dustField({ seed: 11, count: 40, ...box })).toEqual(dustField({ seed: 11, count: 40, ...box }));
    expect(dustField({ seed: 11, count: 40, ...box })).not.toEqual(dustField({ seed: 12, count: 40, ...box }));
  });

  test('specks stay inside the box, small, and out of the face hole', () => {
    const f = dustField({ seed: 29, count: 40, rMin: 0.6, rMax: 1.6, ...box });
    expect(f.length).toBe(40);
    for (const d of f) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(box.width);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(box.height);
      expect(d.r).toBeGreaterThan(0);
      expect(d.r).toBeLessThanOrEqual(1.6 * 1.4 + 0.01);
      expect(d.o).toBeGreaterThan(0);
      expect(d.o).toBeLessThanOrEqual(1);
      expect(Math.hypot(d.x - box.cx, d.y - box.cy)).toBeGreaterThanOrEqual(box.hole * 0.75 - 0.2);
    }
  });

  test('specks keep out of the avoid rects (status text)', () => {
    const info = { left: 16, top: 640, width: 388, height: 84 };
    const f = dustField({ seed: 11, count: 60, ...box, avoid: [info] });
    expect(f.length).toBe(60);
    for (const d of f) expect(d.x >= info.left - 8 && d.x <= info.left + info.width + 8 && d.y >= info.top - 8 && d.y <= info.top + info.height + 8).toBe(false);
  });

  test('seeded PRNG is in [0, 1)', () => {
    const r = seeded(3);
    for (let i = 0; i < 200; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('moodLight', () => {
  test('listening / thinking / error go cool and tinted; speaking is full warm gold', () => {
    expect(moodLight('listening').cool).toBeGreaterThan(moodLight('listening').warm);
    expect(moodLight('thinking').cool).toBeGreaterThan(moodLight('thinking').warm);
    expect(moodLight('error').tint).toBe('#e5675c');
    expect(moodLight('speaking')).toMatchObject({ warm: 1, cool: 0 });
    expect(moodLight('listening').tint).not.toBe(moodLight('thinking').tint);
  });
  test('unknown states fall back to idle', () => {
    expect(moodLight('whatever')).toEqual(moodLight('idle'));
  });
});
