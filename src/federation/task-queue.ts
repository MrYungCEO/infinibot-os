/**
 * Task Queuing System
 *
 * Manages priority queues for spawn requests when target nodes are at capacity.
 * Provides FIFO with priority support, queue timeouts, and capacity monitoring.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  SessionSpawnRequest,
  SessionHandle,
  QueueItem,
  NodeQueue,
  QueuePriority,
  TaskQueueConfig,
  QueueStats,
} from "./types.js";
import { DEFAULT_TASK_QUEUE_CONFIG } from "./types.js";

const log = createSubsystemLogger("federation").child("task-queue");

/**
 * Task Queue Manager
 * 
 * Handles queuing of spawn requests when nodes are at capacity.
 * Supports priority levels and automatic dequeuing when capacity becomes available.
 */
export class TaskQueue extends EventEmitter {
  /** Node-specific queues */
  private queues: Map<string, NodeQueue> = new Map();
  
  /** Timeout handlers for queue items */
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  
  /** Queue processing interval */
  private processingInterval: NodeJS.Timeout | null = null;
  
  /** Configuration */
  private config: TaskQueueConfig;
  
  /** Statistics tracking */
  private stats = {
    totalProcessed: 0,
    totalTimedOut: 0,
    recentlyProcessed: 0,
    lastStatsReset: Date.now(),
  };

  constructor(config: TaskQueueConfig = {}) {
    super();
    this.config = config;
    
    // Start queue processing
    this.startProcessing();
    
    log.info("TaskQueue initialized", { config: this.config });
  }

  /**
   * Check if a node is at capacity and should queue new requests.
   */
  shouldQueue(nodeId: string, currentCapacity: number): boolean {
    return currentCapacity >= (this.config.capacityThreshold || DEFAULT_TASK_QUEUE_CONFIG.capacityThreshold!);
  }

