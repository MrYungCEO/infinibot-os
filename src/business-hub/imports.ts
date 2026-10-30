/**
 * Business hub — customer list imports.
 *
 *   preview  → parse the file, auto-map columns, validate every row, report
 *              what would be created / updated / skipped (nothing written but
 *              the batch row and a sidecar copy of the parsed table)
 *   commit   → apply the (possibly edited) mapping with a dedupe strategy,
 *              tag + source every record, optionally open deals
 *   undo     → reverse one batch: delete what it created, restore the
 *              before-image of what it updated
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HubDb } from "./db.js";
import {
  deleteContact,
  ensureSource,
  findContactMatch,
  logActivity,
  tagSubject,
  untagSubject,
  upsertContact,
  type ContactInput,
  type Lifecycle,
  LIFECYCLES,
} from "./contacts.js";
import {
  autoMap,
  IMPORT_FIELDS,
  parseImportFile,
  type ColumnMapping,
  type ImportField,
  type ParsedTable,
} from "./import-parse.js";
import { createDeal, ensureDefaultPipeline } from "./pipeline.js";
import { hubId, normalizeEmail, normalizePhone, parseJson, str, toCents, toMs } from "./util.js";

export type ImportStrategy = "fill" | "overwrite" | "skip";

export type ImportOptions = {
  strategy?: ImportStrategy;
  tags?: string[];
  sourceName?: string;
  lifecycle?: Lifecycle;
  createDeals?: boolean;
  dealStageId?: string;
  defaultCountry?: string;
};

export type RowIssue = { row: number; field?: string; message: string };

export type ImportReport = {
  total: number;
  valid: number;
  errors: number;
  warnings: number;
  willCreate: number;
  willUpdate: number;
  duplicatesInFile: number;
  invalidEmails: number;
  invalidPhones: number;
  issues: RowIssue[];
};

export type ImportBatch = {
  id: string;
  fileName: string;
  format: string;
  status: "previewed" | "committed" | "undone" | "failed";
  mapping: ColumnMapping;
  options: ImportOptions;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  report: ImportReport | null;
  tags: string[];
  createdAt: number;
  committedAt: number | null;
  undoneAt: number | null;
};

type Row = Record<string, unknown>;

function rowToBatch(r: Row): ImportBatch {
  return {
    id: r.id as string,
    fileName: r.file_name as string,
    format: r.format as string,
    status: r.status as ImportBatch["status"],
    mapping: parseJson(r.mapping, {}),
    options: parseJson(r.options, {}),
    total: r.total as number,
    created: r.created as number,
    updated: r.updated as number,
    skipped: r.skipped as number,
    failed: r.failed as number,
    report: parseJson<ImportReport | null>(r.report, null),
    tags: parseJson(r.tags, []),
    createdAt: r.created_at as number,
    committedAt: (r.committed_at as number) ?? null,
    undoneAt: (r.undone_at as number) ?? null,
  };
}

function sidecarPath(dir: string, batchId: string): string {
  return join(dir, `${batchId}.json`);
}

const TRUTHY = /^(1|y|yes|true|x|✓|subscribed|opted in|opt-in|granted)$/i;

type MappedRow = {
  contact: ContactInput;
  deal: { valueCents: number; stage: string | null } | null;
  source: string | null;
  createdAt: number | null;
  issues: Array<{ field?: string; message: string; level: "error" | "warning" }>;
};

/** Apply a mapping to one row. */
export function mapRow(
  headers: string[],
  row: string[],
  mapping: ColumnMapping,
  opts: ImportOptions = {},
): MappedRow {
  const v: Partial<Record<ImportField, string>> = {};
  const custom: Record<string, string> = {};
  headers.forEach((h, i) => {
    const target = mapping[h];
    const cell = (row[i] ?? "").trim();
    if (!target || target === "ignore" || !cell) return;
    if (target.startsWith("custom:")) custom[target.slice(7)] = cell;
    else if (!v[target as ImportField]) v[target as ImportField] = cell;
  });
  const issues: MappedRow["issues"] = [];
  let email = normalizeEmail(v.email);
  if (v.email && !email)
    issues.push({ field: "email", message: `"${v.email}" is not a valid email`, level: "warning" });
  if (!email && v.email2) email = normalizeEmail(v.email2);
  const phoneRaw = v.phone ?? v.phone2 ?? null;
  const phoneOk = phoneRaw ? normalizePhone(phoneRaw, opts.defaultCountry) : null;
  if (phoneRaw && !phoneOk)
    issues.push({
      field: "phone",
      message: `"${phoneRaw}" is not a valid phone number`,
      level: "warning",
    });
  const name = str(v.name) ?? ([v.firstName, v.lastName].filter(Boolean).join(" ") || null);
  if (!email && !phoneOk && !name)
    issues.push({
      message: "no name, email or phone — nothing to identify this contact",
      level: "error",
    });
  const social: Record<string, string> = {};
  for (const k of ["linkedin", "instagram", "facebook", "twitter"] as const)
    if (v[k]) social[k] = v[k]!;
  let lifecycle = opts.lifecycle;
  const lc = v.lifecycle?.toLowerCase().trim();
  if (lc) {
    if ((LIFECYCLES as readonly string[]).includes(lc)) lifecycle = lc as Lifecycle;
    else if (/customer|client|won|active|paid/.test(lc)) lifecycle = "customer";
    else if (/qualif|hot|opportunit/.test(lc)) lifecycle = "qualified";
    else if (/subscri|newsletter/.test(lc)) lifecycle = "subscriber";
  }
  const score = v.score
    ? Math.max(
        0,
        Math.min(
          100,
          Math.round(Number.parseFloat(v.score) * (Number.parseFloat(v.score) <= 5 ? 20 : 1)),
        ),
      )
    : undefined;
  if (v.notes) custom.notes = v.notes;
  if (v.postalCode) custom.postal_code = v.postalCode;
  const tags = v.tags
    ? v.tags
        .split(/\s*[,;|]\s*|\s+:::\s+/)
        .map((t) => t.replace(/^\*\s*/, "").trim())
        .filter((t) => t && !/^\* ?myContacts$/i.test(t) && t !== "myContacts")
    : [];
  const company =
    v.company || v.website
      ? {
          name: v.company ?? null,
          website: v.website ?? null,
          industry: v.industry ?? null,
          address: v.address ?? null,
          city: v.city ?? null,
          region: v.region ?? null,
          country: v.country ?? null,
        }
      : null;
  return {
    contact: {
      name,
      firstName: v.firstName ?? null,
      lastName: v.lastName ?? null,
      email,
      phone: phoneOk ? phoneRaw : null,
      title: v.title ?? null,
      company,
      city: v.city ?? null,
      country: v.country ?? null,
      lifecycle,
      score: Number.isFinite(score) ? score : undefined,
      emailOptIn: v.optIn ? TRUTHY.test(v.optIn) : undefined,
      consentSource: v.optIn && TRUTHY.test(v.optIn) ? "import" : null,
      social,
      custom,
      tags: [...tags, ...(opts.tags ?? [])],
    },
    deal:
      v.dealValue || v.dealStage
        ? { valueCents: toCents(v.dealValue), stage: v.dealStage ?? null }
        : null,
    source: v.source ?? null,
    createdAt: toMs(v.createdAt),
    issues,
  };
}

