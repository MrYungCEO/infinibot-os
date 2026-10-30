/**
 * Federation Event Bus
 *
 * Central event bus for real-time UI sync and system change notifications
 * across the federated InfiniBot network.
 *
 * Events are:
 * 1. Emitted locally for UI subscribers
 * 2. Broadcast to all connected federation nodes
 * 3. Pushed to connected browser clients via WebSocket
 */

import { EventEmitter } from "events";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("federation").child("event-bus");

// =============================================================================
// Event Types
// =============================================================================

/** All event types in the federation */
export type FederationEventType =
  // Session events
  | "session.spawned"
  | "session.completed"
  | "session.message"
  | "session.error"
  | "session.progress"
  // Node events
  | "node.connected"
  | "node.disconnected"
  | "node.status"
  | "node.load"
  // Task events
  | "task.created"
  | "task.updated"
  | "task.deleted"
  // MCP events
  | "mcp.invoked"
  | "mcp.started"
  | "mcp.stopped"
  // State sync events
  | "state.synced"
  | "state.conflict"
  // System events (InfiniBot itself)
  | "system.config.changed"
  | "system.restarting"
  | "system.restarted"
  | "system.code.updated"
  | "system.build.completed"
  | "system.agent.updated"
  | "system.skill.updated"
  | "system.error"
  // infinicode fleet events (published by infinibot-plugin-infinicode so
  // satellites get live fleet updates via the same hub fan-out as everything
  // else here, instead of a second parallel broadcast channel)
  | "infinicode.status"
  | "infinicode.report";

/** A federation event with metadata */
export interface FederationEvent {
  type: FederationEventType;
  timestamp: number;
  sourceNodeId: string;
  payload: Record<string, unknown>;
}

/** Message format for UI broadcast */
export interface UIBroadcastMessage {
  type: "federation.event";
  event: FederationEvent;
}

// Declare the global broadcast function type
declare global {
  // eslint-disable-next-line no-var
  var __infinibotUIBroadcast: ((message: UIBroadcastMessage) => void) | undefined;
}

// =============================================================================
// Federation Event Bus
// =============================================================================

export class FederationEventBus extends EventEmitter {
  private nodeId: string;
  private hub: FederationHubLike | null = null;
  private recentEvents: FederationEvent[] = [];
  private maxRecentEvents = 100;

  constructor(nodeId: string) {
    super();
    this.nodeId = nodeId;
    this.setMaxListeners(100); // Many subscribers expected
    log.info(`event bus initialized for node: ${nodeId}`);
  }

  /**
   * Set the federation hub reference for broadcasting events
   */
  setHub(hub: FederationHubLike) {
    this.hub = hub;
    log.debug("hub connected to event bus");
  }

  /**
   * Get the current node ID
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Update the node ID (e.g., after registration)
   */
  setNodeId(nodeId: string) {
    this.nodeId = nodeId;
    log.debug(`node ID updated to: ${nodeId}`);
  }

  /**
   * Publish an event - emits locally AND broadcasts to federation + UI
   */
  publish(type: FederationEventType, payload: Record<string, unknown> = {}): void {
    const event: FederationEvent = {
      type,
      timestamp: Date.now(),
      sourceNodeId: this.nodeId,
      payload,
    };

    log.debug(`publishing federation event: ${type}`);

    // Store in recent events
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.pop();
    }

    // Local emission
    this.emit("event", event);
    this.emit(type, event);

    // Broadcast to federation (if hub available)
    if (this.hub) {
      this.hub.broadcastEvent(event);
    }

