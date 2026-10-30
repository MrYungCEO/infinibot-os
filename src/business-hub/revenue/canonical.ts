/**
 * Canonical revenue read model.
 *
 * Provider payments, manually logged income and agency invoice state all land
 * in `business-hub.db/revenue_txns`. Agency Operations remains the authoring
 * system for invoice documents; this module projects those documents and their
 * payments into the same idempotent ledger the Whop/Stripe sync uses. A payment
 * imported from Whop is suppressed when the invoice payment carries that same
 * provider id, so collection is never counted twice.
 */

import { resolveStateDirWithLegacyEnv } from "../../config/paths.js";
import { getAgencyOperationsStore } from "../../agency-operations/store.js";
import { DEFAULT_AGENCY_ID } from "../../agency-operations/types.js";
import type { HubDb } from "../db.js";
import { parseJson } from "../util.js";
import { upsertTxns } from "./ledger.js";
import type { LedgerRow } from "./types.js";

export const CLIENT_INVOICE_ACCOUNT_ID = "racct_client_invoices";
export const MANUAL_ACCOUNT_ID = "racct_manual_income";

export const REVENUE_PROJECTS = [
  "InfiniBot Cloud",
  "FlyPic",
  "Robovoice",
  "InfiniBot plugins",
  "Infinitrade",
  "Courses / digital products",
  "KinglyVault",
  "Agency clients",
] as const;
export type RevenueProject = (typeof REVENUE_PROJECTS)[number];

type RawRecord = Record<string, unknown>;

