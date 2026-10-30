/**
 * Business / CRM database templates.
 *
 * Auto-seeded on first run so a brand-new InfiniBot install ships with a
 * usable CRM + project workspace out of the box. Schemas map 1:1 to common
 * Notion CRM shapes — same property names, same option names, same
 * semantics — so users coming from Notion can paste data straight in (or
 * use the optional Notion import flow) and have everything line up.
 *
 * Critically: **none of this depends on Notion.** The local SQLite database
 * is the system of record. Notion sync is an optional add-on that mirrors
 * rows back and forth when the user provides an API key. With no key, the
 * local databases work fully on their own.
 *
 * Add a template here:
 *   1. Push a `BusinessTemplate` to TEMPLATES with name + Notion-friendly
 *      properties.
 *   2. Optionally bind it to a SystemRole so agent tools can resolve it
 *      ("clients" → this database).
 *   3. The auto-seed call in store.ts picks it up next gateway start.
 */

import type { DatabasesStore } from "./store.js";
import type { PropertyType, PropertyConfig, SystemRole } from "./types.js";
import { ensureLeadPipelineTemplates } from "./lead-pipeline-seed.js";
import { ensureLeadTemperatureProperty } from "./lead-temperature-seed.js";

interface TemplateProperty {
  name: string;
  type: PropertyType;
  config?: PropertyConfig;
}

interface BusinessTemplate {
  name: string;
  icon: string;
  description: string;
  /** Optional system role this template fulfils. */
  role?: SystemRole;
  properties: TemplateProperty[];
}

