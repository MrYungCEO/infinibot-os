/**
 * Database packs — one-click installable bundles of system databases.
 *
 * Each pack is a curated set of databases with sensible default properties,
 * sized for a specific workflow shape (CRM, eCom, Service, Agency). The
 * Business workspace surfaces these as "Library" tiles; clicking Install runs
 * `business.pack.install` which:
 *
 *   1. For each database in the pack, resolves its system role:
 *      - already mapped → reuse the existing database (no churn)
 *      - not mapped → create a fresh native database with the default
 *        properties, then bind the system role to it
 *
 *   2. Returns the resolved database ids so the workspace UI can drop the
 *      panels into place immediately.
 *
 * Packs intentionally use SystemRole strings rather than free-text names so
 * they participate in the agent tool's role lookup ("upsert into the clients
 * database for this business") without each pack having to know its own
 * database id.
 */
import type { PropertyConfig, PropertyType, SystemRole } from "../databases/types.js";

export interface PackPropertyDef {
  name: string;
  type: PropertyType;
  config?: PropertyConfig;
  /** Hide from the default table view; still queryable. */
  hidden?: boolean;
  /**
   * For relation properties: the SystemRole of the target database. The
   * installer resolves this to a concrete databaseId at install time, so packs
   * don't have to know the ids of databases that don't exist yet. Set this
   * (instead of config.targetDatabaseId) on cross-pack relations.
   */
  targetRole?: SystemRole;
}

export interface PackDatabaseDef {
  /**
   * Well-known role this database fills. The installer looks up the role
   * before creating; if already mapped, the existing database is reused.
   */
  role: SystemRole;
  /** Display name when freshly created (existing dbs keep their name). */
  name: string;
  icon?: string;
  description?: string;
  /** Property schema applied only when the database is freshly created. */
  properties: PackPropertyDef[];
}

export interface DatabasePack {
  id: PackId;
  name: string;
  description: string;
  icon: string;
  /**
   * Order matters — earlier dbs are created before later ones so a "Deals"
   * relation property targeting "Companies" can resolve once we wire that
   * up in a later pass.
   */
  databases: PackDatabaseDef[];
}

export type PackId = "crm" | "ecom" | "service" | "agency";

// ─── Property kits ──────────────────────────────────────────────────────────
// Small reusable building blocks so the packs read cleanly.

const TITLE = (name: string): PackPropertyDef => ({ name, type: "title" });
const TEXT = (name: string): PackPropertyDef => ({ name, type: "richText" });
const URL = (name: string): PackPropertyDef => ({ name, type: "url" });
const EMAIL = (name = "Email"): PackPropertyDef => ({ name, type: "email" });
const PHONE = (name = "Phone"): PackPropertyDef => ({ name, type: "phone" });
const DATE = (name: string): PackPropertyDef => ({ name, type: "date" });
const NUM = (name: string, format = "number"): PackPropertyDef => ({
  name,
  type: "number",
  config: { format },
});
const MONEY = (name: string): PackPropertyDef => ({
  name,
  type: "number",
  config: { format: "currency" },
});
const CHECK = (name: string): PackPropertyDef => ({ name, type: "checkbox" });
const FILES = (name: string, mimes?: string[]): PackPropertyDef => ({
  name,
  type: "files",
  config: mimes ? { allowedMimePrefixes: mimes } : undefined,
});

const SELECT = (name: string, options: string[]): PackPropertyDef => ({
  name,
  type: "select",
  config: {
    options: options.map((o, i) => ({ id: `opt_${i}`, name: o })),
  },
});
const STATUS = (name: string, options: string[]): PackPropertyDef => ({
  name,
  type: "status",
  config: {
    options: options.map((o, i) => ({ id: `opt_${i}`, name: o })),
  },
});
const TAGS = (name = "Tags"): PackPropertyDef => ({
  name,
  type: "multiSelect",
  config: { options: [] },
});

// ─── Pack definitions ───────────────────────────────────────────────────────

