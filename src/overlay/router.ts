/**
 * Agentic Overlay System — persistence + broadcast router.
 *
 * Overlays piggyback on the existing `proactive_events` SQLite table (the one
 * the pop-up system owns — see {@link file://../proactive/popup-store.ts}).
 * Rather than spin up a new table we tag overlay rows with `kind='overlay'`
 * and stash the full {@link OverlayRecord} blob in the otherwise pop-up-shaped
 * columns. An idempotent migration adds the `kind` column if the DB predates
 * it; the pop-up store filters to `kind='popup'` so the two never cross-read.
 *
 * Every mutation (spawn/update/close + the non-persisted highlight effects)
 * broadcasts on the WS topic `overlay.events` so the `<agent-overlay-layer>`
 * host reconciles live. The broadcaster is wired once at gateway startup via
 * {@link setOverlayBroadcaster}; both the RPC handlers and the MCP `ui_control`
 * ops route through these functions so there is a single broadcast path.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import {
  isExpired,
  validateSpawn,
  validateUpdate,
  type OverlayPosition,
  type OverlayRecord,
  type SpawnInput,
  type UpdateInput,
} from "./registry.js";

const log = createSubsystemLogger("overlay");

/** WS topic the frontend `<agent-overlay-layer>` subscribes to. */
export const OVERLAY_TOPIC = "overlay.events";

/** Broadcast frame shape (spec §3). `focus` is an additive kind. */
export type OverlayBroadcast =
  | { kind: "spawn"; record: OverlayRecord }
  | { kind: "update"; record: OverlayRecord }
  | { kind: "close"; id: string }
  | { kind: "focus"; id: string }
  | {
      kind: "highlight";
      id: string;
      query: string;
      color: string;
      durationMs: number;
      scope?: string;
    }
  | { kind: "clearHighlight"; id?: string };

/* ─── persistence ─────────────────────────────────────────────────────── */

interface OverlayRow {
  id: string;
  body: string;
  created_at: number;
}

/**
 * Body blob stored in the pop-up table's `body` column for overlay rows.
 * Keeps everything the OverlayRecord needs that doesn't map onto a real
 * pop-up column.
 */
interface OverlayBody {
  type: string;
  payload: Record<string, unknown>;
  position: OverlayPosition;
  anchor: string | null;
  ttlMs: number | null;
}

function rowToRecord(r: OverlayRow): OverlayRecord | null {
  let b: OverlayBody;
  try {
    b = JSON.parse(r.body) as OverlayBody;
  } catch {
    return null;
  }
  return {
    overlayId: r.id,
    type: b.type,
    payload: b.payload ?? {},
    position: b.position,
    anchor: b.anchor ?? null,
    createdAt: r.created_at,
    ttlMs: b.ttlMs ?? null,
  };
}

