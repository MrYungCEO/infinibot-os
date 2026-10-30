/**
 * Lead Qualifier view — single page that lets the user wire up a
 * per-business webhook → criteria → action-stack pipeline.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Header (title · linked business · save · status)     │
 *   ├──────────────────────────────────┬───────────────────┤
 *   │ Webhook                          │ Preview │ Templates │ Project │
 *   │ Criteria                         │  (tabs)            │
 *   │ Action stack                     │                    │
 *   └──────────────────────────────────┴───────────────────┘
 *
 * The empty state (no actions configured) replaces the editor with a
 * 3-card preset picker so a fresh business gets a working pipeline in
 * one click.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  type ActionStep,
  type ActionStepKind,
  type ConfigWarning,
  type Criterion,
  type CriterionField,
  type CriterionOp,
  type LeadQualifierState,
  type QualifierConfig,
  ACTION_KIND_LABELS,
  ACTION_KIND_ICONS,
  COMMON_TOKENS,
  QUALIFIER_PRESETS,
  STYLE_TEMPLATES,
  SAMPLE_PAYLOAD,
  activeQualifierConfig,
  addAction,
  addCriterion,
  applyPreset,
  configWarnings,
  dryRun,
  ensureActiveConfig,
  evaluateCriterion,
  evaluateQualification,
  loadLeadQualifier,
  patchActiveConfig,
  pingWebhook,
  removeAction,
  removeCriterion,
  renderTokens,
  reorderActions,
  saveActiveConfig,
  updateAction,
  updateCriterion,
} from "../controllers/lead-qualifier";
import { activeBusinessProfile, createBusiness, switchBusiness } from "../controllers/business";
import { renderFormBuilder } from "./lead-qualifier-forms";
import { renderDiscoveryPane } from "./lead-qualifier-discovery";
import { gatewayOrigin } from "../gateway-endpoint";

// Right-column tab state — kept on the LeadQualifierState so it survives
// re-renders. We bolt it on with a small augmentation rather than churn the
// type definition because the UI tab is purely cosmetic.
type SideTab = "preview" | "templates" | "project" | "discovery";
function getSideTab(lq: LeadQualifierState): SideTab {
  return ((lq as any).__sideTab as SideTab | undefined) ?? "preview";
}
function setSideTab(lq: LeadQualifierState, tab: SideTab): void {
  (lq as any).__sideTab = tab;
}

// ── Top-level render ────────────────────────────────────────────────────

export function renderLeadQualifier(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const lq = state.leadQualifierState;
  if (!lq) {
    return html`${qualifierStyles()}<div class="lq-page"><div class="lq-loading">Initialising lead qualifier…</div></div>`;
  }
  if (!lq.loaded && !lq.loading) {
    void loadLeadQualifier(state, client);
  }
  if (lq.loaded) ensureActiveConfig(state);

  const cfg = activeQualifierConfig(state);
  const bs = state.businessState;
  const activeBiz = activeBusinessProfile(bs);
  const warnings = configWarnings(cfg);
  const isFreshConfig = !!cfg && cfg.actions.length === 0 && cfg.criteria.length <= 1;

  return html`
    ${qualifierStyles()}
    <div class="lq-page">
      ${renderHeader(state, client, lq, cfg, warnings)}
      ${lq.error ? html`<div class="lq-banner lq-banner--error">⚠ ${lq.error}</div>` : nothing}
      ${lq.success ? html`<div class="lq-banner lq-banner--ok">✓ ${lq.success}</div>` : nothing}
      ${warnings.length > 0 ? renderWarningsBanner(warnings) : nothing}

      ${!cfg
        ? html`<div class="lq-empty-card">
            <p>${activeBiz ? "No qualifier yet for this business." : "Pick or create a business to set up its qualifier."}</p>
            ${!activeBiz
              ? html`<button class="lq-btn lq-btn--primary" @click=${() => openBusinessPicker(state)}>
                  ⎘ Pick or create a business
                </button>`
              : nothing}
          </div>`
        : isFreshConfig
        ? renderQuickStart(state, client, cfg)
        : html`
            <div class="lq-grid">
              <div class="lq-col">
                ${renderWebhookSection(state, client, lq, cfg)}
                ${renderCriteriaSection(state, lq, cfg)}
                ${renderActionStack(state, lq, cfg)}
              </div>
              <div class="lq-col lq-col--side">
                ${renderSideTabs(state, lq)}
                ${getSideTab(lq) === "preview" ? renderPreviewPane(state, lq, cfg) : nothing}
                ${getSideTab(lq) === "templates" ? renderTemplatesSection(state, lq, cfg) : nothing}
                ${getSideTab(lq) === "project" ? renderProjectSection(state, cfg) : nothing}
                ${getSideTab(lq) === "discovery" ? renderDiscoveryPane(state, client) : nothing}
                ${renderTestRunner(state, client, lq, cfg)}
                ${renderRecentRuns(lq)}
              </div>
            </div>
          `}
      ${renderFormBuilder(state, client)}
      ${renderProjectPicker(state, lq, cfg)}
      ${renderBusinessPicker(state, client, lq)}
    </div>
  `;
}

// ── Header ──────────────────────────────────────────────────────────────

function renderHeader(
  state: AppViewState,
  client: GatewayBrowserClient,
  lq: LeadQualifierState,
  cfg: QualifierConfig | null,
  warnings: ConfigWarning[],
): TemplateResult {
  const bs = state.businessState;
  const businesses = bs?.businesses ?? [];
  const activeBiz = activeBusinessProfile(bs);
  const stats = cfg
    ? {
        criteria: cfg.criteria.length,
        actions: cfg.actions.length,
        warnings: warnings.length,
      }
    : { criteria: 0, actions: 0, warnings: 0 };
  return html`
    <header class="lq-header">
      <div class="lq-header__main">
        <div class="lq-header__title-row">
          <span class="lq-header__icon">⎇</span>
          <h1>Lead Qualifier</h1>
          ${cfg
            ? html`<span class="lq-header__pipe-name" title="Click Save to persist changes">${cfg.name}</span>`
            : nothing}
        </div>
        <div class="lq-header__chips">
          <button
            type="button"
            class="lq-chip-readonly lq-chip-readonly--pick"
            title=${businesses.length === 0 ? "Create your first business" : "Switch business — ${businesses.length} available"}
            @click=${() => openBusinessPicker(state)}
          >
            <span class="lq-chip-readonly__label">Business</span>
            <strong>${activeBiz?.name ?? "— pick one —"}</strong>
            <span class="lq-chip-readonly__caret">⌕</span>
          </button>
          <span class="lq-chip-readonly">
            <span class="lq-chip-readonly__label">CRM</span>
            <strong>${activeBiz?.crmDatabaseName ?? (activeBiz?.crmDatabaseId ? "Connected" : "Not connected")}</strong>
          </span>
          <span class="lq-chip-readonly">
            <span class="lq-chip-readonly__label">Criteria</span>
            <strong class="${stats.criteria === 0 ? "is-zero" : ""}">${stats.criteria}</strong>
          </span>
          <span class="lq-chip-readonly">
            <span class="lq-chip-readonly__label">Actions</span>
            <strong class="${stats.actions === 0 ? "is-zero" : ""}">${stats.actions}</strong>
          </span>
          ${stats.warnings > 0
            ? html`<span class="lq-chip-readonly is-warn">
                <span class="lq-chip-readonly__label">Issues</span>
                <strong>${stats.warnings}</strong>
              </span>`
            : nothing}
        </div>
      </div>
      <div class="lq-header__right">
        <label class="lq-toggle ${cfg?.enabled ? "is-on" : ""}" title="Toggle webhook on/off without losing config.">
          <input
            type="checkbox"
            ?checked=${cfg?.enabled ?? false}
            ?disabled=${!cfg}
            @change=${(e: Event) => patchActiveConfig(state, { enabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="lq-toggle__dot"></span>
          <span class="lq-toggle__label">${cfg?.enabled ? "Active" : "Paused"}</span>
        </label>
        <button
          class="lq-btn lq-btn--primary"
          ?disabled=${lq.saving || !cfg}
          @click=${() => saveActiveConfig(state, client)}
        >${lq.saving ? "Saving…" : "Save changes"}</button>
      </div>
    </header>
  `;
}

function renderWarningsBanner(warnings: ConfigWarning[]): TemplateResult {
  const hasWarn = warnings.some((w) => w.level === "warn");
  return html`
    <div class="lq-warnings ${hasWarn ? "is-warn" : "is-info"}">
      ${warnings.map(
        (w) => html`
          <div class="lq-warning">
            <span class="lq-warning__icon">${w.level === "warn" ? "⚠" : "ⓘ"}</span>
            <span class="lq-warning__msg">${w.message}</span>
          </div>
        `,
      )}
    </div>
  `;
}

// ── Quick start (shown when no actions configured) ──────────────────────

function renderQuickStart(
  state: AppViewState,
  _client: GatewayBrowserClient,
  _cfg: QualifierConfig,
): TemplateResult {
  return html`
    <section class="lq-quickstart">
      <header class="lq-quickstart__head">
        <h2>Pick a starter pipeline</h2>
        <p>
          Each preset wires up criteria + actions you can edit afterwards.
          You can always start from scratch by adding actions one-by-one below.
        </p>
      </header>
      <div class="lq-quickstart__grid">
        ${QUALIFIER_PRESETS.map(
          (preset) => html`
            <button
              class="lq-quickstart__card"
              @click=${() => applyPreset(state, preset.id)}
            >
              <div class="lq-quickstart__badge">${preset.badge}</div>
              <div class="lq-quickstart__title">${preset.name}</div>
              <p class="lq-quickstart__tagline">${preset.tagline}</p>
              <div class="lq-quickstart__counts">
                <span>${preset.criteria.length} criterion${preset.criteria.length === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>${preset.actions.length} actions</span>
              </div>
              <div class="lq-quickstart__steps">
                ${preset.actions.slice(0, 4).map(
                  (a) => html`
                    <span class="lq-quickstart__step" title=${ACTION_KIND_LABELS[a.kind]}>
                      ${ACTION_KIND_ICONS[a.kind]}
                    </span>
                  `,
                )}
                ${preset.actions.length > 4
                  ? html`<span class="lq-quickstart__step lq-quickstart__step--more">+${preset.actions.length - 4}</span>`
                  : nothing}
              </div>
              <div class="lq-quickstart__cta">Apply preset →</div>
            </button>
          `,
        )}
      </div>
      <div class="lq-quickstart__skip">
        <button class="lq-btn lq-btn--ghost" @click=${() => addAction(state, "save-to-crm")}>
          Skip — start from scratch
        </button>
      </div>
    </section>
  `;
}

// ── Webhook section ────────────────────────────────────────────────────

function renderWebhookSection(
  state: AppViewState,
  client: GatewayBrowserClient,
  lq: LeadQualifierState,
  cfg: QualifierConfig,
): TemplateResult {
  const fullUrl = computeWebhookUrl(cfg);
  const curlExample = fullUrl
    ? `curl -X POST '${fullUrl}' \\
  -H 'Content-Type: application/json' \\${cfg.webhookSecret ? `\n  -H 'X-Qualifier-Secret: ${cfg.webhookSecret}' \\` : ""}
  -d '${JSON.stringify(SAMPLE_PAYLOAD).slice(0, 100)}…'`
    : "Save to mint a URL.";
  return html`
    <section class="lq-card">
      <header class="lq-card__head">
        <div>
          <h2>Webhook</h2>
          <p class="lq-card__subhead">Point your form / external system at this URL.</p>
        </div>
        <button
          class="lq-btn lq-btn--ghost lq-btn--sm"
          ?disabled=${!fullUrl}
          @click=${async () => {
            await pingWebhook(state, client);
            state.requestUpdate?.();
          }}
        >Test ping</button>
      </header>
      <label class="lq-field">
        <span class="lq-field__label">Endpoint URL</span>
        <div class="lq-input-row">
          <input
            type="text"
            class="lq-input lq-input--mono"
            readonly
            .value=${fullUrl || "(unsaved)"}
            placeholder="(unsaved — save the qualifier to mint a webhook path)"
            @click=${(e: Event) => (e.target as HTMLInputElement).select()}
          />
          <button class="lq-btn" ?disabled=${!fullUrl} @click=${() => copy(fullUrl)}>Copy</button>
        </div>
      </label>
      <details class="lq-disclosure">
        <summary>Show curl example</summary>
        <pre class="lq-pre">${curlExample}</pre>
      </details>
      <label class="lq-field">
        <span class="lq-field__label">Optional shared secret</span>
        <input
          type="text"
          class="lq-input lq-input--mono"
          placeholder="leave blank to allow any caller"
          .value=${cfg.webhookSecret}
          @change=${(e: Event) =>
            patchActiveConfig(state, { webhookSecret: (e.target as HTMLInputElement).value.trim() })}
        />
        <span class="lq-field__hint">If set, requests must include <code>X-Qualifier-Secret</code> header.</span>
      </label>
      <label class="lq-field">
        <span class="lq-field__label">Pipeline name</span>
        <input
          type="text"
          class="lq-input"
          .value=${cfg.name}
          @change=${(e: Event) => patchActiveConfig(state, { name: (e.target as HTMLInputElement).value })}
        />
      </label>
    </section>
  `;
}

function computeWebhookUrl(cfg: QualifierConfig): string {
  if (!cfg.webhookPath) return "";
  if (typeof window === "undefined") return cfg.webhookPath;
  const base = gatewayOrigin();
  return `${base}${cfg.webhookPath.startsWith("/") ? "" : "/"}${cfg.webhookPath}`;
}

function copy(text: string): void {
  if (!text) return;
  try { void navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

// ── Criteria section ───────────────────────────────────────────────────

const CRITERION_FIELDS: Array<{ id: CriterionField; label: string; group: "lead" | "scope" | "advanced" }> = [
  { id: "budget", label: "Budget", group: "scope" },
  { id: "timeline", label: "Timeline", group: "scope" },
  { id: "industry", label: "Industry", group: "scope" },
  { id: "solution_fit", label: "Services interested in", group: "scope" },
  { id: "name", label: "Name", group: "lead" },
  { id: "email", label: "Email", group: "lead" },
  { id: "phone", label: "Phone", group: "lead" },
  { id: "frustration", label: "Frustration", group: "lead" },
  { id: "wish", label: "Wish / outcome", group: "lead" },
  { id: "tried", label: "Past attempts", group: "lead" },
  { id: "business_snapshot", label: "Business snapshot", group: "lead" },
  { id: "custom", label: "Custom JSON path", group: "advanced" },
];

const NUMERIC_OPS: CriterionOp[] = ["gte", "lte", "gt", "lt", "eq", "neq"];
const STRING_OPS: CriterionOp[] = ["contains", "not_contains", "eq", "neq", "regex", "exists", "not_exists"];
const ARRAY_OPS: CriterionOp[] = ["in", "not_in", "contains", "not_contains", "exists", "not_exists"];

function opsForField(field: CriterionField): CriterionOp[] {
  if (field === "budget") return NUMERIC_OPS;
  if (field === "solution_fit") return ARRAY_OPS;
  if (field === "custom") return [...NUMERIC_OPS, ...STRING_OPS, ...ARRAY_OPS];
  return STRING_OPS;
}

const OP_LABELS: Record<CriterionOp, string> = {
  gte: "≥", lte: "≤", gt: ">", lt: "<", eq: "=", neq: "≠",
  contains: "contains", not_contains: "does not contain",
  in: "is one of", not_in: "is not one of",
  exists: "exists", not_exists: "is missing",
  regex: "matches regex",
};

function renderCriteriaSection(
  state: AppViewState,
  _lq: LeadQualifierState,
  cfg: QualifierConfig,
): TemplateResult {
  return html`
    <section class="lq-card">
      <header class="lq-card__head">
        <div>
          <h2>Qualification criteria</h2>
          <p class="lq-card__subhead">A lead is qualified when these match.</p>
        </div>
        <div class="lq-segmented">
          <button
            class=${cfg.criteriaMode === "all" ? "active" : ""}
            @click=${() => patchActiveConfig(state, { criteriaMode: "all" })}
          >All match</button>
          <button
            class=${cfg.criteriaMode === "any" ? "active" : ""}
            @click=${() => patchActiveConfig(state, { criteriaMode: "any" })}
          >Any match</button>
        </div>
      </header>
      <div class="lq-criteria-list">
        ${cfg.criteria.length === 0
          ? html`<div class="lq-empty-row">No criteria — every webhook hit qualifies. Add one below.</div>`
          : cfg.criteria.map((c, i) => renderCriterionRow(state, c, i))}
      </div>
      <div class="lq-criteria__add">
        <button class="lq-btn lq-btn--ghost lq-btn--sm" @click=${() => addCriterion(state)}>+ Add criterion</button>
        <span class="lq-card__hint" style="margin-left:auto;font-style:italic;">
          Tip: numeric fields autoswitch to ≥/≤; arrays support “contains”.
        </span>
      </div>
    </section>
  `;
}

function renderCriterionRow(state: AppViewState, c: Criterion, index: number): TemplateResult {
  const ops = opsForField(c.field);
  const groupedFields = groupCriterionFields();
  const isNumeric = c.field === "budget";
  const isArray = c.field === "solution_fit";
  const showValue = c.op !== "exists" && c.op !== "not_exists";
  const pass = evaluateCriterion(c, SAMPLE_PAYLOAD);
  return html`
    <div class="lq-criterion ${pass ? "is-pass" : "is-fail"}" data-index=${index}>
      <span class="lq-criterion__index" title="Step ${index + 1}">${index + 1}</span>
      <select
        class="lq-input"
        .value=${c.field}
        @change=${(e: Event) => {
          const next = (e.target as HTMLSelectElement).value as CriterionField;
          updateCriterion(state, c.id, { field: next, op: opsForField(next)[0], value: "" });
        }}
      >
        ${groupedFields.map(
          (group) => html`
            <optgroup label=${groupLabel(group.id)}>
              ${group.fields.map((f) => html`<option value=${f.id}>${f.label}</option>`)}
            </optgroup>
          `,
        )}
      </select>
      ${c.field === "custom"
        ? html`
            <input
              type="text"
              class="lq-input lq-input--mono"
              placeholder="body.custom_field"
              .value=${c.customPath ?? ""}
              @change=${(e: Event) =>
                updateCriterion(state, c.id, { customPath: (e.target as HTMLInputElement).value.trim() })}
            />
          `
        : nothing}
      <select
        class="lq-input lq-input--narrow"
        .value=${c.op}
        @change=${(e: Event) =>
          updateCriterion(state, c.id, { op: (e.target as HTMLSelectElement).value as CriterionOp })}
      >
        ${ops.map((op) => html`<option value=${op}>${OP_LABELS[op]}</option>`)}
      </select>
      ${showValue
        ? html`
            <input
              type=${isNumeric ? "number" : "text"}
              class="lq-input ${isArray ? "lq-input--mono" : ""}"
              placeholder=${isArray
                ? "comma,separated,values"
                : isNumeric
                ? "100"
                : c.op === "regex"
                ? "/regex/"
                : "value"}
              .value=${c.value}
              @change=${(e: Event) => updateCriterion(state, c.id, { value: (e.target as HTMLInputElement).value })}
            />
          `
        : html`<span class="lq-criterion__no-value">—</span>`}
      <span class="lq-criterion__pass" title=${pass ? "Sample payload matches" : "Sample payload does not match"}>
        ${pass ? "✓" : "✗"}
      </span>
      <button
        class="lq-icon-btn"
        title="Remove criterion"
        @click=${() => removeCriterion(state, c.id)}
      >×</button>
    </div>
  `;
}

function groupCriterionFields(): Array<{ id: "scope" | "lead" | "advanced"; fields: typeof CRITERION_FIELDS }> {
  const out = {
    scope: [] as typeof CRITERION_FIELDS,
    lead: [] as typeof CRITERION_FIELDS,
    advanced: [] as typeof CRITERION_FIELDS,
  };
  for (const f of CRITERION_FIELDS) out[f.group].push(f);
  return [
    { id: "scope", fields: out.scope },
    { id: "lead", fields: out.lead },
    { id: "advanced", fields: out.advanced },
  ];
}
function groupLabel(id: "scope" | "lead" | "advanced"): string {
  switch (id) {
    case "scope": return "Project scope";
    case "lead": return "Lead identity";
    case "advanced": return "Advanced";
  }
}

// ── Action stack ───────────────────────────────────────────────────────

const ACTION_KIND_OPTIONS: ActionStepKind[] = [
  "save-to-crm",
  "notify-telegram",
  "send-email",
  "ai-proposal",
  "respond-webhook",
  "link-to-project",
  "branch-on-criteria",
  "tag-lead",
];

function renderActionStack(
  state: AppViewState,
  lq: LeadQualifierState,
  cfg: QualifierConfig,
): TemplateResult {
  const evalRes = evaluateQualification(cfg, SAMPLE_PAYLOAD);
  return html`
    <section class="lq-card">
      <header class="lq-card__head">
        <div>
          <h2>Action stack</h2>
          <p class="lq-card__subhead">Run top-to-bottom. Drag rows to reorder. Click ▸ to configure.</p>
        </div>
        <span class="lq-pill ${evalRes.qualified ? "lq-pill--ok" : "lq-pill--err"}">
          ${evalRes.qualified ? "Sample qualifies" : "Sample fails"}
        </span>
      </header>
      <div
        class="lq-action-stack"
        @dragover=${(e: DragEvent) => e.preventDefault()}
      >
        ${cfg.actions.length === 0
          ? html`<div class="lq-empty-row">No actions yet. Add one below or pick a quick-start preset.</div>`
          : cfg.actions.map((step, idx) => renderActionRow(state, lq, cfg, step, idx, evalRes.qualified))}
      </div>
      <div class="lq-action-add">
        <span class="lq-field__label">Add action</span>
        <div class="lq-action-add__chips">
          ${ACTION_KIND_OPTIONS.map(
            (kind) => html`
              <button class="lq-chip" @click=${() => addAction(state, kind)}>
                <span class="lq-chip__icon">${ACTION_KIND_ICONS[kind]}</span>
                ${ACTION_KIND_LABELS[kind]}
              </button>
            `,
          )}
        </div>
      </div>
    </section>
  `;
}

function renderActionRow(
  state: AppViewState,
  lq: LeadQualifierState,
  cfg: QualifierConfig,
  step: ActionStep,
  idx: number,
  qualified: boolean,
): TemplateResult {
  const expanded = lq.expandedStepId === step.id;
  const isDragOver = lq.dragOverIndex === idx;
  const willRun =
    step.branch === null ||
    (step.branch === "qualified" && qualified) ||
    (step.branch === "unqualified" && !qualified);
  return html`
    <div
      class="lq-action ${expanded ? "is-expanded" : ""} ${isDragOver ? "is-drop-target" : ""} ${willRun ? "" : "is-skipped"}"
      draggable="true"
      @dragstart=${(e: DragEvent) => {
        lq.dragStepId = step.id;
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      @dragover=${(e: DragEvent) => {
        e.preventDefault();
        if (!lq.dragStepId || lq.dragStepId === step.id) return;
        if (lq.dragOverIndex !== idx) {
          lq.dragOverIndex = idx;
          state.requestUpdate?.();
        }
      }}
      @dragleave=${() => {
        if (lq.dragOverIndex === idx) {
          lq.dragOverIndex = null;
          state.requestUpdate?.();
        }
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        if (!lq.dragStepId) return;
        reorderActions(state, lq.dragStepId, idx);
        lq.dragStepId = null;
        lq.dragOverIndex = null;
      }}
      @dragend=${() => {
        lq.dragStepId = null;
        lq.dragOverIndex = null;
        state.requestUpdate?.();
      }}
    >
      <div class="lq-action__head">
        <span class="lq-action__step" title="Step ${idx + 1}">${idx + 1}</span>
        <span class="lq-action__handle" title="Drag to reorder">⋮⋮</span>
        <span class="lq-action__icon" title=${ACTION_KIND_LABELS[step.kind]}>${ACTION_KIND_ICONS[step.kind]}</span>
        <input
          class="lq-input lq-input--inline"
          .value=${step.label ?? ACTION_KIND_LABELS[step.kind]}
          @change=${(e: Event) => updateAction(state, step.id, { label: (e.target as HTMLInputElement).value })}
        />
        ${renderBranchPill(state, step)}
        <span class="lq-action__skip-hint">${willRun ? "" : "skipped"}</span>
        <button
          class="lq-icon-btn"
          title=${expanded ? "Collapse" : "Configure"}
          @click=${() => {
            lq.expandedStepId = expanded ? null : step.id;
            state.requestUpdate?.();
          }}
        >${expanded ? "▾" : "▸"}</button>
        <button class="lq-icon-btn lq-icon-btn--danger" title="Remove" @click=${() => removeAction(state, step.id)}>×</button>
      </div>
      ${expanded ? html`<div class="lq-action__body">${renderActionConfig(state, cfg, step)}</div>` : nothing}
    </div>
  `;
}

function renderBranchPill(state: AppViewState, step: ActionStep): TemplateResult {
  const labels: Record<string, string> = {
    qualified: "qualified",
    unqualified: "unqualified",
    both: "always",
  };
  const current = step.branch ?? "both";
  const next = current === "both" ? "qualified" : current === "qualified" ? "unqualified" : "both";
  const titles: Record<string, string> = {
    both: "Runs for every webhook hit.",
    qualified: "Only runs when the lead qualifies.",
    unqualified: "Only runs for unqualified leads.",
  };
  return html`
    <button
      class="lq-branch lq-branch--${current}"
      title=${titles[current] + " — click to change."}
      @click=${(e: Event) => {
        e.stopPropagation();
        updateAction(state, step.id, { branch: next === "both" ? null : (next as "qualified" | "unqualified") });
      }}
    >${labels[current]}</button>
  `;
}

// ── Action configs (with token helper for template fields) ─────────────

function renderActionConfig(
  state: AppViewState,
  cfg: QualifierConfig,
  step: ActionStep,
): TemplateResult {
  const setField = (key: string, value: unknown) =>
    updateAction(state, step.id, { config: { ...step.config, [key]: value } });

  switch (step.kind) {
    case "save-to-crm":
      return html`
        <label class="lq-field">
          <span class="lq-field__label">Notion CRM database</span>
          <input
            class="lq-input lq-input--mono"
            placeholder="leave blank to use the active business's CRM"
            .value=${cfg.crmDatabaseId}
            @change=${(e: Event) => patchActiveConfig(state, { crmDatabaseId: (e.target as HTMLInputElement).value.trim() })}
          />
          <span class="lq-field__hint">Defaults to the active business's connected CRM. Override here for a custom DB.</span>
        </label>
        <label class="lq-field">
          <span class="lq-field__label">Initial status value</span>
          <input
            class="lq-input"
            .value=${String(step.config.statusValue ?? "Lead")}
            @change=${(e: Event) => setField("statusValue", (e.target as HTMLInputElement).value)}
          />
        </label>
      `;
    case "notify-telegram":
      return html`
        <label class="lq-field">
          <span class="lq-field__label">Chat ID (blank = gateway default)</span>
          <input
            class="lq-input lq-input--mono"
            .value=${String(step.config.chatId ?? "")}
            @change=${(e: Event) => setField("chatId", (e.target as HTMLInputElement).value.trim())}
          />
        </label>
        ${renderTextareaWithTokens(
          "Message template",
          String(step.config.template ?? ""),
          (next) => setField("template", next),
          "Use {{ name }}, {{ budget }}, etc — values come from the webhook body.",
        )}
      `;
    case "send-email":
      return html`
        ${renderInputWithTokens(
          "To",
          String(step.config.to ?? "{{ email }}"),
          (next) => setField("to", next),
          "{{ email }}",
        )}
        ${renderInputWithTokens(
          "Subject",
          String(step.config.subject ?? ""),
          (next) => setField("subject", next),
          "{{ name }} — service quote",
        )}
        <label class="lq-field lq-field--inline">
          <input
            type="checkbox"
            ?checked=${Boolean(step.config.useTemplate)}
            @change=${(e: Event) => setField("useTemplate", (e.target as HTMLInputElement).checked)}
          />
          <span>Render with the selected style template</span>
        </label>
      `;
    case "ai-proposal":
      return html`
        <label class="lq-field">
          <span class="lq-field__label">Model</span>
          <input
            class="lq-input lq-input--mono"
            .value=${String(step.config.model ?? "google/gemini-pro")}
            @change=${(e: Event) => setField("model", (e.target as HTMLInputElement).value.trim())}
          />
        </label>
        ${renderTextareaWithTokens(
          "System prompt",
          String(step.config.instructions ?? ""),
          (next) => setField("instructions", next),
          "The AI receives the webhook body + the active business's CRM products + this prompt. Use {{ tokens }} freely.",
        )}
      `;
    case "respond-webhook": {
      const body = step.config.json && typeof step.config.json === "object" ? step.config.json : {};
      return html`
        <label class="lq-field">
          <span class="lq-field__label">Response JSON</span>
          <textarea
            class="lq-textarea lq-textarea--mono"
            rows="6"
            .value=${JSON.stringify(body, null, 2)}
            @change=${(e: Event) => {
              try {
                setField("json", JSON.parse((e.target as HTMLTextAreaElement).value || "{}"));
              } catch {
                setField("json", { error: "Invalid JSON — fix and re-blur to save." });
              }
            }}
          ></textarea>
        </label>
      `;
    }
    case "link-to-project": {
      const allProjects = state.kanbanProjects ?? [];
      const linked = allProjects.find((p) => p.id === cfg.linkedProjectId) ?? null;
      return html`
        <label class="lq-field">
          <span class="lq-field__label">Workspace project</span>
          <button
            type="button"
            class="lq-project-trigger ${linked ? "is-linked" : ""}"
            @click=${() => openProjectPicker(state)}
          >
            ${linked
              ? html`
                  <span class="lq-project-trigger__swatch" style=${`background:${linked.color || "var(--g-primary)"};`}></span>
                  <span class="lq-project-trigger__main">
                    <span class="lq-project-trigger__name">${linked.name}</span>
                    <span class="lq-project-trigger__sub">${linked.id}</span>
                  </span>
                `
              : html`
                  <span class="lq-project-trigger__main">
                    <span class="lq-project-trigger__name lq-project-trigger__name--empty">Choose a project…</span>
                    <span class="lq-project-trigger__sub">${allProjects.length} available</span>
                  </span>
                `}
            <span class="lq-project-trigger__caret">⌕</span>
          </button>
        </label>
        <label class="lq-field">
          <span class="lq-field__label">Initial column / status</span>
          <input
            class="lq-input"
            .value=${String(step.config.columnStatus ?? "todo")}
            @change=${(e: Event) => setField("columnStatus", (e.target as HTMLInputElement).value.trim())}
          />
        </label>
      `;
    }
    case "branch-on-criteria":
      return html`
        <p class="lq-card__hint">Use the branch pill on each later step to run only when qualified or unqualified. This step is purely a divider for readability.</p>
      `;
    case "tag-lead":
      return html`
        <label class="lq-field">
          <span class="lq-field__label">Tags (comma separated)</span>
          <input
            class="lq-input"
            .value=${Array.isArray(step.config.tags) ? (step.config.tags as string[]).join(", ") : ""}
            @change=${(e: Event) =>
              setField(
                "tags",
                (e.target as HTMLInputElement).value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              )}
          />
        </label>
      `;
  }
}

/**
 * Input with an attached token-picker popover. Click <code>{ }</code> to
 * insert any of the documented `{{ token }}` placeholders into the field.
 */
