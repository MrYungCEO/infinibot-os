/**
 * The escalation protocol — how an autonomous AI employee reaches the human.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * `wf_employee_work_items` already had an `escalated` state, but escalating
 * only wrote a row. Nobody watches a row. Exception-based oversight only works
 * if the exception actually arrives on a channel the human reads, sounds like
 * the employee who raised it, and can be *answered* in a way that unblocks the
 * work.
 *
 * ── The four kinds ──────────────────────────────────────────────────────────
 * These are deliberately distinct types rather than a severity scale, because
 * they demand different things from the human:
 *
 *   needs_context     — the employee cannot proceed without information only
 *                       the human has. Carries a `question`; the answer is fed
 *                       back into the next prompt via job memory.
 *   major_decision    — a choice above the worker's autonomy/approval
 *                       threshold. Carries `options`; the answer selects one.
 *   blocked           — a dependency, a repeated failure, or an SLA breach.
 *                       Usually urgent; may bypass quiet hours.
 *   proactive_insight — unprompted, valuable observation. NEVER urgent, always
 *                       rate-limited, and by default batched into a digest.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * An escalation carries a *summary and a reference*, never a payload. Secrets
 * are redacted on the way in (`redactSecrets`), summaries are hard-capped, and
 * the `context` bag is rejected if it looks like it carries credentials — the
 * same rule `channel-bindings.ts` applies, for the same reason: agency.db is
 * replicated and backed up.
 */

import { assertNoCredentials } from "./channel-bindings.js";
import { normalizeChatChannelId, type ChatChannelId } from "../channels/registry.js";

export const ESCALATION_PROTOCOL_VERSION = 1 as const;

