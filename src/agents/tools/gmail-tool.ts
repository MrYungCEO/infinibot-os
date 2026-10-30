/**
 * Gmail Tool — Gmail MCP Integration
 * Allows agents to read, send, label, and manage emails
 */

import { z } from "zod";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { GMAIL_NOT_CONNECTED } from "../../infinibot-knowledge/fix-hints.js";
import { type AnyAgentTool, jsonResult } from "./common.js";

// ============================================================
// Multi-account credential store
// ============================================================
// Accounts are keyed by a stable id ("default" for the legacy single-account
// config wired through the calendar OAuth). Each entry caches its own access
// token so we can refresh independently per account.

interface GmailAccountCredentials {
  id: string;
  email?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
}

const gmailAccounts = new Map<string, GmailAccountCredentials>();
let defaultAccountId: string | null = null;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function pickAccount(accountId?: string): GmailAccountCredentials {
  const id = accountId || defaultAccountId;
  if (!id) throw new Error(GMAIL_NOT_CONNECTED().error);
  const acc = gmailAccounts.get(id);
  if (!acc) throw new Error(`Gmail account "${id}" not found.`);
  return acc;
}

// ============================================================
// Token Management
// ============================================================

async function refreshAccessToken(acc: GmailAccountCredentials): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: acc.refreshToken,
      client_id: acc.clientId,
      client_secret: acc.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error_description || "Failed to refresh Gmail token");
  }

  const data = await response.json();
  acc.accessToken = data.access_token;
  acc.tokenExpiry = Date.now() + data.expires_in * 1000;
  return data.access_token;
}

async function getAccessToken(acc: GmailAccountCredentials): Promise<string> {
  if (!acc.accessToken || (acc.tokenExpiry && Date.now() > acc.tokenExpiry - 60_000)) {
    return refreshAccessToken(acc);
  }
  return acc.accessToken;
}

// ============================================================
// Authorization-code exchange (server-side)
// ============================================================
// The initial OAuth handshake trades the one-time `code` Google returns after
// consent for a long-lived `refresh_token` + a short-lived `access_token`.
// This MUST run server-side: Google's token endpoint does not expose CORS
// headers for a confidential-client (client_secret) exchange, so doing it from
// the browser is blocked/unreliable. The gateway (Node) has no such limit.

export interface GmailTokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

export async function exchangeGmailAuthCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GmailTokenExchangeResult> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json().catch(() => ({}) as Record<string, unknown>);
  if (!response.ok) {
    const err = data as { error?: string; error_description?: string };
    const detail = err.error_description || err.error || `HTTP ${response.status}`;
    // Surface the two most common misconfigurations explicitly so failures are
    // diagnosable in the UI instead of a generic "exchange failed".
    if (err.error === "redirect_uri_mismatch") {
      throw new Error(
        `redirect_uri_mismatch: the redirect URI must be registered exactly (${params.redirectUri}) as an authorized redirect URI on this OAuth client in Google Cloud Console.`,
      );
    }
    if (err.error === "invalid_client") {
      throw new Error(
        "invalid_client: the Client ID or Client Secret is incorrect for this OAuth client.",
      );
    }
    if (err.error === "invalid_grant") {
      // The one-time authorization code is expired or was already used. Codes
      // are single-use and short-lived, so this happens on any retry/refresh.
      throw new Error(
        "invalid_grant: the authorization code expired or was already used. Reopen Google consent to get a fresh code and try again.",
      );
    }
    throw new Error(`Gmail token exchange failed: ${detail}`);
  }

  const ok = data as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!ok.access_token) {
    throw new Error("Gmail token exchange returned no access_token");
  }
  return {
    accessToken: ok.access_token,
    refreshToken: ok.refresh_token,
    expiresIn: ok.expires_in,
    scope: ok.scope,
    tokenType: ok.token_type,
  };
}

