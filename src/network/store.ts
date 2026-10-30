/**
 * People Network store — SQLite-backed contacts, connections and change
 * history (`<stateDir>/network.db`).
 *
 * Modeled on `src/opportunity/store.ts`: one per-state-dir handle (SaaS
 * tenants don't share a slot), typed columns plus JSON for list-shaped fields.
 * The store owns the records only; opportunity links live in the typed-edge
 * relations store and client data stays in agency.db (see ./types.ts).
 *
 * Every status / strength / type / next-action change is appended to
 * `network_history` so the UI and the AI can see how a relationship moved.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PRIORITIES } from "../business-objects/common.js";
import type { Priority } from "../business-objects/common.js";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { normalizeWarmOverride } from "./warm.js";
import {
  CHANNEL_KEYS,
  CONNECTION_DIRECTIONS,
  CONNECTION_STATUSES,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  ME_ID,
  RELATIONSHIP_TYPES,
  type Connection,
  type ConnectionCreateParams,
  type ConnectionUpdateParams,
  type ConnectionValue,
  type Contact,
  type ContactChannels,
  type ContactCreateParams,
  type ContactListParams,
  type ContactUpdateParams,
  type NetworkHistoryEntry,
} from "./types.js";

const dbInstances = new Map<string, Database.Database>();

export function getNetworkStore(stateDir?: string): NetworkStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new NetworkStore(db);
}

/** Test helper: close and forget every cached handle. */
export function resetNetworkStoresForTest(): void {
  for (const db of dbInstances.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbInstances.clear();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS network_contacts (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL DEFAULT '',
  org                 TEXT NOT NULL DEFAULT '',
  role                TEXT NOT NULL DEFAULT '',
  contact_type        TEXT NOT NULL DEFAULT 'other',
  tags                TEXT NOT NULL DEFAULT '[]',
  channels            TEXT NOT NULL DEFAULT '{}',
  notes               TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'Active',
  owner               TEXT NOT NULL DEFAULT 'me',
  priority            TEXT NOT NULL DEFAULT 'P2',
  next_action         TEXT NOT NULL DEFAULT '',
  next_action_owner   TEXT NOT NULL DEFAULT '',
  next_action_date    TEXT NOT NULL DEFAULT '',
  last_touch_date     TEXT NOT NULL DEFAULT '',
  client_id           TEXT NOT NULL DEFAULT '',
  hub_contact_id      TEXT NOT NULL DEFAULT '',
  data_quality        TEXT NOT NULL DEFAULT 'Unknown',
  authority_level     TEXT NOT NULL DEFAULT 'L1',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nc_client ON network_contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_nc_updated ON network_contacts(updated_at);

CREATE TABLE IF NOT EXISTS network_connections (
  id                  TEXT PRIMARY KEY,
  from_id             TEXT NOT NULL,
  to_id               TEXT NOT NULL,
  relationship_type   TEXT NOT NULL DEFAULT 'other',
  strength            INTEGER NOT NULL DEFAULT 3,
  direction           TEXT NOT NULL DEFAULT 'mutual',
  value_items         TEXT NOT NULL DEFAULT '[]',
  last_touch_date     TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'Active',
  notes               TEXT NOT NULL DEFAULT '',
  owner               TEXT NOT NULL DEFAULT 'me',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ncx_from ON network_connections(from_id);
CREATE INDEX IF NOT EXISTS idx_ncx_to ON network_connections(to_id);

CREATE TABLE IF NOT EXISTS network_history (
  id          TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  field       TEXT NOT NULL,
  from_value  TEXT NOT NULL DEFAULT '',
  to_value    TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT '',
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nh_object ON network_history(object_type, object_id, at);

CREATE TABLE IF NOT EXISTS network_warm_history (
  contact_id  TEXT NOT NULL,
  score       INTEGER NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nwh_contact ON network_warm_history(contact_id, at);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new Database(resolve(stateDir, "network.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  // Additive migrations for databases created before a column existed.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(network_contacts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("warm_override"))
    db.exec(`ALTER TABLE network_contacts ADD COLUMN warm_override INTEGER`);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// NORMALIZERS
// ═══════════════════════════════════════════════════════════════════

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = String(v ?? "").trim();
  if (!s) return fallback;
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  return hit ?? fallback;
}

/** Free-text enum: snap to a known value case-insensitively, else keep the text. */
function soft(v: unknown, allowed: readonly string[], fallback: string): string {
  const s = String(v ?? "").trim();
  if (!s) return fallback;
  return allowed.find((a) => a.toLowerCase() === s.toLowerCase()) ?? s;
}

function clampPriority(p: unknown): Priority {
  const up = String(p ?? "").toUpperCase();
  return (PRIORITIES as readonly string[]).includes(up) ? (up as Priority) : "P2";
}

export function clampStrength(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

export function normalizeTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out: string[] = [];
  for (const t of list) {
    const s = String(t ?? "").trim();
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, 40);
}

function normalizeChannels(v: unknown): ContactChannels {
  const out: ContactChannels = {};
  if (!v || typeof v !== "object") return out;
  const src = v as Record<string, unknown>;
  for (const k of CHANNEL_KEYS) {
    const s = typeof src[k] === "string" ? (src[k] as string).trim() : "";
    if (s) out[k] = s.slice(0, 300);
  }
  return out;
}

export function normalizeValues(v: unknown): ConnectionValue[] {
  if (!Array.isArray(v)) return [];
  const out: ConnectionValue[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const description = String(r.description ?? "")
      .trim()
      .slice(0, 500);
    const valueType = String(r.valueType ?? "other").trim() || "other";
    const n = Number(r.estimatedValue);
    const item: ConnectionValue = { valueType, description };
    if (Number.isFinite(n) && n > 0) item.estimatedValue = n;
    if (description || item.estimatedValue) out.push(item);
  }
  return out.slice(0, 20);
}

function isoDate(v: unknown): string {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

// ═══════════════════════════════════════════════════════════════════
// ROWS
// ═══════════════════════════════════════════════════════════════════

interface ContactRow {
  id: string;
  name: string;
  org: string;
  role: string;
  contact_type: string;
  tags: string;
  channels: string;
  notes: string;
  status: string;
  owner: string;
  priority: string;
  next_action: string;
  next_action_owner: string;
  next_action_date: string;
  last_touch_date: string;
  client_id: string;
  hub_contact_id: string;
  data_quality: string;
  authority_level: string;
  warm_override: number | null;
  created_at: number;
  updated_at: number;
}

function rowToContact(r: ContactRow): Contact {
  return {
    id: r.id,
    name: r.name,
    org: r.org,
    role: r.role,
    contactType: r.contact_type,
    tags: parseJson<string[]>(r.tags, []),
    channels: parseJson<ContactChannels>(r.channels, {}),
    notes: r.notes,
    status: r.status,
    owner: r.owner,
    priority: r.priority,
    nextAction: r.next_action,
    nextActionOwner: r.next_action_owner,
    nextActionDate: r.next_action_date,
    lastTouchDate: r.last_touch_date,
    clientId: r.client_id,
    hubContactId: r.hub_contact_id,
    dataQuality: r.data_quality,
    authorityLevel: r.authority_level,
    warmOverride: r.warm_override ?? null,
    lastUpdated: r.updated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface ConnectionRow {
  id: string;
  from_id: string;
  to_id: string;
  relationship_type: string;
  strength: number;
  direction: string;
  value_items: string;
  last_touch_date: string;
  status: string;
  notes: string;
  owner: string;
  created_at: number;
  updated_at: number;
}

function rowToConnection(r: ConnectionRow): Connection {
  return {
    id: r.id,
    fromId: r.from_id,
    toId: r.to_id,
    relationshipType: r.relationship_type,
    strength: r.strength,
    direction: r.direction,
    values: parseJson<ConnectionValue[]>(r.value_items, []),
    lastTouchDate: r.last_touch_date,
    status: r.status,
    notes: r.notes,
    owner: r.owner,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Fields whose changes are written to the history ledger. */
const CONTACT_TRACKED = [
  "status",
  "contactType",
  "nextAction",
  "clientId",
  "priority",
  "lastTouchDate",
  "warmOverride",
] as const;
const CONNECTION_TRACKED = [
  "status",
  "strength",
  "relationshipType",
  "direction",
  "lastTouchDate",
] as const;

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class NetworkStore {
  constructor(private db: Database.Database) {}

  // ── Contacts ─────────────────────────────────────────────────────

  listContacts(params: ContactListParams = {}): Contact[] {
    let rows = (
      this.db
        .prepare(`SELECT * FROM network_contacts ORDER BY updated_at DESC`)
        .all() as ContactRow[]
    ).map(rowToContact);
    if (params.query) {
      const q = params.query.toLowerCase();
      rows = rows.filter((c) =>
        [c.name, c.org, c.role, c.notes, c.tags.join(" "), Object.values(c.channels).join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    if (params.contactType) rows = rows.filter((c) => c.contactType === params.contactType);
    if (params.status) rows = rows.filter((c) => c.status === params.status);
    if (params.clientId) rows = rows.filter((c) => c.clientId === params.clientId);
    if (params.tag) {
      const t = params.tag.toLowerCase();
      rows = rows.filter((c) => c.tags.some((x) => x.toLowerCase() === t));
    }
    if (params.limit && params.limit > 0) rows = rows.slice(0, params.limit);
    return rows;
  }

  getContact(id: string): Contact | null {
    const row = this.db.prepare(`SELECT * FROM network_contacts WHERE id = ?`).get(id) as
      | ContactRow
      | undefined;
    return row ? rowToContact(row) : null;
  }

  findContactByClient(clientId: string): Contact | null {
    if (!clientId) return null;
    const row = this.db
      .prepare(`SELECT * FROM network_contacts WHERE client_id = ? ORDER BY created_at LIMIT 1`)
      .get(clientId) as ContactRow | undefined;
    return row ? rowToContact(row) : null;
  }

  createContact(params: ContactCreateParams, actor = "user"): Contact {
    const id = params.clientRequestId?.trim() || `nc_${randomUUID()}`;
    const existing = this.getContact(id);
    if (existing) return existing;
    const name = String(params.name ?? "").trim();
    if (!name && !params.clientId) throw new Error("name is required");
    if (params.clientId) {
      const linked = this.findContactByClient(params.clientId);
      if (linked)
        throw new Error(`client ${params.clientId} is already in the network as ${linked.id}`);
    }
    const now = Date.now();
    const c: Contact = {
      id,
      name,
      org: String(params.org ?? "").trim(),
      role: String(params.role ?? "").trim(),
      contactType: soft(params.contactType, CONTACT_TYPES, params.clientId ? "client" : "other"),
      tags: normalizeTags(params.tags),
      channels: normalizeChannels(params.channels),
      notes: String(params.notes ?? ""),
      status: pick(params.status, CONTACT_STATUSES, "Active"),
      // §27 one accountable owner — in a personal network that is the owner.
      owner: String(params.owner ?? "").trim() || ME_ID,
      priority: clampPriority(params.priority),
      nextAction: String(params.nextAction ?? ""),
      nextActionOwner: String(params.nextActionOwner ?? ""),
      nextActionDate: isoDate(params.nextActionDate),
      lastTouchDate: isoDate(params.lastTouchDate),
      clientId: String(params.clientId ?? "").trim(),
      hubContactId: String(params.hubContactId ?? "").trim(),
      dataQuality: params.dataQuality ?? "Unknown",
      authorityLevel: params.authorityLevel ?? "L1",
      warmOverride: normalizeWarmOverride(params.warmOverride),
      lastUpdated: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO network_contacts (id,name,org,role,contact_type,tags,channels,notes,status,owner,
          priority,next_action,next_action_owner,next_action_date,last_touch_date,client_id,hub_contact_id,
          data_quality,authority_level,warm_override,created_at,updated_at)
         VALUES (@id,@name,@org,@role,@contactType,@tags,@channels,@notes,@status,@owner,@priority,
          @nextAction,@nextActionOwner,@nextActionDate,@lastTouchDate,@clientId,@hubContactId,
          @dataQuality,@authorityLevel,@warmOverride,@createdAt,@updatedAt)`,
      )
      .run(this.bindContact(c));
    this.record("contact", id, "created", "", c.status, actor, now);
    return c;
  }

  updateContact(params: ContactUpdateParams, actor = "user"): Contact | null {
    const cur = this.getContact(params.id);
    if (!cur) return null;
    const next: Contact = { ...cur };
    if (params.name !== undefined) {
      const name = String(params.name).trim();
      if (!name && !cur.clientId) throw new Error("name is required");
      next.name = name;
    }
    if (params.org !== undefined) next.org = String(params.org).trim();
    if (params.role !== undefined) next.role = String(params.role).trim();
    if (params.contactType !== undefined)
      next.contactType = soft(params.contactType, CONTACT_TYPES, cur.contactType);
    if (params.tags !== undefined) next.tags = normalizeTags(params.tags);
    if (params.channels !== undefined) next.channels = normalizeChannels(params.channels);
    if (params.notes !== undefined) next.notes = String(params.notes);
    if (params.status !== undefined)
      next.status = pick(params.status, CONTACT_STATUSES, cur.status);
    if (params.owner !== undefined) next.owner = String(params.owner).trim() || ME_ID;
    if (params.priority !== undefined) next.priority = clampPriority(params.priority);
    if (params.nextAction !== undefined) next.nextAction = String(params.nextAction);
    if (params.nextActionOwner !== undefined) next.nextActionOwner = String(params.nextActionOwner);
    if (params.nextActionDate !== undefined) next.nextActionDate = isoDate(params.nextActionDate);
    if (params.lastTouchDate !== undefined) next.lastTouchDate = isoDate(params.lastTouchDate);
    if (params.clientId !== undefined) {
      const cid = String(params.clientId).trim();
      if (cid && cid !== cur.clientId) {
        const linked = this.findContactByClient(cid);
        if (linked && linked.id !== cur.id)
          throw new Error(`client ${cid} is already in the network as ${linked.id}`);
      }
      next.clientId = cid;
    }
    if (params.hubContactId !== undefined) next.hubContactId = String(params.hubContactId).trim();
    if (params.dataQuality !== undefined) next.dataQuality = params.dataQuality;
    if (params.authorityLevel !== undefined) next.authorityLevel = params.authorityLevel;
    if (params.warmOverride !== undefined)
      next.warmOverride = normalizeWarmOverride(params.warmOverride);
    const now = Date.now();
    next.updatedAt = now;
    next.lastUpdated = now;
    this.db
      .prepare(
        `UPDATE network_contacts SET name=@name,org=@org,role=@role,contact_type=@contactType,tags=@tags,
          channels=@channels,notes=@notes,status=@status,owner=@owner,priority=@priority,
          next_action=@nextAction,next_action_owner=@nextActionOwner,next_action_date=@nextActionDate,
          last_touch_date=@lastTouchDate,client_id=@clientId,hub_contact_id=@hubContactId,
          data_quality=@dataQuality,authority_level=@authorityLevel,warm_override=@warmOverride,
          updated_at=@updatedAt WHERE id=@id`,
      )
      .run(this.bindContact(next));
    for (const f of CONTACT_TRACKED) {
      const a = String(cur[f] ?? "");
      const b = String(next[f] ?? "");
      if (a !== b) this.record("contact", cur.id, f, a, b, actor, now);
    }
    return next;
  }

  /** Delete a contact and every connection touching it. History is kept. */
  deleteContact(id: string, actor = "user"): { deleted: boolean; connectionIds: string[] } {
    const connectionIds = this.connectionsOf(id).map((c) => c.id);
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM network_connections WHERE from_id = ? OR to_id = ?`).run(id, id);
      this.db.prepare(`DELETE FROM network_warm_history WHERE contact_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM network_contacts WHERE id = ?`).run(id).changes > 0;
    });
    const deleted = tx();
    if (deleted) this.record("contact", id, "deleted", "", "", actor, Date.now());
    return { deleted, connectionIds };
  }

  private bindContact(c: Contact): Record<string, string | number | null> {
    return {
      id: c.id,
      name: c.name,
      org: c.org,
      role: c.role,
      contactType: String(c.contactType),
      tags: JSON.stringify(c.tags),
      channels: JSON.stringify(c.channels),
      notes: c.notes,
      status: String(c.status),
      owner: c.owner,
      priority: String(c.priority),
      nextAction: c.nextAction ?? "",
      nextActionOwner: c.nextActionOwner ?? "",
      nextActionDate: c.nextActionDate ?? "",
      lastTouchDate: c.lastTouchDate,
      clientId: c.clientId ?? "",
      hubContactId: c.hubContactId,
      dataQuality: String(c.dataQuality ?? "Unknown"),
      authorityLevel: String(c.authorityLevel ?? "L1"),
      warmOverride: c.warmOverride ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  // ── Connections ──────────────────────────────────────────────────

  listConnections(params: { contactId?: string; status?: string } = {}): Connection[] {
    let rows = (
      this.db
        .prepare(`SELECT * FROM network_connections ORDER BY updated_at DESC`)
        .all() as ConnectionRow[]
    ).map(rowToConnection);
    if (params.contactId)
      rows = rows.filter((c) => c.fromId === params.contactId || c.toId === params.contactId);
    if (params.status) rows = rows.filter((c) => c.status === params.status);
    return rows;
  }

  connectionsOf(nodeId: string): Connection[] {
    return (
      this.db
        .prepare(`SELECT * FROM network_connections WHERE from_id = ? OR to_id = ?`)
        .all(nodeId, nodeId) as ConnectionRow[]
    ).map(rowToConnection);
  }

  getConnection(id: string): Connection | null {
    const row = this.db.prepare(`SELECT * FROM network_connections WHERE id = ?`).get(id) as
      | ConnectionRow
      | undefined;
    return row ? rowToConnection(row) : null;
  }

  /** The existing connection between two nodes (either direction), if any. */
  findConnection(a: string, b: string): Connection | null {
    const row = this.db
      .prepare(
        `SELECT * FROM network_connections WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) LIMIT 1`,
      )
      .get(a, b, b, a) as ConnectionRow | undefined;
    return row ? rowToConnection(row) : null;
  }

  private assertEndpoint(id: string): void {
    if (id === ME_ID) return;
    if (!this.getContact(id)) throw new Error(`contact "${id}" not found`);
  }

  createConnection(params: ConnectionCreateParams, actor = "user"): Connection {
    const fromId = String(params.fromId ?? "").trim();
    const toId = String(params.toId ?? "").trim();
    if (!fromId || !toId) throw new Error("fromId and toId are required");
    if (fromId === toId) throw new Error("a contact cannot be connected to itself");
    this.assertEndpoint(fromId);
    this.assertEndpoint(toId);
    const id = params.clientRequestId?.trim() || `ncx_${randomUUID()}`;
    const existingById = this.getConnection(id);
    if (existingById) return existingById;
    const dup = this.findConnection(fromId, toId);
    if (dup)
      throw new Error(`these two are already connected (${dup.id}) — update that connection`);
    const now = Date.now();
    const c: Connection = {
      id,
      fromId,
      toId,
      relationshipType: soft(params.relationshipType, RELATIONSHIP_TYPES, "other"),
      strength: clampStrength(params.strength ?? 3),
      direction: pick(params.direction, CONNECTION_DIRECTIONS, "mutual"),
      values: normalizeValues(params.values),
      lastTouchDate: isoDate(params.lastTouchDate),
      status: pick(params.status, CONNECTION_STATUSES, "Active"),
      notes: String(params.notes ?? ""),
      owner: String(params.owner ?? "").trim() || ME_ID,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO network_connections (id,from_id,to_id,relationship_type,strength,direction,value_items,
          last_touch_date,status,notes,owner,created_at,updated_at)
         VALUES (@id,@fromId,@toId,@relationshipType,@strength,@direction,@values,@lastTouchDate,@status,
          @notes,@owner,@createdAt,@updatedAt)`,
      )
      .run(this.bindConnection(c));
    this.record(
      "connection",
      id,
      "created",
      "",
      `${c.relationshipType} · ${c.strength}`,
      actor,
      now,
    );
    return c;
  }

  updateConnection(params: ConnectionUpdateParams, actor = "user"): Connection | null {
    const cur = this.getConnection(params.id);
    if (!cur) return null;
    const next: Connection = { ...cur };
    if (params.relationshipType !== undefined)
      next.relationshipType = soft(
        params.relationshipType,
        RELATIONSHIP_TYPES,
        cur.relationshipType,
      );
    if (params.strength !== undefined) next.strength = clampStrength(params.strength);
    if (params.direction !== undefined)
      next.direction = pick(
        params.direction,
        CONNECTION_DIRECTIONS,
        String(cur.direction) as "mutual",
      );
    if (params.values !== undefined) next.values = normalizeValues(params.values);
    if (params.lastTouchDate !== undefined) next.lastTouchDate = isoDate(params.lastTouchDate);
    if (params.status !== undefined)
      next.status = pick(params.status, CONNECTION_STATUSES, String(cur.status) as "Active");
    if (params.notes !== undefined) next.notes = String(params.notes);
    if (params.owner !== undefined) next.owner = String(params.owner).trim() || ME_ID;
    const now = Date.now();
    next.updatedAt = now;
    this.db
      .prepare(
        `UPDATE network_connections SET relationship_type=@relationshipType,strength=@strength,
          direction=@direction,value_items=@values,last_touch_date=@lastTouchDate,status=@status,
          notes=@notes,owner=@owner,updated_at=@updatedAt WHERE id=@id`,
      )
      .run(this.bindConnection(next));
    for (const f of CONNECTION_TRACKED) {
      const a = String(cur[f] ?? "");
      const b = String(next[f] ?? "");
      if (a !== b) this.record("connection", cur.id, f, a, b, actor, now);
    }
    if (JSON.stringify(cur.values) !== JSON.stringify(next.values))
      this.record(
        "connection",
        cur.id,
        "values",
        String(cur.values.length),
        String(next.values.length),
        actor,
        now,
      );
    return next;
  }

  deleteConnection(id: string, actor = "user"): boolean {
    const ok = this.db.prepare(`DELETE FROM network_connections WHERE id = ?`).run(id).changes > 0;
    if (ok) this.record("connection", id, "deleted", "", "", actor, Date.now());
    return ok;
  }

  private bindConnection(c: Connection): Record<string, string | number> {
    return {
      id: c.id,
      fromId: c.fromId,
      toId: c.toId,
      relationshipType: String(c.relationshipType),
      strength: c.strength,
      direction: String(c.direction),
      values: JSON.stringify(c.values),
      lastTouchDate: c.lastTouchDate,
      status: String(c.status),
      notes: c.notes,
      owner: c.owner,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  // ── History ──────────────────────────────────────────────────────

  record(
    objectType: NetworkHistoryEntry["objectType"],
    objectId: string,
    field: string,
    from: string,
    to: string,
    actor: string,
    at = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO network_history (id,object_type,object_id,field,from_value,to_value,actor,at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        objectType,
        objectId,
        field,
        from.slice(0, 500),
        to.slice(0, 500),
        actor,
        at,
      );
  }

  history(
    params: { objectType?: string; objectIds?: string[]; limit?: number } = {},
  ): NetworkHistoryEntry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.objectType) {
      where.push("object_type = ?");
      args.push(params.objectType);
    }
    if (params.objectIds?.length) {
      where.push(`object_id IN (${params.objectIds.map(() => "?").join(",")})`);
      args.push(...params.objectIds);
    }
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT * FROM network_history ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY at DESC LIMIT ${limit}`,
      )
      .all(...args) as Array<{
      id: string;
      object_type: NetworkHistoryEntry["objectType"];
      object_id: string;
      field: string;
      from_value: string;
      to_value: string;
      actor: string;
      at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      objectType: r.object_type,
      objectId: r.object_id,
      field: r.field,
      from: r.from_value,
      to: r.to_value,
      actor: r.actor,
      at: r.at,
    }));
  }

  // ── Warm score ───────────────────────────────────────────────────

  /**
   * Interaction counts per object id since `sinceMs` (every tracked change
   * except the "created" row and owner warm overrides: touches, status /
   * strength moves, links…).
   */
  activityCounts(sinceMs: number): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT object_id AS id, COUNT(*) AS n FROM network_history
         WHERE at >= ? AND field NOT IN ('created', 'warmOverride') GROUP BY object_id`,
      )
      .all(sinceMs) as Array<{ id: string; n: number }>;
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  /**
   * Snapshot warm scores for the trend line. A contact gets a new point when
   * its score moved by ≥1 or its last point is older than a day, so the table
   * stays small (≤ ~1 row/contact/day plus real changes).
   */
  recordWarmScores(scores: Array<{ id: string; score: number }>, now = Date.now()): number {
    const last = this.db.prepare(
      `SELECT score, at FROM network_warm_history WHERE contact_id = ? ORDER BY at DESC LIMIT 1`,
    );
    const ins = this.db.prepare(
      `INSERT INTO network_warm_history (contact_id, score, at) VALUES (?, ?, ?)`,
    );
    let written = 0;
    const tx = this.db.transaction(() => {
      for (const s of scores) {
        const prev = last.get(s.id) as { score: number; at: number } | undefined;
        if (prev && Math.abs(prev.score - s.score) < 1 && now - prev.at < 86_400_000) continue;
        ins.run(s.id, Math.round(s.score), now);
        written++;
      }
    });
    tx();
    return written;
  }

  /** Warm score points for one contact, oldest first. */
  warmHistory(contactId: string, sinceMs = 0): Array<{ score: number; at: number }> {
    return this.db
      .prepare(
        `SELECT score, at FROM network_warm_history WHERE contact_id = ? AND at >= ? ORDER BY at ASC LIMIT 500`,
      )
      .all(contactId, sinceMs) as Array<{ score: number; at: number }>;
  }

  /** Each contact's latest score at or before `beforeMs` (the trend baseline). */
  warmBaseline(beforeMs: number): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT h.contact_id AS id, h.score AS score FROM network_warm_history h
         JOIN (SELECT contact_id, MAX(at) AS at FROM network_warm_history WHERE at <= ? GROUP BY contact_id) m
           ON m.contact_id = h.contact_id AND m.at = h.at`,
      )
      .all(beforeMs) as Array<{ id: string; score: number }>;
    return new Map(rows.map((r) => [r.id, r.score]));
  }

  /** Oldest point per contact inside [sinceMs, now] — fallback baseline for young contacts. */
  warmEarliest(sinceMs: number): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT h.contact_id AS id, h.score AS score FROM network_warm_history h
         JOIN (SELECT contact_id, MIN(at) AS at FROM network_warm_history WHERE at >= ? GROUP BY contact_id) m
           ON m.contact_id = h.contact_id AND m.at = h.at`,
      )
      .all(sinceMs) as Array<{ id: string; score: number }>;
    return new Map(rows.map((r) => [r.id, r.score]));
  }
}
