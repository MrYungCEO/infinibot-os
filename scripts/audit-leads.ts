#!/usr/bin/env bun
/**
 * scripts/audit-leads.ts — Lead name audit (READ-ONLY)
 *
 * Classifies every lead's name field, attempts recovery from sibling
 * fields, and emits:
 *   leads-audit-report.json  — machine-readable, full detail per row
 *   leads-audit-summary.tsv  — human-readable tab-separated quick scan
 *
 * Run: bun scripts/audit-leads.ts
 */

import { Database } from "bun:sqlite";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const DB_PATH = join(process.cwd(), "state", "funnels", "funnels.db");

if (!existsSync(DB_PATH)) {
  console.error(`ERROR: funnels.db not found at ${DB_PATH}`);
  process.exit(1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type NameCategory =
  | "OK"
  | "NUMERIC_ID"
  | "PLACEHOLDER"
  | "GARBAGE_TOKENS"
  | "EMAIL_AS_NAME"
  | "TOO_SHORT";

interface LeadRow {
  id: string;
  business_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  status: string;
  custom_fields: string;
}

interface AuditEntry {
  id: string;
  businessId: string;
  currentName: string;
  category: NameCategory;
  recoveredName: string | null;
  recoverable: boolean;
  recoverySource: string | null;
  sampleOtherFields: { email?: string; company?: string };
}

// ── Name classification ───────────────────────────────────────────────────────

const PLACEHOLDER_SET = new Set([
  "uncategorized",
  "unknown",
  "null",
  "n/a",
  "na",
  "n\\a",
  "none",
  "lead",
  "test",
  "anonymous",
  "noreply",
  "no-reply",
  "(no name)",
  "unnamed",
  "?",
  "-",
  "–",
  "—",
  "no name",
  "untitled",
  "test lead",
  "test user",
  "new lead",
  "new contact",
  "placeholder",
  "sample",
  "demo",
  "contact",
  "person",
  "user",
]);

function classifyName(name: string): NameCategory {
  const trimmed = (name ?? "").trim();

  // Empty / whitespace-only
  if (!trimmed) return "PLACEHOLDER";

  // Single character
  if (trimmed.length === 1) return "TOO_SHORT";

  // Email leaked into name field
  if (trimmed.includes("@")) return "EMAIL_AS_NAME";

  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_SET.has(lower)) return "PLACEHOLDER";

  // Pure numeric: "12345"
  if (/^\d+$/.test(trimmed)) return "NUMERIC_ID";
  // "Lead #123" / "Lead123" / "lead_42"
  if (/^lead\s*#?\s*\d+$/i.test(trimmed)) return "NUMERIC_ID";
  // "id_12345" / "id-42" / "contact_99"
  if (/^(id|contact|lead)[_\s-]?\d+$/i.test(trimmed)) return "NUMERIC_ID";

  // UUID (any variant)
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    return "GARBAGE_TOKENS";
  }

  // URL fragment
  if (/^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed)) {
    return "GARBAGE_TOKENS";
  }

  // Slug/handle: all lowercase + alphanumerics + separators, with at least one
  // separator or digit → "john.doe42", "user_123", "first.last", "my-handle"
  // No uppercase means it's NOT a capitalised name like "J. Smith"
  if (
    /^[a-z0-9][a-z0-9._-]*$/.test(trimmed) &&
    /[._\-\d]/.test(trimmed)
  ) {
    return "GARBAGE_TOKENS";
  }

  // OK: needs ≥ 2 letter-rich tokens  OR  1 token with ≥ 3 letters
  const tokens = trimmed.split(/[\s,]+/).filter((t) => t.length > 0);
  // A token is "rich" if it has ≥ 2 consecutive letters, or is an initial "A."
  const richTokens = tokens.filter(
    (t) => /[a-zA-Z]{2,}/.test(t) || /^[A-Za-z]\.$/.test(t),
  );

  if (richTokens.length >= 2) return "OK";
  if (tokens.length === 1 && /[a-zA-Z]{3,}/.test(trimmed)) return "OK";
  // Multi-word names like "Li Wei" (two short tokens each with letters)
  if (
    tokens.length >= 2 &&
    tokens.some((t) => /[a-zA-Z]{3,}/.test(t))
  )
    return "OK";

  return "TOO_SHORT";
}

