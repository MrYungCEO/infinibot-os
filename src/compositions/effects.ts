/**
 * Clip effects — turn `clip.props.effects[]` into the CSS that the
 * translator emits onto each clip's element. After-Effects-ish
 * vocabulary delivered as a CSS filter chain + (for grain/vignette)
 * an SVG noise overlay.
 *
 * Lives in its own module so the translator stays focused on element
 * emission and the UI's effects panel can import the same vocabulary.
 */
import type { ClipEffect } from "./types.js";

/** Operator-facing label per kind. */
export const EFFECT_LABELS: Record<string, string> = {
  blur: "Blur",
  glow: "Glow",
  brightness: "Brightness",
  contrast: "Contrast",
  saturate: "Saturate",
  hue: "Hue Shift",
  vignette: "Vignette",
  grain: "Grain",
  chromatic: "Chromatic Aberration",
  invert: "Invert",
};

export interface EffectRenderOutput {
  /** CSS to apply to the clip element. Goes through styles channel. */
  cssRule: string;
  /** Optional extra DOM children to inject (grain noise, vignette).
   *  HTML strings — appended inside the clip element after its content. */
  extraHtml: string;
}

/**
 * Lower a clip's effects[] into a single CSS rule + any overlay DOM
 * the effect needs. Disabled / unknown / zero-intensity effects are
 * dropped. Order is preserved.
 */
export function renderClipEffects(
  clipId: string,
  effects: ClipEffect[] | undefined,
): EffectRenderOutput | null {
  if (!effects || effects.length === 0) return null;
  const filters: string[] = [];
  const dropShadows: string[] = [];
  const overlays: string[] = [];

  for (const e of effects) {
    if (e.enabled === false) continue;
    if (!Number.isFinite(e.intensity)) continue;
    const i = Math.max(0, Math.min(1, e.intensity));
    if (i === 0 && e.kind !== "invert") continue;

    switch (e.kind) {
      case "blur":
        filters.push(`blur(${(i * 16).toFixed(1)}px)`);
        break;
      case "glow": {
        const color = (e.params?.color as string) || "#d4a02b";
        const spread = (i * 24).toFixed(1);
        dropShadows.push(`drop-shadow(0 0 ${spread}px ${color})`);
        // A second shadow makes the bloom feel softer.
        dropShadows.push(`drop-shadow(0 0 ${(i * 8).toFixed(1)}px ${color}88)`);
        break;
      }
      case "brightness":
        filters.push(`brightness(${(1 + (i - 0.5) * 1.0).toFixed(2)})`);
        break;
      case "contrast":
        filters.push(`contrast(${(1 + (i - 0.5) * 1.0).toFixed(2)})`);
        break;
      case "saturate":
        filters.push(`saturate(${(1 + (i - 0.5) * 1.6).toFixed(2)})`);
        break;
      case "hue": {
        const deg = Math.round((e.params?.degrees as number) ?? i * 360);
        filters.push(`hue-rotate(${deg}deg)`);
        break;
      }
      case "invert":
        filters.push(`invert(${i.toFixed(2)})`);
        break;
      case "chromatic": {
        // RGB-split via paired drop-shadows.
        const off = (i * 6).toFixed(1);
        dropShadows.push(`drop-shadow(${off}px 0 0 rgba(255,0,60,0.65))`);
        dropShadows.push(`drop-shadow(-${off}px 0 0 rgba(0,200,255,0.65))`);
        break;
      }
      case "vignette": {
        const opacity = (i * 0.7).toFixed(2);
        overlays.push(
          `<div data-fx="vignette" style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,${opacity}) 100%);border-radius:inherit"></div>`,
        );
        break;
      }
      case "grain": {
        const opacity = (i * 0.18).toFixed(2);
        // SVG turbulence noise as a backgroundImage. Self-contained
        // data URL so no extra HTTP fetches per clip.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/></filter><rect width="200" height="200" filter="url(%23n)" opacity="${opacity}"/></svg>`;
        const url = `data:image/svg+xml;utf8,${svg.replace(/#/g, "%23").replace(/"/g, "'")}`;
        overlays.push(
          `<div data-fx="grain" style="position:absolute;inset:0;pointer-events:none;background-image:url(${url});background-size:200px 200px;mix-blend-mode:overlay;border-radius:inherit"></div>`,
        );
        break;
      }
    }
  }

  if (filters.length === 0 && dropShadows.length === 0 && overlays.length === 0) {
    return null;
  }

  const allFilters = [...filters, ...dropShadows];
  const cssRule = allFilters.length > 0 ? `#${clipId}{filter:${allFilters.join(" ")};}` : "";
  return {
    cssRule,
    extraHtml: overlays.join(""),
  };
}
