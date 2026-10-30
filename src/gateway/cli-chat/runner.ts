/**
 * CLI chat runner — one chat turn through a coding CLI (Claude Code, Codex,
 * OpenCode, Gemini CLI) for the chat composer's "CLI" mode.
 *
 * Each turn is a headless run of the CLI in the thread's working folder that
 * resumes the thread's own CLI session (`--resume` / `exec resume` /
 * `--session` / `-r`), so the conversation carries on turn after turn and
 * survives gateway restarts (the session ids live on the gateway session
 * entry, see server-methods/chat-cli.ts). Output is parsed from each CLI's
 * JSON event stream into a small normalized event set: streamed text, tool
 * calls (shown collapsed in the UI), the CLI session id, errors.
 *
 * The parsers are pure (fed one stdout line at a time) so they are unit-tested
 * against real captured CLI output.
 */

import type { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { enrichedPathEnv, resolveBin } from "../../agents/coder-backend/bin-detect.js";
import { applyCoderSpawnEnv } from "../../agents/coder-install/keys.js";
import {
  classifyCliFailure,
  describeCliFailure,
  isUnsupportedAccountMessage,
  isUntrustedDirMessage,
  pickDetailLine,
  type CliFailureKind,
} from "../../agents/cli-runner/stream.js";
import { commandLineFits } from "../../process/argv-budget.js";
import { spawnCli } from "../../process/win-spawn.js";

export type CliChatBackend = "claude-code" | "codex" | "opencode" | "gemini" | "grok";

export const CLI_CHAT_BACKENDS: readonly CliChatBackend[] = [
  "claude-code",
  "codex",
  "opencode",
  "gemini",
  "grok",
];

export const CLI_CHAT_LABELS: Record<CliChatBackend, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  grok: "Grok Build",
};

const CLI_CHAT_BINS: Record<CliChatBackend, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  grok: "grok",
};

/** Accepts the UI/PTY vocabulary too ("claude", "codex-cli", …). */
export function normalizeCliChatBackend(raw: unknown): CliChatBackend | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/-cli$/, "");
  if (v === "claude" || v === "claude-code" || v === "claudecode" || v === "cc")
    return "claude-code";
  if (v === "codex") return "codex";
  if (v === "opencode" || v === "oc") return "opencode";
  if (v === "gemini") return "gemini";
  if (v === "grok" || v === "grok-build" || v === "grokbuild") return "grok";
  return null;
}

export type CliChatTool = {
  id: string;
  name: string;
  /** One-line summary of the call (command, file path, query…). */
  input?: string;
  status: "running" | "done" | "error";
  /** Truncated tool output. */
  output?: string;
};

export type CliChatEvent =
  | { kind: "session"; id: string }
  /** `append`: streamed delta onto the current text block; `block`: a whole new text block. */
  | { kind: "text"; text: string; mode: "append" | "block" }
  | { kind: "tool"; tool: CliChatTool }
  | { kind: "error"; message: string }
  | { kind: "done" };

