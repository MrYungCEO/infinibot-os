/**
 * World palette for the 3D Agent Mesh — derived from the user's appearance
 * theme, never per-room rainbow colours.
 *
 * One primary accent (the theme's --g-primary; gold on the default dark
 * theme) drives every trim, light strip, glow and the "working" status; one
 * subtle secondary tint (a heavily desaturated --g-accent) is the only other
 * hue. Rooms differ by form, props and lighting — not colour. Error red is
 * the single semantic exception.
 *
 * Pure (no DOM): the host reads the CSS tokens and passes them in
 * (`worldThemeFrom`), the mobile app passes its own. The scene rebuilds
 * materials / static geometry when the palette signature changes.
 */
import type { AgentVisualState } from "../../views/agent-ops/mesh-world-model";

export type ThemeMode = "dark" | "light" | "hud";

export interface ThemeTokens {
  mode?: string | null;
  /** Primary accent, any CSS hex / rgb() string or a 0xRRGGBB number. */
  primary?: string | number | null;
  /** Secondary accent (only a whisper of it is used). */
  secondary?: string | number | null;
}

export interface WorldTheme {
  mode: ThemeMode;
  /** Signature: changes ⇔ the palette changed. */
  sig: string;
  accent: number;
  accentHi: number;
  accentDeep: number;
  /** Subtle secondary tint (desaturated). */
  tint: number;
  /** Backdrop + fog. */
  skyTop: number;
  skyBottom: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  /** Outer ground plane. */
  ground: number;
  groundLine: number;
  /** Architecture roles (vertex colours; the materials add the finish). */
  floor: number;
  floorInlay: number;
  body: number;
  bodyHi: number;
  metal: number;
  metalHi: number;
  glass: number;
  ink: number;
  /** Avatar roles. */
  avatarBody: number;
  avatarLimb: number;
  avatarShell: number;
  /** Status colours (restrained: accent, tint, ivory, graphite + error red). */
  state: Record<AgentVisualState, number>;
  /** Lights. */
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  key: number;
  keyColor: number;
  fill: number;
  exposure: number;
  /** Bloom strength / threshold. */
  bloom: number;
  bloomThreshold: number;
  /** Floor / glass reflection strength (env map intensity). */
  reflect: number;
  /** Overlay UI ink for labels drawn in-GL. */
  labelBg: string;
  labelInk: string;
  labelSub: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Parse "#rgb", "#rrggbb", "rgb(…)", "rgba(…)", "color(srgb r g b)" or a number → 0xRRGGBB (null when unknown). */
export function parseColor(v: string | number | null | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v & 0xffffff;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return parseInt(m[1].split("").map((c) => c + c).join(""), 16);
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return parseInt(m[1], 16);
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return (Math.round(+m[1]) << 16) | (Math.round(+m[2]) << 8) | Math.round(+m[3]);
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (m) return (Math.round(clamp01(+m[1]) * 255) << 16) | (Math.round(clamp01(+m[2]) * 255) << 8) | Math.round(clamp01(+m[3]) * 255);
  return null;
}

function toHsl(hex: number): [number, number, number] {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

export function mix(a: number, b: number, t: number): number {
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export const hexCss = (n: number) => "#" + (n & 0xffffff).toString(16).padStart(6, "0");

export const DEFAULT_ACCENT = 0xd4af37;
const ERROR = 0xe5484d;

/** Build the world palette from theme tokens. Unknown / missing tokens fall back to black + gold. */
export function worldThemeFrom(tokens: ThemeTokens = {}): WorldTheme {
  const mode: ThemeMode = tokens.mode === "light" ? "light" : tokens.mode === "hud" ? "hud" : "dark";
  let accent = parseColor(tokens.primary ?? null) ?? DEFAULT_ACCENT;
  const [ah, as, al] = toHsl(accent);
  // Keep the accent luxurious: never neon-saturated, never too dark to glow.
  accent = fromHsl(ah, Math.min(as, 0.78), mode === "light" ? Math.min(Math.max(al, 0.36), 0.5) : Math.min(Math.max(al, 0.5), 0.66));
  const [, , al2] = toHsl(accent);
  const accentHi = fromHsl(ah, Math.min(as, 0.85), Math.min(0.82, al2 + 0.2));
  const accentDeep = fromHsl(ah, Math.min(as, 0.7), Math.max(0.16, al2 - 0.26));
  const sec = parseColor(tokens.secondary ?? null);
  const [sh, ss] = sec != null ? toHsl(sec) : [(ah + 0.55) % 1, 0.2];
  // The single secondary tint: a whisper of the theme's second colour.
  const tint = fromHsl(sh, Math.min(0.22, ss * 0.3), mode === "light" ? 0.45 : 0.74);

  if (mode === "light") {
    // Gallery daylight: warm porcelain + graphite architecture, accent trims.
    return finish({
      mode,
      accent,
      accentHi,
      accentDeep,
      tint,
      skyTop: 0xf1efea,
      skyBottom: 0xdcd8cf,
      fog: 0xe7e3db,
      fogNear: 140,
      fogFar: 380,
      ground: 0xd9d5cc,
      groundLine: mix(0x9c9585, accent, 0.3),
      floor: 0xd2cdc3,
      floorInlay: mix(0xb3ac9e, accent, 0.25),
      body: 0xe4e0d8,
      bodyHi: 0xf2efe9,
      metal: 0x5c5a57,
      metalHi: 0x8e8778,
      glass: mix(0xc9d0d8, accent, 0.06),
      ink: 0x2a2824,
      avatarBody: 0x2e2d31,
      avatarLimb: 0x4a484e,
      avatarShell: 0xf3f0ea,
      state: { working: accent, waiting: tint, error: ERROR, done: 0x5f7c6c, idle: 0x8f8a80 },
      hemiSky: 0xffffff,
      hemiGround: 0xb9b2a4,
      hemi: 0.95,
      key: 1.9,
      keyColor: 0xfff3df,
      fill: 0.45,
      exposure: 0.88,
      bloom: 0.12,
      bloomThreshold: 0.97,
      reflect: 0.45,
      labelBg: "rgba(250,249,246,0.94)",
      labelInk: "#1e1d1a",
      labelSub: "rgba(40,38,34,0.75)",
    });
  }
  const hud = mode === "hud";
  return finish({
    mode,
    accent,
    accentHi,
    accentDeep,
    tint,
    skyTop: mix(hud ? 0x07060a : 0x0d0c12, accent, 0.035),
    skyBottom: hud ? 0x000000 : 0x020203,
    fog: hud ? 0x030305 : 0x050508,
    fogNear: 60,
    fogFar: hud ? 190 : 215,
    ground: hud ? 0x020203 : 0x040406,
    groundLine: accent,
    floor: hud ? 0x0b0b0e : 0x111116,
    floorInlay: mix(0x111114, accent, 0.12),
    body: hud ? 0x131317 : 0x18181d,
    bodyHi: 0x26262d,
    metal: 0x45433f,
    metalHi: 0x7a705c,
    glass: mix(0x1a1c22, accent, 0.08),
    ink: 0x050507,
    avatarBody: 0x16161b,
    avatarLimb: 0x24242b,
    avatarShell: mix(0xa9a397, accent, 0.14),
    state: { working: accent, waiting: tint, error: ERROR, done: 0xe8e2d2, idle: 0x5d5b62 },
    hemiSky: 0xc8cad6,
    hemiGround: 0x0c0a07,
    hemi: hud ? 0.85 : 1.05,
    key: hud ? 2.0 : 2.4,
    keyColor: mix(0xfff1d6, accent, 0.12),
    fill: 0.7,
    exposure: hud ? 1.12 : 1.1,
    bloom: hud ? 0.7 : 0.55,
    bloomThreshold: hud ? 0.62 : 0.7,
    reflect: hud ? 1.15 : 1.0,
    labelBg: "rgba(8,8,11,0.9)",
    labelInk: "#f6f1e4",
    labelSub: "rgba(236,231,218,0.82)",
  });
}

function finish(t: Omit<WorldTheme, "sig">): WorldTheme {
  return { ...t, sig: `${t.mode}:${t.accent.toString(16)}:${t.tint.toString(16)}` };
}

/** Distinct hues in a palette's architecture + status roles (tests: "far fewer colours"). */
export function paletteHues(t: WorldTheme): number {
  const hues = new Set<number>();
  for (const c of [t.accent, t.tint, t.floor, t.body, t.metal, t.glass, ...Object.values(t.state)]) {
    const [h, s] = toHsl(c);
    if (s < 0.12) continue; // greys / near-neutrals don't count
    hues.add(Math.round(h * 12) % 12);
  }
  return hues.size;
}
