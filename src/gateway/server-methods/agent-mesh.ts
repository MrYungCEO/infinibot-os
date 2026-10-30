/**
 * Agent Mesh Gateway Methods
 *
 * Gateway handlers for the Agent Mesh Network - enabling agent-to-agent
 * communication, discovery, and orchestration across federation nodes.
 */

import crypto from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
// Event bus used for publishing mesh events (accessed via getMeshState)
import { getFederationHub } from "../../federation/hub.js";
import {
  getMeshState,
  registerMeshAgent,
  updateMeshAgentStatus,
  sendMeshMessage,
  discoverMeshAgents,
  type MeshAgent,
  type MeshAgentStatus,
  type MeshMessageType,
  type MeshMessage,
} from "../../federation/mesh-state.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { buildSubagentSystemPrompt } from "../../agents/subagent-announce.js";
import { registerSubagentRun } from "../../agents/subagent-registry.js";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway").child("agent-mesh");

// =============================================================================
// Types
// =============================================================================

interface MeshSpawnParams {
  agentId: string;
  task: string;
  label?: string;
  node?: string;
  parent?: string;
  capabilities?: string[];
  canSpawn?: boolean;
  timeout?: number;
  model?: string;
  thinking?: string;
}

interface MeshSendParams {
  to: string;
  type?: MeshMessageType;
  payload?: {
    action?: string;
    message?: string;
    data?: Record<string, unknown>;
    priority?: "low" | "normal" | "high" | "critical";
    replyTo?: string;
  };
}

interface MeshDiscoverParams {
  capabilities?: string[];
  agentId?: string;
  status?: MeshAgentStatus | MeshAgentStatus[];
  node?: string;
}

interface MeshFindBestParams {
  requiredCapabilities: string[];
  preferNode?: string;
  excludeSessions?: string[];
}

interface MeshDelegateParams {
  task: string;
  requiredCapabilities: string[];
  priority?: "low" | "normal" | "high" | "critical";
  preferExisting?: boolean;
  node?: string;
  label?: string;
  timeout?: number;
}

interface MeshKillParams {
  sessionKey: string;
  reason?: string;
  cascade?: boolean;
}