const TOOL_OUTPUT_MAX = 2000;
const TOOL_INPUT_MAX = 200;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Short human summary of a tool's input object. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return clip(input, TOOL_INPUT_MAX) || undefined;
  if (typeof input !== "object") return clip(String(input), TOOL_INPUT_MAX);
  const o = input as Record<string, unknown>;
  for (const key of [
    "command",
    "cmd",
    "file_path",
    "filePath",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "description",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return clip(v, TOOL_INPUT_MAX);
    if (Array.isArray(v) && v.every((x) => typeof x === "string"))
      return clip(v.join(" "), TOOL_INPUT_MAX);
  }
  try {
    const json = JSON.stringify(o);
    return json === "{}" ? undefined : clip(json, TOOL_INPUT_MAX);
  } catch {
    return undefined;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export interface CliStreamParser {
  /** Feed one stdout line; returns the normalized events it produced. */
  feed(line: string): CliChatEvent[];
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const l = line.trim();
  if (!l || l[0] !== "{") return null;
  try {
    const v = JSON.parse(l) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Claude Code `-p --output-format stream-json --verbose --include-partial-messages`. */
function claudeParser(): CliStreamParser {
  const streamedMsgIds = new Set<string>();
  let currentMsgId: string | null = null;
  let blockOpen = false;
  return {
    feed(line) {
      const ev = parseJsonLine(line);
      if (!ev) return [];
      const out: CliChatEvent[] = [];
      if (typeof ev.session_id === "string" && ev.type === "system" && ev.subtype === "init") {
        out.push({ kind: "session", id: ev.session_id });
      }
      if (ev.type === "stream_event") {
        const e = (ev.event ?? {}) as Record<string, unknown>;
        if (e.type === "message_start") {
          const m = e.message as { id?: unknown } | undefined;
          currentMsgId = typeof m?.id === "string" ? m.id : null;
        } else if (e.type === "content_block_start") {
          const block = e.content_block as { type?: unknown } | undefined;
          blockOpen = block?.type === "text";
          if (blockOpen) out.push({ kind: "text", text: "", mode: "block" });
        } else if (e.type === "content_block_delta") {
          const d = e.delta as { type?: unknown; text?: unknown } | undefined;
          if (d?.type === "text_delta" && typeof d.text === "string" && d.text) {
            if (currentMsgId) streamedMsgIds.add(currentMsgId);
            out.push({ kind: "text", text: d.text, mode: blockOpen ? "append" : "block" });
            blockOpen = true;
          }
        } else if (e.type === "content_block_stop") {
          blockOpen = false;
        }
        return out;
      }
      if (ev.type === "assistant") {
        const msg = (ev.message ?? {}) as { id?: unknown; content?: unknown };
        const content = Array.isArray(msg.content)
          ? (msg.content as Array<Record<string, unknown>>)
          : [];
        const streamed = typeof msg.id === "string" && streamedMsgIds.has(msg.id);
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text && !streamed) {
            out.push({ kind: "text", text: block.text, mode: "block" });
          } else if (block.type === "tool_use") {
            out.push({
              kind: "tool",
              tool: {
                id: String(block.id ?? ""),
                name: String(block.name ?? "tool"),
                input: summarizeToolInput(block.input),
                status: "running",
              },
            });
          }
        }
        return out;
      }
      if (ev.type === "user") {
        const msg = (ev.message ?? {}) as { content?: unknown };
        const content = Array.isArray(msg.content)
          ? (msg.content as Array<Record<string, unknown>>)
          : [];
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          out.push({
            kind: "tool",
            tool: {
              id: String(block.tool_use_id ?? ""),
              name: "",
              status: block.is_error ? "error" : "done",
              output: clip(toolResultText(block.content), TOOL_OUTPUT_MAX),
            },
          });
        }
        return out;
      }
      if (ev.type === "result") {
        if (typeof ev.session_id === "string") out.push({ kind: "session", id: ev.session_id });
        if (ev.is_error) {
          const msg =
            typeof ev.result === "string" && ev.result ? ev.result : String(ev.subtype ?? "error");
          out.push({ kind: "error", message: msg });
        }
        out.push({ kind: "done" });
      }
      return out;
    },
  };
}

/** Codex `exec --json`. */
function codexParser(): CliStreamParser {
  return {
    feed(line) {
      const ev = parseJsonLine(line);
      if (!ev) return [];
      const out: CliChatEvent[] = [];
      if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
        out.push({ kind: "session", id: ev.thread_id });
      }
      if (
        ev.type === "item.started" ||
        ev.type === "item.completed" ||
        ev.type === "item.updated"
      ) {
        const item = (ev.item ?? {}) as Record<string, unknown>;
        const id = String(item.id ?? "");
        const done = ev.type === "item.completed";
        switch (item.type) {
          case "agent_message":
            if (done && typeof item.text === "string" && item.text) {
              out.push({ kind: "text", text: item.text, mode: "block" });
            }
            break;
          case "command_execution": {
            const failed = done && typeof item.exit_code === "number" && item.exit_code !== 0;
            out.push({
              kind: "tool",
              tool: {
                id,
                name: "shell",
                input: summarizeToolInput(item.command),
                status: !done ? "running" : failed ? "error" : "done",
                output: done
                  ? clip(String(item.aggregated_output ?? ""), TOOL_OUTPUT_MAX)
                  : undefined,
              },
            });
            break;
          }
          case "file_change": {
            const changes = Array.isArray(item.changes)
              ? (item.changes as Array<{ path?: unknown }>)
              : [];
            out.push({
              kind: "tool",
              tool: {
                id,
                name: "edit",
                input:
                  clip(
                    changes
                      .map((c) => String(c.path ?? ""))
                      .filter(Boolean)
                      .join(", "),
                    TOOL_INPUT_MAX,
                  ) || undefined,
                status: done ? (item.status === "failed" ? "error" : "done") : "running",
              },
            });
            break;
          }
          case "mcp_tool_call":
            out.push({
              kind: "tool",
              tool: {
                id,
                name:
                  [item.server, item.tool].filter((x) => typeof x === "string" && x).join(".") ||
                  "mcp",
                input: summarizeToolInput(item.arguments),
                status: done ? (item.status === "failed" ? "error" : "done") : "running",
              },
            });
            break;
          case "web_search":
            out.push({
              kind: "tool",
              tool: {
                id,
                name: "web_search",
                input: summarizeToolInput(item.query),
                status: done ? "done" : "running",
              },
            });
            break;
          case "error":
            if (typeof item.message === "string")
              out.push({ kind: "error", message: item.message });
            break;
        }
      }
      if (ev.type === "turn.failed") {
        const err = ev.error as { message?: unknown } | undefined;
        out.push({
          kind: "error",
          message: typeof err?.message === "string" ? err.message : "Codex turn failed",
        });
        out.push({ kind: "done" });
      }
      if (ev.type === "error" && typeof ev.message === "string") {
        out.push({ kind: "error", message: ev.message });
      }
      if (ev.type === "turn.completed") out.push({ kind: "done" });
      return out;
    },
  };
}

