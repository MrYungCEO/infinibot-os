/**
 * backdrop-math — pure helpers for <InfiniBackdrop> (no React, no RN).
 *
 *   dustField   deterministic star / dust specks for a box (same seed → same
 *               field, so the static SVG is drawn once and never changes)
 *   moodLight   the colour + strength of the light pool under the face for
 *               each face state (listening green-cyan, thinking violet-blue,
 *               speaking warm gold, error red, idle soft gold)
 */

/** Small fast seeded PRNG (mulberry32). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` specks spread over a `width` × `height` box. Each speck:
 * { x, y, r, o } — position, radius (px), opacity. Bright specks are rare.
 * Specks avoid a soft hole around (cx, cy) of radius `hole` so the face
 * stays clean, and skip the `avoid` rects ({left, top, width, height}) so
 * no speck reads as a stray dot in the status text.
 */
export function dustField({ seed = 7, count = 40, width, height, rMin = 0.6, rMax = 1.6, cx = null, cy = null, hole = 0, avoid = [] }) {
  const rnd = seeded(seed);
  const out = [];
  let guard = count * 6;
  while (out.length < count && guard-- > 0) {
    const x = rnd() * width;
    const y = rnd() * height;
    if (hole > 0 && cx != null && Math.hypot(x - cx, y - cy) < hole * (0.75 + 0.25 * rnd())) continue;
    if (avoid.some((a) => x >= a.left - 8 && x <= a.left + a.width + 8 && y >= a.top - 8 && y <= a.top + a.height + 8)) continue;
    const bright = rnd() < 0.12;
    const r = bright ? rMax * (0.9 + 0.5 * rnd()) : rMin + (rMax - rMin) * rnd() * 0.6;
    const o = bright ? 0.75 + 0.25 * rnd() : 0.18 + 0.4 * rnd();
    out.push({ x: +x.toFixed(1), y: +y.toFixed(1), r: +r.toFixed(2), o: +o.toFixed(2) });
  }
  return out;
}

const MOOD = {
  idle: { warm: 0.55, cool: 0, tint: '#5fe3c4' },
  connecting: { warm: 0.35, cool: 0.45, tint: '#8a93ff' },
  listening: { warm: 0.15, cool: 0.95, tint: '#4fe0b6' },
  thinking: { warm: 0.1, cool: 0.9, tint: '#8a93ff' },
  speaking: { warm: 1, cool: 0, tint: '#5fe3c4' },
  error: { warm: 0, cool: 0.8, tint: '#e5675c' },
};

/** Light-pool mix for a face state: warm (gold) / cool (tinted) opacities and the cool tint. */
export function moodLight(mood) {
  return MOOD[mood] || MOOD.idle;
}
