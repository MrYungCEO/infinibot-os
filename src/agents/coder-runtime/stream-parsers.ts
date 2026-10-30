/**
 * Backend-agnostic coder stream parsers.
 *
 * Every CLI coder backend (Claude Code, OpenCode, Codex) emits a different
 * JSON event stream on stdout. The activity page, however, must show the SAME
 * experience regardless of which backend ran the job: identical tool_use /
 * tool_result events, identical transcript lines, identical status signals.
 *
 * This module is the single place where each backend's native event schema is
 * normalized into one shared {@link StreamEventFormatted} shape. The consumer
 * (src/agents/tools/claude-coder-tool.ts) calls {@link getStreamParser} once
 * per backend and feeds every NDJSON line through it, then drives the SAME
 * broadcast + transcript + activity pipeline for all backends. There is no
 * per-backend broadcast fork — only this per-backend *parser*.
 *
 * Adding a new backend = add one `format<Backend>StreamEvent` function and a
 * case in `getStreamParser`. Everything downstream (broadcasts, transcript,
 * tool list, status pill) is inherited automatically.
 *
 * COORDINATION: opencode-parity — extracted verbatim from claude-coder-tool.ts
 * so all three backends share one tested normalization layer.
 */

import type { CoderBackendId } from "../coder-backend/types.js";

/**
 * The normalized event shape every backend parser produces. Downstream code
 * (claude-coder-tool's stdout loop) consumes ONLY this shape, so it never has
 * to know which backend produced a line.
 */
export interface StreamEventFormatted {
  /** Human-readable line to append to the activity transcript. */
  transcript?: string;
  /** Coarse summary candidate for the next reportProgress heartbeat. */
  summary?: string;
  /** Live activity ping for recordActivity() — shown as "Xs ago". */
  activity?: { kind: string; label: string };
  /** Structured tool_use blocks parsed from the NDJSON line. */
  toolStarts?: Array<{ toolCallId: string; name: string; arguments: unknown }>;
  /**
   * Structured tool_result blocks parsed from the NDJSON line.
   * `durationMs`, when set, is an authoritative wall-clock duration the backend
   * reported directly (e.g. OpenCode's `state.time.{start,end}`). The downstream
   * loop prefers it over the start→end gap it would otherwise compute from its
   * own `Date.now()` timestamps — necessary for backends that emit a tool's
   * whole lifecycle on a single already-completed event (so the computed gap
   * would be ~0). Omit it and the downstream falls back to its own timing.
   */
  toolEnds?: Array<{ toolCallId: string; result?: unknown; error?: string; durationMs?: number }>;
  /**
   * The backend's own session_id, surfaced from its boot/init event.
   * Stored via updateSubagentRunClaudeSessionId so a gateway restart can
   * resume the run (`claude --resume` / `opencode --session` / `codex resume`).
   * Field name kept as `claudeSessionId` for back-compat with the registry
   * accessor; it carries the resume id for ALL backends, not just Claude.
   */
  claudeSessionId?: string;
}

/** A parser maps one raw NDJSON line to a normalized event (or null to skip). */
export type StreamParser = (line: string) => StreamEventFormatted | null;

// ── Shared tool-input/result formatting helpers ─────────────────────────────

export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const file =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : typeof input.notebook_path === "string"
          ? input.notebook_path
          : "";
  if (file) return shortenPath(file);
  if (name === "Bash" && typeof input.command === "string") {
    return input.command.replace(/\s+/g, " ").slice(0, 80);
  }
  if (name === "Grep" || name === "Glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const path = typeof input.path === "string" ? ` in ${shortenPath(input.path)}` : "";
    return pattern ? `${pattern}${path}` : "";
  }
  if (name === "WebFetch" && typeof input.url === "string") {
    return input.url.slice(0, 80);
  }
  if (name === "Task" || name === "Agent") {
    const desc = typeof input.description === "string" ? input.description : "";
    return desc.slice(0, 80);
  }
  return "";
}

export function shortenPath(p: string): string {
  // Keep the last two path segments — full absolute paths are visual noise.
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

export function renderToolResultPreview(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").slice(0, 80);
  }
  if (Array.isArray(content)) {
    const text = content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join(" ");
    return text.replace(/\s+/g, " ").slice(0, 80);
  }
  return "";
}

