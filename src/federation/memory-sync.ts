/**
 * Bidirectional Memory Sync for Federation
 *
 * Handles bidirectional synchronization of memory files between master and satellites.
 * Implements CRDT-style conflict resolution with last-write-wins semantics and
 * operational transform for append-only sections.
 *
 * Architecture:
 * 1. Satellite detects local file change via FileWatcher
 * 2. Satellite sends update to master with timestamp and content
 * 3. Master merges changes using conflict resolution strategy
 * 4. Master broadcasts merged version to all satellites
 *
 * Conflict Resolution:
 * - Last-write-wins with vector clocks for concurrent updates
 * - Operational transform for append-only sections (daily notes)
 * - Conflict markers for manual resolution when needed
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { FederationHub } from "./hub.js";
import type { MemoryFileWatcher, FileChangeEvent } from "./file-watcher.js";
import type { WebSocket } from "ws";

const log = createSubsystemLogger("federation").child("memory-sync");

// =============================================================================
// Types
// =============================================================================

/** Memory sync message types */
export type MemorySyncMessageType =
  | "memory.update"
  | "memory.update.ack"
  | "memory.broadcast"
  | "memory.conflict"
  | "memory.request";

/** Memory file update from satellite */
export interface MemoryUpdateMessage {
  type: "memory.update";
  /** Source node ID */
  nodeId: string;
  /** File path relative to workspace */
  filePath: string;
  /** New file content */
  content: string;
  /** Timestamp when change occurred */
  timestamp: number;
  /** File size in bytes */
  size: number;
  /** Vector clock for conflict resolution */
  vectorClock: Record<string, number>;
  /** Message ID for tracking */
  messageId: string;
}

/** Acknowledgment of memory update */
export interface MemoryUpdateAck {
  type: "memory.update.ack";
  /** Original message ID */
  messageId: string;
  /** Whether update was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Conflict detected (manual resolution needed) */
  conflict?: boolean;
  /** Merged content if conflict was auto-resolved */
  mergedContent?: string;
}

/** Memory broadcast to all satellites */
export interface MemoryBroadcastMessage {
  type: "memory.broadcast";
  /** File path relative to workspace */
  filePath: string;
  /** Merged file content */
  content: string;
  /** Master's vector clock */
  vectorClock: Record<string, number>;
  /** Source node that triggered the update */
  sourceNodeId: string;
  /** Timestamp of merge */
  timestamp: number;
}

/** Memory conflict notification */
export interface MemoryConflictMessage {
  type: "memory.conflict";
  /** File path with conflict */
  filePath: string;
  /** Local content */
  localContent: string;
  /** Incoming content */
  incomingContent: string;
  /** Merged content with conflict markers */
  conflictContent: string;
  /** Source node ID */
  sourceNodeId: string;
  /** Vector clocks for both versions */
  vectorClocks: {
    local: Record<string, number>;
    incoming: Record<string, number>;
  };
}

/** Request for latest version of a file */
export interface MemoryRequestMessage {
  type: "memory.request";
  /** File path to request */
  filePath: string;
  /** Requesting node ID */
  nodeId: string;
}

/** Vector clock for conflict resolution */
export interface VectorClock {
  [nodeId: string]: number;
}

/** Merged file state */
export interface MergedFileState {
  content: string;
  vectorClock: VectorClock;
  timestamp: number;
  hasConflict: boolean;
  conflictMarkers?: string[];
}

/** Memory sync configuration */
export interface MemorySyncConfig {
  /** Workspace path containing memory files */
  workspace: string;
  /** Current node ID */
  nodeId: string;
  /** Conflict resolution strategy */
  conflictResolution?: "last-write-wins" | "manual" | "operational-transform";
  /** Maximum file size for sync (bytes, default: 10MB) */
  maxFileSize?: number;
  /** Files to sync (defaults to watchable files) */
  syncFiles?: string[];
}

// =============================================================================
// Memory Sync Manager
// =============================================================================

export class MemorySyncManager {
  private workspace: string;
  private nodeId: string;
  private conflictResolution: string;
  private maxFileSize: number;
  private syncFiles: string[];
  private hub?: FederationHub;
  private fileWatcher?: MemoryFileWatcher;
  private vectorClock: VectorClock = {};

