/**
 * The voice tool agent's tools: a SMALL, sharp allowlist of the agent's own
 * InfiniBot tools, run in-process with a per-tool timeout and in parallel.
 *
 * Why not the full agent: a full agent run spends 2.5–35 s before its model is
 * even asked (session store, skills, ~80 tool schemas, a 30k-token prompt) —
 * measured on the live gateway 2026-10-07. The voice tool agent is one fast
 * model with a few hundred tokens of prompt and ~15 tool schemas: the common
 * "what's on my board / did the agents finish / search X / remind me" turn is
 * one tool round trip; everything heavier is delegated to the main agent.
 *
 * Trust: tools are built for the call's session key, so the gateway's normal
 * policy applies (sender-trust.ts) — an unverified caller gets no tools at all
 * from the caller of this module. Heavy work is never awaited here: coder /
 * spawn tools return as soon as the sub-agent is started, and anything still
 * running at the timeout keeps running in the background (voice-pending.ts).
 */

import type { Tool, ToolCall } from "@mariozechner/pi-ai";

import type { AnyAgentTool } from "../../agents/tools/common.js";
import {
  DEFAULT_VOICE_TIMING,
  voiceToolTimeoutMs,
  type VoiceTimingConfig,
} from "./voice-timing.js";

/**
 * Default allowlist, intersected with what the agent is actually allowed.
 * Quick reads and simple actions only: anything heavier (spawning sub-agents
 * or coders, plugins, multi-step work) goes to the main agent through the fast
 * step's `delegate_to_main`, which never blocks the turn. An owner who lists
 * spawn tools in `voiceTools` can still call them directly (their runs are
 * followed the same way).
 */
export const DEFAULT_VOICE_TOOLS = [
  "web_search",
  "web_read",
  "kanban",
  "notes",
  "memory_search",
  "calendar",
  "scheduled_task",
  "sessions_list",
  "agents_list",
  "subagents_list",
  "subagents_events",
  "session_status",
  "workload",
  "daily_review",
  "sessions_send",
  "subagent_message",
  "telegram_send",
  "gmail",
] as const;

/** Tools that START background work: never worth waiting on. */
export const DELEGATE_TOOLS = new Set([
  "sessions_spawn",
  "claude_coder",
  "codex_coder",
  "grok_coder",
  "opencode_coder",
]);

/** Fast-tool budget (voice-timing.ts holds the configurable tiers). */
export const VOICE_TOOL_TIMEOUT_MS = DEFAULT_VOICE_TIMING.fastToolTimeoutMs;
const MAX_RESULT_CHARS = 1_800;
const TOOLSET_TTL_MS = 5 * 60_000;

export type VoiceToolResult = {
  call: ToolCall;
  text: string;
  isError: boolean;
  ms: number;
  /** Set when the tool outlived the timeout: resolves with its real result. */
  late?: Promise<string>;
};

