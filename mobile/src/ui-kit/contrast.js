/**
 * ui-kit/contrast — WCAG contrast math.
 *
 * Why this exists: chips and pills paint a label in tone colour X on a wash of
 * tone colour X. That wash raises the background luminance, so a tone that
 * clears 4.5:1 against the raw obsidian background can land at ~3.9:1 inside
 * its own chip (measured: `error` and `info` both do). Hand-picking lighter
 * hexes would fix it for the two built-in palettes and silently break for
 * every master-chosen palette, so the kit computes it instead.
 *
 * `ensureContrast` mixes the foreground toward white (dark themes) or black
 * (light themes) in small steps until it clears the threshold, then stops. On
 * a colour that already passes it returns the input unchanged, so the common
 * path costs one luminance calculation.
 */

const CACHE = new Map();

function parseColor(color) {
  if (!color || typeof color !== 'string') return null;
  if (color === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (color[0] === '#') {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = parseInt(hex.slice(0, 6), 16);
    if (Number.isNaN(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const p = m[1].split(',').map((s) => parseFloat(s.trim()));
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
  return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
}

/** Composite a (possibly translucent) colour over an opaque backdrop. */
export function composite(fg, bg) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return b || { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
    a: 1,
  };
}

export function luminance(c) {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

/** WCAG 2.1 contrast ratio between two opaque colours. */
export function contrastRatio(a, b) {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) return 21;
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toRgbString(c) {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}

/**
 * Return `color`, lightened (or darkened on light backdrops) just far enough
 * to reach `min` contrast against `backdrop`. Returns the input untouched when
 * it already passes.
 *
 *   ensureContrast(colors.error, chipBackground)      // 4.5:1, body text
 *   ensureContrast(colors.info, chipBackground, 3)    // 3:1, non-text glyph
 */
export function ensureContrast(color, backdrop, min = 4.5) {
  if (!color || !backdrop) return color;
  const bg = typeof backdrop === 'string' ? parseColor(backdrop) : backdrop;
  const fg = parseColor(color);
  if (!bg || !fg) return color;

  // Cache on the RESOLVED channel values. Keying on the raw arguments would
  // stringify an object backdrop to "[object Object]" and collapse every
  // distinct backdrop onto one cache entry.
  const key = `${fg.r},${fg.g},${fg.b},${fg.a}|${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)},${bg.a ?? 1}|${min}`;
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;

  const solidBg = bg.a === 1 ? bg : composite(bg, { r: 0, g: 0, b: 0, a: 1 });
  const solidFg = composite(fg, solidBg);

  if (contrastRatio(solidFg, solidBg) >= min) {
    CACHE.set(key, color);
    return color;
  }

  // Mix toward whichever pole is further from the backdrop.
  const target = luminance(solidBg) < 0.5 ? 255 : 0;
  let best = toRgbString(solidFg);
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24;
    // Round BEFORE measuring. The returned value is a rounded rgb() string, so
    // testing the unrounded mix can report a pass the emitted colour misses by
    // a hair (observed at exactly 4.50:1 on forest/danger).
    const mixed = {
      r: Math.round(solidFg.r + (target - solidFg.r) * t),
      g: Math.round(solidFg.g + (target - solidFg.g) * t),
      b: Math.round(solidFg.b + (target - solidFg.b) * t),
      a: 1,
    };
    best = toRgbString(mixed);
    if (contrastRatio(mixed, solidBg) >= min) break;
  }
  CACHE.set(key, best);
  return best;
}


/**
 * The worst-case (lightest) backdrop a kit surface sits on.
 *
 * A Card's glass gradient runs tint@0.10 → tint@0.02 → black@0.35, so the
 * TOP of a card is the lightest point and therefore the hardest place to
 * stay legible. Chips can also sit directly on the app background, which is
 * darker still. Model the worst case: app background + primary tint @ 10%.
 *
 * Everything that paints a tone-coloured label on a tone-coloured wash should
 * measure against `washBackdrop(colors, tone, alpha)` rather than the raw
 * background, or it will over-estimate its own contrast.
 */
export function surfaceBackdrop(colors) {
  return composite(
    { ...(parseColor(colors?.primary) || { r: 255, g: 255, b: 255 }), a: 0.1 },
    parseColor(colors?.background) || { r: 10, g: 10, b: 14, a: 1 },
  );
}

/**
 * `surfaceBackdrop` with a tone wash of `alpha` composited on top.
 *
 * `alpha` REPLACES the tone's own alpha, matching `withAlpha` in
 * theme/color-utils — which is what the components actually paint. Multiplying
 * instead would model a wash lighter than the real one and let a failing pair
 * through.
 */
export function washBackdrop(colors, tone, alpha) {
  const t = parseColor(tone);
  const base = surfaceBackdrop(colors);
  if (!t) return base;
  return composite({ ...t, a: alpha }, base);
}

/**
 * `surfaceBackdrop` with a NEUTRAL (foreground-coloured) fill of `alpha` on
 * top. This is the backdrop every Chip/Badge actually paints its label on, and
 * it is the same for every tone — which is the whole point: one predictable
 * contrast target instead of one that moves with the tone's lightness.
 */
export function neutralBackdrop(colors, alpha) {
  const fg = parseColor(colors?.text || colors?.foreground || '#ffffff');
  const base = surfaceBackdrop(colors);
  if (!fg) return base;
  return composite({ ...fg, a: alpha }, base);
}

/**
 * Pick the most legible label colour for a fill that spans several colours
 * (a gradient button, a multi-stop pill).
 *
 * A single ensureContrast against one stop is not enough: lifting a label to
 * clear the DARKEST stop can push it past the LIGHTEST one, and vice versa
 * (aurora's purple gradient does exactly this). So evaluate each candidate
 * against every stop and keep the one with the best worst-case, preferring
 * `preferred` when it already clears `min` everywhere.
 */
export function bestLabelOn(stops, { min = 4.5, preferred } = {}) {
  const list = (Array.isArray(stops) ? stops : [stops]).map(parseColor).filter(Boolean);
  if (!list.length) return preferred || '#ffffff';

  const worstAgainst = (candidate) => {
    const c = parseColor(candidate);
    if (!c) return 0;
    return list.reduce((lo, stop) => {
      const solid = stop.a === 1 ? stop : composite(stop, { r: 0, g: 0, b: 0, a: 1 });
      return Math.min(lo, contrastRatio(composite(c, solid), solid));
    }, Infinity);
  };

  if (preferred && worstAgainst(preferred) >= min) return preferred;

  const candidates = [preferred, '#ffffff', '#000000'].filter(Boolean);
  let best = candidates[0];
  let bestRatio = -1;
  for (const cand of candidates) {
    const r = worstAgainst(cand);
    if (r > bestRatio) {
      bestRatio = r;
      best = cand;
    }
  }
  return best;
}

/**
 * Adjust a fill so a chosen label clears `min` on it.
 *
 * Used by the primary Button. When no label colour can clear the threshold on
 * the brand gradient (aurora's mid-purple tops out at 4.23:1 against pure
 * white), the fix is the fill, not the label: deepen the stops away from the
 * label's pole until they clear. The hue is preserved — only luminance moves —
 * so the button still reads as the brand colour.
 *
 * Returns the stops unchanged when they already pass, which is the gold case.
 */
export function ensureFillOn(stops, label, min = 4.5) {
  const list = Array.isArray(stops) ? stops : [stops];
  const lab = parseColor(label);
  if (!lab) return list;
  const labelIsLight = luminance(lab) > 0.5;
  const target = labelIsLight ? 0 : 255; // push the fill away from the label

  return list.map((stop) => {
    const c = parseColor(stop);
    if (!c) return stop;
    const solid = c.a === 1 ? c : composite(c, { r: 0, g: 0, b: 0, a: 1 });
    if (contrastRatio(composite(lab, solid), solid) >= min) return stop;

    let out = toRgbString(solid);
    for (let step = 1; step <= 24; step += 1) {
      const t = step / 24;
      const mixed = {
        r: Math.round(solid.r + (target - solid.r) * t),
        g: Math.round(solid.g + (target - solid.g) * t),
        b: Math.round(solid.b + (target - solid.b) * t),
        a: 1,
      };
      out = toRgbString(mixed);
      if (contrastRatio(composite(lab, mixed), mixed) >= min) break;
    }
    return out;
  });
}

export default ensureContrast;
