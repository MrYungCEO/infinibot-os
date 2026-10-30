/**
 * Federation Settings View
 * 
 * Settings page for InfiniBot federation configuration.
 * - Mode selector (Master/Satellite/Standalone)
 * - Master URL input (for satellites)
 * - Connected nodes list with status
 * - Node capabilities display
 */

import { html, nothing } from "lit";
import type { FederationState, FederationNode, FederationMode, NodeCapabilities, MasterUrlInfo } from "../controllers/federation";
import { formatCapabilities } from "../controllers/federation";
import { renderSatelliteSetupWizard, createSatelliteSetupState, type SatelliteSetupState } from "./federation-setup-wizard.js";

// ── Types ─────────────────────────────────────────────────

export interface FederationSettingsProps {
  state: FederationState;
  onRefresh: () => void;
  onModeChange: (mode: FederationMode) => void;
  onMasterUrlChange: (url: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onAddNode: (url: string, name?: string) => void;
  onRemoveNode: (nodeId: string) => void;
  /** Persist a new display name. For the local node this hits
   * `federation.config.set` (nodeName); for remote nodes it hits
   * `node.rename` (master-only). Both write to disk. */
  onRenameNode?: (nodeId: string, displayName: string, isLocal: boolean) => void;
  onScanNetwork: () => void;
  onSaveConfig: () => void;
  onRefreshUrls?: () => Promise<MasterUrlInfo[]>;
  onScanForMasters?: () => Promise<MasterUrlInfo[]>;
}

// ── Satellite Setup Wizard State ──────────────────────────

let satelliteWizardOpen = false;
let satelliteWizardState: SatelliteSetupState = createSatelliteSetupState();

export function openSatelliteWizard(masterUrls: MasterUrlInfo[]) {
  satelliteWizardOpen = true;
  satelliteWizardState = createSatelliteSetupState();
  satelliteWizardState.masterUrls = masterUrls;
}

export function closeSatelliteWizard() {
  satelliteWizardOpen = false;
}

export function isSatelliteWizardOpen(): boolean {
  return satelliteWizardOpen;
}

export function getSatelliteWizardState(): SatelliteSetupState {
  return satelliteWizardState;
}

export function updateSatelliteWizardState(updates: Partial<SatelliteSetupState>) {
  satelliteWizardState = { ...satelliteWizardState, ...updates };
}

// ── State for add node dialog ─────────────────────────────

let addNodeDialogOpen = false;
let addNodeUrl = "";
let addNodeName = "";

function openAddNodeDialog() {
  addNodeDialogOpen = true;
  addNodeUrl = "";
  addNodeName = "";
}

function closeAddNodeDialog() {
  addNodeDialogOpen = false;
}

// ── Main Render ───────────────────────────────────────────

export function renderFederationSettings(props: FederationSettingsProps) {
  const { state } = props;

  return html`
    <div class="federation-settings">
      <!-- Header -->
      <div class="federation-header">
        <div class="header-content">
          <h1>🌐 Federation</h1>
          <p>Connect and manage your InfiniBot network</p>
        </div>
        <button 
          class="btn" 
          ?disabled=${state.loading}
          @click=${props.onRefresh}
        >
          ${state.loading ? "Loading..." : "↻ Refresh"}
        </button>
      </div>

      ${state.error ? html`
        <div class="error-banner">
          <span>⚠️</span>
          <span>${state.error}</span>
        </div>
      ` : nothing}

      <!-- Federation Mode -->
      ${renderModeSelector(props)}

      <!-- Master URLs (for masters) -->
      ${state.mode === "master" ? renderMasterUrls(props) : nothing}

      <!-- Connection (for satellites) -->
      ${state.mode === "satellite" ? renderSatelliteConnection(props) : nothing}

      <!-- Connected Nodes -->
      ${renderConnectedNodes(props)}

      <!-- Add Node Dialog -->
      ${addNodeDialogOpen ? renderAddNodeDialog(props) : nothing}

      <!-- Satellite Setup Wizard -->
      ${satelliteWizardOpen ? renderSatelliteSetupWizard(
        satelliteWizardState,
        {
          onClose: () => {
            closeSatelliteWizard();
            props.onRefresh();
          },
          onComplete: () => {
            closeSatelliteWizard();
            props.onRefresh();
          },
          onRefreshUrls: async () => {
            if (props.onRefreshUrls) {
              const urls = await props.onRefreshUrls();
              updateSatelliteWizardState({ masterUrls: urls });
              return urls;
            }
            return satelliteWizardState.masterUrls;
          },
          onScanForMasters: props.onScanForMasters,
        },
        (updates) => {
          updateSatelliteWizardState(updates);
          props.onRefresh();
        }
      ) : nothing}
    </div>

    <style>
      .federation-settings {
        padding: 24px;
        max-width: 900px;
        margin: 0 auto;
      }

      .federation-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 32px;
        padding-bottom: 24px;
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      }

      .federation-header h1 {
        font-size: 28px;
        font-weight: 800;
        color: #e4e4e7;
        margin: 0 0 8px 0;
      }

      .federation-header p {
        font-size: 14px;
        color: #71717a;
        margin: 0;
      }

      .error-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 20px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 12px;
        margin-bottom: 24px;
        color: #fca5a5;
        font-size: 14px;
      }

      .section {
        margin-bottom: 32px;
      }

      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .section h2 {
        font-size: 18px;
        font-weight: 700;
        color: #e4e4e7;
        margin: 0;
      }

      .section-sub {
        font-size: 13px;
        color: #71717a;
        margin-top: 4px;
      }

      .card {
        background: rgba(15, 15, 15, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 16px;
        padding: 24px;
      }

      .btn {
        padding: 10px 20px;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 10px;
        color: var(--g-primary);
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .btn:hover:not(:disabled) {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn--sm {
        padding: 6px 14px;
        font-size: 12px;
      }

      .btn--primary {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      }

      .btn--danger {
        background: rgba(239, 68, 68, 0.1);
        border-color: rgba(239, 68, 68, 0.2);
        color: #f87171;
      }

      .btn--danger:hover:not(:disabled) {
        background: rgba(239, 68, 68, 0.2);
      }

      /* Mode Selector */
      .mode-selector {
        display: flex;
        gap: 12px;
        margin-top: 16px;
      }

      .mode-option {
        flex: 1;
        padding: 20px;
        background: rgba(15, 15, 15, 0.6);
        border: 2px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.2s ease;
        text-align: center;
      }

      .mode-option:hover {
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }

      .mode-option.active {
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }

      .mode-option .icon {
        font-size: 32px;
        margin-bottom: 12px;
      }

      .mode-option .label {
        font-size: 16px;
        font-weight: 600;
        color: #e4e4e7;
        margin-bottom: 6px;
      }

      .mode-option .desc {
        font-size: 12px;
        color: #71717a;
      }

      /* Connection Box */
      .connection-box {
        margin-top: 16px;
        padding: 20px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 12px;
      }

      .connection-status {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 16px;
      }

      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }

      .status-dot.connected {
        background: #22c55e;
        box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
      }

      .status-dot.disconnected {
        background: #f87171;
      }

      .status-dot.connecting {
        background: var(--g-primary);
        animation: pulse 1.5s infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .status-text {
        font-size: 14px;
        font-weight: 500;
      }

      .status-text.connected { color: #22c55e; }
      .status-text.disconnected { color: #f87171; }
      .status-text.connecting { color: var(--g-primary); }

      .input-group {
        display: flex;
        gap: 10px;
        margin-top: 12px;
      }

      .input-group input {
        flex: 1;
        padding: 12px 16px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        color: #e4e4e7;
        font-size: 14px;
        font-family: 'JetBrains Mono', monospace;
      }

      .input-group input:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }

      .input-group input::placeholder {
        color: #52525b;
      }

      /* Nodes List */
      .nodes-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-top: 16px;
      }

      .node-card {
        display: flex;
        align-items: flex-start;
        gap: 16px;
        padding: 18px;
        background: rgba(15, 15, 15, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        transition: all 0.2s ease;
      }

      .node-card:hover {
        border-color: color-mix(in srgb, var(--g-primary) 10%, transparent);
      }

      .node-card.local {
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
        background: color-mix(in srgb, var(--g-primary) 2%, transparent);
      }

      .node-icon {
        font-size: 28px;
        padding: 10px;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-radius: 10px;
      }

      .node-info {
        flex: 1;
        min-width: 0;
      }

      .node-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 6px;
      }

      .node-name {
        font-size: 16px;
        font-weight: 600;
        color: #e4e4e7;
      }

      .node-badge {
        padding: 3px 8px;
        border-radius: 6px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .node-badge.master {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
      }

      .node-badge.satellite {
        background: rgba(139, 92, 246, 0.1);
        color: #a78bfa;
      }

      .node-badge.online {
        background: rgba(34, 197, 94, 0.1);
        color: #22c55e;
      }

      .node-badge.offline {
        background: rgba(239, 68, 68, 0.1);
        color: #f87171;
      }

      .node-badge.local {
        background: rgba(59, 130, 246, 0.1);
        color: #60a5fa;
      }

      .node-meta {
        font-size: 13px;
        color: #71717a;
        margin-bottom: 8px;
      }

      .node-caps {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .cap-tag {
        padding: 4px 10px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 6px;
        font-size: 11px;
        color: #a1a1aa;
      }

      .cap-tag.highlight {
        background: rgba(139, 92, 246, 0.1);
        color: #a78bfa;
      }

      .node-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .empty-state {
        padding: 40px;
        text-align: center;
        background: rgba(15, 15, 15, 0.4);
        border: 1px dashed rgba(255, 255, 255, 0.1);
        border-radius: 16px;
      }

      .empty-state .icon {
        font-size: 40px;
        margin-bottom: 12px;
        opacity: 0.5;
      }

      .empty-state h4 {
        font-size: 16px;
        font-weight: 600;
        color: #a1a1aa;
        margin: 0 0 8px 0;
      }

      .empty-state p {
        font-size: 13px;
        color: #71717a;
        margin: 0 0 16px 0;
      }

      /* Dialog */
      .dialog-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      }

      .dialog {
        width: 100%;
        max-width: 460px;
        background: #18181b;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        padding: 24px;
      }

      .dialog h3 {
        font-size: 20px;
        font-weight: 700;
        color: #e4e4e7;
        margin: 0 0 8px 0;
      }

      .dialog p {
        font-size: 14px;
        color: #71717a;
        margin: 0 0 20px 0;
      }

      .form-field {
        margin-bottom: 16px;
      }

      .form-field label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        color: #a1a1aa;
        margin-bottom: 8px;
      }

      .form-field input {
        width: 100%;
        padding: 12px 16px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        color: #e4e4e7;
        font-size: 14px;
        box-sizing: border-box;
      }

      .form-field input:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }

      .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 24px;
      }

      @media (max-width: 640px) {
        .federation-settings {
          padding: 16px;
        }

        .mode-selector {
          flex-direction: column;
        }

        .node-card {
          flex-direction: column;
        }

        .node-actions {
          flex-direction: row;
          width: 100%;
        }

        .node-actions .btn {
          flex: 1;
        }
      }
    </style>
  `;
}

// ── Mode Selector ─────────────────────────────────────────

function renderModeSelector(props: FederationSettingsProps) {
  const { state, onModeChange, onSaveConfig } = props;

  const modes: { id: FederationMode; icon: string; label: string; desc: string }[] = [
    { id: "standalone", icon: "🖥️", label: "Standalone", desc: "Single instance, no federation" },
    { id: "master", icon: "👑", label: "Master", desc: "Hub for satellite connections" },
    { id: "satellite", icon: "🔗", label: "Satellite", desc: "Connect to a master node" },
  ];

  return html`
    <section class="section">
      <h2>Federation Mode</h2>
      <div class="section-sub">Choose how this node participates in the network</div>
      
      <div class="mode-selector">
        ${modes.map((mode) => html`
          <div 
            class="mode-option ${state.mode === mode.id ? "active" : ""}"
            @click=${() => onModeChange(mode.id)}
          >
            <div class="icon">${mode.icon}</div>
            <div class="label">${mode.label}</div>
            <div class="desc">${mode.desc}</div>
          </div>
        `)}
      </div>

      ${state.configDirty ? html`
        <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
          <button 
            class="btn btn--primary" 
            ?disabled=${state.configSaving}
            @click=${onSaveConfig}
          >
            ${state.configSaving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      ` : nothing}
    </section>
  `;
}

// ── Satellite Connection ──────────────────────────────────

function renderSatelliteConnection(props: FederationSettingsProps) {
  const { state, onMasterUrlChange, onConnect, onDisconnect } = props;

  const statusClass = state.connectionStatus;
  const statusLabel = {
    connected: "Connected",
    disconnected: "Disconnected",
    connecting: "Connecting...",
  }[state.connectionStatus];

  return html`
    <section class="section">
      <h2>Master Connection</h2>
      <div class="section-sub">Connect to your master InfiniBot instance</div>

      <div class="card">
        <div class="connection-status">
          <div class="status-dot ${statusClass}"></div>
          <span class="status-text ${statusClass}">${statusLabel}</span>
          ${state.connectionStatus === "connected" && state.nodes.find(n => n.role === "master")?.latency 
            ? html`<span class="status-text" style="color: #71717a;">
                (${state.nodes.find(n => n.role === "master")?.latency}ms)
              </span>` 
            : nothing}
        </div>

        <div class="input-group">
          <input
            type="text"
            placeholder="ws://192.168.1.100:47913"
            .value=${state.masterUrl}
            @input=${(e: Event) => onMasterUrlChange((e.target as HTMLInputElement).value)}
          />
          ${state.connectionStatus === "connected" 
            ? html`<button class="btn btn--danger" @click=${onDisconnect}>Disconnect</button>`
            : html`<button class="btn btn--primary" @click=${onConnect} ?disabled=${!state.masterUrl}>
                Connect
              </button>`}
        </div>
      </div>
    </section>
  `;
}

// ── Master URLs ───────────────────────────────────────────

function renderMasterUrls(props: FederationSettingsProps) {
  const { state } = props;
  const urls = state.masterUrls || [];

  // Find the best URL (prefer tailscale > tunnel > lan)
  const getPrimaryUrl = () => {
    const tailscale = urls.find(u => u.type === "tailscale");
    if (tailscale) return tailscale;
    const tunnel = urls.find(u => u.type === "tunnel");
    if (tunnel) return tunnel;
    const lan = urls.find(u => u.type === "lan");
    if (lan) return lan;
    return urls[0];
  };

  const primaryUrl = getPrimaryUrl();

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      // Visual feedback
      const btn = document.activeElement as HTMLButtonElement;
      if (btn) {
        const original = btn.textContent;
        btn.textContent = "✓";
        setTimeout(() => btn.textContent = original, 1000);
      }
    }).catch(() => {});
  };

  const copyConnectCommand = () => {
    if (!primaryUrl) return;
    const cmd = `infinibot connect ${primaryUrl.url}`;
    navigator.clipboard.writeText(cmd).catch(() => {});
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "lan": return "🏠";
      case "tailscale": return "🔗";
      case "tunnel": return "🌐";
      default: return "📡";
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "lan": return "#3b82f6";
      case "tailscale": return "#8b5cf6";
      case "tunnel": return "#10b981";
      default: return "#71717a";
    }
  };

  return html`
    <section class="section">
      <h2>🔗 Satellite Connection</h2>
      <div class="section-sub">Share this URL with other InfiniBot instances to join the network</div>

      ${urls.length === 0 ? html`
        <div class="card" style="text-align: center; padding: 24px; color: #71717a;">
          <div style="font-size: 32px; margin-bottom: 8px;">⏳</div>
          <div>Loading connection URLs...</div>
        </div>
      ` : html`
        <!-- Primary Connect URL (highlighted) -->
        ${primaryUrl ? html`
          <div class="quick-connect-card">
            <div class="quick-connect-header">
              <span class="quick-connect-title">⚡ Quick Connect URL</span>
              <span class="quick-connect-badge" style="background: ${getTypeColor(primaryUrl.type)}">
                ${getTypeIcon(primaryUrl.type)} ${primaryUrl.type.toUpperCase()}
              </span>
            </div>
            <div class="quick-connect-url">
              <code id="primary-connect-url">${primaryUrl.url}</code>
            </div>
            <div class="quick-connect-actions">
              <button class="btn btn--primary" @click=${() => copyUrl(primaryUrl.url)}>
                📋 Copy URL
              </button>
              <button class="btn" @click=${copyConnectCommand}>
                💻 Copy Command
              </button>
            </div>
            <div class="quick-connect-hint">
              <strong>On satellite device, run:</strong>
              <code class="connect-cmd">infinibot connect ${primaryUrl.url}</code>
            </div>
          </div>
        ` : nothing}

        <!-- All URLs -->
        <div style="margin-top: 20px;">
          <div style="font-size: 14px; color: #a1a1aa; margin-bottom: 12px;">All Available URLs:</div>
          <div class="urls-list">
            ${urls.map((urlInfo) => html`
              <div class="url-card ${urlInfo === primaryUrl ? 'url-card--primary' : ''}">
                <div class="url-header">
                  <span class="url-icon">${getTypeIcon(urlInfo.type)}</span>
                  <span class="url-label" style="color: ${getTypeColor(urlInfo.type)}">${urlInfo.label}</span>
                  <span class="url-type">${urlInfo.type.toUpperCase()}</span>
                  ${urlInfo === primaryUrl ? html`<span class="url-recommended">RECOMMENDED</span>` : nothing}
                </div>
                <div class="url-value">
                  <code>${urlInfo.url}</code>
                  <button class="btn btn--sm" @click=${() => copyUrl(urlInfo.url)} title="Copy URL">
                    📋
                  </button>
                </div>
              </div>
            `)}
          </div>
        </div>
      `}
    </section>

    <style>
      /* Quick Connect Card (Primary URL) */
      .quick-connect-card {
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 2px solid #8b5cf6;
        border-radius: 12px;
        padding: 24px;
        margin-bottom: 16px;
        box-shadow: 0 0 20px rgba(139, 92, 246, 0.2);
      }

      .quick-connect-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .quick-connect-title {
        font-size: 18px;
        font-weight: 700;
        color: #fff;
      }

      .quick-connect-badge {
        font-size: 11px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 6px;
        color: #fff;
      }

      .quick-connect-url {
        background: #0a0a0f;
        border: 1px solid #3f3f46;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
        overflow-x: auto;
      }

      .quick-connect-url code {
        font-family: 'JetBrains Mono', monospace;
        font-size: 14px;
        color: #22d3ee;
        word-break: break-all;
      }

      .quick-connect-actions {
        display: flex;
        gap: 12px;
        margin-bottom: 16px;
      }

      .quick-connect-actions .btn--primary {
        background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
        color: #fff;
        font-weight: 600;
      }

      .quick-connect-hint {
        background: #27272a;
        border-radius: 8px;
        padding: 12px 16px;
        font-size: 13px;
        color: #a1a1aa;
      }

      .quick-connect-hint strong {
        color: #e4e4e7;
        display: block;
        margin-bottom: 8px;
      }

      .connect-cmd {
        display: block;
        background: #18181b;
        padding: 10px 14px;
        border-radius: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        color: #22d3ee;
        margin-top: 8px;
        border: 1px solid #3f3f46;
      }

      .urls-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .url-card {
        background: var(--card-bg, #27272a);
        border: 1px solid var(--border-color, #3f3f46);
        border-radius: 8px;
        padding: 16px;
      }

      .url-card--primary {
        border-color: #8b5cf6;
        background: #27272a;
      }

      .url-recommended {
        font-size: 9px;
        font-weight: 700;
        background: #8b5cf6;
        color: #fff;
        padding: 2px 6px;
        border-radius: 4px;
        margin-left: 8px;
      }

      .url-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .url-icon {
        font-size: 18px;
      }

      .url-label {
        font-weight: 600;
        flex: 1;
      }

      .url-type {
        font-size: 10px;
        font-weight: 600;
        background: #3f3f46;
        padding: 2px 8px;
        border-radius: 4px;
        color: #a1a1aa;
      }

      .url-value {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .url-value code {
        flex: 1;
        font-family: monospace;
        font-size: 13px;
        background: #18181b;
        padding: 10px 14px;
        border-radius: 6px;
        border: 1px solid #3f3f46;
        color: #e4e4e7;
        overflow-x: auto;
        white-space: nowrap;
      }

      .url-value .btn--sm {
        padding: 8px 12px;
        font-size: 14px;
      }
    </style>
  `;
}

