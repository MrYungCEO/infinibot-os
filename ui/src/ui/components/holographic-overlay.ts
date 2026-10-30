/**
 * Holographic Overlay — self-contained CRT/hologram post-FX layer.
 *
 * Drops a premium "holo-display" sheen ON TOP of any host element without
 * editing it: animated scanlines, faint chromatic aberration, edge bloom and
 * a low-opacity animated grain mask, washed with a subtle tint (gold default).
 *
 * It is intentionally additive — it mounts as an absolutely-positioned,
 * pointer-events:none, mix-blend-mode:screen sibling/child so the world viz
 * underneath is never touched. All animation is CSS transform/opacity only
 * (GPU compositor friendly); there is NO per-frame JS. `prefers-reduced-motion`
 * kills every animation automatically.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO MOUNT (one line)
 * ─────────────────────────────────────────────────────────────────────────
 * The overlay fills its nearest positioned ancestor. Place it as the LAST
 * child of the <agency-world-viz> host (or any wrapper that is
 * `position: relative`), e.g. inside the world-map band template:
 *
 *     <div class="world-map-band" style="position:relative">
 *       <agency-world-viz .client=${client}></agency-world-viz>
 *       <holographic-overlay intensity="0.5" tint="gold"></holographic-overlay>
 *     </div>
 *
 * Or imperatively (e.g. from a host that wants to self-mount it):
 *
 *     import "./holographic-overlay";
 *     const holo = document.createElement("holographic-overlay");
 *     holo.setAttribute("tint", "gold");
 *     hostBandEl.appendChild(holo);   // hostBandEl must be position:relative
 *     holo.setIntensity(0.5);
 *
 * The element does not need a `.client`, data, or any wiring — it is purely
 * decorative. Toggle strength at runtime with `el.setIntensity(0..1)`.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

export type HoloTint = "gold" | "cyan" | "amber";

const TINTS: Record<HoloTint, { wash: string; bloom: string; aberr: string }> = {
  // wash = subtle full-field color cast; bloom = edge glow color; aberr = chroma split hue.
  gold: { wash: "212, 175, 55", bloom: "255, 214, 120", aberr: "255, 196, 84" },
  cyan: { wash: "80, 210, 255", bloom: "120, 235, 255", aberr: "90, 220, 255" },
  amber: { wash: "255, 150, 60", bloom: "255, 180, 90", aberr: "255, 160, 70" },
};

@customElement("holographic-overlay")
export class HolographicOverlay extends LitElement {
  /** 0 = invisible, 1 = full strength. Default 0.5. */
  @property({ type: Number }) intensity = 0.5;
  /** Color family for wash / bloom / aberration. Default "gold". */
  @property({ type: String }) tint: HoloTint = "gold";

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      display: block;
      pointer-events: none;
      mix-blend-mode: screen;
      z-index: 6;
      /* Driven by setIntensity()/attribute — every layer scales off these. */
      --holo-i: 0.5;
      --holo-wash: 212, 175, 55;
      --holo-bloom: 255, 214, 120;
      --holo-aberr: 255, 196, 84;
      contain: strict;
      overflow: hidden;
      isolation: isolate;
    }

    /* Perf: freeze every layer's CSS animation while offscreen / tab hidden. */
    :host(.paused) .layer {
      animation-play-state: paused !important;
    }

    .layer {
      position: absolute;
      inset: 0;
      will-change: transform, opacity;
      backface-visibility: hidden;
    }

    /* ── Scanlines: 3px period phosphor lines, slow downward drift ──
       Drawn as faint BRIGHT lines (not dark) so the host's screen blend
       can lighten them onto the world — dark lines would vanish under screen. */
    .scanlines {
      background: repeating-linear-gradient(
        to bottom,
        rgba(var(--holo-bloom), 0.16) 0px,
        rgba(var(--holo-bloom), 0.16) 1px,
        rgba(255, 255, 255, 0) 1px,
        rgba(255, 255, 255, 0) 3px
      );
      opacity: calc(0.55 * var(--holo-i));
      animation: holo-scan 7.5s linear infinite;
    }
    /* A second, brighter "beam" sweeping slowly to sell the CRT refresh. */
    .beam {
      background: linear-gradient(
        to bottom,
        rgba(var(--holo-bloom), 0) 0%,
        rgba(var(--holo-bloom), 0.06) 48%,
        rgba(var(--holo-bloom), 0.12) 50%,
        rgba(var(--holo-bloom), 0.06) 52%,
        rgba(var(--holo-bloom), 0) 100%
      );
      opacity: calc(0.6 * var(--holo-i));
      transform: translateY(-100%);
      animation: holo-beam 9s linear infinite;
    }

    /* ── Edge bloom: vignette glow hugging the borders + soft inner ring ── */
    .bloom {
      background:
        radial-gradient(
          120% 90% at 50% 50%,
          rgba(var(--holo-bloom), 0) 58%,
          rgba(var(--holo-bloom), 0.12) 86%,
          rgba(var(--holo-bloom), 0.26) 100%
        );
      opacity: calc(var(--holo-i));
      box-shadow:
        inset 0 0 60px rgba(var(--holo-bloom), calc(0.18 * var(--holo-i))),
        inset 0 0 140px rgba(var(--holo-wash), calc(0.1 * var(--holo-i)));
    }

    /* ── Chromatic aberration: two faint, offset tint washes that breathe ──
       Kept very subtle — a couple of px of split, never garish. */
    .aberr {
      mix-blend-mode: screen;
      opacity: calc(0.5 * var(--holo-i));
    }
    .aberr::before,
    .aberr::after {
      content: "";
      position: absolute;
      inset: 0;
      background: radial-gradient(
        130% 100% at 50% 50%,
        rgba(var(--holo-aberr), 0) 60%,
        rgba(var(--holo-aberr), 0.16) 100%
      );
    }
    .aberr::before {
      filter: hue-rotate(-22deg);
      animation: holo-aberr-r 6s ease-in-out infinite;
    }
    .aberr::after {
      filter: hue-rotate(22deg);
      animation: holo-aberr-b 6s ease-in-out infinite reverse;
    }

    /* ── Tint wash: flat, very subtle color cast over the whole field ── */
    .wash {
      background: rgba(var(--holo-wash), 1);
      opacity: calc(0.04 * var(--holo-i));
    }

    /* ── Animated grain/noise: SVG fractal-noise data URI, stepped flicker ── */
    .noise {
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/></svg>");
      background-size: 180px 180px;
      opacity: calc(0.14 * var(--holo-i));
      animation: holo-noise 0.2s steps(8) infinite;
    }

    @keyframes holo-scan {
      from { transform: translateY(0); }
      to { transform: translateY(3px); }
    }
    @keyframes holo-beam {
      from { transform: translateY(-100%); }
      to { transform: translateY(100%); }
    }
    @keyframes holo-noise {
      0% { transform: translate(0, 0); }
      10% { transform: translate(-4%, -3%); }
      20% { transform: translate(3%, 2%); }
      30% { transform: translate(-2%, 4%); }
      40% { transform: translate(4%, -2%); }
      50% { transform: translate(-3%, 3%); }
      60% { transform: translate(2%, -4%); }
      70% { transform: translate(-4%, 2%); }
      80% { transform: translate(3%, -3%); }
      90% { transform: translate(-2%, -2%); }
      100% { transform: translate(0, 0); }
    }
    @keyframes holo-aberr-r {
      0%, 100% { transform: translate(-1.5px, 0); }
      50% { transform: translate(1.5px, 0); }
    }
    @keyframes holo-aberr-b {
      0%, 100% { transform: translate(1.5px, 0); }
      50% { transform: translate(-1.5px, 0); }
    }

    /* Accessibility: freeze all motion, keep the static sheen. */
    @media (prefers-reduced-motion: reduce) {
      .scanlines,
      .beam,
      .noise,
      .aberr::before,
      .aberr::after {
        animation: none !important;
      }
      .beam { opacity: 0; }
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has("intensity") || changed.has("tint")) this.applyVars();
  }

  private _visObserver: IntersectionObserver | null = null;
  private _onVisibility = () => this._recomputePaused();
  private _inViewport = true;

  firstUpdated() {
    this.applyVars();
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibility, { passive: true });
    if (typeof IntersectionObserver !== "undefined") {
      this._visObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.target === this) this._inViewport = e.isIntersecting;
        }
        this._recomputePaused();
      }, { threshold: 0 });
      this._visObserver.observe(this);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._visObserver?.disconnect();
    this._visObserver = null;
  }

  /** Freeze CSS animations when the overlay isn't actually visible. */
  private _recomputePaused() {
    const visible = this._inViewport && !document.hidden;
    this.classList.toggle("paused", !visible);
  }

  private applyVars() {
    const i = Math.max(0, Math.min(1, Number(this.intensity) || 0));
    const t = TINTS[this.tint] ?? TINTS.gold;
    this.style.setProperty("--holo-i", String(i));
    this.style.setProperty("--holo-wash", t.wash);
    this.style.setProperty("--holo-bloom", t.bloom);
    this.style.setProperty("--holo-aberr", t.aberr);
    // Hide entirely at zero so it never tints a "should be off" host.
    this.style.opacity = i <= 0 ? "0" : "1";
  }

  /** Public toggle API — clamp + apply. Default strength is 0.5. */
  setIntensity(value: number) {
    this.intensity = Math.max(0, Math.min(1, Number(value) || 0));
  }

  /** Convenience setter for the color family. */
  setTint(tint: HoloTint) {
    this.tint = tint;
  }

  render() {
    return html`
      <div class="layer wash"></div>
      <div class="layer bloom"></div>
      <div class="layer aberr"></div>
      <div class="layer scanlines"></div>
      <div class="layer beam"></div>
      <div class="layer noise"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "holographic-overlay": HolographicOverlay;
  }
}
