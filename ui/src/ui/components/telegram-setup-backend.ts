/**
 * Data contract between <telegram-setup> and whatever saves the bot.
 *
 * The default backend talks to the gateway (`telegram.setup.*` RPCs,
 * src/gateway/server-methods/telegram-setup.ts). A surface with no gateway
 * socket can pass its own backend with the same actions.
 *
 * Nothing in these shapes carries the bot token back to the browser.
 */
import { getGatewayClient, type GatewayBrowserClient } from "../gateway-client";

export type TgSetupAction =
  | "summary"
  | "verify"
  | "deleteWebhook"
  | "capture.start"
  | "capture.status"
  | "capture.cancel"
  | "manual"
  | "confirm"
  | "test"
  | "disconnect";

export interface TgSetupError {
  code: string;
  title: string;
  message: string;
  fix: string;
  action?: "deleteWebhook" | "retry";
}

export interface TgFound {
  userId: number | null;
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  chatTitle: string | null;
  username: string | null;
  firstName: string | null;
}

export interface TgCapture {
  mode: "dm" | "group";
  status: "waiting" | "found" | "expired" | "cancelled" | "error";
  transport: "polling" | "live" | "manual";
  code: string;
  deepLink: string | null;
  expiresAt: number;
  found?: TgFound;
  otherMessages: number;
  error?: TgSetupError;
}

export interface TgSession {
  sessionId: string;
  bot: {
    id: number;
    username: string | null;
    name: string | null;
    avatar: string | null;
    canReadAllGroupMessages: boolean | null;
  };
  tokenMasked: string;
  tokenSource: "pasted" | "saved";
  webhookHost: string | null;
  channelLive: boolean;
  owner: TgFound | null;
  groups: TgFound[];
  capture: TgCapture | null;
  qr?: string | null;
}

export interface TgSummary {
  connected: boolean;
  running: boolean;
  mode: "polling" | "webhook";
  tokenMasked: string | null;
  bot: { username: string | null; name: string | null } | null;
  owners: string[];
  defaultChatId: string | null;
  groups: string[];
  lastError: string | null;
  /** Set when the saved bot is not run by this gateway (e.g. it runs on the hosted plan). */
  note?: string | null;
}

export type TgResult<T> = ({ ok: true } & T) | { ok: false; error: TgSetupError };

export interface TelegramSetupBackend {
  call<T>(action: TgSetupAction, params?: Record<string, unknown>): Promise<TgResult<T>>;
}

const OFFLINE: TgSetupError = {
  code: "network",
  title: "Not connected to InfiniBot",
  message: "This page lost its connection to InfiniBot.",
  fix: "Wait a moment for it to reconnect, then try again.",
  action: "retry",
};

export function gatewayTelegramSetupBackend(
  client?: GatewayBrowserClient | null,
): TelegramSetupBackend {
  return {
    async call<T>(action: TgSetupAction, params: Record<string, unknown> = {}) {
      const c = client ?? getGatewayClient();
      if (!c) return { ok: false, error: OFFLINE } as TgResult<T>;
      try {
        return (await (
          c as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }
        ).request(`telegram.setup.${action}`, params)) as TgResult<T>;
      } catch (err) {
        const text = String((err as Error)?.message ?? err);
        const missing = /unknown method|method not found/i.test(text);
        return {
          ok: false,
          error: missing
            ? {
                code: "unknown",
                title: "InfiniBot needs a restart",
                message: "This InfiniBot hasn't loaded the Telegram setup yet.",
                fix: "Restart InfiniBot, then open this page again.",
              }
            : { ...OFFLINE, title: "Something went wrong", message: text.slice(0, 200) },
        } as TgResult<T>;
      }
    },
  };
}
