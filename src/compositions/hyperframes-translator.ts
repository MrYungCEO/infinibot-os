/**
 * Composition → hyperframes translator.
 *
 * Converts InfiniBot's typed JSON timeline (Composition / Track / Clip)
 * into the data hyperframes' `generateHyperframesHtml` consumes:
 * `(TimelineElement[], totalDuration, SerializeOptions)`.
 *
 * The renderer (src/compositions/render.ts) uses this to hand off to
 * `@hyperframes/producer` or `@hyperframes/engine` for the actual frame
 * capture + MP4 encode. UI timeline JSON model is the source of truth;
 * the translator is one-way.
 */

import {
  CANVAS_DIMENSIONS,
  fitTextFontSize,
  generateHyperframesHtml,
  type CanvasResolution,
  type GsapAnimation,
  type Keyframe,
  type SerializeOptions,
  type StageZoomKeyframe,
  type TimelineCompositionElement,
  type TimelineElement,
  type TimelineMediaElement,
  type TimelineTextElement,
} from "@hyperframes/core";

import { findElementAnimationPreset } from "./element-animation-presets.js";
import { applyPreset, applyTransitionSide } from "./motion-presets.js";
import { resolveVariables, resolveProps } from "./variables.js";
import { readTransitions } from "./transitions.js";
import { renderClipEffects } from "./effects.js";
import type { ClipEffect } from "./types.js";

import type {
  AudioClipProps,
  BlockClipProps,
  CaptionsClipProps,
  Clip,
  CompositionWithChildren,
  EasingName,
  ImageClipProps,
  ShapeClipProps,
  SubCompClipProps,
  TextClipProps,
  VideoClipProps,
} from "./types.js";
import type { BlockDefinition } from "./blocks/types.js";

export interface TranslateResult {
  elements: TimelineElement[];
  totalDuration: number;
  options: SerializeOptions;
  /** Resolved CSS background color from the composition. */
  bgColor: string;
  /** Pixel dimensions of the composition (passed through from input). */
  widthPx: number;
  heightPx: number;
  fps: number;
}

/**
 * Map an arbitrary widthPx/heightPx to the closest hyperframes
 * `CanvasResolution` key. Hyperframes itself only defines the six fixed
 * presets (landscape / portrait / square at 1080 and 4K), so anything
 * non-standard snaps to the closest aspect-ratio bucket.
 */
function pickResolution(widthPx: number, heightPx: number): CanvasResolution {
  const exact = (
    Object.entries(CANVAS_DIMENSIONS) as Array<
      [CanvasResolution, { width: number; height: number }]
    >
  ).find(([, dims]) => dims.width === widthPx && dims.height === heightPx);
  if (exact) return exact[0];

  const ratio = widthPx / heightPx;
  const is4k = Math.max(widthPx, heightPx) >= 2160;
  if (ratio > 1.2) return is4k ? "landscape-4k" : "landscape";
  if (ratio < 0.83) return is4k ? "portrait-4k" : "portrait";
  return is4k ? "square-4k" : "square";
}

/** InfiniBot easing → GSAP ease string. */
function easeToGsap(ease: EasingName | undefined): string {
  switch (ease) {
    case "linear":
      return "none";
    case "easeIn":
      return "power2.in";
    case "easeOut":
      return "power2.out";
    case "easeInOut":
      return "power2.inOut";
    case "spring":
      return "elastic.out(1, 0.5)";
    default:
      return "power2.out";
  }
}

/** Percent-of-canvas → pixel coordinate. */
function pct(value: number | undefined, total: number, fallback = 0): number {
  if (value == null || Number.isNaN(value)) return fallback;
  return Math.round((value / 100) * total);
}

/**
 * Build entrance + exit keyframes for one clip based on
 * `animateIn` / `animateOut`. Returns the keyframe list for that clip,
 * which is keyed by element id in the final SerializeOptions.
 *
 * When `clip.props.animationPresetId` is set we delegate to the motion-
 * preset library which produces a richer in / emphasis / out triplet
 * via `applyPreset` (including effects the manual `animateIn` enum
 * never covered — typewriter, glitch, wipe, kenBurns, etc.). The same
 * function call also produces a tween stream (`GsapAnimation[]`) for
 * effects that need CSS props outside the GSAP-supported keyframe
 * vocabulary; those are returned via the second tuple slot and merged
 * into `options.animations` by the caller.
 */
