/**
 * Claude chat bridge — powers the `/claude` chat command (Telegram et al.).
 *
 * While a chat session is in Claude mode, each inbound message is typed into
 * an interactive Claude Code session running in a tmux-backed terminal, and
 * the reply is read back from Claude Code's JSONL transcript
 * (`~/.claude/projects/<enc-cwd>/<sessionId>.jsonl`). The session id is
 * pre-minted (`--session-id`), so the transcript is located exactly.
 *
 * The terminal is an ordinary InfiniBot terminal: it shows up in the
 * Terminals view and can be attached by hand
 * (`tmux -L <state-scoped-socket> attach -t infinibot_<terminalId>`). Because it is
 * tmux-backed it survives gateway restarts; `ensureClaudeBridge` re-attaches
 * a pty client to the live pane instead of launching a second Claude.
 *
 * Turn detection (Claude Code 2.x transcript):
 *   - our prompt lands as a `user` entry (not a tool_result / meta entry);
 *   - the turn ends with a `system` entry of subtype `turn_duration`;
 *   - fallback: an assistant `end_turn` message followed by a quiet file.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

import type { ClaudeBridgeState } from "../config/sessions.js";
import { findTranscriptBySessionId } from "../gateway/server-methods/terminal-assistant-stream.js";
import type { TerminalManager } from "./manager.js";
import * as TmuxBackend from "./tmux-backend.js";

const SHELL_COMMANDS = new Set([
  "bash",
  "zsh",
  "sh",
  "dash",
  "fish",
  "ksh",
  "tcsh",
  "csh",
  "login",
  "tmux",
]);

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Terminal ids use only `[A-Za-z0-9_]` so the tmux session name round-trips unchanged. */
export function claudeBridgeTerminalId(sessionKey: string, nowMs = Date.now()): string {
  const hash = createHash("sha1").update(sessionKey).digest("hex").slice(0, 10);
  return `chatclaude_${hash}_${nowMs.toString(36)}`;
}

/** True when the terminal's pane (or, without tmux, its pty) is still alive. */
export async function isClaudeBridgePaneAlive(
  manager: TerminalManager,
  terminalId: string,
): Promise<boolean> {
  if (TmuxBackend.isTmuxAvailable()) return TmuxBackend.hasLiveSession(terminalId);
  return Boolean(manager.getTerminal(terminalId)?.pty);
}

/** True when the pane's foreground process is something other than a shell (i.e. Claude). */
export async function isClaudeRunningInPane(
  manager: TerminalManager,
  terminalId: string,
): Promise<boolean> {
  if (!TmuxBackend.isTmuxAvailable()) {
    return manager.getTerminal(terminalId)?.cliType === "claude";
  }
  const command = await TmuxBackend.getPaneCurrentCommand(terminalId);
  if (!command) return false;
  return !SHELL_COMMANDS.has(command.replace(/^-/, "").toLowerCase());
}

/** Plain-text snapshot of the bottom of the pane (last `lines` non-empty rows). */
export async function captureClaudeBridgeScreen(
  manager: TerminalManager,
  terminalId: string,
  lines = 40,
): Promise<string> {
  let raw = "";
  if (TmuxBackend.isTmuxAvailable()) {
    raw = await TmuxBackend.capturePane(terminalId, 200);
  } else {
    raw = manager.getTerminal(terminalId)?.outputBuffer?.slice(-20_000) ?? "";
  }
  const rows = stripAnsi(raw)
    .split("\n")
    .map((row) => row.replace(/\s+$/, ""));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.slice(-lines).join("\n");
}

type ReadyCheck = { ready: boolean; blocker?: string };

/** Classify a pane snapshot taken while Claude Code boots. */
export function classifyClaudeStartupScreen(screen: string): ReadyCheck {
  if (/trust (the files in )?this folder|do you trust/i.test(screen)) {
    return { ready: false, blocker: "Claude is asking whether to trust this folder." };
  }
  if (/bypass permissions mode/i.test(screen) && /accept/i.test(screen)) {
    return {
      ready: false,
      blocker: "Claude is showing its one-time Bypass Permissions consent prompt.",
    };
  }
  if (/select login method|please log ?in|run \/login/i.test(screen)) {
    return { ready: false, blocker: "Claude Code is not logged in." };
  }
  if (/bypass permissions on|\? for shortcuts|shift\+tab to cycle/i.test(screen)) {
    return { ready: true };
  }
  return { ready: false };
}

async function waitForClaudeReady(
  manager: TerminalManager,
  terminalId: string,
  timeoutMs: number,
): Promise<ReadyCheck> {
  if (!TmuxBackend.isTmuxAvailable()) {
    await sleep(4000);
    return { ready: true };
  }
  const deadline = Date.now() + timeoutMs;
  let last: ReadyCheck = { ready: false };
  while (Date.now() < deadline) {
    await sleep(500);
    last = classifyClaudeStartupScreen(await captureClaudeBridgeScreen(manager, terminalId, 60));
    if (last.ready || last.blocker) return last;
  }
  return last;
}

