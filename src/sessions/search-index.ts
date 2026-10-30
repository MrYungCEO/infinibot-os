/**
 * Cross-session full-text search index.
 *
 * Mirrors every text block found in `<state>/agents/<id>/sessions/<sid>.jsonl`
 * into a SQLite FTS5 table at `<state>/sessions-search.sqlite`. Indexing is
 * incremental — we track each JSONL file's last byte offset in `session_files`
 * and only ingest the tail on subsequent passes, so a re-index of a 200-MB
 * session corpus is sub-second after the first build.
 *
 * Exposed via the gateway `sessions.search` RPC. The store is owned by the
 * gateway process; callers should not open the SQLite file from elsewhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sessions/search");

export interface SessionSearchHit {
  agentId: string;
  sessionId: string;
  messageId: string | null;
  role: string;
  timestamp: string;
  snippet: string;
}

export interface SessionSearchResult {
  query: string;
  total: number;
  hits: SessionSearchHit[];
  /** Filled when the FTS5 query string was invalid — caller can show it. */
  warning?: string;
}

let dbHandle: DatabaseSync | null = null;
let ftsAvailable = false;

function dbPath(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): string {
  return path.join(resolveStateDir(env, homedir), "sessions-search.sqlite");
}

function openDb(): DatabaseSync | null {
  if (dbHandle) return dbHandle;
  try {
    const file = dbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_files (
        path TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        last_offset INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_session_files_agent ON session_files(agent_id);`);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text,
          agent_id UNINDEXED,
          session_id UNINDEXED,
          message_id UNINDEXED,
          role UNINDEXED,
          timestamp UNINDEXED,
          tokenize='porter unicode61'
        );
      `);
      ftsAvailable = true;
    } catch (err) {
      log.warn(`FTS5 unavailable, search disabled: ${(err as Error).message}`);
      ftsAvailable = false;
    }
    dbHandle = db;
    return db;
  } catch (err) {
    log.warn(`could not open search index: ${(err as Error).message}`);
    return null;
  }
}

/** Result tuple from one ingest pass — used for logging/observability. */
export interface IngestStats {
  filesScanned: number;
  filesUpdated: number;
  messagesIndexed: number;
  errors: number;
}

/**
 * Scan all session JSONL files for the given agent (or every agent dir under
 * `<state>/agents/*` when `agentId` is omitted) and ingest any bytes the
 * index hasn't seen yet. Safe to call on a timer.
 */
