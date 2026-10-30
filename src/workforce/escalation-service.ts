/**
 * The escalation protocol runtime.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *   raise()         — decide, compose, persist. Never touches a channel.
 *   processQueue()  — deliver what is due. Idempotent; never re-sends.
 *   flushDigests()  — send batched proactive insights as ONE message.
 *   answer()        — the human's reply resolves the escalation, unblocks the
 *                     work item, and lands in job memory for the next prompt.
 *
 * Splitting raise from deliver is the load-bearing decision. It makes delivery
 * failure non-destructive (the row exists, composed and readable, before any
 * network call), makes the loop idempotent (delivery is keyed on
 * `delivered_at IS NULL`, not on the caller remembering), and keeps `raise()`
 * synchronous so an employee can escalate from inside a transaction.
 *
 * Every dependency — transport, clock, broadcast — is injected. Tests never
 * send a real message.
 */

import { randomUUID } from "node:crypto";

import {
  planResponse,
  resolveCommunicationProfile,
  type CommunicationProfile,
  type ScheduleWindow,
} from "./communication.js";
import {
  composeApprovalRequestMessage,
  composeDigestMessage,
  composeEscalationMessage,
  parseApprovalDirective,
  parseEscalationReference,
} from "./escalation-compose.js";
import { isWithinQuietHours, nextDigestAt, quietHoursEndAt } from "./escalation-schedule.js";
import type { WorkforceEscalationStore } from "./escalation-store.js";
import {
  ESCALATION_EVENT,
  ESCALATION_MEMORY_NAMESPACE,
  MAX_ESCALATION_ANSWER_CHARS,
  normalizeEscalationInput,
  sanitizeEscalationText,
  URGENCY_RANK,
  type AgencyEscalationPolicy,
  type Escalation,
  type EscalationInput,
  type EscalationKind,
} from "./escalation-types.js";
import type { EmployeeWorkItem, JobMemoryRecord, Worker, WorkItemStatus } from "./types.js";
import type { WorkerChannelBinding } from "./channel-bindings.js";
import type { ChatChannelId } from "../channels/registry.js";

// ── Injected dependencies ───────────────────────────────────────────────────

export type EscalationTransportRequest = {
  agencyId: string;
  escalationIds: string[];
  workerId: string;
  channelId: ChatChannelId;
  to: string | null;
  text: string;
  urgent: boolean;
};

export type EscalationTransportResult = { messageId?: string | null };

/**
 * How an escalation actually reaches a channel. The gateway supplies a thin
 * wrapper over `src/infra/outbound/message.ts#sendMessage`; tests supply a
 * spy. Nothing in this module knows what a Slack token is.
 */
export type EscalationTransport = (
  request: EscalationTransportRequest,
) => Promise<EscalationTransportResult>;

export interface EscalationWorkerStore {
  getWorker(agencyId: string, workerId: string): Worker | null;
  listChannelBindings?(
    agencyId: string,
    filters?: { workerId?: string; channelId?: string; enabled?: boolean },
  ): WorkerChannelBinding[];
  recordAudit?(
    agencyId: string,
    actorId: string | undefined,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): void;
}

export interface EscalationOperatingStore {
  getWorkItem(agencyId: string, id: string): EmployeeWorkItem | null;
  transitionWorkItem(
    agencyId: string,
    id: string,
    status: WorkItemStatus,
    options?: { waitingReason?: string | null; reviewNote?: string | null; now?: number },
  ): EmployeeWorkItem;
  upsertJobMemory(
    agencyId: string,
    input: {
      workerId: string;
      workItemId?: string | null;
      namespace: string;
      key: string;
      value: unknown;
      source?: string;
      expiresAt?: number | null;
    },
  ): JobMemoryRecord;
  listSchedules?(agencyId: string, workerId?: string): ScheduleWindow[];
}

export type EscalationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type EscalationServiceDeps = {
  store: WorkforceEscalationStore;
  workerStore: EscalationWorkerStore;
  operatingStore?: EscalationOperatingStore | null;
  transport?: EscalationTransport | null;
  broadcast?: (event: string, payload: unknown) => void;
  now?: () => number;
  log?: EscalationLogger;
};

const noopLog: EscalationLogger = { info: () => {}, warn: () => {} };

// ── Results ─────────────────────────────────────────────────────────────────

export type EscalationRaiseResult = {
  escalation: Escalation;
  /** False when an open duplicate absorbed it. */
  created: boolean;
  deduped: boolean;
  /** `sent` is never true here — raising only persists. */
  decision:
    | "queued"
    | "scheduled"
    | "batched"
    | "awaiting_approval"
    | "deduped"
    | "suppressed_rate_limit"
    | "suppressed_muted"
    | "suppressed_proactivity"
    | "suppressed_disabled";
  reason: string;
};

export type EscalationQueueResult = {
  agencyId: string;
  considered: number;
  delivered: number;
  failed: number;
  skipped: number;
  /** Draft approval requests put in front of a human this pass. */
  approvalsRequested: number;
  escalationIds: string[];
};

export type EscalationDigestResult = {
  agencyId: string;
  digestsSent: number;
  itemsDelivered: number;
  deferred: number;
};

export type EscalationAnswerResult = {
  escalation: Escalation;
  workItem: EmployeeWorkItem | null;
  /** True when the work item actually left `waiting`. */
  resumed: boolean;
  memoryKey: string;
};

