/**
 * Telegram channel adapter — LIVE reference implementation.
 *
 * REUSES the existing Telegram bridge (src/telegram/*). It does NOT re-implement
 * transport, auth, or config. Creds live at channels.telegram in
 * ~/.infinibot/infinibot.json and are resolved by resolveTelegramAccount().
 */

import { loadConfig } from "../../config/config.js";
import { resolveTelegramAccount } from "../../telegram/accounts.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { findClientByHandle } from "../client-channel-prefs.js";
import {
  type AdapterStatus,
  type ChannelAdapter,
  type NormalizedMessage,
  type OutboundSend,
  type SendResult,
  threadKeyFor,
} from "../types.js";

export const telegramAdapter: ChannelAdapter = {
  channel: "telegram",

  async status(): Promise<AdapterStatus> {
    let configured = false;
    let enabled = false;
    let accountId: string | null = null;
    try {
      const cfg = loadConfig();
      const account = resolveTelegramAccount({ cfg });
      configured = account.tokenSource !== "none";
      enabled = account.enabled;
      accountId = account.accountId;
    } catch {
      // fall through to unconfigured
    }
    return {
      channel: "telegram",
      configured,
      enabled,
      accountId,
      setupNotes: configured
        ? null
        : "Set channels.telegram.accounts.<id>.botToken (or TELEGRAM_BOT_TOKEN) in ~/.infinibot/infinibot.json, then restart the gateway.",
    };
  },

  async send(req: OutboundSend): Promise<SendResult> {
    const result = await sendMessageTelegram(req.peerHandle, req.text, {
      accountId: req.channelAccountId ?? undefined,
      mediaUrl: req.mediaUrls?.[0],
    });
    return {
      channelMessageId: result.messageId ?? null,
      channelAccountId: req.channelAccountId ?? null,
    };
  },

  /**
   * Normalize a raw inbound Telegram update into a NormalizedMessage.
   * Accepts either a grammy `Context`-like object or a plain
   * `{ chatId, from, text, messageId, agencyId, accountId }` payload
   * (the shape the future bot-handler hook / comms.ingest will pass).
   */
  normalizeInbound(raw: unknown): NormalizedMessage | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, any>;

    // Support both a flat payload and a grammy message object.
    const msg = r.message ?? r;
    const chatId = String(r.chatId ?? msg?.chat?.id ?? "").trim();
    const text = String(r.text ?? msg?.text ?? msg?.caption ?? "").trim();
    if (!chatId) return null;

    const from = msg?.from ?? r.from ?? {};
    const displayName =
      [from.first_name, from.last_name].filter(Boolean).join(" ").trim() ||
      (from.username ? `@${from.username}` : null);
    const agencyId = String(r.agencyId ?? "default");
    const clientId =
      (r.clientId as string | undefined) ??
      findClientByHandle(agencyId, "telegram", chatId) ??
      (from.username ? findClientByHandle(agencyId, "telegram", `@${from.username}`) : null);

    const now = Date.now();
    return {
      id: "", // assigned by the store on record
      channel: "telegram",
      direction: "inbound",
      threadKey: threadKeyFor(clientId, "telegram", chatId),
      clientId,
      agencyId,
      channelAccountId: r.accountId ? String(r.accountId) : null,
      peerHandle: chatId,
      peerDisplayName: displayName ?? null,
      text,
      mediaUrls: [],
      channelMessageId: r.messageId != null ? String(r.messageId) : (msg?.message_id != null ? String(msg.message_id) : null),
      status: "received",
      sentByAgentId: null,
      autonomyDecision: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  },

  resolveClient(peerHandle: string, agencyId: string): string | null {
    return findClientByHandle(agencyId, "telegram", peerHandle);
  },
};
