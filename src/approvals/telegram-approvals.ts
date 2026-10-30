/**
 * Telegram delivery + resolution for the unified approval registry.
 *
 *   registry "requested" ─► queue ─► (burst window) ─► one card, or a digest
 *                                                      with per-item buttons
 *   operator taps  apv:<code>:<id>  ─► from.id checked ─► resolveApprovalRequest
 *   registry "resolved" (any surface / expiry) ─► edit every message in place
 *
 * Only the configured operator's taps / replies count (fail closed: no
 * operator id configured → nothing resolves from Telegram). Messages only ever
 * go to the configured operator chat — never to the chat the request came from.
 *
 * Transport is injected so tests (and the stub-server harness) never touch the
 * real Bot API. In the gateway the running bot's `api` is registered by
 * monitor.ts; if the bot isn't running we fall back to the one-shot send
 * helpers (skipped entirely under INFINIBOT_SKIP_CHANNELS so side gateways
 * can't message the owner).
 */

import { loadConfig, type InfinibotConfig } from "../config/config.js";
import type { TelegramApprovalsConfig } from "../config/types.approvals.js";
import {
  attachTelegramMessage,
  getApprovalRequest,
  listApprovalRequests,
  onApprovalEvent,
  resolveApprovalRequest,
  type ApprovalAction,
  type ApprovalEvent,
  type ApprovalRecord,
  type ApprovalRisk,
} from "../autonomy/approval-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildDeepLink } from "../notifications/links.js";
import { gatewayWebUrl } from "../notifications/public-base.js";
import { resolveOwnerTelegramChatId } from "../telegram/owner-chat.js";
import {
  CB,
  DIGEST_MAX_ITEMS,
  buildCardKeyboard,
  escapeHtml,
  formatApprovalCard,
  formatDigest,
  formatNoteCaptured,
  formatReplyPrompt,
  formatResolvedCard,
  parseApprovalCallback,
  type InlineKeyboard,
} from "./telegram-format.js";

const log = createSubsystemLogger("approvals/telegram");

// ── Transport ──────────────────────────────────────────────────────────────

export interface ApprovalTelegramTransport {
  send(
    chatId: string,
    html: string,
    opts?: { keyboard?: InlineKeyboard; forceReply?: boolean; replyTo?: number },
  ): Promise<{ messageId: number }>;
  /** `keyboard: null` removes the buttons. */
  edit(
    chatId: string,
    messageId: number,
    html: string,
    keyboard: InlineKeyboard | null,
  ): Promise<void>;
}

