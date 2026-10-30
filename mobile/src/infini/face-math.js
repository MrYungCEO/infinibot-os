/**
 * face-math — pure geometry for the InfiniBot character (no React, no RN).
 *
 * The character is a soft gold glass blob (the logo's orb) with a dark glass
 * visor. Its eyes are the logo's infinity loop: one ∞ stroke, a pupil inside
 * each loop. Everything here is a function of (state, time, level) so the
 * component just evaluates it once per animation frame, and jest can check
 * every state without a renderer.
 *
 * Coordinates: a 200 × 200 viewBox centred on (100, 100).
 *
 * States: idle | listening | thinking | speaking | error  (plus "connecting",
 * drawn like thinking but calmer).
 */

export const FACE_STATES = ['idle', 'listening', 'thinking', 'speaking', 'error', 'connecting'];

export const FACE_COLORS = {
  goldHi: '#fbe6a2',
  gold: '#e9b949',
  goldMid: '#c98f2a',
  goldDeep: '#7a4f12',
  visor: '#0b0906',
  visorEdge: 'rgba(251, 230, 162, 0.35)',
  feature: '#f6d27a',
  featureHot: '#fff1c4',
  sad: '#9fb6d9',
};

const TAU = 6.283185307179586;
function clamp01(v) {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function r1(n) {
  'worklet';
  return Math.round(n * 10) / 10;
}

/** Blink envelope: 0 = open, 1 = closed. A blink every ~4.2 s, a double blink now and then. */
export function blinkAmount(t) {
  'worklet';
  const period = 4.2;
  const phase = t % period;
  const one = (p) => (p >= 0 && p < 0.16 ? Math.sin((Math.PI * p) / 0.16) : 0);
  const cycle = Math.floor(t / period);
  const double = cycle % 3 === 2 ? one(phase - 0.26) : 0;
  return Math.max(one(phase), double);
}

/**
 * Animation parameters for one frame.
 * @param {string} state   one of FACE_STATES
 * @param {number} t       seconds since mount
 * @param {number} level   0..1 — mic level while listening, TTS amplitude while speaking
 * @param {{reducedMotion?: boolean}} [opts]
 */
export function faceParams(state, t, level = 0, opts = {}) {
  const reduced = Boolean(opts.reducedMotion);
  const lv = clamp01(level);
  const breathe = reduced ? 0 : Math.sin(t * 1.6) * 0.5 + 0.5; // 0..1, ~4 s cycle
  const base = {
    scale: 1 + (reduced ? 0 : 0.018 * breathe),
    floatY: reduced ? 0 : Math.sin(t * 1.1) * 2.2,
    wobble: reduced ? 0 : 0.35,
    glow: 0.22 + 0.08 * breathe,
    glowColor: FACE_COLORS.gold,
    blink: reduced ? 0 : blinkAmount(t),
    pupil: { dx: reduced ? 0 : Math.sin(t * 0.37) * 3.2, dy: reduced ? 0 : Math.sin(t * 0.23) * 1.6 },
    mouth: { width: 30, curve: 7, open: 0 },
    brows: 0,
    swirl: null,
    ripple: null,
    tint: null,
  };
  switch (state) {
    case 'listening':
      return {
        ...base,
        scale: 1.03 + (reduced ? 0 : 0.05 * lv),
        wobble: reduced ? 0 : 0.5 + lv * 1.4,
        glow: 0.5 + 0.5 * lv,
        glowColor: FACE_COLORS.goldHi,
        pupil: { dx: base.pupil.dx * 0.4, dy: -2.6 },
        // An attentive "ooh": the mouth rounds as the voice gets louder.
        mouth: { width: 22 - lv * 6, curve: 4, open: 2.5 + lv * 9 },
        ripple: reduced ? null : { phase: (t * 0.9) % 1, strength: 0.25 + lv * 0.75 },
      };
    case 'thinking':
    case 'connecting': {
      const spin = reduced ? 0 : t * (state === 'thinking' ? 2.4 : 1.4);
      return {
        ...base,
        wobble: reduced ? 0 : 0.6,
        glow: 0.38 + (reduced ? 0 : 0.12 * Math.sin(t * 3)),
        // Pupils circle inside their loops — the ∞ "thinks".
        pupil: { dx: Math.cos(spin) * 4.2, dy: Math.sin(spin) * 3.2 },
        mouth: { width: 18, curve: reduced ? 0 : Math.sin(t * 2.2) * 2, open: 0 },
        swirl: { angle: reduced ? 0 : (t * (state === 'thinking' ? 140 : 70)) % 360, strength: state === 'thinking' ? 1 : 0.55 },
      };
    }
    case 'speaking': {
      const amp = lv;
      return {
        ...base,
        scale: 1.02 + (reduced ? 0 : 0.035 * amp),
        wobble: reduced ? 0 : 0.45 + amp * 0.9,
        glow: 0.42 + 0.45 * amp,
        pupil: { dx: base.pupil.dx * 0.5, dy: 0.5 },
        // Jaw opens with the TTS amplitude; a happy curve underneath.
        mouth: { width: 30 + amp * 4, curve: 8, open: 1.5 + amp * 15 },
        ripple: reduced ? null : { phase: (t * 1.3) % 1, strength: 0.2 + amp * 0.6 },
      };
    }
    case 'error':
      return {
        ...base,
        scale: 0.985,
        floatY: reduced ? 0 : Math.sin(t * 0.8) * 1.2,
        wobble: reduced ? 0 : 0.2,
        glow: 0.16,
        glowColor: FACE_COLORS.sad,
        pupil: { dx: 0, dy: 3 },
        mouth: { width: 22, curve: -6, open: 0 },
        brows: 1,
        tint: FACE_COLORS.sad,
      };
    default:
      return base;
  }
}

/**
 * Closed smooth blob path through `n` points on a wobbling circle
 * (Catmull-Rom → cubic Bézier).
 */
export function blobPath(t, { radius = 74, wobble = 0.35, energy = 0, points = 9, cx = 100, cy = 100 } = {}) {
  'worklet';
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * TAU;
    const w =
      Math.sin(t * 1.3 + i * 1.7) * 0.55 +
      Math.sin(t * 0.7 + i * 2.9) * 0.3 +
      Math.sin(t * 2.3 + i * 0.6) * 0.15 * (1 + energy);
    const r = radius * (1 + w * 0.045 * wobble);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 0; i < points; i++) {
    const p0 = pts[(i - 1 + points) % points];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % points];
    const p3 = pts[(i + 2) % points];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return `${d} Z`;
}

