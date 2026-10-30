/**
 * Daily Operations controller — "what is happening in the agency today".
 *
 * The workforce operating loop (`agency.ops.employee.loop.tick`) is what turns
 * recurring responsibilities into work items, escalates SLA breaches and moves
 * manager review cycles to `due`. Since the gateway added the
 * `agency-operating-loop` cron job it runs on a schedule, so this surface reads
 * the job out of `cron.list` and presents the loop as *already running* with a
 * last/next-run indicator; the manual tick stays available as an override, not
 * as a chore the operator has to remember.
 */

import type { GatewayBrowserClient } from "../gateway";
import { contentTabOf, type Tab } from "../navigation";
import type {
  AgencyApproval,
  AgencyEmployee,
  AgencyKpi,
  AgencyTaskSummary,
  EmployeeResponsibility,
  EmployeeReviewCycle,
  EmployeeWorkItem,
} from "./agency-operations";
import { attempt, errorMessage, resolveAgency, unwrap } from "./agency-common";

export interface OperatingLoopStatus {
  found: boolean;
  enabled: boolean;
  everyMs: number | null;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: string | null;
  lastError: string | null;
  runningAtMs: number | null;
}

export interface DeliveryPulse {
  total: number;
  byStatus: Record<string, number>;
  /** A short, newest-first sample of work actually moving right now. */
  active: Array<{
    id: string;
    title: string;
    status: AgencyTaskSummary["status"];
    priority: AgencyTaskSummary["priority"];
    projectName: string;
    dueAt: number | null;
  }>;
  overdue: number;
  dueToday: number;
}

/**
 * Per-card execution metadata, mirrored from the gateway's
 * `WorkItemExecutionView` (`src/workforce/executor.ts`). Duplicated rather than
 * imported because the UI bundle does not reach into `src/`.
 */
export interface WorkItemExecutionView {
  workItemId: string;
  workerId: string;
  workerName: string;
  stage: EmployeeWorkItem["status"];
  /** True when the card sits in the stage that authorises autonomous work. */
  executionEligible: boolean;
  /** Whether the executor is switched on at all (`executeWorkItems`). */
  executorEnabled: boolean;
  /** Coder backend the employee's model binding resolves to. */
  backend: string | null;
  autonomyLevel: number;
  /** Where a successful run would land the card; null when it would not run. */
  terminalStage: "review" | "completed" | null;
  /** Human-readable reason the card will NOT run, or null when it will. */
  blockedReason: string | null;
  lastRun: Record<string, unknown> | null;
}

/**
 * The authorisation prompt shown before a card is staged.
 *
 * Staging is the approval gate — `queued -> in_progress` is rejected server
 * side, so moving a card to `accepted` is the *only* way work becomes eligible
 * to run. That has to be a deliberate act with the consequences on screen, so
 * both the button and a drag into the staged column open this prompt instead of
 * transitioning straight away.
 */
export interface StagePrompt {
  workItemId: string;
  title: string;
  loading: boolean;
  view: WorkItemExecutionView | null;
  error: string | null;
  submitting: boolean;
}

/**
 * Which inline composer is open, if any.
 *
 * Daily Operations used to be a read-only report: every panel described work
 * the operator then had to go and do somewhere else. Each kind here maps 1:1
 * onto a gateway RPC so the panel that *describes* a thing is also the panel
 * that *creates* it.
 */
export type DailyComposerKind =
  | "work-item"
  | "responsibility"
  | "review"
  | "review-complete"
  | "schedule";

export interface DailyComposer {
  kind: DailyComposerKind;
  title: string;
  workerId: string;
  managerWorkerId: string;
  instructions: string;
  priority: EmployeeWorkItem["priority"];
  cadence: "daily" | "weekly" | "monthly";
  runAt: string;
  slaMinutes: number;
  cadenceDays: number;
  /** Optional relative due date for a one-off work item; 0 means "no due date". */
  dueInDays: number;
  shiftStart: string;
  shiftEnd: string;
  weekdays: number[];
  timezone: string;
  reviewCycleId: string;
  outcome: string;
  submitting: boolean;
  error: string | null;
}

/**
 * A pending approve/reject decision awaiting its second click.
 *
 * Resolving a client approval is irreversible from this surface, so the row
 * arms first and commits second rather than firing on a single mis-click.
 */
export interface ApprovalIntent {
  approvalId: string;
  decision: "approved" | "rejected";
}

