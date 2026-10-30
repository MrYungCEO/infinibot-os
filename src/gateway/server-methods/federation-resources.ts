/**
 * Federation Resources Server Methods
 *
 * Utility functions for cross-node resource sharing:
 * - Projects & tasks
 * - Agents
 * - MCP servers
 * - Business data
 *
 * Note: The primary gateway handlers are in federation.ts.
 * These are standalone helpers that can be used outside the gateway handler pattern.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFederationHub } from "../../federation/hub.js";
import { getKanbanStore } from "../../tasks/store.js";
import { loadConfig } from "../../config/io.js";
import type { InfinibotConfig } from "../../config/config.js";

const log = createSubsystemLogger("federation").child("resources");

interface FederatedResource<T = unknown> {
  id: string;
  sourceNode: string;
  nodeName: string;
  data: T;
  lastSync: number;
  syncStatus: "synced" | "pending" | "conflict" | "error" | "offline";
}

// ══════════════════════════════════════════════════════════════════════════════
// Resource Collection Handlers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get all projects across federation
 */
export async function handleFederationResourcesProjects(
  _params: Record<string, unknown>,
): Promise<{ projects: Array<Record<string, unknown>> }> {
  const hub = getFederationHub();
  const localProjects = await getLocalProjects();

  // Add local projects
  const projects: Array<Record<string, unknown>> = localProjects.map((p) => ({
    ...p,
    sourceNode: "local",
    nodeName: "This Node",
    syncStatus: "synced",
    lastSync: Date.now(),
  }));

  // Get projects from connected nodes
  if (hub) {
    const connectedNodes = hub.getConnectedNodes();

    for (const node of connectedNodes) {
      try {
        const result = await invokeNodeMethod(hub, node.id, "kanban.list", { type: "projects" });
        const nodeProjects = (result as { projects?: Array<Record<string, unknown>> })?.projects ?? [];

        for (const proj of nodeProjects) {
          projects.push({
            ...proj,
            sourceNode: node.id,
            nodeName: node.manifest.name,
            syncStatus: "synced",
            lastSync: Date.now(),
          });
        }
      } catch (err) {
        log.debug(`Failed to get projects from node ${node.id}: ${err}`);
      }
    }
  }

  return { projects };
}

/**
 * Get all tasks across federation
 */
export async function handleFederationResourcesTasks(
  _params: Record<string, unknown>,
): Promise<{ tasks: Array<Record<string, unknown>> }> {
  const hub = getFederationHub();
  const localTasks = await getLocalTasks();

  // Add local tasks
  const tasks: Array<Record<string, unknown>> = localTasks.map((t) => ({
    ...t,
    sourceNode: "local",
    nodeName: "This Node",
    syncStatus: "synced",
    lastSync: Date.now(),
  }));

  // Get tasks from connected nodes
  if (hub) {
    const connectedNodes = hub.getConnectedNodes();

    for (const node of connectedNodes) {
      try {
        const result = await invokeNodeMethod(hub, node.id, "kanban.list", { type: "tasks" });
        const nodeTasks = (result as { tasks?: Array<Record<string, unknown>> })?.tasks ?? [];

        for (const task of nodeTasks) {
          tasks.push({
            ...task,
            sourceNode: node.id,
            nodeName: node.manifest.name,
            syncStatus: "synced",
            lastSync: Date.now(),
          });
        }
      } catch (err) {
        log.debug(`Failed to get tasks from node ${node.id}: ${err}`);
      }
    }
  }

  return { tasks };
}

/**
 * Get all agents across federation
 */
export async function handleFederationResourcesAgents(
  _params: Record<string, unknown>,
): Promise<{ agents: Array<Record<string, unknown>> }> {
  const hub = getFederationHub();
  const config = loadConfig();
  const localAgents = getLocalAgents(config);

  // Add local agents
  const agents: Array<Record<string, unknown>> = localAgents.map((a) => ({
    ...a,
    nodeId: "local",
    nodeName: "This Node",
    status: "idle",
    activeSessions: 0,
    lastSeen: Date.now(),
  }));

  // Get agents from connected nodes
  if (hub) {
    const connectedNodes = hub.getConnectedNodes();

    for (const node of connectedNodes) {
      const nodeAgents = node.manifest.capabilities.agents ?? [];

      for (const agentId of nodeAgents) {
        agents.push({
          id: agentId,
          nodeId: node.id,
          nodeName: node.manifest.name,
          status: node.state === "registered" ? "idle" : "offline",
          activeSessions: node.activeSessions,
          lastSeen: node.lastHeartbeat,
        });
      }
    }
  }

  return { agents };
}

/**
 * Get all MCP servers across federation
 */