// ── Claude Code: `--output-format stream-json` NDJSON ───────────────────────

/**
 * Parse one line of Claude Code's `--output-format stream-json` NDJSON and
 * surface what matters for the activity UI. Unknown / malformed events are
 * silently skipped (we'd rather lose one tool call's annotation than crash
 * the subagent runner).
 */
export function formatClaudeStreamEvent(line: string): StreamEventFormatted | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof ev.type === "string" ? ev.type : "";

  if (type === "system") {
    const subtype = typeof ev.subtype === "string" ? ev.subtype : "";
    // FIX A/B: capture Claude Code's own session_id on init so we can
    // call `claude --resume <claudeSessionId>` if the gateway restarts.
    const claudeSessionId = typeof ev.session_id === "string" ? ev.session_id : undefined;
    if (subtype === "init") {
      return { transcript: "⚡ session started", claudeSessionId };
    }
    return null;
  }

  if (type === "result") {
    const subtype = typeof ev.subtype === "string" ? ev.subtype : "";
    const ok = subtype === "success";
    return {
      transcript: ok ? "✅ finished" : `⚠️ finished (${subtype || "unknown"})`,
      summary: ok ? "finished" : `finished: ${subtype || "unknown"}`,
      activity: { kind: ok ? "done" : "error", label: ok ? "finished" : subtype || "unknown" },
    };
  }

  if (type === "assistant" || type === "user") {
    const message = (ev.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    const lines: string[] = [];
    let activity: StreamEventFormatted["activity"];
    let summary: string | undefined;
    const toolStarts: NonNullable<StreamEventFormatted["toolStarts"]> = [];
    const toolEnds: NonNullable<StreamEventFormatted["toolEnds"]> = [];
    for (const blockRaw of content) {
      const block = blockRaw as Record<string, unknown>;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text" && typeof block.text === "string") {
        const preview = block.text.replace(/\s+/g, " ").trim().slice(0, 200);
        if (preview) {
          lines.push(`💬 ${preview}`);
          summary = preview;
          activity = { kind: "assistant", label: preview.slice(0, 80) };
        }
      } else if (blockType === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        const input = (block.input ?? {}) as Record<string, unknown>;
        const short = summarizeToolInput(name, input);
        const label = short ? `${name}: ${short}` : name;
        lines.push(`🔧 ${label}`);
        summary = label;
        activity = { kind: name, label };
        const id = typeof block.id === "string" ? block.id : `coder-tool-${Date.now()}`;
        toolStarts.push({ toolCallId: id, name, arguments: input });
      } else if (blockType === "tool_result") {
        const isError = block.is_error === true;
        const preview = renderToolResultPreview(block.content);
        const label = isError ? `✗ ${preview || "error"}` : `✓ ${preview || "ok"}`;
        lines.push(label);
        if (isError) {
          activity = { kind: "tool_error", label: preview || "error" };
          summary = label;
        }
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        if (id) {
          toolEnds.push({
            toolCallId: id,
            ...(isError ? { error: preview || "error" } : { result: preview || "ok" }),
          });
        }
      }
    }
    if (lines.length === 0 && toolStarts.length === 0 && toolEnds.length === 0) return null;
    return {
      transcript: lines.join("\n") || undefined,
      summary,
      activity,
      toolStarts: toolStarts.length ? toolStarts : undefined,
      toolEnds: toolEnds.length ? toolEnds : undefined,
    };
  }

  return null;
}

