/**
 * Sub-Agent Progress Reporting Tool
 *
 * Allows sub-agents to report their progress, checkpoints, and status
 * back to the requester in real-time.
 */

import { Type } from "@sinclair/typebox";

import { isSubagentSessionKey } from "../../routing/session-key.js";
import { reportProgress, type ProgressStatus } from "../subagent-progress.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SubagentProgressToolSchema = Type.Object({
  status: Type.Union([
    Type.Literal("starting"),
    Type.Literal("working"),
    Type.Literal("checkpoint"),
    Type.Literal("blocked"),
    Type.Literal("finishing"),
  ]),
  message: Type.String({ minLength: 1 }),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  checkpoint: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  notify: Type.Optional(Type.Boolean()),
});

export function createSubagentProgressTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Progress",
    name: "subagent_progress",
    description: `Report a meaningful state change back to the parent.

Be sparing. Each report is shipped to the parent agent and burns its context. Report ONLY when something the parent would want to know changed — not on every tool call.

When to report:
- "starting" — once, at kickoff (progress: 0–10)
- "checkpoint" — when you finish a real milestone (progress jumps ~20%+)
- "blocked" — you genuinely cannot proceed without help (notify:true)
- "finishing" — wrapping up (progress: 80–100). The completion ping is automatic, you usually do NOT need a separate "done" call.

Do NOT report:
- Per-file edits, per-tool-call status, "still working", or duplicate messages.
- Heartbeats — the parent polls when it needs to.

Keep message under ~120 chars. Skip "details" unless the parent specifically needs structured data.

Status values: "starting" | "working" | "checkpoint" | "blocked" | "finishing".`,
    parameters: SubagentProgressToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts?.agentSessionKey;

      // Validate we're in a sub-agent context (or allow for testing)
      if (!sessionKey) {
        return jsonResult({
          status: "error",
          error: "subagent_progress requires a session context",
        });
      }

      // Allow progress reporting from any agent, but log if not a subagent
      const isSubagent = isSubagentSessionKey(sessionKey);

      const status = readStringParam(params, "status", { required: true }) as ProgressStatus;
      const message = readStringParam(params, "message", { required: true });
      const progress = typeof params.progress === "number" ? params.progress : undefined;
      const checkpoint = typeof params.checkpoint === "string" ? params.checkpoint : undefined;
      const details =
        params.details && typeof params.details === "object"
          ? (params.details as Record<string, unknown>)
          : undefined;
      const notify = params.notify !== false; // Default to true

      const result = await reportProgress({
        sessionKey,
        status,
        message,
        progress,
        checkpoint,
        details,
        notifyRequester: notify,
      });

      if (!result.ok) {
        return jsonResult({
          status: "error",
          error: result.error,
          note: isSubagent ? undefined : "Progress reporting works best in sub-agent sessions",
        });
      }

      return jsonResult({
        status: "ok",
        reported: {
          status,
          message,
          progress,
          checkpoint,
        },
      });
    },
  };
}
