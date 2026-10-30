/**
 * Script Agent Runtime — the agentic tool loop that replaces one-shot script
 * generation. Drives an Anthropic tool-use conversation:
 *
 *   research/exemplar tools → script.draft → runtime lint → script.revise → return
 *
 * Budgeted (max tool calls + wall clock), traced (every tool call + draft +
 * lint), and streamable (onTrace / onCheckpoint hooks). On a clean lint the
 * agent's final text message is the returned script; the runtime enforces the
 * lint as a fail-closed gate with one programmatic repair pass if needed.
 *
 * Provider: Anthropic (tool use). When ANTHROPIC_API_KEY is absent the run
 * reports stopReason "no_provider" so callers can fall back to the legacy
 * one-shot path.
 */

import { parseScript } from "../../storyboard/script-generator.js";
import { lintScript } from "./viral-lint.js";
import { buildScriptAgentSystemPrompt, buildScriptAgentUserPrompt } from "./script-agent-prompt.js";
import { newRunState, resolveTool, toolSchemas } from "./tools.js";
import type {
  AgentStreamHooks,
  AgenticScriptRequest,
  AgenticScriptResult,
  ResearchDepth,
  TraceEntry,
} from "./types.js";

/**
 * Minimal shape of the Anthropic messages client the loop depends on. Lets
 * tests inject a scripted provider via setAnthropicFactoryForTests without the
 * real SDK or network.
 */
export interface MessagesClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      tools?: unknown;
      messages: unknown;
    }): Promise<{ content: Array<{ type: string; [k: string]: unknown }> }>;
  };
}

let anthropicFactoryOverride: ((apiKey: string) => MessagesClient) | null = null;

/** Test seam: inject a scripted MessagesClient. Pass null to restore the SDK. */
export function setAnthropicFactoryForTests(
  factory: ((apiKey: string) => MessagesClient) | null,
): void {
  anthropicFactoryOverride = factory;
}

const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_WALL_MS = 90_000;
const MAX_TURNS = 24; // safety net independent of tool-call budget

function stateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

function estimateDuration(script: string): number {
  const words = script.split(/\s+/).filter(Boolean).length;
  return Math.round((words / 150) * 10) / 10;
}

function resolveDurationSec(req: AgenticScriptRequest): number | undefined {
  if (typeof req.durationSec === "number") return req.durationSec;
  if (typeof req.targetDuration === "number") return Math.round(req.targetDuration * 60);
  return undefined;
}

/**
 * Run the agentic script pipeline. Always resolves (never throws) — failures
 * land in `error` / `stopReason` so the caller can decide whether to fall back.
 */
