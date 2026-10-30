/**
 * Getting the invoice PDF out of the gateway and into the operator's downloads.
 *
 * The document pipeline already worked end to end and stopped one hop short of
 * being useful: `agency.ops.invoice.document.render` enqueues a report, the
 * report worker writes `~/.infinibot/reports/<id>.pdf`, and the UI printed
 * "PDF queued as report rpt_…" and stopped. Nothing ever fetched the bytes, so
 * from the owner's chair the feature did not exist.
 *
 * This module is that hop. Four things shape it.
 *
 * **`reports.preview` is called, never feature-detected.** The `reports.*`
 * handlers are dispatched from a handler map and are deliberately *absent* from
 * `src/gateway/server-methods-list.ts`, so `client.supports("reports.preview")`
 * answers `false` on a gateway that serves it perfectly. Gating the download on
 * `supports()` would disable a working button. The call is made and the failure
 * is handled instead. Do not "fix" this by adding a `supports()` guard.
 *
 * **The render is asynchronous and the file does not exist yet.** `render`
 * returns `{ reportId, status: "queued" }`; `reports.preview` answers
 * `NOT_READY` until the worker has written the file. So the flow polls with a
 * backoff and a hard ceiling, reports honest progress the whole way, and ends
 * either in a downloaded file or in a sentence saying what went wrong. It never
 * blocks: every await is inside a detached async function and the UI is
 * repainted through `requestUpdate` at each transition.
 *
 * **An invoice rendered in a previous session still downloads.** The reports
 * store stamps `sourceRecordId` with the invoice id when the render is
 * enqueued, and `reports.list` returns that field on the wire. There is no
 * server-side filter for it, so this module lists the `agency_invoice` reports
 * once, indexes them by `sourceRecordId` in memory, and reuses the newest
 * already-rendered one. That is the only association the RPC surface exposes
 * without touching `src/**`. When no report exists — or the stored one has lost
 * its file — the invoice is rendered on demand instead, so the button works on
 * every invoice rather than only the ones rendered since the page loaded.
 *
 * **A stale PDF is a lie about money.** A cached report is the fast path, but
 * the surface always says when the bytes came from an earlier render and offers
 * a forced re-render, because a payment recorded after that render is not in
 * the document.
 *
 * State lives in a module-level map rather than on `AgencyInvoicingState`
 * deliberately: `openInvoiceComposer` replaces that object wholesale, which
 * would drop an in-flight poll's target on the floor mid-render.
 */

import type { GatewayBrowserClient } from "../gateway";
import {
  ensureAgencyOperationsState,
  type AgencyOperationsHost,
  type AgencyOperationsState,
} from "./agency-operations";
import { invoiceMethod } from "./agency-invoicing";

/** The report kind `agency.ops.invoice.document.render` enqueues. */
export const INVOICE_REPORT_KIND = "agency_invoice";

/** Reports pulled per index refresh. Far above any realistic invoice count. */
const REPORT_INDEX_LIMIT = 500;

/** How long an index of rendered invoice reports is reused. */
const REPORT_INDEX_TTL_MS = 30_000;

/**
 * Poll cadence after a render is queued, in ms, holding at the last value.
 *
 * Front-loaded because a small invoice is often ready inside two seconds, then
 * stretched so a slow puppeteer start does not turn into a request storm.
 */
const POLL_DELAYS_MS = [700, 900, 1_200, 1_500, 2_000, 2_500, 3_000];

/** Hard ceiling on one download attempt. Beyond this the operator is told. */
const POLL_CEILING_MS = 90_000;

/**
 * Delay before the object URL is released.
 *
 * Revoking in the same task as the synthetic click cancels the download in
 * Chromium: the anchor's navigation has not started when the blob disappears.
 * The URL is dropped a minute later, which is well past any real save dialog.
 */
const OBJECT_URL_TTL_MS = 60_000;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export type InvoicePdfPhase =
  | "idle"
  | "locating"
  | "rendering"
  | "downloading"
  | "done"
  | "error";

export interface InvoicePdfState {
  phase: InvoicePdfPhase;
  /** Honest progress line for the surface. Never a spinner with no words. */
  message: string | null;
  error: string | null;
  reportId: string | null;
  /** True when the delivered bytes came from a report rendered earlier. */
  fromExistingReport: boolean;
  /** When that earlier report was rendered, so the surface can date it. */
  renderedAt: number | null;
}