function ensureInternalAccount(
  db: HubDb,
  input: { id: string; provider: "invoice" | "manual"; label: string },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO revenue_accounts(id,provider,label,status,created_at,updated_at)
     VALUES(?,?,?,'ok',?,?)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label,status='ok',updated_at=excluded.updated_at`,
  ).run(input.id, input.provider, input.label, now, now);
}

export function defaultProjectForProduct(
  name: string | null | undefined,
  source: { accountId?: string; provider?: string; label?: string } = {},
): RevenueProject {
  const n = (name ?? "").toLowerCase();
  if (/kingly\s*vault|kinglyvault/.test(n)) return "KinglyVault";
  if (/fly\s*pic|flypic|seedance|video\s*(studio|generation)/.test(n)) return "FlyPic";
  if (/robo\s*voice|robovoice|voice\s*(agent|minute|call)/.test(n)) return "Robovoice";
  if (/infini\s*trade|infinitrade|trading|signal/.test(n)) return "Infinitrade";
  if (/plugin|extension|marketplace/.test(n)) return "InfiniBot plugins";
  if (/1\s*on\s*1|minute\s*call|done\s*for\s*you|consult|agency|service/.test(n))
    return "Agency clients";
  if (
    /course|academy|guide|template|ebook|digital|vault pack|starter pack|automation mastery|zero to glitch|ai income hub|yungceo|mentorship|society|passive income|biz in a box|n8n agents|vidblitzz/.test(
      n,
    )
  )
    return "Courses / digital products";
  if (/infini\s*bot|infinibot|cloud|hosted|tenant|ceo plan/.test(n)) return "InfiniBot Cloud";
  // Every synced catalog row must be represented in the owner-facing project
  // inventory, including products which have never sold and old payments for
  // which Whop no longer returns a product. Source context makes those honest
  // rather than leaving an un-actionable "Unmapped" revenue bucket.
  if (
    source.accountId === CLIENT_INVOICE_ACCOUNT_ID ||
    source.accountId === MANUAL_ACCOUNT_ID ||
    source.provider === "invoice" ||
    source.provider === "manual"
  )
    return "Agency clients";
  if (/kingly\s*vault|kinglyvault/.test(source.label ?? "")) return "KinglyVault";
  return "Courses / digital products";
}

export function productKey(accountId: string, productId: string | null, name: string): string {
  return `${accountId}:${productId || name.trim().toLowerCase()}`;
}

export type ProductProjectMapping = {
  key: string;
  accountId: string;
  productId: string | null;
  productName: string;
  project: RevenueProject;
  explicit: boolean;
  sourceLabel: string;
  sourceProvider: string;
  catalog: boolean;
};

export function listProductProjectMappings(db: HubDb): ProductProjectMapping[] {
  const explicit = new Map(
    (
      db
        .prepare(
          "SELECT product_key,account_id,product_id,product_name,project FROM revenue_project_mappings",
        )
        .all() as Array<{
        product_key: string;
        account_id: string;
        product_id: string | null;
        product_name: string;
        project: RevenueProject;
      }>
    ).map((row) => [row.product_key, row]),
  );
  const products = db
    .prepare(
      `WITH products AS (
         SELECT account_id, external_id product_id, name product_name, 1 catalog
         FROM revenue_products
         WHERE COALESCE(json_extract(raw,'$.kind'),'product') <> 'plan'
         UNION
         SELECT account_id, product_id, COALESCE(product_name,'(unknown)') product_name, 0 catalog
         FROM revenue_txns WHERE type='charge'
       )
       SELECT p.account_id,p.product_id,p.product_name,MAX(p.catalog) catalog,
              COALESCE(a.label,p.account_id) source_label,COALESCE(a.provider,'unknown') source_provider
       FROM products p LEFT JOIN revenue_accounts a ON a.id=p.account_id
       GROUP BY p.account_id,p.product_id,p.product_name
       ORDER BY lower(source_label),lower(p.product_name),p.product_id`,
    )
    .all() as Array<{
    account_id: string;
    product_id: string | null;
    product_name: string;
    catalog: number;
    source_label: string;
    source_provider: string;
  }>;
  return products.map((row) => {
    const key = productKey(row.account_id, row.product_id, row.product_name);
    const override = explicit.get(key);
    return {
      key,
      accountId: row.account_id,
      productId: row.product_id,
      productName: row.product_name,
      project:
        override?.project ??
        defaultProjectForProduct(row.product_name, {
          accountId: row.account_id,
          provider: row.source_provider,
          label: row.source_label,
        }),
      explicit: Boolean(override),
      sourceLabel: row.source_label,
      sourceProvider: row.source_provider,
      catalog: Boolean(row.catalog),
    };
  });
}

export function setProductProjectMapping(
  db: HubDb,
  input: { accountId: string; productId?: string | null; productName: string; project: string },
): ProductProjectMapping {
  if (!REVENUE_PROJECTS.includes(input.project as RevenueProject)) {
    throw new Error(`project must be one of ${REVENUE_PROJECTS.join(", ")}`);
  }
  const key = productKey(input.accountId, input.productId ?? null, input.productName);
  const now = Date.now();
  db.prepare(
    `INSERT INTO revenue_project_mappings(product_key,account_id,product_id,product_name,project,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(product_key) DO UPDATE SET
       product_name=excluded.product_name,project=excluded.project,updated_at=excluded.updated_at`,
  ).run(key, input.accountId, input.productId ?? null, input.productName, input.project, now, now);
  return {
    key,
    accountId: input.accountId,
    productId: input.productId ?? null,
    productName: input.productName,
    project: input.project as RevenueProject,
    explicit: true,
    sourceLabel: input.accountId,
    sourceProvider: "unknown",
    catalog: false,
  };
}

export function projectForLedgerRow(
  db: HubDb,
  row: {
    accountId: string;
    productId: string | null;
    productName: string | null;
    projectId?: string | null;
  },
): string {
  if (row.projectId) return row.projectId;
  const name = row.productName ?? "(unknown)";
  const key = productKey(row.accountId, row.productId, name);
  const mapped = db
    .prepare("SELECT project FROM revenue_project_mappings WHERE product_key=?")
    .get(key) as { project: string } | undefined;
  if (mapped?.project) return mapped.project;
  const source = db
    .prepare("SELECT provider,label FROM revenue_accounts WHERE id=?")
    .get(row.accountId) as { provider: string; label: string } | undefined;
  return defaultProjectForProduct(name, { accountId: row.accountId, ...source });
}

function invoiceStatus(status: string, dueAt: number | null, balance: number, now: number): string {
  if (status === "void" || status === "paid" || status === "draft") return status;
  if (balance > 0 && dueAt !== null && dueAt < now) return "overdue";
  return status;
}

/** Project all agency invoices and payments into the canonical ledger. */
export function syncAgencyRevenueToLedger(
  db: HubDb,
  options: { stateDir?: string; agencyId?: string; now?: number } = {},
): { invoices: number; payments: number; inserted: number; updated: number } {
  const stateDir = options.stateDir ?? resolveStateDirWithLegacyEnv();
  const now = options.now ?? Date.now();
  const store = getAgencyOperationsStore(stateDir);
  // Business Hub is an owner-wide view: no agencyId means every agency in the
  // canonical store. Agency Operations RPCs pass an id and remain scoped.
  if (!options.agencyId) {
    const totals = { invoices: 0, payments: 0, inserted: 0, updated: 0 };
    const agencyIds = store.listAgencies().map((agency) => agency.id);
    if (!agencyIds.includes(DEFAULT_AGENCY_ID)) agencyIds.push(DEFAULT_AGENCY_ID);
    for (const agencyId of agencyIds) {
      const result = syncAgencyRevenueToLedger(db, { stateDir, agencyId, now });
      totals.invoices += result.invoices;
      totals.payments += result.payments;
      totals.inserted += result.inserted;
      totals.updated += result.updated;
    }
    return totals;
  }
  const agencyId = options.agencyId;
  const invoices = store.listInvoices(agencyId);
  if (!invoices.length) return { invoices: 0, payments: 0, inserted: 0, updated: 0 };
  const agencyName = store.getAgency(agencyId)?.name ?? agencyId;
  ensureInternalAccount(db, {
    id: CLIENT_INVOICE_ACCOUNT_ID,
    provider: "invoice",
    label: "Client invoices",
  });
  const clients = new Map(store.listClients(agencyId).map((client) => [client.id, client]));
  const projects = new Map(store.listProjects(agencyId).map((project) => [project.id, project]));
  const rows: LedgerRow[] = [];
  const links: Array<{
    externalId: string;
    invoiceId: string;
    clientId: string;
    contactId: string | null;
    companyId: string | null;
    projectId: string;
    raw: RawRecord;
  }> = [];
  let paymentCount = 0;

  for (const invoice of invoices) {
    const client = clients.get(invoice.clientId);
    const projectLinks = store.listInvoiceProjectLinks(agencyId, invoice.id);
    const allocations = projectLinks.map((link) => ({
      projectId: link.projectId,
      project: projects.get(link.projectId)?.name ?? "Agency clients",
      amountCents: link.allocationCents,
    }));
    const primaryProject = allocations[0]?.project ?? "Agency clients";
    const contact = client?.billingEmail
      ? (db
          .prepare("SELECT id,company_id FROM contacts WHERE lower(email)=lower(?) LIMIT 1")
          .get(client.billingEmail) as { id: string; company_id: string | null } | undefined)
      : undefined;
    const balance = Math.max(0, invoice.balanceCents);
    const status = invoiceStatus(invoice.status, invoice.dueAt, balance, now);
    const invoiceRaw = {
      kind: "client_invoice",
      invoiceNumber: invoice.number,
      invoiceStatus: status,
      originalStatus: invoice.status,
      totalCents: invoice.totalCents,
      amountPaidCents: invoice.amountPaidCents,
      balanceCents: balance,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      projectAllocations: allocations,
      agencyId,
      agencyName,
    };
    rows.push({
      externalId: `invoice:${invoice.id}`,
      type: "invoice",
      status,
      grossCents: invoice.totalCents,
      feeCents: 0,
      netCents: invoice.amountPaidCents,
      refundedCents: 0,
      currency: invoice.currency,
      amountUsdCents: invoice.currency === "USD" ? invoice.totalCents : null,
      occurredAt: invoice.issuedAt ?? invoice.createdAt,
      productId: invoice.id,
      productName: `Invoice ${invoice.number}`,
      planId: null,
      billingReason: "invoice",
      customerRef: invoice.clientId,
      customerEmail: client?.billingEmail ?? client?.email ?? null,
      customerName: client?.name ?? null,
      subscriptionRef: null,
      parentExternalId: null,
      raw: invoiceRaw,
    });
    links.push({
      externalId: `invoice:${invoice.id}`,
      invoiceId: invoice.id,
      clientId: invoice.clientId,
      contactId: contact?.id ?? null,
      companyId: contact?.company_id ?? null,
      projectId: primaryProject,
      raw: invoiceRaw,
    });

    const lineItems = store.listInvoiceLineItems(agencyId, invoice.id);
    const recurring = lineItems.some((item) => item.cadence !== "one_time");
    for (const payment of store.listInvoicePayments(agencyId, invoice.id)) {
      paymentCount++;
      const raw = {
        kind: "client_invoice_payment",
        invoiceNumber: invoice.number,
        invoiceStatus: status,
        paymentMethod: payment.method,
        paymentReference: payment.reference,
        projectAllocations: allocations,
        agencyId,
        agencyName,
      };
      rows.push({
        externalId: `invoice-payment:${payment.id}`,
        type: "charge",
        status: "succeeded",
        grossCents: payment.amountCents,
        feeCents: 0,
        netCents: payment.amountCents,
        refundedCents: 0,
        currency: invoice.currency,
        amountUsdCents: invoice.currency === "USD" ? payment.amountCents : null,
        occurredAt: payment.paidAt,
        productId: invoice.id,
        productName: `Invoice ${invoice.number}`,
        planId: null,
        billingReason: recurring ? "subscription" : "one_time",
        customerRef: invoice.clientId,
        customerEmail: client?.billingEmail ?? client?.email ?? null,
        customerName: client?.name ?? null,
        subscriptionRef: null,
        // Reconciled Whop/Stripe invoice payments carry the provider payment id
        // as their reference. Metrics use this to suppress the duplicate copy.
        parentExternalId:
          payment.method === "whop" || payment.method === "stripe" ? payment.reference : null,
        raw,
      });
      links.push({
        externalId: `invoice-payment:${payment.id}`,
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        contactId: contact?.id ?? null,
        companyId: contact?.company_id ?? null,
        projectId: primaryProject,
        raw,
      });
    }
  }

  const account = { id: CLIENT_INVOICE_ACCOUNT_ID, provider: "invoice" };
  const stats = db.transaction(() => {
    const result = upsertTxns(db, account, rows);
    const update = db.prepare(
      `UPDATE revenue_txns SET invoice_id=?,client_id=?,contact_id=COALESCE(?,contact_id),
       company_id=COALESCE(?,company_id),project_id=?,raw=?,updated_at=?
       WHERE account_id=? AND external_id=?`,
    );
    for (const link of links) {
      update.run(
        link.invoiceId,
        link.clientId,
        link.contactId,
        link.companyId,
        link.projectId,
        JSON.stringify(link.raw),
        now,
        CLIENT_INVOICE_ACCOUNT_ID,
        link.externalId,
      );
    }
    return result;
  })();
  return {
    invoices: invoices.length,
    payments: paymentCount,
    inserted: stats.inserted,
    updated: stats.updated,
  };
}

export type ArAging = {
  asOf: number;
  totalCents: number;
  overdueCents: number;
  buckets: Array<{
    id: "current" | "30" | "60" | "90+";
    label: string;
    cents: number;
    count: number;
  }>;
  invoices: Array<{
    invoiceId: string;
    number: string;
    clientId: string | null;
    client: string;
    agency: string;
    status: string;
    originalStatus: string;
    currency: string;
    totalCents: number;
    paidCents: number;
    balanceCents: number;
    dueAt: number | null;
    daysOverdue: number;
    bucket: "current" | "30" | "60" | "90+";
    open: boolean;
  }>;
};

export function revenueArAging(db: HubDb, asOf = Date.now()): ArAging {
  const rows = db
    .prepare(
      `SELECT invoice_id,customer_name,client_id,status,currency,raw
       FROM revenue_txns WHERE account_id=? AND type='invoice'`,
    )
    .all(CLIENT_INVOICE_ACCOUNT_ID) as Array<{
    invoice_id: string;
    customer_name: string | null;
    client_id: string | null;
    status: string;
    currency: string;
    raw: string;
  }>;
  const buckets: ArAging["buckets"] = [
    { id: "current", label: "Current", cents: 0, count: 0 },
    { id: "30", label: "1–30 days", cents: 0, count: 0 },
    { id: "60", label: "31–60 days", cents: 0, count: 0 },
    { id: "90+", label: "90+ days", cents: 0, count: 0 },
  ];
  const invoices: ArAging["invoices"] = [];
  for (const row of rows) {
    const raw = parseJson<RawRecord>(row.raw, {});
    const balance = typeof raw.balanceCents === "number" ? raw.balanceCents : 0;
    const dueAt = typeof raw.dueAt === "number" ? raw.dueAt : null;
    const days = dueAt === null ? 0 : Math.max(0, Math.floor((asOf - dueAt) / 86_400_000));
    const id: ArAging["buckets"][number]["id"] =
      days === 0 ? "current" : days <= 30 ? "30" : days <= 60 ? "60" : "90+";
    const open = balance > 0 && row.status !== "void" && row.status !== "draft";
    if (open) {
      const bucket = buckets.find((entry) => entry.id === id)!;
      bucket.cents += balance;
      bucket.count++;
    }
    invoices.push({
      invoiceId: row.invoice_id,
      number: typeof raw.invoiceNumber === "string" ? raw.invoiceNumber : row.invoice_id,
      clientId: row.client_id,
      client: row.customer_name ?? "Unknown client",
      agency: typeof raw.agencyName === "string" ? raw.agencyName : "Agency",
      status: row.status,
      originalStatus: typeof raw.originalStatus === "string" ? raw.originalStatus : row.status,
      currency: row.currency,
      totalCents: typeof raw.totalCents === "number" ? raw.totalCents : 0,
      paidCents: typeof raw.amountPaidCents === "number" ? raw.amountPaidCents : 0,
      balanceCents: row.status === "void" ? 0 : balance,
      dueAt,
      daysOverdue: days,
      bucket: id,
      open,
    });
  }
  invoices.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balanceCents - a.balanceCents);
  const totalCents = invoices
    .filter((row) => row.open)
    .reduce((sum, row) => sum + row.balanceCents, 0);
  const overdueCents = invoices
    .filter((row) => row.open && row.daysOverdue > 0)
    .reduce((sum, row) => sum + row.balanceCents, 0);
  return { asOf, totalCents, overdueCents, buckets, invoices };
}
