/**
 * Gmail Gateway Methods
 * Server-side handlers for Gmail operations
 *
 * Multi-account model:
 *   - Account credentials live in two places: legacy single-account under
 *     `integrations.calendar.*` (kept for back-compat) and the new
 *     `integrations.gmail.accounts[]` array. On boot we register every entry
 *     in the in-memory account store keyed by `account.id`.
 *   - Every RPC accepts an optional `accountId` param; missing → default.
 *   - `gmail.alerts.*` persist alert rules to ~/.infinibot/gmail-alerts.json
 *     so they survive restarts independent of the main config schema.
 */

import fs from "node:fs";
import path from "node:path";
import {
  configureGmail,
  upsertGmailAccount,
  removeGmailAccount,
  setDefaultGmailAccount,
  listGmailAccounts as listGmailAccountsImpl,
  fetchGmailProfile,
  listGmailMessagesForAccount,
  isGmailConfigured,
  handleGmailTool,
  exchangeGmailAuthCode,
  fetchGoogleUserEmail,
  GmailMessage,
  GmailLabel,
} from "../../agents/tools/gmail-tool.js";
import { STATE_DIR } from "../../config/paths.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/io.js";
import {
  createGmailOauthSession,
  consumePendingGmailCode,
  getGmailOauthRedirectUrl,
  buildGoogleAuthUrl,
  GMAIL_OAUTH_SCOPES,
} from "../gmail-oauth-http.js";
import {
  analyzeEmail as runAnalyzeEmail,
  summarizeEmail as runSummarizeEmail,
  getActiveLLM,
} from "../../services/email/llm-analysis.js";

// ============================================================
// Configuration
// ============================================================

type CalendarCreds = { refreshToken?: string; clientId?: string; clientSecret?: string };
type GmailAccountConfig = {
  id: string;
  email?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};
type IntegrationsConfig = {
  calendar?: CalendarCreds;
  gmail?: { accounts?: GmailAccountConfig[]; defaultAccountId?: string };
};

export function initGmail(state: { config: { integrations?: IntegrationsConfig } }) {
  const integ = state.config.integrations;

  // Legacy: single Google OAuth shared with Calendar -> registered as "default".
  const calendarCreds = integ?.calendar;
  if (calendarCreds?.refreshToken && calendarCreds?.clientId && calendarCreds?.clientSecret) {
    configureGmail({
      clientId: calendarCreds.clientId,
      clientSecret: calendarCreds.clientSecret,
      refreshToken: calendarCreds.refreshToken,
    });
    console.log("[Gmail] Default account configured from calendar credentials");
  }

  // New: explicit multi-account list.
  const accounts = integ?.gmail?.accounts ?? [];
  for (const acc of accounts) {
    if (!acc.id || !acc.clientId || !acc.clientSecret || !acc.refreshToken) continue;
    upsertGmailAccount({
      id: acc.id,
      email: acc.email,
      clientId: acc.clientId,
      clientSecret: acc.clientSecret,
      refreshToken: acc.refreshToken,
    });
    console.log(`[Gmail] Registered account ${acc.id}${acc.email ? ` (${acc.email})` : ""}`);
  }
  const def = integ?.gmail?.defaultAccountId;
  if (def) setDefaultGmailAccount(def);
}

// ============================================================
// Account config persistence (integrations.gmail.accounts[])
// ============================================================
// `gmail.accounts.add/remove/setDefault` need to survive restarts. We read
// the raw on-disk config, mutate the array, and write it back through the
// same schema-validated writer the rest of the gateway uses.