function renderInputWithTokens(
  label: string,
  value: string,
  onChange: (next: string) => void,
  placeholder?: string,
): TemplateResult {
  return html`
    <label class="lq-field">
      <div class="lq-field__row">
        <span class="lq-field__label">${label}</span>
        ${renderTokenButton((token) => onChange(value + token))}
      </div>
      <input
        class="lq-input lq-input--mono"
        placeholder=${placeholder ?? ""}
        .value=${value}
        @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
      />
    </label>
  `;
}

function renderTextareaWithTokens(
  label: string,
  value: string,
  onChange: (next: string) => void,
  hint?: string,
): TemplateResult {
  return html`
    <label class="lq-field">
      <div class="lq-field__row">
        <span class="lq-field__label">${label}</span>
        ${renderTokenButton((token) => onChange(value + token))}
      </div>
      <textarea
        class="lq-textarea"
        rows="6"
        .value=${value}
        @change=${(e: Event) => onChange((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      ${hint ? html`<span class="lq-field__hint">${hint}</span>` : nothing}
    </label>
  `;
}

function renderTokenButton(insert: (token: string) => void): TemplateResult {
  return html`
    <details class="lq-token-popover">
      <summary class="lq-token-btn" title="Insert a {{ token }} placeholder">{ }</summary>
      <div class="lq-token-popover__menu">
        <div class="lq-token-popover__title">Insert token</div>
        ${COMMON_TOKENS.map(
          (t) => html`
            <button
              type="button"
              class="lq-token-popover__row"
              @click=${(e: Event) => {
                insert(`{{ ${t.token} }}`);
                // Close the popover after insertion
                const det = (e.target as HTMLElement).closest("details");
                if (det) (det as HTMLDetailsElement).open = false;
              }}
            >
              <code>{{ ${t.token} }}</code>
              <span>${t.description}</span>
            </button>
          `,
        )}
      </div>
    </details>
  `;
}

