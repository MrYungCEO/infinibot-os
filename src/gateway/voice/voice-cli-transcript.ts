/**
 * The CLI's own transcript as the reply source of a routed voice turn.
 *
 * A full-screen agent TUI (Claude Code, Codex) repaints with cursor moves and
 * spinners, so its raw PTY bytes are not text: cleaning them gives spinner
 * fragments ("✶ h i") and loses the answer. The old Voice Terminal (before the
 * Voice page moved onto Robovoice) read the CLI's JSONL transcript instead —
 * the exact assistant text plus an explicit end-of-turn marker. This module
 * brings that back for voice.cliRoute turns:
 *
 *   claude  ~/.claude/projects/<cwd>/<--session-id>.jsonl
 *           assistant text blocks → reply; tool_use → activity;
 *           system/turn_duration (or stop_reason end_turn) → turn over.
 *   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (cwd + mtime match)
 *           response_item assistant message / event_msg agent_message → reply;
 *           function / custom tool calls → activity; task_complete → over.
 *
 * Read by polling (the turn already ticks every 150 ms), from the byte offset
 * the file had when the utterance was typed, and only lines stamped after it.
 */

import fs from "node:fs";

import {
  findCodexTranscriptForTerminal,
  findTranscriptBySessionId,
  findTranscriptForTerminal,
} from "../server-methods/terminal-assistant-stream.js";

export type CliTranscriptEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "end"; text?: string };

export type CliTranscriptSource = {
  /** Path once found (Claude creates the file on the first message). */
  file(): string | null;
  /** New events since the last call. */
  poll(): CliTranscriptEvent[];
};

export type CliTranscriptLocator = {
  cliType: string;
  /** Claude: the `--session-id` the terminal was launched with. */
  sessionId?: string;
  cwd?: string;
  /** Terminal creation time (cwd heuristic lower bound). */
  createdAtMs?: number;
  /** Overrides (tests). */
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
};

export function transcriptKindOf(cliType: string | undefined): "claude" | "codex" | null {
  const t = (cliType ?? "").toLowerCase();
  if (t === "claude" || t === "claude-code") return "claude";
  if (t === "codex") return "codex";
  return null;
}

