/**
 * Content Studio pipeline store — the drag-and-drop production board, the
 * per-item rich content pages, the free-form Ideas pages and their media.
 *
 * One SQLite file per tenant under the plugin's data dir
 * (`<stateDir>/plugin-data/content-studio/studio.db`), so Setup › Plugins ›
 * Data can size, export and clear it with everything else the plugin owns.
 *
 * Tables (schema version in PRAGMA user_version, see SCHEMA_STEPS):
 *   cs_stages       board columns (name, colour, WIP limit, position, done flag)
 *   cs_items        content items: stage + dense per-stage position
 *   cs_docs         Block[] document per owner — mirrors kanban's
 *                   task_content_blocks (one JSON row per owner, upserted)
 *   cs_ideas        free-form Ideas pages (their body lives in cs_docs)
 *   cs_media        uploaded / referenced / generated media
 *   cs_media_links  media attached to an item or idea, ordered
 *
 * Positions are dense 0..n-1 integers per stage; every move rewrites the
 * affected stage(s) inside one transaction, so the board never shows gaps or
 * duplicate positions.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type DocOwnerKind = "item" | "idea";

export type PipelineStage = {
  id: string;
  name: string;
  color: string;
  wipLimit: number | null;
  position: number;
  isDone: boolean;
  createdAt: number;
  updatedAt: number;
};

export type PipelineItem = {
  id: string;
  stageId: string;
  title: string;
  summary: string;
  platform: string | null;
  format: string | null;
  tags: string[];
  dueAt: number | null;
  assignee: string | null;
  contentPageId: string | null;
  coverMediaId: string | null;
  position: number;
  stageEnteredAt: number;
  createdAt: number;
  updatedAt: number;
};

export type IdeaPage = {
  id: string;
  title: string;
  icon: string;
  tags: string[];
  pinned: boolean;
  promotedItemId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MediaKind = "image" | "video" | "audio" | "file";
export type MediaSource = "upload" | "url" | "flypic" | "agent";

export type MediaRecord = {
  id: string;
  kind: MediaKind;
  mime: string;
  filename: string;
  size: number;
  source: MediaSource;
  /** Relative file name under the media dir, or null for URL references. */
  file: string | null;
  /** External URL for references; null for stored files. */
  externalUrl: string | null;
  caption: string;
  createdAt: number;
};

export type StoredDoc = { blocks: unknown[]; updatedAt: number };

export const DEFAULT_STAGES: Array<{ name: string; color: string; isDone?: boolean }> = [
  { name: "Idea", color: "#a78bfa" },
  { name: "Script", color: "#60a5fa" },
  { name: "Produce", color: "#f59e0b" },
  { name: "Edit", color: "#f472b6" },
  { name: "Schedule", color: "#34d399" },
  { name: "Published", color: "#caa45a", isDone: true },
];

