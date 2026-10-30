// mesh-data.js — the Agent Mesh's live data model, ported 1:1 from the web
// (ui/src/ui/controllers/agency-data-bridge.ts + views/agent-ops/resting-completed.ts).
//
// Same RPCs (federation.status, sessions.list, subagents.list), same push
// events (subagent.*, session.*, progress, agent tool stream, node.*), same
// normalisation, same "resting ring" of the last 10 finished runs parked on
// the Gateway Concourse. Pure: the hook (useAgentMesh) owns the socket.

export const LOCAL = 'local';
export const MAX_RESTING_COMPLETED = 10;
export const RESTING_STORAGE_KEY = 'infinibot.mesh.restingCompleted.v1';
const BACKENDS = new Set(['claude-code', 'opencode', 'codex', 'gemini', 'grok']);

/** The RPCs the web bridge's fetchState() runs (same params). */
export const MESH_SNAPSHOT_RPCS = [
  ['federation.status', {}],
  ['sessions.list', { includeGlobal: false, includeDerivedTitles: true, includeFederated: true, limit: 100 }],
  ['subagents.list', { includeCompleted: false, compact: true, limit: 100 }],
];

/** Push events the web bridge listens to. */
export const MESH_EVENTS = [
  'federation.event',
  'subagent.spawned', 'session.spawned',
  'subagent.complete', 'subagent.error', 'subagent.timeout', 'session.completed', 'session.complete',
  'session.progress', 'progress',
  'agent',
  'node.connected', 'node.status', 'node.disconnected',
  'federation.message.sent', 'federation.peer.connected',
];

const STATUS_MAP = {
  starting: 'starting', working: 'working', checkpoint: 'working', blocked: 'blocked', finishing: 'finishing',
  completed: 'completed', failed: 'failed', idle: 'idle',
  running: 'working', queued: 'starting', pending: 'starting', done: 'completed', complete: 'completed',
  succeeded: 'completed', ok: 'completed', error: 'failed', timeout: 'failed', killed: 'failed',
  cancelled: 'failed', aborted: 'failed',
};

export function normalizeStatus(s, active) {
  if (typeof s === 'string' && STATUS_MAP[s.toLowerCase()]) return STATUS_MAP[s.toLowerCase()];
  if (active) return 'working';
  return 'idle';
}

export function agentIdFromKey(key) {
  if (!key) return 'sub';
  return key.split(':')[1] || 'sub';
}

function asString(v, fallback = '') {
  return typeof v === 'string' && v ? v : fallback;
}

export function asEpochMs(v) {
  const n = typeof v === 'string' ? Date.parse(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 10_000_000_000 ? n * 1000 : n;
}

export function keyOf(p) {
  return asString(p?.sessionKey || p?.childSessionKey || p?.runId);
}

export function coderBackendOf(raw, label) {
  const id = asString(raw?.coderBackend);
  if (BACKENDS.has(id)) return id;
  const laId = asString(raw?.lastActivity?.coderBackend);
  if (BACKENDS.has(laId)) return laId;
  const name = label ?? asString(raw?.label || raw?.derivedTitle);
  if (name.startsWith('OpenCode')) return 'opencode';
  if (name.startsWith('Codex')) return 'codex';
  if (name.startsWith('Claude Coder')) return 'claude-code';
  if (name.startsWith('Grok')) return 'grok';
  if (asString(raw?.runId).startsWith('coder-')) return 'claude-code';
  return undefined;
}

export function isTerminalStatus(s) {
  return s === 'completed' || s === 'failed';
}

export function pluginIdOf(p) {
  const direct = asString(p?.pluginId) || asString(p?.plugin) || asString(p?.meta?.pluginId) || asString(p?.meta?.plugin);
  if (direct) return direct.toLowerCase();
  const tags = p?.tags ?? p?.meta?.tags ?? p?.labels;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const m = typeof t === 'string' ? /^plugin:([a-z0-9][a-z0-9-]*)$/i.exec(t.trim()) : null;
      if (m) return m[1].toLowerCase();
    }
  }
  return undefined;
}

