/**
 * Mesh Tool
 *
 * Agent tool for mesh network operations - enables agents to communicate
 * with and orchestrate other agents across the federation.
 */

import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// =============================================================================
// Schema
// =============================================================================

const MeshToolSchema = Type.Object({
  action: stringEnum([
    "spawn",
    "send",
    "discover",
    "findBest",
    "delegate",
    "status",
    "kill",
    "wait",
    "updateStatus",
    "getAgent",
    "getChain",
    "getMessages",
  ] as const),

  // spawn params
  agentId: Type.Optional(Type.String({ description: "Agent type to spawn (e.g., 'coder', 'tester', 'architect')" })),
  task: Type.Optional(Type.String({ description: "Task description for spawn/delegate" })),
  label: Type.Optional(Type.String({ description: "Human-readable label for the agent" })),
  node: Type.Optional(Type.String({ description: "Target node ID for cross-node spawning" })),
  capabilities: Type.Optional(Type.Array(Type.String(), { description: "Agent capabilities" })),
  canSpawn: Type.Optional(Type.Boolean({ description: "Allow spawned agent to spawn others" })),
  model: Type.Optional(Type.String({ description: "Model to use for the spawned agent" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level override" })),

  // send params
  to: Type.Optional(Type.String({ description: "Target session key for send" })),
  type: optionalStringEnum(["request", "response", "broadcast", "event"] as const),
  message: Type.Optional(Type.String({ description: "Message content" })),
  data: Type.Optional(Type.Unknown({ description: "Additional data payload" })),
  priority: optionalStringEnum(["low", "normal", "high", "critical"] as const),

  // discover params
  status: Type.Optional(Type.String({ description: "Filter by status (idle, working, blocked, etc.)" })),

  // findBest/delegate params
  requiredCapabilities: Type.Optional(Type.Array(Type.String(), { description: "Required capabilities for findBest/delegate" })),
  preferNode: Type.Optional(Type.String({ description: "Preferred node for agent selection" })),
  excludeSessions: Type.Optional(Type.Array(Type.String(), { description: "Sessions to exclude from selection" })),
  preferExisting: Type.Optional(Type.Boolean({ description: "Prefer existing agents over spawning new ones" })),

  // kill params
  sessionKey: Type.Optional(Type.String({ description: "Session key for kill/wait/getAgent" })),
  reason: Type.Optional(Type.String({ description: "Reason for killing the agent" })),
  cascade: Type.Optional(Type.Boolean({ description: "Also kill child agents" })),

  // wait params
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),

  // updateStatus params
  progress: Type.Optional(Type.Number({ description: "Progress percentage (0-100)" })),
  currentTask: Type.Optional(Type.String({ description: "Current task description" })),
  checkpoint: Type.Optional(Type.String({ description: "Checkpoint name" })),

  // getMessages params
  unreadOnly: Type.Optional(Type.Boolean({ description: "Only get unread messages" })),
  limit: Type.Optional(Type.Number({ description: "Maximum messages to return" })),
});

// =============================================================================
// Tool Implementation
// =============================================================================

export function createMeshTool(opts?: {
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Agent Mesh",
    name: "mesh",
    description: `Communicate with and orchestrate other agents in the mesh network.

Actions:
- spawn: Spawn a specialized agent to handle a subtask
- send: Send a message to another agent
- discover: Find agents by capability/status/node
- findBest: Score and find the best agent for a task
- delegate: Assign task to best available agent (spawn if needed)
- status: Check overall mesh status
- kill: Terminate an agent session
- wait: Wait for a response from a specific agent
- updateStatus: Update your own status/progress
- getAgent: Get info about a specific agent
- getChain: Get orchestration chain for an agent
- getMessages: Get messages for a session

Examples:
- Spawn UI architect: mesh({ action: "spawn", agentId: "architect", task: "Design the modal layout" })
- Send message: mesh({ action: "send", to: "agent:coder:mesh:xxx", message: "Please review these changes" })
- Delegate task: mesh({ action: "delegate", task: "Fix WebSocket reconnection", requiredCapabilities: ["typescript", "websocket"] })
- Check status: mesh({ action: "status" })
- Discover idle agents: mesh({ action: "discover", status: "idle", capabilities: ["typescript"] })`,
    parameters: MeshToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        switch (action) {
          case "spawn": {
            const agentId = readStringParam(params, "agentId") || "coder";
            const task = readStringParam(params, "task", { required: true });
            const label = readStringParam(params, "label");
            const node = readStringParam(params, "node");
            const capabilities = params.capabilities as string[] | undefined;
            const canSpawn = params.canSpawn === true;
            const model = readStringParam(params, "model");
            const thinking = readStringParam(params, "thinking");
            const timeout = typeof params.timeout === "number" ? params.timeout : undefined;

            const result = await callGateway({
              method: "mesh.spawn",
              params: {
                agentId,
                task,
                label,
                node,
                capabilities,
                canSpawn,
                parent: opts?.agentSessionKey,
                model,
                thinking,
                timeout,
              },
              timeoutMs: 30_000,
            });

            return jsonResult({
              status: "ok",
              action: "spawn",
              ...(result as Record<string, unknown>),
            });
          }

          case "send": {
            const to = readStringParam(params, "to", { required: true });
            const type = (params.type as string) || "request";
            const message = readStringParam(params, "message");
            const data = params.data as Record<string, unknown> | undefined;
            const priority = (params.priority as string) || "normal";

            const result = await callGateway({
              method: "mesh.send",
              params: {
                to,
                type,
                payload: {
                  message,
                  data,
                  priority,
                  replyTo: opts?.agentSessionKey,
                },
              },
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "send",
              ...(result as Record<string, unknown>),
            });
          }

          case "discover": {
            const capabilities = params.capabilities as string[] | undefined;
            const agentId = readStringParam(params, "agentId");
            const status = readStringParam(params, "status");
            const node = readStringParam(params, "node");

            const result = await callGateway({
              method: "mesh.discover",
              params: {
                capabilities,
                agentId,
                status,
                node,
              },
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "discover",
              ...(result as Record<string, unknown>),
            });
          }

          case "findBest": {
            const requiredCapabilities = (params.requiredCapabilities as string[]) || [];
            const preferNode = readStringParam(params, "preferNode");
            const excludeSessions = params.excludeSessions as string[] | undefined;

            const result = await callGateway({
              method: "mesh.findBest",
              params: {
                requiredCapabilities,
                preferNode,
                excludeSessions,
              },
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "findBest",
              ...(result as Record<string, unknown>),
            });
          }

          case "delegate": {
            const task = readStringParam(params, "task", { required: true });
            const requiredCapabilities = (params.requiredCapabilities as string[]) || [];
            const priority = (params.priority as string) || "normal";
            const preferExisting = params.preferExisting !== false;
            const node = readStringParam(params, "node");
            const label = readStringParam(params, "label");
            const timeout = typeof params.timeout === "number" ? params.timeout : undefined;

            const result = await callGateway({
              method: "mesh.delegate",
              params: {
                task,
                requiredCapabilities,
                priority,
                preferExisting,
                node,
                label,
                timeout,
              },
              timeoutMs: 30_000,
            });

            return jsonResult({
              status: "ok",
              action: "delegate",
              ...(result as Record<string, unknown>),
            });
          }

          case "status": {
            const result = await callGateway({
              method: "mesh.status",
              params: {},
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "status",
              ...(result as Record<string, unknown>),
            });
          }

          case "kill": {
            const sessionKey = readStringParam(params, "sessionKey", { required: true });
            const reason = readStringParam(params, "reason");
            const cascade = params.cascade === true;

            const result = await callGateway({
              method: "mesh.kill",
              params: {
                sessionKey,
                reason,
                cascade,
              },
              timeoutMs: 15_000,
            });

            return jsonResult({
              status: "ok",
              action: "kill",
              ...(result as Record<string, unknown>),
            });
          }

          case "wait": {
            const sessionKey = readStringParam(params, "sessionKey", { required: true });
            const timeout = typeof params.timeout === "number" ? params.timeout : 300;

            const result = await callGateway({
              method: "mesh.waitResponse",
              params: {
                fromSession: sessionKey,
                timeout,
              },
              timeoutMs: (timeout + 30) * 1000,
            });

            return jsonResult({
              status: "ok",
              action: "wait",
              ...(result as Record<string, unknown>),
            });
          }

          case "updateStatus": {
            const sessionKey = opts?.agentSessionKey || readStringParam(params, "sessionKey");
            const status = readStringParam(params, "status");
            const progress = typeof params.progress === "number" ? params.progress : undefined;
            const currentTask = readStringParam(params, "currentTask");
            const checkpoint = readStringParam(params, "checkpoint");

            if (!sessionKey) {
              return jsonResult({
                status: "error",
                error: "sessionKey is required (or must be called from an agent session)",
              });
            }

            const result = await callGateway({
              method: "mesh.updateStatus",
              params: {
                sessionKey,
                status,
                progress,
                currentTask,
                checkpoint,
              },
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "updateStatus",
              ...(result as Record<string, unknown>),
            });
          }

          case "getAgent": {
            const sessionKey = readStringParam(params, "sessionKey", { required: true });

            const result = await callGateway({
              method: "mesh.getAgent",
              params: { sessionKey },
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "getAgent",
              ...(result as Record<string, unknown>),
            });
          }

          case "getChain": {
            const sessionKey = readStringParam(params, "sessionKey", { required: true });

            const result = await callGateway({
              method: "mesh.getChain",
              params: { sessionKey },
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "getChain",
              ...(result as Record<string, unknown>),
            });
          }

          case "getMessages": {
            const sessionKey = readStringParam(params, "sessionKey") || opts?.agentSessionKey;
            const unreadOnly = params.unreadOnly === true;
            const limit = typeof params.limit === "number" ? params.limit : 50;

            const result = await callGateway({
              method: "mesh.getMessages",
              params: {
                sessionKey,
                unreadOnly,
                limit,
              },
              timeoutMs: 10_000,
            });

            return jsonResult({
              status: "ok",
              action: "getMessages",
              ...(result as Record<string, unknown>),
            });
          }

          default:
            return jsonResult({
              status: "error",
              error: `Unknown action: ${action}. Valid actions: spawn, send, discover, findBest, delegate, status, kill, wait, updateStatus, getAgent, getChain, getMessages`,
            });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          action,
          error,
        });
      }
    },
  };
}

// =============================================================================
// Default Export
// =============================================================================

export default createMeshTool;
