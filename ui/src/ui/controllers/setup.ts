/**
 * Setup & Configuration Controller
 * Manages state for the unified setup/configuration page
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { gatewayOrigin } from "../gateway-endpoint";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SetupState {
  loading: boolean;
  error: string | null;
  
  // Instance info
  instanceId: string | null;
  instanceName: string | null;
  instanceRole: "primary" | "secondary" | null;
  
  // Connection info
  gatewayUrl: string | null;
  gatewayToken: string | null;
  connectionCode: string | null;
  connectionQrDataUrl: string | null;
  
  // Download URLs (configurable)
  downloadUrls: DownloadUrls;
  
  // MCP status
  mcpEnabled: boolean;
  mcpServers: McpServerInfo[];
  mcpConfigPath: string | null;
  
  // Docker status
  dockerAvailable: boolean;
  dockerStatus: "running" | "stopped" | "error" | "unknown";
  dockerContainers: DockerContainer[];
  
  // API keys status (summary)
  apiKeysConfigured: string[];
  apiKeysMissing: string[];
  
  // Setup wizard
  wizardCompleted: boolean;
  wizardStep: number;
  
  // Active section
  activeSection: "quickstart" | "overview" | "mcp" | "docker" | "wizard" | "wizard-advanced" | "instance" | "install" | "remote" | "network" | "coder-backend" | "coders" | "kinglyvault" | "voice" | "components"; // COORDINATION: opencode-swap
  
  // Quick start state
  quickstartPlatform: "windows" | "macos" | "linux" | "docker" | null;
  quickstartChannel: string | null;
  quickstartStep: number;
}

export interface DownloadUrls {
  androidApk: string | null;
  iosTestFlight: string | null;
  windowsExe: string | null;
  windowsMsi: string | null;
  linuxAppImage: string | null;
  linuxDeb: string | null;
  macDmg: string | null;
}

export interface McpServerInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  status: "running" | "stopped" | "error";
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string[];
  created: string;
}

// ── Initial State ─────────────────────────────────────────────────────────

export function createSetupState(): SetupState {
  return {
    loading: false,
    error: null,
    instanceId: null,
    instanceName: null,
    instanceRole: null,
    gatewayUrl: null,
    gatewayToken: null,
    connectionCode: null,
    connectionQrDataUrl: null,
    downloadUrls: {
      androidApk: null,
      iosTestFlight: null,
      windowsExe: null,
      windowsMsi: null,
      linuxAppImage: null,
      linuxDeb: null,
      macDmg: null,
    },
    mcpEnabled: false,
    mcpServers: [],
    mcpConfigPath: null,
    dockerAvailable: false,
    dockerStatus: "unknown",
    dockerContainers: [],
    apiKeysConfigured: [],
    apiKeysMissing: [],
    wizardCompleted: false,
    wizardStep: 0,
    // Default to the wizard so first-run users see a guided setup. The
    // sidebar lets them switch to other panels (mcp, docker, install, …)
    // any time. `loadSetupStatus` flips this to "overview" once it detects
    // an existing config so returning users don't re-run the wizard.
    activeSection: "wizard",
    quickstartPlatform: null,
    quickstartChannel: null,
    quickstartStep: 1,
  };
}

// ── Connection Helpers ────────────────────────────────────────────────────

/**
 * Generate a short, memorable connection code from instance ID
 */
