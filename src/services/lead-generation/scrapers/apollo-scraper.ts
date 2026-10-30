/**
 * Apollo.io Scraper
 * Professional B2B lead database with email verification
 *
 * Pricing: Free tier (50 emails/month), Pro ($49/month for 1000 emails)
 * Great for: B2B leads, tech companies, decision makers
 */

import type { Lead, LeadSearchParams, LeadSearchResult, ScraperConfig } from "../types.js";
import { BaseScraper } from "./base-scraper.js";

export class ApolloScraper extends BaseScraper {
  private readonly apiKey?: string;

  constructor(config: Partial<ScraperConfig> & { apolloApiKey?: string } = {}) {
    super("apollo", {
      requestsPerMinute: 10,
      requestsPerDay: 50, // Free tier limit
      ...config,
    });
    this.apiKey = config.apolloApiKey || config.apiKey || process.env.APOLLO_API_KEY;
  }

  async executeSearch(params: LeadSearchParams): Promise<LeadSearchResult> {
    if (!this.apiKey) {
      return {
        leads: [],
        total: 0,
        source: "apollo",
        searchParams: params,
        scrapedAt: Date.now(),
        cached: false,
        errors: [
          "APOLLO_API_KEY not configured.",
          "Get a free API key at https://www.apollo.io (50 emails/month free)",
        ],
      };
    }

    // Search for organizations first
    const orgResults = await this.searchOrganizations(params);

    // Then get contacts for each organization
    const leads: Lead[] = [];
    for (const org of orgResults) {
      const contacts = await this.getOrganizationContacts(org.id);

      // Create a lead with best contact
      const primaryContact = contacts[0];
      leads.push({
        id: this.generateLeadId(),
        companyName: org.name,
        website: org.website_url,
        industry: org.industry,
        description: org.short_description,
        phone: org.phone,
        address: this.formatAddress(org),
        city: org.city,
        state: org.state,
        country: org.country,
        employeeCount: org.estimated_num_employees?.toString(),
        revenue: org.annual_revenue_printed,
        founded: org.founded_year?.toString(),
        linkedInUrl: org.linkedin_url,
        facebookUrl: org.facebook_url,
        twitterUrl: org.twitter_url,
        contactName: primaryContact?.name,
        contactTitle: primaryContact?.title,
        contactEmail: primaryContact?.email,
        contactPhone: primaryContact?.phone_numbers?.[0]?.sanitized_number,
        contactLinkedIn: primaryContact?.linkedin_url,
        type: params.type || "b2b",
        source: "apollo",
        status: "new",
        quality: this.calculateQuality(org, primaryContact),
        tags: org.keywords || [],
        scrapedAt: Date.now(),
        lastUpdated: Date.now(),
        rawData: { org, contact: primaryContact },
      });
    }

    return {
      leads: leads.slice(0, params.limit || 20),
      total: leads.length,
      source: "apollo",
      searchParams: params,
      scrapedAt: Date.now(),
      cached: false,
    };
  }

  private async searchOrganizations(params: LeadSearchParams): Promise<any[]> {
    const url = "https://api.apollo.io/v1/mixed_companies/search";

    const body: Record<string, any> = {
      q_organization_name: params.query,
      per_page: params.limit || 20,
      page: Math.floor((params.offset || 0) / (params.limit || 20)) + 1,
    };

    if (params.location) {
      body.organization_locations = [params.location];
    }

    if (params.industry) {
      body.organization_industry_tag_ids = [params.industry];
    }

    try {
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": this.apiKey!,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      return data.organizations || [];
    } catch (err) {
      console.error("[ApolloScraper] Search error:", err);
      return [];
    }
  }

  private async getOrganizationContacts(orgId: string): Promise<any[]> {
    if (!orgId) return [];

    try {
      const url = "https://api.apollo.io/v1/mixed_people/search";
      const body = {
        organization_ids: [orgId],
        per_page: 5,
        page: 1,
        person_seniorities: ["director", "vp", "c_suite", "owner", "founder"],
      };

      await this.rateLimiter.acquire();

      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": this.apiKey!,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      return data.people || [];
    } catch (err) {
      console.error("[ApolloScraper] Contacts error:", err);
      return [];
    }
  }

  private formatAddress(org: any): string | undefined {
    const parts = [org.street_address, org.city, org.state, org.postal_code, org.country].filter(
      Boolean,
    );

    return parts.length > 0 ? parts.join(", ") : undefined;
  }

