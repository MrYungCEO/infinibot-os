/**
 * Tiered extraction for one file.
 *
 *   images   → OCR (RapidOCR) + VL description (always, when a local VL model exists)
 *   PDFs     → per page: text layer first; pages without one are rendered and
 *              OCR'd; low-confidence/empty OCR pages also get a VL reading
 *              (capped). Progress is saved after every page so a restart
 *              resumes where it stopped.
 *   office   → native text (docx/pptx/xlsx/…); no OCR needed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { layoutLines, meanConfidence } from "./engines.js";
import {
  registerExtractionHandler,
  resolveExtractionHandler,
  type ExtractionHelpers,
} from "./handlers.js";
import type { OcrRuntimeConfig } from "./local-only.js";
import type { OcrEngines, OcrEntry, OcrPage, OcrSidecar } from "./types.js";

export const IMAGE_EXTS = new Set([
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
]);
export const PDF_EXTS = new Set([".pdf"]);
export const OFFICE_EXTS = new Set([".docx", ".pptx", ".xlsx", ".doc", ".odt", ".rtf", ".epub"]);
export const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json", ".log"]);

export type OcrKind = string;

/** Id of the handler that will process this extension (null = not queued). */
export function ocrKindForExt(ext: string, mime?: string | null): OcrKind | null {
  return resolveExtractionHandler(ext, mime)?.id ?? null;
}

export function isOcrCandidate(name: string, mime?: string | null): boolean {
  return ocrKindForExt(path.extname(name), mime) !== null;
}

export const IMAGE_DESCRIBE_PROMPT = [
  "You are a careful document and screenshot reader. Describe this image for a search index and an assistant that cannot see it.",
  "Answer in markdown with exactly these sections:",
  "## Summary",
  "One to three sentences: what the image shows (kind of document, app screen, photo…) and its purpose.",
  "## Text",
  "Every piece of readable text, verbatim, in reading order. Keep layout: use markdown tables for tables, bullet lists for lists. Write [illegible] for unreadable parts.",
  "## Key entities",
  "A bullet list of names, organisations, amounts, dates, IDs, URLs, emails and phone numbers that appear.",
  "Do not invent text that is not visible.",
].join("\n");

export const PAGE_READ_PROMPT =
  "Read this scanned page. Output only its text verbatim in reading order as markdown (tables as markdown tables). Write [illegible] for unreadable parts. No commentary.";

export function parseEntities(description: string | null): string[] {
  if (!description) return [];
  const m = /##\s*Key entities\s*\n([\s\S]*?)(?:\n##\s|$)/i.exec(description);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l && !/^none\b/i.test(l))
    .slice(0, 60);
}

export interface ExtractParams {
  entry: OcrEntry;
  /** Readable path to the bytes (secure lane: a tmpfs copy). */
  filePath: string;
  engines: OcrEngines;
  cfg: OcrRuntimeConfig;
  /** A partial sidecar from an interrupted run of the same bytes. */
  prior?: OcrSidecar | null;
  /** Persist partial progress (after each page / tier). */
  onProgress?: (
    partial: OcrSidecar,
    progress: { done: number; total: number; stage: string },
  ) => void;
  now?: () => number;
  /** Scratch dir for renders/conversions (secure lane: tmpfs). */
  tmpDir?: string;
}

/** A fresh (or resumed) sidecar for a handler to fill in. */
export function newSidecar(params: Pick<ExtractParams, "entry" | "prior" | "now">): OcrSidecar {
  return baseSidecar(params.entry, (params.now ?? Date.now)(), params.prior);
}

function baseSidecar(entry: OcrEntry, now: number, prior?: OcrSidecar | null): OcrSidecar {
  if (prior && prior.sha256 === entry.sha256 && prior.version === 1) {
    return { ...prior, id: entry.id, name: entry.name, source: entry.source, updatedAt: now };
  }
  return {
    version: 1,
    id: entry.id,
    lane: entry.lane,
    name: entry.name,
    sha256: entry.sha256,
    mime: entry.mime,
    ext: entry.ext,
    complete: false,
    stage: "text",
    markdown: "",
    description: null,
    entities: [],
    pages: [],
    pageCount: 0,
    confidence: null,
    engines: { text: [], ocr: null, vl: null },
    warnings: [],
    analyses: [],
    source: entry.source,
    createdAt: now,
    updatedAt: now,
  };
}

