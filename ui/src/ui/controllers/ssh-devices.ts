/**
 * SSH Devices Controller - UI state and gateway communication
 * Supports real-time scan progress via WebSocket events
 */

import type { GatewayBrowserClient } from "../gateway";

export interface SSHDevice {
  id: string;
  name: string;
  ip: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  description?: string;
  tags?: string[];
  lastConnected?: number;
  lastSeen?: number;
  isOnline?: boolean;
  hostname?: string;
  osType?: string;
  createdAt: number;
  updatedAt: number;
  isActive?: boolean;
}

export interface SSHDeviceScanResult {
  ip: string;
  port: number;
  hostname?: string;
  isSSH: boolean;
  responseTime?: number;
}

export type ScanLogEntry = {
  timestamp: number;
  type: "info" | "success" | "error" | "checking";
  message: string;
  ip?: string;
  responseTime?: number;
};

export type ScanProgressEvent = 
  | { type: "start"; subnet: string; total: number; port: number }
  | { type: "checking"; ip: string; current: number; total: number }
  | { type: "found"; device: SSHDeviceScanResult; current: number; total: number }
  | { type: "checked"; ip: string; found: boolean; current: number; total: number; responseTime?: number }
  | { type: "batch_complete"; batchNumber: number; totalBatches: number; foundSoFar: number }
  | { type: "complete"; found: number; total: number; durationMs: number };

export interface SSHDevicesState {
  client: GatewayBrowserClient | null;
  connected: boolean;
  devices: SSHDevice[];
  activeDeviceId: string | null;
  loading: boolean;
  error: string | null;
  
  // Scan state
  scanning: boolean;
  scanResults: SSHDeviceScanResult[];
  scanProgress: number; // 0-100
  scanCurrent: number;
  scanTotal: number;
  scanFoundCount: number;
  scanLogs: ScanLogEntry[];
  scanStartTime: number | null;
  
  // UI state
  editingDevice: SSHDevice | null;
  showAddForm: boolean;
  showScanDialog: boolean;
}

export function createSSHDevicesState(): SSHDevicesState {
  return {
    client: null,
    connected: false,
    devices: [],
    activeDeviceId: null,
    loading: false,
    error: null,
    scanning: false,
    scanResults: [],
    scanProgress: 0,
    scanCurrent: 0,
    scanTotal: 0,
    scanFoundCount: 0,
    scanLogs: [],
    scanStartTime: null,
    editingDevice: null,
    showAddForm: false,
    showScanDialog: false,
  };
}

// ── Scan Progress Event Handler ─────────────────────────────

export function handleScanProgressEvent(state: SSHDevicesState, event: ScanProgressEvent): void {
  const now = Date.now();
  
  switch (event.type) {
    case "start":
      state.scanning = true;
      state.scanProgress = 0;
      state.scanCurrent = 0;
      state.scanTotal = event.total;
      state.scanFoundCount = 0;
      state.scanResults = [];
      state.scanStartTime = now;
      state.scanLogs = [{
        timestamp: now,
        type: "info",
        message: `🔍 Starting scan of ${event.subnet}.* (${event.total} IPs, port ${event.port})`,
      }];
      break;
      
    case "checking":
      // Only log every 10th IP to avoid log spam
      if (event.current % 10 === 1 || event.current === event.total) {
        state.scanLogs.push({
          timestamp: now,
          type: "checking",
          message: `Checking ${event.ip}...`,
          ip: event.ip,
        });
      }
      state.scanCurrent = event.current;
      state.scanProgress = Math.round((event.current / event.total) * 100);
      break;
      
    case "found":
      state.scanResults.push(event.device);
      state.scanFoundCount = state.scanResults.length;
      state.scanLogs.push({
        timestamp: now,
        type: "success",
        message: `✅ Found SSH device: ${event.device.ip}${event.device.hostname ? ` (${event.device.hostname})` : ""} - ${event.device.responseTime}ms`,
        ip: event.device.ip,
        responseTime: event.device.responseTime,
      });
      break;
      
    case "checked":
      state.scanCurrent = event.current;
      state.scanProgress = Math.round((event.current / event.total) * 100);
      break;
      
    case "batch_complete":
      state.scanLogs.push({
        timestamp: now,
        type: "info",
        message: `📦 Batch ${event.batchNumber}/${event.totalBatches} complete (${event.foundSoFar} devices found)`,
      });
      break;
      
    case "complete":
      state.scanning = false;
      state.scanProgress = 100;
      const duration = event.durationMs / 1000;
      state.scanLogs.push({
        timestamp: now,
        type: "info",
        message: `🏁 Scan complete: ${event.found} devices found in ${duration.toFixed(1)}s`,
      });
      break;
  }
  
  // Keep only last 100 log entries
  if (state.scanLogs.length > 100) {
    state.scanLogs = state.scanLogs.slice(-100);
  }
}

