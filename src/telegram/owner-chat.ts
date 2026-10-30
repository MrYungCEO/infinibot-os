/**
 * The owner's Telegram chat — where gateway-originated messages (reports,
 * scheduled-task results, verification verdicts) go.
 *
 * `channels.telegram.defaultChatId` is the delivery target; `allowFrom` is an
 * inbound allow-list whose order means nothing (its first entry may be an id
 * the bot has never talked to → "chat not found"). allowFrom[0] is only a
 * fallback for installs that never set defaultChatId.
 */

export interface TelegramOwnerConfig {
  defaultChatId?: string | number;
  allowFrom?: Array<string | number>;
}

export function resolveOwnerTelegramChatId(
  tg: TelegramOwnerConfig | undefined | null,
): string | null {
  const def = tg?.defaultChatId;
  if (def !== undefined && def !== null && String(def).trim()) return String(def).trim();
  const first = Array.isArray(tg?.allowFrom)
    ? tg.allowFrom.find((x) => String(x ?? "").trim() && String(x) !== "*")
    : undefined;
  return first !== undefined ? String(first).trim() : null;
}
