/**
 * content/trends/store — SQLite TTL cache + proactive-alert bookkeeping for the
 * trends intelligence band. Lives at `<stateDir>/content-trends.db`.
 *
 * Two tables:
 *   trends_cache(key, json, generated_at)   — one row per niche-keyed bundle
 *   trends_alert(key, last_alert_at, signature) — proactive cooldown + dedupe
 *
 * Mirrors the singleton-per-path open pattern used by src/research/store.ts.
 * Never throws on a cache miss — callers treat a null as "no cache, fetch fresh".
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import type { TrendsBundle } from "./types.js";

let db: Database.Database | null = null;
let dbDir = "";

function getDb(stateDir: string): Database.Database {
  if (!db || dbDir !== stateDir) {
    const dbPath = resolve(stateDir, "content-trends.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS trends_cache (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trends_alert (
        key TEXT PRIMARY KEY,
        last_alert_at INTEGER NOT NULL,
        signature TEXT NOT NULL
      );
    `);
    dbDir = stateDir;
  }
  return db;
}

/** Read a cached bundle if present and younger than ttlMs. Else null. */
export function readCache(stateDir: string, key: string, ttlMs: number): TrendsBundle | null {
  try {
    const row = getDb(stateDir)
      .prepare("SELECT json, generated_at FROM trends_cache WHERE key = ?")
      .get(key) as { json: string; generated_at: number } | undefined;
    if (!row) return null;
    if (Date.now() - row.generated_at > ttlMs) return null;
    const bundle = JSON.parse(row.json) as TrendsBundle;
    bundle.origin = "cache";
    return bundle;
  } catch {
    return null;
  }
}

/** Persist a freshly-aggregated bundle under key. */
export function writeCache(stateDir: string, key: string, bundle: TrendsBundle): void {
  try {
    getDb(stateDir)
      .prepare(
        "INSERT INTO trends_cache (key, json, generated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET json = excluded.json, generated_at = excluded.generated_at",
      )
      .run(key, JSON.stringify(bundle), bundle.generatedAt);
  } catch {
    /* cache write is best-effort */
  }
}

export interface AlertState {
  lastAlertAt: number;
  signature: string;
}

/** Read the last proactive-alert state for a key (cooldown + dedupe). */
export function readAlertState(stateDir: string, key: string): AlertState | null {
  try {
    const row = getDb(stateDir)
      .prepare("SELECT last_alert_at, signature FROM trends_alert WHERE key = ?")
      .get(key) as { last_alert_at: number; signature: string } | undefined;
    if (!row) return null;
    return { lastAlertAt: row.last_alert_at, signature: row.signature };
  } catch {
    return null;
  }
}

/** Record that an alert fired for key with the given content signature. */
export function writeAlertState(stateDir: string, key: string, signature: string): void {
  try {
    getDb(stateDir)
      .prepare(
        "INSERT INTO trends_alert (key, last_alert_at, signature) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET last_alert_at = excluded.last_alert_at, signature = excluded.signature",
      )
      .run(key, Date.now(), signature);
  } catch {
    /* best-effort */
  }
}