  /**
   * Add a spawn request to the queue for a specific node.
   * 
   * @param nodeId Target node ID
   * @param request Spawn request
   * @param priority Priority level (default: normal)
   * @param timeoutMs Timeout in milliseconds (default: from config)
   * @returns Promise that resolves when the task is processed
   */
  async queueSpawn(
    nodeId: string,
    request: SessionSpawnRequest,
    priority: QueuePriority = "normal",
    timeoutMs: number = this.config.defaultTimeoutMs || DEFAULT_TASK_QUEUE_CONFIG.defaultTimeoutMs!
  ): Promise<SessionHandle> {
    const queueItem: QueueItem = {
      id: randomUUID(),
      request,
      priority,
      queuedAt: Date.now(),
      timeoutMs,
      resolve: () => {}, // Will be set in the promise
      reject: () => {}, // Will be set in the promise
    };

    return new Promise<SessionHandle>((resolve, reject) => {
      queueItem.resolve = resolve;
      queueItem.reject = reject;

      // Get or create node queue
      const nodeQueue = this.getOrCreateNodeQueue(nodeId);

      // Check queue capacity
      if (nodeQueue.totalItems >= nodeQueue.maxSize) {
        reject(new Error(`Queue for node ${nodeId} is full (${nodeQueue.maxSize} items)`));
        return;
      }

      // Add to appropriate priority queue
      nodeQueue.queues[priority].push(queueItem);
      nodeQueue.totalItems++;

      // Update positions for all items in this node's queue
      this.updateQueuePositions(nodeId);

      // Set timeout
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(queueItem.id, nodeId);
      }, timeoutMs);
      
      this.timeouts.set(queueItem.id, timeoutHandle);

      log.info("Task queued", {
        itemId: queueItem.id,
        nodeId,
        priority,
        position: queueItem.position,
        totalInQueue: nodeQueue.totalItems,
        timeoutMs,
      });

      this.emit("queued", {
        itemId: queueItem.id,
        nodeId,
        priority,
        position: queueItem.position,
        totalInQueue: nodeQueue.totalItems,
      });
    });
  }

  /**
   * Notify that a node has capacity available - dequeue next item if any.
   */
  notifyCapacityAvailable(nodeId: string): void {
    const nodeQueue = this.queues.get(nodeId);
    if (!nodeQueue || nodeQueue.totalItems === 0) {
      return;
    }

    // Process the highest priority item
    const nextItem = this.getNextItemForNode(nodeId);
    if (nextItem) {
      this.processQueueItem(nodeId, nextItem);
    }
  }

  /**
   * Update node capacity (used to determine when to start processing queued items).
   */
  updateNodeCapacity(nodeId: string, capacity: number): void {
    const nodeQueue = this.queues.get(nodeId);
    if (nodeQueue) {
      const wasAtCapacity = nodeQueue.currentCapacity >= nodeQueue.capacityThreshold;
      nodeQueue.currentCapacity = capacity;
      const nowAtCapacity = capacity >= nodeQueue.capacityThreshold;

      log.debug("Node capacity updated", { nodeId, capacity, threshold: nodeQueue.capacityThreshold });

      // If capacity dropped below threshold and we have queued items, start processing
      if (wasAtCapacity && !nowAtCapacity && nodeQueue.totalItems > 0) {
        log.info("Node capacity available, processing queue", { nodeId, capacity });
        this.notifyCapacityAvailable(nodeId);
      }
    }
  }

  /**
   * Get queue position for a specific item.
   */
  getQueuePosition(itemId: string): { nodeId: string; position: number; totalInQueue: number } | null {
    for (const [nodeId, nodeQueue] of this.queues.entries()) {
      for (const priority of ["critical", "high", "normal", "low"] as QueuePriority[]) {
        const items = nodeQueue.queues[priority];
        const index = items.findIndex(item => item.id === itemId);
        if (index !== -1) {
          return {
            nodeId,
            position: items[index].position || 0,
            totalInQueue: nodeQueue.totalItems,
          };
        }
      }
    }
    return null;
  }

  /**
   * Get queue statistics across all nodes.
   */
  getStats(): QueueStats {
    const stats: QueueStats = {
      totalItems: 0,
      byNode: {},
      byPriority: {
        critical: 0,
        high: 0,
        normal: 0,
        low: 0,
      },
      avgWaitTimeMs: 0,
      processedRecently: this.stats.recentlyProcessed,
      timedOut: this.stats.totalTimedOut,
      utilization: {},
    };

    let totalWaitTime = 0;
    let totalItemsWithWaitTime = 0;
    const now = Date.now();

    for (const [nodeId, nodeQueue] of this.queues.entries()) {
      stats.totalItems += nodeQueue.totalItems;
      stats.byNode[nodeId] = nodeQueue.totalItems;
      stats.utilization[nodeId] = (nodeQueue.totalItems / nodeQueue.maxSize) * 100;

      // Count by priority and calculate wait times
      for (const priority of ["critical", "high", "normal", "low"] as QueuePriority[]) {
        const items = nodeQueue.queues[priority];
        stats.byPriority[priority] += items.length;

        for (const item of items) {
          totalWaitTime += now - item.queuedAt;
          totalItemsWithWaitTime++;
        }
      }
    }

    if (totalItemsWithWaitTime > 0) {
      stats.avgWaitTimeMs = totalWaitTime / totalItemsWithWaitTime;
    }

    return stats;
  }

  /**
   * Remove an item from queue (if it exists).
   */
  removeFromQueue(itemId: string): boolean {
    for (const [nodeId, nodeQueue] of this.queues.entries()) {
      for (const priority of ["critical", "high", "normal", "low"] as QueuePriority[]) {
        const items = nodeQueue.queues[priority];
        const index = items.findIndex(item => item.id === itemId);
        
        if (index !== -1) {
          items.splice(index, 1);
          nodeQueue.totalItems--;
          this.updateQueuePositions(nodeId);
          
          // Clear timeout
          const timeoutHandle = this.timeouts.get(itemId);
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            this.timeouts.delete(itemId);
          }
          
          log.debug("Item removed from queue", { itemId, nodeId, priority });
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Get queue status for all nodes.
   */
  getQueueStatus(): Record<string, { totalItems: number; capacity: number; threshold: number }> {
    const status: Record<string, { totalItems: number; capacity: number; threshold: number }> = {};
    
    for (const [nodeId, nodeQueue] of this.queues.entries()) {
      status[nodeId] = {
        totalItems: nodeQueue.totalItems,
        capacity: nodeQueue.currentCapacity,
        threshold: nodeQueue.capacityThreshold,
      };
    }
    
    return status;
  }

  /**
   * Stop the task queue and reject all pending items.
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Clear all timeouts and reject pending items
    for (const [nodeId, nodeQueue] of this.queues.entries()) {
      for (const priority of ["critical", "high", "normal", "low"] as QueuePriority[]) {
        for (const item of nodeQueue.queues[priority]) {
          const timeoutHandle = this.timeouts.get(item.id);
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            this.timeouts.delete(item.id);
          }
          item.reject(new Error("Task queue stopped"));
        }
        nodeQueue.queues[priority] = [];
      }
      nodeQueue.totalItems = 0;
    }

    this.queues.clear();
    log.info("TaskQueue stopped");
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Get or create a node queue.
   */
  private getOrCreateNodeQueue(nodeId: string): NodeQueue {
    let nodeQueue = this.queues.get(nodeId);
    
    if (!nodeQueue) {
      nodeQueue = {
        nodeId,
        queues: {
          critical: [],
          high: [],
          normal: [],
          low: [],
        },
        totalItems: 0,
        maxSize: this.config.maxQueueSizePerNode || DEFAULT_TASK_QUEUE_CONFIG.maxQueueSizePerNode!,
        currentCapacity: 0,
        capacityThreshold: this.config.capacityThreshold || DEFAULT_TASK_QUEUE_CONFIG.capacityThreshold!,
      };
      this.queues.set(nodeId, nodeQueue);
    }
    
    return nodeQueue;
  }

  /**
   * Get the next highest priority item for a node.
   */
  private getNextItemForNode(nodeId: string): QueueItem | null {
    const nodeQueue = this.queues.get(nodeId);
    if (!nodeQueue) return null;

    // Check priorities in order: critical, high, normal, low
    for (const priority of ["critical", "high", "normal", "low"] as QueuePriority[]) {
      const items = nodeQueue.queues[priority];
      if (items.length > 0) {
        return items[0]; // FIFO within priority level
      }
    }
    
    return null;
  }

  /**
   * Process a queue item by executing the spawn request.
   */
  private processQueueItem(nodeId: string, item: QueueItem): void {
    // Remove from queue
    this.removeFromQueue(item.id);

    log.info("Processing queued task", {
      itemId: item.id,
      nodeId,
      priority: item.priority,
      waitTimeMs: Date.now() - item.queuedAt,
    });

    this.stats.totalProcessed++;
    this.stats.recentlyProcessed++;

    this.emit("processing", {
      itemId: item.id,
      nodeId,
      priority: item.priority,
      waitTimeMs: Date.now() - item.queuedAt,
    });

    // The actual spawn execution will be handled by the hub
    // For now, we just emit an event that the hub can listen to
    this.emit("dequeue", {
      itemId: item.id,
      nodeId,
      request: item.request,
      resolve: item.resolve,
      reject: item.reject,
    });
  }

  /**
   * Handle timeout for a queue item.
   */
  private handleTimeout(itemId: string, nodeId: string): void {
    for (const [queueNodeId, nodeQueue] of this.queues.entries()) {
      if (queueNodeId !== nodeId) continue;
      
      for (const priority of ["critical", "high", "normal", "low"] as QueuePriority[]) {
        const items = nodeQueue.queues[priority];
        const index = items.findIndex(item => item.id === itemId);
        
        if (index !== -1) {
          const item = items[index];
          items.splice(index, 1);
          nodeQueue.totalItems--;
          this.updateQueuePositions(nodeId);
          
          this.timeouts.delete(itemId);
          this.stats.totalTimedOut++;
          
          log.warn("Queue item timed out", {
            itemId,
            nodeId,
            priority,
            waitTimeMs: Date.now() - item.queuedAt,
          });
          
          item.reject(new Error(`Queue timeout after ${item.timeoutMs}ms`));
          
          this.emit("timeout", {
            itemId,
            nodeId,
            priority,
            waitTimeMs: Date.now() - item.queuedAt,
          });
          
          return;
        }
      }
    }
  }

  /**
   * Update queue positions for all items in a node's queue.
   */
  private updateQueuePositions(nodeId: string): void {
    const nodeQueue = this.queues.get(nodeId);
    if (!nodeQueue) return;

    let position = 1;
    
    // Assign positions based on priority order
    for (const priority of ["critical", "high", "normal", "low"] as QueuePriority[]) {
      for (const item of nodeQueue.queues[priority]) {
        item.position = position++;
      }
    }
  }

  /**
   * Start the queue processing interval.
   */
  private startProcessing(): void {
    this.processingInterval = setInterval(() => {
      // Reset recent stats periodically
      this.stats.recentlyProcessed = 0;
      
      // Process any items for nodes that have capacity
      for (const [nodeId, nodeQueue] of this.queues.entries()) {
        if (nodeQueue.currentCapacity < nodeQueue.capacityThreshold && nodeQueue.totalItems > 0) {
          this.notifyCapacityAvailable(nodeId);
        }
      }
    }, this.config.processingIntervalMs || DEFAULT_TASK_QUEUE_CONFIG.processingIntervalMs!);
    
    log.debug("Queue processing started", { intervalMs: this.config.processingIntervalMs || DEFAULT_TASK_QUEUE_CONFIG.processingIntervalMs! });
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let defaultTaskQueue: TaskQueue | null = null;

/**
 * Get the default task queue instance.
 */
export function getTaskQueue(): TaskQueue | null {
  return defaultTaskQueue;
}

/**
 * Initialize the task queue system.
 */
export function initTaskQueue(config?: TaskQueueConfig): TaskQueue {
  if (defaultTaskQueue) {
    log.warn("task queue already initialized, returning existing instance");
    return defaultTaskQueue;
  }
  
  defaultTaskQueue = new TaskQueue(config);
  return defaultTaskQueue;
}

/**
 * Stop the task queue system.
 */
export function stopTaskQueue(): void {
  if (defaultTaskQueue) {
    defaultTaskQueue.stop();
    defaultTaskQueue = null;
  }
}