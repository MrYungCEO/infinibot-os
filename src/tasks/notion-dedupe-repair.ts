/**
 * One-time repair for duplicate Notion-linked kanban rows.
 *
 * Before the identity fix, the Notion → local poller created a fresh task row
 * every poll for each page in the newest-edited minute (its lookup checked
 * `notionPageId`, which `createTask` never set). Live installs accumulated
 * tens of thousands of copies of the same few pages.
 *
 * This merges every group of rows sharing one Notion page id into a single
 * row:
 *   - keeper = the richest row (most filled fields, content blocks, relation
 *     edges), ties broken by the latest `updatedAt`, then the oldest row;
 *   - empty keeper fields are filled from the most recently updated sibling;
 *   - links are re-pointed to the keeper: task content blocks, tasks'
 *     projectId / parentProjectId (for project groups), project_* side tables,
 *     object-relations edges, and entity-relations pairs;
 *   - the siblings are deleted and the partial UNIQUE index on `notionId` is
 *     created so it can't happen again.
 *
 * Always run `dryRun: true` first — it writes nothing and reports exactly what
 * would change. A real run takes `.backup()` snapshots of every database it
 * touches before writing, and does all writes per database in one transaction.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

type Table = "projects" | "tasks";

export interface DedupeGroupSummary {
  notionId: string;
  rows: number;
  keepId: string;
  title: string;
}

export interface DedupeTableReport {
  table: Table;
  rowsBefore: number;
  groups: number;
  duplicateRows: number;
  rowsAfter: number;
  topGroups: DedupeGroupSummary[];
  fieldsFilledOnKeepers: number;
  repointed: {
    contentBlocks: number;
    childTasks: number;
    childProjects: number;
    projectSideRows: number;
    objectRelations: number;
    entityRelations: number;
  };
  /** Relation edges that pointed at a duplicate row (before the repair). */
  edgesOnDuplicateRows: number;
  /** Edges dropped because the keeper already had the identical edge. */
  duplicateEdgesMerged: number;
  uniqueIndex: "created" | "already" | "would-create" | "failed";
}

export interface DedupeReport {
  dryRun: boolean;
  stateDir: string;
  startedAt: string;
  durationMs: number;
  backupDir: string | null;
  tables: DedupeTableReport[];
}

/** Score a row: filled columns + attached content + relation edges. */
function richness(row: Record<string, unknown>, extra: number): number {
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k === "createdAt" || k === "updatedAt" || k === "rank") continue;
    if (v === null || v === undefined || v === "" || v === "[]" || v === "{}") continue;
    n++;
  }
  return n + extra;
}

