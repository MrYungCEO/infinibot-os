import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { PromptTemplate, PromptTemplatesState } from "../controllers/prompt-templates";
import {
  createPromptTemplatesState,
  loadTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  searchTemplates,
} from "../controllers/prompt-templates";
import { toSanitizedMarkdownHtml } from "../markdown";
import "../components/markdown-editor.js";
import { icon } from "../icons";
import { wgAurora, wgHero, wgEmpty } from "./work-glass";
import "./work-glass/prompt-templates.css";

// Styles live in ./work-glass/prompt-templates.css (scoped under `.ptg`).

// ── Helpers ──────────────────────────────────────────────────

function ptState(state: AppViewState): PromptTemplatesState {
  if (!(state as any)._ptState) {
    (state as any)._ptState = createPromptTemplatesState();
  }
  return (state as any)._ptState as PromptTemplatesState;
}

// An empty library is a valid, loaded state. Tracking initialization separately
// prevents an empty response from triggering a new request on every render.
const initializedStates = new WeakSet<PromptTemplatesState>();

function loadInitialTemplates(
  ps: PromptTemplatesState,
  state: AppViewState,
  gw: GatewayBrowserClient,
  force = false,
) {
  if (!force && initializedStates.has(ps)) return;
  initializedStates.add(ps);
  ps.loading = true;
  ps.error = null;
  loadTemplates(gw)
    .then((templates) => {
      ps.templates = templates;
      ps.loading = false;
      state.requestUpdate?.();
    })
    .catch((e) => {
      ps.error = String(e);
      ps.loading = false;
      state.requestUpdate?.();
    });
}

function allCategories(templates: PromptTemplate[]): string[] {
  const cats = new Set(templates.map((t) => t.category).filter(Boolean) as string[]);
  return Array.from(cats).sort();
}

function allTags(templates: PromptTemplate[]): string[] {
  const tags = new Set(templates.flatMap((t) => t.tags));
  return Array.from(tags).sort();
}

// ── Sub-renders ───────────────────────────────────────────────

function renderToolbar(
  ps: PromptTemplatesState,
  state: AppViewState,
  gw: GatewayBrowserClient,
) {
  const categories = allCategories(ps.templates);
  const tags = allTags(ps.templates);

  return html`
    <div class="wg-surface ptg-deck">
      <div class="ptg-deck__row">
        <label class="ptg-search">
          <span class="ptg-search__icon" aria-hidden="true">${icon("search")}</span>
          <input
            class="g-input ptg-search__input"
            aria-label="Search templates"
            placeholder="Search templates..."
            .value=${ps.searchQuery}
            @input=${async (e: Event) => {
              ps.searchQuery = (e.target as HTMLInputElement).value;
              if (ps.searchQuery.length > 1) {
                ps.templates = await searchTemplates(gw, ps.searchQuery);
              } else if (ps.searchQuery === "") {
                ps.templates = await loadTemplates(gw);
              }
              state.requestUpdate?.();
            }}
          />
        </label>
        ${categories.length > 0
          ? html`
              <select
                class="g-input ptg-select"
                aria-label="Filter by category"
                .value=${ps.filterCategory}
                @change=${(e: Event) => {
                  ps.filterCategory = (e.target as HTMLSelectElement).value;
                  state.requestUpdate?.();
                }}
              >
                <option value="">All categories</option>
                ${categories.map((c) => html`<option value=${c}>${c}</option>`)}
              </select>
            `
          : nothing}
      </div>

      ${tags.length > 0
        ? html`
            <div class="ptg-chips" role="group" aria-label="Filter by tag">
              <button
                class="ptg-chip ${ps.filterTag === "" ? "is-active" : ""}"
                aria-pressed=${ps.filterTag === ""}
                @click=${() => { ps.filterTag = ""; state.requestUpdate?.(); }}
              >All</button>
              ${tags.map((t) => html`
                <button
                  class="ptg-chip ${ps.filterTag === t ? "is-active" : ""}"
                  aria-pressed=${ps.filterTag === t}
                  @click=${() => { ps.filterTag = t; state.requestUpdate?.(); }}
                >${t}</button>
              `)}
            </div>
          `
        : nothing}
    </div>
  `;
}

