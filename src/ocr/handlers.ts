/**
 * Extraction handler registry — the extension point of the auto-OCR pipeline.
 *
 * Every queued file is dispatched to the first registered handler that claims
 * its extension or MIME type (highest `priority` wins). Built-in handlers
 * (image, pdf, office) are registered by ./extract.ts; other analyzers (e.g.
 * video) register their own:
 *
 *   import { registerExtractionHandler } from "../ocr/handlers.js";
 *   registerExtractionHandler({
 *     id: "video",
 *     exts: [".mp4", ".mov", ".webm"],
 *     mimes: [/^video\//],
 *     defaultMime: { ".mp4": "video/mp4" },
 *     async extract(params, { saveProgress }) {
 *       // params.filePath is a readable copy (tmpfs for the secure lane);
 *       // params.engines.vl is the loopback-only vision client.
 *       const sc = newSidecar(params);           // from ./extract.ts
 *       …
 *       return sc;                               // complete: true when finished
 *     },
 *   });
 *
 * Contract:
 *   - Local-only: use params.engines (loopback Ollama, offline OCR) or other
 *     on-device tools. Never call cloud APIs.
 *   - Secure lane (params.entry.lane === "secure"): write scratch files only
 *     under params.tmpDir (tmpfs) and never log file names or content.
 *   - Long jobs call saveProgress(partialSidecar, {done,total,stage}); a
 *     restart re-runs the handler with params.prior = that partial sidecar so
 *     it can resume.
 *   - Throw to fail the attempt; the queue retries with exponential backoff.
 *   - Per-analyzer results go in sidecar.analyses[] (see OcrAnalysis); the
 *     service also exposes addAnalysis() for analyzers that run after OCR.
 */
import type { ExtractParams } from "./extract.js";
import type { OcrSidecar } from "./types.js";

export interface ExtractionHelpers {
  saveProgress: (
    partial: OcrSidecar,
    progress: { done: number; total: number; stage: string },
  ) => void;
}

export interface ExtractionHandler {
  /** Stable id, recorded on the registry row (`entry.kind`). */
  id: string;
  /** Lower-case extensions with the dot (".mp4"). */
  exts?: readonly string[];
  /** MIME matchers ("video/mp4" or /^video\//). */
  mimes?: ReadonlyArray<string | RegExp>;
  /** MIME to record for an extension when the upload did not say. */
  defaultMime?: Record<string, string>;
  /** Higher wins when several handlers claim a file (built-ins are 0). */
  priority?: number;
  extract(params: ExtractParams, helpers: ExtractionHelpers): Promise<OcrSidecar>;
}

const handlers = new Map<string, ExtractionHandler>();

export function registerExtractionHandler(handler: ExtractionHandler): () => void {
  handlers.set(handler.id, handler);
  return () => {
    if (handlers.get(handler.id) === handler) handlers.delete(handler.id);
  };
}

export function listExtractionHandlers(): ExtractionHandler[] {
  return [...handlers.values()];
}

export function resolveExtractionHandler(
  ext: string,
  mime?: string | null,
): ExtractionHandler | null {
  const e = ext.toLowerCase();
  const m = (mime ?? "").toLowerCase();
  let best: ExtractionHandler | null = null;
  for (const h of handlers.values()) {
    const byExt = h.exts?.includes(e) ?? false;
    const byMime =
      Boolean(m) && (h.mimes ?? []).some((x) => (typeof x === "string" ? x === m : x.test(m)));
    if (!byExt && !byMime) continue;
    if (!best || (h.priority ?? 0) > (best.priority ?? 0)) best = h;
  }
  return best;
}

export function defaultMimeFor(ext: string): string | null {
  const e = ext.toLowerCase();
  for (const h of handlers.values()) {
    const v = h.defaultMime?.[e];
    if (v) return v;
  }
  return null;
}
