/**
 * Business hub — one-time (and safely re-runnable) migration of the legacy
 * lead / pipeline / campaign / submission stores into the hub
 * (docs/business/DATA_MODEL.md §4).
 *
 * Every imported record carries `legacy_ref`, so a second run is a no-op.
 * Legacy stores are only READ; a backup copy of each is written first.
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HubDb } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import { ensureSource, logActivity, tagSubject, upsertCompany, upsertContact } from "./contacts.js";
import { ingestLead } from "./automation.js";
import { createDeal, ensureDefaultPipeline, type Pipeline } from "./pipeline.js";
import { hubId, normalizeEmail, str, toMs } from "./util.js";
import { coerceString } from "../shared/text/coerce.js";

export const MIGRATION_KEY = "migration.v1";

export type MigrationReport = {
  at: number;
  backupDir: string | null;
  leadRows: number;
  agencyLeads: number;
  funnelLeads: number;
  campaigns: number;
  submissions: number;
  clientLinks: number;
  income: number;
  errors: string[];
};

type DbRowValue = {
  type: string;
  text?: string;
  markdown?: string;
  optionId?: string | null;
  optionIds?: string[];
  email?: string | null;
  phone?: string | null;
  url?: string | null;
  value?: number | null;
  iso?: string | null;
  checked?: boolean;
};

function valueText(v: DbRowValue | undefined, options?: Map<string, string>): string | null {
  if (!v) return null;
  switch (v.type) {
    case "title":
      return str(v.text);
    case "richText":
      return str(v.markdown);
    case "email":
      return str(v.email);
    case "phone":
      return str(v.phone);
    case "url":
      return str(v.url);
    case "number":
      return v.value === null || v.value === undefined ? null : String(v.value);
    case "date":
      return str(v.iso);
    case "checkbox":
      return v.checked ? "true" : null;
    case "select":
    case "status":
      return v.optionId ? (options?.get(v.optionId) ?? v.optionId) : null;
    case "multiSelect":
      return (v.optionIds ?? []).map((id) => options?.get(id) ?? id).join(",") || null;
    default:
      return null;
  }
}

const STAGE_ALIASES: Array<[RegExp, string]> = [
  [/^(new|lead|cold|open|backlog)$/i, "New"],
  [/contact|reached|outreach|sent/i, "Contacted"],
  [/engag|replied|respond|warm|interested|nurtur/i, "Engaged"],
  [/qualif|demo|meeting|call|discovery|hot/i, "Qualified"],
  [/propos|negotiat|quote|contract|pending/i, "Proposal"],
  [/won|closed won|customer|client|active|paid|in progress|completed/i, "Won"],
  [/lost|closed lost|dead|churn|unqualif|no fit/i, "Lost"],
];

export function mapStage(pipeline: Pipeline, raw: string | null): Pipeline["stages"][number] {
  const byName = (n: string) =>
    pipeline.stages.find((s) => s.name.toLowerCase() === n.toLowerCase());
  if (raw) {
    const exact = byName(raw.trim());
    if (exact) return exact;
    for (const [re, name] of STAGE_ALIASES)
      if (re.test(raw)) return byName(name) ?? pipeline.stages[0];
  }
  return pipeline.stages[0];
}

/** Copy legacy stores before touching anything (SQLite via VACUUM INTO for WAL safety). */
export function backupLegacyStores(stateDir: string, paths: string[]): string | null {
  const present = paths.filter((p) => existsSync(p));
  if (!present.length) return null;
  const dir = join(
    stateDir,
    "backups",
    `business-hub-migration-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const p of present) {
    const dest = join(
      dir,
      p
        .replace(stateDir, "")
        .replace(/^[/\\]+/, "")
        .replace(/[/\\]/g, "__"),
    );
    if (p.endsWith(".db")) {
      const src = new Database(p, { readonly: true, fileMustExist: true });
      try {
        src.prepare("VACUUM INTO ?").run(dest);
      } finally {
        src.close();
      }
    } else copyFileSync(p, dest);
  }
  return dir;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip torn lines */
    }
  }
  return out;
}

function pick(obj: Record<string, unknown>, re: RegExp): string | null {
  for (const [k, v] of Object.entries(obj))
    if (re.test(k) && typeof v === "string" && v.trim()) return v.trim();
  return null;
}

export type MigrationDeps = {
  /** Rows of the leads-role database: { id, title, values(by property name) }. */
  loadLeadRows?: () => Promise<Array<{ id: string; values: Record<string, string | null> }>>;
  /** Agency clients (id, name, email, billingEmail, pipelineStatus). */
  loadAgencyClients?: () => Array<{
    id: string;
    name: string;
    email: string | null;
    billingEmail: string | null;
    phone: string | null;
    pipelineStatus: string;
    createdAt: number;
  }>;
  /** Legacy income import (revenue module). */
  migrateIncome?: (db: HubDb, stateDir: string) => number | Promise<number>;
  cwd?: string;
};

/** Default loaders bound to the real stores for a state dir. */
export function defaultMigrationDeps(stateDir: string): MigrationDeps {
  return {
    async loadLeadRows() {
      const { getDatabasesStore } = await import("../databases/store.js");
      const store = getDatabasesStore(stateDir);
      const resolved = store.resolveSystemRole("leads");
      if (!resolved) return [];
      const props = resolved.properties;
      const opts = new Map<string, Map<string, string>>();
      for (const p of props)
        opts.set(p.id, new Map((p.config?.options ?? []).map((o) => [o.id, o.name])));
      return store.listRows(resolved.database.id).map((row) => {
        const values: Record<string, string | null> = {};
        for (const p of props)
          values[p.name] = valueText(row.values[p.id] as DbRowValue | undefined, opts.get(p.id));
        values.__title = row.title;
        values.__body = row.body;
        return { id: row.id, values };
      });
    },
    loadAgencyClients() {
      const path = join(stateDir, "agency-operations", "agency.db");
      if (!existsSync(path)) return [];
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        return (
          db
            .prepare(
              "SELECT id, name, email, billing_email, phone, pipeline_status, created_at FROM clients",
            )
            .all() as Array<Record<string, unknown>>
        ).map((r) => ({
          id: r.id as string,
          name: r.name as string,
          email: (r.email as string) ?? null,
          billingEmail: (r.billing_email as string) ?? null,
          phone: (r.phone as string) ?? null,
          pipelineStatus: coerceString(r.pipeline_status),
          createdAt: r.created_at as number,
        }));
      } finally {
        db.close();
      }
    },
  };
}

/** Run the migration once per state dir (force re-runs; legacy_ref keeps it idempotent). */
export async function migrateLegacyBusinessData(
  db: HubDb,
  stateDir: string,
  deps: MigrationDeps,
  opts: { force?: boolean } = {},
): Promise<MigrationReport | null> {
  if (!opts.force && getMeta(db, MIGRATION_KEY)) return null;
  const report: MigrationReport = {
    at: Date.now(),
    backupDir: null,
    leadRows: 0,
    agencyLeads: 0,
    funnelLeads: 0,
    campaigns: 0,
    submissions: 0,
    clientLinks: 0,
    income: 0,
    errors: [],
  };
  const cwd = deps.cwd ?? process.cwd();
  const roots = [...new Set([stateDir, join(cwd, "state")])];
  const legacyFiles = [
    join(stateDir, "databases.db"),
    join(stateDir, "agency-operations", "agency.db"),
    join(stateDir, "business", "income.json"),
    ...roots.flatMap((r) => [
      join(r, "funnels", "funnels.db"),
      join(r, "campaigns", "campaigns.db"),
    ]),
  ];
  try {
    report.backupDir = backupLegacyStores(stateDir, legacyFiles);
  } catch (err) {
    report.errors.push(`backup: ${String(err)}`);
    // Never migrate without a backup.
    return report;
  }
  const pipeline = ensureDefaultPipeline(db);

  // 1. Leads-role database rows → company + contact + deal.
  try {
    const rows = (await deps.loadLeadRows?.()) ?? [];
    for (const row of rows) {
      const ref = `dbrow:${row.id}`;
      if (db.prepare("SELECT 1 FROM deals WHERE legacy_ref = ?").get(ref)) continue;
      const v = row.values;
      const name = v.Name ?? v.__title ?? null;
      const email = normalizeEmail(v.Email);
      const sourceName = v.LeadSource ?? v.Source ?? "Leads database";
      const sourceId = ensureSource(db, "legacy", sourceName);
      const company =
        upsertCompany(
          db,
          {
            name: v.Company && !/^[a-z0-9_-]{20,}$/i.test(v.Company) ? v.Company : name,
            website: v.Website,
            phone: v.Phone,
            address: v.Address,
          },
          { sourceId, legacyRef: `${ref}:co`, actor: "migration" },
        )?.company ?? null;
      const contact =
        email || v.Phone
          ? (upsertContact(
              db,
              {
                name: email ? (name ?? email) : name,
                email,
                phone: v.Phone,
                companyId: company?.id ?? null,
                lifecycle: "lead",
                score: v.QualifierScore ? Number(v.QualifierScore) : undefined,
                emailOptIn: undefined,
                custom: {
                  qualifierReason: v.QualifierReason ?? undefined,
                  recommendedPitch: v.RecommendedPitch ?? undefined,
                  rating: v.Rating ?? undefined,
                  reviewCount: v.ReviewCount ?? undefined,
                },
              },
              { sourceId, legacyRef: ref, actor: "migration" },
            )?.contact ?? null)
          : null;
      if (contact && v.Unsubscribed === "true") {
        db.prepare(
          "INSERT OR IGNORE INTO suppressions(email, reason, source, created_at) SELECT email, 'unsubscribe', 'legacy', ? FROM contacts WHERE id = ? AND email IS NOT NULL",
        ).run(Date.now(), contact.id);
      }
      const stage = mapStage(pipeline, v.Stage ?? v.Status ?? v.LifecycleStatus);
      const deal = createDeal(
        db,
        {
          title: name ?? company?.name ?? "Lead",
          contactId: contact?.id ?? null,
          companyId: company?.id ?? null,
          stageId: stage.id,
          valueCents: v["Estimated Value"] ? Math.round(Number(v["Estimated Value"]) * 100) : 0,
          probability: v.Probability ? Number(v.Probability) : null,
          nextAction: v["Next Step"],
          nextActionAt: toMs(v["Next Action Date"] ?? v.NextTouchAt),
          lostReason: stage.kind === "lost" ? "Imported as lost" : null,
          sourceId,
        },
        { actor: "migration", legacyRef: ref, enforce: false },
      );
      const tags = (v.Tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (v.Temperature) tags.push(v.Temperature);
      if (tags.length)
        tagSubject(db, contact ? "contact" : "company", contact?.id ?? company!.id, tags);
      if (v.Notes || v.__body)
        logActivity(db, {
          subjectType: "deal",
          subjectId: deal.id,
          type: "note",
          summary: (v.Notes ?? v.__body ?? "").slice(0, 2000),
          actor: "migration",
        });
      report.leadRows++;
    }
  } catch (err) {
    report.errors.push(`lead rows: ${String(err)}`);
  }

  // 2. Agency clients: link hub contacts by email; open deals for "lead" clients.
  try {
    const clients = deps.loadAgencyClients?.() ?? [];
    for (const c of clients) {
      for (const e of [c.email, c.billingEmail]) {
        const email = normalizeEmail(e);
        if (!email) continue;
        const r = db
          .prepare("UPDATE contacts SET client_id = ? WHERE email = ? AND client_id IS NULL")
          .run(c.id, email);
        report.clientLinks += r.changes;
      }
      if (c.pipelineStatus !== "lead") continue;
      const ref = `agency-lead:${c.id}`;
      if (db.prepare("SELECT 1 FROM deals WHERE legacy_ref = ?").get(ref)) continue;
      const company =
        upsertCompany(
          db,
          { name: c.name, clientId: c.id, phone: c.phone },
          { actor: "migration", legacyRef: `${ref}:co` },
        )?.company ?? null;
      const email = normalizeEmail(c.email ?? c.billingEmail);
      const contact = email
        ? (upsertContact(
            db,
            { name: c.name, email, companyId: company?.id ?? null, clientId: c.id },
            { actor: "migration", legacyRef: ref },
          )?.contact ?? null)
        : null;
      createDeal(
        db,
        {
          title: c.name,
          companyId: company?.id ?? null,
          contactId: contact?.id ?? null,
          clientId: c.id,
          stageId: pipeline.stages[0].id,
          sourceId: ensureSource(db, "legacy", "Agency CRM"),
        },
        { actor: "migration", legacyRef: ref, enforce: false },
      );
      report.agencyLeads++;
    }
  } catch (err) {
    report.errors.push(`agency clients: ${String(err)}`);
  }

  // 3. funnels.db leads + campaigns.db campaigns (both legacy roots).
  for (const root of roots) {
    const funnels = join(root, "funnels", "funnels.db");
    if (existsSync(funnels)) {
      try {
        const fdb = new Database(funnels, { readonly: true, fileMustExist: true });
        try {
          const rows = fdb.prepare("SELECT * FROM leads").all() as Array<Record<string, unknown>>;
          for (const r of rows) {
            const ref = `funnel-lead:${String(r.id)}`;
            if (db.prepare("SELECT 1 FROM contacts WHERE legacy_ref = ?").get(ref)) continue;
            const sourceId = ensureSource(
              db,
              "legacy",
              `Funnel: ${coerceString(r.source, "lead")}`,
            );
            const contact = upsertContact(
              db,
              {
                name: str(r.name),
                email: str(r.email),
                phone: str(r.phone),
                title: str(r.title),
                company: r.company ? { name: str(r.company) } : null,
                lifecycle: "lead",
                score: Number(r.score ?? 0) || undefined,
              },
              { sourceId, legacyRef: ref, actor: "migration" },
            );
            if (!contact) continue;
            const stage = mapStage(pipeline, str(r.status));
            if (!db.prepare("SELECT 1 FROM deals WHERE contact_id = ?").get(contact.contact.id))
              createDeal(
                db,
                {
                  title: contact.contact.name,
                  contactId: contact.contact.id,
                  companyId: contact.contact.companyId,
                  stageId: stage.id,
                  valueCents: Math.round(Number(r.estimated_value ?? 0) * 100),
                  sourceId,
                  lostReason: stage.kind === "lost" ? "Imported as lost" : null,
                },
                { actor: "migration", legacyRef: `${ref}:deal`, enforce: false },
              );
            report.funnelLeads++;
          }
        } finally {
          fdb.close();
        }
      } catch (err) {
        report.errors.push(`funnels.db: ${String(err)}`);
      }
    }
    const campaigns = join(root, "campaigns", "campaigns.db");
    if (existsSync(campaigns)) {
      try {
        const cdb = new Database(campaigns, { readonly: true, fileMustExist: true });
        try {
          for (const r of cdb.prepare("SELECT * FROM campaigns").all() as Array<
            Record<string, unknown>
          >) {
            const ref = `campaigns-db:${String(r.id)}`;
            if (db.prepare("SELECT 1 FROM campaigns WHERE legacy_ref = ?").get(ref)) continue;
            const now = Date.now();
            db.prepare(
              "INSERT INTO campaigns(id,name,channel,status,goal,legacy_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            ).run(
              hubId("cmp"),
              coerceString(r.name, "Campaign"),
              "outbound",
              coerceString(r.status, "draft"),
              typeof r.goal === "string" ? r.goal : null,
              ref,
              Number(r.created_at ?? now) || now,
              now,
            );
            report.campaigns++;
          }
        } finally {
          cdb.close();
        }
      } catch (err) {
        report.errors.push(`campaigns.db: ${String(err)}`);
      }
    }
  }

  // 4. Form submissions that never became leads (JSONL logs).
  const submissionFiles: Array<{ path: string; source: string }> = [];
  for (const root of roots) {
    const lq = join(root, "lead-qualifier-forms");
    if (existsSync(lq))
      for (const f of readdirSync(lq))
        if (/^submissions-.*\.jsonl$/.test(f))
          submissionFiles.push({
            path: join(lq, f),
            source: `Lead qualifier form ${f.slice(12, -6)}`,
          });
    const lp = join(root, "landing-pages", "leads");
    if (existsSync(lp))
      for (const biz of readdirSync(lp))
        submissionFiles.push({
          path: join(lp, biz, "submissions.jsonl"),
          source: "Landing page form",
        });
    const fw = join(root, "funnels");
    if (existsSync(fw) && statSync(fw).isDirectory())
      for (const id of readdirSync(fw))
        submissionFiles.push({
          path: join(fw, id, "submissions.jsonl"),
          source: `Funnel page ${id.slice(0, 8)}`,
        });
  }
  for (const { path, source } of submissionFiles) {
    for (const rec of readJsonl(path)) {
      const data = (rec.data ?? rec.fields ?? rec.values ?? rec) as Record<string, unknown>;
      const email = normalizeEmail(pick(data, /e-?mail/i));
      const ref = `submission:${coerceString(rec.id, `${path}:${email}:${coerceString(rec.ts ?? rec.receivedAt)}`)}`;
      if (!email || getMeta(db, ref)) continue;
      const res = ingestLead(db, {
        email,
        name: pick(data, /^(full ?)?name$/i),
        phone: pick(data, /phone|tel/i),
        company: pick(data, /company|business/i),
        message: pick(data, /message|note|comment/i),
        fields: data,
        source: { kind: "form", name: source },
        occurredAt: toMs(rec.ts ?? rec.receivedAt ?? rec.createdAt) ?? undefined,
      });
      if (res) {
        setMeta(db, ref, res.contactId);
        report.submissions++;
      }
    }
  }

  // 5. Legacy income → revenue ledger.
  try {
    report.income = (await deps.migrateIncome?.(db, stateDir)) ?? 0;
  } catch (err) {
    report.errors.push(`income: ${String(err)}`);
  }

  setMeta(db, MIGRATION_KEY, JSON.stringify(report));
  return report;
}

export function migrationStatus(db: HubDb): MigrationReport | null {
  const raw = getMeta(db, MIGRATION_KEY);
  return raw ? (JSON.parse(raw) as MigrationReport) : null;
}