function startCreate(ps: PromptTemplatesState, state: AppViewState) {
  ps.isCreating = true;
  ps.selected = null;
  ps.editing = true;
  ps.editorName = "";
  ps.editorDescription = "";
  ps.editorBody = "";
  ps.editorTags = "";
  ps.editorCategory = "";
  ps.dirty = false;
  state.requestUpdate?.();
}

function renderTemplateCard(
  t: PromptTemplate,
  ps: PromptTemplatesState,
  state: AppViewState,
) {
  const active = ps.selected?.id === t.id && !ps.isCreating;
  const select = () => {
    ps.selected = t;
    ps.isCreating = false;
    ps.editing = false;
    ps.editorName = t.name;
    ps.editorDescription = t.description;
    ps.editorBody = t.body;
    ps.editorTags = t.tags.join(", ");
    ps.editorCategory = t.category ?? "";
    ps.dirty = false;
    state.requestUpdate?.();
  };
  return html`
    <div
      class="ptg-item ${active ? "is-active" : ""}"
      role="button"
      tabindex="0"
      aria-current=${active ? "true" : "false"}
      @click=${select}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
      }}
    >
      <div class="ptg-item__name">${t.name}</div>
      ${t.description ? html`<div class="ptg-item__desc">${t.description}</div>` : nothing}
      <div class="ptg-tags">
        ${t.category ? html`<span class="ptg-cat">${t.category}</span>` : nothing}
        ${t.tags.slice(0, 4).map((tag) => html`<span class="ptg-tag">${tag}</span>`)}
      </div>
    </div>
  `;
}

function renderListPanel(
  ps: PromptTemplatesState,
  state: AppViewState,
) {
  let visible = ps.templates;
  if (ps.filterTag) visible = visible.filter((t) => t.tags.includes(ps.filterTag));
  if (ps.filterCategory) visible = visible.filter((t) => t.category === ps.filterCategory);

  return html`
    <div class="wg-surface ptg-list pt-list-panel">
      <div class="ptg-list__head">
        <span>Library</span>
        <span class="ptg-count">${visible.length}</span>
      </div>
      <div class="ptg-list__scroll">
        ${visible.length === 0
          ? wgEmpty({
              icon: icon("fileText"),
              title: ps.templates.length === 0 ? "No templates yet" : "No matches",
              body: ps.templates.length === 0
                ? "Save a prompt you reuse often and run it from anywhere."
                : "Try another search, tag or category.",
              action: ps.templates.length === 0
                ? html`<button class="g-btn g-btn--sm" @click=${() => startCreate(ps, state)}>${icon("plus")} New template</button>`
                : undefined,
            })
          : visible.map((t) => renderTemplateCard(t, ps, state))}
      </div>
    </div>
  `;
}

