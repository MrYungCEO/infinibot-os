/**
 * Motion presets — lower an `ElementAnimationPreset` into the keyframes
 * and GsapAnimation[] the hyperframes generator consumes.
 *
 * Why this file exists: the preset catalog in `element-animation-presets.ts`
 * defines ~14 named recipes (Pop In, Kinetic Title, Wipe Left, Glitch In…)
 * but until now the translator only knew how to render the basic
 * fade / slide / scale kinds. This module fills in the remaining kinds
 * (wipe variants, rotate, scaleDown, typewriter, glitch) and every
 * emphasis loop (pulse, float, breathe, shimmer, spin, wiggle, shake,
 * bounce, kenBurns), then merges the entrance + emphasis + exit into one
 * coherent animation stream for a clip.
 *
 * Two output channels:
 *   - `keyframes` — discrete time→property points consumed via the
 *     generator's `keyframes` option. Used for x/y/opacity/scale/rotation
 *     (the props GSAP's SUPPORTED_PROPS list blesses).
 *   - `animations` — direct GsapAnimation tweens used for effects that
 *     need CSS properties outside that whitelist (clipPath wipes,
 *     filter-based blur/glitch, scaleX flips, etc.). They go through the
 *     generator's `animations` option, which the generator merges with
 *     the keyframe-derived stream.
 *
 * Both channels positions are absolute timeline seconds — the generator
 * subtracts `element.startTime` internally when keyframes pass through
 * `keyframesToGsapAnimations`, so we always emit absolute times here.
 */
import type { Keyframe } from "@hyperframes/core";
import type { GsapAnimation } from "@hyperframes/core";

import type {
  ElementAnimationPreset,
  ElementAnimKind,
  ElementEasing,
  ElementEmphasisKind,
} from "./element-animation-presets.js";

export interface PresetContext {
  /** Element id (composition clip id). */
  elementId: string;
  /** Absolute clip-in time (seconds). */
  clipStartSec: number;
  /** Absolute clip-out time (seconds). */
  clipEndSec: number;
  /** Resting position in canvas pixels. */
  baseX: number;
  baseY: number;
  /** Resting opacity 0..1. */
  baseOpacity: number;
  /** Resting scale (1 = natural). */
  baseScale: number;
  /** Canvas dimensions for "off-stage" math. */
  canvasW: number;
  canvasH: number;
}

export interface PresetOutput {
  keyframes: Keyframe[];
  animations: GsapAnimation[];
}

const EMPTY: PresetOutput = { keyframes: [], animations: [] };

/** ElementEasing → GSAP ease string. */
function gsapEase(e: ElementEasing | undefined): string {
  switch (e) {
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
    case "back":
      return "back.out(2)";
    default:
      return "power2.out";
  }
}

/**
 * Lower a preset (in/emphasis/out) into renderable keyframes + tweens
 * for a single clip. Empty preset (no `in`/`out`/`emphasis` set) returns
 * `EMPTY` — the caller's existing fade/slide path stays in charge.
 */
export function applyPreset(preset: ElementAnimationPreset, ctx: PresetContext): PresetOutput {
  const kfs: Keyframe[] = [];
  const tweens: GsapAnimation[] = [];

  // ── entrance ────────────────────────────────────────────────
  if (preset.in && preset.in.kind !== "none" && preset.in.durationSec > 0) {
    const t0 = ctx.clipStartSec;
    const t1 = ctx.clipStartSec + preset.in.durationSec;
    addInOut(kfs, tweens, ctx, preset.in.kind, t0, t1, "in", gsapEase(preset.in.easing));
  }

  // ── emphasis (looped continuous animation between in-end and out-start) ──
  if (preset.emphasis && preset.emphasis.kind !== "none" && preset.emphasis.durationSec > 0) {
    const empStart = ctx.clipStartSec + (preset.in?.durationSec ?? 0);
    const empEnd = ctx.clipEndSec - (preset.out?.durationSec ?? 0);
    if (empEnd > empStart) {
      addEmphasis(
        kfs,
        tweens,
        ctx,
        preset.emphasis.kind,
        preset.emphasis.durationSec,
        clampIntensity(preset.emphasis.intensity),
        empStart,
        empEnd,
      );
    }
  }

  // ── exit ────────────────────────────────────────────────────
  if (preset.out && preset.out.kind !== "none" && preset.out.durationSec > 0) {
    const t1 = ctx.clipEndSec;
    const t0 = ctx.clipEndSec - preset.out.durationSec;
    addInOut(kfs, tweens, ctx, preset.out.kind, t0, t1, "out", gsapEase(preset.out.easing));
  }

  return { keyframes: kfs, animations: tweens };
}

