/**
 * Caption presets — the visual + animation style library for the
 * `"captions"` ClipKind. Inspired by pycaps's animation patterns and the
 * viral caption styles of OpusClip / CapCut / Hormozi cuts.
 *
 * Each preset is a self-contained spec the editor renderer (DOM) and the
 * server render template (Playwright DOM) both read. We keep both runtimes
 * in lockstep by reading from the same source — this file ships server-side
 * and is mirrored into the UI bundle.
 *
 * Preset shape highlights:
 *   - `font` — family / size / weight / stretch / shadow / stroke
 *   - `palette` — base text color + active-word highlight color + bg
 *   - `box` — optional pill / box behind the text
 *   - `wordAnim` — how each word animates in: "pop" | "fade" | "slideUp" |
 *      "scale" | "bounce" | "glitch"
 *   - `emphasisAnim` — a stronger animation reserved for cues whose words
 *      have `emphasis: true` (Hormozi-style keyword pop)
 *   - `layout` — where the caption block sits on the canvas
 */

export type CaptionWordAnim =
  | "none"
  | "pop"
  | "fade"
  | "slideUp"
  | "scale"
  | "bounce"
  | "glitch"
  | "neon";

export interface CaptionPreset {
  id: string;
  name: string;
  description: string;
  font: {
    family: string;
    size: number;       // px at 1080p reference; renderer scales for other resolutions
    weight: number;
    /** CSS letter-spacing in em. */
    letterSpacing?: number;
    /** Drop-shadow stack — comma-separated CSS shadow declarations. */
    shadow?: string;
    /** -webkit-text-stroke shorthand (e.g. "2px #000"). */
    stroke?: string;
    /** "uppercase" | "lowercase" | "none". */
    transform?: "uppercase" | "lowercase" | "none";
  };
  palette: {
    /** Default word color. */
    text: string;
    /** Highlight color for the active (current-time) word. */
    active: string;
    /** Background pill / box fill. Use "transparent" for none. */
    box?: string;
    /** Border around the box. */
    border?: string;
  };
  box: {
    /** Inset padding in px around the active line. */
    padX: number;
    padY: number;
    /** Corner radius in px. */
    radius: number;
    /** "perWord" puts the highlight box around the active word only;
     *  "perLine" puts it around the whole line; "none" is no box. */
    style: "none" | "perLine" | "perWord";
  };
  /** Each word animates in with this kind. */
  wordAnim: CaptionWordAnim;
  /** Reserved animation for words flagged `emphasis: true`. Falls back to wordAnim. */
  emphasisAnim?: CaptionWordAnim;
  /** Word-in animation duration (seconds). */
  wordAnimSec?: number;
  /** Stagger between successive words in a line (seconds). */
  wordStaggerSec?: number;
  layout: {
    /** % of canvas where the caption block anchors (top-left of the box). */
    x: number;
    y: number;
    width: number;
    /** Multi-line max-height as % of canvas. */
    height: number;
    /** "left" | "center" | "right" — text alignment within the box. */
    align: "left" | "center" | "right";
    /** Default max words per line (keeps lines tight on vertical canvases). */
    maxWordsPerLine: number;
  };
}

// ── Preset library ─────────────────────────────────────────────────