function renderDetailPanel(
  ps: PromptTemplatesState,
  state: AppViewState,
  gw: GatewayBrowserClient,
) {
  if (!ps.selected && !ps.isCreating) {
    return html`
      <div class="wg-surface ptg-detail pt-detail-panel">
        <div class="ptg-detail__empty">
          ${wgEmpty({
            icon: icon("clipboard"),
            title: "Select a template",
            body: "Pick one from the library to read or edit it, or start a new one.",
            action: html`<button class="g-btn g-btn--primary g-btn--sm" @click=${() => startCreate(ps, state)}>${icon("plus")} New template</button>`,
          })}
        </div>
      </div>
    `;
  }

  const t = ps.selected;
  const title = ps.isCreating ? "New Template" : t!.name;

  return html`
    <div class="wg-surface ptg-detail pt-detail-panel">
      <div class="ptg-detail__head">
        <div class="ptg-detail__titles">
          <div class="ptg-detail__eyebrow">${ps.editing ? (ps.isCreating ? "Create" : "Editing") : "Template"}</div>
          <h2 class="ptg-detail__title">${title}</h2>
        </div>
        <div class="ptg-detail__actions">
          ${ps.editing
            ? html`
                <button class="g-btn" @click=${() => {
                  ps.editing = false;
                  ps.isCreating = false;
                  if (t) {
                    ps.editorName = t.name;
                    ps.editorDescription = t.description;
                    ps.editorBody = t.body;
                    ps.editorTags = t.tags.join(", ");
                    ps.editorCategory = t.category ?? "";
                  }
                  ps.dirty = false;
                  state.requestUpdate?.();
                }}>Cancel</button>
                <button
                  class="g-btn g-btn--primary"
                  ?disabled=${ps.saving || !ps.editorName}
                  @click=${async () => {
                    if (!ps.editorName) return;
                    ps.saving = true;
                    state.requestUpdate?.();
                    try {
                      const tags = ps.editorTags
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      const payload = {
                        name: ps.editorName,
                        description: ps.editorDescription,
                        body: ps.editorBody,
                        tags,
                        category: ps.editorCategory || undefined,
                      };
                      if (ps.isCreating) {
                        const created = await createTemplate(gw, payload);
                        ps.templates = await loadTemplates(gw);
                        ps.selected = created;
                        ps.isCreating = false;
                      } else {
                        const updated = await updateTemplate(gw, t!.id, payload);
                        const idx = ps.templates.findIndex((x) => x.id === t!.id);
                        if (idx >= 0) ps.templates[idx] = updated;
                        ps.selected = updated;
                      }
                      ps.editing = false;
                      ps.dirty = false;
                      ps.successMessage = "Saved";
                      setTimeout(() => { ps.successMessage = null; state.requestUpdate?.(); }, 2000);
                    } catch (e) {
                      ps.error = String(e);
                    }
                    ps.saving = false;
                    state.requestUpdate?.();
                  }}
                >${icon("check")} ${ps.saving ? "Saving…" : "Save"}</button>
              `
            : html`
                <button class="g-btn" @click=${() => {
                  ps.editing = true;
                  state.requestUpdate?.();
                }}>${icon("edit")} Edit</button>
                <button class="g-btn g-btn--icon ptg-danger" title="Delete template" aria-label="Delete template" @click=${async () => {
                  if (!t) return;
                  if (!confirm(`Delete "${t.name}"? This cannot be undone.`)) return;
                  await deleteTemplate(gw, t.id);
                  ps.templates = ps.templates.filter((x) => x.id !== t.id);
                  ps.selected = null;
                  ps.editing = false;
                  state.requestUpdate?.();
                }}>${icon("trash")}</button>
              `}
        </div>
      </div>

      <div class="ptg-detail__body">
        ${ps.successMessage ? html`<div class="ptg-msg ptg-msg--ok" role="status">${icon("checkCircle")} ${ps.successMessage}</div>` : nothing}
        ${ps.error ? html`<div class="ptg-msg ptg-msg--err" role="alert">${ps.error}</div>` : nothing}

        ${ps.editing ? renderEditForm(ps, state) : renderViewMode(t!)}
      </div>
    </div>
  `;
}

function renderEditForm(ps: PromptTemplatesState, state: AppViewState) {
  return html`
    <div class="ptg-form">
      <label class="ptg-field">
        <span class="ptg-label">Name *</span>
        <input
          class="g-input"
          .value=${ps.editorName}
          placeholder="Template name..."
          @input=${(e: Event) => {
            ps.editorName = (e.target as HTMLInputElement).value;
            ps.dirty = true;
            state.requestUpdate?.();
          }}
        />
      </label>

      <label class="ptg-field">
        <span class="ptg-label">Description</span>
        <textarea
          class="g-input"
          .value=${ps.editorDescription}
          placeholder="Brief description..."
          @input=${(e: Event) => {
            ps.editorDescription = (e.target as HTMLTextAreaElement).value;
            ps.dirty = true;
          }}
        ></textarea>
      </label>

      <div class="ptg-form__grid pt-tags-category-grid">
        <label class="ptg-field">
          <span class="ptg-label">Tags (comma-separated)</span>
          <input
            class="g-input"
            .value=${ps.editorTags}
            placeholder="ui, style, agent..."
            @input=${(e: Event) => {
              ps.editorTags = (e.target as HTMLInputElement).value;
              ps.dirty = true;
            }}
          />
        </label>
        <label class="ptg-field">
          <span class="ptg-label">Category</span>
          <input
            class="g-input"
            .value=${ps.editorCategory}
            placeholder="e.g. UI Upgrades"
            @input=${(e: Event) => {
              ps.editorCategory = (e.target as HTMLInputElement).value;
              ps.dirty = true;
            }}
          />
        </label>
      </div>

      <div class="ptg-field">
        <span class="ptg-label">Body (Markdown)</span>
        <moltbot-markdown-editor
          .value=${ps.editorBody}
          placeholder="Write the template body in Markdown..."
          .minRows=${12}
          @change=${(e: CustomEvent<{ value: string }>) => {
            ps.editorBody = e.detail.value;
            ps.dirty = true;
          }}
        ></moltbot-markdown-editor>
      </div>
    </div>
  `;
}

