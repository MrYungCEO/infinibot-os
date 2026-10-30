/**
 * Infinibot Network Controller
 * Manages multi-instance federation - registry, connections, and sync
 */

import type { GatewayBrowserClient } from "../gateway";
import { gatewayOrigin } from "../gateway-endpoint";

// ── Types ─────────────────────────────────────────────────────────────────

export interface NetworkInstance {
  id: string;
  name: string;
  url: string;
  token: string;
  role: "primary" | "secondary";
  status: "online" | "offline" | "connecting" | "error";
  lastSeen: number | null;
  lastError: string | null;
  
  // Instance capabilities
  projects: string[];        // Project IDs assigned to this instance
  agents: string[];          // Agent IDs available on this instance
  capabilities: string[];    // What this instance can do (mcp, notion, etc.)
  
  // Local info (only for current instance)
  isCurrent: boolean;
  localPath?: string;        // Workspace path on that machine
}

export interface NetworkState {
  loading: boolean;
  error: string | null;
  
  // Instance registry
  instances: NetworkInstance[];
  currentInstanceId: string | null;
  activeInstanceId: string | null;  // Which instance the UI is connected to
  
  // Connection state
  connecting: boolean;
  
  // Sync state
  syncEnabled: boolean;
  lastSyncAt: number | null;
  syncError: string | null;
  
  // UI state
  showAddInstance: boolean;
  addInstanceForm: {
    name: string;
    url: string;
    token: string;
  };
  editingInstanceId: string | null;
}

export interface NetworkSyncConfig {
  notion: boolean;
  kanban: boolean;
  memory: boolean;
  mcp: boolean;
  sessions: boolean;
}

// ── Storage Keys ──────────────────────────────────────────────────────────

const STORAGE_KEY = "infinibot_network";
const CURRENT_INSTANCE_KEY = "infinibot_current_instance";

// ── Initial State ─────────────────────────────────────────────────────────

export function createNetworkState(): NetworkState {
  return {
    loading: false,
    error: null,
    instances: [],
    currentInstanceId: null,
    activeInstanceId: null,
    connecting: false,
    syncEnabled: false,
    lastSyncAt: null,
    syncError: null,
    showAddInstance: false,
    addInstanceForm: {
      name: "",
      url: "",
      token: "",
    },
    editingInstanceId: null,
  };
}

// ── Storage Functions ─────────────────────────────────────────────────────

export function loadNetworkRegistry(): NetworkInstance[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load network registry:", e);
  }
  return [];
}

export function saveNetworkRegistry(instances: NetworkInstance[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(instances));
  } catch (e) {
    console.error("Failed to save network registry:", e);
  }
}

export function getCurrentInstanceId(): string | null {
  try {
    return localStorage.getItem(CURRENT_INSTANCE_KEY);
  } catch {
    return null;
  }
}

export function setCurrentInstanceId(id: string): void {
  try {
    localStorage.setItem(CURRENT_INSTANCE_KEY, id);
  } catch (e) {
    console.error("Failed to save current instance:", e);
  }
}

// ── Instance ID Generation ────────────────────────────────────────────────

export function generateInstanceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `inf-${timestamp}-${random}`;
}

// ── Network Actions ───────────────────────────────────────────────────────

export async function loadNetworkState(
  setState: (update: Partial<NetworkState>) => void
): Promise<void> {
  setState({ loading: true, error: null });
  
  try {
    // Load instances from localStorage
    const instances = loadNetworkRegistry();
    const currentId = getCurrentInstanceId();
    
    // If no current instance, create one for this gateway
    if (!currentId) {
      const currentInstance = await createCurrentInstance();
      instances.unshift(currentInstance);
      saveNetworkRegistry(instances);
      setCurrentInstanceId(currentInstance.id);
      
      setState({
        instances,
        currentInstanceId: currentInstance.id,
        activeInstanceId: currentInstance.id,
        loading: false,
      });
    } else {
      setState({
        instances,
        currentInstanceId: currentId,
        activeInstanceId: currentId,
        loading: false,
      });
    }
    
    // Check status of all instances
    await checkAllInstanceStatus(instances, setState);
    
  } catch (err: any) {
    setState({
      loading: false,
      error: err.message || "Failed to load network state",
    });
  }
}

async function createCurrentInstance(): Promise<NetworkInstance> {
  const id = generateInstanceId();
  const url = gatewayOrigin();
  const name = (window as any).__INFINIBOT_ASSISTANT_NAME__ || "Infinibot";
  
  return {
    id,
    name,
    url,
    token: "", // Current instance doesn't need token in storage
    role: "primary",
    status: "online",
    lastSeen: Date.now(),
    lastError: null,
    projects: [],
    agents: ["main"],
    capabilities: ["chat", "kanban", "mcp"],
    isCurrent: true,
    localPath: undefined,
  };
}

