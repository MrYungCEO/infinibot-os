import { html, nothing, type TemplateResult } from "lit";
import { baAurora, renderHubLink } from "./ba-glass";
import "./ba-glass/agency.css";
import type { GatewayBrowserClient } from "../gateway";
import {
  invoicingStyles,
  renderClientRevenuePanel,
  renderInvoiceActions,
  renderInvoiceComposer,
  renderInvoiceDownload,
  renderInvoicePaymentLink,
  renderInvoicePaymentControls,
} from "./agency-invoicing";
import { loadClientRevenue, moneyCents, openInvoiceComposer } from "../controllers/agency-invoicing";
import {
  renderAgencyOversightBoard,
  renderAgencyOversightOverlays,
} from "./agency-oversight";
import type { AgencyOversightHost } from "../controllers/agency-oversight";
import { renderProjectDetailPage } from "../projects/ProjectDetailPage";
import type {
  AgencyApproval,
  AgencyClient,
  AgencyEmployee,
  AgencyEngagement,
  AgencyOperationsHost,
  AgencyOperationsState,
  AgencyOpsDialog,
  AgencyProjectSummary,
  AgencySopRun,
  AgencyTaskSummary,
  EmployeeWorkItem,
  EmployeeWorkItemStatus,
  ExtendedAgencyOpsDialogKind,
  PipelineDeal,
} from "../controllers/agency-operations";
import {
  AUTONOMY_LEVELS,
  COMMUNICATION_TONES,
  COMMUNICATION_VERBOSITY,
  EMOJI_USAGE,
  EMPLOYEE_CHANNEL_IDS,
  OUTSIDE_HOURS_BEHAVIOURS,
  PROACTIVITY_LEVELS,
  REPORT_CADENCES,
  deactivateAgencyEmployee,
  describeAutonomy,
  detachAgencyEmployeeSop,
  openAgencyEmployeeEditor,
  removeAgencyEmployeeChannel,
  runAgencyEmployeeSop,
  seedAgencySopCatalogue,
  setAgencyEmployeeLayout,
  setAgencyEmployeeSearch,
  toggleAgencyEmployeeExpansion,
  AGENCY_MIGRATION_CONFIRMATION,
  activateAgencyDatabaseRestore,
  assignAgencyTask,
  cancelAgencyDatabaseRestore,
  checkAgencyAssignmentSuitability,
  closeAgencyOpsDialog,
  completeAgencyReviewCycle,
  createAgencyDatabaseBackup,
  ensureAgencyDatabaseBackup,
  exportAgencyReplicationSnapshot,
  importAgencyReplicationSnapshot,
  loadAgencyDatabaseSchemaStatus,
  previewAgencyMigration,
  pruneAgencyDatabaseBackups,
  runAgencyMigration,
  setAgencyBackupRetention,
  setAgencyMigrationConfirmation,
  stringifyMemoryValue,
  toggleAgencyReplicationConflicts,
  clearAgencyInvoiceDraft,
  focusAgencyAuditEntity,
  focusAgencyClientProjects,
  focusAgencyProjectTasks,
  clientKanbanColumns,
  clientsByPipelineStatus,
  updateAgencyClientPipelineStatus,
  openAgencyClientProfile,
  closeAgencyClientProfile,
  openAgencyProjectDetail,
  addAgencyClientNote,
  spawnAgencyClientAgent,
  setAgencyClientKanbanDragOverCol,
  setAgencyProfileKanbanDragOverCol,
  setAgencyDraggingProfileProject,
  setAgencyClientNoteDraft,
  setAgencyClientAgentTask,
  ingestAgencyInvoice,
  isExtendedAgencyOpsDialog,
  setAgencyDeliveryClientFilter,
  setAgencyReviewOutcome,
  loadAgencyEmployeeDetail,
  loadAgencyOperations,
  openAgencyOpsDialog,
  patchAgencyOpsDialog,
  planAgencyAssignmentTeam,
  prepareAgencyDatabaseRestore,
  removeAgencyMember,
  resolveAgencyApproval,
  runAgencyEmployeeLoop,
  selectAgencyEmployee,
  setAgencyBoardProjectFilter,
  setAgencyDeliveryView,
  setAgencyDraggingTask,
  setAgencyEmployeeFilter,
  setAgencyClientSearch,
  setAgencyFinanceClientView,
  setAgencyDraggingClient,
  setAgencyOperationsSection,
  setAgencyInvoiceProject,
  setAgencyInvoiceClient,
  setAgencyInvoiceText,
  stageAgencyInvoiceFile,
  syncAgencyClients,
  transitionAgencyProject,
  transitionAgencyTask,
  transitionKanbanProject,
  transitionKanbanTask,
  KANBAN_PROJECT_STATUS_OPTIONS,
  KANBAN_TASK_STATUS_OPTIONS,
  updateAgencyClientStatus,
  setAgencyRestoreConfirmation,
  submitAgencyOpsDialog,
  switchAgencyOperationsAgency,
  transitionEmployeeWorkItem,
  updateAgencyEmployeeCapacity,
  updateAgencyMemberRole,
  verifyAgencyDatabaseBackup,
} from "../controllers/agency-operations";

const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value || 0);

const shortDate = (value?: number) =>
  value
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(value)
    : "No date";

const relativeTime = (value: number) => {
  const delta = Date.now() - value;
  const minutes = Math.max(0, Math.round(Math.abs(delta) / 60_000));
  const label =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1_440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1_440)}d`;
  return delta < 0 ? `in ${label}` : `${label} ago`;
};

const fileSize = (value: number) =>
  value < 1_048_576 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1_048_576).toFixed(1)} MB`;

/**
 * Semantic status colours, resolved through the theme's own tokens so a palette
 * change moves every status indicator on the page together. Previously each
 * call site re-declared its own green/amber/red literals.
 */
const TONE = {
  success: "var(--g-success, #22c55e)",
  warning: "var(--g-warning, #f59e0b)",
  danger: "var(--g-danger, #ef4444)",
  info: "var(--g-info, #38bdf8)",
  neutral: "var(--g-neutral, #94a3b8)",
} as const;

/** Utilisation tone: over capacity is a fault, near capacity is a warning. */
const allocationTone = (allocation: number) =>
  allocation > 100 ? TONE.danger : allocation > 85 ? TONE.warning : TONE.success;

function progress(value: number, tone = "var(--g-primary, #8b5cf6)") {
  const safe = Math.max(0, Math.min(100, value || 0));
  return html`<div class="aops-progress"><i style=${`width:${safe}%;background:${tone}`}></i></div>`;
}

function empty(label: string) {
  return html`<div class="aops-empty">${label}</div>`;
}

function renderDeal(deal: PipelineDeal, currency: string) {
  return html`
    <article class="aops-deal">
      <div>
        <strong>${deal.name}</strong>
        <span>${deal.clientName} · ${deal.probability}% probability</span>
      </div>
      <div class="aops-deal-value">${money(deal.value, currency)}</div>
      <div class="aops-deal-next">${deal.nextAction ?? "Define next action"}</div>
    </article>
  `;
}

function renderEngagement(engagement: AgencyEngagement) {
  const color =
    engagement.health === "on_track"
      ? TONE.success
      : engagement.health === "at_risk"
        ? TONE.warning
        : TONE.danger;
  return html`
    <article class="aops-engagement">
      <div class="aops-row">
        <div>
          <strong>${engagement.name}</strong>
          <span>${engagement.clientName}</span>
        </div>
        <span class="aops-chip" style=${`color:${color};border-color:${color}55`}>
          ${engagement.health.replaceAll("_", " ")}
        </span>
      </div>
      <div class="aops-meta">
        <span>${engagement.progress}% complete</span>
        <span>${engagement.budgetUsedPercent}% budget used</span>
        <span>Due ${shortDate(engagement.dueAt)}</span>
      </div>
      ${progress(engagement.progress, color)}
      <div class="aops-deliverables">
        ${engagement.deliverables.slice(0, 3).map(
          (item) => html`
            <div>
              <span class=${`aops-status ${item.status}`}></span>
              <span>${item.name}</span>
              <small>${item.ownerName ?? "Unassigned"}</small>
            </div>
          `,
        )}
      </div>
    </article>
  `;
}

function renderApproval(
  approval: AgencyApproval,
  state: AgencyOperationsState,
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
) {
  const busy = state.approvalBusyId === approval.id;
  return html`
    <article class="aops-approval">
      <div class="aops-row">
        <span class=${`aops-risk ${approval.risk}`}>${approval.risk} risk</span>
        <small>${relativeTime(approval.requestedAt)}</small>
      </div>
      <strong>${approval.title}</strong>
      <p>${approval.description ?? `${approval.type} approval requested by ${approval.requestedBy}`}</p>
      ${
        approval.amount
          ? html`<b>${money(approval.amount, approval.currency ?? state.finance.currency)}</b>`
          : nothing
      }
      <div class="aops-actions">
        <button
          class="aops-btn ghost"
          ?disabled=${busy}
          @click=${() => void resolveAgencyApproval(host, client, approval.id, "rejected")}
        >Decline</button>
        <button
          class="aops-btn primary"
          ?disabled=${busy}
          @click=${() => void resolveAgencyApproval(host, client, approval.id, "approved")}
        >${busy ? "Working…" : "Approve"}</button>
      </div>
    </article>
  `;
}

/**
 * Task-derived progress for one project. Projects carry no stored progress —
 * it is computed from their agency tasks (done / total), the same way the
 * kanban rolls a project up.
 */
function projectProgress(state: AgencyOperationsState, projectId: string) {
  const tasks = state.tasks.filter((task) => task.projectId === projectId);
  const done = tasks.filter((task) => task.status === "done").length;
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return { total: tasks.length, done, inProgress, pct };
}

/**
 * The four kanban project statuses the /projects (kanban) gallery treats as
 * "active" (its `galleryFilter === "active"` predicate). Kept byte-identical to
 * `renderGallery` in views/kanban.ts so the Active Projects panel and the
 * projects page can never disagree about which projects are in flight.
 */
const KANBAN_ACTIVE_STATUSES = new Set<string>([
  "In progress",
  "Updating",
  "Reviewing",
  "Awaiting Client",
]);

const nameKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** A kanban task counts as done exactly as the kanban board counts it. */
const isKanbanTaskDone = (task: { status: string; done?: boolean }) =>
  task.status === "done" || task.done === true;

/**
 * Task-derived progress for one kanban project, rolled up from the SAME
 * `kanban.tasks.list` data the /projects page renders. Returns the open
 * (uncompleted) tasks so the panel can render them as sleek task cards.
 */
function kanbanProjectRoll(state: AgencyOperationsState, projectId: string) {
  const tasks = state.kanbanTasks.filter((task) => task.projectId === projectId);
  const done = tasks.filter(isKanbanTaskDone).length;
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  const open = tasks.filter((task) => !isKanbanTaskDone(task));
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return { total: tasks.length, done, inProgress, pct, open };
}

/** Human label + accent tone for a kanban task status on a sleek task card. */
function taskStatusMeta(status: string): { label: string; tone: string } {
  switch (status) {
    case "in_progress":
      return { label: "In progress", tone: TONE.info };
    case "review":
      return { label: "In review", tone: TONE.warning };
    case "backlog":
      return { label: "Backlog", tone: TONE.neutral };
    case "todo":
    default:
      return { label: "To do", tone: TONE.neutral };
  }
}

/**
 * Active Projects — the exact set of projects the /projects (kanban) page shows
 * under its "Active" filter. Reads the identical `kanban.projects.list` source
 * (`state.kanbanProjects`) with the byte-identical active-status predicate, so
 * the two lists never drift. Projects are joined to CRM clients (by id, then
 * normalized name) purely for grouping; kanban-only work falls under "Internal /
 * Unassigned" so nothing silently disappears. Each project rolls up its kanban
 * tasks and renders its uncompleted/in-progress tasks as sleek cards that reuse
 * the project-card visual language.
 */
function renderActiveProjects(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const active = state.kanbanProjects.filter(
    (project) => !project.archived && KANBAN_ACTIVE_STATUSES.has(String(project.status ?? "")),
  );
  if (!active.length) {
    return empty("No in-progress projects. Move a project to an active status to see it here.");
  }
  const clientsById = new Map(state.clients.map((item) => [item.id, item]));
  // Recover a client link for grouping by matching each kanban project to its
  // agency-register counterpart (same id, else same normalized name).
  const agencyById = new Map(state.projects.map((p) => [p.id, p] as const));
  const agencyByName = new Map(state.projects.map((p) => [nameKey(p.name), p] as const));
  const INTERNAL = "__internal__";
  type ActiveProj = { id: string; name: string; status: string; agencyId: string | null };
  const groups = new Map<string, { name: string; projects: ActiveProj[] }>();
  for (const project of active) {
    const agency = agencyById.get(project.id) ?? agencyByName.get(nameKey(project.name));
    const clientId =
      agency?.clientId && clientsById.has(agency.clientId) ? agency.clientId : null;
    const key = clientId ?? INTERNAL;
    const name = key === INTERNAL ? "Internal / Unassigned" : clientsById.get(key)!.name;
    if (!groups.has(key)) groups.set(key, { name, projects: [] });
    groups.get(key)!.projects.push({
      id: project.id,
      name: project.name,
      status: String(project.status ?? "In progress"),
      agencyId: agency?.id ?? null,
    });
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    a[0] === INTERNAL ? 1 : b[0] === INTERNAL ? -1 : a[1].name.localeCompare(b[1].name),
  );
  return html`
    <div class="aops-active-projects">
      ${ordered.map(
        ([key, group]) => html`
          <article class="aops-active-client">
            <header class="aops-row">
              <div>
                <strong>${group.name}</strong>
                <span>${group.projects.length} in-progress project${group.projects.length === 1 ? "" : "s"}</span>
              </div>
              ${
                key !== INTERNAL
                  ? html`<button class="aops-btn ghost" @click=${() => focusAgencyClientProjects(host, key)}>Open client</button>`
                  : nothing
              }
            </header>
            <div class="aops-active-list">
              ${group.projects.map((project) => {
                const roll = kanbanProjectRoll(state, project.id);
                const openClick = project.agencyId
                  ? () => focusAgencyProjectTasks(host, project.agencyId as string)
                  : undefined;
                return html`
                  <div
                    class="aops-active-proj"
                    role=${openClick ? "button" : nothing}
                    tabindex=${openClick ? "0" : nothing}
                    @click=${openClick ?? nothing}
                  >
                    <div class="aops-row">
                      <span class="aops-proj-name">${project.name}</span>
                      <span class="aops-chip" style=${`color:${TONE.info};border-color:${TONE.info}55`}>In progress</span>
                    </div>
                    <div class="aops-meta">
                      <span>${roll.pct}% complete</span>
                      <span>${roll.done}/${roll.total} tasks done</span>
                      ${roll.inProgress ? html`<span>${roll.inProgress} active</span>` : nothing}
                    </div>
                    ${progress(roll.pct, TONE.info)}
                    <div
                      class="aops-active-controls"
                      @click=${(event: Event) => event.stopPropagation()}
                    >
                      <label class="aops-assign">
                        <span class="aops-visually-hidden">Status of ${project.name}</span>
                        <select
                          class="aops-assign-select"
                          aria-label=${`Change status of project "${project.name}"`}
                          .value=${project.status}
                          ?disabled=${state.secondaryBusyId === project.id}
                          @change=${(event: Event) =>
                            void transitionKanbanProject(
                              host,
                              client,
                              project.id,
                              (event.target as HTMLSelectElement).value,
                            )}
                        >
                          ${KANBAN_PROJECT_STATUS_OPTIONS.map(
                            ([value, label]) =>
                              html`<option value=${value} ?selected=${project.status === value}>${label}</option>`,
                          )}
                        </select>
                      </label>
                      <button
                        class="aops-btn ghost compact"
                        aria-label=${`Mark project ${project.name} complete`}
                        ?disabled=${state.secondaryBusyId === project.id || project.status === "Completed"}
                        @click=${() => void transitionKanbanProject(host, client, project.id, "Completed")}
                      >${state.secondaryBusyId === project.id ? "Saving…" : "Mark complete"}</button>
                    </div>
                    ${
                      roll.open.length
                        ? html`
                            <div class="aops-active-tasks">
                              ${roll.open.slice(0, 6).map((task) => {
                                const meta = taskStatusMeta(task.status);
                                return html`
                                  <div class="aops-active-task" style=${`--task-accent:${meta.tone}`}>
                                    <span class="aops-task-dot"></span>
                                    <span class="aops-task-name">${task.title}</span>
                                    <div
                                      class="aops-active-task-controls"
                                      @click=${(event: Event) => event.stopPropagation()}
                                    >
                                      <label class="aops-assign">
                                        <span class="aops-visually-hidden">Status of ${task.title}</span>
                                        <select
                                          class="aops-assign-select"
                                          aria-label=${`Change status of task "${task.title}"`}
                                          .value=${task.status}
                                          ?disabled=${state.secondaryBusyId === task.id}
                                          @change=${(event: Event) =>
                                            void transitionKanbanTask(
                                              host,
                                              client,
                                              task.id,
                                              (event.target as HTMLSelectElement).value,
                                            )}
                                        >
                                          ${KANBAN_TASK_STATUS_OPTIONS.map(
                                            ([value, label]) =>
                                              html`<option value=${value} ?selected=${task.status === value}>${label}</option>`,
                                          )}
                                        </select>
                                      </label>
                                      <button
                                        class="aops-btn ghost compact"
                                        aria-label=${`Mark task ${task.title} done`}
                                        ?disabled=${state.secondaryBusyId === task.id}
                                        @click=${() => void transitionKanbanTask(host, client, task.id, "done")}
                                      >${state.secondaryBusyId === task.id ? "…" : "Done"}</button>
                                    </div>
                                  </div>
                                `;
                              })}
                              ${
                                roll.open.length > 6
                                  ? html`<span class="aops-task-more">+${roll.open.length - 6} more open</span>`
                                  : nothing
                              }
                            </div>
                          `
                        : nothing
                    }
                  </div>
                `;
              })}
            </div>
          </article>
        `,
      )}
    </div>
  `;
}

/**
 * Decision Queue — the real work that needs a human before it proceeds. Two
 * sources, both already loaded on the overview page:
 *  1. Client approvals (`agency.ops.approvals.list`) — Approve / Decline.
 *  2. Staged employee work items sitting at `queued` — the agency operating
 *     loop enqueues these and they wait for authorization. Approve advances
 *     them to `accepted` (eligible to run); Reject cancels them.
 */
function renderDecisionQueue(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const workerName = new Map(state.employees.map((employee) => [employee.id, employee.name]));
  const staged = state.employeeWorkItems.filter((item) => item.status === "queued");
  if (!state.approvals.length && !staged.length) {
    return empty("All caught up — no work is waiting on your authorization.");
  }
  const riskClass = (priority: EmployeeWorkItem["priority"]) =>
    priority === "urgent" || priority === "high"
      ? "high"
      : priority === "low"
        ? "low"
        : "medium";
  return html`
    ${state.approvals.map((approval) => renderApproval(approval, state, host, client))}
    ${staged.map((item) => {
      const busy = state.secondaryBusyId === item.id;
      return html`
        <article class="aops-approval">
          <div class="aops-row">
            <span class=${`aops-risk ${riskClass(item.priority)}`}>${item.priority} priority</span>
            <small>${relativeTime(item.updatedAt)}</small>
          </div>
          <strong>${item.title}</strong>
          <p>${item.instructions || "Staged work awaiting authorization."} · ${workerName.get(item.workerId) ?? "Unassigned worker"}</p>
          <div class="aops-actions">
            <button
              class="aops-btn ghost"
              ?disabled=${busy}
              @click=${() => void transitionEmployeeWorkItem(host, client, item.id, "cancelled")}
            >Reject</button>
            <button
              class="aops-btn primary"
              ?disabled=${busy}
              @click=${() => void transitionEmployeeWorkItem(host, client, item.id, "accepted")}
            >${busy ? "Working…" : "Approve"}</button>
          </div>
        </article>
      `;
    })}
  `;
}

/** Chat channel display names, in the order the registry declares them. */
const CHANNEL_LABELS: Record<string, string> = {
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  signal: "Signal",
  line: "LINE",
  imessage: "iMessage",
};

const channelLabel = (channelId: string) => CHANNEL_LABELS[channelId] ?? channelId;

/**
 * Autonomy, rendered as something a reader can act on.
 *
 * The stored value is a bare 0-3, and on its own it says nothing about whether
 * this employee's work reaches a client without a human seeing it. The chip
 * therefore always carries the level, its name and — for the bounded level —
 * the threshold that actually decides the outcome.
 */
function autonomyChip(
  level: number | null | undefined,
  approvalThreshold: number | null | undefined,
  currency = "USD",
): TemplateResult {
  const described = describeAutonomy(level);
  if (!described) {
    return html`<span class="aops-autonomy unknown" title="This gateway did not report an autonomy level.">
      <b>Autonomy</b><i>not reported</i>
    </span>`;
  }
  const bounded = described.level === 2 && typeof approvalThreshold === "number";
  return html`
    <span
      class=${`aops-autonomy ${described.tone}`}
      title=${described.detail}
    >
      <b>L${described.level} ${described.label}</b>
      <i>${bounded ? `Auto-completes under ${money(approvalThreshold, currency)}` : described.short}</i>
    </span>
  `;
}

/** Most recent SOP run, phrased as an outcome rather than a status code. */
function lastRunSummary(runs: AgencySopRun[]): { label: string; tone: string } | null {
  const latest = [...runs].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latest) return null;
  const tone =
    latest.status === "failed"
      ? "danger"
      : latest.status === "cancelled"
        ? "warning"
        : latest.status === "materialised"
          ? "success"
          : "info";
  const outcome =
    latest.status === "materialised"
      ? "produced work"
      : latest.status === "pending"
        ? "queued"
        : latest.status;
  return { label: `Last run ${outcome} · ${relativeTime(latest.createdAt)}`, tone };
}

/**
 * The employee card. An AI employee is not a staff-list row: what governs its
 * behaviour is its reporting line, the model it runs on, its autonomy level and
 * what that level means in practice, its load against capacity, and where it
 * can be reached. All of that is on the face of the card; the persona, goals,
 * KPIs and skills are one keyboard-reachable disclosure away.
 */
function renderEmployee(
  employee: AgencyEmployee,
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const capacity = Math.max(1, employee.capacityHours);
  const allocation = Math.round((employee.allocatedHours / capacity) * 100);
  const color = allocationTone(allocation);
  const selected = state.selectedEmployeeId === employee.id;
  const expanded = state.expandedEmployeeIds.includes(employee.id);
  const isAi = employee.kind === "ai";
  const detail =
    state.employeeDetail?.employee.id === employee.id ? state.employeeDetail.employee : null;
  const autonomyLevel = detail?.autonomyLevel ?? employee.autonomyLevel;
  const threshold = detail?.approvalThreshold ?? employee.approvalThreshold;
  const backend = detail?.modelBinding ?? employee.modelBinding ?? employee.model ?? null;
  // SOPs and channels are only fetched for the employee that is open. Showing
  // "0 SOPs" for every other card would be a fabricated zero, so those rows
  // only appear once the data for THIS worker has actually been loaded.
  const sopsLoaded = state.employeeSopWorkerId === employee.id && !state.employeeSopLoading;
  const channelsLoaded =
    state.employeeChannelsWorkerId === employee.id && !state.employeeChannelsLoading;
  const attachedSops = sopsLoaded
    ? state.employeeSopSchedules.filter((schedule) => schedule.workerId === employee.id)
    : [];
  const lastRun = sopsLoaded ? lastRunSummary(state.employeeSopRuns) : null;
  const goals = detail?.goals ?? employee.goals ?? [];
  const kpis = detail?.kpis ?? employee.kpis ?? [];
  const skills = detail?.skills ?? [];
  const capabilities = detail?.capabilities ?? [];
  const persona = detail?.persona ?? employee.persona ?? null;
  const detailId = `aops-emp-detail-${employee.id}`;

  return html`
    <article class=${`aops-employee${selected ? " selected" : ""}`}>
      <header class="aops-employee-head">
        <div class=${`aops-avatar${isAi ? " ai" : ""}`}>${employee.name.slice(0, 2).toUpperCase()}</div>
        <div class="aops-employee-id">
          <div class="aops-row">
            <strong>${employee.name}</strong>
            <span class=${`aops-worker ${employee.kind}`}>${isAi ? "AI" : "Human"}</span>
          </div>
          <span class="aops-employee-role">${employee.role || "No role set"}</span>
          <span class="aops-employee-line">
            ${employee.department || "Unassigned"} ·
            ${employee.managerName ? `reports to ${employee.managerName}` : "no reporting line"}
          </span>
        </div>
        <span
          class=${`aops-presence ${employee.availability}`}
          title=${`Current status: ${employee.availability}`}
        >${employee.availability}</span>
      </header>

      <div class="aops-employee-governance">
        ${autonomyChip(autonomyLevel, threshold)}
        <span class="aops-employee-binding" title=${backend ? `Runs on ${backend}` : ""}>
          <b>Runs on</b>
          <i>${backend ?? (isAi ? "gateway default" : "human — no model")}</i>
        </span>
      </div>

      <div class="aops-employee-load">
        <div class="aops-row aops-util">
          <small>${employee.allocatedHours}/${employee.capacityHours}h allocated</small>
          <small style=${`color:${color}`}>${employee.utilizationPercent}% utilised</small>
        </div>
        ${progress(allocation, color)}
        <div class="aops-employee-facts">
          <span title="Assignments currently planned, active, blocked or in review">
            <b>${employee.activeWork}</b> open ${employee.activeWork === 1 ? "item" : "items"}
          </span>
          ${
            typeof employee.performanceScore === "number"
              ? html`<span title="Mean of quality, reliability and collaboration scores">
                  <b>${employee.performanceScore}</b> score
                </span>`
              : html`<span class="aops-unloaded">Not yet reviewed</span>`
          }
          ${
            sopsLoaded
              ? html`<span title="Standard operating procedures attached on a cadence">
                  <b>${attachedSops.length}</b> SOP${attachedSops.length === 1 ? "" : "s"}
                </span>`
              : nothing
          }
        </div>
      </div>

      ${
        // One honest line rather than three. Until this employee's profile is
        // opened, its SOPs and channel bindings are simply not fetched — saying
        // so once is clearer than three separate "not loaded" labels, and it
        // still never reads as a real zero.
        sopsLoaded || channelsLoaded
          ? html`
            <div class="aops-employee-reach">
              ${
                lastRun
                  ? html`<span class=${`aops-lastrun ${lastRun.tone}`}>${lastRun.label}</span>`
                  : sopsLoaded
                    ? html`<span class="aops-lastrun neutral">No SOP runs recorded yet</span>`
                    : nothing
              }
              ${
                !channelsLoaded
                  ? nothing
                  : state.employeeChannelsUnavailable
                    ? html`<span class="aops-unloaded">Channel bindings unavailable on this gateway</span>`
                    : state.employeeChannels.length
                      ? state.employeeChannels.map(
                          (binding) => html`
                            <span
                              class=${`aops-channel-chip${binding.enabled ? "" : " off"}`}
                              title=${`${channelLabel(binding.channelId)} · ${binding.direction}${
                                binding.target ? ` · ${binding.target}` : ""
                              }${binding.enabled ? "" : " · disabled"}`}
                            >${channelLabel(binding.channelId)}</span>
                          `,
                        )
                      : html`<span class="aops-unloaded">Not reachable on any channel</span>`
              }
            </div>
          `
          : html`
            <div class="aops-employee-reach">
              <span class="aops-unloaded">
                SOPs, channels and run history load when you open this profile
              </span>
            </div>
          `
      }

      <div class="aops-employee-actions">
        <button
          class="aops-btn ghost compact"
          aria-label=${`Open the full profile of ${employee.name}`}
          @click=${() => void loadAgencyEmployeeDetail(host, client, employee.id)}
        >Profile</button>
        <button
          class="aops-btn ghost compact"
          aria-label=${`Customise every setting for ${employee.name}`}
          @click=${() => void openAgencyEmployeeEditor(host, client, employee.id)}
        >Customise</button>
        <button
          class="aops-btn ghost compact"
          aria-label=${`Hand a work item to ${employee.name}`}
          @click=${() => openAgencyOpsDialog(host, "employee-work-item", { entityId: employee.id })}
        >Assign work</button>
        <div class="aops-employee-actions-end">
          <label class="aops-capacity-field">
            <span>Cap h/wk</span>
            <input
              type="number"
              min="1"
              max="168"
              aria-label=${`Weekly capacity hours for ${employee.name}`}
              .value=${String(employee.capacityHours)}
              @change=${(event: Event) =>
                void updateAgencyEmployeeCapacity(
                  host,
                  client,
                  employee.id,
                  Number((event.target as HTMLInputElement).value),
                )}
            />
          </label>
          <button
            class="aops-disclosure"
            aria-expanded=${expanded ? "true" : "false"}
            aria-controls=${detailId}
            aria-label=${`${expanded ? "Hide" : "Show"} persona, goals and skills for ${employee.name}`}
            @click=${() => toggleAgencyEmployeeExpansion(host, employee.id)}
          >${expanded ? "Hide" : "Detail"}</button>
        </div>
      </div>

      ${
        expanded
          ? html`
            <div class="aops-employee-expanded" id=${detailId}>
              <div class="aops-expand-block">
                <b>Persona</b>
                ${
                  persona
                    ? html`<p>${persona}</p>`
                    : html`<p class="aops-unloaded">
                        No persona written. Customise this employee to give it a voice and remit.
                      </p>`
                }
              </div>
              <div class="aops-expand-grid">
                <div class="aops-expand-block">
                  <b>Goals</b>
                  ${
                    goals.length
                      ? html`<ul>${goals.map((goal) => html`<li>${goal}</li>`)}</ul>`
                      : html`<p class="aops-unloaded">No goals set.</p>`
                  }
                </div>
                <div class="aops-expand-block">
                  <b>KPIs</b>
                  ${
                    kpis.length
                      ? html`<ul>${kpis.map((kpi) => html`<li>${kpi}</li>`)}</ul>`
                      : html`<p class="aops-unloaded">No KPIs set.</p>`
                  }
                </div>
              </div>
              <div class="aops-expand-block">
                <b>Skills &amp; capabilities</b>
                ${
                  skills.length || capabilities.length
                    ? html`<div class="aops-token-list">
                        ${skills.map(
                          (skill) => html`<span title=${`Proficiency ${skill.level} of 5`}
                            >${skill.skill} · L${skill.level}</span
                          >`,
                        )}
                        ${capabilities.map((capability) => html`<span>${capability}</span>`)}
                      </div>`
                    : detail
                      ? html`<p class="aops-unloaded">No skills or capabilities recorded.</p>`
                      : html`<p class="aops-unloaded">
                          Open this employee's profile to load skills and capabilities.
                        </p>`
                }
              </div>
            </div>
          `
          : nothing
      }
    </article>
  `;
}

const agencySections = [
  ["overview", "Command center"],
  ["delivery", "Projects & tasks"],
  ["finance", "Clients & revenue"],
  ["employees", "Employees"],
  ["employee-ops", "Employee ops"],
  ["allocation", "Work allocation"],
  ["approvals", "Approval inbox"],
  ["activity", "Activity & audit"],
  ["reliability", "Reliability"],
  ["settings", "Agency settings"],
] as const;

const TASK_BOARD_STATUSES = [
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["in_progress", "In progress"],
  ["blocked", "Blocked"],
  ["review", "Review"],
  ["done", "Done"],
] as const;

/**
 * Explicit assignment control. Drag-and-drop remains, but it cannot be the only
 * path to assign work: a select is reachable by keyboard, touch and assistive
 * technology, and it drives the same `assignAgencyTask` mutation.
 */
function renderTaskAssignControl(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  task: AgencyTaskSummary,
): TemplateResult {
  return html`
    <label class="aops-assign">
      <span class="aops-visually-hidden">Assign ${task.title}</span>
      <select
        class="aops-assign-select"
        aria-label=${`Assign "${task.title}" to an employee`}
        .value=${task.assigneeId ?? ""}
        @click=${(event: Event) => event.stopPropagation()}
        @change=${(event: Event) => {
          const employeeId = (event.target as HTMLSelectElement).value;
          const employee = state.employees.find((item) => item.id === employeeId);
          void assignAgencyTask(
            host,
            client,
            task.id,
            employee ? { id: employee.id, kind: employee.kind } : null,
          );
        }}
      >
        <option value="">Unassigned</option>
        ${state.employees.map(
          (employee) =>
            html`<option value=${employee.id}>
              ${employee.name} · ${employee.kind === "ai" ? "AI" : "Human"}
            </option>`,
        )}
      </select>
    </label>
  `;
}

