// Per-tool execution deadline for the embedded runner.
//
// pi-agent-core awaits `tool.execute()` with no deadline and runs a turn's
// tool calls one after another. A tool promise that never settles therefore
// wedges the whole turn: no tool result, no next model call, the session
// lane and transcript lock held until the 20-min turn timeout (seen live
// 2026-10-26: CMO `kanban list_projects` started, never ended, lane released
// only by the turn timeout 20 min later — the parallel web_fetch never ran).
//
// This wrapper races every tool against a deadline. On expiry it aborts the
// signal it handed the tool (cooperative tools stop their I/O) and resolves
// with an error tool result the model can read, so the turn continues and the
// lane is always released. A watchdog logs "tool still running" first, so a
// slow tool is visible in the gateway log before it times out.

import { normalizeToolName } from "./tool-policy.js";
import { combineAbortSignals } from "./pi-tools.abort.js";
import { log } from "./pi-embedded-runner/logger.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { jsonResult } from "./tools/common.js";

/** Default deadline: far above any healthy lookup, well under the turn timeout. */
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;

/**
 * Tools that legitimately block for long stretches (shell, coders, waits,
 * renders). They still get a deadline, just one that stays under the 20-min
 * turn timeout so the turn can still report back.
 */
export const LONG_TOOL_TIMEOUT_MS = 15 * 60_000;
const LONG_RUNNING_TOOLS = new Set([
  "exec",
  "bash",
  "process",
  "apply_patch",
  "claude_coder",
  "codex_coder",
  "opencode_coder",
  "grok_coder",
  "sessions_spawn",
  "sessions_send",
  "subagents_wait",
  "wait_approval",
  "request_approval",
  "goal_run",
  "queue_run",
  "browser",
  "visual_verify",
  "video_analysis",
  "video_editor",
  "report",
  "image",
  "flypic_wait_job",
  "flypic_generate_video",
  "flypic_generate_image",
  "flypic_edit_media",
  "secure_research",
]);

/** Extra room past a tool's own requested timeout before we step in. */
const OWN_TIMEOUT_GRACE_MS = 30_000;
const WATCHDOG_FIRST_MS = 30_000;

/** Seconds/ms timeouts a caller passed in the tool's own args, in ms. */
function requestedTimeoutMs(args: unknown): number {
  if (!args || typeof args !== "object") return 0;
  const a = args as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return Math.max(
    num(a.timeoutMs),
    num(a.waitMs),
    num(a.timeoutSec) * 1000,
    num(a.timeoutSeconds) * 1000,
    num(a.timeout) * 1000,
    num(a.yieldMs),
  );
}

function envTimeoutMs(): number | undefined {
  const raw = Number(process.env.INFINIBOT_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function resolveToolTimeoutMs(toolName: string, args: unknown, baseMs?: number): number {
  const name = normalizeToolName(toolName);
  const base =
    baseMs ??
    envTimeoutMs() ??
    (LONG_RUNNING_TOOLS.has(name) ? LONG_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS);
  const own = requestedTimeoutMs(args);
  return own > 0 ? Math.max(base, own + OWN_TIMEOUT_GRACE_MS) : base;
}

export function toolTimeoutResult(toolName: string, timeoutMs: number) {
  const seconds = Math.round(timeoutMs / 1000);
  return jsonResult({
    status: "error",
    tool: toolName,
    timedOut: true,
    error:
      `tool ${toolName} timed out after ${seconds}s with no result, so the call was abandoned. ` +
      "Don't repeat the same call unchanged: try a narrower request, a different tool, " +
      "or tell the user this source is unavailable right now.",
  });
}

export function wrapToolWithExecutionTimeout(
  tool: AnyAgentTool,
  opts: { timeoutMs?: number; watchdogMs?: number } = {},
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) return tool;
  const toolName = normalizeToolName(tool.name ?? "tool");
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const timeoutMs = resolveToolTimeoutMs(toolName, params, opts.timeoutMs);
      const controller = new AbortController();
      const combined = combineAbortSignals(signal, controller.signal) ?? controller.signal;
      const startedAt = Date.now();
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const watchdogMs = opts.watchdogMs ?? WATCHDOG_FIRST_MS;
      const watch = (delay: number) => {
        if (delay >= timeoutMs) return;
        timers.push(
          setTimeout(
            () => {
              log.warn(
                `[tools] ${toolName} still running after ${Math.round((Date.now() - startedAt) / 1000)}s ` +
                  `(toolCallId=${toolCallId}, times out at ${Math.round(timeoutMs / 1000)}s)`,
              );
              watch(delay * 2);
            },
            delay - (Date.now() - startedAt),
          ),
        );
      };
      watch(watchdogMs);
      try {
        const work = Promise.resolve().then(() => execute(toolCallId, params, combined, onUpdate));
        const timedOut = new Promise<"timeout">((resolve) => {
          timers.push(setTimeout(() => resolve("timeout"), timeoutMs));
        });
        const outcome = await Promise.race([work, timedOut]);
        if (outcome !== "timeout") return outcome;
        void work.catch(() => {});
        controller.abort(new Error(`tool ${toolName} timed out`));
        log.warn(
          `[tools] ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s (toolCallId=${toolCallId}); returning an error result`,
        );
        return toolTimeoutResult(toolName, timeoutMs);
      } finally {
        for (const t of timers) clearTimeout(t);
      }
    },
  };
}
