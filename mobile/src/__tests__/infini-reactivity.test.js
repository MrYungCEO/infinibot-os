/**
 * Face reactivity: the attack/release envelope, peak → ripple detection,
 * the blended per-frame face parameters, and the text-driven lip-sync
 * envelope used when the player reports no amplitude.
 */
import {
  envelopeStep,
  faceFrame,
  isPeak,
  lookAround,
  mouthShape,
  sampleEnvelope,
  speechEnvelopeFromText,
  syllables,
} from '../infini/face-math';

/** Run the follower at a fixed frame time; return the samples. */
function follow(targets, dt = 1000 / 60, start = 0) {
  let v = start;
  return targets.map((t) => (v = envelopeStep(v, t, dt)));
}
const W = (k) => ({ idle: 0, listen: 0, think: 0, speak: 0, error: 0, connect: 0, [k]: 1 });

describe('envelope smoothing (attack 40 ms, release 180 ms)', () => {
  test('attack reaches ~63% of a step in 40 ms, ~95% in 120 ms', () => {
    expect(envelopeStep(0, 1, 40)).toBeCloseTo(1 - Math.exp(-1), 5);
    const at120 = follow(Array(Math.round(120 / (1000 / 60))).fill(1)).pop();
    expect(at120).toBeGreaterThan(0.94);
  });

  test('release is slower: ~63% of the fall in 180 ms', () => {
    expect(envelopeStep(1, 0, 180)).toBeCloseTo(Math.exp(-1), 5);
    const fall100 = follow(Array(6).fill(0), 1000 / 60, 1).pop(); // 100 ms
    expect(fall100).toBeGreaterThan(0.5); // still well open — no flicker between syllables
  });

  test('frame-rate independent: 60 fps and 120 fps agree', () => {
    const a = follow(Array(6).fill(1), 1000 / 60).pop();
    const b = follow(Array(12).fill(1), 1000 / 120).pop();
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
  });

  test('never overshoots and ignores a zero/garbage dt', () => {
    expect(envelopeStep(0.2, 0.8, 10_000)).toBeLessThanOrEqual(0.8);
    expect(envelopeStep(0.3, 1, 0)).toBe(0.3);
    expect(envelopeStep(0.3, 1, NaN)).toBe(0.3);
  });
});

describe('ripples on peaks', () => {
  test('fires on a loud rising edge, respects the refractory window', () => {
    expect(isPeak(0.3, 0.5, 1000)).toBe(true);
    expect(isPeak(0.3, 0.5, 100)).toBe(false); // too soon
    expect(isPeak(0.6, 0.55, 1000)).toBe(false); // falling
    expect(isPeak(0.1, 0.2, 1000)).toBe(false); // too quiet
  });

  test('a syllable train produces a ripple per loud syllable', () => {
    let env = 0;
    let last = -1e9;
    let n = 0;
    for (let f = 0; f < 120; f++) {
      const t = f * (1000 / 60);
      const lvl = Math.floor(t / 250) % 2 === 0 ? 0.85 : 0.05; // 2 Hz on/off
      const prev = env;
      env = envelopeStep(env, lvl, 1000 / 60);
      if (isPeak(prev, env, t - last)) {
        last = t;
        n += 1;
      }
    }
    expect(n).toBe(4); // 2 s of 4 loud bursts
  });
});

