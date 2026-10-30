/**
 * Federation Load Balancer
 *
 * Manages workload distribution across federation nodes.
 * Tracks per-node load metrics, selects optimal nodes for new sessions,
 * and suggests session migrations when nodes become overloaded.
 */

import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  NodeManifest,
  NodeLoadMetrics,
  MigrationRequest,
  LoadBalancerConfig,
  FleetHealthSummary,
} from "./types.js";
import { calculateLoadScore } from "./resource-monitor.js";

const log = createSubsystemLogger("federation").child("load-balancer");

// ============================================================
// Types
// ============================================================

export interface LoadBalancerEvents {
  /** Emitted when a node becomes overloaded */
  "node:overloaded": (nodeId: string, metrics: NodeLoadMetrics) => void;
  /** Emitted when a node recovers from overload */
  "node:recovered": (nodeId: string, metrics: NodeLoadMetrics) => void;
  /** Emitted when migration is suggested */
  "migration:suggested": (request: MigrationRequest) => void;
  /** Emitted when fleet health changes significantly */
  "fleet:health": (summary: FleetHealthSummary) => void;
}

/** Node state tracked by the load balancer */
interface NodeState {
  manifest: NodeManifest;
  metrics: NodeLoadMetrics | null;
  metricsAge: number;
  isOverloaded: boolean;
  sessions: Set<string>;
}

// ============================================================
// FederationLoadBalancer Class
// ============================================================

export class FederationLoadBalancer extends EventEmitter {
  private nodes = new Map<string, NodeState>();
  private config: Required<LoadBalancerConfig>;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastHealthSummary: FleetHealthSummary | null = null;

  constructor(config: LoadBalancerConfig = {}) {
    super();
    this.config = {
      overloadThreshold: config.overloadThreshold ?? 80,
      migrationThreshold: config.migrationThreshold ?? 20,
      metricsIntervalMs: config.metricsIntervalMs ?? 15000,
      metricsStaleMs: config.metricsStaleMs ?? 60000,
      weights: {
        cpu: config.weights?.cpu ?? 0.3,
        memory: config.weights?.memory ?? 0.25,
        gpu: config.weights?.gpu ?? 0.2,
        sessions: config.weights?.sessions ?? 0.15,
        pending: config.weights?.pending ?? 0.1,
      },
    };
  }

  // ==========================================================================
  // Node Registration
  // ==========================================================================

  /**
   * Register a node with the load balancer.
   */
  registerNode(manifest: NodeManifest): void {
    const existing = this.nodes.get(manifest.id);
    if (existing) {
      // Update manifest, keep metrics
      existing.manifest = manifest;
      log.debug(`updated node registration: ${manifest.name} (${manifest.id})`);
    } else {
      this.nodes.set(manifest.id, {
        manifest,
        metrics: null,
        metricsAge: 0,
        isOverloaded: false,
        sessions: new Set(),
      });
      log.info(`registered node: ${manifest.name} (${manifest.id})`);
    }
  }

  /**
   * Unregister a node from the load balancer.
   */
  unregisterNode(nodeId: string): boolean {
    const removed = this.nodes.delete(nodeId);
    if (removed) {
      log.info(`unregistered node: ${nodeId}`);
    }
    return removed;
  }

  /**
   * Get all registered nodes.
   */
  getNodes(): NodeManifest[] {
    return [...this.nodes.values()].map((s) => s.manifest);
  }

  // ==========================================================================
  // Metrics Updates
  // ==========================================================================

