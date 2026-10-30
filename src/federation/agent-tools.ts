/**
 * Federation Agent Tools
 *
 * Helper functions for cross-node agent operations in the federation.
 * These enable agents to spawn sessions, send messages, and query sessions
 * on remote nodes connected to the federation hub.
 */

import { callGateway } from "../gateway/call.js";
import { loadConfig } from "../config/config.js";

export type FederatedNodeInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  connected: boolean;
  caps: string[];
  commands: string[];
  workspace?: string;
};

export type RemoteSessionHandle = {
  node: string;
  sessionKey: string;
  runId: string;
  status: "accepted" | "error";
  error?: string;
};

export type RemoteMessageResult = {
  node: string;
  sessionKey: string;
  runId: string;
  status: "ok" | "accepted" | "timeout" | "error" | "forbidden";
  reply?: string;
  error?: string;
};

export type RemoteSessionInfo = {
  node: string;
  key: string;
  kind: string;
  channel?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  model?: string;
};

/**
 * Check if a node is connected to the federation hub
 * Checks BOTH federation satellites AND mobile nodes
 */
export async function isNodeConnected(nodeId: string): Promise<boolean> {
  // First check federation satellites (primary for spawn routing)
  try {
    const fedResult = (await callGateway({
      method: "federation.nodes.list",
      params: {},
      timeoutMs: 5000,
    })) as { nodes?: Array<{ id: string; name?: string; status?: string; role?: string }> };

    const fedNodes = fedResult?.nodes ?? [];
    const fedNode = fedNodes.find(
      (n) => n.id === nodeId || n.name?.toLowerCase() === nodeId.toLowerCase(),
    );

    if (fedNode && fedNode.status === "online") {
      return true;
    }
  } catch {
    // Federation check failed, continue to mobile nodes
  }

  // Fallback: check mobile nodes (node.describe)
  try {
    const result = (await callGateway({
      method: "node.describe",
      params: { nodeId },
      timeoutMs: 5000,
    })) as { connected?: boolean };
    return result?.connected === true;
  } catch {
    return false;
  }
}

/**
 * Get list of all connected federation nodes
 * Includes BOTH federation satellites AND mobile nodes
 */
export async function getConnectedNodes(): Promise<FederatedNodeInfo[]> {
  const allNodes: FederatedNodeInfo[] = [];

  // Get federation satellites first
  try {
    const fedResult = (await callGateway({
      method: "federation.nodes.list",
      params: {},
      timeoutMs: 10000,
    })) as {
      nodes?: Array<{
        id: string;
        name?: string;
        status?: string;
        role?: string;
        platform?: string;
        capabilities?: {
          mcpServers?: string[];
          agents?: string[];
          workspaces?: string[];
        };
      }>;
    };

    const fedNodes = fedResult?.nodes ?? [];
    for (const n of fedNodes) {
      if (n.status === "online" && n.role === "satellite") {
        allNodes.push({
          nodeId: n.id,
          displayName: n.name || n.id,
          platform: n.platform,
          connected: true,
          caps: n.capabilities?.agents ?? [],
          commands: [],
          workspace: n.capabilities?.workspaces?.[0],
        });
      }
    }
  } catch {
    // Federation check failed, continue
  }

  // Also get mobile nodes
  try {
    const result = (await callGateway({
      method: "node.list",
      params: {},
      timeoutMs: 10000,
    })) as { nodes?: FederatedNodeInfo[] };

    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
    for (const n of nodes) {
      if (n.connected && !allNodes.some((existing) => existing.nodeId === n.nodeId)) {
        allNodes.push(n);
      }
    }
  } catch {
    // Mobile nodes check failed
  }

  return allNodes;
}

/**
 * Get detailed info about a specific node
 * Checks BOTH federation satellites AND mobile nodes
 */
