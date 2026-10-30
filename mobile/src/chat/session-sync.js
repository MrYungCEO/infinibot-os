/**
 * session-sync — the chat session model the mobile app shares with the web
 * chat (ui/src/ui/views/webchat.ts). Pure and RN-free, unit-tested in
 * src/__tests__/session-sync.test.js.
 *
 * The two clients stay in sync because they agree on four things, all of which
 * live here:
 *
 *   1. WHICH sessions are chats   — keys `agent:<agentId>:webchat-<base36 ts>`
 *                                   plus agent group chats `agent:<id>:groupchat-<id>`,
 *                                   listed with sessions.list { sessionPrefixes }
 *                                   (older gateways: { search: 'webchat-' })
 *   2. HOW a session is titled    — label → derived title (first user message)
 *                                   → "New chat"
 *   3. HOW the list is ordered    — pinned first, then day buckets, newest first
 *   4. HOW a transcript is read   — chat.history messages → turns of text / tool
 *                                   / panel blocks (buildTurns)
 *
 * Paging: newer gateways accept `offset` (sessions.list) and `beforeIndex`
 * (chat.history). Older ones reject unknown params outright, so both fetchers
 * feature-detect once and fall back to growing `limit`.
 */

import { CLI_LABELS, folderName, messageCli } from './cli-route';

export const SESSION_PREFIX = 'webchat-';
export const SESSIONS_PAGE_SIZE = 60;
export const HISTORY_PAGE_SIZE = 80;
export const DEFAULT_AGENT_ID = 'main';

// Agent group chats (src/shared/group-chat/keys.ts) list beside ordinary chats,
// like the web sidebar (ui/src/ui/chat/chat-sessions.ts CHAT_SESSION_PREFIXES).
export const GROUP_SESSION_PREFIX = 'groupchat-';
export const CHAT_SESSION_PREFIXES = [SESSION_PREFIX, GROUP_SESSION_PREFIX];

const CHAT_KEY_RE = /^agent:([^:]+):(webchat-|groupchat-)/;

// ── keys ──────────────────────────────────────────────────────────────────

export function agentIdFromKey(key) {
  const m = /^agent:([^:]+):/.exec(String(key || ''));
  return m ? m[1] : null;
}

/** True for the session keys the web chat sidebar lists. */
export function isChatSessionKey(key) {
  return CHAT_KEY_RE.test(String(key || ''));
}

/** Same key grammar the web composer mints on the first send of a new chat. */
export function newSessionKey(agentId = DEFAULT_AGENT_ID, now = Date.now()) {
  return `agent:${agentId || DEFAULT_AGENT_ID}:${SESSION_PREFIX}${now.toString(36)}`;
}

// ── text cleaning (mirrors ui/src/ui/chat/message-extract.ts) ─────────────

const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  'WebChat', 'WhatsApp', 'Telegram', 'Signal', 'Slack', 'Discord', 'iMessage',
  'Teams', 'Matrix', 'Zalo', 'Zalo Personal', 'BlueBubbles',
];

function looksLikeEnvelopeHeader(header) {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) return true;
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) return true;
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text) {
  const s = String(text ?? '');
  const match = s.match(ENVELOPE_PREFIX);
  if (!match) return s;
  if (!looksLikeEnvelopeHeader(match[1] ?? '')) return s;
  return s.slice(match[0].length);
}

/** Drop transport envelopes and gateway-appended `[message_id: …]` tags. */
export function cleanUserText(text) {
  return stripEnvelope(text)
    .replace(/\s*\[message_id:[^\]]*\]?\s*$/i, '')
    .trim();
}

/** Remove inline reasoning (`<think>…</think>`) the model leaked into its reply. */
export function stripThinkingTags(text) {
  return String(text ?? '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '')
    .replace(/^\s+/, '');
}

function contentArray(msg) {
  return Array.isArray(msg?.content) ? msg.content : [];
}

export function extractText(message) {
  if (!message || typeof message !== 'object') return typeof message === 'string' ? message : null;
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  const finish = (t) => (role === 'assistant' ? stripThinkingTags(t) : stripEnvelope(t));
  if (typeof message.content === 'string') return finish(message.content);
  const parts = contentArray(message)
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text);
  if (parts.length) return finish(parts.join('\n'));
  if (typeof message.text === 'string') return finish(message.text);
  if (role === 'assistant' && typeof message.errorMessage === 'string' && message.errorMessage.trim()) {
    return `Model error: ${message.errorMessage.trim()}`;
  }
  return null;
}

