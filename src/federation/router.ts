/**
 * Federation Compute Router
 *
 * Intelligent task routing based on compute requirements.
 * Routes tasks to the most appropriate node based on:
 * - GPU requirements
 * - Ollama/LLM needs
 * - Voice processing
 * - MCP server availability
 * - Local file access
 * - Current load balancing
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  AlternativeNode,
  ComputeRequirements,
  EnhancedRoutingDecision,
  NodeCapabilities,
  NodeManifest,
  NodeSelection,
  RoutingDecision,
  RoutingMetrics,
  Task,
  TaskType,
  NodeLoadMetrics,
} from "./types.js";

const log = createSubsystemLogger("federation").child("router");

// ============================================================
// Task Analysis Patterns
// ============================================================

/** Patterns that indicate GPU requirements */
const GPU_PATTERNS = [
  /\b(generate|create|make|draw|render)\b.*\b(image|picture|art|illustration|photo|portrait)/i,
  /\b(image|picture|art)\b.*\b(generation|gen|create)/i,
  /\bcomfyui\b/i,
  /\bstable\s*diffusion\b/i,
  /\bsd\s*(xl|3|turbo)\b/i,
  /\bflux\b/i,
  /\bmidjourney\b/i,
  /\bdall-?e\b/i,
  /\bimage\s*gen(eration)?\b/i,
  /\b(train|fine-?tune)\b.*\bmodel\b/i,
  /\bml\b.*\b(training|inference)\b/i,
  /\bdeep\s*learning\b/i,
  /\bneural\s*network\b/i,
];

/** Patterns that indicate Ollama/LLM inference needs */
const OLLAMA_PATTERNS = [
  /\bollama\b/i,
  /\bllama\s*\d/i,
  /\bmistral\b/i,
  /\bcodellama\b/i,
  /\bphi-?\d/i,
  /\bqwen\b/i,
  /\bdeepseek\b/i,
  /\bgemma\b/i,
  /\blocal\s*(llm|model|inference)\b/i,
  /\brun\s*(locally|on-device)\b/i,
  /\bself-?hosted\s*(llm|model)\b/i,
];

/** Patterns that indicate voice/audio processing */
const VOICE_PATTERNS = [
  /\b(speak|say|read\s*aloud|narrate|voice)\b/i,
  /\btts\b/i,
  /\btext[-\s]to[-\s]speech\b/i,
  /\belevenlabs\b/i,
  /\blivekit\b/i,
  /\bvoice\s*(call|chat|mode)\b/i,
  /\baudio\s*(processing|generation)\b/i,
  /\bspeech\s*(synthesis|recognition)\b/i,
  /\bwhisper\b/i,
  /\btranscri(be|ption)\b/i,
];

/** Patterns that indicate heavy compute */
const HEAVY_COMPUTE_PATTERNS = [
  /\b(large|huge|massive)\s*(file|dataset|codebase)\b/i,
  /\bprocess\s*(all|entire|whole)\b/i,
  /\bbatch\s*(process|operation)\b/i,
  /\b(compile|build)\s*(entire|full|whole)\b/i,
  /\brefactor\s*(entire|all|whole)\b/i,
  /\bmigrat(e|ion)\b.*\b(database|codebase)\b/i,
];

/** Task types that typically need specific capabilities */
const TASK_TYPE_REQUIREMENTS: Record<TaskType, Partial<ComputeRequirements>> = {
  image_gen: { needsGPU: true, computeIntensity: "heavy" },
  voice: { needsVoice: true, computeIntensity: "medium" },
  ollama_inference: { needsOllama: true, computeIntensity: "heavy" },
  code: { computeIntensity: "light", needsLocalFiles: true },
  file_ops: { computeIntensity: "light", needsLocalFiles: true },
  browser: { computeIntensity: "light" },
  mcp_invoke: { computeIntensity: "light" },
  research: { computeIntensity: "light" },
  chat: { computeIntensity: "light" },
  subagent: { computeIntensity: "medium" },
  unknown: { computeIntensity: "light" },
};

// ============================================================
// ComputeRouter Class
// ============================================================

export class ComputeRouter {
  private nodes = new Map<string, NodeManifest>();
  private nodeMetrics = new Map<string, NodeLoadMetrics>();
  private masterId: string | null = null;
  private localNodeId: string | null = null;
  private metrics: RoutingMetrics = {
    totalDecisions: 0,
    byNode: {},
    byReason: {},
    avgDecisionMs: 0,
  };
  private decisionLog: RoutingDecision[] = [];
  private maxDecisionLogSize = 100;

