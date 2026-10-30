/**
 * Federation Setup Wizard
 * 
 * Step-by-step wizard for setting up satellite nodes.
 * - Generates config for remote nodes
 * - Provides install instructions
 * - Shows connection status
 */

import { html, nothing } from "lit";
import type { MasterUrlInfo } from "../controllers/federation";

// ── Types ─────────────────────────────────────────────────

export interface SatelliteSetupState {
  step: "intro" | "platform" | "install" | "config" | "connect" | "done";
  platform: "linux" | "macos" | "windows" | "docker" | null;
  nodeName: string;
  masterUrls: MasterUrlInfo[];
  selectedUrl: MasterUrlInfo | null;
  generatedConfig: string;
  installCommand: string;
  connecting: boolean;
  connected: boolean;
  scanning: boolean;
  error: string | null;
}

export interface SatelliteSetupCallbacks {
  onClose: () => void;
  onComplete: () => void;
  onRefreshUrls: () => Promise<MasterUrlInfo[]>;
  onScanForMasters?: () => Promise<MasterUrlInfo[]>;
}

// ── Default State ─────────────────────────────────────────

export function createSatelliteSetupState(): SatelliteSetupState {
  return {
    step: "intro",
    platform: null,
    nodeName: "",
    masterUrls: [],
    selectedUrl: null,
    generatedConfig: "",
    installCommand: "",
    connecting: false,
    connected: false,
    scanning: false,
    error: null,
  };
}

// ── Config Generator ──────────────────────────────────────

function generateSatelliteConfig(
  masterUrl: string,
  nodeName: string,
  platform: string
): string {
  const config = {
    meta: {
      comment: `Satellite node: ${nodeName}`,
      generatedAt: new Date().toISOString(),
    },
    federation: {
      enabled: true,
      mode: "satellite",
      masterUrl: masterUrl,
      nodeName: nodeName,
      discovery: true,
    },
    agents: {
      defaults: {
        workspace: platform === "windows"
          ? "C:\\\\Users\\\\$USER\\\\infinibot"
          : "~/infinibot",
      },
      list: [
        {
          id: "main",
          default: true,
          name: nodeName,
        },
      ],
    },
    gateway: {
      port: 47913,
      mode: "local",
      bind: "lan",
    },
    channels: {},
    commands: {
      native: "auto",
      nativeSkills: "auto",
    },
  };

  return JSON.stringify(config, null, 2);
}

function getInstallCommand(platform: string): string {
  switch (platform) {
    case "linux":
    case "macos":
      return `# Install InfiniBot
curl -fsSL https://get.infinibot.dev | bash

# Or with npm
npm install -g @anthropic/infinibot

# Start the gateway
infinibot gateway start`;

    case "windows":
      return `# Install with npm (requires Node.js)
npm install -g @anthropic/infinibot

# Or download installer from:
# https://github.com/MrYungCEO/infinibotOS/releases

# Start the gateway
infinibot gateway start`;

    case "docker":
      return `# Pull the image
docker pull ghcr.io/mryungceo/infinibotos:latest

# Run with config mounted
docker run -d \\
  --name infinibot-satellite \\
  -v ~/.infinibot:/root/.infinibot \\
  -p 47913:47913 \\
  ghcr.io/mryungceo/infinibotos:latest \\
  gateway start`;

    default:
      return "# Select a platform above";
  }
}

// ── Main Render ───────────────────────────────────────────