/**
 * The ∞ eyes: a lemniscate of Bernoulli centred at (cx, cy). `squash` (0..1)
 * closes it vertically for blinks. Returns the stroke path and the two loop
 * centres (where the pupils sit).
 */
export function infinityEyes({ cx = 100, cy = 92, a = 44, height = 1.35, squash = 0, steps = 48 } = {}) {
  'worklet';
  const k = height * (1 - 0.92 * clamp01(squash));
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * TAU;
    const den = 1 + Math.sin(s) ** 2;
    const x = cx + (a * Math.cos(s)) / den;
    const y = cy + ((a * Math.sin(s) * Math.cos(s)) / den) * k;
    d += `${i === 0 ? 'M' : ' L'}${r1(x)} ${r1(y)}`;
  }
  return { d: `${d} Z`, left: { x: cx - a * 0.62, y: cy }, right: { x: cx + a * 0.62, y: cy }, openness: k / height };
}

/**
 * Mouth path. `open` > 0 draws a filled open mouth (upper + lower lip);
 * `curve` > 0 smiles, < 0 frowns.
 */
export function mouthPath({ width = 30, curve = 7, open = 0 } = {}, { cx = 100, cy = 130 } = {}) {
  'worklet';
  const half = width / 2;
  const x0 = r1(cx - half);
  const x1 = r1(cx + half);
  const y = r1(cy - curve * 0.25);
  if (open <= 0.6) {
    return { d: `M${x0} ${y} Q${r1(cx)} ${r1(y + curve)} ${x1} ${y}`, filled: false };
  }
  const upper = r1(y + curve * 0.35);
  const lower = r1(y + curve + open);
  return {
    d: `M${x0} ${y} Q${r1(cx)} ${upper} ${x1} ${y} Q${r1(cx)} ${lower} ${x0} ${y} Z`,
    filled: true,
  };
}

/** Root-mean-square of PCM frames (-1..1) → 0..1 level with a soft knee. */
export function rmsLevel(frames) {
  if (!frames || !frames.length) return 0;
  let sum = 0;
  for (let i = 0; i < frames.length; i++) sum += frames[i] * frames[i];
  const rms = Math.sqrt(sum / frames.length);
  return clamp01(rms * 3.2);
}

/** Recorder metering (dBFS, about -160..0) → 0..1. */
export function dbToLevel(db) {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return clamp01((db + 55) / 45);
}

/** Exponential smoothing that rises fast and falls slower (looks like a VU meter). */
export function smoothLevel(prev, next, rise = 0.55, fall = 0.18) {
  'worklet';
  const k = next > prev ? rise : fall;
  return prev + (next - prev) * k;
}

