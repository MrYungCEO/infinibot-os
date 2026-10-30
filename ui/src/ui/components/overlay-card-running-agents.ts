/**
 * overlay-card-running-agents.ts — live list of currently-active agent sessions.
 *
 * Data source: the SAME activity controller the dashboard / activity panel use
 * (`loadAgentActivity` over `sessions.list` + the live `agent` WS stream). We do
 * NOT open a new gateway poll: a single module-level shared activity state backs
 * every running-agents overlay on the page, refreshed on a slow safety interval
 * AND debounced off the live `agent` WS event the activity feed already rides.
 */
import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import {
  type AgentSession,
  type AgentActivityState,
  createInitialActivityState,
  loadAgentActivity,
  isClaudeCoder,
} from "../controllers/agent-activity";
import { OverlayCardBase } from "./overlay-card-base.js";

// ── Shared singleton activity source (one per page, refcounted) ───────────────
//
// All running-agents overlays share this so spawning N cards never multiplies
// the underlying sessions.list traffic.

interface SharedSource {
  shim: { agentActivityState: AgentActivityState; requestUpdate: () => void };
  client: GatewayBrowserClient | null;
  refs: number;
  intervalId: number | null;
  unsubscribeWs: (() => void) | null;
  reloadTimer: number | null;
  subscribers: Set<() => void>;
}

const SAFETY_POLL_MS = 4000;

let source: SharedSource | null = null;

function getSource(): SharedSource {
  if (source) return source;
  const shim = {
    agentActivityState: createInitialActivityState(),
    requestUpdate: () => {
      if (source) for (const cb of source.subscribers) cb();
    },
  };
  source = {
    shim,
    client: null,
    refs: 0,
    intervalId: null,
    unsubscribeWs: null,
    reloadTimer: null,
    subscribers: new Set(),
  };
  return source;
}

function scheduleReload(s: SharedSource) {
  if (!s.client || s.reloadTimer !== null) return;
  s.reloadTimer = window.setTimeout(() => {
    s.reloadTimer = null;
    if (!s.client) return;
    void loadAgentActivity(s.shim as any, s.client, { silent: true }).then(() =>
      s.shim.requestUpdate(),
    );
  }, 300);
}

function acquireSource(client: GatewayBrowserClient, onUpdate: () => void): SharedSource {
  const s = getSource();
  s.subscribers.add(onUpdate);
  s.refs += 1;
  if (!s.client) s.client = client;
  if (s.refs === 1) {
    // First consumer — kick an initial load, the safety interval, and ride the
    // same live `agent` WS event the activity feed subscribes to.
    void loadAgentActivity(s.shim as any, s.client, { silent: false }).then(() =>
      s.shim.requestUpdate(),
    );
    s.intervalId = window.setInterval(() => {
      if (!s.client) return;
      void loadAgentActivity(s.shim as any, s.client, { silent: true }).then(() =>
        s.shim.requestUpdate(),
      );
    }, SAFETY_POLL_MS);
    try {
      s.unsubscribeWs = s.client.subscribe((evt: any) => {
        if (evt?.event === "agent") scheduleReload(s);
      });
    } catch {
      /* WS subscribe unavailable — safety interval still covers us */
    }
  }
  return s;
}

function releaseSource(onUpdate: () => void) {
  if (!source) return;
  source.subscribers.delete(onUpdate);
  source.refs = Math.max(0, source.refs - 1);
  if (source.refs === 0) {
    if (source.intervalId !== null) window.clearInterval(source.intervalId);
    if (source.reloadTimer !== null) window.clearTimeout(source.reloadTimer);
    try { source.unsubscribeWs?.(); } catch { /* best-effort */ }
    source = null;
  }
}

// ── Card ──────────────────────────────────────────────────────────────────────

@customElement("overlay-card-running-agents")
export class OverlayCardRunningAgents extends OverlayCardBase {
  @state() private sessions: AgentSession[] = [];

  private onUpdate = () => {
    const all = source?.shim.agentActivityState.sessions ?? [];
    this.sessions = all.filter((s) => s.active);
    this.requestUpdate();
  };

  override connectedCallback() {
    super.connectedCallback();
    if (this.client) acquireSource(this.client, this.onUpdate);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    releaseSource(this.onUpdate);
  }

  protected accent = "#22c55e";

  protected cardTitle() {
    return "Running Agents";
  }

  protected headerMeta() {
    return this.sessions.length ? `${this.sessions.length} live` : "idle";
  }

  private backendLabel(s: AgentSession): string {
    if (s.coderBackend === "claude-code" || isClaudeCoder(s)) return "claude";
    if (s.coderBackend === "opencode") return "opencode";
    if (s.coderBackend === "codex") return "codex";
    if (s.kind === "subagent") return "subagent";
    return s.model || "agent";
  }

  private rowName(s: AgentSession): string {
    if (s.kind === "subagent") {
      return s.label || s.displayName || s.derivedTitle || `Sub-agent ${s.agentId}`;
    }
    return s.agentName || s.agentId;
  }

  protected renderBody() {
    if (!this.sessions.length) {
      return html`<div class="empty">No agents running right now.</div>`;
    }
    return html`
      <div class="list">
        ${this.sessions.map((s) => {
          const task = s.derivedTitle || s.lastMessagePreview || s.label || "";
          return html`
            <div class="row">
              <span class="pulse"></span>
              <div class="row-main">
                <div class="row-top">
                  <span class="name" title=${this.rowName(s)}>${this.rowName(s)}</span>
                  <span class="backend">${this.backendLabel(s)}</span>
                </div>
                ${task ? html`<div class="task" title=${task}>${task}</div>` : null}
              </div>
              ${s.remote ? html`<span class="node" title=${s.node ?? "remote"}>${s.node ?? "remote"}</span>` : null}
            </div>
          `;
        })}
      </div>
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .empty {
        font-size: 11px;
        color: #71717a;
        padding: 6px 2px;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 260px;
      }
      .row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 7px 8px;
        border: 1px solid color-mix(in srgb, #22c55e 16%, transparent);
        border-radius: 8px;
        background: rgba(34, 197, 94, 0.05);
      }
      .pulse {
        margin-top: 4px;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #22c55e;
        box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
        animation: pulse 1.6s ease-out infinite;
        flex: 0 0 auto;
      }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55); }
        100% { box-shadow: 0 0 0 7px rgba(34, 197, 94, 0); }
      }
      .row-main { flex: 1 1 auto; min-width: 0; }
      .row-top { display: flex; align-items: baseline; gap: 6px; }
      .name {
        font-size: 11px;
        font-weight: 700;
        color: #e4e4e7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1 1 auto;
      }
      .backend {
        font-size: 8px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #22c55e;
        flex: 0 0 auto;
      }
      .task {
        font-size: 9px;
        color: #a1a1aa;
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .node {
        font-size: 8px;
        color: #71717a;
        flex: 0 0 auto;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-running-agents": OverlayCardRunningAgents;
  }
}
