/**
 * Work-allocation oversight board — the live mission-control surface.
 *
 * One screen answers "what is every autonomous workflow doing right now": the
 * live autonomy Kanban (reused verbatim from Daily Operations), the agents
 * currently executing, the human gate (approvals + escalations) and a live
 * activity timeline. It reads off the shared `agencyDailyState` so the board
 * here and the board on Daily Operations are the same board, not two copies.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";
import { relativeTime } from "../controllers/agency-common";
import type {
  AgencyAuditEvent,
  EmployeeWorkItem,
} from "../controllers/agency-operations";
import {
  AUTONOMY_STAGE,
  resolveDailyApproval,
  setApprovalIntent,
  type AgencyDailyState,
  type WorkItemExecutionView,
} from "../controllers/agency-daily";
import {
  loadAgencyOversight,
  subscribeAgencyOversight,
  type AgencyEscalation,
  type AgencyOversightHost,
  type AgencyOversightState,
} from "../controllers/agency-oversight";
import {
  DELIVERY_DRAG_TYPE,
  renderDeliveryTaskModal,
  renderHandoffDialog,
} from "./agency-autonomy-board";
import {
  HANDOFF_ELIGIBLE_STATUSES,
  beginTaskDrag,
  endTaskDrag,
  ensureAgencyAutonomyState,
  loadAgencyAutonomy,
  openHandoff,
  setDragOverAutonomy,
  subscribeAutonomyUpdates,
  type AgencyAutonomyHost,
} from "../controllers/agency-autonomy-board";
import type { AgencyEmployee, AgencyTaskSummary } from "../controllers/agency-operations";
import { AGENCY_SURFACE_STYLES } from "./agency-surface-styles";
import { renderBoard, renderDailyBoardOverlays } from "./agency-daily";

function riskTone(risk: string | null): string {
  const value = (risk ?? "").toLowerCase();
  return value === "high" || value === "critical"
    ? "crit"
    : value === "medium"
      ? "warn"
      : "";
}

/** Running executions, newest work first — the "who is working now" lane. */
function runningExecutions(daily: AgencyDailyState): WorkItemExecutionView[] {
  return Object.values(daily.executions).filter((view) => view.stage === "in_progress");
}

function workItemTitle(daily: AgencyDailyState, id: string): string {
  return daily.workItems.find((item) => item.id === id)?.title ?? "Untitled work item";
}

// ── Regions ─────────────────────────────────────────────────────────────────

function renderLiveAgents(daily: AgencyDailyState): TemplateResult {
  const running = runningExecutions(daily);
  return html`
    <section class="agx-panel">
      <header class="agx-panel-head">
        <span>Live agents</span>
        <span class="agx-count">${running.length} running</span>
      </header>
      <div class="agx-panel-body">
        ${running.length === 0
          ? html`<div class="agx-empty inline">
              <span class="agx-empty-glyph" aria-hidden="true">◎</span>
              <div class="agx-empty-copy">
                <strong>No agent is executing right now</strong>
                <span>Stage a card into the authorised column and the assigned AI employee
                  starts here on the next loop tick.</span>
              </div>
            </div>`
          : running.map((view) => {
              const outcome =
                view.terminalStage === "completed"
                  ? "auto-completes"
                  : view.terminalStage === "review"
                    ? "stops in Review"
                    : null;
              return html`
                <div class="agx-row has-actions">
                  <span class="agx-tag gold">running</span>
                  <span class="agx-row-main">
                    <span class="agx-row-title">${workItemTitle(daily, view.workItemId)}</span>
                    <span class="agx-row-meta"
                      >${view.workerName} · ${view.backend ?? "no backend"} · autonomy
                      L${view.autonomyLevel}${outcome ? ` · ${outcome}` : ""}</span
                    >
                    ${view.blockedReason
                      ? html`<span class="agx-card-blocked" role="note"
                          >${view.blockedReason}</span
                        >`
                      : nothing}
                  </span>
                </div>
              `;
            })}
      </div>
    </section>
  `;
}

