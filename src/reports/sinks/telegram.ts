/**
 * Telegram sink — delivers a rendered report PDF via the Bot API.
 *
 * Reads `channels.telegram` (botToken + defaultChatId) from the shared
 * `infinibot.json` and POSTs the PDF to `sendDocument` using multipart form
 * data. We hit the HTTP API directly (Node 22 global fetch/FormData/Blob)
 * rather than going through the grammy-based `src/telegram/send.ts` because the
 * worker is a standalone process and document upload is a single call.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveConfigPath } from "../../config/paths.js";

interface TelegramChannelConfig {
  enabled?: boolean;
  botToken?: string;
  defaultChatId?: string;
}

export interface TelegramSinkResult {
  ok: boolean;
  chatId?: string;
  messageId?: number;
  error?: string;
}

function loadTelegramConfig(): TelegramChannelConfig | null {
  try {
    const raw = readFileSync(resolveConfigPath(), "utf8");
    const cfg = JSON.parse(raw) as { channels?: { telegram?: TelegramChannelConfig } };
    return cfg.channels?.telegram ?? null;
  } catch {
    return null;
  }
}

export interface TelegramTextResult {
  ok: boolean;
  chatId?: string;
  messageId?: number;
  error?: string;
}

/**
 * Send a plain text message to Telegram via Bot API `sendMessage`.
 *
 * Used by the infinite-canvas-walkthrough skill to post a deployed URL as a
 * link-only message (no PDF / no HTML attachment). Same config lookup as
 * {@link sendDocumentTelegram} — `channels.telegram.{botToken, defaultChatId}`.
 * Never throws.
 */
export async function sendTelegramText(
  text: string,
  opts: { chatId?: string; parseMode?: "Markdown" | "HTML" | "MarkdownV2" } = {},
): Promise<TelegramTextResult> {
  const tg = loadTelegramConfig();
  if (!tg?.botToken) return { ok: false, error: "telegram botToken not configured" };
  const chatId = opts.chatId ?? tg.defaultChatId;
  if (!chatId) return { ok: false, error: "no chatId (set channels.telegram.defaultChatId)" };
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 4096),
      disable_web_page_preview: false,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number; chat?: { id?: number } };
    };
    if (!res.ok || !json.ok) return { ok: false, error: json.description ?? `HTTP ${res.status}` };
    return {
      ok: true,
      chatId: String(json.result?.chat?.id ?? chatId),
      messageId: json.result?.message_id,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Send a PDF file to Telegram. `chatId` overrides the configured default.
 * Never throws — returns `{ ok: false, error }` so the worker's fan-out can
 * record a per-sink result without aborting the others.
 */
export async function sendDocumentTelegram(
  filePath: string,
  opts: { caption?: string; chatId?: string } = {},
): Promise<TelegramSinkResult> {
  const tg = loadTelegramConfig();
  if (!tg?.botToken) return { ok: false, error: "telegram botToken not configured" };
  const chatId = opts.chatId ?? tg.defaultChatId;
  if (!chatId) return { ok: false, error: "no chatId (set channels.telegram.defaultChatId)" };

  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `cannot read ${filePath}: ${(err as Error).message}` };
  }

  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (opts.caption) form.append("caption", opts.caption.slice(0, 1024));
    form.append(
      "document",
      new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      basename(filePath),
    );

    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number; chat?: { id?: number } };
    };
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.description ?? `HTTP ${res.status}` };
    }
    return {
      ok: true,
      chatId: String(json.result?.chat?.id ?? chatId),
      messageId: json.result?.message_id,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