// ── Connected Nodes ───────────────────────────────────────

function renderConnectedNodes(props: FederationSettingsProps) {
  const { state, onRemoveNode, onScanNetwork, onRenameNode } = props;
  const isMaster = state.mode === "master";

  return html`
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Connected Nodes</h2>
          <div class="section-sub">${state.nodes.length} node${state.nodes.length !== 1 ? "s" : ""} in network</div>
        </div>
        <div style="display: flex; gap: 10px;">
          ${isMaster ? html`
            <button class="btn btn--sm" @click=${onScanNetwork}>🔍 Scan</button>
            <button class="btn btn--sm" @click=${() => { openAddNodeDialog(); props.onRefresh(); }}>+ Add Node</button>
            <button class="btn btn--sm btn--primary" @click=${() => { 
              openSatelliteWizard(state.masterUrls); 
              props.onRefresh(); 
            }}>🚀 Setup Satellite</button>
          ` : nothing}
        </div>
      </div>

      ${state.nodes.length === 0 
        ? html`
          <div class="empty-state">
            <div class="icon">🌐</div>
            <h4>No nodes connected</h4>
            <p>${isMaster 
              ? "Add satellite nodes to expand your network" 
              : "Connect to a master to see the network"}</p>
            ${isMaster ? html`
              <button class="btn btn--primary" @click=${() => { 
                openSatelliteWizard(state.masterUrls); 
                props.onRefresh(); 
              }}>
                🚀 Setup Satellite
              </button>
            ` : nothing}
          </div>
        `
        : html`
          <div class="nodes-list">
            ${state.nodes.map((node) => renderNodeCard(node, isMaster, onRemoveNode, state.localNodeId, onRenameNode))}
          </div>
        `}
    </section>
  `;
}

