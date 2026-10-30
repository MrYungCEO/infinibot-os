/**
 * Content Intelligence — SQLite store.
 *
 * Mirrors the pattern in {@link src/queue/store.ts} and
 * {@link src/content/pages-store.ts}: singleton via {@link getContentIntelStore},
 * `resolveStateDir()` for path resolution, `better-sqlite3` with WAL.
 *
 * DB path: `<stateDir>/content-intel.db`
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ReelRow, ReelMetricsRow, TranscriptRow, ScoreRow, RunRow } from "./types.js";

const log = createSubsystemLogger("content-intel-store");

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

let _store: ContentIntelStore | null = null;
let _initializedFor: string | null = null;

/**
 * Get the process-wide {@link ContentIntelStore} singleton.
 *
 * Pass `stateDir` only when bootstrapping from a non-default profile; the
 * first call wins and subsequent calls return the same instance until
 * {@link resetContentIntelStore} is invoked.
 */
export function getContentIntelStore(stateDir?: string): ContentIntelStore {
  const dir = stateDir ?? resolveStateDir();
  if (_store && _initializedFor === dir) return _store;
  if (_store && _initializedFor !== dir) {
    log.info("state dir changed, reinitializing", { from: _initializedFor, to: dir });
    _store.db.close();
    _store = null;
  }
  _initializedFor = dir;
  _store = new ContentIntelStore(dir);
  return _store;
}

