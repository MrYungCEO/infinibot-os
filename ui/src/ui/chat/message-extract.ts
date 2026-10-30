import { formatAssistantTurnError } from "../chat-error-format";
import { stripThinkingTags } from "../format";

const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) return true;
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) return true;
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) return text;
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) return text;
  return text.slice(match[0].length);
}

/**
 * Local auto-OCR appends an `<attachment_context source="local-ocr">…` block
 * to the agent's copy of a user message. It is agent context, not something
 * the user typed — hide it from chat bubbles.
 */
const ATTACHMENT_CONTEXT_RE = /\s*<attachment_context\b[^>]*>[\s\S]*?<\/attachment_context>\s*/g;

export function stripAttachmentContext(text: string): string {
  if (!text.includes("<attachment_context")) return text;
  return text.replace(ATTACHMENT_CONTEXT_RE, "\n").trim();
}

function stripUserText(text: string): string {
  return stripAttachmentContext(stripEnvelope(text));
}

export function extractText(message: unknown): string | null {
  // Guard against null/undefined — handleChatEvent's terminal (final/error)
  // paths call extractText(payload.message) where message can be absent; a
  // throw here would abort the assistant-reply commit and drop the answer.
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  
  // Fast path: use pre-extracted text if available (from loadChatHistory normalization)
  if (typeof m._extractedText === "string") {
    const text = m._extractedText;
    const processed = role === "assistant" ? stripThinkingTags(text) : stripUserText(text);
    return processed;
  }
  
  const content = m.content;
  
  if (typeof content === "string") {
    const processed = role === "assistant" ? stripThinkingTags(content) : stripUserText(content);
    return processed;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      const joined = parts.join("\n");
      const processed = role === "assistant" ? stripThinkingTags(joined) : stripUserText(joined);
      return processed;
    }
  }
  if (typeof m.text === "string") {
    const processed = role === "assistant" ? stripThinkingTags(m.text) : stripUserText(m.text);
    return processed;
  }
  if (
    role === "assistant" &&
    typeof m.errorMessage === "string" &&
    m.errorMessage.trim()
  ) {
    return formatAssistantTurnError(m);
  }
  return null;
}

export function extractTextCached(message: unknown): string | null {
  if (!message || typeof message !== "object") return extractText(message);
  const obj = message as object;
  if (textCache.has(obj)) return textCache.get(obj) ?? null;
  const value = extractText(message);
  textCache.set(obj, value);
  return value;
}

export function extractThinking(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      const item = p as Record<string, unknown>;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        const cleaned = item.thinking.trim();
        if (cleaned) parts.push(cleaned);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");

  // Back-compat: older logs may still have <think> tags inside text blocks.
  const rawText = extractRawText(message);
  if (!rawText) return null;
  const matches = [
    ...rawText.matchAll(
      /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi,
    ),
  ];
  const extracted = matches
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  return extracted.length > 0 ? extracted.join("\n") : null;
}

export function extractThinkingCached(message: unknown): string | null {
  if (!message || typeof message !== "object") return extractThinking(message);
  const obj = message as object;
  if (thinkingCache.has(obj)) return thinkingCache.get(obj) ?? null;
  const value = extractThinking(message);
  thinkingCache.set(obj, value);
  return value;
}

export function extractRawText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

export function formatReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `_${line}_`);
  return lines.length ? ["_Reasoning:_", ...lines].join("\n") : "";
}
