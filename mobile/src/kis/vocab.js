/**
 * KIS Phase 1 shared vocabulary — mobile mirror of the gateway's enums.
 *
 * Every value here is transcribed from the authoritative TypeScript source so
 * the mobile pickers offer exactly what the store accepts:
 *
 *   src/opportunity/types.ts   src/product/types.ts   src/decision/types.ts
 *   src/risk/types.ts          src/commitment/types.ts src/person/types.ts
 *   src/business-objects/common.ts (§25 fields, §26 priority, §35 data quality,
 *                                   §32 authority levels)
 *   src/relations/types.ts     (typed edges + the ten object types)
 *
 * Rules this file obeys (mobile/design-system/MASTER.md):
 *   · No colors. Tone names only — the caller resolves them through
 *     `toneColor(tone, colors)` so a re-palette follows.
 *   · Status/priority tone mapping is NOT duplicated here. `StatusChip` and
 *     `PriorityChip` own it (MASTER §9: "add to STATUS_TONES in Chip.js rather
 *     than branching at the call site").
 *
 * The one thing this file DOES map to a tone is the risk P×I band, because
 * that is a computed numeric band rather than a status string.
 */

// ── §26 Priority ────────────────────────────────────────────────────
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

// ── §35 Data quality — an estimate must never look like a fact ──────
export const DATA_QUALITIES = ['Verified', 'FounderReported', 'OperationsEstimated', 'Unknown'];

/** §35 labels: the stored value is PascalCase; humans read two words. */
export const DATA_QUALITY_LABELS = {
  Verified: 'Verified',
  FounderReported: 'Founder reported',
  OperationsEstimated: 'Ops estimated',
  Unknown: 'Unknown',
};

// ── §32 Authority levels ────────────────────────────────────────────
export const AUTHORITY_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
export const AUTHORITY_LEVEL_LABELS = {
  L0: 'Observe',
  L1: 'Recommend',
  L2: 'Prepare',
  L3: 'Execute With Approval',
  L4: 'Execute Within Policy',
  L5: 'Autonomous Exception Management',
};

// ── Object 2 · Opportunity ──────────────────────────────────────────
export const OPPORTUNITY_TYPES = [
  'New Client',
  'Expansion',
  'Partnership',
  'Pilot',
  'Licensing',
  'Custom Build',
  'Other',
];

/** Board column order: New → … → Negotiation, then the terminal three. */
export const PIPELINE_STAGES = [
  'New',
  'Qualification',
  'Discovery',
  'Evaluation',
  'Proposal',
  'Negotiation',
  'Won',
  'Lost',
  'Hold',
];

/** No further pipeline movement is expected from these. */
export const TERMINAL_STAGES = ['Won', 'Lost', 'Hold'];

export const REVENUE_TYPES = ['One-Time', 'Recurring', 'Hybrid'];

// ── Object 5 · Product (the KIS registry, NOT the /products catalog) ─
export const PRODUCT_TYPES = [
  'Core Platform',
  'Module',
  'Vertical Product',
  'Client Configuration',
  'Digital Product',
  'Service Offer',
  'Experimental Product',
];

export const PRODUCT_STATUSES = ['Active', 'Development', 'Hold', 'Retired'];

/** Independent of `status` — "Built ≠ Product". */
export const VALIDATION_STAGES = [
  'Idea',
  'Prototype',
  'Proof of Concept',
  'Pilot',
  'Paying Customer',
  'Repeat Sales',
  'Scaled',
  'Retired',
];

export const REVENUE_MODELS = ['Project Fee', 'Subscription', 'License', 'Usage', 'Hybrid'];

/**
 * Fraction of the validation ladder a product has climbed (0..1), for a
 * determinate ProgressBar. 'Retired' is the end of the list but not progress,
 * so it reports null (indeterminate is wrong too — it reports 0 with a label).
 */
