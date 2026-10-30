/**
 * Compute Router Integration
 * Reserved for future automatic gateway spawn/tool routing; live hub startup
 * currently wires the core router from router.ts directly.
 *
 * High-level integration layer that combines:
 * - ComputeRouter for intelligent task routing
 * - Compute manifest for capability detection
 * - Routing hooks for sessions_spawn and tool calls
 *
 * This is the main entry point for federation compute routing.
 */

import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildLocalNodeManifest,
  calculateLoadScore,
  getComputeStatus,
  startManifestRefresh,
  stopManifestRefresh,
  updateNodeManifest,
} from "./compute-manifest.js";
import { ComputeRouter, getComputeRouter, inferTaskType, initComputeRouter } from "./router.js";
import type { ComputeRequirements, NodeManifest, NodeSelection, Task } from "./types.js";

// Re-export core types and classes for convenience
export { ComputeRouter, getComputeRouter, inferTaskType, initComputeRouter } from "./router.js";

export type {
  AlternativeNode,
  ComputeRequirements,
  EnhancedRoutingDecision,
  NodeManifest,
  NodeSelection,
  Task,
  TaskType,
} from "./types.js";

const log = createSubsystemLogger("federation").child("compute-router");

// ============================================================
// Integrated Routing Service
// ============================================================

/**
 * Integrated compute routing service.
 * Manages router lifecycle and provides high-level routing APIs.
 */
export class ComputeRoutingService {
  private router: ComputeRouter;
  private localNodeId: string | null = null;
  private initialized = false;

  constructor() {
    this.router = getComputeRouter();
  }

  /**
   * Initialize the routing service.
   * Sets up local node, starts manifest refresh, and registers local capabilities.
   */
  async initialize(opts?: {
    masterId?: string;
    localNodeId?: string;
    autoRefreshMs?: number;
  }): Promise<void> {
    if (this.initialized) return;

    const cfg = loadConfig();
    const isMaster = cfg.federation?.mode === "master";
    // Node ID from options or config (will be auto-generated in buildLocalNodeManifest if not set)
    const localNodeId = opts?.localNodeId ?? cfg.federation?.nodeId;

    // Initialize the router
    initComputeRouter({
      masterId: opts?.masterId,
      localNodeId,
    });
    this.router = getComputeRouter();

    // Build and register local node manifest
    const localManifest = await buildLocalNodeManifest({
      nodeId: localNodeId,
      isMaster,
    });
    this.localNodeId = localManifest.id;
    this.router.registerNode(localManifest);
    this.router.setLocalNodeId(localManifest.id);

    // Start manifest refresh
    const refreshMs = opts?.autoRefreshMs ?? 60000;
    startManifestRefresh(refreshMs);

    // Periodically update local node status
    this.startStatusUpdates(refreshMs);

    this.initialized = true;
    log.info(`compute routing initialized`, {
      nodeId: localManifest.id,
      nodeName: localManifest.name,
      isMaster,
      gpu: localManifest.capabilities.gpu,
    });
  }

  /**
   * Start periodic status updates for the local node.
   */
  private statusInterval: NodeJS.Timeout | null = null;

  private startStatusUpdates(intervalMs: number): void {
    if (this.statusInterval) return;

    this.statusInterval = setInterval(async () => {
      if (!this.localNodeId) return;

      try {
        const loadScore = await calculateLoadScore();
        this.router.updateNodeStatus(this.localNodeId, {
          currentLoad: loadScore,
          lastSeenMs: Date.now(),
        });
      } catch (err) {
        log.error("failed to update local status", { error: err });
      }
    }, intervalMs);
  }

  /**
   * Shutdown the routing service.
   */
  shutdown(): void {
    stopManifestRefresh();
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    this.initialized = false;
  }

  // ============================================================
  // High-Level Routing APIs
  // ============================================================

