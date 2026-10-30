import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppNotification, NotificationsState } from "../controllers/notifications";
import {
  dismissNotification,
  pauseNotificationTimer,
  resumeNotificationTimer,
} from "../controllers/notifications";

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1_000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

type KindMeta = { border: string; glow: string; bar: string };
const KIND: Record<string, KindMeta> = {
  success: {
    border: "rgba(34,197,94,0.75)",
    glow: "0 0 24px rgba(34,197,94,0.18)",
    bar: "#22c55e",
  },
  info: {
    border: "rgba(6,182,212,0.75)",
    glow: "0 0 24px rgba(6,182,212,0.18)",
    bar: "#06b6d4",
  },
  warning: {
    border: "rgba(245,158,11,0.75)",
    glow: "0 0 24px rgba(245,158,11,0.18)",
    bar: "#f59e0b",
  },
  error: {
    border: "rgba(239,68,68,0.75)",
    glow: "0 0 24px rgba(239,68,68,0.18)",
    bar: "#ef4444",
  },
  completion: {
    border: "color-mix(in srgb, var(--g-primary, #6366f1) 75%, transparent)",
    glow: "0 0 24px color-mix(in srgb, var(--g-primary, #6366f1) 25%, transparent)",
    bar: "var(--g-primary, #6366f1)",
  },
  spawn: {
    border: "rgba(139,92,246,0.75)",
    glow: "0 0 24px rgba(139,92,246,0.18)",
    bar: "#8b5cf6",
  },
};

@customElement("glass-notification")
export class GlassNotification extends LitElement {
  // Light DOM — inherits global stylesheet so .gn-* classes are visible
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) notification!: AppNotification;
  @property({ type: Object }) notifState!: NotificationsState;

  @state() private _remaining = 0;
  @state() private _paused = false;
  @state() private _exiting = false;

  private _interval: ReturnType<typeof setInterval> | null = null;

  connectedCallback() {
    super.connectedCallback();
    this._remaining = this.notification.duration;
    if (this.notification.duration > 0) this._startInterval();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopInterval();
  }

  private _startInterval() {
    this._stopInterval();
    const tick = 80;
    this._interval = setInterval(() => {
      this._remaining = Math.max(0, this._remaining - tick);
      this.requestUpdate();
    }, tick);
  }

  private _stopInterval() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  private _onMouseEnter() {
    if (this.notification.duration === 0 || this._exiting) return;
    const remaining = pauseNotificationTimer(this.notification.id);
    this._remaining = remaining;
    this._stopInterval();
    this._paused = true;
  }

  private _onMouseLeave() {
    if (this.notification.duration === 0 || this._exiting) return;
    this._paused = false;
    resumeNotificationTimer(this.notifState, this.notification.id, this._remaining);
    this._startInterval();
  }

  private _dismiss() {
    if (this._exiting) return;
    this._exiting = true;
    this._stopInterval();
    pauseNotificationTimer(this.notification.id);
    setTimeout(() => dismissNotification(this.notifState, this.notification.id), 260);
  }

  render() {
    const n = this.notification;
    const meta = KIND[n.type] ?? KIND.info;
    const progressPct =
      n.duration > 0
        ? Math.max(0, Math.min(100, (this._remaining / n.duration) * 100))
        : 100;

    // Per-agent accent overrides the type-default for spawn/completion toasts
    // so each agent has its own colored glow. Falls back to the type meta.
    const accent = n.accentColor;
    const borderColor = accent
      ? `color-mix(in srgb, ${accent} 75%, transparent)`
      : meta.border;
    const glow = accent
      ? `0 0 28px color-mix(in srgb, ${accent} 28%, transparent)`
      : meta.glow;
    const barColor = accent ?? meta.bar;
    const cardStyle = [
      `border-color:${borderColor}`,
      `box-shadow:${glow}, 0 10px 38px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)`,
      // Gradient border accent (top edge picks up agent color).
      accent
        ? `background-image:linear-gradient(rgba(8,8,12,0.78),rgba(8,8,12,0.86)),linear-gradient(120deg, color-mix(in srgb, ${accent} 42%, transparent), rgba(255,255,255,0.04) 50%, color-mix(in srgb, ${accent} 22%, transparent))`
        : "",
      accent ? "background-origin:border-box;background-clip:padding-box, border-box" : "",
    ]
      .filter(Boolean)
      .join(";");

    // Avatar: 2-char glyph from the agentId or the type icon, tinted with the accent.
    const initials = n.agentId
      ? n.agentId.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || (n.icon ?? "•")
      : null;

    return html`
      <div
        class="gn-card gn-card--${n.type}${this._exiting ? " gn-card--exit" : ""}${accent ? " gn-card--accented" : ""}"
        style="${cardStyle}"
        @mouseenter=${this._onMouseEnter}
        @mouseleave=${this._onMouseLeave}
        role="alert"
        aria-live="polite"
      >
        <span class="gn-corner gn-corner--tl" aria-hidden="true"></span>
        <span class="gn-corner gn-corner--tr" aria-hidden="true"></span>

        <div class="gn-header">
          ${initials
            ? html`<span
                class="gn-avatar"
                style="background:color-mix(in srgb, ${accent ?? "#94a3b8"} 22%, rgba(0,0,0,0.4));color:${accent ?? "#cbd5e1"};border:1px solid color-mix(in srgb, ${accent ?? "#94a3b8"} 55%, transparent);box-shadow:0 0 12px color-mix(in srgb, ${accent ?? "#94a3b8"} 30%, transparent);"
                title=${n.agentId ?? ""}
              >${initials}</span>`
            : html`<span class="gn-icon">${n.icon}</span>`}
          <span class="gn-title">${n.title}</span>
          <span class="gn-time">${timeAgo(n.timestamp)}</span>
          <button
            class="gn-close"
            @click=${this._dismiss}
            title="Dismiss"
            aria-label="Dismiss notification"
          >✕</button>
        </div>

        <div class="gn-message">${n.message}</div>

        ${n.action
          ? html`
            <button
              class="gn-action"
              @click=${() => {
                n.action!.callback();
                this._dismiss();
              }}
            >${n.action.label}</button>`
          : nothing}

        ${n.duration > 0
          ? html`
            <div class="gn-progress-track${this._paused ? " gn-progress-track--paused" : ""}">
              <div
                class="gn-progress-bar"
                style="width:${progressPct}%;background:${barColor};"
              ></div>
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "glass-notification": GlassNotification;
  }
}
