/**
 * Turn what the guided setup found into `channels.telegram` config. Pure.
 *
 *   botToken       the verified token (when a new one was pasted)
 *   allowFrom      + the owner's user id (who may talk to the assistant)
 *   defaultChatId  the owner's chat (where reports and alerts are sent)
 *   groups         + the group's (negative) chat id, when a group was added
 */
import type { InfinibotConfig } from "../../config/types.js";
import type { TelegramConfig } from "../../config/types.telegram.js";

export interface TelegramSetupFill {
  /** Only set when the member pasted a new token. */
  token?: string;
  /** The verified bot's @username (display only; stores that keep one use it). */
  botUsername?: string | null;
  owner?: { userId: number; chatId: number };
  group?: { chatId: number; makeDefault?: boolean };
}

const idKey = (v: string | number) =>
  String(v)
    .trim()
    .replace(/^(telegram|tg):/i, "");

export function addAllowFrom(
  list: Array<string | number> | undefined,
  userId: number,
): Array<string | number> {
  const current = Array.isArray(list) ? [...list] : [];
  if (current.some((entry) => idKey(entry) === String(userId))) return current;
  return [...current, String(userId)];
}

export function fillTelegramSection(
  section: TelegramConfig | undefined,
  fill: TelegramSetupFill,
): TelegramConfig {
  const next: TelegramConfig = { ...section, enabled: true };
  if (fill.token) {
    next.botToken = fill.token;
    // A pasted token replaces a token file (the file would win otherwise).
    delete next.tokenFile;
  }
  if (fill.owner) {
    next.allowFrom = addAllowFrom(next.allowFrom, fill.owner.userId);
    next.defaultChatId = String(fill.owner.chatId);
  }
  if (fill.group) {
    const key = String(fill.group.chatId);
    next.groups = { ...next.groups, [key]: { ...next.groups?.[key], enabled: true } };
    if (fill.group.makeDefault || !next.defaultChatId) next.defaultChatId = key;
  }
  return next;
}

export function applyTelegramSetupToConfig(
  cfg: InfinibotConfig,
  fill: TelegramSetupFill,
): InfinibotConfig {
  return {
    ...cfg,
    channels: { ...cfg.channels, telegram: fillTelegramSection(cfg.channels?.telegram, fill) },
  };
}
