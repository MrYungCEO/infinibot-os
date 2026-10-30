/**
 * `agency_proposal` report kind — a branded, client-ready proposal PDF.
 *
 * Mirror image of the invoice kind (see ./invoice.ts for the full rationale):
 * the gateway builds the model from the agency-operations store and passes it
 * in `config.document`; this collector reads nothing from disk and the worker
 * handles persistence, rendering and fan-out.
 *
 * Config:
 *   - document:     ProposalDocumentModel (required; see documents/types.ts)
 *   - brandSource?: raw `agency_profiles` fields, re-layered against the theme
 *   - now?:         override for "as of" when the model omits `asOf` (tests)
 */

import type { CollectedReport, ReportKindModule, Theme } from "../types.js";
import { parseProposalDocument } from "../documents/parse.js";
import { PROPOSAL_REPORT_KIND } from "../documents/types.js";
import {
  buildProposalHtml,
  proposalSummaryText,
  PROPOSAL_STATUS_LABELS,
} from "../templates/proposal.js";

export const proposalReportKind: ReportKindModule = {
  kind: PROPOSAL_REPORT_KIND,
  collect({ theme, config }): CollectedReport {
    const now = typeof config.now === "number" ? config.now : Date.now();
    const model = parseProposalDocument(config as Record<string, unknown>, theme as Theme, now);
    return {
      title: `Proposal ${model.number} — ${model.client.name}`,
      summaryText: proposalSummaryText(model),
      html: buildProposalHtml(model, theme as Theme),
      sourceRecordId: model.id || null,
    };
  },
};

export { PROPOSAL_STATUS_LABELS };