export interface AgencyDailyState {
  loadGeneration: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  failedRequests: string[];
  lastLoadedAt: number | null;
  agencyId: string | null;
  agencyName: string;
  kpis: AgencyKpi[];
  workItems: EmployeeWorkItem[];
  reviews: EmployeeReviewCycle[];
  responsibilities: EmployeeResponsibility[];
  approvals: AgencyApproval[];
  employees: AgencyEmployee[];
  delivery: DeliveryPulse;
  loop: OperatingLoopStatus;
  loopRunning: boolean;
  loopResult: string | null;
  busyWorkItemId: string | null;
  /** Whether the gateway will actually run staged cards at all. */
  executorEnabled: boolean;
  /** Execution metadata keyed by work item id (staged cards + any probed card). */
  executions: Record<string, WorkItemExecutionView>;
  /** True once `execution.list` has answered at least once this session. */
  executionsLoaded: boolean;
  /** Board interaction state. Drag is an accelerator, never the only route. */
  draggingWorkItemId: string | null;
  dragOverStage: EmployeeWorkItem["status"] | null;
  stagePrompt: StagePrompt | null;
  /** Set by the `agency.work.updated` broadcast so the board can show it is live. */
  liveAt: number | null;
  /** Open inline composer (create work item / responsibility / review / shift). */
  composer: DailyComposer | null;
  /** Armed approval decision — committed by a second, explicit click. */
  approvalIntent: ApprovalIntent | null;
  busyApprovalId: string | null;
  busyReviewCycleId: string | null;
  /** Transient confirmation of the last successful action. */
  notice: string | null;
}

export interface AgencyDailyHost {
  agencyDailyState?: AgencyDailyState | null;
  requestUpdate?: () => void;
  setTab?: (tab: Tab) => void;
  /** Read (never written) so broadcast refetches stay off other surfaces. */
  tab?: Tab;
  hostView?: Partial<Record<Tab, string>>;
}

const EMPTY_LOOP: OperatingLoopStatus = {
  found: false,
  enabled: false,
  everyMs: null,
  nextRunAtMs: null,
  lastRunAtMs: null,
  lastStatus: null,
  lastError: null,
  runningAtMs: null,
};

const EMPTY_DELIVERY: DeliveryPulse = {
  total: 0,
  byStatus: {},
  active: [],
  overdue: 0,
  dueToday: 0,
};

export const OPERATING_LOOP_JOB_NAME = "agency-operating-loop";

/** Work-item states an operator has to look at today. */
export const OPEN_WORK_ITEM_STATUSES = [
  "escalated",
  "in_progress",
  "review",
  "waiting",
  "accepted",
  "queued",
] as const;

/**
 * The stage that authorises autonomous execution. Mirrors `EXECUTION_STAGE` in
 * `src/workforce/executor.ts` — a card only becomes eligible to run here.
 */
export const AUTONOMY_STAGE = "accepted" as const;

/** Broadcast the executor emits whenever a work item changes hands. */
export const WORK_ITEM_EVENT = "agency.work.updated";

/**
 * Client mirror of `assertWorkItemTransition` (`src/workforce/lifecycle.ts`).
 *
 * Kept in sync so the board only ever offers legal moves — notably there is no
 * `queued -> in_progress` edge, which is what makes the staged column an
 * unavoidable approval gate rather than a UI convention.
 */
export const WORK_ITEM_TRANSITIONS: Record<
  EmployeeWorkItem["status"],
  ReadonlyArray<EmployeeWorkItem["status"]>
