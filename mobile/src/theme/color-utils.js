// Shared alpha-stamping helper. Accepts a hex (`#abc` / `#aabbcc`), an
// `rgb(...)` / `rgba(...)` string, or `transparent` and returns an `rgba`
// string with the requested alpha. Used by glass surfaces and gradient
// overlays so every tint flows off the live theme primary instead of a
// hard-coded hex.

export function withAlpha(color, alpha) {
  if (!color || color === 'transparent') return `rgba(0,0,0,${alpha})`;
  if (typeof color !== 'string') return `rgba(255,255,255,${alpha})`;
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return `rgba(255,255,255,${alpha})`;
    const num = parseInt(hex.slice(0, 6), 16);
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((p) => p.trim());
    const [r, g, b] = parts;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

// Build the canonical "glass gradient" stack for a given tint colour. Used
// by GlassCard / GlassSurface / SleekHeader so every glass slab looks the
// same: a soft theme-tinted top, a near-transparent middle, and a dimmed
// black floor that lets the AmbientBackground bleed through.
export function glassGradient(tintHex, { top = 0.10, mid = 0.02, floor = 0.35 } = {}) {
  return [
    withAlpha(tintHex, top),
    withAlpha(tintHex, mid),
    `rgba(0,0,0,${floor})`,
  ];
}

// Horizontal header gradient — primary → primary-dim → black floor.
export function headerGradient(tintHex, { start = 0.22, mid = 0.06, floor = 0.4 } = {}) {
  return [
    withAlpha(tintHex, start),
    withAlpha(tintHex, mid),
    `rgba(0,0,0,${floor})`,
  ];
}

// Inner-top highlight gradient (the "lift" effect).
export const innerTopHighlight = ['rgba(255,255,255,0.07)', 'rgba(255,255,255,0.00)'];

export default withAlpha;
