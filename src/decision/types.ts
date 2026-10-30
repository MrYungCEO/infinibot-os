/**
 * Decisions — the CEO-queue backbone (Phase 1 Object 6).
 *
 * A Decision is a discrete choice the business must make: a clear question, a
 * set of options, a recommendation, and — once made — a final call with its
 * rationale. Decisions are the spine of the CEO Queue: anything that needs the
 * founder's judgement is modeled here so it can be prepared by the system,
 * surfaced for review, and recorded with an audit trail (spec §33) once
 * Decided. Humans retain final authority (§24) — the system prepares and
 * recommends (L0–L2), it never decides autonomously.
 *
 * The record extends the standardized `CommonObjectFields` (spec §25): it reuses
 * `owner` (Decision Owner), `priority` (P0–P3, §26), `status`, `ceoRequired`,
 * the denormalized relationship ids, `dataQuality` (§35) and `authorityLevel`
 * (§32). Decision-specific fields are added on top.
 */

import type { CommonObjectFields } from "../business-objects/common.js";

/** Decision Type — the category of judgement being made (spec Object 6). */
export const DECISION_TYPES = [
  "Technical",
  "Product",
  "Strategic",
  "Financial",
  "Client",
  "Pricing",
  "Partnership",
  "Operational",
  "Legal",
  "Resource",
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/**
 * Decision lifecycle status. `Ready for Decision` and `CEO Review` are the two
 * statuses that place a decision on the CEO Queue (see `ceoQueue()`); `Decided`
 * is terminal-with-record (triggers an audit entry, §33); `Deferred` and
 * `Cancelled` remove it from the active queue.
 */
export const DECISION_STATUSES = [
  "Preparing",
  "Ready for Decision",
  "CEO Review",
  "Decided",
  "Deferred",
  "Cancelled",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** The two statuses that surface a decision on the CEO Queue. */
export const CEO_QUEUE_STATUSES: DecisionStatus[] = ["Ready for Decision", "CEO Review"];

/**
 * A fully-materialized Decision record as stored + returned by the store.
 * Extends the standardized common fields; `status`/`priority` are re-narrowed to
 * the Decision-specific vocabularies while staying string-compatible.
 */
export interface Decision extends CommonObjectFields {
  // ── Identification / classification ──
  title: string;
  decisionType: DecisionType | string;
  status: DecisionStatus | string;
  // ── Accountability (owner comes from CommonObjectFields) ──
  /** Who asked for the decision (person/agent id). */
  requestedBy: string;
  // ── Linkage (clientId/opportunityId/projectId/productId from common) ──
  /** Optional linked System Issue (Object 10). */
  issueId?: string;
  // ── The question (§17 CEO REQUEST FORMAT) ──
  /** The exact question that must be answered. */
  decisionRequired: string;
  /** §17 "Why now" — why this must be decided now, not later. */
  whyNow: string;
  /** The options under consideration (free text / newline-separated list). */
  options: string;
  /** The system's / owner's recommendation ("Operations Recommendation"). */
  recommendation: string;
  /** ISO date (YYYY-MM-DD) the decision is needed by ("Decision Needed By"). */
  decisionDeadline: string;
  /** §17 "Impact if delayed" — the concrete cost of not deciding by the deadline. */
  impactIfDelayed: string;
  /**
   * §16 explicit CEO Decision Trigger keys (from `ceo-triggers.ts`). When set,
   * these are authoritative for CEO-Queue membership; when empty the triggers
   * are inferred from decisionType / priority / flags. Optional financial size
   * feeds the value-based triggers.
   */
  ceoTriggers: string[];
  /** Financial magnitude of the decision (base currency units), if known. */
  financialImpact: number;
  // ── Outcome (populated when Decided) ──
  /** The final decision that was made. */
  finalDecision: string;
  /** ISO date (YYYY-MM-DD) the decision was made. */
  decisionDate: string;
  /** Why this decision was made (recorded for the audit trail). */
  rationale: string;
  // ── Timestamps (Unix ms) ──
  createdAt: number;
  updatedAt: number;
}

/** Fields accepted on create. `title` is the only hard requirement. */
export interface DecisionCreateParams {
  title: string;
  decisionType?: string;
  status?: string;
  owner?: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  requestedBy?: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
  issueId?: string;
  decisionRequired?: string;
  whyNow?: string;
  options?: string;
  recommendation?: string;
  decisionDeadline?: string;
  impactIfDelayed?: string;
  ceoTriggers?: string[];
  financialImpact?: number;
  priority?: string;
  finalDecision?: string;
  decisionDate?: string;
  rationale?: string;
  dataQuality?: string;
  authorityLevel?: string;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Partial patch on update; `id` identifies the row. */
export interface DecisionUpdateParams extends Partial<DecisionCreateParams> {
  id: string;
}

export interface DecisionSearchParams {
  query?: string;
  decisionType?: string;
  status?: string;
  priority?: string;
  owner?: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
  issueId?: string;
  /** Only return decisions updated after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}
