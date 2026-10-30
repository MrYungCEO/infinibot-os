/**
 * Lead Qualifier — Discovery side pane.
 *
 * Three sub-views, switched via the local `mode` field on the discovery
 * UI state (stuffed onto leadQualifierState as `__discovery`):
 *
 *   - settings  — Netlify token + per-business publish config
 *   - templates — list of templates + a fat editor pane when one is open
 *   - runs      — submission timeline + approval queue
 *
 * The pane reads everything from `discovery.*` gateway RPCs and stays
 * decoupled from the rest of the qualifier — no shared state with the
 * webhook/criteria flow on the left.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";

// ── Types (mirror server-side) ───────────────────────────────

interface DiscoveryDocTemplate {
  id: string;
  businessId: string;
  name: string;
  description: string;
  type: string;
  slug: string;
  inputFields: Array<{
    id: string;
    name: string;
    label: string;
    type: string;
    required: boolean;
    placeholder?: string;
    helpText?: string;
    options?: string[];
  }>;
  contextSources: Array<{
    id: string;
    label: string;
    databaseId: string;
    variableName: string;
    rowLimit: number;
    filterPropertyId?: string;
    filterValue?: string;
    includeBody: boolean;
  }>;
  ai: {
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
    userPromptTemplate: string;
  };
  layout: string;
  style: {
    brandColor: string;
    accent: string;
    fontFamily: string;
    pageSize: string;
    logoUrl?: string;
  };
  actions: Array<{
    id: string;
    kind: string;
    label?: string;
    config: Record<string, unknown>;
    condition?: { op: string; category?: string; categories?: string[] };
  }>;
  approval: {
    autoApproveCategories: string[];
    requireManualForCategories: string[];
    rejectCategories: string[];
    calendlyEventTypeUri?: string;
    approvalMessageTemplate?: string;
  };
  netlify: {
    siteId: string;
    formName: string;
    publicUrl: string;
    lastSeenSubmissionId: string | null;
    lastPolledAt: number | null;
  } | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface DiscoveryDocRun {
  id: string;
  templateId: string;
  businessId: string;
  source: string;
  inputs: Record<string, string>;
  generatedMarkdown: string;
  qualifyCategory: string | null;
  actions: Array<{
    actionId: string;
    kind: string;
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    detail: string | null;
    output?: Record<string, unknown>;
  }>;
  approvalState: string;
  approvalNote: string | null;
  createdAt: number;
  updatedAt: number;
}

interface NetlifyStatus {
  connected: boolean;
  tokenSuffix: string | null;
  accountSlug: string | null;
  sitePrefix: string | null;
  updatedAt: number | null;
}

// ── UI state stash ───────────────────────────────────────────

interface DiscoveryUIState {
  mode: "templates" | "runs" | "settings";
  templates: DiscoveryDocTemplate[];
  runs: DiscoveryDocRun[];
  netlify: NetlifyStatus | null;
  editingTemplateId: string | null;
  /** Working copy of the template being edited — diff'd against templates list on save. */
  draft: DiscoveryDocTemplate | null;
  testInputs: Record<string, string>;
  testResultRunId: string | null;
  publishingBiz: boolean;
  publishResult: { publicUrl?: string; error?: string } | null;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  // Settings form
  netlifyTokenDraft: string;
  netlifyAccountSlugDraft: string;
  netlifySitePrefixDraft: string;
  netlifyConnecting: boolean;
  netlifyError: string | null;
}

function getDiscoveryUI(state: AppViewState): DiscoveryUIState {
  const lq = state.leadQualifierState as unknown as { __discovery?: DiscoveryUIState };
  if (!lq.__discovery) {
    lq.__discovery = {
      mode: "templates",
      templates: [],
      runs: [],
      netlify: null,
      editingTemplateId: null,
      draft: null,
      testInputs: {},
      testResultRunId: null,
      publishingBiz: false,
      publishResult: null,
      loaded: false,
      loading: false,
      saving: false,
      netlifyTokenDraft: "",
      netlifyAccountSlugDraft: "",
      netlifySitePrefixDraft: "",
      netlifyConnecting: false,
      netlifyError: null,
    };
  }
  return lq.__discovery!;
}

// ── Async loaders ────────────────────────────────────────────

async function loadAll(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDiscoveryUI(state);
  if (ui.loading || ui.loaded) return;
  const businessId = state.businessState?.activeBusinessId;
  if (!businessId) return;
  ui.loading = true;
  try {
    const [tpls, runs, netlify] = await Promise.all([
      client.request("discovery.templates.list", { businessId }) as Promise<{ templates: DiscoveryDocTemplate[] }>,
      client.request("discovery.runs.list", { businessId, limit: 50 }) as Promise<{ runs: DiscoveryDocRun[] }>,
      client.request("discovery.netlify.status", {}) as Promise<NetlifyStatus>,
    ]);
    ui.templates = tpls.templates ?? [];
    ui.runs = runs.runs ?? [];
    ui.netlify = netlify;
    ui.loaded = true;
  } catch (err) {
    console.error("[discovery] load failed:", err);
  } finally {
    ui.loading = false;
    state.requestUpdate?.();
  }
}

async function refreshTemplates(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDiscoveryUI(state);
  const businessId = state.businessState?.activeBusinessId;
  if (!businessId) return;
  const res = (await client.request("discovery.templates.list", { businessId })) as { templates: DiscoveryDocTemplate[] };
  ui.templates = res.templates ?? [];
  state.requestUpdate?.();
}

async function refreshRuns(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDiscoveryUI(state);
  const businessId = state.businessState?.activeBusinessId;
  if (!businessId) return;
  const res = (await client.request("discovery.runs.list", { businessId, limit: 50 })) as { runs: DiscoveryDocRun[] };
  ui.runs = res.runs ?? [];
  state.requestUpdate?.();
}

// ── Top-level render ─────────────────────────────────────────

