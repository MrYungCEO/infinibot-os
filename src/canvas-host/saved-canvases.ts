/**
 * Saved canvases — SQLite persistence (canvas runtime, core).
 *
 * Stores infinite-canvas-walkthrough payloads for later replay, sharing, and
 * re-emit. One table (`canvas_library`) keyed by UUID, with JSON payload,
 * optional thumbnail, baked-audio manifest, and tags.
 *
 * This is part of the core canvas runtime (PLUGIN-PLATFORM.md B34): work-review
 * and `canvas.convert` save here and `/canvas/:id` serves from here whether or
 * not the HoloCanvas library plugin (extensions/canvas-library) is on. The
 * plugin is only the browse/manage surface over this store, reached through
 * the `canvasRuntime` seam in `infinibot/plugin-sdk`.
 *
 * The file keeps its historical name, `<stateDir>/canvas-library.db`, so
 * upgrading installs keep every saved canvas without a data move.
 *
 * Pattern mirrors src/proactive/popup-store.ts.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import type { InfiniteCanvasWalkthroughMedia } from "../proactive/popup-types.js";

const log = createSubsystemLogger("canvas-store");

export interface SavedCanvas {
  id: string;
  title: string;
  payload: InfiniteCanvasWalkthroughMedia;
  thumbnailDataUrl: string | null;
  bakedAudioManifest: Record<string, string> | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

interface SavedCanvasRow {
  id: string;
  title: string;
  payload_json: string;
  thumbnail_data_url: string | null;
  baked_audio_manifest_json: string | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

function rowToEntry(r: SavedCanvasRow): SavedCanvas {
  let payload: InfiniteCanvasWalkthroughMedia = { nodes: [], scenes: [] };
  let bakedAudioManifest: Record<string, string> | null = null;
  let tags: string[] = [];

  try {
    payload = JSON.parse(r.payload_json) as InfiniteCanvasWalkthroughMedia;
  } catch {
    /* keep fallback */
  }
  if (r.baked_audio_manifest_json) {
    try {
      const parsed = JSON.parse(r.baked_audio_manifest_json);
      if (parsed && typeof parsed === "object")
        bakedAudioManifest = parsed as Record<string, string>;
    } catch {
      /* keep null */
    }
  }
  try {
    const parsed = JSON.parse(r.tags_json);
    if (Array.isArray(parsed)) tags = parsed as string[];
  } catch {
    /* keep [] */
  }

  return {
    id: r.id,
    title: r.title,
    payload,
    thumbnailDataUrl: r.thumbnail_data_url,
    bakedAudioManifest,
    tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Historical file name, kept so existing installs need no data move. */
export const SAVED_CANVASES_DB = "canvas-library.db";

let _instance: SavedCanvasStore | null = null;

export function getSavedCanvasStore(stateDir?: string): SavedCanvasStore {
  if (!_instance) {
    const dir = stateDir ?? resolveStateDir();
    _instance = new SavedCanvasStore(dir);
  }
  return _instance;
}

/** Test hook: close and forget the singleton. */
export function resetSavedCanvasStoreForTests(): void {
  _instance?.close();
  _instance = null;
}

export class SavedCanvasStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    const dbPath = join(stateDir, SAVED_CANVASES_DB);
    this.db = new Database(dbPath);
    this.migrate();
    log.info("saved canvas store ready", { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_library (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        thumbnail_data_url TEXT,
        baked_audio_manifest_json TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canvas_library_created_at ON canvas_library (created_at DESC);
    `);
  }

  list(opts: { tag?: string; limit?: number; offset?: number } = {}): SavedCanvas[] {
    const { tag, limit = 100, offset = 0 } = opts;
    const rows = (
      tag
        ? this.db
            .prepare(
              `SELECT * FROM canvas_library
               WHERE EXISTS (SELECT 1 FROM json_each(canvas_library.tags_json) WHERE json_each.value = ?)
               ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            )
            .all(tag, limit, offset)
        : this.db
            .prepare(`SELECT * FROM canvas_library ORDER BY created_at DESC LIMIT ? OFFSET ?`)
            .all(limit, offset)
    ) as SavedCanvasRow[];
    return rows.map(rowToEntry);
  }

  get(id: string): SavedCanvas | null {
    const row = this.db.prepare(`SELECT * FROM canvas_library WHERE id = ?`).get(id) as
      | SavedCanvasRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  save(opts: {
    title: string;
    payload: InfiniteCanvasWalkthroughMedia;
    tags?: string[];
    thumbnailDataUrl?: string | null;
    id?: string;
  }): SavedCanvas {
    const id = opts.id ?? randomUUID();
    const now = Date.now();
    const existing = opts.id ? this.get(opts.id) : null;

    this.db
      .prepare(
        `INSERT INTO canvas_library
           (id, title, payload_json, thumbnail_data_url, baked_audio_manifest_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           payload_json = excluded.payload_json,
           thumbnail_data_url = COALESCE(excluded.thumbnail_data_url, canvas_library.thumbnail_data_url),
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        opts.title,
        JSON.stringify(opts.payload),
        opts.thumbnailDataUrl ?? null,
        existing?.bakedAudioManifest ? JSON.stringify(existing.bakedAudioManifest) : null,
        JSON.stringify(opts.tags ?? []),
        existing?.createdAt ?? now,
        now,
      );

    return this.get(id)!;
  }

  updateBakedManifest(id: string, manifest: Record<string, string>): void {
    this.db
      .prepare(
        `UPDATE canvas_library SET baked_audio_manifest_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(manifest), Date.now(), id);
  }

  updateThumbnail(id: string, dataUrl: string): void {
    this.db
      .prepare(`UPDATE canvas_library SET thumbnail_data_url = ?, updated_at = ? WHERE id = ?`)
      .run(dataUrl, Date.now(), id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM canvas_library WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Total rows, or rows carrying `tag` when given. */
  count(tag?: string): number {
    const row = (
      tag
        ? this.db
            .prepare(
              `SELECT COUNT(*) as n FROM canvas_library
               WHERE EXISTS (SELECT 1 FROM json_each(canvas_library.tags_json) WHERE json_each.value = ?)`,
            )
            .get(tag)
        : this.db.prepare(`SELECT COUNT(*) as n FROM canvas_library`).get()
    ) as { n: number };
    return row.n;
  }

  /** First canvas with exactly this title (idempotent example loading). */
  findByTitle(title: string): SavedCanvas | null {
    const row = this.db
      .prepare(`SELECT * FROM canvas_library WHERE title = ? ORDER BY created_at ASC LIMIT 1`)
      .get(title) as SavedCanvasRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  allTags(): string[] {
    const rows = this.db.prepare(`SELECT tags_json FROM canvas_library`).all() as {
      tags_json: string;
    }[];
    const all = new Set<string>();
    for (const r of rows) {
      try {
        const t = JSON.parse(r.tags_json) as string[];
        if (Array.isArray(t)) t.forEach((tag) => all.add(tag));
      } catch {
        /* skip */
      }
    }
    return [...all].sort();
  }
}