export function renderSatelliteSetupWizard(
  state: SatelliteSetupState,
  callbacks: SatelliteSetupCallbacks,
  updateState: (updates: Partial<SatelliteSetupState>) => void
) {
  return html`
    <div class="wizard-backdrop" @click=${(e: Event) => {
      if (e.target === e.currentTarget) callbacks.onClose();
    }}>
      <div class="wizard-container">
        <!-- Header -->
        <div class="wizard-header">
          <div class="wizard-title">
            <span class="wizard-icon">🚀</span>
            <div>
              <h2>Add Satellite Node</h2>
              <p>Connect another device to your InfiniBot network</p>
            </div>
          </div>
          <button class="wizard-close" @click=${callbacks.onClose}>✕</button>
        </div>

        <!-- Progress -->
        <div class="wizard-progress">
          ${renderProgressSteps(state.step)}
        </div>

        <!-- Content -->
        <div class="wizard-content">
          ${state.step === "intro" ? renderIntroStep(state, updateState) : nothing}
          ${state.step === "platform" ? renderPlatformStep(state, updateState) : nothing}
          ${state.step === "install" ? renderInstallStep(state, updateState) : nothing}
          ${state.step === "config" ? renderConfigStep(state, updateState, callbacks) : nothing}
          ${state.step === "connect" ? renderConnectStep(state, updateState) : nothing}
          ${state.step === "done" ? renderDoneStep(state, callbacks) : nothing}
        </div>

        <!-- Footer -->
        <div class="wizard-footer">
          ${renderFooterButtons(state, updateState, callbacks)}
        </div>
      </div>
    </div>

    <style>
      .wizard-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100002;
        padding: 20px;
      }

      .wizard-container {
        width: 100%;
        max-width: 700px;
        max-height: 90vh;
        background: linear-gradient(180deg, #1a1a2e 0%, #16162a 100%);
        border: 1px solid rgba(139, 92, 246, 0.3);
        border-radius: 20px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 40px rgba(139, 92, 246, 0.1);
      }

      .wizard-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 24px 28px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }

      .wizard-title {
        display: flex;
        align-items: flex-start;
        gap: 16px;
      }

      .wizard-icon {
        font-size: 36px;
      }

      .wizard-title h2 {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
        color: #fff;
      }

      .wizard-title p {
        margin: 6px 0 0 0;
        font-size: 14px;
        color: #71717a;
      }

      .wizard-close {
        background: rgba(255, 255, 255, 0.05);
        border: none;
        border-radius: 8px;
        width: 36px;
        height: 36px;
        color: #71717a;
        cursor: pointer;
        font-size: 18px;
        transition: all 0.2s;
      }

      .wizard-close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      /* Progress Steps */
      .wizard-progress {
        display: flex;
        justify-content: center;
        gap: 8px;
        padding: 20px;
        background: rgba(0, 0, 0, 0.2);
      }

      .progress-step {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .step-dot {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 600;
        transition: all 0.3s;
      }

      .step-dot.inactive {
        background: rgba(255, 255, 255, 0.05);
        color: #52525b;
      }

      .step-dot.active {
        background: linear-gradient(135deg, #8b5cf6, #6366f1);
        color: #fff;
        box-shadow: 0 0 20px rgba(139, 92, 246, 0.5);
      }

      .step-dot.completed {
        background: #22c55e;
        color: #fff;
      }

      .step-connector {
        width: 32px;
        height: 2px;
        background: rgba(255, 255, 255, 0.1);
      }

      .step-connector.completed {
        background: #22c55e;
      }

      /* Content Area */
      .wizard-content {
        flex: 1;
        overflow-y: auto;
        padding: 28px;
      }

      /* Footer */
      .wizard-footer {
        display: flex;
        justify-content: space-between;
        padding: 20px 28px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        background: rgba(0, 0, 0, 0.2);
      }

      .footer-left {
        display: flex;
        gap: 12px;
      }

      .footer-right {
        display: flex;
        gap: 12px;
      }

      /* Buttons */
      .btn {
        padding: 12px 24px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .btn--secondary {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #a1a1aa;
      }

      .btn--secondary:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .btn--primary {
        background: linear-gradient(135deg, #8b5cf6, #6366f1);
        border: none;
        color: #fff;
      }

      .btn--primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 20px rgba(139, 92, 246, 0.4);
      }

      .btn--primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }

      .btn--success {
        background: linear-gradient(135deg, #22c55e, #16a34a);
        border: none;
        color: #fff;
      }

      /* Step Content */
      .step-content h3 {
        font-size: 18px;
        font-weight: 700;
        color: #fff;
        margin: 0 0 12px 0;
      }

      .step-content p {
        font-size: 14px;
        color: #a1a1aa;
        margin: 0 0 24px 0;
        line-height: 1.6;
      }

      /* Platform Selector */
      .platform-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
      }

      .platform-card {
        padding: 24px;
        background: rgba(0, 0, 0, 0.3);
        border: 2px solid rgba(255, 255, 255, 0.05);
        border-radius: 14px;
        cursor: pointer;
        transition: all 0.2s;
        text-align: center;
      }

      .platform-card:hover {
        border-color: rgba(139, 92, 246, 0.3);
        background: rgba(139, 92, 246, 0.05);
      }

      .platform-card.selected {
        border-color: #8b5cf6;
        background: rgba(139, 92, 246, 0.1);
      }

      .platform-icon {
        font-size: 40px;
        margin-bottom: 12px;
      }

      .platform-name {
        font-size: 16px;
        font-weight: 600;
        color: #fff;
      }

      .platform-desc {
        font-size: 12px;
        color: #71717a;
        margin-top: 4px;
      }

      /* Code Block */
      .code-block {
        background: #0a0a0f;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        padding: 20px;
        margin: 16px 0;
        position: relative;
      }

      .code-block pre {
        margin: 0;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 13px;
        color: #22d3ee;
        white-space: pre-wrap;
        word-break: break-all;
        line-height: 1.6;
      }

      .code-block .copy-btn {
        position: absolute;
        top: 12px;
        right: 12px;
        padding: 6px 14px;
        background: rgba(139, 92, 246, 0.2);
        border: none;
        border-radius: 6px;
        color: #a78bfa;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
      }

      .code-block .copy-btn:hover {
        background: rgba(139, 92, 246, 0.3);
        color: #fff;
      }

      .code-label {
        font-size: 12px;
        font-weight: 600;
        color: #71717a;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }

      /* Form */
      .form-group {
        margin-bottom: 20px;
      }

      .form-group label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        color: #a1a1aa;
        margin-bottom: 8px;
      }

      .form-group input {
        width: 100%;
        padding: 14px 18px;
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        color: #fff;
        font-size: 14px;
        box-sizing: border-box;
      }

      .form-group input:focus {
        outline: none;
        border-color: rgba(139, 92, 246, 0.5);
      }

      .form-group input::placeholder {
        color: #52525b;
      }

      /* URL Selector */
      .url-selector {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin: 16px 0;
      }

      .url-option {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 14px 18px;
        background: rgba(0, 0, 0, 0.3);
        border: 2px solid rgba(255, 255, 255, 0.05);
        border-radius: 10px;
        cursor: pointer;
        transition: all 0.2s;
      }

      .url-option:hover {
        border-color: rgba(139, 92, 246, 0.3);
      }

      .url-option.selected {
        border-color: #8b5cf6;
        background: rgba(139, 92, 246, 0.08);
      }

      .url-option input[type="radio"] {
        display: none;
      }

      .url-radio {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .url-option.selected .url-radio {
        border-color: #8b5cf6;
        background: #8b5cf6;
      }

      .url-option.selected .url-radio::after {
        content: "✓";
        color: #fff;
        font-size: 10px;
        font-weight: bold;
      }

      .url-info {
        flex: 1;
      }

      .url-label {
        font-size: 14px;
        font-weight: 500;
        color: #fff;
      }

      .url-value {
        font-size: 12px;
        font-family: monospace;
        color: #71717a;
        margin-top: 2px;
      }

      .url-badge {
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .url-badge.lan { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
      .url-badge.tailscale { background: rgba(139, 92, 246, 0.2); color: #a78bfa; }
      .url-badge.tunnel { background: rgba(16, 185, 129, 0.2); color: #34d399; }

      /* Success State */
      .success-content {
        text-align: center;
        padding: 20px 0;
      }

      .success-icon {
        font-size: 64px;
        margin-bottom: 20px;
      }

      .success-content h3 {
        font-size: 24px;
        margin-bottom: 12px;
      }

      /* Info Box */
      .info-box {
        background: rgba(59, 130, 246, 0.1);
        border: 1px solid rgba(59, 130, 246, 0.2);
        border-radius: 10px;
        padding: 16px;
        display: flex;
        gap: 12px;
        margin: 16px 0;
      }

      .info-box .icon {
        font-size: 20px;
      }

      .info-box .content {
        flex: 1;
        font-size: 13px;
        color: #93c5fd;
        line-height: 1.5;
      }

      /* Loading */
      .loading-spinner {
        display: inline-block;
        width: 20px;
        height: 20px;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      /* Responsive */
      @media (max-width: 640px) {
        .platform-grid {
          grid-template-columns: 1fr;
        }
        
        .wizard-container {
          max-height: 100vh;
          border-radius: 0;
        }
      }
    </style>
  `;
}