export function renderDiscoveryPane(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDiscoveryUI(state);
  if (!ui.loaded && !ui.loading) {
    void loadAll(state, client);
  }
  return html`
    ${discoveryStyles()}
    <div class="dsc-pane">
      <header class="dsc-header">
        <div>
          <h2>Discovery</h2>
          <p>AI-driven discovery forms, hosted on Netlify, processed locally.</p>
        </div>
        <div class="dsc-pill ${ui.netlify?.connected ? "dsc-pill--ok" : "dsc-pill--warn"}">
          ${ui.netlify?.connected ? `Netlify · …${ui.netlify.tokenSuffix}` : "Netlify not connected"}
        </div>
      </header>
      <nav class="dsc-tabs">
        ${(["templates", "runs", "settings"] as const).map((m) => html`
          <button
            class="dsc-tab ${ui.mode === m ? "is-active" : ""}"
            @click=${() => { ui.mode = m; state.requestUpdate?.(); }}
          >${m[0].toUpperCase()}${m.slice(1)}</button>
        `)}
      </nav>
      ${ui.loading ? html`<div class="dsc-loading">Loading…</div>` : nothing}
      ${ui.mode === "templates" ? renderTemplatesMode(state, client) : nothing}
      ${ui.mode === "runs" ? renderRunsMode(state, client) : nothing}
      ${ui.mode === "settings" ? renderSettingsMode(state, client) : nothing}
    </div>
  `;
}

// ── Templates mode ───────────────────────────────────────────

function renderTemplatesMode(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDiscoveryUI(state);
  if (ui.editingTemplateId && ui.draft) {
    return renderTemplateEditor(state, client);
  }
  return html`
    <div class="dsc-section">
      <div class="dsc-row dsc-row--bar">
        <h3>Templates (${ui.templates.length})</h3>
        <div class="dsc-bar-actions">
          <button class="dsc-btn dsc-btn--ghost" @click=${() => void publishBusiness(state, client)} ?disabled=${ui.publishingBiz || !ui.netlify?.connected || ui.templates.length === 0}>
            ${ui.publishingBiz ? "Publishing…" : "↑ Publish forms"}
          </button>
          <button class="dsc-btn dsc-btn--primary" @click=${() => void createTemplate(state, client)}>+ New template</button>
        </div>
      </div>
      ${ui.publishResult?.error ? html`<div class="dsc-banner dsc-banner--err">⚠ ${ui.publishResult.error}</div>` : nothing}
      ${ui.publishResult?.publicUrl ? html`
        <div class="dsc-banner dsc-banner--ok">
          ✓ Published. Forms live at
          <a class="dsc-link" href="${ui.publishResult.publicUrl}" target="_blank" rel="noopener">${ui.publishResult.publicUrl}</a>
        </div>` : nothing}
      ${ui.templates.length === 0 && !ui.loading
        ? html`<div class="dsc-empty">No templates yet — create one to start collecting leads.</div>`
        : html`
          <div class="dsc-template-list">
            ${ui.templates.map((tpl) => renderTemplateRow(state, client, tpl))}
          </div>`}
    </div>
  `;
}

function renderTemplateRow(state: AppViewState, client: GatewayBrowserClient, tpl: DiscoveryDocTemplate): TemplateResult {
  return html`
    <div class="dsc-template-row">
      <div class="dsc-template-row__main">
        <div class="dsc-template-row__title">
          <strong>${tpl.name}</strong>
          <span class="dsc-chip">${tpl.type.replace(/_/g, " ")}</span>
          ${tpl.netlify
            ? html`<a class="dsc-chip dsc-chip--ok" href="${tpl.netlify.publicUrl}" target="_blank" rel="noopener">live ↗</a>`
            : html`<span class="dsc-chip dsc-chip--muted">unpublished</span>`}
          ${tpl.enabled ? nothing : html`<span class="dsc-chip dsc-chip--warn">disabled</span>`}
        </div>
        <p class="dsc-template-row__desc">${tpl.description || html`<em>no description</em>`}</p>
        <div class="dsc-template-row__meta">
          ${tpl.inputFields.length} fields · ${tpl.actions.length} actions · ${tpl.contextSources.length} context sources
        </div>
      </div>
      <div class="dsc-template-row__actions">
        <button class="dsc-btn dsc-btn--ghost" @click=${() => openEditor(state, tpl)}>Edit</button>
        <button class="dsc-btn dsc-btn--danger-ghost" @click=${() => void deleteTemplate(state, client, tpl)}>Delete</button>
      </div>
    </div>
  `;
}

async function createTemplate(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const businessId = state.businessState?.activeBusinessId;
  if (!businessId) return;
  const name = prompt("Template name?", "AI Readiness Audit");
  if (!name) return;
  const res = (await client.request("discovery.templates.upsert", { businessId, name })) as { template: DiscoveryDocTemplate };
  await refreshTemplates(state, client);
  openEditor(state, res.template);
}

async function deleteTemplate(state: AppViewState, client: GatewayBrowserClient, tpl: DiscoveryDocTemplate): Promise<void> {
  if (!confirm(`Delete template "${tpl.name}"? This is permanent.`)) return;
  await client.request("discovery.templates.delete", { id: tpl.id });
  await refreshTemplates(state, client);
}

function openEditor(state: AppViewState, tpl: DiscoveryDocTemplate): void {
  const ui = getDiscoveryUI(state);
  ui.editingTemplateId = tpl.id;
  ui.draft = JSON.parse(JSON.stringify(tpl)) as DiscoveryDocTemplate; // deep clone
  ui.testInputs = {};
  ui.testResultRunId = null;
  state.requestUpdate?.();
}

function closeEditor(state: AppViewState): void {
  const ui = getDiscoveryUI(state);
  ui.editingTemplateId = null;
  ui.draft = null;
  state.requestUpdate?.();
}

// ── Template editor ───────────────────────────────────────────

