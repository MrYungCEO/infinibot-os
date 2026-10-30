/**
 * Orchestration for automatic task routing.
 *
 * `task-routing.ts` decides; this module reads, writes and stages. It is the
 * only place that touches agency.db on behalf of routing, and it is built so a
 * pass over an unchanged agency performs ZERO writes:
 *
 *   • every input is loaded with a fixed, small number of queries (tasks,
 *     projects, workers, capacities, decisions) — never one query per task;
 *   • a task whose content-and-pool signature already matches its stored
 *     decision is skipped before it is ever scored;
 *   • `upsertDecision` compares the whole row and declines to write an
 *     identical one.
 *
 * ── AUTONOMY AND SPEND ──────────────────────────────────────────────────────
 * Routing can auto-stage a card into the execution column, which is what lets
 * an AI employee actually start work without a human clicking. That is real
 * money, so every stage is bounded three ways: policy `mode`, a per-pass cap,
 * and a rolling 24-hour cap. On top of that the executor keeps its own
 * `maxItemsPerPass` / `maxConcurrency` limits, and `decideAutonomy` still
 * decides whether the result lands in `review` or `completed`. Nothing here can
 * make an autonomy-0 employee execute.
 */

import type { AgencyProject, AgencyTask } from "../agency-operations/types.js";
import type { WorkforceOperatingStore } from "./operating-store.js";
import {
  DEFAULT_TASK_ROUTING_POLICY,
  type StoredRoutingDecision,
  type TaskAutostageMode,
  type TaskRoutingPolicy,
  type WorkforceRoutingStore,
} from "./routing-store.js";
import type { WorkforceStore } from "./store.js";
import {
  NON_ROUTABLE_PROJECT_STATUSES,
  ROUTABLE_TASK_STATUSES,
  planTaskRouting,
  type RoutableProject,
  type RoutableTask,
  type TaskRoutingDecision,
  type TaskRoutingLimits,
  type TaskRoutingPlan,
} from "./task-routing.js";
import type { EmployeeWorkItem, WorkItemPriority } from "./types.js";

/** Context marker on every work item routing creates. */
export const TASK_ROUTING_CONTEXT_SOURCE = "task-routing";

/** Structural slice of `AgencyOperationsStore` routing needs. */
export type RoutingOperationsPort = {
  listTasks(agencyId: string, filters?: { projectId?: string }): AgencyTask[];
  listProjects(agencyId: string, status?: AgencyProject["status"]): AgencyProject[];
  getTask(agencyId: string, id: string): AgencyTask | null;
  updateTask(
    agencyId: string,
    id: string,
    patch: { assigneeType?: AgencyTask["assigneeType"]; assigneeId?: string | null },
    actorId?: string,
  ): AgencyTask;
};

export type RoutingWorkerPort = Pick<
  WorkforceStore,
  "listWorkers" | "getWorker" | "getWorkloadSummary" | "recordAudit"
>;

export type RoutingOperatingPort = Pick<
  WorkforceOperatingStore,
  "enqueueWorkItem" | "getWorkItem" | "listWorkItems" | "transitionWorkItem"
>;

export type TaskRouterDeps = {
  operationsStore: RoutingOperationsPort;
  workerStore: RoutingWorkerPort;
  operatingStore: RoutingOperatingPort;
  routingStore: WorkforceRoutingStore;
  broadcast?: (event: string, payload: unknown) => void;
  now?: () => number;
};

export type TaskRoutingRunOptions = {
  /** Overrides applied on top of the stored policy for this run only. */
  limits?: Partial<TaskRoutingLimits>;
  mode?: TaskAutostageMode;
  /** Cap on decisions returned in the payload. Does not change what is written. */
  maxDecisionsReturned?: number;
  actorId?: string;
  /** Re-evaluate every candidate, ignoring stored signatures. */
  force?: boolean;
};

