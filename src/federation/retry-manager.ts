/**
 * Retry Manager for Failed Remote Spawns
 *
 * Handles automatic retry of failed remote spawn operations with exponential backoff.
 * Supports trying alternate nodes when the original node fails.
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  SessionSpawnRequest,
  SessionHandle,
  RetryConfig,
  RetryQueueEntry,
  RetryAttempt,
  SpawnFailureType,
  NodeManifest,
} from "./types.js";
import { DEFAULT_RETRY_CONFIG } from "./types.js";
import { FederationError, FederationErrorCode } from "./types.js";

const log = createSubsystemLogger("federation").child("retry-manager");

/**
 * Function signature for the actual spawn operation
 */
export type SpawnFunction = (request: SessionSpawnRequest) => Promise<SessionHandle>;

/**
 * Function signature for getting available nodes with capabilities
 */
export type NodeSelectorFunction = (excludeNodes?: Set<string>) => NodeManifest[];

/**
 * Manages retry logic for failed remote spawn operations
 */
export class RetryManager {
  private readonly retryQueue = new Map<string, RetryQueueEntry>();
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly defaultConfig: RetryConfig;

  constructor(
    private readonly spawnFunction: SpawnFunction,
    private readonly nodeSelector: NodeSelectorFunction,
    config?: Partial<RetryConfig>,
  ) {
    this.defaultConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
    log.info("RetryManager initialized", { config: this.defaultConfig });
  }