// ── OpenCode: `--format json` NDJSON ────────────────────────────────────────
//
// OpenCode's `--format json` emits a completely different schema than Claude's
// stream-json. Captured event kinds (opencode 1.15.11, --format json):
//   • step_start       — phase begin marker. Skipped (too noisy).
//   • step_finish      — phase end. Skipped; carries tokens/cost but no signal.
//   • tool_use         — per-tool event carrying:
//                          part.tool       (lowercase: "read"/"bash"/"write"…)
//                          part.callID
//                          part.state.status   ("pending"|"running"|"completed"|"failed"|"error")
//                          part.state.input    (object — uses filePath, not file_path)
//                          part.state.output   (string)
//                          part.state.time     ({ start, end } epoch-ms — present once completed)
//                          part.title          (human-readable)
//   • text             — assistant text in part.text.
//   • error            — { error: { name, data: { message } } }
//
// tool_use lifecycle matrix (by state.status) — see formatOpenCodeStreamEvent:
//   "pending" | "running"   → toolStarts ONLY (a streaming start; the matching
//                             "completed"/"failed" event arrives later).
//   "completed" | "failed"  → toolEnds (with the REAL duration from state.time)
//                             AND a paired toolStart. Why both here: opencode
//                             ≥1.16 in `run --format json` emits a tool's WHOLE
//                             lifecycle on this single already-completed event —
//                             there is no preceding "running" event to carry the
//                             tool name / file-touch, so we must emit the start
//                             alongside the end. The end's durationMs comes from
//                             state.time so it is NOT the bug-old 0ms (the
//                             downstream start→end gap would be ~0 since both
//                             fire in the same tick). If a version DOES stream a
//                             "running" first, the extra start is a harmless
//                             re-affirmation (broadcaster keys by callID).
//   "" (legacy/unknown)     → BOTH at once, but only when input+output are both
//                             populated (the original pre-status fallback).
// Top-level sessionID is present on every event; we surface it as the resume
// session id (claudeSessionId) so restart-resume works the same as Claude.
//
// Tool-name + arg-key translation maps OpenCode's lowercase names to the
// Claude-style names the downstream broadcaster + appendFileTouched expect
// (Read/Write/Edit, file_path), so both backends produce identical activity
// rows without further special-casing.
export function normalizeOcToolName(raw: string): string {
  const map: Record<string, string> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    bash: "Bash",
    glob: "Glob",
    grep: "Grep",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    task: "Task",
    multiedit: "MultiEdit",
    notebookedit: "NotebookEdit",
  };
  const lower = raw.toLowerCase();
  return map[lower] ?? (raw ? raw[0].toUpperCase() + raw.slice(1) : "tool");
}

export function normalizeOcToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (typeof out.filePath === "string" && typeof out.file_path !== "string") {
    out.file_path = out.filePath;
  }
  return out;
}

/** Read OpenCode's top-level resume session id from any event. */
function ocSessionId(ev: Record<string, unknown>): string | undefined {
  if (typeof ev.sessionID === "string") return ev.sessionID;
  if (typeof ev.session_id === "string") return ev.session_id;
  return undefined;
}