function aggregateConfidence(pages: OcrPage[]): number | null {
  const c = pages.map((p) => p.confidence).filter((v): v is number => typeof v === "number");
  if (!c.length) return null;
  return Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 1000) / 1000;
}

function pagesMarkdown(pages: OcrPage[], multi: boolean): string {
  return pages
    .map((p) => {
      const body = (p.vlText && (p.confidence ?? 1) < 0.6 ? p.vlText : p.text).trim();
      return multi ? `## Page ${p.page}\n\n${body || "_(no text)_"}` : body;
    })
    .join("\n\n")
    .trim();
}

function addEngine(list: string[], name: string) {
  if (!list.includes(name)) list.push(name);
}

/** Dispatch one file to its registered handler. Throws on a hard failure (the queue retries). */
export async function extractFile(params: ExtractParams): Promise<OcrSidecar> {
  const handler = resolveExtractionHandler(params.entry.ext, params.entry.mime);
  if (!handler) throw new Error(`unsupported file type ${params.entry.ext}`);
  const helpers: ExtractionHelpers = {
    saveProgress: (partial, progress) => params.onProgress?.(structuredClone(partial), progress),
  };
  const sc = await handler.extract(params, helpers);
  sc.analyses ??= [];
  return sc;
}

/** Built-in tiers for images, PDFs and office documents. */
async function builtinExtract(
  params: ExtractParams,
  kind: "image" | "pdf" | "office",
): Promise<OcrSidecar> {
  const now = params.now ?? Date.now;
  const { entry, engines, cfg, filePath } = params;
  const sc = baseSidecar(entry, now(), params.prior);
  const save = (stage: string, done: number, total: number) => {
    sc.updatedAt = now();
    params.onProgress?.(structuredClone(sc), { done, total, stage });
  };
  const scratchBase = params.tmpDir ?? os.tmpdir();
  fs.mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(scratchBase, "ib-ocr-"));
  try {
    const ocrName = await engines.ocrEngineName();
    const vlModel =
      engines.vl && cfg.vlMode !== "off" ? await engines.vl.model().catch(() => null) : null;

    if (kind === "office") {
      const md = (await engines.nativeText(filePath, entry.ext.toLowerCase())) ?? "";
      sc.pages = [{ page: 1, method: "native", text: md, confidence: null }];
      sc.pageCount = 1;
      sc.markdown = md.trim();
      addEngine(sc.engines.text, "native");
      if (!sc.markdown) sc.warnings.push("no text found in document");
      sc.stage = "vl";
      sc.complete = true;
      return sc;
    }

    if (kind === "image") {
      const ext = entry.ext.toLowerCase();
      const png =
        ext === ".png" || ext === ".jpg" || ext === ".jpeg"
          ? filePath
          : await engines.toPng(filePath, tmp);
      if (!sc.pages.length) {
        if (ocrName) {
          const [res] = await engines.ocrImages([png]);
          const text = res ? layoutLines(res) : "";
          sc.pages = [
            { page: 1, method: "ocr", text, confidence: res ? meanConfidence(res) : null },
          ];
          sc.engines.ocr = ocrName;
          addEngine(sc.engines.text, "ocr");
        } else {
          sc.warnings.push("no local OCR engine installed (RapidOCR venv missing)");
          sc.pages = [{ page: 1, method: "ocr", text: "", confidence: null }];
        }
        sc.pageCount = 1;
        sc.confidence = aggregateConfidence(sc.pages);
        sc.markdown = pagesMarkdown(sc.pages, false);
        save("text", 1, 2);
      }
      if (vlModel && engines.vl && !sc.description) {
        try {
          const r = await engines.vl.ask({ images: [png], prompt: IMAGE_DESCRIBE_PROMPT });
          sc.description = r.text || null;
          sc.engines.vl = r.model;
          sc.entities = parseEntities(sc.description);
          if (!sc.markdown.trim() && sc.description) {
            // No OCR engine: the VL transcript is the only text we have.
            const t = /##\s*Text\s*\n([\s\S]*?)(?:\n##\s|$)/i.exec(sc.description);
            sc.markdown = (t?.[1] ?? "").trim();
            sc.pages[0] = { ...sc.pages[0], method: "vl", text: sc.markdown };
          }
        } catch (err) {
          if (!ocrName) throw err;
          sc.warnings.push(`vision pass failed: ${(err as Error).message}`);
        }
      } else if (!vlModel) {
        sc.warnings.push("no local vision model available; description skipped");
      }
      if (!ocrName && !sc.description) {
        throw new Error("no local OCR engine or vision model available");
      }
      sc.stage = "vl";
      sc.complete = true;
      return sc;
    }

    // PDF, page by page.
    const total = await engines.pdfPageCount(filePath);
    if (!total) throw new Error("could not read PDF page count");
    const limit = Math.min(total, cfg.maxPages);
    if (total > limit) sc.warnings.push(`only the first ${limit} of ${total} pages were processed`);
    sc.pageCount = total;
    const donePages = new Set(sc.pages.map((p) => p.page));
    let vlUsed = sc.pages.filter((p) => p.vlText !== undefined).length;
    for (let page = 1; page <= limit; page++) {
      if (donePages.has(page)) continue;
      const layer = (await engines.pdfPageText(filePath, page).catch(() => "")).trim();
      let rec: OcrPage;
      if (layer.replace(/\s+/g, "").length >= 40) {
        rec = { page, method: "text-layer", text: layer, confidence: null };
        addEngine(sc.engines.text, "pdf-text-layer");
      } else {
        const png = await engines.pdfRenderPage(filePath, page, tmp);
        if (ocrName) {
          const [res] = await engines.ocrImages([png]);
          rec = {
            page,
            method: "ocr",
            text: res ? layoutLines(res) : "",
            confidence: res ? meanConfidence(res) : null,
          };
          sc.engines.ocr = ocrName;
          addEngine(sc.engines.text, "ocr");
        } else {
          rec = { page, method: "ocr", text: layer, confidence: null };
          if (!sc.warnings.includes("no local OCR engine installed (RapidOCR venv missing)")) {
            sc.warnings.push("no local OCR engine installed (RapidOCR venv missing)");
          }
        }
        const weak =
          rec.confidence === null ||
          rec.confidence < cfg.lowConfidence ||
          rec.text.replace(/\s+/g, "").length < 20;
        if (weak && vlModel && engines.vl && vlUsed < cfg.maxVlPages) {
          try {
            const r = await engines.vl.ask({ images: [png], prompt: PAGE_READ_PROMPT });
            rec.vlText = r.text;
            sc.engines.vl = r.model;
            vlUsed++;
            if (!rec.text.trim()) rec = { ...rec, method: "vl", text: r.text };
          } catch (err) {
            sc.warnings.push(`vision pass failed on page ${page}: ${(err as Error).message}`);
          }
        }
        fs.rmSync(png, { force: true });
      }
      sc.pages.push(rec);
      sc.pages.sort((a, b) => a.page - b.page);
      sc.confidence = aggregateConfidence(sc.pages);
      sc.markdown = pagesMarkdown(sc.pages, total > 1);
      save("pages", sc.pages.length, limit);
    }
    if (!sc.markdown.replace(/_\(no text\)_|## Page \d+/g, "").trim()) {
      sc.warnings.push("no text found in PDF");
    }
    sc.stage = "vl";
    sc.complete = true;
    return sc;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

registerExtractionHandler({
  id: "image",
  exts: [...IMAGE_EXTS],
  mimes: [/^image\/(png|jpe?g|webp|heic|heif|gif|bmp|tiff)$/],
  extract: (p) => builtinExtract(p, "image"),
});
registerExtractionHandler({
  id: "pdf",
  exts: [...PDF_EXTS],
  mimes: ["application/pdf"],
  extract: (p) => builtinExtract(p, "pdf"),
});
registerExtractionHandler({
  id: "office",
  exts: [...OFFICE_EXTS],
  extract: (p) => builtinExtract(p, "office"),
});
registerExtractionHandler({
  id: "text",
  exts: [...TEXT_EXTS],
  mimes: ["text/plain", "text/markdown", "text/csv", "application/json"],
  defaultMime: {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".log": "text/plain",
  },
  extract: (p) => builtinExtract(p, "office"),
});