export function toolOf(p) {
  const la = p?.lastActivity;
  if (la && typeof la === 'object' && typeof la.kind === 'string') {
    return { kind: String(la.kind), label: asString(la.label, String(la.kind)) };
  }
  const name = p?.tool?.name || p?.toolName || p?.name;
  const kind = p?.tool?.kind || p?.kind;
  if (typeof kind === 'string' && kind) return { kind, label: asString(name || kind, kind) };
  if (typeof name === 'string' && name) return { kind: name.toLowerCase(), label: name };
  return null;
}

export function withRunMeta(agent, sa) {
  if (!sa) return agent;
  const runId = asString(sa.runId);
  if (runId) agent.runId = runId;
  const la = sa.lastActivity;
  if (la && typeof la === 'object') {
    if (typeof la.label === 'string') agent.activityLabel = la.label;
    agent.lastActivity = la;
    const at = asEpochMs(la.at || la.timestamp || la.ts);
    if (at) agent.lastActivityAt = at;
  }
  const startedAt = asEpochMs(sa.startedAt || sa.createdAt || sa.started_at);
  const lastUpdateAt = asEpochMs(sa.lastUpdateAt || sa.updatedAt || sa.updated_at);
  const currentCheckpoint = asString(sa.currentCheckpoint || sa.checkpoint);
  const model = asString(sa.model || sa.modelId || sa.providerModel);
  if (startedAt) agent.startedAt = startedAt;
  if (lastUpdateAt) agent.lastUpdateAt = lastUpdateAt;
  if (currentCheckpoint) agent.currentCheckpoint = currentCheckpoint;
  if (model) agent.model = model;
  const files = Number(sa.filesTouchedCount);
  if (Number.isFinite(files) && files >= 0) agent.filesTouchedCount = files;
  const kanbanTaskId = asString(sa.kanbanTaskId);
  if (kanbanTaskId) agent.kanbanTaskId = kanbanTaskId;
  const endedAt = asEpochMs(sa.endedAt);
  if (endedAt) agent.endedAt = endedAt;
  if (agent.coderBackend) agent.isBuild = true;
  const pid = pluginIdOf(sa);
  if (pid) agent.pluginId = pid;
  return agent;
}

export function toAgent(raw) {
  const key = keyOf(raw);
  if (!key) return null;
  const la = raw?.lastActivity || null;
  const agent = {
    sessionKey: key,
    agentId: asString(raw?.agentId) || agentIdFromKey(key),
    label: asString(raw?.label || raw?.derivedTitle, key),
    nodeId: asString(raw?.nodeId, LOCAL),
    status: normalizeStatus(raw?.status, true),
    progress: Number(raw?.progress ?? 0) || 0,
    currentTask: asString(raw?.task || raw?.currentTask || raw?.derivedTitle) || undefined,
    parent: asString(raw?.parent || raw?.parentSessionKey) || undefined,
    coderBackend: coderBackendOf(raw),
  };
  if (la && typeof la === 'object') {
    agent.lastActivityKind = la.kind;
    agent.lastActivity = la;
  }
  return withRunMeta(agent, raw);
}