export function validationProgress(stage) {
  const idx = VALIDATION_STAGES.indexOf(String(stage));
  if (idx < 0) return null;
  if (String(stage) === 'Retired') return 0;
  // 'Scaled' is index 6 of 8 entries; the ladder proper is Idea..Scaled.
  const ladder = VALIDATION_STAGES.length - 2; // exclude 'Retired'
  return Math.min(1, (idx + 1) / (ladder + 1));
}

// ── Object 6 · Decision ─────────────────────────────────────────────
export const DECISION_TYPES = [
  'Technical',
  'Product',
  'Strategic',
  'Financial',
  'Client',
  'Pricing',
  'Partnership',
  'Operational',
  'Legal',
  'Resource',
];

export const DECISION_STATUSES = [
  'Preparing',
  'Ready for Decision',
  'CEO Review',
  'Decided',
  'Deferred',
  'Cancelled',
];

/** The two statuses that place a decision on the CEO Queue. */
export const CEO_QUEUE_STATUSES = ['Ready for Decision', 'CEO Review'];

/** Grouping order for the queue: what needs the CEO first, terminal last. */
export const DECISION_STATUS_ORDER = [
  'Ready for Decision',
  'CEO Review',
  'Preparing',
  'Deferred',
  'Decided',
  'Cancelled',
];

// ── Object 7 · Risk ─────────────────────────────────────────────────
export const RISK_CATEGORIES = [
  'Financial',
  'Technical',
  'Delivery',
  'Client',
  'Security',
  'Privacy',
  'Legal',
  'Compliance',
  'IP',
  'Capacity',
  'Vendor',
  'Reputational',
  'Founder Dependency',
];

export const RISK_STATUSES = ['Open', 'Monitoring', 'Mitigated', 'Closed'];

export const RISK_MATRIX_MIN = 1;
export const RISK_MATRIX_MAX = 5;

/** Score at/above which a risk is critical (3-day review cadence, §29). */
export const CRITICAL_RISK_SCORE = 12;

/** Clamp a probability/impact entry into the 1–5 matrix. */
export function clampMatrix(v) {
  const n = Math.round(Number(v ?? RISK_MATRIX_MIN));
  if (!Number.isFinite(n)) return RISK_MATRIX_MIN;
  return Math.min(RISK_MATRIX_MAX, Math.max(RISK_MATRIX_MIN, n));
}

/** Risk Score = Probability × Impact, always 1–25. Computed, never entered. */
export function computeRiskScore(probability, impact) {
  return clampMatrix(probability) * clampMatrix(impact);
}

/** Named severity band for a 1–25 score. Mirrors riskBand() in src/risk/types.ts. */
export function riskBand(score) {
  const n = Number(score) || 0;
  if (n >= CRITICAL_RISK_SCORE) return 'Critical';
  if (n >= 8) return 'High';
  if (n >= 4) return 'Medium';
  return 'Low';
}

/**
 * Tone for a computed risk band. This is the one tone mapping that belongs
 * here rather than in Chip.js — the input is a number, not a status string.
 */
export function riskBandTone(score) {
  switch (riskBand(score)) {
    case 'Critical':
      return 'danger';
    case 'High':
      return 'warning';
    case 'Medium':
      return 'info';
    default:
      return 'neutral';
  }
}

// ── Object 8 · Financial Commitment ─────────────────────────────────
export const COMMITMENT_TYPES = [
  'Client Invoice',
  'Deposit',
  'Milestone Payment',
  'Recurring Revenue',
  'Contractor Payment',
  'Vendor Commitment',
  'Project Expense',
];

export const COMMITMENT_DIRECTIONS = ['Money In', 'Money Out'];

export const COMMITMENT_STATUSES = [
  'Expected',
  'Invoiced',
  'Partially Paid',
  'Paid',
  'Overdue',
  'Cancelled',
];

/** Everything else is money out. */
export const MONEY_IN_TYPES = [
  'Client Invoice',
  'Deposit',
  'Milestone Payment',
  'Recurring Revenue',
];

