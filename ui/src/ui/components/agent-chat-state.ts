/**
 * Pure state/logic for <agent-chat-modal> — kept DOM-free so it runs under the
 * node vitest config. Covers the session-key mapping, per-agent threads, the
 * open/alias event contract, suggestions and last-used-agent persistence.
 */

import type { GatewayAgentRow } from "../types";
import { extractPanelRefsFromMessage, type ChatPanelRef } from "../chat-panels/panel-ref";

export type ChatItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  /**
   * A tool call. `status` drives the loading card: running (animated) →
   * done / error (collapses to a pill). Items without a status are legacy pills.
   */
  | {
      role: "tool";
      name: string;
      detail?: string;
      callId?: string;
      status?: "running" | "done" | "error";
      startedAt?: number;
      endedAt?: number;
    }
  | { role: "tool_result"; name: string; text: string }
  /** Agent-invokable panel (show_panel) — rendered by the shared chat-panels card. */
  | { role: "panel"; ref: ChatPanelRef }
  | { role: "error"; text: string };

/** Session suffix for the universal chat modal: `agent:<id>:quick-chat`. */
export const QUICK_CHAT_SUFFIX = "quick-chat";
/** Legacy suffix the CMO-locked `<cmo-chat>` embed keeps using (history continuity). */
export const CMO_CHAT_SUFFIX = "cmo-chat";
export const CMO_AGENT_ID = "cmo";
export const DEFAULT_AGENT_ID = "main";
export const LAST_AGENT_STORAGE_KEY = "infinibot.agentChat.lastAgent";

export const AGENT_CHAT_EVENT = "infinibot:agent-chat";
export const CMO_CHAT_EVENT = "infinibot:cmo-chat";

export function normalizeAgentId(id: unknown): string {
  return typeof id === "string" ? id.trim() : "";
}

export function sessionKeyFor(agentId: string, suffix = QUICK_CHAT_SUFFIX): string {
  return `agent:${normalizeAgentId(agentId) || DEFAULT_AGENT_ID}:${suffix}`;
}

/** Inverse of sessionKeyFor — returns the agent id, or null for foreign keys. */
export function agentIdFromSessionKey(key: unknown, suffix = QUICK_CHAT_SUFFIX): string | null {
  if (typeof key !== "string") return null;
  const m = /^agent:([^:]+):(.+)$/.exec(key);
  return m && m[2] === suffix ? m[1] : null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadLastAgent(storage: StorageLike | null = defaultStorage()): string | null {
  try {
    return normalizeAgentId(storage?.getItem(LAST_AGENT_STORAGE_KEY)) || null;
  } catch {
    return null;
  }
}

export function saveLastAgent(agentId: string, storage: StorageLike | null = defaultStorage()): void {
  const id = normalizeAgentId(agentId);
  if (!id) return;
  try {
    storage?.setItem(LAST_AGENT_STORAGE_KEY, id);
  } catch {
    /* private mode / quota — remembering is best-effort */
  }
}

/** Initial agent: explicit request → last used → `main` (if listed) → gateway default. */
export function resolveInitialAgent(opts: {
  requested?: string | null;
  lastUsed?: string | null;
  agents?: GatewayAgentRow[];
  defaultId?: string | null;
}): string {
  const requested = normalizeAgentId(opts.requested);
  if (requested) return requested;
  const agents = opts.agents ?? [];
  const known = (id: string) => agents.length === 0 || agents.some((a) => a.id === id);
  const last = normalizeAgentId(opts.lastUsed);
  if (last && known(last)) return last;
  if (known(DEFAULT_AGENT_ID)) return DEFAULT_AGENT_ID;
  return normalizeAgentId(opts.defaultId) || agents[0]?.id || DEFAULT_AGENT_ID;
}

export type ChatOpenRequest = {
  action: "open" | "close" | "toggle";
  agentId?: string;
  /** Open on this exact session (chat follows navigation). */
  sessionKey?: string;
  /** Opened by "chat follows navigation": don't steal focus from the page. */
  follow?: boolean;
};

/**
 * Map a window event onto an open request. `infinibot:agent-chat` opens on
 * detail.agentId (or toggles on the current agent); the legacy
 * `infinibot:cmo-chat` always targets the CMO.
 */
export function resolveChatEvent(type: string, detail: unknown): ChatOpenRequest | null {
  const d = (detail && typeof detail === "object" ? detail : {}) as {
    action?: unknown;
    agentId?: unknown;
    sessionKey?: unknown;
    follow?: unknown;
  };
  const action = d.action === "open" || d.action === "close" || d.action === "toggle" ? d.action : null;
  if (type === CMO_CHAT_EVENT) return { action: action ?? "toggle", agentId: CMO_AGENT_ID };
  if (type === AGENT_CHAT_EVENT) {
    const sessionKey =
      typeof d.sessionKey === "string" && /^agent:[^:]+:.+/.test(d.sessionKey.trim()) ? d.sessionKey.trim() : undefined;
    const agentId = (sessionKey ? normalizeAgentId(/^agent:([^:]+):/.exec(sessionKey)?.[1]) : normalizeAgentId(d.agentId)) || undefined;
    return {
      action: action ?? (agentId ? "open" : "toggle"),
      agentId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(d.follow === true ? { follow: true } : {}),
    };
  }
  return null;
}

export function agentDisplayName(agent: GatewayAgentRow | undefined, id: string): string {
  if (id === CMO_AGENT_ID && !agent?.identity?.name && !agent?.name) return "CMO";
  return agent?.identity?.name || agent?.name || id;
}

export function filterAgents(agents: GatewayAgentRow[], query: string): GatewayAgentRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) =>
    [a.id, a.name, a.identity?.name, a.model].some((v) => typeof v === "string" && v.toLowerCase().includes(q)),
  );
}