/** fetchState(): the three RPC answers → { nodes, agents } (web bridge :352). */
export function buildMeshState(fedRes, sessRes, subRes) {
  const nodes = [];
  const localHub = fedRes?.hub;
  if (localHub) {
    nodes.push({ id: localHub.nodeId || localHub.id || LOCAL, name: localHub.nodeName || localHub.name || 'Local', role: 'hub', status: 'online', agentCount: 0 });
  } else {
    nodes.push({ id: LOCAL, name: 'Local', role: 'hub', status: 'online', agentCount: 0 });
  }
  const peerList = Array.isArray(fedRes?.satellites) ? fedRes.satellites
    : Array.isArray(fedRes?.nodes) ? fedRes.nodes
      : Array.isArray(fedRes?.peers) ? fedRes.peers : [];
  const peerStatus = (p) => {
    if (typeof p.connected === 'boolean') return p.connected ? 'online' : 'offline';
    const st = String(p.state || p.status || '').toLowerCase();
    if (st === 'connected' || st === 'online' || st === 'registered' || st === 'ready') return 'online';
    if (st === 'connecting' || st === 'pending') return 'connecting';
    return 'offline';
  };
  for (const p of peerList) {
    const id = p.nodeId || p.id || p.peerId;
    if (!id) continue;
    if (localHub && id === (localHub.nodeId || localHub.id)) continue;
    nodes.push({ id, name: p.nodeName || p.name || p.displayName || id, role: 'satellite', status: peerStatus(p), agentCount: 0 });
  }

  const subs = Array.isArray(subRes?.subagents) ? subRes.subagents
    : Array.isArray(subRes?.items) ? subRes.items
      : Array.isArray(subRes) ? subRes : [];
  const subByKey = new Map();
  subs.forEach((sa) => {
    const k = keyOf(sa);
    if (k) subByKey.set(k, sa);
  });
  const sessRows = sessRes?.sessions || sessRes?.rows || [];
  const agents = [];
  const seen = new Set();
  sessRows.forEach((row) => {
    const isSub = row.kind === 'subagent' || String(row.key || '').includes(':subagent:');
    if (!isSub && row.kind !== 'main') return;
    const key = asString(row.key || row.sessionKey);
    if (!key) return;
    const sa = subByKey.get(key);
    if (isSub && !sa && !row.active) return;
    const la = sa?.lastActivity || null;
    const agent = {
      sessionKey: key,
      agentId: agentIdFromKey(key),
      label: asString(row.label || row.derivedTitle || sa?.label, key),
      nodeId: asString(row.nodeId, LOCAL),
      status: normalizeStatus(sa?.status, row.active),
      progress: Number(sa?.progress ?? row.progress ?? 0) || 0,
      currentTask: asString(sa?.task || row.currentTask || row.derivedTitle) || undefined,
      parent: asString(row.parentSessionKey) || undefined,
      coderBackend: coderBackendOf(sa ?? row, asString(row.label || row.derivedTitle || sa?.label)),
      model: asString(sa?.model || row.model || row.modelId) || undefined,
      startedAt: asEpochMs(sa?.startedAt || row.startedAt || row.createdAt),
      lastUpdateAt: asEpochMs(sa?.lastUpdateAt || row.updatedAt || row.lastActiveAt),
      currentCheckpoint: asString(sa?.currentCheckpoint || sa?.checkpoint) || undefined,
    };
    const tok = Number(row.totalTokens ?? (Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0)));
    if (Number.isFinite(tok) && tok > 0) agent.totalTokens = tok;
    if (la && typeof la === 'object') {
      agent.lastActivityKind = la.kind;
      agent.lastActivity = la;
      agent.lastActivityAt = asEpochMs(la.at || la.timestamp || la.ts);
    }
    withRunMeta(agent, sa);
    seen.add(key);
    agents.push(agent);
  });
  subs.forEach((sa) => {
    const key = keyOf(sa);
    if (!key || seen.has(key)) return;
    const agent = toAgent(sa);
    if (agent) {
      seen.add(key);
      agents.push(agent);
    }
  });
  return { nodes, agents };
}

// ── Resting ring (recently finished runs parked on the concourse) ──────────

function sanitizeResting(r) {
  if (!r || typeof r !== 'object' || typeof r.sessionKey !== 'string' || !r.sessionKey) return null;
  return {
    sessionKey: r.sessionKey,
    agentId: typeof r.agentId === 'string' && r.agentId ? r.agentId : 'sub',
    label: typeof r.label === 'string' && r.label ? r.label : r.sessionKey,
    nodeId: typeof r.nodeId === 'string' && r.nodeId ? r.nodeId : LOCAL,
    success: r.success !== false,
    endedAt: typeof r.endedAt === 'number' && Number.isFinite(r.endedAt) ? r.endedAt : 0,
    coderBackend: BACKENDS.has(r.coderBackend) ? r.coderBackend : undefined,
    runId: typeof r.runId === 'string' && r.runId ? r.runId : undefined,
  };
}

