/**
 * Proactive Pop-Up System — SQLite persistence.
 *
 * One table, `proactive_events`, ring-buffered by a 30-day TTL purge that runs
 * lazily on store construction and after each insert. Mirrors the
 * achievements / ssh-devices SQLite store pattern (process-wide singleton via
 * {@link getPopupStore}, state-dir scoped for multi-user namespacing).
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  PopupAction,
  PopupAttribution,
  PopupEvent,
  PopupLink,
  PopupMedia,
  PopupState,
  PopupTier,
} from "./popup-types.js";

const log = createSubsystemLogger("proactive-popup");

/** Events older than this (by created_at) are purged. */
export const POPUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface PopupRow {
  id: string;
  tier: string;
  title: string;
  body: string;
  attribution_json: string;
  actions_json: string;
  dedup_key: string;
  state: string;
  requested_tier: string;
  applied_tier: string;
  created_at: number;
  acted_at: number | null;
  ack_action: string | null;
  dismiss_reason: string | null;
  snooze_until: number | null;
  voice: string | null;
  media_json: string | null;
  pinned: number | null;
  link_json?: string | null;
}

export interface ListPopupOpts {
  since?: number;
  limit?: number;
  tier?: PopupTier;
  state?: PopupState;
}

function rowToEvent(r: PopupRow): PopupEvent {
  let attribution: PopupAttribution = { agentId: "unknown" };
  let actions: PopupAction[] = [];
  let media: PopupMedia | null = null;
  try {
    attribution = JSON.parse(r.attribution_json) as PopupAttribution;
  } catch {
    /* keep fallback */
  }
  try {
    const parsed = JSON.parse(r.actions_json);
    if (Array.isArray(parsed)) actions = parsed as PopupAction[];
  } catch {
    /* keep [] */
  }
  let link: PopupLink | null = null;
  if (r.link_json) {
    try {
      const parsed = JSON.parse(r.link_json);
      if (parsed && typeof parsed.deepLink === "string") link = parsed as PopupLink;
    } catch {
      /* keep null */
    }
  }
  if (r.media_json) {
    try {
      const parsed = JSON.parse(r.media_json);
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string")
        media = parsed as PopupMedia;
    } catch {
      /* keep null */
    }
  }
  return {
    id: r.id,
    tier: r.applied_tier as PopupTier,
    requestedTier: r.requested_tier as PopupTier,
    appliedTier: r.applied_tier as PopupTier,
    title: r.title,
    body: r.body,
    attribution,
    actions,
    dedupKey: r.dedup_key,
    state: r.state as PopupState,
    createdAt: r.created_at,
    actedAt: r.acted_at,
    ackAction: r.ack_action,
    dismissReason: r.dismiss_reason,
    snoozeUntil: r.snooze_until,
    voice: r.voice,
    media,
    pinned: !!r.pinned,
    ...(link ? { link } : {}),
  };
}

export interface InsertPopupInput {
  title: string;
  body: string;
  attribution: PopupAttribution;
  actions: PopupAction[];
  dedupKey: string;
  requestedTier: PopupTier;
  appliedTier: PopupTier;
  voice?: string | null;
  media?: PopupMedia | null;
  link?: PopupLink | null;
  createdAt?: number;
}

