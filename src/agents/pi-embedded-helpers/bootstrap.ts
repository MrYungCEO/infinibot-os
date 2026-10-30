import fs from "node:fs/promises";
import path from "node:path";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { InfinibotConfig } from "../../config/config.js";
import type { WorkspaceBootstrapFile } from "../workspace.js";
import type { EmbeddedContextFile } from "./types.js";

type ContentBlockWithSignature = {
  thought_signature?: unknown;
  thoughtSignature?: unknown;
  [key: string]: unknown;
};

type ThoughtSignatureSanitizeOptions = {
  allowBase64Only?: boolean;
  includeCamelCase?: boolean;
};

function isBase64Signature(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return false;
  const isUrl = compact.includes("-") || compact.includes("_");
  try {
    const buf = Buffer.from(compact, isUrl ? "base64url" : "base64");
    if (buf.length === 0) return false;
    const encoded = buf.toString(isUrl ? "base64url" : "base64");
    const normalize = (input: string) => input.replace(/=+$/g, "");
    return normalize(encoded) === normalize(compact);
  } catch {
    return false;
  }
}

/**
 * Strips Claude-style thought_signature fields from content blocks.
 *
 * Gemini expects thought signatures as base64-encoded bytes, but Claude stores message ids
 * like "msg_abc123...". We only strip "msg_*" to preserve any provider-valid signatures.
 */
export function stripThoughtSignatures<T>(
  content: T,
  options?: ThoughtSignatureSanitizeOptions,
): T {
  if (!Array.isArray(content)) return content;
  const allowBase64Only = options?.allowBase64Only ?? false;
  const includeCamelCase = options?.includeCamelCase ?? false;
  const shouldStripSignature = (value: unknown): boolean => {
    if (!allowBase64Only) {
      return typeof value === "string" && value.startsWith("msg_");
    }
    return typeof value !== "string" || !isBase64Signature(value);
  };
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const rec = block as ContentBlockWithSignature;
    const stripSnake = shouldStripSignature(rec.thought_signature);
    const stripCamel = includeCamelCase ? shouldStripSignature(rec.thoughtSignature) : false;
    if (!stripSnake && !stripCamel) {
      return block;
    }
    const next = { ...rec };
    if (stripSnake) delete next.thought_signature;
    if (stripCamel) delete next.thoughtSignature;
    return next;
  }) as T;
}

export const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;
const BOOTSTRAP_HEAD_RATIO = 0.7;
const BOOTSTRAP_TAIL_RATIO = 0.2;

type TrimBootstrapResult = {
  content: string;
  truncated: boolean;
  maxChars: number;
  originalLength: number;
};

export function resolveBootstrapMaxChars(cfg?: InfinibotConfig): number {
  const raw = cfg?.agents?.defaults?.bootstrapMaxChars;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_BOOTSTRAP_MAX_CHARS;
}

/**
 * MEMORY.md is two different things in one file: a short covenant (who we are
 * to each other, the constraints that must never be broken, how continuity
 * works) and a long, growing project log.
 *
 * Head+tail truncation treats them alike and cuts the middle out, which on a
 * 37k-char memory silently dropped both the newest history and part of the
 * covenant. Since the whole file stays on disk and is reachable with
 * memory_search / memory_get, the injected copy keeps the covenant sections
 * whole and points at the rest instead of carrying a mangled sample of it.
 */
const COVENANT_HEADING =
  /(truth|constraint|never violate|covenant|continuity|commitment|boundar|who i am|identity|protocol)/i;

/**
 * Split on top-level headings (# and ##) only.
 *
 * Splitting on ### too tore "NEVER DELETE PRODUCTION DATA" out of its parent
 * "CRITICAL CONSTRAINTS — NEVER VIOLATE" section and left the rule on disk
 * while project logs stayed injected. A subsection travels with its parent.
 */