  constructor(opts?: { masterId?: string; localNodeId?: string }) {
    this.masterId = opts?.masterId ?? null;
    this.localNodeId = opts?.localNodeId ?? null;
  }

  // ============================================================
  // Node Management
  // ============================================================

  /**
   * Register a node with its capabilities.
   */
  registerNode(manifest: NodeManifest): void {
    this.nodes.set(manifest.id, manifest);
    if (manifest.isMaster) {
      this.masterId = manifest.id;
    }
    log.debug(`registered node: ${manifest.name} (${manifest.id})`);
  }

  /**
   * Unregister a node.
   */
  unregisterNode(nodeId: string): boolean {
    const removed = this.nodes.delete(nodeId);
    if (nodeId === this.masterId) {
      this.masterId = null;
      // Find another master if available
      for (const node of this.nodes.values()) {
        if (node.isMaster) {
          this.masterId = node.id;
          break;
        }
      }
    }
    return removed;
  }

  /**
   * Update node load/status.
   */
  updateNodeStatus(
    nodeId: string,
    status: { currentLoad?: number; activeSessions?: number; lastSeenMs?: number },
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (status.currentLoad !== undefined) node.currentLoad = status.currentLoad;
    if (status.activeSessions !== undefined) node.activeSessions = status.activeSessions;
    if (status.lastSeenMs !== undefined) node.lastSeenMs = status.lastSeenMs;
  }

  /**
   * Update detailed resource metrics for a node.
   */
  updateNodeMetrics(nodeId: string, metrics: NodeLoadMetrics): void {
    this.nodeMetrics.set(nodeId, metrics);
    // Also update the basic load in the node manifest
    const node = this.nodes.get(nodeId);
    if (node) {
      node.currentLoad = metrics.loadScore;
      node.activeSessions = metrics.activeSessions;
      node.lastSeenMs = metrics.timestamp;
    }
  }

  /**
   * Get detailed resource metrics for a node.
   */
  getNodeMetrics(nodeId: string): NodeLoadMetrics | undefined {
    return this.nodeMetrics.get(nodeId);
  }

  /**
   * Get all registered nodes.
   */
  listNodes(): NodeManifest[] {
    return [...this.nodes.values()];
  }

  /**
   * Get a specific node.
   */
  getNode(nodeId: string): NodeManifest | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Set the local node ID.
   */
  setLocalNodeId(nodeId: string): void {
    this.localNodeId = nodeId;
  }

  // ============================================================
  // Task Requirement Analysis
  // ============================================================

  /**
   * Analyze a task to determine its compute requirements.
   * Public alias matching spec: analyzeTaskRequirements
   */
  analyzeTaskRequirements(task: Task): ComputeRequirements {
    return this.analyzeRequirements(task);
  }

  /**
   * Analyze a task to determine its compute requirements.
   */
  analyzeRequirements(task: Task): ComputeRequirements {
    const description = task.description.toLowerCase();
    const baseRequirements = TASK_TYPE_REQUIREMENTS[task.type] ?? {};

    // Initialize requirements
    const requirements: ComputeRequirements = {
      needsGPU: baseRequirements.needsGPU ?? false,
      needsOllama: baseRequirements.needsOllama ?? false,
      needsVoice: baseRequirements.needsVoice ?? false,
      needsMCP: [],
      needsLocalFiles: baseRequirements.needsLocalFiles ?? false,
      computeIntensity: baseRequirements.computeIntensity ?? "light",
      workspace: task.workspace,
    };

    // Check for GPU patterns
    if (!requirements.needsGPU) {
      requirements.needsGPU = GPU_PATTERNS.some((p) => p.test(task.description));
    }

    // Check for Ollama patterns
    if (!requirements.needsOllama) {
      requirements.needsOllama = OLLAMA_PATTERNS.some((p) => p.test(task.description));
    }

    // Check for voice patterns
    if (!requirements.needsVoice) {
      requirements.needsVoice = VOICE_PATTERNS.some((p) => p.test(task.description));
    }

    // Check for heavy compute patterns
    if (requirements.computeIntensity !== "heavy") {
      if (HEAVY_COMPUTE_PATTERNS.some((p) => p.test(task.description))) {
        requirements.computeIntensity = "heavy";
      }
    }

    // Extract MCP server references
    const mcpMatch = task.description.match(/\bmcp[:\s]+(\w+)/gi);
    if (mcpMatch) {
      requirements.needsMCP = mcpMatch.map((m) => m.replace(/^mcp[:\s]+/i, "").toLowerCase());
    }

    // Check for workspace/file references
    if (task.workspace) {
      requirements.needsLocalFiles = true;
    }

    // Estimate GPU VRAM if needed
    if (requirements.needsGPU) {
      requirements.gpuVRAM = this.estimateGPUVRAM(task);
    }

    // Estimate memory requirements
    requirements.estimatedMemoryMB = this.estimateMemory(task, requirements);

    log.debug(`analyzed task ${task.id}: ${JSON.stringify(requirements)}`);
    return requirements;
  }

