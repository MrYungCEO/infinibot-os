/**
 * Terminal-attached Claude Code transcript streamer.
 *
 * Watches the JSONL transcript Claude Code writes for the session running
 * inside a given terminal, and emits an `assistant.text.delta` gateway event
 * for each text chunk the assistant produces. Used by voice-chat's terminal
 * mode so Kokoro can read the assistant's reply aloud the moment Claude
 * Code flushes a new line to disk — which is well before the line finishes
 * scrolling into the user's xterm.
 *
 * Linking strategy: Claude Code stores transcripts at
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * Each line carries a `cwd` field. We pick the most recent `.jsonl` whose
 * cwd matches the terminal's cwd and whose mtime is later than the
 * terminal's `createdAt`. That picks the right file in the common
 * "one-terminal-one-claude" case; if the heuristic ever picks wrong the
 * subscriber can re-pick by passing an explicit transcriptPath.
 *
 * Filter rules: only `content[].type === "text"` blocks are emitted.
 * `thinking`, `tool_use`, `tool_result`, and the like are dropped — the user
 * doesn't want them spoken.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("gateway").child("terminal-assistant-stream");

interface FileSubscription {
  kind: "file";
  terminalId: string;
  transcriptPath: string;
  transcriptKind: "claude" | "codex";
  watcher: FSWatcher;
  /** Bytes already consumed from the file, so we only emit new tail. */
  offset: number;
  /** Per-line uuid set so re-reads after rotation don't double-emit. */
  emittedUuids: Set<string>;
  /** Sequence number for `chunkIndex` in events. */
  chunkSeq: number;
  /**
   * Wall-clock at attach time. Lines older than (this - lookbackMs) are
   * tracked in `emittedUuids` for de-dup but not emitted as audio. This is
   * what catches the "user spoke → Claude wrote reply → stream attached"
   * race where the reply is already on disk by the time we mount.
   */
  attachedAtMs: number;
  /** How far back in time we still emit on attach. Default 30s. */
  lookbackMs: number;
}

interface PtySubscription {
  kind: "pty";
  terminalId: string;
  cliType: string;
  unsubscribe: () => void;
  /** Sequence number for `chunkIndex` in events. */
  chunkSeq: number;
  /** Carry-over partial line between PTY chunks (no trailing newline yet). */
  lineBuffer: string;
  /** Recently emitted lines for short-window de-dup of redraws/echo. */
  recentLines: Map<string, number>;
  /** Recently written lines so echoed user input can be suppressed. */
  recentInputs: Map<string, number>;
  /** Flushes an unterminated visible TUI row after the CLI stops redrawing. */
  idleFlushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Claude-only: rolling raw PTY buffer + last spoken reply. Interactive Claude
   * Code paints a full-screen TUI (not append-only lines) and never persists a
   * findable jsonl transcript in our spawn context, so the file tailer can't be
   * used. We instead snapshot the screen on idle and speak the newest `●`
   * assistant block. These hold that state.
   */
  claudeRawBuffer?: string;
  claudeLastSpoken?: string;
}

interface OpenCodeSubscription {
  kind: "opencode";
  terminalId: string;
  sessionId: string;
  pollTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  emittedPartIds: Set<string>;
  chunkSeq: number;
  attachedAtMs: number;
  lookbackMs: number;
  pollIntervalMs: number;
  exportSession: (sessionId: string) => string;
  emit: AssistantTextEmitter;
}

type ActiveSubscription = FileSubscription | PtySubscription | OpenCodeSubscription;

const subscriptions = new Map<string, ActiveSubscription>();

export interface AssistantTextDelta {
  terminalId: string;
  text: string;
  chunkIndex: number;
  /** Claude Code message uuid the chunk came from. */
  uuid?: string;
  /** Wall-clock ms when the chunk was emitted from disk. */
  ts: number;
}

export type AssistantTextEmitter = (delta: AssistantTextDelta) => void;

function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Locate the transcript for a known Claude Code session-id. The CLI writes
 * one file per session named `<sessionId>.jsonl`, so the lookup is just a
 * sweep across the project subdirs (~10 entries on a typical machine).
 *
 * This is the *exact* match — preferred over `findTranscriptForTerminal`
 * (cwd+mtime heuristic) whenever infinibot pre-assigned the session-id at
 * launch via `--session-id`. Returns null only when Claude Code hasn't
 * created the file yet (caller should retry shortly).
 */
