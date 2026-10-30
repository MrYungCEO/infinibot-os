/**
 * group-logic — the mobile twin of the web group chat's pure logic:
 *
 *   src/shared/group-chat/keys.ts           (group session keys)
 *   src/shared/group-chat/planner.ts        (@mention parsing, who replies)
 *   ui/src/ui/features/group_chat/logic.ts  (attribution, live turns, mentions)
 *
 * Metro can't import the repo's TypeScript, so this mirrors it in plain JS.
 * src/__tests__/group-chat-parity.test.js runs both on the same inputs, so the
 * two can't drift apart unnoticed.
 *
 * Plus the one thing the web keeps inside its Lit element: the `groupchat`
 * event reducer (reduceGroupEvent), pulled out here so it is unit-testable.
 */

// ── keys (src/shared/group-chat/keys.ts) ──────────────────────────────────

export const GROUP_CHAT_PREFIX = 'groupchat-';
export const GROUP_MEMBER_PREFIX = 'gcmember-';
export const GROUP_CHAT_EVENT = 'groupchat';

function keyRest(key) {
  if (!key) return null;
  const m = /^agent:[^:]+:(.+)$/.exec(String(key));
  return m ? m[1] : null;
}

export function isGroupMemberKey(key) {
  return keyRest(key)?.startsWith(GROUP_MEMBER_PREFIX) ?? false;
}

/** True for the group's shared session (never for member sessions). */
export function isGroupChatKey(key) {
  const rest = keyRest(key);
  return Boolean(rest && rest.startsWith(GROUP_CHAT_PREFIX) && !rest.startsWith(GROUP_MEMBER_PREFIX));
}

export function groupIdFromKey(key) {
  const rest = keyRest(key);
  if (!rest) return null;
  if (rest.startsWith(GROUP_MEMBER_PREFIX)) return rest.slice(GROUP_MEMBER_PREFIX.length) || null;
  if (rest.startsWith(GROUP_CHAT_PREFIX)) return rest.slice(GROUP_CHAT_PREFIX.length) || null;
  return null;
}

// ── mentions (src/shared/group-chat/planner.ts) ───────────────────────────

/** Lowercase slug used to match `@Name` mentions ("Head of Dev" → "head-of-dev"). */
export function mentionSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9][\w-]*)/g;
const EVERYONE = new Set(['all', 'everyone', 'here', 'team']);

/** Members @mentioned in `text`, in first-mention order; `@all` expands to everyone. */
export function parseMentions(text, members) {
  const out = [];
  const add = (id) => { if (!out.includes(id)) out.push(id); };
  for (const m of String(text ?? '').matchAll(MENTION_RE)) {
    const token = m[2].toLowerCase().replace(/[-_]+$/, '');
    if (EVERYONE.has(token)) {
      for (const member of members) add(member.id);
      continue;
    }
    const hit =
      members.find((x) => x.id.toLowerCase() === token) ??
      members.find((x) => mentionSlug(x.name) === token) ??
      members.find((x) => mentionSlug(x.name).split('-')[0] === token);
    if (hit) add(hit.id);
  }
  return out;
}

/** Who answers a user message. @mentions override the group's mode. */
export function planRound({ text, members, mode, moderatorId, rrIndex }) {
  const rr = Math.max(0, Math.floor(rrIndex ?? 0));
  if (members.length === 0) return { agents: [], rrIndex: rr, reason: mode };
  const mentioned = parseMentions(text, members);
  if (mentioned.length > 0) return { agents: mentioned, rrIndex: rr, reason: 'mention' };
  if (mode === 'round-robin') {
    const idx = rr % members.length;
    return { agents: [members[idx].id], rrIndex: (idx + 1) % members.length, reason: mode };
  }
  if (mode === 'moderator') {
    const lead = members.find((m) => m.id === moderatorId) ?? members[0];
    return { agents: [lead.id], rrIndex: rr, reason: mode };
  }
  return { agents: members.map((m) => m.id), rrIndex: rr, reason: mode };
}

