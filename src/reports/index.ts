/**
 * InfiniBot Report System — public surface.
 *
 * THE ONE PDF PATH. Any code that needs a PDF should import from here:
 *
 *   import { renderReport, sendReportToTelegram } from "../reports/index.js";
 *   const pdf = await renderReport(payload);                 // -> Buffer
 *   await sendReportToTelegram(payload, { caption: "..." }); // render + deliver
 *
 * Do not call pandoc / wkhtmltopdf / weasyprint or hand-roll puppeteer for
 * reports — that is exactly the drift this module exists to kill. Build a
 * {@link ReportPayload} (optionally via a builder) and render through here so
 * every PDF gets the same black-gold treatment.
 *
 * See docs/reports.md for the full guide.
 */

// Core render + deliver
export {
  renderReport,
  sendReportToTelegram,
  type RenderReportOptions,
  type SendReportOptions,
  type SendReportResult,
} from "./render.js";

// Template (for callers that want HTML without a PDF)
export { renderReportHtml } from "./template.js";

// Enqueue a report for the worker to render (the async, kind-based path)
export { enqueueReport, fireEventTriggers } from "./trigger.js";

// Common payload builders
export {
  buildAgentStatusPayload,
  buildSecurityPlanPayload,
  buildWeeklyDigestPayload,
  type AgentStatusInput,
  type AgentStatusRow,
  type SecurityPlanInput,
  type WeeklyDigestInput,
} from "./builders.js";

// Register an already-rendered PDF as a first-class report row
export {
  ingestExternalPdf,
  setReportAssociations,
  type IngestExternalPdfInput,
  type ReportAssociation,
} from "./helpers/external-pdf.js";

// Markdown → payload bridge (so a Markdown-only caller still gets the styled PDF)
export {
  markdownToPayload,
  type MarkdownToPayloadOverrides,
} from "./helpers/markdown-to-payload.js";

// Parity context — markdown corpus the agent mesh shares
export {
  getReportContext,
  type ReportContextOptions,
  type ReportContextResult,
  type ReportContextEntry,
} from "./helpers/report-context.js";
export {
  convertToMarkdown,
  markitdownAvailable,
  originalFormatOf,
  type MarkitdownResult,
} from "./helpers/markitdown.js";
export { attachMarkdownParity, type AttachParityResult } from "./helpers/parity.js";
export { categorizeReport, REPORT_CATEGORIES, type ReportCategory } from "./helpers/categorize.js";

// Client-facing documents (invoices, proposals) — report kinds, not a second
// engine. Build a model, preview it as HTML, and enqueue the matching kind to
// get a PDF through the normal worker path. See documents/index.ts.
export {
  buildInvoiceDocumentModel,
  buildProposalDocumentModel,
  renderInvoiceDocumentHtml,
  renderProposalDocumentHtml,
  invoiceSummaryText,
  proposalSummaryText,
  effectiveInvoiceStatus,
  effectiveProposalStatus,
  balanceCents,
  renderInvoiceDocumentPdf,
  renderProposalDocumentPdf,
  checkTotalsConsistency,
  resolveDocumentBrand,
  INVOICE_REPORT_KIND,
  PROPOSAL_REPORT_KIND,
  DEFAULT_DOCUMENT_THEME,
  type InvoiceDocumentModel,
  type ProposalDocumentModel,
  type DocumentBrand,
  type DocumentLineItem,
  type DocumentParty,
  type DocumentTotals,
  type BuildInvoiceModelInput,
  type BuildProposalModelInput,
} from "./documents/index.js";

// Payload schema + theme types
export type {
  ReportPayload,
  ReportSection,
  ReportTable,
  ReportMetric,
  Theme,
  ThemeTokens,
} from "./types.js";

export { getTheme, listThemes, DEFAULT_THEME } from "./themes/index.js";

// Link-only Telegram delivery — used by the infinite-canvas-walkthrough skill
// to post a deployed URL (NOT a PDF) for interactive canvas artifacts.
import { sendTelegramText, type TelegramTextResult } from "./sinks/telegram.js";
export { sendTelegramText, type TelegramTextResult } from "./sinks/telegram.js";

/**
 * Post a deployed infinite-canvas walkthrough URL to the configured Telegram
 * chat as a link-only message. Format: `🟡 <title>\n<url>`. Never throws.
 */
export function sendCanvasLinkToTelegram(
  url: string,
  title: string,
  opts: { chatId?: string } = {},
): Promise<TelegramTextResult> {
  const text = `🟡 ${title}\n${url}`;
  return sendTelegramText(text, { chatId: opts.chatId });
}