  /**
   * Estimate GPU VRAM requirements for a task.
   */
  private estimateGPUVRAM(task: Task): number {
    const desc = task.description.toLowerCase();

    // High-end models need more VRAM
    if (/\b(sdxl|sd\s*xl|flux)\b/i.test(desc)) return 12;
    if (/\bsd\s*3\b/i.test(desc)) return 16;
    if (/\bhigh[-\s]res|4k|8k\b/i.test(desc)) return 12;
    if (/\btrain|fine[-\s]tune\b/i.test(desc)) return 24;

    // Default for image generation
    return 8;
  }

  /**
   * Estimate memory requirements for a task.
   */
  private estimateMemory(task: Task, req: ComputeRequirements): number {
    let baseMB = 256;

    if (req.needsGPU) baseMB = 4096;
    if (req.needsOllama) baseMB = 8192;
    if (req.needsVoice) baseMB = 2048;
    if (req.computeIntensity === "heavy") baseMB = Math.max(baseMB, 4096);
    if (req.computeIntensity === "medium") baseMB = Math.max(baseMB, 1024);

    return baseMB;
  }

  // ============================================================
  // Node Selection
  // ============================================================

  /**
   * Route a task to the best available node.
   */
  async route(task: Task): Promise<NodeSelection> {
    const startMs = Date.now();
    const requirements = this.analyzeRequirements(task);
    const selection = await this.selectBestNode(requirements);
    const durationMs = Date.now() - startMs;

    // Record decision
    const decision: RoutingDecision = {
      taskId: task.id,
      requirements,
      selection,
      timestamp: Date.now(),
      durationMs,
    };
    this.recordDecision(decision);

    log.info(`routed task ${task.id} to ${selection.nodeId}: ${selection.reason}`);
    return selection;
  }

  /**
   * Select the best node for given requirements.
   */
  async selectBestNode(requirements: ComputeRequirements): Promise<NodeSelection> {
    const alternatives: Array<{ nodeId: string; reason: string }> = [];

    // If specific node is preferred
    if (requirements.preferNode) {
      const preferred = this.findNodeByIdOrName(requirements.preferNode);
      if (preferred && this.nodeCanHandle(preferred, requirements)) {
        return {
          nodeId: preferred.id,
          reason: `Preferred node: ${preferred.name}`,
          confidence: 1.0,
          matchedRequirements: ["preferNode"],
        };
      }
    }

    // GPU requirement - find node with best GPU
    if (requirements.needsGPU) {
      const selection = this.selectByGPU(requirements.gpuVRAM ?? 8);
      if (selection) {
        return {
          ...selection,
          matchedRequirements: ["needsGPU"],
        };
      }
      // Fall through to master if no GPU node found
    }

    // Ollama requirement - route to master (Ollama server)
    if (requirements.needsOllama) {
      if (this.masterId) {
        return {
          nodeId: this.masterId,
          reason: "Ollama server on master",
          confidence: 0.95,
          matchedRequirements: ["needsOllama"],
        };
      }
      // Check if any node has Ollama
      const ollamaNode = this.findNodeWithCapability((c) => c.hasOllama);
      if (ollamaNode) {
        return {
          nodeId: ollamaNode.id,
          reason: `Ollama available on ${ollamaNode.name}`,
          confidence: 0.9,
          matchedRequirements: ["needsOllama"],
        };
      }
    }

    // Voice requirement - route to master (LiveKit)
    if (requirements.needsVoice) {
      if (this.masterId) {
        return {
          nodeId: this.masterId,
          reason: "Voice processing on master",
          confidence: 0.95,
          matchedRequirements: ["needsVoice"],
        };
      }
      const voiceNode = this.findNodeWithCapability((c) => c.hasVoice);
      if (voiceNode) {
        return {
          nodeId: voiceNode.id,
          reason: `Voice available on ${voiceNode.name}`,
          confidence: 0.9,
          matchedRequirements: ["needsVoice"],
        };
      }
    }

    // MCP server requirement
    if (requirements.needsMCP.length > 0) {
      const mcpNode = this.selectByMCP(requirements.needsMCP);
      if (mcpNode) {
        return {
          ...mcpNode,
          matchedRequirements: ["needsMCP"],
        };
      }
    }

    // Workspace/local files requirement
    if (requirements.workspace || requirements.needsLocalFiles) {
      const workspaceSelection = this.selectByWorkspace(requirements.workspace);
      if (workspaceSelection) {
        return {
          ...workspaceSelection,
          matchedRequirements: ["workspace", "needsLocalFiles"],
        };
      }
    }

    // Heavy compute - prefer master
    if (requirements.computeIntensity === "heavy" && this.masterId) {
      const master = this.nodes.get(this.masterId);
      if (master) {
        return {
          nodeId: this.masterId,
          reason: "Heavy compute routed to master",
          confidence: 0.8,
          matchedRequirements: ["computeIntensity"],
        };
      }
    }

    // Default: select by load (least busy node)
    return this.selectByLoad();
  }

