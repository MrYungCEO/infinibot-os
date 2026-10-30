/**
 * reconcile-split-stores.ts — one-shot, idempotent MCP↔UI split-brain repair.
 *
 * Background
 * ──────────
 * Historically some code paths resolved the state dir to the LEGACY MCP
 * location (`~/.infinibot`) while the gateway/UI read from the CANONICAL
 * per-repo location (`<repo>/state`). The result is "split-brain": projects,
 * project content blocks (incl. the `<id>::spec` docs), project attachments,
 * project_meta rows, workflows, notes and research written through the MCP
 * tools landed in `~/.infinibot/**` and are invisible in the UI, which only
 * ever reads `<repo>/state/**`.
 *
 * What this script does
 * ─────────────────────
 * Non-destructively MERGES the legacy store's data INTO the canonical store:
 *
 *   • kanban.db tables — projects, tasks, project_content_blocks,
 *     project_attachments, project_meta (plus the companion project_notes,
 *     project_badges, project_phases tables, which are merged with the same
 *     generic, primary-key-aware upsert).
 *   • workflows/ , notes/ , research/ document stores (file trees).
 *   • files/ (project attachment bytes) — copied into the canonical files dir.
 *
 * Merge rules (per row / per file):
 *   • INSERT when the canonical store has no row/file with that id/path.
 *   • REPLACE when the legacy row/file is strictly NEWER (by updatedAt, else
 *     createdAt for rows; by mtime for files).
 *   • SKIP when the canonical row/file is already present and >= as new
 *     (canonical is never downgraded and rows are never deleted).
 *
 * Safety
 * ──────
 *   • A timestamped backup copy of the canonical kanban.db is made before any
 *     write (skipped in --dry-run).
 *   • Legacy DB is opened read-only.
 *   • Idempotent: a second run merges nothing (everything is already >= as new)
 *     and INSERT OR REPLACE with identical data is a no-op in effect.
 *
 * Usage
 * ─────
 *   node --import tsx src/scripts/reconcile-split-stores.ts \
 *        [--canonical <dir>] [--legacy <dir>] [--dry-run] [--yes]
 *
 * Defaults:
 *   canonical = $INFINIBOT_CANONICAL_DIR || <repo>/state
 *   legacy    = $INFINIBOT_LEGACY_DIR   || ~/.infinibot
 *
 * NOTE: better-sqlite3 in this repo is built for Node >= 22 (see engines). Run
 * with the project's Node 22 binary, e.g.
 *   ~/.nvm/versions/node/v22.23.1/bin/node --import tsx src/scripts/reconcile-split-stores.ts --dry-run
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// ─────────────────────────────────────────────────────────────────────────
// CLI / path resolution
// ─────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/scripts/reconcile-split-stores.ts → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface Options {
  canonicalDir: string;
  legacyDir: string;
  dryRun: boolean;
  assumeYes: boolean;
}

function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

function parseArgs(argv: string[]): Options {
  let canonical = process.env.INFINIBOT_CANONICAL_DIR?.trim() || "";
  let legacy = process.env.INFINIBOT_LEGACY_DIR?.trim() || "";
  let dryRun = false;
  let assumeYes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (): string => {
      const eq = arg.indexOf("=");
      if (eq >= 0) return arg.slice(eq + 1);
      return argv[++i] ?? "";
    };
    if (arg === "--canonical" || arg.startsWith("--canonical=")) canonical = takeValue();
    else if (arg === "--legacy" || arg.startsWith("--legacy=")) legacy = takeValue();
    else if (arg === "--dry-run" || arg === "-n") dryRun = true;
    else if (arg === "--yes" || arg === "-y") assumeYes = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  return {
    canonicalDir: expandHome(canonical || path.join(REPO_ROOT, "state")),
    legacyDir: expandHome(legacy || path.join(os.homedir(), ".infinibot")),
    dryRun,
    assumeYes,
  };
}

function printHelp(): void {
  console.log(
    [
      "reconcile-split-stores — merge legacy MCP store into the canonical gateway store",
      "",
      "  --canonical <dir>   canonical (gateway/UI) state dir  [default: <repo>/state]",
      "  --legacy <dir>      legacy MCP state dir              [default: ~/.infinibot]",
      "  --dry-run, -n       report what would change; write nothing",
      "  --yes, -y           skip the confirmation prompt (non-interactive runs)",
      "  --help, -h          show this help",
    ].join("\n"),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────

const nowStamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

interface ColumnInfo {
  name: string;
  pk: number;
}

function columnsOf(db: Database.Database, table: string): ColumnInfo[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as any[]).map((c) => ({
    name: String(c.name),
    pk: Number(c.pk),
  }));
}

/** Resolve the "recency" of a row for the skip-if-canonical-newer rule. */
function rowTimestamp(row: Record<string, unknown>): number {
  const candidates = ["updatedAt", "createdAt", "updated_at", "created_at"];
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v && !Number.isNaN(Number(v))) return Number(v);
  }
  return 0;
}

