/**
 * Document-type migration: give every untyped document a stored `type`.
 *
 *   planTypeMigration(store)          dry run — what would change, and why
 *   applyTypeMigration(store, opts)   backs up index.json first, then writes
 *
 * Rules (doc-types.ts inferDocType): legacy category/type property → tags →
 * title words → source (Notion / uploads = Document, Obsidian = Note) → Note.
 * Only documents WITHOUT a type are touched; explicit types are never
 * overwritten; bodies, titles, tree position and updatedAt are unchanged.
 * Re-running is a no-op once everything is typed.
 */

import type { DocTypeDef } from "./doc-types.js";
import { inferDocType } from "./doc-types.js";
import type { DocumentStore } from "./store.js";

export interface TypeMigrationChange {
  id: string;
  title: string;
  kind: "doc" | "file";
  type: string;
  reason: string;
  deleted: boolean;
}

export interface TypeMigrationReport {
  dryRun: boolean;
  root: string;
  totalNodes: number;
  folders: number;
  documents: number;
  alreadyTyped: number;
  toSet: number;
  byType: Record<string, number>;
  byReason: Record<string, number>;
  changes: TypeMigrationChange[];
  applied: number;
  backupPath: string | null;
  at: string;
}

function reasonBucket(reason: string): string {
  if (reason.startsWith("title")) return "title";
  if (reason.startsWith("tag")) return "tag";
  if (reason.startsWith("property")) return "property";
  if (reason === "default") return "default (note)";
  return reason;
}

export function planTypeMigration(
  store: DocumentStore,
  customTypes: Array<Pick<DocTypeDef, "id" | "label">> = [],
): TypeMigrationReport {
  const nodes = store.all();
  const report: TypeMigrationReport = {
    dryRun: true,
    root: store.root,
    totalNodes: nodes.length,
    folders: 0,
    documents: 0,
    alreadyTyped: 0,
    toSet: 0,
    byType: {},
    byReason: {},
    changes: [],
    applied: 0,
    backupPath: null,
    at: new Date().toISOString(),
  };
  for (const n of nodes) {
    if (n.kind === "folder") {
      report.folders += 1;
      continue;
    }
    report.documents += 1;
    if (n.type) {
      report.alreadyTyped += 1;
      continue;
    }
    const inf = inferDocType(n, customTypes);
    report.toSet += 1;
    report.byType[inf.type] = (report.byType[inf.type] ?? 0) + 1;
    const bucket = reasonBucket(inf.reason);
    report.byReason[bucket] = (report.byReason[bucket] ?? 0) + 1;
    report.changes.push({
      id: n.id,
      title: n.title,
      kind: n.kind,
      type: inf.type,
      reason: inf.reason,
      deleted: Boolean(n.deletedAt),
    });
  }
  report.changes.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
  return report;
}

export function applyTypeMigration(
  store: DocumentStore,
  customTypes: Array<Pick<DocTypeDef, "id" | "label">> = [],
): TypeMigrationReport {
  const plan = planTypeMigration(store, customTypes);
  const report: TypeMigrationReport = { ...plan, dryRun: false };
  if (!plan.changes.length) return report;
  report.backupPath = store.backupIndex("types-premigration");
  if (!report.backupPath)
    throw new Error("could not back up the documents index — migration aborted");
  report.applied = store.setTypes(plan.changes.map((c) => ({ id: c.id, type: c.type })));
  return report;
}

/** Human-readable dry-run summary (CLI / report file). */
export function formatTypeMigrationReport(r: TypeMigrationReport, maxRows = 400): string {
  const lines: string[] = [];
  lines.push(`# Document type migration — ${r.dryRun ? "DRY RUN (nothing written)" : "APPLIED"}`);
  lines.push("");
  lines.push(`- Store: ${r.root}`);
  lines.push(`- At: ${r.at}`);
  lines.push(`- Nodes: ${r.totalNodes} (${r.folders} folders, ${r.documents} documents/files)`);
  lines.push(`- Already typed: ${r.alreadyTyped}`);
  lines.push(`- Would set: ${r.toSet}${r.dryRun ? "" : ` · applied: ${r.applied}`}`);
  if (r.backupPath) lines.push(`- Backup: ${r.backupPath}`);
  lines.push("");
  lines.push("## By type");
  for (const [t, n] of Object.entries(r.byType).sort((a, b) => b[1] - a[1]))
    lines.push(`- ${t}: ${n}`);
  lines.push("");
  lines.push("## By rule");
  for (const [t, n] of Object.entries(r.byReason).sort((a, b) => b[1] - a[1]))
    lines.push(`- ${t}: ${n}`);
  lines.push("");
  lines.push("## Changes");
  lines.push("| type | title | reason | id |");
  lines.push("|---|---|---|---|");
  for (const c of r.changes.slice(0, maxRows)) {
    const t = c.title.replace(/\|/g, "\\|");
    lines.push(
      `| ${c.type} | ${t}${c.deleted ? " (in trash)" : ""} | ${c.reason.replace(/\|/g, "\\|")} | ${c.id} |`,
    );
  }
  if (r.changes.length > maxRows) lines.push(`| … | ${r.changes.length - maxRows} more | | |`);
  return lines.join("\n");
}
