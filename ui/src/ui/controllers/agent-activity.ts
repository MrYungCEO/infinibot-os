/**
 * Agent Activity Controller — real-time monitoring of all running agents/sub-agents.
 * Polls sessions.list + sessions.preview to build a live activity feed.
 * Persists activity history to localStorage for continuity across page refreshes.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Types ────────────────────────────────────────────────────

export interface AgentStep {
  type: "text" | "tool_call" | "tool_result" | "thinking" | "spawn" | "error" | "user";
  timestamp: number;
  /** For text: the content. For tool_call: the tool name. */
  content: string;
  /** For tool_call: arguments summary. For tool_result: result preview. */
  detail?: string;
  /** Tool call ID for linking calls to results. */
  toolCallId?: string;
  /** Model that generated this step. */
  model?: string;
  /** Token usage for this step. */
  usage?: { input?: number; output?: number; total?: number };
  /** Role from the original message */
  role?: string;
}

export interface AgentSession {
  key: string;
  agentId: string;
  agentName: string;
  sessionId?: string;
  kind: "main" | "subagent" | "other";
  /** Task or label if available. */
  label?: string;
  /** Display name (label or derived). */
  displayName?: string;
  /** Derived title from first user message (usually the task prompt for sub-agents). */
  derivedTitle?: string;
  /** Last message preview from sessions.list. */
  lastMessagePreview?: string;
  /** Who spawned this session (parent agent key). */
  spawnedBy?: string;
  channel?: string;
  /**
   * origin.surface from the session store entry. MCP-registered Claude Code
   * sessions get { provider: "mcp", surface: "claude-code" }. Lets the UI
   * classify them as Claude Coder runs even when displayName is the generic
   * "MCP · <last 12>" label.
   */
  originSurface?: string;
  originProvider?: string;
  /**
   * Coder backend that produced this row, when applicable.
   * "claude-code" | "opencode" | "codex". Set by claude-coder-tool at
   * spawn time; the activity feed uses it to pick a per-backend logo
   * and accent colour without grepping displayName.
   */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** Federation node display name this session is running on. "local" or absent = this host. */
  node?: string;
  /** Stable federation node id (matches `federationNodes[].id`) for filtering / colour-mapping. */
  nodeId?: string;
  /** True when this session is running on a remote federation node. */
  remote?: boolean;
  model?: string;
  /** Is this session currently processing (has recent activity)? */
  active: boolean;
  /** When last updated. */
  updatedAt: number | null;
  /** Set to true when completion was signaled by a gateway chat event (not timeout). */
  completedViaEvent?: boolean;
  /** Completion state from the gateway event: "done" or "error". */
  completionState?: "done" | "error";
  /** Token usage. */
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  /** Activity steps (most recent first). */
  steps: AgentStep[];
  /** Is expanded in the UI? */
  expanded: boolean;
  /** Is loading history? */
  loadingHistory: boolean;
  /** Has full preview been loaded? */
  previewLoaded: boolean;
  /** Timestamp of last live WS tool event. Drives streaming-vs-background classification. */
  lastLiveEventAt?: number;
}

export interface AgentActivityState {
  sessions: AgentSession[];
  loading: boolean;
  error: string | null;
  /** Auto-refresh interval ID. */
  pollIntervalId: number | null;
  /** How many seconds between polls. */
  pollInterval: number;
  /** Filter: show only active sessions? */
  showActiveOnly: boolean;
  /** Filter: show only subagent sessions? */
  showSubagentsOnly: boolean;
  /** Filter: show only Claude Coder runs? */
  showCoderOnly: boolean;
  /** Session key of the detail panel. */
  detailKey: string | null;
  /** Last poll timestamp (attempt). */
  lastPollAt: number | null;
  /** Spawn notifications. */
  spawnNotifications: SpawnNotification[];
  /** Track whether initial previews have been loaded. */
  initialPreviewsLoaded: boolean;
  /** Mesh messages from cross-node agent communication */
  meshMessages: MeshMessage[];
  /** Last mesh message fetch timestamp */
  lastMeshFetchAt: number | null;
  /**
   * Unsubscribe handle for the live "agent" event subscription. Set in
   * startActivityPolling; cleared in stopActivityPolling. Without this the
   * activity feed would only update on the poll interval (3–30 s) and would
   * never see streamed tool calls from MCP-driven Claude Code instances
   * between polls.
   */
  unsubscribeAgentEvents?: () => void;
  // ── Hardening additions ────────────────────────────────────
  /**
   * Background-refresh flag. Distinct from `loading` (initial / manual)
   * so the UI doesn't flicker a spinner on every poll tick.
   */
  refreshing: boolean;
  /** Last *successful* poll timestamp. Drives the "last updated" badge. */
  lastSuccessAt: number | null;
  /** Last failed poll timestamp. */
  lastErrorAt: number | null;
  /**
   * Count of consecutive failed polls. Resets to 0 on success. UI can use
   * this to escalate from a soft "retrying" hint to a hard error banner.
   */
  consecutiveFailures: number;
  /**
   * True when the tab is hidden (document.visibilityState === "hidden")
   * AND we've paused the interval. Resumed automatically on visibility
   * change. UI surfaces a "paused" pill so users know why the feed isn't
   * moving.
   */
  paused: boolean;
  /**
   * Per-session last-seen event sequence number. Lets `handleLiveAgentEvent`
   * dedup re-broadcasts and drop out-of-order events without doubling up
   * tool_call / tool_result rows.
   */
  lastSeenSeqByKey: Record<string, number>;
  /**
   * Quarantine queue for live tool events whose `sessionKey` hasn't been
   * seen yet (the parent session hasn't been polled in). Each entry has a
   * TTL (10 s default); after that they're discarded silently. On every
   * `loadAgentActivity` success we drain the queue against the new
   * session list so previously-orphaned events get replayed in order.
   */
  orphanedEvents: Array<{ payload: AgentBroadcastPayload; queuedAt: number }>;
  /**
   * Bound `visibilitychange` handler, kept so we can detach it in
   * `stopActivityPolling`.
   */
  visibilityHandler?: () => void;
  /** Gateway client cached for visibility-driven refresh. */
  cachedClient?: GatewayBrowserClient;
  /** Session keys manually pinned to the Live Agents section. Session-scoped (in-memory). */
  pinnedToLive: Set<string>;
  /** Session keys manually pinned to the Background Tasks section. Session-scoped (in-memory). */
  pinnedToBackground: Set<string>;
  /** Whether the Background Tasks section is collapsed. Persisted to localStorage. */
  bgCollapsed: boolean;

