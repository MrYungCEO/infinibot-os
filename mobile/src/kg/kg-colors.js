/** Tiny colour helpers for the native graph chrome (CSS color-mix equivalents). */

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [212, 175, 55];
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** `rgba()` of a hex colour at alpha `a`. */
export function rgba(hex, a) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** color-mix(in srgb, a `t`, b) → css (optional alpha). */
export function mixHex(a, b, t, alpha = 1) {
  const x = parseHex(a);
  const y = parseHex(b);
  const c = x.map((v, i) => Math.round(v * t + y[i] * (1 - t)));
  return alpha >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