  /**
   * Route a task description to the best node.
   * Creates a Task object from the description and routes it.
   */
  async routeTask(
    description: string,
    opts?: {
      taskId?: string;
      agentId?: string;
      workspace?: string;
      preferNode?: string;
    },
  ): Promise<NodeSelection> {
    const taskType = inferTaskType(description);
    const task: Task = {
      id: opts?.taskId ?? `task_${Date.now().toString(36)}`,
      type: taskType,
      description,
      agentId: opts?.agentId,
      workspace: opts?.workspace,
      metadata: opts?.preferNode ? { preferNode: opts.preferNode } : undefined,
    };

    return this.router.route(task);
  }

  /**
   * Route a sessions_spawn request.
   * Analyzes the task and returns the optimal node.
   */
  async routeSpawn(params: {
    task: string;
    agentId?: string;
    workspace?: string;
    preferNode?: string;
    model?: string;
  }): Promise<{
    nodeId: string;
    reason: string;
    confidence: number;
    isRemote: boolean;
  }> {
    const selection = await this.routeTask(params.task, {
      agentId: params.agentId,
      workspace: params.workspace,
      preferNode: params.preferNode,
    });

    const isRemote = selection.nodeId !== this.localNodeId;

    log.debug(`route spawn decision`, {
      task: params.task.slice(0, 100),
      nodeId: selection.nodeId,
      reason: selection.reason,
      isRemote,
    });

    return {
      nodeId: selection.nodeId,
      reason: selection.reason,
      confidence: selection.confidence,
      isRemote,
    };
  }

  /**
   * Route a sessions_spawn request with enhanced capability-aware routing.
   * Returns detailed decision with alternatives and reasoning.
   */
  async routeSpawnEnhanced(params: {
    task: string;
    agentId?: string;
    workspace?: string;
    preferNode?: string;
    model?: string;
  }): Promise<{
    nodeId: string;
    nodeName: string;
    reason: string;
    confidence: number;
    isRemote: boolean;
    autoRouted: boolean;
    alternatives: Array<{
      nodeId: string;
      nodeName?: string;
      score: number;
      missingCapabilities: string[];
    }>;
    requirements: {
      needsGPU: boolean;
      needsOllama: boolean;
      needsVoice: boolean;
      needsMCP: string[];
    };
  }> {
    const taskType = inferTaskType(params.task);
    const task: Task = {
      id: `spawn_${Date.now().toString(36)}`,
      type: taskType,
      description: params.task,
      agentId: params.agentId,
      workspace: params.workspace,
    };

    const decision = this.router.selectBestNodeEnhanced(task, params.preferNode);
    const isRemote = decision.nodeId !== this.localNodeId;

    log.info(`enhanced route spawn decision`, {
      task: params.task.slice(0, 100),
      nodeId: decision.nodeId,
      nodeName: decision.nodeName,
      reason: decision.reason,
      confidence: decision.confidence,
      isRemote,
      autoRouted: decision.autoRouted,
      alternatives: decision.alternativeNodes.length,
    });

    return {
      nodeId: decision.nodeId,
      nodeName: decision.nodeName,
      reason: decision.reason,
      confidence: decision.confidence,
      isRemote,
      autoRouted: decision.autoRouted,
      alternatives: decision.alternativeNodes.map((alt) => ({
        nodeId: alt.nodeId,
        nodeName: alt.nodeName,
        score: alt.score,
        missingCapabilities: alt.missingCapabilities,
      })),
      requirements: {
        needsGPU: decision.requirements.needsGPU,
        needsOllama: decision.requirements.needsOllama,
        needsVoice: decision.requirements.needsVoice,
        needsMCP: decision.requirements.needsMCP,
      },
    };
  }

