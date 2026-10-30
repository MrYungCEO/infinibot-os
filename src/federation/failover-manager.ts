/**
 * Failover Manager
 * 
 * Automatically recovers sessions when a satellite node fails.
 * Handles detection, recovery attempt orchestration, and notification.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  FailoverConfig,
  FailoverResult,
  FailoverAttempt,
  FailoverNotification,
  SessionFailoverState,
  FailoverRecoveryMode,
  SessionSpawnRequest,
  SessionHandle,
  NodeManifest,
  RequiredCapability,
} from "./types.js";
import { DEFAULT_FAILOVER_CONFIG } from "./types.js";
import type { ComputeRouter } from "./router.js";
import type { FederationLoadBalancer } from "./load-balancer.js";

const log = createSubsystemLogger("federation").child("failover");

/** Events emitted by the failover manager */
export interface FailoverManagerEvents {
  "failover.started": (sessionKey: string, failedNodeId: string) => void;
  "failover.success": (sessionKey: string, newSessionKey: string, targetNodeId: string) => void;
  "failover.failure": (sessionKey: string, error: string) => void;
  "session.tracked": (sessionKey: string, nodeId: string) => void;
  "session.untracked": (sessionKey: string, nodeId: string) => void;
}

/**
 * Manages automatic failover of sessions when nodes fail.
 */
export class FailoverManager extends EventEmitter {
  private config: Required<FailoverConfig>;
  private trackedSessions = new Map<string, SessionFailoverState>();
  private activeFailovers = new Map<string, Promise<FailoverResult>>();
  private router: ComputeRouter;
  private loadBalancer: FederationLoadBalancer;
  private getConnectedNodes: () => NodeManifest[];
  private spawnSession: (request: SessionSpawnRequest) => Promise<SessionHandle>;
  private notifySession: (nodeId: string, sessionKey: string, notification: FailoverNotification) => Promise<void>;

  constructor(options: {
    config?: Partial<FailoverConfig>;
    router: ComputeRouter;
    loadBalancer: FederationLoadBalancer;
    getConnectedNodes: () => NodeManifest[];
    spawnSession: (request: SessionSpawnRequest) => Promise<SessionHandle>;
    notifySession: (nodeId: string, sessionKey: string, notification: FailoverNotification) => Promise<void>;
  }) {
    super();

    this.config = { ...DEFAULT_FAILOVER_CONFIG, ...options.config } as Required<FailoverConfig>;
    this.router = options.router;
    this.loadBalancer = options.loadBalancer;
    this.getConnectedNodes = options.getConnectedNodes;
    this.spawnSession = options.spawnSession;
    this.notifySession = options.notifySession;

    log.info("failover manager initialized", { config: this.config });
  }

  /**
   * Track a session for failover monitoring.
   */
  trackSession(
    sessionKey: string,
    nodeId: string,
    originalRequest: SessionSpawnRequest,
    recoveryMode: FailoverRecoveryMode = this.config.defaultRecoveryMode
  ): void {
    if (!this.config.enabled) return;

    const state: SessionFailoverState = {
      originalSessionKey: sessionKey,
      runId: randomUUID(),
      originalNodeId: nodeId,
      task: originalRequest.task,
      agentId: originalRequest.agentId,
      workspace: originalRequest.workspace,
      model: originalRequest.model,
      metadata: originalRequest.metadata,
      recoveryMode,
      attemptCount: 0,
      startedAt: Date.now(),
      requiredCapabilities: originalRequest.requiredCapabilities,
      preferredCapabilities: originalRequest.preferredCapabilities,
      originalRequest,
    };

    this.trackedSessions.set(sessionKey, state);
    this.emit("session.tracked", sessionKey, nodeId);
    
    log.debug(`tracking session ${sessionKey} on node ${nodeId}`, { 
      agentId: state.agentId,
      task: state.task.substring(0, 100) + "...",
      recoveryMode 
    });
  }

  /**
   * Stop tracking a session (called when session completes normally).
   */
  untrackSession(sessionKey: string): void {
    const state = this.trackedSessions.get(sessionKey);
    if (state) {
      this.trackedSessions.delete(sessionKey);
      this.emit("session.untracked", sessionKey, state.originalNodeId);
      log.debug(`stopped tracking session ${sessionKey}`);
    }
  }

