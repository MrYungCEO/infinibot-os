/**
 * Store rows → models, and the defensive parse of a model that came back out of
 * `config_json`. Together these are the two boundaries the templates trust.
 */

import { describe, expect, it } from "vitest";
import { goldLetterhead } from "../themes/gold-letterhead.js";
import type { Invoice, InvoiceLineItem, Proposal } from "../../agency-operations/types.js";
import {
  buildInvoiceDocumentModel,
  buildProposalDocumentModel,
  checkTotalsConsistency,
  clientPartyFrom,
  DEFAULT_DOCUMENT_THEME,
} from "./mapper.js";
import { parseInvoiceDocument, parseProposalDocument, MAX_LINE_ITEMS } from "./parse.js";
import { FIXED_NOW } from "./test-helpers.js";

const invoiceRow: Invoice = {
  id: "inv_1",
  agencyId: "default",
  clientId: "cli_1",
  engagementId: null,
  number: "INV-2026-0001",
  status: "issued",
  currency: "usd",
  subtotalCents: 250_000,
  taxCents: 21_800,
  totalCents: 271_800,
  amountPaidCents: 100_000,
  balanceCents: 171_800,
  issuedAt: FIXED_NOW - 10 * 86_400_000,
  dueAt: FIXED_NOW + 20 * 86_400_000,
  createdAt: FIXED_NOW - 10 * 86_400_000,
  updatedAt: FIXED_NOW,
};

const lineItemRows: InvoiceLineItem[] = [
  {
    id: "li_1",
    agencyId: "default",
    invoiceId: "inv_1",
    description: "Retainer",
    quantity: 1,
    unitPriceCents: 250_000,
    totalCents: 250_000,
    cadence: "monthly",
    sortOrder: 0,
  },
];

const proposalRow: Proposal = {
  id: "prp_1234567890",
  agencyId: "default",
  opportunityId: "opp_1",
  title: "Website rebuild",
  status: "sent",
  scope: "Rebuild the marketing site.",
  currency: "EUR",
  validUntil: FIXED_NOW + 14 * 86_400_000,
  subtotalCents: 500_000,
  taxCents: 0,
  totalCents: 500_000,
  lineItems: [
    {
      id: "pli_1",
      description: "Design + build",
      quantity: 1,
      unitPriceCents: 500_000,
      totalCents: 500_000,
    },
  ],
  createdAt: FIXED_NOW - 2 * 86_400_000,
  updatedAt: FIXED_NOW,
};

describe("buildInvoiceDocumentModel", () => {
  it("maps a store row into a render-ready model", () => {
    const model = buildInvoiceDocumentModel({
      invoice: invoiceRow,
      client: { name: "Acme Co", legalName: "Acme Co Ltd", billingEmail: "ap@acme.example" },
      lineItems: lineItemRows,
      profile: { tagline: "We build things", email: "hi@studio.example" },
      agencyName: "Studio North",
      asOf: FIXED_NOW,
    });
    expect(model.kind).toBe("invoice");
    expect(model.number).toBe("INV-2026-0001");
    expect(model.currency).toBe("USD");
    expect(model.totals).toEqual({
      subtotalCents: 250_000,
      discountCents: 0,
      taxCents: 21_800,
      taxLabel: null,
      totalCents: 271_800,
    });
    expect(model.amountPaidCents).toBe(100_000);
    expect(model.brand.name).toBe("Studio North");
    expect(model.brand.tagline).toBe("We build things");
    expect(model.client.name).toBe("Acme Co");
    expect(model.lineItems[0].cadence).toBe("monthly");
  });

  it("keeps the stored totals rather than recomputing them", () => {
    // The stored figures are what the client was already told and what revenue
    // recognition used; a document must not quietly disagree with them.
    const model = buildInvoiceDocumentModel({
      invoice: { ...invoiceRow, subtotalCents: 999_999 },
      client: { name: "Acme Co", legalName: null, billingEmail: null },
      lineItems: lineItemRows,
      asOf: FIXED_NOW,
    });
    expect(model.totals.subtotalCents).toBe(999_999);
  });

  it("falls back to a short id when the invoice has no number", () => {
    const model = buildInvoiceDocumentModel({
      invoice: { ...invoiceRow, number: "  " },
      client: { name: "Acme Co", legalName: null, billingEmail: null },
      asOf: FIXED_NOW,
    });
    expect(model.number).toBe("INV_1");
  });

  it("uses a bare-fallback brand when there is no profile at all", () => {
    const model = buildInvoiceDocumentModel({
      invoice: invoiceRow,
      client: { name: "Acme Co", legalName: null, billingEmail: null },
      asOf: FIXED_NOW,
    });
    expect(model.brand.name).toBe("Your Agency");
    expect(model.brand.colors.accent).toBe(goldLetterhead.tokens.accent);
  });

  it("defaults to the client-facing letterhead theme", () => {
    expect(DEFAULT_DOCUMENT_THEME).toBe("gold-letterhead");
  });
});

