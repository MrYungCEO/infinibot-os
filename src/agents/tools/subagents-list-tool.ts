/**
 * Sub-Agents List Tool
 *
 * Allows agents to query the status and progress of their spawned sub-agents.
 */

import { Type } from "@sinclair/typebox";

import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const SubagentsListToolSchema = Type.Object({
  includeCompleted: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  // Default = true → omits per-agent update history; returns only status,
  // progress, current checkpoint, and a one-line lastUpdate. Pass false to
  // pull the recent updates (capped) when you genuinely need them.
  verbose: Type.Optional(Type.Boolean()),
  // Epoch ms. When set, the server only returns updates newer than this.
  // Use the previous call's `serverTime` to do diff-style polling.
  since: Type.Optional(Type.Number({ minimum: 0 })),
});

export function createSubagentsListTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Sub-Agents",
    name: "subagents_list",
    description: `Compact status board for your spawned sub-agents.

Defaults to a tight summary (one line per agent: status, progress %, current checkpoint, last update). Pass verbose:true ONLY if you need the recent update history — it triples the payload.

Token-aware polling:
- The response includes a serverTime. Pass it back as \`since\` on the next call and you'll only get NEW updates per agent.
- Subagents call \`subagent_progress\` themselves and ping you on completion — you do NOT need to poll constantly. Use this tool when the user asks, or when a specific run feels stuck.

Returns: { subagents:[{ runId, sessionKey, label, status, progress, currentCheckpoint, lastUpdate, duration, outcome? }], total, active, serverTime, since? }`,
    parameters: SubagentsListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const includeCompleted = params.includeCompleted === true;
      const limit =
        typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, 50) : 20;
      const verbose = params.verbose === true;
      const since = typeof params.since === "number" && params.since > 0 ? params.since : undefined;

      try {
        const result = (await callGateway({
          method: "subagents.list",
          params: {
            requesterSessionKey: opts?.agentSessionKey,
            includeCompleted,
            limit,
            compact: !verbose,
            since,
            updatesTail: verbose ? 3 : 0,
          },
          timeoutMs: 10_000,
        })) as {
          ok: boolean;
          subagents?: Array<{
            runId: string;
            sessionKey: string;
            label?: string;
            task: string;
            status: string;
            progress: number;
            checkpoints: string[];
            currentCheckpoint?: string;
            createdAt: number;
            startedAt?: number;
            endedAt?: number;
            lastUpdateAt: number;
            outcome?: { status: string; error?: string };
            recentUpdates: Array<{
              status: string;
              message: string;
              progress?: number;
              timestamp: number;
            }>;
            lastActivity?: { kind: string; label: string; at: number };
          }>;
          total?: number;
          serverTime?: number;
          error?: string;
        };

        if (!result.ok) {
          return jsonResult({
            status: "error",
            error: result.error || "Failed to list sub-agents",
          });
        }

        // Format for display — keep compact by default so the parent agent
        // can poll without burning context. Only include recentUpdates when
        // the caller explicitly asked for verbose.
        const subagents = (result.subagents || []).map((sa) => {
          const durationMs = sa.endedAt
            ? sa.endedAt - (sa.startedAt || sa.createdAt)
            : Date.now() - (sa.startedAt || sa.createdAt);
          const durationStr = formatDuration(durationMs);
          const tail =
            sa.recentUpdates && sa.recentUpdates.length > 0
              ? sa.recentUpdates[sa.recentUpdates.length - 1]
              : undefined;

          const base: Record<string, unknown> = {
            runId: sa.runId,
            sessionKey: sa.sessionKey,
            label: sa.label || "(unnamed)",
            status: sa.status,
            progress: sa.progress,
            currentCheckpoint: sa.currentCheckpoint,
            duration: durationStr,
            outcome: sa.outcome,
            lastUpdate: tail?.message,
            lastActivity: sa.lastActivity
              ? {
                  kind: sa.lastActivity.kind,
                  label: sa.lastActivity.label,
                  ageMs: Date.now() - sa.lastActivity.at,
                }
              : undefined,
          };
          if (verbose) {
            base.task = sa.task;
            base.checkpoints = sa.checkpoints;
            base.recentUpdates = sa.recentUpdates;
          }
          return base;
        });

        return jsonResult({
          status: "ok",
          subagents,
          total: result.total,
          active: subagents.filter((s) => s.status !== "completed" && !s.outcome).length,
          serverTime: result.serverTime,
          // Echo the since cursor used so the caller can chain calls.
          since,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          error: message,
        });
      }
    },
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
