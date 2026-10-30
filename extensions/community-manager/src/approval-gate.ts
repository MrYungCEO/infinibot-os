/**
 * Approval gate (plan §1 autonomy split / §7 human in the loop).
 *
 * Gated: every ban/unban and kick, timeouts over 1 h, DMs to more than 25
 * people, and any post that pings @everyone / @here. Gated actions are never
 * executed directly: they become a request in core's approval registry
 * (`api.runtime.host.approvals`, the same queue `request_approval` uses) that
 * shows up in the dashboard, Telegram and mobile. Expiry is 24 h and an
 * expired or unanswered request counts as a deny.
 */

import type { ModActionKind } from "./contract.js";
import { MASS_DM_THRESHOLD, MAX_AUTONOMOUS_TIMEOUT_MS } from "./defaults.js";

export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000;

export type GateInput = {
  action: ModActionKind;
  durationMs?: number | null;
  recipients?: number;
  content?: string;
};

const EVERYONE_RE = /@(everyone|here)\b/;

export function pingsEveryone(content: string | undefined | null): boolean {
  return EVERYONE_RE.test(content ?? "");
}

/** Does this action need a human approval before it runs? */
export function needsApproval(input: GateInput): boolean {
  switch (input.action) {
    case "ban":
    case "kick":
      return true;
    case "timeout":
      return (input.durationMs ?? 0) > MAX_AUTONOMOUS_TIMEOUT_MS;
    case "mass_dm":
      return (input.recipients ?? 0) > MASS_DM_THRESHOLD;
    case "announce_everyone":
      return true;
    case "warn":
    case "delete":
      return pingsEveryone(input.content);
    default:
      return true;
  }
}

/** The subset of core's HostApprovals the gate needs (injectable in tests). */
export type ApprovalsLike = {
  create(input: {
    source: "custom";
    title: string;
    summary?: string;
    details?: string;
    risk?: "low" | "medium" | "high" | "critical";
    options?: Array<"approve" | "deny">;
    sourceRef?: Record<string, string>;
    timeoutMs?: number;
    resumable?: boolean;
    requester?: { agentId?: string | null; label?: string | null };
  }): { id: string; status: string };
  get(id: string): { id: string; status: string } | null;
  onEvent(listener: (event: { type: string; record: { id: string; status: string; sourceRef?: Record<string, string> } }) => void): () => void;
};

export type GateRequest = {
  title: string;
  summary: string;
  details?: string;
  risk?: "medium" | "high" | "critical";
  /** Plugin record this approval unlocks (e.g. `{ kind: "mod", id }`). */
  ref: { kind: "mod" | "campaign"; id: string };
};

export type GateDecision = "approved" | "denied" | "pending";

export class ApprovalGate {
  constructor(private approvals: ApprovalsLike | null) {}

  get available(): boolean {
    return this.approvals !== null;
  }

  /**
   * File a request. Returns the approval id, or null when no approval system
   * is wired (then the action simply never runs — deny by default).
   */
  request(req: GateRequest): string | null {
    if (!this.approvals) return null;
    const rec = this.approvals.create({
      source: "custom",
      title: req.title,
      summary: req.summary,
      details: req.details,
      risk: req.risk ?? "high",
      options: ["approve", "deny"],
      sourceRef: { plugin: "community-manager", kind: req.ref.kind, id: req.ref.id },
      timeoutMs: APPROVAL_TIMEOUT_MS,
      // The decision is applied from the plugin DB, so it survives a restart.
      resumable: true,
      requester: { agentId: "community", label: "Community Manager" },
    });
    return rec.id;
  }

  decision(approvalId: string): GateDecision {
    const rec = this.approvals?.get(approvalId);
    if (!rec) return "denied";
    if (rec.status === "approved") return "approved";
    if (rec.status === "pending") return "pending";
    return "denied";
  }

  /** Resolved approvals that belong to this plugin. */
  onResolved(listener: (ref: { kind: string; id: string }, approved: boolean, approvalId: string) => void): () => void {
    if (!this.approvals) return () => {};
    return this.approvals.onEvent((event) => {
      if (event.type !== "resolved") return;
      const ref = event.record.sourceRef;
      if (ref?.plugin !== "community-manager" || !ref.kind || !ref.id) return;
      listener({ kind: ref.kind, id: ref.id }, event.record.status === "approved", event.record.id);
    });
  }
}