function renderApprovals(
  host: AgencyOversightHost,
  daily: AgencyDailyState,
  client: GatewayBrowserClient,
): TemplateResult {
  const intent = daily.approvalIntent;
  return html`
    <section class="agx-panel">
      <header class="agx-panel-head">
        <span>Approvals waiting</span>
        <span class="agx-count">${daily.approvals.length}</span>
      </header>
      <div class="agx-panel-body">
        ${daily.approvals.length === 0
          ? html`<div class="agx-empty inline">
              <span class="agx-empty-glyph" aria-hidden="true">✓</span>
              <div class="agx-empty-copy">
                <strong>Nothing is waiting on you</strong>
                <span>Spend, outbound and deliverables above a worker's threshold land here.</span>
              </div>
            </div>`
          : daily.approvals.map((approval) => {
              const armed = intent?.approvalId === approval.id;
              const busy = daily.busyApprovalId === approval.id;
              return html`
                <div class="agx-row has-actions">
                  <span class="agx-tag ${riskTone(approval.risk)}">${approval.risk}</span>
                  <span class="agx-row-main">
                    <span class="agx-row-title">${approval.title}</span>
                    <span class="agx-row-meta"
                      >${approval.type} · ${relativeTime(approval.requestedAt)}${approval.engagementName
                        ? ` · ${approval.engagementName}`
                        : ""}</span
                    >
                  </span>
                  <span class="agx-row-actions">
                    <button
                      type="button"
                      class="agx-btn tiny ok"
                      ?disabled=${busy}
                      aria-label="Approve ${approval.title}"
                      @click=${() =>
                        setApprovalIntent(host, { approvalId: approval.id, decision: "approved" })}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      class="agx-btn tiny danger"
                      ?disabled=${busy}
                      aria-label="Reject ${approval.title}"
                      @click=${() =>
                        setApprovalIntent(host, { approvalId: approval.id, decision: "rejected" })}
                    >
                      Reject
                    </button>
                  </span>
                  ${armed
                    ? html`<div class="agx-confirm" role="alertdialog" aria-label="Confirm decision">
                        <span
                          >${intent?.decision === "approved" ? "Approve" : "Reject"}
                          <strong>${approval.title}</strong>? This cannot be undone here.</span
                        >
                        <span class="agx-confirm-actions">
                          <button
                            type="button"
                            class="agx-btn tiny ghost"
                            @click=${() => setApprovalIntent(host, null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            class="agx-btn tiny ${intent?.decision === "approved" ? "ok" : "danger"}"
                            ?disabled=${busy}
                            @click=${() => void resolveDailyApproval(host, client)}
                          >
                            ${busy
                              ? "Saving…"
                              : intent?.decision === "approved"
                                ? "Yes, approve"
                                : "Yes, reject"}
                          </button>
                        </span>
                      </div>`
                    : nothing}
                </div>
              `;
            })}
      </div>
    </section>
  `;
}

/**
 * Open escalations. Prefers the dedicated RPC feed; when that is unavailable on
 * the gateway it falls back to escalated work items already on the board so the
 * panel is never blank while the Kanban shows an Escalated column with cards.
 */
function renderEscalations(
  daily: AgencyDailyState,
  oversight: AgencyOversightState,
): TemplateResult {
  const names = new Map(daily.employees.map((employee) => [employee.id, employee.name] as const));
  // When the dedicated escalations feed is empty (absent on this gateway build,
  // or genuinely nothing raised), derive the panel from work items parked in the
  // Escalated column so it never contradicts that column on the board.
  const fallback: AgencyEscalation[] =
    oversight.escalations.length === 0
      ? daily.workItems
          .filter((item) => item.status === "escalated")
          .map((item) => ({
            id: item.id,
            title: item.title,
            workItemId: item.id,
            workerId: item.workerId,
            workerName: names.get(item.workerId) ?? item.workerId,
            reason: item.waitingReason,
            risk: item.escalationLevel >= 2 ? "high" : "medium",
            level: item.escalationLevel,
            createdAt: item.updatedAt,
          }))
      : [];
  const list = oversight.escalations.length ? oversight.escalations : fallback;
  return html`
    <section class="agx-panel">
      <header class="agx-panel-head">
        <span>Escalations</span>
        <span class="agx-count">${list.length} open</span>
      </header>
      <div class="agx-panel-body">
        ${list.length === 0
          ? html`<div class="agx-empty inline">
              <span class="agx-empty-glyph" aria-hidden="true">△</span>
              <div class="agx-empty-copy">
                <strong>Nothing is off track</strong>
                <span>SLA breaches and failed runs surface here for a human to unblock.</span>
              </div>
            </div>`
          : list.map(
              (escalation) => html`
                <div class="agx-row">
                  <span class="agx-tag ${riskTone(escalation.risk)}"
                    >${escalation.risk ?? (escalation.level ? `L${escalation.level}` : "open")}</span
                  >
                  <span class="agx-row-main">
                    <span class="agx-row-title">${escalation.title}</span>
                    <span class="agx-row-meta"
                      >${escalation.workerName ??
                      (escalation.workerId ? names.get(escalation.workerId) : null) ??
                      "unassigned"}${escalation.reason ? ` · ${escalation.reason}` : ""}${escalation.createdAt
                        ? ` · ${relativeTime(escalation.createdAt)}`
                        : ""}</span
                    >
                  </span>
                </div>
              `,
            )}
      </div>
    </section>
  `;
}

