import path from "node:path";

import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import {
  getConnectedNodes,
  getRemoteSessions,
  validateNodeParameter,
  type RemoteSessionInfo,
} from "../../federation/agent-tools.js";
import { findRemoteSessionBySessionKey } from "../../federation/remote-session-registry.js";
import { callGateway } from "../../gateway/call.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  classifySessionKind,
  deriveChannel,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  type SessionListRow,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsListToolSchema = Type.Object({
  kinds: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  messageLimit: Type.Optional(Type.Number({ minimum: 0 })),
  // Federation: target specific node or include all federated nodes
  node: Type.Optional(Type.String()),
  includeFederated: Type.Optional(Type.Boolean()),
});

function resolveSandboxSessionToolsVisibility(cfg: ReturnType<typeof loadConfig>) {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

export function createSessionsListTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_list",
    description:
      "List sessions with optional filters and last messages. Use node parameter to list sessions on a specific remote node, or includeFederated=true to list sessions across all connected nodes.",
    parameters: SessionsListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const visibility = resolveSandboxSessionToolsVisibility(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : undefined;
      const restrictToSpawned =
        opts?.sandboxed === true &&
        visibility === "spawned" &&
        requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);

      const kindsRaw = readStringArrayParam(params, "kinds")?.map((value) =>
        value.trim().toLowerCase(),
      );
      const allowedKindsList = (kindsRaw ?? []).filter((value) =>
        ["main", "group", "cron", "hook", "node", "other"].includes(value),
      );
      const allowedKinds = allowedKindsList.length ? new Set(allowedKindsList) : undefined;

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;
      const activeMinutes =
        typeof params.activeMinutes === "number" && Number.isFinite(params.activeMinutes)
          ? Math.max(1, Math.floor(params.activeMinutes))
          : undefined;
      const messageLimitRaw =
        typeof params.messageLimit === "number" && Number.isFinite(params.messageLimit)
          ? Math.max(0, Math.floor(params.messageLimit))
          : 0;
      const messageLimit = Math.min(messageLimitRaw, 20);

      // ── Federation: Check for node parameter or includeFederated ──────────
      const nodeParam = readStringParam(params, "node");
      const includeFederated = params.includeFederated === true;

      // If a specific node is requested, list sessions only from that node
      if (nodeParam) {
        const nodeValidation = await validateNodeParameter(nodeParam);
        if (!nodeValidation.valid) {
          return jsonResult({
            count: 0,
            sessions: [],
            error: nodeValidation.error,
          });
        }

        if (nodeValidation.nodeId) {
          const remoteSessions = await getRemoteSessions({
            node: nodeValidation.nodeId,
            kinds: allowedKindsList.length > 0 ? allowedKindsList : undefined,
            limit,
            activeMinutes,
          });

          const remoteRows = remoteSessions.map((s) => ({
            key: s.key,
            kind: s.kind,
            channel: s.channel,
            label: s.label,
            displayName: s.displayName,
            updatedAt: s.updatedAt,
            model: s.model,
            node: s.node,
            remote: true,
          }));

          return jsonResult({
            count: remoteRows.length,
            sessions: remoteRows,
            node: nodeValidation.nodeId,
          });
        }
      }

      // Fetch local sessions
      const list = (await callGateway({
        method: "sessions.list",
        params: {
          limit,
          activeMinutes,
          includeGlobal: !restrictToSpawned,
          includeUnknown: !restrictToSpawned,
          spawnedBy: restrictToSpawned ? requesterInternalKey : undefined,
        },
      })) as {
        path?: string;
        sessions?: Array<Record<string, unknown>>;
      };

      // ── Federation: Include sessions from all connected nodes ──────────
      let federatedSessions: RemoteSessionInfo[] = [];
      let federatedNodes: Array<{
        nodeId: string;
        displayName: string;
        platform?: string;
        connected: boolean;
      }> = [];
      if (includeFederated && !restrictToSpawned) {
        try {
          const connectedNodes = await getConnectedNodes();
          federatedNodes = connectedNodes.map((n) => ({
            nodeId: n.nodeId,
            displayName: n.displayName ?? n.nodeId,
            platform: n.platform,
            connected: n.connected,
          }));
          const fetchPromises = connectedNodes.map((n) =>
            getRemoteSessions({
              node: n.nodeId,
              kinds: allowedKindsList.length > 0 ? allowedKindsList : undefined,
              limit,
              activeMinutes,
            }),
          );
          const results = await Promise.all(fetchPromises);
          federatedSessions = results.flat();
        } catch {
          // Silently ignore federation errors - continue with local sessions
        }
      }

      const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
      const storePath = typeof list?.path === "string" ? list.path : undefined;
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const requesterAgentId = resolveAgentIdFromSessionKey(requesterInternalKey);
      const rows: Array<SessionListRow & { node?: string; remote?: boolean }> = [];

      for (const entry of sessions) {
        if (!entry || typeof entry !== "object") continue;
        const key = typeof entry.key === "string" ? entry.key : "";
        if (!key) continue;

        const entryAgentId = resolveAgentIdFromSessionKey(key);
        const crossAgent = entryAgentId !== requesterAgentId;
        if (crossAgent && !a2aPolicy.isAllowed(requesterAgentId, entryAgentId)) continue;

        if (key === "unknown") continue;
        if (key === "global" && alias !== "global") continue;

        const gatewayKind = typeof entry.kind === "string" ? entry.kind : undefined;
        const kind = classifySessionKind({ key, gatewayKind, alias, mainKey });
        if (allowedKinds && !allowedKinds.has(kind)) continue;

        const displayKey = resolveDisplaySessionKey({
          key,
          alias,
          mainKey,
        });

        const entryChannel = typeof entry.channel === "string" ? entry.channel : undefined;
        const deliveryContext =
          entry.deliveryContext && typeof entry.deliveryContext === "object"
            ? (entry.deliveryContext as Record<string, unknown>)
            : undefined;
        const deliveryChannel =
          typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined;
        const deliveryTo = typeof deliveryContext?.to === "string" ? deliveryContext.to : undefined;
        const deliveryAccountId =
          typeof deliveryContext?.accountId === "string" ? deliveryContext.accountId : undefined;
        const lastChannel =
          deliveryChannel ??
          (typeof entry.lastChannel === "string" ? entry.lastChannel : undefined);
        const lastAccountId =
          deliveryAccountId ??
          (typeof entry.lastAccountId === "string" ? entry.lastAccountId : undefined);
        const derivedChannel = deriveChannel({
          key,
          kind,
          channel: entryChannel,
          lastChannel,
        });

        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
        const transcriptPath =
          sessionId && storePath
            ? path.join(path.dirname(storePath), `${sessionId}.jsonl`)
            : undefined;

        // Determine node/remote status: 1) in-memory registry, 2) persisted fields, 3) key pattern
        const remoteInfoForRow = findRemoteSessionBySessionKey(displayKey);
        const keyIndicatesRemote = displayKey.includes(":remote:");
        const nodeValue = remoteInfoForRow
          ? remoteInfoForRow.nodeName || remoteInfoForRow.nodeId
          : typeof (entry as { federationNode?: string }).federationNode === "string"
            ? (entry as { federationNode?: string }).federationNode
            : keyIndicatesRemote
              ? "federation"
              : "local";
        const remoteValue = remoteInfoForRow
          ? true
          : ((entry as { federationRemote?: boolean }).federationRemote ?? keyIndicatesRemote);

        const row: SessionListRow & { node?: string; remote?: boolean } = {
          key: displayKey,
          kind,
          channel: derivedChannel,
          label: typeof entry.label === "string" ? entry.label : undefined,
          displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
          deliveryContext:
            deliveryChannel || deliveryTo || deliveryAccountId
              ? {
                  channel: deliveryChannel,
                  to: deliveryTo,
                  accountId: deliveryAccountId,
                }
              : undefined,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
          sessionId,
          model: typeof entry.model === "string" ? entry.model : undefined,
          contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : undefined,
          totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : undefined,
          thinkingLevel: typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined,
          verboseLevel: typeof entry.verboseLevel === "string" ? entry.verboseLevel : undefined,
          systemSent: typeof entry.systemSent === "boolean" ? entry.systemSent : undefined,
          abortedLastRun:
            typeof entry.abortedLastRun === "boolean" ? entry.abortedLastRun : undefined,
          sendPolicy: typeof entry.sendPolicy === "string" ? entry.sendPolicy : undefined,
          lastChannel,
          lastTo: deliveryTo ?? (typeof entry.lastTo === "string" ? entry.lastTo : undefined),
          lastAccountId,
          transcriptPath,
          node: nodeValue,
          remote: remoteValue,
        };

        if (messageLimit > 0) {
          const resolvedKey = resolveInternalSessionKey({
            key: displayKey,
            alias,
            mainKey,
          });
          const history = (await callGateway({
            method: "chat.history",
            params: { sessionKey: resolvedKey, limit: messageLimit },
          })) as { messages?: unknown[] };
          const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
          const filtered = stripToolMessages(rawMessages);
          row.messages = filtered.length > messageLimit ? filtered.slice(-messageLimit) : filtered;
        }

        rows.push(row);
      }

      // ── Merge local and federated sessions ──────────────────────────
      // Helper to convert remote session kind to SessionKind
      const validKinds = new Set(["main", "group", "cron", "hook", "node", "other"]);
      const toSessionKind = (k: string): "main" | "group" | "cron" | "hook" | "node" | "other" =>
        validKinds.has(k) ? (k as "main" | "group" | "cron" | "hook" | "node" | "other") : "other";

      const allSessions: Array<SessionListRow & { node?: string; remote?: boolean }> = [
        // Local sessions already have node/remote fields set during row construction
        ...rows,
        ...federatedSessions.map((s) => ({
          key: s.key,
          kind: toSessionKind(s.kind),
          channel: s.channel ?? "",
          label: s.label,
          displayName: s.displayName,
          updatedAt: s.updatedAt,
          model: s.model,
          node: s.node,
          remote: true,
        })),
      ];

      // Sort by updatedAt descending (most recent first)
      allSessions.sort((a, b) => {
        const aTime = a.updatedAt ?? 0;
        const bTime = b.updatedAt ?? 0;
        return bTime - aTime;
      });

      // Apply overall limit if specified
      const finalSessions = limit ? allSessions.slice(0, limit) : allSessions;

      return jsonResult({
        count: finalSessions.length,
        sessions: finalSessions,
        ...(includeFederated
          ? {
              includedFederatedNodes: federatedNodes.length > 0,
              federatedNodes,
            }
          : {}),
      });
    },
  };
}
