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
  progress: Record<string, { chunksSent: number; bytesSent: number; lastChunkAt: number }>;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  savedPath?: string;
}

// Federation message payloads
export interface FileTransferStartPayload {
  transferId: string;
  fromNode: string;
  toNodes: string[];
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
}

export interface FileTransferChunkPayload {
  transferId: string;
  toNodeId: string;
  chunkIndex: number;
  data: string; // base64
}

export interface FileTransferChunkAckPayload {
  transferId: string;
  fromNodeId: string;
  chunkIndex: number;
}

export interface FileTransferCompletePayload {
  transferId: string;
  toNodeId: string;
  sha256: string;
}

export interface FileTransferErrorPayload {
  transferId: string;
  toNodeId: string;
  error: string;
}

export interface FileTransferControlPayload {
  transferId: string;
  toNodeId: string;
}