/** What an inbound message turned out to be. */
export type EscalationInboundResult =
  | { matched: false; reason?: string }
  | ({ matched: true; via: "tag" | "channel"; action: "answered" } & EscalationAnswerResult)
  | {
      matched: true;
      via: "tag" | "channel";
      action: "approved" | "edited" | "rejected";
      escalation: Escalation;
    };

const BACKOFF_SECONDS = [60, 300, 900, 3_600];

export class EscalationService {
  private readonly deps: EscalationServiceDeps;
  private readonly log: EscalationLogger;
  private readonly now: () => number;

  constructor(deps: EscalationServiceDeps) {
    this.deps = deps;
    this.log = deps.log ?? noopLog;
    this.now = deps.now ?? (() => Date.now());
  }

  policy(agencyId: string, workerId?: string | null): AgencyEscalationPolicy {
    return this.deps.store.getPolicy(agencyId, workerId ?? null);
  }

  // ── Raise ─────────────────────────────────────────────────────────────────

  /**
   * Decide whether this escalation should reach the human, compose it in the
   * employee's own voice, and persist it. Synchronous and side-effect-free
   * beyond the single row it writes (or the single `occurrences` bump).
   */
  raise(agencyId: string, input: EscalationInput): EscalationRaiseResult {
    const now = this.now();
    const normalized = normalizeEscalationInput(input);
    const policy = this.policy(agencyId, normalized.workerId);
    const worker = this.deps.workerStore.getWorker(agencyId, normalized.workerId);
    if (!worker) throw new Error("employee not found");
    const profile = resolveCommunicationProfile(worker);

    // 1. Muted / disabled. Still persisted: the operator turned off delivery,
    //    not the record. The board must still show what the employee raised.
    if (!policy.enabled || policy.mutedKinds.includes(normalized.kind)) {
      return this.suppress(
        agencyId,
        normalized,
        now,
        policy.enabled ? "suppressed_muted" : "suppressed_disabled",
        policy.enabled
          ? `${normalized.kind} is muted by escalation policy`
          : "escalation delivery is disabled for this agency",
        profile,
      );
    }

    // 2. Dedupe. An employee looping on the same failure collapses into ONE
    //    row with a rising `occurrences`, not 200 messages.
    const window = now - policy.dedupeWindowMinutes * 60_000;
    const duplicate = this.deps.store.findOpenDuplicate(
      agencyId,
      normalized.workerId,
      normalized.dedupeKey,
      window,
    );
    if (duplicate) {
      const bumped = this.deps.store.bumpOccurrence(agencyId, duplicate.id, now) ?? duplicate;
      this.broadcast(agencyId, bumped);
      return {
        escalation: bumped,
        created: false,
        deduped: true,
        decision: "deduped",
        reason: `collapsed into ${duplicate.correlationCode} (occurrence ${bumped.occurrences})`,
      };
    }

    // 3. Route. The RECIPIENT's route — which for a client message is the
    //    client, not the owner. The approver is resolved separately below.
    const route = this.resolveRoute(agencyId, normalized.workerId, normalized.kind, policy, {
      channelId: normalized.channelId,
      target: normalized.target,
      bindingId: normalized.bindingId,
    });

    // 3b. Approval gate. `requiresApproval` is an explicit override; otherwise
    //     policy decides by recipient kind, and `client` is on that list by
    //     default. Nothing reaches a client unreviewed.
    const requiresApproval =
      normalized.requiresApproval ??
      policy.approval.requireForRecipients.includes(normalized.recipientKind);
    // The correlation code is reserved BEFORE composing so the message the
    // human receives carries the tag their reply is matched on.
    const correlationCode = this.deps.store.nextCorrelationCode(agencyId);

    // 4. Proactivity gate — the profile decides whether this employee
    //    volunteers observations at all, and whether they are batched.
    const urgent = URGENCY_RANK[normalized.urgency] >= URGENCY_RANK[policy.urgencyBypass];
    let status: Escalation["status"];
    let reason: string;
    let digestDueAt: number | null = null;
    let deliverAfter = now;

    if (requiresApproval) {
      // Draft → approve → deliver. `deliverAfter` here paces the *approval
      // request* to the approver; approving re-arms it for the recipient.
      status = "awaiting_approval";
      deliverAfter = policy.approval.bypassQuietHours ? now : quietHoursEndAt(policy, now);
      reason = `awaiting human approval before sending to ${
        normalized.recipientLabel ?? normalized.recipientKind
      }`;
    } else if (normalized.recipientKind !== "operator") {
      // A pre-authorised outbound message. Never batched — a client is not a
      // digest subscriber — and paced by the employee's own latency policy.
      const schedules =
        this.deps.operatingStore?.listSchedules?.(agencyId, normalized.workerId) ?? [];
      const plan = planResponse({ profile, channelId: route.channelId, schedules, now, urgent });
      deliverAfter = urgent ? now : plan.respondAt;
      reason = `approval not required for ${normalized.recipientKind}; ${plan.reason}`;
      status = deliverAfter <= now ? "pending" : "scheduled";
    } else if (normalized.kind === "proactive_insight") {
      if (profile.proactivity === "reactive") {
        return this.suppress(
          agencyId,
          normalized,
          now,
          "suppressed_proactivity",
          "proactivity is 'reactive': this employee does not volunteer observations",
          profile,
          route,
        );
      }
      if (policy.digest.enabled && profile.proactivity !== "driving") {
        status = "batched";
        digestDueAt = nextDigestAt(
          policy.digest.cadence,
          policy.digest.timeOfDay,
          policy.digest.timezone,
          now,
        );
        reason = `batched into the ${policy.digest.cadence} digest`;
        deliverAfter = digestDueAt;
      } else if (policy.digest.enabled) {
        // `driving` still batches, just on the tightest window we have, so even
        // the most forward employee cannot fire one message per thought.
        status = "batched";
        digestDueAt = nextDigestAt("hourly", policy.digest.timeOfDay, policy.digest.timezone, now);
        reason = "batched into the next hourly digest (proactivity: driving)";
        deliverAfter = digestDueAt;
      } else {
        status = "scheduled";
        deliverAfter = quietHoursEndAt(policy, now);
        reason = "digest disabled; queued as a single insight";
      }
    } else {
      // 5. Schedule-aware timing for a real ask. `planResponse` owns working
      //    hours; quiet hours sit on top; urgency bypasses both.
      const schedules =
        this.deps.operatingStore?.listSchedules?.(agencyId, normalized.workerId) ?? [];
      const plan = planResponse({
        profile,
        channelId: route.channelId,
        schedules,
        now,
        urgent,
      });
      if (urgent) {
        deliverAfter = now;
        reason = `urgent (${normalized.urgency}): working hours and quiet hours bypassed`;
      } else {
        const quietEnd = quietHoursEndAt(policy, now);
        deliverAfter = Math.max(plan.respondAt, quietEnd);
        reason = isWithinQuietHours(policy, now)
          ? `held until quiet hours end (${policy.quietHours.end} ${policy.quietHours.timezone})`
          : plan.reason;
      }
      status = deliverAfter <= now ? "pending" : "scheduled";
    }

    // 6. Rate limit. Applied last so the reason survives into the record.
    //    Only messages TO the operator are capped — the cap exists to stop an
    //    assistant being muted, and a client message is gated by human
    //    approval instead, which is a stronger throttle than any counter.
    if (normalized.recipientKind === "operator") {
      const limited = this.rateLimitReason(agencyId, normalized.workerId, policy, now, urgent);
      if (limited) {
        return this.suppress(
          agencyId,
          normalized,
          now,
          "suppressed_rate_limit",
          limited,
          profile,
          route,
        );
      }
    }

    // Composed at raise time so the record is complete and readable in the UI
    // even if every channel is down forever. An employee that drafted its own
    // wording (a client reply) keeps that wording verbatim.
    const body =
      normalized.draftMessage ??
      this.compose(normalized, profile, route.channelId, worker, correlationCode);
    const approvalRoute = requiresApproval
      ? this.resolveApprovalRoute(agencyId, normalized, policy, route)
      : { channelId: null, target: null };

    const escalation = this.deps.store.create(agencyId, {
      ...normalized,
      correlationCode,
      channelId: route.channelId,
      target: route.target,
      bindingId: route.bindingId,
      requiresApproval,
      approvalState: requiresApproval ? "pending" : "not_required",
      approvalChannelId: approvalRoute.channelId,
      approvalTarget: approvalRoute.target,
      draftMessage: body,
      status,
      digestDueAt,
      deliverAfter,
      reason,
      composedMessage: body,
      now,
    });
    this.broadcast(agencyId, escalation);
    return {
      escalation,
      created: true,
      deduped: false,
      decision: requiresApproval
        ? "awaiting_approval"
        : status === "batched"
          ? "batched"
          : status === "scheduled"
            ? "scheduled"
            : "queued",
      reason,
    };
  }

