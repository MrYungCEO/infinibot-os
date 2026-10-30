import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

import {
  DEFAULT_CLIENT_PIPELINE_STATUS,
  DEFAULT_CLIENT_PIPELINE_STATUS_LABEL,
  clientPipelineStatusFromNotes,
  deriveLegacyClientStatus,
  normalizeClientPipelineStatus,
} from "./client-status.js";
import type {
  ApprovalStatus,
  Agency,
  AgencyPaymentAccount,
  AgencyProfile,
  AgencyInvitation,
  AgencyMembership,
  AgencyProject,
  AgencyProjectStatus,
  AgencyRole,
  AgencyTask,
  AgencyTaskStatus,
  AuditEvent,
  BusinessSummary,
  ChangeRequest,
  ChangeRequestStatus,
  Client,
  ClientsNotionConfig,
  ClientApproval,
  Contact,
  Deliverable,
  DeliverableStatus,
  Engagement,
  EngagementStatus,
  ExternalPaymentReceipt,
  ExternalPaymentReceiptStatus,
  InvoicePaymentLink,
  Invoice,
  InvoiceDetail,
  InvoiceLineItem,
  InvoiceProjectLink,
  InvoiceStatus,
  Milestone,
  Opportunity,
  OpportunityStage,
  Payment,
  RevenueEntry,
  RevenueSummary,
  ClientRevenueProfile,
  Proposal,
  ProposalLineItem,
  ProposalSectionRecord,
  ProposalStatus,
  RevenuePipelineSummary,
} from "./types.js";
import type { ParsedInvoiceDocument } from "./invoice-parser.js";
import type {
  ExternalDriftVerdict,
  ExternalEntityLink,
  ExternalEntityType,
  ExternalProviderBinding,
  ExternalSyncDirection,
  ExternalSyncState,
} from "./external-links.js";
import {
  EXTERNAL_ENTITY_TYPES,
  classifyDrift,
  externalLinkId,
  hashAgencyEntity,
  isExternalEntityType,
  isExternalSyncDirection,
} from "./external-links.js";
import { DEFAULT_AGENCY_ID } from "./types.js";
import { AGENCY_DATABASE_SCHEMA_VERSION } from "./resilience.js";

type Row = Record<string, unknown>;
type ActorOptions = { agencyId?: string; actorId?: string | null };

export type AgencyReplicationTable = {
  name: string;
  columns: string[];
  primaryKey: string[];
  rows: Row[];
};

export type AgencyReplicationSnapshot = {
  schemaVersion: number;
  agencyId: string;
  sourceNodeId: string;
  exportedAt: number;
  digest: string;
  tables: AgencyReplicationTable[];
};

export type AgencyReplicationMergeResult = {
  agencyId: string;
  sourceNodeId: string;
  receivedDigest: string;
  localDigest: string;
  inserted: number;
  updated: number;
  keptLocal: number;
  unchanged: number;
  conflicts: number;
  mergedAt: number;
};

export type AgencyReplicationStatus = {
  agencyId: string;
  peerNodeId: string | null;
  state: "never_synced" | "in_sync" | "pending" | "offline" | "error";
  lastSyncAt: number | null;
  lastPushAt: number | null;
  lastPullAt: number | null;
  lastError: string | null;
  localDigest: string;
  remoteDigest: string | null;
  pending: boolean;
  conflicts: number;
};

const transitions = {
  opportunity: {
    lead: ["qualified", "lost"],
    qualified: ["proposal", "lost"],
    proposal: ["won", "lost"],
    won: [],
    lost: [],
  },
  proposal: {
    draft: ["internal_review"],
    internal_review: ["draft", "sent"],
    sent: ["accepted", "rejected", "expired"],
    accepted: [],
    rejected: [],
    expired: [],
  },
  engagement: {
    planned: ["active", "cancelled"],
    active: ["on_hold", "completed", "cancelled"],
    on_hold: ["active", "cancelled"],
    completed: [],
    cancelled: [],
  },
  deliverable: {
    backlog: ["in_progress"],
    in_progress: ["review", "backlog"],
    review: ["in_progress", "client_review"],
    client_review: ["approved", "changes_requested"],
    changes_requested: ["in_progress"],
    approved: [],
  },
  approval: {
    requested: ["approved", "rejected"],
    approved: [],
    rejected: [],
  },
  changeRequest: {
    draft: ["submitted"],
    submitted: ["approved", "rejected"],
    approved: ["implemented"],
    rejected: [],
    implemented: [],
  },
  invoice: {
    draft: ["issued", "void"],
    issued: ["partially_paid", "paid", "overdue", "void"],
    partially_paid: ["paid", "overdue", "void"],
    overdue: ["partially_paid", "paid", "void"],
    paid: [],
    void: [],
  },
  project: {
    planned: ["active", "cancelled"],
    active: ["on_hold", "completed", "cancelled"],
    on_hold: ["active", "cancelled"],
    completed: [],
    cancelled: [],
  },
  task: {
    backlog: ["ready", "cancelled"],
    ready: ["in_progress", "blocked", "cancelled"],
    in_progress: ["blocked", "review", "cancelled"],
    blocked: ["ready", "in_progress", "cancelled"],
    review: ["in_progress", "done"],
    done: [],
    cancelled: [],
  },
} as const;

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} required`);
  return normalized;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function transition(kind: keyof typeof transitions, from: string, to: string): void {
  const states = transitions[kind] as Record<string, readonly string[]>;
  const allowed = states[String(from)] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid ${kind} transition: ${String(from)} -> ${to}`);
  }
}

function camel(row: Row): any {
  const result: Row = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    result[name] = value;
  }
  return result;
}

/** Hydrate a `payment_accounts` row, coercing the integer `is_default` flag. */
function paymentAccountFromRow(row: Row): AgencyPaymentAccount {
  const c = camel(row) as AgencyPaymentAccount & { isDefault: unknown };
  return { ...c, isDefault: Boolean(c.isDefault) };
}

/** Hydrate a `clients` row, parsing the `data` JSON column. */
function hydrateClient(row: Row): Client {
  const c = camel(row) as Client & { data?: unknown };
  if (typeof c.data === "string") {
    try {
      const parsed = JSON.parse(c.data);
      c.data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      c.data = {};
    }
  } else if (!c.data || typeof c.data !== "object") {
    c.data = {};
  }
  return c as Client;
}

/** Hydrate a `clients_notion_config` row. */
function hydrateNotionConfig(row: Row): ClientsNotionConfig {
  return camel(row) as ClientsNotionConfig;
}

/**
 * `camel` plus the one JSON column. A payload that fails to parse is treated
 * as empty rather than throwing — a receipt whose display blob is corrupt must
 * still be listable, because it is the row a human needs in order to assign
 * the payment by hand.
 */
function hydrateReceipt(row: Row): ExternalPaymentReceipt {
  const value = camel(row) as ExternalPaymentReceipt & { payloadJson?: unknown };
  let payload: ExternalPaymentReceipt["payload"] = {};
  if (typeof value.payloadJson === "string") {
    try {
      const parsed = JSON.parse(value.payloadJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
    } catch {
      payload = {};
    }
  }
  delete value.payloadJson;
  return { ...value, payload };
}

/**
 * Shortest legal route from `from` to `to` through a status machine, excluding
 * `from` itself. `null` when the target is unreachable. Breadth-first, so the
 * caller never invents a transition the machine forbids — it just doesn't have
 * to enumerate the intermediate hops by hand.
 */
function shortestStatusPath(
  machine: Record<string, readonly string[]>,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [];
  const queue: Array<{ state: string; path: string[] }> = [{ state: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const { state, path } = queue.shift()!;
    for (const next of machine[state] ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ state: next, path: nextPath });
    }
  }
  return null;
}

/** A line item as the authoring API accepts it — the total is always derived. */
export interface InvoiceLineItemInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  cadence?: InvoiceLineItem["cadence"];
}

const INVOICE_CADENCES = ["one_time", "monthly", "quarterly", "annual"] as const;

function cadenceOf(value: unknown): InvoiceLineItem["cadence"] {
  return INVOICE_CADENCES.includes(value as never)
    ? (value as InvoiceLineItem["cadence"])
    : "one_time";
}

/** Monthly-equivalent value of a line item, in cents. `one_time` is not MRR. */
function monthlyEquivalentCents(cadence: InvoiceLineItem["cadence"], totalCents: number): number {
  switch (cadence) {
    case "monthly":
      return totalCents;
    case "quarterly":
      return Math.round(totalCents / 3);
    case "annual":
      return Math.round(totalCents / 12);
    default:
      return 0;
  }
}

function normalizeProposalSections(
  sections?: ProposalSectionRecord[] | null,
): ProposalSectionRecord[] {
  if (!Array.isArray(sections)) return [];
  return sections
    .map((section) => ({
      heading: String(section?.heading ?? "").trim(),
      body: String(section?.body ?? "").trim(),
    }))
    .filter((section) => section.heading || section.body);
}

