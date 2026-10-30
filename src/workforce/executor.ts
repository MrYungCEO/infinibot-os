/**
 * Worker execution service — turns a STAGED `EmployeeWorkItem` into an actual
 * run of the employee's bound coder backend.
 *
 * ── The board stage is the control surface ─────────────────────────────────
 * The cron operating loop generates work items, but generation alone NEVER
 * causes anything to run. A freshly generated item is `queued`, which is the
 * board's backlog column and is explicitly NOT executable. Work runs only once
 * a human (or an authorised manager) drags the card into the `accepted` column
 * — i.e. calls `agency.ops.employee.work-item.transition` with
 * status `accepted`. Moving the card IS the approval.
 *
 * `accepted` is the natural staging state and needs no new lifecycle state: the
 * existing machine already reads `queued -> accepted -> in_progress -> …`, and
 * `queued -> in_progress` is not a legal transition, so the state machine in
 * `lifecycle.ts` remains authoritative and structurally prevents a backlog item
 * from being executed.
 *
 * Given an `accepted` work item the executor:
 *   1. resolves the worker's `modelBinding` to a `CoderBackendId`,
 *   2. loads the worker's SOP from `sopPath` (best effort — a missing SOP is
 *      not an error, the run just proceeds without it),
 *   3. composes a prompt from persona + goals + KPIs + SOP + job memory +
 *      the work item's own instructions,
 *   4. drives the item `accepted -> in_progress -> review|completed`
 *      (or `escalated` on failure), never skipping a state, and
 *   5. records the outcome into per-employee job memory.
 *
 * SAFETY: nothing here spawns anything unless the caller opts in. The
 * operating-loop wiring is gated on `cron.agencyOperatingLoop.executeWorkItems`
 * which defaults to **false** (see `createWorkItemExecutorConfig`); with it off,
 * staging a card does nothing at all. Every effectful dependency (spawn,
 * filesystem, clock, broadcast) is injected so tests never touch a real CLI.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { spawnCoderWithFallback } from "../agents/coder-backend/spawn-with-fallback.js";
import type { CoderBackendId } from "../agents/coder-backend/types.js";
import type { EmployeeWorkItem, JobMemoryRecord, Worker, WorkItemStatus } from "./types.js";
import { assertWorkItemTransition } from "./lifecycle.js";
import {
  planResponse,
  renderCommunicationPrompt,
  resolveCommunicationProfile,
  type CommunicationProfile,
  type ScheduleWindow,
} from "./communication.js";
import { describeChannelBindings, type WorkerChannelBinding } from "./channel-bindings.js";
import {
  describeToolPolicy,
  resolveExecutionProfile,
  type WorkerExecutionProfile,
} from "./execution-profile.js";
import { renderSopMarkdown } from "./sop-store.js";
import type { Sop, SopSchedule } from "./sop-types.js";

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * The single board stage that means "a human staged this for autonomous work".
 * Items in any other stage — `queued` backlog included — are never executed.
 */
export const EXECUTION_STAGE = "accepted" as const satisfies WorkItemStatus;

/** Board stages an item may be executed from. Exactly one, by design. */
export const EXECUTION_ELIGIBLE_STAGES: readonly WorkItemStatus[] = [EXECUTION_STAGE];

/** True when the card sits in the column that authorises autonomous work. */
export function isExecutionEligibleStage(status: WorkItemStatus): boolean {
  return EXECUTION_ELIGIBLE_STAGES.includes(status);
}

export type WorkItemExecutorConfig = {
  /**
   * Master safety switch. When false (the default) `executeStagedWorkItems`
   * returns immediately having done nothing at all — staging a card is inert.
   */
  enabled: boolean;
  /** Maximum coder CLIs alive at once, across all workers, per pass. */
  maxConcurrency: number;
  /** Hard cap on how many work items a single pass may execute. */
  maxItemsPerPass: number;
  /** Per-item wall-clock budget handed to the backend. */
  timeoutMinutes: number;
  /** Backend to retry with when the bound backend fails to launch. */
  fallbackBackend?: CoderBackendId;
  /** Backend used when a worker has no (or an unknown) `modelBinding`. */
  defaultBackend: CoderBackendId;
  /** Characters of SOP text injected into the prompt. */
  maxSopChars: number;
  /** Characters of backend output retained in job memory. */
  maxOutputChars: number;
};

/** Shape of the optional `cron.agencyOperatingLoop` config block. */
export type AgencyOperatingLoopExecutionConfig = {
  executeWorkItems?: boolean;
  maxConcurrency?: number;
  maxItemsPerPass?: number;
  timeoutMinutes?: number;
  fallbackBackend?: CoderBackendId;
  defaultBackend?: CoderBackendId;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(value)));

/**
 * Build an executor config from the (optional) `cron.agencyOperatingLoop`
 * block. Defaults are deliberately conservative: **disabled**, two concurrent
 * CLIs, five items per pass.
 */
