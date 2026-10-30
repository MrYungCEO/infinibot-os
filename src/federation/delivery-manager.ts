/**
 * Message Delivery Manager
 *
 * Ensures federation messages are delivered reliably with acknowledgments.
 * Handles message tracking, retries, deduplication, and timeouts.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { FederationMessage, FederationMessageType } from "./types.js";
import { getDeadLetterQueue } from "./dead-letter-queue.js";
import { broadcastFederationEvent } from "./events.js";

const log = createSubsystemLogger("federation/delivery");

// =============================================================================
// Configuration
// =============================================================================

/** Default timeout for waiting for ACKs (5 seconds) */
const DEFAULT_ACK_TIMEOUT = 5_000;

/** Default retry attempts for failed deliveries */
const DEFAULT_MAX_RETRIES = 5;

/** Default retry delay (exponential backoff starting at 1 second) */
const DEFAULT_RETRY_DELAY = 1_000;

/** Maximum number of messageIds to track per sender for deduplication */
const MAX_DEDUPLICATION_CACHE = 1000;

// =============================================================================
// Types
// =============================================================================

/** Message types that require delivery guarantees */
export const GUARANTEED_MESSAGE_TYPES: Set<FederationMessageType> = new Set([
  "session.spawn",
  "session.spawn.result",
  "session.send",
  "session.send.result",
  "session.complete",
  "identity.sync",
  "mcp.invoke",
]);

/** Pending message tracking info */
interface PendingMessage {
  /** The original message */
  message: FederationMessage;
  /** Target node ID */
  targetNodeId: string;
  /** Number of retry attempts made */
  retryCount: number;
  /** Timeout handle for this message */
  timeoutHandle?: NodeJS.Timeout;
  /** Callback for successful delivery */
  onSuccess?: (messageId: string) => void;
  /** Callback for failed delivery */
  onFailure?: (messageId: string, error: string) => void;
  /** Timestamp when message first failed (for DLQ) */
  firstFailedAt?: number;
  /** Timestamp when this message entered the delivery manager */
  createdAt: number;
  /** Timestamp of the most recent successful socket write */
  lastSentAt?: number;
  /** Send function for retries */
  sendFn?: (message: FederationMessage) => Promise<void>;
}

/** Deduplication cache entry */
interface DeduplicationEntry {
  messageId: string;
  timestamp: number;
  senderId: string;
}

interface PersistedDeliveryState {
  version: 1;
  pendingMessages: Array<{
    message: FederationMessage;
    targetNodeId: string;
    retryCount: number;
    firstFailedAt?: number;
    createdAt: number;
    lastSentAt?: number;
  }>;
  deduplicationCache: Record<string, DeduplicationEntry[]>;
  lastSeenSeqBySender: Record<string, number>;
}

// =============================================================================
// Delivery Manager
// =============================================================================

export class MessageDeliveryManager {
  private pendingMessages = new Map<string, PendingMessage>();
  private deduplicationCache = new Map<string, DeduplicationEntry[]>();
  private ackTimeout: number;
  private maxRetries: number;
  private retryDelay: number;
  private persistPath: string | null;
  private lastSeenSeqBySender = new Map<string, number>();

  constructor(
    options: {
      ackTimeout?: number;
      maxRetries?: number;
      retryDelay?: number;
      persistPath?: string | null;
    } = {},
  ) {
    this.ackTimeout = options.ackTimeout ?? DEFAULT_ACK_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY;
    this.persistPath =
      options.persistPath === undefined ? defaultPersistPath() : options.persistPath;
    this.loadPersistedState();

    log.debug("DeliveryManager initialized", {
      ackTimeout: this.ackTimeout,
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelay,
      persistPath: this.persistPath,
    });
  }

