/**
 * HTML template for the `agency_invoice` report kind.
 *
 * Renders a standalone, print-ready invoice from an {@link InvoiceDocumentModel}
 * using the shared document chrome (./document-base.ts) so invoices and
 * proposals stay visually identical apart from their content.
 *
 * Money is never recomputed loosely here: line totals come from
 * `resolveLineTotal` (stored value, else one rounded multiply), the balance is
 * `total - amountPaid` clamped at zero, and every figure is formatted from
 * integer cents. `asOf` is supplied by the caller, so "overdue" and "due in N
 * days" are deterministic and the same input always yields the same bytes.
 */

import type { Theme } from "../types.js";
import { esc, escUrl } from "../documents/html.js";
import { balanceCents, formatMoney } from "../documents/money.js";
import { daysBetween, formatDocumentDate } from "../documents/date.js";
import type { InvoiceDocumentModel, InvoiceDocumentStatus } from "../documents/types.js";
import {
  calloutHtml,
  documentShell,
  footerHtml,
  letterheadHtml,
  lineItemsTableHtml,
  metaStripHtml,
  partiesHtml,
  settlementHtml,
  standardTotalsRows,
  type TotalsRow,
} from "./document-base.js";

/** Human labels for the stored status values. */
const STATUS_LABELS: Record<InvoiceDocumentStatus, string> = {
  draft: "Draft",
  issued: "Unpaid",
  partially_paid: "Partially paid",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
};

/**
 * Document statuses mapped onto the theme's generic pill vocabulary
 * (see themes/*.ts `statusPills`), so an invoice renders correctly under any
 * registered theme without each theme having to know about invoices.
 */
const STATUS_PILLS: Record<InvoiceDocumentStatus, string> = {
  draft: "queued",
  issued: "sent",
  partially_paid: "running",
  paid: "ok",
  overdue: "error",
  void: "queued",
};

/**
 * The status actually shown. A stored `issued`/`partially_paid` invoice whose
 * due date has passed presents as **overdue** — the store only flips that field
 * when its sweep runs, and a client-facing document must not under-report.
 * `draft`, `paid` and `void` are never overridden.
 */
export function effectiveInvoiceStatus(model: InvoiceDocumentModel): InvoiceDocumentStatus {
  if (model.status === "paid" || model.status === "void" || model.status === "draft") {
    return model.status;
  }
  if (balanceCents(model.totals.totalCents, model.amountPaidCents) <= 0) return "paid";
  if (model.dueAt !== null && model.dueAt < model.asOf) return "overdue";
  return model.status;
}

/** "Due in 12 days" / "14 days overdue" / "Due today". Null when there is no due date. */
export function duePhrase(model: InvoiceDocumentModel): string | null {
  if (model.dueAt === null) return null;
  const days = daysBetween(model.asOf, model.dueAt);
  if (days === 0) return "Due today";
  if (days > 0) return `Due in ${days} day${days === 1 ? "" : "s"}`;
  const late = Math.abs(days);
  return `${late} day${late === 1 ? "" : "s"} overdue`;
}

