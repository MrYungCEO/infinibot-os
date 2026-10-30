/**
 * Brand Kit panel - logos, color swatches, font pairs, template
 * shortcuts. Persists through the pro store (per-doc); a separate
 * "make brand kit global" action would copy to a user-scoped key —
 * deferred until product calls for it.
 *
 * "Apply brand" is a one-click action: rewrites the current page's
 * background, recolors text+shape fills/strokes that match a swatch
 * already on the page, and swaps the heading/body fontFamily on text
 * elements. Non-destructive (the user can undo via the Excalidraw
 * undo stack — which we don't own — so we also stash a snapshot).
 */

import { html } from "lit";
import type { TemplateResult } from "lit";
import type { CanvasProStore } from "./store";
import type { BrandColorSwatch, BrandFontPair, BrandLogo } from "./types";

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export type BrandKitHandlers = {
  /** Hand the active page scene back to the caller for re-application. */
  onApplyBrand: () => void;
};

export function renderBrandKitPanel(
  store: CanvasProStore,
  h: BrandKitHandlers
): TemplateResult {
  const kit = store.getDocument().brandKit;

  return html`
    <div class="cp-brand">
      <section>
        <header class="cp-brand__h">
          <span>Colors</span>
          <button class="cp-brand__add" @click=${() => addColor(store)}>+</button>
        </header>
        <div class="cp-brand__swatches">
          ${kit.colors.length === 0
            ? html`<div class="cp-rail__empty">No swatches yet</div>`
            : kit.colors.map((c) => renderSwatch(c, store))}
        </div>
      </section>

      <section>
        <header class="cp-brand__h">
          <span>Logos</span>
          <label class="cp-brand__add" title="Upload logo">
            +
            <input type="file" accept="image/*" hidden @change=${(e: Event) => addLogo(e, store)} />
          </label>
        </header>
        <div class="cp-brand__logos">
          ${kit.logos.length === 0
            ? html`<div class="cp-rail__empty">No logos yet</div>`
            : kit.logos.map((l) => renderLogo(l, store))}
        </div>
      </section>

      <section>
        <header class="cp-brand__h">
          <span>Font pairs</span>
          <button class="cp-brand__add" @click=${() => addFontPair(store)}>+</button>
        </header>
        <div class="cp-brand__fonts">
          ${kit.fontPairs.length === 0
            ? html`<div class="cp-rail__empty">No pairs yet</div>`
            : kit.fontPairs.map((f) => renderFontPair(f, store))}
        </div>
      </section>

      <button class="cp-brand__apply" @click=${h.onApplyBrand}>Apply brand to page</button>
    </div>
  `;
}

function renderSwatch(c: BrandColorSwatch, store: CanvasProStore): TemplateResult {
  return html`
    <div class="cp-brand__swatch">
      <input
        type="color"
        .value=${c.hex}
        @change=${(e: Event) =>
          updateSwatch(store, c.id, { hex: (e.target as HTMLInputElement).value })}
      />
      <input
        class="cp-brand__name"
        .value=${c.name}
        @change=${(e: Event) =>
          updateSwatch(store, c.id, { name: (e.target as HTMLInputElement).value })}
      />
      <button class="cp-brand__del" @click=${() => removeSwatch(store, c.id)}>×</button>
    </div>
  `;
}

function renderLogo(l: BrandLogo, store: CanvasProStore): TemplateResult {
  return html`
    <div class="cp-brand__logo">
      <img src=${l.src} alt=${l.name} />
      <input
        class="cp-brand__name"
        .value=${l.name}
        @change=${(e: Event) => {
          const kit = store.getDocument().brandKit;
          store.updateBrandKit({
            logos: kit.logos.map((x) =>
              x.id === l.id ? { ...x, name: (e.target as HTMLInputElement).value } : x
            ),
          });
        }}
      />
      <button
        class="cp-brand__del"
        @click=${() => {
          const kit = store.getDocument().brandKit;
          store.updateBrandKit({ logos: kit.logos.filter((x) => x.id !== l.id) });
        }}
      >×</button>
    </div>
  `;
}

function renderFontPair(f: BrandFontPair, store: CanvasProStore): TemplateResult {
  return html`
    <div class="cp-brand__fontpair">
      <input
        class="cp-brand__name"
        .value=${f.name}
        @change=${(e: Event) => updateFontPair(store, f.id, { name: (e.target as HTMLInputElement).value })}
      />
      <input
        class="cp-brand__font"
        .value=${f.heading}
        placeholder="Heading font"
        @change=${(e: Event) =>
          updateFontPair(store, f.id, { heading: (e.target as HTMLInputElement).value })}
      />
      <input
        class="cp-brand__font"
        .value=${f.body}
        placeholder="Body font"
        @change=${(e: Event) =>
          updateFontPair(store, f.id, { body: (e.target as HTMLInputElement).value })}
      />
      <button class="cp-brand__del" @click=${() => removeFontPair(store, f.id)}>×</button>
    </div>
  `;
}

function addColor(store: CanvasProStore) {
  const kit = store.getDocument().brandKit;
  store.updateBrandKit({
    colors: [...kit.colors, { id: uid("c"), name: "Untitled", hex: "#000000" }],
  });
}
function updateSwatch(store: CanvasProStore, id: string, patch: Partial<BrandColorSwatch>) {
  const kit = store.getDocument().brandKit;
  store.updateBrandKit({
    colors: kit.colors.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  });
}
function removeSwatch(store: CanvasProStore, id: string) {
  const kit = store.getDocument().brandKit;
  store.updateBrandKit({ colors: kit.colors.filter((c) => c.id !== id) });
}

function addFontPair(store: CanvasProStore) {
  const kit = store.getDocument().brandKit;
  store.updateBrandKit({
    fontPairs: [
      ...kit.fontPairs,
      { id: uid("f"), name: "Untitled", heading: "Inter", body: "Inter" },
    ],
  });
}
function updateFontPair(store: CanvasProStore, id: string, patch: Partial<BrandFontPair>) {
  const kit = store.getDocument().brandKit;
  store.updateBrandKit({
    fontPairs: kit.fontPairs.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  });
}
function removeFontPair(store: CanvasProStore, id: string) {
  const kit = store.getDocument().brandKit;
  store.updateBrandKit({ fontPairs: kit.fontPairs.filter((f) => f.id !== id) });
}

function addLogo(e: Event, store: CanvasProStore) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const kit = store.getDocument().brandKit;
    store.updateBrandKit({
      logos: [...kit.logos, { id: uid("l"), name: file.name, src: String(reader.result ?? "") }],
    });
    input.value = "";
  };
  reader.readAsDataURL(file);
}
