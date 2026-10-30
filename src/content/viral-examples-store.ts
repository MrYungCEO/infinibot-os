/**
 * ViralExamplesStore — library of transcribed viral-video examples used as
 * style exemplars for script generation. Lives in the same `databases.db`
 * SQLite file as the other content stores so we get free per-user namespacing
 * via resolveStateDir().
 *
 * Retrieval is intentionally simple (keyword/tag overlap + platform match);
 * good enough to feed 2-3 high-signal examples into the LLM prompt without
 * pulling in embeddings infra. Swap in a vector store later behind the same
 * `retrieveBest()` shape if needed.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getDatabasesStore } from "../databases/store.js";
import type { Platform } from "../storyboard/types.js";

export interface ViralExampleEngagement {
  views?: number;
  likes?: number;
  shares?: number;
  comments?: number;
}

export interface ViralExample {
  id: string;
  title: string;
  /** "any" matches every platform during retrieval. */
  platform: Platform | "any";
  sourceUrl?: string;
  /** First 1–3 seconds — the hook. */
  hook: string;
  /** Full transcript text. */
  transcript: string;
  /** Optional beat-by-beat notes the LLM can imitate. */
  structureNotes?: string;
  tags: string[];
  durationSec?: number;
  engagement?: ViralExampleEngagement;
  createdAt: number;
  updatedAt: number;
}

export interface ViralExampleInput {
  id?: string;
  title: string;
  platform?: Platform | "any";
  sourceUrl?: string;
  hook?: string;
  transcript: string;
  structureNotes?: string;
  tags?: string[];
  durationSec?: number;
  engagement?: ViralExampleEngagement;
}

export interface ViralRetrievalOptions {
  topic: string;
  platform?: Platform;
  limit?: number;
}

let _initializedFor: string | null = null;