  private calculateQuality(org: any, contact: any): "hot" | "warm" | "cold" | "unknown" {
    let score = 0;

    // Organization factors
    if (org.estimated_num_employees >= 50) score += 2;
    else if (org.estimated_num_employees >= 10) score += 1;

    if (org.annual_revenue_printed) score += 1;
    if (org.phone) score += 1;
    if (org.website_url) score += 1;

    // Contact factors
    if (contact?.email) score += 2;
    if (contact?.email_status === "verified") score += 2;
    if (
      contact?.title?.toLowerCase().includes("owner") ||
      contact?.title?.toLowerCase().includes("ceo") ||
      contact?.title?.toLowerCase().includes("founder")
    ) {
      score += 2;
    }

    if (score >= 8) return "hot";
    if (score >= 5) return "warm";
    if (score >= 2) return "cold";
    return "unknown";
  }
}

/**
 * Hunter.io Scraper
 * Email finder and verifier
 *
 * Pricing: Free tier (25 searches/month), Starter ($49/month for 500 searches)
 */

export class HunterScraper extends BaseScraper {
  private readonly apiKey?: string;

  constructor(config: Partial<ScraperConfig> & { hunterApiKey?: string } = {}) {
    super("hunter_io", {
      requestsPerMinute: 10,
      requestsPerDay: 25, // Free tier
      ...config,
    });
    this.apiKey = config.hunterApiKey || config.apiKey || process.env.HUNTER_API_KEY;
  }

  async executeSearch(params: LeadSearchParams): Promise<LeadSearchResult> {
    if (!this.apiKey) {
      return {
        leads: [],
        total: 0,
        source: "hunter_io",
        searchParams: params,
        scrapedAt: Date.now(),
        cached: false,
        errors: [
          "HUNTER_API_KEY not configured.",
          "Get a free API key at https://hunter.io (25 searches/month free)",
        ],
      };
    }

    // Hunter.io searches by domain, so we need a domain
    // If query looks like a domain, use it directly
    // Otherwise, search for domain first
    const domain = this.extractDomain(params.query);

    if (!domain) {
      return {
        leads: [],
        total: 0,
        source: "hunter_io",
        searchParams: params,
        scrapedAt: Date.now(),
        cached: false,
        errors: [
          "Hunter.io requires a domain name.",
          "Please provide a website domain (e.g., 'example.com')",
        ],
      };
    }

    const url = new URL("https://api.hunter.io/v2/domain-search");
    url.searchParams.set("domain", domain);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("limit", String(params.limit || 10));

    const response = await this.fetchWithRetry(url.toString());
    const data = await response.json();

    if (data.errors) {
      return {
        leads: [],
        total: 0,
        source: "hunter_io",
        searchParams: params,
        scrapedAt: Date.now(),
        cached: false,
        errors: data.errors.map((e: any) => e.details),
      };
    }

    const companyData = data.data || {};
    const emails = companyData.emails || [];

    const leads: Lead[] = emails.map((email: any) => ({
      id: this.generateLeadId(),
      companyName: companyData.organization || domain,
      website: `https://${domain}`,
      industry: companyData.industry,
      description: companyData.description,
      contactName: `${email.first_name || ""} ${email.last_name || ""}`.trim() || undefined,
      contactTitle: email.position,
      contactEmail: email.value,
      contactPhone: email.phone_number,
      contactLinkedIn: email.linkedin,
      linkedInUrl: companyData.linkedin,
      facebookUrl: companyData.facebook,
      twitterUrl: companyData.twitter,
      type: params.type || "b2b",
      source: "hunter_io",
      status: "new",
      quality: this.calculateEmailQuality(email),
      tags: email.department ? [email.department] : [],
      scrapedAt: Date.now(),
      lastUpdated: Date.now(),
      rawData: { company: companyData, email },
    }));

    return {
      leads,
      total: leads.length,
      source: "hunter_io",
      searchParams: params,
      scrapedAt: Date.now(),
      cached: false,
    };
  }

  private extractDomain(query: string): string | null {
    // If it looks like a domain already
    if (/^[a-z0-9]+([-.]{1}[a-z0-9]+)*\.[a-z]{2,}$/i.test(query)) {
      return query.toLowerCase();
    }

    // If it looks like a URL
    try {
      const url = new URL(query.startsWith("http") ? query : `https://${query}`);
      return url.hostname.replace("www.", "");
    } catch {
      return null;
    }
  }

  private calculateEmailQuality(email: any): "hot" | "warm" | "cold" | "unknown" {
    const confidence = email.confidence || 0;

    if (confidence >= 90 && email.verification?.status === "valid") return "hot";
    if (confidence >= 70) return "warm";
    if (confidence >= 50) return "cold";
    return "unknown";
  }
}