export function formatOpenCodeStreamEvent(line: string): StreamEventFormatted | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof ev.type === "string" ? ev.type : "";
  // PARITY FIX: surface the resume session id on every event. The registry
  // accessor is idempotent (persists once), so emitting it repeatedly is safe
  // and means OpenCode runs get the same `--session` resume capability that
  // Claude (system:init) and Codex (session) already have.
  const claudeSessionId = ocSessionId(ev);

  if (type === "tool_use") {
    const part = (ev.part ?? {}) as Record<string, unknown>;
    const rawName = typeof part.tool === "string" ? part.tool : "tool";
    const name = normalizeOcToolName(rawName);
    const callId = typeof part.callID === "string" ? part.callID : `oc-tool-${Date.now()}`;
    const state = (part.state ?? {}) as Record<string, unknown>;
    const status = typeof state.status === "string" ? state.status : "";
    const rawInput =
      state.input && typeof state.input === "object"
        ? (state.input as Record<string, unknown>)
        : {};
    const input = normalizeOcToolInput(rawInput);
    const output = typeof state.output === "string" ? state.output : "";
    const title = typeof part.title === "string" ? part.title : "";

    const short = summarizeToolInput(name, input);
    const label = title || (short ? `${name}: ${short}` : name);
    const preview = output ? output.replace(/\s+/g, " ").slice(0, 80) : "";

    // Wall-clock duration straight from opencode, so a single-event completed
    // tool reports its real runtime instead of the ~0ms the downstream gap math
    // would yield (start + end land in the same tick).
    const time = (state.time ?? {}) as Record<string, unknown>;
    const startMs = typeof time.start === "number" ? time.start : undefined;
    const endMs = typeof time.end === "number" ? time.end : undefined;
    const durationMs =
      startMs !== undefined && endMs !== undefined && endMs >= startMs
        ? endMs - startMs
        : undefined;

    const toolStart = { toolCallId: callId, name, arguments: input };

    // ── Lifecycle split by state.status (matrix documented above the function) ──
    if (status === "pending" || status === "running") {
      // Streaming start: the tool just kicked off; its end arrives later.
      return {
        transcript: `🔧 ${label}`,
        summary: label,
        activity: { kind: name, label },
        toolStarts: [toolStart],
        claudeSessionId,
      };
    }

    // "completed" | "failed"/"error" | "" (legacy). For "", keep the original
    // guard: only treat it as a paired both-at-once event when it carries real
    // input AND output (otherwise it's a no-signal placeholder we skip below).
    const isLegacyUnknown = status === "";
    if (isLegacyUnknown && !(output && Object.keys(rawInput).length > 0)) {
      return claudeSessionId ? { claudeSessionId } : null;
    }

    const isError = status !== "completed" && status !== "";
    return {
      transcript: [`🔧 ${label}`, isError ? `✗ ${preview || status}` : `✓ ${preview || "ok"}`].join(
        "\n",
      ),
      summary: label,
      activity: isError
        ? { kind: "tool_error", label: preview || status || "error" }
        : { kind: name, label },
      toolStarts: [toolStart],
      toolEnds: [
        {
          toolCallId: callId,
          ...(isError ? { error: preview || status || "error" } : { result: preview || "ok" }),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      ],
      claudeSessionId,
    };
  }

  if (type === "text") {
    const part = (ev.part ?? {}) as Record<string, unknown>;
    const text = typeof part.text === "string" ? part.text : "";
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!preview) return claudeSessionId ? { claudeSessionId } : null;
    return {
      transcript: `💬 ${preview}`,
      summary: preview,
      activity: { kind: "assistant", label: preview.slice(0, 80) },
      claudeSessionId,
    };
  }

  if (type === "error") {
    const err = (ev.error ?? {}) as Record<string, unknown>;
    const data = (err.data ?? {}) as Record<string, unknown>;
    const message =
      (typeof data.message === "string" && data.message) ||
      (typeof err.name === "string" && err.name) ||
      "unknown error";
    return {
      transcript: `⚠️ ${message}`,
      summary: `error: ${message}`,
      activity: { kind: "error", label: message.slice(0, 80) },
      claudeSessionId,
    };
  }

  // step_start (phase begin) is the earliest event that carries the session id;
  // surface it so resume works even before the first tool/text event lands.
  if ((type === "step_start" || type === "step_finish") && claudeSessionId) {
    return { claudeSessionId };
  }

  // unknown → no UI signal (but still propagate session id if present).
  return claudeSessionId ? { claudeSessionId } : null;
}

// ── Codex: `exec --json` JSONL ──────────────────────────────────────────────

/**
 * Normalize one Codex NEW-schema `item.started` / `item.completed` event into
 * the shared shape. `isEnd` is true for `item.completed`. Tool starts/ends pair
 * on `item.id` (stable across the started/completed pair within a run).
 */