function renderTaskBoard(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult {
  const projectNames = new Map(state.projects.map((project) => [project.id, project.name]));
  const employeeById = new Map(state.employees.map((employee) => [employee.id, employee]));
  const clientProjectIds = state.deliveryClientFilter
    ? new Set(
        state.projects
          .filter((project) => project.clientId === state.deliveryClientFilter)
          .map((project) => project.id),
      )
    : null;
  const filtered = state.tasks.filter(
    (task) =>
      (!state.boardProjectFilter || task.projectId === state.boardProjectFilter) &&
      (!clientProjectIds || clientProjectIds.has(task.projectId)),
  );
  const byStatus = new Map<string, typeof state.tasks>();
  for (const [status] of TASK_BOARD_STATUSES) byStatus.set(status, []);
  for (const task of filtered) {
    if (!byStatus.has(task.status)) byStatus.set(task.status, []);
    byStatus.get(task.status)!.push(task);
  }

  const readTaskId = (event: DragEvent) => event.dataTransfer?.getData("text/plain") || state.draggingTaskId;

  const onDragStart = (event: DragEvent, taskId: string) => {
    event.dataTransfer?.setData("text/plain", taskId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    setAgencyDraggingTask(host, taskId);
  };
  const onColumnDrop = (event: DragEvent, status: (typeof TASK_BOARD_STATUSES)[number][0]) => {
    event.preventDefault();
    const taskId = readTaskId(event);
    if (taskId) void transitionAgencyTask(host, client, taskId, status);
    setAgencyDraggingTask(host, null);
  };
  const onEmployeeDrop = (event: DragEvent, employee: AgencyEmployee | null) => {
    event.preventDefault();
    const taskId = readTaskId(event);
    if (taskId) {
      void assignAgencyTask(host, client, taskId, employee ? { id: employee.id, kind: employee.kind } : null);
    }
    setAgencyDraggingTask(host, null);
  };

  return html`
    <div class="aops-board-wrap">
      <div class="aops-board-toolbar">
        <label class="aops-field aops-board-filter">
          <span>Project</span>
          <select
            aria-label="Filter the task board by project"
            .value=${state.boardProjectFilter}
            @change=${(event: Event) =>
              setAgencyBoardProjectFilter(host, (event.target as HTMLSelectElement).value)}
          >
            <option value="">All projects</option>
            ${state.projects.map((project) => html`<option value=${project.id}>${project.name}</option>`)}
          </select>
        </label>
        <small>
          Drag a card between columns to change status, or use the status and assignee
          controls on each card.
        </small>
      </div>
      <div class="aops-board-employees">
        <div
          class="aops-employee-chip unassigned"
          @dragover=${(event: DragEvent) => event.preventDefault()}
          @drop=${(event: DragEvent) => onEmployeeDrop(event, null)}
        >
          <span class="aops-avatar">—</span><span>Unassigned</span>
        </div>
        ${state.employees.map(
          (employee) => html`
            <div
              class="aops-employee-chip"
              @dragover=${(event: DragEvent) => event.preventDefault()}
              @drop=${(event: DragEvent) => onEmployeeDrop(event, employee)}
            >
              <span class="aops-avatar">${employee.name.slice(0, 2).toUpperCase()}</span>
              <span>${employee.name}</span>
              <span class=${`aops-worker ${employee.kind}`}>${employee.kind}</span>
            </div>
          `,
        )}
      </div>
      <div class="aops-board">
        ${TASK_BOARD_STATUSES.map(([status, label]) => {
          const tasks = byStatus.get(status) ?? [];
          return html`
            <div
              class="aops-board-col"
              @dragover=${(event: DragEvent) => event.preventDefault()}
              @drop=${(event: DragEvent) => onColumnDrop(event, status)}
            >
              <header><span>${label}</span><span class="aops-count">${tasks.length}</span></header>
              <div class="aops-board-col-body">
                ${
                  tasks.length
                    ? tasks.map((task) => {
                        const assignee = task.assigneeId ? employeeById.get(task.assigneeId) : undefined;
                        return html`
                          <article
                            class="aops-board-card"
                            draggable="true"
                            @dragstart=${(event: DragEvent) => onDragStart(event, task.id)}
                            @dragend=${() => setAgencyDraggingTask(host, null)}
                          >
                            <strong>${task.title}</strong>
                            <small>${projectNames.get(task.projectId) ?? "Unlinked"} · ${task.priority}</small>
                            <div class="aops-row">
                              <span class=${`aops-worker ${assignee?.kind ?? task.assigneeType ?? ""}`}>
                                ${assignee ? assignee.name : (task.assigneeType ?? "Unassigned")}
                              </span>
                              ${task.dueAt ? html`<small>${shortDate(task.dueAt)}</small>` : nothing}
                            </div>
                            <div class="aops-task-controls">
                              ${renderTaskAssignControl(host, state, client, task)}
                              <label class="aops-assign">
                                <span class="aops-visually-hidden">Status of ${task.title}</span>
                                <select
                                  class="aops-assign-select"
                                  aria-label=${`Change status of "${task.title}"`}
                                  .value=${task.status}
                                  @click=${(event: Event) => event.stopPropagation()}
                                  @change=${(event: Event) =>
                                    void transitionAgencyTask(
                                      host,
                                      client,
                                      task.id,
                                      (event.target as HTMLSelectElement)
                                        .value as AgencyTaskSummary["status"],
                                    )}
                                >
                                  ${TASK_BOARD_STATUSES.map(
                                    ([value, statusLabel]) =>
                                      html`<option value=${value}>${statusLabel}</option>`,
                                  )}
                                </select>
                              </label>
                            </div>
                          </article>
                        `;
                      })
                    : html`<small class="aops-board-empty">Drop a task here</small>`
                }
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderDeliveryOperations(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult {
  const clientNames = new Map(state.clients.map((agencyClient) => [agencyClient.id, agencyClient.name]));
  const scopedProjects = state.deliveryClientFilter
    ? state.projects.filter((project) => project.clientId === state.deliveryClientFilter)
    : state.projects;
  const tasksByProject = new Map<string, typeof state.tasks>();
  for (const task of state.tasks) {
    const tasks = tasksByProject.get(task.projectId) ?? [];
    tasks.push(task);
    tasksByProject.set(task.projectId, tasks);
  }
  const openTasks = state.tasks.filter(
    (task) => !["done", "cancelled"].includes(task.status),
  );
  const blockedTasks = openTasks.filter((task) => task.status === "blocked");
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head">
        <div>
          <span class="aops-eyebrow">Delivery operations</span>
          <h2>Projects and execution</h2>
          <p>Agency-scoped work with visible ownership, state, client context and next actions.</p>
        </div>
        <div class="aops-actions">
          <div class="aops-view-toggle">
            <button
              class=${state.deliveryView === "list" ? "active" : ""}
              @click=${() => setAgencyDeliveryView(host, "list")}
            >List</button>
            <button
              class=${state.deliveryView === "board" ? "active" : ""}
              @click=${() => setAgencyDeliveryView(host, "board")}
            >Board</button>
          </div>
          <button class="aops-btn ghost" @click=${() => openAgencyOpsDialog(host, "task")}>+ Task</button>
          <button class="aops-btn primary" @click=${() => openAgencyOpsDialog(host, "project")}>+ Project</button>
        </div>
      </header>
      <div class="aops-kpis">
        <article class="aops-kpi"><span>Projects</span><strong>${state.projects.length}</strong><small>${state.projects.filter((project) => project.status === "active").length} active</small></article>
        <article class="aops-kpi"><span>Open tasks</span><strong>${openTasks.length}</strong><small>${state.tasks.filter((task) => task.status === "done").length} complete</small></article>
        <article class="aops-kpi"><span>Blocked</span><strong>${blockedTasks.length}</strong><small>${blockedTasks.length ? "Operator attention required" : "Delivery flowing"}</small></article>
        <article class="aops-kpi"><span>AI-assigned</span><strong>${openTasks.filter((task) => task.assigneeType === "ai").length}</strong><small>Visible agent workload</small></article>
      </div>
      ${
        state.deliveryClientFilter
          ? html`<div class="aops-inline-notice good">
              Scoped to
              <strong>${clientNames.get(state.deliveryClientFilter) ?? "one client"}</strong> ·
              ${scopedProjects.length} project${scopedProjects.length === 1 ? "" : "s"}.
              <button
                class="aops-link"
                aria-label="Clear the client scope and show every project"
                @click=${() => setAgencyDeliveryClientFilter(host, "")}
              >Show all projects</button>
            </div>`
          : nothing
      }
      ${state.deliveryView === "board" ? renderTaskBoard(host, state, client) : nothing}
      <div class="aops-project-grid" ?hidden=${state.deliveryView === "board"}>
        ${
          scopedProjects.length
            ? scopedProjects.map((project) => {
                const tasks = tasksByProject.get(project.id) ?? [];
                const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
                const done = tasks.filter((task) => task.status === "done").length;
                const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
                return html`<article class="aops-project-card">
                  <div class="aops-row">
                    <div>
                      <button
                        class="aops-link strong"
                        aria-label=${`Open the dedicated page for ${project.name}`}
                        @click=${() => openAgencyProjectDetail(host, client, project.id)}
                      >${project.name}</button>
                      ${
                        project.clientId
                          ? html`<button
                              class="aops-link"
                              aria-label=${`Show every project for ${clientNames.get(project.clientId) ?? "this client"}`}
                              @click=${() => focusAgencyClientProjects(host, project.clientId!)}
                            >${clientNames.get(project.clientId) ?? "Linked client"}</button>`
                          : html`<small>No client linked</small>`
                      }
                    </div>
                    <span class=${`aops-chip ${project.status}`}>${project.status.replace("_", " ")}</span>
                    <button
                      class="aops-btn ghost compact"
                      aria-label=${`Open the dedicated page for ${project.name}`}
                      @click=${() => openAgencyProjectDetail(host, client, project.id)}
                    >Open →</button>
                    <button
                      class="aops-btn ghost compact"
                      aria-label=${`Edit project ${project.name}`}
                      @click=${() => openAgencyOpsDialog(host, "project-edit", { entityId: project.id })}
                    >Edit</button>
                  </div>
                  <div class="aops-progress"><i style=${`width:${progress}%`}></i></div>
                  <div class="aops-row">
                    <small>${done}/${tasks.length} tasks complete · ${project.targetEndAt ? shortDate(project.targetEndAt) : "No deadline"}</small>
                    ${
                      project.status === "planned"
                        ? html`<button class="aops-btn ghost compact" @click=${() => void transitionAgencyProject(host, client, project.id, "active")}>Start</button>`
                        : project.status === "active" && active.length === 0
                          ? html`<button class="aops-btn ghost compact" @click=${() => void transitionAgencyProject(host, client, project.id, "completed")}>Complete</button>`
                          : nothing
                    }
                  </div>
                  <div class="aops-project-tasks">
                    ${
                      active.length
                        ? active.slice(0, 4).map(
                            (task) => html`<div class="aops-row">
                              <div><strong>${task.title}</strong><small>${task.assigneeType ?? "unassigned"} · ${task.priority}</small></div>
                              ${renderTaskAssignControl(host, state, client, task)}
                              <button
                                class="aops-btn ghost compact"
                                aria-label=${`${task.status === "in_progress" ? "Complete" : "Start"} task ${task.title}`}
                                ?disabled=${state.secondaryBusyId === task.id}
                                @click=${() =>
                                  void transitionAgencyTask(
                                    host,
                                    client,
                                    task.id,
                                    task.status === "in_progress" ? "done" : "in_progress",
                                  )}
                              >${task.status === "in_progress" ? "Done" : "Start"}</button>
                            </div>`,
                          )
                        : html`<small>No open tasks.</small>`
                    }
                    ${
                      active.length > 4
                        ? html`<button
                            class="aops-link"
                            aria-label=${`Open the board with all ${active.length} open tasks for ${project.name}`}
                            @click=${() => focusAgencyProjectTasks(host, project.id)}
                          >+${active.length - 4} more open tasks</button>`
                        : nothing
                    }
                  </div>
                </article>`;
              })
            : empty("No agency projects yet. Create the first project.")
        }
      </div>
    </section>
  `;
}

function renderFinanceOperations(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult {
  const currency = state.revenue?.currency ?? state.finance.currency;
  const preview = state.invoiceParsedPreview as
    | {
        invoiceNumber?: string;
        clientName?: string;
        totalCents?: number;
        recurringMonthlyCents?: number;
        confidence?: number;
        warnings?: string[];
        projectName?: string | null;
        lineItems?: Array<{
          description: string;
          totalCents: number;
          cadence: "one_time" | "monthly" | "quarterly" | "annual";
        }>;
      }
    | null;
  const trend = state.revenue?.trend ?? [];
  const trendMax = Math.max(
    1,
    ...trend.flatMap((point) => [point.invoicedCents, point.collectedCents]),
  );
  const financeEmployee = state.employees.find(
    (employee) => employee.role.toLowerCase().includes("finance") || employee.name === "Felix",
  );
  const financeWork = financeEmployee
    ? state.employeeWorkItems.filter(
        (item) =>
          item.workerId === financeEmployee.id &&
          !["completed", "cancelled"].includes(item.status),
      )
    : [];
  const collectionRate =
    (state.revenue?.invoicedRevenueCents ?? 0) > 0
      ? Math.round(
          ((state.revenue?.collectedRevenueCents ?? 0) /
            (state.revenue?.invoicedRevenueCents ?? 1)) *
            100,
        )
      : 0;
  const clientNeedle = state.clientSearch.trim().toLowerCase();
  const filteredClients = state.clients.filter(
    (agencyClient) =>
      !clientNeedle ||
      agencyClient.name.toLowerCase().includes(clientNeedle) ||
      agencyClient.billingEmail?.toLowerCase().includes(clientNeedle),
  );
  const visibleClients = filteredClients.slice(0, 80);
  const activeClients = state.clients.filter((agencyClient) => agencyClient.status === "active").length;
  const clientSync = state.clientSyncStatus;
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head">
        <div>
          <span class="aops-eyebrow">Finance operations</span>
          <h2>Clients, invoices and recurring revenue</h2>
          <p>Write an invoice, backdate one you already sent, or import a document. The agency ledger, receivables, revenue and MRR all move together.</p>
        </div>
        <div class="aops-actions">
          <div class="aops-view-toggle" role="group" aria-label="Client directory layout">
            <button
              class=${state.financeClientView === "grid" ? "active" : ""}
              aria-pressed=${state.financeClientView === "grid"}
              @click=${() => setAgencyFinanceClientView(host, "grid")}
            >Cards</button>
            <button
              class=${state.financeClientView === "kanban" ? "active" : ""}
              aria-pressed=${state.financeClientView === "kanban"}
              @click=${() => setAgencyFinanceClientView(host, "kanban")}
            >Kanban</button>
          </div>
          ${renderInvoiceActions(host, state, client)}
          <button class="aops-btn ghost" @click=${() => openAgencyOpsDialog(host, "client")}>+ Client</button>
          ${
            clientSync?.connected
              ? html`<button
                  class="aops-btn primary"
                  ?disabled=${state.clientSyncing}
                  @click=${() => void syncAgencyClients(host, client)}
                >${state.clientSyncing ? "Syncing…" : "Sync shared data"}</button>`
              : nothing
          }
        </div>
      </header>
      <div class="aops-kpis">
        <article class="aops-kpi"><span>Client records</span><strong>${state.clients.length}</strong><small>${activeClients} active · ${state.clients.length - activeClients} prospects/inactive</small></article>
        <article class="aops-kpi"><span>Invoiced this month</span><strong>${money((state.revenue?.invoicedRevenueCents ?? 0) / 100, currency)}</strong><small>Accrual revenue</small></article>
        <article class="aops-kpi"><span>Cash collected</span><strong>${money((state.revenue?.collectedRevenueCents ?? 0) / 100, currency)}</strong><small>Payment ledger</small></article>
        <article class="aops-kpi"><span>MRR</span><strong>${money((state.revenue?.mrrCents ?? 0) / 100, currency)}</strong><small>${state.revenue?.activeMrrClients ?? 0} recurring clients</small></article>
        <article class="aops-kpi"><span>ARR run rate</span><strong>${money((state.revenue?.arrCents ?? 0) / 100, currency)}</strong><small>MRR × 12</small></article>
        <article class="aops-kpi"><span>Receivables</span><strong>${money(state.finance.outstandingReceivables, currency)}</strong><small>${money(state.finance.overdueReceivables, currency)} overdue</small></article>
      </div>
      <section class="aops-card" style="margin-bottom:16px">
        <header>
          <div>
            <h2>Client directory</h2>
            <small>
              ${
                clientSync?.connected
                  ? `${clientSync.databaseName ?? "Connected CRM"} · ${clientSync.lastSync ? `synced ${shortDate(clientSync.lastSync)}` : "ready to sync"}`
                  : "Agency-native client records"
              }
            </small>
          </div>
          <label class="aops-client-search">
            <input
              type="search"
              placeholder="Search clients or email"
              .value=${state.clientSearch}
              @input=${(event: Event) =>
                setAgencyClientSearch(host, (event.target as HTMLInputElement).value)}
            />
          </label>
        </header>
        ${
          visibleClients.length
            ? state.financeClientView === "kanban"
              ? renderClientKanban(host, state, client, filteredClients, currency)
              : renderClientGrid(host, state, client, visibleClients, filteredClients, currency)
            : empty(
                state.clientSearch
                  ? "No clients match this search."
                  : clientSync?.connected
                    ? "No clients are stored yet. Sync the connected CRM."
                    : "Create the first agency client.",
              )
        }
      </section>
      <div class="aops-settings-grid">
        <article class="aops-settings-card">
          <h3>Invoice parser</h3>
          <p>Upload a PDF, text or JSON invoice, or paste its extracted contents.</p>
          <label class="aops-field">
            <span>Invoice file</span>
            <input
              type="file"
              accept=".pdf,.txt,.json,application/pdf,text/plain,application/json"
              @change=${(event: Event) => {
                const file = (event.target as HTMLInputElement).files?.[0];
                if (file) void stageAgencyInvoiceFile(host, file);
              }}
            />
          </label>
          ${state.invoiceFile ? html`<small>Ready: ${state.invoiceFile.name}</small>` : nothing}
          <label class="aops-field">
            <span>Relate to client</span>
            <select
              .value=${state.invoiceClientId}
              @change=${(event: Event) =>
                setAgencyInvoiceClient(host, (event.target as HTMLSelectElement).value)}
            >
              <option value="">Auto-match from invoice</option>
              ${state.clients.map(
                (agencyClient) =>
                  html`<option value=${agencyClient.id}>${agencyClient.name}</option>`,
              )}
            </select>
          </label>
          <label class="aops-field">
            <span>Relate to project</span>
            <select
              .value=${state.invoiceProjectId}
              @change=${(event: Event) =>
                setAgencyInvoiceProject(host, (event.target as HTMLSelectElement).value)}
            >
              <option value="">Auto-match from invoice</option>
              ${state.projects.map(
                (project) =>
                  html`<option value=${project.id}>${project.name} · ${project.status.replace("_", " ")}</option>`,
              )}
            </select>
            <small>Client is matched or created from the invoice; project stays operator-selectable.</small>
          </label>
          <label class="aops-field">
            <span>Paste invoice text or structured JSON</span>
            <textarea
              rows="12"
              placeholder="Invoice #: INV-1001&#10;Bill To: Client name&#10;Billing interval: monthly&#10;Total: $2,500"
              .value=${state.invoiceDraftText}
              @input=${(event: Event) =>
                setAgencyInvoiceText(host, (event.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
          <div class="aops-actions">
            <button
              class="aops-btn primary"
              ?disabled=${state.invoiceImporting || (!state.invoiceDraftText.trim() && !state.invoiceFile)}
              @click=${() => void ingestAgencyInvoice(host, client)}
            >${state.invoiceImporting ? "Parsing…" : "Parse & import"}</button>
            <button class="aops-btn ghost" @click=${() => clearAgencyInvoiceDraft(host)}>Clear</button>
          </div>
          ${
            preview
              ? html`
                <div class="aops-alert">
                  <strong>Review required: ${preview.invoiceNumber ?? "Unknown invoice"} · ${preview.clientName ?? "Unknown client"}</strong>
                  <span style="display:block;margin-top:5px">
                    ${money((preview.totalCents ?? 0) / 100, currency)} total ·
                    ${money((preview.recurringMonthlyCents ?? 0) / 100, currency)} MRR ·
                    ${Math.round((preview.confidence ?? 0) * 100)}% confidence
                  </span>
                  ${preview.warnings?.length ? html`<small>${preview.warnings.join(" ")}</small>` : nothing}
                  ${
                    preview.lineItems?.length
                      ? html`<div style="margin-top:10px">
                          ${preview.lineItems.map(
                            (item) => html`<div class="aops-row">
                              <div><strong>${item.description}</strong><small>${item.cadence.replace("_", " ")}</small></div>
                              <strong>${money(item.totalCents / 100, currency)}</strong>
                            </div>`,
                          )}
                        </div>`
                      : nothing
                  }
                  <button class="aops-btn primary" style="margin-top:10px" @click=${() => void ingestAgencyInvoice(host, client, true)}>Confirm import</button>
                </div>`
              : nothing
          }
        </article>
        <article class="aops-settings-card">
          <h3>Finance AI controls</h3>
          <p>${financeEmployee ? `${financeEmployee.name} monitors invoice exceptions and reconciliation.` : "Add the Finance AI employee to enable exception triage."}</p>
          <div class="aops-row">
            <div><strong>Collection rate</strong><small>Current reporting period</small></div>
            <strong>${collectionRate}%</strong>
          </div>
          <div class="aops-row">
            <div><strong>Review queue</strong><small>Needs finance or operator attention</small></div>
            <strong>${financeWork.length}</strong>
          </div>
          ${
            financeWork.length
              ? financeWork.slice(0, 4).map(
                  (item) => html`<div class="aops-alert" style="margin-top:8px">
                    <strong>${item.title}</strong>
                    <small>${item.status.replace("_", " ")} · ${item.priority}</small>
                  </div>`,
                )
              : html`<small>No unresolved finance exceptions.</small>`
          }
        </article>
      </div>
      <div class="aops-settings-grid" style="margin-top:16px">
        <article class="aops-settings-card">
          <h3>12-month revenue movement</h3>
          ${
            trend.length
              ? html`<div style="display:flex;align-items:flex-end;gap:8px;height:190px;padding-top:18px">
                  ${trend.map(
                    (point) => html`<div style="flex:1;min-width:24px;text-align:center">
                      <div style="height:140px;display:flex;align-items:flex-end;justify-content:center;gap:3px">
                        <i title=${`Invoiced ${money(point.invoicedCents / 100, currency)}`} style=${`display:block;width:9px;min-height:2px;height:${Math.max(2, Math.round((point.invoicedCents / trendMax) * 140))}px;background:var(--g-primary, #8b5cf6);border-radius:var(--g-radius-sm, 8px) var(--g-radius-sm, 8px) 0 0`}></i>
                        <i title=${`Collected ${money(point.collectedCents / 100, currency)}`} style=${`display:block;width:9px;min-height:2px;height:${Math.max(2, Math.round((point.collectedCents / trendMax) * 140))}px;background:${TONE.success};border-radius:var(--g-radius-sm, 8px) var(--g-radius-sm, 8px) 0 0`}></i>
                      </div>
                      <small>${point.month.slice(5)}</small>
                    </div>`,
                  )}
                </div>`
              : empty("Revenue history appears after the first imported invoice.")
          }
        </article>
        <article class="aops-settings-card">
          <h3>Revenue relationships</h3>
          ${
            state.revenue?.revenueByClient.length
              ? state.revenue.revenueByClient.map(
                  (row) => html`
                    <div class="aops-row">
                      <div><strong>${row.clientName}</strong><small>${money(row.mrrCents / 100, currency)} MRR</small></div>
                      <div style="text-align:right"><strong>${money(row.invoicedCents / 100, currency)}</strong><small>${money(row.collectedCents / 100, currency)} collected</small></div>
                    </div>`,
                )
              : empty("No client revenue recorded yet. Import the first invoice.")
          }
          ${
            state.revenue?.revenueByProject.length
              ? html`<h4 style="margin-top:16px">By project</h4>${state.revenue.revenueByProject.map(
                  (row) => html`<div class="aops-row">
                    <div><strong>${row.projectName}</strong><small>Project-attributed invoice revenue</small></div>
                    <div style="text-align:right"><strong>${money(row.invoicedCents / 100, currency)}</strong><small>${money(row.collectedCents / 100, currency)} collected</small></div>
                  </div>`,
                )}`
              : nothing
          }
        </article>
      </div>
      <section class="aops-card" style="margin-top:16px">
        <header><h2>Invoice register</h2><span class="aops-count">${state.invoices.length}</span></header>
        <div class="aops-engagements">
          ${
            state.invoices.length
              ? state.invoices.map(
                  (invoice) => html`
                    <article class="aops-engagement">
                      <div class="aops-row">
                        <div>
                          <strong>${invoice.number}</strong>
                          <span>${invoice.clientName}${invoice.projects?.length ? ` · ${invoice.projects.map((project) => project.projectName).join(", ")}` : " · Unassigned project"}</span>
                        </div>
                        <span class=${`aops-chip ${invoice.status}`}>${invoice.status.replace("_", " ")}</span>
                      </div>
                      <small>
                        ${moneyCents(invoice.totalCents, invoice.currency)} total ·
                        ${moneyCents(invoice.amountPaidCents, invoice.currency)} paid ·
                        ${moneyCents(invoice.balanceCents, invoice.currency)} due ·
                        ${shortDate(invoice.dueAt ?? undefined)}
                      </small>
                      ${renderInvoiceDownload(
                        host,
                        client,
                        {
                          id: invoice.id,
                          number: invoice.number,
                          clientName: invoice.clientName,
                        },
                        "aoi",
                      )}
                      ${renderInvoicePaymentLink(
                        host,
                        client,
                        {
                          id: invoice.id,
                          number: invoice.number,
                          clientName: invoice.clientName,
                        },
                        "aoi",
                      )}
                      ${renderInvoicePaymentControls(host, state, client, invoice)}
                    </article>`,
                )
              : state.failedRequests.some((entry) => entry.startsWith("agency.ops.invoices.list"))
                ? empty(
                    "The invoice register could not be loaded — see the failed-request banner above. This is not an empty ledger.",
                  )
                : empty(
                    "No invoices stored yet. Use “+ New invoice” to raise one, or “Backlog past invoice” to record invoices you have already sent.",
                  )
          }
        </div>
      </section>
      <section class="aops-card" style="margin-top:16px">
        <header><h2>Revenue ledger</h2><span class="aops-count">${state.revenueEntries.length}</span></header>
        <div class="aops-engagements">
          ${
            state.revenueEntries.length
              ? state.revenueEntries.map(
                  (entry) => html`<article class="aops-engagement">
                    <div class="aops-row">
                      <div><strong>${entry.description}</strong><small>${shortDate(entry.recognizedAt)} · ${entry.sourceType.replaceAll("_", " ")}</small></div>
                      <strong>${money(entry.amountCents / 100, entry.currency)}</strong>
                    </div>
                    ${entry.recurringMonthlyCents > 0 ? html`<small>${money(entry.recurringMonthlyCents / 100, entry.currency)} recurring monthly</small>` : nothing}
                  </article>`,
                )
              : empty("No revenue entries recorded.")
          }
        </div>
      </section>
    </section>
  `;
}

/** Full per-client control cluster reused by both the card grid and the kanban. */
function renderClientCardControls(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  agencyClient: AgencyClient,
): TemplateResult {
  const busy = state.secondaryBusyId === agencyClient.id;
  return html`
    <div class="aops-client-actions">
      <button
        class="aops-btn ghost compact"
        aria-label=${`Open the full profile for ${agencyClient.name}`}
        @click=${() => openAgencyClientProfile(host, client, agencyClient.id)}
      >Profile</button>
      <button
        class="aops-btn ghost compact"
        aria-label=${`Open the ${agencyClient.projectCount} project(s) and tasks for ${agencyClient.name}`}
        @click=${() => focusAgencyClientProjects(host, agencyClient.id)}
      >Projects</button>
      <button
        class="aops-btn ghost compact"
        aria-label=${`Open the invoice and income history for ${agencyClient.name}`}
        @click=${() => void loadClientRevenue(host, client, agencyClient.id)}
      >Revenue</button>
      <button
        class="aops-btn ghost compact"
        aria-label=${`Edit ${agencyClient.name}`}
        @click=${() => openAgencyOpsDialog(host, "client-edit", { entityId: agencyClient.id })}
      >Edit</button>
      <button
        class="aops-btn ghost compact"
        aria-label=${`${agencyClient.status === "active" ? "Archive" : "Activate"} ${agencyClient.name}`}
        ?disabled=${busy}
        @click=${() =>
          void updateAgencyClientStatus(
            host,
            client,
            agencyClient.id,
            agencyClient.status === "active" ? "inactive" : "active",
          )}
      >${busy ? "…" : agencyClient.status === "active" ? "Archive" : "Activate"}</button>
    </div>
  `;
}

function renderClientGrid(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  visibleClients: AgencyClient[],
  filteredClients: AgencyClient[],
  currency: string,
): TemplateResult {
  return html`
    <div class="aoc-grid-cards">
      ${visibleClients.map((agencyClient) => renderPremiumClientCard(host, state, client, agencyClient, currency))}
    </div>
    ${
      filteredClients.length > visibleClients.length
        ? html`<small style="display:block;margin-top:12px">Showing ${visibleClients.length} of ${filteredClients.length}. Refine the search to locate any client.</small>`
        : nothing
    }
  `;
}

/** Small social-icon strip shown on the premium client card. */
function renderClientCardSocials(agencyClient: AgencyClient): TemplateResult | typeof nothing {
  const filled = CLIENT_SOCIAL_FIELDS.filter(
    (field) => ((agencyClient as unknown as Record<string, string | null>)[field.key] ?? "").trim(),
  );
  if (filled.length === 0) return nothing;
  return html`
    <div class="aoc-card-socials">
      ${filled.map((field) => html`<span class="aoc-card-social" title=${field.label}>${field.icon}</span>`)}
    </div>
  `;
}

/**
 * Premium client card — a visual match to the dedicated Clients page cards:
 * glass gradient, avatar, contact rows, social strip, status badge, metric band
 * and a lifetime/outstanding ledger, with hover action controls.
 */
function renderPremiumClientCard(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  agencyClient: AgencyClient,
  currency: string,
): TemplateResult {
  const statusLabel = agencyClient.pipelineStatusLabel ?? titleCase(agencyClient.status);
  const initials = agencyClient.name.slice(0, 2).toUpperCase();
  const billing = agencyClient.billingEmail ?? agencyClient.email ?? null;
  const phone = agencyClient.phone ?? null;
  return html`
    <article
      class=${`aoc-card ${agencyClient.status}`}
      @click=${() => openAgencyClientProfile(host, client, agencyClient.id)}
    >
      <div class="aoc-card-actions" @click=${(event: Event) => event.stopPropagation()}>
        <button
          class="aoc-card-action"
          title=${`Edit ${agencyClient.name}`}
          @click=${() => openAgencyOpsDialog(host, "client-edit", { entityId: agencyClient.id })}
        >✎ Edit</button>
        <button
          class="aoc-card-action"
          title=${`Revenue for ${agencyClient.name}`}
          @click=${() => void loadClientRevenue(host, client, agencyClient.id)}
        >Revenue</button>
      </div>
      <div class="aoc-card-header">
        <div class="aoc-card-avatar">${initials}</div>
        <div class="aoc-card-info">
          <div class="aoc-card-name">${agencyClient.name}</div>
          <div class="aoc-card-company">${statusLabel}</div>
        </div>
        <span class=${`aops-chip ${agencyClient.status}`}>${statusLabel}</span>
      </div>
      ${renderClientCardSocials(agencyClient)}
      <div class="aoc-card-details">
        ${billing ? html`<div class="aoc-card-detail"><span class="aoc-card-detail-icon">✉</span><span class="aoc-card-detail-value">${billing}</span></div>` : nothing}
        ${phone ? html`<div class="aoc-card-detail"><span class="aoc-card-detail-icon">☏</span><span class="aoc-card-detail-value">${phone}</span></div>` : nothing}
        ${!billing && !phone ? html`<div class="aoc-card-detail muted"><span class="aoc-card-detail-value">No contact details yet</span></div>` : nothing}
      </div>
      <div class="aoc-card-metrics">
        <span><b>${agencyClient.projectCount}</b><small>Projects</small></span>
        <span><b>${agencyClient.invoiceCount}</b><small>Invoices</small></span>
        <span><b>${money(agencyClient.mrrCents / 100, currency)}</b><small>MRR</small></span>
      </div>
      <div class="aoc-card-ledger">
        <span class="good"><b>${money(agencyClient.lifetimeInvoicedCents / 100, currency)}</b><small>Lifetime billed</small></span>
        <span class=${agencyClient.outstandingCents > 0 ? "warn" : ""}><b>${moneyCents(agencyClient.outstandingCents, currency)}</b><small>Outstanding</small></span>
      </div>
      <div class="aoc-card-footer" @click=${(event: Event) => event.stopPropagation()}>
        <button class="aoc-card-btn" @click=${() => openAgencyClientProfile(host, client, agencyClient.id)}>Profile</button>
        <button class="aoc-card-btn" @click=${() => openAgencyOpsDialog(host, "client-edit", { entityId: agencyClient.id })}>Edit</button>
        <button
          class="aoc-card-btn"
          ?disabled=${state.secondaryBusyId === agencyClient.id}
          @click=${() =>
            void updateAgencyClientStatus(
              host,
              client,
              agencyClient.id,
              agencyClient.status === "active" ? "inactive" : "active",
            )}
        >${state.secondaryBusyId === agencyClient.id ? "…" : agencyClient.status === "active" ? "Archive" : "Activate"}</button>
      </div>
    </article>
  `;
}

/**
 * Client kanban grouped by the *real* pipeline status (Cold, Lead, In progress,
 * …) — the same columns as the dedicated /clients page, not the three-value
 * legacy rollup. Premium glass columns, fluid drag with clear drop targets, and
 * status changes persisted through `agency.ops.clients.update` (pipelineStatus).
 */
function renderClientKanban(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  filteredClients: AgencyClient[],
  currency: string,
): TemplateResult {
  const columns = clientKanbanColumns(state);
  const byCol = clientsByPipelineStatus(state, filteredClients);

  const onDragStart = (event: DragEvent, clientId: string) => {
    event.dataTransfer?.setData("text/plain", clientId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    setAgencyDraggingClient(host, clientId);
  };
  const onDragEnd = () => {
    setAgencyDraggingClient(host, null);
    setAgencyClientKanbanDragOverCol(host, null);
  };
  const onDragOver = (event: DragEvent, colKey: string) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setAgencyClientKanbanDragOverCol(host, colKey);
  };
  const onDragLeave = (event: DragEvent, colKey: string) => {
    const rel = event.relatedTarget as HTMLElement | null;
    const colEl = event.currentTarget as HTMLElement;
    if (rel && colEl.contains(rel)) return;
    if (state.clientKanbanDragOverCol === colKey) setAgencyClientKanbanDragOverCol(host, null);
  };
  const onDrop = (event: DragEvent, label: string) => {
    event.preventDefault();
    const clientId = event.dataTransfer?.getData("text/plain") || state.draggingClientId;
    setAgencyDraggingClient(host, null);
    setAgencyClientKanbanDragOverCol(host, null);
    if (!clientId) return;
    const existing = state.clients.find((item) => item.id === clientId);
    if (!existing) return;
    const current = (existing.pipelineStatusLabel ?? existing.pipelineStatus ?? "").toLowerCase();
    if (current === label.toLowerCase()) return;
    void updateAgencyClientPipelineStatus(host, client, clientId, label);
  };

  return html`
    <div class="crm-kanban aops-crm-kanban">
      ${columns.map((label) => {
        const colKey = label.toLowerCase();
        const clients = byCol.get(colKey) ?? [];
        const colColor = pipelineColumnColor(label);
        const isDragOver = state.clientKanbanDragOverCol === colKey;
        return html`
          <div
            class=${`crm-kanban-col ${isDragOver ? "drag-over" : ""}`}
            style=${`--kcol-color:${colColor}`}
            @dragover=${(event: DragEvent) => onDragOver(event, colKey)}
            @dragleave=${(event: DragEvent) => onDragLeave(event, colKey)}
            @drop=${(event: DragEvent) => onDrop(event, label)}
          >
            <div class="crm-kanban-header" style=${`color:${colColor};border-left:3px solid ${colColor}`}>
              <span>${label}</span>
              <span class="crm-kanban-count">${clients.length}</span>
            </div>
            <div class="crm-kanban-cards">
              ${clients.map(
                (agencyClient) => html`
                  <article
                    class=${`crm-kanban-card aops-client-kcard ${state.draggingClientId === agencyClient.id ? "dragging" : ""}`}
                    draggable="true"
                    @dragstart=${(event: DragEvent) => onDragStart(event, agencyClient.id)}
                    @dragend=${onDragEnd}
                    @click=${() => openAgencyClientProfile(host, client, agencyClient.id)}
                  >
                    <div class="aops-kcard-head">
                      <div class="aops-client-avatar">${agencyClient.name.slice(0, 2).toUpperCase()}</div>
                      <div class="aops-client-ident">
                        <div class="crm-kanban-card-name">${agencyClient.name}</div>
                        <div class="crm-kanban-card-company">${agencyClient.billingEmail ?? "No billing email"}</div>
                      </div>
                    </div>
                    <div class="aops-client-metrics rich">
                      <span><b>${agencyClient.projectCount}</b>proj</span>
                      <span><b>${agencyClient.invoiceCount}</b>inv</span>
                      <span><b>${money(agencyClient.mrrCents / 100, currency)}</b>MRR</span>
                    </div>
                    <div class="aops-client-ledger compact">
                      <span class=${agencyClient.outstandingCents > 0 ? "warn" : ""}>${moneyCents(agencyClient.outstandingCents, currency)} outstanding</span>
                    </div>
                  </article>`,
              )}
              <div class="crm-kanban-drop-zone">Drop to set “${label}”</div>
            </div>
          </div>`;
      })}
    </div>
    <small style="display:block;margin-top:12px">Drag a client card between pipeline columns to change its status, or click a card to open its full profile. Changes persist to the agency database.</small>
  `;
}

/** Stable accent colour for a pipeline column, derived from its stage meaning. */
function pipelineColumnColor(label: string): string {
  const key = label.toLowerCase();
  if (/(cold|lead|prospect)/.test(key)) return "color-mix(in srgb, var(--g-primary) 55%, #6b7280)";
  if (/(in progress|updating|active|won|live)/.test(key)) return "var(--g-primary, #c9a349)";
  if (/(completed|archived|inactive)/.test(key)) return "color-mix(in srgb, var(--g-primary) 40%, #4b5563)";
  if (/(lost|cancelled|canceled)/.test(key)) return "color-mix(in srgb, #b45309 60%, var(--g-primary))";
  return "var(--g-primary, #c9a349)";
}

// ── Client profile (full-page detail surface) ──────────────────────────────

const PROFILE_PROJECT_COLUMNS: Array<{ status: AgencyProjectSummary["status"]; label: string }> = [
  { status: "planned", label: "Planned" },
  { status: "active", label: "Active" },
  { status: "on_hold", label: "On hold" },
  { status: "completed", label: "Completed" },
  { status: "cancelled", label: "Cancelled" },
];

const noteTimestamp = (value: string | number): number => {
  const n = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
};

/**
 * Full-screen client profile. Sections:
 *  (a) Deadlines — upcoming project targetEndAt + task dueAt for this client.
 *  (b) Projects — the client's projects.
 *  (c) Related notes — existing notes system (tag-scoped) + add-note input.
 *  (d) Activity timeline — assembled from invoices, projects, tasks and notes.
 *  (e) Per-client project kanban — drag to change status (existing RPC).
 *  (f) Autonomous agent trigger — existing sessions.spawn path.
 */
function renderClientProfile(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  agencyClient: AgencyClient,
  currency = state.finance?.currency ?? "USD",
): TemplateResult {
  const clientId = agencyClient.id;
  const projects = state.projects.filter((p) => p.clientId === clientId);
  const projectIds = new Set(projects.map((p) => p.id));
  const tasks = state.tasks.filter((t) => projectIds.has(t.projectId));
  const invoices = state.invoices.filter((inv) => inv.clientId === clientId);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Project";

  // (a) Deadlines — projects with a target end date + tasks with due dates, in
  // chronological order, nearest first, open items only.
  const now = Date.now();
  const deadlines: Array<{ kind: "project" | "task"; name: string; due: number; context: string; overdue: boolean }> = [];
  for (const p of projects) {
    if (p.targetEndAt && !["completed", "cancelled"].includes(p.status)) {
      deadlines.push({ kind: "project", name: p.name, due: p.targetEndAt, context: p.status.replace("_", " "), overdue: p.targetEndAt < now });
    }
  }
  for (const t of tasks) {
    if (t.dueAt && !["done", "cancelled"].includes(t.status)) {
      deadlines.push({ kind: "task", name: t.title, due: t.dueAt, context: projectName(t.projectId), overdue: t.dueAt < now });
    }
  }
  deadlines.sort((a, b) => a.due - b.due);

  // (d) Activity timeline — union of the timestamped events we have.
  const timeline: Array<{ ts: number; icon: string; label: string; sub: string }> = [];
  for (const inv of invoices) {
    if (inv.issuedAt) timeline.push({ ts: inv.issuedAt, icon: "🧾", label: `Invoice ${inv.number} issued · ${moneyCents(inv.totalCents, currency)}`, sub: inv.status.replace("_", " ") });
    if (inv.amountPaidCents > 0 && (inv.status === "paid" || inv.status === "partially_paid")) {
      timeline.push({ ts: inv.issuedAt ?? now, icon: "💰", label: `Payment · ${moneyCents(inv.amountPaidCents, currency)} on ${inv.number}`, sub: inv.status.replace("_", " ") });
    }
  }
  for (const p of projects) {
    if (p.targetEndAt) timeline.push({ ts: p.targetEndAt, icon: "📌", label: `${p.name} target`, sub: p.status.replace("_", " ") });
  }
  for (const n of state.clientProfileNotes) {
    timeline.push({ ts: noteTimestamp(n.updatedAt), icon: "📝", label: `Note · ${n.name}`, sub: (n.body || "").slice(0, 60) });
  }
  timeline.sort((a, b) => b.ts - a.ts);

  // (e) Per-client project kanban grouping.
  const projByStatus = new Map<AgencyProjectSummary["status"], AgencyProjectSummary[]>();
  for (const col of PROFILE_PROJECT_COLUMNS) projByStatus.set(col.status, []);
  for (const p of projects) {
    if (!projByStatus.has(p.status)) projByStatus.set(p.status, []);
    projByStatus.get(p.status)!.push(p);
  }

  const onProjDragStart = (event: DragEvent, projectId: string) => {
    event.dataTransfer?.setData("text/plain", projectId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    setAgencyDraggingProfileProject(host, projectId);
  };
  const onProjDrop = (event: DragEvent, status: AgencyProjectSummary["status"]) => {
    event.preventDefault();
    const projectId = event.dataTransfer?.getData("text/plain") || state.draggingProfileProjectId;
    setAgencyDraggingProfileProject(host, null);
    setAgencyProfileKanbanDragOverCol(host, null);
    if (!projectId) return;
    const proj = state.projects.find((p) => p.id === projectId);
    if (!proj || proj.status === status) return;
    void transitionAgencyProject(host, client, projectId, status);
  };

  const initials = agencyClient.name.slice(0, 2).toUpperCase();
  const statusLabel = agencyClient.pipelineStatusLabel ?? titleCase(agencyClient.status);
  const outstanding = agencyClient.outstandingCents;

  return html`
    <section class="aops-profile">
      <div class="aops-profile-topbar">
        <button class="aops-btn ghost" @click=${() => closeAgencyClientProfile(host)}>← Back to clients</button>
        <div class="aops-profile-actions">
          <button class="aops-btn ghost" @click=${() => openAgencyOpsDialog(host, "client-edit", { entityId: clientId })}>Edit client</button>
          <button class="aops-btn ghost" @click=${() => void loadClientRevenue(host, client, clientId)}>Revenue</button>
        </div>
      </div>

      <header class="aops-profile-hero">
        <div class="aops-profile-avatar">${initials}</div>
        <div class="aops-profile-ident">
          <h1>${agencyClient.name}</h1>
          <div class="aops-profile-meta">
            <span class="aops-chip">${statusLabel}</span>
            ${agencyClient.billingEmail ? html`<span>✉ ${agencyClient.billingEmail}</span>` : nothing}
            ${agencyClient.phone ? html`<span>☏ ${agencyClient.phone}</span>` : nothing}
          </div>
        </div>
        <div class="aops-profile-stats">
          <div><b>${projects.length}</b><small>Projects</small></div>
          <div><b>${invoices.length}</b><small>Invoices</small></div>
          <div><b>${money(agencyClient.mrrCents / 100, currency)}</b><small>MRR</small></div>
          <div class=${outstanding > 0 ? "warn" : ""}><b>${moneyCents(outstanding, currency)}</b><small>Outstanding</small></div>
        </div>
      </header>

      <!-- (f) Autonomous agent trigger -->
      <section class="aops-profile-card aops-profile-agent">
        <h3>Launch an autonomous agent for this client</h3>
        <p class="aops-profile-hint">Describe a task and dispatch a coder to carry it out. Runs through the agency's subagent system and appears in your agents list.</p>
        <div class="aops-profile-agent-row">
          <textarea
            class="aops-profile-agent-input"
            placeholder="e.g. Draft the Q3 content plan and outline deliverables for ${agencyClient.name}…"
            .value=${state.clientProfileAgentTask}
            @input=${(e: Event) => setAgencyClientAgentTask(host, (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <button
            class="aops-btn primary"
            ?disabled=${state.clientProfileAgentBusy || !state.clientProfileAgentTask.trim()}
            @click=${() => void spawnAgencyClientAgent(host, client, clientId)}
          >${state.clientProfileAgentBusy ? "Launching…" : "Launch agent"}</button>
        </div>
        ${state.clientProfileAgentNotice ? html`<div class="aops-inline-notice good">${state.clientProfileAgentNotice}</div>` : nothing}
      </section>

      <div class="aops-profile-grid">
        <!-- (a) Deadlines -->
        <section class="aops-profile-card">
          <h3>Upcoming deadlines</h3>
          ${
            deadlines.length
              ? html`<ul class="aops-profile-list">
                  ${deadlines.slice(0, 12).map((d) => html`
                    <li class=${d.overdue ? "overdue" : ""}>
                      <span class="aops-profile-dot ${d.kind}"></span>
                      <div class="aops-profile-list-main">
                        <strong>${d.name}</strong>
                        <small>${d.kind === "project" ? "Project" : "Task"} · ${d.context}</small>
                      </div>
                      <span class="aops-profile-when ${d.overdue ? "warn" : ""}">${shortDate(d.due)}${d.overdue ? " · overdue" : ""}</span>
                    </li>`)}
                </ul>`
              : html`<p class="aops-profile-empty">No upcoming deadlines. Add due dates to this client's projects or tasks.</p>`
          }
        </section>

        <!-- (b) Projects -->
        <section class="aops-profile-card">
          <h3>Projects</h3>
          ${
            projects.length
              ? html`<ul class="aops-profile-list">
                  ${projects.map((p) => html`
                    <li>
                      <span class="aops-profile-dot project"></span>
                      <div class="aops-profile-list-main">
                        <strong>${p.name}</strong>
                        <small>${p.budgetCents ? money(p.budgetCents / 100, currency) + " budget" : "No budget set"}</small>
                      </div>
                      <span class=${`aops-chip ${p.status}`}>${p.status.replace("_", " ")}</span>
                    </li>`)}
                </ul>`
              : html`<p class="aops-profile-empty">No projects linked to this client yet.</p>`
          }
        </section>

        <!-- (c) Related notes -->
        <section class="aops-profile-card aops-profile-notes">
          <h3>Related notes</h3>
          <div class="aops-profile-note-add">
            <textarea
              class="aops-profile-note-input"
              placeholder="Add a note about ${agencyClient.name}…"
              .value=${state.clientProfileNoteDraft}
              @input=${(e: Event) => setAgencyClientNoteDraft(host, (e.target as HTMLTextAreaElement).value)}
            ></textarea>
            <button
              class="aops-btn primary compact"
              ?disabled=${state.clientProfileNoteBusy || !state.clientProfileNoteDraft.trim()}
              @click=${() => void addAgencyClientNote(host, client, clientId)}
            >${state.clientProfileNoteBusy ? "Saving…" : "Add note"}</button>
          </div>
          ${
            state.clientProfileNotesLoading
              ? html`<p class="aops-profile-empty">Loading notes…</p>`
              : state.clientProfileNotes.length
                ? html`<ul class="aops-profile-notes-list">
                    ${state.clientProfileNotes.map((n) => html`
                      <li>
                        <div class="aops-profile-note-head">
                          <strong>${n.name}</strong>
                          <small>${shortDate(noteTimestamp(n.updatedAt))}</small>
                        </div>
                        <p>${n.body}</p>
                      </li>`)}
                  </ul>`
                : html`<p class="aops-profile-empty">No related notes yet. Add the first one above.</p>`
          }
        </section>

        <!-- (d) Activity timeline -->
        <section class="aops-profile-card">
          <h3>Activity timeline</h3>
          ${
            timeline.length
              ? html`<ul class="aops-profile-timeline">
                  ${timeline.slice(0, 20).map((ev) => html`
                    <li>
                      <span class="aops-profile-tl-icon">${ev.icon}</span>
                      <div class="aops-profile-tl-main">
                        <strong>${ev.label}</strong>
                        ${ev.sub ? html`<small>${ev.sub}</small>` : nothing}
                      </div>
                      <span class="aops-profile-tl-when">${shortDate(ev.ts)}</span>
                    </li>`)}
                </ul>`
              : html`<p class="aops-profile-empty">No activity recorded yet.</p>`
          }
        </section>
      </div>

      <!-- (e) Per-client project kanban -->
      <section class="aops-profile-card aops-profile-kanban-wrap">
        <h3>Project board · ${agencyClient.name}</h3>
        <p class="aops-profile-hint">Drag a project between columns to change its status. Changes persist to the agency database.</p>
        <div class="crm-kanban aops-crm-kanban aops-profile-kanban">
          ${PROFILE_PROJECT_COLUMNS.map((col) => {
            const list = projByStatus.get(col.status) ?? [];
            const isDragOver = state.profileKanbanDragOverCol === col.status;
            return html`
              <div
                class=${`crm-kanban-col ${isDragOver ? "drag-over" : ""}`}
                @dragover=${(event: DragEvent) => { event.preventDefault(); setAgencyProfileKanbanDragOverCol(host, col.status); }}
                @dragleave=${(event: DragEvent) => {
                  const rel = event.relatedTarget as HTMLElement | null;
                  if (rel && (event.currentTarget as HTMLElement).contains(rel)) return;
                  if (state.profileKanbanDragOverCol === col.status) setAgencyProfileKanbanDragOverCol(host, null);
                }}
                @drop=${(event: DragEvent) => onProjDrop(event, col.status)}
              >
                <div class="crm-kanban-header"><span>${col.label}</span><span class="crm-kanban-count">${list.length}</span></div>
                <div class="crm-kanban-cards">
                  ${list.map((p) => html`
                    <article
                      class=${`crm-kanban-card ${state.draggingProfileProjectId === p.id ? "dragging" : ""}`}
                      draggable="true"
                      @dragstart=${(event: DragEvent) => onProjDragStart(event, p.id)}
                      @dragend=${() => setAgencyDraggingProfileProject(host, null)}
                    >
                      <div class="crm-kanban-card-name">${p.name}</div>
                      <div class="crm-kanban-card-company">${p.budgetCents ? money(p.budgetCents / 100, currency) : "No budget"}${p.targetEndAt ? " · due " + shortDate(p.targetEndAt) : ""}</div>
                      <div class="aops-client-actions">
                        <button
                          class="aops-btn ghost compact"
                          @click=${() => void spawnAgencyClientAgent(host, client, clientId, { projectId: p.id, projectName: p.name, task: `Advance the project "${p.name}".` })}
                        >Run agent</button>
                      </div>
                    </article>`)}
                  <div class="crm-kanban-drop-zone">Drop to set “${col.label}”</div>
                </div>
              </div>`;
          })}
        </div>
      </section>
    </section>
  `;
}

function renderEmployeeOperatingLoop(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const activeItems = state.employeeWorkItems.filter(
    (item) => !["completed", "cancelled"].includes(item.status),
  );
  const escalated = activeItems.filter((item) => item.status === "escalated");
  const dueReviews = state.employeeReviewCycles.filter((review) =>
    ["due", "overdue"].includes(review.status),
  );
  const workerName = (workerId: string) =>
    state.employees.find((employee) => employee.id === workerId)?.name ?? workerId;
  const nextStatus = (status: string): EmployeeWorkItemStatus | null =>
    status === "queued"
      ? "accepted"
      : status === "accepted" || status === "waiting"
        ? "in_progress"
        : status === "in_progress"
          ? "review"
          : status === "review" || status === "escalated"
            ? "completed"
            : null;

  return html`
    <section class="aops-surface">
      <header class="aops-surface-head">
        <div>
          <span class="aops-eyebrow">Employee operating loop</span>
          <h2>Inbox, schedules, responsibilities and reviews</h2>
          <p>Durable operating rhythm for human and AI employees, with explicit lifecycle and SLA escalation.</p>
        </div>
        <div class="aops-actions">
          <button
            class="aops-btn ghost"
            aria-label="Hand a work item to an employee"
            @click=${() => openAgencyOpsDialog(host, "employee-work-item")}
          >+ Work item</button>
          <button
            class="aops-btn primary"
            ?disabled=${state.secondaryBusyId !== null}
            @click=${() => void runAgencyEmployeeLoop(host, client)}
          >
            ${state.secondaryBusyId === "employee-loop" ? "Running…" : "Run operating loop"}
          </button>
        </div>
      </header>
      <div class="aops-summary-strip">
        <div><strong>${activeItems.length}</strong><span>Open inbox items</span></div>
        <div><strong>${escalated.length}</strong><span>SLA escalations</span></div>
        <div><strong>${state.employeeResponsibilities.filter((item) => item.enabled).length}</strong><span>Recurring duties</span></div>
        <div><strong>${dueReviews.length}</strong><span>Reviews due</span></div>
      </div>
      ${state.employeeLoopLastRunAt
        ? html`<div class="aops-inline-notice good">Operating loop ran ${relativeTime(state.employeeLoopLastRunAt)}.</div>`
        : nothing}

      <div class="aops-assignment-head">
        <div><span class="aops-eyebrow">Durable employee inbox</span><h3>Work items</h3></div>
        <span>${state.employeeWorkItems.length} total</span>
      </div>
      <div class="aops-assignment-list">
        ${state.employeeWorkItems.length
          ? state.employeeWorkItems.map((item) => {
              const next = nextStatus(item.status);
              return html`
                <article>
                  <div>
                    <div class="aops-row">
                      <strong>${item.title}</strong>
                      <span class=${`aops-chip ${item.status}`}>${item.status.replaceAll("_", " ")}</span>
                    </div>
                    <small>${workerName(item.workerId)} · ${item.priority} priority · updated ${relativeTime(item.updatedAt)}</small>
                    ${item.instructions ? html`<p>${item.instructions}</p>` : nothing}
                    ${item.dueAt ? html`<span>Due ${shortDate(item.dueAt)}</span>` : nothing}
                    ${item.waitingReason ? html`<div class="aops-inline-notice warning">${item.waitingReason}</div>` : nothing}
                  </div>
                  ${next
                    ? html`<button
                        class="aops-btn ghost"
                        ?disabled=${state.secondaryBusyId !== null}
                        @click=${() =>
                          void transitionEmployeeWorkItem(
                            host,
                            client,
                            item.id,
                            next,
                          )}
                      >${state.secondaryBusyId === item.id ? "Updating…" : next.replaceAll("_", " ")}</button>`
                    : nothing}
                </article>
              `;
            })
          : empty("No employee inbox items. Recurring responsibilities will generate work on the next loop run.")}
      </div>

      <div class="aops-settings-grid">
        <article class="aops-settings-card">
          <div class="aops-row">
            <h3>Schedules</h3>
            <button
              class="aops-btn ghost compact"
              aria-label="Add a working schedule for an employee"
              @click=${() => openAgencyOpsDialog(host, "employee-schedule")}
            >+ Schedule</button>
          </div>
          ${state.employeeSchedules.length
            ? state.employeeSchedules.map(
                (schedule) => html`<div class="aops-row">
                  <span><strong>${workerName(schedule.workerId)}</strong><small>${schedule.timezone} · ${schedule.shiftStart}–${schedule.shiftEnd}</small></span>
                  <span class=${schedule.enabled ? "aops-health good" : "aops-health"}>${schedule.enabled ? "active" : "disabled"}</span>
                </div>`,
              )
            : empty("No employee schedules configured.")}
        </article>
        <article class="aops-settings-card">
          <div class="aops-row">
            <h3>Recurring responsibilities</h3>
            <button
              class="aops-btn primary compact"
              aria-label="Add a recurring responsibility that drives the operating loop"
              @click=${() => openAgencyOpsDialog(host, "employee-responsibility")}
            >+ Responsibility</button>
          </div>
          <small>Recurring duties are what generate inbox work on each loop run.</small>
          ${state.employeeResponsibilities.length
            ? state.employeeResponsibilities.map(
                (responsibility) => html`<div>
                  <div class="aops-row"><strong>${responsibility.title}</strong><span class="aops-role">${responsibility.cadence}</span></div>
                  <small>${workerName(responsibility.workerId)} · ${responsibility.runAt} · SLA ${responsibility.slaMinutes}m · next ${shortDate(responsibility.nextRunAt)}</small>
                </div>`,
              )
            : empty("No recurring responsibilities configured.")}
        </article>
        <article class="aops-settings-card">
          <div class="aops-row">
            <h3>Manager reviews</h3>
            <button
              class="aops-btn ghost compact"
              aria-label="Schedule a manager review cycle"
              @click=${() => openAgencyOpsDialog(host, "employee-review")}
            >+ Review cycle</button>
          </div>
          ${state.employeeReviewCycles.length
            ? state.employeeReviewCycles.map((review) => {
                const outcome = state.reviewOutcomes[review.id] ?? "";
                return html`<div>
                  <div class="aops-row"><strong>${workerName(review.workerId)}</strong><span class=${`aops-chip ${review.status}`}>${review.status}</span></div>
                  <small>Manager ${workerName(review.managerWorkerId)} · ${shortDate(review.nextReviewAt)}</small>
                  ${review.status === "completed"
                    ? nothing
                    : html`<div class="aops-payment-row">
                        <label class="aops-field compact">
                          <span class="aops-visually-hidden">Review outcome</span>
                          <input
                            type="text"
                            placeholder="Review outcome"
                            aria-label=${`Outcome for the review of ${workerName(review.workerId)}`}
                            .value=${outcome}
                            @input=${(event: Event) =>
                              setAgencyReviewOutcome(
                                host,
                                review.id,
                                (event.target as HTMLInputElement).value,
                              )}
                          />
                        </label>
                        <button
                          class="aops-btn ghost compact"
                          aria-label=${`Complete the review cycle for ${workerName(review.workerId)}`}
                          ?disabled=${state.secondaryBusyId !== null || outcome.trim().length === 0}
                          @click=${() =>
                            void completeAgencyReviewCycle(host, client, review.id, outcome.trim())}
                        >${state.secondaryBusyId === review.id ? "Completing…" : "Complete"}</button>
                      </div>`}
                </div>`;
              })
            : empty("No manager review cycles configured.")}
        </article>
      </div>
    </section>
  `;
}

/**
 * Panel requests are fault isolated, which previously meant a failed fetch and
 * a genuinely empty workspace rendered identically. Name the endpoints that
 * failed so an operator can tell "no clients yet" from "we could not load your
 * clients".
 */
function renderFailedRequests(state: AgencyOperationsState) {
  if (state.failedRequests.length === 0) return nothing;
  return html`
    <div class="aops-alert warning">
      <strong>${state.failedRequests.length} panel${state.failedRequests.length === 1 ? "" : "s"} failed to load.</strong>
      Data shown below may be incomplete or stale.
      <ul style="margin:6px 0 0;padding-left:18px">
        ${state.failedRequests.map((entry) => html`<li>${entry}</li>`)}
      </ul>
    </div>
  `;
}

function renderSectionNavigation(host: AgencyOperationsHost, state: AgencyOperationsState) {
  return html`
    <nav class="aops-section-nav" aria-label="Agency operations">
      ${agencySections.map(
        ([id, label]) => html`
          <button
            class=${state.activeSection === id ? "active" : ""}
            @click=${() => setAgencyOperationsSection(host, id)}
          >${label}${id === "approvals" && state.approvals.length ? html` <b>${state.approvals.length}</b>` : nothing}</button>
        `,
      )}
    </nav>
  `;
}

/**
 * Per-employee durable memory. An AI employee's namespaced recall is the thing
 * that makes it an employee rather than a one-shot prompt, so it belongs in the
 * profile an operator already opens — not behind a separate tool.
 */
function renderEmployeeMemory(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  employee: AgencyEmployee,
): TemplateResult {
  const entries = state.employeeMemoryWorkerId === employee.id ? state.employeeMemory : [];
  const namespaces = [...new Set(entries.map((entry) => entry.namespace))].sort();
  return html`
    <div class="aops-detail-block">
      <div class="aops-row">
        <strong>Memory</strong>
        <button
          class="aops-btn ghost compact"
          aria-label=${`Add a memory entry for ${employee.name}`}
          @click=${() => openAgencyOpsDialog(host, "employee-memory", { entityId: employee.id })}
        >+ Memory</button>
      </div>
      <span>Namespaced recall this employee carries between work items.</span>
      ${
        state.employeeMemoryLoading && state.employeeMemoryWorkerId === employee.id
          ? html`<div class="aops-inline-notice">Loading memory…</div>`
          : entries.length
            ? html`
              <div class="aops-memory-list">
                ${namespaces.map(
                  (namespace) => html`
                    <div class="aops-memory-group">
                      <span class="aops-role">${namespace}</span>
                      ${entries
                        .filter((entry) => entry.namespace === namespace)
                        .map((entry) => {
                          const expired =
                            entry.expiresAt !== null && entry.expiresAt <= Date.now();
                          return html`
                            <div class="aops-memory-entry">
                              <div>
                                <strong>${entry.key}</strong>
                                <code>${stringifyMemoryValue(entry.value).slice(0, 220)}</code>
                                <small>
                                  ${entry.source} · updated ${relativeTime(entry.updatedAt)}
                                  ${
                                    entry.expiresAt === null
                                      ? " · no expiry"
                                      : ` · ${expired ? "expired" : "expires"} ${shortDate(entry.expiresAt)}`
                                  }
                                </small>
                              </div>
                              <button
                                class="aops-btn ghost compact"
                                aria-label=${`Edit the ${namespace} memory entry ${entry.key} for ${employee.name}`}
                                @click=${() =>
                                  openAgencyOpsDialog(host, "employee-memory", {
                                    entityId: employee.id,
                                    memoryEntryId: entry.id,
                                  })}
                              >Edit</button>
                            </div>
                          `;
                        })}
                    </div>
                  `,
                )}
              </div>
            `
            : html`<div class="aops-inline-notice">
                No memory recorded yet. Add the standing context this employee should always recall.
              </div>`
      }
    </div>
  `;
}

const CADENCE_SUMMARY: Record<string, string> = {
  daily: "every day",
  weekly: "weekly",
  monthly: "monthly",
};

/**
 * Attached SOPs, with the schedule that fires them and the outcome of the last
 * few runs. This is the closest thing an operator has to "what does this
 * employee actually do on its own", so an unloaded list must never read as an
 * empty one.
 */
function renderEmployeeSops(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  employee: AgencyEmployee,
): TemplateResult {
  const loadedForThisEmployee = state.employeeSopWorkerId === employee.id;
  const schedules = loadedForThisEmployee
    ? state.employeeSopSchedules.filter((schedule) => schedule.workerId === employee.id)
    : [];
  const sopById = new Map(state.sops.map((sop) => [sop.id, sop]));
  const runs = loadedForThisEmployee
    ? [...state.employeeSopRuns].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)
    : [];
  return html`
    <div class="aops-detail-block">
      <div class="aops-row">
        <strong>Standard operating procedures</strong>
        <button
          class="aops-btn ghost compact"
          ?disabled=${!state.sops.length}
          aria-label=${`Attach an SOP schedule to ${employee.name}`}
          @click=${() => openAgencyOpsDialog(host, "employee-sop-attach", { entityId: employee.id })}
        >+ Attach</button>
      </div>
      <span>Procedures this employee runs on a cadence, and what they last produced.</span>
      ${
        state.employeeSopLoading && loadedForThisEmployee
          ? html`<div class="aops-inline-notice">Loading SOPs…</div>`
          : !loadedForThisEmployee
            ? html`<div class="aops-inline-notice">SOPs have not been loaded for this employee.</div>`
            : schedules.length
              ? html`
                <div class="aops-sop-list">
                  ${schedules.map((schedule) => {
                    const sop = sopById.get(schedule.sopId);
                    return html`
                      <div class="aops-sop-row">
                        <div class="aops-sop-main">
                          <strong>${sop?.name ?? schedule.sopId}</strong>
                          <small>
                            ${CADENCE_SUMMARY[schedule.cadence] ?? schedule.cadence} at
                            ${schedule.runAt} ${schedule.timezone} ·
                            next ${shortDate(schedule.nextRunAt)} ·
                            ${schedule.enabled ? "enabled" : "paused"}
                          </small>
                        </div>
                        <div class="aops-sop-actions">
                          <button
                            class="aops-btn ghost compact"
                            ?disabled=${state.secondaryBusyId === schedule.sopId}
                            aria-label=${`Run ${sop?.name ?? "this SOP"} now for ${employee.name}`}
                            @click=${() =>
                              void runAgencyEmployeeSop(host, client, schedule.sopId, employee.id)}
                          >Run now</button>
                          <button
                            class="aops-btn ghost compact danger"
                            ?disabled=${state.secondaryBusyId === schedule.id}
                            aria-label=${`Detach ${sop?.name ?? "this SOP"} from ${employee.name}`}
                            @click=${() =>
                              void detachAgencyEmployeeSop(host, client, schedule.id, employee.id)}
                          >Detach</button>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
              : state.sops.length
                ? html`<div class="aops-inline-notice">
                    No SOP is attached. ${state.sops.length} procedures are available to attach.
                  </div>`
                : html`
                  <div class="aops-inline-notice">
                    The agency has no SOP catalogue, so there is nothing to attach yet. Provisioning
                    the starter set writes the procedures only — it attaches no schedules, creates no
                    cron jobs and generates no work.
                  </div>
                  <button
                    class="aops-btn ghost compact"
                    ?disabled=${state.secondaryBusyId === "sop-seed"}
                    aria-label="Provision the starter SOP catalogue for this agency"
                    @click=${() => void seedAgencySopCatalogue(host, client)}
                  >${state.secondaryBusyId === "sop-seed" ? "Provisioning…" : "Provision starter SOPs"}</button>
                `
      }
      ${
        loadedForThisEmployee && runs.length
          ? html`
            <div class="aops-run-list" aria-label="Recent SOP runs">
              ${runs.map((run) => {
                const summary = lastRunSummary([run]);
                return html`
                  <div class="aops-run-row">
                    <span class=${`aops-run-dot ${summary?.tone ?? "neutral"}`}></span>
                    <span class="aops-run-name">${sopById.get(run.sopId)?.name ?? run.sopId}</span>
                    <small>${run.trigger} · ${run.status} · ${relativeTime(run.createdAt)}</small>
                  </div>
                `;
              })}
            </div>
          `
          : loadedForThisEmployee && !state.employeeSopLoading
            ? html`<div class="aops-inline-notice">No SOP run history recorded for this employee.</div>`
            : nothing
      }
    </div>
  `;
}

/**
 * Multi-platform reachability. A missing gateway method and "bound to nothing"
 * are rendered as visibly different statements, because they lead an operator
 * to entirely different actions.
 */
function renderEmployeeChannels(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  employee: AgencyEmployee,
): TemplateResult {
  const loadedForThisEmployee = state.employeeChannelsWorkerId === employee.id;
  return html`
    <div class="aops-detail-block">
      <div class="aops-row">
        <strong>Channels</strong>
        <button
          class="aops-btn ghost compact"
          aria-label=${`Bind ${employee.name} to a chat channel`}
          @click=${() => openAgencyOpsDialog(host, "employee-channel", { entityId: employee.id })}
        >+ Bind</button>
      </div>
      <span>Where this employee speaks. Routing only — credentials stay in the gateway.</span>
      ${
        state.employeeChannelsLoading && loadedForThisEmployee
          ? html`<div class="aops-inline-notice">Loading channel bindings…</div>`
          : !loadedForThisEmployee
            ? html`<div class="aops-inline-notice">Channel bindings have not been loaded.</div>`
            : state.employeeChannelsUnavailable
              ? html`<div class="aops-inline-notice warning">
                  This gateway does not expose agency.ops.employee.channels.list, so reachability
                  cannot be read. This is not the same as "no channels".
                </div>`
              : state.employeeChannels.length
                ? html`
                  <div class="aops-channel-list">
                    ${state.employeeChannels.map(
                      (binding) => html`
                        <div class="aops-channel-row">
                          <span class=${`aops-channel-chip${binding.enabled ? "" : " off"}`}
                            >${channelLabel(binding.channelId)}</span
                          >
                          <div class="aops-channel-main">
                            <strong>${binding.handle || "Default handle"}</strong>
                            <small>${binding.target || "channel default"} · ${binding.direction}</small>
                          </div>
                          <div class="aops-sop-actions">
                            <button
                              class="aops-btn ghost compact"
                              aria-label=${`Edit the ${channelLabel(binding.channelId)} binding for ${employee.name}`}
                              @click=${() =>
                                openAgencyOpsDialog(host, "employee-channel", {
                                  entityId: employee.id,
                                  bindingId: binding.id,
                                })}
                            >Edit</button>
                            <button
                              class="aops-btn ghost compact danger"
                              ?disabled=${state.secondaryBusyId === binding.id}
                              aria-label=${`Remove the ${channelLabel(binding.channelId)} binding from ${employee.name}`}
                              @click=${() =>
                                void removeAgencyEmployeeChannel(host, client, binding.id, employee.id)}
                            >Remove</button>
                          </div>
                        </div>
                      `,
                    )}
                  </div>
                `
                : html`<div class="aops-inline-notice">
                    Not bound to any channel. This employee cannot be reached on Discord, Slack,
                    Telegram, WhatsApp, Signal, LINE or iMessage.
                  </div>`
      }
    </div>
  `;
}

/** How the employee writes and when it replies, from the structured profile. */
function renderEmployeeCommunication(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  employee: AgencyEmployee,
): TemplateResult {
  const worker =
    state.employeeDetail?.employee.id === employee.id ? state.employeeDetail.employee : null;
  const profile = worker?.communicationProfile ?? null;
  return html`
    <div class="aops-detail-block">
      <div class="aops-row">
        <strong>Communication</strong>
        <button
          class="aops-btn ghost compact"
          aria-label=${`Edit how ${employee.name} communicates`}
          @click=${() => void openAgencyEmployeeEditor(host, client, employee.id, "communication")}
        >Edit</button>
      </div>
      ${
        !worker
          ? html`<div class="aops-inline-notice">Operating profile has not loaded.</div>`
          : profile
            ? html`
              <div class="aops-token-list">
                <span>${profile.tone ?? "tone not set"}</span>
                <span>${profile.verbosity ?? "verbosity not set"}</span>
                <span>${profile.proactivity ?? "proactivity not set"}</span>
                <span>emoji: ${profile.emojiUse ?? "not set"}</span>
                <span>${profile.language ?? "en"}</span>
              </div>
              <span>
                Replies after ${profile.responseLatency?.minSeconds ?? "?"}s at the earliest,
                aiming for ${profile.responseLatency?.targetSeconds ?? "?"}s, batching messages
                that arrive within ${profile.responseLatency?.batchWindowSeconds ?? "?"}s.
              </span>
              <span>
                Outside working hours: ${profile.workingHours?.outsideHours ?? "not set"} ·
                reports ${profile.reportCadence ?? "not set"} at ${profile.reportTime ?? "—"}.
              </span>
              <span>
                Escalates to the manager after
                ${profile.escalation?.escalateAfterMinutes ?? "?"} minutes of silence.
              </span>
              ${
                profile.channelOverrides?.length
                  ? html`<span>${profile.channelOverrides.length} per-channel override(s) configured.</span>`
                  : nothing
              }
            `
            : html`<div class="aops-inline-notice">
                No structured communication profile on this record. The employee falls back to its
                legacy cadence: ${worker.communicationCadence || "none recorded"}.
              </div>`
      }
    </div>
  `;
}

/**
 * The full read surface for one employee: identity, governance, capacity,
 * operating profile, memory, SOPs, channels, and the deactivate path.
 */
function renderEmployeeDetailPanel(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  selected: AgencyEmployee,
): TemplateResult {
  const worker =
    state.employeeDetail?.employee.id === selected.id ? state.employeeDetail.employee : null;
  const autonomyLevel = worker?.autonomyLevel ?? selected.autonomyLevel;
  const threshold = worker?.approvalThreshold ?? selected.approvalThreshold;
  const described = describeAutonomy(autonomyLevel);
  const backend = worker?.modelBinding ?? selected.modelBinding ?? selected.model ?? null;
  const exec = worker?.executionProfile ?? null;
  return html`
    <aside class="aops-detail">
      <button
        class="aops-x"
        aria-label=${`Close the profile of ${selected.name}`}
        @click=${() => selectAgencyEmployee(host, null)}
      >×</button>
      <div class=${`aops-avatar large${selected.kind === "ai" ? " ai" : ""}`}>
        ${selected.name.slice(0, 2).toUpperCase()}
      </div>
      <span class=${`aops-worker ${selected.kind}`}
        >${selected.kind === "ai" ? "AI employee" : "Human employee"}</span
      >
      <h2>${selected.name}</h2>
      <p>${selected.role || "No role set"}</p>

      <div class="aops-detail-actions">
        <button
          class="aops-btn primary compact"
          aria-label=${`Customise every setting for ${selected.name}`}
          @click=${() => void openAgencyEmployeeEditor(host, client, selected.id)}
        >Customise employee</button>
        <button
          class="aops-btn ghost compact"
          aria-label=${`Hand a work item to ${selected.name}`}
          @click=${() => openAgencyOpsDialog(host, "employee-work-item", { entityId: selected.id })}
        >Assign work</button>
      </div>

      <div class="aops-detail-block">
        <strong>Autonomy</strong>
        ${autonomyChip(autonomyLevel, threshold)}
        <span>
          ${described
            ? described.detail
            : "This gateway did not report an autonomy level, so it is unknown whether this employee completes work unattended."}
        </span>
        ${
          typeof threshold === "number"
            ? html`<span>Approval threshold ${money(threshold)} — work estimated above this always escalates.</span>`
            : html`<span class="aops-unloaded">Approval threshold not reported.</span>`
        }
      </div>

      <dl>
        <div><dt>Department</dt><dd>${selected.department || "Unassigned"}</dd></div>
        <div><dt>Reports to</dt><dd>${selected.managerName ?? "Not assigned"}</dd></div>
        <div><dt>Status</dt><dd>${selected.availability}</dd></div>
        <div><dt>Employment</dt><dd>${worker?.employmentStatus ?? selected.employmentStatus ?? "Not reported"}</dd></div>
        <div><dt>Timezone</dt><dd>${worker?.timezone ?? selected.timezone ?? "Not reported"}</dd></div>
        <div><dt>Open work</dt><dd>${selected.activeWork}</dd></div>
        <div><dt>Performance</dt><dd>${selected.performanceScore ?? "Not reviewed"}</dd></div>
        <div>
          <dt>Runs on</dt>
          <dd>${backend ?? (selected.kind === "ai" ? "Gateway default backend" : "Human — no model")}</dd>
        </div>
        ${
          exec
            ? html`<div>
                <dt>Fallback backend</dt>
                <dd>${exec.fallbackModelBinding ?? "Gateway default"}</dd>
              </div>
              <div>
                <dt>Concurrency</dt>
                <dd>${exec.maxConcurrent ?? "Gateway default"}</dd>
              </div>
              <div>
                <dt>Run timeout</dt>
                <dd>${exec.timeoutMinutes === null || exec.timeoutMinutes === undefined
                  ? "Gateway default"
                  : `${exec.timeoutMinutes} min`}</dd>
              </div>
              ${
                exec.toolAllowlist?.length || exec.toolDenylist?.length
                  ? html`<div>
                      <dt>Tool policy</dt>
                      <dd>
                        ${exec.toolAllowlist?.length ? `allow ${exec.toolAllowlist.join(", ")}` : "allow all"}${
                          exec.toolDenylist?.length ? ` · deny ${exec.toolDenylist.join(", ")}` : ""
                        }
                      </dd>
                    </div>`
                  : nothing
              }`
            : html`<div>
                <dt>Executor limits</dt>
                <dd>${worker ? "Inherits gateway defaults" : "Not loaded"}</dd>
              </div>`
        }
        <div>
          <dt>Heartbeat</dt>
          <dd>
            ${worker?.lastHeartbeatAt ? relativeTime(worker.lastHeartbeatAt) : "Not reported"}
          </dd>
        </div>
      </dl>

      <div class="aops-detail-block">
        <strong>Capacity</strong>
        <span>${selected.allocatedHours} of ${selected.capacityHours} hours allocated</span>
        ${progress(
          selected.capacityHours ? (selected.allocatedHours / selected.capacityHours) * 100 : 0,
          allocationTone(
            Math.round((selected.allocatedHours / Math.max(1, selected.capacityHours)) * 100),
          ),
        )}
      </div>

      ${
        state.secondaryLoading
          ? html`<div class="aops-inline-notice">Loading operating profile…</div>`
          : worker
            ? html`
              <div class="aops-detail-block">
                <strong>Persona</strong>
                ${
                  worker.persona
                    ? html`<span>${worker.persona}</span>`
                    : html`<span class="aops-unloaded">No persona written for this employee.</span>`
                }
              </div>
              <div class="aops-detail-block">
                <strong>Skills &amp; capabilities</strong>
                ${
                  worker.skills.length || worker.capabilities.length
                    ? html`<div class="aops-token-list">
                        ${worker.skills.map(
                          (skill) => html`<span title=${`Proficiency ${skill.level} of 5`}
                            >${skill.skill} · L${skill.level}</span
                          >`,
                        )}
                        ${worker.capabilities.map((capability) => html`<span>${capability}</span>`)}
                      </div>`
                    : html`<span class="aops-unloaded">None recorded.</span>`
                }
              </div>
              <div class="aops-detail-block">
                <strong>Goals &amp; KPIs</strong>
                ${worker.goals.map((goal) => html`<span>Goal · ${goal}</span>`)}
                ${worker.kpis.map((kpi) => html`<span>KPI · ${kpi}</span>`)}
                ${
                  worker.goals.length || worker.kpis.length
                    ? nothing
                    : html`<span class="aops-unloaded">No goals or KPIs set.</span>`
                }
              </div>
              ${
                state.employeeDetail?.performance
                  ? html`<div class="aops-score-grid">
                      <div><strong>${state.employeeDetail.performance.qualityScore ?? "—"}</strong><span>Quality</span></div>
                      <div><strong>${state.employeeDetail.performance.reliabilityScore ?? "—"}</strong><span>Reliability</span></div>
                      <div><strong>${state.employeeDetail.performance.outcomeAttainmentPercent ?? "—"}%</strong><span>Outcomes</span></div>
                    </div>`
                  : html`<div class="aops-inline-notice">No performance review recorded yet.</div>`
              }
            `
            : html`<div class="aops-inline-notice warning">
                The operating profile could not be read for this employee. Persona, skills, goals and
                autonomy shown above may be incomplete.
              </div>`
      }

      ${renderEmployeeCommunication(host, state, client, selected)}
      ${renderEmployeeChannels(host, state, client, selected)}
      ${renderEmployeeSops(host, state, client, selected)}
      ${renderEmployeeMemory(host, state, selected)}

      <div class="aops-detail-block aops-danger-zone">
        <strong>Deactivate</strong>
        <span>
          Takes ${selected.name} off the active roster and sets its status offline. Work already
          assigned is not deleted.
        </span>
        <button
          class="aops-btn ghost compact danger"
          ?disabled=${state.secondaryBusyId === selected.id}
          aria-label=${`Deactivate ${selected.name}`}
          @click=${() => void deactivateAgencyEmployee(host, client, selected.id)}
        >${state.secondaryBusyId === selected.id ? "Deactivating…" : "Deactivate employee"}</button>
      </div>
    </aside>
  `;
}

function renderEmployeeDirectory(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const search = state.employeeSearch.trim().toLowerCase();
  const employees = state.employees.filter((employee) => {
    if (state.employeeFilter !== "all" && employee.kind !== state.employeeFilter) return false;
    if (!search) return true;
    return [employee.name, employee.role, employee.department, employee.model, employee.modelBinding]
      .filter((part): part is string => typeof part === "string")
      .some((part) => part.toLowerCase().includes(search));
  });
  const selected = state.employees.find((employee) => employee.id === state.selectedEmployeeId);
  const autonomous = state.employees.filter(
    (employee) => (employee.autonomyLevel ?? -1) >= 2,
  ).length;
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head">
        <div>
          <span class="aops-eyebrow">Workforce</span>
          <h2>Employee directory</h2>
          <p>One accountable roster for human and AI employees.</p>
        </div>
        <button class="aops-btn primary" @click=${() => openAgencyOpsDialog(host, "employee")}>+ Employee</button>
      </header>
      <div class="aops-summary-strip">
        <div><strong>${state.employees.length}</strong><span>Total employees</span></div>
        <div><strong>${state.employees.filter((item) => item.kind === "human").length}</strong><span>Humans</span></div>
        <div><strong>${state.employees.filter((item) => item.kind === "ai").length}</strong><span>AI employees</span></div>
        <div><strong>${state.employees.filter((item) => item.availability === "blocked").length}</strong><span>Blocked</span></div>
        <div
          title="Employees at autonomy level 2 or 3, which can complete work without a human seeing it"
        ><strong>${autonomous}</strong><span>Self-completing</span></div>
      </div>
      <div class="aops-surface-toolbar">
        <div class="aops-filters">
          ${(["all", "human", "ai"] as const).map(
            (filter) => html`
              <button
                class=${state.employeeFilter === filter ? "active" : ""}
                @click=${() => setAgencyEmployeeFilter(host, filter)}
              >${filter === "all" ? "Everyone" : filter === "ai" ? "AI employees" : "Humans"}</button>
            `,
          )}
        </div>
        <label class="aops-search">
          <span class="aops-visually-hidden">Search employees</span>
          <input
            type="search"
            placeholder="Search name, role, department or model"
            aria-label="Search employees by name, role, department or model"
            .value=${state.employeeSearch}
            @input=${(event: Event) =>
              setAgencyEmployeeSearch(host, (event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="aops-filters">
          ${(["cards", "list"] as const).map(
            (layout) => html`
              <button
                class=${state.employeeLayout === layout ? "active" : ""}
                aria-pressed=${state.employeeLayout === layout ? "true" : "false"}
                aria-label=${layout === "cards" ? "Show rich employee cards" : "Show a dense employee list"}
                @click=${() => setAgencyEmployeeLayout(host, layout)}
              >${layout === "cards" ? "Cards" : "Dense"}</button>
            `,
          )}
        </div>
        <span>${employees.length} shown</span>
      </div>
      <div class=${`${selected ? "aops-directory with-detail" : "aops-directory"} layout-${state.employeeLayout}`}>
        <div class="aops-roster">
          ${
            employees.length
              ? employees.map((employee) => renderEmployee(employee, host, state, client))
              : empty(
                  state.employees.length
                    ? `${state.employees.length} employees are on the roster, but none match this filter or search.`
                    : "No employees on the roster. Add a human or AI employee to establish one.",
                )
          }
        </div>
        ${selected ? renderEmployeeDetailPanel(host, state, client, selected) : nothing}
      </div>
    </section>
  `;
}

function renderWorkAllocation(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const sorted = [...state.employees].sort((a, b) => b.utilizationPercent - a.utilizationPercent);
  const totalCapacity = sorted.reduce((sum, employee) => sum + employee.capacityHours, 0);
  const totalAllocated = sorted.reduce((sum, employee) => sum + employee.allocatedHours, 0);
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head">
        <div><span class="aops-eyebrow">Live oversight</span><h2>Work allocation</h2>
          <p>Mission control for the autonomous workforce — the live work board, running agents,
            the human gate and the activity feed on one screen.</p></div>
        <div class="aops-actions">
          <button class="aops-btn primary" @click=${() => openAgencyOpsDialog(host, "assignment")}>+ Assignment</button>
        </div>
      </header>
      ${renderAgencyOversightBoard(host as unknown as AgencyOversightHost, client, state.auditEvents)}
      <div class="aops-assignment-head">
        <div><span class="aops-eyebrow">Delivery planning</span><h3>Weekly capacity</h3></div>
        <span>${totalAllocated}/${totalCapacity}h allocated ·
          ${sorted.filter((item) => item.allocatedHours > item.capacityHours).length} overallocated</span>
      </div>
      <div class="aops-allocation-list">
        ${
          sorted.length
            ? sorted.map((employee) => {
                const allocation = employee.capacityHours
                  ? Math.round((employee.allocatedHours / employee.capacityHours) * 100)
                  : 0;
                return html`
                <article>
                  <div class="aops-avatar">${employee.name.slice(0, 2).toUpperCase()}</div>
                  <div>
                    <div class="aops-row"><strong>${employee.name}</strong>
                      <span class=${`aops-worker ${employee.kind}`}>${employee.kind}</span></div>
                    <small>${employee.role} · ${employee.activeWork} active work items</small>
                    ${progress(
                      allocation,
                      allocationTone(allocation),
                    )}
                  </div>
                  <div class="aops-allocation-value">
                    <strong>${employee.allocatedHours}/${employee.capacityHours}h</strong>
                    <span>${allocation}% allocated</span>
                  </div>
                  <label>Capacity
                    <input type="number" min="1" max="168" .value=${String(employee.capacityHours)}
                      @change=${(event: Event) =>
                        void updateAgencyEmployeeCapacity(
                          host,
                          client,
                          employee.id,
                          Number((event.target as HTMLInputElement).value),
                        )} />
                  </label>
                </article>
              `;
              })
            : empty("No employee capacity is available. Add employees before allocating work.")
        }
      </div>
      <div class="aops-assignment-head">
        <div><span class="aops-eyebrow">Work queue</span><h3>Assignments</h3></div>
        <span>${state.assignments.length} total</span>
      </div>
      <div class="aops-assignment-list">
        ${
          state.assignments.length
            ? state.assignments.map(
                (assignment) => html`
                <article>
                  <div>
                    <div class="aops-row"><strong>${assignment.title}</strong>
                      <span class=${`aops-chip ${assignment.status}`}>${assignment.status}</span></div>
                    <small>${assignment.estimatedHours}h estimated · priority ${assignment.priority} ·
                      ${assignment.members.length} assigned</small>
                    <div class="aops-token-list">
                      ${assignment.requiredSkills.map(
                        (skill) => html`<span>${skill.skill} L${skill.minimumLevel}</span>`,
                      )}
                    </div>
                  </div>
                  <div class="aops-actions">
                    <button class="aops-btn ghost"
                      aria-label=${`Score every candidate against ${assignment.title}`}
                      ?disabled=${state.secondaryBusyId !== null}
                      @click=${() => void checkAgencyAssignmentSuitability(host, client, assignment)}>
                      ${state.secondaryBusyId === `suitability:${assignment.id}` ? "Scoring…" : "Check candidates"}
                    </button>
                    <button class="aops-btn ghost"
                      aria-label=${`Plan a hybrid human and AI team for ${assignment.title}`}
                      ?disabled=${state.secondaryBusyId === assignment.id}
                      @click=${() => void planAgencyAssignmentTeam(host, client, assignment)}>
                      ${state.secondaryBusyId === assignment.id ? "Planning…" : "Plan hybrid team"}
                    </button>
                  </div>
                  ${
                    state.suitability?.assignmentId === assignment.id
                      ? html`<div class="aops-suitability">
                        <strong>Candidate suitability</strong>
                        ${
                          state.suitability.results.length
                            ? state.suitability.results.slice(0, 8).map((candidate) => {
                                const worker = state.employees.find(
                                  (employee) => employee.id === candidate.workerId,
                                );
                                const blockers = [
                                  ...candidate.missingSkills.map((skill) => `missing ${skill}`),
                                  ...candidate.missingCapabilities.map(
                                    (capability) => `no ${capability}`,
                                  ),
                                  ...candidate.reasons,
                                ];
                                return html`<div class="aops-suitability-row">
                                  <span class=${candidate.eligible ? "aops-health good" : "aops-health"}>
                                    ${Math.round(candidate.score)}
                                  </span>
                                  <div>
                                    <strong>${worker?.name ?? candidate.workerId}</strong>
                                    <small>
                                      ${Math.round(candidate.skillCoverage * 100)}% skill coverage ·
                                      ${candidate.availableHours}h free ·
                                      ${candidate.eligible ? "eligible" : "not eligible"}
                                    </small>
                                    ${
                                      blockers.length
                                        ? html`<small>${[...new Set(blockers)].join(" · ")}</small>`
                                        : nothing
                                    }
                                  </div>
                                </div>`;
                              })
                            : empty("No active workers were scored for this assignment.")
                        }
                      </div>`
                      : nothing
                  }
                  ${
                    state.hybridPlan?.assignmentId === assignment.id
                      ? html`<div class="aops-hybrid-plan">
                        <strong>${Math.round(state.hybridPlan.skillCoverage * 100)}% skill coverage ·
                          ${money(state.hybridPlan.estimatedCost, state.finance.currency)}</strong>
                        <span>${
                          state.hybridPlan.members
                            .map(
                              (member) =>
                                `${member.worker.displayName} (${member.worker.type}, ${member.allocatedHours}h)`,
                            )
                            .join(" · ") || "No eligible team available"
                        }</span>
                        ${state.hybridPlan.warnings.map((warning) => html`<small>${warning}</small>`)}
                      </div>`
                      : nothing
                  }
                </article>
              `,
              )
            : empty("No workforce assignments yet. Create the first one to start allocating work.")
        }
      </div>
    </section>
    <!--
      The board's modal overlays are mounted OUTSIDE .aops-surface on purpose:
      that section's backdrop-filter would otherwise re-base their fixed-position
      scrims and drop them below the fold. Here they centre in the viewport, like
      every other agency dialog.
    -->
    ${renderAgencyOversightOverlays(host as unknown as AgencyOversightHost, client)}
  `;
}

function renderApprovalInbox(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const highRisk = state.approvals.filter((approval) => approval.risk === "high").length;
  const oldest = [...state.approvals].sort((a, b) => a.requestedAt - b.requestedAt)[0];
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head"><div><span class="aops-eyebrow">Human control</span>
        <h2>Approval inbox</h2><p>Review consequential AI and employee actions before execution.</p></div></header>
      <div class="aops-summary-strip">
        <div><strong>${state.approvals.length}</strong><span>Pending</span></div>
        <div><strong>${highRisk}</strong><span>High risk</span></div>
        <div><strong>${oldest ? relativeTime(oldest.requestedAt) : "—"}</strong><span>Oldest request</span></div>
      </div>
      <div class="aops-approval-inbox">
        ${
          state.approvals.length
            ? [...state.approvals]
                .sort((a, b) => {
                  const risk = { high: 3, medium: 2, low: 1 };
                  return risk[b.risk] - risk[a.risk] || a.requestedAt - b.requestedAt;
                })
                .map((approval) => renderApproval(approval, state, host, client))
            : empty("All caught up — there are no actions waiting for human approval.")
        }
      </div>
    </section>
  `;
}

function renderActivityAudit(host: AgencyOperationsHost, state: AgencyOperationsState) {
  const entityLabel = (entityType: string, entityId: string) => {
    const type = entityType.toLowerCase();
    if (type.includes("task")) return state.tasks.find((item) => item.id === entityId)?.title;
    if (type.includes("project")) return state.projects.find((item) => item.id === entityId)?.name;
    if (type.includes("client")) return state.clients.find((item) => item.id === entityId)?.name;
    if (type.includes("worker") || type.includes("employee")) {
      return state.employees.find((item) => item.id === entityId)?.name;
    }
    if (type.includes("invoice")) return state.invoices.find((item) => item.id === entityId)?.number;
    if (type.startsWith("agency")) {
      return state.agencies.find((item) => item.id === entityId)?.name ?? "Agency settings";
    }
    return undefined;
  };
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head">
        <div>
          <span class="aops-eyebrow">Accountability</span>
          <h2>Activity & audit</h2>
          <p>A durable timeline of employee actions, approvals and operating changes.</p>
        </div>
      </header>
      <div class="aops-audit-list">
        ${
          state.auditEvents.length
            ? state.auditEvents.map((event) => {
                const label = entityLabel(event.entityType, event.entityId);
                return html`
                <article>
                  <div class="aops-audit-mark"></div>
                  <div>
                    <div class="aops-row"><strong>${event.action.replaceAll(".", " ")}</strong>
                      <time>${relativeTime(event.createdAt)}</time></div>
                    ${
                      label
                        ? html`<button
                            class="aops-link"
                            aria-label=${`Open ${event.entityType} ${label}`}
                            @click=${() =>
                              focusAgencyAuditEntity(host, event.entityType, event.entityId)}
                          >${event.entityType} · ${label}</button>`
                        : html`<span>${event.entityType} · ${event.entityId}</span>`
                    }
                    <small>Actor ${event.actorId ?? "system"} · immutable event ${event.id}</small>
                  </div>
                </article>
              `;
              })
            : empty("No audit events have been recorded for this agency yet.")
        }
      </div>
    </section>
  `;
}

function renderAgencyReliability(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const health = state.databaseHealth;
  const selectedAgency = state.agencies.find((agency) => agency.id === state.selectedAgencyId);
  const canAdmin = selectedAgency?.role === "owner" || selectedAgency?.role === "admin";
  const plan = state.pendingRestore;
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head">
        <div>
          <span class="aops-eyebrow">Data resilience</span>
          <h2>Database health, backups and recovery</h2>
          <p>Verified recovery points, schema compatibility and an explicit two-phase restore workflow.</p>
        </div>
        ${canAdmin
          ? html`<div class="aops-actions">
              <button
                class="aops-btn ghost"
                aria-label="Read the detailed database schema and migration status"
                ?disabled=${state.secondaryBusyId !== null}
                @click=${() => void loadAgencyDatabaseSchemaStatus(host, client)}
              >${state.secondaryBusyId === "schema-status" ? "Checking…" : "Schema status"}</button>
              <button
                class="aops-btn ghost"
                aria-label="Create a new database backup now"
                ?disabled=${state.secondaryBusyId !== null}
                @click=${() => void createAgencyDatabaseBackup(host, client)}
              >${state.secondaryBusyId === "backup-create" ? "Backing up…" : "Back up now"}</button>
              <button
                class="aops-btn primary"
                ?disabled=${state.secondaryBusyId !== null}
                @click=${() => void ensureAgencyDatabaseBackup(host, client)}
              >${state.secondaryBusyId === "backup-ensure" ? "Checking…" : "Ensure current backup"}</button>
            </div>`
          : nothing}
      </header>
      ${canAdmin
        ? html`
          <div class="aops-summary-strip">
            <div><strong>${health?.integrity ?? "unavailable"}</strong><span>Integrity</span></div>
            <div><strong>${health?.schema.currentVersion ?? "—"}/${health?.schema.supportedVersion ?? "—"}</strong><span>Schema version</span></div>
            <div><strong>${health?.backupCount ?? 0}</strong><span>Recovery points</span></div>
            <div><strong>${health?.latestVerified ? "Verified" : "Needs backup"}</strong><span>Latest backup</span></div>
          </div>
          ${health && !health.ok
            ? html`<div class="aops-inline-notice warning">
                Reliability needs attention: integrity ${health.integrity}; schema
                ${health.schema.upToDate ? "current" : "not current"}; latest backup
                ${health.latestVerified ? "verified" : "unverified or missing"}.
              </div>`
            : html`<div class="aops-inline-notice good">Database integrity, schema and latest recovery point are healthy.</div>`}
          ${state.schemaStatus
            ? html`<div class=${state.schemaStatus.upToDate ? "aops-inline-notice good" : "aops-inline-notice warning"}>
                Schema v${state.schemaStatus.currentVersion} of v${state.schemaStatus.supportedVersion} ·
                ${state.schemaStatus.migrationCount} migration${state.schemaStatus.migrationCount === 1 ? "" : "s"} applied ·
                last migrated
                ${state.schemaStatus.lastMigratedAt ? relativeTime(state.schemaStatus.lastMigratedAt) : "never"}${
                  state.schemaStatus.newerThanRuntime
                    ? " · this database was written by a newer build than the running gateway"
                    : ""
                }.
              </div>`
            : nothing}
          <div class="aops-assignment-head">
            <div><span class="aops-eyebrow">Verified recovery points</span><h3>Backups</h3></div>
            <span>Local encrypted-volume storage recommended</span>
          </div>
          <div class="aops-assignment-list">
            ${state.databaseBackups.length
              ? state.databaseBackups.map(
                  (backup) => html`
                    <article>
                      <div>
                        <div class="aops-row">
                          <strong>${shortDate(backup.createdAt)} · ${fileSize(backup.sizeBytes)}</strong>
                          <span class=${backup.verified ? "aops-health good" : "aops-health"}>
                            ${backup.verified ? "verified" : "unverified"}
                          </span>
                        </div>
                        <small>Schema ${backup.schemaVersion} · SHA-256 ${backup.sha256.slice(0, 12)}… · ${relativeTime(backup.createdAt)}</small>
                      </div>
                      <div class="aops-row">
                        <button
                          class="aops-btn ghost"
                          ?disabled=${state.secondaryBusyId !== null}
                          @click=${() => void verifyAgencyDatabaseBackup(host, client, backup.id)}
                        >${state.secondaryBusyId === backup.id ? "Verifying…" : "Verify"}</button>
                        <button
                          class="aops-btn ghost"
                          ?disabled=${!backup.verified || state.secondaryBusyId !== null}
                          @click=${() => void prepareAgencyDatabaseRestore(host, client, backup.id)}
                        >Prepare restore</button>
                      </div>
                    </article>
                  `,
                )
              : empty("No recovery points yet. Create the first verified backup before making major changes.")}
          </div>
          <article class="aops-settings-card" style="margin-top:16px">
            <div class="aops-row">
              <div>
                <h3>Retention</h3>
                <small>Prune older recovery points. The newest backup is always kept, whatever the policy says.</small>
              </div>
            </div>
            <div class="aops-retention-row">
              <label class="aops-field compact">
                <span>Keep newest</span>
                <input
                  type="number"
                  min="1"
                  max="365"
                  aria-label="Maximum number of backups to keep"
                  .value=${state.backupRetentionCount}
                  @input=${(event: Event) =>
                    setAgencyBackupRetention(host, {
                      maxCount: (event.target as HTMLInputElement).value,
                    })}
                />
              </label>
              <label class="aops-field compact">
                <span>Max age (days)</span>
                <input
                  type="number"
                  min="1"
                  max="3650"
                  aria-label="Maximum age in days before a backup is pruned"
                  .value=${state.backupRetentionDays}
                  @input=${(event: Event) =>
                    setAgencyBackupRetention(host, {
                      maxAgeDays: (event.target as HTMLInputElement).value,
                    })}
                />
              </label>
              <button
                class="aops-btn ghost"
                aria-label="Apply the backup retention policy now"
                ?disabled=${state.secondaryBusyId !== null}
                @click=${() => void pruneAgencyDatabaseBackups(host, client)}
              >${state.secondaryBusyId === "backup-prune" ? "Pruning…" : "Apply retention"}</button>
            </div>
            ${state.backupPruneResult
              ? html`<div class="aops-inline-notice good">
                  Removed ${state.backupPruneResult.removedIds.length} recovery point${state.backupPruneResult.removedIds.length === 1 ? "" : "s"};
                  ${state.backupPruneResult.retained} retained.
                </div>`
              : nothing}
          </article>
          ${plan
            ? html`
                <article
                  class="aops-settings-card"
                  style=${`margin-top:16px;border-color:var(--g-danger-border, color-mix(in srgb, ${TONE.danger} 40%, transparent))`}
                >
                  <div class="aops-row">
                    <div>
                      <h3>Restore staged</h3>
                      <small>Expires ${relativeTime(plan.expiresAt)}. A pre-restore safety backup and rollback fallback are automatic.</small>
                    </div>
                    <span class="aops-health">Destructive</span>
                  </div>
                  <label class="aops-field">
                    <span>Type the exact confirmation: <code>${plan.confirmation}</code></span>
                    <input
                      .value=${state.restoreConfirmation}
                      autocomplete="off"
                      @input=${(event: Event) =>
                        setAgencyRestoreConfirmation(
                          host,
                          (event.target as HTMLInputElement).value,
                        )}
                    />
                  </label>
                  <div class="aops-row">
                    <button class="aops-btn ghost" @click=${() => void cancelAgencyDatabaseRestore(host, client)}>Cancel staged restore</button>
                    <button
                      class="aops-btn primary"
                      ?disabled=${state.restoreConfirmation !== plan.confirmation || state.secondaryBusyId !== null}
                      @click=${() => void activateAgencyDatabaseRestore(host, client)}
                    >Activate verified restore</button>
                  </div>
                </article>
              `
            : nothing}
        `
        : empty("Database resilience controls require an owner or admin role.")}
    </section>
  `;
}

/**
 * Dry run and forced re-import for the legacy business importer. `.migration.run`
 * always passes `force: true` server-side — it re-imports every legacy business,
 * client, project and task rather than only what changed — so the destructive
 * consequence is stated and gated behind a typed confirmation, matching the
 * restore flow.
 */
function renderMigrationControls(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult {
  const agency = state.agencies.find((item) => item.id === state.selectedAgencyId);
  const preview = state.migrationPreview;
  const confirmed = state.migrationConfirmation === AGENCY_MIGRATION_CONFIRMATION;
  return html`
    <div class="aops-migration-controls">
      <button
        class="aops-btn ghost"
        aria-label="Preview what a legacy re-import would touch, without writing anything"
        ?disabled=${state.secondaryBusyId !== null}
        @click=${() => void previewAgencyMigration(host, client)}
      >${state.secondaryBusyId === "migration-preview" ? "Previewing…" : "Preview re-import"}</button>
      ${
        preview
          ? html`
            <div class="aops-migration-stats">
              <div><strong>${preview.businessesFound}</strong><span>Businesses</span></div>
              <div><strong>${preview.clientsImported}</strong><span>Clients</span></div>
              <div><strong>${preview.projectsImported}</strong><span>Projects</span></div>
              <div><strong>${preview.tasksImported}</strong><span>Tasks</span></div>
              <div><strong>${preview.projectsQuarantined + preview.databaseRowsQuarantined}</strong><span>Quarantined</span></div>
            </div>
            <small>Dry run only — nothing has been written.</small>
          `
          : nothing
      }
      ${
        agency?.role === "owner"
          ? html`
            <div class="aops-inline-notice warning">
              <strong>Running the import forces a full re-import.</strong>
              Every legacy business, client, project and task is read and rewritten, not just
              what changed. On a dataset this size that takes minutes and rewrites existing
              agency rows. Take a backup from the Reliability section first.
            </div>
            <label class="aops-field">
              <span>Type <code>${AGENCY_MIGRATION_CONFIRMATION}</code> to enable the forced re-import</span>
              <input
                autocomplete="off"
                aria-label=${`Type ${AGENCY_MIGRATION_CONFIRMATION} to confirm the forced legacy re-import`}
                .value=${state.migrationConfirmation}
                @input=${(event: Event) =>
                  setAgencyMigrationConfirmation(host, (event.target as HTMLInputElement).value)}
              />
            </label>
            <button
              class="aops-btn primary"
              aria-label="Run the forced legacy re-import"
              ?disabled=${!confirmed || state.secondaryBusyId !== null}
              @click=${() => void runAgencyMigration(host, client)}
            >${state.secondaryBusyId === "migration-run" ? "Re-importing…" : "Run forced re-import"}</button>
          `
          : html`<small>Only the agency owner can run the legacy import.</small>`
      }
    </div>
  `;
}

function renderAgencySettings(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const agency = state.agencies.find((item) => item.id === state.selectedAgencyId);
  const migration = state.migrationReport;
  return html`
    <section class="aops-surface">
      <header class="aops-surface-head"><div><span class="aops-eyebrow">Administration</span>
        <h2>Agency settings</h2><p>Ownership, members, collaboration and migration readiness.</p></div></header>
      <div class="aops-settings-grid">
        <article class="aops-settings-card">
          <h3>Agency profile</h3>
          <dl>
            <div><dt>Name</dt><dd>${agency?.name ?? "No agency selected"}</dd></div>
            <div><dt>Your role</dt><dd>${agency?.role ?? "—"}</dd></div>
            <div><dt>Owner</dt><dd>${agency?.ownerName ?? (agency?.role === "owner" ? "You" : "Not available")}</dd></div>
            <div><dt>Agency ID</dt><dd><code>${agency?.id ?? "—"}</code></dd></div>
          </dl>
        </article>
        <article class="aops-settings-card">
          <div class="aops-row"><h3>Members & access</h3>
            ${
              agency && (agency.role === "owner" || agency.role === "admin")
                ? html`<button class="aops-btn primary" @click=${() => openAgencyOpsDialog(host, "share")}>Invite member</button>`
                : nothing
            }
          </div>
          <div class="aops-member-count"><strong>${state.members.length}</strong><span>Members</span></div>
          <div class="aops-member-list">
            ${
              state.members.length
                ? state.members.map(
                    (member) => html`
                    <div>
                      <span><strong>${member.userId}</strong><small>Joined ${shortDate(member.createdAt)}</small></span>
                      ${
                        member.role === "owner"
                          ? html`
                              <span class="aops-role">owner</span>
                            `
                          : agency && (agency.role === "owner" || agency.role === "admin")
                            ? html`
                              <select .value=${member.role} ?disabled=${state.secondaryBusyId === member.userId}
                                @change=${(event: Event) =>
                                  void updateAgencyMemberRole(
                                    host,
                                    client,
                                    member.userId,
                                    (event.target as HTMLSelectElement).value as
                                      | "admin"
                                      | "member"
                                      | "viewer",
                                  )}>
                                <option value="admin">Admin</option>
                                <option value="member">Member</option>
                                <option value="viewer">Viewer</option>
                              </select>
                              <button class="aops-link danger" ?disabled=${state.secondaryBusyId === member.userId}
                                @click=${() => void removeAgencyMember(host, client, member.userId)}>Remove</button>
                            `
                            : html`<span class="aops-role">${member.role}</span>`
                      }
                    </div>
                  `,
                  )
                : empty("No agency members were returned.")
            }
          </div>
        </article>
        <article class="aops-settings-card aops-migration-card">
          <div class="aops-row"><h3>Legacy migration</h3>
            <span class=${migration?.completedAt ? "aops-health good" : "aops-health"}>
              ${migration?.completedAt ? "Completed" : migration?.sourceExists ? "Ready" : "No source detected"}
            </span>
          </div>
          ${
            migration
              ? html`
                <div class="aops-migration-stats">
                  <div><strong>${migration.businessesFound}</strong><span>Businesses</span></div>
                  <div><strong>${migration.clientsImported}</strong><span>Clients</span></div>
                  <div><strong>${migration.projectsImported}</strong><span>Projects</span></div>
                  <div><strong>${migration.tasksImported}</strong><span>Tasks</span></div>
                  <div><strong>${migration.projectsQuarantined + migration.databaseRowsQuarantined}</strong><span>Quarantined</span></div>
                </div>
                ${
                  migration.warnings.length
                    ? html`<div class="aops-inline-notice warning">${migration.warnings.join(" ")}</div>`
                    : html`
                        <div class="aops-inline-notice good">No migration warnings reported.</div>
                      `
                }
              `
              : empty(
                  "Migration status will appear after the agency list reports a migration preview.",
                )
          }
          ${renderMigrationControls(host, state, client)}
        </article>
      </div>
    </section>
  `;
}

function renderDedicatedSurface(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult {
  const selectedAgency = state.agencies.find((agency) => agency.id === state.selectedAgencyId);
  // A selected client profile takes over the whole surface (full-page detail
  // view), matching how the app renders focused detail surfaces.
  // A selected project takes over the whole surface as a dedicated in-depth
  // page (overview / tasks / notes / activity) with its own Back control,
  // mirroring the client-profile full-page pattern.
  const detailProject = state.detailProjectId
    ? state.projects.find((p) => p.id === state.detailProjectId)
    : undefined;
  if (state.detailProjectId && detailProject) {
    return html`
      ${styles}
      ${invoicingStyles}
      <main class="aops ba-glass">
        ${baAurora()}
        ${state.error ? html`<div class="aops-alert">${state.error}</div>` : nothing}
        ${renderProjectDetailPage(host, client)}
        ${renderDialog(host, state, client)}
      </main>
    `;
  }
  const profileClient = state.clientProfileId
    ? state.clients.find((c) => c.id === state.clientProfileId)
    : undefined;
  if (state.clientProfileId && profileClient) {
    return html`
      ${styles}
      ${invoicingStyles}
      <main class="aops ba-glass">
        ${baAurora()}
        ${state.error ? html`<div class="aops-alert">${state.error}</div>` : nothing}
        ${renderClientProfile(host, state, client, profileClient)}
        ${renderDialog(host, state, client)}
        ${renderInvoiceComposer(host, state, client)}
        ${renderClientRevenuePanel(host, state, client)}
      </main>
    `;
  }
  return html`
    ${styles}
    ${invoicingStyles}
    <main class="aops ba-glass">
      ${baAurora()}
      <header class="aops-head">
        <div><h1>Agency Operating System</h1><div class="aops-sub">${selectedAgency?.name ?? "Select an agency"}</div></div>
        <div class="aops-tools">
          <select class="aops-agency-select" .value=${state.selectedAgencyId ?? ""}
            @change=${(event: Event) =>
              void switchAgencyOperationsAgency(
                host,
                client,
                (event.target as HTMLSelectElement).value,
              )}>
            ${state.agencies.map((agency) => html`<option value=${agency.id}>${agency.name}</option>`)}
          </select>
          <button class="aops-btn primary" ?disabled=${state.refreshing}
            @click=${() => void loadAgencyOperations(host, client, { background: true })}>
            ${state.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      ${renderReplicationHealth(host, state, client)}
      ${renderSectionNavigation(host, state)}
      ${state.error ? html`<div class="aops-alert">${state.error}</div>` : nothing}
      ${renderFailedRequests(state)}
      ${
        state.activeSection === "employees"
          ? renderEmployeeDirectory(host, state, client)
          : state.activeSection === "delivery"
            ? renderDeliveryOperations(host, state, client)
          : state.activeSection === "finance"
            ? renderFinanceOperations(host, state, client)
          : state.activeSection === "employee-ops"
            ? renderEmployeeOperatingLoop(host, state, client)
            : state.activeSection === "allocation"
              ? renderWorkAllocation(host, state, client)
              : state.activeSection === "approvals"
                ? renderApprovalInbox(host, state, client)
                : state.activeSection === "activity"
                  ? renderActivityAudit(host, state)
                  : state.activeSection === "reliability"
                    ? renderAgencyReliability(host, state, client)
                    : renderAgencySettings(host, state, client)
      }
      ${renderDialog(host, state, client)}
      ${renderInvoiceComposer(host, state, client)}
      ${renderClientRevenuePanel(host, state, client)}
    </main>
  `;
}

function renderReplicationHealth(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult {
  const sync = state.replicationStatus;
  if (!state.selectedAgencyId) return html``;
  const tone =
    sync?.state === "in_sync"
      ? TONE.success
      : sync?.state === "offline"
        ? TONE.warning
        : sync?.state === "error"
          ? TONE.danger
          : TONE.info;
  const title =
    sync?.state === "in_sync"
      ? "Shared agency data is in sync"
      : sync?.state === "offline"
        ? "Offline mode — local work is safely retained"
        : sync?.state === "error"
          ? "Shared data sync needs attention"
          : sync?.state === "pending"
            ? "Local changes are waiting to sync"
            : "Shared data sync is ready";
  const detail =
    sync?.lastError ??
    (sync?.lastSyncAt
      ? `Last reconciled ${shortDate(sync.lastSyncAt)}${sync.conflicts ? ` · ${sync.conflicts} conflict(s) logged` : ""}`
      : "This node stores agency data locally and reconciles it with the master after reconnect.");
  const role = state.agencies.find((agency) => agency.id === state.selectedAgencyId)?.role;
  const canAdmin = role === "owner" || role === "admin";
  const canWrite = canAdmin || role === "member";
  const conflictCount = sync?.conflicts ?? 0;
  return html`
    <section
      class="aops-card"
      style=${`margin:0 0 16px;border-color:color-mix(in srgb, ${tone} 34%, transparent);background:linear-gradient(160deg, color-mix(in srgb, ${tone} 10%, transparent), color-mix(in srgb, ${tone} 3%, transparent))`}
    >
      <div class="aops-row aops-sync-row" style="align-items:center;gap:12px">
        <span style=${`flex:none;width:10px;height:10px;border-radius:999px;background:${tone};box-shadow:0 0 16px ${tone}`}></span>
        <div class="aops-sync-copy" style="flex:1">
          <strong>${title}</strong>
          <small style="display:block;margin-top:4px">${detail}</small>
        </div>
        <div class="aops-sync-actions">
          ${
            canAdmin && conflictCount > 0
              ? html`<button
                  class="aops-btn ghost"
                  aria-expanded=${state.replicationConflictsOpen ? "true" : "false"}
                  aria-label=${`${state.replicationConflictsOpen ? "Hide" : "Review"} ${conflictCount} replication conflict${conflictCount === 1 ? "" : "s"}`}
                  @click=${() => void toggleAgencyReplicationConflicts(host, client)}
                >${state.replicationConflictsOpen ? "Hide conflicts" : `Review ${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`}</button>`
              : nothing
          }
          ${
            canWrite
              ? html`
                <button
                  class="aops-btn ghost"
                  aria-label="Export this agency's replication snapshot as a file"
                  ?disabled=${state.secondaryBusyId !== null}
                  @click=${() => void exportAgencyReplicationSnapshot(host, client)}
                >${state.secondaryBusyId === "replication-export" ? "Exporting…" : "Export snapshot"}</button>
                <label class="aops-btn ghost aops-file-btn">
                  <span>${state.secondaryBusyId === "replication-merge" ? "Merging…" : "Merge snapshot"}</span>
                  <input
                    type="file"
                    accept="application/json,.json"
                    aria-label="Merge a replication snapshot exported from another node"
                    ?disabled=${state.secondaryBusyId !== null}
                    @change=${(event: Event) => {
                      const input = event.target as HTMLInputElement;
                      const file = input.files?.[0];
                      if (file) void importAgencyReplicationSnapshot(host, client, file);
                      input.value = "";
                    }}
                  />
                </label>
              `
              : nothing
          }
          <button
            class="aops-btn ghost"
            ?disabled=${state.clientSyncing}
            @click=${() => void syncAgencyClients(host, client)}
          >${state.clientSyncing ? "Syncing…" : "Sync now"}</button>
        </div>
      </div>
      ${
        state.replicationSnapshotNotice
          ? html`<div class="aops-inline-notice good">${state.replicationSnapshotNotice}</div>`
          : nothing
      }
      ${
        state.replicationConflictsOpen
          ? html`
            <div class="aops-conflict-list">
              ${
                state.replicationConflictsLoading
                  ? html`<div class="aops-inline-notice">Loading conflicts…</div>`
                  : state.replicationConflicts.length
                    ? state.replicationConflicts.map(
                        (conflict) => html`
                          <article class="aops-conflict">
                            <div class="aops-row">
                              <strong>${conflict.table_name}</strong>
                              <span class=${conflict.resolved_at ? "aops-health good" : "aops-health"}>
                                ${conflict.resolved_at ? "resolved" : `kept ${conflict.winner}`}
                              </span>
                            </div>
                            <small>
                              ${conflict.row_key} · from ${conflict.source_node_id} ·
                              ${relativeTime(conflict.created_at)} ·
                              local v${conflict.local_version ?? "—"} vs remote v${conflict.remote_version ?? "—"}
                            </small>
                            <details>
                              <summary>Compare the two versions</summary>
                              <div class="aops-conflict-diff">
                                <div><span>Local</span><code>${conflict.local_json}</code></div>
                                <div><span>Remote</span><code>${conflict.remote_json}</code></div>
                              </div>
                            </details>
                          </article>
                        `,
                      )
                    : empty("No replication conflicts are recorded for this agency.")
              }
            </div>
          `
          : nothing
      }
    </section>
  `;
}

function field(
  label: string,
  value: string,
  onInput: (value: string) => void,
  options: { type?: string; placeholder?: string } = {},
) {
  return html`
    <label class="aops-field">
      <span>${label}</span>
      <input
        type=${options.type ?? "text"}
        placeholder=${options.placeholder ?? ""}
        .value=${value}
        @input=${(event: Event) => onInput((event.target as HTMLInputElement).value)}
      />
    </label>
  `;
}

function selectField(
  label: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void,
) {
  // `.value` alone is unreliable here: lit commits the property before the
  // <option> children exist, so the select silently falls back to the first
  // option and the form shows a value nobody chose. Marking the option itself
  // is what actually survives the initial render.
  return html`
    <label class="aops-field">
      <span>${label}</span>
      <select
        aria-label=${label}
        .value=${value}
        @change=${(event: Event) => onChange((event.target as HTMLSelectElement).value)}
      >
        ${options.map(
          ([id, text]) => html`<option value=${id} ?selected=${id === value}>${text}</option>`,
        )}
      </select>
    </label>
  `;
}

function textareaField(
  label: string,
  value: string,
  onInput: (value: string) => void,
  placeholder = "",
) {
  return html`
    <label class="aops-field">
      <span>${label}</span>
      <textarea
        rows="3"
        aria-label=${label}
        placeholder=${placeholder}
        .value=${value}
        @input=${(event: Event) => onInput((event.target as HTMLTextAreaElement).value)}
      ></textarea>
    </label>
  `;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const EXTENDED_DIALOG_TITLES: Record<ExtendedAgencyOpsDialogKind, string> = {
  "employee-schedule": "Add working schedule",
  "employee-responsibility": "Add recurring responsibility",
  "employee-review": "Schedule manager review",
  "employee-work-item": "Hand work to an employee",
  "employee-edit": "Edit employee",
  "client-edit": "Edit client",
  "project-edit": "Edit project",
  "task-edit": "Edit task",
  "employee-memory": "Employee memory entry",
  "employee-profile": "Customise employee",
  "employee-channel": "Channel binding",
  "employee-sop-attach": "Attach an SOP schedule",
};

const PROFILE_TABS = [
  ["identity", "Identity & role"],
  ["operating", "Operating & autonomy"],
  ["communication", "Communication"],
  ["channels", "Model & limits"],
] as const;

/** A labelled boolean rendered as a select, matching the string-patch dialog. */
function booleanField(
  label: string,
  value: string,
  onChange: (value: string) => void,
  trueLabel = "Yes",
  falseLabel = "No",
) {
  return selectField(
    label,
    value,
    [
      ["true", trueLabel],
      ["false", falseLabel],
    ],
    onChange,
  );
}

const titleCase = (value: string) =>
  value.length ? value[0].toUpperCase() + value.slice(1).replace(/_/g, " ") : value;

const optionsFrom = (values: readonly string[]): Array<[string, string]> =>
  values.map((value) => [value, titleCase(value)]);

// ── Premium client editor ───────────────────────────────────────────────
// The social contact rows for the client edit modal. Mirrors the icon set and
// ordering used by the dedicated Clients page so the two editors feel identical.
type ClientEditKey = "email" | "phone" | "whatsapp" | "telegram" | "discord" | "instagram";
const CLIENT_SOCIAL_FIELDS: Array<{
  key: ClientEditKey;
  label: string;
  placeholder: string;
  icon: TemplateResult;
}> = [
  {
    key: "whatsapp",
    label: "WhatsApp",
    placeholder: "+1 555 000 0000",
    icon: html`<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="12" fill="#25D366" /><path fill="#fff" d="M12 4.8A7.2 7.2 0 0 0 5.6 15.4l-.9 3.2 3.3-.9A7.2 7.2 0 1 0 12 4.8zm0 13.1a5.9 5.9 0 0 1-3-.83l-.22-.13-2.25.59.6-2.2-.14-.22A5.9 5.9 0 1 1 12 17.9zm3.24-4.37c-.18-.09-1.06-.52-1.22-.58s-.28-.09-.4.09-.46.58-.56.7-.21.13-.39.04a4.9 4.9 0 0 1-1.44-.89 5.4 5.4 0 0 1-1-1.24c-.1-.18 0-.27.08-.36s.18-.21.27-.31a1.2 1.2 0 0 0 .18-.3.33.33 0 0 0-.01-.31c-.04-.09-.4-.96-.55-1.31s-.29-.3-.4-.3h-.34a.65.65 0 0 0-.47.22 2 2 0 0 0-.62 1.48 3.47 3.47 0 0 0 .73 1.84 7.94 7.94 0 0 0 3.04 2.69c.43.18.76.29 1.02.37a2.46 2.46 0 0 0 1.13.07 1.84 1.84 0 0 0 1.21-.85 1.49 1.49 0 0 0 .1-.85c-.04-.07-.16-.12-.34-.21z" /></svg>`,
  },
  {
    key: "telegram",
    label: "Telegram",
    placeholder: "@username",
    icon: html`<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="12" fill="#229ED9" /><path fill="#fff" d="M5.49 11.74 17.1 7.18c.55-.2 1.03.13.85.95l-1.96 9.23c-.14.64-.53.8-1.07.5l-2.96-2.18-1.43 1.37c-.16.16-.29.29-.59.29l.21-3 5.43-4.9c.24-.21-.05-.33-.36-.12L8.02 14.35 5.1 13.44c-.64-.2-.65-.64.39-1.07z" /></svg>`,
  },
  {
    key: "discord",
    label: "Discord",
    placeholder: "user#1234",
    icon: html`<svg viewBox="0 0 24 24" width="16" height="16"><rect width="24" height="24" rx="5" fill="#5865F2" /><path fill="#fff" d="M19.27 5.33A17.1 17.1 0 0 0 15.07 4a11.9 11.9 0 0 0-.52 1.07 15.75 15.75 0 0 0-4.73 0A11.67 11.67 0 0 0 9.3 4 17.14 17.14 0 0 0 5.1 5.33 18.08 18.08 0 0 0 2 17.3a17.32 17.32 0 0 0 5.27 2.68 12.77 12.77 0 0 0 1.1-1.81 11.2 11.2 0 0 1-1.74-.84l.44-.32a12.33 12.33 0 0 0 10.86 0l.44.32a11.11 11.11 0 0 1-1.74.84A12.5 12.5 0 0 0 17.73 20 17.26 17.26 0 0 0 22 17.3 18.08 18.08 0 0 0 19.27 5.33zm-9.35 8.58c-1 0-1.83-.93-1.83-2.07s.8-2.08 1.83-2.08 1.85.93 1.83 2.08-.81 2.07-1.83 2.07zm6.76 0c-1 0-1.83-.93-1.83-2.07s.8-2.08 1.83-2.08 1.85.93 1.83 2.08-.8 2.07-1.83 2.07z" /></svg>`,
  },
  {
    key: "instagram",
    label: "Instagram",
    placeholder: "@handle",
    icon: html`<svg viewBox="0 0 24 24" width="16" height="16"><defs><linearGradient id="aoc-ig-grad" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#f09433" /><stop offset="25%" stop-color="#e6683c" /><stop offset="50%" stop-color="#dc2743" /><stop offset="75%" stop-color="#cc2366" /><stop offset="100%" stop-color="#bc1888" /></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#aoc-ig-grad)" /><rect x="7" y="7" width="10" height="10" rx="3" fill="none" stroke="#fff" stroke-width="1.5" /><circle cx="12" cy="12" r="2.5" fill="none" stroke="#fff" stroke-width="1.5" /><circle cx="16.5" cy="7.5" r="0.8" fill="#fff" /></svg>`,
  },
];

/**
 * Formal, full-field client editor for the finance section — a visual and
 * functional match to the dedicated Clients page. Every field persists through
 * `agency.ops.clients.update`; nothing here is local-only.
 */
function renderClientEditModal(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  draft: Extract<NonNullable<AgencyOpsDialog>, { kind: "client-edit" }>,
): TemplateResult {
  const setField = (key: string, value: string) => patchAgencyOpsDialog(host, { [key]: value });
  const valid = draft.name.trim().length > 0;
  const record = state.clients.find((item) => item.id === draft.clientId);
  const name = draft.name.trim() || record?.name || "Client";
  const initials = name.slice(0, 2).toUpperCase();
  const statusLabel = record?.pipelineStatusLabel ?? titleCase(draft.status);

  const textField = (
    key: ClientEditKey | "name" | "billingEmail",
    label: string,
    opts: { type?: string; placeholder?: string; required?: boolean; wide?: boolean } = {},
  ) => html`
    <div class="aoc-field ${opts.wide ? "aoc-field-wide" : ""}">
      <label class="aoc-label">${label} ${opts.required ? html`<span class="req">*</span>` : nothing}</label>
      <input
        class="aoc-input"
        type=${opts.type ?? "text"}
        placeholder=${opts.placeholder ?? label}
        .value=${(draft as unknown as Record<string, string>)[key] ?? ""}
        @input=${(event: Event) => setField(key, (event.target as HTMLInputElement).value)}
      />
    </div>
  `;

  return html`
    <div class="aoc-overlay" @click=${(event: Event) => event.target === event.currentTarget && closeAgencyOpsDialog(host)}>
      <form
        class="aoc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit client"
        @submit=${(event: Event) => {
          event.preventDefault();
          if (valid) void submitAgencyOpsDialog(host, client);
        }}
      >
        <button type="button" class="aoc-close" aria-label="Close" @click=${() => closeAgencyOpsDialog(host)}>×</button>
        <header class="aoc-head">
          <div class="aoc-head-avatar">${initials}</div>
          <div class="aoc-head-ident">
            <span class="aoc-eyebrow">Edit client</span>
            <h2 class="aoc-title">${name}</h2>
            <p class="aoc-sub">Update the full record — identity, billing, pipeline and every contact channel. Changes save to the agency ledger when you click Save.</p>
          </div>
          <span class=${`aops-chip ${draft.status}`}>${statusLabel}</span>
        </header>

        <div class="aoc-body">
          <section class="aoc-section">
            <div class="aoc-section-head"><span>Identity</span></div>
            <div class="aoc-grid">
              ${textField("name", "Name", { required: true, wide: true, placeholder: "Acme Corp" })}
            </div>
          </section>

          <section class="aoc-section">
            <div class="aoc-section-head"><span>Status &amp; pipeline</span></div>
            <div class="aoc-grid">
              <div class="aoc-field">
                <label class="aoc-label">Status</label>
                <select
                  class="aoc-select"
                  .value=${draft.status}
                  @change=${(event: Event) => setField("status", (event.target as HTMLSelectElement).value)}
                >
                  ${(
                    [
                      ["prospect", "Prospect"],
                      ["active", "Active"],
                      ["inactive", "Inactive"],
                    ] as Array<[string, string]>
                  ).map(
                    ([value, label]) =>
                      html`<option value=${value} ?selected=${draft.status === value}>${label}</option>`,
                  )}
                </select>
              </div>
              ${
                record?.pipelineStatusLabel
                  ? html`<div class="aoc-field">
                      <label class="aoc-label">Pipeline stage</label>
                      <div class="aoc-static">${record.pipelineStatusLabel}</div>
                    </div>`
                  : nothing
              }
            </div>
          </section>

          <section class="aoc-section">
            <div class="aoc-section-head"><span>Billing &amp; contact</span></div>
            <div class="aoc-grid">
              ${textField("billingEmail", "Billing email", { type: "email", placeholder: "billing@acme.com" })}
              ${textField("email", "Primary email", { type: "email", placeholder: "hello@acme.com" })}
              ${textField("phone", "Phone", { type: "tel", placeholder: "+1 (555) 234-5678" })}
            </div>
          </section>

          <section class="aoc-section">
            <div class="aoc-social-divider">
              <span class="aoc-social-divider-line"></span>
              <span class="aoc-social-divider-label">Contact &amp; Socials</span>
              <span class="aoc-social-divider-line"></span>
            </div>
            <div class="aoc-socials-grid">
              ${CLIENT_SOCIAL_FIELDS.map(
                (field) => html`
                  <div class="aoc-social-field">
                    <label class="aoc-social-label">${field.icon} ${field.label}</label>
                    <input
                      class="aoc-social-input"
                      type="text"
                      placeholder=${field.placeholder}
                      .value=${(draft as unknown as Record<string, string>)[field.key] ?? ""}
                      @input=${(event: Event) => setField(field.key, (event.target as HTMLInputElement).value)}
                    />
                  </div>
                `,
              )}
            </div>
          </section>

          <section class="aoc-section">
            <div class="aoc-section-head"><span>Notes &amp; context</span></div>
            <div class="aoc-grid">
              <div class="aoc-field aoc-field-wide">
                <label class="aoc-label">Notes</label>
                <textarea
                  class="aoc-textarea"
                  placeholder="Anything you'd want to remember — history, context, follow-ups…"
                  .value=${draft.notes}
                  @input=${(event: Event) => setField("notes", (event.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>
            </div>
          </section>
        </div>

        <footer class="aoc-foot">
          <span class="aoc-foot-status">
            ${state.saving ? "Saving…" : valid ? "Edits save to the agency ledger when you click Save" : "Add a name to enable Save"}
          </span>
          <div class="aoc-foot-actions">
            <button type="button" class="aoc-btn" @click=${() => closeAgencyOpsDialog(host)}>Cancel</button>
            <button class="aoc-btn primary" ?disabled=${!valid || state.saving}>
              ${state.saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  `;
}

/**
 * The create/edit forms for the mutation surface that previously had no UI.
 * Rendered separately from the original dialog chain so each form stays legible
 * and the existing union keeps narrowing cleanly.
 */
function renderExtendedDialog(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  draft: Extract<NonNullable<AgencyOpsDialog>, { kind: ExtendedAgencyOpsDialogKind }>,
): TemplateResult {
  const patch = (key: string) => (value: string) => patchAgencyOpsDialog(host, { [key]: value });
  // The client editor is a premium, formal, full-field modal that matches the
  // dedicated Clients page. Rendered on its own path so it can use the richer
  // sectioned layout instead of the generic aops-dialog chrome.
  if (draft.kind === "client-edit") {
    return renderClientEditModal(host, state, client, draft);
  }
  const workerOptions: Array<[string, string]> = state.employees.map((employee) => [
    employee.id,
    `${employee.name} · ${employee.kind === "ai" ? "AI" : "Human"} · ${employee.role}`,
  ]);
  const managerOptions: Array<[string, string]> = [
    ["", "No manager"],
    ...workerOptions,
  ];
  const priorityOptions: Array<[string, string]> = [
    ["low", "Low"],
    ["normal", "Normal"],
    ["high", "High"],
    ["urgent", "Urgent"],
  ];

  let valid = true;
  let body: TemplateResult;
  if (draft.kind === "employee-profile") {
    const employee = state.employees.find((item) => item.id === draft.employeeId);
    const detailLoaded = state.employeeDetail?.employee.id === draft.employeeId;
    const described = describeAutonomy(Number(draft.autonomyLevel));
    valid = draft.name.trim().length > 0 && draft.role.trim().length > 0;
    const tabbed = (
      tab: (typeof PROFILE_TABS)[number][0],
      content: TemplateResult,
    ): TemplateResult => (draft.tab === tab ? content : html``);
    body = html`
      <div class="aops-profile-head">
        <div class=${`aops-avatar${employee?.kind === "ai" ? " ai" : ""}`}>
          ${(employee?.name ?? draft.name).slice(0, 2).toUpperCase()}
        </div>
        <div>
          <strong>${employee?.name ?? draft.name}</strong>
          <small>${employee?.kind === "ai" ? "AI employee" : "Human employee"} · ${draft.role || "no role"}</small>
        </div>
      </div>
      ${
        detailLoaded
          ? nothing
          : state.secondaryLoading
            ? html`<div class="aops-inline-notice">
                Loading the stored profile — skills, capabilities and communication settings will
                fill in shortly.
              </div>`
            : html`<div class="aops-inline-notice warning">
                The stored profile could not be read for this employee, so skills, capabilities and
                communication settings below are defaults, not saved values. Saving now would write
                those defaults over whatever is on the record.
              </div>`
      }
      <div class="aops-dialog-tabs" role="tablist" aria-label="Employee settings sections">
        ${PROFILE_TABS.map(
          ([id, label]) => html`
            <button
              type="button"
              role="tab"
              aria-selected=${draft.tab === id ? "true" : "false"}
              class=${draft.tab === id ? "active" : ""}
              @click=${() => patch("tab")(id)}
            >${label}</button>
          `,
        )}
      </div>
      ${tabbed(
        "identity",
        html`
          <div class="aops-field-grid">
            ${field("Name", draft.name, patch("name"))}
            ${field("Role / title", draft.role, patch("role"))}
            ${field("Department", draft.department, patch("department"), {
              placeholder: "e.g. Growth. Created if it does not exist.",
            })}
            ${selectField("Reports to", draft.managerWorkerId, managerOptions, patch("managerWorkerId"))}
            ${field("Weekly capacity (h)", draft.capacityHours, patch("capacityHours"), { type: "number" })}
            ${field("Availability (%)", draft.availabilityPercent, patch("availabilityPercent"), { type: "number" })}
            ${selectField(
              "Current status",
              draft.availability,
              [
                ["available", "Available"],
                ["focused", "Focused"],
                ["blocked", "Blocked"],
                ["offline", "Offline"],
              ],
              patch("availability"),
            )}
            ${selectField(
              "Employment",
              draft.employmentStatus,
              [
                ["active", "Active"],
                ["onboarding", "Onboarding"],
                ["suspended", "Suspended"],
                ["inactive", "Inactive"],
              ],
              patch("employmentStatus"),
            )}
            ${field("Timezone", draft.timezone, patch("timezone"), { placeholder: "e.g. Europe/London" })}
          </div>
          ${textareaField(
            "Persona",
            draft.persona,
            patch("persona"),
            "Who this employee is: voice, remit, standing constraints.",
          )}
        `,
      )}
      ${tabbed(
        "operating",
        html`
          <label class="aops-field">
            <span>Autonomy level</span>
            <div class="aops-autonomy-picker" role="radiogroup" aria-label="Autonomy level">
              ${AUTONOMY_LEVELS.map(
                (entry) => html`
                  <button
                    type="button"
                    role="radio"
                    aria-checked=${Number(draft.autonomyLevel) === entry.level ? "true" : "false"}
                    class=${Number(draft.autonomyLevel) === entry.level
                      ? `aops-autonomy-option ${entry.tone} active`
                      : `aops-autonomy-option ${entry.tone}`}
                    @click=${() => patch("autonomyLevel")(String(entry.level))}
                  >
                    <b>L${entry.level} · ${entry.label}</b>
                    <i>${entry.short}</i>
                  </button>
                `,
              )}
            </div>
          </label>
          <p class="aops-dialog-help">
            ${described?.detail ?? "Pick a level to see what it means in practice."}
          </p>
          ${field(
            "Approval threshold",
            draft.approvalThreshold,
            patch("approvalThreshold"),
            { type: "number", placeholder: "Cost above which work always escalates" },
          )}
          ${textareaField("Goals", draft.goals, patch("goals"), "One goal per line")}
          ${textareaField("KPIs", draft.kpis, patch("kpis"), "One KPI per line")}
          ${textareaField(
            "Skills",
            draft.skills,
            patch("skills"),
            "One per line as skill:level, where level is 1-5. e.g. copywriting:4",
          )}
          ${textareaField(
            "Capabilities",
            draft.capabilities,
            patch("capabilities"),
            "One capability per line, e.g. can_publish_content",
          )}
        `,
      )}
      ${tabbed(
        "communication",
        html`
          <div class="aops-field-grid">
            ${selectField("Tone", draft.commTone, optionsFrom(COMMUNICATION_TONES), patch("commTone"))}
            ${selectField("Verbosity", draft.commVerbosity, optionsFrom(COMMUNICATION_VERBOSITY), patch("commVerbosity"))}
            ${selectField("Proactivity", draft.commProactivity, optionsFrom(PROACTIVITY_LEVELS), patch("commProactivity"))}
            ${selectField("Emoji use", draft.commEmoji, optionsFrom(EMOJI_USAGE), patch("commEmoji"))}
            ${field("Language", draft.commLanguage, patch("commLanguage"), { placeholder: "BCP-47, e.g. en" })}
            ${selectField("Report cadence", draft.commReportCadence, optionsFrom(REPORT_CADENCES), patch("commReportCadence"))}
            ${field("Report time", draft.commReportTime, patch("commReportTime"), { type: "time" })}
          </div>
          <p class="aops-dialog-help">
            Response latency is what stops an employee replying like a bot: never sooner than the
            minimum, aiming for the target, answering once per batch window.
          </p>
          <div class="aops-field-grid">
            ${field("Minimum reply delay (s)", draft.commMinSeconds, patch("commMinSeconds"), { type: "number" })}
            ${field("Target reply time (s)", draft.commTargetSeconds, patch("commTargetSeconds"), { type: "number" })}
            ${field("Batch window (s)", draft.commBatchSeconds, patch("commBatchSeconds"), { type: "number" })}
            ${booleanField("Respect working schedule", draft.commRespectSchedule, patch("commRespectSchedule"))}
            ${selectField("Outside working hours", draft.commOutsideHours, optionsFrom(OUTSIDE_HOURS_BEHAVIOURS), patch("commOutsideHours"))}
            ${field("Escalate after (min)", draft.commEscalateAfterMinutes, patch("commEscalateAfterMinutes"), { type: "number" })}
            ${booleanField("Always notify manager", draft.commNotifyManager, patch("commNotifyManager"))}
          </div>
          ${field("Out-of-hours auto-reply", draft.commOutsideHoursMessage, patch("commOutsideHoursMessage"), {
            placeholder: "Sent once per conversation when outside hours is auto-reply",
          })}
          <div class="aops-field-grid">
            ${field("Greeting", draft.commGreeting, patch("commGreeting"))}
            ${field("Sign-off", draft.commSignOff, patch("commSignOff"))}
          </div>
          ${field("Escalation phrasing", draft.commEscalationPhrase, patch("commEscalationPhrase"), {
            placeholder: "How it words handing a thread up to its manager",
          })}
          ${field("Hand-off phrasing", draft.commHandoffPhrase, patch("commHandoffPhrase"), {
            placeholder: "How it words passing a thread to someone else",
          })}
          ${textareaField("Communication notes", draft.commNotes, patch("commNotes"), "Anything else it should know about how to talk")}
        `,
      )}
      ${tabbed(
        "channels",
        html`
          ${field("Model / backend binding", draft.modelBinding, patch("modelBinding"), {
            placeholder: "e.g. claude, codex, anthropic/claude-opus-4-6. Empty = gateway default.",
          })}
          ${field("Fallback backend", draft.fallbackModelBinding, patch("fallbackModelBinding"), {
            placeholder: "Retried with when the primary fails to launch",
          })}
          <div class="aops-field-grid">
            ${field("Max concurrent runs", draft.maxConcurrent, patch("maxConcurrent"), { type: "number" })}
            ${field("Run timeout (min)", draft.timeoutMinutes, patch("timeoutMinutes"), { type: "number" })}
            ${field("Extra retries", draft.maxRetries, patch("maxRetries"), { type: "number" })}
          </div>
          ${field("Tool allowlist", draft.toolAllowlist, patch("toolAllowlist"), {
            placeholder: "Comma separated. Empty means unrestricted.",
          })}
          ${field("Tool denylist", draft.toolDenylist, patch("toolDenylist"), {
            placeholder: "Comma separated. Wins over the allowlist.",
          })}
          ${textareaField("Operator notes", draft.execNotes, patch("execNotes"), "Why these limits are set the way they are")}
          <p class="aops-dialog-help">
            Leave a numeric field empty to inherit the gateway default. Channel bindings are edited
            from the employee profile panel, one platform at a time.
          </p>
        `,
      )}
    `;
  } else if (draft.kind === "employee-channel") {
    valid = draft.workerId.length > 0 && draft.channelId.length > 0;
    body = html`
      ${selectField("Employee", draft.workerId, workerOptions, patch("workerId"))}
      ${selectField(
        "Platform",
        draft.channelId,
        EMPLOYEE_CHANNEL_IDS.map((id) => [id, channelLabel(id)] as [string, string]),
        patch("channelId"),
      )}
      ${field("Target", draft.target, patch("target"), {
        placeholder: "Channel / chat / JID id. Empty uses the channel default.",
      })}
      ${field("Handle", draft.handle, patch("handle"), {
        placeholder: "How this employee appears there",
      })}
      ${selectField(
        "Direction",
        draft.direction,
        [
          ["both", "Inbound and outbound"],
          ["inbound", "Inbound only"],
          ["outbound", "Outbound only"],
        ],
        patch("direction"),
      )}
      ${booleanField("Enabled", draft.enabled, patch("enabled"))}
      <small>
        Routing only. Never put tokens or secrets here — channel credentials belong in the gateway
        channel configuration, not in the replicated agency database.
      </small>
    `;
  } else if (draft.kind === "employee-sop-attach") {
    const sopOptions: Array<[string, string]> = state.sops.map((sop) => [
      sop.id,
      `${sop.name} · ${sop.category}`,
    ]);
    valid = draft.sopId.length > 0 && draft.workerId.length > 0;
    body = html`
      ${
        state.sops.length
          ? selectField("Procedure", draft.sopId, sopOptions, patch("sopId"))
          : html`<div class="aops-inline-notice warning">
              No SOPs are available to attach. Either the agency has no catalogue yet or
              agency.ops.sops.list did not return.
            </div>`
      }
      ${selectField("Employee", draft.workerId, workerOptions, patch("workerId"))}
      ${selectField("Manager", draft.managerWorkerId, managerOptions, patch("managerWorkerId"))}
      <div class="aops-field-grid">
        ${selectField(
          "Cadence",
          draft.cadence,
          [
            ["daily", "Daily"],
            ["weekly", "Weekly"],
            ["monthly", "Monthly"],
          ],
          patch("cadence"),
        )}
        ${field("Every", draft.interval, patch("interval"), { type: "number" })}
        ${
          draft.cadence === "weekly"
            ? selectField(
                "Weekday",
                draft.weekday,
                WEEKDAY_LABELS.map((label, index) => [String(index), label] as [string, string]),
                patch("weekday"),
              )
            : draft.cadence === "monthly"
              ? field("Day of month", draft.monthDay, patch("monthDay"), { type: "number" })
              : nothing
        }
        ${field("Run at", draft.runAt, patch("runAt"), { type: "time" })}
        ${field("Timezone", draft.timezone, patch("timezone"))}
        ${field("SLA (min)", draft.slaMinutes, patch("slaMinutes"), { type: "number" })}
        ${selectField("Priority", draft.priority, priorityOptions, patch("priority"))}
      </div>
      <small>
        Attaching creates a real cron job and a recurring responsibility. Work materialises into
        Backlog; nothing is auto-accepted.
      </small>
    `;
  } else if (draft.kind === "employee-schedule") {
    const selectedDays = new Set(
      draft.weekdays
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((day) => Number.isInteger(day)),
    );
    const toggleDay = (day: number) => {
      const next = new Set(selectedDays);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      patch("weekdays")([...next].sort().join(","));
    };
    valid = draft.workerId.length > 0 && selectedDays.size > 0;
    body = html`
      ${selectField("Employee", draft.workerId, workerOptions, patch("workerId"))}
      <fieldset class="aops-daypicker">
        <legend>Working days</legend>
        ${WEEKDAY_LABELS.map(
          (dayLabel, index) => html`
            <button
              type="button"
              class=${selectedDays.has(index) ? "aops-day active" : "aops-day"}
              aria-pressed=${selectedDays.has(index) ? "true" : "false"}
              aria-label=${`Toggle ${dayLabel} as a working day`}
              @click=${() => toggleDay(index)}
            >${dayLabel}</button>
          `,
        )}
      </fieldset>
      ${field("Shift start", draft.shiftStart, patch("shiftStart"), { type: "time" })}
      ${field("Shift end", draft.shiftEnd, patch("shiftEnd"), { type: "time" })}
      ${field("Effective from", draft.effectiveFrom, patch("effectiveFrom"), { type: "date" })}
      ${field("Timezone", draft.timezone, patch("timezone"), { placeholder: "e.g. America/New_York" })}
    `;
  } else if (draft.kind === "employee-responsibility") {
    valid = draft.workerId.length > 0 && draft.title.trim().length > 0;
    body = html`
      ${selectField("Employee", draft.workerId, workerOptions, patch("workerId"))}
      ${field("Responsibility", draft.title, patch("title"), {
        placeholder: "e.g. Reconcile yesterday's invoices",
      })}
      ${textareaField(
        "Instructions",
        draft.instructions,
        patch("instructions"),
        "What the employee should do each time this runs",
      )}
      ${selectField(
        "Cadence",
        draft.cadence,
        [
          ["daily", "Daily"],
          ["weekly", "Weekly"],
          ["monthly", "Monthly"],
        ],
        patch("cadence"),
      )}
      ${
        draft.cadence === "weekly"
          ? selectField(
              "Day of week",
              draft.weekday,
              WEEKDAY_LABELS.map((dayLabel, index) => [String(index), dayLabel]),
              patch("weekday"),
            )
          : nothing
      }
      ${
        draft.cadence === "monthly"
          ? field("Day of month", draft.monthDay, patch("monthDay"), { type: "number" })
          : nothing
      }
      ${field("Run at", draft.runAt, patch("runAt"), { type: "time" })}
      ${field("Repeat every (intervals)", draft.interval, patch("interval"), { type: "number" })}
      ${field("SLA minutes", draft.slaMinutes, patch("slaMinutes"), { type: "number" })}
      ${selectField("Priority", draft.priority, priorityOptions, patch("priority"))}
      ${selectField("Manager", draft.managerWorkerId, managerOptions, patch("managerWorkerId"))}
    `;
  } else if (draft.kind === "employee-review") {
    valid = draft.workerId.length > 0 && draft.managerWorkerId.length > 0;
    body = html`
      ${selectField("Employee", draft.workerId, workerOptions, patch("workerId"))}
      ${selectField("Manager", draft.managerWorkerId, workerOptions, patch("managerWorkerId"))}
      ${field("Cadence (days)", draft.cadenceDays, patch("cadenceDays"), { type: "number" })}
      ${field("Next review", draft.nextReviewDate, patch("nextReviewDate"), { type: "date" })}
      ${textareaField("Agenda (one item per line)", draft.agenda, patch("agenda"))}
    `;
  } else if (draft.kind === "employee-work-item") {
    valid = draft.workerId.length > 0 && draft.title.trim().length > 0;
    body = html`
      ${selectField("Employee", draft.workerId, workerOptions, patch("workerId"))}
      ${field("Work item", draft.title, patch("title"), { placeholder: "Clear outcome" })}
      ${textareaField("Instructions", draft.instructions, patch("instructions"))}
      ${selectField("Priority", draft.priority, priorityOptions, patch("priority"))}
      ${field("Due", draft.dueDate, patch("dueDate"), { type: "date" })}
      ${selectField("Manager", draft.managerWorkerId, managerOptions, patch("managerWorkerId"))}
    `;
  } else if (draft.kind === "employee-edit") {
    valid = draft.name.trim().length > 0 && draft.role.trim().length > 0;
    body = html`
      ${field("Name", draft.name, patch("name"))}
      ${field("Role", draft.role, patch("role"))}
      ${field("Department", draft.department, patch("department"))}
      ${field("Weekly capacity", draft.capacityHours, patch("capacityHours"), { type: "number" })}
      ${selectField(
        "Availability",
        draft.availability,
        [
          ["available", "Available"],
          ["focused", "Focused"],
          ["blocked", "Blocked"],
          ["offline", "Offline"],
        ],
        patch("availability"),
      )}
      <small>Employee updates require a gateway that exposes agency.ops.employee.update.</small>
    `;
  } else if (draft.kind === "employee-memory") {
    valid = draft.workerId.length > 0 && draft.key.trim().length > 0;
    body = html`
      ${selectField("Employee", draft.workerId, workerOptions, patch("workerId"))}
      ${field("Namespace", draft.namespace, patch("namespace"), {
        placeholder: "e.g. client-context, sop, preferences",
      })}
      ${field("Key", draft.key, patch("key"), { placeholder: "What this entry is about" })}
      ${textareaField(
        "Value",
        draft.value,
        patch("value"),
        "Plain text, or JSON for structured recall",
      )}
      ${field("Expires on", draft.expiresDate, patch("expiresDate"), { type: "date" })}
      <small>Leave the expiry empty for memory the employee should keep indefinitely.</small>
    `;
  } else if (draft.kind === "client-edit") {
    // Handled by the dedicated premium modal above; this branch is unreachable
    // but keeps the union exhaustive for the type checker.
    valid = draft.name.trim().length > 0;
    body = html``;
  } else if (draft.kind === "task-edit") {
    valid = draft.taskId.length > 0 && draft.title.trim().length > 0;
    body = html`
      ${field("Title", draft.title, patch("title"))}
      ${selectField(
        "Status",
        draft.status,
        [
          ["backlog", "Backlog"],
          ["ready", "Ready"],
          ["in_progress", "In progress"],
          ["blocked", "Blocked"],
          ["review", "Review"],
          ["done", "Done"],
          ["cancelled", "Cancelled"],
        ],
        patch("status"),
      )}
      ${selectField(
        "Priority",
        draft.priority,
        [
          ["low", "Low"],
          ["normal", "Normal"],
          ["high", "High"],
          ["urgent", "Urgent"],
        ],
        patch("priority"),
      )}
      ${field("Due date", draft.dueDate, patch("dueDate"), { type: "date" })}
      <small>Title, priority and due date persist via agency.ops.tasks.update; the state move always saves.</small>
    `;
  } else {
    valid = draft.projectId.length > 0 && draft.name.trim().length > 0;
    body = html`
      ${field("Name", draft.name, patch("name"))}
      ${selectField(
        "Status",
        draft.status,
        [
          ["planned", "Planned"],
          ["active", "Active"],
          ["on_hold", "On hold"],
          ["completed", "Completed"],
          ["cancelled", "Cancelled"],
        ],
        patch("status"),
      )}
      ${field("Budget", draft.budget, patch("budget"), { type: "number", placeholder: "0" })}
      ${field("Target end date", draft.dueDate, patch("dueDate"), { type: "date" })}
      <small>Name, budget and deadline persist via agency.ops.projects.update; the status move always saves.</small>
    `;
  }

  const isEdit =
    draft.kind.endsWith("-edit") ||
    draft.kind === "employee-profile" ||
    (draft.kind === "employee-channel" && draft.bindingId.length > 0) ||
    (draft.kind === "employee-memory" && draft.memoryId.length > 0);
  return html`
    <div class="aops-overlay" @click=${(event: Event) => event.target === event.currentTarget && closeAgencyOpsDialog(host)}>
      <form
        class=${draft.kind === "employee-profile" ? "aops-dialog wide" : "aops-dialog"}
        role="dialog"
        aria-modal="true"
        aria-label=${EXTENDED_DIALOG_TITLES[draft.kind]}
        @submit=${(event: Event) => {
          event.preventDefault();
          if (valid) void submitAgencyOpsDialog(host, client);
        }}
      >
        <div class="aops-row">
          <h2>${EXTENDED_DIALOG_TITLES[draft.kind]}</h2>
          <button type="button" class="aops-x" aria-label="Close dialog" @click=${() => closeAgencyOpsDialog(host)}>×</button>
        </div>
        ${body}
        <div class="aops-actions">
          <button type="button" class="aops-btn ghost" @click=${() => closeAgencyOpsDialog(host)}>Cancel</button>
          <button class="aops-btn primary" ?disabled=${!valid || state.saving}>
            ${state.saving ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderDialog(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
) {
  const draft = state.dialog;
  if (!draft) return nothing;
  if (isExtendedAgencyOpsDialog(draft)) return renderExtendedDialog(host, state, client, draft);
  const patch = (key: string) => (value: string) => patchAgencyOpsDialog(host, { [key]: value });
  const valid =
    draft.kind === "share"
      ? draft.email.trim().length > 3
      : draft.kind === "task"
        ? draft.title.trim().length > 0 && draft.projectId.length > 0
        : draft.kind === "assignment"
          ? draft.title.trim().length > 0
      : draft.kind === "agency" || draft.kind === "client" || draft.kind === "project"
        ? draft.name.trim().length > 0
        : draft.name.trim().length > 0 &&
          (draft.kind === "employee"
            ? draft.role.trim().length > 0
            : draft.clientName.trim().length > 0);
  const title =
    draft.kind === "deal"
      ? "Create pipeline opportunity"
      : draft.kind === "engagement"
        ? "Start engagement"
        : draft.kind === "employee"
          ? "Add employee"
          : draft.kind === "agency"
            ? "Create agency"
            : draft.kind === "client"
              ? "Add client"
              : draft.kind === "project"
                ? "Create project"
                : draft.kind === "task"
                  ? "Create task"
                  : draft.kind === "assignment"
                    ? "Create assignment"
            : "Share agency";

  return html`
    <div class="aops-overlay" @click=${(event: Event) => event.target === event.currentTarget && closeAgencyOpsDialog(host)}>
      <form
        class="aops-dialog"
        @submit=${(event: Event) => {
          event.preventDefault();
          if (valid) void submitAgencyOpsDialog(host, client);
        }}
      >
        <div class="aops-row"><h2>${title}</h2><button type="button" class="aops-x" @click=${() => closeAgencyOpsDialog(host)}>×</button></div>
        ${
          draft.kind === "share"
            ? html`
              ${field("Email", draft.email, patch("email"), { type: "email", placeholder: "teammate@company.com" })}
              <label class="aops-field"><span>Access role</span>
                <select .value=${draft.role} @change=${(e: Event) => patch("role")((e.target as HTMLSelectElement).value)}>
                  <option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option>
                </select>
              </label>
            `
            : draft.kind === "task"
              ? field("Task title", draft.title, patch("title"), {
                  placeholder: "Clear outcome or deliverable",
                })
            : draft.kind === "assignment"
              ? field("Assignment title", draft.title, patch("title"), {
                  placeholder: "Clear outcome or deliverable",
                })
            : field("Name", draft.name, patch("name"), {
                placeholder:
                  draft.kind === "employee"
                    ? "Employee name"
                    : draft.kind === "agency"
                      ? "Agency name"
                      : draft.kind === "client"
                        ? "Client or company name"
                        : draft.kind === "project"
                          ? "Project name"
                      : "Project or opportunity",
              })
        }
        ${
          draft.kind === "deal" || draft.kind === "engagement"
            ? field("Client", draft.clientName, patch("clientName"), {
                placeholder: "Client or company",
              })
            : draft.kind === "employee"
              ? html`
              <label class="aops-field"><span>Worker type</span>
                <select .value=${draft.workerKind} @change=${(e: Event) => patch("workerKind")((e.target as HTMLSelectElement).value)}>
                  <option value="human">Human employee</option><option value="ai">AI employee</option>
                </select>
              </label>
              ${field("Role", draft.role, patch("role"), { placeholder: "e.g. Account Manager" })}
              ${field("Department", draft.department, patch("department"), { placeholder: "e.g. Delivery" })}
              ${field("Weekly capacity", draft.capacityHours, patch("capacityHours"), { type: "number" })}
            `
              : draft.kind === "client"
                ? field("Billing email", draft.billingEmail, patch("billingEmail"), {
                    type: "email",
                    placeholder: "billing@company.com",
                  })
                : draft.kind === "project"
                  ? html`
                      <label class="aops-field"><span>Client</span>
                        <select .value=${draft.clientId} @change=${(event: Event) => patch("clientId")((event.target as HTMLSelectElement).value)}>
                          <option value="">No client yet</option>
                          ${state.clients.map((agencyClient) => html`<option value=${agencyClient.id}>${agencyClient.name}</option>`)}
                        </select>
                      </label>
                      ${field("Budget", draft.budget, patch("budget"), { type: "number" })}
                    `
                  : draft.kind === "task"
                    ? html`
                        <label class="aops-field"><span>Project</span>
                          <select .value=${draft.projectId} @change=${(event: Event) => patch("projectId")((event.target as HTMLSelectElement).value)}>
                            ${state.projects.map((project) => html`<option value=${project.id}>${project.name}</option>`)}
                          </select>
                        </label>
                        <label class="aops-field"><span>Instructions</span>
                          <textarea rows="4" .value=${draft.description} @input=${(event: Event) => patch("description")((event.target as HTMLTextAreaElement).value)}></textarea>
                        </label>
                        <label class="aops-field"><span>Assignee</span>
                          <select .value=${draft.assigneeId} @change=${(event: Event) => {
                            const employeeId = (event.target as HTMLSelectElement).value;
                            const employee = state.employees.find((item) => item.id === employeeId);
                            patchAgencyOpsDialog(host, {
                              assigneeId: employeeId,
                              assigneeType: employee?.kind ?? "human",
                            });
                          }}>
                            <option value="">Unassigned</option>
                            ${state.employees.map((employee) => html`<option value=${employee.id}>${employee.name} · ${employee.kind.toUpperCase()} · ${employee.role}</option>`)}
                          </select>
                        </label>
                      `
                    : draft.kind === "assignment"
                      ? html`
                        <label class="aops-field"><span>Instructions</span>
                          <textarea rows="4" .value=${draft.description} @input=${(event: Event) => patch("description")((event.target as HTMLTextAreaElement).value)}></textarea>
                        </label>
                        <label class="aops-field"><span>Assign to</span>
                          <select .value=${draft.memberId} @change=${(event: Event) => patch("memberId")((event.target as HTMLSelectElement).value)}>
                            <option value="">Unassigned</option>
                            ${state.employees.map((employee) => html`<option value=${employee.id}>${employee.name} · ${employee.kind.toUpperCase()} · ${employee.role}</option>`)}
                          </select>
                        </label>
                      `
              : nothing
        }
        ${
          draft.kind === "deal"
            ? html`
              ${field("Value", draft.value, patch("value"), { type: "number" })}
              <label class="aops-field"><span>Pipeline stage</span>
                <select .value=${draft.stageId} @change=${(e: Event) => patch("stageId")((e.target as HTMLSelectElement).value)}>
                  ${state.pipelineStages.map((stage) => html`<option value=${stage.id}>${stage.label}</option>`)}
                </select>
              </label>
            `
            : draft.kind === "engagement"
              ? html`${field("Budget", draft.budget, patch("budget"), { type: "number" })}${field("Target delivery", draft.dueDate, patch("dueDate"), { type: "date" })}`
              : draft.kind === "assignment"
                ? html`${field("Estimated hours", draft.estimatedHours, patch("estimatedHours"), { type: "number" })}${field("Priority (1 highest)", draft.priority, patch("priority"), { type: "number" })}`
              : nothing
        }
        <div class="aops-actions">
          <button type="button" class="aops-btn ghost" @click=${() => closeAgencyOpsDialog(host)}>Cancel</button>
          <button class="aops-btn primary" ?disabled=${!valid || state.saving}>${state.saving ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </div>
  `;
}

/**
 * Agency Operations visual language.
 *
 * Every surface here is drawn from the app's own glass design system in
 * theme-glass.ts rather than a private palette. Radii come from --g-radius*,
 * elevation from --g-shadow*, frost from --g-blur*, and anything that
 * communicates state (healthy / watch / broken) uses the semantic --g-success,
 * --g-warning, --g-danger, --g-info and --g-neutral tokens. The page therefore
 * recolours with the appearance picker instead of drifting away from it.
 *
 * The local --ao-* layer exists only to name the recipes that repeat: the
 * translucent plate, the raised plate, the hairline highlight and the padding
 * scale. Nothing in it introduces a new colour.
 */
const styles = html`
  <style>
    .aops {
      /* Geometry — theme radii, never literals. */
      --ao-radius-lg: var(--g-radius-lg, 18px);
      --ao-radius: var(--g-radius, 12px);
      --ao-radius-sm: var(--g-radius-sm, 8px);
      --ao-pill: 999px;

      /* Frost + elevation. */
      --ao-blur: var(--g-blur, blur(14px) saturate(160%));
      --ao-blur-heavy: var(--g-blur-heavy, blur(22px) saturate(180%));
      --ao-elev-sm: var(--g-shadow-sm, 0 4px 14px rgba(0, 0, 0, 0.18));
      --ao-elev: var(--g-shadow, 0 12px 40px rgba(0, 0, 0, 0.35));
      --ao-elev-lg: var(--g-shadow-lg, 0 24px 60px rgba(0, 0, 0, 0.45));
      /* Inset top highlight — the single line of specular light that makes a
         translucent plate read as glass rather than as a tinted rectangle. */
      --ao-hairline: inset 0 1px 0 rgba(255, 255, 255, 0.08);
      --ao-hairline-strong: inset 0 1px 0 rgba(255, 255, 255, 0.13);

      /* Lines. */
      --ao-line: var(--g-border, color-mix(in srgb, var(--g-primary, #8b5cf6) 18%, transparent));
      --ao-line-soft: color-mix(in srgb, var(--g-primary, #8b5cf6) 9%, rgba(255, 255, 255, 0.06));
      --ao-line-strong: var(
        --g-border-strong,
        color-mix(in srgb, var(--g-primary, #8b5cf6) 40%, transparent)
      );

      /* Ink. */
      --ao-dim: var(--g-fg-dim, #a1a1aa);
      --ao-faint: var(--g-fg-faint, #71717a);

      /* Plates. Layered translucent gradients so the aurora behind the page
         genuinely shows through the panel instead of being covered by it. */
      --ao-glass: linear-gradient(
        160deg,
        color-mix(in srgb, var(--g-primary, #8b5cf6) 3%, rgba(255, 255, 255, 0.075)) 0%,
        color-mix(in srgb, var(--g-primary, #8b5cf6) 1%, rgba(255, 255, 255, 0.03)) 55%,
        rgba(255, 255, 255, 0.02) 100%
      );
      --ao-glass-raised: linear-gradient(
        160deg,
        color-mix(in srgb, var(--g-primary, #8b5cf6) 9%, rgba(255, 255, 255, 0.08)) 0%,
        color-mix(in srgb, var(--g-primary, #8b5cf6) 3%, rgba(255, 255, 255, 0.03)) 100%
      );
      --ao-glass-inner: linear-gradient(
        160deg,
        rgba(255, 255, 255, 0.055) 0%,
        rgba(255, 255, 255, 0.018) 100%
      );

      /* Padding rhythm — one scale, used everywhere. */
      --ao-pad-lg: 24px;
      --ao-pad: 18px;
      --ao-pad-sm: 12px;
      --ao-gap: 14px;
      --ao-gap-sm: 10px;

      color: var(--g-fg, #f4f4f5);
      padding: 28px 26px 36px;
      max-width: 1600px;
      margin: auto;
    }
    .aops *,
    .aops *::before,
    .aops *::after {
      box-sizing: border-box;
    }
    .aops button,
    .aops input,
    .aops select,
    .aops textarea {
      font: inherit;
    }

    /* ── Page header ──────────────────────────────────────── */
    .aops-head,
    .aops-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .aops-head {
      margin-bottom: 24px;
      align-items: flex-end;
    }
    .aops h1 {
      font-size: 26px;
      letter-spacing: -0.01em;
      margin: 0 0 6px;
    }
    .aops h2 {
      font-size: 15px;
      margin: 0;
    }
    .aops-sub,
    .aops span,
    .aops small {
      color: var(--ao-dim);
    }
    .aops-tools,
    .aops-actions,
    .aops-filters {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    /* ── Buttons: pills with hover lift and a real pressed state ── */
    .aops-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--ao-line);
      background: var(--ao-glass-raised);
      color: var(--g-fg, #f4f4f5);
      padding: 9px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: var(--ao-pill);
      backdrop-filter: var(--ao-blur);
      -webkit-backdrop-filter: var(--ao-blur);
      box-shadow: var(--ao-hairline);
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.18s ease, border-color 0.18s ease, transform 0.12s ease,
        box-shadow 0.18s ease, color 0.18s ease;
    }
    .aops-btn:hover:not(:disabled) {
      border-color: var(--ao-line-strong);
      background: color-mix(in srgb, var(--g-primary, #8b5cf6) 16%, transparent);
      box-shadow: 0 8px 22px -10px color-mix(in srgb, var(--g-primary, #8b5cf6) 65%, transparent),
        var(--ao-hairline-strong);
      transform: translateY(-1px);
    }
    .aops-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.35);
      background: color-mix(in srgb, var(--g-primary, #8b5cf6) 22%, transparent);
    }
    /* Deliberately primary-forward rather than --g-gradient-accent: that
       gradient runs primary to accent, which on the default palette sweeps the
       brand gold into violet and reads as a different product's button. */
    .aops-btn.primary {
      background: linear-gradient(
        160deg,
        color-mix(in srgb, var(--g-primary, #7c3aed) 92%, white) 0%,
        var(--g-primary, #7c3aed) 55%,
        color-mix(in srgb, var(--g-primary, #7c3aed) 88%, var(--g-accent, #a855f7)) 100%
      );
      border-color: transparent;
      color: var(--g-bg-deep, #0a0a0e);
      box-shadow: 0 6px 20px -6px var(--g-primary-strong, rgba(124, 58, 237, 0.5)),
        var(--ao-hairline-strong);
    }
    .aops-btn.primary:hover:not(:disabled) {
      box-shadow: 0 12px 30px -8px var(--g-primary-strong, rgba(124, 58, 237, 0.6)),
        var(--ao-hairline-strong);
      background: linear-gradient(
        160deg,
        color-mix(in srgb, var(--g-primary, #7c3aed) 84%, white) 0%,
        color-mix(in srgb, var(--g-primary, #7c3aed) 96%, white) 55%,
        color-mix(in srgb, var(--g-primary, #7c3aed) 88%, var(--g-accent, #a855f7)) 100%
      );
    }
    .aops-btn.primary:active:not(:disabled) {
      box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .aops-btn.ghost {
      background: transparent;
      color: var(--ao-dim);
      border-color: var(--ao-line-soft);
    }
    .aops-btn.ghost:hover:not(:disabled) {
      color: var(--g-fg, #f4f4f5);
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.06));
    }
    .aops-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }
    .aops-btn.compact {
      min-height: 28px;
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .aops-link {
      border: 0;
      background: transparent;
      color: var(--g-primary, #a78bfa);
      padding: 0;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border-radius: var(--ao-radius-sm);
      transition: color 0.15s ease, opacity 0.15s ease;
    }
    .aops-link:hover {
      text-decoration: underline;
      opacity: 0.85;
    }
    .aops-link.danger {
      color: var(--g-danger, #f87171);
    }
    .aops-link.strong {
      font-size: 14px;
      color: var(--g-text, #e8e8ef);
    }
    .aops-link.strong:hover {
      color: var(--g-primary, #a78bfa);
    }
    .aops-x {
      border: 0;
      background: var(--g-surface, rgba(255, 255, 255, 0.05));
      color: var(--ao-dim);
      font-size: 18px;
      line-height: 1;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border-radius: var(--ao-pill);
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .aops-x:hover {
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.09));
      color: var(--g-fg, #f4f4f5);
    }

    .aops-visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }
    .aops :focus-visible {
      outline: 2px solid var(--g-primary, #8b5cf6);
      outline-offset: 2px;
      border-radius: var(--ao-radius-sm);
    }

    /* ── Inputs ───────────────────────────────────────────── */
    .aops-assign-select,
    .aops-board-filter select,
    .aops-agency-select,
    .aops-member-list select,
    .aops-employee-side input,
    .aops-allocation-list input,
    .aops-client-search input,
    .aops-field input,
    .aops-field select,
    .aops-field textarea {
      background: var(--g-surface, rgba(255, 255, 255, 0.05));
      color: var(--g-fg, #f4f4f5);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
    }
    .aops-assign-select:hover,
    .aops-board-filter select:hover,
    .aops-agency-select:hover,
    .aops-member-list select:hover,
    .aops-client-search input:hover,
    .aops-field input:hover,
    .aops-field select:hover,
    .aops-field textarea:hover {
      border-color: var(--ao-line);
    }
    .aops-assign-select:focus,
    .aops-board-filter select:focus,
    .aops-agency-select:focus,
    .aops-client-search input:focus,
    .aops-field input:focus,
    .aops-field select:focus,
    .aops-field textarea:focus {
      border-color: var(--ao-line-strong);
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.07));
    }

    .aops-task-controls {
      display: flex;
      gap: 6px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .aops-assign {
      display: inline-flex;
      min-width: 0;
      flex: 1 1 120px;
    }
    .aops-assign-select {
      width: 100%;
      max-width: 100%;
      border-radius: var(--ao-radius-sm);
      padding: 6px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .aops-payment-row {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .aops-field.compact {
      margin: 0;
      max-width: 190px;
      min-width: 0;
    }
    .aops-client-open {
      background: none;
      border: 0;
      padding: 0;
      color: inherit;
      font: inherit;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-client-open:hover {
      color: var(--g-primary, #a78bfa);
      text-decoration: underline;
    }
    .aops-daypicker {
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      background: var(--ao-glass-inner);
      padding: 10px 12px 12px;
      margin: 0 0 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .aops-daypicker legend {
      color: var(--ao-dim);
      font-size: 11px;
      padding: 0 4px;
    }
    .aops-day {
      background: transparent;
      color: var(--ao-dim);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-pill);
      padding: 5px 12px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .aops-day:hover {
      border-color: var(--ao-line);
      color: var(--g-fg, #f4f4f5);
    }
    .aops-day.active {
      background: var(--g-primary, #7c3aed);
      border-color: var(--g-primary, #7c3aed);
      color: var(--g-bg-deep, #0a0a0e);
      font-weight: 600;
    }

    /* ── Glass plates ─────────────────────────────────────── */
    .aops-kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--ao-gap);
      margin-bottom: var(--ao-gap);
    }
    .aops-kpis > * {
      min-width: 0;
    }
    .aops-card,
    .aops-kpi,
    .aops-surface,
    .aops-agencybar,
    .aops-board-col,
    .aops-settings-card,
    .aops-detail,
    .aops-board-employees {
      position: relative;
      background: var(--ao-glass);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius-lg);
      backdrop-filter: var(--ao-blur);
      -webkit-backdrop-filter: var(--ao-blur);
      box-shadow: var(--ao-elev), var(--ao-hairline), inset 0 -1px 0 rgba(0, 0, 0, 0.28);
      isolation: isolate;
    }
    /* Top glare arc. A flat translucent fill alone still reads as a tinted
       rectangle; the reflected-light ellipse just outside the top edge is what
       makes the plate read as a sheet of glass. */
    .aops-card::before,
    .aops-kpi::before,
    .aops-surface::before,
    .aops-agencybar::before,
    .aops-settings-card::before,
    .aops-detail::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      border-radius: inherit;
      background: radial-gradient(
          ellipse 60% 42% at 50% -12%,
          rgba(255, 255, 255, 0.09),
          transparent 60%
        ),
        radial-gradient(
          ellipse 42% 32% at 100% 100%,
          var(--g-primary-soft, transparent),
          transparent 62%
        );
    }
    /* Nested plates use the neutral inner glass, never the brand-tinted one:
       a tinted plate drawn over another tinted plate doubles the wash and the
       inner panel turns opaque brown instead of reading as glass. Declared
       after the shared rule above so it wins on equal specificity.

       They also drop backdrop-filter. There is no page background behind a
       nested plate, only its parent plate, so the frost buys nothing while the
       saturate(160%) component re-saturates the parent's brand tint — which is
       what turned every inner panel into a solid amber bar. */
    .aops-board-col,
    .aops-settings-card,
    .aops-detail,
    .aops-board-employees,
    .aops-summary-strip,
    .aops-surface .aops-card,
    .aops-surface .aops-kpi {
      background: var(--ao-glass-inner);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    .aops-settings-card::before,
    .aops-detail::before {
      background: radial-gradient(
        ellipse 60% 42% at 50% -12%,
        rgba(255, 255, 255, 0.06),
        transparent 60%
      );
    }
    .aops-kpi {
      padding: var(--ao-pad);
      min-width: 0;
      transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.2s ease,
        box-shadow 0.2s ease;
    }
    .aops-kpi:hover {
      transform: translateY(-2px);
      border-color: var(--ao-line);
      box-shadow: var(--ao-elev-lg), var(--ao-hairline-strong);
    }
    .aops-kpi > span {
      display: block;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ao-dim);
    }
    .aops-kpi strong {
      display: block;
      font-size: 24px;
      line-height: 1.15;
      margin: 10px 0 5px;
      letter-spacing: -0.01em;
    }
    .aops-trend.positive {
      color: var(--g-success, #22c55e);
    }
    .aops-trend.warning,
    .aops-trend.critical {
      color: var(--g-warning, #f59e0b);
    }
    .aops-grid {
      display: grid;
      grid-template-columns: 1.18fr 0.82fr;
      gap: var(--ao-gap);
      align-items: start;
    }
    .aops-grid > * {
      min-width: 0;
    }
    .aops-card {
      padding: var(--ao-pad-lg);
      min-width: 0;
    }
    .aops-card > header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }
    .aops-count {
      background: var(--g-surface-strong, rgba(255, 255, 255, 0.08));
      border: 1px solid var(--ao-line-soft);
      padding: 4px 11px;
      border-radius: var(--ao-pill);
      font-size: 11px;
      white-space: nowrap;
    }
    .aops-pipeline {
      grid-column: 1/-1;
    }
    .aops-stages {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--ao-gap-sm);
      margin-bottom: var(--ao-gap);
    }
    .aops-stages > * {
      min-width: 0;
    }
    .aops-stage {
      padding: 13px 14px;
      border-radius: var(--ao-radius);
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-top: 2px solid var(--stage-color, var(--g-primary, #8b5cf6));
      box-shadow: var(--ao-hairline);
    }
    .aops-stage strong,
    .aops-stage span {
      display: block;
    }
    .aops-stage strong {
      margin: 6px 0;
      font-size: 16px;
    }
    .aops-deals {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(245px, 1fr));
      gap: var(--ao-gap-sm);
    }
    .aops-deals > * {
      min-width: 0;
    }
    .aops-deal {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      padding: 13px 14px;
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-hairline);
      min-width: 0;
    }
    .aops-deal strong,
    .aops-deal span {
      display: block;
      min-width: 0;
    }
    .aops-deal span,
    .aops-deal-next {
      font-size: 11px;
    }
    .aops-deal-value {
      font-weight: 700;
    }
    .aops-deal-next {
      grid-column: 1/-1;
      color: var(--g-primary, #a78bfa);
    }
    .aops-engagements,
    .aops-approvals,
    .aops-roster {
      display: grid;
      gap: var(--ao-gap-sm);
    }
    .aops-engagement,
    .aops-approval,
    .aops-employee {
      padding: 14px 15px;
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-hairline);
      min-width: 0;
      transition: border-color 0.18s ease, background 0.18s ease;
    }
    .aops-engagement:hover,
    .aops-approval:hover,
    .aops-employee:hover {
      border-color: var(--ao-line);
    }
    .aops-engagement strong,
    .aops-engagement span {
      display: block;
    }

    /* ── Chips + status pills ─────────────────────────────── */
    .aops-chip,
    .aops-risk,
    .aops-worker,
    .aops-presence {
      display: inline-flex;
      align-items: center;
      flex: none;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border: 1px solid var(--g-neutral-border, color-mix(in srgb, var(--g-neutral, #94a3b8) 40%, transparent));
      background: var(--g-neutral-soft, color-mix(in srgb, var(--g-neutral, #94a3b8) 10%, transparent));
      color: var(--g-neutral, #94a3b8);
      border-radius: var(--ao-pill);
      padding: 3px 10px;
      white-space: nowrap;
    }
    .aops-chip.active,
    .aops-chip.completed,
    .aops-chip.paid,
    .aops-chip.approved {
      color: var(--g-success, #22c55e);
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success, #22c55e) 40%, transparent));
      background: var(--g-success-soft, color-mix(in srgb, var(--g-success, #22c55e) 12%, transparent));
    }
    .aops-chip.blocked,
    .aops-chip.overdue,
    .aops-chip.escalated,
    .aops-chip.cancelled {
      color: var(--g-danger, #ef4444);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 40%, transparent));
      background: var(--g-danger-soft, color-mix(in srgb, var(--g-danger, #ef4444) 12%, transparent));
    }
    .aops-chip.review,
    .aops-chip.waiting,
    .aops-chip.due,
    .aops-chip.partially_paid {
      color: var(--g-warning, #f59e0b);
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning, #f59e0b) 40%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning, #f59e0b) 12%, transparent));
    }
    .aops-chip.in_progress,
    .aops-chip.accepted,
    .aops-chip.issued,
    .aops-chip.planned {
      color: var(--g-info, #38bdf8);
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info, #38bdf8) 40%, transparent));
      background: var(--g-info-soft, color-mix(in srgb, var(--g-info, #38bdf8) 12%, transparent));
    }
    .aops-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
      font-size: 10px;
      margin: 12px 0 8px;
    }
    /* The track has to stay legible at 0% — an allocation bar that vanishes
       when empty reads as a missing element rather than as "nothing allocated",
       so the track carries its own border in addition to the fill tint. */
    .aops-progress {
      height: 6px;
      background: rgba(255, 255, 255, 0.09);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-pill);
      overflow: hidden;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
    }
    .aops-progress i {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--g-gradient-accent, var(--g-primary, #7c3aed));
      transition: width 0.4s ease;
    }
    .aops-deliverables {
      margin-top: 11px;
      display: grid;
      gap: 6px;
    }
    .aops-deliverables > div {
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }
    .aops-status {
      width: 6px;
      height: 6px;
      border-radius: var(--ao-pill);
      background: var(--g-neutral, #71717a);
    }
    .aops-status.approved {
      background: var(--g-success, #22c55e);
    }
    .aops-status.in_progress,
    .aops-status.in_review {
      background: var(--g-info, #38bdf8);
    }
    .aops-status.blocked {
      background: var(--g-danger, #ef4444);
    }
    .aops-risk.low {
      color: var(--g-success, #22c55e);
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success, #22c55e) 40%, transparent));
      background: var(--g-success-soft, transparent);
    }
    .aops-risk.medium {
      color: var(--g-warning, #f59e0b);
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning, #f59e0b) 40%, transparent));
      background: var(--g-warning-soft, transparent);
    }
    .aops-risk.high {
      color: var(--g-danger, #ef4444);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 40%, transparent));
      background: var(--g-danger-soft, transparent);
    }
    .aops-approval > strong {
      display: block;
      margin: 12px 0 5px;
    }
    .aops-approval p {
      font-size: 12px;
      color: var(--ao-dim);
      margin: 0 0 12px;
      line-height: 1.5;
    }
    .aops-approval .aops-actions {
      justify-content: flex-end;
      margin-top: 12px;
    }
    .aops-roster-card {
      grid-column: 1/-1;
    }

    /* ── Segmented filters + view toggle ──────────────────── */
    .aops-filters {
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-pill);
      padding: 3px;
      gap: 2px;
      flex-wrap: nowrap;
    }
    .aops-filters button {
      border: 0;
      background: transparent;
      color: var(--ao-dim);
      cursor: pointer;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: var(--ao-pill);
      white-space: nowrap;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .aops-filters button:hover {
      color: var(--g-fg, #f4f4f5);
    }
    .aops-filters button.active {
      background: var(--g-surface-strong, rgba(255, 255, 255, 0.1));
      color: var(--g-fg, #f4f4f5);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
    }
    .aops-view-toggle {
      display: flex;
      border: 1px solid var(--ao-line-soft);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      border-radius: var(--ao-pill);
      padding: 3px;
      gap: 2px;
    }
    .aops-view-toggle button {
      border: 0;
      background: transparent;
      color: var(--ao-dim);
      cursor: pointer;
      padding: 7px 16px;
      font-size: 12px;
      font-weight: 600;
      border-radius: var(--ao-pill);
      transition: background 0.15s ease, color 0.15s ease;
    }
    .aops-view-toggle button:hover {
      color: var(--g-fg, #f4f4f5);
    }
    .aops-view-toggle button.active {
      background: var(--g-primary, #7c3aed);
      color: var(--g-bg-deep, #0a0a0e);
      box-shadow: 0 4px 14px -6px var(--g-primary-strong, transparent);
    }

    /* ── Task board ───────────────────────────────────────── */
    .aops-board-wrap {
      margin-top: 8px;
    }
    .aops-board-toolbar {
      display: flex;
      align-items: center;
      gap: var(--ao-gap);
      margin-bottom: var(--ao-gap);
      flex-wrap: wrap;
    }
    .aops-board-filter select {
      padding: 8px 11px;
      border-radius: var(--ao-radius);
    }
    .aops-board-employees {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: var(--ao-gap);
      padding: var(--ao-pad-sm);
      border-style: dashed;
      border-color: var(--ao-line);
    }
    .aops-employee-chip {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 13px 5px 5px;
      border-radius: var(--ao-pill);
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-hairline);
      font-size: 12px;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .aops-employee-chip:hover {
      border-color: var(--ao-line-strong);
    }
    .aops-employee-chip.unassigned {
      opacity: 0.75;
    }
    .aops-employee-chip .aops-avatar {
      width: 24px;
      height: 24px;
      font-size: 10px;
      border-radius: var(--ao-pill);
    }
    .aops-board {
      display: grid;
      grid-template-columns: repeat(6, minmax(200px, 1fr));
      gap: var(--ao-gap-sm);
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .aops-board > * {
      min-width: 0;
    }
    .aops-board-col {
      padding: 10px;
      min-height: 220px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-radius: var(--ao-radius);
    }
    .aops-board-col header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 4px 4px 9px;
      border-bottom: 1px solid var(--ao-line-soft);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ao-dim);
    }
    .aops-board-col-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
      min-height: 60px;
    }
    .aops-board-card {
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius-sm);
      padding: 10px;
      cursor: grab;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
      transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
    }
    .aops-board-card:hover {
      border-color: var(--ao-line);
      transform: translateY(-1px);
      box-shadow: var(--ao-elev), var(--ao-hairline-strong);
    }
    .aops-board-card strong {
      overflow-wrap: anywhere;
    }
    .aops-board-card:active {
      cursor: grabbing;
    }
    .aops-board-empty {
      display: block;
      text-align: center;
      padding: 12px 4px;
      opacity: 0.55;
    }

    /* ── Employee roster ──────────────────────────────────── */
    .aops-roster {
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    }
    .aops-roster > * {
      min-width: 0;
    }
    /* Dense mode drops the card to a single readable column so a large roster
       can be scanned; it deliberately keeps the governance strip, because
       autonomy is the one field a scan must not lose. */
    .aops-directory.layout-list .aops-roster {
      grid-template-columns: minmax(0, 1fr);
    }
    .aops-directory.layout-list .aops-employee-reach {
      display: none;
    }
    .aops-directory.layout-list .aops-employee {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
      align-items: center;
    }
    .aops-directory.layout-list .aops-employee-head,
    .aops-directory.layout-list .aops-employee-expanded,
    .aops-directory.layout-list .aops-employee-actions {
      grid-column: 1 / -1;
    }
    .aops-employee {
      display: grid;
      gap: 12px;
      align-content: start;
    }
    .aops-employee.selected {
      border-color: var(--ao-line-strong);
      box-shadow: var(--ao-hairline-strong), 0 0 0 1px var(--g-primary-muted, transparent);
    }
    .aops-employee-head {
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
    }
    .aops-employee-id {
      min-width: 0;
    }
    .aops-employee-id .aops-row > strong {
      min-width: 0;
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-employee-role,
    .aops-employee-line {
      display: block;
      max-width: 100%;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-employee-role {
      font-size: 11.5px;
      margin-top: 3px;
      color: var(--g-fg, #f4f4f5);
    }
    .aops-employee-line {
      font-size: 10px;
      margin-top: 2px;
      color: var(--ao-dim);
    }
    .aops-employee-main {
      min-width: 0;
    }

    /* Governance strip — what actually decides whether this employee's work
       reaches anyone without a human in the loop. */
    .aops-employee-governance {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
      gap: 8px;
    }
    .aops-autonomy,
    .aops-employee-binding {
      display: grid;
      gap: 2px;
      min-width: 0;
      padding: 7px 10px;
      border-radius: var(--ao-radius-sm);
      border: 1px solid var(--g-neutral-border, color-mix(in srgb, var(--g-neutral, #94a3b8) 40%, transparent));
      background: var(--g-neutral-soft, color-mix(in srgb, var(--g-neutral, #94a3b8) 10%, transparent));
    }
    .aops-autonomy b,
    .aops-employee-binding b {
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 700;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }
    .aops-autonomy i,
    .aops-employee-binding i {
      font-style: normal;
      font-size: 10px;
      color: var(--ao-dim);
      display: block;
      max-width: 100%;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-autonomy.neutral b {
      color: var(--g-neutral, #94a3b8);
    }
    .aops-autonomy.info {
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info, #38bdf8) 40%, transparent));
      background: var(--g-info-soft, color-mix(in srgb, var(--g-info, #38bdf8) 12%, transparent));
    }
    .aops-autonomy.info b {
      color: var(--g-info, #7dd3fc);
    }
    .aops-autonomy.warning {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning, #f59e0b) 40%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning, #f59e0b) 12%, transparent));
    }
    .aops-autonomy.warning b {
      color: var(--g-warning, #fbbf24);
    }
    .aops-autonomy.danger {
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 40%, transparent));
      background: var(--g-danger-soft, color-mix(in srgb, var(--g-danger, #ef4444) 12%, transparent));
    }
    .aops-autonomy.danger b {
      color: var(--g-danger, #fca5a5);
    }
    .aops-autonomy.unknown {
      border-style: dashed;
    }
    .aops-employee-binding b {
      color: var(--g-accent, #c4b5fd);
    }

    .aops-employee-load {
      display: grid;
      gap: 7px;
    }
    .aops-employee-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      font-size: 10px;
      color: var(--ao-dim);
      min-width: 0;
    }
    .aops-employee-facts b {
      color: var(--g-fg, #f4f4f5);
      font-size: 11px;
    }
    /* "Not loaded" must never look like a zero. Dashed, dimmed and italic so a
       missing fetch is visibly a different statement from a real empty. */
    .aops-unloaded {
      color: var(--ao-faint);
      font-style: italic;
      border-bottom: 1px dashed var(--ao-line-soft);
    }
    .aops-lastrun {
      font-size: 10px;
      padding: 5px 9px;
      border-radius: var(--ao-radius-sm);
      border: 1px solid var(--g-neutral-border, color-mix(in srgb, var(--g-neutral, #94a3b8) 40%, transparent));
      background: var(--g-neutral-soft, color-mix(in srgb, var(--g-neutral, #94a3b8) 10%, transparent));
      color: var(--g-neutral, #94a3b8);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-lastrun.success {
      color: var(--g-success, #22c55e);
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success, #22c55e) 40%, transparent));
      background: var(--g-success-soft, transparent);
    }
    .aops-lastrun.warning {
      color: var(--g-warning, #f59e0b);
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning, #f59e0b) 40%, transparent));
      background: var(--g-warning-soft, transparent);
    }
    .aops-lastrun.danger {
      color: var(--g-danger, #ef4444);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 40%, transparent));
      background: var(--g-danger-soft, transparent);
    }
    .aops-lastrun.info {
      color: var(--g-info, #38bdf8);
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info, #38bdf8) 40%, transparent));
      background: var(--g-info-soft, transparent);
    }

    .aops-employee-reach {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      min-width: 0;
    }
    .aops-employee-channels {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      font-size: 10px;
      min-width: 0;
    }
    .aops-channel-chip {
      font-size: 9px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: var(--ao-pill);
      border: 1px solid var(--g-accent-muted, color-mix(in srgb, var(--g-accent, #a855f7) 35%, transparent));
      background: var(--g-accent-soft, color-mix(in srgb, var(--g-accent, #a855f7) 12%, transparent));
      color: var(--g-accent, #c4b5fd);
      white-space: nowrap;
    }
    .aops-channel-chip.off {
      border-color: var(--ao-line-soft);
      background: transparent;
      color: var(--ao-faint);
      text-decoration: line-through;
    }

    .aops-employee-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding-top: 10px;
      border-top: 1px solid var(--ao-line-soft);
      min-width: 0;
    }
    .aops-employee-actions-end {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-left: auto;
      min-width: 0;
    }
    .aops-capacity-field {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ao-dim);
      white-space: nowrap;
    }
    .aops-capacity-field input {
      width: 58px;
      border-radius: var(--ao-radius-sm);
      padding: 5px 7px;
      text-align: right;
    }
    .aops-disclosure {
      background: transparent;
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-pill);
      color: var(--ao-dim);
      font-size: 10px;
      padding: 5px 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .aops-disclosure:hover,
    .aops-disclosure:focus-visible {
      color: var(--g-fg, #f4f4f5);
      border-color: var(--ao-line);
    }
    .aops-employee-expanded {
      display: grid;
      gap: 12px;
      padding-top: 11px;
      border-top: 1px solid var(--ao-line-soft);
      min-width: 0;
    }
    .aops-expand-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
    }
    .aops-expand-grid > * {
      min-width: 0;
    }
    .aops-expand-block b {
      display: block;
      font-size: 9px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ao-dim);
      margin-bottom: 5px;
    }
    .aops-expand-block p {
      margin: 0;
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .aops-expand-block ul {
      margin: 0;
      padding-left: 15px;
      font-size: 11px;
      line-height: 1.55;
    }
    .aops-expand-block li {
      overflow-wrap: anywhere;
    }

    /* ── Employee detail: SOPs, runs, channels ─────────────── */
    .aops-detail-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-bottom: 16px;
    }
    .aops-sop-list,
    .aops-channel-list,
    .aops-run-list {
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .aops-sop-row,
    .aops-channel-row {
      display: grid;
      gap: 7px;
      padding: 9px 10px;
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius-sm);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      min-width: 0;
    }
    .aops-channel-row {
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
    }
    .aops-sop-main,
    .aops-channel-main {
      min-width: 0;
    }
    .aops-sop-main strong,
    .aops-channel-main strong {
      display: block;
      max-width: 100%;
      font-size: 11.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-sop-main small,
    .aops-channel-main small {
      display: block;
      font-size: 9.5px;
      color: var(--ao-dim);
      margin-top: 3px;
      overflow-wrap: anywhere;
    }
    .aops-sop-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .aops-channel-row .aops-sop-actions {
      grid-column: 1 / -1;
    }
    .aops-run-row {
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      font-size: 10px;
    }
    .aops-run-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-run-row small {
      color: var(--ao-dim);
      white-space: nowrap;
      font-size: 9px;
    }
    .aops-run-dot {
      width: 7px;
      height: 7px;
      border-radius: var(--ao-pill);
      background: var(--g-neutral, #71717a);
    }
    .aops-run-dot.success {
      background: var(--g-success, #22c55e);
    }
    .aops-run-dot.warning {
      background: var(--g-warning, #f59e0b);
    }
    .aops-run-dot.danger {
      background: var(--g-danger, #ef4444);
    }
    .aops-run-dot.info {
      background: var(--g-info, #38bdf8);
    }
    .aops-danger-zone {
      border-top: 1px solid var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 30%, transparent));
      padding-top: 14px;
      margin-top: 22px;
    }
    .aops-btn.danger {
      color: var(--g-danger, #ef4444);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 40%, transparent));
    }
    .aops-btn.danger:hover:not(:disabled) {
      background: var(--g-danger-soft, color-mix(in srgb, var(--g-danger, #ef4444) 14%, transparent));
    }

    /* ── Roster search ────────────────────────────────────── */
    .aops-search {
      flex: 1 1 200px;
      min-width: 0;
      display: flex;
    }
    .aops-search input {
      width: 100%;
      min-width: 0;
      border-radius: var(--ao-pill);
      padding: 7px 14px;
      font-size: 11px;
    }

    /* ── Full employee editor ─────────────────────────────── */
    .aops-dialog.wide {
      max-width: 720px;
      width: min(720px, 94vw);
    }
    /* The editor is taller than the viewport on every tab, and a Save button
       that scrolls out of reach is a save an operator does not make. Both the
       section tabs and the actions stay pinned inside the dialog's own scroll. */
    .aops-dialog.wide .aops-dialog-tabs {
      position: sticky;
      top: -2px;
      z-index: 2;
      background: color-mix(in srgb, var(--g-bg-deep, #09090b) 92%, transparent);
    }
    .aops-dialog.wide .aops-actions {
      position: sticky;
      bottom: -26px;
      z-index: 2;
      margin: 0 -26px -26px;
      padding: 14px 26px 26px;
      background: linear-gradient(
        to top,
        color-mix(in srgb, var(--g-bg-deep, #09090b) 96%, transparent) 62%,
        transparent
      );
    }
    .aops-profile-head {
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr);
      align-items: center;
      gap: 11px;
      min-width: 0;
    }
    .aops-profile-head strong {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-profile-head small {
      display: block;
      font-size: 10px;
      color: var(--ao-dim);
      margin-top: 2px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-dialog-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      padding: 3px;
      border-radius: var(--ao-pill);
      border: 1px solid var(--ao-line-soft);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aops-dialog-tabs button {
      flex: 1 1 auto;
      min-width: 0;
      background: transparent;
      border: 0;
      border-radius: var(--ao-pill);
      color: var(--ao-dim);
      font-size: 10.5px;
      padding: 7px 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .aops-dialog-tabs button.active {
      background: var(--g-primary-soft, color-mix(in srgb, var(--g-primary, #8b5cf6) 18%, transparent));
      color: var(--g-fg, #f4f4f5);
    }
    .aops-field-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: var(--ao-gap-sm);
    }
    .aops-field-grid > * {
      min-width: 0;
    }
    .aops-dialog-help {
      margin: 0;
      font-size: 10.5px;
      line-height: 1.55;
      color: var(--ao-dim);
    }
    .aops-autonomy-picker {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 7px;
    }
    .aops-autonomy-option {
      display: grid;
      gap: 3px;
      text-align: left;
      min-width: 0;
      padding: 9px 11px;
      cursor: pointer;
      border-radius: var(--ao-radius-sm);
      border: 1px solid var(--ao-line-soft);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      color: var(--ao-dim);
    }
    .aops-autonomy-option b {
      font-size: 10.5px;
      color: var(--g-fg, #f4f4f5);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }
    .aops-autonomy-option i {
      font-style: normal;
      font-size: 9.5px;
      display: block;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .aops-autonomy-option.active.info {
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info, #38bdf8) 45%, transparent));
      background: var(--g-info-soft, color-mix(in srgb, var(--g-info, #38bdf8) 14%, transparent));
    }
    .aops-autonomy-option.active.warning {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning, #f59e0b) 45%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning, #f59e0b) 14%, transparent));
    }
    .aops-autonomy-option.active.danger {
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 45%, transparent));
      background: var(--g-danger-soft, color-mix(in srgb, var(--g-danger, #ef4444) 14%, transparent));
    }
    .aops-autonomy-option.active.neutral {
      border-color: var(--ao-line-strong);
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.08));
    }
    .aops-avatar {
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      background: color-mix(in srgb, var(--g-primary, #8b5cf6) 20%, transparent);
      border: 1px solid var(--ao-line-soft);
      color: var(--g-primary, #c4b5fd);
      border-radius: var(--ao-radius);
      font-weight: 700;
      font-size: 13px;
      box-shadow: var(--ao-hairline);
    }
    /* AI employees carry the accent, humans the primary, so the roster reads
       as two kinds of worker at a glance rather than one uniform list. */
    .aops-avatar.ai {
      background: var(--g-accent-soft, color-mix(in srgb, var(--g-accent, #a855f7) 20%, transparent));
      border-color: var(--g-accent-muted, color-mix(in srgb, var(--g-accent, #a855f7) 35%, transparent));
      color: var(--g-accent, #c4b5fd);
    }
    .aops-worker.ai {
      color: var(--g-accent, #c4b5fd);
      border-color: var(--g-accent-muted, color-mix(in srgb, var(--g-accent, #a855f7) 35%, transparent));
      background: var(--g-accent-soft, transparent);
    }
    .aops-worker.human {
      color: var(--g-info, #7dd3fc);
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info, #38bdf8) 40%, transparent));
      background: var(--g-info-soft, transparent);
    }
    .aops-employee-main > span {
      display: block;
      max-width: 100%;
      font-size: 11px;
      margin: 4px 0 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-employee-main .aops-row > strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-util {
      margin-bottom: 7px;
    }
    .aops-employee-side {
      display: grid;
      justify-items: end;
      gap: 8px;
    }
    .aops-employee-side label {
      font-size: 9px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ao-dim);
      display: grid;
      gap: 4px;
      justify-items: end;
    }
    .aops-employee-side input {
      width: 66px;
      border-radius: var(--ao-radius-sm);
      padding: 5px 7px;
      text-align: right;
    }
    .aops-presence.available {
      color: var(--g-success, #22c55e);
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success, #22c55e) 40%, transparent));
      background: var(--g-success-soft, transparent);
    }
    .aops-presence.blocked {
      color: var(--g-danger, #ef4444);
      border-color: var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 40%, transparent));
      background: var(--g-danger-soft, transparent);
    }

    /* ── Finance grid ─────────────────────────────────────── */
    .aops-finance {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: var(--ao-gap-sm);
    }
    .aops-finance div {
      padding: 13px 14px;
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      box-shadow: var(--ao-hairline);
      min-width: 0;
    }
    .aops-finance span,
    .aops-finance strong {
      display: block;
    }
    .aops-finance span {
      font-size: 10px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .aops-finance strong {
      font-size: 16px;
    }

    /* ── Financial command: quick actions + highlight ─────── */
    .aops-fin-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ao-gap-sm);
      margin-bottom: var(--ao-gap);
    }
    .aops-fin-highlight {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: var(--ao-gap-sm);
      margin-bottom: var(--ao-gap-sm);
    }
    .aops-fin-hi {
      padding: 13px 14px;
      background: var(--ao-glass-raised);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      box-shadow: var(--ao-hairline);
      min-width: 0;
    }
    .aops-fin-hi span {
      display: block;
      font-size: 10px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 6px;
      opacity: 0.7;
    }
    .aops-fin-hi strong {
      display: block;
      font-size: 19px;
    }
    .aops-fin-hi.warn strong {
      color: var(--g-warning, #f59e0b);
    }
    .aops-fin-hi.danger strong {
      color: var(--g-danger, #ef4444);
    }

    /* ── Active projects (client-joined, in-progress) ─────── */
    .aops-section-note {
      margin: 0 0 12px;
      font-size: 11px;
      line-height: 1.5;
      opacity: 0.65;
    }
    .aops-active-projects {
      display: flex;
      flex-direction: column;
      gap: var(--ao-gap-sm);
    }
    .aops-active-client {
      padding: 14px 15px;
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      box-shadow: var(--ao-hairline);
    }
    .aops-active-client > header {
      margin-bottom: 10px;
    }
    .aops-active-client > header strong {
      display: block;
      font-size: 14px;
    }
    .aops-active-client > header span {
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.6;
    }
    .aops-active-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .aops-active-proj {
      padding: 11px 12px;
      background: var(--ao-glass-raised);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius-sm);
      cursor: pointer;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .aops-active-proj:hover {
      border-color: color-mix(in srgb, var(--g-info, #38bdf8) 45%, transparent);
      transform: translateY(-1px);
    }
    .aops-proj-name {
      font-size: 13px;
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Uncompleted / in-progress task cards — same visual language as the
       project card above (glass, radius, hairline, typography) but one step
       inset and lighter, with a per-status accent rail. */
    .aops-active-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .aops-active-controls .aops-assign {
      flex: 1 1 140px;
      min-width: 120px;
    }
    .aops-active-task-controls {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .aops-active-task-controls .aops-assign-select {
      max-width: 130px;
    }
    .aops-active-tasks {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--ao-line-soft);
    }
    .aops-active-task {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 10px;
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-left: 2px solid var(--task-accent, var(--g-info, #38bdf8));
      border-radius: var(--ao-radius-sm);
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .aops-active-task:hover {
      border-color: color-mix(in srgb, var(--task-accent, var(--g-info, #38bdf8)) 45%, transparent);
      transform: translateY(-1px);
    }
    .aops-task-dot {
      flex: 0 0 auto;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--task-accent, var(--g-info, #38bdf8));
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--task-accent, #38bdf8) 20%, transparent);
    }
    .aops-task-name {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 12px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-task-more {
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.6;
      padding-left: 2px;
    }

    /* ── Notices ──────────────────────────────────────────── */
    .aops-alert {
      border: 1px solid var(--g-danger-border, color-mix(in srgb, var(--g-danger, #ef4444) 40%, transparent));
      background: var(--g-danger-soft, color-mix(in srgb, var(--g-danger, #ef4444) 12%, transparent));
      color: var(--g-danger, #fca5a5);
      padding: 13px 15px;
      border-radius: var(--ao-radius);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
      margin-bottom: var(--ao-gap);
      font-size: 12px;
      line-height: 1.5;
    }
    .aops-alert.info {
      border-color: var(--g-info-border, color-mix(in srgb, var(--g-info, #38bdf8) 40%, transparent));
      background: var(--g-info-soft, color-mix(in srgb, var(--g-info, #38bdf8) 12%, transparent));
      color: var(--g-info, #bae6fd);
    }
    .aops-alert.warning {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning, #f59e0b) 40%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning, #f59e0b) 12%, transparent));
      color: var(--g-warning, #fde68a);
    }
    .aops-alert.good {
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success, #22c55e) 40%, transparent));
      background: var(--g-success-soft, color-mix(in srgb, var(--g-success, #22c55e) 12%, transparent));
      color: var(--g-success, #bbf7d0);
    }
    .aops-alert strong {
      color: inherit;
    }
    .aops-empty {
      text-align: center;
      color: var(--ao-faint);
      padding: 30px 24px;
      font-size: 12px;
      border: 1px dashed var(--ao-line-soft);
      border-radius: var(--ao-radius);
      background: color-mix(in srgb, var(--g-primary, #8b5cf6) 2%, transparent);
    }

    /* ── Modal dialog ─────────────────────────────────────── */
    .aops-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.62);
      backdrop-filter: blur(10px) saturate(120%);
      -webkit-backdrop-filter: blur(10px) saturate(120%);
      display: grid;
      place-items: center;
      z-index: 1000;
      padding: 24px;
      animation: aops-fade 0.18s ease;
    }
    @keyframes aops-fade {
      from {
        opacity: 0;
      }
    }
    .aops-dialog {
      width: min(500px, 100%);
      max-height: min(86vh, 900px);
      overflow: auto;
      position: relative;
      background: linear-gradient(
          160deg,
          color-mix(in srgb, var(--g-primary, #8b5cf6) 7%, rgba(255, 255, 255, 0.07)) 0%,
          rgba(255, 255, 255, 0.02) 60%,
          rgba(0, 0, 0, 0.05) 100%
        ),
        color-mix(in srgb, var(--g-bg-deep, #09090b) 88%, transparent);
      border: 1px solid var(--ao-line);
      border-radius: var(--ao-radius-lg);
      padding: 26px;
      backdrop-filter: var(--ao-blur-heavy);
      -webkit-backdrop-filter: var(--ao-blur-heavy);
      box-shadow: var(--ao-elev-lg), 0 0 0 1px var(--g-primary-soft, transparent),
        var(--ao-hairline-strong), inset 0 -1px 0 rgba(0, 0, 0, 0.4);
      animation: aops-rise 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes aops-rise {
      from {
        opacity: 0;
        transform: translateY(10px) scale(0.985);
      }
    }
    .aops-dialog h2 {
      font-size: 19px;
      letter-spacing: -0.01em;
    }
    .aops-dialog > .aops-row:first-child {
      margin-bottom: 4px;
    }
    .aops-field {
      display: grid;
      gap: 7px;
      margin-top: 16px;
      min-width: 0;
    }
    .aops-field span {
      font-size: 11px;
      letter-spacing: 0.04em;
      color: var(--ao-dim);
    }
    .aops-field input,
    .aops-field select,
    .aops-field textarea {
      padding: 10px 12px;
      min-width: 0;
    }
    .aops-field textarea {
      resize: vertical;
      min-height: 120px;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .aops-dialog > .aops-actions {
      justify-content: flex-end;
      margin-top: 24px;
    }
    .aops-loading {
      min-height: 380px;
      display: grid;
      place-items: center;
      color: var(--ao-dim);
    }

    /* ── Agency bar ───────────────────────────────────────── */
    .aops-agencybar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      padding: 14px 18px;
      margin-bottom: var(--ao-gap);
      border-radius: var(--ao-radius);
    }
    .aops-agencybar label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--ao-dim);
    }
    .aops-agency-select {
      min-width: 240px;
      padding: 9px 12px;
    }
    .aops-role {
      display: inline-flex;
      align-items: center;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--g-primary, #c4b5fd);
      background: var(--g-primary-soft, color-mix(in srgb, var(--g-primary, #8b5cf6) 10%, transparent));
      border: 1px solid var(--g-primary-muted, color-mix(in srgb, var(--g-primary, #8b5cf6) 28%, transparent));
      border-radius: var(--ao-pill);
      padding: 4px 11px;
    }
    .aops-agency-spacer {
      flex: 1;
    }

    /* ── Section navigation ───────────────────────────────── */
    .aops-section-nav {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      border-bottom: 1px solid var(--ao-line-soft);
      margin: 0 0 20px;
      padding: 0 2px;
      scrollbar-width: thin;
    }
    .aops-section-nav button {
      white-space: nowrap;
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--ao-dim);
      padding: 11px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border-radius: var(--ao-radius-sm) var(--ao-radius-sm) 0 0;
      transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }
    .aops-section-nav button:hover {
      color: var(--g-fg, #f4f4f5);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aops-section-nav button.active {
      color: var(--g-fg, #f4f4f5);
      border-bottom-color: var(--g-primary, #8b5cf6);
      background: var(--g-primary-soft, transparent);
    }
    .aops-section-nav b {
      display: inline-grid;
      place-items: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      margin-left: 5px;
      background: var(--g-danger, #ef4444);
      color: var(--g-bg-deep, #0a0a0e);
      border-radius: var(--ao-pill);
      font-size: 10px;
      font-weight: 700;
    }

    /* ── Dedicated surfaces ───────────────────────────────── */
    .aops-surface {
      padding: var(--ao-pad-lg);
    }
    .aops-surface-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 22px;
    }
    .aops-surface-head > div:first-child {
      min-width: 0;
    }
    .aops-surface-head h2 {
      font-size: 23px;
      letter-spacing: -0.01em;
      margin: 5px 0;
    }
    .aops-surface-head p {
      margin: 0;
      color: var(--ao-dim);
      font-size: 12px;
      line-height: 1.5;
    }
    .aops-eyebrow {
      display: inline-block;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-weight: 600;
      font-size: 9px;
      color: var(--g-primary, #a78bfa) !important;
    }
    /* Cells are divided by a real border rather than by a 1px grid gap over a
       tinted parent: the gap technique showed the parent tint through the
       translucent glass cells, turning the whole strip into a solid bar. */
    .aops-summary-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      overflow: hidden;
      margin-bottom: var(--ao-gap);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
    }
    .aops-summary-strip > div {
      padding: 16px 18px;
      min-width: 0;
      border-left: 1px solid var(--ao-line-soft);
    }
    .aops-summary-strip > div:first-child {
      border-left: 0;
    }
    .aops-summary-strip strong,
    .aops-summary-strip span {
      display: block;
    }
    .aops-summary-strip strong {
      font-size: 21px;
      letter-spacing: -0.01em;
    }
    .aops-summary-strip span {
      font-size: 10px;
      letter-spacing: 0.04em;
      margin-top: 4px;
    }
    .aops-surface-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: var(--ao-gap);
    }
    .aops-directory.with-detail {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: var(--ao-gap);
      align-items: start;
    }
    /* The panel now carries autonomy, executor limits, SOPs, runs, channels and
       memory, so it scrolls in place rather than stretching the page past the
       roster it belongs beside. */
    .aops-directory.with-detail > .aops-detail {
      position: sticky;
      top: 12px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
    }
    .aops-detail {
      padding: var(--ao-pad-lg);
      border-radius: var(--ao-radius);
      min-width: 0;
    }
    .aops-detail > .aops-x {
      position: absolute;
      right: 12px;
      top: 12px;
    }
    .aops-avatar.large {
      width: 56px;
      height: 56px;
      font-size: 18px;
      border-radius: var(--ao-radius);
      margin-bottom: 14px;
    }
    .aops-detail h2 {
      font-size: 20px;
      margin: 12px 0 3px;
    }
    .aops-detail > p {
      margin: 0 0 16px;
      color: var(--ao-dim);
    }
    .aops-detail dl,
    .aops-settings-card dl {
      display: grid;
      gap: 1px;
      margin: 0;
    }
    .aops-detail dl > div,
    .aops-settings-card dl > div {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--ao-line-soft);
    }
    .aops-detail dt,
    .aops-settings-card dt {
      color: var(--ao-dim);
      font-size: 11px;
      white-space: nowrap;
    }
    .aops-detail dd,
    .aops-settings-card dd {
      margin: 0;
      min-width: 0;
      font-size: 11px;
      text-align: right;
      overflow-wrap: anywhere;
    }
    .aops-detail-block {
      display: grid;
      gap: 8px;
      margin-top: 18px;
    }
    .aops-detail-block span {
      font-size: 10px;
      line-height: 1.5;
    }
    .aops-inline-notice {
      margin-top: 16px;
      border: 1px solid var(--g-info-border, color-mix(in srgb, var(--g-info, #38bdf8) 40%, transparent));
      background: var(--g-info-soft, color-mix(in srgb, var(--g-info, #38bdf8) 12%, transparent));
      color: var(--g-info, #bae6fd);
      padding: 11px 13px;
      border-radius: var(--ao-radius);
      box-shadow: var(--ao-hairline);
      font-size: 11px;
      line-height: 1.5;
    }
    .aops-inline-notice.warning {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--g-warning, #f59e0b) 40%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--g-warning, #f59e0b) 12%, transparent));
      color: var(--g-warning, #fde68a);
    }
    .aops-inline-notice.good {
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success, #22c55e) 40%, transparent));
      background: var(--g-success-soft, color-mix(in srgb, var(--g-success, #22c55e) 12%, transparent));
      color: var(--g-success, #bbf7d0);
    }

    /* ── Live oversight board ─────────────────────────────── */
    /* The reused Daily-Ops board renders .agx-* markup, whose design tokens are
       scoped to a .agx ancestor — this wrapper provides that scope so the board
       is styled here exactly as it is on Daily Operations. */
    .aops-oversight {
      display: block;
      margin-bottom: 18px;
    }
    .aops-oversight-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.85fr) minmax(300px, 0.95fr);
      gap: 14px;
      align-items: start;
      margin-top: 12px;
    }
    .aops-oversight-main {
      min-width: 0;
    }
    .aops-oversight-side {
      display: grid;
      gap: 12px;
      min-width: 0;
      position: sticky;
      top: 8px;
    }
    .aops-oversight-side .agx-panel-body {
      max-height: 340px;
      overflow-y: auto;
    }
    .aops-oversight .agx-timeline .agx-row {
      align-items: flex-start;
    }
    @media (max-width: 1180px) {
      .aops-oversight-grid {
        grid-template-columns: 1fr;
      }
      .aops-oversight-side {
        position: static;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 720px) {
      .aops-oversight-side {
        grid-template-columns: 1fr;
      }
    }

    /* ── Allocation ───────────────────────────────────────── */
    .aops-allocation-list {
      display: grid;
      gap: var(--ao-gap-sm);
    }
    .aops-allocation-list article {
      display: grid;
      grid-template-columns: 40px minmax(180px, 1fr) 110px 90px;
      align-items: center;
      gap: 13px;
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-hairline);
      padding: 13px 14px;
      min-width: 0;
    }
    .aops-allocation-list article > * {
      min-width: 0;
    }
    .aops-allocation-list article small {
      display: block;
      margin: 4px 0 9px;
    }
    .aops-allocation-value {
      display: grid;
      gap: 2px;
    }
    .aops-allocation-value span {
      font-size: 10px;
    }
    .aops-allocation-list label {
      display: grid;
      gap: 4px;
      color: var(--ao-dim);
      font-size: 9px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .aops-allocation-list input {
      width: 78px;
      border-radius: var(--ao-radius-sm);
      padding: 6px 8px;
    }
    .aops-approval-inbox {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: var(--ao-gap-sm);
    }
    .aops-approval-inbox > * {
      min-width: 0;
    }
    .aops-purpose-empty {
      text-align: center;
      max-width: 620px;
      margin: 50px auto;
      padding: 36px 32px;
      border: 1px dashed var(--ao-line);
      border-radius: var(--ao-radius-lg);
      background: var(--ao-glass);
      backdrop-filter: var(--ao-blur);
      -webkit-backdrop-filter: var(--ao-blur);
      box-shadow: var(--ao-elev), var(--ao-hairline);
    }
    .aops-purpose-empty h3 {
      margin: 12px 0 6px;
      font-size: 17px;
    }
    .aops-purpose-empty p {
      color: var(--ao-dim);
      font-size: 12px;
      line-height: 1.6;
    }
    .aops-purpose-empty code,
    .aops-inline-notice code {
      font-size: 10px;
      color: var(--g-accent, #c4b5fd);
      background: var(--g-accent-soft, transparent);
      border-radius: var(--ao-radius-sm);
      padding: 1px 5px;
    }
    .aops-empty-icon {
      font-size: 32px;
      color: var(--g-primary, #a78bfa) !important;
    }

    /* ── Settings cards ───────────────────────────────────── */
    .aops-settings-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--ao-gap);
      align-items: start;
    }
    .aops-settings-grid > * {
      min-width: 0;
    }
    .aops-settings-card {
      padding: var(--ao-pad);
      border-radius: var(--ao-radius);
      min-width: 0;
    }
    .aops-settings-card h3 {
      margin: 0 0 14px;
      font-size: 14px;
    }
    .aops-migration-card {
      grid-column: 1/-1;
    }
    .aops-client-search input {
      width: min(320px, 42vw);
      min-height: 40px;
      border-radius: var(--ao-pill);
      padding: 0 16px;
    }
    .aops-client-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: var(--ao-gap-sm);
      margin-top: var(--ao-gap);
    }
    .aops-client-card {
      min-width: 0;
      display: grid;
      gap: var(--ao-gap-sm);
      padding: 16px;
      border-radius: var(--ao-radius);
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
      transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.18s ease,
        box-shadow 0.18s ease;
    }
    /* The action row carries four controls at 1440px. Let it wrap instead of
       clipping "Activate" off the card edge. */
    .aops-client-card > .aops-row:last-child {
      flex-wrap: wrap;
      row-gap: 6px;
    }
    .aops-client-card:hover {
      transform: translateY(-2px);
      border-color: var(--ao-line-strong);
      box-shadow: var(--ao-elev), var(--ao-hairline-strong);
    }
    .aops-client-card > strong,
    .aops-client-card > small {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-client-avatar {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      border-radius: var(--ao-radius);
      background: var(--g-gradient-accent, var(--g-primary, #7c3aed));
      color: var(--g-bg-deep, #0a0a0e);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.04em;
      box-shadow: var(--ao-hairline);
    }
    .aops-client-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .aops-client-metrics span {
      display: grid;
      gap: 3px;
      min-width: 0;
      font-size: 10px;
    }
    .aops-client-metrics b {
      color: var(--g-fg, #f4f4f5);
      font-size: 13px;
    }

    /* ── Rich client cards (finance section) ──────────────── */
    .aops-client-grid.rich {
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    }
    .aops-client-card.rich {
      gap: 12px;
      padding: 18px;
    }
    /* Gold status accent stripe down the leading edge of active clients. */
    .aops-client-card.rich.active {
      border-color: color-mix(in srgb, var(--g-primary, #d4af37) 32%, var(--ao-line-soft));
    }
    .aops-client-card.rich::after {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      border-radius: var(--ao-radius) 0 0 var(--ao-radius);
      background: var(--ao-dim);
      opacity: 0.5;
    }
    .aops-client-card.rich.active::after {
      background: var(--g-gradient-accent, var(--g-primary, #d4af37));
      opacity: 1;
    }
    .aops-client-card.rich.prospect::after {
      background: color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
    }
    .aops-client-head {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .aops-client-ident {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .aops-client-ident .aops-client-open {
      font-size: 14px;
      font-weight: 700;
    }
    .aops-client-ident small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ao-dim);
    }
    .aops-client-metrics.rich {
      padding: 10px 0;
      border-top: 1px solid var(--ao-line-soft);
      border-bottom: 1px solid var(--ao-line-soft);
    }
    .aops-client-metrics.rich span {
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ao-dim);
      gap: 2px;
    }
    .aops-client-metrics.rich b {
      font-size: 15px;
      color: var(--g-fg, #f4f4f5);
    }
    .aops-client-ledger {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .aops-client-ledger.compact {
      grid-template-columns: 1fr;
    }
    .aops-client-ledger span {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .aops-client-ledger b {
      font-size: 14px;
      color: var(--g-fg, #f4f4f5);
    }
    .aops-client-ledger small {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ao-dim);
    }
    .aops-client-ledger span.good b {
      color: var(--g-primary, #d4af37);
    }
    .aops-client-ledger span.warn b,
    .aops-client-ledger.compact span.warn {
      color: color-mix(in srgb, #f0b232 70%, var(--g-fg, #f4f4f5));
    }
    .aops-client-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .aops-client-actions .aops-btn {
      flex: 1 1 auto;
    }

    /* ═══════════════════════════════════════════════════════════════
       Premium client cards + editor — a visual match to the dedicated
       Clients page. Ported from ui/src/ui/views/clients.ts (crm-* system),
       adapted to the AgencyClient data shape and the --g-* / --ao- tokens.
       ═══════════════════════════════════════════════════════════════ */
    @keyframes aocModalFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes aocModalRise {
      from { opacity: 0; transform: translateY(14px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .aoc-grid-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 14px;
      margin-top: var(--ao-gap);
    }
    .aoc-card {
      position: relative; overflow: hidden;
      padding: 18px 18px 16px;
      border-radius: 16px;
      cursor: pointer;
      display: flex; flex-direction: column;
      background:
        linear-gradient(135deg,
          color-mix(in srgb, var(--g-primary, #fbbf24) 5%, transparent),
          transparent 60%),
        linear-gradient(180deg,
          color-mix(in srgb, #fff 3%, transparent),
          color-mix(in srgb, #000 28%, transparent));
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent),
        0 8px 24px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(14px) saturate(150%);
      transition: transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1),
                  border-color 200ms ease, box-shadow 220ms ease, background 200ms ease;
    }
    .aoc-card::before {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background:
        radial-gradient(ellipse 70% 40% at 30% 0%,
          color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent),
          transparent 65%);
      opacity: 0.55; transition: opacity 220ms ease;
    }
    .aoc-card:hover {
      transform: translateY(-3px);
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 38%, transparent);
      box-shadow:
        inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
        0 22px 48px rgba(0, 0, 0, 0.42),
        0 0 32px color-mix(in srgb, var(--g-primary, #fbbf24) 20%, transparent);
    }
    .aoc-card:hover::before { opacity: 0.9; }
    /* Status accent stripe down the leading edge. */
    .aoc-card::after {
      content: ""; position: absolute; inset: 0 auto 0 0;
      width: 3px; border-radius: 16px 0 0 16px;
      background: var(--ao-dim, rgba(255,255,255,0.14)); opacity: 0.5;
    }
    .aoc-card.active::after { background: var(--g-primary, #fbbf24); opacity: 1; }
    .aoc-card.prospect::after { background: color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent); }

    .aoc-card-actions {
      position: absolute; top: 12px; right: 12px; z-index: 3;
      display: flex; gap: 5px;
      opacity: 0; transform: translateY(-4px);
      transition: opacity 200ms ease, transform 200ms ease;
    }
    .aoc-card:hover .aoc-card-actions { opacity: 1; transform: translateY(0); }
    .aoc-card-action {
      padding: 5px 10px; border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
      background: color-mix(in srgb, #000 50%, transparent);
      color: #d4d4d8;
      font: 600 9.5px 'JetBrains Mono', monospace; letter-spacing: 0.06em;
      cursor: pointer; backdrop-filter: blur(10px); transition: all 140ms ease;
    }
    .aoc-card-action:hover {
      color: var(--g-primary, #fbbf24);
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
    }

    .aoc-card-header {
      position: relative; z-index: 1;
      display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
    }
    .aoc-card-avatar {
      width: 42px; height: 42px; border-radius: 50%;
      display: grid; place-items: center;
      font: 700 13px 'Inter', sans-serif; color: #0a0a0e; flex-shrink: 0;
      background: var(--g-gradient-accent, var(--g-primary, #fbbf24));
      border: 1px solid color-mix(in srgb, #fff 18%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent), 0 8px 18px rgba(0,0,0,0.36);
    }
    .aoc-card-info { flex: 1; min-width: 0; }
    .aoc-card-name {
      font: 700 15px/1.2 -apple-system, 'Inter', sans-serif; letter-spacing: -0.01em;
      color: #f5f5f4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .aoc-card-company {
      font: 500 11px 'Inter', sans-serif; color: rgba(255,255,255,0.5);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;
    }
    .aoc-card .aops-chip { flex-shrink: 0; }

    .aoc-card-socials {
      position: relative; z-index: 1;
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 10px;
    }
    .aoc-card-social {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 50%; opacity: 0.85;
      transition: opacity 150ms ease, transform 150ms ease;
    }
    .aoc-card-social:hover { opacity: 1; transform: scale(1.12); }
    .aoc-card-social svg { display: block; width: 20px; height: 20px; }

    .aoc-card-details {
      position: relative; z-index: 1;
      display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px;
    }
    .aoc-card-detail {
      display: flex; align-items: center; gap: 8px;
      font: 500 11.5px 'Inter', sans-serif; color: rgba(255,255,255,0.62); min-width: 0;
    }
    .aoc-card-detail.muted { color: rgba(255,255,255,0.35); font-style: italic; }
    .aoc-card-detail-icon { flex-shrink: 0; opacity: 0.6; color: var(--g-primary, #fbbf24); }
    .aoc-card-detail-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .aoc-card-metrics {
      position: relative; z-index: 1;
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px; padding: 10px 0; margin-bottom: 12px;
      border-top: 1px solid color-mix(in srgb, #fff 6%, transparent);
      border-bottom: 1px solid color-mix(in srgb, #fff 6%, transparent);
    }
    .aoc-card-metrics span { display: grid; gap: 2px; min-width: 0; text-align: left; }
    .aoc-card-metrics b { font: 800 16px 'Inter', sans-serif; color: #f5f5f4; }
    .aoc-card-metrics small {
      font: 600 9px 'JetBrains Mono', monospace; letter-spacing: 0.08em;
      text-transform: uppercase; color: rgba(255,255,255,0.42);
    }

    .aoc-card-ledger {
      position: relative; z-index: 1;
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;
    }
    .aoc-card-ledger span { display: grid; gap: 2px; min-width: 0; }
    .aoc-card-ledger b { font: 700 14px 'Inter', sans-serif; color: #f5f5f4; }
    .aoc-card-ledger small {
      font: 600 9px 'JetBrains Mono', monospace; letter-spacing: 0.08em;
      text-transform: uppercase; color: rgba(255,255,255,0.42);
    }
    .aoc-card-ledger span.good b { color: var(--g-primary, #fbbf24); }
    .aoc-card-ledger span.warn b { color: color-mix(in srgb, #f0b232 78%, #fff); }

    .aoc-card-footer {
      position: relative; z-index: 1;
      display: flex; align-items: center; gap: 6px; margin-top: auto;
      padding-top: 12px; border-top: 1px dashed color-mix(in srgb, #fff 6%, transparent);
    }
    .aoc-card-btn {
      flex: 1 1 auto;
      padding: 7px 10px; border-radius: 9px;
      font: 600 9.5px 'JetBrains Mono', monospace; text-transform: uppercase; letter-spacing: 0.1em;
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 20%, transparent);
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent),
        color-mix(in srgb, var(--g-primary, #fbbf24) 4%, transparent));
      color: color-mix(in srgb, var(--g-primary, #fbbf24) 90%, #fff);
      cursor: pointer; transition: all 150ms cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    .aoc-card-btn:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 48%, transparent);
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 20%, transparent),
        color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent));
      transform: translateY(-1px);
    }
    .aoc-card-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    /* ── Premium client editor modal ─────────────────────── */
    .aoc-overlay {
      position: fixed; inset: 0; z-index: 1300;
      background:
        radial-gradient(ellipse 60% 50% at 0% 0%, color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent), transparent 60%),
        radial-gradient(ellipse 60% 50% at 100% 100%, color-mix(in srgb, var(--g-primary, #fbbf24) 5%, transparent), transparent 60%),
        color-mix(in srgb, #000 72%, transparent);
      backdrop-filter: blur(18px) saturate(140%);
      display: grid; place-items: center; padding: 32px 16px;
      animation: aocModalFade 160ms ease-out;
    }
    .aoc-modal {
      width: min(760px, 100%); max-height: 90vh;
      display: flex; flex-direction: column;
      border-radius: 18px; overflow: hidden; position: relative;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--g-primary, #fbbf24) 6%, transparent), transparent 65%),
        linear-gradient(180deg, color-mix(in srgb, #0a0a0a 96%, transparent), color-mix(in srgb, #0a0a0a 86%, transparent));
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 32%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent), 0 36px 80px rgba(0,0,0,0.65);
      backdrop-filter: blur(22px) saturate(180%);
      animation: aocModalRise 240ms cubic-bezier(0.2, 0.8, 0.25, 1);
    }
    .aoc-modal::before {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(ellipse 60% 40% at 0% 0%, color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent), transparent 65%);
    }
    .aoc-close {
      position: absolute; top: 14px; right: 14px; width: 30px; height: 30px;
      border-radius: 8px; border: 1px solid color-mix(in srgb, #fff 10%, transparent);
      background: transparent; color: rgba(255,255,255,0.55);
      display: grid; place-items: center; cursor: pointer; font: 600 16px sans-serif;
      transition: all 140ms; z-index: 2;
    }
    .aoc-close:hover { background: color-mix(in srgb, #fff 6%, transparent); color: #fff; }
    .aoc-head {
      position: relative; z-index: 1;
      display: flex; align-items: flex-start; gap: 14px;
      padding: 22px 56px 16px 24px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
    }
    .aoc-head-avatar {
      width: 48px; height: 48px; border-radius: 14px; flex-shrink: 0;
      display: grid; place-items: center; font: 800 16px 'Inter', sans-serif; color: #0a0a0e;
      background: var(--g-gradient-accent, var(--g-primary, #fbbf24));
      border: 1px solid color-mix(in srgb, #fff 18%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent), 0 8px 18px rgba(0,0,0,0.4);
    }
    .aoc-head-ident { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .aoc-eyebrow {
      font: 700 9.5px 'JetBrains Mono', monospace; letter-spacing: 0.22em; text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary, #fbbf24) 82%, #fff);
      display: inline-flex; align-items: center; gap: 8px;
    }
    .aoc-eyebrow::before {
      content: ""; width: 6px; height: 6px; border-radius: 50%;
      background: var(--g-primary, #fbbf24);
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
    }
    .aoc-title { font: 700 22px/1.2 -apple-system, 'Inter', sans-serif; letter-spacing: -0.012em; color: #f5f5f4; margin: 0; }
    .aoc-sub { font: 400 12.5px/1.55 -apple-system, 'Inter', sans-serif; color: rgba(255,255,255,0.55); max-width: 58ch; margin: 0; }
    .aoc-head .aops-chip { align-self: flex-start; flex-shrink: 0; }

    .aoc-body {
      position: relative; z-index: 1; flex: 1; overflow-y: auto;
      padding: 18px 24px 22px; display: flex; flex-direction: column; gap: 14px;
    }
    .aoc-body::-webkit-scrollbar { width: 6px; }
    .aoc-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--g-primary, #fbbf24) 26%, transparent); border-radius: 999px; }

    .aoc-section {
      padding: 14px 16px; border-radius: 12px;
      background: color-mix(in srgb, #000 28%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 4%, transparent);
    }
    .aoc-section-head {
      font: 700 10px 'JetBrains Mono', monospace; letter-spacing: 0.2em; text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary, #fbbf24) 78%, #fff);
      margin-bottom: 10px; display: flex; align-items: center; gap: 8px;
    }
    .aoc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .aoc-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .aoc-field-wide { grid-column: 1 / -1; }
    .aoc-label {
      font: 600 10px 'JetBrains Mono', monospace; letter-spacing: 0.1em; text-transform: uppercase;
      color: rgba(255,255,255,0.55); display: flex; align-items: center; gap: 6px;
    }
    .aoc-label .req { color: var(--g-primary, #fbbf24); font-size: 11px; }
    .aoc-input, .aoc-textarea, .aoc-select {
      width: 100%; padding: 10px 12px; border-radius: 10px;
      background: color-mix(in srgb, #000 36%, transparent);
      border: 1px solid color-mix(in srgb, #fff 8%, transparent);
      color: #f5f5f4; font: 500 13px -apple-system, 'Inter', sans-serif;
      outline: none; box-sizing: border-box; transition: all 160ms ease;
    }
    .aoc-textarea { min-height: 90px; resize: vertical; line-height: 1.55; font-size: 12.5px; }
    .aoc-select {
      appearance: none; -webkit-appearance: none; padding-right: 30px; cursor: pointer;
      background:
        color-mix(in srgb, #000 36%, transparent)
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.4' stroke-linecap='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")
        no-repeat right 10px center;
    }
    .aoc-input:hover, .aoc-textarea:hover, .aoc-select:hover {
      border-color: color-mix(in srgb, #fff 14%, transparent);
      background-color: color-mix(in srgb, #000 28%, transparent);
    }
    .aoc-input:focus, .aoc-textarea:focus, .aoc-select:focus {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent);
      background-color: color-mix(in srgb, #000 50%, transparent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
    }
    .aoc-input::placeholder, .aoc-textarea::placeholder { color: rgba(255,255,255,0.32); }
    .aoc-static {
      padding: 10px 12px; border-radius: 10px;
      background: color-mix(in srgb, #000 22%, transparent);
      border: 1px dashed color-mix(in srgb, #fff 8%, transparent);
      color: rgba(255,255,255,0.72); font: 600 12.5px 'Inter', sans-serif;
    }

    .aoc-social-divider { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
    .aoc-social-divider-line { flex: 1; height: 1px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent), transparent); }
    .aoc-social-divider-label {
      font: 700 9px 'JetBrains Mono', monospace; color: color-mix(in srgb, var(--g-primary, #fbbf24) 75%, #fff);
      letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap;
    }
    .aoc-socials-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aoc-social-field { display: flex; flex-direction: column; gap: 5px; }
    .aoc-social-label {
      display: flex; align-items: center; gap: 6px;
      font: 600 10.5px 'Inter', sans-serif; color: rgba(255,255,255,0.55);
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    .aoc-social-label svg { width: 16px; height: 16px; flex-shrink: 0; }
    .aoc-social-input {
      width: 100%; padding: 8px 10px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04);
      color: #f5f5f4; font: 500 12px 'JetBrains Mono', monospace; outline: none;
      transition: border-color 150ms, background 150ms; box-sizing: border-box;
    }
    .aoc-social-input:focus {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 5%, transparent);
    }

    .aoc-foot {
      position: relative; z-index: 1;
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 14px 22px 18px;
      border-top: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
      background: color-mix(in srgb, #000 26%, transparent);
    }
    .aoc-foot-status { font: 500 11.5px 'Inter', sans-serif; color: rgba(255,255,255,0.5); }
    .aoc-foot-actions { display: flex; gap: 8px; }
    .aoc-btn {
      padding: 9px 18px; border-radius: 10px;
      font: 600 10.5px 'JetBrains Mono', monospace; text-transform: uppercase; letter-spacing: 0.12em;
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent),
        color-mix(in srgb, var(--g-primary, #fbbf24) 5%, transparent));
      color: var(--g-primary, #fbbf24); cursor: pointer;
      transition: all 160ms cubic-bezier(0.2, 0.9, 0.3, 1);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
    }
    .aoc-btn:hover:not(:disabled) {
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent),
        color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent));
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
      transform: translateY(-1px);
    }
    .aoc-btn.primary {
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent),
        color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent));
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent);
    }
    .aoc-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    @media (max-width: 640px) {
      .aoc-grid-cards { grid-template-columns: 1fr; }
      .aoc-socials-grid { grid-template-columns: 1fr; }
      .aoc-head { flex-wrap: wrap; }
    }

    /* ── Client kanban (finance section) ──────────────────── */
    .aops-client-kanban {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--ao-gap);
      margin-top: var(--ao-gap);
    }
    @media (max-width: 1080px) {
      .aops-client-kanban {
        grid-template-columns: 1fr;
      }
    }
    .aops-client-col {
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 10px;
      padding: 14px;
      min-height: 220px;
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius-lg);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .aops-client-col.droppable {
      border-style: dashed;
      border-color: color-mix(in srgb, var(--g-primary, #d4af37) 45%, var(--ao-line-soft));
    }
    .aops-client-col > header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .aops-client-col > header > div {
      display: grid;
      gap: 4px;
    }
    .aops-client-col > header small {
      font-size: 10px;
      color: var(--ao-dim);
    }
    .aops-client-col .aops-count {
      font-size: 12px;
      font-weight: 800;
      color: var(--ao-dim);
      background: var(--ao-glass);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-pill);
      padding: 2px 9px;
    }
    .aops-client-col-body {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .aops-client-kcard {
      display: grid;
      gap: 9px;
      padding: 12px;
      cursor: grab;
      border-radius: var(--ao-radius);
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
      transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease,
        opacity 0.15s ease;
    }
    .aops-client-kcard:hover {
      transform: translateY(-2px);
      border-color: var(--ao-line);
      box-shadow: var(--ao-elev), var(--ao-hairline-strong);
    }
    .aops-client-kcard.dragging {
      opacity: 0.45;
      cursor: grabbing;
    }
    .aops-client-kcard .aops-client-metrics.rich {
      padding: 8px 0;
    }
    .aops-client-kcard .aops-client-ledger.compact small {
      font-size: 11px;
      color: var(--ao-dim);
    }
    .aops-board-empty {
      display: grid;
      place-items: center;
      min-height: 80px;
      border: 1px dashed var(--ao-line-soft);
      border-radius: var(--ao-radius);
      color: var(--ao-dim);
      font-size: 12px;
    }

    /* ── Premium client kanban (parity with /clients .crm-kanban) ── */
    .aops-crm-kanban {
      display: flex;
      gap: 14px;
      overflow-x: auto;
      padding: 4px 2px 12px;
      margin-top: var(--ao-gap);
    }
    .aops-crm-kanban::-webkit-scrollbar { height: 7px; }
    .aops-crm-kanban::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary) 22%, transparent);
      border-radius: 999px;
    }
    .aops-crm-kanban .crm-kanban-col {
      flex: 0 0 288px;
      display: flex;
      flex-direction: column;
      max-height: 620px;
      border-radius: 14px;
      overflow: hidden;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 5%, transparent), transparent 35%),
        linear-gradient(180deg, color-mix(in srgb, #fff 2%, transparent), color-mix(in srgb, #000 36%, transparent));
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent), 0 12px 28px rgba(0, 0, 0, 0.32);
      backdrop-filter: blur(14px) saturate(150%);
      transition: border-color 180ms ease, box-shadow 220ms ease;
    }
    .aops-crm-kanban .crm-kanban-header {
      padding: 12px 14px;
      font: 700 10.5px "JetBrains Mono", monospace;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    }
    .aops-crm-kanban .crm-kanban-count {
      font: 700 9px "JetBrains Mono", monospace;
      color: color-mix(in srgb, var(--g-primary) 70%, #fff);
      padding: 3px 9px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    }
    .aops-crm-kanban .crm-kanban-cards {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 90px;
    }
    .aops-crm-kanban .crm-kanban-cards::-webkit-scrollbar { width: 5px; }
    .aops-crm-kanban .crm-kanban-cards::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary) 22%, transparent);
      border-radius: 999px;
    }
    .aops-crm-kanban .crm-kanban-card {
      padding: 12px 13px;
      border-radius: 12px;
      cursor: grab;
      display: grid;
      gap: 8px;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 6%, transparent), transparent 60%),
        color-mix(in srgb, #000 28%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 6px 16px rgba(0, 0, 0, 0.28);
      transition: transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1), border-color 180ms ease,
        box-shadow 180ms ease, opacity 150ms ease;
      backdrop-filter: blur(6px);
    }
    .aops-crm-kanban .crm-kanban-card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in srgb, var(--g-primary) 38%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
        0 14px 30px rgba(0, 0, 0, 0.4), 0 0 20px color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    .aops-crm-kanban .crm-kanban-card.dragging {
      opacity: 0.5;
      cursor: grabbing;
      transform: rotate(-1.5deg) scale(0.98);
      border: 1px dashed color-mix(in srgb, var(--g-primary) 55%, transparent);
      box-shadow: 0 22px 44px rgba(0, 0, 0, 0.55), 0 0 32px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }
    .aops-crm-kanban .crm-kanban-card-name {
      font: 700 13px/1.25 "Inter", -apple-system, sans-serif;
      color: #f5f5f4;
    }
    .aops-crm-kanban .crm-kanban-card-company {
      font: 500 11px "Inter", sans-serif;
      color: rgba(255, 255, 255, 0.5);
    }
    .aops-crm-kanban .aops-kcard-head {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .aops-crm-kanban .crm-kanban-col.drag-over {
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent), 0 18px 40px rgba(0, 0, 0, 0.42),
        0 0 0 1px color-mix(in srgb, var(--g-primary) 28%, transparent),
        0 0 40px color-mix(in srgb, var(--g-primary) 22%, transparent);
    }
    .aops-crm-kanban .crm-kanban-drop-zone {
      min-height: 44px;
      margin-top: 2px;
      display: none;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 22%, transparent);
      color: rgba(255, 255, 255, 0.4);
      font: 700 9.5px "JetBrains Mono", monospace;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    }
    .aops-crm-kanban .crm-kanban-col.drag-over .crm-kanban-drop-zone {
      display: flex;
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }

    /* ── Client profile (full-page detail surface) ── */
    .aops-profile {
      display: grid;
      gap: var(--ao-gap);
    }
    .aops-profile-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .aops-profile-actions { display: flex; gap: 8px; }
    .aops-profile-hero {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 22px;
      border-radius: var(--ao-radius-lg);
      border: 1px solid var(--ao-line);
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 10%, transparent), transparent 55%),
        var(--ao-glass-inner);
      box-shadow: var(--ao-elev), var(--ao-hairline);
    }
    .aops-profile-avatar {
      width: 64px;
      height: 64px;
      flex: 0 0 64px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      font: 800 22px "Inter", sans-serif;
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 34%, transparent);
    }
    .aops-profile-ident { flex: 1; min-width: 0; display: grid; gap: 8px; }
    .aops-profile-ident h1 { margin: 0; font-size: 24px; letter-spacing: -0.01em; }
    .aops-profile-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      color: var(--ao-dim);
      font-size: 12px;
    }
    .aops-profile-stats {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
    }
    .aops-profile-stats > div { display: grid; gap: 2px; text-align: right; }
    .aops-profile-stats b { font-size: 18px; color: #f5f5f4; }
    .aops-profile-stats small { font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ao-dim); }
    .aops-profile-stats > div.warn b { color: var(--ao-danger, #e0533d); }
    .aops-profile-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--ao-gap);
    }
    @media (max-width: 1000px) { .aops-profile-grid { grid-template-columns: 1fr; } }
    .aops-profile-card {
      padding: 18px;
      border-radius: var(--ao-radius-lg);
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
      display: grid;
      gap: 12px;
      align-content: start;
    }
    .aops-profile-card h3 {
      margin: 0;
      font: 700 11px "JetBrains Mono", monospace;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: color-mix(in srgb, var(--g-primary) 75%, #fff);
    }
    .aops-profile-hint { margin: 0; font-size: 12px; color: var(--ao-dim); }
    .aops-profile-empty { margin: 0; font-size: 12px; color: var(--ao-dim); padding: 8px 0; }
    .aops-profile-list, .aops-profile-notes-list, .aops-profile-timeline {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .aops-profile-list li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 11px;
      border-radius: 10px;
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass);
    }
    .aops-profile-list li.overdue { border-color: color-mix(in srgb, var(--ao-danger, #e0533d) 45%, transparent); }
    .aops-profile-list-main { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .aops-profile-list-main strong { font-size: 13px; color: #f5f5f4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .aops-profile-list-main small { font-size: 10.5px; color: var(--ao-dim); }
    .aops-profile-when { font: 600 11px "JetBrains Mono", monospace; color: var(--ao-dim); white-space: nowrap; }
    .aops-profile-when.warn { color: var(--ao-danger, #e0533d); }
    .aops-profile-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; background: var(--g-primary); }
    .aops-profile-dot.task { background: color-mix(in srgb, var(--g-primary) 55%, #6b7280); }
    .aops-profile-dot.project { background: var(--g-primary); }
    .aops-profile-note-add { display: grid; gap: 8px; }
    .aops-profile-note-input, .aops-profile-agent-input {
      width: 100%;
      min-height: 70px;
      resize: vertical;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--ao-line-soft);
      background: color-mix(in srgb, #000 30%, transparent);
      color: #f5f5f4;
      font: 400 13px "Inter", sans-serif;
    }
    .aops-profile-note-input:focus, .aops-profile-agent-input:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    }
    .aops-profile-notes-list li {
      padding: 11px 12px;
      border-radius: 10px;
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass);
      display: grid;
      gap: 5px;
    }
    .aops-profile-note-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .aops-profile-note-head strong { font-size: 12.5px; color: #f5f5f4; }
    .aops-profile-note-head small { font-size: 10px; color: var(--ao-dim); }
    .aops-profile-notes-list li p { margin: 0; font-size: 12.5px; color: rgba(255,255,255,0.72); white-space: pre-wrap; }
    .aops-profile-timeline li {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 4px;
      border-bottom: 1px solid var(--ao-line-soft);
    }
    .aops-profile-tl-icon { font-size: 15px; line-height: 1.2; }
    .aops-profile-tl-main { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .aops-profile-tl-main strong { font-size: 12.5px; color: #f5f5f4; }
    .aops-profile-tl-main small { font-size: 10.5px; color: var(--ao-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .aops-profile-tl-when { font: 600 10.5px "JetBrains Mono", monospace; color: var(--ao-dim); white-space: nowrap; }
    .aops-profile-agent {
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent), transparent 60%),
        var(--ao-glass-inner);
    }
    .aops-profile-agent-row { display: flex; gap: 10px; align-items: flex-end; }
    .aops-profile-agent-row .aops-profile-agent-input { flex: 1; }
    .aops-profile-kanban-wrap { display: grid; gap: 10px; }
    .aops-profile-kanban .crm-kanban-col { flex: 0 0 236px; max-height: 480px; }

    /* ── Projects ─────────────────────────────────────────── */
    .aops-project-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: var(--ao-gap);
    }
    .aops-project-grid > * {
      min-width: 0;
    }
    .aops-project-card {
      display: grid;
      gap: var(--ao-gap-sm);
      min-width: 0;
      padding: var(--ao-pad);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-elev-sm), var(--ao-hairline);
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .aops-project-card:hover {
      border-color: var(--ao-line);
      box-shadow: var(--ao-elev), var(--ao-hairline-strong);
    }
    .aops-project-card > .aops-row:first-child > div,
    .aops-project-tasks .aops-row > div {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .aops-project-card strong {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aops-project-tasks {
      display: grid;
      gap: 9px;
      padding-top: 10px;
      border-top: 1px solid var(--ao-line-soft);
    }
    .aops-settings-card .aops-row {
      gap: 12px;
    }

    /* ── Misc surfaces ────────────────────────────────────── */
    .aops-member-count {
      display: grid;
      margin: 22px 0;
    }
    .aops-member-count strong {
      font-size: 30px;
      letter-spacing: -0.02em;
    }
    .aops-member-count span {
      font-size: 10px;
    }
    .aops-health {
      display: inline-flex;
      align-items: center;
      flex: none;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border: 1px solid var(--g-neutral-border, color-mix(in srgb, var(--g-neutral, #94a3b8) 40%, transparent));
      background: var(--g-neutral-soft, transparent);
      color: var(--g-neutral, #94a3b8);
      padding: 4px 11px;
      border-radius: var(--ao-pill);
      white-space: nowrap;
    }
    .aops-health.good {
      color: var(--g-success, #22c55e);
      border-color: var(--g-success-border, color-mix(in srgb, var(--g-success, #22c55e) 40%, transparent));
      background: var(--g-success-soft, transparent);
    }
    .aops-migration-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: var(--ao-gap-sm);
    }
    .aops-migration-stats div {
      padding: 14px;
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      box-shadow: var(--ao-hairline);
      min-width: 0;
    }
    .aops-migration-stats strong,
    .aops-migration-stats span {
      display: block;
    }
    .aops-migration-stats strong {
      font-size: 18px;
    }
    .aops-migration-stats span {
      font-size: 10px;
      margin-top: 4px;
    }
    .aops-token-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 11px;
    }
    .aops-token-list span {
      font-size: 9px;
      letter-spacing: 0.04em;
      border: 1px solid var(--ao-line-soft);
      background: var(--g-surface, rgba(255, 255, 255, 0.05));
      padding: 4px 9px;
      border-radius: var(--ao-pill);
    }
    .aops-score-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: var(--ao-gap);
    }
    .aops-score-grid div {
      background: var(--ao-glass-inner);
      border: 1px solid var(--ao-line-soft);
      padding: 11px;
      border-radius: var(--ao-radius-sm);
      box-shadow: var(--ao-hairline);
      min-width: 0;
    }
    .aops-score-grid strong,
    .aops-score-grid span {
      display: block;
    }
    .aops-score-grid span {
      font-size: 9px;
      margin-top: 3px;
    }
    .aops-assignment-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 12px;
      border-top: 1px solid var(--ao-line-soft);
      margin-top: 24px;
      padding-top: 20px;
    }
    .aops-assignment-head h3 {
      margin: 4px 0;
      font-size: 16px;
    }
    .aops-assignment-list {
      display: grid;
      gap: var(--ao-gap-sm);
      margin-top: 12px;
    }
    .aops-assignment-list > article {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 14px;
      border: 1px solid var(--ao-line-soft);
      border-radius: var(--ao-radius);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-hairline);
      padding: 14px 15px;
      min-width: 0;
    }
    .aops-assignment-list > article > div {
      min-width: 0;
    }
    .aops-assignment-list article small {
      display: block;
      margin-top: 5px;
    }
    .aops-assignment-list article p {
      margin: 8px 0 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--ao-dim);
      overflow-wrap: anywhere;
    }
    .aops-hybrid-plan {
      grid-column: 1/-1;
      display: grid;
      gap: 5px;
      background: var(--g-accent-soft, color-mix(in srgb, var(--g-accent, #a855f7) 8%, transparent));
      border: 1px solid var(--g-accent-muted, color-mix(in srgb, var(--g-accent, #a855f7) 28%, transparent));
      border-radius: var(--ao-radius-sm);
      padding: 11px 12px;
    }
    .aops-hybrid-plan span {
      font-size: 10px;
    }
    .aops-audit-list {
      display: grid;
      max-width: 900px;
    }
    .aops-audit-list article {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr);
      gap: 12px;
      padding: 13px 0;
      border-bottom: 1px solid var(--ao-line-soft);
    }
    .aops-audit-mark {
      width: 8px;
      height: 8px;
      margin-top: 5px;
      background: var(--g-primary, #8b5cf6);
      border-radius: var(--ao-pill);
      box-shadow: 0 0 0 4px var(--g-primary-soft, transparent);
    }
    .aops-audit-list time {
      font-size: 10px;
      color: var(--ao-dim);
    }
    .aops-audit-list span,
    .aops-audit-list small {
      display: block;
      font-size: 10px;
      margin-top: 4px;
      overflow-wrap: anywhere;
    }
    .aops-member-list {
      display: grid;
      gap: 2px;
    }
    .aops-member-list > div {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-top: 1px solid var(--ao-line-soft);
      padding: 10px 0;
    }
    .aops-member-list > div > span:first-child {
      display: grid;
      min-width: 0;
    }
    .aops-member-list small {
      font-size: 9px;
    }
    .aops-member-list select {
      margin-left: auto;
      border-radius: var(--ao-radius-sm);
      padding: 6px 9px;
    }

    /* ── Employee memory, replication, retention, migration ── */
    .aops-memory-list,
    .aops-memory-group,
    .aops-conflict-list,
    .aops-migration-controls,
    .aops-suitability {
      display: grid;
      gap: var(--ao-gap-sm);
      margin-top: var(--ao-gap-sm);
    }
    .aops-memory-entry,
    .aops-suitability-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      padding: 11px 13px;
      border-radius: var(--ao-radius);
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-hairline);
    }
    .aops-suitability-row {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .aops-memory-entry code,
    .aops-conflict-diff code {
      display: block;
      margin-top: 5px;
      font-size: 11px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--ao-dim);
    }
    .aops-memory-entry small,
    .aops-suitability-row small {
      display: block;
      margin-top: 4px;
    }
    .aops-conflict {
      padding: 12px 14px;
      border-radius: var(--ao-radius);
      border: 1px solid var(--ao-line-soft);
      background: var(--ao-glass-inner);
      box-shadow: var(--ao-hairline);
    }
    .aops-conflict summary {
      cursor: pointer;
      margin-top: 7px;
      font-size: 12px;
      color: var(--ao-dim);
    }
    .aops-conflict-diff {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      margin-top: var(--ao-gap-sm);
      max-height: 220px;
      overflow: auto;
    }
    .aops-retention-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
      gap: 12px;
      align-items: end;
      margin-top: var(--ao-gap-sm);
    }
    /* A file input styled as a button: the input stays in the accessibility
       tree and keyboard-focusable, only visually collapsed onto its label. */
    .aops-file-btn {
      position: relative;
      overflow: hidden;
      display: inline-flex;
      align-items: center;
    }
    .aops-file-btn input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }

    /* ── Responsive ───────────────────────────────────────── */
    @media (max-width: 1200px) {
      .aops-directory.with-detail {
        grid-template-columns: minmax(0, 1fr) 280px;
      }
    }
    @media (max-width: 900px) {
      .aops-grid {
        grid-template-columns: 1fr;
      }
      .aops-pipeline,
      .aops-roster-card {
        grid-column: auto;
      }
      .aops-head {
        align-items: flex-start;
        flex-direction: column;
      }
      .aops-directory.with-detail {
        grid-template-columns: 1fr;
      }
      .aops-settings-grid {
        grid-template-columns: 1fr;
      }
      .aops-migration-card {
        grid-column: auto;
      }
    }
    @media (max-width: 650px) {
      .aops-allocation-list article {
        grid-template-columns: 40px minmax(0, 1fr);
      }
      .aops-allocation-value,
      .aops-allocation-list article > label {
        grid-column: 2;
      }
    }
    @media (max-width: 560px) {
      .aops {
        padding: 16px 14px 28px;
      }
      .aops-tools {
        flex-wrap: wrap;
      }
      .aops-roster {
        grid-template-columns: 1fr;
      }
      .aops-employee {
        grid-template-columns: 40px minmax(0, 1fr);
      }
      .aops-employee-side {
        grid-column: 2;
        justify-items: start;
      }
      .aops-surface {
        padding: var(--ao-pad-sm);
      }
      .aops-surface-head {
        align-items: flex-start;
        flex-direction: column;
      }
      .aops-board {
        grid-template-columns: 1fr;
      }
      .aops-conflict-diff,
      .aops-retention-row {
        grid-template-columns: 1fr;
      }
      .aops-dialog {
        padding: 18px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .aops-overlay,
      .aops-dialog {
        animation: none;
      }
      .aops-kpi,
      .aops-client-card,
      .aops-board-card,
      .aops-btn {
        transition: none;
      }
      .aops-kpi:hover,
      .aops-client-card:hover,
      .aops-board-card:hover,
      .aops-btn:hover:not(:disabled) {
        transform: none;
      }
    }
  </style>
`;

export function renderAgencyOperations(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): TemplateResult {
  const state = host.agencyOperationsState;
  if (!state) {
    queueMicrotask(() => void loadAgencyOperations(host, client));
    return html`${styles}<main class="aops ba-glass">${baAurora()}<div class="aops-loading">Loading agency operations…</div></main>`;
  }
  const currency = state.finance.currency;
  const selectedAgency = state.agencies.find((agency) => agency.id === state.selectedAgencyId);
  const ownedAgencies = state.agencies.filter((agency) => agency.role === "owner");
  const sharedAgencies = state.agencies.filter((agency) => agency.role !== "owner");
  const filteredEmployees = state.employees.filter(
    (employee) => state.employeeFilter === "all" || employee.kind === state.employeeFilter,
  );
  if (state.activeSection !== "overview") {
    return renderDedicatedSurface(host, state, client);
  }

  return html`
    ${styles}
    ${invoicingStyles}
    <main class="aops ba-glass">
      ${baAurora()}
      <header class="aops-head">
        <div><h1>Agency Operations Center</h1><div class="aops-sub">Revenue, delivery, decisions and workforce in one operating rhythm.</div></div>
        <div class="aops-tools">
          <button class="aops-btn ghost" @click=${() => openAgencyOpsDialog(host, "deal")}>+ Opportunity</button>
          <button class="aops-btn ghost" @click=${() => openAgencyOpsDialog(host, "engagement")}>+ Engagement</button>
          <button class="aops-btn ghost" @click=${() => openAgencyOpsDialog(host, "employee")}>+ Employee</button>
          <button class="aops-btn primary" ?disabled=${state.refreshing} @click=${() => void loadAgencyOperations(host, client, { background: true })}>${state.refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>
      ${renderReplicationHealth(host, state, client)}
      <section class="aops-agencybar">
        <label for="aops-agency-switcher">Current agency</label>
        <select
          id="aops-agency-switcher"
          class="aops-agency-select"
          .value=${state.selectedAgencyId ?? ""}
          @change=${(event: Event) =>
            void switchAgencyOperationsAgency(
              host,
              client,
              (event.target as HTMLSelectElement).value,
            )}
        >
          ${
            ownedAgencies.length
              ? html`<optgroup label="Owned by me">${ownedAgencies.map((agency) => html`<option value=${agency.id}>${agency.name}</option>`)}</optgroup>`
              : nothing
          }
          ${
            sharedAgencies.length
              ? html`<optgroup label="Shared with me">${sharedAgencies.map((agency) => html`<option value=${agency.id}>${agency.name}</option>`)}</optgroup>`
              : nothing
          }
          ${
            state.agencies.length === 0
              ? html`
                  <option value="">No agencies yet</option>
                `
              : nothing
          }
        </select>
        ${selectedAgency ? html`<span class="aops-role">${selectedAgency.role}</span><small>${selectedAgency.role === "owner" ? "Owned by you" : `Owned by ${selectedAgency.ownerName ?? "another operator"}`}</small>` : nothing}
        <span class="aops-agency-spacer"></span>
        ${
          selectedAgency && (selectedAgency.role === "owner" || selectedAgency.role === "admin")
            ? html`<button class="aops-btn ghost" @click=${() => openAgencyOpsDialog(host, "share")}>Share</button>`
            : nothing
        }
        <button class="aops-btn primary" @click=${() => openAgencyOpsDialog(host, "agency")}>+ New agency</button>
      </section>
      ${renderSectionNavigation(host, state)}
      ${
        state.migrationReport?.sourceExists
          ? html`
            <div class="aops-alert info">
              <strong>Legacy business data secured in Agency OS.</strong>
              <span style="display:block;margin-top:5px">
                ${state.migrationReport.businessesFound} businesses,
                ${state.migrationReport.clientsImported} clients,
                ${state.migrationReport.projectsImported} projects and
                ${state.migrationReport.tasksImported} tasks synchronized.
              </span>
              ${
                state.migrationReport.projectsQuarantined ||
                state.migrationReport.databaseRowsQuarantined
                  ? html`<small style="display:block;margin-top:4px">
                    ${state.migrationReport.projectsQuarantined} unassigned projects and
                    ${state.migrationReport.databaseRowsQuarantined} database rows were moved to Legacy Unassigned.
                  </small>`
                  : nothing
              }
              ${
                state.migrationReport.warnings.length
                  ? html`<small style=${`display:block;margin-top:4px;color:${TONE.warning}`}>
                    ${state.migrationReport.warnings.join(" ")}
                  </small>`
                  : nothing
              }
            </div>
          `
          : nothing
      }
      ${
        state.lastShareLink
          ? html`
            <div class="aops-alert good">
              <strong>Private collaboration link ready.</strong>
              <span style="display:block;word-break:break-all;margin:5px 0">${state.lastShareLink}</span>
              <small>${state.collaborationStatus ?? "Only verified members of your Tailscale network can open it."}</small>
              <button
                class="aops-btn ghost"
                style="margin-left:10px"
                @click=${() => void navigator.clipboard?.writeText(state.lastShareLink!)}
              >Copy link</button>
            </div>
          `
          : state.collaborationStatus
            ? html`<div class="aops-alert">${state.collaborationStatus}</div>`
            : nothing
      }
      ${state.error ? html`<div class="aops-alert">${state.error}</div>` : nothing}
      <section class="aops-kpis">
        ${
          state.kpis.length
            ? state.kpis.map(
                (kpi) =>
                  html`<article class="aops-kpi"><span>${kpi.label}</span><strong>${kpi.value}</strong><small class=${`aops-trend ${kpi.tone ?? "neutral"}`}>${kpi.change === undefined ? (kpi.context ?? "") : `${kpi.change >= 0 ? "↑" : "↓"} ${Math.abs(kpi.change)}% ${kpi.context ?? ""}`}</small></article>`,
              )
            : html`
              <article class="aops-kpi"><span>Active engagements</span><strong>${state.engagements.length}</strong><small>Live client work</small></article>
              <article class="aops-kpi"><span>Cash collected</span><strong>${money(
                state.finance.cashCollectedMonth,
                currency,
              )}</strong><small>Payments received</small></article>
              <article class="aops-kpi"><span>Pending decisions</span><strong>${state.approvals.length}</strong><small>Human approval required</small></article>
              <article class="aops-kpi"><span>Gross margin</span><strong>${state.finance.grossMarginPercent}%</strong><small>Current month</small></article>
              <article class="aops-kpi"><span>Team utilization</span><strong>${state.employees.length ? Math.round(state.employees.reduce((sum, employee) => sum + employee.utilizationPercent, 0) / state.employees.length) : 0}%</strong><small>Human + AI workforce</small></article>
            `
        }
      </section>
      <div class="aops-grid">
        <section class="aops-card aops-active-card">
          <header><h2>Active projects</h2><span class="aops-count">${state.kanbanProjects.filter((project) => !project.archived && KANBAN_ACTIVE_STATUSES.has(String(project.status ?? ""))).length} in progress</span></header>
          ${renderActiveProjects(host, state, client)}
        </section>
        <section class="aops-card aops-finance-card">
          <header>
            <h2>Financial command</h2>
            <span class="aops-count">This month</span>
          </header>
          <div class="aops-fin-actions">
            <button class="aops-btn primary" @click=${() => openInvoiceComposer(host)}>+ Create invoice</button>
            <button class="aops-btn ghost" @click=${() => openInvoiceComposer(host, { backdated: true })}>Log money</button>
            <button class="aops-btn ghost" @click=${() => setAgencyOperationsSection(host, "finance")}>Revenue snapshot</button>
          </div>
          <div class="aops-fin-highlight">
            <div class="aops-fin-hi"><span>Revenue (mo)</span><strong>${money(state.finance.revenueMonth, currency)}</strong></div>
            <div class="aops-fin-hi"><span>Cash collected</span><strong>${money(state.finance.cashCollectedMonth, currency)}</strong></div>
            <div class="aops-fin-hi ${state.finance.outstandingReceivables > 0 ? "warn" : ""}"><span>Outstanding</span><strong>${money(state.finance.outstandingReceivables, currency)}</strong></div>
            <div class="aops-fin-hi ${state.finance.overdueReceivables > 0 ? "danger" : ""}"><span>Overdue</span><strong>${money(state.finance.overdueReceivables, currency)}</strong></div>
          </div>
          <div class="aops-finance">
            <div><span>MRR</span><strong>${money(state.finance.mrr, currency)}</strong></div>
            <div><span>ARR</span><strong>${money(state.finance.arr, currency)}</strong></div>
            <div><span>Target</span><strong>${money(state.finance.revenueTarget, currency)}</strong></div>
            <div><span>Backlog</span><strong>${money(state.finance.contractedBacklog, currency)}</strong></div>
            <div><span>Gross margin</span><strong>${state.finance.grossMarginPercent}%</strong></div>
            <div><span>Payroll</span><strong>${money(state.finance.payrollMonth, currency)}</strong></div>
            <div><span>AI spend</span><strong>${money(state.finance.aiSpendMonth, currency)}</strong></div>
            <div><span>Runway</span><strong>${state.finance.cashRunwayMonths === undefined ? "—" : `${state.finance.cashRunwayMonths} mo`}</strong></div>
          </div>
        </section>
        <section class="aops-card aops-pipeline">
          <header><h2>Revenue pipeline</h2><span class="aops-count">One shared source</span></header>
          ${renderHubLink(host, {
            section: "pipeline",
            title: "Pipeline lives in Business hub",
            text: `${state.pipelineDeals.length} opportunities are managed in the canonical pipeline — no second board or duplicate store here.`,
            cta: "Open pipeline",
          })}
          ${renderHubLink(host, {
            section: "revenue",
            title: "Revenue analytics lives in Business hub",
            text: "Use the shared ledger for transactions, source attribution and customer revenue. Agency invoicing stays here.",
            cta: "Open revenue",
          })}
        </section>
        <section class="aops-card aops-roster-card">
          <header>
            <h2>Employee roster & capacity</h2>
            <div class="aops-filters">${(["all", "human", "ai"] as const).map((filter) => html`<button class=${state.employeeFilter === filter ? "active" : ""} @click=${() => setAgencyEmployeeFilter(host, filter)}>${filter === "all" ? "All" : filter === "ai" ? "AI employees" : "Humans"}</button>`)}</div>
          </header>
          <div class="aops-roster">${filteredEmployees.length ? filteredEmployees.map((employee) => renderEmployee(employee, host, state, client)) : empty("No employees match this filter.")}</div>
        </section>
        <section class="aops-card">
          <header><h2>Decision queue</h2><span class="aops-count">${state.approvals.length + state.employeeWorkItems.filter((item) => item.status === "queued").length} pending</span></header>
          <p class="aops-section-note">Work paused for your call — client approvals and staged work items the operating loop queued but won't run until you authorize them.</p>
          <div class="aops-approvals">${renderDecisionQueue(host, state, client)}</div>
        </section>
        <section class="aops-card">
          <header><h2>Operating cadence</h2></header>
          <div class="aops-engagements">
            <article class="aops-engagement"><strong>Daily</strong><span>Clear approvals · unblock delivery · assign capacity</span></article>
            <article class="aops-engagement"><strong>Weekly</strong><span>Pipeline review · engagement health · utilization · cash collection</span></article>
            <article class="aops-engagement"><strong>Monthly</strong><span>P&L · margins by client · performance reviews · capacity plan</span></article>
          </div>
        </section>
      </div>
      ${renderInvoiceComposer(host, state, client)}
      ${renderDialog(host, state, client)}
    </main>
  `;
}
