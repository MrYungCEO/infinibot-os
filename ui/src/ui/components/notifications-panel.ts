import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import type { AppNotification, NotificationsState } from "../controllers/notifications";
import {
  dismissNotification,
  clearAllNotifications,
  clearNotificationHistory,
  toggleNotificationHistory,
} from "../controllers/notifications";
import type { GatewayBrowserClient } from "../gateway";
import { TIER_META, type PopupEvent } from "./proactive-popup-shared";
import {
  initAlertsBacklog,
  getBacklogEvents,
  ackAlert,
  clearAllAlerts,
} from "../controllers/alerts-backlog";

type FilterKind = "all" | AppNotification["type"];

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1_000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const KIND_LABELS: Record<string, string> = {
  success: "Success",
  info: "Info",
  warning: "Warning",
  error: "Error",
  completion: "Agent",
  spawn: "Spawn",
};

const KIND_DOT: Record<string, string> = {
  success: "#22c55e",
  info: "#06b6d4",
  warning: "#f59e0b",
  error: "#ef4444",
  completion: "var(--g-primary, #6366f1)",
  spawn: "#8b5cf6",
};

const RECENT_MS = 30 * 60 * 1_000; // 30 minutes

const FILTER_ORDER: FilterKind[] = [
  "all",
  "success",
  "info",
  "warning",
  "error",
  "completion",
  "spawn",
];