/** A one-line, human-readable label for one audit row. */
function auditLabel(event: AgencyAuditEvent): string {
  const action = event.action.replace(/[._]/g, " ");
  const entity = event.entityType.replace(/[._]/g, " ");
  return `${action} · ${entity}`;
}

function renderTimeline(events: AgencyAuditEvent[]): TemplateResult {
  const ordered = [...events].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
  return html`
    <section class="agx-panel">
      <header class="agx-panel-head">
        <span>Activity timeline</span>
        <span class="agx-count">${events.length} events</span>
      </header>
      <div class="agx-panel-body agx-timeline">
        ${ordered.length === 0
          ? html`<div class="agx-empty inline">
              <span class="agx-empty-glyph" aria-hidden="true">≋</span>
              <div class="agx-empty-copy">
                <strong>No activity recorded yet</strong>
                <span>Every stage change, approval and run writes an audit row that streams
                  here.</span>
              </div>
            </div>`
          : ordered.map(
              (event) => html`
                <div class="agx-row">
                  <span class="agx-tag">${relativeTime(event.createdAt)}</span>
                  <span class="agx-row-main">
                    <span class="agx-row-title">${auditLabel(event)}</span>
                    <span class="agx-row-meta"
                      >${event.actorId ? `by ${event.actorId}` : "system"} · ${event.entityId}</span
                    >
                  </span>
                </div>
              `,
            )}
      </div>
    </section>
  `;
}

function summaryStrip(daily: AgencyDailyState, oversight: AgencyOversightState): TemplateResult {
  const count = (status: EmployeeWorkItem["status"]) =>
    daily.workItems.filter((item) => item.status === status).length;
  const running = count("in_progress");
  const staged = count(AUTONOMY_STAGE);
  const waiting = count("waiting");
  const escalated = count("escalated");
  const cells: Array<{ label: string; value: number; tone?: "warn" | "crit" }> = [
    { label: "Running", value: running },
    { label: "Staged", value: staged },
    { label: "Waiting", value: waiting, tone: waiting > 0 ? "warn" : undefined },
    { label: "Escalated", value: escalated, tone: escalated > 0 ? "crit" : undefined },
    {
      label: "Approvals",
      value: daily.approvals.length,
      tone: daily.approvals.length > 0 ? "warn" : undefined,
    },
  ];
  return html`
    <div class="agx-kpis">
      ${cells.map(
        (cell) => html`
          <div
            class="agx-kpi ${cell.value === 0 ? "is-zero" : ""} ${cell.tone && cell.value > 0
              ? `tone-${cell.tone}`
              : ""}"
          >
            <div class="agx-kpi-label">${cell.label}</div>
            <div class="agx-kpi-value">${cell.value}</div>
          </div>
        `,
      )}
      ${oversight.liveAt
        ? html`<div class="agx-kpi">
            <div class="agx-kpi-label">Live</div>
            <div class="agx-kpi-value" style="font-size:15px">${relativeTime(oversight.liveAt)}</div>
          </div>`
        : nothing}
    </div>
  `;
}

// ── Drag-and-assign band ────────────────────────────────────────────────────
//
// The one act this surface exists to make obvious: hand a delivery task to an AI
// employee. Reuses the autonomy board's proven pattern verbatim —
// `DELIVERY_DRAG_TYPE` on the drag, `beginTaskDrag`/`endTaskDrag` for state, and
// `openHandoff` (with the routing + suitability preview inside it) on the drop.
// A card can be dropped on ANY employee target here, or on the Backlog/Staged
// columns of the live board below (which already accept the same drag type).

function taskDue(value: number | null): string {
  if (!value) return "no due date";
  return value < Date.now() ? `overdue ${relativeTime(value)}` : `due ${relativeTime(value)}`;
}

/** A draggable, unassigned delivery task — the source cards for the band. */
function renderDeliveryChip(
  host: AgencyAutonomyHost,
  task: AgencyTaskSummary,
  projectName: string,
): TemplateResult {
  return html`
    <article
      class="agx-card p-${task.priority}"
      draggable="true"
      role="listitem"
      aria-label="${task.title}. ${projectName}. Drag onto an employee or the board to assign."
      @dragstart=${(event: DragEvent) => {
        const ids = beginTaskDrag(host, task.id);
        if (!event.dataTransfer) return;
        event.dataTransfer.setData("text/plain", ids.join(","));
        event.dataTransfer.setData(DELIVERY_DRAG_TYPE, ids.join(","));
        event.dataTransfer.effectAllowed = "copy";
      }}
      @dragend=${() => endTaskDrag(host)}
    >
      <span class="agx-card-title">${task.title}</span>
      <div class="agx-chips">
        <span
          class="agx-chip ${task.priority === "urgent"
            ? "crit"
            : task.priority === "high"
              ? "warn"
              : ""}"
          >${task.priority}</span
        >
        <span class="agx-chip warn">unassigned</span>
      </div>
      <span class="agx-card-meta">${projectName} · ${taskDue(task.dueAt)}</span>
    </article>
  `;
}