    // Push to UI clients
    this.pushToUI(event);
  }

  /**
   * Receive event from another node
   */
  receive(event: FederationEvent): void {
    if (event.sourceNodeId === this.nodeId) {
      log.trace("skipping own event received back");
      return;
    }

    log.debug(`received federation event: ${event.type} from ${event.sourceNodeId}`);

    // Store in recent events
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.pop();
    }

    // Emit locally
    this.emit("event", event);
    this.emit(event.type, event);

    // Push to UI clients
    this.pushToUI(event);
  }

  /**
   * Push event to connected browser clients via global broadcast function
   */
  private pushToUI(event: FederationEvent): void {
    if (typeof globalThis.__infinibotUIBroadcast === "function") {
      globalThis.__infinibotUIBroadcast({
        type: "federation.event",
        event,
      });
    }
  }

  /**
   * Subscribe to all events
   */
  onAny(callback: (event: FederationEvent) => void): () => void {
    this.on("event", callback);
    return () => this.off("event", callback);
  }

  /**
   * Subscribe to specific event type
   */
  onType(type: FederationEventType, callback: (event: FederationEvent) => void): () => void {
    this.on(type, callback);
    return () => this.off(type, callback);
  }

  /**
   * Subscribe to multiple event types
   */
  onTypes(types: FederationEventType[], callback: (event: FederationEvent) => void): () => void {
    for (const type of types) {
      this.on(type, callback);
    }
    return () => {
      for (const type of types) {
        this.off(type, callback);
      }
    };
  }

  /**
   * Subscribe to events matching a prefix (e.g., "session.*")
   */
  onPrefix(prefix: string, callback: (event: FederationEvent) => void): () => void {
    const handler = (event: FederationEvent) => {
      if (event.type.startsWith(prefix)) {
        callback(event);
      }
    };
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  /**
   * Get recent events (for new UI clients to catch up)
   */
  getRecentEvents(limit = 50): FederationEvent[] {
    return this.recentEvents.slice(0, limit);
  }

  /**
   * Get recent events filtered by type prefix
   */
  getRecentEventsByPrefix(prefix: string, limit = 20): FederationEvent[] {
    return this.recentEvents.filter((e) => e.type.startsWith(prefix)).slice(0, limit);
  }

  /**
   * Clear the event bus state (for testing)
   */
  clear(): void {
    this.recentEvents = [];
    this.removeAllListeners();
  }
}

/** Minimal interface for FederationHub to avoid circular imports */
export interface FederationHubLike {
  broadcastEvent(event: FederationEvent): void;
}

// =============================================================================
// Singleton Instance
// =============================================================================

let _eventBus: FederationEventBus | null = null;

/**
 * Get the singleton event bus instance
 * Creates a default "local" instance if not initialized
 */
export function getEventBus(): FederationEventBus {
  if (!_eventBus) {
    _eventBus = new FederationEventBus("local");
  }
  return _eventBus;
}

/**
 * Initialize the event bus with a specific node ID
 */
export function initEventBus(nodeId: string): FederationEventBus {
  if (_eventBus) {
    log.warn("event bus already initialized, updating node ID");
    _eventBus.setNodeId(nodeId);
    return _eventBus;
  }
  _eventBus = new FederationEventBus(nodeId);
  return _eventBus;
}

/**
 * Reset the event bus (for testing)
 */
export function resetEventBus(): void {
  if (_eventBus) {
    _eventBus.clear();
    _eventBus = null;
  }
}

// =============================================================================
// Convenience Helpers
// =============================================================================

/**
 * Publish a system event (convenience wrapper)
 */
export function publishSystemEvent(
  type: Extract<FederationEventType, `system.${string}`>,
  payload: Record<string, unknown> = {},
): void {
  getEventBus().publish(type, payload);
}

/**
 * Publish a session event (convenience wrapper)
 */
export function publishSessionEvent(
  type: Extract<FederationEventType, `session.${string}`>,
  payload: Record<string, unknown> = {},
): void {
  getEventBus().publish(type, payload);
}

/**
 * Publish a task event (convenience wrapper)
 */
export function publishTaskEvent(
  type: Extract<FederationEventType, `task.${string}`>,
  payload: Record<string, unknown> = {},
): void {
  getEventBus().publish(type, payload);
}

/**
 * Publish a node event (convenience wrapper)
 */
export function publishNodeEvent(
  type: Extract<FederationEventType, `node.${string}`>,
  payload: Record<string, unknown> = {},
): void {
  getEventBus().publish(type, payload);
}
