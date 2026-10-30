/**
 * Goal-run service — gateway-side singleton wiring for {@link GoalRunner}:
 * durable store (queue.db), production executor, WS events and completion /
 * failure notifications through the autonomy notification path (Telegram).
 *
 * Shared by the `goals.*` RPCs and the `goal_run` agent tool so both surfaces
 * validate input identically.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { broadcastQueueBridgeEvent } from "../../queue/events.js";
import { sendNotification } from "../notifications.js";
import { buildDeepLink } from "../../notifications/links.js";
import { normalizeChecks, describeCheck } from "./checks.js";
import { createGoalExecutor } from "./executor.js";
import { GoalRunner, type GoalExecutor } from "./runner.js";
import { getGoalStore, type GoalStore } from "./store.js";
import type { CreateGoalInput, GoalAgentTarget, GoalCliBackend, GoalRun } from "./types.js";

const log = createSubsystemLogger("autonomy.goals.service");
const CLI_BACKENDS: GoalCliBackend[] = ["claude-code", "codex", "opencode", "gemini", "grok"];

let runner: GoalRunner | null = null;

/** Compact summary for list views / events (no prompts or outputs). */
export function summarizeGoal(run: GoalRun) {
  const last = run.iterations.at(-1);
  const results = run.checks.map((c) => run.lastResults[c.id ?? ""]).filter(Boolean);
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    reason: run.reason,
    target: run.target,
    workdir: run.workdir,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    updatedAt: run.updatedAt,
    iterations: run.iterations.length,
    maxIterations: run.limits.maxIterations,
    checksTotal: run.checks.length,
    checksPassing: results.filter((r) => r.pass).length,
    lastOutcome: last?.outcome ?? null,
    currentRunId: last && last.endedAt === null ? last.runId : null,
  };
}

/** Push (Expo + in-app) for a finished goal, deep-linked to infinibot://goals/<id>. */
async function pushGoal(run: GoalRun, title: string, body: string): Promise<void> {
  try {
    const { emitNotification } = await import("../../notifications/emit.js");
    const ok = run.status === "completed";
    await emitNotification({
      category: "autonomy.checkpoint",
      severity: ok ? "success" : "error",
      title: `${title}: ${run.title}`.slice(0, 200),
      body: body.slice(0, 400),
      source: "goals",
      sourceId: run.id,
      deepLink: buildDeepLink({ kind: "goal", id: run.id }),
      displayTitle: `${title}: ${run.title}`.slice(0, 200),
      summary: run.reason ?? undefined,
      data: { goalId: run.id, status: run.status, iterations: run.iterations.length },
    });
  } catch (err) {
    log.warn("goal push failed", { id: run.id, error: String(err) });
  }
}

function notifyGoal(run: GoalRun): Promise<unknown> {
  const took =
    run.startedAt && run.finishedAt ? Math.round((run.finishedAt - run.startedAt) / 1000) : 0;
  const checks = run.checks
    .map((c) => `${run.lastResults[c.id ?? ""]?.pass ? "✓" : "✗"} ${describeCheck(c)}`)
    .join("\n");
  const agent = run.target.kind === "cli" ? run.target.backend : `agent:${run.target.agentId}`;
  const body = `${run.title}\n${agent} · ${run.iterations.length} iteration(s) · ${took}s\n${checks}${
    run.reason ? `\nReason: ${run.reason}` : ""
  }`;
  if (run.status === "canceled") return Promise.resolve();
  const link = buildDeepLink({ kind: "goal", id: run.id });
  const title =
    run.status === "completed"
      ? "Goal completed"
      : run.status === "exhausted"
        ? "Goal exhausted"
        : "Goal failed";
  const pushBody = `${agent} · ${run.iterations.length} iteration(s) · ${took}s${
    run.reason ? ` · ${run.reason}` : ""
  }`;
  return Promise.all([
    pushGoal(run, title, pushBody),
    sendNotification(run.status === "completed" ? "success" : "error", title, body, {
      taskId: run.id,
      link,
    }),
  ]);
}

