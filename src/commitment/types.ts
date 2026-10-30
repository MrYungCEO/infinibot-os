/**
 * Financial Commitments (K.I.S. Object 8) — shared types.
 *
 * A commitment is a single expected movement of money — in (client invoices,
 * deposits, milestone payments, recurring revenue) or out (contractor / vendor
 * payments, project expenses). The object is the money-in / money-out ledger
 * that lets the HQ answer "what are we owed", "what's overdue", "which deposits
 * haven't landed" and "where is work proceeding without payment" (spec §8).
 *
 * The record extends the standardized `CommonObjectFields` (spec §25) so it
 * shares the ownership / execution / relationship / management vocabulary with
 * every other business object. Commitment-specific money fields sit on top.
 */

import type { CommonObjectFields } from "../business-objects/common.js";

// ═══════════════════════════════════════════════════════════════════
// ENUMS (spec §8 field set)
// ═══════════════════════════════════════════════════════════════════

/** Type of financial commitment. */
export const COMMITMENT_TYPES = [
  "Client Invoice",
  "Deposit",
  "Milestone Payment",
  "Recurring Revenue",
  "Contractor Payment",
  "Vendor Commitment",
  "Project Expense",
] as const;
export type CommitmentType = (typeof COMMITMENT_TYPES)[number];

/** Direction the money flows relative to the business. */
export const COMMITMENT_DIRECTIONS = ["Money In", "Money Out"] as const;
export type CommitmentDirection = (typeof COMMITMENT_DIRECTIONS)[number];

/** Lifecycle status of a commitment. `Overdue` is also derived (see store). */
export const COMMITMENT_STATUSES = [
  "Expected",
  "Invoiced",
  "Partially Paid",
  "Paid",
  "Overdue",
  "Cancelled",
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/**
 * The `Money In` commitment types — used by the money-in aggregates. Everything
 * else is money out.
 */
export const MONEY_IN_TYPES: readonly CommitmentType[] = [
  "Client Invoice",
  "Deposit",
  "Milestone Payment",
  "Recurring Revenue",
];

// ═══════════════════════════════════════════════════════════════════
// RECORD
// ═══════════════════════════════════════════════════════════════════

/**
 * A fully-materialized commitment record.
 *
 * Reuses `CommonObjectFields`:
 *   - `owner` / `supportingOwner` / `ceoRequired` — Owner🔗 (§27 single owner)
 *   - `status` — the commitment status (narrowed to CommitmentStatus)
 *   - `priority` — P0–P3 (§26)
 *   - `nextAction` / `nextActionOwner` / `nextActionDate` — Next Action(+date)
 *   - `clientId` / `opportunityId` / `projectId` / `productId` — the four 🔗 links
 *   - `financialValue` — mirrors `amount` for cross-object money rollups
 *   - `dataQuality` / `authorityLevel` — §35 / §32
 */
export interface Commitment extends CommonObjectFields {
  /** Commitment Name. */
  name: string;
  /** Type (Client Invoice / Deposit / …). */
  commitmentType: CommitmentType | string;
  /** Direction (Money In / Money Out). */
  direction: CommitmentDirection | string;
  status: CommitmentStatus | string;
  /** Total amount of the commitment (currency base units, e.g. cents). */
  amount: number;
  /** ISO date (YYYY-MM-DD) the amount is due. */
  dueDate: string;
  /** Amount received / paid so far (same units as `amount`). */
  amountPaid: number;
  /** COMPUTED, read-only: `amount − amountPaid` (never persisted). */
  remainingBalance: number;
  /** COMPUTED, read-only: derived from dueDate + status (never persisted). */
  overdue: boolean;
  /** Free link to the source contract / invoice / PO document. */
  sourceDocumentLink: string;
  // ── Timestamps (Unix ms) ──
  createdAt: number;
  updatedAt: number;
}

/** Fields accepted on create. `name` is the only hard requirement. */
export interface CommitmentCreateParams {
  name: string;
  commitmentType?: string;
  direction?: string;
  status?: string;
  amount?: number;
  dueDate?: string;
  amountPaid?: number;
  sourceDocumentLink?: string;
  // Common fields
  owner?: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  priority?: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
  dataQuality?: string;
  authorityLevel?: string;
  /** Who/what created the record (for audit + relation provenance). */
  createdBy?: string;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Partial patch on update; `id` identifies the row. */
export interface CommitmentUpdateParams extends Partial<CommitmentCreateParams> {
  id: string;
}

export interface CommitmentSearchParams {
  query?: string;
  commitmentType?: string;
  direction?: string;
  status?: string;
  owner?: string;
  clientId?: string;
  projectId?: string;
  opportunityId?: string;
  productId?: string;
  /** When true, only rows that are overdue (derived) are returned. */
  overdueOnly?: boolean;
  /** Only return commitments updated after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}

/**
 * The money surfaces spec §8 requires the HQ to answer. All amounts are in the
 * same currency base units as `Commitment.amount`.
 */
export interface CommitmentAggregates {
  /** Remaining balance of active Money-In commitments (what we're still owed). */
  moneyExpected: number;
  /** Remaining balance of active Money-Out commitments (what we still owe). */
  moneyOwed: number;
  /** Remaining balance across all overdue commitments (past due, unpaid). */
  moneyOverdue: number;
  /** Remaining balance of active Money-In `Deposit` commitments not yet received. */
  depositsNotReceived: number;
  /**
   * Money-In commitments tied to a project that is presumably proceeding while
   * payment is still outstanding (unpaid deposit/invoice on a live project).
   */
  workProceedingWithoutPayment: {
    count: number;
    amount: number;
    projectIds: string[];
    commitmentIds: string[];
  };
  /** Count of overdue commitments. */
  overdueCount: number;
  /** Total number of commitments considered. */
  total: number;
}
