/**
 * Guided Telegram setup sessions (gateway memory only).
 *
 *   verify   token → getMe → a session. The token stays here; the browser only
 *            ever holds the session id and a masked token.
 *   capture  wait for the owner's first message, tied to a one-time start code:
 *              - channel not running for this token: short-lived getUpdates
 *                polling, only while the member waits, then it stops;
 *              - channel already running (long-poll or webhook): the running bot
 *                hands each update to offerUpdate() first (src/telegram/bot.ts),
 *                so webhook mode on hosted Machines is covered by the same hook.
 *   confirm  the found user / chat becomes the owner (or an added group).
 *
 * A capture closes after CAPTURE_TTL_MS; a session after SESSION_TTL_MS idle.
 * Sessions belong to a scope (the tenant namespace, or "local"): one tenant can
 * never read or drive another's session.
 */
import { randomBytes } from "node:crypto";
import { classifyTelegramSetupError, setupErrors, type TelegramSetupError } from "./errors.js";
import type { SetupBotApi, SetupBotApiFactory, SetupBotInfo } from "./bot-api.js";
import {
  generateStartCode,
  matchStartCode,
  type CaptureMode,
  type CapturedChat,
} from "./start-code.js";
import { checkTelegramTokenFormat, maskTelegramToken } from "./token-format.js";

export const CAPTURE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS_PER_SCOPE = 4;
const MAX_POLL_NETWORK_RETRIES = 4;

export const FOUND_REPLY = "👋 Found you! Go back to InfiniBot to finish setting up.";
export const TEST_MESSAGE = "✅ InfiniBot is connected";

export type CaptureStatus = "waiting" | "found" | "expired" | "cancelled" | "error";
export type CaptureTransport = "polling" | "live" | "manual";

interface Capture {
  mode: CaptureMode;
  code: string;
  status: CaptureStatus;
  transport: CaptureTransport;
  startedAt: number;
  expiresAt: number;
  found?: CapturedChat;
  /** Messages that arrived without the code (shown as a hint, never who sent them). */
  otherMessages: number;
  error?: TelegramSetupError;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

interface Session {
  id: string;
  scope: string;
  token: string;
  tokenSource: "pasted" | "saved";
  bot: SetupBotInfo;
  avatar: string | null;
  webhookUrl: string | null;
  api: SetupBotApi;
  touchedAt: number;
  owner?: CapturedChat;
  groups: CapturedChat[];
  capture?: Capture;
}

export interface CaptureView {
  mode: CaptureMode;
  status: CaptureStatus;
  transport: CaptureTransport;
  code: string;
  deepLink: string | null;
  expiresAt: number;
  found?: CapturedChat;
  otherMessages: number;
  error?: TelegramSetupError;
}

export interface SessionView {
  sessionId: string;
  bot: SetupBotInfo & { avatar: string | null };
  tokenMasked: string;
  tokenSource: "pasted" | "saved";
  /** Another app's webhook is set on this bot (host only; the URL may hold a secret). */
  webhookHost: string | null;
  channelLive: boolean;
  owner: CapturedChat | null;
  groups: CapturedChat[];
  capture: CaptureView | null;
}

export type SetupResult<T> = { ok: true; value: T } | { ok: false; error: TelegramSetupError };

export interface SetupManagerDeps {
  createApi: SetupBotApiFactory;
  now?: () => number;
  captureTtlMs?: number;
  sessionTtlMs?: number;
  /** getUpdates long-poll seconds. */
  pollTimeoutSec?: number;
  retryDelayMs?: number;
}

const fail = <T>(error: TelegramSetupError): SetupResult<T> => ({ ok: false, error });
const done = <T>(value: T): SetupResult<T> => ({ ok: true, value });

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return "another app";
  }
}

