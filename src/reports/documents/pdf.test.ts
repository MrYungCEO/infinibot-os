/**
 * End-to-end PDF test: a real Chrome, a real file, a real parse.
 *
 * This is the only test in the module that launches a browser, so it is guarded
 * three ways:
 *  - skipped when no Chrome binary is discoverable (`resolveChromePath()`),
 *    so a CI box without a browser reports "skipped", not "failed";
 *  - `REPORTS_PDF_RENDER_URL` is forced empty for the duration, so the shared
 *    renderer does not try (and wait on) the optional remote render service;
 *  - assertions are on the *artifact*, not on "no error was thrown": header
 *    magic, EOF marker, page count and byte size all have to hold.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromePath } from "../renderer.js";
import { renderInvoiceDocumentPdf, renderProposalDocumentPdf } from "./render.js";
import { fixtureInvoice, fixtureProposal, manyLineItems } from "./test-helpers.js";

const chrome = resolveChromePath();
const describeIfChrome = chrome ? describe : describe.skip;

let workDir = "";
let previousRenderUrl: string | undefined;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "ib-doc-pdf-"));
  previousRenderUrl = process.env.REPORTS_PDF_RENDER_URL;
  // Force the local puppeteer path: without this the renderer spends a request
  // (and this test spends its budget) probing localhost:8091.
  process.env.REPORTS_PDF_RENDER_URL = "";
});

afterAll(() => {
  if (previousRenderUrl === undefined) delete process.env.REPORTS_PDF_RENDER_URL;
  else process.env.REPORTS_PDF_RENDER_URL = previousRenderUrl;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Page count straight from the PDF body — no parser dependency. */
function countPages(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  const typePages = text.match(/\/Type\s*\/Page[^s]/g);
  return typePages ? typePages.length : 0;
}

function expectValidPdf(path: string, minBytes: number): Buffer {
  expect(existsSync(path)).toBe(true);
  const bytes = readFileSync(path);
  // Header magic, not just "a file exists".
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // Trailer — a truncated render would be missing this.
  expect(bytes.subarray(-1024).toString("latin1")).toContain("%%EOF");
  expect(bytes.length).toBeGreaterThan(minBytes);
  expect(countPages(bytes)).toBeGreaterThanOrEqual(1);
  return bytes;
}

describeIfChrome(
  "document PDF rendering",
  () => {
    it("renders an invoice to a real, non-trivial PDF", async () => {
      const out = join(workDir, "invoice.pdf");
      const written = await renderInvoiceDocumentPdf(fixtureInvoice(), { outPath: out });
      expect(written).toBe(out);
      const bytes = expectValidPdf(out, 5_000);
      // The full fixture carries projects, a payments table and two callouts, so
      // it legitimately runs to a second page; it must not sprawl beyond that.
      expect(countPages(bytes)).toBeLessThanOrEqual(2);
    });

    it("fits an ordinary invoice on a single page", async () => {
      const out = join(workDir, "invoice-lean.pdf");
      await renderInvoiceDocumentPdf(
        fixtureInvoice({ projects: [], payments: [], notes: null, amountPaidCents: 0 }),
        { outPath: out },
      );
      expect(countPages(expectValidPdf(out, 5_000))).toBe(1);
    });

    it("renders a proposal to a real, non-trivial PDF", async () => {
      const out = join(workDir, "proposal.pdf");
      await renderProposalDocumentPdf(fixtureProposal(), { outPath: out });
      expectValidPdf(out, 5_000);
    });

    it("paginates a long invoice across multiple pages", async () => {
      const items = manyLineItems(60);
      const subtotal = items.reduce((sum, item) => sum + (item.totalCents ?? 0), 0);
      const out = join(workDir, "invoice-long.pdf");
      await renderInvoiceDocumentPdf(
        fixtureInvoice({
          lineItems: items,
          totals: { subtotalCents: subtotal, taxCents: 0, totalCents: subtotal },
          amountPaidCents: 0,
          payments: [],
        }),
        { outPath: out },
      );
      const bytes = expectValidPdf(out, 8_000);
      expect(countPages(bytes)).toBeGreaterThan(1);
    });

    it("renders with no branding configured", async () => {
      const model = fixtureInvoice();
      const out = join(workDir, "invoice-bare.pdf");
      await renderInvoiceDocumentPdf(
        {
          ...model,
          brand: {
            ...model.brand,
            logoDataUri: null,
            tagline: null,
            addressLines: [],
            email: null,
            phone: null,
            website: null,
          },
        },
        { outPath: out },
      );
      expectValidPdf(out, 5_000);
    });

    it("fails fast rather than hanging when the timeout is exceeded", async () => {
      await expect(
        renderInvoiceDocumentPdf(fixtureInvoice(), {
          outPath: join(workDir, "never.pdf"),
          timeoutMs: 1,
        }),
      ).rejects.toThrow(/timed out after 1ms/);
    });
  },
  180_000,
);

describe("chrome discovery", () => {
  it("reports whether a browser is available without throwing", () => {
    // resolveChromePath() is the guard the whole render path depends on; it
    // must answer null rather than blow up when nothing is installed.
    expect(chrome === null || typeof chrome === "string").toBe(true);
  });
});
