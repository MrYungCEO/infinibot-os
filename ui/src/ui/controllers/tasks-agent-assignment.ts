/**
 * Task-Agent Assignment System
 * Handles assigning tasks to agents, finding best matches, auto-assignment
 */

import type { GatewayBrowserClient } from "../gateway";
import type { KanbanTask } from "../types";
import type { AgentCapabilities, AgentProfile } from "./agents-config";
import {
  findBestAgent,
  getAgentCapabilities,
  getAgentProfiles,
  getAgentsForSpecialty,
} from "./agents-config";

// ============================================================
// Types
// ============================================================

export interface TaskAgentAssignment {
  taskId: string;
  assignedAgent: string | null;
  candidateAgents: string[];
  requiredSpecialties?: string[];
  requiredTools?: string[];
  priority: "low" | "normal" | "high" | "critical";
  autoAssign?: boolean;
}

export interface AgentMatchScore {
  agentId: string;
  agentName: string;
  score: number;
  matching: {
    specialties: number;
    tools: number;
    availability: number;
  };
}

// ============================================================
// Task-Agent Matching & Scoring
// ============================================================

export async function scoreAgentForTask(
  client: GatewayBrowserClient,
  agentId: string,
  task: {
    requiredSpecialties?: string[];
    requiredTools?: string[];
    priority?: string;
  }
): Promise<AgentMatchScore | null> {
  try {
    const cap = await getAgentCapabilities(client, agentId);
    if (!cap) return null;

    // Score components (0-100 each)
    let specialtyScore = 0;
    let toolScore = 0;
    let availabilityScore = 0;

    // Specialty matching
    if (task.requiredSpecialties?.length) {
      const matches = task.requiredSpecialties.filter((s) =>
        cap.specialties.includes(s)
      ).length;
      specialtyScore =
        (matches / task.requiredSpecialties.length) * 100;
    } else {
      specialtyScore = 50; // Neutral if no specialty required
    }

    // Tool matching
    if (task.requiredTools?.length) {
      const matches = task.requiredTools.filter((t) =>
        cap.tools.includes(t)
      ).length;
      toolScore = (matches / task.requiredTools.length) * 100;
    } else {
      toolScore = 50; // Neutral if no tools required
    }

    // Availability (inverse of workload)
    if (cap.workload) {
      const utilization =
        (cap.workload.current + cap.workload.queued) /
        cap.workload.maxConcurrent;
      availabilityScore = Math.max(0, (1 - utilization) * 100);
    }

    // Weighted average (specialties 50%, tools 30%, availability 20%)
    const totalScore =
      specialtyScore * 0.5 + toolScore * 0.3 + availabilityScore * 0.2;

    return {
      agentId: cap.id,
      agentName: cap.name,
      score: Math.round(totalScore),
      matching: {
        specialties: Math.round(specialtyScore),
        tools: Math.round(toolScore),
        availability: Math.round(availabilityScore),
      },
    };
  } catch (err) {
    console.error(`Failed to score agent ${agentId}:`, err);
    return null;
  }
}

export async function scoreAllAgentsForTask(
  client: GatewayBrowserClient,
  task: {
    requiredSpecialties?: string[];
    requiredTools?: string[];
    priority?: string;
  }
): Promise<AgentMatchScore[]> {
  try {
    const profiles = await getAgentProfiles(client);
    const scores: AgentMatchScore[] = [];

    for (const profile of profiles) {
      const score = await scoreAgentForTask(client, profile.id, task);
      if (score) {
        scores.push(score);
      }
    }

    // Sort by score descending
    return scores.sort((a, b) => b.score - a.score);
  } catch (err) {
    console.error("Failed to score agents:", err);
    return [];
  }
}

// ============================================================
// Task Assignment
// ============================================================

export async function assignTaskToAgent(
  client: GatewayBrowserClient,
  taskId: string,
  agentId: string
): Promise<boolean> {
  try {
    // Update task via MCP (when integrated)
    // For now, store in local state
    const key = `task:${taskId}:assigned_agent`;
    localStorage.setItem(key, agentId);
    return true;
  } catch (err) {
    console.error(`Failed to assign task ${taskId} to agent ${agentId}:`, err);
    return false;
  }
}

export async function unassignTask(
  client: GatewayBrowserClient,
  taskId: string
): Promise<boolean> {
  try {
    const key = `task:${taskId}:assigned_agent`;
    localStorage.removeItem(key);
    return true;
  } catch (err) {
    console.error(`Failed to unassign task ${taskId}:`, err);
    return false;
  }
}

