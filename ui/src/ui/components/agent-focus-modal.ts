/**
 * <agent-focus-modal> — ROBUST, gamified agent inspector for the isometric world.
 * =============================================================================
 *
 * A self-contained, self-mounting modal that opens when an agent is clicked on
 * the mesh / isometric world (<agency-world-viz>). It mirrors (and exceeds) the
 * information density of the Activity page's <subagent-detail-modal> while
 * wearing the gold-on-black isometric "agency world" aesthetic — glassmorphic,
 * with a status glow ring, a task-completion level bar, and isometric chrome —
 * but never at the expense of legibility or reliability.
 *
 * ── Public contract ─────────────────────────────────────────────────────────
 *   window.openAgentFocus(target)
 *     target may be:
 *       • a string  — an agentId, sessionKey, or runId; the modal resolves the
 *                      rest via subagents.list.
 *       • an object — a MeshAgent-like record ({ sessionKey, agentId, runId,
 *                      status, progress, label, currentTask, coderBackend,
 *                      nodeId, kanbanTaskId, ... }) OR { agent, review }.
 *
 *   mountAgentFocusModal(client, requestUpdate?)
 *     Called once from app-render.ts. Stores the gateway client, registers
 *     window.openAgentFocus, the global "infinibot:open-agent-focus" CustomEvent
 *     bridge, and a dev hotkey (Ctrl+Shift+A → open first active agent).
 *
 *   closeAgentFocus()
 *
 * ── Wiring note ──────────────────────────────────────────────────────────────
 * Until agency-world-viz/gpu-animation-panel are updated (owned by another
 * agent right now), this modal is opened via window.openAgentFocus(...) or the
 * "infinibot:open-agent-focus" event. Once those land, the mesh-click handler
 * should call window.openAgentFocus(agent) instead of the old slide-in panel.
 * See docs/diagnostics/agent-focus-modal-wiring.md.
 *
 * Side-effect-free on import beyond the customElement registration.
 */

