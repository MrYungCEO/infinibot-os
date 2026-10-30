/**
 * Pure helpers shared by the Executive (§15–§17) and Operations (§18) Command
 * Centers, and the Ops Agents surface (§19–§21).
 *
 * The React Native counterpart of `ui/src/ui/views/command-center-shared.ts`,
 * minus everything to do with rendering — on mobile the ui-kit owns presentation
 * (Chip / PriorityChip / StatusChip / ListRow), so this file is only predicates,
 * formatters and the §16 trigger label map.
 *
 * No hex literals, no JSX, no gateway calls. Just data → data.
 */

const DAY = 86400000;

// ═══════════════════════════════════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════════════════════════════════

/** Compact currency. `$1.2M` / `$48.5k` / `$900`. Never a bare number. */
export function money(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a)}`;
}

/** An ISO date rendered relative: `overdue 3d` / `today` / `in 5d` / `—`. */
export function fmtIsoDue(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const days = Math.round((t - startOfToday()) / DAY);
  if (days < 0) return `overdue ${Math.abs(days)}d`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

/** `1 risk` / `2 risks`. Counts read as noise when the noun doesn't agree. */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
}

/** A Unix-ms timestamp as a short absolute stamp for "generated at" lines. */
export function fmtStamp(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(
    undefined,
    { hour: 'numeric', minute: '2-digit' },
  )}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ═══════════════════════════════════════════════════════════════════
// DATE PREDICATES (ISO strings — the object stores speak ISO, not epoch)
// ═══════════════════════════════════════════════════════════════════

export function isoIsPast(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t < startOfToday();
}

export function isoWithinDays(iso, days) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const delta = t - startOfToday();
  return delta >= 0 && delta <= days * DAY;
}

export function isoIsToday(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const delta = t - startOfToday();
  return delta >= 0 && delta < DAY;
}

// ═══════════════════════════════════════════════════════════════════
// OBJECT PREDICATES — mirrors of src/business-objects/rules.ts
// ═══════════════════════════════════════════════════════════════════

export const nonEmpty = (v) => !!(v && String(v).trim());

const TERMINAL_OPP = /won|lost|hold/i;
/** An opportunity is active until it reaches a terminal stage. */
export const oppIsActive = (o) => !TERMINAL_OPP.test(o?.stage || o?.status || '');

const RESOLVED_RISK = /closed|mitigated|accepted|resolved/i;
export const riskIsOpen = (r) => !RESOLVED_RISK.test(r?.status || '');

/** §14: risk score >= 12, or an explicitly Critical level, is CEO-grade. */
export const isCriticalRisk = (r) =>
  riskIsOpen(r) && ((Number(r?.riskScore) || 0) >= 12 || /critical/i.test(r?.riskLevel || ''));

/** Money-in commitments that are still owed to us. */
export const isOutstandingInvoice = (c) =>
  /money in/i.test(c?.direction || '') &&
  /invoiced|expected|overdue|partially/i.test(c?.status || '');

export const isOverdueCommitment = (c) => c?.overdue === true || isoIsPast(c?.dueDate);

export const clientIsActive = (c) => /active/i.test(c?.status || '');

/** §15: a proposal the CEO has to approve before it goes out. */
export const needsCeoApproval = (o) =>
  /proposal/i.test(o?.stage || '') || o?.ceoRequired === true || o?.escalationRequired === true;

// ═══════════════════════════════════════════════════════════════════
// §16 CEO DECISION TRIGGERS — label map only
// ═══════════════════════════════════════════════════════════════════
//
// The trigger *engine* lives in src/business-objects/ceo-triggers.ts and runs
// server-side: `decision.ceoQueue({ triggerFiltered: true })` returns only
// decisions that fired at least one trigger, each enriched with its inferred
// `ceoTriggers`. The app deliberately does NOT re-implement the inference —
// it only needs to name what the gateway already decided.

export const CEO_TRIGGER_LABELS = {
  technical_architecture: 'Technical architecture decision',
  product_direction: 'Product direction',
  major_strategic: 'Major strategic decision',
  strategic_partnership: 'Strategic partnership',
  material_pricing_exception: 'Material pricing exception',
  material_financial_commitment: 'Material financial commitment',
  contract_exception: 'Contract exception',
  critical_client_escalation: 'Critical client escalation',
  critical_risk: 'Critical risk',
  major_scope_change: 'Major scope change',
  ip_ownership: 'IP ownership decision',
  hiring_above_threshold: 'Hiring / contractor above threshold',
  opportunity_above_value: 'Opportunity above defined value',
  ops_cannot_resolve: 'Operations cannot resolve within delegated authority',
};

/** Human labels for the triggers the gateway attached to a queued decision. */
export function triggerLabels(decision) {
  const raw = Array.isArray(decision?.ceoTriggers) ? decision.ceoTriggers : [];
  return raw.map((t) => CEO_TRIGGER_LABELS[t] || String(t).replace(/_/g, ' '));
}

/** True when a queued decision names a product-direction trigger (§15 week band). */
export function firesProductDirection(decision) {
  const raw = Array.isArray(decision?.ceoTriggers) ? decision.ceoTriggers : [];
  return raw.includes('product_direction');
}

/** True when any trigger on the decision concerns a client. */
export function firesClientTrigger(decision) {
  const raw = Array.isArray(decision?.ceoTriggers) ? decision.ceoTriggers : [];
  return raw.some((t) => /client/i.test(String(t)));
}

// ═══════════════════════════════════════════════════════════════════
// §17 CEO REQUEST FORMAT — derived fallbacks
// ═══════════════════════════════════════════════════════════════════
//
// A CEO card must be complete: a request that omits "why now" or "impact if
// delayed" costs the CEO the thinking the format exists to save. When the
// operator hasn't authored those fields we derive a defensible line from a REAL
// signal on the record — and flag it as derived so the screen can render it
// muted. A derived line is never dressed up as an operator-authored one.

export const isDerived = (v) => !(v && String(v).trim());

export function deriveWhyNow(d) {
  if (nonEmpty(d?.whyNow)) return d.whyNow;
  if (d?.decisionDeadline) {
    return `Decision is time-boxed — needed by ${d.decisionDeadline}; dependent work is waiting on the answer.`;
  }
  return 'Dependent work cannot proceed until this is settled.';
}

export function deriveImpact(d, labels = []) {
  if (nonEmpty(d?.impactIfDelayed)) return d.impactIfDelayed;
  if (labels.includes(CEO_TRIGGER_LABELS.technical_architecture)) {
    return 'Technical architecture cannot be finalized; rework risk compounds.';
  }
  if (labels.includes(CEO_TRIGGER_LABELS.opportunity_above_value)) {
    return 'The opportunity may cool or be lost to a competitor.';
  }
  if (labels.some((l) => /client/i.test(l))) {
    return 'Client relationship and delivery timeline are at risk.';
  }
  return 'Downstream work stalls and the deadline slips.';
}

/** Split a decision's free-text options into lettered lines: `A. …`, `B. …`. */
export function parseOptions(options) {
  return String(options || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line, i) => (/^[a-z0-9][.)]/i.test(line) ? line : `${String.fromCharCode(65 + i)}. ${line}`));
}

// ═══════════════════════════════════════════════════════════════════
// §19–§21 OPS AGENT SHAPES
// ═══════════════════════════════════════════════════════════════════

/** Chip tone for a §21 health rating. */
export function healthTone(status) {
  if (/red/i.test(status || '')) return 'danger';
  if (/yellow/i.test(status || '')) return 'warning';
  if (/green/i.test(status || '')) return 'success';
  return 'neutral';
}

/** Chip tone for a §20 exception group, by how loudly it should read. */
const EXCEPTION_TONES = {
  overdue_task: 'danger',
  blocked_work: 'danger',
  overdue_invoice: 'danger',
  decision_deadline_approaching: 'danger',
  risk_needs_review: 'warning',
  upcoming_milestone: 'primary',
  missing_owner: 'warning',
  missing_deadline: 'warning',
  missing_next_action: 'warning',
  stale_project: 'warning',
  opportunity_no_followup: 'warning',
};
export function exceptionTone(kind) {
  return EXCEPTION_TONES[kind] || 'neutral';
}

/**
 * §18 panel routing. The Operations Monitor emits one flat list of exception
 * kinds; the Operations Command Center splits them across two of its four
 * panels — open operational loops vs. record hygiene. Every kind belongs to
 * exactly one panel, so nothing is shown twice and nothing is dropped.
 */
export const ATTENTION_KINDS = [
  'overdue_task',
  'blocked_work',
  'missing_owner',
  'overdue_invoice',
  'decision_deadline_approaching',
  'risk_needs_review',
  'upcoming_milestone',
];
export const QUALITY_KINDS = [
  'missing_deadline',
  'missing_next_action',
  'stale_project',
  'opportunity_no_followup',
];

/** Partition an ExceptionReport's groups into the two panels. */
export function splitExceptionGroups(report) {
  const groups = Array.isArray(report?.groups) ? report.groups : [];
  const attention = [];
  const quality = [];
  const other = [];
  for (const g of groups) {
    if (ATTENTION_KINDS.includes(g.kind)) attention.push(g);
    else if (QUALITY_KINDS.includes(g.kind)) quality.push(g);
    // A kind added to the agent after this file was written must not vanish —
    // it falls through to Needs Attention rather than being silently dropped.
    else other.push(g);
  }
  return { attention: [...attention, ...other], quality };
}

export function groupTotal(groups) {
  return (groups || []).reduce((s, g) => s + (Number(g.count) || 0), 0);
}

/** Flatten the five §19 TODAY buckets into one count. */
export function briefingTodayCount(briefing) {
  const t = briefing?.today;
  if (!t) return 0;
  return (
    (t.ceoActions?.length || 0) +
    (t.decisionsRequired?.length || 0) +
    (t.criticalBlockers?.length || 0) +
    (t.clientMatters?.length || 0) +
    (t.upcomingDeadlines?.length || 0)
  );
}