> = {
  queued: ["accepted", "cancelled", "escalated"],
  accepted: ["in_progress", "cancelled", "escalated"],
  in_progress: ["waiting", "review", "completed", "cancelled", "escalated"],
  waiting: ["in_progress", "cancelled", "escalated"],
  review: ["in_progress", "completed", "escalated"],
  escalated: ["accepted", "in_progress", "review", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionWorkItem(
  from: EmployeeWorkItem["status"],
  to: EmployeeWorkItem["status"],
): boolean {
  return WORK_ITEM_TRANSITIONS[from]?.includes(to) ?? false;
}

export function createAgencyDailyState(): AgencyDailyState {
  return {
    loadGeneration: 0,
    loading: false,
    refreshing: false,
    error: null,
    failedRequests: [],
    lastLoadedAt: null,
    agencyId: null,
    agencyName: "",
    kpis: [],
    workItems: [],
    reviews: [],
    responsibilities: [],
    approvals: [],
    employees: [],
    delivery: { ...EMPTY_DELIVERY },
    loop: { ...EMPTY_LOOP },
    loopRunning: false,
    loopResult: null,
    busyWorkItemId: null,
    executorEnabled: false,
    executions: {},
    executionsLoaded: false,
    draggingWorkItemId: null,
    dragOverStage: null,
    stagePrompt: null,
    liveAt: null,
    composer: null,
    approvalIntent: null,
    busyApprovalId: null,
    busyReviewCycleId: null,
    notice: null,
  };
}

export function ensureAgencyDailyState(host: AgencyDailyHost): AgencyDailyState {
  if (!host.agencyDailyState) host.agencyDailyState = createAgencyDailyState();
  return host.agencyDailyState;
}

function notify(host: AgencyDailyHost): void {
  host.requestUpdate?.();
}

interface CronJobShape {
  name?: string;
  enabled?: boolean;
  schedule?: { kind?: string; everyMs?: number };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    runningAtMs?: number;
    lastStatus?: string;
    lastError?: string;
  };
}

function readLoopStatus(result: unknown): OperatingLoopStatus {
  const jobs = unwrap<CronJobShape[]>(result, "jobs", []);
  const job = Array.isArray(jobs)
    ? jobs.find((entry) => entry?.name === OPERATING_LOOP_JOB_NAME)
    : undefined;
  if (!job) return { ...EMPTY_LOOP };
  return {
    found: true,
    enabled: job.enabled !== false,
    everyMs: job.schedule?.kind === "every" ? (job.schedule.everyMs ?? null) : null,
    nextRunAtMs: job.state?.nextRunAtMs ?? null,
    lastRunAtMs: job.state?.lastRunAtMs ?? null,
    lastStatus: job.state?.lastStatus ?? null,
    lastError: job.state?.lastError ?? null,
    runningAtMs: job.state?.runningAtMs ?? null,
  };
}

/**
 * Condenses the task table into a delivery pulse. The full list is thousands of
 * rows on a real agency, so nothing but counts and a short active sample is
 * retained in state.
 */
function readDeliveryPulse(
  tasksResult: unknown,
  projectNames: Map<string, string>,
): DeliveryPulse {
  const tasks = unwrap<AgencyTaskSummary[]>(tasksResult, "tasks", []);
  if (!Array.isArray(tasks) || tasks.length === 0) return { ...EMPTY_DELIVERY };
  const byStatus: Record<string, number> = {};
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const now = Date.now();
  let overdue = 0;
  let dueToday = 0;
  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    if (task.dueAt && task.status !== "done" && task.status !== "cancelled") {
      if (task.dueAt < now) overdue += 1;
      else if (task.dueAt <= endOfDay.getTime()) dueToday += 1;
    }
  }
  const rank: Record<string, number> = { blocked: 0, in_progress: 1, review: 2, ready: 3 };
  const active = tasks
    .filter((task) => task.status in rank)
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 12)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      projectName: projectNames.get(task.projectId) ?? "Unlinked project",
      dueAt: task.dueAt ?? null,
    }));
  return { total: tasks.length, byStatus, active, overdue, dueToday };
}

