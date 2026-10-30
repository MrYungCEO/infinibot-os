/**
 * Shared chat-session plumbing for every chat surface: the full-page Chat
 * (<webchat-view>) and the topbar chat sidebar (<agent-chat-modal>).
 *
 * Both read and write the SAME gateway session store (sessions.list /
 * sessions.patch / sessions.delete / chat.history), so a chat started in one
 * surface shows up in the other. This module owns:
 *   - which session keys count as the user's chats + how they are titled,
 *   - paged session listing (server-side offset/search, with a client-side
 *     fallback for gateways that predate those params),
 *   - paged history (chat.history `beforeIndex` scroll-back, same fallback),
 *   - rename / delete + the change signal both surfaces listen to,
 *   - the per-agent "last selected session" memory.
 *
 * DOM-free apart from the optional window event, so it runs under node vitest.
 */

import type { GatewaySessionRow, SessionsListResult } from "../types";
import { GROUP_CHAT_PREFIX } from "../../../../src/shared/group-chat/keys.js";
import { stripEnvelope } from "./message-extract";
import { isSecureSessionKey, SECURE_SESSION_PREFIX } from "../secure-mode/session-key";
import { isSecureModeActive } from "../secure-mode/store";

/** Session-key suffix prefix for chats started in webchat or the sidebar. */
export const WEBCHAT_SESSION_PREFIX = "webchat-";
/**
 * The user's chat threads, by key rest (after `agent:<id>:`): new chats
 * (`webchat-…`), agent group chats (`groupchat-…`) plus the sidebar's legacy
 * one-per-agent threads.
 */
export const CHAT_SESSION_PREFIXES = [WEBCHAT_SESSION_PREFIX, GROUP_CHAT_PREFIX, "quick-chat", "cmo-chat"] as const;
/**
 * Prefixes to list right now: secure 1:1 chats (`secure-…`) join the list only
 * while Secure Mode is on; secure groups ride on the group prefix and are
 * filtered out by `isChatSessionKey` while it is off.
 */
export function chatSessionPrefixes(secureOn = isSecureModeActive()): string[] {
  return secureOn ? [...CHAT_SESSION_PREFIXES, SECURE_SESSION_PREFIX] : [...CHAT_SESSION_PREFIXES];
}
/** Gateway event broadcast after sessions.patch / reset / delete. */
export const GATEWAY_SESSIONS_CHANGED_EVENT = "sessions.changed";
/** Same-page signal (works against gateways without `sessions.changed`). */
export const CHAT_SESSIONS_CHANGED_EVENT = "infinibot:chat-sessions-changed";
export const LAST_SESSION_STORAGE_KEY = "infinibot.agentChat.lastSessionByAgent";

export const SESSIONS_PAGE_SIZE = 30;
export const HISTORY_PAGE_SIZE = 60;

type RequestClient = { request<T = unknown>(method: string, params?: unknown): Promise<T> };
type StorageLike = Pick<Storage, "getItem" | "setItem">;

// ── keys + titles ──────────────────────────────────────────────────────────

export function agentIdFromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = /^agent:([^:]+):/.exec(key);
  return m ? m[1] : null;
}

/** True for sessions that belong in a chat list (webchat + sidebar threads). */
export function isChatSessionKey(key: string | null | undefined, secureOn = isSecureModeActive()): boolean {
  if (!key) return false;
  const m = /^agent:[^:]+:(.+)$/.exec(key);
  if (!m) return false;
  const rest = m[1];
  // Secure Mode sessions are hidden from every chat list while it is off.
  if (isSecureSessionKey(key)) {
    return secureOn && (rest.toLowerCase().startsWith(SECURE_SESSION_PREFIX) || rest.startsWith(GROUP_CHAT_PREFIX));
  }
  return (
    rest.startsWith(WEBCHAT_SESSION_PREFIX) ||
    rest.startsWith(GROUP_CHAT_PREFIX) ||
    rest === "quick-chat" ||
    rest === "cmo-chat"
  );
}

