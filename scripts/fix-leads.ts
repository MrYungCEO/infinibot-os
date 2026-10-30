#!/usr/bin/env bun
/**
 * scripts/fix-leads.ts — Apply lead name fixes and quarantine unrecoverables.
 *
 * Default mode is DRY — no writes ever happen without --mode=apply.
 *
 * Usage:
 *   bun scripts/fix-leads.ts             # same as --mode=dry
 *   bun scripts/fix-leads.ts --mode=dry  # print intended changes, no writes
 *   bun scripts/fix-leads.ts --mode=apply  # apply (after reviewing dry run)
 *
 * Requires leads-audit-report.json (run audit-leads.ts first).
 *
 * What apply does:
 *   - Recoverable leads   → name updated; customFields.nameAutoFixedAt + nameAutoFixedFrom set
 *   - Unrecoverable leads → status = "quarantined"; customFields.quarantinedAt + quarantineReason set
 *   - Hard-delete: NEVER
 *   - All writes per business wrapped in a single transaction (atomic, all-or-nothing)
 *   - Backup created and sha256-verified BEFORE any write
 */

import { Database } from "bun:sqlite";
import { readFileSync, copyFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

const DB_PATH = join(process.cwd(), "state", "funnels", "funnels.db");
const AUDIT_PATH = join(process.cwd(), "leads-audit-report.json");

// ── Mode ──────────────────────────────────────────────────────────────────────

const mode = process.argv.includes("--mode=apply") ? "apply" : "dry";

// ── Pre-flight checks ─────────────────────────────────────────────────────────

if (!existsSync(DB_PATH)) {
  console.error(`ERROR: funnels.db not found at\n  ${DB_PATH}`);
  process.exit(1);
}

if (!existsSync(AUDIT_PATH)) {
  console.error(`ERROR: leads-audit-report.json not found at\n  ${AUDIT_PATH}`);
  console.error("Run audit first:  bun scripts/audit-leads.ts");
  process.exit(1);
}

// ── Load audit report ─────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  businessId: string;
  currentName: string;
  category: string;
  recoveredName: string | null;
  recoverable: boolean;
  recoverySource: string | null;
}

interface AuditReport {
  generatedAt: string;
  dbPath: string;
  businesses: Array<{
    businessId: string;
    businessName: string;
    total: number;
    counts: Record<string, number>;
    nonOkEntries: AuditEntry[];
  }>;
}

const report = JSON.parse(
  readFileSync(AUDIT_PATH, "utf-8"),
) as AuditReport;

// ── Dry-run / intent summary ──────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Lead Fix Script — mode: ${mode.toUpperCase()}`);
console.log(`Audit generated: ${report.generatedAt}`);
console.log("=".repeat(60));

let grandFix = 0;
let grandQuarantine = 0;
let grandSkip = 0;

for (const biz of report.businesses) {
  const toFix = biz.nonOkEntries.filter((e) => e.recoverable);
  const toQuarantine = biz.nonOkEntries.filter((e) => !e.recoverable);
  const okCount = biz.total - biz.nonOkEntries.length;

  grandFix += toFix.length;
  grandQuarantine += toQuarantine.length;
  grandSkip += okCount;

  console.log(`\nBusiness: "${biz.businessName}"`);
  console.log(
    `  would-fix: ${toFix.length}  would-quarantine: ${toQuarantine.length}  would-skip: ${okCount}`,
  );

  if (toFix.length > 0) {
    console.log("  Sample fixes (up to 5):");
    for (const e of toFix.slice(0, 5)) {
      console.log(
        `    [${e.category}] "${e.currentName}" → "${e.recoveredName}"  (via ${e.recoverySource})`,
      );
    }
    if (toFix.length > 5)
      console.log(`    … and ${toFix.length - 5} more`);
  }

  if (toQuarantine.length > 0) {
    console.log("  Sample quarantines (up to 5):");
    for (const e of toQuarantine.slice(0, 5)) {
      console.log(
        `    [${e.category}] "${e.currentName}" → status=quarantined`,
      );
    }
    if (toQuarantine.length > 5)
      console.log(`    … and ${toQuarantine.length - 5} more`);
  }
}

console.log(
  `\nTOTAL — fix: ${grandFix}  quarantine: ${grandQuarantine}  skip (OK): ${grandSkip}`,
);