/** Replies that carry no conversation (heartbeat acks, silent turns). */
export function isSilentReply(text) {
  const t = String(text ?? '').trim();
  return !t || t === 'NO_REPLY' || t.startsWith('HEARTBEAT_OK');
}

// ── titles, ordering, grouping (mirrors webchat.ts) ───────────────────────

export function sessionTitle(row) {
  if (!row) return 'New chat';
  if (row.label) return row.label;
  if (/^agent:[^:]+:groupchat-/.test(String(row.key || ''))) return 'Group chat';
  const t = cleanUserText(row.derivedTitle || row.displayName || '');
  // The gateway falls back to "<sessionId prefix> (date)" / a transport display
  // name when a session has no user message yet — the web shows those verbatim,
  // and so do we, so the two lists read identically.
  return t || 'New chat';
}

export function sortSessions(rows) {
  return [...(rows || [])].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];

export function dayBucket(ts, now = new Date()) {
  if (!ts) return 'Older';
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (ts >= startToday) return 'Today';
  if (ts >= startToday - day) return 'Yesterday';
  if (ts >= startToday - 7 * day) return 'Previous 7 days';
  if (ts >= startToday - 30 * day) return 'Previous 30 days';
  return 'Older';
}

/** Compact relative time ("now", "12m", "3h", "Yesterday", "Mon", "Sep 3"). */
export function relTime(ts, now = Date.now()) {
  if (!ts) return '';
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  if (diff < min) return 'now';
  if (diff < 60 * min) return `${Math.floor(diff / min)}m`;
  const d = new Date(ts);
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startToday) return `${Math.floor(diff / (60 * min))}h`;
  if (ts >= startToday - 86_400_000) return 'Yesterday';
  if (ts >= startToday - 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: '2-digit' } : {}),
  });
}

/**
 * The sidebar model: `[{ title, rows }]` — a "Pinned" group, then the day
 * buckets in BUCKET_ORDER. `query` filters on title or key, like the web.
 */
export function groupSessions(rows, { query = '', now = new Date() } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const sorted = sortSessions(rows);
  const visible = q
    ? sorted.filter((s) => sessionTitle(s).toLowerCase().includes(q) || String(s.key).toLowerCase().includes(q))
    : sorted;
  const groups = [];
  const pinned = visible.filter((r) => r.pinned);
  if (pinned.length) groups.push({ title: 'Pinned', rows: pinned });
  const buckets = new Map();
  for (const r of visible) {
    if (r.pinned) continue;
    const b = dayBucket(r.updatedAt, now);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  for (const b of BUCKET_ORDER) {
    if (buckets.has(b)) groups.push({ title: b, rows: buckets.get(b) });
  }
  return groups;
}

/** More than one agent in the list → rows show which agent they belong to. */
export function isMultiAgent(rows) {
  return new Set((rows || []).map((s) => agentIdFromKey(s.key))).size > 1;
}

export function agentLabel(agents, id) {
  const a = (agents || []).find((x) => x.id === id);
  return a?.identity?.name || a?.name || id || DEFAULT_AGENT_ID;
}

/** Prefer `main` (what the web chat talks to), else the roster's default. */
export function pickDefaultAgentId(agentsResult) {
  const agents = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];
  if (agents.some((a) => a.id === DEFAULT_AGENT_ID)) return DEFAULT_AGENT_ID;
  return agentsResult?.defaultId || agents[0]?.id || DEFAULT_AGENT_ID;
}

/**
 * Merge a freshly fetched list into what is on screen. Rows are replaced by
 * key; an optimistic row for a chat the store has not written yet (first send
 * still in flight) survives until the store catches up.
 */
export function mergeSessions(prev, fetched, { keep = [] } = {}) {
  const out = (fetched || []).filter((r) => r && isChatSessionKey(r.key));
  const seen = new Set(out.map((r) => r.key));
  for (const key of keep) {
    if (!key || seen.has(key)) continue;
    const row = (prev || []).find((s) => s.key === key);
    if (row) {
      out.unshift(row);
      seen.add(key);
    }
  }
  return sortSessions(out);
}

// ── paging ────────────────────────────────────────────────────────────────

const UNEXPECTED_PARAM = /unexpected property|additional propert|invalid .* params/i;

/** Per-connection memo of which paging params this gateway accepts. */
export function makePagingCaps() {
  return { sessionsOffset: null, historyBefore: null, sessionPrefixes: null };
}

