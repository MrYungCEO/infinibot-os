/** agent-summary media card: agent name, project, summary, diff stats, thumbs. */
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../markdown/render.js";
import type { AgentSummaryMedia } from "../proactive-popup-shared.js";
import { type MediaRenderCtx, renderThumbs, stagger, nothing } from "./shared.js";

export function renderAgentSummary(p: AgentSummaryMedia, ctx: MediaRenderCtx) {
  const diff = p.diff;
  const summaryHtml = p.summaryMarkdown ? toSanitizedMarkdownHtml(p.summaryMarkdown) : "";
  return html`
    <div class="pmedia pmedia-agent">
      <div class="pmedia-row pmedia-stagger" style=${stagger(0)}>
        <span class="pmedia-badge">◆ agent</span>
        <span class="pmedia-name">${p.agentName}</span>
        ${p.project ? html`<span class="pmedia-proj">${p.project}</span>` : nothing}
      </div>
      ${summaryHtml
        ? html`<div class="pmedia-md pmedia-stagger" style=${stagger(1)}>
            ${unsafeHTML(summaryHtml)}
          </div>`
        : nothing}
      ${diff
        ? html`<div class="pmedia-diff pmedia-stagger" style=${stagger(2)}>
            <span class="pmedia-diff-files">${diff.filesChanged} file${diff.filesChanged === 1 ? "" : "s"}</span>
            <span class="pmedia-diff-add">+${diff.additions}</span>
            <span class="pmedia-diff-del">−${diff.deletions}</span>
            <span class="pmedia-diff-bar">${renderDiffBar(diff.additions, diff.deletions)}</span>
          </div>`
        : nothing}
      ${renderStatusChips(p)}
      ${renderThumbs(p.thumbnails, ctx, 3)}
    </div>
  `;
}

/**
 * The two completion-status indicators: BUILT / UNBUILT and COMMITTED /
 * UNCOMMITTED (with a "· pushed" affordance once a committed change is on its
 * upstream). Rendered only when the emit path derived them.
 */
function renderStatusChips(p: AgentSummaryMedia) {
  if (!p.buildStatus && !p.commitStatus) return nothing;
  const built = p.buildStatus === "built";
  const committed = p.commitStatus === "committed";
  return html`
    <div class="pmedia-status pmedia-stagger" style=${stagger(3)}>
      ${p.buildStatus
        ? html`<span class="pmedia-chip ${built ? "ok" : "warn"}" title="Is the change compiled into the UI?">
            <i class="pmedia-chip-dot"></i>${built ? "BUILT" : "UNBUILT"}
          </span>`
        : nothing}
      ${p.commitStatus
        ? html`<span class="pmedia-chip ${committed ? "ok" : "warn"}" title="Is the change committed in git?">
            <i class="pmedia-chip-dot"></i>${committed ? "COMMITTED" : "UNCOMMITTED"}${committed && p.pushed ? " · pushed" : committed ? " · local" : ""}
          </span>`
        : nothing}
    </div>
  `;
}

function renderDiffBar(add: number, del: number) {
  const total = Math.max(1, add + del);
  const segs = 12;
  const addSegs = Math.round((add / total) * segs);
  const cells: unknown[] = [];
  for (let i = 0; i < segs; i++) {
    cells.push(html`<i class=${i < addSegs ? "add" : del > 0 ? "del" : "neutral"}></i>`);
  }
  return html`<span class="pmedia-bar">${cells}</span>`;
}
