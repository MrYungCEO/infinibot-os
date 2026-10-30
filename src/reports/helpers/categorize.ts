/**
 * Report categorization — the taxonomy every saved document is filed under.
 *
 * The foundation `reports.kind` field is the *report type* (gateway_recovery,
 * ceo_hourly_insights, ...). The mesh plan additionally wants a higher-level,
 * stable **category** so the corpus can be sliced for parity context — "give me
 * every operations doc", "every doc this agent produced", etc. `kind` is open-
 * ended and proliferates; `category` is a small closed set.
 *
 * Taxonomy (proposed here, since the mesh plan does not enumerate categories):
 *   - operations  — recovery, daily/weekly roll-ups, incidents, health
 *   - insights    — CEO/overseer analyses, opportunities, risks, wins
 *   - finance     — credit-burn, spend, budget reports
 *   - security    — security plans / audits
 *   - agent-output— ad-hoc documents a sub-agent generated as work product
 *   - research    — research write-ups, deep dives
 *   - general     — anything that does not match the above
 */

export type ReportCategory =
  | "operations"
  | "insights"
  | "finance"
  | "security"
  | "agent-output"
  | "research"
  | "general";

const KIND_CATEGORY: Record<string, ReportCategory> = {
  gateway_recovery: "operations",
  daily_summary: "operations",
  daily_operational: "operations",
  weekly_strategic: "operations",
  incident: "operations",
  ceo_hourly_insights: "insights",
  credit_burn_alert: "finance",
};

/** Inputs we can infer a category from. All optional. */
export interface CategorizeInput {
  /** Report kind (the strongest signal when it maps cleanly). */
  kind?: string | null;
  /** Source agent id/name, if a sub-agent produced this. */
  sourceAgent?: string | null;
  /** Free-text title — keyword-matched as a last resort. */
  title?: string | null;
  /** Explicit override — used verbatim when provided. */
  explicit?: string | null;
}

/**
 * Resolve a category. Precedence: explicit override → kind map → title keywords
 * → "agent-output" when an agent produced it → "general".
 */
export function categorizeReport(input: CategorizeInput): ReportCategory {
  if (input.explicit) {
    const e = input.explicit.toLowerCase().trim();
    if (isCategory(e)) return e;
  }
  const kind = (input.kind ?? "").toLowerCase();
  if (kind && KIND_CATEGORY[kind]) return KIND_CATEGORY[kind];

  const title = (input.title ?? "").toLowerCase();
  if (/\b(security|audit|pentest|vulnerab)/.test(title)) return "security";
  if (/\b(credit|spend|budget|cost|invoice|billing)/.test(title)) return "finance";
  if (/\b(research|deep dive|study|whitepaper|analysis)/.test(title)) return "research";
  if (/\b(incident|recovery|outage|postmortem|roll-?up|digest|daily|weekly)/.test(title))
    return "operations";
  if (/\b(insight|opportunit|risk|recommendation)/.test(title)) return "insights";

  if (input.sourceAgent) return "agent-output";
  return "general";
}

function isCategory(s: string): s is ReportCategory {
  return [
    "operations",
    "insights",
    "finance",
    "security",
    "agent-output",
    "research",
    "general",
  ].includes(s);
}

/** All known categories — handy for UI filter chips / `reports.meta`. */
export const REPORT_CATEGORIES: ReportCategory[] = [
  "operations",
  "insights",
  "finance",
  "security",
  "agent-output",
  "research",
  "general",
];
