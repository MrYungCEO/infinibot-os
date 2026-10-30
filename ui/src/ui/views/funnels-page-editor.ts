/**
 * Funnels Page Editor — workspace-style editor for the public lead-capture
 * page that ships with each funnel.
 *
 * Layout mirrors the per-composition workspace pattern:
 *
 *   ┌──────────────┬──────────────────────────────┬────────────┐
 *   │ section nav  │  editor pane                 │ preview    │
 *   │ (settings,   │  (forms keyed off page.json) │ iframe     │
 *   │  copy,       │                              │            │
 *   │  fields,     │                              │            │
 *   │  theme,      │                              │            │
 *   │  submissions,│                              │            │
 *   │  preview)    │                              │            │
 *   └──────────────┴──────────────────────────────┴────────────┘
 *
 * The editor pane talks to the controller in
 * ../controllers/funnels.ts which maps to the gateway methods
 * `funnels.page.config.get`, `.set`, `.publish`, `.preview`,
 * `.submissions` — i.e. the same workspace contract used by
 * compositions / kanban / storyboard.
 */

import { html, nothing, type TemplateResult } from "lit";
import "../components/doc-agent-panel.js";
import type { Funnel } from "./funnels-canvas";
import {
  addPageBullet,
  addPageField,
  deletePageBullet,
  deletePageField,
  loadPageConfig,
  loadPagePreview,
  loadPageSubmissions,
  movePageField,
  patchPageConfig,
  patchPageTheme,
  resetPageEditor,
  savePageConfig,
  setPageEditorSection,
  togglePagePublished,
  updatePageBullet,
  updatePageField,
  type PageConfig,
  type PageEditorSection,
  type PageEditorState,
  type PageField,
  type PageFieldKind,
  type SubmissionLogEntry,
} from "../controllers/funnels";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelPageEditorProps {
  funnel: Funnel | null;
  editor: PageEditorState;
  requestUpdate: () => void;
  /**
   * Gateway client — optional so existing call sites don't need to be
   * updated. When provided, the editor mounts a doc-agent panel scoped to
   * the open funnel page.
   */
  client?: { request: (method: string, params: any) => Promise<any> } | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelPageEditor(props: FunnelPageEditorProps): TemplateResult {
  const { funnel, editor, client } = props;

  // No funnel selected — guide the user.
  if (!funnel) {
    return html`
      <style>${pageEditorStyles}</style>
      <div class="page-editor page-editor--empty">
        <div class="page-editor__empty-card">
          <div class="page-editor__empty-icon">📄</div>
          <h2>Select a funnel</h2>
          <p>Pick a funnel from the sidebar to open its lead-capture page workspace.</p>
        </div>
      </div>
    `;
  }

  // Lazy-load the config the first time this funnel becomes active.
  if (editor.funnelId !== funnel.id && !editor.loading) {
    void loadPageConfig(funnel.id);
  }

  if (editor.loading || !editor.config) {
    return html`
      <style>${pageEditorStyles}</style>
      <div class="page-editor page-editor--loading">
        <div class="page-editor__spinner"></div>
        <span>Loading page workspace…</span>
      </div>
    `;
  }

  const cfg = editor.config;

  return html`
    <style>${pageEditorStyles}</style>
    ${client
      ? html`<doc-agent-panel
          .client=${client as any}
          docType="funnel_page"
          .documentId=${funnel.id}
          .title=${(cfg as any).title ?? (cfg as any).headline ?? funnel.name}
          .extra=${`funnelId=${funnel.id} slug=${(cfg as any).slug ?? "(none)"} published=${(cfg as any).published ? "yes" : "no"}`}
        ></doc-agent-panel>`
      : nothing}
    <div class="page-editor">
      ${renderSidebar(funnel, cfg, editor)}
      <div class="page-editor__main">
        ${renderToolbar(funnel, cfg, editor)}
        <div class="page-editor__body">
          ${renderSection(funnel, cfg, editor, props)}
        </div>
      </div>
      ${editor.section !== "preview" ? renderSidePreview(funnel, editor) : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Sidebar (section nav + workspace tree summary)
// ══════════════════════════════════════════════════════════════════════════════

const SECTIONS: Array<{ id: PageEditorSection; label: string; icon: string; hint: string }> = [
  { id: "settings", label: "Settings", icon: "⚙", hint: "Slug + status + meta" },
  { id: "copy", label: "Copy", icon: "✎", hint: "Headline, sub, bullets, CTA" },
  { id: "fields", label: "Form fields", icon: "▤", hint: "Inputs collected on submit" },
  { id: "theme", label: "Theme", icon: "◐", hint: "Colors, fonts, logo" },
  { id: "submissions", label: "Submissions", icon: "✉", hint: "Recent form posts" },
  { id: "preview", label: "Preview", icon: "▷", hint: "Rendered HTML" },
];

function renderSidebar(funnel: Funnel, cfg: PageConfig, editor: PageEditorState): TemplateResult {
  return html`
    <aside class="page-editor__sidebar">
      <div class="page-editor__sidebar-header">
        <div class="page-editor__sidebar-eyebrow">FUNNEL WORKSPACE</div>
        <div class="page-editor__sidebar-title">${funnel.name}</div>
        <div class="page-editor__sidebar-path">
          state/funnels/${funnel.id.slice(0, 8)}…/
        </div>
      </div>

      <div class="page-editor__sidebar-status">
        <span class="page-editor__status-dot ${cfg.published ? "is-live" : "is-draft"}"></span>
        <span>${cfg.published ? "LIVE" : "DRAFT"}</span>
        ${cfg.published
          ? html`<a class="page-editor__status-link" href="/p/funnels/${cfg.slug}" target="_blank" rel="noopener">/p/funnels/${cfg.slug} ↗</a>`
          : html`<span class="page-editor__status-muted">unpublished</span>`}
      </div>

      <nav class="page-editor__nav">
        ${SECTIONS.map(
          (s) => html`
            <button
              class="page-editor__nav-btn ${editor.section === s.id ? "is-active" : ""}"
              @click=${() => setPageEditorSection(s.id)}
            >
              <span class="page-editor__nav-icon">${s.icon}</span>
              <span class="page-editor__nav-label">
                <span class="page-editor__nav-name">${s.label}</span>
                <span class="page-editor__nav-hint">${s.hint}</span>
              </span>
            </button>
          `,
        )}
      </nav>

      <div class="page-editor__sidebar-tree">
        <div class="page-editor__tree-header">workspace</div>
        <ul class="page-editor__tree">
          <li><span class="page-editor__tree-file">page.json</span></li>
          <li><span class="page-editor__tree-dir">assets/</span></li>
          <li><span class="page-editor__tree-dir">templates/</span></li>
          <li><span class="page-editor__tree-dir">sop/</span></li>
          <li><span class="page-editor__tree-file">submissions.jsonl</span></li>
        </ul>
      </div>
    </aside>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Toolbar (save / publish / dirty indicator)
// ══════════════════════════════════════════════════════════════════════════════

function renderToolbar(funnel: Funnel, cfg: PageConfig, editor: PageEditorState): TemplateResult {
  const updatedAgo = formatRelative(cfg.updatedAt);
  return html`
    <div class="page-editor__toolbar">
      <div class="page-editor__breadcrumb">
        <span class="page-editor__crumb">page.json</span>
        <span class="page-editor__crumb-sep">›</span>
        <span class="page-editor__crumb-leaf">${SECTIONS.find((s) => s.id === editor.section)?.label}</span>
      </div>
      <div class="page-editor__toolbar-status">
        ${editor.dirty
          ? html`<span class="page-editor__pill page-editor__pill--warn">unsaved changes</span>`
          : html`<span class="page-editor__pill page-editor__pill--ok">saved · ${updatedAgo}</span>`}
        ${editor.error ? html`<span class="page-editor__pill page-editor__pill--err" title=${editor.error}>error</span>` : nothing}
      </div>
      <div class="page-editor__toolbar-actions">
        <button
          class="page-editor__btn page-editor__btn--ghost"
          @click=${() => loadPageConfig(funnel.id)}
          ?disabled=${editor.saving || editor.loading}
          title="Reload from disk"
        >
          ↻ Reload
        </button>
        <button
          class="page-editor__btn page-editor__btn--primary"
          @click=${() => savePageConfig()}
          ?disabled=${!editor.dirty || editor.saving}
        >
          ${editor.saving ? "Saving…" : "Save"}
        </button>
        <button
          class="page-editor__btn ${cfg.published ? "page-editor__btn--danger" : "page-editor__btn--accent"}"
          @click=${() => togglePagePublished()}
          ?disabled=${editor.saving}
        >
          ${cfg.published ? "Unpublish" : "Publish"}
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Section content
// ══════════════════════════════════════════════════════════════════════════════

function renderSection(
  funnel: Funnel,
  cfg: PageConfig,
  editor: PageEditorState,
  props: FunnelPageEditorProps,
): TemplateResult {
  switch (editor.section) {
    case "settings":
      return renderSettings(cfg);
    case "copy":
      return renderCopy(cfg, props);
    case "fields":
      return renderFields(cfg, props);
    case "theme":
      return renderTheme(cfg);
    case "submissions":
      return renderSubmissions(funnel, editor);
    case "preview":
      return renderPreviewPane(funnel, editor);
  }
}

// ── Settings ─────────────────────────────────────────────────

function renderSettings(cfg: PageConfig): TemplateResult {
  return html`
    <div class="page-editor__form">
      <h3 class="page-editor__section-title">Settings</h3>
      <p class="page-editor__section-sub">URL slug, browser title, and metadata.</p>

      <label class="page-editor__field">
        <span class="page-editor__label">Public slug</span>
        <div class="page-editor__url-wrap">
          <span class="page-editor__url-prefix">/p/funnels/</span>
          <input
            class="page-editor__input"
            type="text"
            .value=${cfg.slug}
            @input=${(e: Event) => patchPageConfig({ slug: slugify((e.target as HTMLInputElement).value) })}
          />
        </div>
        <span class="page-editor__hint">Letters, numbers, dashes only. Lower-cased automatically.</span>
      </label>

      <label class="page-editor__field">
        <span class="page-editor__label">Browser title</span>
        <input
          class="page-editor__input"
          type="text"
          .value=${cfg.title}
          @input=${(e: Event) => patchPageConfig({ title: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="page-editor__field">
        <span class="page-editor__label">Honeypot field name</span>
        <input
          class="page-editor__input"
          type="text"
          .value=${cfg.honeypotField ?? ""}
          @input=${(e: Event) => patchPageConfig({ honeypotField: (e.target as HTMLInputElement).value })}
          placeholder="company_url"
        />
        <span class="page-editor__hint">Hidden field bots fill in. Submissions with this field set are silently dropped.</span>
      </label>

      <label class="page-editor__field">
        <span class="page-editor__label">Default owner ID</span>
        <input
          class="page-editor__input"
          type="text"
          .value=${(cfg.meta?.defaultOwnerId as string | undefined) ?? ""}
          @input=${(e: Event) =>
            patchPageConfig({ meta: { ...cfg.meta, defaultOwnerId: (e.target as HTMLInputElement).value } })}
          placeholder="user-id"
        />
        <span class="page-editor__hint">Optional — leads from this page get auto-assigned. Leave blank for round-robin.</span>
      </label>
    </div>
  `;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── Copy ─────────────────────────────────────────────────────

function renderCopy(cfg: PageConfig, props: FunnelPageEditorProps): TemplateResult {
  return html`
    <div class="page-editor__form">
      <h3 class="page-editor__section-title">Copy</h3>
      <p class="page-editor__section-sub">Headline, body, bullets, and the post-submit thank-you.</p>

      <label class="page-editor__field">
        <span class="page-editor__label">Headline</span>
        <input
          class="page-editor__input page-editor__input--lg"
          type="text"
          .value=${cfg.headline}
          @input=${(e: Event) => patchPageConfig({ headline: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="page-editor__field">
        <span class="page-editor__label">Subheadline</span>
        <textarea
          class="page-editor__textarea"
          rows="2"
          .value=${cfg.subheadline}
          @input=${(e: Event) => patchPageConfig({ subheadline: (e.target as HTMLTextAreaElement).value })}
        ></textarea>
      </label>

      <div class="page-editor__field">
        <div class="page-editor__label-row">
          <span class="page-editor__label">Bullets</span>
          <button class="page-editor__chip-btn" @click=${() => { addPageBullet(); props.requestUpdate(); }}>
            + Add bullet
          </button>
        </div>
        ${cfg.bullets.length === 0
          ? html`<div class="page-editor__empty-row">No bullets — click <em>Add bullet</em> to list features above the form.</div>`
          : html`
              <div class="page-editor__bullets">
                ${cfg.bullets.map(
                  (b, i) => html`
                    <div class="page-editor__bullet-row">
                      <span class="page-editor__bullet-marker">•</span>
                      <input
                        class="page-editor__input"
                        type="text"
                        .value=${b}
                        @input=${(e: Event) => updatePageBullet(i, (e.target as HTMLInputElement).value)}
                      />
                      <button class="page-editor__icon-btn" @click=${() => deletePageBullet(i)} title="Remove">✕</button>
                    </div>
                  `,
                )}
              </div>
            `}
      </div>

      <label class="page-editor__field">
        <span class="page-editor__label">CTA button</span>
        <input
          class="page-editor__input"
          type="text"
          .value=${cfg.cta}
          @input=${(e: Event) => patchPageConfig({ cta: (e.target as HTMLInputElement).value })}
        />
      </label>

      <div class="page-editor__divider"></div>

      <label class="page-editor__field">
        <span class="page-editor__label">Thank-you redirect URL</span>
        <input
          class="page-editor__input"
          type="text"
          placeholder="(blank → show inline thank-you)"
          .value=${cfg.thankYouUrl}
          @input=${(e: Event) => patchPageConfig({ thankYouUrl: (e.target as HTMLInputElement).value })}
        />
      </label>

      ${cfg.thankYouUrl
        ? nothing
        : html`
            <label class="page-editor__field">
              <span class="page-editor__label">Inline thank-you headline</span>
              <input
                class="page-editor__input"
                type="text"
                .value=${cfg.thankYouHeadline}
                @input=${(e: Event) => patchPageConfig({ thankYouHeadline: (e.target as HTMLInputElement).value })}
              />
            </label>
            <label class="page-editor__field">
              <span class="page-editor__label">Inline thank-you body</span>
              <textarea
                class="page-editor__textarea"
                rows="3"
                .value=${cfg.thankYouBody}
                @input=${(e: Event) => patchPageConfig({ thankYouBody: (e.target as HTMLTextAreaElement).value })}
              ></textarea>
            </label>
          `}
    </div>
  `;
}

// ── Form fields ──────────────────────────────────────────────

const FIELD_KIND_OPTIONS: PageFieldKind[] = ["text", "email", "phone", "textarea", "select", "checkbox", "hidden"];

function renderFields(cfg: PageConfig, props: FunnelPageEditorProps): TemplateResult {
  return html`
    <div class="page-editor__form">
      <div class="page-editor__section-head">
        <div>
          <h3 class="page-editor__section-title">Form fields</h3>
          <p class="page-editor__section-sub">Each field maps to a Lead property. Use stable IDs (<code>name</code>, <code>email</code>, <code>phone</code>, <code>company</code>, <code>title</code>) to populate built-in columns; everything else lands in <code>customFields</code>.</p>
        </div>
        <button class="page-editor__btn page-editor__btn--accent" @click=${() => { addPageField(); props.requestUpdate(); }}>
          + Add field
        </button>
      </div>

      ${cfg.fields.length === 0
        ? html`<div class="page-editor__empty-row">No fields. Add at least one input — usually <code>email</code>.</div>`
        : html`
            <div class="page-editor__fields">
              ${cfg.fields.map((field, i) => renderFieldRow(field, i, cfg.fields.length))}
            </div>
          `}
    </div>
  `;
}

function renderFieldRow(field: PageField, index: number, total: number): TemplateResult {
  return html`
    <div class="page-editor__field-card">
      <div class="page-editor__field-card-head">
        <div class="page-editor__field-card-meta">
          <span class="page-editor__field-index">#${index + 1}</span>
          <span class="page-editor__field-id">${field.id}</span>
          <span class="page-editor__field-kind">${field.kind}</span>
          ${field.required ? html`<span class="page-editor__pill page-editor__pill--info">required</span>` : nothing}
        </div>
        <div class="page-editor__field-card-ops">
          <button
            class="page-editor__icon-btn"
            ?disabled=${index === 0}
            @click=${() => movePageField(index, -1)}
            title="Move up"
          >↑</button>
          <button
            class="page-editor__icon-btn"
            ?disabled=${index === total - 1}
            @click=${() => movePageField(index, 1)}
            title="Move down"
          >↓</button>
          <button class="page-editor__icon-btn page-editor__icon-btn--danger" @click=${() => deletePageField(index)} title="Delete">✕</button>
        </div>
      </div>

      <div class="page-editor__field-card-body">
        <label class="page-editor__field page-editor__field--inline">
          <span class="page-editor__label">ID</span>
          <input
            class="page-editor__input"
            type="text"
            .value=${field.id}
            @input=${(e: Event) => updatePageField(index, { id: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="page-editor__field page-editor__field--inline">
          <span class="page-editor__label">Label</span>
          <input
            class="page-editor__input"
            type="text"
            .value=${field.label}
            @input=${(e: Event) => updatePageField(index, { label: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="page-editor__field page-editor__field--inline">
          <span class="page-editor__label">Kind</span>
          <select
            class="page-editor__select"
            .value=${field.kind}
            @change=${(e: Event) => updatePageField(index, { kind: (e.target as HTMLSelectElement).value as PageFieldKind })}
          >
            ${FIELD_KIND_OPTIONS.map((k) => html`<option value=${k} ?selected=${field.kind === k}>${k}</option>`)}
          </select>
        </label>
        <label class="page-editor__field page-editor__field--inline">
          <span class="page-editor__label">Placeholder</span>
          <input
            class="page-editor__input"
            type="text"
            .value=${field.placeholder ?? ""}
            @input=${(e: Event) => updatePageField(index, { placeholder: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="page-editor__field page-editor__field--checkbox">
          <input
            type="checkbox"
            .checked=${!!field.required}
            @change=${(e: Event) => updatePageField(index, { required: (e.target as HTMLInputElement).checked })}
          />
          <span>Required</span>
        </label>
        ${field.kind === "hidden"
          ? html`
              <label class="page-editor__field page-editor__field--inline">
                <span class="page-editor__label">Default value</span>
                <input
                  class="page-editor__input"
                  type="text"
                  .value=${field.defaultValue ?? ""}
                  @input=${(e: Event) => updatePageField(index, { defaultValue: (e.target as HTMLInputElement).value })}
                />
              </label>
            `
          : nothing}
        ${field.kind === "select"
          ? html`
              <label class="page-editor__field page-editor__field--inline page-editor__field--full">
                <span class="page-editor__label">Options (label=value, one per line)</span>
                <textarea
                  class="page-editor__textarea"
                  rows="3"
                  .value=${(field.options ?? []).map((o) => `${o.label}=${o.value}`).join("\n")}
                  @input=${(e: Event) => updatePageField(index, { options: parseOptions((e.target as HTMLTextAreaElement).value) })}
                ></textarea>
              </label>
            `
          : nothing}
      </div>
    </div>
  `;
}

function parseOptions(raw: string): Array<{ label: string; value: string }> {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("=");
      if (idx < 0) return { label: line, value: line };
      return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    });
}

// ── Theme ────────────────────────────────────────────────────

function renderTheme(cfg: PageConfig): TemplateResult {
  return html`
    <div class="page-editor__form">
      <h3 class="page-editor__section-title">Theme</h3>
      <p class="page-editor__section-sub">Branding for the rendered page. Logo lives in <code>assets/</code> — upload via the workspace tools and reference the filename here.</p>

      <div class="page-editor__color-grid">
        ${renderColorField("Primary", cfg.theme.primaryColor, (v) => patchPageTheme({ primaryColor: v }))}
        ${renderColorField("Background", cfg.theme.bgColor, (v) => patchPageTheme({ bgColor: v }))}
        ${renderColorField("Text", cfg.theme.textColor, (v) => patchPageTheme({ textColor: v }))}
      </div>

      <label class="page-editor__field">
        <span class="page-editor__label">Font stack</span>
        <input
          class="page-editor__input"
          type="text"
          .value=${cfg.theme.fontStack}
          @input=${(e: Event) => patchPageTheme({ fontStack: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="page-editor__field">
        <span class="page-editor__label">Logo asset (filename inside <code>assets/</code>)</span>
        <input
          class="page-editor__input"
          type="text"
          placeholder="logo.png"
          .value=${cfg.theme.logoAsset ?? ""}
          @input=${(e: Event) => patchPageTheme({ logoAsset: (e.target as HTMLInputElement).value || null })}
        />
      </label>
    </div>
  `;
}

function renderColorField(label: string, value: string, onChange: (v: string) => void): TemplateResult {
  return html`
    <label class="page-editor__color-field">
      <span class="page-editor__label">${label}</span>
      <div class="page-editor__color-row">
        <input
          type="color"
          class="page-editor__color"
          .value=${value}
          @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
        />
        <input
          class="page-editor__input"
          type="text"
          .value=${value}
          @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
        />
      </div>
    </label>
  `;
}

// ── Submissions ──────────────────────────────────────────────

function renderSubmissions(funnel: Funnel, editor: PageEditorState): TemplateResult {
  return html`
    <div class="page-editor__form">
      <div class="page-editor__section-head">
        <div>
          <h3 class="page-editor__section-title">Submissions</h3>
          <p class="page-editor__section-sub">Append-only log from <code>submissions.jsonl</code>. Entries with a leadId became leads in the store; rejected entries hit the validation, honeypot, or rate-limit gate.</p>
        </div>
        <button class="page-editor__btn page-editor__btn--ghost" @click=${() => loadPageSubmissions()}>↻ Refresh</button>
      </div>

      ${editor.submissionsLoading
        ? html`<div class="page-editor__empty-row"><span class="page-editor__spinner page-editor__spinner--sm"></span> Loading…</div>`
        : editor.submissions.length === 0
          ? html`<div class="page-editor__empty-row">No submissions yet. Try posting a test entry to <code>/api/funnels/${funnel.id}/submit</code>.</div>`
          : html`
              <div class="page-editor__submissions">
                ${editor.submissions.map((s) => renderSubmissionRow(s))}
              </div>
            `}
    </div>
  `;
}

function renderSubmissionRow(s: SubmissionLogEntry): TemplateResult {
  const ts = new Date(s.ts).toLocaleString();
  const status = s.rejected
    ? html`<span class="page-editor__pill page-editor__pill--err">${s.rejected}</span>`
    : s.leadId
      ? html`<span class="page-editor__pill page-editor__pill--ok">lead ${s.leadId.slice(0, 8)}…</span>`
      : html`<span class="page-editor__pill page-editor__pill--info">accepted</span>`;
  return html`
    <details class="page-editor__submission">
      <summary>
        <span class="page-editor__submission-time">${ts}</span>
        ${status}
        <span class="page-editor__submission-summary">${summarizePayload(s.payload)}</span>
      </summary>
      <pre class="page-editor__code">${JSON.stringify(s.payload, null, 2)}</pre>
      ${s.error ? html`<div class="page-editor__error-line">⚠ ${s.error}</div>` : nothing}
      ${s.ip || s.userAgent ? html`<div class="page-editor__submission-meta">${s.ip ?? ""} ${s.userAgent ?? ""}</div>` : nothing}
    </details>
  `;
}

function summarizePayload(p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof p.email === "string") parts.push(p.email);
  if (typeof p.name === "string") parts.push(p.name);
  if (parts.length === 0) {
    const first = Object.keys(p)[0];
    if (first) parts.push(`${first}=${String(p[first]).slice(0, 40)}`);
  }
  return parts.join(" · ");
}

// ── Preview ──────────────────────────────────────────────────

function renderPreviewPane(funnel: Funnel, editor: PageEditorState): TemplateResult {
  return html`
    <div class="page-editor__preview-pane">
      <div class="page-editor__preview-toolbar">
        <span class="page-editor__hint">
          Rendered HTML from
          <code>renderPageHtml(page.json, "${funnel.id.slice(0, 8)}…")</code>.
          ${editor.dirty ? "Save to refresh." : ""}
        </span>
        <button class="page-editor__btn page-editor__btn--ghost" @click=${() => loadPagePreview()}>↻ Re-render</button>
      </div>
      ${editor.previewLoading
        ? html`<div class="page-editor__empty-row"><span class="page-editor__spinner page-editor__spinner--sm"></span> Rendering…</div>`
        : editor.previewHtml
          ? html`<iframe class="page-editor__preview-iframe" sandbox="allow-forms" srcdoc=${editor.previewHtml}></iframe>`
          : html`<div class="page-editor__empty-row">No preview yet. Click ↻ Re-render.</div>`}
    </div>
  `;
}

function renderSidePreview(funnel: Funnel, editor: PageEditorState): TemplateResult {
  // Lazy-load on first show.
  if (editor.previewHtml === null && !editor.previewLoading) {
    void loadPagePreview();
  }
  return html`
    <aside class="page-editor__side-preview">
      <div class="page-editor__side-preview-head">
        <span>Live preview</span>
        <button class="page-editor__icon-btn" @click=${() => loadPagePreview()} title="Re-render">↻</button>
      </div>
      ${editor.previewLoading || editor.previewHtml === null
        ? html`<div class="page-editor__empty-row"><span class="page-editor__spinner page-editor__spinner--sm"></span></div>`
        : html`<iframe class="page-editor__side-preview-iframe" sandbox="allow-forms" srcdoc=${editor.previewHtml}></iframe>`}
    </aside>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function formatRelative(ts: number): string {
  if (!ts) return "never";
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// re-export for callers that want to clear state when the parent unmounts.
export { resetPageEditor };

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

const pageEditorStyles = `
  .page-editor {
    display: grid;
    grid-template-columns: 240px 1fr 320px;
    gap: 0;
    height: 100%;
    min-height: 0;
    color: var(--text, var(--glass-fg));
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    background: transparent;
  }
  .page-editor--empty,
  .page-editor--loading {
    display: flex;
    align-items: center;
    justify-content: center;
    grid-template-columns: none;
  }
  .page-editor__empty-card {
    text-align: center;
    padding: 48px;
    max-width: 420px;
    border: 1px dashed color-mix(in srgb, var(--glass-fg) 12%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
  }
  .page-editor__empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.6;
  }
  .page-editor__empty-card h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 600;
  }
  .page-editor__empty-card p {
    margin: 0;
    color: var(--glass-fg-2);
    font-size: 13px;
  }
  .page-editor__spinner {
    width: 24px;
    height: 24px;
    border: 2px solid color-mix(in srgb, var(--glass-fg) 15%, transparent);
    border-top-color: var(--accent, var(--glass-gold));
    border-radius: 50%;
    animation: page-editor-spin 0.8s linear infinite;
    margin-right: 12px;
  }
  .page-editor__spinner--sm {
    width: 14px;
    height: 14px;
    border-width: 2px;
    display: inline-block;
    margin-right: 6px;
    vertical-align: middle;
  }
  @keyframes page-editor-spin { to { transform: rotate(360deg); } }

  /* Sidebar */
  .page-editor__sidebar {
    border-right: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: auto;
  }
  .page-editor__sidebar-header {
    padding: 16px 16px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
  }
  .page-editor__sidebar-eyebrow {
    font-size: 10px;
    letter-spacing: 0.12em;
    color: var(--glass-fg-3);
    margin-bottom: 6px;
  }
  .page-editor__sidebar-title {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.25;
    word-break: break-word;
  }
  .page-editor__sidebar-path {
    font-family: ui-monospace, "JetBrains Mono", monospace;
    font-size: 11px;
    color: var(--glass-fg-3);
    margin-top: 4px;
    word-break: break-all;
  }
  .page-editor__sidebar-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    font-size: 11px;
    letter-spacing: 0.08em;
  }
  .page-editor__status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .page-editor__status-dot.is-live {
    background: #22c55e;
    box-shadow: 0 0 8px rgba(34,197,94,0.6);
  }
  .page-editor__status-dot.is-draft {
    background: color-mix(in srgb, var(--glass-fg) 25%, transparent);
  }
  .page-editor__status-link {
    margin-left: auto;
    color: var(--accent, var(--glass-gold));
    text-decoration: none;
    font-family: ui-monospace, monospace;
    font-size: 10px;
  }
  .page-editor__status-link:hover { text-decoration: underline; }
  .page-editor__status-muted {
    margin-left: auto;
    color: var(--glass-fg-3);
    font-size: 10px;
    text-transform: lowercase;
  }
  .page-editor__nav {
    display: flex;
    flex-direction: column;
    padding: 8px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
  }
  .page-editor__nav-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    border-left: 2px solid transparent;
    transition: background 0.12s, border-color 0.12s;
  }
  .page-editor__nav-btn:hover {
    background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
  }
  .page-editor__nav-btn.is-active {
    background: color-mix(in srgb, var(--glass-gold) 6%, transparent);
    border-left-color: var(--accent, var(--glass-gold));
  }
  .page-editor__nav-icon {
    width: 20px;
    text-align: center;
    color: var(--accent, var(--glass-gold));
    font-size: 13px;
  }
  .page-editor__nav-label { display: flex; flex-direction: column; min-width: 0; }
  .page-editor__nav-name { font-size: 13px; font-weight: 500; }
  .page-editor__nav-hint {
    font-size: 11px;
    color: var(--glass-fg-3);
  }
  .page-editor__sidebar-tree {
    padding: 12px 16px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .page-editor__tree-header {
    color: var(--glass-fg-3);
    font-size: 10px;
    letter-spacing: 0.12em;
    margin-bottom: 6px;
  }
  .page-editor__tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .page-editor__tree li {
    padding: 2px 0;
    color: var(--glass-fg-2);
  }
  .page-editor__tree-dir { color: rgba(99,179,237,0.85); }
  .page-editor__tree-file { color: var(--glass-fg-2); }

  /* Main pane */
  .page-editor__main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .page-editor__toolbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
  }
  .page-editor__breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--glass-fg-3);
  }
  .page-editor__crumb-leaf { color: var(--text, var(--glass-fg)); }
  .page-editor__crumb-sep { opacity: 0.4; }
  .page-editor__toolbar-status {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .page-editor__toolbar-actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .page-editor__pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .page-editor__pill--ok { background: rgba(34,197,94,0.12); color: #4ade80; }
  .page-editor__pill--warn { background: color-mix(in srgb, var(--glass-gold) 14%, transparent); color: var(--glass-gold); }
  .page-editor__pill--err { background: rgba(239,68,68,0.14); color: #fca5a5; }
  .page-editor__pill--info { background: color-mix(in srgb, var(--glass-gold) 14%, transparent); color: var(--glass-gold); }

  .page-editor__btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 12%, transparent);
    background: color-mix(in srgb, var(--glass-fg) 4%, transparent);
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .page-editor__btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-color: color-mix(in srgb, var(--glass-fg) 20%, transparent);
  }
  .page-editor__btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .page-editor__btn--primary {
    background: var(--accent, var(--glass-gold));
    border-color: var(--accent, var(--glass-gold));
    color: var(--glass-ink);
    font-weight: 600;
  }
  .page-editor__btn--primary:hover:not(:disabled) { background: var(--glass-gold); }
  .page-editor__btn--accent {
    background: rgba(34,197,94,0.18);
    border-color: rgba(34,197,94,0.4);
    color: #86efac;
  }
  .page-editor__btn--accent:hover:not(:disabled) { background: rgba(34,197,94,0.28); }
  .page-editor__btn--danger {
    background: rgba(239,68,68,0.14);
    border-color: rgba(239,68,68,0.4);
    color: #fca5a5;
  }
  .page-editor__btn--danger:hover:not(:disabled) { background: rgba(239,68,68,0.22); }
  .page-editor__btn--ghost { background: transparent; }

  .page-editor__body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 24px 32px;
  }

  .page-editor__form {
    max-width: 720px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .page-editor__section-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  .page-editor__section-sub {
    margin: 0;
    color: var(--glass-fg-2);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .page-editor__section-sub code {
    background: color-mix(in srgb, var(--glass-fg) 6%, transparent);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11.5px;
  }
  .page-editor__section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .page-editor__divider {
    height: 1px;
    background: color-mix(in srgb, var(--glass-fg) 8%, transparent);
    margin: 8px 0;
  }
  .page-editor__field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .page-editor__field--inline { gap: 4px; }
  .page-editor__field--checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .page-editor__field--full { grid-column: 1 / -1; }
  .page-editor__label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .page-editor__label {
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--glass-fg-2);
    text-transform: uppercase;
  }
  .page-editor__hint {
    font-size: 11.5px;
    color: var(--glass-fg-3);
  }
  .page-editor__input,
  .page-editor__textarea,
  .page-editor__select {
    width: 100%;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 12%, transparent);
    background: color-mix(in srgb, var(--glass-fg) 3%, transparent);
    color: inherit;
    font: inherit;
    font-size: 13px;
    box-sizing: border-box;
  }
  .page-editor__input:focus,
  .page-editor__textarea:focus,
  .page-editor__select:focus {
    outline: none;
    border-color: var(--accent, var(--glass-gold));
    background: color-mix(in srgb, var(--glass-fg) 5%, transparent);
  }
  .page-editor__input--lg { font-size: 16px; padding: 10px 12px; }
  .page-editor__textarea { resize: vertical; min-height: 60px; }
  .page-editor__url-wrap {
    display: flex;
    align-items: stretch;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 12%, transparent);
    border-radius: 6px;
    overflow: hidden;
    background: color-mix(in srgb, var(--glass-fg) 3%, transparent);
  }
  .page-editor__url-prefix {
    padding: 8px 10px;
    background: color-mix(in srgb, var(--glass-fg) 5%, transparent);
    color: var(--glass-fg-3);
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .page-editor__url-wrap .page-editor__input {
    border: 0;
    background: transparent;
    border-radius: 0;
  }
  .page-editor__chip-btn {
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px dashed color-mix(in srgb, var(--glass-fg) 20%, transparent);
    background: transparent;
    color: var(--glass-fg-2);
    font-size: 11px;
    cursor: pointer;
  }
  .page-editor__chip-btn:hover { border-color: var(--accent, var(--glass-gold)); color: var(--accent, var(--glass-gold)); }
  .page-editor__bullets { display: flex; flex-direction: column; gap: 8px; }
  .page-editor__bullet-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .page-editor__bullet-marker {
    width: 16px;
    text-align: center;
    color: var(--accent, var(--glass-gold));
  }
  .page-editor__icon-btn {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 10%, transparent);
    background: color-mix(in srgb, var(--glass-fg) 3%, transparent);
    color: var(--glass-fg-2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
  }
  .page-editor__icon-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--glass-fg) 8%, transparent);
    color: var(--text, var(--glass-fg));
  }
  .page-editor__icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .page-editor__icon-btn--danger:hover:not(:disabled) {
    background: rgba(239,68,68,0.16);
    color: #fca5a5;
    border-color: rgba(239,68,68,0.3);
  }
  .page-editor__empty-row {
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px dashed color-mix(in srgb, var(--glass-fg) 12%, transparent);
    color: var(--glass-fg-2);
    font-size: 12.5px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
  }
  .page-editor__empty-row code,
  .page-editor__empty-row em { color: var(--glass-fg-2); }

  /* Field cards */
  .page-editor__fields { display: flex; flex-direction: column; gap: 12px; }
  .page-editor__field-card {
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
  }
  .page-editor__field-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
  }
  .page-editor__field-card-meta { display: flex; align-items: center; gap: 10px; font-size: 12px; }
  .page-editor__field-index { color: var(--glass-fg-3); font-family: ui-monospace, monospace; }
  .page-editor__field-id { font-family: ui-monospace, monospace; color: var(--accent, var(--glass-gold)); }
  .page-editor__field-kind {
    font-size: 10.5px;
    padding: 1px 8px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--glass-fg) 6%, transparent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--glass-fg-2);
  }
  .page-editor__field-card-ops { display: flex; gap: 4px; }
  .page-editor__field-card-body {
    padding: 14px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }

  /* Color grid */
  .page-editor__color-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
  }
  .page-editor__color-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .page-editor__color-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .page-editor__color {
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 12%, transparent);
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
  }

  /* Submissions */
  .page-editor__submissions { display: flex; flex-direction: column; gap: 6px; }
  .page-editor__submission {
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
  }
  .page-editor__submission summary {
    list-style: none;
    cursor: pointer;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .page-editor__submission summary::-webkit-details-marker { display: none; }
  .page-editor__submission-time {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--glass-fg-2);
    min-width: 145px;
  }
  .page-editor__submission-summary {
    flex: 1;
    color: var(--glass-fg-2);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-editor__submission-meta {
    padding: 0 14px 10px;
    font-family: ui-monospace, monospace;
    font-size: 10.5px;
    color: var(--glass-fg-3);
  }
  .page-editor__error-line {
    padding: 6px 14px 10px;
    color: #fca5a5;
    font-size: 12px;
  }
  .page-editor__code {
    margin: 0;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--glass-base) 25%, transparent);
    border-top: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
    color: var(--glass-fg-2);
    overflow: auto;
    max-height: 280px;
  }

  /* Preview pane */
  .page-editor__preview-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .page-editor__preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    border-radius: 8px;
    margin-bottom: 12px;
    background: color-mix(in srgb, var(--glass-fg) 2%, transparent);
  }
  .page-editor__preview-iframe {
    width: 100%;
    flex: 1;
    min-height: 480px;
    border: 1px solid color-mix(in srgb, var(--glass-fg) 10%, transparent);
    border-radius: 8px;
    background: var(--glass-fg);
  }
  .page-editor__side-preview {
    border-left: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .page-editor__side-preview-head {
    padding: 10px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--glass-fg-2);
    text-transform: uppercase;
  }
  .page-editor__side-preview-iframe {
    flex: 1;
    border: 0;
    background: var(--glass-fg);
    width: 100%;
  }

  @media (max-width: 1100px) {
    .page-editor { grid-template-columns: 220px 1fr; }
    .page-editor__side-preview { display: none; }
  }
  @media (max-width: 720px) {
    .page-editor { grid-template-columns: 1fr; }
    .page-editor__sidebar { display: none; }
  }
`;