  /**
   * Update metrics for a node.
   */
  updateMetrics(nodeId: string, metrics: Partial<NodeLoadMetrics>): void {
    const state = this.nodes.get(nodeId);
    if (!state) {
      log.warn(`received metrics for unknown node: ${nodeId}`);
      return;
    }

    // Merge with existing metrics or create new
    const now = Date.now();
    const fullMetrics: NodeLoadMetrics = {
      nodeId,
      timestamp: now,
      cpuPercent: metrics.cpuPercent ?? state.metrics?.cpuPercent ?? 0,
      memoryPercent: metrics.memoryPercent ?? state.metrics?.memoryPercent ?? 0,
      gpuPercent: metrics.gpuPercent ?? state.metrics?.gpuPercent,
      gpuMemoryPercent: metrics.gpuMemoryPercent ?? state.metrics?.gpuMemoryPercent,
      activeSessions: metrics.activeSessions ?? state.metrics?.activeSessions ?? 0,
      pendingTasks: metrics.pendingTasks ?? state.metrics?.pendingTasks ?? 0,
      loadScore: 0, // Will be calculated
    };

    // Calculate load score
    fullMetrics.loadScore =
      metrics.loadScore ?? calculateLoadScore(fullMetrics, this.config.weights);

    state.metrics = fullMetrics;
    state.metricsAge = now;

    // Update manifest with load info
    state.manifest.currentLoad = fullMetrics.loadScore;
    state.manifest.activeSessions = fullMetrics.activeSessions;
    state.manifest.lastSeenMs = now;

    // Check for overload state changes
    const wasOverloaded = state.isOverloaded;
    state.isOverloaded = fullMetrics.loadScore >= this.config.overloadThreshold;

    if (state.isOverloaded && !wasOverloaded) {
      log.warn(`node ${nodeId} became overloaded: loadScore=${fullMetrics.loadScore}`);
      this.emit("node:overloaded", nodeId, fullMetrics);
    } else if (!state.isOverloaded && wasOverloaded) {
      log.info(`node ${nodeId} recovered from overload: loadScore=${fullMetrics.loadScore}`);
      this.emit("node:recovered", nodeId, fullMetrics);
    }

    log.debug(
      `updated metrics for ${nodeId}: cpu=${fullMetrics.cpuPercent}%, mem=${fullMetrics.memoryPercent}%, ` +
        `load=${fullMetrics.loadScore}, sessions=${fullMetrics.activeSessions}`,
    );
  }

  /**
   * Get current load score for a node.
   * Returns 100 (max load) if no metrics available.
   */
  getLoadScore(nodeId: string): number {
    const state = this.nodes.get(nodeId);
    if (!state) return 100;
    if (!state.metrics) return 50; // Default to medium if no metrics

    // Check if metrics are stale
    if (Date.now() - state.metricsAge > this.config.metricsStaleMs) {
      return 75; // Stale metrics - assume moderately loaded
    }

    return state.metrics.loadScore;
  }

  /**
   * Get metrics for a node.
   */
  getMetrics(nodeId: string): NodeLoadMetrics | null {
    return this.nodes.get(nodeId)?.metrics ?? null;
  }

  /**
   * Get all current metrics.
   */
  getAllMetrics(): NodeLoadMetrics[] {
    const metrics: NodeLoadMetrics[] = [];
    for (const state of this.nodes.values()) {
      if (state.metrics) {
        metrics.push(state.metrics);
      }
    }
    return metrics;
  }

  // ==========================================================================
  // Node Selection
  // ==========================================================================

  /**
   * Select the least loaded node from a list of capable nodes.
   *
   * @param capableNodes - Nodes that meet capability requirements
   * @param minCapabilities - Optional capability filters
   * @returns Node ID of the least loaded node, or null if none available
   */
  selectLeastLoadedNode(capableNodes: NodeManifest[], minCapabilities?: string[]): string | null {
    if (capableNodes.length === 0) return null;

    // Filter by capabilities if specified
    let candidates = capableNodes;
    if (minCapabilities && minCapabilities.length > 0) {
      candidates = capableNodes.filter((node) => {
        const caps = node.capabilities;
        return minCapabilities.every((cap) => {
          switch (cap) {
            case "gpu":
              return !!caps.gpu;
            case "ollama":
              return caps.hasOllama;
            case "voice":
              return caps.hasVoice;
            case "comfyui":
              return caps.hasComfyUI;
            default:
              return caps.mcpServers?.includes(cap) ?? false;
          }
        });
      });
    }

    if (candidates.length === 0) return null;

    // Score each candidate
    const scored = candidates.map((node) => ({
      nodeId: node.id,
      loadScore: this.getLoadScore(node.id),
      isOnline: this.isNodeOnline(node.id),
    }));

    // Filter out offline nodes
    const online = scored.filter((s) => s.isOnline);
    if (online.length === 0) {
      // All nodes offline - return first capable node
      return candidates[0].id;
    }

    // Sort by load score (ascending = least loaded first)
    online.sort((a, b) => a.loadScore - b.loadScore);

    const selected = online[0];
    log.debug(
      `selected least loaded node: ${selected.nodeId} (load=${selected.loadScore}) ` +
        `from ${online.length} candidates`,
    );

    return selected.nodeId;
  }

