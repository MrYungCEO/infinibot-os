/**
 * Operator approval tools — `request_approval` + `wait_approval`.
 *
 * For any agent (native, sub-agent, or an orchestrator connected over MCP)
 * that is about to do something that needs the operator's explicit OK:
 * deploys, gateway restarts, deleting data, spending money. The request goes
 * through the unified approval registry → the operator's Telegram (inline
 * Approve / Deny / Reply…) and the web approvals inbox.
 *
 * MCP-friendly: `request_approval` blocks for at most `waitSec` (default 300,
 * max 600) and returns `{status:"pending", approvalId}` if the operator hasn't
 * answered yet; call `wait_approval` with that id to keep waiting. The request
 * itself stays open until `timeoutSec` (expiry = deny, never approve).
 */

import { Type } from "@sinclair/typebox";

import {
  createApprovalRequest,
  getApprovalRequest,
  waitForApprovalRequest,
  type ApprovalOption,
  type ApprovalRecord,
  type ApprovalRisk,
} from "../../autonomy/approval-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export const APPROVAL_WAIT_MAX_SEC = 600;
const DEFAULT_WAIT_SEC = 300;
const DEFAULT_TIMEOUT_SEC = 30 * 60;
const MAX_TIMEOUT_SEC = 24 * 60 * 60;

const RequestSchema = Type.Object({
  title: Type.String({
    minLength: 1,
    description: 'Short action headline, e.g. "fly deploy infinibot-gateway (billable)".',
  }),
  summary: Type.Optional(
    Type.String({
      description: "Why this is needed and what happens if approved (1–3 sentences).",
    }),
  ),
  details: Type.Optional(
    Type.String({
      description:
        "Exact command / diff / plan the operator is approving. Secrets are redacted automatically; long text is truncated.",
    }),
  ),
  risk: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ]),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: `How long the request stays open before it is auto-DENIED (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
    }),
  ),
  waitSec: Type.Optional(
    Type.Number({
      description: `How long THIS call blocks waiting for the decision (default ${DEFAULT_WAIT_SEC}, max ${APPROVAL_WAIT_MAX_SEC}). If still pending, call wait_approval.`,
    }),
  ),
  allowRedirect: Type.Optional(
    Type.Boolean({
      description:
        'Let the operator answer with replacement instructions (status "redirected" + note) instead of a plain approve/deny.',
    }),
  ),
});

const WaitSchema = Type.Object({
  approvalId: Type.String({ minLength: 1 }),
  waitSec: Type.Optional(
    Type.Number({
      description: `Max seconds to block (default ${DEFAULT_WAIT_SEC}, max ${APPROVAL_WAIT_MAX_SEC}).`,
    }),
  ),
});

function clampWait(raw: number | undefined): number {
  return Math.max(0, Math.min(APPROVAL_WAIT_MAX_SEC, raw ?? DEFAULT_WAIT_SEC));
}

/** Tool result for a record (pending / decided / timed out). */
export function describeApprovalOutcome(rec: ApprovalRecord) {
  if (rec.status === "pending") {
    return {
      status: "pending" as const,
      approvalId: rec.id,
      expiresAt: new Date(rec.expiresAt).toISOString(),
      instruction:
        "The operator has not answered yet. Do NOT proceed. Call wait_approval with this approvalId to keep waiting.",
    };
  }
  const timedOut = rec.decidedVia === "system";
  const status = timedOut ? ("timed_out" as const) : rec.status;
  const instruction =
    status === "approved"
      ? "APPROVED — proceed with exactly what you described."
      : status === "redirected"
        ? "REDIRECTED — do NOT do what you proposed; follow the operator's note instead."
        : timedOut
          ? "No decision before expiry — treat as DENIED. Do not proceed; report back instead."
          : "DENIED — do not proceed. Report back or choose a safer alternative.";
  return {
    status,
    decision: timedOut
      ? "deny"
      : rec.status === "approved"
        ? "approve"
        : rec.status === "redirected"
          ? "redirect"
          : "deny",
    note: rec.note,
    approvalId: rec.id,
    decidedBy: rec.decidedBy,
    decidedVia: rec.decidedVia,
    decidedAt: rec.decidedAt ? new Date(rec.decidedAt).toISOString() : null,
    instruction,
  };
}

function requesterFor(sessionKey: string | undefined) {
  const parsed = sessionKey ? parseAgentSessionKey(sessionKey) : null;
  const rest = parsed?.rest ?? "";
  const label = /(^|:)mcp/.test(rest)
    ? "MCP orchestrator"
    : /subagent|claude-coder|coder/.test(sessionKey ?? "")
      ? "Sub-agent"
      : parsed?.agentId
        ? `agent ${parsed.agentId}`
        : null;
  return { sessionKey: sessionKey ?? null, agentId: parsed?.agentId ?? null, label };
}

export function createRequestApprovalTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Request approval",
    name: "request_approval",
    description:
      "Ask the human operator for explicit approval BEFORE doing something risky or irreversible: production/billable deploys (fly deploy, netlify prod), gateway restarts, deleting data, spending money, force-pushes, sending external messages on their behalf. " +
      "The request is pushed to the operator's phone (Telegram, inline Approve/Deny/Reply) and the web approvals inbox. " +
      "Returns {status: approved | denied | redirected | timed_out | pending, note}. Only proceed on status=approved (honour any note). redirected = follow the note instead. " +
      "If status=pending, call wait_approval with the returned approvalId. Never proceed without an approval. Expiry = denied.",
    parameters: RequestSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { required: true });
      const timeoutSec = Math.max(
        10,
        Math.min(MAX_TIMEOUT_SEC, readNumberParam(params, "timeoutSec") ?? DEFAULT_TIMEOUT_SEC),
      );
      const waitSec = Math.min(clampWait(readNumberParam(params, "waitSec")), timeoutSec);
      const options: ApprovalOption[] = ["approve", "deny", "approve-with-note"];
      if (params.allowRedirect === true) options.push("redirect");
      const risk = readStringParam(params, "risk") as ApprovalRisk | undefined;
      const rec = createApprovalRequest({
        source: "orchestrator",
        title,
        summary: readStringParam(params, "summary"),
        details: readStringParam(params, "details"),
        risk,
        options,
        timeoutMs: timeoutSec * 1000,
        requester: requesterFor(opts?.agentSessionKey),
        resumable: true,
      });
      const outcome = (await waitForApprovalRequest(rec.id, waitSec * 1000)) ?? rec;
      return jsonResult(describeApprovalOutcome(outcome));
    },
  };
}

export function createWaitApprovalTool(): AnyAgentTool {
  return {
    label: "Wait for approval",
    name: "wait_approval",
    description:
      "Keep waiting for an operator decision on a request_approval id. Blocks up to waitSec, then returns the same shape as request_approval (status pending → call again). Survives gateway restarts: the request is persisted.",
    parameters: WaitSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const id = readStringParam(params, "approvalId", { required: true });
      if (!getApprovalRequest(id)) {
        return jsonResult({ status: "error", error: `unknown approvalId ${id}` });
      }
      const rec = await waitForApprovalRequest(
        id,
        clampWait(readNumberParam(params, "waitSec")) * 1000,
      );
      if (!rec) return jsonResult({ status: "error", error: `unknown approvalId ${id}` });
      return jsonResult(describeApprovalOutcome(rec));
    },
  };
}