/** Resolve the Google account email from an access token (best-effort). */
export async function fetchGoogleUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return undefined;
    const u = (await r.json()) as { email?: string };
    return u.email;
  } catch {
    return undefined;
  }
}

async function gmailApiRequest(
  endpoint: string,
  options: RequestInit = {},
  accountId?: string,
): Promise<any> {
  const acc = pickAccount(accountId);
  const accessToken = await getAccessToken(acc);

  const response = await fetch(`${GMAIL_API}${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Gmail API error: ${response.status}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

// ============================================================
// Tool Configuration
// ============================================================

export function configureGmail(credentials: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
}) {
  upsertGmailAccount({
    id: "default",
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
    accessToken: credentials.accessToken,
    tokenExpiry: credentials.tokenExpiry,
  });
  defaultAccountId = "default";
  console.log("[Gmail] Default Gmail account configured");
}

export function upsertGmailAccount(acc: {
  id: string;
  email?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
}): void {
  gmailAccounts.set(acc.id, { ...acc });
  if (!defaultAccountId) defaultAccountId = acc.id;
}

export function removeGmailAccount(id: string): boolean {
  const had = gmailAccounts.delete(id);
  if (had && defaultAccountId === id) {
    const first = gmailAccounts.keys().next();
    defaultAccountId = first.done ? null : first.value;
  }
  return had;
}

export function setDefaultGmailAccount(id: string): boolean {
  if (!gmailAccounts.has(id)) return false;
  defaultAccountId = id;
  return true;
}

export function listGmailAccounts(): Array<{ id: string; email?: string; isDefault: boolean }> {
  return Array.from(gmailAccounts.values()).map((a) => ({
    id: a.id,
    email: a.email,
    isDefault: a.id === defaultAccountId,
  }));
}

export function isGmailConfigured(): boolean {
  return gmailAccounts.size > 0;
}

export async function fetchGmailProfile(
  accountId?: string,
): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number }> {
  const data = await gmailApiRequest("/users/me/profile", {}, accountId);
  return {
    emailAddress: data.emailAddress,
    messagesTotal: data.messagesTotal,
    threadsTotal: data.threadsTotal,
  };
}

// ============================================================
// Email Types
// ============================================================

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  labels: string[];
  isUnread: boolean;
  isStarred: boolean;
  body?: string;
  bodyHtml?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
}

// ============================================================
// Email Operations
// ============================================================

function parseHeaders(headers: any[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers || []) {
    result[h.name.toLowerCase()] = h.value;
  }
  return result;
}

function decodeBase64Url(data: string): string {
  try {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return data;
  }
}

function extractBody(payload: any): { text: string; html: string } {
  let text = "";
  let html = "";

  function traverse(part: any) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html = decodeBase64Url(part.body.data);
    }
    if (part.parts) {
      for (const p of part.parts) traverse(p);
    }
  }

  traverse(payload);
  return { text, html };
}

function extractAttachments(payload: any): GmailMessage["attachments"] {
  const attachments: NonNullable<GmailMessage["attachments"]> = [];

  function traverse(part: any) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      for (const p of part.parts) traverse(p);
    }
  }

  traverse(payload);
  return attachments.length ? attachments : undefined;
}

async function listLabels(accountId?: string): Promise<GmailLabel[]> {
  const data = await gmailApiRequest("/users/me/labels", {}, accountId);
  return (data.labels || []).map((l: any) => ({
    id: l.id,
    name: l.name,
    type: l.type === "system" ? "system" : "user",
    messagesTotal: l.messagesTotal,
    messagesUnread: l.messagesUnread,
  }));
}

async function listMessages(
  query: string = "",
  labelIds: string[] = [],
  maxResults: number = 20,
  pageToken?: string,
  accountId?: string,
): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (labelIds.length) params.set("labelIds", labelIds.join(","));
  params.set("maxResults", String(maxResults));
  if (pageToken) params.set("pageToken", pageToken);

  const data = await gmailApiRequest(`/users/me/messages?${params}`, {}, accountId);

  if (!data.messages?.length) {
    return { messages: [], nextPageToken: data.nextPageToken };
  }

  // Fetch message details in batch
  const messages: GmailMessage[] = [];
  for (const msg of data.messages.slice(0, maxResults)) {
    try {
      const detail = await getMessage(msg.id, "full", accountId);
      messages.push(detail);
    } catch (e) {
      console.error(`Failed to fetch message ${msg.id}:`, e);
    }
  }

  return { messages, nextPageToken: data.nextPageToken };
}

async function getMessage(
  messageId: string,
  format: "full" | "metadata" | "minimal" = "full",
  accountId?: string,
): Promise<GmailMessage> {
  const data = await gmailApiRequest(
    `/users/me/messages/${messageId}?format=${format}`,
    {},
    accountId,
  );
  const headers = parseHeaders(data.payload?.headers || []);
  const { text, html } = format === "full" ? extractBody(data.payload) : { text: "", html: "" };

  return {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet || "",
    subject: headers.subject || "(No Subject)",
    from: headers.from || "",
    to: headers.to || "",
    date: headers.date || new Date(Number(data.internalDate)).toISOString(),
    labels: data.labelIds || [],
    isUnread: data.labelIds?.includes("UNREAD") || false,
    isStarred: data.labelIds?.includes("STARRED") || false,
    body: text,
    bodyHtml: html,
    attachments: format === "full" ? extractAttachments(data.payload) : undefined,
  };
}

async function getThread(
  threadId: string,
  accountId?: string,
): Promise<{ id: string; messages: GmailMessage[] }> {
  const data = await gmailApiRequest(`/users/me/threads/${threadId}?format=full`, {}, accountId);

  const messages: GmailMessage[] = (data.messages || []).map((m: any) => {
    const headers = parseHeaders(m.payload?.headers || []);
    const { text, html } = extractBody(m.payload);
    return {
      id: m.id,
      threadId: m.threadId,
      snippet: m.snippet || "",
      subject: headers.subject || "(No Subject)",
      from: headers.from || "",
      to: headers.to || "",
      date: headers.date || new Date(Number(m.internalDate)).toISOString(),
      labels: m.labelIds || [],
      isUnread: m.labelIds?.includes("UNREAD") || false,
      isStarred: m.labelIds?.includes("STARRED") || false,
      body: text,
      bodyHtml: html,
      attachments: extractAttachments(m.payload),
    };
  });

  return { id: data.id, messages };
}

async function sendMessage(
  to: string,
  subject: string,
  body: string,
  options: {
    cc?: string;
    bcc?: string;
    replyTo?: string;
    inReplyTo?: string;
    references?: string;
    threadId?: string;
    accountId?: string;
  } = {},
): Promise<{ id: string; threadId: string }> {
  // Build RFC 2822 formatted email
  const lines: string[] = [];
  lines.push(`To: ${to}`);
  if (options.cc) lines.push(`Cc: ${options.cc}`);
  if (options.bcc) lines.push(`Bcc: ${options.bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`);
  if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) lines.push(`References: ${options.references}`);
  lines.push("");
  lines.push(body);

  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");

  const payload: any = { raw };
  if (options.threadId) payload.threadId = options.threadId;

  const data = await gmailApiRequest(
    "/users/me/messages/send",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    options.accountId,
  );

  return { id: data.id, threadId: data.threadId };
}

async function createDraft(
  to: string,
  subject: string,
  body: string,
  options: { cc?: string; bcc?: string; accountId?: string } = {},
): Promise<{ id: string; messageId: string }> {
  const lines: string[] = [];
  lines.push(`To: ${to}`);
  if (options.cc) lines.push(`Cc: ${options.cc}`);
  if (options.bcc) lines.push(`Bcc: ${options.bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`);
  lines.push("");
  lines.push(body);

  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");

  const data = await gmailApiRequest(
    "/users/me/drafts",
    {
      method: "POST",
      body: JSON.stringify({ message: { raw } }),
    },
    options.accountId,
  );

  return { id: data.id, messageId: data.message.id };
}

async function modifyLabels(
  messageId: string,
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
  accountId?: string,
): Promise<void> {
  await gmailApiRequest(
    `/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    },
    accountId,
  );
}

async function trashMessage(messageId: string, accountId?: string): Promise<void> {
  await gmailApiRequest(
    `/users/me/messages/${messageId}/trash`,
    {
      method: "POST",
    },
    accountId,
  );
}

async function archiveMessage(messageId: string, accountId?: string): Promise<void> {
  await modifyLabels(messageId, [], ["INBOX"], accountId);
}

async function markAsRead(messageId: string, accountId?: string): Promise<void> {
  await modifyLabels(messageId, [], ["UNREAD"], accountId);
}

async function markAsUnread(messageId: string, accountId?: string): Promise<void> {
  await modifyLabels(messageId, ["UNREAD"], [], accountId);
}

async function starMessage(messageId: string, accountId?: string): Promise<void> {
  await modifyLabels(messageId, ["STARRED"], [], accountId);
}

async function unstarMessage(messageId: string, accountId?: string): Promise<void> {
  await modifyLabels(messageId, [], ["STARRED"], accountId);
}

async function createLabel(name: string, accountId?: string): Promise<GmailLabel> {
  const data = await gmailApiRequest(
    "/users/me/labels",
    {
      method: "POST",
      body: JSON.stringify({ name }),
    },
    accountId,
  );
  return {
    id: data.id,
    name: data.name,
    type: "user",
  };
}

async function deleteLabel(labelId: string, accountId?: string): Promise<void> {
  await gmailApiRequest(
    `/users/me/labels/${labelId}`,
    {
      method: "DELETE",
    },
    accountId,
  );
}

// ============================================================
// Public helpers (for poller / alerts)
// ============================================================

export async function listGmailMessagesForAccount(opts: {
  accountId?: string;
  query?: string;
  labelIds?: string[];
  maxResults?: number;
}): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
  return listMessages(
    opts.query ?? "",
    opts.labelIds ?? [],
    opts.maxResults ?? 20,
    undefined,
    opts.accountId,
  );
}