function renderNodeCard(
  node: FederationNode,
  isMaster: boolean,
  onRemove: (id: string) => void,
  localNodeId: string | null,
  onRename?: (nodeId: string, displayName: string, isLocal: boolean) => void,
) {
  const isLocal = node.isLocal || node.id === localNodeId;
  const icon = node.role === "master" ? "👑" : isLocal ? "🖥️" : "💻";
  // Self-rename always allowed (saves to federation.nodeName).
  // Remote rename only when this device is the master (saves to paired-nodes state).
  const canRename = !!onRename && (isLocal || isMaster);
  const handleRename = () => {
    if (!onRename) return;
    const proposed = window.prompt(
      isLocal
        ? "Rename this device (saved to federation.nodeName):"
        : `Rename "${node.name}" (saved on master):`,
      node.name ?? "",
    );
    if (proposed === null) return;
    const trimmed = proposed.trim();
    if (!trimmed || trimmed === node.name) return;
    onRename(node.id, trimmed, isLocal);
  };

  return html`
    <div class="node-card ${isLocal ? "local" : ""}">
      <div class="node-icon">${icon}</div>
      <div class="node-info">
        <div class="node-header">
          <span class="node-name">${node.name}</span>
          <span class="node-badge ${node.role}">${node.role}</span>
          <span class="node-badge ${node.status}">${node.status}</span>
          ${isLocal ? html`<span class="node-badge local">THIS NODE</span>` : nothing}
        </div>
        <div class="node-meta">
          ${node.id}
          ${node.remoteIp ? html` · ${node.remoteIp}` : nothing}
          ${node.version ? html` · v${node.version}` : nothing}
        </div>
        <div class="node-caps">
          ${renderNodeCapabilities(node.capabilities)}
        </div>
      </div>
      ${canRename || (!isLocal && isMaster) ? html`
        <div class="node-actions">
          ${canRename ? html`
            <button class="btn btn--sm" @click=${handleRename}>
              Rename
            </button>
          ` : nothing}
          ${!isLocal && isMaster ? html`
            <button class="btn btn--sm btn--danger" @click=${() => onRemove(node.id)}>
              Remove
            </button>
          ` : nothing}
        </div>
      ` : nothing}
    </div>
  `;
}