function formatCodexItem(
  ev: Record<string, unknown>,
  isEnd: boolean,
  claudeSessionId: string | undefined,
): StreamEventFormatted | null {
  const item = (ev.item ?? {}) as Record<string, unknown>;
  const itemType = typeof item.type === "string" ? item.type : "";
  const id = typeof item.id === "string" ? item.id : "";
  const status = typeof item.status === "string" ? item.status : "";
  const pass = claudeSessionId ? { claudeSessionId } : null;

  // Reasoning / thinking — transcript only, no tool lifecycle. Emit once we
  // have text (on completed, or on started if the version streams it there).
  if (itemType === "reasoning") {
    const text =
      typeof item.text === "string"
        ? item.text
        : typeof item.summary === "string"
          ? item.summary
          : "";
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!preview) return pass;
    return {
      transcript: `💭 ${preview}`,
      summary: preview,
      activity: { kind: "reasoning", label: preview.slice(0, 80) },
      claudeSessionId,
    };
  }

  // Assistant message — text turn, surfaced when the item completes.
  if (itemType === "agent_message") {
    if (!isEnd) return pass;
    const text = typeof item.text === "string" ? item.text : "";
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!preview) return pass;
    return {
      transcript: `💬 ${preview}`,
      summary: preview,
      activity: { kind: "assistant", label: preview.slice(0, 80) },
      claudeSessionId,
    };
  }

  // ── Tool items: command_execution / file_change / web_search / mcp_tool_call
  let name = "";
  let args: Record<string, unknown> = {};
  let cmdPreview = "";
  if (itemType === "command_execution") {
    name = "Bash";
    const command = typeof item.command === "string" ? item.command : "";
    args = { command };
    cmdPreview = command.replace(/\s+/g, " ").slice(0, 80);
  } else if (itemType === "file_change") {
    const changes = Array.isArray(item.changes)
      ? (item.changes as Array<Record<string, unknown>>)
      : [];
    const first = (changes[0] ?? {}) as Record<string, unknown>;
    const file = typeof first.path === "string" ? first.path : "";
    // "Write" only when every change is a brand-new file; otherwise "Edit".
    const allAdd =
      changes.length > 0 && changes.every((c) => (c as { kind?: unknown }).kind === "add");
    name = allAdd ? "Write" : "Edit";
    args = file ? { file_path: file } : {};
    cmdPreview = file ? shortenPath(file) : "";
  } else if (itemType === "web_search") {
    name = "WebSearch";
    const query = typeof item.query === "string" ? item.query : "";
    args = query ? { query } : {};
    cmdPreview = query.slice(0, 80);
  } else if (itemType === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    name = server || tool ? `${server || "Mcp"}${tool ? `.${tool}` : ""}` : "McpTool";
    cmdPreview = tool || server;
  } else {
    // Unknown item type — no tool signal, but keep the session id flowing.
    return pass;
  }

  const label = cmdPreview ? `${name}: ${cmdPreview}` : name;

  if (!isEnd) {
    // item.started → tool start
    return {
      transcript: `🔧 ${label}`,
      summary: label,
      activity: { kind: name, label },
      ...(id ? { toolStarts: [{ toolCallId: id, name, arguments: args }] } : {}),
      claudeSessionId,
    };
  }

  // item.completed → tool end
  const exitCode =
    typeof item.exit_code === "number"
      ? item.exit_code
      : typeof (item as { exitCode?: unknown }).exitCode === "number"
        ? ((item as { exitCode: number }).exitCode as number)
        : undefined;
  const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
  const isError = status === "failed" || (exitCode !== undefined && exitCode !== 0);
  const preview = output.replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    transcript: isError ? `✗ ${preview || `exit ${exitCode ?? "?"}`}` : `✓ ${preview || "ok"}`,
    summary: label,
    ...(isError ? { activity: { kind: "tool_error", label: preview || "error" } } : {}),
    ...(id
      ? {
          toolEnds: [
            {
              toolCallId: id,
              ...(isError
                ? { error: preview || `exit ${exitCode ?? "?"}` }
                : { result: preview || "ok" }),
            },
          ],
        }
      : {}),
    claudeSessionId,
  };
}

/**
 * Parse one line of Codex's `--json` JSONL output and surface what matters for
 * the activity UI. Maps to the same StreamEventFormatted shape as Claude/OpenCode
 * parsers so the downstream recordActivity + heartbeat loop works identically.
 *
 * Two Codex schemas are handled (the CLI changed event shape across versions;
 * both are kept so a Codex upgrade/downgrade doesn't blank the activity feed):
 *
 * NEW (codex-cli ≥ 0.4x, verified on 0.137.0 `exec --json`) — thread/turn/item:
 *   thread.started   — boot; `thread_id` is the resume id.
 *   turn.started     — turn boundary; no UI signal.
 *   item.started     — a work item began. `item.type` selects the tool:
 *                        command_execution → Bash  ({ command })
 *                        file_change       → Write (all-add) | Edit  ({ file_path })
 *                        web_search        → WebSearch ({ query })
 *                        mcp_tool_call     → <Server>  (generic)
 *                        reasoning         → transcript-only 💭 (NO tool start/end)
 *                        agent_message     → no signal on start (text lands on completed)
 *   item.completed   — same item.type set; emits the paired tool end, or for
 *                      agent_message the 💬 assistant text. Pairs by `item.id`.
 *   turn.completed   — turn done; surfaced as a ✅ finish/done signal.
 *
 * LEGACY (older codex) — session/message/result/text:
 *   session/session_id  — boot event, capture sessionId for resume
 *   result              — final output text → done
 *   message role=assistant  — assistant reply with content blocks (output_text/text)
 *   text                — inline text event
 *
 * Reasoning caveat: codex 0.137.0 `exec --json` folds reasoning into the
 * agent_message and does NOT emit a standalone `reasoning` item (even with
 * `-c model_reasoning_summary=detailed`), so the 💭 branch is defensive /
 * forward-looking; it fires on versions that do emit reasoning items.
 *
 * Unknown events are silently skipped (session id still propagated).
 */
