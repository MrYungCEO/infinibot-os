/**
 * proactive-media/animations.ts — per-element entrance + emphasis presets.
 *
 * Every preset is built on the **Web Animations API** (not CSS keyframes) on
 * purpose: the returned `Animation` handle is pausable and seekable, so the
 * live interact channel (`timeline.pause` / `timeline.play` / `timeline.seek`,
 * `element.cue` / `element.hold`) can drive an in-flight reveal frame-by-frame
 * in sync with Kokoro TTS instead of fire-and-forget CSS.
 *
 * Design language: motion stays subtle and premium — transform / opacity /
 * clip-path / gold drop-shadow only (cheap, GPU-friendly). No layout-thrashing
 * properties. Gold is used for the emphasis glow only, never as a fill.
 *
 * Each preset honours `prefers-reduced-motion`: it collapses to a ~1ms snap so
 * the element still lands in its final state without motion.
 */

/** Gold used for emphasis glows (matches --gold-1 token fallback). */
const GOLD = "#d4af37";

/** True when the user asked the OS to minimize motion. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Shared base options; callers override duration / delay per preset. */
export interface PresetOptions {
  /** Animation duration in ms. */
  durationMs?: number;
  /** Start delay in ms. */
  delayMs?: number;
  /** Override the easing curve. */
  easing?: string;
  /** Start paused (so the interact channel can drive currentTime). */
  paused?: boolean;
}

const EASE_OUT = "cubic-bezier(0.2, 0.7, 0.2, 1)";

/**
 * Run a WAAPI keyframe set against `el`, honouring reduced-motion (snap to the
 * last keyframe) and the `paused` flag. Always returns the live `Animation` so
 * the caller can pause / seek / cancel it.
 */
function run(
  el: Element,
  keyframes: Keyframe[],
  opts: PresetOptions & { duration: number; easing: string },
): Animation {
  const reduced = prefersReducedMotion();
  const anim = el.animate(keyframes, {
    duration: reduced ? 1 : opts.duration,
    delay: reduced ? 0 : opts.delayMs ?? 0,
    easing: opts.easing,
    fill: "both",
  });
  if (opts.paused) anim.pause();
  return anim;
}

// ── slideGlow ────────────────────────────────────────────────────────────────
/**
 * Heading entrance: rises + fades in while a gold drop-shadow blooms and
 * settles. The signature "this is the line being spoken" reveal.
 */
export function slideGlow(el: Element, opts: PresetOptions = {}): Animation {
  return run(
    el,
    [
      {
        opacity: 0,
        transform: "translateY(14px)",
        filter: `drop-shadow(0 0 0 transparent)`,
        offset: 0,
      },
      {
        opacity: 1,
        transform: "translateY(0)",
        filter: `drop-shadow(0 0 10px ${GOLD}cc)`,
        offset: 0.6,
      },
      {
        opacity: 1,
        transform: "translateY(0)",
        filter: `drop-shadow(0 0 2px ${GOLD}33)`,
        offset: 1,
      },
    ],
    { ...opts, duration: opts.durationMs ?? 620, easing: opts.easing ?? EASE_OUT },
  );
}

// ── stagger ──────────────────────────────────────────────────────────────────
/**
 * Reveal a list of elements (bullets, choices, steps) one after another with a
 * fixed inter-item delay. Returns one `Animation` per element so the interact
 * channel can target an individual item (e.g. `element.cue` re-pulses item N).
 */
export function stagger(
  els: Iterable<Element>,
  opts: PresetOptions & { stepMs?: number } = {},
): Animation[] {
  const list = Array.from(els);
  const step = opts.stepMs ?? 90;
  return list.map((el, i) =>
    run(
      el,
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        ...opts,
        delayMs: (opts.delayMs ?? 0) + i * step,
        duration: opts.durationMs ?? 380,
        easing: opts.easing ?? EASE_OUT,
      },
    ),
  );
}

// ── typeIn ───────────────────────────────────────────────────────────────────
/**
 * Code / monospace reveal that reads as a left-to-right "type-in" by wiping a
 * clip-path inset with a stepped timing function. Cheaper and more robust than
 * mutating text content, and fully seekable. Pair with {@link caretFor} for a
 * blinking cursor if desired.
 */
