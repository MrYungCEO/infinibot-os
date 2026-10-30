/**
 * <coachmark-overlay> — spotlight a DOM element and show a tooltip beside it,
 * advancing through a sequence of steps on click.
 *
 * Driven entirely by properties:
 *   .steps   = CoachStep[]   — the sequence to walk
 *   .active  = boolean       — when true the overlay mounts + shows step 0
 *
 * For each step it:
 *   • optionally navigates to `step.tab` (dispatched as an InfiniBot tab event),
 *   • finds `step.selector` and draws a spotlight ring + tooltip near it,
 *   • falls back to a centered card when there's no selector / no match.
 *
 * Events (composed, bubbling):
 *   coach-step     { index, step }   — a step became visible
 *   coach-complete {}                — the last step was advanced past
 *   coach-close    {}                — dismissed early
 *
 * Respects prefers-reduced-motion (disables the entrance keyframes).
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CoachStep } from "../../learn/extra-walkthroughs";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

@customElement("coachmark-overlay")
export class CoachmarkOverlay extends LitElement {
  @property({ attribute: false }) steps: CoachStep[] = [];
  @property({ type: Boolean }) active = false;

  @state() private index = 0;
  @state() private targetRect: Rect | null = null;

  private _repoRaf = 0;
  // Scroll/resize fire at high frequency; skip entirely when no coachmark is
  // showing, and coalesce bursts into a single measure() per animation frame.
  private _reposition = () => {
    if (!this.active) return;
    if (this._repoRaf) return;
    this._repoRaf = requestAnimationFrame(() => {
      this._repoRaf = 0;
      this.measure();
    });
  };

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 10050;
      pointer-events: none;
    }
    :host([hidden]) {
      display: none;
    }
    .scrim {
      position: fixed;
      inset: 0;
      pointer-events: auto;
    }
    /* Spotlight: a transparent box with a huge soft shadow that dims the rest. */
    .spotlight {
      position: fixed;
      border-radius: 10px;
      border: 2px solid var(--infinibot-gold, #d4af37);
      box-shadow:
        0 0 0 9999px rgba(0, 0, 0, 0.62),
        0 0 18px 2px color-mix(in srgb, var(--infinibot-gold, #d4af37) 60%, transparent);
      pointer-events: none;
      transition: top 0.22s ease, left 0.22s ease, width 0.22s ease, height 0.22s ease;
    }
    .scrim-dim {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.62);
      pointer-events: auto;
    }
    .tip {
      position: fixed;
      max-width: 320px;
      pointer-events: auto;
      background: color-mix(in srgb, var(--g-surface, #14110a) 94%, transparent);
      border: 1px solid color-mix(in srgb, var(--infinibot-gold, #d4af37) 40%, transparent);
      border-radius: 12px;
      padding: 16px 18px;
      color: var(--g-fg, #e7e3d6);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(8px);
      animation: tip-in 0.2s ease;
    }
    .tip--center {
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      max-width: 420px;
      text-align: center;
    }
    @keyframes tip-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .tip--center {
      animation: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .tip,
      .spotlight {
        animation: none !important;
        transition: none !important;
      }
    }
    .tip h4 {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: var(--infinibot-gold-bright, #fff3c0);
    }
    .tip p {
      margin: 0 0 14px;
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--g-fg-dim, #b9b2a0);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dots {
      display: inline-flex;
      gap: 5px;
      margin-right: auto;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--g-fg, #fff) 22%, transparent);
    }
    .dot.on {
      background: var(--infinibot-gold, #d4af37);
    }
    button {
      font: 600 12px/1 system-ui, sans-serif;
      padding: 7px 13px;
      border-radius: 7px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .next {
      background: var(--infinibot-gold, #d4af37);
      color: #1a1505;
    }
    .next:hover {
      filter: brightness(1.08);
    }
    .ghost {
      background: transparent;
      color: var(--g-fg-dim, #b9b2a0);
      border-color: color-mix(in srgb, var(--g-fg, #fff) 18%, transparent);
    }
    .ghost:hover {
      color: var(--g-fg, #fff);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this._reposition, { passive: true });
    window.addEventListener("scroll", this._reposition, { passive: true, capture: true });
  }

  disconnectedCallback(): void {
    window.removeEventListener("resize", this._reposition);
    window.removeEventListener("scroll", this._reposition, true);
    if (this._repoRaf) { cancelAnimationFrame(this._repoRaf); this._repoRaf = 0; }
    super.disconnectedCallback();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("active") || changed.has("steps")) {
      this.toggleAttribute("hidden", !this.active);
      if (this.active) {
        this.index = 0;
        this.applyStep();
      }
    }
    if (changed.has("index") && this.active) {
      this.applyStep();
    }
  }

  private get current(): CoachStep | undefined {
    return this.steps[this.index];
  }

  private applyStep(): void {
    const step = this.current;
    if (!step) return;
    if (step.tab) {
      // Ask the host shell to navigate. The floating pill also listens, but
      // dispatching here keeps the overlay self-driving.
      window.dispatchEvent(
        new CustomEvent("infinibot:learn-navigate", { detail: { tab: step.tab } }),
      );
    }
    // Let navigation/layout settle before measuring.
    requestAnimationFrame(() => requestAnimationFrame(() => this.measure()));
    this.dispatchEvent(
      new CustomEvent("coach-step", {
        detail: { index: this.index, step },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private measure(): void {
    const step = this.current;
    if (!step?.selector) {
      this.targetRect = null;
      return;
    }
    const el = document.querySelector(step.selector) as HTMLElement | null;
    if (!el) {
      this.targetRect = null;
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      this.targetRect = null;
      return;
    }
    const pad = 6;
    this.targetRect = {
      top: r.top - pad,
      left: r.left - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    };
  }

  private next(): void {
    if (this.index >= this.steps.length - 1) {
      this.finish();
      return;
    }
    this.index += 1;
  }

  private prev(): void {
    if (this.index > 0) this.index -= 1;
  }

  private finish(): void {
    this.active = false;
    this.toggleAttribute("hidden", true);
    this.dispatchEvent(new CustomEvent("coach-complete", { bubbles: true, composed: true }));
  }

  private close(): void {
    this.active = false;
    this.toggleAttribute("hidden", true);
    this.dispatchEvent(new CustomEvent("coach-close", { bubbles: true, composed: true }));
  }

  render() {
    if (!this.active || !this.current) return nothing;
    const step = this.current;
    const isLast = this.index >= this.steps.length - 1;
    const rect = this.targetRect;

    const tip = html`
      <div
        class="tip ${rect ? "" : "tip--center"}"
        style=${rect ? this.tipStyle(rect) : nothing}
        role="dialog"
        aria-label=${step.title}
      >
        <h4>${step.title}</h4>
        <p>${step.body}</p>
        <div class="row">
          <span class="dots">
            ${this.steps.map(
              (_, i) => html`<span class="dot ${i <= this.index ? "on" : ""}"></span>`,
            )}
          </span>
          <button class="ghost" @click=${() => this.close()}>Skip</button>
          ${this.index > 0
            ? html`<button class="ghost" @click=${() => this.prev()}>Back</button>`
            : nothing}
          <button class="next" @click=${() => this.next()}>
            ${isLast ? "Done" : "Next →"}
          </button>
        </div>
      </div>
    `;

    return html`
      ${rect
        ? html`<div
              class="spotlight"
              style="top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;"
            ></div>`
        : html`<div class="scrim-dim" @click=${() => this.close()}></div>`}
      ${tip}
    `;
  }

  /** Position the tooltip below the target, flipping above when near the bottom. */
  private tipStyle(rect: Rect): string {
    const vh = window.innerHeight;
    const below = rect.top + rect.height + 12;
    const placeBelow = below + 160 < vh;
    const top = placeBelow ? below : Math.max(12, rect.top - 12 - 160);
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - 332);
    return `top:${top}px;left:${left}px;`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "coachmark-overlay": CoachmarkOverlay;
  }
}