function renderNodeCapabilities(caps: NodeCapabilities) {
  const tags: Array<{ label: string; highlight?: boolean }> = [];

  if (caps.gpu) tags.push({ label: `GPU: ${caps.gpu}`, highlight: true });
  if (caps.ram) tags.push({ label: `RAM: ${caps.ram}GB` });
  if (caps.hasOllama) tags.push({ label: "Ollama", highlight: true });
  if (caps.hasVoice) tags.push({ label: "Voice" });
  if (caps.hasComfyUI) tags.push({ label: "ComfyUI", highlight: true });
  if (caps.agents?.length) tags.push({ label: `${caps.agents.length} agents` });
  if (caps.mcpServers?.length) tags.push({ label: `${caps.mcpServers.length} MCP` });

  if (tags.length === 0) {
    tags.push({ label: "No capabilities reported" });
  }

  return tags.map(tag => html`
    <span class="cap-tag ${tag.highlight ? "highlight" : ""}">${tag.label}</span>
  `);
}

// ── Add Node Dialog ───────────────────────────────────────

function renderAddNodeDialog(props: FederationSettingsProps) {
  const handleAdd = () => {
    if (addNodeUrl.trim()) {
      props.onAddNode(addNodeUrl.trim(), addNodeName.trim() || undefined);
      closeAddNodeDialog();
      props.onRefresh();
    }
  };

  return html`
    <div class="dialog-backdrop" @click=${(e: Event) => {
      if (e.target === e.currentTarget) {
        closeAddNodeDialog();
        props.onRefresh();
      }
    }}>
      <div class="dialog">
        <h3>Add Node</h3>
        <p>Connect a new satellite node to your network</p>

        <div class="form-field">
          <label>Node URL</label>
          <input
            type="text"
            placeholder="ws://192.168.1.101:47913"
            .value=${addNodeUrl}
            @input=${(e: Event) => { addNodeUrl = (e.target as HTMLInputElement).value; }}
          />
        </div>

        <div class="form-field">
          <label>Display Name (optional)</label>
          <input
            type="text"
            placeholder="e.g., Living Room Mac"
            .value=${addNodeName}
            @input=${(e: Event) => { addNodeName = (e.target as HTMLInputElement).value; }}
          />
        </div>

        <div class="dialog-actions">
          <button class="btn" @click=${() => { closeAddNodeDialog(); props.onRefresh(); }}>
            Cancel
          </button>
          <button 
            class="btn btn--primary" 
            ?disabled=${!addNodeUrl.trim()}
            @click=${handleAdd}
          >
            Add Node
          </button>
        </div>
      </div>
    </div>
  `;
}
