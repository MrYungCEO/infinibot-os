/**
 * Composition store — SQLite-backed persistence for the native video editor.
 * One DB file (`compositions.db`) with three tables: compositions, tracks,
 * clips. Clip props are JSON-encoded to keep schema evolution loose.
 *
 * Public surface mirrors the databases store: list/get/create/update/delete
 * for each entity plus `getWithChildren` which packs a composition + all
 * its tracks/clips for the editor view.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type {
  Clip,
  ClipKind,
  ClipProps,
  Composition,
  CompositionWithChildren,
  Track,
  TrackKind,
} from "./types.js";

// Per-state-dir DB handles so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const dbInstances = new Map<string, Database.Database>();
const seededDirs = new Set<string>();

export function getCompositionsStore(stateDir: string): CompositionsStore {
  let db = dbInstances.get(stateDir);
  if (!db) {
    db = init(stateDir);
    dbInstances.set(stateDir, db);
  }
  const store = new CompositionsStore(db);
  if (!seededDirs.has(stateDir)) {
    seededDirs.add(stateDir);
    try {
      seedDefaults(store);
    } catch {
      /* best-effort; first user open shouldn't fail because of seed */
    }
  }
  return store;
}

function init(stateDir: string): Database.Database {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new Database(resolve(stateDir, "compositions.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS compositions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      width_px INTEGER NOT NULL DEFAULT 1920,
      height_px INTEGER NOT NULL DEFAULT 1080,
      fps INTEGER NOT NULL DEFAULT 30,
      duration_sec REAL NOT NULL DEFAULT 10,
      bg_color TEXT NOT NULL DEFAULT '#050514',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comp_tracks (
      id TEXT PRIMARY KEY,
      composition_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (composition_id) REFERENCES compositions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_comp_tracks_comp ON comp_tracks(composition_id);
    CREATE TABLE IF NOT EXISTS comp_clips (
      id TEXT PRIMARY KEY,
      composition_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT,
      start_sec REAL NOT NULL,
      duration_sec REAL NOT NULL,
      z INTEGER NOT NULL DEFAULT 0,
      props_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (composition_id) REFERENCES compositions(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES comp_tracks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_comp_clips_comp ON comp_clips(composition_id);
    CREATE INDEX IF NOT EXISTS idx_comp_clips_track ON comp_clips(track_id);
    CREATE INDEX IF NOT EXISTS idx_comp_clips_start ON comp_clips(composition_id, start_sec);
  `);
  return db;
}

function jp<T>(raw: string | null | undefined, fb: T): T {
  if (!raw) return fb;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fb;
  }
}

function mapComp(row: Record<string, unknown>): Composition {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    widthPx: row.width_px as number,
    heightPx: row.height_px as number,
    fps: row.fps as number,
    durationSec: row.duration_sec as number,
    bgColor: row.bg_color as string,
    meta: jp(row.meta_json as string | null, {} as Record<string, unknown>),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapTrack(row: Record<string, unknown>): Track {
  return {
    id: row.id as string,
    compositionId: row.composition_id as string,
    kind: row.kind as TrackKind,
    name: row.name as string,
    sortOrder: row.sort_order as number,
    muted: (row.muted as number) === 1,
    locked: (row.locked as number) === 1,
    hidden: (row.hidden as number) === 1,
  };
}

function mapClip(row: Record<string, unknown>): Clip {
  return {
    id: row.id as string,
    compositionId: row.composition_id as string,
    trackId: row.track_id as string,
    kind: row.kind as ClipKind,
    label: (row.label as string | null) ?? undefined,
    startSec: row.start_sec as number,
    durationSec: row.duration_sec as number,
    z: row.z as number,
    props: jp(row.props_json as string | null, {} as ClipProps),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function slugify(s: string): string {
  return (
    (s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `comp-${randomUUID().slice(0, 6)}`
  );
}

export class CompositionsStore {
  constructor(private db: Database.Database) {}

  list(): Composition[] {
    return (
      this.db.prepare(`SELECT * FROM compositions ORDER BY updated_at DESC`).all() as Record<
        string,
        unknown
      >[]
    ).map(mapComp);
  }

  get(id: string): Composition | null {
    const row = this.db.prepare(`SELECT * FROM compositions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapComp(row) : null;
  }

  getBySlug(slug: string): Composition | null {
    const row = this.db.prepare(`SELECT * FROM compositions WHERE slug = ?`).get(slug) as
      | Record<string, unknown>
      | undefined;
    return row ? mapComp(row) : null;
  }

  getWithChildren(id: string): CompositionWithChildren | null {
    const c = this.get(id);
    if (!c) return null;
    return {
      ...c,
      tracks: this.listTracks(id),
      clips: this.listClips(id),
    };
  }

  create(input: {
    id?: string;
    name: string;
    slug?: string;
    widthPx?: number;
    heightPx?: number;
    fps?: number;
    durationSec?: number;
    bgColor?: string;
    meta?: Record<string, unknown>;
  }): Composition {
    const id = input.id || `comp_${randomUUID()}`;
    const now = Date.now();
    const baseSlug = input.slug || slugify(input.name);
    const slug = this.allocateSlug(baseSlug);
    this.db
      .prepare(
        `INSERT INTO compositions (id, name, slug, width_px, height_px, fps, duration_sec, bg_color, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        slug,
        input.widthPx ?? 1920,
        input.heightPx ?? 1080,
        input.fps ?? 30,
        input.durationSec ?? 10,
        input.bgColor ?? "#050514",
        JSON.stringify(input.meta ?? {}),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Composition,
        "name" | "widthPx" | "heightPx" | "fps" | "durationSec" | "bgColor" | "meta"
      >
    >,
  ): Composition | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE compositions SET name = ?, width_px = ?, height_px = ?, fps = ?, duration_sec = ?, bg_color = ?, meta_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.widthPx,
        next.heightPx,
        next.fps,
        next.durationSec,
        next.bgColor,
        JSON.stringify(next.meta ?? {}),
        next.updatedAt,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM compositions WHERE id = ?`).run(id).changes > 0;
  }

  private allocateSlug(base: string, excludeId?: string): string {
    const stmt = this.db.prepare(`SELECT id FROM compositions WHERE slug = ?`);
    let candidate = base;
    let i = 1;
    while (true) {
      const row = stmt.get(candidate) as { id?: string } | undefined;
      if (!row || (excludeId && row.id === excludeId)) return candidate;
      i += 1;
      candidate = `${base}-${i}`;
      if (i > 9999) return `${base}-${randomUUID().slice(0, 4)}`;
    }
  }

  // ── Tracks ───────────────────────────────────────────────────────

  listTracks(compositionId: string): Track[] {
    return (
      this.db
        .prepare(`SELECT * FROM comp_tracks WHERE composition_id = ? ORDER BY sort_order ASC`)
        .all(compositionId) as Record<string, unknown>[]
    ).map(mapTrack);
  }

  createTrack(input: {
    compositionId: string;
    kind: TrackKind;
    name?: string;
    sortOrder?: number;
  }): Track {
    const id = `track_${randomUUID()}`;
    const existing = this.listTracks(input.compositionId);
    const sort =
      input.sortOrder ?? (existing.length ? existing[existing.length - 1]!.sortOrder + 1000 : 1000);
    const name = input.name ?? defaultTrackName(input.kind, existing.length + 1);
    this.db
      .prepare(
        `INSERT INTO comp_tracks (id, composition_id, kind, name, sort_order, muted, locked, hidden)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0)`,
      )
      .run(id, input.compositionId, input.kind, name, sort);
    return {
      id,
      compositionId: input.compositionId,
      kind: input.kind,
      name,
      sortOrder: sort,
      muted: false,
      locked: false,
      hidden: false,
    };
  }

  updateTrack(
    id: string,
    patch: Partial<Pick<Track, "name" | "sortOrder" | "muted" | "locked" | "hidden" | "kind">>,
  ): Track | null {
    const row = this.db.prepare(`SELECT * FROM comp_tracks WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const cur = mapTrack(row);
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE comp_tracks SET kind = ?, name = ?, sort_order = ?, muted = ?, locked = ?, hidden = ? WHERE id = ?`,
      )
      .run(
        next.kind,
        next.name,
        next.sortOrder,
        next.muted ? 1 : 0,
        next.locked ? 1 : 0,
        next.hidden ? 1 : 0,
        id,
      );
    return next;
  }

  deleteTrack(id: string): boolean {
    return this.db.prepare(`DELETE FROM comp_tracks WHERE id = ?`).run(id).changes > 0;
  }

  // ── Clips ────────────────────────────────────────────────────────

  listClips(compositionId: string): Clip[] {
    return (
      this.db
        .prepare(`SELECT * FROM comp_clips WHERE composition_id = ? ORDER BY start_sec ASC, z ASC`)
        .all(compositionId) as Record<string, unknown>[]
    ).map(mapClip);
  }

  getClip(id: string): Clip | null {
    const row = this.db.prepare(`SELECT * FROM comp_clips WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapClip(row) : null;
  }

  createClip(input: {
    id?: string;
    compositionId: string;
    trackId: string;
    kind: ClipKind;
    label?: string;
    startSec: number;
    durationSec: number;
    z?: number;
    props?: ClipProps;
  }): Clip {
    const id = input.id || `clip_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO comp_clips (id, composition_id, track_id, kind, label, start_sec, duration_sec, z, props_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.compositionId,
        input.trackId,
        input.kind,
        input.label ?? null,
        input.startSec,
        input.durationSec,
        input.z ?? 0,
        JSON.stringify(input.props ?? {}),
        now,
        now,
      );
    // Touch the parent composition so list ordering reflects active edits.
    this.db
      .prepare(`UPDATE compositions SET updated_at = ? WHERE id = ?`)
      .run(now, input.compositionId);
    return this.getClip(id)!;
  }

  updateClip(
    id: string,
    patch: Partial<
      Pick<Clip, "trackId" | "kind" | "label" | "startSec" | "durationSec" | "z" | "props">
    >,
  ): Clip | null {
    const cur = this.getClip(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE comp_clips SET track_id = ?, kind = ?, label = ?, start_sec = ?, duration_sec = ?, z = ?, props_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.trackId,
        next.kind,
        next.label ?? null,
        next.startSec,
        next.durationSec,
        next.z,
        JSON.stringify(next.props ?? {}),
        next.updatedAt,
        id,
      );
    this.db
      .prepare(`UPDATE compositions SET updated_at = ? WHERE id = ?`)
      .run(next.updatedAt, next.compositionId);
    return next;
  }

  deleteClip(id: string): boolean {
    return this.db.prepare(`DELETE FROM comp_clips WHERE id = ?`).run(id).changes > 0;
  }
}

function defaultTrackName(kind: TrackKind, ordinal: number): string {
  if (kind === "video") return `Video ${ordinal}`;
  if (kind === "audio") return `Audio ${ordinal}`;
  return `Overlay ${ordinal}`;
}

// ── Default seed: ship one demo composition so the editor isn't empty. ─

function seedDefaults(store: CompositionsStore): void {
  if (store.list().length > 0) return;
  const c = store.create({
    name: "Welcome",
    widthPx: 1920,
    heightPx: 1080,
    fps: 30,
    durationSec: 8,
    bgColor: "#050514",
  });
  const bgTrack = store.createTrack({ compositionId: c.id, kind: "video", name: "Background" });
  const overlayTrack = store.createTrack({ compositionId: c.id, kind: "overlay", name: "Title" });

  store.createClip({
    compositionId: c.id,
    trackId: bgTrack.id,
    kind: "shape",
    label: "Gradient",
    startSec: 0,
    durationSec: 8,
    z: 0,
    props: {
      shape: "gradient",
      gradientFrom: "#1b0d3f",
      gradientTo: "#050514",
      gradientAngle: 135,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 1,
    },
  });
  store.createClip({
    compositionId: c.id,
    trackId: overlayTrack.id,
    kind: "text",
    label: "Welcome",
    startSec: 0.5,
    durationSec: 6,
    z: 1,
    props: {
      text: "Welcome to InfiniBot",
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 96,
      fontWeight: 800,
      color: "#d4af37",
      align: "center",
      letterSpacing: -0.02,
      effect: "glow",
      x: 10,
      y: 40,
      width: 80,
      height: 20,
      opacity: 1,
      animateIn: { kind: "fade", durationSec: 0.8, easing: "easeOut" },
      animateOut: { kind: "fade", durationSec: 0.6, easing: "easeIn" },
    },
  });
}
