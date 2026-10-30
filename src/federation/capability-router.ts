/**
 * Capability-Based Auto-Routing
 *
 * Routes spawns to the best node based on explicitly required capabilities.
 * Complements the existing pattern-based routing with precise capability matching.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  NodeManifest,
  AlternativeNode,
  EnhancedRoutingDecision,
  ComputeRequirements,
  NodeLoadMetrics,
} from "./types.js";
import { getHealthTracker, type HealthScore } from "./health-tracker.js";

const log = createSubsystemLogger("federation").child("capability-router");

// ============================================================
// Capability Types
// ============================================================

/**
 * Standard capabilities that can be required for spawns.
 */
export type RequiredCapability =
  | "gpu" // GPU acceleration (image gen, ML)
  | "ollama" // Ollama LLM inference
  | "voice" // Voice/audio processing
  | "comfyui" // ComfyUI image generation
  | "ffmpeg" // Video/audio processing
  | "workspace" // Specific workspace access
  | string; // Custom MCP server names

/**
 * Capability requirements for a spawn request.
 */
export interface CapabilityRequirements {
  /** Hard requirements - node MUST have these capabilities */
  required: RequiredCapability[];
  /** Soft preferences - node SHOULD have these capabilities (scoring bonus) */
  preferred?: RequiredCapability[];
  /** Minimum GPU VRAM in GB (if GPU required) */
  minGpuVRAM?: number;
  /** Specific workspace path required */
  workspace?: string;
  /** Preferred node by ID or name */
  preferNode?: string;
}

/**
 * Scoring breakdown for transparency.
 */
export interface CapabilityScore {
  /** Base score for available capabilities */
  baseScore: number;
  /** Bonus for meeting hard requirements */
  requirementBonus: number;
  /** Bonus for meeting soft preferences */
  preferenceBonus: number;
  /** Penalty for high load */
  loadPenalty: number;
  /** Resource utilization penalty (CPU, RAM, GPU) */
  resourcePenalty: number;
  /** Bonus for node preference */
  nodePenalty: number;
  /** Health score bonus/penalty (0-100 scaled to -50 to +25) */
  healthBonus: number;
  /** Final computed score */
  finalScore: number;
  /** Capabilities this node is missing */
  missingCapabilities: RequiredCapability[];
  /** Reason for score/selection */
  reason: string;
  /** Node health score (if available) */
  healthScore?: HealthScore;
  /** Detailed resource breakdown */
  resourceBreakdown?: {
    cpuPenalty: number;
    memoryPenalty: number;
    gpuPenalty: number;
    sessionsPenalty: number;
    queuePenalty: number;
  };
}

// ============================================================
// Capability Matcher
// ============================================================

/**
 * Check if a node has a specific capability.
 */
function nodeHasCapability(node: NodeManifest, capability: RequiredCapability): boolean {
  const caps = node.capabilities;

  switch (capability) {
    case "gpu":
      return !!caps.gpu && (caps.gpuVRAM || 0) > 0;

    case "ollama":
      return caps.hasOllama;

    case "voice":
      return caps.hasVoice;

    case "comfyui":
      return caps.hasComfyUI;

    case "ffmpeg":
      return caps.ffmpeg?.available || false;

    case "workspace":
      // Workspace capability handled separately via workspace param
      return true;

    default:
      // Check if it's an MCP server
      return caps.mcpServers.includes(capability);
  }
}

/**
 * Get missing capabilities for a node.
 */
function getMissingCapabilities(
  node: NodeManifest,
  requirements: CapabilityRequirements,
): RequiredCapability[] {
  const missing: RequiredCapability[] = [];

  // Check hard requirements
  for (const capability of requirements.required) {
    if (!nodeHasCapability(node, capability)) {
      missing.push(capability);
    }
  }

  // Check GPU VRAM requirement
  if (requirements.minGpuVRAM && requirements.required.includes("gpu")) {
    const nodeVRAM = node.capabilities.gpuVRAM || 0;
    if (nodeVRAM < requirements.minGpuVRAM) {
      missing.push(`gpu-${requirements.minGpuVRAM}gb` as RequiredCapability);
    }
  }

  // Check workspace requirement
  if (requirements.workspace) {
    const hasWorkspace = node.capabilities.workspaces.some(
      (ws) =>
        ws.toLowerCase().includes(requirements.workspace!.toLowerCase()) ||
        requirements.workspace!.toLowerCase().includes(ws.toLowerCase()),
    );
    if (!hasWorkspace) {
      missing.push("workspace" as RequiredCapability);
    }
  }

  return missing;
}