  /**
   * Analyze a task description to determine routing requirements.
   * Useful for UI to show what capabilities are needed.
   */
  analyzeTaskForUI(taskDescription: string): {
    needsGPU: boolean;
    needsOllama: boolean;
    needsVoice: boolean;
    needsMCP: string[];
    suggestedNode?: {
      nodeId: string;
      nodeName: string;
      reason: string;
      confidence: number;
    };
    taskType: string;
  } {
    const taskType = inferTaskType(taskDescription);
    const task: Task = {
      id: "ui_check",
      type: taskType,
      description: taskDescription,
    };

    const requirements = this.router.analyzeTaskRequirements(task);
    const decision = this.router.selectBestNodeEnhanced(task);

    const isRemote = decision.nodeId !== this.localNodeId;

    return {
      needsGPU: requirements.needsGPU,
      needsOllama: requirements.needsOllama,
      needsVoice: requirements.needsVoice,
      needsMCP: requirements.needsMCP,
      suggestedNode:
        isRemote && decision.confidence > 0.7
          ? {
              nodeId: decision.nodeId,
              nodeName: decision.nodeName,
              reason: decision.reason,
              confidence: decision.confidence,
            }
          : undefined,
      taskType,
    };
  }

  /**
   * Check if a task needs GPU.
   */
  taskNeedsGPU(description: string): boolean {
    const taskType = inferTaskType(description);
    const task: Task = {
      id: "check",
      type: taskType,
      description,
    };
    const req = this.router.analyzeTaskRequirements(task);
    return req.needsGPU;
  }

  /**
   * Check if a task needs Ollama.
   */
  taskNeedsOllama(description: string): boolean {
    const taskType = inferTaskType(description);
    const task: Task = {
      id: "check",
      type: taskType,
      description,
    };
    const req = this.router.analyzeTaskRequirements(task);
    return req.needsOllama;
  }

  /**
   * Check if a task needs voice processing.
   */
  taskNeedsVoice(description: string): boolean {
    const taskType = inferTaskType(description);
    const task: Task = {
      id: "check",
      type: taskType,
      description,
    };
    const req = this.router.analyzeTaskRequirements(task);
    return req.needsVoice;
  }

  /**
   * Get the best GPU node.
   */
  getBestGPUNode(minVRAM = 8): NodeSelection | null {
    return this.router.selectByGPU(minVRAM);
  }

  /**
   * Get the least busy node.
   */
  getLeastBusyNode(): NodeSelection {
    return this.router.selectByLoad();
  }

  /**
   * Get node for a specific workspace.
   */
  getNodeForWorkspace(workspace: string): NodeSelection | null {
    return this.router.selectByWorkspace(workspace);
  }

  // ============================================================
  // Node Management
  // ============================================================

  /**
   * Register a remote node.
   */
  registerNode(manifest: NodeManifest): void {
    this.router.registerNode(manifest);
    updateNodeManifest(manifest.id, manifest);
  }

  /**
   * Unregister a node.
   */
  unregisterNode(nodeId: string): boolean {
    return this.router.unregisterNode(nodeId);
  }

  /**
   * Update node status.
   */
  updateNodeStatus(
    nodeId: string,
    status: { currentLoad?: number; activeSessions?: number },
  ): void {
    this.router.updateNodeStatus(nodeId, {
      ...status,
      lastSeenMs: Date.now(),
    });
  }

  /**
   * List all registered nodes.
   */
  listNodes(): NodeManifest[] {
    return this.router.listNodes();
  }

  /**
   * Get the local node ID.
   */
  getLocalNodeId(): string | null {
    return this.localNodeId;
  }

  /**
   * Get routing metrics.
   */
  getMetrics() {
    return this.router.getMetrics();
  }

  /**
   * Get the underlying router instance.
   */
  getRouter(): ComputeRouter {
    return this.router;
  }
}

// ============================================================
// Singleton Service
// ============================================================

let routingService: ComputeRoutingService | null = null;

/**
 * Get the compute routing service singleton.
 */
export function getComputeRoutingService(): ComputeRoutingService {
  if (!routingService) {
    routingService = new ComputeRoutingService();
  }
  return routingService;
}

/**
 * Initialize the compute routing service.
 */
export async function initComputeRouting(opts?: {
  masterId?: string;
  localNodeId?: string;
  autoRefreshMs?: number;
}): Promise<ComputeRoutingService> {
  const service = getComputeRoutingService();
  await service.initialize(opts);
  return service;
}