interface MeshWaitResponseParams {
  fromSession: string;
  timeout?: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get agent capabilities from config
 */
function getAgentCapabilities(agentId: string): string[] {
  const cfg = loadConfig();
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const capabilities: string[] = [];

  // Add agent-specific capabilities from config
  if (agentConfig?.capabilities) {
    capabilities.push(...agentConfig.capabilities);
  }

  // Infer capabilities from agent ID
  const agentIdLower = agentId.toLowerCase();
  const inferredCaps: Record<string, string[]> = {
    coder: ["typescript", "javascript", "coding", "debugging"],
    architect: ["architecture", "design", "planning"],
    tester: ["testing", "qa", "validation"],
    backend: ["backend", "api", "database"],
    frontend: ["frontend", "ui", "css", "react"],
    devops: ["infrastructure", "deployment", "ci-cd"],
    doc: ["documentation", "writing"],
    reviewer: ["code-review", "feedback"],
  };

  for (const [key, caps] of Object.entries(inferredCaps)) {
    if (agentIdLower.includes(key)) {
      capabilities.push(...caps);
    }
  }

  return [...new Set(capabilities)];
}

/**
 * Get the best agent type for given capabilities
 */
function recommendAgentForCapabilities(capabilities: string[]): string {
  const capSet = new Set(capabilities.map(c => c.toLowerCase()));

  if (capSet.has("testing") || capSet.has("qa")) return "tester";
  if (capSet.has("architecture") || capSet.has("design")) return "architect";
  if (capSet.has("frontend") || capSet.has("ui") || capSet.has("react")) return "frontend";
  if (capSet.has("backend") || capSet.has("api") || capSet.has("database")) return "backend";
  if (capSet.has("infrastructure") || capSet.has("deployment")) return "devops";
  if (capSet.has("documentation") || capSet.has("writing")) return "doc";
  if (capSet.has("code-review") || capSet.has("feedback")) return "reviewer";

  return "coder"; // Default
}

/**
 * Get node info from federation hub
 */
function getNodeInfo(): { nodeId: string; nodeName: string } {
  const hub = getFederationHub();
  if (hub) {
    const nodeId = hub.getEventBus().getNodeId();
    return { nodeId, nodeName: nodeId };
  }
  return { nodeId: "local", nodeName: "Local" };
}

// =============================================================================
// Gateway Handlers
// =============================================================================

export const agentMeshHandlers: GatewayRequestHandlers = {
  /**
   * Spawn an agent with mesh registration
   */
  "mesh.spawn": async ({ params, respond, context: _context }) => {
    const p = params as unknown as MeshSpawnParams;
    const task = typeof p.task === "string" ? p.task.trim() : "";
    const agentId = typeof p.agentId === "string" ? normalizeAgentId(p.agentId) : "coder";
    const label = typeof p.label === "string" ? p.label.trim() : `${agentId}-${Date.now()}`;
    const parentSession = typeof p.parent === "string" ? p.parent : undefined;
    const capabilities = Array.isArray(p.capabilities) ? p.capabilities : getAgentCapabilities(agentId);
    const canSpawn = p.canSpawn === true;
    const timeout = typeof p.timeout === "number" ? p.timeout : 0;
    const targetNode = typeof p.node === "string" ? p.node.trim() : undefined;

    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task is required"));
      return;
    }

    const _cfg = loadConfig(); // Reserved for future model config lookup
    const { nodeId: localNodeId, nodeName: localNodeName } = getNodeInfo();

    // Check if we need to spawn on a remote federation node
    const hub = getFederationHub();
    if (targetNode && hub) {
      // Look up the target node in federation
      const connectedNodes = hub.getConnectedNodes?.() ?? [];
      const targetNodeInfo = connectedNodes.find(
        (n) => n.id === targetNode || 
               n.manifest?.name?.toLowerCase() === targetNode.toLowerCase() ||
               n.id.toLowerCase().includes(targetNode.toLowerCase())
      );

      if (targetNodeInfo) {
        log.info(`mesh.spawn routing to federation node: ${targetNodeInfo.manifest?.name} (${targetNodeInfo.id})`);
        
        try {
          // Spawn on remote node via federation hub with shorter timeout
          const remoteResult = await Promise.race([
            hub.spawnRemoteSession({
              nodeId: targetNodeInfo.id,
              agentId,
              task,
              label,
              parentSession,
              capabilities,
              canSpawn,
              timeout,
              model: p.model,
              thinking: p.thinking,
            }),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error("Federation spawn timeout - satellite may not support remote spawning")), 15000)
            ),
          ]);

          // Register in local mesh state for tracking
          const remoteSessionKey = remoteResult.sessionKey || `agent:${agentId}:mesh:${crypto.randomUUID()}`;
          const remoteRunId = remoteResult.runId || crypto.randomUUID();

          registerMeshAgent({
            sessionKey: remoteSessionKey,
            agentId,
            label,
            nodeId: targetNodeInfo.id,
            nodeName: targetNodeInfo.manifest?.name || targetNodeInfo.id,
            capabilities,
            status: "starting",
            progress: 0,
            currentTask: task,
            parent: parentSession,
            canSpawn,
            spawnedAt: Date.now(),
            lastActivity: Date.now(),
            runId: remoteRunId,
          });

          // Persist remote session to session store for visibility in sessions.list
          const federationNodeName = targetNodeInfo.manifest?.name || targetNodeInfo.id;
          const storeConfig = loadConfig().session?.store;
          const storePath = resolveStorePath(storeConfig, { agentId });
          void updateSessionStore(storePath, (store) => {
            const existing = store[remoteSessionKey];
            store[remoteSessionKey] = {
              ...existing,
              updatedAt: Date.now(),
              label: label || existing?.label,
              federationNode: federationNodeName,
              federationRemote: true,
            };
            return store[remoteSessionKey];
          }).catch((err) => {
            log.warn(`mesh.spawn: Failed to persist remote session to store: ${err}`);
          });

          respond(true, {
            sessionKey: remoteSessionKey,
            nodeId: targetNodeInfo.id,
            nodeName: targetNodeInfo.manifest?.name || targetNodeInfo.id,
            agentId,
            label,
            runId: remoteRunId,
            capabilities,
            parent: parentSession,
            remote: true,
          }, undefined);
          return;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          log.warn(`mesh.spawn failed on remote node ${targetNodeInfo.id}: ${error} - falling back to local spawn`);
          // Fall through to local spawn
        }
      } else {
        // Node not found - fall back to local
        log.warn(`mesh.spawn: target node "${targetNode}" not found in federation, spawning locally`);
      }
    }

    // Local spawn (default path)
    const nodeId = localNodeId;
    const nodeName = localNodeName;

    // Generate session key
    const sessionKey = `agent:${agentId}:mesh:${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();

    try {
      // Build system prompt for the agent
      const systemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey: parentSession,
        childSessionKey: sessionKey,
        label,
        task,
      });

      // Apply model if specified
      if (p.model) {
        await callGateway({
          method: "sessions.patch",
          params: { key: sessionKey, model: p.model },
          timeoutMs: 10_000,
        });
      }

      // Spawn the agent via gateway
      const response = (await callGateway({
        method: "agent",
        params: {
          message: task,
          sessionKey,
          idempotencyKey: runId,
          deliver: false,
          lane: AGENT_LANE_SUBAGENT,
          extraSystemPrompt: systemPrompt,
          thinking: p.thinking,
          timeout: timeout > 0 ? timeout : undefined,
          label,
        },
        timeoutMs: 15_000,
      })) as { runId?: string };

      const actualRunId = response?.runId || runId;

      // Register in mesh state
      registerMeshAgent({
        sessionKey,
        agentId,
        label,
        nodeId,
        nodeName,
        capabilities,
        status: "starting",
        progress: 0,
        currentTask: task,
        parent: parentSession,
        canSpawn,
        spawnedAt: Date.now(),
        lastActivity: Date.now(),
        runId: actualRunId,
      });

      // If there's a parent, add this as a child
      if (parentSession) {
        const parent = getMeshState().getAgent(parentSession);
        if (parent) {
          updateMeshAgentStatus(parentSession, {
            children: [...parent.children, sessionKey],
          });
        }
      }

      // Register with subagent registry for lifecycle tracking
      registerSubagentRun({
        runId: actualRunId,
        childSessionKey: sessionKey,
        requesterSessionKey: parentSession || "mesh",
        requesterDisplayKey: parentSession || "mesh",
        task,
        cleanup: "keep",
        label,
        runTimeoutSeconds: timeout,
      });

      log.info(`mesh agent spawned: ${label} (${sessionKey}) on ${nodeName}`);

      respond(true, {
        sessionKey,
        nodeId,
        nodeName,
        agentId,
        label,
        runId: actualRunId,
        capabilities,
        parent: parentSession,
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.spawn failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Send a message to another agent
   */
  "mesh.send": async ({ params, respond }) => {
    const p = params as unknown as MeshSendParams;
    const to = typeof p.to === "string" ? p.to.trim() : "";
    const type: MeshMessageType = (p.type as MeshMessageType) || "request";
    const payload = p.payload || {};

    if (!to) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "to is required"));
      return;
    }

    // Get sender from context (would be set by the calling agent)
    const from = "mesh.system"; // In practice, this would come from auth context

    try {
      const message = sendMeshMessage(from, to, type, payload);

      // For cross-node messages, use federation
      const targetAgent = getMeshState().getAgent(to);
      const { nodeId: localNodeId } = getNodeInfo();

      if (targetAgent && targetAgent.nodeId !== localNodeId) {
        // Route through federation hub
        const hub = getFederationHub();
        if (hub) {
          hub.broadcastEvent({
            type: "session.message",
            timestamp: Date.now(),
            sourceNodeId: localNodeId,
            payload: {
              messageId: message.id,
              from,
              to,
              type,
              targetNodeId: targetAgent.nodeId,
            },
          });
        }
      }

      log.debug(`mesh message sent: ${message.id} from ${from} to ${to}`);

      respond(true, {
        delivered: message.delivered,
        messageId: message.id,
        targetNode: targetAgent?.nodeId,
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.send failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Discover agents matching criteria
   */
  "mesh.discover": async ({ params, respond }) => {
    const p = params as MeshDiscoverParams;

    try {
      const agents = discoverMeshAgents({
        capabilities: p.capabilities,
        agentId: p.agentId ? normalizeAgentId(p.agentId) : undefined,
        status: p.status,
        nodeId: p.node,
      });

      const result = agents.map(agent => ({
        sessionKey: agent.sessionKey,
        agentId: agent.agentId,
        label: agent.label,
        nodeId: agent.nodeId,
        nodeName: agent.nodeName,
        capabilities: agent.capabilities,
        status: agent.status,
        progress: agent.progress,
        currentTask: agent.currentTask,
        parent: agent.parent,
        canSpawn: agent.canSpawn,
      }));

      log.debug(`mesh.discover found ${result.length} agents`);

      respond(true, { agents: result }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.discover failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Find the best agent for a task
   */
  "mesh.findBest": async ({ params, respond }) => {
    const p = params as unknown as MeshFindBestParams;
    const requiredCapabilities = Array.isArray(p.requiredCapabilities)
      ? p.requiredCapabilities
      : [];

    try {
      const meshState = getMeshState();
      const score = meshState.findBestAgent({
        requiredCapabilities,
        preferNode: p.preferNode,
        excludeSessions: p.excludeSessions,
      });

      if (score) {
        respond(true, {
          found: true,
          agent: {
            sessionKey: score.sessionKey,
            agentId: score.agentId,
            nodeId: score.nodeId,
            score: score.score,
          },
          needsSpawn: false,
        }, undefined);
      } else {
        // No existing agent found, recommend spawning
        const recommendedAgent = recommendAgentForCapabilities(requiredCapabilities);
        const { nodeId } = getNodeInfo();

        respond(true, {
          found: false,
          needsSpawn: true,
          recommendedAgent,
          recommendedNode: p.preferNode || nodeId,
        }, undefined);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.findBest failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Delegate task to best available agent (spawn if needed)
   */
  "mesh.delegate": async ({ params, respond, context: _context }) => {
    const p = params as unknown as MeshDelegateParams;
    const task = typeof p.task === "string" ? p.task.trim() : "";
    const requiredCapabilities = Array.isArray(p.requiredCapabilities)
      ? p.requiredCapabilities
      : [];
    const preferExisting = p.preferExisting !== false;
    const label = typeof p.label === "string" ? p.label : undefined;
    const timeout = typeof p.timeout === "number" ? p.timeout : 0;

    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "task is required"));
      return;
    }

    try {
      let targetSession: string | undefined;
      let spawned = false;

      // Try to find existing agent
      if (preferExisting) {
        const meshState = getMeshState();
        const score = meshState.findBestAgent({
          requiredCapabilities,
          preferNode: p.node,
        });

        if (score) {
          targetSession = score.sessionKey;
        }
      }

      // Spawn new agent if needed
      if (!targetSession) {
        const recommendedAgent = recommendAgentForCapabilities(requiredCapabilities);
        const { nodeId, nodeName } = getNodeInfo();
        const sessionKey = `agent:${recommendedAgent}:mesh:${crypto.randomUUID()}`;
        const runId = crypto.randomUUID();

        // Build system prompt
        const systemPrompt = buildSubagentSystemPrompt({
          childSessionKey: sessionKey,
          label: label || `${recommendedAgent}-delegate`,
          task,
        });

        // Spawn the agent
        const response = (await callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey,
            idempotencyKey: runId,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: systemPrompt,
            timeout: timeout > 0 ? timeout : undefined,
            label: label || `${recommendedAgent}-delegate`,
          },
          timeoutMs: 15_000,
        })) as { runId?: string };

        const actualRunId = response?.runId || runId;

        // Register in mesh
        registerMeshAgent({
          sessionKey,
          agentId: recommendedAgent,
          label: label || `${recommendedAgent}-delegate`,
          nodeId,
          nodeName,
          capabilities: requiredCapabilities,
          status: "starting",
          progress: 0,
          currentTask: task,
          canSpawn: false,
          spawnedAt: Date.now(),
          lastActivity: Date.now(),
          runId: actualRunId,
        });

        // Register for lifecycle tracking
        registerSubagentRun({
          runId: actualRunId,
          childSessionKey: sessionKey,
          requesterSessionKey: "mesh.delegate",
          requesterDisplayKey: "mesh.delegate",
          task,
          cleanup: "keep",
          label: label || `${recommendedAgent}-delegate`,
          runTimeoutSeconds: timeout,
        });

        targetSession = sessionKey;
        spawned = true;

        log.info(`mesh.delegate spawned new agent: ${recommendedAgent} (${sessionKey})`);
      } else {
        // Send task to existing agent
        sendMeshMessage("mesh.delegate", targetSession, "request", {
          action: "execute",
          message: task,
          priority: p.priority || "normal",
        });

        log.info(`mesh.delegate sent task to existing agent: ${targetSession}`);
      }

      const agent = getMeshState().getAgent(targetSession);

      respond(true, {
        delegatedTo: targetSession,
        spawned,
        nodeId: agent?.nodeId || "local",
        agentId: agent?.agentId || "unknown",
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.delegate failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Get full mesh status
   */
  "mesh.status": async ({ respond }) => {
    try {
      const status = getMeshState().getStatus();

      respond(true, {
        totalAgents: status.totalAgents,
        byNode: status.byNode,
        byStatus: status.byStatus,
        byAgentId: status.byAgentId,
        orchestrationChains: status.orchestrationChains.map(chain => ({
          root: chain.root,
          children: chain.children,
          depth: chain.depth,
        })),
        recentMessages: status.recentMessages.slice(-20).map(msg => ({
          from: msg.from,
          to: msg.to,
          type: msg.type,
          timestamp: msg.timestamp,
        })),
        activeSubscriptions: status.activeSubscriptions,
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.status failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Kill an agent session
   */
  "mesh.kill": async ({ params, respond }) => {
    const p = params as unknown as MeshKillParams;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    const reason = typeof p.reason === "string" ? p.reason : "killed via mesh.kill";
    const cascade = p.cascade === true;

    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    try {
      const meshState = getMeshState();
      const agent = meshState.getAgent(sessionKey);

      if (!agent) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Agent ${sessionKey} not found`));
        return;
      }

      // If cascade, kill children first
      if (cascade && agent.children.length > 0) {
        for (const childKey of agent.children) {
          meshState.unregister(childKey, `cascade from ${sessionKey}: ${reason}`);
          try {
            await callGateway({
              method: "sessions.delete",
              params: { key: childKey, deleteTranscript: false },
              timeoutMs: 10_000,
            });
          } catch {
            // Best effort
          }
        }
      }

      // Unregister from mesh
      meshState.unregister(sessionKey, reason);

      // Delete the session
      try {
        await callGateway({
          method: "sessions.delete",
          params: { key: sessionKey, deleteTranscript: false },
          timeoutMs: 10_000,
        });
      } catch {
        // Best effort
      }

      log.info(`mesh.kill: ${sessionKey} (reason: ${reason}, cascade: ${cascade})`);

      respond(true, {
        killed: true,
        sessionKey,
        cascadeKilled: cascade ? agent.children : [],
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.kill failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Wait for a response from a specific session
   */
  "mesh.waitResponse": async ({ params, respond }) => {
    const p = params as unknown as MeshWaitResponseParams;
    const fromSession = typeof p.fromSession === "string" ? p.fromSession.trim() : "";
    const timeout = typeof p.timeout === "number" ? p.timeout : 300;

    if (!fromSession) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "fromSession is required"));
      return;
    }

    try {
      const meshState = getMeshState();

      // Subscribe to messages from the target session
      const response = await new Promise<{
        received: boolean;
        response?: unknown;
        timeout: boolean;
      }>((resolve) => {
        const timeoutId = setTimeout(() => {
          resolve({ received: false, timeout: true });
        }, timeout * 1000);

        const unsubscribe = meshState.subscribeBroadcast((message) => {
          if (message.from === fromSession && message.type === "response") {
            clearTimeout(timeoutId);
            unsubscribe();
            resolve({
              received: true,
              response: message.payload,
              timeout: false,
            });
          }
        });
      });

      respond(true, response, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.waitResponse failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Update agent status from within an agent
   */
  "mesh.updateStatus": async ({ params, respond }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";
    const status = params?.status as MeshAgentStatus | undefined;
    const progress = typeof params?.progress === "number" ? params.progress : undefined;
    const currentTask = typeof params?.currentTask === "string" ? params.currentTask : undefined;
    const checkpoint = typeof params?.checkpoint === "string" ? params.checkpoint : undefined;

    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    try {
      const meshState = getMeshState();
      const agent = meshState.getAgent(sessionKey);

      if (!agent) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Agent ${sessionKey} not found`));
        return;
      }

      const updates: Partial<MeshAgent> = {};
      if (status) updates.status = status;
      if (progress !== undefined) updates.progress = progress;
      if (currentTask) updates.currentTask = currentTask;

      updateMeshAgentStatus(sessionKey, updates);

      if (checkpoint) {
        meshState.addCheckpoint(sessionKey, checkpoint);
      }

      respond(true, { ok: true }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.updateStatus failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Get messages for a session
   */
  "mesh.getMessages": async ({ params, respond }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";
    const unreadOnly = params?.unreadOnly === true;
    const limit = typeof params?.limit === "number" ? params.limit : 50;

    try {
      const meshState = getMeshState();

      let messages: MeshMessage[];
      if (sessionKey && unreadOnly) {
        messages = meshState.getUnread(sessionKey);
      } else if (sessionKey) {
        messages = meshState.getRecentMessages(limit).filter(
          m => m.to === sessionKey || m.from === sessionKey
        );
      } else {
        messages = meshState.getRecentMessages(limit);
      }

      respond(true, {
        messages: messages.map(m => ({
          id: m.id,
          from: m.from,
          to: m.to,
          type: m.type,
          payload: m.payload,
          timestamp: m.timestamp,
          delivered: m.delivered,
          read: m.read,
        })),
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.getMessages failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Get a specific agent's info
   */
  "mesh.getAgent": async ({ params, respond }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";

    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    try {
      const agent = getMeshState().getAgent(sessionKey);

      if (!agent) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Agent ${sessionKey} not found`));
        return;
      }

      respond(true, {
        agent: {
          sessionKey: agent.sessionKey,
          agentId: agent.agentId,
          label: agent.label,
          nodeId: agent.nodeId,
          nodeName: agent.nodeName,
          capabilities: agent.capabilities,
          status: agent.status,
          progress: agent.progress,
          currentTask: agent.currentTask,
          parent: agent.parent,
          children: agent.children,
          canSpawn: agent.canSpawn,
          spawnedAt: agent.spawnedAt,
          lastActivity: agent.lastActivity,
          messageCount: agent.messageCount,
          checkpoints: agent.checkpoints,
        },
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.getAgent failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },

  /**
   * Get orchestration chain for an agent
   */
  "mesh.getChain": async ({ params, respond }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";

    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }

    try {
      const chain = getMeshState().getOrchestrationChain(sessionKey);

      if (!chain) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Chain for ${sessionKey} not found`));
        return;
      }

      respond(true, {
        chain: {
          root: chain.root,
          children: chain.children,
          depth: chain.depth,
          agents: chain.agents.map(a => ({
            sessionKey: a.sessionKey,
            agentId: a.agentId,
            label: a.label,
            status: a.status,
            progress: a.progress,
          })),
        },
      }, undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`mesh.getChain failed: ${error}`);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, error));
    }
  },
};

// =============================================================================
// Export for Gateway Registration
// =============================================================================

export default agentMeshHandlers;
