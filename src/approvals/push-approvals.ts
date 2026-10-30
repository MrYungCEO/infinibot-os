/**
 * Push for approval requests: every `requested` event from the unified
 * approval registry becomes an in-app notification + Expo push deep-linked to
 * `infinibot://approvals/<id>` (docs/mobile/DEEP-LINKS.md), so a phone tap
 * lands on the Approvals screen with approve/deny.
 *
 * Only live requests notify: restoring persisted records on boot emits no
 * `requested` events, so a gateway restart never re-pushes old approvals.
 */

import {
  onApprovalEvent,
  type ApprovalEvent,
  type ApprovalRecord,
} from "../autonomy/approval-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { EmitNotificationOpts } from "../notifications/emit.js";
import { buildDeepLink } from "../notifications/links.js";

const log = createSubsystemLogger("approvals.push");

type Emit = (opts: EmitNotificationOpts) => Promise<unknown>;

/** The notification for one pending approval (exported for tests). */
export function approvalNotification(rec: ApprovalRecord): EmitNotificationOpts {
  const title = `Approval needed: ${rec.title}`.slice(0, 200);
  const who =
    rec.requester.label ?? (rec.requester.agentId ? `agent ${rec.requester.agentId}` : null);
  const summary = rec.summary || (who ? `Requested by ${who}` : "Tap to approve or deny");
  return {
    category: "agent.input_required",
    severity: rec.risk === "high" || rec.risk === "critical" ? "error" : "warn",
    title,
    body: summary.slice(0, 400),
    source: "approvals",
    sourceId: rec.id,
    deepLink: buildDeepLink({ kind: "approval", id: rec.id }),
    displayTitle: title,
    summary: summary.slice(0, 160),
    expiresAt: rec.expiresAt,
    data: {
      approvalId: rec.id,
      risk: rec.risk,
      approvalSource: rec.source,
      requester: rec.requester,
      expiresAt: rec.expiresAt,
      options: rec.options,
    },
  };
}

export async function handleApprovalPushEvent(e: ApprovalEvent, emit: Emit): Promise<void> {
  if (e.type !== "requested" || e.record.status !== "pending") return;
  try {
    await emit(approvalNotification(e.record));
  } catch (err) {
    log.warn("approval push failed", { id: e.record.id, error: String(err) });
  }
}

let unsubscribe: (() => void) | null = null;

/** Subscribe once (idempotent); returns the unsubscribe function. */
export function installApprovalPush(emit?: Emit): () => void {
  if (unsubscribe) return unsubscribe;
  const doEmit: Emit =
    emit ?? (async (opts) => (await import("../notifications/emit.js")).emitNotification(opts));
  const off = onApprovalEvent((e) => handleApprovalPushEvent(e, doEmit));
  unsubscribe = () => {
    off();
    unsubscribe = null;
  };
  return unsubscribe;
}