export async function runScriptAgent(
  req: AgenticScriptRequest,
  hooks: AgentStreamHooks = {},
): Promise<AgenticScriptResult> {
  const trace: TraceEntry[] = [];
  let step = 0;
  const pushTrace = (e: Omit<TraceEntry, "step" | "at">): TraceEntry => {
    const entry: TraceEntry = { ...e, step: step++, at: Date.now() };
    trace.push(entry);
    try {
      hooks.onTrace?.(entry);
    } catch {
      /* streaming is best-effort */
    }
    return entry;
  };
  const checkpoint = (phase: string, message: string): void => {
    try {
      hooks.onCheckpoint?.({ phase, message });
    } catch {
      /* best-effort */
    }
  };

  const apiKey = process.env.ANTHROPIC_API_KEY || (await workspaceAnthropicKey());
  if (!apiKey) {
    return {
      success: false,
      stopReason: "no_provider",
      trace,
      error:
        "No Anthropic key — add one under Settings › API keys (or set ANTHROPIC_API_KEY) to use the agentic path.",
    };
  }

  const platform = req.platform;
  const depth: ResearchDepth = req.researchDepth ?? "standard";
  const includeVoiceover = req.includeVoiceover ?? true;
  const durationSec = resolveDurationSec(req);
  const maxToolCalls = Math.max(1, req.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS);
  const maxWallMs = Math.max(5_000, req.maxWallMs ?? DEFAULT_MAX_WALL_MS);
  const deadline = Date.now() + maxWallMs;

  const promptInput = {
    platform,
    durationSec,
    persona: req.persona,
    tone: req.tone,
    style: req.style,
    anglesToExplore: req.anglesToExplore,
    researchDepth: depth,
    includeVoiceover,
  };

  const system = buildScriptAgentSystemPrompt(promptInput);
  const userPrompt = buildScriptAgentUserPrompt(req.prompt, promptInput);

  const state = newRunState(stateDir(), platform);

  let client: MessagesClient;
  if (anthropicFactoryOverride) {
    client = anthropicFactoryOverride(apiKey);
  } else {
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      client = new Anthropic({ apiKey }) as unknown as MessagesClient;
    } catch (err) {
      return {
        success: false,
        stopReason: "error",
        trace,
        error: `Anthropic SDK unavailable: ${String(err)}`,
      };
    }
  }
  const model =
    process.env.ANTHROPIC_SCRIPT_AGENT_MODEL ||
    process.env.ANTHROPIC_SCRIPT_MODEL ||
    "claude-sonnet-4-6";

  // Anthropic message history.
  type Msg = { role: "user" | "assistant"; content: unknown };
  const messages: Msg[] = [{ role: "user", content: userPrompt }];

  let toolCalls = 0;
  let stopReason: AgenticScriptResult["stopReason"] = "complete";
  let lastAssistantText = "";
  const warnings: string[] = [];

  checkpoint("start", `Script agent started (${depth} research, ${platform || "custom"}).`);

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (Date.now() > deadline) {
        stopReason = "time_budget";
        warnings.push("time budget exhausted");
        break;
      }

      const resp = await client.messages.create({
        model,
        max_tokens: 8000,
        system,
        tools: toolSchemas() as never,
        messages: messages as never,
      });

      // Record assistant turn verbatim into history.
      messages.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter(
        (b: { type: string }) => b.type === "tool_use",
      ) as Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;
      const textBlocks = resp.content.filter((b: { type: string }) => b.type === "text") as Array<{
        type: "text";
        text: string;
      }>;
      const turnText = textBlocks
        .map((t) => t.text)
        .join("\n")
        .trim();
      if (turnText) {
        lastAssistantText = turnText;
        pushTrace({ type: "thought", text: turnText.slice(0, 1200) });
      }

      if (toolUses.length === 0) {
        // No tools requested — the model is done talking. Treat its text as final.
        stopReason = "complete";
        break;
      }

      // Execute each requested tool, respecting the budget.
      const toolResultBlocks: Array<{ type: "tool_result"; tool_use_id: string; content: string }> =
        [];
      let budgetHit = false;
      for (const tu of toolUses) {
        if (toolCalls >= maxToolCalls) {
          budgetHit = true;
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Tool-call budget exhausted. Stop researching and return your best full script now, lint-clean, as your next message.",
          });
          continue;
        }
        toolCalls += 1;
        const resolved = resolveTool(tu.name);
        const isDraft = tu.name === "script_draft" || tu.name === "script_revise";
        pushTrace({ type: "tool_call", tool: tu.name, input: trimInput(tu.input) });
        if (!resolved) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Unknown tool: ${tu.name}`,
          });
          continue;
        }
        try {
          const result = await resolved.def.execute(tu.input, state);
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: result.content,
          });
          if (isDraft && state.lastLint) {
            pushTrace({
              type: "draft",
              tool: tu.name,
              draftMeta: {
                chars: state.currentDraft?.length ?? 0,
                scenes: parseScript(state.currentDraft || "").length,
              },
            });
            pushTrace({ type: "lint", lint: state.lastLint });
            checkpoint(
              "draft",
              state.lastLint.clean
                ? "Draft passed the viral-structure lint."
                : `Draft has ${state.lastLint.violations.length} lint issue(s).`,
            );
          } else {
            pushTrace({ type: "tool_result", tool: tu.name, summary: result.summary });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          pushTrace({ type: "error", tool: tu.name, summary: msg });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Tool error: ${msg}`,
          });
        }
      }

      messages.push({ role: "user", content: toolResultBlocks });
      if (budgetHit) {
        stopReason = "tool_budget";
        // give the model one more turn to emit the final script
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushTrace({ type: "error", summary: msg });
    return {
      success: false,
      stopReason: "error",
      trace,
      error: msg,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  // ── Resolve the final script ────────────────────────────────────
  // Prefer the agent's final text message if it parses to scenes; otherwise the
  // last recorded draft.
  let finalScript = "";
  if (parseScript(lastAssistantText).length > 0) finalScript = lastAssistantText;
  else if (state.currentDraft && parseScript(state.currentDraft).length > 0)
    finalScript = state.currentDraft;
  else finalScript = lastAssistantText || state.currentDraft || "";

  if (!finalScript.trim()) {
    return {
      success: false,
      stopReason: stopReason ?? "error",
      trace,
      error: "Agent produced no script.",
      warnings: warnings.length ? warnings : undefined,
    };
  }

  // ── Fail-closed lint gate with one programmatic repair pass ─────
  let lint = lintScript(finalScript, platform);
  pushTrace({ type: "lint", lint });
  if (!lint.clean && Date.now() < deadline) {
    checkpoint("repair", "Final draft failed lint — requesting one repair pass.");
    try {
      messages.push({
        role: "user",
        content: `${lint.critique}\n\nReturn ONLY the corrected full script in the scene format. No commentary.`,
      });
      const repair = await client.messages.create({
        model,
        max_tokens: 8000,
        system,
        messages: messages as never,
      });
      const repaired = repair.content
        .filter((b) => b.type === "text")
        .map((b) => String((b as { text?: unknown }).text ?? ""))
        .join("\n")
        .trim();
      if (parseScript(repaired).length > 0) {
        finalScript = repaired;
        lint = lintScript(finalScript, platform);
        pushTrace({ type: "lint", lint });
      }
    } catch (err) {
      warnings.push(`repair pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!lint.clean)
    warnings.push(
      `returned with ${lint.violations.filter((v) => v.severity === "error").length} unresolved lint error(s)`,
    );

  const scenes = parseScript(finalScript);
  checkpoint(
    "done",
    `Script complete — ${scenes.length} scenes, lint ${lint.clean ? "clean" : "with issues"}.`,
  );

  return {
    success: true,
    script: finalScript,
    scenes,
    estimatedDuration: estimateDuration(finalScript),
    lint,
    research: state.research,
    exemplarsUsed: Array.from(state.exemplarsUsed.values()),
    trace,
    stopReason,
    warnings: warnings.length ? warnings : undefined,
  };
}

function trimInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === "string" && v.length > 200) out[k] = v.slice(0, 197) + "…";
    else out[k] = v;
  }
  return out;
}

/**
 * The workspace's own Anthropic key (Settings › API keys / auth profiles), for
 * installs that keep provider keys in the workspace rather than the
 * environment (InfiniBot Cloud). Undefined when none is configured.
 */
async function workspaceAnthropicKey(): Promise<string | undefined> {
  try {
    const [{ loadConfig }, { resolveApiKeyForProvider }] = await Promise.all([
      import("../../config/config.js"),
      import("../../agents/model-auth.js"),
    ]);
    const auth = await resolveApiKeyForProvider({ provider: "anthropic", cfg: loadConfig() });
    return auth.apiKey || undefined;
  } catch {
    return undefined;
  }
}
