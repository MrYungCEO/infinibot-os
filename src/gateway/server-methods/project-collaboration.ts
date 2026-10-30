/**
 * Project Collaboration Gateway Methods
 *
 * Federation-aware project collaboration:
 * - Multi-node project assignment
 * - Capability-based task routing
 * - Role designation
 * - Cross-node work delegation
 */

import type { GatewayRequestHandlerOptions } from "./types.js";
import {
  routeTaskToNode,
  assignNodeToProject,
  getProjectCollaboration,
  listProjectCollaborations,
  delegateToNode,
  inferNodeRoles,
  type NodeRole,
  type TaskRouting,
} from "../../federation/project-collaboration.js";
import { getFederationHub } from "../../federation/hub.js";
import { getMeshState, sendMeshMessage } from "../../federation/mesh-state.js";
import { loadConfig } from "../../config/config.js";

// ══════════════════════════════════════════════════════════════════════════════
// Gateway Methods
// ══════════════════════════════════════════════════════════════════════════════

export const projectCollaborationHandlers: Record<
  string,
  (opts: GatewayRequestHandlerOptions) => Promise<void> | void
> = {
  /**
   * Route a task to the best available node based on requirements
   */
  "federation.task.route": async (opts) => {
    const { taskId, taskTitle, requirements, preferredNodeId, excludeNodes } = opts.req.params as {
      taskId: string;
      taskTitle: string;
      requirements: string[];
      preferredNodeId?: string;
      excludeNodes?: string[];
    };

    if (!taskId || !taskTitle) {
      opts.respond(false, { error: "taskId and taskTitle required" });
      return;
    }

    const routing = await routeTaskToNode({
      taskId,
      taskTitle,
      requirements: requirements || [],
      preferredNodeId,
      excludeNodes,
    });

    if (!routing) {
      opts.respond(false, { error: "No suitable node found" });
      return;
    }

    opts.respond(true, {
      success: true,
      routing,
    });
  },

  /**
   * Assign a node to a project with a specific role
   */
  "federation.project.assign": async (opts) => {
    const { projectId, projectName, nodeId, nodeName, role, capabilities } = opts.req.params as {
      projectId: string;
      projectName: string;
      nodeId: string;
      nodeName: string;
      role: NodeRole;
      capabilities?: string[];
    };

    if (!projectId || !projectName || !nodeId || !role) {
      opts.respond(false, { error: "projectId, projectName, nodeId, and role required" });
      return;
    }

    const collab = assignNodeToProject({
      projectId,
      projectName,
      nodeId,
      nodeName: nodeName || nodeId,
      role,
      capabilities: capabilities || [],
    });

    opts.respond(true, {
      success: true,
      collaboration: collab,
    });
  },

  /**
   * Get project collaboration info
   */
  "federation.project.get": async (opts) => {
    const { projectId } = opts.req.params as { projectId: string };

    if (!projectId) {
      opts.respond(false, { error: "projectId required" });
      return;
    }

    const collab = getProjectCollaboration(projectId);

    if (!collab) {
      opts.respond(false, { error: "Project not found" });
      return;
    }

    opts.respond(true, {
      success: true,
      collaboration: collab,
    });
  },

  /**
   * List all project collaborations
   */
  "federation.project.list": async (opts) => {
    const collabs = listProjectCollaborations();

    opts.respond(true, {
      success: true,
      collaborations: collabs,
      count: collabs.length,
    });
  },

  /**
   * Delegate work to another node
   */
  "federation.delegate": async (opts) => {
    const { targetNodeId, task, agentId, context, timeout } = opts.req.params as {
      targetNodeId: string;
      task: string;
      agentId?: string;
      context?: Record<string, unknown>;
      timeout?: number;
    };

    if (!targetNodeId || !task) {
      opts.respond(false, { error: "targetNodeId and task required" });
      return;
    }

    const result = await delegateToNode({
      targetNodeId,
      task,
      agentId,
      context,
      timeout,
    });

    if (!result.success) {
      opts.respond(false, { error: result.error });
      return;
    }

    opts.respond(true, {
      success: true,
      sessionKey: result.sessionKey,
    });
  },

  /**
   * Get federation node capabilities
   */
  "federation.capabilities": async (opts) => {
    const { nodeId } = opts.req.params as { nodeId?: string };

    const hub = getFederationHub();
    const config = loadConfig();
    const nodes = hub?.getConnectedNodes?.() ?? [];

    const capabilities: Array<{
      nodeId: string;
      nodeName: string;
      isOnline: boolean;
      isLocal: boolean;
      roles: NodeRole[];
      capabilities: Record<string, unknown>;
      currentLoad: number;
      activeSessions: number;
    }> = [];

    // Add local node
    if (!nodeId || nodeId === "local") {
      capabilities.push({
        nodeId: "local",
        nodeName: config.federation?.nodeName || "Master",
        isOnline: true,
        isLocal: true,
        roles: ["lead", "compute", "build", "test", "research", "assistant"],
        capabilities: {
          gpu: true,
          ollama: true,
          platform: process.platform,
        },
        currentLoad: 0,
        activeSessions: getMeshState()?.getAllAgents().length || 0,
      });
    }

    // Add connected nodes
    for (const node of nodes) {
      if (nodeId && node.id !== nodeId) continue;

      const caps = node.manifest?.capabilities || {};
      capabilities.push({
        nodeId: node.id,
        nodeName: node.manifest?.name || node.id,
        isOnline: node.state === "registered",
        isLocal: false,
        roles: inferNodeRoles(caps),
        capabilities: caps as unknown as Record<string, unknown>,
        currentLoad: node.currentLoad || 0,
        activeSessions: node.activeSessions || 0,
      });
    }

    opts.respond(true, {
      success: true,
      capabilities,
      count: capabilities.length,
    });
  },

  /**
   * Get mesh agent messages for activity feed
   */
  "federation.mesh.messages": async (opts) => {
    const { limit, since, sessionKey } = opts.req.params as {
      limit?: number;
      since?: number;
      sessionKey?: string;
    };

    const meshState = getMeshState();
    if (!meshState) {
      opts.respond(true, { success: true, messages: [], count: 0 });
      return;
    }

    let messages = meshState.getRecentMessages(limit || 50);

    if (since) {
      messages = messages.filter((m) => m.timestamp > since);
    }

    if (sessionKey) {
      messages = messages.filter((m) => m.from === sessionKey || m.to === sessionKey);
    }

    opts.respond(true, {
      success: true,
      messages,
      count: messages.length,
    });
  },

  /**
   * Get mesh agents across federation
   */
  "federation.mesh.agents": async (opts) => {
    const { nodeId, status, agentId } = opts.req.params as {
      nodeId?: string;
      status?: string;
      agentId?: string;
    };

    const meshState = getMeshState();
    if (!meshState) {
      opts.respond(true, { success: true, agents: [], count: 0 });
      return;
    }

    let agents = meshState.getAllAgents();

    if (nodeId) {
      agents = agents.filter((a) => a.nodeId === nodeId);
    }

    if (status) {
      agents = agents.filter((a) => a.status === status);
    }

    if (agentId) {
      agents = agents.filter((a) => a.agentId === agentId);
    }

    opts.respond(true, {
      success: true,
      agents,
      count: agents.length,
    });
  },

  /**
   * Send a mesh message (for activity feed / agent coordination)
   */
  "federation.mesh.send": async (opts) => {
    const { to, type, payload } = opts.req.params as {
      to: string;
      type?: "request" | "response" | "broadcast" | "event";
      payload: {
        action?: string;
        message?: string;
        data?: Record<string, unknown>;
        priority?: string;
      };
    };

    if (!to || !payload) {
      opts.respond(false, { error: "to and payload required" });
      return;
    }

    const meshState = getMeshState();
    if (!meshState) {
      opts.respond(false, { error: "Mesh not available" });
      return;
    }

    const config = loadConfig();
    const fromSession = `system:${config.federation?.nodeId || "local"}`;

    const message = sendMeshMessage(fromSession, to, type || "event", {
      ...payload,
      priority: payload.priority as "low" | "normal" | "high" | "critical" | undefined,
    });

    opts.respond(true, {
      success: true,
      message,
    });
  },
};

export default projectCollaborationHandlers;