  // ── Focused chat modal ────────────────────────────────────────
  /** Session key currently shown in the focused-chat modal (null = closed). */
  modalKey: string | null;
  /** Full transcript steps loaded for the modal. */
  modalSteps: AgentStep[];
  /** True while fetching the modal transcript from sessions.preview. */
  modalLoading: boolean;
  /** True while a send is in-flight (waiting for first stream event or final). */
  modalSending: boolean;
  /** Current composer draft text. */
  modalDraft: string;
  /** Accumulated text from live WS chat delta events. */
  modalStream: string | null;
  /** Last send / resume error. */
  modalError: string | null;
  /** If true, all tool-call cards are expanded. */
  modalShowAllTools: boolean;
  /** WS unsubscribe handle — torn down on modal close. */
  modalUnsubscribe?: () => void;
}

export interface SpawnNotification {
  id: string;
  agentId: string;
  parentAgent: string;
  task: string;
  timestamp: number;
  dismissed: boolean;
}

/** Mesh message from cross-node agent communication */
export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  type: "request" | "response" | "broadcast" | "event";
  payload: {
    action?: string;
    message?: string;
    data?: Record<string, unknown>;
    priority?: string;
  };
  timestamp: number;
  delivered: boolean;
  read: boolean;
  sourceNodeId?: string;
}

// ── localStorage Persistence ─────────────────────────────────

const STORAGE_KEY = "infinibot-activity-history";
const MAX_STORED_SESSIONS = 30;
const MAX_STORED_STEPS_PER_SESSION = 30;

interface StoredSession {
  key: string;
  agentId: string;
  kind: "main" | "subagent" | "other";
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  model?: string;
  updatedAt: number | null;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  steps: AgentStep[];
}

function saveActivityToStorage(sessions: AgentSession[]): void {
  try {
    const stored: StoredSession[] = sessions.slice(0, MAX_STORED_SESSIONS).map((s) => ({
      key: s.key,
      agentId: s.agentId,
      kind: s.kind,
      label: s.label,
      derivedTitle: s.derivedTitle,
      lastMessagePreview: s.lastMessagePreview,
      channel: s.channel,
      model: s.model,
      updatedAt: s.updatedAt,
      totalTokens: s.totalTokens,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      steps: s.steps.slice(0, MAX_STORED_STEPS_PER_SESSION),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now(), sessions: stored }));
  } catch {
    // Storage full or not available — silently skip
  }
}

function loadActivityFromStorage(): StoredSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Discard if older than 24h
    if (parsed.ts && Date.now() - parsed.ts > 86400000) {
      localStorage.removeItem(STORAGE_KEY);
      return [];
    }
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

// ── Init ─────────────────────────────────────────────────────

export function createInitialActivityState(): AgentActivityState {
  return {
    sessions: [],
    loading: false,
    error: null,
    pollIntervalId: null,
    pollInterval: 5,
    showActiveOnly: false,
    showSubagentsOnly: false,
    showCoderOnly: false,
    detailKey: null,
    lastPollAt: null,
    spawnNotifications: [],
    initialPreviewsLoaded: false,
    meshMessages: [],
    lastMeshFetchAt: null,
    refreshing: false,
    lastSuccessAt: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    paused: false,
    lastSeenSeqByKey: {},
    orphanedEvents: [],
    pinnedToLive: new Set<string>(),
    pinnedToBackground: new Set<string>(),
    bgCollapsed: (() => {
      try { return localStorage.getItem("infinibot-activity-bg-collapsed") === "1"; } catch { return false; }
    })(),
    modalKey: (() => { try { return localStorage.getItem("infinibot-activity-modal") || null; } catch { return null; } })(),
    modalSteps: [],
    modalLoading: false,
    modalSending: false,
    modalDraft: "",
    modalStream: null,
    modalError: null,
    modalShowAllTools: false,
  };
}

/** TTL for orphaned tool events that arrive before their session is polled. */
const ORPHAN_TTL_MS = 10_000;
/** Drop mesh messages older than this on every merge. Prevents unbounded growth. */
const MESH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────

function parseAgentId(
  key: string,
  hint?: {
    displayName?: string;
    label?: string;
    sessionId?: string;
    originSurface?: string;
    originProvider?: string;
    coderBackend?: string;
  },
): { agentId: string; kind: "main" | "subagent" | "other" } {
  // Claude-coder runs use parent-prefixed keys (`agent:main:subagent:UUID`),
  // so we'd otherwise classify them as "main" — masking the coder identity
  // and breaking the CODER filter / terminal card on the activity page.
  // Detect them here so downstream colour/label/filter logic gets the right id.
  const isCoderByHint =
    Boolean(hint?.coderBackend) ||
    hint?.displayName?.startsWith("Claude Coder") ||
    hint?.displayName?.startsWith("OpenCode") ||
    hint?.displayName?.startsWith("Codex") ||
    hint?.label?.startsWith("Claude Coder") ||
    hint?.sessionId?.startsWith("coder-");
  if (isCoderByHint) {
    return { agentId: "claude-code", kind: "subagent" };
  }
  // Terminal-spawned Claude Code sessions register with origin
  // { provider: "terminal", surface: "claude" } and a key shaped like
  // `agent:main:terminal-<id>` (see server-methods/terminal.ts). Without
  // this branch they get classified under agentId "main" and miss the
  // Claude Coder filter on the activity page.
  if (hint?.originProvider === "terminal" && hint?.originSurface === "claude") {
    return { agentId: "claude-code", kind: "main" };
  }
  const parts = key.split(":");
  if (parts[0] === "agent") {
    const agentId = parts[1] || "unknown";
    const isSubagent = parts[2] === "subagent" || key.includes("subagent");
    return { agentId, kind: isSubagent ? "subagent" : agentId === "main" ? "main" : "other" };
  }
  if (parts[0] === "claude-code") {
    return { agentId: "claude-code", kind: "main" };
  }
  return { agentId: "unknown", kind: "other" };
}

