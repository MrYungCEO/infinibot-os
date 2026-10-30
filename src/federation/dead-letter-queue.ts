/**
 * Dead Letter Queue (DLQ)
 *
 * Captures failed messages for debugging and retry.
 * Messages are moved to DLQ after max retries are exceeded.
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { FederationMessage } from "./types.js";

const log = createSubsystemLogger("federation/dlq");

// =============================================================================
// Types
// =============================================================================

/** DLQ entry containing failed message and failure context */
export interface DeadLetterEntry {
  /** Unique DLQ entry ID */
  id: string;
  /** Original message that failed */
  originalMessage: FederationMessage;
  /** Reason for delivery failure */
  failureReason: string;
  /** Number of retry attempts made before DLQ */
  retryCount: number;
  /** Source node ID that sent the message */
  sourceNodeId: string;
  /** Target node ID that was supposed to receive the message */
  targetNodeId: string;
  /** Timestamp when message first failed */
  firstFailedAt: number;
  /** Timestamp when message was added to DLQ */
  enqueuedAt: number;
  /** Whether this entry can be retried */
  retryable: boolean;
  /** Optional additional context about the failure */
  context?: Record<string, unknown>;
}

/** Options for DLQ configuration */
export interface DeadLetterQueueOptions {
  /** Maximum number of entries to keep in DLQ */
  maxEntries?: number;
  /** Maximum age of entries in milliseconds before cleanup */
  maxAge?: number;
  /** Auto-cleanup interval in milliseconds */
  cleanupInterval?: number;
}

/** DLQ statistics */
export interface DeadLetterStats {
  /** Total entries currently in DLQ */
  totalEntries: number;
  /** Entries by failure reason */
  byFailureReason: Record<string, number>;
  /** Entries by message type */
  byMessageType: Record<string, number>;
  /** Entries by source node */
  bySourceNode: Record<string, number>;
  /** Entries by target node */
  byTargetNode: Record<string, number>;
  /** Oldest entry timestamp */
  oldestEntry?: number;
  /** Newest entry timestamp */
  newestEntry?: number;
}

/** Filter options for DLQ queries */
export interface DeadLetterFilter {
  /** Filter by failure reason (partial match) */
  failureReason?: string;
  /** Filter by message type */
  messageType?: string;
  /** Filter by source node ID */
  sourceNodeId?: string;
  /** Filter by target node ID */
  targetNodeId?: string;
  /** Filter by retryable status */
  retryable?: boolean;
  /** Filter by date range - entries newer than this timestamp */
  newerThan?: number;
  /** Filter by date range - entries older than this timestamp */
  olderThan?: number;
  /** Maximum number of results to return */
  limit?: number;
  /** Number of results to skip (for pagination) */
  offset?: number;
}

// =============================================================================
// Configuration
// =============================================================================

/** Default maximum entries in DLQ */
const DEFAULT_MAX_ENTRIES = 10000;

/** Default maximum age of entries (7 days) */
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** Default cleanup interval (1 hour) */
const DEFAULT_CLEANUP_INTERVAL = 60 * 60 * 1000;

// =============================================================================
// Dead Letter Queue Implementation
// =============================================================================

export class DeadLetterQueue {
  private entries = new Map<string, DeadLetterEntry>();
  private readonly maxEntries: number;
  private readonly maxAge: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: DeadLetterQueueOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxAge = options.maxAge ?? DEFAULT_MAX_AGE;