/** For testing — closes the DB and drops the singleton. */
export function resetContentIntelStore(): void {
  if (_store) {
    _store.db.close();
    _store = null;
    _initializedFor = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class ContentIntelStore {
  readonly db: Database.Database;

  constructor(stateDir: string) {
    const dir = join(stateDir);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "content-intel.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.applySchema();

    const reelCount = (this.db.prepare("SELECT COUNT(*) AS c FROM reels").get() as { c: number }).c;
    log.info("content-intel store loaded", { reels: reelCount });
  }

  // ── Schema ──────────────────────────────────────────────────────

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reels (
        shortcode      TEXT PRIMARY KEY,
        url            TEXT NOT NULL,
        post_id        TEXT NOT NULL,
        publish_time   TEXT,
        duration_sec   INTEGER,
        account        TEXT,
        description    TEXT,
        has_video      INTEGER NOT NULL DEFAULT 0,
        has_transcript INTEGER NOT NULL DEFAULT 0,
        has_score      INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reel_metrics (
        shortcode    TEXT NOT NULL,
        views        INTEGER,
        reach        INTEGER,
        likes        INTEGER,
        shares       INTEGER,
        follows      INTEGER,
        comments     INTEGER,
        saves        INTEGER,
        captured_at  INTEGER NOT NULL,
        FOREIGN KEY (shortcode) REFERENCES reels(shortcode) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_reel_metrics_shortcode
        ON reel_metrics(shortcode);
      CREATE INDEX IF NOT EXISTS idx_reel_metrics_captured
        ON reel_metrics(captured_at);

      CREATE TABLE IF NOT EXISTS transcripts (
        shortcode   TEXT PRIMARY KEY,
        text        TEXT NOT NULL,
        engine      TEXT NOT NULL,
        lang        TEXT,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY (shortcode) REFERENCES reels(shortcode) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS scores (
        shortcode        TEXT PRIMARY KEY,
        hook             REAL,
        value            REAL,
        viral            REAL,
        overall          REAL,
        tier             TEXT NOT NULL,
        reason           TEXT,
        idea_vs_execution TEXT,
        scored_by        TEXT,
        model            TEXT,
        created_at       INTEGER NOT NULL,
        FOREIGN KEY (shortcode) REFERENCES reels(shortcode) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_scores_tier ON scores(tier);

      CREATE TABLE IF NOT EXISTS runs (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        status       TEXT NOT NULL,
        details      TEXT,
        reel_count   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_runs_kind ON runs(kind);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);

      CREATE TABLE IF NOT EXISTS youtube_channels (
        channel_id        TEXT PRIMARY KEY,
        name              TEXT,
        handle            TEXT,
        subscriber_count  INTEGER,
        video_count        INTEGER,
        thumbnail_url     TEXT,
        captured_at       INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS youtube_videos (
        video_id        TEXT PRIMARY KEY,
        channel_id      TEXT NOT NULL,
        title           TEXT,
        description     TEXT,
        published_at    TEXT,
        duration_sec    INTEGER,
        thumbnail_url   TEXT,
        views           INTEGER,
        likes           INTEGER,
        comments        INTEGER,
        has_transcript  INTEGER NOT NULL DEFAULT 0,
        has_score       INTEGER NOT NULL DEFAULT 0,
        captured_at    INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES youtube_channels(channel_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_yt_videos_channel ON youtube_videos(channel_id);
      CREATE INDEX IF NOT EXISTS idx_yt_videos_published ON youtube_videos(published_at);
    `);
  }

  // ── Reels ───────────────────────────────────────────────────────

  /** Insert or update a reel. Returns `true` if a new row was inserted. */
  upsertReel(row: ReelRow): boolean {
    const existing = this.db
      .prepare("SELECT shortcode FROM reels WHERE shortcode = ?")
      .get(row.shortcode) as { shortcode: string } | undefined;
    const wasNew = !existing;

    this.db
      .prepare(`
        INSERT INTO reels (shortcode, url, post_id, publish_time, duration_sec, account, description, has_video, has_transcript, has_score, created_at, updated_at)
        VALUES (@shortcode, @url, @post_id, @publish_time, @duration_sec, @account, @description, @has_video, @has_transcript, @has_score, @created_at, @updated_at)
        ON CONFLICT(shortcode) DO UPDATE SET
          url            = excluded.url,
          post_id        = excluded.post_id,
          publish_time   = excluded.publish_time,
          duration_sec   = excluded.duration_sec,
          account        = excluded.account,
          description    = excluded.description,
          has_video      = CASE WHEN excluded.has_video > 0 THEN 1 ELSE reels.has_video END,
          has_transcript = CASE WHEN excluded.has_transcript > 0 THEN 1 ELSE reels.has_transcript END,
          has_score      = CASE WHEN excluded.has_score > 0 THEN 1 ELSE reels.has_score END,
          updated_at     = excluded.updated_at
      `)
      .run(row);
    return wasNew;
  }

  getReel(shortcode: string): ReelRow | undefined {
    return this.db.prepare("SELECT * FROM reels WHERE shortcode = ?").get(shortcode) as
      | ReelRow
      | undefined;
  }

  listReels(limit = 500, offset = 0): ReelRow[] {
    return this.db
      .prepare("SELECT * FROM reels ORDER BY publish_time DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as ReelRow[];
  }

  countReels(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM reels").get() as { c: number }).c;
  }

  /** Update the has_video flag for a reel. */
  setHasVideo(shortcode: string, value: boolean): void {
    this.db
      .prepare("UPDATE reels SET has_video = ?, updated_at = ? WHERE shortcode = ?")
      .run(value ? 1 : 0, Date.now(), shortcode);
  }

  /** Update the has_transcript flag for a reel. */
  setHasTranscript(shortcode: string, value: boolean): void {
    this.db
      .prepare("UPDATE reels SET has_transcript = ?, updated_at = ? WHERE shortcode = ?")
      .run(value ? 1 : 0, Date.now(), shortcode);
  }

  /** Update the has_score flag for a reel. */
  setHasScore(shortcode: string, value: boolean): void {
    this.db
      .prepare("UPDATE reels SET has_score = ?, updated_at = ? WHERE shortcode = ?")
      .run(value ? 1 : 0, Date.now(), shortcode);
  }

  /** Get reels that still need a video download. */
  listReelsMissingVideo(limit = 500): ReelRow[] {
    return this.db
      .prepare("SELECT * FROM reels WHERE has_video = 0 ORDER BY publish_time DESC LIMIT ?")
      .all(limit) as ReelRow[];
  }

  /** Get reels that have video but no transcript. */
  listReelsMissingTranscript(limit = 500): ReelRow[] {
    return this.db
      .prepare(
        "SELECT * FROM reels WHERE has_video = 1 AND has_transcript = 0 ORDER BY publish_time DESC LIMIT ?",
      )
      .all(limit) as ReelRow[];
  }

  /** Get reels that have transcript but no score. */
  listReelsMissingScore(limit = 500): ReelRow[] {
    return this.db
      .prepare(
        "SELECT * FROM reels WHERE has_transcript = 1 AND has_score = 0 ORDER BY publish_time DESC LIMIT ?",
      )
      .all(limit) as ReelRow[];
  }

  /** Count reels by state flags. */
  countByState(): { total: number; hasVideo: number; hasTranscript: number; hasScore: number } {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(has_video) AS hasVideo,
          SUM(has_transcript) AS hasTranscript,
          SUM(has_score) AS hasScore
        FROM reels
      `)
      .get() as { total: number; hasVideo: number; hasTranscript: number; hasScore: number };
    return {
      total: row.total ?? 0,
      hasVideo: row.hasVideo ?? 0,
      hasTranscript: row.hasTranscript ?? 0,
      hasScore: row.hasScore ?? 0,
    };
  }

  // ── Metrics ─────────────────────────────────────────────────────

  insertMetrics(row: ReelMetricsRow): void {
    this.db
      .prepare(`
        INSERT INTO reel_metrics (shortcode, views, reach, likes, shares, follows, comments, saves, captured_at)
        VALUES (@shortcode, @views, @reach, @likes, @shares, @follows, @comments, @saves, @captured_at)
      `)
      .run(row);
  }

  getLatestMetrics(shortcode: string): ReelMetricsRow | undefined {
    return this.db
      .prepare(`
        SELECT * FROM reel_metrics
        WHERE shortcode = ?
        ORDER BY captured_at DESC
        LIMIT 1
      `)
      .get(shortcode) as ReelMetricsRow | undefined;
  }

  getAllMetrics(shortcode: string): ReelMetricsRow[] {
    return this.db
      .prepare(`
        SELECT * FROM reel_metrics
        WHERE shortcode = ?
        ORDER BY captured_at ASC
      `)
      .all(shortcode) as ReelMetricsRow[];
  }

  // ── Transcripts ─────────────────────────────────────────────────

  upsertTranscript(row: TranscriptRow): boolean {
    const existing = this.db
      .prepare("SELECT shortcode FROM transcripts WHERE shortcode = ?")
      .get(row.shortcode) as { shortcode: string } | undefined;
    const wasNew = !existing;

    this.db
      .prepare(`
        INSERT INTO transcripts (shortcode, text, engine, lang, created_at)
        VALUES (@shortcode, @text, @engine, @lang, @created_at)
        ON CONFLICT(shortcode) DO UPDATE SET
          text       = excluded.text,
          engine     = excluded.engine,
          lang       = excluded.lang,
          created_at = excluded.created_at
      `)
      .run(row);
    return wasNew;
  }

  getTranscript(shortcode: string): TranscriptRow | undefined {
    return this.db.prepare("SELECT * FROM transcripts WHERE shortcode = ?").get(shortcode) as
      | TranscriptRow
      | undefined;
  }

  // ── Scores ──────────────────────────────────────────────────────

  upsertScore(row: ScoreRow): boolean {
    const existing = this.db
      .prepare("SELECT shortcode FROM scores WHERE shortcode = ?")
      .get(row.shortcode) as { shortcode: string } | undefined;
    const wasNew = !existing;

    this.db
      .prepare(`
        INSERT INTO scores (shortcode, hook, value, viral, overall, tier, reason, idea_vs_execution, scored_by, model, created_at)
        VALUES (@shortcode, @hook, @value, @viral, @overall, @tier, @reason, @idea_vs_execution, @scored_by, @model, @created_at)
        ON CONFLICT(shortcode) DO UPDATE SET
          hook              = excluded.hook,
          value             = excluded.value,
          viral             = excluded.viral,
          overall           = excluded.overall,
          tier              = excluded.tier,
          reason            = excluded.reason,
          idea_vs_execution = excluded.idea_vs_execution,
          scored_by         = excluded.scored_by,
          model             = excluded.model,
          created_at        = excluded.created_at
      `)
      .run(row);
    return wasNew;
  }

  getScore(shortcode: string): ScoreRow | undefined {
    return this.db.prepare("SELECT * FROM scores WHERE shortcode = ?").get(shortcode) as
      | ScoreRow
      | undefined;
  }

  // ── Runs ────────────────────────────────────────────────────────

  insertRun(row: RunRow): void {
    this.db
      .prepare(`
        INSERT INTO runs (id, kind, started_at, finished_at, status, details, reel_count)
        VALUES (@id, @kind, @started_at, @finished_at, @status, @details, @reel_count)
      `)
      .run(row);
  }

  updateRun(
    id: string,
    patch: Partial<Pick<RunRow, "finished_at" | "status" | "details" | "reel_count">>,
  ): void {
    const sets: string[] = [];
    const vals: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) {
        sets.push(`${k} = @${k}`);
        vals[k] = v;
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  }

  // ── Convenience ──────────────────────────────────────────────────

  /**
   * Returns the latest metrics for every reel, joined with the reel row.
   * Useful for dashboards / analytics.
   */
  listReelsWithMetrics(limit = 500): Array<ReelRow & Partial<ReelMetricsRow>> {
    const rows = this.db
      .prepare(`
        SELECT r.*, m.views, m.reach, m.likes, m.shares, m.follows, m.comments, m.saves, m.captured_at
        FROM reels r
        LEFT JOIN reel_metrics m ON m.shortcode = r.shortcode
          AND m.captured_at = (
            SELECT MAX(captured_at) FROM reel_metrics WHERE shortcode = r.shortcode
          )
        ORDER BY r.publish_time DESC
        LIMIT ?
      `)
      .all(limit) as Array<ReelRow & Partial<ReelMetricsRow>>;
    return rows;
  }

  close(): void {
    this.db.close();
  }

  // ── Accounts ────────────────────────────────────────────────────

  /** List all distinct account usernames from the reels table. */
  listAccounts(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT account FROM reels WHERE account IS NOT NULL AND account != '' ORDER BY account",
      )
      .all() as { account: string }[];
    return rows.map((r) => r.account);
  }

  /** Count reels grouped by account. */
  countByAccount(): Array<{ account: string; count: number; scored: number; transcribed: number }> {
    return this.db
      .prepare(`
        SELECT
          account,
          COUNT(*) AS count,
          SUM(has_score) AS scored,
          SUM(has_transcript) AS transcribed
        FROM reels
        WHERE account IS NOT NULL AND account != ''
        GROUP BY account
        ORDER BY account
      `)
      .all() as Array<{ account: string; count: number; scored: number; transcribed: number }>;
  }

  /** Count ALL reels without a score (regardless of transcript status). */
  countUnscoredTotal(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM reels WHERE has_score = 0").get() as { c: number }
    ).c;
  }

  // ── YouTube ────────────────────────────────────────────────────

  upsertYoutubeChannel(row: YoutubeChannelRow): void {
    this.db
      .prepare(`
        INSERT INTO youtube_channels (channel_id, name, handle, subscriber_count, video_count, thumbnail_url, captured_at, updated_at)
        VALUES (@channel_id, @name, @handle, @subscriber_count, @video_count, @thumbnail_url, @captured_at, @updated_at)
        ON CONFLICT(channel_id) DO UPDATE SET
          name = excluded.name,
          handle = excluded.handle,
          subscriber_count = excluded.subscriber_count,
          video_count = excluded.video_count,
          thumbnail_url = excluded.thumbnail_url,
          updated_at = excluded.updated_at
      `)
      .run(row);
  }

  listYoutubeChannels(): YoutubeChannelRow[] {
    return this.db
      .prepare("SELECT * FROM youtube_channels ORDER BY name")
      .all() as YoutubeChannelRow[];
  }

  upsertYoutubeVideo(row: YoutubeVideoRow): void {
    this.db
      .prepare(`
        INSERT INTO youtube_videos (video_id, channel_id, title, description, published_at, duration_sec, thumbnail_url, views, likes, comments, has_transcript, has_score, captured_at, updated_at)
        VALUES (@video_id, @channel_id, @title, @description, @published_at, @duration_sec, @thumbnail_url, @views, @likes, @comments, @has_transcript, @has_score, @captured_at, @updated_at)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          published_at = excluded.published_at,
          duration_sec = excluded.duration_sec,
          thumbnail_url = excluded.thumbnail_url,
          views = excluded.views,
          likes = excluded.likes,
          comments = excluded.comments,
          updated_at = excluded.updated_at
      `)
      .run(row);
  }

  listYoutubeVideos(channelId?: string, limit = 500): YoutubeVideoRow[] {
    if (channelId) {
      return this.db
        .prepare(
          "SELECT * FROM youtube_videos WHERE channel_id = ? ORDER BY published_at DESC LIMIT ?",
        )
        .all(channelId, limit) as YoutubeVideoRow[];
    }
    return this.db
      .prepare("SELECT * FROM youtube_videos ORDER BY published_at DESC LIMIT ?")
      .all(limit) as YoutubeVideoRow[];
  }

  countYoutubeVideos(channelId?: string): number {
    if (channelId) {
      return (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM youtube_videos WHERE channel_id = ?")
          .get(channelId) as { c: number }
      ).c;
    }
    return (this.db.prepare("SELECT COUNT(*) AS c FROM youtube_videos").get() as { c: number }).c;
  }
}

export interface YoutubeChannelRow {
  channel_id: string;
  name: string;
  handle: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  thumbnail_url: string | null;
  captured_at: number;
  updated_at: number;
}

export interface YoutubeVideoRow {
  video_id: string;
  channel_id: string;
  title: string | null;
  description: string | null;
  published_at: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  has_transcript: number;
  has_score: number;
  captured_at: number;
  updated_at: number;
}