export function formatCodexStreamEvent(line: string): StreamEventFormatted | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof ev.type === "string" ? ev.type : "";

  // Session ID — look in any of the common Codex field locations
  const claudeSessionId =
    typeof ev.session_id === "string"
      ? ev.session_id
      : typeof ev.sessionId === "string"
        ? ev.sessionId
        : type === "session" && typeof ev.id === "string"
          ? (ev.id as string)
          : type === "thread.started" && typeof ev.thread_id === "string"
            ? (ev.thread_id as string)
            : undefined;

  // ── NEW schema: thread/turn/item lifecycle ────────────────────────────────
  if (type === "thread.started") {
    return { transcript: "⚡ Codex session started", claudeSessionId };
  }
  if (type === "turn.started") {
    return claudeSessionId ? { claudeSessionId } : null;
  }
  if (type === "turn.completed") {
    return {
      transcript: "✅ finished",
      summary: "finished",
      activity: { kind: "done", label: "finished" },
      claudeSessionId,
    };
  }
  if (type === "item.started" || type === "item.completed") {
    return formatCodexItem(ev, type === "item.completed", claudeSessionId);
  }

  if (type === "session") {
    return { transcript: "⚡ Codex session started", claudeSessionId };
  }

  if (type === "result") {
    const output = typeof ev.output === "string" ? ev.output : "";
    const preview = output.replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      transcript: preview ? `✅ ${preview}` : "✅ finished",
      summary: preview || "finished",
      activity: { kind: "done", label: preview.slice(0, 80) || "finished" },
    };
  }

  if (type === "message") {
    const role = typeof ev.role === "string" ? ev.role : "";
    if (role !== "assistant") return null;

    const content = ev.content;
    const lines: string[] = [];
    let activity: StreamEventFormatted["activity"];
    let summary: string | undefined;

    if (Array.isArray(content)) {
      for (const c of content as Record<string, unknown>[]) {
        const ct = typeof c.type === "string" ? c.type : "";
        if ((ct === "output_text" || ct === "text") && typeof c.text === "string") {
          const preview = (c.text as string).replace(/\s+/g, " ").trim().slice(0, 200);
          if (preview) {
            lines.push(`💬 ${preview}`);
            summary = preview;
            activity = { kind: "assistant", label: preview.slice(0, 80) };
          }
        }
      }
    } else if (typeof content === "string") {
      const preview = content.replace(/\s+/g, " ").trim().slice(0, 200);
      if (preview) {
        lines.push(`💬 ${preview}`);
        summary = preview;
        activity = { kind: "assistant", label: preview.slice(0, 80) };
      }
    }

    if (lines.length === 0) return null;
    return { transcript: lines.join("\n"), summary, activity, claudeSessionId };
  }

  if (type === "text") {
    const text =
      typeof ev.text === "string"
        ? ev.text
        : typeof ev.content === "string"
          ? (ev.content as string)
          : "";
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!preview) return null;
    return {
      transcript: `💬 ${preview}`,
      summary: preview,
      activity: { kind: "assistant", label: preview.slice(0, 80) },
      claudeSessionId,
    };
  }

  return null;
}

// ── Grok Build: `--output-format streaming-json` NDJSON ─────────────────────
//
// One `type`-tagged object per line (Grok Build user guide, headless mode):
//   text {data} · thought {data} · tool_call {toolCallId, toolName, rawInput}
//   tool_call_update {toolCallId, status, rawOutput} · usage · plan
//   error {message} · end {sessionId, stopReason, usage} (always last)
// Text arrives in small chunks, so it is buffered per parser instance and only
// surfaced at a tool boundary or the end. Tool names are mapped to the
// Claude-style names the activity pipeline already renders.