function buildClipKeyframes(
  clip: Clip,
  widthPx: number,
  heightPx: number,
): {
  keyframes: Keyframe[];
  animations: GsapAnimation[];
} {
  const props = clip.props as {
    animateIn?: { kind: string; durationSec: number; easing: EasingName };
    animateOut?: { kind: string; durationSec: number; easing: EasingName };
    animationPresetId?: string;
  };
  const result: Keyframe[] = [];
  const tweens: GsapAnimation[] = [];

  const baseX = pct((clip.props as { x?: number }).x, widthPx, 0);
  const baseY = pct((clip.props as { y?: number }).y, heightPx, 0);
  const baseOpacity = (clip.props as { opacity?: number }).opacity ?? 1;

  // Preset path — preset wins over the raw animateIn/animateOut pair.
  if (props.animationPresetId && props.animationPresetId !== "none") {
    const preset = findElementAnimationPreset(props.animationPresetId);
    const out = applyPreset(preset, {
      elementId: clip.id,
      clipStartSec: clip.startSec,
      clipEndSec: clip.startSec + clip.durationSec,
      baseX,
      baseY,
      baseOpacity,
      baseScale: 1,
      canvasW: widthPx,
      canvasH: heightPx,
    });
    return { keyframes: out.keyframes, animations: out.animations };
  }

  // animateIn
  const inAnim = props.animateIn;
  if (inAnim && inAnim.kind !== "none" && inAnim.durationSec > 0) {
    const inEase = easeToGsap(inAnim.easing);
    const t0 = clip.startSec;
    const t1 = clip.startSec + inAnim.durationSec;
    switch (inAnim.kind) {
      case "fade":
        result.push({ id: `${clip.id}-in-0`, time: t0, properties: { opacity: 0 }, ease: inEase });
        result.push({
          id: `${clip.id}-in-1`,
          time: t1,
          properties: { opacity: baseOpacity },
          ease: inEase,
        });
        break;
      case "slideUp":
        result.push({
          id: `${clip.id}-in-0`,
          time: t0,
          properties: { y: baseY + heightPx * 0.1, opacity: 0 },
          ease: inEase,
        });
        result.push({
          id: `${clip.id}-in-1`,
          time: t1,
          properties: { y: baseY, opacity: baseOpacity },
          ease: inEase,
        });
        break;
      case "slideDown":
        result.push({
          id: `${clip.id}-in-0`,
          time: t0,
          properties: { y: baseY - heightPx * 0.1, opacity: 0 },
          ease: inEase,
        });
        result.push({
          id: `${clip.id}-in-1`,
          time: t1,
          properties: { y: baseY, opacity: baseOpacity },
          ease: inEase,
        });
        break;
      case "slideLeft":
        result.push({
          id: `${clip.id}-in-0`,
          time: t0,
          properties: { x: baseX + widthPx * 0.1, opacity: 0 },
          ease: inEase,
        });
        result.push({
          id: `${clip.id}-in-1`,
          time: t1,
          properties: { x: baseX, opacity: baseOpacity },
          ease: inEase,
        });
        break;
      case "slideRight":
        result.push({
          id: `${clip.id}-in-0`,
          time: t0,
          properties: { x: baseX - widthPx * 0.1, opacity: 0 },
          ease: inEase,
        });
        result.push({
          id: `${clip.id}-in-1`,
          time: t1,
          properties: { x: baseX, opacity: baseOpacity },
          ease: inEase,
        });
        break;
      case "scale":
        result.push({
          id: `${clip.id}-in-0`,
          time: t0,
          properties: { scale: 0.6, opacity: 0 },
          ease: inEase,
        });
        result.push({
          id: `${clip.id}-in-1`,
          time: t1,
          properties: { scale: 1, opacity: baseOpacity },
          ease: inEase,
        });
        break;
      case "blur":
        // No native blur keyframe; degrade to opacity fade.
        result.push({ id: `${clip.id}-in-0`, time: t0, properties: { opacity: 0 }, ease: inEase });
        result.push({
          id: `${clip.id}-in-1`,
          time: t1,
          properties: { opacity: baseOpacity },
          ease: inEase,
        });
        break;
    }
  }

  // animateOut — applied in the final `durationSec` of the clip.
  const outAnim = props.animateOut;
  if (outAnim && outAnim.kind !== "none" && outAnim.durationSec > 0) {
    const outEase = easeToGsap(outAnim.easing);
    const t0 = clip.startSec + clip.durationSec - outAnim.durationSec;
    const t1 = clip.startSec + clip.durationSec;
    switch (outAnim.kind) {
      case "fade":
        result.push({
          id: `${clip.id}-out-0`,
          time: t0,
          properties: { opacity: baseOpacity },
          ease: outEase,
        });
        result.push({
          id: `${clip.id}-out-1`,
          time: t1,
          properties: { opacity: 0 },
          ease: outEase,
        });
        break;
      case "slideUp":
        result.push({
          id: `${clip.id}-out-0`,
          time: t0,
          properties: { y: baseY, opacity: baseOpacity },
          ease: outEase,
        });
        result.push({
          id: `${clip.id}-out-1`,
          time: t1,
          properties: { y: baseY - heightPx * 0.1, opacity: 0 },
          ease: outEase,
        });
        break;
      case "slideDown":
        result.push({
          id: `${clip.id}-out-0`,
          time: t0,
          properties: { y: baseY, opacity: baseOpacity },
          ease: outEase,
        });
        result.push({
          id: `${clip.id}-out-1`,
          time: t1,
          properties: { y: baseY + heightPx * 0.1, opacity: 0 },
          ease: outEase,
        });
        break;
      case "slideLeft":
        result.push({
          id: `${clip.id}-out-0`,
          time: t0,
          properties: { x: baseX, opacity: baseOpacity },
          ease: outEase,
        });
        result.push({
          id: `${clip.id}-out-1`,
          time: t1,
          properties: { x: baseX - widthPx * 0.1, opacity: 0 },
          ease: outEase,
        });
        break;
      case "slideRight":
        result.push({
          id: `${clip.id}-out-0`,
          time: t0,
          properties: { x: baseX, opacity: baseOpacity },
          ease: outEase,
        });
        result.push({
          id: `${clip.id}-out-1`,
          time: t1,
          properties: { x: baseX + widthPx * 0.1, opacity: 0 },
          ease: outEase,
        });
        break;
      case "scale":
        result.push({
          id: `${clip.id}-out-0`,
          time: t0,
          properties: { scale: 1, opacity: baseOpacity },
          ease: outEase,
        });
        result.push({
          id: `${clip.id}-out-1`,
          time: t1,
          properties: { scale: 0.6, opacity: 0 },
          ease: outEase,
        });
        break;
      case "blur":
        result.push({
          id: `${clip.id}-out-0`,
          time: t0,
          properties: { opacity: baseOpacity },
          ease: outEase,
        });
        result.push({
          id: `${clip.id}-out-1`,
          time: t1,
          properties: { opacity: 0 },
          ease: outEase,
        });
        break;
    }
  }

  return { keyframes: result, animations: tweens };
}

