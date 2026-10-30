/**
 * Orchestrator backend resolution.
 *
 * The goal-mode autonomy orchestrator has two things that must be wired
 * to the user-selected backend:
 *
 *   1. The planner LLM — the model that emits JSON tool-call plans.
 *   2. The worker CLI  — which coder backend each spawned sub-agent runs.
 *
 * This module picks both from a single `AutonomyBackend` value (a per-goal
 * override, falling back to `config.autonomy.defaultBackend`, falling back
 * to `{ kind: "claude" }`).
 *
 * One knob → both decisions. Picking OpenCode means OpenCode-hosted Claude
 * plans AND sub-agents run under the OpenCode CLI. Picking Codex means
 * OpenAI's Codex model plans AND the Codex CLI handles workers.
 */

import { loadConfig } from "../config/config.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AutonomyBackend } from "./types.js";
import type { AutonomyBackendConfig } from "../config/types.infinibot.js";
import { checkCliAvailable, type CliPlannerBackend } from "./cli-planner.js";

const log = createSubsystemLogger("autonomy");

export type CoderBackendId = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

/**
 * What the orchestrator needs to know once a backend is resolved:
 * - which provider+model to use for planning calls (`complete()` is
 *   provider-agnostic so this is purely a routing decision),
 * - which CLI backend each spawned sub-agent should run under,
 * - which agent registry id to spawn (useful for `gateway-agent`).
 */
export interface ResolvedBackend {
  backend: AutonomyBackend;
  /** Provider id passed to `resolveModel(provider, modelId)`. */
  plannerProvider: string;
  /** Model id passed to `resolveModel(provider, modelId)`. */
  plannerModelId: string;
  /** CoderBackend id for spawned sub-agents (`sessions.spawn { coderBackend }`). */
  workerCoderBackend: CoderBackendId;
  /** Agent registry id for spawned sub-agents (`sessions.spawn { agentId }`). */
  workerAgentId: string;
  /** Human label for logs/UI. */
  displayName: string;
}

/**
 * Resolve a `ResolvedBackend` from a per-goal override, falling back through
 * config and then to the Claude default. Never throws — an invalid value is
 * coerced to the default and logged.
 */
export function resolveOrchestratorBackend(perGoal: AutonomyBackend | undefined): ResolvedBackend {
  const cfg = loadConfig() as { autonomy?: { defaultBackend?: AutonomyBackendConfig } };
  const chosen: AutonomyBackend = perGoal ??
    (cfg.autonomy?.defaultBackend as AutonomyBackend | undefined) ?? { kind: "claude" };

  switch (chosen.kind) {
    case "claude": {
      const modelId = process.env.ANTHROPIC_GOAL_ORCHESTRATOR_MODEL?.trim() || "claude-sonnet-4-6";
      return {
        backend: chosen,
        plannerProvider: "anthropic",
        plannerModelId: modelId,
        workerCoderBackend: "claude-code",
        workerAgentId: "coder",
        displayName: "Claude Coder",
      };
    }
    case "opencode": {
      // OpenCode hosts Anthropic models under its own provider id; the
      // planner stays a Claude-class model so JSON tool-call fidelity is
      // preserved, but credentials route through the user's OpenCode auth.
      const modelId = process.env.OPENCODE_GOAL_ORCHESTRATOR_MODEL?.trim() || "claude-sonnet-4-6";
      return {
        backend: chosen,
        plannerProvider: "opencode",
        plannerModelId: modelId,
        workerCoderBackend: "opencode",
        workerAgentId: "coder",
        displayName: "OpenCode",
      };
    }
    case "codex": {
      // Codex is OpenAI's coding model; route the planner through OpenAI.
      const modelId = process.env.CODEX_GOAL_ORCHESTRATOR_MODEL?.trim() || "gpt-5-codex";
      return {
        backend: chosen,
        plannerProvider: "openai",
        plannerModelId: modelId,
        workerCoderBackend: "codex",
        workerAgentId: "coder",
        displayName: "Codex",
      };
    }
    case "grok": {
      // xAI Grok Build: the planner runs through the user's Grok sign-in via
      // the CLI planner (an xAI API key, when configured, resolves first).
      const modelId = process.env.GROK_GOAL_ORCHESTRATOR_MODEL?.trim() || "grok-4.6";
      return {
        backend: chosen,
        plannerProvider: "xai",
        plannerModelId: modelId,
        workerCoderBackend: "grok",
        workerAgentId: "coder",
        displayName: "Grok Build",
      };
    }
    case "gateway-agent": {
      // The agent registry owns model selection for this id; the planner
      // still uses a Claude-class model for plan fidelity (the chosen
      // agent only runs as the worker). If you want the agent to plan
      // too, configure its provider via env override below.
      const modelId =
        process.env.GATEWAY_AGENT_GOAL_ORCHESTRATOR_MODEL?.trim() || "claude-sonnet-4-6";
      const provider = process.env.GATEWAY_AGENT_GOAL_ORCHESTRATOR_PROVIDER?.trim() || "anthropic";
      return {
        backend: chosen,
        plannerProvider: provider,
        plannerModelId: modelId,
        workerCoderBackend: "claude-code",
        workerAgentId: chosen.agentId || "coder",
        displayName: `Agent: ${chosen.agentId}`,
      };
    }
    default: {
      log.warn("orchestrator-backends: unknown backend kind, falling back to claude", {
        chosen,
      });
      return resolveOrchestratorBackend({ kind: "claude" });
    }
  }
}

/**
 * Probe whether a resolved backend can actually run right now. Used by the
 * orchestrator to fail fast on missing credentials *before* burning a turn
 * (cf. the auth-credential infinite-retry bug that exhausted budgets in
 * ~280ms).
 *
 * For CLI-based backends (claude, opencode, codex) this checks whether the
 * CLI binary is installed even when no direct API key is configured — the
 * CLI's own auth (OAuth) is used at planner time.
 */
export function probeBackendModel(resolved: ResolvedBackend): { ok: boolean; error?: string } {
  const { model, error } = resolveModel(resolved.plannerProvider, resolved.plannerModelId);
  if (!model) {
    // Unknown model — if this is a CLI backend, fall through to CLI check
    const cliBackend = backendKindToCliPlanner(resolved.backend.kind);
    if (cliBackend) {
      const available = checkCliAvailable(cliBackend);
      if (available) return { ok: true };
      return {
        ok: false,
        error: `Backend ${resolved.displayName}: model ${resolved.plannerProvider}/${resolved.plannerModelId} unresolvable and CLI binary "${cliBackend}" not found: ${error ?? "unknown"}`,
      };
    }
    return {
      ok: false,
      error: `Backend ${resolved.displayName}: model ${resolved.plannerProvider}/${resolved.plannerModelId} unresolvable: ${error ?? "unknown"}`,
    };
  }
  return { ok: true };
}

function backendKindToCliPlanner(kind: AutonomyBackend["kind"]): CliPlannerBackend | null {
  if (kind === "claude") return "claude-code";
  if (kind === "opencode") return "opencode";
  if (kind === "codex") return "codex";
  if (kind === "grok") return "grok";
  return null;
}
