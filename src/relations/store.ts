/**
 * Relations store — SQLite-backed generic edge store for the Business Control
 * Layer's connected business objects (spec §4/§14).
 *
 * Modeled on `src/issues/store.ts`: local SQLite is the source of truth, opened
 * under the resolved `~/.infinibot` state dir. Every caller — the gateway
 * `relations.*` RPC handlers, object-builder agents, and the HQ views — goes
 * through this single store so the contract stays consistent.
 *
 * One table (`object_relations`) with one typed column per field. Edges are
 * directional (`from` → `to`); queries can walk either direction.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import type {
  ObjectRelation,
  RelationCreateParams,
  RelationGraph,
  RelationMatch,
  RelationNode,
  RelationQuery,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getRelationsStore(stateDir?: string): RelationsStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new RelationsStore(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS object_relations (
  id          TEXT PRIMARY KEY,
  from_type   TEXT NOT NULL DEFAULT '',
  from_id     TEXT NOT NULL DEFAULT '',
  edge        TEXT NOT NULL DEFAULT 'relates_to',
  to_type     TEXT NOT NULL DEFAULT '',
  to_id       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL DEFAULT '',
  meta        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON object_relations(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON object_relations(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_rel_edge ON object_relations(edge);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique
  ON object_relations(from_type, from_id, edge, to_type, to_id);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  // NB: a separate file from the pre-existing untyped `relations.db`
  // (src/databases/relations-store.ts). This is the typed-edge business-object
  // graph; the two stores are intentionally independent.
  const dbPath = resolve(stateDir, "object-relations.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface RelationRow {
  id: string;
  from_type: string;
  from_id: string;
  edge: string;
  to_type: string;
  to_id: string;
  created_at: number;
  created_by: string;
  meta: string;
}

function rowToRelation(r: RelationRow): ObjectRelation {
  let meta: Record<string, unknown> = {};
  try {
    meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  return {
    id: r.id,
    fromType: r.from_type,
    fromId: r.from_id,
    edge: r.edge,
    toType: r.to_type,
    toId: r.to_id,
    createdAt: r.created_at,
    createdBy: r.created_by,
    meta,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class RelationsStore {
  constructor(private db: Database.Database) {}

  /**
   * Create a link. Idempotent on the (from, edge, to) identity: a repeat link
   * returns the existing row rather than duplicating it. `clientRequestId`, if
   * given, is used as the row id for caller-side idempotency.
   */
  create(params: RelationCreateParams): ObjectRelation {
    const existing = this.findMatch({
      fromType: params.fromType,
      fromId: params.fromId,
      edge: params.edge,
      toType: params.toType,
      toId: params.toId,
    });
    if (existing) return existing;

    const rel: ObjectRelation = {
      id: params.clientRequestId?.trim() || randomUUID(),
      fromType: params.fromType,
      fromId: params.fromId,
      edge: params.edge || "relates_to",
      toType: params.toType,
      toId: params.toId,
      createdAt: Date.now(),
      createdBy: params.createdBy ?? "",
      meta: params.meta ?? {},
    };
    this.db
      .prepare(
        `INSERT INTO object_relations
           (id, from_type, from_id, edge, to_type, to_id, created_at, created_by, meta)
         VALUES (@id, @fromType, @fromId, @edge, @toType, @toId, @createdAt, @createdBy, @meta)`,
      )
      .run({
        id: rel.id,
        fromType: rel.fromType,
        fromId: rel.fromId,
        edge: rel.edge,
        toType: rel.toType,
        toId: rel.toId,
        createdAt: rel.createdAt,
        createdBy: rel.createdBy,
        meta: JSON.stringify(rel.meta ?? {}),
      });
    return rel;
  }

  get(id: string): ObjectRelation | null {
    const row = this.db.prepare(`SELECT * FROM object_relations WHERE id = ?`).get(id) as
      | RelationRow
      | undefined;
    return row ? rowToRelation(row) : null;
  }

  /** Find a single relation by its (from, edge, to) identity. */
  findMatch(m: RelationMatch): ObjectRelation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM object_relations
         WHERE from_type = ? AND from_id = ? AND edge = ? AND to_type = ? AND to_id = ?`,
      )
      .get(m.fromType, m.fromId, m.edge, m.toType, m.toId) as RelationRow | undefined;
    return row ? rowToRelation(row) : null;
  }

  /** Delete by row id. Returns true if a row was removed. */
  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM object_relations WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Delete by (partial) identity match. Every provided field is ANDed; omit a
   * field to leave it unconstrained. Returns the number of rows removed.
   */
  deleteMatch(m: RelationMatch): number {
    const clauses: string[] = [];
    const args: string[] = [];
    if (m.fromType != null) (clauses.push("from_type = ?"), args.push(m.fromType));
    if (m.fromId != null) (clauses.push("from_id = ?"), args.push(m.fromId));
    if (m.edge != null) (clauses.push("edge = ?"), args.push(m.edge));
    if (m.toType != null) (clauses.push("to_type = ?"), args.push(m.toType));
    if (m.toId != null) (clauses.push("to_id = ?"), args.push(m.toId));
    if (clauses.length === 0) return 0; // never wipe the whole table by accident
    const res = this.db
      .prepare(`DELETE FROM object_relations WHERE ${clauses.join(" AND ")}`)
      .run(...args);
    return res.changes;
  }

  /** Generic filtered list. Any subset of fields narrows the result. */
  list(q: RelationQuery = {}): ObjectRelation[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (q.fromType != null) (clauses.push("from_type = ?"), args.push(q.fromType));
    if (q.fromId != null) (clauses.push("from_id = ?"), args.push(q.fromId));
    if (q.edge != null) (clauses.push("edge = ?"), args.push(q.edge));
    if (q.toType != null) (clauses.push("to_type = ?"), args.push(q.toType));
    if (q.toId != null) (clauses.push("to_id = ?"), args.push(q.toId));
    if (q.since != null) (clauses.push("created_at > ?"), args.push(q.since));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM object_relations ${where} ORDER BY created_at DESC`)
      .all(...args) as RelationRow[];
    let rels = rows.map(rowToRelation);
    if (q.limit != null) rels = rels.slice(0, q.limit);
    return rels;
  }

  /** All outgoing links where (type,id) is the `from` end. */
  linksFrom(type: string, id: string): ObjectRelation[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM object_relations WHERE from_type = ? AND from_id = ? ORDER BY created_at DESC`,
        )
        .all(type, id) as RelationRow[]
    ).map(rowToRelation);
  }

  /** All incoming links where (type,id) is the `to` end. */
  linksTo(type: string, id: string): ObjectRelation[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM object_relations WHERE to_type = ? AND to_id = ? ORDER BY created_at DESC`,
        )
        .all(type, id) as RelationRow[]
    ).map(rowToRelation);
  }

  /** Every relation touching (type,id) on either end. */
  linksAround(type: string, id: string): ObjectRelation[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM object_relations
           WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
           ORDER BY created_at DESC`,
        )
        .all(type, id, type, id) as RelationRow[]
    ).map(rowToRelation);
  }

  /**
   * Build the connected neighborhood around a root object (spec §14): a BFS
   * across edges in both directions. `maxDepth` bounds the walk (default 3);
   * pass a large value for the full connected component. The `nodes` list
   * includes the root; `edges` are the distinct relations traversed.
   */
  graphFor(type: string, id: string, maxDepth = 3): RelationGraph {
    const root: RelationNode = { type, id };
    const key = (n: RelationNode) => `${n.type}::${n.id}`;
    const seen = new Set<string>([key(root)]);
    const edgeSeen = new Set<string>();
    const edges: ObjectRelation[] = [];
    let frontier: RelationNode[] = [root];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: RelationNode[] = [];
      for (const node of frontier) {
        for (const rel of this.linksAround(node.type, node.id)) {
          if (!edgeSeen.has(rel.id)) {
            edgeSeen.add(rel.id);
            edges.push(rel);
          }
          const neighbor: RelationNode =
            rel.fromType === node.type && rel.fromId === node.id
              ? { type: rel.toType, id: rel.toId }
              : { type: rel.fromType, id: rel.fromId };
          if (!seen.has(key(neighbor))) {
            seen.add(key(neighbor));
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }

    const nodes: RelationNode[] = Array.from(seen).map((k) => {
      const idx = k.indexOf("::");
      return { type: k.slice(0, idx), id: k.slice(idx + 2) };
    });
    return { root, nodes, edges };
  }
}
