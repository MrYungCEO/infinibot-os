/**
 * Mesh State Store
 *
 * CRDT-backed state store for the Agent Mesh Network.
 * Enables agents to communicate, discover each other, and coordinate
 * complex workflows across federation nodes.
 *
 * Features:
 * - Agent registration and discovery
 * - Direct agent-to-agent messaging
 * - Orchestration chain tracking (parent/child relationships)
 * - Cross-node synchronization via CRDT
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { LWWMap, generateTimestamp } from "./crdt.js";
import { getEventBus, type FederationEventType } from "./event-bus.js";

const log = createSubsystemLogger("federation").child("mesh-state");

// =============================================================================
// Types
// =============================================================================

/** Agent status in the mesh */
export type MeshAgentStatus =
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "finishing"
  | "completed"
  | "failed";

/** Agent in the mesh network */
export interface MeshAgent {
  /** Unique session key (e.g., agent:coder:discord-abc123) */
  sessionKey: string;
  /** Agent type ID (e.g., 'coder', 'architect', 'tester') */
  agentId: string;
  /** Human-readable label for UI */
  label: string;
  /** Federation node ID where agent runs */
  nodeId: string;
  /** Human-readable node name */
  nodeName: string;
  /** Agent capabilities (e.g., ['typescript', 'react', 'testing']) */
  capabilities: string[];
  /** Current status */
  status: MeshAgentStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Current task description */
  currentTask?: string;
  /** Parent session key (for orchestration chains) */
  parent?: string;
  /** Child session keys */
  children: string[];
  /** Whether this agent can spawn other agents */
  canSpawn: boolean;
  /** When the agent was spawned */
  spawnedAt: number;
  /** Last activity timestamp */
  lastActivity: number;
  /** Total messages sent/received */
  messageCount: number;
  /** Run ID for tracking */
  runId?: string;
  /** Checkpoints reached */
  checkpoints: string[];
}

/** Message priority levels */
export type MessagePriority = "low" | "normal" | "high" | "critical";

/** Message types in the mesh */
export type MeshMessageType = "request" | "response" | "broadcast" | "event";

/** Message in the mesh network */
export interface MeshMessage {
  /** Unique message ID */
  id: string;
  /** Sender session key */
  from: string;
  /** Recipient session key (or 'broadcast') */
  to: string;
  /** Message type */
  type: MeshMessageType;
  /** Message payload */
  payload: {
    action?: string;
    message?: string;
    data?: Record<string, unknown>;
    priority?: MessagePriority;
    replyTo?: string;
  };
  /** When message was sent */
  timestamp: number;
  /** Whether message was delivered */
  delivered: boolean;
  /** Whether message was read */
  read: boolean;
  /** Source node ID */
  sourceNodeId?: string;
}

/** Subscription handler for messages */
export type MessageHandler = (message: MeshMessage) => void;

/** Agent scoring for task assignment */
export interface AgentScore {
  sessionKey: string;
  agentId: string;
  nodeId: string;
  score: number;
  reasons: string[];
}

/** Orchestration chain info */
export interface OrchestrationChain {
  root: string;
  children: string[];
  depth: number;
  agents: MeshAgent[];
}

// =============================================================================
// Mesh State Store
// =============================================================================

export class MeshStateStore extends EventEmitter {
  /** CRDT-backed agent registry */
  private agents: LWWMap<string, MeshAgent>;
  
  /** Message queue (recent messages for replay) */
  private messages: MeshMessage[] = [];
  
  /** Message subscriptions by session key */
  private subscriptions: Map<string, Set<MessageHandler>> = new Map();
  
  /** Broadcast subscriptions */
  private broadcastSubscriptions: Set<MessageHandler> = new Set();
  
  /** Local node ID */
  private nodeId: string;
  
  /** Maximum messages to retain */
  private maxMessages = 1000;
  
  /** Maximum message age in ms (1 hour) */
  private maxMessageAge = 60 * 60 * 1000;

  constructor(nodeId: string = "local") {
    super();
    this.nodeId = nodeId;
    this.agents = new LWWMap<string, MeshAgent>();
    this.setMaxListeners(100);
    log.info(`mesh state store initialized for node: ${nodeId}`);
  }

  // ===========================================================================
  // Node Identity
  // ===========================================================================

  /**
   * Get the current node ID
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Update the node ID
   */
  setNodeId(nodeId: string): void {
    this.nodeId = nodeId;
    log.debug(`node ID updated to: ${nodeId}`);
  }