function mediaElement(
  clip: Clip,
  type: "video" | "image" | "audio",
  widthPx: number,
  heightPx: number,
): TimelineMediaElement {
  const p = clip.props as VideoClipProps | ImageClipProps | AudioClipProps;
  const src = (p as { src: string }).src;
  return {
    id: clip.id,
    type,
    name: clip.label || clip.kind,
    startTime: clip.startSec,
    duration: clip.durationSec,
    zIndex: clip.z,
    x: pct(p.x, widthPx, 0),
    y: pct(p.y, heightPx, 0),
    opacity: p.opacity ?? 1,
    src,
    mediaStartTime: (p as VideoClipProps | AudioClipProps).trimStart ?? 0,
    volume: (p as VideoClipProps | AudioClipProps).volume,
  };
}

function textElement(
  clip: Clip,
  widthPx: number,
  heightPx: number,
  contentOverride?: string,
): TimelineTextElement {
  const p = clip.props as TextClipProps & { autoFit?: boolean; minFontSize?: number };
  let content = contentOverride ?? p.text ?? "";
  // Text-animator split: when the clip has `animators[]`, wrap each
  // char/word/line in a `<span data-anim-item data-anim-key="...">` so
  // the GSAP target selectors can address each split element. The
  // animators themselves are emitted into `t.options.animations` by
  // `emitTextAnimatorTweens` after every clip's elements are built.
  const animators = Array.isArray(p.animators) ? p.animators : [];
  if (animators.length > 0 && content && !contentOverride) {
    content = splitTextIntoSpans(content, animators[0]!.splitBy);
  }
  // Auto-fit: when the operator (or agent) sets `autoFit: true` on a text
  // clip, shrink the font size until the text lays out on a single line
  // inside its bounding box. hyperframes-core's `fitTextFontSize` ships
  // a pure-JS layout impl (via @chenglou/pretext) so it runs cleanly in
  // the translator. Original `fontSize` becomes the upper bound; we
  // never grow past what the operator authored.
  let fontSize = p.fontSize;
  if (p.autoFit && content && typeof p.fontSize === "number") {
    const widthPct = typeof p.width === "number" ? p.width : 100;
    const maxWidth = Math.max(80, (widthPct / 100) * widthPx);
    const minFontSize =
      typeof p.minFontSize === "number"
        ? p.minFontSize
        : Math.max(12, Math.floor(p.fontSize * 0.35));
    try {
      const fit = fitTextFontSize(content, {
        maxWidth,
        baseFontSize: p.fontSize,
        minFontSize,
        fontWeight: p.fontWeight ?? 700,
        fontFamily: (p.fontFamily ?? "Inter").split(",")[0]!.trim(),
        step: 2,
      });
      fontSize = fit.fontSize;
    } catch {
      // Layout lib can throw on unknown glyphs / unusual scripts; we'd
      // rather render at the seed size than fail the whole composition.
      fontSize = p.fontSize;
    }
  }
  return {
    id: clip.id,
    type: "text",
    name: clip.label || "Text",
    startTime: clip.startSec,
    duration: clip.durationSec,
    zIndex: clip.z,
    x: pct(p.x, widthPx, 0),
    y: pct(p.y, heightPx, 0),
    opacity: p.opacity ?? 1,
    content,
    color: p.color,
    fontSize,
    fontFamily: p.fontFamily,
    fontWeight: p.fontWeight,
  };
}

function shapeAsTextElement(clip: Clip, widthPx: number, heightPx: number): TimelineTextElement {
  const p = clip.props as ShapeClipProps;
  // Shapes have no native hyperframes type — represent as a zero-content
  // text element. The styles option below carves out a CSS rule on the
  // element's id to draw the actual fill / border / radius.
  return {
    id: clip.id,
    type: "text",
    name: clip.label || "Shape",
    startTime: clip.startSec,
    duration: clip.durationSec,
    zIndex: clip.z,
    x: pct(p.x, widthPx, 0),
    y: pct(p.y, heightPx, 0),
    opacity: p.opacity ?? 1,
    content: "",
  };
}

/**
 * Sub-composition clip → `TimelineCompositionElement`. The hyperframes
 * generator emits this as an `<iframe>` pointed at `element.src` with
 * per-instance variable values appended as query params (the embedded
 * runtime reads them via `URLSearchParams` and merges them over the
 * referenced comp's own `meta.variableValues`).
 *
 * `src` is the gateway's same-origin preview endpoint
 * (`/api/compositions/<id>/preview.html`) which already returns the
 * fully-built HTML including the runtime IIFE — so the embedded comp
 * plays back natively, no special render path needed.
 */
function subCompElement(clip: Clip, widthPx: number, heightPx: number): TimelineCompositionElement {
  const p = clip.props as SubCompClipProps;
  const refId = p.referencedCompositionId || "";
  return {
    id: clip.id,
    type: "composition",
    name: clip.label || "Sub-composition",
    startTime: clip.startSec,
    duration: clip.durationSec,
    zIndex: clip.z,
    x: pct(p.x, widthPx, 0),
    y: pct(p.y, heightPx, 0),
    opacity: p.opacity ?? 1,
    scale: 1,
    src: `/api/compositions/${encodeURIComponent(refId)}/preview.html`,
    compositionId: refId,
    sourceDuration: p.sourceDurationSec,
    sourceWidth: p.sourceWidthPx,
    sourceHeight: p.sourceHeightPx,
    variableValues:
      p.variableValues && Object.keys(p.variableValues).length > 0 ? p.variableValues : undefined,
  };
}

