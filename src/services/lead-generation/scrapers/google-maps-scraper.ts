/**
 * Google Maps Scraper
 * Uses Google Places API (free tier) or web scraping fallback
 * 
 * Cost-efficient: Uses free Places API tier (up to $200/month credit)
 * Alternative: Web scraping via SerpAPI or direct scraping
 */

import type { Lead, LeadSearchParams, LeadSearchResult, ScraperConfig } from "../types.js";
import { BaseScraper } from "./base-scraper.js";

export class GoogleMapsScraper extends BaseScraper {
  private readonly placesApiKey?: string;
  private readonly serpApiKey?: string;

  constructor(config: Partial<ScraperConfig> & { placesApiKey?: string; serpApiKey?: string } = {}) {
    super("google_maps", {
      requestsPerMinute: 5,
      requestsPerDay: 100,
      ...config
    });
    this.placesApiKey = config.placesApiKey || process.env.GOOGLE_PLACES_API_KEY;
    this.serpApiKey = config.serpApiKey || process.env.SERP_API_KEY;
  }

  async executeSearch(params: LeadSearchParams): Promise<LeadSearchResult> {
    // Try SerpAPI first (more reliable, pay per use)
    if (this.serpApiKey) {
      return this.searchViaSerpApi(params);
    }

    // Try Google Places API
    if (this.placesApiKey) {
      return this.searchViaPlacesApi(params);
    }

    // Fallback to web scraping simulation (limited)
    return this.searchViaWebScraping(params);
  }

  // ============================================================
  // SerpAPI Method (Most Reliable - $50/5000 searches)
  // ============================================================

  private async searchViaSerpApi(params: LeadSearchParams): Promise<LeadSearchResult> {
    const query = params.location 
      ? `${params.query} in ${params.location}`
      : params.query;
    
    const url = new URL("https://serpapi.com/search");
    url.searchParams.set("engine", "google_maps");
    url.searchParams.set("q", query);
    url.searchParams.set("type", "search");
    url.searchParams.set("api_key", this.serpApiKey!);
    
    if (params.limit) {
      // SerpAPI returns ~20 results per page
      url.searchParams.set("num", String(Math.min(params.limit, 20)));
    }

    const response = await this.fetchWithRetry(url.toString());
    const data = await response.json();

    const leads: Lead[] = (data.local_results || []).map((result: any) => this.mapSerpResultToLead(result, params));

    return {
      leads,
      total: leads.length,
      source: "google_maps",
      searchParams: params,
      scrapedAt: Date.now(),
      cached: false
    };
  }

  private mapSerpResultToLead(result: any, params: LeadSearchParams): Lead {
    return {
      id: this.generateLeadId(),
      companyName: result.title || "Unknown",
      website: result.website,
      industry: result.type || params.industry,
      description: result.description,
      phone: result.phone,
      address: result.address,
      rating: result.rating,
      reviewCount: result.reviews,
      type: params.type || "business",
      source: "google_maps",
      status: "new",
      quality: this.calculateQuality(result),
      tags: result.types || [],
      scrapedAt: Date.now(),
      lastUpdated: Date.now(),
      rawData: result
    };
  }

  // ============================================================
  // Google Places API Method (Free tier: $200/month)
  // ============================================================

  private async searchViaPlacesApi(params: LeadSearchParams): Promise<LeadSearchResult> {
    const query = params.location 
      ? `${params.query} in ${params.location}`
      : params.query;

    const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
    url.searchParams.set("query", query);
    url.searchParams.set("key", this.placesApiKey!);

    const response = await this.fetchWithRetry(url.toString());
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(`Places API error: ${data.status} - ${data.error_message || ""}`);
    }

    const leads: Lead[] = await Promise.all(
      (data.results || [])
        .slice(0, params.limit || 20)
        .map(async (place: any) => {
          // Get detailed info for each place
          const details = await this.getPlaceDetails(place.place_id);
          return this.mapPlacesToLead(place, details, params);
        })
    );

    return {
      leads,
      total: leads.length,
      source: "google_maps",
      searchParams: params,
      scrapedAt: Date.now(),
      cached: false
    };
  }

  private async getPlaceDetails(placeId: string): Promise<any> {
    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", placeId);
    url.searchParams.set("fields", "formatted_phone_number,website,url,opening_hours,reviews,price_level");
    url.searchParams.set("key", this.placesApiKey!);

    try {
      await this.rateLimiter.acquire();
      const response = await this.fetchWithRetry(url.toString());
      const data = await response.json();
      return data.result || {};
    } catch {
      return {};
    }
  }

  private mapPlacesToLead(place: any, details: any, params: LeadSearchParams): Lead {
    return {
      id: this.generateLeadId(),
      companyName: place.name || "Unknown",
      website: details.website,
      industry: place.types?.[0] || params.industry,
      description: place.business_status === "OPERATIONAL" ? "Open" : place.business_status,
      phone: details.formatted_phone_number,
      address: place.formatted_address,
      city: this.extractCity(place.formatted_address),
      rating: place.rating,
      reviewCount: place.user_ratings_total,
      type: params.type || "business",
      source: "google_maps",
      status: "new",
      quality: this.calculateQuality({ rating: place.rating, reviews: place.user_ratings_total }),
      tags: place.types || [],
      scrapedAt: Date.now(),
      lastUpdated: Date.now(),
      rawData: { place, details }
    };
  }

  // ============================================================
  // Web Scraping Fallback (Free but limited)
  // ============================================================

  private async searchViaWebScraping(params: LeadSearchParams): Promise<LeadSearchResult> {
    // This is a placeholder - actual web scraping would require
    // handling of dynamic content (Puppeteer/Playwright) or
    // using a service like Bright Data, ScrapingBee, etc.
    
    console.warn("[GoogleMapsScraper] No API keys configured. Using limited web search fallback.");

    // For now, return empty results with instructions
    return {
      leads: [],
      total: 0,
      source: "google_maps",
      searchParams: params,
      scrapedAt: Date.now(),
      cached: false,
      errors: [
        "No API keys configured. Please set GOOGLE_PLACES_API_KEY or SERP_API_KEY.",
        "Consider using SerpAPI ($50/5000 searches) or Google Places API (free $200/month credit)."
      ]
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  private calculateQuality(result: { rating?: number; reviews?: number }): "hot" | "warm" | "cold" | "unknown" {
    const rating = result.rating || 0;
    const reviews = result.reviews || 0;

    if (rating >= 4.5 && reviews >= 50) return "hot";
    if (rating >= 4.0 && reviews >= 20) return "warm";
    if (rating >= 3.0 || reviews >= 5) return "cold";
    return "unknown";
  }

  private extractCity(address?: string): string | undefined {
    if (!address) return undefined;
    // Simple extraction - city is usually before state/country
    const parts = address.split(",");
    if (parts.length >= 2) {
      return parts[parts.length - 3]?.trim();
    }
    return undefined;
  }
}