export type TaskRoutingPassResult = {
  agencyId: string;
  enabled: boolean;
  mode: TaskAutostageMode;
  /** Tasks that passed the candidate filter. */
  candidates: number;
  /** Candidates whose stored decision was still valid. Zero work performed. */
  skipped: number;
  /** Candidates a human pinned via override/unassign. Never revisited. */
  pinned: number;
  /** Candidates left for the next pass because a per-pass cap was hit. */
  deferred: number;
  assigned: number;
  unmatched: number;
  needsHuman: number;
  autoStaged: number;
  stageRecommended: number;
  workItemsCreated: number;
  /** Rows actually written. 0 on a converged agency — the whole point. */
  writes: number;
  /** Remaining auto-stage budget after this pass (per-day cap). */
  autoStageBudgetLeft: number;
  load: TaskRoutingPlan["load"];
  decisions: StoredRoutingDecision[] | TaskRoutingDecision[];
  durationMs: number;
};

const DAY_MS = 86_400_000;

function limitsFrom(
  policy: TaskRoutingPolicy,
  overrides?: Partial<TaskRoutingLimits>,
): TaskRoutingLimits {
  return {
    minScore: overrides?.minScore ?? policy.minScore,
    minMatchStrength: overrides?.minMatchStrength ?? policy.minMatchStrength,
    maxAssignmentsPerPass: overrides?.maxAssignmentsPerPass ?? policy.maxAssignmentsPerPass,
    maxTasksPerWorkerPerPass:
      overrides?.maxTasksPerWorkerPerPass ?? policy.maxTasksPerWorkerPerPass,
    capacityHeadroom: overrides?.capacityHeadroom ?? policy.capacityHeadroom,
    defaultEstimatedHours: overrides?.defaultEstimatedHours ?? policy.defaultEstimatedHours,
  };
}

function toRoutable(task: AgencyTask): RoutableTask {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description ?? "",
    acceptanceCriteria: task.acceptanceCriteria ?? "",
    status: task.status,
    priority: task.priority,
    assigneeType: task.assigneeType,
    assigneeId: task.assigneeId,
    dueAt: task.dueAt,
  };
}

/**
 * Load everything one pass needs with a fixed number of queries, and work out
 * which tasks are genuinely routable.
 *
 * A task is a candidate when it is in a routable status, its project is alive,
 * and it is either unassigned or still sitting on the worker WE routed it to.
 * A task a human reassigned by hand is deliberately left alone.
 */
function collect(deps: TaskRouterDeps, agencyId: string) {
  const tasks = deps.operationsStore.listTasks(agencyId);
  const projects = new Map<string, RoutableProject>(
    deps.operationsStore
      .listProjects(agencyId)
      .map((project) => [
        project.id,
        { id: project.id, name: project.name, status: project.status },
      ]),
  );
  const decisions = deps.routingStore.decisionIndex(agencyId);

  const candidates: RoutableTask[] = [];
  const routedHours = new Map<string, number>();
  const pinnedTaskIds = new Set<string>();
  const unchangedSignatures = new Map<string, string>();

  for (const task of tasks) {
    const decision = decisions.get(task.id);
    const terminal = task.status === "done" || task.status === "cancelled";

    // Load already committed by open work routed to a worker, so a second pass
    // cannot re-fill a bench that is already full.
    if (!terminal && task.assigneeId && task.assigneeType === "ai") {
      const hours = decision?.estimatedHours ?? DEFAULT_TASK_ROUTING_POLICY.defaultEstimatedHours;
      routedHours.set(task.assigneeId, (routedHours.get(task.assigneeId) ?? 0) + hours);
    }

    if (terminal) continue;
    if (!ROUTABLE_TASK_STATUSES.has(task.status)) continue;
    const project = projects.get(task.projectId);
    if (project && NON_ROUTABLE_PROJECT_STATUSES.has(project.status)) continue;

    if (decision?.pinned) {
      pinnedTaskIds.add(task.id);
      candidates.push(toRoutable(task));
      continue;
    }
    // Assigned by a human, not by us: theirs to manage.
    if (task.assigneeId && decision?.workerId !== task.assigneeId) continue;

    // Only a SETTLED decision may short-circuit the next pass.
    //
    //  • `assigned`                  settled: the task has an owner.
    //  • `unmatched` with no discipline
    //                                settled: the task's own words say nothing
    //                                routable, and that only changes when a
    //                                human rewrites them — which moves the
    //                                signature anyway.
    //  • `unmatched` WITH a discipline
    //                                NOT settled. Understood work that nobody
    //                                could take today (bench full, everyone at
    //                                their per-pass limit) must be retried once
    //                                capacity frees up, or a busy week would
    //                                bury it forever. Re-scoring is cheap and
    //                                an unchanged verdict still writes nothing.
    const settled =
      decision &&
      (decision.outcome === "assigned" ||
        (decision.outcome === "unmatched" && decision.discipline === null));
    if (settled) unchangedSignatures.set(task.id, decision!.signature);
    candidates.push(toRoutable(task));
  }

  return {
    tasks,
    projects,
    decisions,
    candidates,
    routedHours,
    pinnedTaskIds,
    unchangedSignatures,
  };
}

