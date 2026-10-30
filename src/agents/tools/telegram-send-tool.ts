import { Type } from "@sinclair/typebox";

import type { InfinibotConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { resolveAgentTelegramToken } from "../agent-integration-config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam } from "./common.js";

/** Telegram caps a single message at 4096 chars; stay under it to leave headroom. */
const DEFAULT_CHUNK_LIMIT = 4000;
/** Only split on a boundary if it lands past this fraction of the window (avoids tiny chunks). */
const MIN_SPLIT_RATIO = 0.5;

/**
 * Split `text` into Telegram-sized chunks, preferring sensible boundaries:
 * paragraph (\n\n) > sentence (.!?) > newline > space > hard cut.
 */
export function chunkTelegramMessage(text: string, maxLen = DEFAULT_CHUNK_LIMIT): string[] {
  if (text.length <= maxLen) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let remaining = text;
  const minSplit = Math.floor(maxLen * MIN_SPLIT_RATIO);

  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    let splitAt = -1;

    // 1) Paragraph boundary
    const para = window.lastIndexOf("\n\n");
    if (para >= minSplit) splitAt = para + 2;

    // 2) Sentence boundary (terminator followed by whitespace or end of window)
    if (splitAt < 0) {
      const sentences = [...window.matchAll(/[.!?](\s|$)/g)];
      const last = sentences[sentences.length - 1];
      if (last && last.index !== undefined && last.index >= minSplit) {
        splitAt = last.index + last[0].length;
      }
    }

    // 3) Single newline
    if (splitAt < 0) {
      const nl = window.lastIndexOf("\n");
      if (nl >= minSplit) splitAt = nl + 1;
    }

    // 4) Word boundary
    if (splitAt < 0) {
      const sp = window.lastIndexOf(" ");
      if (sp >= minSplit) splitAt = sp + 1;
    }

    // 5) Hard cut
    if (splitAt < 0) splitAt = maxLen;

    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

type TelegramSendChatResult = {
  chatId: string;
  ok: boolean;
  messageIds: string[];
  error?: string;
  evidence?: { ok: boolean; sent: number; more: number; messageIds: string[]; error?: string };
};

function formatTelegramError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Resolve the configured default chat id (channel-level), if any. */
function resolveDefaultChatId(cfg: InfinibotConfig): string | undefined {
  const id = cfg.channels?.telegram?.defaultChatId?.trim();
  return id || undefined;
}

/**
 * Resolve the ordered list of target chat ids:
 * - explicit `targets` wins (broadcast)
 * - else a concrete `chatId` (anything other than the literal "default")
 * - else the configured `defaultChatId`
 */
function resolveTargets(params: Record<string, unknown>, cfg: InfinibotConfig): string[] {
  const targets = readStringArrayParam(params, "targets");
  if (targets && targets.length > 0) return targets;

  const chatId = readStringParam(params, "chatId");
  if (chatId && chatId.toLowerCase() !== "default") return [chatId];

  const fallback = resolveDefaultChatId(cfg);
  if (!fallback) {
    throw new Error(
      "No chatId/targets provided and no default configured. " +
        "Pass chatId/targets, or set channels.telegram.defaultChatId via the telegram_set_default tool.",
    );
  }
  return [fallback];
}

const TelegramSendSchema = Type.Object({
  message: Type.String({ description: "Message text to send (auto-chunked if >4000 chars)." }),
  chatId: Type.Optional(
    Type.String({
      description: 'Target chat id. Omit or pass "default" to use channels.telegram.defaultChatId.',
    }),
  ),
  targets: Type.Optional(
    Type.Array(Type.String(), {
      description: "Broadcast to multiple chat ids. Falls back to [default] if omitted.",
    }),
  ),
  parseMode: Type.Optional(
    Type.Union([Type.Literal("MarkdownV2"), Type.Literal("HTML")], {
      description: "Formatting mode. Defaults to Markdown rendering.",
    }),
  ),
  silent: Type.Optional(
    Type.Boolean({ description: "Send without a notification (disable_notification)." }),
  ),
  dry: Type.Optional(
    Type.Boolean({ description: "Return the chunk plan + resolved targets without sending." }),
  ),
  runId: Type.Optional(
    Type.String({
      description:
        "Run this message reports on (a completion / verdict). Its verification screenshots are " +
        "attached automatically as a reply-threaded album. Detected from the text when omitted.",
    }),
  ),
});

export function createTelegramSendTool(opts?: {
  config?: InfinibotConfig;
  /** Requester agent id, so the message goes out on that agent's token when set. */
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "Telegram Send",
    name: "telegram_send",
    description:
      "Send a Telegram message to a configured default chat (or explicit chatId/targets). " +
      "Auto-chunks long messages at sensible boundaries, broadcasts to multiple chats, and " +
      "skips unreachable chats (chat not found / blocked / 403) while continuing the rest. " +
      "For a report / summary / digest / brief or any multi-section document, use the `report` " +
      "tool instead — it delivers the styled black-gold PDF rather than raw Markdown text.",
    parameters: TelegramSendSchema,
    execute: async (_toolCallId, args, signal) => {
      if (signal?.aborted) {
        const err = new Error("Telegram send aborted");
        err.name = "AbortError";
        throw err;
      }
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();

      const message = readStringParam(params, "message", { required: true });
      const targets = resolveTargets(params, cfg);
      const parseMode = readStringParam(params, "parseMode");
      const textMode = parseMode === "HTML" ? "html" : "markdown";
      const silent = typeof params.silent === "boolean" ? params.silent : undefined;
      const dry = params.dry === true;

      // Completion messages about a verified run carry its screenshots.
      const evidence = dry ? null : await import("../../verification/telegram-evidence.js");
      const runId = evidence
        ? evidence.resolveEvidenceRunId(readStringParam(params, "runId"), message)
        : null;
      const plan = evidence && runId ? await evidence.planVerificationEvidence(runId) : null;
      const fullMessage =
        evidence && plan ? `${message}\n\n${evidence.evidenceSummaryLine(plan)}` : message;

      const chunks = chunkTelegramMessage(fullMessage, DEFAULT_CHUNK_LIMIT);

      if (dry) {
        return jsonResult({
          dry: true,
          totalChunks: chunks.length,
          targets,
          parseMode: parseMode ?? "MarkdownV2",
          plan: chunks.map((chunk, index) => ({
            index,
            length: chunk.length,
            preview: chunk.slice(0, 80),
          })),
        });
      }

      // Per-agent token wins (attributable to this agent); else the global token.
      const token = resolveAgentTelegramToken(cfg, opts?.agentId).token;
      if (!token) {
        throw new Error(
          "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
        );
      }

      const results: TelegramSendChatResult[] = [];
      let totalSent = 0;

      for (const chatId of targets) {
        const messageIds: string[] = [];
        try {
          for (const chunk of chunks) {
            if (signal?.aborted) {
              const err = new Error("Telegram send aborted");
              err.name = "AbortError";
              throw err;
            }
            const res = await sendMessageTelegram(chatId, chunk, {
              token,
              textMode,
              silent,
            });
            messageIds.push(res.messageId);
            totalSent += 1;
          }
          if (evidence && runId && plan?.picked.length) {
            const att = await evidence.attachVerificationEvidence(runId, messageIds.at(-1), {
              chatId,
              token,
              selection: plan,
              silent,
            });
            results.push({ chatId, ok: true, messageIds, evidence: att });
            continue;
          }
          results.push({ chatId, ok: true, messageIds });
        } catch (err) {
          if ((err as Error)?.name === "AbortError") throw err;
          // chat not found / blocked / 403 (and other per-chat failures): skip, keep going.
          results.push({
            chatId,
            ok: false,
            messageIds,
            error: formatTelegramError(err),
          });
        }
      }

      return jsonResult({
        totalSent,
        totalChunks: chunks.length,
        results,
      });
    },
  };
}

const TelegramSetDefaultSchema = Type.Object({
  chatId: Type.String({
    description: "Chat id to persist as channels.telegram.defaultChatId.",
  }),
});

export function createTelegramSetDefaultTool(): AnyAgentTool {
  return {
    label: "Telegram Set Default",
    name: "telegram_set_default",
    description:
      "Persist the default Telegram chat id (channels.telegram.defaultChatId) used by telegram_send.",
    parameters: TelegramSetDefaultSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const chatId = readStringParam(params, "chatId", { required: true });

      // Load fresh and write back immutably (matches the config-write pattern elsewhere).
      const cfg = loadConfig();
      const nextConfig: InfinibotConfig = {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: {
            ...cfg.channels?.telegram,
            defaultChatId: chatId,
          },
        },
      };
      await writeConfigFile(nextConfig);

      return jsonResult({ ok: true, defaultChatId: chatId });
    },
  };
}
