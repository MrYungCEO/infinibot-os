/**
 * Autonomy Orchestrator — closed build/test loop.
 *
 * One orchestrator instance drives a single queued task from pre-fire ready
 * through repeated build → test → assess iterations until either the tester
 * verdict passes or `prefire.maxIterations` is reached. Every phase emits
 * audit entries, Telegram notifications, and writes back to the queue + the
 * linked kanban task so the user sees real progress in the UI.
 *
 * The orchestrator is stateless across process restarts on purpose — if the
 * gateway dies mid-iteration, the queue still has the partial iteration
 * record and the manager will re-pick the task up on resume.
 */

import { randomUUID } from "node:crypto";
import { callGateway } from "../gateway/call.js";
import { logAudit } from "./audit.js";
import { notifications } from "./notifications.js";
import { syncToKanban } from "./kanban-sync.js";
import { validateSpawnParams } from "./spawn-params.js";
import { buildBuilderPrompt, buildTesterPrompt, parseTesterVerdict } from "./tester-agent.js";
import { attemptHeal, classifyFailure } from "./self-heal.js";
import { planIterationRetry } from "./retry.js";
// COORDINATION: goal-orchestrator-mode — queue→goal-orchestrator wiring
import { runOrchestratorTurn, type SubagentRunRef } from "./goal-orchestrator.js";
import { evaluateGoal } from "./goal-judge.js";
import type {
  QueuedTask,
  TaskCliKind,
  TaskExecutionMode,
  TaskIteration,
  TesterVerdict,
} from "./types.js";

/**
 * Truncate a free-form title into a spawn-safe label.
 * Delegates to the shared `validateSpawnParams()` so the constraint lives in
 * exactly one place. Falls back to "autonomy-task" for empty/whitespace input.
 *
 * Exported so orchestrator.test.ts can pin the truncation contract.
 */
export function truncateLabel(raw: string): string {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (!candidate) return "autonomy-task";
  try {
    return validateSpawnParams({
      agentId: "coder",
      label: candidate,
      task: "placeholder",
    }).label;
  } catch {
    return "autonomy-task";
  }
}

// ─── Success-criteria synthesis (NO-BLOCKAGES fallback) ──────────────────

/**
 * Deterministic success-criteria fallback. Used when the operator skipped
 * the prefire form (prefireRequired:false) so the loop has no explicit
 * acceptance signal. Builds a self-contained criteria string from whatever
 * the task itself already carries — title, description, instructions, notes
 * — so the builder + tester can reason about "done" without an LLM call.
 *
 * Exported so the tester-agent prompt and tests can pin the template.
 */
export function synthesizeSuccessCriteria(task: QueuedTask): string {
  const title = (task.title ?? "").trim();
  const description = (task.description ?? "").trim();
  const instructions = (task.context?.instructions ?? "").trim();
  const notes = (task.context?.notes ?? "").trim();
  const lines: string[] = [];
  if (description) {
    lines.push(`Task is complete when the following is delivered as described: ${description}`);
  } else if (title) {
    lines.push(`Task is complete when the following is delivered: ${title}`);
  } else {
    lines.push("Task is complete when the requested work is delivered.");
  }
  if (instructions) {
    lines.push(`Honor these operator instructions exactly: ${instructions}`);
  }
  if (notes) {
    lines.push(`Operator notes for context: ${notes}`);
  }
  lines.push(
    "Verify by exercising the changed code paths end-to-end and confirming no regressions in adjacent surfaces.",
  );
  return lines.join("\n\n");
}

// ─── Pre-fire validation ──────────────────────────────────────────────────

export interface PrefireValidation {
  ok: boolean;
  missing: string[];
}

/**
 * Inspect a task's pre-fire questionnaire and return the list of fields that
 * still need answers. Used by the queue.start guard and by the UI.
 */
export function validatePrefire(task: QueuedTask): PrefireValidation {
  // Dynamic, agent-generated form takes precedence whenever it has been
  // attached to the task. The orchestrator only fires once every required
  // field is answered AND the agent has flipped agentReady=true (which
  // happens via the LLM readiness check in the gateway handler).
  const form = task.context?.prefireForm;
  if (form) {
    const missing: string[] = [];
    for (const field of form.fields ?? []) {
      if (!field.required) continue;
      const value = form.answers?.[field.id];
      if (value === undefined || value === null) {
        missing.push(field.label || field.id);
        continue;
      }
      if (typeof value === "string" && value.trim() === "") {
        missing.push(field.label || field.id);
        continue;
      }
      if (Array.isArray(value) && value.length === 0) {
        missing.push(field.label || field.id);
      }
    }
    // H4: the dynamic-form path used to accept maxIterations: 0 silently
    // (runLoop's Math.max(1, …) hid it) so the user got exactly one
    // iteration when they asked for "skip". Reject it here so the form
    // surfaces the bad value the same way the legacy validator does at :111.
    const maxIterField = (form.fields ?? []).find((f) => f.id === "maxIterations");
    if (maxIterField) {
      const v = form.answers?.["maxIterations"];
      if (typeof v === "number" && v < 1) {
        missing.push(`${maxIterField.label || "maxIterations"} (must be ≥ 1)`);
      }
    }
    if (!form.agentReady) {
      missing.push('agent readiness check (run "Mark ready" or wait for autoready)');
    }
    return { ok: missing.length === 0, missing };
  }

  // Legacy static questionnaire — preserved so previously-queued tasks still
  // run without forced migration.
  const missing: string[] = [];
  const p = task.context?.prefire;
  if (!p) {
    return {
      ok: false,
      missing: ["prefire questionnaire"],
    };
  }
  if (!p.successCriteria || !p.successCriteria.trim()) {
    missing.push("successCriteria");
  }
  if (!Array.isArray(p.testTargets) || p.testTargets.length === 0) {
    missing.push("testTargets");
  } else {
    const hasBad = p.testTargets.some((t) => !t.description || !t.description.trim());
    if (hasBad) missing.push("testTargets[*].description");
  }
  if (typeof p.maxIterations !== "number" || p.maxIterations < 1) {
    missing.push("maxIterations");
  }
  if (typeof p.testerEnabled !== "boolean") {
    missing.push("testerEnabled");
  }
  if (!p.completed) {
    missing.push("completed (operator must confirm)");
  }
  return { ok: missing.length === 0, missing };
}