  /**
   * Execute a spawn request with automatic retry on failure
   */
  async executeWithRetry(
    request: SessionSpawnRequest,
    config?: Partial<RetryConfig>,
  ): Promise<SessionHandle> {
    const retryConfig = { ...this.defaultConfig, ...config };
    
    try {
      // First attempt - try original request as-is
      log.debug("Attempting initial spawn", { nodeId: request.nodeId, agentId: request.agentId });
      return await this.spawnFunction(request);
    } catch (error) {
      log.warn("Initial spawn failed, queuing for retry", { 
        nodeId: request.nodeId, 
        error: error instanceof Error ? error.message : String(error) 
      });

      // Classify the failure type
      const failureType = this.classifyFailure(error);
      
      // Don't retry user errors
      if (failureType === "agent_spawn_error") {
        log.debug("Not retrying agent spawn error", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }

      // Queue for retry
      return this.queueForRetry(request, failureType, retryConfig);
    }
  }

  /**
   * Queue a failed spawn request for retry with exponential backoff
   */
  private async queueForRetry(
    originalRequest: SessionSpawnRequest,
    failureType: SpawnFailureType,
    config: RetryConfig,
  ): Promise<SessionHandle> {
    const retryId = randomUUID();
    const excludedNodes = new Set<string>();
    
    // If node disconnected or connection failed, exclude the original node
    if (failureType === "node_disconnected" || failureType === "connection_timeout") {
      excludedNodes.add(originalRequest.nodeId);
    }

    // Calculate initial delay
    const delayMs = Math.min(config.initialDelayMs, config.maxDelayMs);
    const nextRetryAt = Date.now() + delayMs;

    return new Promise<SessionHandle>((resolve, reject) => {
      const entry: RetryQueueEntry = {
        retryId,
        originalRequest,
        resolve,
        reject,
        attemptNumber: 1,
        nextRetryAt,
        failureType,
        excludedNodes,
        config,
      };

      this.retryQueue.set(retryId, entry);
      log.info("Queued spawn for retry", { 
        retryId, 
        nodeId: originalRequest.nodeId,
        attemptNumber: 1,
        delayMs,
        failureType 
      });

      // Start the retry timer if not already running
      this.ensureRetryTimerRunning();
    });
  }

  /**
   * Process the retry queue, executing any entries that are ready
   */
  private async processRetryQueue(): Promise<void> {
    const now = Date.now();
    const readyEntries = Array.from(this.retryQueue.values())
      .filter(entry => entry.nextRetryAt <= now)
      .sort((a, b) => a.nextRetryAt - b.nextRetryAt);

    if (readyEntries.length === 0) {
      return;
    }

    log.debug(`Processing ${readyEntries.length} ready retry entries`);

    // Process each ready entry
    for (const entry of readyEntries) {
      await this.processRetryEntry(entry);
    }
  }

  /**
   * Process a single retry entry
   */
  private async processRetryEntry(entry: RetryQueueEntry): Promise<void> {
    const { retryId, originalRequest, attemptNumber, config, excludedNodes, failureType } = entry;

    try {
      // Find a suitable node (different from excluded ones if possible)
      const availableNodes = this.nodeSelector(excludedNodes);
      
      if (availableNodes.length === 0) {
        // No nodes available, fail the request
        this.failRetryEntry(entry, new FederationError(
          FederationErrorCode.NODE_NOT_FOUND,
          "No available nodes for retry"
        ));
        return;
      }

      // Pick the first available node (could be improved with load balancing)
      const targetNode = availableNodes[0];
      const retryRequest: SessionSpawnRequest = {
        ...originalRequest,
        nodeId: targetNode.id,
      };

      log.info("Retrying spawn", { 
        retryId,
        attemptNumber,
        originalNodeId: originalRequest.nodeId,
        retryNodeId: targetNode.id,
        failureType 
      });

      // Create retry attempt record
      const attempt: RetryAttempt = {
        requestId: retryId,
        originalRequest,
        attemptNumber,
        timestamp: Date.now(),
        targetNodeId: targetNode.id,
        retryReason: failureType,
        delayMs: entry.nextRetryAt - (Date.now() - this.calculateDelay(attemptNumber - 1, config)),
      };

      // Attempt the spawn
      const result = await this.spawnFunction(retryRequest);
      
      // Success! Resolve the original promise
      this.completeRetryEntry(entry, result);
      log.info("Retry successful", { retryId, attemptNumber, targetNodeId: targetNode.id });

    } catch (error) {
      log.warn("Retry attempt failed", { 
        retryId, 
        attemptNumber,
        error: error instanceof Error ? error.message : String(error) 
      });

      // Check if we should retry again
      if (attemptNumber >= config.maxRetries) {
        // Max retries reached, fail the request
        this.failRetryEntry(entry, new FederationError(
          FederationErrorCode.INTERNAL_ERROR,
          `Failed after ${config.maxRetries} retry attempts: ${error instanceof Error ? error.message : String(error)}`
        ));
      } else {
        // Schedule another retry
        this.scheduleNextRetry(entry, this.classifyFailure(error));
      }
    }
  }

  /**
   * Schedule the next retry attempt for an entry
   */
  private scheduleNextRetry(entry: RetryQueueEntry, newFailureType: SpawnFailureType): void {
    const { retryId, config, attemptNumber } = entry;
    
    // Update failure type and excluded nodes
    entry.failureType = newFailureType;
    if (newFailureType === "node_disconnected" || newFailureType === "connection_timeout") {
      // Exclude the node that just failed
      const lastAttemptNode = entry.originalRequest.nodeId; // This should be updated to track current attempt node
      entry.excludedNodes.add(lastAttemptNode);
    }

    // Calculate exponential backoff delay
    const delay = this.calculateDelay(attemptNumber, config);
    entry.attemptNumber = attemptNumber + 1;
    entry.nextRetryAt = Date.now() + delay;

    log.debug("Scheduled next retry", { 
      retryId,
      attemptNumber: entry.attemptNumber,
      delayMs: delay,
      nextRetryAt: new Date(entry.nextRetryAt).toISOString() 
    });
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateDelay(attemptNumber: number, config: RetryConfig): number {
    const exponentialDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attemptNumber);
    return Math.min(exponentialDelay, config.maxDelayMs);
  }

  /**
   * Complete a successful retry entry
   */
  private completeRetryEntry(entry: RetryQueueEntry, result: SessionHandle): void {
    this.retryQueue.delete(entry.retryId);
    entry.resolve(result);
  }

  /**
   * Fail a retry entry after max attempts or unrecoverable error
   */
  private failRetryEntry(entry: RetryQueueEntry, error: Error): void {
    this.retryQueue.delete(entry.retryId);
    entry.reject(error);
  }

  /**
   * Classify a spawn failure to determine retry strategy
   */
  private classifyFailure(error: unknown): SpawnFailureType {
    if (!(error instanceof Error)) {
      return "unknown_error";
    }

    const message = error.message.toLowerCase();

    // Connection timeouts
    if (message.includes("timeout") || message.includes("request timeout")) {
      return "connection_timeout";
    }

    // Node not connected/available
    if (message.includes("not connected") || message.includes("node not found") || message.includes("node offline")) {
      return "node_disconnected";
    }

    // Network send failures
    if (message.includes("send failed") || message.includes("connection reset") || message.includes("connection refused")) {
      return "send_failed";
    }

    // Agent-specific errors (don't retry these)
    if (message.includes("agent not found") || message.includes("invalid agent") || message.includes("spawn error")) {
      return "agent_spawn_error";
    }

    return "unknown_error";
  }

  /**
   * Ensure the retry timer is running to process the queue
   */
  private ensureRetryTimerRunning(): void {
    if (this.retryTimer !== null) {
      return;
    }

    this.retryTimer = setInterval(async () => {
      try {
        await this.processRetryQueue();
      } catch (error) {
        log.error("Error processing retry queue", { error });
      }

      // Stop timer if queue is empty
      if (this.retryQueue.size === 0) {
        clearInterval(this.retryTimer!);
        this.retryTimer = null;
        log.debug("Retry timer stopped - queue empty");
      }
    }, 1000); // Check every second

    log.debug("Retry timer started");
  }

  /**
   * Get current retry queue status (for debugging/monitoring)
   */
  getRetryStatus() {
    const entries = Array.from(this.retryQueue.values());
    return {
      queueSize: entries.length,
      entries: entries.map(entry => ({
        retryId: entry.retryId,
        attemptNumber: entry.attemptNumber,
        nextRetryAt: new Date(entry.nextRetryAt).toISOString(),
        failureType: entry.failureType,
        excludedNodes: Array.from(entry.excludedNodes),
        originalNodeId: entry.originalRequest.nodeId,
      })),
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    // Fail all pending retries
    for (const entry of this.retryQueue.values()) {
      entry.reject(new Error("RetryManager destroyed"));
    }
    this.retryQueue.clear();

    log.info("RetryManager destroyed");
  }
}