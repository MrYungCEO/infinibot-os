export const DEFAULT_AGENCY_ID = "default";
export type AgencyRole = "owner" | "admin" | "member" | "viewer";

export interface Agency {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyProfile {
  agencyId: string;
  industry: string;
  plan: string;
  context: string;
  logo: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  tagline: string | null;
  branding: Record<string, unknown> | null;
  socialMedia: Record<string, unknown> | null;
  legacyBusinessId: string | null;
  legacySnapshot: Record<string, unknown> | null;
  importedAt: number | null;
  updatedAt: number;
}

/**
 * A reusable set of bank / payment instructions the agency can attach to an
 * invoice. Agency-level (not per-client), so "USD Wise" or "GBP Barclays" is
 * saved once and picked from a dropdown when composing.
 */
export interface AgencyPaymentAccount {
  id: string;
  agencyId: string;
  /** Human label shown in the picker, e.g. "USD Wise" / "GBP Barclays". */
  label: string;
  /** Optional lowercased ISO currency this account is denominated in. */
  currency: string | null;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  iban: string | null;
  swift: string | null;
  /** Routing / sort code. */
  routingNumber: string | null;
  /** Free-form extra instructions printed under the structured fields. */
  instructions: string | null;
  /** Offered first and pre-selected on a new invoice when set. */
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LegacyMigrationStatus {
  source: "business.json";
  sourceExists: boolean;
  businessesFound: number;
  agenciesCreated: number;
  agenciesUpdated: number;
  clientsImported: number;
  projectsImported: number;
  tasksImported: number;
  projectsQuarantined: number;
  databaseRowsQuarantined: number;
  unassignedAgencyId: string | null;
  completedAt: number | null;
  warnings: string[];
}

export interface AgencyMembership {
  agencyId: string;
  userId: string;
  role: AgencyRole;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyInvitation {
  id: string;
  agencyId: string;
  email: string;
  role: Exclude<AgencyRole, "owner">;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export type AgencyProjectStatus = "planned" | "active" | "on_hold" | "completed" | "cancelled";
export type AgencyTaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "blocked"
  | "review"
  | "done"
  | "cancelled";

export interface AgencyProject {
  id: string;
  agencyId: string;
  clientId: string | null;
  name: string;
  status: AgencyProjectStatus;
  ownerId: string | null;
  startAt: number | null;
  targetEndAt: number | null;
  budgetCents: number;
  /** Manually-set monthly recurring revenue attributed to this project. */
  mrrCents: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgencyTask {
  id: string;
  agencyId: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: AgencyTaskStatus;
  priority: "low" | "normal" | "high" | "urgent";
  assigneeType: "human" | "ai" | "hybrid" | null;
  assigneeId: string | null;
  acceptanceCriteria: string;
  dueAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type OpportunityStage = "lead" | "qualified" | "proposal" | "won" | "lost";
export type ProposalStatus =
  | "draft"
  | "internal_review"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired";
export type EngagementStatus = "planned" | "active" | "on_hold" | "completed" | "cancelled";
export type DeliverableStatus =
  | "backlog"
  | "in_progress"
  | "review"
  | "client_review"
  | "approved"
  | "changes_requested";
export type ApprovalStatus = "requested" | "approved" | "rejected";
export type ChangeRequestStatus = "draft" | "submitted" | "approved" | "rejected" | "implemented";
export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "void";

export interface ClientsNotionConfig {
  agencyId: string;
  notionDbId: string | null;
  notionDbName: string | null;
  schemaJson: string | null;
  lastSync: number | null;
  dbRowsMigrated: number;
}

export interface Client {
  id: string;
  agencyId: string;
  name: string;
  legalName: string | null;
  /**
   * Derived rollup kept for existing consumers and KPIs. Computed from
   * `pipelineStatus` by `deriveLegacyClientStatus`; never set independently.
   */
  status: "prospect" | "active" | "inactive";
  /** Real, queryable pipeline state, case-folded (e.g. "in progress"). */
  pipelineStatus: string;
  /** Display form of `pipelineStatus` (e.g. "In progress"). */
  pipelineStatusLabel: string;
  ownerId: string | null;
  billingEmail: string | null;
  notes: string | null;
  /** Contact & social platform fields (all nullable) */
  whatsapp: string | null;
  telegram: string | null;
  discord: string | null;
  instagram: string | null;
  phone: string | null;
  email: string | null;
  /**
   * Notion page ID — set when this client was pulled from / pushed to a
   * connected Notion CRM database. NULL for manually-created clients.
   */
  notionPageId: string | null;
  /**
   * All dynamic Notion properties as a JSON object. Fixed columns above
   * are the authoritative indexed copy; this blob carries additional
   * Notion-schema columns the fixed schema doesn't enumerate (e.g. custom
   * select fields, tags, company, address, …).
   */
  data: Record<string, unknown>;
  /** Unix ms timestamp of the last successful Notion sync for this row. */
  lastSynced: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Contact {
  id: string;
  agencyId: string;
  clientId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Opportunity {
  id: string;
  agencyId: string;
  clientId: string;
  name: string;
  stage: OpportunityStage;
  valueCents: number;
  probability: number;
  ownerId: string | null;
  expectedCloseAt: number | null;
  lostReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

/** Extra prose block on a proposal (timeline, assumptions, exclusions, ...). */
export interface ProposalSectionRecord {
  heading: string;
  body: string;
}

export interface Proposal {
  id: string;
  agencyId: string;
  opportunityId: string;
  /**
   * Denormalised owner of the proposal. Always resolvable from the
   * opportunity, but carried directly so a proposal can be authored (and
   * rendered) without a second lookup.
   */
  clientId: string | null;
  /** Human-facing reference, e.g. `PRO-2026-0004`. Null on legacy rows. */
  number: string | null;
  title: string;
  status: ProposalStatus;
  scope: string;
  /** One-paragraph executive summary printed above the scope. */
  summary: string | null;
  sections: ProposalSectionRecord[];
  acceptanceTerms: string[];
  currency: string;
  validUntil: number | null;
  acceptedAt: number | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  lineItems: ProposalLineItem[];
  createdAt: number;
  updatedAt: number;
}

export interface Engagement {
  id: string;
  agencyId: string;
  clientId: string;
  proposalId: string | null;
  name: string;
  status: EngagementStatus;
  budgetCents: number;
  startAt: number | null;
  targetEndAt: number | null;
  ownerId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Milestone {
  id: string;
  agencyId: string;
  engagementId: string;
  name: string;
  dueAt: number | null;
  completedAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface Deliverable {
  id: string;
  agencyId: string;
  engagementId: string;
  milestoneId: string | null;
  name: string;
  status: DeliverableStatus;
  acceptanceCriteria: string;
  assigneeType: "human" | "ai" | "hybrid" | null;
  assigneeId: string | null;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClientApproval {
  id: string;
  agencyId: string;
  engagementId: string;
  deliverableId: string | null;
  status: ApprovalStatus;
  requestedFromContactId: string | null;
  note: string | null;
  decidedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChangeRequest {
  id: string;
  agencyId: string;
  engagementId: string;
  status: ChangeRequestStatus;
  title: string;
  description: string;
  impactCents: number;
  impactDays: number;
  requestedByContactId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Invoice {
  id: string;
  agencyId: string;
  clientId: string;
  engagementId: string | null;
  /** Accepted proposal this invoice bills against, when there is one. */
  proposalId: string | null;
  number: string;
  status: InvoiceStatus;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  /** Label printed beside the tax row, e.g. "VAT 20%". */
  taxLabel: string | null;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  /** Purchase-order / external reference shown in the document meta block. */
  reference: string | null;
  notes: string | null;
  /** Payment-terms paragraph printed above the document footer. */
  terms: string | null;
  /** Saved bank/payment option whose details print on the document, if any. */
  paymentAccountId: string | null;
  issuedAt: number | null;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** An invoice with everything the authoring UI and the document model need. */
export interface InvoiceDetail {
  invoice: Invoice;
  lineItems: InvoiceLineItem[];
  projectLinks: InvoiceProjectLink[];
  payments: Payment[];
}

export interface Payment {
  id: string;
  agencyId: string;
  invoiceId: string;
  amountCents: number;
  paidAt: number;
  method: string | null;
  reference: string | null;
  createdAt: number;
}

export interface InvoiceLineItem {
  id: string;
  agencyId: string;
  invoiceId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  cadence: "one_time" | "monthly" | "quarterly" | "annual";
  sortOrder: number;
}

export interface InvoiceProjectLink {
  agencyId: string;
  invoiceId: string;
  projectId: string;
  allocationCents: number;
  createdAt: number;
}

export interface RevenueEntry {
  id: string;
  agencyId: string;
  clientId: string;
  invoiceId: string | null;
  sourceType: "invoice_issued" | "payment_received" | "manual_adjustment";
  sourceId: string;
  amountCents: number;
  currency: string;
  recurringMonthlyCents: number;
  description: string;
  recognizedAt: number;
  createdAt: number;
}

export interface ClientRevenueProfile {
  agencyId: string;
  clientId: string;
  currency: string;
  mrrCents: number;
  arrCents: number;
  lastInvoiceId: string | null;
  activeSince: number | null;
  updatedAt: number;
}

export interface RevenueSummary {
  currency: string;
  periodStart: number;
  periodEnd: number;
  invoicedRevenueCents: number;
  collectedRevenueCents: number;
  mrrCents: number;
  arrCents: number;
  activeMrrClients: number;
  averageRevenuePerClientCents: number;
  revenueByClient: Array<{
    clientId: string;
    clientName: string;
    invoicedCents: number;
    collectedCents: number;
    mrrCents: number;
  }>;
  revenueByProject: Array<{
    projectId: string;
    projectName: string;
    invoicedCents: number;
    collectedCents: number;
  }>;
  trend: Array<{
    month: string;
    invoicedCents: number;
    collectedCents: number;
  }>;
  /**
   * Forward-looking revenue. Unlike every other figure here this one is NOT
   * period-scoped: it answers "what is already sold or in flight", which the
   * owner reads next to the historical numbers.
   */
  pipeline: RevenuePipelineSummary;
}

export interface RevenuePipelineSummary {
  /** Total of proposals still in draft / internal_review / sent. */
  openProposalCents: number;
  /** Total of every accepted proposal. */
  acceptedProposalCents: number;
  /**
   * Accepted proposal value not yet covered by a non-void invoice — the part
   * of a won deal still waiting to be billed.
   */
  acceptedUninvoicedCents: number;
  /** Open opportunities (lead/qualified/proposal) at face value. */
  openPipelineCents: number;
  /** The same opportunities multiplied by their probability. */
  weightedPipelineCents: number;
  /** `acceptedUninvoicedCents + weightedPipelineCents`. */
  expectedRevenueCents: number;
}

export interface AuditEvent {
  id: number;
  agencyId: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  createdAt: number;
}

export interface BusinessSummary {
  activeClients: number;
  openPipelineCents: number;
  weightedPipelineCents: number;
  wonRevenueCents: number;
  activeEngagements: number;
  deliverablesAwaitingClient: number;
  outstandingInvoicesCents: number;
  overdueInvoicesCents: number;
  collectedCents: number;
}

// ── Hosted payment links + external payment reconciliation ──────────────────

/**
 * A hosted checkout link bound to exactly one invoice.
 *
 * One row per invoice (the invoice id is the primary key): an invoice has at
 * most one live link, so "regenerate" replaces rather than accumulates. The
 * provider credential is never stored here — only the identifiers the provider
 * handed back and the correlation token we minted.
 */
export interface InvoicePaymentLink {
  invoiceId: string;
  agencyId: string;
  /** Provider slug — `whop` today. */
  provider: string;
  /** Provider-side id (a Whop checkout configuration, `ch_…`). */
  externalId: string;
  /** The URL to put in front of the client. */
  url: string;
  label: string | null;
  /**
   * Correlation token we minted and pushed into the provider's checkout
   * metadata. A payment that echoes this token back is positive evidence.
   */
  reference: string;
  /** Amount the link was created for, in the store's integer cents. */
  amountCents: number;
  /** Lowercased ISO currency the link charges in. */
  currency: string;
  /** Provider-side plan id, when the provider created one (`plan_…`). */
  planId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ExternalPaymentReceiptStatus = "matched" | "unmatched" | "ignored";

/**
 * One provider-side payment we have seen, and what we did (or refused to do)
 * with it.
 *
 * This table is the idempotency ledger for reconciliation: a provider payment
 * we have already recorded a receipt for is never applied to an invoice twice,
 * because `(agency_id, provider, external_id)` is the primary key.
 */
export interface ExternalPaymentReceipt {
  id: string;
  agencyId: string;
  provider: string;
  /** Provider-side payment id (`pay_…`). */
  externalId: string;
  amountCents: number;
  currency: string;
  paidAt: number;
  status: ExternalPaymentReceiptStatus;
  /**
   * Why we matched, or why we refused to. Machine-readable; the UI can map it
   * to prose. See `PAYMENT_MATCH_REASONS`.
   */
  matchReason: string | null;
  invoiceId: string | null;
  /** The `payments.id` we wrote, when matched. */
  paymentId: string | null;
  /** Redacted provider payload — enough for a human to assign it by hand. */
  payload: {
    customerName?: string | null;
    customerEmail?: string | null;
    checkoutConfigurationId?: string | null;
    planId?: string | null;
    productTitle?: string | null;
    metadataKeys?: string[];
  };
  createdAt: number;
  updatedAt: number;
}
