import { join } from "node:path";

import {
  WorkItemExecutor,
  createWorkItemExecutorConfig,
  type AgencyOperatingLoopExecutionConfig,
  type WorkItemExecutionPassResult,
} from "../workforce/executor.js";
import { WorkforceOperatingStore } from "../workforce/operating-store.js";
import { WorkforceRoutingStore } from "../workforce/routing-store.js";
import { WorkforceSopStore } from "../workforce/sop-store.js";
import { getWorkforceStore } from "../workforce/store.js";
import { applyTaskRouting, type TaskRoutingPassResult } from "../workforce/task-router.js";
import type { OperatingLoopTickResult } from "../workforce/types.js";
import { ensureAgencyProvisioned, type AgencyProvisioningResult } from "./provisioning.js";
import { getAgencyOperationsStore } from "./store.js";

export type OperatingLoopLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type AgencyOperatingLoopDeps = {
  /** Every agency on this node. */
  listAgencyIds: () => string[];
  /** Runs `WorkforceOperatingStore.tick` for one agency. */
  tick: (agencyId: string) => OperatingLoopTickResult;
  /**
   * Triages the agency's real, unassigned `agency_tasks` onto the best-suited
   * AI employee before the tick, so new work reaches the workforce without a
   * human opening a dialog. Idempotent and incremental: an agency with nothing
   * new performs no writes at all.
   *
   * Optional: when absent, the loop behaves exactly as it did before routing
   * existed.
   */
  routeTasks?: (agencyId: string) => TaskRoutingPassResult;
  /**
   * Brings a fresh (or long-neglected) agency up to the provisioning baseline:
   * the AI roles, the starter SOPs, their suggested schedules, and the routing
   * policy row. Recorded by version, so a provisioned agency costs four indexed
   * lookups per pass and writes nothing.
   */
  ensureProvisioned?: (agencyId: string) => Promise<AgencyProvisioningResult>;
  /**
   * Executes the work items a human STAGED (moved into the `accepted` board
   * column) for one agency after the tick. Freshly generated `queued` backlog
   * items are never picked up — moving the card is the approval.
   *
   * Optional on purpose: when absent (or when the executor is disabled by
   * config, which is the default) the loop behaves exactly as before and
   * nothing is ever spawned.
   */
  executeWorkItems?: (agencyId: string) => Promise<WorkItemExecutionPassResult>;
  log?: OperatingLoopLogger;
};

export type AgencyOperatingLoopSummary = {
  agencies: number;
  ticked: number;
  failed: number;
  generatedWorkItems: number;
  escalatedWorkItems: number;
  dueReviewCycles: number;
  /** Work items actually handed to a coder backend this pass. */
  executedWorkItems: number;
  /** Executed items that auto-completed. */
  completedWorkItems: number;
  /** Executed items parked for human review (low autonomy / over threshold). */
  reviewWorkItems: number;
  /** Executed items whose run failed and were escalated. */
  failedWorkItems: number;
  /** Real agency tasks assigned to an AI employee this pass. */
  routedTasks: number;
  /** Routed cards handed straight to the executor under the autostage policy. */
  autoStagedTasks: number;
  /** Tasks the router could not confidently place. These need a human. */
  unmatchedTasks: number;
  /** Agencies brought up to the provisioning baseline this pass. */
  provisionedAgencies: number;
  errors: Array<{ agencyId: string; message: string }>;
};

const noopLog: OperatingLoopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Tick the workforce operating loop for every agency on this node.
 *
 * A failure in one agency (corrupt row, locked database, missing worker) must
 * never stop the others: each tick is isolated, logged and counted, and the
 * function always resolves with a summary instead of throwing.
 */
