/**
 * People / Resources store — SQLite-backed (K.I.S. Object 9).
 *
 * Modeled on `src/issues/store.ts`: local SQLite is the source of truth, opened
 * under the resolved `~/.infinibot` state dir in its own file `person.db`. Every
 * caller — the gateway `person.*` RPC handlers, the MCP tool, and the UI — goes
 * through this single store so the contract stays consistent.
 *
 * Cross-object connections (Projects / Tasks / Decisions / Risks / System Issues)
 * are NOT columns here — they live in the typed-edge relations store
 * (`src/relations`). `workloadFor()` derives the person's current capacity from
 * those edges rather than storing a snapshot.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { getRelationsStore } from "../relations/store.js";
import type { ObjectRelation } from "../relations/types.js";
import type {
  Person,
  PersonCreateParams,
  PersonSearchParams,
  PersonUpdateParams,
  PersonWorkload,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getPersonStore(stateDir?: string): PersonStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new PersonStore(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS person (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL DEFAULT '',
  relationship_type     TEXT NOT NULL DEFAULT '',
  role                  TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'Active',
  capabilities          TEXT NOT NULL DEFAULT '[]',
  availability          TEXT NOT NULL DEFAULT '',
  cost_rate             TEXT NOT NULL DEFAULT '',
  access_level          TEXT NOT NULL DEFAULT 'Standard',
  email                 TEXT NOT NULL DEFAULT '',
  phone                 TEXT NOT NULL DEFAULT '',
  contact_info          TEXT NOT NULL DEFAULT '',
  -- standardized common fields (§25)
  owner                 TEXT NOT NULL DEFAULT '',
  supporting_owner      TEXT NOT NULL DEFAULT '',
  ceo_required          INTEGER NOT NULL DEFAULT 0,
  priority              TEXT NOT NULL DEFAULT 'P2',
  next_action           TEXT NOT NULL DEFAULT '',
  next_action_owner     TEXT NOT NULL DEFAULT '',
  next_action_date      TEXT NOT NULL DEFAULT '',
  client_id             TEXT NOT NULL DEFAULT '',
  opportunity_id        TEXT NOT NULL DEFAULT '',
  project_id            TEXT NOT NULL DEFAULT '',
  product_id            TEXT NOT NULL DEFAULT '',
  risk_level            TEXT NOT NULL DEFAULT '',
  financial_value       REAL NOT NULL DEFAULT 0,
  blocked               INTEGER NOT NULL DEFAULT 0,
  blocker               TEXT NOT NULL DEFAULT '',
  escalation_required   INTEGER NOT NULL DEFAULT 0,
  data_quality          TEXT NOT NULL DEFAULT 'Unknown',
  authority_level       TEXT NOT NULL DEFAULT 'L0',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_status ON person(status);
CREATE INDEX IF NOT EXISTS idx_person_rel_type ON person(relationship_type);
CREATE INDEX IF NOT EXISTS idx_person_owner ON person(owner);
CREATE INDEX IF NOT EXISTS idx_person_updated ON person(updated_at);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "person.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface PersonRow {
  id: string;
  name: string;
  relationship_type: string;
  role: string;
  status: string;
  capabilities: string;
  availability: string;
  cost_rate: string;
  access_level: string;
  email: string;
  phone: string;
  contact_info: string;
  owner: string;
  supporting_owner: string;
  ceo_required: number;
  priority: string;
  next_action: string;
  next_action_owner: string;
  next_action_date: string;
  client_id: string;
  opportunity_id: string;
  project_id: string;
  product_id: string;
  risk_level: string;
  financial_value: number;
  blocked: number;
  blocker: string;
  escalation_required: number;
  data_quality: string;
  authority_level: string;
  created_at: number;
  updated_at: number;
}

function parseCapabilities(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

function rowToPerson(r: PersonRow): Person {
  return {
    id: r.id,
    name: r.name,
    relationshipType: r.relationship_type,
    role: r.role,
    status: r.status,
    capabilities: parseCapabilities(r.capabilities),
    availability: r.availability,
    costRate: r.cost_rate,
    accessLevel: r.access_level,
    email: r.email,
    phone: r.phone,
    contactInfo: r.contact_info,
    owner: r.owner,
    supportingOwner: r.supporting_owner,
    ceoRequired: r.ceo_required === 1,
    priority: r.priority,
    nextAction: r.next_action,
    nextActionOwner: r.next_action_owner,
    nextActionDate: r.next_action_date,
    clientId: r.client_id,
    opportunityId: r.opportunity_id,
    projectId: r.project_id,
    productId: r.product_id,
    riskLevel: r.risk_level,
    financialValue: r.financial_value,
    blocked: r.blocked === 1,
    blocker: r.blocker,
    escalationRequired: r.escalation_required === 1,
    dataQuality: r.data_quality,
    authorityLevel: r.authority_level,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Terminal task statuses that don't count toward active workload. */
