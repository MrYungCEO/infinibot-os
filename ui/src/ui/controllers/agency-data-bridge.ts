/**
 * Agency Data Bridge — sub-200ms live data path for the Agency World viz.
 *
 * Replaces the old 3.5s polling loop in agency-world-viz.ts with the gateway
 * WebSocket event stream. On construct it does an immediate snapshot fetch so
 * the world fills instantly, then subscribes to the live event stream and
 * coalesces bursts into one batch per animation frame (with a 200ms safety
 * debounce). A slow 10s reconcile poll always runs to self-heal missed deltas;
 * if no event frames arrive within ~6s it warns once and treats the reconcile
 * poll as the primary source.
 *
 * The bridge translates raw gateway topics (evt.event) into a normalized
 * WorldEvent[] that the Lit element applies to the engine 1:1.
 */

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import type { MeshAgent, MeshNode } from "../views/agent-ops/activity-map";
import {
  RestingRing,
  restingAgentOf,
  type RestingEntry,
} from "../views/agent-ops/resting-completed";

const LOCAL = "local";

/**
 * Operator-facing display-name overrides for federation nodes.
 *
 * Until the gateway-side `pairedByNodeId` overlay in `federation.nodes.list`
 * is rebuilt + reloaded, the live `federation.status` response returns the
 * satellite's raw manifest name (e.g. the hostname it advertised when it
 * connected). This map lets the UI rename specific node ids on the fly so
 * the activity map labels them with friendly names immediately, no gateway
 * restart required.
 *
 * Add an entry here for each federation peer that needs a static UI alias.
 */
const NODE_NAME_OVERRIDES: Record<string, string> = {};

function resolveNodeDisplayName(id: string, fallback: string): string {
  return NODE_NAME_OVERRIDES[id] ?? fallback;
}

export type WorldEvent =
  | { kind: "node.upsert"; node: MeshNode }
  | { kind: "node.remove"; nodeId: string }
  | { kind: "agent.spawn"; agent: MeshAgent }
  | { kind: "agent.progress"; sessionKey: string; patch: Partial<MeshAgent> }
  | { kind: "agent.tool"; sessionKey: string; tool: { kind: string; label: string } }
  | { kind: "agent.message"; from: string; to: string; type: "request" | "response" | "broadcast" }
  | { kind: "agent.complete"; sessionKey: string; success: boolean; message?: string }
  // A resting finished agent was evicted from the recently-completed ring
  // (an 11th run finished) — walk it off the map and free its bed.
  | { kind: "agent.leave"; sessionKey: string }
  | { kind: "task.ingest"; id: string; title: string; nodeId?: string; priority?: string }
  | { kind: "period.tick"; epochMs: number }
  // ── Federation messaging (Part 2) — emitted by mapFederationTopic ──
  | { kind: "fed.msg.send"; fromNodeId: string; toNodeId: string; messageType: string; msgId: string }
  | { kind: "fed.msg.ack"; fromNodeId: string; toNodeId: string; msgId: string; latencyMs?: number }
  | { kind: "fed.msg.fail"; fromNodeId: string; toNodeId: string; msgId: string; reason?: string }
  | { kind: "fed.peer.connect"; peerNodeId: string }
  | { kind: "fed.peer.disconnect"; peerNodeId: string }
  // ── SSH connections (Part 3) — emitted by mapSshTopic ──
  | { kind: "ssh.connection.opened"; deviceId: string; host: string }
  | { kind: "ssh.connection.closed"; deviceId: string; host: string; durationMs?: number }
  | { kind: "ssh.command.executed"; deviceId: string; host: string; command: string; exitCode: number; durationMs?: number }
  | { kind: "ssh.connection.error"; deviceId: string; host: string; error?: string }
  // Back-compat aliases from the first bridge pass.
  | { kind: "ssh.open"; deviceId: string; host: string }
  | { kind: "ssh.close"; deviceId: string; host: string; durationMs?: number }
  | { kind: "ssh.exec"; deviceId: string; host: string; command: string; exitCode: number; durationMs?: number }
  | { kind: "ssh.error"; deviceId: string; host: string; error?: string };

// ════════════════════════════════════════════════════════════════
// NORMALIZATION HELPERS (mirrors agency-world-viz.ts syncOnce logic)
// ════════════════════════════════════════════════════════════════

