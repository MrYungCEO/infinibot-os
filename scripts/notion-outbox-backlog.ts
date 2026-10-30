/**
 * Inspect / clear the kanban → Notion outbox backlog (rows flagged
 * `__notionSyncPending` in databases.db).
 *
 *   node --import tsx scripts/notion-outbox-backlog.ts [--state-dir DIR]
 *        [--clear-title REGEX] [--apply]
 *
 * Lists every pending row (title, status option, whether it already has a
 * Notion page). `--clear-title` selects pending rows WITHOUT a Notion page
 * whose title matches REGEX (e.g. leaked test fixtures) and clears their
 * pending flag so they are never pushed; dry run unless `--apply`, and
 * `--apply` copies databases.db to <state>/backups/ first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stateDir =
  flag("--state-dir") ?? process.env.INFINIBOT_STATE_DIR ?? path.join(os.homedir(), ".infinibot");
const clearRe = flag("--clear-title") ? new RegExp(flag("--clear-title")!) : null;
const apply = args.includes("--apply");

const file = path.join(stateDir, "databases.db");
const db = new Database(file);
db.pragma("busy_timeout = 15000");
const rows = db
  .prepare(
    `SELECT r.id, r.title, r.values_json, r.external_ref_json, d.source
       FROM database_rows r JOIN databases d ON d.id = r.database_id
      WHERE d.source IN ('kanban-projects','kanban-tasks')
        AND json_extract(r.values_json, '$.__notionSyncPending.markdown') = '1'`,
  )
  .all() as Array<{
  id: string;
  title: string;
  values_json: string;
  external_ref_json: string | null;
  source: string;
}>;

const statusOf = (valuesJson: string): string | null => {
  try {
    const v = JSON.parse(valuesJson) as Record<string, { type?: string; optionId?: string }>;
    for (const x of Object.values(v)) if (x?.type === "status") return x.optionId ?? null;
  } catch {
    /* ignore */
  }
  return null;
};

const listed = rows.map((r) => ({
  id: r.id,
  source: r.source,
  title: r.title,
  status: statusOf(r.values_json),
  hasNotionPage: !!r.external_ref_json,
}));
const toClear = clearRe ? listed.filter((r) => !r.hasNotionPage && clearRe.test(r.title)) : [];

let backup: string | null = null;
if (apply && toClear.length > 0) {
  const dir = path.join(stateDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  backup = path.join(dir, `databases.db.pre-outbox-clear-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await db.backup(backup);
  const upd = db.prepare(
    `UPDATE database_rows SET values_json = json_set(values_json, '$.__notionSyncPending.markdown', '') WHERE id = ?`,
  );
  db.transaction(() => {
    for (const r of toClear) upd.run(r.id);
  })();
}
db.close();

const byKey = new Map<string, number>();
for (const r of listed) {
  const k = `${r.source} | ${r.status ?? "-"} | ${r.title} | notionPage=${r.hasNotionPage}`;
  byKey.set(k, (byKey.get(k) ?? 0) + 1);
}
console.log(
  JSON.stringify(
    {
      stateDir,
      dryRun: !apply,
      pending: listed.length,
      groups: [...byKey.entries()].map(([k, n]) => ({ group: k, rows: n })),
      clearMatching: clearRe?.source ?? null,
      cleared: apply ? toClear.length : 0,
      wouldClear: apply ? 0 : toClear.length,
      backup,
    },
    null,
    2,
  ),
);
