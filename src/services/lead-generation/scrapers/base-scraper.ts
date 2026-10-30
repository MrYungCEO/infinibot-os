/**
 * Base Scraper - Common functionality for all scrapers
 */

import type {
  LeadSearchParams,
  LeadSearchResult,
  LeadSource,
  ScraperConfig,
  ScraperStats,
} from "../types.js";

// ============================================================
// Rate Limiter
// ============================================================

export class RateLimiter {
  private requests: number[] = [];
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.requests = this.requests.filter((t) => now - t < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      await this.sleep(waitTime + 100);
    }

    this.requests.push(Date.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================
// Cache Manager
// ============================================================

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class CacheManager<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 3600000) {
    // 1 hour default
    this.ttlMs = ttlMs;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlMs?: number): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }

  generateKey(params: LeadSearchParams): string {
    return JSON.stringify({
      query: params.query,
      location: params.location,
      type: params.type,
      industry: params.industry,
      limit: params.limit,
      offset: params.offset,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// ============================================================
// Base Scraper Class
// ============================================================

export abstract class BaseScraper {
  protected readonly source: LeadSource;
  protected readonly config: ScraperConfig;
  protected readonly rateLimiter: RateLimiter;
  protected readonly cache: CacheManager<LeadSearchResult>;
  protected stats: ScraperStats;

  constructor(source: LeadSource, config: Partial<ScraperConfig> = {}) {
    this.source = source;
    this.config = {
      requestsPerMinute: config.requestsPerMinute ?? 10,
      requestsPerDay: config.requestsPerDay ?? 100,
      cacheEnabled: config.cacheEnabled ?? true,
      cacheTtlMs: config.cacheTtlMs ?? 3600000, // 1 hour
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      useProxy: config.useProxy ?? false,
      proxyUrl: config.proxyUrl,
      apiKey: config.apiKey,
    };

    this.rateLimiter = new RateLimiter(
      this.config.requestsPerMinute,
      60000, // 1 minute window
    );

    this.cache = new CacheManager(this.config.cacheTtlMs);

    this.stats = {
      source,
      requestsToday: 0,
      requestsThisMinute: 0,
      lastRequestAt: 0,
      errorsToday: 0,
      leadsScrapedToday: 0,
    };
  }

  async search(params: LeadSearchParams): Promise<LeadSearchResult> {
    // Check cache first
    if (this.config.cacheEnabled) {
      const cacheKey = this.cache.generateKey(params);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return { ...cached, cached: true };
      }
    }

    // Rate limit
    await this.rateLimiter.acquire();
    this.stats.requestsToday++;
    this.stats.lastRequestAt = Date.now();

    // Execute search with retries
    let lastError: Error | null = null;
    for (let i = 0; i < this.config.maxRetries; i++) {
      try {
        const result = await this.executeSearch(params);
        result.cached = false;

        // Cache the result
        if (this.config.cacheEnabled) {
          const cacheKey = this.cache.generateKey(params);
          this.cache.set(cacheKey, result);
        }

        this.stats.leadsScrapedToday += result.leads.length;
        return result;
      } catch (err) {
        lastError = err as Error;
        this.stats.errorsToday++;
        if (i < this.config.maxRetries - 1) {
          await this.sleep(this.config.retryDelayMs * (i + 1));
        }
      }
    }

    throw lastError ?? new Error(`Search failed after ${this.config.maxRetries} retries`);
  }

  abstract executeSearch(params: LeadSearchParams): Promise<LeadSearchResult>;

  getStats(): ScraperStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.requestsToday = 0;
    this.stats.errorsToday = 0;
    this.stats.leadsScrapedToday = 0;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected generateLeadId(): string {
    return `lead-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  protected async fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
    const fetchFn = globalThis.fetch;

    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ...((options?.headers as Record<string, string>) || {}),
    };

    const response = await fetchFn(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  }
}
