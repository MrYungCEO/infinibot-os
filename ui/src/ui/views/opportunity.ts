/**
 * Opportunity Pipeline view (Business Control Layer — Object 2).
 *
 * A drag-and-drop pipeline board (one column per stage: New → … → Negotiation
 * → Won/Lost/Hold) plus a full-field create/edit modal. Black & gold
 * glassmorphism to match the issues / notes / kanban surfaces. State + data
 * live in controllers/opportunity.ts; this module is presentation only.
 *
 * §24: moving a card into "Won" does NOT create a project — it opens a
 * "Create Project?" prompt that only links a project once a human supplies the
 * projectId (routed through opportunity.convert).
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { renderRelatedPanel } from "../components/related-panel";
import { ensureCovers, monogramFor, renderCoverThumb } from "../components/object-cover";
import { priorityTone, renderOpportunityFocus, stageTone } from "./opportunity-focus";
import { renderObjectReports } from "../components/report-associations";
import {
  OPPORTUNITY_TYPES,
  PIPELINE_STAGES,
  REVENUE_TYPES,
  PRIORITIES,
  PRIORITY_LABELS,
  opportunityState as state,
  loadOpportunities,
  openCreate,
  openEdit,
  openFocus,
  focusedOpportunity,
  closeModal,
  setDraft,
  saveOpportunity,
  deleteOpportunity,
  moveStage,
  dismissConvert,
  convertToProject,
  opportunitiesByStage,
  stageValue,
  type Opportunity,
  type OpportunityDraft,
} from "../controllers/opportunity";
import { icon } from "./kis-shared";
import { wgAurora, wgEmpty, wgHero, wgStat } from "./work-glass";
import { wgkField, wgkModal, wgkSection, wgkSelect } from "./work-glass/kis-form";
import "./work-glass/opportunity.css";


function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

function fmtMoney(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return `$${v.toLocaleString()}`;
}

/** Small inline glyphs the KIS icon set doesn't carry. */
const editGlyph = html`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.8 2.6l2.6 2.6L6 12.6l-3.2.6.6-3.2z" /></svg>`;
const flagGlyph = html`<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 14V2.5M3.5 3h8l-1.6 3 1.6 3h-8" /></svg>`;

// ── Modal field helpers ──
function textField(
  app: AppViewState,
  label: string,
  key: keyof OpportunityDraft,
  opts: { area?: boolean; type?: string; placeholder?: string; span?: boolean } = {},
) {
  const val = (state.draft[key] as string | number | undefined) ?? "";
  const onInput = (raw: string) => {
    const value = opts.type === "number" ? (Number(raw) || 0) : raw;
    setDraft(app, key, value as OpportunityDraft[typeof key]);
  };
  return wgkField(label, val, onInput, opts);
}

function selectField(
  app: AppViewState,
  label: string,
  key: keyof OpportunityDraft,
  options: readonly string[],
  labels?: Record<string, string>,
) {
  const val = (state.draft[key] as string) ?? "";
  return wgkSelect(label, val, options, (v) => setDraft(app, key, v as OpportunityDraft[typeof key]), { labels });
}

const DATA_QUALITIES = ["Verified", "FounderReported", "OperationsEstimated", "Unknown"];