    // Start auto-cleanup if interval specified
    const cleanupInterval = options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL;
    if (cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, cleanupInterval);
    }

    log.debug("DeadLetterQueue initialized", {
      maxEntries: this.maxEntries,
      maxAge: this.maxAge,
      cleanupInterval,
    });
  }

  /**
   * Add a failed message to the dead letter queue
   */
  public enqueue(
    originalMessage: FederationMessage,
    targetNodeId: string,
    failureReason: string,
    retryCount: number,
    firstFailedAt?: number,
    context?: Record<string, unknown>,
  ): string {
    const id = randomUUID();
    const now = Date.now();

    const entry: DeadLetterEntry = {
      id,
      originalMessage,
      failureReason,
      retryCount,
      sourceNodeId: originalMessage.nodeId,
      targetNodeId,
      firstFailedAt: firstFailedAt ?? now,
      enqueuedAt: now,
      retryable: this.isRetryable(failureReason),
      context,
    };

    // Add to queue
    this.entries.set(id, entry);

    // Cleanup if we exceed max entries
    if (this.entries.size > this.maxEntries) {
      this.trimEntries();
    }

    log.warn("Message added to Dead Letter Queue", {
      dlqId: id,
      messageId: originalMessage.messageId,
      messageType: originalMessage.type,
      sourceNodeId: originalMessage.nodeId,
      targetNodeId,
      failureReason,
      retryCount,
      retryable: entry.retryable,
    });

    return id;
  }

  /**
   * Get a specific DLQ entry by ID
   */
  public getEntry(id: string): DeadLetterEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * List DLQ entries with optional filtering
   */
  public listEntries(filter: DeadLetterFilter = {}): DeadLetterEntry[] {
    let entries = Array.from(this.entries.values());

    // Apply filters
    if (filter.failureReason) {
      entries = entries.filter((entry) =>
        entry.failureReason.toLowerCase().includes(filter.failureReason!.toLowerCase()),
      );
    }

    if (filter.messageType) {
      entries = entries.filter((entry) => entry.originalMessage.type === filter.messageType);
    }

    if (filter.sourceNodeId) {
      entries = entries.filter((entry) => entry.sourceNodeId === filter.sourceNodeId);
    }

    if (filter.targetNodeId) {
      entries = entries.filter((entry) => entry.targetNodeId === filter.targetNodeId);
    }

    if (filter.retryable !== undefined) {
      entries = entries.filter((entry) => entry.retryable === filter.retryable);
    }

    if (filter.newerThan) {
      entries = entries.filter((entry) => entry.enqueuedAt > filter.newerThan!);
    }

    if (filter.olderThan) {
      entries = entries.filter((entry) => entry.enqueuedAt < filter.olderThan!);
    }

    // Sort by enqueue time (newest first)
    entries.sort((a, b) => b.enqueuedAt - a.enqueuedAt);

    // Apply pagination
    if (filter.offset) {
      entries = entries.slice(filter.offset);
    }

    if (filter.limit) {
      entries = entries.slice(0, filter.limit);
    }

    return entries;
  }

  /**
   * Remove a specific DLQ entry
   */
  public remove(id: string): boolean {
    const removed = this.entries.delete(id);
    if (removed) {
      log.debug("Removed entry from Dead Letter Queue", { dlqId: id });
    }
    return removed;
  }

  /**
   * Clear all DLQ entries
   */
  public clear(): void {
    const count = this.entries.size;
    this.entries.clear();
    log.info("Cleared Dead Letter Queue", { entriesRemoved: count });
  }

  /**
   * Retry a failed message from DLQ
   */
  public async retryEntry(
    id: string,
    sendFn: (message: FederationMessage, targetNodeId: string) => Promise<void>,
  ): Promise<{ success: boolean; error?: string }> {
    const entry = this.entries.get(id);
    if (!entry) {
      return { success: false, error: "DLQ entry not found" };
    }

    if (!entry.retryable) {
      return { success: false, error: "Entry is not retryable" };
    }

    try {
      log.info("Retrying message from Dead Letter Queue", {
        dlqId: id,
        messageId: entry.originalMessage.messageId,
        messageType: entry.originalMessage.type,
        targetNodeId: entry.targetNodeId,
      });

      await sendFn(entry.originalMessage, entry.targetNodeId);

      // Remove from DLQ on successful retry
      this.entries.delete(id);

      log.info("Successfully retried message from Dead Letter Queue", {
        dlqId: id,
        messageId: entry.originalMessage.messageId,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      log.warn("Failed to retry message from Dead Letter Queue", {
        dlqId: id,
        messageId: entry.originalMessage.messageId,
        error: errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get DLQ statistics
   */
  public getStats(): DeadLetterStats {
    const entries = Array.from(this.entries.values());
    const stats: DeadLetterStats = {
      totalEntries: entries.length,
      byFailureReason: {},
      byMessageType: {},
      bySourceNode: {},
      byTargetNode: {},
    };

    for (const entry of entries) {
      // Count by failure reason
      const reason = entry.failureReason;
      stats.byFailureReason[reason] = (stats.byFailureReason[reason] || 0) + 1;

      // Count by message type
      const type = entry.originalMessage.type;
      stats.byMessageType[type] = (stats.byMessageType[type] || 0) + 1;

      // Count by source node
      const source = entry.sourceNodeId;
      stats.bySourceNode[source] = (stats.bySourceNode[source] || 0) + 1;

      // Count by target node
      const target = entry.targetNodeId;
      stats.byTargetNode[target] = (stats.byTargetNode[target] || 0) + 1;

      // Track oldest/newest
      if (!stats.oldestEntry || entry.enqueuedAt < stats.oldestEntry) {
        stats.oldestEntry = entry.enqueuedAt;
      }
      if (!stats.newestEntry || entry.enqueuedAt > stats.newestEntry) {
        stats.newestEntry = entry.enqueuedAt;
      }
    }

    return stats;
  }

  /**
   * Clean up old DLQ entries
   */
  public cleanup(maxAge?: number): number {
    const cutoff = Date.now() - (maxAge ?? this.maxAge);
    let removed = 0;

    for (const [id, entry] of this.entries) {
      if (entry.enqueuedAt < cutoff) {
        this.entries.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      log.info("Cleaned up old Dead Letter Queue entries", {
        entriesRemoved: removed,
        cutoffAge: maxAge ?? this.maxAge,
      });
    }

    return removed;
  }

  /**
   * Shutdown DLQ and cleanup resources
   */
  public shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    log.info("Dead Letter Queue shutdown", {
      entriesLost: this.entries.size,
    });
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  /**
   * Determine if a failure is retryable based on the reason
   */
  private isRetryable(failureReason: string): boolean {
    const reason = failureReason.toLowerCase();

    // Non-retryable errors
    const nonRetryablePatterns = [
      "invalid message format",
      "malformed",
      "unauthorized",
      "forbidden",
      "bad request",
      "not found",
      "method not allowed",
      "conflict",
      "gone",
      "payload too large",
      "unsupported media type",
    ];

    for (const pattern of nonRetryablePatterns) {
      if (reason.includes(pattern)) {
        return false;
      }
    }

    // Retryable errors (network issues, temporary failures, timeouts)
    return true;
  }

  /**
   * Remove oldest entries to maintain size limit
   */
  private trimEntries(): void {
    const entries = Array.from(this.entries.entries());
    entries.sort(([, a], [, b]) => a.enqueuedAt - b.enqueuedAt); // Sort by oldest first

    const toRemove = entries.length - this.maxEntries;
    for (let i = 0; i < toRemove; i++) {
      const [id] = entries[i]!;
      this.entries.delete(id);
    }

    log.debug("Trimmed Dead Letter Queue to size limit", {
      entriesRemoved: toRemove,
      currentSize: this.entries.size,
      maxEntries: this.maxEntries,
    });
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let deadLetterQueue: DeadLetterQueue | null = null;

/**
 * Get or create the global dead letter queue instance
 */
export function getDeadLetterQueue(): DeadLetterQueue {
  if (!deadLetterQueue) {
    deadLetterQueue = new DeadLetterQueue();
  }
  return deadLetterQueue;
}

/**
 * Shutdown the dead letter queue
 */
export function shutdownDeadLetterQueue(): void {
  if (deadLetterQueue) {
    deadLetterQueue.shutdown();
    deadLetterQueue = null;
  }
}
