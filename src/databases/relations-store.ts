/**
 * Generic entity-relations store.
 *
 * One small SQLite table records pairs of (entity-type, entity-id) ↔
 * (entity-type, entity-id). Each pair is canonicalized so that
 * (a → b) and (b → a) collapse to a single row; lookups are bidirectional
 * by design. Supported entity types are open-ended strings — current
 * callers use "client", "project", "note", "workflow".
 *
 * The store is co-located with the rest of the SQLite stores under STATE_DIR
 * and lazy-opens. No migrations needed beyond the initial CREATE.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let _db: Database.Database | null = null;
let _dir: string | null = null;

function dbFor(stateDir: string): Database.Database {
  if (_db && _dir === stateDir) return _db;
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, "relations.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_relations (
      a_type TEXT NOT NULL,
      a_id   TEXT NOT NULL,
      b_type TEXT NOT NULL,
      b_id   TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (a_type, a_id, b_type, b_id)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_a ON entity_relations(a_type, a_id);
    CREATE INDEX IF NOT EXISTS idx_relations_b ON entity_relations(b_type, b_id);
  `);
  _db = db;
  _dir = stateDir;
  return db;
}

export type EntityRef = { type: string; id: string };

// Canonical ordering — keeps (a, b) and (b, a) as one row.
function canonical(a: EntityRef, b: EntityRef): [EntityRef, EntityRef] {
  if (a.type < b.type) return [a, b];
  if (a.type > b.type) return [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}

export function linkEntities(stateDir: string, a: EntityRef, b: EntityRef): void {
  if (a.type === b.type && a.id === b.id) return;
  const [x, y] = canonical(a, b);
  const db = dbFor(stateDir);
  db.prepare(
    `INSERT OR IGNORE INTO entity_relations(a_type, a_id, b_type, b_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(x.type, x.id, y.type, y.id, new Date().toISOString());
}

export function unlinkEntities(stateDir: string, a: EntityRef, b: EntityRef): void {
  const [x, y] = canonical(a, b);
  const db = dbFor(stateDir);
  db.prepare(
    `DELETE FROM entity_relations
     WHERE a_type = ? AND a_id = ? AND b_type = ? AND b_id = ?`,
  ).run(x.type, x.id, y.type, y.id);
}

/**
 * Returns every entity related to (type, id) — either side of the pair.
 * Optional `peerType` filter constrains the result to a single related-type.
 */
export function listRelations(
  stateDir: string,
  ref: EntityRef,
  peerType?: string,
): Array<EntityRef & { createdAt: string }> {
  const db = dbFor(stateDir);
  const rows = db
    .prepare(
      `SELECT a_type, a_id, b_type, b_id, created_at
       FROM entity_relations
       WHERE (a_type = ? AND a_id = ?)
          OR (b_type = ? AND b_id = ?)`,
    )
    .all(ref.type, ref.id, ref.type, ref.id) as Array<{
    a_type: string;
    a_id: string;
    b_type: string;
    b_id: string;
    created_at: string;
  }>;

  const out: Array<EntityRef & { createdAt: string }> = [];
  for (const r of rows) {
    const peer =
      r.a_type === ref.type && r.a_id === ref.id
        ? { type: r.b_type, id: r.b_id }
        : { type: r.a_type, id: r.a_id };
    if (peerType && peer.type !== peerType) continue;
    out.push({ ...peer, createdAt: r.created_at });
  }
  return out;
}

/**
 * Every pair between two entity types, oriented as `{ a: typeA, b: typeB }`
 * whichever side it was stored on (e.g. all client ↔ project links at once).
 */
export function listPairsByType(
  stateDir: string,
  typeA: string,
  typeB: string,
): Array<{ aId: string; bId: string }> {
  const db = dbFor(stateDir);
  const rows = db
    .prepare(
      `SELECT a_type, a_id, b_id FROM entity_relations
       WHERE (a_type = ? AND b_type = ?) OR (a_type = ? AND b_type = ?)`,
    )
    .all(typeA, typeB, typeB, typeA) as Array<{ a_type: string; a_id: string; b_id: string }>;
  return rows.map((r) =>
    r.a_type === typeA ? { aId: r.a_id, bId: r.b_id } : { aId: r.b_id, bId: r.a_id },
  );
}

/**
 * Bulk-replace the relations for a given (ref, peerType) to exactly the
 * supplied peerIds. Convenient for "save these relations" UX where the
 * client sends the full desired set rather than individual link/unlink ops.
 */
export function replaceRelations(
  stateDir: string,
  ref: EntityRef,
  peerType: string,
  peerIds: string[],
): void {
  const desired = new Set(peerIds);
  const current = listRelations(stateDir, ref, peerType);

  for (const cur of current) {
    if (!desired.has(cur.id)) unlinkEntities(stateDir, ref, { type: peerType, id: cur.id });
  }
  for (const id of desired) {
    linkEntities(stateDir, ref, { type: peerType, id });
  }
}

/** Drop every relation that references (type, id). Used on entity delete. */
export function purgeEntity(stateDir: string, ref: EntityRef): void {
  const db = dbFor(stateDir);
  db.prepare(
    `DELETE FROM entity_relations
     WHERE (a_type = ? AND a_id = ?) OR (b_type = ? AND b_id = ?)`,
  ).run(ref.type, ref.id, ref.type, ref.id);
}
