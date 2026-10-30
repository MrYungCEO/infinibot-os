/**
 * Web Animations API choreography for each emote type.
 *
 * Motion lives here (not inside the SVGs) so the layer can honour
 * `prefers-reduced-motion` from a single switch and reason about lifetimes for
 * the global concurrency cap. `play()` animates the wrapper + inner sprite parts
 * and returns the total lifetime in ms after which the emote should be removed.
 *
 * The wrapper element is transform-positioned by the layer every frame
 * (translate(x,y)); to avoid fighting that, per-emote motion is expressed via a
 * dedicated inner `.fx` element and the sprite's own sub-parts, never the
 * wrapper's transform.
 */

import type { EmoteType } from "./types.js";

const EASE_OUT = "cubic-bezier(.16,.84,.44,1)";
const EASE_POP = "cubic-bezier(.34,1.56,.64,1)";

type Lifetime = number;

interface Ctx {
  /** Inner motion element (the layer transforms the wrapper, not this). */
  fx: HTMLElement;
  /** The <svg> root, for targeting sub-parts. */
  svg: SVGElement;
  reduced: boolean;
}

function q<T extends Element = Element>(svg: SVGElement, sel: string): T | null {
  return svg.querySelector(sel) as T | null;
}

/** Play the choreography for `type`. Returns lifetime (ms) before removal. */
export function play(type: EmoteType, ctx: Ctx): Lifetime {
  if (ctx.reduced) return playReduced(type, ctx);
  switch (type) {
    case "success":
      return playSuccess(ctx);
    case "fail":
      return playFail(ctx);
    case "blocked":
      return playBlocked(ctx);
    case "shipping":
      return playShipping(ctx);
    case "spawn":
      return playSpawn(ctx);
    case "levelup":
      return playLevelup(ctx);
    case "thinking":
      return playThinking(ctx);
    default:
      return playSuccess(ctx);
  }
}

