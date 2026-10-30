/**
 * Autonomy Command — the controller behind the delivery/autonomy split board.
 *
 * The gap this closes: the agency carries 77 projects and ~2,850 real delivery
 * tasks in `agency.ops.tasks.list`, and *none* of them are assigned to anyone.
 * The AI workforce, meanwhile, only ever executes `EmployeeWorkItem`s that a
 * human hand-created. So the two halves of the business never touch.
 *
 * This controller owns the bridge. It reads the delivery side (projects and
 * tasks) and the autonomy side (work items and their execution readiness) into
 * one state, and exposes a single act — "hand this delivery work to an AI
 * employee" — which is:
 *
 *   1. `agency.ops.employee.work-item.create` — the executable unit, carrying
 *      the originating task/project in its `context` so the link is traceable.
 *   2. `agency.ops.tasks.assign` — records the owner on the delivery task, so
 *      the project board stops lying about who has it.
 *   3. optionally `...work-item.transition -> accepted` — the staging gate,
 *      which is the *only* thing that authorises autonomous execution.
 *
 * Step 3 is deliberately separate and opt-in: creating work never runs
 * anything. The same rule Daily Operations enforces, enforced here.
 *
 * A task-routing engine is being built server side. Its RPCs may or may not
 * exist on the gateway this UI is talking to, so every call into it goes
 * through `resolveMethod` capability detection and lands in the surface's
 * failure channel when absent — never a silently blank panel.
 */

import type { GatewayBrowserClient } from "../gateway";
import { contentTabOf, type Tab } from "../navigation";
import type {
  AgencyEmployee,
  AgencyProjectSummary,
  AgencyTaskSummary,
  EmployeeWorkItem,
} from "./agency-operations";
import { attempt, errorMessage, resolveAgency, unwrap } from "./agency-common";
import type { WorkItemExecutionView } from "./agency-daily";
import type { KanbanProject, KanbanTask, TaskStatus } from "../types";

// ── Full-kanban source mapping ───────────────────────────────────────────────
//
// The board reads the SAME project database the /projects page (renderKanban)
// uses — `kanban.projects.list` / `kanban.tasks.list`, the Notion-backed store
// with all ~85 projects and their tasks, parent/sub-project hierarchy and local
// status overlay. That store speaks `KanbanProject` / `KanbanTask`, so these
// mappers project it onto the `AgencyProjectSummary` / `AgencyTaskSummary` shape
// the rest of this board (columns, filters, handoff, routing) already consumes —
// nothing downstream has to know the source changed.

/** Notion project status → the five-state agency rollup used by the board. */
function mapProjectStatus(status: string | undefined): AgencyProjectSummary["status"] {
  switch (status) {
    case "In progress":
    case "Updating":
    case "Reviewing":
      return "active";
    case "Completed":
      return "completed";
    case "Cancelled":
      return "cancelled";
    case "Paused":
    case "Awaiting Client":
      return "on_hold";
    default:
      return "planned";
  }
}

/** Kanban task status → the delivery-column status the board renders against. */
function mapTaskStatus(status: TaskStatus | string | undefined): AgencyTaskSummary["status"] {
  switch (status) {
    case "todo":
      return "ready";
    case "in_progress":
      return "in_progress";
    case "review":
      return "review";
    case "done":
      return "done";
    case "backlog":
    default:
      return "backlog";
  }
}

/** Reverse of {@link mapTaskStatus} — the board status → a kanban write value. */
export function deliveryStatusToKanban(status: AgencyTaskSummary["status"]): TaskStatus {
  switch (status) {
    case "ready":
      return "todo";
    case "in_progress":
      return "in_progress";
    case "review":
      return "review";
    case "done":
      return "done";
    case "blocked":
      // The kanban store has no "blocked" column, so a blocked card writes back
      // as in_progress — the closest live state — rather than silently vanishing.
      return "in_progress";
    case "cancelled":
    case "backlog":
    default:
      return "backlog";
  }
}

function mapTaskPriority(priority: KanbanTask["priority"]): AgencyTaskSummary["priority"] {
  switch (priority) {
    case "critical":
      return "urgent";
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "normal";
  }
}

function dateToMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function mapKanbanProjectToSummary(project: KanbanProject): AgencyProjectSummary {
  return {
    id: project.id,
    clientId: project.businessId ?? null,
    name: project.name,
    status: mapProjectStatus(project.status),
    budgetCents: 0,
    targetEndAt: dateToMs(project.dueDate),
  };
}

export function mapKanbanTaskToSummary(task: KanbanTask): AgencyTaskSummary {
  // The kanban store carries either an AI agent binding (`assignedAgent`) or a
  // free-text human assignee. Prefer the agent id so the "unowned only" filter
  // and the handoff owner-badge agree with what the autonomy side understands.
  const aiOwner = task.assignedAgent ?? null;
  const humanOwner = !aiOwner && task.assignee ? task.assignee : null;
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: mapTaskStatus(task.status),
    priority: mapTaskPriority(task.priority),
    assigneeType: aiOwner ? "ai" : humanOwner ? "human" : null,
    assigneeId: aiOwner ?? humanOwner,
    dueAt: dateToMs(task.dueDate),
  };
}

export type BoardMode = "delivery" | "split" | "autonomy";

export type DeliveryStatus = AgencyTaskSummary["status"];

/** Delivery columns, left to right. `done` is last and collapsed by default. */
export const DELIVERY_COLUMNS: ReadonlyArray<{
  key: DeliveryStatus;
  label: string;
  hint: string;
}> = [
  { key: "backlog", label: "Backlog", hint: "Not scoped for work yet." },
  { key: "ready", label: "Ready", hint: "Scoped and waiting for an owner." },
  { key: "in_progress", label: "In progress", hint: "Someone or something is on it." },
  { key: "blocked", label: "Blocked", hint: "Stopped on a dependency." },
  { key: "review", label: "Review", hint: "Done pending sign-off." },
  { key: "done", label: "Done", hint: "Closed out." },
];

