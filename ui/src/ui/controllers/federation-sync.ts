/**
 * Federation Sync Controller
 * 
 * Handles real-time federation event synchronization from the gateway.
 * - Subscribes to federation.event broadcasts
 * - Invalidates relevant UI data when events occur
 * - Shows toast notifications for important events
 */

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";

// =============================================================================
// Types
// =============================================================================

export interface FederationEvent {
  type: string;
  timestamp: number;
  sourceNodeId: string;
  payload: Record<string, unknown>;
}

export type InvalidationTarget = 
  | "sessions" 
  | "nodes" 
  | "tasks" 
  | "mcps" 
  | "config"
  | "agents"
  | "skills"
  | "all";

export type ToastType = "info" | "success" | "warning" | "error";

// =============================================================================
// Federation Sync Controller
// =============================================================================

export class FederationSyncController {
  private listeners: Map<string, Set<() => void>> = new Map();
  private lastEvents: FederationEvent[] = [];
  private maxEventHistory = 50;
  private unsubscribeGateway: (() => void) | null = null;
  
  constructor(private client: GatewayBrowserClient) {
    this.setupSubscription();
  }
  
  /**
   * Set up the gateway event subscription
   */
  private setupSubscription(): void {
    // Subscribe to federation events from gateway
    this.unsubscribeGateway = this.client.subscribe((evt: GatewayEventFrame) => {
      if (evt.event === "federation.event") {
        const payload = evt.payload as { type: string; event: FederationEvent } | undefined;
        if (payload?.event) {
          this.handleEvent(payload.event);
        }
      }
    });
  }
  