export function findTranscriptBySessionId(params: {
  sessionId: string;
  projectsDir?: string;
}): string | null {
  const projectsDir = params.projectsDir ?? defaultProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  const fileName = `${params.sessionId}.jsonl`;
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const sub of entries) {
    const candidate = path.join(projectsDir, sub, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Find the JSONL file most likely to belong to a terminal's Claude Code
 * session. Returns null if no matching transcript exists yet.
 *
 * Heuristic: scan ~/.claude/projects/<encoded>/*.jsonl, pick the file whose
 * first head-line carries a matching `cwd` AND whose mtime is the most
 * recent of those candidates above the terminal's createdAt. This is good
 * enough for the common one-claude-per-terminal case and degrades to "newest
 * matching session" otherwise.
 */
export function findTranscriptForTerminal(params: {
  cwd: string;
  createdAtMs: number;
  projectsDir?: string;
}): string | null {
  const projectsDir = params.projectsDir ?? defaultProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;

  const wantedCwd = path.resolve(params.cwd);

  let projectSubdirs: string[];
  try {
    projectSubdirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }

  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const sub of projectSubdirs) {
    const subPath = path.join(projectsDir, sub);
    let entries: string[];
    try {
      entries = fs.readdirSync(subPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(subPath, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      // Drop files that haven't been touched since the terminal opened.
      if (stat.mtimeMs < params.createdAtMs - 5_000) continue;
      const cwd = readTranscriptCwd(filePath);
      if (!cwd) continue;
      // Windows/OneDrive: Claude Code records the cwd with its own casing and
      // separators, which routinely differs from the terminal's recorded cwd
      // (drive-letter case, `\` vs `/`). A strict `!==` silently drops the match
      // and leaves read-aloud with no transcript → nothing is ever spoken.
      // Compare path-normalized, and case-insensitively on win32.
      const candidateCwd = path.resolve(cwd);
      const cwdMatches =
        process.platform === "win32"
          ? candidateCwd.toLowerCase() === wantedCwd.toLowerCase()
          : candidateCwd === wantedCwd;
      if (!cwdMatches) continue;
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].filePath;
}

const HEAD_BYTES = 8 * 1024;
const CODEX_HEAD_BYTES = 1024 * 1024;
const OPENCODE_COMMAND_TIMEOUT_MS = 3_000;
const OPENCODE_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const OPENCODE_POLL_INTERVAL_MS = 1_000;

export type OpenCodeCommandRunner = (args: string[]) => string;

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function runOpenCodeCommand(args: string[]): string {
  const execArgs =
    process.platform === "win32"
      ? { command: "opencode", args }
      : {
          command: process.env.SHELL || "/bin/bash",
          args: ["-lc", ["opencode", ...args].map(shellQuote).join(" ")],
        };

  return execFileSync(execArgs.command, execArgs.args, {
    encoding: "utf8",
    maxBuffer: OPENCODE_COMMAND_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENCODE_COMMAND_TIMEOUT_MS,
  });
}

function parseJsonFromOutput(output: string, startChar: "{" | "["): unknown | null {
  const idx = output.indexOf(startChar);
  if (idx < 0) return null;
  try {
    return JSON.parse(output.slice(idx));
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function selectOpenCodeSessionForTerminal(params: {
  cwd: string;
  createdAtMs: number;
  sessions: unknown[];
}): string | null {
  const wantedCwd = path.resolve(params.cwd);
  const candidates: Array<{ id: string; updatedMs: number }> = [];

  for (const raw of params.sessions) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    const directory = typeof raw.directory === "string" ? raw.directory : "";
    if (!id || !directory) continue;
    if (path.resolve(directory) !== wantedCwd) continue;
    const updatedMs = asNumber(raw.updated) ?? asNumber(raw.created) ?? 0;
    if (updatedMs < params.createdAtMs - 5_000) continue;
    candidates.push({ id, updatedMs });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.updatedMs - a.updatedMs);
  return candidates[0].id;
}

export function findOpenCodeSessionForTerminal(params: {
  cwd: string;
  createdAtMs: number;
  runCommand?: OpenCodeCommandRunner;
}): string | null {
  const runCommand = params.runCommand ?? runOpenCodeCommand;
  let output: string;
  try {
    output = runCommand(["session", "list", "--format", "json", "-n", "100"]);
  } catch (err) {
    log.debug(`failed to list opencode sessions: ${String(err)}`);
    return null;
  }

  const parsed = parseJsonFromOutput(output, "[");
  if (!Array.isArray(parsed)) return null;
  return selectOpenCodeSessionForTerminal({
    cwd: params.cwd,
    createdAtMs: params.createdAtMs,
    sessions: parsed,
  });
}

function readTranscriptCwd(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(HEAD_BYTES);
    let offset = 0;
    let carry = "";
    // Scan the file in chunks until the first line carrying a top-level `cwd`
    // is found. The single fixed-8KB read this replaced returned null for the
    // many transcripts (~38% measured) that begin with a large `queue-operation`
    // / `ai-title` line so the first cwd-bearing `user` line sits past 8192 —
    // which broke the cwd fallback and left read-aloud unable to attach.
    const tryLine = (line: string): string | null => {
      if (!line.trim()) return null;
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown };
        if (typeof parsed.cwd === "string" && parsed.cwd.trim()) return parsed.cwd;
      } catch {
        // partial / non-cwd line — keep scanning
      }
      return null;
    };
    while (offset < size) {
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      if (n === 0) break;
      offset += n;
      const parts = (carry + buf.toString("utf-8", 0, n)).split(/\r?\n/);
      carry = parts.pop() ?? ""; // last element may be a partial line
      for (const line of parts) {
        const cwd = tryLine(line);
        if (cwd) return cwd;
      }
    }
    return tryLine(carry);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Locate the Codex CLI JSONL transcript most likely owned by a terminal.
 * Codex writes session logs under ~/.codex/sessions/YYYY/MM/DD/*.jsonl, with
 * a top-level `session_meta` line carrying `payload.cwd`. We use the same
 * cwd+mtime heuristic as Claude when no pre-assigned session id exists.
 */
export function findCodexTranscriptForTerminal(params: {
  cwd: string;
  createdAtMs: number;
  sessionsDir?: string;
}): string | null {
  const sessionsDir = params.sessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  const wantedCwd = path.resolve(params.cwd);
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsDir, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 5) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < params.createdAtMs - 5_000) continue;
      const cwd = readCodexTranscriptCwd(full);
      if (!cwd || path.resolve(cwd) !== wantedCwd) continue;
      candidates.push({ filePath: full, mtimeMs: stat.mtimeMs });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].filePath;
}

function readCodexTranscriptCwd(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(CODEX_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n === 0) return null;
    const text = buf.toString("utf-8", 0, n);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          payload?: { cwd?: unknown };
        };
        if (
          parsed.type === "session_meta" &&
          typeof parsed.payload?.cwd === "string" &&
          parsed.payload.cwd.trim()
        ) {
          return parsed.payload.cwd;
        }
      } catch {
        // partial line, keep going
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

/**
 * Read whatever bytes are after `fromOffset` to EOF, parse JSONL lines
 * fully, ignore the trailing partial. Returns the new offset (start of any
 * trailing partial) plus the parsed lines.
 */
function readNewLines(
  filePath: string,
  fromOffset: number,
): { newOffset: number; lines: unknown[] } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (stat.size <= fromOffset) return { newOffset: fromOffset, lines: [] };
    const len = stat.size - fromOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromOffset);
    const text = buf.toString("utf-8");
    // Last newline marks the boundary of complete lines; anything after it
    // is a partial we'll re-read on the next change event.
    const lastNL = text.lastIndexOf("\n");
    if (lastNL < 0) return { newOffset: fromOffset, lines: [] };
    const complete = text.slice(0, lastNL);
    const lines: unknown[] = [];
    for (const line of complete.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return { newOffset: fromOffset + Buffer.byteLength(complete, "utf-8") + 1, lines };
  } catch {
    return { newOffset: fromOffset, lines: [] };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

interface AssistantLine {
  type?: string;
  uuid?: string;
  /** ISO-8601 string Claude Code stamps on every transcript line. */
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  payload?: {
    type?: string;
    message?: unknown;
  };
}

function parseLineTimestamp(line: AssistantLine): number | null {
  if (typeof line.timestamp !== "string") return null;
  const ms = Date.parse(line.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function extractAssistantTexts(line: AssistantLine): string[] {
  if (line?.type === "event_msg" && line.payload?.type === "agent_message") {
    const text = line.payload.message;
    if (typeof text === "string" && text.trim()) return [text];
    return [];
  }
  if (line?.type !== "assistant") return [];
  const content = line.message?.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      const trimmed = block.text.trim();
      if (trimmed) texts.push(block.text);
    }
  }
  return texts;
}

export function startTerminalAssistantStream(params: {
  terminalId: string;
  transcriptPath: string;
  emit: AssistantTextEmitter;
  transcriptKind?: "claude" | "codex";
  /** Override how far back to look on attach. Default 30000 (30s). */
  lookbackMs?: number;
}): void {
  // Stop existing one for this terminalId, if any — caller is allowed to
  // call start twice and expect the second one to win.
  stopTerminalAssistantStream(params.terminalId);

  // Start at offset 0 — we want to be able to emit a reply that landed
  // between the user speaking and the stream attaching. Lines outside the
  // lookback window are tracked in `emittedUuids` for de-dup but stay
  // silent, so the speaker isn't flooded with the entire conversation
  // history when a stream attaches to a long-running session.
  const attachedAtMs = Date.now();
  const lookbackMs = params.lookbackMs ?? 30_000;

  const sub: FileSubscription = {
    kind: "file",
    terminalId: params.terminalId,
    transcriptPath: params.transcriptPath,
    transcriptKind: params.transcriptKind ?? "claude",
    watcher: chokidar.watch(params.transcriptPath, {
      persistent: true,
      ignoreInitial: true,
      // tight stability so we react within 50ms of a flush
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
      // On Windows (especially under OneDrive) native fs.watch drops/coalesces
      // append notifications for a file that another process (claude.exe) keeps
      // open and writes incrementally — the 'change' event never fires and
      // read-aloud is silent. Poll instead so size growth is always detected.
      usePolling: process.env.CHOKIDAR_USEPOLLING === "1" || process.platform === "win32",
      interval: 150,
      binaryInterval: 300,
    }),
    offset: 0,
    emittedUuids: new Set<string>(),
    chunkSeq: 0,
    attachedAtMs,
    lookbackMs,
  };

  const flush = () => {
    const { newOffset, lines } = readNewLines(sub.transcriptPath, sub.offset);
    sub.offset = newOffset;
    const lookbackCutoff = sub.attachedAtMs - sub.lookbackMs;
    for (const raw of lines) {
      const line = raw as AssistantLine;
      const uuid = typeof line.uuid === "string" ? line.uuid : undefined;
      // De-dupe across the rare case where chokidar fires twice for the
      // same flush — uuid is unique per assistant message line in Claude
      // Code transcripts.
      if (uuid && sub.emittedUuids.has(uuid)) continue;
      const texts = extractAssistantTexts(line);
      if (texts.length === 0) continue;
      if (uuid) sub.emittedUuids.add(uuid);

      // Lookback gate: lines older than (attachedAt - lookbackMs) are
      // tracked above for de-dup but not actually spoken. This keeps the
      // stream silent when re-attaching to a long-lived Claude Code
      // session, while still catching a reply that landed in the few
      // seconds between the user speaking and the watcher mounting.
      const lineTsMs = parseLineTimestamp(line);
      if (lineTsMs !== null && lineTsMs < lookbackCutoff) continue;

      for (const text of texts) {
        sub.chunkSeq += 1;
        params.emit({
          terminalId: sub.terminalId,
          text,
          chunkIndex: sub.chunkSeq,
          uuid,
          ts: Date.now(),
        });
      }
    }
  };

  sub.watcher.on("change", flush);
  sub.watcher.on("add", flush);
  sub.watcher.on("error", (err) => {
    log.warn(`watcher error on ${params.transcriptPath}: ${String(err)}`);
  });

  subscriptions.set(params.terminalId, sub);
  // Emit any reply already on disk within the lookback window right now.
  // ignoreInitial suppresses the initial 'add' event, so a finished turn whose
  // reply landed BEFORE this watcher attached (the common case — the UI poll
  // loop attaches after Claude has already responded) would otherwise never be
  // spoken because no further write fires a 'change'. flush() is idempotent
  // (offset advances, emittedUuids de-dups), so a later event won't double-emit.
  flush();
  log.info(
    `streaming ${sub.transcriptKind} assistant text for ${params.terminalId} ← ${params.transcriptPath}`,
  );
}

interface OpenCodeAssistantTextPart {
  id: string;
  text: string;
  timestampMs: number | null;
}

function openCodeMessageTime(info: Record<string, unknown>): {
  createdMs: number | null;
  completedMs: number | null;
  hasTime: boolean;
} {
  const time = isRecord(info.time) ? info.time : null;
  if (!time) return { createdMs: null, completedMs: null, hasTime: false };
  return {
    createdMs: asNumber(time.created),
    completedMs: asNumber(time.completed),
    hasTime: true,
  };
}

function openCodePartTime(part: Record<string, unknown>): number | null {
  const time = isRecord(part.time) ? part.time : null;
  if (!time) return null;
  return asNumber(time.end) ?? asNumber(time.start);
}

export function extractOpenCodeAssistantTextParts(params: {
  exportData: unknown;
  emittedPartIds: Set<string>;
  attachedAtMs?: number;
  lookbackMs?: number;
  completedOnly?: boolean;
}): OpenCodeAssistantTextPart[] {
  if (!isRecord(params.exportData) || !Array.isArray(params.exportData.messages)) return [];

  const completedOnly = params.completedOnly ?? true;
  const lookbackCutoff =
    typeof params.attachedAtMs === "number"
      ? params.attachedAtMs - (params.lookbackMs ?? 30_000)
      : null;
  const out: OpenCodeAssistantTextPart[] = [];

  params.exportData.messages.forEach((rawMessage, messageIndex) => {
    if (!isRecord(rawMessage)) return;
    const info = isRecord(rawMessage.info) ? rawMessage.info : {};
    if (info.role !== "assistant") return;

    const { createdMs, completedMs, hasTime } = openCodeMessageTime(info);
    // OpenCode mutates the assistant text part while a turn is in progress.
    // Waiting for completion avoids speaking partial prefixes and then
    // missing the final suffix because the part id stayed the same.
    if (completedOnly && hasTime && completedMs === null) return;

    const messageId =
      typeof info.id === "string" && info.id
        ? info.id
        : `opencode-message-${messageIndex.toString(10)}`;
    const messageTsMs = completedMs ?? createdMs;
    const parts = Array.isArray(rawMessage.parts) ? rawMessage.parts : [];

    parts.forEach((rawPart, partIndex) => {
      if (!isRecord(rawPart)) return;
      if (rawPart.type !== "text" || typeof rawPart.text !== "string" || !rawPart.text.trim()) {
        return;
      }
      const partId =
        typeof rawPart.id === "string" && rawPart.id
          ? rawPart.id
          : `${messageId}:part:${partIndex.toString(10)}`;
      if (params.emittedPartIds.has(partId)) return;
      const timestampMs = openCodePartTime(rawPart) ?? messageTsMs;
      params.emittedPartIds.add(partId);

      if (lookbackCutoff !== null && timestampMs !== null && timestampMs < lookbackCutoff) {
        return;
      }

      out.push({ id: partId, text: rawPart.text, timestampMs });
    });
  });

  return out;
}

export function startTerminalOpenCodeAssistantStream(params: {
  terminalId: string;
  sessionId: string;
  emit: AssistantTextEmitter;
  exportSession?: (sessionId: string) => string;
  /** Override how far back to look on attach. Default 30000 (30s). */
  lookbackMs?: number;
  pollIntervalMs?: number;
}): void {
  stopTerminalAssistantStream(params.terminalId);

  const sub: OpenCodeSubscription = {
    kind: "opencode",
    terminalId: params.terminalId,
    sessionId: params.sessionId,
    pollTimer: null,
    stopped: false,
    emittedPartIds: new Set<string>(),
    chunkSeq: 0,
    attachedAtMs: Date.now(),
    lookbackMs: params.lookbackMs ?? 30_000,
    pollIntervalMs: params.pollIntervalMs ?? OPENCODE_POLL_INTERVAL_MS,
    exportSession:
      params.exportSession ?? ((sessionId) => runOpenCodeCommand(["export", sessionId])),
    emit: params.emit,
  };

  const poll = () => {
    if (sub.stopped) return;
    try {
      const output = sub.exportSession(sub.sessionId);
      const parsed = parseJsonFromOutput(output, "{");
      if (parsed) {
        const parts = extractOpenCodeAssistantTextParts({
          exportData: parsed,
          emittedPartIds: sub.emittedPartIds,
          attachedAtMs: sub.attachedAtMs,
          lookbackMs: sub.lookbackMs,
        });
        for (const part of parts) {
          sub.chunkSeq += 1;
          sub.emit({
            terminalId: sub.terminalId,
            text: part.text,
            chunkIndex: sub.chunkSeq,
            uuid: part.id,
            ts: Date.now(),
          });
        }
      }
    } catch (err) {
      log.debug(`failed to export opencode session ${sub.sessionId}: ${String(err)}`);
    } finally {
      if (!sub.stopped) sub.pollTimer = setTimeout(poll, sub.pollIntervalMs);
    }
  };

  subscriptions.set(params.terminalId, sub);
  poll();
  log.info(`streaming opencode assistant text via session export for ${params.terminalId}`);
}

// ── PTY-tap path (generic non-transcript CLI fallback) ───────────────────
// Subscribe to the terminal's raw PTY stream (the same bytes the user sees
// in xterm), strip ANSI/control chars, line-buffer, and emit completed
// lines that look like spoken-assistant prose (not TUI chrome, prompts,
// spinners, or diff hunks). Heuristic — gives the user voice playback at
// the cost of occasionally speaking framing text.

/* eslint-disable no-control-regex -- ANSI parsing intentionally matches terminal control bytes. */
const ANSI_ESCAPE_PATTERNS = [
  /\x1b\[[?!>]?[0-9;]*[a-zA-Z]/g,
  /\x1b\][^\x07]*(?:\x07|\x1b\\)/g,
  /\x1bP[^\x1b]*\x1b\\/g,
  /\x1b[=>ABCDEFGHIJKLMNOPQRSTUVWXYZ\\^_`abcdefghijklmnopqrstuvwxyz{|}~]/g,
  /\x1b[_X^][^\x1b]*\x1b\\/g,
];
/* eslint-enable no-control-regex */

function stripAnsi(s: string): string {
  let out = s;
  for (const p of ANSI_ESCAPE_PATTERNS) out = out.replace(p, "");
  // Bell + backspace + carriage return (xterm uses \r to redraw current row;
  // collapse to nothing so single physical lines don't fragment into many
  // logical ones when we split on \n below).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return out;
}

// Box-drawing / horizontal-rule characters that OpenCode (and similar TUIs)
// wrap content in. We strip them from line edges rather than dropping whole
// lines, since the speakable prose usually lives INSIDE the box.
const BOX_EDGE_REGEX =
  /^[\s│┃┆┇┊┋╎╏║╭╮╯╰┌┐└┘├┤┬┴┼─━┄┅═╔╗╚╝╠╣╦╩╬]+|[\s│┃┆┇┊┋╎╏║╭╮╯╰┌┐└┘├┤┬┴┼─━┄┅═╔╗╚╝╠╣╦╩╬]+$/g;

// Lines that are nothing but rule / box characters — never speak these.
const PURE_BOX_REGEX = /^[│┃┆┇┊┋╎╏║╭╮╯╰┌┐└┘├┤┬┴┼─━┄┅═╔╗╚╝╠╣╦╩╬\s]+$/;

const SKIP_LINE_PREFIXES = [
  "❯", // shell / REPL prompts
  "?",
];

const SKIP_LINE_EXACT = new Set(["[K", "[2K", "[1A", "[H", "[2J"]);

const SPINNER_GLYPH_REGEX = /^[\s◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⏳⌛◇◆●○]+$/;

/**
 * Reduce a raw line to its speakable core. Returns null if nothing
 * speakable is left. Strips leading/trailing box-drawing chrome so that
 * `│ hello │` becomes `hello`.
 */
function speakableText(line: string, cliType = "unknown"): string | null {
  const t = line.trim();
  if (!t) return null;
  if (SKIP_LINE_EXACT.has(t)) return null;
  if (SPINNER_GLYPH_REGEX.test(t)) return null;
  if (PURE_BOX_REGEX.test(t)) return null;

  const stripped = t.replace(BOX_EDGE_REGEX, "").trim();
  if (!stripped) return null;
  if (stripped.length < 2) return null;
  for (const p of SKIP_LINE_PREFIXES) {
    if (stripped.startsWith(p)) return null;
  }
  // Prompt-only lines (e.g. "> " with nothing after) are still dropped,
  // but blockquote content like "> Here is the fix" passes through.
  if (/^>\s*$/.test(stripped)) return null;
  // Diff hunk lines would speak whole files — skip.
  // Require non-whitespace after -/+ so bullet lists ("- text") pass through
  // for CLIs like OpenCode that use the dash prefix for lists.
  if (/^[-+]\S/.test(stripped) && stripped.length < 120) return null;
  // No alphanumeric content → ASCII art / dividers.
  if (!/[A-Za-z0-9]/.test(stripped)) return null;
  if (isCliChromeLine(stripped, cliType)) return null;
  // Diff hunk markers
  if (/^@@.+@@/.test(stripped)) return null;
  // File-path with line:col, e.g. "src/foo.ts:42:5" alone
  if (/^[\w./-]+:\d+(:\d+)?$/.test(stripped)) return null;
  return stripped;
}

function isCliChromeLine(line: string, cliType: string): boolean {
  const lower = line.toLowerCase();
  if (/^(esc|ctrl\+|shift\+|tab\b|enter\b|press\b)/.test(lower)) return true;
  if (
    /^(thinking|working|running|loading|connecting|searching|reading|writing)[. …]*$/.test(lower)
  ) {
    return true;
  }
  if (/^(tokens?|cost|model|session|agent)\b/.test(lower) && line.length < 120) return true;

  if (cliType === "opencode") {
    if (/^opencode\b/.test(lower)) return true;
    if (/^(bash|read|write|edit|grep|glob|list|todo|task)\b/.test(lower) && line.length < 100) {
      return true;
    }
    if (/^(added|modified|deleted|created|updated)\s+[\w./-]+/.test(lower)) return true;
  }

  if (cliType === "codex") {
    if (/^(codex|workdir|approval|sandbox)\b/.test(lower) && line.length < 120) return true;
    if (/^(exec|apply_patch|tool|command|output|exit code)\b/.test(lower) && line.length < 120) {
      return true;
    }
  }

  return false;
}

const RECENT_LINE_TTL_MS = 8_000;
const RECENT_INPUT_ECHO_TTL_MS = 2_000;
const RECENT_LINE_MAX = 64;
const PTY_IDLE_FLUSH_MS = 500;

function isRecentDuplicate(sub: PtySubscription, line: string, nowMs: number): boolean {
  // Cheap GC of stale entries; cap by size too.
  if (sub.recentLines.size > RECENT_LINE_MAX) {
    for (const [k, ts] of sub.recentLines) {
      if (nowMs - ts > RECENT_LINE_TTL_MS) sub.recentLines.delete(k);
    }
  }
  const last = sub.recentLines.get(line);
  if (last !== undefined && nowMs - last < RECENT_LINE_TTL_MS) return true;
  sub.recentLines.set(line, nowMs);
  return false;
}

function normalizePtyLine(s: string): string | null {
  const cleaned = stripAnsi(s).replace(/\r/g, "");
  const trimmed = cleaned.trim();
  return trimmed || null;
}

function recordRecentInput(sub: PtySubscription, data: string, nowMs: number): void {
  const normalized = normalizePtyLine(data);
  if (!normalized) return;

  for (const piece of normalized.split(/\n+/)) {
    const line = piece.trim();
    if (!line) continue;
    sub.recentInputs.set(line, nowMs);
  }

  if (sub.recentInputs.size > RECENT_LINE_MAX) {
    for (const [k, ts] of sub.recentInputs) {
      if (nowMs - ts > RECENT_INPUT_ECHO_TTL_MS) sub.recentInputs.delete(k);
    }
  }
}

function isRecentInputEcho(sub: PtySubscription, line: string, nowMs: number): boolean {
  if (sub.recentInputs.size > RECENT_LINE_MAX) {
    for (const [k, ts] of sub.recentInputs) {
      if (nowMs - ts > RECENT_INPUT_ECHO_TTL_MS) sub.recentInputs.delete(k);
    }
  }
  const last = sub.recentInputs.get(line);
  return last !== undefined && nowMs - last < RECENT_INPUT_ECHO_TTL_MS;
}

function splitPtyChunk(sub: PtySubscription, clean: string): string[] {
  sub.lineBuffer += clean;
  const lines: string[] = [];
  const separator = sub.cliType === "opencode" ? /\r\n|\n|\r/g : /\r?\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(sub.lineBuffer)) !== null) {
    lines.push(sub.lineBuffer.slice(start, match.index));
    start = match.index + match[0].length;
  }
  sub.lineBuffer = sub.lineBuffer.slice(start);
  return lines;
}

function emitPtyLine(
  sub: PtySubscription,
  line: string,
  nowMs: number,
  emit: AssistantTextEmitter,
): void {
  if (isRecentInputEcho(sub, line, nowMs)) return;
  const spoken = speakableText(line, sub.cliType);
  if (!spoken) return;
  if (isRecentDuplicate(sub, spoken, nowMs)) return;
  sub.chunkSeq += 1;
  emit({
    terminalId: sub.terminalId,
    text: spoken,
    chunkIndex: sub.chunkSeq,
    ts: nowMs,
  });
}

function clearPtyIdleFlush(sub: PtySubscription): void {
  if (sub.idleFlushTimer === null) return;
  clearTimeout(sub.idleFlushTimer);
  sub.idleFlushTimer = null;
}

// How long Claude's TUI must be quiet before we treat the on-screen reply as
// final. Claude streams + repaints the `●` line as it generates; waiting for a
// pause means we speak the COMPLETE reply once instead of word-by-word.
const CLAUDE_IDLE_MS = 900;
const CLAUDE_RAW_BUFFER_MAX = 32_768;
// Claude marks assistant replies with a leading ● bullet. Tool calls use the
// same bullet but look like `● Bash(…)` / `● Read(…)` — speak prose, not those.
const CLAUDE_TOOLCALL_REGEX = /^[A-Z][A-Za-z0-9_]*\([^)]*\)/;
// Whimsical spinner/status verbs Claude appends while working — never speak.
const CLAUDE_STATUS_TAIL_REGEX =
  /\s*[·•]\s*(Sketching|Levitating|Baked|Baking|Worked|Working|Churned|Churning|Cogitating|Thinking|Pondering|Brewing|Conjuring|Computing|Reticulating|Simmering|Noodling|Percolating|Marinating|Vibing|Forging|Crafting)\b[\s\S]*$/i;

/**
 * Snapshot Claude's full-screen TUI buffer and pull out the newest assistant
 * reply — the last `●`-prefixed block before the input prompt — as clean,
 * speakable text. Returns null when there's nothing new/speakable.
 */
function extractLatestClaudeReply(rawBuffer: string): string | null {
  // Claude's full-screen TUI uses cursor positioning, so once ANSI is stripped
  // the whole screen collapses with no reliable line breaks (verified: the reply
  // ends up jammed next to the footer + spinner on one row). Splitting on the
  // \u25cf assistant bullet itself is far more robust than line parsing. Keep
  // spaces \u2014 they're real reply words \u2014 and scan segments newest-first.
  const text = stripAnsi(rawBuffer).replace(/\r/g, "");
  const segs = text.split("\u25cf");
  for (let i = segs.length - 1; i >= 1; i--) {
    let s = segs[i];
    // Cut at the first structural boundary after the reply: newline, the input
    // prompt, a box/rule run, or the footer hint row.
    s = s.split(
      /\n|\u276f|[\u2500-\u257f]{2,}|\?\s*for\s*shortcuts|esc\s*to\s*interrupt|for\s*agents/i,
    )[0];
    // Strip a spinner/status the TUI jams onto the reply row.
    s = s
      .replace(CLAUDE_STATUS_TAIL_REGEX, "")
      .replace(
        /\s*[\u00b7\u2022*]\s*[^\u00b7\u2022*]*?(?:\u2026|for\s+\d+\s*s|tokens?)\b[\s\S]*$/i,
        "",
      )
      .replace(/\s*[\u00b7\u2022*]\s*\/?\w+\s*$/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!s) continue;
    // Skip the model/effort footer ("high \u00b7 /effort", "/model", etc.).
    if (/\/(effort|model|clear|help|compact|resume|agents)\b/i.test(s)) continue;
    if (/^(high|medium|low|max|default)\b/i.test(s) && s.length < 16) continue;
    if (CLAUDE_TOOLCALL_REGEX.test(s)) continue; // tool invocation, not prose
    if (s.length < 3) continue;
    if (!/[A-Za-z]/.test(s)) continue;
    return s;
  }
  return null;
}

/**
 * Claude path for the PTY tap. Accumulates raw output and, once the screen has
 * been idle for CLAUDE_IDLE_MS, speaks the newest `●` reply if it's changed.
 */
function handleClaudeChunk(sub: PtySubscription, raw: string, emit: AssistantTextEmitter): void {
  sub.claudeRawBuffer = ((sub.claudeRawBuffer ?? "") + raw).slice(-CLAUDE_RAW_BUFFER_MAX);
  clearPtyIdleFlush(sub);
  sub.idleFlushTimer = setTimeout(() => {
    sub.idleFlushTimer = null;
    const reply = extractLatestClaudeReply(sub.claudeRawBuffer ?? "");
    if (!reply || reply === sub.claudeLastSpoken) return;
    sub.claudeLastSpoken = reply;
    sub.chunkSeq += 1;
    emit({ terminalId: sub.terminalId, text: reply, chunkIndex: sub.chunkSeq, ts: Date.now() });
  }, CLAUDE_IDLE_MS);
}

/**
 * Start tapping a terminal's PTY output and emit speakable lines as
 * assistant.text.delta events. Use this for any backend that doesn't write
 * a disk transcript (OpenCode, Codex, future CLIs). Returns when the
 * subscription is registered — actual emissions are async.
 *
 * `subscribePtyOutput(terminalId, cb) → unsubscribe` is exposed by
 * TerminalManager (src/terminal/manager.ts).
 */
export function startTerminalPtyAssistantStream(params: {
  terminalId: string;
  cliType: string;
  subscribePtyOutput: (terminalId: string, cb: (data: string) => void) => () => void;
  subscribePtyInput?: (terminalId: string, cb: (data: string) => void) => () => void;
  emit: AssistantTextEmitter;
}): void {
  stopTerminalAssistantStream(params.terminalId);

  const sub: PtySubscription = {
    kind: "pty",
    terminalId: params.terminalId,
    cliType: params.cliType,
    unsubscribe: () => undefined,
    chunkSeq: 0,
    lineBuffer: "",
    recentLines: new Map<string, number>(),
    recentInputs: new Map<string, number>(),
    idleFlushTimer: null,
  };

  const handleInput = (raw: string) => {
    recordRecentInput(sub, raw, Date.now());
  };

  const handleChunk = (raw: string) => {
    // Claude paints a full-screen TUI rather than emitting append-only lines —
    // the line-based path below would speak redraw fragments and spinner soup.
    // Route it to the snapshot-on-idle extractor instead.
    if (sub.cliType === "claude") {
      handleClaudeChunk(sub, raw, params.emit);
      return;
    }
    const clean = stripAnsi(raw);
    if (!clean) return;
    clearPtyIdleFlush(sub);
    const parts = splitPtyChunk(sub, clean);
    const nowMs = Date.now();
    for (const line of parts) {
      emitPtyLine(sub, line, nowMs, params.emit);
    }

    if (sub.cliType === "opencode" && sub.lineBuffer.trim()) {
      sub.idleFlushTimer = setTimeout(() => {
        sub.idleFlushTimer = null;
        const line = sub.lineBuffer;
        sub.lineBuffer = "";
        emitPtyLine(sub, line, Date.now(), params.emit);
      }, PTY_IDLE_FLUSH_MS);
    }
  };

  sub.unsubscribe = params.subscribePtyOutput(params.terminalId, handleChunk);
  const unsubscribeInput = params.subscribePtyInput?.(params.terminalId, handleInput);
  const originalUnsubscribe = sub.unsubscribe;
  sub.unsubscribe = () => {
    try {
      clearPtyIdleFlush(sub);
      originalUnsubscribe();
    } finally {
      unsubscribeInput?.();
    }
  };
  subscriptions.set(params.terminalId, sub);
  log.info(`streaming assistant text via PTY tap for ${params.terminalId} (cli=${params.cliType})`);
}

export function stopTerminalAssistantStream(terminalId: string): void {
  const sub = subscriptions.get(terminalId);
  if (!sub) return;
  if (sub.kind === "file") {
    void sub.watcher.close().catch(() => undefined);
  } else if (sub.kind === "opencode") {
    sub.stopped = true;
    if (sub.pollTimer !== null) {
      clearTimeout(sub.pollTimer);
      sub.pollTimer = null;
    }
  } else {
    try {
      sub.unsubscribe();
    } catch {
      /* ignore */
    }
  }
  subscriptions.delete(terminalId);
  log.info(`stopped assistant text stream for ${terminalId}`);
}

export function stopAllForTest(): void {
  for (const id of subscriptions.keys()) stopTerminalAssistantStream(id);
}