describe('faceFrame: reactivity per state', () => {
  test('listening: louder mic → bigger, stretched, wider eyes, bigger ring', () => {
    const quiet = faceFrame(W('listen'), 1, 0.2);
    const loud = faceFrame(W('listen'), 1, 0.8);
    expect(loud.sy).toBeGreaterThan(quiet.sy);
    expect(loud.sy / loud.sx).toBeGreaterThan(quiet.sy / quiet.sx); // squash/stretch
    expect(loud.eyeH).toBeGreaterThan(quiet.eyeH);
    expect(loud.ring.r).toBeGreaterThan(quiet.ring.r);
    expect(loud.ring.opacity).toBeGreaterThan(quiet.ring.opacity);
    expect(loud.glow).toBeGreaterThan(quiet.glow);
  });

  test('speaking: the mouth opens with the amplitude', () => {
    expect(faceFrame(W('speak'), 1, 0.9).mouth.open).toBeGreaterThan(15);
    expect(faceFrame(W('speak'), 1, 0).mouth.open).toBeLessThan(1);
  });

  test('state weights blend smoothly (half-way transition is in between)', () => {
    const a = faceFrame(W('idle'), 1, 0);
    const b = faceFrame(W('error'), 1, 0);
    const mid = faceFrame({ idle: 0.5, listen: 0, think: 0, speak: 0, error: 0.5, connect: 0 }, 1, 0);
    expect(mid.mouth.curve).toBeCloseTo((a.mouth.curve + b.mouth.curve) / 2, 6);
    expect(mid.brows).toBe(0.5);
  });

  test('thinking shows the swirl; reduce motion freezes wobble and blink', () => {
    expect(faceFrame(W('think'), 2, 0).swirl).toBe(1);
    const r = faceFrame(W('listen'), 3.1, 0.7, 0);
    expect(r.wobble).toBe(0);
    expect(r.blink).toBe(0);
    expect(r.floatY).toBeCloseTo(0, 9);
  });

  test('tap squish and wake perk-up', () => {
    const base = faceFrame(W('idle'), 0, 0);
    const pressed = faceFrame(W('idle'), 0, 0, 1, 1);
    expect(pressed.sy).toBeLessThan(base.sy);
    expect(pressed.sx).toBeGreaterThan(pressed.sy);
    const perk = faceFrame(W('idle'), 0, 0, 1, 0, 1);
    expect(perk.eyeH).toBeGreaterThan(base.eyeH);
    expect(perk.sy).toBeGreaterThan(base.sy);
  });

  test('idle look-around stays inside the eye loops', () => {
    for (let t = 0; t < 30; t += 0.05) {
      const p = lookAround(t);
      expect(Math.abs(p.dx)).toBeLessThanOrEqual(4.5);
      expect(Math.abs(p.dy)).toBeLessThanOrEqual(2.4);
    }
  });

  test('mouth shape is one closed path that morphs (same command count)', () => {
    const closed = mouthShape({ width: 30, curve: 7, open: 0 });
    const open = mouthShape({ width: 30, curve: 8, open: 18 });
    expect(closed.split(/[MQZ]/).length).toBe(open.split(/[MQZ]/).length);
  });
});

describe('lip-sync envelope from text', () => {
  test('syllable counter', () => {
    expect(syllables('hello')).toBe(2);
    expect(syllables('board')).toBe(1);
    expect(syllables('today')).toBe(2);
    expect(syllables('infinibot')).toBe(4);
    expect(syllables('make')).toBe(1);
  });

  test('stretches to the clip duration at the requested frame rate', () => {
    const env = speechEnvelopeFromText('You have three tasks due today.', { durationSec: 2.4, fps: 50 });
    expect(env.frames).toHaveLength(120);
    expect(env.syllables).toBe(7); // you-have-three-tasks-due-to-day
    for (const v of env.frames) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test('one mouth opening per syllable', () => {
    const env = speechEnvelopeFromText('one two three four five', { durationSec: 2, fps: 100 });
    // count rising crossings of 0.4
    let peaks = 0;
    for (let i = 1; i < env.frames.length; i++) if (env.frames[i - 1] < 0.4 && env.frames[i] >= 0.4) peaks += 1;
    expect(peaks).toBe(5);
  });

  test('commas and full stops close the mouth for a pause', () => {
    const env = speechEnvelopeFromText('Yes, absolutely. Done', { durationSec: 3, fps: 50 });
    // Lowest point in the middle third is a pause (near-closed).
    const mid = env.frames.slice(10, 140);
    expect(Math.min(...mid)).toBeLessThan(0.05);
    // and it is open most of the time while talking
    expect(env.frames.filter((v) => v > 0.3).length).toBeGreaterThan(env.frames.length * 0.35);
  });

  test('silent lead-in / tail, and sampling follows playback position', () => {
    const env = speechEnvelopeFromText('hello there', { durationSec: 1.2, fps: 50 });
    expect(sampleEnvelope(env, 0)).toBe(0);
    expect(sampleEnvelope(env, 1.19)).toBeLessThan(0.05);
    const peakIdx = env.frames.indexOf(Math.max(...env.frames));
    expect(sampleEnvelope(env, peakIdx / 50)).toBeCloseTo(env.frames[peakIdx], 6);
    expect(sampleEnvelope(env, 99)).toBe(0); // past the end
    expect(sampleEnvelope(null, 1)).toBe(0);
  });

  test('without a known duration it assumes a natural speaking rate', () => {
    const env = speechEnvelopeFromText('This is a sentence with about twelve syllables in it.');
    const sec = env.frames.length / env.fps;
    expect(sec).toBeGreaterThan(1.5);
    expect(sec).toBeLessThan(4.5);
  });
});
