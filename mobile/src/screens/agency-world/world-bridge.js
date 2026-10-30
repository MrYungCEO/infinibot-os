/**
 * world-bridge — pure helpers shared between the RN host and the world engine.
 *
 * This mirrors (mobile-side) the web Agency World bridge: it normalizes raw
 * gateway rows into the engine's vocabulary and diffs two snapshots into a
 * list of incremental WorldEvent objects so the engine can animate changes
 * instead of re-syncing the whole world every tick.
 *
 * WorldEvent shapes (plain objects with a `kind` field, same as the web side):
 *   { kind:'node.upsert',  node }
 *   { kind:'node.remove',  nodeId }
 *   { kind:'agent.spawn',  agent }
 *   { kind:'agent.progress', sessionKey, patch }
 *   { kind:'agent.tool',   sessionKey, tool:{ kind, label } }
 *   { kind:'agent.message', from, to, type }
 *   { kind:'agent.complete', sessionKey, success }
 *   { kind:'task.ingest',  id, title, nodeId }
 *   { kind:'period.tick',  epochMs }
 *
 * Everything here is pure (no React, no DOM, no side effects) so it is safe
 * to unit-test and to run with `node --check`.
 */

export const LOCAL_NODE_ID = 'local';

// Gateway event topic the web UI publishes its settled camera on. Mobile
// subscribes and mirrors it onto the WebView engine (cross-device auto-zoom).
export const WORLD_CAMERA_EVENT = 'world.camera';

// ── WebView command builders (host → embed postMessage payloads) ──
// The embed (ui/src/embed/agency-world-mobile.ts) understands these `type`s.

/** Eased camera transform — drives engine.applyCamera() inside the WebView. */
export function buildCameraMessage(zoom, centerX, centerY, easeMs) {
  return JSON.stringify({
    type: 'camera',
    zoom,
    centerX,
    centerY,
    easeMs: typeof easeMs === 'number' ? easeMs : 600,
  });
}

/** Discrete zoom control — action is 'in' | 'out' | 'fit'. */
export function buildZoomMessage(action) {
  return JSON.stringify({ type: 'zoom', action: action || 'fit' });
}

// Map a subagent status string to the engine's normalized vocabulary.
export function normalizeStatus(s, active) {
  const m = {
    starting: 'starting',
    working: 'working',
    checkpoint: 'working',
    blocked: 'blocked',
    finishing: 'finishing',
    completed: 'completed',
    failed: 'failed',
    idle: 'idle',
  };
  if (s && m[s]) return m[s];
  if (active) return 'working';
  return 'idle';
}

// Infer the visual provider palette key from an agent's identity fields.
// Mirrors inferProvider() in world-html.js so the host and engine agree.
export function inferProvider(agent) {
  const a = agent || {};
  const s = ((a.agentId || '') + ' ' + (a.label || '') + ' ' + (a.model || '')).toLowerCase();
  if (/claude|opus|sonnet|haiku|anthropic/.test(s)) return 'claude';
  if (/gpt|openai|codex/.test(s)) return 'openai';
  if (/gemini|google/.test(s)) return 'gemini';
  if (/ollama|local/.test(s)) return 'ollama';
  if (/xai|grok/.test(s)) return 'xai';
  return 'default';
}

// Tool-kind → Galactic HQ sector mapping.
// Mirrors TOOL_TO_SECTOR in world-html.js (which uses iso/sector-layout.ts IDs).
// The old zone names (drafting, library, terminal, …) are mapped to their
// corresponding sector IDs for documentation parity.
const TOOL_TO_ZONE = {
  // engineering-bay ← old: drafting + terminal
  edit: 'engineering-bay', write: 'engineering-bay', notebookedit: 'engineering-bay',
  bash: 'engineering-bay', bashoutput: 'engineering-bay',
  // observatory ← old: library
  read: 'observatory', glob: 'observatory', grep: 'observatory', toolsearch: 'observatory', search: 'observatory',
  // gateway-concourse ← old: browser
  webfetch: 'gateway-concourse', websearch: 'gateway-concourse', browser: 'gateway-concourse',
  // mission-control ← old: comm + kanban
  task: 'mission-control', agent: 'mission-control',
  taskcreate: 'mission-control', taskupdate: 'mission-control', tasklist: 'mission-control', taskget: 'mission-control',
  schedulewakeup: 'mission-control',
  // comms-deck ← old: message
  message: 'comms-deck',
  // the-vault ← old: records
  memoryget: 'the-vault', memorysearch: 'the-vault',
  // agent-quarters ← old: lounge / assistant
  assistant: 'agent-quarters',
  // broadcast-studio ← speak/tts
  speak: 'broadcast-studio', tts: 'broadcast-studio',
  // canvas-atrium ← design/canvas
  canvas: 'canvas-atrium', design: 'canvas-atrium',
};

// Infer which Galactic HQ sector an agent belongs in.
// Mirrors inferSector() in world-html.js.
export function inferZone(agent) {
  const a = agent || {};
  if (a.status === 'idle' || a.status === 'completed') return 'agent-quarters';
  if (a.status === 'starting') return 'gateway-concourse';
  const k = String(
    (a.lastActivity && a.lastActivity.kind) || a.lastActivityKind || ''
  ).toLowerCase();
  if (k && TOOL_TO_ZONE[k]) return TOOL_TO_ZONE[k];
  const aid = String(a.agentId || '').toLowerCase();
  if (aid.indexOf('coder') >= 0)    return 'engineering-bay';
  if (aid.indexOf('research') >= 0) return 'observatory';
  if (aid.indexOf('browser') >= 0)  return 'gateway-concourse';
  if (aid.indexOf('tester') >= 0)   return 'engineering-bay';
  return 'agent-quarters';
}

