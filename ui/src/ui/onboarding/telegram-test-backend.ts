/**
 * Test-mode backend for <telegram-setup>: walks the exact same guided steps
 * (create → verify → find → test) without a real bot, network or config
 * write. Used by the onboarding flow when opened with `?telegramTest=1`
 * (QA, demos, visual verification on a throwaway gateway).
 *
 * Any token shaped like a BotFather token works ("123456:ABC…"); the chat is
 * "found" on the second status poll.
 */
import type {
  TelegramSetupBackend,
  TgCapture,
  TgFound,
  TgResult,
  TgSession,
  TgSetupAction,
  TgSummary,
} from "../components/telegram-setup-backend";

const TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{20,}$/;

export function isTelegramTestMode(search: string = typeof location === "undefined" ? "" : location.search): boolean {
  try {
    return new URLSearchParams(search).get("telegramTest") === "1";
  } catch {
    return false;
  }
}

export function createTelegramTestBackend(): TelegramSetupBackend {
  const owner: TgFound = {
    userId: 4242,
    chatId: 4242,
    chatType: "private",
    chatTitle: null,
    username: "you",
    firstName: "You",
  };
  let summary: TgSummary = {
    connected: false,
    running: false,
    mode: "polling",
    tokenMasked: null,
    bot: null,
    owners: [],
    defaultChatId: null,
    groups: [],
    lastError: null,
    note: "Test mode: nothing is saved and no message is sent.",
  };
  let session: TgSession | null = null;
  let polls = 0;

  const ok = <T,>(v: T) => ({ ok: true, ...v }) as unknown as TgResult<T>;
  const err = <T,>(code: string, title: string, message: string, fix: string) =>
    ({ ok: false, error: { code, title, message, fix } }) as TgResult<T>;

  return {
    async call<T>(action: TgSetupAction, params: Record<string, unknown> = {}): Promise<TgResult<T>> {
      await new Promise((r) => setTimeout(r, 250));
      switch (action) {
        case "summary":
          return ok(summary) as TgResult<T>;
        case "verify": {
          const token = String(params.token ?? "");
          if (!params.useSaved && !TOKEN.test(token.trim())) {
            return err("bad_token", "That doesn't look like a bot token", "A token looks like 123456789:ABCdef… (numbers, a colon, then letters).", "Copy the whole token from BotFather and paste it again.");
          }
          session = {
            sessionId: `test-${Date.now()}`,
            bot: { id: 1, username: "my_infinibot_test_bot", name: "My InfiniBot (test)", avatar: null, canReadAllGroupMessages: false },
            tokenMasked: "123456:••••••",
            tokenSource: "pasted",
            webhookHost: null,
            channelLive: false,
            owner: null,
            groups: [],
            capture: null,
            qr: null,
          };
          return ok(session) as TgResult<T>;
        }
        case "deleteWebhook":
          return session ? (ok(session) as TgResult<T>) : err("no_session", "Start again", "The setup session ended.", "Paste the token again.");
        case "capture.start": {
          if (!session) return err("no_session", "Start again", "The setup session ended.", "Paste the token again.");
          polls = 0;
          const capture: TgCapture = {
            mode: (params.mode as "dm" | "group") ?? "dm",
            status: "waiting",
            transport: "polling",
            code: "IB-TEST",
            deepLink: "https://t.me/my_infinibot_test_bot?start=IB-TEST",
            expiresAt: Date.now() + 10 * 60_000,
            otherMessages: 0,
          };
          session = { ...session, capture };
          return ok(session) as TgResult<T>;
        }
        case "capture.status": {
          if (!session) return err("no_session", "Start again", "The setup session ended.", "Paste the token again.");
          if (session.capture?.status === "waiting" && ++polls >= 2) {
            session = { ...session, owner: owner, capture: { ...session.capture, status: "found", found: owner } };
          }
          return ok(session) as TgResult<T>;
        }
        case "capture.cancel":
          if (session?.capture) session = { ...session, capture: { ...session.capture, status: "cancelled" } };
          return ok(session ?? {}) as TgResult<T>;
        case "manual":
          if (!session) return err("no_session", "Start again", "The setup session ended.", "Paste the token again.");
          session = { ...session, owner, capture: session.capture ? { ...session.capture, status: "found", transport: "manual", found: owner } : null };
          return ok(session) as TgResult<T>;
        case "confirm":
          summary = {
            ...summary,
            connected: true,
            running: true,
            tokenMasked: "123456:••••••",
            bot: { username: "my_infinibot_test_bot", name: "My InfiniBot (test)" },
            owners: ["4242"],
            defaultChatId: "4242",
          };
          return ok({ ...(session ?? {}), summary, starting: "live" }) as TgResult<T>;
        case "test":
          return ok({ chatId: "4242" }) as TgResult<T>;
        case "disconnect":
          summary = { ...summary, connected: false, running: false, tokenMasked: null, bot: null, owners: [], defaultChatId: null };
          session = null;
          return ok(summary) as TgResult<T>;
        default:
          return err("unknown", "Not available in test mode", "This action isn't simulated.", "Turn off test mode.");
      }
    },
  };
}
