import { describe, expect, it } from "vitest";

import { parseInvoice } from "./invoice-parser.js";

describe("invoice parser", () => {
  it("parses structured recurring invoices and normalizes annual revenue to MRR", () => {
    const parsed = parseInvoice({
      structured: {
        invoiceNumber: "INV-42",
        client: { name: "Acme", email: "billing@acme.test" },
        currency: "USD",
        issuedAt: "2026-07-01",
        total: 12000,
        amountPaid: 12000,
        lineItems: [
          { description: "Annual AI operations retainer", amount: 12000, cadence: "annual" },
        ],
      },
    });
    expect(parsed).toMatchObject({
      invoiceNumber: "INV-42",
      clientName: "Acme",
      status: "paid",
      totalCents: 1_200_000,
      recurringMonthlyCents: 100_000,
    });
  });

  it("parses common invoice text", () => {
    const parsed = parseInvoice({
      text: `Invoice #: KK-100\nBill To: Example Co\nInvoice Date: July 1, 2026\nDue Date: July 15, 2026\nBilling interval: monthly\nSubtotal: $2,500.00\nTax: $175.00\nTotal: $2,675.00`,
    });
    expect(parsed.invoiceNumber).toBe("KK-100");
    expect(parsed.clientName).toBe("Example Co");
    expect(parsed.totalCents).toBe(267_500);
    expect(parsed.recurringMonthlyCents).toBe(250_000);
  });

  it("parses flattened PDF table text and separates recurring maintenance revenue", () => {
    const parsed = parseInvoice({
      text: "Invoice # 02 Client: EXAMPLE PRODUCTIONS INC. 123 Main St Springfield, IL 62701 Description Qty Unit Price Total Completion Payment (2/2) 1 $1,500.00 $1,500.00 First Month Platform Maintenance 1 $1,000.00 $1,000.00 Total Due $2,500.00 Thank you for your business!",
    });

    expect(parsed.invoiceNumber).toBe("02");
    expect(parsed.clientName).toBe("EXAMPLE PRODUCTIONS INC.");
    expect(parsed.totalCents).toBe(250_000);
    expect(parsed.lineItems).toHaveLength(2);
    expect(parsed.lineItems[0]?.description).toBe("Completion Payment (2/2)");
    expect(parsed.lineItems[1]?.description).toBe("First Month Platform Maintenance");
    expect(parsed.recurringMonthlyCents).toBe(100_000);
    expect(parsed.warnings).toEqual([]);
  });
});