  // ── Draft → approve → deliver ─────────────────────────────────────────────

  /**
   * The human signs off on the exact wording. `editedMessage` replaces the
   * draft, which is how "reword rather than bounce" is expressed — the
   * employee's original stays in `draftMessage` for the audit trail.
   *
   * Approval only re-arms delivery; it never sends inline. `processQueue`
   * remains the single place a channel is touched, which keeps re-running a
   * loop pass idempotent.
   */
  approve(
    agencyId: string,
    escalationId: string,
    input: { actorId?: string | null; editedMessage?: string | null } = {},
  ): Escalation {
    const now = this.now();
    const escalation = this.deps.store.get(agencyId, escalationId);
    if (!escalation) throw new Error("escalation not found");
    if (!escalation.requiresApproval) throw new Error("escalation does not require approval");
    if (escalation.approvalState === "approved") return escalation; // idempotent
    if (escalation.approvalState === "rejected") throw new Error("escalation was already rejected");
    const edited = input.editedMessage?.trim()
      ? sanitizeEscalationText(input.editedMessage, MAX_ESCALATION_ANSWER_CHARS)
      : null;
    const updated =
      this.deps.store.update(
        agencyId,
        escalationId,
        {
          approvalState: "approved",
          approvedAt: now,
          approvedBy: input.actorId ?? null,
          status: "pending",
          deliverAfter: now,
          composedMessage: edited ?? escalation.draftMessage ?? escalation.composedMessage,
          reason: edited ? "approved with edits" : "approved as drafted",
        },
        now,
      ) ?? escalation;
    this.deps.workerStore.recordAudit?.(
      agencyId,
      input.actorId ?? undefined,
      "escalation.approved",
      "escalation",
      escalation.id,
      { approvalState: escalation.approvalState },
      { approvalState: "approved", edited: Boolean(edited) },
    );
    this.broadcast(agencyId, updated);
    return updated;
  }