/** A fresh, never-used chat session key for `agentId` (same shape webchat mints). */
export function newChatSessionKey(agentId: string, now = Date.now(), rand = Math.random()): string {
  const id = (agentId || "main").trim() || "main";
  const tail = Math.floor(rand * 36 * 36).toString(36).padStart(2, "0");
  return `agent:${id}:${WEBCHAT_SESSION_PREFIX}${now.toString(36)}${tail}`;
}

/** Drop transport envelopes and gateway-appended `[message_id: …]` tags. */
export function cleanUserText(text: string): string {
  return stripEnvelope(text)
    .replace(/\s*\[message_id:[^\]]*\]?\s*$/i, "")
    .trim();
}

export function sessionTitle(row: GatewaySessionRow): string {
  if (row.label) return row.label;
  if (/^agent:[^:]+:groupchat-/.test(row.key)) return "Group chat";
  const t = cleanUserText(row.derivedTitle || row.displayName || "");
  return t || "New chat";
}

/** One-line last-message preview (empty when the gateway sent none). */
export function sessionPreview(row: GatewaySessionRow, max = 140): string {
  const raw = cleanUserText(row.lastMessagePreview ?? "").replace(/\s+/g, " ");
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/** Compact relative time for session lists ("now", "12m", "3h", "Yesterday", "Mon", "Sep 3"). */
export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "";
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  if (diff < min) return "now";
  if (diff < 60 * min) return `${Math.floor(diff / min)}m`;
  const d = new Date(ts);
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startToday) return `${Math.floor(diff / (60 * min))}h`;
  if (ts >= startToday - 86_400_000) return "Yesterday";
  if (ts >= startToday - 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "2-digit" } : {}),
  });
}

/** Path of the full-page Chat opened on `key` (`<base>/webchat/<key>`). */
export function webchatPathForKey(key: string | null, basePath = ""): string {
  const base = basePath && basePath !== "/" ? basePath.replace(/\/+$/, "") : "";
  return `${base}/webchat${key ? `/${encodeURIComponent(key)}` : ""}`;
}

