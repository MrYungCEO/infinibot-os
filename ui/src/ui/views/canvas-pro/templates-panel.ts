/**
 * Left-rail Templates panel. Lists registry templates grouped by
 * category. Clicking a template either replaces the active page's
 * scene + size + background, or adds a new page from the template,
 * depending on the user's choice.
 */

import { html } from "lit";
import type { TemplateResult } from "lit";
import type { CanvasProStore } from "./store";
import {
  type CanvasTemplate,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
  loadTemplates,
} from "./templates-registry";

export type TemplatesPanelState = {
  category: TemplateCategory | "all";
  templates: CanvasTemplate[];
  loading: boolean;
};

export function createTemplatesPanelState(): TemplatesPanelState {
  return { category: "all", templates: [], loading: true };
}

export async function refreshTemplates(state: TemplatesPanelState): Promise<TemplatesPanelState> {
  const templates = await loadTemplates();
  return { ...state, templates, loading: false };
}

export type TemplatesPanelHandlers = {
  /** Inject template into active page (replaces scene) or new page. */
  onApply: (tpl: CanvasTemplate, mode: "replace" | "new-page") => void;
  onCategoryChange: (cat: TemplateCategory | "all") => void;
};

export function renderTemplatesPanel(
  state: TemplatesPanelState,
  _store: CanvasProStore,
  h: TemplatesPanelHandlers
): TemplateResult {
  const filtered =
    state.category === "all"
      ? state.templates
      : state.templates.filter((t) => t.category === state.category);

  return html`
    <div class="cp-templates">
      <div class="cp-templates__cats">
        <button
          class="cp-templates__cat ${state.category === "all" ? "is-active" : ""}"
          @click=${() => h.onCategoryChange("all")}
        >All</button>
        ${TEMPLATE_CATEGORIES.map(
          (c) => html`
            <button
              class="cp-templates__cat ${state.category === c.id ? "is-active" : ""}"
              @click=${() => h.onCategoryChange(c.id)}
            >${c.label}</button>
          `
        )}
      </div>
      ${state.loading
        ? html`<div class="cp-rail__empty">Loading…</div>`
        : filtered.length === 0
        ? html`<div class="cp-rail__empty">No templates in this category</div>`
        : html`
            <div class="cp-templates__grid">
              ${filtered.map((tpl) => renderTemplateCard(tpl, h))}
            </div>
          `}
    </div>
  `;
}

function renderTemplateCard(tpl: CanvasTemplate, h: TemplatesPanelHandlers): TemplateResult {
  return html`
    <div class="cp-templates__card">
      <div
        class="cp-templates__thumb"
        style="background:${tpl.background};aspect-ratio:${tpl.width}/${tpl.height}"
      >
        <span>${tpl.name}</span>
      </div>
      <div class="cp-templates__actions">
        <button @click=${() => h.onApply(tpl, "replace")} title="Replace current page">Use</button>
        <button @click=${() => h.onApply(tpl, "new-page")} title="Add as new page">+</button>
      </div>
    </div>
  `;
}