  /**
   * Handle an incoming federation event
   */
  private handleEvent(event: FederationEvent): void {
    console.log("[federation-sync] Received event:", event.type, event);
    
    // Store in history
    this.lastEvents.unshift(event);
    if (this.lastEvents.length > this.maxEventHistory) {
      this.lastEvents.pop();
    }
    
    // Determine what to invalidate
    const targets = this.getInvalidationTargets(event.type);
    for (const target of targets) {
      this.invalidate(target);
    }
    
    // Show toast for important events
    this.maybeShowToast(event);
    
    // Emit for direct listeners
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback();
        } catch (err) {
          console.error("[federation-sync] Listener error:", err);
        }
      }
    }
    
    // Emit to "all" listeners
    const allListeners = this.listeners.get("*");
    if (allListeners) {
      for (const callback of allListeners) {
        try {
          callback();
        } catch (err) {
          console.error("[federation-sync] All-listener error:", err);
        }
      }
    }
  }
  
  /**
   * Determine what data to invalidate based on event type
   */
  private getInvalidationTargets(eventType: string): InvalidationTarget[] {
    if (eventType.startsWith("session.")) return ["sessions"];
    if (eventType.startsWith("node.")) return ["nodes"];
    if (eventType.startsWith("task.")) return ["tasks"];
    if (eventType.startsWith("mcp.")) return ["mcps"];
    if (eventType.startsWith("system.config")) return ["config"];
    if (eventType.startsWith("system.restart")) return ["all"];
    if (eventType.startsWith("system.agent")) return ["agents"];
    if (eventType.startsWith("system.skill")) return ["skills"];
    if (eventType.startsWith("state.")) return ["sessions", "tasks", "nodes"];
    return [];
  }
  
  /**
   * Dispatch invalidation event for UI components to react to
   */
  private invalidate(target: InvalidationTarget): void {
    window.dispatchEvent(new CustomEvent("federation-invalidate", {
      detail: { target, timestamp: Date.now() }
    }));
  }
  
  /**
   * Show toast notification for important events
   */
  private maybeShowToast(event: FederationEvent): void {
    const toastEvents: Record<string, { icon: string; message: (e: FederationEvent) => string }> = {
      "session.spawned": { 
        icon: "🚀", 
        message: (e) => `Session spawned: ${e.payload.label || "new session"}` 
      },
      "session.completed": { 
        icon: "✅", 
        message: (e) => `Task completed: ${e.payload.label || "session"}` 
      },
      "session.error": { 
        icon: "❌", 
        message: (e) => `Session error: ${e.payload.error || "unknown"}` 
      },
      "node.connected": { 
        icon: "🟢", 
        message: (e) => `Node connected: ${e.payload.name || e.payload.nodeId}` 
      },
      "node.disconnected": { 
        icon: "🔴", 
        message: (e) => `Node disconnected: ${e.payload.name || e.payload.nodeId}` 
      },
      "task.created": { 
        icon: "📋", 
        message: (e) => `Task created: ${e.payload.title || "new task"}` 
      },
      "task.updated": { 
        icon: "📝", 
        message: (e) => `Task updated: ${e.payload.title || e.payload.taskId}` 
      },
      "system.restarting": { 
        icon: "🔄", 
        message: () => "Gateway restarting..." 
      },
      "system.restarted": { 
        icon: "✨", 
        message: () => "Gateway restarted successfully" 
      },
      "system.config.changed": { 
        icon: "⚙️", 
        message: (e) => {
          const changes = e.payload.changes;
          if (Array.isArray(changes) && changes.length > 0) {
            return `Config updated: ${changes.slice(0, 3).join(", ")}${changes.length > 3 ? "..." : ""}`;
          }
          return "Configuration updated";
        }
      },
      "system.code.updated": { 
        icon: "📝", 
        message: (e) => `Code changed: ${e.payload.filename || "file"}` 
      },
      "system.build.completed": { 
        icon: "🔨", 
        message: () => "Build completed" 
      },
      "system.skill.updated": { 
        icon: "🎯", 
        message: (e) => `Skill updated: ${e.payload.skill || "skill"}` 
      },
      "system.error": { 
        icon: "⚠️", 
        message: (e) => `System error: ${e.payload.message || "unknown"}` 
      },
      "mcp.started": { 
        icon: "🔧", 
        message: (e) => `MCP started: ${e.payload.name || "server"}` 
      },
      "mcp.stopped": { 
        icon: "⏹️", 
        message: (e) => `MCP stopped: ${e.payload.name || "server"}` 
      },
    };
    
    const toastConfig = toastEvents[event.type];
    if (toastConfig) {
      const message = `${toastConfig.icon} ${toastConfig.message(event)}`;
      this.showToast(message, this.getToastType(event.type));
    }
  }
  
  /**
   * Determine toast type based on event type
   */
  private getToastType(eventType: string): ToastType {
    if (eventType.includes("error")) return "error";
    if (eventType.includes("completed") || eventType.includes("connected") || eventType.includes("restarted")) return "success";
    if (eventType.includes("restarting") || eventType.includes("disconnected")) return "warning";
    return "info";
  }
  
  /**
   * Show a toast notification
   */
  private showToast(message: string, type: ToastType): void {
    window.dispatchEvent(new CustomEvent("show-toast", {
      detail: { message, type, duration: 4000 }
    }));
  }
  
  // =============================================================================
  // Public API
  // =============================================================================
  
  /**
   * Subscribe to a specific event type
   * @param eventType - Event type to subscribe to, or "*" for all events
   * @param callback - Function to call when event occurs
   * @returns Unsubscribe function
   */
  on(eventType: string, callback: () => void): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);
    return () => this.listeners.get(eventType)?.delete(callback);
  }
  
  /**
   * Subscribe to events matching a prefix (e.g., "session.*")
   */
  onPrefix(prefix: string, callback: () => void): () => void {
    const handler = () => {
      // Check recent events for matching prefix
      const recent = this.lastEvents[0];
      if (recent && recent.type.startsWith(prefix.replace(".*", ""))) {
        callback();
      }
    };
    return this.on("*", handler);
  }
  
  /**
   * Get recent events
   */
  getRecentEvents(): FederationEvent[] {
    return [...this.lastEvents];
  }
  
  /**
   * Get recent events of a specific type
   */
  getRecentEventsByType(type: string): FederationEvent[] {
    return this.lastEvents.filter(e => e.type === type);
  }
  
  /**
   * Get recent events matching a prefix
   */
  getRecentEventsByPrefix(prefix: string): FederationEvent[] {
    const cleanPrefix = prefix.replace(".*", "");
    return this.lastEvents.filter(e => e.type.startsWith(cleanPrefix));
  }
  
  /**
   * Manually trigger an invalidation (for testing or forced refresh)
   */
  forceInvalidate(target: InvalidationTarget): void {
    this.invalidate(target);
  }
  
  /**
   * Manually show a toast (for testing or manual notifications)
   */
  toast(message: string, type: ToastType = "info"): void {
    this.showToast(message, type);
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.unsubscribeGateway) {
      this.unsubscribeGateway();
      this.unsubscribeGateway = null;
    }
    this.listeners.clear();
    this.lastEvents = [];
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let _syncController: FederationSyncController | null = null;

/**
 * Initialize the federation sync controller
 */
export function initFederationSync(client: GatewayBrowserClient): FederationSyncController {
  if (_syncController) {
    _syncController.dispose();
  }
  _syncController = new FederationSyncController(client);
  return _syncController;
}

/**
 * Get the current federation sync controller instance
 */
export function getFederationSync(): FederationSyncController | null {
  return _syncController;
}

/**
 * Dispose of the federation sync controller
 */
export function disposeFederationSync(): void {
  if (_syncController) {
    _syncController.dispose();
    _syncController = null;
  }
}
