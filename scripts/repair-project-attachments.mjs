#!/usr/bin/env node
/**
 * Repair / reconcile project attachment records.
 *
 * Idempotent. Safe to re-run at any time.
 *
 * What it does:
 *   1. Scans project_attachments rows in kanban.db
 *   2. For each row, checks if the file on disk exists (relative to FILES_ROOT)
 *   3. Reports orphaned DB records (file missing from disk)
 *   4. Scans disk for files under FILES_ROOT/projects/ that have no DB row
 *   5. Optionally inserts missing DB rows for orphaned disk files (--fix flag)
 *   6. Computes SHA256 for rows that don't have it yet (--fix flag)
 *   7. Generates markdown for attachments missing markdownPath (--fix flag)
 *
 * Usage:
 *   node scripts/repair-project-attachments.mjs          # dry-run
 *   node scripts/repair-project-attachments.mjs --fix    # apply fixes
 *   node scripts/repair-project-attachments.mjs --verbose
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, relative, extname, basename } from "path";
import { homedir } from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const FIX = process.argv.includes("--fix");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

const STATE_DIR = process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
const FILES_ROOT = process.env.INFINIBOT_FILES_ROOT ?? join(STATE_DIR, "files");
const DB_PATH = join(STATE_DIR, "kanban.db");

function log(...args) {
  console.log("[repair-project-attachments]", ...args);
}
function verbose(...args) {
  if (VERBOSE) log(...args);
}

if (!existsSync(DB_PATH)) {
  log(`ERROR: kanban.db not found at ${DB_PATH}`);
  log(`Set INFINIBOT_STATE_DIR if your state dir is not ~/.infinibot`);
  process.exit(1);
}

// ── Open DB ──────────────────────────────────────────────────────────
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  log("ERROR: better-sqlite3 not available. Run from the InfiniBot-fresh repo root.");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Ensure columns exist (idempotent)
const addCol = (table, col, type = "TEXT") => {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
};
addCol("project_attachments", "sha256");
addCol("project_attachments", "markdownPath");
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_project_attachments_sha256 ON project_attachments(projectId, sha256)");
} catch {}

// ── Load all attachment rows ──────────────────────────────────────────
const rows = db.prepare("SELECT * FROM project_attachments").all();
log(`Found ${rows.length} attachment record(s) in DB.`);

let orphanedDbRows = 0;
let missingMarkdown = 0;
let missingSha256 = 0;
let fixedSha256 = 0;
let fixedMarkdown = 0;

function resolveFilePath(relPath) {
  if (!relPath) return null;
  // Absolute paths stored by legacy code
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) {
    return relPath;
  }
  return join(FILES_ROOT, relPath);
}

// ── Phase 1: Check DB rows against disk ──────────────────────────────
log("Phase 1: checking DB records against disk...");
for (const row of rows) {
  const absPath = resolveFilePath(row.path);
  if (!absPath) {
    log(`  WARN: row id=${row.id} has no path`);
    continue;
  }
  if (!existsSync(absPath)) {
    log(`  ORPHANED DB ROW: id=${row.id} projectId=${row.projectId} name=${row.name} path=${row.path}`);
    orphanedDbRows++;
    continue;
  }

  verbose(`  OK: ${row.path}`);

  // Back-fill sha256
  if (!row.sha256) {
    missingSha256++;
    if (FIX) {
      const buf = readFileSync(absPath);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      db.prepare("UPDATE project_attachments SET sha256=? WHERE id=?").run(sha256, row.id);
      log(`  FIXED sha256: id=${row.id} sha256=${sha256.slice(0, 16)}`);
      fixedSha256++;
    }
  }

  // Back-fill markdownPath (only if missing AND not an image)
  if (!row.markdownPath) {
    const e = extname(row.name || row.path).toLowerCase();
    const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".heic", ".ico"]);
    if (!imageExts.has(e)) {
      missingMarkdown++;
      if (FIX) {
        try {
          const buf = readFileSync(absPath);
          const { convertToMarkdown } = await import("../src/files/convert.js");
          const { markdown } = await convertToMarkdown(row.name ?? basename(absPath), buf, row.mimeType ?? undefined);
          if (markdown && markdown.trim().length > 0) {
            const sha256 = row.sha256 ??
              db.prepare("SELECT sha256 FROM project_attachments WHERE id=?").get(row.id)?.sha256 ??
              createHash("sha256").update(buf).digest("hex");
            const mdFilename = `${sha256}.md`;
            const projectFilesDir = join(FILES_ROOT, "projects", row.projectId);
            mkdirSync(projectFilesDir, { recursive: true });
            const mdAbsPath = join(projectFilesDir, mdFilename);
            writeFileSync(mdAbsPath, markdown, "utf8");
            const mdRelPath = `projects/${row.projectId}/${mdFilename}`;
            db.prepare("UPDATE project_attachments SET markdownPath=? WHERE id=?").run(mdRelPath, row.id);
            log(`  FIXED markdown: id=${row.id} markdownPath=${mdRelPath}`);
            fixedMarkdown++;
          }
        } catch (err) {
          log(`  WARN: markdown conversion failed for id=${row.id}: ${err.message}`);
        }
      }
    }
  }
}

// ── Phase 2: Scan disk for files not in DB ───────────────────────────
log("Phase 2: scanning disk for files with no DB record...");
const projectsDir = join(FILES_ROOT, "projects");
let orphanedFiles = 0;
let registeredOrphans = 0;

if (existsSync(projectsDir)) {
  const projectIds = readdirSync(projectsDir);
  for (const projectId of projectIds) {
    const dir = join(projectsDir, projectId);
    if (!statSync(dir).isDirectory()) continue;

    const files = readdirSync(dir).filter((f) => !f.endsWith(".md"));
    for (const filename of files) {
      if (filename.startsWith(".")) continue;
      const absPath = join(dir, filename);
      if (!statSync(absPath).isFile()) continue;

      const relPath = `projects/${projectId}/${filename}`;
      const dbRow = db.prepare("SELECT id FROM project_attachments WHERE path=? AND projectId=?").get(relPath, projectId);

      if (!dbRow) {
        orphanedFiles++;
        log(`  ORPHANED FILE: ${relPath} (no DB record)`);

        if (FIX) {
          const buf = readFileSync(absPath);
          const sha256 = createHash("sha256").update(buf).digest("hex");
          const e = extname(filename).toLowerCase();
          // Check if project exists
          const projectExists = db.prepare("SELECT id FROM projects WHERE id=?").get(projectId);
          if (!projectExists) {
            log(`    SKIP: project ${projectId} not in projects table`);
            continue;
          }
          const now = Date.now();
          const id = `att_${now.toString(36)}_repair_${Math.random().toString(36).slice(2, 6)}`;
          db.prepare(
            "INSERT OR IGNORE INTO project_attachments (id, projectId, name, path, size, sha256, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).run(id, projectId, filename, relPath, buf.length, sha256, now);
          log(`    REGISTERED: id=${id} sha256=${sha256.slice(0, 16)}`);
          registeredOrphans++;
        }
      } else {
        verbose(`  OK: ${relPath} → ${dbRow.id}`);
      }
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────
log("─────────────────────────────────");
log(`DB rows with missing file on disk:    ${orphanedDbRows}`);
log(`DB rows missing sha256:               ${missingSha256}${FIX ? ` (fixed ${fixedSha256})` : " (run --fix to backfill)"}`);
log(`DB rows missing markdownPath:         ${missingMarkdown}${FIX ? ` (fixed ${fixedMarkdown})` : " (run --fix to backfill)"}`);
log(`Disk files with no DB record:         ${orphanedFiles}${FIX ? ` (registered ${registeredOrphans})` : " (run --fix to register)"}`);
log(FIX ? "Done." : "Dry-run complete. Run with --fix to apply changes.");
