import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { stripEnvelope } from "./chat-sanitize.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messages.push(parsed.message);
      }
    } catch {
      // ignore bad lines
    }
  }
  return messages;
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string[] {
  const candidates: string[] = [];
  if (sessionFile) candidates.push(sessionFile);
  if (storePath) {
    const dir = path.dirname(storePath);
    candidates.push(path.join(dir, `${sessionId}.jsonl`));
  }
  if (agentId) {
    candidates.push(resolveSessionTranscriptPath(sessionId, agentId));
  }
  candidates.push(path.join(os.homedir(), ".infinibot", "sessions", `${sessionId}.jsonl`));
  return candidates;
}

export function archiveFileOnDisk(filePath: string, reason: string): string {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
  return archived;
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) return { items, bytes: 2 };
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

const MAX_LINES_TO_SCAN = 10;

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
};

function extractTextFromContent(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part.text !== "string") continue;
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const trimmed = part.text.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) return null;
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptMessage | undefined;
        if (msg?.role === "user") {
          const text = extractTextFromContent(msg.content);
          if (text) return text;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file read error
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

const LAST_MSG_MAX_BYTES = 16384;
const LAST_MSG_MAX_LINES = 20;

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) return null;

    const readStart = Math.max(0, size - LAST_MSG_MAX_BYTES);
    const readLen = Math.min(size, LAST_MSG_MAX_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-LAST_MSG_MAX_LINES);

    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptMessage | undefined;
        if (msg?.role === "user" || msg?.role === "assistant") {
          const text = extractTextFromContent(msg.content);
          if (text) return text;
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // file error
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

const PREVIEW_READ_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024];
const PREVIEW_MAX_LINES = 200;

type TranscriptContentEntry = {
  type?: string;
  text?: string;
  name?: string;
  /** tool_use blocks carry the model's call arguments here. */
  input?: unknown;
  /** tool_result blocks carry either a plain string or a list of text parts. */
  content?: string | TranscriptContentEntry[];
};

type TranscriptPreviewMessage = {
  role?: string;
  content?: string | TranscriptContentEntry[];
  text?: string;
  toolName?: string;
  tool_name?: string;
};

function normalizeRole(role: string | undefined, isTool: boolean): SessionPreviewItem["role"] {
  if (isTool) return "tool";
  switch ((role ?? "").toLowerCase()) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "other";
  }
}

function truncatePreviewText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

