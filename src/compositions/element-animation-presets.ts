/**
 * Element animation presets — a curated library of entrance + exit + optional
 * continuous "emphasis" loops that drop on top of any visual clip (text,
 * shape, block, image).
 *
 * Inspired by Apple Keynote build animations, After Effects "magic" presets,
 * and the pycaps animation pipeline. The renderer reads these and synthesises
 * matching CSS keyframes — no third-party animation lib needed.
 *
 * Wiring: set `clip.props.animationPresetId = "<preset.id>"` on any clip that
 * extends `ClipBaseProps`. The editor + render pipeline both read this list
 * (server is source of truth; client mirrors).
 */

export type ElementAnimKind =
  | "none"
  | "fade"
  | "slideUp"
  | "slideDown"
  | "slideLeft"
  | "slideRight"
  | "scale"
  | "scaleDown"
  | "blur"
  | "rotate"
  | "skew"
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "typewriter"
  | "glitch";

export type ElementEmphasisKind =
  | "none"
  | "pulse"
  | "wiggle"
  | "float"
  | "shake"
  | "bounce"
  | "shimmer"
  | "spin"
  | "breathe"
  | "kenBurns";

export type ElementEasing =
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "spring"
  | "back";

export interface ElementAnimationPreset {
  id: string;
  name: string;
  description: string;
  /** Which clip kinds this preset is appropriate for. */
  supports: Array<"text" | "shape" | "block" | "image" | "video">;
  in?: { kind: ElementAnimKind; durationSec: number; easing: ElementEasing };
  out?: { kind: ElementAnimKind; durationSec: number; easing: ElementEasing };
  /** Optional continuous animation that loops between in and out. */
  emphasis?: {
    kind: ElementEmphasisKind;
    /** Per-cycle duration. */
    durationSec: number;
    /** 0..1 — magnitude of the effect. */
    intensity?: number;
  };
}

// ── Library ──────────────────────────────────────────────────────────