const CMO_SUGGESTIONS = [
  "Why are my top reels winning?",
  "Audit my last 30 reels and find the pattern",
  "Write a viral reel script in my voice",
  "What format should I post more of?",
];

const GENERIC_SUGGESTIONS = [
  "What are you working on right now?",
  "Summarize what needs my attention today",
  "What can you help me with?",
  "Draft a quick plan for my next task",
];

export function suggestionsFor(agentId: string, agent?: GatewayAgentRow): string[] {
  const own = (agent as { suggestions?: unknown } | undefined)?.suggestions;
  if (Array.isArray(own) && own.every((s) => typeof s === "string") && own.length > 0) return own as string[];
  return agentId === CMO_AGENT_ID ? CMO_SUGGESTIONS : GENERIC_SUGGESTIONS;
}

/**
 * Panel cards carried by a live tool result (`agent` event, stream "tool",
 * phase "result": data.result = { content, details }). Uses the shared
 * chat-panels detector by framing the result as a toolResult message.
 */
export function panelItemsFromToolResult(result: unknown): ChatItem[] {
  const body = result && typeof result === "object" ? (result as Record<string, unknown>) : { content: result };
  return extractPanelRefsFromMessage({ ...body, role: "toolResult" }).map((ref) => ({ role: "panel", ref }));
}

type ToolItem = Extract<ChatItem, { role: "tool" }>;

/** A tool call started: add a running card (once per call id). */
export function startToolItem(
  items: ChatItem[],
  tool: { name: string; detail?: string; callId?: string; now: number },
): ChatItem[] {
  if (tool.callId && items.some((it) => it.role === "tool" && it.callId === tool.callId)) return items;
  const item: ToolItem = { role: "tool", name: tool.name, status: "running", startedAt: tool.now };
  if (tool.detail) item.detail = tool.detail;
  if (tool.callId) item.callId = tool.callId;
  return [...items, item];
}

/**
 * A tool call finished: settle its card (by call id, else the latest running
 * call with that name). Unknown calls leave the list unchanged.
 */
export function finishToolItem(
  items: ChatItem[],
  done: { name: string; callId?: string; isError?: boolean; now: number },
): ChatItem[] {
  let idx = -1;
  if (done.callId) idx = items.findIndex((it) => it.role === "tool" && it.callId === done.callId);
  if (idx === -1) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.role === "tool" && it.status === "running" && it.name === done.name) {
        idx = i;
        break;
      }
    }
  }
  const hit = idx === -1 ? undefined : items[idx];
  if (!hit || hit.role !== "tool" || hit.status !== "running") return items;
  const next = items.slice();
  next[idx] = { ...hit, status: done.isError ? "error" : "done", endedAt: done.now };
  return next;
}

/** Turn over: nothing can still be running (results may not have streamed). */
export function settleRunningTools(items: ChatItem[], now: number): ChatItem[] {
  if (!hasRunningTool(items)) return items;
  return items.map((it) => (it.role === "tool" && it.status === "running" ? { ...it, status: "done" as const, endedAt: now } : it));
}

export function hasRunningTool(items: ChatItem[]): boolean {
  return items.some((it) => it.role === "tool" && it.status === "running");
}

/**
 * Panels from a finished tool call go right after its card, so the result
 * appears where the loading card was. Falls back to appending.
 */
export function insertPanelsAfterTool(items: ChatItem[], callId: string | undefined, panels: ChatItem[]): ChatItem[] {
  const merged = withPanels(items, panels);
  if (merged === items || !callId) return merged;
  const idx = items.findIndex((it) => it.role === "tool" && it.callId === callId);
  if (idx === -1) return merged;
  const fresh = merged.slice(items.length);
  return [...items.slice(0, idx + 1), ...fresh, ...items.slice(idx + 1)];
}

/** Append panel items to a list, skipping panels it already shows. */
export function withPanels(items: ChatItem[], panels: ChatItem[]): ChatItem[] {
  const seen = new Set(items.flatMap((it) => (it.role === "panel" ? [it.ref.panelId] : [])));
  const fresh: ChatItem[] = [];
  for (const p of panels) {
    if (p.role !== "panel" || seen.has(p.ref.panelId)) continue;
    seen.add(p.ref.panelId);
    fresh.push(p);
  }
  return fresh.length ? [...items, ...fresh] : items;
}