const SILENT_TOKENS = ['NO_REPLY', 'HEARTBEAT_OK'];

/** An agent chose to stay quiet (empty reply or a silent token). */
export function isPassReply(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  return SILENT_TOKENS.some((tok) => t === tok || t.replace(/[.!\s]+$/, '') === tok);
}

// ── attribution (ui/src/ui/features/group_chat/logic.ts) ──────────────────

function textOf(m) {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === 'object' && p.type === 'text' ? String(p.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof m.text === 'string' ? m.text : '';
}

/** chat.history rows of a group session → attributed display messages. */
function ledgerOf(meta) {
  return {
    ...(Array.isArray(meta?.activity) && meta.activity.length ? { activity: meta.activity } : {}),
    ...(Array.isArray(meta?.unverified) && meta.unverified.length ? { unverified: meta.unverified } : {}),
  };
}

// ── shared context (mirrors src/shared/group-chat/activity.ts + context.ts) ──

/** One-line repo status: "main @ abc1234 · no remote". */
export function repoStatusLine(repo) {
  if (!repo) return '';
  if (!repo.exists) return 'directory missing';
  if (!repo.isGitRepo) return 'not a git repo';
  const remote = repo.remotes?.length ? repo.remotes.map((r) => r.name).join(', ') : 'no remote';
  return `${repo.branch ?? '?'}${repo.head ? ` @ ${repo.head}` : ''} · ${remote}`;
}

/** Same text as formatActivityLine() in src/shared/group-chat/activity.ts (minus the bullet). */
export function activityLine(a) {
  const facts = [];
  if (a.commit) facts.push(`commit ${a.commit}`);
  if (a.push) facts.push(a.push.ok ? 'PUSH SUCCEEDED' : 'PUSH FAILED');
  if (a.files?.length) facts.push(`files: ${a.files.join(', ')}`);
  if (a.kanban) facts.push(`kanban ${a.kanban.action}${a.kanban.taskId ? ` ${a.kanban.taskId}` : ''}`);
  let status;
  if (a.spawnedRunId) status = `STARTED run ${a.spawnedRunId} (not finished / not verified yet)`;
  else if (!a.ok) {
    const firstErr = a.error ? (a.error.split('\n').find((l) => l.trim()) ?? a.error) : '';
    status = `${typeof a.exitCode === 'number' ? `exit ${a.exitCode}` : 'FAILED'}${firstErr ? ` — ${firstErr}` : ''}`;
  } else status = typeof a.exitCode === 'number' ? `ok (exit ${a.exitCode})` : 'ok';
  const label = a.tool === 'exec' || a.tool === 'bash' ? `exec \`${a.summary}\`` : a.summary;
  return `${label}${a.cwd ? ` in ${a.cwd}` : ''} → ${status}${facts.length ? ` [${facts.join('; ')}]` : ''}`;
}

/** Collapsed summary of a turn's ledger: { count, failed, push: 'pushed'|'push failed'|null, commits }. */
export function activitySummary(activity) {
  const list = Array.isArray(activity) ? activity : [];
  const pushes = list.filter((a) => a.push);
  return {
    count: list.length,
    failed: list.filter((a) => !a.ok).length,
    push: pushes.length ? (pushes.some((a) => !a.push.ok) ? 'push failed' : 'pushed') : null,
    commits: list.filter((a) => a.commit).map((a) => a.commit),
  };
}

/** Binding patch for groupchat.update: only when it changed; `null` clears. */
export function bindingPatch(next, prev) {
  const clean = (b) => {
    if (!b) return null;
    const out = {};
    for (const k of ['workdir', 'projectId', 'projectName', 'purpose']) if (typeof b[k] === 'string' && b[k].trim()) out[k] = b[k].trim();
    return Object.keys(out).length ? out : null;
  };
  const n = clean(next);
  const p = clean(prev);
  return JSON.stringify(n) === JSON.stringify(p) ? undefined : n;
}

/** Image blocks → data: URIs ({data,mimeType} and Anthropic `source` shapes). */
export function imagesOf(m) {
  const c = m?.content;
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const b of c) {
    if (!b || typeof b !== 'object' || b.type !== 'image') continue;
    const src = b.source && typeof b.source === 'object' ? b.source : null;
    const data = typeof src?.data === 'string' ? src.data : typeof b.data === 'string' ? b.data : '';
    if (!data) continue;
    out.push(data.startsWith('data:') ? data : `data:${src?.media_type || b.mimeType || 'image/png'};base64,${data}`);
  }
  return out;
}