/**
 * A believable mouth envelope when the platform can't report TTS amplitude:
 * syllable-rate bumps (~4.5 Hz) with some irregularity.
 */
export function syntheticSpeechLevel(t) {
  'worklet';
  const syll = Math.max(0, Math.sin(t * 2 * Math.PI * 4.3));
  const phrase = 0.55 + 0.45 * Math.sin(t * 1.7) * Math.sin(t * 0.6 + 1);
  return clamp01(syll * (0.45 + 0.55 * Math.abs(phrase)));
}


// ── Reactivity (UI-thread worklets + their pure, testable cores) ─────────────

/**
 * One step of an attack/release envelope follower, frame-rate independent:
 * the envelope covers ~63% of the gap to `target` in `attackMs` when rising
 * and in `releaseMs` when falling. 40 / 180 ms reads as "snappy but smooth"
 * for both a mic meter and a mouth.
 */
export function envelopeStep(prev, target, dtMs, attackMs = 40, releaseMs = 180) {
  'worklet';
  const tau = target > prev ? attackMs : releaseMs;
  if (!(dtMs > 0)) return prev;
  const k = 1 - Math.exp(-dtMs / Math.max(1, tau));
  return prev + (target - prev) * k;
}

/**
 * Peak detector for the audio-reactive ripples: true when the envelope is
 * loud, still rising, and the last ripple is at least `refractoryMs` old.
 */
export function isPeak(prevEnv, env, msSinceLastRipple, { min = 0.32, rise = 0.012, refractoryMs = 240 } = {}) {
  'worklet';
  return env >= min && env - prevEnv >= rise && msSinceLastRipple >= refractoryMs;
}

/**
 * Idle "look around": the pupils hold a gaze for a couple of seconds, then
 * glance somewhere else with a quick eased saccade — deterministic in t.
 * Returns { dx, dy } in viewBox units (|dx| ≤ 4.5, |dy| ≤ 2.4).
 */
export function lookAround(t) {
  'worklet';
  const HOLD = 2.6;
  const seg = Math.floor(t / HOLD);
  const target = (n) => {
    // cheap hash → [-1, 1]
    const h = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    const h2 = Math.sin(n * 39.3468 + 11.135) * 24634.6345;
    return [(h - Math.floor(h)) * 2 - 1, (h2 - Math.floor(h2)) * 2 - 1];
  };
  const a = target(seg - 1);
  const b = target(seg);
  const p = Math.min(1, (t - seg * HOLD) / 0.22);
  const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return { dx: (a[0] + (b[0] - a[0]) * e) * 4.5, dy: (a[1] + (b[1] - a[1]) * e) * 2.4 };
}

const VOWEL_GROUP = /[aeiouy]+/g;

/** Rough English syllable count for one word (≥ 1 for any word with letters). */
export function syllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return /\d/.test(String(word)) ? Math.max(1, String(word).replace(/\D/g, '').length) : 0;
  let n = (w.match(VOWEL_GROUP) || []).length;
  if (w.length > 2 && /e$/.test(w) && !/le$/.test(w)) n -= 1; // silent e
  return Math.max(1, n);
}

/**
 * Lip-sync envelope for a TTS clip when the player can't report its own
 * amplitude: a frame-per-`1/fps` mouth-openness track (0..1) built from the
 * text that was synthesised. Each syllable is a quick-rise / slower-fall
 * bump, words get a short gap, commas a pause, sentence ends a longer one —
 * stretched to the clip's real duration so it lines up with playback.
 *
 * @param {string} text
 * @param {{durationSec?: number, fps?: number, leadSec?: number, tailSec?: number}} [opts]
 * @returns {{fps: number, frames: number[], syllables: number}}
 */
