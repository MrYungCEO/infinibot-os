/**
 * Floating Agent Card — shared free-floating card treatment for the agent
 * world-map HUD sections ("Active Agents" breakdown + "Recently Completed"
 * pinboard).
 *
 * The world-map sections used to live inside boxed `.hud-overlay` panels. This
 * module replaces that chrome with cards that stand on their own over the Pixi
 * canvas: glassmorphic surface (backdrop blur + faint gold-tinted glass), a
 * hairline border, soft hover glow, a black + gold (#d4af37) accent for the
 * active/highlight state, and a very soft idle "bob" so they feel alive.
 *
 * It also exports `ZoomFadeController` — when the world map is zoomed in past a
 * threshold the floating cards fade out (opacity 0 + pointer-events:none) so
 * they stop fighting the canvas, then fade back in when zoomed out. The scale
 * is read live off the host `<agency-world-viz>` engine's Pixi viewport, so the
 * sections stay decoupled from the engine wiring.
 *
 * Consumed (as a plain `<style>` string + a controller instance) by both
 * `world-map-active-breakdown.ts` and `world-map-pinboard.ts`.
 */

/**
 * Card + free-floating root styles. Scoped under `.fac-floating-root` /
 * `.fac-card` so it never collides with the shared `.hud-overlay` treatment
 * still used by the credit-usage overlay.
 */
export const FLOATING_AGENT_CARD_CSS = `
@keyframes fac-bob {
  0%   { transform: translateY(0); }
  50%  { transform: translateY(-2px); }
  100% { transform: translateY(0); }
}
@keyframes fac-card-in {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* The overlay root floats freely over the canvas — no panel box, no chrome.
   It fades out under zoom via the .fac-faded toggle. */
.fac-floating-root {
  transition: opacity 0.2s ease;
}
.fac-floating-root.fac-faded {
  opacity: 0;
  pointer-events: none;
}

/* Section eyebrow — gold, free-standing (no enclosing bar). */
.fac-eyebrow {
  color: var(--gx-gold-lt, #e9c46a);
  text-transform: uppercase;
  letter-spacing: 0.32em;
  font-size: 10.5px;
  font-weight: 700;
  white-space: nowrap;
  text-shadow: 0 1px 6px rgba(0,0,0,0.7), 0 0 14px var(--gx-gold-15, rgba(212,175,55,0.25));
}

/* Free-floating glass card. */
.fac-card {
  position: relative;
  background:
    linear-gradient(
      150deg,
      color-mix(in srgb, var(--gx-gold, #d4af37) 7%, rgba(8,6,16,0.62)) 0%,
      rgba(6,4,14,0.58) 100%
    );
  border: 1px solid var(--gx-gold-15, rgba(212,175,55,0.16));
  border-radius: 12px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.05),
    0 10px 28px rgba(0,0,0,0.45);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
  animation: fac-card-in 0.4s ease-out both, fac-bob 5.5s ease-in-out infinite;
  will-change: transform;
}
/* Stagger the bob so the column breathes, not pulses in unison. */
.fac-card:nth-child(2n)   { animation-duration: 0.4s, 6.2s; animation-delay: 0s, -1.4s; }
.fac-card:nth-child(3n)   { animation-duration: 0.4s, 5.0s; animation-delay: 0s, -2.6s; }
.fac-card:nth-child(4n)   { animation-duration: 0.4s, 6.6s; animation-delay: 0s, -0.8s; }

.fac-card:hover {
  border-color: var(--gx-gold-50, rgba(212,175,55,0.55));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),
    0 12px 34px rgba(0,0,0,0.55),
    0 0 22px var(--gx-gold-30, rgba(212,175,55,0.30));
  background:
    linear-gradient(
      150deg,
      color-mix(in srgb, var(--gx-gold, #d4af37) 12%, rgba(8,6,16,0.66)) 0%,
      rgba(6,4,14,0.6) 100%
    );
}

/* Active / highlight — gold left accent + rim. */
.fac-card--active {
  border-left: 2px solid var(--gx-gold, #d4af37);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.06),
    0 10px 28px rgba(0,0,0,0.45),
    0 0 16px var(--gx-gold-15, rgba(212,175,55,0.22));
}

@media (prefers-reduced-motion: reduce) {
  .fac-card { animation: fac-card-in 0.4s ease-out both; }
  .fac-floating-root { transition: none; }
}
`;

export interface ZoomFadeOptions {
  /** Fade the cards OUT once the world scale rises above this. */
  fadeOutAbove?: number;
  /** Fade the cards back IN once the world scale drops below this. */
  fadeInBelow?: number;
  /** CSS class toggled on the root when faded out. */
  fadedClass?: string;
  /** Optional probe — receives the live scale every poll (debug/tuning). */
  onScale?: (scale: number) => void;
}

/**
 * Watches the host world-map engine's Pixi viewport scale and toggles a
 * `fac-faded` class on the given root element with hysteresis so it never
 * flickers at the threshold boundary.
 *
 * Decoupled from the engine wiring: it walks from the overlay root up to the
 * enclosing `<agency-world-viz>` shadow host and reads the live scale off its
 * engine's viewport. If that path can't be resolved (engine not mounted yet)
 * it simply does nothing that frame and retries on the next poll.
 */
export class ZoomFadeController {
  private readonly root: HTMLElement;
  private readonly fadeOutAbove: number;
  private readonly fadeInBelow: number;
  private readonly fadedClass: string;
  private readonly onScale?: (scale: number) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private faded = false;
  private cachedViz: any = null;

  constructor(root: HTMLElement, opts: ZoomFadeOptions = {}) {
    this.root = root;
    this.fadeOutAbove = opts.fadeOutAbove ?? 1.3;
    this.fadeInBelow = opts.fadeInBelow ?? 1.15;
    this.fadedClass = opts.fadedClass ?? "fac-faded";
    this.onScale = opts.onScale;
  }

  start(): void {
    if (this.timer != null) return;
    // ~6.7 fps poll is plenty for a fade decision and costs nothing.
    this.timer = setInterval(() => this.tick(), 150);
    this.tick();
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Resolve the enclosing <agency-world-viz> element (cached once mounted). */
  private resolveViz(): any {
    if (this.cachedViz) return this.cachedViz;
    const rootNode = this.root.getRootNode?.();
    const host =
      rootNode && rootNode instanceof ShadowRoot ? (rootNode.host as any) : null;
    if (host && (host as any).tagName?.toLowerCase() === "agency-world-viz") {
      this.cachedViz = host;
    }
    return this.cachedViz;
  }

  private currentScale(): number | null {
    const viz = this.resolveViz();
    const scale = viz?.engine?.getViewport?.()?.scale?.x;
    return typeof scale === "number" && isFinite(scale) ? scale : null;
  }

  private tick(): void {
    const scale = this.currentScale();
    if (scale == null) return;
    this.onScale?.(scale);
    this.root.setAttribute("data-world-scale", scale.toFixed(3));
    if (!this.faded && scale > this.fadeOutAbove) {
      this.faded = true;
      this.root.classList.add(this.fadedClass);
    } else if (this.faded && scale < this.fadeInBelow) {
      this.faded = false;
      this.root.classList.remove(this.fadedClass);
    }
  }
}
