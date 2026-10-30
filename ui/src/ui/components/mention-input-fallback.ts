/**
 * MentionInputOrFallback — Shim that renders <mention-input> if the real
 * component is registered, otherwise falls back to a plain textarea.
 *
 * TODO: Replace with real <mention-input> when the mentions agent lands.
 * Supports multiple @-mentions per field, e.g.:
 *   "@founder hands @shea-bottle to @customer at @kitchen counter"
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("mention-input-fallback")
export class MentionInputFallback extends LitElement {
  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "";
  @property({ type: Number }) rows = 2;
  @property({ type: String }) field = "";

  static styles = css`
    :host { display: block; }
    textarea {
      width: 100%;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.4);
      color: #f5f5f5;
      border: 1px solid rgba(212, 175, 55, 0.25);
      border-radius: 6px;
      padding: 6px 8px;
      font: inherit;
      font-size: 12px;
      resize: vertical;
    }
    textarea:focus { outline: none; border-color: rgba(212, 175, 55, 0.6); }
    .hint { color: rgba(212, 175, 55, 0.5); font-size: 10px; margin-top: 2px; }
  `;

  private onInput(e: Event) {
    const t = e.target as HTMLTextAreaElement;
    this.value = t.value;
    this.dispatchEvent(new CustomEvent("value-changed", {
      detail: { value: t.value, field: this.field },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    // If real <mention-input> ever gets registered, prefer it.
    if (customElements.get("mention-input")) {
      return html`<mention-input
        .value=${this.value}
        .placeholder=${this.placeholder}
        .field=${this.field}
        @value-changed=${(e: CustomEvent) => this.dispatchEvent(new CustomEvent("value-changed", { detail: e.detail, bubbles: true, composed: true }))}
      ></mention-input>`;
    }
    const hasMentions = /@[a-zA-Z][\w-]*/g.test(this.value);
    return html`
      <textarea
        rows=${this.rows}
        .value=${this.value}
        placeholder=${this.placeholder}
        @input=${this.onInput}
      ></textarea>
      ${hasMentions ? html`<div class="hint">@-mentions: ${(this.value.match(/@[a-zA-Z][\w-]*/g) || []).join(", ")}</div>` : nothing}
    `;
  }
}