// ── Progress Steps ────────────────────────────────────────

function renderProgressSteps(currentStep: SatelliteSetupState["step"]) {
  const steps = ["intro", "platform", "install", "config", "connect", "done"];
  const labels = ["Start", "Platform", "Install", "Configure", "Connect", "Done"];
  const currentIndex = steps.indexOf(currentStep);

  return html`
    ${steps.map((step, i) => html`
      ${i > 0 ? html`<div class="step-connector ${i <= currentIndex ? "completed" : ""}"></div>` : nothing}
      <div class="progress-step">
        <div class="step-dot ${i < currentIndex ? "completed" : i === currentIndex ? "active" : "inactive"}">
          ${i < currentIndex ? "✓" : i + 1}
        </div>
      </div>
    `)}
  `;
}

// ── Step Renderers ────────────────────────────────────────

function renderIntroStep(
  state: SatelliteSetupState,
  updateState: (updates: Partial<SatelliteSetupState>) => void
) {
  return html`
    <div class="step-content">
      <h3>What is Federation?</h3>
      <p>
        Federation lets you connect multiple InfiniBot instances across devices. Each satellite 
        node runs its own AI agent that can be accessed through the main dashboard.
      </p>

      <div class="info-box">
        <span class="icon">💡</span>
        <div class="content">
          <strong>Use cases:</strong><br>
          • Run a dedicated coding agent on your workstation<br>
          • Add a home server with GPU for image generation<br>
          • Connect a laptop for mobile access<br>
          • Distribute compute across multiple machines
        </div>
      </div>

      <div class="form-group">
        <label>Node Name</label>
        <input 
          type="text" 
          placeholder="e.g., ASUS-TUF-Linux, Mac-Studio, etc."
          .value=${state.nodeName}
          @input=${(e: Event) => updateState({ nodeName: (e.target as HTMLInputElement).value })}
        />
      </div>
    </div>
  `;
}

