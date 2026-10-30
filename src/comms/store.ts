/**
 * Comms Hub persistence — its OWN SQLite database (`comms.db`) in the state dir.
 *
 * Deliberately separate from agency.db so this feature never has to migrate a
 * schema owned by another team. Client preferred-channel data lives in the
 * client `data` blob (see client-channel-prefs.ts), NOT here; this store owns
 * only the message log and agent communication permissions.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import {
  type AgentCommsPermission,
  type AutonomyDecision,
  type AutonomyLevel,
  type CommsChannel,
  type CommsThread,
  type MessageDirection,
  type MessageStatus,
  type NormalizedMessage,
  isCommsChannel,
} from "./types.js";

const SCHEMA_VERSION = 1;

type Row = Record<string, unknown>;

export interface RecordMessageInput {
  channel: CommsChannel;
  direction: MessageDirection;
  threadKey: string;
  clientId: string | null;
  agencyId: string;
  channelAccountId?: string | null;
  peerHandle: string;
  peerDisplayName?: string | null;
  text: string;
  mediaUrls?: string[];
  channelMessageId?: string | null;
  status: MessageStatus;
  sentByAgentId?: string | null;
  autonomyDecision?: AutonomyDecision | null;
  error?: string | null;
}

export class CommsStore {
  private db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comms_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS comms_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        client_id TEXT,
        agency_id TEXT NOT NULL,
        channel_account_id TEXT,
        peer_handle TEXT NOT NULL,
        peer_display_name TEXT,
        text TEXT NOT NULL DEFAULT '',
        media_urls TEXT NOT NULL DEFAULT '[]',
        channel_message_id TEXT,
        status TEXT NOT NULL,
        sent_by_agent_id TEXT,
        autonomy_decision TEXT,
        error TEXT,
        read_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comms_messages_thread ON comms_messages(thread_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_comms_messages_agency ON comms_messages(agency_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_comms_messages_status ON comms_messages(status);

      CREATE TABLE IF NOT EXISTS comms_thread_meta (
        thread_key TEXT PRIMARY KEY,
        assigned_agent_id TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comms_agent_permissions (
        agent_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        autonomy TEXT NOT NULL DEFAULT 'draft_for_approval',
        channels TEXT NOT NULL DEFAULT '[]',
        client_scope TEXT NOT NULL DEFAULT '"all"',
        daily_send_limit INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db
      .prepare("INSERT OR REPLACE INTO comms_meta(key, value) VALUES('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  // ── Messages ────────────────────────────────────────────────────────────────

  recordMessage(input: RecordMessageInput): NormalizedMessage {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO comms_messages
          (id, channel, direction, thread_key, client_id, agency_id, channel_account_id,
           peer_handle, peer_display_name, text, media_urls, channel_message_id, status,
           sent_by_agent_id, autonomy_decision, error, read_at, created_at, updated_at)
         VALUES (@id, @channel, @direction, @threadKey, @clientId, @agencyId, @channelAccountId,
           @peerHandle, @peerDisplayName, @text, @mediaUrls, @channelMessageId, @status,
           @sentByAgentId, @autonomyDecision, @error, @readAt, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        channel: input.channel,
        direction: input.direction,
        threadKey: input.threadKey,
        clientId: input.clientId,
        agencyId: input.agencyId,
        channelAccountId: input.channelAccountId ?? null,
        peerHandle: input.peerHandle,
        peerDisplayName: input.peerDisplayName ?? null,
        text: input.text,
        mediaUrls: JSON.stringify(input.mediaUrls ?? []),
        channelMessageId: input.channelMessageId ?? null,
        status: input.status,
        sentByAgentId: input.sentByAgentId ?? null,
        autonomyDecision: input.autonomyDecision ? JSON.stringify(input.autonomyDecision) : null,
        error: input.error ?? null,
        // inbound messages start unread; outbound are implicitly "read"
        readAt: input.direction === "outbound" ? now : null,
        createdAt: now,
        updatedAt: now,
      });
    return this.getMessage(id)!;
  }

  getMessage(id: string): NormalizedMessage | null {
    const row = this.db.prepare("SELECT * FROM comms_messages WHERE id = ?").get(id) as Row | undefined;
    return row ? this.rowToMessage(row) : null;
  }

  updateMessage(
    id: string,
    patch: Partial<Pick<NormalizedMessage, "status" | "channelMessageId" | "error" | "text">>,
  ): NormalizedMessage | null {
    const existing = this.getMessage(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE comms_messages
           SET status = @status, channel_message_id = @channelMessageId,
               error = @error, text = @text, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        status: patch.status ?? existing.status,
        channelMessageId: patch.channelMessageId ?? existing.channelMessageId,
        error: patch.error ?? existing.error,
        text: patch.text ?? existing.text,
        updatedAt: Date.now(),
      });
    return this.getMessage(id);
  }

  listThreadMessages(threadKey: string): NormalizedMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM comms_messages WHERE thread_key = ? ORDER BY created_at ASC")
      .all(threadKey) as Row[];
    return rows.map((r) => this.rowToMessage(r));
  }

  markThreadRead(threadKey: string): void {
    this.db
      .prepare("UPDATE comms_messages SET read_at = ? WHERE thread_key = ? AND read_at IS NULL")
      .run(Date.now(), threadKey);
  }

  listPendingApprovals(agencyId: string): NormalizedMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM comms_messages WHERE agency_id = ? AND status = 'pending_approval' ORDER BY created_at ASC",
      )
      .all(agencyId) as Row[];
    return rows.map((r) => this.rowToMessage(r));
  }

  // ── Threads (derived rollup) ─────────────────────────────────────────────────

  listThreads(
    agencyId: string,
    filter?: { assignedAgentId?: string | null; channel?: CommsChannel },
  ): CommsThread[] {
    const rows = this.db
      .prepare(
        `SELECT
            thread_key,
            channel,
            client_id,
            peer_handle,
            peer_display_name,
            MAX(created_at) AS last_at,
            COUNT(*) AS msg_count,
            SUM(CASE WHEN direction = 'inbound' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM comms_messages
         WHERE agency_id = ?
         GROUP BY thread_key
         ORDER BY last_at DESC`,
      )
      .all(agencyId) as Row[];

    const threads: CommsThread[] = [];
    for (const r of rows) {
      const threadKey = String(r.thread_key);
      const channel = String(r.channel) as CommsChannel;
      if (filter?.channel && channel !== filter.channel) continue;
      const assignedAgentId = this.getThreadAssignment(threadKey);
      if (
        filter?.assignedAgentId !== undefined &&
        (filter.assignedAgentId === null
          ? assignedAgentId !== null
          : assignedAgentId !== filter.assignedAgentId)
      ) {
        continue;
      }
      const last = this.db
        .prepare(
          "SELECT text, direction FROM comms_messages WHERE thread_key = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(threadKey) as Row | undefined;
      threads.push({
        threadKey,
        channel,
        clientId: r.client_id ? String(r.client_id) : null,
        clientName: null, // enriched by the RPC layer against the clients store
        peerHandle: String(r.peer_handle),
        peerDisplayName: r.peer_display_name ? String(r.peer_display_name) : null,
        assignedAgentId,
        lastMessageAt: Number(r.last_at) || 0,
        lastMessagePreview: last ? String(last.text ?? "").slice(0, 140) : "",
        lastDirection: (last ? String(last.direction) : "inbound") as MessageDirection,
        unreadCount: Number(r.unread) || 0,
        messageCount: Number(r.msg_count) || 0,
      });
    }
    return threads;
  }

  getThreadAssignment(threadKey: string): string | null {
    const row = this.db
      .prepare("SELECT assigned_agent_id FROM comms_thread_meta WHERE thread_key = ?")
      .get(threadKey) as Row | undefined;
    return row?.assigned_agent_id ? String(row.assigned_agent_id) : null;
  }

  setThreadAssignment(threadKey: string, agentId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO comms_thread_meta(thread_key, assigned_agent_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_key) DO UPDATE SET assigned_agent_id = excluded.assigned_agent_id, updated_at = excluded.updated_at`,
      )
      .run(threadKey, agentId, Date.now());
  }

  // ── Agent permissions ────────────────────────────────────────────────────────

  getPermission(agentId: string): AgentCommsPermission | null {
    const row = this.db
      .prepare("SELECT * FROM comms_agent_permissions WHERE agent_id = ?")
      .get(agentId) as Row | undefined;
    return row ? this.rowToPermission(row) : null;
  }

  listPermissions(): AgentCommsPermission[] {
    const rows = this.db
      .prepare("SELECT * FROM comms_agent_permissions ORDER BY agent_id ASC")
      .all() as Row[];
    return rows.map((r) => this.rowToPermission(r));
  }

  setPermission(input: {
    agentId: string;
    enabled?: boolean;
    autonomy?: AutonomyLevel;
    channels?: CommsChannel[];
    clientScope?: "all" | string[];
    dailySendLimit?: number | null;
  }): AgentCommsPermission {
    const existing = this.getPermission(input.agentId);
    const merged: AgentCommsPermission = {
      agentId: input.agentId,
      enabled: input.enabled ?? existing?.enabled ?? true,
      autonomy: input.autonomy ?? existing?.autonomy ?? "draft_for_approval",
      channels: input.channels ?? existing?.channels ?? [],
      clientScope: input.clientScope ?? existing?.clientScope ?? "all",
      dailySendLimit:
        input.dailySendLimit !== undefined ? input.dailySendLimit : (existing?.dailySendLimit ?? null),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO comms_agent_permissions
           (agent_id, enabled, autonomy, channels, client_scope, daily_send_limit, updated_at)
         VALUES (@agentId, @enabled, @autonomy, @channels, @clientScope, @dailySendLimit, @updatedAt)
         ON CONFLICT(agent_id) DO UPDATE SET
           enabled = excluded.enabled, autonomy = excluded.autonomy, channels = excluded.channels,
           client_scope = excluded.client_scope, daily_send_limit = excluded.daily_send_limit,
           updated_at = excluded.updated_at`,
      )
      .run({
        agentId: merged.agentId,
        enabled: merged.enabled ? 1 : 0,
        autonomy: merged.autonomy,
        channels: JSON.stringify(merged.channels),
        clientScope: JSON.stringify(merged.clientScope),
        dailySendLimit: merged.dailySendLimit,
        updatedAt: merged.updatedAt,
      });
    return merged;
  }

  /** Count outbound sends by an agent since a timestamp (for daily-limit checks). */
  countAgentSendsSince(agentId: string, since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM comms_messages WHERE sent_by_agent_id = ? AND direction = 'outbound' AND created_at >= ? AND status IN ('sent','queued')",
      )
      .get(agentId, since) as Row | undefined;
    return Number(row?.n) || 0;
  }

  close(): void {
    this.db.close();
  }

  // ── Row mappers ──────────────────────────────────────────────────────────────

  private rowToMessage(r: Row): NormalizedMessage {
    return {
      id: String(r.id),
      channel: String(r.channel) as CommsChannel,
      direction: String(r.direction) as MessageDirection,
      threadKey: String(r.thread_key),
      clientId: r.client_id ? String(r.client_id) : null,
      agencyId: String(r.agency_id),
      channelAccountId: r.channel_account_id ? String(r.channel_account_id) : null,
      peerHandle: String(r.peer_handle),
      peerDisplayName: r.peer_display_name ? String(r.peer_display_name) : null,
      text: String(r.text ?? ""),
      mediaUrls: safeJsonArray(r.media_urls),
      channelMessageId: r.channel_message_id ? String(r.channel_message_id) : null,
      status: String(r.status) as MessageStatus,
      sentByAgentId: r.sent_by_agent_id ? String(r.sent_by_agent_id) : null,
      autonomyDecision: r.autonomy_decision
        ? (JSON.parse(String(r.autonomy_decision)) as AutonomyDecision)
        : null,
      error: r.error ? String(r.error) : null,
      createdAt: Number(r.created_at) || 0,
      updatedAt: Number(r.updated_at) || 0,
    };
  }

  private rowToPermission(r: Row): AgentCommsPermission {
    let clientScope: "all" | string[] = "all";
    try {
      const parsed = JSON.parse(String(r.client_scope ?? '"all"'));
      clientScope = Array.isArray(parsed) ? parsed.map(String) : "all";
    } catch {
      clientScope = "all";
    }
    const channels = safeJsonArray(r.channels).filter(isCommsChannel);
    return {
      agentId: String(r.agent_id),
      enabled: Number(r.enabled) === 1,
      autonomy: String(r.autonomy) as AutonomyLevel,
      channels,
      clientScope,
      dailySendLimit: r.daily_send_limit == null ? null : Number(r.daily_send_limit),
      updatedAt: Number(r.updated_at) || 0,
    };
  }
}

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ── Shared instance (mirrors getAgencyOperationsStore) ────────────────────────

const sharedStores = new Map<string, CommsStore>();

export function getCommsStore(stateDir: string): CommsStore {
  const databasePath = join(stateDir, "comms", "comms.db");
  const existing = sharedStores.get(databasePath);
  if (existing) return existing;
  const store = new CommsStore(databasePath);
  sharedStores.set(databasePath, store);
  return store;
}

export function resetCommsStores(): void {
  for (const store of sharedStores.values()) store.close();
  sharedStores.clear();
}
