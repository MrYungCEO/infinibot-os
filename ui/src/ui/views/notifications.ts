/**
 * Global notification overlay + bell — delegates rendering to glass-notification
 * custom elements. The functions here remain the public API called by app-render.ts.
 */
import { html, nothing } from "lit";
import { ensureCommunicationGlassStyles } from "./communication-glass";
import { icons } from "../icons";
import type { AppNotification, NotificationsState } from "../controllers/notifications";
import {
  dismissNotification,
  getActiveNotifications,
  getActiveCount,
  toggleNotificationHistory,
  clearNotificationHistory,
} from "../controllers/notifications";
import { getUnackedCount } from "../controllers/alerts-backlog";
// Register custom elements (side-effect imports)
import "../components/notification-stack";
import "../components/notifications-panel";

/* ------------------------------------------------------------------ */
/*  Time-ago helper                                                   */
/* ------------------------------------------------------------------ */
function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 5000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/* ------------------------------------------------------------------ */
/*  Color accents per type                                            */
/* ------------------------------------------------------------------ */
function accentForType(type: AppNotification["type"]): string {
  switch (type) {
    case "success": return "rgba(34,197,94,0.6)";
    case "error": return "rgba(239,68,68,0.6)";
    case "warning": return "rgba(245,158,11,0.6)";
    case "info": return "rgba(59,130,246,0.6)";
    case "completion": return "color-mix(in srgb, var(--g-primary) 50%, transparent)";
  }
}

/* ------------------------------------------------------------------ */
/*  Single toast card                                                 */
/* ------------------------------------------------------------------ */
function renderToast(state: NotificationsState, n: AppNotification) {
  const borderColor = accentForType(n.type);

  return html`
    <div
      class="notif-toast notif-toast--${n.type}"
      style="--notif-accent:${borderColor}"
    >
      <div class="notif-toast__header">
        <span class="notif-toast__icon">${n.icon}</span>
        <span class="notif-toast__title">${n.title}</span>
        <span class="notif-toast__time">${timeAgo(n.timestamp)}</span>
        <button
          class="notif-toast__close"
          @click=${() => dismissNotification(state, n.id)}
          title="Dismiss"
        >${icons.x}</button>
      </div>
      <div class="notif-toast__message">${n.message}</div>
      ${n.progress != null && n.progress >= 0
        ? html`<div class="notif-toast__progress"><div class="notif-toast__progress-bar" style="width:${n.progress}%"></div></div>`
        : nothing}
      ${n.action
        ? html`<button class="notif-toast__action" @click=${n.action.callback}>${n.action.label}</button>`
        : nothing}
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/*  Toast overlay (top-right, fixed) — now uses glass-notification    */
/* ------------------------------------------------------------------ */
export function renderNotificationOverlay(state: NotificationsState) {
  ensureCommunicationGlassStyles();
  return html`<notification-stack .notifState=${state}></notification-stack>`;
}

/* ------------------------------------------------------------------ */
/*  Notification bell + badge (for topbar)                            */
/* ------------------------------------------------------------------ */
export function renderNotificationBell(state: NotificationsState) {
  ensureCommunicationGlassStyles();
  // Badge = live ephemeral toasts + unacked persisted proactive alerts (backlog).
  const count = getActiveCount(state) + getUnackedCount();
  const isOpen = state.notificationHistoryOpen;
  const client = (state as unknown as { client?: unknown }).client ?? null;

  return html`
    <button
      class="pill notif-bell${isOpen ? " notif-bell--open" : ""}"
      style="cursor:pointer; border:none; position:relative; display:flex; align-items:center; justify-content:center; padding:6px 8px;"
      @click=${() => toggleNotificationHistory(state)}
      title="Notifications"
      aria-label="Notifications"
      aria-expanded=${isOpen ? "true" : "false"}
      aria-haspopup="dialog"
    >
      <!-- Lucide-style bell SVG — no library needed -->
      <svg
        class="notif-bell__icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      ${count > 0
        ? html`<span class="notif-bell__badge${count > 0 ? " notif-bell__badge--pulse" : ""}">${count > 9 ? "9+" : count}</span>`
        : nothing}
    </button>
    <notifications-panel
      .notifState=${state}
      .client=${client}
      .open=${isOpen}
    ></notifications-panel>
  `;
}

/* ------------------------------------------------------------------ */
/*  History dropdown panel                                            */
/* ------------------------------------------------------------------ */
function renderNotificationHistoryPanel(state: NotificationsState) {
  const history = state.notificationHistory;

  return html`
    <div class="notif-history-panel">
      <div class="notif-history-panel__header">
        <span class="notif-history-panel__title">Notifications</span>
        ${history.length > 0
          ? html`<button class="notif-history-panel__clear" @click=${() => clearNotificationHistory(state)}>Clear all</button>`
          : nothing}
      </div>
      <div class="notif-history-panel__list">
        ${history.length === 0
          ? html`<div class="notif-history-panel__empty">No notifications yet</div>`
          : history.map((n) => html`
            <div class="notif-history-item notif-history-item--${n.type}" style="border-left:2px solid ${accentForType(n.type)};">
              <div class="notif-history-item__top">
                <span>${n.icon} ${n.title}</span>
                <span class="notif-history-item__time">${timeAgo(n.timestamp)}</span>
              </div>
              <div class="notif-history-item__msg">${n.message}</div>
              ${n.action
                ? html`<button class="notif-toast__action" @click=${() => { n.action!.callback(); toggleNotificationHistory(state); }}>${n.action.label}</button>`
                : nothing}
            </div>
          `)}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/*  Styles (injected once)                                            */