/** Merge a fetched page into a list: dedupe by key, keep newest-first order. */
export function mergeSessionRows(existing: GatewaySessionRow[], page: GatewaySessionRow[]): GatewaySessionRow[] {
  const byKey = new Map<string, GatewaySessionRow>();
  for (const r of existing) byKey.set(r.key, r);
  for (const r of page) byKey.set(r.key, { ...byKey.get(r.key), ...r });
  return [...byKey.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// ── paged listing ──────────────────────────────────────────────────────────

export type SessionsPageQuery = {
  /** Only this agent's chats; omit for "All agents". */
  agentId?: string | null;
  search?: string;
  offset?: number;
  limit?: number;
  /** Read each row's last message for the preview line (one small read per row). */
  includeLastMessage?: boolean;
};

export type SessionsPage = {
  sessions: GatewaySessionRow[];
  hasMore: boolean;
  total: number | null;
  defaults?: SessionsListResult["defaults"];
};

/** Old gateways reject unknown params (additionalProperties: false). */
export function isUnsupportedParamError(err: unknown): boolean {
  return /additional propert|must NOT have additional|unexpected propert/i.test(String((err as Error)?.message ?? err));
}

const legacyListClients = new WeakSet<object>();
const legacyListCache = new WeakMap<object, { at: number; agentId: string; rows: GatewaySessionRow[] }>();
const LEGACY_CACHE_MS = 5_000;

/** Client-side search over what the lists show (title, preview, key). */
export function matchesSessionSearch(row: GatewaySessionRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [sessionTitle(row), row.lastMessagePreview, row.label, row.displayName, row.key].some(
    (f) => typeof f === "string" && f.toLowerCase().includes(q),
  );
}

/**
 * One page of the user's chat sessions, newest first. Uses the gateway's
 * `sessionPrefixes` + `offset` paging; against an older gateway it lists once,
 * then filters/searches/pages on the client.
 */
export async function fetchChatSessionsPage(client: RequestClient, q: SessionsPageQuery = {}): Promise<SessionsPage> {
  const limit = Math.max(1, q.limit ?? SESSIONS_PAGE_SIZE);
  const offset = Math.max(0, q.offset ?? 0);
  const agentId = q.agentId?.trim() || undefined;
  const search = q.search?.trim() || undefined;
  if (!legacyListClients.has(client)) {
    try {
      const res = await client.request<SessionsListResult>("sessions.list", {
        sessionPrefixes: chatSessionPrefixes(),
        ...(agentId ? { agentId } : {}),
        ...(search ? { search } : {}),
        offset,
        limit,
        includeDerivedTitles: true,
        ...(q.includeLastMessage === false ? {} : { includeLastMessage: true }),
      });
      const rows = (Array.isArray(res?.sessions) ? res.sessions : []).filter((r) => isChatSessionKey(r.key));
      return {
        sessions: rows,
        hasMore: typeof res?.hasMore === "boolean" ? res.hasMore : rows.length >= limit,
        total: typeof res?.total === "number" ? res.total : null,
        defaults: res?.defaults,
      };
    } catch (err) {
      if (!isUnsupportedParamError(err)) throw err;
      legacyListClients.add(client);
    }
  }
  // Legacy gateway: one list (cached briefly so paging doesn't re-read every transcript).
  const cacheKey = agentId ?? "";
  let cached = legacyListCache.get(client);
  if (!cached || cached.agentId !== cacheKey || Date.now() - cached.at > LEGACY_CACHE_MS || offset === 0) {
    const res = await client.request<SessionsListResult>("sessions.list", {
      ...(agentId ? { agentId } : {}),
      limit: 1000,
      includeDerivedTitles: true,
      ...(q.includeLastMessage === false ? {} : { includeLastMessage: true }),
    });
    const rows = (Array.isArray(res?.sessions) ? res.sessions : []).filter((r) => isChatSessionKey(r.key));
    cached = { at: Date.now(), agentId: cacheKey, rows };
    legacyListCache.set(client, cached);
  }
  const matched = search ? cached.rows.filter((r) => matchesSessionSearch(r, search)) : cached.rows;
  return {
    sessions: matched.slice(offset, offset + limit),
    hasMore: offset + limit < matched.length,
    total: matched.length,
  };
}

// ── paged history ──────────────────────────────────────────────────────────

export type HistoryPage = {
  messages: Array<{ role?: string }>;
  /** Absolute transcript index of messages[0]; the next scroll-back cursor. */
  startIndex: number;
  hasMore: boolean;
  thinkingLevel?: string | null;
};

/**
 * The newest `limit` messages of a session, or (with `beforeIndex`) the page
 * just older than a previous page. An older gateway without cursor support
 * returns the whole transcript as one page (the caller windows it).
 */
export async function fetchHistoryPage(
  client: RequestClient,
  sessionKey: string,
  opts: { beforeIndex?: number; limit?: number } = {},
): Promise<HistoryPage> {
  const limit = Math.max(1, opts.limit ?? HISTORY_PAGE_SIZE);
  type Res = {
    messages?: Array<{ role?: string }>;
    startIndex?: number;
    hasMore?: boolean;
    thinkingLevel?: string | null;
  };
  const params: Record<string, unknown> = { sessionKey, limit };
  if (typeof opts.beforeIndex === "number") params.beforeIndex = opts.beforeIndex;
  let res: Res;
  try {
    res = await client.request<Res>("chat.history", params);
  } catch (err) {
    if (!isUnsupportedParamError(err)) throw err;
    res = await legacyFullHistory(client, sessionKey);
    return { messages: res.messages ?? [], startIndex: 0, hasMore: false, thinkingLevel: res.thinkingLevel };
  }
  if (typeof res?.startIndex !== "number") {
    // No cursor support: fetch everything once rather than stop at `limit`.
    if (typeof opts.beforeIndex === "number") return { messages: [], startIndex: 0, hasMore: false };
    const full = (res?.messages?.length ?? 0) >= limit ? await legacyFullHistory(client, sessionKey) : res;
    return { messages: full.messages ?? [], startIndex: 0, hasMore: false, thinkingLevel: full.thinkingLevel };
  }
  return {
    messages: Array.isArray(res.messages) ? res.messages : [],
    startIndex: res.startIndex,
    hasMore: typeof res.hasMore === "boolean" ? res.hasMore : res.startIndex > 0,
    thinkingLevel: res.thinkingLevel,
  };
}

async function legacyFullHistory(client: RequestClient, sessionKey: string) {
  type Res = { messages?: Array<{ role?: string }>; thinkingLevel?: string | null };
  try {
    return await client.request<Res>("chat.history", { sessionKey, limit: 10_000 });
  } catch (err) {
    if (!/must be <= 1000/.test(String(err))) throw err;
    return client.request<Res>("chat.history", { sessionKey, limit: 1000 });
  }
}

// ── mutations + change signal ──────────────────────────────────────────────

export type SessionsChangedDetail = { key?: string; reason: string; source?: string };

/** Tell same-page chat surfaces to re-read their session lists. */
export function notifyChatSessionsChanged(detail: SessionsChangedDetail): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(CHAT_SESSIONS_CHANGED_EVENT, { detail }));
  } catch {
    /* no window (tests) */
  }
}

