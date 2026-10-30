import { toText } from "../../utils/to-text.js";
/**
 * Bot API failures → something a beginner can act on. Every error says what
 * went wrong and what to do next; `action` names a one-click fix when there is one.
 */

export type TelegramSetupErrorCode =
  | "bad_format"
  | "invalid_token"
  | "network"
  | "webhook_active"
  | "in_use_elsewhere"
  | "rate_limited"
  | "chat_unreachable"
  | "expired"
  | "not_found"
  | "not_allowed"
  | "unknown";

export interface TelegramSetupError {
  code: TelegramSetupErrorCode;
  title: string;
  message: string;
  fix: string;
  action?: "deleteWebhook" | "retry";
}

type ApiErr = {
  error_code?: number;
  description?: string;
  message?: string;
  name?: string;
  parameters?: { retry_after?: number };
  error?: unknown;
};

export const setupErrors = {
  badFormat: (message: string): TelegramSetupError => ({
    code: "bad_format",
    title: "That token doesn't look right",
    message,
    fix: "In Telegram, open @BotFather, find the message with your token and copy the whole line.",
  }),
  invalidToken: (): TelegramSetupError => ({
    code: "invalid_token",
    title: "Telegram didn't accept that token",
    message: "The token is the right shape, but Telegram says it doesn't belong to a bot.",
    fix: "Open @BotFather, send /mybots, pick your bot, tap “API Token” and copy it again. If you ever pressed “Revoke”, older tokens stop working.",
  }),
  network: (): TelegramSetupError => ({
    code: "network",
    title: "Couldn't reach Telegram",
    message: "InfiniBot couldn't connect to Telegram just now.",
    fix: "Check the internet connection of the computer running InfiniBot, then try again. If Telegram is blocked on your network, set a proxy under Advanced settings.",
    action: "retry",
  }),
  webhookActive: (host?: string | null): TelegramSetupError => ({
    code: "webhook_active",
    title: "This bot is connected to another app",
    message: host
      ? `Telegram is sending this bot's messages to ${host}. A bot can only talk to one app at a time.`
      : "Telegram is sending this bot's messages to another app. A bot can only talk to one app at a time.",
    fix: "If you're moving this bot to InfiniBot, press “Disconnect the other app”. The other app will stop getting this bot's messages. Or go back and make a new bot just for InfiniBot.",
    action: "deleteWebhook",
  }),
  inUseElsewhere: (): TelegramSetupError => ({
    code: "in_use_elsewhere",
    title: "This bot is already in use somewhere else",
    message:
      "Another program is listening for this bot's messages right now, so InfiniBot can't hear them.",
    fix: "Close the other program that uses this bot (another InfiniBot, a script, a different bot tool), then try again. Or go back and make a new bot just for InfiniBot.",
    action: "retry",
  }),
  rateLimited: (seconds?: number): TelegramSetupError => ({
    code: "rate_limited",
    title: "Telegram asked us to slow down",
    message: "Too many requests were sent to Telegram in a short time.",
    fix: seconds ? `Wait ${seconds} seconds, then try again.` : "Wait a minute, then try again.",
    action: "retry",
  }),
  chatUnreachable: (): TelegramSetupError => ({
    code: "chat_unreachable",
    title: "The bot can't message that chat yet",
    message: "Telegram only lets a bot write to people who have started it.",
    fix: "Open your bot in Telegram and press Start (or send it any message), then try again. For a group, make sure the bot is still a member.",
    action: "retry",
  }),
  expired: (): TelegramSetupError => ({
    code: "expired",
    title: "This setup timed out",
    message: "Setup sessions close after a while to keep your bot safe.",
    fix: "Paste your bot token again to pick up where you left off.",
  }),
  unknown: (detail: string): TelegramSetupError => ({
    code: "unknown",
    title: "Telegram returned an error",
    message: detail,
    fix: "Try again. If it keeps happening, make a new bot in @BotFather and use its token.",
    action: "retry",
  }),
};

/** Never let a token (it sits in Bot API URLs) leak through an error message. */
export function scrubToken(text: string): string {
  return text.replace(/\d{5,16}:[A-Za-z0-9_-]{30,64}/g, "<token>");
}

export function classifyTelegramSetupError(err: unknown): TelegramSetupError {
  const e = (err ?? {}) as ApiErr;
  const code = typeof e.error_code === "number" ? e.error_code : undefined;
  const text = scrubToken(toText(e.description ?? e.message ?? err ?? "")).toLowerCase();
  if (code === 401 || code === 404 || /unauthorized/.test(text)) {
    return setupErrors.invalidToken();
  }
  if (code === 409 || /conflict/.test(text)) {
    return /webhook/.test(text) ? setupErrors.webhookActive() : setupErrors.inUseElsewhere();
  }
  if (code === 429) return setupErrors.rateLimited(e.parameters?.retry_after);
  if (
    code === 403 ||
    /chat not found|bot was blocked|can't initiate|not a member|kicked|user is deactivated|peer_id_invalid/.test(
      text,
    )
  ) {
    return setupErrors.chatUnreachable();
  }
  if (
    code === undefined &&
    (e.name === "HttpError" ||
      e.name === "AbortError" ||
      e.name === "TimeoutError" ||
      /network|fetch failed|econn|enotfound|etimedout|eai_again|socket|timed out|aborted/.test(
        text,
      ))
  ) {
    return setupErrors.network();
  }
  return setupErrors.unknown(
    scrubToken(String(e.description ?? e.message ?? "Unknown error")).slice(0, 240),
  );
}