function clampIntensity(v: number | undefined): number {
  if (v == null || !Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// ── kind dispatchers ─────────────────────────────────────────────────

function addInOut(
  kfs: Keyframe[],
  tweens: GsapAnimation[],
  ctx: PresetContext,
  kind: ElementAnimKind,
  t0: number,
  t1: number,
  side: "in" | "out",
  ease: string,
): void {
  const isIn = side === "in";
  const idBase = `${ctx.elementId}-${side}`;
  // Each builder appends to `kfs` and/or `tweens`. Kept inline for
  // density — extracting per-kind helpers would triple the file size.
  switch (kind) {
    case "fade":
      kfs.push(kf(`${idBase}-0`, t0, isIn ? { opacity: 0 } : { opacity: ctx.baseOpacity }, ease));
      kfs.push(kf(`${idBase}-1`, t1, isIn ? { opacity: ctx.baseOpacity } : { opacity: 0 }, ease));
      return;
    case "slideUp":
      slide(kfs, ctx, idBase, t0, t1, isIn, 0, ctx.canvasH * 0.1, ease);
      return;
    case "slideDown":
      slide(kfs, ctx, idBase, t0, t1, isIn, 0, -ctx.canvasH * 0.1, ease);
      return;
    case "slideLeft":
      slide(kfs, ctx, idBase, t0, t1, isIn, ctx.canvasW * 0.1, 0, ease);
      return;
    case "slideRight":
      slide(kfs, ctx, idBase, t0, t1, isIn, -ctx.canvasW * 0.1, 0, ease);
      return;
    case "scale":
      kfs.push(
        kf(
          `${idBase}-0`,
          t0,
          isIn ? { scale: 0.6, opacity: 0 } : { scale: ctx.baseScale, opacity: ctx.baseOpacity },
          ease,
        ),
      );
      kfs.push(
        kf(
          `${idBase}-1`,
          t1,
          isIn ? { scale: ctx.baseScale, opacity: ctx.baseOpacity } : { scale: 0.6, opacity: 0 },
          ease,
        ),
      );
      return;
    case "scaleDown":
      kfs.push(
        kf(
          `${idBase}-0`,
          t0,
          isIn ? { scale: 1.4, opacity: 0 } : { scale: ctx.baseScale, opacity: ctx.baseOpacity },
          ease,
        ),
      );
      kfs.push(
        kf(
          `${idBase}-1`,
          t1,
          isIn ? { scale: ctx.baseScale, opacity: ctx.baseOpacity } : { scale: 1.4, opacity: 0 },
          ease,
        ),
      );
      return;
    case "rotate":
      // Spring-rotate from offset → 0 on enter, 0 → offset on exit.
      kfs.push(
        kf(
          `${idBase}-0`,
          t0,
          isIn ? { rotation: -15, opacity: 0 } : { rotation: 0, opacity: ctx.baseOpacity },
          ease,
        ),
      );
      kfs.push(
        kf(
          `${idBase}-1`,
          t1,
          isIn ? { rotation: 0, opacity: ctx.baseOpacity } : { rotation: 15, opacity: 0 },
          ease,
        ),
      );
      return;
    case "skew":
      // Skew via scaleX warp (no native skew prop on the supported list).
      kfs.push(
        kf(
          `${idBase}-0`,
          t0,
          isIn ? { scaleX: 1.6, opacity: 0 } : { scaleX: ctx.baseScale, opacity: ctx.baseOpacity },
          ease,
        ),
      );
      kfs.push(
        kf(
          `${idBase}-1`,
          t1,
          isIn ? { scaleX: ctx.baseScale, opacity: ctx.baseOpacity } : { scaleX: 1.6, opacity: 0 },
          ease,
        ),
      );
      return;
    case "blur":
      // CSS `filter` isn't in SUPPORTED_PROPS, so go via the tween channel.
      // For the entrance, opacity also fades in; for the exit, both blur out.
      tweens.push({
        id: `${idBase}-blur-from`,
        targetSelector: `#${ctx.elementId}`,
        method: "set",
        position: t0,
        properties: {
          filter: isIn ? "blur(18px)" : "blur(0px)",
          opacity: isIn ? 0 : ctx.baseOpacity,
        },
      });
      tweens.push({
        id: `${idBase}-blur-to`,
        targetSelector: `#${ctx.elementId}`,
        method: "to",
        position: t0,
        duration: t1 - t0,
        ease,
        properties: {
          filter: isIn ? "blur(0px)" : "blur(18px)",
          opacity: isIn ? ctx.baseOpacity : 0,
        },
      });
      return;
    case "wipeLeft":
      wipe(tweens, ctx, idBase, t0, t1, isIn, "left", ease);
      return;
    case "wipeRight":
      wipe(tweens, ctx, idBase, t0, t1, isIn, "right", ease);
      return;
    case "wipeUp":
      wipe(tweens, ctx, idBase, t0, t1, isIn, "up", ease);
      return;
    case "wipeDown":
      wipe(tweens, ctx, idBase, t0, t1, isIn, "down", ease);
      return;
    case "typewriter":
      // We can't truly per-character without DOM split. Best-effort: a
      // linear clip-path wipe driven over the duration so the operator
      // sees a strong "reveal" feel.
      wipe(tweens, ctx, idBase, t0, t1, isIn, "left", "none");
      return;
    case "glitch":
      glitch(tweens, ctx, idBase, t0, t1, isIn);
      return;
    case "none":
    default:
      return;
  }
}

function slide(
  kfs: Keyframe[],
  ctx: PresetContext,
  idBase: string,
  t0: number,
  t1: number,
  isIn: boolean,
  dx: number,
  dy: number,
  ease: string,
): void {
  kfs.push(
    kf(
      `${idBase}-0`,
      t0,
      isIn
        ? { x: ctx.baseX + dx, y: ctx.baseY + dy, opacity: 0 }
        : { x: ctx.baseX, y: ctx.baseY, opacity: ctx.baseOpacity },
      ease,
    ),
  );
  kfs.push(
    kf(
      `${idBase}-1`,
      t1,
      isIn
        ? { x: ctx.baseX, y: ctx.baseY, opacity: ctx.baseOpacity }
        : { x: ctx.baseX - dx, y: ctx.baseY - dy, opacity: 0 },
      ease,
    ),
  );
}

function wipe(
  tweens: GsapAnimation[],
  ctx: PresetContext,
  idBase: string,
  t0: number,
  t1: number,
  isIn: boolean,
  dir: "left" | "right" | "up" | "down",
  ease: string,
): void {
  // CSS clip-path inset(top right bottom left). Reveal direction = which
  // side starts at 0% inset and ends at 100% (or vice versa for exit).
  const closed = {
    left: "inset(0 100% 0 0)",
    right: "inset(0 0 0 100%)",
    up: "inset(100% 0 0 0)",
    down: "inset(0 0 100% 0)",
  }[dir];
  const open = "inset(0 0 0 0)";
  tweens.push({
    id: `${idBase}-wipe-from`,
    targetSelector: `#${ctx.elementId}`,
    method: "set",
    position: t0,
    properties: {
      clipPath: isIn ? closed : open,
      opacity: ctx.baseOpacity,
    },
  });
  tweens.push({
    id: `${idBase}-wipe-to`,
    targetSelector: `#${ctx.elementId}`,
    method: "to",
    position: t0,
    duration: Math.max(0.001, t1 - t0),
    ease,
    properties: {
      clipPath: isIn ? open : closed,
    },
  });
}

function glitch(
  tweens: GsapAnimation[],
  ctx: PresetContext,
  idBase: string,
  t0: number,
  t1: number,
  isIn: boolean,
): void {
  // RGB-split via CSS drop-shadow + a quick scramble on x. Three pulses
  // across the duration produce the "cyberpunk burst" feel.
  const dur = Math.max(0.05, t1 - t0);
  const step = dur / 3;
  for (let i = 0; i < 3; i++) {
    const ti = t0 + step * i;
    const tn = t0 + step * (i + 1);
    const offset = (3 - i) * 8 * (isIn ? 1 : -1);
    tweens.push({
      id: `${idBase}-glitch-${i}-set`,
      targetSelector: `#${ctx.elementId}`,
      method: "set",
      position: ti,
      properties: {
        x: ctx.baseX + offset,
        opacity: isIn ? (i === 0 ? 0.2 : 0.6 + i * 0.2) : 1 - i * 0.3,
        filter: `drop-shadow(${offset}px 0 0 #ff003c) drop-shadow(${-offset}px 0 0 #00d3ff)`,
      },
    });
    tweens.push({
      id: `${idBase}-glitch-${i}-to`,
      targetSelector: `#${ctx.elementId}`,
      method: "to",
      position: ti,
      duration: tn - ti,
      ease: "steps(2)",
      properties: {
        x: ctx.baseX - offset * 0.5,
        opacity: isIn ? Math.min(1, 0.4 + i * 0.3) : Math.max(0, 0.7 - i * 0.35),
      },
    });
  }
  // Snap to resting state at the end of the glitch.
  tweens.push({
    id: `${idBase}-glitch-end`,
    targetSelector: `#${ctx.elementId}`,
    method: "set",
    position: t1,
    properties: {
      x: ctx.baseX,
      opacity: isIn ? ctx.baseOpacity : 0,
      filter: "none",
    },
  });
}

// ── emphasis loops ────────────────────────────────────────────────────

function addEmphasis(
  kfs: Keyframe[],
  tweens: GsapAnimation[],
  ctx: PresetContext,
  kind: ElementEmphasisKind,
  cycleSec: number,
  intensity: number,
  tStart: number,
  tEnd: number,
): void {
  const total = tEnd - tStart;
  if (total <= 0) return;
  const cycles = Math.max(1, Math.floor(total / cycleSec));
  const idBase = `${ctx.elementId}-emp`;

  switch (kind) {
    case "pulse": {
      // scale 1 → 1+0.06*intensity → 1, repeating per cycle.
      const peak = ctx.baseScale * (1 + 0.06 * intensity);
      for (let i = 0; i < cycles; i++) {
        const t = tStart + i * cycleSec;
        kfs.push(kf(`${idBase}-pulse-${i}-a`, t, { scale: ctx.baseScale }, "power2.inOut"));
        kfs.push(kf(`${idBase}-pulse-${i}-b`, t + cycleSec * 0.5, { scale: peak }, "power2.inOut"));
      }
      kfs.push(kf(`${idBase}-pulse-end`, tEnd, { scale: ctx.baseScale }, "power2.inOut"));
      return;
    }
    case "wiggle": {
      const amp = 4 * intensity;
      for (let i = 0; i < cycles; i++) {
        const t = tStart + i * cycleSec;
        kfs.push(kf(`${idBase}-wig-${i}-0`, t, { rotation: -amp }, "power1.inOut"));
        kfs.push(kf(`${idBase}-wig-${i}-1`, t + cycleSec * 0.5, { rotation: amp }, "power1.inOut"));
      }
      kfs.push(kf(`${idBase}-wig-end`, tEnd, { rotation: 0 }, "power1.inOut"));
      return;
    }
    case "float": {
      const amp = ctx.canvasH * 0.012 * intensity;
      for (let i = 0; i < cycles; i++) {
        const t = tStart + i * cycleSec;
        kfs.push(kf(`${idBase}-flt-${i}-0`, t, { y: ctx.baseY }, "power2.inOut"));
        kfs.push(
          kf(`${idBase}-flt-${i}-1`, t + cycleSec * 0.5, { y: ctx.baseY - amp }, "power2.inOut"),
        );
      }
      kfs.push(kf(`${idBase}-flt-end`, tEnd, { y: ctx.baseY }, "power2.inOut"));
      return;
    }
    case "shake": {
      // 4 micro-shakes per cycle.
      const amp = 6 * intensity;
      for (let i = 0; i < cycles; i++) {
        const t = tStart + i * cycleSec;
        const q = cycleSec / 4;
        kfs.push(kf(`${idBase}-shk-${i}-0`, t, { x: ctx.baseX }, "none"));
        kfs.push(kf(`${idBase}-shk-${i}-1`, t + q, { x: ctx.baseX + amp }, "none"));
        kfs.push(kf(`${idBase}-shk-${i}-2`, t + q * 2, { x: ctx.baseX - amp }, "none"));
        kfs.push(kf(`${idBase}-shk-${i}-3`, t + q * 3, { x: ctx.baseX + amp * 0.5 }, "none"));
      }
      kfs.push(kf(`${idBase}-shk-end`, tEnd, { x: ctx.baseX }, "none"));
      return;
    }
    case "bounce": {
      const amp = ctx.canvasH * 0.025 * intensity;
      for (let i = 0; i < cycles; i++) {
        const t = tStart + i * cycleSec;
        kfs.push(kf(`${idBase}-bnc-${i}-0`, t, { y: ctx.baseY }, "power2.out"));
        kfs.push(
          kf(`${idBase}-bnc-${i}-1`, t + cycleSec * 0.4, { y: ctx.baseY - amp }, "power2.in"),
        );
        kfs.push(
          kf(
            `${idBase}-bnc-${i}-2`,
            t + cycleSec * 0.7,
            { y: ctx.baseY - amp * 0.3 },
            "power2.out",
          ),
        );
      }
      kfs.push(kf(`${idBase}-bnc-end`, tEnd, { y: ctx.baseY }, "power2.out"));
      return;
    }
    case "shimmer": {
      // Filter-based highlight sweep — emit a tween per cycle.
      for (let i = 0; i < cycles; i++) {
        const t = tStart + i * cycleSec;
        tweens.push({
          id: `${idBase}-shm-${i}-set`,
          targetSelector: `#${ctx.elementId}`,
          method: "set",
          position: t,
          properties: { filter: "brightness(1)" },
        });
        tweens.push({
          id: `${idBase}-shm-${i}-peak`,
          targetSelector: `#${ctx.elementId}`,
          method: "to",
          position: t + cycleSec * 0.25,
          duration: cycleSec * 0.5,
          ease: "power1.inOut",
          properties: { filter: `brightness(${1 + 0.35 * intensity})` },
        });
        tweens.push({
          id: `${idBase}-shm-${i}-rest`,
          targetSelector: `#${ctx.elementId}`,
          method: "to",
          position: t + cycleSec * 0.75,
          duration: cycleSec * 0.25,
          ease: "power1.inOut",
          properties: { filter: "brightness(1)" },
        });
      }
      return;
    }
    case "spin": {
      // Continuous slow rotation across the whole emphasis window.
      kfs.push(kf(`${idBase}-spn-0`, tStart, { rotation: 0 }, "none"));
      kfs.push(kf(`${idBase}-spn-1`, tEnd, { rotation: 360 * intensity }, "none"));
      return;
    }
    case "breathe": {
      const peak = ctx.baseScale * (1 + 0.04 * intensity);
      for (let i = 0; i < cycles; i++) {
        const t = tStart + i * cycleSec;
        kfs.push(kf(`${idBase}-brh-${i}-a`, t, { scale: ctx.baseScale }, "power2.inOut"));
        kfs.push(kf(`${idBase}-brh-${i}-b`, t + cycleSec * 0.5, { scale: peak }, "power2.inOut"));
      }
      kfs.push(kf(`${idBase}-brh-end`, tEnd, { scale: ctx.baseScale }, "power2.inOut"));
      return;
    }
    case "kenBurns": {
      // Slow drift + scale across the whole present window. Direction is
      // deterministically picked from the element id so multiple clips
      // get different drifts (instead of every clip drifting the same
      // way and looking obviously templated).
      const seed = hashSeed(ctx.elementId);
      const dx = (seed & 1 ? 1 : -1) * ctx.canvasW * 0.04 * intensity;
      const dy = (seed & 2 ? 1 : -1) * ctx.canvasH * 0.03 * intensity;
      const ds = ctx.baseScale * (1 + 0.08 * intensity);
      kfs.push(
        kf(
          `${idBase}-kb-0`,
          tStart,
          { x: ctx.baseX, y: ctx.baseY, scale: ctx.baseScale },
          "power1.inOut",
        ),
      );
      kfs.push(
        kf(
          `${idBase}-kb-1`,
          tEnd,
          { x: ctx.baseX + dx, y: ctx.baseY + dy, scale: ds },
          "power1.inOut",
        ),
      );
      return;
    }
    case "none":
    default:
      return;
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function kf(id: string, time: number, properties: Record<string, number>, ease: string): Keyframe {
  return { id, time, properties, ease };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// Re-export the empty sentinel for callers that want to short-circuit.
export const EMPTY_PRESET_OUTPUT = EMPTY;

// ── Transition side-effects ─────────────────────────────────────────
//
// `applyTransitionSide` is called twice per transition — once for the
// outgoing clip (`side: "out"`) and once for the incoming (`side: "in"`).
// Both share the same `centerTime` (the cut point) and `durationSec`.
// We emit `GsapAnimation[]` rather than keyframes so the effect can
// reach CSS props outside the GSAP-supported keyframe vocabulary
// (clipPath, filter, mix-blend-mode, etc.) for the wipe/glitch/blur
// variants.

import type { TransitionKind } from "./transitions.js";

export function applyTransitionSide(opts: {
  elementId: string;
  side: "in" | "out";
  kind: TransitionKind;
  centerTime: number;
  durationSec: number;
  ease?: string;
}): GsapAnimation[] {
  const { elementId, side, kind, centerTime, durationSec, ease } = opts;
  const isIn = side === "in";
  const t0 = centerTime - durationSec / 2;
  const dur = durationSec;
  const e = ease ?? "power2.inOut";
  const sel = `#${elementId}`;
  const tw: GsapAnimation[] = [];

  switch (kind) {
    case "crossDissolve":
      tw.push({
        id: `${elementId}-tr-${side}-set`,
        targetSelector: sel,
        method: "set",
        position: t0,
        properties: { opacity: isIn ? 0 : 1 },
      });
      tw.push({
        id: `${elementId}-tr-${side}-to`,
        targetSelector: sel,
        method: "to",
        position: t0,
        duration: dur,
        ease: e,
        properties: { opacity: isIn ? 1 : 0 },
      });
      return tw;

    case "wipeLeft":
    case "wipeRight":
    case "wipeUp":
    case "wipeDown": {
      const closed = {
        wipeLeft: "inset(0 100% 0 0)",
        wipeRight: "inset(0 0 0 100%)",
        wipeUp: "inset(100% 0 0 0)",
        wipeDown: "inset(0 0 100% 0)",
      }[kind];
      tw.push({
        id: `${elementId}-tr-${side}-set`,
        targetSelector: sel,
        method: "set",
        position: t0,
        properties: { clipPath: isIn ? closed : "inset(0 0 0 0)", opacity: 1 },
      });
      tw.push({
        id: `${elementId}-tr-${side}-to`,
        targetSelector: sel,
        method: "to",
        position: t0,
        duration: dur,
        ease: e,
        properties: { clipPath: isIn ? "inset(0 0 0 0)" : closed },
      });
      return tw;
    }

    case "zoomBlur":
      tw.push({
        id: `${elementId}-tr-${side}-set`,
        targetSelector: sel,
        method: "set",
        position: t0,
        properties: {
          opacity: isIn ? 0 : 1,
          filter: isIn ? "blur(24px)" : "blur(0px)",
          scale: isIn ? 1.18 : 1,
        },
      });
      tw.push({
        id: `${elementId}-tr-${side}-to`,
        targetSelector: sel,
        method: "to",
        position: t0,
        duration: dur,
        ease: e,
        properties: {
          opacity: isIn ? 1 : 0,
          filter: isIn ? "blur(0px)" : "blur(24px)",
          scale: isIn ? 1 : 1.18,
        },
      });
      return tw;

    case "glitch": {
      const steps = 4;
      const stepDur = dur / steps;
      for (let i = 0; i < steps; i++) {
        const ti = t0 + i * stepDur;
        const off = (steps - i) * 6 * (isIn ? 1 : -1);
        tw.push({
          id: `${elementId}-tr-${side}-${i}`,
          targetSelector: sel,
          method: "set",
          position: ti,
          properties: {
            x: off,
            opacity: isIn ? 0.3 + i * 0.2 : 1 - i * 0.25,
            filter: `drop-shadow(${off}px 0 0 #ff003c) drop-shadow(${-off}px 0 0 #00d3ff)`,
          },
        });
      }
      tw.push({
        id: `${elementId}-tr-${side}-end`,
        targetSelector: sel,
        method: "set",
        position: t0 + dur,
        properties: {
          x: 0,
          opacity: isIn ? 1 : 0,
          filter: "none",
        },
      });
      return tw;
    }

    case "slideLeft":
    case "slideRight": {
      const dir = kind === "slideLeft" ? -1 : 1;
      tw.push({
        id: `${elementId}-tr-${side}-set`,
        targetSelector: sel,
        method: "set",
        position: t0,
        properties: {
          x: isIn ? dir * 200 : 0,
          opacity: 1,
        },
      });
      tw.push({
        id: `${elementId}-tr-${side}-to`,
        targetSelector: sel,
        method: "to",
        position: t0,
        duration: dur,
        ease: e,
        properties: {
          x: isIn ? 0 : -dir * 200,
          opacity: isIn ? 1 : 0,
        },
      });
      return tw;
    }

    case "fadeBlack":
    case "fadeWhite": {
      // The colored midpoint is approximated via a CSS `background-color`
      // tween on the element. Real implementations would composite a
      // full-stage rect; this is the inline-friendly approximation.
      const tint = kind === "fadeBlack" ? "#000" : "#fff";
      tw.push({
        id: `${elementId}-tr-${side}-set`,
        targetSelector: sel,
        method: "set",
        position: t0,
        properties: { opacity: isIn ? 0 : 1, backgroundColor: tint },
      });
      tw.push({
        id: `${elementId}-tr-${side}-to`,
        targetSelector: sel,
        method: "to",
        position: t0,
        duration: dur,
        ease: e,
        properties: { opacity: isIn ? 1 : 0 },
      });
      return tw;
    }

    default:
      return tw;
  }
}