export const CAPTION_PRESETS: CaptionPreset[] = [
  // ── 1. TikTok highlight — chunky bold uppercase, single-word reveal,
  //      gold pop on the active word, black pill behind each word.
  {
    id: "tiktok-highlight",
    name: "TikTok Highlight",
    description: "Bold uppercase one-word-at-a-time with a gold pop on each beat.",
    font: {
      family: "Inter, system-ui, sans-serif",
      size: 84,
      weight: 900,
      letterSpacing: 0.02,
      stroke: "3px #000",
      transform: "uppercase",
      shadow: "0 4px 18px rgba(0,0,0,0.55)",
    },
    palette: { text: "#ffffff", active: "#ffd54a", box: "rgba(0,0,0,0.78)", border: "rgba(255,213,74,0.42)" },
    box: { padX: 18, padY: 10, radius: 16, style: "perWord" },
    wordAnim: "pop",
    emphasisAnim: "bounce",
    wordAnimSec: 0.18,
    wordStaggerSec: 0.0,
    layout: { x: 8, y: 70, width: 84, height: 18, align: "center", maxWordsPerLine: 4 },
  },

  // ── 2. Hormozi keyword pop — every emphasis word jumps + scales,
  //      neutral words stay calm. Lots of spacing around the line.
  {
    id: "hormozi-keywords",
    name: "Hormozi Keywords",
    description: "Calm white text with massive keyword pops. Reads like a closer.",
    font: {
      family: "Inter, system-ui, sans-serif",
      size: 76,
      weight: 800,
      stroke: "2px #000",
      transform: "uppercase",
      shadow: "0 6px 24px rgba(0,0,0,0.55)",
    },
    palette: { text: "#ffffff", active: "#22d3ee", box: "transparent" },
    box: { padX: 0, padY: 0, radius: 0, style: "none" },
    wordAnim: "fade",
    emphasisAnim: "bounce",
    wordAnimSec: 0.15,
    wordStaggerSec: 0.04,
    layout: { x: 6, y: 64, width: 88, height: 24, align: "center", maxWordsPerLine: 5 },
  },

  // ── 3. Broadcast lower-third — classic sub-headline strip, no animation.
  {
    id: "broadcast-classic",
    name: "Broadcast Classic",
    description: "Single line, lower-third bar, fade in/out. Familiar and clean.",
    font: {
      family: "Inter, system-ui, sans-serif",
      size: 38,
      weight: 600,
      letterSpacing: 0.02,
      shadow: "0 2px 6px rgba(0,0,0,0.45)",
    },
    palette: { text: "#f5f5f4", active: "#f5f5f4", box: "rgba(8, 8, 18, 0.78)", border: "rgba(212,175,55,0.45)" },
    box: { padX: 18, padY: 10, radius: 10, style: "perLine" },
    wordAnim: "fade",
    wordAnimSec: 0.25,
    wordStaggerSec: 0,
    layout: { x: 5, y: 82, width: 90, height: 12, align: "center", maxWordsPerLine: 12 },
  },

  // ── 4. Kinetic bounce — every word bounces in with a spring easing.
  //      Punchy, lots of energy.
  {
    id: "kinetic-bounce",
    name: "Kinetic Bounce",
    description: "Each word springs in with a bounce — high energy, music-video feel.",
    font: {
      family: "Inter, system-ui, sans-serif",
      size: 72,
      weight: 800,
      transform: "uppercase",
      stroke: "2px #000",
      shadow: "0 6px 18px rgba(0,0,0,0.5)",
    },
    palette: { text: "#fef3c7", active: "#f59e0b", box: "transparent" },
    box: { padX: 0, padY: 0, radius: 0, style: "none" },
    wordAnim: "bounce",
    emphasisAnim: "scale",
    wordAnimSec: 0.32,
    wordStaggerSec: 0.06,
    layout: { x: 8, y: 62, width: 84, height: 26, align: "center", maxWordsPerLine: 4 },
  },

  // ── 5. Fade Classic — minimal phrase fade, timeless and editorial.
  {
    id: "fade-classic",
    name: "Fade Classic",
    description: "Whole-phrase fade — quiet, editorial, premium documentary.",
    font: {
      family: "Inter, system-ui, sans-serif",
      size: 44,
      weight: 500,
      letterSpacing: 0.01,
      shadow: "0 1px 4px rgba(0,0,0,0.6)",
    },
    palette: { text: "#fafafa", active: "#fafafa", box: "transparent" },
    box: { padX: 0, padY: 0, radius: 0, style: "none" },
    wordAnim: "fade",
    wordAnimSec: 0.45,
    wordStaggerSec: 0,
    layout: { x: 10, y: 80, width: 80, height: 12, align: "center", maxWordsPerLine: 14 },
  },

  // ── 6. Glitch — RGB-channel split + jitter, edgy / cyberpunk.
  {
    id: "glitch",
    name: "Glitch",
    description: "RGB-split jitter on each word — cyberpunk / edm.",
    font: {
      family: "JetBrains Mono, Consolas, monospace",
      size: 64,
      weight: 800,
      letterSpacing: 0.04,
      transform: "uppercase",
      shadow: "2px 0 0 #ef4444, -2px 0 0 #22d3ee, 0 0 18px rgba(0,255,255,0.45)",
    },
    palette: { text: "#f5f5f4", active: "#22d3ee", box: "transparent" },
    box: { padX: 0, padY: 0, radius: 0, style: "none" },
    wordAnim: "glitch",
    wordAnimSec: 0.18,
    wordStaggerSec: 0.04,
    layout: { x: 8, y: 70, width: 84, height: 20, align: "center", maxWordsPerLine: 5 },
  },

  // ── 7. Gradient stroke — each word strokes in with a primary gradient,
  //      premium product / SaaS announcement vibe.
  {
    id: "gradient-stroke",
    name: "Gradient Stroke",
    description: "Premium product reveal — gradient outline strokes across each word.",
    font: {
      family: "Inter, system-ui, sans-serif",
      size: 72,
      weight: 900,
      transform: "uppercase",
      letterSpacing: 0.04,
      shadow: "0 4px 24px rgba(212,175,55,0.45)",
    },
    palette: { text: "#fde68a", active: "#d4af37", box: "transparent" },
    box: { padX: 0, padY: 0, radius: 0, style: "none" },
    wordAnim: "scale",
    wordAnimSec: 0.28,
    wordStaggerSec: 0.05,
    layout: { x: 6, y: 66, width: 88, height: 22, align: "center", maxWordsPerLine: 4 },
  },

  // ── 8. Neon Pop — saturated neon glow, party / club / nightlife.
  {
    id: "neon-pop",
    name: "Neon Pop",
    description: "Hot pink + cyan neon glow on every word. Built for nightclub edits.",
    font: {
      family: "Inter, system-ui, sans-serif",
      size: 78,
      weight: 900,
      transform: "uppercase",
      shadow: "0 0 12px #f472b6, 0 0 28px #22d3ee, 0 4px 20px rgba(0,0,0,0.6)",
    },
    palette: { text: "#fdf4ff", active: "#f472b6", box: "rgba(0,0,0,0.55)", border: "rgba(244,114,182,0.55)" },
    box: { padX: 16, padY: 8, radius: 14, style: "perLine" },
    wordAnim: "neon",
    emphasisAnim: "pop",
    wordAnimSec: 0.22,
    wordStaggerSec: 0.04,
    layout: { x: 6, y: 70, width: 88, height: 20, align: "center", maxWordsPerLine: 5 },
  },
];

export function findCaptionPreset(id: string | undefined): CaptionPreset {
  if (!id) return CAPTION_PRESETS[0]!;
  return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0]!;
}