/** OpenCode `run --format json`. */
function opencodeParser(): CliStreamParser {
  let announced = false;
  return {
    feed(line) {
      const ev = parseJsonLine(line);
      if (!ev) return [];
      const out: CliChatEvent[] = [];
      const sid =
        typeof ev.sessionID === "string"
          ? ev.sessionID
          : typeof ev.session_id === "string"
            ? ev.session_id
            : null;
      if (sid && !announced) {
        announced = true;
        out.push({ kind: "session", id: sid });
      }
      const part = (ev.part ?? {}) as Record<string, unknown>;
      if (ev.type === "text") {
        const text =
          typeof part.text === "string" ? part.text : typeof ev.text === "string" ? ev.text : "";
        if (text) out.push({ kind: "text", text, mode: "block" });
      } else if (ev.type === "tool_use" || ev.type === "tool") {
        const state = (part.state ?? {}) as Record<string, unknown>;
        const status =
          state.status === "error" ? "error" : state.status === "completed" ? "done" : "running";
        out.push({
          kind: "tool",
          tool: {
            id: String(part.callID ?? part.id ?? ""),
            name: String(part.tool ?? "tool"),
            input: summarizeToolInput(state.input),
            status,
            output:
              typeof state.output === "string"
                ? clip(state.output, TOOL_OUTPUT_MAX)
                : typeof state.error === "string"
                  ? clip(state.error, TOOL_OUTPUT_MAX)
                  : undefined,
          },
        });
      } else if (ev.type === "error") {
        const err = (ev.error ?? {}) as {
          name?: unknown;
          message?: unknown;
          data?: { message?: unknown };
        };
        const msg =
          typeof err.data?.message === "string"
            ? err.data.message
            : typeof err.message === "string"
              ? err.message
              : String(err.name ?? "OpenCode error");
        out.push({ kind: "error", message: msg });
      }
      return out;
    },
  };
}

/**
 * Grok Build `--output-format streaming-json`: {type:"text",data} deltas,
 * {type:"tool_call",toolCallId,toolName,rawInput}, {type:"tool_call_update",
 * toolCallId,status,rawOutput}, {type:"error",message}, {type:"end",sessionId}.
 */
