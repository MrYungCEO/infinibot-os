import {
  createApprovalRequest,
  resolveApprovalRequest,
  type ApprovalRecord,
  type ApprovalVia,
} from "../../autonomy/approval-registry.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecApprovalRequestParams,
  validateExecApprovalResolveParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function execDecisionFromRecord(rec: ApprovalRecord): ExecApprovalDecision {
  if (rec.status !== "approved") return "deny";
  return rec.action === "approve-always" ? "allow-always" : "allow-once";
}

/** Best-effort surface label for the approval audit trail. */
export function approvalViaFromClient(
  client:
    | {
        connect?: { client?: { id?: string; displayName?: string; mode?: string } };
      }
    | null
    | undefined,
): ApprovalVia {
  const c = client?.connect?.client;
  const hay = `${c?.id ?? ""} ${c?.displayName ?? ""}`.toLowerCase();
  if (hay.includes("discord")) return "discord";
  if (hay.includes("chat approval")) return "chat";
  if (hay.includes("telegram")) return "telegram";
  if (c?.mode === "cli" || hay.includes("cli")) return "cli";
  return "ui";
}

export function createExecApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "exec.approval.request": async ({ params, respond, context }) => {
      if (!validateExecApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.request params: ${formatValidationErrors(
              validateExecApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        command: string;
        cwd?: string;
        host?: string;
        security?: string;
        ask?: string;
        agentId?: string;
        resolvedPath?: string;
        sessionKey?: string;
        timeoutMs?: number;
      };
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 120_000;
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }
      const request = {
        command: p.command,
        cwd: p.cwd ?? null,
        host: p.host ?? null,
        security: p.security ?? null,
        ask: p.ask ?? null,
        agentId: p.agentId ?? null,
        resolvedPath: p.resolvedPath ?? null,
        sessionKey: p.sessionKey ?? null,
      };
      const record = manager.create(request, timeoutMs, explicitId);
      const decisionPromise = manager.waitForDecision(record, timeoutMs);
      // Mirror into the unified approval registry (same id) so the request
      // reaches Telegram + the web approvals inbox and can be answered from
      // any surface. First resolution wins; the callback unblocks the exec.
      createApprovalRequest({
        id: record.id,
        source: "exec",
        title: `Run command${request.host ? ` on ${request.host}` : ""}`,
        summary: [
          request.cwd ? `cwd: ${request.cwd}` : "",
          request.security ? `security: ${request.security}` : "",
          request.ask ? `ask: ${request.ask}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        details: request.command,
        risk: request.security === "full" ? "high" : "medium",
        options: ["approve", "deny", "approve-always"],
        requester: {
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          label: request.agentId ? `agent ${request.agentId}` : null,
        },
        sourceRef: { execId: record.id },
        timeoutMs,
        resumable: false,
        onResolve: (rec) => {
          const decision = execDecisionFromRecord(rec);
          const by = rec.decidedVia === "system" ? "system (expired)" : rec.decidedBy;
          if (!manager.resolve(record.id, decision, by)) return;
          const ts = Date.now();
          context.broadcast(
            "exec.approval.resolved",
            { id: record.id, decision, resolvedBy: by, ts },
            { dropIfSlow: true },
          );
          void opts?.forwarder
            ?.handleResolved({ id: record.id, decision, resolvedBy: by, ts })
            .catch((err) => {
              context.logGateway?.error?.(`exec approvals: forward resolve failed: ${String(err)}`);
            });
        },
      });
      context.broadcast(
        "exec.approval.requested",
        {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleRequested({
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        })
        .catch((err) => {
          context.logGateway?.error?.(`exec approvals: forward request failed: ${String(err)}`);
        });
      const decision = await decisionPromise;
      respond(
        true,
        {
          id: record.id,
          decision,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },
    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateExecApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.resolve params: ${formatValidationErrors(
              validateExecApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      const decision = p.decision as ExecApprovalDecision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      // Unified registry first: its callback resolves the manager + broadcasts.
      const unified = resolveApprovalRequest(p.id, {
        action:
          decision === "allow-once"
            ? "approve"
            : decision === "allow-always"
              ? "approve-always"
              : "deny",
        by: resolvedBy ?? null,
        via: approvalViaFromClient(client),
      });
      if (unified.ok) {
        respond(true, { ok: true }, undefined);
        return;
      }
      if (unified.error === "already_resolved" && unified.record) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `approval already ${unified.record.status} by ${unified.record.decidedBy ?? "someone"}`,
          ),
        );
        return;
      }
      const ok = manager.resolve(p.id, decision, resolvedBy ?? null);
      if (!ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
        return;
      }
      context.broadcast(
        "exec.approval.resolved",
        { id: p.id, decision, resolvedBy, ts: Date.now() },
        { dropIfSlow: true },
      );
      void opts?.forwarder
        ?.handleResolved({ id: p.id, decision, resolvedBy, ts: Date.now() })
        .catch((err) => {
          context.logGateway?.error?.(`exec approvals: forward resolve failed: ${String(err)}`);
        });
      respond(true, { ok: true }, undefined);
    },
  };
}
