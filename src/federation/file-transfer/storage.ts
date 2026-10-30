import Database from "better-sqlite3";
import path from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolveStateDir } from "../../config/paths.js";
import type { FileTransfer, TransferStatus, TransferDirection } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("file-transfer").child("storage");

interface TransferRow {
  id: string;
  direction: string;
  from_node: string;
  to_nodes: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  sha256: string;
  chunk_size: number;
  total_chunks: number;
  status: string;
  progress: string;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  saved_path: string | null;
  created_at: number;
}

function rowToTransfer(row: TransferRow): FileTransfer {
  return {
    id: row.id,
    direction: row.direction as TransferDirection,
    fromNode: row.from_node,
    toNodes: JSON.parse(row.to_nodes) as string[],
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    sha256: row.sha256,
    chunkSize: row.chunk_size,
    totalChunks: row.total_chunks,
    status: row.status as TransferStatus,
    progress: JSON.parse(row.progress) as FileTransfer["progress"],
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
    savedPath: row.saved_path ?? undefined,
  };
}

export class FileTransferStore {
  private db: Database.Database;

  constructor(stateDir?: string) {
    const dir = stateDir ?? resolveStateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "file-transfers.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_transfers (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        from_node TEXT NOT NULL,
        to_nodes TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        chunk_size INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        status TEXT NOT NULL,
        progress TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        saved_path TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    log.debug("store opened", { dbPath });
  }

  upsert(transfer: FileTransfer): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO file_transfers
          (id, direction, from_node, to_nodes, file_name, file_size, mime_type, sha256,
           chunk_size, total_chunks, status, progress, started_at, finished_at, error, saved_path, created_at)
         VALUES
          (@id, @direction, @fromNode, @toNodes, @fileName, @fileSize, @mimeType, @sha256,
           @chunkSize, @totalChunks, @status, @progress, @startedAt, @finishedAt, @error, @savedPath, @createdAt)`,
      )
      .run({
        id: transfer.id,
        direction: transfer.direction,
        fromNode: transfer.fromNode,
        toNodes: JSON.stringify(transfer.toNodes),
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        mimeType: transfer.mimeType,
        sha256: transfer.sha256,
        chunkSize: transfer.chunkSize,
        totalChunks: transfer.totalChunks,
        status: transfer.status,
        progress: JSON.stringify(transfer.progress),
        startedAt: transfer.startedAt ?? null,
        finishedAt: transfer.finishedAt ?? null,
        error: transfer.error ?? null,
        savedPath: transfer.savedPath ?? null,
        createdAt: Date.now(),
      });
  }

  get(id: string): FileTransfer | null {
    const row = this.db.prepare("SELECT * FROM file_transfers WHERE id = ?").get(id) as
      | TransferRow
      | undefined;
    return row ? rowToTransfer(row) : null;
  }

  list(opts?: { status?: TransferStatus; direction?: TransferDirection }): FileTransfer[] {
    let sql = "SELECT * FROM file_transfers";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.direction) {
      conditions.push("direction = ?");
      params.push(opts.direction);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY created_at DESC";

    const rows = this.db.prepare(sql).all(...params) as TransferRow[];
    return rows.map(rowToTransfer);
  }

  updateStatus(id: string, status: TransferStatus, error?: string): void {
    this.db
      .prepare("UPDATE file_transfers SET status = ?, error = ? WHERE id = ?")
      .run(status, error ?? null, id);
  }

  updateProgress(id: string, nodeId: string, chunksSent: number, bytesSent: number): void {
    const row = this.db.prepare("SELECT progress FROM file_transfers WHERE id = ?").get(id) as
      | { progress: string }
      | undefined;
    if (!row) return;

    const progress = JSON.parse(row.progress) as FileTransfer["progress"];
    progress[nodeId] = { chunksSent, bytesSent, lastChunkAt: Date.now() };
    this.db
      .prepare("UPDATE file_transfers SET progress = ? WHERE id = ?")
      .run(JSON.stringify(progress), id);
  }

  markComplete(id: string, nodeId: string, finishedAt: number): void {
    const row = this.db.prepare("SELECT progress FROM file_transfers WHERE id = ?").get(id) as
      | { progress: string }
      | undefined;
    if (!row) return;

    const progress = JSON.parse(row.progress) as FileTransfer["progress"];
    if (progress[nodeId]) {
      progress[nodeId].lastChunkAt = finishedAt;
    }
    this.db
      .prepare(
        "UPDATE file_transfers SET status = 'completed', finished_at = ?, progress = ? WHERE id = ?",
      )
      .run(finishedAt, JSON.stringify(progress), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare("UPDATE file_transfers SET status = 'failed', error = ? WHERE id = ?")
      .run(error, id);
  }

  setSavedPath(id: string, savedPath: string): void {
    this.db.prepare("UPDATE file_transfers SET saved_path = ? WHERE id = ?").run(savedPath, id);
  }
}

let _store: FileTransferStore | null = null;

export function getFileTransferStore(stateDir?: string): FileTransferStore {
  if (!_store) _store = new FileTransferStore(stateDir);
  return _store;
}

export function listInboxFiles(
  stateDir?: string,
): Array<{ path: string; fromNode: string; receivedAt: number; size: number; fileName: string }> {
  const store = getFileTransferStore(stateDir);
  const completed = store.list({ status: "completed", direction: "incoming" });
  const results: Array<{
    path: string;
    fromNode: string;
    receivedAt: number;
    size: number;
    fileName: string;
  }> = [];

  for (const t of completed) {
    if (!t.savedPath) continue;
    try {
      const stat = statSync(t.savedPath);
      results.push({
        path: t.savedPath,
        fromNode: t.fromNode,
        receivedAt: t.finishedAt ?? 0,
        size: stat.size,
        fileName: t.fileName,
      });
    } catch {
      // file missing from disk — skip
    }
  }

  return results;
}