function captionsToElements(clip: Clip, widthPx: number, heightPx: number): TimelineTextElement[] {
  const p = clip.props as CaptionsClipProps;
  return p.cues.map((cue, i) => ({
    id: `${clip.id}-cue-${i}`,
    type: "text",
    name: `Caption ${i + 1}`,
    startTime: cue.start,
    duration: Math.max(0, cue.end - cue.start),
    zIndex: clip.z,
    x: pct(p.x, widthPx, 0),
    y: pct(p.y, heightPx, Math.round(heightPx * 0.8)),
    opacity: p.opacity ?? 1,
    content: cue.text,
    color: "#ffffff",
    fontSize: 56,
    fontWeight: 700,
    textOutline: true,
    textOutlineColor: "#000000",
    textOutlineWidth: 3,
  }));
}

function shapeCss(clip: Clip): string {
  const p = clip.props as ShapeClipProps;
  const fill =
    p.shape === "gradient" && p.gradientFrom && p.gradientTo
      ? `linear-gradient(${p.gradientAngle ?? 0}deg, ${p.gradientFrom}, ${p.gradientTo})`
      : (p.fill ?? "#ffffff");
  const radius =
    p.shape === "circle" ? "9999px" : p.borderRadius != null ? `${p.borderRadius}px` : "0";
  const border =
    p.borderColor && p.borderWidth ? `${p.borderWidth}px solid ${p.borderColor}` : "none";
  return `#${clip.id}{background:${fill};border-radius:${radius};border:${border};}`;
}

/**
 * Per-clip CSS that pins the element to the authored canvas % size.
 * Hyperframes' default styling makes every element fill 100% × 100% of the
 * stage; without this override the % width/height on a `Clip` wouldn't take
 * effect.
 */
function sizeCss(clip: Clip, widthPx: number, heightPx: number): string {
  const p = clip.props as { width?: number; height?: number; rotation?: number };
  const w = pct(p.width, widthPx, widthPx);
  const h = pct(p.height, heightPx, heightPx);
  const rot =
    typeof p.rotation === "number" && p.rotation !== 0
      ? ` transform: rotate(${p.rotation}deg);`
      : "";
  return `#${clip.id}{width:${w}px;height:${h}px;${rot}}`;
}

// ── Block expansion (HTML + scoped CSS) ────────────────────────────
//
// Mirrors the in-page block rendering in render.ts: substitute `{{slot}}`
// placeholders against the BlockDefinition.template, scope the block's CSS
// to `.veblk-<id>`, and wrap the rendered HTML in that class so the scoped
// rules apply. Built-in (catalog) blocks fall through to a hardcoded HTML
// fragment so a composition referencing `intro-card`, `lower-third`, etc.
// still renders when the runtime catalog isn't supplied.
function renderBlockTemplate(
  def: BlockDefinition,
  slots: Record<string, string> | undefined,
): string {
  const tpl = def.template ?? "";
  return tpl.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key: string) => {
    if (slots && typeof slots[key] === "string") return slots[key];
    const slotDef = (def.slots ?? []).find((s) => s.key === key);
    return slotDef?.default ?? "";
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Hardcoded HTML for the built-in block ids shipped in catalog.ts. Kept
 * close to the in-page renderer in render.ts so MP4 output and the live
 * editor preview match frame-for-frame.
 */
function builtInBlockHtml(blockId: string, slots: Record<string, string>): string | null {
  const s = (k: string, fb = "") => escapeHtml(slots[k] ?? fb);
  switch (blockId) {
    case "intro-card":
      return (
        `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;` +
        `width:100%;height:100%;text-align:center;gap:12px">` +
        `<div style="font-size:88px;font-weight:800;color:#d4af37;text-shadow:0 0 22px #d4af37;letter-spacing:-0.02em">` +
        `${s("headline", "Your headline")}</div>` +
        (slots.subhead
          ? `<div style="font-size:28px;color:#e4e4e7;opacity:0.85">${s("subhead")}</div>`
          : "") +
        `</div>`
      );
    case "lower-third":
      return (
        `<div style="display:flex;flex-direction:column;justify-content:center;width:100%;height:100%;` +
        `padding:0 18px;background:linear-gradient(135deg,rgba(8,8,18,.85),rgba(5,5,12,.95));` +
        `border:1px solid rgba(212,175,55,.45);border-radius:14px">` +
        `<div style="font-size:34px;font-weight:800;color:#d4af37">${s("name", "Speaker")}</div>` +
        `<div style="font-size:18px;font-weight:500;color:#a1a1aa;margin-top:4px">${s("role", "Role")}</div>` +
        `</div>`
      );
    case "kinetic-title":
      return (
        `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%">` +
        `<div style="font-size:140px;font-weight:900;color:#d4af37;letter-spacing:.04em;text-shadow:0 0 32px #d4af37">` +
        `${s("title", "BIG TITLE")}</div></div>`
      );
    case "end-card":
      return (
        `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;` +
        `width:100%;height:100%;text-align:center;gap:12px">` +
        `<div style="font-size:64px;font-weight:800;color:#e4e4e7">Thanks for watching</div>` +
        `<div style="font-size:28px;font-weight:600;color:#d4af37;letter-spacing:.04em">${s("cta", "yoursite.com")}</div>` +
        `</div>`
      );
    case "captions":
      return (
        `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;` +
        `background:rgba(0,0,0,.62);border-radius:8px">` +
        `<div style="font-size:32px;font-weight:600;color:#e4e4e7;text-align:center;padding:0 12px">` +
        `${s("text", "Caption")}</div></div>`
      );
    default:
      return null;
  }
}

/**
 * Scope a block's CSS to `.veblk-<id>` so it can't bleed into other clips.
 * Selectors that already reference the scope class are passed through.
 * Duplicates blocks/store.ts:scopeBlockCss intentionally — the translator
 * runs synchronously, so we don't want to pull the async block store load
 * chain into this module's import graph.
 */
function scopeBlockCss(blockId: string, css: string): string {
  if (!css) return "";
  const scope = `.veblk-${blockId}`;
  return css.replace(/(^|})\s*([^@}{][^{]*)\{/g, (_m, brace: string, sel: string) => {
    const scoped = sel
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        if (trimmed.startsWith(scope) || trimmed === scope) return trimmed;
        if (/^(:root|html|body)\b/.test(trimmed)) return scope;
        return `${scope} ${trimmed}`;
      })
      .filter(Boolean)
      .join(", ");
    return `${brace} ${scoped} {`;
  });
}

