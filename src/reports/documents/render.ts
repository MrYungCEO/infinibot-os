/**
 * Render entry points for invoices and proposals.
 *
 * HTML rendering is synchronous and dependency-free — safe to call from the
 * gateway for an in-app preview.
 *
 * PDF rendering delegates to the report system's single renderer
 * (`../renderer.ts`), which owns Chrome discovery, the remote-service fallback
 * and browser teardown. Two deliberate choices here:
 *
 *  - `renderHtmlToPdf` is imported **dynamically**, so merely importing this
 *    module (as the gateway does, for the preview path) never pulls puppeteer's
 *    module graph in. That preserves the renderer's documented boundary: the
 *    browser only ever launches inside the worker, or inside an explicit
 *    synchronous PDF call.
 *  - The call is wrapped in an outer timeout. The renderer already bounds
 *    `setContent`, but a browser that hangs *before* that (a wedged Chrome
 *    process, a stalled remote render service) would otherwise block the caller
 *    indefinitely. The inner `finally` still closes the browser; this just
 *    stops the caller waiting on it.
 *
 * The normal production path is neither of these: enqueue an `agency_invoice` /
 * `agency_proposal` report and let the worker render it. Use the PDF helpers
 * only when the bytes are needed inline.
 */

import { getTheme } from "../themes/index.js";
import type { Theme } from "../types.js";
import { DEFAULT_DOCUMENT_THEME } from "./mapper.js";
import { buildInvoiceHtml, buildInvoicePreviewFragment } from "../templates/invoice.js";
import { buildProposalHtml, buildProposalPreviewFragment } from "../templates/proposal.js";
import type { InvoiceDocumentModel, ProposalDocumentModel } from "./types.js";

export interface RenderDocumentHtmlOptions {
  /** Theme name or object. Defaults to the client-facing letterhead theme. */
  theme?: Theme | string | null;
  /**
   * Return a `<style>` + markup fragment for embedding in the app's preview
   * pane instead of a standalone document. The markup is identical either way,
   * which is the point: preview and PDF can never drift.
   */
  fragment?: boolean;
}

function resolveTheme(theme?: Theme | string | null): Theme {
  if (theme && typeof theme === "object") return theme;
  return getTheme(theme ?? DEFAULT_DOCUMENT_THEME);
}

export function renderInvoiceDocumentHtml(
  model: InvoiceDocumentModel,
  options: RenderDocumentHtmlOptions = {},
): string {
  const theme = resolveTheme(options.theme);
  return options.fragment
    ? buildInvoicePreviewFragment(model, theme)
    : buildInvoiceHtml(model, theme);
}

export function renderProposalDocumentHtml(
  model: ProposalDocumentModel,
  options: RenderDocumentHtmlOptions = {},
): string {
  const theme = resolveTheme(options.theme);
  return options.fragment
    ? buildProposalPreviewFragment(model, theme)
    : buildProposalHtml(model, theme);
}

export interface RenderDocumentPdfOptions extends RenderDocumentHtmlOptions {
  /** Absolute path to write the PDF to. */
  outPath: string;
  /** Ceiling on the whole render, browser launch included. Default 60s. */
  timeoutMs?: number;
}

/** Default ceiling — generous enough for a cold Chrome start on Windows. */
export const DEFAULT_DOCUMENT_RENDER_TIMEOUT_MS = 60_000;

async function renderPdf(html: string, options: RenderDocumentPdfOptions): Promise<string> {
  const { renderHtmlToPdf } = await import("../renderer.js");
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOCUMENT_RENDER_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      renderHtmlToPdf(html, options.outPath),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`document render timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        // Don't hold the event loop open purely for the timeout.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return options.outPath;
}

/** Render an invoice straight to a PDF file. Resolves with the written path. */
export function renderInvoiceDocumentPdf(
  model: InvoiceDocumentModel,
  options: RenderDocumentPdfOptions,
): Promise<string> {
  return renderPdf(renderInvoiceDocumentHtml(model, options), options);
}

/** Render a proposal straight to a PDF file. Resolves with the written path. */
export function renderProposalDocumentPdf(
  model: ProposalDocumentModel,
  options: RenderDocumentPdfOptions,
): Promise<string> {
  return renderPdf(renderProposalDocumentHtml(model, options), options);
}