// ─── Internal state ───────────────────────────────────────────────────────

// We keep a map of running orchestrations so a second `start` call on the
// same task is a no-op rather than racing the existing loop.
const running = new Map<string, Promise<void>>();

interface OrchestratorDeps {
  /**
   * Spawn a subagent. Returns the child run id + session key, and when the
   * execution mode is "terminal", the terminalId of the spawned PTY so the
   * task detail panel can embed the live TUI.
   */
  spawnSubagent: (input: {
    agentId: string;
    task: string;
    label: string;
    runTimeoutSeconds?: number;
    /** Execution mode for this spawn. Defaults to "gateway". */
    mode?: TaskExecutionMode;
    /** CLI to launch when mode === "terminal". Defaults to "claude". */
    cli?: TaskCliKind;
    /** Working directory for terminal-mode spawns. Defaults to cwd. */
    cwd?: string;
  }) => Promise<{ runId: string; childSessionKey: string; terminalId?: string }>;

  /** Wait for a subagent to finish; returns its terminal output, if any. */
  waitForSubagent: (
    runId: string,
    timeoutMs: number,
  ) => Promise<{ status: "ok" | "error" | "timeout"; error?: string; reply?: string }>;

  /** Mutate + persist the task in the queue. */
  updateTask: (taskId: string, patch: (t: QueuedTask) => void) => QueuedTask | null;

  /** Mark the task completed / failed in the queue. */
  completeTask: (taskId: string, outcome: string) => void;
  failTask: (taskId: string, error: string) => void;
  /**
   * Park the task as "blocked" after an UNHEALABLE tool/infra failure. Unlike
   * failTask this keeps the task live so the heartbeat resumes it later (and
   * after a restart). Optional so existing callers/tests still work — the
   * default is backed by queue.block. COORDINATION: orch-self-heal
   */
  blockTask?: (taskId: string, reason: string) => void;
}

// ─── Default deps backed by the gateway ───────────────────────────────────

async function defaultSpawnSubagent(input: {
  agentId: string;
  task: string;
  label: string;
  runTimeoutSeconds?: number;
  mode?: TaskExecutionMode;
  cli?: TaskCliKind;
  cwd?: string;
}): Promise<{ runId: string; childSessionKey: string; terminalId?: string }> {
  if (input.mode === "terminal") {
    // Mint a runId + sessionKey here so the orchestrator can record them
    // even before terminal.spawnAgent returns its terminalId. terminal.spawnAgent
    // uses these directly when registering the PTY in the spawn registry.
    const runId = randomUUID();
    const childSessionKey = `autonomy:terminal:${runId}`;
    const result = (await callGateway({
      method: "terminal.spawnAgent",
      params: {
        cli: input.cli ?? "claude",
        cwd: input.cwd && input.cwd.trim() ? input.cwd : ".",
        task: input.task,
        label: input.label,
        runId,
        sessionKey: childSessionKey,
        agentId: input.agentId,
        // Keep the PTY alive after the iteration completes so the operator
        // can click back into the task and see the full scrollback. The UI
        // can offer an explicit "Close terminal" affordance.
        autoClose: false,
        // Autonomous control means there's no operator to approve each
        // tool call. Opt the chosen CLI into its YOLO mode — the
        // terminal handler translates this to the per-CLI canonical
        // flag (claude: --dangerously-skip-permissions, opencode: same,
        // codex: --dangerously-bypass-approvals-and-sandbox, gemini:
        // --yolo). Without this, autonomous loops freeze on the first
        // permission prompt.
        options: {
          dangerouslySkipPermissions: true,
        },
      },
      timeoutMs: 30_000,
    })) as { success?: boolean; terminalId?: string; error?: string };
    if (!result?.success || !result.terminalId) {
      throw new Error(`terminal.spawnAgent failed: ${result?.error ?? "unknown error"}`);
    }
    return {
      runId,
      childSessionKey,
      terminalId: result.terminalId,
    };
  }

  const result = (await callGateway({
    method: "sessions.spawn",
    params: {
      task: input.task,
      agentId: input.agentId,
      label: input.label,
      runTimeoutSeconds: input.runTimeoutSeconds,
    },
    timeoutMs: 30_000,
  })) as { runId?: string; childSessionKey?: string };
  if (!result?.runId || !result?.childSessionKey) {
    throw new Error("sessions.spawn returned no runId / childSessionKey");
  }
  return { runId: result.runId, childSessionKey: result.childSessionKey };
}