export const PACKS: Record<PackId, DatabasePack> = {
  crm: {
    id: "crm",
    name: "CRM Pack",
    description:
      "Track relationships end to end: companies you sell to, the contacts inside them, your active clients, and the deals in flight.",
    icon: "👥",
    databases: [
      {
        role: "companies",
        name: "Companies",
        icon: "🏢",
        description: "Organizations you do business with.",
        properties: [
          TITLE("Name"),
          URL("Website"),
          SELECT("Industry", ["SaaS", "Agency", "eCommerce", "Manufacturing", "Other"]),
          NUM("Employees"),
          MONEY("Annual Revenue"),
          TAGS(),
          TEXT("Notes"),
        ],
      },
      {
        role: "contacts",
        name: "Contacts",
        icon: "📇",
        description: "People at the companies you sell to.",
        properties: [
          TITLE("Name"),
          EMAIL(),
          PHONE(),
          { name: "Company", type: "relation", targetRole: "companies" },
          { name: "Role", type: "richText" },
          STATUS("Stage", ["Cold", "Warm", "Hot", "Customer", "Lost"]),
          TAGS(),
          TEXT("Notes"),
        ],
      },
      {
        role: "clients",
        name: "Clients",
        icon: "🤝",
        description: "Companies in active engagement.",
        properties: [
          TITLE("Name"),
          { name: "Primary Contact", type: "relation", targetRole: "contacts" },
          STATUS("Status", ["Onboarding", "Active", "Paused", "Churned"]),
          MONEY("MRR"),
          DATE("Started"),
          TAGS(),
          TEXT("Notes"),
        ],
      },
      {
        role: "deals",
        name: "Deals",
        icon: "💰",
        description: "Open opportunities with stage + value.",
        properties: [
          TITLE("Title"),
          { name: "Company", type: "relation", targetRole: "companies" },
          { name: "Contact", type: "relation", targetRole: "contacts" },
          STATUS("Stage", ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]),
          MONEY("Value"),
          NUM("Probability %"),
          DATE("Expected close"),
          TEXT("Notes"),
        ],
      },
    ],
  },

  ecom: {
    id: "ecom",
    name: "eCommerce Pack",
    description:
      "Run an online store: catalogue your products, capture orders, manage your customer book, and track refunds.",
    icon: "🛍️",
    databases: [
      {
        role: "products",
        name: "Products",
        icon: "📦",
        description: "Catalogue with images, price, SKU, and stock.",
        properties: [
          TITLE("Name"),
          { name: "SKU", type: "richText" },
          MONEY("Price"),
          MONEY("Cost"),
          NUM("Stock"),
          STATUS("Status", ["Draft", "Active", "Out of stock", "Archived"]),
          FILES("Images", ["image/"]),
          URL("Image URL"),
          URL("Thumbnail URL"),
          TAGS(),
          TEXT("Description"),
        ],
      },
      {
        role: "customers",
        name: "Customers",
        icon: "🧑",
        description: "Buyers across your store and channels.",
        properties: [
          TITLE("Name"),
          EMAIL(),
          PHONE(),
          { name: "Address", type: "richText" },
          MONEY("Lifetime Spend"),
          NUM("Orders"),
          DATE("First Order"),
          DATE("Last Order"),
          TAGS(),
        ],
      },
      {
        role: "orders",
        name: "Orders",
        icon: "🧾",
        description: "Line items, totals, fulfillment status.",
        properties: [
          TITLE("Order #"),
          { name: "Customer", type: "relation", targetRole: "customers" },
          STATUS("Status", ["Pending", "Paid", "Fulfilled", "Refunded", "Cancelled"]),
          MONEY("Subtotal"),
          MONEY("Tax"),
          MONEY("Shipping"),
          MONEY("Total"),
          DATE("Placed"),
          { name: "Items", type: "richText" },
          TAGS(),
        ],
      },
      {
        role: "refunds",
        name: "Refunds",
        icon: "↩️",
        description: "Returns, partial refunds, chargebacks.",
        properties: [
          TITLE("Refund #"),
          { name: "Order", type: "relation", targetRole: "orders" },
          { name: "Customer", type: "relation", targetRole: "customers" },
          STATUS("Status", ["Requested", "Approved", "Issued", "Denied"]),
          MONEY("Amount"),
          SELECT("Reason", ["Defective", "Wrong item", "Not as described", "Other"]),
          DATE("Issued"),
          TEXT("Notes"),
        ],
      },
    ],
  },

  service: {
    id: "service",
    name: "Service Pack",
    description:
      "Coaches, consultants, and agencies running booked sessions: clients, the sessions you deliver, and invoices for the work.",
    icon: "🛎️",
    databases: [
      {
        role: "clients",
        name: "Clients",
        icon: "🤝",
        description: "Active and past service clients.",
        properties: [
          TITLE("Name"),
          EMAIL(),
          PHONE(),
          STATUS("Status", ["Onboarding", "Active", "Paused", "Churned"]),
          DATE("Started"),
          MONEY("MRR"),
          TAGS(),
          TEXT("Notes"),
        ],
      },
      {
        role: "sessions",
        name: "Sessions",
        icon: "📅",
        description: "Booked, completed, or cancelled service sessions.",
        properties: [
          TITLE("Title"),
          { name: "Client", type: "relation", targetRole: "clients" },
          STATUS("Status", ["Scheduled", "Completed", "Cancelled", "No-show"]),
          DATE("When"),
          NUM("Duration (min)"),
          MONEY("Fee"),
          { name: "Notes", type: "richText" },
        ],
      },
      {
        role: "invoices",
        name: "Invoices",
        icon: "💵",
        description: "Issued bills with status and totals.",
        properties: [
          TITLE("Invoice #"),
          { name: "Client", type: "relation", targetRole: "clients" },
          STATUS("Status", ["Draft", "Sent", "Paid", "Overdue", "Voided"]),
          MONEY("Amount"),
          DATE("Issued"),
          DATE("Due"),
          DATE("Paid"),
          { name: "Line Items", type: "richText" },
        ],
      },
    ],
  },

  agency: {
    id: "agency",
    name: "Agency Pack",
    description:
      "Agencies juggling delivery + billing: clients, projects, tasks, time entries, and invoices, all linked.",
    icon: "🏛️",
    databases: [
      {
        role: "clients",
        name: "Clients",
        icon: "🤝",
        description: "Companies engaging your agency.",
        properties: [
          TITLE("Name"),
          EMAIL(),
          PHONE(),
          STATUS("Status", ["Active", "Paused", "Churned"]),
          MONEY("Retainer"),
          TAGS(),
          TEXT("Notes"),
        ],
      },
      {
        role: "projects",
        name: "Projects",
        icon: "📁",
        description: "Engagements you deliver against.",
        properties: [
          TITLE("Name"),
          { name: "Client", type: "relation", targetRole: "clients" },
          STATUS("Status", ["Planning", "In progress", "Review", "Done", "On hold"]),
          DATE("Started"),
          DATE("Due"),
          MONEY("Budget"),
          NUM("Progress %"),
          TAGS(),
        ],
      },
      {
        role: "tasks",
        name: "Tasks",
        icon: "✓",
        description: "Work items for delivery teams.",
        properties: [
          TITLE("Title"),
          { name: "Project", type: "relation", targetRole: "projects" },
          STATUS("Status", ["Todo", "In progress", "Review", "Done"]),
          SELECT("Priority", ["Low", "Medium", "High", "Critical"]),
          { name: "Assignee", type: "person" },
          DATE("Due"),
          NUM("Estimate (hr)"),
          TAGS(),
        ],
      },
      {
        role: "time_entries",
        name: "Time Entries",
        icon: "⏱️",
        description: "Hours logged against projects + tasks.",
        properties: [
          TITLE("Description"),
          { name: "Project", type: "relation", targetRole: "projects" },
          { name: "Task", type: "relation", targetRole: "tasks" },
          { name: "Person", type: "person" },
          DATE("Date"),
          NUM("Hours"),
          MONEY("Rate"),
          CHECK("Billable"),
          CHECK("Invoiced"),
        ],
      },
      {
        role: "invoices",
        name: "Invoices",
        icon: "💵",
        description: "Issued bills tied to projects and time.",
        properties: [
          TITLE("Invoice #"),
          { name: "Client", type: "relation", targetRole: "clients" },
          STATUS("Status", ["Draft", "Sent", "Paid", "Overdue", "Voided"]),
          MONEY("Amount"),
          DATE("Issued"),
          DATE("Due"),
          DATE("Paid"),
          { name: "Line Items", type: "richText" },
        ],
      },
    ],
  },
};

export function listPacks(): DatabasePack[] {
  return Object.values(PACKS);
}

export function getPack(id: string): DatabasePack | null {
  return (PACKS as Record<string, DatabasePack | undefined>)[id] ?? null;
}