export function speechEnvelopeFromText(text, opts = {}) {
  const fps = opts.fps || 50;
  const tokens = String(text || '').match(/[A-Za-z0-9'’]+|[,;:]|[.!?…]+|\n/g) || [];
  // Timeline in "units": 1 per syllable, pauses in between.
  const events = []; // { kind: 'syl', u0, u1, peak } | pause
  let u = 0;
  let total = 0;
  let wi = 0;
  for (const tok of tokens) {
    if (/^[,;:]$/.test(tok)) {
      u += 1.4;
      continue;
    }
    if (/^[.!?…\n]+$/.test(tok)) {
      u += 2.4;
      continue;
    }
    const n = syllables(tok);
    for (let k = 0; k < n; k++) {
      // Stress pattern: first syllable of a word is loudest, a little variety per word.
      const h = Math.sin((wi + 1) * 7.13 + k * 3.7) * 0.5 + 0.5;
      const peak = 0.62 + 0.3 * (k === 0 ? 1 : 0.55) * (0.6 + 0.4 * h);
      events.push({ u0: u, u1: u + 1, peak: Math.min(1, peak) });
      u += 1;
      total += 1;
    }
    u += 0.3; // word gap
    wi += 1;
  }
  const units = Math.max(u, 1);
  // ~4.6 syllables per second when the duration is unknown.
  const lead = opts.leadSec ?? 0.06;
  const tail = opts.tailSec ?? 0.12;
  const durationSec = opts.durationSec > 0 ? opts.durationSec : Math.max(0.4, units / 5.2 + lead + tail);
  const speechSec = Math.max(0.1, durationSec - lead - tail);
  const n = Math.max(1, Math.round(durationSec * fps));
  const frames = new Array(n).fill(0);
  for (const ev of events) {
    const t0 = lead + (ev.u0 / units) * speechSec;
    const t1 = lead + (ev.u1 / units) * speechSec;
    const f0 = Math.floor(t0 * fps);
    const f1 = Math.max(f0 + 1, Math.ceil(t1 * fps));
    for (let f = f0; f <= f1 && f < n; f++) {
      const p = (f / fps - t0) / Math.max(1e-3, t1 - t0); // 0..1 inside the syllable
      if (p < 0 || p > 1) continue;
      // attack in the first 30%, decay after — never fully closes mid-word.
      const shape = p < 0.3 ? p / 0.3 : 1 - ((p - 0.3) / 0.7) * 0.75;
      frames[f] = Math.max(frames[f], ev.peak * shape);
    }
  }
  return { fps, frames: frames.map((v) => Math.round(v * 1000) / 1000), syllables: total };
}

/** Sample a precomputed envelope at playback position `sec` (linear interpolation). */
export function sampleEnvelope(env, sec) {
  if (!env || !env.frames || !env.frames.length || !(sec >= 0)) return 0;
  const x = sec * env.fps;
  const i = Math.floor(x);
  if (i >= env.frames.length - 1) return i === env.frames.length - 1 ? env.frames[i] : 0;
  const a = env.frames[i];
  const b = env.frames[i + 1];
  return a + (b - a) * (x - i);
}

/**
 * Always-closed mouth outline (upper + lower lip). With `open` ≈ 0 the two
 * lips coincide and the stroke reads as a smile line, so the same <Path> can
 * morph continuously from a smile to an open "ah" without swapping shapes.
 */
export function mouthShape({ width = 30, curve = 7, open = 0 } = {}, { cx = 100, cy = 130 } = {}) {
  'worklet';
  const half = width / 2;
  const x0 = r1(cx - half);
  const x1 = r1(cx + half);
  const y = r1(cy - curve * 0.25);
  const o = open < 0 ? 0 : open;
  const upper = r1(y + curve - Math.min(o, 4) * 0.35 * (curve > 0 ? 1 : 0));
  const lower = r1(y + curve + o);
  return `M${x0} ${y} Q${r1(cx)} ${upper} ${x1} ${y} Q${r1(cx)} ${lower} ${x0} ${y} Z`;
}

/**
 * Everything the face draws for one frame, blended across state weights so
 * state changes cross-fade instead of jumping. Runs as a worklet on the UI
 * thread (and in jest as plain JS).
 *
 * @param {{idle:number, listen:number, think:number, speak:number, error:number, connect:number}} w  state weights (0..1, sum ≈ 1)
 * @param {number} t       seconds (frozen at 0 with Reduce Motion)
 * @param {number} env     smoothed audio envelope 0..1
 * @param {number} motion  1 normally, 0 with Reduce Motion
 * @param {number} press   0..1 tactile squish
 * @param {number} perk    0..1 wake-word "perk up"
 */
export function faceFrame(w, t, env, motion = 1, press = 0, perk = 0) {
  'worklet';
  const e = clamp01(env);
  const breathe = Math.sin(t * 1.6) * 0.5 + 0.5;
  const audio = w.listen + w.speak;
  const scale =
    1 +
    0.022 * breathe * motion +
    w.listen * (0.025 + 0.1 * e) +
    w.speak * (0.012 + 0.06 * e) -
    w.error * 0.015 +
    perk * 0.09 -
    press * 0.04;
  const stretch = (w.listen * 0.07 + w.speak * 0.05) * e * motion + perk * 0.05;
  const sy = scale * (1 + stretch - press * 0.07);
  const sx = scale * (1 - stretch * 0.55 + press * 0.06);
  const floatY = motion * (Math.sin(t * 1.1) * 2.2 * (1 - w.error * 0.5)) - perk * 4;
  let wobble = 0.3 + w.listen * (0.2 + 0.7 * e) + w.think * 0.2 + w.speak * (0.1 + 0.45 * e) - w.error * 0.15;
  wobble = Math.min(1.1, Math.max(0, wobble)) * motion;

  const blink = blinkAmount(t) * motion * (1 - perk);
  const eyeH = 1.35 + w.listen * (0.1 + 0.6 * e) + perk * 0.45 - w.speak * 0.12 * e - w.error * 0.12;
  const eyeA = 44 + w.listen * 3.5 * e + perk * 2.5;

  const look = motion ? lookAround(t) : { dx: 0, dy: 0 };
  const spin = t * (w.think > w.connect ? 2.4 : 1.4);
  const idleish = w.idle;
  const pdx = idleish * look.dx + w.listen * look.dx * 0.35 + (w.think + w.connect) * Math.cos(spin) * 4.2 * motion + w.speak * look.dx * 0.4;
  const pdy = idleish * look.dy + w.listen * -2.6 + (w.think + w.connect) * Math.sin(spin) * 3.2 * motion + w.speak * 0.5 + w.error * 3 - perk * 2;

  const mouth = {
    width: 30 * idleish + w.listen * (22 - 6 * e) + (w.think + w.connect) * 18 + w.speak * (28 + 6 * e) + w.error * 22,
    curve: 7 * idleish + 4 * w.listen + (w.think + w.connect) * Math.sin(t * 2.2) * 2 * motion + 8 * w.speak - 6 * w.error,
    open: w.listen * (2 + 9 * e) + w.speak * (0.6 + 18 * e) + perk * 7,
  };

  const glow =
    0.26 + 0.08 * breathe * motion + w.listen * (0.25 + 0.55 * e) + (w.think + w.connect * 0.6) * 0.2 + w.speak * (0.18 + 0.55 * e) - w.error * 0.12 + perk * 0.5;
  const ring = {
    r: 74 * (1.03 + 0.1 * e * audio + perk * 0.06),
    opacity: Math.min(0.8, audio * (0.14 + 0.6 * e) + perk * 0.7),
    width: 1 + 1.8 * e * audio,
  };
  return {
    sx,
    sy,
    floatY,
    wobble,
    blink,
    eyeH,
    eyeA,
    pupil: { dx: pdx, dy: pdy, grow: 1 + w.listen * 0.35 * e + perk * 0.25 },
    mouth,
    glow: Math.min(1, Math.max(0, glow)),
    ring,
    tint: w.error * 0.22,
    brows: w.error,
    swirl: Math.min(1, w.think + w.connect * 0.55),
  };
}

// ── Responsive sizing ────────────────────────────────────────────────────────

/** Orb radius in face units, and the face box's viewBox span (see InfiniFace VB). */
const ORB_R = 74;
const FACE_VB = 160;
const RIPPLE_START = 1.03;
const RIPPLE_MAX = 1.45;

/**
 * How far the audio ripples may grow (multiples of the orb radius beyond
 * RIPPLE_START) so the outermost ripple still fits inside `roomPx` — the
 * distance from the face centre to the nearest screen edge. On a roomy
 * screen this is the full 0.42 swell; on a phone, where the face fills
 * most of the width, the ripples stop just short of the edge instead of
 * being cut off by it.
 */
export function rippleGrowth(roomPx, sizePx) {
  if (!(sizePx > 0) || !(roomPx > 0)) return RIPPLE_MAX - RIPPLE_START;
  const unitPx = sizePx / FACE_VB;
  const maxScale = (roomPx - 3) / (ORB_R * unitPx);
  const s = Math.min(RIPPLE_MAX, Math.max(1.12, maxScale));
  return Math.round((s - RIPPLE_START) * 1000) / 1000;
}

/** Round to a step, so a prop that drifts imperceptibly doesn't re-render the SVG every frame. */
export function quantize(v, step) {
  'worklet';
  return Math.round(v / step) * step;
}

/**
 * Size of the thinking swirl's box (× face size). Its comet arcs sit at
 * radius 98 + stroke in a 208-unit box; at the default 1.3 they reach
 * ~0.61 × the face size from the centre, past the screen edge on a phone —
 * so shrink the box just enough to keep them on screen (never below 1.15,
 * which still clears the orb and its ring).
 */
export function swirlScale(roomPx, sizePx) {
  if (!(sizePx > 0) || !(roomPx > 0)) return 1.3;
  const fit = (((roomPx - 2) * 2) / sizePx) * (104 / 99.2);
  return Math.round(Math.min(1.3, Math.max(1.15, fit)) * 1000) / 1000;
}
