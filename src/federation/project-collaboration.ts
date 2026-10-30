/**
 * Federation Project Collaboration System
 *
 * Enables multi-node project collaboration with:
 * - Node-to-project affinity assignment
 * - Capability-based task routing
 * - Role designation per node
 * - Cross-node work coordination
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getFederationHub } from "./hub.js";
import { getEventBus } from "./event-bus.js";
import type { NodeCapabilities } from "./types.js";

const log = createSubsystemLogger("federation").child("project-collab");

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

/** Role a node can play in a project */
export type NodeRole =
  | "lead" // Primary coordinator
  | "compute" // Heavy computation (GPU, ML)
  | "build" // Building/compilation
  | "test" // Testing
  | "research" // Web research, analysis
  | "assistant"; // General assistance

/** Node assignment to a project */
export interface ProjectNodeAssignment {
  nodeId: string;
  nodeName: string;
  role: NodeRole;
  capabilities: string[];
  assignedAt: number;
  taskCount: number;
}

/** Project collaboration config */
export interface ProjectCollaboration {
  projectId: string;
  projectName: string;
  leadNodeId: string;
  nodeAssignments: ProjectNodeAssignment[];
  createdAt: number;
  updatedAt: number;
}

/** Task routing decision */
export interface TaskRouting {
  taskId: string;
  targetNodeId: string;
  targetNodeName: string;
  agentId: string;
  score: number;
  reasons: string[];
}

/** Node capability profile */
export interface NodeCapabilityProfile {
  nodeId: string;
  nodeName: string;
  isOnline: boolean;
  capabilities: {
    // Compute
    hasGPU: boolean;
    gpuVRAM?: number;
    hasOllama: boolean;
    ollamaModels?: string[];
    // Media
    hasComfyUI: boolean;
    hasFFmpeg: boolean;
    hasVoice: boolean;
    // Development
    canBuild: boolean;
    canTest: boolean;
    // Platform
    platform: string;
  };
  currentLoad: number;
  activeSessions: number;
  roles: NodeRole[];
}

// ══════════════════════════════════════════════════════════════════════════════
// Capability Analysis
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Infer node roles from capabilities
 */
export function inferNodeRoles(caps: NodeCapabilities): NodeRole[] {
  const roles: NodeRole[] = ["assistant"]; // All nodes can assist

  if (caps.gpu || caps.hasOllama || caps.gpuVRAM) {
    roles.push("compute");
  }

  if (caps.hasComfyUI || caps.ffmpeg?.available) {
    roles.push("compute");
  }

  // All nodes can build/test by default
  roles.push("build", "test");

  // Research capability
  roles.push("research");

  return [...new Set(roles)];
}

/**
 * Score a node for a specific capability requirement
 */
export function scoreNodeForCapability(
  profile: NodeCapabilityProfile,
  requirement: string,
): number {
  let score = 0;
  const req = requirement.toLowerCase();

  // GPU/ML requirements
  if (req.includes("gpu") || req.includes("cuda") || req.includes("ml")) {
    if (profile.capabilities.hasGPU) score += 50;
    if (profile.capabilities.gpuVRAM && profile.capabilities.gpuVRAM >= 8) score += 30;
  }

  // LLM requirements
  if (req.includes("ollama") || req.includes("llm") || req.includes("local")) {
    if (profile.capabilities.hasOllama) score += 50;
    if (profile.capabilities.ollamaModels?.length) score += 20;
  }

  // Image generation
  if (req.includes("comfyui") || req.includes("image") || req.includes("diffusion")) {
    if (profile.capabilities.hasComfyUI) score += 50;
  }

  // Video/media
  if (req.includes("video") || req.includes("ffmpeg") || req.includes("media")) {
    if (profile.capabilities.hasFFmpeg) score += 40;
  }

  // Voice/TTS
  if (req.includes("voice") || req.includes("tts") || req.includes("speech")) {
    if (profile.capabilities.hasVoice) score += 40;
  }

  // General availability bonus
  if (profile.isOnline) score += 20;

  // Load penalty
  score -= profile.currentLoad * 0.3;

  // Active sessions penalty
  score -= profile.activeSessions * 5;

  return Math.max(0, score);
}

// ══════════════════════════════════════════════════════════════════════════════
// Task Routing
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Route a task to the best available node
 */
