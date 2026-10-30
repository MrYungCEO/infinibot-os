/**
 * <cosmetics-picker> — world theme swatch chooser for the Agency World map.
 *
 * Owns a small bottom-right palette puck that opens a modal grid of theme
 * previews. Each card renders a *live mini-world* swatch (bg + grid + agents +
 * beam + status pills) painted from the theme's own tokens, so the preview is
 * accurate regardless of the active theme. Clicking a card calls
 * `applyTheme(id)` from ../../../../src/cosmetics — which sets
 * `data-world-theme` on <html>, persists the choice, and cascades the
 * `--world-*` tokens to every world layer.
 *
 * ── MOUNT ONE-LINER ────────────────────────────────────────────────────────
 *   import { initCosmetics } from "../../../../src/cosmetics/index.js";
 *   import "./components/cosmetics-picker.js";
 *   initCosmetics();                                   // once, at app boot
 *   host.appendChild(document.createElement("cosmetics-picker")); // inside .host
 * Open programmatically from existing chrome:  picker.open();
 * Suppress the built-in puck with the `embedded` attribute if you supply a
 * trigger yourself.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  COSMETIC_THEMES,
  applyTheme,
  getActiveThemeId,
  initCosmetics,
  type CosmeticTheme,
} from "../../../../src/cosmetics/index.js";

@customElement("cosmetics-picker")
export class CosmeticsPicker extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      right: var(--cosmetics-right, 62px);
      bottom: var(--cosmetics-bottom, 16px);
      z-index: 6;
      font-family: var(--mono, ui-monospace, monospace);
      color: var(--world-text, #e4e4e7);
      pointer-events: none;
    }
    :host([embedded]) {
      position: static;
    }
    .puck {
      pointer-events: auto;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      cursor: pointer;
      background: color-mix(in srgb, var(--world-surface, #0f0f0f) 88%, transparent);
      border: 1px solid var(--world-border, rgba(255, 255, 255, 0.14));
      color: var(--world-accent, #f5c451);
      backdrop-filter: blur(8px);
      transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
    }
    .puck:hover {
      transform: translateY(-1px);
      border-color: var(--world-accent, #f5c451);
      box-shadow: 0 0 0 1px var(--world-accent, #f5c451),
        0 6px 22px color-mix(in srgb, var(--world-accent, #f5c451) 30%, transparent);
    }
    .puck svg {
      width: 18px;
      height: 18px;
    }
    .backdrop {
      pointer-events: auto;
      position: fixed;
      inset: 0;
      z-index: 40;
      display: grid;
      place-items: center;
      background: rgba(3, 3, 5, 0.62);
      backdrop-filter: blur(6px);
    }
    .modal {
      width: min(680px, 92vw);
      max-height: 86vh;
      overflow: auto;
      padding: 22px;
      border-radius: 16px;
      background: color-mix(in srgb, var(--world-surface, #0f0f0f) 96%, transparent);
      border: 1px solid var(--world-border, rgba(255, 255, 255, 0.16));
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.6);
    }
    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 18px;
    }
    .head h2 {
      margin: 0;
      font-size: 14px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--world-text, #e4e4e7);
    }
    .head p {
      margin: 4px 0 0;
      font-size: 11.5px;
      color: var(--world-muted, #a1a1aa);
    }
    .x {
      cursor: pointer;
      background: none;
      border: none;
      color: var(--world-muted, #a1a1aa);
      font-size: 20px;
      line-height: 1;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
    }
    @media (max-width: 520px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    .card {
      cursor: pointer;
      border-radius: 12px;
      overflow: hidden;
      border: 1.5px solid transparent;
      background: rgba(255, 255, 255, 0.03);
      transition: transform 0.12s ease, border-color 0.12s ease;
    }
    .card:hover {
      transform: translateY(-2px);
    }
    .card.active {
      border-color: var(--world-accent, #f5c451);
      box-shadow: 0 0 0 1px var(--world-accent, #f5c451);
    }
    /* mini-world swatch — painted from theme tokens via inline style */
    .swatch {
      position: relative;
      height: 110px;
      overflow: hidden;
    }
    .swatch .grid-lines {
      position: absolute;
      inset: 0;
    }
    .dot {
      position: absolute;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      box-shadow: 0 0 10px 1px currentColor;
    }
    .beam {
      position: absolute;
      height: 2px;
      border-radius: 2px;
      transform: rotate(-18deg);
      transform-origin: left center;
    }
    .pills {
      position: absolute;
      left: 10px;
      bottom: 10px;
      display: flex;
      gap: 5px;
    }
    .pill {
      width: 16px;
      height: 6px;
      border-radius: 3px;
    }
    .meta {
      padding: 11px 13px 13px;
    }
    .meta .name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--world-text, #e4e4e7);
    }
    .meta .name .check {
      color: var(--world-accent, #f5c451);
      font-size: 12px;
    }
    .meta .desc {
      margin-top: 5px;
      font-size: 10.5px;
      line-height: 1.45;
      color: var(--world-muted, #a1a1aa);
    }
  `;

  /** Hide the built-in puck (caller provides its own trigger). */
  @property({ type: Boolean, reflect: true }) embedded = false;
  @state() private isOpen = false;
  @state() private activeId = getActiveThemeId();

  connectedCallback(): void {
    super.connectedCallback();
    // Be self-sufficient: ensure the stylesheet + persisted theme are applied.
    initCosmetics();
    this.activeId = getActiveThemeId();
  }

  /** Public API. */
  open(): void {
    this.isOpen = true;
  }
  close(): void {
    this.isOpen = false;
  }

  private choose(theme: CosmeticTheme): void {
    applyTheme(theme.id);
    this.activeId = theme.id;
    this.dispatchEvent(
      new CustomEvent("theme-change", { detail: { id: theme.id }, bubbles: true, composed: true }),
    );
  }

  private swatch(t: CosmeticTheme) {
    const k = t.tokens;
    const gridLines = `repeating-linear-gradient(0deg, ${k.grid} 0 1px, transparent 1px 14px),
      repeating-linear-gradient(90deg, ${k.grid} 0 1px, transparent 1px 14px)`;
    return html`
      <div class="swatch" style="background:${k.bg}">
        <div class="grid-lines" style="background:${gridLines}"></div>
        <div
          class="beam"
          style="left:18px;top:40px;width:78px;background:linear-gradient(90deg, transparent, ${k.beam});box-shadow:0 0 8px ${k.beam}"
        ></div>
        <div class="dot" style="left:14px;top:36px;color:${k["accent-strong"]};background:${k["accent-strong"]}"></div>
        <div class="dot" style="left:88px;top:20px;color:${k.accent};background:${k.accent}"></div>
        <div class="dot" style="left:120px;top:62px;color:${k.beam};background:${k.beam}"></div>
        <div class="pills">
          <div class="pill" style="background:${k["status-running"]}"></div>
          <div class="pill" style="background:${k["status-complete"]}"></div>
          <div class="pill" style="background:${k["status-error"]}"></div>
          <div class="pill" style="background:${k["status-idle"]}"></div>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      ${this.embedded
        ? nothing
        : html`<button
            class="puck"
            title="World theme"
            aria-label="Change world theme"
            @click=${() => this.open()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="13.5" cy="6.5" r="1.4" fill="currentColor" />
              <circle cx="17.5" cy="10.5" r="1.4" fill="currentColor" />
              <circle cx="8.5" cy="7.5" r="1.4" fill="currentColor" />
              <circle cx="6.5" cy="12.5" r="1.4" fill="currentColor" />
              <path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4 10 10 0 0 0-10-8z" />
            </svg>
          </button>`}
      ${this.isOpen
        ? html`
            <div class="backdrop" @click=${() => this.close()}>
              <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
                <div class="head">
                  <div>
                    <h2>World Cosmetics</h2>
                    <p>Swap the palette, skybox &amp; agent colours of your agency world.</p>
                  </div>
                  <button class="x" aria-label="Close" @click=${() => this.close()}>×</button>
                </div>
                <div class="grid">
                  ${COSMETIC_THEMES.map(
                    (t) => html`
                      <div
                        class="card ${t.id === this.activeId ? "active" : ""}"
                        role="button"
                        tabindex="0"
                        @click=${() => this.choose(t)}
                        @keydown=${(e: KeyboardEvent) =>
                          (e.key === "Enter" || e.key === " ") && this.choose(t)}
                      >
                        ${this.swatch(t)}
                        <div class="meta">
                          <div class="name">
                            ${t.label}
                            ${t.id === this.activeId ? html`<span class="check">● active</span>` : nothing}
                          </div>
                          <div class="desc">${t.description}</div>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </div>
            </div>
          `
        : nothing}
    `;
  }
}