function normalizeStatus(s: any, active?: boolean): MeshAgent["status"] {
  const m: Record<string, MeshAgent["status"]> = {
    starting: "starting",
    working: "working",
    checkpoint: "working",
    blocked: "blocked",
    finishing: "finishing",
    completed: "completed",
    failed: "failed",
    idle: "idle",
    // subagents.list / registry vocabulary for coder runs.
    running: "working",
    queued: "starting",
    pending: "starting",
    done: "completed",
    complete: "completed",
    succeeded: "completed",
    ok: "completed",
    error: "failed",
    timeout: "failed",
    killed: "failed",
    cancelled: "failed",
    aborted: "failed",
  };
  if (typeof s === "string" && m[s.toLowerCase()]) return m[s.toLowerCase()];
  if (active) return "working";
  return "idle";
}

function agentIdFromKey(key: string): string {
  if (!key) return "sub";
  const parts = key.split(":");
  return parts[1] || "sub";
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v ? v : fallback;
}

function asEpochMs(v: unknown): number | undefined {
  const n = typeof v === "string" ? Date.parse(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 10_000_000_000 ? n * 1_000 : n;
}

/** Pull a usable session key from a raw lifecycle/progress payload. */
function keyOf(p: any): string {
  return asString(p?.sessionKey || p?.childSessionKey || p?.runId);
}

/**
 * Resolve the CLI backend for a row. Prefers the registry-stamped
 * `coderBackend` (subagent rows carry it from subagent-registry.ts via
 * `subagents.list` / `subagent.spawned`), and falls back to a label-prefix
 * heuristic IDENTICAL to views/agent-activity.ts so legacy rows resolve the
 * same brand the running-agent cards show. Returns undefined for native /
 * non-coder rows so the mesh sprite renders no badge.
 */
function coderBackendOf(raw: any, label?: string): MeshAgent["coderBackend"] {
  const id = asString(raw?.coderBackend);
  if (id === "claude-code" || id === "opencode" || id === "codex" || id === "gemini" || id === "grok") {
    return id;
  }
  // Progress records stamp the backend on lastActivity even when the list row
  // itself doesn't carry it (detached claude_coder runs).
  const laId = asString(raw?.lastActivity?.coderBackend);
  if (
    laId === "claude-code" ||
    laId === "opencode" ||
    laId === "codex" ||
    laId === "gemini" ||
    laId === "grok"
  ) {
    return laId;
  }
  const name = label ?? asString(raw?.label || raw?.derivedTitle);
  if (name.startsWith("OpenCode")) return "opencode";
  if (name.startsWith("Codex")) return "codex";
  if (name.startsWith("Claude Coder")) return "claude-code";
  if (name.startsWith("Grok")) return "grok";
  // claude_coder run ids are `coder-<slug>-<id>` (src/agents/run-id.ts); the
  // registry defaults an unstamped coder run to claude-code.
  if (asString(raw?.runId).startsWith("coder-")) return "claude-code";
  return undefined;
}

function isTerminalStatus(s: MeshAgent["status"]): boolean {
  return s === "completed" || s === "failed";
}

function restingEntryOf(agent: MeshAgent, success: boolean, endedAt: number): RestingEntry {
  return {
    sessionKey: agent.sessionKey,
    agentId: agent.agentId,
    label: agent.label,
    nodeId: agent.nodeId,
    success,
    endedAt,
    coderBackend: agent.coderBackend,
    runId: agent.runId,
  };
}

/** Stamp the run-level fields the map's build layer reads off a subagents.list row. */
function withRunMeta(agent: MeshAgent, sa: any): MeshAgent {
  if (!sa) return agent;
  const runId = asString(sa.runId);
  if (runId) agent.runId = runId;
  const la = sa.lastActivity;
  if (la && typeof la === "object") {
    if (typeof la.label === "string") agent.activityLabel = la.label;
    agent.lastActivity = la;
    const lastActivityAt = asEpochMs(la.at || la.timestamp || la.ts);
    if (lastActivityAt) agent.lastActivityAt = lastActivityAt;
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

/** Build a MeshAgent from a raw spawn-ish payload + optional subagent meta. */
function toAgent(raw: any): MeshAgent | null {
  const key = keyOf(raw);
  if (!key) return null;
  const la = raw?.lastActivity || null;
  const agent: MeshAgent = {
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
  if (la && typeof la === "object") {
    (agent as any).lastActivityKind = (la as any).kind;
    agent.lastActivity = la;
  }
  return withRunMeta(agent, raw);
}

/** Plugin id a payload is tagged with (`plugin`, `pluginId`, or a `plugin:<id>` tag). */
function pluginIdOf(p: any): string | undefined {
  const direct = asString(p?.pluginId) || asString(p?.plugin) || asString(p?.meta?.pluginId) || asString(p?.meta?.plugin);
  if (direct) return direct.toLowerCase();
  const tags: unknown = p?.tags ?? p?.meta?.tags ?? p?.labels;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const m = typeof t === "string" ? /^plugin:([a-z0-9][a-z0-9-]*)$/i.exec(t.trim()) : null;
      if (m) return m[1].toLowerCase();
    }
  }
  return undefined;
}

/** Extract a {kind,label} tool descriptor from a progress/tool payload. */
function toolOf(p: any): { kind: string; label: string } | null {
  const la = p?.lastActivity;
  if (la && typeof la === "object" && typeof la.kind === "string") {
    return { kind: String(la.kind), label: asString(la.label, String(la.kind)) };
  }
  const name = p?.tool?.name || p?.toolName || p?.name;
  const kind = p?.tool?.kind || p?.kind;
  if (typeof kind === "string" && kind) {
    return { kind, label: asString(name || kind, kind) };
  }
  if (typeof name === "string" && name) {
    return { kind: name.toLowerCase(), label: name };
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
// BRIDGE
// ════════════════════════════════════════════════════════════════

export class AgencyDataBridge {
  private client: GatewayBrowserClient;
  private unsub: (() => void) | null = null;
  private subscribers = new Set<(events: WorldEvent[]) => void>();

  private queue: WorldEvent[] = [];
  private rafId: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private sawEvent = false;
  private warnedFallback = false;
  private destroyed = false;

  // Last-known snapshot sets (for diff-based reconcile + dedupe of spawns).
  private knownAgents = new Map<string, MeshAgent>();
  private knownNodes = new Map<string, MeshNode>();
  // Finished runs resting on the Concourse beds (newest MAX_RESTING_COMPLETED).
  // Disjoint from knownAgents: a key is either live (known) or resting.
  private resting: RestingRing;

  constructor(client: GatewayBrowserClient, opts: { resting?: RestingRing } = {}) {
    this.client = client;
    this.resting = opts.resting ?? new RestingRing();
    // Immediate snapshot + live stream + reconcile on construct, so the
    // world fills the instant the bridge exists (matches the contract).
    this.start();
  }

  subscribe(cb: (events: WorldEvent[]) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.unsub?.();
    this.unsub = null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.queue = [];
    this.subscribers.clear();
  }

  // ──────────────────────── startup ────────────────────────

  private start(): void {
    // Immediate snapshot so the world fills instantly.
    void this.snapshot().catch(() => {});

    // Live event stream.
    this.unsub = this.client.subscribe((evt) => this.onFrame(evt));

    // Fallback watchdog: if no frames within ~6s, warn + lean on reconcile.
    this.fallbackTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (!this.sawEvent && !this.warnedFallback) {
        this.warnedFallback = true;
        console.warn("[agency-bridge] no event stream — falling back to 10s polling");
      }
    }, 6000);

    // Always keep a slow reconcile to self-heal missed deltas.
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch(() => {});
    }, 10000);
  }

  // ──────────────────────── snapshot / reconcile ────────────────────────

  /** Fetch the current state triple and normalize into nodes + agents. */
  private async fetchState(): Promise<{ nodes: MeshNode[]; agents: MeshAgent[] }> {
    let fedRes: any = {};
    let sessRes: any = {};
    let subRes: any = {};
    try {
      [fedRes, sessRes, subRes] = await Promise.all([
        this.client.request("federation.status", {}).catch(() => ({})),
        this.client
          .request("sessions.list", {
            includeGlobal: false,
            includeDerivedTitles: true,
            includeFederated: true,
            limit: 100,
          })
          .catch(() => ({})),
        this.client
          .request("subagents.list", {
            includeCompleted: false,
            compact: true,
            limit: 100,
          })
          .catch(() => ({})),
      ]);
    } catch {
      return { nodes: [], agents: [] };
    }

    // ── Nodes ──
    // The gateway's `federation.status` response shape is
    //   { role:'master'|'satellite', connected:boolean, nodeCount:number,
    //     nodes:[{ id, name, state }] }   — peers (all roles).
    // Some older fixtures shipped `{ hub:{...}, satellites:[{nodeId,nodeName,connected}] }`,
    // so accept both. Without this fallback the master's registered peer
    // silently never reaches addNode() and the island never renders.
    const nodes: MeshNode[] = [];
    const localHub = fedRes?.hub;
    if (localHub) {
      nodes.push({
        id: localHub.nodeId || localHub.id || LOCAL,
        name: localHub.nodeName || localHub.name || "Local",
        role: "hub",
        status: "online",
        agentCount: 0,
      });
    } else {
      nodes.push({ id: LOCAL, name: "Local", role: "hub", status: "online", agentCount: 0 });
    }
    const peerList: any[] = Array.isArray(fedRes?.satellites)
      ? fedRes.satellites
      : Array.isArray(fedRes?.nodes)
        ? fedRes.nodes
        : Array.isArray(fedRes?.peers)
          ? fedRes.peers
          : [];
    const peerStatus = (p: any): "online" | "offline" | "connecting" => {
      // Newer shape: state ∈ {connected, registered, disconnected, …}.
      // Older shape: connected:boolean. Treat 'registered' as online so a
      // peer that registered but isn't streaming yet still gets an island.
      if (typeof p.connected === "boolean") return p.connected ? "online" : "offline";
      const st = String(p.state || p.status || "").toLowerCase();
      if (st === "connected" || st === "online" || st === "registered" || st === "ready") return "online";
      if (st === "connecting" || st === "pending") return "connecting";
      return "offline";
    };
    for (const p of peerList) {
      const id = p.nodeId || p.id || p.peerId;
      if (!id) continue;
      // Skip the hub if it appears in the peers array.
      if (localHub && (id === (localHub.nodeId || localHub.id))) continue;
      nodes.push({
        id,
        name: resolveNodeDisplayName(id, p.nodeName || p.name || p.displayName || id),
        role: "satellite",
        status: peerStatus(p),
        agentCount: 0,
      });
    }

    // ── Agents ──
    const subs: any[] = Array.isArray(subRes?.subagents)
      ? subRes.subagents
      : Array.isArray(subRes?.items)
        ? subRes.items
        : Array.isArray(subRes)
          ? subRes
          : [];
    const subByKey = new Map<string, any>();
    subs.forEach((sa: any) => {
      const k = keyOf(sa);
      if (k) subByKey.set(k, sa);
    });

    const sessRows: any[] = sessRes?.sessions || sessRes?.rows || [];
    const agents: MeshAgent[] = [];
    const seenKeys = new Set<string>();

    sessRows.forEach((row: any) => {
      const isSub =
        row.kind === "subagent" || String(row.key || "").includes(":subagent:");
      if (!isSub && row.kind !== "main") return;
      const key = asString(row.key || row.sessionKey);
      if (!key) return;
      const sa = subByKey.get(key);
      // A subagent session row with no live subagents.list entry is a past
      // run's transcript, not a running agent — drawing it parks a stale
      // sleeper on the map and re-spawns every finished run on reconcile.
      if (isSub && !sa && !row.active) return;
      const la = sa?.lastActivity || null;
      const agent: MeshAgent = {
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
      // Token usage drives the HUD's TOKENS / HR readout.
      const tok = Number(row.totalTokens ?? (Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0)));
      if (Number.isFinite(tok) && tok > 0) agent.totalTokens = tok;
      if (la && typeof la === "object") {
        (agent as any).lastActivityKind = (la as any).kind;
        agent.lastActivity = la;
        agent.lastActivityAt = asEpochMs((la as any).at || (la as any).timestamp || (la as any).ts);
      }
      withRunMeta(agent, sa);
      seenKeys.add(key);
      agents.push(agent);
    });

    subs.forEach((sa: any) => {
      const key = keyOf(sa);
      if (!key || seenKeys.has(key)) return;
      const agent = toAgent(sa);
      if (agent) {
        seenKeys.add(key);
        agents.push(agent);
      }
    });

    return { nodes, agents };
  }

  /** Initial fill — emit upsert/spawn for everything currently present. */
  private async snapshot(): Promise<void> {
    if (this.destroyed) return;
    const { nodes, agents } = await this.fetchState();
    const events: WorldEvent[] = [];
    for (const node of nodes) {
      this.knownNodes.set(node.id, node);
      events.push({ kind: "node.upsert", node });
    }
    const now = Date.now();
    for (const agent of agents) {
      // Runs that already finished (still inside the list's grace window) join
      // the resting ring instead of popping on just to leave.
      if (isTerminalStatus(agent.status)) {
        if (!this.resting.has(agent.sessionKey)) {
          this.resting.add(restingEntryOf(agent, agent.status !== "failed", now));
        }
        continue;
      }
      // Alive again — it's no longer a resting finished run.
      this.resting.remove(agent.sessionKey);
      this.knownAgents.set(agent.sessionKey, agent);
      events.push({ kind: "agent.spawn", agent });
    }
    // Repopulate the rest area (oldest first, so the engine's own finished
    // order matches the ring's).
    for (const entry of this.resting.list().reverse()) {
      events.push({ kind: "agent.spawn", agent: restingAgentOf(entry) });
    }
    if (events.length) this.enqueue(events);
  }

  /**
   * A live agent finished: emit the completion and move it into the resting
   * ring (evicting the oldest resting run past the cap). Unknown keys that
   * were never on the map just get the plain completion event (engine no-ops)
   * so a stray lifecycle event can't conjure a sleeper; repeat completions of
   * an already-resting key are dropped (no re-animation churn).
   */
  private finishAgent(
    key: string,
    success: boolean,
    out: WorldEvent[],
    message?: string,
    latest?: MeshAgent,
  ): void {
    if (this.resting.has(key)) return;
    const last = latest ?? this.knownAgents.get(key);
    this.knownAgents.delete(key);
    out.push({ kind: "agent.complete", sessionKey: key, success, message });
    if (!last) return;
    const evicted = this.resting.add(restingEntryOf(last, success, Date.now()));
    for (const k of evicted) out.push({ kind: "agent.leave", sessionKey: k });
  }

  /** Slow self-heal: diff against last-known sets, emit only deltas. */
  private async reconcile(): Promise<void> {
    if (this.destroyed) return;
    const { nodes, agents } = await this.fetchState();
    const events: WorldEvent[] = [];

    // Nodes.
    const nodeIds = new Set<string>();
    for (const node of nodes) {
      nodeIds.add(node.id);
      const prev = this.knownNodes.get(node.id);
      if (!prev || prev.status !== node.status || prev.name !== node.name) {
        this.knownNodes.set(node.id, node);
        events.push({ kind: "node.upsert", node });
      } else {
        this.knownNodes.set(node.id, node);
      }
    }
    for (const id of Array.from(this.knownNodes.keys())) {
      if (!nodeIds.has(id)) {
        this.knownNodes.delete(id);
        events.push({ kind: "node.remove", nodeId: id });
      }
    }

    // Agents.
    const agentKeys = new Set<string>();
    for (const agent of agents) {
      const prev = this.knownAgents.get(agent.sessionKey);
      // Never-seen finished runs stay off; resting ones are already parked.
      if (!prev && isTerminalStatus(agent.status)) continue;
      if (prev && isTerminalStatus(agent.status)) {
        this.finishAgent(agent.sessionKey, agent.status !== "failed", events, undefined, {
          ...prev,
          ...agent,
        });
        continue;
      }
      agentKeys.add(agent.sessionKey);
      this.knownAgents.set(agent.sessionKey, agent);
      if (!prev) {
        // A resting finished run that went active again wakes in place (the
        // viz updates the existing sprite rather than re-adding it).
        this.resting.remove(agent.sessionKey);
        events.push({ kind: "agent.spawn", agent });
      } else if (
        prev.nodeId !== agent.nodeId ||
        prev.status !== agent.status ||
        prev.progress !== agent.progress ||
        prev.activityLabel !== agent.activityLabel ||
        prev.currentTask !== agent.currentTask ||
        prev.lastActivityAt !== agent.lastActivityAt ||
        prev.currentCheckpoint !== agent.currentCheckpoint ||
        prev.lastUpdateAt !== agent.lastUpdateAt ||
        (prev as any).lastActivityKind !== (agent as any).lastActivityKind
      ) {
        // The patch carries the full agent (incl. `nodeId`). When the node
        // changed — e.g. a live `subagent.spawned` broadcast for a cross-node
        // run arrived without an origin `nodeId` (so it defaulted to local)
        // and the authoritative `sessions.list`, now backed by the federation
        // remote-session registry, attributes it to its real node — the engine's
        // `updateAgent` detects the new `nodeId` and walks the sprite to the
        // correct island.
        events.push({
          kind: "agent.progress",
          sessionKey: agent.sessionKey,
          patch: agent,
        });
        const tool = toolOf(agent);
        if (tool) {
          events.push({ kind: "agent.tool", sessionKey: agent.sessionKey, tool });
        }
      } else if (prev.totalTokens !== agent.totalTokens) {
        // Usage-only change: patch the token total without re-firing a tool beat.
        events.push({
          kind: "agent.progress",
          sessionKey: agent.sessionKey,
          patch: { totalTokens: agent.totalTokens },
        });
      }
    }
    for (const key of Array.from(this.knownAgents.keys())) {
      if (!agentKeys.has(key)) {
        const last = this.knownAgents.get(key);
        this.finishAgent(key, last?.status !== "failed", events);
      }
    }

    if (events.length) this.enqueue(events);
  }

  // ──────────────────────── live stream ────────────────────────

  private onFrame(evt: GatewayEventFrame): void {
    if (this.destroyed) return;
    // THE TOPIC IS IN evt.event (a string); DATA IS IN evt.payload.
    const topic = typeof evt.event === "string" ? evt.event : "";
    if (!topic) return;
    this.sawEvent = true;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    const events: WorldEvent[] = [];
    this.mapTopic(topic, evt.payload, events);
    if (events.length) this.enqueue(events);
  }

  /** Map one raw topic + payload into zero or more WorldEvents. */
  private mapTopic(topic: string, payload: unknown, out: WorldEvent[]): void {
    const p: any = payload ?? {};

    switch (topic) {
      // Federation event bus arrives wrapped: { type:"federation.event", event: FederationEvent }
      case "federation.event": {
        const inner = p?.event;
        if (inner && typeof inner.type === "string") {
          this.mapTopic(inner.type, inner.payload ?? {}, out);
        }
        return;
      }

      // ── Subagent lifecycle (broadcast directly) ──
      case "subagent.spawned":
      case "session.spawned": {
        const agent = toAgent(p);
        if (agent) {
          this.resting.remove(agent.sessionKey); // respawned → wake
          this.knownAgents.set(agent.sessionKey, agent);
          out.push({ kind: "agent.spawn", agent });
        }
        return;
      }
      case "subagent.complete":
      case "subagent.error":
      case "subagent.timeout":
      case "session.completed":
      case "session.complete": {
        const key = keyOf(p);
        if (!key) return;
        const success =
          topic === "subagent.complete" ||
          topic === "session.completed" ||
          topic === "session.complete" ||
          p?.ok === true ||
          p?.outcome?.status === "ok";
        this.finishAgent(
          key,
          !!success && topic !== "subagent.error" && topic !== "subagent.timeout",
          out,
          asString(p?.outcome?.error || p?.error || p?.reason) || undefined,
        );
        return;
      }

      // ── Progress / tool activity ──
      case "session.progress":
      case "progress": {
        const key = keyOf(p);
        if (!key) return;
        const patch: Partial<MeshAgent> = {};
        if (p?.status !== undefined) patch.status = normalizeStatus(p.status, true);
        if (p?.progress !== undefined) patch.progress = Number(p.progress) || 0;
        if (p?.label !== undefined) patch.label = asString(p.label);
        if (p?.currentTask !== undefined || p?.task !== undefined) {
          patch.currentTask = asString(p.currentTask || p.task) || undefined;
        }
        patch.lastUpdateAt = asEpochMs(p?.lastUpdateAt || p?.updatedAt || p?.ts) ?? Date.now();
        const activityAt = asEpochMs(p?.lastActivity?.at || p?.lastActivity?.timestamp || p?.lastActivity?.ts);
        if (activityAt) patch.lastActivityAt = activityAt;
        if (p?.lastActivity && typeof p.lastActivity === "object") patch.lastActivity = p.lastActivity;
        if (p?.currentCheckpoint !== undefined || p?.checkpoint !== undefined) {
          patch.currentCheckpoint = asString(p.currentCheckpoint || p.checkpoint) || undefined;
        }
        if (p?.model !== undefined || p?.modelId !== undefined) {
          patch.model = asString(p.model || p.modelId) || undefined;
        }
        {
          // Plugin tag on the run/phase/goal (`plugin` / `pluginId`, or a
          // `plugin:<id>` tag) → the map routes the agent to that plugin's room.
          const pid = pluginIdOf(p);
          if (pid) patch.pluginId = pid;
        }
        {
          // Late backend stamp: if the run only learns its CLI mid-stream,
          // patch the sprite badge (AgentRoom.update handles coderBackend).
          const backend = coderBackendOf(p);
          if (backend) patch.coderBackend = backend;
        }
        // Update known set so reconcile diffs stay accurate.
        const prev = this.knownAgents.get(key);
        if (prev) this.knownAgents.set(key, { ...prev, ...patch } as MeshAgent);
        // A late terminal progress frame for an already-resting run must not
        // re-route / re-bump the parked sprite.
        if (!prev && patch.status && isTerminalStatus(patch.status) && this.resting.has(key)) {
          delete patch.status;
        }
        if (
          !prev &&
          patch.status &&
          !isTerminalStatus(patch.status) &&
          this.resting.has(key)
        ) {
          // A resting finished run resumed — wake it back into the live set.
          const entry = this.resting.list().find((e) => e.sessionKey === key);
          this.resting.remove(key);
          if (entry) this.knownAgents.set(key, { ...restingAgentOf(entry), ...patch } as MeshAgent);
        }
        out.push({ kind: "agent.progress", sessionKey: key, patch });
        const tool = toolOf(p);
        if (tool) out.push({ kind: "agent.tool", sessionKey: key, tool });
        if (prev && patch.status && isTerminalStatus(patch.status)) {
          this.finishAgent(key, patch.status !== "failed", out);
        }
        return;
      }

      // Native subagent tool stream: broadcast("agent", {sessionKey, stream:"tool", data:{name,phase}})
      case "agent": {
        if (p?.stream !== "tool") return;
        const key = keyOf(p);
        if (!key) return;
        const name = p?.data?.name;
        if (typeof name !== "string" || !name) return;
        out.push({
          kind: "agent.tool",
          sessionKey: key,
          tool: { kind: name.toLowerCase(), label: name },
        });
        return;
      }

      // ── Nodes ──
      case "node.connected":
      case "node.status": {
        const id = asString(p?.nodeId);
        if (!id) return;
        const node: MeshNode = {
          id,
          name: resolveNodeDisplayName(id, asString(p?.name || p?.nodeName, id)),
          role: p?.role === "hub" ? "hub" : "satellite",
          status: p?.connected === false ? "offline" : "online",
          agentCount: this.knownNodes.get(id)?.agentCount ?? 0,
          capabilities: Array.isArray(p?.capabilities) ? p.capabilities : undefined,
        };
        this.knownNodes.set(id, node);
        out.push({ kind: "node.upsert", node });
        return;
      }
      case "node.disconnected": {
        const id = asString(p?.nodeId);
        if (!id) return;
        this.knownNodes.delete(id);
        out.push({ kind: "node.remove", nodeId: id });
        return;
      }

      // ── Inter-agent messages ──
      case "mesh.message":
      case "session.message": {
        const from = asString(p?.from || p?.fromSessionKey || p?.source);
        const to = asString(p?.to || p?.toSessionKey || p?.target);
        if (!from || !to) return;
        const rawType = asString(p?.type || p?.payload?.type);
        const type: "request" | "response" | "broadcast" =
          rawType === "response" ? "response" : rawType === "broadcast" ? "broadcast" : "request";
        out.push({ kind: "agent.message", from, to, type });
        return;
      }

      // ── Tasks ──
      case "task.created": {
        const id = asString(p?.id || p?.taskId, String(Date.now()));
        const title = asString(p?.title || p?.label || p?.name, "TASK");
        out.push({
          kind: "task.ingest",
          id,
          title,
          nodeId: asString(p?.nodeId) || undefined,
          priority: asString(p?.priority) || undefined,
        });
        return;
      }

      // ── Heartbeat → period tick ──
      case "heartbeat": {
        out.push({ kind: "period.tick", epochMs: Number(p?.ts || p?.epochMs) || Date.now() });
        return;
      }

      default:
        // New federation/SSH event sources (Part 2/3) are routed through
        // dedicated mappers. They no-op for unknown topics, so a missing
        // server-side emitter never affects existing behaviour. Wrapped in
        // try/catch so a malformed payload can't crash the frame handler.
        try {
          this.mapFederationTopic(topic, p, out);
          this.mapSshTopic(topic, p, out);
        } catch (err) {
          console.warn("[agency-bridge] fed/ssh map error:", err);
        }
        return;
    }
  }

  /**
   * Federation messaging topics (Part 2). A separate codex agent emits these
   * on the gateway; if they never arrive this method simply never matches.
   * Both the direct topic and the `federation.event`-wrapped form land here
   * (mapTopic recurses the wrapper into this same switch).
   */
  private mapFederationTopic(topic: string, p: any, out: WorldEvent[]): void {
    switch (topic) {
      case "federation.message.sent": {
        const fromNodeId = asString(p?.fromNodeId || p?.from);
        const toNodeId = asString(p?.toNodeId || p?.to);
        const msgId = asString(p?.msgId || p?.id, String(p?.ts || ""));
        if (!fromNodeId || !toNodeId) return;
        out.push({
          kind: "fed.msg.send",
          fromNodeId,
          toNodeId,
          messageType: asString(p?.messageType || p?.type, "event"),
          msgId,
        });
        return;
      }
      case "federation.message.delivered": {
        const msgId = asString(p?.msgId || p?.id);
        if (!msgId) return;
        out.push({
          kind: "fed.msg.ack",
          fromNodeId: asString(p?.fromNodeId || p?.from),
          toNodeId: asString(p?.toNodeId || p?.to),
          msgId,
          latencyMs: Number(p?.latencyMs) || undefined,
        });
        return;
      }
      case "federation.message.failed": {
        const msgId = asString(p?.msgId || p?.id);
        if (!msgId) return;
        out.push({
          kind: "fed.msg.fail",
          fromNodeId: asString(p?.fromNodeId || p?.from),
          toNodeId: asString(p?.toNodeId || p?.to),
          msgId,
          reason: asString(p?.reason || p?.error) || undefined,
        });
        return;
      }
      case "federation.peer.connected": {
        const peerNodeId = asString(p?.peerNodeId || p?.nodeId);
        if (peerNodeId) out.push({ kind: "fed.peer.connect", peerNodeId });
        return;
      }
      case "federation.peer.disconnected": {
        const peerNodeId = asString(p?.peerNodeId || p?.nodeId);
        if (peerNodeId) out.push({ kind: "fed.peer.disconnect", peerNodeId });
        return;
      }
      default:
        return;
    }
  }

  /** SSH connection topics (Part 3). Same graceful-no-op contract as above. */
  private mapSshTopic(topic: string, p: any, out: WorldEvent[]): void {
    switch (topic) {
      case "ssh.connection.opened": {
        const deviceId = asString(p?.deviceId || p?.id);
        if (!deviceId) return;
        out.push({ kind: "ssh.connection.opened", deviceId, host: asString(p?.host, deviceId) });
        return;
      }
      case "ssh.connection.closed": {
        const deviceId = asString(p?.deviceId || p?.id);
        if (!deviceId) return;
        out.push({
          kind: "ssh.connection.closed",
          deviceId,
          host: asString(p?.host, deviceId),
          durationMs: Number(p?.durationMs) || undefined,
        });
        return;
      }
      case "ssh.command.executed": {
        const deviceId = asString(p?.deviceId || p?.id);
        if (!deviceId) return;
        out.push({
          kind: "ssh.command.executed",
          deviceId,
          host: asString(p?.host, deviceId),
          command: asString(p?.command),
          exitCode: Number(p?.exitCode) || 0,
          durationMs: Number(p?.durationMs) || undefined,
        });
        return;
      }
      case "ssh.connection.error": {
        const deviceId = asString(p?.deviceId || p?.id);
        if (!deviceId) return;
        out.push({
          kind: "ssh.connection.error",
          deviceId,
          host: asString(p?.host, deviceId),
          error: asString(p?.error) || undefined,
        });
        return;
      }
      default:
        return;
    }
  }

  // ──────────────────────── batching ────────────────────────

  private enqueue(events: WorldEvent[]): void {
    if (this.destroyed || !events.length) return;
    for (const e of events) this.queue.push(e);

    // Coalesce to one flush per animation frame.
    if (this.rafId === null && typeof requestAnimationFrame === "function") {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.flush();
      });
    }
    // 200ms safety debounce in case rAF is throttled (hidden tab) or absent.
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 200);
    }
  }

  private flush(): void {
    if (this.destroyed) return;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    for (const cb of this.subscribers) {
      try {
        cb(batch);
      } catch (err) {
        console.error("[agency-bridge] subscriber error:", err);
      }
    }
  }
}