function grokParser(): CliStreamParser {
  let inText = false;
  return {
    feed(line) {
      const ev = parseJsonLine(line);
      if (!ev) return [];
      const out: CliChatEvent[] = [];
      if (typeof ev.sessionId === "string" && ev.sessionId)
        out.push({ kind: "session", id: ev.sessionId });
      if (ev.type === "text") {
        const text = typeof ev.data === "string" ? ev.data : "";
        if (text) {
          out.push({ kind: "text", text, mode: inText ? "append" : "block" });
          inText = true;
        }
      } else if (ev.type === "tool_call") {
        inText = false;
        out.push({
          kind: "tool",
          tool: {
            id: String(ev.toolCallId ?? ""),
            name: String(ev.toolName ?? "tool"),
            input: summarizeToolInput(ev.rawInput),
            status: "running",
          },
        });
      } else if (ev.type === "tool_call_update") {
        const status = String(ev.status ?? "");
        const done = status === "completed" || status === "failed" || status === "error";
        out.push({
          kind: "tool",
          tool: {
            id: String(ev.toolCallId ?? ""),
            name: "",
            status: !done ? "running" : status === "completed" ? "done" : "error",
            output: clip(
              typeof ev.rawOutput === "string"
                ? ev.rawOutput
                : ev.rawOutput == null
                  ? ""
                  : JSON.stringify(ev.rawOutput),
              TOOL_OUTPUT_MAX,
            ),
          },
        });
      } else if (ev.type === "error") {
        out.push({
          kind: "error",
          message: typeof ev.message === "string" && ev.message ? ev.message : "Grok Build failed",
        });
      } else if (ev.type === "max_turns_reached") {
        out.push({ kind: "error", message: "Grok Build stopped: it reached its turn limit." });
      } else if (ev.type === "end") {
        out.push({ kind: "done" });
      }
      return out;
    },
  };
}

/** Gemini CLI `-o stream-json`. */
function geminiParser(): CliStreamParser {
  let lastWasDelta = false;
  return {
    feed(line) {
      const ev = parseJsonLine(line);
      if (!ev) return [];
      const out: CliChatEvent[] = [];
      if (ev.type === "init" && typeof ev.session_id === "string")
        out.push({ kind: "session", id: ev.session_id });
      if (ev.type === "message" && ev.role === "assistant") {
        const text = typeof ev.content === "string" ? ev.content : "";
        if (text) {
          out.push({ kind: "text", text, mode: ev.delta && lastWasDelta ? "append" : "block" });
          lastWasDelta = Boolean(ev.delta);
        }
      } else if (ev.type === "tool_use") {
        lastWasDelta = false;
        out.push({
          kind: "tool",
          tool: {
            id: String(ev.tool_id ?? ""),
            name: String(ev.tool_name ?? "tool"),
            input: summarizeToolInput(ev.parameters),
            status: "running",
          },
        });
      } else if (ev.type === "tool_result") {
        const err = ev.error as { message?: unknown } | undefined;
        out.push({
          kind: "tool",
          tool: {
            id: String(ev.tool_id ?? ""),
            name: "",
            status: ev.status === "error" ? "error" : "done",
            output: clip(
              typeof ev.output === "string"
                ? ev.output
                : typeof err?.message === "string"
                  ? err.message
                  : "",
              TOOL_OUTPUT_MAX,
            ),
          },
        });
      } else if (ev.type === "error" && typeof ev.message === "string") {
        out.push({ kind: "error", message: ev.message });
      } else if (ev.type === "result") {
        const err = ev.error as { message?: unknown } | undefined;
        if (ev.status === "error") {
          out.push({
            kind: "error",
            message: typeof err?.message === "string" ? err.message : "Gemini CLI failed",
          });
        }
        out.push({ kind: "done" });
      }
      return out;
    },
  };
}

export function createCliStreamParser(backend: CliChatBackend): CliStreamParser {
  switch (backend) {
    case "claude-code":
      return claudeParser();
    case "codex":
      return codexParser();
    case "opencode":
      return opencodeParser();
    case "gemini":
      return geminiParser();
    case "grok":
      return grokParser();
  }
}

