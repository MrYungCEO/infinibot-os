/**
 * Discipline Alert — clock-anchored sliding notification component.
 *
 * Mounts via window CustomEvent "discipline:alert". Appears below the
 * bubble clock (topbar-center) with a slide-down + glow animation.
 *
 * Usage (from discipline-notify.ts):
 *   window.dispatchEvent(new CustomEvent("discipline:alert", {
 *     detail: { kind, block, message, durationMs }
 *   }));
 */

import { html, nothing, type TemplateResult } from "lit";

export type DisciplineAlertKind =
  | "block-warning-5"   // 5-min warning before block start
  | "block-start"       // block just started
  | "block-end"         // block window closed
  | "block-missed"      // no activity detected in an active block
  | "day-summary";      // end-of-day digest

export interface DisciplineAlertPayload {
  kind: DisciplineAlertKind;
  /** Short human-readable label (e.g. block name). */
  label: string;
  /** Full message body. */
  message: string;
  /** Auto-dismiss after this many ms (default: 8000). */
  durationMs?: number;
}

export interface ActiveDisciplineAlert {
  id: string;
  payload: DisciplineAlertPayload;
  enteredAt: number;
  /** When true the element is animating out (slide-up). */
  dismissing: boolean;
}

export interface DisciplineAlertState {
  alerts: ActiveDisciplineAlert[];
}

const DEFAULT_DURATION = 8_000;
let _alertUpdateFn: (() => void) | null = null;
let _nextId = 0;

/** Call once at app boot to wire the window event listener. */
export function initDisciplineAlerts(
  state: DisciplineAlertState,
  requestUpdate: () => void,
): void {
  _alertUpdateFn = requestUpdate;
  window.addEventListener("discipline:alert", (e: Event) => {
    const detail = (e as CustomEvent<DisciplineAlertPayload>).detail;
    if (!detail?.kind) return;
    const id = `da-${++_nextId}`;
    const alert: ActiveDisciplineAlert = {
      id,
      payload: detail,
      enteredAt: Date.now(),
      dismissing: false,
    };
    state.alerts = [alert, ...state.alerts].slice(0, 4); // max 4 stacked
    requestUpdate();

    const dur = detail.durationMs ?? DEFAULT_DURATION;
    if (dur > 0) {
      setTimeout(() => dismissAlert(state, id, requestUpdate), dur);
    }
  });
}

export function dismissAlert(
  state: DisciplineAlertState,
  id: string,
  requestUpdate: () => void,
): void {
  const alert = state.alerts.find((a) => a.id === id);
  if (!alert || alert.dismissing) return;
  alert.dismissing = true;
  requestUpdate();
  // Remove after slide-out animation completes (~300ms)
  setTimeout(() => {
    state.alerts = state.alerts.filter((a) => a.id !== id);
    requestUpdate();
  }, 350);
}

const KIND_ICON: Record<DisciplineAlertKind, string> = {
  "block-warning-5": "⏰",
  "block-start": "🟢",
  "block-end": "⏹️",
  "block-missed": "⚠️",
  "day-summary": "📊",
};

const KIND_COLOR: Record<DisciplineAlertKind, string> = {
  "block-warning-5": "var(--g-primary, #7fff7f)",
  "block-start": "#10B981",
  "block-end": "#6B7280",
  "block-missed": "#EF4444",
  "day-summary": "#8B5CF6",
};

export function renderDisciplineAlerts(
  state: DisciplineAlertState,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  if (!state.alerts.length) return nothing;

  return html`
    <div class="disc-alerts-anchor" role="status" aria-live="polite" aria-atomic="false">
      <style>
        .disc-alerts-anchor {
          position: fixed;
          top: 52px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 1050;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          pointer-events: none;
        }
        .disc-alert {
          pointer-events: auto;
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 14px;
          border-radius: 12px;
          background: rgba(15, 15, 25, 0.92);
          backdrop-filter: blur(12px) saturate(1.4);
          -webkit-backdrop-filter: blur(12px) saturate(1.4);
          border: 1px solid rgba(255,255,255,0.12);
          box-shadow:
            0 4px 24px rgba(0,0,0,0.5),
            0 0 0 0 transparent;
          min-width: 280px;
          max-width: 380px;
          font-family: var(--g-font-family, "Inter", sans-serif);
          font-size: 13px;
          color: var(--g-fg, #f5eacd);
          animation: disc-alert-in 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        .disc-alert--dismissing {
          animation: disc-alert-out 0.32s ease-in both;
        }
        .disc-alert--block-start,
        .disc-alert--block-warning-5 {
          box-shadow:
            0 4px 24px rgba(0,0,0,0.5),
            0 0 16px -2px var(--disc-alert-color, var(--g-primary, #7fff7f));
        }
        .disc-alert--block-missed {
          box-shadow:
            0 4px 24px rgba(0,0,0,0.5),
            0 0 16px -2px #EF4444;
        }
        .disc-alert-icon {
          font-size: 18px;
          line-height: 1;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .disc-alert-body {
          flex: 1;
          min-width: 0;
        }
        .disc-alert-label {
          font-weight: 600;
          letter-spacing: 0.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-bottom: 2px;
        }
        .disc-alert-message {
          opacity: 0.75;
          font-size: 12px;
          line-height: 1.4;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .disc-alert-close {
          background: none;
          border: none;
          color: var(--g-fg, #f5eacd);
          opacity: 0.45;
          cursor: pointer;
          padding: 0;
          font-size: 16px;
          line-height: 1;
          flex-shrink: 0;
          margin-top: -1px;
          transition: opacity 0.15s;
        }
        .disc-alert-close:hover { opacity: 0.9; }
        @keyframes disc-alert-in {
          from { opacity: 0; transform: translateY(-14px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes disc-alert-out {
          from { opacity: 1; transform: translateY(0) scale(1); max-height: 80px; }
          to   { opacity: 0; transform: translateY(-10px) scale(0.94); max-height: 0; padding: 0; margin: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .disc-alert { animation: none !important; }
          .disc-alert--dismissing { animation: none !important; opacity: 0; }
        }
      </style>
      ${state.alerts.map(
        (alert) => html`
          <div
            class="disc-alert disc-alert--${alert.payload.kind} ${alert.dismissing ? "disc-alert--dismissing" : ""}"
            style="--disc-alert-color: ${KIND_COLOR[alert.payload.kind] ?? "var(--g-primary)"};"
            role="alert"
          >
            <span class="disc-alert-icon" aria-hidden="true">
              ${KIND_ICON[alert.payload.kind] ?? "•"}
            </span>
            <div class="disc-alert-body">
              <div class="disc-alert-label">${alert.payload.label}</div>
              ${alert.payload.message
                ? html`<div class="disc-alert-message">${alert.payload.message}</div>`
                : nothing}
            </div>
            <button
              class="disc-alert-close"
              title="Dismiss"
              aria-label="Dismiss alert"
              @click=${() => dismissAlert(state, alert.id, requestUpdate)}
            >×</button>
          </div>
        `,
      )}
    </div>
  `;
}

/** Fire a discipline alert window event from anywhere in the UI. */
export function fireDisciplineAlert(detail: DisciplineAlertPayload): void {
  window.dispatchEvent(new CustomEvent("discipline:alert", { detail }));
}