export async function checkInstanceStatus(
  instance: NetworkInstance
): Promise<NetworkInstance> {
  if (instance.isCurrent) {
    return { ...instance, status: "online", lastSeen: Date.now() };
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${instance.url}/health`, {
      signal: controller.signal,
      headers: instance.token ? { Authorization: `Bearer ${instance.token}` } : {},
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      return {
        ...instance,
        status: "online",
        lastSeen: Date.now(),
        lastError: null,
      };
    } else {
      return {
        ...instance,
        status: "error",
        lastError: `HTTP ${response.status}`,
      };
    }
  } catch (err: any) {
    return {
      ...instance,
      status: "offline",
      lastError: err.message || "Connection failed",
    };
  }
}

async function checkAllInstanceStatus(
  instances: NetworkInstance[],
  setState: (update: Partial<NetworkState>) => void
): Promise<void> {
  const updated = await Promise.all(
    instances.map(inst => checkInstanceStatus(inst))
  );
  
  setState({ instances: updated });
  saveNetworkRegistry(updated);
}

export async function addInstance(
  form: { name: string; url: string; token: string },
  setState: (update: Partial<NetworkState>) => void,
  currentState: NetworkState
): Promise<boolean> {
  setState({ connecting: true, error: null });
  
  try {
    // Validate URL format
    let url = form.url.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = `http://${url}`;
    }
    // Remove trailing slash
    url = url.replace(/\/$/, "");
    
    // Test connection
    const testInstance: NetworkInstance = {
      id: generateInstanceId(),
      name: form.name.trim() || "Unnamed Instance",
      url,
      token: form.token.trim(),
      role: "secondary",
      status: "connecting",
      lastSeen: null,
      lastError: null,
      projects: [],
      agents: [],
      capabilities: [],
      isCurrent: false,
    };
    
    const checked = await checkInstanceStatus(testInstance);
    
    if (checked.status === "offline" || checked.status === "error") {
      setState({
        connecting: false,
        error: `Failed to connect: ${checked.lastError || "Unknown error"}`,
      });
      return false;
    }
    
    // Add to registry
    const newInstances = [...currentState.instances, checked];
    saveNetworkRegistry(newInstances);
    
    setState({
      instances: newInstances,
      connecting: false,
      showAddInstance: false,
      addInstanceForm: { name: "", url: "", token: "" },
    });
    
    return true;
  } catch (err: any) {
    setState({
      connecting: false,
      error: err.message || "Failed to add instance",
    });
    return false;
  }
}

export function removeInstance(
  instanceId: string,
  setState: (update: Partial<NetworkState>) => void,
  currentState: NetworkState
): void {
  const filtered = currentState.instances.filter(i => i.id !== instanceId);
  saveNetworkRegistry(filtered);
  
  setState({ instances: filtered });
  
  // If we removed the active instance, switch to current
  if (currentState.activeInstanceId === instanceId) {
    setState({ activeInstanceId: currentState.currentInstanceId });
  }
}

export function updateInstance(
  instanceId: string,
  updates: Partial<NetworkInstance>,
  setState: (update: Partial<NetworkState>) => void,
  currentState: NetworkState
): void {
  const updated = currentState.instances.map(i =>
    i.id === instanceId ? { ...i, ...updates } : i
  );
  saveNetworkRegistry(updated);
  setState({ instances: updated, editingInstanceId: null });
}

export function setActiveInstance(
  instanceId: string,
  setState: (update: Partial<NetworkState>) => void
): void {
  setState({ activeInstanceId: instanceId });
}

export function assignProjectToInstance(
  instanceId: string,
  projectId: string,
  setState: (update: Partial<NetworkState>) => void,
  currentState: NetworkState
): void {
  const updated = currentState.instances.map(i => {
    if (i.id === instanceId) {
      const projects = i.projects.includes(projectId)
        ? i.projects
        : [...i.projects, projectId];
      return { ...i, projects };
    }
    return i;
  });
  saveNetworkRegistry(updated);
  setState({ instances: updated });
}

export function unassignProjectFromInstance(
  instanceId: string,
  projectId: string,
  setState: (update: Partial<NetworkState>) => void,
  currentState: NetworkState
): void {
  const updated = currentState.instances.map(i => {
    if (i.id === instanceId) {
      return { ...i, projects: i.projects.filter(p => p !== projectId) };
    }
    return i;
  });
  saveNetworkRegistry(updated);
  setState({ instances: updated });
}

// ── UI Helpers ────────────────────────────────────────────────────────────

export function showAddInstanceDialog(
  setState: (update: Partial<NetworkState>) => void
): void {
  setState({ showAddInstance: true, error: null });
}

export function hideAddInstanceDialog(
  setState: (update: Partial<NetworkState>) => void
): void {
  setState({
    showAddInstance: false,
    addInstanceForm: { name: "", url: "", token: "" },
    error: null,
  });
}

export function updateAddInstanceForm(
  field: "name" | "url" | "token",
  value: string,
  setState: (update: Partial<NetworkState>) => void,
  currentState: NetworkState
): void {
  setState({
    addInstanceForm: { ...currentState.addInstanceForm, [field]: value },
  });
}

// ── Gateway Connection Helpers ────────────────────────────────────────────

export function getInstanceConnectionConfig(instance: NetworkInstance): {
  url: string;
  token: string;
} {
  return {
    url: instance.url,
    token: instance.token,
  };
}

export function getActiveInstance(state: NetworkState): NetworkInstance | null {
  return state.instances.find(i => i.id === state.activeInstanceId) || null;
}

export function getCurrentInstance(state: NetworkState): NetworkInstance | null {
  return state.instances.find(i => i.id === state.currentInstanceId) || null;
}
