/**
 * Where the Discipline plugin keeps its data, and the one-time move from the
 * pre-plugin core locations.
 *
 *   <stateDir>/plugin-data/discipline/
 *     discipline.db            time blocks, logs, completions, templates, events
 *     discipline-notion.json   Notion sync settings
 *     focus.json               Focus board (server copy)
 *
 * Before the plugin, core wrote `<stateDir>/discipline.db` (+ -wal/-shm),
 * `<stateDir>/discipline-notion.json`, and `focus.json` in
 * `$INFINIBOT_STATE_DIR` or a cwd-relative `state/` dir. `migrateLegacyData`
 * moves them in once: it is idempotent (never overwrites a file that already
 * exists in the plugin dir), leaves a breadcrumb where each file used to be,
 * and never deletes anything. Disabling the plugin never touches this dir.
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export const PLUGIN_ID = "discipline";

export function disciplineDataDir(stateDir: string): string {
  return path.join(stateDir, "plugin-data", PLUGIN_ID);
}

/** Legacy focus.json locations, most specific first. */
export function legacyFocusPaths(stateDir: string): string[] {
  const out = [path.join(stateDir, "focus.json")];
  const envDir = process.env.INFINIBOT_STATE_DIR?.trim();
  out.push(path.resolve(envDir || "state", "focus.json"));
  return [...new Set(out)];
}

export type MigrationLog = { info: (m: string) => void; warn: (m: string) => void };

export type MigrationResult = { moved: string[]; skipped: string[] };

const BREADCRUMB_SUFFIX = ".moved-to-plugin-data";

function breadcrumb(from: string, to: string): void {
  try {
    fs.writeFileSync(
      `${from}${BREADCRUMB_SUFFIX}`,
      `Moved by the Discipline plugin on ${new Date().toISOString()}\n-> ${to}\n`,
      "utf-8",
    );
  } catch {
    /* breadcrumb is best-effort */
  }
}

/** Flush the WAL into the main file so a single-file move is complete. */
function checkpointSqlite(file: string): void {
  const db = new Database(file);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // Cross-device (EXDEV) or similar: copy, then keep the original.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    return;
  }
}

/**
 * Move pre-plugin data into the plugin dir. Safe to call on every start and
 * from several places; cheap when there is nothing to do.
 */
export function migrateLegacyData(stateDir: string, log?: MigrationLog): MigrationResult {
  const result: MigrationResult = { moved: [], skipped: [] };
  const dir = disciplineDataDir(stateDir);

  const legacyDb = path.join(stateDir, "discipline.db");
  const nextDb = path.join(dir, "discipline.db");
  if (fs.existsSync(legacyDb)) {
    if (fs.existsSync(nextDb)) {
      result.skipped.push(legacyDb);
    } else {
      try {
        fs.mkdirSync(dir, { recursive: true });
        checkpointSqlite(legacyDb);
        moveFile(legacyDb, nextDb);
        // After a TRUNCATE checkpoint the side files are empty; drop them so a
        // stale -wal can never be replayed onto the wrong database.
        for (const side of ["-wal", "-shm"]) {
          const f = `${legacyDb}${side}`;
          if (fs.existsSync(f) && fs.statSync(f).size === 0) fs.rmSync(f);
        }
        breadcrumb(legacyDb, nextDb);
        result.moved.push(legacyDb);
      } catch (err) {
        log?.warn(`discipline: could not move ${legacyDb}: ${String(err)}`);
      }
    }
  }

  const plainFiles: Array<[string, string]> = [
    [path.join(stateDir, "discipline-notion.json"), path.join(dir, "discipline-notion.json")],
  ];
  const nextFocus = path.join(dir, "focus.json");
  const legacyFocus = legacyFocusPaths(stateDir).find((p) => fs.existsSync(p));
  if (legacyFocus) plainFiles.push([legacyFocus, nextFocus]);

  for (const [from, to] of plainFiles) {
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) {
      result.skipped.push(from);
      continue;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      moveFile(from, to);
      breadcrumb(from, to);
      result.moved.push(from);
    } catch (err) {
      log?.warn(`discipline: could not move ${from}: ${String(err)}`);
    }
  }

  if (result.moved.length) {
    log?.info(`discipline: moved ${result.moved.length} legacy file(s) into ${dir}`);
  }
  return result;
}