  /**
   * Send a message with delivery guarantee
   */
  public sendMessage(
    message: FederationMessage,
    targetNodeId: string,
    sendFn: (message: FederationMessage) => Promise<void>,
    options: {
      onSuccess?: (messageId: string) => void;
      onFailure?: (messageId: string, error: string) => void;
    } = {},
  ): string {
    // Assign messageId if not present
    const messageId = message.messageId || randomUUID();
    message.messageId = messageId;

    // Check if this message type needs guarantees
    if (!GUARANTEED_MESSAGE_TYPES.has(message.type as FederationMessageType)) {
      // Send without tracking
      sendFn(message)
        .then(() => {
          broadcastFederationEvent("federation.message.sent", {
            fromNodeId: message.nodeId,
            toNodeId: targetNodeId,
            messageType: message.type,
            msgId: messageId,
            ts: Date.now(),
          });
        })
        .catch((error) => {
          log.warn("Failed to send non-guaranteed message", {
            messageId,
            type: message.type,
            error: error.message,
          });
          broadcastFederationEvent("federation.message.failed", {
            fromNodeId: message.nodeId,
            toNodeId: targetNodeId,
            msgId: messageId,
            reason: error.message,
            ts: Date.now(),
          });
          options.onFailure?.(messageId, error.message);
        });
      return messageId;
    }

    log.debug("Sending guaranteed message", {
      messageId,
      type: message.type,
      targetNodeId,
    });

    // Store pending message
    const pending: PendingMessage = {
      message,
      targetNodeId,
      retryCount: 0,
      onSuccess: options.onSuccess,
      onFailure: options.onFailure,
      createdAt: Date.now(),
      sendFn,
    };
    this.pendingMessages.set(messageId, pending);
    this.persistState();

    // Send the message
    void this.attemptSend(messageId, sendFn);

    return messageId;
  }

  /**
   * Handle incoming ACK message
   */
  public handleAck(messageId: string): void {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) {
      log.debug("Received ACK for unknown message", { messageId });
      return;
    }

    log.debug("Received ACK for message", {
      messageId,
      type: pending.message.type,
    });

    // Clear timeout and remove from pending
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    this.pendingMessages.delete(messageId);
    this.persistState();

    broadcastFederationEvent("federation.message.delivered", {
      fromNodeId: pending.message.nodeId,
      toNodeId: pending.targetNodeId,
      msgId: messageId,
      latencyMs: Date.now() - pending.createdAt,
      ts: Date.now(),
    });