// ============================================================
// Enhanced Resource Scoring
// ============================================================

/**
 * Calculate resource-aware penalty based on detailed metrics.
 * Returns 0-100% penalty (0 = idle, 100 = fully loaded/overloaded).
 */
function calculateResourcePenalty(
  node: NodeManifest,
  nodeMetrics?: NodeLoadMetrics,
  requirements?: CapabilityRequirements,
): {
  penalty: number;
  breakdown: {
    cpuPenalty: number;
    memoryPenalty: number;
    gpuPenalty: number;
    sessionsPenalty: number;
    queuePenalty: number;
  };
} {
  const breakdown = {
    cpuPenalty: 0,
    memoryPenalty: 0,
    gpuPenalty: 0,
    sessionsPenalty: 0,
    queuePenalty: 0,
  };

  // If no detailed metrics available, fall back to currentLoad
  if (!nodeMetrics) {
    const fallbackPenalty = Math.min((node.currentLoad || 0) * 0.5, 50);
    breakdown.cpuPenalty = fallbackPenalty;
    return { penalty: fallbackPenalty, breakdown };
  }

  // CPU penalty: 0-30% based on CPU utilization
  // Heavy penalty for >80% CPU usage
  let cpuPenalty = 0;
  if (nodeMetrics.cpuPercent > 95) {
    cpuPenalty = 30; // Severely overloaded
  } else if (nodeMetrics.cpuPercent > 80) {
    cpuPenalty = 20; // High load
  } else if (nodeMetrics.cpuPercent > 60) {
    cpuPenalty = 10; // Medium load
  } else {
    cpuPenalty = Math.round(nodeMetrics.cpuPercent * 0.15); // Light penalty for low usage
  }
  breakdown.cpuPenalty = cpuPenalty;

  // Memory penalty: 0-25% based on RAM utilization
  let memoryPenalty = 0;
  if (nodeMetrics.memoryPercent > 90) {
    memoryPenalty = 25; // Critical memory pressure
  } else if (nodeMetrics.memoryPercent > 75) {
    memoryPenalty = 15; // High memory usage
  } else if (nodeMetrics.memoryPercent > 50) {
    memoryPenalty = 5; // Moderate usage
  }
  breakdown.memoryPenalty = memoryPenalty;

  // GPU penalty: 0-20% based on GPU utilization (if GPU is required)
  let gpuPenalty = 0;
  if (requirements?.required.includes("gpu") && nodeMetrics.gpuPercent !== undefined) {
    if (nodeMetrics.gpuPercent > 90) {
      gpuPenalty = 20; // GPU heavily loaded
    } else if (nodeMetrics.gpuPercent > 70) {
      gpuPenalty = 10; // GPU moderately loaded
    }

    // Also consider GPU memory if available
    if (nodeMetrics.gpuMemoryPercent !== undefined) {
      if (nodeMetrics.gpuMemoryPercent > 85) {
        gpuPenalty += 10; // GPU memory pressure
      }
    }
  }
  breakdown.gpuPenalty = gpuPenalty;

  // Sessions penalty: 0-15% based on active sessions
  // Exponential penalty for high session counts
  let sessionsPenalty = 0;
  if (nodeMetrics.activeSessions > 10) {
    sessionsPenalty = 15; // Too many sessions
  } else if (nodeMetrics.activeSessions > 5) {
    sessionsPenalty = 8; // Many sessions
  } else if (nodeMetrics.activeSessions > 2) {
    sessionsPenalty = 3; // Several sessions
  }
  breakdown.sessionsPenalty = sessionsPenalty;

  // Queue penalty: 0-10% based on pending tasks
  let queuePenalty = 0;
  if (nodeMetrics.pendingTasks > 5) {
    queuePenalty = 10; // Large queue backlog
  } else if (nodeMetrics.pendingTasks > 2) {
    queuePenalty = 5; // Some queue backlog
  } else if (nodeMetrics.pendingTasks > 0) {
    queuePenalty = 2; // Small queue
  }
  breakdown.queuePenalty = queuePenalty;

  const totalPenalty = Math.min(
    100,
    cpuPenalty + memoryPenalty + gpuPenalty + sessionsPenalty + queuePenalty,
  );

  return { penalty: totalPenalty, breakdown };
}