// ── internal helpers ──────────────────────────────────────────────

function toMap(arr, keyFn) {
  const m = new Map();
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item) continue;
      const k = keyFn(item);
      if (k != null) m.set(k, item);
    }
  }
  return m;
}

function lastActivityKey(la) {
  if (!la) return '';
  return String(la.kind || '') + '|' + String(la.label || '') + '|' + String(la.at || '');
}

function nodeChanged(a, b) {
  if (!a || !b) return true;
  return (
    a.name !== b.name ||
    a.role !== b.role ||
    a.status !== b.status ||
    (a.agentCount || 0) !== (b.agentCount || 0)
  );
}

/**
 * diffToWorldEvents(prev, next) — pure diff of two snapshots into WorldEvents.
 *
 * Each snapshot is `{ nodes:[], agents:[], tasks:[] }` (the same shape the host
 * builds for a full `sync`). Returns an array of WorldEvent objects describing
 * only what changed. With no `prev` (first call), every node/agent/task is
 * emitted as an upsert/spawn/ingest so the engine can build from empty.
 *
 * Ordering is deterministic: node.upsert → node.remove → agent.spawn →
 * agent.tool/agent.progress → agent.complete → task.ingest. Nodes come first so
 * agents always have a building to attach to when the engine applies events.
 */
export function diffToWorldEvents(prev, next) {
  const events = [];
  const nextSnap = next || {};
  const prevSnap = prev || {};

  const prevNodes = toMap(prevSnap.nodes, (n) => n.id);
  const nextNodes = toMap(nextSnap.nodes, (n) => n.id);
  const prevAgents = toMap(prevSnap.agents, (a) => a.sessionKey);
  const nextAgents = toMap(nextSnap.agents, (a) => a.sessionKey);
  const prevTasks = toMap(prevSnap.tasks, (t) => t.id);
  const nextTasks = toMap(nextSnap.tasks, (t) => t.id);

  // ── Nodes: new or changed → node.upsert ──
  nextNodes.forEach((node, id) => {
    const before = prevNodes.get(id);
    if (!before || nodeChanged(before, node)) {
      events.push({ kind: 'node.upsert', node: node });
    }
  });
  // ── Nodes: vanished → node.remove ──
  prevNodes.forEach((node, id) => {
    if (!nextNodes.has(id)) {
      events.push({ kind: 'node.remove', nodeId: id });
    }
  });

  // ── Agents: new → agent.spawn ──
  nextAgents.forEach((agent, key) => {
    const before = prevAgents.get(key);
    if (!before) {
      events.push({ kind: 'agent.spawn', agent: agent });
      // Seed the engine with the agent's current activity zone right away.
      if (agent.lastActivity && agent.lastActivity.kind) {
        events.push({
          kind: 'agent.tool',
          sessionKey: key,
          tool: {
            kind: agent.lastActivity.kind,
            label: agent.lastActivity.label || agent.lastActivity.kind,
          },
        });
      }
      return;
    }
    // ── Agents: changed status/progress/lastActivity → agent.progress (+tool) ──
    const statusChanged = before.status !== agent.status;
    const progressChanged = Number(before.progress || 0) !== Number(agent.progress || 0);
    const taskChanged = before.currentTask !== agent.currentTask;
    const labelChanged = before.label !== agent.label;
    const nodeChangedFlag = before.nodeId !== agent.nodeId;
    const activityChanged =
      lastActivityKey(before.lastActivity) !== lastActivityKey(agent.lastActivity);

    if (statusChanged || progressChanged || taskChanged || labelChanged || nodeChangedFlag) {
      const patch = {
        status: agent.status,
        progress: Number(agent.progress || 0),
        currentTask: agent.currentTask,
        label: agent.label,
        nodeId: agent.nodeId,
        lastActivity: agent.lastActivity,
      };
      events.push({ kind: 'agent.progress', sessionKey: key, patch: patch });
    }
    // A fresh tool/lastActivity drives a zone change in the engine.
    if (activityChanged && agent.lastActivity && agent.lastActivity.kind) {
      events.push({
        kind: 'agent.tool',
        sessionKey: key,
        tool: {
          kind: agent.lastActivity.kind,
          label: agent.lastActivity.label || agent.lastActivity.kind,
        },
      });
    }
  });

  // ── Agents: vanished → agent.complete (success unknown → infer from status) ──
  prevAgents.forEach((agent, key) => {
    if (!nextAgents.has(key)) {
      const success = agent.status !== 'failed' && agent.status !== 'blocked';
      events.push({ kind: 'agent.complete', sessionKey: key, success: success });
    }
  });

  // ── Tasks: new → task.ingest ──
  nextTasks.forEach((task, id) => {
    if (!prevTasks.has(id)) {
      events.push({
        kind: 'task.ingest',
        id: id,
        title: task.title || id,
        nodeId: task.nodeId || LOCAL_NODE_ID,
      });
    }
  });

  return events;
}

export default {
  LOCAL_NODE_ID,
  normalizeStatus,
  inferProvider,
  inferZone,
  diffToWorldEvents,
};