async function defaultWaitForSubagent(
  runId: string,
  timeoutMs: number,
): Promise<{ status: "ok" | "error" | "timeout"; error?: string; reply?: string }> {
  try {
    const result = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs },
      timeoutMs: timeoutMs + 10_000,
    })) as { status?: string; error?: string; reply?: string };
    if (result?.status === "ok" || result?.status === "error") {
      return { status: result.status, error: result.error, reply: result.reply };
    }
    return { status: "timeout" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchSubagentReply(childSessionKey: string): Promise<string> {
  try {
    const previewResult = (await callGateway({
      method: "sessions.preview",
      params: { keys: [childSessionKey], limit: 3, maxChars: 16_000 },
      timeoutMs: 8_000,
    })) as {
      previews?: Array<{
        items: Array<{ role: string; text: string }>;
      }>;
    };
    const items = previewResult?.previews?.[0]?.items ?? [];
    // Walk backwards for the most recent assistant message.
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.role === "assistant" && items[i].text) {
        return items[i].text;
      }
    }
  } catch {
    // best-effort
  }
  return "";
}

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Start the closed loop for a task. Returns immediately; the loop runs in
 * the background and updates the queue / kanban / Telegram as it goes.
 * Safe to call again — re-entry on the same task is a no-op while a loop
 * is in flight.
 */