function priorityOf(task: RoutableTask): WorkItemPriority {
  return task.priority;
}

/** Build the plan without writing anything. Shared by preview and apply. */
function plan(deps: TaskRouterDeps, agencyId: string, options: TaskRoutingRunOptions = {}) {
  const policy = deps.routingStore.getPolicy(agencyId);
  const limits = limitsFrom(policy, options.limits);
  const mode = options.mode ?? policy.mode;
  const collected = collect(deps, agencyId);
  const workers = deps.workerStore.listWorkers(agencyId, { status: "active" });
  const capacities = new Map(
    deps.workerStore.getWorkloadSummary(agencyId).map((entry) => [entry.workerId, entry]),
  );

  const now = deps.now?.() ?? Date.now();
  const stagedToday = deps.routingStore.countAutoStagedSince(agencyId, now - DAY_MS);
  const budget = Math.max(
    0,
    Math.min(policy.maxAutoStagePerPass, policy.maxAutoStagePerDay - stagedToday),
  );

  const result = planTaskRouting({
    agencyId,
    tasks: collected.candidates,
    projects: collected.projects,
    workers,
    capacities,
    routedHours: collected.routedHours,
    unchangedSignatures: options.force ? new Map() : collected.unchangedSignatures,
    pinnedTaskIds: collected.pinnedTaskIds,
    limits,
    autostage: {
      mode: policy.enabled ? mode : "off",
      minConfidence: policy.minConfidence,
      minAutonomyLevel: policy.minAutonomyLevel,
      budget,
      workerModes: policy.workerModes,
    },
  });

  return { policy, limits, mode, collected, workers, plan: result, budget, stagedToday, now };
}

/**
 * Dry run: exactly what WOULD be assigned, to whom, and why. Writes nothing at
 * all — no decisions, no work items, no task updates, no audit rows.
 */
