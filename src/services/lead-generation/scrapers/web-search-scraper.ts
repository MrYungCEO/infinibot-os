/**
 * Web Search Scraper
 * Uses Brave Search API (free tier) to find business websites
 * Then extracts contact information from websites
 */

import type { Lead, LeadSearchParams, LeadSearchResult, ScraperConfig } from "../types.js";
import { BaseScraper } from "./base-scraper.js";

export class WebSearchScraper extends BaseScraper {
  private readonly braveApiKey?: string;

  constructor(config: Partial<ScraperConfig> & { braveApiKey?: string } = {}) {
    super("google_search", {
      requestsPerMinute: 10,
      requestsPerDay: 1000, // Brave free tier
      ...config
    });
    this.braveApiKey = config.braveApiKey || process.env.BRAVE_API_KEY;
  }

  async executeSearch(params: LeadSearchParams): Promise<LeadSearchResult> {
    if (!this.braveApiKey) {
      return {
        leads: [],
        total: 0,
        source: "google_search",
        searchParams: params,
        scrapedAt: Date.now(),
        cached: false,
        errors: ["BRAVE_API_KEY not configured. Set it in environment variables."]
      };
    }

    // Build search query for business leads
    const searchQuery = this.buildSearchQuery(params);
    
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", searchQuery);
    url.searchParams.set("count", String(params.limit || 20));
    
    const response = await this.fetchWithRetry(url.toString(), {
      headers: {
        "X-Subscription-Token": this.braveApiKey,
        "Accept": "application/json"
      }
    });

    const data = await response.json();
    const webResults = data.web?.results || [];

    // Process results and extract contact info
    const leads: Lead[] = [];
    for (const result of webResults.slice(0, params.limit || 20)) {
      const lead = await this.processSearchResult(result, params);
      if (lead) {
        leads.push(lead);
      }
    }

    return {
      leads,
      total: leads.length,
      source: "google_search",
      searchParams: params,
      scrapedAt: Date.now(),
      cached: false
    };
  }

  private buildSearchQuery(params: LeadSearchParams): string {
    let query = params.query;
    
    // Add location
    if (params.location) {
      query += ` ${params.location}`;
    }
    
    // Add type-specific keywords
    if (params.type === "agency") {
      query += " marketing agency OR creative agency OR digital agency";
    } else if (params.type === "ecommerce") {
      query += " online store OR ecommerce OR shop";
    } else if (params.type === "restaurant") {
      query += " restaurant OR cafe OR food";
    } else if (params.type === "healthcare") {
      query += " clinic OR medical OR dental OR healthcare";
    }
    
    // Add contact keywords to find pages with contact info
    query += " contact OR email OR phone";
    
    return query;
  }

  private async processSearchResult(result: any, params: LeadSearchParams): Promise<Lead | null> {
    try {
      const url = result.url;
      const domain = new URL(url).hostname.replace("www.", "");
      
      // Skip common non-business sites
      const skipDomains = [
        "facebook.com", "instagram.com", "twitter.com", "linkedin.com",
        "youtube.com", "tiktok.com", "pinterest.com", "yelp.com",
        "yellowpages.com", "tripadvisor.com", "wikipedia.org",
        "amazon.com", "ebay.com", "craigslist.org"
      ];
      
      if (skipDomains.some(d => domain.includes(d))) {
        return null;
      }

      // Extract basic info from search result
      const lead: Lead = {
        id: this.generateLeadId(),
        companyName: this.extractCompanyName(result.title, domain),
        website: url,
        description: result.description,
        type: params.type || "business",
        source: "google_search",
        status: "new",
        quality: "unknown",
        scrapedAt: Date.now(),
        lastUpdated: Date.now(),
        rawData: result
      };

      // Try to extract contact info from the page
      try {
        const contactInfo = await this.extractContactFromPage(url);
        if (contactInfo.email) lead.email = contactInfo.email;
        if (contactInfo.phone) lead.phone = contactInfo.phone;
        if (contactInfo.address) lead.address = contactInfo.address;
      } catch {
        // Ignore extraction errors
      }

      return lead;
    } catch {
      return null;
    }
  }

  private extractCompanyName(title: string, domain: string): string {
    // Clean up title
    let name = title
      .replace(/[-|–—:]\s*.*$/, "") // Remove everything after dash/pipe
      .replace(/\s+/g, " ")
      .trim();
    
    if (name.length < 3) {
      // Fall back to domain
      name = domain
        .split(".")[0]
        .replace(/-/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
    }
    
    return name;
  }

  private async extractContactFromPage(url: string): Promise<{
    email?: string;
    phone?: string;
    address?: string;
  }> {
    try {
      // Fetch the page
      const response = await this.fetchWithRetry(url, {
        headers: {
          "Accept": "text/html"
        }
      });
      
      const html = await response.text();
      
      // Extract email using regex
      const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const email = emailMatch?.[0];
      
      // Extract phone using regex (US format)
      const phonePatterns = [
        /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
        /\+1[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/
      ];
      let phone: string | undefined;
      for (const pattern of phonePatterns) {
        const match = html.match(pattern);
        if (match) {
          phone = match[0];
          break;
        }
      }
      
      // Extract address (simple heuristic)
      const addressMatch = html.match(/\d+\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)[\s,]+[\w\s]+,?\s*[A-Z]{2}\s*\d{5}/i);
      const address = addressMatch?.[0];
      
      return { email, phone, address };
    } catch {
      return {};
    }
  }
}
