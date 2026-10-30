import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  resolveSessionReference,
  resolveMainSessionAlias,
  resolveInternalSessionKey,
  stripToolMessages,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  // Hard cap on returned messages. If omitted we use a tight default
  // (DEFAULT_HISTORY_LIMIT) instead of pulling the full transcript.
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  // Convenience alias for limit — kept so older callers using "tail" work.
  tail: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  includeTools: Type.Optional(Type.Boolean()),
});

// Most parent-agent inspections only need the last few exchanges, not the
// whole conversation. Unbounded pulls were the single biggest source of
// monitoring-loop token bloat.
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 500;

function resolveSandboxSessionToolsVisibility(cfg: ReturnType<typeof loadConfig>) {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

async function isSpawnedSessionAllowed(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
}): Promise<boolean> {
  try {
    const list = (await callGateway({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        limit: 500,
        spawnedBy: params.requesterSessionKey,
      },
    })) as { sessions?: Array<Record<string, unknown>> };
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    return sessions.some((entry) => entry?.key === params.targetSessionKey);
  } catch {
    return false;
  }
}

export function createSessionsHistoryTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    description: `Fetch recent message history for a session. Defaults to the last ${DEFAULT_HISTORY_LIMIT} messages — pass a higher \`limit\` (max ${MAX_HISTORY_LIMIT}) or \`tail\` only when you need more. Avoid pulling full transcripts in monitoring loops; prefer subagents_list for status checks.`,
    parameters: SessionsHistoryToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKeyParam = readStringParam(params, "sessionKey", {
        required: true,
      });
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
        !!requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      // From here on, use the canonical key (sessionId inputs already resolved).
      const resolvedKey = resolvedSession.key;
      const displayKey = resolvedSession.displayKey;
      const resolvedViaSessionId = resolvedSession.resolvedViaSessionId;
      if (restrictToSpawned && !resolvedViaSessionId) {
        const ok = await isSpawnedSessionAllowed({
          requesterSessionKey: requesterInternalKey,
          targetSessionKey: resolvedKey,
        });
        if (!ok) {
          return jsonResult({
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKeyParam}`,
          });
        }
      }

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const requesterAgentId = resolveAgentIdFromSessionKey(requesterInternalKey);
      const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey);
      const isCrossAgent = requesterAgentId !== targetAgentId;
      if (isCrossAgent) {
        if (!a2aPolicy.enabled) {
          return jsonResult({
            status: "forbidden",
            error:
              "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
          });
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          return jsonResult({
            status: "forbidden",
            error: "Agent-to-agent history denied by tools.agentToAgent.allow.",
          });
        }
      }

      const rawLimit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : typeof params.tail === "number" && Number.isFinite(params.tail)
            ? Math.max(1, Math.floor(params.tail as number))
            : DEFAULT_HISTORY_LIMIT;
      const limit = Math.min(rawLimit, MAX_HISTORY_LIMIT);
      const includeTools = Boolean(params.includeTools);
      const result = (await callGateway({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit },
      })) as { messages?: unknown[] };
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const messages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      return jsonResult({
        sessionKey: displayKey,
        limit,
        truncated: messages.length >= limit,
        messages,
      });
    },
  };
}
