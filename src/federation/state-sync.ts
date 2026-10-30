/**
 * State Synchronization Manager for Federation
 *
 * Manages synchronization of state (memory files, kanban, transcripts, config)
 * across federation nodes using CRDTs and vector clocks for conflict-free
 * replication.
 */

import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VectorClock, compareVersionedValues } from "./vector-clock.js";
import { LWWRegister, LWWMap, generateTimestamp } from "./crdt.js";
import type {
  SyncableResource,
  StateSyncMessage,
  SyncConflict,
  StateSyncConfig,
  SyncedResourceState,
  NodeSyncState,
} from "./types.js";
import type { FederationHub } from "./hub.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { getKanbanStore } from "../tasks/store.js";
import type { KanbanTask, KanbanProject } from "../tasks/types.js";

const log = createSubsystemLogger("federation").child("state-sync");

// =============================================================================
// Types
// =============================================================================

/** Events emitted by StateSyncManager */
export interface StateSyncEvents {
  /** A resource was synced */
  "sync:complete": (resource: SyncableResource, path: string) => void;
  /** A conflict was detected and resolved */
  "sync:conflict": (conflict: SyncConflict) => void;
  /** A sync error occurred */
  "sync:error": (resource: SyncableResource, path: string, error: Error) => void;
  /** Full sync completed */
  "sync:full-complete": (stats: { pushed: number; pulled: number; conflicts: number }) => void;
}

/** Options for creating the sync manager */
export interface StateSyncManagerOptions {
  /** This node's ID */
  nodeId: string;
  /** Reference to the federation hub (for sending messages) */
  hub?: FederationHub;
  /** Base workspace path for file operations */
  workspace: string;
  /** Sync configuration */
  config?: Partial<StateSyncConfig>;
}

/** Pending sync request */
interface PendingSync {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

// =============================================================================
// State Sync Manager
// =============================================================================

export class StateSyncManager extends EventEmitter {
  private nodeId: string;
  private hub?: FederationHub;
  private workspace: string;
  private config: StateSyncConfig;

  /** Global vector clock tracking all seen events */
  private vectorClock: VectorClock;

  /** LWW registers for file content */
  private fileRegisters: Map<string, LWWRegister<string>> = new Map();

  /** LWW map for kanban tasks */
  private kanbanTaskMap: LWWMap<string, object> = new LWWMap();

  /** Pending sync requests waiting for response */
  private pending: Map<string, PendingSync> = new Map();

  /** Resource state tracking */
  private resourceStates: Map<string, SyncedResourceState> = new Map();

  /** Sync interval timer */
  private syncTimer?: NodeJS.Timeout;

  /** Is currently performing a full sync */
  private fullSyncInProgress = false;

  private deliveryManager = getDeliveryManager();

  constructor(options: StateSyncManagerOptions) {
    super();
    this.nodeId = options.nodeId;
    this.hub = options.hub;
    this.workspace = options.workspace;
    this.vectorClock = new VectorClock();
    this.vectorClock.increment(this.nodeId);

    this.config = {
      autoSync: true,
      syncIntervalMs: 30000,
      resources: ["memory", "kanban"],
      conflictResolution: "last-write-wins",
      excludePaths: ["node_modules", ".git", "dist"],
      ...options.config,
    };

    log.info(`StateSyncManager initialized for node ${this.nodeId}`);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the sync manager.
   */
  start(): void {
    if (this.config.autoSync && this.config.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        this.periodicSync().catch((err) => {
          log.error("Periodic sync error:", { error: err });
        });
      }, this.config.syncIntervalMs);
      log.info(`Auto-sync enabled, interval: ${this.config.syncIntervalMs}ms`);
    }
  }

  /**
   * Stop the sync manager.
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    // Cancel pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Sync manager stopped"));
    }
    this.pending.clear();

    log.info("StateSyncManager stopped");
  }

  /**
   * Set the federation hub reference.
   */
  setHub(hub: FederationHub): void {
    this.hub = hub;
  }

  // ===========================================================================
  // Push Changes
  // ===========================================================================

