/**
 * telegram.setup.* — the guided Telegram setup behind <telegram-setup>.
 *
 *   summary         what is connected now (never the token)
 *   verify          { token } | { useSaved } → getMe → a setup session
 *   deleteWebhook   disconnect another app's webhook from this bot
 *   capture.start   { sessionId, mode: "dm" | "group" } → start code, link, QR
 *   capture.status  poll: waiting | found | expired | error
 *   capture.cancel
 *   manual          { sessionId, mode, id } typed-in id, checked with getChat
 *   confirm         save bot + owner (allowFrom, defaultChatId) / group, start the channel
 *   test            send "✅ InfiniBot is connected"
 *   disconnect      forget the token, stop the channel
 *
 * Starting without a restart: when the Telegram channel plugin is loaded the
 * channel is stopped and started in place ("live"). On an install that has never
 * had Telegram the bundled plugin isn't loaded yet; the config change then makes
 * the gateway reload itself in-process to load it ("reload", a few seconds, the
 * UI reconnects on its own). `confirm` says which one happened in `starting`.
 *
 * The bot token goes browser → gateway once (verify) and never comes back:
 * responses carry a session id and a masked token. Nothing here logs it.
 * Design + security notes: docs/channels/telegram-guided-setup.md.
 */
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getTelegramSetupManager,
  lookupTelegramBot,
  maskTelegramToken,
  scrubToken,
  setupErrors,
  type CaptureMode,
  type SessionView,
  type TelegramSetupError,
} from "../../telegram/setup/index.js";
import {
  resolveTelegramSetupStore,
  telegramSetupScope,
  type TelegramSetupStore,
} from "../../telegram/setup/store.js";
import { renderQrPngBase64 } from "../../web/qr-image.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

const log = createSubsystemLogger("gateway/telegram-setup");

export const TELEGRAM_SETUP_READ_METHODS = ["telegram.setup.summary"] as const;

/** Everything else changes the bot / who owns it: operator.admin (like config.* and channels.logout). */
export const TELEGRAM_SETUP_ADMIN_METHODS = [
  "telegram.setup.verify",
  "telegram.setup.deleteWebhook",
  "telegram.setup.capture.start",
  "telegram.setup.capture.status",
  "telegram.setup.capture.cancel",
  "telegram.setup.manual",
  "telegram.setup.confirm",
  "telegram.setup.test",
  "telegram.setup.disconnect",
] as const;