  /**
   * Update session checkpoint data for resume capability.
   */
  updateSessionCheckpoint(sessionKey: string, checkpointData: Record<string, unknown>): void {
    const state = this.trackedSessions.get(sessionKey);
    if (state) {
      state.lastCheckpoint = {
        timestamp: Date.now(),
        data: checkpointData,
      };
      log.debug(`updated checkpoint for session ${sessionKey}`);
    }
  }

  /**
   * Handle node failure - attempt to recover all sessions from the failed node.
   */
  async handleNodeFailure(failedNodeId: string, failureReason: string): Promise<void> {
    if (!this.config.enabled) {
      log.info(`failover disabled, not recovering sessions from failed node ${failedNodeId}`);
      return;
    }

    // Find all sessions on the failed node
    const failedSessions = Array.from(this.trackedSessions.values())
      .filter(state => state.originalNodeId === failedNodeId);

    if (failedSessions.length === 0) {
      log.info(`no tracked sessions found on failed node ${failedNodeId}`);
      return;
    }

    log.warn(`node ${failedNodeId} failed (${failureReason}), attempting to recover ${failedSessions.length} sessions`);

    // Attempt recovery for each session
    const recoveryPromises = failedSessions.map(state => 
      this.recoverSession(state, failedNodeId, failureReason)
    );

    // Wait for all recoveries to complete (but don't fail if some fail)
    const results = await Promise.allSettled(recoveryPromises);
    
    let successful = 0;
    let failed = 0;
    
    results.forEach((result, index) => {
      const sessionKey = failedSessions[index].originalSessionKey;
      if (result.status === "fulfilled" && result.value.success) {
        successful++;
        log.info(`successfully recovered session ${sessionKey}`);
      } else {
        failed++;
        const error = result.status === "rejected" ? result.reason : result.value.error;
        log.error(`failed to recover session ${sessionKey}: ${error}`);
      }
    });

    log.info(`failover completed for node ${failedNodeId}: ${successful} successful, ${failed} failed`);
  }

  /**
   * Attempt to recover a single session.
   */
  private async recoverSession(
    state: SessionFailoverState,
    failedNodeId: string,
    failureReason: string
  ): Promise<FailoverResult> {
    const sessionKey = state.originalSessionKey;
    
    // Check if we're already attempting failover for this session
    const existingFailover = this.activeFailovers.get(sessionKey);
    if (existingFailover) {
      log.debug(`failover already in progress for session ${sessionKey}`);
      return existingFailover;
    }

    // Start failover attempt
    const failoverPromise = this.doRecoverSession(state, failedNodeId, failureReason);
    this.activeFailovers.set(sessionKey, failoverPromise);

    try {
      const result = await failoverPromise;
      return result;
    } finally {
      this.activeFailovers.delete(sessionKey);
    }
  }