/** chat.history rows of a group session → attributed display messages (+ images, chat panels, model). */
export function toDisplayMessages(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const meta = r.groupChat ?? null;
    const role = String(r.role ?? '');
    const text = textOf(r).trim();
    const images = imagesOf(r);
    const panels = Array.isArray(meta?.panels) ? meta.panels : [];
    if (!text && images.length === 0 && panels.length === 0) return;
    const ts = typeof r.timestamp === 'number' ? r.timestamp : 0;
    const id = meta?.messageId ?? `${i}-${ts}`;
    if (meta?.kind === 'status') {
      out.push({ id, kind: 'status', text, ts, workflowRunId: meta.workflowRunId, workflowId: meta.workflowId, images: [], panels: [], ...ledgerOf(meta) });
    } else if (role === 'user') {
      out.push({ id, kind: 'user', text, ts, workflowRunId: meta?.workflowRunId, workflowId: meta?.workflowId, images, panels: [] });
    } else if (role === 'assistant') {
      out.push({
        id,
        kind: 'agent',
        agentId: meta?.agentId,
        agentName: meta?.agentName,
        text,
        ts,
        workflowRunId: meta?.workflowRunId,
        workflowId: meta?.workflowId,
        error: meta?.error,
        ...ledgerOf(meta),
        images,
        panels,
        model: meta?.model,
      });
    }
  });
  return out;
}

/** Append live messages, deduped by id. */
export function mergeMessages(existing, incoming) {
  const seen = new Set(existing.map((m) => m.id));
  const add = incoming.filter((m) => !seen.has(m.id));
  return add.length ? [...existing, ...add] : existing;
}

/** Workflow filter: a run id shows only that run; a workflow id shows all its runs. */
export function filterMessages(msgs, filter) {
  if (!filter?.runId && !filter?.workflowId) return msgs;
  return msgs.filter((m) => (filter.runId ? m.workflowRunId === filter.runId : m.workflowId === filter.workflowId));
}

// ── @mention autocomplete ─────────────────────────────────────────────────

/** The `@partial` being typed at the caret, if any. */
export function mentionQueryAt(text, caret) {
  const upto = String(text ?? '').slice(0, caret);
  const m = /(^|[\s(])@([\w-]*)$/.exec(upto);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2].toLowerCase() };
}