/** Kill the bridge terminal and its tmux pane (tracked by the manager or not). */
export async function closeClaudeBridge(
  manager: TerminalManager,
  terminalId: string,
): Promise<void> {
  if (manager.getTerminal(terminalId)) {
    await manager.destroy(terminalId).catch(() => undefined);
  }
  if (TmuxBackend.isTmuxAvailable() && (await TmuxBackend.hasLiveSession(terminalId))) {
    await TmuxBackend.killSession(terminalId);
  }
}

export type EnsureClaudeBridgeResult =
  | { ok: true; state: ClaudeBridgeState; launched: boolean; note?: string }
  | { ok: false; error: string };

/**
 * Return a bridge terminal with Claude running in it — reusing `existing`
 * when its pane is still alive (re-attaching after a gateway restart, and
 * relaunching Claude if it exited back to the shell), otherwise creating a
 * fresh terminal. `fresh` forces a brand-new terminal + Claude session.
 */
export async function ensureClaudeBridge(params: {
  manager: TerminalManager;
  sessionKey: string;
  cwd: string;
  title: string;
  existing?: ClaudeBridgeState;
  fresh?: boolean;
  readyTimeoutMs?: number;
}): Promise<EnsureClaudeBridgeResult> {
  const { manager, existing, title } = params;
  const readyTimeoutMs = params.readyTimeoutMs ?? 30_000;

  if (existing && !params.fresh && (await isClaudeBridgePaneAlive(manager, existing.terminalId))) {
    if (!manager.getTerminal(existing.terminalId)) {
      // The tmux pane outlived a gateway restart — `create` goes through
      // `tmux new-session -A`, which attaches instead of spawning a shell.
      const res = await manager.create({ id: existing.terminalId, cwd: existing.cwd, title });
      if (!res.success) {
        return { ok: false, error: res.error || "Failed to re-attach the Claude terminal" };
      }
    }
    if (await isClaudeRunningInPane(manager, existing.terminalId)) {
      return { ok: true, state: { ...existing, enabled: true }, launched: false };
    }
    const claudeSessionId = randomUUID();
    await manager.invokeAgentCLI(existing.terminalId, "claude", { claudeSessionId });
    const ready = await waitForClaudeReady(manager, existing.terminalId, readyTimeoutMs);
    return {
      ok: true,
      state: { ...existing, enabled: true, claudeSessionId, startedAt: Date.now() },
      launched: true,
      note: ready.blocker ?? "The previous Claude session had exited — started a new one.",
    };
  }

  if (existing) await closeClaudeBridge(manager, existing.terminalId);

  const terminalId = claudeBridgeTerminalId(params.sessionKey);
  const res = await manager.create({ id: terminalId, cwd: params.cwd, title });
  if (!res.success)
    return { ok: false, error: res.error || "Failed to create the Claude terminal" };
  const actualId = res.terminalId || terminalId;
  const claudeSessionId = randomUUID();
  await manager.invokeAgentCLI(actualId, "claude", { claudeSessionId });
  const ready = await waitForClaudeReady(manager, actualId, readyTimeoutMs);
  return {
    ok: true,
    state: {
      enabled: true,
      terminalId: actualId,
      claudeSessionId,
      cwd: manager.getTerminal(actualId)?.cwd ?? params.cwd,
      startedAt: Date.now(),
    },
    launched: true,
    note: ready.blocker,
  };
}

/**
 * PTY writes that submit `text` as one Claude Code prompt. Multi-line text is
 * sent as a bracketed paste so embedded newlines don't submit early; tmux
 * strips the markers if the app hasn't enabled bracketed-paste mode.
 */
export function encodeClaudePrompt(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const body = normalized.includes("\n") ? `\x1b[200~${normalized}\x1b[201~` : normalized;
  return [body, "\r"];
}

export type TranscriptTurnEvent =
  | { kind: "accepted" }
  | { kind: "queued" }
  | { kind: "text"; text: string; stopReason?: string }
  | { kind: "end"; reason: "turn_duration" | "interrupted" | "api-error" };

type TranscriptEntry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: { stop_reason?: string | null; content?: unknown };
};

function contentBlocks(content: unknown): Array<{ type?: string; text?: string }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
}

/**
 * Incremental parser for the tail of a Claude Code transcript, scoped to one
 * turn: everything before our prompt's `user` entry is ignored so a previous
 * turn's end marker can't finish this one.
 */
export class ClaudeTranscriptTurnReader {
  private partial = "";
  private readonly seen = new Set<string>();
  accepted = false;
  ended = false;