// ============================================================
// Capability Scoring Algorithm
// ============================================================

/**
 * Score a node based on capability requirements.
 *
 * Scoring Algorithm:
 * - Base score: 50 points
 * - Hard requirements: +30 points each (or immediate disqualification)
 * - Soft preferences: +10 points each
 * - Resource penalty: -0 to -100 points based on detailed CPU/RAM/GPU/sessions/queue metrics
 * - Health bonus/penalty: -25 to +25 points based on node health score (0-100%)
 * - Node preference: +20 points if explicitly preferred
 * - GPU VRAM bonus: +5 points per GB above minimum
 * - Quarantine: Immediate disqualification for quarantined nodes
 */
function scoreNodeCapabilities(
  node: NodeManifest,
  requirements: CapabilityRequirements,
  nodeMetrics?: NodeLoadMetrics,
): CapabilityScore {
  const healthTracker = getHealthTracker();

  // Check if node is quarantined (immediate disqualification)
  if (healthTracker.isQuarantined(node.id)) {
    return {
      baseScore: 0,
      requirementBonus: 0,
      preferenceBonus: 0,
      loadPenalty: 0,
      resourcePenalty: 0,
      nodePenalty: 0,
      healthBonus: -100,
      finalScore: 0,
      missingCapabilities: [],
      reason: "Node is quarantined due to poor health",
      healthScore: healthTracker.getHealthScore(node.id) || undefined,
    };
  }

  const missingCapabilities = getMissingCapabilities(node, requirements);

  // If missing any hard requirements, node is disqualified
  if (missingCapabilities.length > 0) {
    return {
      baseScore: 0,
      requirementBonus: 0,
      preferenceBonus: 0,
      loadPenalty: 0,
      resourcePenalty: 0,
      nodePenalty: 0,
      healthBonus: 0,
      finalScore: 0,
      missingCapabilities,
      reason: `Missing required capabilities: ${missingCapabilities.join(", ")}`,
      healthScore: healthTracker.getHealthScore(node.id) || undefined,
    };
  }

  let score = 50; // Base score
  let requirementBonus = 0;
  let preferenceBonus = 0;
  let resourcePenalty = 0;
  let nodeBonus = 0;
  let healthBonus = 0;

  // Hard requirements bonus (30 points each)
  requirementBonus = requirements.required.length * 30;
  score += requirementBonus;

  // Soft preferences bonus (10 points each)
  if (requirements.preferred) {
    for (const pref of requirements.preferred) {
      if (nodeHasCapability(node, pref)) {
        preferenceBonus += 10;
      }
    }
    score += preferenceBonus;
  }

  // Enhanced resource penalty (0-100 points based on detailed resource metrics)
  const resourceScore = calculateResourcePenalty(node, nodeMetrics, requirements);
  resourcePenalty = resourceScore.penalty;
  score -= resourcePenalty;

  // Node preference bonus
  if (requirements.preferNode) {
    const prefersThisNode =
      node.id === requirements.preferNode ||
      node.name.toLowerCase().includes(requirements.preferNode.toLowerCase());

    if (prefersThisNode) {
      nodeBonus = 20;
      score += nodeBonus;
    }
  }

  // Health score bonus/penalty (20% weight on health)
  const nodeHealthScore = healthTracker.getHealthScore(node.id);
  if (nodeHealthScore) {
    // Convert health score (0-100) to routing bonus (-25 to +25)
    // Health < 50 = penalty, Health > 50 = bonus
    healthBonus = Math.round(((nodeHealthScore.overall - 50) / 50) * 25);
    score += healthBonus;
  }

  // GPU VRAM bonus
  if (requirements.required.includes("gpu") && requirements.minGpuVRAM) {
    const nodeVRAM = node.capabilities.gpuVRAM || 0;
    const extraVRAM = Math.max(0, nodeVRAM - requirements.minGpuVRAM);
    const vramBonus = extraVRAM * 5;
    score += vramBonus;
    requirementBonus += vramBonus; // Track in requirement bonus
  }

  const finalScore = Math.max(0, score);

  return {
    baseScore: 50,
    requirementBonus,
    preferenceBonus,
    loadPenalty: 0, // Deprecated - now using resourcePenalty
    resourcePenalty: -resourcePenalty,
    nodePenalty: nodeBonus,
    healthBonus,
    finalScore,
    missingCapabilities: [],
    reason: buildScoreReason(
      node,
      finalScore,
      requirementBonus,
      preferenceBonus,
      resourcePenalty,
      nodeBonus,
      healthBonus,
      nodeHealthScore ?? undefined,
    ),
    resourceBreakdown: resourceScore.breakdown,
    healthScore: nodeHealthScore || undefined,
  };
}