const TEMPLATES: BusinessTemplate[] = [
  // ── CRM core ──────────────────────────────────────────────────
  {
    name: "Clients",
    icon: "👥",
    role: "clients",
    description:
      "Active customer relationships — companies you're delivering to. Notion-compatible (Customer DB).",
    properties: [
      { name: "Name", type: "title" },
      {
        name: "Status",
        type: "status",
        config: {
          options: [
            { id: "prospect", name: "Prospect", color: "#94a3b8" },
            { id: "active", name: "Active", color: "#10b981" },
            { id: "paused", name: "Paused", color: "#f59e0b" },
            { id: "churned", name: "Churned", color: "#ef4444" },
          ],
        },
      },
      {
        name: "Tier",
        type: "select",
        config: {
          options: [
            { id: "enterprise", name: "Enterprise", color: "#8b5cf6" },
            { id: "growth", name: "Growth", color: "#3b82f6" },
            { id: "starter", name: "Starter", color: "#10b981" },
          ],
        },
      },
      { name: "Email", type: "email" },
      { name: "Phone", type: "phone" },
      { name: "Website", type: "url" },
      { name: "MRR", type: "number", config: { format: "currency" } },
      { name: "Owner", type: "person" },
      { name: "Tags", type: "multiSelect", config: { options: [] } },
      { name: "Last Contact", type: "date" },
      { name: "Notes", type: "richText" },
      // Cross-link to other CRM objects.
      { name: "Company", type: "relation" },
      { name: "Deals", type: "relation" },
    ],
  },
  {
    name: "Leads",
    icon: "🎯",
    role: "leads",
    description: "Inbound + outbound prospects in the pipeline. Notion-compatible (Pipeline DB).",
    properties: [
      { name: "Name", type: "title" },
      {
        name: "Stage",
        type: "status",
        config: {
          options: [
            { id: "new", name: "New", color: "#94a3b8" },
            { id: "qualified", name: "Qualified", color: "#3b82f6" },
            { id: "contacted", name: "Contacted", color: "#8b5cf6" },
            { id: "demo_scheduled", name: "Demo scheduled", color: "#f59e0b" },
            { id: "negotiating", name: "Negotiating", color: "#f97316" },
            { id: "won", name: "Won", color: "#10b981" },
            { id: "lost", name: "Lost", color: "#ef4444" },
          ],
        },
      },
      {
        name: "Source",
        type: "select",
        config: {
          options: [
            { id: "inbound", name: "Inbound" },
            { id: "referral", name: "Referral" },
            { id: "outbound", name: "Outbound" },
            { id: "event", name: "Event" },
            { id: "social", name: "Social" },
            { id: "other", name: "Other" },
          ],
        },
      },
      { name: "Email", type: "email" },
      { name: "Phone", type: "phone" },
      { name: "Company", type: "relation" },
      { name: "Owner", type: "person" },
      { name: "Estimated Value", type: "number", config: { format: "currency" } },
      { name: "Probability", type: "number", config: { format: "percent" } },
      { name: "Next Step", type: "richText" },
      { name: "Next Action Date", type: "date" },
      { name: "Tags", type: "multiSelect", config: { options: [] } },
      { name: "First Contacted", type: "date" },
      { name: "Notes", type: "richText" },
    ],
  },
  {
    name: "Companies",
    icon: "🏢",
    description: "Organizations behind your contacts and deals. Notion-compatible (Companies DB).",
    properties: [
      { name: "Name", type: "title" },
      {
        name: "Industry",
        type: "select",
        config: {
          options: [
            { id: "saas", name: "SaaS" },
            { id: "fintech", name: "Fintech" },
            { id: "ecommerce", name: "E-commerce" },
            { id: "agency", name: "Agency" },
            { id: "media", name: "Media" },
            { id: "healthcare", name: "Healthcare" },
            { id: "other", name: "Other" },
          ],
        },
      },
      {
        name: "Size",
        type: "select",
        config: {
          options: [
            { id: "1-10", name: "1–10" },
            { id: "11-50", name: "11–50" },
            { id: "51-200", name: "51–200" },
            { id: "201-500", name: "201–500" },
            { id: "501-1000", name: "501–1000" },
            { id: "1000+", name: "1000+" },
          ],
        },
      },
      { name: "Domain", type: "url" },
      { name: "Country", type: "select", config: { options: [] } },
      { name: "Notes", type: "richText" },
      { name: "Clients", type: "relation" },
      { name: "Deals", type: "relation" },
    ],
  },
  {
    name: "Deals",
    icon: "💼",
    description:
      "Active sales opportunities tied to clients and companies. Notion-compatible (Deals DB).",
    properties: [
      { name: "Name", type: "title" },
      {
        name: "Stage",
        type: "status",
        config: {
          options: [
            { id: "discovery", name: "Discovery", color: "#94a3b8" },
            { id: "proposal", name: "Proposal", color: "#3b82f6" },
            { id: "negotiation", name: "Negotiation", color: "#f59e0b" },
            { id: "closed_won", name: "Closed — Won", color: "#10b981" },
            { id: "closed_lost", name: "Closed — Lost", color: "#ef4444" },
          ],
        },
      },
      { name: "Amount", type: "number", config: { format: "currency" } },
      { name: "Probability", type: "number", config: { format: "percent" } },
      { name: "Close Date", type: "date" },
      { name: "Owner", type: "person" },
      { name: "Company", type: "relation" },
      { name: "Client", type: "relation" },
      { name: "Notes", type: "richText" },
    ],
  },
  {
    name: "Contacts",
    icon: "📇",
    description: "People you talk to — contacts tied to companies and leads. Notion-compatible.",
    properties: [
      { name: "Name", type: "title" },
      { name: "Email", type: "email" },
      { name: "Phone", type: "phone" },
      { name: "Title", type: "richText" },
      { name: "Company", type: "relation" },
      { name: "LinkedIn", type: "url" },
      {
        name: "Relationship",
        type: "select",
        config: {
          options: [
            { id: "primary", name: "Primary contact" },
            { id: "decision_maker", name: "Decision maker" },
            { id: "champion", name: "Champion" },
            { id: "user", name: "End user" },
            { id: "other", name: "Other" },
          ],
        },
      },
      { name: "Tags", type: "multiSelect", config: { options: [] } },
      { name: "Last Contact", type: "date" },
      { name: "Notes", type: "richText" },
    ],
  },
  // ── Knowledge / ops ───────────────────────────────────────────
  {
    name: "Notes",
    icon: "📝",
    role: "notes",
    description:
      "Long-form notes — meeting recaps, ideas, briefs. Each row's body is a markdown page.",
    properties: [
      { name: "Title", type: "title" },
      {
        name: "Type",
        type: "select",
        config: {
          options: [
            { id: "meeting", name: "Meeting" },
            { id: "idea", name: "Idea" },
            { id: "brief", name: "Brief" },
            { id: "research", name: "Research" },
            { id: "journal", name: "Journal" },
          ],
        },
      },
      { name: "Tags", type: "multiSelect", config: { options: [] } },
      { name: "Related Project", type: "relation" },
      { name: "Author", type: "person" },
    ],
  },
  // ── Products ────────────────────────────────────────────────
  //
  // Catalog of digital + physical products that map to revenue.
  // Type drives downstream behavior: "Digital" → download_url +
  // license_key are relevant; "Physical" → inventory + weight +
  // shipping_class; "Service" → duration; "Bundle" → child products.
  // SKU is the canonical merchant id and is what Notion sync /
  // Stripe / Shopify use to dedupe on imports.
  {
    name: "Products",
    icon: "📦",
    description:
      "Catalog of digital + physical products with pricing, inventory, and business links",
    role: "products",
    properties: [
      { name: "Name", type: "title" },
      { name: "SKU", type: "richText" },
      {
        name: "Type",
        type: "select",
        config: {
          options: [
            { id: "digital", name: "Digital", color: "#8b5cf6" },
            { id: "physical", name: "Physical", color: "#10b981" },
            { id: "service", name: "Service", color: "#3b82f6" },
            { id: "bundle", name: "Bundle", color: "#f59e0b" },
            { id: "subscription", name: "Subscription", color: "#ec4899" },
          ],
        },
      },
      {
        name: "Status",
        type: "select",
        config: {
          options: [
            { id: "active", name: "Active", color: "#10b981" },
            { id: "draft", name: "Draft", color: "#94a3b8" },
            { id: "out_of_stock", name: "Out of stock", color: "#f59e0b" },
            { id: "archived", name: "Archived", color: "#71717a" },
          ],
        },
      },
      { name: "Price", type: "number", config: { format: "currency" } },
      { name: "Cost", type: "number", config: { format: "currency" } },
      { name: "Inventory", type: "number" },
      { name: "Description", type: "richText" },
      { name: "Image", type: "url" },
      { name: "Gallery", type: "multiSelect", config: { options: [] } },
      {
        name: "Category",
        type: "select",
        config: {
          options: [
            { id: "course", name: "Course" },
            { id: "software", name: "Software" },
            { id: "template", name: "Template" },
            { id: "ebook", name: "Ebook" },
            { id: "apparel", name: "Apparel" },
            { id: "merch", name: "Merch" },
            { id: "consulting", name: "Consulting" },
            { id: "other", name: "Other" },
          ],
        },
      },
      { name: "Tags", type: "multiSelect", config: { options: [] } },
      { name: "Business", type: "relation" },
      { name: "Vendor", type: "richText" },
      { name: "Weight", type: "number" },
      { name: "Dimensions", type: "richText" },
      { name: "Download URL", type: "url" },
      { name: "License Key Pattern", type: "richText" },
      { name: "Stripe Product ID", type: "richText" },
      { name: "External URL", type: "url" },
      { name: "Last Synced", type: "date" },
    ],
  },
];

