/**
 * Federation Message Optimizer
 *
 * Optimizes federation bandwidth through:
 * 1. Message batching - Collects small messages over 10ms windows
 * 2. Payload compression - Compresses large payloads (>1KB) using gzip
 *
 * Transparent to existing message handlers - batching/compression is handled
 * at the transport layer.
 */

import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("federation").child("optimizer");

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// =============================================================================
// Constants
// =============================================================================

/** Batching window in milliseconds */
const BATCH_WINDOW_MS = 10;

/** Compression threshold in bytes */
const COMPRESSION_THRESHOLD = 1024;

/** Maximum batch size (prevent memory issues) */
const MAX_BATCH_SIZE = 100;

/** Maximum compressed message size (10MB) */
const MAX_COMPRESSED_SIZE = 10 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

/** Message batch frame */
export interface MessageBatch {
  type: "federation.batch";
  messages: string[];
  timestamp: number;
  messageId: string;
  nodeId: string;
}

/** Compressed message frame */
export interface CompressedMessage {
  type: "federation.compressed";
  compressedPayload: string; // base64 encoded gzipped data
  originalSize: number;
  timestamp: number;
  messageId: string;
  nodeId: string;
}

/** Pending message for batching */
interface PendingMessage {
  message: string;
  timestamp: number;
  nodeId: string;
}

/** Send function signature */
export type SendFunction = (message: string) => void | Promise<void>;

// =============================================================================
// Message Optimizer
// =============================================================================

export class MessageOptimizer {
  private batchQueues = new Map<string, PendingMessage[]>();
  private batchTimers = new Map<string, NodeJS.Timeout>();
  private compressionEnabled = true;
  private batchingEnabled = true;

  constructor(
    private nodeId: string,
    options: {
      compressionEnabled?: boolean;
      batchingEnabled?: boolean;
    } = {},
  ) {
    this.compressionEnabled = options.compressionEnabled ?? true;
    this.batchingEnabled = options.batchingEnabled ?? true;

    log.debug("Message optimizer initialized", {
      nodeId: this.nodeId,
      compressionEnabled: this.compressionEnabled,
      batchingEnabled: this.batchingEnabled,
    });
  }

  /**
   * Optimize and send a message. Handles batching and compression transparently.
   *
   * @param message - Raw federation message string
   * @param targetNodeId - Target node ID for batching
   * @param sendFn - Function to actually send the message
   */
  async optimizeAndSend(
    message: string,
    targetNodeId: string,
    sendFn: SendFunction,
  ): Promise<void> {
    try {
      const messageSize = Buffer.byteLength(message, "utf-8");

      // For large messages, compress if enabled
      if (this.compressionEnabled && messageSize >= COMPRESSION_THRESHOLD) {
        const compressed = await this.compressMessage(message, targetNodeId);
        await sendFn(compressed);

        log.debug("Message compressed and sent", {
          targetNodeId,
          originalSize: messageSize,
          compressedSize: Buffer.byteLength(compressed, "utf-8"),
          compressionRatio: (1 - Buffer.byteLength(compressed, "utf-8") / messageSize).toFixed(2),
        });
        return;
      }

      // For small messages, batch if enabled
      if (this.batchingEnabled && messageSize < COMPRESSION_THRESHOLD) {
        this.addToBatch(message, targetNodeId, sendFn);
        return;
      }

      // Send directly for medium messages or when optimizations disabled
      await sendFn(message);
    } catch (error) {
      log.error("Message optimization failed", {
        error: error instanceof Error ? error.message : String(error),
        targetNodeId,
        messageSize: Buffer.byteLength(message, "utf-8"),
      });

      // Fallback to direct send
      await sendFn(message);
    }
  }

  /**
   * Process received message, handling unbatching and decompression.
   *
   * @param message - Received message string
   * @returns Array of original messages
   */
  async processReceived(message: string): Promise<string[]> {
    try {
      const parsed = JSON.parse(message);

      // Handle batch messages
      if (parsed.type === "federation.batch") {
        const batch = parsed as MessageBatch;
        log.debug("Unbatching message", {
          messageCount: batch.messages.length,
          fromNode: batch.nodeId,
        });
        return batch.messages;
      }

      // Handle compressed messages
      if (parsed.type === "federation.compressed") {
        const compressed = parsed as CompressedMessage;
        const decompressed = await this.decompressMessage(compressed);

        log.debug("Message decompressed", {
          fromNode: compressed.nodeId,
          compressedSize: Buffer.byteLength(message, "utf-8"),
          originalSize: compressed.originalSize,
        });

        return [decompressed];
      }

      // Regular message
      return [message];
    } catch (error) {
      log.error("Message processing failed", {
        error: error instanceof Error ? error.message : String(error),
        messagePreview: message.slice(0, 100),
      });

      // Return original message as fallback
      return [message];
    }
  }

  /**
   * Flush all pending batches immediately.
   */
  flushAll(): void {
    for (const [targetNodeId] of this.batchQueues) {
      this.flushBatch(targetNodeId);
    }
  }

