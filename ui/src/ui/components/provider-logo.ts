/**
 * <ib-provider-logo provider="anthropic" label="Anthropic" size="40">
 *
 * A fixed logo tile for a provider, CLI or KinglyVault. Shows the official mark
 * from lib/provider-logos.ts, or a lettermark when there isn't one. Always
 * decorative: the provider's name stays in the text next to it.
 */
import { LitElement, css, html, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { providerLetters, providerLogoMark } from "../lib/provider-logos";

@customElement("ib-provider-logo")
export class IbProviderLogo extends LitElement {
  static styles = css`
    :host {
      --_size: 32px;
      display: inline-flex;
      flex: none;
      width: var(--_size);
      height: var(--_size);
    }
    .tile {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      container-type: size;
      border-radius: 24%;
      /* Black/white-only marks follow the theme, never an accent colour. */
      color: var(--sob-fg, var(--text-strong, #fff));
      background: color-mix(in srgb, currentColor 7%, transparent);
      border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    }
    /* KinglyVault's bulb is gold on black in every theme. */
    .tile.kv {
      color: #e8c15a;
      background: #0b0a08;
      border-color: color-mix(in srgb, #e8c15a 45%, transparent);
    }
    svg {
      display: block;
      width: 62%;
      height: 62%;
    }
    .tile.kv svg {
      width: 78%;
      height: 78%;
    }
    /* Inline chips: too small for a tile, so the mark fills the slot. */
    .tile.bare:not(.kv) {
      background: none;
      border: 0;
    }
    .tile.bare svg {
      width: 100%;
      height: 100%;
    }
    .letters {
      font: 700 38cqw / 1 var(--font-body, system-ui, sans-serif);
      letter-spacing: -0.01em;
    }
  `;

  @property() provider = "";
  @property() label = "";
  /** Lettermark override for surfaces with their own letters. */
  @property() letters = "";
  @property({ type: Number }) size = 32;

  override render() {
    this.style.setProperty("--_size", `${this.size}px`);
    const mark = providerLogoMark(this.provider);
    if (!mark) {
      return html`<span class="tile" part="tile" aria-hidden="true"><span class="letters" data-fallback>${this.letters || providerLetters(this.label, this.provider)}</span></span>`;
    }
    return html`<span class="tile ${mark.kind} ${this.size <= 18 ? "bare" : ""}" part="tile" aria-hidden="true">${svg`<svg viewBox=${mark.viewBox} fill="currentColor">${mark.body}</svg>`}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-provider-logo": IbProviderLogo;
  }
}
