/**
 * Template-level tests for the invoice and proposal documents: money on the
 * page, escaping of client-controllable text, pagination affordances, status
 * treatment, and the missing-branding fallbacks.
 */

import { describe, expect, it } from "vitest";
import { blackGold } from "../themes/black-gold.js";
import { goldLetterhead } from "../themes/gold-letterhead.js";
import {
  bareBrand,
  DAY,
  FIXED_NOW,
  fixtureInvoice,
  fixtureProposal,
  manyLineItems,
} from "../documents/test-helpers.js";
import { lineItemsSubtotal, settlementHtml, totalsHtml } from "./document-base.js";
import {
  buildInvoiceHtml,
  buildInvoicePreviewFragment,
  duePhrase,
  effectiveInvoiceStatus,
  invoiceSummaryText,
} from "./invoice.js";
import {
  buildProposalHtml,
  buildProposalPreviewFragment,
  effectiveProposalStatus,
  proposalSummaryText,
  validityPhrase,
} from "./proposal.js";

const theme = goldLetterhead;

describe("invoice document — money on the page", () => {
  it("prints subtotal, tax, total, amount paid and balance due", () => {
    const html = buildInvoiceHtml(fixtureInvoice(), theme);
    expect(html).toContain("$31,437.50"); // subtotal
    expect(html).toContain("$2,740.78"); // tax
    expect(html).toContain("$34,178.28"); // total
    expect(html).toContain("-$10,000.00"); // amount paid
    expect(html).toContain("$24,178.28"); // balance due
    expect(html).toContain("Balance due");
  });

  it("agrees with the line items it printed", () => {
    const model = fixtureInvoice();
    expect(lineItemsSubtotal(model.lineItems)).toBe(model.totals.subtotalCents);
  });

  it("computes a line total when the row omits one", () => {
    const model = fixtureInvoice({
      lineItems: [{ description: "Senior design hours", quantity: 37.5, unitPriceCents: 18_500 }],
    });
    const html = buildInvoiceHtml(model, theme);
    expect(html).toContain("$6,937.50");
  });

  it("shows a full balance when nothing has been paid", () => {
    const html = buildInvoiceHtml(fixtureInvoice({ amountPaidCents: 0, payments: [] }), theme);
    expect(html).toContain("Balance due");
    expect(html).toContain("$34,178.28");
    expect(html).not.toContain("Paid in full");
  });

  it("switches to a settled treatment when paid in full", () => {
    const model = fixtureInvoice({ status: "paid", amountPaidCents: 3_417_828 });
    const html = buildInvoiceHtml(model, theme);
    expect(html).toContain("Paid in full");
    expect(html).not.toContain("Balance due");
    expect(html).toContain("pill-ok");
    // A settled invoice must not still be asking for money.
    expect(html).not.toContain("Pay online");
  });

  it("does not print a negative balance after an overpayment", () => {
    const model = fixtureInvoice({ amountPaidCents: 4_000_000 });
    const html = buildInvoiceHtml(model, theme);
    expect(html).toContain("Paid in full");
    expect(html).not.toMatch(/-\$5[0-9,]*\.\d\d<\/span>\s*<\/div>\s*<\/div>\s*<\/div>/);
  });

  it("suppresses the subtotal row when there is no tax or discount", () => {
    // "Subtotal $X / Total $X" makes a reader hunt for a difference that is
    // not there.
    const html = buildInvoiceHtml(
      fixtureInvoice({
        totals: { subtotalCents: 3_143_750, taxCents: 0, totalCents: 3_143_750 },
      }),
      theme,
    );
    expect(html).not.toContain(">Subtotal<");
    expect(html).toContain(">Total<");
  });

  it("keeps the subtotal row once tax applies", () => {
    const html = buildInvoiceHtml(fixtureInvoice(), theme);
    expect(html).toContain(">Subtotal<");
    expect(html).toContain(">Sales tax 8.72%<");
  });

  it("shows a discount line when one is present", () => {
    const html = buildInvoiceHtml(
      fixtureInvoice({
        totals: {
          subtotalCents: 3_143_750,
          discountCents: 143_750,
          taxCents: 0,
          totalCents: 3_000_000,
        },
        amountPaidCents: 0,
        payments: [],
      }),
      theme,
    );
    expect(html).toContain(">Discount<");
    expect(html).toContain("-$1,437.50");
    expect(html).toContain("$30,000.00");
  });

  it("renders a zero-decimal currency without cents", () => {
    const html = buildInvoiceHtml(
      fixtureInvoice({
        currency: "JPY",
        amountPaidCents: 0,
        payments: [],
        lineItems: [{ description: "Retainer", quantity: 1, unitPriceCents: 250_000 }],
        totals: { subtotalCents: 250_000, taxCents: 0, totalCents: 250_000 },
      }),
      theme,
    );
    expect(html).toContain("¥250,000");
    expect(html).not.toContain("¥250,000.00");
  });
});