function renderTemplateEditor(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDiscoveryUI(state);
  const t = ui.draft!;
  const update = () => state.requestUpdate?.();
  return html`
    <div class="dsc-section dsc-editor">
      <div class="dsc-row dsc-row--bar">
        <button class="dsc-btn dsc-btn--ghost" @click=${() => closeEditor(state)}>← Back to list</button>
        <div class="dsc-bar-actions">
          <button class="dsc-btn dsc-btn--ghost" @click=${() => void runTestExecute(state, client)} ?disabled=${ui.saving}>▶ Test run</button>
          <button class="dsc-btn dsc-btn--primary" @click=${() => void saveDraft(state, client)} ?disabled=${ui.saving}>${ui.saving ? "Saving…" : "Save"}</button>
        </div>
      </div>

      <!-- 1. Identity -->
      <details open class="dsc-card">
        <summary>1 · Identity</summary>
        <div class="dsc-grid-2">
          <label>Name<input class="dsc-input" .value=${t.name} @input=${(e: Event) => { t.name = (e.target as HTMLInputElement).value; update(); }} /></label>
          <label>Slug (URL)<input class="dsc-input" .value=${t.slug} @input=${(e: Event) => { t.slug = (e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); update(); }} /></label>
          <label>Type
            <select class="dsc-input" .value=${t.type} @change=${(e: Event) => { t.type = (e.target as HTMLSelectElement).value; update(); }}>
              <option value="discovery_form">Discovery Form</option>
              <option value="ai_audit">AI Audit</option>
              <option value="proposal">Proposal</option>
              <option value="summary">Summary</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>Enabled
            <input type="checkbox" .checked=${t.enabled} @change=${(e: Event) => { t.enabled = (e.target as HTMLInputElement).checked; update(); }} />
          </label>
          <label class="dsc-grid-2__full">Description<textarea class="dsc-input" rows="2" .value=${t.description} @input=${(e: Event) => { t.description = (e.target as HTMLTextAreaElement).value; update(); }}></textarea></label>
        </div>
      </details>

      <!-- 2. Input fields -->
      <details open class="dsc-card">
        <summary>2 · Input form (${t.inputFields.length} fields)</summary>
        <p class="dsc-help">These become the public form on Netlify. The "name" attribute is the key on the submitted payload.</p>
        <div class="dsc-field-list">
          ${t.inputFields.map((f, idx) => html`
            <div class="dsc-field-card">
              <div class="dsc-field-card__head">
                <input class="dsc-input dsc-input--inline" .value=${f.label} placeholder="Label" @input=${(e: Event) => { f.label = (e.target as HTMLInputElement).value; update(); }} />
                <input class="dsc-input dsc-input--inline dsc-mono" .value=${f.name} placeholder="name" @input=${(e: Event) => { f.name = (e.target as HTMLInputElement).value.replace(/\s/g, "_"); update(); }} />
                <select class="dsc-input dsc-input--inline" .value=${f.type} @change=${(e: Event) => { f.type = (e.target as HTMLSelectElement).value; update(); }}>
                  ${["text","textarea","email","tel","url","number","select","checkbox","radio","date"].map((tt) => html`<option value=${tt}>${tt}</option>`)}
                </select>
                <label class="dsc-toggle">
                  <input type="checkbox" .checked=${f.required} @change=${(e: Event) => { f.required = (e.target as HTMLInputElement).checked; update(); }} /> required
                </label>
                <button class="dsc-btn dsc-btn--danger-ghost dsc-btn--xs" @click=${() => { t.inputFields.splice(idx, 1); update(); }}>✕</button>
              </div>
              <div class="dsc-field-card__body">
                <input class="dsc-input dsc-input--sm" placeholder="placeholder" .value=${f.placeholder ?? ""} @input=${(e: Event) => { f.placeholder = (e.target as HTMLInputElement).value; update(); }} />
                <input class="dsc-input dsc-input--sm" placeholder="help text" .value=${f.helpText ?? ""} @input=${(e: Event) => { f.helpText = (e.target as HTMLInputElement).value; update(); }} />
                ${(f.type === "select" || f.type === "radio") ? html`
                  <input class="dsc-input dsc-input--sm" placeholder="options (comma separated)" .value=${(f.options ?? []).join(", ")} @input=${(e: Event) => { f.options = (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean); update(); }} />
                ` : nothing}
              </div>
            </div>
          `)}
        </div>
        <button class="dsc-btn dsc-btn--ghost" @click=${() => { t.inputFields.push({ id: cryptoId(), name: `field_${t.inputFields.length + 1}`, label: "New field", type: "text", required: false }); update(); }}>+ Add field</button>
      </details>

      <!-- 3. Context sources -->
      <details class="dsc-card">
        <summary>3 · Context from InfiniBot databases (${t.contextSources.length})</summary>
        <p class="dsc-help">Pull rows from any registered database. Each source becomes <code>{{ctx.&lt;variable&gt;}}</code> in the prompt.</p>
        ${t.contextSources.map((src, idx) => html`
          <div class="dsc-field-card">
            <div class="dsc-field-card__head">
              <input class="dsc-input dsc-input--inline" placeholder="Label" .value=${src.label} @input=${(e: Event) => { src.label = (e.target as HTMLInputElement).value; update(); }} />
              <input class="dsc-input dsc-input--inline dsc-mono" placeholder="variableName" .value=${src.variableName} @input=${(e: Event) => { src.variableName = (e.target as HTMLInputElement).value.replace(/\s/g, ""); update(); }} />
              <button class="dsc-btn dsc-btn--danger-ghost dsc-btn--xs" @click=${() => { t.contextSources.splice(idx, 1); update(); }}>✕</button>
            </div>
            <div class="dsc-field-card__body">
              <input class="dsc-input dsc-input--sm dsc-mono" placeholder="InfiniBot database id" .value=${src.databaseId} @input=${(e: Event) => { src.databaseId = (e.target as HTMLInputElement).value.trim(); update(); }} />
              <input class="dsc-input dsc-input--sm" type="number" min="1" max="100" placeholder="rows" .value=${String(src.rowLimit)} @input=${(e: Event) => { src.rowLimit = Math.max(1, Number((e.target as HTMLInputElement).value) || 10); update(); }} />
              <label class="dsc-toggle"><input type="checkbox" .checked=${src.includeBody} @change=${(e: Event) => { src.includeBody = (e.target as HTMLInputElement).checked; update(); }} /> include body</label>
            </div>
          </div>
        `)}
        <button class="dsc-btn dsc-btn--ghost" @click=${() => { t.contextSources.push({ id: cryptoId(), label: "Source", databaseId: "", variableName: `src${t.contextSources.length + 1}`, rowLimit: 10, includeBody: false }); update(); }}>+ Add context source</button>
      </details>

      <!-- 4. AI -->
      <details open class="dsc-card">
        <summary>4 · AI prompt</summary>
        <div class="dsc-grid-2">
          <label>Model<input class="dsc-input dsc-mono" .value=${t.ai.model} @input=${(e: Event) => { t.ai.model = (e.target as HTMLInputElement).value; update(); }} placeholder="anthropic:claude-sonnet-4-6" /></label>
          <label>Temperature<input class="dsc-input" type="number" min="0" max="2" step="0.1" .value=${String(t.ai.temperature)} @input=${(e: Event) => { t.ai.temperature = Number((e.target as HTMLInputElement).value); update(); }} /></label>
          <label>Max tokens<input class="dsc-input" type="number" min="100" max="32000" .value=${String(t.ai.maxTokens)} @input=${(e: Event) => { t.ai.maxTokens = Number((e.target as HTMLInputElement).value); update(); }} /></label>
        </div>
        <label class="dsc-block">
          System prompt
          <span class="dsc-help">
            Tokens: <code>{{input.&lt;name&gt;}}</code> · <code>{{ctx.&lt;var&gt;}}</code> · <code>{{biz.name}}</code> · <code>{{biz.industry}}</code> · <code>{{run.id}}</code>
          </span>
          <textarea class="dsc-input dsc-mono dsc-textarea--tall" rows="14" .value=${t.ai.systemPrompt} @input=${(e: Event) => { t.ai.systemPrompt = (e.target as HTMLTextAreaElement).value; update(); }}></textarea>
        </label>
        <label class="dsc-block">
          User prompt template (optional — blank uses default)
          <textarea class="dsc-input dsc-mono" rows="4" .value=${t.ai.userPromptTemplate} @input=${(e: Event) => { t.ai.userPromptTemplate = (e.target as HTMLTextAreaElement).value; update(); }}></textarea>
        </label>
      </details>

      <!-- 5. Layout & style -->
      <details class="dsc-card">
        <summary>5 · Output style</summary>
        <div class="dsc-grid-2">
          <label>Layout
            <select class="dsc-input" .value=${t.layout} @change=${(e: Event) => { t.layout = (e.target as HTMLSelectElement).value; update(); }}>
              ${["audit","report","proposal","letter","brief"].map((l) => html`<option value=${l}>${l}</option>`)}
            </select>
          </label>
          <label>Page size
            <select class="dsc-input" .value=${t.style.pageSize} @change=${(e: Event) => { t.style.pageSize = (e.target as HTMLSelectElement).value as "letter" | "a4"; update(); }}>
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </select>
          </label>
          <label>Brand color<input class="dsc-input" type="color" .value=${t.style.brandColor} @input=${(e: Event) => { t.style.brandColor = (e.target as HTMLInputElement).value; update(); }} /></label>
          <label>Accent<input class="dsc-input" type="color" .value=${t.style.accent} @input=${(e: Event) => { t.style.accent = (e.target as HTMLInputElement).value; update(); }} /></label>
          <label class="dsc-grid-2__full">Font family<input class="dsc-input" .value=${t.style.fontFamily} @input=${(e: Event) => { t.style.fontFamily = (e.target as HTMLInputElement).value; update(); }} /></label>
          <label class="dsc-grid-2__full">Logo URL<input class="dsc-input" .value=${t.style.logoUrl ?? ""} @input=${(e: Event) => { t.style.logoUrl = (e.target as HTMLInputElement).value || undefined; update(); }} /></label>
        </div>
      </details>

      <!-- 6. Actions -->
      <details open class="dsc-card">
        <summary>6 · Action pipeline (${t.actions.length})</summary>
        <p class="dsc-help">Run in order after AI generation. Use conditions to fire only on specific qualify categories.</p>
        ${t.actions.map((a, idx) => html`
          <div class="dsc-field-card">
            <div class="dsc-field-card__head">
              <select class="dsc-input dsc-input--inline" .value=${a.kind} @change=${(e: Event) => { a.kind = (e.target as HTMLSelectElement).value; update(); }}>
                ${["generate_pdf","send_email","log_to_crm","telegram_notify","qualify_lead","calendly_link"].map((k) => html`<option value=${k}>${k.replace(/_/g, " ")}</option>`)}
              </select>
              <select class="dsc-input dsc-input--inline" .value=${a.condition?.op ?? "always"} @change=${(e: Event) => {
                const op = (e.target as HTMLSelectElement).value;
                a.condition = op === "always" ? undefined : { op, category: "qualified" };
                update();
              }}>
                <option value="always">always</option>
                <option value="equals">if category = …</option>
                <option value="in">if category in …</option>
              </select>
              ${a.condition?.op === "equals" ? html`
                <input class="dsc-input dsc-input--inline" placeholder="qualified" .value=${a.condition.category ?? ""} @input=${(e: Event) => { a.condition!.category = (e.target as HTMLInputElement).value; update(); }} />
              ` : a.condition?.op === "in" ? html`
                <input class="dsc-input dsc-input--inline" placeholder="qualified, maybe" .value=${(a.condition.categories ?? []).join(", ")} @input=${(e: Event) => { a.condition!.categories = (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean); update(); }} />
              ` : nothing}
              <button class="dsc-btn dsc-btn--danger-ghost dsc-btn--xs" @click=${() => { t.actions.splice(idx, 1); update(); }}>✕</button>
            </div>
            ${renderActionConfig(a, update)}
          </div>
        `)}
        <button class="dsc-btn dsc-btn--ghost" @click=${() => { t.actions.push({ id: cryptoId(), kind: "generate_pdf", config: {} }); update(); }}>+ Add action</button>
      </details>

      <!-- 7. Approval gate -->
      <details class="dsc-card">
        <summary>7 · Approval gate</summary>
        <div class="dsc-grid-2">
          <label class="dsc-grid-2__full">Auto-approve when category is one of (comma separated)
            <input class="dsc-input" .value=${t.approval.autoApproveCategories.join(", ")} @input=${(e: Event) => { t.approval.autoApproveCategories = parseCsv((e.target as HTMLInputElement).value); update(); }} />
          </label>
          <label class="dsc-grid-2__full">Send to manual approval queue when category is one of
            <input class="dsc-input" .value=${t.approval.requireManualForCategories.join(", ")} @input=${(e: Event) => { t.approval.requireManualForCategories = parseCsv((e.target as HTMLInputElement).value); update(); }} />
          </label>
          <label class="dsc-grid-2__full">Auto-reject when category is one of
            <input class="dsc-input" .value=${t.approval.rejectCategories.join(", ")} @input=${(e: Event) => { t.approval.rejectCategories = parseCsv((e.target as HTMLInputElement).value); update(); }} />
          </label>
          <label class="dsc-grid-2__full">Calendly event-type URI (sent to approved leads)
            <input class="dsc-input dsc-mono" .value=${t.approval.calendlyEventTypeUri ?? ""} @input=${(e: Event) => { t.approval.calendlyEventTypeUri = (e.target as HTMLInputElement).value || undefined; update(); }} placeholder="https://calendly.com/your-name/30min" />
          </label>
        </div>
      </details>

      <!-- 8. Test runner -->
      <details open class="dsc-card">
        <summary>8 · Test run</summary>
        <p class="dsc-help">Fill the form below and hit ▶ Test run above. Doesn't deliver actions in dry-run mode.</p>
        <div class="dsc-test-form">
          ${t.inputFields.map((f) => html`
            <label class="dsc-block">
              ${f.label}
              ${f.type === "textarea"
                ? html`<textarea class="dsc-input" rows="3" .value=${ui.testInputs[f.name] ?? ""} @input=${(e: Event) => { ui.testInputs[f.name] = (e.target as HTMLTextAreaElement).value; }}></textarea>`
                : html`<input class="dsc-input" type=${f.type === "email" ? "email" : "text"} .value=${ui.testInputs[f.name] ?? ""} @input=${(e: Event) => { ui.testInputs[f.name] = (e.target as HTMLInputElement).value; }} />`}
            </label>
          `)}
        </div>
        ${ui.testResultRunId ? renderTestResult(state, ui.testResultRunId) : nothing}
      </details>

      <!-- 9. Netlify -->
      <details class="dsc-card">
        <summary>9 · Public form</summary>
        ${t.netlify ? html`
          <p>Live at <a class="dsc-link" href="${t.netlify.publicUrl}" target="_blank" rel="noopener">${t.netlify.publicUrl}</a></p>
          <p class="dsc-help">Form name: <code>${t.netlify.formName}</code> · Last submission seen: ${t.netlify.lastSeenSubmissionId ?? "—"} · Last poll: ${t.netlify.lastPolledAt ? new Date(t.netlify.lastPolledAt).toLocaleString() : "—"}</p>
        ` : html`
          <p class="dsc-help">Not yet published. Save your changes, then hit <strong>↑ Publish forms</strong> on the template list to deploy.</p>
        `}
      </details>
    </div>
  `;
}

