/**
 * Infinibot Quick Start - Installation and tunnel URL display
 */

import { html, nothing } from "lit";
import type { SetupState } from "../controllers/setup";
import { GatewayBrowserClient } from "../gateway";
import { gatewayOrigin } from "../gateway-endpoint";
import { g8GlassStyles } from "./glass-g8.js";
import { renderQuickstartConnectSteps } from "./quickstart-connect-steps.js";

// Tunnel State
interface TunnelState {
  enabled: boolean;
  status: "stopped" | "starting" | "running" | "error";
  url: string | null;
  error: string | null;
  cloudflaredAvailable: boolean;
  loading: boolean;
}

let tunnelState: TunnelState = {
  enabled: false,
  status: "stopped",
  url: null,
  error: null,
  cloudflaredAvailable: false,
  loading: true,
};

let tunnelEventListener: (() => void) | null = null;

async function loadTunnelStatus(client: GatewayBrowserClient): Promise<void> {
  try {
    const result = await client.request<{
      enabled: boolean;
      status: string;
      url: string | null;
      error: string | null;
      cloudflaredAvailable: boolean;
    }>("tunnel.status", {});
    tunnelState = {
      ...tunnelState,
      enabled: result.enabled ?? false,
      status: (result.status as TunnelState["status"]) ?? "stopped",
      url: result.url ?? null,
      error: result.error ?? null,
      cloudflaredAvailable: result.cloudflaredAvailable ?? false,
      loading: false,
    };
  } catch (err) {
    tunnelState.loading = false;
    tunnelState.error = String(err);
  }
}

async function startTunnel(client: GatewayBrowserClient, onUpdate: () => void): Promise<void> {
  tunnelState.status = "starting";
  tunnelState.loading = true;
  onUpdate();
  
  try {
    const result = await client.request<{ url: string; status: string }>("tunnel.start", {});
    tunnelState = {
      ...tunnelState,
      url: result.url,
      status: "running",
      error: null,
      loading: false,
    };
  } catch (err) {
    tunnelState = {
      ...tunnelState,
      status: "error",
      error: String(err),
      loading: false,
    };
  }
  onUpdate();
}

async function stopTunnel(client: GatewayBrowserClient, onUpdate: () => void): Promise<void> {
  tunnelState.loading = true;
  onUpdate();
  
  try {
    await client.request("tunnel.stop", {});
    tunnelState = {
      ...tunnelState,
      url: null,
      status: "stopped",
      error: null,
      loading: false,
    };
  } catch (err) {
    tunnelState.error = String(err);
    tunnelState.loading = false;
  }
  onUpdate();
}

function setupTunnelEventListener(client: GatewayBrowserClient, onUpdate: () => void): void {
  if (tunnelEventListener) return;
  
  client.subscribe((evt) => {
    if (evt.event === "tunnel.changed") {
      const data = evt.payload as { url: string | null; status: string };
      tunnelState = {
        ...tunnelState,
        url: data.url,
        status: data.status as TunnelState["status"],
      };
      onUpdate();
    }
  });
  
  tunnelEventListener = () => {};
}

// Get install URL
function getInstallUrl(type: "sh" | "ps1"): string {
  if (typeof window !== "undefined" && window.location) {
    return `${gatewayOrigin()}/install.${type}`;
  }
  return `http://localhost:18789/install.${type}`;
}

