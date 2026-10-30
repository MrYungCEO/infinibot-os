import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { getEventBus } from "../../federation/event-bus.js";
import {
  describeNode,
  spawnRemoteSession,
  validateNodeParameter,
} from "../../federation/agent-tools.js";
import { routeSessionSpawn } from "../../federation/compute-router.js";
import {
  parseCapabilityRequirements,
  routeByCapabilities,
  type RequiredCapability,
} from "../../federation/capability-router.js";
import { registerRemoteSession } from "../../federation/remote-session-registry.js";
import { callGateway } from "../../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "../agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { gateAgentSpawn } from "../agent-concurrency-gate.js";
import { appendSpawnEvent } from "../spawn-ledger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat alias. Prefer runTimeoutSeconds.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  // Federation: target node for cross-node spawning
  node: Type.Optional(Type.String()),
  // Capability-based routing parameters
  requiredCapabilities: Type.Optional(Type.Array(Type.String())),
  preferredCapabilities: Type.Optional(Type.Array(Type.String())),
  minGpuVRAM: Type.Optional(Type.Number({ minimum: 0 })),
  // Kanban project linkage (server condenses related runs into one project)
  projectId: Type.Optional(Type.String()),
  projectHint: Type.Optional(Type.String()),
});

function splitModelRef(ref?: string) {
  if (!ref) return { provider: undefined, model: undefined };
  const trimmed = ref.trim();
  if (!trimmed) return { provider: undefined, model: undefined };
  const [provider, model] = trimmed.split("/", 2);
  if (model) return { provider, model };
  return { provider: undefined, model: trimmed };
}

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  return undefined;
}

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      // PLAN GATE (SaaS/hosted only — a no-op locally): refuse the spawn before
      // any side effect when the tenant is at its plan's concurrent-agent cap.
      // See src/agents/agent-concurrency-gate.ts.
      const planLimit = await gateAgentSpawn();
      if (planLimit) return jsonResult({ status: "error", error: planLimit.message, ...planLimit });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const nodeParam = readStringParam(params, "node");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete"
          ? (params.cleanup as "keep" | "delete")
          : "keep";

      // Parse capability-based routing parameters
      const requiredCapabilities = Array.isArray(params.requiredCapabilities)
        ? (params.requiredCapabilities as string[])
        : undefined;
      const preferredCapabilities = Array.isArray(params.preferredCapabilities)
        ? (params.preferredCapabilities as string[])
        : undefined;
      const minGpuVRAM =
        typeof params.minGpuVRAM === "number" && params.minGpuVRAM > 0
          ? params.minGpuVRAM
          : undefined;
      const requesterOrigin = normalizeDeliveryContext({
        channel: opts?.agentChannel,
        accountId: opts?.agentAccountId,
        to: opts?.agentTo,
        threadId: opts?.agentThreadId,
      });
      const runTimeoutSeconds = (() => {
        const explicit =
          typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
            ? Math.max(0, Math.floor(params.runTimeoutSeconds))
            : undefined;
        if (explicit !== undefined) return explicit;
        const legacy =
          typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
            ? Math.max(0, Math.floor(params.timeoutSeconds))
            : undefined;
        return legacy ?? 0;
      })();
      let modelWarning: string | undefined;
      let modelApplied = false;

      const cfg = loadConfig();

      // ── Federation Cross-Node Spawn Path ──────────────────────────
      // Capability-based auto-routing: Select best node based on required capabilities
      let autoRoutedNode: string | undefined;
      let autoRoutedNodeName: string | undefined;
      let autoRouteReason: string | undefined;
      let routingDecision: any = null;

      if (!nodeParam && cfg.federation?.enabled && cfg.federation?.mode === "master") {
        try {
          // Check if explicit capabilities are provided
          if (requiredCapabilities && requiredCapabilities.length > 0) {
            // Use capability-based routing
            const capabilityRequirements = parseCapabilityRequirements({
              requiredCapabilities,
              preferredCapabilities,
              minGpuVRAM,
              workspace: undefined,
              preferNode: nodeParam,
            });

            // Get available nodes (would need to import from hub or compute router)
            const { getComputeRoutingService } = await import("../../federation/compute-router.js");
            const routingService = getComputeRoutingService();
            const availableNodes = routingService.listNodes();

            if (availableNodes.length > 0) {
              routingDecision = await routeByCapabilities(availableNodes, capabilityRequirements);

              if (routingDecision.confidence > 0.6) {
                autoRoutedNode = routingDecision.nodeId;
                autoRoutedNodeName = routingDecision.nodeName;
                autoRouteReason = `Capability-based routing: ${routingDecision.reason}`;
                console.log(
                  `[sessions_spawn] Capability routing to ${autoRoutedNodeName || autoRoutedNode}: ${autoRouteReason}`,
                );
              }
            }
          } else {
            // Fall back to pattern-based routing if no capabilities specified
            const routeResult = await routeSessionSpawn({
              task,
              agentId: requestedAgentId,
              workspace: undefined,
            });

            if (
              routeResult?.shouldRoute &&
              routeResult.nodeId &&
              routeResult.confidence &&
              routeResult.confidence > 0.7
            ) {
              autoRoutedNode = routeResult.nodeId;
              autoRoutedNodeName = routeResult.nodeName;
              autoRouteReason = routeResult.reason;
              console.log(
                `[sessions_spawn] Pattern-based routing to ${autoRoutedNodeName || autoRoutedNode}: ${autoRouteReason}`,
              );
            }
          }
        } catch (err) {
          // Auto-routing failed, continue with local execution
          console.warn(
            "[sessions_spawn] Auto-routing check failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // If a node parameter is specified OR auto-routing selected a node, route the spawn to that remote node
      const effectiveNode = nodeParam || autoRoutedNode;
      if (effectiveNode) {
        const nodeValidation = await validateNodeParameter(effectiveNode);
        if (!nodeValidation.valid) {
          // If this was auto-routed, fall back to local execution instead of erroring
          if (autoRoutedNode && !nodeParam) {
            console.warn(
              `[sessions_spawn] Auto-routed node ${autoRoutedNode} invalid, falling back to local`,
            );
          } else {
            return jsonResult({
              status: "error",
              error: nodeValidation.error,
            });
          }
        } else if (nodeValidation.nodeId) {
          // Spawn on remote node via federation
          const targetAgentId = requestedAgentId
            ? normalizeAgentId(requestedAgentId)
            : normalizeAgentId(
                opts?.requesterAgentIdOverride ??
                  parseAgentSessionKey(opts?.agentSessionKey ?? "")?.agentId,
              );

          const remoteResult = await spawnRemoteSession({
            node: nodeValidation.nodeId,
            agentId: targetAgentId,
            task,
            label: label || undefined,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            runTimeoutSeconds: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
            cleanup,
            requiredCapabilities,
            preferredCapabilities,
            minGpuVRAM,
          });

          if (remoteResult.status === "error") {
            // If auto-routed and failed, try local execution
            if (autoRoutedNode && !nodeParam) {
              console.warn(
                `[sessions_spawn] Auto-routed spawn to ${autoRoutedNode} failed: ${remoteResult.error}, falling back to local`,
              );
            } else {
              return jsonResult({
                status: "error",
                error: remoteResult.error,
                node: nodeValidation.nodeId,
              });
            }
          } else {
            // Register the remote session for tracking
            const nodeInfo = await describeNode(nodeValidation.nodeId);
            const nodeName = nodeInfo?.displayName ?? autoRoutedNodeName ?? nodeValidation.nodeId;
            registerRemoteSession({
              runId: remoteResult.runId,
              sessionKey: remoteResult.sessionKey,
              nodeId: nodeValidation.nodeId,
              nodeName: nodeInfo?.displayName,
              agentId: targetAgentId,
              task,
              label: label || undefined,
              spawnerSessionKey: opts?.agentSessionKey,
              cleanup,
              timeoutSeconds: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
              model: modelOverride,
            });

            // Persist federation info to session store for survival across restarts
            // Use updateSessionStore to CREATE entry if missing (not just update)
            // IMPORTANT: Write to the SPAWNED agent's store, not the calling agent's store
            const cfgForStore = loadConfig();
            const storeConfig = cfgForStore.session?.store;
            const storePath = resolveStorePath(storeConfig, { agentId: targetAgentId });
            void updateSessionStore(storePath, (store) => {
              const existing = store[remoteResult.sessionKey];
              // Create or update the entry with federation info
              store[remoteResult.sessionKey] = {
                ...existing,
                updatedAt: Date.now(),
                label: label || existing?.label,
                federationNode: nodeName,
                federationRemote: true,
              };
              console.log("[sessions-spawn] Wrote remote session to store:", {
                storePath,
                sessionKey: remoteResult.sessionKey,
                nodeName,
              });
              return store[remoteResult.sessionKey];
            }).catch((err) => {
              console.error("[sessions-spawn] Failed to write remote session to store:", err);
            });

            // Publish session spawned event
            getEventBus().publish("session.spawned", {
              sessionKey: remoteResult.sessionKey,
              runId: remoteResult.runId,
              nodeId: nodeValidation.nodeId,
              agentId: targetAgentId,
              label: label || undefined,
              remote: true,
            });

            return jsonResult({
              status: "accepted",
              childSessionKey: remoteResult.sessionKey,
              runId: remoteResult.runId,
              node: nodeValidation.nodeId,
              nodeName: nodeInfo?.displayName ?? autoRoutedNodeName,
              remote: true,
              autoRouted: !!autoRoutedNode && !nodeParam,
              routingReason: autoRouteReason,
            });
          }
        }
      }
      // ── End Federation Cross-Node Path ────────────────────────────
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
        return jsonResult({
          status: "forbidden",
          error: "sessions_spawn is not allowed from sub-agent sessions",
        });
      }
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });

      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;
      if (targetAgentId !== requesterAgentId) {
        const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((value) => value.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((value) => value.trim() && value.trim() !== "*")
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );
        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
          });
        }
      }
      const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
      const spawnedByKey = requesterInternalKey;
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);

      // ── Terminal-First Execution Path ──────────────────────────
      // If the target agent is configured with execution.mode = "terminal"
      // (either explicitly or synthesised from type:"cli" + cliCommand),
      // spawn a PTY terminal with the CLI instead of running the agent loop.
      const execution = targetAgentConfig?.execution;
      if (execution?.mode === "terminal" && execution?.cli) {
        const childRunId = crypto.randomUUID();
        const cwd = resolveAgentWorkspaceDir(cfg, targetAgentId);

        try {
          const spawnResult = (await callGateway({
            method: "terminal.spawnAgent",
            params: {
              cli: execution.cli,
              cwd,
              task,
              label: label || undefined,
              runId: childRunId,
              sessionKey: childSessionKey,
              agentId: targetAgentId,
              autoClose: execution.autoClose !== false,
              autoCloseDelayMs:
                typeof execution.autoCloseDelayMs === "number" ? execution.autoCloseDelayMs : 5000,
            },
            timeoutMs: 15_000,
          })) as { success: boolean; terminalId?: string; error?: string };

          if (!spawnResult?.success) {
            // Surface the error — a CLI agent that can't start its terminal
            // should not silently fall through to a generic agent-loop that
            // cannot drive the CLI toolchain.
            return jsonResult({
              status: "error",
              error:
                spawnResult?.error ??
                `terminal.spawnAgent failed for cli=${execution.cli} (binary not found or terminal unavailable)`,
            });
          }
          // Ledger: record before registry persist so a crash mid-persist is covered.
          appendSpawnEvent({
            v: 1,
            ts: Date.now(),
            event: "spawn.intent",
            runId: childRunId,
            kind: "session",
            task: task.slice(0, 500),
            label: label || undefined,
            requesterSessionKey: requesterInternalKey,
            childSessionKey,
          });
          // Register in subagent registry for lifecycle tracking + announce
          registerSubagentRun({
            runId: childRunId,
            childSessionKey,
            requesterSessionKey: requesterInternalKey,
            requesterOrigin,
            requesterDisplayKey,
            task,
            cleanup,
            label: label || undefined,
            runTimeoutSeconds,
          });

          // Publish session spawned event
          getEventBus().publish("session.spawned", {
            sessionKey: childSessionKey,
            runId: childRunId,
            agentId: targetAgentId,
            label: label || undefined,
            executionMode: "terminal",
            parentSessionKey: requesterInternalKey,
          });

          return jsonResult({
            status: "accepted",
            childSessionKey,
            runId: childRunId,
            executionMode: "terminal",
            terminalId: spawnResult.terminalId,
          });
        } catch (err) {
          // terminal.spawnAgent threw — surface as error rather than silently
          // falling through to agent-loop.
          return jsonResult({
            status: "error",
            error: `terminal.spawnAgent error for ${targetAgentId}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      // ── End Terminal-First Path ────────────────────────────────

      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);
      let thinkingOverride: string | undefined;
      if (thinkingOverrideRaw) {
        const normalized = normalizeThinkLevel(thinkingOverrideRaw);
        if (!normalized) {
          const { provider, model } = splitModelRef(resolvedModel);
          const hint = formatThinkingLevels(provider, model);
          return jsonResult({
            status: "error",
            error: `Invalid thinking level "${thinkingOverrideRaw}". Use one of: ${hint}.`,
          });
        }
        thinkingOverride = normalized;
      }
      if (resolvedModel) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, model: resolvedModel },
            timeoutMs: 10_000,
          });
          modelApplied = true;
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          const recoverable =
            messageText.includes("invalid model") || messageText.includes("model not allowed");
          if (!recoverable) {
            return jsonResult({
              status: "error",
              error: messageText,
              childSessionKey,
            });
          }
          modelWarning = messageText;
        }
      }
      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterOrigin,
        childSessionKey,
        label: label || undefined,
        task,
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = (await callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            channel: requesterOrigin?.channel,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: childSystemPrompt,
            thinking: thinkingOverride,
            timeout: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
            label: label || undefined,
            spawnedBy: spawnedByKey,
            groupId: opts?.agentGroupId ?? undefined,
            groupChannel: opts?.agentGroupChannel ?? undefined,
            groupSpace: opts?.agentGroupSpace ?? undefined,
          },
          timeoutMs: 10_000,
        })) as { runId?: string };
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          status: "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      appendSpawnEvent({
        v: 1,
        ts: Date.now(),
        event: "spawn.intent",
        runId: childRunId,
        kind: "session",
        task: task.slice(0, 500),
        label: label || undefined,
        requesterSessionKey: requesterInternalKey,
        childSessionKey,
      });
      registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        task,
        cleanup,
        label: label || undefined,
        runTimeoutSeconds,
        projectId: readStringParam(params, "projectId") || undefined,
        projectHint: readStringParam(params, "projectHint") || undefined,
      });

      // Publish session spawned event
      getEventBus().publish("session.spawned", {
        sessionKey: childSessionKey,
        runId: childRunId,
        agentId: targetAgentId,
        label: label || undefined,
        parentSessionKey: spawnedByKey,
      });

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}
