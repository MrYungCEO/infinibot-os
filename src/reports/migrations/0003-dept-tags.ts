/**
 * Report System — department + tags migration.
 *
 * Adds two new columns to the `reports` table:
 *   - `department` TEXT   — high-level org department (operations, strategy, finance, …)
 *   - `tags`       TEXT   — JSON array of string tags, default '[]'
 *
 * Idempotent: swallows SQLite "duplicate column name" errors so it is safe to
 * call on every boot regardless of who created the table first.
 */

import type Database from "better-sqlite3";

export function ensureReportDeptTagsColumns(db: Database.Database): void {
  const safeAdd = (column: string, def: string) => {
    try {
      db.exec(`ALTER TABLE reports ADD COLUMN ${column} ${def}`);
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message ?? "")) throw err;
    }
  };
  safeAdd("department", "TEXT");
  safeAdd("tags", "TEXT NOT NULL DEFAULT '[]'");

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_department ON reports(department)`);
  } catch {
    /* best-effort */
  }
}
