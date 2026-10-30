/** workflow media card: run-status badge + step list. */
import { html } from "lit";
import type { WorkflowMedia, WorkflowStep } from "../proactive-popup-shared.js";
import { type MediaRenderCtx, stagger, nothing } from "./shared.js";

const STEP_GLYPH: Record<WorkflowStep["status"], string> = {
  pending: "○",
  running: "◐",
  done: "●",
  failed: "✕",
  skipped: "–",
};

export function renderWorkflow(p: WorkflowMedia, _ctx: MediaRenderCtx) {
  return html`
    <div class="pmedia pmedia-workflow">
      <div class="pmedia-row pmedia-stagger" style=${stagger(0)}>
        <span class="pmedia-badge pmedia-badge-wf">⚙ workflow</span>
        <span class="pmedia-name">${p.name}</span>
        <span class="pmedia-wf-status pmedia-wf-${p.status}">${p.status}</span>
      </div>
      ${p.steps.length
        ? html`<ol class="pmedia-steps pmedia-stagger" style=${stagger(1)}>
            ${p.steps.slice(0, 8).map(
              (s) => html`<li class="pmedia-step pmedia-step-${s.status}">
                <span class="pmedia-step-glyph">${STEP_GLYPH[s.status] ?? "○"}</span>
                <span class="pmedia-step-label">${s.label}</span>
              </li>`,
            )}
          </ol>`
        : nothing}
    </div>
  `;
}
