/**
 * Right-rail Layers panel. Renders the active page's `layerOrder`
 * top-to-bottom (front-most first), with lock/hide toggles, inline
 * rename, drag-to-reorder z-index, and group nesting.
 *
 * Z-index semantics: `layerOrder[0]` is the front-most layer. Dragging
 * a layer up moves it forward; dragging down sends it backward. The
 * store keeps `layerOrder` and the Excalidraw element array in sync via
 * `syncActiveScene`.
 */

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import type { CanvasProStore } from "./store";
import type { LayerMeta } from "./types";

export type LayersPanelHandlers = {
  onSelectLayer: (id: string, additive: boolean) => void;
  selectedIds: Set<string>;
};

export function renderLayersPanel(
  store: CanvasProStore,
  h: LayersPanelHandlers
): TemplateResult {
  const page = store.getActivePage();
  const layers = page.layerOrder
    .map((id) => page.layers[id])
    .filter((l): l is LayerMeta => Boolean(l));

  if (layers.length === 0) {
    return html`<div class="cp-rail__empty">No elements on this page yet.</div>`;
  }

  // Group consecutive same-groupId runs visually.
  return html`
    <div class="cp-layers">
      ${layers.map((layer, i) => renderLayerRow(layer, i, store, h, page.layerOrder.length))}
    </div>
  `;
}

function renderLayerRow(
  layer: LayerMeta,
  index: number,
  store: CanvasProStore,
  h: LayersPanelHandlers,
  total: number
): TemplateResult {
  const selected = h.selectedIds.has(layer.id);
  return html`
    <div
      class="cp-layer ${selected ? "is-selected" : ""} ${layer.hidden ? "is-hidden" : ""} ${layer.groupId ? "is-grouped" : ""}"
      draggable="true"
      @click=${(e: MouseEvent) => h.onSelectLayer(layer.id, e.shiftKey || e.metaKey || e.ctrlKey)}
      @dragstart=${(e: DragEvent) => e.dataTransfer?.setData("text/cp-layer", layer.id)}
      @dragover=${(e: DragEvent) => e.preventDefault()}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        const draggedId = e.dataTransfer?.getData("text/cp-layer");
        if (draggedId && draggedId !== layer.id) store.reorderLayer(draggedId, index);
      }}
    >
      <button
        class="cp-layer__icon"
        title=${layer.hidden ? "Show" : "Hide"}
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          store.updateLayer(layer.id, { hidden: !layer.hidden });
        }}
      >
        ${layer.hidden ? "◌" : "●"}
      </button>
      <button
        class="cp-layer__icon"
        title=${layer.locked ? "Unlock" : "Lock"}
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          store.updateLayer(layer.id, { locked: !layer.locked });
        }}
      >
        ${layer.locked ? "🔒" : "🔓"}
      </button>
      <input
        class="cp-layer__name"
        .value=${layer.name}
        @click=${(e: Event) => e.stopPropagation()}
        @change=${(e: Event) =>
          store.updateLayer(layer.id, { name: (e.target as HTMLInputElement).value })}
      />
      <div class="cp-layer__z">${total - index}</div>
      ${layer.groupId
        ? html`<span class="cp-layer__group" title="Group ${layer.groupId}">⊞</span>`
        : nothing}
    </div>
  `;
}