const TERMINAL_TASK_STATUSES = new Set([
  "done",
  "completed",
  "complete",
  "cancelled",
  "canceled",
  "archived",
]);

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class PersonStore {
  constructor(private db: Database.Database) {}

  list(params: PersonSearchParams = {}): Person[] {
    const rows = this.db
      .prepare(`SELECT * FROM person ORDER BY updated_at DESC`)
      .all() as PersonRow[];
    let people = rows.map(rowToPerson);

    if (params.query) {
      const q = params.query.toLowerCase();
      people = people.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.role.toLowerCase().includes(q) ||
          p.capabilities.some((c) => c.toLowerCase().includes(q)) ||
          p.email.toLowerCase().includes(q),
      );
    }
    if (params.relationshipType)
      people = people.filter((p) => p.relationshipType === params.relationshipType);
    if (params.status) people = people.filter((p) => p.status === params.status);
    if (params.accessLevel) people = people.filter((p) => p.accessLevel === params.accessLevel);
    if (params.owner) people = people.filter((p) => p.owner === params.owner);
    if (params.since != null) people = people.filter((p) => p.updatedAt > params.since!);
    if (params.limit) people = people.slice(0, params.limit);
    return people;
  }

  get(id: string): Person | null {
    const row = this.db.prepare(`SELECT * FROM person WHERE id = ?`).get(id) as
      | PersonRow
      | undefined;
    return row ? rowToPerson(row) : null;
  }

  /** Find an existing person by (case-insensitive) name — supports §4 dedup. */
  findByName(name: string): Person | null {
    const row = this.db
      .prepare(`SELECT * FROM person WHERE lower(name) = lower(?) LIMIT 1`)
      .get(String(name).trim()) as PersonRow | undefined;
    return row ? rowToPerson(row) : null;
  }

  create(params: PersonCreateParams): Person {
    const now = Date.now();
    const id = params.clientRequestId?.trim() || randomUUID();
    // Idempotency (§4 create once): a repeat create with the same id returns it.
    const existing = this.get(id);
    if (existing) return existing;

    const person: Person = {
      id,
      name: params.name ?? "",
      relationshipType: params.relationshipType ?? "Employee",
      role: params.role ?? "",
      status: params.status ?? "Active",
      capabilities: Array.isArray(params.capabilities) ? params.capabilities.map(String) : [],
      availability: params.availability ?? "",
      costRate: params.costRate ?? "",
      accessLevel: params.accessLevel ?? "Standard",
      email: params.email ?? "",
      phone: params.phone ?? "",
      contactInfo: params.contactInfo ?? "",
      owner: params.owner ?? "",
      supportingOwner: params.supportingOwner ?? "",
      ceoRequired: params.ceoRequired ?? false,
      priority: params.priority ?? "P2",
      nextAction: params.nextAction ?? "",
      nextActionOwner: params.nextActionOwner ?? "",
      nextActionDate: params.nextActionDate ?? "",
      clientId: params.clientId ?? "",
      opportunityId: params.opportunityId ?? "",
      projectId: params.projectId ?? "",
      productId: params.productId ?? "",
      riskLevel: params.riskLevel ?? "",
      financialValue: params.financialValue ?? 0,
      blocked: params.blocked ?? false,
      blocker: params.blocker ?? "",
      escalationRequired: params.escalationRequired ?? false,
      dataQuality: params.dataQuality ?? "Unknown",
      authorityLevel: params.authorityLevel ?? "L0",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO person (
          id, name, relationship_type, role, status, capabilities, availability,
          cost_rate, access_level, email, phone, contact_info,
          owner, supporting_owner, ceo_required, priority,
          next_action, next_action_owner, next_action_date,
          client_id, opportunity_id, project_id, product_id,
          risk_level, financial_value, blocked, blocker, escalation_required,
          data_quality, authority_level, created_at, updated_at
        ) VALUES (
          @id, @name, @relationshipType, @role, @status, @capabilities, @availability,
          @costRate, @accessLevel, @email, @phone, @contactInfo,
          @owner, @supportingOwner, @ceoRequired, @priority,
          @nextAction, @nextActionOwner, @nextActionDate,
          @clientId, @opportunityId, @projectId, @productId,
          @riskLevel, @financialValue, @blocked, @blocker, @escalationRequired,
          @dataQuality, @authorityLevel, @createdAt, @updatedAt
        )`,
      )
      .run(this.bind(person));
    return person;
  }

  update(params: PersonUpdateParams): Person | null {
    const current = this.get(params.id);
    if (!current) return null;
    const patch = stripUndefined(params);
    const next: Person = {
      ...current,
      ...patch,
      id: current.id,
      // capabilities must stay an array even if omitted
      capabilities: Array.isArray(patch.capabilities)
        ? patch.capabilities.map(String)
        : current.capabilities,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE person SET
          name=@name, relationship_type=@relationshipType, role=@role, status=@status,
          capabilities=@capabilities, availability=@availability, cost_rate=@costRate,
          access_level=@accessLevel, email=@email, phone=@phone, contact_info=@contactInfo,
          owner=@owner, supporting_owner=@supportingOwner, ceo_required=@ceoRequired,
          priority=@priority, next_action=@nextAction, next_action_owner=@nextActionOwner,
          next_action_date=@nextActionDate, client_id=@clientId, opportunity_id=@opportunityId,
          project_id=@projectId, product_id=@productId, risk_level=@riskLevel,
          financial_value=@financialValue, blocked=@blocked, blocker=@blocker,
          escalation_required=@escalationRequired, data_quality=@dataQuality,
          authority_level=@authorityLevel, updated_at=@updatedAt
        WHERE id=@id`,
      )
      .run(this.bind(next));
    return next;
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM person WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // RELATIONS-DERIVED CAPACITY (never stored on the record)
  // ═══════════════════════════════════════════════════════════════

  /** All typed edges pointing at this person (e.g. task_assigned_to_person). */
  incomingLinks(personId: string): ObjectRelation[] {
    return getRelationsStore().linksTo("person", personId);
  }

  /**
   * Derive the person's current workload from the relations layer (spec Object 9
   * — workload is DERIVED, not stored). Counts links by object type and the
   * active-task subset. A task edge is "active" unless its `meta.status` is a
   * terminal status; tasks with no status metadata count as active.
   */
  workloadFor(personId: string): PersonWorkload {
    const links = this.incomingLinks(personId);
    let taskCount = 0;
    let activeTaskCount = 0;
    let projectCount = 0;
    let decisionCount = 0;
    let riskCount = 0;
    let issueCount = 0;

    for (const l of links) {
      switch (l.fromType) {
        case "task": {
          taskCount++;
          const status = String((l.meta?.status as string) ?? "").toLowerCase();
          if (!status || !TERMINAL_TASK_STATUSES.has(status)) activeTaskCount++;
          break;
        }
        case "project":
          projectCount++;
          break;
        case "decision":
          decisionCount++;
          break;
        case "risk":
          riskCount++;
          break;
        case "issue":
          issueCount++;
          break;
        default:
          break;
      }
    }

    return {
      personId,
      taskCount,
      activeTaskCount,
      projectCount,
      decisionCount,
      riskCount,
      issueCount,
      totalLinks: links.length,
    };
  }

  /**
   * Convenience wrapper: create the `task_assigned_to_person` edge (task→person)
   * in the typed-edge store. Idempotent on (task, edge, person). Optional
   * `status` is stored on the edge meta so `workloadFor` can classify it.
   */
  assignTask(
    personId: string,
    taskId: string,
    opts: { createdBy?: string; status?: string } = {},
  ): ObjectRelation {
    return getRelationsStore().create({
      fromType: "task",
      fromId: taskId,
      edge: "task_assigned_to_person",
      toType: "person",
      toId: personId,
      createdBy: opts.createdBy ?? "person-agent",
      meta: opts.status ? { status: opts.status } : {},
    });
  }

  /** Remove the `task_assigned_to_person` edge between a task and this person. */
  unassignTask(personId: string, taskId: string): number {
    return getRelationsStore().deleteMatch({
      fromType: "task",
      fromId: taskId,
      edge: "task_assigned_to_person",
      toType: "person",
      toId: personId,
    });
  }

  /** Map a Person model onto the flat, SQLite-friendly bind object. */
  private bind(p: Person): Record<string, string | number | null> {
    return {
      id: p.id,
      name: p.name,
      relationshipType: String(p.relationshipType ?? ""),
      role: p.role,
      status: String(p.status ?? ""),
      capabilities: JSON.stringify(p.capabilities ?? []),
      availability: p.availability,
      costRate: p.costRate,
      accessLevel: String(p.accessLevel ?? ""),
      email: p.email,
      phone: p.phone,
      contactInfo: p.contactInfo,
      owner: p.owner ?? "",
      supportingOwner: p.supportingOwner ?? "",
      ceoRequired: p.ceoRequired ? 1 : 0,
      priority: String(p.priority ?? "P2"),
      nextAction: p.nextAction ?? "",
      nextActionOwner: p.nextActionOwner ?? "",
      nextActionDate: p.nextActionDate ?? "",
      clientId: p.clientId ?? "",
      opportunityId: p.opportunityId ?? "",
      projectId: p.projectId ?? "",
      productId: p.productId ?? "",
      riskLevel: p.riskLevel ?? "",
      financialValue: p.financialValue ?? 0,
      blocked: p.blocked ? 1 : 0,
      blocker: p.blocker ?? "",
      escalationRequired: p.escalationRequired ? 1 : 0,
      dataQuality: String(p.dataQuality ?? "Unknown"),
      authorityLevel: String(p.authorityLevel ?? "L0"),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