/** Ordered, idempotent schema steps; index + 1 is the user_version they reach. */
const SCHEMA_STEPS: string[] = [
  `CREATE TABLE IF NOT EXISTS cs_stages (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#caa45a',
     wip_limit INTEGER,
     position INTEGER NOT NULL,
     is_done INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS cs_items (
     id TEXT PRIMARY KEY,
     stage_id TEXT NOT NULL REFERENCES cs_stages(id),
     title TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     platform TEXT,
     format TEXT,
     tags TEXT NOT NULL DEFAULT '[]',
     due_at INTEGER,
     assignee TEXT,
     content_page_id TEXT,
     cover_media_id TEXT,
     position INTEGER NOT NULL,
     stage_entered_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS cs_items_stage ON cs_items(stage_id, position);
   CREATE TABLE IF NOT EXISTS cs_docs (
     owner_kind TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     blocks TEXT NOT NULL DEFAULT '[]',
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (owner_kind, owner_id)
   );
   CREATE TABLE IF NOT EXISTS cs_ideas (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     icon TEXT NOT NULL DEFAULT '',
     tags TEXT NOT NULL DEFAULT '[]',
     pinned INTEGER NOT NULL DEFAULT 0,
     promoted_item_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS cs_media (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     mime TEXT NOT NULL DEFAULT '',
     filename TEXT NOT NULL DEFAULT '',
     size INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL,
     file TEXT,
     external_url TEXT,
     caption TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS cs_media_links (
     media_id TEXT NOT NULL REFERENCES cs_media(id),
     owner_kind TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (media_id, owner_kind, owner_id)
   );
   CREATE INDEX IF NOT EXISTS cs_media_links_owner ON cs_media_links(owner_kind, owner_id, position);`,
  // v2: video posting queue (posting-store.ts) — per-page device/account
  // binding + schedule + caption template, the ordered queue, and history.
  `CREATE TABLE IF NOT EXISTS cs_post_config (
     page_id TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL DEFAULT 0,
     device_id TEXT,
     device_label TEXT,
     bindings TEXT NOT NULL DEFAULT '[]',
     schedule TEXT NOT NULL DEFAULT '{}',
     template TEXT NOT NULL DEFAULT '',
     default_hashtags TEXT NOT NULL DEFAULT '[]',
     cta TEXT NOT NULL DEFAULT '',
     require_approval INTEGER NOT NULL DEFAULT 1,
     dry_run INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS cs_post_queue (
     id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL,
     platform TEXT NOT NULL,
     position INTEGER NOT NULL,
     status TEXT NOT NULL,
     media_id TEXT,
     title TEXT NOT NULL DEFAULT '',
     hook TEXT NOT NULL DEFAULT '',
     series TEXT NOT NULL DEFAULT '',
     episode TEXT NOT NULL DEFAULT '',
     hashtags TEXT NOT NULL DEFAULT '[]',
     caption_override TEXT,
     source_kind TEXT,
     source_id TEXT,
     scheduled_at INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0,
     max_attempts INTEGER NOT NULL DEFAULT 3,
     last_error TEXT,
     approval_id TEXT,
     posted_at INTEGER,
     post_url TEXT,
     post_ref TEXT,
     dry_run INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS cs_post_queue_page ON cs_post_queue(page_id, position);
   CREATE TABLE IF NOT EXISTS cs_post_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     page_id TEXT NOT NULL,
     entry_id TEXT,
     at INTEGER NOT NULL,
     event TEXT NOT NULL,
     status TEXT,
     message TEXT NOT NULL DEFAULT '',
     meta TEXT NOT NULL DEFAULT '{}'
   );
   CREATE INDEX IF NOT EXISTS cs_post_history_page ON cs_post_history(page_id, at);`,
  // v3: Instagram Trial reel flag per queued video (shown to non-followers first).
  `ALTER TABLE cs_post_queue ADD COLUMN trial_reel INTEGER NOT NULL DEFAULT 0;`,
];

export const PIPELINE_SCHEMA_VERSION = SCHEMA_STEPS.length;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const s = typeof t === "string" ? t.trim() : "";
    if (s && !out.includes(s)) out.push(s.slice(0, 40));
  }
  return out.slice(0, 20);
}

function cleanColor(color: unknown, fallback: string): string {
  return typeof color === "string" && /^#[0-9a-f]{3,8}$/i.test(color.trim())
    ? color.trim()
    : fallback;
}

function cleanWip(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : null;
}