export async function handleFederationResourcesMCP(
  _params: Record<string, unknown>,
): Promise<{ servers: Array<Record<string, unknown>> }> {
  const hub = getFederationHub();

  // Local MCP servers (not available in InfinibotConfig directly)
  const servers: Array<Record<string, unknown>> = [];

  // Get MCPs from connected nodes
  if (hub) {
    const connectedNodes = hub.getConnectedNodes();

    for (const node of connectedNodes) {
      const nodeMCPs = node.manifest.capabilities.mcpServers ?? [];

      for (const mcpName of nodeMCPs) {
        servers.push({
          id: mcpName,
          name: mcpName,
          nodeId: node.id,
          nodeName: node.manifest.name,
          status: "unknown",
          tools: [],
          sharedToFederation: true,
          lastSeen: node.lastHeartbeat,
        });
      }
    }
  }

  return { servers };
}

/**
 * Get business data sources across federation
 */
export async function handleFederationResourcesBusiness(
  _params: Record<string, unknown>,
): Promise<{ sources: Array<Record<string, unknown>> }> {
  const hub = getFederationHub();

  // Local business sources (placeholder - would connect to actual stores)
  const sources: Array<Record<string, unknown>> = [
    {
      id: "local-income",
      type: "income",
      name: "Income Streams",
      nodeId: "local",
      nodeName: "This Node",
      sharedToFederation: true,
      lastSync: Date.now(),
      recordCount: 0,
      status: "synced",
    },
  ];

  // Get business sources from connected nodes
  if (hub) {
    const connectedNodes = hub.getConnectedNodes();

    for (const node of connectedNodes) {
      // Query each node for business sources
      try {
        const result = await invokeNodeMethod(hub, node.id, "business.sources", {});
        const nodeSources = (result as { sources?: Array<Record<string, unknown>> })?.sources ?? [];

        for (const source of nodeSources) {
          sources.push({
            ...source,
            nodeId: node.id,
            nodeName: node.manifest.name,
            lastSeen: node.lastHeartbeat,
          });
        }
      } catch {
        // Node might not support business sources
      }
    }
  }

  return { sources };
}

// ══════════════════════════════════════════════════════════════════════════════
// Node Gateway Access
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get gateway info for a specific node
 */
export async function handleFederationNodeGateway(
  params: Record<string, unknown>,
): Promise<{ info: Record<string, unknown> }> {
  const nodeId = typeof params.nodeId === "string" ? params.nodeId : "";
  if (!nodeId) {
    throw new Error("nodeId is required");
  }

  const hub = getFederationHub();
  if (!hub) {
    throw new Error("Federation hub not available");
  }

  const node = hub.getNode(nodeId);
  if (!node) {
    throw new Error(`Node ${nodeId} not found`);
  }

  return {
    info: {
      nodeId: node.id,
      name: node.manifest.name,
      hostname: node.manifest.hostname,
      port: node.manifest.port,
      url: `ws://${node.manifest.hostname}:${node.manifest.port}`,
      wsUrl: `ws://${node.manifest.hostname}:${node.manifest.port}/ws`,
      httpUrl: `http://${node.manifest.hostname}:${node.manifest.port}`,
      connected: node.state === "registered",
      version: node.manifest.capabilities.platform,
      capabilities: node.manifest.capabilities,
    },
  };
}

/**
 * Connect to a node's gateway and get credentials
 */
export async function handleFederationNodeConnect(
  params: Record<string, unknown>,
): Promise<{ wsUrl: string; token: string }> {
  const nodeId = typeof params.nodeId === "string" ? params.nodeId : "";
  if (!nodeId) {
    throw new Error("nodeId is required");
  }

  const hub = getFederationHub();
  if (!hub) {
    throw new Error("Federation hub not available");
  }

  const node = hub.getNode(nodeId);
  if (!node || node.state !== "registered") {
    throw new Error(`Node ${nodeId} not connected`);
  }

  // Generate a temporary token for direct access
  // In production, this would use proper auth
  const token = `fed_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return {
    wsUrl: `ws://${node.manifest.hostname}:${node.manifest.port}/ws`,
    token,
  };
}

/**
 * Invoke a method on a remote node's gateway
 */
export async function handleFederationNodeInvoke(
  params: Record<string, unknown>,
): Promise<{ result: unknown }> {
  const nodeId = typeof params.nodeId === "string" ? params.nodeId : "";
  const method = typeof params.method === "string" ? params.method : "";
  const methodParams = (params.params as Record<string, unknown>) ?? {};

  if (!nodeId || !method) {
    throw new Error("nodeId and method are required");
  }

  const hub = getFederationHub();
  if (!hub) {
    throw new Error("Federation hub not available");
  }

  const result = await invokeNodeMethod(hub, nodeId, method, methodParams);
  return { result };
}

// ══════════════════════════════════════════════════════════════════════════════
// Resource Sharing Operations
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Share a project to specific nodes
 */