interface MergeCounts {
  inserted: number;
  updated: number;
  skipped: number;
}

// ─────────────────────────────────────────────────────────────────────────
// kanban.db table merge
// ─────────────────────────────────────────────────────────────────────────

// The named target tables plus their natural companions. All are merged with
// the same generic PK-aware upsert; tables absent in either DB are skipped.
const KANBAN_TABLES = [
  "projects",
  "tasks",
  "project_content_blocks",
  "project_attachments",
  "project_meta",
  "project_notes",
  "project_badges",
  "project_phases",
] as const;

function mergeTable(
  legacyDb: Database.Database,
  canonDb: Database.Database,
  table: string,
  dryRun: boolean,
): MergeCounts | { skippedReason: string } {
  if (!tableExists(legacyDb, table)) return { skippedReason: "absent in legacy" };
  if (!tableExists(canonDb, table)) return { skippedReason: "absent in canonical (schema owned by store)" };

  const legacyCols = columnsOf(legacyDb, table);
  const canonCols = columnsOf(canonDb, table);
  const canonColNames = new Set(canonCols.map((c) => c.name));

  // Only carry columns that exist on BOTH sides — insulates against schema drift.
  const sharedCols = legacyCols.map((c) => c.name).filter((n) => canonColNames.has(n));
  // Primary key columns as declared on the canonical side.
  const pkCols = canonCols.filter((c) => c.pk > 0).map((c) => c.name);
  if (pkCols.length === 0) return { skippedReason: "no primary key on canonical table" };
  // A PK column absent from the shared set can't be matched — bail safely.
  if (!pkCols.every((c) => sharedCols.includes(c))) {
    return { skippedReason: "primary key column missing from shared columns" };
  }

  const counts: MergeCounts = { inserted: 0, updated: 0, skipped: 0 };

  const legacyRows = legacyDb.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
  const pkWhere = pkCols.map((c) => `"${c}" = ?`).join(" AND ");
  const selectCanon = canonDb.prepare(`SELECT * FROM "${table}" WHERE ${pkWhere}`);

  const colList = sharedCols.map((c) => `"${c}"`).join(", ");
  const placeholders = sharedCols.map(() => "?").join(", ");
  const upsert = canonDb.prepare(
    `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${placeholders})`,
  );

  const apply = canonDb.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const pkValues = pkCols.map((c) => row[c]);
      const existing = selectCanon.get(...pkValues) as Record<string, unknown> | undefined;

      if (existing) {
        const legacyTs = rowTimestamp(row);
        const canonTs = rowTimestamp(existing);
        // Skip when canonical is already the same age or newer.
        if (canonTs >= legacyTs) {
          counts.skipped++;
          continue;
        }
        if (!dryRun) upsert.run(...sharedCols.map((c) => normalize(row[c])));
        counts.updated++;
      } else {
        if (!dryRun) upsert.run(...sharedCols.map((c) => normalize(row[c])));
        counts.inserted++;
      }
    }
  });

  apply(legacyRows);
  return counts;
}

/** better-sqlite3 only binds numbers, strings, bigints, buffers and null. */
function normalize(value: unknown): string | number | bigint | Buffer | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    Buffer.isBuffer(value)
  ) {
    return value as string | number | bigint | Buffer;
  }
  // Objects/arrays shouldn't appear from a SELECT *, but be defensive.
  return JSON.stringify(value);
}

// ─────────────────────────────────────────────────────────────────────────
// Directory (document store) merge
// ─────────────────────────────────────────────────────────────────────────

// Aggregate / index files that would clobber canonical-only entries if a stale
// legacy copy happened to be newer. These are copy-if-MISSING only (never
// overwritten) so we don't silently drop canonical rows recorded in the index.
const COPY_IF_MISSING_ONLY = new Set(["runs.json", ".external-roots.json"]);