export function typeIn(el: Element, opts: PresetOptions = {}): Animation {
  const chars = (el.textContent ?? "").length || 40;
  // ~1 visual "step" per 2 characters, clamped to keep it lively.
  const steps = Math.max(8, Math.min(120, Math.round(chars / 2)));
  return run(
    el,
    [
      { clipPath: "inset(0 100% 0 0)", opacity: 0.85 },
      { clipPath: "inset(0 0 0 0)", opacity: 1 },
    ],
    {
      ...opts,
      duration: opts.durationMs ?? Math.max(420, Math.min(2200, chars * 14)),
      easing: opts.easing ?? `steps(${steps}, end)`,
    },
  );
}

// ── kenBurns ─────────────────────────────────────────────────────────────────
/**
 * Slow cinematic push-in on an image: a gentle scale + drift. Long duration,
 * runs once and holds on the final frame. Direction alternates by `seed` so a
 * deck of images doesn't all pan the same way.
 */
export function kenBurns(
  el: Element,
  opts: PresetOptions & { seed?: number } = {},
): Animation {
  const dir = (opts.seed ?? 0) % 2 === 0 ? 1 : -1;
  return run(
    el,
    [
      { transform: "scale(1.001) translate3d(0, 0, 0)" },
      { transform: `scale(1.08) translate3d(${dir * -2}%, -1.5%, 0)` },
    ],
    {
      ...opts,
      duration: opts.durationMs ?? 9000,
      easing: opts.easing ?? "ease-out",
    },
  );
}

// ── swipeReveal ──────────────────────────────────────────────────────────────
/**
 * Card-swap motion for decks / scene changes: the incoming surface slides in
 * from `from` ("right" default) while fading up. Use the same preset with
 * `from:"left"` for a back-navigation feel.
 */
export function swipeReveal(
  el: Element,
  opts: PresetOptions & { from?: "left" | "right" } = {},
): Animation {
  const dx = opts.from === "left" ? "-7%" : "7%";
  return run(
    el,
    [
      { opacity: 0, transform: `translateX(${dx}) scale(0.985)` },
      { opacity: 1, transform: "translateX(0) scale(1)" },
    ],
    { ...opts, duration: opts.durationMs ?? 460, easing: opts.easing ?? EASE_OUT },
  );
}

// ── pulse ────────────────────────────────────────────────────────────────────
/**
 * Attention pulse: a quick scale bump + gold glow, for the currently-spoken
 * element or an `element.cue` re-highlight. Set `count` for a finite ping or
 * `Infinity` for a steady breathing glow (remember to `.cancel()` it).
 */
export function pulse(
  el: Element,
  opts: PresetOptions & { count?: number } = {},
): Animation {
  const reduced = prefersReducedMotion();
  const anim = el.animate(
    [
      { transform: "scale(1)", filter: `drop-shadow(0 0 0 transparent)` },
      { transform: "scale(1.035)", filter: `drop-shadow(0 0 12px ${GOLD}aa)` },
      { transform: "scale(1)", filter: `drop-shadow(0 0 2px ${GOLD}22)` },
    ],
    {
      duration: reduced ? 1 : opts.durationMs ?? 760,
      delay: reduced ? 0 : opts.delayMs ?? 0,
      easing: opts.easing ?? "ease-in-out",
      iterations: reduced ? 1 : opts.count ?? 1,
      fill: "both",
    },
  );
  if (opts.paused) anim.pause();
  return anim;
}

// ── caret helper ─────────────────────────────────────────────────────────────
/**
 * A blinking caret animation for typeIn surfaces. Returns the `Animation` so it
 * can be cancelled when the type-in finishes.
 */
export function caretFor(el: Element): Animation {
  return el.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 900,
    iterations: Infinity,
    easing: "steps(2, end)",
  });
}

/** All presets keyed by name — used by element-type → preset routing in renderers. */
export const PRESETS = {
  slideGlow,
  stagger,
  typeIn,
  kenBurns,
  swipeReveal,
  pulse,
} as const;

export type PresetName = keyof typeof PRESETS;