/**
 * Idempotently create the business / CRM database templates and bind their
 * `role` (where set) to the new database — but only if the role is unset.
 * User overrides via `db.system.set` are never clobbered.
 */
export function ensureBusinessTemplates(store: DatabasesStore): void {
  for (const tpl of TEMPLATES) {
    // Look the template up by its existing name first so re-runs don't
    // create dupes if the user kept the default name. If they renamed
    // it we treat it as user content and don't recreate.
    const existing = store
      .listDatabases()
      .find((d) => d.name === tpl.name && d.source === "native");
    let dbId: string;
    if (existing) {
      dbId = existing.id;
    } else {
      const created = store.createDatabase({
        name: tpl.name,
        icon: tpl.icon,
        description: tpl.description,
        source: "native",
        properties: tpl.properties,
      });
      dbId = created.id;
    }
    if (tpl.role) {
      store.defaultSystemRole(tpl.role, dbId);
    }
  }

  // Migrate Leads + seed closed-loop pipeline databases (additive, idempotent)
  try {
    ensureLeadPipelineTemplates(store);
  } catch {
    // best-effort — never block the caller
  }

  // Seed canonical Cold/Warm/Hot Temperature property on Leads + Clients
  try {
    ensureLeadTemperatureProperty(store);
  } catch {
    // best-effort — never block the caller
  }
}
