/** activity media card: compact icon + line (+ optional muted detail). */
import { html } from "lit";
import type { ActivityMedia } from "../proactive-popup-shared.js";
import { type MediaRenderCtx, stagger, nothing } from "./shared.js";

export function renderActivity(p: ActivityMedia, _ctx: MediaRenderCtx) {
  return html`
    <div class="pmedia pmedia-activity pmedia-stagger" style=${stagger(0)}>
      <span class="pmedia-act-icon">${p.icon ?? "•"}</span>
      <div class="pmedia-act-body">
        <div class="pmedia-act-line">${p.line}</div>
        ${p.detail ? html`<div class="pmedia-act-detail">${p.detail}</div>` : nothing}
      </div>
    </div>
  `;
}
