/**
 * Mid-run Check-in Tool — `report_checkpoint`
 *
 * Lets a long-running coder sub-agent surface a structured progress check-in so
 * the operator can see what it just finished, what it's about to do, and any
 * deviations from the brief — instead of the run drifting silently until the
 * final result.
 *
 * Two modes, decided per-run at spawn time (see registerCheckpointConfig):
 *   • soft (default)  — records + broadcasts the check-in, returns immediately.
 *   • strict (gated)  — when the run was spawned with requireCheckpointApproval,
 *     this tool BLOCKS until the operator clicks Approve / Redirect / Stop in
 *     the agent focus modal, then returns that decision so the agent can act on
 *     it (proceed, follow an edited plan, or wind down).
 */

import { Type } from "@sinclair/typebox";

import { isSubagentSessionKey } from "../../routing/session-key.js";
import { recordCheckpoint } from "../subagent-progress.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const CheckpointReportToolSchema = Type.Object({
  summary: Type.String({
    minLength: 1,
    description: "One paragraph: what you just finished since the last check-in.",
  }),
  next: Type.String({
    minLength: 1,
    description: "What you are about to do next.",
  }),
  deviations: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Any deviations from the original brief or scope you are considering (off-limits files, scope creep, approach changes). Empty when you are on-plan.",
    }),
  ),
});

export function createCheckpointReportTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Check-in",
    name: "report_checkpoint",
    description: `Emit a mid-run check-in. Call this every ~10–15 minutes OR every ~10 file edits during long tasks.

State, in one short paragraph each:
- summary — what you just finished
- next — what you are about to do
- deviations[] — anything that departs from the brief or scope (off-limits files, scope creep, a changed approach). Leave empty when on-plan.

This surfaces live to the operator so the work isn't a black box. If this run was spawned with approval required, the call will PAUSE until the operator approves, redirects (you'll receive an edited next-step plan to follow), or stops you (wind down promptly).

This is separate from subagent_progress — use report_checkpoint for the cadence-based "still on track?" check-in, and subagent_progress for milestone/blocked signals.`,
    parameters: CheckpointReportToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts?.agentSessionKey;
      if (!sessionKey) {
        return jsonResult({
          status: "error",
          error: "report_checkpoint requires a session context",
        });
      }

      const summary = readStringParam(params, "summary", { required: true });
      const next = readStringParam(params, "next", { required: true });
      const deviations = Array.isArray(params.deviations)
        ? (params.deviations as unknown[]).filter((d): d is string => typeof d === "string")
        : [];

      const { checkpoint, wait } = recordCheckpoint({
        sessionKey,
        summary,
        next,
        deviations,
      });

      // Soft gate (default): record + broadcast, do not block.
      if (!wait) {
        return jsonResult({
          status: "ok",
          checkpointId: checkpoint.id,
          gated: false,
          driftSuspected: checkpoint.driftSuspected,
          acknowledged: true,
          note: isSubagentSessionKey(sessionKey)
            ? "Check-in recorded. Continue."
            : "Check-in recorded (works best in sub-agent sessions). Continue.",
        });
      }

      // Strict gate: block until the operator decides (or the safety timeout).
      const resolution = await wait;
      if (resolution.decision === "stop") {
        return jsonResult({
          status: "stopped",
          checkpointId: checkpoint.id,
          decision: "stop",
          instruction:
            "The operator asked you to STOP. Do not start new work. Summarize what you have done so far, leave the tree in a consistent state, and finish.",
          note: resolution.note,
        });
      }
      if (resolution.decision === "redirect") {
        return jsonResult({
          status: "redirected",
          checkpointId: checkpoint.id,
          decision: "redirect",
          instruction:
            "The operator REDIRECTED you. Discard your previous 'next' plan and follow this revised plan instead:",
          revisedPlan: resolution.editedNext || next,
          note: resolution.note,
        });
      }
      return jsonResult({
        status: "approved",
        checkpointId: checkpoint.id,
        decision: "approve",
        instruction: "The operator APPROVED your plan. Proceed with your stated next step.",
        note: resolution.note,
      });
    },
  };
}