// ── Name recovery ─────────────────────────────────────────────────────────────

function deriveNameFromEmailLocal(local: string): string | null {
  // Drop trailing digits: "john42" → "john"
  const withoutDigits = local.replace(/\d+$/, "");
  if (!withoutDigits) return null;
  // Split on . _ -
  const parts = withoutDigits.split(/[._-]/);
  const meaningful = parts.filter(
    (p) => p.length >= 2 && /[a-zA-Z]{2,}/.test(p),
  );
  if (meaningful.length === 0) return null;
  // Title-case each part
  return meaningful
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function tryRecoverName(
  row: LeadRow,
): { name: string; source: string } | null {
  let cf: Record<string, unknown> = {};
  try {
    cf = JSON.parse(row.custom_fields || "{}");
  } catch {
    /* malformed JSON — treat as empty */
  }

  // 1. firstName + lastName in customFields
  const cfFirst =
    typeof cf.firstName === "string" ? cf.firstName.trim() : "";
  const cfLast =
    typeof cf.lastName === "string" ? cf.lastName.trim() : "";
  if (cfFirst && cfLast) {
    const combined = `${cfFirst} ${cfLast}`;
    if (classifyName(combined) === "OK")
      return {
        name: combined,
        source: "customFields.firstName+lastName",
      };
  }
  if (cfFirst && cfFirst.length >= 3 && /[a-zA-Z]{3,}/.test(cfFirst)) {
    return { name: cfFirst, source: "customFields.firstName" };
  }

  // 2. Known full-name keys in customFields
  for (const key of [
    "full_name",
    "fullName",
    "displayName",
    "contactName",
    "contact_name",
  ]) {
    const v =
      typeof cf[key] === "string" ? (cf[key] as string).trim() : "";
    if (v && classifyName(v) === "OK")
      return { name: v, source: `customFields.${key}` };
  }

  // 3. Email → derive from local-part
  const emailsToTry: string[] = [];
  if (row.email) emailsToTry.push(row.email);
  if (typeof cf.email === "string") emailsToTry.push(cf.email as string);
  for (const email of emailsToTry) {
    const atIdx = email.indexOf("@");
    const local = atIdx >= 0 ? email.slice(0, atIdx) : email;
    const domain = atIdx >= 0 ? email.slice(atIdx + 1) : "?";
    const derived = deriveNameFromEmailLocal(local);
    if (derived) return { name: derived, source: `email@${domain}` };
  }

  // 4. Company as B2B fallback
  const directCompany = row.company?.trim() ?? "";
  const cfCompany =
    typeof cf.company === "string"
      ? (cf.company as string).trim()
      : typeof cf.companyName === "string"
        ? (cf.companyName as string).trim()
        : "";
  const company = directCompany || cfCompany;
  if (company) {
    const source = directCompany ? "company" : "customFields.company";
    return { name: `Contact at ${company}`, source };
  }

  return null; // UNRECOVERABLE
}

// ── Main ──────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

const businesses = db
  .query(
    "SELECT id, name FROM businesses WHERE archived_at IS NULL ORDER BY created_at",
  )
  .all() as Array<{ id: string; name: string }>;

if (businesses.length === 0) {
  console.warn("WARNING: No active businesses found in funnels.db.");
}

interface BusinessReport {
  businessId: string;
  businessName: string;
  total: number;
  counts: Record<NameCategory, number>;
  nonOkEntries: AuditEntry[];
}

const allEntries: AuditEntry[] = [];
const businessReports: BusinessReport[] = [];

const leadsQuery = db.query<LeadRow, [string]>(
  `SELECT id, business_id, name, email, phone, company, title, status, custom_fields
   FROM leads WHERE business_id = ? AND archived_at IS NULL`,
);

for (const biz of businesses) {
  const leads = leadsQuery.all(biz.id);

  const counts: Record<NameCategory, number> = {
    OK: 0,
    NUMERIC_ID: 0,
    PLACEHOLDER: 0,
    GARBAGE_TOKENS: 0,
    EMAIL_AS_NAME: 0,
    TOO_SHORT: 0,
  };

  const entries: AuditEntry[] = [];

  for (const lead of leads) {
    const category = classifyName(lead.name);
    counts[category]++;
    if (category === "OK") continue;

    const recovery = tryRecoverName(lead);
    entries.push({
      id: lead.id,
      businessId: lead.business_id,
      currentName: lead.name,
      category,
      recoveredName: recovery?.name ?? null,
      recoverable: recovery !== null,
      recoverySource: recovery?.source ?? null,
      sampleOtherFields: {
        ...(lead.email ? { email: lead.email } : {}),
        ...(lead.company ? { company: lead.company } : {}),
      },
    });
    allEntries.push(entries[entries.length - 1]);
  }

  businessReports.push({
    businessId: biz.id,
    businessName: biz.name,
    total: leads.length,
    counts,
    nonOkEntries: entries,
  });
}

db.close();

// ── JSON report ───────────────────────────────────────────────────────────────

const jsonReport = {
  generatedAt: new Date().toISOString(),
  dbPath: DB_PATH,
  businesses: businessReports,
};

const JSON_OUT = join(process.cwd(), "leads-audit-report.json");
const TSV_OUT = join(process.cwd(), "leads-audit-summary.tsv");

writeFileSync(JSON_OUT, JSON.stringify(jsonReport, null, 2));
console.log(`Wrote ${JSON_OUT}`);

// ── TSV summary ───────────────────────────────────────────────────────────────

const tsvLines: string[] = [
  [
    "id",
    "businessName",
    "category",
    "currentName",
    "recoverable",
    "recoveredName",
    "recoverySource",
    "email",
    "company",
  ].join("\t"),
];

const bizNameMap = Object.fromEntries(
  businessReports.map((b) => [b.businessId, b.businessName]),
);

for (const e of allEntries) {
  tsvLines.push(
    [
      e.id,
      bizNameMap[e.businessId] ?? e.businessId,
      e.category,
      e.currentName,
      e.recoverable ? "YES" : "NO",
      e.recoveredName ?? "",
      e.recoverySource ?? "",
      e.sampleOtherFields.email ?? "",
      e.sampleOtherFields.company ?? "",
    ]
      .map((v) =>
        String(v)
          .replace(/\t/g, " ")
          .replace(/\n/g, " "),
      )
      .join("\t"),
  );
}

writeFileSync(TSV_OUT, tsvLines.join("\n") + "\n");
console.log(`Wrote ${TSV_OUT}`);

// ── Console summary ───────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────");
console.log("AUDIT SUMMARY");
console.log("──────────────────────────────────────────────");
for (const b of businessReports) {
  console.log(`\nBusiness: "${b.businessName}" (${b.businessId})`);
  console.log(`  Total leads: ${b.total}`);
  for (const [cat, cnt] of Object.entries(b.counts) as [
    NameCategory,
    number,
  ][]) {
    if (cnt > 0) console.log(`    ${cat.padEnd(16)}: ${cnt}`);
  }
  const fixable = b.nonOkEntries.filter((e) => e.recoverable).length;
  const toQuarantine = b.nonOkEntries.filter(
    (e) => !e.recoverable,
  ).length;
  console.log(
    `  → would-fix: ${fixable}  would-quarantine: ${toQuarantine}`,
  );
}
console.log("\n──────────────────────────────────────────────");
console.log(
  `Total non-OK: ${allEntries.length}  |  Recoverable: ${allEntries.filter((e) => e.recoverable).length}  |  Unrecoverable: ${allEntries.filter((e) => !e.recoverable).length}`,
);
console.log("\nNext step: review leads-audit-summary.tsv, then run:");
console.log("  bun scripts/fix-leads.ts --mode=dry");
console.log(
  "  bun scripts/fix-leads.ts --mode=apply  (after operator review)",
);