export function createWorkItemExecutorConfig(
  raw?: AgencyOperatingLoopExecutionConfig | null,
): WorkItemExecutorConfig {
  return {
    enabled: raw?.executeWorkItems === true,
    maxConcurrency: clamp(raw?.maxConcurrency ?? 2, 1, 8),
    maxItemsPerPass: clamp(raw?.maxItemsPerPass ?? 5, 1, 50),
    timeoutMinutes: clamp(raw?.timeoutMinutes ?? 20, 1, 240),
    fallbackBackend: raw?.fallbackBackend,
    defaultBackend: raw?.defaultBackend ?? "claude-code",
    maxSopChars: 8_000,
    maxOutputChars: 4_000,
  };
}

// ── Model binding → coder backend ───────────────────────────────────────────

const BACKEND_ALIASES: Record<string, CoderBackendId> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  claudecode: "claude-code",
  anthropic: "claude-code",
  codex: "codex",
  "codex-cli": "codex",
  openai: "codex",
  opencode: "opencode",
  "open-code": "opencode",
  gemini: "gemini",
  "gemini-cli": "gemini",
  google: "gemini",
  grok: "grok",
  "grok-cli": "grok",
  "grok-build": "grok",
  xai: "grok",
};

/**
 * Resolve a worker's free-form `modelBinding` ("claude", "codex",
 * "anthropic/claude-opus-4-6", …) to a concrete coder backend id.
 *
 * The provider segment of a `provider/model` binding wins, so
 * "anthropic/claude-opus-4-6" resolves to claude-code. Unknown or empty
 * bindings fall back to `fallback`.
 */
