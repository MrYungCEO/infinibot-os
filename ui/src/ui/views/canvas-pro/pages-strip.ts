/**
 * Bottom-rail page strip - thumbnails, add/duplicate/delete/reorder.
 *
 * Thumbnails are rendered from the page's stored scene by drawing the
 * background + a faint outline; a real raster preview would require
 * either ExcalidrawAPI.exportToCanvas (we don't have a stable handle per
 * page since only the active page is mounted) or a background worker.
 * The current cheap preview keeps the strip useful without that
 * overhead — the active page edges are highlighted for orientation.
 */

import { html } from "lit";
import type { TemplateResult } from "lit";
import type { CanvasProStore } from "./store";

export function renderPagesStrip(store: CanvasProStore): TemplateResult {
  const doc = store.getDocument();
  return html`
    <div class="cp-pages">
      ${doc.pages.map((page, i) => {
        const active = page.id === doc.activePageId;
        return html`
          <div
            class="cp-pages__item ${active ? "is-active" : ""}"
            draggable="true"
            @click=${() => store.setActivePage(page.id)}
            @dragstart=${(e: DragEvent) => e.dataTransfer?.setData("text/cp-page", page.id)}
            @dragover=${(e: DragEvent) => e.preventDefault()}
            @drop=${(e: DragEvent) => {
              e.preventDefault();
              const draggedId = e.dataTransfer?.getData("text/cp-page");
              if (draggedId && draggedId !== page.id) store.reorderPage(draggedId, i);
            }}
          >
            <div
              class="cp-pages__thumb"
              style="background:${page.background};aspect-ratio:${page.width}/${page.height}"
              title="${page.name} · ${page.width}×${page.height}"
            >
              <div class="cp-pages__thumb-label">${i + 1}</div>
            </div>
            <div class="cp-pages__name" title=${page.name}>${page.name}</div>
            <div class="cp-pages__row">
              <button
                class="cp-pages__btn"
                title="Duplicate"
                @click=${(e: MouseEvent) => {
                  e.stopPropagation();
                  store.duplicatePage(page.id);
                }}
              >⧉</button>
              <button
                class="cp-pages__btn"
                title="Delete"
                ?disabled=${doc.pages.length <= 1}
                @click=${(e: MouseEvent) => {
                  e.stopPropagation();
                  store.deletePage(page.id);
                }}
              >×</button>
            </div>
          </div>
        `;
      })}
      <button class="cp-pages__add" title="Add page" @click=${() => store.addPage()}>+</button>
    </div>
  `;
}
