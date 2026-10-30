export type ChatAttachment = {
  id: string;
  dataUrl: string;
  mimeType: string;
  /** Original file name (shown on document/video chips and used for extraction). */
  fileName?: string;
  size?: number;
  /** Browser-only handle retained so a failed preparation can be retried. */
  sourceFile?: File;
  /** Durable local/secure OCR entry created before the chat turn starts. */
  ocrId?: string;
  /** Files-root relative path for normal-lane uploads. */
  filePath?: string;
  secure?: boolean;
  extractionStatus?: "reading" | "uploading" | "queued" | "processing" | "done" | "failed";
  extractionProgress?: { done: number; total: number; stage: string };
  uploadProgress?: number;
  error?: string;
  /** Video attachments: analyst agents to run once the video is processed. */
  analysts?: string[];
};

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
};

export const CRON_CHANNEL_LAST = "last";

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  scheduleKind: "at" | "every" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payloadKind: "systemEvent" | "agentTurn";
  payloadText: string;
  deliver: boolean;
  channel: string;
  to: string;
  timeoutSeconds: string;
  postToMainPrefix: string;
};
