/**
 * Report department mapping — assigns a high-level organisational department
 * to each report kind so the UI can filter by department and report cards can
 * show a coloured department badge.
 *
 * Departments are a small closed set (operations / strategy / finance /
 * engineering / marketing) — much coarser than `kind` and different from the
 * `category` taxonomy in helpers/categorize.ts (which is oriented towards
 * content type rather than org structure).
 */

export type ReportDepartment =
  | "operations"
  | "strategy"
  | "finance"
  | "engineering"
  | "marketing";

const KIND_DEPARTMENT: Record<string, ReportDepartment> = {
  gateway_recovery: "operations",
  daily_operational: "operations",
  incident: "operations",
  workflow_brief: "strategy",
  ceo_hourly_insights: "strategy",
  daily_summary: "strategy",
  weekly_strategic: "strategy",
  credit_burn_alert: "finance",
  financial_summary: "finance",
  dev_summary: "engineering",
  content_report: "marketing",
  outreach_summary: "marketing",
};

/** Resolve the department for a given report kind. Falls back to "operations". */
export function departmentForKind(kind: string): ReportDepartment {
  return KIND_DEPARTMENT[kind] ?? "operations";
}

/** All known departments — used for UI filter chips. */
export const REPORT_DEPARTMENTS: ReportDepartment[] = [
  "operations",
  "strategy",
  "finance",
  "engineering",
  "marketing",
];

/** CSS accent colour for each department badge. */
export const DEPARTMENT_COLORS: Record<ReportDepartment, string> = {
  operations: "#60a5fa",   // blue
  strategy: "#d4af37",     // gold
  finance: "#34d399",      // emerald
  engineering: "#a78bfa",  // violet
  marketing: "#f87171",    // red-400
};
