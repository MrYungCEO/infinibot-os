/**
 * People / Resources (K.I.S. Object 9) — shared types.
 *
 * The human (and human-resource) side of the Business Control Layer: founders,
 * employees, contractors, and partners. One record per real person (§4 "create
 * once, reference throughout"); everything a person is connected to — Projects,
 * Tasks, Decisions, Risks, System Issues — is expressed as a typed edge in the
 * relations layer (`src/relations`), NOT duplicated onto this record.
 *
 * IMPORTANT: this is the *business* People/Resources object (who does the work in
 * the company). It is distinct from the AI agent roster (`src/agents`), which
 * models software agents. Do not conflate the two.
 *
 * Record extends `CommonObjectFields` so it shares the standardized ownership /
 * execution / relationships / management field groups (spec §25) with every
 * other business object. Person-specific fields are added on top.
 */

import type { CommonObjectFields } from "../business-objects/common.js";

/** How this person is related to the business (spec Object 9 — Relationship Type). */
export const PERSON_RELATIONSHIP_TYPES = [
  "Founder",
  "Employee",
  "Contractor",
  "Partner",
] as const;
export type PersonRelationshipType = (typeof PERSON_RELATIONSHIP_TYPES)[number];

/** Lifecycle status of the person as a resource (spec Object 9 — Status). */
export const PERSON_STATUSES = ["Active", "Inactive", "Onboarding"] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/**
 * Access level governs what this person may see/do in the system. Kept distinct
 * from the §32 AI authority level on `CommonObjectFields.authorityLevel` (which
 * governs AI autonomy over the *record*): this is the *person's* access.
 */
export const PERSON_ACCESS_LEVELS = [
  "Owner", // full access
  "Admin",
  "Standard",
  "Restricted",
  "None",
] as const;
export type PersonAccessLevel = (typeof PERSON_ACCESS_LEVELS)[number];

/**
 * A fully-materialized person record as stored + returned by the store.
 * Extends the standardized common fields; `status` carries a `PersonStatus`
 * value and `owner` is the accountable manager for this person record.
 */
export interface Person extends CommonObjectFields {
  // ── Identity ──
  /** Display name of the person. The one hard requirement on create. */
  name: string;
  relationshipType: PersonRelationshipType | string;
  /** Job title / function, e.g. "Head of Growth", "Contract Designer". */
  role: string;

  // ── Capability ──
  /** Capabilities / skills tags — what this person can do. */
  capabilities: string[];

  // ── Capacity & cost ──
  /**
   * Free-text availability / capacity, e.g. "Full-time", "20 hrs/week",
   * "Weekends only". Current *workload* is DERIVED from linked Tasks/Projects
   * (see `PersonStore.workloadFor`) and is never stored on the record.
   */
  availability: string;
  /** Cost / rate, free text so it can hold "$120/hr", "£4k/mo", "equity". */
  costRate: string;

  // ── Access & contact ──
  accessLevel: PersonAccessLevel | string;
  email: string;
  phone: string;
  /** Any other contact detail (Slack handle, address, timezone, …). */
  contactInfo: string;

  // ── Timestamps (Unix ms) ──
  createdAt: number;
  updatedAt: number;
}

/** Fields accepted on create. `name` is the only hard requirement. */
export interface PersonCreateParams {
  name: string;
  relationshipType?: string;
  role?: string;
  status?: string;
  capabilities?: string[];
  availability?: string;
  costRate?: string;
  accessLevel?: string;
  email?: string;
  phone?: string;
  contactInfo?: string;
  // ── Standardized common fields (all optional) ──
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
  riskLevel?: string;
  financialValue?: number;
  blocked?: boolean;
  blocker?: string;
  escalationRequired?: boolean;
  /** §35 data quality — set on migrated / estimated records. */
  dataQuality?: string;
  /** §32 AI authority level over this record. */
  authorityLevel?: string;
  /** Optional idempotency key — a second create with the same id no-ops. */
  clientRequestId?: string;
}

/** Partial patch on update; `id` identifies the row. */
export interface PersonUpdateParams extends Partial<PersonCreateParams> {
  id: string;
}

export interface PersonSearchParams {
  query?: string;
  relationshipType?: string;
  status?: string;
  accessLevel?: string;
  owner?: string;
  /** Only return people updated after this Unix-ms timestamp. */
  since?: number;
  limit?: number;
}

/**
 * Derived capacity picture for one person, computed from the typed-edge store
 * (never stored on the record). `activeTaskCount` counts linked tasks whose edge
 * `meta.status` is not a terminal status (done/completed/cancelled); tasks with
 * no status metadata are treated as active.
 */
export interface PersonWorkload {
  personId: string;
  taskCount: number;
  activeTaskCount: number;
  projectCount: number;
  decisionCount: number;
  riskCount: number;
  issueCount: number;
  /** Total linked objects across all types. */
  totalLinks: number;
}