export function createGoalRunner(
  opts: { store?: GoalStore; executor?: GoalExecutor } = {},
): GoalRunner {
  return new GoalRunner({
    store: opts.store ?? getGoalStore(),
    executor: opts.executor ?? createGoalExecutor(),
    emit: (kind, run) => {
      broadcastQueueBridgeEvent(kind, summarizeGoal(run));
      if (kind !== "goal.checked") broadcastQueueBridgeEvent("goal.changed", { id: run.id });
    },
    notify: notifyGoal,
  });
}

export function getGoalRunner(): GoalRunner {
  if (!runner) runner = createGoalRunner();
  return runner;
}

export function setGoalRunnerForTests(r: GoalRunner | null): void {
  runner = r;
}

export function startGoalRunner(): void {
  if (process.env.INFINIBOT_GOALS_DISABLE === "1") return;
  try {
    getGoalRunner().start(Number(process.env.INFINIBOT_GOALS_TICK_MS) || 5_000);
  } catch (err) {
    log.warn("goal runner failed to start", { error: String(err) });
  }
}

/** Parse + validate an agent target from loose input (RPC / tool / UI). */
export function parseGoalTarget(raw: unknown): GoalAgentTarget {
  if (typeof raw === "string") {
    const s = raw.trim();
    if ((CLI_BACKENDS as string[]).includes(s))
      return { kind: "cli", backend: s as GoalCliBackend };
    if (s === "claude") return { kind: "cli", backend: "claude-code" };
    if (s.startsWith("agent:")) return { kind: "agent", agentId: s.slice(6) };
    if (s) return { kind: "agent", agentId: s };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : undefined;
    if (o.kind === "agent" && typeof o.agentId === "string" && o.agentId.trim()) {
      return { kind: "agent", agentId: o.agentId.trim(), model };
    }
    const backend = o.backend === "claude" ? "claude-code" : o.backend;
    if (
      (o.kind === "cli" || o.kind === undefined) &&
      (CLI_BACKENDS as unknown[]).includes(backend)
    ) {
      return { kind: "cli", backend: backend as GoalCliBackend, model };
    }
  }
  throw new Error(
    `target must be a CLI backend (${CLI_BACKENDS.join(" | ")}) or { kind: "agent", agentId }`,
  );
}

/** Validate loose input and create the run. Throws with a user-facing message. */
export function createGoalFromInput(raw: Record<string, unknown>): GoalRun {
  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  if (!goal) throw new Error("goal is required");
  const checks = normalizeChecks(raw.checks ?? []);
  if (checks.length === 0) {
    throw new Error("at least one completion check is required (shell | file | grep | llm)");
  }
  const target = parseGoalTarget(raw.target ?? raw.backend ?? "claude-code");
  if (typeof raw.model === "string" && raw.model.trim()) target.model = raw.model.trim();
  let workdir = typeof raw.workdir === "string" && raw.workdir.trim() ? raw.workdir.trim() : null;
  if (workdir?.startsWith("~/")) workdir = resolve(homedir(), workdir.slice(2));
  if (workdir && !existsSync(workdir)) throw new Error(`workdir does not exist: ${workdir}`);
  const limits = (
    raw.limits && typeof raw.limits === "object" ? raw.limits : {}
  ) as CreateGoalInput["limits"];
  const run = getGoalRunner().store.create({
    title: typeof raw.title === "string" ? raw.title : undefined,
    goal,
    checks,
    target,
    workdir,
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    limits,
    createdBy: typeof raw.createdBy === "string" ? raw.createdBy : null,
    notify: raw.notify !== false,
    start: raw.start !== false,
  });
  broadcastQueueBridgeEvent("goal.created", summarizeGoal(run));
  broadcastQueueBridgeEvent("goal.changed", { id: run.id });
  // Kick the first spawn now instead of waiting for the next tick.
  void getGoalRunner().tick();
  return run;
}