  /** The human bounces the draft. Nothing is ever sent to the recipient. */
  reject(
    agencyId: string,
    escalationId: string,
    input: { actorId?: string | null; reason?: string | null } = {},
  ): Escalation {
    const now = this.now();
    const escalation = this.deps.store.get(agencyId, escalationId);
    if (!escalation) throw new Error("escalation not found");
    if (!escalation.requiresApproval) throw new Error("escalation does not require approval");
    if (escalation.approvalState === "approved") {
      throw new Error("escalation was already approved");
    }
    const why = input.reason?.trim()
      ? sanitizeEscalationText(input.reason, MAX_ESCALATION_ANSWER_CHARS)
      : null;
    const updated =
      this.deps.store.update(
        agencyId,
        escalationId,
        {
          approvalState: "rejected",
          rejectedAt: now,
          rejectionReason: why,
          status: "rejected",
          resolvedAt: now,
          reason: why ? `rejected: ${why}` : "rejected by the approver",
        },
        now,
      ) ?? escalation;
    // The employee has to learn from the bounce, so the reason lands in job
    // memory exactly like an answer does.
    if (this.deps.operatingStore && why) {
      this.deps.operatingStore.upsertJobMemory(agencyId, {
        workerId: escalation.workerId,
        workItemId: escalation.workItemId,
        namespace: ESCALATION_MEMORY_NAMESPACE,
        key: `rejected:${escalation.correlationCode}`,
        source: "human",
        value: {
          escalationId: escalation.id,
          draft: escalation.draftMessage,
          rejectionReason: why,
          rejectedAt: now,
        },
      });
    }
    this.deps.workerStore.recordAudit?.(
      agencyId,
      input.actorId ?? undefined,
      "escalation.rejected",
      "escalation",
      escalation.id,
      { approvalState: escalation.approvalState },
      { approvalState: "rejected" },
    );
    this.broadcast(agencyId, updated);
    return updated;
  }

  /**
   * Send the outstanding approval requests. Separate from delivery because it
   * goes to a different person on a different route, and because a failed
   * approval request must never advance the draft toward the recipient.
   */
  async requestApprovals(
    agencyId: string,
    options: { now?: number; limit?: number } = {},
  ): Promise<{ requested: number; failed: number }> {
    const now = options.now ?? this.now();
    const pending = this.deps.store.listAwaitingApprovalRequest(agencyId, now, options.limit ?? 25);
    let requested = 0;
    let failed = 0;
    for (const escalation of pending) {
      const worker = this.deps.workerStore.getWorker(agencyId, escalation.workerId);
      if (!worker) continue;
      const profile = resolveCommunicationProfile(worker);
      const text = composeApprovalRequestMessage({
        escalation,
        draft: escalation.draftMessage ?? escalation.composedMessage ?? escalation.title,
        profile,
        channelId: escalation.approvalChannelId,
        workerName: worker.displayName,
      });
      if (!escalation.approvalChannelId || !this.deps.transport) {
        this.deps.store.update(
          agencyId,
          escalation.id,
          {
            lastError: "no approval channel bound",
            reason:
              "awaiting approval, but no approval channel is bound — approve it from the board",
          },
          now,
        );
        failed += 1;
        continue;
      }
      try {
        const sent = await this.deps.transport({
          agencyId,
          escalationIds: [escalation.id],
          workerId: escalation.workerId,
          channelId: escalation.approvalChannelId,
          to: escalation.approvalTarget,
          text,
          urgent: false,
        });
        // Stamped only on success, and the query filters on IS NULL, so the
        // same approval is never requested twice.
        this.deps.store.update(
          agencyId,
          escalation.id,
          { approvalRequestedAt: now, lastError: null, reason: "approval requested" },
          now,
        );
        this.deps.store.recordDelivery(agencyId, {
          escalationId: escalation.id,
          attempt: 0,
          channelId: escalation.approvalChannelId,
          target: escalation.approvalTarget,
          ok: true,
          messageId: sent?.messageId ?? null,
          error: null,
          at: now,
        });
        requested += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.store.update(
          agencyId,
          escalation.id,
          { lastError: message.slice(0, 500), reason: "approval request delivery failed" },
          now,
        );
        this.deps.store.recordDelivery(agencyId, {
          escalationId: escalation.id,
          attempt: 0,
          channelId: escalation.approvalChannelId,
          target: escalation.approvalTarget,
          ok: false,
          messageId: null,
          error: message.slice(0, 500),
          at: now,
        });
        failed += 1;
      }
      this.broadcast(agencyId, this.deps.store.get(agencyId, escalation.id) ?? escalation);
    }
    return { requested, failed };
  }

  // ── Deliver ───────────────────────────────────────────────────────────────

  /**
   * Attempt every escalation that is due. Safe to call on every loop pass:
   * candidates are selected on `delivered_at IS NULL`, so an already-delivered
   * escalation is invisible to this method and can never be sent twice.
   *
   * Outstanding approval requests go out first — a draft the human has not
   * seen yet is the one thing blocking everything downstream of it.
   */
  async processQueue(
    agencyId: string,
    options: { now?: number; limit?: number } = {},
  ): Promise<EscalationQueueResult> {
    const now = options.now ?? this.now();
    const approvals = await this.requestApprovals(agencyId, { now, limit: options.limit });
    const due = this.deps.store.listDeliverable(agencyId, now, options.limit ?? 25);
    const result: EscalationQueueResult = {
      agencyId,
      considered: due.length,
      delivered: 0,
      failed: 0,
      skipped: 0,
      approvalsRequested: approvals.requested,
      escalationIds: [],
    };
    for (const escalation of due) {
      const policy = this.policy(agencyId, escalation.workerId);
      if (escalation.attempts >= policy.maxDeliveryAttempts) {
        result.skipped += 1;
        continue;
      }
      const sent = await this.deliver(
        agencyId,
        [escalation],
        escalation.composedMessage ?? "",
        policy,
        now,
      );
      if (sent.ok) {
        result.delivered += 1;
        result.escalationIds.push(escalation.id);
      } else {
        result.failed += 1;
      }
    }
    return result;
  }

