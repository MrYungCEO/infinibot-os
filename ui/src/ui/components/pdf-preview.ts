/**
 * PDF Preview — inline iframe preview pane for a rendered report.
 *
 * Pure render function. The view resolves a previewable file path (via the
 * `reports.preview` RPC) and hands it in. We render an `<iframe>` pointed at the
 * gateway-served file so the user gets an instant in-app view with no download.
 *
 * On a narrow viewport the host view renders this inside a modal overlay instead
 * of a side pane; this component is layout-agnostic and just fills its container.
 */

import { html, nothing, type TemplateResult } from "lit";

const ICO_CLOSE = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const ICO_DOWNLOAD = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const ICO_EXT = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICO_DOC = html`<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.35"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

export type PdfPreviewCtx = {
  title: string;
  /** resolved, browser-loadable URL/path for the iframe (null while loading) */
  url: string | null;
  mimeType?: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onDownload: () => void;
  onRetry: () => void;
};

export function renderPdfPreview(ctx: PdfPreviewCtx): TemplateResult {
  return html`
    <div class="rep-preview" role="region" aria-label="Report preview">
      <div class="rep-preview-bar">
        <span class="rep-preview-title" title="${ctx.title}">${ctx.title}</span>
        <div class="rep-preview-bar-actions">
          ${ctx.url ? html`
            <a class="btn btn--sm btn--icon" href="${ctx.url}" target="_blank" rel="noopener" aria-label="Open report in new tab" title="Open in new tab">${ICO_EXT}</a>
            <button class="btn btn--sm btn--icon" aria-label="Download report PDF" title="Download" @click=${ctx.onDownload}>${ICO_DOWNLOAD}</button>
          ` : nothing}
          <button class="btn btn--sm btn--icon" aria-label="Close preview" title="Close preview" @click=${ctx.onClose}>${ICO_CLOSE}</button>
        </div>
      </div>

      <div class="rep-preview-body">
        ${ctx.loading ? html`
          <div class="rep-preview-state">
            <span class="rep-preview-spin"></span>
            <span>Loading preview…</span>
          </div>
        ` : ctx.error ? html`
          <div class="rep-preview-state">
            ${ICO_DOC}
            <span style="color:#ef4444;font-weight:600;">Preview failed</span>
            <span class="rep-preview-state-sub">${ctx.error}</span>
            <button class="btn btn--sm" aria-label="Retry preview" @click=${ctx.onRetry}>Retry</button>
          </div>
        ` : ctx.url ? html`
          <iframe
            class="rep-preview-frame"
            src="${ctx.url}"
            title="${ctx.title}"
            loading="lazy"
          ></iframe>
        ` : html`
          <div class="rep-preview-state">
            ${ICO_DOC}
            <span>No preview available.</span>
          </div>
        `}
      </div>
    </div>
  `;
}