/**
 * Build human-readable reason for the score.
 */
function buildScoreReason(
  node: NodeManifest,
  finalScore: number,
  requirementBonus: number,
  preferenceBonus: number,
  resourcePenalty: number,
  nodeBonus: number,
  healthBonus: number,
  healthScore?: HealthScore,
): string {
  const reasons: string[] = [];

  if (requirementBonus > 0) {
    reasons.push(`+${requirementBonus} capabilities`);
  }

  if (preferenceBonus > 0) {
    reasons.push(`+${preferenceBonus} preferences`);
  }

  if (resourcePenalty > 0) {
    reasons.push(`-${resourcePenalty} load`);
  }

  if (nodeBonus > 0) {
    reasons.push(`+${nodeBonus} preferred`);
  }

  if (healthBonus !== 0 && healthScore) {
    if (healthBonus > 0) {
      reasons.push(`+${healthBonus} health (${healthScore.overall}%)`);
    } else {
      reasons.push(`${healthBonus} health (${healthScore.overall}%)`);
    }
  }

  const gpu = node.capabilities.gpu;
  if (gpu) {
    reasons.push(`${gpu}`);
  }

  return `${finalScore} pts (${reasons.join(", ")})`;
}

// ============================================================
// Capability Router
// ============================================================

/**
 * Route based on explicit capability requirements.
 */
export class CapabilityRouter {
  private nodeMetrics = new Map<string, NodeLoadMetrics>();

  /**
   * Update resource metrics for a node.
   */
  updateNodeMetrics(nodeId: string, metrics: NodeLoadMetrics): void {
    this.nodeMetrics.set(nodeId, metrics);
  }

  /**
   * Get current resource metrics for a node.
   */
  getNodeMetrics(nodeId: string): NodeLoadMetrics | undefined {
    return this.nodeMetrics.get(nodeId);
  }

  /**
   * Select the best node based on capability requirements.
   */
  selectBestNode(
    availableNodes: NodeManifest[],
    requirements: CapabilityRequirements,
  ): EnhancedRoutingDecision {
    if (availableNodes.length === 0) {
      throw new Error("No nodes available for capability routing");
    }

    log.debug("capability routing", {
      nodeCount: availableNodes.length,
      required: requirements.required,
      preferred: requirements.preferred,
      minGpuVRAM: requirements.minGpuVRAM,
    });

    // Score all nodes with current resource metrics
    const scoredNodes = availableNodes.map((node) => {
      const metrics = this.getNodeMetrics(node.id);
      return {
        node,
        score: scoreNodeCapabilities(node, requirements, metrics),
      };
    });

    // Sort by score (highest first)
    scoredNodes.sort((a, b) => b.score.finalScore - a.score.finalScore);

    const topNode = scoredNodes[0];

    // If no node meets requirements, return best effort with low confidence
    if (topNode.score.finalScore === 0) {
      const fallbackNode =
        scoredNodes.find((n) => n.score.missingCapabilities.length === 0) || topNode;

      log.warn("no suitable nodes found, using fallback", {
        selectedNode: fallbackNode.node.name,
        missingCapabilities: topNode.score.missingCapabilities,
      });

      return {
        nodeId: fallbackNode.node.id,
        nodeName: fallbackNode.node.name,
        confidence: 0.2,
        reason: `No ideal node available - using ${fallbackNode.node.name} as fallback`,
        alternativeNodes: this.buildAlternatives(scoredNodes.slice(1)),
        requirements: this.buildComputeRequirements(requirements),
        autoRouted: true,
        scoreBreakdown: {
          baseScore: fallbackNode.score.baseScore,
          gpuBonus: fallbackNode.score.requirementBonus,
          loadPenalty: fallbackNode.score.resourcePenalty,
          preferenceBonus: fallbackNode.score.preferenceBonus,
          mcpPenalty: 0,
          healthBonus: fallbackNode.score.healthBonus,
          finalScore: fallbackNode.score.finalScore,
        },
      };
    }

    // Calculate confidence based on score and alternatives
    const confidence = this.calculateConfidence(topNode.score, scoredNodes[1]?.score);

    log.info("capability routing decision", {
      selectedNode: topNode.node.name,
      score: topNode.score.finalScore,
      confidence,
      reason: topNode.score.reason,
      alternatives: scoredNodes.slice(1, 4).map((n) => ({
        node: n.node.name,
        score: n.score.finalScore,
      })),
    });

    return {
      nodeId: topNode.node.id,
      nodeName: topNode.node.name,
      confidence,
      reason: topNode.score.reason,
      alternativeNodes: this.buildAlternatives(scoredNodes.slice(1)),
      requirements: this.buildComputeRequirements(requirements),
      autoRouted: true,
      scoreBreakdown: {
        baseScore: topNode.score.baseScore,
        gpuBonus: topNode.score.requirementBonus,
        loadPenalty: topNode.score.resourcePenalty,
        preferenceBonus: topNode.score.preferenceBonus,
        mcpPenalty: 0,
        healthBonus: topNode.score.healthBonus,
        finalScore: topNode.score.finalScore,
      },
    };
  }