function openIfExists(file: string): Database.Database | null {
  if (!fs.existsSync(file)) return null;
  const db = new Database(file);
  db.pragma("busy_timeout = 15000");
  return db;
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

const PROJECT_SIDE_TABLES = [
  "project_notes",
  "project_attachments",
  "project_badges",
  "project_meta",
  "project_content_blocks",
  "project_phases",
];

const normId = (s: string): string => s.replace(/-/g, "").toLowerCase();

export async function repairNotionDuplicates(opts: {
  stateDir: string;
  dryRun: boolean;
  /** Where backups go (default `<stateDir>/backups/notion-dedupe-<ts>`). */
  backupDir?: string;
  topN?: number;
}): Promise<DedupeReport> {
  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kanbanPath = path.join(opts.stateDir, "kanban.db");
  const kanban = openIfExists(kanbanPath);
  const report: DedupeReport = {
    dryRun: opts.dryRun,
    stateDir: opts.stateDir,
    startedAt: new Date(t0).toISOString(),
    durationMs: 0,
    backupDir: null,
    tables: [],
  };
  if (!kanban) {
    report.durationMs = Date.now() - t0;
    return report;
  }
  const objRel = openIfExists(path.join(opts.stateDir, "object-relations.db"));
  const entRel = openIfExists(path.join(opts.stateDir, "relations.db"));

  try {
    if (!opts.dryRun) {
      const dir = opts.backupDir ?? path.join(opts.stateDir, "backups", `notion-dedupe-${stamp}`);
      fs.mkdirSync(dir, { recursive: true });
      await kanban.backup(path.join(dir, "kanban.db"));
      if (objRel) await objRel.backup(path.join(dir, "object-relations.db"));
      if (entRel) await entRel.backup(path.join(dir, "relations.db"));
      report.backupDir = dir;
    }

    for (const table of ["projects", "tasks"] as const) {
      if (!hasTable(kanban, table)) continue;
      const cols = columnsOf(kanban, table);
      if (!cols.includes("notionId")) continue;
      const rowsBefore = (kanban.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number })
        .n;
      const tr: DedupeTableReport = {
        table,
        rowsBefore,
        groups: 0,
        duplicateRows: 0,
        rowsAfter: rowsBefore,
        topGroups: [],
        fieldsFilledOnKeepers: 0,
        repointed: {
          contentBlocks: 0,
          childTasks: 0,
          childProjects: 0,
          projectSideRows: 0,
          objectRelations: 0,
          entityRelations: 0,
        },
        edgesOnDuplicateRows: 0,
        duplicateEdgesMerged: 0,
        uniqueIndex: "already",
      };

      // Group by normalized Notion id (hyphenated and bare forms collapse).
      const linked = kanban
        .prepare(
          `SELECT id, notionId, updatedAt, createdAt FROM ${table}
           WHERE notionId IS NOT NULL AND notionId != ''`,
        )
        .all() as Array<{ id: string; notionId: string; updatedAt: number; createdAt: number }>;
      const groups = new Map<string, string[]>();
      for (const r of linked) {
        const k = normId(r.notionId);
        const g = groups.get(k);
        if (g) g.push(r.id);
        else groups.set(k, [r.id]);
      }
      const dupGroups = [...groups.entries()].filter(([, ids]) => ids.length > 1);
      tr.groups = dupGroups.length;

      // Relation edge counts per id, used for richness (a row someone linked
      // to is worth keeping).
      const relType = table === "tasks" ? "task" : "project";
      const edgeCount = (id: string): number => {
        let n = 0;
        if (objRel && hasTable(objRel, "object_relations")) {
          n += (
            objRel
              .prepare(
                `SELECT COUNT(*) n FROM object_relations WHERE (from_type=? AND from_id=?) OR (to_type=? AND to_id=?)`,
              )
              .get(relType, id, relType, id) as { n: number }
          ).n;
        }
        if (entRel && hasTable(entRel, "entity_relations")) {
          n += (
            entRel
              .prepare(
                `SELECT COUNT(*) n FROM entity_relations WHERE (a_type=? AND a_id=?) OR (b_type=? AND b_id=?)`,
              )
              .get(relType, id, relType, id) as { n: number }
          ).n;
        }
        return n;
      };
      const blocksTable = table === "tasks" ? "task_content_blocks" : "project_content_blocks";
      const blockKey = table === "tasks" ? "taskId" : "projectId";
      const hasBlocks = hasTable(kanban, blocksTable);
      const getRow = kanban.prepare(`SELECT * FROM ${table} WHERE id = ?`);
      const blockRow = hasBlocks
        ? kanban.prepare(`SELECT blocks, updatedAt FROM ${blocksTable} WHERE ${blockKey} = ?`)
        : null;

      interface Plan {
        notionId: string;
        keepId: string;
        dropIds: string[];
        fill: Record<string, unknown>;
        title: string;
      }
      const plans: Plan[] = [];
      for (const [notionKey, ids] of dupGroups) {
        const rows = ids.map((id) => getRow.get(id) as Record<string, any>);
        const scored = rows.map((r) => {
          const blk = blockRow?.get(r.id) as { blocks?: string } | undefined;
          const hasContent = !!blk && !!blk.blocks && blk.blocks !== "[]";
          return {
            r,
            score: richness(r, (hasContent ? 5 : 0) + edgeCount(r.id) * 10),
          };
        });
        scored.sort(
          (a, b) =>
            b.score - a.score ||
            (Number(b.r.updatedAt) || 0) - (Number(a.r.updatedAt) || 0) ||
            (Number(a.r.createdAt) || 0) - (Number(b.r.createdAt) || 0) ||
            String(a.r.id).localeCompare(String(b.r.id)),
        );
        const keep = scored[0]!.r;
        const others = scored.slice(1).map((s) => s.r);
        // Fill keeper's empty columns from the most recently updated sibling.
        const byRecent = [...others].sort(
          (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0),
        );
        const fill: Record<string, unknown> = {};
        for (const c of cols) {
          if (["id", "createdAt", "updatedAt", "rank", "notionId"].includes(c)) continue;
          const v = keep[c];
          if (v !== null && v !== undefined && v !== "") continue;
          const donor = byRecent.find((o) => o[c] !== null && o[c] !== undefined && o[c] !== "");
          if (donor) fill[c] = donor[c];
        }
        plans.push({
          notionId: notionKey,
          keepId: String(keep.id),
          dropIds: others.map((o) => String(o.id)),
          fill,
          title: String(keep.title ?? keep.name ?? ""),
        });
        tr.duplicateRows += others.length;
        tr.fieldsFilledOnKeepers += Object.keys(fill).length;
      }
      tr.topGroups = [...plans]
        .sort((a, b) => b.dropIds.length - a.dropIds.length)
        .slice(0, opts.topN ?? 10)
        .map((p) => ({
          notionId: p.notionId,
          rows: p.dropIds.length + 1,
          keepId: p.keepId,
          title: p.title,
        }));
      tr.rowsAfter = rowsBefore - tr.duplicateRows;

      // Count what would be re-pointed (dry run) / re-point it (real run).
      const dropToKeep = new Map<string, string>();
      for (const p of plans) for (const d of p.dropIds) dropToKeep.set(d, p.keepId);

      const countIn = (
        db: Database.Database,
        sql: string,
        ids: string[],
        extra: unknown[] = [],
      ): number => {
        let n = 0;
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          const ph = chunk.map(() => "?").join(",");
          n += (db.prepare(sql.replace(/__IDS__/g, ph)).get(...extra, ...chunk) as { n: number }).n;
        }
        return n;
      };
      const dropIds = [...dropToKeep.keys()];
      if (objRel && hasTable(objRel, "object_relations")) {
        tr.edgesOnDuplicateRows +=
          countIn(
            objRel,
            `SELECT COUNT(*) n FROM object_relations WHERE from_type=? AND from_id IN (__IDS__)`,
            dropIds,
            [relType],
          ) +
          countIn(
            objRel,
            `SELECT COUNT(*) n FROM object_relations WHERE to_type=? AND to_id IN (__IDS__)`,
            dropIds,
            [relType],
          );
      }
      if (entRel && hasTable(entRel, "entity_relations")) {
        tr.edgesOnDuplicateRows +=
          countIn(
            entRel,
            `SELECT COUNT(*) n FROM entity_relations WHERE a_type=? AND a_id IN (__IDS__)`,
            dropIds,
            [relType],
          ) +
          countIn(
            entRel,
            `SELECT COUNT(*) n FROM entity_relations WHERE b_type=? AND b_id IN (__IDS__)`,
            dropIds,
            [relType],
          );
      }

      if (opts.dryRun) {
        if (hasBlocks)
          tr.repointed.contentBlocks = countIn(
            kanban,
            `SELECT COUNT(*) n FROM ${blocksTable} WHERE ${blockKey} IN (__IDS__)`,
            dropIds,
          );
        if (table === "projects") {
          tr.repointed.childTasks = countIn(
            kanban,
            `SELECT COUNT(*) n FROM tasks WHERE projectId IN (__IDS__)`,
            dropIds,
          );
          tr.repointed.childProjects = countIn(
            kanban,
            `SELECT COUNT(*) n FROM projects WHERE parentProjectId IN (__IDS__)`,
            dropIds,
          );
          for (const side of PROJECT_SIDE_TABLES) {
            if (!hasTable(kanban, side) || side === "project_content_blocks") continue;
            tr.repointed.projectSideRows += countIn(
              kanban,
              `SELECT COUNT(*) n FROM ${side} WHERE projectId IN (__IDS__)`,
              dropIds,
            );
          }
        }
        tr.uniqueIndex = tr.groups > 0 ? "would-create" : "already";
        report.tables.push(tr);
        continue;
      }

      // ── Real run ────────────────────────────────────────────────────
      kanban.transaction(() => {
        const updCols = (fill: Record<string, unknown>) => Object.keys(fill);
        for (const p of plans) {
          const keys = updCols(p.fill);
          if (keys.length > 0) {
            kanban
              .prepare(
                `UPDATE ${table} SET ${keys.map((k) => `"${k}" = ?`).join(", ")} WHERE id = ?`,
              )
              .run(...keys.map((k) => p.fill[k] as never), p.keepId);
          }
          if (hasBlocks) {
            const keepHas = blockRow!.get(p.keepId) as { blocks?: string } | undefined;
            if (!keepHas || !keepHas.blocks || keepHas.blocks === "[]") {
              // Adopt the most recently updated sibling's content.
              const donors = p.dropIds
                .map((id) => ({
                  id,
                  b: blockRow!.get(id) as { blocks?: string; updatedAt?: number },
                }))
                .filter((d) => d.b && d.b.blocks && d.b.blocks !== "[]")
                .sort((a, b) => (Number(b.b.updatedAt) || 0) - (Number(a.b.updatedAt) || 0));
              if (donors[0]) {
                kanban.prepare(`DELETE FROM ${blocksTable} WHERE ${blockKey} = ?`).run(p.keepId);
                kanban
                  .prepare(`UPDATE ${blocksTable} SET ${blockKey} = ? WHERE ${blockKey} = ?`)
                  .run(p.keepId, donors[0].id);
                tr.repointed.contentBlocks++;
              }
            }
          }
        }
        if (table === "projects") {
          const updTask = kanban.prepare(`UPDATE tasks SET projectId = ? WHERE projectId = ?`);
          const updParent = kanban.prepare(
            `UPDATE projects SET parentProjectId = ? WHERE parentProjectId = ?`,
          );
          for (const [drop, keep] of dropToKeep) {
            tr.repointed.childTasks += updTask.run(keep, drop).changes;
            tr.repointed.childProjects += updParent.run(keep, drop).changes;
            for (const side of PROJECT_SIDE_TABLES) {
              if (!hasTable(kanban, side) || side === "project_content_blocks") continue;
              tr.repointed.projectSideRows += kanban
                .prepare(`UPDATE OR IGNORE ${side} SET projectId = ? WHERE projectId = ?`)
                .run(keep, drop).changes;
            }
          }
        }
        for (let i = 0; i < dropIds.length; i += 500) {
          const chunk = dropIds.slice(i, i + 500);
          const ph = chunk.map(() => "?").join(",");
          if (hasBlocks)
            kanban.prepare(`DELETE FROM ${blocksTable} WHERE ${blockKey} IN (${ph})`).run(...chunk);
          if (table === "projects") {
            for (const side of PROJECT_SIDE_TABLES) {
              if (!hasTable(kanban, side) || side === "project_content_blocks") continue;
              kanban.prepare(`DELETE FROM ${side} WHERE projectId IN (${ph})`).run(...chunk);
            }
          }
          kanban.prepare(`DELETE FROM ${table} WHERE id IN (${ph})`).run(...chunk);
        }
      })();

      if (objRel && hasTable(objRel, "object_relations")) {
        objRel.transaction(() => {
          const upFrom = objRel.prepare(
            `UPDATE OR IGNORE object_relations SET from_id = ? WHERE from_type = ? AND from_id = ?`,
          );
          const upTo = objRel.prepare(
            `UPDATE OR IGNORE object_relations SET to_id = ? WHERE to_type = ? AND to_id = ?`,
          );
          const delLeft = objRel.prepare(
            `DELETE FROM object_relations WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)`,
          );
          for (const [drop, keep] of dropToKeep) {
            tr.repointed.objectRelations += upFrom.run(keep, relType, drop).changes;
            tr.repointed.objectRelations += upTo.run(keep, relType, drop).changes;
            // Whatever is left already existed on the keeper — a duplicate edge.
            tr.duplicateEdgesMerged += delLeft.run(relType, drop, relType, drop).changes;
          }
        })();
      }
      if (entRel && hasTable(entRel, "entity_relations")) {
        entRel.transaction(() => {
          const upA = entRel.prepare(
            `UPDATE OR IGNORE entity_relations SET a_id = ? WHERE a_type = ? AND a_id = ?`,
          );
          const upB = entRel.prepare(
            `UPDATE OR IGNORE entity_relations SET b_id = ? WHERE b_type = ? AND b_id = ?`,
          );
          const delLeft = entRel.prepare(
            `DELETE FROM entity_relations WHERE (a_type = ? AND a_id = ?) OR (b_type = ? AND b_id = ?)`,
          );
          for (const [drop, keep] of dropToKeep) {
            tr.repointed.entityRelations += upA.run(keep, relType, drop).changes;
            tr.repointed.entityRelations += upB.run(keep, relType, drop).changes;
            tr.duplicateEdgesMerged += delLeft.run(relType, drop, relType, drop).changes;
          }
        })();
      }

      try {
        const existed = !!kanban
          .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
          .get(`idx_${table}_notion_unique`);
        kanban.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_notion_unique ON ${table}(notionId) WHERE notionId IS NOT NULL AND notionId != ''`,
        );
        tr.uniqueIndex = existed ? "already" : "created";
      } catch {
        // Hyphenated vs bare forms of one id are distinct strings to SQLite but
        // were merged above, so this only fails if rows were written meanwhile.
        tr.uniqueIndex = "failed";
      }
      tr.rowsAfter = (kanban.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
      report.tables.push(tr);
    }
  } finally {
    kanban.close();
    objRel?.close();
    entRel?.close();
  }
  report.durationMs = Date.now() - t0;
  return report;
}
