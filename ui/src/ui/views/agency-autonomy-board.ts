/**
 * The delivery ⇄ autonomy split board.
 *
 * The owner's ask, verbatim: "our main projects and tasks kanban ... as well as
 * adding an autonomous kanban side by side with a toggle so tasks and projects
 * can be dragged into autonomy que and assigned to employees".
 *
 * Left half is the real delivery work (`agency.ops.projects.list` /
 * `.tasks.list` — 77 projects, ~2,850 tasks). Right half is the existing
 * autonomous work board on Daily Operations, rendered unchanged. Between them
 * sits the one act that has never existed in this product: handing a delivery
 * task to an AI employee.
 *
 * Three rules this file will not bend:
 *  - drag is an accelerator, never the only route. Every card carries a
 *    keyboard- and touch-reachable "Send to autonomy" control, and the bulk bar
 *    does the same for a selection.
 *  - nothing is handed over blind. The confirmation names the employee, its
 *    backend, its autonomy level *and the practical consequence of that level*,
 *    and whether autonomous execution is switched on at all.
 *  - an empty panel is never left ambiguous. "No tasks match this filter",
 *    "this build has no routing engine" and "we could not fetch it" are three
 *    different sentences, and the operator sees which one applies.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";
import { money, relativeTime } from "../controllers/agency-common";
import {
  AUTONOMY_LEVELS,
  describeAutonomy,
  type AgencyEmployee,
  type AgencyTaskSummary,
} from "../controllers/agency-operations";
import {
  DELIVERY_COLUMNS,
  DELIVERY_COLUMN_CAP,
  HANDOFF_ELIGIBLE_STATUSES,
  MAX_BATCH,
  addDeliveryTaskNote,
  applyRouting,
  beginTaskDrag,
  closeTaskDetail,
  loadRoutingPreview,
  openTaskDetail,
  setApplyArmed,
  setDeliveryTaskStatus,
  clearTaskSelection,
  closeHandoff,
  dismissAutonomyNotice,
  endTaskDrag,
  ensureAgencyAutonomyState,
  loadAgencyAutonomy,
  openHandoff,
  openWorkloadByWorker,
  setAutonomyFilter,
  setBoardMode,
  setDragOverAutonomy,
  setTasksSelected,
  submitHandoff,
  subscribeAutonomyUpdates,
  toggleTaskSelected,
  updateHandoff,
  visibleTasks,
  type AgencyAutonomyHost,
  type AgencyAutonomyState,
  type BoardMode,
  type EmployeeRecommendation,
} from "../controllers/agency-autonomy-board";
import { AGENCY_AUTONOMY_STYLES } from "./agency-autonomy-styles";
import type { Tab } from "../navigation";

/**
 * Custom drag type carried alongside `text/plain`.
 *
 * The autonomy board's own columns already accept drops of *work item* ids, so
 * a delivery task has to be distinguishable at `dragover` time — the drop
 * handler cannot read `text/plain` until the drop actually happens.
 */
export const DELIVERY_DRAG_TYPE = "application/x-agency-delivery-task";

const MODES: ReadonlyArray<{ key: BoardMode; label: string; hint: string }> = [
  { key: "delivery", label: "Delivery", hint: "Only the projects and tasks kanban." },
  { key: "split", label: "Side by side", hint: "Delivery and the autonomy board together." },
  { key: "autonomy", label: "Autonomy", hint: "Only the autonomous work board." },
];

const STATUS_TONE: Record<AgencyTaskSummary["status"], string> = {
  backlog: "",
  ready: "",
  in_progress: "gold",
  blocked: "crit",
  review: "warn",
  done: "ok",
  cancelled: "",
};

function dueLabel(value: number | null): string {
  if (!value) return "no due date";
  return value < Date.now() ? `overdue ${relativeTime(value)}` : `due ${relativeTime(value)}`;
}

/**
 * Autonomy, rendered as a consequence rather than an integer.
 *
 * Deliberately the same wording as the employee cards in Agency Operations
 * ("L2 BOUNDED — Auto-completes under $5,000") so the operator learns one
 * vocabulary, not two.
 */
function autonomyChip(employee: AgencyEmployee | undefined): TemplateResult {
  const described = describeAutonomy(employee?.autonomyLevel);
  if (!described) {
    return html`<span
      class="agx-autonomy unknown"
      title="This gateway did not report an autonomy level for this employee."
      ><b>Autonomy</b><i>not reported</i></span
    >`;
  }
  const bounded = described.level === 2 && typeof employee?.approvalThreshold === "number";
  return html`
    <span class="agx-autonomy ${described.tone}" title=${described.detail}>
      <b>L${described.level} ${described.label}</b>
      <i>
        ${bounded ? `Auto-completes under ${money(employee!.approvalThreshold!)}` : described.short}
      </i>
    </span>
  `;
}

/** The full-sentence consequence of an autonomy level, for the confirmation. */
function autonomyConsequence(employee: AgencyEmployee | undefined): string {
  const described = describeAutonomy(employee?.autonomyLevel);
  if (!described) {
    return "This gateway did not report an autonomy level, so what happens after a run cannot be predicted here.";
  }
  if (described.level === 2 && typeof employee?.approvalThreshold === "number") {
    return `${employee.name} completes this work unattended while estimated cost stays under ${money(employee.approvalThreshold)}; anything above escalates for approval.`;
  }
  const tail =
    AUTONOMY_LEVELS.find((entry) => entry.level === described.level)?.detail ?? described.short;
  return `${employee?.name ?? "This employee"} — ${tail}`;
}

// ── Mode switch ────────────────────────────────────────────────────────────