export async function fetchGmailLabels(accountId?: string): Promise<GmailLabel[]> {
  return listLabels(accountId);
}

// ============================================================
// Tool Schema & Handler
// ============================================================

export const gmailToolSchema = {
  name: "gmail",
  description: `Manage Gmail emails. Actions: list_labels, list_messages, get_message, get_thread, send, reply, draft, label, unlabel, archive, trash, mark_read, mark_unread, star, unstar, search, create_label.

Examples:
- List inbox: { "action": "list_messages", "labelIds": ["INBOX"], "maxResults": 10 }
- Search: { "action": "search", "query": "from:boss@company.com is:unread" }
- Send email: { "action": "send", "to": "user@example.com", "subject": "Hello", "body": "Hi there!" }
- Reply: { "action": "reply", "messageId": "abc123", "body": "Thanks for your message!" }
- Label: { "action": "label", "messageId": "abc123", "labelId": "STARRED" }`,
  parameters: z.object({
    action: z.enum([
      "list_labels",
      "list_messages",
      "get_message",
      "get_thread",
      "send",
      "reply",
      "draft",
      "label",
      "unlabel",
      "archive",
      "trash",
      "mark_read",
      "mark_unread",
      "star",
      "unstar",
      "search",
      "create_label",
      "delete_label",
    ]),
    /** Optional account id when multiple Gmail accounts are connected. Falls back to default. */
    accountId: z.string().optional(),
    // For list/search
    query: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
    maxResults: z.number().default(20),
    pageToken: z.string().optional(),
    // For get/modify
    messageId: z.string().optional(),
    threadId: z.string().optional(),
    labelId: z.string().optional(),
    // For send/reply/draft
    to: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    // For create_label
    labelName: z.string().optional(),
  }),
};

