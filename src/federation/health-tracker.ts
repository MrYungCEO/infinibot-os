/**
 * Health-Based Routing - Health Tracker
 *
 * Tracks the health of federation nodes based on multiple metrics:
 * - Error rate (failures per request)
 * - Response latency (average response time)
 * - Heartbeat stability (missed heartbeats)
 * - Connection availability (disconnections)
 *
 * Provides health scores (0-100) for routing decisions and quarantine management.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { EventEmitter } from "node:events";

const log = createSubsystemLogger("federation").child("health-tracker");

// ============================================================
// Health Metric Types
// ============================================================

/**
 * Health factors that contribute to overall node health score.
 */
export interface HealthMetrics {
  /** Error rate: percentage of failed requests (0-100) */
  errorRate: number;
  /** Average response latency in milliseconds */
  averageLatencyMs: number;
  /** Heartbeat stability: percentage of missed heartbeats (0-100) */
  missedHeartbeats: number;
  /** Recent disconnection count */
  recentDisconnections: number;
  /** Timestamp when metrics were last updated */
  lastUpdated: number;
}

/**
 * Node health score breakdown for transparency.
 */
export interface HealthScore {
  /** Overall health score (0-100, higher is better) */
  overall: number;
  /** Individual component scores */
  components: {
    /** Error rate score (0-100) */
    errorRate: number;
    /** Latency score (0-100) */
    latency: number;
    /** Heartbeat stability score (0-100) */
    heartbeat: number;
    /** Availability score (0-100) */
    availability: number;
  };
  /** Whether node is quarantined */
  isQuarantined: boolean;
  /** Reason for current health status */
  reason: string;
  /** Timestamp when score was calculated */
  timestamp: number;
}

/**
 * Historical health tracking data for a single node.
 */
export interface NodeHealthHistory {
  /** Node identifier */
  nodeId: string;
  /** Current health metrics */
  currentMetrics: HealthMetrics;
  /** Current health score */
  currentScore: HealthScore;
  /** Historical error count (sliding window) */
  errorHistory: Array<{ timestamp: number; count: number }>;
  /** Historical latency measurements (sliding window) */
  latencyHistory: Array<{ timestamp: number; latencyMs: number }>;
  /** Historical heartbeat data (sliding window) */
  heartbeatHistory: Array<{ timestamp: number; received: boolean }>;
  /** Connection events (sliding window) */
  connectionHistory: Array<{ timestamp: number; event: "connect" | "disconnect"; reason?: string }>;
  /** Whether node is currently quarantined */
  quarantined: boolean;
  /** When node was quarantined (if applicable) */
  quarantinedAt?: number;
  /** Manual override: force healthy or quarantine */
  manualOverride?: "healthy" | "quarantine";
  /** Last time any metric was updated */
  lastActivity: number;
}

/**
 * Health tracker configuration.
 */
export interface HealthTrackerConfig {
  /** Health score below this threshold triggers quarantine */
  quarantineThreshold: number;
  /** Health score above this threshold removes quarantine */
  unquarantineThreshold: number;
  /** Time window for tracking metrics (in milliseconds) */
  trackingWindowMs: number;
  /** Maximum acceptable error rate (%) before severe penalty */
  maxErrorRate: number;
  /** Maximum acceptable latency (ms) before severe penalty */
  maxLatencyMs: number;
  /** Maximum missed heartbeats before severe penalty */
  maxMissedHeartbeats: number;
  /** How often to cleanup old history data (ms) */
  cleanupIntervalMs: number;
}

/**
 * Health tracker events.
 */
export interface HealthTrackerEvents {
  "health:updated": (nodeId: string, score: HealthScore) => void;
  "health:quarantined": (nodeId: string, score: HealthScore) => void;
  "health:unquarantined": (nodeId: string, score: HealthScore) => void;
  "health:critical": (nodeId: string, score: HealthScore) => void;
}

// ============================================================
// Health Tracker Implementation
// ============================================================

