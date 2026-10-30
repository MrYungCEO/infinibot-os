/**
 * Template Editor — basic markdown editor for outreach templates.
 *
 * Templates live at ~/.infinibot/outreach/templates/<name>.md with YAML
 * frontmatter: { subject, cadence_days, max_followups }
 * Body supports mustache: {{lead.name}}, {{lead.website}}, {{me.first_name}}
 */

import { html, nothing } from "lit";
import "./work-glass/remaining.css";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutreachTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  cadenceDays: number[];
  maxFollowups: number;
  filePath: string;
  status: "active" | "draft" | "retired";
  variantOf?: string;
}

export interface TemplateEditorState {
  loading: boolean;
  templates: OutreachTemplate[];
  error: string | null;
  selectedId: string | null;
  editing: {
    name: string;
    subject: string;
    body: string;
    cadenceDays: string;
    maxFollowups: number;
  } | null;
  saving: boolean;
  previewLead: {
    name: string;
    website: string;
    recommended_pitch: string;
    first_name: string;
  };
}

export function createTemplateEditorState(): TemplateEditorState {
  return {
    loading: false,
    templates: [],
    error: null,
    selectedId: null,
    editing: null,
    saving: false,
    previewLead: {
      name: "Acme Plumbing",
      website: "acmeplumbing.com",
      recommended_pitch: "your 4.2-star reputation on Maps",
      first_name: "Kev",
    },
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

export function renderTemplateEditor(
  state: TemplateEditorState,
  _client: GatewayBrowserClient,
  _appState: AppViewState,
  handlers: {
    onLoad: () => void;
    onSelectTemplate: (id: string | null) => void;
    onNewTemplate: () => void;
    onBodyChange: (v: string) => void;
    onSubjectChange: (v: string) => void;
    onNameChange: (v: string) => void;
    onSave: () => void;
    onDiscard: () => void;
  },
) {
  return html`
    <div class="template-editor-page">
      <div class="template-editor-header">
        <div>
          <h1>Template Editor</h1>
          <p class="template-editor-subtitle">
            Outreach templates · ${state.templates.length} templates
          </p>
        </div>
        <div class="template-editor-actions">
          <button class="lp-btn lp-btn-ghost" @click=${handlers.onLoad}>↻ Refresh</button>
          <button class="lp-btn lp-btn-primary" @click=${handlers.onNewTemplate}>+ New Template</button>
        </div>
      </div>

      ${state.error ? html`<div class="lp-error">${state.error}</div>` : nothing}

      <div class="template-editor-layout">
        <div class="template-list">
          ${state.templates.length === 0
            ? html`<div class="template-empty">
                <p>No templates found.</p>
                <p>Templates are markdown files in <code>~/.infinibot/outreach/templates/</code></p>
                <p>Click <strong>+ New Template</strong> to create one.</p>
              </div>`
            : state.templates.map(
                (t) => html`
                  <div
                    class="template-list-item ${state.selectedId === t.id ? "template-list-item--selected" : ""}"
                    @click=${() => handlers.onSelectTemplate(t.id)}
                  >
                    <div class="template-item-name">${t.name}</div>
                    <div class="template-item-meta">
                      <span class="template-status-badge status-${t.status}">${t.status}</span>
                      <span class="template-followups">${t.maxFollowups} follow-ups</span>
                    </div>
                    <div class="template-item-subject">${t.subject}</div>
                  </div>
                `,
              )}
        </div>

        <div class="template-editor-pane">
          ${state.editing
            ? _renderEditor(state, handlers)
            : html`<div class="template-editor-placeholder">
                <p>Select a template to edit, or create a new one.</p>
              </div>`}
        </div>
      </div>
    </div>
  `;
}

function _renderEditor(
  state: TemplateEditorState,
  handlers: Parameters<typeof renderTemplateEditor>[3],
) {
  const { editing, previewLead, saving } = state;
  if (!editing) return nothing;

  const preview = _renderPreview(editing.body, previewLead);

  return html`
    <div class="template-editor-form">
      <div class="lp-field-group">
        <label>Template Name</label>
        <input
          class="lp-input"
          type="text"
          placeholder="my-cold-email"
          .value=${editing.name}
          @input=${(e: Event) => handlers.onNameChange((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="lp-field-group">
        <label>Subject</label>
        <input
          class="lp-input"
          type="text"
          placeholder="Quick question about {{lead.name}}"
          .value=${editing.subject}
          @input=${(e: Event) => handlers.onSubjectChange((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="template-editor-split">
        <div class="template-editor-left">
          <label class="template-editor-label">Body (Markdown + Mustache)</label>
          <textarea
            class="template-textarea"
            placeholder="Hi {{lead.name}},&#10;&#10;I noticed {{lead.website || &quot;your business&quot;}} and..."
            .value=${editing.body}
            @input=${(e: Event) => handlers.onBodyChange((e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="template-vars-hint">
            Available: <code>{{lead.name}}</code> · <code>{{lead.website}}</code> ·
            <code>{{lead.recommended_pitch}}</code> · <code>{{me.first_name}}</code>
          </div>
        </div>
        <div class="template-editor-right">
          <label class="template-editor-label">Preview (sample lead)</label>
          <div class="template-preview">${preview}</div>
        </div>
      </div>
      <div class="template-editor-form-actions">
        <button
          class="lp-btn lp-btn-primary"
          ?disabled=${saving || !editing.name || !editing.subject}
          @click=${handlers.onSave}
        >
          ${saving ? html`<span class="lp-spinner"></span> Saving…` : "💾 Save Template"}
        </button>
        <button class="lp-btn lp-btn-ghost" @click=${handlers.onDiscard}>Discard</button>
      </div>
    </div>
  `;
}

function _renderPreview(
  body: string,
  lead: TemplateEditorState["previewLead"],
): string {
  let rendered = body;
  rendered = rendered.replace(/\{\{lead\.name\}\}/g, lead.name);
  rendered = rendered.replace(/\{\{lead\.website \|\| "([^"]+)"\}\}/g, lead.website || "$1");
  rendered = rendered.replace(/\{\{lead\.website\}\}/g, lead.website);
  rendered = rendered.replace(/\{\{lead\.recommended_pitch\}\}/g, lead.recommended_pitch);
  rendered = rendered.replace(/\{\{me\.first_name\}\}/g, lead.first_name);
  return rendered;
}
