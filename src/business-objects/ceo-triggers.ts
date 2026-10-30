/**
 * CEO Decision Triggers (spec §16 — CEO QUEUE).
 *
 * The purpose of the CEO Queue is to *protect CEO attention by preventing
 * operational work from being disguised as CEO work*. A Decision belongs on the
 * queue ONLY when at least one CEO Decision Trigger is true; everything else
 * stays out. This module encodes those triggers as pure, side-effect-free
 * predicates so the rule is defined once and applied identically by the decision
 * store (`ceoQueue()`), the gateway RPC, and the Command-Center UI.
 *
 * Nothing here reads a store or performs I/O. A trigger fires from three
 * independent signals, in priority order:
 *   1. an explicit `ceoTriggers` list on the record (authoritative — an operator
 *      or agent has classified the decision),
 *   2. the `decisionType` (Technical→architecture, Product→direction, …),
 *   3. structured flags + keyword heuristics (priority, ceoRequired, scope/IP/
 *      contract/hiring language, or a linked opportunity above a value threshold).
 */

// ═══════════════════════════════════════════════════════════════════
// TRIGGER CATALOGUE (§16)
// ═══════════════════════════════════════════════════════════════════

/** The fourteen CEO Decision Triggers, in spec order. */
export const CEO_DECISION_TRIGGERS = [
  "technical_architecture",
  "product_direction",
  "major_strategic",
  "strategic_partnership",
  "material_pricing_exception",
  "material_financial_commitment",
  "contract_exception",
  "critical_client_escalation",
  "critical_risk",
  "major_scope_change",
  "ip_ownership",
  "hiring_above_threshold",
  "opportunity_above_value",
  "ops_cannot_resolve",
] as const;
export type CeoTrigger = (typeof CEO_DECISION_TRIGGERS)[number];

/** Human labels for each trigger — the "why this reached you" line. */
export const CEO_TRIGGER_LABELS: Record<CeoTrigger, string> = {
  technical_architecture: "Technical architecture decision",
  product_direction: "Product direction",
  major_strategic: "Major strategic decision",
  strategic_partnership: "Strategic partnership",
  material_pricing_exception: "Material pricing exception",
  material_financial_commitment: "Material financial commitment",
  contract_exception: "Contract exception",
  critical_client_escalation: "Critical client escalation",
  critical_risk: "Critical risk",
  major_scope_change: "Major scope change",
  ip_ownership: "IP ownership decision",
  hiring_above_threshold: "Hiring / contractor above threshold",
  opportunity_above_value: "Opportunity above defined value",
  ops_cannot_resolve: "Operations cannot resolve within delegated authority",
};

// ═══════════════════════════════════════════════════════════════════
// INPUT SHAPE
// ═══════════════════════════════════════════════════════════════════

/**
 * The minimal fields a decision must expose to be classified. Kept structural so
 * both the backend `Decision` and the browser `HqDecision` satisfy it.
 */
export interface CeoTriggerInput {
  decisionType?: string;
  priority?: string;
  ceoRequired?: boolean;
  authorityLevel?: string;
  title?: string;
  decisionRequired?: string;
  /** Explicit, pre-classified trigger keys (authoritative when present). */
  ceoTriggers?: string[] | null;
  /** Financial magnitude of the decision, if known (base currency units). */
  financialImpact?: number | null;
  /** Linked opportunity value, when the decision hangs off an opportunity. */
  opportunityValue?: number | null;
}

/** Tunable thresholds for the value-based triggers (§16). */
export interface CeoTriggerThresholds {
  /** A financial commitment at/above this is "material". */
  financial: number;
  /** An opportunity at/above this value warrants CEO attention. */
  opportunity: number;
  /** A hiring/contractor spend at/above this needs approval. */
  hiring: number;
}

/** Starting thresholds — working rules, not benchmarks (§16 "defined value"). */
export const DEFAULT_CEO_THRESHOLDS: CeoTriggerThresholds = {
  financial: 10000,
  opportunity: 25000,
  hiring: 5000,
};

// ═══════════════════════════════════════════════════════════════════
// PREDICATES
// ═══════════════════════════════════════════════════════════════════

const norm = (v: string | undefined | null): string => String(v ?? "").trim();
const isCriticalPriority = (p: string | undefined | null): boolean =>
  norm(p).toUpperCase() === "P0" || norm(p).toUpperCase() === "P1";