// Styles
export const quickstartStyles = html`
<style>
  .quickstart-container {
    min-height: 100%;
    padding: 24px;
  }
  
  .quickstart-hero {
    text-align: center;
    padding: 48px 24px;
    background: linear-gradient(180deg, rgba(245, 181, 66, 0.12) 0%, color-mix(in srgb, var(--g-primary) 5%, transparent) 50%, transparent 100%);
    border-bottom: 1px solid rgba(245, 181, 66, 0.15);
    margin: -24px -24px 32px -24px;
  }
  
  .hero-logo {
    font-size: 64px;
    margin-bottom: 16px;
    display: block;
  }
  
  .quickstart-hero h1 {
    font-size: 36px;
    font-weight: 800;
    margin: 0 0 8px 0;
    background: linear-gradient(135deg, #fbbf24, var(--g-primary), #f5b542);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  
  .quickstart-hero .tagline {
    font-size: 18px;
    color: var(--c-text-2, #a1a1aa);
    margin: 0;
  }
  
  .install-section {
    background: linear-gradient(135deg, rgba(245, 181, 66, 0.05), rgba(0, 0, 0, 0.3));
    border: 1px solid rgba(245, 181, 66, 0.2);
    border-radius: 20px;
    padding: 32px;
    margin-bottom: 32px;
  }
  
  .install-section h2 {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 16px 0;
  }
  
  .install-command {
    background: rgba(0, 0, 0, 0.5);
    border: 2px solid rgba(245, 181, 66, 0.3);
    border-radius: 14px;
    padding: 20px 24px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  
  .install-command::before {
    content: "$";
    font-family: monospace;
    font-size: 16px;
    color: #fbbf24;
    font-weight: 700;
  }
  
  .install-command code {
    flex: 1;
    font-family: monospace;
    font-size: 14px;
    color: var(--g-primary);
    word-break: break-all;
  }
  
  .install-command .copy-btn {
    padding: 12px 24px;
    background: linear-gradient(135deg, #fbbf24, #f5b542);
    border: none;
    border-radius: 10px;
    color: #000;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }
  
  .install-command .copy-btn:hover {
    transform: scale(1.05);
  }
  
  .tunnel-section {
    background: linear-gradient(135deg, rgba(245, 181, 66, 0.08), rgba(212, 175, 55, 0.05));
    border: 1px solid rgba(245, 181, 66, 0.25);
    border-radius: 20px;
    padding: 28px;
    margin-bottom: 32px;
  }
  
  .tunnel-section h3 {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px 0;
  }
  
  .tunnel-section > p {
    color: var(--c-text-2, #a1a1aa);
    margin: 0 0 20px 0;
  }
  
  .tunnel-url-box {
    background: rgba(0, 0, 0, 0.4);
    border: 2px solid rgba(245, 181, 66, 0.4);
    border-radius: 14px;
    padding: 20px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  
  .tunnel-url-box.running {
    border-color: rgba(34, 197, 94, 0.5);
  }
  
  .tunnel-url-box .tunnel-url {
    flex: 1;
    font-family: monospace;
    font-size: 15px;
    color: #ffd278;
    word-break: break-all;
  }
  
  .tunnel-url-box.running .tunnel-url {
    color: #22c55e;
  }
  
  .tunnel-btn {
    padding: 12px 24px;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }
  
  .tunnel-btn.start {
    background: linear-gradient(135deg, #ffd278, #d4af37);
    color: #fff;
  }
  
  .tunnel-btn.stop {
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: #ef4444;
  }
  
  .tunnel-btn.copy {
    background: linear-gradient(135deg, #22c55e, #16a34a);
    color: #fff;
  }
  
  .tunnel-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .tunnel-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--c-text-2, #a1a1aa);
    margin-top: 12px;
  }
  
  .tunnel-status .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #71717a;
  }
  
  .tunnel-status .dot.running {
    background: #22c55e;
    animation: pulse 2s infinite;
  }
  
  .tunnel-status .dot.starting {
    background: var(--g-primary);
    animation: pulse 0.5s infinite;
  }
  
  .tunnel-status .dot.error {
    background: #ef4444;
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  .tunnel-install-commands {
    margin-top: 20px;
    padding: 16px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 12px;
  }
  
  .tunnel-install-commands h4 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 12px 0;
  }
  
  .tunnel-install-cmd {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  
  .tunnel-install-cmd .label {
    font-size: 12px;
    color: var(--c-text-2, #71717a);
    width: 80px;
  }
  
  .tunnel-install-cmd code {
    flex: 1;
    font-family: monospace;
    font-size: 13px;
    color: var(--g-primary);
    background: rgba(0, 0, 0, 0.3);
    padding: 8px 12px;
    border-radius: 6px;
  }
  
  .tunnel-install-cmd .copy-mini {
    padding: 6px 12px;
    background: rgba(245, 181, 66, 0.1);
    border: 1px solid rgba(245, 181, 66, 0.2);
    border-radius: 6px;
    color: #fbbf24;
    font-size: 11px;
    cursor: pointer;
  }
  
  .tunnel-not-available {
    padding: 16px;
    background: rgba(245, 181, 66, 0.08);
    border: 1px solid rgba(245, 181, 66, 0.2);
    border-radius: 12px;
    color: var(--c-text-2, #a1a1aa);
  }
  
  .tunnel-not-available a {
    color: #fbbf24;
  }
  
  .platform-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }
  
  .platform-tab {
    padding: 8px 16px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: var(--c-text-2, #a1a1aa);
    cursor: pointer;
    font-size: 13px;
  }
  
  .platform-tab.active {
    background: rgba(245, 181, 66, 0.15);
    border-color: rgba(245, 181, 66, 0.4);
    color: #fbbf24;
  }
</style>
`;

