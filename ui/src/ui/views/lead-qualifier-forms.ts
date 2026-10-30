/**
 * Form builder UI surfaced on the Lead Qualifier page.
 *
 * Layout:
 *   ┌─ Tabs: list / design / fields / settings / analytics / embed ─┐
 *   │                                                                 │
 *   │  list     → cards of every form for the active business         │
 *   │  design   → template + style + content editors w/ live preview  │
 *   │  fields   → field list editor with drag-reorder & per-field cfg │
 *   │  settings → CRM / funnel / qualifier relations + publish toggle │
 *   │  analytics→ KPI dashboard (views / submits / abandonment)       │
 *   │  embed    → public URL + iframe snippet + copy buttons          │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * The view re-uses the host page's `qualifierStyles()` for chrome and
 * adds its own scoped classes (`fb-*`) to avoid conflicts.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  type FormField,
  type FormFieldKind,
  type FormKpiSummary,
  type FormSubmissionRecord,
  type FormTheme,
  type QualifierFormConfig,
  FORM_THEMES,
  activeForm,
  addField,
  addFieldAt,
  addFieldOption,
  createFormFromTemplate,
  deleteActiveForm,
  duplicateField,
  embedSnippet,
  fieldKindOptions,
  listFormsForActiveBusiness,
  loadFormBuilder,
  loadKpi,
  moveFieldTo,
  patchActiveForm,
  patchContent,
  patchQualifier,
  patchStyle,
  publicFormUrl,
  removeField,
  removeFieldOption,
  saveActiveForm,
  togglePublish,
  updateField,
  updateFieldOption,
  loadNetlifyStatus,
  connectNetlify,
  deployFormToNetlify,
  updateNetlifyApiBaseUrl,
} from "../controllers/lead-qualifier-forms";

// ── Top-level entry ───────────────────────────────────────────

export function renderFormBuilder(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = state.leadQualifierFormsState;
  if (!s) return html`<div class="fb-loading">Form builder loading…</div>`;
  if (!s.loaded && !s.loading) {
    void loadFormBuilder(state, client);
  }
  const forms = listFormsForActiveBusiness(state);
  const form = activeForm(state);
  const bid = state.businessState?.activeBusinessId ?? null;

  return html`
    ${formBuilderStyles()}
    <section
      class="fb-shell"
      @click=${() => {
        let changed = false;
        if (s.formMenuOpen) {
          s.formMenuOpen = false;
          changed = true;
        }
        if (s.publishMenuOpen) {
          s.publishMenuOpen = false;
          changed = true;
        }
        if (changed) state.requestUpdate?.();
      }}
    >
      ${renderHeader(state, client, form, forms, bid)}
      ${s.error ? html`<div class="fb-banner fb-banner--err">⚠ ${s.error}</div>` : nothing}
      ${s.pickerOpen ? renderTemplatePicker(state, client) : nothing}
      ${form && s.previewOpen ? renderPreviewPanel(state, form) : nothing}
      ${form && s.analyticsOpen ? renderAnalyticsPanel(state, client, form) : nothing}

      ${!bid
        ? html`<div class="fb-empty">Pick a business above to manage its forms.</div>`
        : forms.length === 0 && !s.loading
          ? renderEmptyState(state)
          : form
            ? renderUnifiedBuilder(state, client, form)
            : html`<div class="fb-empty">Pick a form from the menu above to edit it.</div>`}
    </section>
  `;
}

// ── Header (form picker dropdown + global actions) ────────────
//
// Single top-of-page toolbar that owns everything that's not the
// drag-and-drop canvas itself: which form you're editing, save/publish,
// and the slide-over panels (Preview + Analytics). Form list lives
// inside the dropdown instead of a left sidebar so the canvas gets the
// whole horizontal space.

function renderHeader(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig | null,
  forms: QualifierFormConfig[],
  bid: string | null,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  const url = publicFormUrl(form);
  return html`
    <header class="fb-header">
      <div class="fb-header__left">
        ${form
          ? html`
              <div class="fb-formpicker">
                <button
                  class="fb-formpicker__trigger"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    s.formMenuOpen = !s.formMenuOpen;
                    state.requestUpdate?.();
                  }}
                  title="Switch form"
                >
                  <span
                    class="fb-formpicker__swatch"
                    style="background:${form.style.bgImageUrl
                      ? `url(${form.style.bgImageUrl}) center/cover`
                      : `linear-gradient(135deg,${form.style.primaryColor},${form.style.accentColor})`}"
                  ></span>
                  <span class="fb-formpicker__body">
                    <input
                      class="fb-formpicker__name"
                      .value=${form.name}
                      @click=${(e: Event) => e.stopPropagation()}
                      @change=${(e: Event) => patchActiveForm(state, { name: (e.target as HTMLInputElement).value })}
                    />
                    <span class="fb-formpicker__meta">
                      <span class="fb-dot ${form.published ? "is-on" : ""}"></span>
                      ${form.published ? "live" : "draft"}
                      · <code>/f/${form.slug || "<slug>"}</code>
                      · ${form.fields.length} field${form.fields.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span class="fb-formpicker__chev">▾</span>
                </button>
                ${s.formMenuOpen ? renderFormPickerMenu(state, forms, form, bid) : nothing}
              </div>
            `
          : html`
              <div class="fb-header__title">
                <span class="fb-header__icon">▤</span>
                <h2>Form builder</h2>
                <span class="fb-pill">${forms.length} form${forms.length === 1 ? "" : "s"}</span>
              </div>
            `}
      </div>
      <div class="fb-header__actions">
        ${form
          ? html`
              ${url && form.published
                ? html`<a
                    class="fb-btn fb-btn--ghost"
                    href=${url}
                    target="_blank"
                    rel="noopener"
                    title="Open public URL"
                  >↗ Open</a>`
                : nothing}
              <button
                class="fb-btn fb-btn--ghost"
                @click=${() => {
                  s.previewOpen = true;
                  state.requestUpdate?.();
                }}
                title="Preview the rendered form"
              >▢ Preview</button>
              <button
                class="fb-btn fb-btn--ghost"
                @click=${() => {
                  s.analyticsOpen = true;
                  void loadKpi(state, client, form.id);
                  state.requestUpdate?.();
                }}
                title="Open analytics dashboard"
              >▤ Analytics</button>
              ${renderPublishSplitButton(state, client, form, url)}
              <button
                class="fb-btn fb-btn--primary"
                ?disabled=${s.saving}
                @click=${() => saveActiveForm(state, client)}
              >${s.saving ? "Saving…" : "💾 Save"}</button>
            `
          : html`
              <button
                class="fb-btn fb-btn--primary"
                ?disabled=${!bid}
                @click=${() => {
                  s.pickerOpen = true;
                  state.requestUpdate?.();
                }}
              >+ Create your first form</button>
            `}
      </div>
    </header>
  `;
}

// Publish split-button: primary toggles publish + auto-opens the public
// form, the ▾ caret exposes Open URL / Copy URL / Deploy to Netlify so
// the user gets one-click access to both the local public form and the
// Netlify cloud deploy from the same toolbar control. Lives next to Save
// in the header — see renderHeader above.
function renderPublishSplitButton(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig,
  url: string,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  const isPublished = form.published;
  const primaryClass = isPublished ? "fb-btn--off" : "fb-btn--on";
  const primaryLabel = isPublished ? "⏸ Unpublish" : "▶ Publish";
  return html`
    <div
      class="fb-split"
      style="display:inline-flex;position:relative;"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <button
        class="fb-btn ${primaryClass}"
        style="border-top-right-radius:0;border-bottom-right-radius:0;"
        @click=${() => togglePublish(state, client)}
      >${primaryLabel}</button>
      <button
        class="fb-btn ${primaryClass}"
        style="border-top-left-radius:0;border-bottom-left-radius:0;border-left:1px solid rgba(255,255,255,0.18);padding-left:8px;padding-right:8px;"
        title="Publish options"
        @click=${() => {
          s.publishMenuOpen = !s.publishMenuOpen;
          if (s.publishMenuOpen && !s.netlifyStatus) {
            void loadNetlifyStatus(state, client);
          }
          state.requestUpdate?.();
        }}
      >▾</button>
      ${s.publishMenuOpen ? renderPublishMenu(state, client, form, url) : nothing}
    </div>
  `;
}

function renderPublishMenu(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig,
  url: string,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  const netlifyConfigured = !!s.netlifyStatus?.configured;
  const apiBase = (s.netlifyStatus?.apiBaseUrl ?? "").trim();
  const busy = !!s.netlifyDeployBusy[form.id];
  const result = s.netlifyDeployResult[form.id];
  const canDeploy = netlifyConfigured && !!apiBase && form.published && !busy;
  const deployTitle = !form.published
    ? "Publish the form first"
    : !netlifyConfigured
      ? "Connect Netlify in the inspector ☁ accordion first"
      : !apiBase
        ? "Set a public gateway URL in the ☁ accordion so submissions reach you"
        : "Push the rendered form HTML to Netlify";
  return html`
    <div
      class="fb-publish-menu"
      style="position:absolute;top:calc(100% + 6px);right:0;z-index:40;min-width:320px;background:rgba(18,16,28,0.98);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:12px;box-shadow:0 18px 48px rgba(0,0,0,0.55);"
    >
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.6;margin-bottom:8px;">
        Public URL
      </div>
      <div class="fb-input-row" style="display:flex;gap:6px;">
        <input
          class="fb-input fb-input--mono"
          readonly
          .value=${url || "(no slug — save first)"}
          @click=${(e: Event) => (e.target as HTMLInputElement).select()}
          style="flex:1;min-width:0;"
        />
        <button class="fb-btn fb-btn--sm" @click=${() => copy(url)} ?disabled=${!url}>Copy</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <a
          class="fb-btn fb-btn--sm fb-btn--ghost"
          href=${url || "#"}
          target="_blank"
          rel="noopener"
          aria-disabled=${!url || !form.published}
          style="flex:1;text-align:center;${!form.published ? "opacity:0.5;pointer-events:none;" : ""}"
        >↗ Open public form</a>
      </div>

      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:12px 0;" />

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.6;margin-bottom:8px;">
        ☁ Netlify cloud deploy
      </div>
      ${netlifyConfigured
        ? html`
            <div style="font-size:12px;opacity:0.8;margin-bottom:8px;">
              ${apiBase
                ? html`Submissions will post to <code style="opacity:0.9;">${apiBase}</code>.`
                : html`<span style="color:#fbbf24;">Set a public gateway URL in the inspector ☁ accordion first.</span>`}
            </div>
            <button
              class="fb-btn fb-btn--primary"
              style="width:100%;"
              ?disabled=${!canDeploy}
              title=${deployTitle}
              @click=${async () => {
                await deployFormToNetlify(state, client, form.id);
              }}
            >${busy ? "Deploying…" : "🚀 Deploy this form to Netlify"}</button>
            ${result
              ? html`
                  <div style="margin-top:10px;font-size:12px;">
                    <div style="opacity:0.7;margin-bottom:4px;">Live on Netlify:</div>
                    <div class="fb-input-row" style="display:flex;gap:6px;">
                      <input
                        class="fb-input fb-input--mono"
                        readonly
                        .value=${result.url}
                        @click=${(e: Event) => (e.target as HTMLInputElement).select()}
                        style="flex:1;min-width:0;"
                      />
                      <button class="fb-btn fb-btn--sm" @click=${() => copy(result.url)}>Copy</button>
                      <a class="fb-btn fb-btn--sm fb-btn--ghost" href=${result.url} target="_blank" rel="noopener">↗</a>
                    </div>
                  </div>
                `
              : nothing}
            ${s.netlifyError
              ? html`<p class="fb-banner fb-banner--err" style="margin:8px 0 0;">⚠ ${s.netlifyError}</p>`
              : nothing}
          `
        : html`
            <p style="font-size:12px;opacity:0.8;margin:0 0 8px;">
              Connect Netlify to host this form on a public, SSL-terminated edge URL — one click after publish.
            </p>
            <button
              class="fb-btn fb-btn--primary"
              style="width:100%;"
              @click=${() => {
                s.netlifyConnectOpen = true;
                s.netlifyTokenInput = "";
                s.netlifyError = null;
                s.publishMenuOpen = false;
                // Auto-open the inspector accordion + scroll it into view
                // so the connect form is actually visible. Without this
                // the click only sets state and the user sees nothing.
                s.netlifyAccordionOpen = true;
                state.requestUpdate?.();
                queueMicrotask(() => {
                  const el = document.getElementById("fb-accord-netlify");
                  el?.scrollIntoView({ block: "center", behavior: "smooth" });
                  const input = el?.querySelector(
                    'input[type="password"]',
                  ) as HTMLInputElement | null;
                  input?.focus();
                });
              }}
            >☁ Connect Netlify…</button>
          `}
    </div>
  `;
}

function renderFormPickerMenu(
  state: AppViewState,
  forms: QualifierFormConfig[],
  active: QualifierFormConfig,
  bid: string | null,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  return html`
    <div
      class="fb-fpmenu"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <div class="fb-fpmenu__head">
        <span>Your forms</span>
        <button
          class="fb-btn fb-btn--sm"
          ?disabled=${!bid}
          @click=${() => {
            s.pickerOpen = true;
            s.formMenuOpen = false;
            state.requestUpdate?.();
          }}
        >+ New</button>
      </div>
      <div class="fb-fpmenu__list">
        ${forms.map(
          (f) => html`
            <button
              class="fb-fpmenu__row ${f.id === active.id ? "is-active" : ""}"
              @click=${() => {
                s.selectedFormId = f.id;
                s.formMenuOpen = false;
                s.editingFieldId = null;
                state.requestUpdate?.();
              }}
            >
              <span
                class="fb-fpmenu__swatch"
                style="background:${f.style.bgImageUrl
                  ? `url(${f.style.bgImageUrl}) center/cover`
                  : `linear-gradient(135deg,${f.style.primaryColor},${f.style.accentColor})`}"
              ></span>
              <span class="fb-fpmenu__body">
                <span class="fb-fpmenu__name">${f.name}</span>
                <span class="fb-fpmenu__meta">
                  <span class="fb-dot ${f.published ? "is-on" : ""}"></span>
                  ${f.published ? "live" : "draft"}
                  · ${f.fields.length} field${f.fields.length === 1 ? "" : "s"}
                  · ${f.layout}
                </span>
              </span>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

// ── Empty state ───────────────────────────────────────────────

function renderEmptyState(state: AppViewState): TemplateResult {
  const s = state.leadQualifierFormsState!;
  return html`
    <div class="fb-empty-card">
      <div class="fb-empty-card__icon">▦</div>
      <h3>No forms yet for this business</h3>
      <p>Pick a template to scaffold a complete branded form — fields, copy, theme, and qualifying score — in seconds.</p>
      <button
        class="fb-btn fb-btn--primary fb-btn--lg"
        @click=${() => {
          s.pickerOpen = true;
          state.requestUpdate?.();
        }}
      >Browse templates →</button>
    </div>
  `;
}

// ── Template picker overlay ───────────────────────────────────

function renderTemplatePicker(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  return html`
    <div
      class="fb-overlay"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          s.pickerOpen = false;
          state.requestUpdate?.();
        }
      }}
    >
      <div class="fb-modal">
        <header>
          <h3>Pick a starting template</h3>
          <button
            class="fb-icon-btn"
            @click=${() => {
              s.pickerOpen = false;
              state.requestUpdate?.();
            }}
          >×</button>
        </header>
        <div class="fb-template-grid">
          ${s.templates.length === 0
            ? html`<div class="fb-empty">Loading templates…</div>`
            : s.templates.map(
                (t) => html`
                  <button class="fb-template-card" @click=${() => createFormFromTemplate(state, client, t.id)}>
                    <div class="fb-template-card__swatch" style="background:${t.swatch}"></div>
                    <div class="fb-template-card__body">
                      <div class="fb-template-card__head">
                        <span class="fb-template-card__badge">${t.badge}</span>
                        <span class="fb-template-card__cat">${t.category}</span>
                      </div>
                      <div class="fb-template-card__title">${t.name}</div>
                      <div class="fb-template-card__tag">${t.tagline}</div>
                      <div class="fb-template-card__stats">
                        <span>${t.fields.length} fields</span>
                        <span>·</span>
                        <span>${t.layout}</span>
                      </div>
                    </div>
                  </button>
                `,
              )}
          ${renderBlankCard(state, client)}
        </div>
      </div>
    </div>
  `;
}

function renderBlankCard(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  return html`
    <button
      class="fb-template-card fb-template-card--blank"
      @click=${() => createFormFromTemplate(state, client, "newsletter-optin", "New form")}
    >
      <div class="fb-template-card__swatch" style="background:repeating-linear-gradient(45deg,#1a1a22,#1a1a22 8px,#22222c 8px,#22222c 16px)"></div>
      <div class="fb-template-card__body">
        <div class="fb-template-card__head">
          <span class="fb-template-card__badge">＋ Blank</span>
        </div>
        <div class="fb-template-card__title">Start from scratch</div>
        <div class="fb-template-card__tag">Minimal name + email opt-in you can tear apart.</div>
      </div>
    </button>
  `;
}

// ── Unified builder (single view — no tabs) ───────────────────
//
// Three-pane drag-and-drop builder is the *only* editing surface.
// Left = field palette, center = canvas with schematic previews,
// right = selection-aware inspector that swaps between field-detail
// (when a card is selected) and a collapsible form-settings accordion
// (otherwise). Analytics + raw preview live in slide-over panels off
// the header so they never push the builder out of view.

function renderUnifiedBuilder(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  return html`
    <div class="fb-builder">
      ${renderFieldPalette()}
      <div class="fb-canvas">${renderCanvas(state, form)}</div>
      <aside class="fb-inspector">
        ${s.editingFieldId
          ? renderInspectorForField(state, form, s.editingFieldId)
          : renderInspectorForForm(state, client, form)}
      </aside>
    </div>
  `;
}

/** Inspector header used in both modes for a consistent affordance. */
function renderInspectorTitle(
  title: string,
  subtitle: string,
  onBack?: () => void,
): TemplateResult {
  return html`
    <header class="fb-insp-head">
      ${onBack
        ? html`<button class="fb-icon-btn" title="Back to form settings" @click=${onBack}>←</button>`
        : nothing}
      <div>
        <h4>${title}</h4>
        <p>${subtitle}</p>
      </div>
    </header>
  `;
}