  /**
   * Check if a node should be avoided due to high load.
   */
  shouldAvoidNode(nodeId: string): boolean {
    const state = this.nodes.get(nodeId);
    if (!state) return true;
    return state.isOverloaded;
  }

  /**
   * Check if a node is considered online (has recent metrics).
   */
  isNodeOnline(nodeId: string): boolean {
    const state = this.nodes.get(nodeId);
    if (!state) return false;

    // Check if we have recent metrics or manifest update
    const now = Date.now();
    const lastSeen = state.manifest.lastSeenMs ?? 0;
    const metricsAge = state.metricsAge;

    const threshold = this.config.metricsStaleMs * 2; // 2x stale threshold
    return now - lastSeen < threshold || now - metricsAge < threshold;
  }

  // ==========================================================================
  // Migration Suggestions
  // ==========================================================================

  /**
   * Check if a specific node needs migration due to overload.
   */
  shouldMigrate(nodeId: string): boolean {
    const state = this.nodes.get(nodeId);
    if (!state || !state.isOverloaded) return false;

    // Check if there's a significantly less loaded node available
    const leastLoadedScore = this.findLeastLoadedScore();
    if (leastLoadedScore === null) return false;

    const currentLoad = this.getLoadScore(nodeId);
    const loadDiff = currentLoad - leastLoadedScore;

    return loadDiff >= this.config.migrationThreshold;
  }