interface StoredGmailAccount {
  id: string;
  email?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

async function readConfigForGmail(): Promise<Record<string, unknown>> {
  const snap = await readConfigFileSnapshot();
  const parsed = snap.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return { ...(parsed as Record<string, unknown>) };
}

async function mutateGmailAccountsConfig(
  fn: (block: { accounts: StoredGmailAccount[]; defaultAccountId?: string }) => void,
): Promise<void> {
  const cfg = await readConfigForGmail();
  const integ = (cfg.integrations as Record<string, unknown> | undefined) ?? {};
  const block =
    (integ.gmail as { accounts?: StoredGmailAccount[]; defaultAccountId?: string } | undefined) ??
    {};
  const next = {
    accounts: Array.isArray(block.accounts) ? [...block.accounts] : [],
    defaultAccountId: block.defaultAccountId,
  };
  fn(next);
  const mergedInteg = { ...integ, gmail: next };
  cfg.integrations = mergedInteg;
  await writeConfigFile(cfg as never);
}

// ============================================================
// Alerts persistence (~/.infinibot/gmail-alerts.json)
// ============================================================

export interface GmailAlertRule {
  accountId?: string; // null/undefined = default
  enabled: boolean;
  /** Telegram target — accepts "telegram:<chatId>" or just a chat id string. */
  telegramChatId?: string;
  telegramAccountId?: string; // optional telegram account name in config
  /** Senders that always alert (substring/email match, case-insensitive). */
  senders: string[];
  /** Subject/body keywords that trigger an alert. */
  keywords: string[];
  /** Only alert on starred messages. */
  starredOnly?: boolean;
  /** Only alert on messages with the IMPORTANT label. */
  importantLabelOnly?: boolean;
  /** Poll interval minutes; 0 disables polling. Default 5. */
  pollIntervalMinutes: number;
  /** ISO timestamp of newest message id we've already alerted on. */
  lastAlertedAt?: string;
  /** Telegram message template — supports {from} {subject} {snippet} {account}. */
  template?: string;

  // ── AI-driven trigger ──────────────────────────────────
  /** When enabled, run the analyze prompt and trigger when score ≥ threshold. */
  aiAnalysisEnabled?: boolean;
  /** 0-100 importance threshold (default 70). */
  aiImportanceThreshold?: number;
  /** Optional category whitelist; when set, only emails in these categories trigger. */
  aiCategoryAllowlist?: string[];