export function parseRestingJson(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr.map(sanitizeResting).filter(Boolean).slice(0, MAX_RESTING_COMPLETED) : [];
  } catch {
    return [];
  }
}

export function restingAgentOf(e) {
  const agent = { sessionKey: e.sessionKey, agentId: e.agentId, label: e.label, nodeId: e.nodeId, status: e.success ? 'completed' : 'failed', progress: e.success ? 100 : 0, resting: true, endedAt: e.endedAt };
  if (e.coderBackend) agent.coderBackend = e.coderBackend;
  if (e.runId) agent.runId = e.runId;
  return agent;
}

function restingEntryOf(agent, success, endedAt) {
  return { sessionKey: agent.sessionKey, agentId: agent.agentId, label: agent.label, nodeId: agent.nodeId, success, endedAt, coderBackend: agent.coderBackend, runId: agent.runId };
}

/**
 * MeshStore — the bridge's known agents / nodes / resting ring, with the
 * web's snapshot + reconcile + live-event rules. `onRestingChange(json)` lets
 * the hook persist the ring (AsyncStorage) like the web's localStorage.
 */
export class MeshStore {
  constructor({ resting = [], onRestingChange } = {}) {
    this.agents = new Map();
    this.nodes = new Map();
    this.resting = resting.slice(0, MAX_RESTING_COMPLETED);
    this.onRestingChange = onRestingChange || null;
    this.version = 0;
    this.toolBeats = []; // [{ sessionKey, kind, label, at }]
    this.completions = []; // [{ sessionKey, success, message, at }]
    // The web bridge's WorldEvent stream (agency-data-bridge.ts), drained by
    // the camera directors: agent.spawn / .progress / .tool / .complete, fed.*.
    this.worldEvents = [];
  }

  emit(e) {
    this.worldEvents.push(e);
    if (this.worldEvents.length > 200) this.worldEvents.splice(0, this.worldEvents.length - 200);
  }

  /** Hand the queued world events to the caller and clear the queue. */
  drainWorldEvents() {
    const out = this.worldEvents;
    this.worldEvents = [];
    return out;
  }

  // ring helpers
  restingHas(key) { return this.resting.some((e) => e.sessionKey === key); }
  restingRemove(key) {
    const before = this.resting.length;
    this.resting = this.resting.filter((e) => e.sessionKey !== key);
    if (this.resting.length !== before) this.saveResting();
  }
  restingAdd(entry) {
    this.resting = this.resting.filter((e) => e.sessionKey !== entry.sessionKey);
    this.resting.unshift(entry);
    this.resting.sort((a, b) => b.endedAt - a.endedAt);
    this.resting.splice(MAX_RESTING_COMPLETED);
    this.saveResting();
  }
  saveResting() {
    try { this.onRestingChange?.(JSON.stringify(this.resting)); } catch { /* storage */ }
  }

  finish(key, success, message, latest, now = Date.now()) {
    if (this.restingHas(key)) return;
    const last = latest ?? this.agents.get(key);
    this.agents.delete(key);
    this.emit({ kind: 'agent.complete', sessionKey: key, success, message });
    this.completions.push({ sessionKey: key, success, message, at: now });
    if (this.completions.length > 40) this.completions.splice(0, this.completions.length - 40);
    if (!last) return;
    this.restingAdd(restingEntryOf(last, success, now));
  }

  noteTool(key, tool, now = Date.now()) {
    if (!tool) return;
    this.emit({ kind: 'agent.tool', sessionKey: key, tool: { kind: tool.kind, label: tool.label } });
    this.toolBeats.push({ sessionKey: key, kind: tool.kind, label: tool.label, at: now });
    if (this.toolBeats.length > 400) this.toolBeats.splice(0, this.toolBeats.length - 400);
  }

