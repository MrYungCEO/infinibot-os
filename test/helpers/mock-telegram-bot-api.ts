/**
 * A local stand-in for the Telegram Bot API (https://api.telegram.org), for
 * tests and the guided-setup end-to-end run. Point the gateway at it with
 * INFINIBOT_TELEGRAM_API_ROOT=http://127.0.0.1:<port>.
 *
 * Bot API:  /bot<token>/<method>   getMe, getWebhookInfo, setWebhook,
 *           deleteWebhook, getUpdates (long-poll), sendMessage, getChat,
 *           getUserProfilePhotos, getFile; anything else answers { ok: true }.
 *           /file/bot<token>/<path> the bot's avatar
 * Control:  POST /__mock/message  { token, text, chat?, from?, channelPost? }
 *                                 a user sends the bot a message (delivered to
 *                                 getUpdates, or POSTed to the webhook if one is set)
 *           POST /__mock/webhook  { token, url }   pretend another app set a webhook
 *           POST /__mock/conflict { token, on }    pretend another app is long-polling
 *           GET  /__mock/state                     sent messages, webhooks, calls
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { toText } from "../../src/utils/to-text.js";

export interface MockBot {
  token: string;
  id: number;
  username: string;
  first_name: string;
  can_read_all_group_messages?: boolean;
  avatar?: boolean;
}

interface BotState {
  bot: MockBot;
  queue: Array<Record<string, unknown>>;
  nextUpdateId: number;
  webhook: { url: string; secret?: string } | null;
  conflict: boolean;
  knownChats: Map<number, Record<string, unknown>>;
  waiters: Array<() => void>;
}

export interface MockTelegram {
  url: string;
  port: number;
  server: Server;
  sent: Array<{ token: string; chat_id: number | string; text: string }>;
  calls: Array<{ token: string; method: string }>;
  message(input: {
    token: string;
    text: string;
    chat?: { id: number; type: string; title?: string };
    from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
    channelPost?: boolean;
  }): Promise<void>;
  setWebhook(token: string, url: string): void;
  setConflict(token: string, on: boolean): void;
  close(): Promise<void>;
}

// 1x1 PNG.
const AVATAR = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwGAhJ0FsQAAAABJRU5ErkJggg==",
  "base64",
);

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

export async function startMockTelegramBotApi(opts: {
  port?: number;
  bots: MockBot[];
  /** Cap on how long getUpdates is held open (ms). */
  maxHoldMs?: number;
}): Promise<MockTelegram> {
  const states = new Map<string, BotState>();
  for (const bot of opts.bots) {
    states.set(bot.token, {
      bot,
      queue: [],
      nextUpdateId: 1000,
      webhook: null,
      conflict: false,
      knownChats: new Map(),
      waiters: [],
    });
  }
  const sent: MockTelegram["sent"] = [];
  const calls: MockTelegram["calls"] = [];
  const maxHoldMs = opts.maxHoldMs ?? 1000;

  const deliver = async (input: Parameters<MockTelegram["message"]>[0]) => {
    const st = states.get(input.token);
    if (!st) throw new Error("unknown bot");
    const from = input.from ?? { id: 777001, username: "alex", first_name: "Alex" };
    const chat = input.chat ?? { id: from.id, type: "private" };
    st.knownChats.set(chat.id, { ...chat, username: from.username, first_name: from.first_name });
    const msg = {
      message_id: st.nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat,
      ...(input.channelPost ? {} : { from: { is_bot: false, ...from } }),
      text: input.text,
    };
    const update = {
      update_id: st.nextUpdateId++,
      [input.channelPost ? "channel_post" : "message"]: msg,
    };
    if (st.webhook) {
      await fetch(st.webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(st.webhook.secret ? { "x-telegram-bot-api-secret-token": st.webhook.secret } : {}),
        },
        body: JSON.stringify(update),
      }).catch(() => undefined);
      return;
    }
    st.queue.push(update);
    for (const wake of st.waiters.splice(0)) wake();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const tgError = (code: number, description: string) =>
      json(code, { ok: false, error_code: code, description });
    try {
      if (url.pathname.startsWith("/__mock/")) {
        const body = req.method === "POST" ? await readBody(req) : {};
        if (url.pathname === "/__mock/message") {
          await deliver(body as never);
          return json(200, { ok: true });
        }
        if (url.pathname === "/__mock/webhook") {
          const st = states.get(String(body.token));
          if (st) st.webhook = body.url ? { url: toText(body.url) } : null;
          return json(200, { ok: true });
        }
        if (url.pathname === "/__mock/conflict") {
          const st = states.get(String(body.token));
          if (st) st.conflict = body.on !== false;
          return json(200, { ok: true });
        }
        if (url.pathname === "/__mock/state") {
          return json(200, {
            sent,
            calls: calls.map((c) => c.method),
            webhooks: [...states.values()].map((s) => ({
              bot: s.bot.username,
              url: s.webhook?.url ?? null,
            })),
          });
        }
        return json(404, { ok: false });
      }

      const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
      if (file) {
        if (!states.has(decodeURIComponent(file[1]))) return tgError(401, "Unauthorized");
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(AVATAR);
      }

      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
      if (!m) return tgError(404, "Not Found");
      const token = decodeURIComponent(m[1]);
      const method = m[2];
      const st = states.get(token);
      calls.push({ token, method });
      if (!st) return tgError(401, "Unauthorized");
      const body = {
        ...Object.fromEntries(url.searchParams),
        ...(req.method === "POST" ? await readBody(req) : {}),
      } as Record<string, unknown>;
      const ok = (result: unknown) => json(200, { ok: true, result });

      switch (method) {
        case "getMe":
          return ok({
            id: st.bot.id,
            is_bot: true,
            first_name: st.bot.first_name,
            username: st.bot.username,
            can_join_groups: true,
            can_read_all_group_messages: st.bot.can_read_all_group_messages ?? false,
            supports_inline_queries: false,
          });
        case "getWebhookInfo":
          return ok({
            url: st.webhook?.url ?? "",
            has_custom_certificate: false,
            pending_update_count: st.queue.length,
          });
        case "setWebhook":
          st.webhook = {
            url: toText(body.url ?? ""),
            secret: body.secret_token ? toText(body.secret_token) : undefined,
          };
          if (!st.webhook.url) st.webhook = null;
          return ok(true);
        case "deleteWebhook":
          st.webhook = null;
          return ok(true);
        case "getUpdates": {
          if (st.webhook) {
            return tgError(
              409,
              "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
            );
          }
          if (st.conflict) {
            return tgError(
              409,
              "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
            );
          }
          const offset = Number(body.offset ?? 0);
          if (offset) st.queue = st.queue.filter((u) => (u.update_id as number) >= offset);
          const timeoutMs = Math.min(Number(body.timeout ?? 0) * 1000, maxHoldMs);
          if (st.queue.length === 0 && timeoutMs > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, timeoutMs);
              st.waiters.push(() => {
                clearTimeout(timer);
                resolve();
              });
              req.on("close", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          return ok(st.queue.slice(0, Number(body.limit ?? 100)));
        }
        case "sendMessage": {
          const chatId = Number(body.chat_id);
          if (!st.knownChats.has(chatId)) return tgError(400, "Bad Request: chat not found");
          sent.push({ token, chat_id: chatId, text: toText(body.text ?? "") });
          return ok({
            message_id: sent.length,
            date: Math.floor(Date.now() / 1000),
            chat: st.knownChats.get(chatId),
            text: body.text,
          });
        }
        case "getChat": {
          const chat = st.knownChats.get(Number(body.chat_id));
          return chat ? ok(chat) : tgError(400, "Bad Request: chat not found");
        }
        case "getUserProfilePhotos":
          return ok(
            st.bot.avatar
              ? {
                  total_count: 1,
                  photos: [[{ file_id: "avatar", file_unique_id: "a", width: 160, height: 160 }]],
                }
              : { total_count: 0, photos: [] },
          );
        case "getFile":
          return ok({ file_id: "avatar", file_unique_id: "a", file_path: "photos/avatar.png" });
        case "getMyCommands":
          return ok([]);
        default:
          return ok(true);
      }
    } catch (err) {
      json(500, { ok: false, error_code: 500, description: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    sent,
    calls,
    message: deliver,
    setWebhook(token, url) {
      const st = states.get(token);
      if (st) st.webhook = url ? { url } : null;
    },
    setConflict(token, on) {
      const st = states.get(token);
      if (st) st.conflict = on;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const st of states.values()) for (const wake of st.waiters.splice(0)) wake();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
