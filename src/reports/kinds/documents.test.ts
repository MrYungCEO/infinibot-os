/**
 * Integration at the report-system seam: the two document kinds must be
 * registered, must survive the `config_json` round-trip the worker performs,
 * and must return the `{ title, summaryText, html, sourceRecordId }` the worker
 * persists — with `sourceRecordId` linking the row back to the source record.
 *
 * If these pass, `reports.generate { kind, config: { document } }` already
 * works with no gateway changes.
 */

import { describe, expect, it } from "vitest";
import { getKind, listKinds } from "./index.js";
import { getTheme } from "../themes/index.js";
import { INVOICE_REPORT_KIND, PROPOSAL_REPORT_KIND } from "../documents/types.js";
import { DEFAULT_DOCUMENT_THEME } from "../documents/mapper.js";
import { FIXED_NOW, fixtureInvoice, fixtureProposal } from "../documents/test-helpers.js";

/** What the worker actually hands a collector: config as parsed from JSON. */
function roundTrip(config: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

const theme = getTheme(DEFAULT_DOCUMENT_THEME);
const stateDir = "/nonexistent-state-dir";

describe("document report kinds", () => {
  it("are registered under stable ids", () => {
    expect(listKinds()).toContain(INVOICE_REPORT_KIND);
    expect(listKinds()).toContain(PROPOSAL_REPORT_KIND);
    expect(INVOICE_REPORT_KIND).toBe("agency_invoice");
    expect(PROPOSAL_REPORT_KIND).toBe("agency_proposal");
  });

  it("collects an invoice from a JSON-round-tripped config", async () => {
    const model = fixtureInvoice();
    const kind = getKind(INVOICE_REPORT_KIND)!;
    const collected = await kind.collect({
      theme,
      config: roundTrip({ document: model }),
      stateDir,
    });
    expect(collected.title).toBe("Invoice INV-2026-0184 — Meridian Health Partners");
    expect(collected.summaryText).toContain("$34,178.28");
    expect(collected.html.startsWith("<!doctype html>")).toBe(true);
    expect(collected.html).toContain("$24,178.28");
    // Links the report row back to the invoice it renders.
    expect(collected.sourceRecordId).toBe(model.id);
  });

  it("collects a proposal from a JSON-round-tripped config", async () => {
    const model = fixtureProposal();
    const kind = getKind(PROPOSAL_REPORT_KIND)!;
    const collected = await kind.collect({
      theme,
      config: roundTrip({ document: model }),
      stateDir,
    });
    expect(collected.title).toBe("Proposal PRO-2026-0031 — Meridian Health Partners");
    expect(collected.html).toContain("Total investment");
    expect(collected.sourceRecordId).toBe(model.id);
  });

  it("reads nothing from disk — stateDir is never touched", async () => {
    // The gateway supplies the document; the worker must not need agency.db.
    const kind = getKind(INVOICE_REPORT_KIND)!;
    const collected = await kind.collect({
      theme,
      config: roundTrip({ document: fixtureInvoice() }),
      stateDir: "/definitely/not/a/real/path",
    });
    expect(collected.html).toContain("INV-2026-0184");
  });

  it("degrades to an empty document instead of failing the row", async () => {
    const kind = getKind(INVOICE_REPORT_KIND)!;
    const collected = await kind.collect({ theme, config: { now: FIXED_NOW }, stateDir });
    expect(collected.title).toBe("Invoice DRAFT — Client");
    expect(collected.html).toContain("No line items.");
    expect(collected.sourceRecordId).toBeNull();
  });

  it("re-layers branding against the report row's theme", async () => {
    const kind = getKind(INVOICE_REPORT_KIND)!;
    const collected = await kind.collect({
      theme: getTheme("black-gold"),
      config: roundTrip({
        document: fixtureInvoice(),
        brandSource: { name: "Studio North", branding: { primary: "#0f62fe" } },
      }),
      stateDir,
    });
    expect(collected.html).toContain("Studio North");
    expect(collected.html).toContain("--accent: #0f62fe");
    // The rest of the palette follows the requested theme.
    expect(collected.html).toContain(getTheme("black-gold").tokens.bg);
  });
});