/**
 * Status values from `subagents.list` that mean a run is genuinely in-flight.
 * Everything else (completed / finishing / error / timeout / cancelled / failed)
 * is terminal and must NOT render as a running agent. Kept permissive on the
 * live side so a new progress status doesn't silently drop a real agent.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "complete",
  "finishing",
  "finished",
  "done",
  "error",
  "failed",
  "timeout",
  "timed_out",
  "cancelled",
  "canceled",
  "interrupted",
]);
function isLiveRunStatus(status: string | undefined): boolean {
  if (!status) return true; // no status yet → assume just-spawned / live
  return !TERMINAL_RUN_STATUSES.has(status.toLowerCase());
}

function agentDisplayName(agentId: string): string {
  const names: Record<string, string> = {
    main: "🔥 Infini (Main)",
    webdev: "🏗️ Architect",
    qa: "🔍 Inspector",
    coder: "💻 Code Architect",
    opus: "🧠 Deep Thinker",
    "claude-code": "🤖 Claude Code",
  };
  return names[agentId] || `🤖 ${agentId}`;
}

/**
 * True if this session is a Claude Coder run.
 *
 * Detection sources (each is a strong signal on its own):
 *   1. agentId === "claude-code"               (explicit agent id)
 *   2. displayName "Claude Coder: ..."          (spawned via claude-coder-tool)
 *   3. label "Claude Coder: ..."                (same)
 *   4. key prefix "claude-code:"                (registered by claude-code-watcher)
 *   5. sessionId prefix "coder-"                (legacy)
 *   6. origin.surface === "claude-code"         (registered by autoRegisterMcpSession —
 *                                                 external Claude Code CLI using InfiniBot MCP)
 *   7. channel === "claude-code"                (set by claude-code-watcher)
 *   8. origin { provider: "terminal", surface: "claude" }
 *                                              (terminal.create handler for a Claude
 *                                                CLI terminal — registered with the
 *                                                short surface "claude", not "claude-code")
 */
export function isClaudeCoder(session: {
  agentId?: string;
  displayName?: string;
  label?: string;
  key?: string;
  sessionId?: string;
  channel?: string;
  originSurface?: string;
  originProvider?: string;
  coderBackend?: string;
}): boolean {
  // Authoritative: row.coderBackend is set at spawn time for every CLI backend
  // (claude-code, opencode, codex). Checked before the string-prefix heuristics
  // so OpenCode / Codex runs aren't missed just because their displayName no
  // longer starts with "Claude Coder".
  if (session.coderBackend) return true;
  if (session.agentId === "claude-code") return true;
  if (session.displayName?.startsWith("Claude Coder")) return true;
  if (session.displayName?.startsWith("OpenCode")) return true;
  if (session.displayName?.startsWith("Codex")) return true;
  if (session.label?.startsWith("Claude Coder")) return true;
  if (session.key?.startsWith("claude-code:")) return true;
  if (session.sessionId?.startsWith("coder-")) return true;
  if (session.originSurface === "claude-code") return true;
  if (session.channel === "claude-code") return true;
  if (session.originProvider === "terminal" && session.originSurface === "claude") return true;
  return false;
}

/**
 * Convert sessions.preview items into AgentStep objects.
 * Preview items have: { role, text, ts, model? }
 */
function previewItemsToSteps(items: any[]): AgentStep[] {
  const steps: AgentStep[] = [];
  for (const item of items) {
    if (!item) continue;
    const timestamp = item.ts || Date.now();
    const text = item.text || item.content || "";
    if (!text) continue;

    // Detect tool calls/results from text patterns
    let type: AgentStep["type"] = "text";
    let content = text;
    let detail: string | undefined;

    if (item.role === "user") {
      type = "user";
    } else if (item.role === "tool" || item.role === "tool_result") {
      type = "tool_result";
    } else if (item.role === "assistant") {
      // Try to detect tool calls from preview text
      if (text.startsWith("⚡ ") || text.match(/^Tool: /)) {
        type = "tool_call";
        const match = text.match(/^(?:⚡|Tool:)\s*(\S+)\s*(.*)/s);
        if (match) {
          content = match[1];
          detail = match[2] || undefined;
        }
      } else {
        type = "text";
      }
    }

    steps.push({
      type,
      timestamp,
      content,
      detail,
      model: item.model,
      role: item.role,
    });
  }
  return steps;
}

// ── API Functions ────────────────────────────────────────────

/**
 * Resolve the set of federation peers worth fanning the activity feed
 * out to. Prefers the cached list under `terminalsState.federationNodes`
 * (populated by `loadFederationNodes`); falls back to a one-shot
 * `federation.nodes.list` if that cache is empty. Filters out the local
 * device + any peer flagged offline.
 *
 * Returns just `{id, name}` so callers can tag rows with a stable node
 * identity for the badge UI.
 */