function renderInspectorForField(
  state: AppViewState,
  form: QualifierFormConfig,
  fieldId: string,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  return html`
    ${renderInspectorTitle(
      "Field properties",
      "Tweak label, validation, options, scoring — changes apply live in the canvas.",
      () => {
        s.editingFieldId = null;
        state.requestUpdate?.();
      },
    )}
    ${renderFieldDetail(state, form, fieldId)}
  `;
}

function renderInspectorForForm(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig,
): TemplateResult {
  return html`
    ${renderInspectorTitle("Form settings", "Layout, branding, copy, scoring. Click a field card on the left to edit it instead.")}
    <div class="fb-accord">
      ${accordItem(
        "Layout",
        layoutIcon(form.layout),
        true,
        renderLayoutPicker(state, form),
      )}
      ${accordItem(
        "Style",
        "🎨",
        false,
        renderStyleSection(state, form),
      )}
      ${accordItem(
        "Content",
        "✎",
        false,
        renderContentSection(state, form),
      )}
      ${accordItem(
        "Qualifying score",
        "▤",
        false,
        renderQualifierSection(state, form),
      )}
      ${accordItem(
        "Identity & relations",
        "⚙",
        false,
        renderIdentitySection(state, form),
      )}
      ${accordItem(
        "Embed",
        "↗",
        false,
        renderEmbedAccordion(form),
      )}
      ${accordItem(
        "Cloud deploy · Netlify",
        "☁",
        !!state.leadQualifierFormsState?.netlifyAccordionOpen,
        renderNetlifyAccordion(state, client, form),
        {
          id: "fb-accord-netlify",
          onToggle: (open) => {
            const ls = state.leadQualifierFormsState;
            if (!ls) return;
            ls.netlifyAccordionOpen = open;
          },
        },
      )}
      ${accordItem(
        "Danger zone",
        "⚠",
        false,
        renderDangerSection(state, client),
      )}
    </div>
  `;
}

function accordItem(
  title: string,
  icon: string,
  open: boolean,
  body: TemplateResult,
  opts: { id?: string; onToggle?: (open: boolean) => void } = {},
): TemplateResult {
  return html`
    <details
      class="fb-accord__item"
      id=${opts.id ?? nothing}
      ?open=${open}
      @toggle=${(e: Event) => {
        if (!opts.onToggle) return;
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) opts.onToggle(next);
      }}
    >
      <summary class="fb-accord__head">
        <span class="fb-accord__icon">${icon}</span>
        <span class="fb-accord__title">${title}</span>
        <span class="fb-accord__chev">▾</span>
      </summary>
      <div class="fb-accord__body">${body}</div>
    </details>
  `;
}

function renderEditor(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig,
): TemplateResult {
  return renderUnifiedBuilder(state, client, form);
}

// ── Inspector accordion sections (extracted from the old tabs) ───

function renderQualifierSection(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  return html`
    <label class="fb-field">
      <span>Score threshold (sum of option scores ≥ this = qualified)</span>
      <input type="number" class="fb-input" .value=${String(form.qualifier.scoreThreshold)}
        @change=${(e: Event) =>
          patchQualifier(state, {
            scoreThreshold: Number((e.target as HTMLInputElement).value) || 0,
          })} />
    </label>
    <label class="fb-field fb-field--row">
      <input type="checkbox" ?checked=${form.qualifier.saveUnqualified}
        @change=${(e: Event) =>
          patchQualifier(state, {
            saveUnqualified: (e.target as HTMLInputElement).checked,
          })} />
      <span>Still save unqualified submissions to the CRM</span>
    </label>
    <p class="fb-hint">
      Each <code>select</code>, <code>radio</code>, or <code>checkbox-group</code> option
      can carry a score (set in the field inspector). The qualifier pipeline runs the
      qualified-only actions whenever the submitted total clears the threshold above.
    </p>
  `;
}

function renderIdentitySection(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  const businesses = state.businessState?.businesses ?? [];
  return html`
    ${textField("Marketing tag", form.tag, (v) => patchActiveForm(state, { tag: v }))}
    <label class="fb-field">
      <span>Public slug (URL — letters/numbers/dashes)</span>
      <input class="fb-input fb-input--mono" .value=${form.slug}
        @change=${(e: Event) => patchActiveForm(state, { slug: (e.target as HTMLInputElement).value })} />
      <span class="fb-hint">Lives at <code>/f/${form.slug || "<slug>"}</code> on this gateway.</span>
    </label>
    <label class="fb-field">
      <span>Business</span>
      <select class="fb-input"
        .value=${form.businessId}
        @change=${(e: Event) =>
          patchActiveForm(state, { businessId: (e.target as HTMLSelectElement).value })}>
        ${businesses.map(
          (b) => html`<option value=${b.id} ?selected=${b.id === form.businessId}>${b.name}</option>`,
        )}
      </select>
    </label>
    <label class="fb-field">
      <span>Funnel (analytics roll-up — optional)</span>
      <input class="fb-input fb-input--mono" placeholder="funnel id" .value=${form.funnelId ?? ""}
        @change=${(e: Event) =>
          patchActiveForm(state, {
            funnelId: (e.target as HTMLInputElement).value.trim() || null,
          })} />
    </label>
    <details class="fb-disclose">
      <summary>Advanced</summary>
      <label class="fb-field">
        <span>Qualifier (defaults to this business's primary qualifier)</span>
        <input class="fb-input fb-input--mono" placeholder="businessId of the qualifier"
          .value=${form.qualifierBusinessId ?? ""}
          @change=${(e: Event) =>
            patchActiveForm(state, {
              qualifierBusinessId: (e.target as HTMLInputElement).value.trim() || null,
            })} />
      </label>
      <label class="fb-field">
        <span>CRM database override (optional)</span>
        <input class="fb-input fb-input--mono" placeholder="leave blank to inherit"
          .value=${form.crmDatabaseId ?? ""}
          @change=${(e: Event) =>
            patchActiveForm(state, {
              crmDatabaseId: (e.target as HTMLInputElement).value.trim() || null,
            })} />
      </label>
      <label class="fb-field">
        <span>Honeypot field name (anti-bot — hidden from humans)</span>
        <input class="fb-input fb-input--mono" .value=${form.honeypotField}
          @change=${(e: Event) =>
            patchActiveForm(state, {
              honeypotField: (e.target as HTMLInputElement).value.trim(),
            })} />
      </label>
    </details>
  `;
}

function renderEmbedAccordion(form: QualifierFormConfig): TemplateResult {
  const url = publicFormUrl(form);
  const snippet = embedSnippet(form);
  return html`
    <label class="fb-field">
      <span>Public URL</span>
      <div class="fb-input-row">
        <input class="fb-input fb-input--mono" readonly .value=${url || "(no slug yet)"}
          @click=${(e: Event) => (e.target as HTMLInputElement).select()} />
        <button class="fb-btn fb-btn--sm" @click=${() => copy(url)}>Copy</button>
      </div>
      <span class="fb-hint">
        ${form.published
          ? "Live now — share or embed on any page."
          : "Toggle Publish in the toolbar to make this URL public."}
      </span>
    </label>
    <label class="fb-field">
      <span>Iframe snippet</span>
      <pre class="fb-pre">${snippet}</pre>
      <button class="fb-btn fb-btn--sm" @click=${() => copy(snippet)}>Copy snippet</button>
    </label>
  `;
}