function buildReport(
  db: HubDb,
  table: ParsedTable,
  mapping: ColumnMapping,
  opts: ImportOptions,
): ImportReport {
  const report: ImportReport = {
    total: table.rows.length,
    valid: 0,
    errors: 0,
    warnings: 0,
    willCreate: 0,
    willUpdate: 0,
    duplicatesInFile: 0,
    invalidEmails: 0,
    invalidPhones: 0,
    issues: [],
  };
  const seen = new Set<string>();
  table.rows.forEach((row, i) => {
    const m = mapRow(table.headers, row, mapping, opts);
    const rowNo = i + 2; // 1-based + header row, matches the spreadsheet
    for (const issue of m.issues) {
      if (issue.level === "error") report.errors++;
      else report.warnings++;
      if (issue.field === "email") report.invalidEmails++;
      if (issue.field === "phone") report.invalidPhones++;
      if (report.issues.length < 200)
        report.issues.push({ row: rowNo, field: issue.field, message: issue.message });
    }
    if (m.issues.some((x) => x.level === "error")) return;
    report.valid++;
    const key =
      m.contact.email ??
      (m.contact.phone ? normalizePhone(m.contact.phone, opts.defaultCountry) : null) ??
      `${m.contact.name}|${m.contact.company?.name ?? ""}`.toLowerCase();
    if (seen.has(key)) {
      report.duplicatesInFile++;
      if (report.issues.length < 200)
        report.issues.push({
          row: rowNo,
          message: "duplicate of an earlier row — will be merged into it",
        });
      return;
    }
    seen.add(key);
    const match = findContactMatch(
      db,
      { email: m.contact.email, phone: m.contact.phone, name: m.contact.name },
      opts.defaultCountry,
    );
    if (match) report.willUpdate++;
    else report.willCreate++;
  });
  return report;
}

