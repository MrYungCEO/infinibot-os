/**
 * Financial Commitments (K.I.S. Object 8) view.
 *
 * A money-in / money-out ledger: aggregate money surfaces at the top (what
 * we're owed, what we owe, what's overdue, deposits not received, work
 * proceeding without payment — spec §8), then a filterable table of commitments
 * with a full-field create/edit modal. Overdue rows are surfaced in red.
 *
 * Self-contained module state; all data goes through `controllers/commitment.ts`
 * → the gateway `commitment.*` RPCs. Black & gold glassmorphism to match the
 * issues / notes / kanban surfaces.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  COMMITMENT_DIRECTIONS,
  COMMITMENT_STATUSES,
  COMMITMENT_TYPES,
  PRIORITIES,
  createCommitment,
  deleteCommitment,
  fetchAggregates,
  fetchCommitments,
  formatMoney,
  isMoneyIn,
  updateCommitment,
  type Commitment,
  type CommitmentAggregates,
  type CommitmentDraft,
} from "../controllers/commitment";
import {
  KIS_STYLE,
  bar,
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
  money,
  moneyCell,
  primaryButton,
  relativeDay,
  selectBox,
  skeletonRows,
  sortBy,
  sortHeader,
  stagger,
  statCard as statCardShared,
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
const sort = createSort("dueDate", "asc");
const fb = createFeedback();

const COMMIT_STATUS_TONES: Record<string, Tone> = {
  Expected: "gold",
  Scheduled: "info",
  Invoiced: "info",
  Partial: "warn",
  "Partially Paid": "warn",
  Paid: "ok",
  Overdue: "danger",
  Cancelled: "muted",
};

const COLS = "26px 2.4fr 0.9fr 1fr 1.2fr 1fr 1fr";


// ── Module state ──
interface CommitmentUIState {
  items: Commitment[];
  aggregates: CommitmentAggregates | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  search: string;
  filterDirection: string;
  filterStatus: string;
  overdueOnly: boolean;
  modalOpen: boolean;
  draft: CommitmentDraft;
  editingId: string | null;
  saving: boolean;
}

const state: CommitmentUIState = {
  items: [],
  aggregates: null,
  loading: false,
  loaded: false,
  error: null,
  search: "",
  filterDirection: "",
  filterStatus: "",
  overdueOnly: false,
  modalOpen: false,
  draft: {},
  editingId: null,
  saving: false,
};

function rerender(app: AppViewState) {
  app.requestUpdate?.();
}

// ── Data ──
async function load(app: AppViewState, client: GatewayBrowserClient) {
  state.loading = true;
  state.error = null;
  const search = {
    query: state.search || undefined,
    direction: state.filterDirection || undefined,
    status: state.filterStatus || undefined,
    overdueOnly: state.overdueOnly || undefined,
  };
  try {
    const [items, aggregates] = await Promise.all([
      fetchCommitments(client, search),
      // Aggregates always reflect the full ledger, not the filtered view.
      fetchAggregates(client, {}),
    ]);
    state.items = items;
    state.aggregates = aggregates;
    state.loaded = true;
  } catch (e) {
    state.error = String(e);
  } finally {
    state.loading = false;
    rerender(app);
  }
}

function openCreate(app: AppViewState) {
  state.editingId = null;
  state.error = null;
  state.draft = {
    commitmentType: "Client Invoice",
    direction: "Money In",
    status: "Expected",
    priority: "P2",
    amount: 0,
    amountPaid: 0,
    dueDate: new Date().toISOString().slice(0, 10),
  };
  state.modalOpen = true;
  rerender(app);
}

function openEdit(app: AppViewState, c: Commitment) {
  state.editingId = c.id;
  state.error = null;
  state.draft = { ...c };
  state.modalOpen = true;
  rerender(app);
}

function closeModal(app: AppViewState) {
  state.modalOpen = false;
  state.draft = {};
  state.editingId = null;
  state.error = null;
  rerender(app);
}

async function save(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.draft.name?.trim()) {
    state.error = "Commitment Name is required";
    rerender(app);
    return;
  }
  if (!state.draft.owner?.trim()) {
    state.error = "Owner is required (§27 — every commitment needs one accountable owner)";
    rerender(app);
    return;
  }
  state.saving = true;
  state.error = null;
  rerender(app);
  try {
    // Coerce the numeric money fields (inputs hand back strings).
    const draft: CommitmentDraft = {
      ...state.draft,
      amount: Number(state.draft.amount ?? 0),
      amountPaid: Number(state.draft.amountPaid ?? 0),
    };
    if (state.editingId) {
      await updateCommitment(client, state.editingId, draft);
    } else {
      await createCommitment(client, draft);
    }
    state.modalOpen = false;
    state.draft = {};
    state.editingId = null;
    await load(app, client);
  } catch (e) {
    state.error = String(e);
  } finally {
    state.saving = false;
    rerender(app);
  }
}

async function remove(app: AppViewState, client: GatewayBrowserClient, id: string) {
  try {
    await deleteCommitment(client, id);
    if (state.editingId === id) closeModal(app);
    await load(app, client);
  } catch (e) {
    state.error = String(e);
    rerender(app);
  }
}

function set<K extends keyof CommitmentDraft>(app: AppViewState, key: K, value: CommitmentDraft[K]) {
  state.draft = { ...state.draft, [key]: value };
  rerender(app);
}

// ── Field helpers ──
function textField(
  app: AppViewState,
  label: string,
  key: keyof CommitmentDraft,
  opts: { type?: string; placeholder?: string; area?: boolean; span?: boolean } = {},
) {
  const val = (state.draft[key] as string | number | undefined) ?? "";
  return wgkField(label, val, (v) => set(app, key, v as never), { rows: 2, ...opts });
}

function selectField(
  app: AppViewState,
  label: string,
  key: keyof CommitmentDraft,
  options: readonly string[],
) {
  const val = (state.draft[key] as string) ?? "";
  return wgkSelect(label, val, options, (v) => set(app, key, v as never));
}

// ── Modal ──
function renderModal(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.modalOpen) return nothing;
  const isEdit = Boolean(state.editingId);
  const remaining =
    Number(state.draft.amount ?? 0) - Number(state.draft.amountPaid ?? 0);
  return wgkModal({
    eyebrow: "Governance · Commitment",
    title: isEdit ? "Edit Commitment" : "New Financial Commitment",
    onClose: () => closeModal(app),
    width: 860,
    error: state.error,
    body: html`
      ${wgkSection("Identification")}
      ${textField(app, "Commitment Name *", "name", { placeholder: "e.g. Acme Corp — Phase 1 deposit", span: true })}
      ${selectField(app, "Type", "commitmentType", COMMITMENT_TYPES)}
      ${selectField(app, "Direction", "direction", COMMITMENT_DIRECTIONS)}

      ${wgkSection("Money")}
      ${textField(app, "Amount", "amount", { type: "number", placeholder: "0" })}
      ${textField(app, "Amount Paid", "amountPaid", { type: "number", placeholder: "0" })}
      <div class="wgk-balance">
        <span>Remaining Balance (computed)</span>
        <strong class=${remaining > 0 ? "is-due" : "is-clear"}>${formatMoney(remaining)}</strong>
      </div>
      ${selectField(app, "Status", "status", COMMITMENT_STATUSES)}
      ${textField(app, "Due Date", "dueDate", { type: "date" })}

      ${wgkSection("Links")}
      ${textField(app, "Client ID 🔗", "clientId", { placeholder: "optional" })}
      ${textField(app, "Project ID 🔗", "projectId", { placeholder: "optional — funds project" })}
      ${textField(app, "Opportunity ID 🔗", "opportunityId", { placeholder: "optional" })}
      ${textField(app, "Product ID 🔗", "productId", { placeholder: "optional" })}

      ${wgkSection("Ownership & Action")}
      ${textField(app, "Owner * 🔗", "owner", { placeholder: "accountable owner" })}
      ${selectField(app, "Priority", "priority", PRIORITIES)}
      ${textField(app, "Next Action", "nextAction")}
      ${textField(app, "Next Action Date", "nextActionDate", { type: "date" })}
      ${textField(app, "Source Document Link", "sourceDocumentLink", { placeholder: "contract / invoice / PO URL", span: true })}
    `,
    foot: html`
      ${isEdit
        ? html`<button class="wgk-btn wgk-btn--danger" @click=${() => remove(app, client, state.editingId!)}>
            ${icon("trash", 13)}<span>Delete</span>
          </button>`
        : nothing}
      <div class="wgk-modal__foot-end">
        <button class="wgk-btn" @click=${() => closeModal(app)}>Cancel</button>
        <button class="wgk-btn wgk-btn--primary" ?disabled=${state.saving} @click=${() => save(app, client)}>
          ${state.saving ? "Saving…" : isEdit ? "Save Changes" : "Add Commitment"}
        </button>
      </div>
    `,
  });
}

// ── Row ──────────────────────────────────────────────────────────────────────
function commitmentRow(app: AppViewState, c: Commitment, index: number) {
  const selected = sel.has(c.id);
  const inbound = isMoneyIn(c);
  const due = c.dueDate ? relativeDay(c.dueDate) : { text: "—", tone: "muted" as Tone };
  const paidPct = c.amount > 0 ? Math.round(((c.amount - c.remainingBalance) / c.amount) * 100) : 0;
  return html`
    <div
      class="kis-tr ${selected ? "is-selected" : ""} ${c.overdue ? "is-alert" : ""}"
      role="row"
      tabindex="0"
      style="animation-delay:${stagger(index)}"
      @click=${() => openEdit(app, c)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEdit(app, c);
        }
      }}
    >
      ${selectBox(selected, () => {
        sel.toggle(c.id);
        rerender(app);
      }, { label: `Select commitment ${c.name || "unnamed"}` })}

      <div class="kis-td kis-td--flex">
        <span class="com-dir com-dir--${inbound ? "in" : "out"}" title=${inbound ? "Money in" : "Money out"}>
          ${icon(inbound ? "arrowDown" : "arrowUp", 11)}
        </span>
        <span class="kis-td-stack">
          <span class="kis-td--strong com-name">${c.name || "(unnamed)"}</span>
          <span class="kis-td-sub">${c.commitmentType || "—"}${c.owner ? ` · ${c.owner}` : ""}</span>
        </span>
        ${c.ceoRequired ? html`<span class="com-ceo" title="CEO required">${icon("star", 11)}</span>` : nothing}
      </div>

      <div class="kis-td kis-td--num" data-label="Amount">${moneyCell(c.amount, "neutral", { exact: true, dim: true })}</div>
      <div class="kis-td kis-td--num" data-label="Remaining">${moneyCell(c.remainingBalance, inbound ? "in" : "out", { exact: true })}</div>

      <div class="kis-td com-progress-cell" data-label="Settled">
        ${bar(c.amount - c.remainingBalance, c.amount || 1, {
          tone: paidPct >= 100 ? "ok" : c.overdue ? "danger" : inbound ? "gold" : "info",
          label: `${paidPct}% settled — ${money(c.amount - c.remainingBalance, { exact: true })} of ${money(c.amount, { exact: true })}`,
          width: 74,
        })}
        <span class="com-pct kis-num">${paidPct}%</span>
      </div>

      <div class="kis-td kis-td--flex" data-label="Due">
        <span class="com-due com-due--${c.overdue ? "danger" : due.tone}">${c.dueDate || "—"}</span>
      </div>

      <div class="kis-td" data-label="Status">
        ${statusChip(c.overdue && c.status !== "Overdue" ? "Overdue" : c.status || "—", COMMIT_STATUS_TONES)}
      </div>
    </div>
  `;
}

// ── Main render ──────────────────────────────────────────────────────────────
export function renderCommitment(app: AppViewState, client: GatewayBrowserClient) {
  if (!state.loaded && !state.loading) {
    void load(app, client);
  }
  const rerenderNow = () => rerender(app);
  const agg = state.aggregates;

  const rows = sortBy(state.items, sort, {
    name: (c) => (c.name || "").toLowerCase(),
    amount: (c) => c.amount || 0,
    remainingBalance: (c) => c.remainingBalance || 0,
    settled: (c) => (c.amount > 0 ? (c.amount - c.remainingBalance) / c.amount : 0),
    dueDate: (c) => Date.parse(c.dueDate || "") || Number.MAX_SAFE_INTEGER,
    status: (c) => (c.overdue ? "0" : "1") + (c.status || "").toLowerCase(),
  });

  const pageIds = rows.map((c) => c.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const someSelected = !allSelected && pageIds.some((id) => sel.has(id));

  // Net position across the visible ledger — the one number a founder wants.
  const net = state.items.reduce((s, c) => s + (isMoneyIn(c) ? c.remainingBalance : -c.remainingBalance), 0);

  const bulkStatus = (next: string) =>
    void fb.run(`Marking ${sel.size} ${next.toLowerCase()}`, async () => {
      for (const id of [...sel.ids]) await updateCommitment(client, id, { status: next });
      sel.clear();
      await load(app, client);
    }, rerenderNow);

  const bulkDelete = () =>
    void fb.run(`Deleting ${sel.size} commitment${sel.size === 1 ? "" : "s"}`, async () => {
      for (const id of [...sel.ids]) await deleteCommitment(client, id);
      sel.clear();
      await load(app, client);
    }, rerenderNow);

  return html`
    <div class="kis kis-com wg-page wg-kis">
      ${wgAurora()}
      ${KIS_STYLE}
      ${COM_STYLE}

      ${wgHero({
        eyebrow: "Governance · Object 8",
        title: html`Financial <span class="wg-gold">Commitments</span>`,
        sub: html`The money-in / money-out ledger — what you are owed, what you owe, and what is already late.
          ${agg?.overdueCount || agg?.workProceedingWithoutPayment.count
            ? html`<span class="wgk-callouts">
                ${agg?.overdueCount ? chip(`${agg.overdueCount} overdue`, "danger") : nothing}
                ${agg?.workProceedingWithoutPayment.count
                  ? chip(`${agg.workProceedingWithoutPayment.count} working unpaid`, "warn")
                  : nothing}
              </span>`
            : nothing}`,
        actions: html`
          ${ghostButton("Refresh", () => void fb.run("Refreshing", () => load(app, client), rerenderNow), {
            iconName: "refresh",
            state: state.loading ? "busy" : "idle",
          })}
          ${primaryButton("Add Commitment", () => openCreate(app), { iconName: "plus" })}
        `,
      })}

      ${agg
        ? statStrip([
            statCardShared({
              label: "Net position",
              value: money(net, { exact: true }),
              tone: net >= 0 ? "ok" : "danger",
              iconName: "coins",
              sub: net >= 0 ? "owed to you, net of payables" : "you owe more than you are owed",
            }),
            statCardShared({ label: "Money expected", value: money(agg.moneyExpected, { exact: true }), tone: "ok", iconName: "arrowDown", sub: "active money-in remaining" }),
            statCardShared({ label: "Money owed", value: money(agg.moneyOwed, { exact: true }), tone: "gold", iconName: "arrowUp", sub: "active money-out remaining" }),
            statCardShared({
              label: "Overdue",
              value: money(agg.moneyOverdue, { exact: true }),
              tone: agg.moneyOverdue > 0 ? "danger" : "ok",
              iconName: "clock",
              sub: `${agg.overdueCount} commitment${agg.overdueCount === 1 ? "" : "s"} past due`,
              onClick: () => {
                state.overdueOnly = !state.overdueOnly;
                void load(app, client);
              },
              active: state.overdueOnly,
            }),
            statCardShared({ label: "Deposits not received", value: money(agg.depositsNotReceived, { exact: true }), tone: agg.depositsNotReceived > 0 ? "warn" : "ok", sub: "work may be at risk" }),
            statCardShared({
              label: "Work without payment",
              value: money(agg.workProceedingWithoutPayment.amount, { exact: true }),
              tone: agg.workProceedingWithoutPayment.count > 0 ? "danger" : "ok",
              sub: `${agg.workProceedingWithoutPayment.count} across ${agg.workProceedingWithoutPayment.projectIds.length} project${agg.workProceedingWithoutPayment.projectIds.length === 1 ? "" : "s"}`,
            }),
          ])
        : nothing}

      ${toolbar({
        search: {
          value: state.search,
          placeholder: "Search name / type / document…",
          onInput: (v) => {
            state.search = v;
          },
          onCommit: () => void load(app, client),
        },
        filters: html`
          ${filterGroup(
            "Direction",
            html`
              ${filterChip("All", state.filterDirection === "", () => {
                state.filterDirection = "";
                void load(app, client);
              })}
              ${COMMITMENT_DIRECTIONS.map((d) =>
                filterChip(d, state.filterDirection === d, () => {
                  state.filterDirection = d;
                  void load(app, client);
                }),
              )}
            `,
          )}
          ${filterChip("Overdue only", state.overdueOnly, () => {
            state.overdueOnly = !state.overdueOnly;
            void load(app, client);
          })}
        `,
        trailing: statusLine(fb),
      })}

      ${state.error ? errorBanner(state.error, () => void load(app, client)) : nothing}

      <div class="kis-tablewrap">
        ${tableShell({
          caption: "Commitment ledger",
          cols: COLS,
          head: html`
            ${selectBox(allSelected, () => {
              sel.setAll(pageIds, !allSelected);
              rerenderNow();
            }, { label: allSelected ? "Deselect all commitments" : "Select all commitments", indeterminate: someSelected })}
            ${sortHeader("Commitment", "name", sort, rerenderNow)}
            ${sortHeader("Amount", "amount", sort, rerenderNow, { natural: "desc", align: "end" })}
            ${sortHeader("Remaining", "remainingBalance", sort, rerenderNow, { natural: "desc", align: "end" })}
            ${sortHeader("Settled", "settled", sort, rerenderNow, { natural: "desc" })}
            ${sortHeader("Due", "dueDate", sort, rerenderNow)}
            ${sortHeader("Status", "status", sort, rerenderNow)}
          `,
          body: state.loading && !state.items.length
            ? skeletonRows(6, COLS)
            : rows.length === 0
              ? emptyState({
                  iconName: "coins",
                  title: state.search || state.filterDirection || state.overdueOnly ? "No commitments match these filters" : "The ledger is empty",
                  hint:
                    state.search || state.filterDirection || state.overdueOnly
                      ? "Clear the direction or overdue filter to see the whole ledger."
                      : "Track every invoice, deposit, retainer and contractor payment so money-in and money-out are never a surprise.",
                  actionLabel: "Add the first commitment",
                  onAction: () => openCreate(app),
                })
              : rows.map((c, i) => commitmentRow(app, c, i)),
        })}
        ${bulkBar({
          count: sel.size,
          noun: "commitment",
          onClear: () => {
            sel.clear();
            rerenderNow();
          },
          actions: html`
            ${ghostButton("Mark paid", () => bulkStatus("Paid"), { iconName: "check", tone: "ok", state: fb.state === "busy" ? "busy" : "idle" })}
            ${ghostButton("Mark overdue", () => bulkStatus("Overdue"), { iconName: "alert", tone: "danger", state: fb.state === "busy" ? "busy" : "idle" })}
            ${ghostButton("Delete", bulkDelete, { iconName: "trash", tone: "danger", state: fb.state === "busy" ? "busy" : "idle" })}
          `,
        })}
      </div>

      ${state.items.length
        ? html`<p class="kis-footnote">
            ${rows.length} of ${state.items.length} commitments shown · net position
            <span class="kis-num">${money(net, { exact: true })}</span>
          </p>`
        : nothing}

      ${renderModal(app, client)}
    </div>
  `;
}

// ── Commitment-specific styling (layered on the shared .kis system) ──────────
const COM_STYLE = html`
  <style>
    .kis-com .com-dir {
      display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
      width: 18px; height: 18px; border-radius: 5px; border: 1px solid;
    }
    .kis-com .com-dir--in { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 11%, transparent); }
    .kis-com .com-dir--out { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 40%, transparent); background: color-mix(in srgb, var(--gold) 11%, transparent); }
    .kis-com .com-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
    .kis-com .com-ceo { color: var(--gold); display: flex; flex: 0 0 auto; }
    .kis-com .com-progress-cell { display: flex; align-items: center; gap: 7px; padding-left: var(--s2); }
    .kis-com .com-pct { font-size: 9.5px; color: var(--fg-muted); min-width: 30px; text-align: right; }
    .kis-com .com-due { font-variant-numeric: tabular-nums; }
    .kis-com .com-due--danger { color: var(--danger); font-weight: 650; }
    .kis-com .com-due--warn { color: var(--warn); }
    .kis-com .com-due--gold { color: var(--gold); }
  </style>
`;
