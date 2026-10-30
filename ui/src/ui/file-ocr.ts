/**
 * Shared client-side helpers for local auto-OCR (Files page, chat attachments,
 * documents). Pure functions + types; the panel lives in
 * components/file-context-panel.ts.
 */

export type OcrStatus = "queued" | "processing" | "done" | "failed";

export interface OcrBadgeInfo {
  id: string;
  status: OcrStatus;
  error?: string;
  confidence?: number | null;
  progress?: { done: number; total: number; stage: string };
}

export interface OcrPageInfo {
  page: number;
  method: "text-layer" | "ocr" | "vl" | "native";
  text: string;
  confidence: number | null;
  vlText?: string;
}

export interface OcrSidecarInfo {
  id: string;
  name: string;
  complete: boolean;
  markdown: string;
  description: string | null;
  entities: string[];
  pages: OcrPageInfo[];
  pageCount: number;
  confidence: number | null;
  engines: { text: string[]; ocr: string | null; vl: string | null };
  warnings: string[];
  source: { kind: string; projectId?: string; sessionKey?: string };
  updatedAt: number;
}

export interface OcrEntryInfo {
  id: string;
  lane: "normal" | "secure";
  name: string;
  path: string | null;
  relPath?: string | null;
  ext: string;
  mime: string;
  size: number;
  status: OcrStatus;
  attempts: number;
  error?: string;
  summary?: string;
  pages?: number;
  confidence?: number | null;
  vlModel?: string | null;
  progress?: { done: number; total: number; stage: string };
  source: { kind: string; projectId?: string; sessionKey?: string };
  createdAt: number;
  updatedAt: number;
}

export interface OcrRefParams {
  id?: string;
  path?: string;
  sha256?: string;
  docId?: string;
  secure?: boolean;
}

const OCR_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".heic",
  ".heif",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".doc",
  ".odt",
  ".rtf",
  ".epub",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  // Videos are processed by the local video pipeline (src/media/video-analysis).
  ".mp4", ".m4v", ".mov", ".webm", ".mkv",
]);

export function isOcrFileName(name: string | null | undefined): boolean {
  const m = /\.[^.\\/]+$/.exec(name ?? "");
  return m ? OCR_EXTS.has(m[0].toLowerCase()) : false;
}

export function isImageFileName(name: string | null | undefined): boolean {
  return /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/i.test(name ?? "");
}

export function ocrStatusLabel(b: Pick<OcrBadgeInfo, "status" | "progress"> | null | undefined): string {
  if (!b) return "Not scanned";
  switch (b.status) {
    case "queued":
      return "OCR queued";
    case "processing":
      return b.progress?.total ? `Reading ${b.progress.done}/${b.progress.total}` : "Reading…";
    case "done":
      return "Text ready";
    case "failed":
      return "OCR failed";
  }
}

export function isOcrPending(status: OcrStatus | undefined): boolean {
  return status === "queued" || status === "processing";
}

/** sha256 of base64 content (chat attachments map to their OCR entry by hash). */
export async function sha256OfBase64(b64: string): Promise<string | null> {
  try {
    const clean = b64.replace(/^data:[^,]*,/, "");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Fetch a data: or blob: URL to base64 (chat history images). */
export async function urlToBase64(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url.slice(url.indexOf(",") + 1);
  try {
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  } catch {
    return null;
  }
}

export function formatConfidence(c: number | null | undefined): string {
  return typeof c === "number" ? `${Math.round(c * 100)}%` : "—";
}

export const OCR_CHANGED_EVENT = "files.ocr.changed";
/** Window event re-dispatched by the app for gateway `files.ocr.changed`. */
export const OCR_WINDOW_EVENT = "infinibot:ocr-changed";