/** Parse + validate a file and store it as a previewed batch. */
export async function previewImport(
  db: HubDb,
  dir: string,
  input: {
    fileName: string;
    bytes: Uint8Array;
    mapping?: ColumnMapping;
    options?: ImportOptions;
    businessId?: string | null;
  },
): Promise<{
  batch: ImportBatch;
  headers: string[];
  sample: string[][];
  fields: readonly string[];
}> {
  if (input.bytes.length > 25 * 1024 * 1024) throw new Error("file is larger than 25 MB");
  const table = await parseImportFile(input.fileName, input.bytes);
  if (!table.headers.length || !table.rows.length) throw new Error("no rows found in the file");
  const mapping = input.mapping ?? autoMap(table.headers, table.rows.slice(0, 50));
  const options = input.options ?? {};
  const report = buildReport(db, table, mapping, options);
  const id = hubId("imp");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sidecarPath(dir, id), JSON.stringify(table), { mode: 0o600 });
  db.prepare(
    "INSERT INTO import_batches(id,business_id,file_name,format,mapping,options,status,total,report,tags,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    input.businessId ?? null,
    input.fileName.slice(0, 200),
    table.format,
    JSON.stringify(mapping),
    JSON.stringify(options),
    "previewed",
    table.rows.length,
    JSON.stringify(report),
    JSON.stringify(options.tags ?? []),
    Date.now(),
  );
  return {
    batch: getImport(db, id)!,
    headers: table.headers,
    sample: table.rows.slice(0, 10),
    fields: IMPORT_FIELDS,
  };
}

/** Re-validate a previewed batch with an edited mapping/options. */
export function revalidateImport(
  db: HubDb,
  dir: string,
  batchId: string,
  mapping: ColumnMapping,
  options: ImportOptions = {},
): ImportBatch {
  const batch = getImport(db, batchId);
  if (!batch || batch.status !== "previewed") throw new Error("import is not in preview");
  const table = JSON.parse(readFileSync(sidecarPath(dir, batchId), "utf8")) as ParsedTable;
  const report = buildReport(db, table, mapping, options);
  db.prepare(
    "UPDATE import_batches SET mapping = ?, options = ?, report = ?, tags = ? WHERE id = ?",
  ).run(
    JSON.stringify(mapping),
    JSON.stringify(options),
    JSON.stringify(report),
    JSON.stringify(options.tags ?? []),
    batchId,
  );
  return getImport(db, batchId)!;
}

export function getImport(db: HubDb, id: string): ImportBatch | null {
  const r = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToBatch(r) : null;
}

