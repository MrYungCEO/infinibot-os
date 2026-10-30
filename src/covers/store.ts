/**
 * Covers store — SQLite-backed Notion-style cover images for business objects.
 *
 * Modeled on `src/issues/store.ts`: local SQLite under the resolved
 * `~/.infinibot` state dir is the source of truth, and every caller (the
 * `covers.*` RPC handlers and the UI through them) goes through this one store.
 *
 * One row per `(object_type, object_id)` — setting a cover replaces whatever
 * was there, which is exactly the Notion semantic ("Change cover").
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import type {
  CoverListParams,
  CoverQueryParams,
  CoverSetLinkParams,
  CoverSetUploadParams,
  ObjectCover,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();

export function getCoversStore(stateDir?: string): CoversStore {
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = dbInstances.get(dir);
  if (!db) {
    db = initDatabase(dir);
    dbInstances.set(dir, db);
  }
  return new CoversStore(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS object_covers (
  id           TEXT PRIMARY KEY,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'link',
  url          TEXT NOT NULL DEFAULT '',
  path         TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  mime_type    TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT NOT NULL DEFAULT '',
  position_y   INTEGER NOT NULL DEFAULT 50,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_covers_object ON object_covers(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_covers_type ON object_covers(object_type);
`;

function initDatabase(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = resolve(stateDir, "covers.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// ROW <-> MODEL
// ═══════════════════════════════════════════════════════════════════

interface CoverRow {
  id: string;
  object_type: string;
  object_id: string;
  source: string;
  url: string;
  path: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  position_y: number;
  created_at: number;
  updated_at: number;
}

function toModel(r: CoverRow): ObjectCover {
  return {
    id: r.id,
    objectType: r.object_type,
    objectId: r.object_id,
    source: r.source === "upload" ? "upload" : "link",
    url: r.url,
    path: r.path,
    name: r.name,
    mimeType: r.mime_type,
    size: r.size,
    sha256: r.sha256,
    positionY: typeof r.position_y === "number" ? r.position_y : 50,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function clampPosition(v: unknown, fallback = 50): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Best-effort display name from a URL (`…/hero-shot.gif` → `hero-shot.gif`). */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.hostname;
  } catch {
    return url.split("/").filter(Boolean).pop() || "cover";
  }
}

/** Guess a mime type from a filename/URL extension. Used for link covers. */
export function mimeFromName(name: string): string {
  const ext = (name.split("?")[0].split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/*";
  }
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class CoversStore {
  constructor(private db: Database.Database) {}

  get({ objectType, objectId }: CoverQueryParams): ObjectCover | null {
    const row = this.db
      .prepare(`SELECT * FROM object_covers WHERE object_type = ? AND object_id = ?`)
      .get(objectType, objectId) as CoverRow | undefined;
    return row ? toModel(row) : null;
  }

  /** Batch fetch for card grids. Empty/omitted `objectIds` → all of the type. */
  list({ objectType, objectIds }: CoverListParams): ObjectCover[] {
    if (Array.isArray(objectIds)) {
      if (objectIds.length === 0) return [];
      // Chunk to stay well under SQLite's variable limit on huge boards.
      const out: ObjectCover[] = [];
      for (let i = 0; i < objectIds.length; i += 400) {
        const chunk = objectIds.slice(i, i + 400);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = this.db
          .prepare(
            `SELECT * FROM object_covers WHERE object_type = ? AND object_id IN (${placeholders})`,
          )
          .all(objectType, ...chunk) as CoverRow[];
        out.push(...rows.map(toModel));
      }
      return out;
    }
    const rows = this.db
      .prepare(`SELECT * FROM object_covers WHERE object_type = ?`)
      .all(objectType) as CoverRow[];
    return rows.map(toModel);
  }

  /** Upsert a link-sourced cover. */
  setLink(params: CoverSetLinkParams): ObjectCover {
    const name = params.name?.trim() || nameFromUrl(params.url);
    return this.upsert({
      objectType: params.objectType,
      objectId: params.objectId,
      source: "link",
      url: params.url,
      path: "",
      name,
      mimeType: mimeFromName(name || params.url),
      size: 0,
      sha256: "",
      positionY: clampPosition(params.positionY),
    });
  }

  /** Upsert an upload-sourced cover (bytes already written to the files root). */
  setUpload(params: CoverSetUploadParams): ObjectCover {
    return this.upsert({
      objectType: params.objectType,
      objectId: params.objectId,
      source: "upload",
      url: "",
      path: params.path,
      name: params.name,
      mimeType: params.mimeType,
      size: params.size,
      sha256: params.sha256,
      positionY: clampPosition(params.positionY),
    });
  }

  /** Reposition an existing cover without re-uploading it. */
  setPosition(objectType: string, objectId: string, positionY: number): ObjectCover | null {
    const existing = this.get({ objectType, objectId });
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare(`UPDATE object_covers SET position_y = ?, updated_at = ? WHERE id = ?`)
      .run(clampPosition(positionY, existing.positionY), now, existing.id);
    return this.get({ objectType, objectId });
  }

  clear(objectType: string, objectId: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM object_covers WHERE object_type = ? AND object_id = ?`)
      .run(objectType, objectId);
    return res.changes > 0;
  }

  private upsert(fields: Omit<ObjectCover, "id" | "createdAt" | "updatedAt">): ObjectCover {
    const now = Date.now();
    const existing = this.get({ objectType: fields.objectType, objectId: fields.objectId });
    if (existing) {
      this.db
        .prepare(
          `UPDATE object_covers
              SET source = @source, url = @url, path = @path, name = @name,
                  mime_type = @mimeType, size = @size, sha256 = @sha256,
                  position_y = @positionY, updated_at = @updatedAt
            WHERE id = @id`,
        )
        .run({ ...fields, id: existing.id, updatedAt: now });
    } else {
      this.db
        .prepare(
          `INSERT INTO object_covers
             (id, object_type, object_id, source, url, path, name, mime_type, size, sha256, position_y, created_at, updated_at)
           VALUES
             (@id, @objectType, @objectId, @source, @url, @path, @name, @mimeType, @size, @sha256, @positionY, @createdAt, @updatedAt)`,
        )
        .run({ ...fields, id: randomUUID(), createdAt: now, updatedAt: now });
    }
    return this.get({ objectType: fields.objectType, objectId: fields.objectId })!;
  }
}
