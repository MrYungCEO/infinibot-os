/**
 * Network Control Panel
 *
 * Lit view for runtime Tailscale exposure control. Renders the live
 * tailnet status (binary detected, backend state, hostname/IP, peer
 * count) and the three primary actions: enable `tailscale serve`
 * (tailnet-only HTTPS), enable `tailscale funnel` (public via
 * funnel.ts.net), and reset both.
 *
 * Backed by gateway RPCs `network.tailscale.{status,enable,disable}`
 * (src/gateway/server-methods/network-tailscale.ts) — those wrap the
 * existing infra/tailscale.ts helpers and inherit the same sudo
 * fallback used at boot.
 */

import { html, nothing, type TemplateResult } from "lit";

export type TailscaleBackendState =
  | "NotInstalled"
  | "Running"
  | "Stopped"
  | "Starting"
  | "NoState"
  | "NeedsLogin"
  | "NeedsMachineAuth"
  | "Unreachable"
  | "Unknown"
  | string;

export interface NetworkTailscaleStatus {
  installed: boolean;
  binary?: string;
  backendState: TailscaleBackendState;
  hostname?: string;
  ip?: string;
  tailnetName?: string;
  peerCount?: number;
  message?: string;
  error?: string;
  /** Live: is `tailscale serve` currently proxying the gateway port? */
  serveEnabled?: boolean;
  /** The port the gateway checked for a serve rule. */
  servePort?: number;
  /** Tailnet URL for the control UI, present only when serve is live. */
  url?: string;
}

export interface NetworkTailscaleExposure {
  serve?: { active: boolean; port?: number };
  funnel?: { active: boolean; port?: number };
}

export interface NetworkPanelState {
  loading: boolean;
  status: NetworkTailscaleStatus | null;
  exposure: NetworkTailscaleExposure;
  busy: "serve" | "funnel" | "disable" | null;
  lastError?: string;
  lastUpdated: number | null;
}

export interface NetworkPanelProps {
  state: NetworkPanelState;
  onRefresh: () => void;
  onEnable: (mode: "serve" | "funnel") => void;
  onDisable: (mode: "serve" | "funnel" | "both") => void;
}