  /**
   * Select node by GPU availability and VRAM.
   * Public method for direct GPU-based routing.
   */
  selectByGPU(requiredVRAM: number): NodeSelection | null {
    const gpuNodes: Array<{ node: NodeManifest; vram: number }> = [];

    for (const node of this.nodes.values()) {
      const caps = node.capabilities;
      if (caps.gpu && caps.gpuVRAM && caps.gpuVRAM >= requiredVRAM) {
        gpuNodes.push({ node, vram: caps.gpuVRAM });
      }
    }

    if (gpuNodes.length === 0) return null;

    // Sort by VRAM (descending) then by load (ascending)
    gpuNodes.sort((a, b) => {
      if (a.vram !== b.vram) return b.vram - a.vram;
      return (a.node.currentLoad ?? 50) - (b.node.currentLoad ?? 50);
    });

    const best = gpuNodes[0];
    return {
      nodeId: best.node.id,
      reason: `GPU: ${best.node.capabilities.gpu} (${best.vram}GB VRAM)`,
      confidence: 0.95,
      alternatives: gpuNodes.slice(1, 3).map((g) => ({
        nodeId: g.node.id,
        reason: `${g.node.capabilities.gpu} (${g.vram}GB)`,
      })),
    };
  }

  /**
   * Select node by MCP server availability.
   * Public method for direct MCP-based routing.
   */
  selectByMCP(requiredServers: string[]): NodeSelection | null {
    for (const node of this.nodes.values()) {
      const available = node.capabilities.mcpServers ?? [];
      const hasAll = requiredServers.every((s) =>
        available.some((a) => a.toLowerCase() === s.toLowerCase()),
      );
      if (hasAll) {
        return {
          nodeId: node.id,
          reason: `MCP servers: ${requiredServers.join(", ")}`,
          confidence: 0.9,
        };
      }
    }
    return null;
  }

  /**
   * Select node by workspace path.
   * Public method for direct workspace-based routing.
   */
  selectByWorkspace(workspace?: string): NodeSelection | null {
    if (!workspace) {
      // If no specific workspace, prefer local node
      if (this.localNodeId) {
        return {
          nodeId: this.localNodeId,
          reason: "Local file operations",
          confidence: 0.85,
        };
      }
      return null;
    }

    // Normalize workspace path for comparison
    const normalizedWorkspace = workspace.toLowerCase().replace(/\\/g, "/");

    for (const node of this.nodes.values()) {
      const workspaces = node.capabilities.workspaces ?? [];
      const nodeWorkspace = node.workspace.toLowerCase().replace(/\\/g, "/");

      // Check if the required workspace is on this node
      if (normalizedWorkspace.startsWith(nodeWorkspace)) {
        return {
          nodeId: node.id,
          reason: `Workspace: ${node.workspace}`,
          confidence: 0.95,
        };
      }

      // Check against registered workspaces
      for (const ws of workspaces) {
        const normalizedWs = ws.toLowerCase().replace(/\\/g, "/");
        if (normalizedWorkspace.startsWith(normalizedWs)) {
          return {
            nodeId: node.id,
            reason: `Workspace match: ${ws}`,
            confidence: 0.9,
          };
        }
      }
    }

    return null;
  }