  // ===========================================================================
  // Agent Lifecycle
  // ===========================================================================

  /**
   * Register an agent in the mesh
   */
  register(agent: MeshAgent): void {
    const timestamp = generateTimestamp();
    this.agents.set(agent.sessionKey, agent, timestamp, this.nodeId);
    
    log.info(`agent registered: ${agent.label} (${agent.sessionKey}) on ${agent.nodeName}`);
    this.emit("agent:registered", agent);
    
    // Publish to federation event bus
    this.publishMeshEvent("session.spawned", {
      sessionKey: agent.sessionKey,
      agentId: agent.agentId,
      label: agent.label,
      nodeId: agent.nodeId,
      nodeName: agent.nodeName,
      capabilities: agent.capabilities,
      parent: agent.parent,
      canSpawn: agent.canSpawn,
    });
  }

  /**
   * Unregister an agent from the mesh
   */
  unregister(sessionKey: string, reason?: string): void {
    const agent = this.agents.get(sessionKey);
    if (!agent) return;
    
    const timestamp = generateTimestamp();
    this.agents.delete(sessionKey, timestamp, this.nodeId);
    
    // Remove from parent's children list
    if (agent.parent) {
      const parent = this.agents.get(agent.parent);
      if (parent) {
        parent.children = parent.children.filter(c => c !== sessionKey);
        this.agents.set(agent.parent, parent, timestamp, this.nodeId);
      }
    }
    
    log.info(`agent unregistered: ${agent.label} (${sessionKey}), reason: ${reason || "unknown"}`);
    this.emit("agent:unregistered", { sessionKey, reason });
    
    // Publish to federation event bus
    this.publishMeshEvent("session.completed", {
      sessionKey,
      agentId: agent.agentId,
      label: agent.label,
      nodeId: agent.nodeId,
      reason,
    });
  }

  /**
   * Update agent status
   */
  updateStatus(sessionKey: string, update: Partial<MeshAgent>): void {
    const existing = this.agents.get(sessionKey);
    if (!existing) {
      log.warn(`cannot update unknown agent: ${sessionKey}`);
      return;
    }

    const updated: MeshAgent = {
      ...existing,
      ...update,
      sessionKey: existing.sessionKey, // Cannot change session key
      lastActivity: Date.now(),
    };

    const timestamp = generateTimestamp();
    this.agents.set(sessionKey, updated, timestamp, this.nodeId);

    log.debug(`agent updated: ${sessionKey} -> ${JSON.stringify(update)}`);
    this.emit("agent:updated", updated);
    
    // Publish progress events
    if (update.status || update.progress !== undefined) {
      this.publishMeshEvent("session.progress", {
        sessionKey,
        agentId: updated.agentId,
        label: updated.label,
        status: updated.status,
        progress: updated.progress,
        currentTask: updated.currentTask,
      });
    }
  }

  /**
   * Add a checkpoint to an agent
   */
  addCheckpoint(sessionKey: string, checkpoint: string): void {
    const existing = this.agents.get(sessionKey);
    if (!existing) return;

    const checkpoints = [...existing.checkpoints, checkpoint];
    this.updateStatus(sessionKey, { checkpoints });
    
    log.info(`checkpoint added to ${sessionKey}: ${checkpoint}`);
  }

  /**
   * Get an agent by session key
   */
  getAgent(sessionKey: string): MeshAgent | undefined {
    return this.agents.get(sessionKey);
  }

  /**
   * Get all agents
   */
  getAllAgents(): MeshAgent[] {
    return this.agents.keys().map(k => this.agents.get(k)!);
  }

  // ===========================================================================
  // Discovery
  // ===========================================================================

  /**
   * Find agents by capability
   */
  findByCapability(capabilities: string[]): MeshAgent[] {
    if (!capabilities.length) return this.getAllAgents();
    
    return this.getAllAgents().filter(agent => 
      capabilities.every(cap => agent.capabilities.includes(cap))
    );
  }

  /**
   * Find agents by status
   */
  findByStatus(status: MeshAgentStatus | MeshAgentStatus[]): MeshAgent[] {
    const statuses = Array.isArray(status) ? status : [status];
    return this.getAllAgents().filter(agent => statuses.includes(agent.status));
  }

  /**
   * Find agents by node
   */
  findByNode(nodeId: string): MeshAgent[] {
    return this.getAllAgents().filter(agent => agent.nodeId === nodeId);
  }

