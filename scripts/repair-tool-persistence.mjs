#!/usr/bin/env node
/**
 * scripts/repair-tool-persistence.mjs
 *
 * Idempotent repair for tool-layer persistence across notes, kanban tasks,
 * kanban projects, project_files, and the file attachment disk store.
 *
 * Usage:
 *   node scripts/repair-tool-persistence.mjs           # dry-run (report only)
 *   node scripts/repair-tool-persistence.mjs --fix     # apply all repairs
 *   node scripts/repair-tool-persistence.mjs --verbose # extra detail
 *   node scripts/repair-tool-persistence.mjs --check-notes  # notes only
 *   node scripts/repair-tool-persistence.mjs --check-kanban # kanban only
 *   node scripts/repair-tool-persistence.mjs --check-files  # attachments only
 *
 * Exit codes:
 *   0  — clean (or fixes applied successfully)
 *   1  — issues found (run with --fix to repair)
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";
import { homedir } from "node:os";

// ── Config ────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
const FILES_ROOT = process.env.INFINIBOT_FILES_ROOT ?? join(STATE_DIR, "files");
const KANBAN_DB = join(STATE_DIR, "kanban.db");
const DATABASES_DB = join(STATE_DIR, "databases.db");
const NOTES_DIR = join(STATE_DIR, "notes");

const FIX = process.argv.includes("--fix");
const VERBOSE = process.argv.includes("--verbose");
const CHECK_NOTES = process.argv.includes("--check-notes");
const CHECK_KANBAN = process.argv.includes("--check-kanban");
const CHECK_FILES = process.argv.includes("--check-files");
const CHECK_ALL = !CHECK_NOTES && !CHECK_KANBAN && !CHECK_FILES;

// ── Counters ──────────────────────────────────────────────────────────────

const report = {
  notes: { orphanFiles: 0, orphanDbRows: 0, fixed: 0 },
  tasks: { orphanedProjectId: 0, fixed: 0 },
  projectContent: { orphanedProjectId: 0, fixed: 0 },
  attachments: { orphanDisk: 0, orphanDb: 0, missingFile: 0, fixed: 0 },
  duplicates: { found: 0, fixed: 0 },
};

let hasIssues = false;

function log(msg) {
  console.log(msg);
}

function verbose(msg) {
  if (VERBOSE) console.log("  " + msg);
}

function issue(msg) {
  hasIssues = true;
  console.warn("[ISSUE] " + msg);
}

function fixed(msg) {
  console.log("[FIXED] " + msg);
}

// ── Database helpers ──────────────────────────────────────────────────────

function openDb(path, opts = {}) {
  if (!existsSync(path)) {
    verbose(`DB not found, skipping: ${path}`);
    return null;
  }
  const db = new Database(path, { readonly: !FIX && !opts.forceWrite });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  if (!opts.readonly) db.pragma("foreign_keys = ON");
  return db;
}

// ── 1. Notes ─────────────────────────────────────────────────────────────

function repairNotes() {
  log("\n── Notes ──────────────────────────────────────────────────────");

  const dbsDb = openDb(DATABASES_DB);
  const notesOnDisk = new Set();
  const notesInDb = new Set();

  // Collect IDs from file store
  if (existsSync(NOTES_DIR)) {
    for (const f of readdirSync(NOTES_DIR)) {
      if (!f.endsWith(".md")) continue;
      const id = f.slice(0, -3);
      notesOnDisk.add(id);
      verbose(`disk note: ${id}`);
    }
  }

  // Collect IDs from databases.db (database_rows mapped to "notes" role)
  if (dbsDb) {
    try {
      const systemDb = dbsDb
        .prepare("SELECT database_id FROM system_databases WHERE role = 'notes'")
        .get();
      if (systemDb) {
        const dbId = systemDb.database_id;
        const rows = dbsDb
          .prepare("SELECT id FROM database_rows WHERE database_id = ?")
          .all(dbId);
        for (const r of rows) {
          notesInDb.add(r.id);
          verbose(`db note: ${r.id}`);
        }
      }
      dbsDb.close();
    } catch (e) {
      verbose("databases.db notes query failed: " + e.message);
    }
  }

  log(`  File-store notes: ${notesOnDisk.size}`);
  log(`  Database notes:   ${notesInDb.size}`);

  // If both stores have notes and no role is mapped, they're separate — report drift
  if (notesOnDisk.size > 0 && notesInDb.size > 0) {
    issue(
      `Notes exist in BOTH file store (${notesOnDisk.size}) and database (${notesInDb.size}). ` +
      `Run 'notes.migrate_to_database' via the UI to merge them.`,
    );
    report.notes.orphanFiles += notesOnDisk.size;
  } else {
    log("  Notes store: single source — OK");
  }
}

// ── 2. Kanban Tasks orphaned projectId ───────────────────────────────────

function repairKanbanTasks() {
  log("\n── Kanban Tasks ────────────────────────────────────────────────");

  const db = openDb(KANBAN_DB, { forceWrite: FIX });
  if (!db) {
    log("  kanban.db not found — skipping");
    return;
  }

  // Find tasks whose projectId references a non-existent project
  const orphanTasks = db
    .prepare(
      `SELECT t.id, t.projectId, t.title FROM tasks t
       WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.projectId)`,
    )
    .all();

  if (orphanTasks.length === 0) {
    log("  No orphaned tasks — OK");
  } else {
    issue(`${orphanTasks.length} tasks reference non-existent projects`);
    report.tasks.orphanedProjectId += orphanTasks.length;
    for (const t of orphanTasks) {
      verbose(`  orphan task: ${t.id} (project: ${t.projectId}) "${t.title}"`);
    }
    if (FIX) {
      // Move orphaned tasks to the default project, or delete if no default exists
      const defaultProject = db.prepare("SELECT id FROM projects LIMIT 1").get();
      if (defaultProject) {
        const stmt = db.prepare("UPDATE tasks SET projectId = ? WHERE id = ?");
        for (const t of orphanTasks) {
          stmt.run(defaultProject.id, t.id);
          fixed(`task ${t.id} reassigned to project ${defaultProject.id}`);
          report.tasks.fixed++;
        }
      } else {
        const stmt = db.prepare("DELETE FROM tasks WHERE id = ?");
        for (const t of orphanTasks) {
          stmt.run(t.id);
          fixed(`task ${t.id} deleted (no project to reassign to)`);
          report.tasks.fixed++;
        }
      }
    }
  }

  // Check for duplicate tasks (same notionId)
  const dupNotionIds = db
    .prepare(
      `SELECT notionId, COUNT(*) as cnt FROM tasks
       WHERE notionId IS NOT NULL
       GROUP BY notionId HAVING cnt > 1`,
    )
    .all();

  if (dupNotionIds.length > 0) {
    issue(`${dupNotionIds.length} notionId values appear more than once in tasks`);
    report.duplicates.found += dupNotionIds.length;
    for (const d of dupNotionIds) {
      const dupes = db
        .prepare("SELECT id, title, createdAt FROM tasks WHERE notionId = ? ORDER BY createdAt ASC")
        .all(d.notionId);
      verbose(`  dup notionId ${d.notionId}: ${dupes.map((r) => r.id).join(", ")}`);
      if (FIX) {
        // Keep oldest, delete rest
        const [keep, ...remove] = dupes;
        for (const r of remove) {
          db.prepare("DELETE FROM tasks WHERE id = ?").run(r.id);
          fixed(`deleted dup task ${r.id} (keeping ${keep.id})`);
          report.duplicates.fixed++;
        }
      }
    }
  } else {
    log("  No duplicate tasks (notionId) — OK");
  }

  db.close();
}

// ── 3. Project content orphans ────────────────────────────────────────────

function repairProjectContent() {
  log("\n── Project Content (notes/attachments/badges/phases) ───────────");

  const db = openDb(KANBAN_DB, { forceWrite: FIX });
  if (!db) {
    log("  kanban.db not found — skipping");
    return;
  }

  const CONTENT_TABLES = [
    "project_notes",
    "project_attachments",
    "project_badges",
    "project_meta",
    "project_content_blocks",
    "project_phases",
  ];

  for (const table of CONTENT_TABLES) {
    try {
      const orphans = db
        .prepare(
          `SELECT id FROM ${table}
           WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${table}.projectId)`,
        )
        .all();

      if (orphans.length === 0) {
        log(`  ${table}: no orphans — OK`);
      } else {
        issue(`${orphans.length} orphan rows in ${table} (project deleted without cascade)`);
        report.projectContent.orphanedProjectId += orphans.length;
        for (const r of orphans) verbose(`  orphan: ${r.id}`);
        if (FIX) {
          for (const r of orphans) {
            db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id);
            fixed(`deleted orphan ${table} row ${r.id}`);
            report.projectContent.fixed++;
          }
        }
      }
    } catch (e) {
      // project_meta and project_content_blocks use projectId as PK — adapt query
      try {
        const orphans = db
          .prepare(
            `SELECT projectId FROM ${table}
             WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${table}.projectId)`,
          )
          .all();
        if (orphans.length === 0) {
          log(`  ${table}: no orphans — OK`);
        } else {
          issue(`${orphans.length} orphan rows in ${table}`);
          report.projectContent.orphanedProjectId += orphans.length;
          if (FIX) {
            for (const r of orphans) {
              db.prepare(`DELETE FROM ${table} WHERE projectId = ?`).run(r.projectId);
              fixed(`deleted orphan ${table} row for project ${r.projectId}`);
              report.projectContent.fixed++;
            }
          }
        }
      } catch {
        verbose(`Could not query ${table}: ${e.message}`);
      }
    }
  }

  db.close();
}

// ── 4. Project file attachments ───────────────────────────────────────────

function sha256File(filePath) {
  try {
    const buf = readFileSync(filePath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function repairAttachments() {
  log("\n── Project File Attachments ─────────────────────────────────────");

  const db = openDb(KANBAN_DB, { forceWrite: FIX });
  if (!db) {
    log("  kanban.db not found — skipping");
    return;
  }

  if (!existsSync(FILES_ROOT)) {
    log(`  FILES_ROOT does not exist yet: ${FILES_ROOT} — skipping disk scan`);
    if (FIX) mkdirSync(FILES_ROOT, { recursive: true });
  }

  // Phase 1: DB rows → check disk files exist
  const dbRows = db.prepare("SELECT * FROM project_attachments").all();
  log(`  DB rows: ${dbRows.length}`);

  const dbPaths = new Map(); // relative path → row
  for (const row of dbRows) {
    const fullPath = row.path.startsWith("/") ? row.path : join(FILES_ROOT, row.path);
    dbPaths.set(row.path, row);

    if (!existsSync(fullPath)) {
      issue(`Attachment "${row.id}" (${row.name}) missing on disk: ${fullPath}`);
      report.attachments.missingFile++;
      // No auto-fix for missing files — can't recreate content
    } else {
      // Backfill missing sha256
      if (!row.sha256 && FIX) {
        const hash = sha256File(fullPath);
        if (hash) {
          db.prepare("UPDATE project_attachments SET sha256 = ? WHERE id = ?").run(hash, row.id);
          fixed(`backfilled sha256 for attachment ${row.id}`);
          report.attachments.fixed++;
        }
      }
    }
  }

  // Phase 2: Disk scan → find files not in DB
  if (existsSync(FILES_ROOT)) {
    const projectDirs = readdirSync(FILES_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const dir of projectDirs) {
      const projectPath = join(FILES_ROOT, dir);
      let files;
      try {
        files = readdirSync(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const f of files) {
        if (!f.isFile()) continue;
        const relPath = join(dir, f.name);
        const fullPath = join(FILES_ROOT, relPath);

        if (!dbPaths.has(relPath)) {
          const stat = statSync(fullPath);
          const hash = sha256File(fullPath);

          // Check if another path for same sha256 already in DB
          const existingBySha = hash
            ? db
                .prepare("SELECT id FROM project_attachments WHERE sha256 = ? LIMIT 1")
                .get(hash)
            : null;

          if (existingBySha) {
            verbose(`  orphan disk file ${relPath} is a dup of DB row ${existingBySha.id} (same sha256)`);
          } else {
            issue(`Disk file not in DB: ${relPath} (${stat.size} bytes)`);
            report.attachments.orphanDisk++;

            if (FIX) {
              // Register the orphaned file as an attachment under the directory-name project
              const projectId = dir;
              const ext = extname(f.name);
              const now = Date.now();
              const id = `att_${now.toString(36)}_orphan`;
              db.prepare(
                `INSERT OR IGNORE INTO project_attachments
                 (id, projectId, name, path, size, sha256, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              ).run(id, projectId, f.name, relPath, stat.size, hash ?? null, now);
              fixed(`registered orphan disk file as attachment ${id}`);
              report.attachments.fixed++;
            }
          }
        }
      }
    }
  }

  // Phase 3: Duplicate sha256 within same project
  const dupSha = db
    .prepare(
      `SELECT projectId, sha256, COUNT(*) as cnt
       FROM project_attachments WHERE sha256 IS NOT NULL
       GROUP BY projectId, sha256 HAVING cnt > 1`,
    )
    .all();

  if (dupSha.length > 0) {
    issue(`${dupSha.length} duplicate sha256 values in project_attachments`);
    report.duplicates.found += dupSha.length;
    for (const d of dupSha) {
      const dupes = db
        .prepare(
          "SELECT id, name, createdAt FROM project_attachments WHERE projectId = ? AND sha256 = ? ORDER BY createdAt ASC",
        )
        .all(d.projectId, d.sha256);
      verbose(`  dup sha256 ${d.sha256} in ${d.projectId}: ${dupes.map((r) => r.id).join(", ")}`);
      if (FIX) {
        const [keep, ...remove] = dupes;
        for (const r of remove) {
          db.prepare("DELETE FROM project_attachments WHERE id = ?").run(r.id);
          fixed(`deleted dup attachment ${r.id} (keeping ${keep.id})`);
          report.duplicates.fixed++;
        }
      }
    }
  } else {
    log("  No duplicate attachments by sha256 — OK");
  }

  db.close();
}

// ── Main ──────────────────────────────────────────────────────────────────

log(`\nInfiniBot Tool-Persistence Repair`);
log(`  STATE_DIR:  ${STATE_DIR}`);
log(`  FILES_ROOT: ${FILES_ROOT}`);
log(`  Mode:       ${FIX ? "FIX" : "DRY-RUN"}`);

if (CHECK_ALL || CHECK_NOTES) repairNotes();
if (CHECK_ALL || CHECK_KANBAN) repairKanbanTasks();
if (CHECK_ALL || CHECK_KANBAN) repairProjectContent();
if (CHECK_ALL || CHECK_FILES) repairAttachments();

log("\n── Summary ─────────────────────────────────────────────────────");
log(JSON.stringify(report, null, 2));

if (hasIssues && !FIX) {
  log("\n⚠  Issues found. Run with --fix to repair.\n");
  process.exit(1);
} else if (!hasIssues) {
  log("\n✓  All checks passed.\n");
  process.exit(0);
} else {
  log(`\n✓  Repairs applied.\n`);
  process.exit(0);
}