  /**
   * Push a local change to the federation.
   * Call this when a file is modified or a kanban task is created/updated.
   */
  async pushChange(resource: SyncableResource, path: string, data: unknown): Promise<void> {
    if (!this.config.resources.includes(resource)) {
      log.debug(`Resource ${resource} not in sync config, skipping`);
      return;
    }

    if (this.isExcludedPath(path)) {
      log.debug(`Path ${path} is excluded, skipping`);
      return;
    }

    // Increment our clock before sending
    this.vectorClock.increment(this.nodeId);
    const timestamp = generateTimestamp();

    // Update local CRDT
    this.updateLocalCRDT(resource, path, data, timestamp);

    // Build sync message
    const message: StateSyncMessage = {
      type: "state.sync.push",
      resource,
      path,
      vectorClock: this.vectorClock.toJSON(),
      data,
      nodeId: this.nodeId,
      timestamp,
    };

    // Send to hub for broadcast
    await this.broadcast(message);

    // Update resource state
    this.updateResourceState(resource, path, data);

    log.debug(`Pushed ${resource}/${path} to federation`);
    this.emit("sync:complete", resource, path);
  }

  /**
   * Update local CRDT with new data.
   */
  private updateLocalCRDT(
    resource: SyncableResource,
    path: string,
    data: unknown,
    timestamp: number,
  ): void {
    const key = `${resource}:${path}`;

    switch (resource) {
      case "memory":
      case "transcript":
      case "config":
        // File-based resources use LWW registers
        let register = this.fileRegisters.get(key);
        if (!register) {
          register = new LWWRegister<string>("", 0, "");
          this.fileRegisters.set(key, register);
        }
        register.set(data as string, timestamp, this.nodeId);
        break;

      case "kanban":
        // Kanban uses LWW map keyed by task/project ID
        const kanbanData = data as { id: string; [key: string]: unknown };
        if (kanbanData.id) {
          this.kanbanTaskMap.set(kanbanData.id, kanbanData, timestamp, this.nodeId);
        }
        break;
    }
  }

  // ===========================================================================
  // Pull Changes
  // ===========================================================================