export const isMoneyIn = (c) => String(c?.direction) === 'Money In';

// ── Object 9 · Person / Resource ────────────────────────────────────
export const PERSON_RELATIONSHIP_TYPES = ['Founder', 'Employee', 'Contractor', 'Partner'];
export const PERSON_STATUSES = ['Active', 'Inactive', 'Onboarding'];
export const PERSON_ACCESS_LEVELS = ['Owner', 'Admin', 'Standard', 'Restricted', 'None'];

// ── The relation graph (src/relations/types.ts) ─────────────────────
export const OBJECT_TYPES = [
  'client',
  'opportunity',
  'project',
  'task',
  'product',
  'decision',
  'risk',
  'commitment',
  'person',
  'issue',
];

export const OBJECT_TYPE_LABEL = {
  client: 'Client',
  opportunity: 'Opportunity',
  project: 'Project',
  task: 'Task',
  product: 'Product',
  decision: 'Decision',
  risk: 'Risk',
  commitment: 'Commitment',
  person: 'Person',
  issue: 'Issue',
};

/** Ionicons name per object type — SVG icons only, never emoji (MASTER §4). */
export const OBJECT_TYPE_ICON = {
  client: 'business-outline',
  opportunity: 'trending-up-outline',
  project: 'layers-outline',
  task: 'checkbox-outline',
  product: 'cube-outline',
  decision: 'git-compare-outline',
  risk: 'warning-outline',
  commitment: 'cash-outline',
  person: 'person-outline',
  issue: 'bug-outline',
};

/** Verb phrase for each typed edge, read left-to-right from `from` to `to`. */
export const RELATION_EDGE_LABEL = {
  client_has_opportunity: 'has opportunity',
  opportunity_becomes_project: 'becomes project',
  project_has_task: 'has task',
  project_delivers_product: 'delivers product',
  product_offered_in_opportunity: 'offered in',
  decision_guides_task: 'guides',
  risk_impacts_task: 'impacts',
  commitment_funds_project: 'funds',
  task_assigned_to_person: 'assigned to',
  issue_relates_task: 'relates to',
  relates_to: 'relates to',
};

export const objectTypeLabel = (t) => OBJECT_TYPE_LABEL[t] || String(t || 'Object');
export const objectTypeIcon = (t) => OBJECT_TYPE_ICON[t] || 'ellipse-outline';
export const relationEdgeLabel = (e) =>
  RELATION_EDGE_LABEL[e] || String(e || '').replace(/_/g, ' ') || 'relates to';

// ── Formatters ──────────────────────────────────────────────────────

/**
 * Compact currency. Mirrors fmtMoney() in the web views so the two surfaces
 * read the same: $1.5k, $12k, $840. Always monospaced at the call site.
 */
export function formatMoney(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

/** Truncate a uuid-ish id for a mono chip. */
export function shortId(id) {
  const s = String(id || '');
  if (!s) return '?';
  return s.length > 10 ? `${s.slice(0, 8)}…` : s;
}

/** ISO date (YYYY-MM-DD) → short local label. Returns '' for empty input. */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Unix ms → relative age, for `lastUpdated` staleness (§29). */
export function formatAge(ms) {
  const t = Number(ms) || 0;
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** True when an ISO date is strictly in the past (dueDate / nextActionDate). */
export function isPastDue(iso) {
  if (!iso) return false;
  const d = new Date(String(iso).length <= 10 ? `${iso}T23:59:59` : iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

export default {
  PRIORITIES,
  DATA_QUALITIES,
  AUTHORITY_LEVELS,
  PIPELINE_STAGES,
  VALIDATION_STAGES,
  DECISION_STATUSES,
  RISK_CATEGORIES,
  COMMITMENT_STATUSES,
  PERSON_STATUSES,
  OBJECT_TYPES,
};