export function previewTaskRouting(
  deps: TaskRouterDeps,
  agencyId: string,
  options: TaskRoutingRunOptions = {},
): TaskRoutingPassResult {
  const startedAt = Date.now();
  const context = plan(deps, agencyId, options);
  const decisions = context.plan.decisions;
  return {
    agencyId,
    enabled: context.policy.enabled,
    mode: context.mode,
    candidates: context.collected.candidates.length,
    skipped: context.plan.skipped,
    pinned: context.plan.pinned,
    deferred: context.plan.deferred,
    assigned: decisions.filter((entry) => entry.outcome === "assigned").length,
    unmatched: decisions.filter((entry) => entry.outcome === "unmatched").length,
    needsHuman: decisions.filter((entry) => entry.needsHuman).length,
    autoStaged: decisions.filter((entry) => entry.autoStaged).length,
    stageRecommended: decisions.filter((entry) => entry.stageRecommended).length,
    workItemsCreated: 0,
    writes: 0,
    autoStageBudgetLeft: context.budget,
    load: context.plan.load,
    decisions: decisions.slice(0, options.maxDecisionsReturned ?? 100),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Route for real: assign the task, create the employee's Backlog card, and —
 * when policy and confidence allow — stage it for execution.
 *
 * Incremental and idempotent. A second call with nothing changed returns
 * `writes: 0` and touches no table.
 */
export function applyTaskRouting(
  deps: TaskRouterDeps,
  agencyId: string,
  options: TaskRoutingRunOptions = {},
): TaskRoutingPassResult {
  const startedAt = Date.now();

  // `enabled` is the master switch for the pass itself, not just for staging.
  // Turning routing off must mean nothing is read, scored or written — an
  // operator who disables a subsystem is entitled to expect it to be inert.
  const policy = deps.routingStore.getPolicy(agencyId);
  if (!policy.enabled) {
    return {
      agencyId,
      enabled: false,
      mode: policy.mode,
      candidates: 0,
      skipped: 0,
      pinned: 0,
      deferred: 0,
      assigned: 0,
      unmatched: 0,
      needsHuman: 0,
      autoStaged: 0,
      stageRecommended: 0,
      workItemsCreated: 0,
      writes: 0,
      autoStageBudgetLeft: 0,
      load: [],
      decisions: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const context = plan(deps, agencyId, options);
  const now = context.now;
  const actorId = options.actorId ?? "agency-operating-loop";

  let writes = 0;
  let workItemsCreated = 0;
  let autoStaged = 0;
  const stored: StoredRoutingDecision[] = [];

  for (const decision of context.plan.decisions) {
    let workItem: EmployeeWorkItem | null = null;
    let stagedAt: number | null = null;
    let staged = false;

    if (decision.outcome === "assigned" && decision.workerId) {
      const task = deps.operationsStore.getTask(agencyId, decision.taskId);
      if (!task) continue;
      if (task.assigneeId !== decision.workerId || task.assigneeType !== "ai") {
        deps.operationsStore.updateTask(
          agencyId,
          decision.taskId,
          { assigneeId: decision.workerId, assigneeType: "ai" },
          actorId,
        );
        writes += 1;
      }

      const worker = deps.workerStore.getWorker(agencyId, decision.workerId);
      // Idempotent per task: the same key returns the existing card instead of
      // creating a duplicate on every pass.
      workItem = deps.operatingStore.enqueueWorkItem(agencyId, {
        workerId: decision.workerId,
        managerWorkerId: worker?.managerWorkerId ?? null,
        responsibilityId: null,
        title: task.title,
        instructions: routingInstructions(task, decision),
        priority: priorityOf(toRoutable(task)),
        scheduledFor: now,
        dueAt: task.dueAt,
        idempotencyKey: `task-route:${decision.taskId}`,
        context: {
          source: TASK_ROUTING_CONTEXT_SOURCE,
          taskId: task.id,
          projectId: task.projectId,
          discipline: decision.discipline,
          confidence: decision.confidence,
          routedBy: actorId,
          // Drives `decideAutonomy` for level-2 employees. AI workers cost
          // nothing per hour in this model, so routine routed work sits inside
          // the approval threshold and anything expensive must be declared.
          estimatedCost: 0,
        },
      });
      // "Created" means this pass produced a card that did not exist before.
      // `enqueueWorkItem` returns the existing row for a known idempotency key,
      // so comparing against the recorded id is exact and clock-independent.
      if (context.collected.decisions.get(decision.taskId)?.workItemId !== workItem.id) {
        workItemsCreated += 1;
        writes += 1;
      }

      if (decision.autoStaged && workItem.status === "queued") {
        deps.operatingStore.transitionWorkItem(agencyId, workItem.id, "accepted", { now });
        staged = true;
        stagedAt = now;
        autoStaged += 1;
        writes += 1;
        deps.broadcast?.("agency.routing.staged", {
          agencyId,
          taskId: decision.taskId,
          taskTitle: decision.taskTitle,
          workItemId: workItem.id,
          workerId: decision.workerId,
          workerName: decision.workerName,
          confidence: decision.confidence,
          score: decision.score,
          rationale: decision.rationale,
          stagedAt: now,
        });
      }
    }

    const written = deps.routingStore.upsertDecision(
      agencyId,
      { ...decision, autoStaged: staged },
      {
        decidedBy: "auto",
        workItemId: workItem?.id ?? null,
        ...(staged ? { stagedAt } : {}),
        autoStaged: staged,
        now,
      },
    );
    if (written.changed) writes += 1;
    stored.push(written.decision);
  }

  const assigned = context.plan.decisions.filter((entry) => entry.outcome === "assigned").length;
  const unmatched = context.plan.decisions.filter((entry) => entry.outcome === "unmatched").length;

  // ONE audit row per pass that changed something. Never one per entity: that
  // is exactly what once grew this database to 633 MB.
  if (writes > 0) {
    deps.workerStore.recordAudit(
      agencyId,
      actorId,
      "task.routing.applied",
      "task_routing",
      `pass:${now}`,
      null,
      { assigned, unmatched, autoStaged, workItemsCreated, writes },
    );
  }

  const result: TaskRoutingPassResult = {
    agencyId,
    enabled: context.policy.enabled,
    mode: context.mode,
    candidates: context.collected.candidates.length,
    skipped: context.plan.skipped,
    pinned: context.plan.pinned,
    deferred: context.plan.deferred,
    assigned,
    unmatched,
    needsHuman: context.plan.decisions.filter((entry) => entry.needsHuman).length,
    autoStaged,
    stageRecommended: context.plan.decisions.filter((entry) => entry.stageRecommended).length,
    workItemsCreated,
    writes,
    autoStageBudgetLeft: Math.max(0, context.budget - autoStaged),
    load: context.plan.load,
    decisions: stored.slice(0, options.maxDecisionsReturned ?? 100),
    durationMs: Date.now() - startedAt,
  };
  if (writes > 0) deps.broadcast?.("agency.routing.pass", { ...result, decisions: undefined });
  return result;
}

function routingInstructions(task: AgencyTask, decision: TaskRoutingDecision): string {
  const lines = [`# ${task.title}`, ""];
  if (task.description?.trim()) lines.push(task.description.trim(), "");
  if (task.acceptanceCriteria?.trim()) {
    lines.push("## Acceptance criteria", task.acceptanceCriteria.trim(), "");
  }
  lines.push("## Why you", decision.rationale, "");
  lines.push(
    "If you need context, hit a decision above your approval threshold, or are blocked,",
    "escalate rather than guess.",
  );
  return lines.join("\n");
}

// ── Batch staging ───────────────────────────────────────────────────────────

export type StageRoutedWorkResult = {
  agencyId: string;
  staged: number;
  skipped: number;
  items: Array<{ taskId: string; workItemId: string; workerId: string; workerName: string | null }>;
};

/**
 * Stage a BATCH of routed cards in one action: "stage everything recommended
 * for Wren" instead of twenty separate clicks. Explicitly operator-driven, so
 * it ignores the autostage confidence gate but still refuses cards whose
 * employee can never execute (autonomy 0) and still honours the transition
 * machine.
 */
export function stageRoutedWork(
  deps: TaskRouterDeps,
  agencyId: string,
  input: { workerId?: string; taskIds?: string[]; limit?: number; actorId?: string },
): StageRoutedWorkResult {
  const now = deps.now?.() ?? Date.now();
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const decisions = input.taskIds?.length
    ? input.taskIds
        .map((taskId) => deps.routingStore.getDecision(agencyId, taskId))
        .filter((entry): entry is StoredRoutingDecision => Boolean(entry))
    : deps.routingStore.listDecisions(agencyId, {
        workerId: input.workerId,
        outcome: "assigned",
        stageRecommended: true,
        autoStaged: false,
        limit,
      });

  const result: StageRoutedWorkResult = { agencyId, staged: 0, skipped: 0, items: [] };
  for (const decision of decisions.slice(0, limit)) {
    if (decision.outcome !== "assigned" || !decision.workerId || !decision.workItemId) {
      result.skipped += 1;
      continue;
    }
    const worker = deps.workerStore.getWorker(agencyId, decision.workerId);
    if (!worker || worker.autonomyLevel <= 0) {
      result.skipped += 1;
      continue;
    }
    const item = deps.operatingStore.getWorkItem(agencyId, decision.workItemId);
    if (!item || item.status !== "queued") {
      result.skipped += 1;
      continue;
    }
    deps.operatingStore.transitionWorkItem(agencyId, item.id, "accepted", { now });
    deps.routingStore.upsertDecision(
      agencyId,
      { ...decision, autoStaged: true, stageReason: "staged by operator (batch)" },
      {
        decidedBy: decision.decidedBy,
        pinned: decision.pinned,
        autoStaged: true,
        stagedAt: now,
        now,
      },
    );
    result.staged += 1;
    result.items.push({
      taskId: decision.taskId,
      workItemId: item.id,
      workerId: decision.workerId,
      workerName: decision.workerName,
    });
    deps.broadcast?.("agency.routing.staged", {
      agencyId,
      taskId: decision.taskId,
      taskTitle: decision.taskTitle,
      workItemId: item.id,
      workerId: decision.workerId,
      workerName: decision.workerName,
      confidence: decision.confidence,
      score: decision.score,
      rationale: decision.rationale,
      stagedAt: now,
      trigger: "operator",
    });
  }
  if (result.staged) {
    deps.workerStore.recordAudit(
      agencyId,
      input.actorId,
      "task.routing.staged",
      "task_routing",
      `stage:${now}`,
      null,
      { staged: result.staged, workerId: input.workerId ?? null },
    );
  }
  return result;
}

// ── Operator overrides ──────────────────────────────────────────────────────

/**
 * Reassign one task by hand. The resulting decision is PINNED: the router never
 * revisits a task a human has ruled on, so an override survives every
 * subsequent pass.
 */
export function overrideTaskRouting(
  deps: TaskRouterDeps,
  agencyId: string,
  input: { taskId: string; workerId: string; actorId?: string; note?: string },
): StoredRoutingDecision {
  const now = deps.now?.() ?? Date.now();
  const task = deps.operationsStore.getTask(agencyId, input.taskId);
  if (!task) throw new Error("task not found");
  const worker = deps.workerStore.getWorker(agencyId, input.workerId);
  if (!worker) throw new Error("employee not found");

  const before = deps.routingStore.getDecision(agencyId, input.taskId);
  deps.operationsStore.updateTask(
    agencyId,
    input.taskId,
    { assigneeId: worker.id, assigneeType: worker.type === "ai" ? "ai" : "human" },
    input.actorId,
  );

  let workItemId = before?.workItemId ?? null;
  if (worker.type === "ai") {
    const item = deps.operatingStore.enqueueWorkItem(agencyId, {
      workerId: worker.id,
      managerWorkerId: worker.managerWorkerId,
      responsibilityId: null,
      title: task.title,
      instructions: [task.description, task.acceptanceCriteria].filter(Boolean).join("\n\n"),
      priority: task.priority,
      scheduledFor: now,
      dueAt: task.dueAt,
      idempotencyKey: `task-route:${task.id}:${worker.id}`,
      context: {
        source: TASK_ROUTING_CONTEXT_SOURCE,
        taskId: task.id,
        projectId: task.projectId,
        assignedBy: input.actorId ?? "operator",
        estimatedCost: 0,
      },
    });
    workItemId = item.id;
  }

  const written = deps.routingStore.upsertDecision(
    agencyId,
    {
      agencyId,
      taskId: task.id,
      projectId: task.projectId,
      taskTitle: task.title,
      outcome: "assigned",
      workerId: worker.id,
      workerName: worker.displayName,
      assigneeType: worker.type === "ai" ? "ai" : "human",
      discipline: before?.discipline ?? null,
      matchStrength: before?.matchStrength ?? 0,
      matchedTerms: before?.matchedTerms ?? [],
      score: before?.score ?? 0,
      skillCoverage: before?.skillCoverage ?? 0,
      confidence: 1,
      matchedSkills: before?.matchedSkills ?? [],
      missingSkills: before?.missingSkills ?? [],
      estimatedHours: before?.estimatedHours ?? DEFAULT_TASK_ROUTING_POLICY.defaultEstimatedHours,
      runnerUp: before?.runnerUp ?? null,
      rationale: `Assigned to ${worker.displayName} by ${input.actorId ?? "an operator"}${input.note ? `: ${input.note}` : "."}`,
      needsHuman: false,
      autoStaged: false,
      stageRecommended: worker.autonomyLevel > 0,
      stageReason: "operator override: stage explicitly when ready",
      signature: before?.signature ?? "",
    },
    { decidedBy: "operator", pinned: true, workItemId, stagedAt: null, autoStaged: false, now },
  );

  deps.workerStore.recordAudit(
    agencyId,
    input.actorId,
    "task.routing.override",
    "agency_task",
    task.id,
    before ?? null,
    written.decision,
  );
  return written.decision;
}

/**
 * Remove an assignment by hand. Also pinned — "leave this alone" is an
 * instruction, not a gap for the router to helpfully refill on the next tick.
 * The employee's card is cancelled so it stops appearing in their inbox.
 */
export function unassignTask(
  deps: TaskRouterDeps,
  agencyId: string,
  input: { taskId: string; actorId?: string; note?: string; unpin?: boolean },
): StoredRoutingDecision | null {
  const now = deps.now?.() ?? Date.now();
  const task = deps.operationsStore.getTask(agencyId, input.taskId);
  if (!task) throw new Error("task not found");
  const before = deps.routingStore.getDecision(agencyId, input.taskId);

  if (task.assigneeId) {
    deps.operationsStore.updateTask(
      agencyId,
      input.taskId,
      { assigneeId: null, assigneeType: null },
      input.actorId,
    );
  }
  if (before?.workItemId) {
    const item = deps.operatingStore.getWorkItem(agencyId, before.workItemId);
    if (item && ["queued", "accepted", "in_progress", "waiting"].includes(item.status)) {
      deps.operatingStore.transitionWorkItem(agencyId, item.id, "cancelled", { now });
    }
  }

  // `unpin: true` hands the task back to the router on the next pass.
  if (input.unpin) {
    deps.routingStore.deleteDecision(agencyId, input.taskId);
    deps.workerStore.recordAudit(
      agencyId,
      input.actorId,
      "task.routing.unassigned",
      "agency_task",
      task.id,
      before ?? null,
      null,
    );
    return null;
  }

  const written = deps.routingStore.upsertDecision(
    agencyId,
    {
      agencyId,
      taskId: task.id,
      projectId: task.projectId,
      taskTitle: task.title,
      outcome: "unassigned",
      workerId: null,
      workerName: null,
      assigneeType: null,
      discipline: before?.discipline ?? null,
      matchStrength: before?.matchStrength ?? 0,
      matchedTerms: before?.matchedTerms ?? [],
      score: 0,
      skillCoverage: 0,
      confidence: 0,
      matchedSkills: [],
      missingSkills: [],
      estimatedHours: before?.estimatedHours ?? 0,
      runnerUp: null,
      rationale: `Unassigned by ${input.actorId ?? "an operator"}${input.note ? `: ${input.note}` : "."} The router will not revisit it.`,
      needsHuman: true,
      autoStaged: false,
      stageRecommended: false,
      stageReason: "not staged: unassigned by operator",
      signature: before?.signature ?? "",
    },
    {
      decidedBy: "operator",
      pinned: true,
      workItemId: null,
      stagedAt: null,
      autoStaged: false,
      now,
    },
  );
  deps.workerStore.recordAudit(
    agencyId,
    input.actorId,
    "task.routing.unassigned",
    "agency_task",
    task.id,
    before ?? null,
    written.decision,
  );
  return written.decision;
}
