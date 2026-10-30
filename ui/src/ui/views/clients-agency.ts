/**
 * "Invoicing & agency" — the agency operating system inside the CRM record.
 *
 * The owner works in `/clients` all day; every invoice, payment, project and
 * real pipeline status lived one route away in Agency Operations. This tab
 * brings them onto the record without forking any of it: the composer, the
 * integer-cent arithmetic, the payment controls and the revenue rollup are the
 * modules from `views/agency-invoicing.ts` and
 * `controllers/agency-invoicing.ts`, driven here against the same agency state.
 *
 * Nothing on this tab renders as an ambiguous blank. A client whose agency
 * counterpart could not be found says so and offers to create one; a gateway
 * that does not serve the agency RPCs is named; a failed call is listed by
 * method. Zeros only ever mean "this client genuinely has no invoices".
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { ClientsState } from "../controllers/clients";
import {
  ensureAgencyOperationsState,
  type AgencyProjectSummary,
  type AgencyTaskSummary,
} from "../controllers/agency-operations";
import {
  invoiceMethod,
  isOverdue,
  loadClientRevenue,
  moneyCents,
  voidInvoice,
} from "../controllers/agency-invoicing";
import {
  closePaymentCredentials,
  openPaymentCredentials,
  paymentCredentialsState,
  supportsPaymentCredentials,
} from "../controllers/payment-credentials";
import {
  launchInvoiceComposer,
  renderInvoiceDownload,
  renderInvoicePaymentLink,
  renderPaymentCredentialsEditor,
  renderInvoicePaymentControls,
} from "./agency-invoicing";
import {
  AGENCY_CLIENTS_METHOD,
  agencyClientRecord,
  agencyProjectsForClient,
  agencyTasksForProjects,
  createAgencyCounterpart,
  loadClientAgencyLink,
} from "../controllers/clients-agency";

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

/** Tone class for a real pipeline status label. */
function pipelineTone(status: string): string {
  const key = status.trim().toLowerCase();
  if (key === "in progress" || key === "updating" || key === "active" || key === "won") return "ok";
  if (key === "lead") return "info";
  if (key === "completed" || key === "archived") return "done";
  if (key === "lost" || key === "cancelled") return "bad";
  return "cold";
}

function taskTone(status: AgencyTaskSummary["status"]): string {
  if (status === "done") return "ok";
  if (status === "blocked") return "bad";
  if (status === "in_progress" || status === "review") return "info";
  return "cold";
}

function projectTone(status: AgencyProjectSummary["status"]): string {
  if (status === "active") return "ok";
  if (status === "completed") return "done";
  if (status === "cancelled") return "bad";
  if (status === "on_hold") return "warn";
  return "cold";
}

/**
 * `partially_paid` to `Partially paid`.
 *
 * Sentence case, not `text-transform: capitalize` — the real pipeline labels
 * are already sentence case ("In progress") and CSS capitalize would title-case
 * them into something the owner never typed.
 */