  /**
   * Send the batched proactive insights whose window has closed — one digest
   * per employee, never one message per insight.
   */
  async flushDigests(
    agencyId: string,
    options: { now?: number } = {},
  ): Promise<EscalationDigestResult> {
    const now = options.now ?? this.now();
    const due = this.deps.store.listBatchedDue(agencyId, now);
    const result: EscalationDigestResult = {
      agencyId,
      digestsSent: 0,
      itemsDelivered: 0,
      deferred: 0,
    };
    const byWorker = new Map<string, Escalation[]>();
    for (const entry of due) {
      const bucket = byWorker.get(entry.workerId) ?? [];
      bucket.push(entry);
      byWorker.set(entry.workerId, bucket);
    }

    for (const [workerId, entries] of byWorker) {
      const policy = this.policy(agencyId, workerId);
      const worker = this.deps.workerStore.getWorker(agencyId, workerId);
      if (!worker) continue;
      const nextWindow = nextDigestAt(
        policy.digest.cadence,
        policy.digest.timeOfDay,
        policy.digest.timezone,
        now,
      );
      // Too thin to be worth interrupting a human for — roll into next window.
      if (entries.length < policy.digest.minItems) {
        for (const entry of entries) {
          this.deps.store.update(
            agencyId,
            entry.id,
            {
              digestDueAt: nextWindow,
              deliverAfter: nextWindow,
              reason: "held: digest below minItems",
            },
            now,
          );
        }
        result.deferred += entries.length;
        continue;
      }
      const batch = entries.slice(0, policy.digest.maxItems);
      for (const overflow of entries.slice(policy.digest.maxItems)) {
        this.deps.store.update(
          agencyId,
          overflow.id,
          {
            digestDueAt: nextWindow,
            deliverAfter: nextWindow,
            reason: "rolled into the next digest",
          },
          now,
        );
        result.deferred += 1;
      }
      const profile = resolveCommunicationProfile(worker);
      const route = this.resolveRoute(agencyId, workerId, "proactive_insight", policy, {
        channelId: batch[0]?.channelId ?? null,
        target: batch[0]?.target ?? null,
        bindingId: batch[0]?.bindingId ?? null,
      });
      const text = composeDigestMessage({
        escalations: batch,
        profile,
        channelId: route.channelId,
        workerName: worker.displayName,
        windowLabel: policy.digest.cadence === "weekly" ? "this week" : "today",
      });
      const digestId = randomUUID();
      const sent = await this.deliver(agencyId, batch, text, policy, now, digestId);
      if (sent.ok) {
        result.digestsSent += 1;
        result.itemsDelivered += batch.length;
      }
    }
    return result;
  }