/**
 * One page of chat sessions. Returns `{ rows, hasMore, total, defaults }`.
 * `rows` is always the page ALONE (callers append) whichever path ran.
 */
export async function fetchSessionsPage(sendReq, { offset = 0, limit = SESSIONS_PAGE_SIZE, caps = makePagingCaps() } = {}) {
  const only = (res) => (Array.isArray(res?.sessions) ? res.sessions : []).filter((r) => isChatSessionKey(r?.key));
  // `sessionPrefixes` (webchat + group chats in one list) needs a gateway from
  // 2026-10; an older one rejects it, so fall back to the webchat-only search.
  const list = async (params) => {
    if (caps.sessionPrefixes !== false) {
      try {
        const res = await sendReq('sessions.list', { sessionPrefixes: CHAT_SESSION_PREFIXES, includeDerivedTitles: true, ...params });
        caps.sessionPrefixes = true;
        return res;
      } catch (err) {
        const msg = String(err?.message || err);
        if (!(UNEXPECTED_PARAM.test(msg) && /sessionPrefixes/.test(msg))) throw err;
        caps.sessionPrefixes = false;
      }
    }
    return sendReq('sessions.list', { search: SESSION_PREFIX, includeDerivedTitles: true, ...params });
  };

  // The first page needs no offset, so it is never sent there: a gateway
  // without paging support answers page one cleanly and the probe (one rejected
  // call) only happens if the user actually pages further.
  if (offset === 0 && caps.sessionsOffset !== true) {
    const res = await list({ limit });
    const all = Array.isArray(res?.sessions) ? res.sessions : [];
    return {
      rows: only(res),
      hasMore: typeof res?.hasMore === 'boolean' ? res.hasMore : all.length >= limit,
      total: typeof res?.total === 'number' ? res.total : null,
      defaults: res?.defaults ?? null,
    };
  }

  if (caps.sessionsOffset !== false) {
    try {
      const res = await list({ limit, offset });
      caps.sessionsOffset = true;
      const rows = only(res);
      const got = Array.isArray(res?.sessions) ? res.sessions.length : 0;
      return {
        rows,
        hasMore: typeof res?.hasMore === 'boolean' ? res.hasMore : got >= limit,
        total: typeof res?.total === 'number' ? res.total : null,
        defaults: res?.defaults ?? null,
      };
    } catch (err) {
      if (!UNEXPECTED_PARAM.test(String(err?.message || err))) throw err;
      caps.sessionsOffset = false;
    }
  }

  // Legacy gateway: no offset. Ask for everything up to the end of this page
  // and slice the tail off — the store returns newest first, so it is stable.
  const res = await list({ limit: offset + limit });
  const all = Array.isArray(res?.sessions) ? res.sessions : [];
  return {
    rows: only({ sessions: all.slice(offset) }),
    hasMore: all.length >= offset + limit,
    total: null,
    defaults: res?.defaults ?? null,
  };
}

/**
 * One page of transcript, oldest → newest. `before` is how many of the newest
 * messages the caller already holds. Returns `{ messages, hasMore, thinkingLevel }`
 * where `messages` is the older page alone.
 */
export async function fetchHistoryPage(sendReq, { sessionKey, limit = HISTORY_PAGE_SIZE, before = 0, total = null, caps = makePagingCaps() } = {}) {
  if (before > 0 && caps.historyBefore !== false && typeof total === 'number') {
    try {
      const beforeIndex = Math.max(0, total - before);
      const res = await sendReq('chat.history', { sessionKey, limit, beforeIndex });
      caps.historyBefore = true;
      const messages = Array.isArray(res?.messages) ? res.messages : [];
      return {
        messages,
        hasMore: typeof res?.hasMore === 'boolean' ? res.hasMore : (res?.startIndex ?? 0) > 0,
        total: typeof res?.total === 'number' ? res.total : total,
        thinkingLevel: res?.thinkingLevel ?? null,
      };
    } catch (err) {
      if (!UNEXPECTED_PARAM.test(String(err?.message || err))) throw err;
      caps.historyBefore = false;
    }
  }
  const res = await sendReq('chat.history', { sessionKey, limit: before + limit });
  const all = Array.isArray(res?.messages) ? res.messages : [];
  const older = before > 0 ? all.slice(0, Math.max(0, all.length - before)) : all;
  return {
    messages: older,
    hasMore: all.length >= before + limit,
    total: typeof res?.total === 'number' ? res.total : null,
    thinkingLevel: res?.thinkingLevel ?? null,
  };
}

