/**
 * Goal Orchestrator — orchestrator-mode goal executor.
 *
 * Replaces the flat single-LLM executeGoalTurn with a planning → tool-execution
 * → synthesis loop. One "turn" from the judge's perspective encapsulates:
 *   1. LLM planning call with a constrained tool surface.
 *   2. Execution of requested tool calls (spawn, await, list, cancel).
 *   3. LLM synthesis call that produces the summary the judge evaluates.
 *
 * Production-reliability defaults:
 *   - Max 4 concurrent sub-agents per goal (AUTONOMY_GOAL_MAX_PARALLEL)
 *   - Max 20 total sub-agents per goal lifetime (AUTONOMY_GOAL_MAX_TOTAL_SUBAGENTS)
 *   - Every spawned task body is prefixed with goal context so the sub-agent
 *     knows what it's working toward.
 *   - autoApprove: true, mode: "detach", timeout: 60 min.
 */

// COORDINATION: goal-orchestrator-mode

import type { AssistantMessage, Context, Model, Api } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { callGateway } from "../gateway/call.js";
import { setSubagentLineage, listSubagentRunsByGoalId } from "../agents/subagent-registry.js";
import {
  validateSpawnParams,
  sanitizeToolResult,
  SPAWN_TIMEOUT_DEFAULT_SEC,
} from "./spawn-params.js";
import { retryWithBackoff } from "./retry.js";
import { resolveOrchestratorBackend, type ResolvedBackend } from "./orchestrator-backends.js";
import type { AutonomyBackend } from "./types.js";
import { runCliPlanner, checkCliAvailable, type CliPlannerBackend } from "./cli-planner.js";

// COORDINATION: goal-orchestrator-mode — concurrency caps
const MAX_PARALLEL = Math.max(1, parseInt(process.env.AUTONOMY_GOAL_MAX_PARALLEL ?? "4", 10));
const MAX_TOTAL = Math.max(1, parseInt(process.env.AUTONOMY_GOAL_MAX_TOTAL_SUBAGENTS ?? "20", 10));
// Hard wallclock ceiling for one orchestrator turn. Caller passes
// `budget.startedAt`; if Date.now() - startedAt exceeds this we short-circuit
// before the planning call. Default 30 min, override via env. See
// docs/hermes-reliability-audit.md → Change 5 (mirrors Hermes's
// IterationBudget + wallclock-aware retry behaviour).
const MAX_TURN_WALLCLOCK_MS = Math.max(
  60_000,
  parseInt(process.env.AUTONOMY_GOAL_MAX_TURN_WALLCLOCK_SEC ?? "1800", 10) * 1_000,
);

// LLM-call retry knobs — tight so a turn that's hitting a real outage exits
// in under ~30s rather than burning the whole turn budget on backoff.
const LLM_RETRY_OPTS = {
  maxAttempts: 3,
  baseDelayMs: 1_500,
  maxDelayMs: 15_000,
} as const;

const log = createSubsystemLogger("autonomy.goal-orchestrator");
const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

// ─── Public interfaces ────────────────────────────────────────────────────

// COORDINATION: goal-orchestrator-mode — public contract

export interface SubagentRunRef {
  runId: string;
  label: string;
  status: string;
}

export interface OrchestratorTurnInput {
  goalText: string;
  subgoalText?: string[];
  priorIterations: Array<{ summary: string; subagentRuns?: SubagentRunRef[] }>;
  /**
   * Goal-level budget. `startedAt` (ms epoch) is consulted by the wallclock
   * cap; turns past `MAX_TURN_WALLCLOCK_MS` since the goal began are
   * short-circuited before the planning call.
   */
  budget: { maxTurns: number; turnsUsed: number; startedAt?: number };
  goalId: string;
  iterationIndex: number;
  /** default: "production-reliability" */
  priorityMode: "production-reliability" | "speed";
  /** Per-goal backend override. Resolved against config + claude default
   *  via resolveOrchestratorBackend. Undefined → use config default. */
  backend?: AutonomyBackend;
}

export interface OrchestratorTurnResult {
  summary: string;
  spawnedRunIds: string[];
  completedRunIds: string[];
  /** 1–2 sentence rationale visible in the iterations log. */
  reasoning: string;
  /** COORDINATION: goal-oversight — per-turn failure list. The caller appends
   *  these into task.context.recentErrors so the UI can show them. */
  errors?: Array<{
    phase: "planning" | "synthesis" | "tool" | "other";
    message: string;
    detail?: Record<string, unknown>;
  }>;
}