function normalizeAcceptanceTerms(terms?: string[] | null): string[] {
  if (!Array.isArray(terms)) return [];
  return terms.map((term) => String(term ?? "").trim()).filter(Boolean);
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function proposalFromRow(row: Row, lineItems: ProposalLineItem[]): Proposal {
  const proposal = camel(row) as Proposal & {
    sectionsJson?: unknown;
    acceptanceTermsJson?: unknown;
  };
  proposal.sections = parseJsonArray<ProposalSectionRecord>(proposal.sectionsJson);
  proposal.acceptanceTerms = parseJsonArray<string>(proposal.acceptanceTermsJson);
  delete proposal.sectionsJson;
  delete proposal.acceptanceTermsJson;
  proposal.lineItems = lineItems;
  return proposal;
}

function requireExternalEntityType(value: unknown): ExternalEntityType {
  if (!isExternalEntityType(value))
    throw new Error("entityType must be client|project|task|invoice");
  return value;
}

function requireExternalSyncDirection(value: unknown): ExternalSyncDirection {
  if (!isExternalSyncDirection(value)) {
    throw new Error("syncDirection must be pull|push|bidirectional");
  }
  return value;
}

function requireExternalSyncState(value: unknown): ExternalSyncState {
  const states = ["in_sync", "local_ahead", "remote_ahead", "conflict", "error"];
  if (typeof value !== "string" || !states.includes(value)) throw new Error("invalid syncState");
  return value as ExternalSyncState;
}

function externalBindingFromRow(row: Row): ExternalProviderBinding {
  const value = camel(row);
  let schema: Record<string, unknown> | null = null;
  if (typeof value.schemaJson === "string") {
    try {
      schema = JSON.parse(value.schemaJson) as Record<string, unknown>;
    } catch {
      schema = null;
    }
  }
  delete value.schemaJson;
  return { ...value, schema } as ExternalProviderBinding;
}

function externalLinkFromRow(row: Row): ExternalEntityLink {
  return camel(row) as ExternalEntityLink;
}

export class AgencyOperationsStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const version = (
      this.db.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_migrations").get() as {
        version: number;
      }
    ).version;
    if (version < 1) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE clients (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, name TEXT NOT NULL,
            legal_name TEXT, status TEXT NOT NULL CHECK(status IN ('prospect','active','inactive')),
            owner_id TEXT, billing_email TEXT, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE contacts (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, title TEXT,
            is_primary INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX one_primary_contact ON contacts(client_id) WHERE is_primary = 1;
          CREATE TABLE opportunities (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id),
            name TEXT NOT NULL, stage TEXT NOT NULL, value_cents INTEGER NOT NULL, probability REAL NOT NULL,
            owner_id TEXT, expected_close_at INTEGER, lost_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE proposals (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
            title TEXT NOT NULL, status TEXT NOT NULL, scope TEXT NOT NULL, currency TEXT NOT NULL,
            valid_until INTEGER, subtotal_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE proposal_line_items (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
            description TEXT NOT NULL, quantity REAL NOT NULL, unit_price_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, sort_order INTEGER NOT NULL
          );
          CREATE TABLE engagements (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id),
            proposal_id TEXT REFERENCES proposals(id), name TEXT NOT NULL, status TEXT NOT NULL, budget_cents INTEGER NOT NULL,
            start_at INTEGER, target_end_at INTEGER, owner_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE milestones (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
            name TEXT NOT NULL, due_at INTEGER, completed_at INTEGER, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE deliverables (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
            milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL, name TEXT NOT NULL, status TEXT NOT NULL,
            acceptance_criteria TEXT NOT NULL, assignee_type TEXT, assignee_id TEXT, due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE client_approvals (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, engagement_id TEXT NOT NULL REFERENCES engagements(id),
            deliverable_id TEXT REFERENCES deliverables(id), status TEXT NOT NULL,
            requested_from_contact_id TEXT REFERENCES contacts(id), note TEXT, decided_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE change_requests (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, engagement_id TEXT NOT NULL REFERENCES engagements(id),
            status TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, impact_cents INTEGER NOT NULL,
            impact_days INTEGER NOT NULL, requested_by_contact_id TEXT REFERENCES contacts(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE invoices (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES clients(id),
            engagement_id TEXT REFERENCES engagements(id), number TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL,
            subtotal_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, amount_paid_cents INTEGER NOT NULL DEFAULT 0,
            issued_at INTEGER, due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            UNIQUE(agency_id, number)
          );
          CREATE TABLE payments (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, invoice_id TEXT NOT NULL REFERENCES invoices(id),
            amount_cents INTEGER NOT NULL, paid_at INTEGER NOT NULL, method TEXT, reference TEXT, created_at INTEGER NOT NULL
          );
          CREATE TABLE audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, agency_id TEXT NOT NULL, actor_id TEXT,
            entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
            before_json TEXT, after_json TEXT, created_at INTEGER NOT NULL
          );
          CREATE INDEX clients_org_status ON clients(agency_id, status);
          CREATE INDEX opportunities_org_stage ON opportunities(agency_id, stage);
          CREATE INDEX engagements_org_status ON engagements(agency_id, status);
          CREATE INDEX deliverables_engagement_status ON deliverables(engagement_id, status);
          CREATE INDEX invoices_org_status ON invoices(agency_id, status);
          CREATE INDEX audit_entity ON audit_events(agency_id, entity_type, entity_id);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)")
          .run(Date.now());
      })();
    }
    if (version < 2) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE agencies (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
            owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE agency_memberships (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(agency_id, user_id)
          );
          CREATE INDEX agency_memberships_user ON agency_memberships(user_id);
          CREATE TABLE agency_invitations (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')),
            token_hash TEXT NOT NULL UNIQUE, invited_by_user_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
          );
          CREATE INDEX agency_invitations_agency_email ON agency_invitations(agency_id, email);
          CREATE TABLE agency_projects (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            client_id TEXT REFERENCES clients(id), name TEXT NOT NULL, status TEXT NOT NULL,
            owner_id TEXT, start_at INTEGER, target_end_at INTEGER, budget_cents INTEGER NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE INDEX agency_projects_scope ON agency_projects(agency_id, status);
          CREATE TABLE agency_tasks (
            id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES agency_projects(id) ON DELETE CASCADE,
            parent_task_id TEXT REFERENCES agency_tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
            assignee_type TEXT, assignee_id TEXT, acceptance_criteria TEXT NOT NULL,
            due_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE INDEX agency_tasks_scope ON agency_tasks(agency_id, project_id, status);
        `);
        const now = Date.now();
        this.db
          .prepare(
            "INSERT INTO agencies(id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
          )
          .run(DEFAULT_AGENCY_ID, "Default Agency", "default", "system", now, now);
        this.db
          .prepare(
            "INSERT INTO agency_memberships(agency_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)",
          )
          .run(DEFAULT_AGENCY_ID, "system", "owner", now, now);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)")
          .run(now);
      })();
    }
    if (version < 3) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE agency_profiles (
            agency_id TEXT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
            industry TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '',
            context TEXT NOT NULL DEFAULT '', logo TEXT, website TEXT, email TEXT,
            phone TEXT, address TEXT, tagline TEXT, branding_json TEXT,
            social_media_json TEXT, legacy_business_id TEXT UNIQUE,
            legacy_snapshot_json TEXT, imported_at INTEGER, updated_at INTEGER NOT NULL
          );
          CREATE TABLE legacy_entity_mappings (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            source_type TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
            source_hash TEXT NOT NULL, migrated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(agency_id, source_type, source_id),
            UNIQUE(source_type, target_id)
          );
          CREATE INDEX legacy_entity_target ON legacy_entity_mappings(agency_id, target_id);
          CREATE TABLE legacy_migration_runs (
            id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, source_path TEXT NOT NULL,
            source_hash TEXT NOT NULL, status TEXT NOT NULL,
            report_json TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER
          );
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)")
          .run(Date.now());
      })();
    }
    if (version < 4) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE invoice_line_items (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            description TEXT NOT NULL,
            quantity REAL NOT NULL,
            unit_price_cents INTEGER NOT NULL,
            total_cents INTEGER NOT NULL,
            cadence TEXT NOT NULL CHECK(cadence IN ('one_time','monthly','quarterly','annual')),
            sort_order INTEGER NOT NULL
          );
          CREATE INDEX invoice_line_items_invoice ON invoice_line_items(agency_id, invoice_id, sort_order);
          CREATE TABLE invoice_imports (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            source_hash TEXT NOT NULL,
            source_name TEXT,
            source_text TEXT NOT NULL,
            parsed_json TEXT NOT NULL,
            confidence REAL NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(agency_id, source_hash)
          );
          CREATE TABLE revenue_entries (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
            source_type TEXT NOT NULL CHECK(source_type IN ('invoice_issued','payment_received','manual_adjustment')),
            source_id TEXT NOT NULL,
            amount_cents INTEGER NOT NULL,
            currency TEXT NOT NULL,
            recurring_monthly_cents INTEGER NOT NULL DEFAULT 0,
            description TEXT NOT NULL,
            recognized_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(agency_id, source_type, source_id)
          );
          CREATE INDEX revenue_entries_period ON revenue_entries(agency_id, recognized_at, source_type);
          CREATE INDEX revenue_entries_client ON revenue_entries(agency_id, client_id, recognized_at);
          CREATE TABLE client_revenue_profiles (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            currency TEXT NOT NULL,
            mrr_cents INTEGER NOT NULL DEFAULT 0,
            arr_cents INTEGER NOT NULL DEFAULT 0,
            last_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
            active_since INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(agency_id, client_id)
          );
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)")
          .run(Date.now());
      })();
    }
    if (version < 5) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE invoice_project_links (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES agency_projects(id) ON DELETE CASCADE,
            allocation_cents INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(invoice_id, project_id)
          );
          CREATE INDEX invoice_project_links_scope
            ON invoice_project_links(agency_id, project_id, invoice_id);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?)")
          .run(Date.now());
      })();
    }
    if (version < 6) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE agency_replication_state (
            agency_id TEXT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
            peer_node_id TEXT,
            last_sync_at INTEGER,
            last_push_at INTEGER,
            last_pull_at INTEGER,
            last_status TEXT NOT NULL DEFAULT 'never_synced',
            last_error TEXT,
            local_digest TEXT,
            remote_digest TEXT,
            conflicts_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE agency_replication_conflicts (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            table_name TEXT NOT NULL,
            row_key TEXT NOT NULL,
            local_json TEXT NOT NULL,
            remote_json TEXT NOT NULL,
            local_version INTEGER,
            remote_version INTEGER,
            winner TEXT NOT NULL CHECK(winner IN ('local','remote','deterministic')),
            source_node_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            resolved_at INTEGER
          );
          CREATE INDEX agency_replication_conflicts_scope
            ON agency_replication_conflicts(agency_id, resolved_at, created_at);
          CREATE TABLE agency_tombstones (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            entity_table TEXT NOT NULL,
            row_key TEXT NOT NULL,
            deleted_at INTEGER NOT NULL,
            source_node_id TEXT NOT NULL,
            PRIMARY KEY(agency_id, entity_table, row_key)
          );
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (6, ?)")
          .run(Date.now());
      })();
    }
    let prunedAuditRows = 0;
    if (version < 7) {
      this.db.transaction(() => {
        // listAgencyAuditEvents orders by id DESC, but the only audit index was
        // (agency_id, entity_type, entity_id). SQLite therefore matched the
        // agency then built a temp B-tree over every row in it just to return
        // the newest 100 — on a large log that blocks the gateway event loop
        // for minutes, because better-sqlite3 is synchronous. Indexing
        // (agency_id, id DESC) lets the same query walk the index backwards
        // and stop after LIMIT rows.
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS audit_agency_recent
            ON audit_events(agency_id, id DESC);
        `);
        // legacy_synced rows record that a re-import found an entity unchanged.
        // legacy_entity_mappings already stores the authoritative source hash,
        // so these carry no information the store cannot reconstruct, and a
        // repeatedly re-run migration can generate hundreds of thousands of
        // them. Drop them; genuine legacy_imported events are preserved.
        prunedAuditRows = this.db
          .prepare("DELETE FROM audit_events WHERE action='legacy_synced'")
          .run().changes;
        // Profile audits used to embed the whole imported business.json on both
        // sides of every update, which dwarfed the rest of the database. The
        // event itself is the record worth keeping; drop the oversized bodies.
        prunedAuditRows += this.db
          .prepare(
            `UPDATE audit_events SET before_json=NULL, after_json=NULL
             WHERE LENGTH(COALESCE(before_json,'')) + LENGTH(COALESCE(after_json,'')) > 65536`,
          )
          .run().changes;
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (7, ?)")
          .run(Date.now());
      })();
      // Deleting rows only frees pages for reuse inside the file. A repeatedly
      // re-run migration can leave hundreds of megabytes of them, so reclaim
      // the space once, here, rather than carrying it forever. VACUUM cannot
      // run inside a transaction.
      if (prunedAuditRows > 0) this.db.exec("VACUUM");
    }
    if (version < 8) {
      this.db.transaction(() => {
        // agency.db becomes the single source of truth and Notion becomes one
        // of its mirrors. Two tables carry that: a *binding* says "this
        // provider database mirrors this entity type", and a *link* says "this
        // agency row is that provider record". Both are pure DDL plus a
        // handful of indexes over tables that hold thousands (not millions) of
        // rows, so this runs in milliseconds at gateway boot.
        //
        // Deliberately absent: any credential column. Provider tokens live in
        // the Notion config and must never reach a replicated database.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS external_provider_bindings (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            entity_type TEXT NOT NULL
              CHECK(entity_type IN ('client','project','task','invoice')),
            external_database_id TEXT NOT NULL,
            external_database_name TEXT,
            schema_json TEXT,
            sync_direction TEXT NOT NULL DEFAULT 'bidirectional'
              CHECK(sync_direction IN ('pull','push','bidirectional')),
            last_pull_at INTEGER,
            last_push_at INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(agency_id, provider, entity_type)
          );
          CREATE INDEX IF NOT EXISTS external_provider_bindings_database
            ON external_provider_bindings(agency_id, provider, external_database_id);

          CREATE TABLE IF NOT EXISTS external_entity_links (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            entity_type TEXT NOT NULL
              CHECK(entity_type IN ('client','project','task','invoice')),
            entity_id TEXT NOT NULL,
            external_database_id TEXT,
            external_id TEXT NOT NULL,
            external_url TEXT,
            -- The pair that makes no-drift detection possible: the local and
            -- remote content hashes as they stood at the last successful sync.
            local_hash TEXT NOT NULL,
            remote_hash TEXT NOT NULL,
            sync_direction TEXT NOT NULL DEFAULT 'bidirectional'
              CHECK(sync_direction IN ('pull','push','bidirectional')),
            sync_state TEXT NOT NULL DEFAULT 'in_sync'
              CHECK(sync_state IN ('in_sync','local_ahead','remote_ahead','conflict','error')),
            last_synced_at INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(agency_id, provider, entity_type, entity_id)
          );
          CREATE INDEX IF NOT EXISTS external_entity_links_entity
            ON external_entity_links(agency_id, entity_type, entity_id);
          -- Non-unique on purpose. A federated peer could legitimately carry a
          -- second row for the same remote record; a UNIQUE here would abort
          -- the entire merge transaction rather than let the sync resolve it.
          CREATE INDEX IF NOT EXISTS external_entity_links_remote
            ON external_entity_links(agency_id, provider, external_id);
          CREATE INDEX IF NOT EXISTS external_entity_links_state
            ON external_entity_links(agency_id, provider, entity_type, sync_state);

          -- Relation navigation. Every one of these columns already carried a
          -- foreign key; none of them carried an index, so "show me this
          -- client's projects/invoices/contacts" was a full scan of the
          -- agency's rows. These make the client -> * traversals index-driven.
          CREATE INDEX IF NOT EXISTS agency_projects_client
            ON agency_projects(agency_id, client_id);
          CREATE INDEX IF NOT EXISTS invoices_client
            ON invoices(agency_id, client_id);
          CREATE INDEX IF NOT EXISTS engagements_client
            ON engagements(agency_id, client_id);
          CREATE INDEX IF NOT EXISTS contacts_client
            ON contacts(agency_id, client_id);
          CREATE INDEX IF NOT EXISTS opportunities_client
            ON opportunities(agency_id, client_id);
          CREATE INDEX IF NOT EXISTS agency_tasks_project
            ON agency_tasks(agency_id, project_id);
          -- Lets a child row be checked against (agency_id, id) of its parent
          -- client in one index seek, which is what checkRelationIntegrity
          -- uses to find cross-tenant references.
          CREATE UNIQUE INDEX IF NOT EXISTS clients_agency_scope
            ON clients(agency_id, id);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?)")
          .run(Date.now());
      })();
    }
    if (version < 9) {
      this.db.transaction(() => {
        // Promote the *real* pipeline status to a first-class column.
        //
        // Until now `clients.status` was a three-value enum, so "Cold",
        // "Lead" and "no status at all" were indistinguishable `prospect`
        // rows and the two client screens could never agree. The real value
        // was preserved only as raw JSON inside `notes` — not queryable, not
        // groupable, not filterable.
        //
        // `ALTER TABLE ... ADD COLUMN` with a constant default is an O(1)
        // header edit in SQLite: no table rebuild, no row rewrite. That
        // matters because migrations run at gateway boot and block it.
        const columns = new Set(
          (this.db.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        );
        if (!columns.has("pipeline_status")) {
          this.db.exec(
            `ALTER TABLE clients ADD COLUMN pipeline_status TEXT NOT NULL DEFAULT '${DEFAULT_CLIENT_PIPELINE_STATUS}'`,
          );
        }
        if (!columns.has("pipeline_status_label")) {
          this.db.exec(
            `ALTER TABLE clients ADD COLUMN pipeline_status_label TEXT NOT NULL DEFAULT '${DEFAULT_CLIENT_PIPELINE_STATUS_LABEL}'`,
          );
        }
        // Supports "group/filter this agency's clients by pipeline status"
        // with a single index range scan instead of a full agency scan.
        this.db.exec(`CREATE INDEX IF NOT EXISTS clients_agency_pipeline_status
          ON clients(agency_id, pipeline_status);`);

        // Backfill from the notes blob, which is the only place the legacy
        // import ever recorded the real value. Bounded by client count (a few
        // hundred on the largest known install), and the rollup is recomputed
        // from the same source so both columns agree from the first boot.
        const update = this.db.prepare(
          `UPDATE clients SET pipeline_status=?, pipeline_status_label=?, status=?
           WHERE id=? AND (pipeline_status IS NOT ? OR pipeline_status_label IS NOT ? OR status IS NOT ?)`,
        );
        const rows = this.db.prepare("SELECT id, notes FROM clients").all() as Array<{
          id: string;
          notes: string | null;
        }>;
        for (const row of rows) {
          const pipeline = clientPipelineStatusFromNotes(row.notes);
          const rollup = deriveLegacyClientStatus(pipeline.status);
          update.run(
            pipeline.status,
            pipeline.label,
            rollup,
            row.id,
            pipeline.status,
            pipeline.label,
            rollup,
          );
        }
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (9, ?)")
          .run(Date.now());
      })();
    }
    if (version < 10) {
      this.db.transaction(() => {
        // Invoice/proposal *authoring*. Until now both tables could only be
        // written by the inbound parser (`ingestParsedInvoice`) and carried no
        // room for the things an outbound, client-facing document needs:
        // terms, notes, a PO reference, a tax label, or a link back to the
        // proposal the work was sold on.
        //
        // Every change here is `ALTER TABLE ... ADD COLUMN` with no default,
        // which SQLite applies as an O(1) header edit — no table rebuild — so
        // this stays inside the "migrations block gateway boot" budget even on
        // the owner's 400-client database.
        const ensure = (table: string, column: string, type: string) => {
          const columns = new Set(
            (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
              (row) => row.name,
            ),
          );
          if (!columns.has(column))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        };
        ensure("invoices", "proposal_id", "TEXT REFERENCES proposals(id)");
        ensure("invoices", "tax_label", "TEXT");
        ensure("invoices", "reference", "TEXT");
        ensure("invoices", "notes", "TEXT");
        ensure("invoices", "terms", "TEXT");
        ensure("proposals", "client_id", "TEXT");
        ensure("proposals", "number", "TEXT");
        ensure("proposals", "summary", "TEXT");
        ensure("proposals", "sections_json", "TEXT");
        ensure("proposals", "acceptance_terms_json", "TEXT");
        ensure("proposals", "accepted_at", "INTEGER");
        // Proposals always had an owning client — via the opportunity. Copy it
        // down so the document mapper and the expected-revenue rollup can read
        // it without a join. Bounded by proposal count (zero on the live
        // database today).
        this.db.exec(`
          UPDATE proposals SET client_id = (
            SELECT o.client_id FROM opportunities o
             WHERE o.id = proposals.opportunity_id AND o.agency_id = proposals.agency_id
          ) WHERE client_id IS NULL
        `);
        // Per-agency, per-series invoice/proposal numbering. A counter row
        // rather than `MAX(number)+1` so a deleted or voided document never
        // hands its number to the next one — the client already saw it.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS document_number_counters (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            series TEXT NOT NULL,
            next_seq INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(agency_id, series)
          );
          CREATE INDEX IF NOT EXISTS invoices_proposal
            ON invoices(agency_id, proposal_id);
          CREATE INDEX IF NOT EXISTS proposals_agency_status
            ON proposals(agency_id, status);
          -- Backdated documents are read by issue/payment date, not by
          -- creation date; without this a "what did we bill in March 2024"
          -- query scans the whole agency.
          CREATE INDEX IF NOT EXISTS invoices_agency_issued
            ON invoices(agency_id, issued_at);
          CREATE INDEX IF NOT EXISTS payments_agency_paid
            ON payments(agency_id, paid_at);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (10, ?)")
          .run(Date.now());
      })();
    }
    if (version < 11) {
      this.db.transaction(() => {
        // Hosted payment links + the reconciliation ledger.
        //
        // Two `CREATE TABLE`s and their indexes — no ALTER, no rewrite of an
        // existing table, so this is O(1) on the owner's database and stays
        // well inside the "migrations block gateway boot" budget.
        //
        // `external_payment_receipts` is keyed on the provider's own payment
        // id. That key is what makes reconciliation idempotent: a payment we
        // have already seen can never be applied to an invoice a second time,
        // however many times the sync is re-run.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS invoice_payment_links (
            invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            label TEXT,
            reference TEXT NOT NULL,
            amount_cents INTEGER NOT NULL,
            currency TEXT NOT NULL,
            plan_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS invoice_payment_links_external
            ON invoice_payment_links(agency_id, provider, external_id);
          CREATE INDEX IF NOT EXISTS invoice_payment_links_reference
            ON invoice_payment_links(agency_id, reference);
          CREATE INDEX IF NOT EXISTS invoice_payment_links_plan
            ON invoice_payment_links(agency_id, plan_id);

          CREATE TABLE IF NOT EXISTS external_payment_receipts (
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            id TEXT NOT NULL UNIQUE,
            amount_cents INTEGER NOT NULL,
            currency TEXT NOT NULL,
            paid_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('matched','unmatched','ignored')),
            match_reason TEXT,
            invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
            payment_id TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(agency_id, provider, external_id)
          );
          CREATE INDEX IF NOT EXISTS external_payment_receipts_status
            ON external_payment_receipts(agency_id, status, paid_at);
          CREATE INDEX IF NOT EXISTS external_payment_receipts_invoice
            ON external_payment_receipts(agency_id, invoice_id);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (11, ?)")
          .run(Date.now());
      })();
    }
    if (version < 12) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS client_revenue_log (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            amount_cents INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            note TEXT,
            logged_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS client_revenue_log_client
            ON client_revenue_log(agency_id, client_id, logged_at);

          CREATE TABLE IF NOT EXISTS client_activity_log (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            type TEXT NOT NULL DEFAULT 'note',
            note TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS client_activity_log_client
            ON client_activity_log(agency_id, client_id, created_at);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (12, ?)")
          .run(Date.now());
      })();
    }
    if (version < 13) {
      this.db.transaction(() => {
        // Add social/contact platform columns to clients.
        // ALTER TABLE ADD COLUMN with a constant default is O(1) in SQLite.
        const existingCols = (
          this.db.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>
        ).map((r) => r.name);
        for (const col of ["whatsapp", "telegram", "discord", "instagram", "phone", "email"]) {
          if (!existingCols.includes(col)) {
            this.db.exec(`ALTER TABLE clients ADD COLUMN ${col} TEXT`);
          }
        }
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (13, ?)")
          .run(Date.now());
      })();
    }
    if (version < 14) {
      this.db.transaction(() => {
        const existingCols = (
          this.db.prepare("PRAGMA table_info(clients)").all() as Array<{ name: string }>
        ).map((r) => r.name);
        // notion_page_id: tracks which Notion page this row came from
        if (!existingCols.includes("notion_page_id")) {
          this.db.exec("ALTER TABLE clients ADD COLUMN notion_page_id TEXT");
        }
        // data: JSON blob of all dynamic Notion properties
        if (!existingCols.includes("data")) {
          this.db.exec("ALTER TABLE clients ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
        }
        // last_synced: unix ms of last successful Notion sync
        if (!existingCols.includes("last_synced")) {
          this.db.exec("ALTER TABLE clients ADD COLUMN last_synced INTEGER");
        }
        // Unique index so upsert-by-notion-page-id is efficient
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS clients_notion_page
            ON clients(agency_id, notion_page_id)
            WHERE notion_page_id IS NOT NULL;

          CREATE TABLE IF NOT EXISTS clients_notion_config (
            agency_id TEXT PRIMARY KEY,
            notion_db_id TEXT,
            notion_db_name TEXT,
            schema_json TEXT,
            last_sync INTEGER,
            db_rows_migrated INTEGER NOT NULL DEFAULT 0
          );
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?)")
          .run(Date.now());
      })();
    }
    if (version < 15) {
      this.db.transaction(() => {
        // Reusable agency-level bank / payment options, plus a nullable link
        // from each invoice to the one it prints. The ALTER is an O(1) add of a
        // nullable column, so this stays inside the "migrations block gateway
        // boot" budget even on a large invoices table.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS payment_accounts (
            id TEXT PRIMARY KEY,
            agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            currency TEXT,
            bank_name TEXT,
            account_name TEXT,
            account_number TEXT,
            iban TEXT,
            swift TEXT,
            routing_number TEXT,
            instructions TEXT,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS payment_accounts_agency
            ON payment_accounts(agency_id, created_at);
        `);
        const invoiceCols = (
          this.db.prepare("PRAGMA table_info(invoices)").all() as Array<{ name: string }>
        ).map((r) => r.name);
        if (!invoiceCols.includes("payment_account_id")) {
          this.db.exec("ALTER TABLE invoices ADD COLUMN payment_account_id TEXT");
        }
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (15, ?)")
          .run(Date.now());
      })();
    }
    if (version < 16) {
      this.db.transaction(() => {
        // Manually-set MRR for a project. Until now MRR lived only on the
        // client (client_revenue_profiles) and was derived from recurring
        // invoices; a project carried no recurring-revenue figure at all.
        //
        // `ALTER TABLE ... ADD COLUMN` with a constant default is an O(1)
        // header edit in SQLite — no table rebuild, no row rewrite — so it
        // stays inside the "migrations block gateway boot" budget, and every
        // existing project row keeps its data and simply reads back mrr_cents=0.
        const columns = new Set(
          (
            this.db.prepare("PRAGMA table_info(agency_projects)").all() as Array<{ name: string }>
          ).map((column) => column.name),
        );
        if (!columns.has("mrr_cents")) {
          this.db.exec(
            "ALTER TABLE agency_projects ADD COLUMN mrr_cents INTEGER NOT NULL DEFAULT 0",
          );
        }
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (16, ?)")
          .run(Date.now());
      })();
    }
    const appliedVersion = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
      .pluck()
      .get() as number;
    if (appliedVersion > AGENCY_DATABASE_SCHEMA_VERSION) {
      throw new Error("agency database schema is newer than this runtime");
    }
    if (appliedVersion !== AGENCY_DATABASE_SCHEMA_VERSION) {
      throw new Error("agency database schema migration incomplete");
    }
  }

  private audit(
    entityType: string,
    entityId: string,
    action: string,
    before: unknown,
    after: unknown,
    options?: ActorOptions,
  ): void {
    this.db
      .prepare(`INSERT INTO audit_events
      (agency_id, actor_id, entity_type, entity_id, action, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        options?.agencyId ?? DEFAULT_AGENCY_ID,
        options?.actorId ?? null,
        entityType,
        entityId,
        action,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        Date.now(),
      );
  }

  createAgency(input: {
    id?: string;
    name: string;
    slug: string;
    ownerUserId: string;
    createdAt?: number;
  }): Agency {
    const now = Date.now();
    const slug = required(input.slug, "slug").toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("slug must be URL-safe");
    const agency: Agency = {
      id: input.id ? required(input.id, "id") : randomUUID(),
      name: required(input.name, "name"),
      slug,
      ownerUserId: required(input.ownerUserId, "ownerUserId"),
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO agencies VALUES (@id,@name,@slug,@ownerUserId,@createdAt,@updatedAt)")
        .run(agency);
      this.db
        .prepare("INSERT INTO agency_memberships VALUES (?,?,?,?,?)")
        .run(agency.id, agency.ownerUserId, "owner", now, now);
      this.audit("agency", agency.id, "created", null, agency, {
        agencyId: agency.id,
        actorId: agency.ownerUserId,
      });
    })();
    return agency;
  }

  getAgency(agencyId: string): Agency | null {
    const row = this.db.prepare("SELECT * FROM agencies WHERE id=?").get(agencyId) as
      | Row
      | undefined;
    return row ? camel(row) : null;
  }

  /**
   * Every agency on this node, irrespective of membership. Used by node-level
   * background workers (e.g. the workforce operating loop) that must service
   * all tenants rather than the agencies visible to one user.
   */
  listAgencies(): Agency[] {
    return (this.db.prepare("SELECT * FROM agencies ORDER BY name").all() as Row[]).map(
      (row) => camel(row) as Agency,
    );
  }

  updateAgency(
    agencyId: string,
    patch: { name?: string; slug?: string },
    actorId?: string,
  ): Agency {
    const before = this.getAgency(agencyId);
    if (!before) throw new Error("agency not found");
    const name = patch.name === undefined ? before.name : required(patch.name, "name");
    const slug =
      patch.slug === undefined ? before.slug : required(patch.slug, "slug").toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("slug must be URL-safe");
    const after = { ...before, name, slug, updatedAt: Date.now() };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE agencies SET name=?,slug=?,updated_at=? WHERE id=?")
        .run(after.name, after.slug, after.updatedAt, agencyId);
      this.audit("agency", agencyId, "updated", before, after, { agencyId, actorId });
    })();
    return after;
  }

  ensureAgencyMembership(agencyId: string, userId: string, role: AgencyRole): AgencyMembership {
    this.requireAgency(agencyId);
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO agency_memberships(agency_id,user_id,role,created_at,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(agency_id,user_id) DO UPDATE SET
      role=CASE WHEN agency_memberships.role='owner' THEN 'owner' ELSE excluded.role END,
      updated_at=excluded.updated_at`)
      .run(agencyId, required(userId, "userId"), role, now, now);
    const row = this.db
      .prepare("SELECT * FROM agency_memberships WHERE agency_id=? AND user_id=?")
      .get(agencyId, userId) as Row;
    return camel(row);
  }

  upsertAgencyProfile(profile: AgencyProfile, actorId?: string): AgencyProfile {
    this.requireAgency(profile.agencyId);
    const before = this.getAgencyProfile(profile.agencyId);
    if (
      before &&
      JSON.stringify({
        ...before,
        importedAt: profile.importedAt,
      }) === JSON.stringify(profile)
    ) {
      return before;
    }
    this.db
      .prepare(`INSERT INTO agency_profiles(
      agency_id,industry,plan,context,logo,website,email,phone,address,tagline,
      branding_json,social_media_json,legacy_business_id,legacy_snapshot_json,imported_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agency_id) DO UPDATE SET
      industry=excluded.industry,plan=excluded.plan,context=excluded.context,
      logo=excluded.logo,website=excluded.website,email=excluded.email,phone=excluded.phone,
      address=excluded.address,tagline=excluded.tagline,branding_json=excluded.branding_json,
      social_media_json=excluded.social_media_json,
      legacy_business_id=COALESCE(agency_profiles.legacy_business_id,excluded.legacy_business_id),
      legacy_snapshot_json=excluded.legacy_snapshot_json,
      imported_at=COALESCE(agency_profiles.imported_at,excluded.imported_at),
      updated_at=excluded.updated_at`)
      .run(
        profile.agencyId,
        profile.industry,
        profile.plan,
        profile.context,
        profile.logo,
        profile.website,
        profile.email,
        profile.phone,
        profile.address,
        profile.tagline,
        profile.branding == null ? null : JSON.stringify(profile.branding),
        profile.socialMedia == null ? null : JSON.stringify(profile.socialMedia),
        profile.legacyBusinessId,
        profile.legacySnapshot == null ? null : JSON.stringify(profile.legacySnapshot),
        profile.importedAt,
        profile.updatedAt,
      );
    const after = this.getAgencyProfile(profile.agencyId)!;
    // legacySnapshot holds the entire imported business.json — hundreds of
    // kilobytes, already persisted on the profile row itself. Auditing it on
    // both sides of every update is what turned this log into the largest
    // thing in the database, so record the change without the snapshot.
    this.audit(
      "agency_profile",
      profile.agencyId,
      before ? "updated" : "imported",
      before ? { ...before, legacySnapshot: undefined } : null,
      { ...after, legacySnapshot: undefined },
      { agencyId: profile.agencyId, actorId },
    );
    return after;
  }

  getAgencyProfile(agencyId: string): AgencyProfile | null {
    const row = this.db.prepare("SELECT * FROM agency_profiles WHERE agency_id=?").get(agencyId) as
      | Row
      | undefined;
    if (!row) return null;
    const value = camel(row);
    return {
      ...value,
      branding: value.brandingJson ? JSON.parse(value.brandingJson) : null,
      socialMedia: value.socialMediaJson ? JSON.parse(value.socialMediaJson) : null,
      legacySnapshot: value.legacySnapshotJson ? JSON.parse(value.legacySnapshotJson) : null,
      brandingJson: undefined,
      socialMediaJson: undefined,
      legacySnapshotJson: undefined,
    } as AgencyProfile;
  }

  getLegacyEntityMapping(
    agencyId: string,
    sourceType: string,
    sourceId: string,
  ): { targetId: string; sourceHash: string } | null {
    const row = this.db
      .prepare(`SELECT target_id,source_hash FROM legacy_entity_mappings
      WHERE agency_id=? AND source_type=? AND source_id=?`)
      .get(agencyId, sourceType, sourceId) as
      | { target_id: string; source_hash: string }
      | undefined;
    return row ? { targetId: row.target_id, sourceHash: row.source_hash } : null;
  }

  recordLegacyEntityMapping(input: {
    agencyId: string;
    sourceType: string;
    sourceId: string;
    targetId: string;
    sourceHash: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO legacy_entity_mappings(
      agency_id,source_type,source_id,target_id,source_hash,migrated_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(agency_id,source_type,source_id) DO UPDATE SET
      target_id=excluded.target_id,source_hash=excluded.source_hash,updated_at=excluded.updated_at`)
      .run(
        input.agencyId,
        input.sourceType,
        input.sourceId,
        input.targetId,
        input.sourceHash,
        now,
        now,
      );
  }

  recordLegacyMigrationRun(input: {
    id: string;
    actorId: string;
    sourcePath: string;
    sourceHash: string;
    status: string;
    report: unknown;
    startedAt: number;
    completedAt?: number | null;
  }): void {
    this.db
      .prepare(`INSERT INTO legacy_migration_runs
      (id,actor_id,source_path,source_hash,status,report_json,started_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,report_json=excluded.report_json,
      completed_at=excluded.completed_at`)
      .run(
        input.id,
        input.actorId,
        input.sourcePath,
        input.sourceHash,
        input.status,
        JSON.stringify(input.report),
        input.startedAt,
        input.completedAt ?? null,
      );
  }

  listLegacyMigrationRuns(limit = 50): Row[] {
    return this.db
      .prepare("SELECT * FROM legacy_migration_runs ORDER BY started_at DESC LIMIT ?")
      .all(Math.max(1, Math.trunc(limit))) as Row[];
  }

  /**
   * The most recent completed run for an actor, used to skip re-importing a
   * business.json that has not changed since it was last migrated.
   */
  getLastCompletedLegacyMigration(
    actorId: string,
  ): { sourceHash: string; report: unknown; completedAt: number } | null {
    const row = this.db
      .prepare(
        `SELECT source_hash, report_json, completed_at FROM legacy_migration_runs
         WHERE actor_id=? AND status='completed' AND completed_at IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(actorId) as
      | { source_hash: string; report_json: string; completed_at: number }
      | undefined;
    if (!row) return null;
    let report: unknown = null;
    try {
      report = JSON.parse(row.report_json);
    } catch {
      return null;
    }
    return { sourceHash: row.source_hash, report, completedAt: row.completed_at };
  }

  importLegacyClient(
    input: {
      agencyId: string;
      sourceId: string;
      sourceHash: string;
      name: string;
      status?: Client["status"];
      /** Real pipeline status from the source record; blank means "Cold". */
      pipelineStatus?: string | null;
      billingEmail?: string | null;
      notes?: string | null;
      createdAt?: number;
      updatedAt?: number;
    },
    actorId?: string,
  ): Client {
    this.requireAgency(input.agencyId);
    const mapped = this.getLegacyEntityMapping(input.agencyId, "client", input.sourceId);
    const id = mapped?.targetId ?? `legacy-client:${input.agencyId}:${input.sourceId}`;
    const pipeline = normalizeClientPipelineStatus(input.pipelineStatus);
    const rollup = input.status ?? deriveLegacyClientStatus(pipeline.status);
    if (mapped?.sourceHash === input.sourceHash) {
      const existing = this.getClient(id, input.agencyId);
      if (existing) {
        // The source hash covers the *source record*, not how this build
        // interprets it. When the interpretation changes — a new status
        // column, a corrected rollup — the stored row is stale even though
        // the source is byte-identical, and short-circuiting here is why the
        // owner's data never self-healed after the last mapping fix.
        //
        // Repair only the derived columns, and only when they actually
        // differ. A re-import of genuinely unchanged data still writes
        // nothing: no UPDATE, no mapping row, no audit event. That is the
        // discipline that stopped this database growing to 633 MB.
        const stale =
          existing.pipelineStatus !== pipeline.status ||
          existing.pipelineStatusLabel !== pipeline.label ||
          existing.status !== rollup;
        if (!stale) return existing;
        const repaired: Client = {
          ...existing,
          status: rollup,
          pipelineStatus: pipeline.status,
          pipelineStatusLabel: pipeline.label,
          // Bumped so the corrected value wins last-writer-wins on peers.
          updatedAt: Date.now(),
        };
        this.db.transaction(() => {
          this.db
            .prepare(
              `UPDATE clients SET status=@status,pipeline_status=@pipelineStatus,
               pipeline_status_label=@pipelineStatusLabel,updated_at=@updatedAt
               WHERE agency_id=@agencyId AND id=@id`,
            )
            .run(repaired);
          this.audit("client", id, "legacy_status_repaired", existing, repaired, {
            agencyId: input.agencyId,
            actorId,
          });
        })();
        return repaired;
      }
    }
    const now = Date.now();
    const client: Client = {
      id,
      agencyId: input.agencyId,
      name: required(input.name, "name"),
      legalName: null,
      status: rollup,
      pipelineStatus: pipeline.status,
      pipelineStatusLabel: pipeline.label,
      ownerId: null,
      billingEmail: input.billingEmail?.trim() || null,
      notes: input.notes?.trim() || null,
      whatsapp: null,
      telegram: null,
      discord: null,
      instagram: null,
      phone: null,
      email: null,
      notionPageId: null,
      data: {},
      lastSynced: null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO clients
        (id,agency_id,name,legal_name,status,owner_id,billing_email,notes,created_at,updated_at,pipeline_status,pipeline_status_label,whatsapp,telegram,discord,instagram,phone,email)
        VALUES (@id,@agencyId,@name,@legalName,@status,@ownerId,@billingEmail,@notes,@createdAt,@updatedAt,@pipelineStatus,@pipelineStatusLabel,@whatsapp,@telegram,@discord,@instagram,@phone,@email)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,
        pipeline_status=excluded.pipeline_status,
        pipeline_status_label=excluded.pipeline_status_label,
        billing_email=excluded.billing_email,notes=excluded.notes,updated_at=excluded.updated_at`)
        .run(client);
      this.recordLegacyEntityMapping({
        agencyId: input.agencyId,
        sourceType: "client",
        sourceId: input.sourceId,
        targetId: id,
        sourceHash: input.sourceHash,
      });
      this.audit("client", id, mapped ? "legacy_synced" : "legacy_imported", null, client, {
        agencyId: input.agencyId,
        actorId,
      });
    })();
    return client;
  }

  importLegacyProject(
    input: AgencyProject & { sourceId: string; sourceHash: string },
    actorId?: string,
  ): AgencyProject {
    this.requireAgency(input.agencyId);
    const mapped = this.getLegacyEntityMapping(input.agencyId, "project", input.sourceId);
    const { sourceId, sourceHash, ...projectInput } = input;
    const project = {
      ...projectInput,
      id: mapped?.targetId ?? `legacy-project:${input.agencyId}:${sourceId}`,
    };
    if (mapped?.sourceHash === sourceHash) {
      const existing = this.getProject(input.agencyId, project.id);
      if (existing) return existing;
    }
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO agency_projects
        (id,agency_id,client_id,name,status,owner_id,start_at,target_end_at,budget_cents,created_at,updated_at)
        VALUES (@id,@agencyId,@clientId,@name,@status,@ownerId,@startAt,@targetEndAt,@budgetCents,@createdAt,@updatedAt)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,
        owner_id=excluded.owner_id,target_end_at=excluded.target_end_at,
        budget_cents=excluded.budget_cents,updated_at=excluded.updated_at`)
        .run(project);
      this.recordLegacyEntityMapping({
        agencyId: input.agencyId,
        sourceType: "project",
        sourceId,
        targetId: project.id,
        sourceHash,
      });
      this.audit(
        "agency_project",
        project.id,
        mapped ? "legacy_synced" : "legacy_imported",
        null,
        project,
        {
          agencyId: input.agencyId,
          actorId,
        },
      );
    })();
    return project;
  }

  importLegacyTask(
    input: AgencyTask & { sourceId: string; sourceHash: string },
    actorId?: string,
  ): AgencyTask {
    this.requireAgency(input.agencyId);
    if (!this.getProject(input.agencyId, input.projectId)) throw new Error("project not found");
    const mapped = this.getLegacyEntityMapping(input.agencyId, "task", input.sourceId);
    const { sourceId, sourceHash, ...taskInput } = input;
    const task = {
      ...taskInput,
      id: mapped?.targetId ?? `legacy-task:${input.agencyId}:${sourceId}`,
    };
    if (mapped?.sourceHash === sourceHash) {
      const existing = this.getTask(input.agencyId, task.id);
      if (existing) return existing;
    }
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO agency_tasks
        (id,agency_id,project_id,parent_task_id,title,description,status,priority,assignee_type,
         assignee_id,acceptance_criteria,due_at,completed_at,created_at,updated_at)
        VALUES (@id,@agencyId,@projectId,@parentTaskId,@title,@description,@status,@priority,
         @assigneeType,@assigneeId,@acceptanceCriteria,@dueAt,@completedAt,@createdAt,@updatedAt)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
        status=excluded.status,priority=excluded.priority,assignee_type=excluded.assignee_type,
        assignee_id=excluded.assignee_id,due_at=excluded.due_at,
        completed_at=excluded.completed_at,updated_at=excluded.updated_at`)
        .run(task);
      this.recordLegacyEntityMapping({
        agencyId: input.agencyId,
        sourceType: "task",
        sourceId,
        targetId: task.id,
        sourceHash,
      });
      this.audit("agency_task", task.id, mapped ? "legacy_synced" : "legacy_imported", null, task, {
        agencyId: input.agencyId,
        actorId,
      });
    })();
    return task;
  }

  listAgenciesForUser(
    userId: string,
  ): Array<Agency & { role: AgencyRole; ownership: "owned" | "shared" }> {
    return (
      this.db
        .prepare(`
      SELECT a.*, m.role FROM agencies a
      JOIN agency_memberships m ON m.agency_id=a.id
      WHERE m.user_id=? ORDER BY a.name
    `)
        .all(userId) as Row[]
    ).map((row) => {
      const value = camel(row);
      return { ...value, ownership: value.ownerUserId === userId ? "owned" : "shared" };
    });
  }

  listAgencyMembers(agencyId: string): AgencyMembership[] {
    this.requireAgency(agencyId);
    return (
      this.db
        .prepare("SELECT * FROM agency_memberships WHERE agency_id=? ORDER BY created_at")
        .all(agencyId) as Row[]
    ).map(camel);
  }

  setAgencyMemberRole(
    agencyId: string,
    userId: string,
    role: AgencyRole,
    actorId: string,
  ): AgencyMembership {
    this.requireAgencyRole(agencyId, actorId, ["owner", "admin"]);
    const agency = this.getAgency(agencyId)!;
    if (userId === agency.ownerUserId && role !== "owner")
      throw new Error("agency owner role cannot be changed");
    if (role === "owner") throw new Error("ownership transfer is not supported by this operation");
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO agency_memberships(agency_id,user_id,role,created_at,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(agency_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`)
      .run(agencyId, required(userId, "userId"), role, now, now);
    const membership = this.db
      .prepare("SELECT * FROM agency_memberships WHERE agency_id=? AND user_id=?")
      .get(agencyId, userId) as Row;
    this.audit("agency_membership", `${agencyId}:${userId}`, "role_set", null, camel(membership), {
      agencyId,
      actorId,
    });
    return camel(membership);
  }

  removeAgencyMember(agencyId: string, userId: string, actorId: string): void {
    this.requireAgencyRole(agencyId, actorId, ["owner", "admin"]);
    const agency = this.getAgency(agencyId)!;
    if (userId === agency.ownerUserId) throw new Error("agency owner cannot be removed");
    if (userId === actorId) throw new Error("use leave agency instead of removing yourself");
    const before = this.db
      .prepare("SELECT * FROM agency_memberships WHERE agency_id=? AND user_id=?")
      .get(agencyId, userId) as Row | undefined;
    if (!before) throw new Error("agency member not found");
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM agency_memberships WHERE agency_id=? AND user_id=?")
        .run(agencyId, userId);
      this.audit("agency_membership", `${agencyId}:${userId}`, "removed", camel(before), null, {
        agencyId,
        actorId,
      });
    })();
  }

  createAgencyInvitation(
    input: {
      agencyId: string;
      email: string;
      role: Exclude<AgencyRole, "owner">;
      expiresAt: number;
    },
    actorId: string,
  ): { invitation: AgencyInvitation; token: string } {
    this.requireAgencyRole(input.agencyId, actorId, ["owner", "admin"]);
    if (input.expiresAt <= Date.now()) throw new Error("expiresAt must be in the future");
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const invitation: AgencyInvitation = {
      id: randomUUID(),
      agencyId: input.agencyId,
      email: required(input.email, "email").toLowerCase(),
      role: input.role,
      tokenHash: this.hashToken(token),
      invitedByUserId: actorId,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO agency_invitations VALUES (@id,@agencyId,@email,@role,@tokenHash,@invitedByUserId,@expiresAt,@acceptedAt,@revokedAt,@createdAt)",
        )
        .run(invitation);
      this.audit(
        "agency_invitation",
        invitation.id,
        "created",
        null,
        { ...invitation, tokenHash: "[redacted]" },
        { agencyId: input.agencyId, actorId },
      );
    })();
    return { invitation, token };
  }

  acceptAgencyInvitation(token: string, userId: string, email: string): AgencyMembership {
    const tokenHash = this.hashToken(token);
    const invitationRow = this.db
      .prepare("SELECT * FROM agency_invitations WHERE token_hash=?")
      .get(tokenHash) as Row | undefined;
    if (!invitationRow) throw new Error("invitation not found");
    const invitation = camel(invitationRow) as AgencyInvitation;
    if (invitation.revokedAt) throw new Error("invitation revoked");
    if (invitation.acceptedAt) throw new Error("invitation already accepted");
    if (invitation.expiresAt <= Date.now()) throw new Error("invitation expired");
    if (invitation.email !== email.trim().toLowerCase())
      throw new Error("invitation email does not match");
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO agency_memberships VALUES (?,?,?,?,?)")
        .run(invitation.agencyId, userId, invitation.role, now, now);
      this.db
        .prepare("UPDATE agency_invitations SET accepted_at=? WHERE id=?")
        .run(now, invitation.id);
      this.audit(
        "agency_invitation",
        invitation.id,
        "accepted",
        null,
        { userId },
        { agencyId: invitation.agencyId, actorId: userId },
      );
    })();
    return {
      agencyId: invitation.agencyId,
      userId,
      role: invitation.role,
      createdAt: now,
      updatedAt: now,
    };
  }

  revokeAgencyInvitation(agencyId: string, invitationId: string, actorId: string): void {
    this.requireAgencyRole(agencyId, actorId, ["owner", "admin"]);
    const result = this.db
      .prepare(
        "UPDATE agency_invitations SET revoked_at=? WHERE id=? AND agency_id=? AND accepted_at IS NULL AND revoked_at IS NULL",
      )
      .run(Date.now(), invitationId, agencyId);
    if (result.changes === 0) throw new Error("active invitation not found");
    this.audit("agency_invitation", invitationId, "revoked", null, null, { agencyId, actorId });
  }

  createProject(
    agencyId: string,
    input: {
      name: string;
      clientId?: string;
      ownerId?: string;
      startAt?: number;
      targetEndAt?: number;
      budgetCents?: number;
    },
    actorId?: string,
  ): AgencyProject {
    this.requireAgency(agencyId);
    if (input.clientId && !this.getClient(input.clientId, agencyId))
      throw new Error("client not found");
    const now = Date.now();
    const project: AgencyProject = {
      id: randomUUID(),
      agencyId,
      clientId: input.clientId ?? null,
      name: required(input.name, "name"),
      status: "planned",
      ownerId: input.ownerId ?? null,
      startAt: input.startAt ?? null,
      targetEndAt: input.targetEndAt ?? null,
      budgetCents: nonNegative(input.budgetCents ?? 0, "budgetCents"),
      mrrCents: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agency_projects
          (id,agency_id,client_id,name,status,owner_id,start_at,target_end_at,budget_cents,mrr_cents,created_at,updated_at)
          VALUES (@id,@agencyId,@clientId,@name,@status,@ownerId,@startAt,@targetEndAt,@budgetCents,@mrrCents,@createdAt,@updatedAt)`,
        )
        .run(project);
      this.audit("agency_project", project.id, "created", null, project, { agencyId, actorId });
    })();
    return project;
  }

  getProject(agencyId: string, id: string): AgencyProject | null {
    const row = this.db
      .prepare("SELECT * FROM agency_projects WHERE agency_id=? AND id=?")
      .get(agencyId, id) as Row | undefined;
    return row ? camel(row) : null;
  }

  listProjects(agencyId: string, status?: AgencyProjectStatus): AgencyProject[] {
    this.requireAgency(agencyId);
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM agency_projects WHERE agency_id=? AND status=? ORDER BY updated_at DESC",
          )
          .all(agencyId, status)
      : this.db
          .prepare("SELECT * FROM agency_projects WHERE agency_id=? ORDER BY updated_at DESC")
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  updateProject(
    agencyId: string,
    id: string,
    patch: {
      name?: string;
      ownerId?: string | null;
      targetEndAt?: number | null;
      budgetCents?: number;
    },
    actorId?: string,
  ): AgencyProject {
    const before = this.getProject(agencyId, id);
    if (!before) throw new Error("project not found");
    const after = {
      ...before,
      name: patch.name === undefined ? before.name : required(patch.name, "name"),
      ownerId: patch.ownerId === undefined ? before.ownerId : patch.ownerId,
      targetEndAt: patch.targetEndAt === undefined ? before.targetEndAt : patch.targetEndAt,
      budgetCents:
        patch.budgetCents === undefined
          ? before.budgetCents
          : nonNegative(patch.budgetCents, "budgetCents"),
      updatedAt: Date.now(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE agency_projects SET name=@name,owner_id=@ownerId,target_end_at=@targetEndAt,budget_cents=@budgetCents,updated_at=@updatedAt WHERE agency_id=@agencyId AND id=@id",
        )
        .run(after);
      this.audit("agency_project", id, "updated", before, after, { agencyId, actorId });
    })();
    return after;
  }

  /**
   * Set the manually-attributed monthly recurring revenue for a project.
   * Everything else on the project is left untouched; only mrr_cents (and the
   * updated-at stamp) move, so a save from the revenue modal cannot clobber a
   * concurrent name/budget edit.
   */
  setProjectMrr(agencyId: string, id: string, mrrCents: number, actorId?: string): AgencyProject {
    const before = this.getProject(agencyId, id);
    if (!before) throw new Error("project not found");
    const after = {
      ...before,
      mrrCents: nonNegative(mrrCents, "mrrCents"),
      updatedAt: Date.now(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE agency_projects SET mrr_cents=@mrrCents,updated_at=@updatedAt WHERE agency_id=@agencyId AND id=@id",
        )
        .run(after);
      this.audit("agency_project", id, "updated", before, after, { agencyId, actorId });
    })();
    return after;
  }

  transitionProject(
    agencyId: string,
    id: string,
    status: AgencyProjectStatus,
    actorId?: string,
  ): AgencyProject {
    return this.transitionSimple(
      "project",
      "agency_projects",
      id,
      status,
      { agencyId, actorId },
      () => this.getProject(agencyId, id),
    );
  }

  deleteProject(agencyId: string, id: string, actorId?: string): void {
    const before = this.getProject(agencyId, id);
    if (!before) throw new Error("project not found");
    const taskIds = this.listTasks(agencyId, { projectId: id }).map((task) => task.id);
    this.db.transaction(() => {
      const deletedAt = Date.now();
      for (const taskId of taskIds) {
        this.recordTombstone(agencyId, "agency_tasks", { id: taskId }, deletedAt);
      }
      this.recordTombstone(agencyId, "agency_projects", { id }, deletedAt);
      this.db.prepare("DELETE FROM agency_projects WHERE agency_id=? AND id=?").run(agencyId, id);
      this.audit("agency_project", id, "deleted", before, null, { agencyId, actorId });
    })();
  }

  createTask(
    agencyId: string,
    input: {
      projectId: string;
      parentTaskId?: string;
      title: string;
      description?: string;
      priority?: AgencyTask["priority"];
      assigneeType?: AgencyTask["assigneeType"];
      assigneeId?: string;
      acceptanceCriteria: string;
      dueAt?: number;
    },
    actorId?: string,
  ): AgencyTask {
    if (!this.getProject(agencyId, input.projectId)) throw new Error("project not found");
    if (input.parentTaskId && !this.getTask(agencyId, input.parentTaskId))
      throw new Error("parent task not found");
    const now = Date.now();
    const task: AgencyTask = {
      id: randomUUID(),
      agencyId,
      projectId: input.projectId,
      parentTaskId: input.parentTaskId ?? null,
      title: required(input.title, "title"),
      description: input.description?.trim() ?? "",
      status: "backlog",
      priority: input.priority ?? "normal",
      assigneeType: input.assigneeType ?? null,
      assigneeId: input.assigneeId ?? null,
      acceptanceCriteria: required(input.acceptanceCriteria, "acceptanceCriteria"),
      dueAt: input.dueAt ?? null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO agency_tasks VALUES (@id,@agencyId,@projectId,@parentTaskId,@title,@description,@status,@priority,@assigneeType,@assigneeId,@acceptanceCriteria,@dueAt,@completedAt,@createdAt,@updatedAt)",
        )
        .run(task);
      this.audit("agency_task", task.id, "created", null, task, { agencyId, actorId });
    })();
    return task;
  }

  getTask(agencyId: string, id: string): AgencyTask | null {
    const row = this.db
      .prepare("SELECT * FROM agency_tasks WHERE agency_id=? AND id=?")
      .get(agencyId, id) as Row | undefined;
    return row ? camel(row) : null;
  }

  listTasks(
    agencyId: string,
    filters?: { projectId?: string; status?: AgencyTaskStatus; assigneeId?: string },
  ): AgencyTask[] {
    this.requireAgency(agencyId);
    let sql = "SELECT * FROM agency_tasks WHERE agency_id=?";
    const params: unknown[] = [agencyId];
    if (filters?.projectId) {
      sql += " AND project_id=?";
      params.push(filters.projectId);
    }
    if (filters?.status) {
      sql += " AND status=?";
      params.push(filters.status);
    }
    if (filters?.assigneeId) {
      sql += " AND assignee_id=?";
      params.push(filters.assigneeId);
    }
    sql += " ORDER BY due_at IS NULL,due_at,created_at";
    return (this.db.prepare(sql).all(...params) as Row[]).map(camel);
  }

  updateTask(
    agencyId: string,
    id: string,
    patch: {
      title?: string;
      description?: string;
      priority?: AgencyTask["priority"];
      assigneeType?: AgencyTask["assigneeType"];
      assigneeId?: string | null;
      dueAt?: number | null;
    },
    actorId?: string,
  ): AgencyTask {
    const before = this.getTask(agencyId, id);
    if (!before) throw new Error("task not found");
    const after = {
      ...before,
      title: patch.title === undefined ? before.title : required(patch.title, "title"),
      description: patch.description === undefined ? before.description : patch.description.trim(),
      priority: patch.priority ?? before.priority,
      assigneeType: patch.assigneeType === undefined ? before.assigneeType : patch.assigneeType,
      assigneeId: patch.assigneeId === undefined ? before.assigneeId : patch.assigneeId,
      dueAt: patch.dueAt === undefined ? before.dueAt : patch.dueAt,
      updatedAt: Date.now(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE agency_tasks SET title=@title,description=@description,priority=@priority,assignee_type=@assigneeType,assignee_id=@assigneeId,due_at=@dueAt,updated_at=@updatedAt WHERE agency_id=@agencyId AND id=@id",
        )
        .run(after);
      this.audit("agency_task", id, "updated", before, after, { agencyId, actorId });
    })();
    return after;
  }

  transitionTask(
    agencyId: string,
    id: string,
    status: AgencyTaskStatus,
    actorId?: string,
  ): AgencyTask {
    const result = this.transitionSimple(
      "task",
      "agency_tasks",
      id,
      status,
      { agencyId, actorId },
      () => this.getTask(agencyId, id),
    ) as AgencyTask;
    if (status === "done") {
      this.db
        .prepare("UPDATE agency_tasks SET completed_at=? WHERE agency_id=? AND id=?")
        .run(Date.now(), agencyId, id);
      return this.getTask(agencyId, id)!;
    }
    return result;
  }

  deleteTask(agencyId: string, id: string, actorId?: string): void {
    const before = this.getTask(agencyId, id);
    if (!before) throw new Error("task not found");
    this.db.transaction(() => {
      this.recordTombstone(agencyId, "agency_tasks", { id }, Date.now());
      this.db.prepare("DELETE FROM agency_tasks WHERE agency_id=? AND id=?").run(agencyId, id);
      this.audit("agency_task", id, "deleted", before, null, { agencyId, actorId });
    })();
  }

  createClient(
    input: {
      name: string;
      legalName?: string;
      billingEmail?: string;
      ownerId?: string;
      notes?: string;
      pipelineStatus?: string | null;
      whatsapp?: string | null;
      telegram?: string | null;
      discord?: string | null;
      instagram?: string | null;
      phone?: string | null;
      email?: string | null;
      notionPageId?: string | null;
      data?: Record<string, unknown>;
    },
    options?: ActorOptions,
  ): Client {
    this.requireAgency(options?.agencyId ?? DEFAULT_AGENCY_ID);
    const now = Date.now();
    const pipeline = normalizeClientPipelineStatus(input.pipelineStatus);
    const client: Client = {
      id: randomUUID(),
      agencyId: options?.agencyId ?? DEFAULT_AGENCY_ID,
      name: required(input.name, "name"),
      legalName: input.legalName?.trim() || null,
      status: deriveLegacyClientStatus(pipeline.status),
      pipelineStatus: pipeline.status,
      pipelineStatusLabel: pipeline.label,
      ownerId: input.ownerId ?? null,
      billingEmail: input.billingEmail?.trim() || null,
      notes: input.notes?.trim() || null,
      whatsapp: input.whatsapp?.trim() || null,
      telegram: input.telegram?.trim() || null,
      discord: input.discord?.trim() || null,
      instagram: input.instagram?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      notionPageId: input.notionPageId?.trim() || null,
      data: input.data ?? {},
      lastSynced: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO clients
        (id,agency_id,name,legal_name,status,owner_id,billing_email,notes,created_at,updated_at,pipeline_status,pipeline_status_label,whatsapp,telegram,discord,instagram,phone,email,notion_page_id,data,last_synced)
        VALUES (@id,@agencyId,@name,@legalName,@status,@ownerId,@billingEmail,@notes,@createdAt,@updatedAt,@pipelineStatus,@pipelineStatusLabel,@whatsapp,@telegram,@discord,@instagram,@phone,@email,@notionPageId,@data,@lastSynced)`)
        .run({ ...client, data: JSON.stringify(client.data) });
      this.audit("client", client.id, "created", null, client, options);
    })();
    return client;
  }

  /**
   * Upsert a client by its Notion page ID. If a row with the same
   * agency_id + notion_page_id already exists it is updated in place;
   * otherwise a new row is created. Returns the resulting client.
   */
  upsertClientByNotionPageId(
    agencyId: string,
    notionPageId: string,
    fields: {
      name: string;
      email?: string | null;
      phone?: string | null;
      billingEmail?: string | null;
      notes?: string | null;
      pipelineStatus?: string | null;
      data: Record<string, unknown>;
    },
    options?: ActorOptions,
  ): Client {
    const existing = this.db
      .prepare("SELECT * FROM clients WHERE agency_id=? AND notion_page_id=?")
      .get(agencyId, notionPageId) as Row | undefined;

    const now = Date.now();
    const pipeline = normalizeClientPipelineStatus(fields.pipelineStatus);

    if (existing) {
      const before = camel(existing) as Client;
      const after: Client = {
        ...before,
        name: fields.name || before.name,
        email: fields.email !== undefined ? fields.email : before.email,
        phone: fields.phone !== undefined ? fields.phone : before.phone,
        billingEmail: fields.billingEmail !== undefined ? fields.billingEmail : before.billingEmail,
        notes: fields.notes !== undefined ? fields.notes : before.notes,
        pipelineStatus:
          fields.pipelineStatus !== undefined ? pipeline.status : before.pipelineStatus,
        pipelineStatusLabel:
          fields.pipelineStatus !== undefined ? pipeline.label : before.pipelineStatusLabel,
        status:
          fields.pipelineStatus !== undefined
            ? deriveLegacyClientStatus(pipeline.status)
            : before.status,
        data: fields.data,
        lastSynced: now,
        updatedAt: now,
      };
      this.db
        .prepare(
          "UPDATE clients SET name=@name,email=@email,phone=@phone,billing_email=@billingEmail,notes=@notes,pipeline_status=@pipelineStatus,pipeline_status_label=@pipelineStatusLabel,status=@status,data=@data,last_synced=@lastSynced,updated_at=@updatedAt WHERE agency_id=@agencyId AND notion_page_id=@notionPageId",
        )
        .run({ ...after, data: JSON.stringify(after.data), agencyId, notionPageId });
      return after;
    } else {
      return this.createClient(
        {
          ...fields,
          billingEmail: fields.billingEmail ?? undefined,
          notes: fields.notes ?? undefined,
          notionPageId,
          data: fields.data,
        },
        { ...options, agencyId },
      );
    }
  }

  // ── Notion config ───────────────────────────────────────────────────────────

  getClientsNotionConfig(agencyId = DEFAULT_AGENCY_ID): ClientsNotionConfig | null {
    const row = this.db
      .prepare("SELECT * FROM clients_notion_config WHERE agency_id=?")
      .get(agencyId) as Row | undefined;
    return row ? hydrateNotionConfig(row) : null;
  }

  setClientsNotionConfig(
    agencyId = DEFAULT_AGENCY_ID,
    patch: Partial<Omit<ClientsNotionConfig, "agencyId">>,
  ): ClientsNotionConfig {
    const existing = this.getClientsNotionConfig(agencyId);
    const merged: ClientsNotionConfig = {
      agencyId,
      notionDbId:
        patch.notionDbId !== undefined ? patch.notionDbId : (existing?.notionDbId ?? null),
      notionDbName:
        patch.notionDbName !== undefined ? patch.notionDbName : (existing?.notionDbName ?? null),
      schemaJson:
        patch.schemaJson !== undefined ? patch.schemaJson : (existing?.schemaJson ?? null),
      lastSync: patch.lastSync !== undefined ? patch.lastSync : (existing?.lastSync ?? null),
      dbRowsMigrated:
        patch.dbRowsMigrated !== undefined ? patch.dbRowsMigrated : (existing?.dbRowsMigrated ?? 0),
    };
    this.db
      .prepare(
        `INSERT INTO clients_notion_config (agency_id,notion_db_id,notion_db_name,schema_json,last_sync,db_rows_migrated)
         VALUES (@agencyId,@notionDbId,@notionDbName,@schemaJson,@lastSync,@dbRowsMigrated)
         ON CONFLICT(agency_id) DO UPDATE SET
           notion_db_id=excluded.notion_db_id,
           notion_db_name=excluded.notion_db_name,
           schema_json=excluded.schema_json,
           last_sync=excluded.last_sync,
           db_rows_migrated=excluded.db_rows_migrated`,
      )
      .run(merged);
    return merged;
  }

  getClient(id: string, agencyId = DEFAULT_AGENCY_ID): Client | null {
    const row = this.db
      .prepare("SELECT * FROM clients WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    return row ? hydrateClient(row) : null;
  }

  /**
   * @param filter.pipelineStatus one or more real pipeline statuses. Matching
   * is case/whitespace-insensitive: callers may pass "In Progress" or
   * "in progress" and get the same rows.
   * @param filter.status the derived three-value rollup, for legacy callers.
   */
  listClients(
    agencyId = DEFAULT_AGENCY_ID,
    filter?: { pipelineStatus?: string | readonly string[]; status?: Client["status"] },
  ): Client[] {
    const where = ["agency_id=?"];
    const params: unknown[] = [agencyId];
    const requested = filter?.pipelineStatus;
    if (requested !== undefined) {
      const keys = Array.from(
        new Set(
          (Array.isArray(requested) ? requested : [requested as string]).map(
            (value) => normalizeClientPipelineStatus(value).status,
          ),
        ),
      );
      if (!keys.length) return [];
      where.push(`pipeline_status IN (${keys.map(() => "?").join(",")})`);
      params.push(...keys);
    }
    if (filter?.status !== undefined) {
      where.push("status=?");
      params.push(filter.status);
    }
    return (
      this.db
        .prepare(`SELECT * FROM clients WHERE ${where.join(" AND ")} ORDER BY name`)
        .all(...params) as Row[]
    ).map(hydrateClient);
  }

  /**
   * Distinct pipeline statuses in use for an agency, with counts — everything
   * a status-grouped board needs to build its columns without loading rows.
   */
  listClientPipelineStatusCounts(agencyId = DEFAULT_AGENCY_ID): Array<{
    status: string;
    label: string;
    rollup: Client["status"];
    count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT pipeline_status status, pipeline_status_label label, COUNT(*) count
         FROM clients WHERE agency_id=?
         GROUP BY pipeline_status, pipeline_status_label
         ORDER BY count DESC, label ASC`,
      )
      .all(agencyId) as Array<{ status: string; label: string; count: number }>;
    return rows.map((row) => ({ ...row, rollup: deriveLegacyClientStatus(row.status) }));
  }

  updateClient(
    id: string,
    patch: {
      name?: string;
      status?: Client["status"];
      pipelineStatus?: string | null;
      ownerId?: string | null;
      billingEmail?: string | null;
      notes?: string | null;
      whatsapp?: string | null;
      telegram?: string | null;
      discord?: string | null;
      instagram?: string | null;
      phone?: string | null;
      email?: string | null;
      notionPageId?: string | null;
      data?: Record<string, unknown>;
    },
    options?: ActorOptions,
  ): Client {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getClient(id, agencyId);
    if (!before) throw new Error("client not found");
    const pipeline =
      patch.pipelineStatus === undefined
        ? null
        : normalizeClientPipelineStatus(patch.pipelineStatus);
    const after: Client = {
      ...before,
      name: patch.name === undefined ? before.name : required(patch.name, "name"),
      pipelineStatus: pipeline?.status ?? before.pipelineStatus,
      pipelineStatusLabel: pipeline?.label ?? before.pipelineStatusLabel,
      status:
        patch.status ?? (pipeline ? deriveLegacyClientStatus(pipeline.status) : before.status),
      ownerId: patch.ownerId === undefined ? before.ownerId : patch.ownerId,
      billingEmail: patch.billingEmail === undefined ? before.billingEmail : patch.billingEmail,
      notes: patch.notes === undefined ? before.notes : patch.notes,
      whatsapp: patch.whatsapp === undefined ? before.whatsapp : patch.whatsapp,
      telegram: patch.telegram === undefined ? before.telegram : patch.telegram,
      discord: patch.discord === undefined ? before.discord : patch.discord,
      instagram: patch.instagram === undefined ? before.instagram : patch.instagram,
      phone: patch.phone === undefined ? before.phone : patch.phone,
      email: patch.email === undefined ? before.email : patch.email,
      notionPageId: patch.notionPageId === undefined ? before.notionPageId : patch.notionPageId,
      data: patch.data === undefined ? before.data : patch.data,
      updatedAt: Date.now(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE clients SET name=@name,status=@status,pipeline_status=@pipelineStatus,pipeline_status_label=@pipelineStatusLabel,owner_id=@ownerId,billing_email=@billingEmail,notes=@notes,whatsapp=@whatsapp,telegram=@telegram,discord=@discord,instagram=@instagram,phone=@phone,email=@email,notion_page_id=@notionPageId,data=@data,updated_at=@updatedAt WHERE agency_id=@agencyId AND id=@id",
        )
        .run({ ...after, data: JSON.stringify(after.data) });
      this.audit("client", id, "updated", before, after, options);
    })();
    return after;
  }

  deleteClient(id: string, options?: ActorOptions): void {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getClient(id, agencyId);
    if (!before) throw new Error("client not found");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM clients WHERE id=? AND agency_id=?").run(id, agencyId);
      this.audit("client", id, "deleted", before, null, options);
    })();
  }

  logClientRevenue(
    input: {
      clientId: string;
      amountCents: number;
      currency?: string;
      note?: string;
      loggedAt?: number;
    },
    options?: ActorOptions,
  ): {
    id: string;
    clientId: string;
    amountCents: number;
    currency: string;
    note: string | null;
    loggedAt: number;
    createdAt: number;
  } {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getClient(input.clientId, agencyId)) throw new Error("client not found");
    const now = Date.now();
    const row = {
      id: randomUUID(),
      agencyId,
      clientId: input.clientId,
      amountCents: Math.round(input.amountCents),
      currency: (input.currency ?? "USD").toUpperCase(),
      note: input.note?.trim() || null,
      loggedAt: input.loggedAt ?? now,
      createdAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO client_revenue_log (id,agency_id,client_id,amount_cents,currency,note,logged_at,created_at) VALUES (@id,@agencyId,@clientId,@amountCents,@currency,@note,@loggedAt,@createdAt)",
      )
      .run(row);
    return {
      id: row.id,
      clientId: row.clientId,
      amountCents: row.amountCents,
      currency: row.currency,
      note: row.note,
      loggedAt: row.loggedAt,
      createdAt: row.createdAt,
    };
  }

  listClientRevenue(
    clientId: string | null,
    agencyId = DEFAULT_AGENCY_ID,
    limit = 200,
  ): Array<{
    id: string;
    clientId: string;
    amountCents: number;
    currency: string;
    note: string | null;
    loggedAt: number;
    createdAt: number;
  }> {
    if (clientId) {
      return (
        this.db
          .prepare(
            "SELECT id,client_id,amount_cents,currency,note,logged_at,created_at FROM client_revenue_log WHERE agency_id=? AND client_id=? ORDER BY logged_at DESC LIMIT ?",
          )
          .all(agencyId, clientId, limit) as Array<Record<string, unknown>>
      ).map((r) => ({
        id: r.id as string,
        clientId: r.client_id as string,
        amountCents: r.amount_cents as number,
        currency: r.currency as string,
        note: r.note as string | null,
        loggedAt: r.logged_at as number,
        createdAt: r.created_at as number,
      }));
    }
    return (
      this.db
        .prepare(
          "SELECT id,client_id,amount_cents,currency,note,logged_at,created_at FROM client_revenue_log WHERE agency_id=? ORDER BY logged_at DESC LIMIT ?",
        )
        .all(agencyId, limit) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r.id as string,
      clientId: r.client_id as string,
      amountCents: r.amount_cents as number,
      currency: r.currency as string,
      note: r.note as string | null,
      loggedAt: r.logged_at as number,
      createdAt: r.created_at as number,
    }));
  }

  logClientActivity(
    input: { clientId: string; type?: string; note: string },
    options?: ActorOptions,
  ): { id: string; clientId: string; type: string; note: string; createdAt: number } {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getClient(input.clientId, agencyId)) throw new Error("client not found");
    const now = Date.now();
    const row = {
      id: randomUUID(),
      agencyId,
      clientId: input.clientId,
      type: input.type?.trim() || "note",
      note: required(input.note, "note"),
      createdAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO client_activity_log (id,agency_id,client_id,type,note,created_at) VALUES (@id,@agencyId,@clientId,@type,@note,@createdAt)",
      )
      .run(row);
    return {
      id: row.id,
      clientId: row.clientId,
      type: row.type,
      note: row.note,
      createdAt: row.createdAt,
    };
  }

  listClientActivity(
    clientId: string,
    agencyId = DEFAULT_AGENCY_ID,
    limit = 200,
  ): Array<{ id: string; clientId: string; type: string; note: string; createdAt: number }> {
    return (
      this.db
        .prepare(
          "SELECT id,client_id,type,note,created_at FROM client_activity_log WHERE agency_id=? AND client_id=? ORDER BY created_at DESC LIMIT ?",
        )
        .all(agencyId, clientId, limit) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r.id as string,
      clientId: r.client_id as string,
      type: r.type as string,
      note: r.note as string,
      createdAt: r.created_at as number,
    }));
  }

  createContact(
    input: {
      clientId: string;
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
      title?: string;
      isPrimary?: boolean;
    },
    options?: ActorOptions,
  ): Contact {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getClient(input.clientId, agencyId)) throw new Error("client not found");
    const now = Date.now();
    const contact: Contact = {
      id: randomUUID(),
      agencyId,
      clientId: input.clientId,
      firstName: required(input.firstName, "firstName"),
      lastName: input.lastName?.trim() ?? "",
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      title: input.title?.trim() || null,
      isPrimary: Boolean(input.isPrimary),
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO contacts VALUES (@id,@agencyId,@clientId,@firstName,@lastName,@email,@phone,@title,@isPrimary,@createdAt,@updatedAt)`,
        )
        .run({ ...contact, isPrimary: contact.isPrimary ? 1 : 0 });
      this.audit("contact", contact.id, "created", null, contact, options);
    })();
    return contact;
  }

  /** A client's contacts, primary first — the "Attn:" line on a document. */
  listClientContacts(agencyId: string, clientId: string): Contact[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM contacts WHERE agency_id=? AND client_id=? ORDER BY is_primary DESC, created_at",
        )
        .all(agencyId, clientId) as Row[]
    ).map((row) => ({ ...camel(row), isPrimary: Boolean(row.is_primary) })) as Contact[];
  }

  createOpportunity(
    input: {
      clientId: string;
      name: string;
      valueCents: number;
      probability?: number;
      ownerId?: string;
      expectedCloseAt?: number;
    },
    options?: ActorOptions,
  ): Opportunity {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getClient(input.clientId, agencyId)) throw new Error("client not found");
    const probability = input.probability ?? 0.2;
    if (probability < 0 || probability > 1) throw new Error("probability must be between 0 and 1");
    const now = Date.now();
    const opportunity: Opportunity = {
      id: randomUUID(),
      agencyId,
      clientId: input.clientId,
      name: required(input.name, "name"),
      stage: "lead",
      valueCents: nonNegative(input.valueCents, "valueCents"),
      probability,
      ownerId: input.ownerId ?? null,
      expectedCloseAt: input.expectedCloseAt ?? null,
      lostReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO opportunities VALUES (@id,@agencyId,@clientId,@name,@stage,@valueCents,@probability,@ownerId,@expectedCloseAt,@lostReason,@createdAt,@updatedAt)`,
        )
        .run(opportunity);
      this.audit("opportunity", opportunity.id, "created", null, opportunity, options);
    })();
    return opportunity;
  }

  transitionOpportunity(
    id: string,
    stage: OpportunityStage,
    input?: { probability?: number; lostReason?: string },
    options?: ActorOptions,
  ): Opportunity {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getOpportunity(id, agencyId);
    if (!before) throw new Error("opportunity not found");
    transition("opportunity", before.stage, stage);
    if (stage === "lost" && !input?.lostReason?.trim()) throw new Error("lostReason required");
    const probability =
      input?.probability ?? (stage === "won" ? 1 : stage === "lost" ? 0 : before.probability);
    if (probability < 0 || probability > 1) throw new Error("probability must be between 0 and 1");
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE opportunities SET stage=?, probability=?, lost_reason=?, updated_at=? WHERE id=? AND agency_id=?",
        )
        .run(
          stage,
          probability,
          stage === "lost" ? input!.lostReason!.trim() : null,
          Date.now(),
          id,
          agencyId,
        );
      this.audit("opportunity", id, "stage_changed", before, { stage, probability }, options);
    })();
    return this.getOpportunity(id, agencyId)!;
  }

  getOpportunity(id: string, agencyId = DEFAULT_AGENCY_ID): Opportunity | null {
    const row = this.db
      .prepare("SELECT * FROM opportunities WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    return row ? camel(row) : null;
  }

  listOpportunities(agencyId: string, stage?: OpportunityStage): Opportunity[] {
    const rows = stage
      ? this.db
          .prepare(
            "SELECT * FROM opportunities WHERE agency_id=? AND stage=? ORDER BY updated_at DESC",
          )
          .all(agencyId, stage)
      : this.db
          .prepare("SELECT * FROM opportunities WHERE agency_id=? ORDER BY updated_at DESC")
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  /**
   * Create a proposal.
   *
   * `opportunityId` stays supported for existing callers, but the authoring
   * path only knows about a client: pass `clientId` and an opportunity is
   * opened for you, sized to the proposal and parked at the `proposal` stage.
   * That is what keeps a proposal visible in the pipeline figures without a
   * second, hand-maintained concept of "expected revenue".
   */
  createProposal(
    input: {
      opportunityId?: string;
      clientId?: string;
      title: string;
      scope: string;
      summary?: string;
      currency?: string;
      number?: string;
      validUntil?: number;
      taxCents?: number;
      sections?: ProposalSectionRecord[];
      acceptanceTerms?: string[];
      createdAt?: number;
      lineItems: Array<{ description: string; quantity: number; unitPriceCents: number }>;
    },
    options?: ActorOptions,
  ): Proposal {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!input.lineItems.length) throw new Error("at least one line item required");
    const items: ProposalLineItem[] = input.lineItems.map((item) => {
      if (!Number.isFinite(item.quantity) || item.quantity <= 0)
        throw new Error("quantity must be positive");
      nonNegative(item.unitPriceCents, "unitPriceCents");
      return {
        id: randomUUID(),
        description: required(item.description, "description"),
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: Math.round(item.quantity * item.unitPriceCents),
      };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.totalCents, 0);
    const taxCents = nonNegative(input.taxCents ?? 0, "taxCents");
    const totalCents = subtotalCents + taxCents;
    const title = required(input.title, "title");

    let opportunityId = input.opportunityId;
    let clientId = input.clientId ?? null;
    if (opportunityId) {
      const opportunity = this.getOpportunity(opportunityId, agencyId);
      if (!opportunity) throw new Error("opportunity not found");
      if (clientId && clientId !== opportunity.clientId) {
        throw new Error("clientId does not match the opportunity's client");
      }
      clientId = opportunity.clientId;
    } else {
      if (!clientId) throw new Error("clientId or opportunityId is required");
      if (!this.getClient(clientId, agencyId)) throw new Error("client not found");
      const opportunity = this.createOpportunity(
        { clientId, name: title, valueCents: totalCents, probability: 0.5 },
        options,
      );
      // lead -> qualified -> proposal: a proposal only exists because the deal
      // reached that stage, so the opportunity is walked there rather than
      // being left misreported as a raw lead.
      this.transitionOpportunity(opportunity.id, "qualified", undefined, options);
      this.transitionOpportunity(opportunity.id, "proposal", undefined, options);
      opportunityId = opportunity.id;
    }

    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const proposal: Proposal = {
      id: randomUUID(),
      agencyId,
      opportunityId,
      clientId,
      number: input.number?.trim() || this.allocateDocumentNumber(agencyId, "proposal", createdAt),
      title,
      status: "draft",
      scope: required(input.scope, "scope"),
      summary: input.summary?.trim() || null,
      sections: normalizeProposalSections(input.sections),
      acceptanceTerms: normalizeAcceptanceTerms(input.acceptanceTerms),
      currency: input.currency?.toUpperCase() ?? "USD",
      validUntil: input.validUntil ?? null,
      acceptedAt: null,
      subtotalCents,
      taxCents,
      totalCents,
      lineItems: items,
      createdAt,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.writeProposalRow(proposal);
      const insertItem = this.db.prepare(`INSERT INTO proposal_line_items
        (id,agency_id,proposal_id,description,quantity,unit_price_cents,total_cents,sort_order)
        VALUES (@id,@agencyId,@proposalId,@description,@quantity,@unitPriceCents,@totalCents,@sortOrder)`);
      items.forEach((item, sortOrder) =>
        insertItem.run({ ...item, agencyId, proposalId: proposal.id, sortOrder }),
      );
      this.audit("proposal", proposal.id, "created", null, proposal, options);
    })();
    return proposal;
  }

  /** Named-column write shared by create and update. Never `VALUES (…)`. */
  private writeProposalRow(proposal: Proposal): void {
    this.db
      .prepare(`INSERT INTO proposals
      (id,agency_id,opportunity_id,client_id,number,title,status,scope,summary,sections_json,
       acceptance_terms_json,currency,valid_until,accepted_at,subtotal_cents,tax_cents,total_cents,
       created_at,updated_at)
      VALUES (@id,@agencyId,@opportunityId,@clientId,@number,@title,@status,@scope,@summary,@sectionsJson,
       @acceptanceTermsJson,@currency,@validUntil,@acceptedAt,@subtotalCents,@taxCents,@totalCents,
       @createdAt,@updatedAt)`)
      .run({
        ...proposal,
        sectionsJson: JSON.stringify(proposal.sections ?? []),
        acceptanceTermsJson: JSON.stringify(proposal.acceptanceTerms ?? []),
        lineItems: undefined,
      });
  }

  /**
   * Edit a draft proposal. Money and line items are editable only while the
   * proposal has not been sent — once a client has seen it, the numbers are
   * the record of what they were told.
   */
  updateProposal(
    id: string,
    patch: {
      title?: string;
      scope?: string;
      summary?: string | null;
      number?: string;
      currency?: string;
      validUntil?: number | null;
      taxCents?: number;
      sections?: ProposalSectionRecord[];
      acceptanceTerms?: string[];
      lineItems?: Array<{ description: string; quantity: number; unitPriceCents: number }>;
    },
    options?: ActorOptions,
  ): Proposal {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getProposal(id, agencyId);
    if (!before) throw new Error("proposal not found");
    const editableMoney = before.status === "draft" || before.status === "internal_review";
    const touchesMoney =
      patch.lineItems !== undefined || patch.taxCents !== undefined || patch.currency !== undefined;
    if (touchesMoney && !editableMoney) {
      throw new Error(`proposal money cannot be edited while status is ${before.status}`);
    }
    const now = Date.now();
    this.db.transaction(() => {
      let subtotalCents = before.subtotalCents;
      if (patch.lineItems) {
        if (!patch.lineItems.length) throw new Error("at least one line item required");
        this.db
          .prepare("DELETE FROM proposal_line_items WHERE agency_id=? AND proposal_id=?")
          .run(agencyId, id);
        const insertItem = this.db.prepare(`INSERT INTO proposal_line_items
          (id,agency_id,proposal_id,description,quantity,unit_price_cents,total_cents,sort_order)
          VALUES (@id,@agencyId,@proposalId,@description,@quantity,@unitPriceCents,@totalCents,@sortOrder)`);
        subtotalCents = 0;
        patch.lineItems.forEach((item, sortOrder) => {
          if (!Number.isFinite(item.quantity) || item.quantity <= 0)
            throw new Error("quantity must be positive");
          nonNegative(item.unitPriceCents, "unitPriceCents");
          const totalCents = Math.round(item.quantity * item.unitPriceCents);
          subtotalCents += totalCents;
          insertItem.run({
            id: randomUUID(),
            agencyId,
            proposalId: id,
            description: required(item.description, "description"),
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            totalCents,
            sortOrder,
          });
        });
      }
      const taxCents =
        patch.taxCents === undefined ? before.taxCents : nonNegative(patch.taxCents, "taxCents");
      const sets: string[] = [
        "subtotal_cents=@subtotalCents",
        "tax_cents=@taxCents",
        "total_cents=@totalCents",
        "updated_at=@updatedAt",
      ];
      const args: Record<string, unknown> = {
        id,
        agencyId,
        subtotalCents,
        taxCents,
        totalCents: subtotalCents + taxCents,
        updatedAt: now,
      };
      const assign = (column: string, key: string, value: unknown) => {
        sets.push(`${column}=@${key}`);
        args[key] = value;
      };
      if (patch.title !== undefined) assign("title", "title", required(patch.title, "title"));
      if (patch.scope !== undefined) assign("scope", "scope", required(patch.scope, "scope"));
      if (patch.summary !== undefined) assign("summary", "summary", patch.summary?.trim() || null);
      if (patch.number !== undefined) assign("number", "number", required(patch.number, "number"));
      if (patch.currency !== undefined)
        assign("currency", "currency", patch.currency.toUpperCase());
      if (patch.validUntil !== undefined) assign("valid_until", "validUntil", patch.validUntil);
      if (patch.sections !== undefined) {
        assign(
          "sections_json",
          "sectionsJson",
          JSON.stringify(normalizeProposalSections(patch.sections)),
        );
      }
      if (patch.acceptanceTerms !== undefined) {
        assign(
          "acceptance_terms_json",
          "acceptanceTermsJson",
          JSON.stringify(normalizeAcceptanceTerms(patch.acceptanceTerms)),
        );
      }
      this.db
        .prepare(`UPDATE proposals SET ${sets.join(",")} WHERE id=@id AND agency_id=@agencyId`)
        .run(args);
      // The opportunity is the pipeline's view of this proposal; keep its value
      // in step or "expected revenue" silently reports a stale number.
      this.db
        .prepare("UPDATE opportunities SET value_cents=?, updated_at=? WHERE id=? AND agency_id=?")
        .run(args.totalCents, now, before.opportunityId, agencyId);
      this.audit("proposal", id, "updated", before, args, options);
    })();
    return this.getProposal(id, agencyId)!;
  }

  transitionProposal(id: string, status: ProposalStatus, options?: ActorOptions): Proposal {
    return this.transitionSimple("proposal", "proposals", id, status, options, () =>
      this.getProposal(id, options?.agencyId),
    );
  }

  /**
   * Move a proposal to `target`, walking every intermediate state the status
   * machine requires. The machine is respected exactly — this only spares the
   * caller from having to spell out `draft → internal_review → sent → accepted`
   * for a proposal that was agreed over the phone.
   */
  advanceProposalTo(id: string, target: ProposalStatus, options?: ActorOptions): Proposal {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    let current = this.getProposal(id, agencyId);
    if (!current) throw new Error("proposal not found");
    if (current.status === target) return current;
    const path = shortestStatusPath(
      transitions.proposal as Record<string, readonly string[]>,
      current.status,
      target,
    );
    if (!path) throw new Error(`Invalid proposal transition: ${current.status} -> ${target}`);
    for (const step of path) {
      current = this.transitionProposal(id, step as ProposalStatus, options);
    }
    return current!;
  }

  /**
   * Accept a proposal and let the win flow into the pipeline: the opportunity
   * is resized to the agreed total and marked `won`, which is what
   * `revenueSummary().pipeline` reads. `acceptedAt` may be backdated for a deal
   * that was actually agreed months ago.
   */
  acceptProposal(id: string, options?: ActorOptions, acceptedAt?: number): Proposal {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const proposal = this.advanceProposalTo(id, "accepted", options);
    const at = acceptedAt ?? Date.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE proposals SET accepted_at=?, updated_at=? WHERE id=? AND agency_id=?")
        .run(at, Date.now(), id, agencyId);
      const opportunity = this.getOpportunity(proposal.opportunityId, agencyId);
      if (opportunity && opportunity.stage !== "won" && opportunity.stage !== "lost") {
        this.db
          .prepare(
            "UPDATE opportunities SET value_cents=?, updated_at=? WHERE id=? AND agency_id=?",
          )
          .run(proposal.totalCents, Date.now(), opportunity.id, agencyId);
      }
      this.audit(
        "proposal",
        id,
        "accepted",
        null,
        { acceptedAt: at, totalCents: proposal.totalCents },
        options,
      );
    })();
    const opportunity = this.getOpportunity(proposal.opportunityId, agencyId);
    if (opportunity && opportunity.stage !== "won" && opportunity.stage !== "lost") {
      const path = shortestStatusPath(
        transitions.opportunity as Record<string, readonly string[]>,
        opportunity.stage,
        "won",
      );
      for (const step of path ?? []) {
        this.transitionOpportunity(opportunity.id, step as OpportunityStage, undefined, options);
      }
    }
    return this.getProposal(id, agencyId)!;
  }

  getProposal(id: string, agencyId = DEFAULT_AGENCY_ID): Proposal | null {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    if (!row) return null;
    const lineItems = (
      this.db
        .prepare(
          "SELECT id,description,quantity,unit_price_cents,total_cents FROM proposal_line_items WHERE agency_id=? AND proposal_id=? ORDER BY sort_order",
        )
        .all(agencyId, id) as Row[]
    ).map(camel);
    return proposalFromRow(row, lineItems);
  }

  listProposals(
    agencyId = DEFAULT_AGENCY_ID,
    filters: { status?: ProposalStatus; clientId?: string } = {},
  ): Proposal[] {
    const where = ["agency_id=?"];
    const params: unknown[] = [agencyId];
    if (filters.status) {
      where.push("status=?");
      params.push(filters.status);
    }
    if (filters.clientId) {
      where.push("client_id=?");
      params.push(filters.clientId);
    }
    const rows = this.db
      .prepare(`SELECT id FROM proposals WHERE ${where.join(" AND ")} ORDER BY created_at DESC`)
      .all(...params) as Array<{ id: string }>;
    return rows.map((row) => this.getProposal(row.id, agencyId)!).filter(Boolean);
  }

  createEngagement(
    input: {
      clientId: string;
      name: string;
      proposalId?: string;
      budgetCents: number;
      startAt?: number;
      targetEndAt?: number;
      ownerId?: string;
    },
    options?: ActorOptions,
  ): Engagement {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getClient(input.clientId, agencyId)) throw new Error("client not found");
    if (input.proposalId) {
      const proposal = this.getProposal(input.proposalId, agencyId);
      if (!proposal || proposal.status !== "accepted") throw new Error("proposal must be accepted");
    }
    const now = Date.now();
    const engagement: Engagement = {
      id: randomUUID(),
      agencyId,
      clientId: input.clientId,
      proposalId: input.proposalId ?? null,
      name: required(input.name, "name"),
      status: "planned",
      budgetCents: nonNegative(input.budgetCents, "budgetCents"),
      startAt: input.startAt ?? null,
      targetEndAt: input.targetEndAt ?? null,
      ownerId: input.ownerId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO engagements VALUES (@id,@agencyId,@clientId,@proposalId,@name,@status,@budgetCents,@startAt,@targetEndAt,@ownerId,@createdAt,@updatedAt)`,
        )
        .run(engagement);
      this.audit("engagement", engagement.id, "created", null, engagement, options);
    })();
    return engagement;
  }

  transitionEngagement(id: string, status: EngagementStatus, options?: ActorOptions): Engagement {
    return this.transitionSimple("engagement", "engagements", id, status, options, () =>
      this.getEngagement(id, options?.agencyId),
    );
  }

  getEngagement(id: string, agencyId = DEFAULT_AGENCY_ID): Engagement | null {
    const row = this.db
      .prepare("SELECT * FROM engagements WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    return row ? camel(row) : null;
  }

  listEngagements(agencyId: string, status?: EngagementStatus): Engagement[] {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM engagements WHERE agency_id=? AND status=? ORDER BY updated_at DESC",
          )
          .all(agencyId, status)
      : this.db
          .prepare("SELECT * FROM engagements WHERE agency_id=? ORDER BY updated_at DESC")
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  createMilestone(
    input: { engagementId: string; name: string; dueAt?: number; sortOrder?: number },
    options?: ActorOptions,
  ): Milestone {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getEngagement(input.engagementId, agencyId)) throw new Error("engagement not found");
    const now = Date.now();
    const milestone: Milestone = {
      id: randomUUID(),
      agencyId,
      engagementId: input.engagementId,
      name: required(input.name, "name"),
      dueAt: input.dueAt ?? null,
      completedAt: null,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO milestones VALUES (@id,@agencyId,@engagementId,@name,@dueAt,@completedAt,@sortOrder,@createdAt,@updatedAt)",
        )
        .run(milestone);
      this.audit("milestone", milestone.id, "created", null, milestone, options);
    })();
    return milestone;
  }

  createDeliverable(
    input: {
      engagementId: string;
      milestoneId?: string;
      name: string;
      acceptanceCriteria: string;
      assigneeType?: "human" | "ai" | "hybrid";
      assigneeId?: string;
      dueAt?: number;
    },
    options?: ActorOptions,
  ): Deliverable {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getEngagement(input.engagementId, agencyId)) throw new Error("engagement not found");
    const now = Date.now();
    const deliverable: Deliverable = {
      id: randomUUID(),
      agencyId,
      engagementId: input.engagementId,
      milestoneId: input.milestoneId ?? null,
      name: required(input.name, "name"),
      status: "backlog",
      acceptanceCriteria: required(input.acceptanceCriteria, "acceptanceCriteria"),
      assigneeType: input.assigneeType ?? null,
      assigneeId: input.assigneeId ?? null,
      dueAt: input.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO deliverables VALUES (@id,@agencyId,@engagementId,@milestoneId,@name,@status,@acceptanceCriteria,@assigneeType,@assigneeId,@dueAt,@createdAt,@updatedAt)",
        )
        .run(deliverable);
      this.audit("deliverable", deliverable.id, "created", null, deliverable, options);
    })();
    return deliverable;
  }

  transitionDeliverable(
    id: string,
    status: DeliverableStatus,
    options?: ActorOptions,
  ): Deliverable {
    return this.transitionSimple("deliverable", "deliverables", id, status, options, () =>
      this.getDeliverable(id, options?.agencyId),
    );
  }

  getDeliverable(id: string, agencyId = DEFAULT_AGENCY_ID): Deliverable | null {
    const row = this.db
      .prepare("SELECT * FROM deliverables WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    return row ? camel(row) : null;
  }

  listDeliverables(agencyId: string, engagementId?: string): Deliverable[] {
    const rows = engagementId
      ? this.db
          .prepare(
            "SELECT * FROM deliverables WHERE agency_id=? AND engagement_id=? ORDER BY due_at IS NULL,due_at",
          )
          .all(agencyId, engagementId)
      : this.db
          .prepare("SELECT * FROM deliverables WHERE agency_id=? ORDER BY updated_at DESC")
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  requestClientApproval(
    input: { engagementId: string; deliverableId?: string; contactId?: string; note?: string },
    options?: ActorOptions,
  ): ClientApproval {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getEngagement(input.engagementId, agencyId)) throw new Error("engagement not found");
    const now = Date.now();
    const approval: ClientApproval = {
      id: randomUUID(),
      agencyId,
      engagementId: input.engagementId,
      deliverableId: input.deliverableId ?? null,
      status: "requested",
      requestedFromContactId: input.contactId ?? null,
      note: input.note?.trim() || null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO client_approvals VALUES (@id,@agencyId,@engagementId,@deliverableId,@status,@requestedFromContactId,@note,@decidedAt,@createdAt,@updatedAt)",
        )
        .run(approval);
      this.audit("client_approval", approval.id, "requested", null, approval, options);
    })();
    return approval;
  }

  decideClientApproval(
    id: string,
    status: Exclude<ApprovalStatus, "requested">,
    note?: string,
    options?: ActorOptions,
  ): ClientApproval {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getApproval(id, agencyId);
    if (!before) throw new Error("approval not found");
    transition("approval", before.status, status);
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE client_approvals SET status=?, note=COALESCE(?,note), decided_at=?, updated_at=? WHERE id=? AND agency_id=?",
        )
        .run(status, note?.trim() || null, Date.now(), Date.now(), id, agencyId);
      this.audit("client_approval", id, "decided", before, { status, note }, options);
    })();
    return this.getApproval(id, agencyId)!;
  }

  getApproval(id: string, agencyId = DEFAULT_AGENCY_ID): ClientApproval | null {
    const row = this.db
      .prepare("SELECT * FROM client_approvals WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    return row ? camel(row) : null;
  }

  listApprovals(agencyId: string, status?: ApprovalStatus): ClientApproval[] {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM client_approvals WHERE agency_id=? AND status=? ORDER BY updated_at DESC",
          )
          .all(agencyId, status)
      : this.db
          .prepare("SELECT * FROM client_approvals WHERE agency_id=? ORDER BY updated_at DESC")
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  createChangeRequest(
    input: {
      engagementId: string;
      title: string;
      description: string;
      impactCents?: number;
      impactDays?: number;
      requestedByContactId?: string;
    },
    options?: ActorOptions,
  ): ChangeRequest {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getEngagement(input.engagementId, agencyId)) throw new Error("engagement not found");
    const now = Date.now();
    const request: ChangeRequest = {
      id: randomUUID(),
      agencyId,
      engagementId: input.engagementId,
      status: "draft",
      title: required(input.title, "title"),
      description: required(input.description, "description"),
      impactCents: nonNegative(input.impactCents ?? 0, "impactCents"),
      impactDays: nonNegative(input.impactDays ?? 0, "impactDays"),
      requestedByContactId: input.requestedByContactId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO change_requests VALUES (@id,@agencyId,@engagementId,@status,@title,@description,@impactCents,@impactDays,@requestedByContactId,@createdAt,@updatedAt)",
        )
        .run(request);
      this.audit("change_request", request.id, "created", null, request, options);
    })();
    return request;
  }

  transitionChangeRequest(
    id: string,
    status: ChangeRequestStatus,
    options?: ActorOptions,
  ): ChangeRequest {
    return this.transitionSimple("changeRequest", "change_requests", id, status, options, () =>
      this.getChangeRequest(id, options?.agencyId),
    );
  }

  getChangeRequest(id: string, agencyId = DEFAULT_AGENCY_ID): ChangeRequest | null {
    const row = this.db
      .prepare("SELECT * FROM change_requests WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    return row ? camel(row) : null;
  }

  /**
   * Allocate the next number in a per-agency series and persist the advance.
   *
   * The counter is a row, not `MAX(number) + 1`: a voided or deleted document
   * must never hand its number to the next one, because the client already saw
   * it. On first use the counter seeds itself from the highest number already
   * present in the series, so an agency that has been numbering invoices by
   * hand continues from where it left off instead of restarting at 1.
   *
   * Series are year-scoped off the *document's* date, which is what makes a
   * backdated invoice fall into its own year's run rather than this year's.
   */
  allocateDocumentNumber(
    agencyId: string,
    kind: "invoice" | "proposal",
    at = Date.now(),
    prefixOverride?: string,
  ): string {
    const prefix = (prefixOverride ?? (kind === "invoice" ? "INV" : "PRO")).toUpperCase();
    const year = new Date(at).getUTCFullYear();
    const series = `${prefix}-${year}`;
    return this.db.transaction(() => {
      let next = this.db
        .prepare("SELECT next_seq FROM document_number_counters WHERE agency_id=? AND series=?")
        .pluck()
        .get(agencyId, series) as number | undefined;
      if (next === undefined) {
        const table = kind === "invoice" ? "invoices" : "proposals";
        const existing = this.db
          .prepare(`SELECT number FROM ${table} WHERE agency_id=? AND number LIKE ?`)
          .pluck()
          .all(agencyId, `${series}-%`) as string[];
        let highest = 0;
        for (const number of existing) {
          const suffix = Number.parseInt(String(number).slice(series.length + 1), 10);
          if (Number.isFinite(suffix) && suffix > highest) highest = suffix;
        }
        next = highest + 1;
      }
      // A hand-entered number can still collide with the counter's position;
      // skip past anything already taken rather than failing the insert.
      const table = kind === "invoice" ? "invoices" : "proposals";
      const taken = this.db
        .prepare(`SELECT 1 FROM ${table} WHERE agency_id=? AND number=?`)
        .pluck();
      let candidate = `${series}-${String(next).padStart(4, "0")}`;
      while (taken.get(agencyId, candidate)) {
        next += 1;
        candidate = `${series}-${String(next).padStart(4, "0")}`;
      }
      this.db
        .prepare(`INSERT INTO document_number_counters (agency_id,series,next_seq,updated_at)
        VALUES (?,?,?,?)
        ON CONFLICT(agency_id,series) DO UPDATE SET next_seq=excluded.next_seq, updated_at=excluded.updated_at`)
        .run(agencyId, series, next + 1, Date.now());
      return candidate;
    })();
  }

  /** The number the next document in this series would get, without consuming it. */
  peekDocumentNumber(agencyId: string, kind: "invoice" | "proposal", at = Date.now()): string {
    const prefix = kind === "invoice" ? "INV" : "PRO";
    const series = `${prefix}-${new Date(at).getUTCFullYear()}`;
    const next = this.db
      .prepare("SELECT next_seq FROM document_number_counters WHERE agency_id=? AND series=?")
      .pluck()
      .get(agencyId, series) as number | undefined;
    if (next !== undefined) return `${series}-${String(next).padStart(4, "0")}`;
    const table = kind === "invoice" ? "invoices" : "proposals";
    const existing = this.db
      .prepare(`SELECT number FROM ${table} WHERE agency_id=? AND number LIKE ?`)
      .pluck()
      .all(agencyId, `${series}-%`) as string[];
    let highest = 0;
    for (const number of existing) {
      const suffix = Number.parseInt(String(number).slice(series.length + 1), 10);
      if (Number.isFinite(suffix) && suffix > highest) highest = suffix;
    }
    return `${series}-${String(highest + 1).padStart(4, "0")}`;
  }

  /* ---------------------------------------------------------------- *
   * Payment accounts (reusable agency-level bank / payment options)
   * ---------------------------------------------------------------- */

  listPaymentAccounts(agencyId = DEFAULT_AGENCY_ID): AgencyPaymentAccount[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM payment_accounts WHERE agency_id=? ORDER BY is_default DESC, created_at DESC",
      )
      .all(agencyId) as Row[];
    return rows.map(paymentAccountFromRow);
  }

  getPaymentAccount(agencyId: string, id: string): AgencyPaymentAccount | null {
    const row = this.db
      .prepare("SELECT * FROM payment_accounts WHERE id=? AND agency_id=?")
      .get(id, agencyId) as Row | undefined;
    return row ? paymentAccountFromRow(row) : null;
  }

  upsertPaymentAccount(
    input: {
      id?: string;
      label: string;
      currency?: string | null;
      bankName?: string | null;
      accountName?: string | null;
      accountNumber?: string | null;
      iban?: string | null;
      swift?: string | null;
      routingNumber?: string | null;
      instructions?: string | null;
      isDefault?: boolean;
    },
    options?: ActorOptions,
  ): AgencyPaymentAccount {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    this.requireAgency(agencyId);
    const label = required(input.label, "label").trim();
    if (!label) throw new Error("label required");
    const clean = (value: string | null | undefined): string | null => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed ? trimmed : null;
    };
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = input.id ? this.getPaymentAccount(agencyId, input.id) : null;
      const record: AgencyPaymentAccount = {
        id: existing?.id ?? input.id ?? randomUUID(),
        agencyId,
        label,
        // Currency is stored lowercased ISO, matching the rest of the schema.
        currency: clean(input.currency)?.toLowerCase() ?? null,
        bankName: clean(input.bankName),
        accountName: clean(input.accountName),
        accountNumber: clean(input.accountNumber),
        iban: clean(input.iban),
        swift: clean(input.swift),
        routingNumber: clean(input.routingNumber),
        instructions: clean(input.instructions),
        isDefault: input.isDefault ?? existing?.isDefault ?? false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      // Only one default per agency: promoting this one demotes the rest.
      if (record.isDefault) {
        this.db
          .prepare("UPDATE payment_accounts SET is_default=0, updated_at=? WHERE agency_id=?")
          .run(now, agencyId);
      }
      this.db
        .prepare(`INSERT INTO payment_accounts
        (id,agency_id,label,currency,bank_name,account_name,account_number,iban,swift,
         routing_number,instructions,is_default,created_at,updated_at)
        VALUES (@id,@agencyId,@label,@currency,@bankName,@accountName,@accountNumber,@iban,@swift,
         @routingNumber,@instructions,@isDefaultInt,@createdAt,@updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          label=excluded.label,currency=excluded.currency,bank_name=excluded.bank_name,
          account_name=excluded.account_name,account_number=excluded.account_number,
          iban=excluded.iban,swift=excluded.swift,routing_number=excluded.routing_number,
          instructions=excluded.instructions,is_default=excluded.is_default,
          updated_at=excluded.updated_at`)
        .run({ ...record, isDefaultInt: record.isDefault ? 1 : 0 });
      this.audit(
        "payment_account",
        record.id,
        existing ? "updated" : "created",
        existing,
        record,
        options,
      );
      return this.getPaymentAccount(agencyId, record.id)!;
    })();
  }

  deletePaymentAccount(agencyId: string, id: string, options?: ActorOptions): boolean {
    const before = this.getPaymentAccount(agencyId, id);
    if (!before) return false;
    this.db.transaction(() => {
      // Detach the account from any invoice that referenced it so the row does
      // not dangle; the invoice keeps its currency and terms either way.
      this.db
        .prepare(
          "UPDATE invoices SET payment_account_id=NULL WHERE agency_id=? AND payment_account_id=?",
        )
        .run(agencyId, id);
      this.db.prepare("DELETE FROM payment_accounts WHERE id=? AND agency_id=?").run(id, agencyId);
      this.audit("payment_account", id, "deleted", before, null, options);
    })();
    return true;
  }

  createInvoice(
    input: {
      clientId: string;
      engagementId?: string;
      proposalId?: string;
      number?: string;
      subtotalCents: number;
      taxCents?: number;
      taxLabel?: string;
      currency?: string;
      dueAt?: number;
      issuedAt?: number;
      createdAt?: number;
      reference?: string;
      notes?: string;
      terms?: string;
      paymentAccountId?: string | null;
    },
    options?: ActorOptions,
  ): Invoice {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!this.getClient(input.clientId, agencyId)) throw new Error("client not found");
    const subtotalCents = nonNegative(input.subtotalCents, "subtotalCents");
    const taxCents = nonNegative(input.taxCents ?? 0, "taxCents");
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const invoice = {
      id: randomUUID(),
      agencyId,
      clientId: input.clientId,
      engagementId: input.engagementId ?? null,
      proposalId: input.proposalId ?? null,
      number:
        input.number?.trim() ||
        this.allocateDocumentNumber(agencyId, "invoice", input.issuedAt ?? createdAt),
      status: "draft" as const,
      currency: input.currency?.toUpperCase() ?? "USD",
      subtotalCents,
      taxCents,
      taxLabel: input.taxLabel?.trim() || null,
      totalCents: subtotalCents + taxCents,
      amountPaidCents: 0,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      terms: input.terms?.trim() || null,
      paymentAccountId: input.paymentAccountId?.trim() || null,
      issuedAt: null,
      dueAt: input.dueAt ?? null,
      createdAt,
      updatedAt: now,
    };
    if (invoice.paymentAccountId && !this.getPaymentAccount(agencyId, invoice.paymentAccountId)) {
      throw new Error("payment account not found");
    }
    this.db.transaction(() => {
      // Named columns, never positional: this table gains columns over time and
      // a positional VALUES list silently shifts every value along when it does.
      this.db
        .prepare(`INSERT INTO invoices
        (id,agency_id,client_id,engagement_id,proposal_id,number,status,currency,
         subtotal_cents,tax_cents,tax_label,total_cents,amount_paid_cents,
         reference,notes,terms,payment_account_id,issued_at,due_at,created_at,updated_at)
        VALUES (@id,@agencyId,@clientId,@engagementId,@proposalId,@number,@status,@currency,
         @subtotalCents,@taxCents,@taxLabel,@totalCents,@amountPaidCents,
         @reference,@notes,@terms,@paymentAccountId,@issuedAt,@dueAt,@createdAt,@updatedAt)`)
        .run(invoice);
      this.audit("invoice", invoice.id, "created", null, invoice, options);
    })();
    return { ...invoice, balanceCents: invoice.totalCents };
  }

  /**
   * Create a full invoice — line items, project links, tax and terms — in one
   * transaction. Totals are derived from the line items to the cent; the caller
   * never supplies a subtotal that could disagree with what is printed.
   */
  createInvoiceDraft(
    input: {
      clientId: string;
      engagementId?: string;
      proposalId?: string;
      number?: string;
      currency?: string;
      issuedAt?: number;
      dueAt?: number;
      createdAt?: number;
      taxCents?: number;
      taxLabel?: string;
      reference?: string;
      notes?: string;
      terms?: string;
      paymentAccountId?: string | null;
      projectIds?: string[];
      lineItems: InvoiceLineItemInput[];
    },
    options?: ActorOptions,
  ): InvoiceDetail {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!input.lineItems?.length) throw new Error("at least one line item required");
    return this.db.transaction(() => {
      const invoice = this.createInvoice(
        {
          clientId: input.clientId,
          engagementId: input.engagementId,
          proposalId: input.proposalId,
          number: input.number,
          subtotalCents: 0,
          taxCents: input.taxCents,
          taxLabel: input.taxLabel,
          currency: input.currency,
          dueAt: input.dueAt,
          issuedAt: input.issuedAt,
          createdAt: input.createdAt,
          reference: input.reference,
          notes: input.notes,
          terms: input.terms,
          paymentAccountId: input.paymentAccountId,
        },
        options,
      );
      if (input.proposalId && !this.getProposal(input.proposalId, agencyId)) {
        throw new Error("proposal not found");
      }
      this.replaceInvoiceLineItems(agencyId, invoice.id, input.lineItems);
      this.recomputeInvoiceTotals(agencyId, invoice.id);
      if (input.projectIds?.length) {
        this.setInvoiceProjectLinks(invoice.id, input.projectIds, options);
      }
      return this.getInvoiceDetail(agencyId, invoice.id)!;
    })();
  }

  /** Invoice plus line items, project links and payments. */
  getInvoiceDetail(agencyId: string, invoiceId: string): InvoiceDetail | null {
    const invoice = this.getInvoice(invoiceId, agencyId);
    if (!invoice) return null;
    return {
      invoice,
      lineItems: this.listInvoiceLineItems(agencyId, invoiceId),
      projectLinks: this.listInvoiceProjectLinks(agencyId, invoiceId),
      payments: this.listInvoicePayments(agencyId, invoiceId),
    };
  }

  listInvoicePayments(agencyId: string, invoiceId?: string): Payment[] {
    const rows = invoiceId
      ? this.db
          .prepare(
            "SELECT * FROM payments WHERE agency_id=? AND invoice_id=? ORDER BY paid_at, created_at",
          )
          .all(agencyId, invoiceId)
      : this.db
          .prepare("SELECT * FROM payments WHERE agency_id=? ORDER BY paid_at DESC")
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  /**
   * Edit an invoice.
   *
   * Anything that changes what the client owes — line items, tax, currency,
   * the client itself — is draft-only, because after issue those figures are
   * the record of what they were told and what revenue recognition used.
   * Presentation and admin fields (notes, terms, reference, due date) stay
   * editable until the invoice is paid or void.
   */
  updateInvoice(
    id: string,
    patch: {
      clientId?: string;
      engagementId?: string | null;
      proposalId?: string | null;
      number?: string;
      currency?: string;
      dueAt?: number | null;
      issuedAt?: number | null;
      taxCents?: number;
      taxLabel?: string | null;
      reference?: string | null;
      notes?: string | null;
      terms?: string | null;
      paymentAccountId?: string | null;
      lineItems?: InvoiceLineItemInput[];
      projectIds?: string[];
    },
    options?: ActorOptions,
  ): InvoiceDetail {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getInvoice(id, agencyId);
    if (!before) throw new Error("invoice not found");
    if (before.status === "void") throw new Error("a void invoice cannot be edited");
    const touchesMoney =
      patch.lineItems !== undefined ||
      patch.taxCents !== undefined ||
      patch.currency !== undefined ||
      patch.clientId !== undefined;
    if (touchesMoney && before.status !== "draft") {
      throw new Error(
        `invoice amounts can only be edited while the invoice is a draft (status is ${before.status})`,
      );
    }
    return this.db.transaction(() => {
      if (patch.clientId && !this.getClient(patch.clientId, agencyId))
        throw new Error("client not found");
      if (patch.proposalId && !this.getProposal(patch.proposalId, agencyId))
        throw new Error("proposal not found");
      const sets: string[] = ["updated_at=@updatedAt"];
      const args: Record<string, unknown> = { id, agencyId, updatedAt: Date.now() };
      const assign = (column: string, key: string, value: unknown) => {
        sets.push(`${column}=@${key}`);
        args[key] = value;
      };
      if (patch.clientId !== undefined) assign("client_id", "clientId", patch.clientId);
      if (patch.engagementId !== undefined)
        assign("engagement_id", "engagementId", patch.engagementId);
      if (patch.proposalId !== undefined) assign("proposal_id", "proposalId", patch.proposalId);
      if (patch.number !== undefined) assign("number", "number", required(patch.number, "number"));
      if (patch.currency !== undefined)
        assign("currency", "currency", patch.currency.toUpperCase());
      if (patch.dueAt !== undefined) assign("due_at", "dueAt", patch.dueAt);
      if (patch.issuedAt !== undefined) assign("issued_at", "issuedAt", patch.issuedAt);
      if (patch.taxCents !== undefined)
        assign("tax_cents", "taxCents", nonNegative(patch.taxCents, "taxCents"));
      if (patch.taxLabel !== undefined)
        assign("tax_label", "taxLabel", patch.taxLabel?.trim() || null);
      if (patch.reference !== undefined)
        assign("reference", "reference", patch.reference?.trim() || null);
      if (patch.notes !== undefined) assign("notes", "notes", patch.notes?.trim() || null);
      if (patch.terms !== undefined) assign("terms", "terms", patch.terms?.trim() || null);
      if (patch.paymentAccountId !== undefined) {
        const accountId = patch.paymentAccountId?.trim() || null;
        if (accountId && !this.getPaymentAccount(agencyId, accountId))
          throw new Error("payment account not found");
        assign("payment_account_id", "paymentAccountId", accountId);
      }
      this.db
        .prepare(`UPDATE invoices SET ${sets.join(",")} WHERE id=@id AND agency_id=@agencyId`)
        .run(args);
      if (patch.lineItems) {
        if (!patch.lineItems.length) throw new Error("at least one line item required");
        this.replaceInvoiceLineItems(agencyId, id, patch.lineItems);
      }
      this.recomputeInvoiceTotals(agencyId, id);
      if (patch.projectIds) this.setInvoiceProjectLinks(id, patch.projectIds, options);
      this.audit("invoice", id, "updated", before, args, options);
      return this.getInvoiceDetail(agencyId, id)!;
    })();
  }

  addInvoiceLineItem(
    invoiceId: string,
    item: InvoiceLineItemInput,
    options?: ActorOptions,
  ): InvoiceDetail {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    this.requireDraftInvoice(agencyId, invoiceId);
    return this.db.transaction(() => {
      const nextOrder =
        (this.db
          .prepare(
            "SELECT COALESCE(MAX(sort_order), -1) FROM invoice_line_items WHERE agency_id=? AND invoice_id=?",
          )
          .pluck()
          .get(agencyId, invoiceId) as number) + 1;
      this.insertInvoiceLineItem(agencyId, invoiceId, item, nextOrder);
      this.recomputeInvoiceTotals(agencyId, invoiceId);
      this.audit("invoice", invoiceId, "line_item_added", null, item, options);
      return this.getInvoiceDetail(agencyId, invoiceId)!;
    })();
  }

  updateInvoiceLineItem(
    invoiceId: string,
    lineItemId: string,
    patch: Partial<InvoiceLineItemInput>,
    options?: ActorOptions,
  ): InvoiceDetail {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    this.requireDraftInvoice(agencyId, invoiceId);
    const existing = this.db
      .prepare("SELECT * FROM invoice_line_items WHERE agency_id=? AND invoice_id=? AND id=?")
      .get(agencyId, invoiceId, lineItemId) as Row | undefined;
    if (!existing) throw new Error("line item not found");
    const current = camel(existing) as InvoiceLineItem;
    const next: InvoiceLineItemInput = {
      description: patch.description ?? current.description,
      quantity: patch.quantity ?? current.quantity,
      unitPriceCents: patch.unitPriceCents ?? current.unitPriceCents,
      cadence: patch.cadence ?? current.cadence,
    };
    if (!Number.isFinite(next.quantity) || next.quantity <= 0)
      throw new Error("quantity must be positive");
    nonNegative(next.unitPriceCents, "unitPriceCents");
    return this.db.transaction(() => {
      this.db
        .prepare(`UPDATE invoice_line_items
        SET description=?, quantity=?, unit_price_cents=?, total_cents=?, cadence=?
        WHERE agency_id=? AND invoice_id=? AND id=?`)
        .run(
          required(next.description, "description"),
          next.quantity,
          next.unitPriceCents,
          Math.round(next.quantity * next.unitPriceCents),
          cadenceOf(next.cadence),
          agencyId,
          invoiceId,
          lineItemId,
        );
      this.recomputeInvoiceTotals(agencyId, invoiceId);
      this.audit("invoice", invoiceId, "line_item_updated", current, next, options);
      return this.getInvoiceDetail(agencyId, invoiceId)!;
    })();
  }

  removeInvoiceLineItem(
    invoiceId: string,
    lineItemId: string,
    options?: ActorOptions,
  ): InvoiceDetail {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    this.requireDraftInvoice(agencyId, invoiceId);
    return this.db.transaction(() => {
      const removed = this.db
        .prepare("DELETE FROM invoice_line_items WHERE agency_id=? AND invoice_id=? AND id=?")
        .run(agencyId, invoiceId, lineItemId).changes;
      if (!removed) throw new Error("line item not found");
      // Close the gap so sort_order stays a dense 0..n-1 run.
      const remaining = this.db
        .prepare(
          "SELECT id FROM invoice_line_items WHERE agency_id=? AND invoice_id=? ORDER BY sort_order",
        )
        .all(agencyId, invoiceId) as Array<{ id: string }>;
      const reorder = this.db.prepare(
        "UPDATE invoice_line_items SET sort_order=? WHERE agency_id=? AND id=?",
      );
      remaining.forEach((row, index) => reorder.run(index, agencyId, row.id));
      this.recomputeInvoiceTotals(agencyId, invoiceId);
      this.audit("invoice", invoiceId, "line_item_removed", { lineItemId }, null, options);
      return this.getInvoiceDetail(agencyId, invoiceId)!;
    })();
  }

  reorderInvoiceLineItems(
    invoiceId: string,
    orderedIds: string[],
    options?: ActorOptions,
  ): InvoiceDetail {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    this.requireDraftInvoice(agencyId, invoiceId);
    return this.db.transaction(() => {
      const current = this.db
        .prepare("SELECT id FROM invoice_line_items WHERE agency_id=? AND invoice_id=?")
        .pluck()
        .all(agencyId, invoiceId) as string[];
      const wanted = new Set(orderedIds);
      if (
        wanted.size !== orderedIds.length ||
        orderedIds.length !== current.length ||
        current.some((id) => !wanted.has(id))
      ) {
        throw new Error("orderedIds must list every line item on this invoice exactly once");
      }
      const reorder = this.db.prepare(
        "UPDATE invoice_line_items SET sort_order=? WHERE agency_id=? AND id=?",
      );
      orderedIds.forEach((id, index) => reorder.run(index, agencyId, id));
      this.audit("invoice", invoiceId, "line_items_reordered", current, orderedIds, options);
      return this.getInvoiceDetail(agencyId, invoiceId)!;
    })();
  }

  /** Replace every project link on an invoice; allocation splits the total. */
  setInvoiceProjectLinks(
    invoiceId: string,
    links: Array<string | { projectId: string; allocationCents?: number }>,
    options?: ActorOptions,
  ): InvoiceProjectLink[] {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const invoice = this.getInvoice(invoiceId, agencyId);
    if (!invoice) throw new Error("invoice not found");
    const normalized = links.map((link) =>
      typeof link === "string" ? { projectId: link, allocationCents: undefined } : link,
    );
    return this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM invoice_project_links WHERE agency_id=? AND invoice_id=?")
        .run(agencyId, invoiceId);
      if (!normalized.length) return [];
      // An unallocated split divides the total evenly and gives the remainder
      // to the first project, so the parts always add up to the invoice total.
      const even = Math.floor(invoice.totalCents / normalized.length);
      const remainder = invoice.totalCents - even * normalized.length;
      const insert = this.db.prepare(`INSERT INTO invoice_project_links
        (agency_id,invoice_id,project_id,allocation_cents,created_at)
        VALUES (@agencyId,@invoiceId,@projectId,@allocationCents,@createdAt)`);
      const now = Date.now();
      const written: InvoiceProjectLink[] = [];
      normalized.forEach((link, index) => {
        if (!this.getProject(agencyId, link.projectId)) throw new Error("project not found");
        const row: InvoiceProjectLink = {
          agencyId,
          invoiceId,
          projectId: link.projectId,
          allocationCents: link.allocationCents ?? even + (index === 0 ? remainder : 0),
          createdAt: now,
        };
        insert.run(row);
        written.push(row);
      });
      this.audit("invoice", invoiceId, "projects_linked", null, written, options);
      return written;
    })();
  }

  private requireDraftInvoice(agencyId: string, invoiceId: string): Invoice {
    const invoice = this.getInvoice(invoiceId, agencyId);
    if (!invoice) throw new Error("invoice not found");
    if (invoice.status !== "draft") {
      throw new Error(
        `invoice line items can only be edited while the invoice is a draft (status is ${invoice.status})`,
      );
    }
    return invoice;
  }

  private insertInvoiceLineItem(
    agencyId: string,
    invoiceId: string,
    item: InvoiceLineItemInput,
    sortOrder: number,
  ): InvoiceLineItem {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0)
      throw new Error("quantity must be positive");
    nonNegative(item.unitPriceCents, "unitPriceCents");
    const row: InvoiceLineItem = {
      id: randomUUID(),
      agencyId,
      invoiceId,
      description: required(item.description, "description"),
      quantity: item.quantity,
      unitPriceCents: Math.trunc(item.unitPriceCents),
      // Rounded once, here, and stored: the printed line, the subtotal and the
      // revenue entry all read the same integer afterwards.
      totalCents: Math.round(item.quantity * item.unitPriceCents),
      cadence: cadenceOf(item.cadence),
      sortOrder,
    };
    this.db
      .prepare(`INSERT INTO invoice_line_items
      (id,agency_id,invoice_id,description,quantity,unit_price_cents,total_cents,cadence,sort_order)
      VALUES (@id,@agencyId,@invoiceId,@description,@quantity,@unitPriceCents,@totalCents,@cadence,@sortOrder)`)
      .run(row);
    return row;
  }

  private replaceInvoiceLineItems(
    agencyId: string,
    invoiceId: string,
    items: InvoiceLineItemInput[],
  ): InvoiceLineItem[] {
    this.db
      .prepare("DELETE FROM invoice_line_items WHERE agency_id=? AND invoice_id=?")
      .run(agencyId, invoiceId);
    return items.map((item, index) => this.insertInvoiceLineItem(agencyId, invoiceId, item, index));
  }

  /**
   * Re-derive `subtotal_cents` / `total_cents` from the stored line items.
   * Invoices with no line items (the parser's manual-amount path) keep the
   * subtotal they were given.
   */
  private recomputeInvoiceTotals(agencyId: string, invoiceId: string): void {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS subtotal FROM invoice_line_items WHERE agency_id=? AND invoice_id=?",
      )
      .get(agencyId, invoiceId) as { n: number; subtotal: number };
    if (row.n === 0) {
      this.db
        .prepare(
          "UPDATE invoices SET total_cents=subtotal_cents+tax_cents, updated_at=? WHERE agency_id=? AND id=?",
        )
        .run(Date.now(), agencyId, invoiceId);
      return;
    }
    this.db
      .prepare(
        "UPDATE invoices SET subtotal_cents=?, total_cents=?+tax_cents, updated_at=? WHERE agency_id=? AND id=?",
      )
      .run(row.subtotal, row.subtotal, Date.now(), agencyId, invoiceId);
  }

  /** Monthly recurring value implied by this invoice's line-item cadences. */
  invoiceRecurringMonthlyCents(agencyId: string, invoiceId: string): number {
    return this.listInvoiceLineItems(agencyId, invoiceId).reduce(
      (sum, item) => sum + monthlyEquivalentCents(item.cadence, item.totalCents),
      0,
    );
  }

  /**
   * Issue an invoice and recognise the revenue.
   *
   * `overrides.issuedAt` is the backdating hook: the revenue entry is
   * recognised at the *invoice's* issue date, not at the moment the row was
   * typed in, so a March invoice entered in July lands in March's period in
   * `revenueSummary`.
   */
  issueInvoice(
    id: string,
    options?: ActorOptions,
    overrides?: { issuedAt?: number; dueAt?: number },
  ): Invoice {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getInvoice(id, agencyId);
    if (!before) throw new Error("invoice not found");
    transition("invoice", before.status, "issued");
    const issuedAt = overrides?.issuedAt ?? before.issuedAt ?? Date.now();
    const dueAt = overrides?.dueAt ?? before.dueAt ?? null;
    const recurringMonthlyCents = this.invoiceRecurringMonthlyCents(agencyId, id);
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE invoices SET status='issued', issued_at=?, due_at=?, updated_at=? WHERE id=? AND agency_id=?",
        )
        .run(issuedAt, dueAt, Date.now(), id, agencyId);
      const invoice = this.getInvoice(id, agencyId)!;
      if (invoice.totalCents > 0) {
        this.insertRevenueEntry({
          id: randomUUID(),
          agencyId,
          clientId: invoice.clientId,
          invoiceId: invoice.id,
          sourceType: "invoice_issued",
          sourceId: invoice.id,
          amountCents: invoice.totalCents,
          currency: invoice.currency,
          recurringMonthlyCents,
          description: `Invoice ${invoice.number} issued`,
          recognizedAt: issuedAt,
          createdAt: Date.now(),
        });
      }
      if (recurringMonthlyCents > 0) {
        this.upsertClientRevenueProfile(agencyId, invoice.clientId, {
          currency: invoice.currency,
          mrrCents: recurringMonthlyCents,
          lastInvoiceId: invoice.id,
          activeSince: issuedAt,
        });
      }
      this.audit("invoice", id, "issued", before, { issuedAt, dueAt }, options);
    })();
    return this.getInvoice(id, agencyId)!;
  }

  /**
   * Void an invoice and un-recognise the revenue it created. Refused once any
   * payment has landed — money that actually arrived is not erasable, it is
   * refunded, which is a different (and deliberately unimplemented) event.
   */
  voidInvoice(id: string, options?: ActorOptions, reason?: string): Invoice {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const before = this.getInvoice(id, agencyId);
    if (!before) throw new Error("invoice not found");
    if (before.amountPaidCents > 0) throw new Error("an invoice with payments cannot be voided");
    transition("invoice", before.status, "void");
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE invoices SET status='void', updated_at=? WHERE id=? AND agency_id=?")
        .run(Date.now(), id, agencyId);
      this.db
        .prepare(
          "DELETE FROM revenue_entries WHERE agency_id=? AND invoice_id=? AND source_type='invoice_issued'",
        )
        .run(agencyId, id);
      this.db
        .prepare(
          "UPDATE client_revenue_profiles SET mrr_cents=0, arr_cents=0, updated_at=? WHERE agency_id=? AND last_invoice_id=?",
        )
        .run(Date.now(), agencyId, id);
      this.audit("invoice", id, "voided", before, { reason: reason ?? null }, options);
    })();
    return this.getInvoice(id, agencyId)!;
  }

  /**
   * Record an invoice that already happened — the backlogging entry point.
   *
   * Creates the invoice, issues it at `issuedAt`, and applies each payment at
   * its own `paidAt`, all inside one transaction. Every timestamp that revenue
   * reporting reads (`issued_at`, `paid_at`, `recognized_at`, and the row's own
   * `created_at`) is the historical one, so a backdated entry never shows up as
   * having been transacted today.
   */
  recordHistoricalInvoice(
    input: {
      clientId: string;
      issuedAt: number;
      dueAt?: number;
      number?: string;
      currency?: string;
      engagementId?: string;
      proposalId?: string;
      taxCents?: number;
      taxLabel?: string;
      reference?: string;
      notes?: string;
      terms?: string;
      projectIds?: string[];
      lineItems: InvoiceLineItemInput[];
      payments?: Array<{
        amountCents: number;
        paidAt: number;
        method?: string;
        reference?: string;
      }>;
      /** Convenience for "this one was paid in full on the issue date". */
      paidInFullAt?: number;
    },
    options?: ActorOptions,
  ): InvoiceDetail {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    if (!Number.isFinite(input.issuedAt))
      throw new Error("issuedAt is required for a historical invoice");
    return this.db.transaction(() => {
      const created = this.createInvoiceDraft(
        {
          ...input,
          // The row is dated when the work was billed, not when it was typed
          // in, so the invoice list reads as history rather than as today.
          createdAt: input.issuedAt,
        },
        options,
      );
      this.issueInvoice(created.invoice.id, options, {
        issuedAt: input.issuedAt,
        dueAt: input.dueAt,
      });
      const payments = [...(input.payments ?? [])];
      if (input.paidInFullAt !== undefined) {
        const total = this.getInvoice(created.invoice.id, agencyId)!.totalCents;
        payments.push({ amountCents: total, paidAt: input.paidInFullAt });
      }
      for (const payment of payments) {
        this.recordPayment(created.invoice.id, payment, options);
      }
      return this.getInvoiceDetail(agencyId, created.invoice.id)!;
    })();
  }

  /**
   * Bulk backlog import. Rows are applied in one transaction — either the whole
   * batch lands or none of it does — because a half-imported revenue history is
   * worse than no import at all.
   */
  importHistoricalInvoices(
    rows: Array<Parameters<AgencyOperationsStore["recordHistoricalInvoice"]>[0]>,
    options?: ActorOptions,
  ): { imported: InvoiceDetail[]; totalCents: number; collectedCents: number } {
    return this.db.transaction(() => {
      const imported = rows.map((row, index) => {
        try {
          return this.recordHistoricalInvoice(row, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`row ${index + 1}: ${message}`);
        }
      });
      return {
        imported,
        totalCents: imported.reduce((sum, entry) => sum + entry.invoice.totalCents, 0),
        collectedCents: imported.reduce((sum, entry) => sum + entry.invoice.amountPaidCents, 0),
      };
    })();
  }

  private upsertClientRevenueProfile(
    agencyId: string,
    clientId: string,
    input: {
      currency: string;
      mrrCents: number;
      lastInvoiceId: string | null;
      activeSince: number;
    },
  ): ClientRevenueProfile | null {
    this.db
      .prepare(`INSERT INTO client_revenue_profiles
      (agency_id,client_id,currency,mrr_cents,arr_cents,last_invoice_id,active_since,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agency_id,client_id) DO UPDATE SET
        currency=excluded.currency,mrr_cents=excluded.mrr_cents,arr_cents=excluded.arr_cents,
        last_invoice_id=excluded.last_invoice_id,
        -- MIN, not COALESCE: backlogging an older invoice must be able to move
        -- "active since" earlier, which is the whole point of entering it.
        active_since=MIN(COALESCE(client_revenue_profiles.active_since,excluded.active_since),excluded.active_since),
        updated_at=excluded.updated_at`)
      .run(
        agencyId,
        clientId,
        input.currency,
        input.mrrCents,
        input.mrrCents * 12,
        input.lastInvoiceId,
        input.activeSince,
        Date.now(),
      );
    return this.getClientRevenueProfile(agencyId, clientId);
  }

  recordPayment(
    invoiceId: string,
    input: { amountCents: number; paidAt?: number; method?: string; reference?: string },
    options?: ActorOptions,
  ): Payment {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const invoice = this.getInvoice(invoiceId, agencyId);
    if (!invoice) throw new Error("invoice not found");
    if (!["issued", "partially_paid", "overdue"].includes(invoice.status))
      throw new Error("invoice is not payable");
    const amount = nonNegative(input.amountCents, "amountCents");
    if (amount === 0 || amount > invoice.balanceCents)
      throw new Error("payment exceeds outstanding balance");
    const payment: Payment = {
      id: randomUUID(),
      agencyId,
      invoiceId,
      amountCents: amount,
      paidAt: input.paidAt ?? Date.now(),
      method: input.method?.trim() || null,
      reference: input.reference?.trim() || null,
      createdAt: Date.now(),
    };
    const amountPaid = invoice.amountPaidCents + amount;
    const status: InvoiceStatus = amountPaid === invoice.totalCents ? "paid" : "partially_paid";
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO payments
        (id,agency_id,invoice_id,amount_cents,paid_at,method,reference,created_at)
        VALUES (@id,@agencyId,@invoiceId,@amountCents,@paidAt,@method,@reference,@createdAt)`)
        .run(payment);
      this.db
        .prepare("UPDATE invoices SET amount_paid_cents=?, status=?, updated_at=? WHERE id=?")
        .run(amountPaid, status, Date.now(), invoiceId);
      this.insertRevenueEntry({
        id: randomUUID(),
        agencyId,
        clientId: invoice.clientId,
        invoiceId,
        sourceType: "payment_received",
        sourceId: payment.id,
        amountCents: payment.amountCents,
        currency: invoice.currency,
        recurringMonthlyCents: 0,
        description: `Payment for invoice ${invoice.number}`,
        recognizedAt: payment.paidAt,
        createdAt: Date.now(),
      });
      this.audit("payment", payment.id, "recorded", null, payment, options);
      this.audit(
        "invoice",
        invoiceId,
        "payment_applied",
        invoice,
        { amountPaidCents: amountPaid, status },
        options,
      );
    })();
    return payment;
  }

  // ── Hosted payment links ───────────────────────────────────────────────────

  /**
   * Bind a hosted checkout link to an invoice, replacing any existing one.
   *
   * An invoice has at most one live link (invoice_id is the primary key), so
   * "regenerate" is an upsert rather than an append — an operator can never
   * end up with two live links quietly charging different amounts.
   */
  upsertInvoicePaymentLink(
    input: {
      invoiceId: string;
      provider: string;
      externalId: string;
      url: string;
      label?: string | null;
      reference: string;
      amountCents: number;
      currency: string;
      planId?: string | null;
    },
    options?: ActorOptions,
  ): InvoicePaymentLink {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const invoice = this.getInvoice(input.invoiceId, agencyId);
    if (!invoice) throw new Error("invoice not found");
    const now = Date.now();
    const before = this.getInvoicePaymentLink(agencyId, input.invoiceId);
    const row: InvoicePaymentLink = {
      invoiceId: input.invoiceId,
      agencyId,
      provider: input.provider,
      externalId: input.externalId,
      url: input.url,
      label: input.label?.trim() || null,
      reference: input.reference,
      amountCents: nonNegative(input.amountCents, "amountCents"),
      currency: input.currency.trim().toLowerCase(),
      planId: input.planId?.trim() || null,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO invoice_payment_links
             (invoice_id,agency_id,provider,external_id,url,label,reference,amount_cents,currency,plan_id,created_at,updated_at)
           VALUES
             (@invoiceId,@agencyId,@provider,@externalId,@url,@label,@reference,@amountCents,@currency,@planId,@createdAt,@updatedAt)
           ON CONFLICT(invoice_id) DO UPDATE SET
             provider=excluded.provider, external_id=excluded.external_id, url=excluded.url,
             label=excluded.label, reference=excluded.reference, amount_cents=excluded.amount_cents,
             currency=excluded.currency, plan_id=excluded.plan_id, updated_at=excluded.updated_at`,
        )
        .run(row);
      this.audit(
        "invoice",
        input.invoiceId,
        before ? "payment_link_replaced" : "payment_link_attached",
        before,
        // The URL is client-facing, not a secret; no credential is recorded.
        { provider: row.provider, externalId: row.externalId, url: row.url },
        options,
      );
    })();
    return row;
  }

  getInvoicePaymentLink(agencyId: string, invoiceId: string): InvoicePaymentLink | null {
    const row = this.db
      .prepare("SELECT * FROM invoice_payment_links WHERE agency_id=? AND invoice_id=?")
      .get(agencyId, invoiceId) as Row | undefined;
    return row ? camel(row) : null;
  }

  /** Look a link up by the provider's own id — the reconciliation join. */
  findInvoicePaymentLinkByExternalId(
    agencyId: string,
    provider: string,
    externalId: string,
  ): InvoicePaymentLink | null {
    const row = this.db
      .prepare(
        "SELECT * FROM invoice_payment_links WHERE agency_id=? AND provider=? AND external_id=?",
      )
      .get(agencyId, provider, externalId) as Row | undefined;
    return row ? camel(row) : null;
  }

  findInvoicePaymentLinkByReference(
    agencyId: string,
    reference: string,
  ): InvoicePaymentLink | null {
    const row = this.db
      .prepare("SELECT * FROM invoice_payment_links WHERE agency_id=? AND reference=?")
      .get(agencyId, reference) as Row | undefined;
    return row ? camel(row) : null;
  }

  /**
   * A plan is created per link, so a plan id identifies one invoice — but only
   * if it identifies *exactly* one. Two rows sharing a plan id means the
   * provider reused a plan, and that is not positive evidence: return null.
   */
  findInvoicePaymentLinkByPlanId(agencyId: string, planId: string): InvoicePaymentLink | null {
    const rows = this.db
      .prepare("SELECT * FROM invoice_payment_links WHERE agency_id=? AND plan_id=? LIMIT 2")
      .all(agencyId, planId) as Row[];
    return rows.length === 1 ? camel(rows[0]) : null;
  }

  deleteInvoicePaymentLink(agencyId: string, invoiceId: string, options?: ActorOptions): boolean {
    const before = this.getInvoicePaymentLink(agencyId, invoiceId);
    if (!before) return false;
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM invoice_payment_links WHERE agency_id=? AND invoice_id=?")
        .run(agencyId, invoiceId);
      this.audit("invoice", invoiceId, "payment_link_detached", before, null, options);
    })();
    return true;
  }

  // ── External payment receipts (the reconciliation ledger) ──────────────────

  getExternalPaymentReceipt(
    agencyId: string,
    provider: string,
    externalId: string,
  ): ExternalPaymentReceipt | null {
    const row = this.db
      .prepare(
        "SELECT * FROM external_payment_receipts WHERE agency_id=? AND provider=? AND external_id=?",
      )
      .get(agencyId, provider, externalId) as Row | undefined;
    return row ? hydrateReceipt(row) : null;
  }

  getExternalPaymentReceiptById(agencyId: string, id: string): ExternalPaymentReceipt | null {
    const row = this.db
      .prepare("SELECT * FROM external_payment_receipts WHERE agency_id=? AND id=?")
      .get(agencyId, id) as Row | undefined;
    return row ? hydrateReceipt(row) : null;
  }

  listExternalPaymentReceipts(
    agencyId: string,
    filter: { status?: ExternalPaymentReceiptStatus; provider?: string; limit?: number } = {},
  ): ExternalPaymentReceipt[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const where = ["agency_id=?"];
    const args: unknown[] = [agencyId];
    if (filter.status) {
      where.push("status=?");
      args.push(filter.status);
    }
    if (filter.provider) {
      where.push("provider=?");
      args.push(filter.provider);
    }
    args.push(limit);
    return (
      this.db
        .prepare(
          `SELECT * FROM external_payment_receipts WHERE ${where.join(" AND ")}
           ORDER BY paid_at DESC, external_id DESC LIMIT ?`,
        )
        .all(...args) as Row[]
    ).map(hydrateReceipt);
  }

  /**
   * Write a receipt row, and — when the caller resolved it to an invoice —
   * record the payment in the same transaction.
   *
   * Idempotency lives here rather than in the caller: if a receipt for this
   * provider payment already exists, nothing is written and the stored row is
   * returned unchanged. That holds even if the existing row is `unmatched`;
   * re-matching an unmatched receipt goes through `resolveExternalPaymentReceipt`,
   * which is an explicit, audited act.
   */
  recordExternalPaymentReceipt(
    input: {
      provider: string;
      externalId: string;
      amountCents: number;
      currency: string;
      paidAt: number;
      status: ExternalPaymentReceiptStatus;
      matchReason?: string | null;
      invoiceId?: string | null;
      payload?: ExternalPaymentReceipt["payload"];
    },
    options?: ActorOptions,
  ): { receipt: ExternalPaymentReceipt; payment: Payment | null; created: boolean } {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    const existing = this.getExternalPaymentReceipt(agencyId, input.provider, input.externalId);
    if (existing) return { receipt: existing, payment: null, created: false };
    if (input.status === "matched" && !input.invoiceId) {
      throw new Error("a matched receipt requires an invoiceId");
    }
    const now = Date.now();
    let payment: Payment | null = null;
    const receipt: ExternalPaymentReceipt = {
      id: randomUUID(),
      agencyId,
      provider: input.provider,
      externalId: input.externalId,
      amountCents: nonNegative(input.amountCents, "amountCents"),
      currency: input.currency.trim().toLowerCase(),
      paidAt: input.paidAt,
      status: input.status,
      matchReason: input.matchReason ?? null,
      invoiceId: input.invoiceId ?? null,
      paymentId: null,
      payload: input.payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      if (receipt.status === "matched" && receipt.invoiceId) {
        payment = this.recordPayment(
          receipt.invoiceId,
          {
            amountCents: receipt.amountCents,
            // Revenue recognises at the real provider payment date, not at
            // sync time — a payment imported in July for a March invoice
            // lands in March.
            paidAt: receipt.paidAt,
            method: receipt.provider,
            reference: receipt.externalId,
          },
          options,
        );
        receipt.paymentId = payment.id;
      }
      this.insertReceiptRow(receipt);
    })();
    return { receipt, payment, created: true };
  }

  /**
   * Attach an already-recorded, previously unmatched receipt to an invoice —
   * the human-assignment path. Refuses on anything already resolved so a
   * double-click cannot double-charge revenue.
   */
  resolveExternalPaymentReceipt(
    agencyId: string,
    receiptId: string,
    invoiceId: string,
    options?: ActorOptions,
  ): { receipt: ExternalPaymentReceipt; payment: Payment } {
    const existing = this.getExternalPaymentReceiptById(agencyId, receiptId);
    if (!existing) throw new Error("payment receipt not found");
    if (existing.status !== "unmatched") {
      throw new Error(`payment receipt is already ${existing.status}`);
    }
    const invoice = this.getInvoice(invoiceId, agencyId);
    if (!invoice) throw new Error("invoice not found");
    let payment!: Payment;
    this.db.transaction(() => {
      payment = this.recordPayment(
        invoiceId,
        {
          amountCents: existing.amountCents,
          paidAt: existing.paidAt,
          method: existing.provider,
          reference: existing.externalId,
        },
        { ...options, agencyId },
      );
      this.db
        .prepare(
          `UPDATE external_payment_receipts
              SET status='matched', match_reason=?, invoice_id=?, payment_id=?, updated_at=?
            WHERE agency_id=? AND id=?`,
        )
        .run("manual_assignment", invoiceId, payment.id, Date.now(), agencyId, receiptId);
      this.audit(
        "payment_receipt",
        receiptId,
        "assigned",
        existing,
        { invoiceId, paymentId: payment.id },
        { ...options, agencyId },
      );
    })();
    return { receipt: this.getExternalPaymentReceiptById(agencyId, receiptId)!, payment };
  }

  /** Park a receipt a human has decided is not ours to apply. */
  ignoreExternalPaymentReceipt(
    agencyId: string,
    receiptId: string,
    reason?: string,
    options?: ActorOptions,
  ): ExternalPaymentReceipt {
    const existing = this.getExternalPaymentReceiptById(agencyId, receiptId);
    if (!existing) throw new Error("payment receipt not found");
    if (existing.status !== "unmatched") {
      throw new Error(`payment receipt is already ${existing.status}`);
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE external_payment_receipts SET status='ignored', match_reason=?, updated_at=?
            WHERE agency_id=? AND id=?`,
        )
        .run(reason?.trim() || "ignored_by_operator", Date.now(), agencyId, receiptId);
      this.audit(
        "payment_receipt",
        receiptId,
        "ignored",
        existing,
        { reason: reason ?? null },
        { ...options, agencyId },
      );
    })();
    return this.getExternalPaymentReceiptById(agencyId, receiptId)!;
  }

  private insertReceiptRow(receipt: ExternalPaymentReceipt): void {
    this.db
      .prepare(
        `INSERT INTO external_payment_receipts
           (agency_id,provider,external_id,id,amount_cents,currency,paid_at,status,match_reason,invoice_id,payment_id,payload_json,created_at,updated_at)
         VALUES
           (@agencyId,@provider,@externalId,@id,@amountCents,@currency,@paidAt,@status,@matchReason,@invoiceId,@paymentId,@payloadJson,@createdAt,@updatedAt)`,
      )
      .run({ ...receipt, payloadJson: JSON.stringify(receipt.payload ?? {}) });
  }

  /**
   * Invoices a payment of exactly `amountCents` in `currency` could plausibly
   * settle, within `[paidAt - windowMs, paidAt + dayMs]` of issue.
   *
   * Deliberately returns *every* candidate rather than a best guess — the
   * caller refuses to match unless there is exactly one.
   */
  findInvoicesByOutstandingAmount(
    agencyId: string,
    amountCents: number,
    currency: string,
    issuedFrom: number,
    issuedTo: number,
  ): Invoice[] {
    return (
      this.db
        .prepare(
          `SELECT *, total_cents - amount_paid_cents AS balance_cents FROM invoices
            WHERE agency_id=? AND status IN ('issued','partially_paid','overdue')
              AND LOWER(currency)=?
              AND total_cents - amount_paid_cents = ?
              AND issued_at IS NOT NULL AND issued_at >= ? AND issued_at <= ?
            ORDER BY issued_at`,
        )
        .all(agencyId, currency.trim().toLowerCase(), amountCents, issuedFrom, issuedTo) as Row[]
    ).map(camel);
  }

  getInvoice(id: string, agencyId = DEFAULT_AGENCY_ID): Invoice | null {
    const row = this.db
      .prepare(
        "SELECT *, total_cents - amount_paid_cents AS balance_cents FROM invoices WHERE id=? AND agency_id=?",
      )
      .get(id, agencyId) as Row | undefined;
    return row ? camel(row) : null;
  }

  listInvoices(agencyId = DEFAULT_AGENCY_ID, status?: InvoiceStatus): Invoice[] {
    const rows = status
      ? this.db
          .prepare(
            "SELECT *,total_cents-amount_paid_cents AS balance_cents FROM invoices WHERE agency_id=? AND status=? ORDER BY created_at DESC",
          )
          .all(agencyId, status)
      : this.db
          .prepare(
            "SELECT *,total_cents-amount_paid_cents AS balance_cents FROM invoices WHERE agency_id=? ORDER BY created_at DESC",
          )
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  listInvoiceLineItems(agencyId: string, invoiceId: string): InvoiceLineItem[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM invoice_line_items WHERE agency_id=? AND invoice_id=? ORDER BY sort_order",
        )
        .all(agencyId, invoiceId) as Row[]
    ).map(camel);
  }

  listInvoiceProjectLinks(agencyId: string, invoiceId?: string): InvoiceProjectLink[] {
    const rows = invoiceId
      ? this.db
          // project_id breaks the tie: links written in the same millisecond
          // must still come back in a stable order.
          .prepare(
            "SELECT * FROM invoice_project_links WHERE agency_id=? AND invoice_id=? ORDER BY created_at, project_id",
          )
          .all(agencyId, invoiceId)
      : this.db
          .prepare("SELECT * FROM invoice_project_links WHERE agency_id=? ORDER BY created_at DESC")
          .all(agencyId);
    return (rows as Row[]).map(camel);
  }

  ingestParsedInvoice(
    parsed: ParsedInvoiceDocument,
    input: { sourceText: string; sourceName?: string; projectId?: string; clientId?: string },
    options?: ActorOptions,
  ): {
    duplicate: boolean;
    client: Client;
    invoice: Invoice;
    lineItems: InvoiceLineItem[];
    projectLinks: InvoiceProjectLink[];
    revenueEntries: RevenueEntry[];
    revenueProfile: ClientRevenueProfile | null;
  } {
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    this.requireAgency(agencyId);
    if (!parsed.invoiceNumber.trim()) throw new Error("invoice number is required");
    if (!parsed.clientName.trim() && !input.clientId) throw new Error("client name is required");
    if (parsed.totalCents <= 0) throw new Error("invoice total must be greater than zero");
    const existingImport = this.db
      .prepare("SELECT invoice_id FROM invoice_imports WHERE agency_id=? AND source_hash=?")
      .get(agencyId, parsed.sourceHash) as { invoice_id: string } | undefined;
    if (existingImport) {
      const invoice = this.getInvoice(existingImport.invoice_id, agencyId);
      if (!invoice) throw new Error("invoice import references a missing invoice");
      const client = this.getClient(invoice.clientId, agencyId);
      if (!client) throw new Error("invoice import references a missing client");
      return {
        duplicate: true,
        client,
        invoice,
        lineItems: this.listInvoiceLineItems(agencyId, invoice.id),
        projectLinks: this.listInvoiceProjectLinks(agencyId, invoice.id),
        revenueEntries: this.listRevenueEntries(agencyId, { invoiceId: invoice.id }),
        revenueProfile: this.getClientRevenueProfile(agencyId, client.id),
      };
    }

    return this.db.transaction(() => {
      let client = input.clientId ? this.getClient(input.clientId, agencyId) : null;
      if (input.clientId && !client) throw new Error("client not found");
      client ??=
        this.listClients(agencyId).find(
          (candidate) => candidate.name.toLowerCase() === parsed.clientName.toLowerCase(),
        ) ?? null;
      if (!client) {
        client = this.createClient(
          { name: parsed.clientName, billingEmail: parsed.billingEmail ?? undefined },
          options,
        );
      }
      if (client.status !== "active" || (!client.billingEmail && parsed.billingEmail)) {
        client = this.updateClient(
          client.id,
          {
            // Set the real status, not just the rollup, so the two stay in
            // step. Guarded by `status !== "active"` above, so a client
            // already live under a richer status ("In progress") is untouched.
            pipelineStatus: client.status === "active" ? undefined : "Active",
            billingEmail: client.billingEmail ?? parsed.billingEmail,
          },
          options,
        );
      }

      const sameNumber = this.db
        .prepare("SELECT id FROM invoices WHERE agency_id=? AND number=?")
        .get(agencyId, parsed.invoiceNumber) as { id: string } | undefined;
      if (sameNumber) {
        const invoice = this.getInvoice(sameNumber.id, agencyId)!;
        this.db
          .prepare(`INSERT INTO invoice_imports
          (id,agency_id,invoice_id,source_hash,source_name,source_text,parsed_json,confidence,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(
            randomUUID(),
            agencyId,
            invoice.id,
            parsed.sourceHash,
            input.sourceName?.trim() || null,
            input.sourceText,
            JSON.stringify(parsed),
            parsed.confidence,
            Date.now(),
          );
        return {
          duplicate: true,
          client,
          invoice,
          lineItems: this.listInvoiceLineItems(agencyId, invoice.id),
          projectLinks: this.listInvoiceProjectLinks(agencyId, invoice.id),
          revenueEntries: this.listRevenueEntries(agencyId, { invoiceId: invoice.id }),
          revenueProfile: this.getClientRevenueProfile(agencyId, client.id),
        };
      }

      let invoice = this.createInvoice(
        {
          clientId: client.id,
          number: parsed.invoiceNumber,
          subtotalCents: parsed.subtotalCents,
          taxCents: parsed.taxCents,
          currency: parsed.currency,
          dueAt: parsed.dueAt ?? undefined,
        },
        options,
      );
      if (parsed.status !== "draft") invoice = this.issueInvoice(invoice.id, options);
      const issuedAt = parsed.issuedAt ?? invoice.issuedAt ?? Date.now();
      this.db
        .prepare("UPDATE invoices SET issued_at=?, updated_at=? WHERE agency_id=? AND id=?")
        .run(issuedAt, Date.now(), agencyId, invoice.id);
      invoice = this.getInvoice(invoice.id, agencyId)!;

      const lineItems: InvoiceLineItem[] = parsed.lineItems.map((item, sortOrder) => ({
        id: randomUUID(),
        agencyId,
        invoiceId: invoice.id,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
        cadence: item.cadence,
        sortOrder,
      }));
      const insertLine = this.db.prepare(`INSERT INTO invoice_line_items
        (id,agency_id,invoice_id,description,quantity,unit_price_cents,total_cents,cadence,sort_order)
        VALUES (@id,@agencyId,@invoiceId,@description,@quantity,@unitPriceCents,@totalCents,@cadence,@sortOrder)`);
      for (const line of lineItems) insertLine.run(line);

      const projects = this.listProjects(agencyId);
      const normalized = (value: string) =>
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      const candidateText = normalized(
        [parsed.projectName, ...parsed.lineItems.map((item) => item.description)]
          .filter(Boolean)
          .join(" "),
      );
      let project = input.projectId ? this.getProject(agencyId, input.projectId) : null;
      if (input.projectId && !project) throw new Error("project not found");
      if (!project && parsed.projectName) {
        const requested = normalized(parsed.projectName);
        project = projects.find((candidate) => normalized(candidate.name) === requested) ?? null;
      }
      if (!project && candidateText) {
        project =
          projects
            .filter((candidate) => !candidate.clientId || candidate.clientId === client.id)
            .map((candidate) => {
              const name = normalized(candidate.name);
              const tokens = name.split(" ").filter((token) => token.length > 2);
              const matches = tokens.filter((token) => candidateText.includes(token)).length;
              return { candidate, score: tokens.length ? matches / tokens.length : 0 };
            })
            .filter(({ score }) => score >= 0.6)
            .sort((a, b) => b.score - a.score)[0]?.candidate ?? null;
      }
      if (project?.clientId && project.clientId !== client.id) {
        throw new Error("selected project belongs to a different client");
      }
      if (project && !project.clientId) {
        this.db
          .prepare("UPDATE agency_projects SET client_id=?,updated_at=? WHERE agency_id=? AND id=?")
          .run(client.id, Date.now(), agencyId, project.id);
      }
      const projectLinks: InvoiceProjectLink[] = project
        ? [
            {
              agencyId,
              invoiceId: invoice.id,
              projectId: project.id,
              allocationCents: invoice.totalCents,
              createdAt: Date.now(),
            },
          ]
        : [];
      if (projectLinks[0]) {
        this.db
          .prepare(`INSERT INTO invoice_project_links
          (agency_id,invoice_id,project_id,allocation_cents,created_at)
          VALUES (@agencyId,@invoiceId,@projectId,@allocationCents,@createdAt)`)
          .run(projectLinks[0]);
      }

      const revenueEntries: RevenueEntry[] = [];
      if (parsed.status !== "draft") {
        const entry: RevenueEntry = {
          id: randomUUID(),
          agencyId,
          clientId: client.id,
          invoiceId: invoice.id,
          sourceType: "invoice_issued",
          sourceId: invoice.id,
          amountCents: invoice.totalCents,
          currency: invoice.currency,
          recurringMonthlyCents: parsed.recurringMonthlyCents,
          description: `Invoice ${invoice.number} issued`,
          recognizedAt: issuedAt,
          createdAt: Date.now(),
        };
        this.insertRevenueEntry(entry);
        revenueEntries.push(entry);
      }

      if (parsed.amountPaidCents > 0) {
        if (invoice.status === "draft") invoice = this.issueInvoice(invoice.id, options);
        const payment = this.recordPayment(
          invoice.id,
          {
            amountCents: Math.min(parsed.amountPaidCents, invoice.balanceCents),
            paidAt: parsed.issuedAt ?? Date.now(),
            method: "invoice_import",
            reference: input.sourceName,
          },
          options,
        );
        const entry = this.listRevenueEntries(agencyId, { invoiceId: invoice.id }).find(
          (candidate) =>
            candidate.sourceType === "payment_received" && candidate.sourceId === payment.id,
        );
        if (entry) revenueEntries.push(entry);
        invoice = this.getInvoice(invoice.id, agencyId)!;
      }

      let revenueProfile: ClientRevenueProfile | null = null;
      if (parsed.recurringMonthlyCents > 0) {
        const activeSince =
          this.getClientRevenueProfile(agencyId, client.id)?.activeSince ?? issuedAt;
        this.db
          .prepare(`INSERT INTO client_revenue_profiles
          (agency_id,client_id,currency,mrr_cents,arr_cents,last_invoice_id,active_since,updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(agency_id,client_id) DO UPDATE SET
            currency=excluded.currency,mrr_cents=excluded.mrr_cents,arr_cents=excluded.arr_cents,
            last_invoice_id=excluded.last_invoice_id,
            active_since=COALESCE(client_revenue_profiles.active_since,excluded.active_since),
            updated_at=excluded.updated_at`)
          .run(
            agencyId,
            client.id,
            invoice.currency,
            parsed.recurringMonthlyCents,
            parsed.recurringMonthlyCents * 12,
            invoice.id,
            activeSince,
            Date.now(),
          );
        revenueProfile = this.getClientRevenueProfile(agencyId, client.id);
      }

      this.db
        .prepare(`INSERT INTO invoice_imports
        (id,agency_id,invoice_id,source_hash,source_name,source_text,parsed_json,confidence,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          randomUUID(),
          agencyId,
          invoice.id,
          parsed.sourceHash,
          input.sourceName?.trim() || null,
          input.sourceText,
          JSON.stringify(parsed),
          parsed.confidence,
          Date.now(),
        );
      this.audit(
        "invoice",
        invoice.id,
        "parsed_and_imported",
        null,
        {
          sourceName: input.sourceName ?? null,
          sourceHash: parsed.sourceHash,
          confidence: parsed.confidence,
          recurringMonthlyCents: parsed.recurringMonthlyCents,
        },
        options,
      );
      return {
        duplicate: false,
        client,
        invoice,
        lineItems,
        projectLinks,
        revenueEntries,
        revenueProfile,
      };
    })();
  }

  /**
   * Write a revenue entry, keyed on `(agency, source_type, source_id)`.
   *
   * Upsert rather than insert: an invoice can be issued and then have its
   * recognition date corrected (the ingest path issues first and backdates
   * second), and the recognised amount/date must end up matching the invoice —
   * not throw a constraint error and leave the first, wrong figure in place.
   */
  private insertRevenueEntry(entry: RevenueEntry): void {
    this.db
      .prepare(`INSERT INTO revenue_entries
      (id,agency_id,client_id,invoice_id,source_type,source_id,amount_cents,currency,
       recurring_monthly_cents,description,recognized_at,created_at)
      VALUES (@id,@agencyId,@clientId,@invoiceId,@sourceType,@sourceId,@amountCents,@currency,
       @recurringMonthlyCents,@description,@recognizedAt,@createdAt)
      ON CONFLICT(agency_id,source_type,source_id) DO UPDATE SET
        client_id=excluded.client_id,
        invoice_id=excluded.invoice_id,
        amount_cents=excluded.amount_cents,
        currency=excluded.currency,
        recurring_monthly_cents=excluded.recurring_monthly_cents,
        description=excluded.description,
        recognized_at=excluded.recognized_at`)
      .run(entry);
  }

  getClientRevenueProfile(agencyId: string, clientId: string): ClientRevenueProfile | null {
    const row = this.db
      .prepare("SELECT * FROM client_revenue_profiles WHERE agency_id=? AND client_id=?")
      .get(agencyId, clientId) as Row | undefined;
    return row ? camel(row) : null;
  }

  /**
   * Manually set a client's monthly recurring revenue (and the derived ARR).
   * Unlike the invoice-driven upsert this does not touch `last_invoice_id`, and
   * preserves the existing `active_since` / `currency` so an operator entering a
   * flat MRR from the revenue modal never erases the invoice lineage.
   */
  setClientMrr(
    agencyId: string,
    clientId: string,
    mrrCents: number,
    currency?: string,
  ): ClientRevenueProfile | null {
    this.requireAgency(agencyId);
    if (!this.getClient(clientId, agencyId)) throw new Error("client not found");
    const amount = nonNegative(mrrCents, "mrrCents");
    const existing = this.getClientRevenueProfile(agencyId, clientId);
    const now = Date.now();
    const resolvedCurrency = currency ?? existing?.currency ?? "USD";
    this.db
      .prepare(`INSERT INTO client_revenue_profiles
      (agency_id,client_id,currency,mrr_cents,arr_cents,last_invoice_id,active_since,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agency_id,client_id) DO UPDATE SET
        currency=excluded.currency,mrr_cents=excluded.mrr_cents,arr_cents=excluded.arr_cents,
        updated_at=excluded.updated_at`)
      .run(
        agencyId,
        clientId,
        resolvedCurrency,
        amount,
        amount * 12,
        existing?.lastInvoiceId ?? null,
        existing?.activeSince ?? now,
        now,
      );
    return this.getClientRevenueProfile(agencyId, clientId);
  }

  listClientRevenueProfiles(agencyId: string): ClientRevenueProfile[] {
    return (
      this.db
        .prepare("SELECT * FROM client_revenue_profiles WHERE agency_id=? ORDER BY mrr_cents DESC")
        .all(agencyId) as Row[]
    ).map(camel);
  }

  listRevenueEntries(
    agencyId: string,
    filters: { invoiceId?: string; startAt?: number; endAt?: number; limit?: number } = {},
  ): RevenueEntry[] {
    const where = ["agency_id=?"];
    const params: unknown[] = [agencyId];
    if (filters.invoiceId) {
      where.push("invoice_id=?");
      params.push(filters.invoiceId);
    }
    if (filters.startAt !== undefined) {
      where.push("recognized_at>=?");
      params.push(filters.startAt);
    }
    if (filters.endAt !== undefined) {
      where.push("recognized_at<?");
      params.push(filters.endAt);
    }
    params.push(Math.max(1, Math.min(1_000, filters.limit ?? 250)));
    return (
      this.db
        .prepare(
          `SELECT * FROM revenue_entries WHERE ${where.join(" AND ")}
           ORDER BY recognized_at DESC, created_at DESC LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map(camel);
  }

  revenueSummary(agencyId: string, periodStart: number, periodEnd: number): RevenueSummary {
    const rows = this.db
      .prepare(`
      SELECT c.id client_id,c.name client_name,
        COALESCE(SUM(CASE WHEN r.source_type='invoice_issued' THEN r.amount_cents ELSE 0 END),0) invoiced_cents,
        COALESCE(SUM(CASE WHEN r.source_type='payment_received' THEN r.amount_cents ELSE 0 END),0) collected_cents,
        COALESCE(p.mrr_cents,0) mrr_cents
      FROM clients c
      LEFT JOIN revenue_entries r ON r.client_id=c.id AND r.agency_id=c.agency_id
        AND r.recognized_at>=? AND r.recognized_at<?
      LEFT JOIN client_revenue_profiles p ON p.client_id=c.id AND p.agency_id=c.agency_id
      WHERE c.agency_id=?
      GROUP BY c.id,c.name,p.mrr_cents
      HAVING invoiced_cents>0 OR collected_cents>0 OR mrr_cents>0
      ORDER BY collected_cents DESC,invoiced_cents DESC,mrr_cents DESC
    `)
      .all(periodStart, periodEnd, agencyId) as Array<{
      client_id: string;
      client_name: string;
      invoiced_cents: number;
      collected_cents: number;
      mrr_cents: number;
    }>;
    const invoicedRevenueCents = rows.reduce((sum, row) => sum + row.invoiced_cents, 0);
    const collectedRevenueCents = rows.reduce((sum, row) => sum + row.collected_cents, 0);
    const mrrCents = rows.reduce((sum, row) => sum + row.mrr_cents, 0);
    const revenueClients = rows.filter((row) => row.collected_cents > 0).length;
    const projectRows = this.db
      .prepare(`
      SELECT p.id project_id,p.name project_name,
        COALESCE(SUM(CASE WHEN r.source_type='invoice_issued' THEN r.amount_cents ELSE 0 END),0) invoiced_cents,
        COALESCE(SUM(CASE WHEN r.source_type='payment_received' THEN r.amount_cents ELSE 0 END),0) collected_cents
      FROM agency_projects p
      JOIN invoice_project_links l ON l.project_id=p.id AND l.agency_id=p.agency_id
      JOIN revenue_entries r ON r.invoice_id=l.invoice_id AND r.agency_id=l.agency_id
        AND r.recognized_at>=? AND r.recognized_at<?
      WHERE p.agency_id=?
      GROUP BY p.id,p.name
      ORDER BY invoiced_cents DESC,collected_cents DESC
    `)
      .all(periodStart, periodEnd, agencyId) as Array<{
      project_id: string;
      project_name: string;
      invoiced_cents: number;
      collected_cents: number;
    }>;
    const trendStart = new Date(periodEnd);
    trendStart.setUTCMonth(trendStart.getUTCMonth() - 12);
    const trendRows = this.db
      .prepare(`
      SELECT strftime('%Y-%m', recognized_at / 1000, 'unixepoch') month,
        COALESCE(SUM(CASE WHEN source_type='invoice_issued' THEN amount_cents ELSE 0 END),0) invoiced_cents,
        COALESCE(SUM(CASE WHEN source_type='payment_received' THEN amount_cents ELSE 0 END),0) collected_cents
      FROM revenue_entries
      WHERE agency_id=? AND recognized_at>=? AND recognized_at<?
      GROUP BY month ORDER BY month
    `)
      .all(agencyId, trendStart.getTime(), periodEnd) as Array<{
      month: string;
      invoiced_cents: number;
      collected_cents: number;
    }>;
    return {
      currency: "USD",
      periodStart,
      periodEnd,
      invoicedRevenueCents,
      collectedRevenueCents,
      mrrCents,
      arrCents: mrrCents * 12,
      activeMrrClients: rows.filter((row) => row.mrr_cents > 0).length,
      averageRevenuePerClientCents: revenueClients
        ? Math.round(collectedRevenueCents / revenueClients)
        : 0,
      revenueByClient: rows.map((row) => ({
        clientId: row.client_id,
        clientName: row.client_name,
        invoicedCents: row.invoiced_cents,
        collectedCents: row.collected_cents,
        mrrCents: row.mrr_cents,
      })),
      revenueByProject: projectRows.map((row) => ({
        projectId: row.project_id,
        projectName: row.project_name,
        invoicedCents: row.invoiced_cents,
        collectedCents: row.collected_cents,
      })),
      trend: trendRows.map((row) => ({
        month: row.month,
        invoicedCents: row.invoiced_cents,
        collectedCents: row.collected_cents,
      })),
      pipeline: this.revenuePipelineSummary(agencyId),
    };
  }

  /**
   * Forward-looking revenue: what has been sold but not yet billed, plus what
   * is still in the pipeline weighted by its own probability.
   *
   * `acceptedUninvoicedCents` is the number that makes an accepted proposal
   * move the figure: the moment an invoice is raised against that proposal the
   * same money stops counting as "expected" and starts counting as invoiced,
   * so the two never double-count. Void invoices are excluded — a voided bill
   * puts its proposal back into the expected column, which is correct.
   */
  revenuePipelineSummary(agencyId = DEFAULT_AGENCY_ID): RevenuePipelineSummary {
    const value = (sql: string, ...params: unknown[]) =>
      (this.db
        .prepare(sql)
        .pluck()
        .get(...params) as number | null) ?? 0;
    const openProposalCents = value(
      "SELECT SUM(total_cents) FROM proposals WHERE agency_id=? AND status IN ('draft','internal_review','sent')",
      agencyId,
    );
    const acceptedProposalCents = value(
      "SELECT SUM(total_cents) FROM proposals WHERE agency_id=? AND status='accepted'",
      agencyId,
    );
    const acceptedUninvoicedCents = value(
      `SELECT SUM(MAX(0, p.total_cents - COALESCE(billed.total, 0)))
         FROM proposals p
         LEFT JOIN (
           SELECT proposal_id, SUM(total_cents) total FROM invoices
            WHERE agency_id=? AND status <> 'void' AND proposal_id IS NOT NULL
            GROUP BY proposal_id
         ) billed ON billed.proposal_id = p.id
        WHERE p.agency_id=? AND p.status='accepted'`,
      agencyId,
      agencyId,
    );
    const openPipelineCents = value(
      "SELECT SUM(value_cents) FROM opportunities WHERE agency_id=? AND stage IN ('lead','qualified','proposal')",
      agencyId,
    );
    const weightedPipelineCents = Math.round(
      value(
        "SELECT SUM(value_cents * probability) FROM opportunities WHERE agency_id=? AND stage IN ('lead','qualified','proposal')",
        agencyId,
      ),
    );
    return {
      openProposalCents,
      acceptedProposalCents,
      acceptedUninvoicedCents,
      openPipelineCents,
      weightedPipelineCents,
      expectedRevenueCents: acceptedUninvoicedCents + weightedPipelineCents,
    };
  }

  markOverdue(now = Date.now(), agencyId = DEFAULT_AGENCY_ID, actorId?: string): number {
    const invoices = this.db
      .prepare(
        "SELECT id FROM invoices WHERE agency_id=? AND due_at < ? AND status IN ('issued','partially_paid')",
      )
      .all(agencyId, now) as Array<{ id: string }>;
    for (const { id } of invoices) {
      this.transitionSimple("invoice", "invoices", id, "overdue", { agencyId, actorId }, () =>
        this.getInvoice(id, agencyId),
      );
    }
    return invoices.length;
  }

  businessSummary(agencyId = DEFAULT_AGENCY_ID): BusinessSummary {
    const value = (sql: string, ...params: unknown[]) =>
      (this.db
        .prepare(sql)
        .pluck()
        .get(...params) as number | null) ?? 0;
    return {
      activeClients: value(
        "SELECT COUNT(*) FROM clients WHERE agency_id=? AND status='active'",
        agencyId,
      ),
      openPipelineCents: value(
        "SELECT SUM(value_cents) FROM opportunities WHERE agency_id=? AND stage IN ('lead','qualified','proposal')",
        agencyId,
      ),
      weightedPipelineCents: Math.round(
        value(
          "SELECT SUM(value_cents * probability) FROM opportunities WHERE agency_id=? AND stage IN ('lead','qualified','proposal')",
          agencyId,
        ),
      ),
      wonRevenueCents: value(
        "SELECT SUM(value_cents) FROM opportunities WHERE agency_id=? AND stage='won'",
        agencyId,
      ),
      activeEngagements: value(
        "SELECT COUNT(*) FROM engagements WHERE agency_id=? AND status IN ('active','on_hold')",
        agencyId,
      ),
      deliverablesAwaitingClient: value(
        "SELECT COUNT(*) FROM deliverables WHERE agency_id=? AND status='client_review'",
        agencyId,
      ),
      outstandingInvoicesCents: value(
        "SELECT SUM(total_cents - amount_paid_cents) FROM invoices WHERE agency_id=? AND status IN ('issued','partially_paid','overdue')",
        agencyId,
      ),
      overdueInvoicesCents: value(
        "SELECT SUM(total_cents - amount_paid_cents) FROM invoices WHERE agency_id=? AND status='overdue'",
        agencyId,
      ),
      collectedCents: value("SELECT SUM(amount_cents) FROM payments WHERE agency_id=?", agencyId),
    };
  }

  listAuditEvents(
    entityType: string,
    entityId: string,
    agencyId = DEFAULT_AGENCY_ID,
  ): AuditEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM audit_events WHERE agency_id=? AND entity_type=? AND entity_id=? ORDER BY id",
        )
        .all(agencyId, entityType, entityId) as Row[]
    ).map((row) => {
      const event = camel(row);
      event.before = event.beforeJson ? JSON.parse(event.beforeJson) : null;
      event.after = event.afterJson ? JSON.parse(event.afterJson) : null;
      delete event.beforeJson;
      delete event.afterJson;
      return event;
    });
  }

  listAgencyAuditEvents(
    agencyId: string,
    options: { limit?: number; beforeId?: number; entityType?: string; actorId?: string } = {},
  ): AuditEvent[] {
    this.requireAgency(agencyId);
    const where = ["agency_id=?"];
    const params: unknown[] = [agencyId];
    if (options.beforeId !== undefined) {
      where.push("id<?");
      params.push(options.beforeId);
    }
    if (options.entityType) {
      where.push("entity_type=?");
      params.push(options.entityType);
    }
    if (options.actorId) {
      where.push("actor_id=?");
      params.push(options.actorId);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    params.push(limit);
    // Deliberately excludes before_json/after_json. This feed renders as a
    // timeline of what changed, never the payloads, but a single row can carry
    // a whole imported business snapshot — selecting them made one page of 100
    // events tens of megabytes over the websocket. Use listAuditEvents for one
    // entity's full history when the payloads are actually needed.
    return (
      this.db
        .prepare(
          `SELECT id, agency_id, actor_id, entity_type, entity_id, action, created_at,
                LENGTH(COALESCE(before_json,'')) + LENGTH(COALESCE(after_json,'')) AS payload_bytes
         FROM audit_events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map((row) => {
      const event = camel(row);
      event.before = null;
      event.after = null;
      return event as AuditEvent;
    });
  }

  /**
   * Exports every canonical agency-scoped row from agency.db. The payload is
   * deterministic and digest-addressed so reconnects can cheaply detect an
   * already-converged peer. Replication bookkeeping is deliberately excluded.
   */
  exportReplicationSnapshot(agencyId: string, sourceNodeId: string): AgencyReplicationSnapshot {
    this.requireAgency(agencyId);
    const safeSourceNodeId = required(sourceNodeId, "sourceNodeId");
    const tableNames = (
      this.db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .filter(
        (name) =>
          name !== "schema_migrations" &&
          name !== "agency_replication_state" &&
          name !== "agency_replication_conflicts",
      )
      .sort((left, right) => {
        if (left === "agency_tombstones") return 1;
        if (right === "agency_tombstones") return -1;
        return left.localeCompare(right);
      });

    const tables: AgencyReplicationTable[] = [];
    for (const name of tableNames) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) continue;
      const info = this.db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
        name: string;
        pk: number;
      }>;
      const columns = info.map((column) => column.name);
      const primaryKey = info
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      if (!primaryKey.length) continue;
      let rows: Row[];
      if (name === "agencies") {
        rows = this.db.prepare(`SELECT * FROM "${name}" WHERE id=?`).all(agencyId) as Row[];
      } else if (name === "audit_events") {
        // Repeated compatibility migration runs in older builds emitted a
        // legacy_synced event for every unchanged row. Those events duplicate
        // the canonical entity state (hundreds of MB on established installs)
        // and can exceed the federation frame limit. The verified database
        // backup retains that raw compatibility history; federation carries
        // the canonical rows plus the operating audit stream created after
        // replication was introduced.
        rows = (
          this.db
            .prepare(
              `SELECT * FROM audit_events
               WHERE agency_id=?
                 AND created_at >= COALESCE(
                   (SELECT applied_at FROM schema_migrations WHERE version=6),
                   0
                 )
                 AND action NOT LIKE 'legacy_%'`,
            )
            .all(agencyId) as Row[]
        ).map((row) => {
          const { id: _localSequence, ...event } = row;
          const stableId = Number.parseInt(
            createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 13),
            16,
          );
          return { id: -stableId, ...event };
        });
      } else if (columns.includes("agency_id")) {
        rows = this.db.prepare(`SELECT * FROM "${name}" WHERE agency_id=?`).all(agencyId) as Row[];
      } else {
        continue;
      }
      rows.sort((left, right) =>
        primaryKey
          .map((key) => String(left[key] ?? ""))
          .join("\u0000")
          .localeCompare(primaryKey.map((key) => String(right[key] ?? "")).join("\u0000")),
      );
      tables.push({ name, columns, primaryKey, rows });
    }
    const body = JSON.stringify({
      schemaVersion: AGENCY_DATABASE_SCHEMA_VERSION,
      agencyId,
      tables,
    });
    return {
      schemaVersion: AGENCY_DATABASE_SCHEMA_VERSION,
      agencyId,
      sourceNodeId: safeSourceNodeId,
      exportedAt: Date.now(),
      digest: createHash("sha256").update(body).digest("hex"),
      tables,
    };
  }

  /**
   * Atomically reconciles a peer snapshot. Rows are never deleted by a
   * snapshot, preventing an offline/stale node from erasing newer shared data.
   * Timestamped rows use last-writer-wins; equal-version conflicts use a
   * deterministic content hash and are retained for operator review.
   */
  mergeReplicationSnapshot(
    snapshot: AgencyReplicationSnapshot,
    localNodeId: string,
  ): AgencyReplicationMergeResult {
    if (!snapshot || typeof snapshot !== "object") throw new Error("replication snapshot required");
    const agencyId = required(snapshot.agencyId, "agencyId");
    const sourceNodeId = required(snapshot.sourceNodeId, "sourceNodeId");
    required(localNodeId, "localNodeId");
    this.requireAgency(agencyId);
    if (
      !Number.isInteger(snapshot.schemaVersion) ||
      snapshot.schemaVersion > AGENCY_DATABASE_SCHEMA_VERSION
    ) {
      throw new Error("replication snapshot schema is newer than this runtime");
    }
    if (!Array.isArray(snapshot.tables)) throw new Error("invalid replication snapshot tables");
    const encoded = JSON.stringify(snapshot);
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024 * 1024) {
      throw new Error("replication snapshot exceeds 64 MB");
    }

    const result: AgencyReplicationMergeResult = {
      agencyId,
      sourceNodeId,
      receivedDigest: required(snapshot.digest, "digest"),
      localDigest: "",
      inserted: 0,
      updated: 0,
      keptLocal: 0,
      unchanged: 0,
      conflicts: 0,
      mergedAt: Date.now(),
    };

    this.db.transaction(() => {
      this.db.pragma("defer_foreign_keys = ON");
      for (const incomingTable of snapshot.tables) {
        const name = incomingTable?.name;
        if (
          typeof name !== "string" ||
          !/^[a-zA-Z0-9_]+$/.test(name) ||
          name === "schema_migrations" ||
          name.startsWith("agency_replication_") ||
          name === "agency_tombstones"
        ) {
          continue;
        }
        const info = this.db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
          name: string;
          pk: number;
        }>;
        if (!info.length) continue;
        const localColumns = info.map((column) => column.name);
        const primaryKey = info
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name);
        if (!primaryKey.length || !Array.isArray(incomingTable.rows)) continue;
        const scopeColumn = name === "agencies" ? "id" : "agency_id";
        if (!localColumns.includes(scopeColumn)) continue;

        for (const candidate of incomingTable.rows) {
          if (!candidate || typeof candidate !== "object" || candidate[scopeColumn] !== agencyId) {
            continue;
          }
          const row = Object.fromEntries(
            Object.entries(candidate).filter(([column]) => localColumns.includes(column)),
          ) as Row;
          if (primaryKey.some((key) => row[key] === undefined || row[key] === null)) continue;
          const tombstoneKey = JSON.stringify(
            Object.fromEntries(primaryKey.map((key) => [key, row[key]])),
          );
          const tombstone = this.db
            .prepare(
              `SELECT deleted_at FROM agency_tombstones
               WHERE agency_id=? AND entity_table=? AND row_key=?`,
            )
            .get(agencyId, name, tombstoneKey) as { deleted_at: number } | undefined;
          const incomingVersion = Number(row.updated_at ?? row.created_at ?? 0);
          if (tombstone && tombstone.deleted_at >= incomingVersion) {
            result.keptLocal += 1;
            continue;
          }
          const where = primaryKey.map((key) => `"${key}"=?`).join(" AND ");
          const keyValues = primaryKey.map((key) => row[key]);
          const local = this.db
            .prepare(`SELECT * FROM "${name}" WHERE ${where}`)
            .get(...keyValues) as Row | undefined;
          if (!local) {
            const columns = Object.keys(row);
            this.db
              .prepare(
                `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(",")})
                 VALUES (${columns.map(() => "?").join(",")})`,
              )
              .run(...columns.map((column) => row[column]));
            result.inserted += 1;
            continue;
          }

          const localJson = JSON.stringify(local);
          const remoteJson = JSON.stringify(row);
          if (localJson === remoteJson) {
            result.unchanged += 1;
            continue;
          }
          const versionColumn = localColumns.includes("updated_at")
            ? "updated_at"
            : localColumns.includes("created_at")
              ? "created_at"
              : null;
          const localVersion = versionColumn ? Number(local[versionColumn] ?? 0) : 0;
          const remoteVersion = versionColumn ? Number(row[versionColumn] ?? 0) : 0;
          const localHash = createHash("sha256").update(localJson).digest("hex");
          const remoteHash = createHash("sha256").update(remoteJson).digest("hex");
          const remoteWins =
            remoteVersion > localVersion ||
            (remoteVersion === localVersion && remoteHash.localeCompare(localHash) > 0);
          const equalVersionConflict = remoteVersion === localVersion;
          if (remoteWins) {
            const columns = Object.keys(row).filter((column) => !primaryKey.includes(column));
            if (columns.length) {
              this.db
                .prepare(
                  `UPDATE "${name}" SET ${columns
                    .map((column) => `"${column}"=?`)
                    .join(",")} WHERE ${where}`,
                )
                .run(...columns.map((column) => row[column]), ...keyValues);
              result.updated += 1;
            }
          } else {
            result.keptLocal += 1;
          }
          if (equalVersionConflict) {
            this.db
              .prepare(
                `INSERT INTO agency_replication_conflicts
                 (id,agency_id,table_name,row_key,local_json,remote_json,local_version,
                  remote_version,winner,source_node_id,created_at,resolved_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
              )
              .run(
                randomUUID(),
                agencyId,
                name,
                JSON.stringify(Object.fromEntries(primaryKey.map((key) => [key, row[key]]))),
                localJson,
                remoteJson,
                localVersion,
                remoteVersion,
                remoteWins ? "remote" : "local",
                sourceNodeId,
                result.mergedAt,
              );
            result.conflicts += 1;
          }
        }
      }

      const tombstoneTable = snapshot.tables.find((table) => table.name === "agency_tombstones");
      for (const candidate of tombstoneTable?.rows ?? []) {
        if (
          !candidate ||
          candidate.agency_id !== agencyId ||
          typeof candidate.entity_table !== "string" ||
          !/^[a-zA-Z0-9_]+$/.test(candidate.entity_table) ||
          typeof candidate.row_key !== "string"
        ) {
          continue;
        }
        const deletedAt = Number(candidate.deleted_at ?? 0);
        if (!Number.isFinite(deletedAt) || deletedAt <= 0) continue;
        let rowKey: Record<string, unknown>;
        try {
          rowKey = JSON.parse(candidate.row_key) as Record<string, unknown>;
        } catch {
          continue;
        }
        const targetInfo = this.db
          .prepare(`PRAGMA table_info("${candidate.entity_table}")`)
          .all() as Array<{ name: string; pk: number }>;
        const primaryKey = targetInfo
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name);
        if (!primaryKey.length || primaryKey.some((key) => rowKey[key] === undefined)) continue;
        const existing = this.db
          .prepare(
            `SELECT * FROM "${candidate.entity_table}" WHERE agency_id=? AND ${primaryKey
              .map((key) => `"${key}"=?`)
              .join(" AND ")}`,
          )
          .get(agencyId, ...primaryKey.map((key) => rowKey[key])) as Row | undefined;
        const existingVersion = Number(existing?.updated_at ?? existing?.created_at ?? 0);
        if (existing && deletedAt >= existingVersion) {
          this.db
            .prepare(
              `DELETE FROM "${candidate.entity_table}" WHERE agency_id=? AND ${primaryKey
                .map((key) => `"${key}"=?`)
                .join(" AND ")}`,
            )
            .run(agencyId, ...primaryKey.map((key) => rowKey[key]));
          result.updated += 1;
        }
        this.recordTombstone(
          agencyId,
          candidate.entity_table,
          rowKey,
          deletedAt,
          typeof candidate.source_node_id === "string" ? candidate.source_node_id : sourceNodeId,
        );
      }
    })();

    result.localDigest = this.exportReplicationSnapshot(agencyId, localNodeId).digest;
    this.recordReplicationStatus(agencyId, {
      peerNodeId: sourceNodeId,
      status: result.localDigest === snapshot.digest ? "in_sync" : "pending",
      lastSyncAt: result.mergedAt,
      lastPullAt: result.mergedAt,
      localDigest: result.localDigest,
      remoteDigest: snapshot.digest,
      conflicts: result.conflicts,
      error: null,
    });
    return result;
  }

  getReplicationStatus(agencyId: string, localNodeId: string): AgencyReplicationStatus {
    const localDigest = this.exportReplicationSnapshot(agencyId, localNodeId).digest;
    const row = this.db
      .prepare("SELECT * FROM agency_replication_state WHERE agency_id=?")
      .get(agencyId) as Row | undefined;
    const remoteDigest = typeof row?.remote_digest === "string" ? row.remote_digest : null;
    const persistedState = typeof row?.last_status === "string" ? row.last_status : "never_synced";
    const pending = remoteDigest !== null && remoteDigest !== localDigest;
    return {
      agencyId,
      peerNodeId: typeof row?.peer_node_id === "string" ? row.peer_node_id : null,
      state:
        persistedState === "offline" || persistedState === "error"
          ? persistedState
          : pending
            ? "pending"
            : remoteDigest
              ? "in_sync"
              : "never_synced",
      lastSyncAt: typeof row?.last_sync_at === "number" ? row.last_sync_at : null,
      lastPushAt: typeof row?.last_push_at === "number" ? row.last_push_at : null,
      lastPullAt: typeof row?.last_pull_at === "number" ? row.last_pull_at : null,
      lastError: typeof row?.last_error === "string" ? row.last_error : null,
      localDigest,
      remoteDigest,
      pending,
      conflicts: Number(row?.conflicts_count ?? 0),
    };
  }

  recordReplicationStatus(
    agencyId: string,
    input: {
      peerNodeId?: string | null;
      status: AgencyReplicationStatus["state"];
      lastSyncAt?: number | null;
      lastPushAt?: number | null;
      lastPullAt?: number | null;
      localDigest?: string | null;
      remoteDigest?: string | null;
      conflicts?: number;
      error?: string | null;
    },
  ): void {
    this.requireAgency(agencyId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agency_replication_state
         (agency_id,peer_node_id,last_sync_at,last_push_at,last_pull_at,last_status,last_error,
          local_digest,remote_digest,conflicts_count,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(agency_id) DO UPDATE SET
           peer_node_id=COALESCE(excluded.peer_node_id,peer_node_id),
           last_sync_at=COALESCE(excluded.last_sync_at,last_sync_at),
           last_push_at=COALESCE(excluded.last_push_at,last_push_at),
           last_pull_at=COALESCE(excluded.last_pull_at,last_pull_at),
           last_status=excluded.last_status,last_error=excluded.last_error,
           local_digest=COALESCE(excluded.local_digest,local_digest),
           remote_digest=COALESCE(excluded.remote_digest,remote_digest),
           conflicts_count=conflicts_count+excluded.conflicts_count,updated_at=excluded.updated_at`,
      )
      .run(
        agencyId,
        input.peerNodeId ?? null,
        input.lastSyncAt ?? null,
        input.lastPushAt ?? null,
        input.lastPullAt ?? null,
        input.status,
        input.error ?? null,
        input.localDigest ?? null,
        input.remoteDigest ?? null,
        input.conflicts ?? 0,
        now,
      );
  }

  listReplicationConflicts(agencyId: string, limit = 100): Row[] {
    this.requireAgency(agencyId);
    return this.db
      .prepare(
        `SELECT * FROM agency_replication_conflicts
         WHERE agency_id=? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agencyId, Math.max(1, Math.min(500, Math.trunc(limit)))) as Row[];
  }

  // ── External provider linkage (agency.db is the source of truth) ─────────

  /**
   * Bind a provider database to one agency entity type. Idempotent: rebinding
   * to the same database with the same direction writes nothing, so a UI that
   * re-issues connect on every page load cannot churn the replication digest.
   */
  upsertExternalBinding(
    input: {
      agencyId: string;
      provider: string;
      entityType: ExternalEntityType;
      externalDatabaseId: string;
      externalDatabaseName?: string | null;
      schema?: Record<string, unknown> | null;
      syncDirection?: ExternalSyncDirection;
    },
    actorId?: string,
  ): { binding: ExternalProviderBinding; changed: boolean } {
    this.requireAgency(input.agencyId);
    const provider = required(input.provider, "provider");
    const entityType = requireExternalEntityType(input.entityType);
    const externalDatabaseId = required(input.externalDatabaseId, "externalDatabaseId");
    const syncDirection = requireExternalSyncDirection(input.syncDirection ?? "bidirectional");
    const externalDatabaseName = input.externalDatabaseName?.trim() || null;
    const schemaJson = input.schema == null ? null : JSON.stringify(input.schema);
    const before = this.getExternalBinding(input.agencyId, provider, entityType);
    if (
      before &&
      before.externalDatabaseId === externalDatabaseId &&
      before.externalDatabaseName === externalDatabaseName &&
      before.syncDirection === syncDirection &&
      JSON.stringify(before.schema ?? null) === JSON.stringify(input.schema ?? null)
    ) {
      return { binding: before, changed: false };
    }
    const now = Date.now();
    this.db.transaction(() => {
      // Repointing an entity type at a different provider database orphans
      // every link that referenced the old one. Dropping them here is what
      // stops the next pull from resurrecting records that no longer exist.
      if (before && before.externalDatabaseId !== externalDatabaseId) {
        this.db
          .prepare(
            `DELETE FROM external_entity_links
             WHERE agency_id=? AND provider=? AND entity_type=?`,
          )
          .run(input.agencyId, provider, entityType);
      }
      this.db
        .prepare(
          `INSERT INTO external_provider_bindings
           (agency_id,provider,entity_type,external_database_id,external_database_name,
            schema_json,sync_direction,last_pull_at,last_push_at,last_error,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)
           ON CONFLICT(agency_id,provider,entity_type) DO UPDATE SET
             external_database_id=excluded.external_database_id,
             external_database_name=excluded.external_database_name,
             schema_json=excluded.schema_json,
             sync_direction=excluded.sync_direction,
             last_pull_at=CASE
               WHEN external_provider_bindings.external_database_id=excluded.external_database_id
               THEN external_provider_bindings.last_pull_at ELSE NULL END,
             last_push_at=CASE
               WHEN external_provider_bindings.external_database_id=excluded.external_database_id
               THEN external_provider_bindings.last_push_at ELSE NULL END,
             last_error=NULL,
             updated_at=excluded.updated_at`,
        )
        .run(
          input.agencyId,
          provider,
          entityType,
          externalDatabaseId,
          externalDatabaseName,
          schemaJson,
          syncDirection,
          now,
          now,
        );
      this.audit(
        "external_binding",
        `${provider}:${entityType}`,
        before ? "updated" : "connected",
        before ? { externalDatabaseId: before.externalDatabaseId } : null,
        { externalDatabaseId, externalDatabaseName, syncDirection },
        { agencyId: input.agencyId, actorId },
      );
    })();
    return {
      binding: this.getExternalBinding(input.agencyId, provider, entityType)!,
      changed: true,
    };
  }

  getExternalBinding(
    agencyId: string,
    provider: string,
    entityType: ExternalEntityType,
  ): ExternalProviderBinding | null {
    const row = this.db
      .prepare(
        `SELECT * FROM external_provider_bindings
         WHERE agency_id=? AND provider=? AND entity_type=?`,
      )
      .get(agencyId, provider, entityType) as Row | undefined;
    return row ? externalBindingFromRow(row) : null;
  }

  listExternalBindings(agencyId: string, provider?: string): ExternalProviderBinding[] {
    const rows = provider
      ? this.db
          .prepare(
            "SELECT * FROM external_provider_bindings WHERE agency_id=? AND provider=? ORDER BY entity_type",
          )
          .all(agencyId, provider)
      : this.db
          .prepare(
            "SELECT * FROM external_provider_bindings WHERE agency_id=? ORDER BY provider, entity_type",
          )
          .all(agencyId);
    return (rows as Row[]).map(externalBindingFromRow);
  }

  removeExternalBinding(
    agencyId: string,
    provider: string,
    entityType: ExternalEntityType,
    actorId?: string,
  ): { removed: boolean; linksRemoved: number } {
    const before = this.getExternalBinding(agencyId, provider, entityType);
    if (!before) return { removed: false, linksRemoved: 0 };
    let linksRemoved = 0;
    this.db.transaction(() => {
      linksRemoved = this.db
        .prepare(
          "DELETE FROM external_entity_links WHERE agency_id=? AND provider=? AND entity_type=?",
        )
        .run(agencyId, provider, entityType).changes;
      this.db
        .prepare(
          "DELETE FROM external_provider_bindings WHERE agency_id=? AND provider=? AND entity_type=?",
        )
        .run(agencyId, provider, entityType);
      this.audit(
        "external_binding",
        `${provider}:${entityType}`,
        "disconnected",
        { externalDatabaseId: before.externalDatabaseId },
        { linksRemoved },
        { agencyId, actorId },
      );
    })();
    return { removed: true, linksRemoved };
  }

  /** Stamp the outcome of a sync run onto the binding. */
  recordExternalBindingSync(
    agencyId: string,
    provider: string,
    entityType: ExternalEntityType,
    patch: { lastPullAt?: number | null; lastPushAt?: number | null; lastError?: string | null },
  ): ExternalProviderBinding | null {
    const before = this.getExternalBinding(agencyId, provider, entityType);
    if (!before) return null;
    const lastPullAt = patch.lastPullAt ?? before.lastPullAt;
    const lastPushAt = patch.lastPushAt ?? before.lastPushAt;
    const lastError = patch.lastError === undefined ? before.lastError : patch.lastError;
    if (
      lastPullAt === before.lastPullAt &&
      lastPushAt === before.lastPushAt &&
      lastError === before.lastError
    ) {
      return before;
    }
    this.db
      .prepare(
        `UPDATE external_provider_bindings
         SET last_pull_at=?, last_push_at=?, last_error=?, updated_at=?
         WHERE agency_id=? AND provider=? AND entity_type=?`,
      )
      .run(lastPullAt, lastPushAt, lastError, Date.now(), agencyId, provider, entityType);
    return this.getExternalBinding(agencyId, provider, entityType);
  }

  getExternalLink(
    agencyId: string,
    provider: string,
    entityType: ExternalEntityType,
    entityId: string,
  ): ExternalEntityLink | null {
    const row = this.db
      .prepare(
        `SELECT * FROM external_entity_links
         WHERE agency_id=? AND provider=? AND entity_type=? AND entity_id=?`,
      )
      .get(agencyId, provider, entityType, entityId) as Row | undefined;
    return row ? externalLinkFromRow(row) : null;
  }

  findExternalLinkByExternalId(
    agencyId: string,
    provider: string,
    externalId: string,
    entityType?: ExternalEntityType,
  ): ExternalEntityLink | null {
    const row = entityType
      ? (this.db
          .prepare(
            `SELECT * FROM external_entity_links
             WHERE agency_id=? AND provider=? AND external_id=? AND entity_type=?
             ORDER BY created_at LIMIT 1`,
          )
          .get(agencyId, provider, externalId, entityType) as Row | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM external_entity_links
             WHERE agency_id=? AND provider=? AND external_id=? ORDER BY created_at LIMIT 1`,
          )
          .get(agencyId, provider, externalId) as Row | undefined);
    return row ? externalLinkFromRow(row) : null;
  }

  listExternalLinks(
    agencyId: string,
    filters: {
      provider?: string;
      entityType?: ExternalEntityType;
      syncState?: ExternalSyncState;
      limit?: number;
    } = {},
  ): ExternalEntityLink[] {
    const where = ["agency_id=?"];
    const params: unknown[] = [agencyId];
    if (filters.provider) {
      where.push("provider=?");
      params.push(filters.provider);
    }
    if (filters.entityType) {
      where.push("entity_type=?");
      params.push(filters.entityType);
    }
    if (filters.syncState) {
      where.push("sync_state=?");
      params.push(filters.syncState);
    }
    params.push(Math.max(1, Math.min(2_000, Math.trunc(filters.limit ?? 500))));
    return (
      this.db
        .prepare(
          `SELECT * FROM external_entity_links WHERE ${where.join(" AND ")}
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map(externalLinkFromRow);
  }

  /**
   * Record the result of syncing one entity.
   *
   * The contract that keeps this database small: if the row already says
   * exactly this, **nothing is written** — no UPDATE, no audit event, not even
   * a `last_synced_at` bump. A re-run over unchanged data therefore leaves the
   * file byte-identical and the replication digest stable. This is the same
   * discipline `importLegacyClient` uses, applied to provider mirroring; the
   * alternative is what once grew this database to 633 MB.
   */
  recordExternalLink(
    input: {
      agencyId: string;
      provider: string;
      entityType: ExternalEntityType;
      entityId: string;
      externalId: string;
      externalDatabaseId?: string | null;
      externalUrl?: string | null;
      localHash: string;
      remoteHash: string;
      syncDirection?: ExternalSyncDirection;
      syncState?: ExternalSyncState;
      lastSyncedAt?: number;
      lastError?: string | null;
    },
    actorId?: string,
  ): { link: ExternalEntityLink; changed: boolean } {
    this.requireAgency(input.agencyId);
    const provider = required(input.provider, "provider");
    const entityType = requireExternalEntityType(input.entityType);
    const entityId = required(input.entityId, "entityId");
    const externalId = required(input.externalId, "externalId");
    const localHash = required(input.localHash, "localHash");
    const remoteHash = required(input.remoteHash, "remoteHash");
    const syncDirection = requireExternalSyncDirection(input.syncDirection ?? "bidirectional");
    const syncState = requireExternalSyncState(input.syncState ?? "in_sync");
    const externalDatabaseId = input.externalDatabaseId?.trim() || null;
    const externalUrl = input.externalUrl?.trim() || null;
    const lastError = input.lastError?.trim() || null;
    const existing = this.getExternalLink(input.agencyId, provider, entityType, entityId);
    if (
      existing &&
      existing.externalId === externalId &&
      existing.externalDatabaseId === externalDatabaseId &&
      existing.externalUrl === externalUrl &&
      existing.localHash === localHash &&
      existing.remoteHash === remoteHash &&
      existing.syncDirection === syncDirection &&
      existing.syncState === syncState &&
      existing.lastError === lastError
    ) {
      return { link: existing, changed: false };
    }
    const now = input.lastSyncedAt ?? Date.now();
    const id = externalLinkId(input.agencyId, provider, entityType, entityId);
    this.db
      .prepare(
        `INSERT INTO external_entity_links
         (id,agency_id,provider,entity_type,entity_id,external_database_id,external_id,
          external_url,local_hash,remote_hash,sync_direction,sync_state,last_synced_at,
          last_error,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           external_database_id=excluded.external_database_id,
           external_id=excluded.external_id,
           external_url=excluded.external_url,
           local_hash=excluded.local_hash,
           remote_hash=excluded.remote_hash,
           sync_direction=excluded.sync_direction,
           sync_state=excluded.sync_state,
           last_synced_at=excluded.last_synced_at,
           last_error=excluded.last_error,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.agencyId,
        provider,
        entityType,
        entityId,
        externalDatabaseId,
        externalId,
        externalUrl,
        localHash,
        remoteHash,
        syncDirection,
        syncState,
        now,
        lastError,
        existing?.createdAt ?? now,
        now,
      );
    // Only the first bind is audited. Routine hash refreshes are already
    // recorded on the link row itself, and one audit row per entity per run is
    // exactly the pattern that bloated this database before.
    if (!existing) {
      this.audit(
        "external_link",
        `${provider}:${entityType}:${entityId}`,
        "linked",
        null,
        { externalId, externalDatabaseId },
        { agencyId: input.agencyId, actorId },
      );
    }
    return {
      link: this.getExternalLink(input.agencyId, provider, entityType, entityId)!,
      changed: true,
    };
  }

  deleteExternalLink(
    agencyId: string,
    provider: string,
    entityType: ExternalEntityType,
    entityId: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM external_entity_links
           WHERE agency_id=? AND provider=? AND entity_type=? AND entity_id=?`,
        )
        .run(agencyId, provider, entityType, entityId).changes > 0
    );
  }

  /** The current canonical row for an entity type, or null if it is gone. */
  getSyncableEntity(
    agencyId: string,
    entityType: ExternalEntityType,
    entityId: string,
  ): Record<string, unknown> | null {
    switch (entityType) {
      case "client":
        return this.getClient(entityId, agencyId) as Record<string, unknown> | null;
      case "project":
        return this.getProject(agencyId, entityId) as Record<string, unknown> | null;
      case "task":
        return this.getTask(agencyId, entityId) as Record<string, unknown> | null;
      case "invoice":
        return this.getInvoice(entityId, agencyId) as Record<string, unknown> | null;
    }
  }

  listSyncableEntities(
    agencyId: string,
    entityType: ExternalEntityType,
  ): Array<Record<string, unknown>> {
    switch (entityType) {
      case "client":
        return this.listClients(agencyId) as unknown as Array<Record<string, unknown>>;
      case "project":
        return this.listProjects(agencyId) as unknown as Array<Record<string, unknown>>;
      case "task":
        return this.listTasks(agencyId) as unknown as Array<Record<string, unknown>>;
      case "invoice":
        return this.listInvoices(agencyId) as unknown as Array<Record<string, unknown>>;
    }
  }

  /**
   * Answer "did local, remote, or both move since the last sync?" for one
   * entity. `remoteHash` may be omitted when the provider was not consulted.
   */
  evaluateExternalDrift(
    agencyId: string,
    provider: string,
    entityType: ExternalEntityType,
    entityId: string,
    observed?: { localHash?: string; remoteHash?: string | null },
  ): ExternalDriftVerdict {
    const link = this.getExternalLink(agencyId, provider, entityType, entityId);
    const entity = this.getSyncableEntity(agencyId, entityType, entityId);
    const localHash =
      observed?.localHash ?? (entity ? hashAgencyEntity(entityType, entity) : "missing");
    const verdict = classifyDrift(link, { localHash, remoteHash: observed?.remoteHash });
    return { entityType, entityId, linked: Boolean(link), ...verdict, link };
  }

  /**
   * Per-entity-type mirror health: how many rows are linked, how many are
   * unlinked, and how many links are currently out of step. Local drift is
   * recomputed from live rows so an edit made through any other RPC shows up
   * without needing a sync run first.
   */
  externalSyncStatus(
    agencyId: string,
    provider: string,
  ): Array<{
    entityType: ExternalEntityType;
    binding: ExternalProviderBinding | null;
    connected: boolean;
    localTotal: number;
    linked: number;
    unlinked: number;
    localAhead: number;
    remoteAhead: number;
    conflicts: number;
    errored: number;
    driftDetected: boolean;
    lastSyncAt: number | null;
  }> {
    this.requireAgency(agencyId);
    return EXTERNAL_ENTITY_TYPES.map((entityType) => {
      const binding = this.getExternalBinding(agencyId, provider, entityType);
      const links = this.listExternalLinks(agencyId, { provider, entityType, limit: 2_000 });
      const byEntity = new Map(links.map((link) => [link.entityId, link]));
      const entities = this.listSyncableEntities(agencyId, entityType);
      let localAhead = 0;
      let linked = 0;
      for (const entity of entities) {
        const link = byEntity.get(String(entity.id));
        if (!link) continue;
        linked += 1;
        if (hashAgencyEntity(entityType, entity) !== link.localHash) localAhead += 1;
      }
      const remoteAhead = links.filter((link) => link.syncState === "remote_ahead").length;
      const conflicts = links.filter((link) => link.syncState === "conflict").length;
      const errored = links.filter((link) => link.syncState === "error").length;
      const lastSyncAt = links.reduce<number | null>(
        (latest, link) =>
          link.lastSyncedAt != null && (latest == null || link.lastSyncedAt > latest)
            ? link.lastSyncedAt
            : latest,
        null,
      );
      return {
        entityType,
        binding,
        connected: Boolean(binding),
        localTotal: entities.length,
        linked,
        unlinked: entities.length - linked,
        localAhead,
        remoteAhead,
        conflicts,
        errored,
        driftDetected: localAhead + remoteAhead + conflicts + errored > 0,
        lastSyncAt,
      };
    });
  }

  // ── Relation navigation ──────────────────────────────────────────────────

  /**
   * Everything hanging off one client. The audit found no way to walk from a
   * client to its projects; this is that walk, plus the tasks reached through
   * those projects and the invoices billed against them.
   */
  getClientRelations(
    agencyId: string,
    clientId: string,
  ): {
    client: Client;
    contacts: Contact[];
    projects: AgencyProject[];
    tasks: AgencyTask[];
    engagements: Engagement[];
    invoices: Invoice[];
    totals: {
      projects: number;
      openProjects: number;
      tasks: number;
      openTasks: number;
      invoices: number;
      invoicedCents: number;
      outstandingCents: number;
    };
  } {
    this.requireAgency(agencyId);
    const client = this.getClient(clientId, agencyId);
    if (!client) throw new Error("client not found");
    const projects = (
      this.db
        .prepare(
          "SELECT * FROM agency_projects WHERE agency_id=? AND client_id=? ORDER BY updated_at DESC",
        )
        .all(agencyId, clientId) as Row[]
    ).map(camel) as AgencyProject[];
    const tasks = projects.length
      ? ((
          this.db
            .prepare(
              `SELECT * FROM agency_tasks WHERE agency_id=? AND project_id IN (${projects
                .map(() => "?")
                .join(",")}) ORDER BY due_at IS NULL, due_at, created_at`,
            )
            .all(agencyId, ...projects.map((project) => project.id)) as Row[]
        ).map(camel) as AgencyTask[])
      : [];
    const contacts = (
      this.db
        .prepare(
          "SELECT * FROM contacts WHERE agency_id=? AND client_id=? ORDER BY is_primary DESC, created_at",
        )
        .all(agencyId, clientId) as Row[]
    ).map((row) => ({ ...camel(row), isPrimary: Boolean(row.is_primary) })) as Contact[];
    const engagements = (
      this.db
        .prepare(
          "SELECT * FROM engagements WHERE agency_id=? AND client_id=? ORDER BY updated_at DESC",
        )
        .all(agencyId, clientId) as Row[]
    ).map(camel) as Engagement[];
    const invoices = (
      this.db
        .prepare(
          `SELECT *, total_cents - amount_paid_cents AS balance_cents FROM invoices
           WHERE agency_id=? AND client_id=? ORDER BY created_at DESC`,
        )
        .all(agencyId, clientId) as Row[]
    ).map(camel) as Invoice[];
    return {
      client,
      contacts,
      projects,
      tasks,
      engagements,
      invoices,
      totals: {
        projects: projects.length,
        openProjects: projects.filter((project) =>
          ["planned", "active", "on_hold"].includes(project.status),
        ).length,
        tasks: tasks.length,
        openTasks: tasks.filter((task) => !["done", "cancelled"].includes(task.status)).length,
        invoices: invoices.length,
        invoicedCents: invoices.reduce((sum, invoice) => sum + invoice.totalCents, 0),
        outstandingCents: invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0),
      },
    };
  }

  /** Reverse traversal: which client does this project belong to? */
  getProjectRelations(
    agencyId: string,
    projectId: string,
  ): { project: AgencyProject; client: Client | null; tasks: AgencyTask[]; invoices: Invoice[] } {
    const project = this.getProject(agencyId, projectId);
    if (!project) throw new Error("project not found");
    const invoices = (
      this.db
        .prepare(
          `SELECT i.*, i.total_cents - i.amount_paid_cents AS balance_cents FROM invoices i
           JOIN invoice_project_links l ON l.invoice_id=i.id AND l.agency_id=i.agency_id
           WHERE i.agency_id=? AND l.project_id=? ORDER BY i.created_at DESC`,
        )
        .all(agencyId, projectId) as Row[]
    ).map(camel) as Invoice[];
    return {
      project,
      client: project.clientId ? this.getClient(project.clientId, agencyId) : null,
      tasks: this.listTasks(agencyId, { projectId }),
      invoices,
    };
  }

  /**
   * Referential-integrity report over the client → project → task → invoice
   * chain. Every one of these columns has a declared foreign key, but the FKs
   * are unscoped (`REFERENCES clients(id)`, not `(agency_id, id)`), so a row
   * pointing at another tenant's parent satisfies SQLite and still corrupts
   * every agency-scoped read. This finds those, plus links whose entity has
   * been deleted underneath them.
   */
  checkRelationIntegrity(agencyId: string): {
    agencyId: string;
    ok: boolean;
    orphanProjects: string[];
    crossAgencyProjects: string[];
    orphanTasks: string[];
    orphanInvoices: string[];
    crossAgencyInvoices: string[];
    danglingExternalLinks: string[];
    foreignKeyViolations: number;
  } {
    this.requireAgency(agencyId);
    const ids = (sql: string, ...params: unknown[]) =>
      (this.db
        .prepare(sql)
        .pluck()
        .all(...params) as string[]) ?? [];
    const orphanProjects = ids(
      `SELECT p.id FROM agency_projects p WHERE p.agency_id=? AND p.client_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=p.client_id)`,
      agencyId,
    );
    const crossAgencyProjects = ids(
      `SELECT p.id FROM agency_projects p JOIN clients c ON c.id=p.client_id
       WHERE p.agency_id=? AND c.agency_id<>p.agency_id`,
      agencyId,
    );
    const orphanTasks = ids(
      `SELECT t.id FROM agency_tasks t WHERE t.agency_id=?
       AND NOT EXISTS (SELECT 1 FROM agency_projects p
                       WHERE p.id=t.project_id AND p.agency_id=t.agency_id)`,
      agencyId,
    );
    const orphanInvoices = ids(
      `SELECT i.id FROM invoices i WHERE i.agency_id=?
       AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=i.client_id)`,
      agencyId,
    );
    const crossAgencyInvoices = ids(
      `SELECT i.id FROM invoices i JOIN clients c ON c.id=i.client_id
       WHERE i.agency_id=? AND c.agency_id<>i.agency_id`,
      agencyId,
    );
    const danglingExternalLinks = ids(
      `SELECT l.id FROM external_entity_links l WHERE l.agency_id=? AND (
         (l.entity_type='client'  AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id=l.entity_id AND c.agency_id=l.agency_id)) OR
         (l.entity_type='project' AND NOT EXISTS (SELECT 1 FROM agency_projects p WHERE p.id=l.entity_id AND p.agency_id=l.agency_id)) OR
         (l.entity_type='task'    AND NOT EXISTS (SELECT 1 FROM agency_tasks t WHERE t.id=l.entity_id AND t.agency_id=l.agency_id)) OR
         (l.entity_type='invoice' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id=l.entity_id AND i.agency_id=l.agency_id))
       )`,
      agencyId,
    );
    const foreignKeyViolations = (this.db.pragma("foreign_key_check") as unknown[]).length;
    return {
      agencyId,
      ok:
        orphanProjects.length === 0 &&
        crossAgencyProjects.length === 0 &&
        orphanTasks.length === 0 &&
        orphanInvoices.length === 0 &&
        crossAgencyInvoices.length === 0 &&
        danglingExternalLinks.length === 0 &&
        foreignKeyViolations === 0,
      orphanProjects,
      crossAgencyProjects,
      orphanTasks,
      orphanInvoices,
      crossAgencyInvoices,
      danglingExternalLinks,
      foreignKeyViolations,
    };
  }

  /** Repoint a project at a client, enforcing that both live in this agency. */
  setProjectClient(
    agencyId: string,
    projectId: string,
    clientId: string | null,
    actorId?: string,
  ): AgencyProject {
    const before = this.getProject(agencyId, projectId);
    if (!before) throw new Error("project not found");
    if (clientId && !this.getClient(clientId, agencyId)) throw new Error("client not found");
    if (before.clientId === clientId) return before;
    const updatedAt = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE agency_projects SET client_id=?, updated_at=? WHERE agency_id=? AND id=?")
        .run(clientId, updatedAt, agencyId, projectId);
      this.audit(
        "agency_project",
        projectId,
        "client_linked",
        { clientId: before.clientId },
        { clientId },
        { agencyId, actorId },
      );
    })();
    return this.getProject(agencyId, projectId)!;
  }

  private recordTombstone(
    agencyId: string,
    entityTable: string,
    rowKey: Record<string, unknown>,
    deletedAt: number,
    sourceNodeId = "local",
  ): void {
    this.db
      .prepare(
        `INSERT INTO agency_tombstones
         (agency_id,entity_table,row_key,deleted_at,source_node_id)
         VALUES (?,?,?,?,?)
         ON CONFLICT(agency_id,entity_table,row_key) DO UPDATE SET
           deleted_at=MAX(deleted_at,excluded.deleted_at),
           source_node_id=CASE
             WHEN excluded.deleted_at>=deleted_at THEN excluded.source_node_id
             ELSE source_node_id
           END`,
      )
      .run(agencyId, entityTable, JSON.stringify(rowKey), deletedAt, sourceNodeId);
  }

  private transitionSimple(
    kind:
      | "proposal"
      | "engagement"
      | "deliverable"
      | "changeRequest"
      | "invoice"
      | "project"
      | "task",
    table: string,
    id: string,
    status: string,
    options: ActorOptions | undefined,
    getter: () => any,
  ): any {
    const before = getter();
    if (!before) throw new Error(`${kind} not found`);
    transition(kind, before.status, status);
    const agencyId = options?.agencyId ?? DEFAULT_AGENCY_ID;
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE ${table} SET status=?, updated_at=? WHERE id=? AND agency_id=?`)
        .run(status, Date.now(), id, agencyId);
      this.audit(
        kind === "changeRequest" ? "change_request" : kind,
        id,
        "status_changed",
        before,
        { status },
        options,
      );
    })();
    return getter();
  }

  private requireAgency(agencyId: string): Agency {
    const agency = this.getAgency(required(agencyId, "agencyId"));
    if (!agency) throw new Error("agency not found");
    return agency;
  }

  private requireAgencyRole(
    agencyId: string,
    userId: string,
    roles: AgencyRole[],
  ): AgencyMembership {
    this.requireAgency(agencyId);
    const row = this.db
      .prepare("SELECT * FROM agency_memberships WHERE agency_id=? AND user_id=?")
      .get(agencyId, userId) as Row | undefined;
    if (!row) throw new Error("agency membership required");
    const membership = camel(row) as AgencyMembership;
    if (!roles.includes(membership.role)) throw new Error("insufficient agency role");
    return membership;
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(required(token, "token")).digest("hex");
  }
}

const sharedStores = new Map<string, AgencyOperationsStore>();

/**
 * Returns the process-wide canonical agency store. Pass a state directory by
 * default; set `isDatabasePath` only when bootstrapping/tests supply a full path.
 */
export function getAgencyOperationsStore(
  stateDirOrDbPath: string,
  options?: { isDatabasePath?: boolean },
): AgencyOperationsStore {
  const databasePath = options?.isDatabasePath
    ? stateDirOrDbPath
    : join(stateDirOrDbPath, "agency-operations", "agency.db");
  const existing = sharedStores.get(databasePath);
  if (existing) return existing;
  const store = new AgencyOperationsStore(databasePath);
  sharedStores.set(databasePath, store);
  return store;
}

export function resetAgencyOperationsStores(): void {
  for (const store of sharedStores.values()) store.close();
  sharedStores.clear();
}