describe("clientPartyFrom", () => {
  it("prefers the billing email and adds the primary contact as an attention line", () => {
    const party = clientPartyFrom(
      { name: "Acme Co", legalName: "Acme Co Ltd", billingEmail: "ap@acme.example" },
      { firstName: "Dana", lastName: "Cole", email: "dana@acme.example", phone: "+1 212 555 0177" },
    );
    expect(party.email).toBe("ap@acme.example");
    expect(party.attention).toBe("Dana Cole");
    expect(party.phone).toBe("+1 212 555 0177");
  });

  it("falls back to the contact email when there is no billing email", () => {
    const party = clientPartyFrom(
      { name: "Acme Co", legalName: null, billingEmail: null },
      { firstName: "Dana", lastName: "Cole", email: "dana@acme.example", phone: null },
    );
    expect(party.email).toBe("dana@acme.example");
  });
});

describe("buildProposalDocumentModel", () => {
  it("maps a proposal row, deriving a reference number from the id", () => {
    const model = buildProposalDocumentModel({
      proposal: proposalRow,
      client: { name: "Acme Co", legalName: null, billingEmail: null },
      agencyName: "Studio North",
      asOf: FIXED_NOW,
    });
    expect(model.number).toBe("P-PRP_1234");
    expect(model.currency).toBe("EUR");
    expect(model.title).toBe("Website rebuild");
    expect(model.scope).toBe("Rebuild the marketing site.");
    expect(model.lineItems).toHaveLength(1);
    expect(model.validUntil).toBe(proposalRow.validUntil);
  });

  it("accepts an explicit reference number", () => {
    const model = buildProposalDocumentModel({
      proposal: proposalRow,
      client: { name: "Acme Co", legalName: null, billingEmail: null },
      number: "PRO-2026-0031",
      asOf: FIXED_NOW,
    });
    expect(model.number).toBe("PRO-2026-0031");
  });
});