export type CliChatLaunch = {
  bin: string;
  args: string[];
  stdin?: string;
  /** Scratch files written for this launch (prompt files); delete after the turn. */
  tempFiles?: string[];
};

/** Write a prompt to an owner-only scratch file for `--prompt-file`-style flags. */
function writeChatPromptFile(body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "infinibot-cli-chat-"));
  const file = path.join(dir, "prompt.txt");
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

export function buildCliChatLaunch(params: {
  backend: CliChatBackend;
  prompt: string;
  model?: string | null;
  resumeId?: string | null;
  /** Resolved binary spawn will run (sizes the Windows command line). */
  command?: string;
  /** Test seam: platform whose command-line budget applies. */
  platform?: NodeJS.Platform;
  /** Test seam: where prompt files go. */
  writePromptFile?: (body: string) => string;
}): CliChatLaunch {
  const { backend, prompt } = params;
  const model = params.model?.trim() || null;
  const resumeId = params.resumeId?.trim() || null;
  const bin = CLI_CHAT_BINS[backend];
  // The prompt rides in argv only while the whole command line fits this
  // platform (Windows: 32,767 chars, 8,191 through cmd.exe; POSIX: 128 KiB
  // per arg). Otherwise it goes through stdin or a prompt file — a long
  // message is never refused.
  const fits = (args: string[]) =>
    commandLineFits({ command: params.command ?? bin, args, platform: params.platform });
  switch (backend) {
    case "claude-code": {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
      ];
      if (model) args.push("--model", model);
      if (resumeId) args.push("--resume", resumeId);
      return { bin, args, stdin: prompt };
    }
    case "codex": {
      const args: string[] = [];
      if (model) args.push("--model", model);
      args.push(
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
      );
      if (resumeId) args.push("resume", resumeId);
      args.push("-");
      return { bin, args, stdin: prompt };
    }
    case "opencode": {
      const args = ["run", "--format", "json"];
      if (model) args.push("--model", model);
      if (resumeId) args.push("--session", resumeId);
      // `opencode run` reads a non-TTY stdin as the message.
      if (fits([...args, prompt])) return { bin, args: [...args, prompt] };
      return { bin, args, stdin: prompt };
    }
    case "gemini": {
      const args = ["-o", "stream-json", "--approval-mode", "yolo"];
      if (model) args.push("-m", model);
      if (resumeId) args.push("-r", resumeId);
      // Without -p, a piped stdin is the headless prompt.
      if (fits([...args, "-p", prompt])) return { bin, args: [...args, "-p", prompt] };
      return { bin, args, stdin: prompt };
    }
    case "grok": {
      // Headless Grok Build never reads piped stdin: -p, else --prompt-file.
      const args = ["--output-format", "streaming-json", "--always-approve"];
      if (model) args.push("-m", model);
      if (resumeId) args.push("--resume", resumeId);
      if (fits([...args, "-p", prompt])) return { bin, args: [...args, "-p", prompt] };
      const file = (params.writePromptFile ?? writeChatPromptFile)(prompt);
      return { bin, args: [...args, "--prompt-file", file], tempFiles: [file] };
    }
  }
}

/** Stderr noise CLIs print on every run — never the reason a turn failed. */
const STDERR_NOISE = [
  /^YOLO mode is enabled/i,
  /^Loaded cached credentials/i,
  /^Reading prompt from stdin/i,
  /^\s*$/,
];

/** The most useful stderr line(s) for a failed run with no other error. */
export function stderrReason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !STDERR_NOISE.some((re) => re.test(l)));
  const joined = lines.join("\n");
  const kind = classifyCliFailure(joined);
  if (kind === "unsupported_account" || kind === "untrusted_dir") {
    return describeCliFailure({ kind, label: "Gemini CLI", command: "gemini", detail: joined });
  }
  if (kind !== "unknown") return joined;
  // A multi-line error object ends in "}": prefer the line that names the error.
  return clip(pickDetailLine(joined) ?? lines.slice(-3).join(" "), 500);
}