/** Delivery statuses that can sensibly be handed to an AI employee. */
export const HANDOFF_ELIGIBLE_STATUSES: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
]);

/**
 * Mirror of `SuitabilityResult` (`src/workforce/suitability.ts`). Duplicated
 * rather than imported because the UI bundle does not reach into `src/`.
 */
export interface EmployeeRecommendation {
  workerId: string;
  eligible: boolean;
  score: number;
  skillCoverage: number;
  availableHours: number;
  reasons: string[];
  missingSkills: string[];
  missingCapabilities: string[];
}

/**
 * One row of the routing engine's dry run. Mirrors `TaskRoutingDecision`
 * (`src/workforce/task-routing.ts`); every field is read defensively because
 * the UI must survive an older or newer gateway.
 */
export interface RoutingDecisionPreview {
  taskId: string | null;
  taskTitle: string | null;
  workerId: string | null;
  workerName: string | null;
  outcome: string | null;
  rationale: string | null;
  /** 0–1 blend of "the task was understood" and "this worker fits". */
  confidence: number | null;
  needsHuman: boolean;
  stageRecommended: boolean;
}

/** Pass counts from `TaskRoutingRunResult`. All optional on an older gateway. */
export interface RoutingCounts {
  candidates: number | null;
  assigned: number | null;
  unmatched: number | null;
  needsHuman: number | null;
  autoStaged: number | null;
  stageRecommended: number | null;
  deferred: number | null;
  writes: number | null;
}

export type RoutingStatus = "idle" | "loading" | "ready" | "unavailable" | "failed";

/**
 * The engine's dry run, which is **agency-wide** — `agency.ops.routing.preview`
 * routes every unassigned candidate task, not a caller-supplied batch. So this
 * lives on the board rather than inside one handoff, and the handoff dialog
 * simply filters it down to the tasks in front of the operator.
 */
export interface RoutingPreview {
  status: RoutingStatus;
  /** The method actually called, so the operator can see what answered. */
  method: string | null;
  decisions: RoutingDecisionPreview[];
  counts: RoutingCounts | null;
  /** Whether the engine is switched on, and its auto-stage mode. */
  enabled: boolean | null;
  mode: string | null;
  error: string | null;
  loadedAt: number | null;
}

/**
 * The pending handoff — one task or two thousand, same shape. Single-send is
 * simply a batch of one, so there is exactly one confirmation surface to keep
 * honest rather than two that can drift apart.
 */
export interface AutonomyHandoff {
  taskIds: string[];
  /** Set when the operator handed over a whole project rather than a selection. */
  projectId: string | null;
  projectName: string | null;
  workerId: string;
  priority: EmployeeWorkItem["priority"];
  /** Whether to stage immediately — the authorisation to actually execute. */
  authorizeNow: boolean;
  instructions: string;
  recommendations: EmployeeRecommendation[];
  recommendationsLoading: boolean;
  recommendationsError: string | null;
  submitting: boolean;
  /** Live batch progress, so a 200-card send is never a frozen button. */
  progress: { done: number; failed: number; total: number } | null;
  error: string | null;
}

export interface AgencyAutonomyState {
  loadGeneration: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  failedRequests: string[];
  lastLoadedAt: number | null;
  agencyId: string | null;
  agencyName: string;

  /** Delivery half. */
  projects: AgencyProjectSummary[];
  tasks: AgencyTaskSummary[];
  /**
   * Raw kanban rows, kept alongside the projected summaries so the detail modal
   * can show the full record (description, progress, tags, sub-project link)
   * without a second fetch. Keyed by id; empty when the source is not kanban.
   */
  rawTasks: Record<string, KanbanTask>;
  rawProjects: Record<string, KanbanProject>;
  /** Autonomy half. */
  employees: AgencyEmployee[];
  workItems: EmployeeWorkItem[];
  executions: Record<string, WorkItemExecutionView>;
  executorEnabled: boolean;
  /** True once the execution feed answered — tells "off" apart from "unknown". */
  executionsLoaded: boolean;

  mode: BoardMode;
  projectFilter: string;
  search: string;
  /** Hide the 1,500 closed tasks unless explicitly asked for. */
  showDone: boolean;
  /** Only show delivery work nobody owns — the actual gap, by default. */
  unassignedOnly: boolean;

  selectedTaskIds: Set<string>;
  /** Task ids currently being dragged (the whole selection, if it is selected). */
  draggingTaskIds: string[];
  dragOverAutonomy: boolean;
  /**
   * Employee drop target currently under the pointer on the Work-allocation
   * assign band, or null. Drives the drop-target highlight there; the board's
   * own column highlight stays on `dragOverAutonomy`/the daily `dragOverStage`.
   */
  dragOverEmployeeId: string | null;

  handoff: AutonomyHandoff | null;
  /** Delivery task open in the full-detail modal, or null. */
  taskDetailId: string | null;
  /** True while a quick action from the detail modal is in flight. */
  taskDetailBusy: boolean;
  /** Autonomy work item open in the full-detail modal, or null. */
  workItemDetailId: string | null;
  notice: string | null;
  liveAt: number | null;
  /** Agency-wide routing dry run. Read-only: `preview` writes nothing. */
  routing: RoutingPreview;
  /** True once the operator has armed the agency-wide apply (two-step). */
  applyArmed: boolean;
  applying: boolean;
  /** Resolved routing-engine method names, or null when this build lacks them. */
  routingMethods: {
    preview: string | null;
    apply: string | null;
    taskAssign: string | null;
    stage: string | null;
    resolved: boolean;
  };
}

export interface AgencyAutonomyHost {
  agencyAutonomyState?: AgencyAutonomyState | null;
  requestUpdate?: () => void;
  setTab?: (tab: Tab) => void;
  tab?: Tab;
  hostView?: Partial<Record<Tab, string>>;
}

