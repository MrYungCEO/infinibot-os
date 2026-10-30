/**
 * Delivery sinks for scheduled-task messages.
 *
 *   telegram — the owner's bot chat (channels.telegram.defaultChatId, else
 *              allowFrom[0]); PDFs via the reports Telegram sink, texts with
 *              inline buttons via src/telegram/send.ts.
 *   file     — JSONL (tests / isolated side gateways). Selected with
 *              INFINIBOT_SCHEDULED_TASKS_SINK=file:/abs/path.jsonl, which also
 *              guarantees nothing reaches the real Telegram.
 *
 * The UI needs no sink: it reads the store.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { Button } from "./render.js";

const log = createSubsystemLogger("autonomy.scheduled.delivery");

export interface OutgoingMessage {
  kind: string;
  taskId: string;
  runId?: string | null;
  itemId?: string | null;
  /** Telegram HTML. */
  text: string;
  buttons?: Button[][];
  /** Send this PDF first (as a document). */
  pdfPath?: string | null;
  pdfCaption?: string;
  /** Ask for a text reply (Telegram force_reply); the reply is routed back by marker. */
  forceReply?: boolean;
}

export interface SendResult {
  ok: boolean;
  chatId?: string;
  messageId?: number;
  error?: string;
}

export interface DeliverySink {
  readonly name: string;
  send(msg: OutgoingMessage): Promise<SendResult>;
  /** Replace text/buttons of an earlier message (buttons: [] removes them). */
  edit(chatId: string, messageId: number, text: string, buttons: Button[][]): Promise<void>;
}

export class FileSink implements DeliverySink {
  readonly name = "file";
  private seq = 0;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const messageId = Date.now() * 10 + (this.seq++ % 10);
    appendFileSync(this.path, `${JSON.stringify({ at: Date.now(), messageId, ...msg })}\n`);
    return { ok: true, chatId: "file", messageId };
  }
  async edit(chatId: string, messageId: number, text: string, buttons: Button[][]): Promise<void> {
    appendFileSync(
      this.path,
      `${JSON.stringify({ at: Date.now(), kind: "edit", chatId, messageId, text, buttons })}\n`,
    );
  }
}

export class MemorySink implements DeliverySink {
  readonly name = "memory";
  sent: Array<OutgoingMessage & { messageId: number }> = [];
  edits: Array<{ messageId: number; text: string; buttons: Button[][] }> = [];
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const messageId = this.sent.length + 1;
    this.sent.push({ ...msg, messageId });
    return { ok: true, chatId: "mem", messageId };
  }
  async edit(_c: string, messageId: number, text: string, buttons: Button[][]): Promise<void> {
    this.edits.push({ messageId, text, buttons });
  }
}

async function ownerChatId(): Promise<{ chatId: string; token: string } | null> {
  const { loadConfig } = await import("../../config/config.js");
  const tg = (loadConfig().channels?.telegram ?? {}) as {
    botToken?: string;
    defaultChatId?: string | number;
    allowFrom?: Array<string | number>;
  };
  const { resolveOwnerTelegramChatId } = await import("../../telegram/owner-chat.js");
  const chat = resolveOwnerTelegramChatId(tg);
  const token = tg.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  if (!chat || !token) return null;
  return { chatId: String(chat), token };
}

/** Web opener for the task (`<public-base>/m/scheduled/<taskId>`), or null. */
async function taskWebUrl(taskId: string): Promise<string | null> {
  if (!taskId) return null;
  try {
    const [{ gatewayWebUrl }, { buildDeepLink }] = await Promise.all([
      import("../../notifications/public-base.js"),
      import("../../notifications/links.js"),
    ]);
    return gatewayWebUrl(buildDeepLink({ kind: "scheduled", taskId }));
  } catch {
    return null;
  }
}

/** Telegram HTML-escape for the plain "Open: <url>" fallback line. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class TelegramSink implements DeliverySink {
  readonly name = "telegram";
  async send(msg: OutgoingMessage): Promise<SendResult> {
    const owner = await ownerChatId();
    if (!owner) return { ok: false, error: "telegram not configured (botToken / defaultChatId)" };
    const webUrl = await taskWebUrl(msg.taskId);
    const { isTelegramButtonUrl } = await import("../../notifications/links.js");
    const urlButton = isTelegramButtonUrl(webUrl);
    // Force-reply prompts can't carry an inline keyboard → link as a text line.
    const openLine =
      webUrl && (!urlButton || msg.forceReply) ? `\nOpen: ${escapeHtml(webUrl)}` : "";
    try {
      if (msg.pdfPath) {
        const { sendDocumentTelegram } = await import("../../reports/sinks/telegram.js");
        const doc = await sendDocumentTelegram(msg.pdfPath, {
          caption: msg.pdfCaption ?? "Report",
          chatId: owner.chatId,
        });
        if (!doc.ok) log.warn("report PDF upload failed", { error: doc.error });
      }
      if (msg.forceReply) {
        const res = await fetch(`https://api.telegram.org/bot${owner.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: owner.chatId,
            text: `${msg.text.slice(0, 4096 - openLine.length)}${openLine}`,
            parse_mode: "HTML",
            reply_markup: { force_reply: true, input_field_placeholder: "Your instructions…" },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          description?: string;
          result?: { message_id?: number };
        };
        if (!json.ok) return { ok: false, error: json.description ?? `HTTP ${res.status}` };
        return { ok: true, chatId: owner.chatId, messageId: json.result?.message_id };
      }
      const { sendMessageTelegram } = await import("../../telegram/send.js");
      const buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
        ...(msg.buttons ?? []),
        ...(urlButton && webUrl ? [[{ text: "🔗 Open", url: webUrl }]] : []),
      ];
      const r = await sendMessageTelegram(
        owner.chatId,
        `${msg.text.slice(0, 4096 - openLine.length)}${openLine}`,
        {
          textMode: "html",
          ...(buttons.length ? { buttons } : {}),
        },
      );
      return { ok: true, chatId: r.chatId, messageId: Number(r.messageId) };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }
  async edit(chatId: string, messageId: number, text: string, buttons: Button[][]): Promise<void> {
    try {
      const { editMessageTelegram } = await import("../../telegram/send.js");
      await editMessageTelegram(chatId, messageId, text.slice(0, 4096), {
        textMode: "html",
        buttons,
      });
    } catch (err) {
      log.debug?.("telegram edit failed", { error: String(err) });
    }
  }
}

/** Sink for production use; honours the file override and SKIP_CHANNELS. */
export function resolveDefaultSink(): DeliverySink | null {
  const override = process.env.INFINIBOT_SCHEDULED_TASKS_SINK?.trim();
  if (override?.startsWith("file:")) return new FileSink(override.slice(5));
  if (override === "none") return null;
  if (process.env.INFINIBOT_SKIP_CHANNELS === "1") return null;
  return new TelegramSink();
}
