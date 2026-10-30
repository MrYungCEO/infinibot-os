import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GatewayRequestHandlerOptions } from "./types.js";

const stateDir = mkdtempSync(join(tmpdir(), "infinibot-invoicing-rpc-"));
process.env.INFINIBOT_STATE_DIR = stateDir;

// Imported after the state dir is pinned so the singleton stores resolve to it.
const { agencyOperationsHandlers } = await import("./agency-operations.js");
const { getAgencyOperationsStore } = await import("../../agency-operations/store.js");
const { isBusinessAgencyLegacyMethod } = await import("../../business-agency/methods.js");

const AGENCY_ID = "agency-invoicing-test";

type Response = { ok: boolean; result?: any; error?: { code: string; message: string } };

async function call(method: string, params: Record<string, unknown>): Promise<Response> {
  let response: Response | null = null;
  const opts = {
    params,
    client: null,
    respond: (ok: boolean, result?: unknown, error?: { code: string; message: string }) => {
      response = { ok, result, error } as Response;
    },
  } as unknown as GatewayRequestHandlerOptions;
  await agencyOperationsHandlers[method](opts);
  if (!response) throw new Error(`${method} did not respond`);
  return response;
}

/** Unwrap a successful call, surfacing the gateway error message on failure. */
async function ok(method: string, params: Record<string, unknown>): Promise<any> {
  const response = await call(method, params);
  if (!response.ok) throw new Error(`${method} failed: ${response.error?.message}`);
  return response.result;
}

const MARCH_2024 = Date.UTC(2024, 2, 15);
const APRIL_2024 = Date.UTC(2024, 3, 2);

let clientId = "";
let projectId = "";

beforeAll(() => {
  const store = getAgencyOperationsStore(stateDir);
  store.createAgency({
    id: AGENCY_ID,
    name: "Invoicing Test Agency",
    slug: "invoicing-test-agency",
    ownerUserId: "local-owner",
  });
  clientId = store.createClient(
    { name: "Acme", billingEmail: "ap@acme.test" },
    { agencyId: AGENCY_ID },
  ).id;
  projectId = store.createProject(AGENCY_ID, { name: "Website", clientId }).id;
});

