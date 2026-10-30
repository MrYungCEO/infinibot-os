/**
 * Streaming credit hook for CLI coder backends (opencode / codex / claude).
 *
 * Each backend pipes JSONL events on stdout. This module lets each backend's
 * stdout `data` handler forward incoming bytes to a per-spawn hook that
 * incrementally parses lines and records usage events as they arrive — so
 * long-running CLI sessions don't have to hold the entire transcript in
 * memory before we get accounting numbers.
 *
 * Best-effort: malformed JSON, missing usage, and ledger failures are all
 * silently swallowed. CLI spawns must never fail because of accounting.
 */

import {
  recordFromCodexJSON,
  recordFromOpencodeJSON,
  recordFromClaudeCodeTranscript,
  recordCredit,
} from "../../credits/recorder.js";
import type { AgentBackend, CreditContext } from "../../credits/types.js";

export type CliBackendId = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

export interface CliCreditHookOptions extends CreditContext {
  backend: CliBackendId;
  /** Provided to provider-specific defaults when the JSON doesn't carry one. */
  defaultModel?: string;
  defaultProvider?: string;
}

export interface CliCreditHook {
  /** Feed a raw stdout chunk; the hook keeps a tiny line buffer. */
  feed: (chunk: string) => void;
  /** Flush the last partial line and stop accepting input. */
  end: () => void;
  /** Total usage entries recorded so far. */
  count: () => number;
}

const BACKEND_TO_AGENT_BACKEND: Record<CliBackendId, AgentBackend> = {
  "claude-code": "claude-code",
  opencode: "opencode",
  codex: "codex",
  gemini: "gemini",
  grok: "grok",
};

export function createCliCreditHook(opts: CliCreditHookOptions): CliCreditHook {
  let buffer = "";
  let count = 0;
  const ctx: CreditContext = {
    agentBackend: opts.agentBackend ?? BACKEND_TO_AGENT_BACKEND[opts.backend] ?? "unknown",
    // Fallback model/provider used by the adapters only when the streamed event
    // doesn't carry its own (e.g. codex turn.completed events omit the model).
    model: opts.defaultModel,
    provider: opts.defaultProvider,
    sessionKey: opts.sessionKey,
    taskId: opts.taskId,
    projectId: opts.projectId,
    workflowId: opts.workflowId,
    cronId: opts.cronId,
    agentId: opts.agentId,
    autonomous: opts.autonomous ?? false,
  };

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line || (line[0] !== "{" && line[0] !== "[")) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    if (!json || typeof json !== "object") return;
    try {
      let entry = null;
      switch (opts.backend) {
        case "opencode":
          entry = recordFromOpencodeJSON(json as Parameters<typeof recordFromOpencodeJSON>[0], ctx);
          break;
        case "codex":
          entry = recordFromCodexJSON(json as Parameters<typeof recordFromCodexJSON>[0], ctx);
          break;
        case "claude-code":
          entry = recordFromClaudeCodeTranscript(
            json as Parameters<typeof recordFromClaudeCodeTranscript>[0],
            ctx,
          );
          break;
        case "gemini":
          entry = tryRecordGeminiCli(json, ctx, opts);
          break;
        case "grok":
          entry = tryRecordGrokCli(json, ctx, opts);
          break;
      }
      if (entry) count += 1;
    } catch {
      /* swallow */
    }
  };

  return {
    feed(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
        nl = buffer.indexOf("\n");
      }
      // Guard against pathological no-newline output: cap buffer at 1 MB.
      if (buffer.length > 1_000_000) {
        handleLine(buffer);
        buffer = "";
      }
    },
    end() {
      if (buffer.trim()) handleLine(buffer);
      buffer = "";
    },
    count() {
      return count;
    },
  };
}

/**
 * Gemini CLI emits `{ "usage_metadata": { "prompt_token_count": ..., "candidates_token_count": ... } }`
 * along with `{ "model": "...", ... }` lines. We accept either shape.
 */
function tryRecordGeminiCli(json: unknown, ctx: CreditContext, opts: CliCreditHookOptions) {
  const obj = json as Record<string, unknown>;
  const usage = (obj.usage_metadata ?? obj.usageMetadata) as
    | {
        prompt_token_count?: number;
        candidates_token_count?: number;
        cached_content_token_count?: number;
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      }
    | undefined;
  if (!usage) return null;
  return recordCredit({
    ...ctx,
    provider: "google",
    model: String(obj.model ?? opts.defaultModel ?? "gemini-unknown"),
    usage: {
      tokensIn: Number(usage.prompt_token_count ?? usage.promptTokenCount ?? 0),
      tokensOut: Number(usage.candidates_token_count ?? usage.candidatesTokenCount ?? 0),
      cacheReadTokens: Number(usage.cached_content_token_count ?? 0),
    },
    agentBackend: "gemini",
    source: "ledger.cli.transcript",
  });
}

/**
 * Grok Build streaming-json: the final `{type:"end", usage:{input_tokens,
 * output_tokens, cache_read_input_tokens}}` line carries the run's spend
 * (per-response `usage` lines would double-count it).
 */
function tryRecordGrokCli(json: unknown, ctx: CreditContext, opts: CliCreditHookOptions) {
  const obj = json as Record<string, unknown>;
  if (obj.type !== "end") return null;
  const usage = obj.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
    | undefined;
  if (!usage || typeof usage !== "object") return null;
  return recordCredit({
    ...ctx,
    provider: "xai",
    model: String(obj.model ?? opts.defaultModel ?? "grok-build"),
    usage: {
      tokensIn: Number(usage.input_tokens ?? 0),
      tokensOut: Number(usage.output_tokens ?? 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
    },
    agentBackend: "grok",
    source: "ledger.cli.transcript",
  });
}
