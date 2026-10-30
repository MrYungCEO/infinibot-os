/**
 * Content Intelligence — reel thumbnail store.
 *
 * Deliberately a *separate* module from {@link store.ts}: thumbnails live in
 * their own `reel_thumbnails` table so we never `ALTER TABLE reels` (which
 * would churn-conflict with the agents actively editing the reels schema /
 * store). We reuse the existing store's open DB handle (WAL) rather than
 * opening a second connection.
 *
 * Table:
 *   reel_thumbnails(
 *     shortcode     TEXT PRIMARY KEY,
 *     thumbnail_url TEXT,    -- remote og:image URL (may expire — IG CDN)
 *     local_path    TEXT,    -- downloaded bytes on disk, if we mirrored them
 *     fetched_at    INTEGER, -- ms epoch of last fetch attempt
 *     ok            INTEGER  -- 1 = got a real image, 0 = attempted but failed
 *   )
 */

import type Database from "better-sqlite3";
import { getContentIntelStore } from "./store.js";

export interface ThumbnailRow {
  shortcode: string;
  thumbnail_url: string | null;
  local_path: string | null;
  fetched_at: number;
  ok: number; // 0 | 1
}

let _ensuredFor: Database.Database | null = null;

/** Lazily create the table on the store's DB handle (idempotent, cached). */
function db(): Database.Database {
  const handle = getContentIntelStore().db;
  if (_ensuredFor !== handle) {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS reel_thumbnails (
        shortcode     TEXT PRIMARY KEY,
        thumbnail_url TEXT,
        local_path    TEXT,
        fetched_at    INTEGER NOT NULL,
        ok            INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_reel_thumbnails_ok ON reel_thumbnails(ok);
    `);
    _ensuredFor = handle;
  }
  return handle;
}

/** Ensure the table exists (call before any read so a fresh DB doesn't throw). */
export function ensureThumbnailTable(): void {
  db();
}

export function getThumbnail(shortcode: string): ThumbnailRow | undefined {
  return db().prepare("SELECT * FROM reel_thumbnails WHERE shortcode = ?").get(shortcode) as
    | ThumbnailRow
    | undefined;
}

export function setThumbnail(row: ThumbnailRow): void {
  db()
    .prepare(`
      INSERT INTO reel_thumbnails (shortcode, thumbnail_url, local_path, fetched_at, ok)
      VALUES (@shortcode, @thumbnail_url, @local_path, @fetched_at, @ok)
      ON CONFLICT(shortcode) DO UPDATE SET
        thumbnail_url = excluded.thumbnail_url,
        local_path    = excluded.local_path,
        fetched_at    = excluded.fetched_at,
        ok            = excluded.ok
    `)
    .run(row);
}

/** All thumbnails as a `shortcode -> row` map (cheap; ≤ a few hundred rows). */
export function getAllThumbnails(): Map<string, ThumbnailRow> {
  const rows = db().prepare("SELECT * FROM reel_thumbnails").all() as ThumbnailRow[];
  return new Map(rows.map((r) => [r.shortcode, r]));
}

/** Count of thumbnails that successfully resolved a real image. */
export function countOkThumbnails(): number {
  return (
    db().prepare("SELECT COUNT(*) AS c FROM reel_thumbnails WHERE ok = 1").get() as {
      c: number;
    }
  ).c;
}