const NOT_ALLOWED: TelegramSetupError = {
  code: "not_allowed",
  title: "Telegram can't be set up from this workspace",
  message: "This workspace doesn't manage its own Telegram bot here.",
  fix: "Ask the workspace owner, or open Setup › Channels in your own workspace.",
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const failed = (respond: RespondFn, error: TelegramSetupError) =>
  respond(true, { ok: false, error });

function crash(respond: RespondFn, method: string, err: unknown) {
  const message = scrubToken(err instanceof Error ? err.message : String(err));
  log.warn(`${method} failed: ${message}`);
  failed(respond, setupErrors.unknown(message.slice(0, 240)));
}

/** Bot identity for the summary card, remembered per token so it costs one getMe. */
const botCache = new Map<string, { at: number; username: string | null; name: string | null }>();
const BOT_CACHE_MS = 10 * 60 * 1000;

function rememberBot(token: string | undefined, view: SessionView) {
  if (token) {
    botCache.set(token, { at: Date.now(), username: view.bot.username, name: view.bot.name });
  }
}

async function buildSummary(store: TelegramSetupStore, context: GatewayRequestContext) {
  const saved = store.read();
  const manager = getTelegramSetupManager();
  const runtime = context.getRuntimeSnapshot().channels.telegram;
  let bot: { username: string | null; name: string | null } | null = null;
  if (saved.token) {
    const hit = botCache.get(saved.token);
    bot =
      hit && Date.now() - hit.at < BOT_CACHE_MS ? { username: hit.username, name: hit.name } : null;
    if (!bot) {
      // First look after a restart: ask Telegram who the bot is (briefly).
      const looked = await Promise.race([
        lookupTelegramBot(saved.token).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
      ]);
      if (looked) {
        bot = { username: looked.username, name: looked.name };
        botCache.set(saved.token, { at: Date.now(), ...bot });
      }
    }
  }
  const running = saved.token ? manager.isLive(saved.token) : false;
  return {
    ok: true as const,
    connected: Boolean(saved.token),
    running,
    mode: saved.webhook ? "webhook" : "polling",
    tokenMasked: saved.token ? maskTelegramToken(saved.token) : null,
    tokenSource: saved.tokenSource,
    bot,
    owners: saved.owners,
    defaultChatId: saved.defaultChatId,
    groups: saved.groups,
    lastError: !running && runtime?.lastError ? scrubToken(String(runtime.lastError)) : null,
    storage: store.kind,
    note: store.note ?? null,
  };
}

async function withQr(view: SessionView) {
  const link = view.capture?.deepLink;
  if (!link || view.capture?.status !== "waiting") return { ok: true as const, ...view };
  let qr: string | null = null;
  try {
    qr = `data:image/png;base64,${await renderQrPngBase64(link, { scale: 5, marginModules: 2 })}`;
  } catch {
    qr = null;
  }
  return { ok: true as const, ...view, qr };
}

/** (Re)start the channel so the new token / allow-list is live without a gateway restart. */
async function restartChannel(context: GatewayRequestContext) {
  try {
    await context.stopChannel("telegram");
    await context.startChannel("telegram");
  } catch (err) {
    log.warn(`telegram channel restart failed: ${scrubToken(String(err))}`);
  }
}

export const telegramSetupHandlers: GatewayRequestHandlers = {
  "telegram.setup.summary": async ({ respond, context }) => {
    try {
      const store = resolveTelegramSetupStore();
      if (!store) return failed(respond, NOT_ALLOWED);
      respond(true, await buildSummary(store, context));
    } catch (err) {
      crash(respond, "summary", err);
    }
  },

  "telegram.setup.verify": async ({ params, respond }) => {
    try {
      const store = resolveTelegramSetupStore();
      if (!store) return failed(respond, NOT_ALLOWED);
      const useSaved = params.useSaved === true;
      const token = useSaved ? (store.read().token ?? "") : str(params.token);
      if (useSaved && !token) {
        return failed(respond, setupErrors.badFormat("No bot is saved yet. Paste a token first."));
      }
      const scope = telegramSetupScope();
      const res = await getTelegramSetupManager().verify(scope, {
        token,
        source: useSaved ? "saved" : "pasted",
      });
      if (!res.ok) return failed(respond, res.error);
      rememberBot(getTelegramSetupManager().tokenOf(scope, res.value.sessionId), res.value);
      respond(true, { ok: true, ...res.value });
    } catch (err) {
      crash(respond, "verify", err);
    }
  },

  "telegram.setup.deleteWebhook": async ({ params, respond }) => {
    try {
      const res = await getTelegramSetupManager().deleteWebhook(
        telegramSetupScope(),
        str(params.sessionId),
      );
      if (!res.ok) return failed(respond, res.error);
      log.info("removed another app's webhook during guided setup");
      respond(true, { ok: true, ...res.value });
    } catch (err) {
      crash(respond, "deleteWebhook", err);
    }
  },

  "telegram.setup.capture.start": async ({ params, respond }) => {
    try {
      const mode: CaptureMode = params.mode === "group" ? "group" : "dm";
      const res = await getTelegramSetupManager().startCapture(
        telegramSetupScope(),
        str(params.sessionId),
        mode,
      );
      if (!res.ok) return failed(respond, res.error);
      respond(true, await withQr(res.value));
    } catch (err) {
      crash(respond, "capture.start", err);
    }
  },

  "telegram.setup.capture.status": ({ params, respond }) => {
    const res = getTelegramSetupManager().get(telegramSetupScope(), str(params.sessionId));
    if (!res.ok) return failed(respond, res.error);
    respond(true, { ok: true, ...res.value });
  },

  "telegram.setup.capture.cancel": ({ params, respond }) => {
    const res = getTelegramSetupManager().cancelCapture(
      telegramSetupScope(),
      str(params.sessionId),
    );
    if (!res.ok) return failed(respond, res.error);
    respond(true, { ok: true, ...res.value });
  },

  "telegram.setup.manual": async ({ params, respond }) => {
    try {
      const res = await getTelegramSetupManager().manual(
        telegramSetupScope(),
        str(params.sessionId),
        { mode: params.mode === "group" ? "group" : "dm", id: str(params.id) },
      );
      if (!res.ok) return failed(respond, res.error);
      respond(true, { ok: true, ...res.value });
    } catch (err) {
      crash(respond, "manual", err);
    }
  },

  "telegram.setup.confirm": async ({ params, respond, context }) => {
    try {
      const store = resolveTelegramSetupStore();
      if (!store) return failed(respond, NOT_ALLOWED);
      const scope = telegramSetupScope();
      const manager = getTelegramSetupManager();
      const sessionId = str(params.sessionId);
      const token = manager.tokenOf(scope, sessionId);
      const res = manager.confirm(scope, sessionId);
      if (!res.ok || !token) return failed(respond, res.ok ? setupErrors.expired() : res.error);
      const { mode, found, view } = res.value;
      const newToken = store.read().token !== token;
      await store.apply({
        ...(newToken ? { token } : {}),
        botUsername: view.bot.username,
        ...(mode === "dm" && found.userId !== null
          ? { owner: { userId: found.userId, chatId: found.chatId } }
          : {}),
        ...(mode === "group"
          ? { group: { chatId: found.chatId, makeDefault: params.makeDefault === true } }
          : {}),
      });
      rememberBot(token, view);
      log.info(
        `guided setup saved (${mode === "dm" ? "owner" : "group"}) for @${view.bot.username ?? "bot"}`,
      );
      // Plugin loaded → swap the channel in place. Not loaded (first Telegram on
      // this install) → the config watcher reloads the gateway to load it, so
      // answer first: the socket is about to drop.
      // A store that doesn't drive this gateway's channel is only saved.
      const live = Boolean(getChannelPlugin("telegram"));
      if (live && store.controlsChannel) await restartChannel(context);
      respond(true, {
        ok: true,
        ...view,
        starting: !store.controlsChannel ? "saved" : live ? "live" : "reload",
        summary: await buildSummary(store, context),
      });
    } catch (err) {
      crash(respond, "confirm", err);
    }
  },

  "telegram.setup.test": async ({ params, respond }) => {
    try {
      const scope = telegramSetupScope();
      const manager = getTelegramSetupManager();
      const chatId = str(params.chatId) || undefined;
      let res = await manager.sendTest(scope, str(params.sessionId), chatId);
      if (!res.ok && res.error.code === "expired") {
        // No session (summary card, or the gateway reloaded): use the saved bot.
        const saved = resolveTelegramSetupStore()?.read();
        if (saved?.token) {
          const opened = await manager.verify(scope, { token: saved.token, source: "saved" });
          if (!opened.ok) return failed(respond, opened.error);
          res = await manager.sendTest(
            scope,
            opened.value.sessionId,
            chatId ?? saved.defaultChatId ?? undefined,
          );
        }
      }
      if (!res.ok) return failed(respond, res.error);
      respond(true, { ok: true, chatId: res.value.chatId });
    } catch (err) {
      crash(respond, "test", err);
    }
  },

  "telegram.setup.disconnect": async ({ params, respond, context }) => {
    try {
      const store = resolveTelegramSetupStore();
      if (!store) return failed(respond, NOT_ALLOWED);
      const sessionId = str(params.sessionId);
      if (sessionId) getTelegramSetupManager().close(telegramSetupScope(), sessionId);
      if (store.controlsChannel) await context.stopChannel("telegram").catch(() => undefined);
      await store.clear();
      log.info("telegram disconnected from guided setup");
      respond(true, await buildSummary(store, context));
    } catch (err) {
      crash(respond, "disconnect", err);
    }
  },
};