/**
 * Candidate names for the routing engine, most specific first.
 *
 * A backend agent is landing these concurrently and the final spelling is not
 * settled, so the UI resolves against what the gateway actually advertises in
 * its handshake instead of hard-coding one guess.
 */
export const ROUTING_PREVIEW_METHODS = [
  "agency.ops.routing.preview",
  "agency.ops.routing.dry-run",
  "agency.ops.tasks.routing.preview",
  "agency.ops.task.routing.preview",
] as const;

export const ROUTING_APPLY_METHODS = [
  "agency.ops.routing.apply",
  "agency.ops.tasks.routing.apply",
  "agency.ops.task.routing.apply",
] as const;

/**
 * Operator override: assigns the task, enqueues the work item and PINS the
 * decision in one atomic call, so the router never silently reassigns work a
 * human ruled on. Strictly better than the create/assign pair it replaces.
 */
export const ROUTING_TASK_ASSIGN_METHODS = [
  "agency.ops.routing.task.assign",
  "agency.ops.routing.assign",
] as const;

/** Batch staging of routed cards — one call for a whole batch. */
export const ROUTING_STAGE_METHODS = [
  "agency.ops.routing.stage",
  "agency.ops.routing.tasks.stage",
] as const;

export const WORK_ITEM_EVENT = "agency.work.updated";

/** The stage that authorises execution. Mirrors `EXECUTION_STAGE` server side. */
export const AUTONOMY_STAGE = "accepted" as const;

/** Cards rendered per delivery column before the rest is summarised. */
export const DELIVERY_COLUMN_CAP = 40;

/** Hard ceiling on one batch, so a mis-click cannot enqueue two thousand runs. */
export const MAX_BATCH = 200;

export function createAgencyAutonomyState(): AgencyAutonomyState {
  return {
    loadGeneration: 0,
    loading: false,
    refreshing: false,
    error: null,
    failedRequests: [],
    lastLoadedAt: null,
    agencyId: null,
    agencyName: "",
    projects: [],
    tasks: [],
    rawTasks: {},
    rawProjects: {},
    employees: [],
    workItems: [],
    executions: {},
    executorEnabled: false,
    executionsLoaded: false,
    mode: "split",
    projectFilter: "",
    search: "",
    showDone: false,
    unassignedOnly: true,
    selectedTaskIds: new Set<string>(),
    draggingTaskIds: [],
    dragOverAutonomy: false,
    dragOverEmployeeId: null,
    handoff: null,
    taskDetailId: null,
    taskDetailBusy: false,
    workItemDetailId: null,
    notice: null,
    liveAt: null,
    routing: {
      status: "idle",
      method: null,
      decisions: [],
      counts: null,
      enabled: null,
      mode: null,
      error: null,
      loadedAt: null,
    },
    applyArmed: false,
    applying: false,
    routingMethods: {
      preview: null,
      apply: null,
      taskAssign: null,
      stage: null,
      resolved: false,
    },
  };
}

export function ensureAgencyAutonomyState(host: AgencyAutonomyHost): AgencyAutonomyState {
  if (!host.agencyAutonomyState) host.agencyAutonomyState = createAgencyAutonomyState();
  return host.agencyAutonomyState;
}

function notify(host: AgencyAutonomyHost): void {
  host.requestUpdate?.();
}

function recordFailure(state: AgencyAutonomyState, entry: string): void {
  if (!state.failedRequests.includes(entry)) {
    state.failedRequests = [...state.failedRequests, entry];
  }
}

// ── Load ───────────────────────────────────────────────────────────────────

export async function loadAgencyAutonomy(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
  options: { background?: boolean } = {},
): Promise<void> {
  const state = ensureAgencyAutonomyState(host);
  const generation = ++state.loadGeneration;
  const background = options.background === true || state.lastLoadedAt !== null;
  state.loading = !background;
  state.refreshing = background;
  state.error = null;
  notify(host);

  const failures: string[] = [];
  try {
    const { agencyId, agencyName } = await resolveAgency(client, failures);
    if (generation !== state.loadGeneration) return;
    state.agencyId = agencyId;
    state.agencyName = agencyName;
    if (!agencyId) {
      state.failedRequests = failures;
      state.lastLoadedAt = Date.now();
      return;
    }

    // Delivery half now reads the FULL projects database — the same
    // `kanban.projects.list` / `kanban.tasks.list` the /projects page uses — so
    // the board reflects every project (all ~85, parent + sub) and their tasks,
    // not the narrower agency-scoped `agency.ops.*` slice it used before. Those
    // endpoints return bare arrays (Notion-backed, with the local status
    // overlay), so they are read directly rather than through `unwrap`.
    const [projectsResult, tasksResult, employeesResult, inboxResult, executionResult] =
      await Promise.all([
        attempt(client, failures, "kanban.projects.list", {}),
        attempt(client, failures, "kanban.tasks.list", {}),
        attempt(client, failures, "agency.ops.employees.list", { agencyId, status: "active" }),
        attempt(client, failures, "agency.ops.employee.inbox.list", { agencyId, limit: 250 }),
        attempt(client, failures, "agency.ops.employee.work-item.execution.list", {
          agencyId,
          limit: 200,
        }),
      ]);
    if (generation !== state.loadGeneration || agencyId !== state.agencyId) return;

    const kanbanProjects = Array.isArray(projectsResult) ? (projectsResult as KanbanProject[]) : [];
    const kanbanTasks = Array.isArray(tasksResult) ? (tasksResult as KanbanTask[]) : [];
    if (kanbanProjects.length || projectsResult !== null) {
      state.projects = kanbanProjects.map(mapKanbanProjectToSummary);
      state.rawProjects = Object.fromEntries(kanbanProjects.map((p) => [p.id, p]));
    }
    if (kanbanTasks.length || tasksResult !== null) {
      state.tasks = kanbanTasks.map(mapKanbanTaskToSummary);
      state.rawTasks = Object.fromEntries(kanbanTasks.map((t) => [t.id, t]));
    }
    state.employees = unwrap<AgencyEmployee[]>(employeesResult, "employees", state.employees);
    state.workItems = unwrap<EmployeeWorkItem[]>(inboxResult, "workItems", state.workItems);
    if (executionResult) {
      const views = unwrap<WorkItemExecutionView[]>(executionResult, "items", []);
      const executions: Record<string, WorkItemExecutionView> = {};
      for (const view of Array.isArray(views) ? views : []) {
        if (view?.workItemId) executions[view.workItemId] = view;
      }
      state.executions = executions;
      state.executorEnabled = unwrap<boolean>(executionResult, "executorEnabled", false) === true;
      state.executionsLoaded = true;
    }

    // Capability detection for the routing engine. Recorded once per load so a
    // gateway restart that adds the engine is picked up without a page reload.
    state.routingMethods = {
      preview: client.resolveMethod(ROUTING_PREVIEW_METHODS),
      apply: client.resolveMethod(ROUTING_APPLY_METHODS),
      taskAssign: client.resolveMethod(ROUTING_TASK_ASSIGN_METHODS),
      stage: client.resolveMethod(ROUTING_STAGE_METHODS),
      resolved: client.serverMethods !== null,
    };
    void loadRoutingPreview(host, client);

    // Drop selections for tasks that no longer exist, or the batch count lies.
    if (state.selectedTaskIds.size) {
      const live = new Set(state.tasks.map((task) => task.id));
      const next = new Set<string>();
      for (const id of state.selectedTaskIds) if (live.has(id)) next.add(id);
      state.selectedTaskIds = next;
    }
    state.failedRequests = failures;
    state.lastLoadedAt = Date.now();
  } catch (error) {
    if (generation === state.loadGeneration) {
      state.error = errorMessage(error);
      state.failedRequests = failures;
    }
  } finally {
    if (generation === state.loadGeneration) {
      state.loading = false;
      state.refreshing = false;
      notify(host);
    }
  }
}