if (mode === "dry") {
  console.log(
    "\n[DRY RUN] No changes made. Inspect leads-audit-summary.tsv, then:\n" +
      "  bun scripts/fix-leads.ts --mode=apply",
  );
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("APPLYING CHANGES");
console.log("=".repeat(60));

// ── Step 1: Backup ────────────────────────────────────────────────────────────

function makeTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

const backupPath = `${DB_PATH}.backup-${makeTimestamp()}`;

console.log(`\nCreating backup → ${backupPath}`);
try {
  copyFileSync(DB_PATH, backupPath);
} catch (e) {
  console.error(`FATAL: Could not create backup: ${e}`);
  process.exit(1);
}

// Verify byte-identical via sha256
const origBuf = readFileSync(DB_PATH);
const backBuf = readFileSync(backupPath);
if (origBuf.length !== backBuf.length) {
  console.error(
    `FATAL: Backup size mismatch (orig=${origBuf.length}, backup=${backBuf.length}). Aborting.`,
  );
  process.exit(1);
}
const origHash = createHash("sha256").update(origBuf).digest("hex");
const backHash = createHash("sha256").update(backBuf).digest("hex");
if (origHash !== backHash) {
  console.error(`FATAL: Backup sha256 mismatch. Aborting.`);
  process.exit(1);
}
console.log(`Backup verified  sha256=${origHash.slice(0, 16)}…`);

// ── Step 2: Open DB and apply ─────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

// Typed query to fetch current state before merging customFields
const selectCF = db.query<
  { custom_fields: string; status: string },
  [string]
>("SELECT custom_fields, status FROM leads WHERE id = ?");

// Minimal update — only the fields we touch.
// Prepared statement with positional parameter binding; no string interpolation.
const updateStmt = db.prepare(
  "UPDATE leads SET name = ?, status = ?, custom_fields = ?, updated_at = ? WHERE id = ?",
);

const nowIso = new Date().toISOString();
let appliedFix = 0;
let appliedQuarantine = 0;
let errorCount = 0;

for (const biz of report.businesses) {
  const toFix = biz.nonOkEntries.filter((e) => e.recoverable);
  const toQuarantine = biz.nonOkEntries.filter((e) => !e.recoverable);

  if (toFix.length === 0 && toQuarantine.length === 0) continue;

  // Single transaction per business — atomic, all-or-nothing
  const applyBusiness = db.transaction(() => {
    for (const entry of toFix) {
      const row = selectCF.get(entry.id);
      if (!row) {
        console.warn(`  WARN: row ${entry.id} not found, skipping`);
        errorCount++;
        return;
      }
      let cf: Record<string, unknown> = {};
      try {
        cf = JSON.parse(row.custom_fields || "{}");
      } catch {
        /* malformed — start fresh */
      }

      // Audit trail: record original value + timestamp
      cf.nameAutoFixedAt = nowIso;
      cf.nameAutoFixedFrom = entry.currentName;

      updateStmt.run(
        entry.recoveredName!,
        row.status,           // keep existing lifecycle status
        JSON.stringify(cf),
        nowIso,
        entry.id,
      );
      appliedFix++;
    }

    for (const entry of toQuarantine) {
      const row = selectCF.get(entry.id);
      if (!row) {
        console.warn(`  WARN: row ${entry.id} not found, skipping`);
        errorCount++;
        return;
      }
      let cf: Record<string, unknown> = {};
      try {
        cf = JSON.parse(row.custom_fields || "{}");
      } catch {
        /* malformed — start fresh */
      }

      cf.quarantinedAt = nowIso;
      cf.quarantineReason = entry.category;

      updateStmt.run(
        entry.currentName,    // preserve original name for operator review
        "quarantined",
        JSON.stringify(cf),
        nowIso,
        entry.id,
      );
      appliedQuarantine++;
    }
  });

  try {
    applyBusiness();
    console.log(
      `✓ "${biz.businessName}": fixed=${toFix.length}  quarantined=${toQuarantine.length}`,
    );
  } catch (e) {
    console.error(
      `✗ Transaction failed for "${biz.businessName}": ${e}`,
    );
    errorCount++;
  }
}

db.close();

console.log(
  `\nDone. applied-fix=${appliedFix}  applied-quarantine=${appliedQuarantine}  errors=${errorCount}`,
);
console.log(`Backup at: ${backupPath}`);

if (errorCount > 0) {
  console.error(
    `\nWARNING: ${errorCount} row(s) had errors. Review output above.`,
  );
  process.exit(1);
}

console.log(
  "\nVerify with:\n  bun scripts/audit-leads.ts\n(Before/after OK counts should match planned changes)",
);