const IDLE: InvoicePdfState = {
  phase: "idle",
  message: null,
  error: null,
  reportId: null,
  fromExistingReport: false,
  renderedAt: null,
};

const downloads = new Map<string, InvoicePdfState>();

/** The download state for one invoice. Always defined, never `undefined`. */
export function invoicePdfState(invoiceId: string | null | undefined): InvoicePdfState {
  if (!invoiceId) return IDLE;
  return downloads.get(invoiceId) ?? IDLE;
}

/** True while this invoice is being located, rendered or fetched. */
export function invoicePdfBusy(invoiceId: string | null | undefined): boolean {
  const phase = invoicePdfState(invoiceId).phase;
  return phase === "locating" || phase === "rendering" || phase === "downloading";
}

function setState(
  host: AgencyOperationsHost,
  invoiceId: string,
  patch: Partial<InvoicePdfState>,
): void {
  downloads.set(invoiceId, { ...invoicePdfState(invoiceId), ...patch });
  host.requestUpdate?.();
}

/** Clears a finished notice so a surface can be reopened clean. */
export function clearInvoicePdfState(host: AgencyOperationsHost, invoiceId: string): void {
  downloads.delete(invoiceId);
  host.requestUpdate?.();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Records a failed RPC on the shared agency banner as well as inline, matching
 * `recordMutationFailure` in the operations controller: a call this build does
 * not serve has to be visible as a named method.
 */
function recordFailure(state: AgencyOperationsState, method: string, error: unknown): void {
  const entry = `${method} — ${errorText(error)}`;
  if (!state.failedRequests.includes(entry)) {
    state.failedRequests = [...state.failedRequests, entry];
  }
}

/* ------------------------------------------------------------------ *
 * Defensive readers
 * ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * The report index
 * ------------------------------------------------------------------ */

interface InvoiceReportRow {
  id: string;
  status: string;
  sourceRecordId: string;
  renderedAt: number | null;
  createdAt: number | null;
  hasFile: boolean;
}

interface ReportIndex {
  /** Newest usable report per invoice id. */
  byInvoice: Map<string, InvoiceReportRow>;
  loadedAt: number;
}

let reportIndex: ReportIndex | null = null;
let reportIndexInFlight: Promise<ReportIndex | null> | null = null;
/** When `reports.list` last failed, so a broken store is not re-asked on loop. */
let reportIndexFailedAt = 0;

/** True once a report is worth fetching bytes from. */
function isRendered(row: InvoiceReportRow): boolean {
  return row.hasFile && row.status !== "queued" && row.status !== "failed";
}

function indexReports(rows: unknown): ReportIndex {
  const byInvoice = new Map<string, InvoiceReportRow>();
  if (Array.isArray(rows)) {
    for (const raw of rows) {
      const entry = record(raw);
      if (!entry) continue;
      const id = text(entry.id);
      const sourceRecordId = text(entry.sourceRecordId);
      if (!id || !sourceRecordId) continue;
      const row: InvoiceReportRow = {
        id,
        status: text(entry.status) ?? "unknown",
        sourceRecordId,
        renderedAt: count(entry.renderedAt),
        createdAt: count(entry.createdAt),
        hasFile: Boolean(text(entry.filePath)),
      };
      if (!isRendered(row)) continue;
      const previous = byInvoice.get(sourceRecordId);
      const stamp = (candidate: InvoiceReportRow) =>
        candidate.renderedAt ?? candidate.createdAt ?? 0;
      if (!previous || stamp(row) >= stamp(previous)) byInvoice.set(sourceRecordId, row);
    }
  }
  return { byInvoice, loadedAt: Date.now() };
}

/**
 * Lists rendered invoice reports and indexes them by invoice id.
 *
 * Coalesced: several invoice rows asking at once share one `reports.list`.
 * A failure returns `null` rather than an empty index, so "we could not read
 * the report store" and "this invoice has never been rendered" stay distinct —
 * the first falls through to an on-demand render, it does not claim there is
 * nothing there.
 */
async function loadReportIndex(
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  force: boolean,
): Promise<ReportIndex | null> {
  if (!force && reportIndex && Date.now() - reportIndex.loadedAt < REPORT_INDEX_TTL_MS) {
    return reportIndex;
  }
  if (reportIndexInFlight) return reportIndexInFlight;
  const method = "reports.list";
  reportIndexInFlight = (async () => {
    try {
      // Deliberately not guarded by client.supports(): reports.* is dispatched
      // from a handler map and never advertised in the hello-ok method list.
      const response = await client.request(method, {
        kind: INVOICE_REPORT_KIND,
        limit: REPORT_INDEX_LIMIT,
      });
      reportIndex = indexReports(record(response)?.reports);
      reportIndexFailedAt = 0;
      return reportIndex;
    } catch (error) {
      reportIndexFailedAt = Date.now();
      recordFailure(state, method, error);
      return null;
    } finally {
      reportIndexInFlight = null;
    }
  })();
  return reportIndexInFlight;
}

/**
 * Warms the index so a register full of invoices knows which ones already have
 * a PDF before the operator clicks anything. Fire-and-forget by design.
 */
export function primeInvoiceReportIndex(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
): void {
  // Surfaces call this from render, so it must be a no-op once the index is
  // warm. Without this guard the `requestUpdate` below would re-enter render,
  // which would call this again, forever.
  if (reportIndexInFlight) return;
  if (reportIndex && Date.now() - reportIndex.loadedAt < REPORT_INDEX_TTL_MS) return;
  if (reportIndexFailedAt && Date.now() - reportIndexFailedAt < REPORT_INDEX_TTL_MS) return;
  const state = ensureAgencyOperationsState(host);
  void loadReportIndex(state, client, false).then(() => host.requestUpdate?.());
}

/**
 * The already-rendered report for an invoice, if the index holds one.
 *
 * Synchronous and index-only: surfaces call this during render, so it must
 * never fire an RPC. `null` means "not known to have one", which is exactly the
 * state that makes the button render on demand instead.
 */
export function existingInvoiceReport(invoiceId: string): { id: string; renderedAt: number | null } | null {
  const row = reportIndex?.byInvoice.get(invoiceId);
  return row ? { id: row.id, renderedAt: row.renderedAt } : null;
}

/* ------------------------------------------------------------------ *
 * Fetching the bytes
 * ------------------------------------------------------------------ */

/** How long a just-enqueued report is allowed to be `NOT_FOUND`. */
const REPORT_VISIBILITY_GRACE_MS = 12_000;

/**
 * True when a `reports.preview` failure means "the worker has not finished",
 * not "this will never work".
 *
 * The gateway's structured error code (`NOT_READY`, `FILE_MISSING`) does not
 * survive `GatewayBrowserClient`, which rejects with `new Error(res.error.message)`.
 * The message is matched instead, and the codes are matched too in case that
 * client ever starts carrying them.
 *
 * `NOT_FOUND` is the interesting case. Immediately after a render it can just
 * be the store's write not being visible to the reading handler yet, so it is
 * tolerated briefly. Past the grace window it is a real fault — the row was
 * never registered — and the caller turns it into a named error rather than
 * polling out the full ceiling on something that will never appear.
 */
function isNotReady(error: unknown, elapsedMs: number): boolean {
  const message = errorText(error);
  if (
    /NOT_READY|FILE_MISSING|has no rendered file|not rendered yet|rendered file missing/i.test(
      message,
    )
  ) {
    return true;
  }
  return elapsedMs < REPORT_VISIBILITY_GRACE_MS && /NOT_FOUND|not found/i.test(message);
}

/** True when the report row itself never appeared in the reports store. */
function isMissingReport(error: unknown): boolean {
  return /NOT_FOUND|not found/i.test(errorText(error));
}

interface PreviewResult {
  base64: string;
}

/** One `reports.preview` call asking for the bytes. Throws on any failure. */
async function fetchReportBytes(
  client: GatewayBrowserClient,
  reportId: string,
): Promise<PreviewResult> {
  // Not gated on client.supports() — see the module header.
  const response = record(
    await client.request("reports.preview", { id: reportId, base64: true }),
  );
  const base64 = text(response?.base64);
  if (!base64) {
    throw new Error(
      `reports.preview returned no document bytes for ${reportId}. The gateway found the file but did not encode it.`,
    );
  }
  return { base64 };
}

/** `queued` → still working; `failed` → stop polling and say why. */
async function reportStatus(
  client: GatewayBrowserClient,
  reportId: string,
): Promise<string | null> {
  try {
    const response = record(await client.request("reports.get", { id: reportId }));
    const report = record(response?.report);
    return text(report?.status);
  } catch {
    // The status probe is a courtesy; a failure here must not end the poll.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/**
 * A filesystem-safe download name.
 *
 * `filePath` from `reports.preview` is a server-side path and is useless in a
 * browser, so the name is built from what the operator recognises: the invoice
 * number and the client.
 */
export function invoicePdfFilename(number: string, clientName: string): string {
  const clean = (value: string): string =>
    value
      .normalize("NFKD")
      .replace(/[^\w .()-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const parts = [clean(number) || "invoice", clean(clientName)].filter((part) => part.length > 0);
  return `${parts.join(" - ").slice(0, 120)}.pdf`;
}

/** Decodes base64 into bytes without a data: URL, which caps out on big PDFs. */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Hands the PDF to the browser's own download machinery, then cleans up. */
function deliverPdf(base64: string, filename: string): number {
  const bytes = decodeBase64(base64);
  // `bytes.buffer` rather than the view: this lib's `BlobPart` does not accept
  // a `Uint8Array<ArrayBufferLike>`. The array was allocated here at exactly the
  // decoded length, so its buffer is the whole PDF and nothing else.
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
  }
  return bytes.byteLength;
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * The download flow
 * ------------------------------------------------------------------ */

export interface InvoicePdfTarget {
  id: string;
  number: string;
  clientName: string;
  /**
   * When the stored invoice last changed. A cached report rendered *before*
   * this is stale — it cannot describe an edit (a changed due date, a recorded
   * payment) made after it was produced — so the cache is skipped and a fresh
   * document is rendered. Omitted/`null` keeps the old cache-first behaviour.
   */
  updatedAt?: number | null;
}

export interface DownloadInvoicePdfOptions {
  /** Skip the cached report and render the invoice again from current data. */
  force?: boolean;
  /** Passed through to the render RPC when one has to be enqueued. */
  agencyId?: string | null;
}

/**
 * Downloads the branded PDF for one invoice.
 *
 * Resolution order: an already-rendered report (unless `force`), then an
 * on-demand render polled until the worker writes the file. Every exit is
 * either a file in the operator's downloads folder or a sentence explaining
 * why there is not one.
 */
export async function downloadInvoicePdf(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoice: InvoicePdfTarget,
  options: DownloadInvoicePdfOptions = {},
): Promise<void> {
  const state = ensureAgencyOperationsState(host);
  const invoiceId = invoice.id;
  if (!invoiceId || invoicePdfBusy(invoiceId)) return;
  const filename = invoicePdfFilename(invoice.number, invoice.clientName);

  setState(host, invoiceId, {
    phase: "locating",
    message: options.force
      ? "Rendering a fresh PDF…"
      : "Looking for a rendered PDF for this invoice…",
    error: null,
    reportId: null,
    fromExistingReport: false,
    renderedAt: null,
  });

  try {
    /* 1. An existing report, when one is on file, is current, and a fresh one
     *    is not demanded. A report rendered before the invoice's last edit is
     *    stale — serving it would print a superseded due date (or miss a later
     *    payment) — so it is skipped in favour of an on-demand render. */
    if (!options.force) {
      const index = await loadReportIndex(state, client, false);
      const cached = index?.byInvoice.get(invoiceId) ?? null;
      const stale =
        cached !== null &&
        typeof invoice.updatedAt === "number" &&
        cached.renderedAt !== null &&
        invoice.updatedAt > cached.renderedAt;
      const existing = stale ? null : cached;
      if (existing) {
        setState(host, invoiceId, {
          phase: "downloading",
          reportId: existing.id,
          message: "Fetching the stored PDF…",
        });
        try {
          const { base64 } = await fetchReportBytes(client, existing.id);
          const size = deliverPdf(base64, filename);
          const stamp = existing.renderedAt ?? existing.createdAt;
          setState(host, invoiceId, {
            phase: "done",
            fromExistingReport: true,
            renderedAt: stamp,
            message: `Downloaded ${filename} (${humanBytes(size)}), rendered ${
              stamp ? new Date(stamp).toLocaleString() : "in an earlier session"
            }.`,
          });
          return;
        } catch (error) {
          // The row exists but its file is gone or unreadable. That is not a
          // dead end — drop it from the index and render the invoice again.
          reportIndex?.byInvoice.delete(invoiceId);
          if (!isNotReady(error, 0)) recordFailure(state, "reports.preview", error);
        }
      }
    }

    /* 2. Render on demand. */
    const renderMethod = invoiceMethod(client, "render");
    if (!renderMethod) {
      setState(host, invoiceId, {
        phase: "error",
        message: null,
        error:
          "No PDF has been rendered for this invoice yet, and this gateway build does not serve agency.ops.invoice.document.render — so one cannot be produced from here.",
      });
      return;
    }
    const agencyId = options.agencyId ?? state.selectedAgencyId;
    if (!agencyId) {
      setState(host, invoiceId, {
        phase: "error",
        message: null,
        error: "No agency is selected, so the invoice document cannot be rendered.",
      });
      return;
    }

    setState(host, invoiceId, { phase: "rendering", message: "Rendering the PDF…" });
    let reportId: string;
    try {
      const response = record(
        await client.request(renderMethod, { agencyId, invoiceId }),
      );
      const id = text(response?.reportId);
      if (!id) {
        throw new Error("the render was accepted but no report id came back");
      }
      reportId = id;
    } catch (error) {
      recordFailure(state, renderMethod, error);
      setState(host, invoiceId, {
        phase: "error",
        message: null,
        error: `${renderMethod} — ${errorText(error)}`,
      });
      return;
    }
    setState(host, invoiceId, { reportId });

    /* 3. Poll until the worker has written the file. */
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      const elapsed = Date.now() - startedAt;
      if (elapsed > POLL_CEILING_MS) {
        setState(host, invoiceId, {
          phase: "error",
          message: null,
          error: `The PDF was queued as report ${reportId} but was still not rendered after ${Math.round(
            elapsed / 1000,
          )}s. The report worker may not be running — the document will download once it is.`,
        });
        return;
      }

      try {
        const { base64 } = await fetchReportBytes(client, reportId);
        const size = deliverPdf(base64, filename);
        // A fresh file exists now, so the next click on this invoice is instant.
        reportIndex?.byInvoice.set(invoiceId, {
          id: reportId,
          status: "ready",
          sourceRecordId: invoiceId,
          renderedAt: Date.now(),
          createdAt: startedAt,
          hasFile: true,
        });
        setState(host, invoiceId, {
          phase: "done",
          fromExistingReport: false,
          renderedAt: Date.now(),
          message: `Downloaded ${filename} (${humanBytes(size)}).`,
        });
        return;
      } catch (error) {
        if (!isNotReady(error, elapsed)) {
          recordFailure(state, "reports.preview", error);
          setState(host, invoiceId, {
            phase: "error",
            message: null,
            // A report that the render RPC created but `reports.preview` cannot
            // see is a gateway-side split, not an operator mistake, and it will
            // not resolve by waiting — so it is named for what it is.
            error: isMissingReport(error)
              ? `The render was accepted as report ${reportId}, but the gateway's report store has no such row — ${renderMethod} and reports.* are not reading the same store on this build. The PDF cannot be fetched until that is fixed.`
              : `reports.preview — ${errorText(error)}`,
          });
          return;
        }
        setState(host, invoiceId, {
          phase: "rendering",
          message: `Rendering the PDF… (${Math.round(elapsed / 1000)}s)`,
        });
        // Every few rounds, ask whether the worker gave up, so a failed render
        // reports its own cause instead of running out the ceiling in silence.
        if (attempt >= 3 && attempt % 3 === 0) {
          const status = await reportStatus(client, reportId);
          if (status === "failed") {
            setState(host, invoiceId, {
              phase: "error",
              message: null,
              error: `The report worker failed to render report ${reportId}. Check the gateway log for the render error.`,
            });
            return;
          }
        }
      }
    }
  } catch (error) {
    // Anything unforeseen still ends as a sentence, never a stuck spinner.
    setState(host, invoiceId, { phase: "error", message: null, error: errorText(error) });
  }
}