async function fetchFederationPeers(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<Array<{ id: string; name: string }>> {
  const ts = state.terminalsState;
  const cached = (ts?.federationNodes ?? []) as Array<{
    id: string;
    name?: string;
    isLocal?: boolean;
    online?: boolean;
  }>;
  let pool = cached;
  if (pool.length === 0) {
    try {
      const r = (await client.request("federation.nodes.list", {})) as
        | { nodes?: Array<{ id: string; name?: string; isLocal?: boolean; status?: string }> }
        | undefined;
      pool = (r?.nodes ?? []).map((n) => ({
        id: n.id,
        name: n.name,
        isLocal: !!n.isLocal,
        online: n.status !== "offline",
      }));
    } catch {
      pool = [];
    }
  }
  return pool
    .filter((n) => !n.isLocal && n.online !== false && typeof n.id === "string" && n.id.length > 0)
    .map((n) => ({ id: n.id, name: n.name ?? n.id }));
}

export async function loadAgentActivity(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: { silent?: boolean } = {},
): Promise<void> {
  const as = state.agentActivityState;
  if (!as) return;

  // Distinguish initial / manual load (which can flash a spinner) from
  // background poll ticks (which must not). Either way we track an
  // attempt timestamp + clear stale error state opportunistically.
  if (opts.silent) {
    as.refreshing = true;
  } else {
    as.loading = true;
  }
  as.lastPollAt = Date.now();

  try {
    // Load from localStorage first (for instant display)
    const stored = loadActivityFromStorage();
    const storedMap = new Map(stored.map((s) => [s.key, s]));

    // Get all sessions with previews. `includeFederated` asks a master
    // gateway to enrich rows with node info before returning them.
    const res = (await client.request("sessions.list", {
      activeMinutes: 1440, // Last 24h
      limit: 50,
      includeLastMessage: true,
      includeDerivedTitles: true,
      includeFederated: true,
    })) as any;

    // ── Cross-node aggregation ───────────────────────────────────
    // When running on a satellite UI, the local sessions.list above
    // only sees this device's sessions. Fan out to every connected
    // federation peer (master + sibling satellites) and merge their
    // sessions in, tagging each row with the originating node so the
    // activity feed reads as a single unified mesh view rather than a
    // per-device sliver.
    try {
      const fedNodes = await fetchFederationPeers(state, client);
      if (fedNodes.length > 0) {
        const remoteRows = await Promise.all(
          fedNodes.map(async (node) => {
            try {
              const r = (await client.request("federation.node.invoke", {
                nodeId: node.id,
                method: "sessions.list",
                params: {
                  activeMinutes: 1440,
                  limit: 50,
                  includeLastMessage: true,
                  includeDerivedTitles: true,
                  includeFederated: true,
                },
              })) as { status?: string; payload?: { sessions?: any[] } } | undefined;
              if (r?.status !== "ok" || !Array.isArray(r.payload?.sessions)) return [];
              return r.payload!.sessions!.map((row) => ({
                ...row,
                // Tag every remote row with its origin node so the UI
                // badge + filter logic can light up the right device.
                // Don't clobber a node value the master already stamped.
                node: row.node ?? node.name ?? node.id,
                nodeId: row.nodeId ?? node.id,
                remote: true,
              }));
            } catch {
              return [];
            }
          }),
        );
        const merged: any[] = Array.isArray(res?.sessions) ? [...res.sessions] : [];
        const seen = new Set(merged.map((s: any) => s.key));
        for (const rows of remoteRows) {
          for (const row of rows) {
            if (!row?.key || seen.has(row.key)) continue;
            seen.add(row.key);
            merged.push(row);
          }
        }
        if (res) res.sessions = merged;
      }
    } catch (fedErr) {
      // Federation aggregation is best-effort — never block the local feed.
      console.warn("[agent-activity] federation aggregation failed:", fedErr);
    }

    if (!res?.sessions) {
      // If we have stored data, use it
      if (stored.length > 0 && as.sessions.length === 0) {
        as.sessions = stored.map((s) => ({
          ...s,
          agentName: agentDisplayName(s.agentId),
          active: false,
          expanded: false,
          loadingHistory: false,
          previewLoaded: s.steps.length > 0,
        }));
      }
      as.loading = false;
      as.refreshing = false;
      // Treat "no sessions list returned" as a soft success — the server
      // responded, just with empty data. Reset failure counter.
      as.consecutiveFailures = 0;
      as.lastSuccessAt = Date.now();
      return;
    }

    // ── Liveness ground truth ────────────────────────────────────
    // sessions.list has no concept of process liveness — it returns every
    // session record touched in the active window (24h), including terminal /
    // MCP mirror rows and coder runs that already exited. Cross-reference the
    // subagent registry (subagents.list), which knows each run's real status
    // (and, after the server-side reconcile, flips dead-PID runs to failed
    // promptly). A coder / sub-agent row is only "running" when the registry
    // reports a matching run with a live status. The join is exact:
    // registry.childSessionKey === session.key.
    //
    // Best-effort: if the registry call fails we fall back to the legacy
    // time-based heuristic rather than stranding a page full of real agents.
    let liveRunKeys: Set<string> | null = null;
    try {
      const subRes = (await client.request("subagents.list", {
        compact: true,
        includeCompleted: false,
        limit: 100,
      })) as { subagents?: Array<{ sessionKey?: string; status?: string }> } | undefined;
      if (Array.isArray(subRes?.subagents)) {
        liveRunKeys = new Set(
          subRes.subagents
            .filter((s) => s?.sessionKey && isLiveRunStatus(s.status))
            .map((s) => s.sessionKey as string),
        );
      }
    } catch {
      // Registry unavailable — keep liveRunKeys null to trigger the fallback.
    }

    const prevSessions = new Map(as.sessions.map((s) => [s.key, s]));
    const newSessions: AgentSession[] = [];

    for (const row of res.sessions) {
      const { agentId, kind } = parseAgentId(row.key, {
        displayName: row.displayName,
        label: row.label,
        sessionId: row.sessionId,
        originSurface: row.origin?.surface,
        originProvider: row.origin?.provider,
        coderBackend: row.coderBackend,
      });
      const prev = prevSessions.get(row.key);
      const storedSession = storedMap.get(row.key);

      // If this session was already marked complete via a gateway event, keep it inactive.
      // This is the authoritative signal — no timeout guessing needed.
      const prevCompletedViaEvent = prev?.completedViaEvent ?? false;
      const prevCompletionState = prev?.completionState;

      // Is this row a coder / sub-agent run the registry tracks? Those get the
      // authoritative liveness gate; the gateway's own conversational sessions
      // (main / native) aren't registry runs and keep the time heuristic.
      const isRegistryBacked =
        kind === "subagent" ||
        isClaudeCoder({
          agentId,
          displayName: row.displayName,
          label: row.label,
          key: row.key,
          sessionId: row.sessionId,
          channel: row.lastChannel || row.channel,
          originSurface: row.origin?.surface,
          originProvider: row.origin?.provider,
          coderBackend: row.coderBackend,
        });

      // Active classification:
      //   • completed-via-event → never active (authoritative terminal signal).
      //   • registry-backed run, registry reachable → active iff the registry
      //     reports it live. A dead / finished run is NOT active even if its
      //     session row was touched seconds ago — this is what kills the ghosts.
      //   • otherwise (main/native, or registry unreachable) → legacy timeout.
      const activeThresholdMs = kind === "subagent" ? 600000 : 120000;
      const timeActive = row.updatedAt
        ? Date.now() - row.updatedAt < activeThresholdMs
        : false;
      const isActive = prevCompletedViaEvent
        ? false
        : isRegistryBacked && liveRunKeys
          ? liveRunKeys.has(row.key)
          : timeActive;

      // Use existing steps if we have them (from preview or storage)
      let steps: AgentStep[] = prev?.steps ?? storedSession?.steps ?? [];

      // Detect new spawns
      if (!prev && kind === "subagent") {
        as.spawnNotifications.push({
          id: `spawn-${row.key}-${Date.now()}`,
          agentId,
          parentAgent: "main",
          task: row.label || row.displayName || row.derivedTitle || row.key,
          timestamp: Date.now(),
          dismissed: false,
        });
      }

      // Coder cards default to expanded so the user can see the action stream
      // without clicking. Mirrors `isClaudeCoder`'s signal set so any source
      // that flags a session as Claude Coder opens automatically.
      const isCoderRow =
        Boolean(row.coderBackend) ||
        agentId === "claude-code" ||
        (typeof row.displayName === "string" && row.displayName.startsWith("Claude Coder")) ||
        (typeof row.displayName === "string" && row.displayName.startsWith("OpenCode")) ||
        (typeof row.displayName === "string" && row.displayName.startsWith("Codex")) ||
        (typeof row.label === "string" && row.label.startsWith("Claude Coder")) ||
        (typeof row.key === "string" && row.key.startsWith("claude-code:")) ||
        (typeof row.sessionId === "string" && row.sessionId.startsWith("coder-")) ||
        row.origin?.surface === "claude-code" ||
        row.lastChannel === "claude-code" ||
        row.channel === "claude-code" ||
        (row.origin?.provider === "terminal" && row.origin?.surface === "claude");

      newSessions.push({
        key: row.key,
        agentId,
        agentName: agentDisplayName(agentId),
        sessionId: row.sessionId,
        kind,
        label: row.label,
        displayName: row.displayName || row.label,
        derivedTitle: row.derivedTitle,
        lastMessagePreview: row.lastMessagePreview,
        spawnedBy: row.spawnedBy,
        channel: row.lastChannel || row.channel,
        originSurface: row.origin?.surface,
        originProvider: row.origin?.provider,
        coderBackend: row.coderBackend,
        node: row.node,
        nodeId: row.nodeId,
        remote: row.remote,
        model: row.model,
        active: isActive,
        updatedAt: row.updatedAt,
        totalTokens: row.totalTokens,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        contextTokens: row.contextTokens,
        steps,
        expanded: prev?.expanded ?? isCoderRow,
        loadingHistory: false,
        previewLoaded: prev?.previewLoaded ?? (steps.length > 0),
        completedViaEvent: prevCompletedViaEvent,
        completionState: prevCompletionState,
      });
    }

    // Sort: active first, then by updatedAt
    newSessions.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    as.sessions = newSessions;
    as.loading = false;
    as.refreshing = false;
    as.error = null;
    as.consecutiveFailures = 0;
    as.lastSuccessAt = Date.now();

    // Save to localStorage
    saveActivityToStorage(newSessions);

    // Drop dismissed; keep undismissed for 5 min OR until the session is
    // marked completed via gateway event — whichever happens first. Once
    // the spawn has visibly run to completion the toast is just noise.
    const completedKeys = new Set(
      newSessions.filter((s) => s.completedViaEvent).map((s) => s.key),
    );
    as.spawnNotifications = as.spawnNotifications.filter((n) => {
      if (n.dismissed) return false;
      if (Date.now() - n.timestamp >= 300000) return false;
      // Spawn id format: `spawn-${row.key}-${ts}` — peel out the row key
      // so we can match against completed sessions.
      const rowKey = n.id.replace(/^spawn-/, "").replace(/-\d+$/, "");
      if (completedKeys.has(rowKey)) return false;
      return true;
    });

    // Drain orphan events queued before their session showed up. Replays
    // them in the order they arrived so the tool_call / tool_result rows
    // appear in the right sequence.
    drainOrphanQueue(state);

    // Auto-load previews for sessions that don't have steps yet
    if (!as.initialPreviewsLoaded) {
      as.initialPreviewsLoaded = true;
      // Load previews in background for top sessions
      void loadPreviewsForSessions(state, client, newSessions.slice(0, 15));
    } else {
      // On subsequent polls, load previews for active sessions that need refresh
      const activeSessions = newSessions.filter(
        (s) => s.active || (!s.previewLoaded && (Date.now() - (s.updatedAt || 0)) < 300000),
      );
      if (activeSessions.length > 0) {
        void loadPreviewsForSessions(state, client, activeSessions);
      }
    }

    // Load mesh messages for cross-node activity
    await loadMeshMessages(state, client);
  } catch (e) {
    as.error = e instanceof Error ? e.message : String(e);
    as.loading = false;
    as.refreshing = false;
    as.lastErrorAt = Date.now();
    as.consecutiveFailures += 1;
  }
}

/**
 * Replay tool events that arrived before their owning session was known.
 * Drops entries older than `ORPHAN_TTL_MS`; for the rest, runs them
 * through `handleLiveAgentEvent` again (which will now find the session).
 */
function drainOrphanQueue(state: AppViewState): void {
  const as = state.agentActivityState;
  if (!as || as.orphanedEvents.length === 0) return;
  const now = Date.now();
  const survivors: Array<{ payload: AgentBroadcastPayload; queuedAt: number }> = [];
  // Take a snapshot first — handleLiveAgentEvent mutates the queue if a
  // session is *still* missing.
  const queue = as.orphanedEvents;
  as.orphanedEvents = [];
  for (const entry of queue) {
    if (now - entry.queuedAt > ORPHAN_TTL_MS) continue;
    const key = entry.payload.sessionKey;
    if (!key) continue;
    const session = as.sessions.find((s) => s.key === key);
    if (session) {
      // The session is now known — replay the event normally.
      applyLiveEventToSession(state, session, entry.payload);
    } else {
      survivors.push(entry);
    }
  }
  as.orphanedEvents = survivors;
}

/**
 * Batch-load previews for multiple sessions using sessions.preview.
 */
async function loadPreviewsForSessions(
  state: AppViewState,
  client: GatewayBrowserClient,
  sessions: AgentSession[],
): Promise<void> {
  const as = state.agentActivityState;
  if (!as || sessions.length === 0) return;

  // Coder runs: every action matters → fetch a wider window.
  const hasCoder = sessions.some((s) => isClaudeCoder(s));
  const keys = sessions.map((s) => s.key);

  try {
    const res = (await client.request("sessions.preview", {
      keys,
      limit: hasCoder ? 120 : 30,
      maxChars: hasCoder ? 6000 : 2000,
    })) as any;

    if (!res?.previews) return;

    let updated = false;
    for (const preview of res.previews) {
      if (preview.status !== "ok" || !preview.items?.length) continue;

      const session = as.sessions.find((s) => s.key === preview.key);
      if (!session) continue;

      const newSteps = previewItemsToSteps(preview.items);
      if (newSteps.length > 0) {
        session.steps = newSteps;
        session.previewLoaded = true;
        updated = true;
      }
    }

    if (updated) {
      saveActivityToStorage(as.sessions);
      state.requestUpdate?.();
    }
  } catch {
    // Preview fetch failed — not critical, will retry on next poll
  }
}

export async function loadSessionHistory(
  state: AppViewState,
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<void> {
  const as = state.agentActivityState;
  if (!as) return;

  const session = as.sessions.find((s) => s.key === sessionKey);
  if (!session) return;

  session.loadingHistory = true;
  state.requestUpdate?.();

  try {
    const res = (await client.request("sessions.preview", {
      keys: [sessionKey],
      limit: 80,
      maxChars: 4000,
    })) as any;

    if (res?.previews?.[0]?.items?.length) {
      const newSteps = previewItemsToSteps(res.previews[0].items);
      if (newSteps.length > 0) {
        session.steps = newSteps;
        session.previewLoaded = true;
      }
    }
    session.loadingHistory = false;
    saveActivityToStorage(as.sessions);
    state.requestUpdate?.();
  } catch {
    session.loadingHistory = false;
    state.requestUpdate?.();
  }
}

/**
 * Load mesh messages from federation for cross-node activity
 */
async function loadMeshMessages(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const as = state.agentActivityState;
  if (!as) return;
  
  try {
    const since = as.lastMeshFetchAt || Date.now() - 3600000; // Last hour if first load
    
    const res = (await client.request("federation.mesh.messages", {
      limit: 100,
      since: as.lastMeshFetchAt ? since : undefined,
    })) as { success?: boolean; messages?: MeshMessage[] };
    
    if (res?.success && res.messages) {
      // Merge new messages, avoiding duplicates
      const existingIds = new Set(as.meshMessages.map(m => m.id));
      const newMessages = res.messages.filter(m => !existingIds.has(m.id));
      
      if (newMessages.length > 0) {
        const cutoff = Date.now() - MESH_MAX_AGE_MS;
        as.meshMessages = [...newMessages, ...as.meshMessages]
          .filter((m) => m.timestamp >= cutoff)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 200); // Keep last 200 messages (already age-capped above)
      }

      as.lastMeshFetchAt = Date.now();
    }
  } catch {
    // Mesh messages are optional, don't fail the whole load
  }
}

/**
 * Get mesh messages for display
 */
export function getMeshMessages(state: AppViewState): MeshMessage[] {
  return state.agentActivityState?.meshMessages || [];
}

export function startActivityPolling(
  state: AppViewState,
  client: GatewayBrowserClient,
): void {
  const as = state.agentActivityState;
  if (!as) return;

  // Idempotent: if something's still running from a previous mount, tear
  // it down first so we don't end up with duplicate intervals + listeners.
  if (as.pollIntervalId !== null || as.unsubscribeAgentEvents || as.visibilityHandler) {
    stopActivityPolling(state);
  }

  as.cachedClient = client;

  // Load cached data immediately for instant display
  const stored = loadActivityFromStorage();
  if (stored.length > 0 && as.sessions.length === 0) {
    as.sessions = stored.map((s) => ({
      ...s,
      agentName: agentDisplayName(s.agentId),
      active: false,
      expanded: false,
      loadingHistory: false,
      previewLoaded: s.steps.length > 0,
    }));
    state.requestUpdate?.();
  }

  // Initial load is *not* silent — it sets `loading` so the UI shows a
  // first-fetch spinner. Subsequent ticks pass { silent: true } so the
  // feed doesn't flicker every poll interval.
  void loadAgentActivity(state, client).then(() => state.requestUpdate?.());

  // Re-open the focused-chat modal if the user had one open before refresh.
  if (as.modalKey) {
    void openChatModal(state, client, as.modalKey);
  }

  // If the tab starts in the background, don't kick off the interval —
  // visibilitychange will start it when the user returns.
  const startInterval = () => {
    if (as.pollIntervalId !== null) return;
    as.pollIntervalId = window.setInterval(async () => {
      await loadAgentActivity(state, client, { silent: true });
      state.requestUpdate?.();
    }, as.pollInterval * 1000);
  };
  const stopInterval = () => {
    if (as.pollIntervalId !== null) {
      window.clearInterval(as.pollIntervalId);
      as.pollIntervalId = null;
    }
  };

  const docHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  if (docHidden) {
    as.paused = true;
  } else {
    as.paused = false;
    startInterval();
  }

  // Pause when the tab is hidden, resume + force-refresh on return. Saves
  // CPU/quota and prevents the activity feed from going stale "silently"
  // because the background interval kept firing into the void.
  if (typeof document !== "undefined") {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        as.paused = true;
        stopInterval();
        state.requestUpdate?.();
      } else {
        as.paused = false;
        // Force an immediate refresh so the user sees fresh data instead
        // of waiting up to `pollInterval` seconds.
        void loadAgentActivity(state, client, { silent: true }).then(() =>
          state.requestUpdate?.(),
        );
        startInterval();
        state.requestUpdate?.();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    as.visibilityHandler = onVis;
  }

  // Live subscription: every agent tool call (including MCP-driven Claude
  // Code instances via agent.tools.invoke) broadcasts an "agent" event
  // with stream:"tool". Append it to the matching session immediately so
  // the activity feed shows real-time tool-call streams instead of
  // waiting for the next sessions.preview poll. Polling stays as the
  // source of truth for session metadata + token totals.
  if (!as.unsubscribeAgentEvents) {
    as.unsubscribeAgentEvents = client.subscribe((evt) => {
      if (evt.event !== "agent") return;
      const payload = evt.payload as AgentBroadcastPayload | undefined;
      if (!payload) return;
      handleLiveAgentEvent(state, payload);
    });
  }
}

export function stopActivityPolling(state: AppViewState): void {
  const as = state.agentActivityState;
  if (!as) return;
  if (as.pollIntervalId !== null) {
    window.clearInterval(as.pollIntervalId);
    as.pollIntervalId = null;
  }
  if (as.unsubscribeAgentEvents) {
    try { as.unsubscribeAgentEvents(); } catch { /* best-effort */ }
    as.unsubscribeAgentEvents = undefined;
  }
  if (as.visibilityHandler && typeof document !== "undefined") {
    try { document.removeEventListener("visibilitychange", as.visibilityHandler); }
    catch { /* best-effort */ }
    as.visibilityHandler = undefined;
  }
  as.paused = false;
  as.refreshing = false;
}

/**
 * Manual retry — called from the error banner. Forces an immediate
 * non-silent load so the spinner shows and `error` gets cleared on
 * success.
 */
export async function retryActivityLoad(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const as = state.agentActivityState;
  if (!as) return;
  await loadAgentActivity(state, client);
  state.requestUpdate?.();
}

/**
 * Force a session into the "completed" terminal state from the client —
 * useful when the gateway lost the chat completion event (e.g. WS dropped
 * mid-run) and the session sits in "still active" purgatory forever. Pure
 * UI-side mark; the server-side session record is untouched.
 */
export function forceCompleteSession(
  state: AppViewState,
  sessionKey: string,
  outcome: "done" | "error" = "done",
): void {
  const as = state.agentActivityState;
  if (!as) return;
  const session = as.sessions.find((s) => s.key === sessionKey);
  if (!session) return;
  session.completedViaEvent = true;
  session.completionState = outcome;
  session.active = false;
  state.requestUpdate?.();
}

/**
 * Tool-call broadcast payload from src/gateway/server-methods/agent-tools.ts.
 * Two phases: phase="start" (we record a tool_call step) and phase="end"
 * (we record a tool_result step and link it back to the call via toolCallId).
 */
interface AgentBroadcastPayload {
  runId?: string;
  sessionKey?: string;
  source?: string;
  stream?: string;
  ts?: number;
  seq?: number;
  data?: {
    toolCallId?: string;
    name?: string;
    arguments?: unknown;
    phase?: "start" | "end" | "update" | "result";
    durationMs?: number;
    result?: unknown;
    error?: string;
  };
}

function handleLiveAgentEvent(state: AppViewState, payload: AgentBroadcastPayload): void {
  const as = state.agentActivityState;
  if (!as) return;
  // Defensive: don't crash on malformed broadcasts. We see these whenever
  // a new tool surface ships an unexpected payload shape; silently dropping
  // is safer than throwing inside a WS callback (which would kill the
  // whole event stream).
  if (!payload || typeof payload !== "object") return;
  if (payload.stream !== "tool") return;
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
  if (!sessionKey) return;

  // Per-session monotonic dedup. The gateway re-broadcasts on reconnect
  // and occasionally double-sends on hot-paths; without this the feed
  // grows phantom tool_call rows for the same call.
  const seq = typeof payload.seq === "number" ? payload.seq : undefined;
  if (seq !== undefined) {
    const lastSeen = as.lastSeenSeqByKey[sessionKey] ?? -1;
    if (seq <= lastSeen) return;
    as.lastSeenSeqByKey[sessionKey] = seq;
  }

  // If the session is not yet known to the activity feed, queue the
  // event instead of creating an orphan "ghost row" with no metadata.
  // The next poll will pull the session in and `drainOrphanQueue` will
  // replay this event in order.
  let session = as.sessions.find((s) => s.key === sessionKey);
  if (!session) {
    as.orphanedEvents.push({ payload, queuedAt: Date.now() });
    // Cap quarantine so a flood of broken events can't blow memory.
    if (as.orphanedEvents.length > 200) {
      as.orphanedEvents.splice(0, as.orphanedEvents.length - 200);
    }
    return;
  }

  applyLiveEventToSession(state, session, payload);
}

/**
 * Apply a known-valid tool broadcast onto a session. Split out so the
 * orphan-queue drainer can re-use the same logic without re-running the
 * dedup checks (those already ran when the event was queued).
 */
function applyLiveEventToSession(
  state: AppViewState,
  session: AgentSession,
  payload: AgentBroadcastPayload,
): void {
  const as = state.agentActivityState;
  if (!as) return;
  const data = payload.data ?? {};
  const phase = data.phase ?? "start";
  const toolName = data.name ?? "tool";
  const ts = typeof payload.ts === "number" ? payload.ts : Date.now();

  // Map phase → step type. start = tool_call, end = tool_result (or error).
  const argsPreview = (() => {
    if (data.arguments === undefined) return undefined;
    try { return JSON.stringify(data.arguments).slice(0, 240); }
    catch { return String(data.arguments).slice(0, 240); }
  })();
  if (phase === "start") {
    session.steps.push({
      type: "tool_call",
      content: toolName,
      detail: argsPreview,
      toolCallId: data.toolCallId,
      timestamp: ts,
    });
  } else if (phase === "end") {
    const durationSuffix = data.durationMs ? ` (${data.durationMs}ms)` : "";
    if (data.error) {
      session.steps.push({
        type: "error",
        content: data.error,
        detail: toolName + durationSuffix,
        toolCallId: data.toolCallId,
        timestamp: ts,
      });
    } else {
      const resultStr = typeof data.result === "string"
        ? data.result
        : JSON.stringify(data.result ?? {});
      session.steps.push({
        type: "tool_result",
        content: resultStr.slice(0, 1000),
        detail: toolName + durationSuffix,
        toolCallId: data.toolCallId,
        timestamp: ts,
      });
    }
  }
  // Cap step buffer per-session to keep DOM cost bounded.
  const MAX_LIVE_STEPS = 400;
  if (session.steps.length > MAX_LIVE_STEPS) {
    session.steps.splice(0, session.steps.length - MAX_LIVE_STEPS);
  }
  // A new tool event means the session is alive again — clear any
  // premature completion flag the chat-completion handler may have set
  // before the run was actually finished. The next chat completion
  // event will re-set it for real.
  if (session.completedViaEvent) {
    session.completedViaEvent = false;
    session.completionState = undefined;
  }
  session.active = true;
  session.lastLiveEventAt = ts;
  session.updatedAt = ts;
  state.requestUpdate?.();
}

/** Restart the polling timer with the current `as.pollInterval`. */
export function restartActivityPolling(
  state: AppViewState,
  client: GatewayBrowserClient,
): void {
  stopActivityPolling(state);
  startActivityPolling(state, client);
}

export function dismissSpawnNotification(state: AppViewState, id: string): void {
  const as = state.agentActivityState;
  if (!as) return;
  const notif = as.spawnNotifications.find((n) => n.id === id);
  if (notif) notif.dismissed = true;
}

/** Milliseconds of inactivity before a streaming session auto-demotes to Background. */
export const STREAMING_IDLE_MS = 10_000;

/**
 * True when a session is actively streaming live events OR manually pinned to Live.
 * Non-streaming sessions (detached spawns, idle agents) show in the compact Background list.
 */
export function isStreamingSession(session: AgentSession, as: AgentActivityState): boolean {
  if (as.pinnedToBackground.has(session.key)) return false;
  if (as.pinnedToLive.has(session.key)) return true;
  return !!(session.lastLiveEventAt && Date.now() - session.lastLiveEventAt < STREAMING_IDLE_MS);
}

export function pinToLive(state: AppViewState, key: string): void {
  const as = state.agentActivityState;
  if (!as) return;
  as.pinnedToLive.add(key);
  as.pinnedToBackground.delete(key);
  state.requestUpdate?.();
}

export function pinToBackground(state: AppViewState, key: string): void {
  const as = state.agentActivityState;
  if (!as) return;
  as.pinnedToBackground.add(key);
  as.pinnedToLive.delete(key);
  state.requestUpdate?.();
}

export function unpinSession(state: AppViewState, key: string): void {
  const as = state.agentActivityState;
  if (!as) return;
  as.pinnedToLive.delete(key);
  as.pinnedToBackground.delete(key);
  state.requestUpdate?.();
}

export function toggleBgCollapsed(state: AppViewState): void {
  const as = state.agentActivityState;
  if (!as) return;
  as.bgCollapsed = !as.bgCollapsed;
  try {
    localStorage.setItem("infinibot-activity-bg-collapsed", as.bgCollapsed ? "1" : "0");
  } catch { /* best-effort */ }
  state.requestUpdate?.();
}

// ── Focused Chat Modal ────────────────────────────────────────

/** Scroll the modal body to bottom (used on open + new messages). */
export function scrollModalToBottom(force = false): void {
  requestAnimationFrame(() => {
    const el = document.getElementById("infinibot-modal-scroll-body");
    if (!el) return;
    if (force) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  });
}

/**
 * Load (or reload) the full transcript for the modal via sessions.preview.
 * Does not touch modalKey, so it can be called as a refresh after a send.
 */
async function loadModalTranscript(
  state: AppViewState,
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<void> {
  const as = state.agentActivityState;
  if (!as) return;
  as.modalLoading = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("sessions.preview", {
      keys: [sessionKey],
      limit: 200,
      maxChars: 10000,
    })) as any;
    if (res?.previews?.[0]?.items?.length) {
      as.modalSteps = previewItemsToSteps(res.previews[0].items);
    } else if (!as.modalSteps.length) {
      as.modalSteps = [];
    }
  } catch {
    // Keep existing steps if reload fails — non-critical
  } finally {
    as.modalLoading = false;
    state.requestUpdate?.();
    scrollModalToBottom(true);
  }
}