// ── chat panels (mirrors ui/src/ui/chat-panels/panel-ref.ts) ──────────────

export const SHOW_PANEL_TOOL = 'show_panel';

function coercePanelRef(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.v !== 1 || typeof v.kind !== 'string' || !v.kind) return null;
  const link = v.link && typeof v.link === 'object' ? v.link : { tab: '', label: '' };
  return {
    v: 1,
    panelId: typeof v.panelId === 'string' && v.panelId ? v.panelId : `panel_${v.kind}_${String(v.ts ?? '')}`,
    kind: v.kind,
    query: v.query && typeof v.query === 'object' ? v.query : {},
    title: typeof v.title === 'string' ? v.title : v.kind,
    display: v.display === 'modal' ? 'modal' : 'inline',
    summary: typeof v.summary === 'string' ? v.summary : '',
    count: typeof v.count === 'number' ? v.count : 0,
    empty: v.empty === true,
    error: typeof v.error === 'string' ? v.error : null,
    link,
    refreshMs: typeof v.refreshMs === 'number' ? v.refreshMs : 0,
    ts: typeof v.ts === 'number' ? v.ts : 0,
  };
}

function sliceObject(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Find a `chatPanel` ref in a show_panel tool result (object or JSON text). */
export function extractPanelRef(source) {
  if (!source) return null;
  if (typeof source === 'object') {
    return coercePanelRef(source.chatPanel) || coercePanelRef(source.details?.chatPanel) || null;
  }
  const text = String(source);
  const at = text.indexOf('"chatPanel"');
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  if (open < 0) return null;
  const body = sliceObject(text, open);
  if (!body) return null;
  try {
    return coercePanelRef(JSON.parse(body));
  } catch {
    return null;
  }
}

// ── transcript model (mirrors webchat.ts buildTurns) ──────────────────────

function isToolCallItem(item) {
  const kind = String(item?.type ?? '').toLowerCase();
  return kind === 'toolcall' || kind === 'tool_call' || kind === 'tooluse' || kind === 'tool_use';
}

function isToolResultMsg(m) {
  const role = String(m?.role ?? '').toLowerCase();
  if (role === 'toolresult' || role === 'tool_result' || role === 'tool') return true;
  return typeof m?.toolCallId === 'string' && role !== 'assistant' && role !== 'user';
}

function toolResultText(msg) {
  const t = extractText(msg);
  if (t) return t;
  return contentArray(msg)
    .map((c) => (typeof c?.text === 'string' ? c.text : null))
    .filter(Boolean)
    .join('\n');
}

function imageUris(msg) {
  return contentArray(msg)
    .filter((c) => c && c.type === 'image')
    .map((c) => {
      const src = c.source;
      const data = typeof src?.data === 'string' ? src.data : typeof c.data === 'string' ? c.data : '';
      if (!data) return typeof c.url === 'string' ? c.url : '';
      if (data.startsWith('data:')) return data;
      const mime = src?.media_type || c.mimeType || 'image/png';
      return `data:${mime};base64,${data}`;
    })
    .filter(Boolean);
}

function toolBlock(tool, details) {
  const panel = tool.name === SHOW_PANEL_TOOL || /"chatPanel"/.test(String(tool.result || ''))
    ? extractPanelRef(details) || extractPanelRef(tool.result)
    : null;
  return panel ? { kind: 'panel', panel, tool } : { kind: 'tool', tool };
}

/**
 * Raw gateway messages (+ the live run, if any) → render turns:
 *   { role:'user', id, text, images, ts, pending?, failed? }
 *   { role:'assistant', id, blocks:[{kind:'text'|'tool'|'panel', …}], model?, streaming?, ts }
 *
 * `live` = { runId, stream, tools:[{ id, name, args, result, pending }] }.
 */
export function buildTurns(messages, live = null) {
  const turns = [];
  const msgs = Array.isArray(messages) ? messages : [];
  const results = new Map();
  const details = new Map();
  for (const m of msgs) {
    if (isToolResultMsg(m) && typeof m.toolCallId === 'string') {
      results.set(m.toolCallId, toolResultText(m));
      if (m.details) details.set(m.toolCallId, m);
    }
  }
  const consumed = new Set();
  const assistantTurn = (id, ts) => {
    const last = turns[turns.length - 1];
    if (last?.role === 'assistant') return last;
    const t = { role: 'assistant', id, blocks: [], ts };
    turns.push(t);
    return t;
  };

  msgs.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const role = String(m.role ?? '').toLowerCase();
    const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
    const id = String(m.id ?? m.clientMsgId ?? m.runId ?? `${i}-${m.timestamp ?? ''}`);
    if (role === 'user') {
      const text = cleanUserText(extractText(m) ?? '');
      const images = imageUris(m);
      if (!text.trim() && images.length === 0) return;
      turns.push({ role: 'user', id, text, images, ts, pending: Boolean(m.pending), failed: Boolean(m.failed) });
      return;
    }
    if (isToolResultMsg(m)) {
      const callId = typeof m.toolCallId === 'string' ? m.toolCallId : '';
      if (callId && consumed.has(callId)) return;
      const name = m.toolName || m.tool_name || 'tool';
      assistantTurn(id, ts).blocks.push(toolBlock({ id: callId || id, name, result: toolResultText(m) }, m));
      return;
    }
    if (role !== 'assistant') return;
    const turn = assistantTurn(id, ts);
    // "infinibot/*" rows are gateway-synthesized (delivery mirrors), not a model.
    if (typeof m.model === 'string' && m.model && m.provider !== 'infinibot') {
      turn.model = typeof m.provider === 'string' && m.provider ? `${m.provider}/${m.model}` : m.model;
    }
    // Chat CLI mode (chat.cli.send): name the CLI, fold its tool calls.
    const cliId = messageCli(m);
    if (cliId) {
      turn.model = `${CLI_LABELS[cliId]} · CLI${m.cli?.cwd ? ` · ${folderName(m.cli.cwd)}` : ''}`;
      turn.cli = cliId;
      if (Array.isArray(m.cliTools)) {
        for (const tl of m.cliTools) {
          if (!tl?.name) continue;
          turn.blocks.push(toolBlock({ id: String(tl.id || `${id}-cli-${turn.blocks.length}`), name: String(tl.name), args: tl.input, result: tl.output }, null));
        }
      }
    }
    const items = contentArray(m);
    if (items.length === 0) {
      const text = extractText(m);
      if (text && !isSilentReply(text)) turn.blocks.push({ kind: 'text', text });
      return;
    }
    let buf = [];
    const flush = () => {
      const joined = stripThinkingTags(buf.join('\n'));
      if (!isSilentReply(joined)) turn.blocks.push({ kind: 'text', text: joined });
      buf = [];
    };
    for (const item of items) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        buf.push(item.text);
      } else if (isToolCallItem(item)) {
        flush();
        const callId = String(item.id ?? item.toolCallId ?? '');
        if (callId) consumed.add(callId);
        turn.blocks.push(
          toolBlock(
            {
              id: callId || `${id}-${turn.blocks.length}`,
              name: String(item.name ?? 'tool'),
              args: item.arguments ?? item.args ?? item.input,
              result: callId ? results.get(callId) : undefined,
            },
            callId ? details.get(callId) : null,
          ),
        );
      }
    }
    flush();
    if (turn.blocks.length === 0 && typeof m.errorMessage === 'string' && m.errorMessage) {
      turn.blocks.push({ kind: 'error', text: m.errorMessage });
    }
  });

  if (live && live.runId) {
    const turn = assistantTurn(`live-${live.runId}`, Date.now());
    turn.streaming = true;
    const liveCli = messageCli(live);
    if (liveCli) turn.model = `${CLI_LABELS[liveCli]} · CLI`;
    for (const t of live.tools || []) turn.blocks.push(toolBlock({ ...t }, null));
    const stream = stripThinkingTags(live.stream || '');
    if (stream.trim()) turn.blocks.push({ kind: 'text', text: stream, live: true });
  }
  return turns.filter((t) => t.role === 'user' || t.blocks.length > 0 || t.streaming);
}