export function renderOpsSwitch(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
): TemplateResult {
  const unassigned = state.tasks.filter(
    (task) => !task.assigneeId && HANDOFF_ELIGIBLE_STATUSES.has(task.status),
  ).length;
  return html`
    <div class="agx-ops-switch">
      <span class="agx-ops-switch-title">
        <b>Operations command</b>
        <span>
          ${state.projects.length} project${state.projects.length === 1 ? "" : "s"} ·
          ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"} ·
          <strong>${unassigned} open with no owner</strong> · ${state.employees.length} AI
          employee${state.employees.length === 1 ? "" : "s"} available to take them
        </span>
      </span>
      <div class="agx-seg" role="group" aria-label="Which boards to show">
        ${MODES.map(
          (mode) => html`<button
            type="button"
            aria-pressed=${state.mode === mode.key ? "true" : "false"}
            title=${mode.hint}
            aria-label="Show ${mode.label} — ${mode.hint}"
            @click=${() => setBoardMode(host, mode.key)}
          >
            ${mode.label}
          </button>`,
        )}
      </div>
    </div>
  `;
}

// ── Delivery board ─────────────────────────────────────────────────────────

function renderToolbar(host: AgencyAutonomyHost, state: AgencyAutonomyState): TemplateResult {
  const projects = [...state.projects].sort((a, b) => a.name.localeCompare(b.name));
  return html`
    <div class="agx-dlv-tools">
      <div class="agx-form-field">
        <label for="agx-dlv-project">Project</label>
        <select
          id="agx-dlv-project"
          class="agx-select"
          aria-label="Filter delivery tasks by project"
          @change=${(event: Event) =>
            setAutonomyFilter(host, {
              projectFilter: (event.target as HTMLSelectElement).value,
            })}
        >
          <option value="" ?selected=${state.projectFilter === ""}>
            All projects (${projects.length})
          </option>
          ${projects.map(
            (project) => html`<option
              value=${project.id}
              ?selected=${project.id === state.projectFilter}
            >
              ${project.name}
            </option>`,
          )}
        </select>
      </div>
      <div class="agx-form-field">
        <label for="agx-dlv-search">Search</label>
        <input
          id="agx-dlv-search"
          class="agx-input"
          type="search"
          placeholder="Filter by task title"
          .value=${state.search}
          aria-label="Filter delivery tasks by title"
          @input=${(event: Event) =>
            setAutonomyFilter(host, { search: (event.target as HTMLInputElement).value })}
        />
      </div>
      <button
        type="button"
        class="agx-toggle"
        aria-pressed=${state.unassignedOnly ? "true" : "false"}
        aria-label="Show only tasks with no owner"
        title="The gap this board exists to close: open work nobody is on."
        @click=${() => setAutonomyFilter(host, { unassignedOnly: !state.unassignedOnly })}
      >
        Unowned only
      </button>
      <button
        type="button"
        class="agx-toggle"
        aria-pressed=${state.showDone ? "true" : "false"}
        aria-label="Include completed and cancelled tasks"
        @click=${() => setAutonomyFilter(host, { showDone: !state.showDone })}
      >
        Show closed
      </button>
    </div>
  `;
}

function renderBulkBar(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
  shown: AgencyTaskSummary[],
): TemplateResult | typeof nothing {
  const count = state.selectedTaskIds.size;
  const sendable = shown.filter((task) => HANDOFF_ELIGIBLE_STATUSES.has(task.status));
  if (count === 0) return nothing;
  return html`
    <div class="agx-bulk" role="status">
      <strong>${count} selected</strong>
      <span
        >${count > MAX_BATCH
          ? `Batches are capped at ${MAX_BATCH} — the first ${MAX_BATCH} go in this pass.`
          : "Sending creates one work item per task and records the owner on the delivery task."}</span
      >
      <span class="agx-bulk-spacer"></span>
      <button
        type="button"
        class="agx-btn tiny"
        aria-label="Select all ${sendable.length} visible tasks"
        @click=${() =>
          setTasksSelected(
            host,
            sendable.map((task) => task.id),
            true,
          )}
      >
        Select all shown
      </button>
      <button
        type="button"
        class="agx-btn tiny ghost"
        aria-label="Clear the selection"
        @click=${() => clearTaskSelection(host)}
      >
        Clear
      </button>
      <button
        type="button"
        class="agx-btn tiny authorize"
        aria-label="Send ${count} selected tasks to autonomy — opens a confirmation"
        @click=${() => openHandoff(host, client, [...state.selectedTaskIds])}
      >
        Send ${Math.min(count, MAX_BATCH)} to autonomy…
      </button>
    </div>
  `;
}

/**
 * The bridge. Present at all times — not only mid-drag — because a control that
 * only exists while a pointer is held down is invisible to a keyboard, and
 * because it is the thing this whole surface is for.
 */
function renderDropStrip(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
): TemplateResult {
  const count = state.selectedTaskIds.size;
  return html`
    <div
      class="agx-dropstrip ${state.dragOverAutonomy ? "is-over" : ""}"
      role="group"
      aria-label="Autonomy queue drop target. Drag delivery cards here, or use Send to autonomy on any card."
      @dragover=${(event: DragEvent) => {
        if (!event.dataTransfer?.types.includes(DELIVERY_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragOverAutonomy(host, true);
      }}
      @dragleave=${() => setDragOverAutonomy(host, false)}
      @drop=${(event: DragEvent) => {
        if (!event.dataTransfer?.types.includes(DELIVERY_DRAG_TYPE)) return;
        event.preventDefault();
        const ids = state.draggingTaskIds.length
          ? [...state.draggingTaskIds]
          : (event.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
        endTaskDrag(host);
        if (ids.length) openHandoff(host, client, ids);
      }}
    >
      <span class="agx-dropstrip-glyph" aria-hidden="true">◈</span>
      <span>
        <strong>Autonomy queue.</strong>
        Drop delivery cards here to hand them to an AI employee — or use
        <strong>Send to autonomy</strong> on any card, which works from the keyboard.
        Nothing runs until you authorise it.
      </span>
      <span class="agx-bulk-spacer"></span>
      <button
        type="button"
        class="agx-btn tiny"
        ?disabled=${count === 0}
        aria-label=${count === 0
          ? "Select tasks first to hand a batch to autonomy"
          : `Hand the ${count} selected tasks to autonomy`}
        title=${count === 0 ? "Tick one or more task cards first." : ""}
        @click=${() => openHandoff(host, client, [...state.selectedTaskIds])}
      >
        ${count === 0 ? "Select tasks to send" : `Send ${Math.min(count, MAX_BATCH)}…`}
      </button>
    </div>
  `;
}