function renderNetlifyAccordion(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  // Migrate-in defaults for stale state objects created before these
  // fields existed. Touching them on the original `s` keeps the runtime
  // observable since the parent owns the reference.
  if (s.netlifyDeployBusy === undefined) s.netlifyDeployBusy = {};
  if (s.netlifyDeployResult === undefined) s.netlifyDeployResult = {};
  if (s.netlifyTokenInput === undefined) s.netlifyTokenInput = "";
  if (s.netlifyApiBaseUrlInput === undefined) s.netlifyApiBaseUrlInput = "";

  // Lazily fetch on first render so the section is populated by the time
  // the user opens the accordion. Idempotent: loadNetlifyStatus only hits
  // the gateway when called explicitly.
  if ((s.netlifyStatus === null || s.netlifyStatus === undefined) && !s.netlifyError) {
    queueMicrotask(() => void loadNetlifyStatus(state, client));
  }
  const status = s.netlifyStatus;
  const busy = !!(s.netlifyDeployBusy ?? {})[form.id];
  const result = (s.netlifyDeployResult ?? {})[form.id];
  const persistedSiteId = status?.formSites?.[form.id];
  const apiBase = ((s.netlifyApiBaseUrlInput ?? status?.apiBaseUrl ?? "") + "").trim();

  return html`
    <div class="fb-netlify">
      ${!status?.configured ? html`
        <p class="fb-hint">
          Connect Netlify to host this form on a public, SSL-terminated edge URL.
          Submissions still POST back to your local gateway via the public URL below.
        </p>
        ${s.netlifyConnectOpen ? html`
          <label class="fb-field">
            <span>Personal access token</span>
            <input
              type="password"
              class="fb-input fb-input--mono"
              placeholder="nfp_…"
              .value=${s.netlifyTokenInput}
              @input=${(e: InputEvent) => {
                s.netlifyTokenInput = (e.target as HTMLInputElement).value;
                state.requestUpdate?.();
              }}
            />
            <span class="fb-hint">
              Create one at
              <a href="https://app.netlify.com/user/applications#personal-access-tokens" target="_blank" rel="noopener">app.netlify.com → User settings → Applications → Personal access tokens</a>.
              Stored only in <code>~/.infinibot/infinibot.json</code>.
            </span>
          </label>
          <label class="fb-field">
            <span>Public gateway URL <em>(Tailscale funnel / ngrok / static IP)</em></span>
            <input
              type="url"
              class="fb-input fb-input--mono"
              placeholder="https://your-gateway.ts.net"
              .value=${s.netlifyApiBaseUrlInput}
              @input=${(e: InputEvent) => {
                s.netlifyApiBaseUrlInput = (e.target as HTMLInputElement).value;
                state.requestUpdate?.();
              }}
            />
            <span class="fb-hint">
              The Netlify-hosted form posts submissions here. Without a publicly-reachable URL the form will fail to submit.
            </span>
          </label>
          ${s.netlifyError ? html`<p class="fb-banner fb-banner--err" style="margin:6px 0;">⚠ ${s.netlifyError}</p>` : nothing}
          <div class="fb-row">
            <button
              class="fb-btn fb-btn--primary"
              ?disabled=${s.netlifyConnectBusy}
              @click=${() => connectNetlify(state, client)}
            >${s.netlifyConnectBusy ? "Connecting…" : "Connect Netlify"}</button>
            <button class="fb-btn fb-btn--ghost" ?disabled=${s.netlifyConnectBusy} @click=${() => {
              s.netlifyConnectOpen = false;
              s.netlifyError = null;
              state.requestUpdate?.();
            }}>Cancel</button>
          </div>
        ` : html`
          <button class="fb-btn fb-btn--primary" @click=${() => {
            s.netlifyConnectOpen = true;
            s.netlifyTokenInput = "";
            state.requestUpdate?.();
          }}>☁ Connect to Netlify</button>
        `}
      ` : html`
        <div class="fb-row" style="align-items:flex-start;gap:14px;">
          <div class="fb-flex-1">
            <p class="fb-hint" style="margin-top:0;">
              ✓ Connected as <strong>${status.user?.email ?? status.user?.full_name ?? "Netlify user"}</strong>.
              Re-deploys land on the same site so the URL stays stable.
            </p>
          </div>
        </div>
        <label class="fb-field">
          <span>Public gateway URL <em>(used as submission endpoint)</em></span>
          <div class="fb-input-row">
            <input
              type="url"
              class="fb-input fb-input--mono"
              placeholder="https://your-gateway.ts.net"
              .value=${s.netlifyApiBaseUrlInput || apiBase}
              @input=${(e: InputEvent) => {
                s.netlifyApiBaseUrlInput = (e.target as HTMLInputElement).value;
                state.requestUpdate?.();
              }}
            />
            <button class="fb-btn fb-btn--sm" @click=${() => updateNetlifyApiBaseUrl(state, client)}>Save</button>
          </div>
          <span class="fb-hint">
            Expose your gateway via Tailscale funnel, ngrok, cloudflared, or a static IP.
            The deployed form fetches <code>${apiBase || "<base>"}/api/forms/lq/${form.slug || "&lt;slug&gt;"}/submit</code>.
          </span>
        </label>
        ${s.netlifyError ? html`<p class="fb-banner fb-banner--err" style="margin:6px 0;">⚠ ${s.netlifyError}</p>` : nothing}
        <div class="fb-row" style="gap:10px;">
          <button
            class="fb-btn fb-btn--primary"
            ?disabled=${busy || !apiBase}
            title=${apiBase ? "Push the rendered form HTML to Netlify" : "Set a public gateway URL first"}
            @click=${() => deployFormToNetlify(state, client, form.id)}
          >${busy ? "Deploying…" : "🚀 Deploy form to Netlify"}</button>
          <button
            class="fb-btn fb-btn--ghost"
            @click=${() => {
              s.netlifyConnectOpen = true;
              s.netlifyTokenInput = "";
              state.requestUpdate?.();
            }}
            title="Re-enter your Netlify token"
          >Reconnect</button>
        </div>
        ${result ? html`
          <div class="fb-netlify-result">
            <div class="fb-row" style="justify-content:space-between;">
              <strong>${result.state === "ready" ? "✓ Live" : `${result.state}…`}</strong>
              <code style="font-size:11px;color:var(--g-fg-faint, #9b8b4d);">site: ${result.siteId}</code>
            </div>
            <div class="fb-input-row" style="margin-top:6px;">
              <input class="fb-input fb-input--mono" readonly .value=${result.url}
                @click=${(e: Event) => (e.target as HTMLInputElement).select()} />
              <a class="fb-btn fb-btn--sm" href=${result.url} target="_blank" rel="noopener">Open ↗</a>
              <button class="fb-btn fb-btn--sm" @click=${() => copy(result.url)}>Copy</button>
            </div>
          </div>
        ` : persistedSiteId ? html`
          <p class="fb-hint" style="margin-top:8px;">
            Previously deployed to site <code>${persistedSiteId}</code>. Re-deploy will overwrite that site.
          </p>
        ` : nothing}
      `}
    </div>
  `;
}

function renderDangerSection(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  return html`
    <button class="fb-btn fb-btn--danger" @click=${() => deleteActiveForm(state, client)}>
      Delete this form
    </button>
    <p class="fb-hint">Submissions and analytics for this form are not recoverable.</p>
  `;
}

// ── Slide-over panels (Preview + Analytics) ───────────────────

function renderPreviewPanel(
  state: AppViewState,
  form: QualifierFormConfig,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  const url = publicFormUrl(form);
  const close = () => {
    s.previewOpen = false;
    state.requestUpdate?.();
  };
  return html`
    <div class="fb-slideover" @click=${(e: Event) => {
      if (e.target === e.currentTarget) close();
    }}>
      <aside class="fb-slideover__panel">
        <header class="fb-slideover__head">
          <div>
            <h3>Live preview</h3>
            <p>${url || "Save with a slug to get a URL"}</p>
          </div>
          <div class="fb-slideover__actions">
            ${url && form.published
              ? html`<a class="fb-btn fb-btn--sm" href=${url} target="_blank" rel="noopener">Open ↗</a>`
              : nothing}
            <button class="fb-icon-btn" @click=${close} title="Close">×</button>
          </div>
        </header>
        <div class="fb-slideover__body">
          ${form.published && url
            ? html`<iframe class="fb-iframe" src=${url} title="form preview" sandbox="allow-forms allow-scripts allow-same-origin"></iframe>`
            : html`<div class="fb-preview__placeholder">
                The form is unpublished. Hit <strong>▶ Publish</strong> in the toolbar to render it
                against the live gateway here.
              </div>`}
        </div>
      </aside>
    </div>
  `;
}

function renderAnalyticsPanel(
  state: AppViewState,
  client: GatewayBrowserClient,
  form: QualifierFormConfig,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  const kpi = s.kpi[form.id];
  const submissions = s.submissions[form.id] ?? [];
  const close = () => {
    s.analyticsOpen = false;
    state.requestUpdate?.();
  };
  return html`
    <div class="fb-slideover" @click=${(e: Event) => {
      if (e.target === e.currentTarget) close();
    }}>
      <aside class="fb-slideover__panel fb-slideover__panel--wide">
        <header class="fb-slideover__head">
          <div>
            <h3>Analytics — ${form.name}</h3>
            <p>Views, submits, abandonment, and recent activity.</p>
          </div>
          <div class="fb-slideover__actions">
            <button class="fb-btn fb-btn--sm" @click=${() => loadKpi(state, client, form.id)}>Refresh</button>
            <button class="fb-icon-btn" @click=${close} title="Close">×</button>
          </div>
        </header>
        <div class="fb-slideover__body">
          ${kpi
            ? html`
                ${renderKpiHeadline(kpi)}
                <div class="fb-analytics__grid">
                  ${renderHourlyChart(kpi)}
                  ${renderBySource(kpi)}
                  ${renderAbandonment(kpi)}
                </div>
                ${renderSubmissions(submissions)}
              `
            : html`<div class="fb-empty">Loading KPI snapshot…</div>`}
        </div>
      </aside>
    </div>
  `;
}

// ── DESIGN TAB ────────────────────────────────────────────────

