/**
 * HTML template for the `agency_proposal` report kind.
 *
 * Same chrome as the invoice (./document-base.ts) so a client who receives both
 * sees one house style. The differences are content-shaped: a proposal leads
 * with prose (summary, scope, extra sections), prices the work as an investment
 * rather than a demand for payment, and ends with validity + acceptance terms
 * and a signature block instead of a balance due.
 *
 * As with the invoice, `asOf` is supplied by the caller so "expires in N days"
 * is deterministic.
 */

import type { Theme } from "../types.js";
import { esc, escProse } from "../documents/html.js";
import { formatMoney } from "../documents/money.js";
import { daysBetween, formatDocumentDate } from "../documents/date.js";
import type { ProposalDocumentModel, ProposalDocumentStatus } from "../documents/types.js";
import {
  calloutHtml,
  documentShell,
  footerHtml,
  letterheadHtml,
  lineItemsTableHtml,
  metaStripHtml,
  partiesHtml,
  standardTotalsRows,
  totalsHtml,
  type TotalsRow,
} from "./document-base.js";

const STATUS_LABELS: Record<ProposalDocumentStatus, string> = {
  draft: "Draft",
  internal_review: "In review",
  sent: "Awaiting decision",
  accepted: "Accepted",
  rejected: "Declined",
  expired: "Expired",
};

/** Mapped onto the theme's generic pill vocabulary — see the invoice template. */
const STATUS_PILLS: Record<ProposalDocumentStatus, string> = {
  draft: "queued",
  internal_review: "rendering",
  sent: "sent",
  accepted: "ok",
  rejected: "error",
  expired: "timeout",
};

/**
 * A `sent` proposal past its validity date presents as **expired**. `accepted`,
 * `rejected` and `draft` are decisions/edits and are never overridden.
 */
export function effectiveProposalStatus(model: ProposalDocumentModel): ProposalDocumentStatus {
  if (model.status === "accepted" || model.status === "rejected" || model.status === "draft") {
    return model.status;
  }
  if (model.validUntil !== null && model.validUntil < model.asOf) return "expired";
  return model.status;
}

/** "Valid for 21 more days" / "Expired 3 days ago". Null when open-ended. */
export function validityPhrase(model: ProposalDocumentModel): string | null {
  if (model.validUntil === null) return null;
  const days = daysBetween(model.asOf, model.validUntil);
  if (days === 0) return "Expires today";
  if (days > 0) return `Valid for ${days} more day${days === 1 ? "" : "s"}`;
  const past = Math.abs(days);
  return `Expired ${past} day${past === 1 ? "" : "s"} ago`;
}

const DEFAULT_ACCEPTANCE_TERMS = [
  "Acceptance of this proposal constitutes agreement to the scope and fees set out above.",
  "Work begins once this proposal is signed and any initial invoice is settled.",
  "Anything not listed in the scope is out of scope and will be quoted separately.",
  "Fees are quoted exclusive of third-party costs unless stated otherwise.",
];

function proseSection(heading: string, body: string | null | undefined): string {
  const html = escProse(body ?? "");
  if (!html) return "";
  return `<section><h2>${esc(heading)}</h2>${html}</section>`;
}

function signatureHtml(model: ProposalDocumentModel): string {
  const agency = model.signature?.agencySignatory?.trim() || model.brand.name;
  const client = model.signature?.clientSignatory?.trim() || model.client.name;
  return `<div class="sign-grid">
    <div class="sign"><div class="rule"></div><div class="who">Signed for ${esc(agency)}</div></div>
    <div class="sign"><div class="rule"></div><div class="who">Signed for ${esc(client)}</div></div>
  </div>`;
}

function proposalBody(model: ProposalDocumentModel): string {
  const status = effectiveProposalStatus(model);
  const validity = validityPhrase(model);

  // A proposal quotes an investment, not a demand for payment — one emphasised
  // total, no duplicate "Total" row above it.
  const totalsRows: TotalsRow[] = standardTotalsRows(model.totals, model.currency, {
    grandLabel: "Total investment",
    grandVariant: "due",
  });

  const meta = metaStripHtml([
    { label: "Prepared", value: formatDocumentDate(model.preparedAt) },
    {
      label: "Valid until",
      value: model.validUntil === null ? "Open-ended" : formatDocumentDate(model.validUntil),
      accent: status === "expired",
    },
    validity ? { label: "Validity", value: validity, accent: status === "expired" } : null,
    { label: "Currency", value: model.currency.toUpperCase() },
    {
      label: "Total",
      value: formatMoney(model.totals.totalCents, model.currency),
      accent: true,
    },
  ]);

  const extraSections = (model.sections ?? [])
    .map((section) => proseSection(section.heading, section.body))
    .join("");

  const terms = model.acceptanceTerms?.length ? model.acceptanceTerms : DEFAULT_ACCEPTANCE_TERMS;

  return `${letterheadHtml({
    brand: model.brand,
    kindLabel: "Proposal",
    number: model.number,
    statusLabel: STATUS_LABELS[status],
    statusPill: STATUS_PILLS[status],
  })}
${meta}
${partiesHtml([
  { heading: "Prepared for", party: model.client },
  {
    heading: "Prepared by",
    party: { name: model.brand.name, email: model.brand.email, phone: model.brand.phone },
  },
])}

<div class="doc-lead">
  <h1>${esc(model.title)}</h1>
  ${model.summary ? `<div class="summary">${escProse(model.summary)}</div>` : ""}
</div>

${proseSection("Scope of work", model.scope)}
${extraSections}

<section>
  <h2>Investment</h2>
  ${lineItemsTableHtml(model.lineItems, model.currency, "Item")}
  ${totalsHtml(totalsRows)}
</section>

<section class="keep">
  <h2>Acceptance</h2>
  <ul>${terms.map((term) => `<li>${esc(term)}</li>`).join("")}</ul>
  ${signatureHtml(model)}
</section>

${model.notes ? calloutHtml("Notes", model.notes) : ""}
${footerHtml(model.brand, `Proposal ${model.number} · ${STATUS_LABELS[status]}`)}`;
}

/** Standalone print-ready HTML document for a proposal. */
export function buildProposalHtml(model: ProposalDocumentModel, theme: Theme): string {
  return documentShell({
    title: `Proposal ${model.number} — ${model.brand.name}`,
    brand: model.brand,
    theme,
    body: proposalBody(model),
  });
}

/** Style + markup fragment for embedding the proposal in an in-app preview pane. */
export function buildProposalPreviewFragment(model: ProposalDocumentModel, theme: Theme): string {
  return documentShell({
    title: `Proposal ${model.number}`,
    brand: model.brand,
    theme,
    body: proposalBody(model),
    fragment: true,
  });
}

/** One-line summary persisted on the report row. */
export function proposalSummaryText(model: ProposalDocumentModel): string {
  const status = effectiveProposalStatus(model);
  return [
    `Proposal ${model.number}`,
    model.client.name,
    model.title,
    formatMoney(model.totals.totalCents, model.currency),
    STATUS_LABELS[status],
  ].join(" · ");
}

export { STATUS_LABELS as PROPOSAL_STATUS_LABELS, DEFAULT_ACCEPTANCE_TERMS };