/**
 * Plain-English text for a failed chat CLI turn — never a raw "spawn EINVAL"
 * or a lone "}". Recognised failures (not installed, signed out, can't start,
 * plan/quota limits, account rejected) get a sentence with a next step; the
 * rest keep their most readable line.
 */
export function humanizeCliChatError(
  backend: CliChatBackend,
  raw: string,
): { message: string; kind: CliFailureKind } {
  const label = CLI_CHAT_LABELS[backend];
  const command = CLI_CHAT_BINS[backend];
  const text = (raw ?? "").trim();
  if (isUnsupportedAccountMessage(text)) return { message: text, kind: "unsupported_account" };
  if (isUntrustedDirMessage(text)) return { message: text, kind: "untrusted_dir" };
  const kind = classifyCliFailure(text);
  if (kind !== "unknown") {
    return {
      message: describeCliFailure({
        kind,
        label,
        command,
        detail:
          kind === "not_installed" || kind === "spawn_failed" || kind === "command_too_long"
            ? undefined
            : text,
      }),
      kind,
    };
  }
  const line = pickDetailLine(text);
  return {
    message: line ? `${label} couldn't answer: ${clip(line, 400)}` : `${label} couldn't answer.`,
    kind,
  };
}

/** The CLI rejected the stored session id: retry the turn as a fresh session. */
export function isMissingSessionError(text: string): boolean {
  return /no conversation found|session[^.\n]{0,40}not found|could not find session|unknown session|invalid session|no session (?:found|with)/i.test(
    text,
  );
}

/** Folds the event stream into the reply text + tool list shown in chat. */
export class CliTurnAccumulator {
  text = "";
  tools: CliChatTool[] = [];
  sessionId: string | null = null;
  errors: string[] = [];
  done = false;

  apply(ev: CliChatEvent): void {
    switch (ev.kind) {
      case "session":
        this.sessionId = ev.id;
        break;
      case "text":
        // A new block (possibly an empty opener whose deltas follow) starts a paragraph.
        if (ev.mode === "block" && this.text.trim() && !this.text.endsWith("\n\n"))
          this.text += "\n\n";
        this.text += ev.text;
        break;
      case "tool": {
        const i = ev.tool.id ? this.tools.findIndex((t) => t.id === ev.tool.id) : -1;
        if (i >= 0) {
          const prev = this.tools[i];
          this.tools[i] = {
            ...prev,
            ...Object.fromEntries(
              Object.entries(ev.tool).filter(([, v]) => v !== undefined && v !== ""),
            ),
          } as CliChatTool;
        } else if (ev.tool.name) {
          this.tools.push(ev.tool);
        }
        break;
      }
      case "error":
        if (!this.errors.includes(ev.message)) this.errors.push(ev.message);
        break;
      case "done":
        this.done = true;
        break;
    }
  }

  /** Reply text with trailing separators trimmed. */
  get reply(): string {
    return this.text.replace(/\s+$/, "");
  }
}

export type CliTurnResult = {
  text: string;
  tools: CliChatTool[];
  sessionId: string | null;
  error: string | null;
  aborted: boolean;
  exitCode: number | null;
  /** The stored session was gone, so the turn ran as a fresh session. */
  restarted: boolean;
  /** What kind of failure `error` is (set only when error is). */
  errorKind?: CliFailureKind;
};

export type CliTurnHandle = {
  result: Promise<CliTurnResult>;
  abort: () => void;
};

