/**
 * Backend-agnostic transcript digest for a finished coder run.
 *
 * Reads the raw stdout of a CLI run (Claude Code stream-json, Codex
 * `exec --json`, OpenCode `run --format json`, Gemini stream-json, or plain
 * text) and extracts what the completion pipeline needs: the assistant's text
 * turns, the final message, the session id (for resume), and — for Claude
 * Code — the background tasks still running when the final `result` event was
 * emitted (the W5 failure mode: "I'll wait for the notification." + exit 0).
 */

import { coerceString } from "../shared/text/coerce.js";

export interface BackgroundTaskInfo {
  id: string;
  description: string;
}

export interface TranscriptDigest {
  /** Every assistant text turn, in order. */
  assistantTexts: string[];
  /** The final assistant message (result text when the backend reports one). */
  finalText: string;
  /** All assistant text joined — what the RESULT parser scans. */
  fullText: string;
  sessionId: string | null;
  /** Background tasks still listed as running at the moment the run reported its result. */
  pendingBackgroundTasks: BackgroundTaskInfo[];
  /** Background tasks killed after the result (they never finished). */
  killedAfterResult: string[];
  /** The backend emitted an explicit end-of-run event. */
  sawResultEvent: boolean;
  /** The backend flagged the final result as an error. */
  resultIsError: boolean;
  /** Tool calls observed (name only), for heuristics + UI. */
  toolCalls: string[];
  /** Number of lines that were JSON events (0 → plain text output). */
  jsonEvents: number;
  /**
   * Absolute directories the agent worked in, most-used first: the CLI's
   * session cwd, `cd <dir>` targets of its shell commands, the directories of
   * files it edited, and `worktree` args of its visual_verify calls. The
   * verifier re-runs claimed checks from these instead of guessing.
   */
  workdirs: string[];
  /** visual_verify capture dirs (…/verification/<runId>/visual-xxxx) seen in tool results. */
  visualDirs: string[];
}

