/**
 * Report System — association columns migration.
 *
 * The foundation `reports` table ships with a single generic `source_record_id`
 * FK. Backfilling ad-hoc PDFs (and, going forward, any externally-rendered PDF
 * ingested through {@link ../helpers/external-pdf.ts}) needs to link a report to
 * the concrete things that produced it: the originating project, kanban task,
 * spawn run, and — for reports that were also pushed to Telegram out-of-band —
 * the Telegram message id(s).
 *
 * We ADD these as dedicated nullable columns (never rename/drop the foundation
 * schema). The migration is idempotent (`safeAddColumn` swallows the SQLite
 * "duplicate column name" error) so it is safe to call on every boot / ingest
 * regardless of which process created the table first.
 *
 * NOTE: the foundation store's `rowToReport` does not (yet) map these columns
 * onto the wire record, so `reports.list` / `reports.get` will not surface them
 * until the foundation store opts in. We therefore ALSO mirror the associations
 * into each report's `config_json` (see the helper) so the `reports.get` payload
 * — which returns the full record including `config` — can render them today
 * without touching foundation files. The dedicated columns give a normalized,
 * queryable home for the same data. See
 * `docs/plans/report-system-followups.md`.
 */

import type Database from "better-sqlite3";

/** `[column, sqlType]` pairs added to the `reports` table. */
export const REPORT_ASSOCIATION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["source_project_id", "TEXT"],
  ["source_kanban_task_id", "TEXT"],
  ["source_run_id", "TEXT"],
  ["source_telegram_message_id", "TEXT"],
];

/** Idempotently add the association columns to the `reports` table. */
export function ensureReportAssociationColumns(db: Database.Database): void {
  for (const [column, type] of REPORT_ASSOCIATION_COLUMNS) {
    try {
      db.exec(`ALTER TABLE reports ADD COLUMN ${column} ${type}`);
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message ?? "")) throw err;
    }
  }
}