// ── live events ───────────────────────────────────────────────────────────

/**
 * The per-session live state the chat screen keeps between history loads:
 *   { runId, stream, startedAt, tools:[…], error }
 */
export function emptyLive() {
  return { runId: null, stream: '', startedAt: null, tools: [], error: null };
}

/**
 * Fold one gateway `chat` event into the active session's live state.
 * Returns `{ live, effect }`, effect ∈
 *   'stream'   — live text changed, just re-render
 *   'adopt'    — a run this client did not start began here (another device
 *                sent a message): reload history so its user turn shows
 *   'settle'   — the run ended: reload history + refresh the session list
 *   null       — not for this session / nothing to do
 */
export function reduceChatEvent(live, payload, activeKey) {
  if (!payload || !activeKey || payload.sessionKey !== activeKey) return { live, effect: null };
  const { runId, state } = payload;

  // A different run finishing in this session (e.g. a sub-agent announce).
  if (runId && live.runId && runId !== live.runId) {
    return { live, effect: state === 'final' ? 'settle' : null };
  }

  if (state === 'delta') {
    const next = extractText(payload.message);
    const adopting = !live.runId;
    const stream = typeof next === 'string' && next.length >= (live.stream || '').length ? next : live.stream;
    return {
      live: { ...live, runId: runId || live.runId, stream, startedAt: live.startedAt || Date.now(), error: null },
      effect: adopting ? 'adopt' : 'stream',
    };
  }
  if (state === 'final' || state === 'aborted') {
    return { live: emptyLive(), effect: 'settle' };
  }
  if (state === 'error') {
    return { live: { ...emptyLive(), error: payload.errorMessage || 'chat error' }, effect: 'settle' };
  }
  return { live, effect: null };
}