  constructor(config: MemorySyncConfig) {
    this.workspace = config.workspace;
    this.nodeId = config.nodeId;
    this.conflictResolution = config.conflictResolution ?? "last-write-wins";
    this.maxFileSize = config.maxFileSize ?? 10 * 1024 * 1024; // 10MB
    this.syncFiles = config.syncFiles ?? ["MEMORY.md", "TOOLS.md", "HEARTBEAT.md"];

    // Initialize vector clock for this node
    this.vectorClock[this.nodeId] = 0;

    log.info(
      `MemorySyncManager initialized for ${this.nodeId}, strategy: ${this.conflictResolution}`,
    );
  }

  /**
   * Set the federation hub reference (master side).
   */
  setHub(hub: FederationHub): void {
    this.hub = hub;
    log.info("MemorySyncManager attached to hub");
  }

  /**
   * Set the file watcher reference (both master and satellite).
   */
  setFileWatcher(watcher: MemoryFileWatcher): void {
    this.fileWatcher = watcher;

    // Listen for file changes
    watcher.on("file:changed", (event: FileChangeEvent) => this.handleFileChange(event));

    log.info("MemorySyncManager attached to file watcher");
  }

  /**
   * Handle local file changes from the file watcher.
   */
  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    // Only sync configured files
    if (!this.shouldSyncFile(event.filePath)) {
      log.debug(`Skipping non-sync file: ${event.filePath}`);
      return;
    }

    // Only handle modified/created files with content
    if (event.changeType === "deleted" || !event.content) {
      log.debug(`Skipping deleted/empty file: ${event.filePath}`);
      return;
    }

    // Check file size limit
    if (event.size && event.size > this.maxFileSize) {
      log.warn(`File too large for sync: ${event.filePath} (${event.size} bytes)`);
      return;
    }

    log.info(`Processing memory sync for: ${event.filePath}`);