interface BlockExpansion {
  html: string;
  scopedCss: string;
}

function expandBlock(clip: Clip, blocksById: Map<string, BlockDefinition>): BlockExpansion {
  const p = clip.props as BlockClipProps;
  const slots = (p.slots ?? {}) as Record<string, string>;
  const def = blocksById.get(p.blockId);
  if (def?.template) {
    const inner = renderBlockTemplate(def, slots);
    return {
      html: `<div class="veblk-${def.id}" style="width:100%;height:100%">${inner}</div>`,
      scopedCss: def.css ? scopeBlockCss(def.id, def.css) : "",
    };
  }
  const fallback = builtInBlockHtml(p.blockId, slots);
  if (fallback) return { html: fallback, scopedCss: "" };
  return { html: `<div>[block ${escapeHtml(p.blockId)}]</div>`, scopedCss: "" };
}

function blockCss(clip: Clip): string {
  // The block's own template provides its visual; this rule just neutralizes
  // hyperframes' default text-element flex-centering so the block's inner
  // layout takes effect, and gives a transparent fallback background.
  return (
    `#${clip.id}{display:block;background:transparent;}` +
    `#${clip.id}>div{display:block;width:100%;height:100%;}`
  );
}

export interface TranslateOptions {
  /**
   * In-process block catalog. When omitted, agent-authored blocks render a
   * placeholder; built-in blocks still expand via the hardcoded fallbacks.
   * Pass `await listAllBlocks()` from the render call site.
   */
  blocks?: BlockDefinition[];
}

/**
 * Translate a full Composition (with tracks + clips) into the inputs
 * `generateHyperframesHtml(elements, totalDuration, options)` expects.
 */