// ── Board controls ─────────────────────────────────────────────────────────

export function setBoardMode(host: AgencyAutonomyHost, mode: BoardMode): void {
  const state = ensureAgencyAutonomyState(host);
  if (state.mode === mode) return;
  state.mode = mode;
  notify(host);
}

export function setAutonomyFilter(
  host: AgencyAutonomyHost,
  patch: Partial<Pick<AgencyAutonomyState, "projectFilter" | "search" | "showDone" | "unassignedOnly">>,
): void {
  const state = ensureAgencyAutonomyState(host);
  Object.assign(state, patch);
  notify(host);
}

export function dismissAutonomyNotice(host: AgencyAutonomyHost): void {
  const state = ensureAgencyAutonomyState(host);
  if (!state.notice) return;
  state.notice = null;
  notify(host);
}

/** Tasks left after the toolbar filters, in a stable, useful order. */
export function visibleTasks(state: AgencyAutonomyState): AgencyTaskSummary[] {
  const needle = state.search.trim().toLowerCase();
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return state.tasks
    .filter((task) => {
      if (!state.showDone && (task.status === "done" || task.status === "cancelled")) return false;
      if (state.unassignedOnly && task.assigneeId) return false;
      if (state.projectFilter && task.projectId !== state.projectFilter) return false;
      if (needle && !task.title.toLowerCase().includes(needle)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) ||
        (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER) ||
        a.title.localeCompare(b.title),
    );
}

export function toggleTaskSelected(host: AgencyAutonomyHost, taskId: string): void {
  const state = ensureAgencyAutonomyState(host);
  const next = new Set(state.selectedTaskIds);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  state.selectedTaskIds = next;
  notify(host);
}

export function setTasksSelected(
  host: AgencyAutonomyHost,
  taskIds: string[],
  selected: boolean,
): void {
  const state = ensureAgencyAutonomyState(host);
  const next = new Set(state.selectedTaskIds);
  for (const id of taskIds) {
    if (selected) next.add(id);
    else next.delete(id);
  }
  state.selectedTaskIds = next;
  notify(host);
}

export function clearTaskSelection(host: AgencyAutonomyHost): void {
  const state = ensureAgencyAutonomyState(host);
  if (state.selectedTaskIds.size === 0) return;
  state.selectedTaskIds = new Set<string>();
  notify(host);
}

// ── Drag accelerators (never the only route — see `openHandoff` callers) ────

export function beginTaskDrag(host: AgencyAutonomyHost, taskId: string): string[] {
  const state = ensureAgencyAutonomyState(host);
  // Dragging a selected card drags the whole selection; dragging an unselected
  // one drags just it, which is what every file manager has taught people.
  const ids = state.selectedTaskIds.has(taskId) ? [...state.selectedTaskIds] : [taskId];
  state.draggingTaskIds = ids;
  notify(host);
  return ids;
}

export function endTaskDrag(host: AgencyAutonomyHost): void {
  const state = ensureAgencyAutonomyState(host);
  if (
    state.draggingTaskIds.length === 0 &&
    !state.dragOverAutonomy &&
    !state.dragOverEmployeeId
  )
    return;
  state.draggingTaskIds = [];
  state.dragOverAutonomy = false;
  state.dragOverEmployeeId = null;
  notify(host);
}

export function setDragOverAutonomy(host: AgencyAutonomyHost, over: boolean): void {
  const state = ensureAgencyAutonomyState(host);
  if (state.dragOverAutonomy === over) return;
  state.dragOverAutonomy = over;
  notify(host);
}

// ── Handoff ────────────────────────────────────────────────────────────────

/**
 * Ranks employees for this batch, best first.
 *
 * `agency.ops.assignment.suitability` scores capacity, skills and cost. With no
 * skill requirements attached to a legacy delivery task every active worker
 * scores identically, so open work-item load breaks the tie — otherwise the
 * "recommended" employee would just be whoever the roster listed first, which
 * is worse than no recommendation at all because it looks considered.
 */
export async function loadRecommendations(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyAutonomyState(host);
  const handoff = state.handoff;
  if (!handoff || !state.agencyId) return;
  handoff.recommendationsLoading = true;
  handoff.recommendationsError = null;
  notify(host);
  try {
    const response = await client.request("agency.ops.assignment.suitability", {
      agencyId: state.agencyId,
      estimatedHours: Math.max(1, handoff.taskIds.length),
      preferredType: "ai",
    });
    const recommendations = unwrap<EmployeeRecommendation[]>(response, "recommendations", []);
    if (state.handoff !== handoff) return;
    const load = openWorkloadByWorker(state);
    handoff.recommendations = [...(Array.isArray(recommendations) ? recommendations : [])].sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.score - a.score ||
        (load.get(a.workerId) ?? 0) - (load.get(b.workerId) ?? 0),
    );
    // Only pre-select when the operator has not already chosen someone.
    if (!handoff.workerId) {
      handoff.workerId = handoff.recommendations[0]?.workerId ?? state.employees[0]?.id ?? "";
    }
  } catch (error) {
    if (state.handoff !== handoff) return;
    handoff.recommendationsError = `Suitability unavailable — ${errorMessage(error)}`;
    recordFailure(state, `agency.ops.assignment.suitability — ${errorMessage(error)}`);
  } finally {
    if (state.handoff === handoff) {
      handoff.recommendationsLoading = false;
      notify(host);
    }
  }
}