/** Panel items produced during the latest turn (messages after the last user message). */
export function panelsForLastTurn(messages: Array<{ role?: string }> | undefined): ChatItem[] {
  const list = messages ?? [];
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }
  return list.slice(start).flatMap((m) => extractPanelRefsFromMessage(m).map((ref): ChatItem => ({ role: "panel", ref })));
}

/**
 * Add a turn's panels above its reply: before the trailing assistant bubble
 * (the answer that talks about the panel), else at the end. Skips duplicates.
 */
export function insertPanelsBeforeReply(items: ChatItem[], panels: ChatItem[]): ChatItem[] {
  const merged = withPanels(items, panels);
  if (merged === items) return items;
  const fresh = merged.slice(items.length);
  const last = items.at(-1);
  if (last?.role !== "assistant") return merged;
  return [...items.slice(0, -1), ...fresh, last];
}

/** chat.history messages → the modal's user/assistant bubbles + panel cards. */
export function historyToItems(
  messages: Array<{ role?: string }> | undefined,
  extract: (m: unknown) => string | null,
): ChatItem[] {
  let out: ChatItem[] = [];
  for (const m of messages ?? []) {
    // show_panel results live on toolResult messages (or tool_result blocks).
    const panels = extractPanelRefsFromMessage(m).map((ref): ChatItem => ({ role: "panel", ref }));
    if (panels.length) out = withPanels(out, panels);
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const text = extract(m)?.trim();
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

export type ChatThread = {
  items: ChatItem[];
  /** null = idle; "" = waiting for first token; otherwise the streamed text so far. */
  streamText: string | null;
  sending: boolean;
  error: string | null;
  hydrated: boolean;
  /** First history page in flight. */
  loading: boolean;
  /** First history page failed (retryable). */
  loadError: string | null;
  /** Older items already fetched but not shown yet (a gateway without paging sends the whole transcript). */
  olderBuffer: ChatItem[];
  /** Absolute transcript index of the oldest fetched message — the scroll-back cursor. */
  cursor: number;
  /** The gateway has messages before `cursor`. */
  hasMoreRemote: boolean;
  loadingOlder: boolean;
};

export function emptyThread(): ChatThread {
  return {
    items: [],
    streamText: null,
    sending: false,
    error: null,
    hydrated: false,
    loading: false,
    loadError: null,
    olderBuffer: [],
    cursor: 0,
    hasMoreRemote: false,
    loadingOlder: false,
  };
}

/** Items shown right after a session opens; the rest wait for scroll-back. */
export const HISTORY_WINDOW = 80;
/** Items revealed per scroll-back step from an already-fetched buffer. */
export const OLDER_CHUNK = 40;

/** Split history into the visible tail and the older remainder. */
export function splitHistoryWindow(items: ChatItem[], size = HISTORY_WINDOW): { visible: ChatItem[]; older: ChatItem[] } {
  if (items.length <= size) return { visible: items, older: [] };
  return { visible: items.slice(-size), older: items.slice(0, -size) };
}

/** Take the newest `n` items off an older-items buffer. */
export function takeOlderChunk(buffer: ChatItem[], n = OLDER_CHUNK): { chunk: ChatItem[]; rest: ChatItem[] } {
  if (buffer.length <= n) return { chunk: buffer, rest: [] };
  return { chunk: buffer.slice(-n), rest: buffer.slice(0, -n) };
}

export function threadHasOlder(t: ChatThread): boolean {
  return t.olderBuffer.length > 0 || t.hasMoreRemote;
}

/** Conversation buffers keyed by session key: switching away and back restores the thread. */
export class ThreadStore {
  private threads = new Map<string, ChatThread>();

  get(key: string): ChatThread {
    return this.threads.get(key) ?? emptyThread();
  }

  has(key: string): boolean {
    return this.threads.has(key);
  }

  patch(key: string, patch: Partial<ChatThread>): ChatThread {
    const next = { ...this.get(key), ...patch };
    this.threads.set(key, next);
    return next;
  }

  append(key: string, ...items: ChatItem[]): ChatThread {
    return this.patch(key, { items: [...this.get(key).items, ...items] });
  }

  /** Older history goes above what is shown. */
  prepend(key: string, items: ChatItem[]): ChatThread {
    if (!items.length) return this.get(key);
    return this.patch(key, { items: [...items, ...this.get(key).items] });
  }

  /** Seed from server history without clobbering anything typed meanwhile. */
  hydrate(key: string, history: ChatItem[]): ChatThread {
    const cur = this.get(key);
    return this.patch(key, { hydrated: true, items: [...history, ...cur.items] });
  }

  /** Forget a thread (it is re-read from the gateway next time it opens). */
  drop(key: string): void {
    this.threads.delete(key);
  }
}