export async function routeTaskToNode(params: {
  taskId: string;
  taskTitle: string;
  requirements: string[];
  preferredNodeId?: string;
  excludeNodes?: string[];
}): Promise<TaskRouting | null> {
  const hub = getFederationHub();
  const nodes = hub?.getConnectedNodes?.() ?? [];

  // Build node profiles
  const profiles: NodeCapabilityProfile[] = [];

  // Add local node
  profiles.push({
    nodeId: "local",
    nodeName: "Master",
    isOnline: true,
    capabilities: {
      hasGPU: true, // Assume master has GPU
      hasOllama: true,
      hasComfyUI: false,
      hasFFmpeg: true,
      hasVoice: true,
      canBuild: true,
      canTest: true,
      platform: process.platform,
    },
    currentLoad: 0,
    activeSessions: 0,
    roles: ["lead", "compute", "build", "test", "research", "assistant"],
  });

  // Add connected nodes
  for (const node of nodes) {
    if (params.excludeNodes?.includes(node.id)) continue;

    const caps = (node.manifest?.capabilities || {}) as NodeCapabilities;
    profiles.push({
      nodeId: node.id,
      nodeName: node.manifest?.name || node.id,
      isOnline: node.state === "registered",
      capabilities: {
        hasGPU: !!caps.gpu,
        gpuVRAM: caps.gpuVRAM,
        hasOllama: !!caps.hasOllama,
        ollamaModels: caps.ollamaModels,
        hasComfyUI: !!caps.hasComfyUI,
        hasFFmpeg: !!caps.ffmpeg?.available,
        hasVoice: !!caps.hasVoice,
        canBuild: true,
        canTest: true,
        platform: caps.platform || "unknown",
      },
      currentLoad: node.currentLoad || 0,
      activeSessions: node.activeSessions || 0,
      roles: inferNodeRoles(caps),
    });
  }

  // Score each node
  const scored = profiles
    .filter((p) => p.isOnline)
    .map((profile) => {
      let totalScore = 0;
      const reasons: string[] = [];

      // Preferred node bonus
      if (params.preferredNodeId === profile.nodeId) {
        totalScore += 30;
        reasons.push("preferred node");
      }

      // Score requirements
      for (const req of params.requirements) {
        const reqScore = scoreNodeForCapability(profile, req);
        if (reqScore > 0) {
          totalScore += reqScore;
          reasons.push(`${req}: +${reqScore}`);
        }
      }

      // Online bonus
      totalScore += 20;
      reasons.push("online");

      return {
        taskId: params.taskId,
        targetNodeId: profile.nodeId,
        targetNodeName: profile.nodeName,
        agentId: "coder", // Default, can be customized
        score: totalScore,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    log.warn(`No available nodes for task ${params.taskId}`);
    return null;
  }

  const best = scored[0];
  log.info(`Routed task "${params.taskTitle}" to ${best.targetNodeName} (score: ${best.score})`);

  // Emit event (task.routed is logged but not a federation event type)
  log.info(`Task routed: ${params.taskTitle} → ${best.targetNodeName} (score: ${best.score})`);
  const eventBus = getEventBus();
  if (eventBus) {
    eventBus.emit("session.update" as const, {
      type: "session.update" as const,
      nodeId: best.targetNodeId,
      payload: {
        taskId: params.taskId,
        taskTitle: params.taskTitle,
        targetNode: best.targetNodeName,
        score: best.score,
      },
      timestamp: Date.now(),
    });
  }

  return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// Project Assignment
// ══════════════════════════════════════════════════════════════════════════════

/** In-memory project collaborations */
const projectCollabs = new Map<string, ProjectCollaboration>();

/**
 * Assign a node to a project with a specific role
 */
export function assignNodeToProject(params: {
  projectId: string;
  projectName: string;
  nodeId: string;
  nodeName: string;
  role: NodeRole;
  capabilities: string[];
}): ProjectCollaboration {
  let collab = projectCollabs.get(params.projectId);

  if (!collab) {
    collab = {
      projectId: params.projectId,
      projectName: params.projectName,
      leadNodeId: params.nodeId,
      nodeAssignments: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // Check if node already assigned
  const existing = collab.nodeAssignments.find((a) => a.nodeId === params.nodeId);
  if (existing) {
    existing.role = params.role;
    existing.capabilities = params.capabilities;
  } else {
    collab.nodeAssignments.push({
      nodeId: params.nodeId,
      nodeName: params.nodeName,
      role: params.role,
      capabilities: params.capabilities,
      assignedAt: Date.now(),
      taskCount: 0,
    });
  }

  // If lead role, update leadNodeId
  if (params.role === "lead") {
    collab.leadNodeId = params.nodeId;
  }

  collab.updatedAt = Date.now();
  projectCollabs.set(params.projectId, collab);

  log.info(`Assigned ${params.nodeName} to project "${params.projectName}" as ${params.role}`);

  return collab;
}

/**
 * Get project collaboration info
 */
export function getProjectCollaboration(projectId: string): ProjectCollaboration | null {
  return projectCollabs.get(projectId) || null;
}

/**
 * List all project collaborations
 */
export function listProjectCollaborations(): ProjectCollaboration[] {
  return Array.from(projectCollabs.values());
}

// ══════════════════════════════════════════════════════════════════════════════
// Cross-Node Delegation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Delegate work to another node in the federation
 * Note: Currently returns info for manual delegation; direct remote spawn TBD
 */
export async function delegateToNode(params: {
  targetNodeId: string;
  task: string;
  agentId?: string;
  context?: Record<string, unknown>;
  timeout?: number;
}): Promise<{
  success: boolean;
  sessionKey?: string;
  error?: string;
  delegationInfo?: Record<string, unknown>;
}> {
  const hub = getFederationHub();

  if (!hub) {
    return { success: false, error: "Federation hub not available" };
  }

  // Find target node
  const nodes = hub.getConnectedNodes?.() ?? [];
  const targetNode = nodes.find((n) => n.id === params.targetNodeId);

  if (!targetNode || targetNode.state !== "registered") {
    return { success: false, error: `Node ${params.targetNodeId} not available` };
  }

  // For now, return delegation info - actual remote spawn needs federation message routing
  // which will be implemented via the mesh messaging system
  log.info(`Delegation prepared for ${targetNode.manifest?.name}: ${params.task.slice(0, 50)}...`);

  return {
    success: true,
    delegationInfo: {
      targetNodeId: params.targetNodeId,
      targetNodeName: targetNode.manifest?.name || params.targetNodeId,
      task: params.task,
      agentId: params.agentId || "coder",
      prepared: true,
      note: "Use mesh.spawn with node parameter to execute on target node",
    },
  };
}

// Functions are already exported at declaration