/** Open (non-terminal) work items per worker — the tie-break for suitability. */
export function openWorkloadByWorker(state: AgencyAutonomyState): Map<string, number> {
  const load = new Map<string, number>();
  for (const item of state.workItems) {
    if (item.status === "completed" || item.status === "cancelled") continue;
    load.set(item.workerId, (load.get(item.workerId) ?? 0) + 1);
  }
  return load;
}

let handoffKeyHandler: ((event: KeyboardEvent) => void) | null = null;

function bindHandoffKeys(host: AgencyAutonomyHost): void {
  if (handoffKeyHandler) return;
  handoffKeyHandler = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeHandoff(host);
  };
  document.addEventListener("keydown", handoffKeyHandler, true);
}

function unbindHandoffKeys(): void {
  if (!handoffKeyHandler) return;
  document.removeEventListener("keydown", handoffKeyHandler, true);
  handoffKeyHandler = null;
}

/**
 * Opens the confirmation for a set of delivery tasks. Every route in — the
 * per-card button, the bulk bar, and a drop onto the autonomy queue — lands
 * here, because handing work to an AI employee is a decision, not a gesture.
 */
export function openHandoff(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
  taskIds: string[],
  options: {
    projectId?: string | null;
    projectName?: string | null;
    /** Pre-arms the staging gate — used by a drop straight onto Staged. */
    authorizeNow?: boolean;
    /**
     * Pre-selects the AI employee — used when a delivery card is dropped
     * directly onto one employee's drop target, so the picker opens on the
     * worker the operator aimed at rather than the top-ranked default.
     */
    preselectWorkerId?: string | null;
  } = {},
): void {
  const state = ensureAgencyAutonomyState(host);
  const eligible = taskIds.filter((id) => {
    const task = state.tasks.find((entry) => entry.id === id);
    return !!task && HANDOFF_ELIGIBLE_STATUSES.has(task.status);
  });
  if (eligible.length === 0) {
    state.error = "Nothing to hand over — closed and cancelled tasks cannot be sent to autonomy.";
    notify(host);
    return;
  }
  state.error = null;
  state.notice = null;
  const preselect =
    options.preselectWorkerId && state.employees.some((e) => e.id === options.preselectWorkerId)
      ? options.preselectWorkerId
      : "";
  state.handoff = {
    taskIds: eligible.slice(0, MAX_BATCH),
    projectId: options.projectId ?? null,
    projectName: options.projectName ?? null,
    workerId: preselect,
    priority: "normal",
    authorizeNow: options.authorizeNow === true,
    instructions: "",
    recommendations: [],
    recommendationsLoading: false,
    recommendationsError: null,
    submitting: false,
    progress: null,
    error:
      eligible.length > MAX_BATCH
        ? `Capped at ${MAX_BATCH} tasks per batch — ${eligible.length - MAX_BATCH} left selected for a second pass.`
        : null,
  };
  bindHandoffKeys(host);
  notify(host);
  queueMicrotask(() => {
    document.querySelector<HTMLElement>(".agx-modal .agx-handoff-worker")?.focus();
  });
  void loadRecommendations(host, client);
  // The dry run is agency-wide and writes nothing; refresh it so the rows for
  // this batch are current rather than whatever the last board load saw.
  if (!state.routing.loadedAt || Date.now() - state.routing.loadedAt > 60_000) {
    void loadRoutingPreview(host, client);
  }
}

export function updateHandoff(host: AgencyAutonomyHost, patch: Partial<AutonomyHandoff>): void {
  const state = ensureAgencyAutonomyState(host);
  if (!state.handoff) return;
  state.handoff = { ...state.handoff, ...patch };
  notify(host);
}

export function closeHandoff(host: AgencyAutonomyHost): void {
  const state = ensureAgencyAutonomyState(host);
  unbindHandoffKeys();
  if (!state.handoff) return;
  state.handoff = null;
  notify(host);
}

/**
 * Records the owner on a delivery task across both stores, tolerating either
 * one being absent. The full-kanban write is authoritative; `agency.ops.tasks.
 * assign` is a mirror for gateways that still keep an agency-scoped copy. A
 * failure of either is swallowed on purpose — the caller has already created
 * the work item that does the actual work, and a task the assign RPC does not
 * recognise must not roll that back.
 */
async function recordDeliveryOwner(
  client: GatewayBrowserClient,
  agencyId: string,
  taskId: string,
  workerId: string,
): Promise<void> {
  try {
    await client.request("kanban.tasks.update", {
      id: taskId,
      patch: { assignedAgent: workerId },
    });
  } catch {
    /* kanban store may not track this task — fall through to the mirror. */
  }
  try {
    await client.request("agency.ops.tasks.assign", {
      agencyId,
      taskId,
      assigneeId: workerId,
      assigneeType: "ai",
    });
  } catch {
    /* agency-ops mirror is best-effort; the kanban write above is the record. */
  }
}