export class TelegramSetupManager {
  private readonly sessions = new Map<string, Session>();
  /** Tokens a running channel (long-poll or webhook) is consuming updates for. */
  private readonly liveTokens = new Map<string, number>();
  private readonly now: () => number;
  private readonly captureTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly pollTimeoutSec: number;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: SetupManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.captureTtlMs = deps.captureTtlMs ?? CAPTURE_TTL_MS;
    this.sessionTtlMs = deps.sessionTtlMs ?? SESSION_TTL_MS;
    this.pollTimeoutSec = deps.pollTimeoutSec ?? 8;
    this.retryDelayMs = deps.retryDelayMs ?? 1500;
  }

  // ── running channel hooks ────────────────────────────────────────────────

  /** The channel started consuming updates for `token`. Returns the matching "stopped" call. */
  markLive(token: string): () => void {
    this.liveTokens.set(token, (this.liveTokens.get(token) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.liveTokens.get(token) ?? 1) - 1;
      if (left <= 0) this.liveTokens.delete(token);
      else this.liveTokens.set(token, left);
    };
  }

  isLive(token: string): boolean {
    return this.liveTokens.has(token);
  }

  /**
   * Called by the running bot for every update (long-poll and webhook).
   * True = the update was a setup start message and has been used up.
   */
  offerUpdate(token: string, update: unknown): boolean {
    for (const session of this.sessions.values()) {
      if (session.token !== token) continue;
      if (this.consider(session, update)) return true;
    }
    return false;
  }

  // ── verify ───────────────────────────────────────────────────────────────

  async verify(
    scope: string,
    input: { token: string; source: "pasted" | "saved" },
  ): Promise<SetupResult<SessionView>> {
    const format = checkTelegramTokenFormat(input.token);
    if (!format.ok) return fail(setupErrors.badFormat(format.message));
    const api = this.deps.createApi(format.token);
    let bot: SetupBotInfo;
    try {
      bot = await api.getMe();
    } catch (err) {
      return fail(classifyTelegramSetupError(err));
    }
    const [webhookUrl, avatar] = await Promise.all([
      api.getWebhookUrl().catch(() => null),
      api.avatar(bot.id).catch(() => null),
    ]);
    this.sweep();
    // One session per bot per scope: starting over replaces the old one.
    for (const old of Array.from(this.sessions.values())) {
      if (old.scope === scope && old.token === format.token) this.drop(old);
    }
    const mine = [...this.sessions.values()]
      .filter((s) => s.scope === scope)
      .sort((a, b) => a.touchedAt - b.touchedAt);
    while (mine.length >= MAX_SESSIONS_PER_SCOPE) this.drop(mine.shift() as Session);

    const session: Session = {
      id: randomBytes(18).toString("base64url"),
      scope,
      token: format.token,
      tokenSource: input.source,
      bot,
      avatar,
      webhookUrl,
      api,
      touchedAt: this.now(),
      groups: [],
    };
    this.sessions.set(session.id, session);
    return done(this.view(session));
  }

  get(scope: string, sessionId: string): SetupResult<SessionView> {
    const session = this.find(scope, sessionId);
    return session ? done(this.view(session)) : fail(setupErrors.expired());
  }

  /** The verified token of a session (gateway side only: to save it). */
  tokenOf(scope: string, sessionId: string): string | undefined {
    return this.find(scope, sessionId)?.token;
  }

  async deleteWebhook(scope: string, sessionId: string): Promise<SetupResult<SessionView>> {
    const session = this.find(scope, sessionId);
    if (!session) return fail(setupErrors.expired());
    try {
      await session.api.deleteWebhook();
      session.webhookUrl = await session.api.getWebhookUrl().catch(() => null);
    } catch (err) {
      return fail(classifyTelegramSetupError(err));
    }
    return done(this.view(session));
  }

  // ── capture ──────────────────────────────────────────────────────────────

  async startCapture(
    scope: string,
    sessionId: string,
    mode: CaptureMode,
  ): Promise<SetupResult<SessionView>> {
    const session = this.find(scope, sessionId);
    if (!session) return fail(setupErrors.expired());
    this.stopCapture(session, "cancelled");

    const live = this.isLive(session.token);
    if (!live) {
      // Another app's webhook makes getUpdates fail with 409: say so up front.
      try {
        session.webhookUrl = await session.api.getWebhookUrl();
      } catch (err) {
        return fail(classifyTelegramSetupError(err));
      }
      if (session.webhookUrl) return fail(setupErrors.webhookActive(hostOf(session.webhookUrl)));
    }

    const startedAt = this.now();
    const capture: Capture = {
      mode,
      code: generateStartCode(),
      status: "waiting",
      transport: live ? "live" : "polling",
      startedAt,
      expiresAt: startedAt + this.captureTtlMs,
      otherMessages: 0,
      abort: new AbortController(),
    };
    capture.timer = setTimeout(() => {
      if (capture.status === "waiting") this.finish(capture, "expired");
    }, this.captureTtlMs);
    capture.timer.unref?.();
    session.capture = capture;
    if (!live) void this.poll(session, capture);
    return done(this.view(session));
  }

  cancelCapture(scope: string, sessionId: string): SetupResult<SessionView> {
    const session = this.find(scope, sessionId);
    if (!session) return fail(setupErrors.expired());
    this.stopCapture(session, "cancelled");
    return done(this.view(session));
  }

  /** Manual fallback: the member typed an id. Checked with getChat before it counts. */
  async manual(
    scope: string,
    sessionId: string,
    input: { mode: CaptureMode; id: string },
  ): Promise<SetupResult<SessionView>> {
    const session = this.find(scope, sessionId);
    if (!session) return fail(setupErrors.expired());
    const raw = input.id.trim();
    const dm = input.mode === "dm";
    if (!(dm ? /^\d{4,15}$/ : /^-\d{4,16}$/).test(raw)) {
      return fail({
        code: "bad_format",
        title: "That ID doesn't look right",
        message: dm
          ? "A Telegram user ID is only numbers, like 123456789."
          : "A group ID starts with a minus sign, like -1001234567890.",
        fix: dm
          ? "Message @userinfobot in Telegram. It replies with your ID. Copy only the number."
          : "Use the automatic way above, or add @userinfobot to the group to read its ID.",
      });
    }
    let chat;
    try {
      chat = await session.api.getChat(raw);
    } catch (err) {
      return fail(classifyTelegramSetupError(err));
    }
    this.stopCapture(session, "cancelled");
    const now = this.now();
    session.capture = {
      mode: input.mode,
      code: "",
      status: "found",
      transport: "manual",
      startedAt: now,
      expiresAt: now + this.captureTtlMs,
      otherMessages: 0,
      abort: new AbortController(),
      found: {
        userId: dm ? chat.id : null,
        chatId: chat.id,
        chatType: (dm ? "private" : chat.type) as CapturedChat["chatType"],
        chatTitle: chat.title,
        username: chat.username,
        firstName: chat.firstName,
      },
    };
    return done(this.view(session));
  }

  /** Accept what the capture found. Returns it so the caller can save it. */
  confirm(
    scope: string,
    sessionId: string,
  ): SetupResult<{ mode: CaptureMode; found: CapturedChat; view: SessionView }> {
    const session = this.find(scope, sessionId);
    if (!session) return fail(setupErrors.expired());
    const capture = session.capture;
    if (!capture || capture.status !== "found" || !capture.found) {
      return fail({
        code: "not_found",
        title: "Nothing to confirm yet",
        message: "InfiniBot hasn't seen your message yet.",
        fix: "Open your bot with the link, press Start, and wait for “Found you”.",
      });
    }
    const found = capture.found;
    if (capture.mode === "dm") session.owner = found;
    else if (!session.groups.some((g) => g.chatId === found.chatId)) session.groups.push(found);
    session.capture = undefined;
    return done({ mode: capture.mode, found, view: this.view(session) });
  }

  async sendTest(
    scope: string,
    sessionId: string,
    chatId?: number | string,
  ): Promise<SetupResult<{ chatId: string }>> {
    const session = this.find(scope, sessionId);
    if (!session) return fail(setupErrors.expired());
    const target = chatId ?? session.owner?.chatId ?? session.groups[0]?.chatId;
    if (target === undefined) {
      return fail({
        code: "not_found",
        title: "No chat to send to yet",
        message: "InfiniBot doesn't know your Telegram chat yet.",
        fix: "Go back one step and let InfiniBot find you first.",
      });
    }
    try {
      await session.api.sendMessage(target, TEST_MESSAGE);
    } catch (err) {
      return fail(classifyTelegramSetupError(err));
    }
    return done({ chatId: String(target) });
  }

  close(scope: string, sessionId: string): void {
    const session = this.find(scope, sessionId);
    if (session) this.drop(session);
  }

  /** Stop everything (gateway shutdown, tests). */
  dispose(): void {
    for (const session of Array.from(this.sessions.values())) this.drop(session);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private find(scope: string, sessionId: string): Session | undefined {
    this.sweep();
    const session = this.sessions.get(String(sessionId ?? ""));
    if (!session || session.scope !== scope) return undefined;
    session.touchedAt = this.now();
    return session;
  }

  private sweep(): void {
    const cutoff = this.now() - this.sessionTtlMs;
    for (const session of Array.from(this.sessions.values())) {
      if (session.touchedAt < cutoff) this.drop(session);
    }
  }

  private drop(session: Session): void {
    this.stopCapture(session, "cancelled");
    this.sessions.delete(session.id);
  }

  private stopCapture(session: Session, status: CaptureStatus): void {
    const capture = session.capture;
    if (capture && capture.status === "waiting") this.finish(capture, status);
  }

  private finish(capture: Capture, status: CaptureStatus, error?: TelegramSetupError): void {
    capture.status = status;
    if (error) capture.error = error;
    if (capture.timer) clearTimeout(capture.timer);
    capture.abort.abort();
  }

  /** Check one update against the session's waiting capture. */
  private consider(session: Session, update: unknown): boolean {
    const capture = session.capture;
    if (!capture || capture.status !== "waiting") return false;
    if (this.now() >= capture.expiresAt) {
      this.finish(capture, "expired");
      return false;
    }
    const result = matchStartCode(update, {
      code: capture.code,
      mode: capture.mode,
      // Telegram dates are whole seconds; allow a little clock drift.
      notBefore: Math.floor(capture.startedAt / 1000) - 30,
      ownerUserId: session.owner?.userId ?? null,
    });
    if (!result.match) {
      if (result.reason === "no-code" || result.reason === "wrong-sender") {
        capture.otherMessages += 1;
      }
      return false;
    }
    capture.found = result.found;
    this.finish(capture, "found");
    void session.api.sendMessage(result.found.chatId, FOUND_REPLY).catch(() => undefined);
    return true;
  }

  private async poll(session: Session, capture: Capture): Promise<void> {
    const signal = capture.abort.signal;
    let offset: number | undefined;
    let networkFailures = 0;
    while (capture.status === "waiting" && !signal.aborted) {
      let updates: Array<{ update_id: number }>;
      try {
        updates = await session.api.getUpdates({ offset, timeout: this.pollTimeoutSec }, signal);
        networkFailures = 0;
      } catch (err) {
        if (signal.aborted || capture.status !== "waiting") return;
        const error = classifyTelegramSetupError(err);
        if (error.code === "network" && ++networkFailures <= MAX_POLL_NETWORK_RETRIES) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          continue;
        }
        this.finish(capture, "error", error);
        return;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        if (this.consider(session, update)) break;
      }
      if ((capture.status as CaptureStatus) === "found" && offset !== undefined) {
        // Tell Telegram the start message is handled, so the channel that starts
        // next doesn't see "/start <code>" again.
        await session.api.getUpdates({ offset, timeout: 0, limit: 1 }).catch(() => undefined);
      }
    }
  }

  private view(session: Session): SessionView {
    const c = session.capture;
    const username = session.bot.username;
    return {
      sessionId: session.id,
      bot: { ...session.bot, avatar: session.avatar },
      tokenMasked: maskTelegramToken(session.token),
      tokenSource: session.tokenSource,
      webhookHost: this.isLive(session.token) ? null : hostOf(session.webhookUrl),
      channelLive: this.isLive(session.token),
      owner: session.owner ?? null,
      groups: [...session.groups],
      capture: c
        ? {
            mode: c.mode,
            status: c.status,
            transport: c.transport,
            code: c.code,
            deepLink:
              username && c.code
                ? `https://t.me/${username}?${c.mode === "dm" ? "start" : "startgroup"}=${c.code}`
                : null,
            expiresAt: c.expiresAt,
            ...(c.found ? { found: c.found } : {}),
            otherMessages: c.otherMessages,
            ...(c.error ? { error: c.error } : {}),
          }
        : null,
    };
  }
}