/** decisionType → the trigger it inherently implies (1:1 where meaningful). */
const TYPE_TO_TRIGGER: Record<string, CeoTrigger> = {
  technical: "technical_architecture",
  product: "product_direction",
  strategic: "major_strategic",
  partnership: "strategic_partnership",
  pricing: "material_pricing_exception",
  financial: "material_financial_commitment",
};

/**
 * Evaluate which CEO Decision Triggers fire for a decision. Returns the distinct
 * set of matched trigger keys (empty ⇒ this is operational work, keep it OUT of
 * the CEO Queue). Pure and deterministic.
 */
export function evaluateCeoTriggers(
  d: CeoTriggerInput,
  thresholds: CeoTriggerThresholds = DEFAULT_CEO_THRESHOLDS,
): CeoTrigger[] {
  const hits = new Set<CeoTrigger>();

  // 1. Explicit classification is authoritative.
  for (const raw of d.ceoTriggers ?? []) {
    const key = String(raw).trim() as CeoTrigger;
    if ((CEO_DECISION_TRIGGERS as readonly string[]).includes(key)) hits.add(key);
  }

  // 2. decisionType mapping.
  const type = norm(d.decisionType).toLowerCase();
  const typed = TYPE_TO_TRIGGER[type];
  if (typed) hits.add(typed);

  // 3. Structured flags + keyword heuristics over the free text.
  const text = `${norm(d.title)} ${norm(d.decisionRequired)}`.toLowerCase();
  const has = (rx: RegExp) => rx.test(text);

  if (has(/\bcontract\b|\bmsa\b|\bsow\b|\bterms\b/) && type === "legal")
    hits.add("contract_exception");
  else if (has(/contract exception|contract deviation|non-standard terms/))
    hits.add("contract_exception");

  if (has(/\bip\b|intellectual property|ownership|assignment of rights|licen[sc]e ownership/))
    hits.add("ip_ownership");

  if (has(/scope change|major scope|scope expansion|re-?scope|scope dispute/))
    hits.add("major_scope_change");

  if (has(/\bhir(e|ing)\b|contractor|headcount|new role|full[- ]time/))
    hits.add("hiring_above_threshold");

  // Critical client escalation: a client-type decision that is critical, or
  // anything explicitly flagged as an escalation.
  if ((type === "client" && isCriticalPriority(d.priority)) || has(/escalat/))
    hits.add("critical_client_escalation");

  // Critical risk: top-priority decision or explicit critical-risk language.
  if (isCriticalPriority(d.priority) || has(/critical risk|severe risk/)) hits.add("critical_risk");

  // Value-based triggers.
  if ((d.financialImpact ?? 0) >= thresholds.financial) hits.add("material_financial_commitment");
  if ((d.opportunityValue ?? 0) >= thresholds.opportunity) hits.add("opportunity_above_value");
  if (
    hits.has("hiring_above_threshold") &&
    (d.financialImpact ?? 0) > 0 &&
    (d.financialImpact ?? 0) < thresholds.hiring
  ) {
    // A hiring decision *below* the approval threshold is delegated — drop it
    // unless another trigger independently qualifies it.
    hits.delete("hiring_above_threshold");
  }

  // Operations cannot resolve within delegated authority: an explicit CEO
  // requirement or an authority level that stops short of autonomous execution
  // while the decision is still open.
  if (d.ceoRequired === true) hits.add("ops_cannot_resolve");

  return CEO_DECISION_TRIGGERS.filter((t) => hits.has(t));
}

/**
 * Whether a decision qualifies for the CEO Queue (§16): at least one trigger
 * fires. Everything else "should remain outside the CEO Queue."
 */
export function isCeoDecision(
  d: CeoTriggerInput,
  thresholds: CeoTriggerThresholds = DEFAULT_CEO_THRESHOLDS,
): boolean {
  return evaluateCeoTriggers(d, thresholds).length > 0;
}

/** The human-readable trigger labels that fired, for display. */
export function ceoTriggerLabels(
  d: CeoTriggerInput,
  thresholds: CeoTriggerThresholds = DEFAULT_CEO_THRESHOLDS,
): string[] {
  return evaluateCeoTriggers(d, thresholds).map((t) => CEO_TRIGGER_LABELS[t]);
}