export function ingestSessions(opts?: { agentId?: string }): IngestStats {
  const db = openDb();
  const stats: IngestStats = { filesScanned: 0, filesUpdated: 0, messagesIndexed: 0, errors: 0 };
  if (!db || !ftsAvailable) return stats;
  const state = resolveStateDir();
  const agentsRoot = path.join(state, "agents");
  if (!fs.existsSync(agentsRoot)) return stats;

  const agentIds = opts?.agentId
    ? [opts.agentId]
    : fs
        .readdirSync(agentsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

  const selectFile = db.prepare(
    `SELECT mtime, size, last_offset FROM session_files WHERE path = ?`,
  );
  const upsertFile = db.prepare(
    `INSERT INTO session_files (path, agent_id, session_id, mtime, size, last_offset, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime=excluded.mtime,
       size=excluded.size,
       last_offset=excluded.last_offset,
       updated_at=excluded.updated_at;`,
  );
  const insertMsg = db.prepare(
    `INSERT INTO messages_fts (text, agent_id, session_id, message_id, role, timestamp)
     VALUES (?, ?, ?, ?, ?, ?);`,
  );

  for (const agentId of agentIds) {
    const sessionsDir = path.join(agentsRoot, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(sessionsDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      stats.filesScanned += 1;
      const sessionId = entry.replace(/\.jsonl$/, "");
      const prior = selectFile.get(filePath) as
        | { mtime: number; size: number; last_offset: number }
        | undefined;

      // If the file shrank (was truncated/rotated) start over.
      const startOffset = prior && stat.size >= prior.last_offset ? prior.last_offset : 0;
      if (prior && stat.mtimeMs === prior.mtime && stat.size === prior.size) {
        continue;
      }

      let appended = 0;
      try {
        const fd = fs.openSync(filePath, "r");
        try {
          const length = stat.size - startOffset;
          if (length > 0) {
            const buf = Buffer.alloc(length);
            fs.readSync(fd, buf, 0, length, startOffset);
            const tail = buf.toString("utf8");
            const lines = tail.split("\n");
            // The last element may be a partial line if the file is being
            // appended to — only keep complete lines (terminated by \n).
            const lastLineComplete = tail.endsWith("\n");
            const completeLines = lastLineComplete ? lines : lines.slice(0, -1);
            const consumedBytes = lastLineComplete
              ? length
              : Buffer.byteLength(
                  completeLines.join("\n") + (completeLines.length ? "\n" : ""),
                  "utf8",
                );
            for (const rawLine of completeLines) {
              const trimmed = rawLine.trim();
              if (!trimmed) continue;
              const text = extractMessageText(trimmed);
              if (!text) continue;
              try {
                insertMsg.run(
                  text.body,
                  agentId,
                  sessionId,
                  text.messageId,
                  text.role,
                  text.timestamp,
                );
                appended += 1;
              } catch {
                stats.errors += 1;
              }
            }
            const newOffset = startOffset + consumedBytes;
            upsertFile.run(
              filePath,
              agentId,
              sessionId,
              Math.floor(stat.mtimeMs),
              stat.size,
              newOffset,
              Date.now(),
            );
            if (appended > 0) {
              stats.filesUpdated += 1;
              stats.messagesIndexed += appended;
            }
          } else {
            // No new bytes — still update the row so we skip it next pass.
            upsertFile.run(
              filePath,
              agentId,
              sessionId,
              Math.floor(stat.mtimeMs),
              stat.size,
              startOffset,
              Date.now(),
            );
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        log.debug(`failed to ingest ${filePath}: ${(err as Error).message}`);
        stats.errors += 1;
      }
    }
  }
  return stats;
}

interface ExtractedMessage {
  body: string;
  role: string;
  messageId: string | null;
  timestamp: string;
}

/**
 * Parse one JSONL line and pull the text body to index. Returns null for
 * non-message lines (session headers, tool envelopes without text). Each
 * AssistantMessage / UserMessage has a `content` array of typed blocks; we
 * concatenate all text-bearing variants ("text", "thinking", string fallback).
 */
function extractMessageText(line: string): ExtractedMessage | null {
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      id?: string;
      timestamp?: string;
      message?: {
        role?: string;
        content?:
          | string
          | Array<{ type?: string; text?: string; thinking?: string; reasoning?: string }>;
      };
    };
    if (obj.type !== "message" || !obj.message) return null;
    const role = obj.message.role ?? "unknown";
    const messageId = typeof obj.id === "string" ? obj.id : null;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
    const content = obj.message.content;
    let body = "";
    if (typeof content === "string") {
      body = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string" && block.text) parts.push(block.text);
        else if (typeof block.thinking === "string" && block.thinking) parts.push(block.thinking);
        else if (typeof block.reasoning === "string" && block.reasoning)
          parts.push(block.reasoning);
      }
      body = parts.join("\n").trim();
    }
    if (!body) return null;
    // Truncate ludicrously long messages — FTS5 doesn't need full paste dumps,
    // and an attacker could otherwise blow up the index by sending 50MB blobs.
    if (body.length > 200_000) body = body.slice(0, 200_000);
    return { body, role, messageId, timestamp };
  } catch {
    return null;
  }
}

/**
 * Run a search across the indexed session messages.
 *
 * `query` is passed to FTS5 — it supports column filters (e.g. `role:user`),
 * prefix wildcards (`foo*`), and phrase queries (`"exact phrase"`). When the
 * query string is invalid we strip MATCH-significant characters and retry as
 * a plain-text search so the caller never has to escape user input.
 */
export function searchSessions(opts: {
  query: string;
  agentId?: string;
  limit?: number;
}): SessionSearchResult {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
  const db = openDb();
  const empty: SessionSearchResult = { query: opts.query, total: 0, hits: [] };
  if (!db || !ftsAvailable) return empty;
  const query = opts.query?.trim();
  if (!query) return empty;

  const params: string[] = [query];
  let where = `messages_fts MATCH ?`;
  if (opts.agentId) {
    where += ` AND agent_id = ?`;
    params.push(opts.agentId);
  }
  const sql = `
    SELECT agent_id, session_id, message_id, role, timestamp,
           snippet(messages_fts, 0, '[', ']', '…', 18) AS snippet,
           bm25(messages_fts) AS score
    FROM messages_fts
    WHERE ${where}
    ORDER BY score
    LIMIT ${limit};
  `;

  const runQuery = (q: string, allParams: string[]) => {
    const stmt = db.prepare(sql);
    return stmt.all(...allParams) as Array<{
      agent_id: string;
      session_id: string;
      message_id: string | null;
      role: string;
      timestamp: string;
      snippet: string;
      score: number;
    }>;
  };

  let rows: ReturnType<typeof runQuery>;
  let warning: string | undefined;
  try {
    rows = runQuery(query, params);
  } catch (err) {
    // FTS5 syntax error — retry with a sanitized version.
    const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
    if (!sanitized) return empty;
    warning = `FTS5 query syntax invalid, retried as plain text: ${(err as Error).message}`;
    const retryParams = opts.agentId ? [sanitized, opts.agentId] : [sanitized];
    try {
      rows = runQuery(sanitized, retryParams);
    } catch {
      return { ...empty, warning };
    }
  }

  return {
    query,
    total: rows.length,
    hits: rows.map((r) => ({
      agentId: r.agent_id,
      sessionId: r.session_id,
      messageId: r.message_id,
      role: r.role,
      timestamp: r.timestamp,
      snippet: r.snippet,
    })),
    ...(warning ? { warning } : {}),
  };
}

/** For tests / shutdown. */
export function closeSearchIndex(): void {
  if (dbHandle) {
    try {
      dbHandle.close();
    } catch {
      /* ignore */
    }
    dbHandle = null;
    ftsAvailable = false;
  }
}