// ── Modal ──
function renderModal(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.modalOpen) return nothing;
  const isEdit = Boolean(state.editingId);
  return wgkModal({
    eyebrow: "Pipeline · Opportunity",
    title: isEdit ? "Edit Opportunity" : "New Opportunity",
    onClose: () => closeModal(app),
    width: 880,
    error: state.error,
    body: html`
      ${wgkSection("Identification")}
      ${textField(app, "Opportunity Name *", "name", { placeholder: "Short recognizable name" })}
      ${selectField(app, "Type", "opportunityType", OPPORTUNITY_TYPES)}
      ${textField(app, "Owner * 🔗", "owner", { placeholder: "One accountable owner" })}
      ${textField(app, "Supporting Owner 🔗", "supportingOwner")}
      ${selectField(app, "Pipeline Stage", "stage", PIPELINE_STAGES)}
      ${selectField(app, "Priority", "priority", PRIORITIES, PRIORITY_LABELS)}

      ${wgkSection("Substance")}
      ${textField(app, "Problem / Need", "problemNeed", { area: true, placeholder: "What is the customer trying to solve?", span: true })}
      ${textField(app, "Proposed Solution 🔗", "proposedSolution", { area: true, placeholder: "Product / solution being considered", span: true })}
      ${textField(app, "Estimated Value ($)", "estimatedValue", { type: "number", placeholder: "0" })}
      ${selectField(app, "Revenue Type", "revenueType", REVENUE_TYPES)}
      ${textField(app, "Opportunity Score", "opportunityScore", { type: "number", placeholder: "scoring SOP result" })}
      ${textField(app, "Expected Close Date", "expectedCloseDate", { type: "date" })}

      ${wgkSection("Next Action (§28 — Next Action + Owner + Date, or Waiting For + Review Date)")}
      ${textField(app, "Next Action", "nextAction", { placeholder: "Specific next sales/eval step" })}
      ${textField(app, "Next Action Owner 🔗", "nextActionOwner")}
      ${textField(app, "Next Action Date", "nextActionDate", { type: "date" })}
      ${textField(app, "Waiting For", "waitingFor", { placeholder: "…if not an action" })}
      ${textField(app, "Review Date", "reviewDate", { type: "date" })}

      ${wgkSection("Links & Context")}
      ${textField(app, "Client / Company ID 🔗", "clientId", { placeholder: "linked client record id" })}
      ${textField(app, "Product ID 🔗", "productId", { placeholder: "linked product record id" })}
      ${textField(app, "Proposal / Commercial Doc Link", "proposalLink", { placeholder: "https://…", span: true })}
      ${textField(app, "Notes", "notes", { area: true, span: true })}
      ${selectField(app, "Data Quality (§35)", "dataQuality", DATA_QUALITIES)}

      ${isEdit ? html`<div class="wgk-span">${renderRelatedPanel(app, client, "opportunity", state.editingId!, { title: "Related — Client · Product · Project" })}</div>` : nothing}
      ${isEdit ? html`<div class="wgk-span">${renderObjectReports(app, client, "opportunity", state.editingId!, { title: "Reports — documents this opportunity" })}</div>` : nothing}
    `,
    foot: html`
      ${isEdit
        ? html`<button class="wgk-btn wgk-btn--danger" @click=${() => deleteOpportunity(app, client, state.editingId!)}>
            ${icon("trash", 13)}<span>Delete</span>
          </button>`
        : nothing}
      <div class="wgk-modal__foot-end">
        <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
        <button class="wgk-btn wgk-btn--primary" ?disabled=${state.saving} @click=${() => saveOpportunity(app, client)}>
          ${state.saving ? "Saving…" : isEdit ? "Save Changes" : "Create Opportunity"}
        </button>
      </div>
    `,
  });
}

// ── §24 "Create Project?" prompt ──
function renderConvertPrompt(app: AppViewState, client: GatewayBrowserClient) {
  const opp = state.convertFor;
  if (!opp) return nothing;
  const ready = Boolean(state.convertProjectId.trim());
  return wgkModal({
    eyebrow: "§24 · Human-gated",
    title: "Create Project?",
    onClose: () => dismissConvert(app),
    width: 480,
    center: true,
    stack: true,
    body: html`
      <p class="wgo-convert-copy">
        “<strong>${opp.name}</strong>” was marked <strong class="wgo-won">Won</strong>. A won opportunity is not turned into
        a project automatically (human-gated). Paste the approved project id to link it, or dismiss to decide later.
      </p>
      <input
        class="wgk-input"
        aria-label="Approved project id"
        placeholder="approved project id…"
        .value=${state.convertProjectId}
        @input=${(e: Event) => { state.convertProjectId = (e.target as HTMLInputElement).value; rerender(app); }}
      />
    `,
    foot: html`
      <div class="wgk-modal__foot-end">
        <button class="wgk-btn" @click=${() => dismissConvert(app)}>Decide Later</button>
        <button
          class="wgk-btn wgk-btn--primary"
          ?disabled=${state.converting || !ready}
          @click=${() => convertToProject(app, client)}
        >${state.converting ? "Linking…" : "Link Project"}</button>
      </div>
    `,
  });
}