export function resolveBackendForBinding(
  modelBinding: string | null | undefined,
  fallback: CoderBackendId = "claude-code",
): CoderBackendId {
  const raw = (modelBinding ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  const direct = BACKEND_ALIASES[raw];
  if (direct) return direct;
  const provider = raw.split("/")[0]?.trim();
  if (provider && BACKEND_ALIASES[provider]) return BACKEND_ALIASES[provider];
  // Last resort: substring match so "claude-opus-4-6" still lands on Claude.
  for (const [alias, id] of Object.entries(BACKEND_ALIASES)) {
    if (raw.includes(alias)) return id;
  }
  return fallback;
}

// ── Autonomy policy ─────────────────────────────────────────────────────────

export type AutonomyDecision =
  | { execute: false; reason: string }
  | { execute: true; terminalStatus: "review" | "completed"; reason: string };

/**
 * AUTONOMY MAPPING (`Worker.autonomyLevel` 0-3, `Worker.approvalThreshold`):
 *
 *   0 — none / shadow.       NEVER executed, even when staged. The card stays
 *                            in `accepted` for a human to do by hand. An AI
 *                            employee at level 0 is observed, not trusted to
 *                            act.
 *   1 — draft only.          Executed, but the result ALWAYS lands in `review`.
 *                            Nothing a level-1 worker produces is ever
 *                            auto-accepted.
 *   2 — supervised.          Executed. Auto-`completed` only when the item's
 *                            declared cost/impact
 *                            (`context.estimatedCost`, default 0) is at or
 *                            below the worker's `approvalThreshold`; anything
 *                            more expensive lands in `review`.
 *   3 — autonomous.          Executed and auto-`completed` on success.
 *
 * Urgency never buys autonomy, and a FAILED run ignores this mapping entirely:
 * failures always `escalate` so a human sees them.
 */
export function decideAutonomy(
  worker: Pick<Worker, "autonomyLevel" | "approvalThreshold">,
  item: Pick<EmployeeWorkItem, "context">,
): AutonomyDecision {
  const level = worker.autonomyLevel;
  if (level <= 0) {
    return { execute: false, reason: "autonomyLevel 0: requires a human operator" };
  }
  if (level === 1) {
    return {
      execute: true,
      terminalStatus: "review",
      reason: "autonomyLevel 1: output is draft-only and always needs review",
    };
  }
  if (level === 2) {
    const raw = (item.context as Record<string, unknown> | undefined)?.estimatedCost;
    const cost = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    const threshold = Number.isFinite(worker.approvalThreshold) ? worker.approvalThreshold : 0;
    return cost <= threshold
      ? {
          execute: true,
          terminalStatus: "completed",
          reason: `autonomyLevel 2: estimatedCost ${cost} within approvalThreshold ${threshold}`,
        }
      : {
          execute: true,
          terminalStatus: "review",
          reason: `autonomyLevel 2: estimatedCost ${cost} exceeds approvalThreshold ${threshold}`,
        };
  }
  return {
    execute: true,
    terminalStatus: "completed",
    reason: "autonomyLevel 3: fully autonomous",
  };
}

// ── Injected dependencies ───────────────────────────────────────────────────

/** Structural subset of `WorkforceOperatingStore` the executor needs. */
export interface WorkItemExecutorOperatingStore {
  listWorkItems(
    agencyId: string,
    filters?: { workerId?: string; status?: WorkItemStatus; limit?: number },
  ): EmployeeWorkItem[];
  getWorkItem(agencyId: string, id: string): EmployeeWorkItem | null;
  transitionWorkItem(
    agencyId: string,
    id: string,
    status: WorkItemStatus,
    options?: { waitingReason?: string | null; reviewNote?: string | null; now?: number },
  ): EmployeeWorkItem;
  upsertJobMemory(
    agencyId: string,
    input: {
      workerId: string;
      workItemId?: string | null;
      namespace: string;
      key: string;
      value: unknown;
      source?: string;
      expiresAt?: number | null;
    },
  ): JobMemoryRecord;
  listJobMemory(
    agencyId: string,
    workerId: string,
    namespace?: string,
    now?: number,
  ): JobMemoryRecord[];
  /** Optional: the worker's shifts, used to make the reply cadence schedule-aware. */
  listSchedules?(agencyId: string, workerId?: string): ScheduleWindow[];
}

/** Structural subset of `WorkforceStore` the executor needs. */
export interface WorkItemExecutorWorkerStore {
  getWorker(agencyId: string, workerId: string): Worker | null;
  /**
   * Optional: where this worker speaks. Absent on the narrow test doubles, and
   * a missing binding list only means the prompt omits the channel section.
   */
  listChannelBindings?(
    agencyId: string,
    filters?: { workerId?: string; channelId?: string; enabled?: boolean },
  ): WorkerChannelBinding[];
}

/** Structural subset of `WorkforceSopStore` used to resolve a STORED SOP. */
export interface WorkItemExecutorSopStore {
  getSop(agencyId: string, sopId: string): Sop | null;
  getSopBySlug(agencyId: string, slug: string): Sop | null;
  findScheduleByResponsibility(agencyId: string, responsibilityId: string): SopSchedule | null;
}

/**
 * Resolve the STORED SOP behind a work item, if there is one.
 *
 * Order, most specific first:
 *   1. `context.sopId`   — set by `runSopOnce` and by SOP-generated
 *                          responsibilities, so a card carries its own SOP;
 *   2. `context.sopSlug` — survives an SOP being recreated under the same slug;
 *   3. the schedule that owns the item's `responsibilityId`.
 *
 * Returns null when the item has no SOP link, which is the signal to fall back
 * to the worker's `sopPath` on disk (the pre-SOP-store behaviour).
 */
export function resolveStoredSopForItem(
  sopStore: WorkItemExecutorSopStore,
  agencyId: string,
  item: Pick<EmployeeWorkItem, "context" | "responsibilityId">,
): Sop | null {
  const context = (item.context ?? {}) as Record<string, unknown>;

  const sopId = typeof context.sopId === "string" ? context.sopId.trim() : "";
  if (sopId) {
    const byId = sopStore.getSop(agencyId, sopId);
    if (byId) return byId;
  }

  const slug = typeof context.sopSlug === "string" ? context.sopSlug.trim() : "";
  if (slug) {
    const bySlug = sopStore.getSopBySlug(agencyId, slug);
    if (bySlug) return bySlug;
  }

  if (item.responsibilityId) {
    const schedule = sopStore.findScheduleByResponsibility(agencyId, item.responsibilityId);
    if (schedule) return sopStore.getSop(agencyId, schedule.sopId);
  }
  return null;
}

export type CoderSpawnRequest = {
  backend: CoderBackendId;
  prompt: string;
  workdir: string;
  timeoutMinutes: number;
  runId: string;
  agentId: string;
  worker: Worker;
  item: EmployeeWorkItem;
};

export type CoderSpawnResult = {
  output: string;
  exitCode: number | null;
  killed?: boolean;
  sessionId?: string;
};

/** Injected so tests never spawn a real CLI. */
export type CoderSpawnFn = (request: CoderSpawnRequest) => Promise<CoderSpawnResult>;

export type WorkItemExecutorLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type WorkItemExecutorDeps = {
  operatingStore: WorkItemExecutorOperatingStore;
  workerStore: WorkItemExecutorWorkerStore;
  /**
   * First-class SOPs. When supplied, a work item that links to a stored SOP
   * uses it in preference to the worker's `sopPath` on disk. Optional so the
   * pre-SOP-store wiring keeps working unchanged.
   */
  sopStore?: WorkItemExecutorSopStore | null;
  config: WorkItemExecutorConfig;
  /** Root the workers' relative `sopPath` / `workspacePath` resolve against. */
  workspaceRoot: string;
  /** Defaults to the real coder-backend registry. */
  spawn?: CoderSpawnFn;
  /** Defaults to reading from disk; injected in tests. */
  readSop?: (path: string) => string | null;
  /** Defaults to `existsSync` on a directory; injected in tests. */
  directoryExists?: (path: string) => boolean;
  /** Broadcast-as-invalidation signal for the UI. */
  broadcast?: (event: string, payload: unknown) => void;
  now?: () => number;
  log?: WorkItemExecutorLogger;
};

const noopLog: WorkItemExecutorLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ── Results ─────────────────────────────────────────────────────────────────

export type WorkItemExecutionOutcome =
  | "completed"
  | "review"
  | "escalated"
  | "skipped"
  | "disabled";

export type WorkItemExecutionResult = {
  workItemId: string;
  workerId: string;
  outcome: WorkItemExecutionOutcome;
  backend: CoderBackendId | null;
  status: WorkItemStatus;
  reason: string;
  durationMs: number;
  error?: string;
};

export type WorkItemExecutionPassResult = {
  agencyId: string;
  enabled: boolean;
  considered: number;
  executed: number;
  completed: number;
  review: number;
  escalated: number;
  skipped: number;
  results: WorkItemExecutionResult[];
};

const emptyPass = (agencyId: string, enabled: boolean): WorkItemExecutionPassResult => ({
  agencyId,
  enabled,
  considered: 0,
  executed: 0,
  completed: 0,
  review: 0,
  escalated: 0,
  skipped: 0,
  results: [],
});

// ── Prompt composition ──────────────────────────────────────────────────────

const bullet = (values: string[]) => values.map((value) => `- ${value}`).join("\n");

/**
 * Compose the full instruction text handed to the coder backend. Pure — no I/O
 * — so prompt shape can be asserted directly in tests.
 */
export function composeWorkItemPrompt(input: {
  worker: Worker;
  item: EmployeeWorkItem;
  sop?: string | null;
  memory?: Array<{ key: string; value: unknown }>;
  terminalStatus: "review" | "completed";
  /** Defaults to the worker's own profile (migrated from the legacy string). */
  communicationProfile?: CommunicationProfile | null;
  /** Where this employee can be reached; renders the channel section. */
  channelBindings?: WorkerChannelBinding[];
  /** Shifts, used to state whether the employee is currently on the clock. */
  schedules?: ScheduleWindow[];
  /** Defaults to the worker's own execution profile. */
  executionProfile?: WorkerExecutionProfile | null;
  now?: number;
}): string {
  const { worker, item } = input;
  const sections: string[] = [];

  sections.push(
    [
      `You are ${worker.displayName}, ${worker.title} at this agency.`,
      `Employee id: ${worker.id}${worker.agentId ? ` (agent: ${worker.agentId})` : ""}.`,
      `Autonomy level: ${worker.autonomyLevel}/3.`,
    ].join("\n"),
  );

  if (worker.persona?.trim()) sections.push(`## Persona\n${worker.persona.trim()}`);
  if (worker.goals.length) sections.push(`## Standing goals\n${bullet(worker.goals)}`);
  if (worker.kpis.length) sections.push(`## Measured on\n${bullet(worker.kpis)}`);
  if (worker.capabilities.length) sections.push(`## Capabilities\n${bullet(worker.capabilities)}`);

  // ── How this employee talks ───────────────────────────────────────────────
  // The profile is rendered into the prompt rather than kept as inert
  // metadata: changing an employee's tone/verbosity/cadence in the UI has to
  // change how they actually write, or the profile is decoration.
  const profile = input.communicationProfile ?? resolveCommunicationProfile(worker);
  sections.push(`## How you communicate\n${renderCommunicationPrompt(profile)}`);

  const plan = planResponse({
    profile,
    schedules: input.schedules ?? [],
    now: input.now,
    urgent: item.priority === "urgent",
  });
  sections.push(
    `## Timing\n${
      plan.withinWorkingHours
        ? "You are on shift right now."
        : "You are OUTSIDE your rostered working hours right now."
    } ${plan.reason}.` +
      (plan.action === "defer"
        ? " Do the work, but hold non-urgent outbound messages until your next shift."
        : ""),
  );

  const bindings = (input.channelBindings ?? []).filter((binding) => binding.enabled);
  if (bindings.length) {
    sections.push(
      `## Where you are reachable\n${describeChannelBindings(bindings)}\n` +
        `Match each platform's conventions — a Slack message is not an email is not a WhatsApp reply.`,
    );
  }

  const execution = input.executionProfile ?? resolveExecutionProfile(worker);
  const toolPolicy = describeToolPolicy(execution);
  if (toolPolicy) sections.push(`## Tool policy\n${toolPolicy}`);

  const sop = input.sop?.trim();
  if (sop) sections.push(`## Standard operating procedure\n${sop}`);

  const memory = (input.memory ?? []).filter((entry) => entry.value !== undefined);
  if (memory.length) {
    sections.push(
      `## Recent job memory\n${memory
        .map((entry) => `- ${entry.key}: ${safeJson(entry.value)}`)
        .join("\n")}`,
    );
  }

  sections.push(
    [
      `## Work item`,
      `Title: ${item.title}`,
      `Priority: ${item.priority}`,
      item.dueAt ? `Due: ${new Date(item.dueAt).toISOString()}` : null,
      ``,
      item.instructions.trim() || "(no additional instructions were provided)",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );

  const contextKeys = Object.keys(item.context ?? {});
  if (contextKeys.length) sections.push(`## Context\n${safeJson(item.context)}`);

  sections.push(
    input.terminalStatus === "completed"
      ? `## Completion\nDo the work now and finish it. End your reply with a short summary of exactly what you changed or produced.`
      : `## Completion\nDo the work now, but it will be HELD FOR HUMAN REVIEW before it counts as done. End your reply with a short summary plus anything the reviewer must check.`,
  );

  return sections.join("\n\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ── SOP + workspace resolution ──────────────────────────────────────────────

function defaultReadSop(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultDirectoryExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Candidate locations for a worker's SOP, most specific first. Relative paths
 * resolve against the agency workspace root, and against the worker's own
 * workspace beneath it.
 */
export function sopCandidatePaths(worker: Worker, workspaceRoot: string): string[] {
  const sopPath = worker.sopPath?.trim();
  if (!sopPath) return [];
  if (isAbsolute(sopPath)) return [sopPath];
  const candidates = [join(workspaceRoot, sopPath)];
  const workspacePath = worker.workspacePath?.trim();
  if (workspacePath) {
    candidates.push(
      isAbsolute(workspacePath)
        ? join(workspacePath, sopPath)
        : join(workspaceRoot, workspacePath, sopPath),
    );
  }
  return candidates;
}

/** Working directory for the spawn; falls back to the agency root. */
export function resolveWorkerWorkdir(
  worker: Worker,
  workspaceRoot: string,
  directoryExists: (path: string) => boolean,
): string {
  const workspacePath = worker.workspacePath?.trim();
  if (workspacePath) {
    const candidate = isAbsolute(workspacePath)
      ? workspacePath
      : resolve(workspaceRoot, workspacePath);
    if (directoryExists(candidate)) return candidate;
  }
  return resolve(workspaceRoot);
}

// ── Default spawn (real coder backends) ─────────────────────────────────────

/**
 * Real backend spawn. Deliberately imported lazily so that merely importing
 * this module — in tests, in the gateway, anywhere — never pulls in the CLI
 * launcher stack.
 */
export const defaultCoderSpawn: CoderSpawnFn = async (request) => {
  const { createCoderBackend } = await import("../agents/coder-backend/registry.js");
  const backend = createCoderBackend(request.backend);
  const session = await backend.spawn(
    {
      id: request.agentId,
      name: request.agentId,
      type: "cli",
      cliCommand: request.backend === "codex" ? "codex" : request.backend,
      autoApprove: false,
      timeoutMinutes: request.timeoutMinutes,
      enabledMCPs: [],
    },
    request.prompt,
    request.workdir,
    { runId: request.runId },
  );
  return {
    output: session.output,
    exitCode: session.exitCode,
    killed: session.killed,
    sessionId: session.sessionId,
  };
};

// ── The executor ────────────────────────────────────────────────────────────

export class WorkItemExecutor {
  private readonly deps: WorkItemExecutorDeps;
  private readonly log: WorkItemExecutorLogger;
  private readonly spawn: CoderSpawnFn;
  private readonly readSop: (path: string) => string | null;
  private readonly directoryExists: (path: string) => boolean;
  private readonly now: () => number;

  constructor(deps: WorkItemExecutorDeps) {
    this.deps = deps;
    this.log = deps.log ?? noopLog;
    this.spawn = deps.spawn ?? defaultCoderSpawn;
    this.readSop = deps.readSop ?? defaultReadSop;
    this.directoryExists = deps.directoryExists ?? defaultDirectoryExists;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Execute the STAGED work items of one agency — the cards a human moved into
   * the `accepted` column. Backlog (`queued`) items are never touched.
   *
   * Bounded by `maxItemsPerPass` and `maxConcurrency`; every item is isolated
   * so one failure can never abort the pass, and the returned summary always
   * resolves instead of throwing.
   */
  async executeStagedWorkItems(agencyId: string): Promise<WorkItemExecutionPassResult> {
    const config = this.deps.config;
    if (!config.enabled) return emptyPass(agencyId, false);

    const pass = emptyPass(agencyId, true);
    const now = this.now();

    let staged: EmployeeWorkItem[] = [];
    try {
      staged = this.deps.operatingStore
        .listWorkItems(agencyId, { status: EXECUTION_STAGE, limit: 200 })
        .filter((item) => item.scheduledFor <= now);
    } catch (error) {
      this.log.error(`work item executor: failed to list staged items: ${message(error)}`);
      return pass;
    }

    const batch = staged.slice(0, config.maxItemsPerPass);
    pass.considered = batch.length;
    if (!batch.length) return pass;

    // Bounded worker pool: at most `maxConcurrency` CLIs alive at once.
    const queue = [...batch];
    const lanes = Math.min(Math.max(1, config.maxConcurrency), queue.length);
    const runLane = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const result = await this.executeOne(agencyId, item);
        pass.results.push(result);
        if (result.outcome === "completed") {
          pass.executed += 1;
          pass.completed += 1;
        } else if (result.outcome === "review") {
          pass.executed += 1;
          pass.review += 1;
        } else if (result.outcome === "escalated") {
          pass.executed += 1;
          pass.escalated += 1;
        } else {
          pass.skipped += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: lanes }, runLane));

    if (pass.executed) {
      this.log.info(
        `work item executor: agency ${agencyId} executed=${pass.executed} ` +
          `completed=${pass.completed} review=${pass.review} escalated=${pass.escalated} ` +
          `skipped=${pass.skipped}`,
      );
    }
    return pass;
  }

  /**
   * Execute exactly one work item. Never throws: any failure is converted into
   * an `escalated` (or `skipped`) result so the caller's pass survives.
   */
  async executeOne(agencyId: string, input: EmployeeWorkItem): Promise<WorkItemExecutionResult> {
    const startedAt = this.now();
    const base = {
      workItemId: input.id,
      workerId: input.workerId,
      backend: null as CoderBackendId | null,
      durationMs: 0,
    };
    const skip = (reason: string, status: WorkItemStatus = input.status) => ({
      ...base,
      outcome: "skipped" as const,
      status,
      reason,
      durationMs: this.now() - startedAt,
    });

    let item = input;
    let worker: Worker | null = null;
    try {
      // The board stage IS the approval gate: only a card a human staged into
      // `accepted` may run. Anything else (backlog, in flight, done) is inert.
      if (!isExecutionEligibleStage(item.status))
        return skip(`item is ${item.status}; only ${EXECUTION_STAGE} items are execution-eligible`);
      worker = this.deps.workerStore.getWorker(agencyId, item.workerId);
      if (!worker) return skip("worker not found");
      if (worker.type !== "ai") return skip("worker is human; nothing to spawn");
      if (worker.employmentStatus !== "active")
        return skip(`worker employmentStatus is ${worker.employmentStatus}`);
    } catch (error) {
      return skip(`pre-flight failed: ${message(error)}`);
    }

    const decision = decideAutonomy(worker, item);
    if (!decision.execute) return skip(decision.reason);

    const execution = resolveExecutionProfile(worker);
    const backend = resolveBackendForBinding(worker.modelBinding, this.deps.config.defaultBackend);
    // A worker pinned to a backend that is not installed (today: Dev and Wren
    // on `codex`, which exits 1) needs its OWN retry target, not the fleet's.
    const fallbackBackend = execution.fallbackModelBinding
      ? resolveBackendForBinding(execution.fallbackModelBinding, this.deps.config.defaultBackend)
      : this.deps.config.fallbackBackend;
    const timeoutMinutes = execution.timeoutMinutes ?? this.deps.config.timeoutMinutes;
    base.backend = backend;

    // ── accepted -> in_progress (the human already did queued -> accepted) ──
    try {
      assertWorkItemTransition(item.status, "in_progress");
      item = this.deps.operatingStore.transitionWorkItem(agencyId, item.id, "in_progress", {
        now: this.now(),
      });
    } catch (error) {
      return skip(`could not start item: ${message(error)}`);
    }
    this.emit(agencyId, item, "in_progress", backend);

    const prompt = this.buildPrompt(agencyId, worker, item, decision.terminalStatus);
    const workdir = resolveWorkerWorkdir(worker, this.deps.workspaceRoot, this.directoryExists);
    const runId = randomUUID();

    const spawnResult = await spawnCoderWithFallback<CoderSpawnResult>({
      primary: backend,
      fallback: fallbackBackend === backend ? undefined : fallbackBackend,
      attempt: async (candidate) => {
        try {
          const session = await this.spawn({
            backend: candidate,
            prompt,
            workdir,
            timeoutMinutes,
            runId,
            agentId: worker!.agentId ?? worker!.id,
            worker: worker!,
            item,
          });
          if (session.killed) {
            return {
              ok: false as const,
              error: "backend run timed out",
              exitCode: session.exitCode,
            };
          }
          if (session.exitCode !== null && session.exitCode !== 0) {
            return {
              ok: false as const,
              error: `backend exited with code ${session.exitCode}`,
              exitCode: session.exitCode,
            };
          }
          return { ok: true as const, session, exitCode: session.exitCode };
        } catch (error) {
          return { ok: false as const, error: message(error) };
        }
      },
    });

    const durationMs = this.now() - startedAt;

    if (!spawnResult.ok) {
      const reason = `execution failed: ${spawnResult.error}`;
      const status = this.safeTransition(agencyId, item, "escalated", {
        reviewNote: reason.slice(0, 500),
      });
      this.recordMemory(agencyId, worker, item, {
        outcome: "escalated",
        backend,
        attempts: spawnResult.attempts,
        error: spawnResult.error,
        durationMs,
        startedAt,
      });
      this.emit(agencyId, item, status, backend);
      this.log.warn(`work item executor: ${item.id} escalated — ${spawnResult.error}`);
      return {
        ...base,
        outcome: "escalated",
        status,
        reason,
        durationMs,
        error: spawnResult.error,
      };
    }

    const output = spawnResult.session.output ?? "";
    const terminal = decision.terminalStatus;
    const status = this.safeTransition(agencyId, item, terminal, {
      reviewNote:
        terminal === "review"
          ? `${decision.reason}\n\n${truncate(output, this.deps.config.maxOutputChars)}`
          : null,
    });

    this.recordMemory(agencyId, worker, item, {
      outcome: terminal,
      backend: spawnResult.backendUsed,
      attempts: spawnResult.attempts,
      output: truncate(output, this.deps.config.maxOutputChars),
      exitCode: spawnResult.session.exitCode ?? null,
      sessionId: spawnResult.session.sessionId ?? null,
      durationMs,
      startedAt,
    });
    this.emit(agencyId, item, status, spawnResult.backendUsed);

    return {
      ...base,
      backend: spawnResult.backendUsed,
      outcome: terminal,
      status,
      reason: decision.reason,
      durationMs,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private buildPrompt(
    agencyId: string,
    worker: Worker,
    item: EmployeeWorkItem,
    terminalStatus: "review" | "completed",
  ): string {
    let sop: string | null = null;

    // A STORED SOP wins over the file on disk: it is the one an operator can
    // actually edit, it is versioned, and it is what the schedule that produced
    // this card points at. Disk remains the backward-compatible fallback.
    if (this.deps.sopStore) {
      try {
        const stored = resolveStoredSopForItem(this.deps.sopStore, agencyId, item);
        if (stored) sop = truncate(renderSopMarkdown(stored), this.deps.config.maxSopChars);
      } catch (error) {
        this.log.warn(`work item executor: stored SOP lookup failed: ${message(error)}`);
      }
    }

    if (!sop) {
      for (const candidate of sopCandidatePaths(worker, this.deps.workspaceRoot)) {
        try {
          const text = this.readSop(candidate);
          if (text?.trim()) {
            sop = truncate(text, this.deps.config.maxSopChars);
            break;
          }
        } catch {
          /* a missing or unreadable SOP degrades to "no SOP" */
        }
      }
    }
    if (!sop && worker.sopPath) {
      this.log.warn(
        `work item executor: SOP not found for ${worker.displayName} (${worker.sopPath})`,
      );
    }

    let memory: Array<{ key: string; value: unknown }> = [];
    try {
      memory = this.deps.operatingStore
        .listJobMemory(agencyId, worker.id, JOB_MEMORY_NAMESPACE)
        .slice(0, 5)
        .map((record) => ({ key: record.key, value: record.value }));
    } catch {
      /* memory is an enhancement, never a hard dependency */
    }

    // Channel bindings and shifts are enhancements: a store double that does
    // not implement them simply yields a prompt without those sections.
    let channelBindings: WorkerChannelBinding[] = [];
    try {
      channelBindings =
        this.deps.workerStore.listChannelBindings?.(agencyId, {
          workerId: worker.id,
          enabled: true,
        }) ?? [];
    } catch {
      /* routing is descriptive only; never fail a run over it */
    }

    let schedules: ScheduleWindow[] = [];
    try {
      schedules = this.deps.operatingStore.listSchedules?.(agencyId, worker.id) ?? [];
    } catch {
      /* no schedule = always on, which is the pre-feature behaviour */
    }

    return composeWorkItemPrompt({
      worker,
      item,
      sop,
      memory,
      terminalStatus,
      channelBindings,
      schedules,
      now: this.now(),
    });
  }

  private safeTransition(
    agencyId: string,
    item: EmployeeWorkItem,
    status: WorkItemStatus,
    options: { reviewNote?: string | null } = {},
  ): WorkItemStatus {
    try {
      const current = this.deps.operatingStore.getWorkItem(agencyId, item.id) ?? item;
      assertWorkItemTransition(current.status, status);
      const updated = this.deps.operatingStore.transitionWorkItem(agencyId, item.id, status, {
        reviewNote: options.reviewNote ?? null,
        now: this.now(),
      });
      return updated.status;
    } catch (error) {
      this.log.error(
        `work item executor: could not transition ${item.id} to ${status}: ${message(error)}`,
      );
      return item.status;
    }
  }

  private recordMemory(
    agencyId: string,
    worker: Worker,
    item: EmployeeWorkItem,
    value: Record<string, unknown>,
  ): void {
    const payload = {
      workItemId: item.id,
      title: item.title,
      priority: item.priority,
      recordedAt: this.now(),
      ...value,
    };
    try {
      this.deps.operatingStore.upsertJobMemory(agencyId, {
        workerId: worker.id,
        workItemId: item.id,
        namespace: JOB_MEMORY_NAMESPACE,
        key: `work-item:${item.id}`,
        value: payload,
        source: "work-item-executor",
      });
      this.deps.operatingStore.upsertJobMemory(agencyId, {
        workerId: worker.id,
        workItemId: item.id,
        namespace: JOB_MEMORY_NAMESPACE,
        key: "last-run",
        value: payload,
        source: "work-item-executor",
      });
    } catch (error) {
      this.log.warn(`work item executor: failed to persist job memory: ${message(error)}`);
    }
  }

  /**
   * Broadcast-as-invalidation: the payload identifies WHAT changed, not the
   * full record, so the UI refetches through the normal RPCs.
   */
  private emit(
    agencyId: string,
    item: EmployeeWorkItem,
    status: WorkItemStatus,
    backend: CoderBackendId | null,
  ): void {
    try {
      this.deps.broadcast?.(WORK_ITEM_EVENT, {
        agencyId,
        workerId: item.workerId,
        workItemId: item.id,
        status,
        backend,
        at: this.now(),
      });
    } catch {
      /* a broken socket must never fail a work item */
    }
  }
}

// ── Board support (what the live kanban needs to render + drive execution) ──

/** Per-card execution metadata for the board. */
export type WorkItemExecutionView = {
  workItemId: string;
  workerId: string;
  workerName: string;
  /** Current board column. */
  stage: WorkItemStatus;
  /** True when this card sits in the stage that authorises autonomous work. */
  executionEligible: boolean;
  /** Whether the executor is switched on at all (`executeWorkItems`). */
  executorEnabled: boolean;
  /** Coder backend this employee's `modelBinding` resolves to. */
  backend: CoderBackendId | null;
  autonomyLevel: number;
  /** Where a successful run would land the card. Null when it would not run. */
  terminalStage: "review" | "completed" | null;
  /** Human-readable reason the card will NOT run, or null when it will. */
  blockedReason: string | null;
  /** Last recorded execution for this card, from job memory. */
  lastRun: Record<string, unknown> | null;
};

export type WorkItemExecutionViewDeps = {
  operatingStore: Pick<WorkItemExecutorOperatingStore, "listWorkItems" | "listJobMemory">;
  workerStore: WorkItemExecutorWorkerStore;
  config: Pick<WorkItemExecutorConfig, "enabled" | "defaultBackend">;
};

/**
 * Describe one card's execution readiness. Pure lookup — never spawns.
 *
 * The UI uses this to show WHY a staged card is or is not going to run
 * (executor off, level-0 employee, inactive worker, …) and what will happen
 * when it does (auto-complete vs held for review).
 */
export function describeWorkItemExecution(
  deps: WorkItemExecutionViewDeps,
  agencyId: string,
  item: EmployeeWorkItem,
): WorkItemExecutionView {
  const worker = deps.workerStore.getWorker(agencyId, item.workerId);
  const eligible = isExecutionEligibleStage(item.status);
  const view: WorkItemExecutionView = {
    workItemId: item.id,
    workerId: item.workerId,
    workerName: worker?.displayName ?? item.workerId,
    stage: item.status,
    executionEligible: eligible,
    executorEnabled: deps.config.enabled,
    backend: worker
      ? resolveBackendForBinding(worker.modelBinding, deps.config.defaultBackend)
      : null,
    autonomyLevel: worker?.autonomyLevel ?? 0,
    terminalStage: null,
    blockedReason: null,
    lastRun: null,
  };

  try {
    const memory = deps.operatingStore
      .listJobMemory(agencyId, item.workerId, JOB_MEMORY_NAMESPACE)
      .find((record) => record.key === `work-item:${item.id}`);
    if (memory && memory.value && typeof memory.value === "object")
      view.lastRun = memory.value as Record<string, unknown>;
  } catch {
    /* memory is decoration, never a hard dependency */
  }

  if (!worker) {
    view.blockedReason = "worker not found";
    return view;
  }
  if (worker.type !== "ai") {
    view.blockedReason = "human employee: this card is done by a person";
    return view;
  }
  if (worker.employmentStatus !== "active") {
    view.blockedReason = `employee is ${worker.employmentStatus}`;
    return view;
  }
  const decision = decideAutonomy(worker, item);
  if (!decision.execute) {
    view.blockedReason = decision.reason;
    return view;
  }
  view.terminalStage = decision.terminalStatus;
  if (!deps.config.enabled) {
    view.blockedReason =
      "work-item execution is disabled (cron.agencyOperatingLoop.executeWorkItems)";
    return view;
  }
  if (!eligible) {
    view.blockedReason = `move the card to "${EXECUTION_STAGE}" to authorise autonomous work`;
  }
  return view;
}

/**
 * Every card currently staged for execution, with its readiness metadata.
 * This is the board's "ready to run" column feed.
 */
export function listExecutionEligibleWorkItems(
  deps: WorkItemExecutionViewDeps,
  agencyId: string,
  filters: { workerId?: string; limit?: number } = {},
): WorkItemExecutionView[] {
  return deps.operatingStore
    .listWorkItems(agencyId, {
      status: EXECUTION_STAGE,
      workerId: filters.workerId,
      limit: filters.limit ?? 100,
    })
    .map((item) => describeWorkItemExecution(deps, agencyId, item));
}

/** Namespace used for per-employee execution memory. */
export const JOB_MEMORY_NAMESPACE = "work-item-execution";

/** Broadcast event name (invalidation signal consumed by the UI). */
export const WORK_ITEM_EVENT = "agency.work.updated";

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… (truncated, ${value.length - max} more characters)`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