function renderActionConfig(a: { kind: string; config: Record<string, unknown> }, update: () => void): TemplateResult {
  const cfg = a.config;
  const setCfg = <K extends string>(k: K, v: unknown) => { cfg[k] = v; update(); };
  switch (a.kind) {
    case "send_email":
      return html`
        <div class="dsc-field-card__body">
          <input class="dsc-input dsc-input--sm" placeholder="to (e.g. {{input.email}})" .value=${(cfg.to as string) ?? "{{input.email}}"} @input=${(e: Event) => setCfg("to", (e.target as HTMLInputElement).value)} />
          <input class="dsc-input dsc-input--sm" placeholder="from" .value=${(cfg.from as string) ?? ""} @input=${(e: Event) => setCfg("from", (e.target as HTMLInputElement).value)} />
          <input class="dsc-input dsc-input--sm" placeholder="subject" .value=${(cfg.subject as string) ?? ""} @input=${(e: Event) => setCfg("subject", (e.target as HTMLInputElement).value)} />
        </div>
      `;
    case "telegram_notify":
      return html`
        <div class="dsc-field-card__body">
          <input class="dsc-input dsc-input--sm dsc-mono" placeholder="chat id (blank = default)" .value=${(cfg.chatId as string) ?? ""} @input=${(e: Event) => setCfg("chatId", (e.target as HTMLInputElement).value)} />
          <textarea class="dsc-input dsc-input--sm" rows="3" placeholder="message template — supports {{input.*}} {{run.id}} {{category}}" .value=${(cfg.message as string) ?? ""} @input=${(e: Event) => setCfg("message", (e.target as HTMLTextAreaElement).value)}></textarea>
        </div>
      `;
    case "calendly_link":
      return html`
        <div class="dsc-field-card__body">
          <input class="dsc-input dsc-input--sm" placeholder="Override event URI (defaults to approval gate URI)" .value=${(cfg.eventTypeUri as string) ?? ""} @input=${(e: Event) => setCfg("eventTypeUri", (e.target as HTMLInputElement).value)} />
        </div>
      `;
    case "qualify_lead":
      return html`
        <div class="dsc-field-card__body">
          <label class="dsc-toggle"><input type="checkbox" .checked=${cfg.extractFromMarkdown === true} @change=${(e: Event) => setCfg("extractFromMarkdown", (e.target as HTMLInputElement).checked)} /> Extract from AI markdown</label>
          <input class="dsc-input dsc-input--sm" placeholder="candidates (comma) e.g. qualified, maybe, unqualified" .value=${((cfg.candidates as string[]) ?? []).join(", ")} @input=${(e: Event) => setCfg("candidates", (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean))} />
          <input class="dsc-input dsc-input--sm" placeholder="default category" .value=${(cfg.defaultCategory as string) ?? ""} @input=${(e: Event) => setCfg("defaultCategory", (e.target as HTMLInputElement).value)} />
        </div>
      `;
    default:
      return nothing as unknown as TemplateResult;
  }
}