function renderViewMode(t: PromptTemplate) {
  const rendered = toSanitizedMarkdownHtml(t.body || "");
  return html`
    <div class="ptg-meta">
      ${t.category ? html`<span class="ptg-cat">${t.category}</span>` : nothing}
      ${t.tags.map((tag) => html`<span class="ptg-tag">${tag}</span>`)}
      <span class="ptg-meta__date">
        Updated ${new Date(t.updatedAt).toLocaleDateString()}
      </span>
    </div>
    ${t.description ? html`<p class="ptg-desc">${t.description}</p>` : nothing}
    <div class="wg-card ptg-body-card">
      <div class="markdown-body ptg-md">
        ${unsafeHTML(rendered)}
      </div>
    </div>
  `;
}

function renderSkeleton() {
  return html`
    <div class="pt-body ptg-body" aria-busy="true" aria-label="Loading templates">
      <div class="wg-surface ptg-list">
        <div class="ptg-skel-list">
          ${[0, 1, 2, 3].map(() => html`
            <div class="ptg-skel-item">
              <div class="wg-skel" style="height:14px;width:70%"></div>
              <div class="wg-skel" style="height:10px;width:92%"></div>
              <div class="wg-skel" style="height:10px;width:40%"></div>
            </div>
          `)}
        </div>
      </div>
      <div class="wg-surface ptg-detail">
        <div class="ptg-skel-detail">
          <div class="wg-skel" style="height:22px;width:40%"></div>
          <div class="wg-skel" style="height:12px;width:80%"></div>
          <div class="wg-skel" style="height:180px;width:100%"></div>
        </div>
      </div>
    </div>
  `;
}

// ── Main export ──────────────────────────────────────────────

export function renderPromptTemplates(
  state: AppViewState,
  gw: GatewayBrowserClient,
) {
  const ps = ptState(state);

  if (!ps.loading && !initializedStates.has(ps)) loadInitialTemplates(ps, state, gw);

  const categoryCount = allCategories(ps.templates).length;

  return html`
    <div class="wg-page ptg">
      ${wgAurora()}
      ${wgHero({
        eyebrow: "Workflows · Library",
        title: html`Prompt <span class="wg-gold">templates</span>`,
        sub: html`Reusable instructions for agents and chats.
          <span class="ptg-hero-stat">${ps.templates.length} template${ps.templates.length === 1 ? "" : "s"}${categoryCount ? html` · ${categoryCount} categor${categoryCount === 1 ? "y" : "ies"}` : nothing}</span>`,
        actions: html`<button class="g-btn g-btn--primary" @click=${() => startCreate(ps, state)}>${icon("plus")} New Template</button>`,
      })}
      ${ps.error
        ? html`<div class="ptg-msg ptg-msg--err" role="alert">
            ${icon("alertCircle")}
            <span>${ps.error}</span>
            <button class="g-btn g-btn--sm" @click=${() => loadInitialTemplates(ps, state, gw, true)}>Retry</button>
          </div>`
        : nothing}
      ${renderToolbar(ps, state, gw)}
      ${ps.loading
        ? renderSkeleton()
        : html`
            <div class="pt-body ptg-body">
              ${renderListPanel(ps, state)}
              ${renderDetailPanel(ps, state, gw)}
            </div>
          `}
    </div>
  `;
}