function renderPlatformStep(
  state: SatelliteSetupState,
  updateState: (updates: Partial<SatelliteSetupState>) => void
) {
  const platforms = [
    { id: "linux", icon: "🐧", name: "Linux", desc: "Ubuntu, Debian, Fedora, etc." },
    { id: "macos", icon: "🍎", name: "macOS", desc: "Intel or Apple Silicon" },
    { id: "windows", icon: "🪟", name: "Windows", desc: "Windows 10/11" },
    { id: "docker", icon: "🐳", name: "Docker", desc: "Container deployment" },
  ];

  return html`
    <div class="step-content">
      <h3>Select Platform</h3>
      <p>What operating system will the satellite node run on?</p>

      <div class="platform-grid">
        ${platforms.map((p) => html`
          <div 
            class="platform-card ${state.platform === p.id ? "selected" : ""}"
            @click=${() => updateState({ 
              platform: p.id as SatelliteSetupState["platform"],
              installCommand: getInstallCommand(p.id),
            })}
          >
            <div class="platform-icon">${p.icon}</div>
            <div class="platform-name">${p.name}</div>
            <div class="platform-desc">${p.desc}</div>
          </div>
        `)}
      </div>
    </div>
  `;
}

function renderInstallStep(
  state: SatelliteSetupState,
  updateState: (updates: Partial<SatelliteSetupState>) => void
) {
  const copyCommand = () => {
    navigator.clipboard.writeText(state.installCommand).catch(() => {});
  };

  return html`
    <div class="step-content">
      <h3>Install InfiniBot</h3>
      <p>Run these commands on the satellite device to install InfiniBot.</p>

      <div class="code-label">Installation Commands</div>
      <div class="code-block">
        <pre>${state.installCommand}</pre>
        <button class="copy-btn" @click=${copyCommand}>📋 Copy</button>
      </div>

      <div class="info-box">
        <span class="icon">ℹ️</span>
        <div class="content">
          Make sure Node.js 18+ is installed on the target device.
          After installation, proceed to configure the connection.
        </div>
      </div>
    </div>
  `;
}

