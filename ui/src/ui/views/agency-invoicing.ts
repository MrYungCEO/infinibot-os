/**
 * Invoice authoring, backlogging and per-client revenue — presentation layer.
 *
 * Three surfaces live here and are mounted by the finance section of
 * `views/agency-operations.ts`:
 *
 * - the **composer**, a full-screen editor with a live document preview beside
 *   the fields, which is how an invoice gets written and how last quarter's
 *   invoices get backdated into the ledger;
 * - the **payment controls** on the register, which take an arbitrary amount
 *   *and* an arbitrary paid-at date;
 * - the **client revenue panel**, one client's invoices with paid, open and
 *   overdue money separated.
 *
 * The preview is drawn into a sandboxed iframe rather than injected into the
 * page. The gateway returns the same markup the PDF is produced from, complete
 * with its own document stylesheet; inlining that would rewrite the app's own
 * typography. The iframe also means the preview cannot script the page.
 *
 * Nothing here renders an empty rectangle where data is missing: every pane
 * distinguishes "nothing to show" from "we could not load this", and the
 * preview always states whether the document on screen came from the gateway
 * renderer or from the local approximation.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  recordAgencyInvoicePayment,
  setAgencyInvoicePaymentAmount,
  type AgencyInvoice,
  type AgencyOperationsHost,
  type AgencyOperationsState,
} from "../controllers/agency-operations";
import {
  INVOICE_CADENCES,
  INVOICE_CURRENCIES,
  addInvoiceLine,
  centsToInput,
  closeClientRevenue,
  closeInvoiceComposer,
  computeInvoiceTotals,
  dayToTimestamp,
  describePeriod,
  endOfMonthsAgo,
  hasNativeInvoiceAuthoring,
  invoiceDraftProblems,
  invoiceMethod,
  invoicePaymentDate,
  invoicingState,
  isBackdated,
  isOverdue,
  isoDay,
  loadClientRevenue,
  loadPaymentAccounts,
  moneyCents,
  mrrDraftValue,
  setMrrDraft,
  saveClientMrr,
  saveProjectMrr,
  moveInvoiceLine,
  openInvoiceComposer,
  parseCents,
  patchInvoiceDraft,
  patchInvoiceLine,
  patchPaymentAccountDraft,
  primeInvoiceNumber,
  deletePaymentAccount,
  removeInvoiceLine,
  savePaymentAccount,
  togglePaymentAccountForm,
  renderInvoiceDocument,
  saveInvoiceDraft,
  scheduleInvoicePreview,
  setInvoiceIssueDate,
  setInvoicePaymentDate,
  shiftDay,
  voidInvoice,
  type AgencyInvoicingState,
  type InvoiceCadence,
  type InvoiceTotals,
  type PaymentAccountDraft,
} from "../controllers/agency-invoicing";
import {
  downloadInvoicePdf,
  existingInvoiceReport,
  invoicePdfBusy,
  invoicePdfState,
  primeInvoiceReportIndex,
  type InvoicePdfTarget,
} from "../controllers/invoice-pdf";
import {
  createInvoicePaymentLink,
  detachInvoicePaymentLink,
  paymentLinkBusy,
  paymentLinkState,
  primeInvoicePaymentLink,
  supportsPaymentLinks,
} from "../controllers/invoice-payment-link";
import {
  closePaymentCredentials,
  openPaymentCredentials,
  paymentCredentialsState,
  savePaymentCredentials,
  setPaymentCredentialDraft,
  supportsPaymentCredentials,
  paymentCredentialsComplete,
  primePaymentCredentials,
} from "../controllers/payment-credentials";

/**
 * Owner id for the always-available header instance of the credentials editor,
 * distinct from any invoice id so the two can never collide.
 */
const CREDENTIALS_HEADER_OWNER = "__header__";

/** Clients listed at once in the picker before the operator must narrow down. */
const CLIENT_RESULT_LIMIT = 40;

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
}

/* ------------------------------------------------------------------ *
 * Register: payment controls
 * ------------------------------------------------------------------ */

/**
 * Amount and date controls for one open invoice.
 *
 * Replaces a button that always paid the whole balance on today's date. Both
 * are now operator-set, which is the difference between "mark this paid" and
 * "record the £4,000 that arrived on 14 March".
 */