describe("checkTotalsConsistency", () => {
  it("is silent when everything reconciles", () => {
    expect(
      checkTotalsConsistency({ subtotalCents: 250_000, taxCents: 21_800, totalCents: 271_800 }, [
        { description: "x", quantity: 1, unitPriceCents: 250_000, totalCents: 250_000 },
      ]),
    ).toEqual([]);
  });

  it("flags line items that disagree with the subtotal", () => {
    const problems = checkTotalsConsistency(
      { subtotalCents: 250_000, taxCents: 0, totalCents: 250_000 },
      [{ description: "x", quantity: 2, unitPriceCents: 100_000, totalCents: 200_000 }],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("200000");
  });

  it("flags a total that does not equal subtotal − discount + tax", () => {
    const problems = checkTotalsConsistency(
      { subtotalCents: 100_000, discountCents: 10_000, taxCents: 5_000, totalCents: 99_999 },
      [],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("95000");
  });
});

describe("parseInvoiceDocument", () => {
  const theme = goldLetterhead;

  it("round-trips a model built by the mapper", () => {
    const model = buildInvoiceDocumentModel({
      invoice: invoiceRow,
      client: { name: "Acme Co", legalName: null, billingEmail: "ap@acme.example" },
      lineItems: lineItemRows,
      agencyName: "Studio North",
      asOf: FIXED_NOW,
    });
    const parsed = parseInvoiceDocument(
      JSON.parse(JSON.stringify({ document: model })),
      theme,
      FIXED_NOW,
    );
    expect(parsed.number).toBe(model.number);
    expect(parsed.totals).toEqual(model.totals);
    expect(parsed.amountPaidCents).toBe(model.amountPaidCents);
    expect(parsed.brand.name).toBe("Studio North");
    expect(parsed.lineItems).toEqual(model.lineItems);
  });

  it("produces a renderable model from an empty config instead of throwing", () => {
    const parsed = parseInvoiceDocument({}, theme, FIXED_NOW);
    expect(parsed.number).toBe("DRAFT");
    expect(parsed.status).toBe("draft");
    expect(parsed.currency).toBe("USD");
    expect(parsed.client.name).toBe("Client");
    expect(parsed.lineItems).toEqual([]);
    expect(parsed.asOf).toBe(FIXED_NOW);
  });

  it("coerces cents fields to integers and never carries a fractional cent", () => {
    const parsed = parseInvoiceDocument(
      {
        document: {
          totals: { subtotalCents: "1999.7", taxCents: null, totalCents: 1999.7 },
          amountPaidCents: "abc",
          lineItems: [{ description: "x", quantity: "2.5", unitPriceCents: "800.9" }],
        },
      },
      theme,
      FIXED_NOW,
    );
    expect(parsed.totals.subtotalCents).toBe(1_999);
    expect(parsed.totals.totalCents).toBe(1_999);
    expect(parsed.totals.taxCents).toBe(0);
    expect(parsed.amountPaidCents).toBe(0);
    expect(parsed.lineItems[0].quantity).toBe(2.5);
    expect(parsed.lineItems[0].unitPriceCents).toBe(800);
  });

  it("rejects an unknown status rather than rendering it raw", () => {
    const parsed = parseInvoiceDocument(
      { document: { status: "<script>alert(1)</script>" } },
      theme,
      FIXED_NOW,
    );
    expect(parsed.status).toBe("draft");
  });

  it("caps the line-item count so a runaway payload cannot produce a huge PDF", () => {
    const lineItems = Array.from({ length: MAX_LINE_ITEMS + 50 }, (_, i) => ({
      description: `Item ${i}`,
      quantity: 1,
      unitPriceCents: 100,
    }));
    const parsed = parseInvoiceDocument({ document: { lineItems } }, theme, FIXED_NOW);
    expect(parsed.lineItems).toHaveLength(MAX_LINE_ITEMS);
  });

  it("re-validates stored brand colours", () => {
    const parsed = parseInvoiceDocument(
      {
        document: { brand: { name: "Acme", colors: { accent: "red; } * { display:none } .x {" } } },
      },
      theme,
      FIXED_NOW,
    );
    expect(parsed.brand.colors.accent).toBe(theme.tokens.accent);
  });

  it("drops a non-data logo that survived into config_json", () => {
    const parsed = parseInvoiceDocument(
      { document: { brand: { name: "Acme", logoDataUri: "https://cdn.example/logo.png" } } },
      theme,
      FIXED_NOW,
    );
    expect(parsed.brand.logoDataUri).toBeNull();
  });

  it("re-layers the brand against the render-time theme when brandSource is given", () => {
    const parsed = parseInvoiceDocument(
      {
        document: { number: "INV-1" },
        brandSource: { name: "Studio North", branding: { primary: "#0f62fe" } },
      },
      theme,
      FIXED_NOW,
    );
    expect(parsed.brand.name).toBe("Studio North");
    expect(parsed.brand.colors.accent).toBe("#0f62fe");
  });
});

describe("parseProposalDocument", () => {
  const theme = goldLetterhead;

  it("round-trips a mapper-built proposal", () => {
    const model = buildProposalDocumentModel({
      proposal: proposalRow,
      client: { name: "Acme Co", legalName: null, billingEmail: null },
      agencyName: "Studio North",
      asOf: FIXED_NOW,
    });
    const parsed = parseProposalDocument(
      JSON.parse(JSON.stringify({ document: model })),
      theme,
      FIXED_NOW,
    );
    expect(parsed.title).toBe("Website rebuild");
    expect(parsed.currency).toBe("EUR");
    expect(parsed.totals.totalCents).toBe(500_000);
  });

  it("drops sections with no body and keeps the rest", () => {
    const parsed = parseProposalDocument(
      {
        document: {
          sections: [
            { heading: "Timeline", body: "Six weeks." },
            { heading: "Empty", body: "" },
            "not-an-object",
          ],
        },
      },
      theme,
      FIXED_NOW,
    );
    expect(parsed.sections).toEqual([{ heading: "Timeline", body: "Six weeks." }]);
  });

  it("survives a completely empty config", () => {
    const parsed = parseProposalDocument({}, theme, FIXED_NOW);
    expect(parsed.title).toBe("Proposal");
    expect(parsed.status).toBe("draft");
    expect(parsed.scope).toBe("");
  });
});