// ── Detail modals ────────────────────────────────────────────────────────────
//
// A card on either half opens a full-record modal: the delivery task or the
// autonomy work item in full, plus the actions that belong to it. The delivery
// modal reuses the handoff dialog for assignment; the work-item modal defers its
// stage/transition actions to the Daily controller, which owns that lifecycle.

export function openTaskDetail(host: AgencyAutonomyHost, taskId: string): void {
  const state = ensureAgencyAutonomyState(host);
  state.taskDetailId = taskId;
  notify(host);
}

export function closeTaskDetail(host: AgencyAutonomyHost): void {
  const state = ensureAgencyAutonomyState(host);
  if (!state.taskDetailId && !state.taskDetailBusy) return;
  state.taskDetailId = null;
  state.taskDetailBusy = false;
  notify(host);
}

export function openWorkItemDetail(host: AgencyAutonomyHost, workItemId: string): void {
  const state = ensureAgencyAutonomyState(host);
  state.workItemDetailId = workItemId;
  notify(host);
}

export function closeWorkItemDetail(host: AgencyAutonomyHost): void {
  const state = ensureAgencyAutonomyState(host);
  if (!state.workItemDetailId) return;
  state.workItemDetailId = null;
  notify(host);
}

/**
 * Quick action from the delivery detail modal: move a delivery task to another
 * column. Writes through the same `kanban.tasks.update` the /projects board
 * uses, then patches the projected summary in place so the board and the modal
 * both reflect it without waiting for the next full load.
 */
export async function setDeliveryTaskStatus(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
  taskId: string,
  status: AgencyTaskSummary["status"],
): Promise<void> {
  const state = ensureAgencyAutonomyState(host);
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task || task.status === status) return;
  state.taskDetailBusy = true;
  notify(host);
  const previous = task.status;
  task.status = status;
  const raw = state.rawTasks[taskId];
  const kanbanStatus = deliveryStatusToKanban(status);
  if (raw) raw.status = kanbanStatus;
  notify(host);
  try {
    await client.request("kanban.tasks.update", {
      id: taskId,
      patch: { status: kanbanStatus },
    });
    state.notice = `Moved "${task.title}" to ${status.replace("_", " ")}.`;
  } catch (error) {
    task.status = previous;
    if (raw) raw.status = deliveryStatusToKanban(previous);
    state.error = `Could not move the task — ${errorMessage(error)}`;
    recordFailure(state, `kanban.tasks.update — ${errorMessage(error)}`);
  } finally {
    state.taskDetailBusy = false;
    notify(host);
  }
}

/**
 * Quick action from the delivery detail modal: append a timestamped note to the
 * task's description in the kanban store. The store has no separate per-task
 * note field, so a note is folded into the description the /projects board
 * already renders — visible everywhere the task is, not just here.
 */
export async function addDeliveryTaskNote(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
  taskId: string,
  note: string,
): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;
  const state = ensureAgencyAutonomyState(host);
  const raw = state.rawTasks[taskId];
  state.taskDetailBusy = true;
  notify(host);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `\n\n[note ${stamp}] ${trimmed}`;
  const nextDescription = `${raw?.description ?? ""}${line}`.trim();
  try {
    await client.request("kanban.tasks.update", {
      id: taskId,
      patch: { description: nextDescription },
    });
    if (raw) raw.description = nextDescription;
    state.notice = "Note added to the task.";
  } catch (error) {
    state.error = `Could not add the note — ${errorMessage(error)}`;
    recordFailure(state, `kanban.tasks.update — ${errorMessage(error)}`);
  } finally {
    state.taskDetailBusy = false;
    notify(host);
  }
}

/**
 * Reads the engine's dry run over the whole agency.
 *
 * `agency.ops.routing.preview` is deliberately agency-wide — it routes every
 * unassigned candidate task and writes nothing at all: no decisions, no work
 * items, no audit rows. So this is safe to run on every board load, and its
 * answer serves both the board summary and the per-batch rows in the dialog.
 *
 * Capability-gated: when the gateway does not advertise a preview method the
 * panel says "this build has no routing engine", which is a different sentence
 * from "the engine had no opinion" and from "we could not reach it".
 */
export async function loadRoutingPreview(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyAutonomyState(host);
  if (!state.agencyId) return;
  const method = state.routingMethods.preview ?? client.resolveMethod(ROUTING_PREVIEW_METHODS);
  if (!method) {
    state.routing = {
      status: "unavailable",
      method: null,
      decisions: [],
      counts: null,
      enabled: null,
      mode: null,
      error: null,
      loadedAt: Date.now(),
    };
    notify(host);
    return;
  }
  const agencyId = state.agencyId;
  state.routing = { ...state.routing, status: "loading", method, error: null };
  notify(host);
  try {
    const response = await client.request(method, { agencyId, limit: ROUTING_PREVIEW_LIMIT });
    if (state.agencyId !== agencyId) return;
    const run = readRoutingRun(response);
    state.routing = {
      status: "ready",
      method,
      decisions: readRoutingDecisions(run),
      counts: readRoutingCounts(run),
      enabled: typeof run?.enabled === "boolean" ? run.enabled : null,
      mode: typeof run?.mode === "string" ? run.mode : null,
      error: null,
      loadedAt: Date.now(),
    };
  } catch (error) {
    if (state.agencyId !== agencyId) return;
    const message = errorMessage(error);
    state.routing = {
      ...state.routing,
      status: "failed",
      method,
      error: message,
      loadedAt: Date.now(),
    };
    recordFailure(state, `${method} — ${message}`);
  } finally {
    notify(host);
  }
}

/** How many decisions the dry run returns. The engine caps at its own limit. */
export const ROUTING_PREVIEW_LIMIT = 250;