  /**
   * Select node by current load (least busy).
   * Public method for load-balanced routing.
   */
  selectByLoad(): NodeSelection {
    const available = [...this.nodes.values()].filter((n) => this.isNodeHealthy(n));

    if (available.length === 0) {
      // No nodes available, fall back to local or master
      const fallback = this.localNodeId ?? this.masterId ?? "local";
      return {
        nodeId: fallback,
        reason: "No healthy nodes - fallback",
        confidence: 0.3,
      };
    }

    // Sort by load (ascending), then by active sessions
    available.sort((a, b) => {
      const loadA = a.currentLoad ?? 50;
      const loadB = b.currentLoad ?? 50;
      if (loadA !== loadB) return loadA - loadB;
      return (a.activeSessions ?? 0) - (b.activeSessions ?? 0);
    });

    const best = available[0];
    return {
      nodeId: best.id,
      reason: `Least busy: ${best.name} (load: ${best.currentLoad ?? "unknown"}%)`,
      confidence: 0.7,
      alternatives: available.slice(1, 3).map((n) => ({
        nodeId: n.id,
        reason: `Load: ${n.currentLoad ?? "unknown"}%`,
      })),
    };
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Find a node by ID or name.
   */
  private findNodeByIdOrName(idOrName: string): NodeManifest | null {
    // Try by ID first
    const byId = this.nodes.get(idOrName);
    if (byId) return byId;

    // Try by name (case-insensitive)
    const lowerName = idOrName.toLowerCase();
    for (const node of this.nodes.values()) {
      if (node.name.toLowerCase() === lowerName) {
        return node;
      }
      if (node.hostname.toLowerCase() === lowerName) {
        return node;
      }
    }
    return null;
  }

  /**
   * Find a node with a specific capability.
   */
  private findNodeWithCapability(
    predicate: (caps: NodeCapabilities) => boolean,
  ): NodeManifest | null {
    for (const node of this.nodes.values()) {
      if (predicate(node.capabilities)) {
        return node;
      }
    }
    return null;
  }

  /**
   * Check if a node can handle given requirements.
   */
  private nodeCanHandle(node: NodeManifest, req: ComputeRequirements): boolean {
    const caps = node.capabilities;

    if (req.needsGPU && !caps.gpu) return false;
    if (req.gpuVRAM && (!caps.gpuVRAM || caps.gpuVRAM < req.gpuVRAM)) return false;
    if (req.needsOllama && !caps.hasOllama) return false;
    if (req.needsVoice && !caps.hasVoice) return false;

    if (req.needsMCP.length > 0) {
      const available = caps.mcpServers ?? [];
      if (!req.needsMCP.every((s) => available.includes(s))) return false;
    }

    return true;
  }

  /**
   * Check if a node is healthy and available.
   */
  private isNodeHealthy(node: NodeManifest): boolean {
    // Consider stale if not seen in 5 minutes
    const staleThresholdMs = 5 * 60 * 1000;
    if (node.lastSeenMs && Date.now() - node.lastSeenMs > staleThresholdMs) {
      return false;
    }

    // Consider overloaded if load > 95%
    if (node.currentLoad && node.currentLoad > 95) {
      return false;
    }

    return true;
  }

  // ============================================================
  // Enhanced Resource-Aware Scoring
  // ============================================================

  /**
   * Calculate resource-aware penalty based on detailed metrics.
   * Returns penalty amount to subtract from score (0-100).
   */
  private calculateEnhancedResourcePenalty(
    node: NodeManifest,
    requirements: ComputeRequirements,
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
    const nodeMetrics = this.getNodeMetrics(node.id);
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
    // More aggressive penalty for CPU-intensive tasks
    let cpuPenalty = 0;
    const cpuThreshold = requirements.computeIntensity === "heavy" ? 70 : 80;
    if (nodeMetrics.cpuPercent > 95) {
      cpuPenalty = 30; // Severely overloaded
    } else if (nodeMetrics.cpuPercent > cpuThreshold) {
      cpuPenalty = 20; // High load for this task type
    } else if (nodeMetrics.cpuPercent > 50) {
      cpuPenalty = Math.round(nodeMetrics.cpuPercent * 0.2); // Scaled penalty
    }
    breakdown.cpuPenalty = cpuPenalty;

    // Memory penalty: 0-25% based on RAM utilization
    // Higher penalty for memory-intensive tasks
    let memoryPenalty = 0;
    const memoryThreshold =
      requirements.estimatedMemoryMB && requirements.estimatedMemoryMB > 4096 ? 70 : 85;
    if (nodeMetrics.memoryPercent > 90) {
      memoryPenalty = 25; // Critical memory pressure
    } else if (nodeMetrics.memoryPercent > memoryThreshold) {
      memoryPenalty = 15; // High memory usage for this task
    } else if (nodeMetrics.memoryPercent > 60) {
      memoryPenalty = 5; // Moderate usage
    }
    breakdown.memoryPenalty = memoryPenalty;

    // GPU penalty: 0-20% based on GPU utilization (if GPU is required)
    let gpuPenalty = 0;
    if (requirements.needsGPU && nodeMetrics.gpuPercent !== undefined) {
      if (nodeMetrics.gpuPercent > 90) {
        gpuPenalty = 20; // GPU heavily loaded
      } else if (nodeMetrics.gpuPercent > 70) {
        gpuPenalty = 12; // GPU moderately loaded
      } else if (nodeMetrics.gpuPercent > 50) {
        gpuPenalty = 5; // GPU active
      }

      // Additional penalty for GPU memory pressure
      if (nodeMetrics.gpuMemoryPercent !== undefined && nodeMetrics.gpuMemoryPercent > 85) {
        gpuPenalty += 10;
      }
    }
    breakdown.gpuPenalty = gpuPenalty;

    // Sessions penalty: 0-15% based on active sessions
    // More aggressive for complex tasks
    let sessionsPenalty = 0;
    const sessionThreshold = requirements.computeIntensity === "heavy" ? 3 : 8;
    if (nodeMetrics.activeSessions > sessionThreshold * 2) {
      sessionsPenalty = 15; // Way too many sessions
    } else if (nodeMetrics.activeSessions > sessionThreshold) {
      sessionsPenalty = 8; // Many sessions
    } else if (nodeMetrics.activeSessions > 1) {
      sessionsPenalty = Math.round(nodeMetrics.activeSessions * 1.5); // Light penalty
    }
    breakdown.sessionsPenalty = sessionsPenalty;

    // Queue penalty: 0-10% based on pending tasks
    let queuePenalty = 0;
    if (nodeMetrics.pendingTasks > 5) {
      queuePenalty = 10; // Large queue backlog
    } else if (nodeMetrics.pendingTasks > 2) {
      queuePenalty = 6; // Some queue backlog
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
  // Enhanced Capability-Aware Routing
  // ============================================================

  /**
   * Score a node for a given task based on capabilities and requirements.
   * Returns 0 if the node cannot handle the task (hard requirements not met).
   * Higher scores indicate better fit.
   */
  scoreNodeForTask(
    node: NodeManifest,
    requirements: ComputeRequirements,
  ): {
    score: number;
    missingCapabilities: string[];
    breakdown: {
      baseScore: number;
      gpuBonus: number;
      loadPenalty: number;
      preferenceBonus: number;
      mcpPenalty: number;
      healthBonus: number;
      finalScore: number;
    };
  } {
    let score = 100; // Base score
    const missingCapabilities: string[] = [];
    const caps = node.capabilities;

    // Track score components for transparency
    const breakdown = {
      baseScore: 100,
      gpuBonus: 0,
      loadPenalty: 0,
      preferenceBonus: 0,
      mcpPenalty: 0,
      healthBonus: 0,
      finalScore: 0,
    };

    // ── Hard Requirements (must have) ──
    if (requirements.needsGPU && !caps.gpu) {
      missingCapabilities.push("GPU");
      return { score: 0, missingCapabilities, breakdown: { ...breakdown, finalScore: 0 } };
    }

    if (requirements.needsOllama && !caps.hasOllama) {
      missingCapabilities.push("Ollama");
      return { score: 0, missingCapabilities, breakdown: { ...breakdown, finalScore: 0 } };
    }

    if (requirements.needsVoice && !caps.hasVoice) {
      missingCapabilities.push("Voice");
      return { score: 0, missingCapabilities, breakdown: { ...breakdown, finalScore: 0 } };
    }

    // Check minimum VRAM if GPU is needed
    if (requirements.gpuVRAM && caps.gpuVRAM && caps.gpuVRAM < requirements.gpuVRAM) {
      missingCapabilities.push(`GPU VRAM (need ${requirements.gpuVRAM}GB, have ${caps.gpuVRAM}GB)`);
      return { score: 0, missingCapabilities, breakdown: { ...breakdown, finalScore: 0 } };
    }

    // ── MCP Requirements (soft - can proxy, but prefer local) ──
    const mcpNeeded = requirements.needsMCP ?? [];
    for (const mcp of mcpNeeded) {
      const available = caps.mcpServers ?? [];
      const hasLocal = available.some((a) => a.toLowerCase() === mcp.toLowerCase());
      if (!hasLocal) {
        score -= 30; // Can still work via proxy, but prefer local
        breakdown.mcpPenalty -= 30;
        missingCapabilities.push(`MCP:${mcp}`);
      }
    }

    // ── Soft Preferences (bonus points) ──

    // Bonus for more GPU VRAM when GPU is needed
    if (requirements.needsGPU && caps.gpuVRAM) {
      const vramBonus = Math.min(caps.gpuVRAM, 24); // Cap bonus at 24GB
      score += vramBonus;
      breakdown.gpuBonus = vramBonus;
    }

    // Bonus for having ComfyUI when generating images
    if (requirements.needsGPU && caps.hasComfyUI) {
      score += 10;
      breakdown.gpuBonus += 10;
    }

    // Bonus for more system RAM for heavy compute
    if (requirements.computeIntensity === "heavy" && caps.systemRAM) {
      const ramBonus = Math.min(Math.floor(caps.systemRAM / 8), 10); // +1 per 8GB, max 10
      score += ramBonus;
      breakdown.gpuBonus += ramBonus;
    }

    // ── Enhanced Resource Factor (prefer less loaded nodes) ──
    const resourceScore = this.calculateEnhancedResourcePenalty(node, requirements);
    score -= resourceScore.penalty;
    breakdown.loadPenalty = -resourceScore.penalty;

    // ── Health Factor ──
    if (!this.isNodeHealthy(node)) {
      score -= 50;
      missingCapabilities.push("unhealthy");
    }

    breakdown.finalScore = Math.max(0, score);
    return { score: Math.max(0, score), missingCapabilities, breakdown };
  }

  /**
   * Select the best node using enhanced capability-aware routing.
   * Returns detailed decision with reasoning and alternatives.
   */
  selectBestNodeEnhanced(task: Task, preferredNodeId?: string): EnhancedRoutingDecision {
    const requirements = this.analyzeRequirements(task);
    const availableNodes = [...this.nodes.values()];

    // Score all nodes
    const scored = availableNodes.map((node) => {
      const { score, missingCapabilities, breakdown } = this.scoreNodeForTask(node, requirements);
      return { node, score, missingCapabilities, breakdown };
    });

    // Apply preference bonus if node is capable
    if (preferredNodeId) {
      const preferredEntry = scored.find((s) => s.node.id === preferredNodeId);
      if (preferredEntry && preferredEntry.score > 0) {
        preferredEntry.score += 20;
        preferredEntry.breakdown.preferenceBonus = 20;
        preferredEntry.breakdown.finalScore += 20;
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Handle no capable nodes
    if (scored.length === 0 || scored[0].score === 0) {
      // Try to find any node as fallback
      const fallbackId = this.localNodeId ?? this.masterId ?? "local";
      const fallbackNode = this.nodes.get(fallbackId);

      return {
        nodeId: fallbackId,
        nodeName: fallbackNode?.name ?? "Local",
        confidence: 0.1,
        reason: "No capable nodes found - using fallback",
        alternativeNodes: scored.slice(0, 3).map((s) => ({
          nodeId: s.node.id,
          nodeName: s.node.name,
          score: s.score,
          missingCapabilities: s.missingCapabilities,
          reason:
            s.missingCapabilities.length > 0
              ? `Missing: ${s.missingCapabilities.join(", ")}`
              : "Low score",
        })),
        requirements,
        autoRouted: true,
      };
    }

    const best = scored[0];
    const confidence = Math.min(1, best.score / 100);

    // Build reason string
    const reasonParts: string[] = [];
    if (requirements.needsGPU && best.node.capabilities.gpu) {
      reasonParts.push(`GPU: ${best.node.capabilities.gpu}`);
      if (best.node.capabilities.gpuVRAM) {
        reasonParts.push(`${best.node.capabilities.gpuVRAM}GB VRAM`);
      }
    }
    if (requirements.needsOllama && best.node.capabilities.hasOllama) {
      reasonParts.push("Ollama available");
    }
    if (requirements.needsVoice && best.node.capabilities.hasVoice) {
      reasonParts.push("Voice processing");
    }
    if (preferredNodeId === best.node.id) {
      reasonParts.push("preferred node");
    }
    if (reasonParts.length === 0) {
      const load = best.node.currentLoad ?? 50;
      reasonParts.push(`load: ${load}%`);
    }

    const reason = reasonParts.join(", ");

    // Build alternatives list (top 3 excluding best)
    const alternatives: AlternativeNode[] = scored.slice(1, 4).map((s) => ({
      nodeId: s.node.id,
      nodeName: s.node.name,
      score: s.score,
      missingCapabilities: s.missingCapabilities,
      reason:
        s.score === 0 ? `Cannot handle: ${s.missingCapabilities.join(", ")}` : `Score: ${s.score}`,
    }));

    return {
      nodeId: best.node.id,
      nodeName: best.node.name,
      confidence,
      reason: `${best.node.name}: ${reason}`,
      alternativeNodes: alternatives,
      requirements,
      autoRouted: !preferredNodeId,
      scoreBreakdown: best.breakdown,
    };
  }

  /**
   * Quick check if auto-routing would select a different node than local.
   * Useful for deciding whether to suggest remote execution.
   */
  wouldRouteRemotely(taskDescription: string): {
    shouldRouteRemote: boolean;
    suggestedNodeId?: string;
    suggestedNodeName?: string;
    reason?: string;
  } {
    const taskType = inferTaskType(taskDescription);
    const task: Task = {
      id: "check",
      type: taskType,
      description: taskDescription,
    };

    const decision = this.selectBestNodeEnhanced(task);
    const isRemote = decision.nodeId !== this.localNodeId;

    if (isRemote && decision.confidence > 0.7) {
      return {
        shouldRouteRemote: true,
        suggestedNodeId: decision.nodeId,
        suggestedNodeName: decision.nodeName,
        reason: decision.reason,
      };
    }

    return { shouldRouteRemote: false };
  }

  // ============================================================
  // Metrics and Logging
  // ============================================================

  /**
   * Record a routing decision for metrics.
   */
  private recordDecision(decision: RoutingDecision): void {
    // Update metrics
    this.metrics.totalDecisions++;
    this.metrics.byNode[decision.selection.nodeId] =
      (this.metrics.byNode[decision.selection.nodeId] ?? 0) + 1;
    this.metrics.byReason[decision.selection.reason] =
      (this.metrics.byReason[decision.selection.reason] ?? 0) + 1;

    // Update average decision time
    const prevTotal = this.metrics.avgDecisionMs * (this.metrics.totalDecisions - 1);
    this.metrics.avgDecisionMs = (prevTotal + decision.durationMs) / this.metrics.totalDecisions;

    // Keep decision log bounded
    this.decisionLog.push(decision);
    if (this.decisionLog.length > this.maxDecisionLogSize) {
      this.decisionLog.shift();
    }
  }

  /**
   * Get routing metrics.
   */
  getMetrics(): RoutingMetrics {
    return { ...this.metrics };
  }

  /**
   * Get recent routing decisions.
   */
  getRecentDecisions(limit = 10): RoutingDecision[] {
    return this.decisionLog.slice(-limit);
  }

  /**
   * Reset metrics.
   */
  resetMetrics(): void {
    this.metrics = {
      totalDecisions: 0,
      byNode: {},
      byReason: {},
      avgDecisionMs: 0,
    };
    this.decisionLog = [];
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let defaultRouter: ComputeRouter | null = null;

/**
 * Get the default compute router instance.
 */
export function getComputeRouter(): ComputeRouter {
  if (!defaultRouter) {
    defaultRouter = new ComputeRouter();
  }
  return defaultRouter;
}

/**
 * Initialize the compute router with configuration.
 */
export function initComputeRouter(opts?: {
  masterId?: string;
  localNodeId?: string;
}): ComputeRouter {
  defaultRouter = new ComputeRouter(opts);
  return defaultRouter;
}

/**
 * Utility function to infer task type from description.
 */
export function inferTaskType(description: string): TaskType {
  const desc = description.toLowerCase();

  if (GPU_PATTERNS.some((p) => p.test(description))) return "image_gen";
  if (VOICE_PATTERNS.some((p) => p.test(description))) return "voice";
  if (OLLAMA_PATTERNS.some((p) => p.test(description))) return "ollama_inference";
  if (/\b(browse|open\s*url|navigate|web\s*page)\b/i.test(desc)) return "browser";
  if (/\b(code|implement|fix|debug|refactor|write\s*function)\b/i.test(desc)) return "code";
  if (/\b(read|write|create|delete|move|copy)\s*(file|folder|dir)/i.test(desc)) return "file_ops";
  if (/\b(research|search|find|look\s*up)\b/i.test(desc)) return "research";
  if (/\bmcp\b/i.test(desc)) return "mcp_invoke";
  if (/\b(spawn|sub-?agent|delegate)\b/i.test(desc)) return "subagent";
  if (/\b(chat|talk|convers|discuss)\b/i.test(desc)) return "chat";

  return "unknown";
}