function locate(loc: CliTranscriptLocator, sinceMs: number): string | null {
  const kind = transcriptKindOf(loc.cliType);
  if (kind === "claude") {
    if (loc.sessionId) {
      const exact = findTranscriptBySessionId({
        sessionId: loc.sessionId,
        projectsDir: loc.claudeProjectsDir,
      });
      if (exact) return exact;
    }
    if (!loc.cwd) return null;
    // No pre-assigned id (a session the user started by hand): newest file of
    // this folder written since the turn started.
    return findTranscriptForTerminal({
      cwd: loc.cwd,
      createdAtMs: Math.max(loc.createdAtMs ?? 0, sinceMs),
      projectsDir: loc.claudeProjectsDir,
    });
  }
  if (kind === "codex" && loc.cwd) {
    return findCodexTranscriptForTerminal({
      cwd: loc.cwd,
      createdAtMs: Math.max(loc.createdAtMs ?? 0, sinceMs),
      sessionsDir: loc.codexSessionsDir,
    });
  }
  return null;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Complete JSONL lines after `offset`; returns the offset after the last complete line. */
function readLines(file: string, offset: number): { offset: number; lines: unknown[] } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { offset: size < offset ? 0 : offset, lines: [] };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { offset, lines: [] };
    const complete = text.slice(0, lastNl);
    const lines: unknown[] = [];
    for (const l of complete.split(/\r?\n/)) {
      if (!l.trim()) continue;
      try {
        lines.push(JSON.parse(l));
      } catch {
        /* malformed line: skip */
      }
    }
    return { offset: offset + Buffer.byteLength(complete, "utf8") + 1, lines };
  } catch {
    return { offset, lines: [] };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Events of one transcript line (pure; exported for tests). */
export function transcriptLineEvents(raw: unknown): CliTranscriptEvent[] {
  if (!isRec(raw)) return [];
  const out: CliTranscriptEvent[] = [];
  const type = raw.type;
  // ── Claude Code ──
  if (type === "assistant" && isRec(raw.message)) {
    const content = raw.message.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isRec(b)) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim())
          out.push({ kind: "text", text: b.text.trim() });
        else if (b.type === "tool_use" && typeof b.name === "string")
          out.push({ kind: "tool", name: b.name });
      }
    }
    if (raw.message.stop_reason === "end_turn") out.push({ kind: "end" });
    return out;
  }
  if (type === "system" && raw.subtype === "turn_duration") return [{ kind: "end" }];
  if (type === "user" && isRec(raw.message)) {
    // Esc / Ctrl-C: Claude records the interruption as a user line.
    const c = raw.message.content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((b) => (isRec(b) && typeof b.text === "string" ? b.text : "")).join(" ")
          : "";
    if (text.trim().startsWith("[Request interrupted by user")) return [{ kind: "end" }];
    return [];
  }
  // ── Codex ──
  const p = isRec(raw.payload) ? raw.payload : null;
  if (!p) return [];
  if (type === "response_item" && p.type === "message" && p.role === "assistant") {
    if (Array.isArray(p.content))
      for (const b of p.content)
        if (isRec(b) && typeof b.text === "string" && b.text.trim())
          out.push({ kind: "text", text: b.text.trim() });
    return out;
  }
  if (
    type === "response_item" &&
    (p.type === "function_call" || p.type === "custom_tool_call") &&
    typeof p.name === "string"
  )
    return [{ kind: "tool", name: p.name }];
  if (type === "event_msg" && p.type === "agent_message" && typeof p.message === "string")
    return p.message.trim() ? [{ kind: "text", text: p.message.trim() }] : [];
  if (type === "event_msg" && p.type === "task_complete")
    return [
      {
        kind: "end",
        ...(typeof p.last_agent_message === "string" && p.last_agent_message.trim()
          ? { text: p.last_agent_message.trim() }
          : {}),
      },
    ];
  if (type === "event_msg" && (p.type === "turn_aborted" || p.type === "error"))
    return [{ kind: "end" }];
  return [];
}

function lineTime(raw: unknown): number | null {
  if (!isRec(raw) || typeof raw.timestamp !== "string") return null;
  const ms = Date.parse(raw.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A transcript reader for one turn, positioned at "now": only what the CLI
 * writes after this call is reported. null when the CLI keeps no transcript
 * we can read (then the turn reads the rendered screen instead).
 */
export function openCliTranscript(
  loc: CliTranscriptLocator,
  now = Date.now(),
): CliTranscriptSource | null {
  const kind = transcriptKindOf(loc.cliType);
  if (!kind) return null;
  // Lines a moment older than the utterance are the previous turn's tail.
  const sinceMs = now - 500;
  let file = locate(loc, now);
  // Known file: start at its current end. Found later (Claude writes it on the
  // first message): start at 0 and let the timestamp gate drop older lines.
  let offset = file ? fileSize(file) : 0;
  const seenCodexTexts = new Set<string>();
  return {
    file: () => file,
    poll: () => {
      if (!file) {
        file = locate(loc, sinceMs);
        if (!file) return [];
        offset = 0;
      }
      const r = readLines(file, offset);
      offset = r.offset;
      const events: CliTranscriptEvent[] = [];
      for (const line of r.lines) {
        const t = lineTime(line);
        if (t !== null && t < sinceMs) continue;
        for (const e of transcriptLineEvents(line)) {
          // Codex logs the final message twice (response_item + event); speak it once.
          if (kind === "codex" && e.kind === "text") {
            if (seenCodexTexts.has(e.text)) continue;
            seenCodexTexts.add(e.text);
          }
          events.push(e);
        }
      }
      return events;
    },
  };
}