  /**
   * Suggest migrations for overloaded nodes.
   * Returns a list of migration requests sorted by priority.
   */
  suggestMigrations(): MigrationRequest[] {
    const migrations: MigrationRequest[] = [];

    for (const [nodeId, state] of this.nodes) {
      if (!state.isOverloaded) continue;
      if (state.sessions.size === 0) continue;

      // Find target node for migration
      const targetId = this.findMigrationTarget(nodeId);
      if (!targetId) continue;

      const loadDiff = this.getLoadScore(nodeId) - this.getLoadScore(targetId);

      // Create migration requests for sessions on this node
      for (const sessionKey of state.sessions) {
        const priority = this.getMigrationPriority(state.metrics?.loadScore ?? 0);

        migrations.push({
          sessionKey,
          sourceNodeId: nodeId,
          targetNodeId: targetId,
          reason: `Node overloaded (load=${state.metrics?.loadScore}%), migrating to ${targetId} (diff=${loadDiff}%)`,
          priority,
        });
      }
    }

    // Sort by priority (high first)
    migrations.sort((a, b) => {
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    // Emit events for suggested migrations
    for (const migration of migrations) {
      this.emit("migration:suggested", migration);
    }

    return migrations;
  }

  /**
   * Find the best target node for migration from a source node.
   */
  private findMigrationTarget(sourceNodeId: string): string | null {
    let bestTarget: string | null = null;
    let bestScore = Infinity;

    for (const [nodeId, state] of this.nodes) {
      if (nodeId === sourceNodeId) continue;
      if (!this.isNodeOnline(nodeId)) continue;
      if (state.isOverloaded) continue;

      const score = this.getLoadScore(nodeId);
      if (score < bestScore) {
        bestScore = score;
        bestTarget = nodeId;
      }
    }

    return bestTarget;
  }

  /**
   * Find the lowest load score in the fleet.
   */
  private findLeastLoadedScore(): number | null {
    let minScore: number | null = null;

    for (const [nodeId, state] of this.nodes) {
      if (!this.isNodeOnline(nodeId)) continue;

      const score = this.getLoadScore(nodeId);
      if (minScore === null || score < minScore) {
        minScore = score;
      }
    }

    return minScore;
  }

  /**
   * Determine migration priority based on load score.
   */
  private getMigrationPriority(loadScore: number): "low" | "normal" | "high" {
    if (loadScore >= 95) return "high";
    if (loadScore >= 90) return "normal";
    return "low";
  }

  // ==========================================================================
  // Session Tracking
  // ==========================================================================

  /**
   * Track that a session is on a specific node.
   */
  trackSession(nodeId: string, sessionKey: string): void {
    const state = this.nodes.get(nodeId);
    if (state) {
      state.sessions.add(sessionKey);
    }
  }

  /**
   * Remove session tracking when session ends or migrates.
   */
  untrackSession(nodeId: string, sessionKey: string): void {
    const state = this.nodes.get(nodeId);
    if (state) {
      state.sessions.delete(sessionKey);
    }
  }

  /**
   * Move session tracking from one node to another.
   */
  moveSession(sessionKey: string, fromNodeId: string, toNodeId: string): void {
    this.untrackSession(fromNodeId, sessionKey);
    this.trackSession(toNodeId, sessionKey);
  }

  /**
   * Get all sessions tracked on a node.
   */
  getNodeSessions(nodeId: string): string[] {
    const state = this.nodes.get(nodeId);
    return state ? [...state.sessions] : [];
  }

  // ==========================================================================
  // Fleet Health
  // ==========================================================================

  /**
   * Get a summary of fleet-wide health.
   */
  getFleetHealth(): FleetHealthSummary {
    const nodeMetrics: NodeLoadMetrics[] = [];
    let totalLoad = 0;
    let reportingCount = 0;
    let overloadedCount = 0;
    let totalSessions = 0;
    let onlineCount = 0;

    for (const [nodeId, state] of this.nodes) {
      if (this.isNodeOnline(nodeId)) {
        onlineCount++;
      }

      if (state.metrics) {
        nodeMetrics.push(state.metrics);
        totalLoad += state.metrics.loadScore;
        reportingCount++;
        totalSessions += state.metrics.activeSessions;
      }

      if (state.isOverloaded) {
        overloadedCount++;
      }
    }

    const suggestedMigrations = this.suggestMigrations();

    const summary: FleetHealthSummary = {
      totalNodes: this.nodes.size,
      onlineNodes: onlineCount,
      reportingNodes: reportingCount,
      averageLoad: reportingCount > 0 ? Math.round(totalLoad / reportingCount) : 0,
      overloadedNodes: overloadedCount,
      totalActiveSessions: totalSessions,
      nodeMetrics,
      suggestedMigrations,
      timestamp: Date.now(),
    };

    this.lastHealthSummary = summary;
    return summary;
  }

  /**
   * Start periodic health checks.
   */
  startHealthChecks(intervalMs?: number): void {
    if (this.healthCheckInterval) return;

    const interval = intervalMs ?? this.config.metricsIntervalMs * 2;

    this.healthCheckInterval = setInterval(() => {
      const health = this.getFleetHealth();
      this.emit("fleet:health", health);
    }, interval);

    this.healthCheckInterval.unref();
    log.info(`started fleet health checks, interval: ${interval}ms`);
  }

  /**
   * Stop periodic health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      log.info("stopped fleet health checks");
    }
  }

  /**
   * Get the last health summary without recalculating.
   */
  getLastHealthSummary(): FleetHealthSummary | null {
    return this.lastHealthSummary;
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let defaultLoadBalancer: FederationLoadBalancer | null = null;

/**
 * Get the default load balancer instance.
 */
export function getLoadBalancer(): FederationLoadBalancer | null {
  return defaultLoadBalancer;
}

/**
 * Initialize the default load balancer.
 */
export function initLoadBalancer(config?: LoadBalancerConfig): FederationLoadBalancer {
  if (defaultLoadBalancer) {
    defaultLoadBalancer.stopHealthChecks();
  }
  defaultLoadBalancer = new FederationLoadBalancer(config);
  return defaultLoadBalancer;
}

/**
 * Get or create the default load balancer.
 */
export function ensureLoadBalancer(config?: LoadBalancerConfig): FederationLoadBalancer {
  if (!defaultLoadBalancer) {
    defaultLoadBalancer = new FederationLoadBalancer(config);
  }
  return defaultLoadBalancer;
}