// ── Card ──
function renderCard(app: AppViewState, client: GatewayBrowserClient, opp: Opportunity) {
  // Monogram for the placeholder when the opportunity has no cover yet.
  const monogram = monogramFor(opp.name);
  const prio = String(opp.priority).toUpperCase();
  return html`
    <div
      class="wgo-deal ${state.dragId === opp.id ? "is-dragging" : ""}"
      draggable="true"
      role="button"
      tabindex="0"
      aria-label=${`${opp.name || "Untitled opportunity"} — ${fmtMoney(opp.estimatedValue)}, ${opp.stage}`}
      style="--prio:${priorityTone(opp.priority)}"
      @dragstart=${() => { state.dragId = opp.id; }}
      @dragend=${() => { state.dragId = null; state.dragOverStage = null; rerender(app); }}
      @click=${() => openFocus(app, opp.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openFocus(app, opp.id);
        }
      }}
    >
      <div class="wgo-deal__cover">
        ${renderCoverThumb(app, client, "opportunity", opp.id, {
          height: 74,
          seed: opp.id || opp.name,
          monogram,
          radius: "0",
        })}
      </div>
      <div class="wgo-deal__body">
        <div class="wgo-deal__head">
          <span class="wgo-deal__name">${opp.name || "(untitled)"}</span>
          <div class="wgo-deal__tools">
            ${opp.ceoRequired ? html`<span class="wgo-ceo" title="CEO required">${icon("star", 11)}</span>` : nothing}
            <button
              class="wgo-iconbtn"
              title="Edit fields"
              aria-label="Edit fields"
              @click=${(e: Event) => { e.stopPropagation(); openEdit(app, opp); }}
            >${editGlyph}</button>
          </div>
        </div>
        <div class="wgo-deal__meta">
          <span class="wgo-deal__val">${fmtMoney(opp.estimatedValue)}</span>
          ${opp.opportunityScore ? html`<span class="wgo-deal__score" title="Opportunity score">◆ ${opp.opportunityScore}</span>` : nothing}
          <span class="wgo-pchip" style="--tone:${priorityTone(opp.priority)}">${PRIORITY_LABELS[prio] ?? opp.priority}</span>
          ${opp.opportunityType ? html`<span class="wgo-deal__type">${opp.opportunityType}</span>` : nothing}
        </div>
        <div class="wgo-deal__foot">
          <span class="wgo-deal__owner">
            ${opp.owner
              ? html`<span class="wgo-av" aria-hidden="true">${monogramFor(opp.owner).slice(0, 2)}</span>${opp.owner}`
              : html`<span class="wgo-warn-text">no owner</span>`}
          </span>
          <div class="wgo-deal__flags">
            ${opp.needsAction ? html`<span class="wgo-flag wgo-flag--warn" title="Needs a next action (§28)">${flagGlyph}action</span>` : nothing}
            ${opp.stale ? html`<span class="wgo-flag wgo-flag--danger" title="Stale — not updated in 7 days (§29)">${icon("clock", 10)}stale</span>` : nothing}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Column ──
function renderColumn(app: AppViewState, client: GatewayBrowserClient, stage: string, list: Opportunity[]) {
  const isOver = state.dragOverStage === stage;
  return html`
    <div
      class="wgo-col ${isOver ? "is-over" : ""}"
      style="--stage:${stageTone(stage)}"
      @dragover=${(e: DragEvent) => { e.preventDefault(); if (state.dragOverStage !== stage) { state.dragOverStage = stage; rerender(app); } }}
      @dragleave=${() => { if (state.dragOverStage === stage) { state.dragOverStage = null; rerender(app); } }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        const id = state.dragId;
        state.dragOverStage = null;
        state.dragId = null;
        const opp = state.opportunities.find((o) => o.id === id);
        if (opp) void moveStage(app, client, opp, stage);
      }}
    >
      <div class="wgo-col__head">
        <div class="wgo-col__title">
          <span class="wgo-dot"></span>
          <span>${stage}</span>
          <span class="wgo-col__count">${list.length}</span>
        </div>
        ${list.length ? html`<span class="wgo-col__sum">${fmtMoney(stageValue(list))}</span>` : nothing}
      </div>
      <div class="wgo-col__body">
        ${list.length === 0
          ? html`<div class="wgo-col__empty">Drop a deal here</div>`
          : list.map((o) => renderCard(app, client, o))}
      </div>
    </div>
  `;
}

// ── Main render ──
export function renderOpportunity(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.loaded && !state.loading) {
    void loadOpportunities(app, client);
  }

  // One batch call resolves every card thumbnail on the board.
  if (state.opportunities.length) {
    ensureCovers(app, client, "opportunity", state.opportunities.map((o) => o.id));
  }

  // Focus page takes over the surface when an opportunity is selected. The
  // edit modal still renders on top of it so "Edit" works from either place.
  const focused = focusedOpportunity();
  if (focused) {
    return html`
      <div class="wg-page wg-kis wg-opp wg-opp--focus">
        ${wgAurora()}
        ${renderOpportunityFocus(app, client, focused)}
        ${renderModal(app, client)}
        ${renderConvertPrompt(app, client)}
      </div>
    `;
  }

  const byStage = opportunitiesByStage();
  const totalValue = stageValue(state.opportunities);
  const openList = state.opportunities.filter((o) => !["Won", "Lost", "Hold"].includes(o.stage));
  const openValue = stageValue(openList);
  const wonValue = stageValue(state.opportunities.filter((o) => o.stage === "Won"));
  const needsAction = state.opportunities.filter((o) => o.needsAction || o.stale).length;

  return html`
    <div class="wg-page wg-kis wg-opp">
      ${wgAurora()}
      ${wgHero({
        eyebrow: "Business · Pipeline",
        title: html`Opportunity <span class="wg-gold">Pipeline</span>`,
        sub: "Potential business before it becomes confirmed work — score, qualify & follow up.",
        actions: html`<button class="wgk-btn wgk-btn--primary" data-learn-id="opportunity-new" @click=${() => openCreate(app)}>
          ${icon("plus", 13)}<span>New Opportunity</span>
        </button>`,
      })}

      <div class="wg-stats wgo-stats">
        ${wgStat("Opportunities", state.opportunities.length, `${openList.length} still open`)}
        ${wgStat("Open pipeline", fmtMoney(openValue), "excludes won · lost · hold")}
        ${wgStat("Won", fmtMoney(wonValue), "closed revenue")}
        ${wgStat("Total value", fmtMoney(totalValue), "every stage")}
        ${wgStat("Needs attention", needsAction, "no next action or stale")}
      </div>

      <!-- Filters -->
      <div class="wgo-filters" role="search">
        <label class="wgo-search">
          ${icon("search", 13)}
          <input
            type="search"
            aria-label="Search opportunities"
            placeholder="Search name / problem / solution / notes…"
            .value=${state.search}
            @input=${(e: Event) => { state.search = (e.target as HTMLInputElement).value; }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void loadOpportunities(app, client); }}
          />
        </label>
        <select
          class="wgk-input wgo-type"
          aria-label="Filter by type"
          .value=${state.filterType}
          @change=${(e: Event) => { state.filterType = (e.target as HTMLSelectElement).value; void loadOpportunities(app, client); }}
        >
          <option value="">All types</option>
          ${OPPORTUNITY_TYPES.map((t) => html`<option value=${t} ?selected=${t === state.filterType}>${t}</option>`)}
        </select>
      </div>

      ${state.error ? html`<div class="wgk-err wgo-err" role="alert">${state.error}</div>` : nothing}

      <!-- Board -->
      ${state.loading && !state.loaded
        ? html`<div class="wgo-board" aria-busy="true">
            ${PIPELINE_STAGES.slice(0, 6).map(() => html`<div class="wgo-col wgo-col--skel"><div class="wg-skel" style="height:14px;width:60%"></div><div class="wg-skel" style="height:120px"></div><div class="wg-skel" style="height:120px"></div></div>`)}
          </div>`
        : state.opportunities.length === 0 && !state.search && !state.filterType
          ? html`<div class="wg-surface wgo-empty">
              ${wgEmpty({
                icon: icon("coins", 24),
                title: "Your pipeline is empty",
                body: "Capture each potential deal with one accountable owner, an estimated value and a next action — then drag it across the stages as it qualifies.",
                action: html`<button class="wgk-btn wgk-btn--primary" @click=${() => openCreate(app)}>${icon("plus", 13)}<span>Add the first opportunity</span></button>`,
              })}
            </div>`
          : state.opportunities.length === 0
            ? html`<div class="wg-surface wgo-empty">
                ${wgEmpty({
                  icon: icon("search", 24),
                  title: "No matching opportunities",
                  body: "Nothing matches the current search and type filter. Clear the filters to return to the full pipeline.",
                  action: html`<button
                    class="wgk-btn wgk-btn--primary"
                    @click=${() => {
                      state.search = "";
                      state.filterType = "";
                      void loadOpportunities(app, client);
                    }}
                  >Clear filters</button>`,
                })}
              </div>`
          : html`<div class="wgo-board">
              ${PIPELINE_STAGES.map((stage) => renderColumn(app, client, stage, byStage[stage] ?? []))}
            </div>`}

      ${renderModal(app, client)}
      ${renderConvertPrompt(app, client)}
    </div>
  `;
}