export class OverlayStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    // Same DB file the pop-up store uses — we are reusing its table, not
    // forking a new one.
    this.db = new Database(join(stateDir, "proactive-popups.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.ensureSchema();
  }

  /**
   * Create the shared table if we're the first store to open the DB, then
   * add the `kind` discriminator column if it's an older DB without it. Both
   * steps are idempotent and safe to run from either store.
   */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_events (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        attribution_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_tier TEXT NOT NULL,
        applied_tier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acted_at INTEGER,
        ack_action TEXT,
        dismiss_reason TEXT,
        snooze_until INTEGER,
        voice TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_popup_created ON proactive_events(created_at);
    `);
    const hasKind = (
      this.db.prepare("PRAGMA table_info(proactive_events)").all() as Array<{ name: string }>
    ).some((c) => c.name === "kind");
    if (!hasKind) {
      this.db.exec("ALTER TABLE proactive_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'popup'");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_overlay_kind ON proactive_events(kind, created_at)",
    );
  }

  insert(record: NormalizedRecord): OverlayRecord {
    const body: OverlayBody = {
      type: record.type,
      payload: record.payload,
      position: record.position,
      anchor: record.anchor,
      ttlMs: record.ttlMs,
    };
    // Fill the pop-up NOT NULL columns with overlay-flavoured placeholders.
    this.db
      .prepare(
        `INSERT INTO proactive_events (
          id, kind, tier, title, body, attribution_json, actions_json, dedup_key,
          state, requested_tier, applied_tier, created_at, acted_at,
          ack_action, dismiss_reason, snooze_until, voice
        ) VALUES (?, 'overlay', 'overlay', ?, ?, '{}', '[]', ?, 'active', 'overlay', 'overlay', ?, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(record.overlayId, record.type, JSON.stringify(body), record.overlayId, record.createdAt);
    return this.get(record.overlayId)!;
  }

  get(id: string): OverlayRecord | null {
    const row = this.db
      .prepare(
        "SELECT id, body, created_at FROM proactive_events WHERE id = ? AND kind = 'overlay'",
      )
      .get(id) as OverlayRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  update(
    id: string,
    patch: { payload?: Record<string, unknown>; position?: OverlayPosition },
  ): OverlayRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const body: OverlayBody = {
      type: current.type,
      payload: patch.payload ?? current.payload,
      position: patch.position ?? current.position,
      anchor: current.anchor,
      ttlMs: current.ttlMs,
    };
    this.db
      .prepare("UPDATE proactive_events SET body = ? WHERE id = ? AND kind = 'overlay'")
      .run(JSON.stringify(body), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.db
      .prepare("DELETE FROM proactive_events WHERE id = ? AND kind = 'overlay'")
      .run(id);
    return (res.changes ?? 0) > 0;
  }

  /** All live overlays, newest first. Expired (TTL'd) rows are purged lazily. */
  list(now: number = Date.now()): OverlayRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, body, created_at FROM proactive_events WHERE kind = 'overlay' ORDER BY created_at DESC",
      )
      .all() as OverlayRow[];
    const out: OverlayRecord[] = [];
    const expired: string[] = [];
    for (const r of rows) {
      const rec = rowToRecord(r);
      if (!rec) {
        expired.push(r.id);
        continue;
      }
      if (isExpired(rec, now)) {
        expired.push(rec.overlayId);
        continue;
      }
      out.push(rec);
    }
    if (expired.length) {
      const del = this.db.prepare("DELETE FROM proactive_events WHERE id = ? AND kind = 'overlay'");
      const tx = this.db.transaction((ids: string[]) => ids.forEach((id) => del.run(id)));
      tx(expired);
    }
    return out;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

interface NormalizedRecord {
  overlayId: string;
  type: string;
  payload: Record<string, unknown>;
  position: OverlayPosition;
  anchor: string | null;
  ttlMs: number | null;
  createdAt: number;
}

// ── Singleton ───────────────────────────────────────────────────────────────

let store: OverlayStore | null = null;

export function getOverlayStore(stateDir?: string): OverlayStore {
  if (!store) {
    store = new OverlayStore(stateDir ?? resolveStateDir());
  }
  return store;
}

/** Test/teardown helper. */
export function closeOverlayStore(): void {
  store?.close();
  store = null;
}

/* ─── broadcast ───────────────────────────────────────────────────────── */

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcaster: BroadcastFn | null = null;

/** Wired once at gateway startup (server.impl.ts). */
export function setOverlayBroadcaster(fn: BroadcastFn): void {
  broadcaster = fn;
}

function emit(frame: OverlayBroadcast): void {
  if (!broadcaster) {
    log.warn("overlay broadcast dropped — broadcaster not wired", { kind: frame.kind });
    return;
  }
  broadcaster(OVERLAY_TOPIC, frame);
}

/* ─── high-level operations (shared by RPC + MCP) ─────────────────────── */

export function spawnOverlay(input: SpawnInput, stateDir?: string): OverlayRecord {
  const norm = validateSpawn(input);
  const record: NormalizedRecord = {
    overlayId: randomUUID(),
    type: norm.type,
    payload: norm.payload,
    position: norm.position,
    anchor: norm.anchor,
    ttlMs: norm.ttlMs,
    createdAt: Date.now(),
  };
  const saved = getOverlayStore(stateDir).insert(record);
  emit({ kind: "spawn", record: saved });
  return saved;
}

export function updateOverlay(
  overlayId: string,
  patch: UpdateInput,
  stateDir?: string,
): OverlayRecord | null {
  const norm = validateUpdate(patch);
  const saved = getOverlayStore(stateDir).update(overlayId, norm);
  if (saved) emit({ kind: "update", record: saved });
  return saved;
}

export function closeOverlay(overlayId: string, stateDir?: string): boolean {
  const existed = getOverlayStore(stateDir).delete(overlayId);
  if (existed) emit({ kind: "close", id: overlayId });
  return existed;
}

export function listOverlays(stateDir?: string): OverlayRecord[] {
  return getOverlayStore(stateDir).list();
}

/**
 * Close every live overlay card. Deletes each row and broadcasts a per-row
 * `close` frame so the frontend `<agent-overlay-layer>` reconciles with the
 * existing close-handling path (no new broadcast kind needed). Returns the
 * number of cards actually closed.
 */
export function closeAllOverlays(stateDir?: string): number {
  const open = getOverlayStore(stateDir).list();
  let closed = 0;
  for (const rec of open) {
    if (closeOverlay(rec.overlayId, stateDir)) closed++;
  }
  return closed;
}

export function focusOverlay(overlayId: string, stateDir?: string): boolean {
  const exists = getOverlayStore(stateDir).get(overlayId) != null;
  if (exists) emit({ kind: "focus", id: overlayId });
  return exists;
}

/** Pop-out to a native window is an Electron-only feature; stubbed for v1. */
export function popOutOverlay(overlayId: string): { windowId: string | null } {
  log.warn("popOut requested but native windows are not implemented (Electron-only, v2)", {
    overlayId,
  });
  return { windowId: null };
}

export interface HighlightInput {
  query: string;
  color?: string;
  durationMs?: number;
  scope?: string;
}

/** Transient text highlight — broadcast only, never persisted (spec §3). */
export function highlightText(input: HighlightInput): { id: string } {
  const query = typeof input?.query === "string" ? input.query : "";
  const id = randomUUID();
  emit({
    kind: "highlight",
    id,
    query,
    color: typeof input?.color === "string" && input.color.trim() ? input.color : "#ffd34d",
    durationMs:
      typeof input?.durationMs === "number" && Number.isFinite(input.durationMs)
        ? input.durationMs
        : 4000,
    scope: typeof input?.scope === "string" && input.scope.trim() ? input.scope : undefined,
  });
  return { id };
}

export function clearHighlight(id?: string): void {
  emit({ kind: "clearHighlight", id: id || undefined });
}