@customElement("notifications-panel")
export class NotificationsPanel extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) notifState!: NotificationsState;
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /**
   * Keep the visibility trigger primitive and reactive. `notifState` is the
   * long-lived app instance, so mutating notificationHistoryOpen on it does
   * not change the object identity Lit compares for child updates.
   */
  @property({ type: Boolean }) open = false;
  @state() private _filter: FilterKind = "all";

  /** Unbinder for the persisted alerts-backlog change listener. */
  private _unbindBacklog: (() => void) | null = null;

  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.notifState?.notificationHistoryOpen) {
      toggleNotificationHistory(this.notifState);
    }
  };

  private _onDocMouseDown = (e: MouseEvent) => {
    if (!this.notifState?.notificationHistoryOpen) return;
    const target = e.target as Node;
    if (this.contains(target)) return;
    // Allow the bell button to toggle itself via its own click handler
    const bell = document.querySelector(".notif-bell");
    if (bell && bell.contains(target)) return;
    toggleNotificationHistory(this.notifState);
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._onKeyDown);
    document.addEventListener("mousedown", this._onDocMouseDown);
    // Bind the persisted proactive backlog. Re-render this panel AND the parent
    // shell (so the bell's unread badge stays in sync) on every change.
    this._unbindBacklog = initAlertsBacklog(this.client, () => {
      this.requestUpdate();
      this.notifState?.requestUpdate?.();
    });
  }

  updated(changed: Map<string, unknown>) {
    // Late-arriving gateway client (connects after first mount) — rebind.
    if (changed.has("client") && this.client) {
      this._unbindBacklog?.();
      this._unbindBacklog = initAlertsBacklog(this.client, () => {
        this.requestUpdate();
        this.notifState?.requestUpdate?.();
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeyDown);
    document.removeEventListener("mousedown", this._onDocMouseDown);
    this._unbindBacklog?.();
    this._unbindBacklog = null;
  }

  private _renderBacklogEntry(ev: PopupEvent) {
    const meta = TIER_META[ev.tier] ?? TIER_META.FYI;
    const unread = ev.state === "pending";
    const source = ev.attribution?.agentName || ev.attribution?.agentId || "system";
    return html`
      <div
        class="np-alert${unread ? " np-alert--unread" : ""}"
        style="--tier:${meta.color};"
        role="button"
        tabindex="0"
        title=${unread ? "Click to mark read" : "Read"}
        @click=${() => { if (unread) void ackAlert(ev.id); }}
        @keydown=${(e: KeyboardEvent) => {
          if ((e.key === "Enter" || e.key === " ") && unread) { e.preventDefault(); void ackAlert(ev.id); }
        }}
      >
        <div class="np-alert-top">
          <span class="np-alert-tier">${meta.label}</span>
          <span class="np-alert-title">${ev.title}</span>
          ${unread ? html`<span class="np-alert-unread-dot" aria-label="Unread"></span>` : nothing}
          <span class="np-entry-time" title="${new Date(ev.createdAt).toLocaleString()}">${fmtTime(ev.createdAt)} · ${timeAgo(ev.createdAt)}</span>
        </div>
        ${ev.body ? html`<div class="np-alert-msg">${ev.body}</div>` : nothing}
        <div class="np-alert-src">from ${source}</div>
      </div>
    `;
  }

  private _applyFilter(items: AppNotification[]): AppNotification[] {
    return this._filter === "all"
      ? items
      : items.filter((n) => n.type === this._filter);
  }

  private _renderEntry(n: AppNotification, isLive: boolean) {
    const dot = KIND_DOT[n.type] ?? "#64748b";
    const label = KIND_LABELS[n.type] ?? n.type;
    return html`
      <div class="np-entry np-entry--${n.type}">
        <div class="np-entry-top">
          <span class="np-dot" style="background:${dot};box-shadow:0 0 6px ${dot}80;"></span>
          <span class="np-entry-kind" style="color:${dot};">${label}</span>
          <span class="np-entry-title">${n.title}</span>
          <span class="np-entry-time" title="${new Date(n.timestamp).toLocaleString()}">${fmtTime(n.timestamp)} · ${timeAgo(n.timestamp)}</span>
          ${isLive
            ? html`<button
                class="np-entry-dismiss"
                @click=${() => dismissNotification(this.notifState, n.id)}
                title="Dismiss"
                aria-label="Dismiss"
              >${icons.x}</button>`
            : nothing}
        </div>
        <div class="np-entry-msg">${n.message}</div>
        ${n.action
          ? html`<button
              class="np-action-btn"
              @click=${() => {
                n.action!.callback();
                toggleNotificationHistory(this.notifState);
              }}
            >${n.action.label}</button>`
          : nothing}
      </div>
    `;
  }

  render() {
    if (!this.open) return nothing;

    const history = this.notifState.notificationHistory ?? [];
    const active = (this.notifState.notifications ?? []).filter((n) => !n.dismissed);
    const now = Date.now();

    const dismissed = history.filter((n) => n.dismissed);
    const recentDismissed = dismissed.filter((n) => now - n.timestamp < RECENT_MS);
    const olderDismissed = dismissed.filter((n) => now - n.timestamp >= RECENT_MS);

    const filteredActive = this._applyFilter(active);
    const filteredRecent = this._applyFilter(recentDismissed);
    const filteredOlder = this._applyFilter(olderDismissed);

    // Persisted proactive backlog (survives restart) — only shown on the "All"
    // filter; the kind chips filter the ephemeral client notifications.
    const backlog = getBacklogEvents();
    const showBacklog = this._filter === "all" && backlog.length > 0;
    const unreadAlerts = backlog.reduce((n, e) => (e.state === "pending" ? n + 1 : n), 0);

    const isEmpty =
      filteredActive.length === 0 &&
      filteredRecent.length === 0 &&
      filteredOlder.length === 0 &&
      !showBacklog;

    return html`
      <div class="np-panel" role="dialog" aria-label="Notifications panel">
        <!-- Header -->
        <div class="np-header">
          <div class="np-header-left">
            <svg class="np-header-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            <span class="np-title">Notifications</span>
            ${active.length > 0
              ? html`<span class="np-live-count">${active.length}</span>`
              : nothing}
          </div>
          <div class="np-header-actions">
            ${backlog.length > 0
              ? html`<button class="np-btn-sm" @click=${() => void clearAllAlerts()}>Clear alerts</button>`
              : nothing}
            ${active.length > 0
              ? html`<button class="np-btn-sm" @click=${() => clearAllNotifications(this.notifState)}>Clear active</button>`
              : nothing}
            ${history.length > 0
              ? html`<button class="np-btn-sm" @click=${() => clearNotificationHistory(this.notifState)}>Clear history</button>`
              : nothing}
            <button
              class="np-btn-close"
              @click=${() => toggleNotificationHistory(this.notifState)}
              aria-label="Close notifications"
            >${icons.x}</button>
          </div>
        </div>

        <!-- Filter chips -->
        <div class="np-filters" role="group" aria-label="Filter notifications">
          ${FILTER_ORDER.map(
            (f) => html`
              <button
                class="np-chip${this._filter === f ? " np-chip--active" : ""}"
                @click=${() => { this._filter = f; }}
                aria-pressed=${this._filter === f ? "true" : "false"}
              >${f === "all" ? "All" : (KIND_LABELS[f] ?? f)}</button>
            `,
          )}
        </div>

        <!-- Body -->
        <div class="np-body">
          ${isEmpty
            ? html`<div class="np-empty">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.5" opacity="0.3" aria-hidden="true">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                <span>No alerts</span>
              </div>`
            : nothing}

          ${showBacklog
            ? html`
              <div class="np-section-label">
                <span class="np-section-dot np-section-dot--alert"></span>Alerts backlog${unreadAlerts > 0 ? html` · <span class="np-unread-pill">${unreadAlerts} new</span>` : nothing}
              </div>
              ${backlog.map((ev) => this._renderBacklogEntry(ev))}`
            : nothing}

          ${filteredActive.length > 0
            ? html`
              <div class="np-section-label">
                <span class="np-section-dot np-section-dot--live"></span>Live
              </div>
              ${filteredActive.map((n) => this._renderEntry(n, true))}`
            : nothing}

          ${filteredRecent.length > 0
            ? html`
              <div class="np-section-label">Recent (last 30 min)</div>
              ${filteredRecent.map((n) => this._renderEntry(n, false))}`
            : nothing}

          ${filteredOlder.length > 0
            ? html`
              <div class="np-section-label">History</div>
              ${filteredOlder.map((n) => this._renderEntry(n, false))}`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "notifications-panel": NotificationsPanel;
  }
}