export class PopupStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "proactive-popups.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
    this.purgeExpired();

    const count = (
      this.db.prepare("SELECT COUNT(*) AS c FROM proactive_events").get() as { c: number }
    ).c;
    log.info("Pop-up store loaded", { events: count });
  }

  private createTables(): void {
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
        voice TEXT,
        media_json TEXT,
        pinned INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_popup_created ON proactive_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_popup_dedup ON proactive_events(dedup_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_popup_state ON proactive_events(state);
    `);
    // The agentic overlay system (src/overlay) shares this table, tagging its
    // rows with kind='overlay'. Add the discriminator column if it's missing
    // (older DBs) so pop-up reads can exclude overlay rows. Idempotent — the
    // overlay store runs the same migration; whichever opens first wins.
    const columns = (
      this.db.prepare("PRAGMA table_info(proactive_events)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!columns.includes("kind")) {
      this.db.exec("ALTER TABLE proactive_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'popup'");
    }
    // Deep link + web opener (docs/mobile/DEEP-LINKS.md). Nullable, idempotent.
    if (!columns.includes("link_json")) {
      this.db.exec("ALTER TABLE proactive_events ADD COLUMN link_json TEXT");
    }
  }

  /** Ring-buffer: drop events past the TTL. Returns rows removed. */
  purgeExpired(now: number = Date.now()): number {
    const cutoff = now - POPUP_TTL_MS;
    const res = this.db
      .prepare("DELETE FROM proactive_events WHERE created_at < ? AND kind = 'popup'")
      .run(cutoff);
    return res.changes ?? 0;
  }

  insert(input: InsertPopupInput): PopupEvent {
    const id = randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO proactive_events (
          id, tier, title, body, attribution_json, actions_json, dedup_key,
          state, requested_tier, applied_tier, created_at, acted_at,
          ack_action, dismiss_reason, snooze_until, voice, media_json, pinned, link_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, ?)`,
      )
      .run(
        id,
        input.appliedTier,
        input.title,
        input.body,
        JSON.stringify(input.attribution),
        JSON.stringify(input.actions ?? []),
        input.dedupKey,
        input.requestedTier,
        input.appliedTier,
        createdAt,
        input.voice ?? null,
        input.media ? JSON.stringify(input.media) : null,
        input.link ? JSON.stringify(input.link) : null,
      );
    this.purgeExpired(createdAt);
    return this.get(id)!;
  }

  get(id: string): PopupEvent | null {
    const row = this.db.prepare("SELECT * FROM proactive_events WHERE id = ?").get(id) as
      | PopupRow
      | undefined;
    return row ? rowToEvent(row) : null;
  }

  list(opts: ListPopupOpts = {}): PopupEvent[] {
    const clauses: string[] = ["kind = 'popup'"];
    const args: unknown[] = [];
    if (typeof opts.since === "number") {
      clauses.push("created_at >= ?");
      args.push(opts.since);
    }
    if (opts.tier) {
      clauses.push("applied_tier = ?");
      args.push(opts.tier);
    }
    if (opts.state) {
      clauses.push("state = ?");
      args.push(opts.state);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM proactive_events ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit) as PopupRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Prior emits with the same dedupKey within `windowMs` before `now`.
   * Used by the router to decide cooldown downgrades.
   */
  countInWindow(dedupKey: string, windowMs: number, now: number = Date.now()): number {
    const since = now - windowMs;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM proactive_events WHERE dedup_key = ? AND created_at >= ? AND kind = 'popup'",
      )
      .get(dedupKey, since) as { c: number };
    return row.c;
  }

  ack(id: string, action: string, now: number = Date.now()): PopupEvent | null {
    this.db
      .prepare(
        "UPDATE proactive_events SET state = 'acted', acted_at = ?, ack_action = ? WHERE id = ?",
      )
      .run(now, action, id);
    return this.get(id);
  }

  snooze(id: string, until: number, now: number = Date.now()): PopupEvent | null {
    this.db
      .prepare(
        "UPDATE proactive_events SET state = 'snoozed', acted_at = ?, snooze_until = ? WHERE id = ?",
      )
      .run(now, until, id);
    return this.get(id);
  }

  dismiss(id: string, reason: string, now: number = Date.now()): PopupEvent | null {
    this.db
      .prepare(
        "UPDATE proactive_events SET state = 'dismissed', acted_at = ?, dismiss_reason = ? WHERE id = ?",
      )
      .run(now, reason, id);
    return this.get(id);
  }

  /** Pin / unpin an event so the overlay holds it on screen. Pure flag toggle —
   *  does not change the lifecycle `state`. */
  setPinned(id: string, pinned: boolean): PopupEvent | null {
    this.db.prepare("UPDATE proactive_events SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
    return this.get(id);
  }

  /** Replace an event's media payload (e.g. completion overlay chip refresh
   *  after a Build / Commit & Push action). Pure — does not touch lifecycle. */
  setMedia(id: string, media: unknown): PopupEvent | null {
    this.db
      .prepare("UPDATE proactive_events SET media_json = ? WHERE id = ?")
      .run(media == null ? null : JSON.stringify(media), id);
    return this.get(id);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let singleton: PopupStore | null = null;

export function getPopupStore(stateDir?: string): PopupStore {
  if (!singleton) {
    singleton = new PopupStore(stateDir ?? resolveStateDir());
  }
  return singleton;
}

/** Test/teardown helper. */
export function closePopupStore(): void {
  singleton?.close();
  singleton = null;
}