export class HealthTracker extends EventEmitter {
  private nodeHealthMap = new Map<string, NodeHealthHistory>();
  private config: HealthTrackerConfig;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config?: Partial<HealthTrackerConfig>) {
    super();

    // Default configuration
    this.config = {
      quarantineThreshold: 20, // Quarantine below 20% health
      unquarantineThreshold: 50, // Unquarantine above 50% health
      trackingWindowMs: 30 * 60 * 1000, // 30 minutes window
      maxErrorRate: 10, // 10% error rate threshold
      maxLatencyMs: 5000, // 5 second latency threshold
      maxMissedHeartbeats: 20, // 20% missed heartbeats threshold
      cleanupIntervalMs: 10 * 60 * 1000, // Cleanup every 10 minutes
      ...config,
    };

    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldHistory();
    }, this.config.cleanupIntervalMs);

    log.info("health tracker initialized", {
      quarantineThreshold: this.config.quarantineThreshold,
      unquarantineThreshold: this.config.unquarantineThreshold,
      trackingWindowMs: this.config.trackingWindowMs,
    });
  }

  /**
   * Initialize health tracking for a new node.
   */
  addNode(nodeId: string): void {
    if (this.nodeHealthMap.has(nodeId)) {
      return; // Already tracking
    }

    const now = Date.now();
    const nodeHealth: NodeHealthHistory = {
      nodeId,
      currentMetrics: {
        errorRate: 0,
        averageLatencyMs: 0,
        missedHeartbeats: 0,
        recentDisconnections: 0,
        lastUpdated: now,
      },
      currentScore: this.calculateInitialScore(),
      errorHistory: [],
      latencyHistory: [],
      heartbeatHistory: [],
      connectionHistory: [{ timestamp: now, event: "connect" }],
      quarantined: false,
      lastActivity: now,
    };

    this.nodeHealthMap.set(nodeId, nodeHealth);

    log.debug("added node to health tracking", { nodeId });
  }

  /**
   * Remove a node from health tracking.
   */
  removeNode(nodeId: string): void {
    this.nodeHealthMap.delete(nodeId);
    log.debug("removed node from health tracking", { nodeId });
  }

  /**
   * Record a request error for a node.
   */
  recordError(nodeId: string, errorType?: string): void {
    const nodeHealth = this.getOrCreateNodeHealth(nodeId);
    const now = Date.now();

    // Add to error history
    nodeHealth.errorHistory.push({ timestamp: now, count: 1 });
    nodeHealth.lastActivity = now;

    // Update metrics and score
    this.updateNodeMetrics(nodeId);

    log.debug("recorded error for node", { nodeId, errorType });
  }

  /**
   * Record a successful request latency for a node.
   */
  recordLatency(nodeId: string, latencyMs: number): void {
    const nodeHealth = this.getOrCreateNodeHealth(nodeId);
    const now = Date.now();

    // Add to latency history
    nodeHealth.latencyHistory.push({ timestamp: now, latencyMs });
    nodeHealth.lastActivity = now;

    // Update metrics and score
    this.updateNodeMetrics(nodeId);

    log.debug("recorded latency for node", { nodeId, latencyMs });
  }

  /**
   * Record a heartbeat event (received or missed).
   */
  recordHeartbeat(nodeId: string, received: boolean): void {
    const nodeHealth = this.getOrCreateNodeHealth(nodeId);
    const now = Date.now();

    // Add to heartbeat history
    nodeHealth.heartbeatHistory.push({ timestamp: now, received });
    nodeHealth.lastActivity = now;

    // Update metrics and score
    this.updateNodeMetrics(nodeId);

    log.debug("recorded heartbeat for node", { nodeId, received });
  }

  /**
   * Record a connection event (connect/disconnect).
   */
  recordConnection(nodeId: string, event: "connect" | "disconnect", reason?: string): void {
    const nodeHealth = this.getOrCreateNodeHealth(nodeId);
    const now = Date.now();

    // Add to connection history
    nodeHealth.connectionHistory.push({ timestamp: now, event, reason });
    nodeHealth.lastActivity = now;

    // Update metrics and score
    this.updateNodeMetrics(nodeId);

    log.info("recorded connection event for node", { nodeId, event, reason });
  }

  /**
   * Get current health score for a node.
   */
  getHealthScore(nodeId: string): HealthScore | null {
    const nodeHealth = this.nodeHealthMap.get(nodeId);
    return nodeHealth?.currentScore || null;
  }

  /**
   * Get all health scores for routing decisions.
   */
  getAllHealthScores(): Map<string, HealthScore> {
    const scores = new Map<string, HealthScore>();

    for (const [nodeId, nodeHealth] of this.nodeHealthMap) {
      scores.set(nodeId, nodeHealth.currentScore);
    }

    return scores;
  }

  /**
   * Check if a node is quarantined.
   */
  isQuarantined(nodeId: string): boolean {
    const nodeHealth = this.nodeHealthMap.get(nodeId);
    return nodeHealth?.quarantined || false;
  }

  /**
   * Get all quarantined nodes.
   */
  getQuarantinedNodes(): string[] {
    const quarantined: string[] = [];

    for (const [nodeId, nodeHealth] of this.nodeHealthMap) {
      if (nodeHealth.quarantined) {
        quarantined.push(nodeId);
      }
    }

    return quarantined;
  }

  /**
   * Manually override node health status.
   */
  setManualOverride(nodeId: string, override: "healthy" | "quarantine" | null): void {
    const nodeHealth = this.getOrCreateNodeHealth(nodeId);

    if (override === null) {
      delete nodeHealth.manualOverride;
    } else {
      nodeHealth.manualOverride = override;
    }

    // Force quarantine state based on override
    if (override === "quarantine") {
      this.quarantineNode(nodeId, "Manual override");
    } else if (override === "healthy") {
      this.unquarantineNode(nodeId, "Manual override");
    }

    // Recalculate score
    this.updateNodeMetrics(nodeId);

    log.info("set manual health override", { nodeId, override });
  }

  /**
   * Get health summary for all nodes.
   */
  getHealthSummary(): {
    totalNodes: number;
    healthyNodes: number;
    quarantinedNodes: number;
    averageHealth: number;
    nodeScores: Array<{ nodeId: string; score: number; quarantined: boolean }>;
  } {
    const scores: Array<{ nodeId: string; score: number; quarantined: boolean }> = [];
    let totalScore = 0;
    let healthyCount = 0;
    let quarantinedCount = 0;

    for (const [nodeId, nodeHealth] of this.nodeHealthMap) {
      const score = nodeHealth.currentScore.overall;
      const quarantined = nodeHealth.quarantined;

      scores.push({ nodeId, score, quarantined });
      totalScore += score;

      if (quarantined) {
        quarantinedCount++;
      } else {
        healthyCount++;
      }
    }

    const totalNodes = this.nodeHealthMap.size;
    const averageHealth = totalNodes > 0 ? totalScore / totalNodes : 0;

    return {
      totalNodes,
      healthyNodes: healthyCount,
      quarantinedNodes: quarantinedCount,
      averageHealth,
      nodeScores: scores.sort((a, b) => b.score - a.score),
    };
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.nodeHealthMap.clear();
    this.removeAllListeners();

    log.info("health tracker destroyed");
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Get or create node health history.
   */
  private getOrCreateNodeHealth(nodeId: string): NodeHealthHistory {
    let nodeHealth = this.nodeHealthMap.get(nodeId);
    if (!nodeHealth) {
      this.addNode(nodeId);
      nodeHealth = this.nodeHealthMap.get(nodeId)!;
    }
    return nodeHealth;
  }

  /**
   * Update metrics and health score for a node.
   */
  private updateNodeMetrics(nodeId: string): void {
    const nodeHealth = this.nodeHealthMap.get(nodeId);
    if (!nodeHealth) return;

    const now = Date.now();
    const windowStart = now - this.config.trackingWindowMs;

    // Calculate current metrics
    const currentMetrics = this.calculateMetrics(nodeHealth, windowStart, now);
    nodeHealth.currentMetrics = currentMetrics;

    // Calculate health score
    const healthScore = this.calculateHealthScore(nodeId, currentMetrics);
    const previousScore = nodeHealth.currentScore;
    nodeHealth.currentScore = healthScore;

    // Check for quarantine changes
    this.checkQuarantineStatus(nodeId, nodeHealth, previousScore, healthScore);

    // Emit health update event
    this.emit("health:updated", nodeId, healthScore);
  }

  /**
   * Calculate metrics from historical data within time window.
   */
  private calculateMetrics(
    nodeHealth: NodeHealthHistory,
    windowStart: number,
    windowEnd: number,
  ): HealthMetrics {
    // Calculate error rate
    const recentErrors = nodeHealth.errorHistory.filter(
      (e) => e.timestamp >= windowStart && e.timestamp <= windowEnd,
    );
    const totalRequests =
      recentErrors.length +
      nodeHealth.latencyHistory.filter(
        (l) => l.timestamp >= windowStart && l.timestamp <= windowEnd,
      ).length;
    const errorRate = totalRequests > 0 ? (recentErrors.length / totalRequests) * 100 : 0;

    // Calculate average latency
    const recentLatencies = nodeHealth.latencyHistory.filter(
      (l) => l.timestamp >= windowStart && l.timestamp <= windowEnd,
    );
    const averageLatencyMs =
      recentLatencies.length > 0
        ? recentLatencies.reduce((sum, l) => sum + l.latencyMs, 0) / recentLatencies.length
        : 0;

    // Calculate missed heartbeats percentage
    const recentHeartbeats = nodeHealth.heartbeatHistory.filter(
      (h) => h.timestamp >= windowStart && h.timestamp <= windowEnd,
    );
    const missedHeartbeats =
      recentHeartbeats.length > 0
        ? (recentHeartbeats.filter((h) => !h.received).length / recentHeartbeats.length) * 100
        : 0;

    // Count recent disconnections
    const recentDisconnections = nodeHealth.connectionHistory.filter(
      (c) => c.timestamp >= windowStart && c.timestamp <= windowEnd && c.event === "disconnect",
    ).length;

    return {
      errorRate,
      averageLatencyMs,
      missedHeartbeats,
      recentDisconnections,
      lastUpdated: windowEnd,
    };
  }

  /**
   * Calculate overall health score from metrics.
   */
  private calculateHealthScore(nodeId: string, metrics: HealthMetrics): HealthScore {
    const nodeHealth = this.nodeHealthMap.get(nodeId);

    // Handle manual overrides
    if (nodeHealth?.manualOverride === "healthy") {
      return {
        overall: 100,
        components: { errorRate: 100, latency: 100, heartbeat: 100, availability: 100 },
        isQuarantined: false,
        reason: "Manual override: healthy",
        timestamp: Date.now(),
      };
    } else if (nodeHealth?.manualOverride === "quarantine") {
      return {
        overall: 0,
        components: { errorRate: 0, latency: 0, heartbeat: 0, availability: 0 },
        isQuarantined: true,
        reason: "Manual override: quarantine",
        timestamp: Date.now(),
      };
    }

    // Component scores (0-100 each)
    const errorScore = Math.max(0, 100 - (metrics.errorRate / this.config.maxErrorRate) * 100);
    const latencyScore = Math.max(
      0,
      100 - (metrics.averageLatencyMs / this.config.maxLatencyMs) * 100,
    );
    const heartbeatScore = Math.max(
      0,
      100 - (metrics.missedHeartbeats / this.config.maxMissedHeartbeats) * 100,
    );

    // Availability score based on recent disconnections (exponential penalty)
    const availabilityScore = Math.max(0, 100 - Math.min(100, metrics.recentDisconnections * 25));

    // Overall score: weighted average of components
    const overall = Math.round(
      errorScore * 0.3 + // 30% weight on error rate
        latencyScore * 0.25 + // 25% weight on latency
        heartbeatScore * 0.25 + // 25% weight on heartbeat stability
        availabilityScore * 0.2, // 20% weight on availability
    );

    // Determine reason
    let reason = "Healthy";
    if (overall < 20) {
      reason = "Critical: Multiple health issues";
    } else if (overall < 50) {
      reason = "Degraded: ";
      const issues = [];
      if (errorScore < 50) issues.push("high errors");
      if (latencyScore < 50) issues.push("high latency");
      if (heartbeatScore < 50) issues.push("missed heartbeats");
      if (availabilityScore < 50) issues.push("frequent disconnects");
      reason += issues.join(", ");
    } else if (overall < 80) {
      reason = "Good";
    } else {
      reason = "Excellent";
    }

    return {
      overall,
      components: {
        errorRate: Math.round(errorScore),
        latency: Math.round(latencyScore),
        heartbeat: Math.round(heartbeatScore),
        availability: Math.round(availabilityScore),
      },
      isQuarantined: nodeHealth?.quarantined || false,
      reason,
      timestamp: Date.now(),
    };
  }

  /**
   * Check and update quarantine status based on health score.
   */
  private checkQuarantineStatus(
    nodeId: string,
    nodeHealth: NodeHealthHistory,
    previousScore: HealthScore,
    newScore: HealthScore,
  ): void {
    const wasQuarantined = nodeHealth.quarantined;
    const shouldQuarantine = newScore.overall < this.config.quarantineThreshold;
    const shouldUnquarantine = newScore.overall > this.config.unquarantineThreshold;

    // Don't change quarantine status if manual override is set
    if (nodeHealth.manualOverride) {
      return;
    }

    if (!wasQuarantined && shouldQuarantine) {
      this.quarantineNode(nodeId, `Health score too low: ${newScore.overall}`);
    } else if (wasQuarantined && shouldUnquarantine) {
      this.unquarantineNode(nodeId, `Health score improved: ${newScore.overall}`);
    }

    // Emit critical health warning if score is very low
    if (newScore.overall < 10 && previousScore.overall >= 10) {
      this.emit("health:critical", nodeId, newScore);
    }
  }

  /**
   * Quarantine a node.
   */
  private quarantineNode(nodeId: string, reason: string): void {
    const nodeHealth = this.nodeHealthMap.get(nodeId);
    if (!nodeHealth || nodeHealth.quarantined) {
      return; // Already quarantined
    }

    nodeHealth.quarantined = true;
    nodeHealth.quarantinedAt = Date.now();
    nodeHealth.currentScore.isQuarantined = true;

    log.warn("node quarantined", { nodeId, reason });
    this.emit("health:quarantined", nodeId, nodeHealth.currentScore);
  }

  /**
   * Remove a node from quarantine.
   */
  private unquarantineNode(nodeId: string, reason: string): void {
    const nodeHealth = this.nodeHealthMap.get(nodeId);
    if (!nodeHealth || !nodeHealth.quarantined) {
      return; // Not quarantined
    }

    nodeHealth.quarantined = false;
    delete nodeHealth.quarantinedAt;
    nodeHealth.currentScore.isQuarantined = false;

    log.info("node unquarantined", { nodeId, reason });
    this.emit("health:unquarantined", nodeId, nodeHealth.currentScore);
  }

  /**
   * Calculate initial health score for new nodes.
   */
  private calculateInitialScore(): HealthScore {
    return {
      overall: 100,
      components: {
        errorRate: 100,
        latency: 100,
        heartbeat: 100,
        availability: 100,
      },
      isQuarantined: false,
      reason: "New node - no history",
      timestamp: Date.now(),
    };
  }

  /**
   * Cleanup old history data outside the tracking window.
   */
  private cleanupOldHistory(): void {
    const now = Date.now();
    const cutoff = now - this.config.trackingWindowMs;
    let cleanedCount = 0;

    for (const [nodeId, nodeHealth] of this.nodeHealthMap) {
      // Clean error history
      const errorsBefore = nodeHealth.errorHistory.length;
      nodeHealth.errorHistory = nodeHealth.errorHistory.filter((e) => e.timestamp >= cutoff);

      // Clean latency history
      const latenciesBefore = nodeHealth.latencyHistory.length;
      nodeHealth.latencyHistory = nodeHealth.latencyHistory.filter((l) => l.timestamp >= cutoff);

      // Clean heartbeat history
      const heartbeatsBefore = nodeHealth.heartbeatHistory.length;
      nodeHealth.heartbeatHistory = nodeHealth.heartbeatHistory.filter(
        (h) => h.timestamp >= cutoff,
      );

      // Clean connection history
      const connectionsBefore = nodeHealth.connectionHistory.length;
      nodeHealth.connectionHistory = nodeHealth.connectionHistory.filter(
        (c) => c.timestamp >= cutoff,
      );

      const totalCleaned =
        errorsBefore -
        nodeHealth.errorHistory.length +
        (latenciesBefore - nodeHealth.latencyHistory.length) +
        (heartbeatsBefore - nodeHealth.heartbeatHistory.length) +
        (connectionsBefore - nodeHealth.connectionHistory.length);

      cleanedCount += totalCleaned;
    }

    if (cleanedCount > 0) {
      log.debug("cleaned up old health history", { cleanedCount });
    }
  }
}

// ============================================================
// Singleton and Factory Functions
// ============================================================

let healthTracker: HealthTracker | null = null;

/**
 * Get the health tracker singleton.
 */
export function getHealthTracker(): HealthTracker {
  if (!healthTracker) {
    healthTracker = new HealthTracker();
  }
  return healthTracker;
}

/**
 * Initialize health tracker with custom configuration.
 */
export function initHealthTracker(config?: Partial<HealthTrackerConfig>): HealthTracker {
  if (healthTracker) {
    healthTracker.destroy();
  }
  healthTracker = new HealthTracker(config);
  return healthTracker;
}

/**
 * Destroy the health tracker singleton.
 */
export function destroyHealthTracker(): void {
  if (healthTracker) {
    healthTracker.destroy();
    healthTracker = null;
  }
}
