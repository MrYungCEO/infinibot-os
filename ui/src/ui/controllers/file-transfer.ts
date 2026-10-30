/**
 * File Transfer Controller
 *
 * State management and business logic for the file transfer UI.
 * Handles transfers over the InfiniBot federation mesh.
 */

import type { GatewayBrowserClient } from "../gateway";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export type TransferStatus =
  | "queued"
  | "negotiating"
  | "transferring"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TransferDirection = "outgoing" | "incoming";

export interface FileTransfer {
  id: string;
  direction: TransferDirection;
  fromNode: string;
  toNodes: string[];
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
  status: TransferStatus;
  progress: Record<
    string,
    { chunksSent: number; bytesSent: number; lastChunkAt: number }
  >;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  savedPath?: string;
}

export interface FileTransferPeer {
  id: string;
  name: string;
  online: boolean;
  capability: { fileTransfer: boolean };
  lastSeen: number;
}

export interface InboxFile {
  path: string;
  fromNode: string;
  receivedAt: number;
  size: number;
  fileName: string;
}

export interface FileTransferState {
  transfers: FileTransfer[];
  peers: FileTransferPeer[];
  inboxFiles: InboxFile[];
  loading: boolean;
  error: string | null;
  selectedPeers: Set<string>;
  pendingFile: { name: string; path: string; size: number } | null;
  activeTab: "send" | "inbox";
  dragOver: boolean;
  totalBytesTransferred: number;
  completedToday: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// State Factory
// ══════════════════════════════════════════════════════════════════════════════

export function createFileTransferState(): FileTransferState {
  return {
    transfers: [],
    peers: [],
    inboxFiles: [],
    loading: false,
    error: null,
    selectedPeers: new Set(),
    pendingFile: null,
    activeTab: "send",
    dragOver: false,
    totalBytesTransferred: 0,
    completedToday: 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Data Loading
// ══════════════════════════════════════════════════════════════════════════════

export async function loadFileTransferData(
  client: GatewayBrowserClient,
  state: FileTransferState,
  requestUpdate: () => void
): Promise<void> {
  state.loading = true;
  state.error = null;
  requestUpdate();

  try {
    const [transfersRes, peersRes, inboxRes] = await Promise.all([
      client.request<{ transfers: FileTransfer[] }>("fileTransfer.list", {}),
      client.request<{ peers: FileTransferPeer[] }>("fileTransfer.peers.list", {}),
      client.request<{ files: InboxFile[] }>("fileTransfer.inbox.list", {}),
    ]);

    state.transfers = (transfersRes as any)?.transfers ?? [];
    state.peers = (peersRes as any)?.peers ?? [];
    state.inboxFiles = (inboxRes as any)?.files ?? [];

    // Compute aggregate stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    state.totalBytesTransferred = state.transfers
      .filter((t) => t.status === "completed")
      .reduce((sum, t) => sum + t.fileSize, 0);

    state.completedToday = state.transfers.filter(
      (t) =>
        t.status === "completed" &&
        t.finishedAt !== undefined &&
        t.finishedAt >= todayMs
    ).length;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    requestUpdate();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Transfer Actions
// ══════════════════════════════════════════════════════════════════════════════

export async function sendFile(
  client: GatewayBrowserClient,
  state: FileTransferState,
  filePath: string,
  toNodes: string[],
  requestUpdate: () => void
): Promise<string | null> {
  try {
    const res = await client.request<{ transferId: string }>(
      "fileTransfer.send",
      { filePath, toNodes }
    );
    const transferId = (res as any)?.transferId ?? null;

    // Reload transfers list to pick up the new transfer
    await loadFileTransferData(client, state, requestUpdate);

    return transferId;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    requestUpdate();
    return null;
  }
}

export async function pauseTransfer(
  client: GatewayBrowserClient,
  state: FileTransferState,
  id: string,
  requestUpdate: () => void
): Promise<void> {
  try {
    await client.request("fileTransfer.pause", { id });
    await loadFileTransferData(client, state, requestUpdate);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    requestUpdate();
  }
}

export async function resumeTransfer(
  client: GatewayBrowserClient,
  state: FileTransferState,
  id: string,
  requestUpdate: () => void
): Promise<void> {
  try {
    await client.request("fileTransfer.resume", { id });
    await loadFileTransferData(client, state, requestUpdate);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    requestUpdate();
  }
}

export async function cancelTransfer(
  client: GatewayBrowserClient,
  state: FileTransferState,
  id: string,
  requestUpdate: () => void
): Promise<void> {
  try {
    await client.request("fileTransfer.cancel", { id });
    await loadFileTransferData(client, state, requestUpdate);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    requestUpdate();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UI State Helpers
// ══════════════════════════════════════════════════════════════════════════════

export function togglePeerSelection(
  state: FileTransferState,
  peerId: string
): void {
  if (state.selectedPeers.has(peerId)) {
    state.selectedPeers.delete(peerId);
  } else {
    state.selectedPeers.add(peerId);
  }
}

export function setDragOver(state: FileTransferState, value: boolean): void {
  state.dragOver = value;
}

// ══════════════════════════════════════════════════════════════════════════════
// Formatting Utilities
// ══════════════════════════════════════════════════════════════════════════════

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function getOverallProgress(transfer: FileTransfer): number {
  const nodes = Object.keys(transfer.progress);
  if (nodes.length === 0) {
    return transfer.status === "completed" ? 100 : 0;
  }

  const totalChunks = transfer.totalChunks;
  if (totalChunks === 0) return 0;

  const avgChunksSent =
    nodes.reduce((sum, nodeId) => {
      const p = transfer.progress[nodeId];
      return sum + (p?.chunksSent ?? 0);
    }, 0) / nodes.length;

  return Math.min(100, Math.round((avgChunksSent / totalChunks) * 100));
}