  /**
   * Internal recovery implementation.
   */
  private async doRecoverSession(
    state: SessionFailoverState,
    failedNodeId: string,
    failureReason: string
  ): Promise<FailoverResult> {
    const startTime = Date.now();
    const sessionKey = state.originalSessionKey;
    const attempts: FailoverAttempt[] = [];

    // Check if we've exceeded max attempts
    if (state.attemptCount >= this.config.maxAttempts) {
      const error = `Maximum failover attempts (${this.config.maxAttempts}) exceeded`;
      log.error(`${error} for session ${sessionKey}`);
      
      await this.sendFailoverNotification(state, "failover.failure", {
        error,
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error,
        recoveryMode: state.recoveryMode,
        durationMs: Date.now() - startTime,
        attempts,
      };
    }

    // Emit failover started event
    this.emit("failover.started", sessionKey, failedNodeId);
    
    await this.sendFailoverNotification(state, "failover.started", {
      durationMs: Date.now() - startTime,
    });

    // Increment attempt count
    state.attemptCount++;

    // Wait for initial delay before attempting recovery
    if (this.config.failoverDelayMs > 0) {
      log.debug(`waiting ${this.config.failoverDelayMs}ms before failover attempt`);
      await new Promise(resolve => setTimeout(resolve, this.config.failoverDelayMs));
    }

    // Find a suitable target node
    const targetNodeId = this.selectRecoveryNode(state, failedNodeId);
    if (!targetNodeId) {
      const error = "No suitable nodes available for recovery";
      log.error(`${error} for session ${sessionKey}`);
      
      await this.sendFailoverNotification(state, "failover.failure", {
        error,
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error,
        recoveryMode: state.recoveryMode,
        durationMs: Date.now() - startTime,
        attempts,
      };
    }

    // Create recovery attempt record
    const attempt: FailoverAttempt = {
      attemptId: randomUUID(),
      sessionKey,
      failedNodeId,
      targetNodeId,
      recoveryMode: state.recoveryMode,
      attemptNumber: state.attemptCount,
      startedAt: Date.now(),
    };
    attempts.push(attempt);

    log.info(`attempting failover of session ${sessionKey} from ${failedNodeId} to ${targetNodeId}`, {
      recoveryMode: state.recoveryMode,
      attemptNumber: state.attemptCount,
    });

    try {
      // Build recovery request based on recovery mode
      const recoveryRequest = this.buildRecoveryRequest(state, targetNodeId);
      
      // Spawn the recovered session
      const newSession = await this.spawnSession(recoveryRequest);
      
      attempt.completedAt = Date.now();
      attempt.success = true;
      attempt.newSessionKey = newSession.sessionKey;
      attempt.durationMs = attempt.completedAt - attempt.startedAt;

      // Update tracking to new session
      const newState: SessionFailoverState = {
        ...state,
        originalSessionKey: newSession.sessionKey,
        originalNodeId: targetNodeId,
        runId: newSession.runId,
      };
      
      this.trackedSessions.delete(sessionKey);
      this.trackedSessions.set(newSession.sessionKey, newState);

      // Emit success event
      this.emit("failover.success", sessionKey, newSession.sessionKey, targetNodeId);
      
      await this.sendFailoverNotification(state, "failover.success", {
        newSessionKey: newSession.sessionKey,
        recoveryNodeId: targetNodeId,
        durationMs: Date.now() - startTime,
      });

      log.info(`successfully failed over session ${sessionKey} to ${newSession.sessionKey} on ${targetNodeId}`);

      return {
        success: true,
        newSessionKey: newSession.sessionKey,
        targetNodeId,
        recoveryMode: state.recoveryMode,
        durationMs: Date.now() - startTime,
        attempts,
      };

    } catch (error) {
      attempt.completedAt = Date.now();
      attempt.success = false;
      attempt.error = error instanceof Error ? error.message : String(error);
      attempt.durationMs = attempt.completedAt - attempt.startedAt;

      const errorMessage = `Failover attempt failed: ${attempt.error}`;
      log.error(`${errorMessage} for session ${sessionKey}`);

      // Emit failure event
      this.emit("failover.failure", sessionKey, errorMessage);
      
      await this.sendFailoverNotification(state, "failover.failure", {
        error: errorMessage,
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error: errorMessage,
        recoveryMode: state.recoveryMode,
        durationMs: Date.now() - startTime,
        attempts,
      };
    }
  }

  /**
   * Select the best node for recovery based on capabilities and load.
   */
  private selectRecoveryNode(state: SessionFailoverState, excludeNodeId: string): string | null {
    const connectedNodes = this.getConnectedNodes();
    const availableNodes = connectedNodes.filter(node => node.id !== excludeNodeId);

    if (availableNodes.length === 0) {
      return null;
    }

    // If we have capability requirements, use the capability router
    if (state.requiredCapabilities && state.requiredCapabilities.length > 0) {
      const capableNodes = availableNodes.filter(node => {
        return this.nodeHasCapabilities(node, state.requiredCapabilities!);
      });

      if (capableNodes.length === 0) {
        log.warn("no nodes found with required capabilities for recovery", {
          requiredCapabilities: state.requiredCapabilities,
        });
        return null;
      }

      // Select least loaded from capable nodes
      return this.loadBalancer.selectLeastLoadedNode(capableNodes);
    }

    // If preferring similar capabilities, try to find nodes with similar capabilities to the original
    if (this.config.preferSimilarCapabilities && state.preferredCapabilities) {
      const similarNodes = availableNodes.filter(node => {
        return this.nodeHasCapabilities(node, state.preferredCapabilities!);
      });

      if (similarNodes.length > 0) {
        return this.loadBalancer.selectLeastLoadedNode(similarNodes);
      }
    }

    // Fall back to least loaded available node
    return this.loadBalancer.selectLeastLoadedNode(availableNodes);
  }

  /**
   * Check if a node has the required capabilities.
   */
  private nodeHasCapabilities(node: NodeManifest, capabilities: RequiredCapability[]): boolean {
    for (const capability of capabilities) {
      switch (capability) {
        case "gpu":
          if (!node.capabilities.gpu || !node.capabilities.gpuVRAM) return false;
          break;
        case "ollama":
          if (!node.capabilities.hasOllama) return false;
          break;
        case "voice":
          if (!node.capabilities.hasVoice) return false;
          break;
        case "comfyui":
          if (!node.capabilities.hasComfyUI) return false;
          break;
        case "ffmpeg":
          if (!node.capabilities.ffmpeg?.available) return false;
          break;
        case "workspace":
          // This would need workspace-specific checking
          break;
        default:
          // Check if it's an MCP server
          if (!node.capabilities.mcpServers.includes(capability)) return false;
      }
    }
    return true;
  }

  /**
   * Build a recovery request based on the recovery mode.
   */
  private buildRecoveryRequest(state: SessionFailoverState, targetNodeId: string): SessionSpawnRequest {
    const baseRequest: SessionSpawnRequest = {
      ...state.originalRequest,
      nodeId: targetNodeId,
    };

    switch (state.recoveryMode) {
      case "restart":
        // Restart from beginning - use original request as-is
        return {
          ...baseRequest,
          label: `${baseRequest.label || "Recovered"} (Restart)`,
        };

      case "resume":
        // Resume from checkpoint if available
        return {
          ...baseRequest,
          label: `${baseRequest.label || "Recovered"} (Resume)`,
          metadata: {
            ...baseRequest.metadata,
            failoverResume: true,
            lastCheckpoint: state.lastCheckpoint,
            originalSessionKey: state.originalSessionKey,
          },
        };

      case "abort":
        // This shouldn't be called for abort mode
        throw new Error("Cannot build recovery request for abort mode");

      default:
        return baseRequest;
    }
  }

  /**
   * Send a failover notification to the originating session.
   */
  private async sendFailoverNotification(
    state: SessionFailoverState,
    type: FailoverNotification["type"],
    data: Partial<FailoverNotification>
  ): Promise<void> {
    try {
      const notification: FailoverNotification = {
        type,
        originalSessionKey: state.originalSessionKey,
        failedNodeId: state.originalNodeId,
        recoveryMode: state.recoveryMode,
        ...data,
      };

      // Note: In a real implementation, we would need to track the originating session
      // and send the notification there. For now, we'll emit it as an event.
      this.emit("failover.notification", notification);
      
    } catch (error) {
      log.error("failed to send failover notification", { error, sessionKey: state.originalSessionKey });
    }
  }

  /**
   * Get statistics about tracked sessions and failover attempts.
   */
  getStats(): {
    trackedSessions: number;
    activeFailovers: number;
    sessionsByNode: Record<string, number>;
    config: Required<FailoverConfig>;
  } {
    const sessionsByNode: Record<string, number> = {};
    
    for (const state of this.trackedSessions.values()) {
      sessionsByNode[state.originalNodeId] = (sessionsByNode[state.originalNodeId] || 0) + 1;
    }

    return {
      trackedSessions: this.trackedSessions.size,
      activeFailovers: this.activeFailovers.size,
      sessionsByNode,
      config: this.config,
    };
  }

  /**
   * Get tracked session state for debugging.
   */
  getTrackedSession(sessionKey: string): SessionFailoverState | null {
    return this.trackedSessions.get(sessionKey) || null;
  }

  /**
   * Update failover configuration.
   */
  updateConfig(newConfig: Partial<FailoverConfig>): void {
    this.config = { ...this.config, ...newConfig };
    log.info("failover configuration updated", { config: this.config });
  }
}