function generateConnectionCode(instanceId: string): string {
  // Use a hash of the instance ID to generate consistent code
  let hash = 0;
  for (let i = 0; i < instanceId.length; i++) {
    const char = instanceId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  let n = Math.abs(hash);
  for (let i = 0; i < 6; i++) {
    code += chars[n % chars.length];
    n = Math.floor(n / chars.length);
  }
  return code.slice(0, 3) + "-" + code.slice(3);
}

/**
 * Build a connection URL with encoded credentials
 */
export function buildConnectionUrl(
  gatewayUrl: string,
  token: string | null,
  instanceName: string | null
): string {
  // Use infinibot:// deep link scheme
  const params = new URLSearchParams();
  params.set("url", gatewayUrl);
  if (token) params.set("token", token);
  if (instanceName) params.set("name", instanceName);
  
  return `infinibot://connect?${params.toString()}`;
}

/**
 * Build an HTTP fallback URL for web-based connection
 */
export function buildWebConnectionUrl(
  gatewayUrl: string,
  token: string | null
): string {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  return `${gatewayUrl}/connect?${params.toString()}`;
}

/**
 * QR code for the connection URL. The URL embeds the gateway token/password,
 * so it must never be sent to a third-party QR service; until a local encoder
 * is wired in, return null and let the view fall back to the code + URL.
 */
async function generateQrCode(_data: string): Promise<string | null> {
  return null;
}

/**
 * Generate platform-specific install URLs with connection parameters
 */
export function getInstallUrl(
  platform: "android" | "ios" | "windows" | "linux" | "mac",
  downloadUrl: string | null,
  connectionUrl: string
): string | null {
  if (!downloadUrl) return null;
  
  // Append connection params to download URL if it's a web URL
  try {
    const url = new URL(downloadUrl);
    url.searchParams.set("connect", encodeURIComponent(connectionUrl));
    return url.toString();
  } catch {
    return downloadUrl;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────

export async function loadSetupStatus(
  client: GatewayBrowserClient,
  setState: (update: Partial<SetupState>) => void
): Promise<void> {
  setState({ loading: true, error: null });
  
  try {
    // Load config to get instance info and MCP servers
    // Served name is `config.get` — `gateway:config.get` was never registered.
    const configRes = await client.request("config.get", {}) as any;
    const config = configRes?.config || {};
    
    // Gateway config
    const gateway = config.gateway || {};
    const auth = gateway.auth || {};
    
    // Get gateway URL from current browser location (most reliable)
    const currentUrl = gatewayOrigin();
    const gatewayUrl = currentUrl;
    
    // Get token from gateway.auth.token or gateway.auth.password
    const gatewayToken = auth.token || auth.password || null;
    
    // Use assistant name from window config or config file
    const assistantName = (window as any).__INFINIBOT_ASSISTANT_NAME__ || config.agents?.list?.[0]?.identity?.name || "Infinibot";
    
    // Generate connection code based on gateway URL hash
    const connectionCode = generateConnectionCode(gatewayUrl + (gatewayToken || ""));
    
    // Generate QR code with connection URL
    const connectionUrl = buildConnectionUrl(gatewayUrl, gatewayToken, assistantName);
    const qrDataUrl = await generateQrCode(connectionUrl);
    
    // Load download URLs from localStorage (since config schema doesn't support custom keys)
    const savedDownloads = localStorage.getItem("infinibot_download_urls");
    const downloads = savedDownloads ? JSON.parse(savedDownloads) : {};
    
    setState({
      instanceId: `infinibot-${gateway.port || "local"}`,
      instanceName: assistantName,
      instanceRole: "primary",
      gatewayUrl,
      gatewayToken,
      connectionCode,
      connectionQrDataUrl: qrDataUrl,
      downloadUrls: {
        androidApk: downloads.androidApk || null,
        iosTestFlight: downloads.iosTestFlight || null,
        windowsExe: downloads.windowsExe || null,
        windowsMsi: downloads.windowsMsi || null,
        linuxAppImage: downloads.linuxAppImage || null,
        linuxDeb: downloads.linuxDeb || null,
        macDmg: downloads.macDmg || null,
      },
    });
    
    // MCP servers from config
    const mcpConfig = config.mcp || {};
    const servers: McpServerInfo[] = [];
    
    if (mcpConfig.servers) {
      for (const [id, serverConfig] of Object.entries(mcpConfig.servers)) {
        const sc = serverConfig as any;
        servers.push({
          id,
          name: sc.name || id,
          command: sc.command || "",
          args: sc.args || [],
          enabled: sc.enabled !== false,
          status: "unknown",
        });
      }
    }
    
    setState({
      mcpEnabled: servers.length > 0,
      mcpServers: servers,
      mcpConfigPath: getMcpConfigPath(),
    });
    
    // Check API keys status
    const providers = config.providers || {};
    const configured: string[] = [];
    const missing: string[] = [];
    
    const knownProviders = ["anthropic", "openai", "google", "notion", "replicate", "elevenlabs"];
    for (const provider of knownProviders) {
      const p = providers[provider];
      if (p?.apiKey) {
        configured.push(provider);
      } else {
        missing.push(provider);
      }
    }
    
    setState({
      apiKeysConfigured: configured,
      apiKeysMissing: missing,
      // First-run heuristic: if at least one model provider is configured we
      // assume the user has been through setup and land them on the overview
      // instead of forcing them back through the wizard. We only flip *to*
      // overview here — never back to the wizard — so a user mid-wizard
      // doesn't get bounced when this status load resolves.
      ...(configured.some((p) => p === "anthropic" || p === "openai" || p === "google")
        ? { activeSection: "overview" as const }
        : {}),
    });
    
    // Check Docker status (if available)
    try {
      const dockerRes = await client.request("docker.status", {}) as any;
      setState({
        dockerAvailable: true,
        dockerStatus: dockerRes?.running ? "running" : "stopped",
        dockerContainers: dockerRes?.containers || [],
      });
    } catch {
      // Docker not available or not configured
      setState({
        dockerAvailable: false,
        dockerStatus: "unknown",
        dockerContainers: [],
      });
    }
    
    // Check wizard completion status
    const wizardComplete = Boolean(instance.id && instance.name);
    setState({
      wizardCompleted: wizardComplete,
      wizardStep: wizardComplete ? 5 : 0,
      loading: false,
    });
    
  } catch (err: any) {
    setState({
      loading: false,
      error: err.message || "Failed to load setup status",
    });
  }
}

export function getMcpConfigPath(): string {
  // Detect OS and return appropriate path
  const isWindows = navigator.platform.toLowerCase().includes("win");
  const isMac = navigator.platform.toLowerCase().includes("mac");
  
  if (isWindows) {
    return "%APPDATA%/Claude/claude_desktop_config.json";
  } else if (isMac) {
    return "~/Library/Application Support/Claude/claude_desktop_config.json";
  } else {
    return "~/.config/claude/claude_desktop_config.json";
  }
}

export function generateMcpConfig(infinibotPath: string): string {
  const config = {
    mcpServers: {
      "infinibot-kanban": {
        command: "node",
        args: [`${infinibotPath}/dist/entry.js`, "mcp"],
      },
      "infinibot-files": {
        command: "node",
        args: [`${infinibotPath}/dist/entry.js`, "mcp", "--server", "files"],
      },
      "infinibot-memory": {
        command: "node",
        args: [`${infinibotPath}/dist/entry.js`, "mcp", "--server", "memory"],
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

export function getDockerSetupScript(): string {
  return `#!/usr/bin/env bash
# Infinibot Docker Setup Script
# Run this on a Linux server to deploy Infinibot via Docker

# Set environment variables
export INFINIBOT_CONFIG_DIR="\${HOME}/.infinibot"
export INFINIBOT_WORKSPACE_DIR="\${HOME}/workspace"
export INFINIBOT_GATEWAY_PORT=18789
export INFINIBOT_GATEWAY_BIND=lan

# Clone and setup
git clone https://github.com/MrYungCEO/infinibotOS.git
cd infinibotOS
./docker-setup.sh

# After setup, access the gateway at:
# http://<your-ip>:18789
`;
}

export function setActiveSection(
  setState: (update: Partial<SetupState>) => void,
  section: SetupState["activeSection"]
): void {
  setState({ activeSection: section });
}

/**
 * Update download URLs (saved to localStorage since config schema doesn't support custom keys)
 */
export async function updateDownloadUrls(
  client: GatewayBrowserClient,
  urls: Partial<DownloadUrls>,
  setState: (update: Partial<SetupState>) => void
): Promise<void> {
  try {
    // Load existing URLs from localStorage
    const savedDownloads = localStorage.getItem("infinibot_download_urls");
    const existing = savedDownloads ? JSON.parse(savedDownloads) : {};
    
    // Merge with new URLs
    const updated = { ...existing, ...urls };
    
    // Save to localStorage
    localStorage.setItem("infinibot_download_urls", JSON.stringify(updated));
    
    // Update state directly
    setState({
      downloadUrls: {
        androidApk: updated.androidApk || null,
        iosTestFlight: updated.iosTestFlight || null,
        windowsExe: updated.windowsExe || null,
        windowsMsi: updated.windowsMsi || null,
        linuxAppImage: updated.linuxAppImage || null,
        linuxDeb: updated.linuxDeb || null,
        macDmg: updated.macDmg || null,
      },
    });
  } catch (err: any) {
    setState({ error: err.message || "Failed to update download URLs" });
  }
}

/**
 * Copy connection info to clipboard
 */
export async function copyConnectionInfo(
  format: "url" | "code" | "full",
  state: SetupState
): Promise<boolean> {
  try {
    let text = "";
    
    switch (format) {
      case "url":
        text = buildConnectionUrl(
          state.gatewayUrl || "",
          state.gatewayToken,
          state.instanceName
        );
        break;
      case "code":
        text = state.connectionCode || "";
        break;
      case "full":
        text = `Infinibot Connection Details
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Instance: ${state.instanceName || "Unnamed"}
Gateway URL: ${state.gatewayUrl || "Not set"}
Token: ${state.gatewayToken || "Not set"}
Connection Code: ${state.connectionCode || "Not set"}

Quick Connect URL:
${buildConnectionUrl(state.gatewayUrl || "", state.gatewayToken, state.instanceName)}
`;
        break;
    }
    
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate install command for CLI
 */
export function getCliInstallCommand(platform: "windows" | "linux" | "mac"): string {
  switch (platform) {
    case "windows":
      return `# PowerShell (Admin)
irm https://get.infinibot.dev/install.ps1 | iex

# Or with npm
npm install -g infinibot`;
    case "linux":
      return `# Shell
curl -fsSL https://get.infinibot.dev/install.sh | bash

# Or with npm
npm install -g infinibot`;
    case "mac":
      return `# Shell
curl -fsSL https://get.infinibot.dev/install.sh | bash

# Or with Homebrew
brew install infinibot

# Or with npm
npm install -g infinibot`;
    default:
      return "npm install -g infinibot";
  }
}

/**
 * Generate the connection command for CLI
 */
export function getCliConnectCommand(state: SetupState): string {
  const url = state.gatewayUrl || "<gateway-url>";
  const token = state.gatewayToken || "<token>";
  
  return `infinibot connect --url "${url}" --token "${token}"`;
}
