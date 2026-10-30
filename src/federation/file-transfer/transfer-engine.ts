import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  createReadStream,
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFileTransferStore, type FileTransferStore } from "./storage.js";
import type {
  FileTransfer,
  FileTransferChunkPayload,
  FileTransferStartPayload,
  FileTransferCompletePayload,
  FileTransferErrorPayload,
  FileTransferChunkAckPayload,
} from "./types.js";

const log = createSubsystemLogger("file-transfer").child("engine");

const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256KB

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".csv": "text/csv",
};

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function resolveInboxFinalPath(inboxDir: string, fileName: string): string {
  const ts = Date.now();
  const base = `${ts}-${fileName}`;
  let candidate = path.join(inboxDir, base);
  if (!existsSync(candidate)) return candidate;

  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(inboxDir, `${ts}-${stem}(${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(inboxDir, `${ts}-${stem}-${randomUUID()}${ext}`);
}

export class FileTransferEngine extends EventEmitter {
  private store: FileTransferStore;
  private stateDir: string;
  private sendMessageFn: ((targetNodeId: string, type: string, payload: unknown) => void) | null =
    null;
  private localNodeId: string = "local";
  private activeReads: Map<string, { aborted: boolean }> = new Map();
  // Maps transferId → absolute file path for outgoing transfers (in-memory only)
  private outgoingPaths: Map<string, string> = new Map();

  constructor(stateDir?: string) {
    super();
    this.stateDir = stateDir ?? resolveStateDir();
    this.store = getFileTransferStore(this.stateDir);
  }

  init(
    localNodeId: string,
    sendMessageFn: (targetNodeId: string, type: string, payload: unknown) => void,
  ): void {
    this.localNodeId = localNodeId;
    this.sendMessageFn = sendMessageFn;
    log.info("engine initialized", { localNodeId });
  }

  async sendFile(opts: {
    filePath: string;
    toNodes: string[];
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { filePath, toNodes } = opts;
    const stat = statSync(filePath);
    const fileSize = stat.size;
    const fileName = path.basename(filePath);
    const mimeType = detectMimeType(filePath);
    const sha256 = await computeSha256(filePath);
    const chunkSize = DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(fileSize / chunkSize) || 1;

    const id = randomUUID();
    const transfer: FileTransfer = {
      id,
      direction: "outgoing",
      fromNode: this.localNodeId,
      toNodes,
      fileName,
      fileSize,
      mimeType,
      sha256,
      chunkSize,
      totalChunks,
      status: "negotiating",
      progress: {},
      startedAt: Date.now(),
    };

    for (const nodeId of toNodes) {
      transfer.progress[nodeId] = { chunksSent: 0, bytesSent: 0, lastChunkAt: 0 };
    }

    this.store.upsert(transfer);
    this.outgoingPaths.set(id, filePath);
    log.info("sending file", { id, fileName, fileSize, toNodes });

    const startPayload: FileTransferStartPayload = {
      transferId: id,
      fromNode: this.localNodeId,
      toNodes,
      fileName,
      fileSize,
      mimeType,
      sha256,
      chunkSize,
      totalChunks,
    };

    if (this.sendMessageFn) {
      for (const nodeId of toNodes) {
        this.sendMessageFn(nodeId, "file-transfer.start", startPayload);
      }
    }

    this._streamChunks(transfer).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("stream error", { id, error: msg });
      this._failTransfer(id, msg);
    });

    return id;
  }

  async _streamChunks(transfer: FileTransfer): Promise<void> {
    const current = this.store.get(transfer.id);
    if (!current) return;
    if (
      current.status !== "queued" &&
      current.status !== "negotiating" &&
      current.status !== "transferring"
    ) {
      return;
    }

    const filePath = this.outgoingPaths.get(transfer.id);
    if (!filePath) {
      this._failTransfer(transfer.id, "file path not available for streaming");
      return;
    }

    await this._streamFrom(transfer, filePath, 0);
  }

  private async _streamFrom(
    transfer: FileTransfer,
    filePath: string,
    startByte: number,
  ): Promise<void> {
    const handle = { aborted: false };
    this.activeReads.set(transfer.id, handle);

    try {
      this.store.updateStatus(transfer.id, "transferring");

      const streamOpts: Parameters<typeof createReadStream>[1] = {
        highWaterMark: transfer.chunkSize,
      };
      if (startByte > 0) streamOpts.start = startByte;

      const fileStream = createReadStream(filePath, streamOpts);
      // Track progress locally for this run
      const localProgress = { ...transfer.progress };
      let chunkIndex = Math.floor(startByte / transfer.chunkSize);

      await new Promise<void>((resolve, reject) => {
        fileStream.on("data", (chunk: Buffer) => {
          if (handle.aborted) {
            fileStream.destroy();
            resolve();
            return;
          }

          const data = chunk.toString("base64");

          for (const nodeId of transfer.toNodes) {
            if (this.sendMessageFn) {
              const payload: FileTransferChunkPayload = {
                transferId: transfer.id,
                toNodeId: nodeId,
                chunkIndex,
                data,
              };
              this.sendMessageFn(nodeId, "file-transfer.chunk", payload);
            }

            const prev = localProgress[nodeId] ?? { chunksSent: 0, bytesSent: 0, lastChunkAt: 0 };
            const newChunksSent = prev.chunksSent + 1;
            const newBytesSent = prev.bytesSent + chunk.length;
            localProgress[nodeId] = {
              chunksSent: newChunksSent,
              bytesSent: newBytesSent,
              lastChunkAt: Date.now(),
            };
            this.store.updateProgress(transfer.id, nodeId, newChunksSent, newBytesSent);
          }

          this.emit("transfer:progress", transfer.id, { ...localProgress });
          chunkIndex++;
        });

        fileStream.on("end", () => resolve());
        fileStream.on("error", reject);
      });

      if (handle.aborted) {
        this.activeReads.delete(transfer.id);
        return;
      }

      for (const nodeId of transfer.toNodes) {
        if (this.sendMessageFn) {
          const payload = {
            transferId: transfer.id,
            toNodeId: nodeId,
            sha256: transfer.sha256,
          };
          this.sendMessageFn(nodeId, "file-transfer.complete", payload);
        }
      }

      this.store.markComplete(transfer.id, this.localNodeId, Date.now());
      const completed = this.store.get(transfer.id)!;
      this.emit("transfer:complete", completed);
      log.info("transfer complete", { id: transfer.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._failTransfer(transfer.id, msg);
    } finally {
      this.activeReads.delete(transfer.id);
    }
  }

  pauseTransfer(transferId: string): void {
    this.store.updateStatus(transferId, "paused");
    const handle = this.activeReads.get(transferId);
    if (handle) handle.aborted = true;
    log.info("transfer paused", { id: transferId });
  }

  resumeTransfer(transferId: string): void {
    const transfer = this.store.get(transferId);
    if (!transfer || transfer.status !== "paused") return;

    const filePath = this.outgoingPaths.get(transferId);
    if (!filePath) {
      this._failTransfer(transferId, "file path not available for resume");
      return;
    }

    // Seek to the max chunksSent position across all recipients
    let maxChunksSent = 0;
    for (const nodeId of transfer.toNodes) {
      const p = transfer.progress[nodeId];
      if (p && p.chunksSent > maxChunksSent) maxChunksSent = p.chunksSent;
    }
    const offset = maxChunksSent * transfer.chunkSize;

    this.store.updateStatus(transferId, "transferring");

    this._streamFrom(transfer, filePath, offset).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this._failTransfer(transferId, msg);
    });

    log.info("transfer resumed", { id: transferId, fromChunk: maxChunksSent });
  }

  cancelTransfer(transferId: string): void {
    this.store.updateStatus(transferId, "cancelled");
    const handle = this.activeReads.get(transferId);
    if (handle) handle.aborted = true;
    this.outgoingPaths.delete(transferId);
    log.info("transfer cancelled", { id: transferId });
  }

  getTransfer(transferId: string): FileTransfer | null {
    return this.store.get(transferId);
  }

  listTransfers(opts?: { status?: string; direction?: string }): FileTransfer[] {
    return this.store.list(opts as Parameters<FileTransferStore["list"]>[0]);
  }

  handleIncomingStart(payload: FileTransferStartPayload): void {
    const transfer: FileTransfer = {
      id: payload.transferId,
      direction: "incoming",
      fromNode: payload.fromNode,
      toNodes: payload.toNodes,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      mimeType: payload.mimeType,
      sha256: payload.sha256,
      chunkSize: payload.chunkSize,
      totalChunks: payload.totalChunks,
      status: "transferring",
      progress: {
        [payload.fromNode]: { chunksSent: 0, bytesSent: 0, lastChunkAt: 0 },
      },
      startedAt: Date.now(),
    };

    this.store.upsert(transfer);
    this.emit("transfer:incoming", transfer);
    log.info("incoming transfer started", {
      id: payload.transferId,
      from: payload.fromNode,
      fileName: payload.fileName,
    });
  }

  handleIncomingChunk(payload: FileTransferChunkPayload): void {
    const transfer = this.store.get(payload.transferId);
    if (!transfer) {
      log.warn("chunk for unknown transfer", { id: payload.transferId });
      return;
    }

    const inboxDir = path.join(this.stateDir, "inbox", transfer.fromNode);
    try {
      mkdirSync(inboxDir, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("failed to create inbox dir", { inboxDir, error: msg });
      this._failTransfer(payload.transferId, `inbox dir creation failed: ${msg}`);
      return;
    }

    const tempPath = path.join(inboxDir, `${payload.transferId}.partial`);

    try {
      const chunkData = Buffer.from(payload.data, "base64");
      appendFileSync(tempPath, chunkData);

      const prev = transfer.progress[transfer.fromNode] ?? {
        chunksSent: 0,
        bytesSent: 0,
        lastChunkAt: 0,
      };
      this.store.updateProgress(
        payload.transferId,
        transfer.fromNode,
        prev.chunksSent + 1,
        prev.bytesSent + chunkData.length,
      );

      const updated = this.store.get(payload.transferId)!;
      this.emit("transfer:progress", payload.transferId, updated.progress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("failed to write chunk", { id: payload.transferId, error: msg });
      this._failTransfer(payload.transferId, `chunk write failed: ${msg}`);
      return;
    }

    if (this.sendMessageFn) {
      const ack: FileTransferChunkAckPayload = {
        transferId: payload.transferId,
        fromNodeId: this.localNodeId,
        chunkIndex: payload.chunkIndex,
      };
      this.sendMessageFn(transfer.fromNode, "file-transfer.chunk.ack", ack);
    }
  }

  handleIncomingComplete(payload: FileTransferCompletePayload): void {
    const transfer = this.store.get(payload.transferId);
    if (!transfer) {
      log.warn("complete for unknown transfer", { id: payload.transferId });
      return;
    }

    const inboxDir = path.join(this.stateDir, "inbox", transfer.fromNode);
    const tempPath = path.join(inboxDir, `${payload.transferId}.partial`);

    computeSha256(tempPath)
      .then((actualSha256) => {
        if (actualSha256 !== payload.sha256) {
          log.error("SHA256 mismatch", {
            id: payload.transferId,
            expected: payload.sha256,
            actual: actualSha256,
          });
          try {
            unlinkSync(tempPath);
          } catch {
            /* ignore */
          }
          this._failTransfer(payload.transferId, "SHA256 mismatch");
          return;
        }

        const finalPath = resolveInboxFinalPath(inboxDir, transfer.fileName);
        try {
          renameSync(tempPath, finalPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("failed to rename temp file", { id: payload.transferId, error: msg });
          this._failTransfer(payload.transferId, `rename failed: ${msg}`);
          return;
        }

        this.store.markComplete(payload.transferId, transfer.fromNode, Date.now());
        this.store.setSavedPath(payload.transferId, finalPath);
        const completed = this.store.get(payload.transferId)!;
        this.emit("transfer:complete", completed);
        log.info("incoming transfer complete", { id: payload.transferId, savedPath: finalPath });
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("sha256 verify failed", { id: payload.transferId, error: msg });
        this._failTransfer(payload.transferId, `sha256 verify error: ${msg}`);
      });
  }

  handleChunkAck(payload: FileTransferChunkAckPayload): void {
    const transfer = this.store.get(payload.transferId);
    if (!transfer) return;
    const prev = transfer.progress[payload.fromNodeId] ?? {
      chunksSent: 0,
      bytesSent: 0,
      lastChunkAt: 0,
    };
    // Only advance if the ack is for a later chunk than what we have recorded
    const ackChunks = payload.chunkIndex + 1;
    if (ackChunks > prev.chunksSent) {
      this.store.updateProgress(
        payload.transferId,
        payload.fromNodeId,
        ackChunks,
        ackChunks * transfer.chunkSize,
      );
    }
  }

  handleIncomingError(payload: FileTransferErrorPayload): void {
    this.store.markFailed(payload.transferId, payload.error);
    const transfer = this.store.get(payload.transferId);
    if (transfer) this.emit("transfer:failed", transfer);
  }

  handlePeerDisconnect(nodeId: string): void {
    const outgoing = this.store.list({ direction: "outgoing" });
    for (const t of outgoing) {
      if (
        t.toNodes.includes(nodeId) &&
        (t.status === "transferring" || t.status === "negotiating")
      ) {
        this.store.updateStatus(t.id, "paused");
        const handle = this.activeReads.get(t.id);
        if (handle) handle.aborted = true;
        log.info("paused transfer on peer disconnect", { id: t.id, nodeId });
      }
    }
  }

  handlePeerReconnect(nodeId: string): void {
    const paused = this.store.list({ status: "paused", direction: "outgoing" });
    for (const t of paused) {
      if (t.toNodes.includes(nodeId)) {
        log.info("auto-resuming transfer on peer reconnect", { id: t.id, nodeId });
        this.resumeTransfer(t.id);
      }
    }
  }

  _failTransfer(id: string, error: string): void {
    this.store.markFailed(id, error);
    const transfer = this.store.get(id);
    if (transfer) this.emit("transfer:failed", transfer);
    log.error("transfer failed", { id, error });
  }
}

let _engine: FileTransferEngine | null = null;

export function getTransferEngine(): FileTransferEngine {
  if (!_engine) _engine = new FileTransferEngine();
  return _engine;
}

export function initTransferEngine(
  localNodeId: string,
  sendFn: (targetNodeId: string, type: string, payload: unknown) => void,
): void {
  const engine = getTransferEngine();
  engine.init(localNodeId, sendFn);

  // Wire up hub events so the engine handles locally-addressed messages.
  import("../hub.js")
    .then(({ getFederationHub }) => {
      const hub = getFederationHub();
      if (!hub) return;
      hub.on(
        "file-transfer:message",
        (type: string, payload: Record<string, unknown>, _fromNodeId: string) => {
          switch (type) {
            case "file-transfer.start":
              engine.handleIncomingStart(payload as unknown as FileTransferStartPayload);
              break;
            case "file-transfer.chunk":
              engine.handleIncomingChunk(payload as unknown as FileTransferChunkPayload);
              break;
            case "file-transfer.chunk.ack":
              engine.handleChunkAck(payload as unknown as FileTransferChunkAckPayload);
              break;
            case "file-transfer.complete":
              engine.handleIncomingComplete(payload as unknown as FileTransferCompletePayload);
              break;
            case "file-transfer.error":
              engine.handleIncomingError(payload as unknown as FileTransferErrorPayload);
              break;
            case "file-transfer.pause":
              engine.pauseTransfer((payload.transferId as string) ?? "");
              break;
            case "file-transfer.resume":
              engine.resumeTransfer((payload.transferId as string) ?? "");
              break;
          }
        },
      );

      // Auto-pause/resume transfers when peers connect/disconnect.
      hub.on("node:disconnected", (nodeId: string) => engine.handlePeerDisconnect(nodeId));
      hub.on("node:connected", (node: { id: string }) => engine.handlePeerReconnect(node.id));
    })
    .catch(() => {
      // Hub not running (standalone mode) — skip registration.
    });
}