/* ------------------------------------------------------------------ */
let stylesInjected = false;

export function injectNotificationStyles(): void {
  if (stylesInjected) { ensureCommunicationGlassStyles(); return; }
  stylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
/* ---- Toast overlay ---- */
.notif-overlay {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 400px;
  width: 380px;
}

/* ---- Toast card ---- */
.notif-toast {
  pointer-events: auto;
  background: rgba(10, 10, 10, 0.92);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px;
  padding: 12px 14px;
  animation: notif-slide-in 0.3s ease-out forwards;
  transition: opacity 0.25s ease, transform 0.25s ease;
  font-family: inherit;
  color: #e0e0e0;
}

.notif-toast--completion {
  border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
}

@keyframes notif-slide-in {
  from { opacity: 0; transform: translateX(100%); }
  to   { opacity: 1; transform: translateX(0); }
}

.notif-toast__header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.notif-toast__icon {
  font-size: 15px;
  flex-shrink: 0;
}

.notif-toast__title {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #fff;
}

.notif-toast__time {
  font-size: 11px;
  color: rgba(255,255,255,0.35);
  flex-shrink: 0;
}

.notif-toast__close {
  background: none;
  border: none;
  color: rgba(255,255,255,0.3);
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
  line-height: 1;
  transition: color 0.15s;
  flex-shrink: 0;
}
.notif-toast__close:hover { color: #fff; }

.notif-toast__message {
  font-size: 12px;
  color: rgba(255,255,255,0.6);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.notif-toast__progress {
  margin-top: 6px;
  height: 3px;
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
  overflow: hidden;
}
.notif-toast__progress-bar {
  height: 100%;
  background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 50%, transparent), color-mix(in srgb, var(--g-primary) 80%, transparent));
  border-radius: 2px;
  transition: width 0.3s ease;
}

.notif-toast__action {
  margin-top: 6px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 5px;
  color: color-mix(in srgb, var(--g-primary) 85%, transparent);
  font-size: 11px;
  font-weight: 500;
  padding: 3px 10px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.notif-toast__action:hover {
  background: color-mix(in srgb, var(--g-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
}

/* ---- Bell ---- */
.notif-bell {
  position: relative;
}
.notif-bell__badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #ef4444;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 8px;
  padding: 0 3px;
  pointer-events: none;
}

/* ---- History panel ---- */
.notif-history-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  width: 360px;
  max-height: 420px;
  background: rgba(10, 10, 10, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  z-index: 10000;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: notif-panel-in 0.2s ease-out forwards;
}

@keyframes notif-panel-in {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.notif-history-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

.notif-history-panel__title {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}

.notif-history-panel__clear {
  background: none;
  border: none;
  color: color-mix(in srgb, var(--g-primary) 70%, transparent);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 0.15s;
}
.notif-history-panel__clear:hover {
  background: color-mix(in srgb, var(--g-primary) 10%, transparent);
}

.notif-history-panel__list {
  overflow-y: auto;
  flex: 1;
  padding: 6px;
}

.notif-history-panel__empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: rgba(255,255,255,0.3);
}

.notif-history-item {
  padding: 8px 10px;
  margin-bottom: 4px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  transition: background 0.15s;
}
.notif-history-item:hover {
  background: rgba(255,255,255,0.04);
}

.notif-history-item__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 500;
  color: #e0e0e0;
  margin-bottom: 2px;
}

.notif-history-item__time {
  font-size: 10px;
  color: rgba(255,255,255,0.3);
  flex-shrink: 0;
}

.notif-history-item__msg {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Premium communication-glass finish. */
.notif-overlay { gap:10px; width:min(380px,calc(100vw - 32px)); }
.notif-toast {
  position:relative; overflow:hidden; padding:13px 15px 13px 17px;
  color:var(--glass-fg,var(--g-fg,#f5f5f4)); border-radius:var(--glass-radius,14px)!important;
  font-family:var(--glass-font,var(--font-ui,Inter,-apple-system,sans-serif));
}
.notif-toast::before {
  content:""; position:absolute; inset:0 auto 0 0; width:3px;
  background:var(--notif-accent,var(--glass-gold)); box-shadow:0 0 16px var(--notif-accent,var(--glass-gold));
}
.notif-toast__title,.notif-history-panel__title { color:var(--glass-fg); letter-spacing:var(--glass-tracking-tight,-.02em); }
.notif-toast__time,.notif-history-item__time { color:var(--glass-fg-4); font-variant-numeric:tabular-nums; }
.notif-toast__message,.notif-history-item__msg { color:var(--glass-fg-2); }
.notif-toast__close,.notif-toast__action,.notif-history-panel__clear {
  border:1px solid var(--glass-stroke)!important; border-radius:var(--glass-radius-sm,10px)!important;
  background:var(--glass-hover)!important; color:var(--glass-fg-2)!important;
}
.notif-toast__close { width:28px; height:28px; display:grid; place-items:center; padding:0; }
.notif-toast__close:hover,.notif-toast__action:hover,.notif-history-panel__clear:hover { color:var(--glass-gold-hi)!important; border-color:var(--glass-stroke-gold)!important; }
.notif-toast__progress { background:var(--glass-press); height:4px; }
.notif-toast__progress-bar { background:var(--glass-gold-fill); }
.notif-bell {
  border:1px solid var(--glass-stroke)!important; background:var(--glass-sheen),var(--glass-hover)!important;
  color:var(--glass-fg-2); box-shadow:var(--glass-elev-1); transition:transform var(--glass-dur-fast),border-color var(--glass-dur-fast),color var(--glass-dur-fast);
}
.notif-bell:hover,.notif-bell--open { color:var(--glass-gold-hi); border-color:var(--glass-stroke-gold)!important; transform:var(--glass-lift,translateY(-1px)); }
.notif-bell__badge { background:var(--glass-danger,#ef4444); color:#fff; box-shadow:0 0 0 2px var(--glass-base),0 0 12px color-mix(in srgb,var(--glass-danger,#ef4444) 55%,transparent); }
.notif-history-panel { color:var(--glass-fg); border-radius:var(--glass-radius-lg,20px)!important; }
.notif-history-panel__header { padding:14px 16px; border-color:var(--glass-stroke); }
.notif-history-panel__list { padding:8px; }
.notif-history-item {
  margin-bottom:6px; padding:10px 11px; border-radius:var(--glass-radius-sm,10px);
  background:var(--glass-3); border-top:1px solid var(--glass-stroke); border-right:1px solid var(--glass-stroke); border-bottom:1px solid var(--glass-stroke);
}
.notif-history-item:hover { background:var(--glass-hover); }
.notif-history-item__top { color:var(--glass-fg); }
.notif-history-panel__empty { color:var(--glass-fg-3); }
:where(.notif-bell,.notif-toast__close,.notif-toast__action,.notif-history-panel__clear):focus-visible { outline:none; box-shadow:var(--glass-focus-ring)!important; }

/* Live notification-stack + notifications-panel (both render in light DOM). */
.gn-card {
  background:var(--glass-sheen),var(--glass-4)!important;
  border-radius:var(--glass-radius,14px); color:var(--glass-fg);
  font-family:var(--glass-font,var(--font-ui,Inter,-apple-system,sans-serif));
  box-shadow:var(--glass-elev-4)!important;
}
.gn-corner--tl { border-top-color:var(--glass-stroke-gold); border-left-color:var(--glass-stroke-gold); }
.gn-corner--tr { border-top-color:var(--glass-stroke-gold); border-right-color:var(--glass-stroke-gold); }
.gn-title { color:var(--glass-fg); letter-spacing:var(--glass-tracking-tight,-.02em); }
.gn-time { color:var(--glass-fg-4); }
.gn-message { color:var(--glass-fg-2); }
.gn-close,.gn-action {
  border:1px solid var(--glass-stroke); border-radius:var(--glass-radius-sm,10px);
  background:var(--glass-hover); color:var(--glass-fg-2);
}
.gn-close { width:28px; height:28px; display:grid; place-items:center; padding:0; }
.gn-close:hover,.gn-action:hover { background:var(--glass-hover); color:var(--glass-gold-hi); border-color:var(--glass-stroke-gold); }
.gn-progress-track { height:3px; background:var(--glass-press); }

.np-panel {
  background:var(--glass-sheen),var(--glass-4); color:var(--glass-fg);
  border:1px solid var(--glass-stroke-strong); border-radius:var(--glass-radius-lg,20px);
  box-shadow:var(--glass-elev-4); font-family:var(--glass-font,var(--font-ui,Inter,-apple-system,sans-serif));
}
.np-header,.np-filters { border-color:var(--glass-stroke); }
.np-header-icon { color:var(--glass-gold); }
.np-title { color:var(--glass-fg); letter-spacing:var(--glass-tracking-tight,-.02em); }
.np-live-count,.np-unread-pill { background:var(--glass-gold-tint); color:var(--glass-gold-hi); border:1px solid var(--glass-stroke-gold); }
.np-btn-sm,.np-btn-close,.np-chip,.np-action-btn,.np-entry-dismiss {
  border:1px solid var(--glass-stroke); border-radius:var(--glass-radius-sm,10px);
  background:var(--glass-hover); color:var(--glass-fg-3);
}
.np-btn-close,.np-entry-dismiss { display:grid; place-items:center; }
.np-btn-sm:hover,.np-btn-close:hover,.np-chip:hover,.np-action-btn:hover,.np-entry-dismiss:hover {
  background:var(--glass-hover); border-color:var(--glass-stroke-gold); color:var(--glass-gold-hi);
}
.np-chip--active { background:var(--glass-gold-tint); border-color:var(--glass-stroke-gold); color:var(--glass-gold-hi); }
.np-section-label { color:var(--glass-fg-4); letter-spacing:var(--glass-tracking-caps,.11em); }
.np-entry,.np-alert { background:var(--glass-3); border-color:var(--glass-stroke); border-radius:var(--glass-radius-sm,10px); }
.np-entry:hover,.np-alert:hover { background:var(--glass-hover); border-color:var(--glass-stroke-gold); }
.np-entry-title,.np-alert-title { color:var(--glass-fg); }
.np-entry-time,.np-alert-src { color:var(--glass-fg-4); }
.np-entry-msg,.np-alert-msg { color:var(--glass-fg-2); }
.np-empty { color:var(--glass-fg-3); }
:where(.gn-close,.gn-action,.np-btn-sm,.np-btn-close,.np-chip,.np-action-btn,.np-entry-dismiss,.np-alert):focus-visible { outline:none; box-shadow:var(--glass-focus-ring)!important; }
@media(max-width:520px) {
  .notif-overlay { top:10px; right:10px; left:10px; width:auto; max-width:none; }
  .notif-history-panel { position:fixed; top:64px; right:10px; left:10px; width:auto; max-height:calc(100dvh - 84px); }
  .gn-stack { top:64px; right:10px; left:10px; width:auto; max-width:none; }
  .gn-card { padding:12px; }
  .np-panel { position:fixed; top:64px; right:10px; left:10px; width:auto; max-width:none; max-height:calc(100dvh - 84px); }
  .np-header { align-items:flex-start; gap:10px; }
  .np-header-actions { flex-wrap:wrap; justify-content:flex-end; }
  .np-filters { flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; }
  .np-chip { min-height:34px; flex:0 0 auto; }
}
@media(prefers-reduced-motion:reduce) { .notif-toast,.notif-history-panel { animation:none; } .notif-bell { transition:none; } }
`;
  document.head.appendChild(style);
  ensureCommunicationGlassStyles();
}