    try {
      if (this.hub) {
        // Master node: broadcast change to all satellites
        await this.broadcastFileChange(event);
      } else {
        // Satellite node: send update to master
        await this.sendUpdateToMaster(event);
      }
    } catch (err) {
      log.error(
        `Failed to sync file change for ${event.filePath}:`,
        err as Record<string, unknown>,
      );
    }
  }

  /**
   * Check if a file should be synced.
   */
  private shouldSyncFile(filePath: string): boolean {
    // Check exact matches
    if (this.syncFiles.includes(filePath)) {
      return true;
    }

    // Check daily notes pattern
    if (filePath.match(/^memory\/\d{4}-\d{2}-\d{2}\.md$/)) {
      return true;
    }

    return false;
  }

  /**
   * Send file update to master (satellite side).
   */
  private async sendUpdateToMaster(event: FileChangeEvent): Promise<void> {
    // Increment local vector clock
    this.vectorClock[this.nodeId] = (this.vectorClock[this.nodeId] ?? 0) + 1;

    const updateMessage: MemoryUpdateMessage = {
      type: "memory.update",
      nodeId: this.nodeId,
      filePath: event.filePath,
      content: event.content!,
      timestamp: event.timestamp,
      size: event.size ?? 0,
      vectorClock: { ...this.vectorClock },
      messageId: this.generateMessageId(),
    };

    // Send via WebSocket to master (implementation depends on satellite connection)
    this.emitToMaster?.("memory.update", updateMessage);

    log.info(`Sent memory update to master: ${event.filePath}`);
  }

  /**
   * Broadcast file change to all satellites (master side).
   */
  private async broadcastFileChange(event: FileChangeEvent): Promise<void> {
    if (!this.hub) {
      log.warn("No hub available for broadcasting");
      return;
    }

    // Increment master vector clock
    this.vectorClock[this.nodeId] = (this.vectorClock[this.nodeId] ?? 0) + 1;

    const broadcastMessage: MemoryBroadcastMessage = {
      type: "memory.broadcast",
      filePath: event.filePath,
      content: event.content!,
      vectorClock: { ...this.vectorClock },
      sourceNodeId: this.nodeId,
      timestamp: event.timestamp,
    };

    // Send to all connected satellites
    const nodes = this.hub.getConnectedNodes();
    for (const node of nodes) {
      try {
        node.socket.send(
          JSON.stringify({
            type: "memory.broadcast",
            payload: broadcastMessage,
            nodeId: this.nodeId,
            timestamp: Date.now(),
          }),
        );
      } catch (err) {
        log.warn(`Failed to broadcast to ${node.id}:`, err as Record<string, unknown>);
      }
    }

    log.info(`Broadcasted memory update: ${event.filePath} to ${nodes.length} satellites`);
  }

  /**
   * Handle incoming memory update from satellite (master side).
   */
  async handleMemoryUpdate(message: MemoryUpdateMessage, sourceSocket: WebSocket): Promise<void> {
    log.info(`Received memory update from ${message.nodeId}: ${message.filePath}`);

    try {
      // Merge the incoming change with local state
      const mergeResult = await this.mergeFileContent(
        message.filePath,
        message.content,
        message.vectorClock,
        message.timestamp,
      );

      // Send acknowledgment
      const ack: MemoryUpdateAck = {
        type: "memory.update.ack",
        messageId: message.messageId,
        success: true,
        conflict: mergeResult.hasConflict,
        mergedContent: mergeResult.hasConflict ? mergeResult.content : undefined,
      };

      sourceSocket.send(
        JSON.stringify({
          type: "memory.update.ack",
          payload: ack,
          nodeId: this.nodeId,
          timestamp: Date.now(),
        }),
      );

      // Broadcast merged result to all other satellites
      if (!mergeResult.hasConflict) {
        await this.broadcastMergedContent(message.filePath, mergeResult, message.nodeId);
      } else {
        // Handle conflict
        await this.handleFileConflict(
          message.filePath,
          message.content,
          mergeResult,
          message.nodeId,
        );
      }
    } catch (err) {
      log.error(
        `Failed to handle memory update from ${message.nodeId}:`,
        err as Record<string, unknown>,
      );

      // Send error acknowledgment
      const errorAck: MemoryUpdateAck = {
        type: "memory.update.ack",
        messageId: message.messageId,
        success: false,
        error: (err as Error).message,
      };

      sourceSocket.send(
        JSON.stringify({
          type: "memory.update.ack",
          payload: errorAck,
          nodeId: this.nodeId,
          timestamp: Date.now(),
        }),
      );
    }
  }

  /**
   * Merge incoming file content with local state.
   */
  private async mergeFileContent(
    filePath: string,
    incomingContent: string,
    incomingVectorClock: VectorClock,
    incomingTimestamp: number,
  ): Promise<MergedFileState> {
    const fullPath = join(this.workspace, filePath);

    try {
      // Read current local content
      const localContent = await readFile(fullPath, "utf-8");

      // Compare vector clocks to determine conflict resolution
      const clockComparison = this.compareVectorClocks(this.vectorClock, incomingVectorClock);

      if (clockComparison === "before") {
        // Local is behind, accept incoming change
        await this.writeFile(fullPath, incomingContent);
        this.updateVectorClock(incomingVectorClock);

        return {
          content: incomingContent,
          vectorClock: { ...this.vectorClock },
          timestamp: incomingTimestamp,
          hasConflict: false,
        };
      } else if (clockComparison === "after") {
        // Local is ahead, keep local
        return {
          content: localContent,
          vectorClock: { ...this.vectorClock },
          timestamp: Date.now(),
          hasConflict: false,
        };
      } else {
        // Concurrent update - resolve conflict
        return await this.resolveConflict(
          filePath,
          localContent,
          incomingContent,
          this.vectorClock,
          incomingVectorClock,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist locally, create it
        await this.writeFile(fullPath, incomingContent);
        this.updateVectorClock(incomingVectorClock);

        return {
          content: incomingContent,
          vectorClock: { ...this.vectorClock },
          timestamp: incomingTimestamp,
          hasConflict: false,
        };
      }
      throw err;
    }
  }

  /**
   * Resolve content conflict between local and incoming versions.
   */
  private async resolveConflict(
    filePath: string,
    localContent: string,
    incomingContent: string,
    localVC: VectorClock,
    incomingVC: VectorClock,
  ): Promise<MergedFileState> {
    log.warn(`Conflict detected for ${filePath}`);

    switch (this.conflictResolution) {
      case "last-write-wins":
        // Use vector clock majority or fall back to timestamp
        const localSum = Object.values(localVC).reduce((a, b) => a + b, 0);
        const incomingSum = Object.values(incomingVC).reduce((a, b) => a + b, 0);

        const winner = incomingSum > localSum ? incomingContent : localContent;
        const winnerVC = incomingSum > localSum ? incomingVC : localVC;

        await this.writeFile(join(this.workspace, filePath), winner);
        this.updateVectorClock(winnerVC);

        return {
          content: winner,
          vectorClock: { ...this.vectorClock },
          timestamp: Date.now(),
          hasConflict: false,
        };

      case "operational-transform":
        // For append-only files like daily notes, try to merge both changes
        if (filePath.includes("memory/") && filePath.endsWith(".md")) {
          const merged = this.operationalTransform(localContent, incomingContent);
          await this.writeFile(join(this.workspace, filePath), merged);

          // Merge vector clocks
          const mergedVC = this.mergeVectorClocks(localVC, incomingVC);
          this.updateVectorClock(mergedVC);

          return {
            content: merged,
            vectorClock: { ...this.vectorClock },
            timestamp: Date.now(),
            hasConflict: false,
          };
        }
      // Fall through to manual for non-appendable files

      case "manual":
      default:
        // Create conflict markers for manual resolution
        const conflictContent = this.createConflictMarkers(
          localContent,
          incomingContent,
          this.nodeId,
          "incoming",
        );

        await this.writeFile(join(this.workspace, filePath), conflictContent);

        return {
          content: conflictContent,
          vectorClock: { ...this.vectorClock },
          timestamp: Date.now(),
          hasConflict: true,
          conflictMarkers: ["<<<<<<< LOCAL", ">>>>>>> INCOMING"],
        };
    }
  }

  /**
   * Operational transform for append-only content (daily notes).
   */
  private operationalTransform(local: string, incoming: string): string {
    // Simple implementation: if incoming has more lines, assume it's an append
    const localLines = local.split("\n");
    const incomingLines = incoming.split("\n");

    // Find common prefix
    let commonLength = 0;
    while (
      commonLength < localLines.length &&
      commonLength < incomingLines.length &&
      localLines[commonLength] === incomingLines[commonLength]
    ) {
      commonLength++;
    }

    // If incoming has same prefix but more content, append the difference
    if (commonLength === localLines.length && incomingLines.length > localLines.length) {
      return incoming;
    }

    // If both have additions after the common prefix, merge them
    const common = localLines.slice(0, commonLength);
    const localNew = localLines.slice(commonLength);
    const incomingNew = incomingLines.slice(commonLength);

    return [...common, ...localNew, "", "---", "", ...incomingNew].join("\n");
  }

  /**
   * Create conflict markers for manual resolution.
   */
  private createConflictMarkers(
    localContent: string,
    incomingContent: string,
    localLabel: string,
    incomingLabel: string,
  ): string {
    return [
      `<<<<<<< ${localLabel}`,
      localContent,
      "=======",
      incomingContent,
      `>>>>>>> ${incomingLabel}`,
    ].join("\n");
  }

  /**
   * Compare vector clocks to determine ordering.
   */
  private compareVectorClocks(
    vc1: VectorClock,
    vc2: VectorClock,
  ): "before" | "after" | "concurrent" {
    let vc1Greater = false;
    let vc2Greater = false;

    const allNodes = new Set([...Object.keys(vc1), ...Object.keys(vc2)]);

    for (const node of allNodes) {
      const v1 = vc1[node] ?? 0;
      const v2 = vc2[node] ?? 0;

      if (v1 > v2) vc1Greater = true;
      if (v2 > v1) vc2Greater = true;
    }

    if (vc1Greater && !vc2Greater) return "after";
    if (vc2Greater && !vc1Greater) return "before";
    return "concurrent";
  }

  /**
   * Update local vector clock with incoming clock.
   */
  private updateVectorClock(incomingVC: VectorClock): void {
    for (const [node, value] of Object.entries(incomingVC)) {
      this.vectorClock[node] = Math.max(this.vectorClock[node] ?? 0, value);
    }
    // Increment own clock
    this.vectorClock[this.nodeId] = (this.vectorClock[this.nodeId] ?? 0) + 1;
  }

  /**
   * Merge two vector clocks.
   */
  private mergeVectorClocks(vc1: VectorClock, vc2: VectorClock): VectorClock {
    const merged: VectorClock = {};
    const allNodes = new Set([...Object.keys(vc1), ...Object.keys(vc2)]);

    for (const node of allNodes) {
      merged[node] = Math.max(vc1[node] ?? 0, vc2[node] ?? 0);
    }

    return merged;
  }

  /**
   * Write file with error handling and directory creation.
   */
  private async writeFile(filePath: string, content: string): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  /**
   * Generate unique message ID.
   */
  private generateMessageId(): string {
    return `${this.nodeId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Broadcast merged content to other satellites.
   */
  private async broadcastMergedContent(
    filePath: string,
    mergeResult: MergedFileState,
    excludeNodeId: string,
  ): Promise<void> {
    if (!this.hub) return;

    const broadcastMessage: MemoryBroadcastMessage = {
      type: "memory.broadcast",
      filePath,
      content: mergeResult.content,
      vectorClock: mergeResult.vectorClock,
      sourceNodeId: excludeNodeId,
      timestamp: mergeResult.timestamp,
    };

    const nodes = this.hub.getConnectedNodes().filter((n) => n.id !== excludeNodeId);
    for (const node of nodes) {
      try {
        node.socket.send(
          JSON.stringify({
            type: "memory.broadcast",
            payload: broadcastMessage,
            nodeId: this.nodeId,
            timestamp: Date.now(),
          }),
        );
      } catch (err) {
        log.warn(
          `Failed to broadcast merged content to ${node.id}:`,
          err as Record<string, unknown>,
        );
      }
    }

    log.info(`Broadcasted merged content: ${filePath} to ${nodes.length} satellites`);
  }

  /**
   * Handle file conflict notifications.
   */
  private async handleFileConflict(
    filePath: string,
    incomingContent: string,
    mergeResult: MergedFileState,
    sourceNodeId: string,
  ): Promise<void> {
    log.error(`Unresolved conflict in ${filePath} from ${sourceNodeId}`);

    // Could emit events for UI notifications or logging
    // For now, just log the conflict

    const conflictMessage: MemoryConflictMessage = {
      type: "memory.conflict",
      filePath,
      localContent: "", // Would need to read local content
      incomingContent,
      conflictContent: mergeResult.content,
      sourceNodeId,
      vectorClocks: {
        local: this.vectorClock,
        incoming: {}, // Would need incoming vector clock
      },
    };

    // Emit conflict event for handling by UI or external systems
    this.emitConflict?.(conflictMessage);
  }

  // Placeholder for master-satellite communication
  private emitToMaster?: (type: string, data: unknown) => void;
  private emitConflict?: (conflict: MemoryConflictMessage) => void;

  /**
   * Set communication handlers.
   */
  setHandlers(handlers: {
    emitToMaster?: (type: string, data: unknown) => void;
    emitConflict?: (conflict: MemoryConflictMessage) => void;
  }): void {
    this.emitToMaster = handlers.emitToMaster;
    this.emitConflict = handlers.emitConflict;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let defaultMemorySyncManager: MemorySyncManager | null = null;

/**
 * Get the memory sync manager.
 */
export function getMemorySyncManager(): MemorySyncManager | null {
  return defaultMemorySyncManager;
}

/**
 * Initialize the memory sync manager.
 */
export function initMemorySyncManager(config: MemorySyncConfig): MemorySyncManager {
  if (defaultMemorySyncManager) {
    log.warn("MemorySyncManager already initialized");
    return defaultMemorySyncManager;
  }

  defaultMemorySyncManager = new MemorySyncManager(config);
  return defaultMemorySyncManager;
}

/**
 * Stop the memory sync manager.
 */
export function stopMemorySyncManager(): void {
  defaultMemorySyncManager = null;
}