describe("invoice document — status treatment", () => {
  it("presents an unpaid invoice past its due date as overdue", () => {
    const model = fixtureInvoice({ dueAt: FIXED_NOW - 9 * DAY });
    expect(effectiveInvoiceStatus(model)).toBe("overdue");
    const html = buildInvoiceHtml(model, theme);
    expect(html).toContain("pill-error");
    expect(html).toContain("Overdue");
    expect(html).toContain("9 days overdue");
  });

  it("marks an overdue balance box as danger, and a settled one as positive", () => {
    // The theme has no danger token; the treatment is derived from its own
    // error/ok status pills, so a new theme needs to know nothing about invoices.
    const overdue = buildInvoiceHtml(fixtureInvoice({ dueAt: FIXED_NOW - 9 * DAY }), theme);
    expect(overdue).toContain('class="row due danger"');
    expect(overdue).toContain(`--danger-bg: ${theme.tokens.statusPills.error.bg}`);

    const settled = buildInvoiceHtml(
      fixtureInvoice({ status: "paid", amountPaidCents: 3_417_828 }),
      theme,
    );
    expect(settled).toContain('class="row due settled positive"');

    // An outstanding-but-not-late balance stays neutral.
    const current = buildInvoiceHtml(fixtureInvoice(), theme);
    expect(current).toContain('class="row due"');
    expect(current).not.toContain('class="row due danger"');
  });

  it("derives the danger colour from whichever theme is in use", () => {
    const dark = buildInvoiceHtml(fixtureInvoice({ dueAt: FIXED_NOW - DAY }), blackGold);
    expect(dark).toContain(`--danger-bg: ${blackGold.tokens.statusPills.error.bg}`);
  });

  it("never overrides draft, paid or void", () => {
    const past = FIXED_NOW - 30 * DAY;
    expect(effectiveInvoiceStatus(fixtureInvoice({ status: "draft", dueAt: past }))).toBe("draft");
    expect(effectiveInvoiceStatus(fixtureInvoice({ status: "void", dueAt: past }))).toBe("void");
  });

  it("treats a fully-paid invoice as paid even if the row says otherwise", () => {
    const model = fixtureInvoice({ status: "partially_paid", amountPaidCents: 3_417_828 });
    expect(effectiveInvoiceStatus(model)).toBe("paid");
  });

  it("phrases the due date relative to asOf", () => {
    expect(duePhrase(fixtureInvoice())).toBe("Due in 14 days");
    expect(duePhrase(fixtureInvoice({ dueAt: FIXED_NOW }))).toBe("Due today");
    expect(duePhrase(fixtureInvoice({ dueAt: FIXED_NOW - DAY }))).toBe("1 day overdue");
    expect(duePhrase(fixtureInvoice({ dueAt: null }))).toBeNull();
  });

  it("falls back to a placeholder when no payment link is configured", () => {
    const withLink = buildInvoiceHtml(fixtureInvoice(), theme);
    expect(withLink).toContain('href="https://pay.northwind.studio/inv-2026-0184"');

    const withoutLink = buildInvoiceHtml(fixtureInvoice({ paymentLink: null }), theme);
    expect(withoutLink).toContain("Payment link to follow");
    expect(withoutLink).not.toContain('<a class="pay-link"');
  });

  it("refuses a non-http payment link", () => {
    const html = buildInvoiceHtml(
      fixtureInvoice({ paymentLink: { url: "javascript:alert(1)", label: "Pay" } }),
      theme,
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Payment link to follow");
  });
});

describe("invoice document — escaping", () => {
  const hostile = '<script>alert("xss")</script>';

  it("escapes the client name, line-item text and notes", () => {
    const html = buildInvoiceHtml(
      fixtureInvoice({
        client: { name: hostile, attention: hostile, addressLines: [hostile] },
        lineItems: [
          {
            description: hostile,
            detail: hostile,
            quantity: 1,
            unitPriceCents: 100,
            totalCents: 100,
          },
        ],
        notes: hostile,
        paymentTerms: hostile,
        reference: hostile,
        projects: [hostile],
      }),
      theme,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes branding text", () => {
    const model = fixtureInvoice();
    const html = buildInvoiceHtml(
      { ...model, brand: { ...model.brand, name: hostile, tagline: hostile, footerNote: hostile } },
      theme,
    );
    expect(html).not.toContain("<script>");
  });

  it("escapes an attribute breakout in the payment link label", () => {
    const html = buildInvoiceHtml(
      fixtureInvoice({
        paymentLink: { url: "https://pay.example/x", label: '" onclick="alert(1)' },
      }),
      theme,
    );
    expect(html).not.toContain('onclick="alert(1)"');
    expect(html).toContain("&quot;");
  });
});

describe("invoice document — branding fallbacks", () => {
  it("renders a monogram when there is no logo", () => {
    const model = fixtureInvoice();
    const html = buildInvoiceHtml({ ...model, brand: bareBrand() }, theme);
    expect(html).toContain('<div class="brand-mark">');
    expect(html).not.toContain('<img class="brand-logo"');
    expect(html).toContain("Your Agency");
  });

  it("embeds a data-uri logo when one is present", () => {
    const model = fixtureInvoice();
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const html = buildInvoiceHtml(
      { ...model, brand: { ...model.brand, logoDataUri: logo } },
      theme,
    );
    // Base64 padding survives intact — the logo src uses the URL escaper, not
    // the strict text escaper that would turn "=" into "&#61;".
    expect(html).toContain(`<img class="brand-logo" src="${logo}"`);
    expect(html).not.toContain('<div class="brand-mark">');
  });

  it("omits contact lines that are not configured", () => {
    const model = fixtureInvoice();
    const html = buildInvoiceHtml({ ...model, brand: bareBrand() }, theme);
    // Match the markup, not the stylesheet — both class names appear in the
    // inlined CSS regardless of whether the blocks are rendered.
    expect(html).not.toContain('<div class="brand-contact">');
    expect(html).not.toContain('<div class="brand-tagline">');
    // ...and they do appear once the profile supplies them.
    const branded = buildInvoiceHtml(model, theme);
    expect(branded).toContain('<div class="brand-contact">');
    expect(branded).toContain('<div class="brand-tagline">');
  });

  it("makes no network requests — no remote src/href in the document", () => {
    const html = buildInvoiceHtml(fixtureInvoice(), theme);
    // The only absolute URL allowed is the payment link the client clicks.
    const remoteAssets = html.match(/(?:src|@import|url\()\s*=?\s*["(]?https?:\/\//gi) ?? [];
    expect(remoteAssets).toEqual([]);
  });
});

describe("invoice document — pagination", () => {
  it("repeats the column headers and avoids splitting rows", () => {
    const items = manyLineItems(60);
    const subtotal = lineItemsSubtotal(items);
    const html = buildInvoiceHtml(
      fixtureInvoice({
        lineItems: items,
        totals: { subtotalCents: subtotal, taxCents: 0, totalCents: subtotal },
        amountPaidCents: 0,
        payments: [],
      }),
      theme,
    );
    expect(html).toContain("table.items thead { display: table-header-group; }");
    expect(html).toMatch(/table\.items tr \{[^}]*break-inside: avoid/);
    // Page margins are the only mechanism that gives page 2+ a top margin.
    expect(html).toMatch(/@page \{ size: A4; margin: [^}]+\}/);
    // Every row made it onto the page.
    expect(html.match(/<tr>\s*<td class="desc">Sprint /g) ?? []).toHaveLength(60);
    expect(html).toContain("Sprint 60");
  });

  it("pairs the payment block with the totals instead of stacking it below", () => {
    // The area left of the totals is dead space on every invoice; filling it is
    // what keeps an ordinary invoice on one page.
    const html = buildInvoiceHtml(fixtureInvoice(), theme);
    expect(html).toContain('<div class="settle">');
    expect(html).toMatch(
      /<div class="settle-aside">[\s\S]*Net 30[\s\S]*<\/div>\s*<div class="totals-wrap">/,
    );
  });

  it("falls back to a plain totals stack when there is nothing to pair", () => {
    // An invoice always has *something* to say about payment, so this is
    // exercised on the helper directly.
    const rows = [{ label: "Total", value: "$10.00", variant: "grand" as const }];
    expect(settlementHtml(rows, "")).toBe(totalsHtml(rows));
    expect(settlementHtml(rows, "<p>aside</p>")).toContain('<div class="settle">');
  });

  it("keeps the totals stack from splitting across a page break", () => {
    const html = buildInvoiceHtml(fixtureInvoice(), theme);
    expect(html).toMatch(/\.totals-wrap \{[^}]*break-inside: avoid/);
    expect(html).toMatch(/\.totals \.row \{[^}]*break-inside: avoid/);
  });

  it("renders an empty line-item list without collapsing the table", () => {
    const html = buildInvoiceHtml(
      fixtureInvoice({
        lineItems: [],
        totals: { subtotalCents: 0, taxCents: 0, totalCents: 0 },
        amountPaidCents: 0,
        payments: [],
      }),
      theme,
    );
    expect(html).toContain("No line items.");
  });

  it("survives a very long client name without unescaped overflow", () => {
    const longName = `${"Meridian Health Partners International Holdings ".repeat(6)}LLC`;
    const html = buildInvoiceHtml(fixtureInvoice({ client: { name: longName } }), theme);
    expect(html).toContain(longName);
    // The party block is allowed to wrap rather than run off the sheet.
    expect(html).toMatch(/\.party \.who \{[^}]*word-break: break-word/);
  });
});

describe("invoice document — determinism and shell", () => {
  it("produces identical bytes for identical input", () => {
    expect(buildInvoiceHtml(fixtureInvoice(), theme)).toBe(
      buildInvoiceHtml(fixtureInvoice(), theme),
    );
  });

  it("emits a standalone document, and a style+markup fragment for previews", () => {
    const doc = buildInvoiceHtml(fixtureInvoice(), theme);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>Invoice INV-2026-0184 — Northwind Studio</title>");

    const fragment = buildInvoicePreviewFragment(fixtureInvoice(), theme);
    expect(fragment.startsWith("<style>")).toBe(true);
    expect(fragment).not.toContain("<!doctype html>");
    // Preview and PDF share one template, so the body cannot drift.
    expect(fragment).toContain("INV-2026-0184");
    expect(fragment).toContain("$24,178.28");
  });

  it("renders under the dark console theme too", () => {
    const html = buildInvoiceHtml(fixtureInvoice(), blackGold);
    expect(html).toContain(blackGold.tokens.bg);
    expect(html).toContain("INV-2026-0184");
  });

  it("summarises itself for the report row", () => {
    expect(invoiceSummaryText(fixtureInvoice())).toBe(
      "Invoice INV-2026-0184 · Meridian Health Partners · $34,178.28 · Unpaid · balance $24,178.28",
    );
  });
});

describe("proposal document", () => {
  it("renders scope, sections, pricing and totals", () => {
    const html = buildProposalHtml(fixtureProposal(), theme);
    expect(html).toContain("Scope of work");
    expect(html).toContain("Timeline");
    expect(html).toContain("What we need from you");
    expect(html).toContain("Investment");
    expect(html).toContain("$31,437.50");
    expect(html).toContain("Total investment");
  });

  it("sets its title as a lead block and renders hyphen lists as lists", () => {
    const html = buildProposalHtml(fixtureProposal(), theme);
    expect(html).toContain('<div class="doc-lead">');
    expect(html).toContain("<h1>Meridian Health — brand and design system</h1>");
    expect(html).toContain("<li>Weeks 1–2: discovery workshop and positioning</li>");
    expect(html).not.toContain("<p>- Weeks 1–2");
  });

  it("emphasises one total rather than stacking a duplicate", () => {
    const html = buildProposalHtml(fixtureProposal(), theme);
    expect(html).toContain(">Total investment<");
    // No tax on this proposal, so neither a Subtotal nor a second Total row.
    expect(html).not.toContain(">Subtotal<");
    expect(html).not.toContain('<span class="k">Total</span>');
  });

  it("shows validity and the acceptance block", () => {
    const html = buildProposalHtml(fixtureProposal(), theme);
    expect(html).toContain("Valid for 21 more days");
    expect(html).toContain("Acceptance");
    expect(html).toContain("Signed for Northwind Studio");
    expect(html).toContain("Signed for Meridian Health Partners");
  });

  it("supplies default acceptance terms when none are given", () => {
    const html = buildProposalHtml(fixtureProposal(), theme);
    expect(html).toContain("Acceptance of this proposal constitutes agreement");
  });

  it("uses the caller's acceptance terms when supplied", () => {
    const html = buildProposalHtml(
      fixtureProposal({ acceptanceTerms: ["Fifty percent up front."] }),
      theme,
    );
    expect(html).toContain("Fifty percent up front.");
    expect(html).not.toContain("Acceptance of this proposal constitutes agreement");
  });

  it("presents a sent proposal past its validity date as expired", () => {
    const model = fixtureProposal({ validUntil: FIXED_NOW - 3 * DAY });
    expect(effectiveProposalStatus(model)).toBe("expired");
    const html = buildProposalHtml(model, theme);
    expect(html).toContain("Expired");
    expect(html).toContain("Expired 3 days ago");
    expect(html).toContain("pill-timeout");
  });

  it("never overrides an accepted or rejected decision", () => {
    const stale = FIXED_NOW - 30 * DAY;
    expect(
      effectiveProposalStatus(fixtureProposal({ status: "accepted", validUntil: stale })),
    ).toBe("accepted");
    expect(
      effectiveProposalStatus(fixtureProposal({ status: "rejected", validUntil: stale })),
    ).toBe("rejected");
  });

  it("handles an open-ended validity date", () => {
    expect(validityPhrase(fixtureProposal({ validUntil: null }))).toBeNull();
    const html = buildProposalHtml(fixtureProposal({ validUntil: null }), theme);
    expect(html).toContain("Open-ended");
  });

  it("escapes hostile scope, summary and section text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = buildProposalHtml(
      fixtureProposal({
        title: hostile,
        summary: hostile,
        scope: hostile,
        sections: [{ heading: hostile, body: hostile }],
        client: { name: hostile },
        notes: hostile,
      }),
      theme,
    );
    expect(html).not.toContain("onerror=");
    expect(html).toContain("&lt;img");
  });

  it("paginates a long item list the same way the invoice does", () => {
    const items = manyLineItems(45);
    const subtotal = lineItemsSubtotal(items);
    const html = buildProposalHtml(
      fixtureProposal({
        lineItems: items,
        totals: { subtotalCents: subtotal, taxCents: 0, totalCents: subtotal },
      }),
      theme,
    );
    expect(html).toContain("table.items thead { display: table-header-group; }");
    expect(html).toContain("Sprint 45");
  });

  it("renders with no branding configured", () => {
    const model = fixtureProposal();
    const html = buildProposalHtml({ ...model, brand: bareBrand() }, theme);
    expect(html).toContain("Your Agency");
    expect(html).toContain('<div class="brand-mark">');
  });

  it("is deterministic, standalone, and previewable", () => {
    expect(buildProposalHtml(fixtureProposal(), theme)).toBe(
      buildProposalHtml(fixtureProposal(), theme),
    );
    expect(buildProposalPreviewFragment(fixtureProposal(), theme).startsWith("<style>")).toBe(true);
  });

  it("summarises itself for the report row", () => {
    expect(proposalSummaryText(fixtureProposal())).toBe(
      "Proposal PRO-2026-0031 · Meridian Health Partners · Meridian Health — brand and design system · $31,437.50 · Awaiting decision",
    );
  });
});