// ─── Internal tool-call types ─────────────────────────────────────────────

type OrchestratorToolCall =
  | { tool: "spawn_subagent"; label: string; task: string; projectHint?: string }
  | { tool: "await_subagent"; runId: string; timeoutSec?: number }
  | { tool: "list_my_subagents" }
  | { tool: "cancel_subagent"; runId: string; reason: string };

interface ToolCallResult {
  tool: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

type ResolvedAuth =
  | {
      kind: "api";
      model: Model<Api>;
      authStorage: ReturnType<typeof resolveModel>["authStorage"];
      apiKey: string;
      isOAuth: boolean;
      resolved: ResolvedBackend;
    }
  | {
      kind: "cli";
      cliBackend: CliPlannerBackend;
      resolved: ResolvedBackend;
    };

async function resolveOrchestratorAuth(
  backend: AutonomyBackend | undefined,
): Promise<ResolvedAuth | null> {
  const resolved = resolveOrchestratorBackend(backend);
  const { model, error, authStorage } = resolveModel(
    resolved.plannerProvider,
    resolved.plannerModelId,
  );
  // Prefer the local CLI binary whenever it's installed for this backend.
  // The CLI uses its own OAuth/login, sidestepping the stale-API-key /
  // expired-OAuth-token failures that put the API path into a permanent
  // auth-error loop. Honors INFINIBOT_AUTONOMY_FORCE_API=1 for the rare
  // case where someone wants the SDK path explicitly.
  const cliBackend = backendToCliPlanner(resolved);
  const forceApi = process.env.INFINIBOT_AUTONOMY_FORCE_API === "1";
  if (cliBackend && !forceApi && checkCliAvailable(cliBackend)) {
    log.info("orchestrator: using CLI planner (preferred over API)", {
      cliBackend,
      backend: resolved.backend.kind,
    });
    return { kind: "cli", cliBackend, resolved };
  }
  if (!model) {
    log.warn(
      `orchestrator: unknown model ${resolved.plannerProvider}/${resolved.plannerModelId}: ${error}`,
      { backend: resolved.backend.kind },
    );
    return null;
  }
  let auth;
  try {
    auth = await getApiKeyForModel({ model });
  } catch (err) {
    log.warn("orchestrator: credential resolution failed", {
      error: String(err),
      backend: resolved.backend.kind,
    });
    return null;
  }
  if (!auth.apiKey) {
    log.warn("orchestrator: no API key resolved and CLI not available", {
      backend: resolved.backend.kind,
      cliBackend,
    });
    return null;
  }
  authStorage.setRuntimeApiKey(model.provider, auth.apiKey);
  return {
    kind: "api",
    model,
    authStorage,
    apiKey: auth.apiKey,
    isOAuth: auth.mode === "oauth",
    resolved,
  } as const;
}

function backendToCliPlanner(resolved: ResolvedBackend): CliPlannerBackend | null {
  const kind = resolved.backend.kind;
  if (kind === "claude") return "claude-code";
  if (kind === "opencode") return "opencode";
  if (kind === "codex") return "codex";
  if (kind === "grok") return "grok";
  return null;
}

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

// ─── Spawn helper ─────────────────────────────────────────────────────────

// COORDINATION: goal-orchestrator-mode — inject goal context header into every task body
function buildTaskWithGoalHeader(task: string, goalText: string, iterationIndex: number): string {
  const truncated = goalText.length > 120 ? goalText.slice(0, 117) + "…" : goalText;
  return `[Goal: ${truncated}] [Iteration ${iterationIndex}]\n\n${task}`;
}

async function spawnGoalSubagent(params: {
  label: string;
  task: string;
  goalId: string;
  goalText: string;
  iterationIndex: number;
  resolved: ResolvedBackend;
}): Promise<{ runId: string; childSessionKey: string }> {
  const taskWithHeader = buildTaskWithGoalHeader(
    params.task,
    params.goalText,
    params.iterationIndex,
  );
  // Shared pre-call validator: label cap, task cap, timeout clamp. Failures
  // surface as SpawnParamsError("invalid agent params: …") which the retry
  // classifier already treats as non-retryable, so a bad spawn is rejected
  // immediately instead of bouncing off the gateway three times.
  const safe = validateSpawnParams({
    agentId: params.resolved.workerAgentId,
    label: params.label,
    task: taskWithHeader,
    runTimeoutSeconds: SPAWN_TIMEOUT_DEFAULT_SEC,
  });

  const result = (await callGateway({
    method: "sessions.spawn",
    params: {
      task: safe.task,
      agentId: safe.agentId,
      label: safe.label,
      runTimeoutSeconds: safe.runTimeoutSeconds,
      // Routes the spawned worker through the selected CLI backend
      // (claude-code / opencode / codex). Honored downstream by
      // subagent-registry → coder-backend/registry.
      coderBackend: params.resolved.workerCoderBackend,
    },
    timeoutMs: 30_000,
  })) as { runId?: string; childSessionKey?: string; error?: string };

  if (!result?.runId || !result?.childSessionKey) {
    throw new Error(
      `sessions.spawn failed: ${result?.error ?? "no runId/childSessionKey returned"}`,
    );
  }

  // COORDINATION: goal-orchestrator-mode — stamp lineage on registry entry
  setSubagentLineage(result.runId, {
    parentGoalId: params.goalId,
    parentGoalIterationIndex: params.iterationIndex,
    parentGoalTitle: params.goalText.slice(0, 80),
  });

  log.info("goal orchestrator: spawned sub-agent", {
    runId: result.runId,
    goalId: params.goalId,
    label: safe.label,
  });

  return { runId: result.runId, childSessionKey: result.childSessionKey };
}

// ─── Tool execution ───────────────────────────────────────────────────────

// COORDINATION: goal-orchestrator-mode — tool surface (4 tools only)
async function executeToolCall(
  call: OrchestratorToolCall,
  context: {
    goalId: string;
    goalText: string;
    iterationIndex: number;
    spawnedRunIds: string[];
    completedRunIds: string[];
    resolved: ResolvedBackend;
  },
): Promise<ToolCallResult> {
  switch (call.tool) {
    case "spawn_subagent": {
      // Cap: total subagents across this goal's lifetime.
      // H3: `listSubagentRunsByGoalId` already includes runs spawned earlier
      // in this same turn (setSubagentLineage stamps them immediately), so
      // adding context.spawnedRunIds.length on top double-counted every
      // in-turn spawn. With MAX_PARALLEL=4 this capped at 2.
      const all = listSubagentRunsByGoalId(context.goalId);
      if (all.length >= MAX_TOTAL) {
        return {
          tool: "spawn_subagent",
          ok: false,
          error: `Total sub-agent cap reached (${MAX_TOTAL} per goal lifetime). Cannot spawn more.`,
        };
      }
      // Cap: concurrent active sub-agents (same registry view).
      const active = all.filter((r) => !r.endedAt);
      if (active.length >= MAX_PARALLEL) {
        return {
          tool: "spawn_subagent",
          ok: false,
          error: `Concurrent sub-agent cap reached (${MAX_PARALLEL}). Await or cancel existing ones first.`,
        };
      }
      try {
        const { runId, childSessionKey } = await spawnGoalSubagent({
          label: call.label,
          task: call.task,
          goalId: context.goalId,
          goalText: context.goalText,
          iterationIndex: context.iterationIndex,
          resolved: context.resolved,
        });
        context.spawnedRunIds.push(runId);
        return {
          tool: "spawn_subagent",
          ok: true,
          data: { runId, childSessionKey, message: "Sub-agent spawned successfully." },
        };
      } catch (err) {
        return {
          tool: "spawn_subagent",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "await_subagent": {
      const timeoutSec = call.timeoutSec ?? 120;
      const timeoutMs = timeoutSec * 1_000;
      try {
        const result = (await callGateway({
          method: "agent.wait",
          params: { runId: call.runId, timeoutMs },
          timeoutMs: timeoutMs + 10_000,
        })) as { status?: string; error?: string; reply?: string };

        const status = result?.status ?? "timeout";
        if (status === "ok") {
          context.completedRunIds.push(call.runId);
        }
        // H6: a "timeout" response carries no error string, so the synthesis
        // turn just saw `await_subagent: FAILED {"status":"timeout","reply":""}`
        // with no hint at what went wrong. Synthesize one so the LLM has
        // something useful to reason about (still-running vs unknown runId).
        const inferredError =
          status === "timeout"
            ? `await timed out after ${timeoutSec}s (runId may be unknown or still running)`
            : result?.error;
        return {
          tool: "await_subagent",
          ok: status === "ok",
          data: {
            runId: call.runId,
            status,
            reply: result?.reply?.slice(0, 2000) ?? "",
            error: inferredError,
          },
          ...(status !== "ok" && inferredError ? { error: inferredError } : {}),
        };
      } catch (err) {
        return {
          tool: "await_subagent",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "list_my_subagents": {
      const runs = listSubagentRunsByGoalId(context.goalId);
      return {
        tool: "list_my_subagents",
        ok: true,
        data: {
          subagents: runs.map((r) => ({
            runId: r.runId,
            label: r.label ?? "(unlabelled)",
            status: r.endedAt ? (r.outcome?.status === "error" ? "failed" : "done") : "running",
            iteration: r.parentGoalIterationIndex,
          })),
          total: runs.length,
        },
      };
    }

    case "cancel_subagent": {
      try {
        await callGateway({
          method: "agent.cancel",
          params: { runId: call.runId, reason: call.reason },
          timeoutMs: 10_000,
        });
        return { tool: "cancel_subagent", ok: true, data: { runId: call.runId } };
      } catch (err) {
        return {
          tool: "cancel_subagent",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
}

// ─── LLM call helper ──────────────────────────────────────────────────────

async function callOrchestratorLLM(
  systemPrompt: string,
  userMessage: string,
  auth: ResolvedAuth,
  maxTokens = 2048,
): Promise<string> {
  if (auth.kind === "cli") {
    return runCliPlanner({
      backend: auth.cliBackend,
      systemPrompt,
      userMessage,
    });
  }
  const systemPrefix = auth.isOAuth ? `${CLAUDE_CODE_PREFIX}\n\n` : "";
  const context: Context = {
    systemPrompt: `${systemPrefix}${systemPrompt}`,
    messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
  };
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const message = (await complete(auth.model!, context, {
    apiKey: auth.apiKey,
    maxTokens,
  })) as AssistantMessage;
  return extractText(message);
}

// ─── Plan parsing ─────────────────────────────────────────────────────────

interface ParsedPlan {
  reasoning: string;
  toolCalls: OrchestratorToolCall[];
}

/**
 * Best-effort parser. Returns null when the JSON is so malformed that we
 * can't even extract a reasoning string — that signal triggers the repair
 * retry path. A non-null result with an empty toolCalls AND empty reasoning
 * still goes through the structured-error path in the caller.
 */
// COORDINATION: goal-orchestrator-mode — parse structured tool-call plan from LLM response
export function tryParsePlanResponse(text: string): ParsedPlan | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const blob = fenced ? fenced[1] : text;
  const start = blob.indexOf("{");
  const end = blob.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blob.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  const rawCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
  const toolCalls: OrchestratorToolCall[] = [];
  for (const raw of rawCalls) {
    if (!raw || typeof raw.tool !== "string") continue;
    switch (raw.tool) {
      case "spawn_subagent":
        if (typeof raw.label === "string" && typeof raw.task === "string") {
          toolCalls.push({
            tool: "spawn_subagent",
            label: raw.label,
            task: raw.task,
            projectHint: typeof raw.projectHint === "string" ? raw.projectHint : undefined,
          });
        }
        break;
      case "await_subagent":
        if (typeof raw.runId === "string") {
          toolCalls.push({
            tool: "await_subagent",
            runId: raw.runId,
            timeoutSec: typeof raw.timeoutSec === "number" ? raw.timeoutSec : 120,
          });
        }
        break;
      case "list_my_subagents":
        toolCalls.push({ tool: "list_my_subagents" });
        break;
      case "cancel_subagent":
        if (typeof raw.runId === "string") {
          toolCalls.push({
            tool: "cancel_subagent",
            runId: raw.runId,
            reason: typeof raw.reason === "string" ? raw.reason : "cancelled by orchestrator",
          });
        }
        break;
    }
  }
  return { reasoning, toolCalls };
}

function buildRepairPrompt(prevResponse: string): string {
  return `Your previous response was not valid JSON. Emit ONLY a JSON object matching this schema — no preamble, no markdown, no commentary. If you have no action to take, respond with {"reasoning": "<why>", "tool_calls": []}.

Previous response (for context only — do not echo it):
${prevResponse.slice(0, 800)}`;
}

// ─── System prompts ───────────────────────────────────────────────────────

// COORDINATION: goal-orchestrator-mode — planning system prompt
const PLANNING_SYSTEM_PROMPT = `You are an orchestrator agent. Your job is to break the goal into independent pieces of work, spawn dedicated sub-agents in parallel where possible, and synthesize their outputs. Prioritize PRODUCTION RELIABILITY over speed: prefer fewer, more focused sub-agents with well-scoped tasks over many small spammy ones. Each sub-agent is a full Claude Code session — they are slow and expensive, so only spawn one when it would do work you cannot do yourself in this turn.

You have access to 4 tools. Respond STRICTLY with valid JSON matching this structure:
{
  "reasoning": "1-2 sentence explanation of your plan",
  "tool_calls": [
    // zero or more tool calls — an empty array is valid if no action needed
  ]
}

Available tools (include in tool_calls array):
- spawn_subagent: { "tool": "spawn_subagent", "label": "short label (max 63 chars)", "task": "detailed task description" }
- await_subagent: { "tool": "await_subagent", "runId": "...", "timeoutSec": 120 }
- list_my_subagents: { "tool": "list_my_subagents" }
- cancel_subagent: { "tool": "cancel_subagent", "runId": "...", "reason": "why" }

Rules:
- Do NOT spawn sub-agents for trivial tasks you can reason about directly.
- Do NOT spawn more than ${MAX_PARALLEL} sub-agents concurrently.
- Always await a sub-agent before spawning many more (unless they are truly independent).
- If the goal looks complete based on prior iteration summaries, emit an empty tool_calls array.
- Use ONLY the four tool names listed above. Do NOT invent or rename tools.
  If none of them apply, return an empty tool_calls array and explain in "reasoning".
- If you are uncertain about a runId, runId format, or required arg, return an
  empty tool_calls array and explain — do NOT guess.
- Output ONLY the JSON object — no preamble, no markdown outside the JSON block.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are an orchestrator synthesizing the results of a goal execution turn. Write a clear, specific summary of what was accomplished and what remains. Be honest about partial progress. This summary is evaluated by a goal-completion judge, so be specific about deliverables, file changes, findings, or decisions made.`;

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Execute one orchestrator turn for a goal. Called from runGoalLoop when
 * task.context.goalMode === "orchestrator" (or undefined, which defaults to
 * orchestrator mode).
 *
 * The result's `summary` is what the judge evaluates for goal completion —
 * ensure it is high-quality and specific.
 */
// COORDINATION: goal-orchestrator-mode
export async function runOrchestratorTurn(
  input: OrchestratorTurnInput,
): Promise<OrchestratorTurnResult> {
  const errors: NonNullable<OrchestratorTurnResult["errors"]> = [];
  const fallback: OrchestratorTurnResult = {
    summary: "(orchestrator turn failed — credentials unavailable)",
    spawnedRunIds: [],
    completedRunIds: [],
    reasoning: "credentials unavailable",
    errors: [
      {
        phase: "other",
        message:
          "Anthropic credentials unavailable for orchestrator model. Check ANTHROPIC_API_KEY or OAuth login.",
      },
    ],
  };

  try {
    // ── Wallclock cap (Change 5) ──────────────────────────────────────────
    // Short-circuit BEFORE credential resolution so the cap is enforced even
    // when the model layer is broken — protects against a goal that's been
    // hammering retries for hours.
    if (
      typeof input.budget.startedAt === "number" &&
      Date.now() - input.budget.startedAt > MAX_TURN_WALLCLOCK_MS
    ) {
      const cappedSec = Math.round(MAX_TURN_WALLCLOCK_MS / 1_000);
      log.warn("orchestrator turn: wallclock cap reached", {
        goalId: input.goalId,
        startedAt: input.budget.startedAt,
        cappedSec,
      });
      return {
        summary: `(goal wallclock cap reached: ${cappedSec}s since startedAt)`,
        spawnedRunIds: [],
        completedRunIds: [],
        reasoning: "wallclock cap",
        errors: [
          {
            phase: "other",
            message: `goal wallclock cap of ${cappedSec}s reached`,
            detail: { startedAt: input.budget.startedAt, cappedSec },
          },
        ],
      };
    }

    const resolvedAuth = await resolveOrchestratorAuth(input.backend);
    if (!resolvedAuth) {
      // Surface the chosen backend in the failure so the UI can show
      // which backend was missing credentials, not just "credentials
      // unavailable" without context.
      const resolvedBackend = resolveOrchestratorBackend(input.backend);
      return {
        ...fallback,
        summary: `(orchestrator turn failed — ${resolvedBackend.displayName} credentials unavailable)`,
        reasoning: `${resolvedBackend.displayName} credentials unavailable`,
        errors: [
          {
            phase: "other",
            message: `${resolvedBackend.displayName} credentials unavailable for orchestrator model ${resolvedBackend.plannerProvider}/${resolvedBackend.plannerModelId}.`,
          },
        ],
      };
    }
    const { resolved } = resolvedAuth;

    const priorSummary =
      input.priorIterations.length > 0
        ? input.priorIterations
            .map(
              (it, i) =>
                `Turn ${i + 1}: ${it.summary}${
                  it.subagentRuns && it.subagentRuns.length > 0
                    ? ` [sub-agents: ${it.subagentRuns.map((r) => r.label).join(", ")}]`
                    : ""
                }`,
            )
            .join("\n")
        : "None — this is the first turn.";

    const subgoalBlock =
      input.subgoalText && input.subgoalText.length > 0
        ? `\nSubgoals:\n${input.subgoalText.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

    const existingSubagents = listSubagentRunsByGoalId(input.goalId);
    const existingBlock =
      existingSubagents.length > 0
        ? `\nCurrently tracked sub-agents for this goal:\n${existingSubagents
            .map(
              (r) =>
                `- ${r.runId.slice(0, 8)}: ${r.label ?? "(unlabelled)"} [${r.endedAt ? (r.outcome?.status === "error" ? "failed" : "done") : "running"}]`,
            )
            .join("\n")}`
        : "";

    const planningMessage = `GOAL: ${input.goalText}${subgoalBlock}

Budget: ${input.budget.maxTurns - input.budget.turnsUsed} turns remaining out of ${input.budget.maxTurns}.
This is turn ${input.iterationIndex}.

Prior turns:
${priorSummary}${existingBlock}

Decide what tool calls (if any) to make this turn. Remember: spawn sub-agents only for work that truly requires a full Claude Code session. If you can reason about the answer directly, just plan a synthesis with no tool calls.`;

    // ── Step 1: Planning call ─────────────────────────────────────────────
    log.info("orchestrator turn: planning", {
      goalId: input.goalId,
      iteration: input.iterationIndex,
    });

    let planText: string;
    try {
      // Wrap the model call in retryWithBackoff so transient network /
      // overloaded errors don't kill the whole turn (Change 3, mirrors the
      // inner retry loop around api calls in Hermes's conversation_loop.py).
      planText = await retryWithBackoff(
        () => callOrchestratorLLM(PLANNING_SYSTEM_PROMPT, planningMessage, resolvedAuth, 1024),
        LLM_RETRY_OPTS,
      );
    } catch (err) {
      log.warn("orchestrator planning call failed", { error: String(err) });
      errors.push({ phase: "planning", message: String(err) });
      return {
        ...fallback,
        summary: "(planning call failed — see logs)",
        reasoning: String(err),
        errors,
      };
    }

    // Parse with one repair retry on malformed JSON (Change 4). Hermes uses
    // _has_content_after_think_block / _repair_tool_call_arguments to recover
    // from the same class of failure; we send a single corrective prompt
    // before falling through to the structured-error path.
    let parsed = tryParsePlanResponse(planText);
    if (parsed === null) {
      log.warn("orchestrator turn: plan JSON malformed, attempting repair retry", {
        goalId: input.goalId,
      });
      try {
        const repaired = await retryWithBackoff(
          () =>
            callOrchestratorLLM(
              PLANNING_SYSTEM_PROMPT,
              buildRepairPrompt(planText),
              resolvedAuth,
              1024,
            ),
          { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 5_000 },
        );
        parsed = tryParsePlanResponse(repaired);
        if (parsed === null) {
          errors.push({
            phase: "planning",
            message: "Planner JSON unparseable after one repair retry.",
            detail: { planPreview: planText.slice(0, 400) },
          });
        }
      } catch (err) {
        log.warn("orchestrator planning repair call failed", { error: String(err) });
        errors.push({
          phase: "planning",
          message: `repair retry failed: ${String(err)}`,
          detail: { planPreview: planText.slice(0, 400) },
        });
      }
    }
    const reasoning = parsed?.reasoning ?? planText.slice(0, 200);
    const toolCalls = parsed?.toolCalls ?? [];
    if (parsed && toolCalls.length === 0 && !reasoning.trim()) {
      errors.push({
        phase: "planning",
        message: "Planner returned no tool calls and no reasoning — JSON likely malformed.",
        detail: { planPreview: planText.slice(0, 400) },
      });
    }
    log.info("orchestrator turn: plan parsed", {
      goalId: input.goalId,
      toolCallCount: toolCalls.length,
      reasoning: reasoning.slice(0, 120),
    });

    // ── Step 2: Execute tool calls ────────────────────────────────────────
    const spawnedRunIds: string[] = [];
    const completedRunIds: string[] = [];
    const toolResults: ToolCallResult[] = [];

    const execContext = {
      goalId: input.goalId,
      goalText: input.goalText,
      iterationIndex: input.iterationIndex,
      spawnedRunIds,
      completedRunIds,
      resolved,
    };

    for (const call of toolCalls) {
      const result = await executeToolCall(call, execContext);
      toolResults.push(result);
      if (!result.ok && result.error) {
        errors.push({ phase: "tool", message: `${result.tool}: ${result.error}` });
      }
      log.info("orchestrator tool call", {
        tool: result.tool,
        ok: result.ok,
        goalId: input.goalId,
        error: result.error,
      });
    }

    // ── Step 3: Synthesis call ────────────────────────────────────────────
    // Sanitize every tool result fragment before embedding it back into the
    // synthesis prompt — strips XML/markdown framing tokens and caps length,
    // so a tool that returned attacker-shaped output can't smuggle protocol
    // markers into the next model turn (Change 6, Hermes H0.7).
    const toolResultsText =
      toolResults.length > 0
        ? `\nTool call results:\n${toolResults
            .map(
              (r) =>
                `- ${r.tool}: ${r.ok ? "OK" : "FAILED"} ${
                  r.ok
                    ? sanitizeToolResult(JSON.stringify(r.data ?? {}))
                    : sanitizeToolResult(r.error ?? "unknown error")
                }`,
            )
            .join("\n")}`
        : "\nNo tool calls were made this turn.";

    const synthesisMessage = `GOAL: ${input.goalText}

Turn ${input.iterationIndex} execution summary:
- Reasoning: ${reasoning || "(none provided)"}
${toolResultsText}

Prior turns:
${priorSummary}

Write a synthesis summary for this turn. Be specific: what was accomplished, what sub-agents were spawned and why, what their results showed, and what remains to be done. If the goal appears complete, say so explicitly.`;

    let summary: string;
    try {
      // Same retry shape as the planning call — synthesis failures on a
      // transient blip should not lose the work the tool calls just did.
      summary = await retryWithBackoff(
        () => callOrchestratorLLM(SYNTHESIS_SYSTEM_PROMPT, synthesisMessage, resolvedAuth, 2048),
        LLM_RETRY_OPTS,
      );
    } catch (err) {
      log.warn("orchestrator synthesis call failed", { error: String(err) });
      errors.push({ phase: "synthesis", message: String(err) });
      summary = `(synthesis call failed) Reasoning: ${reasoning}. Tool calls made: ${toolResults.length}.${toolResultsText}`;
    }

    return {
      summary: summary || "(no synthesis produced)",
      spawnedRunIds,
      completedRunIds,
      reasoning: reasoning || "(no reasoning provided)",
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (err) {
    log.warn("runOrchestratorTurn threw", { error: String(err) });
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ phase: "other", message: msg });
    return {
      ...fallback,
      summary: `(orchestrator error: ${msg})`,
      errors,
    };
  }
}