  /**
   * Find agents by agent type
   */
  findByAgentId(agentId: string): MeshAgent[] {
    return this.getAllAgents().filter(agent => agent.agentId === agentId);
  }

  /**
   * Find the best agent for a task based on capabilities and load
   */
  findBestAgent(params: {
    requiredCapabilities: string[];
    preferNode?: string;
    excludeSessions?: string[];
    preferIdle?: boolean;
  }): AgentScore | null {
    const { requiredCapabilities, preferNode, excludeSessions = [], preferIdle = true } = params;
    
    // Get capable agents
    let candidates = this.findByCapability(requiredCapabilities);
    
    // Exclude specified sessions
    candidates = candidates.filter(a => !excludeSessions.includes(a.sessionKey));
    
    // Exclude completed/failed agents
    candidates = candidates.filter(a => !["completed", "failed"].includes(a.status));
    
    if (candidates.length === 0) return null;

    // Score each candidate
    const scores: AgentScore[] = candidates.map(agent => {
      let score = 100;
      const reasons: string[] = [];

      // Prefer idle agents
      if (preferIdle && agent.status === "idle") {
        score += 30;
        reasons.push("idle");
      } else if (agent.status === "blocked") {
        score -= 50;
        reasons.push("blocked");
      } else if (agent.status === "working") {
        score -= 10;
        reasons.push("busy");
      }

      // Prefer agents on specified node
      if (preferNode && agent.nodeId === preferNode) {
        score += 20;
        reasons.push("preferred-node");
      }

      // More capabilities = more specialized
      const capScore = Math.min(agent.capabilities.length * 5, 25);
      score += capScore;
      if (capScore > 0) reasons.push(`${agent.capabilities.length}-capabilities`);

      // Recent activity is good (within last 5 minutes)
      const minutesAgo = (Date.now() - agent.lastActivity) / 60000;
      if (minutesAgo < 5) {
        score += 10;
        reasons.push("recently-active");
      }

      // Penalize heavily loaded agents (many children)
      if (agent.children.length > 3) {
        score -= agent.children.length * 5;
        reasons.push(`${agent.children.length}-children`);
      }

      return {
        sessionKey: agent.sessionKey,
        agentId: agent.agentId,
        nodeId: agent.nodeId,
        score,
        reasons,
      };
    });

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);
    
