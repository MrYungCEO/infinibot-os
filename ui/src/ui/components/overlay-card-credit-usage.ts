/**
 * overlay-card-credit-usage.ts — overlay wrapper around the existing
 * <credit-usage-breakdown> component (which already polls `credits.timeseries`,
 * see project memory `credits_timeseries_24h_source`). We do NOT add a new poll
 * — we just hand the shared gateway client to the existing component.
 *
 * Payload: `{ compact?: boolean, limit?: number }`
 */
import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base.js";
import "./credit-usage-breakdown";

@customElement("overlay-card-credit-usage")
export class OverlayCardCreditUsage extends OverlayCardBase {
  protected accent = "var(--g-primary, #d4af37)";

  protected cardTitle() {
    return "Credit Usage · 24h";
  }

  protected renderBody() {
    const compact = this.payload?.compact ?? this.compact ?? false;
    const limit = Number(this.payload?.limit) || 5;
    return html`
      <credit-usage-breakdown
        .client=${this.client as any}
        ?compact=${compact}
        .limit=${limit}
      ></credit-usage-breakdown>
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .ovc-body { min-width: 280px; }
      credit-usage-breakdown { display: block; }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-credit-usage": OverlayCardCreditUsage;
  }
}