function resultText(res: unknown): string {
  const content = (res as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  const text = Array.isArray(content)
    ? content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
    : typeof res === "string"
      ? res
      : JSON.stringify(res ?? "");
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (truncated)` : text;
}

/** pi-ai tool schemas for the model. */
export function toolDefs(tools: AnyAgentTool[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description ?? "").slice(0, 600),
    parameters: t.parameters as Tool["parameters"],
  }));
}

/**
 * Small/fast models fill every optional parameter with an empty value
 * ("", [], {}, null) — e.g. `sessions_spawn {cleanup: "", thinking: "",
 * node: ""}` fails validation and the model then tells the caller it "can't
 * spawn". Optional empties are dropped; voice turns never block on waits.
 */
export function sanitizeVoiceToolArgs(tool: AnyAgentTool, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const required = new Set(
    ((tool.parameters as { required?: unknown } | undefined)?.required as string[] | undefined) ??
      [],
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const empty =
      v === null ||
      v === undefined ||
      (typeof v === "string" && !v.trim()) ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
    if (empty && !required.has(k)) continue;
    out[k] = v;
  }
  // A live call never waits on background work: status only.
  if (tool.name === "subagents_events") delete out.waitSec;
  if (tool.name === "subagents_wait") out.timeoutSec = 0;
  return out;
}

/** Appended to a failed tool result so the model routes instead of refusing. */
export const DELEGATE_HINT =
  "Do not tell the caller you can't do this. Call delegate_to_main with their request: the main agent has every tool and will handle it.";

function looksFailed(text: string): boolean {
  return (
    /^\s*\{?\s*"status"\s*:\s*"(?:error|forbidden|denied)"/.test(text) ||
    /^\s*(?:error|validation failed)\b/i.test(text)
  );
}

/**
 * Run one round of tool calls in parallel. Each call gets `timeoutMs`; a call
 * that is still running is reported to the model as "continuing in the
 * background" and its eventual result is handed back via `late`.
 */
export async function executeVoiceToolCalls(
  calls: ToolCall[],
  tools: AnyAgentTool[],
  opts: {
    /** Overrides the fast budget (tests / callers without timing settings). */
    timeoutMs?: number;
    timing?: VoiceTimingConfig;
    /** Failed results tell the model to delegate instead of refusing. */
    delegateHint?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<VoiceToolResult[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const timing = opts.timing ?? DEFAULT_VOICE_TIMING;
  const budget = (name: string) => {
    const tiered = voiceToolTimeoutMs(name, timing);
    if (opts.timeoutMs == null) return tiered;
    return timing.slowTools.includes(name) ? Math.max(opts.timeoutMs, tiered) : opts.timeoutMs;
  };
  const hint = (text: string) => (opts.delegateHint ? `${text}\n${DELEGATE_HINT}` : text);
  return Promise.all(
    calls.map(async (call): Promise<VoiceToolResult> => {
      const started = Date.now();
      const tool = byName.get(call.name);
      if (!tool) {
        return {
          call,
          text: hint(`Tool "${call.name}" is not available on this call.`),
          isError: true,
          ms: 0,
        };
      }
      const timeoutMs = budget(call.name);
      const args = sanitizeVoiceToolArgs(tool, call.arguments);
      const work = Promise.resolve()
        .then(() => tool.execute(call.id, args, opts.signal))
        .then(resultText);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      try {
        const first = await Promise.race([work, timeout]);
        if (first === "timeout") {
          work.catch(() => undefined);
          return {
            call,
            text: `Still running after ${Math.round(timeoutMs / 1000)} seconds. It continues in the background and the caller gets an update automatically when it is done: say in a few words that it is underway.`,
            isError: false,
            ms: Date.now() - started,
            late: work,
          };
        }
        const text = first || "(no output)";
        const failed = looksFailed(text);
        return {
          call,
          text: failed ? hint(text) : text,
          isError: failed,
          ms: Date.now() - started,
        };
      } catch (err) {
        return {
          call,
          text: hint(`Error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400)),
          isError: true,
          ms: Date.now() - started,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}

// ── toolset per call ───────────────────────────────────────────────────────────

const toolsetCache = new Map<string, { at: number; tools: AnyAgentTool[] }>();

export function clearVoiceToolsetsForTests(): void {
  toolsetCache.clear();
}

/**
 * The call's voice tools: the agent's own tools for this session key (normal
 * gateway policy), filtered to the voice allowlist. Cached per session.
 */
export async function resolveVoiceToolset(p: {
  agentId: string;
  sessionKey: string;
  allow?: readonly string[];
  modelProvider?: string;
  modelId?: string;
}): Promise<AnyAgentTool[]> {
  const allow = new Set(p.allow?.length ? p.allow : DEFAULT_VOICE_TOOLS);
  const key = `${p.sessionKey}|${[...allow].sort().join(",")}`;
  const hit = toolsetCache.get(key);
  if (hit && Date.now() - hit.at < TOOLSET_TTL_MS) return hit.tools;
  const [
    { loadConfig },
    { resolveAgentDir, resolveAgentWorkspaceDir },
    { createInfiniBotCodingTools },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../agents/agent-scope.js"),
    import("../../agents/pi-tools.js"),
  ]);
  const cfg = loadConfig();
  const all = createInfiniBotCodingTools({
    config: cfg,
    sessionKey: p.sessionKey,
    agentDir: resolveAgentDir(cfg, p.agentId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, p.agentId),
    messageProvider: "voice",
    modelProvider: p.modelProvider,
    modelId: p.modelId,
  });
  const tools = all.filter((t) => allow.has(t.name));
  toolsetCache.set(key, { at: Date.now(), tools });
  if (toolsetCache.size > 200) toolsetCache.delete(toolsetCache.keys().next().value!);
  return tools;
}