/** Minimal slice of grammy's Api we use. */
export interface GrammyLikeApi {
  sendMessage(
    chatId: string | number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
}

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const NOT_MODIFIED_RE = /message is not modified/i;

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Transport over a grammy Api (the running bot, or a stub-server Api in tests). */
export function createGrammyApprovalTransport(api: GrammyLikeApi): ApprovalTelegramTransport {
  return {
    async send(chatId, html, opts) {
      const markup = opts?.forceReply
        ? { force_reply: true, selective: true, input_field_placeholder: "Your note…" }
        : opts?.keyboard?.length
          ? { inline_keyboard: opts.keyboard }
          : undefined;
      const other: Record<string, unknown> = {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(markup ? { reply_markup: markup } : {}),
        ...(opts?.replyTo
          ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
          : {}),
      };
      try {
        const res = await api.sendMessage(chatId, html, other);
        return { messageId: res.message_id };
      } catch (err) {
        if (!PARSE_ERR_RE.test(String(err))) throw err;
        const { parse_mode: _pm, ...plain } = other;
        const res = await api.sendMessage(chatId, stripHtml(html), plain);
        return { messageId: res.message_id };
      }
    },
    async edit(chatId, messageId, html, keyboard) {
      const other: Record<string, unknown> = {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      };
      try {
        await api.editMessageText(chatId, messageId, html, other);
      } catch (err) {
        const msg = String(err);
        if (NOT_MODIFIED_RE.test(msg)) return;
        if (!PARSE_ERR_RE.test(msg)) throw err;
        const { parse_mode: _pm, ...plain } = other;
        await api.editMessageText(chatId, messageId, stripHtml(html), plain);
      }
    },
  };
}

const registeredApis = new Map<string, GrammyLikeApi>();

/** Called by the Telegram monitor once its bot exists. */
export function registerApprovalTelegramApi(accountId: string, api: GrammyLikeApi): () => void {
  registeredApis.set(accountId, api);
  return () => {
    if (registeredApis.get(accountId) === api) registeredApis.delete(accountId);
  };
}

function pickRegisteredApi(accountId?: string): GrammyLikeApi | undefined {
  if (accountId && registeredApis.has(accountId)) return registeredApis.get(accountId);
  return registeredApis.get("default") ?? registeredApis.values().next().value;
}

/**
 * Default transport: the running bot when registered, else a fresh Bot built
 * from config (never when INFINIBOT_SKIP_CHANNELS is set).
 */
export function createDefaultApprovalTransport(accountId?: string): ApprovalTelegramTransport {
  const resolveApi = async (): Promise<GrammyLikeApi> => {
    const registered = pickRegisteredApi(accountId);
    if (registered) return registered;
    if (
      process.env.INFINIBOT_SKIP_CHANNELS === "1" ||
      process.env.INFINIBOT_SKIP_CHANNELS === "true"
    ) {
      throw new Error(
        "telegram approvals: channels skipped (INFINIBOT_SKIP_CHANNELS) — not sending",
      );
    }
    const [{ Bot }, { resolveTelegramAccount }] = await Promise.all([
      import("grammy"),
      import("../telegram/accounts.js"),
    ]);
    const account = resolveTelegramAccount({ cfg: loadConfig(), accountId });
    if (!account.token) throw new Error("telegram approvals: no bot token configured");
    return new Bot(account.token).api as unknown as GrammyLikeApi;
  };
  return {
    async send(chatId, html, opts) {
      return createGrammyApprovalTransport(await resolveApi()).send(chatId, html, opts);
    },
    async edit(chatId, messageId, html, keyboard) {
      return createGrammyApprovalTransport(await resolveApi()).edit(
        chatId,
        messageId,
        html,
        keyboard,
      );
    },
  };
}

// ── Config ─────────────────────────────────────────────────────────────────

export interface ResolvedTelegramApprovals {
  enabled: boolean;
  chatId: string | null;
  /** Numeric Telegram user ids allowed to decide. */
  operatorIds: Set<string>;
  /** Lower-cased usernames (without @) allowed to decide. */
  operatorUsernames: Set<string>;
  accountId?: string;
  sources: Set<string> | null;
  minRisk: ApprovalRisk;
  digestWindowMs: number;
  minIntervalMs: number;
  timeZone?: string;
}

const RISK_ORDER: ApprovalRisk[] = ["low", "medium", "high", "critical"];

function normalizeOperatorEntry(raw: unknown): { id?: string; username?: string } | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/^(tg|telegram):/i, "");
  if (!s || s === "*") return null;
  if (/^\d+$/.test(s)) return { id: s };
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,}$/.test(s))
    return { username: s.replace(/^@/, "").toLowerCase() };
  return null;
}