    return scores[0] || null;
  }

  /**
   * Get the orchestration chain starting from a root agent
   */
  getOrchestrationChain(rootSession: string): OrchestrationChain | null {
    const root = this.agents.get(rootSession);
    if (!root) return null;

    // Find the true root (go up the parent chain)
    let current = root;
    while (current.parent) {
      const parent = this.agents.get(current.parent);
      if (!parent) break;
      current = parent;
    }

    // Now collect all children recursively
    const collectChildren = (sessionKey: string, depth: number): { agents: MeshAgent[]; maxDepth: number } => {
      const agent = this.agents.get(sessionKey);
      if (!agent) return { agents: [], maxDepth: depth };

      const result: MeshAgent[] = [agent];
      let maxDepth = depth;

      for (const childKey of agent.children) {
        const childResult = collectChildren(childKey, depth + 1);
        result.push(...childResult.agents);
        maxDepth = Math.max(maxDepth, childResult.maxDepth);
      }

      return { agents: result, maxDepth };
    };

    const { agents, maxDepth } = collectChildren(current.sessionKey, 0);

    return {
      root: current.sessionKey,
      children: agents.slice(1).map(a => a.sessionKey),
      depth: maxDepth,
      agents,
    };
  }

  // ===========================================================================
  // Messaging
  // ===========================================================================

  /**
   * Enqueue a message for delivery
   */
  enqueue(message: Omit<MeshMessage, "id" | "timestamp" | "delivered" | "read">): MeshMessage {
    const fullMessage: MeshMessage = {
      ...message,
      id: randomUUID(),
      timestamp: Date.now(),
      delivered: false,
      read: false,
      sourceNodeId: this.nodeId,
    };

    // Add to message queue
    this.messages.push(fullMessage);
    
    // Trim old messages
    this.pruneMessages();

    // Update sender's message count
    const sender = this.agents.get(message.from);
    if (sender) {
      this.updateStatus(message.from, { messageCount: sender.messageCount + 1 });
    }

    // Deliver to subscribers
    if (message.to === "broadcast") {
      fullMessage.delivered = true;
      this.broadcastSubscriptions.forEach(handler => {
        try {
          handler(fullMessage);
        } catch (err) {
          log.error(`broadcast handler error: ${err}`);
        }
      });
    } else {
      const handlers = this.subscriptions.get(message.to);
      if (handlers && handlers.size > 0) {
        fullMessage.delivered = true;
        handlers.forEach(handler => {
          try {
            handler(fullMessage);
          } catch (err) {
            log.error(`message handler error: ${err}`);
          }
        });
      }
    }

    log.debug(`message enqueued: ${fullMessage.id} from ${message.from} to ${message.to}`);
    this.emit("message:enqueued", fullMessage);
    
    // Publish to federation event bus
    this.publishMeshEvent("session.message", {
      messageId: fullMessage.id,
      from: message.from,
      to: message.to,
      type: message.type,
      delivered: fullMessage.delivered,
    });

    return fullMessage;
  }

  /**
   * Subscribe to messages for a session
   */
  subscribe(sessionKey: string, handler: MessageHandler): () => void {
    if (!this.subscriptions.has(sessionKey)) {
      this.subscriptions.set(sessionKey, new Set());
    }
    this.subscriptions.get(sessionKey)!.add(handler);
    
    log.debug(`subscription added for ${sessionKey}`);
    
    return () => {
      const handlers = this.subscriptions.get(sessionKey);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(sessionKey);
        }
      }
    };
  }

  /**
   * Subscribe to broadcast messages
   */
  subscribeBroadcast(handler: MessageHandler): () => void {
    this.broadcastSubscriptions.add(handler);
    
    return () => {
      this.broadcastSubscriptions.delete(handler);
    };
  }

  /**
   * Mark a message as read
   */
  markRead(messageId: string): void {
    const message = this.messages.find(m => m.id === messageId);
    if (message) {
      message.read = true;
      log.debug(`message marked read: ${messageId}`);
    }
  }

  /**
   * Get unread messages for a session
   */
  getUnread(sessionKey: string): MeshMessage[] {
    return this.messages.filter(m => 
      (m.to === sessionKey || m.to === "broadcast") &&
      !m.read
    );
  }

  /**
   * Get recent messages (for UI display)
   */
  getRecentMessages(limit: number = 50): MeshMessage[] {
    return this.messages.slice(-limit);
  }

  /**
   * Get messages between two sessions
   */
  getMessagesBetween(sessionA: string, sessionB: string, limit: number = 100): MeshMessage[] {
    return this.messages
      .filter(m => 
        (m.from === sessionA && m.to === sessionB) ||
        (m.from === sessionB && m.to === sessionA)
      )
      .slice(-limit);
  }

  // ===========================================================================
  // CRDT Sync
  // ===========================================================================

  /**
   * Merge state from another node
   */
  merge(other: MeshStateStore): void {
    this.agents.merge(other.agents);
    
    // Merge messages (dedup by ID)
    const messageIds = new Set(this.messages.map(m => m.id));
    for (const msg of other.messages) {
      if (!messageIds.has(msg.id)) {
        this.messages.push(msg);
        messageIds.add(msg.id);
      }
    }
    
    // Sort messages by timestamp
    this.messages.sort((a, b) => a.timestamp - b.timestamp);
    this.pruneMessages();
    
    log.debug("mesh state merged from remote node");
  }

  /**
   * Get serializable state for sync
   */
  toJSON(): {
    agents: ReturnType<LWWMap<string, MeshAgent>["toJSON"]>;
    messages: MeshMessage[];
    nodeId: string;
  } {
    return {
      agents: this.agents.toJSON(),
      messages: this.messages.slice(-this.maxMessages),
      nodeId: this.nodeId,
    };
  }

  /**
   * Restore state from JSON
   */
  static fromJSON(json: ReturnType<MeshStateStore["toJSON"]>): MeshStateStore {
    const store = new MeshStateStore(json.nodeId);
    store.agents = LWWMap.fromJSON<string, MeshAgent>(json.agents);
    store.messages = json.messages || [];
    return store;
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get mesh status summary
   */
  getStatus(): {
    totalAgents: number;
    byNode: Record<string, number>;
    byStatus: Record<string, number>;
    byAgentId: Record<string, number>;
    orchestrationChains: OrchestrationChain[];
    recentMessages: MeshMessage[];
    activeSubscriptions: number;
  } {
    const agents = this.getAllAgents();
    
    const byNode: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byAgentId: Record<string, number> = {};
    
    for (const agent of agents) {
      byNode[agent.nodeId] = (byNode[agent.nodeId] || 0) + 1;
      byStatus[agent.status] = (byStatus[agent.status] || 0) + 1;
      byAgentId[agent.agentId] = (byAgentId[agent.agentId] || 0) + 1;
    }

    // Find all root agents (no parent) and build chains
    const roots = agents.filter(a => !a.parent);
    const chains: OrchestrationChain[] = [];
    
    for (const root of roots) {
      const chain = this.getOrchestrationChain(root.sessionKey);
      if (chain && chain.agents.length > 1) {
        chains.push(chain);
      }
    }

    return {
      totalAgents: agents.length,
      byNode,
      byStatus,
      byAgentId,
      orchestrationChains: chains,
      recentMessages: this.messages.slice(-20),
      activeSubscriptions: this.subscriptions.size + this.broadcastSubscriptions.size,
    };
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Publish an event to the federation event bus
   */
  private publishMeshEvent(type: FederationEventType, payload: Record<string, unknown>): void {
    try {
      const eventBus = getEventBus();
      eventBus.publish(type, {
        ...payload,
        mesh: true,
      });
    } catch (err) {
      // Event bus may not be initialized yet
      log.debug(`failed to publish mesh event: ${err}`);
    }
  }

  /**
   * Prune old messages
   */
  private pruneMessages(): void {
    const cutoff = Date.now() - this.maxMessageAge;
    
    // Remove old messages
    this.messages = this.messages.filter(m => m.timestamp > cutoff);
    
    // Trim to max size
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  /**
   * Clear all state (for testing)
   */
  clear(): void {
    this.agents = new LWWMap<string, MeshAgent>();
    this.messages = [];
    this.subscriptions.clear();
    this.broadcastSubscriptions.clear();
    this.removeAllListeners();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let _meshState: MeshStateStore | null = null;

/**
 * Get the singleton mesh state store
 */
export function getMeshState(): MeshStateStore {
  if (!_meshState) {
    _meshState = new MeshStateStore("local");
  }
  return _meshState;
}

/**
 * Initialize the mesh state store with a specific node ID
 */
export function initMeshState(nodeId: string): MeshStateStore {
  if (_meshState) {
    log.warn("mesh state already initialized, updating node ID");
    _meshState.setNodeId(nodeId);
    return _meshState;
  }
  _meshState = new MeshStateStore(nodeId);
  return _meshState;
}

/**
 * Reset the mesh state (for testing)
 */
export function resetMeshState(): void {
  if (_meshState) {
    _meshState.clear();
    _meshState = null;
  }
}

// =============================================================================
// Convenience Helpers
// =============================================================================

/**
 * Register an agent in the global mesh
 */
export function registerMeshAgent(agent: Omit<MeshAgent, "children" | "messageCount" | "checkpoints">): MeshAgent {
  const fullAgent: MeshAgent = {
    ...agent,
    children: [],
    messageCount: 0,
    checkpoints: [],
  };
  getMeshState().register(fullAgent);
  return fullAgent;
}

/**
 * Update an agent's status in the global mesh
 */
export function updateMeshAgentStatus(sessionKey: string, update: Partial<MeshAgent>): void {
  getMeshState().updateStatus(sessionKey, update);
}

/**
 * Send a message in the global mesh
 */
export function sendMeshMessage(
  from: string,
  to: string,
  type: MeshMessageType,
  payload: MeshMessage["payload"]
): MeshMessage {
  return getMeshState().enqueue({ from, to, type, payload });
}

/**
 * Find agents by capability in the global mesh
 */
export function discoverMeshAgents(params: {
  capabilities?: string[];
  status?: MeshAgentStatus | MeshAgentStatus[];
  agentId?: string;
  nodeId?: string;
}): MeshAgent[] {
  const state = getMeshState();
  let agents = state.getAllAgents();

  if (params.capabilities?.length) {
    agents = agents.filter(a => 
      params.capabilities!.every(cap => a.capabilities.includes(cap))
    );
  }

  if (params.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    agents = agents.filter(a => statuses.includes(a.status));
  }

  if (params.agentId) {
    agents = agents.filter(a => a.agentId === params.agentId);
  }

  if (params.nodeId) {
    agents = agents.filter(a => a.nodeId === params.nodeId);
  }

  return agents;
}
