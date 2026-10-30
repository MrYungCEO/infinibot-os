/**
 * The handful of Bot API calls the guided setup makes, on grammY's `Api`
 * (the same client the channel uses; no second Telegram library).
 */
import { Api, type ApiClientOptions } from "grammy";
import type { TelegramNetworkConfig } from "../../config/types.telegram.js";
import { resolveTelegramApiRoot, withTelegramApiRoot } from "../api-root.js";
import { resolveTelegramFetch } from "../fetch.js";
import { makeProxyFetch } from "../proxy.js";

export interface SetupBotInfo {
  id: number;
  username: string | null;
  name: string | null;
  canJoinGroups: boolean | null;
  /** false = privacy mode is on: in groups the bot only sees commands and mentions. */
  canReadAllGroupMessages: boolean | null;
}

export interface SetupChatInfo {
  id: number;
  type: string;
  title: string | null;
  username: string | null;
  firstName: string | null;
}

export interface SetupBotApi {
  getMe(): Promise<SetupBotInfo>;
  getWebhookUrl(): Promise<string | null>;
  deleteWebhook(): Promise<void>;
  getUpdates(
    params: { offset?: number; timeout: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<Array<{ update_id: number }>>;
  sendMessage(chatId: number | string, text: string): Promise<void>;
  getChat(chatId: number | string): Promise<SetupChatInfo>;
  /** The bot's profile photo as a small data: URL, or null. Never throws. */
  avatar(botId: number): Promise<string | null>;
}

export type SetupBotApiFactory = (token: string) => SetupBotApi;

const AVATAR_MAX_BYTES = 200 * 1024;

export function createGrammySetupApi(
  token: string,
  opts: { proxy?: string; network?: TelegramNetworkConfig; env?: NodeJS.ProcessEnv } = {},
): SetupBotApi {
  const proxyFetch = opts.proxy?.trim() ? makeProxyFetch(opts.proxy.trim()) : undefined;
  const fetchImpl = resolveTelegramFetch(proxyFetch, { network: opts.network });
  const client = withTelegramApiRoot(
    {
      ...(fetchImpl ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] } : {}),
      timeoutSeconds: 40,
    },
    opts.env,
  );
  const api = new Api(token, client);
  const doFetch = (fetchImpl ?? fetch) as typeof fetch;
  return {
    async getMe() {
      const me = await api.getMe();
      return {
        id: me.id,
        username: me.username ?? null,
        name: me.first_name ?? null,
        canJoinGroups: typeof me.can_join_groups === "boolean" ? me.can_join_groups : null,
        canReadAllGroupMessages:
          typeof me.can_read_all_group_messages === "boolean"
            ? me.can_read_all_group_messages
            : null,
      };
    },
    async getWebhookUrl() {
      const info = await api.getWebhookInfo();
      return info.url?.trim() || null;
    },
    async deleteWebhook() {
      await api.deleteWebhook();
    },
    async getUpdates(params, signal) {
      return api.getUpdates(
        {
          offset: params.offset,
          timeout: params.timeout,
          limit: params.limit ?? 50,
          allowed_updates: ["message", "channel_post"],
        },
        signal as never,
      );
    },
    async sendMessage(chatId, text) {
      await api.sendMessage(chatId, text);
    },
    async getChat(chatId) {
      const chat = (await api.getChat(chatId)) as {
        id: number;
        type: string;
        title?: string;
        username?: string;
        first_name?: string;
      };
      return {
        id: chat.id,
        type: chat.type,
        title: chat.title ?? null,
        username: chat.username ?? null,
        firstName: chat.first_name ?? null,
      };
    },
    async avatar(botId) {
      try {
        const photos = await api.getUserProfilePhotos(botId, { limit: 1 });
        const sizes = photos.photos?.[0];
        if (!sizes?.length) return null;
        const pick = sizes.find((s) => s.width >= 120) ?? sizes[sizes.length - 1];
        const file = await api.getFile(pick.file_id);
        if (!file.file_path) return null;
        const url = `${resolveTelegramApiRoot(opts.env)}/file/bot${token}/${file.file_path}`;
        const res = await doFetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return null;
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return null;
        const type = /\.png$/i.test(file.file_path) ? "image/png" : "image/jpeg";
        return `data:${type};base64,${bytes.toString("base64")}`;
      } catch {
        return null;
      }
    },
  };
}
