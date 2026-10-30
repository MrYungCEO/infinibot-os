/**
 * Federation Session Sync
 *
 * Persistent session history storage with cross-node synchronization.
 *
 * Features:
 * - SQLite-backed session history storage
 * - Cross-node replication via federation protocol
 * - Session recovery/resume from any node
 * - Conflict resolution with vector clocks
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { EventEmitter } from "events";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface SessionHistoryMessage {
  id: string;
  sessionKey: string;
  nodeId: string;
  role: "user" | "assistant" | "system";
  content: string;
  mediaUrls?: string[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
  timestamp: number;
  vectorClock: Record<string, number>;
}

export interface SessionHistoryEntry {
  sessionKey: string;
  nodeId: string;
  agentId: string;
  channel: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  metadata: Record<string, unknown>;
}

export interface SyncState {
  nodeId: string;
  lastSyncTimestamp: number;
  vectorClock: Record<string, number>;
}

// ══════════════════════════════════════════════════════════════════════════════
// Session History Store
// ══════════════════════════════════════════════════════════════════════════════

export class SessionHistoryStore extends EventEmitter {
  private db: Database.Database;
  private nodeId: string;
  private vectorClock: Record<string, number> = {};

  constructor(stateDir: string, nodeId: string) {
    super();
    this.nodeId = nodeId;

    const dbDir = join(stateDir, "federation");
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = join(dbDir, "session-history.db");
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        channel TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        vector_clock TEXT DEFAULT '{}'
      );
      
      -- Messages table  
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        node_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        media_urls TEXT,
        tool_calls TEXT,
        tool_results TEXT,
        timestamp INTEGER NOT NULL,
        vector_clock TEXT NOT NULL,
        synced INTEGER DEFAULT 0,
        FOREIGN KEY (session_key) REFERENCES sessions(session_key)
      );
      
      -- Sync state table
      CREATE TABLE IF NOT EXISTS sync_state (
        node_id TEXT PRIMARY KEY,
        last_sync_timestamp INTEGER NOT NULL,
        vector_clock TEXT NOT NULL
      );
      
      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_synced ON messages(synced);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at);
    `);

    // Load vector clock
    this.loadVectorClock();
  }

  private loadVectorClock(): void {
    const row = this.db
      .prepare("SELECT vector_clock FROM sync_state WHERE node_id = ?")
      .get(this.nodeId) as { vector_clock: string } | undefined;

    if (row?.vector_clock) {
      try {
        this.vectorClock = JSON.parse(row.vector_clock);
      } catch {
        this.vectorClock = {};
      }
    }

    // Ensure our node is in the clock
    if (!this.vectorClock[this.nodeId]) {
      this.vectorClock[this.nodeId] = 0;
    }
  }

  private incrementClock(): Record<string, number> {
    this.vectorClock[this.nodeId] = (this.vectorClock[this.nodeId] || 0) + 1;

    // Persist
    this.db
      .prepare(`
      INSERT OR REPLACE INTO sync_state (node_id, last_sync_timestamp, vector_clock)
      VALUES (?, ?, ?)
    `)
      .run(this.nodeId, Date.now(), JSON.stringify(this.vectorClock));

    return { ...this.vectorClock };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Session Operations
  // ──────────────────────────────────────────────────────────────────────────

  createSession(params: {
    sessionKey: string;
    agentId: string;
    channel?: string;
    metadata?: Record<string, unknown>;
  }): SessionHistoryEntry {
    const now = Date.now();
    const clock = this.incrementClock();

    this.db
      .prepare(`
      INSERT OR REPLACE INTO sessions 
      (session_key, node_id, agent_id, channel, created_at, last_active_at, message_count, metadata, vector_clock)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `)
      .run(
        params.sessionKey,
        this.nodeId,
        params.agentId,
        params.channel || "unknown",
        now,
        now,
        JSON.stringify(params.metadata || {}),
        JSON.stringify(clock),
      );

    const entry: SessionHistoryEntry = {
      sessionKey: params.sessionKey,
      nodeId: this.nodeId,
      agentId: params.agentId,
      channel: params.channel || "unknown",
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
      metadata: params.metadata || {},
    };

    this.emit("session:created", entry);
    return entry;
  }

  getSession(sessionKey: string): SessionHistoryEntry | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    return {
      sessionKey: row.session_key as string,
      nodeId: row.node_id as string,
      agentId: row.agent_id as string,
      channel: row.channel as string,
      createdAt: row.created_at as number,
      lastActiveAt: row.last_active_at as number,
      messageCount: row.message_count as number,
      metadata: JSON.parse((row.metadata as string) || "{}"),
    };
  }

  listSessions(params?: {
    nodeId?: string;
    channel?: string;
    limit?: number;
    since?: number;
  }): SessionHistoryEntry[] {
    let query = "SELECT * FROM sessions WHERE 1=1";
    const bindings: unknown[] = [];

    if (params?.nodeId) {
      query += " AND node_id = ?";
      bindings.push(params.nodeId);
    }
    if (params?.channel) {
      query += " AND channel = ?";
      bindings.push(params.channel);
    }
    if (params?.since) {
      query += " AND last_active_at > ?";
      bindings.push(params.since);
    }

    query += " ORDER BY last_active_at DESC";

    if (params?.limit) {
      query += " LIMIT ?";
      bindings.push(params.limit);
    }

    const rows = this.db.prepare(query).all(...bindings) as Record<string, unknown>[];

    return rows.map((row) => ({
      sessionKey: row.session_key as string,
      nodeId: row.node_id as string,
      agentId: row.agent_id as string,
      channel: row.channel as string,
      createdAt: row.created_at as number,
      lastActiveAt: row.last_active_at as number,
      messageCount: row.message_count as number,
      metadata: JSON.parse((row.metadata as string) || "{}"),
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Message Operations
  // ──────────────────────────────────────────────────────────────────────────

  appendMessage(params: {
    sessionKey: string;
    role: "user" | "assistant" | "system";
    content: string;
    mediaUrls?: string[];
    toolCalls?: unknown[];
    toolResults?: unknown[];
  }): SessionHistoryMessage {
    const id = `${this.nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const clock = this.incrementClock();

    // Ensure session exists
    let session = this.getSession(params.sessionKey);
    if (!session) {
      // Auto-create session
      const parts = params.sessionKey.split(":");
      session = this.createSession({
        sessionKey: params.sessionKey,
        agentId: parts[1] || "unknown",
        channel: parts[0] === "agent" ? "agent" : "unknown",
      });
    }

    // Insert message
    this.db
      .prepare(`
      INSERT INTO messages 
      (id, session_key, node_id, role, content, media_urls, tool_calls, tool_results, timestamp, vector_clock, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `)
      .run(
        id,
        params.sessionKey,
        this.nodeId,
        params.role,
        params.content,
        params.mediaUrls ? JSON.stringify(params.mediaUrls) : null,
        params.toolCalls ? JSON.stringify(params.toolCalls) : null,
        params.toolResults ? JSON.stringify(params.toolResults) : null,
        now,
        JSON.stringify(clock),
      );

    // Update session
    this.db
      .prepare(`
      UPDATE sessions 
      SET last_active_at = ?, message_count = message_count + 1, vector_clock = ?
      WHERE session_key = ?
    `)
      .run(now, JSON.stringify(clock), params.sessionKey);

    const message: SessionHistoryMessage = {
      id,
      sessionKey: params.sessionKey,
      nodeId: this.nodeId,
      role: params.role,
      content: params.content,
      mediaUrls: params.mediaUrls,
      toolCalls: params.toolCalls,
      toolResults: params.toolResults,
      timestamp: now,
      vectorClock: clock,
    };

    this.emit("message:appended", message);
    return message;
  }

  getHistory(
    sessionKey: string,
    params?: {
      limit?: number;
      before?: number;
      includeTools?: boolean;
    },
  ): SessionHistoryMessage[] {
    let query = "SELECT * FROM messages WHERE session_key = ?";
    const bindings: unknown[] = [sessionKey];

    if (params?.before) {
      query += " AND timestamp < ?";
      bindings.push(params.before);
    }

    query += " ORDER BY timestamp DESC";

    if (params?.limit) {
      query += " LIMIT ?";
      bindings.push(params.limit);
    }

    const rows = this.db.prepare(query).all(...bindings) as Record<string, unknown>[];

    return rows.reverse().map((row) => ({
      id: row.id as string,
      sessionKey: row.session_key as string,
      nodeId: row.node_id as string,
      role: row.role as "user" | "assistant" | "system",
      content: row.content as string,
      mediaUrls: row.media_urls ? JSON.parse(row.media_urls as string) : undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : undefined,
      timestamp: row.timestamp as number,
      vectorClock: JSON.parse((row.vector_clock as string) || "{}"),
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Federation Sync
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get messages that need to be synced to other nodes
   */
  getUnsyncedMessages(targetNodeId: string): SessionHistoryMessage[] {
    const syncState = this.db
      .prepare("SELECT last_sync_timestamp FROM sync_state WHERE node_id = ?")
      .get(targetNodeId) as { last_sync_timestamp: number } | undefined;

    const since = syncState?.last_sync_timestamp || 0;

    const rows = this.db
      .prepare(`
      SELECT * FROM messages 
      WHERE timestamp > ? AND node_id = ?
      ORDER BY timestamp ASC
      LIMIT 1000
    `)
      .all(since, this.nodeId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      sessionKey: row.session_key as string,
      nodeId: row.node_id as string,
      role: row.role as "user" | "assistant" | "system",
      content: row.content as string,
      mediaUrls: row.media_urls ? JSON.parse(row.media_urls as string) : undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : undefined,
      timestamp: row.timestamp as number,
      vectorClock: JSON.parse((row.vector_clock as string) || "{}"),
    }));
  }

  /**
   * Receive and merge messages from another node
   */
  mergeRemoteMessages(messages: SessionHistoryMessage[], fromNodeId: string): number {
    let merged = 0;

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages 
      (id, session_key, node_id, role, content, media_urls, tool_calls, tool_results, timestamp, vector_clock, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const sessionUpdateStmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions 
      (session_key, node_id, agent_id, channel, created_at, last_active_at, message_count, metadata, vector_clock)
      SELECT 
        ?,
        COALESCE((SELECT node_id FROM sessions WHERE session_key = ?), ?),
        COALESCE((SELECT agent_id FROM sessions WHERE session_key = ?), 'unknown'),
        COALESCE((SELECT channel FROM sessions WHERE session_key = ?), 'unknown'),
        COALESCE((SELECT created_at FROM sessions WHERE session_key = ?), ?),
        MAX(COALESCE((SELECT last_active_at FROM sessions WHERE session_key = ?), 0), ?),
        COALESCE((SELECT message_count FROM sessions WHERE session_key = ?), 0) + 1,
        COALESCE((SELECT metadata FROM sessions WHERE session_key = ?), '{}'),
        ?
    `);

    const transaction = this.db.transaction((msgs: SessionHistoryMessage[]) => {
      for (const msg of msgs) {
        // Insert message
        const result = insertStmt.run(
          msg.id,
          msg.sessionKey,
          msg.nodeId,
          msg.role,
          msg.content,
          msg.mediaUrls ? JSON.stringify(msg.mediaUrls) : null,
          msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
          msg.toolResults ? JSON.stringify(msg.toolResults) : null,
          msg.timestamp,
          JSON.stringify(msg.vectorClock),
        );

        if (result.changes > 0) {
          merged++;

          // Update session
          sessionUpdateStmt.run(
            msg.sessionKey,
            msg.sessionKey,
            msg.nodeId,
            msg.sessionKey,
            msg.sessionKey,
            msg.sessionKey,
            msg.timestamp,
            msg.sessionKey,
            msg.timestamp,
            msg.sessionKey,
            msg.sessionKey,
            JSON.stringify(msg.vectorClock),
          );

          // Merge vector clocks
          for (const [node, time] of Object.entries(msg.vectorClock)) {
            if ((this.vectorClock[node] || 0) < time) {
              this.vectorClock[node] = time;
            }
          }
        }
      }
    });

    transaction(messages);

    // Update sync state for this node
    if (messages.length > 0) {
      const lastTimestamp = Math.max(...messages.map((m) => m.timestamp));
      this.db
        .prepare(`
        INSERT OR REPLACE INTO sync_state (node_id, last_sync_timestamp, vector_clock)
        VALUES (?, ?, ?)
      `)
        .run(fromNodeId, lastTimestamp, JSON.stringify(this.vectorClock));
    }

    if (merged > 0) {
      this.emit("sync:received", { fromNodeId, count: merged });
    }

    return merged;
  }

  /**
   * Mark messages as synced to a node
   */
  markSynced(toNodeId: string, upToTimestamp: number): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO sync_state (node_id, last_sync_timestamp, vector_clock)
      VALUES (?, ?, ?)
    `)
      .run(toNodeId, upToTimestamp, JSON.stringify(this.vectorClock));
  }

  /**
   * Get sync status for all known nodes
   */
  getSyncStatus(): SyncState[] {
    const rows = this.db.prepare("SELECT * FROM sync_state").all() as Record<string, unknown>[];

    return rows.map((row) => ({
      nodeId: row.node_id as string,
      lastSyncTimestamp: row.last_sync_timestamp as number,
      vectorClock: JSON.parse((row.vector_clock as string) || "{}"),
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ──────────────────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  /**
   * Prune old messages (keep recent history)
   */
  prune(keepDays: number = 30): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;

    const result = this.db
      .prepare("DELETE FROM messages WHERE timestamp < ? AND synced = 1")
      .run(cutoff);

    return result.changes;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Singleton
// ══════════════════════════════════════════════════════════════════════════════

let store: SessionHistoryStore | null = null;

export function getSessionHistoryStore(): SessionHistoryStore | null {
  return store;
}

export function initSessionHistoryStore(stateDir: string, nodeId: string): SessionHistoryStore {
  if (store) return store;
  store = new SessionHistoryStore(stateDir, nodeId);
  return store;
}

export function closeSessionHistoryStore(): void {
  if (store) {
    store.close();
    store = null;
  }
}