/** `{ routing: TaskRoutingRunResult }`, tolerating a bare result envelope. */
function readRoutingRun(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const record = response as Record<string, unknown>;
  const inner = record.routing ?? record.result ?? record.run;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return record;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRoutingCounts(run: Record<string, unknown> | null): RoutingCounts | null {
  if (!run) return null;
  return {
    candidates: readNumber(run, "candidates"),
    assigned: readNumber(run, "assigned"),
    unmatched: readNumber(run, "unmatched"),
    needsHuman: readNumber(run, "needsHuman"),
    autoStaged: readNumber(run, "autoStaged"),
    stageRecommended: readNumber(run, "stageRecommended"),
    deferred: readNumber(run, "deferred"),
    writes: readNumber(run, "writes"),
  };
}

/**
 * Normalises the decision rows. Every field is optional on purpose: this UI has
 * to keep rendering against a gateway older or newer than itself, and anything
 * it cannot read shows as "not reported" rather than `undefined`.
 */
function readRoutingDecisions(run: Record<string, unknown> | null): RoutingDecisionPreview[] {
  const list = firstArray(run, ["decisions", "assignments", "routes", "plan", "items"]);
  return list.map((entry) => ({
    taskId: typeof entry.taskId === "string" ? entry.taskId : null,
    taskTitle:
      typeof entry.taskTitle === "string"
        ? entry.taskTitle
        : typeof entry.title === "string"
          ? entry.title
          : null,
    workerId: typeof entry.workerId === "string" ? entry.workerId : null,
    workerName: typeof entry.workerName === "string" ? entry.workerName : null,
    outcome: typeof entry.outcome === "string" ? entry.outcome : null,
    rationale:
      typeof entry.rationale === "string"
        ? entry.rationale
        : typeof entry.reason === "string"
          ? entry.reason
          : null,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
    needsHuman: entry.needsHuman === true,
    stageRecommended: entry.stageRecommended === true,
  }));
}

/** First array-valued key from `keys`, or the value itself if it is one. */
function firstArray(value: unknown, keys: readonly string[]): Record<string, unknown>[] {
  const rows = (input: unknown): Record<string, unknown>[] | null =>
    Array.isArray(input)
      ? input.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
        )
      : null;
  const direct = rows(value);
  if (direct) return direct;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = rows(record[key]);
    if (found) return found;
  }
  return [];
}

/** Arms (or disarms) the agency-wide apply. It takes two deliberate clicks. */
export function setApplyArmed(host: AgencyAutonomyHost, armed: boolean): void {
  const state = ensureAgencyAutonomyState(host);
  if (state.applyArmed === armed) return;
  state.applyArmed = armed;
  notify(host);
}

/**
 * Runs the routing engine for real, across the agency.
 *
 * This is the one genuinely large action on the surface — it can assign
 * hundreds of tasks in a pass — so it is armed and confirmed separately from
 * the per-batch handoff, and never sits in a dialog footer where it could be
 * mistaken for "apply to the three tasks I am looking at".
 */
export async function applyRouting(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyAutonomyState(host);
  if (state.applying || !state.agencyId) return;
  const method = state.routingMethods.apply ?? client.resolveMethod(ROUTING_APPLY_METHODS);
  if (!method) {
    state.error = "This gateway build has no routing engine to apply.";
    state.applyArmed = false;
    notify(host);
    return;
  }
  state.applying = true;
  state.error = null;
  notify(host);
  try {
    const response = await client.request(method, {
      agencyId: state.agencyId,
      limit: ROUTING_PREVIEW_LIMIT,
    });
    const run = readRoutingRun(response);
    const counts = readRoutingCounts(run);
    state.notice =
      counts && counts.writes === 0
        ? "Routing pass ran and changed nothing — every candidate task already has a decision."
        : `Routing pass: ${counts?.assigned ?? 0} assigned, ${counts?.unmatched ?? 0} left for a human, ${counts?.autoStaged ?? 0} auto-staged.`;
    state.applyArmed = false;
    notify(host);
    await loadAgencyAutonomy(host, client, { background: true });
  } catch (error) {
    const message = errorMessage(error);
    state.error = message;
    state.applyArmed = false;
    recordFailure(state, `${method} — ${message}`);
    notify(host);
  } finally {
    state.applying = false;
    notify(host);
  }
}

/**
 * Commits the handoff.
 *
 * Two paths, same outcome:
 *  - `agency.ops.routing.task.assign` when the gateway serves the routing
 *    engine. One atomic call assigns the task, enqueues the work item AND pins
 *    the decision, so the router never quietly reassigns work a human ruled on.
 *  - otherwise the manual pair: `work-item.create` then `tasks.assign`.
 *
 * Sequential rather than `Promise.all`: a 200-item batch fired at once would
 * saturate the client's RPC window and, worse, report a single opaque failure
 * for the whole batch. Per-task progress is published as it goes so a long run
 * is visibly working, and partial failure names the count rather than rolling
 * back work the gateway already accepted.
 */
