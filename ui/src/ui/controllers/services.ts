/**
 * Services Controller — state management and API calls for federation API services.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Types ────────────────────────────────────────────────────

export type ServiceStatus = "running" | "stopped" | "starting" | "stopping" | "error" | "unknown";
export type ServiceType = "python" | "node" | "docker" | "binary" | "external";

export interface ServiceHealthCheck {
  endpoint: string;
  method: "GET" | "POST";
  expectedStatus: number;
  timeoutMs: number;
  intervalMs: number;
  jsonPath?: string;
  expectedValue?: string | boolean;
}

export interface ServiceCapability {
  name: string;
  provides: string[];
  requirements?: {
    gpuVRAM?: number;
    systemRAM?: number;
    needsGPU?: boolean;
  };
}

export interface ServiceEndpoint {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  description: string;
  primary?: boolean;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  type: ServiceType;
  version: string;
  workdir: string;
  startCommand: string;
  startArgs?: string[];
  env?: Record<string, string>;
  port: number;
  host?: string;
  basePath?: string;
  baseUrl?: string;
  healthCheck: ServiceHealthCheck;
  startupTimeoutMs?: number;
  autoRestart?: boolean;
  maxRestartAttempts?: number;
  capabilities: ServiceCapability[];
  federationEnabled: boolean;
  preferNode?: string;
  allowMultiNode?: boolean;
  docsUrl?: string;
  endpoints?: ServiceEndpoint[];
  tags?: string[];
  dependencies?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface ServiceInstance {
  serviceId: string;
  nodeId: string;
  status: ServiceStatus;
  pid?: number;
  url: string;
  startedAt?: number;
  lastHealthCheck?: {
    timestamp: number;
    healthy: boolean;
    latencyMs: number;
    error?: string;
  };
  restartCount: number;
  lastError?: string;
}

export interface ServiceWithInstance extends ServiceDefinition {
  instance?: ServiceInstance;
}

export interface ServiceHealthResult {
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

// ── State ────────────────────────────────────────────────────

export interface ServicesState {
  loading: boolean;
  error: string | null;
  services: ServiceWithInstance[];
  selectedServiceId: string | null;
  actionInProgress: string | null;
  registerFormVisible: boolean;
  registerForm: Partial<ServiceDefinition>;
}

// ── API Calls ────────────────────────────────────────────────

export async function loadServices(state: AppViewState): Promise<void> {
  state.servicesLoading = true;
  state.servicesError = null;
  state.requestUpdate?.();

  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    const result = await client.request("services.list", {});
    state.services = result.services ?? [];
  } catch (err) {
    state.servicesError = String(err);
    console.error("[Services] Load error:", err);
  } finally {
    state.servicesLoading = false;
    state.requestUpdate?.();
  }
}

export async function startService(state: AppViewState, serviceId: string): Promise<void> {
  state.servicesActionInProgress = serviceId;
  state.requestUpdate?.();

  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    const result = await client.request("services.start", { serviceId, waitForHealthy: true });
    if (!result.success) {
      throw new Error(result.error || "Failed to start service");
    }

    // Refresh list
    await loadServices(state);
  } catch (err) {
    state.servicesError = String(err);
    console.error("[Services] Start error:", err);
    state.requestUpdate?.();
  } finally {
    state.servicesActionInProgress = null;
    state.requestUpdate?.();
  }
}

export async function stopService(state: AppViewState, serviceId: string): Promise<void> {
  state.servicesActionInProgress = serviceId;
  state.requestUpdate?.();

  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    const result = await client.request("services.stop", { serviceId });
    if (!result.success) {
      throw new Error(result.error || "Failed to stop service");
    }

    await loadServices(state);
  } catch (err) {
    state.servicesError = String(err);
    console.error("[Services] Stop error:", err);
    state.requestUpdate?.();
  } finally {
    state.servicesActionInProgress = null;
    state.requestUpdate?.();
  }
}

export async function restartService(state: AppViewState, serviceId: string): Promise<void> {
  state.servicesActionInProgress = serviceId;
  state.requestUpdate?.();

  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    const result = await client.request("services.restart", { serviceId });
    if (!result.success) {
      throw new Error(result.error || "Failed to restart service");
    }

    await loadServices(state);
  } catch (err) {
    state.servicesError = String(err);
    console.error("[Services] Restart error:", err);
    state.requestUpdate?.();
  } finally {
    state.servicesActionInProgress = null;
    state.requestUpdate?.();
  }
}

export async function checkServiceHealth(state: AppViewState, serviceId: string): Promise<ServiceHealthResult | null> {
  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    return await client.request("services.health", { serviceId });
  } catch (err) {
    console.error("[Services] Health check error:", err);
    return null;
  }
}

export async function registerService(state: AppViewState, service: Partial<ServiceDefinition>): Promise<boolean> {
  state.servicesActionInProgress = "register";
  state.requestUpdate?.();

  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    const result = await client.request("services.register", service);
    if (!result.success) {
      throw new Error(result.error || "Failed to register service");
    }

    state.servicesRegisterFormVisible = false;
    state.servicesRegisterForm = {};
    await loadServices(state);
    return true;
  } catch (err) {
    state.servicesError = String(err);
    console.error("[Services] Register error:", err);
    state.requestUpdate?.();
    return false;
  } finally {
    state.servicesActionInProgress = null;
    state.requestUpdate?.();
  }
}

export async function unregisterService(state: AppViewState, serviceId: string): Promise<void> {
  state.servicesActionInProgress = serviceId;
  state.requestUpdate?.();

  try {
    const client = state.gatewayClient;
    if (!client) throw new Error("Gateway client not available");

    await client.request("services.unregister", { serviceId });
    await loadServices(state);
  } catch (err) {
    state.servicesError = String(err);
    console.error("[Services] Unregister error:", err);
    state.requestUpdate?.();
  } finally {
    state.servicesActionInProgress = null;
    state.requestUpdate?.();
  }
}

// ── Helpers ──────────────────────────────────────────────────

export function getStatusColor(status: ServiceStatus): string {
  switch (status) {
    case "running": return "#22c55e"; // green
    case "stopped": return "#6b7280"; // gray
    case "starting": return "#f59e0b"; // amber
    case "stopping": return "#f59e0b";
    case "error": return "#ef4444"; // red
    default: return "#6b7280";
  }
}

export function getStatusIcon(status: ServiceStatus): string {
  switch (status) {
    case "running": return "●";
    case "stopped": return "○";
    case "starting": return "◐";
    case "stopping": return "◐";
    case "error": return "✕";
    default: return "?";
  }
}

export function getTypeIcon(type: ServiceType): string {
  switch (type) {
    case "python": return "🐍";
    case "node": return "📦";
    case "docker": return "🐳";
    case "binary": return "⚙️";
    case "external": return "🌐";
    default: return "❓";
  }
}

export function formatUptime(startedAt?: number): string {
  if (!startedAt) return "—";
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
