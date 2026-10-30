/**
 * Unified approvals RPCs (src/autonomy/approval-registry.ts).
 *
 *   approvals.list     {status?, limit?}             — pending by default
 *   approvals.get      {id}
 *   approvals.wait     {id, waitSec?}                — long-poll ≤ 300s
 *   approvals.audit    {limit?}                      — audit.jsonl tail
 *   approvals.request  {title, summary?, details?, risk?, timeoutSec?, options?, source?}
 *                      — create (non-blocking); delivery to Telegram is automatic
 *   approvals.resolve  {id, action, note?}           — operator.approvals scope
 *
 * approvals.resolve is deliberately in the approvals-scope set: an agent that
 * only holds operator.write can request approval but can never grant it.
 */

import {
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  readApprovalAudit,
  resolveApprovalRequest,
  waitForApprovalRequest,
  type ApprovalAction,
  type ApprovalOption,
  type ApprovalSource,
  type ApprovalStatus,
} from "../../autonomy/approval-registry.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { approvalViaFromClient } from "./exec-approval.js";
import type { GatewayRequestHandlers } from "./types.js";

export const APPROVALS_READ_METHODS = [
  "approvals.list",
  "approvals.get",
  "approvals.wait",
  "approvals.audit",
] as const;
export const APPROVALS_WRITE_METHODS = ["approvals.request"] as const;
/** Requires operator.approvals (or admin). */
export const APPROVALS_RESOLVE_METHODS = ["approvals.resolve"] as const;

const STATUSES = new Set(["pending", "approved", "denied", "redirected", "all"]);
const REQUESTABLE_SOURCES = new Set<ApprovalSource>(["tool-gate", "orchestrator", "custom"]);
const ACTIONS = new Set<ApprovalAction>(["approve", "deny", "redirect", "approve-always"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export const approvalsHandlers: GatewayRequestHandlers = {
  "approvals.list": ({ params, respond }) => {
    const status = str(params?.status);
    const limit = typeof params?.limit === "number" ? params.limit : 100;
    const records = listApprovalRequests({
      status: status && STATUSES.has(status) ? (status as ApprovalStatus | "all") : "pending",
      limit,
    });
    respond(true, { approvals: records, pendingCount: listApprovalRequests().length });
  },

  "approvals.get": ({ params, respond }) => {
    const id = str(params?.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
      return;
    }
    const rec = getApprovalRequest(id);
    if (!rec) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
      return;
    }
    respond(true, rec);
  },

  "approvals.wait": async ({ params, respond }) => {
    const id = str(params?.id);
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
      return;
    }
    const waitSec =
      typeof params?.waitSec === "number" ? Math.min(300, Math.max(0, params.waitSec)) : 30;
    const rec = await waitForApprovalRequest(id, waitSec * 1000);
    if (!rec) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
      return;
    }
    respond(true, rec);
  },

  "approvals.audit": ({ params, respond }) => {
    const limit =
      typeof params?.limit === "number" ? Math.min(2000, Math.max(1, params.limit)) : 200;
    respond(true, { entries: readApprovalAudit(limit) });
  },

  "approvals.request": ({ params, respond, client }) => {
    const title = str(params?.title);
    if (!title) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title required"));
      return;
    }
    const sourceRaw = str(params?.source) as ApprovalSource | undefined;
    const source: ApprovalSource =
      sourceRaw && REQUESTABLE_SOURCES.has(sourceRaw) ? sourceRaw : "custom";
    const options = Array.isArray(params?.options)
      ? (params.options.filter((o: unknown) => typeof o === "string") as ApprovalOption[])
      : undefined;
    const rec = createApprovalRequest({
      source,
      title,
      summary: str(params?.summary),
      details: str(params?.details),
      risk: str(params?.risk) as never,
      options,
      timeoutMs: typeof params?.timeoutSec === "number" ? params.timeoutSec * 1000 : undefined,
      requester: {
        label:
          str(params?.requester) ??
          client?.connect?.client?.displayName ??
          client?.connect?.client?.id ??
          null,
        sessionKey: str(params?.sessionKey) ?? null,
        agentId: str(params?.agentId) ?? null,
      },
    });
    respond(true, rec);
  },

  "approvals.resolve": ({ params, respond, client }) => {
    const id = str(params?.id);
    const action = str(params?.action) as ApprovalAction | undefined;
    if (!id || !action || !ACTIONS.has(action)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "id and action (approve | deny | redirect | approve-always) required",
        ),
      );
      return;
    }
    const via = str(params?.via);
    const res = resolveApprovalRequest(id, {
      action,
      note: str(params?.note) ?? null,
      by:
        str(params?.by) ??
        client?.connect?.client?.displayName ??
        client?.connect?.client?.id ??
        "operator",
      via:
        via === "cli" || via === "chat" || via === "discord" ? via : approvalViaFromClient(client),
      // Verified connection facts (never params) for policy-restricted approvals.
      actor: {
        kind: "rpc",
        clientMode: client?.connect?.client?.mode,
        authMethod: client?.authMethod,
        saasTenantId: client?.saasTenantId,
        saasRole: client?.saasRole,
      },
    });
    respond(true, res);
  },
};