function paymentsHtml(model: InvoiceDocumentModel): string {
  const payments = model.payments ?? [];
  if (!payments.length) return "";
  const rows = payments
    .map(
      (payment) => `<tr>
      <td class="desc">${esc(formatDocumentDate(payment.paidAt))}</td>
      <td class="desc">${esc(payment.method || "—")}</td>
      <td class="desc">${esc(payment.reference || "—")}</td>
      <td class="num">${esc(formatMoney(payment.amountCents, model.currency))}</td>
    </tr>`,
    )
    .join("");
  return `<section class="keep">
    <h2>Payments received</h2>
    <table class="items">
      <thead><tr>
        <th class="desc">Date</th><th class="desc">Method</th>
        <th class="desc">Reference</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/** Saved bank / payment option details, as a labelled block of rows. */
function bankDetailsHtml(model: InvoiceDocumentModel): string {
  const bank = model.bankDetails;
  if (!bank) return "";
  const rows: Array<[string, string | null | undefined]> = [
    ["Bank", bank.bankName],
    ["Account name", bank.accountName],
    ["Account number", bank.accountNumber],
    ["IBAN", bank.iban],
    ["SWIFT/BIC", bank.swift],
    ["Routing / sort code", bank.routingNumber],
  ];
  const printable = rows.filter(([, value]) => !!value?.trim());
  const instructions = bank.instructions?.trim();
  if (!printable.length && !instructions) return "";
  const heading = bank.label?.trim() ? `Payment details — ${bank.label.trim()}` : "Payment details";
  const rowsHtml = printable
    .map(
      ([label, value]) => `<tr>
      <td class="desc">${esc(label)}</td>
      <td class="desc">${esc((value ?? "").trim())}</td>
    </tr>`,
    )
    .join("");
  const tableHtml = printable.length
    ? `<table class="items"><tbody>${rowsHtml}</tbody></table>`
    : "";
  const instructionsHtml = instructions ? `<p>${esc(instructions)}</p>` : "";
  return `<section class="keep">
    <h2>${esc(heading)}</h2>
    ${tableHtml}
    ${instructionsHtml}
  </section>`;
}

function paymentLinkHtml(model: InvoiceDocumentModel, balance: number): string {
  if (balance <= 0) return "";
  const link = model.paymentLink;
  const label = link?.label?.trim() || "Pay this invoice";
  const url = typeof link?.url === "string" ? link.url.trim() : "";
  // Only http(s) survives; anything else degrades to the neutral placeholder so
  // the layout is identical whether or not a payment URL has been configured.
  if (/^https?:\/\/[^\s<>"']+$/i.test(url)) {
    // The URL passed the http(s) grammar check above; the *label* is free text
    // and still goes through the strict escaper.
    return `<a class="pay-link" href="${escUrl(url)}">${esc(label)}</a>`;
  }
  return `<span class="pay-link placeholder">Payment link to follow</span>`;
}

/** Build the invoice body markup (shared by the standalone doc and the preview fragment). */
function invoiceBody(model: InvoiceDocumentModel): string {
  const status = effectiveInvoiceStatus(model);
  const balance = balanceCents(model.totals.totalCents, model.amountPaidCents);
  const settled = balance <= 0;

  const totalsRows: TotalsRow[] = standardTotalsRows(model.totals, model.currency);
  if (model.amountPaidCents > 0 || !settled) {
    totalsRows.push({
      label: "Amount paid",
      value:
        model.amountPaidCents > 0
          ? `-${formatMoney(model.amountPaidCents, model.currency)}`
          : formatMoney(0, model.currency),
    });
  }
  totalsRows.push(
    settled
      ? {
          label: "Paid in full",
          value: formatMoney(0, model.currency),
          variant: "settled",
          tone: "positive",
        }
      : {
          label: "Balance due",
          value: formatMoney(balance, model.currency),
          variant: "due",
          // An overdue balance must not look like one that is merely outstanding.
          tone: status === "overdue" ? "danger" : undefined,
        },
  );

  const due = duePhrase(model);
  const meta = metaStripHtml([
    { label: "Issue date", value: formatDocumentDate(model.issuedAt) },
    {
      label: "Due date",
      value: model.dueAt === null ? "On receipt" : formatDocumentDate(model.dueAt),
      accent: status === "overdue",
    },
    due && !settled ? { label: "Terms", value: due, accent: status === "overdue" } : null,
    model.reference ? { label: "Reference", value: model.reference } : null,
    { label: "Currency", value: model.currency.toUpperCase() },
    settled
      ? { label: "Balance", value: formatMoney(0, model.currency), accent: true }
      : { label: "Balance due", value: formatMoney(balance, model.currency), accent: true },
  ]);

  const projects = (model.projects ?? []).filter((name) => !!name?.trim());
  const projectsBlock = projects.length
    ? `<section class="keep"><h2>Projects</h2><ul>${projects
        .map((name) => `<li>${esc(name)}</li>`)
        .join("")}</ul></section>`
    : "";

  const paymentBlock = calloutHtml(
    "Payment",
    model.paymentTerms ?? (settled ? "Thank you — this invoice is settled in full." : ""),
    paymentLinkHtml(model, balance),
  );

  return `${letterheadHtml({
    brand: model.brand,
    kindLabel: "Invoice",
    number: model.number,
    statusLabel: STATUS_LABELS[status],
    statusPill: STATUS_PILLS[status],
  })}
${meta}
${partiesHtml([{ heading: "Billed to", party: model.client }])}

<section>
  <h2>Line items</h2>
  ${lineItemsTableHtml(model.lineItems, model.currency)}
  ${settlementHtml(totalsRows, paymentBlock)}
</section>

${projectsBlock}
${bankDetailsHtml(model)}
${paymentsHtml(model)}
${model.notes ? calloutHtml("Notes", model.notes) : ""}
${footerHtml(model.brand, `Invoice ${model.number} · ${STATUS_LABELS[status]}`)}`;
}

/** Standalone print-ready HTML document for an invoice. */
export function buildInvoiceHtml(model: InvoiceDocumentModel, theme: Theme): string {
  return documentShell({
    title: `Invoice ${model.number} — ${model.brand.name}`,
    brand: model.brand,
    theme,
    body: invoiceBody(model),
  });
}

/** Style + markup fragment for embedding the invoice in an in-app preview pane. */
export function buildInvoicePreviewFragment(model: InvoiceDocumentModel, theme: Theme): string {
  return documentShell({
    title: `Invoice ${model.number}`,
    brand: model.brand,
    theme,
    body: invoiceBody(model),
    fragment: true,
  });
}

/** One-line summary persisted on the report row. */
export function invoiceSummaryText(model: InvoiceDocumentModel): string {
  const status = effectiveInvoiceStatus(model);
  const balance = balanceCents(model.totals.totalCents, model.amountPaidCents);
  return [
    `Invoice ${model.number}`,
    model.client.name,
    formatMoney(model.totals.totalCents, model.currency),
    STATUS_LABELS[status],
    balance > 0 ? `balance ${formatMoney(balance, model.currency)}` : "settled",
  ].join(" · ");
}

export { STATUS_LABELS as INVOICE_STATUS_LABELS };
