/**
 * Lead Generation Service
 * Orchestrates multiple scrapers and handles CRM integration
 */

import { openLeadDeal } from "../../business-hub/automation.js";
import { ensureSource, upsertCompany, upsertContact } from "../../business-hub/contacts.js";
import { getHubDb } from "../../business-hub/db.js";
import type {
  Lead,
  LeadSearchParams,
  LeadSearchResult,
  LeadSource,
  LeadToCrmParams,
  ScraperStats,
} from "./types.js";
import { GoogleMapsScraper } from "./scrapers/google-maps-scraper.js";
import { WebSearchScraper } from "./scrapers/web-search-scraper.js";
import { ApolloScraper, HunterScraper } from "./scrapers/apollo-scraper.js";
import { BaseScraper } from "./scrapers/base-scraper.js";

// ============================================================
// Lead Service
// ============================================================

export class LeadService {
  private scrapers: Map<LeadSource, BaseScraper> = new Map();
  private notionApiKey?: string;
  private leadsCache: Map<string, Lead> = new Map();

  constructor(
    config: {
      googlePlacesApiKey?: string;
      serpApiKey?: string;
      braveApiKey?: string;
      apolloApiKey?: string;
      hunterApiKey?: string;
      notionApiKey?: string;
    } = {},
  ) {
    // Initialize scrapers with API keys from config or environment
    this.scrapers.set(
      "google_maps",
      new GoogleMapsScraper({
        placesApiKey: config.googlePlacesApiKey || process.env.GOOGLE_PLACES_API_KEY,
        serpApiKey: config.serpApiKey || process.env.SERP_API_KEY,
      }),
    );

    this.scrapers.set(
      "google_search",
      new WebSearchScraper({
        braveApiKey: config.braveApiKey || process.env.BRAVE_API_KEY,
      }),
    );

    this.scrapers.set(
      "apollo",
      new ApolloScraper({
        apolloApiKey: config.apolloApiKey || process.env.APOLLO_API_KEY,
      }),
    );

    this.scrapers.set(
      "hunter_io",
      new HunterScraper({
        hunterApiKey: config.hunterApiKey || process.env.HUNTER_API_KEY,
      }),
    );

    this.notionApiKey = config.notionApiKey || process.env.NOTION_API_KEY;
  }

  // ============================================================
  // Search Methods
  // ============================================================

