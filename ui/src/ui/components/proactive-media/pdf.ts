/**
 * pdf media card: an embedded PDF preview with download / open affordances.
 *
 * When `url` is present we embed an <iframe> preview inline. Otherwise (the
 * common reports.render case, where the PDF is only addressable by reportId) we
 * render a framed "PDF ready" card whose Open button dispatches a bubbling
 * `pmedia-pdf-open` event — the overlay host resolves it via reports.preview and
 * opens a blob in a new tab.
 */
import { html } from "lit";
import type { PdfMedia } from "../proactive-popup-shared.js";
import { stagger, nothing } from "./shared.js";

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fireOpen(e: Event, p: PdfMedia): void {
  (e.currentTarget as HTMLElement).dispatchEvent(
    new CustomEvent("pmedia-pdf-open", {
      bubbles: true,
      composed: true,
      detail: { reportId: p.reportId, filePath: p.filePath, url: p.url },
    }),
  );
}

export function renderPdf(p: PdfMedia) {
  const size = fmtBytes(p.bytes);
  const meta = [size, p.pageCount ? `${p.pageCount} pages` : ""].filter(Boolean).join(" · ");
  if (p.url) {
    return html`
      <div class="pmedia pmedia-pdfcard">
        <div class="pmedia-pdfframe pmedia-stagger" style=${stagger(0)}>
          <iframe class="pmedia-pdfembed" src=${p.url} title=${p.title ?? "PDF preview"}></iframe>
        </div>
        <div class="pmedia-pdfrow pmedia-stagger" style=${stagger(1)}>
          <span class="pmedia-pdf-name">${p.title ?? "Report.pdf"}</span>
          ${meta ? html`<span class="pmedia-proj">${meta}</span>` : nothing}
          <a class="pmedia-pdf-btn" href=${p.url} target="_blank" rel="noopener">Open</a>
        </div>
      </div>
    `;
  }
  return html`
    <div class="pmedia pmedia-pdfcard pmedia-pdfcard-stub pmedia-stagger" style=${stagger(0)}>
      <div class="pmedia-pdf-icon">PDF</div>
      <div class="pmedia-pdf-info">
        <span class="pmedia-pdf-name">${p.title ?? "Report.pdf"}</span>
        ${meta ? html`<span class="pmedia-proj">${meta}</span>` : nothing}
      </div>
      <button class="pmedia-pdf-btn" @click=${(e: Event) => fireOpen(e, p)}>Open</button>
    </div>
  `;
}