    // Call success callback
    pending.onSuccess?.(messageId);
  }

  /**
   * Check if a message is a duplicate based on messageId and sender
   */
  public isDuplicate(messageId: string, senderId: string): boolean {
    const senderCache = this.deduplicationCache.get(senderId) || [];
    const isDupe = senderCache.some((entry) => entry.messageId === messageId);

    if (isDupe) {
      log.debug("Detected duplicate message", { messageId, senderId });
      return true;
    }

    // Add to cache
    const now = Date.now();
    senderCache.push({ messageId, timestamp: now, senderId });

    // Trim cache if too large (remove oldest entries)
    if (senderCache.length > MAX_DEDUPLICATION_CACHE) {
      senderCache.splice(0, senderCache.length - MAX_DEDUPLICATION_CACHE);
    }

    this.deduplicationCache.set(senderId, senderCache);
    this.persistState();
    return false;
  }

  /**
   * Reconcile vector-clock sequence watermarks on reconnect before applying state.
   */
  public isStaleSequence(senderId: string, sequence: number): boolean {
    if (!Number.isFinite(sequence) || sequence <= 0) return false;
    const lastSeen = this.lastSeenSeqBySender.get(senderId) ?? 0;
    if (sequence <= lastSeen) {
      log.debug("Detected stale federation sequence", { senderId, sequence, lastSeen });
      return true;
    }
    this.lastSeenSeqBySender.set(senderId, sequence);
    this.persistState();
    return false;
  }

  /**
   * Clean up old deduplication entries (call periodically)
   */
  public cleanupDeduplication(maxAge: number = 300_000): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [senderId, entries] of this.deduplicationCache) {
      const beforeCount = entries.length;
      const filtered = entries.filter((entry) => now - entry.timestamp < maxAge);
      this.deduplicationCache.set(senderId, filtered);
      cleaned += beforeCount - filtered.length;
    }

    if (cleaned > 0) {
      log.debug("Cleaned up deduplication cache", { entriesRemoved: cleaned });
      this.persistState();
    }
  }

  public retryPendingForTarget(
    targetNodeId: string,
    sendFn: (message: FederationMessage) => Promise<void>,
  ): number {
    let retried = 0;
    for (const [messageId, pending] of this.pendingMessages) {
      if (pending.targetNodeId !== targetNodeId) continue;
      pending.sendFn = sendFn;
      // Restart restored messages only after the peer reconnects.
      this.scheduleAckTimeout(messageId, pending);
      void this.attemptSend(messageId, sendFn);
      retried++;
    }
    if (retried > 0) this.persistState();
    return retried;
  }

  /**
   * Get delivery statistics
   */
  public getStats(): {
    pendingMessages: number;
    cacheSize: number;
    pendingByType: Record<string, number>;
  } {
    const pendingByType: Record<string, number> = {};

    for (const pending of this.pendingMessages.values()) {
      const type = pending.message.type;
      pendingByType[type] = (pendingByType[type] || 0) + 1;
    }

    let totalCacheSize = 0;
    for (const entries of this.deduplicationCache.values()) {
      totalCacheSize += entries.length;
    }

    return {
      pendingMessages: this.pendingMessages.size,
      cacheSize: totalCacheSize,
      pendingByType,
    };
  }

  /**
   * Shutdown and clean up all pending timeouts
   */
  public shutdown(): void {
    log.info("Shutting down delivery manager", {
      pendingMessages: this.pendingMessages.size,
    });

    for (const pending of this.pendingMessages.values()) {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    }
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  private async attemptSend(
    messageId: string,
    sendFn: (message: FederationMessage) => Promise<void>,
  ): Promise<void> {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) {
      return;
    }

    try {
      await sendFn(pending.message);
      pending.lastSentAt = Date.now();
      this.scheduleAckTimeout(messageId, pending);
      this.persistState();
      log.debug("Message sent successfully", {
        messageId,
        type: pending.message.type,
        attempt: pending.retryCount + 1,
      });
      broadcastFederationEvent("federation.message.sent", {
        fromNodeId: pending.message.nodeId,
        toNodeId: pending.targetNodeId,
        messageType: pending.message.type,
        msgId: messageId,
        ts: pending.lastSentAt,
      });
    } catch (error) {
      log.warn("Failed to send message", {
        messageId,
        type: pending.message.type,
        attempt: pending.retryCount + 1,
        error: error instanceof Error ? error.message : String(error),
      });

      this.handleSendFailure(messageId, error instanceof Error ? error.message : String(error));
    }
  }

  private handleTimeout(messageId: string): void {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) {
      return;
    }

    log.warn("Message ACK timeout", {
      messageId,
      type: pending.message.type,
      retryCount: pending.retryCount,
    });

    this.handleSendFailure(messageId, "ACK timeout");
  }

  private handleSendFailure(messageId: string, error: string): void {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) {
      return;
    }

    // Track first failure time for DLQ
    if (!pending.firstFailedAt) {
      pending.firstFailedAt = Date.now();
    }

    pending.retryCount++;
    this.persistState();

    if (pending.retryCount >= this.maxRetries) {
      // Max retries exceeded - move to Dead Letter Queue
      log.error("Message delivery failed after max retries", {
        messageId,
        type: pending.message.type,
        retryCount: pending.retryCount,
        error,
      });

      // Add to Dead Letter Queue
      const dlq = getDeadLetterQueue();
      const dlqId = dlq.enqueue(
        pending.message,
        pending.targetNodeId,
        `retry_exhausted:${error}`,
        pending.retryCount,
        pending.firstFailedAt,
        {
          maxRetries: this.maxRetries,
          finalError: error,
        },
      );

      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      this.pendingMessages.delete(messageId);
      this.persistState();

      const finalError = `Max retries exceeded: ${error} (moved to DLQ: ${dlqId})`;
      const failedPayload = {
        fromNodeId: pending.message.nodeId,
        toNodeId: pending.targetNodeId,
        msgId: messageId,
        reason: finalError,
        ts: Date.now(),
      };
      broadcastFederationEvent("federation.message.failed", failedPayload);
      broadcastFederationEvent("federation.delivery_failed", failedPayload);
      pending.onFailure?.(messageId, finalError);
      return;
    }

    // Schedule retry with exponential backoff
    const delay = this.retryDelay * Math.pow(2, pending.retryCount - 1);

    log.debug("Scheduling message retry", {
      messageId,
      type: pending.message.type,
      retryCount: pending.retryCount,
      delayMs: delay,
    });

    // Clear old timeout and set new one for retry
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);

    // Schedule retry
    setTimeout(() => {
      if (pending.sendFn) {
        void this.attemptSend(messageId, pending.sendFn);
      } else {
        log.error("No send function available for retry", { messageId });
        this.handleSendFailure(messageId, "No send function available for retry");
      }
    }, delay);
  }

  private scheduleAckTimeout(messageId: string, pending: PendingMessage): void {
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    pending.timeoutHandle = setTimeout(() => {
      this.handleTimeout(messageId);
    }, this.ackTimeout);
  }

  private loadPersistedState(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as PersistedDeliveryState;
      if (parsed.version !== 1) return;
      this.pendingMessages.clear();
      for (const entry of parsed.pendingMessages) {
        const messageId = entry.message.messageId;
        if (!messageId) continue;
        this.pendingMessages.set(messageId, {
          ...entry,
          createdAt: entry.createdAt ?? Date.now(),
        });
      }
      this.deduplicationCache = new Map(Object.entries(parsed.deduplicationCache ?? {}));
      this.lastSeenSeqBySender = new Map(Object.entries(parsed.lastSeenSeqBySender ?? {}));
      log.info("Restored federation delivery state", {
        pendingMessages: this.pendingMessages.size,
        cacheSenders: this.deduplicationCache.size,
      });
    } catch (error) {
      log.warn("Failed to restore federation delivery state", {
        persistPath: this.persistPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persistState(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const state: PersistedDeliveryState = {
        version: 1,
        pendingMessages: Array.from(this.pendingMessages.values()).map((pending) => ({
          message: pending.message,
          targetNodeId: pending.targetNodeId,
          retryCount: pending.retryCount,
          firstFailedAt: pending.firstFailedAt,
          createdAt: pending.createdAt,
          lastSentAt: pending.lastSentAt,
        })),
        deduplicationCache: Object.fromEntries(this.deduplicationCache),
        lastSeenSeqBySender: Object.fromEntries(this.lastSeenSeqBySender),
      };
      writeFileSync(this.persistPath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      log.warn("Failed to persist federation delivery state", {
        persistPath: this.persistPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function defaultPersistPath(): string {
  return resolve(process.env.INFINIBOT_STATE_DIR || "state", "federation", "delivery-state.json");
}

// =============================================================================
// Singleton Instance
// =============================================================================

let deliveryManager: MessageDeliveryManager | null = null;

/**
 * Get or create the global delivery manager instance
 */
export function getDeliveryManager(): MessageDeliveryManager {
  if (!deliveryManager) {
    deliveryManager = new MessageDeliveryManager();

    // Cleanup old deduplication entries every 5 minutes
    setInterval(() => {
      deliveryManager?.cleanupDeduplication();
    }, 300_000);
  }

  return deliveryManager;
}

/**
 * Shutdown the delivery manager
 */
export function shutdownDeliveryManager(): void {
  if (deliveryManager) {
    deliveryManager.shutdown();
    deliveryManager = null;
  }
}
