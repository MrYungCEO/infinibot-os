/**
 * Client-facing documents (invoices, proposals) — public surface.
 *
 * These are report *kinds*, not a separate engine: rendering, storage,
 * associations and delivery all belong to the report system. The intended
 * call sequence from the gateway is
 *
 *   const document = buildInvoiceDocumentModel({ invoice, client, lineItems, profile, ... });
 *   const html = renderInvoiceDocumentHtml(document);          // in-app preview
 *   enqueueReport({ kind: INVOICE_REPORT_KIND, theme: DEFAULT_DOCUMENT_THEME,
 *                   config: { document }, sinks: ["ui"] });    // -> worker renders the PDF
 *
 * `renderInvoiceDocumentPdf` exists for the rare synchronous case (an agent that
 * needs the bytes right now); it goes through the shared `renderReport` path's
 * renderer, so there is still exactly one puppeteer call site in the codebase.
 */

export type {
  AgencyDocumentModel,
  DocumentBrand,
  DocumentBrandColors,
  DocumentLineItem,
  DocumentParty,
  DocumentTotals,
  InvoiceDocumentModel,
  InvoiceDocumentStatus,
  InvoicePaymentRecord,
  ProposalDocumentModel,
  ProposalDocumentStatus,
  ProposalSection,
} from "./types.js";
export { INVOICE_REPORT_KIND, PROPOSAL_REPORT_KIND } from "./types.js";

export {
  resolveDocumentBrand,
  splitAddress,
  monogramFor,
  embeddableLogo,
  displayWebsite,
  type AgencyBrandSource,
} from "./brand.js";

export {
  buildInvoiceDocumentModel,
  buildProposalDocumentModel,
  brandSourceFrom,
  clientPartyFrom,
  checkTotalsConsistency,
  DEFAULT_DOCUMENT_THEME,
  type BuildInvoiceModelInput,
  type BuildProposalModelInput,
} from "./mapper.js";

export { parseInvoiceDocument, parseProposalDocument, MAX_LINE_ITEMS } from "./parse.js";

export {
  balanceCents,
  currencyDecimals,
  currencySymbol,
  formatMoney,
  formatQuantity,
  lineTotalCents,
  normalizeCurrency,
  roundCents,
  sumCents,
  taxFromBasisPoints,
} from "./money.js";

export { formatDocumentDate, toIsoDate, daysBetween } from "./date.js";
export { esc, escMultiline, escProse, escUrl, safeColor, safeUrl } from "./html.js";

export {
  buildInvoiceHtml,
  buildInvoicePreviewFragment,
  effectiveInvoiceStatus,
  duePhrase,
  invoiceSummaryText,
  INVOICE_STATUS_LABELS,
} from "../templates/invoice.js";

export {
  buildProposalHtml,
  buildProposalPreviewFragment,
  effectiveProposalStatus,
  validityPhrase,
  proposalSummaryText,
  PROPOSAL_STATUS_LABELS,
  DEFAULT_ACCEPTANCE_TERMS,
} from "../templates/proposal.js";

export { renderInvoiceDocumentHtml, renderProposalDocumentHtml } from "./render.js";
export {
  renderInvoiceDocumentPdf,
  renderProposalDocumentPdf,
  type RenderDocumentPdfOptions,
} from "./render.js";