  feed(chunk: string): TranscriptTurnEvent[] {
    const events: TranscriptTurnEvent[] = [];
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (this.ended) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(trimmed) as TranscriptEntry;
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object" || entry.isSidechain) continue;
      if (entry.uuid) {
        if (this.seen.has(entry.uuid)) continue;
        this.seen.add(entry.uuid);
      }
      events.push(...this.handleEntry(entry));
    }
    return events;
  }

  private handleEntry(entry: TranscriptEntry): TranscriptTurnEvent[] {
    if (entry.type === "queue-operation" && !this.accepted) return [{ kind: "queued" }];
    if (entry.type === "user") {
      const blocks = contentBlocks(entry.message?.content);
      if (blocks.some((b) => b.type === "tool_result")) return [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (!this.accepted) {
        if (entry.isMeta) return [];
        this.accepted = true;
        return [{ kind: "accepted" }];
      }
      if (text.includes("[Request interrupted by user")) {
        this.ended = true;
        return [{ kind: "end", reason: "interrupted" }];
      }
      return [];
    }
    if (!this.accepted) return [];
    if (entry.type === "assistant") {
      const text = contentBlocks(entry.message?.content)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")
        .trim();
      const events: TranscriptTurnEvent[] = [];
      if (text) {
        events.push({ kind: "text", text, stopReason: entry.message?.stop_reason ?? undefined });
      }
      if (entry.isApiErrorMessage) {
        this.ended = true;
        events.push({ kind: "end", reason: "api-error" });
      }
      return events;
    }
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      this.ended = true;
      return [{ kind: "end", reason: "turn_duration" }];
    }
    return [];
  }
}

export type ClaudeTurnResult = {
  status: "done" | "timeout" | "not-accepted";
  /** Final reply text (assistant `end_turn` text, or everything not already sent as progress). */
  text: string;
  /** Pane snapshot, included when the prompt never landed. */
  screen?: string;
};

function readTail(filePath: string, offset: number): { text: string; size: number } {
  let fd: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size <= offset) return { text: "", size };
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.toString("utf8"), size };
  } catch {
    return { text: "", size: offset };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Type `text` into the bridge's Claude session and wait for the turn to end.
 * Intermediate assistant text (narration between tool calls) goes to
 * `onProgress` as it lands; the returned `text` is the closing reply.
 */
export async function sendToClaudeBridge(params: {
  manager: TerminalManager;
  state: ClaudeBridgeState;
  text: string;
  onProgress?: (text: string) => Promise<void> | void;
  timeoutMs?: number;
  acceptTimeoutMs?: number;
  pollMs?: number;
  /** Quiet period after an `end_turn` message that counts as turn end. */
  idleEndMs?: number;
  projectsDir?: string;
}): Promise<ClaudeTurnResult> {
  const { manager, state } = params;
  const timeoutMs = params.timeoutMs ?? 30 * 60_000;
  const acceptTimeoutMs = params.acceptTimeoutMs ?? 45_000;
  const pollMs = params.pollMs ?? 500;
  const idleEndMs = params.idleEndMs ?? 5_000;

  const locate = () =>
    findTranscriptBySessionId({
      sessionId: state.claudeSessionId,
      projectsDir: params.projectsDir,
    });
  let transcriptPath = locate();
  let offset = transcriptPath ? fs.statSync(transcriptPath).size : 0;

  const writes = encodeClaudePrompt(params.text);
  for (let i = 0; i < writes.length; i++) {
    if (i > 0) await sleep(250);
    manager.write(state.terminalId, writes[i]);
  }

  const reader = new ClaudeTranscriptTurnReader();
  const finalTexts: string[] = [];
  const pendingTexts: string[] = [];
  let lastStopReason: string | undefined;
  let lastGrowthAt = Date.now();
  let queued = false;
  const startedAt = Date.now();

  const finish = (status: ClaudeTurnResult["status"]): ClaudeTurnResult => ({
    status,
    text: (finalTexts.length ? finalTexts : pendingTexts).join("\n\n").trim(),
  });

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    if (!transcriptPath) {
      transcriptPath = locate();
      offset = 0;
    }
    if (transcriptPath) {
      const tail = readTail(transcriptPath, offset);
      if (tail.text) {
        lastGrowthAt = Date.now();
        // Only consume complete bytes; the reader buffers partial lines itself.
        offset = tail.size;
        for (const event of reader.feed(tail.text)) {
          if (event.kind === "queued") queued = true;
          if (event.kind === "text") {
            lastStopReason = event.stopReason;
            if (event.stopReason === "end_turn") {
              finalTexts.push(event.text);
            } else if (params.onProgress) {
              await params.onProgress(event.text);
            } else {
              pendingTexts.push(event.text);
            }
          }
          if (event.kind === "end") return finish("done");
        }
      }
    }
    if (!reader.accepted && !queued && Date.now() - startedAt > acceptTimeoutMs) {
      return {
        status: "not-accepted",
        text: "",
        screen: await captureClaudeBridgeScreen(manager, state.terminalId),
      };
    }
    if (lastStopReason === "end_turn" && Date.now() - lastGrowthAt > idleEndMs) {
      return finish("done");
    }
  }
  return finish("timeout");
}
