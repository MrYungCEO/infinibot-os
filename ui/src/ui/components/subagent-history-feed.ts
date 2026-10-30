/**
 * SubagentHistoryFeed — persistent archive feed of completed sub-agents.
 *
 * Renders the entries returned by the gateway's `subagents.history` method.
 * Lives directly below the live <subagent-activity-panel> so that the moment
 * a run drops out of the live panel's 10-minute window it's still visible
 * here for review.
 *
 * Visual: same glass/blur design language as the live panel, but denser,
 * lower-saturation, and a single-line row layout — this is an archive, not
 * a live HUD.  Clicking a row fires the shared
 * `infinibot:subagent-open-detail` CustomEvent that the existing detail
 * modal listener catches; we never re-implement the modal.
 */

import { LitElement, html, css, nothing, PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import {
  getCoderBackendIcon,
  getCoderBackendIconLabel,
  getCoderBackendBrand,
} from "../lib/coder-backend-brand";

// Compact satellite/node glyph: center dot + half arc
const _histNodeIcon = html`<svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true"><circle cx="5" cy="5" r="1.5" fill="currentColor"/><path d="M2.5 5a2.5 2.5 0 0 1 5 0" stroke="currentColor" stroke-width="1" stroke-linecap="round" fill="none"/></svg>`;

// ── Types ──────────────────────────────────────────────────────────────────

export type HistoryStatus = "complete" | "error" | "timeout";

export interface HistoryEntry {
  runId: string;
  label?: string;
  task: string;
  status: HistoryStatus;
  startedAt?: number;
  endedAt: number;
  outcome?: { status: string; error?: string };
  error?: string;
  requesterSessionKey: string;
  kanbanTaskId?: string;
  workdir?: string;
  coderBackend?: string;
  filesTouchedCount?: number;
  filesTouchedSample?: string[];
  /** Federation node this run was on, if remote. */
  remote?: boolean;
  nodeId?: string;
  nodeName?: string;
}

interface HistoryListResult {
  ok: boolean;
  history?: HistoryEntry[];
  total?: number;
  serverTime?: number;
}

type StatusPillKey = "all" | HistoryStatus;

// ── Helpers ────────────────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDuration(startedAt: number | undefined, endedAt: number): string {
  if (!startedAt) return "—";
  const ms = Math.max(0, endedAt - startedAt);
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s ?? "";
  return s.slice(0, max - 1) + "…";
}

const STATUS_LABEL: Record<HistoryStatus, string> = {
  complete: "Done",
  error: "Failed",
  timeout: "Timeout",
};

// ── Component ──────────────────────────────────────────────────────────────

@customElement("subagent-history-feed")
export class SubagentHistoryFeed extends LitElement {
  @property({ type: Object }) gateway: GatewayBrowserClient | null = null;
  @property({ type: Number }) initialLimit = 30;
  /** Page size for the Load More button. */
  @property({ type: Number }) pageSize = 30;
  /**
   * Render with a clickable collapse/expand header. When true, the body
   * (filters, search, rows, footer) hides behind a smooth max-height/opacity
   * transition and the panel collapses by default on first visit.
   */
  @property({ type: Boolean }) collapsible = false;
  /** localStorage key for persisting the collapsed flag across reloads. */
  @property({ type: String }) storageKey =
    "infinibot:activity:subagent-history:collapsed";

  @state() private entries: HistoryEntry[] = [];
  @state() private total = 0;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private filter: StatusPillKey = "all";
  @state() private search = "";
  @state() private limit = 30;
  /** Toggles the collapsible wrapper. Only consulted when `collapsible` is on. */
  @state() private collapsed = true;
  /** Stable id so aria-controls survives re-renders. */
  private readonly bodyId = `shf-body-${Math.random().toString(36).slice(2, 9)}`;

  private unsubscribe: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private idleTimer: number | null = null;
  /** Idle re-fetch interval — completed runs don't change, so this can be lazy. */
  private static IDLE_FETCH_MS = 30_000;

  // ── Styles ────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    }