function resolveStateDir(stateDir?: string): string {
  return stateDir || process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS viral_examples (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'any',
      source_url TEXT,
      hook TEXT NOT NULL DEFAULT '',
      transcript TEXT NOT NULL DEFAULT '',
      structure_notes TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      duration_sec INTEGER,
      engagement_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_viral_examples_platform ON viral_examples(platform);
    CREATE INDEX IF NOT EXISTS idx_viral_examples_updated ON viral_examples(updated_at);
  `);
}

interface Row {
  id: string;
  title: string;
  platform: string;
  source_url: string | null;
  hook: string;
  transcript: string;
  structure_notes: string | null;
  tags_json: string;
  duration_sec: number | null;
  engagement_json: string | null;
  created_at: number;
  updated_at: number;
}

function rowToExample(row: Row): ViralExample {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch {
    /* corrupt row — fall back to empty */
  }
  let engagement: ViralExampleEngagement | undefined;
  if (row.engagement_json) {
    try {
      engagement = JSON.parse(row.engagement_json);
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.id,
    title: row.title,
    platform: (row.platform as Platform | "any") || "any",
    sourceUrl: row.source_url || undefined,
    hook: row.hook,
    transcript: row.transcript,
    structureNotes: row.structure_notes || undefined,
    tags,
    durationSec: row.duration_sec ?? undefined,
    engagement,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tokenize(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/** First sentence (or first 140 chars) — used when hook is not explicitly set. */
function inferHook(transcript: string): string {
  const t = (transcript || "").trim();
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])\s/);
  const candidate = (m ? m[1] : t).trim();
  return candidate.length > 140 ? candidate.slice(0, 137) + "…" : candidate;
}

export class ViralExamplesStore {
  constructor(private readonly db: Database.Database) {}

  list(filter?: { platform?: Platform | "any"; tag?: string }): ViralExample[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.platform) {
      where.push("platform IN (?, 'any')");
      args.push(filter.platform);
    }
    const sql =
      `SELECT * FROM viral_examples` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY updated_at DESC`;
    const rows = this.db.prepare(sql).all(...args) as Row[];
    let out = rows.map(rowToExample);
    if (filter?.tag) {
      const t = filter.tag.toLowerCase();
      out = out.filter((e) => e.tags.some((x) => x.toLowerCase() === t));
    }
    return out;
  }

  get(id: string): ViralExample | null {
    const row = this.db.prepare(`SELECT * FROM viral_examples WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? rowToExample(row) : null;
  }

  upsert(input: ViralExampleInput): ViralExample {
    const now = Date.now();
    const id = input.id || `viral-${randomUUID()}`;
    const transcript = (input.transcript || "").trim();
    if (!transcript) throw new Error("transcript required");
    const hook = (input.hook || inferHook(transcript)).trim();
    const platform = (input.platform || "any") as ViralExample["platform"];
    const tags = Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === "string") : [];
    const existing = this.get(id);
    const createdAt = existing?.createdAt ?? now;
    this.db
      .prepare(
        `INSERT INTO viral_examples
          (id, title, platform, source_url, hook, transcript, structure_notes,
           tags_json, duration_sec, engagement_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           platform=excluded.platform,
           source_url=excluded.source_url,
           hook=excluded.hook,
           transcript=excluded.transcript,
           structure_notes=excluded.structure_notes,
           tags_json=excluded.tags_json,
           duration_sec=excluded.duration_sec,
           engagement_json=excluded.engagement_json,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.title,
        platform,
        input.sourceUrl ?? null,
        hook,
        transcript,
        input.structureNotes ?? null,
        JSON.stringify(tags),
        input.durationSec ?? null,
        input.engagement ? JSON.stringify(input.engagement) : null,
        createdAt,
        now,
      );
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM viral_examples WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /**
   * Cheap keyword overlap retrieval: score = (#topic tokens hitting tags ×3)
   * + (#hitting title ×2) + (#hitting hook). Platform-any rows match every
   * platform; a hard platform mismatch is excluded. Ties broken by recency.
   */
  retrieveBest(opts: ViralRetrievalOptions): ViralExample[] {
    const topic = (opts.topic || "").trim();
    if (!topic) return [];
    const limit = Math.max(1, Math.min(10, opts.limit ?? 3));
    const candidates = this.list(opts.platform ? { platform: opts.platform } : undefined);
    const topicTokens = tokenize(topic);
    if (topicTokens.size === 0) return candidates.slice(0, limit);
    const scored = candidates.map((ex) => {
      const tagTokens = tokenize(ex.tags.join(" "));
      const titleTokens = tokenize(ex.title);
      const hookTokens = tokenize(ex.hook);
      let score = 0;
      for (const t of topicTokens) {
        if (tagTokens.has(t)) score += 3;
        if (titleTokens.has(t)) score += 2;
        if (hookTokens.has(t)) score += 1;
      }
      // Platform-exact preferred over "any".
      if (opts.platform && ex.platform === opts.platform) score += 1;
      return { ex, score };
    });
    scored.sort((a, b) => b.score - a.score || b.ex.updatedAt - a.ex.updatedAt);
    // Drop zero-score matches when we have any positive hits; otherwise allow
    // platform-matched fallbacks so a brand-new library still feeds something.
    const hasHits = scored.some((s) => s.score > 0);
    const filtered = hasHits ? scored.filter((s) => s.score > 0) : scored;
    return filtered.slice(0, limit).map((s) => s.ex);
  }
}

export function getViralExamplesStore(stateDir?: string): ViralExamplesStore {
  const dir = resolveStateDir(stateDir);
  const databases = getDatabasesStore(dir);
  const handle = (databases as unknown as { db?: Database.Database }).db;
  if (!handle) {
    throw new Error("databases store did not expose its sqlite handle");
  }
  if (_initializedFor !== dir) {
    _initializedFor = dir;
    ensureSchema(handle);
  }
  return new ViralExamplesStore(handle);
}

/** Compact shape passed into the script generator prompt. */
export interface ViralExemplar {
  title: string;
  platform: string;
  hook: string;
  excerpt: string;
  structureNotes?: string;
  tags: string[];
}

export function toExemplar(ex: ViralExample, maxExcerptChars = 600): ViralExemplar {
  const transcript = (ex.transcript || "").replace(/\s+/g, " ").trim();
  const excerpt =
    transcript.length > maxExcerptChars
      ? transcript.slice(0, maxExcerptChars - 1) + "…"
      : transcript;
  return {
    title: ex.title,
    platform: ex.platform,
    hook: ex.hook,
    excerpt,
    structureNotes: ex.structureNotes,
    tags: ex.tags,
  };
}