export async function handleGmailTool(
  params: z.input<(typeof gmailToolSchema)["parameters"]>,
): Promise<string> {
  if (!isGmailConfigured()) {
    return JSON.stringify(GMAIL_NOT_CONNECTED());
  }

  try {
    const accountId = (params as any).accountId as string | undefined;
    switch (params.action) {
      case "list_labels": {
        const labels = await listLabels(accountId);
        return JSON.stringify({ success: true, labels });
      }

      case "list_messages": {
        const { messages, nextPageToken } = await listMessages(
          params.query || "",
          params.labelIds || [],
          params.maxResults ?? 20,
          params.pageToken,
          accountId,
        );
        return JSON.stringify({
          success: true,
          messages: messages.map((m) => ({
            id: m.id,
            threadId: m.threadId,
            subject: m.subject,
            from: m.from,
            snippet: m.snippet,
            date: m.date,
            isUnread: m.isUnread,
            isStarred: m.isStarred,
            labels: m.labels,
          })),
          count: messages.length,
          nextPageToken,
        });
      }

      case "search": {
        const { messages, nextPageToken } = await listMessages(
          params.query || "",
          [],
          params.maxResults ?? 20,
          params.pageToken,
          accountId,
        );
        return JSON.stringify({
          success: true,
          messages: messages.map((m) => ({
            id: m.id,
            threadId: m.threadId,
            subject: m.subject,
            from: m.from,
            snippet: m.snippet,
            date: m.date,
            isUnread: m.isUnread,
          })),
          count: messages.length,
          nextPageToken,
        });
      }

      case "get_message": {
        if (!params.messageId) {
          return JSON.stringify({ success: false, error: "messageId required" });
        }
        const message = await getMessage(params.messageId, "full", accountId);
        return JSON.stringify({ success: true, message });
      }

      case "get_thread": {
        if (!params.threadId) {
          return JSON.stringify({ success: false, error: "threadId required" });
        }
        const thread = await getThread(params.threadId, accountId);
        return JSON.stringify({ success: true, thread });
      }

      case "send": {
        if (!params.to || !params.subject || !params.body) {
          return JSON.stringify({ success: false, error: "to, subject, and body required" });
        }
        const result = await sendMessage(params.to, params.subject, params.body, {
          cc: params.cc,
          bcc: params.bcc,
          accountId,
        });
        return JSON.stringify({
          success: true,
          message: `Email sent to ${params.to}`,
          id: result.id,
          threadId: result.threadId,
        });
      }

      case "reply": {
        if (!params.messageId || !params.body) {
          return JSON.stringify({ success: false, error: "messageId and body required" });
        }
        const original = await getMessage(params.messageId, "metadata", accountId);
        const subject = original.subject.startsWith("Re:")
          ? original.subject
          : `Re: ${original.subject}`;

        // Extract reply-to address
        const replyTo = original.from.match(/<([^>]+)>/)?.[1] || original.from;

        const result = await sendMessage(replyTo, subject, params.body, {
          threadId: original.threadId,
          inReplyTo: params.messageId,
          references: params.messageId,
          accountId,
        });
        return JSON.stringify({
          success: true,
          message: `Reply sent to ${replyTo}`,
          id: result.id,
          threadId: result.threadId,
        });
      }

      case "draft": {
        if (!params.to || !params.subject || !params.body) {
          return JSON.stringify({ success: false, error: "to, subject, and body required" });
        }
        const result = await createDraft(params.to, params.subject, params.body, {
          cc: params.cc,
          bcc: params.bcc,
          accountId,
        });
        return JSON.stringify({
          success: true,
          message: "Draft created",
          draftId: result.id,
          messageId: result.messageId,
        });
      }

      case "label": {
        if (!params.messageId || !params.labelId) {
          return JSON.stringify({ success: false, error: "messageId and labelId required" });
        }
        await modifyLabels(params.messageId, [params.labelId], [], accountId);
        return JSON.stringify({ success: true, message: `Label ${params.labelId} added` });
      }

      case "unlabel": {
        if (!params.messageId || !params.labelId) {
          return JSON.stringify({ success: false, error: "messageId and labelId required" });
        }
        await modifyLabels(params.messageId, [], [params.labelId], accountId);
        return JSON.stringify({ success: true, message: `Label ${params.labelId} removed` });
      }

      case "archive": {
        if (!params.messageId) {
          return JSON.stringify({ success: false, error: "messageId required" });
        }
        await archiveMessage(params.messageId, accountId);
        return JSON.stringify({ success: true, message: "Email archived" });
      }

      case "trash": {
        if (!params.messageId) {
          return JSON.stringify({ success: false, error: "messageId required" });
        }
        await trashMessage(params.messageId, accountId);
        return JSON.stringify({ success: true, message: "Email moved to trash" });
      }

      case "mark_read": {
        if (!params.messageId) {
          return JSON.stringify({ success: false, error: "messageId required" });
        }
        await markAsRead(params.messageId, accountId);
        return JSON.stringify({ success: true, message: "Marked as read" });
      }

      case "mark_unread": {
        if (!params.messageId) {
          return JSON.stringify({ success: false, error: "messageId required" });
        }
        await markAsUnread(params.messageId, accountId);
        return JSON.stringify({ success: true, message: "Marked as unread" });
      }

      case "star": {
        if (!params.messageId) {
          return JSON.stringify({ success: false, error: "messageId required" });
        }
        await starMessage(params.messageId, accountId);
        return JSON.stringify({ success: true, message: "Starred" });
      }

      case "unstar": {
        if (!params.messageId) {
          return JSON.stringify({ success: false, error: "messageId required" });
        }
        await unstarMessage(params.messageId, accountId);
        return JSON.stringify({ success: true, message: "Unstarred" });
      }

      case "create_label": {
        if (!params.labelName) {
          return JSON.stringify({ success: false, error: "labelName required" });
        }
        const label = await createLabel(params.labelName, accountId);
        return JSON.stringify({ success: true, label });
      }

      case "delete_label": {
        if (!params.labelId) {
          return JSON.stringify({ success: false, error: "labelId required" });
        }
        await deleteLabel(params.labelId, accountId);
        return JSON.stringify({ success: true, message: "Label deleted" });
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown action: ${params.action}` });
    }
  } catch (error: any) {
    console.error("[Gmail] Tool error:", error.message);
    return JSON.stringify({ success: false, error: error.message });
  }
}

// ============================================================
// Formatted Output Helpers
// ============================================================

export function formatEmailList(messages: GmailMessage[]): string {
  if (!messages.length) return "📭 No emails found.";

  const lines: string[] = ["📬 **Emails**", ""];

  for (const msg of messages) {
    const unread = msg.isUnread ? "🔵" : "⚪";
    const starred = msg.isStarred ? "⭐" : "";
    const date = new Date(msg.date).toLocaleDateString();

    lines.push(`${unread}${starred} **${msg.subject}**`);
    lines.push(`   From: ${msg.from}`);
    lines.push(`   ${date} — ${msg.snippet.slice(0, 80)}...`);
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================
// Agent Tool Factory (MCP / agent registry surface)
// ============================================================
// `gmailToolSchema.parameters` is a zod schema, but the agent tool registry +
// gateway `agent.tools.list` expose `parameters` as a plain JSON schema object
// (serialized via toJsonSerializable and used for `action` folding). zod does
// not serialize to JSON schema, so we mirror the shape with TypeBox here — same
// pattern the other agent tools (notes/kanban) use. `handleGmailTool` still runs
// the authoritative zod validation internally.

const GMAIL_ACTIONS = [
  "list_labels",
  "list_messages",
  "get_message",
  "get_thread",
  "send",
  "reply",
  "draft",
  "label",
  "unlabel",
  "archive",
  "trash",
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
  "search",
  "create_label",
  "delete_label",
] as const;

const GmailToolParameters = Type.Object({
  action: stringEnum(GMAIL_ACTIONS),
  /** Optional account id when multiple Gmail accounts are connected. Falls back to default. */
  accountId: Type.Optional(Type.String()),
  /** Gmail search query (for list_messages/search). */
  query: Type.Optional(Type.String()),
  /** Label ids to filter by (for list_messages). */
  labelIds: Type.Optional(Type.Array(Type.String())),
  /** Max results to return. */
  maxResults: Type.Optional(Type.Number()),
  /** Pagination token from a previous list/search. */
  pageToken: Type.Optional(Type.String()),
  /** Message id (for get_message/reply/label/archive/trash/etc). */
  messageId: Type.Optional(Type.String()),
  /** Thread id (for get_thread/send). */
  threadId: Type.Optional(Type.String()),
  /** Label id (for label/unlabel/delete_label). */
  labelId: Type.Optional(Type.String()),
  /** Recipient (for send/draft). */
  to: Type.Optional(Type.String()),
  /** Subject line (for send/draft). */
  subject: Type.Optional(Type.String()),
  /** Message body (for send/reply/draft). */
  body: Type.Optional(Type.String()),
  /** CC recipients (for send/draft). */
  cc: Type.Optional(Type.String()),
  /** BCC recipients (for send/draft). */
  bcc: Type.Optional(Type.String()),
  /** New label name (for create_label). */
  labelName: Type.Optional(Type.String()),
});

/** Actions whose results carry email content written by third parties. */
const GMAIL_CONTENT_ACTIONS = new Set(["list_messages", "search", "get_message", "get_thread"]);

/**
 * Email content is attacker-controlled (anyone can mail the inbox), so read
 * results reach the model inside the untrusted-content markers. `details`
 * keeps the parsed object for UI/MCP consumers.
 */
export function wrapGmailToolResult(action: unknown, details: unknown) {
  const base = jsonResult(details);
  if (typeof action !== "string" || !GMAIL_CONTENT_ACTIONS.has(action)) return base;
  if ((details as { success?: unknown } | null)?.success === false) return base;
  const text = base.content[0]?.type === "text" ? base.content[0].text : JSON.stringify(details);
  return {
    ...base,
    content: [
      {
        type: "text" as const,
        text: wrapExternalContent(text, { source: "email", subject: `gmail ${action} result` }),
      },
    ],
  };
}

export function createGmailTool(): AnyAgentTool {
  return {
    label: "Gmail",
    name: "gmail",
    description: gmailToolSchema.description,
    parameters: GmailToolParameters,
    execute: async (_toolCallId, args) => {
      if (!isGmailConfigured()) {
        return jsonResult(GMAIL_NOT_CONNECTED());
      }
      try {
        const raw = await handleGmailTool(args as z.input<(typeof gmailToolSchema)["parameters"]>);
        // handleGmailTool returns a JSON string; surface the parsed object as
        // details while keeping the text content for MCP text rendering.
        let details: unknown = raw;
        try {
          details = JSON.parse(raw);
        } catch {
          /* leave as string if not valid JSON */
        }
        return wrapGmailToolResult((args as { action?: unknown } | null)?.action, details);
      } catch (e) {
        return jsonResult({ success: false, error: String(e) });
      }
    },
  };
}

export function formatEmail(msg: GmailMessage): string {
  const lines: string[] = [];

  lines.push(`# ${msg.subject}`);
  lines.push("");
  lines.push(`**From:** ${msg.from}`);
  lines.push(`**To:** ${msg.to}`);
  lines.push(`**Date:** ${new Date(msg.date).toLocaleString()}`);

  if (msg.attachments?.length) {
    lines.push(`**Attachments:** ${msg.attachments.map((a) => a.filename).join(", ")}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(msg.body || msg.snippet);

  return lines.join("\n");
}