  /**
   * Shutdown optimizer, flushing pending messages.
   */
  shutdown(): void {
    this.flushAll();

    // Clear all timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }

    this.batchQueues.clear();
    this.batchTimers.clear();

    log.debug("Message optimizer shutdown");
  }

  /**
   * Get optimization statistics.
   */
  getStats(): {
    pendingBatches: number;
    totalQueuedMessages: number;
    batchingEnabled: boolean;
    compressionEnabled: boolean;
  } {
    let totalMessages = 0;
    for (const queue of this.batchQueues.values()) {
      totalMessages += queue.length;
    }

    return {
      pendingBatches: this.batchQueues.size,
      totalQueuedMessages: totalMessages,
      batchingEnabled: this.batchingEnabled,
      compressionEnabled: this.compressionEnabled,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Add message to batch queue and schedule flush.
   */
  private addToBatch(message: string, targetNodeId: string, sendFn: SendFunction): void {
    if (!this.batchQueues.has(targetNodeId)) {
      this.batchQueues.set(targetNodeId, []);
    }

    const queue = this.batchQueues.get(targetNodeId)!;
    queue.push({
      message,
      timestamp: Date.now(),
      nodeId: this.nodeId,
    });

    // If batch is full, flush immediately
    if (queue.length >= MAX_BATCH_SIZE) {
      this.flushBatch(targetNodeId, sendFn);
      return;
    }

    // Schedule batch flush if not already scheduled
    if (!this.batchTimers.has(targetNodeId)) {
      const timer = setTimeout(() => {
        this.flushBatch(targetNodeId, sendFn);
      }, BATCH_WINDOW_MS);

      this.batchTimers.set(targetNodeId, timer);
    }
  }

  /**
   * Flush pending batch for a target node.
   */
  private flushBatch(targetNodeId: string, sendFn?: SendFunction): void {
    const queue = this.batchQueues.get(targetNodeId);
    if (!queue || queue.length === 0) return;

    // Clear timer
    const timer = this.batchTimers.get(targetNodeId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(targetNodeId);
    }

    // Create batch message
    const batch: MessageBatch = {
      type: "federation.batch",
      messages: queue.map((p) => p.message),
      timestamp: Date.now(),
      messageId: this.generateMessageId(),
      nodeId: this.nodeId,
    };

    // Clear queue
    queue.length = 0;

    // Send batch
    if (sendFn) {
      const batchMessage = JSON.stringify(batch);

      log.debug("Sending message batch", {
        targetNodeId,
        messageCount: batch.messages.length,
        batchSize: Buffer.byteLength(batchMessage, "utf-8"),
      });

      const result = sendFn(batchMessage);
      if (result && typeof result.catch === "function") {
        result.catch((error: unknown) => {
          log.error("Failed to send batch", {
            targetNodeId,
            messageCount: batch.messages.length,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  /**
   * Compress a large message.
   */
  private async compressMessage(message: string, targetNodeId: string): Promise<string> {
    const originalData = Buffer.from(message, "utf-8");
    const compressedData = await gzipAsync(originalData);

    if (compressedData.length > MAX_COMPRESSED_SIZE) {
      throw new Error(`Compressed message too large: ${compressedData.length} bytes`);
    }

    const compressed: CompressedMessage = {
      type: "federation.compressed",
      compressedPayload: compressedData.toString("base64"),
      originalSize: originalData.length,
      timestamp: Date.now(),
      messageId: this.generateMessageId(),
      nodeId: this.nodeId,
    };

    return JSON.stringify(compressed);
  }

  /**
   * Decompress a compressed message.
   */
  private async decompressMessage(compressed: CompressedMessage): Promise<string> {
    const compressedData = Buffer.from(compressed.compressedPayload, "base64");
    const originalData = await gunzipAsync(compressedData);

    // Verify size matches
    if (originalData.length !== compressed.originalSize) {
      log.warn("Decompressed size mismatch", {
        expected: compressed.originalSize,
        actual: originalData.length,
        fromNode: compressed.nodeId,
      });
    }

    return originalData.toString("utf-8");
  }

  /**
   * Generate a unique message ID.
   */
  private generateMessageId(): string {
    return `opt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a message optimizer instance.
 */
export function createMessageOptimizer(
  nodeId: string,
  options?: {
    compressionEnabled?: boolean;
    batchingEnabled?: boolean;
  },
): MessageOptimizer {
  return new MessageOptimizer(nodeId, options);
}

/**
 * Check if a message is a batch or compressed message.
 */
export function isOptimizedMessage(message: string): boolean {
  try {
    const parsed = JSON.parse(message);
    return parsed.type === "federation.batch" || parsed.type === "federation.compressed";
  } catch {
    return false;
  }
}

/**
 * Get the estimated size reduction from compression for a given message.
 */
export async function estimateCompressionRatio(message: string): Promise<number> {
  try {
    const originalData = Buffer.from(message, "utf-8");
    const compressedData = await gzipAsync(originalData);
    return 1 - compressedData.length / originalData.length;
  } catch {
    return 0;
  }
}
