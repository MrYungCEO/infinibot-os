/**
 * Shared common-fields base for the ten Phase 1 business objects.
 *
 * The spec (§25 "Common System Fields") mandates that every major object use a
 * standardized field vocabulary so cross-system querying is possible. This file
 * is the single source of truth for those field groups and the enums that back
 * them (§26 Priority, §35 Data Quality, §32 Authority Levels).
 *
 * Object-builder agents SHOULD extend `CommonObjectFields` (or compose the
 * individual `Ownership` / `Execution` / `Relationships` / `Management` groups)
 * on their object's record type, and reuse these enums instead of re-declaring
 * their own. This keeps the public shape identical across all objects so the HQ
 * views and rules engine can treat any object uniformly.
 */

// ═══════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════

/**
 * §26 Priority System — a single four-level scale used by every object.
 *   P0 Critical · P1 High · P2 Normal · P3 Low
 * "If everything is urgent, the system has stopped prioritizing."
 */
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Human labels for each priority level (§26). */
export const PRIORITY_LABELS: Record<Priority, string> = {
  P0: "Critical",
  P1: "High",
  P2: "Normal",
  P3: "Low",
};

/**
 * §35 Data Quality Rule — every migrated/record value is classified so an
 * estimate never looks like a fact.
 */
export const DATA_QUALITIES = [
  "Verified", // supported by documentation / data
  "FounderReported", // supplied from memory
  "OperationsEstimated", // reasonable working estimate
  "Unknown", // information not yet available
] as const;
export type DataQuality = (typeof DATA_QUALITIES)[number];

/**
 * §32 System Authority Levels — how much autonomy an AI workflow has over an
 * object. Phase 1 operates primarily at L0–L2 with selected L3 actions.
 *   L0 Observe · L1 Recommend · L2 Prepare · L3 Execute w/ Approval
 *   L4 Execute Within Policy · L5 Autonomous Exception Management
 */
export const AUTHORITY_LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

/** Human labels for each authority level (§32). */
export const AUTHORITY_LEVEL_LABELS: Record<AuthorityLevel, string> = {
  L0: "Observe",
  L1: "Recommend",
  L2: "Prepare",
  L3: "Execute With Approval",
  L4: "Execute Within Policy",
  L5: "Autonomous Exception Management",
};

// ═══════════════════════════════════════════════════════════════════
// STANDARDIZED FIELD GROUPS (§25)
// ═══════════════════════════════════════════════════════════════════

/**
 * Ownership (§25 / §27). Exactly one accountable `owner`; contributors and a
 * single supporting owner are fine. `ceoRequired` flags items reserved for the
 * CEO under the authority model (§31).
 */
export interface Ownership {
  /** The single accountable owner. A record without one "is a wish" (§27). */
  owner: string;
  /** Optional secondary/supporting owner (not a second accountable owner). */
  supportingOwner?: string;
  /** Whether the item requires the CEO (routes to the CEO Queue). */
  ceoRequired?: boolean;
}

/**
 * Execution (§25 / §28). Status + priority, and the next-action triplet that
 * the Next-Action Rule enforces.
 */
export interface Execution {
  /** Object-specific status string (each object defines its own status set). */
  status: string;
  priority: Priority | string;
  nextAction?: string;
  nextActionOwner?: string;
  /** ISO date (YYYY-MM-DD) the next action is due. */
  nextActionDate?: string;
}

/**
 * Relationships (§25). Denormalized convenience ids for the four most-queried
 * parents. The authoritative graph still lives in `src/relations` — these are a
 * fast-path cache, not a replacement for the edge store.
 */
export interface Relationships {
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  productId?: string;
}

/** Management (§25). Cross-cutting risk / money / blocked / escalation state. */
export interface Management {
  riskLevel?: string;
  /** Currency amount (base units), when the object carries financial value. */
  financialValue?: number;
  blocked?: boolean;
  blocker?: string;
  escalationRequired?: boolean;
  /** Unix ms of the last meaningful update (drives the staleness rules §29). */
  lastUpdated?: number;
}

/**
 * The full standardized common-fields shape. Object records SHOULD extend this
 * (and add their own object-specific fields). All groups except `owner`,
 * `status` and `priority` are optional so partial/migrated records are valid.
 */
export interface CommonObjectFields
  extends Ownership,
    Execution,
    Relationships,
    Management {
  id: string;
  /** §35 classification of how trustworthy this record's data is. */
  dataQuality?: DataQuality | string;
  /** §32 authority level governing AI autonomy over this object. */
  authorityLevel?: AuthorityLevel | string;
}

/**
 * Convenience factory: a fully-defaulted common-fields object. Object agents can
 * spread this to guarantee every standardized field is present.
 */
export function defaultCommonFields(id: string, owner = ""): CommonObjectFields {
  return {
    id,
    owner,
    supportingOwner: "",
    ceoRequired: false,
    status: "",
    priority: "P2",
    nextAction: "",
    nextActionOwner: "",
    nextActionDate: "",
    clientId: "",
    opportunityId: "",
    projectId: "",
    productId: "",
    riskLevel: "",
    financialValue: 0,
    blocked: false,
    blocker: "",
    escalationRequired: false,
    lastUpdated: Date.now(),
    dataQuality: "Unknown",
    authorityLevel: "L0",
  };
}