export function runAgencyOperatingLoop(deps: AgencyOperatingLoopDeps): AgencyOperatingLoopSummary {
  const log = deps.log ?? noopLog;
  const summary: AgencyOperatingLoopSummary = {
    agencies: 0,
    ticked: 0,
    failed: 0,
    generatedWorkItems: 0,
    escalatedWorkItems: 0,
    dueReviewCycles: 0,
    executedWorkItems: 0,
    completedWorkItems: 0,
    reviewWorkItems: 0,
    failedWorkItems: 0,
    routedTasks: 0,
    autoStagedTasks: 0,
    unmatchedTasks: 0,
    provisionedAgencies: 0,
    errors: [],
  };

  let agencyIds: string[] = [];
  try {
    agencyIds = deps.listAgencyIds();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`agency operating loop: failed to list agencies: ${message}`);
    summary.errors.push({ agencyId: "*", message });
    return summary;
  }

  summary.agencies = agencyIds.length;
  for (const agencyId of agencyIds) {
    // Routing runs BEFORE the tick so work triaged this pass is already on the
    // right employee when escalation and SLA checks run. Isolated on purpose:
    // a routing failure must never stop an agency's operating tick.
    if (deps.routeTasks) {
      try {
        const routed = deps.routeTasks(agencyId);
        summary.routedTasks += routed.assigned;
        summary.autoStagedTasks += routed.autoStaged;
        summary.unmatchedTasks += routed.unmatched;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push({ agencyId, message });
        log.warn(`agency operating loop: routing failed for agency ${agencyId}: ${message}`);
      }
    }
    try {
      const result = deps.tick(agencyId);
      summary.ticked += 1;
      summary.generatedWorkItems += result.generatedWorkItemIds.length;
      summary.escalatedWorkItems += result.escalatedWorkItemIds.length;
      summary.dueReviewCycles += result.dueReviewCycleIds.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed += 1;
      summary.errors.push({ agencyId, message });
      log.warn(`agency operating loop: tick failed for agency ${agencyId}: ${message}`);
    }
  }

  if (
    summary.generatedWorkItems ||
    summary.escalatedWorkItems ||
    summary.dueReviewCycles ||
    summary.routedTasks
  ) {
    log.info(
      `agency operating loop: ${summary.ticked}/${summary.agencies} agencies ticked ` +
        `(generated=${summary.generatedWorkItems} escalated=${summary.escalatedWorkItems} ` +
        `reviewsDue=${summary.dueReviewCycles} routed=${summary.routedTasks} ` +
        `autoStaged=${summary.autoStagedTasks} unmatched=${summary.unmatchedTasks})`,
    );
  }
  return summary;
}

/**
 * One full pass: tick every agency (generate + escalate work), then execute the
 * cards a human has STAGED into the execution column. Generation never implies
 * execution — the board stage is the approval gate.
 *
 * Execution is opt-in and per-agency isolated: an agency whose execution throws
 * is counted as an error and the remaining agencies still run. The pass always
 * resolves.
 */