export async function getAssignedAgent(
  taskId: string
): Promise<string | null> {
  try {
    const key = `task:${taskId}:assigned_agent`;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setTaskRequirements(
  taskId: string,
  requirements: {
    specialties?: string[];
    tools?: string[];
  }
): Promise<void> {
  try {
    const key = `task:${taskId}:requirements`;
    localStorage.setItem(key, JSON.stringify(requirements));
  } catch (err) {
    console.error("Failed to set task requirements:", err);
  }
}

export async function getTaskRequirements(
  taskId: string
): Promise<{ specialties?: string[]; tools?: string[] } | null> {
  try {
    const key = `task:${taskId}:requirements`;
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

// ============================================================
// Auto-Assignment & Suggestions
// ============================================================

export async function suggestAgentsForTask(
  client: GatewayBrowserClient,
  task: {
    requiredSpecialties?: string[];
    requiredTools?: string[];
    priority?: string;
  },
  limit: number = 3
): Promise<AgentMatchScore[]> {
  try {
    const scores = await scoreAllAgentsForTask(client, task);
    return scores.slice(0, limit);
  } catch (err) {
    console.error("Failed to suggest agents:", err);
    return [];
  }
}

export async function autoAssignTask(
  client: GatewayBrowserClient,
  taskId: string,
  task: {
    requiredSpecialties?: string[];
    requiredTools?: string[];
    priority?: string;
  }
): Promise<string | null> {
  try {
    const scores = await scoreAllAgentsForTask(client, task);

    if (scores.length === 0) {
      return null;
    }

    // Get best match
    const best = scores[0];

    // Auto-assign if score is above threshold (70%)
    if (best.score >= 70) {
      const success = await assignTaskToAgent(
        client,
        taskId,
        best.agentId
      );
      return success ? best.agentId : null;
    }

    return null;
  } catch (err) {
    console.error("Failed to auto-assign task:", err);
    return null;
  }
}

// ============================================================
// Candidate Agent Filtering
// ============================================================

export async function getCandidateAgentsForTask(
  client: GatewayBrowserClient,
  task: {
    requiredSpecialties?: string[];
    requiredTools?: string[];
    priority?: string;
  }
): Promise<AgentMatchScore[]> {
  try {
    const scores = await scoreAllAgentsForTask(client, task);
    // Filter to agents with score >= 50 (at least half match)
    return scores.filter((s) => s.score >= 50);
  } catch (err) {
    console.error("Failed to get candidate agents:", err);
    return [];
  }
}

// ============================================================
// Agent Delegation Chain
// ============================================================

export async function delegateTaskToAgent(
  client: GatewayBrowserClient,
  taskId: string,
  delegatingAgentId: string,
  targetAgentId: string
): Promise<boolean> {
  try {
    // Store delegation chain
    const key = `task:${taskId}:delegated_from`;
    localStorage.setItem(key, delegatingAgentId);

    // Assign to target agent
    return assignTaskToAgent(client, taskId, targetAgentId);
  } catch (err) {
    console.error("Failed to delegate task:", err);
    return false;
  }
}

export async function getDelegationChain(
  taskId: string
): Promise<string[]> {
  try {
    const chain: string[] = [];
    let current = taskId;

    // Trace back through delegations
    for (let i = 0; i < 10; i++) {
      const key = `task:${current}:delegated_from`;
      const delegatedFrom = localStorage.getItem(key);

      if (!delegatedFrom) break;

      chain.push(delegatedFrom);
      // In a real system, we'd traverse to the original task ID
      break;
    }

    return chain;
  } catch {
    return [];
  }
}

// ============================================================
// Task Execution Triggering
// ============================================================

export async function triggerTaskExecution(
  client: GatewayBrowserClient,
  taskId: string,
  agentId: string,
  taskTitle: string
): Promise<string | null> {
  try {
    // Spawn sub-agent to execute task
    // This would call sessions_spawn in a real implementation
    const sessionKey = `task:${taskId}:agent:${agentId}`;

    // For now, just mark as started
    localStorage.setItem(`${sessionKey}:started_at`, new Date().toISOString());

    // In real impl: await client.request('sessions_spawn', {...})
    // Would return run ID

    return sessionKey;
  } catch (err) {
    console.error("Failed to trigger task execution:", err);
    return null;
  }
}

export async function updateTaskStatus(
  taskId: string,
  status: "new" | "in_progress" | "blocked" | "done",
  result?: string
): Promise<void> {
  try {
    localStorage.setItem(`task:${taskId}:status`, status);
    if (result) {
      localStorage.setItem(`task:${taskId}:result`, result);
    }
  } catch (err) {
    console.error("Failed to update task status:", err);
  }
}