  /**
   * Calculate confidence level based on top scores.
   */
  private calculateConfidence(topScore: CapabilityScore, secondScore?: CapabilityScore): number {
    // If no alternatives, confidence based on absolute score
    if (!secondScore) {
      return Math.min(0.95, topScore.finalScore / 100);
    }

    // If there's a clear winner, high confidence
    const gap = topScore.finalScore - secondScore.finalScore;
    if (gap > 30) return 0.9;
    if (gap > 20) return 0.8;
    if (gap > 10) return 0.7;
    if (gap > 5) return 0.6;

    // Close scores, lower confidence
    return 0.5;
  }

  /**
   * Build alternative nodes list.
   */
  private buildAlternatives(
    scoredNodes: Array<{ node: NodeManifest; score: CapabilityScore }>,
  ): AlternativeNode[] {
    return scoredNodes.slice(0, 3).map(({ node, score }) => ({
      nodeId: node.id,
      nodeName: node.name,
      score: score.finalScore,
      missingCapabilities: score.missingCapabilities,
      reason: score.reason,
    }));
  }

  /**
   * Convert capability requirements to compute requirements.
   */
  private buildComputeRequirements(requirements: CapabilityRequirements): ComputeRequirements {
    return {
      needsGPU: requirements.required.includes("gpu"),
      gpuVRAM: requirements.minGpuVRAM,
      needsOllama: requirements.required.includes("ollama"),
      needsVoice: requirements.required.includes("voice"),
      needsMCP: requirements.required.filter(
        (cap) => !["gpu", "ollama", "voice", "comfyui", "ffmpeg", "workspace"].includes(cap),
      ),
      needsLocalFiles: !!requirements.workspace,
      workspace: requirements.workspace,
      computeIntensity: requirements.required.length > 2 ? "heavy" : "medium",
      preferNode: requirements.preferNode,
    };
  }
}

// ============================================================
// Factory Functions
// ============================================================

let capabilityRouter: CapabilityRouter | null = null;

/**
 * Get the capability router singleton.
 */
export function getCapabilityRouter(): CapabilityRouter {
  if (!capabilityRouter) {
    capabilityRouter = new CapabilityRouter();
  }
  return capabilityRouter;
}

/**
 * Update node metrics in the capability router.
 */
export function updateCapabilityRouterMetrics(nodeId: string, metrics: NodeLoadMetrics): void {
  const router = getCapabilityRouter();
  router.updateNodeMetrics(nodeId, metrics);
}

/**
 * Route spawn based on capabilities.
 */
export async function routeByCapabilities(
  availableNodes: NodeManifest[],
  requirements: CapabilityRequirements,
): Promise<EnhancedRoutingDecision> {
  const router = getCapabilityRouter();
  return router.selectBestNode(availableNodes, requirements);
}

/**
 * Parse capability requirements from spawn parameters.
 */
export function parseCapabilityRequirements(params: {
  requiredCapabilities?: string[];
  preferredCapabilities?: string[];
  minGpuVRAM?: number;
  workspace?: string;
  preferNode?: string;
}): CapabilityRequirements {
  return {
    required: params.requiredCapabilities || [],
    preferred: params.preferredCapabilities,
    minGpuVRAM: params.minGpuVRAM,
    workspace: params.workspace,
    preferNode: params.preferNode,
  };
}
