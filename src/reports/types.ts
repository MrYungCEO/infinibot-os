/**
 * Report System — shared types.
 *
 * The report system generates stylized PDF reports on a schedule, on demand,
 * or triggered by system events (gateway crash/recovery, incidents, etc).
 * Rows live in `~/.infinibot/databases.db` (see {@link ./store.ts}); rendering
 * happens in a separate worker process (see {@link ./worker/index.ts}) so a
 * puppeteer/render crash can never destabilize the gateway.
 *
 * This module is dependency-free (pure types + small const unions) so both the
 * gateway and the standalone worker can import it without pulling in heavy
 * runtime modules.
 */

/** Lifecycle of a single report row. */
export type ReportStatus = "queued" | "rendering" | "ready" | "failed" | "sent";

/** What caused a report to be enqueued. */
export type ReportTrigger = "manual" | "cron" | "event";

/** Where a rendered report fans out to. `ui` = saved to file_path (always). */
export type ReportSink = "ui" | "telegram" | "email";

/**
 * Report kind id. Open-ended string at the type level so future kinds can be
 * registered without editing this union, but the known/initial set is enumerated
 * for autocompletion and validation.
 */
export type ReportKind =
  | "gateway_recovery"
  | "ceo_hourly_insights"
  | "daily_summary"
  | "daily_operational"
  | "weekly_strategic"
  | "credit_burn_alert"
  | "incident"
  | (string & {});

/** A persisted report row (mirrors the `reports` table). */
export interface ReportRecord {
  id: string;
  kind: ReportKind;
  title: string;
  theme: string;
  status: ReportStatus;
  /** Optional FK into a source table (incident id, run id, etc). */
  sourceRecordId: string | null;
  trigger: ReportTrigger;
  createdAt: number;
  renderedAt: number | null;
  filePath: string | null;
  fileSize: number | null;
  summaryText: string | null;
  /** Free-form snapshot of the config/inputs used to render this report. */
  config: Record<string, unknown>;
  // ── parity-context fields (migration 0002) ──────────────────────────
  /** High-level taxonomy bucket (see helpers/categorize.ts). */
  category: string | null;
  /** Agent id/name that produced this document, if a sub-agent did. */
  sourceAgent: string | null;
  /** Gateway session key the document originated from, if known. */
  sourceSession: string | null;
  /** Source format we converted to markdown from (pdf/docx/html/...). */
  originalFormat: string | null;
  /** Absolute path to the `<id>.md` markdown parity copy on disk. */
  markdownPath: string | null;
  /** markitdown-converted markdown body — the cross-agent parity context. */
  markdownBody: string | null;
  /** Optional department/team tag for filtering (e.g. "engineering", "finance"). */
  department?: string | null;
  /** Free-form tags for filtering (stored as JSON array in config or dedicated column). */
  tags?: string[];
}

/** A persisted schedule row (mirrors the `report_schedules` table). */
export interface ReportScheduleRecord {
  id: string;
  kind: ReportKind;
  cron: string;
  theme: string;
  enabled: boolean;
  sinks: ReportSink[];
  lastRunAt: number | null;
  nextRunAt: number | null;
  config: Record<string, unknown>;
}

/** A persisted event-trigger row (mirrors the `report_triggers` table). */
export interface ReportTriggerRecord {
  id: string;
  kind: ReportKind;
  /** e.g. "gateway_crash", "kanban_milestone", "credit_threshold". */
  eventType: string;
  theme: string;
  sinks: ReportSink[];
  config: Record<string, unknown>;
  enabled: boolean;
}

/** Severity of a CEO/overseer insight row. */
export type InsightSeverity = "info" | "low" | "medium" | "high" | "critical";

/** An actionable insight row (mirrors the `report_insights` table). */
export interface ReportInsightRecord {
  id: string;
  reportId: string | null;
  kind: ReportKind;
  /** alert | opportunity | risk | win (free-form, not enforced). */
  title: string;
  body: string;
  action: string | null;
  severity: InsightSeverity;
  createdAt: number;
}

