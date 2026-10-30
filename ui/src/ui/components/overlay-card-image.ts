/**
 * overlay-card-image.ts — image overlay with caption + click-to-expand.
 *
 * payload: { src?|url?: string, caption?|alt?: string }
 * Click the image to toggle a full-bleed fit / expanded lightbox state.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base";

@customElement("overlay-card-image")
export class OverlayCardImage extends OverlayCardBase {
  @state() private expanded = false;
  @state() private errored = false;

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .ovc-body {
        padding: 0;
        display: flex;
        flex-direction: column;
        background: rgba(0, 0, 0, 0.25);
      }
      .frame {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        place-items: center;
        overflow: hidden;
        cursor: zoom-in;
      }
      img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        display: block;
      }
      .frame.expanded {
        cursor: zoom-out;
        overflow: auto;
      }
      .frame.expanded img {
        max-width: none;
        max-height: none;
        width: 100%;
      }
      .caption {
        flex: 0 0 auto;
        padding: 7px 10px;
        font-size: 11px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
        border-top: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        background: var(--g-surface, rgba(255, 255, 255, 0.04));
      }
      .err {
        padding: 24px;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.45));
        font-size: 12px;
        text-align: center;
      }
    `,
  ];

  protected get cardIcon() {
    return "🖼";
  }
  protected get cardTitle() {
    return (this.payload.caption as string) || (this.payload.alt as string) || "Image";
  }

  private get src(): string {
    return String(this.payload.src ?? this.payload.url ?? "");
  }

  protected renderBody() {
    const cap = (this.payload.caption as string) || (this.payload.alt as string) || "";
    if (!this.src || this.errored) {
      return html`<div class="err">No image to display</div>`;
    }
    return html`
      <div
        class="frame ${this.expanded ? "expanded" : ""}"
        @click=${() => (this.expanded = !this.expanded)}
      >
        <img
          src=${this.src}
          alt=${cap}
          @error=${() => (this.errored = true)}
          loading="lazy"
        />
      </div>
      ${cap ? html`<div class="caption">${cap}</div>` : nothing}
    `;
  }
}
