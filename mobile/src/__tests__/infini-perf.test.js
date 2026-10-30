/**
 * Infini page performance helpers: device tier / effect budget, the ripple
 * reach that keeps audio ripples inside the screen on phones, prop
 * quantisation, and the face's distance-to-edge from the layout.
 */
import { perfTierFor, effectBudget } from '../infini/perf-tier';
import { quantize, rippleGrowth, swirlScale } from '../infini/face-math';
import { edgeRoom, infiniLayout } from '../infini/layout';

const GB = 1024 * 1024 * 1024;

describe('perfTierFor', () => {
  test('iOS and web are always high', () => {
    expect(perfTierFor({ os: 'ios', totalMemory: 1 * GB, yearClass: 2014 })).toBe('high');
    expect(perfTierFor({ os: 'web' })).toBe('high');
  });
  test('Android with little RAM or an old year class is low', () => {
    expect(perfTierFor({ os: 'android', totalMemory: 2 * GB, yearClass: 2022 })).toBe('low');
    expect(perfTierFor({ os: 'android', totalMemory: 6 * GB, yearClass: 2016 })).toBe('low');
  });
  test('capable or unknown Android stays high', () => {
    expect(perfTierFor({ os: 'android', totalMemory: 8 * GB, yearClass: 2023 })).toBe('high');
    expect(perfTierFor({ os: 'android', totalMemory: null, yearClass: null })).toBe('high');
    expect(perfTierFor({ os: 'android' })).toBe('high');
  });
  test('budget trims particles and stills the aurora on low', () => {
    expect(effectBudget('high')).toEqual({ particles: 14, auroraMotion: true, backdropLite: false });
    expect(effectBudget('low')).toEqual({ particles: 8, auroraMotion: false, backdropLite: true });
  });
});

describe('rippleGrowth', () => {
  // Outer ripple radius in px for a given growth (orb r = 74 in a 160-unit face box).
  const outer = (growth, size) => 74 * (1.03 + growth) * (size / 160);

  test('roomy screens keep the full 0.42 swell', () => {
    expect(rippleGrowth(1000, 300)).toBeCloseTo(0.42, 3);
  });
  test.each([
    ['390x844 portrait', 390, 844, { top: 47, bottom: 34 }],
    ['375x667 portrait', 375, 667, { top: 20, bottom: 0 }],
    ['430x932 portrait', 430, 932, { top: 59, bottom: 34 }],
    ['844x390 landscape', 844, 390, { left: 47, right: 47, bottom: 21 }],
    ['667x375 landscape', 667, 375, {}],
  ])('%s: the outermost ripple stays on screen', (_n, w, h, insets) => {
    const l = infiniLayout(w, h, insets);
    const g = rippleGrowth(l.face.room, l.faceSize);
    expect(g).toBeGreaterThan(0.08);
    expect(g).toBeLessThanOrEqual(0.42);
    expect(outer(g, l.faceSize)).toBeLessThanOrEqual(l.face.room);
  });
  test('degenerate input falls back to the default', () => {
    expect(rippleGrowth(0, 300)).toBeCloseTo(0.42, 3);
    expect(rippleGrowth(200, 0)).toBeCloseTo(0.42, 3);
  });
});

describe('quantize / edgeRoom', () => {
  test('quantize rounds to the step', () => {
    expect(quantize(0.2637, 0.002)).toBeCloseTo(0.264, 6);
    expect(quantize(1.0004, 0.001)).toBeCloseTo(1, 6);
  });
  test('edgeRoom is the nearest edge distance', () => {
    expect(edgeRoom(195, 400, 390, 844)).toBe(195);
    expect(edgeRoom(422, 200, 844, 390)).toBe(190);
    expect(edgeRoom(-5, 10, 100, 100)).toBe(0);
  });
  test('layouts expose face.room', () => {
    expect(infiniLayout(390, 844, { top: 47, bottom: 34 }).face.room).toBe(195);
    expect(infiniLayout(844, 390, {}).face.room).toBeGreaterThan(150);
  });
});

describe('swirlScale', () => {
  test('roomy screens keep 1.3', () => {
    expect(swirlScale(1000, 300)).toBe(1.3);
    expect(swirlScale(0, 300)).toBe(1.3);
  });
  test.each([
    ['390x844', 390, 844, { top: 47, bottom: 34 }],
    ['375x667', 375, 667, { top: 20 }],
    ['430x932', 430, 932, { top: 59, bottom: 34 }],
    ['844x390', 844, 390, { left: 47, right: 47, bottom: 21 }],
  ])('%s: the comet arcs stay on screen and clear the orb', (_n, w, h, insets) => {
    const l = infiniLayout(w, h, insets);
    const k = swirlScale(l.face.room, l.faceSize);
    const arcPx = (99.2 / 208) * k * l.faceSize;
    expect(arcPx).toBeLessThanOrEqual(l.face.room);
    expect(k).toBeGreaterThanOrEqual(1.15);
  });
});
