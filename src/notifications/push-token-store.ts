import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { STATE_DIR } from "../config/paths.js";

export interface PushToken {
  id: string;
  token: string;
  platform: "ios" | "android" | "web";
  account_id: string;
  device_label: string;
  created_at: number;
  last_seen_at: number;
  invalid_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_tokens (
  id           TEXT    PRIMARY KEY,
  token        TEXT    UNIQUE NOT NULL,
  platform     TEXT    NOT NULL DEFAULT 'ios',
  account_id   TEXT    NOT NULL DEFAULT '',
  device_label TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  invalid_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_invalid ON push_tokens(invalid_at);
`;

let _db: Database.Database | null = null;
let _stateDir: string | null = null;

export function getPushTokenStore(stateDir?: string): PushTokenStore {
  // Default to the canonical STATE_DIR (~/.infinibot) so this store and the
  // notification history store agree on a path. Earlier the fallback was a
  // bare "state" string, which resolved to <cwd>/state and diverged from
  // history-store.ts (which uses STATE_DIR). That split-brain caused
  // emitNotification to write history at one path while readers looked at
  // another, and the Alerts page came up empty.
  const dir = stateDir ?? STATE_DIR;
  if (!_db || _stateDir !== dir) {
    _stateDir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(resolve(dir, "push_tokens.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(SCHEMA);
    _db = db;
  }
  return new PushTokenStore(_db);
}

export class PushTokenStore {
  constructor(private readonly db: Database.Database) {}

  upsert(token: string, platform: string, deviceLabel: string, accountId = ""): PushToken {
    const now = Date.now();
    const existing = this.db.prepare("SELECT * FROM push_tokens WHERE token = ?").get(token) as
      | PushToken
      | undefined;

    if (existing) {
      this.db
        .prepare(
          "UPDATE push_tokens SET platform = ?, device_label = ?, last_seen_at = ?, invalid_at = NULL WHERE token = ?",
        )
        .run(platform, deviceLabel, now, token);
      return {
        ...existing,
        platform: platform as PushToken["platform"],
        device_label: deviceLabel,
        last_seen_at: now,
        invalid_at: null,
      };
    }

    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO push_tokens (id, token, platform, account_id, device_label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, token, platform, accountId, deviceLabel, now, now);
    return {
      id,
      token,
      platform: platform as PushToken["platform"],
      account_id: accountId,
      device_label: deviceLabel,
      created_at: now,
      last_seen_at: now,
      invalid_at: null,
    };
  }

  listValid(): PushToken[] {
    return this.db
      .prepare("SELECT * FROM push_tokens WHERE invalid_at IS NULL ORDER BY last_seen_at DESC")
      .all() as PushToken[];
  }

  list(): PushToken[] {
    return this.db
      .prepare("SELECT * FROM push_tokens ORDER BY last_seen_at DESC")
      .all() as PushToken[];
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM push_tokens WHERE id = ?").run(id);
  }

  markInvalid(token: string): void {
    this.db.prepare("UPDATE push_tokens SET invalid_at = ? WHERE token = ?").run(Date.now(), token);
  }
}