export const ESCALATION_KINDS = [
  "needs_context",
  "major_decision",
  "blocked",
  "proactive_insight",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export const ESCALATION_URGENCIES = ["low", "normal", "high", "critical"] as const;
export type EscalationUrgency = (typeof ESCALATION_URGENCIES)[number];

export const URGENCY_RANK: Record<EscalationUrgency, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

/**
 * `awaiting_approval` — drafted, and a human must approve it before it is sent
 *               to its recipient. The approval request itself goes to the
 *               *approver*, who is not the recipient.
 * `rejected`  — the approver bounced the draft. Never sent.
 * `pending`   — persisted and cleared to send, not yet attempted.
 * `scheduled` — held until `deliverAfter` (working hours / human pacing).
 * `batched`   — a proactive insight waiting for its digest window to close.
 * `suppressed`— deliberately not sent (rate limit, dedupe, proactivity gate).
 *               Still readable in the UI: suppression is not deletion.
 * `delivered` — a channel accepted it.
 * `failed`    — every attempt failed. Retriable; never lost.
 * `answered`  — the human replied; `answer` holds their words.
 * `resolved`  — closed out (with or without an answer).
 * `cancelled` — withdrawn by the employee or an operator.
 */
export const ESCALATION_STATUSES = [
  "awaiting_approval",
  "rejected",
  "pending",
  "scheduled",
  "batched",
  "suppressed",
  "delivered",
  "failed",
  "answered",
  "resolved",
  "cancelled",
] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

/** Statuses that still count against the rate limit and block a duplicate. */
export const OPEN_ESCALATION_STATUSES: readonly EscalationStatus[] = [
  "awaiting_approval",
  "pending",
  "scheduled",
  "batched",
  "delivered",
  "failed",
  "answered",
];

/**
 * Who the message is *for*. Deliberately separate from who approves it: today
 * both collapse onto the owner, but a project-manager employee talking to a
 * real client has a client recipient and an owner approver, and nothing about
 * that message may reach the client unreviewed.
 */
export const ESCALATION_RECIPIENTS = ["operator", "client", "teammate"] as const;
export type EscalationRecipientKind = (typeof ESCALATION_RECIPIENTS)[number];

export const APPROVAL_STATES = ["not_required", "pending", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** Statuses the delivery queue will attempt. Never includes `delivered`. */
export const DELIVERABLE_ESCALATION_STATUSES: readonly EscalationStatus[] = [
  "pending",
  "scheduled",
  "failed",
];

export const DIGEST_CADENCES = ["hourly", "daily", "weekly"] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

/** Job-memory namespace the human's answers land in. */
export const ESCALATION_MEMORY_NAMESPACE = "escalation";

/** Broadcast event name; the UI treats it as invalidate-and-refetch. */
export const ESCALATION_EVENT = "agency.escalation.updated";

/** Hard cap on anything an escalation puts on a channel. */
export const MAX_ESCALATION_SUMMARY_CHARS = 900;
export const MAX_ESCALATION_TITLE_CHARS = 160;
export const MAX_ESCALATION_ANSWER_CHARS = 4_000;

export interface Escalation {
  id: string;
  agencyId: string;
  workerId: string;
  /** The work item this blocks. Null for a standalone proactive insight. */
  workItemId: string | null;
  kind: EscalationKind;
  urgency: EscalationUrgency;
  status: EscalationStatus;
  /** One line. What the human sees first. */
  title: string;
  /** A few sentences. Redacted and capped — never a payload dump. */
  summary: string;
  /** The explicit ask, for `needs_context` / `major_decision`. */
  question: string | null;
  /** Choices for a `major_decision`. */
  options: string[];
  /**
   * A pointer, not a payload: a work item id, a URL, a file path. The human
   * follows it; the channel never carries the contents.
   */
  reference: string | null;
  /** Who this message is FOR. `operator` is the exception-oversight case. */
  recipientKind: EscalationRecipientKind;
  /** Human label for the recipient, shown to the approver ("Acme Corp"). */
  recipientLabel: string | null;
  /** Recipient route. */
  channelId: ChatChannelId | null;
  target: string | null;
  bindingId: string | null;
  /**
   * Draft → approve → deliver. When true nothing reaches `target` until a
   * human approves; the approver may edit the wording first.
   */
  requiresApproval: boolean;
  approvalState: ApprovalState;
  /** Where the approval request goes — the APPROVER, not the recipient. */
  approvalChannelId: ChatChannelId | null;
  approvalTarget: string | null;
  approvalRequestedAt: number | null;
  approvedAt: number | null;
  approvedBy: string | null;
  rejectedAt: number | null;
  rejectionReason: string | null;
  /**
   * The employee's proposed wording, preserved verbatim even after the
   * approver edits it — so an operator can always see what their employee
   * wanted to say versus what actually went out.
   */
  draftMessage: string | null;
  /**
   * Short, human-typeable handle the reply is matched on, e.g. `ESC-7K2QF4`.
   * Unique per agency.
   */
  correlationCode: string;
  /**
   * Collapse key. A second escalation with the same key while the first is
   * still open increments `occurrences` instead of creating a row — this is
   * what stops an employee in a failure loop emitting 200 messages.
   */
  dedupeKey: string;
  occurrences: number;
  /** Set when the escalation is batched into a digest. */
  digestId: string | null;
  /** When a batched insight's digest window closes. */
  digestDueAt: number | null;
  /** Earliest send time — the schedule-aware `ResponsePlan.respondAt`. */
  deliverAfter: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  /** The exact text composed for the channel. Stored so the UI can show it
   *  even when every channel is down. */
  composedMessage: string | null;
  /** Why an escalation was suppressed, deferred or failed. Operator-facing. */
  reason: string;
  answer: string | null;
  answeredAt: number | null;
  answeredBy: string | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
  /** Non-secret metadata (source, run id, metric values). */
  context: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type EscalationInput = {
  id?: string;
  workerId: string;
  workItemId?: string | null;
  kind: EscalationKind;
  urgency?: EscalationUrgency;
  title: string;
  summary?: string;
  question?: string | null;
  options?: string[];
  reference?: string | null;
  recipientKind?: string | null;
  recipientLabel?: string | null;
  channelId?: string | null;
  target?: string | null;
  bindingId?: string | null;
  /**
   * Force the approval gate on or off. Omit to let policy decide
   * (`policy.approval.requireForRecipients`).
   */
  requiresApproval?: boolean;
  approvalChannelId?: string | null;
  approvalTarget?: string | null;
  /** Pre-composed body. Supplied when the employee drafted its own wording. */
  draftMessage?: string | null;
  dedupeKey?: string | null;
  context?: Record<string, unknown>;
};

// ── Policy ──────────────────────────────────────────────────────────────────

export type QuietHoursPolicy = {
  enabled: boolean;
  /** HH:MM local. `start > end` spans midnight, as an operator reads it. */
  start: string;
  end: string;
  timezone: string;
};

export type EscalationRateLimitPolicy = {
  maxPerWorkerPerHour: number;
  maxPerAgencyPerHour: number;
  /** Floor between two deliveries from the same worker. */
  minSecondsBetween: number;
};

export type EscalationDigestPolicy = {
  enabled: boolean;
  cadence: DigestCadence;
  /** HH:MM local, for daily/weekly. */
  timeOfDay: string;
  timezone: string;
  /** Do not send a digest with fewer than this many insights. */
  minItems: number;
  /** Trim the digest to the highest-value N. */
  maxItems: number;
};

export type EscalationApprovalPolicy = {
  /**
   * Recipient kinds that may never be messaged without a human approving the
   * exact wording first. `client` is in this list by default and removing it
   * is an explicit, audited operator decision.
   */
  requireForRecipients: EscalationRecipientKind[];
  /** Where approval requests go. Null = the worker's own outbound binding. */
  channelId: ChatChannelId | null;
  target: string | null;
  /** Approval requests are an interruption too; they still respect quiet hours. */
  bypassQuietHours: boolean;
};

export interface AgencyEscalationPolicy {
  version: typeof ESCALATION_PROTOCOL_VERSION;
  enabled: boolean;
  /**
   * Which channel each kind goes to. `null` = whatever outbound binding the
   * worker has. A kind can be muted with `channelByKind[kind] = "off"` via
   * `mutedKinds`.
   */
  channelByKind: Record<EscalationKind, ChatChannelId | null>;
  mutedKinds: EscalationKind[];
  quietHours: QuietHoursPolicy;
  /** At or above this urgency, quiet hours and working hours are bypassed. */
  urgencyBypass: EscalationUrgency;
  rateLimit: EscalationRateLimitPolicy;
  /** How long a resolved escalation still collapses a repeat. */
  dedupeWindowMinutes: number;
  digest: EscalationDigestPolicy;
  approval: EscalationApprovalPolicy;
  /** Answering an escalation moves its work item out of `waiting`. */
  autoResumeWorkItem: boolean;
  maxDeliveryAttempts: number;
  updatedAt: number;
}

const oneOf = <T extends string>(values: readonly T[], raw: unknown, fallback: T): T =>
  typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;

const int = (raw: unknown, fallback: number, min: number, max: number): number => {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
  return Math.min(max, Math.max(min, value));
};

const bool = (raw: unknown, fallback: boolean): boolean =>
  typeof raw === "boolean" ? raw : fallback;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeOfDay = (raw: unknown, fallback: string): string =>
  typeof raw === "string" && HHMM.test(raw.trim()) ? raw.trim() : fallback;

export function defaultEscalationPolicy(now = Date.now()): AgencyEscalationPolicy {
  return {
    version: ESCALATION_PROTOCOL_VERSION,
    enabled: true,
    channelByKind: {
      needs_context: null,
      major_decision: null,
      blocked: null,
      proactive_insight: null,
    },
    mutedKinds: [],
    quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" },
    // A blocker at 03:00 still pages. An idea at 03:00 does not.
    urgencyBypass: "high",
    rateLimit: {
      maxPerWorkerPerHour: 4,
      maxPerAgencyPerHour: 12,
      minSecondsBetween: 120,
    },
    dedupeWindowMinutes: 720,
    digest: {
      enabled: true,
      cadence: "daily",
      timeOfDay: "17:00",
      timezone: "UTC",
      minItems: 1,
      maxItems: 8,
    },
    approval: {
      // Nothing reaches a client unreviewed. This is the owner's standing
      // instruction, encoded as a default rather than left to each caller.
      requireForRecipients: ["client"],
      channelId: null,
      target: null,
      bypassQuietHours: false,
    },
    autoResumeWorkItem: true,
    maxDeliveryAttempts: 4,
    updatedAt: now,
  };
}

/** Coerce arbitrary (RPC) input into a complete policy. Never throws. */
export function normalizeEscalationPolicy(
  raw: unknown,
  base: AgencyEscalationPolicy = defaultEscalationPolicy(),
  now = Date.now(),
): AgencyEscalationPolicy {
  const value = (raw ?? {}) as Record<string, unknown>;
  const quiet = (value.quietHours ?? {}) as Record<string, unknown>;
  const rate = (value.rateLimit ?? {}) as Record<string, unknown>;
  const digest = (value.digest ?? {}) as Record<string, unknown>;
  const approval = (value.approval ?? {}) as Record<string, unknown>;
  const byKind = (value.channelByKind ?? {}) as Record<string, unknown>;

  const channelByKind = { ...base.channelByKind };
  for (const kind of ESCALATION_KINDS) {
    if (byKind[kind] === undefined) continue;
    channelByKind[kind] =
      byKind[kind] === null ? null : normalizeChatChannelId(String(byKind[kind]));
  }

  const mutedKinds = Array.isArray(value.mutedKinds)
    ? ESCALATION_KINDS.filter((kind) => (value.mutedKinds as unknown[]).includes(kind))
    : base.mutedKinds;

  return {
    version: ESCALATION_PROTOCOL_VERSION,
    enabled: bool(value.enabled, base.enabled),
    channelByKind,
    mutedKinds: [...mutedKinds],
    quietHours: {
      enabled: bool(quiet.enabled, base.quietHours.enabled),
      start: timeOfDay(quiet.start, base.quietHours.start),
      end: timeOfDay(quiet.end, base.quietHours.end),
      timezone:
        (typeof quiet.timezone === "string" ? quiet.timezone.trim().slice(0, 64) : "") ||
        base.quietHours.timezone,
    },
    urgencyBypass: oneOf(ESCALATION_URGENCIES, value.urgencyBypass, base.urgencyBypass),
    rateLimit: {
      maxPerWorkerPerHour: int(
        rate.maxPerWorkerPerHour,
        base.rateLimit.maxPerWorkerPerHour,
        0,
        240,
      ),
      maxPerAgencyPerHour: int(
        rate.maxPerAgencyPerHour,
        base.rateLimit.maxPerAgencyPerHour,
        0,
        1_000,
      ),
      minSecondsBetween: int(rate.minSecondsBetween, base.rateLimit.minSecondsBetween, 0, 86_400),
    },
    dedupeWindowMinutes: int(value.dedupeWindowMinutes, base.dedupeWindowMinutes, 0, 43_200),
    digest: {
      enabled: bool(digest.enabled, base.digest.enabled),
      cadence: oneOf(DIGEST_CADENCES, digest.cadence, base.digest.cadence),
      timeOfDay: timeOfDay(digest.timeOfDay, base.digest.timeOfDay),
      timezone:
        (typeof digest.timezone === "string" ? digest.timezone.trim().slice(0, 64) : "") ||
        base.digest.timezone,
      minItems: int(digest.minItems, base.digest.minItems, 1, 100),
      maxItems: Math.max(
        int(digest.minItems, base.digest.minItems, 1, 100),
        int(digest.maxItems, base.digest.maxItems, 1, 100),
      ),
    },
    approval: {
      requireForRecipients: Array.isArray(approval.requireForRecipients)
        ? ESCALATION_RECIPIENTS.filter((kind) =>
            (approval.requireForRecipients as unknown[]).includes(kind),
          )
        : [...base.approval.requireForRecipients],
      channelId:
        approval.channelId === undefined
          ? base.approval.channelId
          : approval.channelId === null
            ? null
            : normalizeChatChannelId(String(approval.channelId)),
      target:
        approval.target === undefined
          ? base.approval.target
          : typeof approval.target === "string" && approval.target.trim()
            ? approval.target.trim().slice(0, 400)
            : null,
      bypassQuietHours: bool(approval.bypassQuietHours, base.approval.bypassQuietHours),
    },
    autoResumeWorkItem: bool(value.autoResumeWorkItem, base.autoResumeWorkItem),
    maxDeliveryAttempts: int(value.maxDeliveryAttempts, base.maxDeliveryAttempts, 1, 20),
    updatedAt: now,
  };
}

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * Patterns that must never leave the process on a chat channel. Deliberately
 * broad — a false positive costs an operator a `[redacted]` in a summary, a
 * false negative posts a live API key into a Slack channel.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // key: value / key=value forms
  [
    /\b(api[_-]?key|apikey|secret|token|password|passwd|passphrase|private[_-]?key|access[_-]?key|client[_-]?secret|bearer|authorization|session[_-]?id|cookie|signing[_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
    "$1: [redacted]",
  ],
  // Bare high-entropy provider tokens.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]"],
  [/\b\d{6,10}:AA[A-Za-z0-9_-]{30,}\b/g, "[redacted]"], // telegram bot token
  // PEM blocks and JWTs.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]"],
  // Basic-auth in a URL.
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@"],
];

/**
 * Strip anything credential-shaped and collapse code fences: an escalation
 * carries a summary and a reference, never file contents.
 */
export function redactSecrets(raw: string): string {
  let text = raw ?? "";
  // A fenced block is a payload dump by definition. Replace it with a marker
  // rather than trying to sanitise its contents line by line.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, "[code omitted — see the reference]");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/** Redact, collapse whitespace and hard-cap. Used on every channel-bound field. */
export function sanitizeEscalationText(raw: string, maxChars: number): string {
  const redacted = redactSecrets(String(raw ?? ""))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1).trimEnd()}…` : redacted;
}

// ── Input normalisation ─────────────────────────────────────────────────────

export function parseEscalationKind(raw: unknown): EscalationKind {
  if (typeof raw === "string" && (ESCALATION_KINDS as readonly string[]).includes(raw)) {
    return raw as EscalationKind;
  }
  throw new Error(`kind must be one of ${ESCALATION_KINDS.join(", ")}`);
}

export function parseEscalationUrgency(raw: unknown): EscalationUrgency {
  if (raw === undefined || raw === null || raw === "") return "normal";
  if (typeof raw === "string" && (ESCALATION_URGENCIES as readonly string[]).includes(raw)) {
    return raw as EscalationUrgency;
  }
  throw new Error(`urgency must be one of ${ESCALATION_URGENCIES.join(", ")}`);
}

export function parseEscalationStatus(raw: unknown): EscalationStatus {
  if (typeof raw === "string" && (ESCALATION_STATUSES as readonly string[]).includes(raw)) {
    return raw as EscalationStatus;
  }
  throw new Error(`status must be one of ${ESCALATION_STATUSES.join(", ")}`);
}

/**
 * The default collapse key: same worker, same kind, same work item, same
 * subject. Two identical failures in a loop therefore collapse into one row
 * with `occurrences: 2` rather than two messages.
 */
export function defaultDedupeKey(input: {
  kind: EscalationKind;
  workItemId?: string | null;
  title: string;
}): string {
  const subject = input.title
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${input.kind}:${input.workItemId ?? "-"}:${subject}`;
}

export function parseRecipientKind(raw: unknown): EscalationRecipientKind {
  if (raw === undefined || raw === null || raw === "") return "operator";
  if (typeof raw === "string" && (ESCALATION_RECIPIENTS as readonly string[]).includes(raw)) {
    return raw as EscalationRecipientKind;
  }
  throw new Error(`recipientKind must be one of ${ESCALATION_RECIPIENTS.join(", ")}`);
}

export type NormalizedEscalationInput = {
  workerId: string;
  workItemId: string | null;
  kind: EscalationKind;
  urgency: EscalationUrgency;
  title: string;
  summary: string;
  question: string | null;
  options: string[];
  reference: string | null;
  recipientKind: EscalationRecipientKind;
  recipientLabel: string | null;
  channelId: ChatChannelId | null;
  target: string | null;
  bindingId: string | null;
  requiresApproval: boolean | null;
  approvalChannelId: ChatChannelId | null;
  approvalTarget: string | null;
  draftMessage: string | null;
  dedupeKey: string;
  context: Record<string, unknown>;
};

/** Shape and sanitise raw escalation input. Throws on structurally bad input. */
export function normalizeEscalationInput(input: EscalationInput): NormalizedEscalationInput {
  const workerId = String(input.workerId ?? "").trim();
  if (!workerId) throw new Error("workerId is required");
  const kind = parseEscalationKind(input.kind);
  const title = sanitizeEscalationText(input.title ?? "", MAX_ESCALATION_TITLE_CHARS);
  if (!title) throw new Error("title is required");
  const context = input.context ?? {};
  // Same rule as channel bindings: nothing credential-shaped in agency.db.
  assertNoCredentials(context, "context");
  const urgency = parseEscalationUrgency(input.urgency);
  return {
    workerId,
    workItemId: input.workItemId?.trim() ? input.workItemId.trim() : null,
    kind,
    // A proactive insight is never urgent by construction — that is the whole
    // point of it being proactive rather than a blocker.
    urgency: kind === "proactive_insight" ? "low" : urgency,
    title,
    summary: sanitizeEscalationText(input.summary ?? "", MAX_ESCALATION_SUMMARY_CHARS),
    question: input.question?.trim()
      ? sanitizeEscalationText(input.question, MAX_ESCALATION_TITLE_CHARS * 2)
      : null,
    options: (input.options ?? [])
      .filter((option): option is string => typeof option === "string" && !!option.trim())
      .slice(0, 8)
      .map((option) => sanitizeEscalationText(option, 200)),
    reference: input.reference?.trim() ? input.reference.trim().slice(0, 500) : null,
    recipientKind: parseRecipientKind(input.recipientKind),
    recipientLabel: input.recipientLabel?.trim()
      ? sanitizeEscalationText(input.recipientLabel, 160)
      : null,
    channelId: input.channelId ? normalizeChatChannelId(input.channelId) : null,
    target: input.target?.trim() ? input.target.trim().slice(0, 400) : null,
    bindingId: input.bindingId?.trim() ? input.bindingId.trim() : null,
    // `null` means "policy decides"; an explicit boolean is an override.
    requiresApproval: typeof input.requiresApproval === "boolean" ? input.requiresApproval : null,
    approvalChannelId: input.approvalChannelId
      ? normalizeChatChannelId(input.approvalChannelId)
      : null,
    approvalTarget: input.approvalTarget?.trim() ? input.approvalTarget.trim().slice(0, 400) : null,
    // The employee's own wording is redacted like any other channel-bound text.
    draftMessage: input.draftMessage?.trim()
      ? sanitizeEscalationText(input.draftMessage, MAX_ESCALATION_SUMMARY_CHARS * 3)
      : null,
    dedupeKey:
      input.dedupeKey?.trim()?.slice(0, 200) ||
      defaultDedupeKey({ kind, workItemId: input.workItemId ?? null, title }),
    context,
  };
}
