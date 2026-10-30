/**
 * Opportunities (Business Control Layer — Object 2) — shared types.
 *
 * Tracks potential business before it becomes confirmed work (spec §5 "OBJECT 2
 * — OPPORTUNITIES"). Backs the New Opportunity Scoring SOP: capture, score,
 * qualify, and move an opportunity through the sales pipeline without relying on
 * memory or informal conversations.
 *
 * The record extends the standardized `CommonObjectFields` (§25) so cross-system
 * querying works: `owner`, `status`, `priority`, the next-action triplet, the
 * denormalized relationship ids, and the §35 `dataQuality` / §32 `authorityLevel`
 * all come from the shared base. Object-specific fields (pipeline stage, score,
 * value, revenue type, …) are added on top.
 */

import type { CommonObjectFields, Priority } from "../business-objects/common.js";

// ═══════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════

/** Opportunity Type (spec) — the shape of the potential business. */
export const OPPORTUNITY_TYPES = [
  "New Client",
  "Expansion",
  "Partnership",
  "Pilot",
  "Licensing",
  "Custom Build",
  "Other",
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/**
 * Pipeline Stage (spec) — direction is New → … → Negotiation, then a terminal
 * Won / Lost / Hold. This is the opportunity's primary state; the board columns
 * are these stages in order.
 */
export const PIPELINE_STAGES = [
  "New",
  "Qualification",
  "Discovery",
  "Evaluation",
  "Proposal",
  "Negotiation",
  "Won",
  "Lost",
  "Hold",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Terminal stages — no further pipeline movement is expected. */
export const TERMINAL_STAGES: readonly PipelineStage[] = ["Won", "Lost", "Hold"];

/** Revenue Type (spec) — how the money recurs, if at all. */
export const REVENUE_TYPES = ["One-Time", "Recurring", "Hybrid"] as const;
export type RevenueType = (typeof REVENUE_TYPES)[number];

// ═══════════════════════════════════════════════════════════════════
// RECORD
// ═══════════════════════════════════════════════════════════════════

/**
 * A fully-materialized opportunity record as stored + returned by the store.
 * Extends the shared common fields (Ownership / Execution / Relationships /
 * Management + id / dataQuality / authorityLevel).
 */
export interface Opportunity extends CommonObjectFields {
  // ── Identification / classification ──
  /** Short recognizable name. */
  name: string;
  /** New Client / Expansion / Partnership / Pilot / Licensing / Custom Build. */
  opportunityType: OpportunityType | string;
  /** Pipeline Stage — the opportunity's primary state (drives the board). */
  stage: PipelineStage | string;

  // ── Substance ──
  /** What the customer is trying to solve. */
  problemNeed: string;
  /** Proposed Solution — free text description of the product/solution. The
   *  authoritative product link lives in the objrel graph + `productId`. */
  proposedSolution: string;
  /** Likely contract value (base currency units). Mirrored to `financialValue`
   *  on the common Management group so cross-object money queries see it too. */
  estimatedValue: number;
  /** One-Time / Recurring / Hybrid. */
  revenueType: RevenueType | string;
  /** Result of the opportunity scoring process (numeric score). */
  opportunityScore: number;
  /** Best current estimate of the decision date (ISO YYYY-MM-DD). */
  expectedCloseDate: string;

  // ── Next-action alternative (§28) ──
  /** "Waiting for X" — the alternative to a Next Action (§28). */
  waitingFor: string;
  /** Review date for the Waiting-For path (ISO YYYY-MM-DD). */
  reviewDate: string;

  // ── Links / context ──
  /** Latest relevant proposal / commercial document link. */
  proposalLink: string;
  /** Context not captured elsewhere. */
  notes: string;

  // ── Timestamps (Unix ms) ──
  createdAt: number;
  updatedAt: number;

  // ── Derived (populated by list()/get(); never persisted) ──
  /** §28: true when this active opportunity lacks a Next Action / Waiting-For. */
  needsAction?: boolean;
  /** §29: true when this active opportunity hasn't been updated in 7 days. */
  stale?: boolean;
}

/** Fields accepted on create. `name` is the only hard requirement; an
 *  accountable `owner` is enforced by the §27 ownership rule at the store. */
export interface OpportunityCreateParams {
  name: string;
  owner?: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  opportunityType?: string;
  stage?: string;
  status?: string;
  priority?: string;
  problemNeed?: string;
  proposedSolution?: string;
  estimatedValue?: number;
  revenueType?: string;
  opportunityScore?: number;
  expectedCloseDate?: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  waitingFor?: string;
  reviewDate?: string;
  clientId?: string;
  productId?: string;
  projectId?: string;
  proposalLink?: string;
  notes?: string;
  dataQuality?: string;
  authorityLevel?: string;
  blocked?: boolean;
  blocker?: string;
  escalationRequired?: boolean;
  /** When true, treat this as a §34 migration import: default dataQuality to
   *  "FounderReported" (an estimate, not a fact) unless one is supplied (§35). */
  migrated?: boolean;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Partial patch on update; `id` identifies the row. */
export interface OpportunityUpdateParams extends Partial<OpportunityCreateParams> {
  id: string;
}

export interface OpportunitySearchParams {
  query?: string;
  stage?: string;
  opportunityType?: string;
  priority?: Priority | string;
  owner?: string;
  clientId?: string;
  productId?: string;
  /** Only return opportunities updated after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}
