/**
 * `agency_invoice` report kind — a branded, client-ready invoice PDF.
 *
 * Same contract as every other kind: `collect()` only reads, returns
 * `{ title, summaryText, html }`, and the worker persists the row, prints the
 * PDF to `~/.infinibot/reports/<id>.pdf`, attaches the markdown parity copy and
 * fans out to the configured sinks. An invoice is therefore a first-class
 * report row like anything else — listable, previewable, linkable to its client
 * and project.
 *
 * Unlike the operational kinds, this collector reads **nothing from disk**: the
 * gateway builds the document model from the agency-operations store (see
 * documents/mapper.ts) and passes it in `config.document`. The worker process
 * never opens `agency.db`.
 *
 * Config:
 *   - document:     InvoiceDocumentModel (required; see documents/types.ts)
 *   - brandSource?: raw `agency_profiles` fields — when present the brand is
 *                   re-layered against this report row's theme at render time
 *   - now?:         override for "as of" when the model omits `asOf` (tests)
 */

import type { CollectedReport, ReportKindModule, Theme } from "../types.js";
import { parseInvoiceDocument } from "../documents/parse.js";
import { INVOICE_REPORT_KIND } from "../documents/types.js";
import {
  buildInvoiceHtml,
  invoiceSummaryText,
  INVOICE_STATUS_LABELS,
} from "../templates/invoice.js";

export const invoiceReportKind: ReportKindModule = {
  kind: INVOICE_REPORT_KIND,
  collect({ theme, config }): CollectedReport {
    const now = typeof config.now === "number" ? config.now : Date.now();
    const model = parseInvoiceDocument(config as Record<string, unknown>, theme as Theme, now);
    return {
      title: `Invoice ${model.number} — ${model.client.name}`,
      summaryText: invoiceSummaryText(model),
      html: buildInvoiceHtml(model, theme as Theme),
      // Links the report row back to the invoice it renders.
      sourceRecordId: model.id || null,
    };
  },
};

export { INVOICE_STATUS_LABELS };