const TURN_TIMEOUT_MS = 30 * 60_000;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Run one chat turn. `onProgress` fires on every change with the folded state. */
export function runCliChatTurn(params: {
  backend: CliChatBackend;
  prompt: string;
  cwd: string;
  model?: string | null;
  resumeId?: string | null;
  onProgress?: (acc: CliTurnAccumulator) => void;
  /** Test seam: spawn replacement. */
  spawnImpl?: typeof spawn;
}): CliTurnHandle {
  let aborted = false;
  let current: ChildProcess | null = null;
  // spawnCli: Windows .cmd shims (codex.cmd, gemini.cmd, …) run via their real
  // target — a bare spawn() of a .cmd throws EINVAL (CVE-2024-27980).
  const spawnFn = params.spawnImpl ?? (spawnCli as unknown as typeof spawn);

  const runOnce = (resumeId: string | null) =>
    new Promise<{
      acc: CliTurnAccumulator;
      stderr: string;
      exitCode: number | null;
      spawnError?: string;
    }>((resolve) => {
      const acc = new CliTurnAccumulator();
      let launch: CliChatLaunch;
      const bin = CLI_CHAT_BINS[params.backend];
      const command = resolveBin(bin) ?? bin;
      try {
        launch = buildCliChatLaunch({ ...params, resumeId, command });
      } catch (err) {
        resolve({ acc, stderr: "", exitCode: null, spawnError: (err as Error).message });
        return;
      }
      const env = enrichedPathEnv({ ...process.env });
      applyCoderSpawnEnv(params.backend, env);
      // Never let a chat CLI inherit the gateway's own run context.
      delete env.INFINIBOT_SUBAGENT_RUN_ID;
      delete env.INFINIBOT_SUBAGENT_SESSION_KEY;
      delete env.INFINIBOT_PARENT_SESSION_KEY;
      let child: ChildProcess;
      try {
        child = spawnFn(command, launch.args, {
          cwd: params.cwd,
          env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        for (const file of launch.tempFiles ?? []) {
          rmSync(path.dirname(file), { recursive: true, force: true });
        }
        resolve({ acc, stderr: "", exitCode: null, spawnError: (err as Error).message });
        return;
      }
      current = child;
      const parser = createCliStreamParser(params.backend);
      let buf = "";
      let stderr = "";
      const timer = setTimeout(() => killTree(child, "SIGTERM"), TURN_TIMEOUT_MS);
      const handleLine = (line: string) => {
        const events = parser.feed(line);
        if (!events.length) return;
        for (const ev of events) acc.apply(ev);
        params.onProgress?.(acc);
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-8000);
      });
      let settled = false;
      const finish = (exitCode: number | null, spawnError?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const file of launch.tempFiles ?? []) {
          rmSync(path.dirname(file), { recursive: true, force: true });
        }
        if (buf.trim()) handleLine(buf);
        buf = "";
        resolve({ acc, stderr, exitCode, spawnError });
      };
      child.on("error", (err) => finish(null, err.message));
      child.on("close", (code) => finish(code));
      if (launch.stdin !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(launch.stdin);
      } else {
        child.stdin?.end();
      }
    });

  const result = (async (): Promise<CliTurnResult> => {
    const resumeId = params.resumeId?.trim() || null;
    let run = await runOnce(resumeId);
    let restarted = false;
    const failedText = () => [...run.acc.errors, run.stderr].join("\n");
    if (
      !aborted &&
      resumeId &&
      !run.acc.reply &&
      (run.exitCode !== 0 || run.acc.errors.length) &&
      isMissingSessionError(failedText())
    ) {
      restarted = true;
      run = await runOnce(null);
    }
    const { acc } = run;
    let rawError: string | null = null;
    if (run.spawnError) {
      rawError = run.spawnError;
    } else if (!aborted && acc.errors.length) {
      rawError = [acc.errors.join("\n"), acc.reply ? "" : run.stderr].filter(Boolean).join("\n");
    } else if (!aborted && run.exitCode !== 0 && !acc.reply) {
      rawError = stderrReason(run.stderr) || `it stopped unexpectedly (exit code ${run.exitCode}).`;
    }
    let error: string | null = null;
    let errorKind: CliFailureKind | undefined;
    if (rawError) {
      const h = humanizeCliChatError(params.backend, rawError);
      error = h.message;
      errorKind = h.kind;
    }
    return {
      text: acc.reply,
      tools: acc.tools,
      sessionId: acc.sessionId,
      error,
      aborted,
      exitCode: run.exitCode,
      restarted,
      ...(errorKind ? { errorKind } : {}),
    };
  })();

  return {
    result,
    abort: () => {
      aborted = true;
      if (current) {
        killTree(current, "SIGINT");
        const c = current;
        setTimeout(() => killTree(c, "SIGKILL"), 3000).unref?.();
      }
    },
  };
}