export function compositionToHyperframes(
  comp: CompositionWithChildren,
  opts: TranslateOptions = {},
): TranslateResult {
  const elements: TimelineElement[] = [];
  const keyframes: Record<string, Keyframe[]> = {};
  const animations: GsapAnimation[] = [];
  const extraCss: string[] = [];
  const widthPx = comp.widthPx;
  const heightPx = comp.heightPx;

  const trackById = new Map(comp.tracks.map((t) => [t.id, t] as const));
  const blocksById = new Map<string, BlockDefinition>((opts.blocks ?? []).map((b) => [b.id, b]));

  // Resolve composition variables once — every clip's string-valued
  // props get `{{varId}}` substitution and `{$var: id}` binding
  // resolution against this map before the element builder reads them.
  // Keeps the per-clip code path identical whether or not the project
  // is using parameterized templates.
  const { values: variableValues } = resolveVariables(
    comp.meta as Record<string, unknown> | undefined,
  );

  // Parent-chain resolver — walk `clip.props.parentClipId` and
  // pre-multiply x/y/rotation/scale onto each child's effective
  // transform before any other translator math reads it. Cycles are
  // detected via a visited-set and silently dropped (the leaf gets its
  // own untransformed props as a last resort).
  const clipById = new Map(comp.clips.map((c) => [c.id, c] as const));
  const effectiveProps = (raw: Clip): Record<string, unknown> => {
    const base = resolveProps(raw.props as unknown as Record<string, unknown>, variableValues);
    const walk = (
      id: string | undefined,
      visited: Set<string>,
    ): { x: number; y: number; scale: number; rotation: number } => {
      if (!id || visited.has(id)) return { x: 0, y: 0, scale: 1, rotation: 0 };
      const parent = clipById.get(id);
      if (!parent) return { x: 0, y: 0, scale: 1, rotation: 0 };
      visited.add(id);
      const parentProps = resolveProps(
        parent.props as unknown as Record<string, unknown>,
        variableValues,
      );
      const px = typeof parentProps.x === "number" ? parentProps.x : 0;
      const py = typeof parentProps.y === "number" ? parentProps.y : 0;
      const pr = typeof parentProps.rotation === "number" ? parentProps.rotation : 0;
      const ps = typeof parentProps.scale === "number" ? parentProps.scale : 1;
      const up = walk(parentProps.parentClipId as string | undefined, visited);
      return {
        x: up.x + px * up.scale,
        y: up.y + py * up.scale,
        rotation: up.rotation + pr,
        scale: up.scale * ps,
      };
    };
    const parentXf = walk(base.parentClipId as string | undefined, new Set<string>([raw.id]));
    if (parentXf.x !== 0 || parentXf.y !== 0 || parentXf.scale !== 1 || parentXf.rotation !== 0) {
      const selfScale = typeof base.scale === "number" ? base.scale : 1;
      const selfX = typeof base.x === "number" ? base.x : 0;
      const selfY = typeof base.y === "number" ? base.y : 0;
      const selfRot = typeof base.rotation === "number" ? base.rotation : 0;
      base.x = parentXf.x + selfX * parentXf.scale;
      base.y = parentXf.y + selfY * parentXf.scale;
      base.scale = selfScale * parentXf.scale;
      base.rotation = selfRot + parentXf.rotation;
    }
    return base;
  };

  for (const rawClip of comp.clips) {
    const track = trackById.get(rawClip.trackId);
    if (track?.hidden) continue;
    // Null clips are transform-only — they propagate to children via the
    // parent walker above but emit no visual element themselves.
    if (rawClip.kind === "null") continue;
    const clip: Clip = {
      ...rawClip,
      props: effectiveProps(rawClip) as unknown as Clip["props"],
    };

    let el: TimelineElement | null = null;
    let extraElements: TimelineElement[] = [];
    let emitSizeCss = true;

    switch (clip.kind) {
      case "video":
      case "image":
      case "audio":
        el = mediaElement(clip, clip.kind, widthPx, heightPx);
        if (track?.muted && (clip.kind === "video" || clip.kind === "audio")) {
          (el as TimelineMediaElement).volume = 0;
        }
        if (clip.kind === "audio") emitSizeCss = false;
        break;
      case "text":
        el = textElement(clip, widthPx, heightPx);
        break;
      case "shape":
        el = shapeAsTextElement(clip, widthPx, heightPx);
        extraCss.push(shapeCss(clip));
        break;
      case "block": {
        const expanded = expandBlock(clip, blocksById);
        if (expanded.scopedCss) extraCss.push(expanded.scopedCss);
        el = textElement(clip, widthPx, heightPx, expanded.html);
        extraCss.push(blockCss(clip));
        break;
      }
      case "captions":
        extraElements = captionsToElements(clip, widthPx, heightPx);
        emitSizeCss = false;
        break;
      case "subcomp":
        el = subCompElement(clip, widthPx, heightPx);
        break;
    }

    if (el) elements.push(el);
    if (extraElements.length) elements.push(...extraElements);
    if (el && emitSizeCss) extraCss.push(sizeCss(clip, widthPx, heightPx));

    // Effects chain — turn `clip.props.effects[]` into a CSS filter
    // rule on the element id + any required overlay HTML (grain,
    // vignette). The generator's `customStyles` channel forwards the
    // rule to the runtime; overlays get appended to the element content
    // via the text-element trick (block-clip path already does this).
    const fx = (clip.props as { effects?: ClipEffect[] }).effects;
    if (el && fx && fx.length > 0) {
      const out = renderClipEffects(clip.id, fx);
      if (out) {
        if (out.cssRule) extraCss.push(out.cssRule);
        // Overlays piggyback on the text-element content channel — for
        // media/shape clips that channel is normally empty, so we
        // re-emit them as a text wrapper with the overlay HTML inside.
        if (out.extraHtml && el.type === "text") {
          (el as TimelineTextElement).content =
            `${(el as TimelineTextElement).content ?? ""}${out.extraHtml}`;
        }
      }
    }

    const clipAnim = buildClipKeyframes(clip, widthPx, heightPx);
    // Layer the user-authored `customKeyframes` on top of whatever the
    // preset/animateIn/animateOut emitted.
    const propsAny = clip.props as {
      customKeyframes?: Array<{
        id: string;
        time: number;
        properties: Record<string, number>;
        ease?: string;
      }>;
      keyframeLanes?: Array<{
        property: string;
        points: Array<{
          id: string;
          time: number;
          value: number;
          interp: string;
          bezier?: [number, number, number, number];
        }>;
      }>;
    };
    const customKf = propsAny.customKeyframes;
    let allKeyframes = clipAnim.keyframes;
    if (customKf && customKf.length) {
      allKeyframes = [
        ...allKeyframes,
        ...customKf.filter(
          (k) => Number.isFinite(k?.time) && k?.properties && typeof k.properties === "object",
        ),
      ];
    }
    // Lower per-property keyframe lanes (the AE-style representation)
    // into the same Keyframe[] stream — each lane produces N keyframes
    // (one per point) with the property + ease baked in.
    const lanes = propsAny.keyframeLanes;
    if (lanes && lanes.length > 0) {
      const laneKeyframes = lanesToKeyframes(clip.id, lanes);
      if (laneKeyframes.length) allKeyframes = [...allKeyframes, ...laneKeyframes];
    }
    if (allKeyframes.length) keyframes[clip.id] = allKeyframes;
    if (clipAnim.animations.length) animations.push(...clipAnim.animations);
  }

  const resolution = pickResolution(widthPx, heightPx);
  const presetDims = CANVAS_DIMENSIONS[resolution];
  // Hyperframes' default stylesheet sizes `#stage` from the resolution
  // preset. When the authored composition's pixels don't match the preset
  // exactly, override the stage to the authored size + bg color so the
  // pixel-positioned elements land where the editor placed them.
  const stageOverride =
    presetDims.width !== widthPx || presetDims.height !== heightPx
      ? `#stage{width:${widthPx}px;height:${heightPx}px;background:${comp.bgColor};}`
      : `#stage{background:${comp.bgColor};}`;
  extraCss.unshift(stageOverride);

  // Stage-zoom keyframes come straight off `comp.meta.stageZoomKeyframes`
  // (managed via the `compositions.stageZoom.*` RPCs). We forward them
  // unchanged to the generator — hyperframes-core handles the camera-
  // tween math at render time AND the inline `<hyperframes-stage>`
  // mount reads them off the stage container to drive live preview.
  const stageZoomKeyframes: StageZoomKeyframe[] = readStageZoomKeyframes(
    comp.meta as Record<string, unknown> | undefined,
  );

  // Text animators — emit per-span stagger tweens for every text clip
  // with `animators[]`. Must happen AFTER element emission (so the
  // wrapped `<span data-anim-key>` markup is in the elements html) but
  // BEFORE the SerializeOptions snapshot below.
  emitTextAnimatorTweens(comp, animations);

  // Clip transitions — `comp.meta.transitions` is the source of truth.
  // For each entry we emit BOTH sides of the effect (outgoing fade-out
  // + incoming fade-in / wipe etc.) anchored at the cut point so the
  // two clips visually hand off. The cut point is the midpoint between
  // the outgoing clip's end and the incoming clip's start when they
  // abut, or the average when they overlap.
  const transitions = readTransitions(comp.meta as Record<string, unknown> | undefined);
  for (const tr of transitions) {
    const fromClip = clipById.get(tr.fromClipId);
    const toClip = clipById.get(tr.toClipId);
    if (!fromClip || !toClip) continue;
    const fromEnd = fromClip.startSec + fromClip.durationSec;
    const toStart = toClip.startSec;
    const center = (fromEnd + toStart) / 2;
    animations.push(
      ...applyTransitionSide({
        elementId: fromClip.id,
        side: "out",
        kind: tr.kind,
        centerTime: center,
        durationSec: tr.durationSec,
        ease: tr.ease,
      }),
    );
    animations.push(
      ...applyTransitionSide({
        elementId: toClip.id,
        side: "in",
        kind: tr.kind,
        centerTime: center,
        durationSec: tr.durationSec,
        ease: tr.ease,
      }),
    );
  }

  const options: SerializeOptions = {
    resolution,
    compositionId: comp.id,
    keyframes,
    animations: animations.length ? animations : undefined,
    stageZoomKeyframes,
    styles: extraCss.length ? extraCss.join("\n") : undefined,
    generateDefaultAnimations: true,
    includeScripts: true,
    includeStyles: true,
  };

  return {
    elements,
    totalDuration: comp.durationSec,
    options,
    bgColor: comp.bgColor,
    widthPx,
    heightPx,
    fps: comp.fps,
  };
}