export async function handleFederationShareProject(
  params: Record<string, unknown>,
): Promise<{ success: boolean }> {
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  const targetNodes = Array.isArray(params.targetNodes) ? params.targetNodes : [];

  if (!projectId) {
    throw new Error("projectId is required");
  }

  const hub = getFederationHub();
  if (!hub) {
    throw new Error("Federation hub not available");
  }

  // Broadcast project to target nodes
  for (const nodeId of targetNodes) {
    if (typeof nodeId !== "string") continue;

    try {
      await invokeNodeMethod(hub, nodeId, "kanban.project.sync", {
        projectId,
        operation: "share",
      });
      log.info(`Shared project ${projectId} to node ${nodeId}`);
    } catch (err) {
      log.warn(`Failed to share project to ${nodeId}: ${err}`);
    }
  }

  return { success: true };
}

/**
 * Assign a task to a specific node and optionally agent
 */
export async function handleFederationAssignTask(
  params: Record<string, unknown>,
): Promise<{ success: boolean }> {
  const taskId = typeof params.taskId === "string" ? params.taskId : "";
  const nodeId = typeof params.nodeId === "string" ? params.nodeId : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : undefined;

  if (!taskId || !nodeId) {
    throw new Error("taskId and nodeId are required");
  }

  const hub = getFederationHub();

  // Update local task assignment
  const store = getKanbanStore();
  if (agentId) {
    await store.updateTask(taskId, { assignee: agentId });
  }

  // Notify target node
  if (hub && nodeId !== "local") {
    try {
      await invokeNodeMethod(hub, nodeId, "kanban.task.assign", {
        taskId,
        agentId,
      });
    } catch (err) {
      log.warn(`Failed to assign task to ${nodeId}: ${err}`);
    }
  }

  return { success: true };
}

/**
 * Share/unshare an MCP server to federation
 */
export async function handleFederationShareMCP(
  params: Record<string, unknown>,
): Promise<{ success: boolean }> {
  const mcpId = typeof params.mcpId === "string" ? params.mcpId : "";
  const share = params.share !== false;

  if (!mcpId) {
    throw new Error("mcpId is required");
  }

  // In a full implementation, this would update the MCP sharing config
  // and broadcast the change to connected nodes
  log.info(`${share ? "Sharing" : "Unsharing"} MCP ${mcpId} to federation`);

  const hub = getFederationHub();
  if (hub) {
    hub.broadcastUpdate({
      updates: [
        {
          type: "capabilities",
          value: { mcpSharing: { [mcpId]: share } },
        },
      ],
    });
  }

  return { success: true };
}

/**
 * Full sync across all federation nodes
 */
export async function handleFederationSync(
  params: Record<string, unknown>,
): Promise<{ success: boolean; synced: number }> {
  const full = params.full === true;
  const hub = getFederationHub();

  if (!hub) {
    return { success: true, synced: 0 };
  }

  const connectedNodes = hub.getConnectedNodes();
  let synced = 0;

  for (const node of connectedNodes) {
    try {
      if (full) {
        // Full sync: push and pull all resources
        await invokeNodeMethod(hub, node.id, "federation.sync.pull", {});
      }
      synced++;
    } catch (err) {
      log.warn(`Failed to sync with node ${node.id}: ${err}`);
    }
  }

  log.info(`Federation sync complete: ${synced}/${connectedNodes.length} nodes synced`);
  return { success: true, synced };
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

async function getLocalProjects(): Promise<Array<Record<string, unknown>>> {
  try {
    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const store = getKanbanStore(stateDir);
    const projects = await store.getProjects();
    const tasks = await store.getTasks();

    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      taskCount: tasks.filter((t) => t.projectId === p.id).length,
      sharedWith: [],
    }));
  } catch {
    return [];
  }
}

async function getLocalTasks(): Promise<Array<Record<string, unknown>>> {
  try {
    const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
    const store = getKanbanStore(stateDir);
    const tasks = await store.getTasks();
    const projects = await store.getProjects();
    const projectMap = new Map(projects.map((p) => [p.id, p.name]));

    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority ?? "medium",
      projectId: t.projectId,
      projectName: t.projectId ? projectMap.get(t.projectId) : undefined,
      assignedAgent: t.assignee,
    }));
  } catch {
    return [];
  }
}

function getLocalAgents(config?: InfinibotConfig): Array<Record<string, unknown>> {
  if (!config?.agents) return [];

  const agentsList = config.agents.list ?? [];
  return agentsList.map((a) => ({
    id: a.id,
    name: a.name,
    isDefault: a.default ?? false,
    specialties: [],
  }));
}

async function invokeNodeMethod(
  hub: ReturnType<typeof getFederationHub>,
  nodeId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  if (!hub) throw new Error("Federation hub not available");

  const node = hub.getNode(nodeId);
  if (!node || node.state !== "registered") {
    throw new Error(`Node ${nodeId} not connected`);
  }

  // Use the hub's invoke mechanism
  // This is a simplified version - real implementation would use proper RPC
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timeout"));
    }, 10000);

    const messageId = `invoke_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const message = JSON.stringify({
      type: "invoke",
      messageId,
      payload: { method, params },
      nodeId: "master",
      timestamp: Date.now(),
    });

    // Send message to node
    try {
      node.socket.send(message);

      // For now, resolve immediately - real implementation would wait for response
      clearTimeout(timeout);
      resolve({});
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });
}