// ── Theme system ───────────────────────────────────────────────────

/** CSS token bundle for a report theme. Rendered into `:root` CSS vars. */
export interface ThemeTokens {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentStrong: string;
  fontHeading: string;
  fontBody: string;
  /** Status pill colors keyed by a status label (ok/error/running/...). */
  statusPills: Record<string, { fg: string; bg: string }>;
}

export interface Theme {
  name: string;
  label: string;
  tokens: ThemeTokens;
}

// ── Kind contract ──────────────────────────────────────────────────

/** Result of a kind's collector — the raw content + a renderable HTML doc. */
export interface CollectedReport {
  title: string;
  summaryText: string;
  /** Fully-formed standalone HTML document (theme already applied). */
  html: string;
  /** Optional insight rows the collector wants persisted alongside the PDF. */
  insights?: Array<Omit<ReportInsightRecord, "id" | "reportId" | "createdAt">>;
  /** Optional override of the source record id. */
  sourceRecordId?: string | null;
}

// ── Generic structured payload (the canonical PDF path) ────────────
//
// Every ad-hoc PDF a future agent wants to generate should build one of these
// and hand it to `renderReport()` (see ./render.ts) instead of hand-rolling
// HTML or shelling out to pandoc/wkhtmltopdf. The black-gold template
// (./template.ts) turns a payload into a standalone print-ready HTML document;
// the renderer turns that into a PDF Buffer. One shape, one renderer, one look.

/** A simple table inside a section. `rows` cells are stringified verbatim. */
export interface ReportTable {
  /** Column headers, left-to-right. */
  columns: string[];
  /** Row-major cell values; short values render best. */
  rows: Array<Array<string | number>>;
  /**
   * Zero-based column indexes whose cell values should render as a status pill
   * (matched against the theme's `statusPills`, falling back to a neutral pill).
   */
  pillColumns?: number[];
}

/** One content block in a report. At least one of body/bullets/table/code. */
export interface ReportSection {
  /** Gold section header. */
  heading: string;
  /** Optional small count badge shown beside the heading. */
  count?: number;
  /** Body text. Blank lines split paragraphs; lines beginning "- " become bullets. */
  body?: string;
  /** Explicit bullet list (rendered as a gold-marker <ul>). */
  bullets?: string[];
  /** Optional table. */
  table?: ReportTable;
  /** Optional monospace pre-formatted block (IDs, diffs, logs, commands). */
  code?: string;
}

/** A headline metric shown in the document header meta-grid. */
export interface ReportMetric {
  label: string;
  value: string | number;
}

/** The canonical structured input to `renderReport()`. */
export interface ReportPayload {
  /** Big document title. */
  title: string;
  /** One-line description under the title. */
  subtitle?: string;
  /** Small uppercase eyebrow above the title (default "InfiniBot · Report"). */
  eyebrow?: string;
  /** Unix ms the report was generated (default: render time). */
  generatedAt?: number;
  /** Headline metrics rendered in the header grid. */
  metrics?: ReportMetric[];
  /** Body sections, in order. */
  sections: ReportSection[];
  /** Right-aligned footer note (left side is always "InfiniBot Report System"). */
  footer?: string;
  /** Theme name (default "black-gold"). Unknown names fall back to black-gold. */
  theme?: string;
}

/** A report kind: knows how to gather its data and render an HTML document. */
export interface ReportKindModule {
  kind: ReportKind;
  /**
   * Gather source data and render a standalone HTML document for the given
   * theme + config snapshot. Pure with respect to the DB (the worker persists
   * the result) — collectors only read source data.
   */
  collect(args: {
    theme: Theme;
    config: Record<string, unknown>;
    stateDir: string;
  }): Promise<CollectedReport> | CollectedReport;
}
