/**
 * SubagentActivityPanel — Premium glass UI for real-time sub-agent monitoring
 *
 * Shows live status of spawned sub-agents with deep glassmorphism cards,
 * SVG status icons, segmented progress, shimmer sweep, and stagger-in animation.
 */

import { LitElement, html, css, nothing, PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import type { AgentSession } from "../controllers/agent-activity";
// The single card is now its own element so the EXACT same card renders on
// every surface (this panel + the Voice Terminal edge HUD). Types + the data
// normalizers live alongside it.
import {
  Subagent,
  normalizeStatus,
  resolveSubagentBackend,
} from "./subagent-activity-card";
import "./subagent-activity-card";

// Re-export the canonical row type so existing importers keep working.
export type { Subagent } from "./subagent-activity-card";

interface SubagentsListResult {
  ok: boolean;
  subagents: RawSubagent[];
}

interface RawSubagent extends Omit<Subagent, "status"> {
  status: string;
}

// Inline chevron-up (icons.ts has no chevronUp)
const chevronUpSvg = html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="m18 15-6-6-6 6"/></svg>`;

// ============================================================
// SubagentActivityPanel Component
// ============================================================

@customElement("subagent-activity-panel")
export class SubagentActivityPanel extends LitElement {
  @property({ type: Object }) gateway: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) collapsed = false;
  /**
   * Suppress the built-in panel header (title + count badges + collapse/refresh).
   * Used when an outer surface (e.g. the masonry grid Activity panel) supplies
   * its own section header and only wants the card body. Default false keeps
   * the standalone Activity page unchanged.
   */
  @property({ type: Boolean }) hideHeader = false;
  @property({ type: Number }) pollIntervalMs = 2000;
  @property({ type: Number }) limit = 20;
  /**
   * Live session map keyed by session key, sourced from the Running Agents
   * feed. When provided, the card uses estimateProgress() for running/pending
   * subagents that haven't reported explicit backend progress, so the bar
   * moves continuously instead of snapping 0 → 100 at completion.
   */
  @property({ type: Object }) liveSessions: Map<string, AgentSession> | null = null;
  /**
   * "compact"  = horizontal scroll row (chat page default)
   * "expanded" = auto-fill grid (activity page)
   */
  @property({ type: String }) density: "compact" | "expanded" = "compact";

  @state() private subagents: Subagent[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private lastFetchAt = 0;
  @state() private now = Date.now();

  private pollTimer: number | null = null;
  private tickTimer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private pendingFetch: number | null = null;

  // ============================================================
  // Styles
  // ============================================================

  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    }

    /* ── Panel shell ─────────────────────────────────────────── */
    .sap-panel {
      position: relative;
      border-radius: 14px;
      overflow: hidden;
      background: rgba(9, 11, 18, 0.6);
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.07);
      box-shadow:
        0 4px 32px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.07);
      transition: border-color 0.3s ease, box-shadow 0.3s ease;
    }

    .sap-panel.has-running {
      border-color: rgba(34, 211, 238, 0.18);
      box-shadow:
        0 4px 32px rgba(0, 0, 0, 0.5),
        0 0 60px rgba(34, 211, 238, 0.05),
        inset 0 1px 0 rgba(255, 255, 255, 0.07);
    }

    /* ── Header ─────────────────────────────────────────────── */
    .sap-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.025);
      border-bottom: 1px solid rgba(255, 255, 255, 0.055);
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }

    .sap-header:hover { background: rgba(255, 255, 255, 0.042); }

    .sap-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .sap-title {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(255, 255, 255, 0.65);
    }

    .sap-title-icon {
      display: flex;
      align-items: center;
      color: rgba(255, 255, 255, 0.4);
    }

    .sap-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      flex-shrink: 0;
      transition: background 0.3s, box-shadow 0.3s;
    }

    .sap-live-dot.active {
      background: #22d3ee;
      box-shadow: 0 0 10px rgba(34, 211, 238, 0.7);
      animation: sap-pulse 1.6s ease-in-out infinite;
    }

    @keyframes sap-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.55; transform: scale(0.8); }
    }

    .sap-header-badges {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .sap-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 20px;
      font-size: 10px;
      font-weight: 700;
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.2px;
    }

    .sap-badge svg { width: 11px; height: 11px; }

    .sap-badge.running {
      background: rgba(34, 211, 238, 0.1);
      color: #22d3ee;
      border: 1px solid rgba(34, 211, 238, 0.22);
    }

    .sap-badge.complete {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
      border: 1px solid rgba(34, 197, 94, 0.18);
    }

    .sap-badge.error {
      background: rgba(248, 113, 113, 0.1);
      color: #f87171;
      border: 1px solid rgba(248, 113, 113, 0.2);
    }

    .sap-header-actions {
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .sap-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: rgba(255, 255, 255, 0.35);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }

    .sap-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.8);
    }

    .sap-btn.spinning svg { animation: sap-spin 0.8s linear infinite; }

    @keyframes sap-spin { to { transform: rotate(360deg); } }

    /* ── Scroll / content area ───────────────────────────────── */
    .sap-scroll {
      overflow-x: auto;
      overflow-y: hidden;
      padding: 12px;
      -ms-overflow-style: none;
      scrollbar-width: none;
    }

    .sap-scroll::-webkit-scrollbar { display: none; }

    .sap-panel.collapsed .sap-scroll { display: none; }

    .sap-cards-row {
      display: flex;
      gap: 10px;
      align-items: stretch;
    }

    /* ── Expanded / grid density ─────────────────────────────── */
    .sap-panel.density-expanded .sap-scroll {
      overflow-x: hidden;
      overflow-y: visible;
    }

    .sap-panel.density-expanded .sap-cards-row {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
      gap: 12px;
    }

    /* ── Empty state ─────────────────────────────────────────────── */
    .sap-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 34px 24px;
      gap: 10px;
    }

    .sap-empty-ring {
      width: 46px;
      height: 46px;
      border-radius: 50%;
      border: 1.5px solid rgba(255, 255, 255, 0.07);
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.18);
      animation: sap-empty-bloom 2.6s ease-in-out infinite;
    }

    @keyframes sap-empty-bloom {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.04); }
      50%       { box-shadow: 0 0 0 12px rgba(255,255,255,0); }
    }

    .sap-empty-text {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.2);
      letter-spacing: 0.3px;
    }

    /* ── Loading ─────────────────────────────────────────────────── */
    .sap-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
      gap: 9px;
      color: rgba(255, 255, 255, 0.3);
      font-size: 11.5px;
    }

    .sap-loading-icon {
      display: flex;
      color: rgba(255, 255, 255, 0.28);
      animation: sap-spin 1s linear infinite;
    }

    /* ── Error state ─────────────────────────────────────────────── */
    .sap-err {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      gap: 8px;
      color: #f87171;
      font-size: 11px;
      text-align: center;
    }

    .sap-err-icon {
      display: flex;
      color: #f87171;
      opacity: 0.7;
    }

    .sap-retry-btn {
      margin-top: 4px;
      padding: 5px 14px;
      border-radius: 6px;
      border: 1px solid rgba(248, 113, 113, 0.3);
      background: rgba(248, 113, 113, 0.08);
      color: #f87171;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .sap-retry-btn:hover { background: rgba(248, 113, 113, 0.16); }

    /* ── Mobile ──────────────────────────────────────────────────── */
    @media (max-width: 600px) {
      .sap-header-badges { display: none; }
    }

  `;

  // ============================================================
  // Lifecycle
  // ============================================================

  connectedCallback() {
    super.connectedCallback();
    this.startPolling();
    this.startTicker();
    this.subscribeToEvents();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopPolling();
    this.stopTicker();
    this.unsubscribeFromEvents();
    if (this.pendingFetch !== null) {
      clearTimeout(this.pendingFetch);
      this.pendingFetch = null;
    }
  }

  updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (changedProperties.has("gateway")) {
      this.unsubscribeFromEvents();
      this.subscribeToEvents();
      this.fetchSubagents();
    }
  }

  // ============================================================
  // Gateway
  // ============================================================

  private async fetchSubagents() {
    if (!this.gateway?.connected) return;
    try {
      this.loading = this.subagents.length === 0;
      const result = await this.gateway.request<SubagentsListResult>("subagents.list", {
        limit: this.limit,
      });
      if (result?.ok && Array.isArray(result.subagents)) {
        const normalized: Subagent[] = result.subagents.map((raw) => ({
          ...raw,
          status: normalizeStatus(raw.status),
          coderBackend: resolveSubagentBackend(raw),
        }));
        this.subagents = this.mergeSubagents(normalized);
        this.lastFetchAt = Date.now();
        this.error = null;
      }
    } catch (err) {
      console.warn("[SubagentPanel] fetch error:", err);
      if (this.subagents.length === 0) {
        this.error = err instanceof Error ? err.message : "Failed to fetch";
      }
    } finally {
      this.loading = false;
    }
  }

  private mergeSubagents(fresh: Subagent[]): Subagent[] {
    const freshMap = new Map(fresh.map((s) => [s.runId, s]));
    const result: Subagent[] = [];

    for (const existing of this.subagents) {
      const update = freshMap.get(existing.runId);
      if (update) {
        result.push({ ...existing, ...update });
        freshMap.delete(existing.runId);
      } else if (!this.isLocallyExpired(existing)) {
        result.push(existing);
      }
    }

    for (const agent of freshMap.values()) result.push(agent);
    return result;
  }

  private isLocallyExpired(agent: Subagent): boolean {
    if (agent.status !== "complete" && agent.status !== "error" && agent.status !== "timeout") {
      return false;
    }
    const endTime = agent.endedAt ?? agent.completedAt ?? agent.lastUpdateAt;
    return Date.now() - endTime > 10 * 60_000;
  }

  private subscribeToEvents() {
    if (!this.gateway) return;
    this.unsubscribe = this.gateway.subscribe((evt) => {
      if (
        evt.event === "subagent.spawned" ||
        evt.event === "subagent.progress" ||
        evt.event === "subagent.complete" ||
        evt.event === "subagent.error" ||
        evt.event === "subagent.timeout"
      ) {
        this.scheduleFetch();
      }
    });
  }

  private scheduleFetch() {
    if (this.pendingFetch !== null) return;
    this.pendingFetch = window.setTimeout(() => {
      this.pendingFetch = null;
      void this.fetchSubagents();
    }, 300);
  }

  private unsubscribeFromEvents() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  // ============================================================
  // Timers
  // ============================================================

  private startPolling() {
    this.stopPolling();
    this.fetchSubagents();
    this.pollTimer = window.setInterval(() => this.fetchSubagents(), this.pollIntervalMs);
  }

  private stopPolling() {
    if (this.pollTimer !== null) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private startTicker() {
    this.stopTicker();
    // 15s tick — enough for "2m ago" time-ago precision
    this.tickTimer = window.setInterval(() => { this.now = Date.now(); }, 15_000);
  }

  private stopTicker() {
    if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  // ============================================================
  // Interactions
  // ============================================================

  private toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this.dispatchEvent(new CustomEvent("toggle-collapsed", {
      detail: { collapsed: this.collapsed },
      bubbles: true,
      composed: true,
    }));
  }

  private refresh() { this.fetchSubagents(); }

  // ============================================================
  // Computed
  // ============================================================

  private get runningCount() {
    return this.subagents.filter(s => s.status === "running" || s.status === "pending").length;
  }

  private get completeCount() {
    return this.subagents.filter(s => s.status === "complete").length;
  }

  private get errorCount() {
    return this.subagents.filter(s => s.status === "error" || s.status === "timeout").length;
  }

  private get hasRunning() { return this.runningCount > 0; }

  // ============================================================
  // Render
  // ============================================================

  render() {
    if (this.subagents.length === 0 && !this.loading && !this.error) return nothing;

    const cls = [
      "sap-panel",
      this.collapsed ? "collapsed" : "",
      this.hasRunning ? "has-running" : "",
      this.density === "expanded" ? "density-expanded" : "",
    ].filter(Boolean).join(" ");

    return html`
      <div class=${cls}>
        ${this.hideHeader ? nothing : this.renderHeader()}
        <div class="sap-scroll">
          ${this.loading && this.subagents.length === 0
            ? this.renderLoading()
            : this.error && this.subagents.length === 0
              ? this.renderError()
              : this.renderCards()
          }
        </div>
      </div>
    `;
  }

  private renderHeader() {
    return html`
      <div class="sap-header" @click=${this.toggleCollapsed}>
        <div class="sap-header-left">
          <div class="sap-title">
            <div class="sap-live-dot ${this.hasRunning ? "active" : ""}"></div>
            <span class="sap-title-icon">${icons.activity}</span>
            <span>Sub-Agents</span>
          </div>
          <div class="sap-header-badges">
            ${this.runningCount > 0 ? html`
              <span class="sap-badge running">${icons.loader} ${this.runningCount}</span>
            ` : nothing}
            ${this.completeCount > 0 ? html`
              <span class="sap-badge complete">${icons.checkCircle} ${this.completeCount}</span>
            ` : nothing}
            ${this.errorCount > 0 ? html`
              <span class="sap-badge error">${icons.xCircle} ${this.errorCount}</span>
            ` : nothing}
          </div>
        </div>
        <div class="sap-header-actions">
          <button
            class="sap-btn ${this.loading ? "spinning" : ""}"
            title="Refresh"
            @click=${(e: Event) => { e.stopPropagation(); this.refresh(); }}
          >${icons.refresh}</button>
          <button class="sap-btn" title="${this.collapsed ? "Expand" : "Collapse"}">
            ${this.collapsed ? icons.chevronDown : chevronUpSvg}
          </button>
        </div>
      </div>
    `;
  }

  private renderLoading() {
    return html`
      <div class="sap-loading">
        <span class="sap-loading-icon">${icons.loader}</span>
        Loading agents…
      </div>
    `;
  }

  private renderError() {
    return html`
      <div class="sap-err">
        <span class="sap-err-icon">${icons.alertCircle}</span>
        ${this.error}
        <button class="sap-retry-btn" @click=${this.refresh}>Retry</button>
      </div>
    `;
  }

  private renderCards() {
    if (this.subagents.length === 0) {
      return html`
        <div class="sap-empty">
          <div class="sap-empty-ring">${icons.bot}</div>
          <span class="sap-empty-text">No agents currently running</span>
        </div>
      `;
    }

    const sorted = [...this.subagents].sort((a, b) => {
      const order: Record<string, number> = {
        running: 0, pending: 1, complete: 2, error: 3, timeout: 4,
      };
      const oa = order[a.status] ?? 5;
      const ob = order[b.status] ?? 5;
      if (oa !== ob) return oa - ob;
      return (b.lastUpdateAt || 0) - (a.lastUpdateAt || 0);
    });

    return html`
      <div class="sap-cards-row">
        ${repeat(
          sorted,
          (a) => a.runId,
          (a, i) => this.renderCard(a, i)
        )}
      </div>
    `;
  }

  private renderCard(agent: Subagent, index: number) {
    // Delegates to the shared <subagent-activity-card> so the EXACT same card
    // renders here and on the Voice Terminal edge HUD running lane.
    return html`
      <subagent-activity-card
        .agent=${agent}
        .liveSessions=${this.liveSessions}
        .now=${this.now}
        .index=${index}
        density=${this.density}
      ></subagent-activity-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "subagent-activity-panel": SubagentActivityPanel;
  }
}
