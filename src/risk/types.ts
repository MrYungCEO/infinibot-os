/**
 * Risk Register (Object 7) — shared types.
 *
 * A structured tracker for the risks that threaten the business: financial,
 * technical, delivery, client, security/privacy, legal/compliance, IP,
 * capacity, vendor, reputational, and founder-dependency risks. Each risk is
 * scored on a 1–25 Probability × Impact matrix, carries a single accountable
 * owner (§27), and is connected to the objects it touches (client, opportunity,
 * project, product, system issue, decision, and the tasks it impacts) through
 * the typed-edge relations layer (`src/relations`), never duplicated (§4/§14).
 *
 * The record extends the standardized `CommonObjectFields` (§25) so the HQ
 * views and rules engine can treat a risk like any other business object.
 */

import type { CommonObjectFields } from "../business-objects/common.js";

// ═══════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════

/** The risk categories from the spec (Object 7 — RISKS). */
export const RISK_CATEGORIES = [
  "Financial",
  "Technical",
  "Delivery",
  "Client",
  "Security",
  "Privacy",
  "Legal",
  "Compliance",
  "IP",
  "Capacity",
  "Vendor",
  "Reputational",
  "Founder Dependency",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** Lifecycle status of a risk. */
export const RISK_STATUSES = ["Open", "Monitoring", "Mitigated", "Closed"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

/**
 * Probability / Impact are captured on the standard 1–5 risk-matrix scale.
 * A `RiskScore` is their product, in the range 1–25.
 */
export const RISK_MATRIX_MIN = 1;
export const RISK_MATRIX_MAX = 5;

/**
 * Score at (and above) which a risk is treated as *critical*: it flips to the
 * short (3-day) review cadence (§29 `criticalRisk`) and an audit entry is
 * written when a risk crosses this line. 12 sits at the high/critical band of a
 * 1–25 matrix (e.g. 3×4, 4×3, 4×4, any ×5 ≥ 3).
 */
export const CRITICAL_RISK_SCORE = 12;

/** Named severity band for a 1–25 score — surfaced as the common `riskLevel`. */
export type RiskBand = "Low" | "Medium" | "High" | "Critical";

// ═══════════════════════════════════════════════════════════════════
// PURE SCORING HELPERS (no I/O)
// ═══════════════════════════════════════════════════════════════════

/** Clamp a raw probability/impact input into the 1–5 matrix range. */
export function clampMatrix(v: number | undefined | null): number {
  const n = Math.round(Number(v ?? RISK_MATRIX_MIN));
  if (!Number.isFinite(n)) return RISK_MATRIX_MIN;
  return Math.min(RISK_MATRIX_MAX, Math.max(RISK_MATRIX_MIN, n));
}

/** Risk Score = Probability × Impact, always in 1–25. Computed, never entered. */
export function computeRiskScore(probability: number, impact: number): number {
  return clampMatrix(probability) * clampMatrix(impact);
}

/** Map a 1–25 score onto its named severity band. */
export function riskBand(score: number): RiskBand {
  if (score >= CRITICAL_RISK_SCORE) return "Critical";
  if (score >= 8) return "High";
  if (score >= 4) return "Medium";
  return "Low";
}

/** True once a score reaches the critical threshold. */
export function isCriticalScore(score: number): boolean {
  return score >= CRITICAL_RISK_SCORE;
}

/**
 * The §29 staleness kind that governs this risk's review cadence: high-scoring
 * risks are reviewed every 3 days (`criticalRisk`), the rest every 14 days
 * (`normalRisk`).
 */
export function staleKindForScore(score: number): "criticalRisk" | "normalRisk" {
  return isCriticalScore(score) ? "criticalRisk" : "normalRisk";
}

// ═══════════════════════════════════════════════════════════════════
// RECORD
// ═══════════════════════════════════════════════════════════════════

/**
 * A fully-materialized risk record as stored + returned by the store. Extends
 * the standardized common fields (§25): `owner`/`status`/`priority`, the
 * relationship id cache (`clientId`/`opportunityId`/`projectId`/`productId`),
 * `riskLevel`/`financialValue`/`lastUpdated`, `dataQuality`, `authorityLevel`.
 */
export interface Risk extends CommonObjectFields {
  // ── Identification / classification ──
  /** Risk Title. */
  title: string;
  category: RiskCategory | string;
  // ── Additional typed links not covered by the common relationship cache ──
  /** Linked System Issue (Object 10) id, if this risk originates from one. */
  issueId?: string;
  /** Linked Decision (Object 6) id that governs this risk's response. */
  decisionId?: string;
  // ── Scoring (1–5 each; score is computed 1–25) ──
  probability: number;
  impact: number;
  /** Computed = Probability × Impact. Never accepted from the caller. */
  riskScore: number;
  // ── Response ──
  mitigation: string;
  /** ISO date (YYYY-MM-DD) the risk is next due for review. */
  nextReviewDate: string;
  // ── Timestamps (Unix ms) ──
  createdAt: number;
  updatedAt: number;
}

/**
 * Fields accepted on create. `title` is the only hard requirement; `owner` is
 * enforced at the write boundary by the §27 single-owner rule. `riskScore` is
 * intentionally absent — it is always computed from probability × impact.
 */
export interface RiskCreateParams {
  title: string;
  category?: string;
  owner?: string;
  supportingOwner?: string;
  ceoRequired?: boolean;
  status?: string;
  priority?: string;
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
  issueId?: string;
  decisionId?: string;
  probability?: number;
  impact?: number;
  mitigation?: string;
  nextReviewDate?: string;
  financialValue?: number;
  blocked?: boolean;
  blocker?: string;
  escalationRequired?: boolean;
  dataQuality?: string;
  authorityLevel?: string;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Partial patch on update; `id` identifies the row. `riskScore` is computed. */
export interface RiskUpdateParams extends Partial<RiskCreateParams> {
  id: string;
}

export interface RiskSearchParams {
  query?: string;
  category?: string;
  status?: string;
  owner?: string;
  clientId?: string;
  projectId?: string;
  opportunityId?: string;
  productId?: string;
  /** Only risks whose score is ≥ this value. */
  minScore?: number;
  /** Only risks whose score is critical (≥ CRITICAL_RISK_SCORE). */
  criticalOnly?: boolean;
  /** Only risks updated after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}