  /** A fresh fetchState(): first call = snapshot, later calls = reconcile. */
  applySnapshot({ nodes, agents }, now = Date.now()) {
    const nodeIds = new Set();
    for (const n of nodes) {
      nodeIds.add(n.id);
      this.nodes.set(n.id, n);
    }
    for (const id of Array.from(this.nodes.keys())) if (!nodeIds.has(id)) this.nodes.delete(id);
    const keys = new Set();
    for (const a of agents) {
      const prev = this.agents.get(a.sessionKey);
      if (!prev && isTerminalStatus(a.status)) {
        // Already finished inside the list's grace window: park it (snapshot) or skip.
        if (!this.restingHas(a.sessionKey) && this.version === 0) this.restingAdd(restingEntryOf(a, a.status !== 'failed', now));
        continue;
      }
      if (prev && isTerminalStatus(a.status)) {
        this.finish(a.sessionKey, a.status !== 'failed', undefined, { ...prev, ...a }, now);
        continue;
      }
      keys.add(a.sessionKey);
      if (!prev) {
        this.restingRemove(a.sessionKey);
        this.emit({ kind: 'agent.spawn', agent: a });
      } else if (prev.status !== a.status || prev.progress !== a.progress || prev.activityLabel !== a.activityLabel || prev.currentTask !== a.currentTask || prev.lastActivityAt !== a.lastActivityAt) {
        this.emit({ kind: 'agent.progress', sessionKey: a.sessionKey, patch: a });
        if (prev.activityLabel !== a.activityLabel || prev.lastActivityAt !== a.lastActivityAt) this.noteTool(a.sessionKey, toolOf(a), now);
      }
      this.agents.set(a.sessionKey, prev ? { ...prev, ...a } : a);
    }
    for (const key of Array.from(this.agents.keys())) {
      if (!keys.has(key)) this.finish(key, this.agents.get(key)?.status !== 'failed', undefined, undefined, now);
    }
    this.version += 1;
    return true;
  }

