/**
 * Auto-OCR pipeline types.
 *
 * Every uploaded image or document gets a registry entry (one per lane) that
 * doubles as its durable job record, and a sidecar holding the extracted text,
 * the local vision-model description, per-page text and provenance.
 */

export type OcrLane = "normal" | "secure";

export type OcrStatus = "queued" | "processing" | "done" | "failed";

export type OcrSourceKind =
  | "files"
  | "chat"
  | "groupchat"
  | "documents"
  | "channel"
  | "secure-files";

export interface OcrSource {
  kind: OcrSourceKind;
  projectId?: string;
  sessionKey?: string;
  agentId?: string;
  /** documents workspace node id (kind = documents). */
  docId?: string;
  /** Channel name for inbound media (telegram, whatsapp, …). */
  channel?: string;
}

/** Registry row = file identity + durable job state. */
export interface OcrEntry {
  id: string;
  lane: OcrLane;
  name: string;
  /** Absolute path (normal lane). Secure-lane bytes live in the vault, so null. */
  path: string | null;
  ext: string;
  mime: string;
  size: number;
  sha256: string;
  status: OcrStatus;
  attempts: number;
  /** Epoch ms before which a retry must not start. */
  nextAttemptAt: number;
  /** Higher runs first (chat attachments jump the queue). */
  priority: number;
  error?: string;
  source: OcrSource;
  createdAt: number;
  updatedAt: number;
  /** Filled when done (cheap list/search rendering without the sidecar). */
  summary?: string;
  chars?: number;
  pages?: number;
  confidence?: number | null;
  vlModel?: string | null;
  /** Normal lane: where the sidecar JSON lives (next to the file when writable). */
  sidecarPath?: string;
  /** Live progress for multi-page documents. */
  progress?: { done: number; total: number; stage: string };
}

export type OcrPageMethod = "text-layer" | "ocr" | "vl" | "native";

export interface OcrPage {
  page: number;
  method: OcrPageMethod;
  text: string;
  /** Mean OCR line confidence 0..1; null for text-layer/native text. */
  confidence: number | null;
  /** VL reading of a low-confidence page (scanned PDFs). */
  vlText?: string;
}

/**
 * One analyzer's result on a file (OCR is the base layer; video analysis,
 * specialist-agent reviews etc. append entries here).
 */
export interface OcrAnalysis {
  /** Unique per sidecar, e.g. "video:frames" or "agent:legal-review:1". */
  id: string;
  /** Analyzer / handler id. */
  analyzer: string;
  agentId?: string;
  model?: string | null;
  createdAt: number;
  summary: string;
  findings?: Array<{
    title: string;
    detail?: string;
    severity?: "info" | "low" | "medium" | "high";
    at?: number;
  }>;
  /** Time-coded observations (video) — t in seconds. */
  frames?: Array<{ t: number; text?: string; description?: string }>;
  /** Free-form structured payload owned by the analyzer. */
  data?: Record<string, unknown>;
}

export interface OcrSidecar {
  version: 1;
  id: string;
  lane: OcrLane;
  name: string;
  sha256: string;
  mime: string;
  ext: string;
  /** True once every tier ran; partial sidecars let a restart resume page by page. */
  complete: boolean;
  /** Stage reached: "text" = OCR/native text ready, "vl" = description ready. */
  stage: "text" | "vl";
  /** Markdown text of the whole file (native or OCR). */
  markdown: string;
  /** Local vision-model description (markdown) or null. */
  description: string | null;
  entities: string[];
  pages: OcrPage[];
  pageCount: number;
  /** Mean OCR confidence across OCR'd pages; null when no OCR ran. */
  confidence: number | null;
  engines: { text: string[]; ocr: string | null; vl: string | null };
  warnings: string[];
  /** Per-analyzer results (see OcrAnalysis). Older sidecars may omit it. */
  analyses?: OcrAnalysis[];
  /** Opaque block owned by the video analyzer (src/media/video-analysis). */
  video?: unknown;
  source: OcrSource;
  createdAt: number;
  updatedAt: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  /** [x0,y0,x1,y1] in pixels. */
  box: [number, number, number, number];
}

export interface OcrImageResult {
  lines: OcrLine[];
  width: number;
  height: number;
}

/** Pluggable local engines (fakes in tests). */
export interface OcrEngines {
  /** OCR several images in one process; returns per-image results. */
  ocrImages(paths: string[]): Promise<OcrImageResult[]>;
  /** Convert any image (heic/webp/gif/tiff/bmp) to PNG; returns the png path. */
  toPng(input: string, outDir: string): Promise<string>;
  pdfPageCount(pdf: string): Promise<number>;
  pdfPageText(pdf: string, page: number): Promise<string>;
  /** Render one PDF page to PNG; returns the png path. */
  pdfRenderPage(pdf: string, page: number, outDir: string, dpi?: number): Promise<string>;
  /** Native text for office/html/text docs (markdown) or null. */
  nativeText(filePath: string, ext: string): Promise<string | null>;
  /** Local vision model chat: image(s) + prompt → answer. Null when no VL model. */
  vl: {
    model(): Promise<string | null>;
    ask(params: {
      images: string[];
      prompt: string;
      timeoutMs?: number;
      /**
       * Asked on behalf of a running chat turn (inspect, the turn's own
       * analyses, chat attachments): skip the background GPU lease — the
       * turn already holds the runtime, and waiting for it to go idle would
       * deadlock the turn on its own tool call.
       */
      interactive?: boolean;
    }): Promise<{ text: string; model: string }>;
  } | null;
  ocrEngineName(): Promise<string | null>;
}