/**
 * Alias matching the migration brief's preferred name. Returns the same
 * shape as `compositionToHyperframes` — both are kept exported because
 * downstream code (smoke test, render.ts, UI preview) reaches for whichever
 * verb feels right at the call site.
 */
export const compositionToHyperframesSpec = compositionToHyperframes;

/** Convenience: produce the final HTML directly from a Composition. */
export function compositionToHyperframesHtml(
  comp: CompositionWithChildren,
  opts: TranslateOptions = {},
): string {
  const t = compositionToHyperframes(comp, opts);
  return generateHyperframesHtml(t.elements, t.totalDuration, t.options);
}

/**
 * Pull stage-zoom keyframes off a composition's meta, validating each
 * entry's shape. Anything malformed is dropped silently so an agent
 * writing partial data can't poison the render — `compositions.stageZoom.*`
 * RPCs enforce shape on write so this is belt-and-suspenders.
 */
function readStageZoomKeyframes(meta: Record<string, unknown> | undefined): StageZoomKeyframe[] {
  const raw = (meta?.stageZoomKeyframes ?? []) as unknown;
  if (!Array.isArray(raw)) return [];
  const out: StageZoomKeyframe[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const zoom = e.zoom as Record<string, unknown> | undefined;
    if (!zoom || typeof zoom !== "object") continue;
    const time = typeof e.time === "number" ? e.time : NaN;
    const scale = typeof zoom.scale === "number" ? zoom.scale : NaN;
    const focusX = typeof zoom.focusX === "number" ? zoom.focusX : NaN;
    const focusY = typeof zoom.focusY === "number" ? zoom.focusY : NaN;
    if ([time, scale, focusX, focusY].some((n) => !Number.isFinite(n))) continue;
    out.push({
      id: typeof e.id === "string" ? e.id : `kf-${time.toFixed(3)}-${scale.toFixed(2)}`,
      time,
      zoom: { scale, focusX, focusY },
      ease: typeof e.ease === "string" ? e.ease : undefined,
    });
  }
  // Generator expects ascending time order.
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Flatten AE-style keyframe lanes into the Keyframe[] shape the
 * hyperframes generator consumes. Each lane has its own time series
 * for one property; we emit one Keyframe per point with the right
 * `ease` derived from the point's `interp` + bezier handles.
 *
 * Keyframes from different lanes share a clip id but apply to
 * different `properties`, so the generator's `keyframesToGsapAnimations`
 * keeps them separate at emit time.
 */
function lanesToKeyframes(
  clipId: string,
  lanes: Array<{
    property: string;
    points: Array<{
      id: string;
      time: number;
      value: number;
      interp: string;
      bezier?: [number, number, number, number];
    }>;
  }>,
): Keyframe[] {
  const out: Keyframe[] = [];
  for (const lane of lanes) {
    if (!lane || !Array.isArray(lane.points)) continue;
    const sorted = [...lane.points]
      .filter((p) => p && Number.isFinite(p.time) && Number.isFinite(p.value))
      .sort((a, b) => a.time - b.time);
    for (const p of sorted) {
      out.push({
        id: `${clipId}-lane-${lane.property}-${p.id}`,
        time: p.time,
        properties: { [lane.property]: p.value },
        ease: interpToGsapEase(p.interp, p.bezier),
      });
    }
  }
  return out;
}

function interpToGsapEase(interp: string, bezier?: [number, number, number, number]): string {
  switch (interp) {
    case "hold":
      return "steps(1)";
    case "linear":
      return "none";
    case "easeIn":
      return "power2.in";
    case "easeOut":
      return "power2.out";
    case "easeInOut":
      return "power2.inOut";
    case "bezier": {
      if (bezier && bezier.every((n) => Number.isFinite(n))) {
        // GSAP's CustomEase needs a registered name; CSS-style cubic
        // bezier values work via the `cubicBezier(...)` shorthand in
        // newer GSAP builds. Falling back to power2.inOut if the
        // runtime parser doesn't recognise it is non-fatal.
        return `cubic-bezier(${bezier[0]}, ${bezier[1]}, ${bezier[2]}, ${bezier[3]})`;
      }
      return "power2.inOut";
    }
    default:
      return "power2.out";
  }
}

/**
 * Split text into a sequence of `<span data-anim-item data-anim-key>`
 * elements so per-element GSAP tweens can target them. The
 * `data-anim-key` matches the index so we can build deterministic
 * selectors. Returns sanitized HTML safe for the generator's
 * `content` injection (which uses it verbatim inside the element).
 */
function splitTextIntoSpans(text: string, by: string): string {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (by === "line") {
    const lines = safe.split(/\n+/);
    return lines
      .map(
        (line, i) =>
          `<span data-anim-item data-anim-key="${i}" style="display:block;white-space:pre">${line || "&nbsp;"}</span>`,
      )
      .join("");
  }
  if (by === "word") {
    // Split on whitespace but preserve the spaces as separate
    // (non-animated) text nodes so the layout stays correct.
    const tokens = safe.split(/(\s+)/);
    let wordIdx = 0;
    return tokens
      .map((tok) => {
        if (/^\s+$/.test(tok)) return tok;
        if (tok === "") return "";
        const key = wordIdx++;
        return `<span data-anim-item data-anim-key="${key}" style="display:inline-block">${tok}</span>`;
      })
      .join("");
  }
  // char (default)
  const chars = [...safe];
  let charIdx = 0;
  return chars
    .map((ch) => {
      if (ch === " ") return "&nbsp;";
      if (ch === "\n") return "<br>";
      const key = charIdx++;
      return `<span data-anim-item data-anim-key="${key}" style="display:inline-block">${ch}</span>`;
    })
    .join("");
}

/**
 * For every clip with `animators[]`, emit a stagger of per-element
 * GSAP tweens. Each animator picks a range (chars/words/lines), seeds
 * each element with an offset state at clip-time `startSec`, then
 * tweens back to identity over `durationSec` with `staggerSec` between
 * consecutive elements.
 *
 * We push these onto the shared `animations` array — the generator
 * merges them with the keyframe-derived stream at render time.
 */
function emitTextAnimatorTweens(comp: CompositionWithChildren, animations: GsapAnimation[]): void {
  for (const clip of comp.clips) {
    if (clip.kind !== "text") continue;
    const p = clip.props as TextClipProps & { animators?: Array<Record<string, unknown>> };
    const list = Array.isArray(p.animators) ? p.animators : [];
    if (list.length === 0) continue;
    for (const aRaw of list) {
      const a = aRaw as {
        id?: string;
        splitBy?: string;
        staggerSec?: number;
        startSec?: number;
        durationSec?: number;
        ease?: string;
        rangeStart?: number;
        rangeEnd?: number;
        offset?: Record<string, number>;
      };
      const text = (clip.props as { text?: string }).text ?? "";
      if (!text) continue;
      const splitBy = a.splitBy === "line" || a.splitBy === "word" ? a.splitBy : "char";
      const count = splitCount(text, splitBy);
      if (count === 0) continue;
      const stagger = Number.isFinite(a.staggerSec) ? Math.max(0, a.staggerSec ?? 0) : 0.04;
      const dur =
        Number.isFinite(a.durationSec) && (a.durationSec ?? 0) > 0
          ? (a.durationSec as number)
          : 0.6;
      const start = clip.startSec + (Number.isFinite(a.startSec) ? (a.startSec ?? 0) : 0);
      const rs = clamp01(a.rangeStart ?? 0);
      const re = clamp01(a.rangeEnd ?? 1);
      const lo = Math.floor(Math.min(rs, re) * count);
      const hi = Math.ceil(Math.max(rs, re) * count);
      const ease = textAnimatorEase(a.ease);
      const offset = a.offset && typeof a.offset === "object" ? a.offset : {};
      const animatorId = a.id ?? `${clip.id}-anim-${Math.random().toString(36).slice(2, 8)}`;
      for (let i = lo; i < hi; i++) {
        const sel = `#${clip.id} [data-anim-key="${i}"]`;
        const t0 = start + (i - lo) * stagger;
        // Seed at the offset state.
        const fromProps: Record<string, number | string> = {};
        if (typeof offset.opacity === "number") fromProps.opacity = offset.opacity;
        if (typeof offset.x === "number") fromProps.x = offset.x;
        if (typeof offset.y === "number") fromProps.y = offset.y;
        if (typeof offset.scale === "number") fromProps.scale = offset.scale;
        if (typeof offset.rotation === "number") fromProps.rotation = offset.rotation;
        if (typeof offset.blur === "number") fromProps.filter = `blur(${offset.blur}px)`;
        animations.push({
          id: `${animatorId}-${i}-set`,
          targetSelector: sel,
          method: "set",
          position: t0,
          properties: fromProps,
        });
        // Tween back to identity.
        const toProps: Record<string, number | string> = {};
        if (typeof offset.opacity === "number") toProps.opacity = 1;
        if (typeof offset.x === "number") toProps.x = 0;
        if (typeof offset.y === "number") toProps.y = 0;
        if (typeof offset.scale === "number") toProps.scale = 1;
        if (typeof offset.rotation === "number") toProps.rotation = 0;
        if (typeof offset.blur === "number") toProps.filter = "blur(0px)";
        animations.push({
          id: `${animatorId}-${i}-to`,
          targetSelector: sel,
          method: "to",
          position: t0,
          duration: dur,
          ease,
          properties: toProps,
        });
      }
    }
  }
}

function splitCount(text: string, by: string): number {
  if (by === "line") return text.split(/\n+/).length;
  if (by === "word") return text.split(/\s+/).filter((w) => w.length > 0).length;
  return [...text].filter((c) => c !== "\n").length;
}

function clamp01(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function textAnimatorEase(ease: string | undefined): string {
  switch (ease) {
    case "linear":
      return "none";
    case "easeIn":
      return "power2.in";
    case "easeOut":
      return "power2.out";
    case "easeInOut":
      return "power2.inOut";
    case "back":
      return "back.out(2)";
    case "spring":
      return "elastic.out(1, 0.45)";
    default:
      return "power2.out";
  }
}