function optStr(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function optTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n =
    typeof v === "number"
      ? v
      : v instanceof Date
        ? v.getTime()
        : typeof v === "string"
          ? Date.parse(v)
          : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export class ContentStudioError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

type StageRow = {
  id: string;
  name: string;
  color: string;
  wip_limit: number | null;
  position: number;
  is_done: number;
  created_at: number;
  updated_at: number;
};

type ItemRow = {
  id: string;
  stage_id: string;
  title: string;
  summary: string;
  platform: string | null;
  format: string | null;
  tags: string;
  due_at: number | null;
  assignee: string | null;
  content_page_id: string | null;
  cover_media_id: string | null;
  position: number;
  stage_entered_at: number;
  created_at: number;
  updated_at: number;
};

type IdeaRow = {
  id: string;
  title: string;
  icon: string;
  tags: string;
  pinned: number;
  promoted_item_id: string | null;
  created_at: number;
  updated_at: number;
};

type MediaRow = {
  id: string;
  kind: string;
  mime: string;
  filename: string;
  size: number;
  source: string;
  file: string | null;
  external_url: string | null;
  caption: string;
  created_at: number;
};

const stageOf = (r: StageRow): PipelineStage => ({
  id: r.id,
  name: r.name,
  color: r.color,
  wipLimit: r.wip_limit ?? null,
  position: r.position,
  isDone: r.is_done === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const itemOf = (r: ItemRow): PipelineItem => ({
  id: r.id,
  stageId: r.stage_id,
  title: r.title,
  summary: r.summary,
  platform: r.platform,
  format: r.format,
  tags: cleanTags(parseJsonArray(r.tags)),
  dueAt: r.due_at ?? null,
  assignee: r.assignee,
  contentPageId: r.content_page_id,
  coverMediaId: r.cover_media_id,
  position: r.position,
  stageEnteredAt: r.stage_entered_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const ideaOf = (r: IdeaRow): IdeaPage => ({
  id: r.id,
  title: r.title,
  icon: r.icon,
  tags: cleanTags(parseJsonArray(r.tags)),
  pinned: r.pinned === 1,
  promotedItemId: r.promoted_item_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mediaOf = (r: MediaRow): MediaRecord => ({
  id: r.id,
  kind: r.kind as MediaKind,
  mime: r.mime,
  filename: r.filename,
  size: r.size,
  source: r.source as MediaSource,
  file: r.file,
  externalUrl: r.external_url,
  caption: r.caption,
  createdAt: r.created_at,
});

export class ContentPipelineStore {
  readonly db: Database.Database;

  constructor(
    readonly dbPath: string,
    private readonly now: () => number = Date.now,
  ) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** Applies pending schema steps, then seeds the default stages once. */
  private migrate(): void {
    const version = Number(this.db.pragma("user_version", { simple: true })) || 0;
    for (let v = version; v < SCHEMA_STEPS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(SCHEMA_STEPS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
    if (version === 0) {
      const count = (this.db.prepare("SELECT COUNT(*) AS n FROM cs_stages").get() as { n: number })
        .n;
      if (count === 0) this.resetStagesToDefaults();
    }
  }

  private resetStagesToDefaults(): void {
    const t = this.now();
    const ins = this.db.prepare(
      "INSERT INTO cs_stages (id, name, color, wip_limit, position, is_done, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      DEFAULT_STAGES.forEach((s, i) =>
        ins.run(newId("stg"), s.name, s.color, i, s.isDone ? 1 : 0, t, t),
      );
    })();
  }

  // ── Stages ──────────────────────────────────────────────────────────────

  listStages(): PipelineStage[] {
    return (
      this.db.prepare("SELECT * FROM cs_stages ORDER BY position, created_at").all() as StageRow[]
    ).map(stageOf);
  }

  getStage(id: string): PipelineStage | null {
    const row = this.db.prepare("SELECT * FROM cs_stages WHERE id = ?").get(id) as
      | StageRow
      | undefined;
    return row ? stageOf(row) : null;
  }

  private requireStage(id: unknown): PipelineStage {
    const stage = typeof id === "string" ? this.getStage(id) : null;
    if (!stage) throw new ContentStudioError("NOT_FOUND", `stage not found: ${String(id)}`);
    return stage;
  }

  /** Resolves a stage by id or (case-insensitive) name — agents use names. */
  findStage(ref: string): PipelineStage | null {
    const byId = this.getStage(ref);
    if (byId) return byId;
    const want = ref.trim().toLowerCase();
    return this.listStages().find((s) => s.name.toLowerCase() === want) ?? null;
  }

  createStage(input: {
    name?: unknown;
    color?: unknown;
    wipLimit?: unknown;
    isDone?: unknown;
    index?: unknown;
  }): PipelineStage {
    const name = optStr(input.name, 60);
    if (!name) throw new ContentStudioError("BAD_REQUEST", "stage name required");
    const stages = this.listStages();
    const t = this.now();
    const id = newId("stg");
    const at =
      typeof input.index === "number" && Number.isFinite(input.index)
        ? Math.max(0, Math.min(stages.length, Math.floor(input.index)))
        : stages.length;
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO cs_stages (id, name, color, wip_limit, position, is_done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          name,
          cleanColor(input.color, "#caa45a"),
          cleanWip(input.wipLimit),
          at,
          input.isDone === true ? 1 : 0,
          t,
          t,
        );
      const order = stages.map((s) => s.id);
      order.splice(at, 0, id);
      this.writeStageOrder(order);
    })();
    return this.getStage(id)!;
  }

  updateStage(
    id: unknown,
    patch: { name?: unknown; color?: unknown; wipLimit?: unknown; isDone?: unknown },
  ): PipelineStage {
    const stage = this.requireStage(id);
    const name = patch.name === undefined ? stage.name : optStr(patch.name, 60);
    if (!name) throw new ContentStudioError("BAD_REQUEST", "stage name cannot be empty");
    this.db
      .prepare(
        "UPDATE cs_stages SET name = ?, color = ?, wip_limit = ?, is_done = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        name,
        patch.color === undefined ? stage.color : cleanColor(patch.color, stage.color),
        patch.wipLimit === undefined ? stage.wipLimit : cleanWip(patch.wipLimit),
        patch.isDone === undefined ? (stage.isDone ? 1 : 0) : patch.isDone === true ? 1 : 0,
        this.now(),
        stage.id,
      );
    return this.getStage(stage.id)!;
  }

  /** Full new order of stage ids (must be a permutation of the current set). */
  reorderStages(order: unknown): PipelineStage[] {
    const current = this.listStages().map((s) => s.id);
    if (
      !Array.isArray(order) ||
      order.length !== current.length ||
      new Set(order).size !== order.length ||
      !order.every((id) => current.includes(id as string))
    ) {
      throw new ContentStudioError("BAD_REQUEST", "order must list every stage id exactly once");
    }
    this.db.transaction(() => this.writeStageOrder(order as string[]))();
    return this.listStages();
  }

  private writeStageOrder(order: string[]): void {
    const upd = this.db.prepare("UPDATE cs_stages SET position = ? WHERE id = ?");
    order.forEach((id, i) => upd.run(i, id));
  }

  /**
   * Deletes a stage. A non-empty stage needs `moveItemsTo` (its items are
   * appended there, keeping their order); the last stage can't be deleted.
   */
  deleteStage(id: unknown, moveItemsTo?: unknown): { deleted: string; movedItems: number } {
    const stage = this.requireStage(id);
    const stages = this.listStages();
    if (stages.length <= 1) {
      throw new ContentStudioError("CONFLICT", "a pipeline needs at least one stage");
    }
    const items = this.listItems(stage.id);
    let target: PipelineStage | null = null;
    if (items.length > 0) {
      if (moveItemsTo === undefined || moveItemsTo === null || moveItemsTo === "") {
        throw new ContentStudioError(
          "CONFLICT",
          `stage "${stage.name}" has ${items.length} item(s); pass moveItemsTo`,
        );
      }
      target = this.requireStage(moveItemsTo);
      if (target.id === stage.id) {
        throw new ContentStudioError("BAD_REQUEST", "moveItemsTo must be a different stage");
      }
    }
    this.db.transaction(() => {
      if (target) {
        const base = this.listItems(target.id).length;
        const t = this.now();
        const upd = this.db.prepare(
          "UPDATE cs_items SET stage_id = ?, position = ?, stage_entered_at = ?, updated_at = ? WHERE id = ?",
        );
        items.forEach((it, i) => upd.run(target.id, base + i, t, t, it.id));
      }
      this.db.prepare("DELETE FROM cs_stages WHERE id = ?").run(stage.id);
      this.writeStageOrder(stages.filter((s) => s.id !== stage.id).map((s) => s.id));
    })();
    return { deleted: stage.id, movedItems: target ? items.length : 0 };
  }

  // ── Items ───────────────────────────────────────────────────────────────

  listItems(stageId?: string): PipelineItem[] {
    const rows = stageId
      ? (this.db
          .prepare("SELECT * FROM cs_items WHERE stage_id = ? ORDER BY position, created_at")
          .all(stageId) as ItemRow[])
      : (this.db
          .prepare(
            "SELECT i.* FROM cs_items i JOIN cs_stages s ON s.id = i.stage_id ORDER BY s.position, i.position, i.created_at",
          )
          .all() as ItemRow[]);
    return rows.map(itemOf);
  }

  getItem(id: string): PipelineItem | null {
    const row = this.db.prepare("SELECT * FROM cs_items WHERE id = ?").get(id) as
      | ItemRow
      | undefined;
    return row ? itemOf(row) : null;
  }

  requireItem(id: unknown): PipelineItem {
    const item = typeof id === "string" ? this.getItem(id) : null;
    if (!item) throw new ContentStudioError("NOT_FOUND", `item not found: ${String(id)}`);
    return item;
  }

  createItem(input: {
    title?: unknown;
    stageId?: unknown;
    summary?: unknown;
    platform?: unknown;
    format?: unknown;
    tags?: unknown;
    dueAt?: unknown;
    assignee?: unknown;
    contentPageId?: unknown;
    index?: unknown;
  }): PipelineItem {
    const title = optStr(input.title, 200);
    if (!title) throw new ContentStudioError("BAD_REQUEST", "item title required");
    const stage =
      input.stageId === undefined || input.stageId === null || input.stageId === ""
        ? this.listStages()[0]
        : this.requireStage(input.stageId);
    if (!stage) throw new ContentStudioError("CONFLICT", "pipeline has no stages");
    const id = newId("itm");
    const t = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cs_items (id, stage_id, title, summary, platform, format, tags, due_at, assignee,
             content_page_id, cover_media_id, position, stage_entered_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          stage.id,
          title,
          typeof input.summary === "string" ? input.summary.slice(0, 2000) : "",
          optStr(input.platform, 40),
          optStr(input.format, 40),
          JSON.stringify(cleanTags(input.tags)),
          optTime(input.dueAt),
          optStr(input.assignee, 80),
          optStr(input.contentPageId, 80),
          Number.MAX_SAFE_INTEGER,
          t,
          t,
          t,
        );
      const order = this.listItems(stage.id)
        .map((i) => i.id)
        .filter((x) => x !== id);
      const at =
        typeof input.index === "number" && Number.isFinite(input.index)
          ? Math.max(0, Math.min(order.length, Math.floor(input.index)))
          : order.length;
      order.splice(at, 0, id);
      this.writeItemOrder(order);
    })();
    return this.getItem(id)!;
  }

  updateItem(
    id: unknown,
    patch: {
      title?: unknown;
      summary?: unknown;
      platform?: unknown;
      format?: unknown;
      tags?: unknown;
      dueAt?: unknown;
      assignee?: unknown;
      contentPageId?: unknown;
      coverMediaId?: unknown;
    },
  ): PipelineItem {
    const item = this.requireItem(id);
    const title = patch.title === undefined ? item.title : optStr(patch.title, 200);
    if (!title) throw new ContentStudioError("BAD_REQUEST", "item title cannot be empty");
    let cover = item.coverMediaId;
    if (patch.coverMediaId !== undefined) {
      cover = optStr(patch.coverMediaId, 80);
      if (cover && !this.getMedia(cover)) {
        throw new ContentStudioError("NOT_FOUND", `media not found: ${cover}`);
      }
    }
    const pick = <T>(v: unknown, cur: T, f: (x: unknown) => T): T => (v === undefined ? cur : f(v));
    this.db
      .prepare(
        `UPDATE cs_items SET title = ?, summary = ?, platform = ?, format = ?, tags = ?, due_at = ?,
           assignee = ?, content_page_id = ?, cover_media_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        title,
        pick(patch.summary, item.summary, (v) => (typeof v === "string" ? v.slice(0, 2000) : "")),
        pick(patch.platform, item.platform, (v) => optStr(v, 40)),
        pick(patch.format, item.format, (v) => optStr(v, 40)),
        JSON.stringify(pick(patch.tags, item.tags, cleanTags)),
        pick(patch.dueAt, item.dueAt, optTime),
        pick(patch.assignee, item.assignee, (v) => optStr(v, 80)),
        pick(patch.contentPageId, item.contentPageId, (v) => optStr(v, 80)),
        cover,
        this.now(),
        item.id,
      );
    return this.getItem(item.id)!;
  }

  /**
   * Moves an item to `toStageId` at `toIndex` (0-based, clamped; omitted =
   * end). Same-stage moves reorder; cross-stage moves re-pack both stages and
   * stamp stageEnteredAt.
   */
  moveItem(id: unknown, toStageId: unknown, toIndex?: unknown): PipelineItem {
    const item = this.requireItem(id);
    const target = this.requireStage(toStageId);
    const t = this.now();
    this.db.transaction(() => {
      const crossing = target.id !== item.stageId;
      if (crossing) {
        this.db
          .prepare(
            "UPDATE cs_items SET stage_id = ?, stage_entered_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(target.id, t, t, item.id);
        this.writeItemOrder(
          this.listItems(item.stageId)
            .map((i) => i.id)
            .filter((x) => x !== item.id),
        );
      } else {
        this.db.prepare("UPDATE cs_items SET updated_at = ? WHERE id = ?").run(t, item.id);
      }
      const order = this.listItems(target.id)
        .map((i) => i.id)
        .filter((x) => x !== item.id);
      const at =
        typeof toIndex === "number" && Number.isFinite(toIndex)
          ? Math.max(0, Math.min(order.length, Math.floor(toIndex)))
          : order.length;
      order.splice(at, 0, item.id);
      this.writeItemOrder(order);
    })();
    return this.getItem(item.id)!;
  }

  private writeItemOrder(order: string[]): void {
    const upd = this.db.prepare("UPDATE cs_items SET position = ? WHERE id = ?");
    order.forEach((id, i) => upd.run(i, id));
  }

  deleteItem(id: unknown): { deleted: string } {
    const item = this.requireItem(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM cs_items WHERE id = ?").run(item.id);
      this.db
        .prepare("DELETE FROM cs_docs WHERE owner_kind = 'item' AND owner_id = ?")
        .run(item.id);
      this.db
        .prepare("DELETE FROM cs_media_links WHERE owner_kind = 'item' AND owner_id = ?")
        .run(item.id);
      this.db
        .prepare("UPDATE cs_ideas SET promoted_item_id = NULL WHERE promoted_item_id = ?")
        .run(item.id);
      this.writeItemOrder(this.listItems(item.stageId).map((i) => i.id));
    })();
    return { deleted: item.id };
  }

  // ── Documents (Block[] per owner) ───────────────────────────────────────

  private requireOwner(kind: unknown, id: unknown): { kind: DocOwnerKind; id: string } {
    if (kind === "item") return { kind, id: this.requireItem(id).id };
    if (kind === "idea") return { kind, id: this.requireIdea(id).id };
    throw new ContentStudioError("BAD_REQUEST", 'ownerKind must be "item" or "idea"');
  }

  getDoc(kind: unknown, id: unknown): StoredDoc {
    const owner = this.requireOwner(kind, id);
    const row = this.db
      .prepare("SELECT blocks, updated_at FROM cs_docs WHERE owner_kind = ? AND owner_id = ?")
      .get(owner.kind, owner.id) as { blocks: string; updated_at: number } | undefined;
    if (!row) return { blocks: [], updatedAt: 0 };
    return { blocks: parseJsonArray(row.blocks), updatedAt: row.updated_at };
  }

  saveDoc(kind: unknown, id: unknown, blocks: unknown): { updatedAt: number } {
    const owner = this.requireOwner(kind, id);
    if (!Array.isArray(blocks))
      throw new ContentStudioError("BAD_REQUEST", "blocks array required");
    const t = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cs_docs (owner_kind, owner_id, blocks, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(owner_kind, owner_id) DO UPDATE SET blocks = excluded.blocks, updated_at = excluded.updated_at`,
        )
        .run(owner.kind, owner.id, JSON.stringify(blocks), t);
      const table = owner.kind === "item" ? "cs_items" : "cs_ideas";
      this.db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(t, owner.id);
    })();
    return { updatedAt: t };
  }

  /** Word count and block count per owner, for card badges. */
  docStats(kind: DocOwnerKind): Map<string, { words: number; blocks: number; updatedAt: number }> {
    const out = new Map<string, { words: number; blocks: number; updatedAt: number }>();
    const rows = this.db
      .prepare("SELECT owner_id, blocks, updated_at FROM cs_docs WHERE owner_kind = ?")
      .all(kind) as Array<{ owner_id: string; blocks: string; updated_at: number }>;
    for (const r of rows) {
      const blocks = parseJsonArray(r.blocks) as Array<{ text?: unknown }>;
      let words = 0;
      for (const b of blocks) {
        const text =
          typeof b?.text === "string"
            ? b.text.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")
            : "";
        words += text.split(/\s+/).filter(Boolean).length;
      }
      out.set(r.owner_id, { words, blocks: blocks.length, updatedAt: r.updated_at });
    }
    return out;
  }

  // ── Ideas ───────────────────────────────────────────────────────────────

  listIdeas(): IdeaPage[] {
    return (
      this.db
        .prepare("SELECT * FROM cs_ideas ORDER BY pinned DESC, updated_at DESC")
        .all() as IdeaRow[]
    ).map(ideaOf);
  }

  getIdea(id: string): IdeaPage | null {
    const row = this.db.prepare("SELECT * FROM cs_ideas WHERE id = ?").get(id) as
      | IdeaRow
      | undefined;
    return row ? ideaOf(row) : null;
  }

  requireIdea(id: unknown): IdeaPage {
    const idea = typeof id === "string" ? this.getIdea(id) : null;
    if (!idea) throw new ContentStudioError("NOT_FOUND", `idea not found: ${String(id)}`);
    return idea;
  }

  createIdea(input: {
    title?: unknown;
    icon?: unknown;
    tags?: unknown;
    pinned?: unknown;
  }): IdeaPage {
    const id = newId("ida");
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO cs_ideas (id, title, icon, tags, pinned, promoted_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(
        id,
        optStr(input.title, 200) ?? "Untitled idea",
        optStr(input.icon, 8) ?? "",
        JSON.stringify(cleanTags(input.tags)),
        input.pinned === true ? 1 : 0,
        t,
        t,
      );
    return this.getIdea(id)!;
  }

  updateIdea(
    id: unknown,
    patch: { title?: unknown; icon?: unknown; tags?: unknown; pinned?: unknown },
  ): IdeaPage {
    const idea = this.requireIdea(id);
    this.db
      .prepare(
        "UPDATE cs_ideas SET title = ?, icon = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.title === undefined ? idea.title : (optStr(patch.title, 200) ?? "Untitled idea"),
        patch.icon === undefined ? idea.icon : (optStr(patch.icon, 8) ?? ""),
        JSON.stringify(patch.tags === undefined ? idea.tags : cleanTags(patch.tags)),
        patch.pinned === undefined ? (idea.pinned ? 1 : 0) : patch.pinned === true ? 1 : 0,
        this.now(),
        idea.id,
      );
    return this.getIdea(idea.id)!;
  }

  deleteIdea(id: unknown): { deleted: string } {
    const idea = this.requireIdea(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM cs_ideas WHERE id = ?").run(idea.id);
      this.db
        .prepare("DELETE FROM cs_docs WHERE owner_kind = 'idea' AND owner_id = ?")
        .run(idea.id);
      this.db
        .prepare("DELETE FROM cs_media_links WHERE owner_kind = 'idea' AND owner_id = ?")
        .run(idea.id);
    })();
    return { deleted: idea.id };
  }

  /**
   * Turns an idea into a pipeline item: copies its page and media links onto
   * a new item in `stageId` (default: first stage) and remembers the link.
   */
  promoteIdea(id: unknown, stageId?: unknown): { idea: IdeaPage; item: PipelineItem } {
    const idea = this.requireIdea(id);
    let item!: PipelineItem;
    this.db.transaction(() => {
      item = this.createItem({ title: idea.title, stageId, tags: idea.tags });
      const doc = this.getDoc("idea", idea.id);
      if (doc.blocks.length) this.saveDoc("item", item.id, doc.blocks);
      for (const m of this.listMediaFor("idea", idea.id)) this.linkMedia(m.id, "item", item.id);
      this.db
        .prepare("UPDATE cs_ideas SET promoted_item_id = ?, updated_at = ? WHERE id = ?")
        .run(item.id, this.now(), idea.id);
    })();
    return { idea: this.getIdea(idea.id)!, item: this.getItem(item.id)! };
  }

  // ── Media ───────────────────────────────────────────────────────────────

  insertMedia(input: Omit<MediaRecord, "id" | "createdAt">): MediaRecord {
    const id = newId("med");
    this.db
      .prepare(
        `INSERT INTO cs_media (id, kind, mime, filename, size, source, file, external_url, caption, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.mime,
        input.filename.slice(0, 200),
        input.size,
        input.source,
        input.file,
        input.externalUrl,
        input.caption.slice(0, 500),
        this.now(),
      );
    return this.getMedia(id)!;
  }

  getMedia(id: string): MediaRecord | null {
    const row = this.db.prepare("SELECT * FROM cs_media WHERE id = ?").get(id) as
      | MediaRow
      | undefined;
    return row ? mediaOf(row) : null;
  }

  requireMedia(id: unknown): MediaRecord {
    const m = typeof id === "string" ? this.getMedia(id) : null;
    if (!m) throw new ContentStudioError("NOT_FOUND", `media not found: ${String(id)}`);
    return m;
  }

  listMedia(limit = 200): MediaRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM cs_media ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(1000, limit))) as MediaRow[]
    ).map(mediaOf);
  }

  listMediaFor(kind: unknown, ownerId: unknown): MediaRecord[] {
    const owner = this.requireOwner(kind, ownerId);
    return (
      this.db
        .prepare(
          `SELECT m.* FROM cs_media m JOIN cs_media_links l ON l.media_id = m.id
           WHERE l.owner_kind = ? AND l.owner_id = ? ORDER BY l.position, l.created_at`,
        )
        .all(owner.kind, owner.id) as MediaRow[]
    ).map(mediaOf);
  }

  /** Media counts per owner for card badges. */
  mediaCounts(kind: DocOwnerKind): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT owner_id, COUNT(*) AS n FROM cs_media_links WHERE owner_kind = ? GROUP BY owner_id",
      )
      .all(kind) as Array<{ owner_id: string; n: number }>;
    return new Map(rows.map((r) => [r.owner_id, r.n]));
  }

  linkMedia(mediaId: unknown, kind: unknown, ownerId: unknown): MediaRecord[] {
    const media = this.requireMedia(mediaId);
    const owner = this.requireOwner(kind, ownerId);
    const next = (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cs_media_links WHERE owner_kind = ? AND owner_id = ?",
        )
        .get(owner.kind, owner.id) as { p: number }
    ).p;
    this.db
      .prepare(
        `INSERT INTO cs_media_links (media_id, owner_kind, owner_id, position, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(media_id, owner_kind, owner_id) DO NOTHING`,
      )
      .run(media.id, owner.kind, owner.id, next, this.now());
    // The first image/video attached becomes the item's cover.
    if (owner.kind === "item" && (media.kind === "image" || media.kind === "video")) {
      this.db
        .prepare("UPDATE cs_items SET cover_media_id = ? WHERE id = ? AND cover_media_id IS NULL")
        .run(media.id, owner.id);
    }
    return this.listMediaFor(owner.kind, owner.id);
  }

  unlinkMedia(mediaId: unknown, kind: unknown, ownerId: unknown): MediaRecord[] {
    const owner = this.requireOwner(kind, ownerId);
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM cs_media_links WHERE media_id = ? AND owner_kind = ? AND owner_id = ?",
        )
        .run(mediaId, owner.kind, owner.id);
      if (owner.kind === "item") {
        this.db
          .prepare("UPDATE cs_items SET cover_media_id = NULL WHERE id = ? AND cover_media_id = ?")
          .run(owner.id, mediaId);
      }
    })();
    return this.listMediaFor(owner.kind, owner.id);
  }

  /** Removes the record and every link; returns it so the caller can drop the file. */
  deleteMedia(id: unknown): MediaRecord {
    const media = this.requireMedia(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM cs_media_links WHERE media_id = ?").run(media.id);
      this.db
        .prepare("UPDATE cs_items SET cover_media_id = NULL WHERE cover_media_id = ?")
        .run(media.id);
      this.db.prepare("DELETE FROM cs_media WHERE id = ?").run(media.id);
    })();
    return media;
  }
}