export async function startOrchestratedTask(
  task: QueuedTask,
  customDeps?: Partial<OrchestratorDeps>,
): Promise<{ started: boolean; reason?: string }> {
  if (running.has(task.id)) {
    return { started: false, reason: "already running" };
  }

  // Pre-fire gate. Honor task.context.prefireRequired === false so the
  // gateway handler's "skip prefire" path agrees with the orchestrator.
  //
  // SELF-HEAL (NO-BLOCKAGES): if the prefire is missing AND prefireRequired
  // is unset/true, auto-flip prefireRequired to false instead of refusing
  // to start. The runLoop has deterministic fallbacks for every prefire
  // field (successCriteria → task.description, builderAgentId → "coder",
  // testerEnabled → false, maxIterations → 5) so the loop can always
  // proceed. Refusing to start was the dominant production failure mode.
  let prefireRequired = task.context?.prefireRequired !== false;
  if (prefireRequired) {
    const prefireCheck = validatePrefire(task);
    if (!prefireCheck.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[autonomy] prefire missing for ${task.id} (${task.title}); auto-flipping prefireRequired=false. Missing: ${prefireCheck.missing.join(", ")}`,
      );
      if (!task.context) task.context = {};
      task.context.prefireRequired = false;
      prefireRequired = false;
      logAudit("prefire_completed", `Pre-fire auto-skipped (self-heal) for ${task.title}`, {
        category: "autonomy",
        target: task.id,
        outcome: "success",
        details: { selfHeal: true, missing: prefireCheck.missing },
      });
    }
  }

  const deps = await resolveDeps(customDeps);
  // H1: a throw inside runLoop bypasses every inner failTask/notify call and
  // leaves the task stranded in status:"running" forever. Catch at the
  // boundary so the queue/audit/telegram trio always learn about it and the
  // promise can't surface as an unhandled rejection.
  const promise = runLoop(task, deps)
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        task.currentPhase = "failed";
        deps.failTask(task.id, `orchestrator crashed: ${msg}`);
      } catch {
        // best-effort — the queue may itself be the thing that exploded
      }
      try {
        logAudit("task_failed", `Orchestrator crashed: ${task.title}`, {
          category: "autonomy",
          target: task.id,
          outcome: "failure",
          details: { error: msg },
        });
      } catch {
        /* best-effort */
      }
      try {
        await notifications.taskFailed(task.title, task.id, `Orchestrator crashed: ${msg}`);
      } catch {
        /* best-effort */
      }
    })
    .finally(() => {
      running.delete(task.id);
    });
  running.set(task.id, promise);
  return { started: true };
}

async function resolveDeps(custom?: Partial<OrchestratorDeps>): Promise<OrchestratorDeps> {
  const { queue } = await import("./queue.js");
  return {
    spawnSubagent: custom?.spawnSubagent ?? defaultSpawnSubagent,
    waitForSubagent: custom?.waitForSubagent ?? defaultWaitForSubagent,
    updateTask:
      custom?.updateTask ??
      ((taskId, patch) => {
        const t = queue.getById(taskId);
        if (!t) return null;
        patch(t);
        queue.persist();
        return t;
      }),
    completeTask:
      custom?.completeTask ??
      ((taskId, outcome) => {
        queue.complete(taskId, outcome);
      }),
    failTask:
      custom?.failTask ??
      ((taskId, error) => {
        queue.fail(taskId, error);
      }),
    blockTask:
      custom?.blockTask ??
      ((taskId, reason) => {
        if (typeof (queue as { block?: unknown }).block === "function") {
          queue.block(taskId, reason);
        } else {
          // Defensive fallback for any queue shim lacking block(): a parked
          // task must never be left "running". Fail closed.
          queue.fail(taskId, reason);
        }
      }),
  };
}

/**
 * Persist whatever phase-progress mutations were made on `task` since the
 * last call. We rely on the orchestrator only touching tasks fetched from
 * the queue, so writing the whole queue back captures them.
 */
async function persistTask(): Promise<void> {
  try {
    const { queue } = await import("./queue.js");
    queue.persist();
  } catch {
    // best-effort
  }
}

// ─── Self-heal classification (COORDINATION: orch-self-heal) ───────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Max heal+retry attempts per phase before a task is parked as blocked. */
const PHASE_HEAL_RETRIES = Math.max(
  0,
  parseInt(process.env.AUTONOMY_PHASE_HEAL_RETRIES ?? "3", 10),
);

type InfraDecision =
  | { action: "retry"; delayMs: number; note: string }
  | { action: "block"; blocker: string; healAction: string }
  // Genuine task failure (not infra) — caller runs its existing terminal path.
  | { action: "fail" };

/**
 * Classify a phase failure and, if it's an infra/tool error, attempt a heal.
 * Returns whether the caller should retry the phase (heal succeeded / transient
 * and budget remains), park the task as blocked (infra but unhealable / budget
 * exhausted), or fall through to its existing terminal failure path (genuine
 * task error). Persists the task's heal bookkeeping. Never throws.
 */
async function decideInfraRecovery(
  task: QueuedTask,
  phase: "build" | "test",
  error: unknown,
  healAttempt: number,
): Promise<InfraDecision> {
  const errorText = error instanceof Error ? error.message : String(error);
  const cls = classifyFailure({ error, errorText, task, phase });
  if (cls.kind !== "infra") {
    return { action: "fail" };
  }
  const heal = await attemptHeal({ error, errorText, task, phase });
  void persistTask();
  const canRetry = healAttempt < PHASE_HEAL_RETRIES && (heal.healed || heal.retryable);
  if (canRetry) {
    const plan = planIterationRetry({ reason: "error", priorAttempts: healAttempt });
    return { action: "retry", delayMs: plan.delayMs, note: heal.action };
  }
  return { action: "block", blocker: errorText, healAction: heal.action };
}

// ─── Loop ────────────────────────────────────────────────────────────────

// COORDINATION: goal-orchestrator-mode — multi-turn goal loop. Each turn calls
// runOrchestratorTurn (planner → sub-agent fan-out → synthesis) then evaluateGoal
// to decide done/continue. Persists per-iteration history on the task so a
// restart resumes from the last saved budget.
async function runGoalLoop(task: QueuedTask, deps: OrchestratorDeps): Promise<void> {
  const goalText = (task.goalText || task.description || task.title).trim();
  if (!goalText) {
    deps.failTask(task.id, "goal task missing goalText");
    return;
  }
  if (!task.goalBudget) {
    task.goalBudget = { maxTurns: 10, turnsUsed: 0, startedAt: Date.now() };
  } else if (task.goalBudget.startedAt == null) {
    task.goalBudget.startedAt = Date.now();
  }
  if (!Array.isArray(task.goalIterations)) task.goalIterations = [];

  task.currentPhase = "building";
  deps.updateTask(task.id, (t) => {
    t.goalBudget = task.goalBudget;
    t.goalIterations = task.goalIterations;
    t.currentPhase = task.currentPhase;
  });
  void syncToKanban(task);

  logAudit("task_started", `Goal loop started: ${task.title}`, {
    category: "autonomy",
    target: task.id,
    outcome: "success",
    details: {
      kind: "goal",
      maxTurns: task.goalBudget.maxTurns,
      subgoals: task.subgoalText?.length ?? 0,
    },
  });

  const conversationTail: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  while ((task.goalBudget?.turnsUsed ?? 0) < (task.goalBudget?.maxTurns ?? 10)) {
    const iterationIndex = task.goalIterations.length;
    const priorIterations = task.goalIterations.map((it) => ({
      summary: it.summary,
      subagentRuns: it.subagentRuns,
    }));

    const iterStart = Date.now();
    let turnResult: Awaited<ReturnType<typeof runOrchestratorTurn>>;
    try {
      turnResult = await runOrchestratorTurn({
        goalText,
        subgoalText: task.subgoalText,
        priorIterations,
        budget: { ...task.goalBudget! },
        goalId: task.id,
        iterationIndex,
        priorityMode: "production-reliability",
        backend: task.backend,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.failTask(task.id, `goal orchestrator turn crashed: ${msg}`);
      return;
    }

    task.goalIterations.push({
      index: iterationIndex,
      summary: turnResult.summary,
      reasoning: turnResult.reasoning,
      subagentRuns: turnResult.spawnedRunIds.map<SubagentRunRef>((runId) => ({
        runId,
        label: "",
        status: turnResult.completedRunIds.includes(runId) ? "completed" : "running",
      })),
      errors: turnResult.errors?.map((e) => ({ phase: e.phase, message: e.message })),
      startedAt: iterStart,
      endedAt: Date.now(),
    });
    task.goalBudget!.turnsUsed += 1;
    conversationTail.push({ role: "assistant", content: turnResult.summary });
    if (conversationTail.length > 20) conversationTail.splice(0, conversationTail.length - 20);

    deps.updateTask(task.id, (t) => {
      t.goalBudget = task.goalBudget;
      t.goalIterations = task.goalIterations;
    });
    void syncToKanban(task);

    // Fail fast on auth/credential errors. Without this, the loop burns
    // the full budget on the same permanent error in milliseconds (we
    // observed 10 turns in 280ms when Anthropic creds were missing).
    // Auth failures are not transient — the user needs to fix creds or
    // pick a different backend, retrying doesn't help.
    const authFatal = turnResult.errors?.some(
      (e) =>
        e.phase === "other" &&
        /credentials unavailable|no api key|api key resolved/i.test(e.message),
    );
    if (authFatal) {
      const reason = turnResult.errors![0].message;
      task.currentPhase = "failed";
      logAudit("task_failed", `Goal failed (auth): ${task.title}`, {
        category: "autonomy",
        target: task.id,
        outcome: "failure",
        details: { reason, turnsUsed: task.goalBudget!.turnsUsed },
      });
      deps.failTask(task.id, reason);
      try {
        await notifications.taskFailed(task.title, task.id, reason);
      } catch {
        /* best-effort */
      }
      return;
    }

    // Judge after each iteration.
    let verdict;
    try {
      verdict = await evaluateGoal({
        goalText,
        conversationTail,
        subgoals: task.subgoalText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logAudit("task_failed", `Goal judge crashed: ${task.title}`, {
        category: "autonomy",
        target: task.id,
        outcome: "failure",
        details: { error: msg },
      });
      // Treat judge crash as continue — do not abort the goal on judge flakiness.
      verdict = { done: false, rationale: `judge error: ${msg}`, blocked: false };
    }

    if (verdict.blocked) {
      task.currentPhase = "blocked";
      try {
        deps.blockTask?.(task.id, verdict.rationale || "goal judge marked blocked");
      } catch {
        deps.failTask(task.id, verdict.rationale || "goal blocked");
      }
      return;
    }
    if (verdict.done) {
      task.currentPhase = "done";
      deps.completeTask(task.id, verdict.rationale || "goal complete");
      try {
        const startedAt = task.goalBudget?.startedAt ?? Date.now();
        await notifications.taskCompleted(
          task.title,
          task.id,
          Date.now() - startedAt,
          verdict.rationale || "goal complete",
        );
      } catch {
        /* best-effort */
      }
      return;
    }
    if (verdict.nextPrompt) {
      conversationTail.push({ role: "user", content: verdict.nextPrompt });
    }
  }

  // Budget exhausted without judge marking done.
  const used = task.goalBudget?.turnsUsed ?? 0;
  const max = task.goalBudget?.maxTurns ?? 0;
  const reason = `goal budget exhausted (${used}/${max} turns)`;
  task.currentPhase = "failed";
  deps.failTask(task.id, reason);
  try {
    await notifications.taskFailed(task.title, task.id, reason);
  } catch {
    /* best-effort */
  }
}

async function runLoop(task: QueuedTask, deps: OrchestratorDeps): Promise<void> {
  // COORDINATION: goal-orchestrator-mode — dispatch goal-kind tasks to the
  // iterative orchestrator loop. The build/test path below is bypassed.
  if (task.kind === "goal") {
    await runGoalLoop(task, deps);
    return;
  }
  // Park the task as "blocked" on an unhealable tool/infra failure and fire a
  // de-duped critical-blocker Telegram alert. The heartbeat resumes it later
  // (and after a restart). COORDINATION: orch-self-heal
  const parkBlocked = async (
    blocker: string,
    healAction: string,
    iteration?: TaskIteration,
  ): Promise<void> => {
    task.currentPhase = "blocked";
    if (iteration && !iteration.endedAt) iteration.endedAt = Date.now();
    try {
      deps.blockTask?.(task.id, blocker);
    } catch {
      // best-effort — fall back to fail so we never strand a "running" task.
      try {
        deps.failTask(task.id, `blocked (block path failed): ${blocker}`);
      } catch {
        /* best-effort */
      }
    }
    // De-dupe: only fire a critical alert when the blocker actually changes,
    // so a parked-and-retrying task doesn't spam Telegram every tick.
    if (task.blockedNotifiedFor !== blocker) {
      task.blockedNotifiedFor = blocker;
      try {
        await notifications.criticalBlocker(task.title, task.id, blocker, healAction);
      } catch {
        /* best-effort */
      }
    }
    void persistTask();
    void syncToKanban(task);
  };

  // Dynamic prefireForm wins when it exists; otherwise fall back to the
  // legacy questionnaire. Pull every operational knob from the answered
  // fields so the orchestrator can run without a parallel legacy block.
  const form = task.context?.prefireForm;
  const legacy = task.context?.prefire;
  const answerStr = (id: string): string | undefined => {
    const v = form?.answers?.[id];
    return typeof v === "string" ? v : undefined;
  };
  const answerNum = (id: string): number | undefined => {
    const v = form?.answers?.[id];
    return typeof v === "number" ? v : undefined;
  };
  const answerBool = (id: string): boolean | undefined => {
    const v = form?.answers?.[id];
    return typeof v === "boolean" ? v : undefined;
  };
  // NO-BLOCKAGES: when the operator skipped the prefire form, no explicit
  // successCriteria exists. Walk the most-specific → least-specific fallback
  // chain; the deterministic synthesizer at the end guarantees a non-empty
  // criteria string so the tester / builder always have something to anchor on.
  const successCriteria =
    legacy?.successCriteria?.trim() ||
    answerStr("successCriteria")?.trim() ||
    answerStr("success_criteria")?.trim() ||
    form?.summary?.trim() ||
    synthesizeSuccessCriteria(task);
  // Execution mode / CLI / cwd. Caller chose "terminal" → launch builder
  // (and optionally tester) inside a long-lived PTY running a Claude Code /
  // OpenCode / Gemini CLI instead of a native gateway agent.
  const executionMode: TaskExecutionMode =
    (legacy?.executionMode as TaskExecutionMode | undefined) ??
    (answerStr("executionMode") as TaskExecutionMode | undefined) ??
    "gateway";
  const cliKind: TaskCliKind =
    (legacy?.cli as TaskCliKind | undefined) ??
    (answerStr("cli") as TaskCliKind | undefined) ??
    "claude";
  const cwd = legacy?.cwd ?? answerStr("cwd") ?? undefined;

  const prefire = {
    successCriteria,
    testTargets: legacy?.testTargets ?? [],
    maxIterations: legacy?.maxIterations ?? answerNum("maxIterations") ?? 5,
    testerEnabled: legacy?.testerEnabled ?? answerBool("testerEnabled") ?? false,
    builderAgentId: legacy?.builderAgentId ?? answerStr("builderAgentId"),
    testerAgentId: legacy?.testerAgentId ?? answerStr("testerAgentId"),
    executionMode,
    cli: cliKind,
    cwd,
    notes: legacy?.notes ?? answerStr("notes"),
    completed: true,
    completedAt: legacy?.completedAt ?? form?.readyAt ?? Date.now(),
  } as NonNullable<typeof legacy>;
  const maxIter = Math.max(1, prefire.maxIterations);
  const builderAgentId = prefire.builderAgentId || "coder";

  // Ensure iteration history exists
  if (!Array.isArray(task.iterations)) task.iterations = [];

  // Reflect "we accept this and we're going" in audit
  logAudit("prefire_completed", `Pre-fire passed; starting loop for ${task.title}`, {
    category: "autonomy",
    target: task.id,
    outcome: "success",
    details: {
      maxIterations: maxIter,
      testerEnabled: prefire.testerEnabled,
      builder: builderAgentId,
      targets: prefire.testTargets.length,
    },
  });

  let lastVerdict: TesterVerdict | undefined;

  for (let i = 1; i <= maxIter; i++) {
    const iteration: TaskIteration = {
      number: i,
      startedAt: Date.now(),
      buildAgentId: builderAgentId,
    };
    task.iterations.push(iteration);
    task.currentPhase = "building";

    logAudit("iteration_started", `Iteration ${i} started: ${task.title}`, {
      category: "autonomy",
      target: task.id,
      details: { iteration: i, max: maxIter },
    });
    await notifications.iterationStarted(task.title, task.id, i, maxIter, builderAgentId);
    void persistTask();
    void syncToKanban(task);

    // ── BUILD ───────────────────────────────────────────────────────
    // The spawn + wait are wrapped in a heal-aware retry loop. On an
    // infra/tool failure (matched by the self-heal registry, or a transient
    // network error) we heal + retry the SAME phase — the iteration counter
    // does NOT advance, so "keep going until complete" holds. When the heal
    // budget is exhausted the task is PARKED ("blocked"), not failed, so the
    // heartbeat resumes it later / after a restart. A genuine task failure
    // (no healer, not transient) takes the existing terminal path.
    // A wait "timeout" stays terminal (H2) — it isn't a tool we can heal.
    // COORDINATION: orch-self-heal
    const previous = task.iterations[task.iterations.length - 2];
    const builderPrompt = buildBuilderPrompt(task, prefire, iteration, previous);
    let buildSpawn: { runId: string; childSessionKey: string; terminalId?: string };
    let buildResult: { status: "ok" | "error" | "timeout"; error?: string; reply?: string };
    let buildHealAttempt = 0;
    // eslint-disable-next-line no-constant-condition
    buildPhase: while (true) {
      // SPAWN
      try {
        const safeParams = validateSpawnParams({
          agentId: builderAgentId,
          task: builderPrompt,
          label: `Build iter ${i} · ${task.title}`,
        });
        buildSpawn = await deps.spawnSubagent({
          agentId: safeParams.agentId,
          task: safeParams.task,
          label: safeParams.label,
          runTimeoutSeconds: safeParams.runTimeoutSeconds,
          mode: executionMode,
          cli: cliKind,
          cwd,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const decision = await decideInfraRecovery(task, "build", e, buildHealAttempt);
        if (decision.action === "retry") {
          buildHealAttempt++;
          task.currentPhase = "healing";
          void persistTask();
          if (decision.delayMs) await sleep(decision.delayMs);
          continue buildPhase;
        }
        iteration.buildOutcome = "error";
        iteration.endedAt = Date.now();
        iteration.notes = `Builder spawn failed: ${msg}`;
        logAudit("iteration_build_done", `Build spawn failed iter ${i}`, {
          category: "autonomy",
          target: task.id,
          outcome: decision.action === "block" ? "blocked" : "failure",
          details: { iteration: i, error: msg, parked: decision.action === "block" },
        });
        if (decision.action === "block") {
          await parkBlocked(decision.blocker, decision.healAction, iteration);
          return;
        }
        task.currentPhase = "failed";
        deps.failTask(task.id, `iteration ${i} build spawn failed: ${msg}`);
        await notifications.taskFailed(task.title, task.id, `Build spawn failed: ${msg}`);
        void persistTask();
        void syncToKanban(task);
        return;
      }
      iteration.buildRunId = buildSpawn.runId;
      iteration.buildSessionKey = buildSpawn.childSessionKey;
      if (buildSpawn.terminalId) {
        iteration.buildTerminalId = buildSpawn.terminalId;
      }
      task.currentPhase = "building";

      // WAIT
      buildResult = await deps.waitForSubagent(buildSpawn.runId, 30 * 60_000);
      iteration.buildOutcome = buildResult.status;
      if (buildResult.status === "ok") {
        iteration.buildSummary =
          buildResult.reply || (await fetchSubagentReply(buildSpawn.childSessionKey));
      } else {
        iteration.buildSummary = `Builder ${buildResult.status}: ${buildResult.error ?? ""}`;
      }
      logAudit("iteration_build_done", `Build iter ${i} ${iteration.buildOutcome}`, {
        category: "autonomy",
        target: task.id,
        outcome: buildResult.status === "ok" ? "success" : "failure",
        details: { iteration: i, runId: buildSpawn.runId },
      });
      void persistTask();
      void syncToKanban(task);

      if (buildResult.status === "ok") break buildPhase;

      // H2: a "timeout" from the wait means the wait window expired (the agent
      // may still be running) — feeding the tester a phantom builder is worse
      // than stopping. Timeout is terminal and is NOT a healable tool error.
      if (buildResult.status === "timeout") {
        task.currentPhase = "failed";
        iteration.endedAt = Date.now();
        const reasonDetail = buildResult.error ?? "wait expired before agent reported done";
        deps.failTask(task.id, `iteration ${i} builder timed out: ${reasonDetail}`);
        await notifications.taskFailed(
          task.title,
          task.id,
          `Iteration ${i} builder timed out: ${reasonDetail}`,
        );
        void persistTask();
        void syncToKanban(task);
        return;
      }

      // status === "error" → classify. Infra/tool errors heal + retry; genuine
      // build errors take the existing terminal path.
      const errObj = new Error(buildResult.error ?? "builder error");
      const decision = await decideInfraRecovery(task, "build", errObj, buildHealAttempt);
      if (decision.action === "retry") {
        buildHealAttempt++;
        task.currentPhase = "healing";
        void persistTask();
        if (decision.delayMs) await sleep(decision.delayMs);
        continue buildPhase;
      }
      iteration.endedAt = Date.now();
      if (decision.action === "block") {
        await parkBlocked(decision.blocker, decision.healAction, iteration);
        return;
      }
      task.currentPhase = "failed";
      const reasonDetail = buildResult.error ?? "unknown";
      deps.failTask(task.id, `iteration ${i} builder error: ${reasonDetail}`);
      await notifications.taskFailed(
        task.title,
        task.id,
        `Iteration ${i} builder error: ${reasonDetail}`,
      );
      void persistTask();
      void syncToKanban(task);
      return;
    }

    // ── TEST ────────────────────────────────────────────────────────
    if (!prefire.testerEnabled) {
      // Tester opted out — accept the build summary as outcome.
      task.currentPhase = "done";
      iteration.endedAt = Date.now();
      iteration.notes = "Tester disabled in pre-fire — accepting builder output.";
      deps.completeTask(task.id, iteration.buildSummary ?? "completed (tester disabled)");
      await notifications.taskCompleted(
        task.title,
        task.id,
        iteration.endedAt - iteration.startedAt,
        iteration.buildSummary,
      );
      void persistTask();
      void syncToKanban(task);
      return;
    }

    task.currentPhase = "testing";
    const testerPrompt = buildTesterPrompt(task, prefire, iteration);
    let testerSpawn: { runId: string; childSessionKey: string; terminalId?: string };
    let testerResult: { status: "ok" | "error" | "timeout"; error?: string; reply?: string };
    let testHealAttempt = 0;
    // Same heal-aware retry loop as the build phase. COORDINATION: orch-self-heal
    // eslint-disable-next-line no-constant-condition
    testPhase: while (true) {
      // SPAWN
      try {
        const safeParams = validateSpawnParams({
          agentId: prefire.testerAgentId || builderAgentId,
          task: testerPrompt,
          label: `Test iter ${i} · ${task.title}`,
        });
        testerSpawn = await deps.spawnSubagent({
          agentId: safeParams.agentId,
          task: safeParams.task,
          label: safeParams.label,
          runTimeoutSeconds: safeParams.runTimeoutSeconds,
          mode: executionMode,
          cli: cliKind,
          cwd,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const decision = await decideInfraRecovery(task, "test", e, testHealAttempt);
        if (decision.action === "retry") {
          testHealAttempt++;
          task.currentPhase = "healing";
          void persistTask();
          if (decision.delayMs) await sleep(decision.delayMs);
          continue testPhase;
        }
        iteration.notes = `Tester spawn failed: ${msg}`;
        iteration.endedAt = Date.now();
        logAudit("iteration_test_done", `Tester spawn failed iter ${i}`, {
          category: "autonomy",
          target: task.id,
          outcome: decision.action === "block" ? "blocked" : "failure",
          details: { iteration: i, error: msg, parked: decision.action === "block" },
        });
        if (decision.action === "block") {
          await parkBlocked(decision.blocker, decision.healAction, iteration);
          return;
        }
        task.currentPhase = "failed";
        deps.failTask(task.id, `iteration ${i} tester spawn failed: ${msg}`);
        await notifications.taskFailed(task.title, task.id, `Tester spawn failed: ${msg}`);
        void persistTask();
        void syncToKanban(task);
        return;
      }
      iteration.testerRunId = testerSpawn.runId;
      iteration.testerSessionKey = testerSpawn.childSessionKey;
      if (testerSpawn.terminalId) {
        iteration.testerTerminalId = testerSpawn.terminalId;
      }
      task.currentPhase = "testing";

      // WAIT
      testerResult = await deps.waitForSubagent(testerSpawn.runId, 15 * 60_000);
      if (testerResult.status === "ok") break testPhase;

      // H2: a tester "timeout" means we can't parse a verdict from a missing
      // reply (empty-reply parse tends to come back PASS by accident).
      // Timeout is terminal and not a healable tool error.
      if (testerResult.status === "timeout") {
        const reasonDetail = testerResult.error ?? "wait expired before tester reported done";
        const failVerdict: TesterVerdict = {
          pass: false,
          summary: `Tester timed out: ${reasonDetail}`,
          reasons: ["Tester timed out"],
          evidence: [],
          fixHints: [],
          rawOutput: testerResult.reply,
        };
        iteration.testerVerdict = failVerdict;
        iteration.endedAt = Date.now();
        task.currentPhase = "failed";
        logAudit("iteration_test_done", `Tester iter ${i} timed out`, {
          category: "autonomy",
          target: task.id,
          outcome: "failure",
          details: { iteration: i, error: reasonDetail },
        });
        deps.failTask(task.id, `iteration ${i} tester timed out: ${reasonDetail}`);
        await notifications.taskFailed(
          task.title,
          task.id,
          `Iteration ${i} tester timed out: ${reasonDetail}`,
        );
        void persistTask();
        void syncToKanban(task);
        return;
      }

      // status === "error" → classify. Infra/tool errors heal + retry; a
      // genuine tester error takes the existing terminal failed-verdict path.
      const errObj = new Error(testerResult.error ?? "tester error");
      const decision = await decideInfraRecovery(task, "test", errObj, testHealAttempt);
      if (decision.action === "retry") {
        testHealAttempt++;
        task.currentPhase = "healing";
        void persistTask();
        if (decision.delayMs) await sleep(decision.delayMs);
        continue testPhase;
      }
      const reasonDetail = testerResult.error ?? "unknown";
      const failVerdict: TesterVerdict = {
        pass: false,
        summary: `Tester errored: ${reasonDetail}`,
        reasons: ["Tester errored"],
        evidence: [],
        fixHints: [],
        rawOutput: testerResult.reply,
      };
      iteration.testerVerdict = failVerdict;
      iteration.endedAt = Date.now();
      logAudit("iteration_test_done", `Tester iter ${i} errored`, {
        category: "autonomy",
        target: task.id,
        outcome: decision.action === "block" ? "blocked" : "failure",
        details: { iteration: i, error: reasonDetail, parked: decision.action === "block" },
      });
      if (decision.action === "block") {
        await parkBlocked(decision.blocker, decision.healAction, iteration);
        return;
      }
      task.currentPhase = "failed";
      deps.failTask(task.id, `iteration ${i} tester errored: ${reasonDetail}`);
      await notifications.taskFailed(
        task.title,
        task.id,
        `Iteration ${i} tester errored: ${reasonDetail}`,
      );
      void persistTask();
      void syncToKanban(task);
      return;
    }

    const testerReply =
      testerResult.reply || (await fetchSubagentReply(testerSpawn.childSessionKey));
    const verdict = parseTesterVerdict(testerReply);
    iteration.testerVerdict = verdict;
    iteration.fixHints = verdict.fixHints;
    lastVerdict = verdict;

    logAudit("iteration_test_done", `Tester iter ${i}: ${verdict.pass ? "PASS" : "FAIL"}`, {
      category: "autonomy",
      target: task.id,
      outcome: verdict.pass ? "success" : "failure",
      details: {
        iteration: i,
        summary: verdict.summary,
        reasons: verdict.reasons,
      },
    });
    await notifications.testerVerdict(task.title, task.id, i, verdict.pass, verdict.summary);
    void persistTask();
    void syncToKanban(task);

    // ── ASSESS ──────────────────────────────────────────────────────
    task.currentPhase = "assessing";
    iteration.endedAt = Date.now();
    logAudit("iteration_assess", `Iteration ${i} assessment recorded`, {
      category: "autonomy",
      target: task.id,
      details: {
        iteration: i,
        pass: verdict.pass,
        durationMs: iteration.endedAt - iteration.startedAt,
      },
    });

    if (verdict.pass) {
      task.currentPhase = "done";
      deps.completeTask(task.id, verdict.summary);
      await notifications.taskCompleted(
        task.title,
        task.id,
        iteration.endedAt - iteration.startedAt,
        verdict.summary,
      );
      void persistTask();
      void syncToKanban(task);
      return;
    }
    // FAIL → continue to next iteration if budget remains
  }

  // Iteration cap exhausted without a pass.
  task.currentPhase = "failed";
  const lastSummary = lastVerdict?.summary ?? "no tester verdict captured";
  logAudit("iteration_max_reached", `Iteration cap reached for ${task.title}`, {
    category: "autonomy",
    target: task.id,
    outcome: "failure",
    details: { maxIterations: maxIter, lastSummary },
  });
  deps.failTask(task.id, `iteration cap (${maxIter}) reached: ${lastSummary}`);
  await notifications.maxIterationsReached(task.title, task.id, maxIter, lastSummary);
  void syncToKanban(task);
}

/** Test-only: snapshot of in-flight loops. */
export function getRunningOrchestrationsForTests(): string[] {
  return [...running.keys()];
}
