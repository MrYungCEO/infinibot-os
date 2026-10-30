/**
 * Where the Telegram Bot API lives. Always https://api.telegram.org, unless
 * INFINIBOT_TELEGRAM_API_ROOT points somewhere else.
 *
 * The override exists for tests and for a self-hosted Bot API server
 * (https://github.com/tdlib/telegram-bot-api). Whatever it points at receives
 * the bot token in every request URL, so only ever set it to a server you run.
 */
import type { ApiClientOptions } from "grammy";

export const TELEGRAM_API_ROOT_ENV = "INFINIBOT_TELEGRAM_API_ROOT";
export const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

export function resolveTelegramApiRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[TELEGRAM_API_ROOT_ENV]?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return DEFAULT_TELEGRAM_API_ROOT;
  return raw.replace(/\/+$/, "");
}

/** grammY client options with the API root override applied (when one is set). */
export function withTelegramApiRoot(
  client: ApiClientOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ApiClientOptions | undefined {
  const root = resolveTelegramApiRoot(env);
  if (root === DEFAULT_TELEGRAM_API_ROOT) return client;
  return { ...client, apiRoot: root };
}