/**
 * Does a gateway event mean a chat list may be stale? `sessions.changed`
 * always; a `chat` frame when it's for a chat session the list doesn't know
 * yet (a chat just started elsewhere) or a turn just finished (order/preview).
 */
export function isSessionListEvent(
  evt: { event?: string; payload?: unknown },
  knows: (key: string) => boolean,
): boolean {
  if (evt.event === GATEWAY_SESSIONS_CHANGED_EVENT) return true;
  if (evt.event !== "chat") return false;
  const p = evt.payload as { sessionKey?: string; state?: string } | undefined;
  if (!p?.sessionKey || !isChatSessionKey(p.sessionKey)) return false;
  return !knows(p.sessionKey) || p.state === "final";
}

export async function renameChatSession(client: RequestClient, key: string, label: string | null): Promise<void> {
  await client.request("sessions.patch", { key, label: label?.trim() || null });
  notifyChatSessionsChanged({ key, reason: "patch" });
}

/** Deletes the session; the gateway archives its transcript. */
export async function deleteChatSession(client: RequestClient, key: string): Promise<void> {
  await client.request("sessions.delete", { key, deleteTranscript: true });
  forgetRememberedSession(key);
  notifyChatSessionsChanged({ key, reason: "delete" });
}

// ── last selected session per agent ────────────────────────────────────────

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readRemembered(storage: StorageLike | null): Record<string, string> {
  try {
    const raw = storage?.getItem(LAST_SESSION_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeRemembered(map: Record<string, string>, storage: StorageLike | null): void {
  try {
    storage?.setItem(LAST_SESSION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota — remembering is best-effort */
  }
}

export function loadRememberedSession(agentId: string, storage: StorageLike | null = defaultStorage()): string | null {
  const key = readRemembered(storage)[agentId];
  return typeof key === "string" && agentIdFromKey(key) === agentId ? key : null;
}

export function rememberSession(key: string, storage: StorageLike | null = defaultStorage()): void {
  const agentId = agentIdFromKey(key);
  if (!agentId) return;
  const map = readRemembered(storage);
  if (map[agentId] === key) return;
  map[agentId] = key;
  writeRemembered(map, storage);
}

export function forgetRememberedSession(key: string, storage: StorageLike | null = defaultStorage()): void {
  const map = readRemembered(storage);
  let changed = false;
  for (const [agent, k] of Object.entries(map)) {
    if (k === key) {
      delete map[agent];
      changed = true;
    }
  }
  if (changed) writeRemembered(map, storage);
}