  // ── Auto-actions when a message matches ───────────────
  /** Send the Telegram alert. Default true if telegramChatId set. */
  doTelegramAlert?: boolean;
  /** Forward the email to this address via gmail.send. Empty = skip. */
  forwardTo?: string;
  /** Apply these label IDs to the matched email via gmail.label. */
  applyLabelIds?: string[];
  /** Star the matched email. */
  doStar?: boolean;
  /** Mark the matched email as read after handling. */
  doMarkRead?: boolean;
}

const ALERTS_PATH = path.join(STATE_DIR, "gmail-alerts.json");

function readAlerts(): Record<string, GmailAlertRule> {
  try {
    if (!fs.existsSync(ALERTS_PATH)) return {};
    const raw = fs.readFileSync(ALERTS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch (e) {
    console.error("[Gmail] Failed to read alerts file:", e);
    return {};
  }
}

function writeAlerts(rules: Record<string, GmailAlertRule>): void {
  try {
    fs.mkdirSync(path.dirname(ALERTS_PATH), { recursive: true });
    fs.writeFileSync(ALERTS_PATH, JSON.stringify(rules, null, 2), "utf-8");
  } catch (e) {
    console.error("[Gmail] Failed to write alerts file:", e);
  }
}

function normalizeRule(input: Partial<GmailAlertRule>): GmailAlertRule {
  return {
    accountId: input.accountId,
    enabled: input.enabled !== false,
    telegramChatId: input.telegramChatId?.trim() || undefined,
    telegramAccountId: input.telegramAccountId?.trim() || undefined,
    senders: Array.isArray(input.senders)
      ? input.senders.map((s) => String(s).trim()).filter(Boolean)
      : [],
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map((s) => String(s).trim()).filter(Boolean)
      : [],
    starredOnly: !!input.starredOnly,
    importantLabelOnly: !!input.importantLabelOnly,
    pollIntervalMinutes:
      typeof input.pollIntervalMinutes === "number" && input.pollIntervalMinutes >= 0
        ? Math.floor(input.pollIntervalMinutes)
        : 5,
    lastAlertedAt: input.lastAlertedAt,
    template: input.template?.trim() || undefined,

    aiAnalysisEnabled: !!input.aiAnalysisEnabled,
    aiImportanceThreshold:
      typeof input.aiImportanceThreshold === "number"
        ? Math.max(0, Math.min(100, Math.floor(input.aiImportanceThreshold)))
        : 70,
    aiCategoryAllowlist: Array.isArray(input.aiCategoryAllowlist)
      ? input.aiCategoryAllowlist.map((s) => String(s).trim()).filter(Boolean)
      : [],
    doTelegramAlert: input.doTelegramAlert !== false,
    forwardTo: input.forwardTo?.trim() || undefined,
    applyLabelIds: Array.isArray(input.applyLabelIds)
      ? input.applyLabelIds.map((s) => String(s).trim()).filter(Boolean)
      : [],
    doStar: !!input.doStar,
    doMarkRead: !!input.doMarkRead,
  };
}

// AI helpers live in src/services/email/llm-analysis.ts so summarisation and
// structured analysis share one provider-resolution path.

// ============================================================
// Gateway Method Handlers
// ============================================================

export interface GmailListMessagesParams {
  accountId?: string;
  query?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
}

export interface GmailGetMessageParams {
  accountId?: string;
  messageId: string;
}

export interface GmailGetThreadParams {
  accountId?: string;
  threadId: string;
}

export interface GmailSendParams {
  accountId?: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

export interface GmailReplyParams {
  accountId?: string;
  messageId: string;
  body: string;
}

export interface GmailModifyParams {
  accountId?: string;
  messageId: string;
  labelId?: string;
}

export interface GmailCreateLabelParams {
  accountId?: string;
  name: string;
}

// Handler functions that wrap the tool
export async function handleGmailStatus(): Promise<{
  configured: boolean;
  accounts: Array<{ id: string; email?: string; isDefault: boolean }>;
}> {
  return {
    configured: isGmailConfigured(),
    accounts: listGmailAccountsImpl(),
  };
}

export async function handleGmailListLabels(
  p: { accountId?: string } = {},
): Promise<{ labels: GmailLabel[] }> {
  const result = JSON.parse(
    await handleGmailTool({ action: "list_labels", accountId: p.accountId } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { labels: result.labels };
}

export async function handleGmailListMessages(params: GmailListMessagesParams): Promise<{
  messages: Partial<GmailMessage>[];
  nextPageToken?: string;
}> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "list_messages",
      accountId: params.accountId,
      query: params.query,
      labelIds: params.labelIds,
      maxResults: params.maxResults || 20,
      pageToken: params.pageToken,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { messages: result.messages, nextPageToken: result.nextPageToken };
}

export async function handleGmailSearch(params: {
  accountId?: string;
  query: string;
  maxResults?: number;
}): Promise<{
  messages: Partial<GmailMessage>[];
  nextPageToken?: string;
}> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "search",
      accountId: params.accountId,
      query: params.query,
      maxResults: params.maxResults || 20,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { messages: result.messages, nextPageToken: result.nextPageToken };
}

export async function handleGmailGetMessage(
  params: GmailGetMessageParams,
): Promise<{ message: GmailMessage }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "get_message",
      accountId: params.accountId,
      messageId: params.messageId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { message: result.message };
}

export async function handleGmailGetThread(params: GmailGetThreadParams): Promise<{
  id: string;
  messages: GmailMessage[];
}> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "get_thread",
      accountId: params.accountId,
      threadId: params.threadId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return result.thread;
}

export async function handleGmailSend(
  params: GmailSendParams,
): Promise<{ id: string; threadId: string }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "send",
      accountId: params.accountId,
      to: params.to,
      subject: params.subject,
      body: params.body,
      cc: params.cc,
      bcc: params.bcc,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { id: result.id, threadId: result.threadId };
}

export async function handleGmailReply(
  params: GmailReplyParams,
): Promise<{ id: string; threadId: string }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "reply",
      accountId: params.accountId,
      messageId: params.messageId,
      body: params.body,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { id: result.id, threadId: result.threadId };
}

export async function handleGmailDraft(
  params: GmailSendParams,
): Promise<{ draftId: string; messageId: string }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "draft",
      accountId: params.accountId,
      to: params.to,
      subject: params.subject,
      body: params.body,
      cc: params.cc,
      bcc: params.bcc,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { draftId: result.draftId, messageId: result.messageId };
}