export async function submitHandoff(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyAutonomyState(host);
  const handoff = state.handoff;
  if (!handoff || handoff.submitting) return;
  if (!state.agencyId) {
    updateHandoff(host, { error: "No agency selected." });
    return;
  }
  if (!handoff.workerId) {
    updateHandoff(host, { error: "Pick the employee that takes this on." });
    return;
  }
  const agencyId = state.agencyId;
  const workerId = handoff.workerId;
  const worker = state.employees.find((entry) => entry.id === workerId);
  const workerName = worker?.name ?? workerId;

  handoff.submitting = true;
  handoff.error = null;
  handoff.progress = { done: 0, failed: 0, total: handoff.taskIds.length };
  notify(host);

  const overrideMethod =
    state.routingMethods.taskAssign ?? client.resolveMethod(ROUTING_TASK_ASSIGN_METHODS);
  const stageMethod = state.routingMethods.stage ?? client.resolveMethod(ROUTING_STAGE_METHODS);

  let done = 0;
  let failed = 0;
  let lastError: string | null = null;
  let lastMethod = overrideMethod ?? "agency.ops.employee.work-item.create";
  const sentTaskIds: string[] = [];
  const createdWorkItemIds: string[] = [];

  for (const taskId of handoff.taskIds) {
    if (state.handoff !== handoff) return; // dialog closed underneath us
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      failed += 1;
      continue;
    }
    const project = state.projects.find((entry) => entry.id === task.projectId);
    try {
      if (overrideMethod) {
        const response = await client.request(overrideMethod, {
          agencyId,
          taskId: task.id,
          workerId,
          note:
            handoff.instructions.trim() ||
            `Handed over from the delivery board by the operator${project ? ` (${project.name})` : ""}.`,
        });
        const decision = unwrap<{ workItemId?: string | null } | null>(response, "decision", null);
        if (decision?.workItemId) createdWorkItemIds.push(decision.workItemId);
      } else {
        lastMethod = "agency.ops.employee.work-item.create";
        const created = await client.request("agency.ops.employee.work-item.create", {
          agencyId,
          workerId,
          title: task.title,
          instructions:
            handoff.instructions.trim() ||
            `Delivery task from ${project?.name ?? "an unlinked project"}. Acceptance: complete the task and report what changed.`,
          priority: handoff.priority,
          dueAt: task.dueAt ?? null,
          // The link back to delivery. Without this the work item is an orphan
          // and nothing can reconcile it against the project board.
          context: {
            source: "agency-autonomy-board",
            taskId: task.id,
            projectId: task.projectId,
            projectName: project?.name ?? null,
          },
          idempotencyKey: `autonomy-board:${task.id}:${workerId}`,
        });
        // Record the owner on the delivery task itself, so the project board
        // stops showing thousands of tasks with nobody on them. The delivery
        // source is now the full kanban store, so the kanban write is the
        // authoritative one; the agency-ops assign is kept as a best-effort
        // second write for gateways that still mirror tasks there. Neither is
        // allowed to fail the handoff — the work item (which actually makes the
        // employee do the job) already exists at this point.
        await recordDeliveryOwner(client, agencyId, task.id, workerId);
        const workItem = unwrap<{ id?: string } | null>(created, "workItem", null);
        if (workItem?.id) createdWorkItemIds.push(workItem.id);
      }
      task.assigneeId = workerId;
      task.assigneeType = "ai";
      sentTaskIds.push(task.id);
      done += 1;
    } catch (error) {
      failed += 1;
      lastError = errorMessage(error);
    }
    if (state.handoff === handoff) {
      handoff.progress = { done, failed, total: handoff.taskIds.length };
      notify(host);
    }
  }

  // Staging is the authorisation gate, so it happens once, after every card
  // exists — and in one call when the engine offers a batch endpoint. It
  // refuses autonomy-0 employees server side, which is the correct place for
  // that rule to live.
  let stageError: string | null = null;
  if (handoff.authorizeNow && sentTaskIds.length) {
    try {
      if (stageMethod) {
        await client.request(stageMethod, { agencyId, taskIds: sentTaskIds, workerId });
      } else {
        for (const workItemId of createdWorkItemIds) {
          await client.request("agency.ops.employee.work-item.transition", {
            agencyId,
            workItemId,
            status: AUTONOMY_STAGE,
          });
        }
      }
    } catch (error) {
      stageError = errorMessage(error);
      recordFailure(
        state,
        `${stageMethod ?? "agency.ops.employee.work-item.transition"} — ${stageError}`,
      );
    }
  }

  if (failed > 0) {
    recordFailure(state, `${lastMethod} — ${lastError ?? "unknown error"}`);
  }
  const sent = done;
  const authorised = handoff.authorizeNow && !stageError;
  state.notice =
    failed === 0
      ? `${sent} task${sent === 1 ? "" : "s"} handed to ${workerName}${authorised ? " and authorised to run" : handoff.authorizeNow ? ` — but staging failed: ${stageError}` : " — queued in Backlog, not yet authorised"}.`
      : `${sent} of ${handoff.taskIds.length} handed to ${workerName}; ${failed} failed. See the failure list above.`;
  if (state.handoff === handoff) {
    state.handoff = null;
    unbindHandoffKeys();
  }
  if (done > 0) {
    const sentIds = new Set(handoff.taskIds);
    const next = new Set<string>();
    for (const id of state.selectedTaskIds) if (!sentIds.has(id)) next.add(id);
    state.selectedTaskIds = next;
  }
  notify(host);
  await loadAgencyAutonomy(host, client, { background: true });
}

// ── Live updates ───────────────────────────────────────────────────────────

let workEventUnsubscribe: (() => void) | null = null;
let workEventTimer: number | null = null;

/**
 * Subscribes to `agency.work.updated`. The payload is an invalidation signal,
 * not a record, so this debounces a refetch instead of patching state from the
 * event — the same convention Daily Operations follows.
 */
export function subscribeAutonomyUpdates(
  host: AgencyAutonomyHost,
  client: GatewayBrowserClient,
): void {
  if (workEventUnsubscribe) return;
  workEventUnsubscribe = client.subscribe((event) => {
    if (event.event !== WORK_ITEM_EVENT) return;
    const state = host.agencyAutonomyState;
    if (!state) return;
    const payload = (event.payload ?? {}) as { agencyId?: string };
    if (payload.agencyId && state.agencyId && payload.agencyId !== state.agencyId) return;
    state.liveAt = Date.now();
    // On the merged Command page the board is the "Today" sub-tab.
    if (host.tab && contentTabOf({ tab: host.tab, hostView: host.hostView }) !== "agency-daily") return;
    // Never refetch mid-batch: the board would reorder under the operator's
    // cursor while their own submit loop is still running.
    if (state.handoff?.submitting) return;
    if (workEventTimer !== null) return;
    workEventTimer = window.setTimeout(() => {
      workEventTimer = null;
      void loadAgencyAutonomy(host, client, { background: true });
    }, 400);
  });
}
