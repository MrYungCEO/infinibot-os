/**
 * overlay-card-pdf.ts — PDF overlay.
 *
 * payload: { url?|src?: string, title?: string }
 *
 * Mirrors the file_viewer PDF path (browser-native <iframe> against a
 * reachable/gateway-served URL — no client-side pdf.js dependency is pulled in).
 */

import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base";

@customElement("overlay-card-pdf")
export class OverlayCardPdf extends OverlayCardBase {
  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .ovc-body {
        padding: 0;
        display: flex;
        flex-direction: column;
        background: rgba(0, 0, 0, 0.3);
      }
      iframe {
        flex: 1 1 auto;
        width: 100%;
        height: 100%;
        border: none;
        background: #1a1a1d;
      }
      .empty,
      .toolbar {
        flex: 0 0 auto;
      }
      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 6px 10px;
        border-bottom: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
      }
      .toolbar a {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--g-primary, #fbbf24);
        text-decoration: none;
      }
      .url {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 10px;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.45));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .empty {
        padding: 28px;
        text-align: center;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.45));
        font-size: 12px;
      }
    `,
  ];

  protected get cardIcon() {
    return "▦";
  }
  protected get cardTitle() {
    return (this.payload.title as string) || "PDF";
  }

  private get url(): string {
    return String(this.payload.url ?? this.payload.src ?? "");
  }

  protected renderBody() {
    if (!this.url) return html`<div class="empty">No PDF URL provided</div>`;
    return html`
      <div class="toolbar">
        <span class="url" title=${this.url}>${this.url}</span>
        <a href=${this.url} target="_blank" rel="noopener">Open ↗</a>
      </div>
      <iframe src=${this.url} title=${this.cardTitle} loading="lazy"></iframe>
    `;
  }
}