  /**
   * Search for leads using specified sources
   * If no sources specified, uses best sources for the lead type
   */
  async search(params: LeadSearchParams): Promise<LeadSearchResult> {
    const sources = params.sources || this.getDefaultSources(params.type);
    const results: LeadSearchResult[] = [];
    const errors: string[] = [];

    // Search all specified sources in parallel
    await Promise.all(
      sources.map(async (source) => {
        try {
          const scraper = this.scrapers.get(source);
          if (!scraper) {
            errors.push(`Unknown source: ${source}`);
            return;
          }
          const result = await scraper.search(params);
          results.push(result);
          if (result.errors) {
            errors.push(...result.errors);
          }
        } catch (err) {
          errors.push(`${source}: ${(err as Error).message}`);
        }
      }),
    );

    // Merge and deduplicate results
    const allLeads = results.flatMap((r) => r.leads);
    const deduped = this.deduplicateLeads(allLeads);

    // Apply filters
    const filtered = this.filterLeads(deduped, params);

    // Cache leads
    for (const lead of filtered) {
      this.leadsCache.set(lead.id, lead);
    }

    return {
      leads: filtered,
      total: filtered.length,
      source: sources[0] || "google_maps",
      searchParams: params,
      scrapedAt: Date.now(),
      cached: results.every((r) => r.cached),
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Search using a specific source only
   */
  async searchWithSource(source: LeadSource, params: LeadSearchParams): Promise<LeadSearchResult> {
    const scraper = this.scrapers.get(source);
    if (!scraper) {
      throw new Error(`Unknown source: ${source}`);
    }
    const result = await scraper.search(params);

    // Cache leads
    for (const lead of result.leads) {
      this.leadsCache.set(lead.id, lead);
    }

    return result;
  }

  private getDefaultSources(type?: string): LeadSource[] {
    switch (type) {
      case "b2b":
      case "agency":
      case "tech":
      case "professional":
        return ["apollo", "google_search"];
      case "business":
      case "restaurant":
      case "healthcare":
      case "realestate":
        return ["google_maps"];
      case "ecommerce":
        return ["google_search", "google_maps"];
      default:
        return ["google_maps", "google_search"];
    }
  }

  private deduplicateLeads(leads: Lead[]): Lead[] {
    const seen = new Map<string, Lead>();

    for (const lead of leads) {
      // Identity is name + website. Email is deliberately NOT part of the key:
      // the same business scraped from two sources usually differs only in
      // which contact fields each source found, and mergeLeads() is what
      // combines those — keying on email would keep them apart forever.
      const key = [
        lead.companyName.toLowerCase().replace(/[^a-z0-9]/g, ""),
        lead.website
          ?.toLowerCase()
          .replace(/^https?:\/\/(www\.)?/, "")
          .replace(/\/$/, "") || "",
      ].join("|");

      const existing = seen.get(key);
      if (existing) {
        // Merge data - keep the more complete record
        seen.set(key, this.mergeLeads(existing, lead));
      } else {
        seen.set(key, lead);
      }
    }

    return Array.from(seen.values());
  }

  private mergeLeads(a: Lead, b: Lead): Lead {
    return {
      ...a,
      website: a.website || b.website,
      email: a.email || b.email,
      phone: a.phone || b.phone,
      address: a.address || b.address,
      contactName: a.contactName || b.contactName,
      contactEmail: a.contactEmail || b.contactEmail,
      contactPhone: a.contactPhone || b.contactPhone,
      contactLinkedIn: a.contactLinkedIn || b.contactLinkedIn,
      industry: a.industry || b.industry,
      description: a.description || b.description,
      linkedInUrl: a.linkedInUrl || b.linkedInUrl,
      rating: a.rating ?? b.rating,
      reviewCount: a.reviewCount ?? b.reviewCount,
      quality: this.betterQuality(a.quality, b.quality),
      tags: [...new Set([...(a.tags || []), ...(b.tags || [])])],
    };
  }

  private betterQuality(a: string, b: string): "hot" | "warm" | "cold" | "unknown" {
    const order = { hot: 0, warm: 1, cold: 2, unknown: 3 };
    return order[a as keyof typeof order] < order[b as keyof typeof order]
      ? (a as "hot" | "warm" | "cold" | "unknown")
      : (b as "hot" | "warm" | "cold" | "unknown");
  }

  private filterLeads(leads: Lead[], params: LeadSearchParams): Lead[] {
    return leads.filter((lead) => {
      if (params.minRating && (lead.rating ?? 0) < params.minRating) return false;
      if (params.minReviews && (lead.reviewCount ?? 0) < params.minReviews) return false;
      if (params.hasEmail && !lead.email && !lead.contactEmail) return false;
      if (params.hasPhone && !lead.phone && !lead.contactPhone) return false;
      if (params.hasWebsite && !lead.website) return false;
      return true;
    });
  }

  // ============================================================
  // Lead Management
  // ============================================================

  getLead(id: string): Lead | undefined {
    return this.leadsCache.get(id);
  }

  getAllLeads(): Lead[] {
    return Array.from(this.leadsCache.values());
  }

  updateLead(id: string, updates: Partial<Lead>): Lead | null {
    const lead = this.leadsCache.get(id);
    if (!lead) return null;

    const updated = { ...lead, ...updates, lastUpdated: Date.now() };
    this.leadsCache.set(id, updated);
    return updated;
  }

  deleteLead(id: string): boolean {
    return this.leadsCache.delete(id);
  }

  // ============================================================
  // Notion CRM Integration
  // ============================================================

  /**
   * Save a lead into the CRM. The local client store (the /clients page) is
   * the source of truth and is written synchronously; the Notion CRM is an
   * optional mirror pushed in the background when a key + database exist,
   * so a missing, slow or broken Notion never blocks or fails the save.
   */
  async saveLeadToCRM(
    params: LeadToCrmParams,
  ): Promise<{ clientId: string; notionPageId?: string; notionSync: "off" | "queued" }> {
    const { lead, databaseId, businessId, mapping = {}, updateIfExists = true } = params;
    const clientId = this.saveLeadToLocalCRM(lead, businessId ?? undefined);

    const notionOn = !!(this.notionApiKey && databaseId);
    if (notionOn) {
      void this.mirrorLeadToNotion(lead, databaseId!, mapping, updateIfExists).catch((err) => {
        console.warn(
          `[leads] Notion CRM mirror skipped for ${lead.companyName}: ${(err as Error).message}`,
        );
      });
    }
    return {
      clientId,
      notionPageId: lead.notionPageId,
      notionSync: notionOn ? "queued" : "off",
    };
  }

  /**
   * "Save to CRM" lands the lead in the Business hub (src/business-hub): a
   * company + contact (deduped by domain / email / phone) and an open deal in
   * the first pipeline stage, with lead-gen source attribution. It no longer
   * creates an agency client — a lead becomes a client only when its deal is
   * won (docs/business/DATA_MODEL.md). Returns the hub contact (or company) id.
   */
  private saveLeadToLocalCRM(lead: Lead, businessId?: string): string {
    if (lead.crmClientId) return lead.crmClientId;
    const db = getHubDb();
    const sourceId = ensureSource(db, "leadgen", `Lead search: ${String(lead.source ?? "web")}`);
    const company =
      upsertCompany(
        db,
        {
          name: lead.companyName || null,
          website: lead.website ?? null,
          industry: lead.industry ?? null,
          phone: lead.phone ?? null,
          address: lead.address ?? null,
          city: lead.city ?? null,
          region: lead.state ?? null,
          country: lead.country ?? null,
          businessId: businessId ?? null,
        },
        { sourceId, actor: "lead_generation" },
      )?.company ?? null;
    const email = lead.email || lead.contactEmail;
    const phone = lead.phone || lead.contactPhone;
    const contact =
      email || lead.contactName || lead.contactPhone
        ? (upsertContact(
            db,
            {
              name: lead.contactName || lead.companyName || email || null,
              email: email ?? null,
              phone: phone ?? null,
              title: lead.contactTitle ?? null,
              companyId: company?.id ?? null,
              lifecycle: "lead",
              businessId: businessId ?? null,
              custom: lead.notes ? { notes: lead.notes } : undefined,
            },
            { sourceId, actor: "lead_generation" },
          )?.contact ?? null)
        : null;
    if (!company && !contact) throw new Error("lead has no name, email or phone");
    openLeadDeal(db, { contactId: contact?.id ?? null, companyId: company?.id ?? null });
    lead.crmClientId = contact?.id ?? company!.id;
    this.leadsCache.set(lead.id, lead);
    return lead.crmClientId;
  }

  private async mirrorLeadToNotion(
    lead: Lead,
    databaseId: string,
    mapping: any,
    updateIfExists: boolean,
  ): Promise<void> {
    if (updateIfExists && lead.notionPageId) {
      await this.updateNotionPage(lead.notionPageId, lead, mapping);
      return;
    }
    const properties = this.mapLeadToNotionProperties(lead, mapping);
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.notionApiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Notion API ${response.status}: ${JSON.stringify(error)}`);
    }
    const data = await response.json();
    lead.notionPageId = data.id;
    this.leadsCache.set(lead.id, lead);
  }

  private async updateNotionPage(pageId: string, lead: Lead, mapping: any): Promise<void> {
    const properties = this.mapLeadToNotionProperties(lead, mapping);

    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.notionApiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  private mapLeadToNotionProperties(lead: Lead, mapping: any): Record<string, any> {
    const props: Record<string, any> = {};

    // Title property (required)
    const titleProp = mapping.companyName || "Name";
    props[titleProp] = {
      title: [{ text: { content: lead.companyName } }],
    };

    // Email
    if (lead.email || lead.contactEmail) {
      const emailProp = mapping.email || "Email";
      props[emailProp] = { email: lead.email || lead.contactEmail };
    }

    // Phone
    if (lead.phone || lead.contactPhone) {
      const phoneProp = mapping.phone || "Phone";
      props[phoneProp] = { phone_number: lead.phone || lead.contactPhone };
    }

    // Website
    if (lead.website) {
      const websiteProp = mapping.website || "Website";
      props[websiteProp] = { url: lead.website };
    }

    // Industry
    if (lead.industry) {
      const industryProp = mapping.industry || "Industry";
      props[industryProp] = { select: { name: lead.industry } };
    }

    // Source
    const sourceProp = mapping.source || "Source";
    props[sourceProp] = { select: { name: lead.source } };

    // Quality
    const qualityProp = mapping.quality || "Quality";
    props[qualityProp] = { select: { name: lead.quality } };

    // Contact name
    if (lead.contactName) {
      const contactProp = mapping.contactName || "Contact";
      props[contactProp] = { rich_text: [{ text: { content: lead.contactName } }] };
    }

    // Address
    if (lead.address) {
      const addressProp = mapping.address || "Address";
      props[addressProp] = { rich_text: [{ text: { content: lead.address } }] };
    }

    // Notes
    if (lead.notes || lead.description) {
      const notesProp = mapping.notes || "Notes";
      props[notesProp] = {
        rich_text: [{ text: { content: lead.notes || lead.description || "" } }],
      };
    }

    return props;
  }

  async bulkSaveToCRM(
    leads: Lead[],
    databaseId?: string | null,
    businessId?: string | null,
  ): Promise<{
    success: number;
    failed: number;
    errors: string[];
  }> {
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    const toMirror: Lead[] = [];

    for (const lead of leads) {
      try {
        this.saveLeadToLocalCRM(lead, businessId ?? undefined);
        success++;
        toMirror.push(lead);
      } catch (err) {
        failed++;
        errors.push(`${lead.companyName}: ${(err as Error).message}`);
      }
    }

    // Notion mirror runs after the response, paced for Notion's rate limit.
    if (this.notionApiKey && databaseId && toMirror.length > 0) {
      void (async () => {
        for (const lead of toMirror) {
          await this.mirrorLeadToNotion(lead, databaseId, {}, true).catch((err) => {
            console.warn(
              `[leads] Notion CRM mirror skipped for ${lead.companyName}: ${(err as Error).message}`,
            );
          });
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      })();
    }

    return { success, failed, errors };
  }

  // ============================================================
  // Stats
  // ============================================================

  getStats(): ScraperStats[] {
    return Array.from(this.scrapers.values()).map((scraper) => scraper.getStats());
  }

  getAvailableSources(): { source: LeadSource; hasApiKey: boolean; description: string }[] {
    return [
      {
        source: "google_maps",
        hasApiKey: !!process.env.GOOGLE_PLACES_API_KEY || !!process.env.SERP_API_KEY,
        description: "Local businesses, restaurants, services (Google Maps/Places)",
      },
      {
        source: "google_search",
        hasApiKey: !!process.env.BRAVE_API_KEY,
        description: "Web search for business websites (Brave Search API)",
      },
      {
        source: "apollo",
        hasApiKey: !!process.env.APOLLO_API_KEY,
        description: "B2B leads with verified emails (Apollo.io)",
      },
      {
        source: "hunter_io",
        hasApiKey: !!process.env.HUNTER_API_KEY,
        description: "Find emails by domain (Hunter.io)",
      },
    ];
  }
}

// ============================================================
// Singleton instance
// ============================================================

let leadServiceInstance: LeadService | null = null;

export function getLeadService(): LeadService {
  if (!leadServiceInstance) {
    leadServiceInstance = new LeadService();
  }
  return leadServiceInstance;
}

export function resetLeadService(): void {
  leadServiceInstance = null;
}