/**
 * Fold a gateway `agent` tool-stream event into the live tool list. Events:
 *   { runId, sessionKey?, stream:'tool', data:{ phase:'start'|'update'|'result', toolCallId, name, args, result|partialResult } }
 */
export function reduceToolEvent(live, payload, activeKey) {
  if (!payload || payload.stream !== 'tool') return live;
  if (payload.sessionKey && payload.sessionKey !== activeKey) return live;
  if (live.runId && payload.runId && payload.runId !== live.runId) return live;
  const data = payload.data || {};
  const id = String(data.toolCallId || '');
  if (!id) return live;
  const tools = [...(live.tools || [])];
  let i = tools.findIndex((t) => t.id === id);
  if (i < 0) {
    tools.push({ id, name: String(data.name || 'tool'), args: data.args, pending: true });
    i = tools.length - 1;
  }
  const out = data.phase === 'result' ? data.result : data.partialResult;
  const text = out == null ? undefined : typeof out === 'string' ? out : extractText(out) ?? safeJson(out);
  tools[i] = {
    ...tools[i],
    name: String(data.name || tools[i].name),
    args: data.args ?? tools[i].args,
    result: text ?? tools[i].result,
    pending: data.phase !== 'result',
  };
  return { ...live, runId: live.runId || payload.runId || null, tools };
}

function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Which sessions have something new the user has not looked at, and which are
 * mid-run. `activity` = { unread:{[key]:ts}, streaming:{[key]:runId} }.
 */
export function reduceActivity(activity, payload, activeKey) {
  const key = payload?.sessionKey;
  if (!key || !isChatSessionKey(key)) return activity;
  const unread = { ...(activity?.unread || {}) };
  const streaming = { ...(activity?.streaming || {}) };
  if (payload.state === 'delta') {
    streaming[key] = payload.runId || true;
  } else if (payload.state === 'final' || payload.state === 'aborted' || payload.state === 'error') {
    delete streaming[key];
    if (payload.state === 'final' && key !== activeKey && !isSilentReply(extractText(payload.message) ?? 'x')) {
      unread[key] = Date.now();
    }
  }
  return { unread, streaming };
}

/**
 * A run often starts with thinking or tool calls and sends no chat text for a
 * while. The gateway's `agent` broadcasts (lifecycle start/end, tool phases)
 * mark the session as busy from the first moment.
 */
export function reduceAgentActivity(activity, payload) {
  const key = payload?.sessionKey;
  if (!key || !isChatSessionKey(key)) return activity;
  const phase = payload?.data?.phase;
  const starting = (payload.stream === 'lifecycle' && phase === 'start') || payload.stream === 'tool';
  const ending = payload.stream === 'lifecycle' && (phase === 'end' || phase === 'error');
  if (starting && !activity?.streaming?.[key]) {
    return { unread: activity?.unread || {}, streaming: { ...(activity?.streaming || {}), [key]: payload.runId || true } };
  }
  if (ending && activity?.streaming?.[key]) {
    const streaming = { ...activity.streaming };
    delete streaming[key];
    return { ...activity, streaming };
  }
  return activity;
}

export function markRead(activity, key) {
  if (!activity?.unread?.[key]) return activity;
  const unread = { ...activity.unread };
  delete unread[key];
  return { ...activity, unread };
}

export function formatArgs(args) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  return safeJson(args);
}
