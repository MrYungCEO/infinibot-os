/**
 * CEO Decision Triggers — browser mirror of `src/business-objects/ceo-triggers.ts`
 * (§16 CEO QUEUE). The gateway store is the source of truth; this mirror lets the
 * Command-Center views apply the same trigger gate client-side so the CEO Queue
 * filters correctly even against a pre-restart gateway that hasn't yet enriched
 * decisions with their inferred triggers. Keep the two in lockstep.
 */

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

export interface CeoTriggerInput {
  decisionType?: string;
  priority?: string;
  ceoRequired?: boolean;
  authorityLevel?: string;
  title?: string;
  decisionRequired?: string;
  ceoTriggers?: string[] | null;
  financialImpact?: number | null;
  opportunityValue?: number | null;
}

export interface CeoTriggerThresholds {
  financial: number;
  opportunity: number;
  hiring: number;
}

export const DEFAULT_CEO_THRESHOLDS: CeoTriggerThresholds = {
  financial: 10000,
  opportunity: 25000,
  hiring: 5000,
};

const norm = (v: string | undefined | null): string => String(v ?? "").trim();
const isCriticalPriority = (p: string | undefined | null): boolean =>
  norm(p).toUpperCase() === "P0" || norm(p).toUpperCase() === "P1";

const TYPE_TO_TRIGGER: Record<string, CeoTrigger> = {
  technical: "technical_architecture",
  product: "product_direction",
  strategic: "major_strategic",
  partnership: "strategic_partnership",
  pricing: "material_pricing_exception",
  financial: "material_financial_commitment",
};

export function evaluateCeoTriggers(
  d: CeoTriggerInput,
  thresholds: CeoTriggerThresholds = DEFAULT_CEO_THRESHOLDS,
): CeoTrigger[] {
  const hits = new Set<CeoTrigger>();

  for (const raw of d.ceoTriggers ?? []) {
    const key = String(raw).trim() as CeoTrigger;
    if ((CEO_DECISION_TRIGGERS as readonly string[]).includes(key)) hits.add(key);
  }

  const type = norm(d.decisionType).toLowerCase();
  const typed = TYPE_TO_TRIGGER[type];
  if (typed) hits.add(typed);

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
  if ((type === "client" && isCriticalPriority(d.priority)) || has(/escalat/))
    hits.add("critical_client_escalation");
  if (isCriticalPriority(d.priority) || has(/critical risk|severe risk/))
    hits.add("critical_risk");

  if ((d.financialImpact ?? 0) >= thresholds.financial)
    hits.add("material_financial_commitment");
  if ((d.opportunityValue ?? 0) >= thresholds.opportunity)
    hits.add("opportunity_above_value");
  if (
    hits.has("hiring_above_threshold") &&
    (d.financialImpact ?? 0) > 0 &&
    (d.financialImpact ?? 0) < thresholds.hiring
  ) {
    hits.delete("hiring_above_threshold");
  }

  if (d.ceoRequired === true) hits.add("ops_cannot_resolve");

  return CEO_DECISION_TRIGGERS.filter((t) => hits.has(t));
}

export function isCeoDecision(
  d: CeoTriggerInput,
  thresholds: CeoTriggerThresholds = DEFAULT_CEO_THRESHOLDS,
): boolean {
  return evaluateCeoTriggers(d, thresholds).length > 0;
}

export function ceoTriggerLabels(
  d: CeoTriggerInput,
  thresholds: CeoTriggerThresholds = DEFAULT_CEO_THRESHOLDS,
): string[] {
  return evaluateCeoTriggers(d, thresholds).map((t) => CEO_TRIGGER_LABELS[t]);
}