function renderTunnelSection(client: GatewayBrowserClient | null, onUpdate: () => void) {
  const tunnelUrl = tunnelState.url;
  const psCommand = tunnelUrl
    ? `iwr -useb "${tunnelUrl}/install.ps1" | iex`
    : 'Enable tunnel to get public install URL';
  const shCommand = tunnelUrl
    ? `curl -fsSL ${tunnelUrl}/install.sh | bash`
    : 'Enable tunnel to get public install URL';

  return html`
    <div class="tunnel-section">
      <h3>Public Install URL</h3>
      <p>Enable Cloudflare Tunnel to share install commands that work from anywhere.</p>

      ${tunnelState.loading ? html`
        <div class="tunnel-url-box">
          <span class="tunnel-url">Loading tunnel status...</span>
        </div>
      ` : !tunnelState.cloudflaredAvailable ? html`
        <div class="tunnel-not-available">
          <strong>cloudflared not installed.</strong><br>
          Install from <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank">Cloudflare Downloads</a> to enable public URLs.
        </div>
      ` : tunnelState.status === "running" && tunnelState.url ? html`
        <div class="tunnel-url-box running">
          <span class="tunnel-url">${tunnelState.url}</span>
          <button
            class="tunnel-btn copy"
            @click=${(e: Event) => {
              navigator.clipboard.writeText(tunnelState.url!);
              const btn = e.target as HTMLButtonElement;
              btn.textContent = "Copied!";
              setTimeout(() => btn.textContent = "Copy", 2000);
            }}
          >Copy</button>
          <button
            class="tunnel-btn stop"
            @click=${() => client && stopTunnel(client, onUpdate)}
          >Stop</button>
        </div>

        <div class="tunnel-status">
          <span class="dot running"></span>
          Tunnel running - Share these commands to install Infinibot anywhere
        </div>

        <div class="tunnel-install-commands">
          <h4>Public Install Commands</h4>

          <div class="tunnel-install-cmd">
            <span class="label">Windows:</span>
            <code>${psCommand}</code>
            <button
              class="copy-mini"
              @click=${(e: Event) => {
                navigator.clipboard.writeText(psCommand);
                const btn = e.target as HTMLButtonElement;
                btn.textContent = "OK";
                setTimeout(() => btn.textContent = "Copy", 1500);
              }}
            >Copy</button>
          </div>

          <div class="tunnel-install-cmd">
            <span class="label">macOS/Linux:</span>
            <code>${shCommand}</code>
            <button
              class="copy-mini"
              @click=${(e: Event) => {
                navigator.clipboard.writeText(shCommand);
                const btn = e.target as HTMLButtonElement;
                btn.textContent = "OK";
                setTimeout(() => btn.textContent = "Copy", 1500);
              }}
            >Copy</button>
          </div>
        </div>
      ` : html`
        <div class="tunnel-url-box">
          <span class="tunnel-url">${tunnelState.status === "starting" ? "Starting tunnel..." : "Tunnel not running"}</span>
          <button
            class="tunnel-btn start"
            ?disabled=${tunnelState.status === "starting" || !client}
            @click=${() => client && startTunnel(client, onUpdate)}
          >${tunnelState.status === "starting" ? "Starting..." : "Start Tunnel"}</button>
        </div>

        ${tunnelState.error ? html`
          <div class="tunnel-status">
            <span class="dot error"></span>
            Error: ${tunnelState.error}
          </div>
        ` : html`
          <div class="tunnel-status">
            <span class="dot ${tunnelState.status}"></span>
            ${tunnelState.status === "starting" ? "Starting Cloudflare tunnel..." : "Click Start to enable public access"}
          </div>
        `}
      `}
    </div>
  `;
}

export function renderQuickstart(
  state: SetupState,
  onUpdate: () => void,
  client?: GatewayBrowserClient | null
) {
  const shellUrl = getInstallUrl("sh");
  const ps1Url = getInstallUrl("ps1");
  
  const platform = state.quickstartPlatform || "windows";
  
  // Auto-detect platform on first render
  if (!state.quickstartPlatform) {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) state.quickstartPlatform = "windows";
    else if (ua.includes("mac")) state.quickstartPlatform = "macos";
    else if (ua.includes("linux")) state.quickstartPlatform = "linux";
    else state.quickstartPlatform = "docker";
  }
  
  // Load tunnel status on first render
  if (tunnelState.loading && !tunnelEventListener && client) {
    void loadTunnelStatus(client).then(onUpdate);
    setupTunnelEventListener(client, onUpdate);
  }
  
  const installCommand = platform === "windows"
    ? `iwr -useb "${ps1Url}" | iex`
    : `curl -fsSL ${shellUrl} | bash`;

  return html`
    ${g8GlassStyles}
    <div class="quickstart-container g8-page">
      <div class="quickstart-hero">
        <span class="hero-logo">Infinibot</span>
        <h1>Quick Start</h1>
        <p class="tagline">Your AI Assistant, Everywhere</p>
      </div>

      <div class="install-section">
        <h2>Install Infinibot</h2>
        
        <div class="platform-tabs">
          <button 
            class="platform-tab ${platform === 'windows' ? 'active' : ''}"
            @click=${() => { state.quickstartPlatform = 'windows'; onUpdate(); }}
          >Windows</button>
          <button 
            class="platform-tab ${platform === 'macos' ? 'active' : ''}"
            @click=${() => { state.quickstartPlatform = 'macos'; onUpdate(); }}
          >macOS</button>
          <button 
            class="platform-tab ${platform === 'linux' ? 'active' : ''}"
            @click=${() => { state.quickstartPlatform = 'linux'; onUpdate(); }}
          >Linux</button>
        </div>
        
        <div class="install-command">
          <code>${installCommand}</code>
          <button 
            class="copy-btn"
            @click=${(e: Event) => {
              navigator.clipboard.writeText(installCommand);
              const btn = e.target as HTMLButtonElement;
              btn.textContent = "Copied!";
              setTimeout(() => btn.textContent = "Copy", 2000);
            }}
          >Copy</button>
        </div>
      </div>

      ${renderQuickstartConnectSteps(client, onUpdate)}

      ${renderTunnelSection(client ?? null, onUpdate)}
    </div>
  `;
}

export default renderQuickstart;