/** Reduced-motion: static fade in/out, no transforms, no loops. */
function playReduced(type: EmoteType, { fx }: Ctx): Lifetime {
  const hold = type === "thinking" ? 1600 : 1100;
  fx.animate(
    [
      { opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { opacity: 1, offset: 0.8 },
      { opacity: 0 },
    ],
    { duration: hold, easing: "linear", fill: "forwards" },
  );
  return hold + 40;
}

function playSuccess({ fx, svg }: Ctx): Lifetime {
  fx.animate(
    [
      { transform: "translateY(0) scale(.3)", opacity: 0 },
      { transform: "translateY(-2px) scale(1.12)", opacity: 1, offset: 0.35 },
      { transform: "translateY(-10px) scale(1)", opacity: 1, offset: 0.65 },
      { transform: "translateY(-24px) scale(.96)", opacity: 0 },
    ],
    { duration: 1050, easing: EASE_POP, fill: "forwards" },
  );
  q(svg, "[data-burst]")?.animate(
    [
      { transform: "scale(.4)", opacity: 0, transformOrigin: "24px 24px" },
      { transform: "scale(1.05)", opacity: 1, offset: 0.4, transformOrigin: "24px 24px" },
      { transform: "scale(1.35)", opacity: 0, transformOrigin: "24px 24px" },
    ],
    { duration: 520, easing: EASE_OUT, fill: "forwards" },
  );
  return 1090;
}

function playFail({ fx, svg }: Ctx): Lifetime {
  fx.animate(
    [
      { transform: "translate(0,0) scale(.5)", opacity: 0 },
      { transform: "translate(0,-4px) scale(1.08)", opacity: 1, offset: 0.2 },
      { transform: "translate(-4px,-6px)", offset: 0.34 },
      { transform: "translate(4px,-6px)", offset: 0.46 },
      { transform: "translate(-3px,-8px)", offset: 0.58 },
      { transform: "translate(2px,-10px)", offset: 0.7 },
      { transform: "translate(0,-20px) scale(.95)", opacity: 0 },
    ],
    { duration: 900, easing: EASE_OUT, fill: "forwards" },
  );
  q(svg, "[data-crack]")?.animate(
    [
      { opacity: 0 },
      { opacity: 0, offset: 0.3 },
      { opacity: 0.95, offset: 0.5 },
      { opacity: 0.95 },
    ],
    { duration: 700, fill: "forwards" },
  );
  return 940;
}

function playBlocked({ fx, svg }: Ctx): Lifetime {
  fx.animate(
    [
      { transform: "translateY(0) scale(.5)", opacity: 0 },
      { transform: "translateY(-8px) scale(1)", opacity: 1, offset: 0.25 },
      { transform: "translateY(-10px) scale(1)", opacity: 1, offset: 0.8 },
      { transform: "translateY(-16px) scale(.97)", opacity: 0 },
    ],
    { duration: 1300, easing: EASE_OUT, fill: "forwards" },
  );
  q(svg, "[data-pulse]")?.animate(
    [
      { transform: "scale(.7)", opacity: 0.7, transformOrigin: "24px 24px" },
      { transform: "scale(1.25)", opacity: 0, transformOrigin: "24px 24px" },
      { transform: "scale(.7)", opacity: 0.7, transformOrigin: "24px 24px" },
    ],
    { duration: 760, iterations: 2, easing: "ease-in-out" },
  );
  return 1340;
}

function playShipping({ fx, svg }: Ctx): Lifetime {
  fx.animate(
    [
      { transform: "translateY(6px) scale(.55)", opacity: 0 },
      { transform: "translateY(-6px) scale(1.05)", opacity: 1, offset: 0.3 },
      { transform: "translateY(-44px) scale(1)", opacity: 1, offset: 0.75 },
      { transform: "translateY(-72px) scale(.9)", opacity: 0 },
    ],
    { duration: 1150, easing: EASE_OUT, fill: "forwards" },
  );
  q(svg, "[data-trail]")?.animate(
    [
      { opacity: 0.2, transform: "scaleY(.6)", transformOrigin: "24px 34px" },
      { opacity: 0.9, transform: "scaleY(1.4)", transformOrigin: "24px 34px" },
      { opacity: 0, transform: "scaleY(1.8)", transformOrigin: "24px 34px" },
    ],
    { duration: 600, iterations: 2, easing: "ease-out" },
  );
  return 1190;
}

function playSpawn({ fx, svg }: Ctx): Lifetime {
  fx.animate(
    [
      { transform: "scale(.2) rotate(-30deg)", opacity: 0 },
      { transform: "scale(1.1) rotate(0deg)", opacity: 1, offset: 0.4 },
      { transform: "scale(1) rotate(0deg)", opacity: 1, offset: 0.75 },
      { transform: "scale(1.05) rotate(8deg)", opacity: 0 },
    ],
    { duration: 1000, easing: EASE_POP, fill: "forwards" },
  );
  q(svg, "[data-spark]")?.animate(
    [
      { transform: "scale(.3) rotate(0)", opacity: 0, transformOrigin: "24px 24px" },
      { transform: "scale(1.15) rotate(45deg)", opacity: 1, offset: 0.5, transformOrigin: "24px 24px" },
      { transform: "scale(1) rotate(90deg)", opacity: 1, transformOrigin: "24px 24px" },
    ],
    { duration: 560, easing: EASE_OUT, fill: "forwards" },
  );
  q(svg, "[data-sparkmini]")?.animate(
    [
      { opacity: 0, transform: "scale(.2)", transformOrigin: "24px 24px" },
      { opacity: 1, transform: "scale(1.2)", offset: 0.6, transformOrigin: "24px 24px" },
      { opacity: 0, transform: "scale(.6)", transformOrigin: "24px 24px" },
    ],
    { duration: 700, easing: EASE_OUT, fill: "forwards" },
  );
  return 1040;
}

function playLevelup({ fx, svg }: Ctx): Lifetime {
  fx.animate(
    [
      { transform: "translateY(6px) scale(.6)", opacity: 0 },
      { transform: "translateY(-6px) scale(1)", opacity: 1, offset: 0.3 },
      { transform: "translateY(-22px) scale(1)", opacity: 1, offset: 0.78 },
      { transform: "translateY(-40px) scale(.92)", opacity: 0 },
    ],
    { duration: 1150, easing: EASE_OUT, fill: "forwards" },
  );
  const rise = (sel: string, delay: number) =>
    q(svg, sel)?.animate(
      [
        { transform: "translateY(10px)", opacity: 0 },
        { transform: "translateY(0)", opacity: 1, offset: 0.5 },
        { transform: "translateY(-6px)", opacity: 0 },
      ],
      { duration: 700, delay, easing: EASE_OUT, fill: "both" },
    );
  rise("[data-chev1]", 0);
  rise("[data-chev2]", 110);
  rise("[data-chev3]", 220);
  return 1190;
}

function playThinking({ fx, svg }: Ctx): Lifetime {
  fx.animate(
    [
      { transform: "translateY(6px) scale(.6)", opacity: 0 },
      { transform: "translateY(0) scale(1)", opacity: 1, offset: 0.15 },
      { transform: "translateY(-2px) scale(1)", opacity: 1, offset: 0.85 },
      { transform: "translateY(-6px) scale(.96)", opacity: 0 },
    ],
    { duration: 1800, easing: EASE_OUT, fill: "forwards" },
  );
  const bounce = (sel: string, delay: number) =>
    q(svg, sel)?.animate(
      [
        { transform: "translateY(0)", opacity: 0.45 },
        { transform: "translateY(-3px)", opacity: 1, offset: 0.5 },
        { transform: "translateY(0)", opacity: 0.45 },
      ],
      { duration: 560, delay, iterations: 3, easing: "ease-in-out" },
    );
  bounce("[data-dot1]", 0);
  bounce("[data-dot2]", 140);
  bounce("[data-dot3]", 280);
  return 1840;
}