import { LitElement, html, css, unsafeCSS, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import { requestAgentDrawer, rosterAgentIdOf } from "../lib/agents-drawer-intent";

// ── Theme tokens (match agency-world-viz: gold #d4af37 on #0a0e1a) ──────────
const GOLD = unsafeCSS("#d4af37");
const GOLD_SOFT = unsafeCSS("#f5d77a");
const BG = unsafeCSS("#0a0e1a");

const STATUS_COLORS: Record<string, string> = {
  starting: "#3b82f6",
  running: "#ffd700",
  working: "#ffd700",
  idle: "#6a8a6a",
  checkpoint: "#22d3ee",
  blocked: "#e74c3c",
  finishing: "#f59e0b",
  completed: "#22c55e",
  complete: "#22c55e",
  failed: "#ef4444",
  error: "#ef4444",
  timeout: "#f97316",
  online: "#22c55e",
  offline: "#ef4444",
};

function statusColor(status: unknown): string {
  const s = String(status || "").toLowerCase();
  return STATUS_COLORS[s] || "#9aa2b1";
}

function fileBase(path: string): string {
  const p = String(path || "");
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function fmtAgo(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return "";
  const ms = Date.now() - ts;
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDuration(from: number | undefined, to: number | undefined): string {
  if (!from) return "—";
  const end = to || Date.now();
  const s = Math.max(0, Math.floor((end - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Normalized internal shapes ───────────────────────────────────────────────
interface FocusAgent {
  runId: string | null;
  sessionKey: string | null;
  agentId: string | null;
  label: string;
  status: string;
  progress: number;
  currentTask?: string;
  task?: string;
  coderBackend?: string;
  model?: string;
  nodeId?: string;
  nodeName?: string;
  kanbanTaskId?: string;
  remote?: boolean;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
}

interface TimelineEvent {
  at: number;
  kind: string; // "tool" | "status" | "file" | "error" | "checkpoint"
  label: string;
  color?: string;
}

interface FileTouched {
  path: string;
  action?: string;
}

// ── Module-level singleton plumbing ──────────────────────────────────────────
let _client: GatewayBrowserClient | null = null;
let _modal: AgentFocusModal | null = null;
let _mounted = false;

function ensureModalElement(): AgentFocusModal {
  if (_modal && document.body.contains(_modal)) return _modal;
  const el = document.createElement("agent-focus-modal") as AgentFocusModal;
  document.body.appendChild(el);
  _modal = el;
  return el;
}

/** Open the modal for an agent target (string id or MeshAgent-like object). */
export function openAgentFocus(target: unknown): void {
  if (!_client) {
    console.warn(
      "[agent-focus-modal] openAgentFocus called before mountAgentFocusModal(client). Ignoring.",
    );
    return;
  }
  const el = ensureModalElement();
  el.client = _client;
  el.openFor(target);
}

export function closeAgentFocus(): void {
  _modal?.close();
}

/**
 * Idempotent: register the gateway client, window.openAgentFocus, the
 * "infinibot:open-agent-focus" event bridge, and the dev hotkey.
 */
export function mountAgentFocusModal(
  client: GatewayBrowserClient,
  _requestUpdate?: () => void,
): void {
  _client = client;
  if (_mounted) return;
  _mounted = true;

  (window as unknown as { openAgentFocus?: (t: unknown) => void }).openAgentFocus =
    openAgentFocus;

  window.addEventListener("infinibot:open-agent-focus", (e: Event) => {
    const detail = (e as CustomEvent).detail;
    openAgentFocus(detail?.agent ?? detail?.target ?? detail);
  });

  // Dev hotkey: Ctrl+Shift+A → open the first active mesh agent (for verify).
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      void (async () => {
        try {
          const res = (await client.request("subagents.list", {
            includeCompleted: true,
            limit: 20,
          })) as { subagents?: any[]; items?: any[]; runs?: any[] };
          const items = res?.subagents ?? res?.items ?? res?.runs ?? [];
          if (items.length) openAgentFocus(items[0]);
          else console.warn("[agent-focus-modal] hotkey: no agents to show");
        } catch (err) {
          console.warn("[agent-focus-modal] hotkey list failed", err);
        }
      })();
    }
  });
}

@customElement("agent-focus-modal")
export class AgentFocusModal extends LitElement {
  client: GatewayBrowserClient | null = null;

  @state() private _open = false;
  @state() private _agent: FocusAgent | null = null;
  @state() private _detail: any = null;
  @state() private _loading = false;
  @state() private _error: string | null = null;
  @state() private _timeline: TimelineEvent[] = [];
  @state() private _files: FileTouched[] = [];
  @state() private _lastActivity: { kind: string; label: string; at: number } | null = null;
  @state() private _lastLog = "";
  @state() private _taskExpanded = false;
  @state() private _showAllFiles = false;
  @state() private _composeText = "";
  @state() private _busy = false;
  @state() private _usage: { tokensIn?: number; tokensOut?: number; costUsd?: number } | null = null;

  private _unsub: (() => void) | null = null;
  private _poll: ReturnType<typeof setInterval> | null = null;
  /** Cache of the visible agent list for arrow-key cycling. */
  private _siblings: any[] = [];
  private _loadToken = 0;
  /** Last open target, kept so the error banner's Retry can re-run the load. */
  private _lastTarget: unknown = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._teardown();
  }

  private _teardown(): void {
    if (this._unsub) {
      try { this._unsub(); } catch { /* noop */ }
      this._unsub = null;
    }
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
  }

  close = (): void => {
    this._open = false;
    this._teardown();
  };

  // ── Open / resolve / load ───────────────────────────────────────────────────
  async openFor(target: unknown): Promise<void> {
    this._teardown();
    this._lastTarget = target;
    this._open = true;
    this._loading = true;
    this._error = null;
    this._detail = null;
    this._timeline = [];
    this._files = [];
    this._lastActivity = null;
    this._lastLog = "";
    this._usage = null;
    this._taskExpanded = false;
    this._showAllFiles = false;
    const token = ++this._loadToken;

    const agent = this._normalize(target);
    this._agent = agent;

    // Resolve missing identifiers from subagents.list when needed.
    if (!agent.runId || !agent.sessionKey || !agent.status) {
      const resolved = await this._resolveFromList(agent);
      if (token !== this._loadToken) return;
      if (resolved) this._agent = { ...agent, ...resolved };
    }

    window.addEventListener("keydown", this._onKeydown);
    await this._load(token);
  }

  private _normalize(target: unknown): FocusAgent {
    let a: any = target;
    if (a && typeof a === "object" && a.agent) a = a.agent; // {agent, review}
    if (typeof a === "string") {
      // Bare id — could be runId / sessionKey / agentId.
      return {
        runId: null, sessionKey: null, agentId: a, label: a,
        status: "", progress: 0,
      };
    }
    a = a || {};
    return {
      runId: a.runId ?? a.run_id ?? null,
      sessionKey: a.sessionKey ?? a.childSessionKey ?? a.session_key ?? null,
      agentId: a.agentId ?? a.agent_id ?? a.id ?? null,
      label: a.label || a.agentId || a.sessionKey || a.runId || "Agent",
      status: String(a.status || ""),
      progress: Number(a.progress) || 0,
      currentTask: a.currentTask,
      task: a.task,
      coderBackend: a.coderBackend,
      model: a.model || a.provider,
      nodeId: a.nodeId,
      nodeName: a.nodeName,
      kanbanTaskId: a.kanbanTaskId,
      remote: a.remote,
      createdAt: a.createdAt,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
    };
  }

  private async _resolveFromList(agent: FocusAgent): Promise<Partial<FocusAgent> | null> {
    if (!this.client) return null;
    try {
      const res = (await this.client.request("subagents.list", {
        includeCompleted: true,
        limit: 100,
        updatesTail: 10,
      })) as { subagents?: any[]; items?: any[]; runs?: any[] };
      const items = res?.subagents ?? res?.items ?? res?.runs ?? [];
      this._siblings = items;
      const match = items.find(
        (it) =>
          (agent.runId && it.runId === agent.runId) ||
          (agent.sessionKey && it.sessionKey === agent.sessionKey) ||
          (agent.agentId &&
            (it.runId === agent.agentId ||
              it.sessionKey === agent.agentId ||
              it.label === agent.agentId)),
      );
      if (!match) return null;
      return {
        runId: match.runId ?? agent.runId,
        sessionKey: match.sessionKey ?? agent.sessionKey,
        label: match.label || agent.label,
        status: match.status || agent.status,
        progress: Number(match.progress) || agent.progress,
        task: match.task || agent.task,
        coderBackend: match.coderBackend || agent.coderBackend,
        kanbanTaskId: match.kanbanTaskId ?? agent.kanbanTaskId,
        createdAt: match.createdAt ?? agent.createdAt,
        remote: match.remote ?? agent.remote,
      };
    } catch (err) {
      // Surface list failures so the modal can offer a retry. We only flag the
      // error when we have no usable identifiers to fall back on (a runId
      // passed by the caller still renders fine).
      if (!agent.runId && !agent.sessionKey) {
        this._error = err instanceof Error ? err.message : String(err);
      }
      return null;
    }
  }

  private async _load(token: number): Promise<void> {
    const a = this._agent;
    if (!this.client || !a) { this._loading = false; return; }

    // 1) Rich detail (task brief, files, project, outcome, workdir, backend).
    const runId = a.runId ?? undefined;
    const sessionKey = a.sessionKey ?? undefined;
    if (runId || sessionKey || a.kanbanTaskId) {
      try {
        const d = (await this.client.request("subagents.detail", {
          runId, sessionKey, kanbanTaskId: a.kanbanTaskId,
        })) as any;
        if (token !== this._loadToken) return;
        if (d?.ok || d?.run) {
          this._detail = d;
          const run = d.run || {};
          // Files touched
          const ft: FileTouched[] = Array.isArray(run.filesTouched)
            ? run.filesTouched.map((f: any) =>
                typeof f === "string" ? { path: f } : { path: f.path, action: f.action })
            : Array.isArray(run.filesTouchedSample)
              ? run.filesTouchedSample.map((p: string) => ({ path: p }))
              : [];
          this._files = ft;
          // Backfill timestamps / backend / task from detail.
          this._agent = {
            ...a,
            task: a.task || run.task,
            coderBackend: a.coderBackend || run.coderBackend,
            createdAt: a.createdAt ?? run.createdAt,
            startedAt: a.startedAt ?? run.startedAt,
            endedAt: a.endedAt ?? run.endedAt,
            status: a.status || (run.outcome?.status ?? a.status),
          };
          // Usage, if the backend recorded it on the run.
          if (run.usage || run.tokensIn != null || run.costUsd != null) {
            this._usage = {
              tokensIn: run.usage?.inputTokens ?? run.tokensIn,
              tokensOut: run.usage?.outputTokens ?? run.tokensOut,
              costUsd: run.usage?.costUsd ?? run.costUsd,
            };
          }
        }
      } catch { /* non-fatal */ }
    }

    this._loading = false;

    // 2) Live status snapshot + timeline from progress record.
    await this._refreshProgress(token);

    // 2b) Token / cost usage.
    await this._refreshUsage(token);

    // 3) Transcript → last log line + dialogue backfill for the timeline.
    //    The handler resolves the sessionKey from runId, so runId alone is
    //    enough even when the caller passed a stale/placeholder sessionKey.
    if (runId || sessionKey) {
      try {
        const tr = (await this.client.request("sessions.transcript", {
          runId, sessionKey, limit: 14, maxChars: 1400,
        })) as { ok?: boolean; turns?: Array<{ role: string; text: string }> };
        if (token === this._loadToken && tr?.turns?.length) {
          const turns = tr.turns;
          const last = turns[turns.length - 1];
          this._lastLog = `${last.role}: ${last.text}`.slice(0, 280);
          this._seedTimelineFromTranscript(turns);
        }
      } catch { /* non-fatal */ }
    }

    // 4) Live WS subscription + slow poll for progress refresh.
    this._subscribe();
    if (this._isActive()) {
      this._poll = setInterval(() => {
        const t = this._loadToken;
        void this._refreshProgress(t);
        void this._refreshUsage(t);
      }, 2000);
    }
  }

  /**
   * Seed the activity timeline with dialogue events from the session
   * transcript so the modal shows history that predates the live WS
   * subscription. Turns arrive oldest→newest with no per-turn timestamp, so we
   * spread them evenly across the run's lifespan (startedAt → lastActivity/now)
   * to keep ordering sane without inventing precise times.
   */
  private _seedTimelineFromTranscript(
    turns: Array<{ role: string; text: string }>,
  ): void {
    const a = this._agent;
    const to = this._lastActivity?.at || a?.endedAt || Date.now();
    const from = a?.startedAt || a?.createdAt || to - turns.length * 60_000;
    const span = Math.max(1, to - from);
    const step = span / (turns.length + 1);
    turns.forEach((turn, i) => {
      const text = String(turn.text || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      const isUser = /user|human/i.test(turn.role);
      this._pushTimeline({
        at: Math.round(from + step * (i + 1)),
        kind: "dialogue",
        label: `${isUser ? "📨" : "💬"} ${text.slice(0, 90)}${text.length > 90 ? "…" : ""}`,
        color: isUser ? "#9aa2b1" : "#a855f7",
      });
    });
  }

  private async _refreshProgress(token: number): Promise<void> {
    const a = this._agent;
    if (!this.client || !a) return;
    try {
      const res = (await this.client.request("subagents.list", {
        includeCompleted: true,
        limit: 100,
        updatesTail: 10,
      })) as { subagents?: any[]; items?: any[]; runs?: any[] };
      if (token !== this._loadToken) return;
      const items = res?.subagents ?? res?.items ?? res?.runs ?? [];
      this._siblings = items;
      const m = items.find(
        (it) => (a.runId && it.runId === a.runId) || (a.sessionKey && it.sessionKey === a.sessionKey),
      );
      if (!m) return;
      this._agent = {
        ...a,
        status: m.status || a.status,
        progress: Number(m.progress) || a.progress,
        endedAt: m.endedAt ?? a.endedAt,
      };
      if (m.lastActivity) {
        this._lastActivity = {
          kind: m.lastActivity.kind,
          label: m.lastActivity.label,
          at: m.lastActivity.at,
        };
      }
      // Merge checkpoint updates into the timeline (de-dup by at+label).
      const updates = Array.isArray(m.recentUpdates) ? m.recentUpdates : [];
      for (const u of updates) {
        this._pushTimeline({
          at: u.timestamp || u.at || Date.now(),
          kind: "checkpoint",
          label: u.message || u.status || "update",
          color: statusColor(u.status),
        });
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Token / cost usage. Prefers the authoritative per-run rollup
   * (`subagents.usage`, added alongside this modal — needs a gateway restart to
   * serve). Falls back to the always-served `credits.bySession` for
   * session-keyed entries so usage shows live even before that restart. Never
   * clobbers a good value with zeros, so the modal degrades to "—" gracefully.
   */
  private async _refreshUsage(token: number): Promise<void> {
    const a = this._agent;
    if (!this.client || !a || (!a.runId && !a.sessionKey)) return;
    try {
      const u = (await this.client.request("subagents.usage", {
        runId: a.runId ?? undefined,
        sessionKey: a.sessionKey ?? undefined,
      })) as { ok?: boolean; tokensIn?: number; tokensOut?: number; costUsd?: number };
      if (token !== this._loadToken) return;
      if (u?.ok && (u.tokensIn || u.tokensOut || u.costUsd)) {
        this._usage = { tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: u.costUsd };
        return;
      }
    } catch {
      /* method not served yet (pre-restart) — fall through to credits.bySession */
    }
    if (a.sessionKey && a.sessionKey !== a.runId) {
      try {
        const r = (await this.client.request("credits.bySession", {
          sessionKey: a.sessionKey,
          period: "all",
        })) as {
          summary?: { totalTokensIn?: number; totalTokensOut?: number; totalCostUsd?: number };
        };
        if (token !== this._loadToken) return;
        const s = r?.summary;
        if (s && (s.totalTokensIn || s.totalTokensOut || s.totalCostUsd)) {
          this._usage = {
            tokensIn: s.totalTokensIn,
            tokensOut: s.totalTokensOut,
            costUsd: s.totalCostUsd,
          };
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  private _subscribe(): void {
    if (!this.client || this._unsub) return;
    const a = this._agent;
    if (!a?.runId) return;
    const runId = a.runId;
    this._unsub = (this.client as unknown as {
      subscribe: (h: (e: GatewayEventFrame) => void) => () => void;
    }).subscribe((evt: GatewayEventFrame) => {
      if (evt.event !== "agent") return;
      const p = evt.payload as any;
      if (!p || p.runId !== runId) return;
      const data = p.data ?? {};
      const ts = p.ts || Date.now();
      if (p.stream === "tool") {
        if (data.phase === "start") {
          const name = String(data.name ?? "tool");
          this._lastActivity = { kind: name, label: name, at: ts };
          this._pushTimeline({ at: ts, kind: "tool", label: name, color: "#22d3ee" });
        } else if (data.phase === "end" && data.error) {
          this._pushTimeline({
            at: ts, kind: "error", label: `Error: ${String(data.error).slice(0, 120)}`,
            color: "#ef4444",
          });
        }
      } else if (p.stream === "text" && data.deltaText) {
        this._lastLog = String(data.deltaText).slice(0, 280);
      } else if (p.stream === "state" && data.state) {
        this._pushTimeline({
          at: ts, kind: "status", label: `State → ${data.state}`,
          color: statusColor(data.state),
        });
        if (this._agent) this._agent = { ...this._agent, status: String(data.state) };
      }
    });
  }

  private _pushTimeline(ev: TimelineEvent): void {
    const exists = this._timeline.some((t) => t.at === ev.at && t.label === ev.label);
    if (exists) return;
    const next = [...this._timeline, ev].sort((x, y) => y.at - x.at).slice(0, 60);
    this._timeline = next;
  }

  private _isActive(): boolean {
    const s = String(this._agent?.status || "").toLowerCase();
    return ["working", "running", "starting", "checkpoint", "finishing", "blocked"].includes(s);
  }

  // ── Keyboard: Esc closes, ←/→ cycles siblings ───────────────────────────────
  private _onKeydown = (e: KeyboardEvent): void => {
    if (!this._open) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      window.removeEventListener("keydown", this._onKeydown);
      this.close();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      this._cycle(e.key === "ArrowRight" ? 1 : -1);
    }
  };

  private _cycle(dir: number): void {
    const list = this._siblings;
    if (!list.length) return;
    const a = this._agent;
    const idx = list.findIndex(
      (it) => (a?.runId && it.runId === a.runId) || (a?.sessionKey && it.sessionKey === a.sessionKey),
    );
    const next = list[(((idx >= 0 ? idx : 0) + dir) % list.length + list.length) % list.length];
    if (next) void this.openFor(next);
  }

  // ── Quick actions ───────────────────────────────────────────────────────────
  private _act = async (fn: () => Promise<unknown>): Promise<void> => {
    this._busy = true;
    try { await fn(); } catch (err) { console.warn("[agent-focus-modal] action failed", err); }
    finally { this._busy = false; }
  };

  private _onStop = () =>
    this._act(async () => {
      const a = this._agent;
      if (a?.sessionKey) await this.client!.request("agent.abort", { sessionKey: a.sessionKey });
      else if (a?.runId) await this.client!.request("subagents.stop", { runId: a.runId });
    });

  private _onResume = () =>
    this._act(async () => {
      if (this._agent?.runId) await this.client!.request("sessions.resume", { runId: this._agent.runId });
    });

  private _onRespawn = () =>
    this._act(async () => {
      if (this._agent?.runId) {
        const r = (await this.client!.request("subagents.respawn", { runId: this._agent.runId })) as any;
        if (r?.newRunId) this._agent = { ...this._agent!, runId: r.newRunId };
      }
    });

  private _onSend = () =>
    this._act(async () => {
      const a = this._agent;
      const msg = this._composeText.trim();
      if (!a?.runId || !a.sessionKey || !msg) return;
      await this.client!.request("sessions.send", { runId: a.runId, sessionKey: a.sessionKey, message: msg });
      this._composeText = "";
    });

  private _retry = (): void => {
    this._error = null;
    void this.openFor(this._lastTarget);
  };

  private _onFullLogs = (): void => {
    if (!this._agent?.runId) return;
    window.dispatchEvent(
      new CustomEvent("infinibot:subagent-open-detail", {
        detail: { runId: this._agent.runId, sessionKey: this._agent.sessionKey, tab: "live" },
      }),
    );
    this.close();
  };

  /** Open the agent's detail drawer on the Agents page. */
  private _onOpenAgentProfile = (): void => {
    const id = rosterAgentIdOf(this._agent);
    if (!id) return;
    requestAgentDrawer(id);
    this.close();
  };

  private _onOpenKanban = (): void => {
    const taskId = this._agent?.kanbanTaskId || this._detail?.task?.id;
    const projectId = this._detail?.project?.id;
    if (!taskId && !projectId) return;
    window.dispatchEvent(
      new CustomEvent("infinibot:kanban-open-task", { detail: { taskId, projectId } }),
    );
    this.close();
  };

  // ── Styles ──────────────────────────────────────────────────────────────────
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 9500;
      display: none;
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      color: #e4e4e7;
    }
    :host([data-open]) { display: block; }

    .scrim {
      position: absolute;
      inset: 0;
      background: radial-gradient(
        120% 100% at 50% 0%,
        rgba(10, 14, 26, 0.72),
        rgba(2, 4, 10, 0.9)
      );
      backdrop-filter: blur(7px);
      animation: fade 0.18s ease both;
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes rise {
      from { opacity: 0; transform: translate(-50%, calc(-50% + 18px)) scale(0.98); }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    .card {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(720px, 94vw);
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      background:
        linear-gradient(180deg, rgba(212, 175, 55, 0.07), transparent 42%),
        linear-gradient(180deg, rgba(20, 26, 42, 0.92), rgba(8, 11, 20, 0.96));
      border: 1px solid rgba(212, 175, 55, 0.4);
      border-radius: 16px;
      box-shadow:
        0 30px 90px rgba(0, 0, 0, 0.7),
        0 0 0 1px rgba(0, 0, 0, 0.4) inset,
        0 1px 0 rgba(255, 255, 255, 0.05) inset;
      overflow: hidden;
      animation: rise 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    /* Isometric corner chrome */
    .card::before, .card::after {
      content: "";
      position: absolute;
      width: 26px; height: 26px;
      border: 1px solid ${GOLD};
      opacity: 0.5;
      pointer-events: none;
    }
    .card::before { top: 10px; left: 10px; border-right: none; border-bottom: none; }
    .card::after  { bottom: 10px; right: 10px; border-left: none; border-top: none; }

    /* ── Header ── */
    .hdr {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 20px 16px;
      border-bottom: 1px solid rgba(212, 175, 55, 0.2);
      background: linear-gradient(180deg, rgba(212, 175, 55, 0.09), transparent);
    }
    .ring {
      flex: none;
      position: relative;
      width: 52px; height: 52px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: radial-gradient(circle at 50% 40%, rgba(255,255,255,0.06), transparent 70%);
    }
    .ring::before {
      content: "";
      position: absolute; inset: 0;
      border-radius: 50%;
      border: 2px solid var(--glow, #9aa2b1);
      box-shadow: 0 0 16px var(--glow, #9aa2b1), 0 0 4px var(--glow, #9aa2b1) inset;
      animation: pulse 2.4s ease-in-out infinite;
    }
    @keyframes pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
    .ring .glyph { font-size: 20px; color: var(--glow, #d4af37); font-weight: 700; }

    .titles { flex: 1; min-width: 0; }
    .kicker {
      font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase;
      color: ${GOLD}; opacity: 0.85;
    }
    .title {
      font-size: 17px; font-weight: 700; color: #fff; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .submeta {
      display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 6px;
      font-size: 10px; color: #9aa2b1;
    }
    .submeta b { color: #c6ccd6; font-weight: 600; }
    .x {
      flex: none; width: 30px; height: 30px; border-radius: 8px;
      border: 1px solid rgba(212, 175, 55, 0.35); background: transparent;
      color: ${GOLD}; font-size: 15px; cursor: pointer; font-family: inherit;
    }
    .x:hover { background: rgba(212, 175, 55, 0.16); }

    .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 20px 0; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px; font-size: 10px;
      letter-spacing: 0.05em; text-transform: uppercase; border: 1px solid currentColor;
    }
    .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .chip.muted { color: #8a93a6; }

    /* ── Body ── */
    .body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 4px; }
    .body::-webkit-scrollbar { width: 8px; }
    .body::-webkit-scrollbar-thumb { background: rgba(212,175,55,0.25); border-radius: 8px; }

    .sect { margin-top: 16px; }
    .sect:first-child { margin-top: 6px; }
    .lbl {
      display: flex; align-items: center; gap: 8px;
      font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
      color: #9aa2b1; margin-bottom: 7px;
    }
    .lbl::after {
      content: ""; flex: 1; height: 1px;
      background: linear-gradient(90deg, rgba(212,175,55,0.3), transparent);
    }

    /* Level / progress bar */
    .level {
      height: 12px; border-radius: 7px; overflow: hidden;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(212,175,55,0.25);
      position: relative;
    }
    .level > i {
      display: block; height: 100%;
      background: linear-gradient(90deg, ${GOLD}, ${GOLD_SOFT});
      box-shadow: 0 0 12px rgba(212,175,55,0.5);
      transition: width 0.4s ease;
    }
    .level-meta {
      display: flex; justify-content: space-between;
      font-size: 10px; color: ${GOLD}; margin-top: 5px;
    }

    .now {
      display: flex; flex-direction: column; gap: 4px;
      padding: 10px 12px; border-radius: 9px;
      background: rgba(34, 211, 238, 0.05);
      border: 1px solid rgba(34, 211, 238, 0.22);
    }
    .now .k { font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: #67e8f9; }
    .now .v { font-size: 12px; color: #e4e4e7; word-break: break-word; }
    .now .log { font-size: 10px; color: #9aa2b1; white-space: pre-wrap; word-break: break-word; max-height: 54px; overflow: hidden; }

    .brief {
      font-size: 12px; line-height: 1.55; color: #d6dae2; word-break: break-word;
      max-height: 64px; overflow: hidden; position: relative;
      padding: 10px 12px; border-radius: 9px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    }
    .brief.expanded { max-height: none; }
    .brief-toggle {
      margin-top: 6px; font-size: 10px; color: ${GOLD}; cursor: pointer;
      background: none; border: none; font-family: inherit; padding: 0;
      text-transform: uppercase; letter-spacing: 0.08em;
    }

    .files {
      border: 1px solid rgba(212,175,55,0.16); border-radius: 9px;
      background: rgba(0,0,0,0.28); overflow: hidden;
    }
    .file {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; font-size: 10px; color: #c6ccd6;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .file:last-child { border-bottom: none; }
    .file .badge {
      flex: none; width: 16px; height: 16px; border-radius: 4px;
      display: grid; place-items: center; font-size: 9px; font-weight: 700;
    }
    .file .path { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .file .path .dir { color: #6b7280; }

    /* Timeline */
    .timeline { display: flex; flex-direction: column; gap: 0; padding-left: 6px; }
    .tl {
      display: flex; gap: 10px; padding: 5px 0; position: relative;
    }
    .tl .pin {
      flex: none; width: 9px; height: 9px; border-radius: 50%;
      margin-top: 3px; background: var(--c, #9aa2b1);
      box-shadow: 0 0 8px var(--c, #9aa2b1);
    }
    .tl .stem {
      position: absolute; left: 4px; top: 12px; bottom: -5px;
      width: 1px; background: rgba(212,175,55,0.18);
    }
    .tl:last-child .stem { display: none; }
    .tl .txt { flex: 1; font-size: 11px; color: #d6dae2; word-break: break-word; }
    .tl .ts { flex: none; font-size: 9px; color: #6b7280; }

    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .stat {
      padding: 8px 10px; border-radius: 8px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
    }
    .stat .k { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: #8a93a6; }
    .stat .v { font-size: 13px; color: #fff; margin-top: 2px; word-break: break-word; }
    .stat .v.gold { color: ${GOLD}; }

    .link {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 11px; border-radius: 7px; font-size: 10px;
      letter-spacing: 0.05em; text-transform: uppercase; cursor: pointer;
      border: 1px solid rgba(212,175,55,0.3); background: rgba(212,175,55,0.08);
      color: ${GOLD}; font-family: inherit;
    }
    .link:hover { background: rgba(212,175,55,0.18); }

    .skel {
      height: 12px; border-radius: 6px; margin: 8px 0;
      background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.1), rgba(255,255,255,0.04));
      background-size: 200% 100%; animation: shimmer 1.3s linear infinite;
    }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

    /* ── Composer + actions ── */
    .compose { display: flex; gap: 8px; margin-top: 8px; }
    .compose textarea {
      flex: 1; resize: none; min-height: 36px; max-height: 90px;
      background: rgba(0,0,0,0.3); border: 1px solid rgba(212,175,55,0.22);
      border-radius: 8px; color: #e4e4e7; font-family: inherit; font-size: 11px;
      padding: 8px 10px;
    }
    .compose textarea:focus { outline: none; border-color: rgba(212,175,55,0.5); }

    .actions {
      flex: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
      padding: 14px 20px; border-top: 1px solid rgba(212,175,55,0.2);
      background: rgba(0,0,0,0.25);
    }
    button.act {
      padding: 9px 10px; border-radius: 8px; font-family: inherit; font-size: 10px;
      letter-spacing: 0.05em; text-transform: uppercase; cursor: pointer;
      border: 1px solid rgba(212,175,55,0.35); background: rgba(212,175,55,0.1);
      color: ${GOLD}; transition: background 0.15s ease;
    }
    button.act:hover:not(:disabled) { background: rgba(212,175,55,0.2); }
    button.act.primary { background: ${GOLD}; color: ${BG}; border-color: ${GOLD}; font-weight: 700; }
    button.act.primary:hover:not(:disabled) { background: ${GOLD_SOFT}; }
    button.act.danger {
      border-color: rgba(239,68,68,0.5); background: rgba(239,68,68,0.12); color: #f87171;
    }
    button.act.danger:hover:not(:disabled) { background: rgba(239,68,68,0.22); }
    button.act:disabled { opacity: 0.35; cursor: not-allowed; }

    .empty { padding: 16px 0; font-size: 11px; color: #6b7280; text-align: center; }

    .errbar {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px; margin-bottom: 10px; border-radius: 9px;
      background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.4);
      color: #f87171; font-size: 11px;
    }
    .errbar .msg { flex: 1; word-break: break-word; }
    .errbar button {
      flex: none; padding: 5px 11px; border-radius: 7px; cursor: pointer;
      font-family: inherit; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase;
      border: 1px solid rgba(239, 68, 68, 0.5); background: rgba(239, 68, 68, 0.16); color: #fca5a5;
    }
    .errbar button:hover { background: rgba(239, 68, 68, 0.28); }

    @media (max-width: 560px) {
      .card {
        top: 0; left: 0; transform: none; width: 100vw; max-width: 100vw;
        height: 100dvh; max-height: 100dvh; border-radius: 0; border: none;
        animation: fade 0.2s ease both;
      }
      .card::before, .card::after { display: none; }
      .actions { grid-template-columns: repeat(2, 1fr); }
    }
  `;

  // Reflect open state to host attribute for the display:none toggle.
  override updated(): void {
    if (this._open) this.setAttribute("data-open", "");
    else this.removeAttribute("data-open");
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  render() {
    if (!this._open) return nothing;
    const a = this._agent;
    const color = statusColor(a?.status);
    const progress = Math.max(0, Math.min(100, a?.progress ?? 0));
    const backend = a?.coderBackend || this._detail?.run?.coderBackend || "—";
    const isLocal = !a?.remote && (!a?.nodeId || /local|master|^$/i.test(String(a?.nodeId)));
    const node = a?.nodeName || a?.nodeId || (isLocal ? "local" : "satellite");

    return html`
      <div class="scrim" @click=${this.close}></div>
      <div class="card" @click=${(e: Event) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div class="hdr">
          <div class="ring" style="--glow:${color}">
            <span class="glyph">${(a?.label || "A").slice(0, 1).toUpperCase()}</span>
          </div>
          <div class="titles">
            <div class="kicker">Agent · Mesh Focus</div>
            <div class="title" title=${a?.label || ""}>${a?.label || "Agent"}</div>
            <div class="submeta">
              ${a?.agentId ? html`<span><b>ID</b> ${a.agentId}</span>` : nothing}
              <span><b>Backend</b> ${backend}</span>
              <span><b>Node</b> ${node} ${isLocal ? "· LOCAL" : "· SAT"}</span>
              ${a?.createdAt ? html`<span><b>Up</b> ${fmtDuration(a.startedAt || a.createdAt, a.endedAt)}</span>` : nothing}
            </div>
          </div>
          <button class="x" title="Close (Esc)" @click=${this.close}>✕</button>
        </div>

        <div class="chips">
          <span class="chip" style="color:${color}"><span class="dot"></span>${a?.status || "unknown"}</span>
          ${this._detail?.project
            ? html`<span class="chip muted">▣ ${this._detail.project.name}</span>` : nothing}
          ${a?.kanbanTaskId || this._detail?.task
            ? html`<span class="chip muted">✓ task linked</span>` : nothing}
          ${a?.model ? html`<span class="chip muted">${a.model}</span>` : nothing}
        </div>

        <div class="body">
          ${this._error
            ? html`<div class="errbar">
                <span class="msg">⚠ Couldn't load agent data: ${this._error}</span>
                <button @click=${this._retry}>Retry</button>
              </div>`
            : nothing}
          ${this._loading ? this._renderSkeleton() : this._renderContent()}
        </div>

        ${this._renderActions()}
      </div>
    `;
  }

  private _renderSkeleton() {
    return html`
      <div class="sect"><div class="skel" style="width:40%"></div><div class="skel"></div></div>
      <div class="sect"><div class="skel" style="width:30%"></div><div class="skel"></div><div class="skel" style="width:80%"></div></div>
    `;
  }

  private _renderContent() {
    const a = this._agent;
    const progress = Math.max(0, Math.min(100, a?.progress ?? 0));
    const files = this._showAllFiles ? this._files : this._files.slice(0, 8);
    const brief = a?.task || this._detail?.run?.task || "";

    return html`
      <!-- Level / completion -->
      <div class="sect">
        <div class="lbl">Task progress</div>
        <div class="level"><i style="width:${progress}%"></i></div>
        <div class="level-meta">
          <span>Lvl ${Math.floor(progress / 10)} · ${progress}%</span>
          <span>${this._isActive() ? "in progress" : (a?.status || "done")}</span>
        </div>
      </div>

      <!-- Live status -->
      <div class="sect">
        <div class="lbl">Live status</div>
        <div class="now">
          <span class="k">Current activity</span>
          <span class="v">
            ${this._lastActivity
              ? html`${this._lastActivity.label} <span style="color:#6b7280">· ${fmtAgo(this._lastActivity.at)}</span>`
              : (a?.currentTask || (this._isActive() ? "working…" : "idle"))}
          </span>
          ${this._lastLog ? html`<span class="log">${this._lastLog}</span>` : nothing}
        </div>
      </div>

      <!-- Task brief (collapsible) -->
      ${brief ? html`
        <div class="sect">
          <div class="lbl">Task brief</div>
          <div class="brief ${this._taskExpanded ? "expanded" : ""}">${brief}</div>
          ${brief.length > 180 ? html`
            <button class="brief-toggle" @click=${() => { this._taskExpanded = !this._taskExpanded; }}>
              ${this._taskExpanded ? "▲ collapse" : "▼ expand"}
            </button>` : nothing}
        </div>` : nothing}

      <!-- Files touched -->
      ${this._files.length ? html`
        <div class="sect">
          <div class="lbl">Files touched · ${this._files.length}</div>
          <div class="files">
            ${files.map((f) => {
              const base = fileBase(f.path);
              const dir = String(f.path).slice(0, String(f.path).length - base.length);
              const act = (f.action || "").charAt(0).toUpperCase() || "·";
              const ac = f.action === "deleted" ? "#ef4444"
                : f.action === "created" ? "#22c55e"
                : f.action === "edited" ? "#d4af37" : "#6b7280";
              return html`<div class="file" title=${f.path}>
                <span class="badge" style="background:${ac}22;color:${ac};border:1px solid ${ac}55">${act}</span>
                <span class="path"><span class="dir">${dir}</span>${base}</span>
              </div>`;
            })}
          </div>
          ${this._files.length > 8 ? html`
            <button class="brief-toggle" @click=${() => { this._showAllFiles = !this._showAllFiles; }}>
              ${this._showAllFiles ? "▲ show fewer" : `▼ show all ${this._files.length}`}
            </button>` : nothing}
        </div>` : nothing}

      <!-- Activity timeline -->
      <div class="sect">
        <div class="lbl">Activity timeline</div>
        ${this._timeline.length ? html`
          <div class="timeline">
            ${this._timeline.slice(0, 18).map((ev) => html`
              <div class="tl" style="--c:${ev.color || "#9aa2b1"}">
                <span class="pin"></span><span class="stem"></span>
                <span class="txt">${ev.label}</span>
                <span class="ts">${fmtAgo(ev.at)}</span>
              </div>`)}
          </div>` : html`<div class="empty">No events recorded yet.</div>`}
      </div>

      <!-- Tokens / cost -->
      <div class="sect">
        <div class="lbl">Usage</div>
        <div class="grid2">
          <div class="stat"><div class="k">Tokens in</div><div class="v">${this._usage?.tokensIn != null ? this._usage.tokensIn.toLocaleString() : "—"}</div></div>
          <div class="stat"><div class="k">Tokens out</div><div class="v">${this._usage?.tokensOut != null ? this._usage.tokensOut.toLocaleString() : "—"}</div></div>
          <div class="stat"><div class="k">Cost</div><div class="v gold">${this._usage?.costUsd != null ? `$${this._usage.costUsd.toFixed(4)}` : "—"}</div></div>
          <div class="stat"><div class="k">Run ID</div><div class="v" style="font-size:10px">${a?.runId ? String(a.runId).slice(0, 14) : "—"}</div></div>
        </div>
      </div>

      <!-- Send message -->
      <div class="sect">
        <div class="lbl">Send message</div>
        <div class="compose">
          <textarea
            placeholder="Inject a message to this agent…"
            .value=${this._composeText}
            @input=${(e: Event) => { this._composeText = (e.target as HTMLTextAreaElement).value; }}
            @keydown=${(e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") this._onSend(); }}
          ></textarea>
          <button class="act" ?disabled=${this._busy || !this._composeText.trim() || !this._isActive()} @click=${this._onSend}>Send</button>
        </div>
      </div>

      <!-- deep links -->
      <div class="sect" style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="link" @click=${this._onFullLogs} ?disabled=${!a?.runId}>↗ Full logs</button>
        <button class="link" @click=${this._onOpenKanban} ?disabled=${!(a?.kanbanTaskId || this._detail?.task || this._detail?.project)}>▣ Open in kanban</button>
        <button class="link" data-testid="afm-agent-profile" @click=${this._onOpenAgentProfile} ?disabled=${!rosterAgentIdOf(a)}>◉ Agent profile</button>
      </div>
    `;
  }

  private _renderActions() {
    const a = this._agent;
    const active = this._isActive();
    return html`
      <div class="actions">
        <button class="act primary" ?disabled=${this._busy || !active || !a?.runId} @click=${this._onResume}>▶ Resume</button>
        <button class="act danger" ?disabled=${this._busy || !active || !(a?.sessionKey || a?.runId)} @click=${this._onStop}>■ Stop</button>
        <button class="act" ?disabled=${this._busy || active || !a?.runId} @click=${this._onRespawn}>⟳ Respawn</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-focus-modal": AgentFocusModal;
  }
  interface Window {
    openAgentFocus?: (target: unknown) => void;
  }
}