afterAll(() => {
  try {
    // Windows keeps the sqlite handle busy until the process exits; best effort.
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("invoice authoring RPCs", () => {
  // agency.ops.* is served (and advertised) by the business-agency plugin, so
  // every method must be in its legacy table rather than in core's list.
  it("advertises every new method", () => {
    for (const method of [
      "agency.ops.invoice.create",
      "agency.ops.invoice.get",
      "agency.ops.invoice.update",
      "agency.ops.invoice.lineItem.add",
      "agency.ops.invoice.lineItem.update",
      "agency.ops.invoice.lineItem.remove",
      "agency.ops.invoice.lineItems.reorder",
      "agency.ops.invoice.projects.set",
      "agency.ops.invoice.issue",
      "agency.ops.invoice.void",
      "agency.ops.invoice.number.next",
      "agency.ops.invoice.payments.list",
      "agency.ops.invoice.backlog.record",
      "agency.ops.invoice.backlog.import",
      "agency.ops.invoice.document.preview",
      "agency.ops.invoice.document.render",
      "agency.ops.proposal.create",
      "agency.ops.proposal.get",
      "agency.ops.proposal.list",
      "agency.ops.proposal.update",
      "agency.ops.proposal.status.set",
      "agency.ops.proposal.accept",
      "agency.ops.proposal.document.preview",
      "agency.ops.proposal.document.render",
    ]) {
      expect(typeof agencyOperationsHandlers[method], `${method} handler`).toBe("function");
      expect(isBusinessAgencyLegacyMethod(method), `${method} advertised`).toBe(true);
    }
  });

  it("creates, issues and settles an invoice over the wire", async () => {
    const preview = await ok("agency.ops.invoice.number.next", { agencyId: AGENCY_ID });
    expect(preview.number).toMatch(/^INV-\d{4}-0001$/);

    const created = await ok("agency.ops.invoice.create", {
      agencyId: AGENCY_ID,
      clientId,
      projectIds: [projectId],
      dueAt: APRIL_2024,
      taxCents: 2_500,
      taxLabel: "VAT 20%",
      terms: "Net 30",
      lineItems: [
        { description: "Design sprint", quantity: 2, unitPriceCents: 125_000 },
        { description: "Hosting", quantity: 1, unitPriceCents: 4_999, cadence: "monthly" },
      ],
    });
    expect(created.invoice.number).toBe(preview.number);
    expect(created.invoice.subtotalCents).toBe(254_999);
    expect(created.invoice.totalCents).toBe(257_499);
    expect(created.projectLinks).toHaveLength(1);

    const invoiceId = created.invoice.id;
    const issued = await ok("agency.ops.invoice.issue", { agencyId: AGENCY_ID, invoiceId });
    expect(issued.invoice.status).toBe("issued");

    // Partial payment in integer cents — the shape the old dollars-only call
    // could not express.
    const partial = await ok("agency.ops.invoices.payment.record", {
      agencyId: AGENCY_ID,
      invoiceId,
      amountCents: 7_499,
      paidAt: APRIL_2024,
    });
    expect(partial.payment.amountCents).toBe(7_499);
    expect(partial.invoice.status).toBe("partially_paid");
    expect(partial.invoice.balanceCents).toBe(250_000);

    await ok("agency.ops.invoices.payment.record", {
      agencyId: AGENCY_ID,
      invoiceId,
      amountCents: 250_000,
    });
    const fetched = await ok("agency.ops.invoice.get", { agencyId: AGENCY_ID, invoiceId });
    expect(fetched.invoice.status).toBe("paid");
    expect(fetched.payments).toHaveLength(2);
    expect(fetched.client.name).toBe("Acme");
  });

  it("rejects fractional cents instead of quietly rounding them", async () => {
    const response = await call("agency.ops.invoice.create", {
      agencyId: AGENCY_ID,
      clientId,
      lineItems: [{ description: "Odd", quantity: 1, unitPriceCents: 10.5 }],
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toMatch(/whole number of cents/);
  });

  it("backlogs a historical invoice into its own revenue period", async () => {
    const detail = await ok("agency.ops.invoice.backlog.record", {
      agencyId: AGENCY_ID,
      clientId,
      issuedAt: MARCH_2024,
      lineItems: [{ description: "Q1 retainer", quantity: 3, unitPriceCents: 100_000 }],
      payments: [{ amountCents: 120_000, paidAt: APRIL_2024, method: "bank" }],
    });
    expect(detail.invoice.status).toBe("partially_paid");
    expect(detail.invoice.issuedAt).toBe(MARCH_2024);

    const march = await ok("agency.ops.revenue.summary", {
      agencyId: AGENCY_ID,
      startAt: Date.UTC(2024, 2, 1),
      endAt: Date.UTC(2024, 3, 1),
    });
    expect(march.revenue.invoicedRevenueCents).toBe(300_000);
    expect(march.revenue.collectedRevenueCents).toBe(0);

    const april = await ok("agency.ops.revenue.summary", {
      agencyId: AGENCY_ID,
      startAt: Date.UTC(2024, 3, 1),
      endAt: Date.UTC(2024, 4, 1),
    });
    // 120 000 from this invoice plus the 7 499 partial recorded at the same
    // backdated instant by the lifecycle test above.
    expect(april.revenue.collectedRevenueCents).toBe(127_499);
  });

  it("imports a batch of backdated invoices in one call", async () => {
    const result = await ok("agency.ops.invoice.backlog.import", {
      agencyId: AGENCY_ID,
      rows: [
        {
          clientId,
          issuedAt: Date.UTC(2023, 0, 10),
          paidInFull: true,
          lineItems: [{ description: "2023 Jan", quantity: 1, unitPriceCents: 80_000 }],
        },
        {
          clientId,
          issuedAt: Date.UTC(2023, 1, 10),
          paidInFull: true,
          lineItems: [{ description: "2023 Feb", quantity: 1, unitPriceCents: 80_000 }],
        },
      ],
    });
    expect(result.imported).toBe(2);
    expect(result.totalCents).toBe(160_000);
    expect(result.collectedCents).toBe(160_000);

    const jan = await ok("agency.ops.revenue.summary", {
      agencyId: AGENCY_ID,
      startAt: Date.UTC(2023, 0, 1),
      endAt: Date.UTC(2023, 1, 1),
    });
    expect(jan.revenue.collectedRevenueCents).toBe(80_000);
  });

  it("refuses a backlog row with no issue date", async () => {
    const response = await call("agency.ops.invoice.backlog.record", {
      agencyId: AGENCY_ID,
      clientId,
      lineItems: [{ description: "Undated", quantity: 1, unitPriceCents: 100 }],
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toMatch(/issuedAt is required/);
  });
});

describe("document RPCs", () => {
  let invoiceId = "";
  let proposalId = "";

  beforeAll(async () => {
    const created = await ok("agency.ops.invoice.create", {
      agencyId: AGENCY_ID,
      clientId,
      projectIds: [projectId],
      dueAt: APRIL_2024,
      notes: "Thank you for your business.",
      lineItems: [{ description: "Retainer", quantity: 1, unitPriceCents: 500_000 }],
    });
    invoiceId = created.invoice.id;
    await ok("agency.ops.invoice.issue", { agencyId: AGENCY_ID, invoiceId, issuedAt: MARCH_2024 });

    const proposal = await ok("agency.ops.proposal.create", {
      agencyId: AGENCY_ID,
      clientId,
      title: "Growth retainer",
      scope: "Strategy, content and reporting",
      summary: "Twelve months of growth support.",
      sections: [{ heading: "Timeline", body: "Starts in April" }],
      acceptanceTerms: ["Invoiced monthly in advance"],
      lineItems: [{ description: "Monthly retainer", quantity: 12, unitPriceCents: 100_000 }],
    });
    proposalId = proposal.proposal.id;
  });

  it("previews an invoice with real markup, a summary and totals warnings", async () => {
    const result = await ok("agency.ops.invoice.document.preview", {
      agencyId: AGENCY_ID,
      invoiceId,
      asOf: MARCH_2024,
    });
    expect(result.html).toContain("<style");
    expect(result.html).toContain("Retainer");
    expect(result.html).toContain("Acme");
    expect(result.summaryText).toContain("Invoice");
    expect(result.status).toBe("issued");
    expect(result.balanceCents).toBe(500_000);
    // Stored totals reconcile with the line items, so nothing to warn about.
    expect(result.warnings).toEqual([]);
  });

  it("enqueues an invoice PDF with the document model in the report config", async () => {
    const result = await ok("agency.ops.invoice.document.render", {
      agencyId: AGENCY_ID,
      invoiceId,
      paymentLink: "https://pay.example.test/abc",
      paymentTerms: "Payable within 30 days",
    });
    expect(result.reportId).toMatch(/^rpt_/);
    expect(result.status).toBe("queued");

    const { getReportsStore } = await import("../../reports/store.js");
    const record = getReportsStore(stateDir).getReport(result.reportId)!;
    expect(record.kind).toBe("agency_invoice");
    expect(record.sourceRecordId).toBe(invoiceId);
    const document = (record.config as any).document;
    // The worker gets everything it needs as plain JSON — it never opens
    // agency.db.
    expect(document.kind).toBe("invoice");
    expect(document.totals.totalCents).toBe(500_000);
    expect(document.paymentLink.url).toBe("https://pay.example.test/abc");
    expect(document.projects).toContain("Website");
  });

  it("previews and enqueues a proposal document", async () => {
    const preview = await ok("agency.ops.proposal.document.preview", {
      agencyId: AGENCY_ID,
      proposalId,
    });
    expect(preview.html).toContain("Growth retainer");
    expect(preview.summaryText).toContain("Proposal");
    expect(preview.balanceCents).toBe(1_200_000);
    expect(preview.warnings).toEqual([]);

    const render = await ok("agency.ops.proposal.document.render", {
      agencyId: AGENCY_ID,
      proposalId,
    });
    const { getReportsStore } = await import("../../reports/store.js");
    const record = getReportsStore(stateDir).getReport(render.reportId)!;
    expect(record.kind).toBe("agency_proposal");
    expect((record.config as any).document.kind).toBe("proposal");
  });

  it("moves expected revenue when the proposal is accepted", async () => {
    const before = await ok("agency.ops.revenue.summary", { agencyId: AGENCY_ID });
    expect(before.revenue.pipeline.openProposalCents).toBe(1_200_000);
    expect(before.revenue.pipeline.acceptedUninvoicedCents).toBe(0);

    const accepted = await ok("agency.ops.proposal.accept", {
      agencyId: AGENCY_ID,
      proposalId,
      acceptedAt: MARCH_2024,
    });
    expect(accepted.proposal.status).toBe("accepted");
    expect(accepted.pipeline.acceptedUninvoicedCents).toBe(1_200_000);

    const after = await ok("agency.ops.revenue.summary", { agencyId: AGENCY_ID });
    expect(after.revenue.pipeline.openProposalCents).toBe(0);
    expect(after.revenue.pipeline.expectedRevenueCents).toBe(1_200_000);

    // Billing against the proposal moves the money out of "expected".
    await ok("agency.ops.invoice.backlog.record", {
      agencyId: AGENCY_ID,
      clientId,
      proposalId,
      issuedAt: MARCH_2024,
      lineItems: [{ description: "April retainer", quantity: 1, unitPriceCents: 100_000 }],
    });
    const billed = await ok("agency.ops.revenue.summary", { agencyId: AGENCY_ID });
    expect(billed.revenue.pipeline.acceptedUninvoicedCents).toBe(1_100_000);
  });
});
