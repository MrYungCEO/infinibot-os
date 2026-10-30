/**
 * Risk Register (Object 7) view.
 *
 * A Risk Register table with a live Probability × Impact score heatmap and a
 * full-field create/edit modal. Self-contained render layer; all state, data
 * loading and CRUD live in `../controllers/risk`. Talks to the gateway `risk.*`
 * RPCs via the shared browser client. Black & gold glassmorphism to match the
 * issues / notes / kanban surfaces.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  state,
  loadRisks,
  openCreate,
  openEdit,
  closeModal,
  saveRisk,
  deleteRisk,
  set,
  computeScore,
  scoreColor,
  statusColor,
  riskBand,
  isReviewOverdue,
  RISK_CATEGORIES,
  RISK_STATUSES,
  RISK_PRIORITIES,
  MATRIX_SCALE,
  type Risk,
  type RiskDraft,
} from "../controllers/risk";
import {
  KIS_STYLE,
  bulkBar,
  chip,
  createFeedback,
  createSelection,
  createSort,
  emptyState,
  errorBanner,
  filterChip,
  filterGroup,
  ghostButton,
  icon,
  primaryButton,
  scoreChip,
  selectBox,
  skeletonRows,
  sortBy,
  sortHeader,
  stagger,
  statCard,
  statStrip,
  statusChip,
  statusLine,
  tableShell,
  toolbar,
  type Tone,
} from "./kis-shared";
import { wgAurora, wgHero } from "./work-glass";
import { wgkField, wgkModal, wgkSection, wgkSelect } from "./work-glass/kis-form";

// ── Page-level UI state the controller doesn't persist ──────────────────────
const sel = createSelection();
const sort = createSort("riskScore", "desc");
const fb = createFeedback();

const RISK_STATUS_TONES: Record<string, Tone> = {
  Open: "danger",
  Monitoring: "warn",
  Mitigated: "ok",
  Closed: "muted",
};

const COLS = "26px 2.5fr 1fr 62px 1fr 1.1fr 1fr";


// ── Field builders ──
function textField(
  app: AppViewState,
  label: string,
  key: keyof RiskDraft,
  opts: { area?: boolean; type?: string; placeholder?: string; span?: boolean } = {},
) {
  const val = (state.draft[key] as string) ?? "";
  return wgkField(label, val, (v) => set(app, key, v as RiskDraft[typeof key]), opts);
}

function selectField(app: AppViewState, label: string, key: keyof RiskDraft, options: string[]) {
  const val = (state.draft[key] as string) ?? "";
  return wgkSelect(label, val, options, (v) => set(app, key, v as RiskDraft[typeof key]));
}

function scaleField(app: AppViewState, label: string, key: "probability" | "impact") {
  const val = Number(state.draft[key] ?? 3);
  return html`
    <div class="wgk-field" role="group" aria-label=${`${label} (1–5)`}>
      <span class="wgk-label">${label} (1–5)</span>
      <div class="wgk-scale">
        ${MATRIX_SCALE.map(
          (n) => html`<button type="button" aria-pressed=${String(n === val)} @click=${() => set(app, key, n)}>${n}</button>`,
        )}
      </div>
    </div>
  `;
}

// ── Live score badge for the modal ──
function liveScoreBadge() {
  const score = computeScore(state.draft.probability, state.draft.impact);
  const band = riskBand(score);
  const col = scoreColor(score);
  return html`
    <div class="wgk-score" style="--tone:${col}">
      <div class="wgk-score__n">${score}<small>/25</small></div>
      <div>
        <div class="wgk-score__band">${band} Risk</div>
        <div class="wgk-score__hint">Risk Score = Probability × Impact (computed automatically)</div>
      </div>
    </div>
  `;
}

// ── Modal ──
function renderModal(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.modalOpen) return nothing;
  const isEdit = Boolean(state.editingId);
  return wgkModal({
    eyebrow: "Governance · Risk",
    title: isEdit ? "Edit Risk" : "Log New Risk",
    onClose: () => closeModal(app),
    width: 880,
    error: state.error,
    body: html`
      ${wgkSection("Identification")}
      ${textField(app, "Risk Title *", "title", { placeholder: "What could go wrong?" })}
      ${selectField(app, "Category", "category", RISK_CATEGORIES)}
      ${textField(app, "Owner *", "owner", { placeholder: "Single accountable owner (§27)" })}
      ${textField(app, "Supporting Owner", "supportingOwner")}

      ${wgkSection("Scoring")}
      ${scaleField(app, "Probability", "probability")}
      ${scaleField(app, "Impact", "impact")}
      ${liveScoreBadge()}

      ${wgkSection("Response")}
      ${textField(app, "Mitigation", "mitigation", { area: true, placeholder: "How is this risk being reduced / handled?", span: true })}
      ${selectField(app, "Status", "status", RISK_STATUSES)}
      ${selectField(app, "Priority", "priority", RISK_PRIORITIES)}
      ${textField(app, "Next Review Date", "nextReviewDate", { type: "date" })}

      ${wgkSection("Connections")}
      ${textField(app, "Client ID 🔗", "clientId", { placeholder: "optional" })}
      ${textField(app, "Opportunity ID 🔗", "opportunityId", { placeholder: "optional" })}
      ${textField(app, "Project ID 🔗", "projectId", { placeholder: "optional" })}
      ${textField(app, "Product ID 🔗", "productId", { placeholder: "optional" })}
      ${textField(app, "System Issue ID 🔗", "issueId", { placeholder: "optional" })}
      ${textField(app, "Decision ID 🔗", "decisionId", { placeholder: "optional" })}
    `,
    foot: html`
      ${isEdit
        ? html`<button class="wgk-btn wgk-btn--danger" @click=${() => deleteRisk(app, client, state.editingId!)}>
            ${icon("trash", 13)}<span>Delete</span>
          </button>`
        : nothing}
      <div class="wgk-modal__foot-end">
        <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
        <button class="wgk-btn wgk-btn--primary" ?disabled=${state.saving} @click=${() => saveRisk(app, client)}>
          ${state.saving ? "Saving…" : isEdit ? "Save Changes" : "Log Risk"}
        </button>
      </div>
    `,
  });
}

// ── Score heatmap (5×5 Probability × Impact matrix) ──
function renderHeatmap(app: AppViewState) {
  // Bucket risks by (probability, impact) cell.
  const counts = new Map<string, number>();
  for (const r of state.risks) {
    const key = `${r.probability}:${r.impact}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cell = (p: number, i: number) => {
    const score = p * i;
    const col = scoreColor(score);
    const n = counts.get(`${p}:${i}`) ?? 0;
    return html`<button
      class="risk-cell ${n > 0 ? "is-hot" : ""}"
      title=${`Probability ${p} × Impact ${i} = score ${score} · ${n} risk${n === 1 ? "" : "s"}`}
      aria-label=${`Probability ${p}, impact ${i}, score ${score}, ${n} risks. Filter to these.`}
      @click=${() => {
        // Clicking a hot cell narrows the register to that score band.
        if (!n) return;
        state.criticalOnly = score >= 12;
        state.search = "";
        void loadRisks(app, client0!);
      }}
      style="--cell:${col}; background:${col}${n > 0 ? "33" : "14"}; border-color:${col}${n > 0 ? "80" : "3a"}; color:${n > 0 ? col : "var(--fg-muted)"};"
    >${n > 0 ? n : ""}</button>`;
  };
  // Rows = Impact 5→1 (top = highest impact); Cols = Probability 1→5.
  const rows = [...MATRIX_SCALE].reverse();
  return html`
    <aside class="risk-heat kis-panel" aria-label="Probability by impact score heatmap">
      <div class="kis-panel-head">
        <div class="kis-panel-headmain">${icon("scale", 12)}<h2>Score heatmap</h2></div>
        <span class="kis-panel-count kis-panel-count--gold">${state.risks.length}</span>
      </div>
      <div class="kis-panel-body kis-panel-body--pad risk-heat-body">
        <span class="risk-heat-yaxis">Impact →</span>
        <div class="risk-heat-grid-wrap">
          <div class="risk-heat-grid">${rows.map((i) => MATRIX_SCALE.map((p) => cell(p, i)))}</div>
          <div class="risk-heat-xaxis">Probability →</div>
        </div>
      </div>
      <div class="risk-heat-legend">
        <span><i style="background:#4ade80"></i>1–5 low</span>
        <span><i style="background:#fbbf24"></i>6–11 med</span>
        <span><i style="background:#fb923c"></i>12–14 high</span>
        <span><i style="background:#f87171"></i>15+ critical</span>
      </div>
    </aside>
  `;
}

// The heatmap needs a client to re-query when a cell is used as a filter; the
// render root stashes the live one so the aside stays a pure function of state.
let client0: GatewayBrowserClient | null = null;

// ── Row ──────────────────────────────────────────────────────────────────────
function renderRow(app: AppViewState, r: Risk, index: number) {
  const overdue = isReviewOverdue(r);
  const selected = sel.has(r.id);
  const review = r.nextReviewDate || "—";
  return html`
    <div
      class="kis-tr ${selected ? "is-selected" : ""} ${r.riskScore >= 15 ? "is-alert" : ""}"
      role="row"
      tabindex="0"
      style="animation-delay:${stagger(index)}"
      @click=${() => openEdit(app, r)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEdit(app, r);
        }
      }}
    >
      ${selectBox(selected, () => {
        sel.toggle(r.id);
        app.requestUpdate?.();
      }, { label: `Select risk ${r.title || "untitled"}` })}

      <div class="kis-td kis-td--strong kis-td--flex">
        <span class="risk-band" style="background:${scoreColor(r.riskScore)}; color:${scoreColor(r.riskScore)}"></span>
        <span class="kis-td-stack">
          <span class="kis-td--strong risk-title">${r.title || "(untitled)"}</span>
          ${r.mitigation ? html`<span class="kis-td-sub">${r.mitigation}</span>` : nothing}
        </span>
        ${r.ceoRequired ? html`<span class="risk-ceo" title="CEO input required">${icon("star", 11)}</span>` : nothing}
      </div>

      <div class="kis-td" data-label="Category">${r.category || "—"}</div>
      <div class="kis-td kis-td--center" data-label="Score">${scoreChip(r.riskScore)}</div>
      <div class="kis-td" data-label="Status">${statusChip(r.status, RISK_STATUS_TONES)}</div>
      <div class="kis-td kis-td--flex" data-label="Owner">
        ${r.owner
          ? html`<span class="kis-td">${r.owner}</span>`
          : chip("unassigned", "danger", { title: "No accountable owner — assign one" })}
      </div>
      <div class="kis-td kis-td--flex" data-label="Next review">
        <span class=${overdue ? "risk-review-late" : ""}>${review}</span>
        ${overdue ? html`<span class="risk-review-flag" title="Review overdue">${icon("alert", 11)}</span>` : nothing}
      </div>
    </div>
  `;
}

// ── Main render ──────────────────────────────────────────────────────────────
export function renderRisk(app: AppViewState, client: GatewayBrowserClient) {
  client0 = client;
  if (!state.loaded && !state.loading) {
    void loadRisks(app, client);
  }
  const rerender = () => app.requestUpdate?.();

  const critical = state.risks.filter((r) => r.riskScore >= 12).length;
  const overdue = state.risks.filter((r) => isReviewOverdue(r)).length;
  const unowned = state.risks.filter((r) => !r.owner).length;
  const open = state.risks.filter((r) => r.status === "Open").length;
  const mitigated = state.risks.filter((r) => r.status === "Mitigated").length;
  const avg = state.risks.length
    ? Math.round((state.risks.reduce((s, r) => s + (r.riskScore || 0), 0) / state.risks.length) * 10) / 10
    : 0;

  const rows = sortBy(state.risks, sort, {
    title: (r) => (r.title || "").toLowerCase(),
    category: (r) => (r.category || "").toLowerCase(),
    riskScore: (r) => r.riskScore || 0,
    status: (r) => (r.status || "").toLowerCase(),
    owner: (r) => (r.owner || "￿").toLowerCase(),
    nextReviewDate: (r) => Date.parse(r.nextReviewDate || "") || Number.MAX_SAFE_INTEGER,
  });

  const pageIds = rows.map((r) => r.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const someSelected = !allSelected && pageIds.some((id) => sel.has(id));

  const bulkDelete = () =>
    void fb.run(`Deleting ${sel.size} risk${sel.size === 1 ? "" : "s"}`, async () => {
      const ids = [...sel.ids];
      for (const id of ids) await deleteRisk(app, client, id);
      sel.clear();
      await loadRisks(app, client);
    }, rerender);

  const bulkStatus = (next: string) =>
    void fb.run(`Marking ${sel.size} ${next.toLowerCase()}`, async () => {
      const ids = [...sel.ids];
      for (const id of ids) await client.request("risk.update", { id, status: next });
      sel.clear();
      await loadRisks(app, client);
    }, rerender);

  return html`
    <div class="kis kis-risk wg-page wg-kis">
      ${wgAurora()}
      ${KIS_STYLE}
      ${RISK_STYLE}

      ${wgHero({
        eyebrow: "Governance · Object 7",
        title: html`Risk <span class="wg-gold">Register</span>`,
        sub: html`Score every risk on a 1–25 probability × impact matrix, assign one accountable owner, and review on cadence.
          ${critical || overdue || unowned
            ? html`<span class="wgk-callouts">
                ${critical ? chip(`${critical} critical`, "danger") : nothing}
                ${overdue ? chip(`${overdue} review overdue`, "warn") : nothing}
                ${unowned ? chip(`${unowned} unowned`, "warn") : nothing}
              </span>`
            : nothing}`,
        actions: html`
          ${ghostButton("Refresh", () => void fb.run("Refreshing", () => loadRisks(app, client), rerender), {
            iconName: "refresh",
            state: state.loading ? "busy" : "idle",
          })}
          ${primaryButton("Log Risk", () => openCreate(app), { iconName: "plus" })}
        `,
      })}

      ${statStrip([
        statCard({ label: "Registered", value: state.risks.length, tone: "gold", iconName: "shield", sub: "risks on the register" }),
        statCard({ label: "Critical", value: critical, tone: critical ? "danger" : "ok", sub: "score ≥ 12", onClick: () => { state.criticalOnly = !state.criticalOnly; void loadRisks(app, client); }, active: state.criticalOnly }),
        statCard({ label: "Open", value: open, tone: open ? "warn" : "ok", sub: "not yet mitigated" }),
        statCard({ label: "Mitigated", value: mitigated, tone: "ok", sub: "controls in place" }),
        statCard({ label: "Avg score", value: avg, tone: avg >= 12 ? "danger" : avg >= 6 ? "warn" : "ok", sub: "of 25 max" }),
        statCard({ label: "Review overdue", value: overdue, tone: overdue ? "warn" : "ok", iconName: "clock", sub: "past next-review date" }),
      ])}

      ${toolbar({
        search: {
          value: state.search,
          placeholder: "Search title / mitigation / category…",
          onInput: (v) => {
            state.search = v;
          },
          onCommit: () => void loadRisks(app, client),
        },
        filters: html`
          ${filterChip("Critical only", state.criticalOnly, () => {
            state.criticalOnly = !state.criticalOnly;
            void loadRisks(app, client);
          })}
          ${filterGroup(
            "Status",
            html`
              ${filterChip("All", state.filterStatus === "", () => {
                state.filterStatus = "";
                void loadRisks(app, client);
              })}
              ${RISK_STATUSES.map((st) =>
                filterChip(st, state.filterStatus === st, () => {
                  state.filterStatus = st;
                  void loadRisks(app, client);
                }),
              )}
            `,
          )}
        `,
        trailing: statusLine(fb),
      })}

      ${state.error ? errorBanner(state.error, () => void loadRisks(app, client)) : nothing}

      <div class="risk-body">
        <div class="kis-tablewrap">
          ${tableShell({
            caption: "Risk register",
            cols: COLS,
            head: html`
              ${selectBox(allSelected, () => {
                sel.setAll(pageIds, !allSelected);
                app.requestUpdate?.();
              }, { label: allSelected ? "Deselect all risks" : "Select all risks", indeterminate: someSelected })}
              ${sortHeader("Risk", "title", sort, rerender)}
              ${sortHeader("Category", "category", sort, rerender)}
              ${sortHeader("Score", "riskScore", sort, rerender, { natural: "desc", align: "center" })}
              ${sortHeader("Status", "status", sort, rerender)}
              ${sortHeader("Owner", "owner", sort, rerender)}
              ${sortHeader("Next review", "nextReviewDate", sort, rerender)}
            `,
            body: state.loading && !state.risks.length
              ? skeletonRows(6, COLS)
              : rows.length === 0
                ? emptyState({
                    iconName: "shield",
                    title: state.search || state.filterStatus || state.criticalOnly ? "No risks match these filters" : "The register is clear",
                    hint:
                      state.search || state.filterStatus || state.criticalOnly
                        ? "Widen the search or clear the status filter to see the full register."
                        : "Log the things that could derail delivery, cash or compliance — each with one accountable owner and a review date.",
                    actionLabel: "Log the first risk",
                    onAction: () => openCreate(app),
                  })
                : rows.map((r, i) => renderRow(app, r, i)),
          })}
          ${bulkBar({
            count: sel.size,
            noun: "risk",
            onClear: () => {
              sel.clear();
              app.requestUpdate?.();
            },
            actions: html`
              ${ghostButton("Mark monitoring", () => bulkStatus("Monitoring"), { iconName: "clock", tone: "gold", state: fb.state === "busy" ? "busy" : "idle" })}
              ${ghostButton("Mark mitigated", () => bulkStatus("Mitigated"), { iconName: "check", tone: "ok", state: fb.state === "busy" ? "busy" : "idle" })}
              ${ghostButton("Delete", bulkDelete, { iconName: "trash", tone: "danger", state: fb.state === "busy" ? "busy" : "idle" })}
            `,
          })}
        </div>
        ${renderHeatmap(app)}
      </div>

      <p class="kis-footnote">${rows.length} of ${state.risks.length} risks shown · sorted by ${sort.key} ${sort.dir === "asc" ? "ascending" : "descending"}</p>

      ${renderModal(app, client)}
    </div>
  `;
}

// ── Risk-specific styling (layered on the shared .kis system) ────────────────
const RISK_STYLE = html`
  <style>
    .kis-risk .risk-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--s3); align-items: start; }
    @media (max-width: 1180px) { .kis-risk .risk-body { grid-template-columns: minmax(0, 1fr); } }

    .kis-risk .risk-band { width: 3px; height: 22px; border-radius: 2px; flex: 0 0 auto; }
    .kis-risk .risk-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    .kis-risk .risk-ceo { color: var(--gold); display: flex; flex: 0 0 auto; }
    .kis-risk .risk-review-late { color: var(--warn); }
    .kis-risk .risk-review-flag { color: var(--warn); display: flex; }

    .kis-risk .risk-heat { position: sticky; top: var(--s2); }
    .kis-risk .risk-heat-body { display: flex; gap: var(--s2); }
    .kis-risk .risk-heat-yaxis {
      writing-mode: vertical-rl; transform: rotate(180deg);
      font-size: 8.5px; letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--fg-muted); align-self: center;
    }
    .kis-risk .risk-heat-grid-wrap { flex: 1 1 auto; min-width: 0; }
    .kis-risk .risk-heat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
    .kis-risk .risk-cell {
      aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
      border-radius: 5px; border: 1px solid; font-family: var(--mono);
      font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums;
      cursor: default; padding: 0; transition: transform 120ms ease, filter 120ms ease;
    }
    .kis-risk .risk-cell.is-hot { cursor: pointer; }
    .kis-risk .risk-cell.is-hot:hover { transform: scale(1.08); filter: brightness(1.25); }
    .kis-risk .risk-cell:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
    .kis-risk .risk-heat-xaxis {
      text-align: center; font-size: 8.5px; letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--fg-muted); margin-top: 6px;
    }
    .kis-risk .risk-heat-legend {
      display: flex; flex-wrap: wrap; gap: var(--s2);
      border-top: 1px solid color-mix(in srgb, var(--rule) 70%, transparent);
      padding: var(--s2) var(--s3) var(--s3);
      font-size: 8.5px; color: var(--fg-muted);
    }
    .kis-risk .risk-heat-legend span { display: inline-flex; align-items: center; gap: 4px; }
    .kis-risk .risk-heat-legend i { width: 7px; height: 7px; border-radius: 2px; display: block; }
  </style>
`;
