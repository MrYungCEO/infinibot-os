/**
 * Report System — parity-context migration.
 *
 * The foundation `reports` table tracks the rendered artifact (PDF) but not the
 * cross-agent "parity context" the mesh plan calls for: a categorized, plain
 * markdown copy of every document so any sub-agent can read what every other
 * agent produced without parsing a PDF.
 *
 * This migration ADDs the columns that back that contract (never rename/drop the
 * foundation schema):
 *   - `category`        free-form taxonomy bucket (see helpers/categorize.ts)
 *   - `source_agent`    the agent/session that produced the document
 *   - `source_session`  the gateway session key, when known
 *   - `original_format` the source format we converted from (pdf/docx/html/...)
 *   - `markdown_path`   absolute path to the `<id>.md` parity copy on disk
 *   - `markdown_body`   the markitdown-converted markdown (the parity context)
 *
 * Idempotent (`safeAddColumn` swallows the SQLite "duplicate column name" error)
 * so it is safe to call on every boot / save regardless of which process created
 * the table first (gateway vs the separate render worker).
 */

import type Database from "better-sqlite3";

/** `[column, sqlType]` pairs added to the `reports` table. */
export const REPORT_PARITY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["category", "TEXT"],
  ["source_agent", "TEXT"],
  ["source_session", "TEXT"],
  ["original_format", "TEXT"],
  ["markdown_path", "TEXT"],
  ["markdown_body", "TEXT"],
];

/** Idempotently add the parity-context columns to the `reports` table. */
export function ensureReportParityColumns(db: Database.Database): void {
  for (const [column, type] of REPORT_PARITY_COLUMNS) {
    try {
      db.exec(`ALTER TABLE reports ADD COLUMN ${column} ${type}`);
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message ?? "")) throw err;
    }
  }
  // Category is queried by getReportContext + the /reports filter.
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_category ON reports(category)`);
  } catch {
    /* index is best-effort */
  }
}