function renderTestResult(state: AppViewState, runId: string): TemplateResult {
  const ui = getDiscoveryUI(state);
  const run = ui.runs.find((r) => r.id === runId);
  if (!run) return html`<div class="dsc-help">Run pending…</div>`;
  return html`
    <div class="dsc-test-result">
      <div class="dsc-row">
        <span class="dsc-chip">${run.source}</span>
        <span class="dsc-chip">${run.qualifyCategory ?? "no category"}</span>
        <span class="dsc-chip ${run.approvalState === "auto-approved" || run.approvalState === "approved" ? "dsc-chip--ok" : run.approvalState === "rejected" ? "dsc-chip--err" : "dsc-chip--warn"}">${run.approvalState}</span>
      </div>
      <pre class="dsc-markdown">${run.generatedMarkdown}</pre>
      <div class="dsc-action-log">
        ${run.actions.map((a) => html`
          <div class="dsc-action-log__row">
            <span class="dsc-chip dsc-chip--muted">${a.kind}</span>
            <span class="dsc-chip ${a.status === "done" ? "dsc-chip--ok" : a.status === "failed" ? "dsc-chip--err" : a.status === "skipped" ? "dsc-chip--muted" : "dsc-chip--warn"}">${a.status}</span>
            <span class="dsc-action-log__detail">${a.detail ?? (a.output ? JSON.stringify(a.output) : "")}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

async function saveDraft(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDiscoveryUI(state);
  if (!ui.draft) return;
  ui.saving = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("discovery.templates.upsert", { template: ui.draft })) as { template: DiscoveryDocTemplate };
    ui.draft = JSON.parse(JSON.stringify(res.template)) as DiscoveryDocTemplate;
    await refreshTemplates(state, client);
  } catch (err) {
    alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ui.saving = false;
    state.requestUpdate?.();
  }
}