/** One employee rendered as a forgiving drop target. */
function renderEmployeeTarget(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
  employee: AgencyEmployee,
): TemplateResult {
  const autonomy = ensureAgencyAutonomyState(host);
  const util = Math.round(employee.utilizationPercent ?? 0);
  const over = autonomy.dragOverEmployeeId === employee.id;
  return html`
    <div
      class="agx-emp-target ${over ? "is-over" : ""}"
      role="button"
      tabindex="0"
      aria-label="Assign the dragged task to ${employee.name}, ${employee.role}"
      @dragover=${(event: DragEvent) => {
        if (!event.dataTransfer?.types.includes(DELIVERY_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (autonomy.dragOverEmployeeId !== employee.id) {
          autonomy.dragOverEmployeeId = employee.id;
          host.requestUpdate?.();
        }
      }}
      @dragleave=${() => {
        if (autonomy.dragOverEmployeeId === employee.id) {
          autonomy.dragOverEmployeeId = null;
          host.requestUpdate?.();
        }
      }}
      @drop=${(event: DragEvent) => {
        if (!event.dataTransfer?.types.includes(DELIVERY_DRAG_TYPE)) return;
        event.preventDefault();
        const ids = autonomy.draggingTaskIds.length
          ? [...autonomy.draggingTaskIds]
          : (event.dataTransfer.getData(DELIVERY_DRAG_TYPE) || "").split(",").filter(Boolean);
        autonomy.dragOverEmployeeId = null;
        endTaskDrag(host);
        setDragOverAutonomy(host, false);
        if (ids.length) openHandoff(host, client, ids, { preselectWorkerId: employee.id });
      }}
    >
      <span class="agx-emp-name">${employee.name}</span>
      <span class="agx-emp-meta"
        >${employee.role} · ${employee.activeWork ?? 0} active · ${util}% loaded</span
      >
      <span class="agx-emp-load"><span style="width:${Math.min(100, util)}%"></span></span>
    </div>
  `;
}

/**
 * The assign band: unassigned delivery work on the left, the AI roster as drop
 * targets on the right. Drives (and subscribes to) the autonomy controller so it
 * has delivery tasks to offer, then leaves every mutation to `openHandoff`.
 */
function renderAssignBand(
  host: AgencyOversightHost,
  daily: AgencyDailyState,
  client: GatewayBrowserClient,
): TemplateResult {
  const autonomyHost = host as unknown as AgencyAutonomyHost;
  const autonomy = ensureAgencyAutonomyState(autonomyHost);
  subscribeAutonomyUpdates(autonomyHost, client);
  if (!autonomy.lastLoadedAt && !autonomy.loading) {
    queueMicrotask(() => void loadAgencyAutonomy(autonomyHost, client));
  }

  const projectNames = new Map(
    autonomy.projects.map((project) => [project.id, project.name] as const),
  );
  const unassigned = autonomy.tasks
    .filter((task) => !task.assigneeId && HANDOFF_ELIGIBLE_STATUSES.has(task.status))
    .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER));
  const shown = unassigned.slice(0, 30);
  const employees = daily.employees.length ? daily.employees : autonomy.employees;

  return html`
    <div class="aops-assign-band">
      <section class="agx-panel">
        <header class="agx-panel-head">
          <span>Unassigned work</span>
          <span class="agx-count">${unassigned.length} open</span>
        </header>
        <div class="agx-panel-body agx-assign-rail" role="list" aria-label="Unassigned delivery tasks">
          ${autonomy.loading && !autonomy.lastLoadedAt
            ? html`<div class="agx-skel" aria-busy="true">
                <div class="agx-skel-bar" style="width:80%"></div>
                <div class="agx-skel-bar" style="width:60%"></div>
              </div>`
            : shown.length === 0
              ? html`<div class="agx-empty inline">
                  <span class="agx-empty-glyph" aria-hidden="true">✓</span>
                  <div class="agx-empty-copy">
                    <strong>Every task has an owner</strong>
                    <span>New unowned delivery tasks land here, ready to drag onto an employee.</span>
                  </div>
                </div>`
              : shown.map((task) =>
                  renderDeliveryChip(
                    autonomyHost,
                    task,
                    projectNames.get(task.projectId) ?? "Unlinked project",
                  ),
                )}
        </div>
      </section>
      <section class="agx-panel">
        <header class="agx-panel-head">
          <span>Assign to employee</span>
          <span class="agx-count">${employees.length} available</span>
        </header>
        <div class="agx-panel-body">
          <p class="agx-assign-hint">
            <strong>Drag a task onto an employee</strong> to hand it over — the confirmation names
            the employee, its backend and exactly what will happen before anything runs. Or drop it
            on <strong>Backlog</strong> / <strong>Staged</strong> on the board below.
          </p>
          ${employees.length === 0
            ? html`<div class="agx-empty inline">
                <span class="agx-empty-glyph" aria-hidden="true">◎</span>
                <div class="agx-empty-copy">
                  <strong>No AI employees yet</strong>
                  <span>Hire one in Agency Operations, then work can be handed to it here.</span>
                </div>
              </div>`
            : html`<div class="agx-emp-targets">
                ${employees.map((employee) =>
                  renderEmployeeTarget(autonomyHost, client, employee),
                )}
              </div>`}
        </div>
      </section>
    </div>
  `;
}

