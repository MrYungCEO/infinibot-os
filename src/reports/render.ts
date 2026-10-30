/**
 * The canonical PDF entry point.
 *
 *   renderReport(payload) -> Promise<Buffer>
 *
 * Every future agent that needs a PDF should call THIS, not pandoc /
 * wkhtmltopdf / weasyprint / a hand-rolled puppeteer script. It builds the
 * black-gold HTML from a structured payload (see ./template.ts) and prints it
 * to a PDF via the shared puppeteer-core renderer (./renderer.ts), returning the
 * bytes. Optionally writes the file to disk and/or sends it to Telegram.
 *
 * puppeteer-core is imported lazily inside renderer.ts, so importing this module
 * is cheap; the heavy browser launch only happens when you actually render.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportPayload } from "./types.js";
import { renderReportHtml } from "./template.js";
import { getTheme } from "./themes/index.js";
import { renderHtmlToPdf } from "./renderer.js";
import { sendDocumentTelegram, type TelegramSinkResult } from "./sinks/telegram.js";

export interface RenderReportOptions {
  /** Also write the rendered PDF to this absolute path (kept after return). */
  savePath?: string;
}

/**
 * Render a structured report payload to a PDF Buffer using the black-gold
 * template. If `opts.savePath` is given the PDF is also persisted there.
 */
export async function renderReport(
  payload: ReportPayload,
  opts: RenderReportOptions = {},
): Promise<Buffer> {
  const theme = getTheme(payload.theme);
  const html = renderReportHtml(payload, theme);

  // renderHtmlToPdf writes to a path; render to a scratch file, read it back as
  // a Buffer, then clean up. If a savePath is requested, render straight there.
  if (opts.savePath) {
    await renderHtmlToPdf(html, opts.savePath);
    return readFileSync(opts.savePath);
  }

  const dir = mkdtempSync(join(tmpdir(), "ib-report-"));
  const scratch = join(dir, "report.pdf");
  try {
    await renderHtmlToPdf(html, scratch);
    return readFileSync(scratch);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export interface SendReportOptions extends RenderReportOptions {
  /** Telegram caption (defaults to the payload title). */
  caption?: string;
  /** Override the configured default chat id. */
  chatId?: string;
  /** Filename for the uploaded document (default: derived from the title). */
  filename?: string;
}

export interface SendReportResult extends TelegramSinkResult {
  /** Absolute path the PDF was written to (the savePath, or a temp file). */
  filePath: string;
  /** Size of the rendered PDF in bytes. */
  bytes: number;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}

/**
 * Render a payload and deliver it to Telegram in one call. Writes the PDF to
 * `opts.savePath` if given, otherwise to a temp file (kept, so the caller can
 * register/ingest it afterwards). Never throws — Telegram failures come back in
 * the result `{ ok: false, error }`.
 */
export async function sendReportToTelegram(
  payload: ReportPayload,
  opts: SendReportOptions = {},
): Promise<SendReportResult> {
  const filename = opts.filename ?? `${slugify(payload.title)}.pdf`;
  const dir = mkdtempSync(join(tmpdir(), "ib-report-"));
  const filePath = opts.savePath ?? join(dir, filename);

  const buf = await renderReport(payload, { savePath: filePath });
  writeFileSync(filePath, buf); // ensure bytes are on disk at filePath

  const result = await sendDocumentTelegram(filePath, {
    caption: opts.caption ?? payload.title,
    chatId: opts.chatId,
  });

  return { ...result, filePath, bytes: buf.length };
}