/**
 * Open the focused-chat modal for the given session key.
 * Loads the full transcript and subscribes to live WS events.
 * Closing the modal does NOT kill the underlying run.
 */
export async function openChatModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<void> {
  const as = state.agentActivityState;
  if (!as) return;

  // Tear down any previous subscription
  if (as.modalUnsubscribe) {
    try { as.modalUnsubscribe(); } catch { /* best-effort */ }
    as.modalUnsubscribe = undefined;
  }

  as.modalKey = sessionKey;
  as.modalSteps = [];
  as.modalLoading = true;
  as.modalSending = false;
  as.modalStream = null;
  as.modalError = null;
  as.modalDraft = "";
  state.requestUpdate?.();

  try { localStorage.setItem("infinibot-activity-modal", sessionKey); } catch { /* */ }

  // Subscribe to gateway events for this modal
  as.modalUnsubscribe = client.subscribe((evt) => {
    const currentKey = as.modalKey;
    if (!currentKey) return;

    // Chat stream events — response from chat.send
    if (evt.event === "chat") {
      const p = evt.payload as { sessionKey?: string; state?: string; message?: unknown; errorMessage?: string } | undefined;
      if (!p || p.sessionKey !== currentKey) return;

      if (p.state === "delta") {
        const msg = p.message as any;
        const chunk =
          typeof msg?.content?.[0]?.text === "string" ? msg.content[0].text
          : typeof msg?.content === "string" ? msg.content
          : typeof msg?.text === "string" ? msg.text
          : null;
        if (chunk && chunk.length > (as.modalStream?.length ?? 0)) {
          as.modalStream = chunk;
          state.requestUpdate?.();
          scrollModalToBottom();
        }
      } else if (p.state === "final" || p.state === "aborted") {
        const finalText = as.modalStream;
        as.modalSending = false;
        as.modalStream = null;
        if (finalText) {
          as.modalSteps = [...as.modalSteps, { type: "text", timestamp: Date.now(), content: finalText }];
        }
        // Reload full transcript to get the authoritative response
        void loadModalTranscript(state, client, currentKey);
        state.requestUpdate?.();
      } else if (p.state === "error") {
        as.modalSending = false;
        as.modalStream = null;
        as.modalError = (p.errorMessage as string | undefined) ?? "Request failed";
        state.requestUpdate?.();
      }
    }

    // Live tool-call events — append to modal transcript
    if (evt.event === "agent") {
      const p = evt.payload as AgentBroadcastPayload | undefined;
      if (!p || p.stream !== "tool" || p.sessionKey !== currentKey) return;
      const data = p.data ?? {};
      const phase = data.phase ?? "start";
      const toolName = data.name ?? "tool";
      const ts = typeof p.ts === "number" ? p.ts : Date.now();
      if (phase === "start") {
        as.modalSteps = [...as.modalSteps, {
          type: "tool_call",
          content: toolName,
          detail: data.arguments !== undefined
            ? (() => { try { return JSON.stringify(data.arguments).slice(0, 240); } catch { return String(data.arguments).slice(0, 240); } })()
            : undefined,
          toolCallId: data.toolCallId,
          timestamp: ts,
        }];
      } else if (phase === "end") {
        const suffix = data.durationMs ? ` (${data.durationMs}ms)` : "";
        if (data.error) {
          as.modalSteps = [...as.modalSteps, { type: "error", content: data.error, detail: toolName + suffix, toolCallId: data.toolCallId, timestamp: ts }];
        } else {
          const resultStr = typeof data.result === "string" ? data.result : JSON.stringify(data.result ?? {});
          as.modalSteps = [...as.modalSteps, { type: "tool_result", content: resultStr.slice(0, 1200), detail: toolName + suffix, toolCallId: data.toolCallId, timestamp: ts }];
        }
      }
      state.requestUpdate?.();
      scrollModalToBottom();
    }
  });

  await loadModalTranscript(state, client, sessionKey);
}