export async function handleGmailLabel(params: GmailModifyParams): Promise<{ success: boolean }> {
  if (!params.labelId) throw new Error("labelId required");
  const result = JSON.parse(
    await handleGmailTool({
      action: "label",
      accountId: params.accountId,
      messageId: params.messageId,
      labelId: params.labelId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailUnlabel(params: GmailModifyParams): Promise<{ success: boolean }> {
  if (!params.labelId) throw new Error("labelId required");
  const result = JSON.parse(
    await handleGmailTool({
      action: "unlabel",
      accountId: params.accountId,
      messageId: params.messageId,
      labelId: params.labelId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailArchive(params: {
  accountId?: string;
  messageId: string;
}): Promise<{ success: boolean }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "archive",
      accountId: params.accountId,
      messageId: params.messageId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailTrash(params: {
  accountId?: string;
  messageId: string;
}): Promise<{ success: boolean }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "trash",
      accountId: params.accountId,
      messageId: params.messageId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailMarkRead(params: {
  accountId?: string;
  messageId: string;
}): Promise<{ success: boolean }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "mark_read",
      accountId: params.accountId,
      messageId: params.messageId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailMarkUnread(params: {
  accountId?: string;
  messageId: string;
}): Promise<{ success: boolean }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "mark_unread",
      accountId: params.accountId,
      messageId: params.messageId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailStar(params: {
  accountId?: string;
  messageId: string;
}): Promise<{ success: boolean }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "star",
      accountId: params.accountId,
      messageId: params.messageId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailUnstar(params: {
  accountId?: string;
  messageId: string;
}): Promise<{ success: boolean }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "unstar",
      accountId: params.accountId,
      messageId: params.messageId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

export async function handleGmailCreateLabel(
  params: GmailCreateLabelParams,
): Promise<{ label: GmailLabel }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "create_label",
      accountId: params.accountId,
      labelName: params.name,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { label: result.label };
}

export async function handleGmailDeleteLabel(params: {
  accountId?: string;
  labelId: string;
}): Promise<{ success: boolean }> {
  const result = JSON.parse(
    await handleGmailTool({
      action: "delete_label",
      accountId: params.accountId,
      labelId: params.labelId,
    } as any),
  );
  if (!result.success) throw new Error(result.error);
  return { success: true };
}

// ============================================================
// Insights
// ============================================================

/**
 * Inbox stats: unread, today, last-24h-volume, and top senders. Single
 * Gmail call (full list of metadata) so the page can render a "useful
 * insight" block without firing one request per email.
 */
export async function handleGmailInsights(params: {
  accountId?: string;
  lookbackDays?: number;
}): Promise<{
  unread: number;
  today: number;
  last24h: number;
  totalScanned: number;
  topSenders: Array<{ sender: string; count: number }>;
}> {
  const lookback = Math.max(1, Math.min(30, params.lookbackDays ?? 7));
  const q = `newer_than:${lookback}d`;
  const { messages } = await listGmailMessagesForAccount({
    accountId: params.accountId,
    query: q,
    maxResults: 100,
  });

  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const day24 = now - 24 * 60 * 60 * 1000;

  let unread = 0;
  let today = 0;
  let last24h = 0;
  const senderCounts = new Map<string, number>();

  for (const m of messages) {
    if (m.isUnread) unread++;
    const t = Date.parse(m.date);
    if (Number.isFinite(t)) {
      if (t >= todayStart.getTime()) today++;
      if (t >= day24) last24h++;
    }
    const fromAddr =
      (m.from || "").match(/<([^>]+)>/)?.[1] || (m.from || "").split("<")[0].trim() || "(unknown)";
    senderCounts.set(fromAddr, (senderCounts.get(fromAddr) ?? 0) + 1);
  }

  const topSenders = Array.from(senderCounts.entries())
    .map(([sender, count]) => ({ sender, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return { unread, today, last24h, totalScanned: messages.length, topSenders };
}

// ============================================================
// Gateway Handlers Export
// ============================================================

import type { GatewayRequestHandlers } from "./types.js";

function pickAccountId(params: Record<string, unknown> | undefined): string | undefined {
  const v = params?.accountId;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Resolve the email body the AI should read. Accepts either an inline
 * `text` blob (caller already has the content) or `messageId` (we fetch).
 */
async function materializeEmailText(
  params: Record<string, unknown>,
  accountId: string | undefined,
): Promise<string> {
  let text = typeof params.text === "string" ? params.text.trim() : "";
  if (!text && typeof params.messageId === "string" && params.messageId) {
    const { message } = await handleGmailGetMessage({ accountId, messageId: params.messageId });
    text = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      `Date: ${message.date}`,
      "",
      message.body || message.snippet || "",
    ].join("\n");
  }
  return text;
}

export const gmailHandlers: GatewayRequestHandlers = {
  "gmail.status": async ({ respond }) => {
    try {
      const result = await handleGmailStatus();
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.accounts.list": async ({ respond }) => {
    try {
      respond(true, { accounts: listGmailAccountsImpl() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  // ─── OAuth helper RPCs ──────────────────────────────────────
  // Used by the Emails page connect drawer. `gmail.oauth.config` lets the
  // UI surface the exact redirect URL the user should register in Google
  // Cloud Console; `startSession` issues a state id that the callback
  // route correlates with; `pollCode` returns the parked authorization
  // code after Google's redirect.
  "gmail.oauth.config": async ({ params, respond }) => {
    try {
      const host =
        typeof params.host === "string" && params.host.trim() ? params.host.trim() : undefined;
      const redirectUrl = getGmailOauthRedirectUrl(host ? { hostOverride: host } : undefined);
      respond(true, {
        redirectUrl,
        scopes: [...GMAIL_OAUTH_SCOPES],
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.oauth.startSession": async ({ respond }) => {
    try {
      respond(true, { sessionId: createGmailOauthSession() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  // Build the full Google consent URL server-side and mint the correlated
  // session in one call. Owning the confidential-client OAuth parameters here
  // (scopes, access_type=offline, prompt=consent, include_granted_scopes) means
  // the browser can't drift from the exchange's expectations — the #1 source of
  // "connected but no refresh_token" / scope-mismatch failures.
  "gmail.oauth.authUrl": async ({ params, respond }) => {
    try {
      const clientId = String(params.clientId || "").trim();
      if (!clientId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "clientId required" });
        return;
      }
      const host =
        typeof params.host === "string" && params.host.trim() ? params.host.trim() : undefined;
      const redirectUrl = getGmailOauthRedirectUrl(host ? { hostOverride: host } : undefined);
      const sessionId = createGmailOauthSession();
      const url = buildGoogleAuthUrl({ clientId, redirectUri: redirectUrl, state: sessionId });
      respond(true, { url, sessionId, redirectUrl, scopes: [...GMAIL_OAUTH_SCOPES] });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.oauth.pollCode": async ({ params, respond }) => {
    try {
      const sessionId = String(params.sessionId || "").trim();
      if (!sessionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "sessionId required" });
        return;
      }
      const code = consumePendingGmailCode(sessionId);
      respond(true, { code });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  // Exchange the OAuth authorization code for tokens **server-side** and
  // persist the account. Doing the exchange in the browser is unreliable —
  // Google's token endpoint has no CORS for confidential-client (client_secret)
  // exchanges — so the UI hands us the parked `code` and we finish the handshake
  // here. On success the account is registered + written to config in one shot.
  "gmail.oauth.exchange": async ({ params, respond }) => {
    try {
      const code = String(params.code || "").trim();
      const clientId = String(params.clientId || "").trim();
      const clientSecret = String(params.clientSecret || "").trim();
      const redirectUri = String(params.redirectUri || "").trim();
      const makeDefault = params.makeDefault === true;
      if (!code || !clientId || !clientSecret || !redirectUri) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "code, clientId, clientSecret, redirectUri required",
        });
        return;
      }

      const tokens = await exchangeGmailAuthCode({ code, clientId, clientSecret, redirectUri });
      if (!tokens.refreshToken) {
        // Google only returns a refresh_token on the FIRST consent for an app.
        respond(false, undefined, {
          code: "NO_REFRESH_TOKEN",
          message:
            "Google did not return a refresh_token. Revoke this app's access at myaccount.google.com/permissions and reconnect — the refresh token is only issued on the first consent (access_type=offline + prompt=consent).",
        });
        return;
      }

      // Resolve the email server-side so the account pill is meaningful; fall
      // back to a caller-supplied email or a synthesized id.
      let email = params.email ? String(params.email).trim() : "";
      if (!email) email = (await fetchGoogleUserEmail(tokens.accessToken)) ?? "";
      const id =
        (params.id ? String(params.id).trim() : "") ||
        (email ? email.split("@")[0] : "") ||
        `gmail-${email || clientId.slice(0, 8)}`;

      // In-memory first so a config write failure doesn't dead-end the user,
      // matching gmail.accounts.add.
      upsertGmailAccount({
        id,
        email: email || undefined,
        clientId,
        clientSecret,
        refreshToken: tokens.refreshToken,
      });
      if (makeDefault) setDefaultGmailAccount(id);

      try {
        await mutateGmailAccountsConfig((block) => {
          const idx = block.accounts.findIndex((a) => a.id === id);
          const entry: StoredGmailAccount = {
            id,
            email: email || undefined,
            clientId,
            clientSecret,
            refreshToken: tokens.refreshToken!,
          };
          if (idx >= 0) block.accounts[idx] = entry;
          else block.accounts.push(entry);
          if (makeDefault || !block.defaultAccountId) block.defaultAccountId = id;
        });
      } catch (e) {
        console.error("[Gmail] config persistence failed:", e);
      }

      respond(true, { accounts: listGmailAccountsImpl(), id, email: email || undefined });
    } catch (e) {
      respond(false, undefined, { code: "OAUTH_EXCHANGE_FAILED", message: String(e) });
    }
  },
  "gmail.accounts.profile": async ({ params, respond }) => {
    try {
      const accountId = pickAccountId(params);
      const profile = await fetchGmailProfile(accountId);
      respond(true, profile);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.accounts.add": async ({ params, respond }) => {
    try {
      const id = String(params.id || "").trim();
      const clientId = String(params.clientId || "").trim();
      const clientSecret = String(params.clientSecret || "").trim();
      const refreshToken = String(params.refreshToken || "").trim();
      const email = params.email ? String(params.email).trim() : undefined;
      const makeDefault = params.makeDefault === true;
      if (!id || !clientId || !clientSecret || !refreshToken) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "id, clientId, clientSecret, refreshToken required",
        });
        return;
      }
      // In-memory registration first so a write failure doesn't dead-end the user.
      upsertGmailAccount({ id, email, clientId, clientSecret, refreshToken });
      if (makeDefault) setDefaultGmailAccount(id);

      // Persist to ~/.infinibot/infinibot.json so the account survives restarts.
      try {
        await mutateGmailAccountsConfig((block) => {
          const idx = block.accounts.findIndex((a) => a.id === id);
          const entry: StoredGmailAccount = { id, email, clientId, clientSecret, refreshToken };
          if (idx >= 0) block.accounts[idx] = entry;
          else block.accounts.push(entry);
          if (makeDefault || !block.defaultAccountId) block.defaultAccountId = id;
        });
      } catch (e) {
        console.error("[Gmail] config persistence failed:", e);
      }
      respond(true, { accounts: listGmailAccountsImpl() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.accounts.remove": async ({ params, respond }) => {
    try {
      const id = String(params.id || "").trim();
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      removeGmailAccount(id);
      try {
        await mutateGmailAccountsConfig((block) => {
          block.accounts = block.accounts.filter((a) => a.id !== id);
          if (block.defaultAccountId === id) {
            block.defaultAccountId = block.accounts[0]?.id;
          }
        });
      } catch (e) {
        console.error("[Gmail] config persistence failed:", e);
      }
      respond(true, { accounts: listGmailAccountsImpl() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.accounts.setDefault": async ({ params, respond }) => {
    try {
      const id = String(params.id || "").trim();
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const ok = setDefaultGmailAccount(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Account ${id} not registered` });
        return;
      }
      try {
        await mutateGmailAccountsConfig((block) => {
          block.defaultAccountId = id;
        });
      } catch (e) {
        console.error("[Gmail] config persistence failed:", e);
      }
      respond(true, { accounts: listGmailAccountsImpl() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.labels": async ({ params, respond }) => {
    try {
      const result = await handleGmailListLabels({ accountId: pickAccountId(params) });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailListMessagesParams;
      const result = await handleGmailListMessages(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.search": async ({ params, respond }) => {
    try {
      const p = params as unknown as { accountId?: string; query: string; maxResults?: number };
      const result = await handleGmailSearch(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailGetMessageParams;
      const result = await handleGmailGetMessage(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.thread": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailGetThreadParams;
      const result = await handleGmailGetThread(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.send": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailSendParams;
      const result = await handleGmailSend(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.reply": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailReplyParams;
      const result = await handleGmailReply(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.draft": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailSendParams;
      const result = await handleGmailDraft(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.label": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailModifyParams;
      const result = await handleGmailLabel(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.unlabel": async ({ params, respond }) => {
    try {
      const p = params as unknown as GmailModifyParams;
      const result = await handleGmailUnlabel(p);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.archive": async ({ params, respond }) => {
    try {
      const result = await handleGmailArchive({
        accountId: pickAccountId(params),
        messageId: params.messageId as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.trash": async ({ params, respond }) => {
    try {
      const result = await handleGmailTrash({
        accountId: pickAccountId(params),
        messageId: params.messageId as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.markRead": async ({ params, respond }) => {
    try {
      const result = await handleGmailMarkRead({
        accountId: pickAccountId(params),
        messageId: params.messageId as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.markUnread": async ({ params, respond }) => {
    try {
      const result = await handleGmailMarkUnread({
        accountId: pickAccountId(params),
        messageId: params.messageId as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.star": async ({ params, respond }) => {
    try {
      const result = await handleGmailStar({
        accountId: pickAccountId(params),
        messageId: params.messageId as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.unstar": async ({ params, respond }) => {
    try {
      const result = await handleGmailUnstar({
        accountId: pickAccountId(params),
        messageId: params.messageId as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.createLabel": async ({ params, respond }) => {
    try {
      const result = await handleGmailCreateLabel({
        accountId: pickAccountId(params),
        name: params.name as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.deleteLabel": async ({ params, respond }) => {
    try {
      const result = await handleGmailDeleteLabel({
        accountId: pickAccountId(params),
        labelId: params.labelId as string,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.insights": async ({ params, respond }) => {
    try {
      const result = await handleGmailInsights({
        accountId: pickAccountId(params),
        lookbackDays: typeof params.lookbackDays === "number" ? params.lookbackDays : undefined,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.summarize": async ({ params, respond }) => {
    try {
      const accountId = pickAccountId(params);
      const text = await materializeEmailText(params, accountId);
      if (!text) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "text or messageId required" });
        return;
      }
      respond(true, await runSummarizeEmail(text));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.analyze": async ({ params, respond }) => {
    try {
      const accountId = pickAccountId(params);
      const text = await materializeEmailText(params, accountId);
      if (!text) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "text or messageId required" });
        return;
      }
      respond(true, await runAnalyzeEmail(text));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.llm.status": async ({ respond }) => {
    try {
      respond(true, getActiveLLM());
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  // Manually run a saved rule against a message — used by the "Apply rule"
  // shortcut in the analysis modal so users can fire the configured
  // forward / label / alert actions on demand.
  "gmail.runRule": async ({ params, respond }) => {
    try {
      const accountId = pickAccountId(params);
      const ruleKey = accountId ?? "_default";
      const rules = readAlerts();
      const rule = rules[ruleKey];
      if (!rule) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "no alert rule saved for this account",
        });
        return;
      }
      const messageId = String(params.messageId || "").trim();
      if (!messageId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "messageId required" });
        return;
      }
      const { message } = await handleGmailGetMessage({ accountId, messageId });
      const summary = `${message.from}\n${message.subject}\n${message.snippet}`;
      const actions: string[] = [];

      if (rule.doTelegramAlert !== false && rule.telegramChatId) {
        try {
          const { sendMessageTelegram } = await import("../../telegram/send.js");
          const target = rule.telegramChatId.startsWith("telegram:")
            ? rule.telegramChatId
            : `telegram:${rule.telegramChatId}`;
          const text = (rule.template || "📧 *{subject}*\n\nFrom: {from}\n\n{snippet}")
            .replace("{from}", message.from)
            .replace("{subject}", message.subject)
            .replace("{snippet}", message.snippet)
            .replace("{account}", accountId ?? "default");
          await sendMessageTelegram(target, text, {
            accountId: rule.telegramAccountId,
            textMode: "markdown",
          });
          actions.push("telegram_alert");
        } catch (e) {
          actions.push(`telegram_failed: ${e}`);
        }
      }

      if (rule.forwardTo) {
        try {
          await handleGmailSend({
            accountId,
            to: rule.forwardTo,
            subject: message.subject.startsWith("Fwd:")
              ? message.subject
              : `Fwd: ${message.subject}`,
            body: `--- Forwarded by InfiniBot ---\nFrom: ${message.from}\nSubject: ${message.subject}\nDate: ${message.date}\n\n${message.body || message.snippet}`,
          });
          actions.push(`forwarded:${rule.forwardTo}`);
        } catch (e) {
          actions.push(`forward_failed: ${e}`);
        }
      }

      if (rule.applyLabelIds && rule.applyLabelIds.length > 0) {
        for (const lid of rule.applyLabelIds) {
          try {
            await handleGmailLabel({ accountId, messageId, labelId: lid });
            actions.push(`label:${lid}`);
          } catch {
            actions.push(`label_failed:${lid}`);
          }
        }
      }

      if (rule.doStar) {
        try {
          await handleGmailStar({ accountId, messageId });
          actions.push("starred");
        } catch {
          /* noop */
        }
      }
      if (rule.doMarkRead) {
        try {
          await handleGmailMarkRead({ accountId, messageId });
          actions.push("read");
        } catch {
          /* noop */
        }
      }

      respond(true, { actions, summary });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.alerts.get": async ({ params, respond }) => {
    try {
      const accountId = pickAccountId(params) ?? "_default";
      const rules = readAlerts();
      respond(true, { rule: rules[accountId] ?? null });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.alerts.list": async ({ respond }) => {
    try {
      respond(true, { rules: readAlerts() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.alerts.set": async ({ params, respond }) => {
    try {
      const accountId = pickAccountId(params) ?? "_default";
      const rule = normalizeRule((params.rule || params) as Partial<GmailAlertRule>);
      rule.accountId = accountId === "_default" ? undefined : accountId;
      const rules = readAlerts();
      rules[accountId] = rule;
      writeAlerts(rules);
      respond(true, { rule });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.alerts.delete": async ({ params, respond }) => {
    try {
      const accountId = pickAccountId(params) ?? "_default";
      const rules = readAlerts();
      delete rules[accountId];
      writeAlerts(rules);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
  "gmail.alerts.test": async ({ params, respond }) => {
    // Fire a sample Telegram alert using the saved rule (or the inline one),
    // so the UI's "Send test alert" button can confirm delivery without
    // waiting for a real important email.
    try {
      const accountId = pickAccountId(params) ?? "_default";
      const rules = readAlerts();
      const rule = (params.rule as Partial<GmailAlertRule> | undefined)
        ? normalizeRule(params.rule as Partial<GmailAlertRule>)
        : rules[accountId];
      if (!rule || !rule.telegramChatId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "no telegram target configured",
        });
        return;
      }
      const { sendMessageTelegram } = await import("../../telegram/send.js");
      const target = rule.telegramChatId.startsWith("telegram:")
        ? rule.telegramChatId
        : `telegram:${rule.telegramChatId}`;
      const text = (
        rule.template ||
        "📧 *Important email test*\n\nFrom: {from}\nSubject: {subject}\nAccount: {account}"
      )
        .replace("{from}", "test@example.com")
        .replace("{subject}", "Test alert from InfiniBot Emails")
        .replace("{snippet}", "This is a test of your important-email alerts.")
        .replace("{account}", accountId);
      await sendMessageTelegram(target, text, {
        accountId: rule.telegramAccountId,
        textMode: "markdown",
      });
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

console.log("[Gmail] Gmail handlers loaded");