export async function runAgencyOperatingLoopPass(
  deps: AgencyOperatingLoopDeps,
): Promise<AgencyOperatingLoopSummary> {
  const log = deps.log ?? noopLog;

  // Provisioning runs first and is awaited: routing and the tick both depend on
  // the agency actually having employees, SOPs and schedules. On a provisioned
  // agency this is four indexed lookups per agency and no writes.
  const provisioned = new Set<string>();
  if (deps.ensureProvisioned) {
    let ids: string[] = [];
    try {
      ids = deps.listAgencyIds();
    } catch {
      ids = [];
    }
    for (const agencyId of ids) {
      try {
        const result = await deps.ensureProvisioned(agencyId);
        if (result.changed) provisioned.add(agencyId);
      } catch (error) {
        log.warn(
          `agency operating loop: provisioning failed for agency ${agencyId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  const summary = runAgencyOperatingLoop(deps);
  summary.provisionedAgencies = provisioned.size;
  if (!deps.executeWorkItems) return summary;

  let agencyIds: string[] = [];
  try {
    agencyIds = deps.listAgencyIds();
  } catch (error) {
    // Already reported by runAgencyOperatingLoop; nothing to execute against.
    log.warn(`agency operating loop: skipping execution: ${errorMessage(error)}`);
    return summary;
  }

  for (const agencyId of agencyIds) {
    try {
      const pass = await deps.executeWorkItems(agencyId);
      summary.executedWorkItems += pass.executed;
      summary.completedWorkItems += pass.completed;
      summary.reviewWorkItems += pass.review;
      summary.failedWorkItems += pass.escalated;
    } catch (error) {
      const message = errorMessage(error);
      summary.errors.push({ agencyId, message });
      log.warn(`agency operating loop: execution failed for agency ${agencyId}: ${message}`);
    }
  }

  if (summary.executedWorkItems) {
    log.info(
      `agency operating loop: executed ${summary.executedWorkItems} work items ` +
        `(completed=${summary.completedWorkItems} review=${summary.reviewWorkItems} ` +
        `escalated=${summary.failedWorkItems})`,
    );
  }
  return summary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let sharedOperatingStore: WorkforceOperatingStore | null = null;
let sharedSopStore: WorkforceSopStore | null = null;
let sharedRoutingStore: WorkforceRoutingStore | null = null;

/**
 * Default wiring against the canonical agency database. The operating store is
 * cached per process because better-sqlite3 handles are expensive to reopen.
 */
export function createAgencyOperatingLoopDeps(
  stateDir: string,
  log?: OperatingLoopLogger,
  options?: {
    /** The `cron.agencyOperatingLoop` config block. Execution is off unless
     *  `executeWorkItems` is explicitly true. */
    execution?: AgencyOperatingLoopExecutionConfig | null;
    /** Root that workers' relative `sopPath`/`workspacePath` resolve against. */
    workspaceRoot?: string;
    broadcast?: (event: string, payload: unknown) => void;
    /**
     * Cron service, so first-run provisioning creates REAL, operator-visible
     * SOP schedules rather than orphan rows. Omitting it still writes the
     * schedule and the responsibility.
     */
    cron?: Parameters<typeof ensureAgencyProvisioned>[0]["sopService"]["cron"];
    /** Set false to disable automatic task routing entirely on this node. */
    routeTasks?: boolean;
    /** Set false to disable automatic first-run provisioning on this node. */
    provision?: boolean;
  },
): AgencyOperatingLoopDeps {
  const dbPath = join(stateDir, "agency-operations", "agency.db");
  const operatingStore = () => (sharedOperatingStore ??= new WorkforceOperatingStore(dbPath));
  const sopStore = () => (sharedSopStore ??= new WorkforceSopStore(dbPath));
  const routingStore = () => (sharedRoutingStore ??= new WorkforceRoutingStore(dbPath));
  const executorConfig = createWorkItemExecutorConfig(options?.execution);

  const deps: AgencyOperatingLoopDeps = {
    listAgencyIds: () =>
      getAgencyOperationsStore(stateDir)
        .listAgencies()
        .map((a) => a.id),
    tick: (agencyId) => operatingStore().tick(agencyId),
    log,
  };

  // Proactive by default: without this the workforce only ever sees work a
  // human typed into the Assign-work dialog, which is precisely the failure
  // this loop exists to fix. The autostage POLICY (per agency, per worker)
  // decides whether a routed card is merely queued or handed to the executor.
  if (options?.routeTasks !== false) {
    deps.routeTasks = (agencyId) =>
      applyTaskRouting(
        {
          operationsStore: getAgencyOperationsStore(stateDir),
          workerStore: getWorkforceStore(dbPath),
          operatingStore: operatingStore(),
          routingStore: routingStore(),
          broadcast: options?.broadcast,
        },
        agencyId,
        { actorId: "agency-operating-loop" },
      );
  }

  if (options?.provision !== false) {
    deps.ensureProvisioned = (agencyId) =>
      ensureAgencyProvisioned(
        {
          workerStore: getWorkforceStore(dbPath),
          sopStore: sopStore(),
          routingStore: routingStore(),
          sopService: { operatingStore: operatingStore(), cron: options?.cron ?? null },
        },
        agencyId,
        "agency-operating-loop",
      );
  }

  // SAFETY: only attach the executor when the operator has opted in. With the
  // flag off we do not even construct it, so no code path can spawn a CLI.
  if (executorConfig.enabled) {
    let executor: WorkItemExecutor | null = null;
    deps.executeWorkItems = (agencyId) => {
      executor ??= new WorkItemExecutor({
        operatingStore: operatingStore(),
        workerStore: getWorkforceStore(dbPath),
        // Stored, operator-editable SOPs take precedence over `sopPath` on disk.
        sopStore: (sharedSopStore ??= new WorkforceSopStore(dbPath)),
        config: executorConfig,
        workspaceRoot: options?.workspaceRoot ?? stateDir,
        broadcast: options?.broadcast,
        log,
      });
      return executor.executeStagedWorkItems(agencyId);
    };
  }
  return deps;
}

export type AgencyOperatingLoopScheduler = {
  /** Run one full pass immediately (tick + optional execution). */
  runOnce: () => Promise<AgencyOperatingLoopSummary>;
  stop: () => void;
  intervalMs: number;
};

export type AgencyOperatingLoopSchedulerOptions = {
  deps: AgencyOperatingLoopDeps;
  intervalMs: number;
  /**
   * Consulted before every pass so pausing the `agency-operating-loop` cron job
   * in Settings actually pauses the loop. Defaults to always-enabled.
   */
  isEnabled?: () => boolean | Promise<boolean>;
  /** Run one pass immediately on start. Defaults to false (wait one interval). */
  runOnStart?: boolean;
  log?: OperatingLoopLogger;
};

/**
 * Drives `runAgencyOperatingLoop` on an interval. Kept separate from the cron
 * service because cron payloads are agent nudges (systemEvent / agentTurn) and
 * cannot invoke in-process code; the tick must run regardless of whether an
 * agent session is alive.
 */
export function startAgencyOperatingLoopScheduler(
  options: AgencyOperatingLoopSchedulerOptions,
): AgencyOperatingLoopScheduler {
  const log = options.log ?? options.deps.log ?? noopLog;
  const deps: AgencyOperatingLoopDeps = { ...options.deps, log };
  const intervalMs = Math.max(1_000, options.intervalMs);
  let running = false;

  const runOnce = () => runAgencyOperatingLoopPass(deps);

  const tickIfEnabled = async () => {
    if (running) return;
    running = true;
    try {
      if (options.isEnabled && !(await options.isEnabled())) return;
      await runOnce();
    } catch (error) {
      log.error(`agency operating loop: scheduler pass failed: ${String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tickIfEnabled(), intervalMs);
  timer.unref?.();
  if (options.runOnStart) void tickIfEnabled();

  return {
    runOnce,
    stop: () => clearInterval(timer),
    intervalMs,
  };
}