function extractPreviewText(message: TranscriptPreviewMessage): string | null {
  if (typeof message.content === "string") {
    const trimmed = message.content.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter((text) => text.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  if (typeof message.text === "string") {
    const trimmed = message.text.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function isToolCall(message: TranscriptPreviewMessage): boolean {
  if (message.toolName || message.tool_name) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((entry) => {
    if (entry?.name) return true;
    const raw = typeof entry?.type === "string" ? entry.type.toLowerCase() : "";
    return raw === "toolcall" || raw === "tool_call";
  });
}

function extractToolNames(message: TranscriptPreviewMessage): string[] {
  const names: string[] = [];
  if (Array.isArray(message.content)) {
    for (const entry of message.content) {
      if (typeof entry?.name === "string" && entry.name.trim()) {
        names.push(entry.name.trim());
      }
    }
  }
  const toolName = typeof message.toolName === "string" ? message.toolName : message.tool_name;
  if (typeof toolName === "string" && toolName.trim()) {
    names.push(toolName.trim());
  }
  return names;
}

function extractMediaSummary(message: TranscriptPreviewMessage): string | null {
  if (!Array.isArray(message.content)) return null;
  for (const entry of message.content) {
    const raw = typeof entry?.type === "string" ? entry.type.trim().toLowerCase() : "";
    if (!raw || raw === "text" || raw === "toolcall" || raw === "tool_call") continue;
    return `[${raw}]`;
  }
  return null;
}

/**
 * Pull the readable text out of a `tool_result` block. Claude's transcripts
 * put the result either as a plain string under `entry.content`, or as an
 * array of `{ type: "text", text }` parts (rich content / image results).
 */
function extractToolResultText(entry: TranscriptContentEntry): string {
  if (typeof entry.content === "string") return entry.content;
  if (Array.isArray(entry.content)) {
    return entry.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return "";
}

/**
 * Format a `tool_use` block as a single line the activity feed can detect.
 * The client's `previewItemsToSteps` watches for the "⚡ " prefix to classify
 * an item as a tool_call, with the second token taken as the tool name and
 * the trailing string as the arguments JSON.
 */
function formatToolUseText(entry: TranscriptContentEntry, maxChars: number): string {
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "tool";
  const head = `⚡ ${name}`;
  if (entry.input === undefined) return head;
  let serialized = "";
  try {
    serialized = typeof entry.input === "string" ? entry.input : JSON.stringify(entry.input);
  } catch {
    serialized = String(entry.input);
  }
  serialized = serialized.trim();
  if (!serialized) return head;
  const room = Math.max(0, maxChars - head.length - 1);
  if (room <= 0) return head;
  if (serialized.length > room) serialized = serialized.slice(0, room);
  return `${head} ${serialized}`;
}

/**
 * Walk a message whose `content` is an array of blocks (Claude's standard
 * transcript shape) and emit one preview item per significant block:
 *   • text part → role-preserving text item
 *   • tool_use → role:"assistant", text:"⚡ <name> <argsJSON>"
 *   • tool_result → role:"tool", text:"<full result text>"
 * Returns [] for messages that don't contain any tool blocks — the caller
 * falls back to the legacy collapsed-to-one-item logic in that case so the
 * existing "call <toolname>" preview format keeps working.
 */
function expandStructuredContent(
  message: TranscriptPreviewMessage,
  maxChars: number,
): SessionPreviewItem[] {
  if (!Array.isArray(message.content)) return [];
  const blocks = message.content;
  const hasToolBlock = blocks.some((entry) => {
    const t = typeof entry?.type === "string" ? entry.type.toLowerCase() : "";
    return t === "tool_use" || t === "tool_result";
  });
  if (!hasToolBlock) return [];

  const baseRole = normalizeRole(message.role, false);
  const out: SessionPreviewItem[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length === 0) return;
    let combined = textBuf.join("\n").trim();
    textBuf = [];
    if (!combined) return;
    if (baseRole === "user") combined = stripEnvelope(combined);
    combined = truncatePreviewText(combined, maxChars);
    out.push({ role: baseRole, text: combined });
  };

  for (const entry of blocks) {
    const entryType = typeof entry?.type === "string" ? entry.type.toLowerCase() : "";
    if (entryType === "tool_use") {
      flushText();
      out.push({
        role: "assistant",
        text: truncatePreviewText(formatToolUseText(entry, maxChars), maxChars),
      });
      continue;
    }
    if (entryType === "tool_result") {
      flushText();
      const raw = extractToolResultText(entry).trim();
      const text = raw || "[tool_result]";
      out.push({ role: "tool", text: truncatePreviewText(text, maxChars) });
      continue;
    }
    if (typeof entry?.text === "string" && entry.text.trim()) {
      textBuf.push(entry.text);
    }
  }
  flushText();
  return out;
}

function buildPreviewItems(
  messages: TranscriptPreviewMessage[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    // Try the structured path first — Claude transcripts encode tool calls
    // and results as separate content blocks that should each surface as
    // their own activity row.
    const expanded = expandStructuredContent(message, maxChars);
    if (expanded.length > 0) {
      items.push(...expanded);
      continue;
    }

    const toolCall = isToolCall(message);
    const role = normalizeRole(message.role, toolCall);
    let text = extractPreviewText(message);
    if (!text) {
      const toolNames = extractToolNames(message);
      if (toolNames.length > 0) {
        const shown = toolNames.slice(0, 2);
        const overflow = toolNames.length - shown.length;
        text = `call ${shown.join(", ")}`;
        if (overflow > 0) text += ` +${overflow}`;
      }
    }
    if (!text) {
      text = extractMediaSummary(message);
    }
    if (!text) continue;
    let trimmed = text.trim();
    if (!trimmed) continue;
    if (role === "user") {
      trimmed = stripEnvelope(trimmed);
    }
    trimmed = truncatePreviewText(trimmed, maxChars);
    items.push({ role, text: trimmed });
  }

  if (items.length <= maxItems) return items;
  return items.slice(-maxItems);
}

function readRecentMessagesFromTranscript(
  filePath: string,
  maxMessages: number,
  readBytes: number,
): TranscriptPreviewMessage[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) return [];

    const readStart = Math.max(0, size - readBytes);
    const readLen = Math.min(size, readBytes);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-PREVIEW_MAX_LINES);

    const collected: TranscriptPreviewMessage[] = [];
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message as TranscriptPreviewMessage | undefined;
        if (msg && typeof msg === "object") {
          collected.push(msg);
          if (collected.length >= maxMessages) break;
        }
      } catch {
        // skip malformed lines
      }
    }
    return collected.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readSessionPreviewItemsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return [];

  // Caps used to be 50 / 2000 — too tight for Claude Coder runs whose
  // activity feed surfaces every tool call. Raised so a Coder session's full
  // action stream survives the round trip without being silently truncated.
  const boundedItems = Math.max(1, Math.min(maxItems, 200));
  const boundedChars = Math.max(20, Math.min(maxChars, 8000));

  for (const readSize of PREVIEW_READ_SIZES) {
    const messages = readRecentMessagesFromTranscript(filePath, boundedItems, readSize);
    if (messages.length > 0 || readSize === PREVIEW_READ_SIZES[PREVIEW_READ_SIZES.length - 1]) {
      return buildPreviewItems(messages, boundedItems, boundedChars);
    }
  }

  return [];
}