function renderConfigStep(
  state: SatelliteSetupState,
  updateState: (updates: Partial<SatelliteSetupState>) => void,
  callbacks: SatelliteSetupCallbacks
) {
  // Auto-select first URL if none selected
  if (!state.selectedUrl && state.masterUrls.length > 0) {
    const preferred = state.masterUrls.find(u => u.type === "tailscale")
      || state.masterUrls.find(u => u.type === "tunnel")
      || state.masterUrls[0];
    updateState({ selectedUrl: preferred });
  }

  // Generate config when URL is selected
  const config = state.selectedUrl
    ? generateSatelliteConfig(state.selectedUrl.url, state.nodeName || "satellite", state.platform || "linux")
    : "";

  const copyConfig = () => {
    navigator.clipboard.writeText(config).catch(() => {});
  };

  const configPath = state.platform === "windows"
    ? "%USERPROFILE%\\.infinibot\\infinibot.json"
    : "~/.infinibot/infinibot.json";

  const scanLan = async () => {
    if (!callbacks.onScanForMasters || state.scanning) return;
    updateState({ scanning: true, error: null });
    try {
      const found = await callbacks.onScanForMasters();
      if (found.length > 0) {
        const merged = [
          ...state.masterUrls.filter(u => !found.some(f => f.url === u.url)),
          ...found,
        ];
        updateState({ scanning: false, masterUrls: merged, selectedUrl: found[0] });
      } else {
        updateState({ scanning: false, error: "No masters found on LAN via mDNS. Try selecting a URL manually." });
      }
    } catch {
      updateState({ scanning: false, error: "mDNS scan failed. Master may not be advertising." });
    }
  };

  // Quick toggle: jump straight to a Tailscale URL (works off-LAN) or back
  // to the first LAN URL, instead of making the user hunt through the list.
  const useNetworkType = (type: "tailscale" | "lan") => {
    const match = state.masterUrls.find(u => u.type === type);
    if (match) {
      updateState({ selectedUrl: match, error: null });
    } else {
      updateState({
        error: type === "tailscale"
          ? "No Tailscale address available. Make sure Tailscale is running on this master."
          : "No LAN address available.",
      });
    }
  };

  return html`
    <div class="step-content">
      <h3>Configure Connection</h3>
      <p>Select how the satellite will connect to this master node.</p>

      <div class="code-label" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <span>Connection URL</span>
        <div style="display:flex;gap:8px;">
          <button
            class="btn btn--secondary"
            style="padding:6px 14px;font-size:12px;${state.selectedUrl?.type === "tailscale" ? "border-color:#8b5cf6;color:#a78bfa;" : ""}"
            title="Use a Tailscale address so this satellite can connect from anywhere, not just the local network"
            @click=${() => useNetworkType("tailscale")}
          >
            🔒 Use Tailscale
          </button>
          <button
            class="btn btn--secondary"
            style="padding:6px 14px;font-size:12px;${state.selectedUrl?.type === "lan" ? "border-color:#3b82f6;color:#60a5fa;" : ""}"
            title="Use a LAN address (only reachable on the same local network)"
            @click=${() => useNetworkType("lan")}
          >
            🏠 Use LAN
          </button>
          ${callbacks.onScanForMasters ? html`
            <button
              class="btn btn--secondary"
              style="padding:6px 14px;font-size:12px;"
              ?disabled=${state.scanning}
              @click=${scanLan}
            >
              ${state.scanning ? html`<span class="loading-spinner" style="width:12px;height:12px;border-width:1.5px;"></span> Scanning...` : "⊕ Scan LAN"}
            </button>
          ` : nothing}
        </div>
      </div>

      <div class="url-selector">
        ${state.masterUrls.map((url) => html`
          <div
            class="url-option ${state.selectedUrl?.url === url.url ? "selected" : ""}"
            @click=${() => updateState({ selectedUrl: url })}
          >
            <div class="url-radio"></div>
            <div class="url-info">
              <div class="url-label">${url.label}</div>
              <div class="url-value">${url.url}</div>
            </div>
            <span class="url-badge ${url.type}">${url.type}</span>
          </div>
        `)}
        ${state.masterUrls.length === 0 && !state.scanning ? html`
          <div class="info-box" style="margin:0;">
            <span class="icon">📡</span>
            <div class="content">No addresses found yet. Click <strong>Scan LAN</strong> to discover masters via mDNS, or wait — this device's IPs will appear once loaded.</div>
          </div>
        ` : nothing}
      </div>

      ${state.error ? html`
        <div class="info-box" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.2);margin-top:12px;">
          <span class="icon">⚠️</span>
          <div class="content" style="color:#fca5a5;">${state.error}</div>
        </div>
      ` : nothing}

      <div class="code-label">Configuration File</div>
      <p style="font-size: 13px; color: #71717a;">
        Save this to <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">${configPath}</code> on the satellite:
      </p>
      <div class="code-block" style="max-height: 200px; overflow-y: auto;">
        <pre>${config}</pre>
        <button class="copy-btn" @click=${copyConfig}>📋 Copy</button>
      </div>

      <div class="info-box">
        <span class="icon">🔒</span>
        <div class="content">
          <strong>Security Note:</strong> Use Tailscale or Tunnel URLs for connections outside your local network.
          LAN URLs only work within the same network.
        </div>
      </div>
    </div>
  `;
}