async function runTestExecute(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDiscoveryUI(state);
  if (!ui.draft) return;
  ui.saving = true;
  state.requestUpdate?.();
  try {
    // Save first so the run uses the latest template.
    await saveDraft(state, client);
    const res = (await client.request("discovery.run.execute", {
      templateId: ui.draft.id,
      inputs: ui.testInputs,
      dryRun: false,
    })) as { run: DiscoveryDocRun };
    ui.testResultRunId = res.run.id;
    await refreshRuns(state, client);
  } catch (err) {
    alert(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ui.saving = false;
    state.requestUpdate?.();
  }
}

async function publishBusiness(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDiscoveryUI(state);
  const businessId = state.businessState?.activeBusinessId;
  if (!businessId) return;
  ui.publishingBiz = true;
  ui.publishResult = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("discovery.templates.publish", { businessId })) as {
      publicUrl?: string;
      siteName?: string;
    };
    ui.publishResult = { publicUrl: res.publicUrl };
    await refreshTemplates(state, client);
  } catch (err) {
    ui.publishResult = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    ui.publishingBiz = false;
    state.requestUpdate?.();
  }
}

// ── Runs mode ────────────────────────────────────────────────

function renderRunsMode(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDiscoveryUI(state);
  const pending = ui.runs.filter((r) => r.approvalState === "pending");
  const recent = ui.runs.filter((r) => r.approvalState !== "pending").slice(0, 30);
  return html`
    <div class="dsc-section">
      ${pending.length > 0 ? html`
        <h3>Approval queue (${pending.length})</h3>
        <div class="dsc-run-list">
          ${pending.map((r) => renderRunRow(state, client, r, true))}
        </div>
      ` : nothing}
      <h3>Recent runs (${recent.length})</h3>
      ${recent.length === 0 ? html`<div class="dsc-empty">No runs yet.</div>` :
        html`<div class="dsc-run-list">${recent.map((r) => renderRunRow(state, client, r, false))}</div>`}
    </div>
  `;
}

function renderRunRow(state: AppViewState, client: GatewayBrowserClient, run: DiscoveryDocRun, showApprovalButtons: boolean): TemplateResult {
  const ui = getDiscoveryUI(state);
  const tpl = ui.templates.find((t) => t.id === run.templateId);
  return html`
    <details class="dsc-run-row">
      <summary>
        <span class="dsc-chip">${run.source}</span>
        <span class="dsc-run-row__title">${tpl?.name ?? run.templateId.slice(0, 8)}</span>
        <span class="dsc-chip">${run.qualifyCategory ?? "—"}</span>
        <span class="dsc-chip ${run.approvalState === "auto-approved" || run.approvalState === "approved" ? "dsc-chip--ok" : run.approvalState === "rejected" ? "dsc-chip--err" : "dsc-chip--warn"}">${run.approvalState}</span>
        <span class="dsc-run-row__time">${new Date(run.createdAt).toLocaleString()}</span>
      </summary>
      <div class="dsc-run-row__body">
        <div class="dsc-run-row__inputs">
          <strong>Inputs:</strong>
          ${Object.entries(run.inputs).map(([k, v]) => html`<div><code>${k}</code>: ${v}</div>`)}
        </div>
        <pre class="dsc-markdown">${run.generatedMarkdown}</pre>
        <div class="dsc-action-log">
          ${run.actions.map((a) => html`
            <div class="dsc-action-log__row">
              <span class="dsc-chip dsc-chip--muted">${a.kind}</span>
              <span class="dsc-chip ${a.status === "done" ? "dsc-chip--ok" : a.status === "failed" ? "dsc-chip--err" : "dsc-chip--muted"}">${a.status}</span>
              <span class="dsc-action-log__detail">${a.detail ?? (a.output ? JSON.stringify(a.output) : "")}</span>
            </div>
          `)}
        </div>
        ${showApprovalButtons ? html`
          <div class="dsc-bar-actions">
            <button class="dsc-btn dsc-btn--primary" @click=${() => void approveRun(state, client, run.id)}>✓ Approve & send</button>
            <button class="dsc-btn dsc-btn--danger-ghost" @click=${() => void rejectRun(state, client, run.id)}>Reject</button>
          </div>
        ` : nothing}
      </div>
    </details>
  `;
}

async function approveRun(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const note = prompt("Optional note for this approval?", "") ?? undefined;
  await client.request("discovery.run.approve", { id, approver: "operator", note });
  await refreshRuns(state, client);
}

async function rejectRun(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const note = prompt("Reason for rejection?", "") ?? undefined;
  await client.request("discovery.run.reject", { id, approver: "operator", note });
  await refreshRuns(state, client);
}

// ── Settings mode ────────────────────────────────────────────