function shortAgo(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function backendBadge(state: TailscaleBackendState): TemplateResult {
  const cls =
    state === "Running"
      ? "ts-badge ts-badge--ok"
      : state === "NotInstalled"
        ? "ts-badge ts-badge--off"
        : state === "Stopped" || state === "NeedsLogin" || state === "NeedsMachineAuth"
          ? "ts-badge ts-badge--warn"
          : "ts-badge ts-badge--neutral";
  return html`<span class=${cls}>${state}</span>`;
}

export function renderNetworkPanel(props: NetworkPanelProps): TemplateResult {
  const { state } = props;
  const status = state.status;
  const installed = status?.installed ?? false;
  const running = status?.backendState === "Running";
  const serveBusy = state.busy === "serve";
  const funnelBusy = state.busy === "funnel";
  const disableBusy = state.busy === "disable";
  const anyBusy = state.busy !== null;

  return html`
    ${renderNetworkPanelStyles()}
    <div class="net-panel">
      <header class="net-header">
        <div class="net-title">
          <h2>🔒 Network & Access</h2>
          <span class="net-subtitle">
            Tailscale exposure for the gateway (${status?.tailnetName ? status.tailnetName : "tailnet-only"})
          </span>
        </div>
        <div class="net-header-actions">
          <span class="net-meta">Updated ${shortAgo(state.lastUpdated)}</span>
          <button
            class="net-btn net-btn--ghost"
            ?disabled=${state.loading}
            @click=${props.onRefresh}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      ${!installed
        ? html`
            <div class="net-row net-row--banner">
              <div class="net-banner">
                <strong>Tailscale not installed.</strong>
                ${status?.message
                  ? html`<span class="net-banner-detail">${status.message}</span>`
                  : nothing}
                <a
                  class="net-link"
                  href="https://tailscale.com/download"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Get Tailscale ↗
                </a>
              </div>
            </div>
          `
        : html`
            <div class="net-row net-row--status">
              <div class="net-stat">
                <span class="net-stat-label">Status</span>
                <span class="net-stat-value">${backendBadge(status!.backendState)}</span>
              </div>
              <div class="net-stat">
                <span class="net-stat-label">Hostname</span>
                <span class="net-stat-value mono">${status?.hostname ?? "—"}</span>
              </div>
              <div class="net-stat">
                <span class="net-stat-label">IP</span>
                <span class="net-stat-value mono">${status?.ip ?? "—"}</span>
              </div>
              <div class="net-stat">
                <span class="net-stat-label">Peers</span>
                <span class="net-stat-value">${status?.peerCount ?? "—"}</span>
              </div>
            </div>

            ${status?.error
              ? html`<div class="net-row net-row--error">${status.error}</div>`
              : nothing}

            <div class="net-row net-row--actions">
              <div class="net-action-group">
                <div class="net-action-title">
                  Tailnet-only HTTPS
                  ${state.exposure.serve?.active
                    ? html`<span class="ts-badge ts-badge--ok">active</span>`
                    : nothing}
                </div>
                <p class="net-action-desc">
                  Make the gateway reachable from any device on your tailnet via
                  <code>https://${status?.hostname ?? "your-machine.tailnet"}/</code>. Stays private.
                </p>
                <div class="net-action-buttons">
                  <button
                    class="net-btn net-btn--primary"
                    ?disabled=${!running || anyBusy}
                    @click=${() => props.onEnable("serve")}
                  >
                    ${serveBusy ? "Enabling…" : "Enable serve"}
                  </button>
                  <button
                    class="net-btn net-btn--ghost"
                    ?disabled=${!running || anyBusy}
                    @click=${() => props.onDisable("serve")}
                  >
                    Stop serve
                  </button>
                </div>
              </div>

              <div class="net-action-group">
                <div class="net-action-title">
                  Public (Funnel)
                  ${state.exposure.funnel?.active
                    ? html`<span class="ts-badge ts-badge--ok">active</span>`
                    : nothing}
                </div>
                <p class="net-action-desc">
                  Expose the gateway to the public Internet via
                  <code>funnel.ts.net</code>. Anyone with the URL can reach it — use
                  with auth on.
                </p>
                <div class="net-action-buttons">
                  <button
                    class="net-btn net-btn--primary"
                    ?disabled=${!running || anyBusy}
                    @click=${() => props.onEnable("funnel")}
                  >
                    ${funnelBusy ? "Enabling…" : "Enable funnel"}
                  </button>
                  <button
                    class="net-btn net-btn--ghost"
                    ?disabled=${!running || anyBusy}
                    @click=${() => props.onDisable("funnel")}
                  >
                    Stop funnel
                  </button>
                </div>
              </div>

              <div class="net-action-group">
                <div class="net-action-title">Reset all</div>
                <p class="net-action-desc">
                  Disable both serve and funnel. Useful before changing the gateway port.
                </p>
                <div class="net-action-buttons">
                  <button
                    class="net-btn net-btn--danger"
                    ?disabled=${!running || anyBusy}
                    @click=${() => props.onDisable("both")}
                  >
                    ${disableBusy ? "Disabling…" : "Disable all"}
                  </button>
                </div>
              </div>
            </div>
          `}

      ${state.lastError
        ? html`<div class="net-row net-row--error">⚠ ${state.lastError}</div>`
        : nothing}
    </div>
  `;
}

function renderNetworkPanelStyles(): TemplateResult {
  return html`
    <style>
      .net-panel { color: var(--fcc-text, #e4e4e7); }
      .net-header {
        display: flex; justify-content: space-between; align-items: flex-start;
        gap: 12px; margin-bottom: 12px;
      }
      .net-title h2 { font-size: 1.05rem; margin: 0 0 4px; }
      .net-subtitle { color: var(--fcc-text-muted, #a1a1aa); font-size: 0.85rem; }
      .net-header-actions { display: flex; align-items: center; gap: 10px; }
      .net-meta { color: var(--fcc-text-muted, #a1a1aa); font-size: 0.75rem; }

      .net-row { padding: 12px 0; border-top: 1px solid var(--fcc-border, #3f3f46); }
      .net-row:first-of-type { border-top: none; }
      .net-row--status { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
      @media (max-width: 720px) { .net-row--status { grid-template-columns: repeat(2, 1fr); } }

      .net-stat { display: flex; flex-direction: column; gap: 4px; }
      .net-stat-label { color: var(--fcc-text-muted, #a1a1aa); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
      .net-stat-value { font-size: 0.95rem; }
      .net-stat-value.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85rem; }

      .net-row--actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
      @media (max-width: 820px) { .net-row--actions { grid-template-columns: 1fr; } }

      .net-action-group {
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--fcc-border, #3f3f46);
        border-radius: 10px; padding: 14px;
      }
      .net-action-title { font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
      .net-action-desc { color: var(--fcc-text-muted, #a1a1aa); font-size: 0.8rem; margin: 0 0 12px; line-height: 1.5; }
      .net-action-desc code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; font-size: 0.78rem; }
      .net-action-buttons { display: flex; gap: 8px; flex-wrap: wrap; }

      .net-btn {
        border: 1px solid var(--fcc-border, #3f3f46);
        background: var(--fcc-input-bg, #27272a);
        color: var(--fcc-text, #e4e4e7);
        padding: 7px 14px; border-radius: 7px; cursor: pointer;
        font-size: 0.85rem; transition: 0.15s;
      }
      .net-btn:hover:not(:disabled) { border-color: var(--fcc-accent, #FFD700); }
      .net-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .net-btn--primary { background: var(--fcc-accent, #FFD700); color: #000; border-color: var(--fcc-accent, #FFD700); }
      .net-btn--primary:hover:not(:disabled) { background: var(--fcc-accent-hover, #FFC000); }
      .net-btn--ghost { background: transparent; }
      .net-btn--danger { color: #fff; background: #b91c1c; border-color: #b91c1c; }
      .net-btn--danger:hover:not(:disabled) { background: #991b1b; }

      .net-banner { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.3); border-radius: 8px; }
      .net-banner-detail { color: var(--fcc-text-muted, #a1a1aa); font-size: 0.85rem; }
      .net-link { color: var(--fcc-accent, #FFD700); margin-left: auto; text-decoration: none; }
      .net-link:hover { text-decoration: underline; }

      .net-row--error { color: #fca5a5; font-size: 0.85rem; }

      .ts-badge {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        font-size: 0.72rem; font-weight: 600;
      }
      .ts-badge--ok { background: rgba(34,197,94,0.15); color: #4ade80; }
      .ts-badge--warn { background: rgba(245,158,11,0.15); color: #fbbf24; }
      .ts-badge--off { background: rgba(239,68,68,0.15); color: #fca5a5; }
      .ts-badge--neutral { background: rgba(255,255,255,0.06); color: #a1a1aa; }
    </style>
  `;
}