// ── Subscribe to scan progress events ───────────────────────

export function subscribeToScanProgress(
  state: SSHDevicesState, 
  onUpdate: () => void
): () => void {
  if (!state.client) {
    console.log("[ssh-scan] No client available for subscription");
    return () => {};
  }
  
  console.log("[ssh-scan] Setting up scan progress subscription");
  
  // Use the gateway client's subscribe method which takes a full event frame
  const unsubscribe = state.client.subscribe((evt) => {
    // Log all events for debugging
    if (evt.event?.startsWith("ssh.")) {
      console.log("[ssh-scan] Received event:", evt.event, evt.payload);
    }
    
    if (evt.event === "ssh.scan.progress" && evt.payload) {
      console.log("[ssh-scan] Processing scan progress:", (evt.payload as ScanProgressEvent).type);
      handleScanProgressEvent(state, evt.payload as ScanProgressEvent);
      console.log("[ssh-scan] State after update:", {
        scanning: state.scanning,
        progress: state.scanProgress,
        found: state.scanFoundCount,
        logsCount: state.scanLogs.length
      });
      onUpdate();
    }
  });
  
  return unsubscribe;
}

// ── Load Devices ────────────────────────────────────────────

export async function loadSSHDevices(state: SSHDevicesState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) return;
  if (state.loading) return;
  
  state.loading = true;
  if (!opts?.quiet) state.error = null;
  
  try {
    const res = await state.client.request("ssh.device.list", {}) as {
      devices?: SSHDevice[];
      activeDeviceId?: string | null;
    };
    
    state.devices = res.devices || [];
    state.activeDeviceId = res.activeDeviceId || null;
  } catch (err) {
    if (!opts?.quiet) state.error = String(err);
  } finally {
    state.loading = false;
  }
}

// ── Get Single Device ───────────────────────────────────────