export const ELEMENT_ANIMATION_PRESETS: ElementAnimationPreset[] = [
  {
    id: "none",
    name: "None",
    description: "No animation. Element appears and disappears instantly.",
    supports: ["text", "shape", "block", "image", "video"],
  },

  // ── Soft / editorial ──────────────────────────────────
  {
    id: "soft-fade",
    name: "Soft Fade",
    description: "Gentle fade in + fade out. Editorial / documentary feel.",
    supports: ["text", "shape", "block", "image", "video"],
    in: { kind: "fade", durationSec: 0.5, easing: "easeOut" },
    out: { kind: "fade", durationSec: 0.5, easing: "easeIn" },
  },
  {
    id: "rise-fade",
    name: "Rise & Fade",
    description: "Slides up while fading in; fades out in place.",
    supports: ["text", "shape", "block", "image"],
    in: { kind: "slideUp", durationSec: 0.6, easing: "easeOut" },
    out: { kind: "fade", durationSec: 0.5, easing: "easeIn" },
  },

  // ── Punchy / kinetic ──────────────────────────────────
  {
    id: "pop-in",
    name: "Pop In",
    description: "Fast scale-up + fade. Snappy CTAs, callouts, pricing.",
    supports: ["text", "shape", "block", "image"],
    in: { kind: "scale", durationSec: 0.32, easing: "back" },
    out: { kind: "fade", durationSec: 0.25, easing: "easeIn" },
  },
  {
    id: "kinetic-title",
    name: "Kinetic Title",
    description: "Scale in + subtle Ken Burns drift while present + fade out.",
    supports: ["text", "block", "image"],
    in: { kind: "scale", durationSec: 0.7, easing: "easeOut" },
    out: { kind: "fade", durationSec: 0.6, easing: "easeIn" },
    emphasis: { kind: "kenBurns", durationSec: 6, intensity: 0.5 },
  },
  {
    id: "bounce-in",
    name: "Bounce In",
    description: "Spring-bounce entrance for high-energy product reveals.",
    supports: ["text", "shape", "block", "image"],
    in: { kind: "scale", durationSec: 0.55, easing: "spring" },
    out: { kind: "scaleDown", durationSec: 0.35, easing: "easeIn" },
    emphasis: { kind: "breathe", durationSec: 3.5, intensity: 0.4 },
  },

  // ── Directional sweeps ────────────────────────────────
  {
    id: "wipe-left",
    name: "Wipe Left",
    description: "Reveals via a left-to-right wipe. Lower-thirds, tickers.",
    supports: ["text", "shape", "block"],
    in: { kind: "wipeLeft", durationSec: 0.5, easing: "easeOut" },
    out: { kind: "fade", durationSec: 0.3, easing: "easeIn" },
  },
  {
    id: "slide-from-right",
    name: "Slide from Right",
    description: "Slides in from the right edge; exits the way it came.",
    supports: ["text", "shape", "block", "image"],
    in: { kind: "slideRight", durationSec: 0.6, easing: "easeOut" },
    out: { kind: "slideLeft", durationSec: 0.5, easing: "easeIn" },
  },

  // ── Looped emphasis (subtle while present) ───────────
  {
    id: "drift-float",
    name: "Drift Float",
    description: "Gentle vertical float — perfect for floating titles / icons.",
    supports: ["text", "shape", "block", "image"],
    in: { kind: "fade", durationSec: 0.6, easing: "easeOut" },
    out: { kind: "fade", durationSec: 0.4, easing: "easeIn" },
    emphasis: { kind: "float", durationSec: 4, intensity: 0.6 },
  },
  {
    id: "pulse-cta",
    name: "Pulse CTA",
    description: "Subtle pulse loop. Call-to-action buttons, urgency cues.",
    supports: ["shape", "block", "text"],
    in: { kind: "scale", durationSec: 0.35, easing: "back" },
    out: { kind: "fade", durationSec: 0.3, easing: "easeIn" },
    emphasis: { kind: "pulse", durationSec: 1.6, intensity: 0.5 },
  },
  {
    id: "shimmer-gold",
    name: "Shimmer",
    description: "Diagonal highlight sweeps across the element on a loop.",
    supports: ["text", "shape", "block", "image"],
    in: { kind: "fade", durationSec: 0.45, easing: "easeOut" },
    out: { kind: "fade", durationSec: 0.4, easing: "easeIn" },
    emphasis: { kind: "shimmer", durationSec: 3, intensity: 0.7 },
  },

  // ── Edgy / cinematic ─────────────────────────────────
  {
    id: "glitch-in",
    name: "Glitch In",
    description: "Glitched RGB-split entrance — cyberpunk / EDM cuts.",
    supports: ["text", "shape", "block"],
    in: { kind: "glitch", durationSec: 0.4, easing: "linear" },
    out: { kind: "blur", durationSec: 0.35, easing: "easeIn" },
    emphasis: { kind: "shake", durationSec: 0.8, intensity: 0.25 },
  },
  {
    id: "typewriter",
    name: "Typewriter",
    description: "Reveals text character by character. Text only.",
    supports: ["text"],
    in: { kind: "typewriter", durationSec: 1.2, easing: "linear" },
    out: { kind: "fade", durationSec: 0.4, easing: "easeIn" },
  },
  {
    id: "blur-reveal",
    name: "Blur Reveal",
    description: "De-focuses from heavy blur. Premium product shots.",
    supports: ["text", "shape", "block", "image"],
    in: { kind: "blur", durationSec: 0.7, easing: "easeOut" },
    out: { kind: "blur", durationSec: 0.6, easing: "easeIn" },
  },
  {
    id: "spin-wobble",
    name: "Spin Wobble",
    description: "Quick wobble-spin entrance + slow continuous spin.",
    supports: ["shape", "block", "image"],
    in: { kind: "rotate", durationSec: 0.6, easing: "back" },
    out: { kind: "fade", durationSec: 0.4, easing: "easeIn" },
    emphasis: { kind: "spin", durationSec: 12, intensity: 0.3 },
  },
];

export function findElementAnimationPreset(
  id: string | undefined,
): ElementAnimationPreset {
  if (!id) return ELEMENT_ANIMATION_PRESETS[0]!;
  return ELEMENT_ANIMATION_PRESETS.find((p) => p.id === id) ?? ELEMENT_ANIMATION_PRESETS[0]!;
}