// ── Side tabs ──────────────────────────────────────────────────────────

function renderSideTabs(state: AppViewState, lq: LeadQualifierState): TemplateResult {
  const tab = getSideTab(lq);
  const tabs: Array<{ id: SideTab; label: string }> = [
    { id: "preview", label: "Preview" },
    { id: "templates", label: "Templates" },
    { id: "project", label: "Project" },
    { id: "discovery", label: "Discovery" },
  ];
  return html`
    <div class="lq-side-tabs">
      ${tabs.map(
        (t) => html`
          <button
            class="lq-side-tab ${tab === t.id ? "is-active" : ""}"
            @click=${() => {
              setSideTab(lq, t.id);
              state.requestUpdate?.();
            }}
          >${t.label}</button>
        `,
      )}
    </div>
  `;
}

// ── Preview pane ───────────────────────────────────────────────────────

function renderPreviewPane(
  _state: AppViewState,
  _lq: LeadQualifierState,
  cfg: QualifierConfig,
): TemplateResult {
  const evalRes = evaluateQualification(cfg, SAMPLE_PAYLOAD);
  const tpl = STYLE_TEMPLATES.find((t) => t.id === cfg.styleTemplateId) ?? STYLE_TEMPLATES[0];
  const flat = SAMPLE_PAYLOAD.body ?? SAMPLE_PAYLOAD;
  const renderedBody = composeEmailPreview(tpl.css, flat);
  // Build a self-contained iframe-srcdoc string. We use srcdoc instead of
  // an inline element so the template's CSS is fully scoped (no clashes
  // with the host page styles).
  const srcdoc = renderedBody
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return html`
    <section class="lq-card lq-preview-card">
      <header class="lq-card__head">
        <div>
          <h2>Live preview</h2>
          <p class="lq-card__subhead">What runs against the sample payload — refreshes as you edit.</p>
        </div>
        <span class="lq-pill ${evalRes.qualified ? "lq-pill--ok" : "lq-pill--err"}">
          ${evalRes.qualified ? "Qualified" : "Unqualified"}
        </span>
      </header>
      <div class="lq-preview-criteria">
        <div class="lq-field__label" style="margin-bottom:6px;">Criteria check</div>
        ${cfg.criteria.length === 0
          ? html`<div class="lq-empty-row" style="padding:6px 8px;">No criteria — qualifies by default.</div>`
          : cfg.criteria.map((c) => {
              const pass = evaluateCriterion(c, SAMPLE_PAYLOAD);
              return html`
                <div class="lq-preview-criteria__row ${pass ? "is-pass" : "is-fail"}">
                  <span class="lq-preview-criteria__icon">${pass ? "✓" : "✗"}</span>
                  <span class="lq-preview-criteria__label">${describeCriterion(c)}</span>
                </div>
              `;
            })}
      </div>
      <div class="lq-preview-flow">
        <div class="lq-field__label" style="margin-bottom:6px;">Action fan-out</div>
        ${cfg.actions.length === 0
          ? html`<div class="lq-empty-row" style="padding:6px 8px;">No actions to run.</div>`
          : cfg.actions.map((a, i) => {
              const willRun =
                a.branch === null ||
                (a.branch === "qualified" && evalRes.qualified) ||
                (a.branch === "unqualified" && !evalRes.qualified);
              return html`
                <div class="lq-preview-flow__row ${willRun ? "" : "is-skipped"}">
                  <span class="lq-preview-flow__step">${i + 1}</span>
                  <span class="lq-preview-flow__icon">${ACTION_KIND_ICONS[a.kind]}</span>
                  <span class="lq-preview-flow__label">${a.label ?? ACTION_KIND_LABELS[a.kind]}</span>
                  <span class="lq-preview-flow__state">${willRun ? "runs" : "skipped"}</span>
                </div>
              `;
            })}
      </div>
      <div class="lq-preview-email">
        <div class="lq-field__label" style="margin-bottom:6px;">Email body (style: ${tpl.name})</div>
        <iframe
          class="lq-preview-iframe"
          sandbox=""
          srcdoc=${srcdoc}
          title="Email preview"
        ></iframe>
      </div>
    </section>
  `;
}