export async function getSSHDevice(
  state: SSHDevicesState, 
  params: { id?: string; name?: string; ip?: string }
): Promise<SSHDevice | null> {
  if (!state.client || !state.connected) return null;
  
  try {
    const res = await state.client.request("ssh.device.get", params) as {
      device?: SSHDevice;
      error?: string;
    };
    
    if (res.error) {
      state.error = res.error;
      return null;
    }
    
    return res.device || null;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

// ── Create Device ───────────────────────────────────────────

export async function createSSHDevice(
  state: SSHDevicesState,
  device: {
    name: string;
    ip: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    description?: string;
    tags?: string[];
  }
): Promise<SSHDevice | null> {
  if (!state.client || !state.connected) return null;
  state.error = null;
  
  try {
    const res = await state.client.request("ssh.device.create", device) as {
      device?: SSHDevice;
      error?: string;
    };
    
    if (res.error) {
      state.error = res.error;
      return null;
    }
    
    await loadSSHDevices(state, { quiet: true });
    return res.device || null;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

// ── Update Device ───────────────────────────────────────────

export async function updateSSHDevice(
  state: SSHDevicesState,
  id: string,
  updates: Partial<SSHDevice>
): Promise<SSHDevice | null> {
  if (!state.client || !state.connected) return null;
  state.error = null;
  
  try {
    const res = await state.client.request("ssh.device.update", { id, ...updates }) as {
      device?: SSHDevice;
      error?: string;
    };
    
    if (res.error) {
      state.error = res.error;
      return null;
    }
    
    await loadSSHDevices(state, { quiet: true });
    return res.device || null;
  } catch (err) {
    state.error = String(err);
    return null;
  }
}

// ── Delete Device ───────────────────────────────────────────

export async function deleteSSHDevice(state: SSHDevicesState, id: string): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  
  const device = state.devices.find(d => d.id === id);
  if (!device) return false;
  
  const confirmed = window.confirm(`Delete device "${device.name}"?`);
  if (!confirmed) return false;
  
  try {
    const res = await state.client.request("ssh.device.delete", { id }) as {
      deleted?: boolean;
      error?: string;
    };
    
    if (res.error) {
      state.error = res.error;
      return false;
    }
    
    await loadSSHDevices(state, { quiet: true });
    return res.deleted || false;
  } catch (err) {
    state.error = String(err);
    return false;
  }
}

// ── Set Active Device ───────────────────────────────────────

export async function setActiveSSHDevice(
  state: SSHDevicesState,
  params: { id?: string; name?: string } | null
): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  
  try {
    const res = await state.client.request("ssh.device.setActive", params || {}) as {
      activeDeviceId?: string | null;
      error?: string;
    };
    
    if (res.error) {
      state.error = res.error;
      return false;
    }
    
    state.activeDeviceId = res.activeDeviceId || null;
    await loadSSHDevices(state, { quiet: true });
    return true;
  } catch (err) {
    state.error = String(err);
    return false;
  }
}

// ── Scan Network (starts async scan with progress events) ───

export async function scanSSHDevices(
  state: SSHDevicesState,
  params: { subnet?: string; ips?: string[]; port?: number }
): Promise<SSHDeviceScanResult[]> {
  if (!state.client || !state.connected) return [];
  
  // Reset scan state
  state.scanning = true;
  state.scanResults = [];
  state.scanProgress = 0;
  state.scanCurrent = 0;
  state.scanTotal = 0;
  state.scanFoundCount = 0;
  state.scanLogs = [];
  state.scanStartTime = Date.now();
  state.error = null;
  
  try {
    // Request scan with streamProgress enabled (default)
    const res = await state.client.request("ssh.device.scan", {
      ...params,
      streamProgress: true,
    }) as {
      results?: SSHDeviceScanResult[];
      error?: string;
    };
    
    if (res.error) {
      state.error = res.error;
      state.scanning = false;
      return [];
    }
    
    // Results come back after scan completes
    // Progress events update state in real-time via WebSocket
    state.scanResults = res.results || [];
    state.scanning = false;
    return state.scanResults;
  } catch (err) {
    state.error = String(err);
    state.scanning = false;
    return [];
  }
}

// ── Test Connection ─────────────────────────────────────────

export async function testSSHConnection(
  state: SSHDevicesState,
  params: { id?: string; ip?: string; port?: number; username?: string; password?: string }
): Promise<{ success: boolean; message: string; latencyMs?: number }> {
  if (!state.client || !state.connected) {
    return { success: false, message: "Not connected to gateway" };
  }
  
  try {
    const res = await state.client.request("ssh.device.test", params) as {
      success?: boolean;
      message?: string;
      latencyMs?: number;
      error?: string;
    };
    
    if (res.error) {
      return { success: false, message: res.error };
    }
    
    // Refresh device list to update status
    await loadSSHDevices(state, { quiet: true });
    
    return {
      success: res.success || false,
      message: res.message || (res.success ? "Connection successful" : "Connection failed"),
      latencyMs: res.latencyMs,
    };
  } catch (err) {
    return { success: false, message: String(err) };
  }
}

// ── Ping Device ─────────────────────────────────────────────

export async function pingSSHDevice(
  state: SSHDevicesState,
  params: { id?: string; ip?: string }
): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  
  try {
    const res = await state.client.request("ssh.device.ping", params) as {
      reachable?: boolean;
      error?: string;
    };
    
    if (res.error) {
      state.error = res.error;
      return false;
    }
    
    await loadSSHDevices(state, { quiet: true });
    return res.reachable || false;
  } catch (err) {
    state.error = String(err);
    return false;
  }
}

// ── Refresh All Status ──────────────────────────────────────

export async function refreshAllDeviceStatus(state: SSHDevicesState): Promise<void> {
  if (!state.client || !state.connected) return;
  
  state.loading = true;
  
  try {
    await state.client.request("ssh.device.refreshStatus", {});
    await loadSSHDevices(state, { quiet: true });
  } catch (err) {
    state.error = String(err);
  } finally {
    state.loading = false;
  }
}

// ── Format helpers ──────────────────────────────────────────

export function formatLastSeen(timestamp?: number): string {
  if (!timestamp) return "Never";
  
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function getStatusColor(device: SSHDevice): string {
  if (device.isOnline) return "#22c55e"; // green
  if (device.lastSeen && Date.now() - device.lastSeen < 3600000) return "#eab308"; // yellow
  return "#6b7280"; // gray
}

export function formatLogTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", { 
    hour12: false, 
    hour: "2-digit", 
    minute: "2-digit", 
    second: "2-digit",
    fractionalSecondDigits: 3 
  });
}