export function suggestMembers(members, query, max = 6) {
  const q = String(query ?? '').toLowerCase();
  const scored = members
    .map((m) => {
      const id = m.id.toLowerCase();
      const name = m.name.toLowerCase();
      const score = !q ? 1 : id.startsWith(q) || name.startsWith(q) ? 3 : id.includes(q) || name.includes(q) ? 2 : 0;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const list = scored.map((x) => x.m);
  if (!q || 'all'.startsWith(q) || 'everyone'.startsWith(q)) list.push({ id: 'all', name: 'Everyone' });
  return list.slice(0, max);
}

/** Replace the `@partial` at [start, caret) with `@id `; returns text + new caret. */
export function applyMention(text, start, caret, id) {
  const insert = `@${id} `;
  const next = text.slice(0, start) + insert + text.slice(caret).replace(/^\s+/, '');
  return { text: next, caret: start + insert.length };
}

/** Append `@id ` to a draft (the quick-mention chips). */
export function appendMention(draft, id) {
  const d = String(draft ?? '');
  const sep = d && !/\s$/.test(d) ? ' ' : '';
  return `${d}${sep}@${id} `;
}

// ── avatars ───────────────────────────────────────────────────────────────

export function agentHue(id) {
  let h = 0;
  const s = String(id ?? '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The web avatar colour (`--h` hue) as an RN colour string. */
export function agentColor(id, { s = 62, l = 58, a = 1 } = {}) {
  return `hsla(${agentHue(id)}, ${s}%, ${l}%, ${a})`;
}

// Unicode property escapes need a recent engine; fall back to ASCII on old Hermes.
const NON_WORD = (() => {
  try { return new RegExp('[^\\p{L}\\p{N}\\s-]', 'gu'); } catch { return /[^A-Za-z0-9\s-]/g; }
})();

export function initials(name) {
  const words = String(name ?? '')
    .replace(NON_WORD, '')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** agents.list row → display name (identity name wins, like the web). */
export function rosterName(agents, id, fallback) {
  if (!id) return fallback ?? 'Agent';
  const row = (agents || []).find((a) => a.id === id);
  return row?.identity?.name || row?.name || fallback || id;
}

/** Group members joined with the roster (names + avatars). */
export function memberInfos(group, agents) {
  return (group?.members ?? []).map((m) => {
    const row = (agents || []).find((a) => a.id === m.id);
    return { id: m.id, name: row?.identity?.name || row?.name || m.name, avatarUrl: row?.identity?.avatarUrl ?? null, emoji: row?.identity?.emoji ?? null };
  });
}

// ── live turns ────────────────────────────────────────────────────────────

/**
 * Apply a `chat` delta for a member session to the live-turn map (an object
 * keyed by runId here). Returns the same object when the event is unrelated.
 */
export function applyChatEvent(turns, payload) {
  if (!payload?.runId) return turns;
  const turn = turns[payload.runId];
  if (!turn || (payload.sessionKey && payload.sessionKey !== turn.memberKey)) return turns;
  if (payload.state === 'delta') {
    const text = textOf(payload.message ?? {});
    if (!text || text === turn.text) return turns;
    return { ...turns, [payload.runId]: { ...turn, text } };
  }
  return turns;
}

export const MODE_LABELS = {
  everyone: { label: 'Everyone replies', short: 'Everyone', hint: "Each agent answers in turn and sees the others' replies." },
  'round-robin': { label: 'Round robin', short: 'Round-robin', hint: 'One agent answers per message, rotating through the group.' },
  moderator: { label: 'Moderator', short: 'Moderator', hint: 'The lead answers and @mentions others when it needs them.' },
};
export const MODES = ['everyone', 'round-robin', 'moderator'];

export function runLabel(run) {
  const done = run.steps.filter((s) => s.status === 'done').length;
  const t = new Date(run.startedAt);
  const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${run.workflowName} · ${time} · ${run.status === 'running' ? `${done}/${run.steps.length}` : run.status}`;
}

// ── the group view's state machine ────────────────────────────────────────

/**
 * View state for one open group:
 *   group        groupchat.get description (members, mode, workflows, runs, busy)
 *   messages     attributed transcript (toDisplayMessages)
 *   live         { [runId]: { runId, agentId, memberKey, text, workflowRunId } }
 *   ended        { [runId]: true } — turn ended, bubble waits for its message
 *   roundActive  a round is in progress (Stop button, "replying" header)
 */
export function emptyGroupState() {
  return { group: null, messages: [], live: {}, ended: {}, roundActive: false };
}

/** groupchat.get + chat.history results → a fresh state (also the reconnect resync). */
export function loadedGroupState(group, historyMessages) {
  const live = {};
  for (const t of group?.activeTurns ?? []) live[t.runId] = { ...t, text: '' };
  return { group, messages: toDisplayMessages(historyMessages), live, ended: {}, roundActive: Boolean(group?.busy) };
}

/**
 * Fold one `groupchat` event into the view state. Returns `{ state, effects }`;
 * effects are instructions for the host (timers, refetch), keeping this pure:
 *   { type: 'refresh', delay }          re-read groupchat.get
 *   { type: 'expire', runId, delay }    drop a finished turn's bubble later
 */
export function reduceGroupEvent(state, evt, groupKey) {
  if (!evt || evt.groupKey !== groupKey) return { state, effects: [] };
  switch (evt.type) {
    case 'message': {
      const messages = mergeMessages(state.messages, toDisplayMessages([evt.message]));
      const agentId = evt.message?.groupChat?.agentId;
      let { live, ended } = state;
      if (agentId) {
        // The reply landed — drop that agent's finished streaming bubble.
        const drop = Object.values(live).filter((t) => t.agentId === agentId && ended[t.runId]);
        if (drop.length) {
          live = { ...live };
          ended = { ...ended };
          for (const t of drop) { delete live[t.runId]; delete ended[t.runId]; }
        }
      }
      return { state: { ...state, messages, live, ended }, effects: [] };
    }
    case 'turn.start':
      return {
        state: {
          ...state,
          live: { ...state.live, [evt.runId]: { runId: evt.runId, agentId: evt.agentId, memberKey: evt.memberKey, text: '', workflowRunId: evt.workflowRunId } },
          roundActive: true,
        },
        effects: [],
      };
    case 'turn.end':
      // Keep the bubble until the reply message arrives (or briefly, if the agent passed).
      return {
        state: { ...state, ended: { ...state.ended, [evt.runId]: true } },
        effects: [{ type: 'expire', runId: evt.runId, delay: evt.ok ? 2500 : 300 }],
      };
    case 'round.start':
      return { state: { ...state, roundActive: true }, effects: [] };
    case 'round.end':
      return { state, effects: [{ type: 'refresh', delay: 150 }] };
    case 'workflow': {
      if (!state.group || !evt.run) return { state, effects: [] };
      const runs = (state.group.runs || []).filter((r) => r.id !== evt.run.id);
      const next = { ...state, group: { ...state.group, runs: [...runs, evt.run] } };
      if (evt.run.status === 'running') return { state: { ...next, roundActive: true }, effects: [] };
      return { state: next, effects: [{ type: 'refresh', delay: 150 }] };
    }
    case 'meta':
      return { state, effects: [{ type: 'refresh', delay: 50 }] };
    default:
      return { state, effects: [] };
  }
}

/** Drop a turn bubble whose expiry timer fired (no-op if its message already removed it). */
export function expireTurn(state, runId) {
  if (!state.live[runId]) return state;
  const live = { ...state.live };
  const ended = { ...state.ended };
  delete live[runId];
  delete ended[runId];
  return { ...state, live, ended };
}

/** A groupchat.get refresh: new description, `busy` drives the round flag. */
export function applyGroupRefresh(state, group) {
  return { ...state, group, roundActive: Boolean(group?.busy) };
}

/** Is anything running (Stop visible)? */
export function isGroupBusy(state) {
  return state.roundActive || Object.keys(state.live).length > 0 || Boolean(state.group?.runs?.some((r) => r.status === 'running'));
}

/** Which run card to show above the transcript: the filtered run, else the running one. */
export function cardRun(group, runFilter) {
  const runs = group?.runs ?? [];
  const filtered = runFilter ? runs.find((r) => r.id === runFilter) : null;
  return filtered ?? [...runs].reverse().find((r) => r.status === 'running') ?? null;
}

/**
 * The "who will reply" hint under the composer, from the same planner the
 * gateway runs — so a typed @mention visibly redirects the turn.
 */
export function replyHint(draft, group, members) {
  if (!group || !members.length) return '';
  const plan = planRound({ text: draft, members, mode: group.mode, moderatorId: group.moderatorId, rrIndex: group.rrIndex });
  const names = plan.agents.map((id) => members.find((m) => m.id === id)?.name || id);
  if (plan.reason === 'mention') return `Only ${names.join(', ')} will reply`;
  if (plan.reason === 'everyone') return names.length > 1 ? 'Everyone replies in turn' : `${names[0]} replies`;
  if (plan.reason === 'moderator') return `${names[0]} leads`;
  return 'Next agent in the rotation replies';
}