/**
 * The engine's standing offer, on the board rather than buried in a dialog.
 *
 * `agency.ops.routing.preview` writes nothing, so the operator can always see
 * what the router *would* do with the backlog before deciding whether to let
 * it. Applying is the largest action on this surface — it can assign hundreds
 * of tasks — so it arms first and commits second, exactly like the approval
 * rows on Daily Operations.
 */
function renderRoutingBar(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  const routing = state.routing;
  if (routing.status === "unavailable") return nothing;
  const counts = routing.counts;
  const canApply = !!state.routingMethods.apply && routing.status === "ready";
  return html`
    <div class="agx-routebar ${routing.status === "failed" ? "is-bad" : ""}" role="status">
      <span class="agx-routebar-tag">Routing engine</span>
      <span class="agx-routebar-copy">
        ${routing.status === "loading" || routing.status === "idle"
          ? "Working out what it would assign…"
          : routing.status === "failed"
            ? `Dry run failed — ${routing.error}. Hand work over manually below; nothing is blocked.`
            : html`Dry run over the backlog:
                <strong>${counts?.assigned ?? 0}</strong> of ${counts?.candidates ?? 0} candidate
                tasks would be assigned, <strong>${counts?.needsHuman ?? 0}</strong> flagged for a
                human.${routing.enabled === false ? " The engine is switched OFF." : ""} Nothing
                written.`}
      </span>
      <span class="agx-bulk-spacer"></span>
      ${routing.status === "ready" || routing.status === "failed"
        ? html`<button
            type="button"
            class="agx-btn tiny ghost"
            aria-label="Re-run the routing dry run"
            @click=${() => void loadRoutingPreview(host, client)}
          >
            Re-run
          </button>`
        : nothing}
      ${canApply
        ? state.applyArmed
          ? html`<span class="agx-routebar-confirm" role="alertdialog" aria-label="Confirm routing">
              <span
                >Assign ${counts?.assigned ?? 0} tasks across the agency for real?</span
              >
              <button
                type="button"
                class="agx-btn tiny ghost"
                @click=${() => setApplyArmed(host, false)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="agx-btn tiny authorize"
                ?disabled=${state.applying}
                aria-label="Confirm — run the routing engine across the agency"
                @click=${() => void applyRouting(host, client)}
              >
                ${state.applying ? "Routing…" : "Yes, route them"}
              </button>
            </span>`
          : html`<button
              type="button"
              class="agx-btn tiny"
              ?disabled=${(counts?.assigned ?? 0) === 0}
              aria-label="Apply the routing engine across the whole agency"
              title=${(counts?.assigned ?? 0) === 0
                ? "The dry run proposed no assignments, so there is nothing to apply."
                : "Runs the router for real across every candidate task."}
              @click=${() => setApplyArmed(host, true)}
            >
              Auto-route the backlog…
            </button>`
        : nothing}
    </div>
  `;
}

function renderTaskCard(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
  task: AgencyTaskSummary,
  projectName: string,
  employeeNames: Map<string, string>,
): TemplateResult {
  const selected = state.selectedTaskIds.has(task.id);
  const dragging = state.draggingTaskIds.includes(task.id);
  const sendable = HANDOFF_ELIGIBLE_STATUSES.has(task.status);
  const owner = task.assigneeId ? (employeeNames.get(task.assigneeId) ?? task.assigneeId) : null;
  return html`
    <article
      class="agx-card agx-dlv-card p-${task.priority} ${selected ? "is-selected" : ""} ${dragging
        ? "is-dragging"
        : ""}"
      draggable=${sendable ? "true" : "false"}
      role="button"
      tabindex="0"
      aria-label="${task.title}. ${projectName}. Status ${task.status.replace(
        "_",
        " ",
      )}. ${owner ? `Owned by ${owner}` : "No owner"}. Open for full details."
      @click=${(event: MouseEvent) => {
        // Clicks on the checkbox or the Send button do their own thing; only a
        // click on the card body opens the record.
        if ((event.target as HTMLElement).closest("input,button,a,select,label")) return;
        openTaskDetail(host, task.id);
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if ((event.target as HTMLElement).closest("input,button,a,select,label")) return;
        event.preventDefault();
        openTaskDetail(host, task.id);
      }}
      @dragstart=${(event: DragEvent) => {
        const ids = beginTaskDrag(host, task.id);
        if (!event.dataTransfer) return;
        event.dataTransfer.setData("text/plain", ids.join(","));
        event.dataTransfer.setData(DELIVERY_DRAG_TYPE, ids.join(","));
        event.dataTransfer.effectAllowed = "copy";
      }}
      @dragend=${() => endTaskDrag(host)}
    >
      <div class="agx-dlv-head">
        <input
          type="checkbox"
          .checked=${selected}
          ?disabled=${!sendable}
          aria-label="Select ${task.title} for a batch handoff"
          @change=${() => toggleTaskSelected(host, task.id)}
        />
        <span class="agx-card-title">${task.title}</span>
      </div>
      <div class="agx-chips">
        <span
          class="agx-chip ${task.priority === "urgent"
            ? "crit"
            : task.priority === "high"
              ? "warn"
              : ""}"
          >${task.priority}</span
        >
        <span class="agx-chip ${owner ? "gold" : "warn"}">${owner ?? "no owner"}</span>
      </div>
      <span class="agx-card-meta">${projectName} · ${dueLabel(task.dueAt)}</span>
      ${sendable
        ? html`<button
            type="button"
            class="agx-btn tiny authorize"
            aria-label="Send ${task.title} to autonomy — opens a confirmation naming the employee and what it will do"
            @click=${() => openHandoff(host, client, [task.id])}
          >
            Send to autonomy…
          </button>`
        : nothing}
    </article>
  `;
}

/**
 * Why this panel never renders a bare empty column: on a board with 2,853 rows
 * behind three filters, "nothing here" is almost always the filter and almost
 * never the data. Saying which is the whole job.
 */
function renderDeliveryEmpty(host: AgencyAutonomyHost, state: AgencyAutonomyState): TemplateResult {
  const filtered =
    state.tasks.length > 0 &&
    (state.unassignedOnly || state.search.trim() !== "" || state.projectFilter !== "");
  return html`
    <div class="agx-empty inline">
      <span class="agx-empty-glyph" aria-hidden="true">${filtered ? "⌕" : "◇"}</span>
      <div class="agx-empty-copy">
        <strong>${filtered ? "No tasks match these filters" : "No delivery tasks"}</strong>
        <span>
          ${filtered
            ? `${state.tasks.length} tasks exist — the project, search and "unowned only" filters are hiding all of them.`
            : "This agency has no project tasks yet. Create a project and its tasks in Agency Operations and they appear here."}
        </span>
      </div>
      ${filtered
        ? html`<div class="agx-empty-actions">
            <button
              type="button"
              class="agx-btn primary"
              @click=${() =>
                setAutonomyFilter(host, {
                  projectFilter: "",
                  search: "",
                  unassignedOnly: false,
                })}
            >
              Clear filters
            </button>
          </div>`
        : nothing}
    </div>
  `;
}

export function renderDeliveryBoard(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
): TemplateResult {
  const shown = visibleTasks(state);
  const projectNames = new Map(state.projects.map((project) => [project.id, project.name] as const));
  const employeeNames = new Map(
    state.employees.map((employee) => [employee.id, employee.name] as const),
  );
  const byStatus = new Map<AgencyTaskSummary["status"], AgencyTaskSummary[]>();
  for (const task of shown) {
    const bucket = byStatus.get(task.status);
    if (bucket) bucket.push(task);
    else byStatus.set(task.status, [task]);
  }

  return html`
    <section class="agx-panel agx-board-panel">
      <header class="agx-panel-head">
        <span>Projects &amp; tasks</span>
        <span class="agx-count"
          >${shown.length} shown of ${state.tasks.length}${state.projectFilter
            ? ` · ${projectNames.get(state.projectFilter) ?? "project"}`
            : ""}</span
        >
        ${state.projectFilter
          ? html`<button
              type="button"
              class="agx-btn tiny agx-panel-act authorize"
              aria-label="Hand every open task in this project to autonomy"
              @click=${() =>
                openHandoff(
                  host,
                  client,
                  shown.map((task) => task.id),
                  {
                    projectId: state.projectFilter,
                    projectName: projectNames.get(state.projectFilter) ?? null,
                  },
                )}
            >
              Send whole project…
            </button>`
          : nothing}
      </header>
      ${renderToolbar(host, state)} ${renderDropStrip(host, state, client)}
      ${renderRoutingBar(host, state, client)} ${renderBulkBar(host, state, client, shown)}
      ${shown.length === 0
        ? html`<div style="padding:10px 11px 11px">${renderDeliveryEmpty(host, state)}</div>`
        : html`
            <div class="agx-board">
              ${DELIVERY_COLUMNS.filter(
                (column) => column.key !== "done" || state.showDone,
              ).map((column) => {
                const items = byStatus.get(column.key) ?? [];
                const visible = items.slice(0, DELIVERY_COLUMN_CAP);
                const selectable = items.filter((task) =>
                  HANDOFF_ELIGIBLE_STATUSES.has(task.status),
                );
                return html`
                  <div
                    class="agx-col"
                    role="group"
                    aria-label="${column.label} — ${items.length} task${items.length === 1
                      ? ""
                      : "s"}. ${column.hint}"
                  >
                    <div class="agx-col-head">
                      <span>${column.label}</span>
                      <span class="agx-col-n">${items.length}</span>
                    </div>
                    <div class="agx-col-hint">${column.hint}</div>
                    <div class="agx-col-body">
                      ${selectable.length > 1
                        ? html`<button
                            type="button"
                            class="agx-btn tiny ghost"
                            aria-label="Select all ${selectable.length} ${column.label} tasks"
                            @click=${() =>
                              setTasksSelected(
                                host,
                                selectable.map((task) => task.id),
                                true,
                              )}
                          >
                            Select ${selectable.length}
                          </button>`
                        : nothing}
                      ${visible.length === 0
                        ? html`<div class="agx-col-empty">none in this filter</div>`
                        : visible.map((task) =>
                            renderTaskCard(
                              host,
                              state,
                              client,
                              task,
                              projectNames.get(task.projectId) ?? "Unlinked project",
                              employeeNames,
                            ),
                          )}
                      ${items.length > visible.length
                        ? html`<div class="agx-col-empty">
                            +${items.length - visible.length} more — narrow the filter
                          </div>`
                        : nothing}
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
    </section>
  `;
}

// ── Handoff confirmation ───────────────────────────────────────────────────

function renderCandidate(
  host: AgencyAutonomyHost,
  employee: AgencyEmployee,
  recommendation: EmployeeRecommendation | undefined,
  picked: boolean,
  top: boolean,
  openItems: number,
  showScore: boolean,
): TemplateResult {
  // Repeating an identical "meets all constraints" sentence down eleven rows is
  // noise; the reasons only earn their line when they actually differ.
  const why = !recommendation
    ? "not scored by the suitability service"
    : showScore
      ? recommendation.reasons.join("; ")
      : !recommendation.eligible
        ? recommendation.reasons.join("; ")
        : `${employee.department || "no department"}`;
  return html`
    <label class="agx-cand ${picked ? "is-picked" : ""} ${top ? "is-top" : ""}">
      <input
        type="radio"
        name="agx-handoff-worker"
        class="agx-handoff-worker"
        .checked=${picked}
        aria-label="Assign to ${employee.name}, ${employee.role}"
        @change=${() => updateHandoff(host, { workerId: employee.id })}
      />
      <span class="agx-cand-body">
        <span class="agx-cand-name">
          ${employee.name} <em>${employee.role}</em> ${autonomyChip(employee)}
        </span>
        <span class="agx-cand-why">
          ${employee.modelBinding ?? employee.model ?? "no backend resolved"} · ${openItems} open
          item${openItems === 1 ? "" : "s"} · ${Math.round(employee.utilizationPercent)}% of
          ${employee.capacityHours}h · ${why}
        </span>
      </span>
      <span class="agx-cand-rank"
        >${recommendation && showScore
          ? `${top ? "best " : ""}${recommendation.score}`
          : `${openItems} open`}</span
      >
    </label>
  `;
}

/**
 * The routing engine's dry run.
 *
 * Four distinct states, four distinct sentences. "Unavailable" in particular
 * must never look like "the engine had no suggestions" — that is exactly the
 * kind of ambiguity that let a total data outage hide on these pages.
 */
function renderRouting(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
  /** Restricts the rows to one batch; omitted on the board-level summary. */
  scopeTaskIds?: readonly string[],
): TemplateResult {
  const routing = state.routing;
  const names = new Map(state.employees.map((employee) => [employee.id, employee.name] as const));
  const scope = scopeTaskIds ? new Set(scopeTaskIds) : null;
  const rows = scope
    ? routing.decisions.filter((decision) => decision.taskId && scope.has(decision.taskId))
    : routing.decisions;
  const counts = routing.counts;
  return html`
    <div class="agx-routing">
      <div class="agx-routing-head">
        <span>Routing engine — dry run</span>
        ${routing.method ? html`<span style="opacity:.7">${routing.method}</span>` : nothing}
        ${routing.status === "ready" || routing.status === "failed"
          ? html`<button
              type="button"
              class="agx-btn tiny ghost"
              style="margin-left:auto"
              aria-label="Re-run the routing preview"
              @click=${() => void loadRoutingPreview(host, client)}
            >
              Re-run
            </button>`
          : nothing}
      </div>
      ${routing.status === "unavailable"
        ? html`<span class="agx-cand-why">
            This gateway build does not serve a routing engine, so there is no automatic plan to
            preview. Pick the employee yourself — the handoff works exactly the same.
          </span>`
        : routing.status === "loading" || routing.status === "idle"
          ? html`<span class="agx-cand-why">Asking the engine what it would do…</span>`
          : routing.status === "failed"
            ? html`<span class="agx-cand-why">
                The routing preview failed: ${routing.error}. Choosing an employee by hand is
                unaffected.
              </span>`
            : html`
                <span class="agx-cand-why">
                  ${routing.enabled === false
                    ? "The engine is switched OFF for this agency — this is what it would do if enabled. "
                    : ""}Over the whole agency it would assign
                  <b>${counts?.assigned ?? 0}</b> of <b>${counts?.candidates ?? 0}</b> candidate
                  tasks, leave <b>${counts?.unmatched ?? 0}</b> unmatched and flag
                  <b>${counts?.needsHuman ?? 0}</b> for a human.${counts?.autoStaged
                    ? ` ${counts.autoStaged} would be auto-staged (mode ${routing.mode ?? "unknown"}).`
                    : ""}
                  Nothing has been written.
                </span>
                ${rows.length === 0
                  ? html`<span class="agx-cand-why">
                      ${scope
                        ? "The engine proposed nothing for the tasks in this batch — it has no opinion here, so the pick above is yours alone."
                        : "The engine proposed no assignments at all in this pass."}
                    </span>`
                  : html`
                      <div class="agx-routing-rows">
                        ${rows.slice(0, 40).map(
                          (decision) => html`
                            <div class="agx-routing-row">
                              <span><b>${decision.taskTitle ?? decision.taskId ?? "task"}</b></span>
                              <span
                                >${decision.workerName ??
                                (decision.workerId ? names.get(decision.workerId) : null) ??
                                "no worker — needs a human"}</span
                              >
                              <span
                                >${decision.rationale ?? "no rationale reported"}${decision.confidence !==
                                null
                                  ? ` (${Math.round(decision.confidence * 100)}% confidence)`
                                  : ""}</span
                              >
                            </div>
                          `,
                        )}
                      </div>
                      ${rows.length > 40
                        ? html`<span class="agx-cand-why"
                            >+${rows.length - 40} more decisions not shown.</span
                          >`
                        : nothing}
                    `}
              `}
    </div>
  `;
}

export function renderHandoffDialog(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  const handoff = state.handoff;
  if (!handoff) return nothing;
  const tasks = handoff.taskIds
    .map((id) => state.tasks.find((task) => task.id === id))
    .filter((task): task is AgencyTaskSummary => !!task);
  const employee = state.employees.find((entry) => entry.id === handoff.workerId);
  const byScore = new Map(handoff.recommendations.map((entry) => [entry.workerId, entry] as const));
  const load = openWorkloadByWorker(state);
  const ordered = [...state.employees].sort(
    (a, b) =>
      (byScore.get(b.id)?.score ?? -1) - (byScore.get(a.id)?.score ?? -1) ||
      (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0),
  );
  // A "best" badge is only worth showing when suitability actually separated
  // the roster. Legacy delivery tasks carry no skill requirements, so every
  // active worker scores identically — and a badge on whoever the roster
  // happened to list first is worse than no badge, because it looks considered.
  const distinctScores = new Set(handoff.recommendations.map((entry) => entry.score));
  const discriminating = distinctScores.size > 1;
  const topId = discriminating ? (ordered[0]?.id ?? null) : null;
  const count = handoff.taskIds.length;
  const progress = handoff.progress;

  return html`
    <div
      class="agx-modal-scrim"
      @click=${(event: Event) => {
        if (event.target === event.currentTarget && !handoff.submitting) closeHandoff(host);
      }}
    >
      <div
        class="agx-modal agx-handoff"
        role="dialog"
        aria-modal="true"
        aria-label="Hand ${count} delivery task${count === 1 ? "" : "s"} to an AI employee"
      >
        <h2>Send to autonomy</h2>
        <div class="agx-modal-body">
          <div>
            Handing <strong>${count} delivery task${count === 1 ? "" : "s"}</strong>${handoff.projectName
              ? html` from <strong>${handoff.projectName}</strong>`
              : nothing}
            to an AI employee. Each becomes one work item, and the delivery task records its new
            owner.
          </div>
          <div class="agx-handoff-list" role="list" aria-label="Tasks in this handoff">
            ${tasks.slice(0, 8).map((task) => html`<span role="listitem">${task.title}</span>`)}
            ${tasks.length > 8
              ? html`<span role="listitem">+${tasks.length - 8} more</span>`
              : nothing}
          </div>

          <div class="agx-form-field">
            <label id="agx-cands-label">
              Who takes it on${handoff.recommendationsLoading
                ? " — ranking employees…"
                : discriminating
                  ? " — ranked by suitability, capacity and current load"
                  : ""}
            </label>
            ${!handoff.recommendationsLoading &&
            handoff.recommendations.length > 1 &&
            !discriminating
              ? html`<div class="agx-note">
                  Suitability scored every employee identically
                  (${[...distinctScores][0] ?? 0}/100): these delivery tasks carry no skill or
                  capability requirements to score against, and nobody is near capacity. Ranked by
                  open workload instead — <strong>this is not a recommendation</strong>, pick on
                  role and autonomy level.
                </div>`
              : nothing}
            ${handoff.recommendationsError
              ? html`<div class="agx-note warn">${handoff.recommendationsError}</div>`
              : nothing}
            ${ordered.length === 0
              ? html`<div class="agx-note warn">
                  No active AI employees to hand work to. Hire one in Agency Operations first.
                </div>`
              : html`<div class="agx-cands" role="radiogroup" aria-labelledby="agx-cands-label">
                  ${ordered.map((entry) =>
                    renderCandidate(
                      host,
                      entry,
                      byScore.get(entry.id),
                      entry.id === handoff.workerId,
                      entry.id === topId && byScore.has(entry.id),
                      load.get(entry.id) ?? 0,
                      discriminating,
                    ),
                  )}
                </div>`}
          </div>

          <div class="agx-form-row">
            <div class="agx-form-field">
              <label for="agx-handoff-priority">Priority</label>
              <select
                id="agx-handoff-priority"
                class="agx-select"
                @change=${(event: Event) =>
                  updateHandoff(host, {
                    priority: (event.target as HTMLSelectElement)
                      .value as typeof handoff.priority,
                  })}
              >
                ${(["low", "normal", "high", "urgent"] as const).map(
                  (value) => html`<option value=${value} ?selected=${value === handoff.priority}>
                    ${value}
                  </option>`,
                )}
              </select>
            </div>
            <div class="agx-form-field">
              <label for="agx-handoff-authorize">Authorisation</label>
              <button
                id="agx-handoff-authorize"
                type="button"
                class="agx-toggle"
                aria-pressed=${handoff.authorizeNow ? "true" : "false"}
                aria-label="Stage immediately — authorises autonomous execution without a second step"
                @click=${() => updateHandoff(host, { authorizeNow: !handoff.authorizeNow })}
              >
                ${handoff.authorizeNow ? "Stage & authorise now" : "Queue in backlog only"}
              </button>
            </div>
          </div>

          <div class="agx-form-field">
            <label for="agx-handoff-instructions">Instructions (optional)</label>
            <textarea
              id="agx-handoff-instructions"
              class="agx-textarea"
              .value=${handoff.instructions}
              placeholder="Applied to every task in this batch. Leave blank to use the task's own project context."
              @input=${(event: Event) =>
                updateHandoff(host, {
                  instructions: (event.target as HTMLTextAreaElement).value,
                })}
            ></textarea>
          </div>

          ${renderConsequence(state, employee, handoff.authorizeNow)}
          ${renderRouting(host, state, client, handoff.taskIds)}
          ${progress
            ? html`<div class="agx-progress" role="status">
                <span>${progress.done + progress.failed} / ${progress.total}</span>
                <span class="agx-progress-track">
                  <span
                    class="agx-progress-fill"
                    style="width:${Math.round(
                      ((progress.done + progress.failed) / Math.max(1, progress.total)) * 100,
                    )}%"
                  ></span>
                </span>
                ${progress.failed ? html`<span>${progress.failed} failed</span>` : nothing}
              </div>`
            : nothing}
          ${handoff.error ? html`<div class="agx-note warn">${handoff.error}</div>` : nothing}
        </div>
        <div class="agx-modal-foot">
          <button
            type="button"
            class="agx-btn ghost"
            ?disabled=${handoff.submitting}
            aria-label="Cancel — hand nothing over"
            @click=${() => closeHandoff(host)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="agx-btn authorize"
            style="width:auto"
            ?disabled=${handoff.submitting || !handoff.workerId}
            aria-label="Hand ${count} task${count === 1 ? "" : "s"} to ${employee?.name ??
            "the selected employee"}"
            @click=${() => void submitHandoff(host, client)}
          >
            ${handoff.submitting
              ? "Sending…"
              : handoff.authorizeNow
                ? `Send & authorise ${count}`
                : `Send ${count} to backlog`}
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * "What will actually happen" — the block the operator reads before committing.
 *
 * Three facts decide the answer and all three are on screen: the employee's
 * autonomy level, whether this batch is authorised now, and whether the
 * executor is globally switched on. Any one of them can make the other two
 * irrelevant, which is precisely why none of them may be left implicit.
 */
function renderConsequence(
  state: AgencyAutonomyState,
  employee: AgencyEmployee | undefined,
  authorizeNow: boolean,
): TemplateResult {
  if (!employee) {
    return html`<div class="agx-note warn">Pick an employee to see what autonomy will do.</div>`;
  }
  const backend = employee.modelBinding ?? employee.model ?? "no backend resolved";
  if (!state.executionsLoaded) {
    return html`<div class="agx-note">
      ${autonomyConsequence(employee)} Backend: <code>${backend}</code>. Whether autonomous
      execution is switched on could not be read from this gateway — treat "will run" as unknown.
    </div>`;
  }
  if (!state.executorEnabled) {
    return html`<div class="agx-note warn">
      <strong>Autonomous execution is OFF.</strong> ${authorizeNow
        ? "These will be staged and your authorisation recorded, but"
        : "These land in Backlog, and even once staged"}
      <strong>nothing will run</strong> until
      <code>cron.agencyOperatingLoop.executeWorkItems</code> is enabled.
      ${autonomyConsequence(employee)}
    </div>`;
  }
  if (!authorizeNow) {
    return html`<div class="agx-note">
      <strong>Autonomous execution is ON</strong>, but these land in <strong>Backlog</strong> — the
      executor only ever picks work up from <strong>Staged</strong>, so nothing runs until you
      authorise it on the autonomy board. When you do: ${autonomyConsequence(employee)} Backend:
      <code>${backend}</code>.
    </div>`;
  }
  return html`<div class="agx-note ok">
    <strong>These will run.</strong> Autonomous execution is on and you are staging them now, so on
    the next loop tick ${employee.name} spawns <code>${backend}</code> and starts work.
    ${autonomyConsequence(employee)}
  </div>`;
}

// ── Delivery task detail modal ─────────────────────────────────────────────

/** Human label for a delivery column key, reused from the column definitions. */
function deliveryStatusLabel(status: AgencyTaskSummary["status"]): string {
  return DELIVERY_COLUMNS.find((column) => column.key === status)?.label ?? status;
}

/**
 * The full record for one delivery task — everything the thin card omits, plus
 * the three things you would leave the board to do: hand it to an employee,
 * move it between columns, and pin a note. Assignment reuses the handoff dialog
 * rather than a second, divergent picker.
 */
export function renderDeliveryTaskModal(
  host: AgencyAutonomyHost,
  state: AgencyAutonomyState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  const taskId = state.taskDetailId;
  if (!taskId) return nothing;
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return nothing;
  const raw = state.rawTasks[taskId];
  const project = state.projects.find((entry) => entry.id === task.projectId);
  const rawProject = state.rawProjects[task.projectId];
  const owner = task.assigneeId
    ? (state.employees.find((entry) => entry.id === task.assigneeId)?.name ?? task.assigneeId)
    : null;
  const sendable = HANDOFF_ELIGIBLE_STATUSES.has(task.status);
  const busy = state.taskDetailBusy;
  const siblingCount = state.tasks.filter(
    (entry) => entry.projectId === task.projectId && entry.id !== task.id,
  ).length;
  const setTab = (host as { setTab?: (tab: Tab) => void }).setTab;

  return html`
    <div
      class="agx-modal-scrim"
      @click=${(event: Event) => {
        if (event.target === event.currentTarget && !busy) closeTaskDetail(host);
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape" && !busy) closeTaskDetail(host);
      }}
    >
      <div class="agx-modal" role="dialog" aria-modal="true" aria-label="Details for ${task.title}">
        <h2>${task.title}</h2>
        <div class="agx-modal-body">
          <dl>
            <dt>Project</dt>
            <dd>${project?.name ?? "Unlinked project"}</dd>
            <dt>Status</dt>
            <dd>${deliveryStatusLabel(task.status)}</dd>
            <dt>Priority</dt>
            <dd>${task.priority}</dd>
            <dt>Due</dt>
            <dd>${dueLabel(task.dueAt)}</dd>
            <dt>Owner</dt>
            <dd>${owner ?? "no owner"}</dd>
            ${raw?.tags?.length
              ? html`<dt>Tags</dt>
                  <dd>${raw.tags.join(", ")}</dd>`
              : nothing}
            ${rawProject && typeof rawProject.progress === "number"
              ? html`<dt>Project progress</dt>
                  <dd>${rawProject.progress}%${siblingCount
                    ? ` · ${siblingCount} sibling task${siblingCount === 1 ? "" : "s"}`
                    : ""}</dd>`
              : nothing}
            ${rawProject?.businessId
              ? html`<dt>Client link</dt>
                  <dd>${rawProject.businessId}</dd>`
              : nothing}
          </dl>

          ${raw?.description
            ? html`<div class="agx-note" style="white-space:pre-wrap">${raw.description}</div>`
            : html`<div class="agx-note">No description recorded for this task.</div>`}

          <!-- Assignment: reuse the handoff dialog rather than a second picker. -->
          <div class="agx-form-field">
            <label>Assignment</label>
            <div style="display:flex;gap:7px;flex-wrap:wrap">
              <button
                type="button"
                class="agx-btn tiny authorize"
                ?disabled=${!sendable || busy}
                title=${sendable
                  ? "Open the handoff dialog to assign or reassign an AI employee"
                  : "Closed and cancelled tasks cannot be handed to autonomy"}
                aria-label="Assign or reassign ${task.title} to an AI employee"
                @click=${() => {
                  closeTaskDetail(host);
                  openHandoff(host, client, [task.id]);
                }}
              >
                ${owner ? "Reassign to an employee…" : "Assign to an employee…"}
              </button>
              ${setTab
                ? html`<button
                    type="button"
                    class="agx-btn tiny ghost"
                    aria-label="Open this project in the Projects board"
                    @click=${() => {
                      closeTaskDetail(host);
                      setTab("projects");
                    }}
                  >
                    Open in projects
                  </button>`
                : nothing}
            </div>
          </div>

          <!-- Quick action: move between delivery columns. -->
          <div class="agx-form-field">
            <label for="agx-task-status">Change status</label>
            <select
              id="agx-task-status"
              class="agx-select"
              .value=${task.status}
              ?disabled=${busy}
              aria-label="Move ${task.title} to another column"
              @change=${(event: Event) => {
                const value = (event.target as HTMLSelectElement).value as AgencyTaskSummary["status"];
                void setDeliveryTaskStatus(host, client, task.id, value);
              }}
            >
              ${DELIVERY_COLUMNS.map(
                (column) => html`<option value=${column.key} ?selected=${column.key === task.status}>
                  ${column.label}
                </option>`,
              )}
            </select>
          </div>

          <!-- Quick action: pin a note into the shared description. -->
          <div class="agx-form-field">
            <label for="agx-task-note">Add a note</label>
            <textarea
              id="agx-task-note"
              class="agx-textarea"
              placeholder="Context, a decision, a blocker — folded into the task description."
              ?disabled=${busy}
            ></textarea>
            <div>
              <button
                type="button"
                class="agx-btn tiny"
                ?disabled=${busy}
                aria-label="Add the note to ${task.title}"
                @click=${() => {
                  const field = document.querySelector<HTMLTextAreaElement>("#agx-task-note");
                  const note = field?.value ?? "";
                  if (field) field.value = "";
                  void addDeliveryTaskNote(host, client, task.id, note);
                }}
              >
                Add note
              </button>
            </div>
          </div>
        </div>
        <div class="agx-modal-foot">
          <button
            type="button"
            class="agx-btn ghost"
            ?disabled=${busy}
            aria-label="Close the task details"
            @click=${() => closeTaskDetail(host)}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Surface entry point ────────────────────────────────────────────────────

/**
 * Everything this module contributes to Daily Operations, in one call: styles,
 * the mode switch, the delivery half and the confirmation dialog. The autonomy
 * half stays the existing `renderBoard` on that surface, untouched.
 */
export function renderAutonomyCommand(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
  renderAutonomyHalf: () => TemplateResult,
): TemplateResult {
  const state = ensureAgencyAutonomyState(host);
  subscribeAutonomyUpdates(host, client);
  if (!state.lastLoadedAt && !state.loading) {
    queueMicrotask(() => void loadAgencyAutonomy(host, client));
  }

  const showDelivery = state.mode !== "autonomy";
  const showAutonomy = state.mode !== "delivery";
  return html`
    ${AGENCY_AUTONOMY_STYLES} ${renderOpsSwitch(host, state)}
    ${state.notice
      ? html`<div class="agx-notice" role="status">
          <span>${state.notice}</span>
          <button
            type="button"
            class="agx-btn tiny ghost"
            aria-label="Dismiss confirmation"
            @click=${() => dismissAutonomyNotice(host)}
          >
            Dismiss
          </button>
        </div>`
      : nothing}
    ${state.error ? html`<div class="agx-banner" role="alert">${state.error}</div>` : nothing}
    ${state.failedRequests.length
      ? html`<div class="agx-banner" role="status">
          <strong
            >${state.failedRequests.length} request(s) failed — the boards below may be
            incomplete.</strong
          >
          <ul>
            ${state.failedRequests.map((entry) => html`<li>${entry}</li>`)}
          </ul>
        </div>`
      : nothing}
    ${state.loading && !state.lastLoadedAt
      ? html`<div class="agx-skel" aria-busy="true" aria-label="Loading projects and tasks">
          <div class="agx-skel-bar" style="width:40%"></div>
          <div class="agx-skel-bar tall"></div>
        </div>`
      : html`
          <div class="agx-ops-split ${showDelivery && showAutonomy ? "is-split" : ""}">
            ${showDelivery ? renderDeliveryBoard(host, state, client) : nothing}
            ${showAutonomy ? renderAutonomyHalf() : nothing}
          </div>
        `}
    ${renderHandoffDialog(host, state, client)} ${renderDeliveryTaskModal(host, state, client)}
  `;
}
