/**
 * grid-data — pure data mapping for the native Grid panel bodies.
 *
 * Each block mirrors the web panel it ports:
 *   group chat   ui/src/ui/features/group_chat/logic.ts
 *   workflows    src/shared/group-chat/workflow-graph.ts + features/workflow_builder/builder-logic.ts
 *   kanban       ui/src/ui/controllers/kanban.ts (kanban.* RPC rows)
 *   activity     subagents.list / sessions.list rows
 *   credits      credits.summary
 *   database     ui/src/ui/controllers/databases.ts (db.* RPC rows)
 *   chart        chart-grid-panel (TradingView pairs / Solana tokens)
 *   terminal     terminal.getBuffer text
 *
 * No React / react-native imports — unit-tested in node (__tests__/grid-data.test.js).
 */
import { stripEmoji } from './grid-model';

// ── formatting ───────────────────────────────────────────────────────────────
export function compactNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  if (Math.abs(v) >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (Math.abs(v) > 0 && Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return v.toFixed(Math.abs(v) >= 100 ? 2 : 4);
  if (v === 0) return '0';
  return v.toPrecision(4);
}

export function relTime(ts, now = Date.now()) {
  const t = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function initials(name) {
  const words = stripEmoji(name).replace(/[^\p{L}\p{N}\s-]/gu, '').split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// ── sessions (chat panel switcher) ──────────────────────────────────────────
export function sessionTitle(row) {
  if (!row) return 'Session';
  return stripEmoji(row.label || row.displayName || row.derivedTitle || row.subject || '') || shortKey(row.key);
}

export function shortKey(key) {
  const k = String(key || '');
  const parts = k.split(':');
  return parts.length > 2 ? parts.slice(2).join(':') : k || 'Session';
}

/** sessions.list rows → picker rows, newest first, group chats excluded. */
export function sessionRows(res, { exclude = 'groupchat-' } = {}) {
  const list = Array.isArray(res?.sessions) ? res.sessions : [];
  return list
    .filter((s) => s && s.key && !(exclude && String(s.key).includes(exclude)))
    .map((s) => ({ key: s.key, title: sessionTitle(s), updatedAt: Number(s.updatedAt) || 0, model: s.model || '', kind: s.kind || '' }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── group chat (port of features/group_chat/logic.ts) ───────────────────────
export const GROUP_CHAT_PREFIX = 'groupchat-';

export const MODE_LABELS = {
  everyone: { label: 'Everyone', hint: "Each agent answers in turn and sees the others' replies." },
  'round-robin': { label: 'Round robin', hint: 'One agent answers per message, rotating through the group.' },
  moderator: { label: 'Moderator', hint: 'The lead answers and @mentions others when it needs them.' },
};

function textOf(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === 'object' && p.type === 'text' ? String(p.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof m?.text === 'string' ? m.text : '';
}

export function toDisplayMessages(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const meta = m.groupChat || null;
    const role = String(m.role ?? '');
    const text = textOf(m).trim();
    if (!text) return;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    const id = meta?.messageId ?? `${i}-${ts}`;
    const base = { id, text, ts, workflowRunId: meta?.workflowRunId, workflowId: meta?.workflowId };
    if (meta?.kind === 'status') out.push({ ...base, kind: 'status' });
    else if (role === 'user') out.push({ ...base, kind: 'user' });
    else if (role === 'assistant') out.push({ ...base, kind: 'agent', agentId: meta?.agentId, agentName: meta?.agentName, error: meta?.error });
  });
  return out;
}

export function mergeMessages(existing, incoming) {
  const seen = new Set(existing.map((m) => m.id));
  const add = incoming.filter((m) => !seen.has(m.id));
  return add.length ? [...existing, ...add] : existing;
}

/** Apply a member-session `chat` delta to the live-turn map (same map back when unrelated). */
export function applyChatEvent(turns, payload) {
  if (!payload?.runId) return turns;
  const turn = turns.get(payload.runId);
  if (!turn || (payload.sessionKey && payload.sessionKey !== turn.memberKey)) return turns;
  if (payload.state === 'delta') {
    const text = textOf(payload.message ?? {});
    if (!text || text === turn.text) return turns;
    const next = new Map(turns);
    next.set(payload.runId, { ...turn, text });
    return next;
  }
  return turns;
}

/** One `groupchat` event → { messages, live, roundActive, refresh } changes. */
export function reduceGroupEvent(st, e, now = Date.now()) {
  if (!e || !e.type) return st;
  switch (e.type) {
    case 'message': {
      const messages = mergeMessages(st.messages, toDisplayMessages([e.message]));
      const agentId = e.message?.groupChat?.agentId;
      let live = st.live;
      if (agentId) {
        live = new Map(st.live);
        for (const [id, t] of live) if (t.agentId === agentId && st.ended?.has?.(id)) live.delete(id);
      }
      return { ...st, messages, live };
    }
    case 'turn.start': {
      const live = new Map(st.live);
      live.set(e.runId, { runId: e.runId, agentId: e.agentId, memberKey: e.memberKey, text: '', workflowRunId: e.workflowRunId });
      return { ...st, live, roundActive: true };
    }
    case 'turn.end': {
      const ended = new Map(st.ended || []);
      ended.set(e.runId, now);
      return { ...st, ended };
    }
    case 'round.start':
      return { ...st, roundActive: true };
    case 'round.end':
    case 'meta':
      return { ...st, refresh: true };
    case 'workflow': {
      if (!st.group) return st;
      const runs = (st.group.runs || []).filter((r) => r.id !== e.run?.id);
      return { ...st, group: { ...st.group, runs: [...runs, e.run] }, roundActive: e.run?.status === 'running' ? true : st.roundActive, refresh: e.run?.status !== 'running' };
    }
    default:
      return st;
  }
}

export function groupRows(res) {
  const list = Array.isArray(res?.sessions) ? res.sessions : [];
  return list
    .filter((s) => s && typeof s.key === 'string' && s.key.includes(GROUP_CHAT_PREFIX))
    .map((s) => ({ key: s.key, title: stripEmoji(s.label || s.derivedTitle || '') || 'Group chat', updatedAt: Number(s.updatedAt) || 0 }));
}

export function agentRows(res) {
  const list = Array.isArray(res?.agents) ? res.agents : [];
  return list
    .filter((a) => a && a.id)
    .map((a) => ({ id: a.id, name: stripEmoji(a.identity?.name || a.name || a.id) || a.id }));
}

export function agentName(agents, id, fallback) {
  if (!id) return fallback || 'Agent';
  const a = agents.find((x) => x.id === id);
  return a?.name || stripEmoji(fallback || '') || id;
}

// ── workflows (port of shared/group-chat/workflow-graph.ts) ─────────────────
export const MAX_WORKFLOW_NODES = 24;

function rid(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function dependencyPairs(graph) {
  const seen = new Set();
  const out = [];
  const push = (a, b) => {
    const k = `${a}\u0000${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([a, b]);
  };
  for (const n of graph.nodes || []) if (n.parentId) push(n.parentId, n.id);
  for (const e of graph.edges || []) push(e.sourceId, e.targetId);
  return out;
}

/** Stable Kahn layering; throws on a cycle / dangling link (same as the gateway). */
export function topologicalLayers(graph) {
  const nodes = graph.nodes || [];
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b] of dependencyPairs(graph)) {
    if (!index.has(a) || !index.has(b)) throw new Error(`Link references a missing step (${a} -> ${b})`);
    indegree.set(b, (indegree.get(b) ?? 0) + 1);
    out.get(a).push(b);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let ready = nodes.filter((n) => indegree.get(n.id) === 0);
  const layers = [];
  let seen = 0;
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
    layers.push(ready);
    const next = [];
    for (const n of ready) {
      seen += 1;
      for (const t of out.get(n.id) ?? []) {
        indegree.set(t, (indegree.get(t) ?? 0) - 1);
        if (indegree.get(t) === 0) next.push(byId.get(t));
      }
    }
    ready = next;
  }
  if (seen !== nodes.length) throw new Error('Workflow has a cycle: remove a link so steps flow one way');
  return layers;
}

export function safeLayers(graph) {
  try {
    return topologicalLayers(graph);
  } catch {
    return [graph.nodes || []];
  }
}

export function validateWorkflow(graph, { members } = {}) {
  const errors = [];
  if (!graph?.name?.trim()) errors.push('Workflow needs a name');
  const nodes = graph?.nodes || [];
  if (nodes.length === 0) errors.push('Add at least one agent step');
  if (nodes.length > MAX_WORKFLOW_NODES) errors.push(`At most ${MAX_WORKFLOW_NODES} steps`);
  const ids = new Set();
  for (const n of nodes) {
    if (!n.id || !n.agentId) errors.push('Every step needs an agent');
    if (ids.has(n.id)) errors.push(`Duplicate step id ${n.id}`);
    ids.add(n.id);
    if (n.parentId === n.id) errors.push('A step cannot be its own lead');
    if (members && n.agentId && !members.includes(n.agentId)) errors.push(`@${n.agentId} is not a member of this group`);
  }
  for (const e of graph?.edges || []) if (e.sourceId === e.targetId) errors.push('A step cannot link to itself');
  if (errors.length === 0) {
    try {
      topologicalLayers(graph);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { valid: errors.length === 0, errors };
}

export const NODE_W = 180;

export function emptyWorkflow(name = 'New workflow') {
  return { id: rid('wf'), name, nodes: [], edges: [] };
}

/** Same starter as the web builder: lead plans, member builds, lead reviews. */
export function starterWorkflow(memberIds) {
  const [a, b, c] = [memberIds[0], memberIds[1] ?? memberIds[0], memberIds[2] ?? memberIds[0]];
  const lead = { id: rid('n'), agentId: a, label: 'Plan', prompt: 'Break the request into a short plan and hand clear instructions to the next step.', x: 24, y: 40, parentId: null };
  const build = { id: rid('n'), agentId: b, label: 'Build', prompt: 'Carry out the plan and report exactly what you produced.', x: 24 + NODE_W + 70, y: 40, parentId: null };
  const review = { id: rid('n'), agentId: c, label: 'Review', prompt: 'Review the result, list issues and give a final verdict.', x: 24 + 2 * (NODE_W + 70), y: 40, parentId: null };
  return {
    id: rid('wf'),
    name: 'Plan, build, review',
    nodes: [lead, build, review],
    edges: [
      { id: rid('e'), sourceId: lead.id, targetId: build.id },
      { id: rid('e'), sourceId: build.id, targetId: review.id },
    ],
  };
}

/**
 * Phone editing: append a step after `afterId` (or after the last layer).
 * `parallel` adds it beside `afterId` (same predecessors) instead of after it.
 */
export function addStep(graph, agentId, { afterId = null, parallel = false, label = '', prompt = '' } = {}) {
  const layers = safeLayers(graph);
  const lastLayer = layers[layers.length - 1] || [];
  const anchor = afterId ? graph.nodes.find((n) => n.id === afterId) : lastLayer[lastLayer.length - 1];
  const depth = layers.length;
  const node = { id: rid('n'), agentId, label, prompt, x: 24 + depth * (NODE_W + 70), y: 40 + (parallel ? 110 : 0), parentId: null };
  let edges = [...(graph.edges || [])];
  if (anchor) {
    if (parallel) {
      for (const [a, b] of dependencyPairs(graph)) if (b === anchor.id) edges.push({ id: rid('e'), sourceId: a, targetId: node.id });
      if (anchor.parentId) node.parentId = anchor.parentId;
    } else {
      edges.push({ id: rid('e'), sourceId: anchor.id, targetId: node.id });
    }
  }
  return { ...graph, nodes: [...graph.nodes, node], edges };
}

/** Remove a step; its predecessors are re-linked to its successors so the chain survives. */
export function removeStep(graph, nodeId) {
  const preds = dependencyPairs(graph).filter(([, b]) => b === nodeId).map(([a]) => a);
  const succs = dependencyPairs(graph).filter(([a]) => a === nodeId).map(([, b]) => b);
  let edges = (graph.edges || []).filter((e) => e.sourceId !== nodeId && e.targetId !== nodeId);
  for (const p of preds) for (const s of succs) {
    if (!edges.some((e) => e.sourceId === p && e.targetId === s)) edges.push({ id: rid('e'), sourceId: p, targetId: s });
  }
  const nodes = graph.nodes.filter((n) => n.id !== nodeId).map((n) => (n.parentId === nodeId ? { ...n, parentId: null } : n));
  return { ...graph, nodes, edges };
}

export function updateStep(graph, nodeId, patch) {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
}

/** "Plan -> (Build || Tests) -> Review" — empty string on a cycle. */
export function describeOrder(graph, nameOf) {
  try {
    return topologicalLayers(graph)
      .map((layer) => (layer.length > 1 ? `(${layer.map(nameOf).join(' || ')})` : nameOf(layer[0])))
      .join(' -> ');
  } catch {
    return '';
  }
}

export function latestRun(graph, runs) {
  return [...(runs || [])].reverse().find((r) => r.workflowId === graph.id) || null;
}

export function runSummary(run) {
  if (!run) return '';
  const steps = run.steps || [];
  const done = steps.filter((s) => s.status === 'done').length;
  return run.status === 'running' ? `${done}/${steps.length} steps` : run.status;
}

// ── kanban (kanban.projects.list / kanban.tasks.list rows) ──────────────────
export const TASK_COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];

export const PROJECT_FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'ai', label: 'AI' },
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Done' },
];

const CLOSED_PROJECT = /^(completed|cancel+ed|archived|done)$/i;

export function projectMatches(p, filter, query) {
  if (!p) return false;
  if (p.archived && filter !== 'all') return false;
  const status = String(p.status || '');
  if (filter === 'active' && CLOSED_PROJECT.test(status)) return false;
  if (filter === 'completed' && !/^(completed|done)$/i.test(status)) return false;
  if (filter === 'ai') {
    const types = Array.isArray(p.type) ? p.type : [];
    if (!types.some((t) => /ai|autonom/i.test(String(t))) && !p.autonomous) return false;
    if (CLOSED_PROJECT.test(status)) return false;
  }
  const q = String(query || '').trim().toLowerCase();
  if (q && !`${p.name || ''} ${p.description || ''}`.toLowerCase().includes(q)) return false;
  return true;
}

const STATUS_RANK = { 'in progress': 0, reviewing: 1, updating: 2, 'not started': 3, paused: 4, completed: 5, cancelled: 6, canceled: 6 };

export function sortProjects(list) {
  return [...list].sort((a, b) => {
    const ra = STATUS_RANK[String(a.status || '').toLowerCase()] ?? 3;
    const rb = STATUS_RANK[String(b.status || '').toLowerCase()] ?? 3;
    if (ra !== rb) return ra - rb;
    return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
  });
}

export function projectRows(list, filter = 'active', query = '') {
  const arr = Array.isArray(list) ? list : Array.isArray(list?.projects) ? list.projects : [];
  return sortProjects(arr.filter((p) => projectMatches(p, filter, query))).map((p) => ({
    id: p.id,
    name: stripEmoji(p.name) || 'Untitled project',
    status: p.status || 'Not started',
    priority: p.priority || '',
    progress: Math.max(0, Math.min(100, Number(p.progress) || 0)),
    taskCount: Number(p.taskCount) || 0,
    updatedAt: Number(p.updatedAt) || 0,
    parentProjectId: p.parentProjectId || null,
  }));
}

export function normalizeTaskStatus(s) {
  const v = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'in_progress' || v === 'doing' || v === 'active') return 'in_progress';
  if (v === 'review' || v === 'reviewing' || v === 'awaiting_response') return 'review';
  if (v === 'done' || v === 'complete' || v === 'completed') return 'done';
  return 'todo';
}

export function taskRows(list) {
  const arr = Array.isArray(list) ? list : Array.isArray(list?.tasks) ? list.tasks : [];
  return arr
    .filter((t) => t && t.id)
    .map((t) => ({
      id: t.id,
      title: stripEmoji(t.title) || 'Untitled task',
      status: normalizeTaskStatus(t.status),
      priority: String(t.priority || t.priorityLevel || '').toLowerCase(),
      assignee: stripEmoji(t.assignee || ''),
      updatedAt: Number(t.updatedAt) || 0,
      rank: Number.isFinite(Number(t.rank)) ? Number(t.rank) : 1e9,
      done: Boolean(t.done) || normalizeTaskStatus(t.status) === 'done',
    }));
}

export function groupTasks(tasks) {
  const out = { todo: [], in_progress: [], review: [], done: [] };
  for (const t of tasks) (out[t.status] || out.todo).push(t);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt);
  return out;
}

/** kanban.tasks.update patch for a status move (web updateTask keeps done ↔ status in sync). */
export function statusPatch(status) {
  return { status, done: status === 'done' };
}

// ── activity (subagents.list + sessions.list) ───────────────────────────────
const RUNNING = /^(working|running|spawning|starting|queued|pending|active)$/i;

export function activityModel(subRes, sessRes, now = Date.now()) {
  const subs = Array.isArray(subRes?.subagents) ? subRes.subagents : Array.isArray(subRes) ? subRes : [];
  const rows = subs.map((s) => {
    const last = Array.isArray(s.recentUpdates) && s.recentUpdates.length ? s.recentUpdates[s.recentUpdates.length - 1] : null;
    return {
      id: s.runId || s.sessionKey,
      label: stripEmoji(s.label || s.task || s.runId) || 'Sub-agent',
      status: String(s.status || 'unknown'),
      running: RUNNING.test(String(s.status || '')),
      progress: Number(s.progress) || 0,
      lastMessage: stripEmoji(last?.message || ''),
      updatedAt: Number(s.lastUpdateAt || last?.timestamp || s.createdAt) || 0,
      createdAt: Number(s.createdAt) || 0,
      updates: (Array.isArray(s.recentUpdates) ? s.recentUpdates : []).slice(-8).reverse().map((u) => ({ text: stripEmoji(u.message || ''), ts: Number(u.timestamp) || 0, status: u.status || '' })),
      sessionKey: s.sessionKey || '',
    };
  });
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const running = rows.filter((r) => r.running);
  const finished = rows.filter((r) => !r.running).slice(0, 12);
  const sessions = (Array.isArray(sessRes?.sessions) ? sessRes.sessions : [])
    .filter((s) => s && s.key && !String(s.key).includes(':subagent:'))
    .map((s) => ({ key: s.key, title: sessionTitle(s), updatedAt: Number(s.updatedAt) || 0, live: now - (Number(s.updatedAt) || 0) < 5 * 60 * 1000 }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);
  return { running, finished, sessions, liveSessions: sessions.filter((s) => s.live).length };
}

// ── credits (credits.summary) ────────────────────────────────────────────────
export function creditsModel(summary) {
  const s = summary || {};
  const providers = (Array.isArray(s.byProvider) ? s.byProvider : []).map((p) => ({
    key: `${p.provider}${p.model ? `:${p.model}` : ''}`,
    provider: p.provider || 'unknown',
    model: p.model || '',
    tokens: (Number(p.tokensIn) || 0) + (Number(p.tokensOut) || 0),
    cacheTokens: (Number(p.cacheReadTokens) || 0) + (Number(p.cacheWriteTokens) || 0),
    costUsd: Number(p.costUsd) || 0,
    requests: Number(p.requests) || 0,
  }));
  const totalTokens = providers.reduce((a, p) => a + p.tokens, 0);
  const totalReq = providers.reduce((a, p) => a + p.requests, 0);
  const anyCost = providers.some((p) => p.costUsd > 0);
  const share = (p) => (anyCost ? p.costUsd / Math.max(1e-9, providers.reduce((a, x) => a + x.costUsd, 0)) : totalReq ? p.requests / totalReq : 0);
  const rows = providers.map((p) => ({ ...p, share: share(p) })).sort((a, b) => b.share - a.share);
  const backends = (Array.isArray(s.byBackend) ? s.byBackend : []).map((b) => ({
    key: b.agentBackend || 'unknown',
    requests: Number(b.requests) || 0,
    tokens: (Number(b.tokensIn) || 0) + (Number(b.tokensOut) || 0),
    costUsd: Number(b.costUsd) || 0,
  })).sort((a, b) => b.requests - a.requests);
  return {
    totalCostUsd: Number(s.totalCostUsd) || 0,
    totalRequests: Number(s.totalRequests) || 0,
    tokensIn: Number(s.totalTokensIn) || 0,
    tokensOut: Number(s.totalTokensOut) || 0,
    cacheRead: Number(s.totalCacheReadTokens) || 0,
    totalTokens,
    shareBy: anyCost ? 'cost' : 'requests',
    providers: rows,
    backends,
  };
}

// ── databases (db.* rows) ────────────────────────────────────────────────────
export function databaseRows(res) {
  const list = Array.isArray(res?.databases) ? res.databases : [];
  return list.map((d) => ({ id: d.id, name: stripEmoji(d.name) || 'Database', description: stripEmoji(d.description || ''), source: d.source || '', updatedAt: Number(d.updatedAt) || 0 }));
}

function optionName(prop, id) {
  const opts = prop?.config?.options || [];
  return stripEmoji(opts.find((o) => o.id === id)?.name || '');
}

/** Display string for a db property value (same value union as controllers/databases.ts). */
export function formatDbValue(prop, value) {
  if (!value || typeof value !== 'object') return '';
  switch (value.type) {
    case 'title': return stripEmoji(value.text);
    case 'richText': return stripEmoji(String(value.markdown || '').replace(/[#*_`>]/g, '')).slice(0, 140);
    case 'select':
    case 'status': return value.optionId ? optionName(prop, value.optionId) : '';
    case 'multiSelect': return (value.optionIds || []).map((id) => optionName(prop, id)).filter(Boolean).join(', ');
    case 'date': return value.iso ? String(value.iso).slice(0, 10) : '';
    case 'dateRange': return [value.start, value.end].filter(Boolean).map((d) => String(d).slice(0, 10)).join(' - ');
    case 'number': return value.value == null ? '' : String(value.value);
    case 'checkbox': return value.checked ? 'Yes' : 'No';
    case 'url': return value.url || '';
    case 'email': return value.email || '';
    case 'phone': return value.phone || '';
    case 'files': return (value.files || []).length ? `${value.files.length} file${value.files.length === 1 ? '' : 's'}` : '';
    case 'relation': return (value.rowIds || []).length ? `${value.rowIds.length} linked` : '';
    case 'person': return (value.personIds || []).length ? `${value.personIds.length} people` : '';
    case 'createdAt':
    case 'updatedAt': return value.iso ? String(value.iso).slice(0, 10) : '';
    default: return '';
  }
}

/** Row → { id, title, chips: [{label,value}] } using the first visible non-title properties. */
export function dbRowPreview(row, properties, max = 3) {
  const props = (Array.isArray(properties) ? properties : []).filter((p) => !p.hidden && p.type !== 'title').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const chips = [];
  for (const p of props) {
    if (chips.length >= max) break;
    const v = formatDbValue(p, row?.values?.[p.id]);
    if (v) chips.push({ label: stripEmoji(p.name), value: v });
  }
  return { id: row?.id, title: stripEmoji(row?.title) || 'Untitled', chips, updatedAt: Number(row?.updatedAt) || 0 };
}

export function dbRowDetail(row, properties) {
  const props = (Array.isArray(properties) ? properties : []).filter((p) => p.type !== 'title').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  return props.map((p) => ({ id: p.id, label: stripEmoji(p.name), value: formatDbValue(p, row?.values?.[p.id]) || '-' }));
}

// ── chart (chart-grid-panel: TradingView pairs + Solana tokens) ─────────────
export const DEFAULT_TV_PAIRS = [
  { symbol: 'BINANCE:BTCUSDT', name: 'BTC/USDT', category: 'crypto' },
  { symbol: 'BINANCE:ETHUSDT', name: 'ETH/USDT', category: 'crypto' },
  { symbol: 'BINANCE:SOLUSDT', name: 'SOL/USDT', category: 'crypto' },
  { symbol: 'BINANCE:BNBUSDT', name: 'BNB/USDT', category: 'crypto' },
  { symbol: 'BINANCE:XRPUSDT', name: 'XRP/USDT', category: 'crypto' },
  { symbol: 'BINANCE:DOGEUSDT', name: 'DOGE/USDT', category: 'crypto' },
  { symbol: 'BINANCE:ADAUSDT', name: 'ADA/USDT', category: 'crypto' },
  { symbol: 'BINANCE:AVAXUSDT', name: 'AVAX/USDT', category: 'crypto' },
  { symbol: 'COINBASE:BTCUSD', name: 'BTC/USD', category: 'crypto' },
  { symbol: 'COINBASE:ETHUSD', name: 'ETH/USD', category: 'crypto' },
  { symbol: 'FX:EURUSD', name: 'EUR/USD', category: 'forex' },
  { symbol: 'FX:GBPUSD', name: 'GBP/USD', category: 'forex' },
  { symbol: 'FX:USDJPY', name: 'USD/JPY', category: 'forex' },
  { symbol: 'NASDAQ:AAPL', name: 'Apple', category: 'stocks' },
  { symbol: 'NASDAQ:NVDA', name: 'NVIDIA', category: 'stocks' },
  { symbol: 'NASDAQ:TSLA', name: 'Tesla', category: 'stocks' },
  { symbol: 'SP:SPX', name: 'S&P 500', category: 'indices' },
  { symbol: 'NASDAQ:NDX', name: 'NASDAQ 100', category: 'indices' },
  { symbol: 'TVC:GOLD', name: 'GOLD', category: 'commodities' },
  { symbol: 'TVC:SILVER', name: 'SILVER', category: 'commodities' },
];

export const CHART_RANGES = [
  { key: '1d', label: '1D', binance: ['15m', 96], coinbase: 900 },
  { key: '1w', label: '1W', binance: ['2h', 84], coinbase: 3600 },
  { key: '3m', label: '3M', binance: ['1d', 90], coinbase: 86400 },
  { key: '1y', label: '1Y', binance: ['1w', 52], coinbase: 86400 },
];

/** Where a native chart can source candles for a TradingView symbol (null = TradingView only). */
export function chartSourceFor(symbol) {
  const [ex, raw] = String(symbol || '').toUpperCase().split(':');
  if (!raw) return null;
  if (ex === 'BINANCE' && /^[A-Z0-9]{5,15}$/.test(raw)) return { kind: 'binance', pair: raw };
  if (ex === 'COINBASE') {
    const m = /^([A-Z0-9]{2,8})(USD|USDC|EUR|GBP|BTC)$/.exec(raw);
    if (m) return { kind: 'coinbase', product: `${m[1]}-${m[2]}` };
  }
  return null;
}

export function candlesUrl(source, rangeKey = '3m', now = Date.now()) {
  const r = CHART_RANGES.find((x) => x.key === rangeKey) || CHART_RANGES[2];
  if (source?.kind === 'binance') return `https://api.binance.com/api/v3/klines?symbol=${source.pair}&interval=${r.binance[0]}&limit=${r.binance[1]}`;
  if (source?.kind === 'coinbase') {
    const span = { '1d': 86400e3, '1w': 7 * 86400e3, '3m': 90 * 86400e3, '1y': 300 * 86400e3 }[r.key];
    const start = new Date(now - span).toISOString();
    return `https://api.exchange.coinbase.com/products/${source.product}/candles?granularity=${r.coinbase}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(new Date(now).toISOString())}`;
  }
  return null;
}

/** Binance klines [[openTime, o, h, l, c, ...]] or Coinbase [[time, low, high, open, close, vol]] → [{t, c}] ascending. */
export function parseCandles(source, json) {
  if (!Array.isArray(json)) return [];
  if (source?.kind === 'binance') return json.map((k) => ({ t: Number(k[0]), c: Number(k[4]) })).filter((p) => Number.isFinite(p.c));
  if (source?.kind === 'coinbase') return json.map((k) => ({ t: Number(k[0]) * 1000, c: Number(k[4]) })).filter((p) => Number.isFinite(p.c)).sort((a, b) => a.t - b.t);
  return [];
}

/** SVG line + area paths for a close series, plus min/max/last/change. */
export function linePath(points, w, h, pad = 6) {
  if (!Array.isArray(points) || points.length < 2 || w <= 0 || h <= 0) return null;
  const cs = points.map((p) => p.c);
  const min = Math.min(...cs);
  const max = Math.max(...cs);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (points.length - 1);
  const xy = points.map((p, i) => [pad + i * stepX, pad + (h - pad * 2) * (1 - (p.c - min) / span)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const area = `${d}L${xy[xy.length - 1][0].toFixed(1)} ${h}L${xy[0][0].toFixed(1)} ${h}Z`;
  const first = cs[0];
  const last = cs[cs.length - 1];
  return { d, area, min, max, first, last, changePct: first ? ((last - first) / first) * 100 : 0, lastXY: xy[xy.length - 1] };
}

export function tradingViewUrl(symbol) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol || '')}`;
}

export function groupPairs(pairs) {
  const order = ['crypto', 'forex', 'stocks', 'indices', 'commodities', 'custom'];
  const out = [];
  for (const cat of order) {
    const items = pairs.filter((p) => (p.category || 'custom') === cat);
    if (items.length) out.push({ cat, items });
  }
  return out;
}

/** DexScreener /latest/dex/tokens/<address> → the most liquid pair's stats. */
export function parseDexToken(json) {
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!pairs.length) return null;
  const best = [...pairs].sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
  const ch = best.priceChange || {};
  return {
    name: stripEmoji(best.baseToken?.name || ''),
    symbol: stripEmoji(best.baseToken?.symbol || ''),
    priceUsd: Number(best.priceUsd) || 0,
    liquidityUsd: Number(best.liquidity?.usd) || 0,
    volume24h: Number(best.volume?.h24) || 0,
    fdv: Number(best.fdv) || 0,
    changes: [
      { key: 'm5', label: '5m', pct: Number(ch.m5) || 0 },
      { key: 'h1', label: '1h', pct: Number(ch.h1) || 0 },
      { key: 'h6', label: '6h', pct: Number(ch.h6) || 0 },
      { key: 'h24', label: '24h', pct: Number(ch.h24) || 0 },
    ],
    dex: best.dexId || '',
    url: best.url || '',
  };
}

// ── terminal ────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]|\r(?!\n)/g;

/** Plain-text tail of a PTY buffer (web build fallback where xterm's WebView cannot run). */
export function terminalTail(buffer, maxLines = 60) {
  const text = String(buffer || '')
    .replace(ANSI_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-maxLines).join('\n');
}

export function terminalRows(res) {
  const list = Array.isArray(res?.terminals) ? res.terminals : Array.isArray(res) ? res : [];
  return list
    .filter((t) => t && t.id)
    .map((t) => ({
      id: t.id,
      title: stripEmoji(t.title || t.name || '') || 'Terminal',
      cwd: t.cwd || '',
      cli: t.isClaudeMode === true || t.isClaudeMode === 'True' || t.cliType === 'claude' ? 'claude' : t.cliType || t.activeCLI || 'shell',
      status: t.status === 'exited' ? 'exited' : 'running',
      lastActiveAt: t.lastActiveAt || t.createdAt || '',
    }))
    .sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)));
}

export function newTerminalId(now = Date.now()) {
  return `term-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── agency ops (agency.ops.* rows) ──────────────────────────────────────────
export function agencyRows(res) {
  return (Array.isArray(res?.agencies) ? res.agencies : []).map((a) => ({ id: a.id, name: stripEmoji(a.name) || 'Agency', role: a.role || '' }));
}

export function employeeRows(res) {
  return (Array.isArray(res?.employees) ? res.employees : []).map((e) => ({
    id: e.id,
    name: stripEmoji(e.name) || 'Employee',
    role: stripEmoji(e.role || ''),
    kind: e.kind === 'ai' ? 'AI' : 'Human',
    availability: e.availability || '',
    utilization: Math.max(0, Math.min(100, Number(e.utilizationPercent) || 0)),
    capacityHours: Number(e.capacityHours) || 0,
    allocatedHours: Number(e.allocatedHours) || 0,
    activeWork: Number(e.activeWork) || 0,
    department: stripEmoji(e.department || ''),
  }));
}

export function auditRows(res) {
  return (Array.isArray(res?.events) ? res.events : []).map((e) => ({
    id: String(e.id),
    title: `${humanize(e.entityType)} ${humanize(e.action)}`.trim(),
    actor: e.actorId || '',
    ts: Number(e.createdAt) || 0,
  }));
}

export function humanize(s) {
  return String(s || '').replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