/**
 * Close the focused-chat modal. Does NOT kill the underlying run.
 */
export function closeChatModal(state: AppViewState): void {
  const as = state.agentActivityState;
  if (!as) return;
  as.modalKey = null;
  as.modalSteps = [];
  as.modalStream = null;
  as.modalError = null;
  if (as.modalUnsubscribe) {
    try { as.modalUnsubscribe(); } catch { /* best-effort */ }
    as.modalUnsubscribe = undefined;
  }
  try { localStorage.removeItem("infinibot-activity-modal"); } catch { /* */ }
  state.requestUpdate?.();
}

/**
 * Send a message from the modal composer into the session.
 * Uses chat.send (same RPC as the main chat view).
 * Streaming response arrives via the WS subscription set up in openChatModal.
 */
export async function sendModalMessage(
  state: AppViewState,
  client: GatewayBrowserClient,
  sessionKey: string,
  message: string,
): Promise<void> {
  const as = state.agentActivityState;
  if (!as || as.modalSending || !message.trim()) return;

  const userStep: AgentStep = { type: "user", timestamp: Date.now(), content: message.trim() };
  as.modalSteps = [...as.modalSteps, userStep];
  as.modalDraft = "";
  as.modalSending = true;
  as.modalStream = "";
  as.modalError = null;
  state.requestUpdate?.();
  scrollModalToBottom(true);

  try {
    await client.request("chat.send", {
      sessionKey,
      message: message.trim(),
      deliver: false,
      idempotencyKey: `modal-${sessionKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  } catch (err) {
    as.modalSending = false;
    as.modalStream = null;
    as.modalError = String(err);
    // Roll back optimistic user step
    const idx = as.modalSteps.indexOf(userStep);
    if (idx !== -1) as.modalSteps = [...as.modalSteps.slice(0, idx), ...as.modalSteps.slice(idx + 1)];
    state.requestUpdate?.();
  }
}