export function renderInvoicePaymentControls(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  invoice: AgencyInvoice,
): TemplateResult | typeof nothing {
  if (invoice.balanceCents <= 0) return nothing;
  if (!["issued", "partially_paid", "overdue"].includes(invoice.status)) return nothing;

  const draftText = state.invoicePaymentAmounts[invoice.id] ?? centsToInput(invoice.balanceCents);
  const amountCents = parseCents(draftText);
  const amountValid =
    amountCents !== null && amountCents > 0 && amountCents <= invoice.balanceCents;
  const day = invoicePaymentDate(host, invoice.id);
  const paidAt = dayToTimestamp(day);
  const dateValid = paidAt !== null;
  const backdated = isBackdated(day);
  const busy = state.secondaryBusyId === invoice.id;
  const full = amountValid && amountCents === invoice.balanceCents;

  return html`
    <div class="aoi-pay">
      <label class="aoi-field tight">
        <span>Amount (${invoice.currency})</span>
        <input
          type="text"
          inputmode="decimal"
          autocomplete="off"
          class=${amountValid || !draftText.trim() ? "" : "invalid"}
          aria-label=${`Payment amount for invoice ${invoice.number}, up to ${centsToInput(invoice.balanceCents)} ${invoice.currency}`}
          aria-invalid=${amountValid ? "false" : "true"}
          .value=${draftText}
          @input=${(event: Event) =>
            setAgencyInvoicePaymentAmount(host, invoice.id, inputValue(event))}
        />
      </label>
      <label class="aoi-field tight">
        <span>Paid on</span>
        <input
          type="date"
          class=${dateValid ? "" : "invalid"}
          aria-label=${`Date the payment for invoice ${invoice.number} was received`}
          .value=${day}
          @change=${(event: Event) => setInvoicePaymentDate(host, invoice.id, inputValue(event))}
        />
      </label>
      <div class="aoi-pay-quick">
        <button
          type="button"
          class="aoi-link"
          aria-label=${`Set the payment amount for invoice ${invoice.number} to the full balance`}
          @click=${() =>
            setAgencyInvoicePaymentAmount(host, invoice.id, centsToInput(invoice.balanceCents))}
        >Full balance</button>
        <button
          type="button"
          class="aoi-link"
          aria-label=${`Set the payment date for invoice ${invoice.number} to today`}
          @click=${() => setInvoicePaymentDate(host, invoice.id, isoDay())}
        >Today</button>
      </div>
      <button
        class="aoi-btn"
        aria-label=${`Record a ${full ? "full" : "partial"} payment against invoice ${invoice.number}`}
        ?disabled=${busy || !amountValid || !dateValid}
        @click=${() =>
          void recordAgencyInvoicePayment(host, client, invoice.id, amountCents!, paidAt!)}
      >${busy ? "Recording…" : full ? "Record full payment" : "Record partial payment"}</button>
      ${
        backdated && dateValid
          ? html`<span class="aoi-pill info" role="note"
              >Backdated to ${describePeriod(day)}</span
            >`
          : nothing
      }
      ${
        !amountValid && draftText.trim()
          ? html`<span class="aoi-pill danger" role="alert"
              >Enter an amount between 0.01 and ${centsToInput(invoice.balanceCents)}</span
            >`
          : nothing
      }
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * Register: PDF download
 * ------------------------------------------------------------------ */

/**
 * Class names per host surface, so one control serves both stylesheets.
 *
 * The CRM tab and Agency Operations were written with separate design
 * vocabularies (`crm-ag-*` and `aoi-*`). Forking the control to match would
 * fork the queued/ready race handling with it, which is the part that is easy
 * to get wrong — so the markup is shared and only the class names differ.
 */
const DOWNLOAD_CLASSES = {
  aoi: { row: "aoi-dl", button: "aoi-btn", link: "aoi-link", note: "aoi-note" },
  crm: { row: "crm-ag-dl", button: "crm-ag-btn", link: "crm-ag-link", note: "crm-ag-note" },
} as const;

export type InvoiceDownloadVariant = keyof typeof DOWNLOAD_CLASSES;

/**
 * "Download PDF" for one invoice, wherever an invoice is shown.
 *
 * The button is never disabled for lack of a stored PDF: an invoice with no
 * report is rendered on demand and polled, which is the whole point. It is
 * disabled only while its own download is in flight, and it always says which
 * of the two is happening.
 */
export function renderInvoiceDownload(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoice: InvoicePdfTarget,
  variant: InvoiceDownloadVariant = "aoi",
): TemplateResult {
  const css = DOWNLOAD_CLASSES[variant];
  const pdf = invoicePdfState(invoice.id);
  const busy = invoicePdfBusy(invoice.id);
  // Index-only lookup: a warm index means this invoice's PDF already exists and
  // the click is a straight fetch. A cold index is not "no PDF" — it just means
  // the click will find out, so the label stays honest either way.
  const stored = existingInvoiceReport(invoice.id);
  primeInvoiceReportIndex(host, client);

  const label = busy
    ? (pdf.phase === "downloading" ? "Fetching…" : pdf.phase === "rendering" ? "Rendering…" : "Locating…")
    : "Download PDF";

  return html`
    <div class=${css.row}>
      <button
        type="button"
        class=${css.button}
        aria-label=${`Download the PDF for invoice ${invoice.number}`}
        aria-busy=${busy ? "true" : "false"}
        title=${
          stored
            ? `A rendered PDF is already on file${stored.renderedAt ? ` from ${new Date(stored.renderedAt).toLocaleString()}` : ""} — it downloads straight away.`
            : "Renders the branded invoice document and downloads it. This takes a few seconds the first time."
        }
        ?disabled=${busy}
        @click=${() => void downloadInvoicePdf(host, client, invoice)}
      >${label}</button>
      ${
        stored && !busy
          ? html`<button
              type="button"
              class=${css.link}
              aria-label=${`Render a fresh PDF for invoice ${invoice.number} and download it`}
              title="Renders the document again from the invoice as it stands now, including any payments recorded since the stored PDF was made."
              @click=${() => void downloadInvoicePdf(host, client, invoice, { force: true })}
            >Re-render</button>`
          : nothing
      }
      ${
        busy && pdf.message
          ? html`<span class=${css.note} role="status">${pdf.message}</span>`
          : nothing
      }
      ${
        pdf.phase === "done" && pdf.message
          ? html`<span class=${css.note} role="status"
              >${pdf.message}${
                pdf.fromExistingReport
                  ? " Payments recorded since then are not in it — use Re-render for a current copy."
                  : ""
              }</span
            >`
          : nothing
      }
      ${
        pdf.error
          ? html`<span class=${`${css.note} is-bad`} role="alert">${pdf.error}</span>`
          : nothing
      }
    </div>
  `;
}

/**
 * Whop credentials, editable inline from any invoice surface.
 *
 * Rendered directly under the payment-link control, so the message that blocks
 * the operator ("Whop API key not configured") sits next to the two fields that
 * unblock it. Both fields are masked/autocomplete-off, the key is write-only —
 * the gateway only ever returns a `••••1234` tail — and the company id is
 * prefilled from whatever is already on file.
 */
export function renderPaymentCredentialsEditor(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  variant: InvoiceDownloadVariant = "aoi",
  agencyId?: string | null,
  /** The row drawing this. The editor only opens under the row that asked. */
  ownerId?: string | null,
): TemplateResult | typeof nothing {
  if (!supportsPaymentCredentials(client)) return nothing;
  const cred = paymentCredentialsState();
  const css = DOWNLOAD_CLASSES[variant];
  primePaymentCredentials(host, client, agencyId);

  // Another row owns the open editor — draw nothing rather than a duplicate.
  if (cred.open && cred.openFor !== (ownerId ?? null)) return nothing;

  if (!cred.open) {
    // The header already renders its own always-present button, so this
    // instance contributes only the panel itself.
    if (ownerId === CREDENTIALS_HEADER_OWNER) return nothing;
    // Once both halves are on file this is settled; stop advertising setup on
    // every invoice and let the link control speak for itself.
    if (paymentCredentialsComplete()) return nothing;
    return html`
      <div class=${css.row}>
        <button
          type="button"
          class=${css.link}
          title="Set the Whop API key and company id this machine uses to create checkout links."
          @click=${() => openPaymentCredentials(host, client, agencyId, ownerId ?? null)}
        >${cred.status?.configured ? "Payment keys" : "Set up Whop keys"}</button>
        ${
          cred.status?.configured && !cred.status.companyId
            ? html`<span class=${css.note} role="status"
                >Key on file (${cred.status.hint}) — company id still missing.</span
              >`
            : nothing
        }
      </div>
    `;
  }

  return html`
    <div class="aoi-cred">
      <div class="aoi-cred-head">
        <strong>Whop payment keys</strong>
        <button
          type="button"
          class=${css.link}
          aria-label="Close the payment key editor"
          @click=${() => closePaymentCredentials(host)}
        >Close</button>
      </div>
      <p class="aoi-cred-why">
        Stored on this machine, which is the one that mints checkout links. The
        Business page's income settings save to the master node and do not reach
        this store.
      </p>
      <label class="aoi-cred-field">
        <span
          >Whop API key${
            cred.status?.configured
              ? html` <em
                  >— on file ${cred.status.hint}${cred.status.fromEnv
                    ? " (from WHOP_API_KEY)"
                    : ""}, leave blank to keep</em
                >`
              : nothing
          }</span
        >
        <input
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="apik_…"
          .value=${cred.keyDraft}
          ?disabled=${cred.saving}
          @input=${(event: Event) =>
            setPaymentCredentialDraft(host, "keyDraft", inputValue(event))}
        />
      </label>
      <label class="aoi-cred-field">
        <span
          >Whop company id${
            cred.status?.companyId ? nothing : html` <em>— required</em>`
          }</span
        >
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="biz_…"
          .value=${cred.companyDraft}
          ?disabled=${cred.saving}
          @input=${(event: Event) =>
            setPaymentCredentialDraft(host, "companyDraft", inputValue(event))}
        />
        <small>Whop dashboard → Settings → API → Company ID</small>
      </label>
      <div class="aoi-cred-actions">
        <button
          type="button"
          class="aoi-btn primary"
          ?disabled=${cred.saving}
          aria-busy=${cred.saving ? "true" : "false"}
          @click=${() => void savePaymentCredentials(host, client, agencyId)}
        >${cred.saving ? "Saving…" : "Save keys"}</button>
        ${
          cred.loading
            ? html`<span class=${css.note} role="status">Reading current keys…</span>`
            : nothing
        }
        ${
          cred.message
            ? html`<span class=${css.note} role="status">${cred.message}</span>`
            : nothing
        }
        ${
          cred.error
            ? html`<span class=${`${css.note} is-bad`} role="alert">${cred.error}</span>`
            : nothing
        }
      </div>
    </div>
  `;
}

/**
 * The Whop payment link for one invoice, wherever an invoice is shown.
 *
 * Renders nothing at all when the gateway does not serve the payment-link RPCs,
 * so an older gateway shows no dead control. Otherwise it always states the
 * invoice's true position — a live link with its URL, or no link with the way
 * to make one — because the read (`.get`) is cheap and is primed from here.
 *
 * A missing Whop API key is shown as a setup note rather than an error: it is
 * the expected state on a fresh install, and the gateway's own message already
 * names the fix.
 */
export function renderInvoicePaymentLink(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  invoice: InvoicePdfTarget,
  variant: InvoiceDownloadVariant = "aoi",
  agencyId?: string | null,
): TemplateResult | typeof nothing {
  if (!supportsPaymentLinks(client)) return nothing;
  const css = DOWNLOAD_CLASSES[variant];
  const state = paymentLinkState(invoice.id);
  const busy = paymentLinkBusy(invoice.id);
  primeInvoicePaymentLink(host, client, invoice.id, agencyId);

  const link = state.link;
  return html`
    <div class=${css.row}>
      ${
        link
          ? html`
              <a
                class=${css.link}
                href=${link.url}
                target="_blank"
                rel="noopener noreferrer"
                title=${`Opens the live ${link.provider} checkout for invoice ${invoice.number}.`}
                >${link.label ?? "Pay online"} ↗</a
              >
              <button
                type="button"
                class=${css.button}
                ?disabled=${busy}
                aria-busy=${busy ? "true" : "false"}
                aria-label=${`Replace the payment link for invoice ${invoice.number}`}
                title="Mints a new checkout for the amount still outstanding and retires this one. Any copy of the old URL stops working."
                @click=${() =>
                  void createInvoicePaymentLink(host, client, invoice, {
                    regenerate: true,
                    agencyId,
                  })}
              >Replace</button>
              <button
                type="button"
                class=${css.button}
                ?disabled=${busy}
                aria-label=${`Remove the payment link for invoice ${invoice.number}`}
                title="Unbinds the link here and retires the checkout at Whop, so the URL stops taking payment."
                @click=${() => void detachInvoicePaymentLink(host, client, invoice, agencyId)}
              >Remove</button>
            `
          : html`
              <button
                type="button"
                class=${css.button}
                ?disabled=${busy}
                aria-busy=${busy ? "true" : "false"}
                aria-label=${`Create a Whop payment link for invoice ${invoice.number}`}
                title="Creates a Whop checkout for the balance still outstanding and embeds it in the invoice document."
                @click=${() =>
                  void createInvoicePaymentLink(host, client, invoice, { agencyId })}
              >${busy ? "Creating…" : "Create payment link"}</button>
            `
      }
      ${
        state.message
          ? html`<span class=${css.note} role="status">${state.message}</span>`
          : nothing
      }
      ${
        state.error
          ? html`<span
              class=${state.needsCredentials ? css.note : `${css.note} is-bad`}
              role=${state.needsCredentials ? "status" : "alert"}
              >${state.error}</span
            >`
          : nothing
      }
      ${
        // The blocking message is only useful if it is also the way out.
        state.needsCredentials
          ? html`<button
              type="button"
              class="aoi-btn primary"
              @click=${() =>
                openPaymentCredentials(host, client, agencyId, invoice.id)}
            >Add Whop keys</button>`
          : nothing
      }
    </div>
    ${renderPaymentCredentialsEditor(host, client, variant, agencyId, invoice.id)}
  `;
}

/* ------------------------------------------------------------------ *
 * Finance header actions
 * ------------------------------------------------------------------ */

/**
 * Opens the composer and immediately draws the document, so the preview pane is
 * never an empty rectangle on first paint.
 *
 * Exported as `launchInvoiceComposer` for the CRM's own invoicing tab, which
 * must open *this* composer rather than grow a second one.
 */
export function launchComposer(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  options: { clientId?: string; backdated?: boolean } = {},
): void {
  openInvoiceComposer(host, options);
  scheduleInvoicePreview(host, client, 0);
  void primeInvoiceNumber(host, client);
  void loadPaymentAccounts(host, client);
}

export { launchComposer as launchInvoiceComposer };

/** The two ways in: a new invoice, or a historical one. */
export function renderInvoiceActions(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult {
  const native = hasNativeInvoiceAuthoring(client);
  return html`
    <button
      class="aoi-btn primary"
      aria-label="Create a new invoice"
      ?disabled=${!state.selectedAgencyId}
      @click=${() => launchComposer(host, client)}
    >+ New invoice</button>
    <button
      class="aoi-btn"
      aria-label="Record a historical invoice that was issued in the past"
      ?disabled=${!state.selectedAgencyId}
      @click=${() => launchComposer(host, client, { backdated: true })}
    >Backlog past invoice</button>
    ${
      // Persistent way in, independent of whether any invoice is currently
      // blocked. Without this the editor vanished the moment both fields were
      // filled, leaving no way to correct a wrong company id.
      supportsPaymentCredentials(client)
        ? html`<button
            class="aoi-btn"
            aria-label="Edit the Whop API key and company id used for payment links"
            title="The Whop API key and company id this machine uses to create checkout links."
            ?disabled=${!state.selectedAgencyId}
            @click=${() =>
              paymentCredentialsState().open
                ? closePaymentCredentials(host)
                : openPaymentCredentials(host, client, state.selectedAgencyId, CREDENTIALS_HEADER_OWNER)}
          >Payment keys</button>`
        : nothing
    }
    ${
      native
        ? nothing
        : html`<span
            class="aoi-pill warning"
            role="note"
            title="agency.ops.invoice.create is not advertised by this gateway. Invoices are written through the structured-ingest path instead, which stores the same record."
            >Compatibility write path</span
          >`
    }
    ${renderPaymentCredentialsEditor(
      host,
      client,
      "aoi",
      state.selectedAgencyId,
      CREDENTIALS_HEADER_OWNER,
    )}
  `;
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */

function clientPicker(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  draft: AgencyInvoicingState,
): TemplateResult {
  const selected = state.clients.find((entry) => entry.id === draft.clientId) ?? null;
  if (selected) {
    return html`
      <div class="aoi-field">
        <span>Client</span>
        <div class="aoi-chosen">
          <div class="aoi-chosen-main">
            <strong>${selected.name}</strong>
            <small>${selected.billingEmail ?? "No billing email"} · ${selected.invoiceCount} invoices · ${moneyCents(selected.outstandingCents, draft.currency)} outstanding</small>
          </div>
          <button
            type="button"
            class="aoi-link"
            aria-label=${`Choose a different client instead of ${selected.name}`}
            @click=${() => {
              patchInvoiceDraft(host, { clientId: "", clientQuery: "" });
              scheduleInvoicePreview(host, client, 0);
            }}
          >Change</button>
          <button
            type="button"
            class="aoi-link"
            aria-label=${`Open the revenue history for ${selected.name}`}
            @click=${() => void loadClientRevenue(host, client, selected.id)}
          >Revenue history</button>
        </div>
      </div>
    `;
  }

  const needle = draft.clientQuery.trim().toLowerCase();
  const matches = state.clients.filter(
    (entry) =>
      !needle ||
      entry.name.toLowerCase().includes(needle) ||
      (entry.billingEmail ?? "").toLowerCase().includes(needle),
  );
  const shown = matches.slice(0, CLIENT_RESULT_LIMIT);
  return html`
    <label class="aoi-field">
      <span>Client</span>
      <input
        type="search"
        autocomplete="off"
        placeholder=${`Search ${state.clients.length} clients by name or billing email`}
        aria-label="Search for the client this invoice bills"
        .value=${draft.clientQuery}
        @input=${(event: Event) => patchInvoiceDraft(host, { clientQuery: inputValue(event) })}
      />
    </label>
    <div class="aoi-results" role="listbox" aria-label="Matching clients">
      ${
        state.clients.length === 0
          ? html`<p class="aoi-note">
              No clients are loaded. If the client directory above is also empty this is a data
              problem, not an empty agency — check the failed-request banner.
            </p>`
          : shown.length === 0
            ? html`<p class="aoi-note">No client matches “${draft.clientQuery}”.</p>`
            : shown.map(
                (entry) => html`
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    class="aoi-result"
                    @click=${() => {
                      patchInvoiceDraft(host, { clientId: entry.id, clientQuery: "" });
                      scheduleInvoicePreview(host, client, 0);
                    }}
                  >
                    <span class="aoi-result-name">${entry.name}</span>
                    <span class="aoi-result-meta"
                      >${entry.status} · ${entry.invoiceCount} invoices ·
                      ${moneyCents(entry.lifetimeInvoicedCents, draft.currency)} lifetime</span
                    >
                  </button>
                `,
              )
      }
      ${
        matches.length > shown.length
          ? html`<p class="aoi-note">
              Showing ${shown.length} of ${matches.length}. Keep typing to narrow the list.
            </p>`
          : nothing
      }
    </div>
  `;
}

/**
 * Payment-option picker: a dropdown of the agency's saved bank details plus an
 * inline "add new" form. The attached option's details print on the document.
 */
function paymentOptionPicker(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  draft: AgencyInvoicingState,
): TemplateResult {
  const selected = draft.paymentAccounts.find((account) => account.id === draft.paymentAccountId);
  const field = (
    label: string,
    key: keyof PaymentAccountDraft,
    placeholder = "",
  ): TemplateResult => html`
    <label class="aoi-field">
      <span>${label}</span>
      <input
        type="text"
        placeholder=${placeholder}
        aria-label=${`Payment option ${label}`}
        .value=${draft.newAccount[key]}
        @input=${(event: Event) => patchPaymentAccountDraft(host, { [key]: inputValue(event) })}
      />
    </label>
  `;
  return html`
    <div class="aoi-field aoi-payment-option">
      <span>Bank details / payment option</span>
      <div class="aoi-payment-row">
        <select
          aria-label="Saved payment option printed on this invoice"
          @change=${(event: Event) => {
            patchInvoiceDraft(host, { paymentAccountId: inputValue(event) });
            scheduleInvoicePreview(host, client);
          }}
        >
          <option value="" ?selected=${!draft.paymentAccountId}>No bank details</option>
          ${draft.paymentAccounts.map(
            (account) => html`<option
              value=${account.id}
              ?selected=${draft.paymentAccountId === account.id}
            >${account.label}${account.currency ? ` · ${account.currency.toUpperCase()}` : ""}</option>`,
          )}
        </select>
        <button
          type="button"
          class="aoi-btn ghost"
          aria-label="Add a new saved payment option"
          @click=${() => togglePaymentAccountForm(host, !draft.newAccountOpen)}
        >${draft.newAccountOpen ? "Close" : "+ Add new"}</button>
      </div>
      ${
        selected
          ? html`<div class="aoi-quick">
              <button
                type="button"
                class="aoi-link danger"
                aria-label=${`Delete the saved payment option ${selected.label}`}
                @click=${() => void deletePaymentAccount(host, client, selected.id)}
              >Delete “${selected.label}”</button>
            </div>`
          : nothing
      }
      ${
        draft.newAccountOpen
          ? html`<div class="aoi-payment-form">
              <div class="aoi-grid two">
                ${field("Label", "label", "USD Wise")}
                <label class="aoi-field">
                  <span>Currency (optional)</span>
                  <select
                    aria-label="Payment option currency"
                    @change=${(event: Event) =>
                      patchPaymentAccountDraft(host, { currency: inputValue(event) })}
                  >
                    <option value="" ?selected=${!draft.newAccount.currency}>—</option>
                    ${INVOICE_CURRENCIES.map(
                      (code) => html`<option
                        value=${code}
                        ?selected=${draft.newAccount.currency.toUpperCase() === code}
                      >${code}</option>`,
                    )}
                  </select>
                </label>
              </div>
              <div class="aoi-grid two">
                ${field("Bank name", "bankName")} ${field("Account name", "accountName")}
              </div>
              <div class="aoi-grid two">
                ${field("Account number", "accountNumber")} ${field("Routing / sort code", "routingNumber")}
              </div>
              <div class="aoi-grid two">${field("IBAN", "iban")} ${field("SWIFT / BIC", "swift")}</div>
              <label class="aoi-field">
                <span>Other instructions</span>
                <textarea
                  rows="2"
                  aria-label="Free-form payment instructions"
                  .value=${draft.newAccount.instructions}
                  @input=${(event: Event) =>
                    patchPaymentAccountDraft(host, { instructions: inputValue(event) })}
                ></textarea>
              </label>
              ${
                draft.accountError
                  ? html`<span class="aoi-pill danger" role="alert">${draft.accountError}</span>`
                  : nothing
              }
              <div class="aoi-foot-actions">
                <button
                  type="button"
                  class="aoi-btn ghost"
                  @click=${() => togglePaymentAccountForm(host, false)}
                >Cancel</button>
                <button
                  type="button"
                  class="aoi-btn primary"
                  ?disabled=${draft.savingAccount}
                  @click=${() => void savePaymentAccount(host, client)}
                >${draft.savingAccount ? "Saving…" : "Save payment option"}</button>
              </div>
            </div>`
          : nothing
      }
    </div>
  `;
}

function dateBlock(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  draft: AgencyInvoicingState,
): TemplateResult {
  const backdated = isBackdated(draft.issueDate);
  const setIssue = (day: string) => {
    setInvoiceIssueDate(host, day);
    scheduleInvoicePreview(host, client);
  };
  const setDue = (day: string) => {
    patchInvoiceDraft(host, { dueDate: day });
    scheduleInvoicePreview(host, client);
  };
  return html`
    <div class="aoi-grid two">
      <label class="aoi-field">
        <span>Issue date</span>
        <input
          type="date"
          aria-label="Date this invoice was or will be issued. Past dates are allowed."
          .value=${draft.issueDate}
          @change=${(event: Event) => setIssue(inputValue(event))}
        />
        <div class="aoi-quick">
          <button type="button" class="aoi-link" @click=${() => setIssue(isoDay())}>Today</button>
          <button type="button" class="aoi-link" @click=${() => setIssue(endOfMonthsAgo(1))}>
            End of last month
          </button>
          <button type="button" class="aoi-link" @click=${() => setIssue(endOfMonthsAgo(2))}>
            2 months ago
          </button>
          <button type="button" class="aoi-link" @click=${() => setIssue(endOfMonthsAgo(3))}>
            3 months ago
          </button>
        </div>
      </label>
      <label class="aoi-field">
        <span>Due date</span>
        <input
          type="date"
          aria-label="Date payment is due. May also be in the past for historical invoices."
          .value=${draft.dueDate}
          @change=${(event: Event) => setDue(inputValue(event))}
        />
        <div class="aoi-quick">
          <button type="button" class="aoi-link" @click=${() => setDue(draft.issueDate)}>
            On receipt
          </button>
          <button type="button" class="aoi-link" @click=${() => setDue(shiftDay(draft.issueDate, 14))}>
            Net 14
          </button>
          <button type="button" class="aoi-link" @click=${() => setDue(shiftDay(draft.issueDate, 30))}>
            Net 30
          </button>
          <button type="button" class="aoi-link" @click=${() => setDue(shiftDay(draft.issueDate, 60))}>
            Net 60
          </button>
        </div>
      </label>
    </div>
    ${
      backdated
        ? html`
            <div class="aoi-banner info" role="note">
              <strong>Backlog entry — issued ${describePeriod(draft.issueDate)}.</strong>
              This invoice is recorded into that period, so revenue, MRR and receivables move in the
              month it actually belongs to rather than this one.
            </div>
            <div class="aoi-grid two">
              <label class="aoi-field">
                <span>Already paid (optional)</span>
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="0.00"
                  class=${!draft.paidAmount.trim() || parseCents(draft.paidAmount) !== null ? "" : "invalid"}
                  aria-label="Amount already received against this historical invoice"
                  .value=${draft.paidAmount}
                  @input=${(event: Event) => patchInvoiceDraft(host, { paidAmount: inputValue(event) })}
                />
              </label>
              <label class="aoi-field">
                <span>Received on</span>
                <input
                  type="date"
                  aria-label="Date the historical payment was received"
                  .value=${draft.paidDate}
                  @change=${(event: Event) => patchInvoiceDraft(host, { paidDate: inputValue(event) })}
                />
              </label>
            </div>
            <p class="aoi-note">
              Leave the amount blank for an invoice that went unpaid. Anything entered here is
              recorded as cash collected on that date, not today, so the collections history is
              real. Further part-payments can be added from the register afterwards.
            </p>
          `
        : nothing
    }
  `;
}

function lineEditor(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  draft: AgencyInvoicingState,
  totals: InvoiceTotals,
): TemplateResult {
  return html`
    <div class="aoi-lines" role="group" aria-label="Invoice line items">
      <div class="aoi-line head" aria-hidden="true">
        <span>Description</span><span>Qty</span><span>Unit price</span><span>Cadence</span>
        <span class="num">Amount</span><span></span>
      </div>
      ${draft.lines.map((line, index) => {
        const computed = totals.lines[index];
        const quantityValid = computed?.quantityValid !== false;
        const priceValid = computed?.priceValid !== false || !line.unitPrice.trim();
        const change = (patch: Parameters<typeof patchInvoiceLine>[2]) => {
          patchInvoiceLine(host, line.key, patch);
          scheduleInvoicePreview(host, client);
        };
        return html`
          <div class="aoi-line">
            <input
              type="text"
              placeholder="What was delivered"
              aria-label=${`Description for line item ${index + 1}`}
              .value=${line.description}
              @input=${(event: Event) => change({ description: inputValue(event) })}
            />
            <input
              type="text"
              inputmode="decimal"
              class=${quantityValid ? "" : "invalid"}
              aria-label=${`Quantity for line item ${index + 1}`}
              aria-invalid=${quantityValid ? "false" : "true"}
              .value=${line.quantity}
              @input=${(event: Event) => change({ quantity: inputValue(event) })}
            />
            <input
              type="text"
              inputmode="decimal"
              placeholder="0.00"
              class=${priceValid ? "" : "invalid"}
              aria-label=${`Unit price for line item ${index + 1} in ${draft.currency}`}
              aria-invalid=${priceValid ? "false" : "true"}
              .value=${line.unitPrice}
              @input=${(event: Event) => change({ unitPrice: inputValue(event) })}
            />
            <select
              aria-label=${`Billing cadence for line item ${index + 1}`}
              @change=${(event: Event) => change({ cadence: inputValue(event) as InvoiceCadence })}
            >
              ${INVOICE_CADENCES.map(
                (cadence) => html`<option
                  value=${cadence.id}
                  ?selected=${line.cadence === cadence.id}
                >${cadence.label}</option>`,
              )}
            </select>
            <span class="aoi-line-total num"
              >${
                computed?.totalCents === null || computed === undefined
                  ? html`<em>—</em>`
                  : moneyCents(computed.totalCents, draft.currency)
              }</span
            >
            <div class="aoi-line-tools">
              <button
                type="button"
                class="aoi-icon"
                aria-label=${`Move line item ${index + 1} up`}
                ?disabled=${index === 0}
                @click=${() => moveInvoiceLine(host, line.key, -1)}
              >↑</button>
              <button
                type="button"
                class="aoi-icon"
                aria-label=${`Move line item ${index + 1} down`}
                ?disabled=${index === draft.lines.length - 1}
                @click=${() => moveInvoiceLine(host, line.key, 1)}
              >↓</button>
              <button
                type="button"
                class="aoi-icon danger"
                aria-label=${`Remove line item ${index + 1}`}
                @click=${() => {
                  removeInvoiceLine(host, line.key);
                  scheduleInvoicePreview(host, client);
                }}
              >✕</button>
            </div>
          </div>
        `;
      })}
    </div>
    <button
      type="button"
      class="aoi-btn ghost"
      aria-label="Add another line item"
      @click=${() => addInvoiceLine(host)}
    >+ Line item</button>
  `;
}

function totalsBlock(draft: AgencyInvoicingState, totals: InvoiceTotals): TemplateResult {
  return html`
    <div class="aoi-totals">
      <div><span>Subtotal</span><b>${moneyCents(totals.subtotalCents, draft.currency)}</b></div>
      <div>
        <span>${draft.taxLabel.trim() || "Tax"} · ${draft.taxPercent || "0"}%</span>
        <b>${totals.taxValid ? moneyCents(totals.taxCents, draft.currency) : "—"}</b>
      </div>
      <div class="grand"><span>Total</span><b>${moneyCents(totals.totalCents, draft.currency)}</b></div>
      ${
        totals.recurringMonthlyCents > 0
          ? html`<div class="recurring">
              <span>Recurring value</span
              ><b>${moneyCents(totals.recurringMonthlyCents, draft.currency)} / month</b>
            </div>`
          : nothing
      }
    </div>
  `;
}

function previewPane(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  state: AgencyOperationsState,
  draft: AgencyInvoicingState,
): TemplateResult {
  const renderMethod = invoiceMethod(client, "render");
  const previewMethod = invoiceMethod(client, "preview");
  const clientName =
    state.clients.find((entry) => entry.id === draft.clientId)?.name ?? "Client";
  return html`
    <aside class="aoi-preview" aria-label="Invoice document preview">
      <header class="aoi-preview-head">
        <div class="aoi-preview-title">
          <strong>Document preview</strong>
          ${
            draft.previewSource === "gateway"
              ? html`<span class="aoi-pill success">Branded renderer · identical to the PDF</span>`
              : !previewMethod
                ? html`<span class="aoi-pill warning"
                    >Local approximation — this gateway build does not serve the document
                    renderer</span
                  >`
                : !draft.invoiceId
                  ? html`<span class="aoi-pill info"
                      >Live draft — the branded document appears the moment this invoice is
                      saved</span
                    >`
                  : html`<span class="aoi-pill warning">Local approximation</span>`
          }
          ${draft.previewLoading ? html`<span class="aoi-pill info">Refreshing…</span>` : nothing}
        </div>
        <button
          class="aoi-btn"
          aria-label="Render this invoice as a branded PDF"
          title=${
            !renderMethod
              ? "This gateway build does not serve invoice PDF rendering."
              : !draft.invoiceId
                ? "Save the invoice first — the PDF is rendered from the stored record."
                : "Produce the branded PDF through the reports system."
          }
          ?disabled=${draft.rendering || !renderMethod || !draft.invoiceId}
          @click=${() => void renderInvoiceDocument(host, client)}
        >${draft.rendering ? "Rendering…" : "Render PDF"}</button>
      </header>
      ${
        // The download only exists once the invoice is stored, because the PDF
        // is rendered from the stored record. Before that the operator is told
        // why rather than shown a button that cannot work.
        draft.invoiceId
          ? renderInvoiceDownload(
              host,
              client,
              {
                id: draft.invoiceId,
                number: draft.number.trim() || "invoice",
                clientName,
              },
              "aoi",
            )
          : html`<p class="aoi-note">
              Save the invoice to download it — the PDF is produced from the stored record.
            </p>`
      }
      ${
        draft.previewWarnings.length
          ? html`<div class="aoi-banner warning" role="alert">
              <strong
                >${draft.previewWarnings.length} document
                warning${draft.previewWarnings.length === 1 ? "" : "s"}</strong
              >
              <ul>
                ${draft.previewWarnings.map((warning) => html`<li>${warning}</li>`)}
              </ul>
            </div>`
          : nothing
      }
      ${
        draft.previewError
          ? html`<div class="aoi-banner danger" role="alert">
              <strong>The document renderer failed.</strong> ${draft.previewError} The preview below
              is the local approximation, not the PDF.
            </div>`
          : nothing
      }
      ${
        draft.renderError
          ? html`<div class="aoi-banner danger" role="alert">${draft.renderError}</div>`
          : nothing
      }
      ${
        draft.renderNotice
          ? html`<div class="aoi-banner success" role="status">${draft.renderNotice}</div>`
          : nothing
      }
      ${
        draft.previewSummary
          ? html`<p class="aoi-note">${draft.previewSummary}</p>`
          : nothing
      }
      <div class="aoi-doc-shell">
        ${
          draft.previewHtml
            ? html`<iframe
                class="aoi-doc"
                title="Rendered invoice document"
                sandbox=""
                srcdoc=${draft.previewHtml}
              ></iframe>`
            : html`<p class="aoi-note">
                The preview has not been generated yet. Choose a client and add a line item.
              </p>`
        }
      </div>
    </aside>
  `;
}

/** The full-screen invoice editor. Returns nothing when it is closed. */
export function renderInvoiceComposer(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  const draft = state.invoicing;
  if (!draft?.composerOpen) return nothing;
  const totals = computeInvoiceTotals(draft.lines, draft.taxPercent);
  const problems = invoiceDraftProblems(draft, totals);
  const native = hasNativeInvoiceAuthoring(client);
  const backdated = isBackdated(draft.issueDate);

  return html`
    <div
      class="aoi-overlay ba-glass"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-label="Invoice composer"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") closeInvoiceComposer(host);
      }}
    >
      <div class="aoi-modal">
        <header class="aoi-modal-head">
          <div>
            <span class="aoi-eyebrow">${backdated ? "Backlog entry" : "New invoice"}</span>
            <h2>${draft.number.trim() || "Untitled invoice"}</h2>
            <p>
              ${
                native
                  ? "Written through the gateway's invoice authoring RPCs."
                  : "This gateway build does not advertise invoice authoring yet, so the invoice is written through the structured-ingest path. It produces the same stored record, line items and revenue entries."
              }
            </p>
          </div>
          <button
            class="aoi-icon"
            aria-label="Close the invoice composer"
            @click=${() => closeInvoiceComposer(host)}
          >✕</button>
        </header>

        <div class="aoi-body">
          <section class="aoi-editor">
            <div class="aoi-grid two">
              <label class="aoi-field">
                <span>Invoice number</span>
                <input
                  type="text"
                  aria-label="Invoice number"
                  .value=${draft.number}
                  @input=${(event: Event) => {
                    patchInvoiceDraft(host, { number: inputValue(event) });
                    scheduleInvoicePreview(host, client);
                  }}
                />
              </label>
              <label class="aoi-field">
                <span>Currency</span>
                <select
                  aria-label="Invoice currency"
                  @change=${(event: Event) => {
                    patchInvoiceDraft(host, { currency: inputValue(event) });
                    scheduleInvoicePreview(host, client);
                  }}
                >
                  ${INVOICE_CURRENCIES.map(
                    (code) => html`<option value=${code} ?selected=${draft.currency === code}>
                      ${code}
                    </option>`,
                  )}
                </select>
              </label>
            </div>

            ${clientPicker(host, state, client, draft)}

            <label class="aoi-field">
              <span>Project (optional)</span>
              <select
                aria-label="Project this invoice is attributed to"
                @change=${(event: Event) => {
                  patchInvoiceDraft(host, { projectId: inputValue(event) });
                  scheduleInvoicePreview(host, client);
                }}
              >
                <option value="" ?selected=${!draft.projectId}>No project attribution</option>
                ${state.projects
                  .filter((project) => !draft.clientId || project.clientId === draft.clientId)
                  .map(
                    (project) => html`<option
                      value=${project.id}
                      ?selected=${draft.projectId === project.id}
                    >${project.name} · ${project.status.replace("_", " ")}</option>`,
                  )}
              </select>
            </label>

            ${paymentOptionPicker(host, client, draft)}

            ${dateBlock(host, client, draft)}

            <h3 class="aoi-section-title">Line items</h3>
            ${lineEditor(host, client, draft, totals)}

            <div class="aoi-grid two">
              <label class="aoi-field">
                <span>Tax rate (%)</span>
                <input
                  type="text"
                  inputmode="decimal"
                  class=${totals.taxValid ? "" : "invalid"}
                  aria-label="Tax rate as a percentage of the subtotal"
                  aria-invalid=${totals.taxValid ? "false" : "true"}
                  .value=${draft.taxPercent}
                  @input=${(event: Event) => {
                    patchInvoiceDraft(host, { taxPercent: inputValue(event) });
                    scheduleInvoicePreview(host, client);
                  }}
                />
              </label>
              <label class="aoi-field">
                <span>Tax label</span>
                <input
                  type="text"
                  placeholder="VAT, Sales tax, GST…"
                  aria-label="Label printed beside the tax row"
                  .value=${draft.taxLabel}
                  @input=${(event: Event) => {
                    patchInvoiceDraft(host, { taxLabel: inputValue(event) });
                    scheduleInvoicePreview(host, client);
                  }}
                />
              </label>
            </div>

            ${totalsBlock(draft, totals)}

            <label class="aoi-field">
              <span>Reference (optional)</span>
              <input
                type="text"
                placeholder="Purchase order or client reference"
                aria-label="Purchase order or external reference"
                .value=${draft.reference}
                @input=${(event: Event) => {
                  patchInvoiceDraft(host, { reference: inputValue(event) });
                  scheduleInvoicePreview(host, client);
                }}
              />
            </label>
            <label class="aoi-field">
              <span>Payment terms</span>
              <textarea
                rows="2"
                aria-label="Payment terms printed above the document footer"
                .value=${draft.terms}
                @input=${(event: Event) => {
                  patchInvoiceDraft(host, { terms: inputValue(event) });
                  scheduleInvoicePreview(host, client);
                }}
              ></textarea>
            </label>
            <label class="aoi-field">
              <span>Notes</span>
              <textarea
                rows="2"
                aria-label="Notes printed on the invoice"
                .value=${draft.notes}
                @input=${(event: Event) => {
                  patchInvoiceDraft(host, { notes: inputValue(event) });
                  scheduleInvoicePreview(host, client);
                }}
              ></textarea>
            </label>
          </section>

          ${previewPane(host, client, state, draft)}
        </div>

        <footer class="aoi-modal-foot">
          <div class="aoi-foot-status">
            ${
              draft.error
                ? html`<span class="aoi-pill danger" role="alert">${draft.error}</span>`
                : draft.savedNotice
                  ? html`<span class="aoi-pill success" role="status">${draft.savedNotice}</span>`
                  : problems.length
                    ? html`<span class="aoi-pill warning">${problems[0]}</span>`
                    : html`<span class="aoi-pill success"
                        >Ready · ${moneyCents(totals.totalCents, draft.currency)} across
                        ${totals.billableLines} line${totals.billableLines === 1 ? "" : "s"}</span
                      >`
            }
          </div>
          <div class="aoi-foot-actions">
            <button class="aoi-btn ghost" @click=${() => closeInvoiceComposer(host)}>Cancel</button>
            <button
              class="aoi-btn"
              aria-label="Save this invoice as a draft without issuing it"
              ?disabled=${draft.saving || problems.length > 0}
              @click=${() => void saveInvoiceDraft(host, client, { issue: false })}
            >${draft.saving ? "Saving…" : "Save draft"}</button>
            <button
              class="aoi-btn primary"
              aria-label=${
                backdated
                  ? "Record this historical invoice as issued"
                  : "Issue this invoice"
              }
              ?disabled=${draft.saving || problems.length > 0}
              @click=${() => void saveInvoiceDraft(host, client, { issue: true })}
            >${draft.saving ? "Saving…" : backdated ? "Record as issued" : "Issue invoice"}</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * Per-client revenue
 * ------------------------------------------------------------------ */