export async function describeNode(nodeId: string): Promise<FederatedNodeInfo | null> {
  // First check federation satellites
  try {
    const fedResult = (await callGateway({
      method: "federation.nodes.list",
      params: {},
      timeoutMs: 5000,
    })) as {
      nodes?: Array<{
        id: string;
        name?: string;
        status?: string;
        role?: string;
        platform?: string;
        capabilities?: {
          mcpServers?: string[];
          agents?: string[];
          workspaces?: string[];
        };
      }>;
    };

    const fedNodes = fedResult?.nodes ?? [];
    const fedNode = fedNodes.find(
      (n) => n.id === nodeId || n.name?.toLowerCase() === nodeId.toLowerCase(),
    );

    if (fedNode && fedNode.status === "online") {
      return {
        nodeId: fedNode.id,
        displayName: fedNode.name || fedNode.id,
        platform: fedNode.platform,
        connected: true,
        caps: fedNode.capabilities?.agents ?? [],
        commands: [],
        workspace: fedNode.capabilities?.workspaces?.[0],
      };
    }
  } catch {
    // Federation check failed, continue
  }

  // Fallback to mobile nodes
  try {
    const result = (await callGateway({
      method: "node.describe",
      params: { nodeId },
      timeoutMs: 5000,
    })) as FederatedNodeInfo & { connected?: boolean };

    if (!result || !result.connected) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Helper to check if a node is a federation satellite (vs mobile node)
 */
async function isFederationSatellite(
  nodeId: string,
): Promise<{ isSatellite: boolean; resolvedId?: string }> {
  try {
    const fedResult = (await callGateway({
      method: "federation.nodes.list",
      params: {},
      timeoutMs: 5000,
    })) as { nodes?: Array<{ id: string; name?: string; status?: string; role?: string }> };

    const fedNodes = fedResult?.nodes ?? [];
    const fedNode = fedNodes.find(
      (n) => n.id === nodeId || n.name?.toLowerCase() === nodeId.toLowerCase(),
    );

    if (fedNode && fedNode.role === "satellite") {
      return { isSatellite: true, resolvedId: fedNode.id };
    }
  } catch {
    // Federation check failed
  }
  return { isSatellite: false };
}

/**
 * Spawn a session on a remote node
 *
 * Routes the spawn request through the federation hub to the target node.
 * Supports BOTH federation satellites (via federation.node.invoke)
 * AND mobile nodes (via node.invoke).
 */
export async function spawnRemoteSession(params: {
  node: string;
  agentId: string;
  task: string;
  label?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  requiredCapabilities?: string[];
  preferredCapabilities?: string[];
  minGpuVRAM?: number;
}): Promise<RemoteSessionHandle> {
  const {
    node,
    agentId,
    task,
    label,
    model,
    thinking,
    runTimeoutSeconds,
    cleanup,
    requiredCapabilities,
    preferredCapabilities,
    minGpuVRAM,
  } = params;

  // Validate node is connected
  const connected = await isNodeConnected(node);
  if (!connected) {
    const available = await getConnectedNodes().catch(() => []);
    const hint = available.length
      ? ` Available: ${available.map((n) => `${n.nodeId}${n.displayName && n.displayName !== n.nodeId ? ` (${n.displayName})` : ""}`).join(", ")}`
      : " No federation/mobile nodes are currently connected.";
    return {
      node,
      sessionKey: "",
      runId: "",
      status: "error",
      error: `Node "${node}" not found or not connected.${hint}`,
    };
  }

  // Determine if this is a federation satellite or mobile node
  const { isSatellite, resolvedId } = await isFederationSatellite(node);
  const targetNodeId = resolvedId || node;

  try {
    let result: {
      ok?: boolean;
      status?: string;
      payload?: {
        status?: string;
        childSessionKey?: string;
        runId?: string;
        error?: string;
      };
      childSessionKey?: string;
      runId?: string;
      error?: string;
    };

    if (isSatellite) {
      // Use federation.node.invoke for satellites
      result = (await callGateway({
        method: "federation.node.invoke",
        params: {
          nodeId: targetNodeId,
          method: "agent",
          params: {
            message: task,
            agentId: agentId || "coder",
            label,
            thinking,
            timeout: runTimeoutSeconds,
            requiredCapabilities,
            preferredCapabilities,
            minGpuVRAM,
            idempotencyKey: `spawn-${targetNodeId}-${Date.now()}`,
          },
        },
        timeoutMs: 35000,
      })) as typeof result;

      // Federation invoke returns different shape
      if (result.status === "ok" || result.status === "accepted") {
        return {
          node: targetNodeId,
          sessionKey: result.childSessionKey || result.payload?.childSessionKey || "",
          runId: result.runId || result.payload?.runId || "",
          status: "accepted",
        };
      } else {
        return {
          node: targetNodeId,
          sessionKey: "",
          runId: "",
          status: "error",
          error: result.error || result.payload?.error || "Federation spawn failed",
        };
      }
    } else {
      // Use node.invoke for mobile nodes
      result = (await callGateway({
        method: "node.invoke",
        params: {
          nodeId: targetNodeId,
          command: "agent.spawn",
          params: {
            agentId,
            task,
            label,
            model,
            thinking,
            runTimeoutSeconds,
            cleanup,
            requiredCapabilities,
            preferredCapabilities,
            minGpuVRAM,
            federatedFrom: "local",
          },
          timeoutMs: 30000,
          idempotencyKey: `spawn-${targetNodeId}-${Date.now()}`,
        },
        timeoutMs: 35000,
      })) as typeof result;

      if (!result.ok || !result.payload) {
        return {
          node: targetNodeId,
          sessionKey: "",
          runId: "",
          status: "error",
          error: "Failed to spawn session on remote node",
        };
      }

      const payload = result.payload;
      if (payload.status !== "accepted") {
        return {
          node: targetNodeId,
          sessionKey: payload.childSessionKey || "",
          runId: payload.runId || "",
          status: "error",
          error: payload.error || "Remote spawn rejected",
        };
      }

      return {
        node: targetNodeId,
        sessionKey: payload.childSessionKey || "",
        runId: payload.runId || "",
        status: "accepted",
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      node: targetNodeId,
      sessionKey: "",
      runId: "",
      status: "error",
      error: `Remote spawn failed: ${message}`,
    };
  }
}

/**
 * Send a message to a session on a remote node
 *
 * Routes the message through the federation hub to the target session.
 */
export async function sendRemoteMessage(params: {
  node: string;
  sessionKey: string;
  message: string;
  timeoutSeconds?: number;
}): Promise<RemoteMessageResult> {
  const { node, sessionKey, message, timeoutSeconds = 30 } = params;

  // Validate node is connected
  const connected = await isNodeConnected(node);
  if (!connected) {
    return {
      node,
      sessionKey,
      runId: "",
      status: "error",
      error: `Node "${node}" is not connected to the federation`,
    };
  }

  try {
    // Invoke sessions_send on the remote node
    const result = (await callGateway({
      method: "node.invoke",
      params: {
        nodeId: node,
        command: "agent.send",
        params: {
          sessionKey,
          message,
          timeoutSeconds,
          federatedFrom: "local",
        },
        timeoutMs: (timeoutSeconds + 10) * 1000,
        idempotencyKey: `send-${node}-${sessionKey}-${Date.now()}`,
      },
      timeoutMs: (timeoutSeconds + 15) * 1000,
    })) as {
      ok: boolean;
      payload?: {
        status?: string;
        runId?: string;
        reply?: string;
        error?: string;
      };
    };

    if (!result.ok || !result.payload) {
      return {
        node,
        sessionKey,
        runId: "",
        status: "error",
        error: "Failed to send message to remote session",
      };
    }

    const payload = result.payload;
    return {
      node,
      sessionKey,
      runId: payload.runId || "",
      status: (payload.status as RemoteMessageResult["status"]) || "error",
      reply: payload.reply,
      error: payload.error,
    };
  } catch (err) {
    const message_ = err instanceof Error ? err.message : String(err);
    return {
      node,
      sessionKey,
      runId: "",
      status: "error",
      error: `Remote send failed: ${message_}`,
    };
  }
}

/**
 * List sessions on a remote node
 */
export async function getRemoteSessions(params: {
  node: string;
  kinds?: string[];
  limit?: number;
  activeMinutes?: number;
}): Promise<RemoteSessionInfo[]> {
  const { node, kinds, limit, activeMinutes } = params;

  // Validate node is connected
  const connected = await isNodeConnected(node);
  if (!connected) {
    return [];
  }

  try {
    const result = (await callGateway({
      method: "node.invoke",
      params: {
        nodeId: node,
        command: "sessions.list",
        params: {
          kinds,
          limit,
          activeMinutes,
        },
        timeoutMs: 15000,
        idempotencyKey: `list-${node}-${Date.now()}`,
      },
      timeoutMs: 20000,
    })) as {
      ok: boolean;
      payload?: {
        sessions?: Array<{
          key: string;
          kind: string;
          channel?: string;
          label?: string;
          displayName?: string;
          updatedAt?: number;
          model?: string;
        }>;
      };
    };

    if (!result.ok || !result.payload?.sessions) {
      return [];
    }

    return result.payload.sessions.map((s) => ({
      node,
      key: s.key,
      kind: s.kind,
      channel: s.channel,
      label: s.label,
      displayName: s.displayName,
      updatedAt: s.updatedAt,
      model: s.model,
    }));
  } catch {
    return [];
  }
}

/**
 * Get sessions across all connected nodes
 */
export async function getAllFederatedSessions(params?: {
  kinds?: string[];
  limit?: number;
  activeMinutes?: number;
}): Promise<RemoteSessionInfo[]> {
  const nodes = await getConnectedNodes();
  const results: RemoteSessionInfo[] = [];

  // Fetch sessions from all nodes in parallel
  const promises = nodes.map((n) =>
    getRemoteSessions({
      node: n.nodeId,
      kinds: params?.kinds,
      limit: params?.limit,
      activeMinutes: params?.activeMinutes,
    }),
  );

  const nodeResults = await Promise.all(promises);
  for (const sessions of nodeResults) {
    results.push(...sessions);
  }

  // Sort by updatedAt descending
  results.sort((a, b) => {
    const aTime = a.updatedAt ?? 0;
    const bTime = b.updatedAt ?? 0;
    return bTime - aTime;
  });

  return results;
}

/**
 * Build federation topology info for agent system prompts
 *
 * Returns a formatted string describing available nodes and their capabilities
 * for inclusion in agent context.
 */
export async function buildFederationTopologyContext(): Promise<string | undefined> {
  const cfg = loadConfig();
  const federationEnabled = cfg.federation?.enabled !== false;

  if (!federationEnabled) {
    return undefined;
  }

  const nodes = await getConnectedNodes();
  if (nodes.length === 0) {
    return undefined;
  }

  const lines: string[] = [
    "## Federation Topology",
    "",
    "You are part of a federated InfiniBot network. The following nodes are available:",
    "",
  ];

  for (const node of nodes) {
    const name = node.displayName || node.nodeId;
    const platform = node.platform || "unknown";
    const capsStr = node.caps.length > 0 ? node.caps.join(", ") : "none";

    lines.push(`- **${name}** (${node.nodeId})`);
    lines.push(`  - Platform: ${platform}`);
    lines.push(`  - Capabilities: ${capsStr}`);
    lines.push("");
  }

  lines.push(
    "To spawn a session on a specific node, use the `node` parameter in sessions_spawn:",
    "",
    "```typescript",
    'sessions_spawn({ node: "node-id", agentId: "coder", task: "..." })',
    "```",
    "",
    "To send a message to a session on another node:",
    "",
    "```typescript",
    'sessions_send({ node: "node-id", sessionKey: "...", message: "..." })',
    "```",
    "",
    "Consider delegating tasks to nodes with appropriate capabilities:",
    "- GPU-intensive tasks → nodes with GPU capabilities",
    "- File operations → nodes with access to those files",
    "- Local development → nodes running in the target workspace",
  );

  return lines.join("\n");
}

/**
 * Validate that a node parameter is valid and connected
 * Returns normalized node ID or null if invalid
 */
export async function validateNodeParameter(
  nodeParam: string | undefined,
): Promise<{ valid: true; nodeId: string } | { valid: false; error: string }> {
  if (!nodeParam) {
    return { valid: true, nodeId: "" }; // Empty means local
  }

  const nodeId = nodeParam.trim();
  if (!nodeId) {
    return { valid: true, nodeId: "" };
  }

  // Check if node exists and is connected
  const nodeInfo = await describeNode(nodeId);
  if (!nodeInfo) {
    // Try to find by display name
    const nodes = await getConnectedNodes();
    const byName = nodes.find(
      (n) => n.displayName?.toLowerCase() === nodeId.toLowerCase() || n.nodeId === nodeId,
    );

    if (!byName) {
      return {
        valid: false,
        error: `Node "${nodeId}" not found or not connected`,
      };
    }

    return { valid: true, nodeId: byName.nodeId };
  }

  return { valid: true, nodeId };
}

// ============================================================
// Node Capability Helpers
// ============================================================

/**
 * Find the best node for a specific capability requirement.
 */
export async function findNodeWithCapability(
  capability: string,
): Promise<FederatedNodeInfo | null> {
  const nodes = await getConnectedNodes();
  const capLower = capability.toLowerCase();

  for (const node of nodes) {
    if (node.caps.some((c) => c.toLowerCase() === capLower)) {
      return node;
    }
  }

  return null;
}

/**
 * Get nodes that have a specific capability.
 */
export async function getNodesWithCapability(capability: string): Promise<FederatedNodeInfo[]> {
  const nodes = await getConnectedNodes();
  const capLower = capability.toLowerCase();

  return nodes.filter((node) => node.caps.some((c) => c.toLowerCase() === capLower));
}

/**
 * Check if federation is enabled and has connected nodes.
 */
export async function isFederationActive(): Promise<boolean> {
  const cfg = loadConfig();
  if (cfg.federation?.enabled === false) {
    return false;
  }

  const nodes = await getConnectedNodes();
  return nodes.length > 0;
}

/**
 * Get a summary of the federation topology for quick checks.
 */
export async function getFederationSummary(): Promise<{
  enabled: boolean;
  nodeCount: number;
  nodes: Array<{ id: string; name: string; platform?: string; caps: string[] }>;
}> {
  const cfg = loadConfig();
  const enabled = cfg.federation?.enabled !== false;

  if (!enabled) {
    return { enabled: false, nodeCount: 0, nodes: [] };
  }

  const nodes = await getConnectedNodes();
  return {
    enabled: true,
    nodeCount: nodes.length,
    nodes: nodes.map((n) => ({
      id: n.nodeId,
      name: n.displayName || n.nodeId,
      platform: n.platform,
      caps: n.caps,
    })),
  };
}

// ============================================================
// Context for Agents (System Prompt Injection)
// ============================================================

/**
 * Build a compact federation context string for agent system prompts.
 * This is a more token-efficient version for subagents.
 */
export async function buildCompactFederationContext(): Promise<string | undefined> {
  const cfg = loadConfig();
  if (cfg.federation?.enabled === false) {
    return undefined;
  }

  const nodes = await getConnectedNodes();
  if (nodes.length === 0) {
    return undefined;
  }

  const nodeList = nodes
    .map((n) => {
      const name = n.displayName || n.nodeId;
      const caps = n.caps.length > 0 ? ` [${n.caps.join(", ")}]` : "";
      return `${name}${caps}`;
    })
    .join("; ");

  return `Federation nodes: ${nodeList}. Use node parameter in sessions_spawn/sessions_send for cross-node ops.`;
}

/**
 * Build federation context suitable for the agent's prompt mode.
 */
export async function buildFederationContextForPromptMode(
  promptMode: "full" | "minimal" | "none",
): Promise<string | undefined> {
  if (promptMode === "none") {
    return undefined;
  }

  if (promptMode === "minimal") {
    return buildCompactFederationContext();
  }

  return buildFederationTopologyContext();
}

// ============================================================
// Routing Helpers
// ============================================================

/**
 * Determine the best node for a task based on requirements.
 * This is a lightweight version of the full compute router.
 */
export async function suggestNodeForTask(taskDescription: string): Promise<{
  nodeId: string;
  nodeName?: string;
  reason: string;
} | null> {
  const nodes = await getConnectedNodes();
  if (nodes.length === 0) {
    return null;
  }

  const descLower = taskDescription.toLowerCase();

  // Check for GPU-related tasks
  const gpuPatterns = [
    /\b(image|picture|art|illustration)\b.*\b(generat|creat|mak|draw|render)/i,
    /\b(stable\s*diffusion|comfyui|sdxl|flux|midjourney)/i,
    /\bgpu\b/i,
    /\bml\b.*\b(train|infer)/i,
  ];

  if (gpuPatterns.some((p) => p.test(descLower))) {
    const gpuNode = await findNodeWithCapability("gpu");
    if (gpuNode) {
      return {
        nodeId: gpuNode.nodeId,
        nodeName: gpuNode.displayName,
        reason: "GPU-intensive task",
      };
    }
  }

  // Check for voice/audio tasks
  const voicePatterns = [
    /\b(speak|say|read\s*aloud|narrate|voice)\b/i,
    /\btts\b/i,
    /\btext[-\s]to[-\s]speech\b/i,
    /\belevenlabs\b/i,
    /\blivekit\b/i,
  ];

  if (voicePatterns.some((p) => p.test(descLower))) {
    const voiceNode = await findNodeWithCapability("voice");
    if (voiceNode) {
      return {
        nodeId: voiceNode.nodeId,
        nodeName: voiceNode.displayName,
        reason: "Voice processing task",
      };
    }
  }

  // Check for Ollama/local LLM tasks
  const ollamaPatterns = [
    /\bollama\b/i,
    /\bllama\s*\d/i,
    /\blocal\s*(llm|model|inference)\b/i,
    /\bself-?hosted\s*(llm|model)\b/i,
  ];

  if (ollamaPatterns.some((p) => p.test(descLower))) {
    const ollamaNode = await findNodeWithCapability("ollama");
    if (ollamaNode) {
      return {
        nodeId: ollamaNode.nodeId,
        nodeName: ollamaNode.displayName,
        reason: "Ollama inference task",
      };
    }
  }

  return null;
}