function humanize(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function banner(kind: "info" | "warn" | "bad", body: TemplateResult): TemplateResult {
  return html`<div class=${`crm-ag-banner is-${kind}`} role=${kind === "info" ? "note" : "alert"}>
    ${body}
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Tab body
 * ------------------------------------------------------------------ */

export function renderDetailAgency(
  state: AppViewState,
  cs: ClientsState,
  client: GatewayBrowserClient,
  legacyName: string,
): TemplateResult | typeof nothing {
  const record = cs.detailClient;
  if (!record) return nothing;
  const link = cs.agencyLink;
  const aops = ensureAgencyOperationsState(state);

  if (!link || link.phase === "idle" || (link.phase === "loading" && !link.agencyClientId)) {
    return html`
      <div class="crm-ag">
        <p class="crm-ag-note">
          ${link?.phase === "loading"
            ? "Matching this client against the agency ledger…"
            : "Opening the agency ledger for this client…"}
        </p>
      </div>
    `;
  }

  if (link.phase === "unsupported") {
    return html`
      <div class="crm-ag">
        ${banner(
          "warn",
          html`<strong>This gateway build does not serve the agency operating system.</strong>
            ${AGENCY_CLIENTS_METHOD} is not advertised in the connection handshake, so invoices,
            revenue and pipeline status cannot be read for this client. Everything else on this
            record is unaffected.`,
        )}
      </div>
    `;
  }

  if (link.phase === "error") {
    return html`
      <div class="crm-ag">
        ${banner(
          "bad",
          html`<strong>The agency ledger could not be opened.</strong> ${link.error ?? "Unknown error."}`,
        )}
        ${renderFailedCalls(link.failedCalls)}
        <button
          class="crm-ag-btn"
          aria-label="Try opening the agency ledger for this client again"
          @click=${() => void loadClientAgencyLink(state, client, legacyName, { force: true })}
        >Try again</button>
      </div>
    `;
  }

  const agencyClient = agencyClientRecord(aops, link);
  if (!agencyClient) {
    return html`
      <div class="crm-ag">
        ${renderFailedCalls(link.failedCalls)}
        <section class="crm-ag-card is-empty">
          <h3>No agency record for ${legacyName || "this client"}</h3>
          <p>
            This CRM record has no counterpart in the agency ledger, so it cannot be invoiced and has
            no revenue, projects or pipeline status. This is a real gap, not a loading failure — the
            ledger was read successfully and contains ${aops.clients.length} clients, none of them
            matching this record by mapping id or by name.
          </p>
          ${link.createError
            ? banner("bad", html`<strong>Creating the agency record failed.</strong> ${link.createError}`)
            : nothing}
          ${link.createNotice
            ? banner("info", html`${link.createNotice}`)
            : nothing}
          <div class="crm-ag-actions">
            <button
              class="crm-ag-btn is-primary"
              aria-label=${`Create an agency record for ${legacyName}`}
              ?disabled=${link.creating || !link.agencyId}
              @click=${() => void createAgencyCounterpart(state, client, legacyName)}
            >${link.creating ? "Creating…" : "Create agency record"}</button>
            <button
              class="crm-ag-btn"
              aria-label="Re-check the agency ledger for this client"
              @click=${() => void loadClientAgencyLink(state, client, legacyName, { force: true })}
            >Re-check</button>
          </div>
          <p class="crm-ag-note">
            The new record carries this client's name and billing email, is filed as a
            <b>Lead</b>, and becomes billable immediately.
          </p>
        </section>
      </div>
    `;
  }

  const detail = aops.invoicing?.clientDetail ?? null;
  const detailLoading = aops.invoicing?.clientDetailLoading ?? false;
  const detailError = aops.invoicing?.clientDetailError ?? null;
  const currency = detail?.currency ?? aops.revenue?.currency ?? aops.finance.currency ?? "USD";
  const projects = agencyProjectsForClient(aops, agencyClient.id);
  const tasks = agencyTasksForProjects(aops, projects);
  const statusLabel = agencyClient.pipelineStatusLabel ?? null;

  return html`
    <div class="crm-ag">
      ${renderFailedCalls(link.failedCalls)}

      <section class="crm-ag-head">
        <div class="crm-ag-head-main">
          <span class="crm-ag-eyebrow">Agency ledger</span>
          <h3>${agencyClient.name}</h3>
          <div class="crm-ag-chips">
            ${statusLabel
              ? html`<span class=${`crm-ag-chip is-${pipelineTone(statusLabel)}`}
                  >${statusLabel}</span
                >`
              : html`<span class="crm-ag-chip is-cold" title="This gateway build does not return the real pipeline status."
                  >${humanize(agencyClient.status)} (rollup only)</span
                >`}
            ${link.matchedBy === "record-link"
              ? html`<span class="crm-ag-chip is-quiet">Linked record</span>`
              : html`<span class="crm-ag-chip is-warn"
                  >Matched by name${link.nameCandidates > 1 ? ` · ${link.nameCandidates} candidates` : ""}</span
                >`}
          </div>
        </div>
        <div class="crm-ag-actions">
          <button
            class="crm-ag-btn is-primary"
            aria-label=${`Create a new invoice for ${agencyClient.name}`}
            @click=${() => launchInvoiceComposer(state, client, { clientId: agencyClient.id })}
          >+ New invoice</button>
          <button
            class="crm-ag-btn"
            aria-label=${`Record a past invoice that was already issued to ${agencyClient.name}`}
            @click=${() =>
              launchInvoiceComposer(state, client, { clientId: agencyClient.id, backdated: true })}
          >Backlog past invoice</button>
          <button
            class="crm-ag-btn"
            aria-label="Reload this client's agency ledger"
            ?disabled=${detailLoading}
            @click=${() => void loadClientRevenue(state, client, agencyClient.id)}
          >${detailLoading ? "Refreshing…" : "Refresh"}</button>
          ${
            // Same persistent entry point the agency register has, so a wrong
            // Whop company id can be corrected from the client modal too.
            supportsPaymentCredentials(client)
              ? html`<button
                  class="crm-ag-btn"
                  aria-label="Edit the Whop API key and company id used for payment links"
                  title="The Whop API key and company id this machine uses to create checkout links."
                  @click=${() =>
                    paymentCredentialsState().open
                      ? closePaymentCredentials(state)
                      : openPaymentCredentials(state, client, aops.selectedAgencyId, "__header__")}
                >Payment keys</button>`
              : nothing
          }
        </div>
        ${renderPaymentCredentialsEditor(state, client, "crm", aops.selectedAgencyId, "__header__")}
      </section>

      ${link.matchedBy === "name" && link.nameCandidates > 1
        ? banner(
            "warn",
            html`<strong>${link.nameCandidates} agency clients share this name.</strong> The one with
              the most billing activity is shown. Invoices raised here are filed against
              <b>${agencyClient.id}</b>.`,
          )
        : nothing}

      ${detailError
        ? banner(
            "warn",
            html`<strong>agency.ops.relations.client failed.</strong> ${detailError} The invoices
              below come from the register already loaded in this browser, so they may be
              incomplete.`,
          )
        : nothing}

      ${detailLoading && !detail
        ? html`<p class="crm-ag-note">Loading this client's invoice history…</p>`
        : !detail
          ? banner(
              "bad",
              html`<strong>No revenue data was returned and no error was reported.</strong> That is
                unexpected — reload the page and check the agency failed-request banner before
                trusting any total on this record.`,
            )
          : html`
              <div class="crm-ag-stats">
                <article>
                  <span>Invoiced</span><strong>${moneyCents(detail.invoicedCents, currency)}</strong>
                  <small>${detail.invoices.length} invoice${detail.invoices.length === 1 ? "" : "s"}</small>
                </article>
                <article>
                  <span>Collected</span
                  ><strong class="is-ok">${moneyCents(detail.collectedCents, currency)}</strong>
                  <small>${detail.paidCount} paid in full</small>
                </article>
                <article>
                  <span>Outstanding</span
                  ><strong class=${detail.outstandingCents > 0 ? "is-warn" : ""}
                    >${moneyCents(detail.outstandingCents, currency)}</strong
                  >
                  <small>${detail.openCount} open</small>
                </article>
                <article>
                  <span>Overdue</span
                  ><strong class=${detail.overdueCents > 0 ? "is-bad" : ""}
                    >${moneyCents(detail.overdueCents, currency)}</strong
                  >
                  <small>${detail.overdueCount} past due</small>
                </article>
              </div>

              ${detail.invoices.length === 0
                ? html`<section class="crm-ag-card is-empty">
                    <h3>No invoices raised against this client yet</h3>
                    <p>
                      The agency ledger was read and returned nothing for
                      ${agencyClient.name} — the totals above are real zeros, not a failed load.
                      Use <b>+ New invoice</b> to raise the first one, or
                      <b>Backlog past invoice</b> to enter invoices that were already sent, dated
                      into the month they belong to.
                    </p>
                  </section>`
                : html`<div class="crm-ag-invoices">
                    ${detail.invoices.map(
                      (invoice) => html`
                        <article class="crm-ag-invoice">
                          <div class="crm-ag-invoice-head">
                            <div class="crm-ag-invoice-id">
                              <strong>${invoice.number}</strong>
                              <small
                                >${invoice.issuedAt
                                  ? new Date(invoice.issuedAt).toLocaleDateString()
                                  : "Not issued"}${invoice.dueAt
                                  ? ` · due ${new Date(invoice.dueAt).toLocaleDateString()}`
                                  : ""}</small
                              >
                            </div>
                            <span
                              class=${`crm-ag-chip is-${
                                invoice.status === "paid"
                                  ? "ok"
                                  : isOverdue(invoice)
                                    ? "bad"
                                    : invoice.status === "draft" || invoice.status === "void"
                                      ? "quiet"
                                      : "info"
                              }`}
                              >${isOverdue(invoice) ? "overdue" : humanize(invoice.status)}</span
                            >
                          </div>
                          <div class="crm-ag-invoice-money">
                            <span
                              ><small>Total</small>${moneyCents(invoice.totalCents, invoice.currency)}</span
                            >
                            <span
                              ><small>Paid</small>${moneyCents(
                                invoice.amountPaidCents,
                                invoice.currency,
                              )}</span
                            >
                            <span
                              ><small>Balance</small>${moneyCents(
                                invoice.balanceCents,
                                invoice.currency,
                              )}</span
                            >
                          </div>
                          ${renderInvoiceDownload(
                            state,
                            client,
                            {
                              id: invoice.id,
                              number: invoice.number,
                              clientName: invoice.clientName || agencyClient.name,
                            },
                            "crm",
                          )}
                          ${renderInvoicePaymentLink(
                            state,
                            client,
                            {
                              id: invoice.id,
                              number: invoice.number,
                              clientName: invoice.clientName || agencyClient.name,
                            },
                            "crm",
                          )}
                          ${renderInvoicePaymentControls(state, aops, client, invoice)}
                          ${invoice.status === "draft" && invoiceMethod(client, "voidInvoice")
                            ? html`<button
                                class="crm-ag-link"
                                aria-label=${`Void invoice ${invoice.number}`}
                                @click=${() => void voidInvoice(state, client, invoice.id)}
                              >Void this draft</button>`
                            : nothing}
                        </article>
                      `,
                    )}
                  </div>`}
            `}

      ${renderDelivery(projects, tasks, currency)}
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * Projects and tasks
 * ------------------------------------------------------------------ */

function renderDelivery(
  projects: readonly AgencyProjectSummary[],
  tasks: readonly AgencyTaskSummary[],
  currency: string,
): TemplateResult {
  return html`
    <section class="crm-ag-delivery">
      <h4>Agency delivery</h4>
      ${projects.length === 0
        ? html`<section class="crm-ag-card is-empty">
            <h3>No agency projects attributed to this client</h3>
            <p>
              The project register was read and nothing is linked to this client. Projects created
              in Agency Operations and attached to this client appear here with their tasks and
              budgets.
            </p>
          </section>`
        : html`
            <div class="crm-ag-projects">
              ${projects.map((project) => {
                const own = tasks.filter((task) => task.projectId === project.id);
                const done = own.filter((task) => task.status === "done").length;
                return html`
                  <article class="crm-ag-project">
                    <div class="crm-ag-project-head">
                      <strong>${project.name}</strong>
                      <span class=${`crm-ag-chip is-${projectTone(project.status)}`}
                        >${humanize(project.status)}</span
                      >
                    </div>
                    <div class="crm-ag-project-meta">
                      <span>${moneyCents(project.budgetCents, currency)} budget</span>
                      <span>${done}/${own.length} tasks done</span>
                      ${project.targetEndAt
                        ? html`<span>target ${new Date(project.targetEndAt).toLocaleDateString()}</span>`
                        : nothing}
                    </div>
                    ${own.length === 0
                      ? html`<p class="crm-ag-note">No tasks on this project yet.</p>`
                      : html`<ul class="crm-ag-tasks">
                          ${own.slice(0, 8).map(
                            (task) => html`<li>
                              <span class=${`crm-ag-dot is-${taskTone(task.status)}`}></span>
                              <span class="crm-ag-task-title">${task.title}</span>
                              <span class="crm-ag-task-status">${humanize(task.status)}</span>
                            </li>`,
                          )}
                          ${own.length > 8
                            ? html`<li class="crm-ag-more">
                                ${own.length - 8} more task${own.length - 8 === 1 ? "" : "s"} on this
                                project.
                              </li>`
                            : nothing}
                        </ul>`}
                  </article>
                `;
              })}
            </div>
          `}
    </section>
  `;
}

function renderFailedCalls(failedCalls: readonly string[]): TemplateResult | typeof nothing {
  if (!failedCalls.length) return nothing;
  return banner(
    "warn",
    html`<strong
        >${failedCalls.length} agency call${failedCalls.length === 1 ? "" : "s"} failed while
        building this tab.</strong
      >
      Anything below may be incomplete.
      <ul>
        ${failedCalls.map((entry) => html`<li>${entry}</li>`)}
      </ul>`,
  );
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

/**
 * Matches the surrounding CRM detail page (dense cards on the glass surface)
 * while drawing every colour from the design tokens. No raw hex: the literals
 * inside var() are the design system's own documented defaults.
 */
export const clientAgencyStyles = html`
  <style>
    .crm-ag {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-width: 0;
    }
    .crm-ag-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      padding: 14px 16px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      backdrop-filter: var(--g-blur, blur(12px));
    }
    .crm-ag-head-main {
      min-width: 0;
      flex: 1 1 240px;
    }
    .crm-ag-head-main h3 {
      display: block;
      max-width: 100%;
      margin: 2px 0 7px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 17px;
      letter-spacing: -0.01em;
    }
    .crm-ag-eyebrow {
      font-size: 9.5px;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--g-accent, #22d3ee);
    }
    .crm-ag-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .crm-ag-chip {
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
    .crm-ag-chip.is-ok {
      border-color: var(--g-success-border, rgba(34, 197, 94, 0.42));
      background: var(--g-success-soft, rgba(34, 197, 94, 0.14));
      color: var(--g-success, #22c55e);
    }
    .crm-ag-chip.is-info {
      border-color: var(--g-info-border, rgba(56, 189, 248, 0.42));
      background: var(--g-info-soft, rgba(56, 189, 248, 0.14));
      color: var(--g-info, #38bdf8);
    }
    .crm-ag-chip.is-warn {
      border-color: var(--g-warning-border, rgba(245, 158, 11, 0.42));
      background: var(--g-warning-soft, rgba(245, 158, 11, 0.14));
      color: var(--g-warning, #f59e0b);
    }
    .crm-ag-chip.is-bad {
      border-color: var(--g-danger-border, rgba(239, 68, 68, 0.42));
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.14));
      color: var(--g-danger, #ef4444);
    }
    .crm-ag-chip.is-done {
      border-color: var(--g-primary-muted, rgba(139, 92, 246, 0.4));
      background: var(--g-primary-soft, rgba(139, 92, 246, 0.14));
      color: var(--g-primary, #a78bfa);
    }
    .crm-ag-chip.is-quiet,
    .crm-ag-chip.is-cold {
      opacity: 0.85;
    }
    .crm-ag-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      flex: 0 0 auto;
    }
    .crm-ag-btn {
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
    .crm-ag-btn:hover:not(:disabled) {
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.1));
    }
    .crm-ag-btn.is-primary {
      border-color: var(--g-primary-strong, #7c3aed);
      background: var(--g-primary, #8b5cf6);
      color: var(--g-on-primary, #fff);
    }
    .crm-ag-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .crm-ag-btn:focus-visible,
    .crm-ag-link:focus-visible {
      outline: 2px solid var(--g-primary, #8b5cf6);
      outline-offset: 2px;
    }
    .crm-ag-link {
      margin-top: 8px;
      padding: 0;
      border: 0;
      background: none;
      color: var(--g-primary, #a78bfa);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .crm-ag-link:hover {
      text-decoration: underline;
    }
    .crm-ag-note {
      margin: 0;
      font-size: 11.5px;
      line-height: 1.6;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .crm-ag-dl {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 10px;
      min-width: 0;
      margin-top: 10px;
    }
    /* The shared link style leads with a top margin for its stacked use; inside
       the download row it must sit on the button's own baseline. */
    .crm-ag-dl .crm-ag-link {
      margin-top: 0;
    }
    .crm-ag-dl .crm-ag-note {
      flex: 1 1 220px;
      min-width: 0;
    }
    .crm-ag-dl .crm-ag-note.is-bad {
      color: var(--g-danger, #ef4444);
    }
    .crm-ag-dl button[aria-busy="true"] {
      opacity: 0.75;
    }
    .aoi-cred {
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
    .aoi-cred-field em { font-style: normal; opacity: 0.7; }
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
    .aoi-cred-field small { opacity: 0.6; }
    .aoi-cred-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      min-width: 0;
    }
    .crm-ag-banner {
      padding: 10px 13px;
      border-radius: var(--g-radius, 12px);
      border: 1px solid var(--g-info-border, rgba(56, 189, 248, 0.4));
      background: var(--g-info-soft, rgba(56, 189, 248, 0.1));
      font-size: 11.5px;
      line-height: 1.6;
    }
    .crm-ag-banner.is-warn {
      border-color: var(--g-warning-border, rgba(245, 158, 11, 0.4));
      background: var(--g-warning-soft, rgba(245, 158, 11, 0.1));
    }
    .crm-ag-banner.is-bad {
      border-color: var(--g-danger-border, rgba(239, 68, 68, 0.4));
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.1));
    }
    .crm-ag-banner ul {
      margin: 6px 0 0;
      padding-left: 18px;
      word-break: break-word;
    }
    .crm-ag-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
      padding: 18px 18px 16px;
      border: 1px dashed var(--g-border-strong, rgba(255, 255, 255, 0.18));
      border-radius: var(--g-radius-lg, 18px);
      background: var(--g-surface, rgba(255, 255, 255, 0.03));
    }
    .crm-ag-card h3 {
      margin: 0;
      font-size: 14.5px;
    }
    .crm-ag-card p {
      margin: 0;
      max-width: 76ch;
      font-size: 12px;
      line-height: 1.65;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .crm-ag-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }
    .crm-ag-stats article {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      padding: 11px 13px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .crm-ag-stats span {
      font-size: 10px;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .crm-ag-stats strong {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 18px;
      font-variant-numeric: tabular-nums;
    }
    .crm-ag-stats strong.is-ok {
      color: var(--g-success, #22c55e);
    }
    .crm-ag-stats strong.is-warn {
      color: var(--g-warning, #f59e0b);
    }
    .crm-ag-stats strong.is-bad {
      color: var(--g-danger, #ef4444);
    }
    .crm-ag-stats small {
      font-size: 10.5px;
      color: var(--g-fg-faint, #71717a);
    }
    .crm-ag-invoices {
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .crm-ag-invoice {
      min-width: 0;
      padding: 11px 13px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .crm-ag-invoice-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .crm-ag-invoice-id {
      min-width: 0;
    }
    .crm-ag-invoice-id strong,
    .crm-ag-invoice-id small {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .crm-ag-invoice-id small {
      font-size: 10.5px;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .crm-ag-invoice-money {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      margin-top: 8px;
    }
    .crm-ag-invoice-money span {
      display: flex;
      flex-direction: column;
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .crm-ag-invoice-money small {
      font-size: 9.5px;
      font-weight: 400;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .crm-ag-delivery h4 {
      margin: 0 0 9px;
      font-size: 11px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .crm-ag-projects {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 10px;
    }
    .crm-ag-project {
      min-width: 0;
      padding: 11px 13px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
    }
    .crm-ag-project-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .crm-ag-project-head strong {
      display: block;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12.5px;
    }
    .crm-ag-project-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      margin-top: 5px;
      font-size: 10.5px;
      color: var(--g-fg-dim, #a1a1aa);
    }
    .crm-ag-tasks {
      list-style: none;
      margin: 9px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .crm-ag-tasks li {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      font-size: 11.5px;
    }
    .crm-ag-task-title {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .crm-ag-task-status {
      flex: 0 0 auto;
      font-size: 10px;
      color: var(--g-fg-faint, #71717a);
    }
    .crm-ag-more {
      font-size: 10.5px;
      color: var(--g-fg-faint, #71717a);
    }
    .crm-ag-dot {
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--g-neutral, #94a3b8);
    }
    .crm-ag-dot.is-ok {
      background: var(--g-success, #22c55e);
    }
    .crm-ag-dot.is-info {
      background: var(--g-info, #38bdf8);
    }
    .crm-ag-dot.is-bad {
      background: var(--g-danger, #ef4444);
    }
  </style>
`;