function renderSettingsMode(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ui = getDiscoveryUI(state);
  return html`
    <div class="dsc-section">
      <h3>Netlify connection</h3>
      <p class="dsc-help">
        Personal access token from
        <a class="dsc-link" href="https://app.netlify.com/user/applications#personal-access-tokens" target="_blank" rel="noopener">app.netlify.com/user/applications</a>.
        Stored locally in <code>~/.infinibot/secrets/netlify.json</code> — never sent back to the UI after save.
      </p>
      ${ui.netlify?.connected ? html`
        <div class="dsc-banner dsc-banner--ok">
          ✓ Connected. Token ending …${ui.netlify.tokenSuffix} · Saved ${ui.netlify.updatedAt ? new Date(ui.netlify.updatedAt).toLocaleString() : ""}
        </div>
        <div class="dsc-bar-actions">
          <button class="dsc-btn dsc-btn--ghost" @click=${() => void testNetlify(state, client)}>Test</button>
          <button class="dsc-btn dsc-btn--ghost" @click=${() => void pollNetlify(state, client)}>Poll now</button>
          <button class="dsc-btn dsc-btn--danger-ghost" @click=${() => void disconnectNetlify(state, client)}>Disconnect</button>
        </div>
      ` : html`
        <div class="dsc-grid-2">
          <label class="dsc-grid-2__full">Personal access token
            <input class="dsc-input dsc-mono" type="password" .value=${ui.netlifyTokenDraft} @input=${(e: Event) => { ui.netlifyTokenDraft = (e.target as HTMLInputElement).value; }} placeholder="nfp_…" />
          </label>
          <label>Account slug (optional)
            <input class="dsc-input dsc-mono" .value=${ui.netlifyAccountSlugDraft} @input=${(e: Event) => { ui.netlifyAccountSlugDraft = (e.target as HTMLInputElement).value; }} placeholder="default-account" />
          </label>
          <label>Site name prefix (optional)
            <input class="dsc-input dsc-mono" .value=${ui.netlifySitePrefixDraft} @input=${(e: Event) => { ui.netlifySitePrefixDraft = (e.target as HTMLInputElement).value; }} placeholder="tws-" />
          </label>
        </div>
        ${ui.netlifyError ? html`<div class="dsc-banner dsc-banner--err">⚠ ${ui.netlifyError}</div>` : nothing}
        <button class="dsc-btn dsc-btn--primary" @click=${() => void connectNetlify(state, client)} ?disabled=${ui.netlifyConnecting || !ui.netlifyTokenDraft.trim()}>${ui.netlifyConnecting ? "Connecting…" : "Connect Netlify"}</button>
      `}
    </div>
  `;
}

async function connectNetlify(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ui = getDiscoveryUI(state);
  ui.netlifyConnecting = true;
  ui.netlifyError = null;
  state.requestUpdate?.();
  try {
    await client.request("discovery.netlify.connect", {
      token: ui.netlifyTokenDraft.trim(),
      accountSlug: ui.netlifyAccountSlugDraft.trim() || undefined,
      sitePrefix: ui.netlifySitePrefixDraft.trim() || undefined,
    });
    const status = (await client.request("discovery.netlify.status", {})) as NetlifyStatus;
    ui.netlify = status;
    ui.netlifyTokenDraft = "";
  } catch (err) {
    ui.netlifyError = err instanceof Error ? err.message : String(err);
  } finally {
    ui.netlifyConnecting = false;
    state.requestUpdate?.();
  }
}