/**
 * Shutdown the compute routing service.
 */
export function shutdownComputeRouting(): void {
  if (routingService) {
    routingService.shutdown();
    routingService = null;
  }
}

// ============================================================
// Routing Hooks for Integration
// ============================================================

/**
 * Hook for sessions_spawn routing.
 * Returns null to use local execution, or node ID to route remotely.
 */
export async function routeSessionSpawn(params: {
  task: string;
  agentId?: string;
  workspace?: string;
  explicitNode?: string;
}): Promise<{
  shouldRoute: boolean;
  nodeId?: string;
  nodeName?: string;
  reason?: string;
  confidence?: number;
  alternatives?: Array<{
    nodeId: string;
    nodeName?: string;
    score: number;
    missingCapabilities: string[];
  }>;
} | null> {
  const cfg = loadConfig();

  // Skip if federation not enabled
  if (!cfg.federation?.enabled) {
    return null;
  }

  // If explicit node specified, validate and use it
  if (params.explicitNode) {
    return {
      shouldRoute: true,
      nodeId: params.explicitNode,
      reason: "explicit node parameter",
    };
  }

  // Skip auto-routing if not in master mode
  if (cfg.federation.mode !== "master") {
    return null;
  }

  // Get routing service
  const service = getComputeRoutingService();

  try {
    const result = await service.routeSpawnEnhanced({
      task: params.task,
      agentId: params.agentId,
      workspace: params.workspace,
    });

    // Only route if it's a different node
    if (result.isRemote && result.confidence > 0.7) {
      return {
        shouldRoute: true,
        nodeId: result.nodeId,
        nodeName: result.nodeName,
        reason: result.reason,
        confidence: result.confidence,
        alternatives: result.alternatives,
      };
    }

    return {
      shouldRoute: false,
      reason: "local execution preferred",
    };
  } catch (err) {
    log.error("routing hook error", { error: err });
    return null;
  }
}

/**
 * Hook for image generation routing.
 * Routes to best GPU node.
 */
export async function routeImageGen(): Promise<{
  nodeId?: string;
  reason: string;
} | null> {
  const cfg = loadConfig();

  if (!cfg.federation?.enabled) {
    return null;
  }

  const service = getComputeRoutingService();
  const gpuNode = service.getBestGPUNode(8); // Minimum 8GB VRAM

  if (gpuNode) {
    return {
      nodeId: gpuNode.nodeId,
      reason: gpuNode.reason,
    };
  }

  return {
    reason: "no GPU node available",
  };
}

/**
 * Hook for Ollama inference routing.
 * Routes to master node with Ollama.
 */
export async function routeOllamaInference(): Promise<{
  nodeId?: string;
  reason: string;
} | null> {
  const cfg = loadConfig();

  if (!cfg.federation?.enabled) {
    return null;
  }

  const service = getComputeRoutingService();
  const nodes = service.listNodes();

  // Find node with Ollama
  const ollamaNode = nodes.find((n) => n.capabilities.hasOllama);

  if (ollamaNode) {
    return {
      nodeId: ollamaNode.id,
      reason: `Ollama available on ${ollamaNode.name}`,
    };
  }

  return {
    reason: "no Ollama node available",
  };
}

/**
 * Hook for voice processing routing.
 * Routes to master node with voice capabilities.
 */
export async function routeVoiceProcessing(): Promise<{
  nodeId?: string;
  reason: string;
} | null> {
  const cfg = loadConfig();

  if (!cfg.federation?.enabled) {
    return null;
  }

  const service = getComputeRoutingService();
  const nodes = service.listNodes();

  // Find node with voice
  const voiceNode = nodes.find((n) => n.capabilities.hasVoice);

  if (voiceNode) {
    return {
      nodeId: voiceNode.id,
      reason: `Voice processing available on ${voiceNode.name}`,
    };
  }

  return {
    reason: "no voice node available",
  };
}