export function resolveTelegramApprovalsConfig(cfg: InfinibotConfig): ResolvedTelegramApprovals {
  const ac: TelegramApprovalsConfig = cfg.approvals?.telegram ?? {};
  const tg = cfg.channels?.telegram;
  const chatId = ac.chatId ? String(ac.chatId).trim() : resolveOwnerTelegramChatId(tg);
  const operatorIds = new Set<string>();
  const operatorUsernames = new Set<string>();
  const add = (raw: unknown) => {
    const e = normalizeOperatorEntry(raw);
    if (e?.id) operatorIds.add(e.id);
    if (e?.username) operatorUsernames.add(e.username);
  };
  if (Array.isArray(ac.operatorIds) && ac.operatorIds.length > 0) {
    ac.operatorIds.forEach(add);
  } else {
    // Owner convention used across the codebase: allowFrom[0]; plus a private
    // defaultChatId (positive numeric chat id == the user's id).
    const first = Array.isArray(tg?.allowFrom)
      ? tg.allowFrom.find((x) => String(x ?? "").trim() && String(x) !== "*")
      : undefined;
    if (first !== undefined) add(first);
    if (tg?.defaultChatId !== undefined && /^\d+$/.test(String(tg.defaultChatId).trim())) {
      add(tg.defaultChatId);
    }
  }
  const tz = (cfg.agents?.defaults as { userTimezone?: string } | undefined)?.userTimezone;
  return {
    enabled: ac.enabled !== false && Boolean(chatId),
    chatId: chatId ?? null,
    operatorIds,
    operatorUsernames,
    accountId: ac.accountId,
    sources: Array.isArray(ac.sources) && ac.sources.length ? new Set(ac.sources) : null,
    minRisk: RISK_ORDER.includes(ac.minRisk as ApprovalRisk) ? (ac.minRisk as ApprovalRisk) : "low",
    digestWindowMs: clampNum(ac.digestWindowMs, 0, 60_000, 1500),
    minIntervalMs: clampNum(ac.minIntervalMs, 0, 300_000, 3000),
    timeZone: tz,
  };
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
}

export function isAuthorizedOperator(
  conf: Pick<ResolvedTelegramApprovals, "operatorIds" | "operatorUsernames">,
  from: { id?: number | string | null; username?: string | null } | null | undefined,
): boolean {
  if (!from) return false;
  const id = from.id !== undefined && from.id !== null ? String(from.id) : "";
  if (id && conf.operatorIds.has(id)) return true;
  // Usernames are only a fallback when no numeric operator id is configured.
  if (conf.operatorIds.size === 0 && from.username) {
    return conf.operatorUsernames.has(from.username.toLowerCase());
  }
  return false;
}

function shouldDeliver(conf: ResolvedTelegramApprovals, rec: ApprovalRecord): boolean {
  if (!conf.enabled || !conf.chatId) return false;
  if (conf.sources && !conf.sources.has(rec.source)) return false;
  return RISK_ORDER.indexOf(rec.risk) >= RISK_ORDER.indexOf(conf.minRisk);
}

// ── Notifier ───────────────────────────────────────────────────────────────

export interface TelegramApprovalNotifierDeps {
  getConfig: () => InfinibotConfig;
  transport?: ApprovalTelegramTransport;
  now?: () => number;
  /** Web opener URL for a deep link (default: the gateway's public base; null = no link). */
  webUrlFor?: (deepLink: string) => string | null;
}

export interface CallbackInput {
  data: string;
  from: { id?: number | string | null; username?: string | null } | null | undefined;
  chatId: string | number;
  messageId?: number;
  /** When provided (bot context) replies go through this api. */
  transport?: ApprovalTelegramTransport;
}

export interface CallbackOutcome {
  handled: boolean;
  /** Short text for answerCallbackQuery (toast). */
  toast?: string;
}

export interface TextInput {
  chatId: string | number;
  from: { id?: number | string | null; username?: string | null } | null | undefined;
  text: string;
  transport?: ApprovalTelegramTransport;
}

const NOTE_WINDOW_MS = 10 * 60_000;