async function testNetlify(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  try {
    const res = (await client.request("discovery.netlify.test", {})) as { email?: string; siteCount?: number };
    alert(`✓ Connected as ${res.email ?? "?"} — ${res.siteCount ?? 0} sites visible.`);
  } catch (err) {
    alert(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pollNetlify(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const res = (await client.request("discovery.netlify.poll", {})) as { processed: number; templates: number };
  alert(`Poll done — processed ${res.processed} new submissions across ${res.templates} templates.`);
  await refreshRuns(state, client);
}

async function disconnectNetlify(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  if (!confirm("Disconnect Netlify? Published sites stay live but new submissions won't be polled.")) return;
  await client.request("discovery.netlify.disconnect", {});
  const status = (await client.request("discovery.netlify.status", {})) as NetlifyStatus;
  const ui = getDiscoveryUI(state);
  ui.netlify = status;
  state.requestUpdate?.();
}

// ── Helpers ──────────────────────────────────────────────────

function cryptoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as Crypto).randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseCsv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// ── Styles ───────────────────────────────────────────────────

function discoveryStyles(): TemplateResult {
  return html`<style>
    .dsc-pane { display: flex; flex-direction: column; gap: 12px; }
    .dsc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 4px; }
    .dsc-header h2 { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 4px; color: var(--glass-gold-hi); }
    .dsc-header p { font-size: 11px; color: var(--glass-fg-3); margin: 0; }
    .dsc-pill { font-size: 10px; padding: 3px 10px; border-radius: 999px; letter-spacing: 0.04em; font-weight: 600; }
    .dsc-pill--ok { background: rgba(34,197,94,0.12); color: #22c55e; border: 1px solid rgba(34,197,94,0.3); }
    .dsc-pill--warn { background: color-mix(in srgb, var(--glass-gold) 12%, transparent); color: #f59e0b; border: 1px solid color-mix(in srgb, var(--glass-gold) 30%, transparent); }
    .dsc-tabs { display: flex; gap: 4px; border-bottom: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent); }
    .dsc-tab { padding: 6px 14px; background: transparent; border: 0; color: var(--glass-fg-3); font: inherit; font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent; }
    .dsc-tab.is-active { color: var(--glass-gold-hi); border-bottom-color: var(--glass-gold-hi); }
    .dsc-tab:hover { color: var(--glass-gold-hi); }
    .dsc-section { display: flex; flex-direction: column; gap: 10px; }
    .dsc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .dsc-row--bar { justify-content: space-between; }
    .dsc-bar-actions { display: flex; gap: 6px; }
    .dsc-loading { text-align: center; padding: 18px; color: var(--glass-fg-3); }
    .dsc-empty { text-align: center; padding: 24px; color: var(--glass-fg-3); border: 1px dashed color-mix(in srgb, var(--glass-fg) 8%, transparent); border-radius: 8px; font-size: 12px; }
    .dsc-help { font-size: 11px; color: var(--glass-fg-3); margin: 4px 0 8px; }
    .dsc-banner { padding: 8px 12px; border-radius: 6px; font-size: 11px; }
    .dsc-banner--ok { background: rgba(34,197,94,0.08); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
    .dsc-banner--err { background: rgba(239,68,68,0.08); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }
    .dsc-link { color: var(--glass-gold-hi); }
    .dsc-template-list { display: flex; flex-direction: column; gap: 8px; }
    .dsc-template-row { display: flex; gap: 10px; padding: 12px 14px; background: color-mix(in srgb, var(--glass-fg) 2%, transparent); border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent); border-radius: 8px; }
    .dsc-template-row__main { flex: 1; min-width: 0; }
    .dsc-template-row__title { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .dsc-template-row__desc { margin: 4px 0 0; font-size: 11px; color: var(--glass-fg-2); }
    .dsc-template-row__meta { margin-top: 4px; font-size: 10px; color: var(--glass-fg-4); }
    .dsc-template-row__actions { display: flex; gap: 4px; align-items: flex-start; }
    .dsc-chip { font-size: 9px; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--glass-fg) 5%, transparent); color: var(--glass-fg-2); letter-spacing: 0.04em; }
    .dsc-chip--ok { background: rgba(34,197,94,0.12); color: #22c55e; }
    .dsc-chip--warn { background: color-mix(in srgb, var(--glass-gold) 12%, transparent); color: #f59e0b; }
    .dsc-chip--err { background: rgba(239,68,68,0.12); color: #f87171; }
    .dsc-chip--muted { background: color-mix(in srgb, var(--glass-fg) 3%, transparent); color: var(--glass-fg-3); }
    .dsc-btn { padding: 5px 12px; border-radius: 6px; font: inherit; font-size: 11px; cursor: pointer; border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent); background: transparent; color: var(--glass-fg); }
    .dsc-btn:hover:not(:disabled) { border-color: var(--glass-gold-hi); color: var(--glass-gold-hi); }
    .dsc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .dsc-btn--primary { background: color-mix(in srgb, var(--glass-gold-hi) 12%, transparent); border-color: color-mix(in srgb, var(--glass-gold-hi) 40%, transparent); color: var(--glass-gold-hi); }
    .dsc-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--glass-gold-hi) 20%, transparent); }
    .dsc-btn--ghost { background: transparent; }
    .dsc-btn--danger-ghost { color: #f87171; border-color: rgba(248,113,113,0.2); }
    .dsc-btn--danger-ghost:hover:not(:disabled) { background: rgba(248,113,113,0.08); }
    .dsc-btn--xs { padding: 3px 8px; font-size: 10px; }
    .dsc-card { background: color-mix(in srgb, var(--glass-fg) 2%, transparent); border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent); border-radius: 8px; padding: 12px 14px; }
    .dsc-card summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--glass-gold-hi); padding: 2px 0; outline: none; user-select: none; }
    .dsc-card summary::marker { color: var(--glass-gold-hi); }
    .dsc-card[open] summary { margin-bottom: 10px; }
    .dsc-editor { display: flex; flex-direction: column; gap: 10px; }
    .dsc-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .dsc-grid-2 label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--glass-fg-2); }
    .dsc-grid-2__full { grid-column: 1 / -1; }
    .dsc-block { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--glass-fg-2); margin-top: 8px; }
    .dsc-input { padding: 6px 10px; background: color-mix(in srgb, var(--glass-fg) 3%, transparent); border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent); border-radius: 6px; color: var(--glass-fg); font: inherit; font-size: 11px; }
    .dsc-input--inline { flex: 0 1 auto; width: auto; min-width: 120px; }
    .dsc-input--sm { font-size: 10px; padding: 4px 8px; }
    .dsc-mono { font-family: ui-monospace, SFMono-Regular, monospace; }
    .dsc-textarea--tall { min-height: 220px; }
    .dsc-input:focus { outline: none; border-color: var(--glass-gold-hi); box-shadow: 0 0 0 2px color-mix(in srgb, var(--glass-gold-hi) 15%, transparent); }
    .dsc-toggle { display: inline-flex; gap: 4px; align-items: center; font-size: 10px; color: var(--glass-fg-2); }
    .dsc-field-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
    .dsc-field-card { padding: 8px 10px; background: color-mix(in srgb, var(--glass-fg) 2%, transparent); border: 1px solid color-mix(in srgb, var(--glass-fg) 5%, transparent); border-radius: 6px; }
    .dsc-field-card__head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .dsc-field-card__body { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
    .dsc-test-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
    .dsc-test-result { margin-top: 8px; padding: 10px; background: color-mix(in srgb, var(--glass-fg) 2%, transparent); border-radius: 6px; }
    .dsc-markdown { max-height: 320px; overflow: auto; padding: 10px; background: color-mix(in srgb, var(--glass-base) 25%, transparent); border-radius: 6px; font-size: 11px; font-family: ui-monospace, SFMono-Regular, monospace; color: var(--glass-fg-2); white-space: pre-wrap; word-wrap: break-word; }
    .dsc-action-log { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
    .dsc-action-log__row { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--glass-fg-2); }
    .dsc-action-log__detail { color: var(--glass-fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; }
    .dsc-run-list { display: flex; flex-direction: column; gap: 6px; }
    .dsc-run-row { background: color-mix(in srgb, var(--glass-fg) 2%, transparent); border: 1px solid color-mix(in srgb, var(--glass-fg) 6%, transparent); border-radius: 6px; padding: 8px 10px; }
    .dsc-run-row summary { display: flex; gap: 8px; align-items: center; cursor: pointer; font-size: 11px; }
    .dsc-run-row__title { font-weight: 600; color: var(--glass-gold-hi); }
    .dsc-run-row__time { margin-left: auto; color: var(--glass-fg-3); font-size: 10px; }
    .dsc-run-row__body { padding-top: 10px; }
    .dsc-run-row__inputs { font-size: 10px; color: var(--glass-fg-2); margin-bottom: 8px; }
  </style>`;
}