const CD_RE = /(?:^|&&|;|\n|\|\||\(|['"])\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
const VISUAL_DIR_RE = /(\/[\w.@+~-]+(?:\/[\w.@+~-]+)*\/verification\/[\w.-]+\/visual-[a-z0-9]+)/gi;

/** `cd /abs/dir` targets in a shell command (relative targets are ignored). */
export function cdTargets(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(CD_RE)) {
    const t = m[1].replace(/^["']|["']$/g, "");
    if (t.startsWith("/")) out.push(t.replace(/\/+$/, "") || "/");
  }
  return out;
}

function noteToolInput(name: string, input: unknown, dirs: Map<string, number>): void {
  if (!input || typeof input !== "object") return;
  const o = input as Record<string, unknown>;
  const bump = (d: string, w = 1) => {
    if (d && d.startsWith("/") && d !== "/") dirs.set(d, (dirs.get(d) ?? 0) + w);
  };
  for (const key of ["command", "cmd"]) {
    const c = o[key];
    if (typeof c === "string") {
      for (const d of cdTargets(c)) bump(d, 2);
      for (const m of c.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\/[^\s;&|')]+)/g))
        bump(m[1].replace(/^["']|["']$/g, ""), 1);
    }
    if (Array.isArray(c)) for (const d of cdTargets(c.map(String).join(" "))) bump(d, 2);
  }
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const f = o[key];
    if (typeof f === "string" && f.startsWith("/") && /\.[\w]{1,8}$/.test(f))
      bump(f.slice(0, f.lastIndexOf("/")), 1);
  }
  if (/visual_verify/.test(name) && typeof o.worktree === "string") bump(o.worktree, 3);
  if (typeof o.workdir === "string") bump(o.workdir, 1);
  if (typeof o.cwd === "string") bump(o.cwd, 2);
}

function noteVisualDirs(text: string, out: Set<string>): void {
  for (const m of text.matchAll(VISUAL_DIR_RE)) out.add(m[1]);
}

function textOfClaudeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? coerceString((b as { text?: unknown }).text)
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function parseTasks(raw: unknown): BackgroundTaskInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      const o = t as Record<string, unknown>;
      const id = typeof o.task_id === "string" ? o.task_id : typeof o.id === "string" ? o.id : "";
      if (!id) return null;
      const status = typeof o.status === "string" ? o.status : "running";
      if (status && !/running|pending|started|in_progress/i.test(status)) return null;
      return {
        id,
        description: typeof o.description === "string" ? o.description.slice(0, 200) : "",
      };
    })
    .filter((t): t is BackgroundTaskInfo => t !== null);
}

export function digestTranscript(raw: string): TranscriptDigest {
  const assistantTexts: string[] = [];
  const toolCalls: string[] = [];
  let sessionId: string | null = null;
  let resultText: string | null = null;
  let sawResultEvent = false;
  let resultIsError = false;
  let jsonEvents = 0;
  let tasksNow: BackgroundTaskInfo[] = [];
  let pendingAtResult: BackgroundTaskInfo[] = [];
  const killedAfterResult: string[] = [];
  const plainLines: string[] = [];
  const dirs = new Map<string, number>();
  const visualDirs = new Set<string>();

  for (const line of (raw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("{")) {
      plainLines.push(line);
      continue;
    }
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      plainLines.push(line);
      continue;
    }
    jsonEvents++;
    const type = typeof ev.type === "string" ? ev.type : "";
    const sid =
      (typeof ev.session_id === "string" && ev.session_id) ||
      (typeof ev.sessionID === "string" && ev.sessionID) ||
      (typeof ev.sessionId === "string" && ev.sessionId) ||
      (type === "thread.started" && typeof ev.thread_id === "string" && ev.thread_id) ||
      null;
    if (sid) sessionId = sid;

    // ── Claude Code stream-json ────────────────────────────────────────
    if (type === "assistant" && ev.message && typeof ev.message === "object") {
      const content = (ev.message as { content?: unknown }).content;
      const text = textOfClaudeContent(content).trim();
      if (text) assistantTexts.push(text);
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
            const name = coerceString((b as { name?: unknown }).name, "tool");
            toolCalls.push(name);
            noteToolInput(name, (b as { input?: unknown }).input, dirs);
          }
        }
      }
      continue;
    }
    if (type === "user" && ev.message && typeof ev.message === "object") {
      // Tool results: visual_verify reports its capture dir here.
      const content = (ev.message as { content?: unknown }).content;
      if (Array.isArray(content))
        for (const b of content) {
          if (b && typeof b === "object" && (b as { type?: string }).type === "tool_result") {
            const c = (b as { content?: unknown }).content;
            const t =
              typeof c === "string"
                ? c
                : Array.isArray(c)
                  ? c.map((x) => coerceString((x as { text?: unknown })?.text)).join("\n")
                  : "";
            if (t.includes("/visual-")) noteVisualDirs(t, visualDirs);
          }
        }
      continue;
    }
    if (type === "system") {
      const subtype = typeof ev.subtype === "string" ? ev.subtype : "";
      if (subtype === "init" && typeof ev.cwd === "string") {
        dirs.set(ev.cwd, (dirs.get(ev.cwd) ?? 0) + 1);
      }
      if (subtype === "background_tasks_changed") {
        tasksNow = parseTasks(ev.tasks);
      } else if (subtype === "task_updated" && sawResultEvent) {
        const patch = (ev.patch ?? {}) as Record<string, unknown>;
        if (patch.status === "killed" && typeof ev.task_id === "string") {
          killedAfterResult.push(ev.task_id);
        }
      }
      continue;
    }
    if (type === "result") {
      sawResultEvent = true;
      resultIsError =
        ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype.startsWith("error"));
      if (typeof ev.result === "string") resultText = ev.result;
      else if (typeof ev.output === "string") resultText = ev.output;
      pendingAtResult = tasksNow;
      continue;
    }

    // ── Codex exec --json ──────────────────────────────────────────────
    if (type === "item.completed" && ev.item && typeof ev.item === "object") {
      const item = ev.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        assistantTexts.push(item.text.trim());
      } else if (item.type === "file_change" && Array.isArray(item.changes)) {
        // Codex edits: { changes: [{ path, kind }] }
        for (const ch of item.changes as Array<{ path?: unknown }>)
          noteToolInput("file_change", { file_path: ch?.path }, dirs);
      } else if (item.type === "command_execution" || item.type === "mcp_tool_call") {
        toolCalls.push(String(item.type));
        noteToolInput(String(item.type), item, dirs);
        if (
          typeof item.aggregated_output === "string" &&
          item.aggregated_output.includes("/visual-")
        )
          noteVisualDirs(item.aggregated_output, visualDirs);
      }
      continue;
    }
    if (type === "turn.completed") {
      sawResultEvent = true;
      continue;
    }
    if (type === "turn.failed" || type === "error") {
      resultIsError = true;
      continue;
    }

    // ── OpenCode run --format json ─────────────────────────────────────
    if (type === "text" && ev.part && typeof ev.part === "object") {
      const text = (ev.part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) assistantTexts.push(text.trim());
      continue;
    }
    if (type === "tool_use") {
      toolCalls.push("tool");
      const part = (ev.part ?? {}) as {
        tool?: unknown;
        state?: { input?: unknown; output?: unknown };
      };
      noteToolInput(coerceString(part.tool, "tool"), part.state?.input, dirs);
      if (typeof part.state?.output === "string" && part.state.output.includes("/visual-"))
        noteVisualDirs(part.state.output, visualDirs);
      continue;
    }

    // ── Gemini / generic { type: message, role: assistant } ─────────────
    if (type === "message" && ev.role === "assistant") {
      const c = ev.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .map((x) =>
                  x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string"
                    ? (x as { text: string }).text
                    : "",
                )
                .join("")
            : "";
      // Gemini streams deltas: merge consecutive fragments into one turn.
      if (text) {
        if (ev.delta === true && assistantTexts.length > 0) {
          assistantTexts[assistantTexts.length - 1] += text;
        } else {
          assistantTexts.push(text);
        }
      }
      continue;
    }
  }

  if (jsonEvents === 0 && plainLines.length > 0) {
    // Plain-text backend output — treat the whole thing as one assistant turn.
    assistantTexts.push(plainLines.join("\n").trim());
  }

  const finalText = (resultText ?? assistantTexts[assistantTexts.length - 1] ?? "").trim();
  const fullText = [
    ...assistantTexts,
    resultText && !assistantTexts.includes(resultText) ? resultText : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    assistantTexts,
    finalText,
    fullText,
    sessionId,
    pendingBackgroundTasks: sawResultEvent ? pendingAtResult : tasksNow,
    killedAfterResult,
    sawResultEvent,
    resultIsError,
    toolCalls,
    jsonEvents,
    workdirs: [...dirs.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([d]) => d)
      .slice(0, 24),
    visualDirs: [...visualDirs].slice(0, 50),
  };
}