export function listImports(db: HubDb, limit = 50): ImportBatch[] {
  return (
    db.prepare("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]
  ).map(rowToBatch);
}

function snapshot(db: HubDb, contactId: string): string {
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as Row;
  const tags = (
    db
      .prepare(
        "SELECT t.name FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE g.subject_type='contact' AND g.subject_id = ?",
      )
      .all(contactId) as Array<{ name: string }>
  ).map((t) => t.name);
  return JSON.stringify({ row, tags });
}

/** Write a previewed batch. Returns the committed batch with counts. */
export function commitImport(
  db: HubDb,
  dir: string,
  batchId: string,
  edits: { mapping?: ColumnMapping; options?: ImportOptions; actor?: string | null } = {},
): ImportBatch {
  const batch = getImport(db, batchId);
  if (!batch) throw new Error("import not found");
  if (batch.status !== "previewed") throw new Error(`import already ${batch.status}`);
  const table = JSON.parse(readFileSync(sidecarPath(dir, batchId), "utf8")) as ParsedTable;
  const mapping = edits.mapping ?? batch.mapping;
  const options = { ...batch.options, ...edits.options };
  const strategy = options.strategy ?? "fill";
  const defaultSource = ensureSource(db, "import", options.sourceName?.trim() || batch.fileName);
  const pipeline = options.createDeals ? ensureDefaultPipeline(db) : null;
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const touched = new Set<string>();
  const recordChange = db.prepare(
    "INSERT OR IGNORE INTO import_changes(batch_id,subject_type,subject_id,action,before) VALUES(?,?,?,?,?)",
  );
  db.transaction(() => {
    table.rows.forEach((row) => {
      const m = mapRow(table.headers, row, mapping, options);
      if (m.issues.some((x) => x.level === "error")) {
        counts.failed++;
        return;
      }
      const existing = findContactMatch(
        db,
        { email: m.contact.email, phone: m.contact.phone, name: m.contact.name },
        options.defaultCountry,
      );
      if (existing && strategy === "skip") {
        counts.skipped++;
        return;
      }
      if (existing && !touched.has(existing.contact.id))
        recordChange.run(
          batchId,
          "contact",
          existing.contact.id,
          "updated",
          snapshot(db, existing.contact.id),
        );
      const sourceId = m.source ? ensureSource(db, "import", m.source) : defaultSource;
      const res = upsertContact(db, m.contact, {
        sourceId,
        importBatchId: batchId,
        strategy: strategy === "overwrite" ? "overwrite" : "fill",
        defaultCountry: options.defaultCountry,
        actor: edits.actor ?? "import",
      });
      if (!res) {
        counts.failed++;
        return;
      }
      // upsertCompany stamps companies it creates with this batch id.
      if (
        res.contact.companyId &&
        db
          .prepare("SELECT 1 FROM companies WHERE id = ? AND import_batch_id = ?")
          .get(res.contact.companyId, batchId)
      ) {
        recordChange.run(batchId, "company", res.contact.companyId, "created", null);
      }
      if (res.created) {
        recordChange.run(batchId, "contact", res.contact.id, "created", null);
        if (m.createdAt)
          db.prepare("UPDATE contacts SET created_at = ? WHERE id = ?").run(
            m.createdAt,
            res.contact.id,
          );
        counts.created++;
      } else if (!touched.has(res.contact.id)) counts.updated++;
      touched.add(res.contact.id);
      if (pipeline && (m.deal || options.createDeals)) {
        const hasOpen = db
          .prepare("SELECT 1 FROM deals WHERE contact_id = ? AND status = 'open'")
          .get(res.contact.id);
        if (!hasOpen) {
          const stageName = m.deal?.stage?.toLowerCase();
          const stage =
            pipeline.stages.find((s) => s.name.toLowerCase() === stageName) ??
            pipeline.stages.find((s) => s.id === options.dealStageId) ??
            pipeline.stages[0];
          const deal = createDeal(
            db,
            {
              title: res.contact.name,
              contactId: res.contact.id,
              companyId: res.contact.companyId,
              stageId: stage.id,
              valueCents: m.deal?.valueCents ?? 0,
              sourceId,
            },
            { actor: "import", enforce: false },
          );
          recordChange.run(batchId, "deal", deal.id, "created", null);
        }
      }
    });
    db.prepare(
      "UPDATE import_batches SET status='committed', mapping=?, options=?, created=?, updated=?, skipped=?, failed=?, source_id=?, tags=?, committed_at=? WHERE id=?",
    ).run(
      JSON.stringify(mapping),
      JSON.stringify(options),
      counts.created,
      counts.updated,
      counts.skipped,
      counts.failed,
      defaultSource,
      JSON.stringify(options.tags ?? []),
      Date.now(),
      batchId,
    );
  })();
  return getImport(db, batchId)!;
}

/** Reverse a committed batch. Records edited after the import keep those edits only where the import did not create them. */
export function undoImport(
  db: HubDb,
  batchId: string,
  actor?: string | null,
): ImportBatch & { undo: { deleted: number; restored: number } } {
  const batch = getImport(db, batchId);
  if (!batch) throw new Error("import not found");
  if (batch.status !== "committed") throw new Error(`import is ${batch.status}, not committed`);
  const changes = db
    .prepare("SELECT * FROM import_changes WHERE batch_id = ?")
    .all(batchId) as Array<{
    subject_type: string;
    subject_id: string;
    action: string;
    before: string | null;
  }>;
  let deleted = 0;
  let restored = 0;
  db.transaction(() => {
    for (const ch of changes.filter((c) => c.subject_type === "deal")) {
      db.prepare("DELETE FROM activities WHERE subject_type='deal' AND subject_id = ?").run(
        ch.subject_id,
      );
      db.prepare("DELETE FROM deals WHERE id = ?").run(ch.subject_id);
    }
    for (const ch of changes.filter((c) => c.subject_type === "contact")) {
      if (ch.action === "created") {
        if (db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(ch.subject_id)) {
          deleteContact(db, ch.subject_id);
          deleted++;
        }
      } else if (ch.before) {
        const before = JSON.parse(ch.before) as { row: Row; tags: string[] };
        const cols = Object.keys(before.row).filter((c) => c !== "id");
        db.prepare(
          `UPDATE contacts SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        ).run(...cols.map((c) => before.row[c]), ch.subject_id);
        const now = (
          db
            .prepare(
              "SELECT t.name FROM taggings g JOIN tags t ON t.id=g.tag_id WHERE g.subject_type='contact' AND g.subject_id = ?",
            )
            .all(ch.subject_id) as Array<{ name: string }>
        ).map((t) => t.name);
        untagSubject(
          db,
          "contact",
          ch.subject_id,
          now.filter((t) => !before.tags.includes(t)),
        );
        tagSubject(db, "contact", ch.subject_id, before.tags);
        restored++;
      }
    }
    for (const ch of changes.filter(
      (c) => c.subject_type === "company" && c.action === "created",
    )) {
      const inUse = db
        .prepare(
          "SELECT 1 FROM contacts WHERE company_id = ? UNION SELECT 1 FROM deals WHERE company_id = ? LIMIT 1",
        )
        .get(ch.subject_id, ch.subject_id);
      if (inUse) continue;
      db.prepare("DELETE FROM taggings WHERE subject_type='company' AND subject_id = ?").run(
        ch.subject_id,
      );
      db.prepare("DELETE FROM activities WHERE subject_type='company' AND subject_id = ?").run(
        ch.subject_id,
      );
      db.prepare("DELETE FROM companies WHERE id = ?").run(ch.subject_id);
    }
    db.prepare("UPDATE import_batches SET status='undone', undone_at=? WHERE id=?").run(
      Date.now(),
      batchId,
    );
  })();
  for (const ch of changes.filter((c) => c.subject_type === "contact" && c.action === "updated"))
    logActivity(db, {
      subjectType: "contact",
      subjectId: ch.subject_id,
      type: "import.undone",
      summary: `Import "${batch.fileName}" undone — fields restored`,
      actor,
    });
  return { ...getImport(db, batchId)!, undo: { deleted, restored } };
}