function renderLayoutPicker(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  const layouts: Array<{ id: typeof form.layout; label: string; desc: string }> = [
    { id: "single-column", label: "Single column", desc: "All fields stacked. Lowest friction." },
    { id: "two-column", label: "Two-column grid", desc: "Pairs name+email, etc. Collapses on mobile." },
    { id: "multi-step", label: "Multi-step wizard", desc: "Group fields by `step`. Best for long forms." },
    {
      id: "step-by-step",
      label: "Step-by-step pages",
      desc: "Typeform-style — one centered page per step, logo top-center, animated transitions.",
    },
    { id: "long-form", label: "Long-form sales", desc: "Hero + bullets + testimonials + form." },
  ];
  return html`
    <section class="fb-card">
      <h4>Layout</h4>
      <div class="fb-layout-grid">
        ${layouts.map(
          (l) => html`
            <button
              class="fb-layout ${form.layout === l.id ? "is-active" : ""}"
              @click=${() => patchActiveForm(state, { layout: l.id })}
            >
              <div class="fb-layout__icon">${layoutIcon(l.id)}</div>
              <div class="fb-layout__name">${l.label}</div>
              <div class="fb-layout__desc">${l.desc}</div>
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function layoutIcon(id: QualifierFormConfig["layout"]): string {
  switch (id) {
    case "single-column": return "▤";
    case "two-column": return "▥";
    case "multi-step": return "⊞";
    case "step-by-step": return "◐";
    case "long-form": return "▦";
    case "card-grid": return "⊟";
  }
}

function renderStyleSection(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  const s = state.leadQualifierFormsState!;
  const currentFilter = s.themeGalleryFilter ?? "";
  const currentLayout = form.layout;

  // Filter themes
  const visible = FORM_THEMES.filter((t) => {
    if (currentFilter && t.category !== currentFilter) return false;
    return true;
  });

  const categories: Array<{ key: string; label: string }> = [
    { key: "", label: "All" },
    { key: "premium", label: "Premium" },
    { key: "minimal", label: "Minimal" },
    { key: "bold", label: "Bold" },
    { key: "glass", label: "Glass" },
    { key: "editorial", label: "Editorial" },
    { key: "playful", label: "Playful" },
    { key: "dark", label: "Dark" },
    { key: "luxury", label: "Luxury" },
  ];

  return html`
    <section class="fb-card">
      <h4>Themes</h4>

      <!-- Category filter -->
      <div class="fb-theme-filters">
        ${categories.map(
          (c) => html`
            <button
              class="fb-theme-filter-btn ${currentFilter === c.key ? "is-active" : ""}"
              @click=${() => {
                s.themeGalleryFilter = c.key;
                state.requestUpdate?.();
              }}
            >${c.label}</button>
          `,
        )}
      </div>

      <!-- Best-for hint -->
      ${currentFilter === ""
        ? html`<p class="fb-hint" style="margin:0 0 8px;">
            Showing all themes. Your layout is <strong>${currentLayout}</strong> —
            themes with ✦ work especially well with it.
          </p>`
        : nothing}

      <!-- Theme grid -->
      <div class="fb-theme-grid">
        ${visible.map((theme) => {
          const isActive = form.style.themeId === theme.id;
          const fitsCurrent = theme.recommendedFor.includes(currentLayout);
          return html`
            <button
              class="fb-theme-card ${isActive ? "is-active" : ""}"
              title="${theme.name} — ${theme.tagline}"
              @click=${() => {
                patchStyle(state, { ...theme.style, themeId: theme.id });
                ensureThemeFontsLoaded(theme);
              }}
            >
              <div class="fb-theme-card__thumb">
                ${renderThemeMiniPreview(theme)}
                ${isActive
                  ? html`<div class="fb-theme-card__check">✓</div>`
                  : nothing}
                ${fitsCurrent
                  ? html`<div style="position:absolute;top:5px;left:5px;font-size:9px;color:${theme.style.primaryColor};font-weight:900;text-shadow:0 0 6px rgba(0,0,0,0.8);">✦</div>`
                  : nothing}
              </div>
              <div class="fb-theme-card__info">
                <div class="fb-theme-card__name">${theme.name}</div>
                <div class="fb-theme-card__tag">${theme.category}</div>
              </div>
            </button>
          `;
        })}
      </div>

      <!-- Current theme indicator -->
      ${form.style.themeId
        ? html`<p class="fb-hint" style="margin:0 0 10px;">
            Theme: <strong>${FORM_THEMES.find((t) => t.id === form.style.themeId)?.name ?? form.style.themeId}</strong>
            — customize below.
          </p>`
        : nothing}

      <details class="fb-disclose" style="margin-bottom:12px;">
        <summary style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;">
          ✎ Customize theme
        </summary>
        <div style="padding-top:10px;display:flex;flex-direction:column;gap:10px;">

          <!-- Premium controls -->
          ${segControl("Button style", [
            { value: "gradient", label: "Gradient" },
            { value: "solid", label: "Solid" },
            { value: "outline", label: "Outline" },
            { value: "glass", label: "Glass" },
            { value: "neon", label: "Neon" },
          ], form.style.buttonStyle ?? "gradient", (v) =>
            patchStyle(state, { buttonStyle: v as "solid" | "outline" | "glass" | "gradient" | "neon" }))}

          ${segControl("Surface style", [
            { value: "raised", label: "Raised" },
            { value: "flat", label: "Flat" },
            { value: "glass", label: "Glass" },
            { value: "gradient", label: "Grad" },
            { value: "noise", label: "Noise" },
          ], form.style.surfaceStyle ?? "raised", (v) =>
            patchStyle(state, { surfaceStyle: v as "flat" | "raised" | "glass" | "gradient" | "noise" }))}

          ${segControl("Input style", [
            { value: "outline", label: "Outline" },
            { value: "filled", label: "Filled" },
            { value: "glass", label: "Glass" },
            { value: "underline", label: "Line" },
          ], form.style.inputStyle ?? "outline", (v) =>
            patchStyle(state, { inputStyle: v as "underline" | "filled" | "outline" | "glass" }))}

          ${segControl("Density", [
            { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Default" },
            { value: "spacious", label: "Spacious" },
          ], form.style.density ?? "comfortable", (v) =>
            patchStyle(state, { density: v as "comfortable" | "compact" | "spacious" }))}

          ${segControl("Motion", [
            { value: "off", label: "Off" },
            { value: "subtle", label: "Subtle" },
            { value: "full", label: "Full" },
          ], form.style.motionLevel ?? "subtle", (v) =>
            patchStyle(state, { motionLevel: v as "off" | "subtle" | "full" }))}

          <!-- Shadow level -->
          <label class="fb-field">
            <span>Shadow level (${form.style.shadowLevel ?? 1})</span>
            <input type="range" min="0" max="3" step="1"
              .value=${String(form.style.shadowLevel ?? 1)}
              @input=${(e: Event) =>
                patchStyle(state, { shadowLevel: Number((e.target as HTMLInputElement).value) as 0|1|2|3 })} />
          </label>

          <!-- Color grid -->
          <div class="fb-style-grid">
            ${colorField("Primary", form.style.primaryColor, (v) => patchStyle(state, { primaryColor: v }))}
            ${colorField("Accent", form.style.accentColor, (v) => patchStyle(state, { accentColor: v }))}
            ${colorField("Background", form.style.bgColor, (v) => patchStyle(state, { bgColor: v }))}
            ${colorField("Text", form.style.textColor, (v) => patchStyle(state, { textColor: v }))}
            ${colorField("Card", form.style.cardColor ?? "#000000", (v) => patchStyle(state, { cardColor: v }))}
          </div>

          <!-- Fonts -->
          <label class="fb-field">
            <span>Body font stack</span>
            <input class="fb-input" .value=${form.style.fontStack}
              @change=${(e: Event) => patchStyle(state, { fontStack: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="fb-field">
            <span>Heading font stack</span>
            <input class="fb-input" placeholder="Leave blank to match body"
              .value=${form.style.headingFontStack ?? ""}
              @change=${(e: Event) =>
                patchStyle(state, { headingFontStack: (e.target as HTMLInputElement).value.trim() || undefined })} />
          </label>

          <!-- Radius -->
          <label class="fb-field">
            <span>Border radius (${form.style.radius}px)</span>
            <input type="range" min="0" max="32" step="1" .value=${String(form.style.radius)}
              @input=${(e: Event) =>
                patchStyle(state, { radius: Number((e.target as HTMLInputElement).value) })} />
          </label>

          <!-- Logo -->
          <label class="fb-field">
            <span>Logo URL (optional)</span>
            <input class="fb-input fb-input--mono" placeholder="https://…/logo.png"
              .value=${form.style.logoUrl ?? ""}
              @change=${(e: Event) =>
                patchStyle(state, { logoUrl: (e.target as HTMLInputElement).value.trim() || null })} />
          </label>
          ${form.style.logoUrl
            ? html`
              <label class="fb-field">
                <span>Logo position</span>
                <select class="fb-input"
                  .value=${form.style.logoPosition ?? "center-top"}
                  @change=${(e: Event) =>
                    patchStyle(state, { logoPosition: (e.target as HTMLSelectElement).value as "center-top" | "top-left" | "hidden" })}>
                  <option value="center-top">Centered (top)</option>
                  <option value="top-left">Top-left</option>
                  <option value="hidden">Hidden</option>
                </select>
              </label>
              <label class="fb-field">
                <span>Logo max width (${form.style.logoMaxWidth ?? 140}px)</span>
                <input type="range" min="40" max="400" step="4"
                  .value=${String(form.style.logoMaxWidth ?? 140)}
                  @input=${(e: Event) =>
                    patchStyle(state, { logoMaxWidth: Number((e.target as HTMLInputElement).value) })} />
              </label>
            `
            : nothing}

          <!-- Background image -->
          <label class="fb-field">
            <span>Background image URL (optional)</span>
            <input class="fb-input fb-input--mono" placeholder="https://…/bg.jpg"
              .value=${form.style.bgImageUrl ?? ""}
              @change=${(e: Event) =>
                patchStyle(state, { bgImageUrl: (e.target as HTMLInputElement).value.trim() || null })} />
          </label>
        </div>
      </details>

      <details class="fb-disclose">
        <summary>Advanced — Custom CSS</summary>
        <textarea class="fb-textarea fb-input--mono" rows="6"
          placeholder="/* injected at the end of the page */"
          .value=${form.style.customCss}
          @change=${(e: Event) =>
            patchStyle(state, { customCss: (e.target as HTMLTextAreaElement).value })}></textarea>
      </details>
    </section>
  `;
}

function colorField(label: string, value: string, onChange: (v: string) => void): TemplateResult {
  return html`
    <label class="fb-color">
      <span class="fb-color__label">${label}</span>
      <span class="fb-color__row">
        <input type="color" .value=${value || "#000000"} @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)} />
        <input class="fb-input fb-input--mono" .value=${value || ""} @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)} />
      </span>
    </label>
  `;
}

/** Segmented control helper — renders a row of option buttons. */
function segControl(
  label: string,
  options: Array<{ value: string; label: string }>,
  active: string,
  onChange: (v: string) => void,
): TemplateResult {
  return html`
    <label class="fb-field">
      <span>${label}</span>
      <div class="fb-seg">
        ${options.map(
          (o) => html`
            <button
              class="fb-seg-btn ${active === o.value ? "is-active" : ""}"
              @click=${() => onChange(o.value)}
            >${o.label}</button>
          `,
        )}
      </div>
    </label>
  `;
}

/** Mini live preview rendered inside each theme card. */
function renderThemeMiniPreview(theme: FormTheme): TemplateResult {
  const s = theme.style;
  const r = s.radius;
  const rSmall = Math.max(0, Math.round(r * 0.65));
  const density = s.density ?? "comfortable";
  const gap = density === "compact" ? "4px" : density === "spacious" ? "8px" : "6px";
  const inputPad = density === "compact" ? "4px 7px" : density === "spacious" ? "8px 12px" : "6px 10px";
  const outerPad = density === "compact" ? "9px" : density === "spacious" ? "14px" : "11px";
  const headingFont = s.headingFontStack ?? s.fontStack;

  // Compute button appearance
  let btnBg: string;
  let btnTxtColor: string;
  let btnBorder = "none";
  switch (s.buttonStyle ?? "gradient") {
    case "outline":
      btnBg = "transparent";
      btnTxtColor = s.primaryColor;
      btnBorder = `1px solid ${s.primaryColor}`;
      break;
    case "glass":
      btnBg = `${s.primaryColor}28`;
      btnTxtColor = s.primaryColor;
      btnBorder = `1px solid ${s.primaryColor}66`;
      break;
    case "neon":
      btnBg = "transparent";
      btnTxtColor = s.primaryColor;
      btnBorder = `1px solid ${s.primaryColor}`;
      break;
    case "solid":
      btnBg = s.primaryColor;
      btnTxtColor = "#000000";
      break;
    default: // gradient
      btnBg = `linear-gradient(135deg,${s.primaryColor},${s.accentColor})`;
      btnTxtColor = "#000000";
  }

  // Compute input appearance — handle underline separately to avoid CSS border shorthand issues
  const isUnderline = (s.inputStyle ?? "outline") === "underline";
  let inputBg: string;
  let inputBorderStyle: string;
  let inputRadius = `${rSmall}px`;

  if (isUnderline) {
    inputBg = "transparent";
    inputBorderStyle = `border:0;border-bottom:1px solid ${s.textColor}44`;
    inputRadius = "0px";
  } else {
    switch (s.inputStyle ?? "outline") {
      case "filled":
        inputBg = `${s.textColor}14`;
        inputBorderStyle = "border:1px solid transparent";
        break;
      case "glass":
        inputBg = `${s.textColor}0a`;
        inputBorderStyle = `border:1px solid ${s.textColor}22`;
        break;
      default: // outline
        inputBg = `${s.bgColor}b0`;
        inputBorderStyle = `border:1px solid ${s.textColor}30`;
    }
  }

  const inputStyleAttr = `font-size:7px;padding:${inputPad};border-radius:${inputRadius};background:${inputBg};color:${s.textColor}aa;${inputBorderStyle};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;

  return html`
    <div style="
      background:${s.bgColor};
      font-family:${s.fontStack};
      padding:${outerPad};
      display:flex;
      flex-direction:column;
      gap:${gap};
      width:100%;
      height:100%;
      box-sizing:border-box;
    ">
      <div style="
        font-family:${headingFont};
        font-size:9.5px;
        font-weight:800;
        color:${s.textColor};
        line-height:1.2;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        letter-spacing:-0.01em;
      ">Start your journey</div>
      <div style="${inputStyleAttr}">Your name</div>
      <div style="${inputStyleAttr}">Email address</div>
      <div style="
        font-size:7px;
        padding:${inputPad};
        border-radius:${r}px;
        background:${btnBg};
        color:${btnTxtColor};
        text-align:center;
        font-weight:800;
        border:${btnBorder};
        white-space:nowrap;
        overflow:hidden;
      ">Get started →</div>
    </div>
  `;
}

/** Lazy-load Google Fonts needed for a theme (client-side only, on demand). */
function ensureThemeFontsLoaded(theme: FormTheme): void {
  if (typeof document === "undefined") return;
  const GFONTS: Record<string, string> = {
    "Playfair Display": "Playfair+Display:ital,wght@0,400;0,700;0,800;1,400",
    "Merriweather": "Merriweather:wght@400;700;900",
    "Cormorant Garamond": "Cormorant+Garamond:ital,wght@0,400;0,600;1,400",
    "Plus Jakarta Sans": "Plus+Jakarta+Sans:wght@400;600;800",
    "DM Sans": "DM+Sans:wght@400;500;700",
    "Raleway": "Raleway:wght@400;600;800",
  };
  const fonts = [theme.style.fontStack, theme.style.headingFontStack ?? ""].join(",");
  for (const [name, spec] of Object.entries(GFONTS)) {
    if (!fonts.includes(name)) continue;
    const id = `gfont-${name.replace(/\s+/g, "-").toLowerCase()}`;
    if (document.getElementById(id)) continue;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
    document.head.appendChild(link);
  }
}

function renderContentSection(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  return html`
    <section class="fb-card">
      <h4>Content</h4>
      ${textField("Eyebrow (small caps above headline)", form.content.eyebrow, (v) => patchContent(state, { eyebrow: v }))}
      ${textField("Headline", form.content.headline, (v) => patchContent(state, { headline: v }))}
      ${textareaField("Subheadline", form.content.subheadline, (v) => patchContent(state, { subheadline: v }))}
      ${textField("CTA button label", form.content.cta, (v) => patchContent(state, { cta: v }))}
      ${textareaField("Bullets (one per line)", form.content.bullets.join("\n"), (v) =>
        patchContent(state, { bullets: v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) }))}
      ${textField("Browser title", form.content.title, (v) => patchContent(state, { title: v }))}
      ${renderStepContentEditor(state, form)}
      <h5 class="fb-subhead">Thank-you</h5>
      ${textField("Thank-you headline", form.content.thankYouHeadline, (v) => patchContent(state, { thankYouHeadline: v }))}
      ${textareaField("Thank-you body", form.content.thankYouBody, (v) => patchContent(state, { thankYouBody: v }))}
      ${textField("External thank-you URL (overrides inline)", form.content.thankYouUrl, (v) => patchContent(state, { thankYouUrl: v }))}
      ${textField("Calendly embed URL", form.content.calendlyUrl, (v) => patchContent(state, { calendlyUrl: v }))}
      ${textField("Video URL (YouTube / Vimeo / mp4)", form.content.videoUrl, (v) => patchContent(state, { videoUrl: v }))}
      ${renderTestimonialsEditor(state, form)}
    </section>
  `;
}

/**
 * Per-step content editor — only relevant for step-by-step layout.
 * Each step gets its own eyebrow / headline / subheadline. Missing
 * entries fall back to the form-level content, so authors can fill
 * in only the steps that should differ from the form-wide default.
 */
function renderStepContentEditor(
  state: AppViewState,
  form: QualifierFormConfig,
): TemplateResult {
  if (form.layout !== "step-by-step") return html``;
  // Count distinct step numbers across fields (1-indexed). At least 1.
  const stepNums = new Set<number>();
  for (const f of form.fields) stepNums.add(Math.max(1, f.step ?? 1));
  const totalSteps = Math.max(1, stepNums.size);
  const current = form.content.stepContent ?? [];
  const setStep = (
    idx: number,
    patch: { eyebrow?: string; headline?: string; subheadline?: string },
  ) => {
    const next: Array<{ eyebrow?: string; headline?: string; subheadline?: string }> = [
      ...current,
    ];
    while (next.length < totalSteps) next.push({});
    next[idx] = { ...next[idx], ...patch };
    patchContent(state, { stepContent: next });
  };

  return html`
    <h5 class="fb-subhead">Per-step content (step-by-step layout)</h5>
    <p class="fb-help">
      Each step renders as its own full-screen page. Leave a field blank to fall back to the form-level eyebrow/headline/subheadline.
    </p>
    ${Array.from({ length: totalSteps }, (_, idx) => {
      const sc = current[idx] ?? {};
      return html`
        <details class="fb-disclose" ?open=${idx === 0}>
          <summary>Step ${idx + 1}</summary>
          <div class="fb-stepcontent">
            ${textField(`Eyebrow (step ${idx + 1})`, sc.eyebrow ?? "", (v) => setStep(idx, { eyebrow: v }))}
            ${textField(`Headline (step ${idx + 1})`, sc.headline ?? "", (v) => setStep(idx, { headline: v }))}
            ${textareaField(`Subheadline (step ${idx + 1})`, sc.subheadline ?? "", (v) =>
              setStep(idx, { subheadline: v }))}
          </div>
        </details>
      `;
    })}
  `;
}

function renderTestimonialsEditor(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  return html`
    <details class="fb-disclose">
      <summary>Testimonials (${form.content.testimonials.length})</summary>
      ${form.content.testimonials.map(
        (t, i) => html`
          <div class="fb-testimonial">
            <textarea class="fb-textarea" rows="3" placeholder="Quote"
              .value=${t.quote}
              @change=${(e: Event) => {
                const next = [...form.content.testimonials];
                next[i] = { ...t, quote: (e.target as HTMLTextAreaElement).value };
                patchContent(state, { testimonials: next });
              }}></textarea>
            <div class="fb-testimonial__row">
              <input class="fb-input" placeholder="Author"
                .value=${t.author}
                @change=${(e: Event) => {
                  const next = [...form.content.testimonials];
                  next[i] = { ...t, author: (e.target as HTMLInputElement).value };
                  patchContent(state, { testimonials: next });
                }} />
              <input class="fb-input" placeholder="Role (optional)"
                .value=${t.role ?? ""}
                @change=${(e: Event) => {
                  const next = [...form.content.testimonials];
                  next[i] = { ...t, role: (e.target as HTMLInputElement).value };
                  patchContent(state, { testimonials: next });
                }} />
              <button class="fb-icon-btn" @click=${() =>
                patchContent(state, {
                  testimonials: form.content.testimonials.filter((_, j) => j !== i),
                })}>×</button>
            </div>
          </div>
        `,
      )}
      <button class="fb-btn fb-btn--sm"
        @click=${() =>
          patchContent(state, {
            testimonials: [...form.content.testimonials, { quote: "", author: "", role: "" }],
          })}>+ Add testimonial</button>
    </details>
  `;
}

function textField(label: string, value: string, onChange: (v: string) => void): TemplateResult {
  return html`
    <label class="fb-field">
      <span>${label}</span>
      <input class="fb-input" .value=${value}
        @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)} />
    </label>
  `;
}

function textareaField(label: string, value: string, onChange: (v: string) => void): TemplateResult {
  return html`
    <label class="fb-field">
      <span>${label}</span>
      <textarea class="fb-textarea" rows="3" .value=${value}
        @change=${(e: Event) => onChange((e.target as HTMLTextAreaElement).value)}></textarea>
    </label>
  `;
}

// ── Drag-and-drop wire format ─────────────────────────────────
//
// Two MIME types let the canvas tell a brand-new add (from the palette)
// apart from a reorder (from another canvas card):
//
//   application/x-fb-kind   palette chip → drop creates a new field
//   application/x-fb-field  canvas card  → drop reorders the field
//
// Per-step grouping kicks in for `multi-step` and `step-by-step`
// layouts; otherwise the canvas is a flat list.

const DND_KIND = "application/x-fb-kind";
const DND_FIELD = "application/x-fb-field";

// ── PALETTE ───────────────────────────────────────────────────

function renderFieldPalette(): TemplateResult {
  const opts = fieldKindOptions();
  return html`
    <aside class="fb-palette">
      <div class="fb-palette__head">
        <h4>Field types</h4>
        <p>Drag onto the canvas, or click to append.</p>
      </div>
      <div class="fb-palette__grid">
        ${opts.map(
          (o) => html`
            <button
              class="fb-pchip"
              draggable="true"
              title="${o.label} — drag or click to add"
              @dragstart=${(e: DragEvent) => {
                if (!e.dataTransfer) return;
                e.dataTransfer.setData(DND_KIND, o.kind);
                e.dataTransfer.effectAllowed = "copy";
                (e.currentTarget as HTMLElement).classList.add("is-dragging");
              }}
              @dragend=${(e: DragEvent) => {
                (e.currentTarget as HTMLElement).classList.remove("is-dragging");
                clearAllDropOverHighlights();
              }}
              @click=${(e: Event) => {
                e.preventDefault();
                addFieldFromClick(o.kind);
              }}
            >
              <span class="fb-pchip__icon">${o.icon}</span>
              <span class="fb-pchip__label">${o.label}</span>
              <span class="fb-pchip__hint">⠿</span>
            </button>
          `,
        )}
      </div>
    </aside>
  `;
}

// Click-handler shim — uses the imported `addField` since the palette
// click case wants to append at the end of the list, not a specific index.
function addFieldFromClick(kind: FormFieldKind): void {
  // Resolve the active form / state via the global window event bus —
  // but we don't have one. Instead, dispatch a custom event the wrapper
  // captures. Simpler: re-export addField at module scope and call it.
  // The inner handler in renderFieldPalette gets state via closure when
  // we wire it from renderFieldsTab. For palette we don't need state in
  // the chip; we'll let click bubble to the canvas which calls addField.
  // To keep palette stateless, surface a custom event:
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("fb-add-field", { detail: { kind } }));
  }
}

// ── CANVAS ────────────────────────────────────────────────────

function renderCanvas(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  const isStepped = form.layout === "multi-step" || form.layout === "step-by-step";
  // Wire the palette-click event to add at the end (per current step).
  attachAddFieldListener(state);

  if (form.fields.length === 0) {
    return html`
      ${renderCanvasHeader(state, form)}
      ${renderEmptyDropZone(state, form, 0, 1)}
    `;
  }

  if (!isStepped) {
    return html`
      ${renderCanvasHeader(state, form)}
      <div class="fb-canvas__list">
        ${renderDropSlot(state, form, 0, undefined)}
        ${form.fields.map(
          (f, i) => html`
            ${renderFieldCard(state, form, f)}
            ${renderDropSlot(state, form, i + 1, undefined)}
          `,
        )}
      </div>
    `;
  }

  // Stepped layouts — group by `field.step ?? 1`. Always render at least
  // steps 1..max(found), plus a tail "Add step N+1" affordance.
  const stepGroups = groupFieldsByStep(form.fields);
  const maxStep = Math.max(1, ...form.fields.map((f) => f.step ?? 1));
  const stepsToRender = Array.from({ length: maxStep }, (_, i) => i + 1);

  return html`
    ${renderCanvasHeader(state, form)}
    <div class="fb-canvas__steps">
      ${stepsToRender.map((stepNum) => {
        const group = stepGroups.get(stepNum) ?? [];
        return html`
          <section class="fb-step-group">
            <header class="fb-step-group__head">
              <span class="fb-step-group__num">${stepNum}</span>
              <span class="fb-step-group__title">Step ${stepNum}</span>
              <span class="fb-step-group__count">
                ${group.length} field${group.length === 1 ? "" : "s"}
              </span>
            </header>
            <div class="fb-step-group__body">
              ${renderDropSlot(state, form, indexOfFirstInStep(form.fields, stepNum), stepNum)}
              ${group.map(
                (f) => html`
                  ${renderFieldCard(state, form, f)}
                  ${renderDropSlot(
                    state,
                    form,
                    form.fields.findIndex((x) => x.id === f.id) + 1,
                    stepNum,
                  )}
                `,
              )}
              ${group.length === 0
                ? html`
                    <div class="fb-step-group__empty">
                      Drop fields here for step ${stepNum}.
                    </div>
                  `
                : nothing}
            </div>
          </section>
        `;
      })}
      <button
        class="fb-step-add"
        @click=${() => {
          // Adding step N+1 means setting the next added field's step.
          // For now, just hint the user — the next palette drop into the
          // "add step" zone below pins to maxStep + 1.
          const id = addFieldAt(state, "text", form.fields.length, maxStep + 1);
          if (id) state.requestUpdate?.();
        }}
        @dragover=${(e: DragEvent) => {
          if (!e.dataTransfer) return;
          // Accept either palette kind or existing field — both create
          // step maxStep+1.
          const types = Array.from(e.dataTransfer.types);
          if (!types.includes(DND_KIND) && !types.includes(DND_FIELD)) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).classList.add("is-over");
        }}
        @dragleave=${(e: DragEvent) => {
          (e.currentTarget as HTMLElement).classList.remove("is-over");
        }}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).classList.remove("is-over");
          handleDrop(e, state, form, form.fields.length, maxStep + 1);
        }}
      >
        + Add step ${maxStep + 1}
      </button>
    </div>
  `;
}

function renderCanvasHeader(state: AppViewState, form: QualifierFormConfig): TemplateResult {
  return html`
    <header class="fb-canvas__head">
      <div>
        <h4>Form canvas</h4>
        <p>${form.fields.length} field${form.fields.length === 1 ? "" : "s"} · layout: ${form.layout}</p>
      </div>
      <button class="fb-btn fb-btn--sm" @click=${() => addField(state, "text")}>+ Append text field</button>
    </header>
  `;
}

function renderEmptyDropZone(
  state: AppViewState,
  form: QualifierFormConfig,
  index: number,
  step: number,
): TemplateResult {
  return html`
    <div
      class="fb-empty-drop"
      @dragover=${(e: DragEvent) => {
        if (!e.dataTransfer?.types.includes(DND_KIND) && !e.dataTransfer?.types.includes(DND_FIELD)) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.add("is-over");
      }}
      @dragleave=${(e: DragEvent) => {
        (e.currentTarget as HTMLElement).classList.remove("is-over");
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.remove("is-over");
        handleDrop(e, state, form, index, step);
      }}
    >
      <div class="fb-empty-drop__inner">
        <div class="fb-empty-drop__icon">⬇</div>
        <h3>Drag a field here to start</h3>
        <p>Pick from the palette on the left, or click any chip to append.</p>
      </div>
    </div>
  `;
}

function renderDropSlot(
  state: AppViewState,
  form: QualifierFormConfig,
  index: number,
  step: number | undefined,
): TemplateResult {
  return html`
    <div
      class="fb-drop-slot"
      data-drop-index=${String(index)}
      data-drop-step=${step !== undefined ? String(step) : ""}
      @dragover=${(e: DragEvent) => {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types);
        if (!types.includes(DND_KIND) && !types.includes(DND_FIELD)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = types.includes(DND_FIELD) ? "move" : "copy";
        (e.currentTarget as HTMLElement).classList.add("is-over");
      }}
      @dragleave=${(e: DragEvent) => {
        (e.currentTarget as HTMLElement).classList.remove("is-over");
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.remove("is-over");
        handleDrop(e, state, form, index, step);
      }}
    >
      <span class="fb-drop-slot__line"></span>
    </div>
  `;
}

function renderFieldCard(
  state: AppViewState,
  form: QualifierFormConfig,
  f: FormField,
): TemplateResult {
  const s = state.leadQualifierFormsState!;
  const isActive = s.editingFieldId === f.id;
  return html`
    <article
      class="fb-fcard ${isActive ? "is-active" : ""}"
      draggable="true"
      data-field-id=${f.id}
      @dragstart=${(e: DragEvent) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData(DND_FIELD, f.id);
        e.dataTransfer.effectAllowed = "move";
        (e.currentTarget as HTMLElement).classList.add("is-dragging");
      }}
      @dragend=${(e: DragEvent) => {
        (e.currentTarget as HTMLElement).classList.remove("is-dragging");
        clearAllDropOverHighlights();
      }}
      @click=${() => {
        s.editingFieldId = f.id;
        state.requestUpdate?.();
      }}
    >
      <div class="fb-fcard__handle" title="Drag to reorder">⠿</div>
      <div class="fb-fcard__body">
        <div class="fb-fcard__meta">
          <span class="fb-fcard__kind">${kindIcon(f.kind)} ${f.kind}</span>
          ${f.required ? html`<span class="fb-tag fb-tag--req">required</span>` : nothing}
          ${(f.options?.length ?? 0) > 0
            ? html`<span class="fb-tag">${f.options!.length} opts</span>`
            : nothing}
          <span class="fb-fcard__name">${f.name}</span>
        </div>
        <div class="fb-fcard__preview">${renderFieldMockPreview(f)}</div>
      </div>
      <div class="fb-fcard__actions" @click=${(e: Event) => e.stopPropagation()}>
        <button
          class="fb-icon-btn"
          title="Duplicate"
          @click=${() => duplicateField(state, f.id)}
        >⎘</button>
        <button
          class="fb-icon-btn fb-icon-btn--danger"
          title="Delete"
          @click=${() => removeField(state, f.id)}
        >×</button>
      </div>
    </article>
  `;
}

/**
 * Schematic mini preview of a field — looks like the real input but
 * styled to read as "design surface" rather than a working form, so
 * users don't accidentally try to fill it in here.
 */
function renderFieldMockPreview(f: FormField): TemplateResult {
  const label = html`<span class="fb-mock__label">${f.label || "Untitled"}${f.required ? " *" : ""}</span>`;
  switch (f.kind) {
    case "textarea":
      return html`${label}<div class="fb-mock__textarea">${f.placeholder || "Long answer…"}</div>`;
    case "select":
      return html`${label}<div class="fb-mock__select">${f.placeholder || "— select —"} <span>▾</span></div>`;
    case "radio":
      return html`
        ${label}
        <div class="fb-mock__choices">
          ${(f.options ?? []).slice(0, 4).map(
            (o) => html`<span class="fb-mock__choice"><span class="fb-mock__radio"></span>${o.label}</span>`,
          )}
        </div>
      `;
    case "checkbox-group":
      return html`
        ${label}
        <div class="fb-mock__choices">
          ${(f.options ?? []).slice(0, 4).map(
            (o) => html`<span class="fb-mock__choice"><span class="fb-mock__check"></span>${o.label}</span>`,
          )}
        </div>
      `;
    case "checkbox":
    case "consent":
      return html`
        <div class="fb-mock__inline"><span class="fb-mock__check"></span>${f.label || "Confirm"}</div>
      `;
    case "rating": {
      const max = f.max ?? 5;
      const min = f.min ?? 1;
      return html`
        ${label}
        <div class="fb-mock__rating">
          ${Array.from({ length: max - min + 1 }, (_, i) => i + min).map(
            (n) => html`<span class="fb-mock__star">${n}</span>`,
          )}
        </div>
      `;
    }
    case "hidden":
      return html`
        <span class="fb-mock__label fb-mock__label--mute">
          hidden · default: <code>${f.defaultValue || "(empty)"}</code>
        </span>
      `;
    case "date":
      return html`${label}<div class="fb-mock__input">📅 yyyy-mm-dd</div>`;
    case "number":
      return html`${label}<div class="fb-mock__input">${f.placeholder || "0"}</div>`;
    default:
      return html`${label}<div class="fb-mock__input">${f.placeholder || "Type here…"}</div>`;
  }
}

function kindIcon(kind: FormFieldKind): string {
  const opt = fieldKindOptions().find((o) => o.kind === kind);
  return opt?.icon ?? "•";
}

// ── DnD shared logic ──────────────────────────────────────────

/**
 * Resolve a drop event into the right controller call. The drop slot
 * passes its own index (post-source-removal-aware bookkeeping is done
 * inside the controller by re-finding the source after splice).
 */
function handleDrop(
  e: DragEvent,
  state: AppViewState,
  form: QualifierFormConfig,
  index: number,
  step: number | undefined,
): void {
  if (!e.dataTransfer) return;
  const kind = e.dataTransfer.getData(DND_KIND) as FormFieldKind | "";
  const fieldId = e.dataTransfer.getData(DND_FIELD);
  if (kind) {
    addFieldAt(state, kind, index, step);
    return;
  }
  if (fieldId) {
    // Reordering within the same list: the source field will be removed
    // before being re-inserted, which shifts the target index when the
    // source was *before* the drop point. Account for that here so the
    // visible drop indicator and the resulting slot match.
    const src = form.fields.findIndex((f) => f.id === fieldId);
    let target = index;
    if (src >= 0 && src < index) target -= 1;
    moveFieldTo(state, fieldId, target, step);
  }
}

function clearAllDropOverHighlights(): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".fb-drop-slot.is-over, .fb-empty-drop.is-over, .fb-step-add.is-over")
    .forEach((el) => el.classList.remove("is-over"));
}

function groupFieldsByStep(fields: FormField[]): Map<number, FormField[]> {
  const out = new Map<number, FormField[]>();
  for (const f of fields) {
    const s = Math.max(1, f.step ?? 1);
    if (!out.has(s)) out.set(s, []);
    out.get(s)!.push(f);
  }
  return out;
}

function indexOfFirstInStep(fields: FormField[], step: number): number {
  const i = fields.findIndex((f) => (f.step ?? 1) === step);
  return i < 0 ? fields.length : i;
}

// One-shot binding from the palette's click event → addField. We use a
// document-level CustomEvent so the palette chip rendering stays pure
// (no state closure), and rebind on every renderCanvas call. The
// listener is idempotent — we replace it each time so it always sees
// the latest `state` reference.
let _lastAddFieldListener: ((e: Event) => void) | null = null;
function attachAddFieldListener(state: AppViewState): void {
  if (typeof document === "undefined") return;
  if (_lastAddFieldListener) {
    document.removeEventListener("fb-add-field", _lastAddFieldListener);
  }
  const handler = (e: Event) => {
    const ce = e as CustomEvent<{ kind: FormFieldKind }>;
    addField(state, ce.detail.kind);
  };
  document.addEventListener("fb-add-field", handler);
  _lastAddFieldListener = handler;
}

function renderFieldDetail(
  state: AppViewState,
  form: QualifierFormConfig,
  fieldId: string,
): TemplateResult {
  const f = form.fields.find((x) => x.id === fieldId);
  if (!f) return html``;
  const isChoice = f.kind === "select" || f.kind === "radio" || f.kind === "checkbox-group";
  const isNumber = f.kind === "number" || f.kind === "rating";
  return html`
    <div class="fb-detail">
      <h4>Edit field</h4>
      ${textField("Label", f.label, (v) => updateField(state, f.id, { label: v }))}
      <label class="fb-field">
        <span>Field name (used by qualifier criteria)</span>
        <input class="fb-input fb-input--mono" .value=${f.name}
          @change=${(e: Event) => updateField(state, f.id, { name: (e.target as HTMLInputElement).value.trim() })} />
      </label>
      <label class="fb-field">
        <span>Kind</span>
        <select class="fb-input"
          .value=${f.kind}
          @change=${(e: Event) => updateField(state, f.id, { kind: (e.target as HTMLSelectElement).value as FormFieldKind })}>
          ${fieldKindOptions().map((o) => html`<option value=${o.kind}>${o.label}</option>`)}
        </select>
      </label>
      ${f.kind !== "consent" && f.kind !== "hidden"
        ? textField("Placeholder", f.placeholder ?? "", (v) => updateField(state, f.id, { placeholder: v }))
        : nothing}
      ${f.kind === "hidden"
        ? textField("Default value", f.defaultValue ?? "", (v) => updateField(state, f.id, { defaultValue: v }))
        : nothing}
      ${textField("Help text (optional)", f.helpText ?? "", (v) => updateField(state, f.id, { helpText: v }))}
      <label class="fb-field fb-field--row">
        <input type="checkbox" ?checked=${f.required}
          @change=${(e: Event) => updateField(state, f.id, { required: (e.target as HTMLInputElement).checked })} />
        <span>Required</span>
      </label>
      ${form.layout === "multi-step"
        ? html`
            <label class="fb-field">
              <span>Step (which page this field shows on)</span>
              <input type="number" min="1" class="fb-input" .value=${String(f.step ?? 1)}
                @change=${(e: Event) => updateField(state, f.id, { step: Number((e.target as HTMLInputElement).value) || 1 })} />
            </label>
          `
        : nothing}
      ${form.layout === "two-column"
        ? html`
            <label class="fb-field">
              <span>Column span (1-12)</span>
              <input type="number" min="1" max="12" class="fb-input" .value=${String(f.span ?? 6)}
                @change=${(e: Event) => updateField(state, f.id, { span: Number((e.target as HTMLInputElement).value) || 6 })} />
            </label>
          `
        : nothing}
      ${isNumber
        ? html`
            <div class="fb-row">
              <label class="fb-field">
                <span>Min</span>
                <input type="number" class="fb-input" .value=${String(f.min ?? "")}
                  @change=${(e: Event) => updateField(state, f.id, { min: Number((e.target as HTMLInputElement).value) || undefined })} />
              </label>
              <label class="fb-field">
                <span>Max</span>
                <input type="number" class="fb-input" .value=${String(f.max ?? "")}
                  @change=${(e: Event) => updateField(state, f.id, { max: Number((e.target as HTMLInputElement).value) || undefined })} />
              </label>
            </div>
          `
        : nothing}
      ${isChoice ? renderOptionsEditor(state, f) : nothing}
    </div>
  `;
}

function renderOptionsEditor(state: AppViewState, field: FormField): TemplateResult {
  return html`
    <div class="fb-options">
      <h5 class="fb-subhead">Options (score adds to qualifying total)</h5>
      ${(field.options ?? []).map(
        (opt, i) => html`
          <div class="fb-option-row">
            <input class="fb-input" placeholder="Label" .value=${opt.label}
              @change=${(e: Event) => updateFieldOption(state, field.id, i, { label: (e.target as HTMLInputElement).value })} />
            <input class="fb-input fb-input--mono" placeholder="value" .value=${opt.value}
              @change=${(e: Event) => updateFieldOption(state, field.id, i, { value: (e.target as HTMLInputElement).value })} />
            <input type="number" class="fb-input fb-input--narrow" placeholder="0" .value=${String(opt.score ?? 0)}
              @change=${(e: Event) => updateFieldOption(state, field.id, i, { score: Number((e.target as HTMLInputElement).value) || 0 })} />
            <button class="fb-icon-btn" @click=${() => removeFieldOption(state, field.id, i)}>×</button>
          </div>
        `,
      )}
      <button class="fb-btn fb-btn--sm" @click=${() => addFieldOption(state, field.id)}>+ Add option</button>
    </div>
  `;
}


function renderKpiHeadline(kpi: FormKpiSummary): TemplateResult {
  const conversion = (kpi.conversionRate * 100).toFixed(1);
  const qualifiedRate = (kpi.qualifiedRate * 100).toFixed(1);
  return html`
    <div class="fb-kpi-grid">
      ${kpiCard("Views", String(kpi.views))}
      ${kpiCard("Starts", String(kpi.starts))}
      ${kpiCard("Submits", String(kpi.submits))}
      ${kpiCard("Conversion", `${conversion}%`)}
      ${kpiCard("Qualified", String(kpi.qualified))}
      ${kpiCard("Qualified rate", `${qualifiedRate}%`)}
    </div>
  `;
}

function kpiCard(label: string, value: string): TemplateResult {
  return html`
    <div class="fb-kpi-card">
      <div class="fb-kpi-card__label">${label}</div>
      <div class="fb-kpi-card__value">${value}</div>
    </div>
  `;
}

function renderHourlyChart(kpi: FormKpiSummary): TemplateResult {
  const max = Math.max(1, ...kpi.hourly.map((h) => Math.max(h.views, h.submits)));
  return html`
    <section class="fb-card">
      <h4>Last 24h</h4>
      <div class="fb-hour-chart">
        ${kpi.hourly.map(
          (h) => html`
            <div class="fb-hour-bar" title="${h.hour}:00 — ${h.views} views, ${h.submits} submits">
              <span class="fb-hour-bar__views" style="height:${(h.views / max) * 100}%"></span>
              <span class="fb-hour-bar__submits" style="height:${(h.submits / max) * 100}%"></span>
              <span class="fb-hour-bar__label">${h.hour}</span>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderBySource(kpi: FormKpiSummary): TemplateResult {
  const max = Math.max(1, ...kpi.bySource.map((b) => b.views));
  return html`
    <section class="fb-card">
      <h4>Top sources (UTM)</h4>
      ${kpi.bySource.length === 0
        ? html`<div class="fb-empty">No traffic yet.</div>`
        : kpi.bySource.map(
            (s) => html`
              <div class="fb-source-row">
                <span class="fb-source-row__name">${s.source}</span>
                <span class="fb-source-row__bar">
                  <span style="width:${(s.views / max) * 100}%"></span>
                </span>
                <span class="fb-source-row__stat">${s.views} v · ${s.submits} s</span>
              </div>
            `,
          )}
    </section>
  `;
}

function renderAbandonment(kpi: FormKpiSummary): TemplateResult {
  return html`
    <section class="fb-card">
      <h4>Abandonment by field</h4>
      ${kpi.fieldAbandonment.length === 0
        ? html`<div class="fb-empty">No abandonment data yet.</div>`
        : kpi.fieldAbandonment.map(
            (f) => html`
              <div class="fb-abandon-row">
                <span class="fb-abandon-row__name">${f.field}</span>
                <span class="fb-abandon-row__count">${f.count}</span>
              </div>
            `,
          )}
    </section>
  `;
}

function renderSubmissions(submissions: FormSubmissionRecord[]): TemplateResult {
  return html`
    <section class="fb-card">
      <h4>Recent submissions</h4>
      ${submissions.length === 0
        ? html`<div class="fb-empty">No submissions yet.</div>`
        : html`
            <div class="fb-subs">
              ${submissions.slice(0, 30).map(
                (s) => html`
                  <div class="fb-sub-row fb-sub-row--${s.qualified ? "ok" : "skip"}">
                    <span class="fb-sub-row__time">${new Date(s.ts).toLocaleString()}</span>
                    <span class="fb-sub-row__badge">${s.qualified ? "qualified" : "unqualified"}</span>
                    <span class="fb-sub-row__score">Score: ${s.score}</span>
                    <span class="fb-sub-row__payload" title=${JSON.stringify(s.payload)}>
                      ${JSON.stringify(s.payload).slice(0, 80)}…
                    </span>
                  </div>
                `,
              )}
            </div>
          `}
    </section>
  `;
}


function copy(text: string): void {
  if (!text) return;
  try { void navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

// ── Styles ────────────────────────────────────────────────────

function formBuilderStyles(): TemplateResult {
  return html`
    <style>
      .fb-shell {
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 4%, transparent), transparent),
          color-mix(in srgb, var(--g-bg, var(--glass-3)) 55%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 16px;
        padding: 18px 22px;
        backdrop-filter: blur(14px) saturate(140%);
        margin-top: 16px;
      }
      .fb-header {
        display: flex; justify-content: space-between; align-items: flex-start;
        gap: 18px; flex-wrap: wrap; margin-bottom: 12px;
      }
      .fb-header h2 {
        margin: 0; font-size: 16px; font-weight: 800; letter-spacing: 0.04em;
        text-transform: uppercase; color: var(--g-primary);
      }
      .fb-header__row { display: inline-flex; align-items: center; gap: 10px; }
      .fb-header__icon { font-size: 18px; color: var(--g-primary); }
      .fb-header__sub {
        margin: 6px 0 0; font-size: 12px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 90%, transparent);
        max-width: 560px; line-height: 1.5;
      }
      .fb-header__actions { display: inline-flex; gap: 8px; flex-wrap: wrap; }
      .fb-pill {
        padding: 3px 10px; font-size: 10px; font-weight: 800; letter-spacing: 0.12em;
        text-transform: uppercase; border-radius: 99px;
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        color: var(--g-primary);
      }
      .fb-pill--off { background: color-mix(in srgb, var(--glass-gold) 18%, transparent); color: var(--glass-gold); }
      .fb-banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 10px; font-size: 12px; font-weight: 600; }
      .fb-banner--err { background: rgba(239, 68, 68, 0.12); color: #ff8a8a; border: 1px solid rgba(239, 68, 68, 0.35); }

      /* Buttons */
      .fb-btn {
        padding: 7px 14px; font-family: inherit; font-size: 12px; font-weight: 700;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 6px; cursor: pointer;
        transition: background 0.15s, border-color 0.15s, transform 0.1s;
      }
      .fb-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      }
      .fb-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .fb-btn--primary {
        background: linear-gradient(135deg, var(--g-primary), color-mix(in srgb, var(--g-primary) 60%, #5a3a00));
        color: var(--glass-ink); border-color: var(--g-primary);
        box-shadow: 0 4px 14px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .fb-btn--sm { padding: 4px 10px; font-size: 11px; }
      .fb-btn--lg { padding: 10px 22px; font-size: 13px; }
      .fb-btn--on { background: rgba(16, 185, 129, 0.14); color: #34d399; border-color: rgba(16, 185, 129, 0.35); }
      .fb-btn--off { background: rgba(239, 68, 68, 0.12); color: #ff8a8a; border-color: rgba(239, 68, 68, 0.35); }
      .fb-btn--danger { background: rgba(239, 68, 68, 0.18); color: #ff8a8a; border-color: rgba(239, 68, 68, 0.45); }
      .fb-icon-btn {
        width: 26px; height: 26px;
        display: inline-flex; align-items: center; justify-content: center;
        background: transparent;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 5px; cursor: pointer; font-size: 13px;
      }
      .fb-icon-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
      }

      /* Grid + list */
      .fb-grid {
        display: grid; grid-template-columns: 260px minmax(0, 1fr);
        gap: 16px; align-items: flex-start;
      }
      @media (max-width: 920px) {
        .fb-grid { grid-template-columns: 1fr; }
      }
      .fb-side { display: flex; flex-direction: column; gap: 6px; }
      .fb-list { display: flex; flex-direction: column; gap: 4px; }
      .fb-list__row {
        display: grid;
        grid-template-columns: 28px 1fr auto;
        gap: 10px; align-items: center;
        padding: 8px 10px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 8px;
        cursor: pointer; font-family: inherit; color: inherit;
        text-align: left;
        transition: background 0.12s, border-color 0.12s;
      }
      .fb-list__row:hover { background: color-mix(in srgb, var(--g-primary) 10%, transparent); }
      .fb-list__row.is-active {
        border-color: var(--g-primary);
        box-shadow: 0 0 0 1px var(--g-primary);
      }
      .fb-list__swatch {
        width: 28px; height: 28px; border-radius: 6px;
        border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
      }
      .fb-list__name {
        display: flex; flex-direction: column; gap: 1px;
        font-size: 13px; font-weight: 600; color: var(--g-fg, var(--glass-fg));
      }
      .fb-list__tag { font-size: 10px; color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent); font-weight: 500; }
      .fb-list__state {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 10px; color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 80%, transparent);
      }
      .fb-dot.is-on { background: #34d399; box-shadow: 0 0 8px rgba(16, 185, 129, 0.6); }

      /* Empty states */
      .fb-empty {
        padding: 40px 18px; text-align: center; font-style: italic;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        font-size: 12px;
      }
      .fb-empty-card {
        padding: 56px 24px; text-align: center;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px dashed color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 14px;
      }
      .fb-empty-card__icon { font-size: 38px; color: var(--g-primary); margin-bottom: 12px; }
      .fb-empty-card h3 {
        margin: 0 0 6px; font-size: 17px; color: var(--g-primary);
        font-weight: 800; letter-spacing: -0.005em;
      }
      .fb-empty-card p {
        margin: 0 auto 16px;
        max-width: 480px; font-size: 13px; line-height: 1.55;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }

      /* Overlay modal */
      .fb-overlay {
        position: fixed; inset: 0;
        display: flex; align-items: center; justify-content: center;
        background: color-mix(in srgb, var(--glass-base) 60%, transparent);
        backdrop-filter: blur(8px);
        z-index: 1000;
        padding: 24px;
      }
      .fb-modal {
        width: min(1100px, 100%);
        max-height: 80vh; overflow-y: auto;
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 95%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 16px;
        padding: 22px;
      }
      .fb-modal header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 18px;
      }
      .fb-modal h3 {
        margin: 0; font-size: 16px; letter-spacing: 0.06em;
        color: var(--g-primary); font-weight: 800; text-transform: uppercase;
      }
      .fb-template-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 12px;
      }
      .fb-template-card {
        text-align: left; cursor: pointer; font-family: inherit;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 12px; overflow: hidden;
        transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
        color: inherit;
      }
      .fb-template-card:hover {
        transform: translateY(-2px);
        border-color: var(--g-primary);
        box-shadow: 0 12px 28px color-mix(in srgb, var(--g-primary) 18%, transparent);
      }
      .fb-template-card__swatch { height: 90px; }
      .fb-template-card__body { padding: 14px 16px; }
      .fb-template-card__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
      .fb-template-card__badge {
        font-size: 11px; padding: 3px 9px; border-radius: 99px;
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        color: var(--g-primary); font-weight: 700;
      }
      .fb-template-card__cat {
        font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-template-card__title { font-size: 14px; font-weight: 700; color: var(--g-primary); margin-bottom: 4px; }
      .fb-template-card__tag {
        font-size: 11.5px; line-height: 1.45;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        margin-bottom: 10px;
      }
      .fb-template-card__stats {
        display: flex; gap: 6px; font-size: 10px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        letter-spacing: 0.08em; text-transform: uppercase;
      }

      /* Tabs */
      .fb-tabs {
        display: inline-flex; gap: 4px; padding: 4px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
        border-radius: 8px;
        margin-bottom: 12px;
      }
      .fb-tab {
        padding: 6px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
        background: transparent;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        border: none; border-radius: 6px; cursor: pointer; font-family: inherit;
      }
      .fb-tab.is-active {
        background: color-mix(in srgb, var(--g-primary) 18%, transparent);
        color: var(--g-primary);
      }

      /* Editor grid */
      .fb-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: flex-start; }
      @media (max-width: 1100px) { .fb-editor-grid { grid-template-columns: 1fr; } }
      .fb-editor-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

      .fb-card {
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 12px;
        padding: 14px 16px;
      }
      .fb-card--danger { border-color: rgba(239, 68, 68, 0.35); }
      .fb-card h4 {
        margin: 0 0 10px; font-size: 11px; font-weight: 800; letter-spacing: 0.14em;
        text-transform: uppercase; color: var(--g-primary);
      }
      .fb-subhead {
        font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        margin: 12px 0 6px;
      }
      .fb-hint {
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 100%, transparent);
        line-height: 1.4; margin: 4px 0 0;
      }
      .fb-hint code {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        padding: 1px 5px; border-radius: 3px;
      }

      /* Inputs */
      .fb-field {
        display: flex; flex-direction: column; gap: 4px;
        margin-bottom: 8px;
      }
      .fb-field > span {
        font-size: 9px; font-weight: 700; letter-spacing: 0.16em;
        text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-field--row {
        flex-direction: row; align-items: center; gap: 8px;
      }
      .fb-field--row > span {
        font-size: 12px; letter-spacing: 0; text-transform: none;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        font-weight: 500;
      }
      .fb-input {
        width: 100%; padding: 7px 10px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        color: var(--g-fg, var(--glass-fg));
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 5px; font-family: inherit; font-size: 12px; outline: none;
      }
      .fb-input:focus {
        border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .fb-input--mono { font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 11px; }
      .fb-input--narrow { max-width: 80px; }
      .fb-textarea {
        width: 100%; padding: 8px 10px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent); color: var(--g-fg, var(--glass-fg));
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 6px; font-family: inherit; font-size: 12px;
        resize: vertical; outline: none;
      }
      .fb-input-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .fb-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .fb-row > .fb-field { flex: 1; }
      .fb-flex-1 { flex: 1; min-width: 0; }

      /* Netlify accordion result panel */
      .fb-netlify {
        display: flex; flex-direction: column; gap: 10px;
      }
      .fb-netlify-result {
        margin-top: 10px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 8px;
      }

      .fb-color {
        display: flex; flex-direction: column; gap: 4px;
      }
      .fb-color__label {
        font-size: 9px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-color__row { display: flex; gap: 6px; align-items: center; }
      .fb-color__row input[type="color"] {
        width: 36px; height: 30px; border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 4px; background: transparent;
      }
      .fb-style-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px; margin-bottom: 12px;
      }

      .fb-disclose summary {
        cursor: pointer; padding: 6px 0;
        font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }

      /* Layout picker */
      .fb-layout-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
      }
      .fb-layout {
        cursor: pointer; background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
        border-radius: 10px; padding: 12px;
        text-align: left; font-family: inherit; color: inherit;
        transition: all 0.15s;
      }
      .fb-layout:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      .fb-layout.is-active {
        border-color: var(--g-primary);
        box-shadow: 0 0 0 1px var(--g-primary);
      }
      .fb-layout__icon { font-size: 20px; color: var(--g-primary); margin-bottom: 6px; }
      .fb-layout__name { font-size: 12px; font-weight: 700; color: var(--g-primary); }
      .fb-layout__desc { font-size: 10.5px; color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent); margin-top: 2px; line-height: 1.4; }

      /* Preview pane */
      .fb-preview { display: flex; flex-direction: column; gap: 8px; }
      .fb-preview__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
      .fb-preview__frame {
        min-height: 520px; border-radius: 8px; overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        background: var(--glass-fg);
      }
      .fb-iframe { width: 100%; height: 600px; border: 0; display: block; }
      .fb-preview__placeholder {
        padding: 60px 24px; text-align: center; color: color-mix(in srgb, var(--glass-gold) 40%, transparent);
        background: var(--glass-3); height: 100%;
        font-style: italic; font-size: 12px;
      }
      .fb-link { font-size: 11px; color: var(--g-primary); text-decoration: underline; }

      /* ── Drag-and-drop builder (Fields tab) ─────────────────────── */
      .fb-builder {
        display: grid;
        grid-template-columns: 220px minmax(0, 1fr) 360px;
        gap: 12px;
        align-items: flex-start;
      }
      @media (max-width: 1180px) {
        .fb-builder { grid-template-columns: 200px minmax(0, 1fr); }
        .fb-inspector { grid-column: 1 / -1; }
      }
      @media (max-width: 760px) {
        .fb-builder { grid-template-columns: 1fr; }
        .fb-palette { order: 1; }
        .fb-canvas { order: 2; }
        .fb-inspector { order: 3; }
      }

      /* Palette */
      .fb-palette {
        position: sticky; top: 12px;
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 12px;
        padding: 12px 12px 10px;
        max-height: calc(100vh - 200px);
        overflow-y: auto;
      }
      .fb-palette__head { margin-bottom: 10px; }
      .fb-palette__head h4 {
        margin: 0 0 3px; font-size: 11px; font-weight: 800; letter-spacing: 0.14em;
        text-transform: uppercase; color: var(--g-primary);
      }
      .fb-palette__head p {
        margin: 0; font-size: 10px; line-height: 1.4;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-palette__grid {
        display: flex; flex-direction: column; gap: 4px;
      }
      .fb-pchip {
        display: grid; grid-template-columns: 22px 1fr 14px;
        gap: 8px; align-items: center;
        padding: 7px 10px;
        background: color-mix(in srgb, var(--glass-base) 28%, transparent);
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 7px;
        cursor: grab; font-family: inherit; font-size: 11.5px; font-weight: 600;
        text-align: left;
        transition: background 0.12s, border-color 0.12s, transform 0.1s;
      }
      .fb-pchip:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        color: var(--g-primary);
        transform: translateX(2px);
      }
      .fb-pchip:active { cursor: grabbing; }
      .fb-pchip.is-dragging { opacity: 0.4; }
      .fb-pchip__icon {
        font-family: "JetBrains Mono", monospace;
        font-size: 13px; color: var(--g-primary);
        text-align: center;
      }
      .fb-pchip__hint {
        font-size: 10px; opacity: 0.45;
      }

      /* Canvas */
      .fb-canvas { min-width: 0; }
      .fb-canvas__head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 4px 12px;
      }
      .fb-canvas__head h4 {
        margin: 0; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
        color: var(--g-primary); font-weight: 800;
      }
      .fb-canvas__head p {
        margin: 2px 0 0; font-size: 10.5px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-canvas__list,
      .fb-canvas__steps {
        display: flex; flex-direction: column; gap: 0;
      }
      .fb-canvas__steps { gap: 14px; }

      /* Step group container */
      .fb-step-group {
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 12px;
        overflow: hidden;
      }
      .fb-step-group__head {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      }
      .fb-step-group__num {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; border-radius: 50%;
        background: color-mix(in srgb, var(--g-primary) 22%, transparent);
        color: var(--g-primary); font-size: 11px; font-weight: 800;
      }
      .fb-step-group__title {
        flex: 1;
        font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--g-primary); font-weight: 700;
      }
      .fb-step-group__count {
        font-size: 10px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-step-group__body {
        padding: 8px 10px 10px;
        display: flex; flex-direction: column; gap: 0;
        min-height: 60px;
      }
      .fb-step-group__empty {
        margin: 8px 6px;
        padding: 18px 14px;
        border: 1px dashed color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 8px;
        text-align: center;
        font-size: 11px; font-style: italic;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-step-add {
        align-self: stretch;
        padding: 14px;
        background: transparent;
        border: 1px dashed color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 12px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        font: inherit; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }
      .fb-step-add:hover,
      .fb-step-add.is-over {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border-color: var(--g-primary);
        border-style: solid;
        color: var(--g-primary);
      }

      /* Drop slot — thin band between field cards */
      .fb-drop-slot {
        position: relative;
        height: 8px;
        transition: height 0.12s;
      }
      .fb-drop-slot__line {
        position: absolute; left: 8px; right: 8px; top: 50%;
        height: 2px;
        background: transparent;
        border-radius: 99px;
        transform: translateY(-1px);
        transition: background 0.15s, box-shadow 0.15s;
      }
      .fb-drop-slot.is-over {
        height: 28px;
      }
      .fb-drop-slot.is-over .fb-drop-slot__line {
        background: var(--g-primary);
        box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 55%, transparent);
      }
      .fb-drop-slot.is-over::before {
        content: "↓ drop here";
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        font-size: 9px; font-weight: 800; letter-spacing: 0.18em;
        text-transform: uppercase; color: var(--g-primary);
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 92%, transparent);
        padding: 2px 8px; border-radius: 99px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 50%, transparent);
      }

      /* Empty drop (no fields yet) */
      .fb-empty-drop {
        margin: 8px 0;
        padding: 48px 24px;
        border: 2px dashed color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 14px;
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        text-align: center;
        transition: background 0.15s, border-color 0.15s;
      }
      .fb-empty-drop.is-over {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: var(--g-primary);
        border-style: solid;
      }
      .fb-empty-drop__icon {
        font-size: 28px; color: var(--g-primary); margin-bottom: 8px;
        animation: fb-bob 1.8s ease-in-out infinite;
      }
      .fb-empty-drop__inner h3 {
        margin: 0 0 4px; font-size: 14px; color: var(--g-primary);
        letter-spacing: 0.04em; text-transform: uppercase; font-weight: 800;
      }
      .fb-empty-drop__inner p {
        margin: 0 auto; max-width: 360px; font-size: 12px; line-height: 1.5;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      @keyframes fb-bob {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(4px); }
      }

      /* Field card on canvas */
      .fb-fcard {
        display: grid;
        grid-template-columns: 22px 1fr auto;
        gap: 10px;
        align-items: stretch;
        padding: 12px 12px 12px 6px;
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 60%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 10px;
        cursor: pointer;
        transition: border-color 0.15s, transform 0.1s, box-shadow 0.15s;
      }
      .fb-fcard:hover {
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        box-shadow: 0 8px 20px color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .fb-fcard.is-active {
        border-color: var(--g-primary);
        box-shadow: 0 0 0 1px var(--g-primary), 0 10px 24px color-mix(in srgb, var(--g-primary) 14%, transparent);
      }
      .fb-fcard.is-dragging { opacity: 0.35; }
      .fb-fcard__handle {
        display: flex; align-items: center; justify-content: center;
        font-family: "JetBrains Mono", monospace;
        font-size: 16px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        cursor: grab;
        user-select: none;
      }
      .fb-fcard:active .fb-fcard__handle { cursor: grabbing; }
      .fb-fcard__body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .fb-fcard__meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .fb-fcard__kind {
        font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--g-primary); font-weight: 700;
      }
      .fb-fcard__name {
        font-family: "JetBrains Mono", monospace;
        font-size: 10px;
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 100%, transparent);
        margin-left: auto;
      }
      .fb-fcard__actions {
        display: flex; flex-direction: column; gap: 4px;
        align-items: flex-end;
        opacity: 0; transition: opacity 0.12s;
      }
      .fb-fcard:hover .fb-fcard__actions,
      .fb-fcard.is-active .fb-fcard__actions { opacity: 1; }
      .fb-icon-btn--danger {
        color: #ff8a8a;
        border-color: rgba(239, 68, 68, 0.22);
      }
      .fb-icon-btn--danger:hover {
        background: rgba(239, 68, 68, 0.12);
        color: #ff8a8a;
        border-color: rgba(239, 68, 68, 0.5);
      }

      /* Schematic mock preview inside the field card */
      .fb-fcard__preview { display: flex; flex-direction: column; gap: 4px; }
      .fb-mock__label {
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg, var(--glass-fg)) 90%, transparent);
        font-weight: 600;
      }
      .fb-mock__label--mute { color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent); }
      .fb-mock__label--mute code {
        font-family: "JetBrains Mono", monospace;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        padding: 1px 5px; border-radius: 3px;
      }
      .fb-mock__input,
      .fb-mock__select,
      .fb-mock__textarea {
        padding: 6px 10px;
        background: color-mix(in srgb, var(--glass-base) 28%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-radius: 5px;
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-mock__textarea { min-height: 36px; }
      .fb-mock__select {
        display: flex; justify-content: space-between; align-items: center;
      }
      .fb-mock__choices {
        display: flex; flex-wrap: wrap; gap: 6px 12px;
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .fb-mock__choice { display: inline-flex; align-items: center; gap: 5px; }
      .fb-mock__radio {
        width: 10px; height: 10px; border-radius: 50%;
        border: 1.5px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      .fb-mock__check {
        width: 10px; height: 10px; border-radius: 2px;
        border: 1.5px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      .fb-mock__inline {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .fb-mock__rating { display: inline-flex; gap: 4px; }
      .fb-mock__star {
        width: 22px; height: 22px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
        font-size: 10px; font-weight: 700;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }

      /* Tag pills (still used by the inspector & cards) */
      .fb-tag {
        font-size: 9px; padding: 2px 6px; border-radius: 99px;
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
        letter-spacing: 0.1em; text-transform: uppercase;
      }
      .fb-tag--req { background: color-mix(in srgb, var(--glass-gold) 18%, transparent); color: var(--glass-gold); }

      /* Inspector */
      .fb-inspector {
        position: sticky; top: 12px;
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 12px;
        padding: 14px 16px;
        max-height: calc(100vh - 200px);
        overflow-y: auto;
      }
      .fb-inspector__empty {
        text-align: center; padding: 18px 4px;
      }
      .fb-inspector__empty-icon {
        font-size: 28px; color: var(--g-primary); margin-bottom: 6px;
      }
      .fb-inspector__empty h4 {
        margin: 0 0 4px; font-size: 11px; letter-spacing: 0.14em;
        text-transform: uppercase; color: var(--g-primary);
      }
      .fb-inspector__empty p {
        margin: 0; font-size: 11.5px; line-height: 1.5;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .fb-detail h4 {
        margin: 0 0 10px; font-size: 11px; letter-spacing: 0.14em;
        text-transform: uppercase; color: var(--g-primary);
      }
      .fb-options { margin-top: 8px; }
      .fb-option-row {
        display: grid; grid-template-columns: 1fr 1fr 80px 26px;
        gap: 6px; align-items: center; margin-bottom: 4px;
      }
      .fb-testimonial { margin-bottom: 8px; }
      .fb-testimonial__row { display: flex; gap: 6px; margin-top: 4px; }

      /* Analytics */
      .fb-analytics__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
      .fb-analytics__head h4 {
        margin: 0; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
        color: var(--g-primary);
      }
      .fb-kpi-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px; margin-bottom: 12px;
      }
      .fb-kpi-card {
        padding: 14px 16px;
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 10px;
      }
      .fb-kpi-card__label {
        font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        margin-bottom: 6px;
      }
      .fb-kpi-card__value { font-size: 22px; font-weight: 800; color: var(--g-primary); }
      .fb-analytics__grid {
        display: grid; grid-template-columns: 2fr 1fr 1fr;
        gap: 10px; margin-bottom: 12px;
      }
      @media (max-width: 980px) { .fb-analytics__grid { grid-template-columns: 1fr; } }
      .fb-hour-chart {
        display: flex; align-items: flex-end; gap: 4px;
        height: 140px; padding-top: 12px;
      }
      .fb-hour-bar {
        flex: 1;
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        position: relative;
      }
      .fb-hour-bar__views,
      .fb-hour-bar__submits {
        width: 100%; min-height: 2px; border-radius: 2px 2px 0 0;
      }
      .fb-hour-bar__views {
        background: color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      .fb-hour-bar__submits {
        background: var(--g-primary);
        position: absolute; bottom: 14px; left: 0;
      }
      .fb-hour-bar__label {
        font-size: 9px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        font-variant-numeric: tabular-nums;
      }
      .fb-source-row {
        display: grid; grid-template-columns: 100px 1fr 90px;
        gap: 8px; align-items: center; padding: 5px 0;
      }
      .fb-source-row__name {
        font-size: 11px; font-family: "JetBrains Mono", monospace;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .fb-source-row__bar {
        height: 6px; border-radius: 99px;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        overflow: hidden;
      }
      .fb-source-row__bar > span {
        display: block; height: 100%; background: var(--g-primary);
        border-radius: 99px;
      }
      .fb-source-row__stat {
        font-size: 10px; text-align: right;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        font-variant-numeric: tabular-nums;
      }
      .fb-abandon-row {
        display: flex; justify-content: space-between;
        padding: 5px 0; font-size: 11px;
        border-bottom: 1px dashed color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .fb-abandon-row__name {
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        font-family: "JetBrains Mono", monospace;
      }
      .fb-abandon-row__count { color: var(--glass-gold); font-weight: 700; }

      .fb-subs { display: flex; flex-direction: column; gap: 4px; }
      .fb-sub-row {
        display: grid;
        grid-template-columns: 160px auto 90px 1fr;
        gap: 8px; align-items: center;
        padding: 6px 10px;
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-radius: 5px; font-size: 11px;
      }
      .fb-sub-row__time {
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 100%, transparent);
        font-variant-numeric: tabular-nums;
      }
      .fb-sub-row__badge {
        font-size: 9px; padding: 2px 8px; border-radius: 99px;
        letter-spacing: 0.12em; text-transform: uppercase; font-weight: 800;
      }
      .fb-sub-row--ok .fb-sub-row__badge { background: rgba(16, 185, 129, 0.16); color: #34d399; }
      .fb-sub-row--skip .fb-sub-row__badge { background: rgba(239, 68, 68, 0.14); color: #ff8a8a; }
      .fb-sub-row__score { color: var(--g-primary); font-weight: 700; }
      .fb-sub-row__payload {
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        font-family: "JetBrains Mono", monospace; font-size: 10px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      /* Embed */
      .fb-embed { display: flex; flex-direction: column; gap: 12px; }
      .fb-pre {
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        padding: 12px 14px;
        border-radius: 6px;
        font-family: "JetBrains Mono", "Fira Code", monospace;
        font-size: 11px; line-height: 1.5;
        color: color-mix(in srgb, var(--g-fg, var(--glass-fg)) 90%, transparent);
        overflow: auto; white-space: pre-wrap; margin: 0 0 8px;
      }

      /* ── Unified-builder additions ─────────────────────────────── */

      /* Header reshape — form picker on the left, actions on the right */
      .fb-header__left { display: flex; align-items: center; min-width: 0; }
      .fb-header__title { display: inline-flex; align-items: center; gap: 10px; }
      .fb-btn--ghost {
        background: transparent;
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .fb-btn--ghost:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
      }

      /* Form picker dropdown trigger */
      .fb-formpicker { position: relative; min-width: 0; }
      .fb-formpicker__trigger {
        display: grid;
        grid-template-columns: 36px minmax(0, 1fr) 14px;
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 10px;
        cursor: pointer;
        font: inherit;
        color: inherit;
        text-align: left;
        max-width: 460px;
        transition: background 0.15s, border-color 0.15s;
      }
      .fb-formpicker__trigger:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 36%, transparent);
      }
      .fb-formpicker__swatch {
        width: 36px; height: 36px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--glass-fg) 7%, transparent);
      }
      .fb-formpicker__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .fb-formpicker__name {
        background: transparent;
        border: 0;
        padding: 0;
        color: var(--g-fg, var(--glass-fg));
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        outline: none;
        max-width: 100%;
        overflow: hidden; text-overflow: ellipsis;
      }
      .fb-formpicker__name:focus {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        outline: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 3px;
      }
      .fb-formpicker__meta {
        font-size: 10.5px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        display: inline-flex; align-items: center; gap: 6px;
        white-space: nowrap;
      }
      .fb-formpicker__meta code {
        font-family: "JetBrains Mono", monospace;
        font-size: 10px;
        background: color-mix(in srgb, var(--glass-base) 30%, transparent);
        padding: 1px 5px;
        border-radius: 3px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .fb-formpicker__chev {
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }

      .fb-fpmenu {
        position: absolute;
        left: 0; top: calc(100% + 6px);
        z-index: 50;
        min-width: 360px; max-width: 460px;
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 96%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 12px;
        padding: 10px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(14px) saturate(150%);
      }
      .fb-fpmenu__head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 4px 6px 8px;
        font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        font-weight: 700;
      }
      .fb-fpmenu__list { display: flex; flex-direction: column; gap: 3px; max-height: 50vh; overflow-y: auto; }
      .fb-fpmenu__row {
        display: grid;
        grid-template-columns: 28px 1fr;
        gap: 10px;
        align-items: center;
        padding: 6px 8px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        cursor: pointer;
        font: inherit;
        color: inherit;
        text-align: left;
      }
      .fb-fpmenu__row:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 22%, transparent);
      }
      .fb-fpmenu__row.is-active {
        background: color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-color: var(--g-primary);
      }
      .fb-fpmenu__swatch {
        width: 28px; height: 28px;
        border-radius: 6px;
        border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent);
      }
      .fb-fpmenu__body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .fb-fpmenu__name {
        font-size: 13px; font-weight: 600;
        color: var(--g-fg, var(--glass-fg));
      }
      .fb-fpmenu__meta {
        font-size: 10px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        display: inline-flex; align-items: center; gap: 5px;
      }

      /* Inspector header (selection-aware) */
      .fb-insp-head {
        display: flex; align-items: flex-start; gap: 8px;
        margin: -2px 0 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      }
      .fb-insp-head h4 {
        margin: 0 0 2px;
        font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
        color: var(--g-primary); font-weight: 800;
      }
      .fb-insp-head p {
        margin: 0; font-size: 11px; line-height: 1.5;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }

      /* Accordion in the inspector */
      .fb-accord { display: flex; flex-direction: column; gap: 6px; }
      .fb-accord__item {
        border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-radius: 10px;
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 50%, transparent);
        overflow: hidden;
      }
      .fb-accord__item[open] {
        border-color: color-mix(in srgb, var(--g-primary) 28%, transparent);
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
      }
      .fb-accord__head {
        display: grid;
        grid-template-columns: 24px 1fr 14px;
        gap: 8px; align-items: center;
        padding: 8px 12px;
        cursor: pointer;
        list-style: none;
        user-select: none;
      }
      .fb-accord__head::-webkit-details-marker { display: none; }
      .fb-accord__icon {
        font-size: 14px; line-height: 1;
        text-align: center;
        color: var(--g-primary);
      }
      .fb-accord__title {
        font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
        color: var(--g-fg, var(--glass-fg));
      }
      .fb-accord__chev {
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        transition: transform 0.2s;
      }
      .fb-accord__item[open] .fb-accord__chev { transform: rotate(180deg); }
      .fb-accord__body {
        padding: 4px 12px 14px;
        border-top: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      .fb-accord__body > .fb-card {
        background: transparent;
        border: 0;
        padding: 0;
      }
      .fb-accord__body > .fb-card h4 { display: none; }

      /* Slide-over panel (Preview + Analytics) */
      .fb-slideover {
        position: fixed; inset: 0;
        background: color-mix(in srgb, var(--glass-base) 55%, transparent);
        backdrop-filter: blur(6px);
        z-index: 900;
        display: flex; justify-content: flex-end;
        animation: fb-slideover-fade 0.15s ease-out;
      }
      @keyframes fb-slideover-fade {
        from { background: color-mix(in srgb, var(--glass-base) 1%, transparent); backdrop-filter: blur(0); }
        to { background: color-mix(in srgb, var(--glass-base) 55%, transparent); backdrop-filter: blur(6px); }
      }
      .fb-slideover__panel {
        width: min(560px, 100%);
        height: 100vh;
        display: flex; flex-direction: column;
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 97%, transparent);
        border-left: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
        box-shadow: -20px 0 80px rgba(0, 0, 0, 0.55);
        animation: fb-slideover-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .fb-slideover__panel--wide { width: min(880px, 100%); }
      @keyframes fb-slideover-in {
        from { transform: translateX(100%); }
        to { transform: translateX(0); }
      }
      .fb-slideover__head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 18px;
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        gap: 12px;
      }
      .fb-slideover__head h3 {
        margin: 0; font-size: 14px; font-weight: 800;
        letter-spacing: 0.04em; color: var(--g-primary);
      }
      .fb-slideover__head p {
        margin: 2px 0 0; font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .fb-slideover__actions { display: inline-flex; gap: 6px; align-items: center; }
      .fb-slideover__body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 18px;
      }
      .fb-slideover__body .fb-iframe {
        width: 100%; height: 100%;
        min-height: 600px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 8px;
        background: var(--glass-fg);
      }
      .fb-slideover__body .fb-preview__placeholder {
        padding: 80px 24px; text-align: center;
        font-style: italic; font-size: 13px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }

      /* Tighten the inspector accordion fields */
      .fb-accord__body .fb-field { margin-bottom: 8px; }
      .fb-accord__body .fb-layout-grid { gap: 6px; }
      .fb-accord__body .fb-style-grid { gap: 6px; }

      /* ── Theme gallery ──────────────────────────────────────── */
      .fb-theme-filters {
        display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;
      }
      .fb-theme-filter-btn {
        font-size: 10px; padding: 3px 9px; border-radius: 99px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        background: transparent;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        cursor: pointer; font: inherit;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
        white-space: nowrap;
      }
      .fb-theme-filter-btn.is-active,
      .fb-theme-filter-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-color: var(--g-primary);
        color: var(--g-primary);
      }
      .fb-theme-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;
      }
      .fb-theme-card {
        border: 1.5px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 10px; overflow: hidden; cursor: pointer;
        background: transparent; font: inherit; color: inherit;
        padding: 0; text-align: left;
        transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
        position: relative;
      }
      .fb-theme-card:hover {
        border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
        box-shadow: 0 6px 20px color-mix(in srgb, var(--g-primary) 10%, transparent);
        transform: translateY(-1px);
      }
      .fb-theme-card.is-active {
        border-color: var(--g-primary);
        box-shadow: 0 0 0 1px var(--g-primary), 0 8px 24px color-mix(in srgb, var(--g-primary) 18%, transparent);
      }
      .fb-theme-card__thumb {
        width: 100%; height: 96px; overflow: hidden;
        display: flex; align-items: stretch;
        position: relative;
      }
      .fb-theme-card__thumb > div { flex: 1; }
      .fb-theme-card__info {
        padding: 5px 8px 7px;
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 88%, transparent);
        border-top: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      .fb-theme-card__name {
        font-size: 10.5px; font-weight: 700;
        color: var(--g-fg, var(--glass-fg));
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .fb-theme-card__tag {
        font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        margin-top: 1px;
      }
      .fb-theme-card__check {
        position: absolute; top: 5px; right: 5px;
        width: 17px; height: 17px; border-radius: 50%;
        background: var(--g-primary);
        display: flex; align-items: center; justify-content: center;
        font-size: 9px; color: var(--glass-ink); font-weight: 900;
        z-index: 2;
      }

      /* Segmented controls */
      .fb-seg { display: flex; gap: 3px; flex-wrap: wrap; }
      .fb-seg-btn {
        flex: 1; min-width: 0; padding: 4px 7px;
        font-size: 9.5px; font-weight: 600; white-space: nowrap; overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 5px; background: transparent;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        cursor: pointer; font: inherit; text-align: center;
        transition: background 0.1s, border-color 0.1s, color 0.1s;
      }
      .fb-seg-btn.is-active {
        background: color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-color: var(--g-primary);
        color: var(--g-primary);
      }
      .fb-seg-btn:hover:not(.is-active) {
        background: color-mix(in srgb, var(--g-primary) 7%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 80%, transparent);
      }
    </style>
  `;
}
