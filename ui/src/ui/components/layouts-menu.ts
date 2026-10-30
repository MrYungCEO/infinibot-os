// ============================================================
// Shared "Layouts" dropdown menu
// ============================================================
//
// The markup + interaction for the Layouts dropdown used by both the
// masonry-grid view and the terminals view. Keeping the template here means the
// two views can never drift. masonry-grid passes no `quickPresets`, so its menu
// renders byte-identically to the original inline implementation.

import { html, type TemplateResult } from "lit";

/** A built-in quick layout (1-up / 2-col / 3-col / 2x2 / focus-left …). */
export interface LayoutsMenuQuickPreset {
  id: string;
  label: string;
  icon: string;
}

/** View-model for one saved user preset row. */
export interface LayoutsMenuSavedPreset {
  name: string;
  count: number;
  savedAt: number;
}

export interface LayoutsMenuLabels {
  /** Section header above the quick-layout buttons (when any are present). */
  quickSection: string;
  /** Section header above the "Save as preset…" button. */
  currentSection: string;
  /** "Save as preset…" button text. */
  save: string;
  /** Header for the saved list — receives the count. */
  savedSection: (count: number) => string;
  /** Delete-button tooltip. */
  deleteTitle: string;
  /** Unit shown in each saved row's tooltip (e.g. "panels" / "terminals"). */
  countUnit: string;
}

export interface LayoutsMenuOptions {
  quickPresets?: LayoutsMenuQuickPreset[];
  savedPresets: LayoutsMenuSavedPreset[];
  labels: LayoutsMenuLabels;
  onApplyQuick?: (id: string) => void;
  onSave: () => void;
  onApply: (name: string) => void;
  onDelete: (name: string, e: Event) => void;
}

/**
 * Render the Layouts dropdown body. The caller owns the open/closed guard and
 * positioning wrapper (`.layouts-dropdown-wrapper`).
 */
export function renderLayoutsMenu(opts: LayoutsMenuOptions): TemplateResult {
  const { quickPresets, savedPresets, labels } = opts;
  const hasQuick = !!quickPresets && quickPresets.length > 0;
  return html`
    <div class="layouts-menu" @click=${(e: Event) => e.stopPropagation()}>
      ${hasQuick
        ? html`
            <div class="layouts-menu__section-label">${labels.quickSection}</div>
            ${quickPresets!.map(
              (q) => html`
                <button
                  class="layouts-menu__item"
                  @click=${() => opts.onApplyQuick?.(q.id)}
                >
                  <span class="layouts-menu__icon">${q.icon}</span>
                  <span class="layouts-menu__title">${q.label}</span>
                </button>
              `,
            )}
            <div class="layouts-menu__sep"></div>
          `
        : ""}
      <div class="layouts-menu__section-label">${labels.currentSection}</div>
      <button class="layouts-menu__item" @click=${() => opts.onSave()}>
        <span class="layouts-menu__icon">💾</span><span>${labels.save}</span>
      </button>
      <div class="layouts-menu__sep"></div>
      <div class="layouts-menu__section-label">
        ${labels.savedSection(savedPresets.length)}
      </div>
      ${savedPresets.map(
        (p) => html`
          <div class="layouts-menu__row">
            <button
              class="layouts-menu__item layouts-menu__item--main"
              @click=${() => opts.onApply(p.name)}
              title="${new Date(p.savedAt).toLocaleString()} · ${p.count} ${labels.countUnit}"
            >
              <span class="layouts-menu__icon">📐</span>
              <span class="layouts-menu__title">${p.name}</span>
              <span class="layouts-menu__meta">${p.count}</span>
            </button>
            <button
              class="layouts-menu__del"
              title="${labels.deleteTitle}"
              @click=${(e: Event) => opts.onDelete(p.name, e)}
            >
              ✕
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

/**
 * The CSS rules for the dropdown, as a raw string for views that build their
 * styles via an html`<style>` template (e.g. the terminals view). The
 * masonry-grid view keeps its own identical copy inside its `static styles`.
 */
export const LAYOUTS_MENU_CSS = `
  .layouts-dropdown-wrapper { position: relative; }
  .layouts-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    min-width: 260px;
    max-height: 420px;
    overflow-y: auto;
    background: rgba(10, 10, 12, 0.97);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
    border-radius: 10px;
    padding: 6px;
    box-shadow: 0 18px 50px rgba(0,0,0,0.65), 0 0 0 1px rgba(0,0,0,0.5);
    z-index: 1000;
  }
  .layouts-menu__section-label {
    font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase;
    color: rgba(255,255,255,0.4);
    padding: 6px 10px 4px; font-weight: 700;
  }
  .layouts-menu__sep {
    height: 1px;
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    margin: 4px 6px;
  }
  .layouts-menu__row { display: flex; align-items: stretch; gap: 2px; }
  .layouts-menu__item {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 10px;
    border: 1px solid transparent; border-radius: 6px;
    background: transparent; color: rgba(255,255,255,0.85);
    font-size: 12px; font-family: inherit; text-align: left;
    cursor: pointer; transition: all 0.12s; flex: 1; min-width: 0;
  }
  .layouts-menu__item:hover {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
    color: var(--c-accent, var(--g-primary));
  }
  .layouts-menu__icon { flex-shrink: 0; font-size: 13px; width: 16px; text-align: center; }
  .layouts-menu__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .layouts-menu__meta {
    flex-shrink: 0;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    color: color-mix(in srgb, var(--g-primary) 80%, transparent);
  }
  .layouts-menu__del {
    width: 26px; flex-shrink: 0;
    border: 1px solid transparent; border-radius: 6px;
    background: transparent; color: rgba(255,255,255,0.35);
    cursor: pointer; font-size: 11px;
  }
  .layouts-menu__del:hover {
    background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.4);
    color: #ef4444;
  }
`;
