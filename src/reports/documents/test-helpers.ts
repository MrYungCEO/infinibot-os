/**
 * Shared fixtures for document tests and the sample-PDF script.
 *
 * Every fixture pins `asOf` and all dates to fixed epochs so rendered output is
 * byte-deterministic — the tests assert on exact strings, and a `Date.now()`
 * anywhere in the model would make them flap at midnight.
 */

import { getTheme } from "../themes/index.js";
import { resolveDocumentBrand } from "./brand.js";
import { DEFAULT_DOCUMENT_THEME } from "./mapper.js";
import type {
  DocumentBrand,
  DocumentLineItem,
  InvoiceDocumentModel,
  ProposalDocumentModel,
} from "./types.js";

/** 14 Mar 2026, 00:00 UTC — the reference "today" for every fixture. */
export const FIXED_NOW = Date.UTC(2026, 2, 14);
export const DAY = 86_400_000;

export function fixtureTheme(name = DEFAULT_DOCUMENT_THEME) {
  return getTheme(name);
}

/** A fully-populated brand: logo, tagline, contact block, colour overrides. */
export function fixtureBrand(overrides: Partial<DocumentBrand> = {}): DocumentBrand {
  const base = resolveDocumentBrand(
    {
      name: "Northwind Studio",
      tagline: "Brand systems for companies that ship",
      email: "billing@northwind.studio",
      phone: "+1 (415) 555-0142",
      website: "https://northwind.studio",
      address: "1200 Harrison Street\nSuite 410\nSan Francisco, CA 94103",
      branding: { footerNote: "Registered in Delaware · EIN 88-1234567" },
    },
    fixtureTheme(),
  );
  return { ...base, ...overrides };
}

/** Brand with nothing configured — exercises every fallback. */
export function bareBrand(): DocumentBrand {
  return resolveDocumentBrand(null, fixtureTheme());
}

export function fixtureLineItems(): DocumentLineItem[] {
  return [
    {
      description: "Brand strategy workshop",
      detail: "Two-day onsite, discovery + positioning",
      quantity: 1,
      unitPriceCents: 850_000,
      totalCents: 850_000,
    },
    {
      description: "Visual identity system",
      detail: "Logo suite, type scale, colour tokens, usage guide",
      quantity: 1,
      unitPriceCents: 1_240_000,
      totalCents: 1_240_000,
    },
    {
      description: "Senior design hours",
      quantity: 37.5,
      unitPriceCents: 18_500,
      totalCents: 693_750,
    },
    {
      description: "Design system maintenance",
      quantity: 3,
      unitPriceCents: 120_000,
      totalCents: 360_000,
      cadence: "monthly",
    },
  ];
}

export function fixtureInvoice(
  overrides: Partial<InvoiceDocumentModel> = {},
): InvoiceDocumentModel {
  const lineItems = overrides.lineItems ?? fixtureLineItems();
  const subtotal = 850_000 + 1_240_000 + 693_750 + 360_000; // 3,143,750
  const tax = 274_078; // 8.72% — deliberately not a round number
  return {
    kind: "invoice",
    id: "inv_9f3c1a20",
    agencyId: "default",
    number: "INV-2026-0184",
    status: "issued",
    currency: "USD",
    brand: fixtureBrand(),
    client: {
      name: "Meridian Health Partners",
      legalName: "Meridian Health Partners, LLC",
      email: "accounts-payable@meridianhealth.example",
      phone: "+1 (212) 555-0177",
      addressLines: ["88 Water Street", "Floor 12", "New York, NY 10005"],
      attention: "Dana Cole",
    },
    issuedAt: FIXED_NOW - 16 * DAY,
    dueAt: FIXED_NOW + 14 * DAY,
    lineItems,
    totals: {
      subtotalCents: subtotal,
      taxCents: tax,
      taxLabel: "Sales tax 8.72%",
      totalCents: subtotal + tax,
    },
    amountPaidCents: 1_000_000,
    payments: [
      {
        paidAt: FIXED_NOW - 9 * DAY,
        amountCents: 1_000_000,
        method: "ACH transfer",
        reference: "ACH-8837211",
      },
    ],
    reference: "PO-44192",
    projects: ["Meridian rebrand", "Patient portal design system"],
    notes: "Please include the invoice number with your remittance.",
    paymentTerms: "Net 30. Late balances accrue 1.5% monthly.",
    paymentLink: { url: "https://pay.northwind.studio/inv-2026-0184", label: "Pay online" },
    asOf: FIXED_NOW,
    ...overrides,
  };
}

export function fixtureProposal(
  overrides: Partial<ProposalDocumentModel> = {},
): ProposalDocumentModel {
  const subtotal = 850_000 + 1_240_000 + 693_750 + 360_000;
  return {
    kind: "proposal",
    id: "prp_4b7e0c11",
    agencyId: "default",
    number: "PRO-2026-0031",
    title: "Meridian Health — brand and design system",
    status: "sent",
    currency: "USD",
    brand: fixtureBrand(),
    client: {
      name: "Meridian Health Partners",
      legalName: "Meridian Health Partners, LLC",
      email: "dana.cole@meridianhealth.example",
      addressLines: ["88 Water Street", "Floor 12", "New York, NY 10005"],
      attention: "Dana Cole",
    },
    summary:
      "Meridian's patient-facing products have drifted into four visual languages across three teams. This engagement consolidates them into one brand and one design system, with the governance to keep it that way.",
    scope:
      "We start with a two-day workshop to agree positioning and the audiences that matter, then build the visual identity outward from it.\n\nThe identity is delivered as a working design system — tokens, components and documentation in your repository — not a PDF of guidelines. Every screen your team ships afterwards pulls from it.\n\nWe stay on for three months of maintenance so the system survives contact with real product work.",
    sections: [
      {
        heading: "Timeline",
        body: "- Weeks 1–2: discovery workshop and positioning\n- Weeks 3–6: visual identity exploration and selection\n- Weeks 7–10: design system build and documentation\n- Weeks 11–22: maintenance and governance",
      },
      {
        heading: "What we need from you",
        body: "A single decision-maker who can approve direction, access to two existing product repositories, and 90 minutes a week from a product designer on your side.",
      },
    ],
    lineItems: fixtureLineItems(),
    totals: {
      subtotalCents: subtotal,
      taxCents: 0,
      totalCents: subtotal,
    },
    preparedAt: FIXED_NOW - 4 * DAY,
    validUntil: FIXED_NOW + 21 * DAY,
    signature: { agencySignatory: "Northwind Studio", clientSignatory: "Meridian Health Partners" },
    notes: "Fees are quoted in USD and exclude third-party licensing.",
    asOf: FIXED_NOW,
    ...overrides,
  };
}

/** Many line items, for exercising multi-page pagination. */
export function manyLineItems(count: number): DocumentLineItem[] {
  return Array.from({ length: count }, (_, index) => ({
    description: `Sprint ${index + 1} — product design and front-end implementation`,
    detail: "Includes design review, build, QA pass and handover notes",
    quantity: 1,
    unitPriceCents: 120_000 + index * 1_000,
    totalCents: 120_000 + index * 1_000,
  }));
}