interface DirMergeCounts {
  copied: number;
  updated: number;
  skipped: number;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function mergeDir(
  legacyDir: string,
  canonDir: string,
  dryRun: boolean,
): DirMergeCounts | { skippedReason: string } {
  if (!fs.existsSync(legacyDir)) return { skippedReason: "absent in legacy" };
  const counts: DirMergeCounts = { copied: 0, updated: 0, skipped: 0 };

  for (const src of walkFiles(legacyDir)) {
    const rel = path.relative(legacyDir, src);
    const dst = path.join(canonDir, rel);
    const base = path.basename(src);
    const exists = fs.existsSync(dst);

    if (!exists) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      counts.copied++;
      continue;
    }
    if (COPY_IF_MISSING_ONLY.has(base)) {
      counts.skipped++;
      continue;
    }
    if (mtimeOf(src) > mtimeOf(dst)) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      counts.updated++;
    } else {
      counts.skipped++;
    }
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

function isCountResult<T extends object>(v: T | { skippedReason: string }): v is T {
  return !("skippedReason" in v);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log("── reconcile-split-stores ──────────────────────────────────");
  console.log(`  canonical : ${opts.canonicalDir}`);
  console.log(`  legacy    : ${opts.legacyDir}`);
  console.log(`  mode      : ${opts.dryRun ? "DRY-RUN (no writes)" : "APPLY"}`);
  console.log("");

  if (path.resolve(opts.canonicalDir) === path.resolve(opts.legacyDir)) {
    console.error("Refusing to run: canonical and legacy dirs are the same path.");
    process.exit(1);
  }
  if (!fs.existsSync(opts.legacyDir)) {
    console.error(`Legacy dir does not exist: ${opts.legacyDir} — nothing to merge.`);
    process.exit(0);
  }
  if (!opts.dryRun) fs.mkdirSync(opts.canonicalDir, { recursive: true });

  // ── kanban.db ────────────────────────────────────────────────────────
  const legacyDbPath = path.join(opts.legacyDir, "kanban.db");
  const canonDbPath = path.join(opts.canonicalDir, "kanban.db");

  if (fs.existsSync(legacyDbPath)) {
    if (!fs.existsSync(canonDbPath)) {
      console.log(`kanban.db: canonical DB missing — copying legacy DB wholesale.`);
      if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(canonDbPath), { recursive: true });
        fs.copyFileSync(legacyDbPath, canonDbPath);
      }
      console.log(`  ${opts.dryRun ? "(dry-run) would copy" : "copied"} ${legacyDbPath} → ${canonDbPath}`);
    } else {
      // Backup canonical before touching it.
      if (!opts.dryRun) {
        const backup = `${canonDbPath}.bak-${nowStamp()}`;
        fs.copyFileSync(canonDbPath, backup);
        console.log(`kanban.db: backed up canonical → ${backup}`);
      } else {
        console.log("kanban.db: (dry-run) backup skipped");
      }

      const legacyDb = new Database(legacyDbPath, { readonly: true });
      const canonDb = new Database(canonDbPath);
      try {
        canonDb.pragma("journal_mode = WAL");
        console.log("kanban.db tables:");
        for (const table of KANBAN_TABLES) {
          const res = mergeTable(legacyDb, canonDb, table, opts.dryRun);
          if (isCountResult(res)) {
            console.log(
              `  ${table.padEnd(24)} inserted=${res.inserted}  updated=${res.updated}  skipped=${res.skipped}`,
            );
          } else {
            console.log(`  ${table.padEnd(24)} — skipped (${res.skippedReason})`);
          }
        }
      } finally {
        legacyDb.close();
        canonDb.close();
      }
    }
  } else {
    console.log("kanban.db: absent in legacy — skipped.");
  }
  console.log("");

  // ── document stores + attachment bytes ────────────────────────────────
  console.log("document stores:");
  for (const store of ["workflows", "notes", "research", "files"]) {
    const res = mergeDir(
      path.join(opts.legacyDir, store),
      path.join(opts.canonicalDir, store),
      opts.dryRun,
    );
    if (isCountResult(res)) {
      console.log(
        `  ${(store + "/").padEnd(24)} copied=${res.copied}  updated=${res.updated}  skipped=${res.skipped}`,
      );
    } else {
      console.log(`  ${(store + "/").padEnd(24)} — skipped (${res.skippedReason})`);
    }
  }
  console.log("");

  console.log(
    opts.dryRun
      ? "DRY-RUN complete — no changes written. Re-run without --dry-run to apply."
      : "Reconciliation complete. Restart the gateway to pick up merged data.",
  );
}

main().catch((err) => {
  console.error("reconcile-split-stores failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