function invoiceStatusTone(invoice: AgencyInvoice): string {
  if (invoice.status === "paid") return "success";
  if (invoice.status === "void") return "neutral";
  if (isOverdue(invoice)) return "danger";
  if (invoice.status === "draft") return "neutral";
  return "info";
}

/** One client's invoices and income. Returns nothing when it is closed. */
export function renderClientRevenuePanel(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  const draft = state.invoicing;
  if (!draft?.clientDetailId) return nothing;
  const detail = draft.clientDetail;
  const record = state.clients.find((entry) => entry.id === draft.clientDetailId);
  const name = detail?.clientName ?? record?.name ?? "Client";
  const currency = detail?.currency ?? "USD";
  const clientKey = `client:${draft.clientDetailId}`;
  const clientProjects = state.projects.filter(
    (project) => project.clientId === draft.clientDetailId,
  );

  return html`
    <div
      class="aoi-overlay ba-glass"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-label=${`Revenue history for ${name}`}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") closeClientRevenue(host);
      }}
    >
      <div class="aoi-modal narrow">
        <header class="aoi-modal-head">
          <div>
            <span class="aoi-eyebrow">Client revenue</span>
            <h2>${name}</h2>
            <p>Every invoice raised against this client, and what has actually been collected.</p>
            <p class="aoi-note" role="note">Included automatically in Business Hub → Revenue, with invoice status, project attribution, and accounts-receivable aging.</p>
          </div>
          <div class="aoi-head-actions">
            <button
              class="aoi-btn primary"
              aria-label=${`Create an invoice for ${name}`}
              @click=${() => launchComposer(host, client, { clientId: draft.clientDetailId! })}
            >+ Invoice</button>
            <button
              class="aoi-icon"
              aria-label="Close the client revenue panel"
              @click=${() => closeClientRevenue(host)}
            >✕</button>
          </div>
        </header>

        <div class="aoi-body single">
          ${
            draft.clientDetailError
              ? html`<div class="aoi-banner warning" role="alert">
                  <strong>agency.ops.relations.client failed.</strong>
                  ${draft.clientDetailError} The invoices below come from the register already
                  loaded on this page, so they may be incomplete.
                </div>`
              : nothing
          }
          <section class="aoi-mrr">
            <div class="aoi-mrr-head">
              <span class="aoi-eyebrow">Recurring revenue</span>
              <p>Set monthly recurring revenue directly. ARR is derived as MRR × 12.</p>
            </div>
            <div class="aoi-mrr-row">
              <label>Client MRR</label>
              <div class="aoi-mrr-input">
                <span class="aoi-mrr-currency">${currency}</span>
                <input
                  type="text"
                  inputmode="decimal"
                  aria-label=${`Monthly recurring revenue for ${name}`}
                  .value=${mrrDraftValue(host, clientKey, record?.mrrCents ?? 0)}
                  @input=${(event: Event) =>
                    setMrrDraft(host, clientKey, (event.target as HTMLInputElement).value)}
                />
                <button
                  class="aoi-btn primary"
                  ?disabled=${draft.mrrSavingId === clientKey}
                  aria-label=${`Save monthly recurring revenue for ${name}`}
                  @click=${() => void saveClientMrr(host, client, draft.clientDetailId!)}
                >${draft.mrrSavingId === clientKey ? "Saving…" : "Save"}</button>
              </div>
              <small>${moneyCents((record?.mrrCents ?? 0) * 12, currency)} ARR</small>
            </div>
            ${
              clientProjects.length === 0
                ? html`<p class="aoi-note">This client has no projects to attribute MRR to yet.</p>`
                : html`<div class="aoi-mrr-projects">
                    <span class="aoi-mrr-sub">Per project</span>
                    ${clientProjects.map((project) => {
                      const key = `project:${project.id}`;
                      return html`<div class="aoi-mrr-row">
                        <label title=${project.name}>${project.name}</label>
                        <div class="aoi-mrr-input">
                          <span class="aoi-mrr-currency">${currency}</span>
                          <input
                            type="text"
                            inputmode="decimal"
                            aria-label=${`Monthly recurring revenue for project ${project.name}`}
                            .value=${mrrDraftValue(host, key, project.mrrCents ?? 0)}
                            @input=${(event: Event) =>
                              setMrrDraft(host, key, (event.target as HTMLInputElement).value)}
                          />
                          <button
                            class="aoi-btn"
                            ?disabled=${draft.mrrSavingId === key}
                            aria-label=${`Save monthly recurring revenue for project ${project.name}`}
                            @click=${() => void saveProjectMrr(host, client, project.id)}
                          >${draft.mrrSavingId === key ? "Saving…" : "Save"}</button>
                        </div>
                        <small>${moneyCents((project.mrrCents ?? 0) * 12, currency)} ARR</small>
                      </div>`;
                    })}
                  </div>`
            }
          </section>
          ${
            draft.clientDetailLoading && !detail
              ? html`<p class="aoi-note">Loading this client's invoice history…</p>`
              : !detail
                ? html`<p class="aoi-note">
                    No revenue data was returned for this client and no error was reported. That is
                    unexpected — refresh the page and check the failed-request banner.
                  </p>`
                : html`
                    <div class="aoi-stats">
                      <article>
                        <span>Invoiced</span><strong>${moneyCents(detail.invoicedCents, currency)}</strong>
                        <small>${detail.invoices.length} invoices</small>
                      </article>
                      <article>
                        <span>Collected</span
                        ><strong class="ok">${moneyCents(detail.collectedCents, currency)}</strong>
                        <small>${detail.paidCount} paid in full</small>
                      </article>
                      <article>
                        <span>Outstanding</span
                        ><strong class=${detail.outstandingCents > 0 ? "warn" : ""}
                          >${moneyCents(detail.outstandingCents, currency)}</strong
                        >
                        <small>${detail.openCount} open</small>
                      </article>
                      <article>
                        <span>Overdue</span
                        ><strong class=${detail.overdueCents > 0 ? "bad" : ""}
                          >${moneyCents(detail.overdueCents, currency)}</strong
                        >
                        <small>${detail.overdueCount} past due</small>
                      </article>
                    </div>
                    ${
                      detail.invoices.length === 0
                        ? html`<p class="aoi-note">
                            This client has no invoices yet. Use <b>+ Invoice</b> above to raise the
                            first one, or backdate the invoices they were already sent.
                          </p>`
                        : html`<div class="aoi-invoice-list">
                            ${detail.invoices.map(
                              (invoice) => html`
                                <article class="aoi-invoice">
                                  <div class="aoi-invoice-head">
                                    <div class="aoi-invoice-id">
                                      <strong>${invoice.number}</strong>
                                      <small
                                        >${
                                          invoice.issuedAt
                                            ? new Date(invoice.issuedAt).toLocaleDateString()
                                            : "Not issued"
                                        }${
                                          invoice.dueAt
                                            ? ` · due ${new Date(invoice.dueAt).toLocaleDateString()}`
                                            : ""
                                        }</small
                                      >
                                    </div>
                                    <span class=${`aoi-pill ${invoiceStatusTone(invoice)}`}
                                      >${isOverdue(invoice) ? "overdue" : invoice.status.replace("_", " ")}</span
                                    >
                                  </div>
                                  <div class="aoi-invoice-money">
                                    <span
                                      ><small>Total</small
                                      >${moneyCents(invoice.totalCents, invoice.currency)}</span
                                    >
                                    <span
                                      ><small>Paid</small
                                      >${moneyCents(invoice.amountPaidCents, invoice.currency)}</span
                                    >
                                    <span
                                      ><small>Balance</small
                                      >${moneyCents(invoice.balanceCents, invoice.currency)}</span
                                    >
                                  </div>
                                  ${renderInvoiceDownload(
                                    host,
                                    client,
                                    {
                                      id: invoice.id,
                                      number: invoice.number,
                                      clientName: invoice.clientName || name,
                                      updatedAt: invoice.updatedAt,
                                    },
                                    "aoi",
                                  )}
                                  ${renderInvoicePaymentLink(
                                    host,
                                    client,
                                    {
                                      id: invoice.id,
                                      number: invoice.number,
                                      clientName: invoice.clientName || name,
                                      updatedAt: invoice.updatedAt,
                                    },
                                    "aoi",
                                  )}
                                  ${renderInvoicePaymentControls(host, state, client, invoice)}
                                  ${
                                    invoice.status === "draft" && invoiceMethod(client, "voidInvoice")
                                      ? html`<button
                                          class="aoi-link"
                                          aria-label=${`Void invoice ${invoice.number}`}
                                          @click=${() => void voidInvoice(host, client, invoice.id)}
                                        >Void</button>`
                                      : nothing
                                  }
                                </article>
                              `,
                            )}
                          </div>`
                    }
                  `
          }
        </div>
      </div>
    </div>
  `;
}

/**
 * Styles for the surfaces above.
 *
 * Everything is expressed through the glass design tokens — radii from
 * --g-radius*, elevation from --g-shadow*, frost from --g-blur, and status
 * colour from the semantic --g-success / --g-warning / --g-danger / --g-info /
 * --g-neutral families. The fallbacks in var() are the design system's own
 * documented defaults, not a second palette.
 */
export const invoicingStyles = html`
  <style>
    .aoi-overlay {
      position: fixed;
      inset: 0;
      /* Above the app shell's sticky topbar (99999). A modal the chrome can
         cover is a modal whose close button cannot be clicked. */
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
      background: color-mix(in srgb, var(--g-bg, #09090b) 88%, transparent);
      backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(180%));
    }
    .aoi-modal {
      display: flex;
      flex-direction: column;
      width: min(1360px, 100%);
      max-height: 100%;
      min-width: 0;
      border: 1px solid var(--g-border-strong, rgba(255, 255, 255, 0.18));
      border-radius: var(--g-radius-lg, 18px);
      /* Opaque plate. The glass tokens are translucent by design, and a
         translucent editor over a dense operations page is unreadable — the
         frost lives on the overlay behind it instead. */
      background: color-mix(in srgb, var(--g-bg, #09090b) 92%, var(--g-primary, #8b5cf6) 8%);
      box-shadow: var(--g-shadow-lg, 0 24px 60px rgba(0, 0, 0, 0.45));
      overflow: hidden;
    }
    .aoi-modal.narrow {
      width: min(900px, 100%);
    }
    .aoi-modal-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 22px;
      border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aoi-modal-head > div {
      min-width: 0;
    }
    .aoi-modal-head h2 {
      margin: 2px 0 4px;
      font-size: 19px;
      letter-spacing: -0.01em;
    }
    .aoi-modal-head p {
      margin: 0;
      max-width: 78ch;
      font-size: 11.5px;
      line-height: 1.5;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-head-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .aoi-eyebrow {
      font-size: 9.5px;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--g-accent, #22d3ee);
    }
    .aoi-body {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
      gap: 0;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }
    .aoi-body.single {
      grid-template-columns: minmax(0, 1fr);
      overflow-y: auto;
      padding: 18px 22px 22px;
    }
    .aoi-mrr {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 4px 0 18px;
      padding: 14px 16px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
      border-radius: var(--g-radius, 14px);
      background: color-mix(in srgb, var(--g-surface, #18181b) 60%, transparent);
    }
    .aoi-mrr-head p {
      margin: 2px 0 0;
      font-size: 11px;
      color: var(--g-text-dim, rgba(255, 255, 255, 0.6));
    }
    .aoi-mrr-sub {
      display: block;
      font-size: 9.5px;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--g-text-dim, rgba(255, 255, 255, 0.5));
      margin-bottom: 4px;
    }
    .aoi-mrr-projects {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .aoi-mrr-row {
      display: grid;
      grid-template-columns: minmax(90px, 1.1fr) minmax(0, 1.4fr) auto;
      align-items: center;
      gap: 10px;
    }
    .aoi-mrr-row > label {
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .aoi-mrr-row > small {
      font-size: 10.5px;
      color: var(--g-text-dim, rgba(255, 255, 255, 0.55));
      white-space: nowrap;
    }
    .aoi-mrr-input {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .aoi-mrr-currency {
      font-size: 10px;
      letter-spacing: 0.06em;
      color: var(--g-text-dim, rgba(255, 255, 255, 0.55));
    }
    .aoi-mrr-input input {
      flex: 1 1 auto;
      min-width: 0;
      padding: 6px 9px;
      font: inherit;
      font-size: 12px;
      color: var(--g-text, #fafafa);
      background: color-mix(in srgb, var(--g-bg, #09090b) 70%, transparent);
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: 9px;
    }
    .aoi-mrr-input input:focus-visible {
      outline: none;
      border-color: var(--g-accent, #22d3ee);
    }
    .aoi-editor {
      min-width: 0;
      overflow-y: auto;
      padding: 18px 22px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    /* The column scrolls; its children must not be squashed to fit instead.
       Without this the 40-row client picker collapsed to a single visible row. */
    .aoi-editor > * {
      flex: 0 0 auto;
    }
    .aoi-section-title {
      margin: 6px 0 -4px;
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-grid.two {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .aoi-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 0;
    }
    .aoi-field > span {
      font-size: 10.5px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-field.tight {
      max-width: 170px;
    }
    .aoi-field input,
    .aoi-field select,
    .aoi-field textarea,
    .aoi-line input,
    .aoi-line select {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      padding: 7px 9px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius-sm, 8px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      color: inherit;
      font: inherit;
      font-size: 12.5px;
    }
    .aoi-field textarea {
      resize: vertical;
      line-height: 1.5;
    }
    .aoi-field input:focus-visible,
    .aoi-field select:focus-visible,
    .aoi-field textarea:focus-visible,
    .aoi-line input:focus-visible,
    .aoi-line select:focus-visible,
    .aoi-btn:focus-visible,
    .aoi-link:focus-visible,
    .aoi-icon:focus-visible,
    .aoi-result:focus-visible {
      outline: 2px solid var(--g-primary, #8b5cf6);
      outline-offset: 2px;
    }
    .aoi-field input.invalid,
    .aoi-line input.invalid {
      border-color: var(--g-danger, #ef4444);
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.12));
    }
    .aoi-quick,
    .aoi-pay-quick {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      margin-top: 1px;
    }
    .aoi-payment-option {
      gap: 7px;
    }
    .aoi-payment-row {
      display: flex;
      gap: 8px;
      align-items: stretch;
    }
    .aoi-payment-row select {
      flex: 1 1 auto;
      min-width: 0;
    }
    .aoi-payment-row .aoi-btn {
      flex: 0 0 auto;
    }
    .aoi-payment-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 4px;
      padding: 12px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius-sm, 8px);
      background: var(--g-surface, rgba(255, 255, 255, 0.03));
    }
    .aoi-link.danger {
      color: var(--g-danger, #ef4444);
    }
    .aoi-link {
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      font-size: 10.5px;
      color: var(--g-primary, #a78bfa);
      cursor: pointer;
      text-align: left;
    }
    .aoi-link:hover {
      text-decoration: underline;
    }
    .aoi-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 13px;
      border: 1px solid var(--g-border-strong, rgba(255, 255, 255, 0.18));
      border-radius: var(--g-radius-sm, 8px);
      background: var(--g-surface, rgba(255, 255, 255, 0.05));
      color: inherit;
      font: inherit;
      font-size: 12px;
      font-weight: 550;
      cursor: pointer;
      white-space: nowrap;
    }
    .aoi-btn:hover:not(:disabled) {
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.1));
    }
    .aoi-btn.primary {
      border-color: var(--g-primary-strong, #7c3aed);
      background: var(--g-primary, #8b5cf6);
      color: var(--g-on-primary, #fff);
    }
    .aoi-btn.ghost {
      border-color: var(--g-border, rgba(255, 255, 255, 0.12));
      background: transparent;
      align-self: flex-start;
    }
    .aoi-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .aoi-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      flex: 0 0 auto;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius-sm, 8px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      color: inherit;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
    }
    .aoi-icon:hover:not(:disabled) {
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.1));
    }
    .aoi-icon.danger:hover:not(:disabled) {
      border-color: var(--g-danger-border, rgba(239, 68, 68, 0.5));
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.14));
    }
    .aoi-icon:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .aoi-chosen {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 9px 12px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aoi-chosen-main {
      flex: 1 1 auto;
      min-width: 0;
    }
    .aoi-chosen-main strong,
    .aoi-chosen-main small {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aoi-chosen-main small {
      color: var(--g-fg-dim, #a1a1aa);
      font-size: 11px;
    }
    .aoi-results {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 220px;
      overflow-y: auto;
      padding: 4px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.03));
    }
    .aoi-result {
      display: flex;
      flex-direction: column;
      gap: 1px;
      width: 100%;
      min-width: 0;
      padding: 6px 9px;
      border: 0;
      border-radius: var(--g-radius-sm, 8px);
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .aoi-result:hover {
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.08));
    }
    .aoi-result-name {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12.5px;
      font-weight: 550;
    }
    .aoi-result-meta {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10.5px;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-note {
      margin: 6px 2px;
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-lines {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .aoi-line {
      display: grid;
      grid-template-columns: minmax(0, 2.6fr) 62px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.9fr) 92px;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .aoi-line.head {
      font-size: 9.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
      padding-bottom: 2px;
      border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
    }
    .aoi-line .num,
    .aoi-line.head .num {
      text-align: right;
    }
    .aoi-line-total {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .aoi-line-total em {
      color: var(--g-fg-faint, #71717a);
      font-style: normal;
    }
    .aoi-line-tools {
      display: flex;
      gap: 3px;
      justify-content: flex-end;
    }
    .aoi-totals {
      align-self: flex-end;
      width: min(320px, 100%);
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 11px 13px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aoi-totals div {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-totals b {
      color: var(--g-fg, inherit);
      font-variant-numeric: tabular-nums;
    }
    .aoi-totals .grand {
      margin-top: 4px;
      padding-top: 7px;
      border-top: 1px solid var(--g-border-strong, rgba(255, 255, 255, 0.18));
      font-size: 14px;
    }
    .aoi-totals .grand b {
      font-size: 17px;
      font-weight: 700;
      color: var(--g-primary, #a78bfa);
    }
    .aoi-totals .recurring b {
      color: var(--g-accent, #22d3ee);
    }
    .aoi-preview {
      display: flex;
      flex-direction: column;
      gap: 9px;
      min-width: 0;
      padding: 18px 22px 22px;
      overflow-y: auto;
      border-left: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      background: var(--g-surface, rgba(255, 255, 255, 0.02));
    }
    .aoi-preview-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .aoi-preview-title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .aoi-doc-shell {
      flex: 1 1 auto;
      min-height: 420px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      overflow: hidden;
      background: var(--g-bg, #09090b);
    }
    .aoi-doc {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 420px;
      border: 0;
    }
    .aoi-pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 9px;
      border-radius: 999px;
      border: 1px solid var(--g-neutral-border, rgba(148, 163, 184, 0.4));
      background: var(--g-neutral-soft, rgba(148, 163, 184, 0.14));
      color: var(--g-neutral, #94a3b8);
      font-size: 10.5px;
      font-weight: 550;
      white-space: nowrap;
    }
    .aoi-pill.success {
      border-color: var(--g-success-border, rgba(34, 197, 94, 0.42));
      background: var(--g-success-soft, rgba(34, 197, 94, 0.14));
      color: var(--g-success, #22c55e);
    }
    .aoi-pill.warning {
      border-color: var(--g-warning-border, rgba(245, 158, 11, 0.42));
      background: var(--g-warning-soft, rgba(245, 158, 11, 0.14));
      color: var(--g-warning, #f59e0b);
    }
    .aoi-pill.danger {
      border-color: var(--g-danger-border, rgba(239, 68, 68, 0.42));
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.14));
      color: var(--g-danger, #ef4444);
    }
    .aoi-pill.info {
      border-color: var(--g-info-border, rgba(56, 189, 248, 0.42));
      background: var(--g-info-soft, rgba(56, 189, 248, 0.14));
      color: var(--g-info, #38bdf8);
    }
    .aoi-banner {
      padding: 9px 12px;
      border-radius: var(--g-radius, 12px);
      border: 1px solid var(--g-info-border, rgba(56, 189, 248, 0.4));
      background: var(--g-info-soft, rgba(56, 189, 248, 0.1));
      font-size: 11.5px;
      line-height: 1.55;
    }
    .aoi-banner ul {
      margin: 5px 0 0;
      padding-left: 18px;
    }
    .aoi-banner.warning {
      border-color: var(--g-warning-border, rgba(245, 158, 11, 0.4));
      background: var(--g-warning-soft, rgba(245, 158, 11, 0.1));
    }
    .aoi-banner.danger {
      border-color: var(--g-danger-border, rgba(239, 68, 68, 0.4));
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.1));
    }
    .aoi-banner.success {
      border-color: var(--g-success-border, rgba(34, 197, 94, 0.4));
      background: var(--g-success-soft, rgba(34, 197, 94, 0.1));
    }
    .aoi-modal-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 13px 22px;
      border-top: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aoi-foot-status {
      min-width: 0;
      flex: 1 1 auto;
    }
    .aoi-foot-actions {
      display: flex;
      gap: 8px;
      flex: 0 0 auto;
    }
    .aoi-pay {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 9px;
      margin-top: 10px;
    }
    .aoi-dl {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 10px;
      min-width: 0;
      margin-top: 10px;
    }
    .aoi-dl .aoi-note {
      flex: 1 1 220px;
      min-width: 0;
      margin: 0;
    }
    .aoi-dl .aoi-note.is-bad {
      color: var(--g-danger, #ef4444);
    }
    .aoi-dl button[aria-busy="true"] {
      opacity: 0.75;
    }
    .aoi-cred {
      /* The header is a wrapping flex row; claim a whole line there so the
         panel never gets squeezed between the action buttons. */
      flex: 1 1 100%;
      margin-top: 10px;
      padding: 11px 12px;
      border: 1px solid var(--g-border);
      border-radius: var(--g-radius-sm, 10px);
      background: var(--g-surface);
      backdrop-filter: blur(var(--g-blur, 12px));
      display: flex;
      flex-direction: column;
      gap: 9px;
      min-width: 0;
    }
    .aoi-cred-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    .aoi-cred-why {
      margin: 0;
      font-size: 11px;
      line-height: 1.45;
      opacity: 0.72;
    }
    .aoi-cred-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      min-width: 0;
    }
    .aoi-cred-field em {
      font-style: normal;
      opacity: 0.7;
    }
    .aoi-cred-field input {
      width: 100%;
      min-width: 0;
      padding: 7px 9px;
      border-radius: var(--g-radius-sm, 8px);
      border: 1px solid var(--g-border);
      background: color-mix(in srgb, #000 22%, transparent);
      color: inherit;
      font: inherit;
    }
    .aoi-cred-field input:focus-visible {
      outline: 2px solid var(--g-primary);
      outline-offset: 1px;
    }
    .aoi-cred-field small {
      opacity: 0.6;
    }
    .aoi-cred-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      min-width: 0;
    }
    .aoi-pay-quick {
      flex-direction: column;
      gap: 2px;
      padding-bottom: 5px;
    }
    .aoi-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .aoi-stats article {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      padding: 11px 13px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aoi-stats span {
      font-size: 10px;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-stats strong {
      font-size: 18px;
      font-variant-numeric: tabular-nums;
    }
    .aoi-stats strong.ok {
      color: var(--g-success, #22c55e);
    }
    .aoi-stats strong.warn {
      color: var(--g-warning, #f59e0b);
    }
    .aoi-stats strong.bad {
      color: var(--g-danger, #ef4444);
    }
    .aoi-stats small {
      font-size: 10.5px;
      color: var(--g-fg-faint, #71717a);
    }
    .aoi-invoice-list {
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .aoi-invoice {
      min-width: 0;
      padding: 11px 13px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .aoi-invoice-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .aoi-invoice-id {
      min-width: 0;
    }
    .aoi-invoice-id strong,
    .aoi-invoice-id small {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .aoi-invoice-id small {
      font-size: 10.5px;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .aoi-invoice-money {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      margin-top: 8px;
    }
    .aoi-invoice-money span {
      display: flex;
      flex-direction: column;
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .aoi-invoice-money small {
      font-size: 9.5px;
      font-weight: 400;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
    }
    @media (max-width: 1180px) {
      .aoi-body {
        grid-template-columns: minmax(0, 1fr);
        overflow-y: auto;
      }
      .aoi-editor,
      .aoi-preview {
        overflow: visible;
      }
      .aoi-preview {
        border-left: 0;
        border-top: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      }
      .aoi-line {
        grid-template-columns: minmax(0, 1fr) 58px minmax(0, 1fr);
        grid-template-areas:
          "desc desc desc"
          "qty price cadence"
          "total total tools";
        row-gap: 4px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
      }
      .aoi-line.head {
        display: none;
      }
      .aoi-line > :nth-child(1) {
        grid-area: desc;
      }
      .aoi-line > :nth-child(2) {
        grid-area: qty;
      }
      .aoi-line > :nth-child(3) {
        grid-area: price;
      }
      .aoi-line > :nth-child(4) {
        grid-area: cadence;
      }
      .aoi-line > :nth-child(5) {
        grid-area: total;
        text-align: left;
      }
      .aoi-line > :nth-child(6) {
        grid-area: tools;
      }
    }
    @media (max-width: 720px) {
      .aoi-overlay {
        padding: 0;
      }
      .aoi-modal {
        border-radius: 0;
        border: 0;
      }
      .aoi-grid.two {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  </style>
`;