    .shf-panel {
      position: relative;
      border-radius: 12px;
      overflow: hidden;
      background: rgba(7, 9, 14, 0.55);
      backdrop-filter: blur(22px) saturate(140%);
      -webkit-backdrop-filter: blur(22px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.05);
      box-shadow:
        0 2px 18px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    /* ── Header ───────────────────────────────────────────────── */
    .shf-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.018);
      border-bottom: 1px solid rgba(255, 255, 255, 0.045);
      flex-wrap: wrap;
    }

    .shf-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .shf-title {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.1px;
      color: rgba(255, 255, 255, 0.5);
    }

    .shf-title-icon {
      color: rgba(255, 255, 255, 0.3);
      display: inline-flex;
    }

    .shf-count-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 7px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.55);
      font-size: 10px;
      font-weight: 700;
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.3px;
    }

    /* ── Filter pills ─────────────────────────────────────────── */
    .shf-pills {
      display: inline-flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .shf-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      border-radius: 20px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.025);
      color: rgba(255, 255, 255, 0.5);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.25px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      font-family: var(--font-mono, monospace);
      text-transform: uppercase;
    }

    .shf-pill:hover {
      background: rgba(255, 255, 255, 0.045);
      color: rgba(255, 255, 255, 0.75);
    }

    .shf-pill.active {
      background: rgba(255, 255, 255, 0.07);
      color: rgba(255, 255, 255, 0.92);
      border-color: rgba(255, 255, 255, 0.16);
    }

    .shf-pill.complete.active { color: #34d399; border-color: rgba(52, 211, 153, 0.32); background: rgba(52, 211, 153, 0.08); }
    .shf-pill.error.active    { color: #f87171; border-color: rgba(248, 113, 113, 0.32); background: rgba(248, 113, 113, 0.08); }
    .shf-pill.timeout.active  { color: #9ca3af; border-color: rgba(156, 163, 175, 0.32); background: rgba(156, 163, 175, 0.08); }

    /* ── Search ───────────────────────────────────────────────── */
    .shf-search {
      width: 180px;
      padding: 5px 10px;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(0, 0, 0, 0.22);
      color: rgba(255, 255, 255, 0.85);
      font-size: 11px;
      font-family: var(--font-mono, monospace);
      outline: none;
      transition: border-color 0.15s;
    }

    .shf-search:focus { border-color: rgba(255, 255, 255, 0.18); }

    .shf-search::placeholder { color: rgba(255, 255, 255, 0.28); }

    /* ── List body ────────────────────────────────────────────── */
    .shf-body {
      padding: 6px;
      max-height: 360px;
      overflow-y: auto;
      scrollbar-width: thin;
    }

    .shf-body::-webkit-scrollbar { width: 6px; }
    .shf-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.07); border-radius: 3px; }

    /* ── Row ──────────────────────────────────────────────────── */
    .shf-row {
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      gap: 8px;
      align-items: center;
      padding: 7px 10px;
      border-radius: 8px;
      background: linear-gradient(
        155deg,
        rgba(255, 255, 255, 0.018) 0%,
        rgba(255, 255, 255, 0) 60%,
        rgba(0, 0, 0, 0.04) 100%
      ), rgba(10, 13, 19, 0.55);
      backdrop-filter: blur(18px) saturate(130%);
      -webkit-backdrop-filter: blur(18px) saturate(130%);
      border: 1px solid rgba(255, 255, 255, 0.045);
      margin-bottom: 4px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, transform 0.15s;
      font-size: 11.5px;
    }

    .shf-row:hover {
      background: linear-gradient(
        155deg,
        rgba(255, 255, 255, 0.04) 0%,
        rgba(255, 255, 255, 0) 60%,
        rgba(0, 0, 0, 0.04) 100%
      ), rgba(14, 18, 26, 0.7);
      border-color: rgba(255, 255, 255, 0.085);
      transform: translateY(-1px);
    }

    .shf-row:focus-visible {
      outline: 2px solid rgba(34, 211, 238, 0.4);
      outline-offset: 2px;
    }

    .shf-row-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 16px;
      font-size: 9px;
      font-weight: 700;
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }

    .shf-row-pill svg { width: 10px; height: 10px; }

    .shf-row-pill.complete {
      background: rgba(52, 211, 153, 0.06);
      color: #6ee7b7;
      border: 1px solid rgba(52, 211, 153, 0.18);
    }

    .shf-row-pill.error {
      background: rgba(248, 113, 113, 0.06);
      color: #fca5a5;
      border: 1px solid rgba(248, 113, 113, 0.2);
    }

    .shf-row-pill.timeout {
      background: rgba(156, 163, 175, 0.05);
      color: #cbd5e1;
      border: 1px solid rgba(156, 163, 175, 0.18);
    }

    .shf-row-meta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .shf-row-label {
      font-weight: 600;
      color: rgba(255, 255, 255, 0.85);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0.1px;
    }

    .shf-row-task {
      font-size: 10.5px;
      color: rgba(255, 255, 255, 0.4);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--font-mono, monospace);
    }

    .shf-row-time {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.4);
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.2px;
      white-space: nowrap;
    }

    .shf-row-duration {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.32);
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.2px;
      white-space: nowrap;
    }

    /* ── States ──────────────────────────────────────────────── */
    .shf-empty {
      padding: 22px 16px;
      text-align: center;
      color: rgba(255, 255, 255, 0.35);
      font-size: 11px;
      letter-spacing: 0.2px;
    }

    .shf-skel {
      height: 30px;
      border-radius: 8px;
      background: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0.03) 0%,
        rgba(255, 255, 255, 0.06) 50%,
        rgba(255, 255, 255, 0.03) 100%
      );
      background-size: 200% 100%;
      animation: shf-shimmer 1.4s linear infinite;
      margin-bottom: 4px;
    }

    @keyframes shf-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    .shf-error {
      padding: 16px;
      text-align: center;
      color: #f87171;
      font-size: 11px;
    }

    .shf-retry-btn {
      margin-top: 8px;
      padding: 4px 14px;
      border-radius: 14px;
      border: 1px solid rgba(248, 113, 113, 0.28);
      background: rgba(248, 113, 113, 0.06);
      color: #f87171;
      font-size: 10.5px;
      font-family: var(--font-mono, monospace);
      cursor: pointer;
    }

    .shf-retry-btn:hover { background: rgba(248, 113, 113, 0.14); }

    .shf-footer {
      display: flex;
      justify-content: center;
      padding: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.035);
    }

    .shf-more-btn {
      padding: 5px 16px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.025);
      color: rgba(255, 255, 255, 0.65);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      font-family: var(--font-mono, monospace);
    }

    .shf-more-btn:hover {
      background: rgba(255, 255, 255, 0.055);
      color: rgba(255, 255, 255, 0.9);
    }

    .shf-more-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }

    @media (max-width: 600px) {
      .shf-search { width: 140px; }
      .shf-row { grid-template-columns: auto 1fr auto; }
      .shf-row-duration { display: none; }
    }

    /* ── Federation node tag (compact, single-line) ──────────────── */
    .shf-row-label-row {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }

    .shf-node-tag {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 5px;
      border-radius: 20px;
      border: 1px solid rgba(34, 211, 238, 0.2);
      background: rgba(34, 211, 238, 0.07);
      color: #22d3ee;
      font-size: 8px;
      font-weight: 700;
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.04em;
      flex-shrink: 0;
      max-width: 90px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
    }

    .shf-node-tag svg { flex-shrink: 0; }

    /* ── CLI provider chip (left of label) ───────────────────────── */
    .shf-row-backend {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      border-radius: 4px;
      /* color + background set inline per-brand (accent / tone) */
    }

    .shf-row-backend svg { width: 11px; height: 11px; display: block; }

    /* ── Collapsible mode ──────────────────────────────────────── */
    .shf-toggle-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.018);
      border-bottom: 1px solid rgba(255, 255, 255, 0.045);
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }

    .shf-toggle-bar:hover {
      background: rgba(255, 255, 255, 0.035);
    }

    .shf-toggle-bar:focus-visible {
      outline: 2px solid rgba(34, 211, 238, 0.4);
      outline-offset: -2px;
    }

    /* When fully collapsed the bar has no separator. */
    .shf-toggle-bar.is-collapsed {
      border-bottom-color: transparent;
    }

    .shf-chevron {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.55);
      transition: transform 180ms ease;
      flex-shrink: 0;
    }

    .shf-chevron.is-collapsed {
      transform: rotate(-90deg);
    }

    .shf-summary {
      margin-left: auto;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.45);
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .shf-collapsible {
      max-height: 1200px;
      opacity: 1;
      overflow: hidden;
      transition: max-height 180ms ease, opacity 180ms ease;
    }

    .shf-collapsible.is-collapsed {
      max-height: 0;
      opacity: 0;
      pointer-events: none;
    }
  `;

  // ── Lifecycle ─────────────────────────────────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    this.limit = this.initialLimit;
    if (this.collapsible) {
      // Default = collapsed; restore prior choice if present.
      try {
        const raw = localStorage.getItem(this.storageKey);
        this.collapsed = raw === null ? true : raw === "1";
      } catch {
        this.collapsed = true;
      }
    } else {
      this.collapsed = false;
    }
    this.attachListeners();
    void this.fetch();
  }

  private toggleCollapsed = () => {
    this.collapsed = !this.collapsed;
    if (this.collapsible) {
      try {
        localStorage.setItem(this.storageKey, this.collapsed ? "1" : "0");
      } catch {
        /* best-effort */
      }
    }
  };

  private onHeaderKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.toggleCollapsed();
    }
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    this.detachListeners();
  }

  updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("gateway")) {
      this.detachListeners();
      this.attachListeners();
      void this.fetch();
    }
    if (changed.has("filter") || changed.has("limit")) {
      // Filter is server-side; re-fetch.  Limit changes also re-fetch.
      void this.fetch();
    }
  }

  private attachListeners() {
    // Re-fetch on window focus.  Completed runs don't change in the middle,
    // but new completions can arrive while we're away from the tab.
    this.focusHandler = () => { void this.fetch(); };
    window.addEventListener("focus", this.focusHandler);

    // Re-fetch when the tab becomes visible.
    this.visibilityHandler = () => {
      if (document.visibilityState === "visible") void this.fetch();
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);

    // Slow background re-fetch while the tab is visible.  Completed runs
    // don't change once written, but new ones can land.
    this.idleTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void this.fetch();
    }, SubagentHistoryFeed.IDLE_FETCH_MS);

    // Listen for live subagent completion events on the gateway event bus
    // (when available) — those signal the moment a new history entry just
    // got written, so we want to pick it up immediately.
    if (this.gateway) {
      this.unsubscribe = this.gateway.subscribe((evt) => {
        if (
          evt.event === "subagent.complete" ||
          evt.event === "subagent.error" ||
          evt.event === "subagent.timeout"
        ) {
          // Small debounce — the archive write happens in the same tick as
          // the event, but reading the disk is async, so wait briefly.
          window.setTimeout(() => void this.fetch(), 300);
        }
      });
    }
  }

  private detachListeners() {
    if (this.focusHandler) window.removeEventListener("focus", this.focusHandler);
    if (this.visibilityHandler) document.removeEventListener("visibilitychange", this.visibilityHandler);
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.focusHandler = null;
    this.visibilityHandler = null;
  }

  // ── Data ──────────────────────────────────────────────────────────────

  private async fetch() {
    if (!this.gateway?.connected) return;
    this.loading = this.entries.length === 0;
    try {
      const params: Record<string, unknown> = { limit: this.limit };
      if (this.filter !== "all") params.statusFilter = [this.filter];
      const result = await this.gateway.request<HistoryListResult>(
        "subagents.history",
        params,
      );
      if (result?.ok && Array.isArray(result.history)) {
        this.entries = result.history;
        this.total = typeof result.total === "number" ? result.total : result.history.length;
        this.error = null;
      } else {
        this.error = "Failed to load history";
      }
    } catch (err) {
      console.warn("[SubagentHistoryFeed] fetch error:", err);
      if (this.entries.length === 0) {
        this.error = err instanceof Error ? err.message : "Failed to load history";
      }
    } finally {
      this.loading = false;
    }
  }

  // ── Interactions ──────────────────────────────────────────────────────

  private onRowClick(runId: string) {
    this.dispatchEvent(
      new CustomEvent("infinibot:subagent-open-detail", {
        detail: { runId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private setFilter(filter: StatusPillKey) {
    if (this.filter === filter) return;
    this.filter = filter;
  }

  private onSearchInput(e: Event) {
    this.search = (e.target as HTMLInputElement).value;
  }

  private loadMore() {
    this.limit = this.limit + this.pageSize;
  }

  /**
   * Client-side substring filter on label + task.  Filter pills are
   * server-side; search stays local so typing doesn't burn RPCs.
   */
  private get visibleEntries(): HistoryEntry[] {
    if (!this.search.trim()) return this.entries;
    const q = this.search.trim().toLowerCase();
    return this.entries.filter((e) => {
      const haystack = `${e.label ?? ""} ${e.task ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  // ── Render ────────────────────────────────────────────────────────────

  render() {
    if (this.collapsible) {
      const collapsed = this.collapsed;
      return html`
        <div class="shf-panel" part="panel">
          ${this.renderToggleBar()}
          <div
            id=${this.bodyId}
            class="shf-collapsible ${collapsed ? "is-collapsed" : ""}"
            aria-hidden=${collapsed ? "true" : "false"}
          >
            ${this.renderHeader({ omitTitle: true })}
            <div class="shf-body">
              ${this.loading && this.entries.length === 0
                ? this.renderSkeleton()
                : this.error && this.entries.length === 0
                  ? this.renderError()
                  : this.visibleEntries.length === 0
                    ? this.renderEmpty()
                    : this.renderRows()}
            </div>
            ${this.renderFooter()}
          </div>
        </div>
      `;
    }
    return html`
      <div class="shf-panel" part="panel">
        ${this.renderHeader()}
        <div class="shf-body">
          ${this.loading && this.entries.length === 0
            ? this.renderSkeleton()
            : this.error && this.entries.length === 0
              ? this.renderError()
              : this.visibleEntries.length === 0
                ? this.renderEmpty()
                : this.renderRows()}
        </div>
        ${this.renderFooter()}
      </div>
    `;
  }

  /** Latest endedAt across loaded entries, for the collapsed summary line. */
  private get latestEndedAt(): number | null {
    if (this.entries.length === 0) return null;
    let max = 0;
    for (const e of this.entries) {
      if (e.endedAt && e.endedAt > max) max = e.endedAt;
    }
    return max || null;
  }

  private renderToggleBar() {
    const collapsed = this.collapsed;
    const count = this.total;
    const latest = this.latestEndedAt;
    const summary = collapsed
      ? count === 0
        ? "No completed runs yet"
        : `${count} completed run${count === 1 ? "" : "s"}${latest ? ` · last ${formatRelative(latest)}` : ""}`
      : "";
    return html`
      <div
        class="shf-toggle-bar ${collapsed ? "is-collapsed" : ""}"
        role="button"
        tabindex="0"
        aria-expanded=${collapsed ? "false" : "true"}
        aria-controls=${this.bodyId}
        @click=${this.toggleCollapsed}
        @keydown=${this.onHeaderKey}
      >
        <span class="shf-chevron ${collapsed ? "is-collapsed" : ""}" aria-hidden="true">
          ${icons.chevronDown}
        </span>
        <div class="shf-title">
          <span class="shf-title-icon">${icons.clockRotate}</span>
          <span>Sub-Agent History</span>
        </div>
        <span class="shf-count-badge" title="Total entries available">
          ${count}
        </span>
        ${collapsed
          ? html`<span class="shf-summary" title=${summary}>${summary}</span>`
          : nothing}
      </div>
    `;
  }

  private renderHeader(opts: { omitTitle?: boolean } = {}) {
    const pills: Array<{ key: StatusPillKey; label: string; cls: string }> = [
      { key: "all",      label: "All",       cls: "all" },
      { key: "complete", label: "Completed", cls: "complete" },
      { key: "error",    label: "Errors",    cls: "error" },
      { key: "timeout",  label: "Timeouts",  cls: "timeout" },
    ];
    return html`
      <div class="shf-header">
        <div class="shf-header-left">
          ${opts.omitTitle ? nothing : html`
            <div class="shf-title">
              <span class="shf-title-icon">${icons.clockRotate}</span>
              <span>Sub-Agent History</span>
            </div>
            <span class="shf-count-badge" title="Total entries available">
              ${this.total}
            </span>
          `}
          <div class="shf-pills" role="tablist" aria-label="Status filter">
            ${pills.map(
              (p) => html`
                <button
                  role="tab"
                  aria-selected=${this.filter === p.key ? "true" : "false"}
                  class="shf-pill ${p.cls} ${this.filter === p.key ? "active" : ""}"
                  @click=${() => this.setFilter(p.key)}
                >${p.label}</button>
              `,
            )}
          </div>
        </div>
        <input
          class="shf-search"
          type="search"
          aria-label="Search sub-agent history"
          placeholder="Search label or task…"
          .value=${this.search}
          @input=${(e: Event) => this.onSearchInput(e)}
        />
      </div>
    `;
  }

  private renderSkeleton() {
    return html`
      ${Array.from({ length: 4 }, () => html`<div class="shf-skel"></div>`)}
    `;
  }

  private renderError() {
    return html`
      <div class="shf-error">
        ${this.error ?? "Failed to load"}
        <div>
          <button class="shf-retry-btn" @click=${() => void this.fetch()}>Retry</button>
        </div>
      </div>
    `;
  }

  private renderEmpty() {
    return html`
      <div class="shf-empty">
        No completed sub-agents yet — finished runs will show up here.
      </div>
    `;
  }

  private renderRows() {
    return html`
      ${repeat(
        this.visibleEntries,
        (e) => e.runId,
        (e) => this.renderRow(e),
      )}
    `;
  }

  private renderRow(entry: HistoryEntry) {
    const label = entry.label || "Sub-Agent";
    const taskPreview = truncate(entry.task || "", 80);
    return html`
      <div
        class="shf-row"
        role="button"
        tabindex="0"
        data-run-id=${entry.runId}
        title="Click to open full detail"
        @click=${() => this.onRowClick(entry.runId)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.onRowClick(entry.runId);
          }
        }}
      >
        ${this.renderPill(entry.status)}
        <div class="shf-row-meta">
          <div class="shf-row-label-row">
            ${this.renderBackendChip(entry.coderBackend)}
            <span class="shf-row-label">${label}</span>
            ${this.renderNodeTag(entry)}
          </div>
          ${taskPreview
            ? html`<div class="shf-row-task">${taskPreview}</div>`
            : nothing}
        </div>
        <div class="shf-row-duration" title="Run duration">
          ${formatDuration(entry.startedAt, entry.endedAt)}
        </div>
        <div class="shf-row-time" title=${new Date(entry.endedAt).toLocaleString()}>
          ${formatRelative(entry.endedAt)}
        </div>
      </div>
    `;
  }

  /**
   * Small CLI-provider chip rendered to the LEFT of the row label, mirroring
   * the running-agent badges. Returns nothing when the backend doesn't resolve
   * to a known brand (legacy / native rows), so those rows render unchanged.
   */
  private renderBackendChip(backend: string | undefined) {
    const icon = getCoderBackendIcon(backend);
    if (!icon) return nothing;
    const label = getCoderBackendIconLabel(backend);
    const brand = getCoderBackendBrand(backend);
    return html`
      <span
        class="shf-row-backend"
        title=${label}
        aria-label=${label}
        style="color:${brand.accent};background:${brand.tone};"
      >${icon}</span>
    `;
  }

  private renderNodeTag(entry: HistoryEntry) {
    if (!entry.remote || (!entry.nodeId && !entry.nodeName)) return nothing;
    const raw = entry.nodeName || entry.nodeId!.slice(0, 6);
    const name = raw.length > 12 ? raw.slice(0, 12) + "…" : raw;
    const tooltip = `Node: ${entry.nodeName || entry.nodeId}`;
    return html`<span class="shf-node-tag" title=${tooltip}>${_histNodeIcon}${name}</span>`;
  }

  private renderPill(status: HistoryStatus) {
    const icon =
      status === "complete" ? icons.checkCircle
      : status === "error" ? icons.xCircle
      : icons.clockRotate;
    return html`
      <span class="shf-row-pill ${status}">
        ${icon}
        ${STATUS_LABEL[status]}
      </span>
    `;
  }

  private renderFooter() {
    const visibleCount = this.visibleEntries.length;
    // "More" makes sense when the server has more entries than we currently
    // hold.  We use total (server-side, before the client-side search
    // filter) so the button reflects what we can pull, not what's filtered.
    const hasMore = this.entries.length >= this.limit && this.entries.length < this.total;
    if (!hasMore && visibleCount === 0) return nothing;
    if (!hasMore) return nothing;
    return html`
      <div class="shf-footer">
        <button
          class="shf-more-btn"
          ?disabled=${this.loading}
          @click=${() => this.loadMore()}
        >${this.loading ? "Loading…" : "Load more"}</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "subagent-history-feed": SubagentHistoryFeed;
  }
}
