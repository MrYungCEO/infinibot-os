/**
 * Decisions view — the CEO decision queue (Phase 1 Object 6).
 *
 * A CEO-facing queue of decisions grouped by status (lifecycle order) and, in
 * CEO-Queue mode, sorted by urgency (priority then deadline). Every decision
 * carries the exact question, its options and recommendation, so the founder
 * can decide in one glance. A full-field create/edit modal captures the rest.
 *
 * Self-contained black & gold glassmorphism to match the issues / notes /
 * kanban surfaces. Data + state live in `../controllers/decision`.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  DECISION_TYPES,
  DECISION_STATUSES,
  CEO_QUEUE_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  decisionState as state,
  loadDecisions,
  saveDecision,
  deleteDecision,
  openCreate,
  openEdit,
  closeModal,
  priorityRank,
  type Decision,
} from "../controllers/decision";
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
  prioChip,
  relativeDay,
  selectBox,
  skeletonRows,
  stagger,
  statCard,
  statStrip,
  statusChip,
  statusLine,
  toolbar,
  type Tone,
} from "./kis-shared";
import { wgAurora, wgHero } from "./work-glass";
import { wgkError, wgkField, wgkModal, wgkSection, wgkSelect } from "./work-glass/kis-form";

// ── Page-level UI state the controller doesn't persist ──────────────────────
const sel = createSelection();
const sort = createSort("urgency", "asc");
const fb = createFeedback();

const DECISION_STATUS_TONES: Record<string, Tone> = {
  "CEO Review": "gold",
  "Ready for Decision": "warn",
  Preparing: "muted",
  Decided: "ok",
  Deferred: "info",
  Cancelled: "muted",
};

function deadlineTone(iso: string): { text: string; tone: Tone } {
  if (!iso || !iso.trim()) return { text: "no deadline", tone: "muted" };
  return relativeDay(iso);
}
function isPastDeadline(d: Decision): boolean {
  if (!d.decisionDeadline) return false;
  const t = Date.parse(d.decisionDeadline);
  return !Number.isNaN(t) && t < Date.now();
}


// Lifecycle order for grouping (active first, terminal last).
const STATUS_ORDER = [
  "CEO Review",
  "Ready for Decision",
  "Preparing",
  "Decided",
  "Deferred",
  "Cancelled",
];

// ── Modal ──
function renderModal(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.modalOpen) return nothing;
  const d = state.draft;
  const set = (patch: Partial<Decision>) => {
    state.draft = { ...state.draft, ...patch };
    app.requestUpdate?.();
  };
  const canSave = !state.saving && Boolean((state.draft.title ?? "").trim());

  return wgkModal({
    eyebrow: "Governance · Decision",
    title: state.editingId ? "Edit Decision" : "New Decision",
    onClose: () => closeModal(app),
    width: 760,
    body: html`
      ${wgkField("Decision Title", d.title ?? "", (v) => set({ title: v }), {
        placeholder: "What has to be decided?",
        span: true,
      })}
      ${wgkSelect("Decision Type", d.decisionType ?? "Strategic", DECISION_TYPES, (v) => set({ decisionType: v }))}
      ${wgkSelect("Status", d.status ?? "Preparing", DECISION_STATUSES, (v) => set({ status: v }))}
      ${wgkField("Decision Owner", d.owner ?? "", (v) => set({ owner: v }), { placeholder: "single accountable owner" })}
      ${wgkField("Requested By", d.requestedBy ?? "", (v) => set({ requestedBy: v }))}
      ${wgkSelect("Priority", d.priority ?? "P2", PRIORITIES, (v) => set({ priority: v }), {
        format: (o) => `${o} · ${PRIORITY_LABELS[o] ?? o}`,
      })}
      ${wgkField("Decision Deadline", d.decisionDeadline ?? "", (v) => set({ decisionDeadline: v }), { type: "date" })}

      ${wgkField("Decision Required (the exact question)", d.decisionRequired ?? "", (v) => set({ decisionRequired: v }), { area: true, placeholder: "State the precise question to answer.", span: true })}
      ${wgkField("Options", d.options ?? "", (v) => set({ options: v }), { area: true, placeholder: "One option per line…", span: true })}
      ${wgkField("Recommendation", d.recommendation ?? "", (v) => set({ recommendation: v }), { area: true, span: true })}

      ${wgkSection("Linkage (optional)")}
      ${wgkField("Client 🔗", d.clientId ?? "", (v) => set({ clientId: v }))}
      ${wgkField("Opportunity 🔗", d.opportunityId ?? "", (v) => set({ opportunityId: v }))}
      ${wgkField("Project 🔗", d.projectId ?? "", (v) => set({ projectId: v }))}
      ${wgkField("Product 🔗", d.productId ?? "", (v) => set({ productId: v }))}
      ${wgkField("Issue 🔗", d.issueId ?? "", (v) => set({ issueId: v }), { span: true })}

      ${wgkSection("Outcome (when Decided)")}
      ${wgkField("Final Decision", d.finalDecision ?? "", (v) => set({ finalDecision: v }), { area: true, span: true })}
      ${wgkField("Decision Date", d.decisionDate ?? "", (v) => set({ decisionDate: v }), { type: "date" })}
      <label class="wgk-check">
        <input type="checkbox" .checked=${!!d.ceoRequired} @change=${(e: Event) => set({ ceoRequired: (e.target as HTMLInputElement).checked })} />
        <span>CEO Required</span>
      </label>
      ${wgkField("Rationale", d.rationale ?? "", (v) => set({ rationale: v }), { area: true, placeholder: "Why this decision was made (recorded to the audit trail).", span: true })}
      ${wgkError(state.error)}
    `,
    foot: html`
      ${state.editingId
        ? html`<button
            class="wgk-btn wgk-btn--danger"
            @click=${() => {
              if (state.editingId) void deleteDecision(app, client, state.editingId);
              closeModal(app);
            }}
          >${icon("trash", 13)}<span>Delete</span></button>`
        : nothing}
      <div class="wgk-modal__foot-end">
        <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
        <button class="wgk-btn wgk-btn--primary" ?disabled=${!canSave} @click=${() => void saveDecision(app, client)}>
          ${state.saving ? "Saving…" : state.editingId ? "Save" : "Create"}
        </button>
      </div>
    `,
  });
}

// ── Decision row ────────────────────────────────────────────────────────────
function decisionRow(app: AppViewState, d: Decision, index: number) {
  const dl = deadlineTone(d.decisionDeadline);
  const selected = sel.has(d.id);
  return html`
    <div
      class="dec-row ${selected ? "is-selected" : ""} ${d.ceoRequired ? "is-ceo" : ""}"
      role="row"
      tabindex="0"
      style="animation-delay:${stagger(index)}"
      @click=${() => openEdit(app, d)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEdit(app, d);
        }
      }}
    >
      ${selectBox(selected, () => {
        sel.toggle(d.id);
        app.requestUpdate?.();
      }, { label: `Select decision ${d.title || "untitled"}` })}

      <div class="dec-row-main">
        <div class="dec-row-head">
          ${prioChip(d.priority, { withLabel: true })}
          <h3 class="dec-row-title">${d.title || "(untitled)"}</h3>
          ${d.ceoRequired
            ? html`<span class="dec-ceo" title="CEO decision required">${icon("star", 11)}<span>CEO</span></span>`
            : nothing}
        </div>
        ${d.decisionRequired ? html`<p class="dec-row-q">${d.decisionRequired}</p>` : nothing}
        ${d.recommendation ? html`<p class="dec-row-rec"><span>Recommendation</span>${d.recommendation}</p>` : nothing}
        <div class="dec-row-meta">
          ${d.decisionType ? chip(d.decisionType, "muted") : nothing}
          ${d.owner ? html`<span class="dec-meta-k">Owner<b>${d.owner}</b></span>` : nothing}
          ${d.requestedBy ? html`<span class="dec-meta-k">By<b>${d.requestedBy}</b></span>` : nothing}
        </div>
      </div>

      <div class="dec-row-side">
        <span class="dec-deadline dec-deadline--${dl.tone}">${icon("clock", 11)}<span>${dl.text}</span></span>
        ${statusChip(d.status, DECISION_STATUS_TONES)}
      </div>
    </div>
  `;
}

// ── Root ────────────────────────────────────────────────────────────────────
export function renderDecision(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.loaded && !state.loading) {
    void loadDecisions(app, client);
  }
  const rerender = () => app.requestUpdate?.();

  // Group + order the decisions.
  const groups = new Map<string, Decision[]>();
  for (const d of state.decisions) {
    const list = groups.get(String(d.status)) ?? [];
    list.push(d);
    groups.set(String(d.status), list);
  }
  const sortInGroup = (arr: Decision[]) => {
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...arr].sort((a, b) => {
      if (sort.key === "title") return a.title.localeCompare(b.title) * mul;
      if (sort.key === "deadline") {
        const ak = a.decisionDeadline ? Date.parse(a.decisionDeadline) : Number.MAX_SAFE_INTEGER;
        const bk = b.decisionDeadline ? Date.parse(b.decisionDeadline) : Number.MAX_SAFE_INTEGER;
        return ((Number.isNaN(ak) ? Number.MAX_SAFE_INTEGER : ak) - (Number.isNaN(bk) ? Number.MAX_SAFE_INTEGER : bk)) * mul;
      }
      // urgency (default): priority, then deadline
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr * mul;
      const ak = a.decisionDeadline ? Date.parse(a.decisionDeadline) : Number.MAX_SAFE_INTEGER;
      const bk = b.decisionDeadline ? Date.parse(b.decisionDeadline) : Number.MAX_SAFE_INTEGER;
      return ((Number.isNaN(ak) ? Number.MAX_SAFE_INTEGER : ak) - (Number.isNaN(bk) ? Number.MAX_SAFE_INTEGER : bk)) * mul;
    });
  };
  const orderedStatuses = STATUS_ORDER.filter((s) => groups.has(s)).concat(
    [...groups.keys()].filter((s) => !STATUS_ORDER.includes(s)),
  );

  const all = state.decisions;
  const ceoWaiting = all.filter((d) => CEO_QUEUE_STATUSES.includes(d.status)).length;
  const p0 = all.filter((d) => (d.priority || "").toUpperCase() === "P0" && d.status !== "Decided" && d.status !== "Cancelled").length;
  const overdue = all.filter((d) => isPastDeadline(d) && d.status !== "Decided" && d.status !== "Cancelled").length;
  const decided = all.filter((d) => d.status === "Decided").length;
  const noRec = all.filter((d) => !d.recommendation && d.status !== "Decided" && d.status !== "Cancelled").length;

  const allIds = all.map((d) => d.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => sel.has(id));
  const someSelected = !allSelected && allIds.some((id) => sel.has(id));

  const bulkStatus = (next: string) =>
    void fb.run(`Moving ${sel.size} to ${next}`, async () => {
      for (const id of [...sel.ids]) await client.request("decision.update", { id, status: next });
      sel.clear();
      await loadDecisions(app, client);
    }, rerender);

  const bulkDelete = () =>
    void fb.run(`Deleting ${sel.size} decision${sel.size === 1 ? "" : "s"}`, async () => {
      for (const id of [...sel.ids]) await deleteDecision(app, client, id);
      sel.clear();
      await loadDecisions(app, client);
    }, rerender);

  const sortChip = (label: string, key: string) =>
    filterChip(
      sort.key === key ? `${label} ${sort.dir === "asc" ? "↑" : "↓"}` : label,
      sort.key === key,
      () => {
        sort.toggle(key, key === "title" ? "asc" : "asc");
        rerender();
      },
    );

  return html`
    <div class="kis kis-dec wg-page wg-kis">
      ${wgAurora()}
      ${KIS_STYLE}
      ${DEC_STYLE}

      ${wgHero({
        eyebrow: "Governance · Object 6",
        title: html`Decisions <span class="wg-gold">· CEO Queue</span>`,
        sub: html`Prepare, review and record the decisions the business must make. Humans retain final authority.
          ${ceoWaiting || p0 || overdue
            ? html`<span class="wgk-callouts">
                ${ceoWaiting ? chip(`${ceoWaiting} awaiting the CEO`, "warn") : nothing}
                ${p0 ? chip(`${p0} critical`, "danger") : nothing}
                ${overdue ? chip(`${overdue} past deadline`, "danger") : nothing}
              </span>`
            : nothing}`,
        actions: html`
          ${ghostButton("Refresh", () => void fb.run("Refreshing", () => loadDecisions(app, client), rerender), {
            iconName: "refresh",
            state: state.loading ? "busy" : "idle",
          })}
          ${primaryButton("New Decision", () => openCreate(app), { iconName: "plus" })}
        `,
      })}

      ${statStrip([
        statCard({ label: "In queue", value: all.length, tone: "gold", iconName: "scale", sub: "decisions tracked" }),
        statCard({
          label: "Needs CEO",
          value: ceoWaiting,
          tone: ceoWaiting ? "warn" : "ok",
          iconName: "star",
          sub: "ready or in CEO review",
          onClick: () => {
            state.ceoQueueOnly = !state.ceoQueueOnly;
            void loadDecisions(app, client);
          },
          active: state.ceoQueueOnly,
        }),
        statCard({ label: "Critical", value: p0, tone: p0 ? "danger" : "ok", sub: "P0 still open" }),
        statCard({ label: "Past deadline", value: overdue, tone: overdue ? "danger" : "ok", iconName: "clock", sub: "undecided and late" }),
        statCard({ label: "No recommendation", value: noRec, tone: noRec ? "warn" : "ok", sub: "not yet decision-ready" }),
        statCard({ label: "Decided", value: decided, tone: "ok", iconName: "check", sub: "recorded with rationale" }),
      ])}

      ${toolbar({
        search: {
          value: state.search,
          placeholder: "Search title / question / recommendation…",
          onInput: (v) => {
            state.search = v;
          },
          onCommit: () => void loadDecisions(app, client),
        },
        filters: html`
          ${filterChip("CEO queue only", state.ceoQueueOnly, () => {
            state.ceoQueueOnly = !state.ceoQueueOnly;
            void loadDecisions(app, client);
          })}
          ${filterGroup(
            "Status",
            html`
              ${filterChip("All", state.filterStatus === "" && !state.ceoQueueOnly, () => {
                state.filterStatus = "";
                state.ceoQueueOnly = false;
                void loadDecisions(app, client);
              })}
              ${DECISION_STATUSES.map((st) =>
                filterChip(st, state.filterStatus === st, () => {
                  state.filterStatus = st;
                  state.ceoQueueOnly = false;
                  void loadDecisions(app, client);
                }),
              )}
            `,
          )}
          ${filterGroup("Sort", html`${sortChip("Urgency", "urgency")}${sortChip("Deadline", "deadline")}${sortChip("Title", "title")}`)}
        `,
        trailing: html`
          ${all.length
            ? html`<span class="dec-selectall">
                ${selectBox(allSelected, () => {
                  sel.setAll(allIds, !allSelected);
                  rerender();
                }, { label: allSelected ? "Deselect all decisions" : "Select all decisions", indeterminate: someSelected })}
                <span>Select all</span>
              </span>`
            : nothing}
          ${statusLine(fb)}
        `,
      })}

      ${state.error ? errorBanner(state.error, () => void loadDecisions(app, client)) : nothing}

      ${state.loading && !all.length
        ? skeletonRows(5, "1fr")
        : all.length === 0
          ? emptyState({
              iconName: "scale",
              title: state.search || state.filterStatus || state.ceoQueueOnly ? "No decisions match these filters" : "Nothing waiting on a decision",
              hint:
                state.search || state.filterStatus || state.ceoQueueOnly
                  ? "Clear the CEO-queue toggle or widen the status filter to see the whole log."
                  : "Queue the choices the business has to make — the exact question, the options, and a recommendation — so each one can be decided in a single glance.",
              actionLabel: "Queue the first decision",
              onAction: () => openCreate(app),
            })
          : html`<div class="dec-groups">
              ${orderedStatuses.map((status) => {
                const arr = sortInGroup(groups.get(status) ?? []);
                const tone = DECISION_STATUS_TONES[status] ?? "muted";
                return html`
                  <section class="kis-panel ${CEO_QUEUE_STATUSES.includes(status) ? "kis-panel--accent" : ""}">
                    <div class="kis-panel-head">
                      <div class="kis-panel-headmain">
                        <span class="dec-dot dec-dot--${tone}"></span>
                        <h2>${status}</h2>
                        ${CEO_QUEUE_STATUSES.includes(status) ? chip("needs CEO", "warn") : nothing}
                      </div>
                      <span class="kis-panel-count kis-panel-count--${tone}">${arr.length}</span>
                    </div>
                    <div class="kis-panel-body">${arr.map((d, i) => decisionRow(app, d, i))}</div>
                  </section>
                `;
              })}
            </div>`}

      ${bulkBar({
        count: sel.size,
        noun: "decision",
        onClear: () => {
          sel.clear();
          rerender();
        },
        actions: html`
          ${ghostButton("Send to CEO", () => bulkStatus("CEO Review"), { iconName: "star", tone: "gold", state: fb.state === "busy" ? "busy" : "idle" })}
          ${ghostButton("Mark decided", () => bulkStatus("Decided"), { iconName: "check", tone: "ok", state: fb.state === "busy" ? "busy" : "idle" })}
          ${ghostButton("Defer", () => bulkStatus("Deferred"), { iconName: "clock", state: fb.state === "busy" ? "busy" : "idle" })}
          ${ghostButton("Delete", bulkDelete, { iconName: "trash", tone: "danger", state: fb.state === "busy" ? "busy" : "idle" })}
        `,
      })}

      ${all.length ? html`<p class="kis-footnote">${all.length} decisions across ${orderedStatuses.length} stages · sorted by ${sort.key}</p>` : nothing}

      ${renderModal(app, client)}
    </div>
  `;
}

// ── Decision-specific styling (layered on the shared .kis system) ────────────
const DEC_STYLE = html`
  <style>
    .kis-dec .dec-groups { display: flex; flex-direction: column; gap: var(--s3); }
    .kis-dec .dec-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--fg-muted); }
    .kis-dec .dec-dot--gold { background: var(--gold); box-shadow: 0 0 7px color-mix(in srgb, var(--gold) 60%, transparent); }
    .kis-dec .dec-dot--warn { background: var(--warn); }
    .kis-dec .dec-dot--danger { background: var(--danger); }
    .kis-dec .dec-dot--ok { background: var(--ok); }
    .kis-dec .dec-dot--info { background: var(--info); }

    .kis-dec .dec-selectall {
      display: inline-flex; align-items: center; gap: 5px; margin-right: var(--s1);
      font-size: 9px; letter-spacing: 0.11em; text-transform: uppercase;
      color: var(--fg-muted); font-weight: 700; white-space: nowrap;
    }

    .kis-dec .dec-row {
      display: grid; grid-template-columns: 26px minmax(0, 1fr) auto;
      align-items: start; gap: var(--s3);
      padding: var(--s3);
      border-top: 1px solid color-mix(in srgb, var(--rule) 55%, transparent);
      cursor: pointer; transition: background 120ms ease, box-shadow 120ms ease;
      animation: kis-fade 260ms ease both;
    }
    .kis-dec .kis-panel-body > .dec-row:first-child { border-top: none; }
    .kis-dec .dec-row:hover { background: color-mix(in srgb, var(--gold) 6%, transparent); }
    .kis-dec .dec-row:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
    .kis-dec .dec-row.is-selected { background: color-mix(in srgb, var(--gold) 10%, transparent); box-shadow: inset 2px 0 0 var(--gold); }
    .kis-dec .dec-row .kis-check { margin-top: 2px; }

    .kis-dec .dec-row-main { min-width: 0; display: flex; flex-direction: column; gap: var(--s1); }
    .kis-dec .dec-row-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .kis-dec .dec-row-title {
      margin: 0; font-size: 12.5px; font-weight: 700; color: var(--fg);
      letter-spacing: -0.005em; text-transform: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .kis-dec .dec-ceo {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 9px; font-weight: 800; letter-spacing: 0.08em;
      color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 40%, transparent);
      background: color-mix(in srgb, var(--gold) 12%, transparent);
      padding: 1px 6px; border-radius: 999px;
    }
    .kis-dec .dec-row-q { margin: 0; font-size: 11px; color: var(--fg-dim); line-height: 1.45; }
    .kis-dec .dec-row-rec {
      margin: 0; font-size: 10.5px; color: var(--fg-dim); line-height: 1.45;
      padding-left: 8px; border-left: 2px solid color-mix(in srgb, var(--gold) 40%, transparent);
    }
    .kis-dec .dec-row-rec > span {
      display: block; font-size: 8.5px; letter-spacing: 0.13em; text-transform: uppercase;
      color: var(--gold); opacity: 0.85; font-weight: 700; margin-bottom: 1px;
    }
    .kis-dec .dec-row-meta { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; margin-top: 1px; }
    .kis-dec .dec-meta-k { font-size: 9.5px; color: var(--fg-muted); display: inline-flex; gap: 4px; }
    .kis-dec .dec-meta-k b { color: var(--fg-dim); font-weight: 650; }

    .kis-dec .dec-row-side { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: 0 0 auto; }
    .kis-dec .dec-deadline {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; font-variant-numeric: tabular-nums; color: var(--fg-muted);
    }
    .kis-dec .dec-deadline--danger { color: var(--danger); }
    .kis-dec .dec-deadline--warn { color: var(--warn); }
    .kis-dec .dec-deadline--gold { color: var(--gold); }

    @media (max-width: 860px) {
      .kis-dec .dec-row { grid-template-columns: 26px minmax(0, 1fr); }
      .kis-dec .dec-row-side { grid-column: 2; flex-direction: row; align-items: center; }
    }
  </style>
`;