export async function loadAgencyDaily(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
  options: { background?: boolean } = {},
): Promise<void> {
  const state = ensureAgencyDailyState(host);
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

    const [
      dashboardResult,
      inboxResult,
      reviewsResult,
      responsibilitiesResult,
      approvalsResult,
      employeesResult,
      projectsResult,
      tasksResult,
      cronResult,
      executionResult,
    ] = await Promise.all([
      attempt(client, failures, "agency.ops.dashboard", { agencyId }),
      attempt(client, failures, "agency.ops.employee.inbox.list", { agencyId, limit: 250 }),
      attempt(client, failures, "agency.ops.employee.reviews.list", { agencyId }),
      attempt(client, failures, "agency.ops.employee.responsibilities.list", { agencyId }),
      attempt(client, failures, "agency.ops.approvals.list", { agencyId, status: "pending" }),
      attempt(client, failures, "agency.ops.employees.list", { agencyId, status: "active" }),
      attempt(client, failures, "agency.ops.projects.list", { agencyId }),
      attempt(client, failures, "agency.ops.tasks.list", { agencyId }),
      attempt(client, failures, "cron.list", { includeDisabled: true }),
      // Routed through `attempt` on purpose: a gateway built before the
      // execution RPCs landed answers "method not found", and that has to reach
      // the failure banner rather than quietly render a board with no
      // execution detail on it.
      attempt(client, failures, "agency.ops.employee.work-item.execution.list", {
        agencyId,
        limit: 200,
      }),
    ]);
    if (generation !== state.loadGeneration || agencyId !== state.agencyId) return;

    const dashboard = unwrap<{ kpis?: AgencyKpi[] }>(dashboardResult, "dashboard", {});
    state.kpis = dashboardResult ? (dashboard.kpis ?? state.kpis) : state.kpis;
    state.workItems = unwrap<EmployeeWorkItem[]>(inboxResult, "workItems", state.workItems);
    state.reviews = unwrap<EmployeeReviewCycle[]>(reviewsResult, "reviewCycles", state.reviews);
    state.responsibilities = unwrap<EmployeeResponsibility[]>(
      responsibilitiesResult,
      "responsibilities",
      state.responsibilities,
    );
    state.approvals = unwrap<AgencyApproval[]>(approvalsResult, "approvals", state.approvals);
    state.employees = unwrap<AgencyEmployee[]>(employeesResult, "employees", state.employees);

    const projectNames = new Map(
      unwrap<Array<{ id: string; name: string }>>(projectsResult, "projects", []).map(
        (project) => [project.id, project.name] as const,
      ),
    );
    state.delivery = tasksResult
      ? readDeliveryPulse(tasksResult, projectNames)
      : state.delivery;
    state.loop = cronResult ? readLoopStatus(cronResult) : state.loop;
    if (executionResult) {
      const views = unwrap<WorkItemExecutionView[]>(executionResult, "items", []);
      const executions: Record<string, WorkItemExecutionView> = {};
      for (const view of Array.isArray(views) ? views : []) {
        if (view?.workItemId) executions[view.workItemId] = view;
      }
      // Probed cards (fetched for the staging prompt) are not in the staged
      // feed, so keep them rather than dropping detail the operator just read.
      for (const [id, view] of Object.entries(state.executions)) {
        if (!executions[id] && view.stage !== AUTONOMY_STAGE) executions[id] = view;
      }
      state.executions = executions;
      state.executorEnabled =
        unwrap<boolean>(executionResult, "executorEnabled", false) === true;
      state.executionsLoaded = true;
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

/**
 * Manual override for the scheduled loop. Reports what the tick produced so the
 * operator can tell "ran and found nothing" apart from "did not run".
 */
export async function runOperatingLoopNow(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyDailyState(host);
  if (!state.agencyId || state.loopRunning) return;
  state.loopRunning = true;
  state.loopResult = null;
  state.error = null;
  notify(host);
  try {
    const response = await client.request("agency.ops.employee.loop.tick", {
      agencyId: state.agencyId,
    });
    const result = unwrap<{
      generatedWorkItemIds?: string[];
      escalatedWorkItemIds?: string[];
      dueReviewCycleIds?: string[];
    }>(response, "result", {});
    const generated = result?.generatedWorkItemIds?.length ?? 0;
    const escalated = result?.escalatedWorkItemIds?.length ?? 0;
    const due = result?.dueReviewCycleIds?.length ?? 0;
    state.loopResult =
      generated + escalated + due === 0
        ? "Loop ran — nothing was due."
        : `Loop ran — ${generated} generated, ${escalated} escalated, ${due} review${due === 1 ? "" : "s"} due.`;
    await loadAgencyDaily(host, client, { background: true });
  } catch (error) {
    const entry = `agency.ops.employee.loop.tick — ${errorMessage(error)}`;
    state.error = errorMessage(error);
    if (!state.failedRequests.includes(entry)) {
      state.failedRequests = [...state.failedRequests, entry];
    }
  } finally {
    state.loopRunning = false;
    notify(host);
  }
}

/**
 * Moves one work item along its lifecycle straight from the queue. Optimistic
 * with rollback: a rejected transition must not leave a lie on screen.
 */
export async function transitionDailyWorkItem(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
  workItemId: string,
  status: EmployeeWorkItem["status"],
): Promise<void> {
  const state = ensureAgencyDailyState(host);
  if (!state.agencyId || state.busyWorkItemId) return;
  const item = state.workItems.find((entry) => entry.id === workItemId);
  if (!item) return;
  const previous = item.status;
  if (previous === status) return;
  if (!canTransitionWorkItem(previous, status)) {
    state.error = `"${previous.replace("_", " ")}" cannot move straight to "${status.replace("_", " ")}".`;
    notify(host);
    return;
  }
  item.status = status;
  // The board keys execution detail off the card, so the optimistic stage has
  // to move with it or a just-staged card renders with stale readiness.
  const previousExecution = state.executions[workItemId];
  if (previousExecution) {
    state.executions = {
      ...state.executions,
      [workItemId]: { ...previousExecution, stage: status },
    };
  }
  state.busyWorkItemId = workItemId;
  notify(host);
  try {
    await client.request("agency.ops.employee.work-item.transition", {
      agencyId: state.agencyId,
      workItemId,
      status,
    });
  } catch (error) {
    item.status = previous;
    if (previousExecution) {
      state.executions = { ...state.executions, [workItemId]: previousExecution };
    }
    const entry = `agency.ops.employee.work-item.transition — ${errorMessage(error)}`;
    state.error = errorMessage(error);
    if (!state.failedRequests.includes(entry)) {
      state.failedRequests = [...state.failedRequests, entry];
    }
  } finally {
    state.busyWorkItemId = null;
    notify(host);
  }
}

// ── Board: staging as an explicit authorisation ────────────────────────────

/**
 * Opens the authorisation prompt for one card and fetches its real execution
 * readiness so the operator authorises against facts (which employee, which
 * backend, auto-complete or held for review) instead of a guess.
 */
export async function openStagePrompt(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
  workItemId: string,
): Promise<void> {
  const state = ensureAgencyDailyState(host);
  const item = state.workItems.find((entry) => entry.id === workItemId);
  if (!state.agencyId || !item) return;
  state.stagePrompt = {
    workItemId,
    title: item.title,
    loading: true,
    view: state.executions[workItemId] ?? null,
    error: null,
    submitting: false,
  };
  bindStagePromptKeys(host);
  notify(host);
  // Move focus into the dialog so it is escapable and operable from the
  // keyboard alone; the render is a plain function, so there is no lifecycle
  // hook to do this from.
  queueMicrotask(() => {
    document.querySelector<HTMLElement>(".agx-modal button.authorize")?.focus();
  });
  try {
    const response = await client.request(
      "agency.ops.employee.work-item.execution.status",
      { agencyId: state.agencyId, workItemId },
    );
    const view = unwrap<WorkItemExecutionView | null>(response, "execution", null);
    if (state.stagePrompt?.workItemId !== workItemId) return;
    if (view?.workItemId) {
      state.executions = { ...state.executions, [workItemId]: view };
      state.stagePrompt.view = view;
      state.executorEnabled = view.executorEnabled;
    }
  } catch (error) {
    if (state.stagePrompt?.workItemId !== workItemId) return;
    // Not fatal: the operator can still authorise, they just do it without the
    // preview. Say so rather than showing a blank panel.
    state.stagePrompt.error = `Readiness unavailable — ${errorMessage(error)}`;
  } finally {
    if (state.stagePrompt?.workItemId === workItemId) {
      state.stagePrompt.loading = false;
      notify(host);
    }
  }
}

/**
 * Escape closes the prompt. Bound on the document rather than the dialog
 * element because the dialog is re-rendered on every state change, so a
 * template-level handler would only fire while focus happened to sit inside it.
 */
let stagePromptKeyHandler: ((event: KeyboardEvent) => void) | null = null;

function bindStagePromptKeys(host: AgencyDailyHost): void {
  if (stagePromptKeyHandler) return;
  stagePromptKeyHandler = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeStagePrompt(host);
  };
  document.addEventListener("keydown", stagePromptKeyHandler, true);
}

function unbindStagePromptKeys(): void {
  if (!stagePromptKeyHandler) return;
  document.removeEventListener("keydown", stagePromptKeyHandler, true);
  stagePromptKeyHandler = null;
}

export function closeStagePrompt(host: AgencyDailyHost): void {
  const state = ensureAgencyDailyState(host);
  unbindStagePromptKeys();
  if (!state.stagePrompt) return;
  state.stagePrompt = null;
  notify(host);
}

/** Confirms the prompt: this is the moment autonomous work is authorised. */
export async function confirmStagePrompt(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyDailyState(host);
  const prompt = state.stagePrompt;
  if (!prompt || prompt.submitting) return;
  prompt.submitting = true;
  notify(host);
  await transitionDailyWorkItem(host, client, prompt.workItemId, AUTONOMY_STAGE);
  if (state.stagePrompt?.workItemId === prompt.workItemId) {
    state.stagePrompt = null;
    unbindStagePromptKeys();
  }
  notify(host);
}

/**
 * Fetches the full execution record for ONE work item — the readiness view plus
 * its `lastRun` memory (final output, session id, duration, outcome) — and folds
 * it into `state.executions`. The board's summary feed only carries `lastRun`
 * for staged cards, so the full-expansion modal calls this on open to surface
 * the actual deliverable/result for a card in any column. Best-effort: a gateway
 * that predates the RPC, or a card the executor never touched, simply leaves the
 * modal to render what the summary already had.
 */
export async function loadWorkItemExecutionDetail(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
  workItemId: string,
): Promise<void> {
  const state = ensureAgencyDailyState(host);
  if (!state.agencyId) return;
  try {
    const response = await client.request(
      "agency.ops.employee.work-item.execution.status",
      { agencyId: state.agencyId, workItemId },
    );
    const view = unwrap<WorkItemExecutionView | null>(response, "execution", null);
    if (view?.workItemId) {
      state.executions = { ...state.executions, [workItemId]: view };
      state.executorEnabled = view.executorEnabled;
      state.executionsLoaded = true;
      notify(host);
    }
  } catch {
    /* Decoration, not a hard dependency — the modal degrades to the summary. */
  }
}

// ── Board: drag accelerators (never the only route — see the stage select) ──

export function beginWorkItemDrag(host: AgencyDailyHost, workItemId: string): void {
  const state = ensureAgencyDailyState(host);
  state.draggingWorkItemId = workItemId;
  notify(host);
}

export function endWorkItemDrag(host: AgencyDailyHost): void {
  const state = ensureAgencyDailyState(host);
  if (!state.draggingWorkItemId && !state.dragOverStage) return;
  state.draggingWorkItemId = null;
  state.dragOverStage = null;
  notify(host);
}

export function setDragOverStage(
  host: AgencyDailyHost,
  stage: EmployeeWorkItem["status"] | null,
): void {
  const state = ensureAgencyDailyState(host);
  if (state.dragOverStage === stage) return;
  state.dragOverStage = stage;
  notify(host);
}

/**
 * Single entry point for "move this card to that column", used by the drop
 * handler and by the keyboard stage control alike. A move *into* the autonomy
 * stage always goes through the authorisation prompt.
 */
export function requestWorkItemStage(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
  workItemId: string,
  stage: EmployeeWorkItem["status"],
): void {
  const state = ensureAgencyDailyState(host);
  const item = state.workItems.find((entry) => entry.id === workItemId);
  if (!item || item.status === stage) return;
  if (!canTransitionWorkItem(item.status, stage)) return;
  if (stage === AUTONOMY_STAGE) {
    void openStagePrompt(host, client, workItemId);
    return;
  }
  void transitionDailyWorkItem(host, client, workItemId, stage);
}

// ── Inline actions ─────────────────────────────────────────────────────────
//
// Every function below is a thin wrapper over one gateway RPC. They all follow
// the same contract: refuse without an agency, report failure onto the surface's
// own error/failure channels rather than throwing into the render, and refetch
// in the background on success so the panel the operator just acted on is the
// panel that updates.

const DAY_MS = 86_400_000;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Sensible defaults for every composer field; each kind reads what it needs. */
function createComposer(kind: DailyComposerKind, patch: Partial<DailyComposer>): DailyComposer {
  return {
    kind,
    title: "",
    workerId: "",
    managerWorkerId: "",
    instructions: "",
    priority: "normal",
    cadence: "daily",
    runAt: "09:00",
    slaMinutes: 1_440,
    cadenceDays: 7,
    dueInDays: 0,
    shiftStart: "09:00",
    shiftEnd: "17:00",
    weekdays: [1, 2, 3, 4, 5],
    timezone: localTimezone(),
    reviewCycleId: "",
    outcome: "",
    submitting: false,
    error: null,
    ...patch,
  };
}

export function openDailyComposer(
  host: AgencyDailyHost,
  kind: DailyComposerKind,
  patch: Partial<DailyComposer> = {},
): void {
  const state = ensureAgencyDailyState(host);
  // Default to the first active worker so the common case is title-and-go.
  const fallbackWorker = state.employees[0]?.id ?? "";
  const manager = state.employees.find((entry) => entry.id !== (patch.workerId ?? fallbackWorker));
  state.composer = createComposer(kind, {
    workerId: fallbackWorker,
    managerWorkerId: manager?.id ?? fallbackWorker,
    ...patch,
  });
  state.notice = null;
  notify(host);
  // The render is a plain function with no lifecycle hook, so focus is moved
  // into the dialog here — same approach as the staging prompt.
  queueMicrotask(() => {
    document
      .querySelector<HTMLElement>(".agx-composer input, .agx-composer textarea, .agx-composer select")
      ?.focus();
  });
}

export function updateDailyComposer(host: AgencyDailyHost, patch: Partial<DailyComposer>): void {
  const state = ensureAgencyDailyState(host);
  if (!state.composer) return;
  state.composer = { ...state.composer, ...patch, error: patch.error ?? null };
  notify(host);
}

export function closeDailyComposer(host: AgencyDailyHost): void {
  const state = ensureAgencyDailyState(host);
  if (!state.composer) return;
  state.composer = null;
  notify(host);
}

export function dismissDailyNotice(host: AgencyDailyHost): void {
  const state = ensureAgencyDailyState(host);
  if (!state.notice) return;
  state.notice = null;
  notify(host);
}

/** Maps a composer to its RPC. Returns the confirmation line shown on success. */
function composerRequest(
  state: AgencyDailyState,
  composer: DailyComposer,
  agencyId: string,
): { method: string; params: Record<string, unknown>; notice: string } | string {
  const workerName =
    state.employees.find((entry) => entry.id === composer.workerId)?.name ?? "the worker";
  switch (composer.kind) {
    case "work-item": {
      if (!composer.workerId) return "Pick who this is for.";
      if (!composer.title.trim()) return "Give the work item a title.";
      return {
        method: "agency.ops.employee.work-item.create",
        params: {
          agencyId,
          workerId: composer.workerId,
          title: composer.title.trim(),
          instructions: composer.instructions.trim() || undefined,
          priority: composer.priority,
          dueAt: composer.dueInDays > 0 ? Date.now() + composer.dueInDays * DAY_MS : null,
        },
        notice: `Queued "${composer.title.trim()}" for ${workerName} — it lands in Backlog, not in execution.`,
      };
    }
    case "responsibility": {
      if (!composer.workerId) return "Pick who owns this responsibility.";
      if (!composer.title.trim()) return "Give the responsibility a title.";
      return {
        method: "agency.ops.employee.responsibility.create",
        params: {
          agencyId,
          workerId: composer.workerId,
          title: composer.title.trim(),
          instructions: composer.instructions.trim(),
          cadence: composer.cadence,
          runAt: composer.runAt,
          slaMinutes: composer.slaMinutes,
          priority: composer.priority,
        },
        notice: `${workerName} now owns "${composer.title.trim()}" ${composer.cadence} at ${composer.runAt}. The loop generates it from the next run.`,
      };
    }
    case "review": {
      if (!composer.workerId) return "Pick who is being reviewed.";
      if (!composer.managerWorkerId) return "Pick who reviews them.";
      return {
        method: "agency.ops.employee.review-cycle.create",
        params: {
          agencyId,
          workerId: composer.workerId,
          managerWorkerId: composer.managerWorkerId,
          cadenceDays: composer.cadenceDays,
          nextReviewAt: Date.now() + composer.cadenceDays * DAY_MS,
        },
        notice: `Review cycle scheduled for ${workerName} every ${composer.cadenceDays} days.`,
      };
    }
    case "review-complete": {
      if (!composer.reviewCycleId) return "No review cycle selected.";
      if (!composer.outcome.trim()) return "Record what the review concluded.";
      return {
        method: "agency.ops.employee.review-cycle.complete",
        params: {
          agencyId,
          reviewCycleId: composer.reviewCycleId,
          outcome: composer.outcome.trim(),
        },
        notice: `Review signed off for ${workerName}.`,
      };
    }
    case "schedule": {
      if (!composer.workerId) return "Pick whose shift this is.";
      if (composer.weekdays.length === 0) return "Pick at least one working day.";
      return {
        method: "agency.ops.employee.schedule.create",
        params: {
          agencyId,
          workerId: composer.workerId,
          timezone: composer.timezone,
          weekdays: [...composer.weekdays].sort((a, b) => a - b),
          shiftStart: composer.shiftStart,
          shiftEnd: composer.shiftEnd,
          effectiveFrom: todayIsoDate(),
        },
        notice: `${workerName} is on shift ${composer.shiftStart}–${composer.shiftEnd} (${composer.timezone}).`,
      };
    }
  }
}

export async function submitDailyComposer(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyDailyState(host);
  const composer = state.composer;
  if (!composer || composer.submitting) return;
  if (!state.agencyId) {
    state.composer = { ...composer, error: "No agency selected." };
    notify(host);
    return;
  }
  const plan = composerRequest(state, composer, state.agencyId);
  if (typeof plan === "string") {
    state.composer = { ...composer, error: plan };
    notify(host);
    return;
  }
  state.composer = { ...composer, submitting: true, error: null };
  notify(host);
  try {
    await client.request(plan.method, plan.params);
    state.composer = null;
    state.notice = plan.notice;
    notify(host);
    await loadAgencyDaily(host, client, { background: true });
  } catch (error) {
    const message = errorMessage(error);
    if (state.composer) state.composer = { ...state.composer, submitting: false, error: message };
    const entry = `${plan.method} — ${message}`;
    if (!state.failedRequests.includes(entry)) {
      state.failedRequests = [...state.failedRequests, entry];
    }
    notify(host);
  }
}

/** Arms (or disarms) an approve/reject decision so it takes two clicks. */
export function setApprovalIntent(host: AgencyDailyHost, intent: ApprovalIntent | null): void {
  const state = ensureAgencyDailyState(host);
  state.approvalIntent = intent;
  state.notice = null;
  notify(host);
}

/** Commits the armed decision through `agency.ops.approval.resolve`. */
export async function resolveDailyApproval(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
): Promise<void> {
  const state = ensureAgencyDailyState(host);
  const intent = state.approvalIntent;
  if (!intent || !state.agencyId || state.busyApprovalId) return;
  const approval = state.approvals.find((entry) => entry.id === intent.approvalId);
  state.busyApprovalId = intent.approvalId;
  notify(host);
  try {
    await client.request("agency.ops.approval.resolve", {
      agencyId: state.agencyId,
      approvalId: intent.approvalId,
      decision: intent.decision,
    });
    state.approvalIntent = null;
    state.notice = `${approval?.title ?? "Approval"} ${intent.decision}.`;
    // Drop it locally so the panel empties immediately; the refetch confirms.
    state.approvals = state.approvals.filter((entry) => entry.id !== intent.approvalId);
    notify(host);
    await loadAgencyDaily(host, client, { background: true });
  } catch (error) {
    const message = errorMessage(error);
    state.error = message;
    const entry = `agency.ops.approval.resolve — ${message}`;
    if (!state.failedRequests.includes(entry)) {
      state.failedRequests = [...state.failedRequests, entry];
    }
    notify(host);
  } finally {
    state.busyApprovalId = null;
    notify(host);
  }
}

// ── Live updates ───────────────────────────────────────────────────────────

let workEventUnsubscribe: (() => void) | null = null;
let workEventTimer: number | null = null;

/**
 * Subscribes to `agency.work.updated`. The payload is an invalidation signal,
 * not a record, so this debounces a normal refetch rather than trying to patch
 * state from the event — the established convention (see
 * `components/subagent-activity-panel.ts`).
 */
export function subscribeAgencyWorkUpdates(
  host: AgencyDailyHost,
  client: GatewayBrowserClient,
): void {
  if (workEventUnsubscribe) return;
  workEventUnsubscribe = client.subscribe((event) => {
    if (event.event !== WORK_ITEM_EVENT) return;
    const state = host.agencyDailyState;
    if (!state) return;
    const payload = (event.payload ?? {}) as { agencyId?: string };
    if (payload.agencyId && state.agencyId && payload.agencyId !== state.agencyId) return;
    state.liveAt = Date.now();
    // Do not refetch a surface nobody is looking at; the next visit reloads.
    // On the merged Command page the board is the "Today" sub-tab.
    if (host.tab && contentTabOf({ tab: host.tab, hostView: host.hostView }) !== "agency-daily") return;
    if (workEventTimer !== null) return;
    workEventTimer = window.setTimeout(() => {
      workEventTimer = null;
      void loadAgencyDaily(host, client, { background: true });
    }, 400);
  });
}