  /**
   * One transport attempt for one message covering `escalations` (a single
   * escalation, or a whole digest). Records the attempt either way; a failure
   * leaves the row intact, retriable, and visible.
   */
  private async deliver(
    agencyId: string,
    escalations: Escalation[],
    text: string,
    policy: AgencyEscalationPolicy,
    now: number,
    digestId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const head = escalations[0]!;
    const attempt = head.attempts + 1;
    const urgent = URGENCY_RANK[head.urgency] >= URGENCY_RANK[policy.urgencyBypass];

    const fail = (error: string) => {
      for (const entry of escalations) {
        const attempts = entry.attempts + 1;
        const exhausted = attempts >= policy.maxDeliveryAttempts;
        const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!;
        this.deps.store.update(
          agencyId,
          entry.id,
          {
            status: "failed",
            attempts,
            lastAttemptAt: now,
            lastError: error.slice(0, 500),
            deliverAfter: now + backoff * 1_000,
            reason: exhausted
              ? `delivery gave up after ${attempts} attempts — still readable here`
              : `delivery failed; retrying in ${backoff}s`,
          },
          now,
        );
        this.deps.store.recordDelivery(agencyId, {
          escalationId: entry.id,
          attempt,
          channelId: entry.channelId,
          target: entry.target,
          ok: false,
          messageId: null,
          error: error.slice(0, 500),
          at: now,
        });
        this.broadcast(agencyId, this.deps.store.get(agencyId, entry.id) ?? entry);
      }
      this.log.warn(`escalation ${head.correlationCode}: delivery failed — ${error}`);
      return { ok: false, error };
    };

    if (!head.channelId) {
      return fail("no outbound channel bound for this employee");
    }
    if (!this.deps.transport) {
      return fail("no escalation transport configured on this gateway");
    }
    if (!text.trim()) {
      return fail("composed message was empty");
    }

    let messageId: string | null = null;
    try {
      const sent = await this.deps.transport({
        agencyId,
        escalationIds: escalations.map((entry) => entry.id),
        workerId: head.workerId,
        channelId: head.channelId,
        to: head.target,
        text,
        urgent,
      });
      messageId = sent?.messageId ?? null;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    for (const entry of escalations) {
      this.deps.store.update(
        agencyId,
        entry.id,
        {
          status: "delivered",
          deliveredAt: now,
          attempts: entry.attempts + 1,
          lastAttemptAt: now,
          lastError: null,
          composedMessage: escalations.length > 1 ? text : (entry.composedMessage ?? text),
          digestId: digestId ?? entry.digestId,
          reason: digestId ? "delivered in a digest" : "delivered",
        },
        now,
      );
      this.deps.store.recordDelivery(agencyId, {
        escalationId: entry.id,
        attempt: entry.attempts + 1,
        channelId: entry.channelId,
        target: entry.target,
        ok: true,
        messageId,
        error: null,
        at: now,
      });
      this.parkWorkItem(agencyId, entry, now);
      this.broadcast(agencyId, this.deps.store.get(agencyId, entry.id) ?? entry);
    }
    return { ok: true };
  }

  /**
   * A delivered ask parks its work item in `waiting` so the executor stops
   * burning tokens on something it cannot finish. Illegal transitions are
   * ignored rather than thrown: a work item that already moved on is not an
   * error, and must not fail the delivery that already happened.
   */
  private parkWorkItem(agencyId: string, escalation: Escalation, now: number): void {
    if (!this.deps.operatingStore || !escalation.workItemId) return;
    if (escalation.kind === "proactive_insight") return;
    try {
      const item = this.deps.operatingStore.getWorkItem(agencyId, escalation.workItemId);
      if (!item || item.status === "waiting") return;
      this.deps.operatingStore.transitionWorkItem(agencyId, escalation.workItemId, "waiting", {
        waitingReason: `${escalation.kind}: awaiting human reply (${escalation.correlationCode})`,
        now,
      });
    } catch {
      /* the item moved on; the escalation still stands on its own */
    }
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  /**
   * The human's reply. Resolves the escalation, feeds the answer into job
   * memory (the carrier the executor already reads when composing a prompt),
   * and lifts the work item out of `waiting`.
   */
  answer(
    agencyId: string,
    escalationId: string,
    input: { answer: string; actorId?: string | null; resume?: boolean; note?: string | null },
  ): EscalationAnswerResult {
    const now = this.now();
    const escalation = this.deps.store.get(agencyId, escalationId);
    if (!escalation) throw new Error("escalation not found");
    if (escalation.status === "cancelled") throw new Error("escalation was cancelled");
    const policy = this.policy(agencyId, escalation.workerId);
    // The human's own words are stored, but a pasted credential must not be
    // written into a replicated database any more than an outbound one.
    const answer = sanitizeEscalationText(input.answer ?? "", MAX_ESCALATION_ANSWER_CHARS);
    if (!answer) throw new Error("answer is required");

    const memoryKey = `answer:${escalation.correlationCode}`;
    if (this.deps.operatingStore) {
      // Keyed on the correlation code, so answering twice upserts one row
      // rather than growing the memory table.
      this.deps.operatingStore.upsertJobMemory(agencyId, {
        workerId: escalation.workerId,
        workItemId: escalation.workItemId,
        namespace: ESCALATION_MEMORY_NAMESPACE,
        key: memoryKey,
        source: "human",
        value: {
          escalationId: escalation.id,
          correlationCode: escalation.correlationCode,
          kind: escalation.kind,
          question: escalation.question ?? escalation.title,
          options: escalation.options,
          answer,
          answeredAt: now,
          answeredBy: input.actorId ?? null,
        },
      });
    }

    const updated =
      this.deps.store.update(
        agencyId,
        escalationId,
        {
          status: "resolved",
          answer,
          answeredAt: now,
          answeredBy: input.actorId ?? null,
          resolvedAt: now,
          resolutionNote: input.note ?? null,
          reason: "answered by the human",
        },
        now,
      ) ?? escalation;

    let workItem: EmployeeWorkItem | null = null;
    let resumed = false;
    const shouldResume = input.resume ?? policy.autoResumeWorkItem;
    if (this.deps.operatingStore && escalation.workItemId) {
      workItem = this.deps.operatingStore.getWorkItem(agencyId, escalation.workItemId);
      if (shouldResume && workItem?.status === "waiting") {
        try {
          workItem = this.deps.operatingStore.transitionWorkItem(
            agencyId,
            escalation.workItemId,
            "in_progress",
            { waitingReason: null, now },
          );
          resumed = true;
        } catch {
          /* a cancelled or completed item cannot be resumed; the answer stands */
        }
      }
    }

    this.deps.workerStore.recordAudit?.(
      agencyId,
      input.actorId ?? undefined,
      "escalation.answered",
      "escalation",
      escalation.id,
      { status: escalation.status },
      { status: "resolved", resumed },
    );
    this.broadcast(agencyId, updated);
    return { escalation: updated, workItem, resumed, memoryKey };
  }

  /**
   * Correlate a raw inbound message with an open escalation.
   *
   * Two strategies, most reliable first:
   *   1. the `[#ESC-XXXXXX]` tag the outbound message carried — works on every
   *      channel, because it lives in the message body rather than in provider
   *      threading metadata;
   *   2. failing that, the most recent delivered-but-unanswered escalation on
   *      the same channel and target.
   *
   * Strategy 2 is only used when a channel+target is supplied, and is
   * deliberately conservative: it never guesses across workers or agencies.
   */
  ingestReply(input: {
    agencyId?: string | null;
    channelId?: string | null;
    target?: string | null;
    workerId?: string | null;
    text: string;
    actorId?: string | null;
  }): EscalationInboundResult {
    const code = parseEscalationReference(input.text);
    let escalation: Escalation | null = null;
    let via: "tag" | "channel" = "tag";
    if (code) {
      escalation = input.agencyId
        ? this.deps.store.getByCode(input.agencyId, code)
        : this.deps.store.findByCodeAnyAgency(code);
    }
    if (!escalation && input.agencyId && (input.channelId || input.target)) {
      escalation = this.deps.store.findLatestAwaitingReply(input.agencyId, {
        channelId: input.channelId ?? null,
        target: input.target ?? null,
        workerId: input.workerId ?? null,
      });
      via = "channel";
    }
    if (!escalation) return { matched: false };

    // A draft awaiting sign-off is answered with a verdict, not with prose.
    if (escalation.requiresApproval && escalation.approvalState === "pending") {
      const directive = parseApprovalDirective(input.text);
      if (!directive) {
        return { matched: false, reason: "awaiting approve/reject/edit, not a plain reply" };
      }
      if (directive.verb === "reject") {
        return {
          matched: true,
          via,
          action: "rejected",
          escalation: this.reject(escalation.agencyId, escalation.id, {
            actorId: input.actorId ?? null,
            reason: directive.body || null,
          }),
        };
      }
      return {
        matched: true,
        via,
        action: directive.verb === "edit" ? "edited" : "approved",
        escalation: this.approve(escalation.agencyId, escalation.id, {
          actorId: input.actorId ?? null,
          editedMessage: directive.verb === "edit" ? directive.body : null,
        }),
      };
    }

    // The tag itself is addressing, not content — strip it from the answer.
    const answer = input.text.replace(/\[?#\s*ESC-[A-Z0-9]{6}\]?/gi, "").trim();
    if (!answer) return { matched: false, reason: "reply carried a tag but no content" };
    return {
      matched: true,
      via,
      action: "answered",
      ...this.answer(escalation.agencyId, escalation.id, {
        answer,
        actorId: input.actorId ?? null,
      }),
    };
  }

  // ── Operator actions ──────────────────────────────────────────────────────

  resolve(
    agencyId: string,
    escalationId: string,
    input: { note?: string | null; actorId?: string | null } = {},
  ): Escalation {
    const now = this.now();
    const escalation = this.deps.store.get(agencyId, escalationId);
    if (!escalation) throw new Error("escalation not found");
    const updated =
      this.deps.store.update(
        agencyId,
        escalationId,
        {
          status: "resolved",
          resolvedAt: now,
          resolutionNote: input.note ?? null,
          reason: "resolved without an answer",
        },
        now,
      ) ?? escalation;
    this.broadcast(agencyId, updated);
    return updated;
  }

  cancel(
    agencyId: string,
    escalationId: string,
    input: { reason?: string | null; actorId?: string | null } = {},
  ): Escalation {
    const now = this.now();
    const escalation = this.deps.store.get(agencyId, escalationId);
    if (!escalation) throw new Error("escalation not found");
    if (escalation.deliveredAt) {
      // Cancelling something the human has already read would silently drop it
      // off their board with no explanation; resolve it instead.
      throw new Error("escalation was already delivered; resolve it instead of cancelling");
    }
    const updated =
      this.deps.store.update(
        agencyId,
        escalationId,
        {
          status: "cancelled",
          resolvedAt: now,
          reason: input.reason?.slice(0, 300) ?? "cancelled",
        },
        now,
      ) ?? escalation;
    this.broadcast(agencyId, updated);
    return updated;
  }

  /** Re-arm a failed or suppressed escalation for immediate delivery. */
  retry(
    agencyId: string,
    escalationId: string,
    options: { resetAttempts?: boolean } = {},
  ): Escalation {
    const now = this.now();
    const escalation = this.deps.store.get(agencyId, escalationId);
    if (!escalation) throw new Error("escalation not found");
    if (escalation.deliveredAt) throw new Error("escalation was already delivered");
    if (escalation.status === "resolved" || escalation.status === "cancelled") {
      throw new Error(`a ${escalation.status} escalation cannot be retried`);
    }
    const updated =
      this.deps.store.update(
        agencyId,
        escalationId,
        {
          status: "pending",
          deliverAfter: now,
          reason: "retry requested",
          ...(options.resetAttempts ? { attempts: 0, lastError: null } : {}),
        },
        now,
      ) ?? escalation;
    this.broadcast(agencyId, updated);
    return updated;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Where this kind speaks. Policy pins a channel per kind; otherwise the
   * worker's first enabled outbound binding wins. Routing only — no credential
   * ever passes through here.
   */
  private resolveRoute(
    agencyId: string,
    workerId: string,
    kind: EscalationKind,
    policy: AgencyEscalationPolicy,
    explicit: { channelId: ChatChannelId | null; target: string | null; bindingId: string | null },
  ): { channelId: ChatChannelId | null; target: string | null; bindingId: string | null } {
    if (explicit.channelId && explicit.target) return explicit;
    const bindings = (
      this.deps.workerStore.listChannelBindings?.(agencyId, { workerId, enabled: true }) ?? []
    ).filter((binding) => binding.direction === "outbound" || binding.direction === "both");
    const preferred = explicit.channelId ?? policy.channelByKind[kind];
    const match =
      (preferred ? bindings.find((binding) => binding.channelId === preferred) : undefined) ??
      bindings[0];
    if (!match)
      return {
        channelId: preferred ?? explicit.channelId,
        target: explicit.target,
        bindingId: null,
      };
    return {
      channelId: match.channelId,
      target: explicit.target ?? match.target,
      bindingId: match.id,
    };
  }

  /**
   * Where the APPROVAL request goes. Falls back through: an explicit approver
   * route on the escalation → the agency approval policy → the worker's own
   * operator-facing binding. Never the recipient's route: approving a client
   * message by messaging the client would defeat the whole control.
   */
  private resolveApprovalRoute(
    agencyId: string,
    normalized: ReturnType<typeof normalizeEscalationInput>,
    policy: AgencyEscalationPolicy,
    recipientRoute: { channelId: ChatChannelId | null; target: string | null },
  ): { channelId: ChatChannelId | null; target: string | null } {
    if (normalized.approvalChannelId) {
      return { channelId: normalized.approvalChannelId, target: normalized.approvalTarget };
    }
    if (policy.approval.channelId || policy.approval.target) {
      return { channelId: policy.approval.channelId, target: policy.approval.target };
    }
    const bindings = (
      this.deps.workerStore.listChannelBindings?.(agencyId, {
        workerId: normalized.workerId,
        enabled: true,
      }) ?? []
    ).filter(
      (binding) =>
        (binding.direction === "outbound" || binding.direction === "both") &&
        // Anything but the recipient we are asking permission to message.
        !(
          binding.channelId === recipientRoute.channelId && binding.target === recipientRoute.target
        ),
    );
    const match = bindings[0];
    return match
      ? { channelId: match.channelId, target: match.target }
      : { channelId: null, target: null };
  }

  private compose(
    normalized: ReturnType<typeof normalizeEscalationInput>,
    profile: CommunicationProfile,
    channelId: ChatChannelId | null,
    worker: Worker,
    correlationCode: string,
  ): string {
    const manager = worker.managerWorkerId
      ? (this.deps.workerStore.getWorker(worker.agencyId, worker.managerWorkerId)?.displayName ??
        null)
      : null;
    return composeEscalationMessage({
      escalation: { ...normalized, correlationCode, occurrences: 1 },
      profile,
      channelId,
      managerName: manager,
      workerName: worker.displayName,
    });
  }

  /**
   * Hard caps, applied by construction rather than by hoping the caller
   * behaves. Returns the operator-facing reason when the cap is hit.
   */
  private rateLimitReason(
    agencyId: string,
    workerId: string,
    policy: AgencyEscalationPolicy,
    now: number,
    urgent: boolean,
  ): string | null {
    const hourAgo = now - 3_600_000;
    const perWorker = this.deps.store.countDeliveredSince(agencyId, hourAgo, workerId);
    if (perWorker >= policy.rateLimit.maxPerWorkerPerHour) {
      return `rate limit: ${perWorker} messages from this employee in the last hour (cap ${policy.rateLimit.maxPerWorkerPerHour})`;
    }
    const perAgency = this.deps.store.countDeliveredSince(agencyId, hourAgo);
    if (perAgency >= policy.rateLimit.maxPerAgencyPerHour) {
      return `rate limit: ${perAgency} agency messages in the last hour (cap ${policy.rateLimit.maxPerAgencyPerHour})`;
    }
    if (urgent) return null;
    const last = this.deps.store.lastDeliveredAt(agencyId, workerId);
    if (last !== null && now - last < policy.rateLimit.minSecondsBetween * 1_000) {
      const wait = Math.ceil((policy.rateLimit.minSecondsBetween * 1_000 - (now - last)) / 1_000);
      return `rate limit: this employee messaged ${Math.round((now - last) / 1_000)}s ago; ${wait}s to go`;
    }
    return null;
  }

  private suppress(
    agencyId: string,
    normalized: ReturnType<typeof normalizeEscalationInput>,
    now: number,
    decision: EscalationRaiseResult["decision"],
    reason: string,
    profile: CommunicationProfile,
    route?: { channelId: ChatChannelId | null; target: string | null; bindingId: string | null },
  ): EscalationRaiseResult {
    // Suppression is not deletion. The row is written so the operator can see
    // what their employee wanted to say and why it never went out — and can
    // `retry` it, which is why it still gets a real correlation code.
    const correlationCode = this.deps.store.nextCorrelationCode(agencyId);
    const escalation = this.deps.store.create(agencyId, {
      ...normalized,
      correlationCode,
      channelId: route?.channelId ?? normalized.channelId,
      target: route?.target ?? normalized.target,
      bindingId: route?.bindingId ?? normalized.bindingId,
      requiresApproval: false,
      approvalState: "not_required",
      status: "suppressed",
      deliverAfter: now,
      reason,
      composedMessage: composeEscalationMessage({
        escalation: { ...normalized, correlationCode, occurrences: 1 },
        profile,
        channelId: route?.channelId ?? normalized.channelId,
      }),
      now,
    });
    this.broadcast(agencyId, escalation);
    return { escalation, created: true, deduped: false, decision, reason };
  }

  private broadcast(agencyId: string, escalation: Escalation): void {
    this.deps.broadcast?.(ESCALATION_EVENT, {
      agencyId,
      escalationId: escalation.id,
      workerId: escalation.workerId,
      workItemId: escalation.workItemId,
      kind: escalation.kind,
      status: escalation.status,
      urgency: escalation.urgency,
      updatedAt: escalation.updatedAt,
    });
  }
}
