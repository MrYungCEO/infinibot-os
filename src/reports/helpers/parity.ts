/**
 * Parity-context attach — turn a saved report artifact into the markdown copy
 * every agent reads.
 *
 * The mesh plan wants "full parity context": on save, every document is also
 * available as plain markdown so any sub-agent can consume the whole corpus
 * without parsing PDFs. This helper is the single chokepoint that:
 *   1. runs markitdown on the artifact on disk,
 *   2. writes a sibling `<id>.md` next to the artifact in the reports dir,
 *   3. patches the report row with markdown_body / markdown_path / original_format.
 *
 * It is best-effort and never throws — if markitdown is missing or the format is
 * unsupported, the report stays exactly as it was (PDF only) and the failure is
 * returned for logging.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReportsStore } from "../store.js";
import { convertToMarkdown, originalFormatOf } from "./markitdown.js";

export interface AttachParityInput {
  store: ReportsStore;
  /** The report row id to attach markdown to. */
  reportId: string;
  /** Absolute path of the rendered/ingested artifact (pdf/docx/html/...). */
  filePath: string;
  /** Override the detected source format. */
  originalFormat?: string | null;
}

export interface AttachParityResult {
  ok: boolean;
  markdownPath?: string;
  chars?: number;
  error?: string;
}

/**
 * Convert `filePath` to markdown, persist it next to the artifact, and update
 * the report row. Returns `{ ok:false, error }` without throwing on any failure.
 */
export async function attachMarkdownParity(input: AttachParityInput): Promise<AttachParityResult> {
  const { store, reportId, filePath } = input;
  const originalFormat = input.originalFormat ?? originalFormatOf(filePath);

  // Always record the source format even if conversion later fails.
  try {
    store.updateReport(reportId, { originalFormat });
  } catch {
    /* row may have been deleted concurrently — nothing to attach to */
  }

  const conv = await convertToMarkdown(filePath);
  if (!conv.ok || !conv.markdown) {
    return { ok: false, error: conv.error ?? "conversion produced no markdown" };
  }

  // Write the sibling .md alongside the canonical artifact (`<id>.md`).
  const mdPath = join(dirname(filePath), `${reportId}.md`);
  try {
    writeFileSync(mdPath, conv.markdown, "utf8");
  } catch (err) {
    return { ok: false, error: `failed to write markdown: ${(err as Error).message}` };
  }

  try {
    store.updateReport(reportId, {
      markdownBody: conv.markdown,
      markdownPath: mdPath,
      originalFormat,
    });
  } catch (err) {
    return { ok: false, error: `failed to update row: ${(err as Error).message}` };
  }

  return { ok: true, markdownPath: mdPath, chars: conv.markdown.length };
}