function renderConnectStep(
  state: SatelliteSetupState,
  updateState: (updates: Partial<SatelliteSetupState>) => void
) {
  const startCommand = state.platform === "docker"
    ? "docker start infinibot-satellite"
    : "infinibot gateway start";

  return html`
    <div class="step-content">
      <h3>Start the Satellite</h3>
      <p>After saving the config, start the InfiniBot gateway on the satellite device.</p>

      <div class="code-label">Start Command</div>
      <div class="code-block">
        <pre>${startCommand}</pre>
        <button class="copy-btn" @click=${() => navigator.clipboard.writeText(startCommand)}>📋 Copy</button>
      </div>

      ${state.connecting ? html`
        <div style="text-align: center; padding: 24px;">
          <div class="loading-spinner"></div>
          <p style="color: #a1a1aa; margin-top: 12px;">Waiting for satellite to connect...</p>
        </div>
      ` : nothing}

      ${state.error ? html`
        <div class="info-box" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2);">
          <span class="icon">⚠️</span>
          <div class="content" style="color: #fca5a5;">${state.error}</div>
        </div>
      ` : nothing}

      <div class="info-box">
        <span class="icon">💡</span>
        <div class="content">
          Once the satellite starts, it will automatically connect to this master.
          You'll see it appear in the Connected Nodes list.
        </div>
      </div>
    </div>
  `;
}

function renderDoneStep(
  state: SatelliteSetupState,
  callbacks: SatelliteSetupCallbacks
) {
  return html`
    <div class="step-content success-content">
      <div class="success-icon">🎉</div>
      <h3>Satellite Added!</h3>
      <p style="text-align: center;">
        ${state.nodeName || "Your satellite"} is now part of the federation network.<br>
        You can select it from the node dropdown to route sessions to it.
      </p>

      <div class="info-box">
        <span class="icon">🚀</span>
        <div class="content">
          <strong>Next steps:</strong><br>
          • Open the session grid and select the new node<br>
          • Configure agents and capabilities on the satellite<br>
          • Set up MCP servers for specialized tools
        </div>
      </div>
    </div>
  `;
}

// ── Footer Buttons ────────────────────────────────────────

function renderFooterButtons(
  state: SatelliteSetupState,
  updateState: (updates: Partial<SatelliteSetupState>) => void,
  callbacks: SatelliteSetupCallbacks
) {
  const steps: SatelliteSetupState["step"][] = ["intro", "platform", "install", "config", "connect", "done"];
  const currentIndex = steps.indexOf(state.step);

  const goBack = () => {
    if (currentIndex > 0) {
      updateState({ step: steps[currentIndex - 1] });
    }
  };

  const goNext = async () => {
    if (currentIndex < steps.length - 1) {
      // If moving to config step, refresh URLs
      if (steps[currentIndex + 1] === "config") {
        const urls = await callbacks.onRefreshUrls();
        updateState({ 
          step: steps[currentIndex + 1],
          masterUrls: urls,
        });
      } else {
        updateState({ step: steps[currentIndex + 1] });
      }
    }
  };

  const canProceed = () => {
    switch (state.step) {
      case "intro": return state.nodeName.trim().length > 0;
      case "platform": return state.platform !== null;
      case "install": return true;
      case "config": return state.selectedUrl !== null;
      case "connect": return true;
      case "done": return true;
    }
  };

  return html`
    <div class="footer-left">
      ${currentIndex > 0 && state.step !== "done" ? html`
        <button class="btn btn--secondary" @click=${goBack}>
          ← Back
        </button>
      ` : html`<div></div>`}
    </div>
    <div class="footer-right">
      ${state.step === "done" ? html`
        <button class="btn btn--success" @click=${callbacks.onComplete}>
          ✓ Done
        </button>
      ` : html`
        <button 
          class="btn btn--primary" 
          ?disabled=${!canProceed()}
          @click=${goNext}
        >
          ${state.step === "connect" ? "Check Connection" : "Continue"} →
        </button>
      `}
    </div>
  `;
}