  /**
   * Pull the latest version of a resource from the federation.
   */
  async pullResource(resource: SyncableResource, path: string): Promise<unknown | null> {
    if (!this.hub) {
      log.warn("No hub available for pull request");
      return null;
    }

    const correlationId = `pull-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const message: StateSyncMessage = {
      type: "state.sync.pull",
      resource,
      path,
      vectorClock: this.vectorClock.toJSON(),
      nodeId: this.nodeId,
      timestamp: Date.now(),
      correlationId,
    };

    return new Promise<unknown | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve(null);
      }, 10000);

      this.pending.set(correlationId, { resolve, reject, timeout });
      this.broadcast(message).catch(reject);
    });
  }

  // ===========================================================================
  // Handle Incoming Sync Messages
  // ===========================================================================

  /**
   * Handle an incoming sync message from another node.
   */
  async handleSyncMessage(message: StateSyncMessage): Promise<void> {
    log.debug(
      `Received ${message.type} from ${message.nodeId}: ${message.resource}/${message.path}`,
    );

    const remoteSeq = message.vectorClock?.[message.nodeId] ?? 0;
    if (
      (message.type === "state.sync.push" || message.type === "state.sync.full") &&
      this.deliveryManager.isStaleSequence(message.nodeId, remoteSeq)
    ) {
      // Reconnect replay can resend old vector-clock frames; watermark drops them.
      log.debug("Dropping stale state sync message", {
        nodeId: message.nodeId,
        type: message.type,
        remoteSeq,
      });
      return;
    }

    // Merge the remote clock into ours
    const remoteClock = VectorClock.fromJSON(message.vectorClock);
    this.vectorClock.merge(remoteClock);
    this.vectorClock.increment(this.nodeId);

    switch (message.type) {
      case "state.sync.push":
        await this.handlePush(message);
        break;

      case "state.sync.pull":
        await this.handlePull(message);
        break;

      case "state.sync.ack":
        this.handleAck(message);
        break;

      case "state.sync.full":
        await this.handleFullSync(message);
        break;
    }
  }

  /**
   * Handle a push message (incoming data from another node).
   */
  private async handlePush(message: StateSyncMessage): Promise<void> {
    const { resource, path, data, timestamp, nodeId } = message;
    const key = `${resource}:${path}`;

    // Check for conflict
    const conflict = this.checkConflict(resource, path, message);
    if (conflict) {
      this.emit("sync:conflict", conflict);
      if (conflict.resolution === "local") {
        log.debug(`Conflict resolved: keeping local version for ${path}`);
        return;
      }
    }

    // Update local CRDT
    this.updateLocalCRDT(resource, path, data, timestamp);

    // Apply to local storage
    await this.applyToLocal(resource, path, data);

    // Update resource state
    this.updateResourceState(resource, path, data);

    log.debug(`Applied remote change from ${nodeId}: ${resource}/${path}`);
    this.emit("sync:complete", resource, path);
  }

  /**
   * Handle a pull request (someone wants our data).
   */
  private async handlePull(message: StateSyncMessage): Promise<void> {
    const { resource, path, correlationId, nodeId } = message;

    // Get local data
    const data = await this.getLocalData(resource, path);

    // Send response
    const response: StateSyncMessage = {
      type: "state.sync.ack",
      resource,
      path,
      vectorClock: this.vectorClock.toJSON(),
      data,
      nodeId: this.nodeId,
      timestamp: Date.now(),
      correlationId,
    };

    // Send directly to the requesting node
    this.sendToNode(nodeId, response);
  }

  /**
   * Handle an ack message (response to our pull request).
   */
  private handleAck(message: StateSyncMessage): void {
    const { correlationId, data } = message;
    if (!correlationId) return;

    const pending = this.pending.get(correlationId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(data);
      this.pending.delete(correlationId);
    }
  }

  /**
   * Handle a full sync message.
   */
  private async handleFullSync(message: StateSyncMessage): Promise<void> {
    const state = message.data as NodeSyncState;
    if (!state?.resources) return;

    log.info(`Processing full sync from ${message.nodeId}`);

    for (const resourceState of state.resources) {
      // For each resource in the remote state, check if we need to pull
      const localState = this.resourceStates.get(`${resourceState.resource}:${resourceState.path}`);
      if (!localState || resourceState.lastSyncTimestamp > localState.lastSyncTimestamp) {
        // Pull this resource
        await this.pullResource(resourceState.resource, resourceState.path);
      }
    }
  }

  // ===========================================================================
  // Conflict Resolution
  // ===========================================================================

  /**
   * Check if there's a conflict with incoming data.
   */
  private checkConflict(
    resource: SyncableResource,
    path: string,
    incoming: StateSyncMessage,
  ): SyncConflict | null {
    const key = `${resource}:${path}`;
    const incomingClock = VectorClock.fromJSON(incoming.vectorClock);

    // Check if we have local data
    let localData: unknown;
    let localClock: VectorClock;

    switch (resource) {
      case "memory":
      case "transcript":
      case "config":
        const register = this.fileRegisters.get(key);
        if (!register) return null; // No local data, no conflict
        localData = register.get();
        localClock = new VectorClock({ [register.nodeId]: register.timestamp });
        break;

      case "kanban":
        const kanbanData = incoming.data as { id: string };
        localData = this.kanbanTaskMap.get(kanbanData.id);
        if (!localData) return null;
        localClock = this.vectorClock.copy();
        break;

      default:
        return null;
    }

    // Compare clocks
    const comparison = localClock.compare(incomingClock);

    if (comparison === "concurrent") {
      // Concurrent updates - need to resolve
      const conflict: SyncConflict = {
        resource,
        path,
        localVersion: localData,
        remoteVersion: incoming.data,
        localClock: localClock.toJSON(),
        remoteClock: incoming.vectorClock,
        resolution: this.resolveConflict(localData, incoming.data, incoming.timestamp),
      };
      return conflict;
    }

    return null;
  }

  /**
   * Resolve a conflict using the configured strategy.
   */
  private resolveConflict(
    localData: unknown,
    remoteData: unknown,
    remoteTimestamp: number,
  ): "local" | "remote" | "merge" {
    switch (this.config.conflictResolution) {
      case "last-write-wins":
        // Remote wins if it has a later timestamp
        const key = Array.from(this.fileRegisters.keys())[0];
        const register = this.fileRegisters.get(key);
        const localTimestamp = register?.timestamp ?? 0;
        return remoteTimestamp > localTimestamp ? "remote" : "local";

      case "merge":
        // For text files, could implement operational transform or diff-merge
        // For now, fall back to LWW
        return remoteTimestamp > Date.now() - 1000 ? "remote" : "local";

      case "manual":
        // Keep local and notify user
        return "local";

      default:
        return "remote";
    }
  }

  // ===========================================================================
  // Local Storage Operations
  // ===========================================================================

  /**
   * Apply synced data to local storage.
   */
  private async applyToLocal(
    resource: SyncableResource,
    path: string,
    data: unknown,
  ): Promise<void> {
    try {
      switch (resource) {
        case "memory":
        case "transcript":
        case "config":
          // Write to file
          const filePath = this.resolvePath(path);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, data as string, "utf-8");
          break;

        case "kanban":
          // Kanban updates are handled by the kanban store directly
          try {
            const kanbanStore = getKanbanStore();
            await kanbanStore.handleFederationSync(path, data as KanbanTask | KanbanProject);
          } catch {
            log.warn("KanbanStore not available, cannot apply kanban sync", { path });
            // Emit event as fallback for any other listeners
            this.emit("kanban:sync", data as Record<string, unknown>);
          }
          break;
      }
    } catch (err) {
      log.error(`Failed to apply sync data for ${resource}/${path}:`, { error: err });
      this.emit("sync:error", resource, path, err as Error);
      throw err;
    }
  }

  /**
   * Get local data for a resource.
   */
  private async getLocalData(resource: SyncableResource, path: string): Promise<unknown | null> {
    try {
      switch (resource) {
        case "memory":
        case "transcript":
        case "config":
          const filePath = this.resolvePath(path);
          return await readFile(filePath, "utf-8");

        case "kanban":
          // Return from KanbanStore directly when available
          try {
            const kanbanStore = getKanbanStore();
            const parts = path.split("/");
            if (parts.length >= 2) {
              const [type, id] = parts;
              if (type === "task") {
                const tasks = await kanbanStore.getTasks();
                return tasks.find((t) => t.id === id) || null;
              } else if (type === "project") {
                const projects = await kanbanStore.getProjects();
                return projects.find((p) => p.id === id) || null;
              }
            }
            // Fallback to CRDT map
            return this.kanbanTaskMap.get(parts[1]);
          } catch {
            log.debug("KanbanStore not available, using CRDT map");
            const parts = path.split("/");
            if (parts.length >= 2) {
              return this.kanbanTaskMap.get(parts[1]);
            }
            return this.kanbanTaskMap.toObject();
          }

        default:
          return null;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Resolve a sync path to an absolute file path.
   */
  private resolvePath(path: string): string {
    // Normalize and join with workspace
    const normalized = normalize(path).replace(/^(\.\.[\\/])+/, "");
    return join(this.workspace, normalized);
  }

  /**
   * Check if a path should be excluded from sync.
   */
  private isExcludedPath(path: string): boolean {
    if (!this.config.excludePaths) return false;
    return this.config.excludePaths.some(
      (exclude) => path.includes(exclude) || path.startsWith(exclude),
    );
  }

  // ===========================================================================
  // Full Sync
  // ===========================================================================

  /**
   * Perform a full sync with all connected nodes.
   * Called when a new node connects or periodically.
   */
  async fullSync(): Promise<{ pushed: number; pulled: number; conflicts: number }> {
    if (this.fullSyncInProgress) {
      log.warn("Full sync already in progress");
      return { pushed: 0, pulled: 0, conflicts: 0 };
    }

    this.fullSyncInProgress = true;
    const stats = { pushed: 0, pulled: 0, conflicts: 0 };

    try {
      log.info("Starting full sync...");

      // Build our current state
      const state: NodeSyncState = {
        nodeId: this.nodeId,
        resources: Array.from(this.resourceStates.values()),
        globalClock: this.vectorClock.toJSON(),
        lastFullSyncTimestamp: Date.now(),
      };

      // Broadcast our state
      const message: StateSyncMessage = {
        type: "state.sync.full",
        resource: "memory", // Dummy, full sync covers all
        path: "",
        vectorClock: this.vectorClock.toJSON(),
        data: state,
        nodeId: this.nodeId,
        timestamp: Date.now(),
      };

      await this.broadcast(message);
      stats.pushed = this.resourceStates.size;

      log.info(`Full sync complete: ${stats.pushed} resources shared`);
      this.emit("sync:full-complete", stats);
    } finally {
      this.fullSyncInProgress = false;
    }

    return stats;
  }

  /**
   * Periodic sync - push any pending changes.
   */
  private async periodicSync(): Promise<void> {
    for (const [key, state] of this.resourceStates) {
      if (state.pendingChanges) {
        const [resource, path] = key.split(":") as [SyncableResource, string];
        const data = await this.getLocalData(resource, path);
        if (data !== null) {
          await this.pushChange(resource, path, data);
        }
      }
    }
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Update resource state tracking.
   */
  private updateResourceState(resource: SyncableResource, path: string, data: unknown): void {
    const key = `${resource}:${path}`;
    const hash = this.hashContent(data);

    this.resourceStates.set(key, {
      resource,
      path,
      vectorClock: this.vectorClock.toJSON(),
      lastSyncTimestamp: Date.now(),
      pendingChanges: false,
      contentHash: hash,
    });
  }

  /**
   * Mark a resource as having pending local changes.
   */
  markPendingChange(resource: SyncableResource, path: string): void {
    const key = `${resource}:${path}`;
    const state = this.resourceStates.get(key);
    if (state) {
      state.pendingChanges = true;
    } else {
      this.resourceStates.set(key, {
        resource,
        path,
        vectorClock: this.vectorClock.toJSON(),
        lastSyncTimestamp: 0,
        pendingChanges: true,
      });
    }
  }

  /**
   * Hash content for change detection.
   */
  private hashContent(data: unknown): string {
    const str = typeof data === "string" ? data : JSON.stringify(data);
    return createHash("sha256").update(str).digest("hex").slice(0, 16);
  }

  /**
   * Broadcast a message to all connected nodes via the hub.
   */
  private async broadcast(message: StateSyncMessage): Promise<void> {
    if (!this.hub) {
      log.debug("No hub available for broadcast");
      return;
    }

    // Use hub's broadcast mechanism
    const nodes = this.hub.getConnectedNodes();
    for (const node of nodes) {
      if (node.id !== this.nodeId) {
        this.sendToNode(node.id, message);
      }
    }
  }

  /**
   * Send a message to a specific node.
   */
  private sendToNode(targetNodeId: string, message: StateSyncMessage): void {
    if (!this.hub) return;

    const node = this.hub.getNode(targetNodeId);
    if (!node || node.state !== "registered") return;

    try {
      node.socket.send(
        JSON.stringify({
          type: message.type,
          payload: message,
          nodeId: this.nodeId,
          timestamp: Date.now(),
        }),
      );
    } catch (err) {
      log.error(`Failed to send to node ${targetNodeId}:`, { error: err });
    }
  }

  /**
   * Get the current vector clock.
   */
  getVectorClock(): VectorClock {
    return this.vectorClock.copy();
  }

  /**
   * Get current sync state for all resources.
   */
  getSyncState(): NodeSyncState {
    return {
      nodeId: this.nodeId,
      resources: Array.from(this.resourceStates.values()),
      globalClock: this.vectorClock.toJSON(),
      lastFullSyncTimestamp: Date.now(),
    };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let defaultSyncManager: StateSyncManager | null = null;

/**
 * Get the default state sync manager instance.
 */
export function getStateSyncManager(): StateSyncManager | null {
  return defaultSyncManager;
}

/**
 * Initialize the state sync manager.
 */
export function initStateSyncManager(options: StateSyncManagerOptions): StateSyncManager {
  if (defaultSyncManager) {
    log.warn("StateSyncManager already initialized, returning existing instance");
    return defaultSyncManager;
  }
  defaultSyncManager = new StateSyncManager(options);
  return defaultSyncManager;
}

/**
 * Start the default state sync manager.
 */
export function startStateSyncManager(options: StateSyncManagerOptions): StateSyncManager {
  const manager = initStateSyncManager(options);
  manager.start();
  return manager;
}

/**
 * Stop the default state sync manager.
 */
export function stopStateSyncManager(): void {
  if (defaultSyncManager) {
    defaultSyncManager.stop();
    defaultSyncManager = null;
  }
}
