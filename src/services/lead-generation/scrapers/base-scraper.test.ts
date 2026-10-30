/**
 * Base Scraper Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RateLimiter, CacheManager, BaseScraper } from "./base-scraper.js";
import type { LeadSearchParams, LeadSearchResult } from "../types.js";

describe("RateLimiter", () => {
  it("should allow requests within limit", async () => {
    const limiter = new RateLimiter(3, 1000);
    
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    
    // All 3 requests should complete quickly (within limit)
    expect(elapsed).toBeLessThan(200);
  });

  it("should delay requests exceeding limit", async () => {
    const limiter = new RateLimiter(2, 500);
    
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire(); // Should wait
    const elapsed = Date.now() - start;
    
    // Third request should trigger wait
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });
});

describe("CacheManager", () => {
  let cache: CacheManager<string>;

  beforeEach(() => {
    cache = new CacheManager(1000); // 1 second TTL
  });

  it("should store and retrieve values", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("should return null for non-existent keys", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("should expire entries after TTL", async () => {
    cache.set("key1", "value1", 100); // 100ms TTL
    expect(cache.get("key1")).toBe("value1");
    
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(cache.get("key1")).toBeNull();
  });

  it("should generate consistent cache keys", () => {
    const params: LeadSearchParams = {
      query: "restaurants",
      location: "Bangkok",
      type: "restaurant",
      limit: 20
    };
    
    const key1 = cache.generateKey(params);
    const key2 = cache.generateKey(params);
    
    expect(key1).toBe(key2);
    expect(key1).toContain("restaurants");
    expect(key1).toContain("Bangkok");
  });

  it("should generate different keys for different params", () => {
    const key1 = cache.generateKey({ query: "restaurants" });
    const key2 = cache.generateKey({ query: "hotels" });
    
    expect(key1).not.toBe(key2);
  });

  it("should clear all entries", () => {
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    
    cache.clear();
    
    expect(cache.get("key1")).toBeNull();
    expect(cache.get("key2")).toBeNull();
  });
});

describe("BaseScraper", () => {
  // Create a concrete implementation for testing
  class TestScraper extends BaseScraper {
    public mockResults: LeadSearchResult | null = null;
    public mockError: Error | null = null;

    constructor() {
      super("google_maps", {
        requestsPerMinute: 10,
        requestsPerDay: 100,
        cacheEnabled: true,
        cacheTtlMs: 1000
      });
    }

    async executeSearch(params: LeadSearchParams): Promise<LeadSearchResult> {
      if (this.mockError) throw this.mockError;
      return this.mockResults || {
        leads: [],
        total: 0,
        source: "google_maps",
        searchParams: params,
        scrapedAt: Date.now(),
        cached: false
      };
    }
  }

  let scraper: TestScraper;

  beforeEach(() => {
    scraper = new TestScraper();
  });

  it("should return cached results if available", async () => {
    scraper.mockResults = {
      leads: [{ id: "1", companyName: "Test", type: "business", source: "google_maps", status: "new", quality: "unknown", scrapedAt: Date.now(), lastUpdated: Date.now() }],
      total: 1,
      source: "google_maps",
      searchParams: { query: "test" },
      scrapedAt: Date.now(),
      cached: false
    };

    // First call - should execute
    const result1 = await scraper.search({ query: "test" });
    expect(result1.cached).toBe(false);
    expect(result1.leads).toHaveLength(1);

    // Second call - should be cached
    const result2 = await scraper.search({ query: "test" });
    expect(result2.cached).toBe(true);
  });

  it("should retry on failure", async () => {
    let attempts = 0;
    scraper.executeSearch = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error("Network error");
      return {
        leads: [],
        total: 0,
        source: "google_maps",
        searchParams: { query: "test" },
        scrapedAt: Date.now(),
        cached: false
      };
    });

    const result = await scraper.search({ query: "test" });
    expect(attempts).toBe(3);
    expect(result).toBeDefined();
  });

  it("should track stats", async () => {
    scraper.mockResults = {
      leads: [{ id: "1", companyName: "Test", type: "business", source: "google_maps", status: "new", quality: "unknown", scrapedAt: Date.now(), lastUpdated: Date.now() }],
      total: 1,
      source: "google_maps",
      searchParams: { query: "test" },
      scrapedAt: Date.now(),
      cached: false
    };

    await scraper.search({ query: "test" });
    const stats = scraper.getStats();

    expect(stats.source).toBe("google_maps");
    expect(stats.requestsToday).toBe(1);
    expect(stats.leadsScrapedToday).toBe(1);
  });

  it("should reset stats", async () => {
    scraper.mockResults = {
      leads: [{ id: "1", companyName: "Test", type: "business", source: "google_maps", status: "new", quality: "unknown", scrapedAt: Date.now(), lastUpdated: Date.now() }],
      total: 1,
      source: "google_maps",
      searchParams: { query: "test" },
      scrapedAt: Date.now(),
      cached: false
    };

    await scraper.search({ query: "test" });
    scraper.resetStats();
    const stats = scraper.getStats();

    expect(stats.requestsToday).toBe(0);
    expect(stats.leadsScrapedToday).toBe(0);
  });

  it("should generate unique lead IDs", () => {
    const id1 = (scraper as any).generateLeadId();
    const id2 = (scraper as any).generateLeadId();

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^lead-\d+-[a-z0-9]+$/);
  });
});