export function createTelegramApprovalNotifier(deps: TelegramApprovalNotifierDeps) {
  const now = deps.now ?? (() => Date.now());
  let queue: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = 0;
  let digestSeq = 0;
  /** chatId → awaiting a note for approval id. */
  const awaitingNote = new Map<string, { id: string; fromId: string; expiresAt: number }>();
  /** approval id → captured note awaiting Approve/Deny. */
  const stashedNotes = new Map<string, string>();
  let chain: Promise<void> = Promise.resolve();

  const conf = () => resolveTelegramApprovalsConfig(deps.getConfig());
  const webUrlFor = (deepLink: string): string | null => {
    try {
      return deps.webUrlFor ? deps.webUrlFor(deepLink) : gatewayWebUrl(deepLink, deps.getConfig());
    } catch {
      return null;
    }
  };
  const transportFor = (c: ResolvedTelegramApprovals) =>
    deps.transport ?? createDefaultApprovalTransport(c.accountId);

  /** Serialize all Telegram I/O so edits never race sends. */
  const enqueueIO = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).catch((err) => {
      log.warn(`telegram approvals I/O failed: ${String(err)}`);
    });
    return chain;
  };

  function scheduleFlush(c: ResolvedTelegramApprovals): void {
    if (flushTimer) return;
    const t = now();
    const at = Math.max(t + c.digestWindowMs, lastSentAt + c.minIntervalMs);
    flushTimer = setTimeout(
      () => {
        flushTimer = null;
        void flush();
      },
      Math.max(0, at - t),
    );
    (flushTimer as { unref?: () => void }).unref?.();
  }

  async function flush(): Promise<void> {
    const c = conf();
    const ids = queue;
    queue = [];
    const recs = ids
      .map((id) => getApprovalRequest(id))
      .filter((r): r is ApprovalRecord => Boolean(r && r.status === "pending"));
    if (!recs.length || !c.chatId) return;
    const transport = transportFor(c);
    const chatId = c.chatId;
    await enqueueIO(async () => {
      if (recs.length === 1) {
        await sendCard(transport, chatId, recs[0], c);
      } else {
        for (let i = 0; i < recs.length; i += DIGEST_MAX_ITEMS) {
          await sendDigest(transport, chatId, recs.slice(i, i + DIGEST_MAX_ITEMS), c);
        }
      }
      lastSentAt = now();
    });
  }

  async function sendCard(
    transport: ApprovalTelegramTransport,
    chatId: string,
    rec: ApprovalRecord,
    c: ResolvedTelegramApprovals,
    replyTo?: number,
  ): Promise<void> {
    const webUrl = webUrlFor(buildDeepLink({ kind: "approval", id: rec.id }));
    const { messageId } = await transport.send(
      chatId,
      formatApprovalCard(rec, { now: now(), timeZone: c.timeZone, webUrl }),
      { keyboard: buildCardKeyboard(rec, { webUrl }), replyTo },
    );
    attachTelegramMessage(rec.id, { chatId, messageId, kind: "single" });
    // The request might have been resolved while we were sending.
    const fresh = getApprovalRequest(rec.id);
    if (fresh && fresh.status !== "pending") await renderResolved(transport, fresh, c);
  }

  async function sendDigest(
    transport: ApprovalTelegramTransport,
    chatId: string,
    recs: ApprovalRecord[],
    c: ResolvedTelegramApprovals,
  ): Promise<void> {
    digestSeq += 1;
    const digestId = `dg${now().toString(36)}${digestSeq}`;
    const { text, keyboard } = formatDigest(recs, {
      now: now(),
      timeZone: c.timeZone,
      webUrl: webUrlFor(buildDeepLink({ kind: "approval" })),
    });
    const { messageId } = await transport.send(chatId, text, { keyboard });
    for (const r of recs)
      attachTelegramMessage(r.id, { chatId, messageId, kind: "digest", digestId });
    if (recs.some((r) => getApprovalRequest(r.id)?.status !== "pending")) {
      await rerenderDigest(transport, chatId, messageId, digestId, c);
    }
  }

  async function rerenderDigest(
    transport: ApprovalTelegramTransport,
    chatId: string,
    messageId: number,
    digestId: string,
    c: ResolvedTelegramApprovals,
  ): Promise<void> {
    const members = listApprovalRequests({ status: "all" })
      .filter((r) => r.telegram?.some((m) => m.digestId === digestId))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!members.length) return;
    const { text, keyboard } = formatDigest(members, {
      now: now(),
      timeZone: c.timeZone,
      webUrl: webUrlFor(buildDeepLink({ kind: "approval" })),
    });
    await transport.edit(chatId, messageId, text, keyboard.length ? keyboard : null);
  }

  async function renderResolved(
    transport: ApprovalTelegramTransport,
    rec: ApprovalRecord,
    c: ResolvedTelegramApprovals,
  ): Promise<void> {
    const seenDigests = new Set<string>();
    for (const m of rec.telegram ?? []) {
      if (m.kind === "digest" && m.digestId) {
        if (seenDigests.has(m.digestId)) continue;
        seenDigests.add(m.digestId);
        await rerenderDigest(transport, m.chatId, m.messageId, m.digestId, c).catch((err) =>
          log.warn(`digest edit failed: ${String(err)}`),
        );
      } else {
        await transport
          .edit(m.chatId, m.messageId, formatResolvedCard(rec, { timeZone: c.timeZone }), null)
          .catch((err) => log.warn(`card edit failed: ${String(err)}`));
      }
    }
  }

  function handleEvent(event: ApprovalEvent): void {
    const c = conf();
    if (event.type === "requested") {
      if (!shouldDeliver(c, event.record)) return;
      queue.push(event.record.id);
      scheduleFlush(c);
      return;
    }
    // resolved: drop from queue (never announce something already decided)
    queue = queue.filter((id) => id !== event.record.id);
    stashedNotes.delete(event.record.id);
    for (const [chat, w] of awaitingNote) if (w.id === event.record.id) awaitingNote.delete(chat);
    if (!event.record.telegram?.length) return;
    const rec = event.record;
    void enqueueIO(() => renderResolved(transportFor(c), rec, c));
  }

  function actorLabel(from: CallbackInput["from"]): string {
    if (from?.username) return `@${from.username}`;
    return from?.id !== undefined && from?.id !== null ? `tg:${from.id}` : "telegram";
  }

  function toastFor(res: ReturnType<typeof resolveApprovalRequest>): string {
    if (res.ok) {
      return res.record.status === "approved"
        ? "Approved ✅"
        : res.record.status === "redirected"
          ? "Redirected ↪️"
          : "Denied ❌";
    }
    if (res.error === "already_resolved" && res.record) {
      return `Already ${res.record.status} by ${res.record.decidedBy ?? "someone"}`;
    }
    if (res.error === "option_not_allowed") return "That option isn't available here";
    if (res.error === "not_authorized") return res.message ?? "Not authorized";
    return "This approval no longer exists";
  }

  async function handleCallback(input: CallbackInput): Promise<CallbackOutcome> {
    const parsed = parseApprovalCallback(input.data);
    if (!parsed) return { handled: false };
    const c = conf();
    if (!isAuthorizedOperator(c, input.from)) {
      log.warn(
        `ignored approval tap from unauthorized telegram user ${String(input.from?.id ?? "?")}`,
      );
      return { handled: true, toast: "Not authorized" };
    }
    const transport = input.transport ?? transportFor(c);
    const chatId = String(input.chatId);
    const rec = getApprovalRequest(parsed.id);
    if (!rec) return { handled: true, toast: "This approval no longer exists" };

    const decide = (action: ApprovalAction, note?: string) => {
      const res = resolveApprovalRequest(rec.id, {
        action,
        note: note ?? null,
        by: actorLabel(input.from),
        via: "telegram",
        // In-process callback from an operator-checked tap (isAuthorizedOperator).
        actor: { kind: "telegram-callback" },
      });
      // A stale button on a message that never got the resolved edit: fix it.
      if (!res.ok && res.error === "already_resolved" && res.record && input.messageId) {
        const r = res.record;
        void enqueueIO(() => renderResolved(transport, r, c));
      }
      return { handled: true, toast: toastFor(res) };
    };

    switch (parsed.code) {
      case CB.approve:
        return decide("approve");
      case CB.approveAlways:
        return decide("approve-always");
      case CB.deny:
        return decide("deny");
      case CB.approveWithNote:
        return decide("approve", stashedNotes.get(rec.id));
      case CB.denyWithNote:
        return decide("deny", stashedNotes.get(rec.id));
      case CB.view: {
        if (rec.status !== "pending")
          return {
            handled: true,
            toast: toastFor({ ok: false, error: "already_resolved", record: rec }),
          };
        await enqueueIO(() => sendCard(transport, chatId, rec, c, input.messageId));
        return { handled: true };
      }
      case CB.reply: {
        if (rec.status !== "pending")
          return {
            handled: true,
            toast: toastFor({ ok: false, error: "already_resolved", record: rec }),
          };
        awaitingNote.set(chatId, {
          id: rec.id,
          fromId: String(input.from?.id ?? ""),
          expiresAt: now() + NOTE_WINDOW_MS,
        });
        await enqueueIO(async () => {
          await transport.send(chatId, formatReplyPrompt(rec), {
            forceReply: true,
            replyTo: input.messageId,
          });
        });
        return {
          handled: true,
          toast: rec.options.includes("redirect") ? "Send the new instructions" : "Send your note",
        };
      }
      default:
        return { handled: true };
    }
  }

  /**
   * Consume the operator's next text message after a ✍️ tap. Returns true when
   * the message was an approval note (so the normal agent pipeline skips it).
   */
  async function handleText(input: TextInput): Promise<boolean> {
    const chatId = String(input.chatId);
    const waiting = awaitingNote.get(chatId);
    if (!waiting) return false;
    const c = conf();
    if (!isAuthorizedOperator(c, input.from)) return false;
    if (waiting.fromId && String(input.from?.id ?? "") !== waiting.fromId) return false;
    if (waiting.expiresAt < now()) {
      awaitingNote.delete(chatId);
      return false;
    }
    awaitingNote.delete(chatId);
    const transport = input.transport ?? transportFor(c);
    const text = input.text.trim();
    if (!text) return true;
    if (/^\/cancel\b/i.test(text)) {
      await enqueueIO(async () => {
        await transport.send(chatId, "Cancelled — the approval is still waiting.");
      });
      return true;
    }
    const rec = getApprovalRequest(waiting.id);
    if (!rec || rec.status !== "pending") {
      await enqueueIO(async () => {
        await transport.send(
          chatId,
          rec
            ? `That request was already ${escapeHtml(rec.status)}.`
            : "That request no longer exists.",
        );
      });
      return true;
    }
    if (rec.options.includes("redirect")) {
      resolveApprovalRequest(rec.id, {
        action: "redirect",
        note: text,
        by: actorLabel(input.from),
        via: "telegram",
        actor: { kind: "telegram-callback" },
      });
      return true;
    }
    stashedNotes.set(rec.id, text);
    const { text: html, keyboard } = formatNoteCaptured(rec, text);
    await enqueueIO(async () => {
      const { messageId } = await transport.send(chatId, html, { keyboard });
      attachTelegramMessage(rec.id, { chatId, messageId, kind: "single" });
    });
    return true;
  }

  /** Wait for queued sends / edits (tests). */
  async function drain(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
      await flush();
    }
    await chain;
  }

  function stop(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    queue = [];
  }

  return { handleEvent, handleCallback, handleText, drain, stop };
}

export type TelegramApprovalNotifier = ReturnType<typeof createTelegramApprovalNotifier>;

// ── Gateway singleton ──────────────────────────────────────────────────────

let singleton: { notifier: TelegramApprovalNotifier; unsubscribe: () => void } | null = null;

/** Install once at gateway boot; idempotent. */
export function installTelegramApprovals(
  deps?: Partial<TelegramApprovalNotifierDeps>,
): TelegramApprovalNotifier {
  if (singleton) return singleton.notifier;
  const notifier = createTelegramApprovalNotifier({
    getConfig: deps?.getConfig ?? loadConfig,
    transport: deps?.transport,
    now: deps?.now,
  });
  const unsubscribe = onApprovalEvent((e) => notifier.handleEvent(e));
  singleton = { notifier, unsubscribe };
  return notifier;
}

export function getTelegramApprovalNotifier(): TelegramApprovalNotifier | null {
  return singleton?.notifier ?? null;
}

export function _resetTelegramApprovals(): void {
  singleton?.unsubscribe();
  singleton?.notifier.stop();
  singleton = null;
  registeredApis.clear();
}