  /** One push event (web bridge mapTopic). Returns true when the map changed. */
  applyEvent(topic, payload, now = Date.now()) {
    const p = payload ?? {};
    switch (topic) {
      case 'federation.event': {
        const inner = p?.event;
        return inner && typeof inner.type === 'string' ? this.applyEvent(inner.type, inner.payload ?? {}, now) : false;
      }
      case 'subagent.spawned':
      case 'session.spawned': {
        const agent = toAgent(p);
        if (!agent) return false;
        this.restingRemove(agent.sessionKey);
        this.agents.set(agent.sessionKey, { ...(this.agents.get(agent.sessionKey) || {}), ...agent });
        this.emit({ kind: 'agent.spawn', agent });
        break;
      }
      case 'subagent.complete':
      case 'subagent.error':
      case 'subagent.timeout':
      case 'session.completed':
      case 'session.complete': {
        const key = keyOf(p);
        if (!key) return false;
        const success = topic === 'subagent.complete' || topic === 'session.completed' || topic === 'session.complete' || p?.ok === true || p?.outcome?.status === 'ok';
        this.finish(key, !!success && topic !== 'subagent.error' && topic !== 'subagent.timeout', asString(p?.outcome?.error || p?.error || p?.reason) || undefined, undefined, now);
        break;
      }
      case 'session.progress':
      case 'progress': {
        const key = keyOf(p);
        if (!key) return false;
        const patch = {};
        if (p.status !== undefined) patch.status = normalizeStatus(p.status, true);
        if (p.progress !== undefined) patch.progress = Number(p.progress) || 0;
        if (p.label !== undefined) patch.label = asString(p.label);
        if (p.currentTask !== undefined || p.task !== undefined) patch.currentTask = asString(p.currentTask || p.task) || undefined;
        patch.lastUpdateAt = asEpochMs(p.lastUpdateAt || p.updatedAt || p.ts) ?? now;
        const at = asEpochMs(p.lastActivity?.at || p.lastActivity?.timestamp || p.lastActivity?.ts);
        if (at) patch.lastActivityAt = at;
        if (p.lastActivity && typeof p.lastActivity === 'object') {
          patch.lastActivity = p.lastActivity;
          if (typeof p.lastActivity.label === 'string') patch.activityLabel = p.lastActivity.label;
        }
        if (p.currentCheckpoint !== undefined || p.checkpoint !== undefined) patch.currentCheckpoint = asString(p.currentCheckpoint || p.checkpoint) || undefined;
        if (p.model !== undefined || p.modelId !== undefined) patch.model = asString(p.model || p.modelId) || undefined;
        const pid = pluginIdOf(p);
        if (pid) patch.pluginId = pid;
        const backend = coderBackendOf(p);
        if (backend) patch.coderBackend = backend;
        const prev = this.agents.get(key);
        if (!prev && patch.status && isTerminalStatus(patch.status) && this.restingHas(key)) delete patch.status;
        if (prev || this.agents.has(key)) this.emit({ kind: 'agent.progress', sessionKey: key, patch });
        if (prev) this.agents.set(key, { ...prev, ...patch });
        else if (patch.status && !isTerminalStatus(patch.status) && this.restingHas(key)) {
          const entry = this.resting.find((e) => e.sessionKey === key);
          this.restingRemove(key);
          if (entry) this.agents.set(key, { ...restingAgentOf(entry), resting: false, ...patch });
        }
        this.noteTool(key, toolOf(p), now);
        if (prev && patch.status && isTerminalStatus(patch.status)) this.finish(key, patch.status !== 'failed', undefined, { ...prev, ...patch }, now);
        break;
      }
      case 'agent': {
        if (p.stream !== 'tool') return false;
        const key = keyOf(p);
        const name = p?.data?.name;
        if (!key || typeof name !== 'string' || !name) return false;
        this.noteTool(key, { kind: name.toLowerCase(), label: name }, now);
        const prev = this.agents.get(key);
        if (prev) this.agents.set(key, { ...prev, activityLabel: name, lastActivityAt: now });
        break;
      }
      case 'node.connected':
      case 'node.status': {
        const id = asString(p.nodeId);
        if (!id) return false;
        this.nodes.set(id, { id, name: asString(p.name || p.nodeName, id), role: p.role === 'hub' ? 'hub' : 'satellite', status: p.connected === false ? 'offline' : 'online', agentCount: this.nodes.get(id)?.agentCount ?? 0 });
        break;
      }
      case 'federation.message.sent': {
        const fromNodeId = asString(p?.fromNodeId || p?.from);
        const toNodeId = asString(p?.toNodeId || p?.to);
        if (fromNodeId && toNodeId) this.emit({ kind: 'fed.msg.send', fromNodeId, toNodeId });
        return false;
      }
      case 'federation.peer.connected': {
        const peerNodeId = asString(p?.peerNodeId || p?.nodeId);
        if (peerNodeId) this.emit({ kind: 'fed.peer.connect', peerNodeId });
        return false;
      }
      case 'node.disconnected': {
        const id = asString(p.nodeId);
        if (!id || !this.nodes.has(id)) return false;
        this.nodes.delete(id);
        break;
      }
      default:
        return false;
    }
    this.version += 1;
    return true;
  }

  /** Every agent on the map: live ones + the resting finished runs. */
  listAgents() {
    const out = Array.from(this.agents.values());
    for (const e of this.resting) if (!this.agents.has(e.sessionKey)) out.push(restingAgentOf(e));
    return out;
  }

  listNodes() {
    const counts = new Map();
    for (const a of this.agents.values()) counts.set(a.nodeId, (counts.get(a.nodeId) || 0) + 1);
    return Array.from(this.nodes.values()).map((n) => ({ ...n, agentCount: counts.get(n.id) || 0 }));
  }
}