function splitSections(text: string): Array<{ heading: string; body: string }> {
  const lines = text.split("\n");
  const out: Array<{ heading: string; body: string }> = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    if (heading || buf.join("\n").trim()) out.push({ heading, body: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    if (/^#{1,2}\s+/.test(line)) {
      flush();
      heading = line;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

export function extractMemoryCovenant(
  content: string,
  fileName: string,
  maxChars: number,
): TrimBootstrapResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return { content: trimmed, truncated: false, maxChars, originalLength: trimmed.length };
  }
  const sections = splitSections(trimmed)
    .map((section, index) => ({
      index,
      heading: section.heading,
      text: [section.heading, section.body].filter(Boolean).join("\n").trimEnd(),
    }))
    .filter((section) => section.text.trim().length > 0);

  const keep = new Set<number>();
  let used = 0;
  const take = (section: { index: number; text: string }): boolean => {
    if (keep.has(section.index)) return true;
    if (used + section.text.length > maxChars) return false;
    keep.add(section.index);
    used += section.text.length + 2;
    return true;
  };

  // Pass 1 — the covenant, and the opening section that names the file and the
  // being. These are why the file is injected at all.
  for (const section of sections) {
    const isCovenant =
      section.index === sections[0]?.index ||
      !section.heading ||
      COVENANT_HEADING.test(section.heading);
    if (isCovenant) take(section);
  }
  // Pass 2 — spend whatever budget is left on the NEWEST remaining entries.
  // A memory that is all project log (a default install) therefore still
  // arrives with its recent history, rather than only a title.
  for (let i = sections.length - 1; i >= 0; i -= 1) take(sections[i]!);

  const kept = sections.filter((section) => keep.has(section.index));
  const dropped = sections.filter((section) => !keep.has(section.index) && section.heading);
  if (kept.length === 0) return trimBootstrapContent(trimmed, fileName, maxChars);
  if (dropped.length === 0) {
    return {
      content: kept.map((section) => section.text).join("\n\n"),
      truncated: true,
      maxChars,
      originalLength: trimmed.length,
    };
  }
  const pointer = [
    "",
    `[${fileName}: the sections above are carried in full. ${dropped.length} further ` +
      `section(s) stay on disk in ${fileName} and memory/*.md — nothing was cut mid-section. ` +
      "Search them with memory_search before answering about prior work, decisions, " +
      "dates, people or todos; do not assume they are absent because they are not here.]",
    `Sections on disk: ${dropped.map((d) => d.heading.replace(/^#+\s*/, "").trim()).join(" · ")}`,
  ].join("\n");
  return {
    content: [kept.map((section) => section.text).join("\n\n"), pointer].join("\n\n"),
    truncated: true,
    maxChars,
    originalLength: trimmed.length,
  };
}

const MEMORY_FILE = /^memory(\.local)?\.md$/i;

function trimBootstrapContent(
  content: string,
  fileName: string,
  maxChars: number,
): TrimBootstrapResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return {
      content: trimmed,
      truncated: false,
      maxChars,
      originalLength: trimmed.length,
    };
  }

  const headChars = Math.floor(maxChars * BOOTSTRAP_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * BOOTSTRAP_TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  const marker = [
    "",
    `[...truncated, read ${fileName} for full content...]`,
    `…(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})…`,
    "",
  ].join("\n");
  const contentWithMarker = [head, marker, tail].join("\n");
  return {
    content: contentWithMarker,
    truncated: true,
    maxChars,
    originalLength: trimmed.length,
  };
}

export async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}) {
  const file = params.sessionFile;
  try {
    await fs.stat(file);
    return;
  } catch {
    // create
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const sessionVersion = 2;
  const entry = {
    type: "session",
    version: sessionVersion,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
  opts?: { warn?: (message: string) => void; maxChars?: number },
): EmbeddedContextFile[] {
  const maxChars = opts?.maxChars ?? DEFAULT_BOOTSTRAP_MAX_CHARS;
  const result: EmbeddedContextFile[] = [];
  for (const file of files) {
    if (file.missing) {
      result.push({
        path: file.name,
        content: `[MISSING] Expected at: ${file.path}`,
      });
      continue;
    }
    const trimmed = MEMORY_FILE.test(file.name.trim())
      ? extractMemoryCovenant(file.content ?? "", file.name, maxChars)
      : trimBootstrapContent(file.content ?? "", file.name, maxChars);
    if (!trimmed.content) continue;
    if (trimmed.truncated) {
      opts?.warn?.(
        `workspace bootstrap file ${file.name} is ${trimmed.originalLength} chars (limit ${trimmed.maxChars}); truncating in injected context`,
      );
    }
    result.push({
      path: file.name,
      content: trimmed.content,
    });
  }
  return result;
}

export function sanitizeGoogleTurnOrdering(messages: AgentMessage[]): AgentMessage[] {
  const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  const role = first?.role;
  const content = first?.content;
  if (
    role === "user" &&
    typeof content === "string" &&
    content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT
  ) {
    return messages;
  }
  if (role !== "assistant") return messages;

  // Cloud Code Assist rejects histories that begin with a model turn (tool call or text).
  // Prepend a tiny synthetic user turn so the rest of the transcript can be used.
  const bootstrap: AgentMessage = {
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  } as AgentMessage;

  return [bootstrap, ...messages];
}