function describeCriterion(c: Criterion): string {
  const fieldDef = CRITERION_FIELDS.find((f) => f.id === c.field);
  const fieldLabel = c.field === "custom" ? c.customPath || "(custom)" : fieldDef?.label ?? c.field;
  if (c.op === "exists") return `${fieldLabel} present`;
  if (c.op === "not_exists") return `${fieldLabel} missing`;
  return `${fieldLabel} ${OP_LABELS[c.op]} ${c.value || "(empty)"}`;
}

/**
 * Compose a self-contained HTML doc that pairs the chosen template's CSS
 * with the sample lead body data. This is what gets stuffed into the
 * preview iframe — keeps the template render isolated from the host
 * page's stylesheet.
 */
function composeEmailPreview(css: string, body: Record<string, any>): string {
  const services = Array.isArray(body.solution_fit) ? body.solution_fit : [];
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><style>${css}</style></head>
<body>
  <div class="container">
    <div class="header"><h1>${escape(body.business_snapshot ?? "Your business") + " — proposal"}</h1></div>
    <div class="section">
      <h2>Lead snapshot</h2>
      <p><strong>Name:</strong> ${escape(body.name ?? "—")}</p>
      <p><strong>Email:</strong> ${escape(body.email ?? "—")}</p>
      <p><strong>Phone:</strong> ${escape(body.phone ?? "—")}</p>
    </div>
    <div class="section">
      <h2>What they said</h2>
      <p><strong>Frustration:</strong> ${escape(body.frustration ?? "—")}</p>
      <p><strong>Wish:</strong> ${escape(body.wish ?? "—")}</p>
      <p><strong>Timeline:</strong> ${escape(body.timeline ?? "—")}</p>
      <p><strong>Budget:</strong> ${escape(body.budget ?? "—")}</p>
    </div>
    <div class="section">
      <h2>Recommended services</h2>
      ${services.length > 0 ? services.map((s: string) => `<p>• ${escape(s)}</p>`).join("") : "<p>—</p>"}
    </div>
    <div class="btn-container">
      <a class="btn" href="#">Book a call</a>
    </div>
  </div>
</body></html>`;
  return html;
}

function escape(v: any): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Templates pane ─────────────────────────────────────────────────────

function renderTemplatesSection(
  state: AppViewState,
  lq: LeadQualifierState,
  cfg: QualifierConfig,
): TemplateResult {
  return html`
    <section class="lq-card">
      <header class="lq-card__head">
        <div>
          <h2>Style template</h2>
          <p class="lq-card__subhead">Used by Send-email + AI-proposal actions.</p>
        </div>
      </header>
      <div class="lq-template-grid">
        ${STYLE_TEMPLATES.map(
          (t) => html`
            <button
              class="lq-template ${cfg.styleTemplateId === t.id ? "is-active" : ""}"
              @click=${() => {
                patchActiveConfig(state, { styleTemplateId: t.id });
                lq.previewTemplateId = t.id;
                state.requestUpdate?.();
              }}
              @mouseenter=${() => {
                lq.previewTemplateId = t.id;
                state.requestUpdate?.();
              }}
            >
              <div class="lq-template__swatch" style="background:${t.preview};"></div>
              <div class="lq-template__name">${t.name}</div>
              <div class="lq-template__desc">${t.description}</div>
              ${cfg.styleTemplateId === t.id ? html`<div class="lq-template__active-tag">Active</div>` : nothing}
            </button>
          `,
        )}
      </div>
      <details class="lq-disclosure" style="margin-top:10px;">
        <summary>Inspect CSS for the active template</summary>
        <pre class="lq-pre">${STYLE_TEMPLATES.find((t) => t.id === cfg.styleTemplateId)?.css ?? ""}</pre>
      </details>
    </section>
  `;
}

// ── Project pane ───────────────────────────────────────────────────────

function renderProjectSection(state: AppViewState, cfg: QualifierConfig): TemplateResult {
  const projects = state.kanbanProjects ?? [];
  const linked = projects.find((p) => p.id === cfg.linkedProjectId) ?? null;
  return html`
    <section class="lq-card">
      <header class="lq-card__head">
        <div>
          <h2>Workspace project</h2>
          <p class="lq-card__subhead">Qualified leads create a card in this kanban project.</p>
        </div>
      </header>
      <button
        type="button"
        class="lq-project-trigger ${linked ? "is-linked" : ""}"
        @click=${() => openProjectPicker(state)}
      >
        ${linked
          ? html`
              <span class="lq-project-trigger__swatch" style=${`background:${linked.color || "var(--g-primary)"};`}></span>
              <span class="lq-project-trigger__main">
                <span class="lq-project-trigger__name">${linked.name}</span>
                <span class="lq-project-trigger__sub">${linked.id}${linked.taskCount != null ? ` · ${linked.taskCount} tasks` : ""}</span>
              </span>
            `
          : html`
              <span class="lq-project-trigger__main">
                <span class="lq-project-trigger__name lq-project-trigger__name--empty">Choose a project…</span>
                <span class="lq-project-trigger__sub">${projects.length} available</span>
              </span>
            `}
        <span class="lq-project-trigger__caret">⌕</span>
      </button>
      ${linked ? html`
        <div class="lq-project-actions">
          <button class="lq-btn lq-btn--ghost" @click=${() => patchActiveConfig(state, { linkedProjectId: "" })}>Unlink</button>
          <button class="lq-btn" @click=${() => openProjectPicker(state)}>Change project</button>
        </div>
      ` : nothing}
      ${projects.length === 0
        ? html`<span class="lq-field__hint">No projects yet — open the <strong>Projects</strong> tab to create one.</span>`
        : linked
        ? html`<div class="lq-project-card">
            <div class="lq-project-card__name">${linked.name}</div>
            <div class="lq-project-card__hint">New cards land in the “${stringConfig(cfg, "columnStatus", "todo")}” column.</div>
          </div>`
        : html`<span class="lq-field__hint">Pick a project to receive qualified leads as kanban cards.</span>`}
    </section>
  `;
}

// ── Project picker modal ───────────────────────────────────────────────
// A searchable, keyboard-friendly selector so picking from a long list of
// projects doesn't devolve into a native <select> with hundreds of options.

function openProjectPicker(state: AppViewState): void {
  const lq = state.leadQualifierState;
  if (!lq) return;
  lq.projectPickerOpen = true;
  lq.projectPickerQuery = "";
  state.requestUpdate?.();
}

function closeProjectPicker(state: AppViewState): void {
  const lq = state.leadQualifierState;
  if (!lq) return;
  lq.projectPickerOpen = false;
  state.requestUpdate?.();
}

function selectProject(state: AppViewState, projectId: string): void {
  patchActiveConfig(state, { linkedProjectId: projectId });
  closeProjectPicker(state);
}

function renderProjectPicker(
  state: AppViewState,
  lq: LeadQualifierState,
  cfg: QualifierConfig | null,
): TemplateResult {
  const projects = state.kanbanProjects ?? [];
  const query = (lq.projectPickerQuery ?? "").trim().toLowerCase();
  const filtered = !query
    ? projects
    : projects.filter((p) => {
        const haystack = [p.name, p.id, p.description ?? "", (p.type ?? []).join(" "), p.status ?? "", p.priority ?? ""]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });
  const linkedId = cfg?.linkedProjectId ?? "";

  return html`
    <div
      class="lq-modal-backdrop ${lq.projectPickerOpen ? "is-open" : ""}"
      @click=${() => closeProjectPicker(state)}
    ></div>
    <div
      class="lq-modal lq-project-modal ${lq.projectPickerOpen ? "is-open" : ""}"
      role="dialog"
      aria-label="Choose project"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <header class="lq-modal__head">
        <div>
          <h2 class="lq-modal__title">Link to a project</h2>
          <p class="lq-modal__sub">Qualified leads land as cards in the selected kanban board.</p>
        </div>
        <button class="lq-modal__close" @click=${() => closeProjectPicker(state)} aria-label="Close">✕</button>
      </header>
      <div class="lq-modal__search">
        <span class="lq-modal__search-icon">⌕</span>
        <input
          type="text"
          class="lq-modal__search-input"
          placeholder="Search by name, ID, status, type…"
          autocomplete="off"
          .value=${lq.projectPickerQuery ?? ""}
          @input=${(e: InputEvent) => {
            const v = (e.target as HTMLInputElement).value;
            const cur = state.leadQualifierState;
            if (!cur) return;
            cur.projectPickerQuery = v;
            state.requestUpdate?.();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Escape") closeProjectPicker(state);
            else if (e.key === "Enter" && filtered.length > 0) selectProject(state, filtered[0].id);
          }}
        />
        <span class="lq-modal__count">${filtered.length}/${projects.length}</span>
      </div>
      <div class="lq-modal__body">
        ${projects.length === 0
          ? html`<div class="lq-modal__empty">
              <div class="lq-modal__empty-icon">📋</div>
              <div>No kanban projects yet. Create one from the <strong>Projects</strong> tab, then come back here.</div>
            </div>`
          : filtered.length === 0
          ? html`<div class="lq-modal__empty">No projects match “${lq.projectPickerQuery}”.</div>`
          : html`
              <button
                type="button"
                class="lq-project-row ${!linkedId ? "is-selected" : ""}"
                @click=${() => selectProject(state, "")}
              >
                <span class="lq-project-row__swatch" style="background:transparent;border:1px dashed var(--g-border-strong, #fbbf24);"></span>
                <span class="lq-project-row__main">
                  <span class="lq-project-row__name">— Unlink —</span>
                  <span class="lq-project-row__sub">Stop forwarding qualified leads to any project</span>
                </span>
                ${!linkedId ? html`<span class="lq-project-row__check">✓</span>` : nothing}
              </button>
              ${filtered.map((p) => html`
                <button
                  type="button"
                  class="lq-project-row ${p.id === linkedId ? "is-selected" : ""}"
                  @click=${() => selectProject(state, p.id)}
                >
                  <span class="lq-project-row__swatch" style=${`background:${p.color || "var(--g-primary)"};`}></span>
                  <span class="lq-project-row__main">
                    <span class="lq-project-row__name">${p.name}</span>
                    <span class="lq-project-row__sub">
                      ${p.id}
                      ${p.status ? html` · <em>${p.status}</em>` : nothing}
                      ${p.priority ? html` · ${p.priority}` : nothing}
                      ${p.taskCount != null ? html` · ${p.taskCount} tasks` : nothing}
                    </span>
                    ${p.description ? html`<span class="lq-project-row__desc">${p.description}</span>` : nothing}
                  </span>
                  ${p.id === linkedId ? html`<span class="lq-project-row__check">✓</span>` : nothing}
                </button>
              `)}
            `}
      </div>
      <footer class="lq-modal__foot">
        <span class="lq-modal__hint">↵ to select first match · esc to close</span>
        <button class="lq-btn" @click=${() => closeProjectPicker(state)}>Close</button>
      </footer>
    </div>
  `;
}

// ── Business picker modal ──────────────────────────────────────────────
// Same affordance as the project picker — search + select-by-click — plus
// an inline "create new business" row so the empty-state on a fresh
// install doesn't dead-end.

function openBusinessPicker(state: AppViewState): void {
  const lq = state.leadQualifierState;
  if (!lq) return;
  lq.businessPickerOpen = true;
  lq.businessPickerQuery = "";
  lq.businessPickerCreateName = "";
  state.requestUpdate?.();
}

function closeBusinessPicker(state: AppViewState): void {
  const lq = state.leadQualifierState;
  if (!lq) return;
  lq.businessPickerOpen = false;
  state.requestUpdate?.();
}

function renderBusinessPicker(
  state: AppViewState,
  client: GatewayBrowserClient,
  lq: LeadQualifierState,
): TemplateResult {
  const bs = state.businessState;
  const businesses = bs?.businesses ?? [];
  const activeId = bs?.activeBusinessId ?? "";
  const query = (lq.businessPickerQuery ?? "").trim().toLowerCase();
  const filtered = !query
    ? businesses
    : businesses.filter((b) => {
        const hay = [b.name, b.id, b.industry ?? "", b.context ?? ""].join(" ").toLowerCase();
        return hay.includes(query);
      });

  const doCreate = async () => {
    const name = (lq.businessPickerCreateName ?? "").trim();
    if (!name) return;
    await createBusiness(state, client, name);
    closeBusinessPicker(state);
  };

  return html`
    <div
      class="lq-modal-backdrop ${lq.businessPickerOpen ? "is-open" : ""}"
      @click=${() => closeBusinessPicker(state)}
    ></div>
    <div
      class="lq-modal lq-business-modal ${lq.businessPickerOpen ? "is-open" : ""}"
      role="dialog"
      aria-label="Choose business"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <header class="lq-modal__head">
        <div>
          <h2 class="lq-modal__title">Switch business</h2>
          <p class="lq-modal__sub">Each business owns its own qualifier, CRM, and project links.</p>
        </div>
        <button class="lq-modal__close" @click=${() => closeBusinessPicker(state)} aria-label="Close">✕</button>
      </header>
      <div class="lq-modal__search">
        <span class="lq-modal__search-icon">⌕</span>
        <input
          type="text"
          class="lq-modal__search-input"
          placeholder="Search by name, ID, industry, context…"
          autocomplete="off"
          .value=${lq.businessPickerQuery ?? ""}
          @input=${(e: InputEvent) => {
            const v = (e.target as HTMLInputElement).value;
            const cur = state.leadQualifierState;
            if (!cur) return;
            cur.businessPickerQuery = v;
            state.requestUpdate?.();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Escape") closeBusinessPicker(state);
            else if (e.key === "Enter" && filtered.length > 0) {
              const first = filtered[0];
              if (first.id !== activeId) void switchBusiness(state, client, first.id);
              closeBusinessPicker(state);
            }
          }}
        />
        <span class="lq-modal__count">${filtered.length}/${businesses.length}</span>
      </div>
      <div class="lq-modal__body">
        ${businesses.length === 0
          ? html`<div class="lq-modal__empty">
              <div class="lq-modal__empty-icon">🏢</div>
              <div>No businesses yet. Create your first one below to start qualifying leads.</div>
            </div>`
          : filtered.length === 0
          ? html`<div class="lq-modal__empty">No businesses match “${lq.businessPickerQuery}”.</div>`
          : filtered.map((b) => html`
              <button
                type="button"
                class="lq-project-row ${b.id === activeId ? "is-selected" : ""}"
                @click=${() => {
                  if (b.id !== activeId) void switchBusiness(state, client, b.id);
                  closeBusinessPicker(state);
                }}
              >
                <span class="lq-project-row__swatch" style="background: var(--g-primary);"></span>
                <span class="lq-project-row__main">
                  <span class="lq-project-row__name">${b.name || "Untitled"}</span>
                  <span class="lq-project-row__sub">
                    ${b.id}
                    ${b.industry ? html` · ${b.industry}` : nothing}
                    ${b.crmDatabaseId ? html` · CRM connected` : nothing}
                  </span>
                  ${b.context ? html`<span class="lq-project-row__desc">${b.context}</span>` : nothing}
                </span>
                ${b.id === activeId ? html`<span class="lq-project-row__check">✓</span>` : nothing}
              </button>
            `)}
      </div>
      <footer class="lq-modal__create">
        <div class="lq-modal__create-label">+ Create a new business</div>
        <div class="lq-modal__create-row">
          <input
            class="lq-modal__create-input"
            type="text"
            placeholder="e.g. Acme Co."
            .value=${lq.businessPickerCreateName ?? ""}
            @input=${(e: InputEvent) => {
              const v = (e.target as HTMLInputElement).value;
              const cur = state.leadQualifierState;
              if (!cur) return;
              cur.businessPickerCreateName = v;
              state.requestUpdate?.();
            }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void doCreate(); }}
          />
          <button
            class="lq-btn lq-btn--primary"
            ?disabled=${!(lq.businessPickerCreateName ?? "").trim()}
            @click=${() => void doCreate()}
          >Create</button>
        </div>
      </footer>
      <footer class="lq-modal__foot">
        <span class="lq-modal__hint">↵ on search to switch · esc to close</span>
        <button class="lq-btn" @click=${() => closeBusinessPicker(state)}>Close</button>
      </footer>
    </div>
  `;
}

function stringConfig(cfg: QualifierConfig, key: string, fallback: string): string {
  const linkAction = cfg.actions.find((a) => a.kind === "link-to-project");
  if (!linkAction) return fallback;
  const v = linkAction.config[key];
  return typeof v === "string" && v ? v : fallback;
}

// ── Test runner + recent runs ──────────────────────────────────────────

function renderTestRunner(
  state: AppViewState,
  client: GatewayBrowserClient,
  _lq: LeadQualifierState,
  cfg: QualifierConfig,
): TemplateResult {
  return html`
    <section class="lq-card">
      <header class="lq-card__head">
        <div>
          <h2>Test runner</h2>
          <p class="lq-card__subhead">Dry-run locally or send the sample to the gateway.</p>
        </div>
      </header>
      <details class="lq-disclosure">
        <summary>View sample payload</summary>
        <pre class="lq-pre">${JSON.stringify(SAMPLE_PAYLOAD, null, 2)}</pre>
      </details>
      <div class="lq-test-actions">
        <button class="lq-btn lq-btn--primary" @click=${() => dryRun(state, SAMPLE_PAYLOAD)}>
          Dry-run sample
        </button>
        <button class="lq-btn" @click=${async () => {
          await pingWebhook(state, client);
          state.requestUpdate?.();
        }}>Live ping</button>
        <button
          class="lq-btn lq-btn--ghost"
          @click=${async () => {
            try {
              const text = await navigator.clipboard.readText();
              dryRun(state, JSON.parse(text));
            } catch {
              dryRun(state, { body: { _error: "clipboard read failed" } });
            }
          }}
        >From clipboard</button>
      </div>
      <div class="lq-card__hint" style="margin-top:8px;">
        ${cfg.criteria.length} criteria · ${cfg.actions.length} actions
      </div>
    </section>
  `;
}

function renderRecentRuns(lq: LeadQualifierState): TemplateResult {
  if (lq.runs.length === 0) {
    return html`
      <section class="lq-card">
        <header class="lq-card__head"><h2>Recent runs</h2></header>
        <div class="lq-empty-row" style="padding:18px;">No runs yet — fire a sample from above or send a real webhook.</div>
      </section>
    `;
  }
  return html`
    <section class="lq-card">
      <header class="lq-card__head">
        <h2>Recent runs</h2>
        <span class="lq-card__hint">${lq.runs.length}</span>
      </header>
      <div class="lq-runs">
        ${lq.runs.slice(0, 12).map(
          (r) => html`
            <div class="lq-run lq-run--${r.result}">
              <span class="lq-run__badge">${r.result}</span>
              <span class="lq-run__time">${new Date(r.receivedAt).toLocaleTimeString()}</span>
              <span class="lq-run__note" title=${r.note}>${r.note}</span>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

// ── Styles ─────────────────────────────────────────────────────────────

function qualifierStyles(): TemplateResult {
  return html`
    <style>
      .lq-page {
        padding: 22px 24px 60px;
        max-width: 1380px;
        margin: 0 auto;
        color: var(--g-fg, var(--glass-fg));
        font-family: var(--g-font-family, "Inter", "SF Pro Display", -apple-system, sans-serif);
      }
      .lq-loading,
      .lq-empty-card {
        padding: 40px 16px;
        text-align: center;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        font-style: italic;
      }
      .lq-empty-row {
        padding: 14px 12px;
        background: color-mix(in srgb, var(--glass-base) 18%, transparent);
        border: 1px dashed color-mix(in srgb, var(--g-primary) 16%, transparent);
        border-radius: 8px;
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        font-style: italic;
        text-align: center;
      }

      /* Banners */
      .lq-banner {
        padding: 10px 14px; border-radius: 8px; margin-bottom: 12px;
        font-size: 12px; font-weight: 600;
      }
      .lq-banner--error { background: rgba(239, 68, 68, 0.12); color: #ff8a8a; border: 1px solid rgba(239, 68, 68, 0.35); }
      .lq-banner--ok { background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); }

      .lq-warnings {
        display: flex; flex-direction: column; gap: 4px;
        padding: 10px 14px; border-radius: 10px;
        margin-bottom: 14px;
      }
      .lq-warnings.is-warn {
        background: color-mix(in srgb, var(--glass-gold) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--glass-gold) 35%, transparent);
      }
      .lq-warnings.is-info {
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      }
      .lq-warning { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; }
      .lq-warning__icon { font-weight: 700; color: var(--glass-gold); }
      .lq-warning__msg {
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        line-height: 1.45;
      }

      /* Header */
      .lq-header {
        display: flex; justify-content: space-between; align-items: flex-start;
        gap: 18px; flex-wrap: wrap;
        padding: 18px 22px; margin-bottom: 18px;
        border-radius: 16px;
        background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, transparent 60%),
          color-mix(in srgb, var(--g-bg, var(--glass-3)) 55%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        backdrop-filter: blur(14px) saturate(140%);
      }
      .lq-header__main {
        display: flex; flex-direction: column; gap: 10px;
        min-width: 0; flex: 1;
      }
      .lq-header__title-row {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      .lq-header__title-row h1 {
        margin: 0; font-size: 22px; font-weight: 800;
        color: var(--g-primary);
        letter-spacing: -0.005em;
      }
      .lq-header__icon {
        font-size: 20px; color: var(--g-primary);
        text-shadow: 0 0 14px color-mix(in srgb, var(--g-primary) 50%, transparent);
      }
      .lq-header__pipe-name {
        font-size: 12px; padding: 3px 10px;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 99px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        font-style: italic;
      }
      .lq-header__chips {
        display: flex; gap: 8px; flex-wrap: wrap;
      }
      .lq-chip-readonly {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 4px 12px;
        background: color-mix(in srgb, var(--glass-base) 25%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 99px;
        font-size: 11px;
      }
      .lq-chip-readonly__label {
        font-size: 9px; font-weight: 800; letter-spacing: 0.18em;
        text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .lq-chip-readonly strong {
        color: var(--g-primary); font-weight: 700;
      }
      .lq-chip-readonly strong.is-zero {
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .lq-chip-readonly.is-warn {
        background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
        border-color: color-mix(in srgb, var(--glass-gold) 35%, transparent);
      }
      .lq-chip-readonly.is-warn strong { color: var(--glass-gold); }

      /* Clickable variant — turns the Business chip into a picker button. */
      button.lq-chip-readonly {
        font: inherit;
        cursor: pointer;
        color: inherit;
        transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      button.lq-chip-readonly.lq-chip-readonly--pick {
        border-color: color-mix(in srgb, var(--g-primary) 28%, transparent);
      }
      button.lq-chip-readonly.lq-chip-readonly--pick:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, color-mix(in srgb, var(--glass-base) 25%, transparent));
        border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
      }
      button.lq-chip-readonly.lq-chip-readonly--pick:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-chip-readonly__caret {
        margin-left: 4px;
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      button.lq-chip-readonly:hover .lq-chip-readonly__caret { color: var(--g-primary); }

      /* Inline create-business row inside the business picker modal. */
      .lq-modal__create {
        padding: 12px 18px;
        border-top: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
        display: flex; flex-direction: column; gap: 6px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
      }
      .lq-modal__create-label {
        font-size: 10px; font-weight: 800; letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--g-fg-faint, var(--glass-fg-2));
      }
      .lq-modal__create-row {
        display: flex; gap: 8px; align-items: center;
      }
      .lq-modal__create-input {
        flex: 1;
        padding: 8px 12px;
        background: color-mix(in srgb, var(--glass-base) 25%, transparent);
        border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 12%, transparent));
        border-radius: 8px;
        color: var(--g-fg, var(--glass-fg));
        font: inherit;
        font-size: 13px;
        outline: none;
      }
      .lq-modal__create-input:focus {
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 22%, transparent);
      }
      .lq-header__right {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      }
      .lq-biz-select {
        padding: 6px 12px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 6px;
        font-family: inherit; font-size: 12px; font-weight: 600;
        cursor: pointer; outline: none;
      }
      .lq-toggle {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 5px 12px;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 99px;
        font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
        cursor: pointer;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        text-transform: uppercase;
      }
      .lq-toggle input { position: absolute; opacity: 0; pointer-events: none; }
      .lq-toggle__dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        transition: background 0.18s ease, box-shadow 0.18s ease;
      }
      .lq-toggle.is-on { background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.45); color: #34d399; }
      .lq-toggle.is-on .lq-toggle__dot { background: #34d399; box-shadow: 0 0 10px rgba(16, 185, 129, 0.6); }

      /* Buttons */
      .lq-btn {
        padding: 7px 14px;
        font-family: inherit; font-size: 12px; font-weight: 600;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 6px; cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      }
      .lq-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      }
      .lq-btn:active { transform: translateY(1px); }
      .lq-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .lq-btn--sm { padding: 4px 10px; font-size: 11px; }
      .lq-btn--primary {
        background: linear-gradient(135deg, var(--g-primary), color-mix(in srgb, var(--g-primary) 60%, #5a3a00));
        color: var(--glass-ink); border-color: var(--g-primary);
        box-shadow: 0 4px 14px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-btn--primary:hover { box-shadow: 0 6px 20px color-mix(in srgb, var(--g-primary) 50%, transparent); }
      .lq-btn--ghost { background: transparent; }
      .lq-icon-btn {
        width: 26px; height: 26px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 14px;
        background: transparent;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 5px; cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
      }
      .lq-icon-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
        border-color: var(--g-primary);
      }
      .lq-icon-btn--danger:hover {
        background: rgba(239, 68, 68, 0.12);
        color: #ff8a8a;
        border-color: rgba(239, 68, 68, 0.45);
      }

      /* Layout */
      .lq-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 380px;
        gap: 18px;
      }
      @media (max-width: 1080px) {
        .lq-grid { grid-template-columns: 1fr; }
      }
      .lq-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
      .lq-col--side { gap: 12px; }

      /* Cards */
      .lq-card {
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 4%, transparent), transparent),
          color-mix(in srgb, var(--g-bg, var(--glass-3)) 55%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
        border-radius: 14px;
        padding: 16px 18px;
        backdrop-filter: blur(10px) saturate(130%);
      }
      .lq-card__head {
        display: flex; justify-content: space-between; align-items: flex-start;
        gap: 12px; flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .lq-card__head h2 {
        margin: 0; font-size: 13px; font-weight: 800; letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--g-primary);
      }
      .lq-card__subhead {
        margin: 2px 0 0;
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 90%, transparent);
        font-style: italic;
      }
      .lq-card__hint {
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 90%, transparent);
        font-style: italic;
      }

      /* Pills */
      .lq-pill {
        display: inline-flex; align-items: center;
        padding: 3px 10px;
        font-size: 9px; font-weight: 800; letter-spacing: 0.14em;
        text-transform: uppercase;
        border-radius: 99px;
      }
      .lq-pill--ok { background: rgba(16, 185, 129, 0.16); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); }
      .lq-pill--err { background: rgba(239, 68, 68, 0.16); color: #ff8a8a; border: 1px solid rgba(239, 68, 68, 0.35); }

      /* Fields */
      .lq-field {
        display: flex; flex-direction: column; gap: 4px;
        margin-bottom: 10px;
      }
      .lq-field--inline {
        flex-direction: row; align-items: center; gap: 8px;
      }
      .lq-field__row {
        display: flex; align-items: center; justify-content: space-between; gap: 6px;
      }
      .lq-field__label {
        font-size: 9px; font-weight: 700; letter-spacing: 0.16em;
        text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .lq-field__hint {
        font-size: 10px;
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 100%, transparent);
        margin-top: 2px;
      }
      .lq-field__hint code {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        padding: 1px 4px; border-radius: 3px;
      }
      .lq-input {
        width: 100%;
        padding: 7px 10px;
        font-family: inherit; font-size: 12px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        color: var(--g-fg, var(--glass-fg));
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 5px;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .lq-input:focus {
        border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .lq-input--mono { font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 11px; }
      .lq-input--narrow { max-width: 130px; }
      .lq-input--inline {
        flex: 1; min-width: 0;
        background: transparent; border: 1px solid transparent;
        padding: 4px 8px;
        font-weight: 600; font-size: 12.5px;
      }
      .lq-input--inline:focus {
        background: color-mix(in srgb, var(--glass-base) 25%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-textarea {
        width: 100%;
        padding: 8px 10px;
        font-family: inherit; font-size: 12px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        color: var(--g-fg, var(--glass-fg));
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 6px;
        resize: vertical;
        outline: none;
      }
      .lq-textarea:focus {
        border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .lq-textarea--mono { font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 11px; }
      .lq-input-row { display: flex; gap: 6px; align-items: center; }

      .lq-disclosure {
        margin-top: 8px;
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .lq-disclosure summary {
        cursor: pointer;
        padding: 4px 0;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .lq-pre {
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        padding: 10px 12px;
        border-radius: 6px;
        font-family: "JetBrains Mono", "Fira Code", monospace;
        font-size: 10px;
        line-height: 1.5;
        color: color-mix(in srgb, var(--g-fg, var(--glass-fg)) 90%, transparent);
        overflow: auto;
        max-height: 280px;
        margin: 0;
        white-space: pre-wrap;
      }

      /* Token popover */
      .lq-token-popover { position: relative; }
      .lq-token-popover summary {
        list-style: none; cursor: pointer;
      }
      .lq-token-popover summary::-webkit-details-marker { display: none; }
      .lq-token-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 22px;
        font-family: "JetBrains Mono", "Fira Code", monospace;
        font-size: 11px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 5px;
      }
      .lq-token-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-color: var(--g-primary);
      }
      .lq-token-popover[open] .lq-token-btn {
        background: color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-color: var(--g-primary);
      }
      .lq-token-popover__menu {
        position: absolute; right: 0; top: calc(100% + 4px);
        min-width: 240px;
        max-height: 280px; overflow-y: auto;
        padding: 6px;
        background: color-mix(in srgb, var(--g-bg, var(--glass-3)) 90%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
        z-index: 30;
      }
      .lq-token-popover__title {
        padding: 4px 8px;
        font-size: 9px; font-weight: 800; letter-spacing: 0.16em;
        text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .lq-token-popover__row {
        display: grid;
        grid-template-columns: 130px 1fr;
        gap: 8px; align-items: center;
        width: 100%;
        padding: 6px 8px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 5px;
        text-align: left;
        cursor: pointer;
        font-family: inherit;
      }
      .lq-token-popover__row:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-token-popover__row code {
        font-family: "JetBrains Mono", "Fira Code", monospace;
        font-size: 11px;
        color: var(--g-primary);
      }
      .lq-token-popover__row span {
        font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }

      /* Segmented */
      .lq-segmented {
        display: inline-flex; gap: 2px;
        padding: 2px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 6px;
      }
      .lq-segmented button {
        padding: 4px 10px; font-size: 10px; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase;
        background: transparent; color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        border: none; border-radius: 4px; cursor: pointer; font-family: inherit;
      }
      .lq-segmented button.active {
        background: color-mix(in srgb, var(--g-primary) 18%, transparent);
        color: var(--g-primary);
      }

      /* Quickstart */
      .lq-quickstart {
        padding: 24px;
        border-radius: 16px;
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 5%, transparent), transparent),
          color-mix(in srgb, var(--g-bg, var(--glass-3)) 55%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        backdrop-filter: blur(12px) saturate(140%);
      }
      .lq-quickstart__head h2 {
        margin: 0 0 4px;
        font-size: 18px; font-weight: 800; letter-spacing: -0.005em;
        color: var(--g-primary);
      }
      .lq-quickstart__head p {
        margin: 0 0 18px;
        font-size: 12px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        line-height: 1.55;
        max-width: 640px;
      }
      .lq-quickstart__grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
      }
      .lq-quickstart__card {
        position: relative;
        text-align: left;
        padding: 18px 18px 16px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 14px;
        cursor: pointer;
        transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
        font-family: inherit; color: inherit;
      }
      .lq-quickstart__card:hover {
        transform: translateY(-2px);
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: var(--g-primary);
        box-shadow: 0 12px 30px color-mix(in srgb, var(--g-primary) 18%, transparent);
      }
      .lq-quickstart__badge {
        display: inline-flex; align-items: center;
        padding: 3px 10px;
        font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 99px;
        color: var(--g-primary);
        margin-bottom: 10px;
      }
      .lq-quickstart__title {
        font-size: 16px; font-weight: 800; color: var(--g-primary);
        letter-spacing: -0.005em;
        margin-bottom: 2px;
      }
      .lq-quickstart__tagline {
        font-size: 12px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        line-height: 1.55;
        margin: 4px 0 12px;
      }
      .lq-quickstart__counts {
        display: flex; gap: 4px; align-items: center;
        font-size: 10px; color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        letter-spacing: 0.08em; text-transform: uppercase;
        margin-bottom: 10px;
      }
      .lq-quickstart__steps {
        display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px;
      }
      .lq-quickstart__step {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px;
        font-size: 14px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 6px;
      }
      .lq-quickstart__step--more {
        font-size: 10px; font-weight: 700;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .lq-quickstart__cta {
        font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--g-primary);
      }
      .lq-quickstart__skip {
        margin-top: 16px; text-align: center;
      }

      /* Criteria */
      .lq-criteria-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .lq-criterion {
        display: grid;
        grid-template-columns: 28px 180px 130px 1fr 28px 28px;
        gap: 6px; align-items: center;
        padding: 4px;
        border-radius: 8px;
        border: 1px solid transparent;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      .lq-criterion.is-pass { background: rgba(16, 185, 129, 0.04); border-color: rgba(16, 185, 129, 0.16); }
      .lq-criterion.is-fail { background: rgba(239, 68, 68, 0.04); border-color: rgba(239, 68, 68, 0.16); }
      .lq-criterion__index {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px;
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        color: var(--g-primary);
        border-radius: 50%;
        font-size: 10px; font-weight: 800;
      }
      .lq-criterion__no-value {
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 90%, transparent);
        text-align: center;
        font-style: italic;
      }
      .lq-criterion__pass {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px;
        font-size: 13px; font-weight: 800;
        border-radius: 50%;
      }
      .lq-criterion.is-pass .lq-criterion__pass { color: #34d399; background: rgba(16, 185, 129, 0.18); }
      .lq-criterion.is-fail .lq-criterion__pass { color: #ff8a8a; background: rgba(239, 68, 68, 0.18); }
      .lq-criteria__add {
        display: flex; align-items: center; gap: 8px;
      }
      @media (max-width: 720px) {
        .lq-criterion {
          grid-template-columns: auto 1fr 1fr;
          grid-auto-rows: auto;
        }
      }

      /* Action stack */
      .lq-action-stack {
        display: flex; flex-direction: column; gap: 6px;
        padding: 4px;
        margin-bottom: 8px;
      }
      .lq-action {
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 10px;
        transition: border-color 0.15s ease, background 0.15s ease, opacity 0.15s ease;
      }
      .lq-action:hover {
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .lq-action.is-expanded {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .lq-action.is-drop-target {
        border-color: var(--g-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-action.is-skipped { opacity: 0.55; }
      .lq-action__head {
        display: grid;
        grid-template-columns: 26px 16px auto 1fr auto auto auto auto;
        gap: 8px; align-items: center;
        padding: 8px 10px;
        cursor: grab;
      }
      .lq-action__head:active { cursor: grabbing; }
      .lq-action__step {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px;
        background: color-mix(in srgb, var(--g-primary) 16%, transparent);
        color: var(--g-primary);
        border-radius: 50%;
        font-size: 10px; font-weight: 800;
      }
      .lq-action__handle {
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 80%, transparent);
        font-size: 14px;
        line-height: 1;
        user-select: none;
      }
      .lq-action__icon { font-size: 16px; }
      .lq-action__skip-hint {
        font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 100%, transparent);
        font-style: italic;
      }
      .lq-action__body {
        padding: 4px 14px 14px 14px;
        border-top: 1px dashed color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .lq-branch {
        padding: 2px 8px;
        font-size: 9px; font-weight: 800; letter-spacing: 0.12em;
        text-transform: uppercase;
        border-radius: 99px;
        cursor: pointer;
        background: transparent;
        border: 1px solid currentColor;
        font-family: inherit;
      }
      .lq-branch--qualified { color: #34d399; background: rgba(16, 185, 129, 0.08); }
      .lq-branch--unqualified { color: #ff8a8a; background: rgba(239, 68, 68, 0.08); }
      .lq-branch--both {
        color: color-mix(in srgb, var(--g-primary) 100%, transparent);
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      }

      /* Action add chips */
      .lq-action-add { display: flex; flex-direction: column; gap: 6px; }
      .lq-action-add__chips {
        display: flex; flex-wrap: wrap; gap: 6px;
      }
      .lq-chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 12px;
        font-family: inherit; font-size: 11px; font-weight: 600;
        background: color-mix(in srgb, var(--glass-base) 25%, transparent);
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 99px;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      }
      .lq-chip:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        transform: translateY(-1px);
      }
      .lq-chip__icon { font-size: 12px; }

      /* Side tabs */
      .lq-side-tabs {
        display: inline-flex; gap: 4px; padding: 4px;
        background: color-mix(in srgb, var(--glass-base) 35%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
        border-radius: 8px;
        align-self: flex-start;
      }
      .lq-side-tab {
        padding: 6px 14px;
        font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
        background: transparent;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
        border: none; border-radius: 6px; cursor: pointer; font-family: inherit;
      }
      .lq-side-tab.is-active {
        background: color-mix(in srgb, var(--g-primary) 18%, transparent);
        color: var(--g-primary);
      }

      /* Preview pane */
      .lq-preview-criteria,
      .lq-preview-flow,
      .lq-preview-email { margin-bottom: 12px; }
      .lq-preview-criteria__row,
      .lq-preview-flow__row {
        display: grid;
        grid-template-columns: 26px auto 1fr auto;
        gap: 8px; align-items: center;
        padding: 5px 8px;
        font-size: 11px;
        border-radius: 6px;
        margin-bottom: 4px;
      }
      .lq-preview-criteria__row.is-pass {
        background: rgba(16, 185, 129, 0.08);
        border: 1px solid rgba(16, 185, 129, 0.22);
      }
      .lq-preview-criteria__row.is-fail {
        background: rgba(239, 68, 68, 0.06);
        border: 1px solid rgba(239, 68, 68, 0.22);
      }
      .lq-preview-criteria__icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px;
        font-size: 13px; font-weight: 800; border-radius: 50%;
      }
      .is-pass .lq-preview-criteria__icon { color: #34d399; background: rgba(16, 185, 129, 0.18); }
      .is-fail .lq-preview-criteria__icon { color: #ff8a8a; background: rgba(239, 68, 68, 0.18); }
      .lq-preview-criteria__label {
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .lq-preview-flow__row {
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      }
      .lq-preview-flow__row.is-skipped {
        opacity: 0.55;
        background: color-mix(in srgb, var(--glass-base) 18%, transparent);
        border-style: dashed;
      }
      .lq-preview-flow__step {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px;
        font-size: 10px; font-weight: 800;
        background: color-mix(in srgb, var(--g-primary) 16%, transparent);
        color: var(--g-primary);
        border-radius: 50%;
      }
      .lq-preview-flow__icon { font-size: 14px; }
      .lq-preview-flow__label {
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }
      .lq-preview-flow__state {
        font-size: 9px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
        color: color-mix(in srgb, var(--g-fg-faint, color-mix(in srgb, var(--glass-gold) 62%, transparent)) 100%, transparent);
      }
      .is-skipped .lq-preview-flow__state { color: #ff8a8a; }
      .lq-preview-iframe {
        width: 100%; height: 360px;
        background: var(--glass-fg);
        border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
        border-radius: 8px;
      }

      /* Templates */
      .lq-template-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }
      .lq-template {
        position: relative;
        display: grid; grid-template-columns: 36px 1fr; gap: 10px; align-items: center;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 8px;
        text-align: left; cursor: pointer; font-family: inherit; color: inherit;
        transition: all 0.15s ease;
      }
      .lq-template:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
        transform: translateX(2px);
      }
      .lq-template.is-active {
        border-color: var(--g-primary);
        box-shadow: 0 0 0 1px var(--g-primary), 0 0 22px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-template__swatch {
        width: 36px; height: 36px;
        border-radius: 6px;
        border: 1px solid color-mix(in srgb, var(--glass-fg) 8%, transparent);
      }
      .lq-template__name {
        font-size: 13px; font-weight: 700;
        color: var(--g-primary);
      }
      .lq-template__desc {
        font-size: 10px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 95%, transparent);
        margin-top: 2px;
        line-height: 1.4;
      }
      .lq-template__active-tag {
        position: absolute; top: 8px; right: 8px;
        font-size: 8px; font-weight: 800; letter-spacing: 0.14em;
        text-transform: uppercase;
        padding: 2px 6px;
        background: rgba(16, 185, 129, 0.18);
        color: #34d399;
        border-radius: 99px;
      }

      /* Project card */
      .lq-project-card {
        margin-top: 8px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 8px;
      }
      .lq-project-card__name {
        font-size: 13px; font-weight: 700; color: var(--g-primary);
      }
      .lq-project-card__hint {
        margin-top: 2px; font-size: 11px;
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
      }

      /* Project picker trigger button (used in side pane + link-to-project step) */
      .lq-project-trigger {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--g-fg, var(--glass-fg)) 4%, transparent);
        border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 12%, transparent));
        border-radius: 10px;
        color: var(--g-fg, var(--glass-fg));
        font: inherit;
        cursor: pointer;
        text-align: left;
        transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .lq-project-trigger:hover {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      .lq-project-trigger:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-project-trigger.is-linked {
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .lq-project-trigger__swatch {
        flex-shrink: 0;
        width: 14px; height: 14px;
        border-radius: 4px;
        background: var(--g-primary);
        box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .lq-project-trigger__main {
        flex: 1;
        min-width: 0;
        display: flex; flex-direction: column; gap: 2px;
      }
      .lq-project-trigger__name {
        font-size: 13px; font-weight: 600;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .lq-project-trigger__name--empty {
        color: var(--g-fg-faint, var(--glass-fg-2));
        font-weight: 500;
      }
      .lq-project-trigger__sub {
        font-size: 11px;
        color: var(--g-fg-faint, var(--glass-fg-3));
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .lq-project-trigger__caret {
        flex-shrink: 0;
        font-size: 16px;
        color: var(--g-fg-faint, var(--glass-fg-2));
      }
      .lq-project-trigger:hover .lq-project-trigger__caret { color: var(--g-primary); }
      .lq-project-actions {
        display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;
      }

      /* Modal: backdrop + dialog shell */
      .lq-modal-backdrop {
        position: fixed; inset: 0;
        background: color-mix(in srgb, var(--glass-base) 55%, transparent);
        backdrop-filter: blur(3px);
        z-index: 1199;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.22s ease;
      }
      .lq-modal-backdrop.is-open { opacity: 1; pointer-events: auto; }

      .lq-modal {
        position: fixed; top: 50%; left: 50%;
        transform: translate(-50%, -50%) scale(0.96);
        width: min(540px, 92vw);
        max-height: 80vh;
        z-index: 1200;
        display: none; flex-direction: column;
        background: linear-gradient(var(--g-glass-tint, transparent), var(--g-glass-tint, transparent)),
          var(--g-gradient-surface, linear-gradient(155deg, color-mix(in srgb, var(--glass-fg) 6%, transparent), color-mix(in srgb, var(--glass-base) 4%, transparent)));
        border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 12%, transparent));
        border-radius: 16px;
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        box-shadow: 0 36px 96px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.08);
        opacity: 0;
        transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
        overflow: hidden;
      }
      .lq-modal.is-open {
        display: flex;
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
      .lq-modal__head {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      }
      .lq-modal__title {
        margin: 0; font-size: 15px; font-weight: 700; color: var(--g-fg, var(--glass-fg));
      }
      .lq-modal__sub {
        margin: 4px 0 0; font-size: 12px;
        color: var(--g-fg-faint, var(--glass-fg-2));
      }
      .lq-modal__close {
        background: none; border: none; cursor: pointer;
        font-size: 16px; padding: 4px 8px;
        color: var(--g-fg-dim, var(--glass-fg-2));
        border-radius: 6px;
      }
      .lq-modal__close:hover {
        background: color-mix(in srgb, var(--g-fg, var(--glass-fg)) 8%, transparent);
        color: var(--g-fg, var(--glass-fg));
      }

      .lq-modal__search {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 18px;
        border-bottom: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      }
      .lq-modal__search-icon {
        font-size: 14px;
        color: var(--g-fg-faint, var(--glass-fg-2));
      }
      .lq-modal__search-input {
        flex: 1; min-width: 0;
        background: transparent;
        border: none; outline: none;
        color: var(--g-fg, var(--glass-fg));
        font: inherit;
        font-size: 13px;
      }
      .lq-modal__search-input::placeholder { color: var(--g-fg-faint, var(--glass-fg-3)); }
      .lq-modal__count {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        color: var(--g-primary);
        white-space: nowrap;
      }

      .lq-modal__body {
        flex: 1; min-height: 0;
        overflow-y: auto;
        padding: 8px;
        display: flex; flex-direction: column; gap: 4px;
      }
      .lq-modal__empty {
        padding: 32px 18px;
        text-align: center;
        color: var(--g-fg-faint, var(--glass-fg-3));
        font-size: 13px;
      }
      .lq-modal__empty-icon {
        font-size: 28px;
        margin-bottom: 10px;
      }
      .lq-modal__foot {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 18px;
        border-top: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      }
      .lq-modal__hint {
        font-size: 11px;
        color: var(--g-fg-faint, var(--glass-fg-3));
      }

      /* Project row inside the modal */
      .lq-project-row {
        display: flex; align-items: flex-start; gap: 10px;
        width: 100%;
        padding: 10px 12px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        color: var(--g-fg, var(--glass-fg));
        cursor: pointer;
        font: inherit;
        text-align: left;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .lq-project-row:hover {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
      }
      .lq-project-row.is-selected {
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .lq-project-row__swatch {
        flex-shrink: 0;
        width: 12px; height: 12px;
        margin-top: 3px;
        border-radius: 3px;
        background: var(--g-primary);
        box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .lq-project-row__main {
        flex: 1; min-width: 0;
        display: flex; flex-direction: column; gap: 2px;
      }
      .lq-project-row__name {
        font-size: 13px; font-weight: 600;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .lq-project-row__sub {
        font-size: 11px;
        color: var(--g-fg-faint, var(--glass-fg-2));
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .lq-project-row__desc {
        font-size: 11px;
        color: var(--g-fg-dim, var(--glass-fg-2));
        margin-top: 3px;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .lq-project-row__check {
        flex-shrink: 0;
        font-size: 14px;
        font-weight: 700;
        color: var(--g-primary);
      }

      /* Test runner */
      .lq-test-actions {
        display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
      }

      /* Recent runs */
      .lq-runs { display: flex; flex-direction: column; gap: 4px; }
      .lq-run {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 8px; align-items: center;
        padding: 6px 10px;
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-radius: 5px;
        font-size: 11px;
      }
      .lq-run__badge {
        display: inline-flex; align-items: center;
        padding: 1px 8px;
        font-size: 9px; font-weight: 800; letter-spacing: 0.12em;
        text-transform: uppercase;
        border-radius: 99px;
      }
      .lq-run--qualified .lq-run__badge { background: rgba(16, 185, 129, 0.18); color: #34d399; }
      .lq-run--unqualified .lq-run__badge { background: rgba(239, 68, 68, 0.18); color: #ff8a8a; }
      .lq-run--error .lq-run__badge { background: color-mix(in srgb, var(--glass-gold) 18%, transparent); color: var(--glass-gold); }
      .lq-run__time {
        color: color-mix(in srgb, var(--g-fg-mute, color-mix(in srgb, var(--glass-gold) 40%, transparent)) 100%, transparent);
        font-variant-numeric: tabular-nums;
      }
      .lq-run__note {
        color: color-mix(in srgb, var(--g-fg-dim, color-mix(in srgb, var(--glass-gold) 80%, transparent)) 100%, transparent);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      @media (max-width: 720px) {
        .lq-page {
          padding: 10px 0 44px;
        }
        .lq-header {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 14px;
          padding: 16px;
        }
        .lq-header__main,
        .lq-header__right {
          width: 100%;
        }
        .lq-header__title-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 6px 9px;
        }
        .lq-header__title-row h1 {
          font-size: 20px;
          white-space: nowrap;
        }
        .lq-header__pipe-name {
          grid-column: 2;
          justify-self: start;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .lq-header__chips {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 7px;
        }
        .lq-chip-readonly {
          min-width: 0;
          justify-content: space-between;
          border-radius: 10px;
          padding: 7px 10px;
        }
        .lq-chip-readonly--pick {
          grid-column: 1 / -1;
        }
        .lq-chip-readonly strong {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .lq-header__right {
          justify-content: flex-end;
          padding-top: 12px;
          border-top: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        }
        .lq-header__right .lq-btn {
          flex: 1;
        }
        .lq-card {
          padding: 14px;
        }
      }
    </style>
  `;
}