/**
 * The full oversight board. Reads the shared daily state and the operations
 * audit feed off the host, kicks the first load and subscribes to live updates.
 */
export function renderAgencyOversightBoard(
  host: AgencyOversightHost,
  client: GatewayBrowserClient,
  auditEvents: AgencyAuditEvent[],
): TemplateResult {
  const oversight = host.agencyOversightState ?? null;
  const daily = host.agencyDailyState ?? null;

  // Idempotent: subscribe once, kick the first load exactly once — when the
  // state does not exist yet. Guarding on `!oversight` (not on `loadedAt`) is
  // load-bearing: the load sets `loading` and re-renders before `loadedAt` is
  // set, so a `loadedAt === null` guard would re-queue a load on every render
  // and storm the microtask queue until the main thread froze.
  subscribeAgencyOversight(host, client);
  if (!oversight) {
    queueMicrotask(() => void loadAgencyOversight(host, client));
  }

  if (!daily || (daily.loading && !daily.lastLoadedAt)) {
    return html`
      ${AGENCY_SURFACE_STYLES}
      <div class="agx aops-oversight">
        <div class="agx-skel" aria-busy="true" aria-label="Loading live oversight">
          <div class="agx-skel-bar" style="width:38%"></div>
          <div class="agx-skel-bar tall"></div>
          <div class="agx-skel-bar tall"></div>
        </div>
      </div>
    `;
  }

  const os = oversight ?? {
    loading: false,
    loadedAt: null,
    escalations: [],
    failed: [],
    liveAt: null,
    escalationsUnavailable: false,
  };

  return html`
    ${AGENCY_SURFACE_STYLES}
    <div class="agx aops-oversight">
      ${summaryStrip(daily, os)}
      ${renderAssignBand(host, daily, client)}
      <div class="aops-oversight-grid">
        <div class="aops-oversight-main">${renderBoard(host, daily, client)}</div>
        <div class="aops-oversight-side">
          ${renderLiveAgents(daily)} ${renderApprovals(host, daily, client)}
          ${renderEscalations(daily, os)} ${renderTimeline(auditEvents)}
        </div>
      </div>
    </div>
  `;
}

/**
 * The board's modal overlays — staging prompt, composer, work-item detail, the
 * delivery handoff dialog and the delivery-task modal.
 *
 * Rendered SEPARATELY from the board so the caller can mount them OUTSIDE the
 * `.aops-surface` section. That section has a `backdrop-filter`, which
 * establishes a containing block for `position:fixed`; a scrim nested inside it
 * is re-based to the (very tall) section instead of the viewport and lands below
 * the fold. Mounted at the `.aops` main level — as the other agency dialogs
 * already are — the scrims are viewport-fixed and centre correctly.
 */
export function renderAgencyOversightOverlays(
  host: AgencyOversightHost,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  const daily = host.agencyDailyState ?? null;
  if (!daily) return nothing;
  const autonomyHost = host as unknown as AgencyAutonomyHost;
  const autonomy = ensureAgencyAutonomyState(autonomyHost);
  return html`
    ${renderDailyBoardOverlays(host, daily, client)}
    ${renderHandoffDialog(autonomyHost, autonomy, client)}
    ${renderDeliveryTaskModal(autonomyHost, autonomy, client)}
  `;
}
