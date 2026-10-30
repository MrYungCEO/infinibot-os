// Generic tool-result size cap.
//
// A single oversized tool result can poison an agent session permanently: it
// gets written into the transcript and re-sent on every subsequent turn. When
// that one message is larger than the model's context window (e.g. the kanban
// `list_projects` action dumping ~250k tokens of 966 full project objects into
// a voice model with a 128k window) the API rejects EVERY following request
// with "prompt too long", and compaction can't rescue it because a single
// message larger than ~50% of the window is "oversized for summary" and is
// kept, not summarized.
//
// This wrapper caps the text content of any tool result before it enters the
// transcript. It truncates the text and appends a clear note telling the model
// the output was cut and to narrow its query (filter / limit / search) instead
// of asking for everything. Non-text blocks (images) are left untouched.

import type { AnyAgentTool } from "./pi-tools.types.js";

// ~15k tokens at ~4 chars/token. Generous for a single legitimate tool result
// while staying far below the smallest context window we run (128k for the
// local/cloud voice models), so one result can never blow the window on its own.
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 60_000;

// Share of the model's context window one tool result may use (~4 chars per
// token). The 60k default assumes a 128k window; a local Ollama model served
// at 32k would be pushed past its window by one such result plus a ~22k
// system prompt, and Ollama then silently front-truncates the prompt (the
// system prompt and tool schemas go first).
const RESULT_SHARE_OF_CONTEXT = 0.2;
const MIN_TOOL_RESULT_CHARS = 8_000;

/** Result cap for a model with `contextWindowTokens` (default when unknown). */
export function resolveToolResultMaxChars(contextWindowTokens?: number): number {
  if (!contextWindowTokens || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return DEFAULT_MAX_TOOL_RESULT_CHARS;
  }
  const scaled = Math.floor(contextWindowTokens * 4 * RESULT_SHARE_OF_CONTEXT);
  return Math.max(MIN_TOOL_RESULT_CHARS, Math.min(DEFAULT_MAX_TOOL_RESULT_CHARS, scaled));
}

// Head/tail slices kept when truncating so the model still sees the shape of
// the payload (the opening + the tail, where a JSON envelope's status lives).
const HEAD_SHARE = 0.75;

function truncateText(text: string, maxChars: number, toolName: string): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * HEAD_SHARE);
  const tailChars = Math.max(0, maxChars - headChars);
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  const droppedChars = text.length - headChars - tailChars;
  const note =
    `\n\n[... ${toolName} output truncated: ${droppedChars.toLocaleString()} of ` +
    `${text.length.toLocaleString()} characters omitted to protect the context window. ` +
    `Re-run with a narrower request (a filter, a search query, or a smaller limit) ` +
    `instead of fetching everything. ...]\n\n`;
  return `${head}${note}${tail}`;
}

/**
 * Cap the text blocks of a tool result at `maxChars`. Returns the result
 * unchanged when it is already within budget or has no text content.
 */
export function capToolResultText(result: unknown, maxChars: number, toolName: string): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;

  let mutated = false;
  const cappedContent = content.map((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = (block as { text: string }).text;
      if (text.length > maxChars) {
        mutated = true;
        return { ...block, text: truncateText(text, maxChars, toolName) };
      }
    }
    return block;
  });

  if (!mutated) return result;
  // Drop `details` when we truncated: it holds the same oversized raw payload
  // (kanban stores the full 966-project array there too) and gets persisted to
  // the session file, bloating it even though it isn't sent to the model as text.
  const { details: _details, ...rest } = result as Record<string, unknown>;
  return { ...rest, content: cappedContent };
}

/**
 * Wrap a tool so its result text is capped at `maxChars`. Preserves the tool's
 * identity (name, label, parameters) and just intercepts `execute`.
 */
export function wrapToolWithResultCap(
  tool: AnyAgentTool,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): AnyAgentTool {
  const orig = (tool as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
  if (typeof orig !== "function") return tool;
  const toolName = (tool as { name?: string }).name ?? "tool";
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      const result = await orig.apply(tool, args);
      return capToolResultText(result, maxChars, toolName);
    },
  } as AnyAgentTool;
}
