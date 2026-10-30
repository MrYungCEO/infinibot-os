/**
 * Business-object rules utilities — pure, side-effect-free functions that
 * encode the Phase 1 operating rules (§26–§29). Object-builder agents and the
 * HQ views all call these so a rule is defined once and applied identically
 * everywhere.
 *
 * Nothing here reads a store, mutates input, or performs I/O. `now` is injected
 * (defaulting to `Date.now()`) so callers/tests stay deterministic.
 */

import type { Priority } from "./common.js";

// ═══════════════════════════════════════════════════════════════════
// §26 PRIORITY
// ═══════════════════════════════════════════════════════════════════

/**
 * Sort rank for a priority: P0 → 0 (most urgent) … P3 → 3, unknown → 4.
 * Lower is more urgent, so `records.sort((a,b)=>priorityRank(a)-priorityRank(b))`
 * orders most-urgent-first.
 */
export function priorityRank(priority: Priority | string | undefined | null): number {
  switch (String(priority ?? "").toUpperCase()) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
    default:
      return 4;
  }
}

// ═══════════════════════════════════════════════════════════════════
// §29 STALE RECORD RULE
// ═══════════════════════════════════════════════════════════════════

/** The kinds of record the staleness thresholds are defined for (§29). */
export type StaleKind = "project" | "opportunity" | "criticalRisk" | "normalRisk";

/** §29 initial suggested thresholds, in days. Starting rules, not benchmarks. */
export const STALE_THRESHOLD_DAYS: Record<StaleKind, number> = {
  project: 7,
  opportunity: 7,
  criticalRisk: 3,
  normalRisk: 14,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a record is stale for its kind (§29): it has not been updated within
 * the kind's threshold window. A record with no `lastUpdated` is treated as
 * stale (unknown freshness needs attention). `lastUpdated` is Unix ms.
 */
export function isStale(
  record: { lastUpdated?: number | null },
  kind: StaleKind,
  now: number = Date.now(),
): boolean {
  const last = record?.lastUpdated;
  if (last == null || last <= 0) return true;
  const thresholdMs = STALE_THRESHOLD_DAYS[kind] * DAY_MS;
  return now - last > thresholdMs;
}

// ═══════════════════════════════════════════════════════════════════
// §28 NEXT-ACTION RULE
// ═══════════════════════════════════════════════════════════════════

/** Fields the next-action rule inspects. */
export interface NextActionRecord {
  nextAction?: string;
  nextActionOwner?: string;
  nextActionDate?: string;
  /** Alternative to a next action: an explicit "waiting for X" + review date. */
  waitingFor?: string;
  reviewDate?: string;
}

const nonEmpty = (v: string | undefined | null): boolean => !!(v && String(v).trim());

/**
 * §28: every active Client / Opportunity / Project / Risk / Decision must have
 * either **Next Action + Owner + Date** or **Waiting For + Review Date**.
 * Returns true when the record is MISSING both — i.e. it needs a next action.
 */
export function needsNextAction(record: NextActionRecord): boolean {
  const hasNext =
    nonEmpty(record.nextAction) &&
    nonEmpty(record.nextActionOwner) &&
    nonEmpty(record.nextActionDate);
  const hasWaiting = nonEmpty(record.waitingFor) && nonEmpty(record.reviewDate);
  return !(hasNext || hasWaiting);
}

// ═══════════════════════════════════════════════════════════════════
// §27 OWNERSHIP RULE
// ═══════════════════════════════════════════════════════════════════

/** Ownership shape the rule inspects: a single `owner` or an `owners` list. */
export interface OwnableRecord {
  owner?: string;
  owners?: string[];
}

/** The distinct, trimmed set of accountable owners on a record. */
function distinctOwners(record: OwnableRecord): string[] {
  const raw = record.owners ?? (record.owner ? [record.owner] : []);
  return Array.from(new Set(raw.map((o) => String(o).trim()).filter(Boolean)));
}

/**
 * §27: exactly one accountable owner. Multiple contributors are fine; multiple
 * owners are not. Non-throwing predicate.
 */
export function isSingleOwner(record: OwnableRecord): boolean {
  return distinctOwners(record).length === 1;
}

/**
 * §27 assertion form: throws with an actionable message when there is no
 * accountable owner or more than one. Use at write boundaries where the rule
 * must be enforced (create/update of an actionable item).
 */
export function assertSingleOwner(record: OwnableRecord): void {
  const owners = distinctOwners(record);
  if (owners.length === 0) {
    throw new Error(
      "Ownership rule (§27): an accountable owner is required — a task without an owner is a wish.",
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `Ownership rule (§27): exactly one accountable owner allowed, got ${owners.length} (${owners.join(
        ", ",
      )}). Keep one owner; move the rest to contributors.`,
    );
  }
}