const GROK_TOOL_NAMES: Record<string, string> = {
  read_file: "Read",
  search_replace: "Edit",
  write: "Write",
  run_terminal_cmd: "Bash",
  run_terminal_command: "Bash",
  grep: "Grep",
  grep_search: "Grep",
  list_dir: "LS",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  todo_write: "TodoWrite",
  task: "Task",
};

function normalizeGrokToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  if (typeof out.path === "string" && out.file_path === undefined) out.file_path = out.path;
  if (typeof out.target_file === "string" && out.file_path === undefined)
    out.file_path = out.target_file;
  if (typeof out.cmd === "string" && out.command === undefined) out.command = out.cmd;
  return out;
}

export function createGrokStreamParser(): StreamParser {
  let pendingText = "";
  const flushText = (): string[] => {
    const preview = pendingText.replace(/\s+/g, " ").trim().slice(0, 200);
    pendingText = "";
    return preview ? [`💬 ${preview}`] : [];
  };
  return (line: string) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    const type = typeof ev.type === "string" ? ev.type : "";
    const claudeSessionId = typeof ev.sessionId === "string" ? ev.sessionId : undefined;
    if (type === "text") {
      if (typeof ev.data === "string") pendingText += ev.data;
      return null;
    }
    if (type === "tool_call") {
      const raw = typeof ev.toolName === "string" ? ev.toolName : "tool";
      const name = GROK_TOOL_NAMES[raw] ?? raw;
      const input = normalizeGrokToolInput(
        ev.rawInput && typeof ev.rawInput === "object"
          ? (ev.rawInput as Record<string, unknown>)
          : {},
      );
      const short = summarizeToolInput(name, input);
      const label = short ? `${name}: ${short}` : name;
      const id = typeof ev.toolCallId === "string" ? ev.toolCallId : `coder-tool-${Date.now()}`;
      return {
        transcript: [...flushText(), `🔧 ${label}`].join("\n"),
        summary: label,
        activity: { kind: name, label },
        toolStarts: [{ toolCallId: id, name, arguments: input }],
      };
    }
    if (type === "tool_call_update") {
      const status = typeof ev.status === "string" ? ev.status : "";
      if (status !== "completed" && status !== "failed") return null;
      const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
      const failed = status === "failed";
      const preview = renderToolResultPreview(ev.rawOutput ?? ev.content);
      const label = failed ? `✗ ${preview || "error"}` : `✓ ${preview || "ok"}`;
      return {
        transcript: label,
        ...(failed
          ? { activity: { kind: "tool_error", label: preview || "error" }, summary: label }
          : {}),
        toolEnds: id
          ? [
              {
                toolCallId: id,
                ...(failed ? { error: preview || "error" } : { result: preview || "ok" }),
              },
            ]
          : undefined,
      };
    }
    if (type === "error") {
      const msg = typeof ev.message === "string" ? ev.message : "Grok Build reported an error";
      return {
        transcript: [...flushText(), `⚠️ ${msg}`].join("\n"),
        summary: msg,
        activity: { kind: "error", label: msg.slice(0, 80) },
        claudeSessionId,
      };
    }
    if (type === "end") {
      const stop = typeof ev.stopReason === "string" ? ev.stopReason : "";
      const ok = !stop || stop === "end_turn" || stop === "EndTurn";
      const lines = [...flushText(), ok ? "✅ finished" : `⚠️ finished (${stop})`];
      return {
        transcript: lines.join("\n"),
        summary: ok ? "finished" : `finished: ${stop}`,
        activity: { kind: ok ? "done" : "error", label: ok ? "finished" : stop },
        claudeSessionId,
      };
    }
    return null;
  };
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Return the NDJSON line parser for a backend. This is the ONLY place the
 * consumer branches on backend id; everything after the parser is shared.
 */
export function getStreamParser(backendId: CoderBackendId): StreamParser {
  switch (backendId) {
    case "opencode":
      return formatOpenCodeStreamEvent;
    case "codex":
      return formatCodexStreamEvent;
    case "grok":
      // Stateful (buffers text chunks): a fresh parser per call / per run.
      return createGrokStreamParser();
    default:
      return formatClaudeStreamEvent;
  }
}
